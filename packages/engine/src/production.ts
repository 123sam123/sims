/**
 * Production: land + labour -> goods.
 *
 * Every good a civilisation holds is produced here, and it can only come from a
 * cell the civ controls plus the capability to work it. There are no abstract
 * "production points": food comes off worked land, wood off standing forest,
 * ore out of a finite deposit the civ has both found and can smelt. What the
 * planet does not hold, or the civ cannot yet do, it does not get.
 *
 * The step is deterministic. The only stochastic input is a per-civ-per-year
 * weather multiplier drawn from `hashSeed("prod", civId, year)`, so a seed
 * always replays to the same harvests — and the same famines.
 */
import { emit } from "./events.ts";
import type { ResourceKind } from "./geo-data.ts";
import { CAPABILITY_BY_ID } from "./knowledge.ts";
import { Rng, hashSeed } from "./rng.ts";
import {
  BIOMES,
  type Biome,
  type Civ,
  type Grid,
  type StoreKey,
  type World,
  civPopulation,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables — calibrated so a starting band feeds itself by foraging
 * and the same band, once farming, runs a clear grain surplus.
 * ------------------------------------------------------------------ */

/** Food a person eats in a year. Food is measured in person-years. */
export const FOOD_PER_CAPITA = 1.0;

/** Share of labour a civ puts on food before anything else. Farming's high
 * yield turns this baseline into a surplus; foraging's does not. */
const FOOD_LABOUR_SHARE = 0.55;

/** Food a single worker brings in from a fully-fertile cell in an average year. */
const FORAGE_PER_WORKER = 4.5;
const FARM_PER_WORKER = 11;

/** Farming force-multipliers, applied only once a civ actually farms. */
const IRRIGATION_MULT = 1.3;
const PLOUGH_MULT = 1.4;
/** Irrigation lifts the effective fertility of a river cell. */
const IRRIGATION_FERT_BONUS = 0.25;

/** How many workers one ~12,000 km² cell can usefully absorb. Farming packs in
 * far more hands than extensive foraging, which is why farming lifts the ceiling
 * on population, not just the yield per worker. */
const FORAGE_WORKERS_PER_CELL = 300;
const FARM_WORKERS_PER_CELL = 3000;

/** How the leftover labour (after food) splits across the material trades. */
const WOOD_LABOUR_SHARE = 0.35;
const STONE_LABOUR_SHARE = 0.25;
const MINE_LABOUR_SHARE = 0.4;

/** Wood a woodcutter fells in a year, and the timber embodied in one fully
 * forested cell. Taking wood removes standing forest, mass-for-mass. */
const WOOD_PER_WORKER = 3.0;
const WOOD_PER_FOREST_CELL = 200;
const WOOD_WORKERS_PER_CELL = 200;
/** Without hafted axes, cutting timber is drudgery. */
const WOOD_NO_AXE_PENALTY = 0.5;
const FOREST_MIN = 0.02;
/** Fraction of the gap to climax a forest closes each year. Slow enough that
 * cutting faster than this bites: the anti-snowball brake. */
const FOREST_REGROWTH = 0.02;

const STONE_PER_WORKER = 2.5;
const STONE_WORKERS_PER_CELL = 200;

/** Ore a miner draws from one deposit in a year, per unit richness. */
const MINE_PER_WORKER = 3.0;

/** Prospecting reach: how deep/hidden a deposit a civ can find. Grows with the
 * civ's most advanced capability (`era` used as a numeric proxy for sophistication).
 * Era 0 (a stone-age band) clears 0.12 — surface outcrops, native copper and the
 * shallow copper of Cyprus/Timna/Rio Tinto (depth 0.10) unambiguously; Ghawar oil
 * (0.9) waits for the steam age. The floor sits above 0.10 so surface copper is
 * "visible to anyone" without riding on exact float equality. */
const PROSPECT_BASE = 0.12;
const PROSPECT_PER_ERA = 0.12;

/** Weather multiplier bounds. A bad year can starve marginal land; the floor is
 * high enough that decent land, worked hard, still feeds its people. */
const WEATHER_MIN = 0.65;
const WEATHER_MAX = 1.25;
const WEATHER_SPREAD = 0.16;

/** A shortfall below this fraction of need is reported as a famine. */
const FAMINE_THRESHOLD = 0.85;

/** Working-age cohorts (ages 15–64) are bands 3..12 of the 16 five-year bands. */
export const WORK_START_BAND = 3;
export const WORK_END_BAND = 12;

/** Which store a mined resource lands in. `oil`/`uranium` have no store yet, so
 * they can be discovered but not extracted until the economy grows a use for them. */
const STORE_FOR_KIND: Partial<Record<ResourceKind, StoreKey>> = {
  copper: "copper",
  tin: "tin",
  iron: "iron",
  coal: "coal",
  gold: "luxury",
  silver: "luxury",
};

/** The capability a civ must hold to extract each resource. Discovery is a
 * separate gate (`prospectingLevel` vs `deposit.depth`). */
const EXTRACTION_CAP: Record<ResourceKind, string> = {
  copper: "copper_working",
  tin: "tin_working",
  iron: "iron_smelting",
  coal: "smelting",
  gold: "smelting",
  silver: "smelting",
  oil: "chemistry",
  uranium: "chemistry",
};

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface ProductionResult {
  civ: number;
  weather: number;
  labour: number;
  population: number;
  food: { produced: number; consumed: number; net: number };
  wood: number;
  stone: number;
  mined: Partial<Record<ResourceKind, number>>;
  discovered: string[];
  famine: boolean;
}

/**
 * Run one year of production for every living civilisation, mutating stores,
 * deposits and forest cover in place, then let forests regrow. Returns a
 * per-civ summary (useful for the chronicle and for tests).
 */
export function runProduction(world: World): ProductionResult[] {
  const territory = collectTerritory(world.grid);
  const results: ProductionResult[] = [];
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    results.push(produceCiv(world, civ, territory.get(civ.id) ?? []));
  }
  regrowForests(world.grid);
  return results;
}

/** Working-age population of a civ, summed from its settlements' cohorts. */
export function workingAgePopulation(world: World, civId: number): number {
  let total = 0;
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    for (let b = WORK_START_BAND; b <= WORK_END_BAND; b++) total += s.cohorts[b];
  }
  return total;
}

/** How deep a deposit a civ can find, from its most advanced capability. */
export function prospectingLevel(capabilities: Iterable<string>): number {
  let maxEra = 0;
  for (const id of capabilities) {
    const c = CAPABILITY_BY_ID.get(id);
    if (c && c.era > maxEra) maxEra = c.era;
  }
  return Math.min(1, PROSPECT_BASE + PROSPECT_PER_ERA * maxEra);
}

/** Climax forest cover for a biome — the ceiling regrowth walks back toward.
 * Mirrors the forest assignment in `worldgen.classify`. */
export function forestClimax(biomeIndex: number): number {
  const b: Biome = BIOMES[biomeIndex];
  if (b === "temperate_forest" || b === "tropical_forest") return 1;
  if (b === "taiga") return 0.75;
  if (b === "savanna" || b === "wetland") return 0.25;
  if (b === "grassland") return 0.12;
  return 0.02;
}

/** Regrow every land cell's forest a little toward its climax. */
export function regrowForests(grid: Grid): void {
  for (let i = 0; i < grid.land.length; i++) {
    if (!grid.land[i]) continue;
    const climax = forestClimax(grid.biome[i]);
    const f = grid.forest[i];
    if (f < climax) grid.forest[i] = Math.min(climax, f + FOREST_REGROWTH * (climax - f));
  }
}

/* ------------------------------------------------------------------ *
 * Per-civ production
 * ------------------------------------------------------------------ */

function produceCiv(world: World, civ: Civ, cells: number[]): ProductionResult {
  const grid = world.grid;
  const held = new Set(civ.capabilities);
  const rng = new Rng(hashSeed("prod", civ.id, world.year));
  const weather = clamp(WEATHER_MIN, WEATHER_MAX, 1 + WEATHER_SPREAD * rng.normal());

  const labour = workingAgePopulation(world, civ.id);
  const population = civPopulation(world, civ.id);
  const consumed = population * FOOD_PER_CAPITA;

  // --- Food first ---
  const { produced: food, workersUsed } = produceFood(
    grid,
    cells,
    held,
    labour,
    consumed,
    weather,
  );
  civ.stores.food = Math.max(0, civ.stores.food + food - consumed);
  const surplus = Math.max(0, labour - workersUsed);

  // --- Then the material trades, out of whatever labour is left over ---
  const wood = harvestWood(grid, cells, held, surplus * WOOD_LABOUR_SHARE);
  civ.stores.wood += wood;
  const stone = quarryStone(grid, cells, held, surplus * STONE_LABOUR_SHARE);
  civ.stores.stone += stone;

  const mined: Partial<Record<ResourceKind, number>> = {};
  const discovered: string[] = [];
  mineDeposits(world, civ, held, surplus * MINE_LABOUR_SHARE, mined, discovered);

  // --- Report what happened ---
  const famine = population > 0 && food < consumed * FAMINE_THRESHOLD;
  if (famine) {
    const shortfall = clamp(0, 1, (consumed - food) / Math.max(1, consumed));
    const place = cells.length > 0 ? cells[0] : null;
    // Two events, one cause: the harvest failed (the mechanism), and its people
    // went hungry (the consequence). Linking them lets the chronicle trace a
    // famine back to the failed fields behind it, rather than reporting only the
    // hunger and losing the why.
    const harvest = emit(world, {
      kind: "disaster",
      civ: civ.id,
      cell: place,
      magnitude: shortfall,
      text: `The harvest failed across ${civ.name}: its fields yielded far short of the people's need.`,
    });
    emit(world, {
      kind: "famine",
      civ: civ.id,
      cell: place,
      magnitude: shortfall,
      causedBy: [harvest.id],
    });
  }
  for (const name of discovered) {
    emit(world, {
      kind: "discovery",
      civ: civ.id,
      magnitude: 0.15,
      fields: { civ: civ.name, subject: name },
    });
  }

  return {
    civ: civ.id,
    weather,
    labour,
    population,
    food: { produced: food, consumed, net: food - consumed },
    wood,
    stone,
    mined,
    discovered,
    famine,
  };
}

/* ------------------------------------------------------------------ *
 * Food
 * ------------------------------------------------------------------ */

function produceFood(
  grid: Grid,
  cells: number[],
  held: Set<string>,
  labour: number,
  consumed: number,
  weather: number,
): { produced: number; workersUsed: number } {
  if (labour <= 0 || cells.length === 0) return { produced: 0, workersUsed: 0 };

  const farming = held.has("plant_domestication");
  const herding = held.has("animal_domestication");
  let baseRate = farming ? FARM_PER_WORKER : FORAGE_PER_WORKER;
  if (farming && held.has("irrigation")) baseRate *= IRRIGATION_MULT;
  if (farming && held.has("plough")) baseRate *= PLOUGH_MULT;
  const workersPerCell = farming ? FARM_WORKERS_PER_CELL : FORAGE_WORKERS_PER_CELL;

  const effFert = (c: number): number => {
    let f = grid.fertility[c];
    if (farming && held.has("irrigation") && grid.river[c] > 0) {
      f = Math.min(1, f + IRRIGATION_FERT_BONUS);
    }
    if (herding) f = Math.max(f, grazingFloor(grid.biome[c]));
    return f;
  };

  const sorted = [...cells].sort((a, b) => effFert(b) - effFert(a));

  // Baseline: put FOOD_LABOUR_SHARE of labour on the best land. If that leaves
  // the people hungry, keep adding hands (food is existential) only until fed —
  // so a shortfall means bad weather or too many mouths, never idle laziness.
  const minWorkers = Math.min(labour, labour * FOOD_LABOUR_SHARE);
  let placed = 0;
  let produced = 0;
  for (const c of sorted) {
    if (placed >= labour) break;
    const per = baseRate * effFert(c) * weather;
    let take = Math.min(workersPerCell, labour - placed);
    // Once we've met the baseline share and the population is fed, stop mid-cell.
    if (placed + take > minWorkers && produced + take * per > consumed && per > 0) {
      const takeForMin = Math.max(0, minWorkers - placed);
      const takeForFood = (consumed - produced) / per;
      take = Math.min(take, Math.max(takeForMin, takeForFood));
    }
    produced += take * per;
    placed += take;
    if (placed >= minWorkers && produced >= consumed) break;
  }

  return { produced, workersUsed: placed };
}

/** Extra food poor grazing land yields once a civ herds animals on it. */
function grazingFloor(biomeIndex: number): number {
  const b: Biome = BIOMES[biomeIndex];
  if (b === "steppe" || b === "grassland" || b === "savanna") return 0.35;
  if (b === "tundra") return 0.15;
  return 0;
}

/* ------------------------------------------------------------------ *
 * Wood — a stock that gets cut down
 * ------------------------------------------------------------------ */

function harvestWood(
  grid: Grid,
  cells: number[],
  held: Set<string>,
  woodWorkers: number,
): number {
  if (woodWorkers <= 0) return 0;
  const axe = held.has("hafting") ? 1 : WOOD_NO_AXE_PENALTY;
  const forested = cells
    .filter((c) => grid.forest[c] > FOREST_MIN)
    .sort((a, b) => grid.forest[b] - grid.forest[a]);

  let remaining = woodWorkers;
  let wood = 0;
  for (const c of forested) {
    if (remaining <= 0) break;
    const w = Math.min(WOOD_WORKERS_PER_CELL, remaining);
    remaining -= w;
    const wanted = w * WOOD_PER_WORKER * axe;
    const standing = grid.forest[c] * WOOD_PER_FOREST_CELL;
    const got = Math.min(wanted, standing);
    wood += got;
    // Cutting removes standing timber, mass for mass — this is deforestation.
    grid.forest[c] = Math.max(0, grid.forest[c] - got / WOOD_PER_FOREST_CELL);
  }
  return wood;
}

/* ------------------------------------------------------------------ *
 * Stone — abundant, labour-limited, richer in the hills
 * ------------------------------------------------------------------ */

function quarryStone(
  grid: Grid,
  cells: number[],
  held: Set<string>,
  stoneWorkers: number,
): number {
  if (stoneWorkers <= 0) return 0;
  const tool = (held.has("masonry") ? 1.5 : 1) * (held.has("hafting") ? 1.2 : 1);
  const byYield = [...cells].sort((a, b) => stoneYield(grid, b) - stoneYield(grid, a));

  let remaining = stoneWorkers;
  let stone = 0;
  for (const c of byYield) {
    if (remaining <= 0) break;
    const w = Math.min(STONE_WORKERS_PER_CELL, remaining);
    remaining -= w;
    stone += w * STONE_PER_WORKER * stoneYield(grid, c) * tool;
  }
  return stone;
}

const stoneYield = (grid: Grid, c: number): number => 0.3 + 0.7 * grid.elevation[c];

/* ------------------------------------------------------------------ *
 * Ore — find it, then draw down a finite deposit
 * ------------------------------------------------------------------ */

function mineDeposits(
  world: World,
  civ: Civ,
  held: Set<string>,
  mineWorkers: number,
  minedOut: Partial<Record<ResourceKind, number>>,
  discoveredOut: string[],
): void {
  const grid = world.grid;
  const level = prospectingLevel(held);
  const controlled = world.deposits.filter(
    (d) => grid.owner[d.cell] === civ.id && grid.land[d.cell] === 1,
  );

  // Discovery is separate from extraction: clearing the depth reveals the
  // deposit, whether or not the civ can yet work what is in it.
  for (const d of controlled) {
    if (!d.discoveredBy.includes(civ.id) && level >= d.depth) {
      d.discoveredBy.push(civ.id);
      discoveredOut.push(d.name);
    }
  }

  if (mineWorkers <= 0) return;

  const active = controlled.filter(
    (d) =>
      d.remaining > 0 &&
      d.discoveredBy.includes(civ.id) &&
      STORE_FOR_KIND[d.kind] !== undefined &&
      held.has(EXTRACTION_CAP[d.kind]),
  );
  if (active.length === 0) return;

  const perDeposit = mineWorkers / active.length;
  for (const d of active) {
    const store = STORE_FOR_KIND[d.kind];
    if (!store) continue;
    const got = Math.min(d.remaining, MINE_PER_WORKER * perDeposit * d.richness);
    if (got <= 0) continue;
    d.remaining -= got;
    civ.stores[store] += got;
    minedOut[d.kind] = (minedOut[d.kind] ?? 0) + got;
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** One pass over the grid grouping every owned land cell by its civ. */
function collectTerritory(grid: Grid): Map<number, number[]> {
  const territory = new Map<number, number[]>();
  for (let i = 0; i < grid.owner.length; i++) {
    const owner = grid.owner[i];
    if (owner < 0 || grid.land[i] === 0) continue;
    let arr = territory.get(owner);
    if (!arr) {
      arr = [];
      territory.set(owner, arr);
    }
    arr.push(i);
  }
  return territory;
}
