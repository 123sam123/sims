/**
 * The run loop: advance a world year by year against a store, persisting as it
 * goes. Shared by the CLI and the tests so there is exactly one definition of
 * how a run, a snapshot and the event log fit together.
 *
 * Each iteration ticks one year, drains that year's events into the append-only
 * log, and empties the world's own event buffer so snapshots stay lean. A
 * snapshot is written on every `SNAPSHOT_INTERVAL` boundary and once more on a
 * clean finish, so the final year is always captured even when it is not a
 * multiple of the interval.
 *
 * Resume falls out of this for free: reload the last snapshot and call
 * `advanceWorld` again toward the same target. The lost years re-tick
 * deterministically, re-emit the identical events, and the store dedupes them.
 */

import { tickWorld, type TickReport, type World } from "@sim/engine";
import { SNAPSHOT_INTERVAL, type Store } from "./store.ts";

export interface AdvanceOptions {
  /** Write a final snapshot when the target is reached. Off simulates a crash
   *  that never got to exit cleanly. Default true. */
  finalSnapshot?: boolean;
  /** Called after each tick with the just-produced report. For progress output. */
  onTick?: (world: World, report: TickReport) => void;
}

export interface AdvanceResult {
  fromYear: number;
  toYear: number;
  ticks: number;
}

/**
 * Advance `world` until `world.year >= targetYear`, persisting to `store`.
 * `targetYear` is an absolute year, so calling this again after a resume
 * continues toward the same destination rather than overshooting. A no-op when
 * the world is already at or past the target (a final snapshot is still written
 * unless disabled).
 */
export function advanceWorld(
  store: Store,
  world: World,
  targetYear: number,
  opts: AdvanceOptions = {},
): AdvanceResult {
  const { finalSnapshot = true, onTick } = opts;
  const fromYear = world.year;

  while (world.year < targetYear) {
    const report = tickWorld(world);
    // Drain this year's events into the log, then clear so the next snapshot
    // carries state only — never a growing event array.
    store.appendEvents(world.events);
    world.events.length = 0;
    if (world.year % SNAPSHOT_INTERVAL === 0) store.saveSnapshot(world);
    onTick?.(world, report);
  }

  if (finalSnapshot) store.saveSnapshot(world);
  return { fromYear, toYear: world.year, ticks: world.year - fromYear };
}

/** A decision pass over the world, run between ticks. Mutates the world (and its
 *  event buffer) in place; enqueues work the next tick executes. */
export type DecisionHook = (world: World) => Promise<void>;

/**
 * Like {@link advanceWorld}, but runs an async decision pass after every tick —
 * this is the agent path. The hook (the civilisation minds) observes the
 * just-simulated year and enqueues directives that only take effect in later
 * years; its `decision`/`refusal` events are pushed onto the same buffer and
 * drained in the very same iteration, so the snapshot-and-log contract is
 * preserved exactly as in the plain loop. Async because a brain may call a model.
 */
export async function advanceWorldWithDecisions(
  store: Store,
  world: World,
  targetYear: number,
  decide: DecisionHook,
  opts: AdvanceOptions = {},
): Promise<AdvanceResult> {
  const { finalSnapshot = true, onTick } = opts;
  const fromYear = world.year;

  while (world.year < targetYear) {
    const report = tickWorld(world);
    // Decide AFTER the tick, BEFORE the drain: the mind never sees its own
    // directive land within the tick that issued it, and its events ride out on
    // this iteration's drain rather than lingering into the next snapshot.
    await decide(world);
    store.appendEvents(world.events);
    world.events.length = 0;
    if (world.year % SNAPSHOT_INTERVAL === 0) store.saveSnapshot(world);
    onTick?.(world, report);
  }

  if (finalSnapshot) store.saveSnapshot(world);
  return { fromYear, toYear: world.year, ticks: world.year - fromYear };
}
