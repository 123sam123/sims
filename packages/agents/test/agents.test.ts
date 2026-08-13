/**
 * The agent loop: fog of war, the six-gate adjudication, and the timing that
 * keeps a directive from taking effect within the tick that issued it.
 *
 * These pin the acceptance criteria directly: a stone-age band cannot order
 * bronze and is told why; a briefing never leaks a neighbour's ground truth; an
 * accepted order draws real stores over more than one year; and the whole loop
 * runs with no API key on the deterministic heuristic brain.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Civ,
  executeDirectives,
  generateWorld,
  tickWorld,
  type World,
  workingAgePopulation,
} from "@sim/engine";
import {
  adjudicate,
  buildBriefing,
  createHeuristicBrain,
  decideForWorld,
  makeBrains,
} from "@sim/agents";

/** Give a civ enough to actually build: the capability to settle, a full
 *  store of timber and stone, and hands spared for building. */
function readyToBuild(civ: Civ): void {
  if (!civ.capabilities.includes("settlement")) civ.capabilities.push("settlement");
  civ.stores.wood = 500;
  civ.stores.stone = 500;
  civ.policy.building = 0.1;
}

function briefingText(world: World, civ: Civ): string {
  const b = buildBriefing(world, civ);
  return `${b.system.map((s) => s.text).join("\n")}\n${b.context}`;
}

test("a band that has never smelted cannot order bronze tools, and is told why", () => {
  const world = generateWorld(3);
  const civ = world.civs[0]; // a fresh stone-age band: no smelting, no bronze

  const verdict = adjudicate(world, civ, { type: "construct", building: "bronze tools" });

  assert.equal(verdict.ok, false);
  if (verdict.ok) return; // narrow the type
  assert.equal(verdict.gate, "knowledge");
  // The refusal names the missing capability — smelting, the thing they've never done.
  assert.match(verdict.reason, /smelt/i);
});

test("the briefing carries no ground truth about a civ this one has not met", () => {
  const world = generateWorld(11);
  tickWorld(world);
  const a = world.civs[0];
  const b = world.civs[1];

  // Give B a distinctive, secret internal state.
  b.name = "Ironhold-SECRET";
  b.capabilities.push("smelting", "bronze");
  b.chronicle.push("SECRET_MARKER_XYZ — we forged the first bronze");
  b.stores.copper = 9999;

  // A has met no one (the default: `known` is empty).
  const unmet = briefingText(world, a);
  assert.ok(!unmet.includes("Ironhold-SECRET"), "must not leak an unmet civ's name");
  assert.ok(!unmet.includes("SECRET_MARKER_XYZ"), "must not leak an unmet civ's chronicle");
  assert.ok(!unmet.includes("9999"), "must not leak an unmet civ's stores");

  // Now A meets B. A may know B's *name* and the recorded relation — nothing more.
  a.known.push(b.id);
  a.relations[b.id] = {
    opinion: -20,
    atWar: false,
    treaty: null,
    grievances: [],
    contactYear: world.year,
  };
  const met = briefingText(world, a);
  assert.ok(met.includes("Ironhold-SECRET"), "a met neighbour's name is knowable");
  assert.ok(!met.includes("SECRET_MARKER_XYZ"), "even a met civ's private chronicle stays hidden");
  assert.ok(!met.includes("9999"), "even a met civ's stores stay hidden");
});

test("a directive issued this year takes effect no earlier than the next", () => {
  const world = generateWorld(7);
  tickWorld(world); // world.year === 1
  const civ = world.civs[0];
  readyToBuild(civ);

  const verdict = adjudicate(world, civ, { type: "construct", building: "storehouse" });
  assert.ok(verdict.ok);
  if (!verdict.ok) return;
  verdict.apply(world, civ);

  // Applied, but not yet executed — the issuing "tick" never touches its own order.
  assert.equal(civ.projects?.length, 1);
  const project = (civ.projects ?? [])[0];
  assert.equal(project.remaining, project.total, "no labour drawn in the year it was issued");

  // Only a subsequent tick executes it.
  tickWorld(world);
  const after = (civ.projects ?? [])[0];
  const advanced = after === undefined || after.remaining < project.total;
  assert.ok(advanced, "the project advances only on a later tick");
});

test("an accepted construction draws real materials and labour over more than one year", () => {
  const world = generateWorld(9);
  tickWorld(world);
  const civ = world.civs[0];
  readyToBuild(civ); // building policy is small, so the work outlasts one year

  const verdict = adjudicate(world, civ, { type: "construct", building: "storehouse" });
  assert.ok(verdict.ok);
  if (!verdict.ok) return;
  verdict.apply(world, civ);

  const project = (civ.projects ?? [])[0];
  const woodBefore = civ.stores.wood;
  const stoneBefore = civ.stores.stone;
  const totalLabour = project.total;

  // One year of execution, in isolation from production so the material draw is clean.
  executeDirectives(world);

  const oneYearLabour = workingAgePopulation(world, civ.id) * civ.policy.building;
  assert.ok(oneYearLabour < totalLabour, "the fixture is set so one year cannot finish it");

  const remaining = (civ.projects ?? [])[0];
  assert.ok(remaining, "the project is still standing after one year — it takes several");
  assert.ok(remaining.remaining < totalLabour, "labour was drawn down");
  assert.ok(
    civ.stores.wood < woodBefore || civ.stores.stone < stoneBefore,
    "materials were drawn from the stores",
  );
});

test("policy is a bounded, validated delta; out-of-range values are clamped", () => {
  const world = generateWorld(13);
  const civ = world.civs[0];

  const verdict = adjudicate(world, civ, { type: "policy", research: 5, building: -2 });
  assert.ok(verdict.ok);
  if (!verdict.ok) return;
  verdict.apply(world, civ);

  assert.equal(civ.policy.research, 1, "research clamped to 1");
  assert.equal(civ.policy.building, 0, "building clamped to 0");
});

test("the loop runs with no API key and emits both decision and refusal events", async () => {
  const world = generateWorld(5);
  tickWorld(world);

  // With no key, the selection is the deterministic heuristic — no network.
  const selection = makeBrains({ apiKey: "" });
  assert.equal(selection.usingLlm, false);
  assert.equal(selection.brain.kind, "heuristic");

  await decideForWorld(world, { brain: createHeuristicBrain(), force: true });

  const kinds = new Set(world.events.map((e) => e.kind));
  assert.ok(kinds.has("decision"), "a decision is recorded for the round");
  assert.ok(kinds.has("refusal"), "reaching past the walls is recorded as a refusal");
});

test("the heuristic brain is deterministic — same world, same directives", async () => {
  const a = generateWorld(21);
  const b = generateWorld(21);
  tickWorld(a);
  tickWorld(b);

  await decideForWorld(a, { brain: createHeuristicBrain(), force: true });
  await decideForWorld(b, { brain: createHeuristicBrain(), force: true });

  assert.deepEqual(
    a.events.map((e) => e.text),
    b.events.map((e) => e.text),
  );
});
