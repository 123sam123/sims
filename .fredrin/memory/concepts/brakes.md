# The anti-snowball brakes

Why one civilisation cannot quietly compound a 3% edge into a planet-wide blob.
Four brakes, each a *mechanism with a visible cause chain* — never a scalar that
punishes whoever is winning. Every brake reports through its own `EventKind`
(`plague`, `unrest`/`secession`, `depletion`, `degradation`), so the log can say
*why* a civ stalled. No LLM anywhere; deterministic throughout (streams keyed
`hashSeed(subsystem, …, year)`). Ticket SIMS-S988FG; knowledge diffusion (the
fifth historical brake) lives with diplomacy, not here.

## 1. Disease — `packages/engine/src/disease.ts` (tick stage 4)

Success is what exposes you. Per settlement per year, outbreak chance =
`OUTBREAK_BASE_CHANCE + OUTBREAK_DENSITY_CHANCE × pop/5000 +
OUTBREAK_CONTACT_CHANCE × civsKnown`, so a big, dense, connected empire rolls
more dice at worse odds than an isolated band. An outbreak sweeps outward
(`SPREAD_KM`, `SPREAD_CHANCE` per link) through the civ's own settlements *and
across contacted civs* — trade contact (`civ.known`, populated by the diplomacy
ticket) is a disease route, with the cross-border `plague` event `causedBy` the
origin civ's event. Kills a flat share of `ages` (`EPIDEMIC_KILL_MIN..MAX`,
relieved by `sanitation`/`medicine`); survivors get `Settlement.lastPlagueYear`
immunity (`IMMUNITY_YEARS`, ×`IMMUNITY_SUPPRESSION`), which is why plagues come
in waves. Crowd disease needs a crowd: below `EPIDEMIC_MIN_POP` (150) nothing
starts or spreads — foragers stay clean.

**Boundary:** this is the *epidemic wave* layer. `pop.ts` keeps its own endemic
per-settlement disease load (density/crowding mortality + its small local
epidemic term) — that is calibrated background demography; do not merge the
two or delete either. Disease runs **after** the population step and **before**
research on purpose: a wave's dead are gone before research refreshes
capability holders, so a great plague can genuinely cost knowledge ([[knowledge]]).

## 2. Overextension — in `settlement.ts` (`stepUnrest`, stage 6 of `stepSettlements`)

"Administrative capacity decays with distance from the capital; corruption and
revolt are the failure mode, not a hard territory cap." Reach is
`adminReach(held)` = `ADMIN_REACH_KM × (1 + ADMIN_REACH_BONUS[writing/roads/
law_code/currency])` — governance tech is how empires get big, and the same
number gates claiming, founding and strain, so expansion and its price agree.
Strain past `UNREST_STRAIN_FLOOR` accrues `Settlement.unrest` (hunger adds,
legitimacy damps); boiling settlements secede (`SECESSION_CHANCE`/yr), and the
`secession` event is `causedBy` the standing `unrest` event
(`Settlement.unrestEventId`). A breakaway takes people AND land out of the civ
(no dispersal — that is the loss). Successor states are explicitly out of
scope; the seceded region simply leaves the tracked world, and the empire may
re-take the near fringe next year — imperial churn is intended texture.

## 3. Exhaustion — in `production.ts`

Deposits were already finite; now running one dry is *history*: the tick a
deposit's `remaining` hits 0, a `depletion` event fires (magnitude = richness)
and `ProductionResult.exhausted` names it. No re-emission (the empty deposit
drops out of the `active` filter forever).

## 4. Degradation — `packages/engine/src/environment.ts` (tick stage 1)

`grid.soil` (0..1, pristine=1, **new grid array — serialisation format v2, v1
migrates on read with soil←1**). Cells in a farming civ's catchment wear at
`SOIL_CULTIVATION_WEAR`/yr, ×(1+`SOIL_EROSION_WEIGHT`) when the cell's forest
is gone relative to its biome climax — production's wood-cutting is what arms
this. Floor `SOIL_FLOOR` (0.25): land degrades, never dies. Unworked land heals
at `SOIL_RECOVERY` toward pristine (~250-year constant). Effective yield is
`fertility × soil` in exactly two consumers: `cellFoodCapacity` (settlement
carrying capacity) and production's `effFert` (the grazing floor is deliberately
NOT soil-scaled — herding still works on worn land). A catchment whose mean soil
first drops under `SOIL_STRESS_THRESHOLD` logs one `degradation` event
(latched via `Settlement.soilStressed`, hysteresis at `SOIL_RECOVERED_THRESHOLD`).

## Measured effect (brakes-sweep)

`pnpm tsx packages/runner/src/brakes-sweep.ts` runs N headless engine worlds
(no agents; unsteered research) and writes `docs/brakes/report.md`: per-run
largest-civ share of settled land, share trajectory, brake-event counts against
each run's leader, and receipt events. The characteristic shape: the leader
peaks mid-run (~50-60%) and is ground back by plague waves, rim secessions and
worn-out heartlands. Acceptance: majority of ten 3,000-year runs end with the
largest civ under ~60% of settled land.

Constants all live named at the top of their module; tune against
`packages/engine/test/brakes.test.ts`. See [[settlement]], [[tick]], [[events]],
[[population]].
