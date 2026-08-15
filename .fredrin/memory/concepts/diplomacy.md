# Contact, diplomacy, trade & diffusion

How civilisations meet, deal, remember and leak ideas to each other.
Implemented in `packages/engine/src/diplomacy.ts`, running as **stage 5 of the
tick** (after research, before extinction emission). No LLM on this path — the
agent layer *proposes* diplomatic acts (`envoy`/`pact`/`spy` directives in
`packages/agents/src/directives.ts`); this module is the engine that disposes.
Determinism: every pair-level draw comes from `hashSeed("diplo", lo, hi, year)`
with the pair in stable id order (sub-streams add a tag, e.g. `"meet"`,
`"expedition"`).

## Contact has two channels — and the second one is load-bearing

1. **Proximity**: a windowed scan over `grid.owner` (verified in real km via
   `cellDistance`) meets pairs whose territories drift within
   `CONTACT_RANGE_KM` (260, or 620 when either sails). Skipped entirely once
   every living pair has met.
2. **Expeditions**: a civ holding `navigation` discovers, at
   `EXPEDITION_CHANCE`/yr, any unmet people with an owned *coast* cell within
   `NAVIGATION_CONTACT_RANGE_KM` (4500) of one of its coastal settlements.
   **Why this exists:** the five start continents apart and territorial growth
   is deliberately capped by the admin-reach brake (see [[settlement]]), so on
   the real Earth proximity contact alone NEVER fires — measured: closest pair
   still ~2,900 km apart at year 3500. Deep-water navigation is what connects
   this world, as it did ours; in a seed-42 run the contact graph lights up
   within ~20 years of navigation existing, and stays realistically partial
   (transatlantic pairs meet, the 8,700 km ones don't).

Contact writes both `known` lists, creates both `Relation`s, emits ONE
`contact` event (stored as `contactEvent` on both relations — the causal
anchor later events point at), and forms a first noisy belief on each side.

## Relations have memory, not a mood

`opinion` is **recomputed every year from durable components**, never drifted:
familiarity (slow, capped), active treaty, active trade route (base + age
bonus), war penalty, minus every grievance at
`100 × weight × 0.5^(age/120yr)`. A 0.8-weight betrayal is −80 fresh, −25 two
centuries on, −2.5 after six; grievances are pruned only when the decayed
sting drops below 1 opinion point (~750 yr). `addGrievance` is the single
write path into that memory — war uses it too (aggression 0.55, conquest 0.6;
see [[war]]). War/peace relation bookkeeping (`declareWar` / `makePeace` /
`sueForPeace`, `Relation.warSince`/`warEvent`/`peaceOffer`) lives in this
module so wars are remembered like every other dealing; the fighting itself is
`military.ts`, tick stage 5b.

## Treaties, trade, goods

- Treaties form by **mutual offers**, one offer met with warm opinion
  (≥ `TREATY_OPINION_MIN`), or ripen automatically after 40 trading years.
  Formation and breach both emit `peace` (no new EventKind was added —
  `contact`/`trade`/`peace`/`discovery`/`decision` cover diplomacy).
  `breakTreaty()` plants the `TREATY_BREAK_WEIGHT` (0.8) grievance on the
  wronged side only.
- Trade routes are relation state (`tradeSince` on both sides, engine keeps
  them symmetric — no World-shape/serialisation change). They open on their
  own 10 years after contact when neither side is sour, closing at war or
  opinion < −20.
- Barter is value-balanced and conservative: each side offers
  `TRADABLE_SHARE` of goods it holds in >2× per-head abundance over the
  other, equal value moves each way (capped by route capacity scaled by
  wheel/roads/sailing/navigation/currency), and goods really leave one
  `Stores` and land in the other. No credit, nothing minted.

## Diffusion respects the possibility gates (anti-snowball)

A capability leaks only if the receiver could research it **right now** —
candidates are `researchable(receiver) ∩ held(sender)`, the same gate check
research uses, then a per-era-halved yearly chance (trade route ≫ mere
contact), granted through `adoptCapability()` in `research.ts` so holders/
events/prereq-closure stay consistent. No reachable tin still means no bronze,
however rich the neighbour — pinned by a 500-year negative test. Note the
gate reads *deposits in territory*, not traded stores: tin bought by caravan
does not make bronze researchable. (Deliberate for now; loosening it is a
real design decision, not a bug fix.) `researchGates` is cached per civ per
step and invalidated on adoption — it scans the grid, so don't call it per
pair.

## Espionage, beliefs, messages

- The agent orders an op (`Civ.espionage`, optional field like `projects`);
  the next tick resolves it: seeded roll of agency (era + centralization +
  writing/currency) vs counter-intelligence, success 15–85%. Steal missions
  carry home a capability **through the same gates as diffusion**; detection
  (likelier on failure) plants a `SPY_CAUGHT_WEIGHT` grievance and emits a
  `decision` event.
- `Relation.belief` is a noisy snapshot {population, era, military, asOf} —
  noise by channel (contact 0.5, traders' gossip 0.25 refreshed ~5-yearly,
  spies 0.05). **Isolation degrades beliefs by staleness, not added noise**:
  the world moves on while `asOf` stands still. The briefing renders only
  these beliefs — fog of war holds.
- `relayMessage` is the ONLY inter-mind channel: engine-relayed, contact
  required, 240 chars, inbox capped at 5 (`Relation.inbox`), surfaced in the
  recipient's briefing.

All new `Relation`/`Civ` fields are optional, so pre-diplomacy snapshots load
unchanged (format stays v1).
