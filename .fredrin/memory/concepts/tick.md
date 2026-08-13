# Tick, persistence and the runner

The loop that makes the world actually run. The engine subsystems (population,
production, research, settlement) are pure functions; this layer sequences them
into a year, persists the result, and exposes a CLI. Implemented in
`packages/engine/src/tick.ts` and `world.ts`, and `packages/runner/src/{store,run,cli}.ts`.
No LLM is involved anywhere on this path.

## The tick — one sim-year, fixed order

`tickWorld(world)` (`tick.ts`) advances the world by exactly one year in a
**fixed, dependency-ordered sequence**, and a later stage reads what an earlier
stage wrote *this* year:

1. **environment** — relief and climate are fixed after worldgen; the one living
   environmental process, forest regrowth, runs inside production. So this is an
   explicit no-op seam where future climate/season lands.
2. **production** — `runProduction(world)`: land + labour → goods, into stores,
   deposits and forest cover.
3. **population + settlement/migration** — `stepSettlements(world)`. This is a
   **single call for two constraint stages**: `stepSettlements` *owns* the
   population step (`stepPopulation` per settlement), because migration is the
   release valve for population pressure and can't be separated from it. Do not
   call `stepPopulation` from the tick — settlement does it against each site's
   local carrying capacity.
4. **research** — `advanceResearch(world)`: spend scholarship toward each civ's
   target; lose unwritten knowledge whose carriers have died.
5. **event emission** — derived, world-level events the subsystems don't own.
   Today that is only extinction: a living civ whose population just hit zero is
   marked `alive = false` with an `extinctYear` and a `collapse` event.
6. **agent directive intake** — the seam where the NEXT tick's agent directives
   are read. **No agents/LLM this ticket.** The stage is fixed in the order now
   so that, once agents exist, a directive can never take effect in the same
   tick it was issued — an agent must never observe the result of its own action
   within a tick (that is how oracle behaviour creeps in).

All stages run while `world.year` still holds the year being simulated; the
clock is advanced to `year + 1` only at the very end. So after N ticks from a
fresh world, `world.year === N`. Multi-rate pacing (fast prehistory, slowing
later) is a **separate, later ticket** — here a tick is exactly one year.

### Determinism is the contract

Every stochastic draw comes from a seeded stream keyed by
`(subsystem, ids, world.year)` via `hashSeed`, so the result never depends on
the order the tick visited things in, how many draws a sibling consumed, or how
a run was chopped up. There is **no `Math.random` and no `Date.now` anywhere on
the tick path** — timing and wall-clock belong to the runner, never to the
world. Two worlds from the same seed run 2,000 years are byte-identical (proven
by serialised-blob equality, not just a fingerprint).

## Serialisation — `world.ts`

A world is mostly typed arrays: 11 grid arrays of 64,800 cells each, plus an
80-slot age pyramid per settlement. `serializeWorld`/`deserializeWorld` store
those as **base64 of their raw bytes** — compact and byte-for-byte reversible,
which is what lets a snapshot restore to a state the tick then replays
identically. Everything else (deposits, civs, events, counters) rides along as
ordinary JSON. The format carries a version (`WORLD_FORMAT_VERSION`) so a shape
change is a migration, not a silent misread. Base64 decode copies into a fresh
zero-offset buffer so Float32/Float64 alignment is guaranteed.

## Persistence and resume — `store.ts` + `run.ts`

Built on the **built-in `node:sqlite`** (Node 24; no native dependency). Two
things are stored, and the split is deliberate:

- **Snapshots** — whole world state at a year, written every `SNAPSHOT_INTERVAL`
  (**50**) years and on clean exit. The world is "live present only" — there is
  no rewind — so a snapshot is a resume point, not a history.
- **Events** — an **append-only log** keyed by the engine's own monotonic event
  id, inserted `ON CONFLICT(id) DO NOTHING`.

Each tick the runner (`advanceWorld` in `run.ts`) drains `world.events` into the
log and **clears the array**, so snapshots carry state only and never a growing
event list. Nothing reads `world.events` mid-tick, so clearing is safe; the
`nextEventId` counter (in the snapshot) is what carries continuity.

**Resume falls out of this for free.** After a crash, reload the last snapshot
and call `advanceWorld` again toward the same target. The lost years re-tick
deterministically, re-emit the *identical* events with the *identical* ids, and
the id-keyed insert drops the duplicates. A `kill -9` mid-run followed by a
re-run reaches a byte-identical final state with no gaps or duplicates in the
log. WAL + `synchronous=NORMAL` keeps the last committed snapshot durable across
a process kill (the resume contract) without an fsync per write.

## CLI — `cli.ts`

`new --seed N`, `run --years YEAR`, `status`, `history --limit N`, all taking
`--db PATH` (default `worlds/world.db`, a gitignored dir).

- **`--years N` is an absolute target year, not a duration.** Re-running `run`
  after an interruption continues toward the same year rather than overshooting
  — which is exactly what makes "kill it and re-run" resume to the same state.

### pnpm gotcha: `run` collides with pnpm's built-in

`new`, `status` and `history` are not pnpm sub-commands, so `pnpm new --seed 1`,
`pnpm status`, `pnpm history --limit 40` work directly (pnpm forwards the flags).
But **`run` IS a pnpm built-in**, so `pnpm run --years 2000` is intercepted by
pnpm (`Unknown option: 'years'`). Invoke the `run` **script** as
**`pnpm run run --years 2000`** (or `node --import tsx packages/runner/src/cli.ts run --years 2000`).
