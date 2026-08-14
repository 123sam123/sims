# Divergence findings — does agent choice change history?

**Status: in progress — the LLM arm has not run yet.** Everything in this
document up to the Results section was written *before* any model-driven run
existed, so the interpretation rules below are pre-registered: they cannot be
bent to fit the data after the fact. The verdict section is filled in last.

## The question

This experiment is the gate on the whole project. The premise is that five
AI-run civilisations produce meaningfully different histories — that a mind
steering a civilisation changes what happens, beyond what geography and the
engine's physics dictate. If five runs of the same seed with the model deciding
converge on one history, the premise is flat and no amount of breadth (war,
trade, rendering) rescues it.

## Method

`packages/runner/src/experiment.ts` runs four arms over the **same seed (1)**
to the **same target year (1500)**, and writes `docs/divergence/report.md` +
`report.json`. Full design notes are in the file header; the short version:

| arm | runs | brain | purpose |
|---|---|---|---|
| engine | 2 | none | determinism gate: both runs must be bit-identical |
| heuristic | 5 | deterministic heuristic | the control: the full decision path with zero nondeterminism |
| perturbed | 5 | heuristic + tiny seeded per-run noise | the **chaos floor**: how much divergence any nondeterminism buys |
| llm | 5 | `claude-opus-5`, instrumented | the measurement |

Two design facts make the comparison clean:

- **The engine's RNG is hash-keyed per (subsystem, entity, year)**, not a
  shared stream. A different decision cannot desync unrelated random draws;
  divergence only ever flows through real state differences (steered research,
  projects, settlements, policy, chronicle). Whatever diverges, diverged
  because the world actually went a different way.
- **The perturbed arm exists because "the histories differ" is not the same as
  "choice matters".** A complex system can snowball any perturbation. The
  perturbed arm injects the smallest nondeterminism-equivalent nudge
  (occasionally drop/reorder one heuristic directive, jitter a policy share)
  and measures how far pure snowballing carries. The LLM arm has to beat that
  floor — and beat it in the right *places* — for the premise to hold.

The LLM brain is instrumented (stop reason, token usage, cache hits, retries,
terminal failures) because the production loop degrades silently: a truncated
or refused model response becomes "held to its present course", and a thrown
error becomes a quiet heuristic decision. A run that was materially heuristic
is reported as contaminated, not passed off as a clean measurement.

## Gate and control results (measured before the LLM arm)

- **Determinism gate: PASSED.** Two engine-only runs of seed 1 are
  bit-identical at year 1500 (world hash and full-event-log hash equal).
- **Heuristic control: PASSED.** All five decision-loop runs with the
  deterministic brain are bit-identical — the decision path adds no hidden
  nondeterminism. Every metric is exactly zero across runs.
- **Chaos floor (perturbed arm): LARGE.** Tiny per-run nudges snowball hard by
  year 1500:

| metric (mean across civs) | heuristic | perturbed floor |
|---|---|---|
| final capability-set Jaccard distance | 0.000 | 0.004 |
| discovery-year σ per capability | 0.0y | 35.1y (per-civ means 6.7–65.7y) |
| settled-cell-set Jaccard distance | 0.000 | 0.668 (per-civ 0.375–0.830) |
| final population CV | 0.0% | ~10.7% (per-civ 1.9–19.1%) |
| top-20-event overlap distance | 0.000 | 0.987 (nearly disjoint) |
| distinct government forms per civ | 1 | 1 |
| capability Jaccard trajectory | 0 everywhere | wobbles to 0.17 (yr 500) then **re-converges to 0.004** |

Two readings matter. First, the engine amplifies noise enormously in *where*
and *how much*: settlement maps, event lists and populations scatter widely
from trivial nudges. Second, the engine pulls *what is known* back together:
capability sets wobble mid-run and then re-converge onto the same feasible
frontier, and nothing in the perturbed arm ever proclaims a government, names
a people differently, or takes a research path that cheapest-first greed would
not have taken. The floor is loud in geography and quiet in character.

## Pre-registered interpretation rules

Written before any LLM run existed. The LLM arm is judged against the floor,
dimension by dimension:

1. **DIVERGED — premise holds.** The LLM arm clearly exceeds the perturbed
   floor on at least two *strategy-bearing* dimensions — discovery-year σ or a
   capability trajectory that stays apart instead of re-converging; research
   paths that are not cheapest-first; distinct government forms or self-chosen
   names across runs; systematically different policy/settlement postures —
   **and** the five chronicles read as recognisably different histories to a
   human. Divergence that merely matches the floor's geographic scatter does
   not count.
2. **NOISE-ONLY — premise weak.** The LLM arm diverges, but no more than the
   perturbed floor and in the same places (geography loud, character quiet).
   The model is then just an expensive noise source: nondeterminism, not
   choice, is doing the work. Stop and rethink before building breadth.
3. **CONVERGED — premise fails.** The LLM arm tracks the heuristic control
   toward zero. The engine's physics dominates outright.

Secondary, qualitative check (from the ticket): if a reader cannot tell the
five chronicles apart, that is a fail regardless of the numbers.

Known measurement caveats, stated up front: final capability sets have a
ceiling effect (by year 1500 every arm converges on the reachable frontier —
timing and order carry the signal, not the final set); event-overlap uses
identity tuples (kind, year, civ, cell), not text, so self-chosen names cannot
fake divergence; government-form counts are qualitative colour (free text,
lightly normalised); and the heuristic arm's zero on every metric is by
construction, which is exactly why the perturbed arm, not the control, is the
comparison bar.

## Results — LLM arm

_Not yet run. This section and the verdict are filled in from
`docs/divergence/report.md` once the five model-driven runs complete._

## Verdict

_Pending the LLM arm._
