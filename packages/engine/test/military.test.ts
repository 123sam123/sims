import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addGrievance,
  declareWar,
  establishContact,
  makePeace,
  sueForPeace,
} from "../src/diplomacy.ts";
import { STARTING_CAPABILITIES } from "../src/knowledge.ts";
import {
  EQUIP_TIER_BRONZE,
  EQUIP_TIER_STONE,
  MOBILISATION_SCALE,
  WARBAND_CAP,
  equipmentTier,
  stepMilitary,
} from "../src/military.ts";
import { runProduction, workingAgePopulation } from "../src/production.ts";
import { tickWorld } from "../src/tick.ts";
import {
  AGE_BANDS,
  type Army,
  GRID_W,
  type Settlement,
  type World,
  cellDistance,
  cellIndex,
  cellX,
  cellY,
  civPopulation,
  neighbors,
  refreshCohorts,
  seedAges,
} from "../src/types.ts";
import { deserializeWorld, serializeWorld } from "../src/world.ts";
import { generateWorld } from "../src/worldgen.ts";

const SEED = 12345;

const NEOLITHIC = [
  ...STARTING_CAPABILITIES,
  "hafting",
  "shelter",
  "plant_domestication",
  "settlement",
];
const BRONZE_KIT = [
  ...NEOLITHIC,
  "pottery",
  "kiln",
  "smelting",
  "copper_working",
  "tin_working",
  "bronze",
  "military_org",
];
const STEEL_KIT = [...BRONZE_KIT, "weaving", "bellows", "iron_smelting", "steel", "siegecraft"];

/** Adult-heavy age shape so the working-age share is high and stable. */
const ADULT_SHAPE = [6, 6, 8, 10, 10, 10, 10, 9, 8, 7, 6, 4, 3, 2, 1, 0.5];

/**
 * Re-plant a civ's single starting camp at `cell` with an exact population and
 * capability set, holding a two-ring block of territory around it.
 */
function plant(
  world: World,
  civId: number,
  cell: number,
  pop: number,
  caps: string[],
): Settlement {
  const civ = world.civs[civId];
  civ.capabilities = [...caps];
  civ.holders = {};
  civ.forgotten = [];
  civ.research = { target: null, progress: 0 };
  const s = world.settlements.find((t) => t.civ === civId);
  assert.ok(s, `civ ${civId} has a starting camp`);

  const grid = world.grid;
  for (let c = 0; c < grid.owner.length; c++) {
    if (grid.owner[c] === civId) grid.owner[c] = -1;
    if (grid.settlement[c] === s.id) grid.settlement[c] = -1;
  }
  s.cell = cell;
  s.ages = seedAges(ADULT_SHAPE, pop);
  refreshCohorts(s);
  s.housing = pop; // shelter is not under test here

  grid.owner[cell] = civId;
  grid.settlement[cell] = s.id;
  const ring = new Set<number>([cell]);
  for (const n of neighbors(cell)) ring.add(n);
  for (const n of [...ring]) for (const m of neighbors(n)) ring.add(m);
  for (const c of ring) {
    if (grid.land[c] === 1 && grid.owner[c] === -1) {
      grid.owner[c] = civId;
      grid.settlement[c] = s.id;
    }
  }
  return s;
}

/** First land cell due east of `from` whose real distance is in [minKm, maxKm]. */
function landCellEast(world: World, from: number, minKm: number, maxKm: number): number {
  const y = cellY(from);
  const x = cellX(from);
  for (let dx = 1; dx < 120; dx++) {
    const c = cellIndex((x + dx) % GRID_W, y);
    if (!world.grid.land[c]) continue;
    const d = cellDistance(from, c);
    if (d >= minKm && d <= maxKm) return c;
  }
  assert.fail(`no land cell ${minKm}-${maxKm} km east`);
}

/** A hand-built army in the field, defaults overridable. */
function makeArmy(partial: Partial<Army> & { cell: number; target: number }): Army {
  return {
    id: 0,
    troops: 1000,
    equipment: 1000,
    morale: 0.8,
    objective: partial.cell,
    home: partial.cell,
    supplies: 0,
    commander: null,
    raised: 0,
    ...partial,
  };
}

/* ================================================================== *
 * Muster — soldiers are people, and there are only so many
 * ================================================================== */

test("troops muster toward the policy target; without organised warfare only a warband stands", () => {
  const world = generateWorld(SEED);
  const home0 = world.settlements.find((s) => s.civ === 0);
  const home1 = world.settlements.find((s) => s.civ === 1);
  assert.ok(home0 && home1);
  plant(world, 0, home0.cell, 5000, [...NEOLITHIC, "military_org"]);
  plant(world, 1, home1.cell, 5000, NEOLITHIC);
  world.civs[0].policy.military = 0.5;
  world.civs[1].policy.military = 0.5;

  for (let y = 1; y <= 40; y++) {
    world.year = y;
    stepMilitary(world);
  }

  const target0 = 0.5 * MOBILISATION_SCALE * workingAgePopulation(world, 0);
  const troops0 = world.civs[0].military.troops;
  assert.ok(
    Math.abs(troops0 - target0) < target0 * 0.05,
    `organised muster converges on the target (${troops0} vs ${target0})`,
  );

  const cap1 = WARBAND_CAP * workingAgePopulation(world, 1);
  const troops1 = world.civs[1].military.troops;
  assert.ok(troops1 > 0, "even a band raises some warriors");
  assert.ok(troops1 <= cap1 * 1.01, `warband stays capped (${troops1} vs cap ${cap1})`);
  assert.ok(troops0 > troops1 * 5, "organised warfare fields far more");
});

test("soldiers under arms come out of the labour force: production measurably falls", () => {
  const worldA = generateWorld(SEED);
  const worldB = generateWorld(SEED);
  for (const world of [worldA, worldB]) {
    const home = world.settlements.find((s) => s.civ === 0);
    assert.ok(home);
    plant(world, 0, home.cell, 5000, NEOLITHIC);
  }
  worldB.civs[0].military.troops = 1000;

  const prodA = runProduction(worldA).find((r) => r.civ === 0);
  const prodB = runProduction(worldB).find((r) => r.civ === 0);
  assert.ok(prodA && prodB);

  assert.equal(prodA.labour - prodB.labour, 1000, "exactly the soldiers are missing");
  const outputA = prodA.food.produced + prodA.wood + prodA.stone;
  const outputB = prodB.food.produced + prodB.wood + prodB.stone;
  assert.ok(outputB < outputA, `output falls (${outputB} < ${outputA})`);
});

/* ================================================================== *
 * Equipment — capability caps the tier, stores pay every set
 * ================================================================== */

test("a civ without metalworking cannot arm past stone, however much metal it hoards", () => {
  const world = generateWorld(SEED);
  const home = world.settlements.find((s) => s.civ === 0);
  assert.ok(home);
  plant(world, 0, home.cell, 5000, [...NEOLITHIC, "military_org"]);
  const civ = world.civs[0];
  civ.policy.military = 0.5;
  civ.stores = { ...civ.stores, wood: 1e6, stone: 1e6, copper: 5000, tin: 5000, iron: 5000 };

  for (let y = 1; y <= 40; y++) {
    world.year = y;
    stepMilitary(world);
  }

  const m = civ.military;
  assert.equal(equipmentTier(civ), EQUIP_TIER_STONE);
  assert.ok(m.equipment > 0, "the smiths did work");
  assert.ok(
    m.equipment <= m.troops * EQUIP_TIER_STONE * 1.01,
    "arsenal quality is capped by what they know how to make",
  );
  assert.equal(civ.stores.copper, 5000, "the useless copper was never touched");
  assert.equal(civ.stores.iron, 5000, "nor the iron");
});

test("bronze arms cost real copper and tin; without them the smiths fall back to stone", () => {
  const rich = generateWorld(SEED);
  const poor = generateWorld(SEED);
  for (const world of [rich, poor]) {
    const home = world.settlements.find((s) => s.civ === 0);
    assert.ok(home);
    plant(world, 0, home.cell, 5000, BRONZE_KIT);
    world.civs[0].policy.military = 0.5;
    world.civs[0].stores.wood = 1e6;
    world.civs[0].stores.stone = 1e6;
  }
  rich.civs[0].stores.copper = 2000;
  rich.civs[0].stores.tin = 800;
  poor.civs[0].stores.copper = 0;
  poor.civs[0].stores.tin = 0;

  for (let y = 1; y <= 40; y++) {
    rich.year = y;
    poor.year = y;
    stepMilitary(rich);
    stepMilitary(poor);
  }

  const mRich = rich.civs[0].military;
  const mPoor = poor.civs[0].military;
  assert.ok(
    mRich.equipment / mRich.troops > EQUIP_TIER_STONE * 1.3,
    "with metal in the stores, the army arms in bronze",
  );
  assert.ok(rich.civs[0].stores.copper < 2000, "the copper was really spent");
  assert.ok(rich.civs[0].stores.tin < 800, "and the tin");
  assert.ok(
    mPoor.equipment <= mPoor.troops * (EQUIP_TIER_STONE + 0.21),
    "knowing bronze arms nobody without the metal",
  );
  assert.equal(equipmentTier(poor.civs[0]), EQUIP_TIER_BRONZE, "the knowledge is there all the same");
});

/* ================================================================== *
 * Supply — an army beyond its reach starves without a battle
 * ================================================================== */

test("an army beyond supply range suffers attrition without fighting", () => {
  const world = generateWorld(SEED);
  const home = world.settlements.find((s) => s.civ === 0);
  assert.ok(home);
  plant(world, 0, home.cell, 5000, [...NEOLITHIC, "military_org"]);
  const civ = world.civs[0];
  civ.stores.food = 1e6; // the granary is full — it just cannot reach them
  establishContact(world, 0, 1);
  declareWar(world, 0, 1);

  const farCell = landCellEast(world, home.cell, 1800, 3000);
  const army = makeArmy({ cell: farCell, target: 1, troops: 1000, supplies: 0 });
  civ.military.troops = 1000;
  civ.military.armies = [army];
  civ.military.nextArmyId = 1;
  world.civs[1].policy.military = 0; // the other side stays home

  const popBefore = civPopulation(world, 0);
  world.year = 1;
  const report = stepMilitary(world);

  assert.equal(report.battles.length, 0, "no battle was fought");
  assert.ok(report.attrition.length >= 1, "attrition was reported");
  assert.ok(army.troops < 1000, `the army thinned (${army.troops})`);
  assert.ok(civ.military.troops < 1000, "the muster roll shrank with it");
  assert.ok(civPopulation(world, 0) < popBefore, "the dead are real people");
});

/* ================================================================== *
 * Battle — equipment, numbers, terrain and the commander all tell
 * ================================================================== */

interface AssaultOptions {
  attCaps?: string[];
  attTroops?: number;
  commanderSkill?: number;
  fortify?: boolean;
  defTroops?: number;
}

/** A steel-armed invader one cell from a stone-age settlement, at war. */
function assaultFixture(opts: AssaultOptions = {}) {
  const world = generateWorld(SEED);
  const home0 = world.settlements.find((s) => s.civ === 0);
  assert.ok(home0);
  const attCaps = opts.attCaps ?? STEEL_KIT;
  plant(world, 0, home0.cell, 30000, attCaps);
  const siteCell = landCellEast(world, home0.cell, 300, 600);
  const defCaps = opts.fortify
    ? [...NEOLITHIC, "military_org", "masonry", "fortification"]
    : [...NEOLITHIC, "military_org"];
  const site = plant(world, 1, siteCell, 15000, defCaps);
  if (opts.fortify) {
    world.grid.elevation[siteCell] = 0.9;
    site.buildings.walls = 1;
  }

  establishContact(world, 0, 1);
  declareWar(world, 0, 1);

  const att = world.civs[0];
  const def = world.civs[1];
  att.policy.military = 1;
  def.policy.military = 1;
  att.stores = { ...att.stores, food: 1e6, wood: 0, stone: 0, iron: 0, coal: 0 };
  def.stores = { ...def.stores, food: 1e6, wood: 0, stone: 0 };

  const troops = opts.attTroops ?? 3000;
  const army = makeArmy({
    cell: neighbors(siteCell).find((c) => world.grid.land[c] === 1) ?? siteCell,
    target: 1,
    troops,
    equipment: troops * equipmentTier(att),
    morale: 0.8,
    commander: { person: -1, skill: opts.commanderSkill ?? 0.6 },
    objective: siteCell,
  });
  att.military.troops = troops;
  att.military.equipment = troops * equipmentTier(att);
  att.military.armies = [army];
  att.military.nextArmyId = 1;

  const defTroops = opts.defTroops ?? 2500;
  def.military.troops = defTroops;
  def.military.equipment = defTroops * EQUIP_TIER_STONE;
  // A spent army marker keeps the defender from fielding a fresh force this
  // year, so the assault meets the standing home defence and nothing else.
  def.military.armies = [makeArmy({ cell: siteCell, target: 0, troops: 0, equipment: 0 })];
  def.military.nextArmyId = 1;

  world.year = 1;
  const report = stepMilitary(world);
  const battle = report.battles.find((b) => b.attacker === 0 && b.defender === 1);
  assert.ok(battle, "the assault was fought");
  return { world, report, battle, site };
}

test("steel and numbers against stone: the defender bleeds far worse, and the place falls", () => {
  const { battle } = assaultFixture();
  assert.ok(
    battle.defenderLosses > battle.attackerLosses * 1.5,
    `equipment tells (${battle.defenderLosses} vs ${battle.attackerLosses})`,
  );
  assert.ok(battle.stormed, "the overmatched settlement was stormed");
});

test("high ground, fortification and walls narrow the exchange and hold the town", () => {
  const open = assaultFixture();
  const walled = assaultFixture({ fortify: true, attCaps: STEEL_KIT.filter((c) => c !== "siegecraft") });
  const openRatio = open.battle.defenderLosses / Math.max(1, open.battle.attackerLosses);
  const walledRatio = walled.battle.defenderLosses / Math.max(1, walled.battle.attackerLosses);
  assert.ok(
    walledRatio < openRatio * 0.7,
    `the walls tell (${walledRatio.toFixed(2)} vs ${openRatio.toFixed(2)} in the open)`,
  );
  assert.ok(!walled.battle.stormed, "the fortified town held");
});

test("a great commander loses fewer of their own than a poor one, all else equal", () => {
  const poor = assaultFixture({ commanderSkill: 0.05 });
  const great = assaultFixture({ commanderSkill: 0.95 });
  assert.ok(
    great.battle.attackerLosses < poor.battle.attackerLosses,
    `the commander tells (${great.battle.attackerLosses} vs ${poor.battle.attackerLosses})`,
  );
  assert.ok(great.battle.defenderLosses > poor.battle.defenderLosses);
});

/* ================================================================== *
 * Conquest — the map changes hands, and people run
 * ================================================================== */

test("a stormed settlement changes civ, its land transfers, and refugees crowd a neighbour", () => {
  const world = generateWorld(SEED);
  const home0 = world.settlements.find((s) => s.civ === 0);
  assert.ok(home0);
  plant(world, 0, home0.cell, 30000, STEEL_KIT);
  const siteCell = landCellEast(world, home0.cell, 300, 600);
  const site = plant(world, 1, siteCell, 3000, [...NEOLITHIC, "military_org"]);

  // A second, distant settlement of the defender for the refugees to reach.
  const refugeCell = landCellEast(world, siteCell, 450, 900);
  const refuge: Settlement = {
    id: world.nextSettlementId++,
    civ: 1,
    cell: refugeCell,
    name: "refuge",
    founded: 0,
    ages: seedAges(ADULT_SHAPE, 800),
    cohorts: new Float64Array(AGE_BANDS),
    housing: 400,
    buildings: {},
    unrest: 0,
    lastHarvest: 1,
    leanYears: 0,
  };
  refreshCohorts(refuge);
  world.settlements.push(refuge);
  world.grid.owner[refugeCell] = 1;
  world.grid.settlement[refugeCell] = refuge.id;
  const refugePopBefore = refuge.cohorts.reduce((a, b) => a + b, 0);

  establishContact(world, 0, 1);
  declareWar(world, 0, 1);
  const att = world.civs[0];
  att.policy.military = 1;
  att.stores.food = 1e6;
  world.civs[1].policy.military = 0.2;
  const troops = 6000;
  const army = makeArmy({
    cell: neighbors(siteCell).find((c) => world.grid.land[c] === 1) ?? siteCell,
    target: 1,
    troops,
    equipment: troops * equipmentTier(att),
    morale: 0.9,
    commander: { person: -1, skill: 0.9 },
    objective: siteCell,
  });
  att.military.troops = troops;
  att.military.equipment = army.equipment;
  att.military.armies = [army];
  att.military.nextArmyId = 1;
  world.civs[1].military.troops = 300;
  world.civs[1].military.equipment = 300;
  // A spent army marker keeps the defender home, so the only fighting this
  // year is the assault under test.
  world.civs[1].military.armies = [makeArmy({ cell: siteCell, target: 0, troops: 0, equipment: 0 })];
  world.civs[1].military.nextArmyId = 1;

  const ownedBefore = countOwned(world, 1);
  world.year = 1;
  const report = stepMilitary(world);

  const conquest = report.conquests.find((c) => c.winner === 0 && c.loser === 1);
  assert.ok(conquest, "the settlement was taken");
  assert.equal(site.civ, 0, "the settlement now answers to the conqueror");
  assert.ok(conquest.cells > 0, "cells changed hands");
  assert.ok(countOwned(world, 1) < ownedBefore, "the loser holds less of the map");
  assert.ok(countOwned(world, 0) > 0 && world.grid.owner[siteCell] === 0, "the winner holds the site");

  assert.ok(conquest.refugees > 0, "people fled the sack");
  const refugePopAfter = refuge.cohorts.reduce((a, b) => a + b, 0);
  assert.ok(
    refugePopAfter > refugePopBefore + conquest.refugees * 0.9,
    "the refugees really arrived somewhere",
  );
  assert.ok(
    world.events.some((e) => e.kind === "settlement" && /fled the sack/.test(e.text)),
    "the flight is on the record",
  );
  const grievance = world.civs[1].relations[0].grievances.find((g) => /took our lands/.test(g.note));
  assert.ok(grievance, "the conquest is remembered as a grievance");
});

function countOwned(world: World, civId: number): number {
  let n = 0;
  for (let i = 0; i < world.grid.owner.length; i++) if (world.grid.owner[i] === civId) n++;
  return n;
}

/* ================================================================== *
 * The whole arc — hostility ignites war, exhaustion ends it, nobody wins free
 * ================================================================== */

function warOfTheCenturySetup(): World {
  const world = generateWorld(SEED);
  const home0 = world.settlements.find((s) => s.civ === 0);
  assert.ok(home0);
  plant(world, 0, home0.cell, 20000, BRONZE_KIT);
  const cellB = landCellEast(world, home0.cell, 300, 600);
  plant(world, 1, cellB, 12000, [...NEOLITHIC, "military_org"]);

  const a = world.civs[0];
  const b = world.civs[1];
  a.policy.military = 0.5;
  b.policy.military = 0.3;
  a.stores = { ...a.stores, food: 50000, wood: 5000, stone: 2000, copper: 2000, tin: 800 };
  b.stores = { ...b.stores, food: 30000, wood: 3000, stone: 1000 };

  establishContact(world, 0, 1);
  addGrievance(world, 0, 1, "they burned our fields in the dry years", 1.0);
  a.relations[1].belief = { population: 12000, era: 2, military: 50, asOf: 0 };
  return world;
}

test("grievance plus believed advantage ignites war; exhaustion makes peace; both sides paid", () => {
  const world = warOfTheCenturySetup();
  // Conquest can hand the attacker whole subjugated settlements, so its NET
  // headcount may rise — the honest measure of "never free" is its own home
  // settlement's people, and the world's total dead.
  const homeA = world.settlements.find((s) => s.civ === 0);
  assert.ok(homeA);
  const homeAPop0 = homeA.cohorts.reduce((a, b) => a + b, 0);
  const totalPop0 = civPopulation(world, 0) + civPopulation(world, 1);
  const popB0 = civPopulation(world, 1);
  const foodA0 = world.civs[0].stores.food;
  const foodB0 = world.civs[1].stores.food;

  let warYear: number | null = null;
  let peaceYear: number | null = null;
  let battles = 0;
  let attackerDead = 0;
  for (let y = 1; y <= 250 && peaceYear === null; y++) {
    world.year = y;
    const report = stepMilitary(world);
    if (report.wars.length > 0 && warYear === null) warYear = y;
    battles += report.battles.length;
    for (const b of report.battles) {
      if (b.attacker === 0) attackerDead += b.attackerLosses;
      if (b.defender === 0) attackerDead += b.defenderLosses;
    }
    for (const a of report.attrition) if (a.civ === 0) attackerDead += a.losses;
    if (report.peaces.length > 0) peaceYear = y;
  }

  assert.ok(warYear !== null, "the war came");
  assert.ok(peaceYear !== null && peaceYear > (warYear as number), "and it ended");
  assert.ok(battles > 0, "battles were fought");
  assert.ok(world.events.some((e) => e.kind === "war"), "the declaration is on the record");
  assert.ok(world.events.some((e) => e.kind === "battle"), "so are the battles");
  assert.ok(world.events.some((e) => e.kind === "peace"), "and the peace");
  assert.equal(world.civs[0].relations[1].atWar, false);
  assert.equal(world.civs[1].relations[0].atWar, false);

  // War is never free: both belligerents lost people and ate their stores.
  assert.ok(attackerDead > 0, "the attacker buried its dead too");
  const homeAPop1 = homeA.cohorts.reduce((a, b) => a + b, 0);
  assert.ok(homeAPop1 < homeAPop0, "the attacker's own home has fewer people");
  assert.ok(
    civPopulation(world, 0) + civPopulation(world, 1) < totalPop0,
    "the world holds fewer people than before the war",
  );
  assert.ok(civPopulation(world, 1) < popB0, "the defender bled");
  assert.ok(world.civs[0].stores.food < foodA0, "campaigns ate the attacker's granary");
  assert.ok(world.civs[1].stores.food < foodB0, "and the defender's");
});

test("war replays deterministically from the same seed and setup", () => {
  const fingerprint = (world: World): string => {
    let ownerSum = 0;
    for (let i = 0; i < world.grid.owner.length; i++) ownerSum += world.grid.owner[i] * (i % 97);
    return JSON.stringify({
      m0: world.civs[0].military,
      m1: world.civs[1].military,
      events: world.events.length,
      people: world.people.length,
      pop0: civPopulation(world, 0),
      pop1: civPopulation(world, 1),
      ownerSum,
    });
  };
  const run = (): string => {
    const world = warOfTheCenturySetup();
    for (let y = 1; y <= 60; y++) {
      world.year = y;
      stepMilitary(world);
    }
    return fingerprint(world);
  };
  assert.equal(run(), run());
});

/* ================================================================== *
 * Bookkeeping — declarations, peace, and the tick
 * ================================================================== */

test("a snapshot taken mid-war — armies in the field — restores and replays identically", () => {
  const world = warOfTheCenturySetup();
  // March until somebody's army is actually in the field.
  let y = 1;
  for (; y <= 250; y++) {
    world.year = y;
    stepMilitary(world);
    if (world.civs.some((c) => (c.military.armies?.length ?? 0) > 0)) break;
  }
  assert.ok(world.civs.some((c) => (c.military.armies?.length ?? 0) > 0), "an army took the field");

  const restored = deserializeWorld(JSON.parse(JSON.stringify(serializeWorld(world))));
  assert.ok(
    restored.civs.some((c) => (c.military.armies?.length ?? 0) > 0),
    "the army survived the snapshot",
  );
  for (let i = 1; i <= 20; i++) {
    world.year = y + i;
    restored.year = y + i;
    stepMilitary(world);
    stepMilitary(restored);
  }
  assert.deepEqual(restored.civs[0].military, world.civs[0].military);
  assert.deepEqual(restored.civs[1].military, world.civs[1].military);
  assert.equal(restored.events.length, world.events.length);
});

test("declareWar and makePeace keep both relations honest and leave causal anchors", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  world.year = 5;
  const war = declareWar(world, 0, 1);
  assert.ok(war && war.kind === "war");
  const r01 = world.civs[0].relations[1];
  const r10 = world.civs[1].relations[0];
  assert.equal(r01.atWar, true);
  assert.equal(r10.atWar, true);
  assert.equal(r01.warSince, 5);
  assert.equal(r01.warEvent, war.id);
  assert.ok(
    r10.grievances.some((g) => /war upon us/.test(g.note)),
    "the aggression is remembered by the attacked",
  );
  assert.ok(r10.opinion < 0, "and it poisons opinion");
  assert.equal(declareWar(world, 0, 1), null, "a war cannot be declared twice");

  world.year = 9;
  const peace = makePeace(world, 0, 1);
  assert.ok(peace && peace.kind === "peace");
  assert.deepEqual(peace.causedBy, [war.id], "the peace points back at the declaration");
  assert.equal(r01.atWar, false);
  assert.equal(r10.atWar, false);
  assert.equal(makePeace(world, 0, 1), null, "no war left to end");
});

test("a peace plea ends the war only when both will it, or the other side is worn down", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  world.year = 1;
  declareWar(world, 0, 1);
  const a = world.civs[0];
  const b = world.civs[1];
  a.policy.military = 0;
  b.policy.military = 0;
  a.military.morale = 0.6;
  b.military.morale = 0.6;

  assert.ok(sueForPeace(world, 0, 1), "the plea was recorded");
  world.year = 2;
  let report = stepMilitary(world);
  assert.equal(report.peaces.length, 0, "one plea against a willing enemy changes nothing");
  assert.equal(a.relations[1].atWar, true);

  b.military.morale = 0.45; // worn down enough to take the standing offer
  world.year = 3;
  report = stepMilitary(world);
  assert.deepEqual(report.peaces, [[0, 1]]);
  assert.equal(a.relations[1].atWar, false);
  assert.equal(b.relations[0].atWar, false);
});

test("the tick runs the military stage and reports it", () => {
  const world = generateWorld(SEED);
  const report = tickWorld(world);
  assert.ok(report.military, "the tick carries a military report");
  assert.deepEqual(report.military.wars, [], "no wars on the first morning of the world");
  assert.deepEqual(report.military.battles, []);
  for (const civ of world.civs) {
    assert.ok(civ.military.troops >= 0, "muster ran without incident");
  }
});
