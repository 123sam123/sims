# War — armies, logistics, battle and consequences

War, fought with what a civilisation actually has. Implemented in
`packages/engine/src/military.ts`, running as **stage 5b of the tick** (after
diplomacy, so wars ignite from this year's opinions and beliefs; before
extinction emission, so a people destroyed in war is mourned the same year it
fell). War/peace *relation bookkeeping* lives in `diplomacy.ts`
(`declareWar` / `makePeace` / `sueForPeace`) so wars are remembered exactly
like every other dealing. No LLM on this path. Determinism: pair draws from
`hashSeed("war", lo, hi, year)` (tags `"declare"`, `"battle"`, `"peace"`),
per-civ draws tagged per civ-year; armies visited in stable (civ, id) order.

## No unit without its supply chain (the load-bearing commitment)

- **Muster** — `Civ.military.troops` tracks a *claim on the workforce*:
  production subtracts every soldier from labour (`production.ts`), so an army
  is paid for in lost output before it fights. Target =
  `policy.military × MOBILISATION_SCALE (0.3) × working-age`, capped at
  `WARBAND_CAP` (2%) without `military_org`, raised/disbanded at ~25%/yr —
  never more soldiers than people. Soldiers stay *in* settlement demography
  (they are a label, not a migration); war deaths are removed from real
  working-age `ages` slots via `killPeople`, so the missing generation and the
  birth collapse follow from the population model on their own.
- **Equipment** — `Civ.military.equipment` is an arsenal in quality-points.
  `equipmentTier` (stone 1 / bronze 2 / iron 2.8 / steel 3.6) is the
  *knowledge* ceiling; `forgeEquipment` pays for every weapon-set out of real
  `Stores` (bronze set = 0.22 copper + 0.08 tin + wood), falling back to
  lesser recipes when the metal runs out — knowing bronze arms nobody without
  copper, and a lesser recipe can never fill the arsenal past its own tier
  (pinned by tests). Army quality = carried points / troops, capped by tier.
- **Supply** — within `SUPPLY_RANGE_KM` (700, ×1.5 with roads) of ANY
  friendly-held cell (conquered land counts — a beachhead is a supply line) an
  army eats from `stores.food`; beyond that from ration carts loaded at
  fielding (1.5 yr, drawn from the granary); after that, `ATTRITION_RATE`
  (18%/unsupplied-yr) — armies die of hunger without a battle.

## Armies, movement, battle

`Army` records ride on `Civ.military.armies` (plain JSON — optional, so
pre-war snapshots load; format stays v1). Movement is a greedy cell walk
toward the objective priced by `terrainFactor` (mountains 0.4×, roads/cavalry
multipliers); ocean cells are enterable only with `sailing` (sea pace 2600
km/yr) — an army that cannot cross the water simply stands, which is a wall of
the world, not a bug. Battle is an **attritional yearly casualty exchange**,
never one roll: loss share = `BATTLE_INTENSITY × enemyStrength/total`, capped
0.45, with strength = troops × (1+quality) × morale × commander. Assaulted
settlements defend with the home reserve + a militia of their own people,
multiplied by elevation/forest/`fortification`/walls; attacker `siegecraft`
cancels half that. Commanders are minimal `Person` records (first user of
`world.people`) — they shift strength ±15% and can fall in battle (`person`
events, biography for free).

## Consequences are real and visible

A stormed settlement is sacked (`settlement.ts:sackSettlement`): 12% killed,
30% flee to the nearest surviving sibling (a real people transfer + a
`settlement` refugee event), the rest are **subjugated — the settlement and
its catchment change `civ`/`grid.owner`**, so total conquest = the loser's
`civPopulation` hits 0 = collapse event, with no special-case code. NB: the
conqueror's *net* population can therefore rise; "war is never free" is
asserted on real deaths and the attacker's own home settlement, not net
headcount. Conquest plants a `CONQUEST_GRIEVANCE_WEIGHT` (0.6) grievance via
`addGrievance` — wars seed the next war's hostility.

## Who starts wars, and how they end

Two paths, one write-path (`declareWar`): the **agent** (pact directive gained
`war`/`peace` actions — the engine never blocks the choice, it prices it), and
the **engine's own ignition** — opinion ≤ −30 AND *believed* military
advantage ≥1.25× (beliefs may be stale → misjudged wars are a feature) AND
`military_org` AND recovered war spirit (`WAR_MORALE_MIN` 0.5 — the brake that
spaces recurring border wars ~15 yr apart instead of three; agent wars are
deliberately NOT gated on it). Peace: national morale collapse (< 0.28), a
standing `sueForPeace` offer accepted when mutual or the other side is worn
below 0.5, or war-weariness (25%/yr after year 8). Peace terms are whatever
the map now says — the engine hands nothing back.

Event kinds are all reused (`war`/`battle`/`peace`/`settlement`/`person`/
`decision`) with causal chains: battles point at their declaration, refugee
flight at the sack, the peace at the war. Perf: ~1.7 ms/tick with the stage in
(early-outs when nobody wars). Mid-war snapshots (armies in the field)
round-trip serialisation and replay identically — pinned by test.
