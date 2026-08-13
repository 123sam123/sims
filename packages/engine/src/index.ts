/**
 * Public surface of the simulation engine (`@sim/engine`).
 *
 * The engine is deterministic and IO-free: give `generateWorld(seed)` a seed and
 * `tickWorld(world)` a world, and the same inputs always replay to the same
 * history. Persistence, timing and the CLI live in the runner, not here.
 */

export * from "./types.ts";
export * from "./events.ts";
export * from "./rng.ts";
export * from "./geo-data.ts";
export * from "./knowledge.ts";
export * from "./production.ts";
export * from "./pop.ts";
export * from "./settlement.ts";
export * from "./research.ts";
export * from "./tick.ts";
export * from "./world.ts";
// worldgen re-exports GRID_W/GRID_H/cellIndex from ./types; take only its own
// symbols here so those names resolve unambiguously through the barrel.
export { generateWorld, landCellCount } from "./worldgen.ts";
