# @sim/runner

The tick orchestrator, persistent store and CLI for the simulation engine.
It turns the pure engine subsystems into a planet that ticks: a deterministic
one-year tick (`@sim/engine`'s `tickWorld`), a `node:sqlite` store with
snapshots and an append-only event log, and a CLI to create, advance and
inspect a world. No LLM is involved anywhere.

## Commands

| Do this | Command |
|---|---|
| Create a fresh world at year 0 | `pnpm new --seed 1` |
| Advance to (absolute) year 2000 | `pnpm run run --years 2000` |
| Print year, per-civ population, settlements, capabilities | `pnpm status` |
| Print recent events, newest first | `pnpm history --limit 40` |

All commands accept `--db <path>` (default `worlds/world.db`, a gitignored
directory).

### ⚠️ `pnpm run` collides with pnpm's built-in

`run` is a reserved pnpm sub-command, so `pnpm run --years 2000` is intercepted
by pnpm itself (`Unknown option: 'years'`). Invoke the **`run` script** with the
doubled word:

```sh
pnpm run run --years 2000
# or, bypassing pnpm's script layer entirely:
node --import tsx packages/runner/src/cli.ts run --years 2000
```

`new`, `status` and `history` are not pnpm built-ins, so they work directly.

## Determinism & resume

`--years N` is an **absolute target year**, not a duration — re-running after an
interruption continues toward the same year rather than overshooting. A snapshot
is written every 50 years and on clean exit; the event log is append-only and
idempotent. So killing a run mid-flight and re-running it resumes from the last
snapshot and reaches a byte-identical final state, with no gaps or duplicate
events. A given seed always replays to the same history.

See `.fredrin/memory/concepts/tick.md` for the full design.
