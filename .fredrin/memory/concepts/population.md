# Population

How many people a settlement has, how old they are, and what kills them.
Implemented in `packages/engine/src/pop.ts`. No LLM is involved at any point —
this is the layer the AI civilisations read from, not one they steer.

## Shape of the state

A settlement carries two arrays, both on `Settlement` in `types.ts`:

- **`ages`** — `Float64Array(AGE_SLOTS)`, 80 single-year slots, ages 0..79.
  **This is the authoritative state.** Slot 79 is absorbing: it holds "75-79
  and everyone older".
- **`cohorts`** — `Float64Array(AGE_BANDS)`, the 16 five-year bands the rest of
  the simulation reads. **Derived.** `stepPopulation` refreshes it; anything
  that writes `ages` directly must call `refreshCohorts(s)`.

Counts are continuous, not integers. That is not a shortcut: a cohort-component
projection is a flow model, and Poisson draws on a 120-person settlement would
bury a 0.06%/yr signal under demographic noise. Sub-person populations are
handled by `MIN_VIABLE_POPULATION`, which empties a settlement below ~4 people,
and by suppressing births below `MIN_BREEDING_POPULATION` of fertile age.

### Why single years and not five-year bands

Ageing by moving a fifth of each band up per tick — the obvious cheap version —
makes residence in a band exponentially distributed instead of exactly five
years. People then arrive in the fertile bands years early (mean age at entry
to "15-19" measures 12.6), generation time collapses, and intrinsic growth
comes out roughly 6x too high. Correcting that with harsher mortality produces
a life expectancy below any human population ever recorded, and every
acceptance test still passes. Eighty float slots avoid the whole problem for
640 bytes per settlement.

Shifting whole bands every fifth year is worse still (measured 1.35%/yr):
births arrive continuously, so the average newborn only gets three years of
infant mortality instead of five.

## Calling it

```ts
const demand = foodDemand(settlement);            // BEFORE the step
const step = stepPopulation(settlement, {
  year, seed,                                     // deterministic key
  foodRatio: available / demand,                  // 1.0 = exactly fed
  capabilities,                                   // civ's capability id set
});
```

`foodDemand` is separate on purpose. `foodRatio` is an input and `foodDemand`
is an output of the same call, so computing the ratio from the returned value
lags every famine by a year. The `foodDemand` on `PopStep` is a reporting echo.

`stepPopulation` takes **no `Rng`**. Its stream is derived per settlement-year
from `hashSeed("pop", seed, settlement.id, year)`, so a settlement's history
does not depend on how many other settlements the tick stepped first or how
many draws they consumed. A seed replays to the same world.

`PopStep` also reports `crowding` and `migrationPressure`. This module never
moves anyone — migration is the settlement layer's job; this only says how
badly a place wants to shed people. It does not touch `unrest` or `Person`
records either.

## Boundary with production (SIMS-03BXNW)

`production.ts` **owns food consumption**: it does `stores.food = max(0, prev +
produced - consumed)` with `consumed = civPopulation * FOOD_PER_CAPITA`. This
module deliberately consumes nothing — `foodDemand(s)` only tells a caller what
a settlement *needs*, so the two cannot double-consume.

The two measures differ on purpose: production's is a flat per-capita civ-wide
figure; `foodDemand` is age-weighted per settlement (children and the very old
eat less), because famine has to hit a settlement full of children differently
from one full of adults. The tick orchestrator (SIMS-N872WA) owns call order
and decides which number depletes the store.

## Invariants worth keeping

- `population === before - deaths + births`, exactly, every year.
- No cohort ever goes negative or non-finite, under any stressor combination.
  Stressors scale **hazards** (`p = 1 - exp(-H·mult)`), never probabilities —
  multiplying a 0.14 probability by a famine factor of 7 gives 1.04, i.e.
  more deaths than people.
- Non-finite numbers arriving on `PopContext` are absorbed at the boundary. A
  NaN in `ages` is unrecoverable and would be persisted into a saved world.
- More housing is never worse than less.

## Calibrated behaviour

Measured from the constants in `pop.ts`, not asserted by hand:

| | |
|---|---|
| total fertility rate | 6.3 |
| survive to 5 / to 15 | 46% / 41% |
| life expectancy at birth | 22.4 y |
| under 15 / over 65 | 37% / 4% |
| growth, subsistence, no epidemics | 0.11%/yr |
| growth, subsistence, realistic | 0.06%/yr median |
| growth at 1.3x rations | ~0.5%/yr |

Break-even at subsistence is the point: a foraging band hovers near zero, and
**food surplus is what lets a farming civilisation grow**. That is the lever
the settlement and economy layers pull, not the vital rates.

`sanitation` and `medicine` are read from the civ's capability set — there is
no era number anywhere in this module. Sanitation acts on the crowding and
density term, so it barely registers in a hamlet and cuts the death rate ~28%
in a settlement of 12,000. That asymmetry is deliberate and tested.

## Tuning

Every arguable number is an exported named constant at the top of `pop.ts`.
The constants are sensitive: 0.001 on `BASE_MORTALITY[0]` moves long-run
growth by about 0.02 pp/yr, which is a third of the target band. Re-tune
against the tests in `packages/engine/test/pop.test.ts` — in particular the
stable-age-structure test, which is the one that catches a change that keeps
growth plausible while making the age pyramid nonsense.
