import { createRequire } from "node:module";
import { feature } from "topojson-client";
import { Rng, hashSeed } from "./rng.ts";
import { DEPOSITS, RANGES, RIVERS, START_SITES } from "./geo-data.ts";
import {
  AGE_BANDS,
  BIOMES,
  CELL_COUNT,
  EMPTY_STORES,
  GRID_H,
  GRID_W,
  type Biome,
  type Civ,
  type Deposit,
  type Grid,
  type World,
  cellIndex,
  cellLat,
  cellLon,
  cellX,
  cellY,
  latLonToCell,
  neighbors,
  refreshCohorts,
  seedAges,
} from "./types.ts";
import { STARTING_CAPABILITIES } from "./knowledge.ts";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * 1. Real coastlines
 * ------------------------------------------------------------------ */

type Ring = number[][];

function loadLandRings(): { rings: Ring[]; bboxes: number[][] } {
  // Natural Earth 110m land, public domain, shipped in the world-atlas package.
  const topo = require("world-atlas/land-110m.json");
  const geo = feature(topo, topo.objects.land) as any;
  const rings: Ring[] = [];
  // GeoJSON nesting: Polygon = Ring[], MultiPolygon = Polygon[] = Ring[][].
  const pushPolygon = (poly: Ring[]) => {
    for (const ring of poly) rings.push(ring);
  };
  for (const f of geo.features ?? [geo]) {
    const g = f.geometry ?? f;
    if (g.type === "Polygon") pushPolygon(g.coordinates);
    else if (g.type === "MultiPolygon") for (const poly of g.coordinates) pushPolygon(poly);
  }
  if (rings.length === 0) throw new Error("worldgen: no coastline rings loaded from world-atlas");

  // Landmasses that straddle the antimeridian (Fiji, Chukotka, Antarctica) are
  // stored with longitudes jumping from +179 to -180. Read planar, that jump is
  // an edge 359° wide, and every point west of it tests as inside — which paints
  // a band of land right across the Pacific. Unwrap each ring so consecutive
  // longitudes never jump more than 180°; the ring may then extend past ±180,
  // which is exactly why points are tested at three longitude offsets below.
  const unwrapped = rings.map((ring) => {
    const out: Ring = [ring[0].slice()];
    for (let i = 1; i < ring.length; i++) {
      let x = ring[i][0];
      const prev = out[i - 1][0];
      while (x - prev > 180) x -= 360;
      while (prev - x > 180) x += 360;
      out.push([x, ring[i][1]]);
    }
    return out;
  });

  const bboxes = unwrapped.map((r) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of r) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
  });
  return { rings: unwrapped, bboxes };
}

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function rasteriseLand(grid: Grid) {
  const { rings, bboxes } = loadLandRings();
  // Cell centres land on exact half-degrees, and Natural Earth's quantised
  // coordinates put real vertices there too. A ray that passes exactly through
  // a vertex counts a degenerate crossing and flips parity for the whole rest
  // of the row — which shows up as a continent-wide stripe across the ocean.
  // Nudge the sample point off the lattice by an irrational-ish epsilon.
  const EPS_LAT = 0.0007321;
  const EPS_LON = 0.0004142;
  for (let i = 0; i < CELL_COUNT; i++) {
    const lon = cellLon(i) + EPS_LON;
    const lat = cellLat(i) + EPS_LAT;
    let hits = 0;
    for (let r = 0; r < rings.length; r++) {
      const b = bboxes[r];
      if (lat < b[1] || lat > b[3]) continue;
      // Unwrapped rings can sit outside ±180, so try the point in each wrap.
      for (const shift of [-360, 0, 360]) {
        const lx = lon + shift;
        if (lx < b[0] || lx > b[2]) continue;
        if (pointInRing(lx, lat, rings[r])) hits++;
      }
    }
    // Odd number of containing rings = land (handles lakes carved as holes).
    grid.land[i] = hits % 2 === 1 ? 1 : 0;
  }
}

/* ------------------------------------------------------------------ *
 * 2. Relief, climate, water
 * ------------------------------------------------------------------ */

/** Distance from a point to a line segment, in degrees. */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/**
 * Smooth value noise. Per-cell white noise looks fine until you hillshade it —
 * then every flat plain and ice sheet turns into a hatched mess, because the
 * slope between neighbours is pure randomness. Sampling on a coarse lattice and
 * interpolating gives gentle rolling relief that shades like actual ground.
 */
function valueNoise(x: number, y: number, period: number): number {
  const gx = Math.floor(x / period);
  const gy = Math.floor(y / period);
  const fx = x / period - gx;
  const fy = y / period - gy;
  const at = (ix: number, iy: number) => (hashSeed("relief", ix, iy) % 4096) / 4096;
  // smoothstep for continuous first derivative — no visible lattice seams
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = at(gx, gy) + (at(gx + 1, gy) - at(gx, gy)) * sx;
  const b = at(gx, gy + 1) + (at(gx + 1, gy + 1) - at(gx, gy + 1)) * sx;
  return a + (b - a) * sy;
}

function applyRanges(grid: Grid, rng: Rng) {
  for (let i = 0; i < CELL_COUNT; i++) {
    if (!grid.land[i]) continue;
    const lat = cellLat(i);
    const lon = cellLon(i);
    let best = 0;
    for (const range of RANGES) {
      for (let s = 0; s < range.path.length - 1; s++) {
        const [ay, ax] = range.path[s];
        const [by, bx] = range.path[s + 1];
        const d = distToSegment(lon, lat, ax, ay, bx, by);
        if (d > 4) continue;
        // A real range is 100–300km across; one cell is ~111km. Keep it tight,
        // or the Pyrenees freeze Aquitaine and the Himalaya swallow the Ganges.
        const h = range.height * Math.exp(-(d * d) / 0.8);
        if (h > best) best = h;
      }
    }
    // Gentle continental relief at two scales so nowhere is perfectly flat.
    const x = cellX(i);
    const y = cellY(i);
    const noise = valueNoise(x, y, 9) * 0.055 + valueNoise(x, y, 3) * 0.02;
    grid.elevation[i] = Math.min(1, best + noise * (1 - best));
  }
}

/** BFS from ocean so we know how continental each land cell is. */
function distanceToOcean(grid: Grid): Float32Array {
  const dist = new Float32Array(CELL_COUNT).fill(Infinity);
  const queue: number[] = [];
  for (let i = 0; i < CELL_COUNT; i++) {
    if (!grid.land[i]) {
      dist[i] = 0;
      queue.push(i);
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    for (const n of neighbors(i)) {
      if (dist[n] === Infinity) {
        dist[n] = dist[i] + 1;
        queue.push(n);
      }
    }
  }
  return dist;
}

function applyClimate(grid: Grid, oceanDist: Float32Array) {
  for (let i = 0; i < CELL_COUNT; i++) {
    const lat = cellLat(i);
    const alat = Math.abs(lat);
    const elev = grid.elevation[i];

    // Temperature: latitude gradient, altitude lapse, continentality.
    const maritime = Math.min(1, oceanDist[i] / 20);
    let t = 27 - 0.0058 * alat * alat - elev * 32;
    t += maritime * (alat > 45 ? -10 : 2); // interiors: harsher winters up north
    grid.temperature[i] = t;

    // Rainfall: ITCZ (broad, because it migrates seasonally), mid-latitude
    // storm track, subtropical high, then decay inland.
    let rain =
      0.95 * Math.exp(-((lat / 18) ** 2)) +
      0.5 * Math.exp(-(((alat - 50) / 16) ** 2)) +
      0.12;
    rain -= 0.3 * Math.exp(-(((alat - 26) / 8) ** 2));
    rain *= Math.exp(-maritime * 0.5);
    rain += elev * 0.18; // crude orographic lift
    grid.rainfall[i] = Math.max(0.02, Math.min(1, rain));
  }
}

function applyRivers(grid: Grid) {
  for (const river of RIVERS) {
    for (let s = 0; s < river.path.length - 1; s++) {
      const [ay, ax] = river.path[s];
      const [by, bx] = river.path[s + 1];
      const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const lat = ay + (by - ay) * t;
        const lon = ax + (bx - ax) * t;
        const i = latLonToCell(lat, lon);
        // Flow tapers toward the headwaters.
        const flow = river.flow * (1 - 0.45 * (s / Math.max(1, river.path.length - 1)));
        if (grid.river[i] < flow) grid.river[i] = flow;
        if (grid.land[i]) grid.rainfall[i] = Math.min(1, grid.rainfall[i] + 0.12);
      }
    }
  }
}

function classify(grid: Grid) {
  const idx = (b: Biome) => BIOMES.indexOf(b);
  for (let i = 0; i < CELL_COUNT; i++) {
    if (!grid.land[i]) {
      grid.biome[i] = idx("ocean");
      continue;
    }
    const t = grid.temperature[i];
    const r = grid.rainfall[i];
    const e = grid.elevation[i];
    let b: Biome;
    if (e > 0.62) b = "mountain";
    else if (t < -8) b = "ice";
    else if (t < 0) b = "tundra";
    else if (t < 6) b = r > 0.35 ? "taiga" : "tundra";
    else if (r < 0.16) b = "desert";
    else if (t > 21) {
      if (r > 0.62) b = "tropical_forest";
      else if (r > 0.3) b = "savanna";
      else b = "desert";
    } else {
      if (r > 0.55) b = "temperate_forest";
      else if (r > 0.3) b = "grassland";
      else b = "steppe";
    }
    if (grid.river[i] > 0.5 && r > 0.4 && e < 0.2) b = "wetland";
    grid.biome[i] = idx(b);

    // Coast flag
    grid.coast[i] = neighbors(i).some((n) => !grid.land[n]) ? 1 : 0;

    // Forest cover, which is a stock that gets cut down.
    grid.forest[i] =
      b === "temperate_forest" || b === "tropical_forest"
        ? 1
        : b === "taiga"
          ? 0.75
          : b === "savanna" || b === "wetland"
            ? 0.25
            : b === "grassland"
              ? 0.12
              : 0.02;

    // Fertility: what a farmer gets out of this cell.
    let f = 0;
    if (b === "grassland") f = 0.85;
    else if (b === "temperate_forest") f = 0.72;
    else if (b === "wetland") f = 0.8;
    else if (b === "savanna") f = 0.5;
    else if (b === "tropical_forest") f = 0.45;
    else if (b === "steppe") f = 0.35;
    else if (b === "taiga") f = 0.2;
    else if (b === "tundra") f = 0.06;
    else if (b === "desert") f = 0.04;
    else if (b === "mountain") f = 0.1;
    if (grid.river[i] > 0) f = Math.min(1, f + 0.3 * grid.river[i]);
    if (t < 2) f *= 0.4;
    grid.fertility[i] = f;
  }
}

/* ------------------------------------------------------------------ *
 * 3. What is in the ground
 * ------------------------------------------------------------------ */

function placeDeposits(grid: Grid, rng: Rng): Deposit[] {
  const out: Deposit[] = [];
  for (const d of DEPOSITS) {
    let cell = latLonToCell(d.at[0], d.at[1]);
    // Nudge onto land if the coarse coordinate landed just offshore.
    if (!grid.land[cell]) {
      const onLand = neighbors(cell).find((n) => grid.land[n]);
      if (onLand === undefined) continue;
      cell = onLand;
    }
    out.push({
      kind: d.kind,
      name: d.name,
      cell,
      richness: d.richness,
      depth: d.depth,
      remaining: d.richness * rng.range(60_000, 140_000),
      discoveredBy: [],
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 4. The five bands
 * ------------------------------------------------------------------ */

const DOCTRINES: { key: string; color: string; doctrine: string }[] = [
  {
    key: "aquitaine",
    color: "#c2603f",
    doctrine:
      "Your people are cautious and long-memoried. They distrust concentrated power and prefer slow, durable arrangements to bold gambles.",
  },
  {
    key: "greatlakes",
    color: "#3f7fa8",
    doctrine:
      "Your people are restless and mobile. They would rather move to a better place than fight for a worse one, and they hold obligations loosely.",
  },
  {
    key: "zambezi",
    color: "#c9a227",
    doctrine:
      "Your people are intensely social. Standing is earned through generosity and kinship, and a leader who cannot feed others is not a leader.",
  },
  {
    key: "deccan",
    color: "#6b5ca5",
    doctrine:
      "Your people are systematisers. They like to count, categorise and record, and they are suspicious of anything that cannot be explained.",
  },
  {
    key: "honshu",
    color: "#4f8f5b",
    doctrine:
      "Your people are exacting. They value craft, refinement and the correct way of doing a thing, sometimes past the point of usefulness.",
  },
];

function seedCivs(world: World, rng: Rng) {
  START_SITES.forEach((site, id) => {
    const meta = DOCTRINES.find((d) => d.key === site.key)!;
    let cell = latLonToCell(site.at[0], site.at[1]);
    if (!world.grid.land[cell]) {
      const onLand = neighbors(cell).find((n) => world.grid.land[n]);
      if (onLand !== undefined) cell = onLand;
    }

    const civ: Civ = {
      id,
      key: site.key,
      // Placeholder until they invent a name for themselves.
      name: `Band of ${site.key}`,
      color: meta.color,
      doctrine: meta.doctrine,
      capabilities: [...STARTING_CAPABILITIES],
      research: { target: null, progress: 0 },
      stores: { ...EMPTY_STORES, food: 400, wood: 60, stone: 20 },
      government: { form: "band", legitimacy: 0.7, centralization: 0.1, established: 0 },
      policy: { farming: 0.6, building: 0.1, research: 0.15, military: 0.15 },
      military: { troops: 0, equipment: 0, morale: 0.6 },
      relations: {},
      known: [],
      chronicle: [],
      agenda: [],
      alive: true,
    };
    world.civs.push(civ);

    // One camp, ~120 people, weighted young — this is a hard life.
    const shape = [22, 19, 16, 14, 12, 10, 9, 7, 5, 3, 2, 1, 0.5, 0.2, 0.1, 0];
    const ages = seedAges(shape, 120);
    const cohorts = new Float64Array(AGE_BANDS);

    world.settlements.push({
      id: world.nextSettlementId++,
      civ: id,
      cell,
      name: "camp",
      founded: 0,
      ages,
      cohorts,
      housing: 25,
      buildings: {},
      unrest: 0,
      lastHarvest: 1,
    });
    refreshCohorts(world.settlements[world.settlements.length - 1]);
    world.grid.owner[cell] = id;
    world.grid.settlement[cell] = world.settlements.length - 1;

    // A small home range from the first day.
    for (const n of neighbors(cell)) {
      if (world.grid.land[n] && world.grid.owner[n] === -1) world.grid.owner[n] = id;
    }
    void rng;
  });
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export function generateWorld(seed: number): World {
  const rng = new Rng(hashSeed("world", seed));

  const grid: Grid = {
    land: new Uint8Array(CELL_COUNT),
    elevation: new Float32Array(CELL_COUNT),
    temperature: new Float32Array(CELL_COUNT),
    rainfall: new Float32Array(CELL_COUNT),
    river: new Float32Array(CELL_COUNT),
    coast: new Uint8Array(CELL_COUNT),
    fertility: new Float32Array(CELL_COUNT),
    forest: new Float32Array(CELL_COUNT),
    biome: new Uint8Array(CELL_COUNT),
    owner: new Int16Array(CELL_COUNT).fill(-1),
    settlement: new Int16Array(CELL_COUNT).fill(-1),
  };

  rasteriseLand(grid);
  applyRanges(grid, rng);
  const oceanDist = distanceToOcean(grid);
  applyClimate(grid, oceanDist);
  applyRivers(grid);
  classify(grid);

  const world: World = {
    seed,
    year: 0,
    grid,
    deposits: placeDeposits(grid, rng),
    civs: [],
    settlements: [],
    people: [],
    events: [],
    nextSettlementId: 0,
    nextPersonId: 0,
    nextEventId: 0,
  };

  seedCivs(world, rng);
  return world;
}

export function landCellCount(grid: Grid): number {
  let n = 0;
  for (let i = 0; i < CELL_COUNT; i++) n += grid.land[i];
  return n;
}

export { GRID_W, GRID_H, cellIndex };
