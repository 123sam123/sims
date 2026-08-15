# The civilisation agent loop

Where a civilisation gets a mind. Everything else in the engine is physics that
runs whether anyone is watching; this layer is the five minds that push against
it. Implemented in `packages/agents/src/` (`briefing.ts`, `directives.ts`,
`brain.ts`, `heuristic.ts`, `loop.ts`) plus the engine's execution stage in
`packages/engine/src/projects.ts` and the runner's `advanceWorldWithDecisions`.

The contract is one sentence: **the agent proposes, the engine disposes.** A
brain returns a set of *directives* — intentions — and not one of them touches
the world directly. Every directive is checked against six gates and only the
survivors are applied, as bounded, engine-owned state.

## The two-sided split (this is the load-bearing decision)

An LLM call is IO and non-deterministic; the tick must stay pure, deterministic
and wall-clock-free (see [[tick]]). So generation and execution are separated:

- **Generation** lives in the runner, *between* ticks. `advanceWorldWithDecisions`
  runs `tickWorld`, then `decideForWorld`, then drains events — all in one loop
  iteration so decision/refusal events ride out on the same drain as the tick's
  (the resume/snapshot contract in [[tick]] is preserved).
- **Execution** is a pure engine stage. Accepted construction/settlement
  directives become a `Project` queued on the civ (`Civ.projects`, plain JSON so
  snapshots are unchanged); the tick's stage 6 `executeDirectives` draws them
  down from real labour (`workingAgePopulation × policy.building`) and real
  materials (`Civ.stores`) year by year.

**Timing falls out of this for free.** A decision is made when `world.year`
already reads N+1 (the tick that simulated N has finished); its projects are
first executed by the *next* tick. So a directive issued in year N can never
take effect before N+1, and a mind can never observe its own order landing
inside the tick that issued it. Pinned by a test.

## Fog of war is mandatory

`buildBriefing(world, civ)` is built from what a civ *believes*, never from
`World`. It reads the civ's own state freely, but other civs only through
`known` / `relations` — never their capabilities, stores, population or the name
they chose. Contact/diplomacy (see [[diplomacy]]) populates `known` and the
noisy `Relation.belief` snapshots the briefing renders; a civ that has met
nobody still sees no other-civ ground truth. Without this,
diplomacy is trivial and the premise collapses. Pinned by a leakage test that
injects a secret neighbour and asserts none of it appears unmet, and only the
name+relation appears once met.

Prompt caching is architecture here, not optimisation. The briefing is a stable,
cache-broken prefix (world rules identical across all five minds → shared cache;
then this civ's doctrine + chronicle) plus a small volatile tail (this decision's
believed state). Put anything time-varying in the prefix and hit rate is zero.

## The six gates (`adjudicate` in `directives.ts`)

Each refusal names its gate and a plain reason, so a civ learns the world by
hitting walls (a `refusal` event + a chronicle line fed back into the next
briefing):

- **knowledge** — reuses `researchable`/`blockedBecause` from [[knowledge]].
  A construct order for a gated item (bronze tools → `bronze`) is refused naming
  the missing capability; for metal it calls out smelting explicitly.
- **materials** — a hard material/terrain wall anywhere in a research target's
  prerequisite closure (no tin → no bronze, ever).
- **labour** — hands must be free of feeding the people to build.
- **capital** — some materials must already be stockpiled to begin.
- **authority** — a monument needs `government.centralization`; a proclamation
  needs `legitimacy`.
- **time** — a `minPop`/era wall: possible, but not *yet*.

## Directive categories

research (sets `research.target`), construct (queues a `Project`), settle (queues
a `settle` `Project` → `foundDirectedColony`), policy (clamped 0..1 deltas to
`Civ.policy` — the one gate-free dial, "bounded parameter delta the engine
validates"), and proclaim (free-text name / government form / chronicle line).
Free-text authoring is allowed; mechanical effects are always bounded, validated
deltas — the model never invents new mechanics.

## The brain, and running with no key

`Brain.decide(ctx) → DirectiveSet`. Two implementations: `createLlmBrain`
(`claude-opus-5`, structured output via `output_config.format`, adaptive thinking
left on — no `budget_tokens`/`temperature`/`top_p`/`top_k`; `stop_reason:"refusal"`
handled before content) and `createHeuristicBrain` (deterministic, no network).
`makeBrains` picks the model when `ANTHROPIC_API_KEY` is set (heuristic as
fallback if it throws mid-run) and the heuristic alone when it is not — so the
whole simulation runs end to end with nothing configured. The heuristic
deliberately reaches for the next age before it is ready, so refusals happen
naturally offline. Cadence loosens with era (~25 yrs stone age, tightening
later), phased by civ id.

CLI: `pnpm run run --years N --agents on` (note the `pnpm run run` double —
see [[tick]]). A 500-year heuristic run finishes in ~1.5s, is byte-identical
across two runs, and logs both `decision` and `refusal` events.
