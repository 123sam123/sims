# Live operation — the daemon, time dilation and the attention budget

How the world runs 24/7 at a watchable pace without the model bill tracking
world complexity. Implemented in `packages/runner/src/daemon.ts` (the loop and
pacing), `packages/runner/src/attention.ts` (consequence scoring and the
budget) and `packages/runner/src/llm.ts` (metered model transports); the spend
ledger and snapshot pruning live on the store. Entry point: `pnpm daemon`
(plus `pnpm daemon report`, `pnpm daemon budget --daily-usd N` and
`pnpm daemon restore`). **This does not run on Vercel** — it is one long-lived
process for a VM or container; the website reads the SQLite file locally in
dev, and in production the shared Postgres replica the daemon publishes (see
[[tick]] and *Deployment* below).

## Time dilation — pace follows event density

A fixed tick rate cannot work: at a year a minute prehistory is days of empty
map and a busy era is an unreadable firehose. The daemon keeps an EWMA
(halflife 25 sim-years) of emitted **event weight per sim-year** — the same
calibrated weights the chronicle ranks by ([[events]]) — and maps it through
`paceMsPerYear`: a Hill curve picks a position on a **log-space** ramp from
`PACE_FLOOR_MS` (2 s/yr, an empty world) to `PACE_CEIL_MS` (one sim-year per
real day). Log-space is load-bearing: the range spans 43,000×, so linear
interpolation would pin everything to the ceiling. Calibration anchors, from
real runs: engine-only worlds idle at 0.03–0.7 weight/yr (≈ floor); the
LLM-driven divergence arm ran 0.3–1.8 and rises with era. Pace is monotone in
density by construction and the world slows *for everyone* — density is
global, not per-civ. The current pace is published every tick in the
`daemon.status` meta key (year, density, paceMsPerYear, simYearsPerRealDay,
budget numbers) for the site to show viewers.

## The attention budget — model calls bid by consequence

Model attention is a budgeted resource with a **hard daily dollar cap**
(default $10/day; meta key `budget.dailyUsd`, changeable while the daemon runs
via `pnpm daemon budget` — no restart, no redeploy). Every due civ decision
bids with a `consequenceScore` (era, population share, EWMA of recent event
weight involving the civ, and *staleness* — sim-years since its last
model-driven decision, the fairness valve that stops starvation). Two guards
must both pass: the **calendar-day cap** checked against the persisted spend
ledger (restarts cannot double-spend a day), and a **USD token bucket**
refilled continuously at cap/24h (a fast-ticking hour cannot burn the whole
day). Above them sits the adaptive **bar**: the score quantile admitting
roughly as many bids as the budget affords, from the observed bid arrival rate
and observed average call cost — as the world gets faster and richer the bar
rises on its own. Refused bids resolve through the deterministic heuristic
([[agents]]); an approved call's real cost settles the reservation and lands
in the `spend` table (category `decision` now, `narration` reserved for the
batched narrator). `pnpm daemon report` aggregates by day and category and
reports the prompt-cache hit rate.

**Degrade, never stall.** A model failure resolves that one decision
heuristically; a usage/rate-limit failure additionally benches the model for a
15-minute cooldown. This is the opposite of the divergence experiment's
wait-forever rule, deliberately: the experiment optimised for measurement
purity, the daemon for liveness.

## Metered transports and the cache-hit fix

Two transports, same mind: the API brain (`ANTHROPIC_API_KEY`, cost estimated
from token usage) and the subscription CLI brain (`claude -p`, CLI-reported
notional cost). The experiment measured a ~4% cache hit rate because the
per-civ identity/chronicle rode in `--system-prompt`, breaking the cached
prefix on the first civ-specific byte. The CLI transport now (a) keeps the
system prompt **bit-stable across all civs and years** — world rules + the
directive schema, nothing else, with identity/context moved into the user
message — and (b) gives each civ a **resumed CLI session** (`--resume`), so a
decision reads its whole prior transcript from cache and pays uncached tokens
only for the new turn. Sessions reset after 30 turns to bound growth; the
chronicle remains the durable memory across resets, exactly as [[agents]]
intends. Session ids persist in meta `daemon.sessions` and survive restarts.

## Persistence — crash loses at most one tick

The loop is tick → decide → drain → snapshot, every iteration, with
non-keyframe snapshots pruned (`pruneSnapshots`) so only 50-year keyframes and
the latest tick remain — `settlementCensus` keeps its history without a world
blob per year. `kill -9` at any moment resumes from the last completed tick.
On startup the daemon prunes logged events at or above the loaded snapshot's
`nextEventId`: the crash window between drain and snapshot would otherwise let
the id-keyed dedupe keep an abandoned (differently re-decided) timeline's
text. Allocator state, decision counters and CLI sessions persist in meta, so
a restart keeps a warm bar and warm caches.

## Deployment — the site reads a replica, never the host

Deployed shape (live since 2026-08; runbook in `deploy/README.md`, costs in
`docs/operating-cost.md`): the daemon runs supervised (systemd,
`Restart=always`, enabled at boot) on a small Lightsail VM; the site runs on
Vercel; Neon Postgres is the store both reach. The split of authority is the
load-bearing decision: **the VM's SQLite stays authoritative** (resume
semantics untouched), and Postgres is a **read replica**
(`packages/runner/src/publish.ts` writes; `apps/web/lib/remote.ts` reads,
enabled by `DATABASE_URL`). The publisher runs off the tick's critical path:
events are re-read from the local store by id cursor (so an outage self-heals
— the replica catches up by `eventsAfter`), the ~2.6 MB latest-snapshot row is
throttled to one write per 30 s of wall clock, census keeps keyframe years
only (mirroring `pruneSnapshots`), and the daemon's startup resume guard is
applied to the remote log too. Every layer degrades rather than errors:
remote down → the world keeps ticking; daemon down → the site serves the last
published snapshot; replica empty → the site renders a generated year-0
Earth. A lost VM is rebuilt from the replica with `pnpm daemon restore`
(loses ≤ one publish interval). The public deployment runs
`--brain heuristic`; switching on the model mind is an env edit on the host
(`/etc/sim-daemon.env`), not a redeploy.
