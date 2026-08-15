# Knowledge, research and loss

How a civilisation gains capabilities, and — more importantly — how it loses
them. The capability graph lives in `packages/engine/src/knowledge.ts`
(~55 capabilities with prerequisites, materials, terrain and population gates,
plus `researchable()` and `blockedBecause()`); the yearly dynamics live in
`packages/engine/src/research.ts`. No LLM is involved — this is the layer the AI
civilisations read from and steer via `Civ.research.target`, not one that thinks
for them.

## Capabilities are possibility, not a script

A capability is something physically possible given prerequisites and materials.
Nothing obliges a civ to discover anything, order is not fixed, and there is **no
era gating beyond `Capability.era`** (used only as a numeric proxy for
sophistication — e.g. `prospectingLevel` in production, and holder `spread`
here). A civ with no tin in reach can never make bronze, however long it runs.

## Shape of the state (`types.ts`)

Each `Civ` carries:

- `capabilities: string[]` — what it currently knows. **Kept prerequisite-closed**:
  every held capability's `needs` are also held. Enforced at gain time (only
  research a cap whose prereqs are met) *and* at loss time (see cascade below).
- `research: { target: string | null; progress: number }` — `target` is the
  **goal** (may be several steps away); `progress` accumulates against the
  current *step* toward it. Cleared to `null` when the goal is reached or invalid;
  an unsteered civ auto-picks the cheapest researchable cap so it keeps moving.
- `holders: Record<capId, CapabilityHolders>` — `{ people, institutions[], written }`.
  The key set mirrors `capabilities`. Refreshed every step: `people =
  population × spread(cap)`, institutions derived from writing/schools/granary,
  and `written` latched true once the civ holds `writing` (never forced back —
  records persist even if writing is later lost).
- `forgotten: string[]` — capabilities once held and lost. Cheaper to re-discover.

## Research effort — scholarship, not headcount

`researchCapacity(world, civId)` = `population × policy.research` (scholar-equivalents)
× literacy (`writing`×1.6, `schools`×1.5, `philosophy`×1.25) × density (rises with
the civ's **largest settlement** — ideas need density). Capability `effort` is
denominated in these units. `stepResearch` multiplies capacity by a deterministic
yearly "fortune" (`hashSeed("research", civId, year)`, the module's ONLY RNG) and
spends it toward the target, decomposing prerequisites depth-first
(`nextStepToward`). When a directive can't advance, `blocked` reports the honest
wall from `blockedBecause()` and **no effort accrues** (the civ stalls on an
impossible goal rather than silently drifting).

## Knowledge loss — write it down or lose it

Every step, before research: `applyKnowledgeLoss`. An held capability is lost when
it is **unwritten** AND `holderStrength` (`people + 4×institutions`) falls below
`HOLDER_LOSS_THRESHOLD` (3) AND it does not underpin any still-held capability.
That last guard makes loss **cascade from the most-derived down** and keeps the
held set prerequisite-closed (you forget bronze before you forget smelting).
`STARTING_CAPABILITIES` are never lost. Because `spread` shrinks with era, a
population crash takes the rarefied, specialised, unwritten knowledge first — a
dark age nobody scripted. Holding `writing` marks everything `written` and thus
immune; `schools`/guilds only raise the holder count.

Load-bearing constants (all exported, named, tunable): `RESEARCH_PER_SCHOLAR`,
`WRITING/SCHOOLS/PHILOSOPHY_MULT`, `DENSITY_*`, `FORTUNE_*`, `SPREAD_BASE/DECAY/MIN`,
`HOLDER_LOSS_THRESHOLD`, `INSTITUTION_SUPPORT`, `REDISCOVERY_DISCOUNT` (0.4 — a
forgotten cap costs 40% to relearn), `SCHOLARLY_ERA_MIN`.

## Boundaries

- **Diffusion between civs is NOT here** — technology spreading on contact/trade
  lives in [[diplomacy]], which grants through this layer's `adoptCapability`
  (same holders/event bookkeeping as a home-grown discovery) and filters
  candidates with the same `researchable()` gates.
- **The tick orchestrator (SIMS-N872WA) owns call order.** Loss reads the *current*
  `civPopulation`, so run pop/production (which set population) before research in
  the tick, or a plague's loss lags a year. War killing *specific* scholars would
  perturb `holders` directly between steps.
- Novel AI-proposed capabilities (things Earth never had) are out of scope; the
  agent ticket (SIMS-RDGCK0) adds the proposal path and reuses these gates.
- Shares the engine's determinism + test/lint conventions; see the concept doc for
  [[population]] and the memory notes for production and test setup.
