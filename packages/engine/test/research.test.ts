import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CAPABILITY_BY_ID,
  STARTING_CAPABILITIES,
  blockedBecause,
} from "../src/knowledge.ts";
import {
  WRITING_MULT,
  advanceResearch,
  capabilitySpread,
  holderStrength,
  researchCapacity,
  researchGates,
  stepResearch,
} from "../src/research.ts";
import type { World } from "../src/types.ts";
import { civPopulation } from "../src/types.ts";
import { generateWorld } from "../src/worldgen.ts";

const SEED = 12345;

/** Scale every cohort of a civ — the cheap way to grow or crash a population
 * for a test, since `civPopulation` sums the cohort view. */
function scaleCohorts(world: World, civId: number, factor: number): void {
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    for (let b = 0; b < s.cohorts.length; b++) s.cohorts[b] *= factor;
  }
}

/** Give a civ an exact, prerequisite-closed capability set and a clean slate. */
function setCapabilities(world: World, civId: number, caps: string[]): void {
  const civ = world.civs[civId];
  civ.capabilities = [...caps];
  civ.holders = {};
  civ.forgotten = [];
  civ.research = { target: null, progress: 0 };
}

/* ================================================================== *
 * Gates: prerequisites, materials, terrain, population
 * ================================================================== */

test("a civ with no tin in reach never completes bronze, and the refusal is honest", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0]; // aquitaine — no tin in its small home range
  // Everything bronze needs except the tin half: it can smelt and work copper.
  setCapabilities(world, 0, [
    ...STARTING_CAPABILITIES,
    "hafting",
    "shelter",
    "plant_domestication",
    "settlement",
    "pottery",
    "kiln",
    "smelting",
    "copper_working",
  ]);
  scaleCohorts(world, 0, 20); // ample scholars, and enough holders that nothing is lost
  civ.policy.research = 0.6;
  civ.research.target = "bronze";

  let lastBlocked: string | null = null;
  for (let y = 0; y < 300; y++) {
    world.year = y;
    lastBlocked = stepResearch(world, civ).blocked;
  }

  assert.equal(civ.capabilities.includes("bronze"), false, "bronze is unreachable without tin");
  assert.equal(civ.capabilities.includes("tin_working"), false, "and so is tinworking");
  assert.equal(lastBlocked, "no reachable tin", "the step reports the true wall");

  // And `blockedBecause()` from knowledge.ts, driven by the same gates, agrees.
  const gates = researchGates(world, 0);
  const tinWorking = CAPABILITY_BY_ID.get("tin_working");
  assert.ok(tinWorking);
  assert.equal(
    blockedBecause(tinWorking, gates.held, gates.hasMaterial, gates.hasTerrain, gates.population),
    "no reachable tin",
  );
});

test("capabilities never appear without every prerequisite already held", () => {
  const world = generateWorld(SEED);
  for (const civ of world.civs) civ.policy.research = 0.5;
  scaleCohorts(world, 0, 15);
  scaleCohorts(world, 1, 15);
  scaleCohorts(world, 2, 15);
  scaleCohorts(world, 3, 15);
  scaleCohorts(world, 4, 15);

  let anyCompleted = false;
  for (let y = 0; y < 200; y++) {
    world.year = y;
    const results = advanceResearch(world);
    for (const r of results) if (r.completed.length > 0) anyCompleted = true;

    for (const civ of world.civs) {
      const held = new Set(civ.capabilities);
      for (const id of civ.capabilities) {
        const cap = CAPABILITY_BY_ID.get(id);
        if (!cap) continue;
        for (const need of cap.needs) {
          assert.ok(held.has(need), `year ${y}: ${civ.key} holds ${id} without prerequisite ${need}`);
        }
      }
    }
  }
  assert.ok(anyCompleted, "some research actually completed over the run");
});

/* ================================================================== *
 * Effort scales with scholarship, not raw headcount
 * ================================================================== */

test("research rate scales with literate/scholarly population, not raw headcount", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];

  const base = researchCapacity(world, 0);
  assert.ok(base > 0, "a living band does some research");

  // Same population, same settlements — only literacy changes.
  civ.capabilities.push("writing");
  const literate = researchCapacity(world, 0);
  assert.ok(literate > base, "at identical headcount, writing raises the research rate");
  assert.ok(Math.abs(literate - base * WRITING_MULT) < 1e-9, "and by exactly the writing multiplier");
  civ.capabilities.pop();

  // The scholar *share* drives it too: double the fraction, double the output,
  // with the population untouched.
  const p0 = researchCapacity(world, 0);
  civ.policy.research *= 2;
  const p1 = researchCapacity(world, 0);
  assert.ok(Math.abs(p1 - p0 * 2) < 1e-9, "doubling policy.research doubles the rate at the same population");
});

/* ================================================================== *
 * Knowledge loss — write it down or lose it
 * ================================================================== */

test("a population crash drops an unwritten capability; writing preserves it", () => {
  // A pre-literate smelting culture. `smelting` is held by a specialised few.
  const preLiterate = [
    ...STARTING_CAPABILITIES,
    "hafting",
    "shelter",
    "plant_domestication",
    "settlement",
    "pottery",
    "kiln",
    "smelting",
  ];

  // --- unwritten: the plague costs them the craft -----------------
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  setCapabilities(world, 0, preLiterate);
  civ.policy.research = 0; // freeze research so we watch loss in isolation

  world.year = 1;
  stepResearch(world, civ);
  assert.ok(civ.capabilities.includes("smelting"), "a populous culture keeps its craft");
  const holders = holderStrength(civ, "smelting");
  assert.ok(holders >= 3, `and has carriers to spare (${holders.toFixed(1)})`);

  scaleCohorts(world, 0, 0.05); // a plague kills 95% in one year
  world.year = 2;
  const step = stepResearch(world, civ);
  assert.ok(!civ.capabilities.includes("smelting"), "unwritten, the craft dies with its carriers");
  assert.ok(step.lost.includes("smelting"), "the step reports the loss");
  assert.ok(civ.forgotten.includes("smelting"), "but the civ remembers that it once knew it");

  // --- written: the same crash, but they wrote it down ------------
  const world2 = generateWorld(SEED);
  const civ2 = world2.civs[0];
  setCapabilities(world2, 0, [...preLiterate, "granary", "counting", "writing"]);
  civ2.policy.research = 0;

  world2.year = 1;
  stepResearch(world2, civ2);
  assert.ok(civ2.holders.smelting.written, "with writing, the craft is recorded");

  scaleCohorts(world2, 0, 0.05);
  world2.year = 2;
  stepResearch(world2, civ2);
  assert.ok(civ2.capabilities.includes("smelting"), "a civ that wrote it down keeps it through the plague");
});

test("starting capabilities survive even a near-extinction, but nothing else does", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  setCapabilities(world, 0, [...STARTING_CAPABILITIES, "hafting", "clothing"]);
  civ.policy.research = 0;

  scaleCohorts(world, 0, 0.02); // a few survivors
  world.year = 1;
  stepResearch(world, civ);

  for (const id of STARTING_CAPABILITIES) {
    assert.ok(civ.capabilities.includes(id), `${id} is never forgotten`);
  }
  assert.ok(!civ.capabilities.includes("hafting"), "acquired knowledge goes when the carriers do");
});

test("a lost capability is cheaper to re-discover than to invent", () => {
  function yearsToLearnHafting(seed: number, alreadyForgotten: boolean): number {
    const world = generateWorld(seed);
    const civ = world.civs[0];
    civ.capabilities = [...STARTING_CAPABILITIES];
    civ.holders = {};
    civ.forgotten = alreadyForgotten ? ["hafting"] : [];
    civ.research = { target: "hafting", progress: 0 };
    civ.policy.research = 0.05; // slow enough that it takes many years
    let y = 0;
    while (!civ.capabilities.includes("hafting") && y < 5000) {
      world.year = y;
      stepResearch(world, civ);
      y++;
    }
    return y;
  }

  const fresh = yearsToLearnHafting(SEED, false);
  const relearn = yearsToLearnHafting(SEED, true);
  assert.ok(fresh < 5000 && relearn < 5000, "both eventually learn it");
  assert.ok(relearn < fresh, `re-discovery is faster (${relearn} vs ${fresh} years)`);
});

/* ================================================================== *
 * Holders bookkeeping and determinism
 * ================================================================== */

test("holders are seeded for every held capability and scale with population", () => {
  const world = generateWorld(SEED);
  const civ = world.civs[0];
  world.year = 1;
  stepResearch(world, civ);

  for (const id of civ.capabilities) {
    assert.ok(civ.holders[id], `holders tracked for ${id}`);
  }
  // Basic survival knowledge is held by far more people than any craft would be.
  const fire = CAPABILITY_BY_ID.get("fire");
  assert.ok(fire && capabilitySpread(fire) > capabilitySpread(CAPABILITY_BY_ID.get("smelting") ?? fire));
  const pop = civPopulation(world, 0);
  assert.ok(civ.holders.fire.people <= pop, "carriers never exceed the population");
});

test("research is deterministic for a given seed", () => {
  function run(seed: number, years: number): World {
    const world = generateWorld(seed);
    for (let y = 0; y < years; y++) {
      world.year = y;
      advanceResearch(world);
    }
    return world;
  }

  const a = run(SEED, 400);
  const b = run(SEED, 400);
  assert.deepEqual(
    a.civs.map((c) => c.capabilities),
    b.civs.map((c) => c.capabilities),
    "same seed replays to the same capabilities",
  );
  assert.deepEqual(
    a.civs.map((c) => c.forgotten),
    b.civs.map((c) => c.forgotten),
  );
  assert.deepEqual(
    a.events.map((e) => e.text),
    b.events.map((e) => e.text),
    "and the same discoveries and losses, in the same order",
  );
});
