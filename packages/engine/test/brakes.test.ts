/**
 * The four anti-snowball brakes: disease, overextension, exhaustion,
 * degradation. Each is a mechanism with a visible cause chain — these tests
 * hold every brake to that: the effect must happen, be located, and leave the
 * right kind of event in the log.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stepDisease } from "../src/disease.ts";
import {
  SOIL_STRESS_THRESHOLD,
  stepEnvironment,
} from "../src/environment.ts";
import { emit, traceCauses } from "../src/events.ts";
import { runProduction } from "../src/production.ts";
import {
  ADMIN_REACH_KM,
  adminReach,
  cellFoodCapacity,
  stepSettlements,
} from "../src/settlement.ts";
import { tickWorld } from "../src/tick.ts";
import {
  BIOMES,
  cellDistance,
  refreshCohorts,
  seedAges,
  type Settlement,
  settlementPop,
  type World,
} from "../src/types.ts";
import { deserializeWorld, serializeWorld } from "../src/world.ts";
import { generateWorld } from "../src/worldgen.ts";

const SEED = 20260814;
const NEOLITHIC = ["plant_domestication", "shelter", "settlement"];

const PYRAMID = [22, 19, 16, 14, 12, 10, 9, 7, 5, 3, 2, 1, 0.5, 0.2, 0.1, 0];

function mkSettlement(id: number, civ: number, cell: number, pop: number): Settlement {
  const s: Settlement = {
    id,
    civ,
    cell,
    name: "settlement",
    founded: 0,
    ages: seedAges(PYRAMID, pop),
    cohorts: new Float64Array(16),
    housing: pop / 5,
    buildings: {},
    unrest: 0,
    lastHarvest: 1,
    leanYears: 0,
  };
  refreshCohorts(s);
  return s;
}

function refill(s: Settlement, pop: number): void {
  s.ages.set(seedAges(PYRAMID, pop));
  refreshCohorts(s);
}

/* ------------------------------------------------------------------ *
 * Brake 1 — disease: density and contact raise epidemic exposure
 * ------------------------------------------------------------------ */

test("a large, dense, connected civ is struck by epidemics far more than an isolated band", () => {
  // stepDisease reads only civs, settlements, seed and year, so a hand-built
  // world isolates the mechanism exactly.
  const world = generateWorld(SEED);
  world.settlements = [];
  world.civs = world.civs.slice(0, 3);
  const [big, small, partner] = world.civs;
  big.known = [partner.id];
  partner.known = [big.id];
  small.known = [];

  // Big: eight towns of 4,000 in a tight chain near the equator (adjacent
  // cells ~111km apart, well inside the spread radius). Small: one village of
  // 400 on the far side of the world. Partner: one town next to Big's chain.
  let nextId = 0;
  const bigTowns: Settlement[] = [];
  for (let i = 0; i < 8; i++) {
    bigTowns.push(mkSettlement(nextId++, big.id, 90 * 360 + 100 + i, 4000));
  }
  const smallTown = mkSettlement(nextId++, small.id, 40 * 360 + 300, 400);
  const partnerTown = mkSettlement(nextId++, partner.id, 90 * 360 + 109, 4000);
  world.settlements = [...bigTowns, smallTown, partnerTown];

  const YEARS = 1500;
  for (let y = 0; y < YEARS; y++) {
    world.year = y;
    stepDisease(world);
    // Hold populations steady so exposure — not attrition — is what's measured.
    for (const s of world.settlements) refill(s, s.id === smallTown.id ? 400 : 4000);
  }

  const plagues = world.events.filter((e) => e.kind === "plague");
  const bigHits = plagues.filter((e) => e.civ === big.id).length;
  const smallHits = plagues.filter((e) => e.civ === small.id).length;
  assert.ok(bigHits > 10, `the connected empire should be struck often (got ${bigHits})`);
  assert.ok(
    bigHits > 5 * Math.max(1, smallHits),
    `density and contact must dominate exposure (big ${bigHits} vs small ${smallHits})`,
  );

  // Contact is a disease route: the partner catches waves that started in the
  // big civ, and the log links them causally across the border.
  const partnerLinked = plagues.filter(
    (e) =>
      e.civ === partner.id &&
      e.causedBy.some((id) => {
        const parent = world.events.find((p) => p.id === id);
        return parent?.kind === "plague" && parent.civ === big.id;
      }),
  );
  assert.ok(
    partnerLinked.length > 0,
    "a wave should cross into the contacted civ with a causal link back to its origin",
  );
});

test("immunity spaces epidemics into waves rather than annual attrition", () => {
  const world = generateWorld(SEED + 1);
  world.settlements = [];
  world.civs = world.civs.slice(0, 1);
  const civ = world.civs[0];
  civ.known = [];
  const town = mkSettlement(0, civ.id, 90 * 360 + 100, 8000);
  world.settlements = [town];

  const struckYears: number[] = [];
  for (let y = 0; y < 2000; y++) {
    world.year = y;
    const r = stepDisease(world);
    if (r.struck.length > 0) struckYears.push(y);
    refill(town, 8000);
  }
  assert.ok(struckYears.length >= 3, `waves should recur (got ${struckYears.length})`);
  for (let i = 1; i < struckYears.length; i++) {
    assert.ok(
      struckYears[i] - struckYears[i - 1] >= 3,
      `back-to-back plague years at ${struckYears[i - 1]} and ${struckYears[i]}`,
    );
  }
});

/* ------------------------------------------------------------------ *
 * Brake 2 — overextension: unrest at the rim, secession past boiling
 * ------------------------------------------------------------------ */

test("a settlement far past comfortable reach accrues unrest and secedes, traceably", () => {
  const world = generateWorld(SEED);
  for (const c of world.civs) c.capabilities.push(...NEOLITHIC);
  // A few years to establish real catchments and populations.
  for (let y = 0; y < 5; y++) {
    world.year = y;
    stepSettlements(world);
  }

  const civ = world.civs[0];
  const sites = world.settlements.filter((s) => s.civ === civ.id);
  const capital = sites.reduce((a, b) => (settlementPop(b) > settlementPop(a) ? b : a));

  // Plant an outpost on land ~95% of the way to the edge of reach.
  let outpostCell = -1;
  for (let c = 0; c < world.grid.land.length; c++) {
    if (world.grid.land[c] === 0 || world.grid.owner[c] !== -1) continue;
    if (world.grid.settlement[c] !== -1) continue;
    const b = BIOMES[world.grid.biome[c]];
    if (b === "ocean" || b === "ice") continue;
    const d = cellDistance(c, capital.cell);
    if (d > 1700 && d < 1850) {
      outpostCell = c;
      break;
    }
  }
  assert.ok(outpostCell >= 0, "found a distant land cell inside reach");

  const outpost = mkSettlement(world.nextSettlementId++, civ.id, outpostCell, 300);
  world.settlements.push(outpost);
  world.grid.owner[outpostCell] = civ.id;
  world.grid.settlement[outpostCell] = outpost.id;

  let secededAt = -1;
  for (let y = 5; y < 400 && secededAt < 0; y++) {
    world.year = y;
    stepSettlements(world);
    const still = world.settlements.find((s) => s.id === outpost.id);
    if (!still) {
      secededAt = y;
      break;
    }
    // Keep the outpost alive and fed on paper, so distance — not starvation —
    // is the force under test.
    refill(still, 300);
    still.leanYears = 0;
    // The capital must stay the capital.
    refill(capital, Math.max(settlementPop(capital), 5000));
  }

  assert.ok(secededAt > 0, "the overextended outpost should eventually secede");
  const secession = world.events.find(
    (e) => e.kind === "secession" && e.civ === civ.id && e.cell === outpostCell,
  );
  assert.ok(secession, "secession must be recorded in the event log");
  assert.equal(world.grid.owner[outpostCell], -1, "the seceded land leaves the civ");
  assert.equal(world.grid.settlement[outpostCell], -1, "the seceded site is unassigned");

  // The log explains itself: the secession traces back to a standing unrest
  // report at the same place.
  const causes = traceCauses(world.events, secession.id);
  assert.ok(
    causes.some((e) => e.kind === "unrest" && e.cell === outpostCell),
    "secession should trace causally to the unrest that preceded it",
  );

  // And the near settlements felt none of it.
  assert.ok(capital.unrest < 0.05, "the capital itself does not chafe at distance");
});

test("governance capabilities stretch administrative reach", () => {
  const none = adminReach(new Set(NEOLITHIC));
  assert.equal(none, ADMIN_REACH_KM, "no governance capabilities, base reach");
  const literate = adminReach(new Set([...NEOLITHIC, "writing"]));
  const imperial = adminReach(new Set([...NEOLITHIC, "writing", "roads", "law_code", "currency"]));
  assert.ok(literate > none, "writing extends reach");
  assert.ok(imperial > literate, "each governance capability extends it further");
});

/* ------------------------------------------------------------------ *
 * Brake 3 — exhaustion: a worked-out deposit is recorded history
 * ------------------------------------------------------------------ */

test("mining a deposit to nothing emits a depletion event, exactly once", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("kiln", "smelting", "copper_working");

  const deposit = world.deposits.find(
    (d) => d.kind === "copper" && world.grid.land[d.cell] === 1,
  );
  assert.ok(deposit, "the world holds a copper deposit on land");
  deposit.remaining = 5;
  deposit.discoveredBy = [civ.id];
  world.grid.owner[deposit.cell] = civ.id;

  // Give the civ a solid workforce so the mine crews actually deploy.
  const home = world.settlements.find((s) => s.civ === civ.id);
  assert.ok(home, "civ 0 has a settlement");
  refill(home, 3000);

  let exhaustedYear = -1;
  for (let y = 0; y < 30; y++) {
    world.year = y;
    const results = runProduction(world);
    const mine = results.find((r) => r.civ === civ.id);
    if (mine?.exhausted.includes(deposit.name) && exhaustedYear < 0) {
      exhaustedYear = y;
    }
  }
  assert.ok(exhaustedYear >= 0, "the five remaining units of ore should run out");
  assert.equal(deposit.remaining, 0);

  const events = world.events.filter((e) => e.kind === "depletion");
  assert.equal(events.length, 1, "depletion is reported once, not annually");
  assert.equal(events[0].civ, civ.id);
  assert.equal(events[0].cell, deposit.cell);
});

/* ------------------------------------------------------------------ *
 * Brake 4 — degradation: long-farmed cells measurably lose yield
 * ------------------------------------------------------------------ */

test("long cultivation wears soil down, cuts capacity, reports it, and fallow heals it", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push(...NEOLITHIC);
  const home = world.settlements.find((s) => s.civ === civ.id);
  assert.ok(home, "civ 0 has a settlement");

  // Stamp a small catchment by hand so the mechanism is isolated from the
  // settlement layer's own dynamics.
  const cells = [home.cell];
  for (let c = 0; c < world.grid.land.length && cells.length < 6; c++) {
    if (world.grid.land[c] === 1 && world.grid.settlement[c] === -1 && c !== home.cell) {
      if (cellDistance(c, home.cell) < 400 && world.grid.fertility[c] > 0.3) cells.push(c);
    }
  }
  assert.ok(cells.length >= 3, "found nearby fertile cells to farm");
  for (const c of cells) {
    world.grid.owner[c] = civ.id;
    world.grid.settlement[c] = home.id;
  }

  const pristineCapacity = cells.reduce(
    (t, c) => t + cellFoodCapacity(world.grid, c, true),
    0,
  );

  for (let y = 0; y < 400; y++) {
    world.year = y;
    stepEnvironment(world);
  }

  for (const c of cells) {
    assert.ok(
      world.grid.soil[c] < SOIL_STRESS_THRESHOLD,
      `four centuries of farming should wear cell ${c} below ${SOIL_STRESS_THRESHOLD} (got ${world.grid.soil[c].toFixed(3)})`,
    );
  }
  const wornCapacity = cells.reduce(
    (t, c) => t + cellFoodCapacity(world.grid, c, true),
    0,
  );
  assert.ok(
    wornCapacity < pristineCapacity * 0.75,
    `worn land must feed measurably fewer people (${wornCapacity.toFixed(0)} vs ${pristineCapacity.toFixed(0)})`,
  );

  const reports = world.events.filter(
    (e) => e.kind === "degradation" && e.civ === civ.id,
  );
  assert.equal(reports.length, 1, "the decline is reported once, not annually");

  // Abandon the fields: fallow land heals on a generational timescale.
  for (const c of cells) {
    world.grid.owner[c] = -1;
    world.grid.settlement[c] = -1;
  }
  const wornSample = world.grid.soil[cells[0]];
  for (let y = 400; y < 800; y++) {
    world.year = y;
    stepEnvironment(world);
  }
  assert.ok(
    world.grid.soil[cells[0]] > wornSample + 0.25,
    `fallow soil should recover materially (${wornSample.toFixed(3)} -> ${world.grid.soil[cells[0]].toFixed(3)})`,
  );
});

test("deforested farmland erodes faster than land that kept its trees", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("plant_domestication");
  const home = world.settlements.find((s) => s.civ === civ.id);
  assert.ok(home);

  const forestBiome = BIOMES.indexOf("temperate_forest");
  let wooded = -1;
  let bare = -1;
  for (let c = 0; c < world.grid.land.length && (wooded < 0 || bare < 0); c++) {
    if (world.grid.land[c] !== 1 || world.grid.biome[c] !== forestBiome) continue;
    if (world.grid.settlement[c] !== -1) continue;
    if (wooded < 0) wooded = c;
    else bare = c;
  }
  assert.ok(wooded >= 0 && bare >= 0, "found two temperate-forest cells");
  world.grid.forest[wooded] = 1;
  world.grid.forest[bare] = 0; // clear-cut
  for (const c of [wooded, bare]) {
    world.grid.owner[c] = civ.id;
    world.grid.settlement[c] = home.id;
  }

  for (let y = 0; y < 100; y++) {
    world.year = y;
    // Hold the clear-cut: production's regrowth is not running here, but keep
    // the intent explicit against future coupling.
    world.grid.forest[bare] = 0;
    stepEnvironment(world);
  }
  assert.ok(
    world.grid.soil[bare] < world.grid.soil[wooded] - 0.05,
    `bare soil erodes faster (${world.grid.soil[bare].toFixed(3)} vs wooded ${world.grid.soil[wooded].toFixed(3)})`,
  );
});

/* ------------------------------------------------------------------ *
 * Determinism and persistence
 * ------------------------------------------------------------------ */

test("a full tick with every brake active replays identically for a given seed", () => {
  const run = (): string => {
    const world = generateWorld(SEED);
    for (const c of world.civs) c.capabilities.push(...NEOLITHIC);
    for (let y = 0; y < 250; y++) tickWorld(world);
    return JSON.stringify(serializeWorld(world));
  };
  const a = run();
  const b = run();
  assert.equal(a.length, b.length, "same seed, same serialised size");
  assert.equal(a, b, "same seed must replay to the same world, brakes included");
});

test("soil survives a serialisation round trip, and v1 snapshots migrate to pristine", () => {
  const world = generateWorld(SEED);
  world.grid.soil[1234] = 0.5;
  const wire = serializeWorld(world);
  const back = deserializeWorld(JSON.parse(JSON.stringify(wire)));
  assert.equal(back.grid.soil[1234], 0.5, "v2 carries soil byte-for-byte");

  // A v1 snapshot has no soil array: it predates degradation, so its land is
  // pristine by definition.
  const v1 = JSON.parse(JSON.stringify(wire));
  v1.v = 1;
  v1.grid.soil = undefined;
  const migrated = deserializeWorld(v1);
  assert.equal(migrated.grid.soil.length, world.grid.soil.length);
  assert.equal(migrated.grid.soil[1234], 1, "migrated soil is pristine");
  assert.throws(
    () => deserializeWorld({ ...wire, v: 99 }),
    /unsupported format version/,
    "an unknown version is still rejected",
  );
});

/* ------------------------------------------------------------------ *
 * The brakes speak distinctly
 * ------------------------------------------------------------------ */

test("each brake owns its event kind, so the log can say why a civ stalled", () => {
  // Contract check on the vocabulary: the four brakes report through distinct
  // kinds (plague / unrest+secession / depletion / degradation), each with a
  // legible headline of its own.
  const world: World = generateWorld(SEED);
  const kinds = ["plague", "unrest", "secession", "depletion", "degradation"] as const;
  const texts = new Set<string>();
  for (const kind of kinds) {
    const before = world.events.length;
    const e = emit(world, {
      kind,
      fields: { civ: "Aeland", place: "the Rim", subject: "the mines of Timna" },
    });
    assert.equal(world.events.length, before + 1);
    assert.equal(e.kind, kind);
    assert.ok(e.text.length > 0 && e.text.endsWith("."), `${kind} renders a sentence`);
    texts.add(e.text);
  }
  assert.equal(texts.size, kinds.length, "each kind speaks in its own words");
});
