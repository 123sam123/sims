# Events & the chronicle

The world's only memory. We settled on **live-present-only** — no rewind — so the
written event log is the *only* history the world keeps. If a state change is not
emitted as an event, it did not happen and cannot be recovered. Implemented in
`packages/engine/src/events.ts`; the type lives on `WorldEvent` in `types.ts`. No
LLM is involved — narration by a model is a later, batched, cheap concern; the
templates here are the durable fallback that must stand on their own.

## Shape of an event

`WorldEvent` = `{ id, year, kind, civ, cell, weight, text, causedBy }`.

- **`kind`** — one of 21 `EventKind`s, from `founding` to `collapse`. Four of
  them (`unrest`, `secession`, `depletion`, `degradation`) belong to the
  anti-snowball brakes (see [[brakes]]), so the log can say *why* a civ stalled.
- **`weight`** (0..1) — magnitude. Drives what the front page leads with, and later
  which events are worth an LLM narration call.
- **`text`** — the durable, templated headline.
- **`causedBy`** — ids of the events that produced this one. Append-only.

Events are append-only: set once at emission, never mutated.

## `emit` is the only writer

`emit(world, spec)` is the single path into `world.events` — no subsystem pushes by
hand. It assigns the id, stamps `world.year`, renders text, computes weight, appends,
and **returns the event** so a caller can chain the next event's `causedBy` off its
`.id`. Emission is O(1), cheap enough to call inside the tick.

`spec` carries `{ kind, civ?, cell?, magnitude?, weight?, fields?, text?, causedBy? }`.
Supply `fields` to render the kind's template, or `text` to override it; supply
`magnitude` (0..1) to place the event in its kind's weight band, or `weight` to set it
outright.

## Weight is calibrated across kinds

Each kind owns a `[min, max]` band in `KIND_META`, and the bands are **ordered across
kinds**: the top of a settlement `founding` (0.5) sits below the bottom of a
civilisation `collapse` (0.85). So no amount of local drama lifts a founding above a
collapse. `magnitude` lerps within the band (`weightFor(kind, mag)`). To re-tune what
matters, move the bands — not the call sites.

`filterByWeight(events, 0.6)` is the chronicle of "things that actually mattered": on a
2,000-year run of ~8,900 events, ~650 clear 0.6 — hundreds, readable in one sitting,
not a 10,000-line firehose. `renderChronicle` prints it, one dated line per event.

## Causal memory

`causedBy` is how the log answers *why*. Production wires the canonical example: a
harvest shortfall emits a `disaster` ("the harvest failed …") and then the `famine`
with `causedBy: [harvest.id]` — the mechanism precedes and is outweighed by its human
consequence. `traceCauses(events, id)` walks the links transitively (nearest cause
first, cycle-guarded), so a famine can be traced back to the fields that failed.

## Retention

Keep everything for now. On a world that never stops the log grows without bound;
compaction of low-weight events is the likely answer once a long run shows the real
growth rate.
