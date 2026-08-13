/**
 * The tick orchestrator, store and resume contract.
 *
 * Determinism is the whole point: a seed replays to one history, a snapshot
 * restores to a state the tick continues identically, and a crash mid-run loses
 * no correctness — only re-derivable wall-clock progress. These tests pin all
 * three, plus the base64 round-trip that makes snapshots faithful.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  civPopulation,
  deserializeWorld,
  generateWorld,
  serializeWorld,
  tickWorld,
  type World,
} from "@sim/engine";
import { advanceWorld } from "../src/run.ts";
import { Store } from "../src/store.ts";

/** A total order over the observable state the acceptance criteria name:
 *  year, per-civ population, capability set and settlement count. */
function fingerprint(world: World): string {
  return JSON.stringify({
    year: world.year,
    settlements: world.settlements.length,
    civs: world.civs.map((c) => ({
      id: c.id,
      alive: c.alive,
      pop: civPopulation(world, c.id),
      caps: [...c.capabilities].sort(),
      settlements: world.settlements.filter((s) => s.civ === c.id).length,
    })),
  });
}

function tickN(world: World, n: number): void {
  for (let i = 0; i < n; i++) tickWorld(world);
}

test("same seed replays to an identical world after 1,000 years", () => {
  const a = generateWorld(12345);
  const b = generateWorld(12345);
  tickN(a, 1000);
  tickN(b, 1000);

  // The acceptance-named observables…
  assert.equal(fingerprint(a), fingerprint(b));
  // …and, far stronger, every cell, deposit and counter of the whole world.
  assert.equal(JSON.stringify(serializeWorld(a)), JSON.stringify(serializeWorld(b)));
});

test("different seeds diverge (the fingerprint actually discriminates)", () => {
  const a = generateWorld(1);
  const b = generateWorld(2);
  tickN(a, 500);
  tickN(b, 500);
  assert.notEqual(fingerprint(a), fingerprint(b));
});

test("serialise/deserialise round-trips a world exactly, and it keeps ticking identically", () => {
  const w = generateWorld(99);
  tickN(w, 80); // long enough to found colonies, mine deposits and log events

  const json1 = JSON.stringify(serializeWorld(w));
  const restored = deserializeWorld(JSON.parse(json1));
  const json2 = JSON.stringify(serializeWorld(restored));
  assert.equal(json2, json1, "round-trip must be byte-identical");

  // Typed arrays specifically survive the base64 hop.
  assert.deepEqual([...restored.grid.owner], [...w.grid.owner]);
  assert.deepEqual([...restored.grid.forest], [...w.grid.forest]);
  assert.deepEqual([...restored.settlements[0].ages], [...w.settlements[0].ages]);

  // A deserialised world is not just equal, it is live: continuing it matches a
  // world generated fresh and ticked straight through.
  const straight = generateWorld(99);
  tickN(straight, 120);
  tickN(restored, 40);
  assert.equal(fingerprint(restored), fingerprint(straight));
});

test("a killed run resumes from the last snapshot to an identical state, with no gaps or duplicate events", () => {
  const dir = mkdtempSync(join(tmpdir(), "sims-resume-"));
  try {
    // Straight through, 0 -> 600, the reference.
    const straightDb = join(dir, "straight.db");
    const s1 = new Store(straightDb);
    const w1 = generateWorld(777);
    s1.saveSnapshot(w1); // the year-0 snapshot `new` writes
    advanceWorld(s1, w1, 600);
    const referenceState = fingerprint(w1);
    const referenceEvents = s1.eventCount();
    s1.close();

    // Interrupted: run 0 -> 430 with no clean final snapshot (a kill), then a
    // fresh process reopens the store and continues to 600.
    const resumeDb = join(dir, "resume.db");
    const s2 = new Store(resumeDb);
    const w2 = generateWorld(777);
    s2.saveSnapshot(w2);
    advanceWorld(s2, w2, 430, { finalSnapshot: false });
    s2.close(); // process killed — only periodic snapshots survive

    const reopened = new Store(resumeDb);
    const resumed = reopened.loadLatest();
    assert.ok(resumed, "must resume from a snapshot");
    assert.ok(
      resumed.year >= 400 && resumed.year <= 430,
      `resumed from the last 50-year snapshot, got year ${resumed.year}`,
    );
    advanceWorld(reopened, resumed, 600);
    const resumedState = fingerprint(resumed);
    const resumedEvents = reopened.eventCount();
    reopened.close();

    assert.equal(resumedState, referenceState, "resumed year-600 state must match the straight run");
    assert.equal(
      resumedEvents,
      referenceEvents,
      "the append-only log must have no gaps and no duplicates after resume",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--years is an absolute target: reaching it again is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "sims-target-"));
  try {
    const db = join(dir, "w.db");
    const store = new Store(db);
    const world = generateWorld(3);
    store.saveSnapshot(world);
    const first = advanceWorld(store, world, 200);
    assert.equal(first.toYear, 200);
    const again = advanceWorld(store, world, 200);
    assert.equal(again.ticks, 0, "already at the target — nothing to advance");
    assert.equal(world.year, 200);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
