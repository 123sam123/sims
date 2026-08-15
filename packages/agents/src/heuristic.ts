/**
 * The heuristic brain — a deterministic mind so the world runs with no API key.
 *
 * It is not meant to be clever; it is meant to be *lawful and characterful
 * enough* that the simulation exercises every path the real model would: it
 * keeps research moving, builds when it can, and — crucially — reaches for the
 * next age before it is ready, so refusals happen naturally and the "you learn
 * the world by hitting its walls" loop is real even offline. No randomness and
 * no wall-clock: the same world always yields the same directives.
 */

import {
  type Capability,
  type Civ,
  civPopulation,
  researchable,
  researchGates,
  type World,
} from "@sim/engine";
import type { Brain, DecisionContext } from "./brain.ts";
import type { Directive, DirectiveSet } from "./directives.ts";

/** Names the five peoples give themselves once they can write — deterministic,
 *  one per starting doctrine. */
const SELF_NAMES: Record<string, string> = {
  aquitaine: "The Aquitani",
  greatlakes: "The Lakespeople",
  zambezi: "The Zambezi Kin",
  deccan: "The Deccan Reckoners",
  honshu: "The Honshu Makers",
};

/** The stretch order a civ reaches for by era — refused until it is ready. */
function ambition(civ: Civ): Directive | null {
  const held = new Set(civ.capabilities);
  if (!held.has("bronze")) return { type: "construct", building: "bronze tools", rationale: "arm our people in bronze" };
  if (!held.has("iron_smelting")) return { type: "construct", building: "iron tools", rationale: "iron for tools and war" };
  if (!held.has("steel")) return { type: "construct", building: "steel tools", rationale: "the finest edge our smiths can make" };
  return { type: "construct", building: "monument", rationale: "a work to outlast us" };
}

export function createHeuristicBrain(): Brain {
  return {
    kind: "heuristic",
    decide(ctx: DecisionContext): Promise<DirectiveSet> {
      return Promise.resolve({ directives: propose(ctx.world, ctx.civ) });
    },
  };
}

function propose(world: World, civ: Civ): Directive[] {
  const directives: Directive[] = [];
  const held = new Set(civ.capabilities);
  const pop = civPopulation(world, civ.id);
  const sites = world.settlements.filter((s) => s.civ === civ.id).length;
  const projectCount = civ.projects?.length ?? 0;

  // 1. Keep research moving when nothing is steered — cheapest reachable next.
  if (!civ.research.target) {
    const next = cheapestResearchable(world, civ);
    if (next) directives.push({ type: "research", target: next.id, rationale: `learn ${next.name}` });
  }

  // 2. Reach for the next age. This is the one that gets refused early on.
  const reach = ambition(civ);
  if (reach) directives.push(reach);

  // 3. Build something useful while there is timber and no work in hand.
  if (held.has("settlement") && projectCount === 0 && civ.stores.wood >= 20) {
    directives.push({ type: "construct", building: "storehouse", rationale: "store the surplus against lean years" });
  }

  // 4. Grow into new land once the people crowd their settlements.
  if (held.has("settlement") && projectCount === 0 && sites > 0 && pop / sites > 900 && civ.stores.wood >= 40) {
    directives.push({ type: "settle", rationale: "our settlements are full; send people to new land" });
  }

  // 5. Lean into learning once literate.
  if (held.has("writing") && civ.policy.research < 0.3) {
    directives.push({ type: "policy", research: 0.3, building: 0.2, rationale: "invest in scholarship" });
  }

  // 6. Sue for peace when a war has bled the people white — the heuristic
  // never starts wars (the engine's own ignition covers hostility), but it
  // knows when to stop one.
  if (civ.military.morale < 0.45) {
    for (const [idStr, rel] of Object.entries(civ.relations)) {
      if (rel.atWar) {
        directives.push({
          type: "pact",
          towards: Number(idStr),
          action: "peace",
          rationale: "this war costs more than it can return",
        });
        break;
      }
    }
  }

  // 7. Name the people once they can record the name.
  if (held.has("writing") && civ.name.startsWith("Band of")) {
    const name = SELF_NAMES[civ.key] ?? civ.key;
    directives.push({ type: "proclaim", name, record: `We name ourselves ${name}.`, rationale: "a people should have a name" });
  }

  return directives;
}

/** The cheapest thing the civ could research right now, era then id breaking
 *  ties — deterministic, and enough to creep an unsteered civ forward. */
function cheapestResearchable(world: World, civ: Civ): Capability | null {
  const g = researchGates(world, civ.id);
  const options = researchable(g.held, g.hasMaterial, g.hasTerrain, g.population);
  if (options.length === 0) return null;
  let best = options[0];
  for (const c of options) {
    if (c.effort < best.effort || (c.effort === best.effort && (c.era < best.era || (c.era === best.era && c.id < best.id)))) {
      best = c;
    }
  }
  return best;
}
