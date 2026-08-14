/**
 * Public surface of the civilisation agent layer (`@sim/agents`).
 *
 * The engine is the physics; this package is the minds that push against it.
 * It builds a fog-of-war briefing, asks a brain (the model, or a deterministic
 * heuristic) for directives, and adjudicates each against the six gates — but it
 * never mutates the world outside those bounded, adjudicated effects. The runner
 * drives it between ticks; the engine only ever sees the projects it enqueues.
 */

import { type Brain, createLlmBrain } from "./brain.ts";
import { createHeuristicBrain } from "./heuristic.ts";

export * from "./directives.ts";
export * from "./briefing.ts";
export * from "./brain.ts";
export * from "./heuristic.ts";
export * from "./loop.ts";

export interface BrainSelection {
  /** The primary mind: the model when a key is present, else the heuristic. */
  brain: Brain;
  /** Deterministic fallback used if the primary throws mid-run. */
  fallback: Brain;
  /** True when the real model is driving. */
  usingLlm: boolean;
}

/**
 * Pick the brains for a run. With an `ANTHROPIC_API_KEY` the model drives and
 * the heuristic backs it up; with no key the heuristic drives alone, so the
 * whole simulation still runs end to end with nothing configured.
 */
export function makeBrains(opts: { apiKey?: string; model?: string } = {}): BrainSelection {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const heuristic = createHeuristicBrain();
  if (apiKey) {
    return { brain: createLlmBrain({ apiKey, model: opts.model }), fallback: heuristic, usingLlm: true };
  }
  return { brain: heuristic, fallback: heuristic, usingLlm: false };
}
