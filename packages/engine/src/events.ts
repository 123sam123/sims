/**
 * The event log — the world's only memory.
 *
 * We settled on live-present-only: no rewind. So the written record is the ONLY
 * history the world keeps. Every meaningful state change becomes a typed,
 * weighted {@link WorldEvent} carrying its actors, a location, and its causal
 * parents, and the log becomes the memory the front page reads from — and, one
 * day, the memory a narrator model re-tells. If it is not in the log, it did not
 * happen and cannot be recovered.
 *
 * No LLM is involved here. Text is rendered from per-kind templates: the durable
 * fallback that must stand on its own. A model may later re-narrate the
 * high-weight events in a cheap batch, but these headlines are what survive if
 * it never runs.
 *
 * `weight` (0..1) is calibrated per kind so the feed can be filtered to "things
 * that actually mattered". The ranges are laid out so importance is ordered
 * *across* kinds, not just within one: the very top of a settlement founding
 * still sits below the very bottom of a civilisation collapsing. No amount of
 * local drama lifts a founding above a collapse.
 *
 * Emission is O(1) — it appends one object and bumps a counter — so it is cheap
 * enough to call from inside the tick.
 */
import type { EventKind, World, WorldEvent } from "./types.ts";

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Named values interpolated into a kind's headline template. */
export type EventFields = Record<string, string | number>;

/**
 * Per-kind calibration. `weight` is drawn from `[min, max]` by the occurrence's
 * magnitude; `template` renders the durable headline from named fields.
 */
interface KindMeta {
  /** Weight of the most trivial instance of this kind. */
  min: number;
  /** Weight of the most consequential instance of this kind. */
  max: number;
  /** Default magnitude when a caller does not supply one. */
  defaultMagnitude: number;
  template: (f: EventFields) => string;
}

/* ------------------------------------------------------------------ *
 * Template helpers — every field is optional, so a missing value never
 * throws; it falls back to a neutral noun so the headline still reads.
 * ------------------------------------------------------------------ */

const field = (f: EventFields, key: string, fallback: string): string => {
  const v = f[key];
  if (v === undefined || v === null || v === "") return fallback;
  return String(v);
};

const civOf = (f: EventFields) => field(f, "civ", "A people");
const otherOf = (f: EventFields) => field(f, "other", "their neighbour");
const placeOf = (f: EventFields) => field(f, "place", "a new place");
const subjectOf = (f: EventFields) => field(f, "subject", "something new");

/**
 * The calibration table. Ranges chosen so that a `weight > 0.6` filter keeps the
 * civilisation-scale story — collapses, wars, great plagues and famines, first
 * contact, dynastic change, paradigm discoveries — and drops the year-to-year
 * chatter of growth, minor decisions, routine trade and ordinary lives.
 */
const KIND_META: Record<EventKind, KindMeta> = {
  // Existential — a civilisation ends.
  collapse: {
    min: 0.85,
    max: 1.0,
    defaultMagnitude: 0.9,
    template: (f) => `${civOf(f)} collapsed and was no more.`,
  },
  // Great disruptions.
  war: {
    min: 0.62,
    max: 0.9,
    defaultMagnitude: 0.7,
    template: (f) => `${civOf(f)} went to war with ${otherOf(f)}.`,
  },
  plague: {
    min: 0.5,
    max: 0.95,
    defaultMagnitude: 0.6,
    template: (f) => `A plague swept through ${civOf(f)}.`,
  },
  famine: {
    min: 0.45,
    max: 0.9,
    defaultMagnitude: 0.55,
    template: (f) =>
      `${civOf(f)} could not bring in enough food, and its people went hungry.`,
  },
  // First contact between peoples is a hinge of history.
  contact: {
    min: 0.5,
    max: 0.8,
    defaultMagnitude: 0.7,
    template: (f) => `${civOf(f)} met ${otherOf(f)} for the first time.`,
  },
  peace: {
    min: 0.5,
    max: 0.78,
    defaultMagnitude: 0.6,
    template: (f) => `${civOf(f)} and ${otherOf(f)} laid down their arms and made peace.`,
  },
  government: {
    min: 0.45,
    max: 0.8,
    defaultMagnitude: 0.55,
    template: (f) => `${civOf(f)} became ${subjectOf(f)}.`,
  },
  battle: {
    min: 0.4,
    max: 0.85,
    defaultMagnitude: 0.5,
    template: (f) => `${civOf(f)} and ${otherOf(f)} met in battle at ${placeOf(f)}.`,
  },
  // Discovery spans a spectrum: a shallow copper seam is minor; ironworking is
  // an age. Magnitude, supplied by the caller, decides where it lands.
  discovery: {
    min: 0.25,
    max: 0.72,
    defaultMagnitude: 0.3,
    template: (f) => `${civOf(f)} discovered ${subjectOf(f)}.`,
  },
  disaster: {
    min: 0.3,
    max: 0.75,
    defaultMagnitude: 0.45,
    template: (f) => `Disaster struck ${civOf(f)}.`,
  },
  // A settlement is born or a frontier pushed — locally momentous, globally small.
  founding: {
    min: 0.25,
    max: 0.5,
    defaultMagnitude: 0.4,
    template: (f) => `${civOf(f)} founded ${placeOf(f)}.`,
  },
  settlement: {
    min: 0.2,
    max: 0.45,
    defaultMagnitude: 0.35,
    template: (f) => `${civOf(f)} extended its reach to ${placeOf(f)}.`,
  },
  trade: {
    min: 0.15,
    max: 0.5,
    defaultMagnitude: 0.3,
    template: (f) => `${civOf(f)} opened trade with ${otherOf(f)}.`,
  },
  decision: {
    min: 0.1,
    max: 0.45,
    defaultMagnitude: 0.25,
    template: (f) => `${civOf(f)} resolved to ${subjectOf(f)}.`,
  },
  refusal: {
    min: 0.1,
    max: 0.4,
    defaultMagnitude: 0.2,
    template: (f) => `${civOf(f)} refused to ${subjectOf(f)}.`,
  },
  // The quiet background hum of history.
  person: {
    min: 0.05,
    max: 0.35,
    defaultMagnitude: 0.15,
    template: (f) => `${subjectOf(f)}.`,
  },
  growth: {
    min: 0.05,
    max: 0.3,
    defaultMagnitude: 0.1,
    template: (f) => `${placeOf(f)} grew.`,
  },
};

/** The weight range `[min, max]` a kind can occupy — exposed for calibration tests. */
export function weightRange(kind: EventKind): { min: number; max: number } {
  const m = KIND_META[kind];
  return { min: m.min, max: m.max };
}

/** Render a kind's durable headline from fields, without emitting anything. */
export function describeEvent(kind: EventKind, fields: EventFields = {}): string {
  return KIND_META[kind].template(fields);
}

/**
 * Map a 0..1 magnitude onto a kind's calibrated weight band. This is the whole
 * calibration guarantee: every instance of a kind lands inside its band, so the
 * cross-kind ordering of the bands holds no matter how dramatic one instance is.
 */
export function weightFor(kind: EventKind, magnitude: number): number {
  const m = KIND_META[kind];
  const t = clamp01(magnitude);
  return m.min + (m.max - m.min) * t;
}

export interface EmitSpec {
  kind: EventKind;
  /** Actor civilisation, or null for a world-level event. */
  civ?: number | null;
  /** Where it happened, or null. */
  cell?: number | null;
  /**
   * How consequential *this* occurrence is, 0..1. Mapped onto the kind's weight
   * band. Omit to use the kind's default. Ignored if `weight` is given.
   */
  magnitude?: number;
  /** Escape hatch: set the final weight directly (still clamped to 0..1). */
  weight?: number;
  /** Values for the kind's template. Ignored when `text` is supplied. */
  fields?: EventFields;
  /** A ready-made headline, bypassing the template. */
  text?: string;
  /** Ids of the events that produced this one. */
  causedBy?: number[];
}

/**
 * Emit one event: append it to the log and return it, so a caller can chain the
 * next event's `causedBy` off the returned id. This is the single writer into
 * `world.events` — no subsystem should push events by hand.
 */
export function emit(world: World, spec: EmitSpec): WorldEvent {
  const meta = KIND_META[spec.kind];
  const magnitude = spec.magnitude ?? meta.defaultMagnitude;
  const weight =
    spec.weight !== undefined ? clamp01(spec.weight) : weightFor(spec.kind, magnitude);
  const text = spec.text ?? meta.template(spec.fields ?? {});

  const event: WorldEvent = {
    id: world.nextEventId++,
    year: world.year,
    kind: spec.kind,
    civ: spec.civ ?? null,
    cell: spec.cell ?? null,
    weight,
    text,
    causedBy: spec.causedBy ? [...spec.causedBy] : [],
  };
  world.events.push(event);
  return event;
}

/* ------------------------------------------------------------------ *
 * Reading the log back
 * ------------------------------------------------------------------ */

/**
 * The chronicle: the events that cleared a weight bar, newest concerns first in
 * whatever order they were emitted (emission order is chronological). This is
 * how the front page answers "what actually mattered" without scanning a
 * two-thousand-year firehose.
 */
export function filterByWeight(
  events: readonly WorldEvent[],
  minWeight: number,
): WorldEvent[] {
  return events.filter((e) => e.weight >= minWeight);
}

export interface ChronicleOptions {
  /** Keep only events at or above this weight. Default 0 (everything). */
  minWeight?: number;
  /** Inclusive year window. */
  fromYear?: number;
  toYear?: number;
}

/**
 * Render the log to a plain-text chronicle, one line per event, oldest first:
 * `Year 1234  ·  A people founded Ur.`. Deliberately dumb — the durable, no-LLM
 * view of history.
 */
export function renderChronicle(
  events: readonly WorldEvent[],
  opts: ChronicleOptions = {},
): string {
  const min = opts.minWeight ?? 0;
  const lines: string[] = [];
  for (const e of events) {
    if (e.weight < min) continue;
    if (opts.fromYear !== undefined && e.year < opts.fromYear) continue;
    if (opts.toYear !== undefined && e.year > opts.toYear) continue;
    lines.push(`Year ${e.year}  ·  ${e.text}`);
  }
  return lines.join("\n");
}

/**
 * Walk `causedBy` transitively from one event and return every ancestor cause,
 * nearest first, de-duplicated. This is how you answer "why did this happen?" —
 * following a famine back to the harvest failure, and the failure back to the
 * drought behind it. Cycles (which append-only ids make impossible in practice)
 * are guarded against anyway.
 */
export function traceCauses(
  events: readonly WorldEvent[],
  eventId: number,
): WorldEvent[] {
  const byId = new Map<number, WorldEvent>();
  for (const e of events) byId.set(e.id, e);

  const start = byId.get(eventId);
  if (!start) return [];

  const out: WorldEvent[] = [];
  const seen = new Set<number>([eventId]);
  const queue: number[] = [...start.causedBy];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = byId.get(id);
    if (!parent) continue;
    out.push(parent);
    for (const p of parent.causedBy) if (!seen.has(p)) queue.push(p);
  }
  return out;
}
