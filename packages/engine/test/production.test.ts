import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FOOD_PER_CAPITA,
  forestClimax,
  prospectingLevel,
  regrowForests,
  runProduction,
  workingAgePopulation,
} from "../src/production.ts";
import type { Deposit, World } from "../src/types.ts";
import { civPopulation } from "../src/types.ts";
import { generateWorld } from "../src/worldgen.ts";

const SEED = 12345;

/** The first owned land cell of a civ — where we plant test deposits. */
function ownedCell(world: World, civId: number): number {
  for (let i = 0; i < world.grid.owner.length; i++) {
    if (world.grid.owner[i] === civId && world.grid.land[i] === 1) return i;
  }
  throw new Error(`civ ${civId} owns no land`);
}

/** Scale every cohort of a civ so it has plenty of hands to spare after eating. */
function scaleCohorts(world: World, civId: number, factor: number): void {
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    for (let b = 0; b < s.cohorts.length; b++) s.cohorts[b] *= factor;
  }
}

function resultFor(world: World, civId: number) {
  const r = runProduction(world).find((x) => x.civ === civId);
  assert.ok(r, `no production result for civ ${civId}`);
  return r;
}

test("a stone-age band feeds itself by foraging and mines nothing", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[1]; // greatlakes: flat, fertile home range
  const r = resultFor(world, 1);

  assert.equal(civ.capabilities.includes("plant_domestication"), false, "band is not farming yet");
  assert.ok(r.food.produced > 0, "foraging yields food");
  // Feeds itself: production covers what the population eats.
  assert.ok(
    r.food.produced >= r.food.consumed,
    `foraging should feed the band (produced ${r.food.produced} >= consumed ${r.food.consumed})`,
  );
  // A stone-age band can mine nothing at all.
  assert.deepEqual(r.mined, {}, "no ore mined with only starting capabilities");
  assert.equal(civ.stores.copper, 0);
  assert.equal(civ.stores.iron, 0);
  assert.equal(civ.stores.coal, 0);
});

test("the same band, once farming, produces a clear grain surplus", () => {
  const forageWorld = generateWorld(SEED);
  const forage = resultFor(forageWorld, 1);

  const farmWorld = generateWorld(SEED);
  farmWorld.civs[1].capabilities.push("plant_domestication", "settlement");
  const farm = resultFor(farmWorld, 1);

  assert.ok(farm.food.net > 0, `farming runs a surplus (net ${farm.food.net})`);
  assert.ok(
    farm.food.produced > forage.food.produced,
    `farming out-produces foraging (${farm.food.produced} > ${forage.food.produced})`,
  );
  // The surplus is a real grain surplus, not a rounding artefact.
  assert.ok(farm.food.net > forage.food.consumed * 0.25, "surplus is substantial");
});

test("every civ eats what its population needs", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  const before = civ.stores.food;
  const r = resultFor(world, 0);
  const pop = r.population;
  assert.equal(r.food.consumed, pop * FOOD_PER_CAPITA);
  // Stores move by produced minus consumed (clamped at zero).
  assert.equal(civ.stores.food, Math.max(0, before + r.food.produced - r.food.consumed));
});

test("copper flows once a civ can work a shallow deposit it controls", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("plant_domestication", "settlement", "copper_working");
  scaleCohorts(world, 0, 20); // ample labour so some is left over for mining

  const cell = ownedCell(world, 0);
  const deposit: Deposit = {
    kind: "copper",
    name: "Test Lode",
    cell,
    richness: 0.6,
    depth: 0.1, // shallow: findable by a civ that can already smelt copper
    remaining: 1_000_000,
    discoveredBy: [],
  };
  world.deposits.push(deposit);

  assert.ok(prospectingLevel(civ.capabilities) >= deposit.depth, "the civ can find shallow copper");
  const r = resultFor(world, 0); // one year is well within five

  assert.ok(deposit.discoveredBy.includes(0), "the deposit is discovered");
  assert.ok(civ.stores.copper > 0, `copper is flowing (${civ.stores.copper})`);
  assert.ok((r.mined.copper ?? 0) > 0, "the result reports copper mined");
  assert.ok(deposit.remaining < 1_000_000, "extraction drew the deposit down");
});

test("a civ with no copper deposit gets no copper, even able to work it", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("plant_domestication", "settlement", "copper_working");
  scaleCohorts(world, 0, 20);

  for (let y = 0; y < 5; y++) {
    world.year = y;
    runProduction(world);
  }
  assert.equal(civ.stores.copper, 0, "no source, no copper");
});

test("extraction needs the working capability, not just the deposit", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  // Farming for surplus labour, but NO copper_working.
  civ.capabilities.push("plant_domestication", "settlement");
  scaleCohorts(world, 0, 20);

  const cell = ownedCell(world, 0);
  world.deposits.push({
    kind: "copper",
    name: "Unworkable Lode",
    cell,
    richness: 0.6,
    depth: 0.1,
    remaining: 1_000_000,
    discoveredBy: [0], // already found, but the civ can't smelt copper
  });

  const r = resultFor(world, 0);
  assert.equal(civ.stores.copper, 0, "found but unworkable: no copper");
  assert.equal(r.mined.copper ?? 0, 0);
});

test("a civ sitting on tin it has not discovered gets no tin", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  scaleCohorts(world, 0, 20);
  // It can even smelt tin — but the deposit is buried deeper than it can prospect.
  civ.capabilities.push("plant_domestication", "settlement", "tin_working");

  const cell = ownedCell(world, 0);
  const tin: Deposit = {
    kind: "tin",
    name: "Buried Tin",
    cell,
    richness: 0.7,
    depth: 0.6, // deeper than this civ's prospecting reach
    remaining: 1_000_000,
    discoveredBy: [],
  };
  world.deposits.push(tin);

  assert.ok(prospectingLevel(civ.capabilities) < tin.depth, "the tin is out of prospecting reach");
  runProduction(world);
  assert.equal(tin.discoveredBy.length, 0, "undiscovered");
  assert.equal(civ.stores.tin, 0, "no tin from a deposit it never found");
});

test("cutting wood faster than it regrows deforests the land and yield falls", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("plant_domestication", "settlement", "hafting");
  scaleCohorts(world, 0, 200); // a hungry-for-timber population

  const forestCells: number[] = [];
  for (let i = 0; i < world.grid.owner.length; i++) {
    if (world.grid.owner[i] === 0 && world.grid.forest[i] > 0.3) forestCells.push(i);
  }
  assert.ok(forestCells.length > 0, "the civ controls forest to cut");
  const before = forestCells.map((c) => world.grid.forest[c]);

  let firstWood = 0;
  let lastWood = 0;
  for (let y = 0; y < 40; y++) {
    world.year = y;
    const r = resultFor(world, 0);
    if (y === 0) firstWood = r.wood;
    lastWood = r.wood;
  }
  const after = forestCells.map((c) => world.grid.forest[c]);

  for (let i = 0; i < forestCells.length; i++) {
    assert.ok(after[i] < before[i], `forest at cell ${forestCells[i]} was cut down`);
    assert.ok(after[i] < 0.1, "sustained over-cutting drives forest toward zero");
  }
  assert.ok(lastWood < firstWood, `wood yield falls as the forest is exhausted (${firstWood} -> ${lastWood})`);
});

test("a depleted deposit stops producing", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  civ.capabilities.push("plant_domestication", "settlement", "copper_working");
  scaleCohorts(world, 0, 20);

  const cell = ownedCell(world, 0);
  const deposit: Deposit = {
    kind: "copper",
    name: "Nearly Empty",
    cell,
    richness: 0.6,
    depth: 0.1,
    remaining: 5,
    discoveredBy: [0],
  };
  world.deposits.push(deposit);

  world.year = 0;
  runProduction(world);
  const afterFirst = civ.stores.copper;
  assert.ok(afterFirst > 0, "it produced while it had ore");
  assert.equal(deposit.remaining, 0, "the deposit is exhausted");

  world.year = 1;
  runProduction(world);
  assert.equal(civ.stores.copper, afterFirst, "an empty deposit yields nothing more");
});

test("forests regrow toward their biome climax once cutting stops", () => {
  const world = generateWorld(SEED);
  // Find a forested land cell and clear-cut it.
  let cell = -1;
  for (let i = 0; i < world.grid.land.length; i++) {
    if (world.grid.land[i] === 1 && forestClimax(world.grid.biome[i]) >= 0.75) {
      cell = i;
      break;
    }
  }
  assert.ok(cell >= 0, "found a cell whose climax is a real forest");
  const climax = forestClimax(world.grid.biome[cell]);
  world.grid.forest[cell] = 0; // clear-cut

  for (let y = 0; y < 50; y++) regrowForests(world.grid);
  assert.ok(world.grid.forest[cell] > 0, "the cleared forest grows back");
  assert.ok(world.grid.forest[cell] <= climax + 1e-9, "regrowth never exceeds the climax");
});

test("production is deterministic for a given seed and year", () => {
  const a = resultFor(generateWorld(SEED), 2);
  const b = resultFor(generateWorld(SEED), 2);
  assert.deepEqual(a, b, "same seed replays to the same harvest");
});

test("working-age labour is drawn from the population cohorts, not invented", () => {
  const world = generateWorld(SEED);
  const labour = workingAgePopulation(world, 0);
  const pop = civPopulation(world, 0);
  assert.ok(labour > 0, "there are workers");
  assert.ok(labour < pop, "labour is a subset of the population (children and elders excluded)");
});
