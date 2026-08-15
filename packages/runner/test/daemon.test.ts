/**
 * The daemon: pacing and the live-operation persistence contract.
 *
 * The acceptance criteria these pin: the pace decelerates monotonically as
 * event density rises (assertable, not just logged); the loop survives a hard
 * stop and resumes from the last completed tick with a history identical to an
 * uninterrupted run; per-tick snapshots are pruned back to keyframes so the DB
 * does not grow a world blob per year.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateWorld, serializeWorld, tickWorld, type World } from "@sim/engine";
import { createHeuristicBrain, decideForWorld } from "@sim/agents";
import {
  AttentionTracker,
  decayDensity,
  formatPace,
  PACE_CEIL_MS,
  PACE_FLOOR_MS,
  paceMsPerYear,
  runDaemon,
} from "../src/daemon.ts";
import { Store } from "../src/store.ts";

/* ------------------------------------------------------------------ *
 * Pacing
 * ------------------------------------------------------------------ */

test("pace clamps to the floor when the world is quiet", () => {
  assert.equal(paceMsPerYear(0), PACE_FLOOR_MS);
  assert.equal(paceMsPerYear(-1), PACE_FLOOR_MS);
  assert.ok(paceMsPerYear(0.001) < PACE_FLOOR_MS * 1.1);
});

test("pace approaches (and never exceeds) one sim-year per real day", () => {
  const busy = paceMsPerYear(1e6);
  assert.ok(busy <= PACE_CEIL_MS);
  assert.ok(busy > PACE_CEIL_MS * 0.99, "extreme density should sit at the ceiling");
});

test("pace is monotone nondecreasing in density — the deceleration guarantee", () => {
  let prev = 0;
  for (let d = 0; d <= 8; d += 0.05) {
    const pace = paceMsPerYear(d);
    assert.ok(pace >= prev, `pace regressed at density ${d.toFixed(2)}`);
    prev = pace;
  }
});

test("real calibration points land in watchable bands", () => {
  // Engine-only idle (~0.04 weight/yr): near the floor — minutes, not days.
  assert.ok(paceMsPerYear(0.04) < 5_000);
  // The LLM arm's busiest measured century (~1.8): tens of minutes per year.
  const busy = paceMsPerYear(1.8);
  assert.ok(busy > 60_000 && busy < 4 * 3_600_000, `expected minutes-to-hours, got ${busy}ms`);
});

test("a rising event stream visibly decelerates the tick rate", () => {
  let density = 0;
  let prevPace = paceMsPerYear(density);
  const paces: number[] = [prevPace];
  for (let tick = 0; tick < 60; tick++) {
    density = decayDensity(density, 2.0); // a loud age: 2 weight/yr sustained
    const pace = paceMsPerYear(density);
    assert.ok(pace >= prevPace, "pace must only slow while density rises");
    prevPace = pace;
    paces.push(pace);
  }
  assert.ok(
    paces[paces.length - 1] > paces[0] * 100,
    "sixty loud years should slow the world by orders of magnitude",
  );
  // And silence speeds it back up.
  for (let tick = 0; tick < 200; tick++) density = decayDensity(density, 0);
  assert.ok(paceMsPerYear(density) < paces[paces.length - 1]);
});

test("formatPace renders each magnitude", () => {
  assert.equal(formatPace(2_000), "2.0s/yr");
  assert.equal(formatPace(4 * 60_000), "4.0m/yr");
  assert.equal(formatPace(3 * 3_600_000), "3.0h/yr");
  assert.equal(formatPace(86_400_000), "1.0d/yr");
});

/* ------------------------------------------------------------------ *
 * The loop — restart survival, identical history, snapshot pruning
 * ------------------------------------------------------------------ */

const quietHooks = { now: () => 0, sleep: () => Promise.resolve(), log: () => {} };

/** The reference: an uninterrupted tick+decide loop with the same brain. */
async function referenceRun(seed: number, years: number): Promise<{ world: World; events: number }> {
  const world = generateWorld(seed);
  const brain = createHeuristicBrain();
  let events = world.events.length;
  while (world.year < years) {
    tickWorld(world);
    await decideForWorld(world, { brain, fallback: brain });
    events += world.events.length;
    world.events.length = 0;
  }
  return { world, events };
}

test("daemon: hard stop + restart resumes to a history identical to an uninterrupted run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
  const dbPath = join(dir, "w.db");
  try {
    const seed = 7;
    const brain = createHeuristicBrain();

    // Phase 1: run to year 30, then "crash" — no clean shutdown, just abandon
    // the objects. Per-tick snapshots make the last completed tick durable.
    {
      const store = new Store(dbPath);
      const world = generateWorld(seed);
      store.appendEvents(world.events);
      world.events.length = 0;
      store.saveSnapshot(world);
      const result = await runDaemon(store, world, {
        primary: brain,
        fallback: brain,
        untilYear: 30,
        hooks: quietHooks,
      });
      assert.equal(result.toYear, 30);
      // no store.close(): simulating a kill -9.
    }

    // Phase 2: reopen cold, resume from the latest snapshot, run to year 60.
    const store = new Store(dbPath);
    const world = store.loadLatest();
    assert.ok(world, "a snapshot must survive the crash");
    assert.equal(world.year, 30, "resume point is the last completed tick");
    store.pruneEventsFrom(world.nextEventId); // the daemon's startup guard
    await runDaemon(store, world, {
      primary: brain,
      fallback: brain,
      untilYear: 60,
      hooks: quietHooks,
    });

    // The interrupted history equals the uninterrupted one, byte for byte.
    const ref = await referenceRun(seed, 60);
    assert.equal(
      JSON.stringify(serializeWorld(world)),
      JSON.stringify(serializeWorld(ref.world)),
    );
    // And the event log carries each event exactly once.
    assert.equal(store.eventCount(), ref.events);

    // Snapshot pruning: keyframes (year % 50) and the latest tick survive;
    // intermediate per-tick snapshots are gone.
    assert.equal(store.latestSnapshotYear(), 60);
    assert.ok(store.loadAt(50), "keyframe snapshots must be kept");
    assert.equal(store.loadAt(30), null, "the old resume point is pruned");
    assert.equal(store.loadAt(59), null, "non-keyframe per-tick snapshots are pruned");

    // The status meta is written for viewers, tick rate included.
    const status = JSON.parse(store.getMeta("daemon.status") ?? "{}") as {
      year: number;
      paceMsPerYear: number;
      simYearsPerRealDay: number;
    };
    assert.equal(status.year, 60);
    assert.ok(status.paceMsPerYear >= PACE_FLOOR_MS);
    assert.ok(status.simYearsPerRealDay > 0);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon: abort stops after the tick in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-daemon-"));
  const dbPath = join(dir, "w.db");
  try {
    const store = new Store(dbPath);
    const world = generateWorld(3);
    store.appendEvents(world.events);
    world.events.length = 0;
    store.saveSnapshot(world);

    const brain = createHeuristicBrain();
    const controller = new AbortController();
    let ticks = 0;
    const result = await runDaemon(store, world, {
      primary: brain,
      fallback: brain,
      signal: controller.signal,
      hooks: quietHooks,
      onTick: () => {
        ticks++;
        if (ticks === 5) controller.abort();
      },
    });
    assert.equal(result.ticks, 5);
    assert.equal(store.latestSnapshotYear(), world.year, "the last tick is durable");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attention tracker feeds rising scores to eventful civs and starving ones", () => {
  const world = generateWorld(5);
  const tracker = new AttentionTracker(world);
  const civ = world.civs[0];

  const quiet = tracker.score({ world, civ, briefing: { system: [], context: "", civId: civ.id } });

  // A century of loud events involving this civ raises its consequence.
  for (let i = 0; i < 100; i++) {
    world.year++;
    tracker.update(world, [
      { id: i, year: world.year, kind: "war", civ: civ.id, cell: null, weight: 0.8, text: "", causedBy: [] },
    ]);
  }
  const loud = tracker.score({ world, civ, briefing: { system: [], context: "", civId: civ.id } });
  assert.ok(loud > quiet, `eventful history must raise the score (${loud} vs ${quiet})`);

  // A model decision resets staleness, lowering the score.
  tracker.notedModelDecision(civ.id, world.year);
  const justServed = tracker.score({ world, civ, briefing: { system: [], context: "", civId: civ.id } });
  assert.ok(justServed < loud);
});
