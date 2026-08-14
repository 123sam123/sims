/**
 * The decision loop — where minds meet the world, once per due year.
 *
 * The runner calls `decideForWorld` between ticks. For each civ whose turn it is
 * (cadence loosens the interval as the civ advances — roughly every 25 years in
 * the stone age, tightening later), it builds a fog-of-war briefing, asks the
 * brain for directives, and runs each past the six gates. Survivors are applied
 * as bounded, standing state (a research target, a queued project, policy, a
 * proclamation); the rest become `refusal` events and a line in the chronicle,
 * so the civ carries its setbacks into the next briefing. Exactly one `decision`
 * event is emitted per civ per turn.
 *
 * Nothing here touches the tick's determinism: the brain call is the only IO,
 * it runs OUTSIDE `tickWorld`, and everything it enqueues takes effect only in
 * later years (see `tick.ts`, stage 6). If the primary brain throws mid-run — a
 * network blip on a 500-year run — the loop falls back rather than dying.
 */

import { type Civ, emit, type EventKind, type World } from "@sim/engine";
import { buildBriefing } from "./briefing.ts";
import type { Brain } from "./brain.ts";
import { adjudicate, civEra, type Directive, type DirectiveSet } from "./directives.ts";

export interface DecideOptions {
  /** The mind that proposes directives. */
  brain: Brain;
  /** Used when `brain.decide` throws — keeps a long run alive. Typically the
   *  deterministic heuristic. */
  fallback?: Brain;
  /** Ignore cadence and let every living civ decide this call. For tests. */
  force?: boolean;
}

/** How many standing orders and chronicle lines to keep — memory is bounded so
 *  a long run's snapshot does not balloon. */
const MAX_AGENDA = 6;
const MAX_CHRONICLE = 60;

/**
 * Run one decision pass over the world. Awaits each due civ's brain in turn
 * (order is stable civ-id order, so a seeded run is reproducible up to the
 * brain's own determinism). Mutates civs and the event log; enqueues work the
 * tick will execute in later years.
 */
export async function decideForWorld(world: World, opts: DecideOptions): Promise<void> {
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    if (!opts.force && !isDue(civ, world.year)) continue;
    await decideForCiv(world, civ, opts);
  }
}

/** Whether this civ decides in `year`. Phased by id so the five don't all fire
 *  the same year, and the interval loosens with the civ's advancement. */
export function isDue(civ: Civ, year: number): boolean {
  const interval = decisionInterval(civ);
  const phase = 1 + civ.id;
  if (year < phase) return false;
  return (year - phase) % interval === 0;
}

/** Years between decisions, by era. Roughly a generation early, tightening as
 *  the civilisation gets more moving parts to steer. */
export function decisionInterval(civ: Civ): number {
  const era = civEra(civ);
  if (era >= 5) return 8;
  if (era >= 4) return 12;
  if (era >= 2) return 20;
  return 25;
}

async function decideForCiv(world: World, civ: Civ, opts: DecideOptions): Promise<void> {
  const briefing = buildBriefing(world, civ);
  let set: DirectiveSet;
  try {
    set = await opts.brain.decide({ world, civ, briefing });
  } catch {
    set = opts.fallback ? await safeDecide(opts.fallback, world, civ, briefing) : { directives: [] };
  }
  applyDecision(world, civ, set.directives);
}

async function safeDecide(
  brain: Brain,
  world: World,
  civ: Civ,
  briefing: ReturnType<typeof buildBriefing>,
): Promise<DirectiveSet> {
  try {
    return await brain.decide({ world, civ, briefing });
  } catch {
    return { directives: [] };
  }
}

/** Adjudicate every proposed directive, apply the survivors, and log the round. */
export function applyDecision(world: World, civ: Civ, directives: Directive[]): void {
  const accepted: string[] = [];
  const setbacks: string[] = [];

  for (const d of directives) {
    const verdict = adjudicate(world, civ, d);
    if (verdict.ok) {
      verdict.apply(world, civ);
      accepted.push(verdict.summary);
    } else {
      setbacks.push(`${phrase(d)} — ${verdict.reason} [${verdict.gate}]`);
      pushEvent(world, "refusal", civ, 0.3, `${civ.name} could not ${phrase(d)}: ${verdict.reason}.`);
    }
  }

  if (accepted.length) civ.agenda = accepted.slice(0, MAX_AGENDA);
  const summary = accepted.length ? accepted.join("; ") : "held to its present course";
  pushEvent(world, "decision", civ, 0.5, `${civ.name} resolved to ${summary}.`);

  for (const s of setbacks) civ.chronicle.push(`[${world.year}] reached too far — ${s}`);
  if (civ.chronicle.length > MAX_CHRONICLE) {
    civ.chronicle.splice(0, civ.chronicle.length - MAX_CHRONICLE);
  }
}

/** A short human phrase for a directive, for events and the chronicle. */
function phrase(d: Directive): string {
  switch (d.type) {
    case "research":
      return `pursue ${d.target}`;
    case "construct":
      return `build ${d.building}`;
    case "settle":
      return "found a new settlement";
    case "policy":
      return "change its priorities";
    case "proclaim":
      return d.name ? `take the name ${d.name}` : "proclaim";
    case "envoy":
      return "send an envoy";
    case "pact":
      return d.action === "break" ? "break a pact" : "offer a pact";
    case "spy":
      return "send spies abroad";
  }
}

function pushEvent(world: World, kind: EventKind, civ: Civ, weight: number, text: string): void {
  emit(world, { kind, civ: civ.id, weight, text });
}
