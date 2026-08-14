/**
 * Public surface of the runner (`@sim/runner`).
 *
 * The CLI is the runner's own entry point and stays out of this barrel; what
 * other packages need is the persistent {@link Store} (to read a live world's
 * snapshots and event log) and the {@link advanceWorld} loop. The web app reads
 * the current world through `Store.loadLatest()`.
 */

export { Store, SNAPSHOT_INTERVAL } from "./store.ts";
export { advanceWorld } from "./run.ts";
export type { AdvanceOptions, AdvanceResult } from "./run.ts";
