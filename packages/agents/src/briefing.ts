/**
 * The briefing — what a civilisation's mind is allowed to see.
 *
 * Fog of war is the load-bearing constraint of the whole project: a civ decides
 * from what it *believes*, never from the `World`. So this module builds the
 * decision prompt out of one civ's own state plus only what contact and
 * diplomacy have recorded about others (`known` / `relations`) — and nothing
 * else. It never reads another civ's capabilities, stores, population or the
 * name it chose for itself. Beliefs may be stale or wrong; that is the point.
 *
 * The prompt is split for prompt-caching, which here is architecture, not an
 * optimisation. A stable prefix — the unchanging rules of the world, then this
 * civ's slowly-changing doctrine and chronicle — carries cache breakpoints, and
 * only a small volatile tail (this decision's world state) is rebuilt each time.
 * Put anything time-varying in the prefix and the cache hit rate is zero.
 */

import {
  type Capability,
  type Civ,
  civPopulation,
  researchable,
  researchGates,
  settlementPop,
  type World,
} from "@sim/engine";

/** A `system` block in the shape the Anthropic SDK accepts, with an optional
 *  cache breakpoint. Kept SDK-free so the briefing can be built and tested
 *  without a network client. */
export interface CachedTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface Briefing {
  /** Stable, cacheable prefix: the world's rules, then this civ's doctrine and
   *  chronicle. Passed as the request `system`. */
  system: CachedTextBlock[];
  /** Volatile tail: this decision's believed world state. The user message. */
  context: string;
  /** The civ this briefing is for — handy for the caller. */
  civId: number;
}

/** How many chronicle lines the prompt carries. The chronicle is institutional
 *  memory and grows without bound; the prompt shows only the recent tail. */
const CHRONICLE_LINES = 16;
/** How many researchable options to list, cheapest first. */
const RESEARCH_OPTIONS = 12;

/**
 * The rules of the world — identical for every civilisation and every decision,
 * so it sits first and is cache-shared across all five minds. Explains the
 * propose/dispose contract, the six gates, and the directive vocabulary.
 */
const WORLD_RULES = `You are the mind of one civilisation growing from the stone age on the real Earth. You do not move armies or place cities by hand. Each turn you issue DIRECTIVES — intentions — and the world decides what is actually possible.

Every directive is checked against six gates. If one fails, the directive is refused and you are told why, so you learn the world by hitting its walls:
- knowledge: do your people know how? Nothing can be built without the capability behind it.
- materials: is the physical resource in reach? No tin in your soil, no bronze — ever.
- labour: are there hands to spare from feeding the people?
- capital: is anything stockpiled to fund it?
- authority: does your government have the standing to command it?
- time: is your society large and advanced enough yet?

Accepted directives take effect over the FOLLOWING years, not instantly. Construction and new settlements draw real materials and labour and take time to finish.

Issue a short list of directives, each one of:
- research: steer your scholars toward a capability (give its id).
- construct: build a structure or item at a settlement (name it).
- settle: found a new settlement where your reach and land allow.
- policy: set effort shares (0..1) across farming, building, research, military.
- proclaim: name your people, declare a form of government, or record a law or event.
- envoy: send words to a people you have met (give their civ id and the message).
- pact: offer a treaty to a people you have met, break the one that stands (a broken pact is remembered for centuries), declare war on them, or sue for peace in a war you are fighting. War is never blocked and never free: soldiers stop producing, equipment costs real goods, campaigns eat the granary, and the dead are your own people. A peace plea ends the war only when both sides will it, or the other side is worn down enough to take it.
- spy: send agents into a people you have met, to steal a capability or assess their strength. The world decides whether they succeed — and whether they are caught.

What you know of other peoples is only what contact, trade and your own spies have brought back. Your beliefs about them may be old or wrong.

Be true to your people's character. Reach for what is just beyond you; the refusals will teach you the shape of the world.`;

/** Build the fog-of-war briefing for one civilisation. */
export function buildBriefing(world: World, civ: Civ): Briefing {
  const system: CachedTextBlock[] = [
    { type: "text", text: WORLD_RULES, cache_control: { type: "ephemeral" } },
    { type: "text", text: identityBlock(civ), cache_control: { type: "ephemeral" } },
  ];
  return { system, context: contextBlock(world, civ), civId: civ.id };
}

/** Doctrine + chronicle: who this civ is and what it remembers. Slowly changing,
 *  so it rides in the cached prefix. */
function identityBlock(civ: Civ): string {
  const lines = [`You are the mind of ${civ.name}.`, "", civ.doctrine, ""];
  if (civ.chronicle.length > 0) {
    lines.push("Your chronicle (institutional memory):");
    for (const entry of civ.chronicle.slice(-CHRONICLE_LINES)) lines.push(`  ${entry}`);
  } else {
    lines.push("Your chronicle is empty; nothing has yet been written down.");
  }
  return lines.join("\n");
}

/** This decision's believed world state — the only volatile part. */
function contextBlock(world: World, civ: Civ): string {
  const pop = civPopulation(world, civ.id);
  const sites = world.settlements.filter((s) => s.civ === civ.id);
  const largest = sites.reduce((m, s) => Math.max(m, settlementPop(s)), 0);
  const out: string[] = [];

  out.push(`Year ${world.year}.`);
  out.push(
    `Your people number about ${Math.round(pop).toLocaleString()} across ${sites.length} settlement(s); your largest holds about ${Math.round(largest).toLocaleString()}.`,
  );
  out.push(`Government: ${civ.government.form} (legitimacy ${civ.government.legitimacy.toFixed(2)}, centralization ${civ.government.centralization.toFixed(2)}).`);
  out.push(
    `Effort — farming ${pct(civ.policy.farming)}, building ${pct(civ.policy.building)}, research ${pct(civ.policy.research)}, military ${pct(civ.policy.military)}.`,
  );
  out.push(`Stores: ${describeStores(civ)}.`);
  out.push(`Capabilities you hold: ${civ.capabilities.join(", ") || "none"}.`);
  if (civ.forgotten.length) out.push(`Capabilities lost to time: ${civ.forgotten.join(", ")}.`);

  if (civ.research.target) {
    out.push(`Current research: ${civ.research.target} (progress ${civ.research.progress.toFixed(0)}).`);
  } else {
    out.push("No research is currently steered.");
  }

  const options = describeResearchable(world, civ);
  if (options.length) {
    out.push("", "You could plausibly research now (id — name — effort):");
    for (const line of options) out.push(`  ${line}`);
  }

  if (civ.agenda.length) {
    out.push("", "Standing orders in force:");
    for (const a of civ.agenda) out.push(`  ${a}`);
  }

  out.push("", describeNeighbours(world, civ));

  out.push(
    "",
    "Issue your directives for the coming years. Prefer a few good orders to many. Reach a little past what you have.",
  );
  return out.join("\n");
}

/** What this civ believes about its neighbours — ONLY what contact recorded. */
function describeNeighbours(world: World, civ: Civ): string {
  if (civ.known.length === 0) {
    return "You have met no other peoples; as far as you know, you are alone in the world.";
  }
  const lines = ["Peoples you have encountered:"];
  for (const otherId of civ.known) {
    const rel = civ.relations[otherId];
    // Only the met civ's chosen name and this civ's OWN recorded relation and
    // beliefs — never the other's true capabilities, stores or strength.
    const other = world.civs.find((c) => c.id === otherId);
    const name = other ? other.name : `a people (${otherId})`;
    if (!rel) {
      lines.push(`  ${name} (civ ${otherId}): encountered, no dealings recorded.`);
      continue;
    }
    const bits = [`opinion ${rel.opinion}`];
    if (rel.atWar) bits.push("at war");
    if (rel.treaty) bits.push(`treaty: ${rel.treaty}`);
    if (rel.tradeSince !== undefined && rel.tradeSince !== null) {
      bits.push(`trading since year ${rel.tradeSince}`);
    }
    bits.push(`met year ${rel.contactYear}`);
    lines.push(`  ${name} (civ ${otherId}): ${bits.join(", ")}.`);
    if (rel.belief) {
      lines.push(
        `    You reckon them some ${rel.belief.population.toLocaleString()} people, of era ${rel.belief.era}, about ${rel.belief.military.toLocaleString()} under arms — as of year ${rel.belief.asOf}. The world may have moved on.`,
      );
    }
    const grudge = freshestGrievance(rel);
    if (grudge) {
      lines.push(`    Your people remember: they ${grudge.note} (year ${grudge.year}).`);
    }
    if (rel.inbox && rel.inbox.length > 0) {
      lines.push("    Words they have sent you:");
      for (const m of rel.inbox) lines.push(`      [year ${m.year}] ${m.text}`);
    }
  }
  return lines.join("\n");
}

/** The wrong that still stings most — heaviest first, newest breaking ties. */
function freshestGrievance(
  rel: NonNullable<Civ["relations"][number]>,
): { year: number; note: string } | null {
  let best: { year: number; note: string; weight: number } | null = null;
  for (const g of rel.grievances) {
    if (!best || g.weight > best.weight || (g.weight === best.weight && g.year > best.year)) {
      best = g;
    }
  }
  return best;
}

function describeResearchable(world: World, civ: Civ): string[] {
  const g = researchGates(world, civ.id);
  const opts: Capability[] = researchable(g.held, g.hasMaterial, g.hasTerrain, g.population);
  return opts
    .sort((a, b) => a.effort - b.effort || a.era - b.era)
    .slice(0, RESEARCH_OPTIONS)
    .map((c) => `${c.id} — ${c.name} — ~${c.effort}`);
}

function describeStores(civ: Civ): string {
  const parts: string[] = [];
  for (const [good, amount] of Object.entries(civ.stores)) {
    if (amount >= 1) parts.push(`${good} ${Math.round(amount)}`);
  }
  return parts.length ? parts.join(", ") : "bare";
}

const pct = (v: number): string => `${Math.round(v * 100)}%`;
