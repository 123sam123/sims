import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ABANDON_YEARS,
  cellFoodCapacity,
  recordFoodStress,
  stepSettlements,
  TERRITORY_RADIUS_KM,
} from "../src/settlement.ts";
import {
  BIOMES,
  cellDistance,
  neighbors,
  refreshCohorts,
  type Settlement,
  seedAges,
  settlementPop,
  type World,
} from "../src/types.ts";
import { generateWorld, landCellCount } from "../src/worldgen.ts";

const SEED = 12345;
/** The neolithic package: enough to farm and to found permanent settlements.
 *  Granting it stands in for the research ticket — this suite tests settlement
 *  dynamics, not how a civ discovers farming, and there is still no agent. */
const NEOLITHIC = ["plant_domestication", "shelter", "settlement"];

const OCEAN = BIOMES.indexOf("ocean");
const ICE = BIOMES.indexOf("ice");
const DESERT = BIOMES.indexOf("desert");
const TUNDRA = BIOMES.indexOf("tundra");

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : Number.NaN;
}

/**
 * Run the world forward with every civ able to farm and settle — no agent, no
 * directives, just the physical world and population pressure — while watching
 * every year for an illegal founding. This is the module's most expensive
 * operation, so the 2,000-year run is built once and shared by the tests below.
 */
function grow(years: number): { world: World; illegalFoundings: number } {
  const world = generateWorld(SEED);
  for (const c of world.civs) c.capabilities.push(...NEOLITHIC);
  let illegalFoundings = 0;
  for (let y = 0; y < years; y++) {
    world.year = y;
    stepSettlements(world);
    const occupant = new Map<number, number>();
    for (const s of world.settlements) {
      const b = world.grid.biome[s.cell];
      if (world.grid.land[s.cell] === 0 || b === OCEAN || b === ICE) illegalFoundings++;
      if (world.grid.owner[s.cell] !== s.civ) illegalFoundings++;
      const prev = occupant.get(s.cell);
      if (prev !== undefined && prev !== s.civ) illegalFoundings++;
      occupant.set(s.cell, s.civ);
    }
  }
  return { world, illegalFoundings };
}

const GROWN = grow(2000);

/** Fertility of every cell a settlement sits on. */
function settledFertility(world: World): number[] {
  return world.settlements.map((s) => world.grid.fertility[s.cell]);
}

/** Fertility of every owned land cell — the civilisations' whole territory. */
function territoryFertility(world: World): number[] {
  const out: number[] = [];
  for (let i = 0; i < world.grid.owner.length; i++) {
    if (world.grid.owner[i] >= 0 && world.grid.land[i] === 1) out.push(world.grid.fertility[i]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Acceptance: founding, clustering, territory
 * ------------------------------------------------------------------ */

test("a 2,000-year headless run founds far more than the five seeded camps", () => {
  // Five camps in, and with nobody placing anything the world grows a map of
  // settlements on its own.
  assert.ok(
    GROWN.world.settlements.length > 5,
    `only ${GROWN.world.settlements.length} settlements after 2,000 years`,
  );
  // Not marginally — budding is a real, repeated process.
  assert.ok(GROWN.world.settlements.length > 20, "founding should be prolific, not a fluke");
});

test("no settlement is ever founded on ocean, ice, or another civ's cell", () => {
  // Checked every one of the 2,000 years, not just at the end.
  assert.equal(GROWN.illegalFoundings, 0, "an illegal site slipped through");
});

test("settlements cluster on fertile, riverine land", () => {
  const settled = settledFertility(GROWN.world);
  const territory = territoryFertility(GROWN.world);
  const settledMedian = median(settled);
  const territoryMedian = median(territory);
  assert.ok(
    settledMedian > territoryMedian + 0.05,
    `settled median fertility ${settledMedian.toFixed(3)} is not materially above ` +
      `territory median ${territoryMedian.toFixed(3)}`,
  );

  // ...and on fresh water far more than the land at large.
  const settledRiver =
    GROWN.world.settlements.filter((s) => GROWN.world.grid.river[s.cell] > 0).length /
    GROWN.world.settlements.length;
  let terrRiver = 0;
  let terrN = 0;
  for (let i = 0; i < GROWN.world.grid.owner.length; i++) {
    if (GROWN.world.grid.owner[i] >= 0 && GROWN.world.grid.land[i] === 1) {
      terrN++;
      if (GROWN.world.grid.river[i] > 0) terrRiver++;
    }
  }
  assert.ok(
    settledRiver > terrRiver / terrN,
    `settlements should sit on rivers (${(settledRiver * 100).toFixed(0)}%) more than ` +
      `their territory does (${((terrRiver / terrN) * 100).toFixed(0)}%)`,
  );
});

test("deserts, ice and tundra are left empty of settlements", () => {
  for (const s of GROWN.world.settlements) {
    const b = GROWN.world.grid.biome[s.cell];
    assert.ok(
      b !== DESERT && b !== ICE && b !== TUNDRA,
      `a settlement was founded on ${BIOMES[b]} at cell ${s.cell}`,
    );
  }
});

test("territory is anchored to settlements — expansion is not free", () => {
  const grid = GROWN.world.grid;
  const land = landCellCount(grid);
  let owned = 0;
  for (let i = 0; i < grid.owner.length; i++) {
    if (grid.owner[i] >= 0 && grid.land[i] === 1) owned++;
  }
  // The civilisations do not carpet the Earth: administrative reach is finite.
  assert.ok(owned / land < 0.3, `civs own ${((owned / land) * 100).toFixed(1)}% of all land`);

  // Every owned cell lies within a settlement's claim radius of one of its own
  // civ's settlements — territory is anchored to where people actually live.
  let worst = 0;
  for (let i = 0; i < grid.owner.length; i++) {
    const o = grid.owner[i];
    if (o < 0 || grid.land[i] === 0) continue;
    let nearest = Number.POSITIVE_INFINITY;
    for (const s of GROWN.world.settlements) {
      if (s.civ !== o) continue;
      const d = cellDistance(i, s.cell);
      if (d < nearest) nearest = d;
    }
    if (nearest > worst) worst = nearest;
  }
  assert.ok(
    worst < TERRITORY_RADIUS_KM + 150,
    `an owned cell is ${worst.toFixed(0)}km from any same-civ settlement`,
  );
});

test("stepSettlements replays identically for a given seed", () => {
  const run = () => {
    const w = generateWorld(SEED);
    for (const c of w.civs) c.capabilities.push(...NEOLITHIC);
    for (let y = 0; y < 300; y++) {
      w.year = y;
      stepSettlements(w);
    }
    return w.settlements
      .map((s) => `${s.id}:${s.cell}:${settlementPop(s).toFixed(6)}`)
      .sort();
  };
  assert.deepEqual(run(), run(), "same seed must replay to the same map");
});

/* ------------------------------------------------------------------ *
 * Abandonment
 * ------------------------------------------------------------------ */

test("food stress abandons a site only after 20 consecutive collapsed years", () => {
  const s = mkSettlement(1000);
  let firedAt = -1;
  for (let y = 1; y <= 25; y++) {
    if (recordFoodStress(s, 0.3) && firedAt < 0) firedAt = y;
  }
  assert.equal(firedAt, ABANDON_YEARS, "abandonment must wait the full twenty years");

  // A single fed year resets the count — the twenty must be consecutive.
  const t = mkSettlement(1000);
  recordFoodStress(t, 0.3);
  recordFoodStress(t, 0.3);
  recordFoodStress(t, 1);
  assert.equal(t.leanYears, 0, "a fed year clears the collapse counter");
});

test("a settlement whose food collapses for 20 years is abandoned and its cell freed", () => {
  const world = generateWorld(SEED);
  world.civs[0].capabilities.push(...NEOLITHIC);
  // A couple of years to establish a catchment and a real population.
  for (let y = 0; y < 3; y++) {
    world.year = y;
    stepSettlements(world);
  }
  const target = world.settlements.find((x) => x.civ === 0);
  assert.ok(target, "civ 0 has a settlement to abandon");
  const id = target.id;
  const cell = target.cell;

  const pyramid = [22, 19, 16, 14, 12, 10, 9, 7, 5, 3, 2, 1, 0.5, 0.2, 0.1, 0];
  let goneAt = -1;
  for (let k = 1; k <= 25; k++) {
    world.year = 100 + k;
    world.grid.fertility.fill(0); // total, sustained food collapse
    stepSettlements(world);
    const still = world.settlements.find((x) => x.id === id);
    if (!still) {
      goneAt = k;
      break;
    }
    // Keep it populated, so it is the twenty-year rule — not a population
    // wipe-out — that abandons it.
    still.ages.set(seedAges(pyramid, 800));
    refreshCohorts(still);
  }
  assert.equal(goneAt, ABANDON_YEARS, "the site should be abandoned on the twentieth collapsed year");
  assert.equal(world.grid.owner[cell], -1, "the abandoned cell's ownership is freed");
  assert.equal(world.grid.settlement[cell], -1, "the abandoned cell holds no settlement");
});

test("a settlement that empties out is cleaned up and its cell freed", () => {
  const world = generateWorld(SEED);
  world.civs[0].capabilities.push(...NEOLITHIC);
  for (let y = 0; y < 3; y++) {
    world.year = y;
    stepSettlements(world);
  }
  const target = world.settlements.find((x) => x.civ === 0);
  assert.ok(target);
  const id = target.id;
  const cell = target.cell;

  // Starve everyone with no relief and no re-seeding: the population dies out,
  // and the empty husk must not linger with its land still marked owned.
  let removed = false;
  for (let k = 1; k <= 40 && !removed; k++) {
    world.year = 200 + k;
    world.grid.fertility.fill(0);
    stepSettlements(world);
    removed = !world.settlements.some((x) => x.id === id);
  }
  assert.ok(removed, "an emptied settlement is removed");
  assert.equal(world.grid.owner[cell], -1, "its cell is freed");
  assert.equal(world.grid.settlement[cell], -1, "its cell holds no settlement");
});

/* ------------------------------------------------------------------ *
 * Pre-settlement bands
 * ------------------------------------------------------------------ */

test("a band that cannot settle relocates toward better foraging and never founds", () => {
  const world = generateWorld(SEED);
  // civ 0 keeps only its starting capabilities — no "settlement".
  const camp = world.settlements.find((s) => s.civ === 0);
  assert.ok(camp);
  const start = camp.cell;

  // Make where it stands poor and one walkable neighbour rich.
  world.grid.fertility[start] = 0.2;
  let rich = -1;
  for (const n of neighbors(start)) {
    if (world.grid.land[n] === 1) {
      rich = n;
      break;
    }
  }
  assert.ok(rich >= 0, "the camp has a land neighbour to move to");
  world.grid.fertility[rich] = 0.95;

  const before = world.settlements.length;
  world.year = 0;
  stepSettlements(world);
  assert.equal(camp.cell, rich, "the band walked to the richer cell");
  assert.equal(world.settlements.length, before, "a band with no settlement capability founds nothing");

  // ...and over centuries it still never founds a second settlement.
  for (let y = 1; y < 300; y++) {
    world.year = y;
    stepSettlements(world);
  }
  assert.equal(
    world.settlements.filter((s) => s.civ === 0).length,
    1,
    "a foraging band stays a single wandering camp",
  );
});

/* ------------------------------------------------------------------ *
 * Carrying capacity
 * ------------------------------------------------------------------ */

test("carrying capacity rises with fertility, and farming beats foraging", () => {
  const world = generateWorld(SEED);
  const grid = world.grid;
  // Find a fertile land cell and a poorer one.
  let rich = -1;
  let poor = -1;
  for (let i = 0; i < grid.land.length && (rich < 0 || poor < 0); i++) {
    if (grid.land[i] === 0) continue;
    if (rich < 0 && grid.fertility[i] > 0.8) rich = i;
    if (poor < 0 && grid.fertility[i] > 0.05 && grid.fertility[i] < 0.2) poor = i;
  }
  assert.ok(rich >= 0 && poor >= 0, "found a rich and a poor cell");
  assert.ok(
    cellFoodCapacity(grid, rich, true) > cellFoodCapacity(grid, poor, true),
    "richer land feeds more people",
  );
  assert.ok(
    cellFoodCapacity(grid, rich, true) > cellFoodCapacity(grid, rich, false),
    "the same cell feeds more once farmed than foraged",
  );
  assert.equal(cellFoodCapacity(grid, rich, false) >= 0, true);
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function mkSettlement(pop: number): Settlement {
  const shape = [22, 19, 16, 14, 12, 10, 9, 7, 5, 3, 2, 1, 0.5, 0.2, 0.1, 0];
  const s: Settlement = {
    id: 1,
    civ: 0,
    cell: 0,
    name: "test",
    founded: 0,
    ages: seedAges(shape, pop),
    cohorts: new Float64Array(16),
    housing: pop / 5,
    buildings: {},
    unrest: 0,
    lastHarvest: 1,
  };
  refreshCohorts(s);
  return s;
}
