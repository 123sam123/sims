# Settlements

How settlements appear, grow, spread, hold territory and die — with nobody
placing them. Implemented in `packages/engine/src/settlement.ts`. No LLM is
involved: this is emergent behaviour driven only by the physical `grid` and the
population model. `stepSettlements(world)` advances every civ's settlements one
year and is deterministic from the world seed.

## What one tick does, in order

1. **Territory** — one ring of dilation per *settled* civ (has the `settlement`
   capability), in civ-id order. A frontier cell (unowned land next to something
   the civ holds) is claimed when `reach × distance-decay > CLAIM_THRESHOLD`,
   where `reach` falls off with distance from the civ's **largest settlement**
   over `adminReach(held)` — the base `ADMIN_REACH_KM` stretched by governance
   capabilities (`writing`/`roads`/`law_code`/`currency`, see
   `ADMIN_REACH_BONUS`) — and `distance-decay`
   falls off with distance from the nearest settlement. Ocean and land already
   held by another civ are never taken. A civ controls its whole reachable
   region — good land *and* the marginal land between its settlements — not only
   the fertile cells. Foraging bands (no `settlement` capability) do **not**
   dilate; they keep only the home range they stand on.
2. **Catchments + carrying capacity** — a multi-source BFS from every settlement
   at once assigns each owned land cell to the settlement that works it
   (`grid.settlement`), and accumulates that settlement's **local carrying
   capacity** in the same O(owned) pass. BFS (not nearest-by-coordinate) so a
   settlement never claims land across a bay it cannot walk to.
3. **Population** — for each settlement, `foodRatio = capacity / foodDemand(s)`
   (capped at `FOOD_RATIO_MAX`) is handed to `stepPopulation`. A place well under
   its carrying capacity runs a surplus and grows; at capacity `foodRatio → 1`
   and growth stalls; over capacity it starves and shrinks. **This module owns
   the population call** — `population.md` says migration is the settlement
   layer's job, and the local food context lives here. Housing then grows toward
   the population, lagging (`HOUSING_GROWTH_RATE`), which is what "growth" is.
4. **Camp relocation** — a band that cannot settle walks its single camp to the
   best-foraging neighbouring cell if it beats where it stands by
   `CAMP_RELOCATE_GAIN`. It leaves no owned trail and never founds.
5. **Founding & migration** — a settlement that is big enough (`FOUND_MIN_POP`)
   and full enough (`pop/capacity ≥ FOUND_SATURATION`) tries, with
   `FOUND_ATTEMPT_CHANCE`, to bud a colony: `bestSite` scores nearby cells and
   picks the best. No site worth founding → send a slice to a roomier sibling.
6. **Overextension (unrest & secession)** — `stepUnrest`: each settlement's
   strain = distance-from-capital / `adminReach`. Past `UNREST_STRAIN_FLOOR`
   (0.55) unrest accrues (faster when hungry, damped by government legitimacy);
   crossing `UNREST_EVENT_THRESHOLD` logs a standing `unrest` event; at boiling
   point a non-capital settlement may secede (`SECESSION_CHANCE`/yr, stream
   `hashSeed("unrest", civId, year)`), emitting a `secession` event causally
   linked to the unrest report. A seceding settlement takes its **people and
   land out of the civilisation** — no dispersal to siblings, land freed. This
   is the overextension brake; see [[brakes]].
7. **Abandonment** — a settlement whose `foodRatio` stays below
   `ABANDON_FOOD_RATIO` for `ABANDON_YEARS` (20) running, **or** that empties
   out, is removed; survivors disperse to the nearest sibling and its land is
   freed (`owner`/`settlement` → -1). A fed year resets the counter, so the 20
   must be consecutive (`recordFoodStress`).

## Two food numbers, on purpose

`production.ts` keeps a **civ-wide grain store** (for trade/building/armies).
This module computes a **per-settlement local carrying capacity** from the
settlement's catchment (`cellFoodCapacity` = `fertility × soil ×
FARM_/FORAGE_CAPACITY_PER_CELL` — `soil` is the environment brake's wear state,
see [[brakes]]). They answer different questions and do not double-count: population
consumes nothing (see `population.md`), production depletes the store, and the
carrying-capacity ratio only shapes per-settlement growth/shrink/abandon. Because
of this, settlement founding is **independent of `runProduction`** — a headless
run produces the identical settlement map with or without it (used to keep the
2,000-year acceptance test to ~4s by running settlements only).

## Site score

`bestSite` skips ocean, ice, cells below `SITE_MIN_FERTILITY` (0.35 — this floor
is what keeps deserts/ice/tundra/taiga/bare-mountain empty of settlements and
what puts cities above their territory's median fertility), cells already
settled, land held by another civ, anything outside administrative reach, and
anything within `FOUND_MIN_SPACING_KM` of an existing settlement. The rest score
`fertility + river + coast + defensibility(elevation) + spacing − hostile
neighbours`, weighted by the named `SITE_*` constants.

## Invariants worth keeping

- **Determinism**: the only stochastic input is `hashSeed("settle", civId,
  year)`; population uses its own per-settlement stream. A seed replays to the
  same map. Iterate civs/settlements in stable id order.
- **`grid.settlement` holds settlement *ids*, not array indices** (ids happen to
  equal indices only at worldgen). Look settlements up by id; the array is
  filtered on abandonment so index ≠ id afterwards.
- Settlements are **persistent objects with stable ids** — never recreated tick
  to tick. New `Settlement.leanYears` (optional) tracks the abandonment counter;
  `lastHarvest` is reused to hold the last local food ratio.
- No settlement is ever founded on ocean, ice, or a cell owned by another civ
  (tested every year of the 2,000-year run).

## Calibrated behaviour (seed 12345, 2,000 years, five neolithic civs)

~200 settlements founded from five camps; ~16% of land owned (civs do not carpet
the Earth); every owned cell within ~430 km of a same-civ settlement; median
fertility of settled cells 0.85 vs 0.72 for territory; settlements ~2.5× more
likely to sit on a river than the territory at large. Constants are sensitive and
live named at the top of `settlement.ts`; re-tune against
`packages/engine/test/settlement.test.ts`. See also `population.md`.
