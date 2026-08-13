/**
 * Directive execution — turning accepted orders into things that happen.
 *
 * The agent layer *proposes* directives and adjudicates them against the six
 * gates; a construction or settlement directive that survives becomes a
 * `Project` queued on the civilisation. This module is the engine's side of the
 * "the agent proposes, the engine disposes" contract: it draws down those
 * projects, year by year, from the same labour and materials every other
 * subsystem competes for. Nothing here calls an LLM, and nothing here is
 * stochastic — a project advances by exactly the labour its civ can spare and
 * exactly the materials in its stores, so a seed always replays to the same
 * skyline.
 *
 * Why it lives on the tick rather than in the agent loop: an accepted order must
 * take effect over the years *after* it is issued, never within the tick that
 * issued it (see `tick.ts`, stage 6). Executing here — the last stage of the
 * tick — and enqueuing from the runner *between* ticks is what enforces that.
 */

import { emit } from "./events.ts";
import { workingAgePopulation } from "./production.ts";
import { foundDirectedColony } from "./settlement.ts";
import type { Civ, Project, Settlement, StoreKey, World } from "./types.ts";

/** Below this many labour-years left a project is treated as finished — floating
 *  point never lands exactly on zero. */
const COMPLETE_EPS = 1e-6;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface ProjectResult {
  civ: number;
  /** Structures finished this year: the settlement they rose in and their name. */
  completed: { settlement: number; building: string }[];
  /** Total labour-years spent across all of this civ's projects this year. */
  labourSpent: number;
}

/**
 * Advance every living civilisation's queued projects by one year, drawing
 * labour and materials from what it actually has. Mutates civs, settlements,
 * stores and the event log in place; returns a per-civ summary for the
 * chronicle and for tests. Civs with no queue are skipped and produce no result.
 */
export function executeDirectives(world: World): ProjectResult[] {
  const results: ProjectResult[] = [];
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    if (!civ.projects || civ.projects.length === 0) continue;
    results.push(advanceProjects(world, civ));
  }
  return results;
}

function advanceProjects(world: World, civ: Civ): ProjectResult {
  const completed: { settlement: number; building: string }[] = [];
  // Building labour is what is left of the workforce after this civ's own policy
  // decides how much of it builds rather than farms or fights. A project can
  // only ever draw on this — expansion is never free of the people it needs.
  let budget = workingAgePopulation(world, civ.id) * clamp01(civ.policy.building);
  let labourSpent = 0;
  const queue = civ.projects ?? [];
  const survivors: Project[] = [];

  for (const p of queue) {
    if (budget <= COMPLETE_EPS) {
      survivors.push(p);
      continue;
    }
    const applied = drawProject(civ, p, budget);
    budget -= applied;
    labourSpent += applied;

    if (p.remaining <= COMPLETE_EPS) {
      finishProject(world, civ, p, completed);
    } else {
      survivors.push(p);
    }
  }

  civ.projects = survivors;
  return { civ: civ.id, completed, labourSpent };
}

/**
 * Apply as much of `budget` labour-years to `p` as both the budget and the civ's
 * stores allow, drawing the matching share of materials. Returns the labour
 * actually spent (0 when the project is stalled for want of materials, so the
 * budget flows to the next project instead of being burned on a stuck one).
 */
function drawProject(civ: Civ, p: Project, budget: number): number {
  const wantLabour = Math.min(p.remaining, budget);
  if (wantLabour <= 0 || p.total <= 0) return 0;

  // The fraction of the whole project this much labour would complete, then the
  // fraction the stores can actually pay for — materials, not just muscle.
  let frac = wantLabour / p.total;
  for (const good of Object.keys(p.cost) as StoreKey[]) {
    const c = p.cost[good] ?? 0;
    if (c <= 0) continue;
    const have = civ.stores[good];
    frac = Math.min(frac, have / c);
  }
  if (frac <= 0) return 0;

  for (const good of Object.keys(p.cost) as StoreKey[]) {
    const c = p.cost[good] ?? 0;
    if (c <= 0) continue;
    civ.stores[good] = Math.max(0, civ.stores[good] - c * frac);
  }
  const spent = frac * p.total;
  p.remaining -= spent;
  return spent;
}

/** Complete a project: raise the structure (or found the colony) and log it. */
function finishProject(
  world: World,
  civ: Civ,
  p: Project,
  completed: { settlement: number; building: string }[],
): void {
  if (p.kind === "settle") {
    const colony = foundDirectedColony(world, civ.id);
    if (colony) completed.push({ settlement: colony.id, building: "settlement" });
    return;
  }

  const site = world.settlements.find((s) => s.id === p.settlement && s.civ === civ.id);
  if (!site) return; // its settlement was abandoned mid-build — the work is lost.
  raiseBuilding(site, p.building);
  completed.push({ settlement: site.id, building: p.building });
  emit(world, {
    kind: "decision",
    civ: civ.id,
    cell: site.cell,
    weight: 0.5,
    text: `${civ.name} completed ${p.building}${p.note ? ` — ${p.note}` : ""}.`,
  });
}

/** Record a finished structure on its settlement. Buildings are a plain tally;
 *  their only mechanical hook this far is that dwellings lift shelter. */
function raiseBuilding(site: Settlement, building: string): void {
  site.buildings[building] = (site.buildings[building] ?? 0) + 1;
  if (building === "houses" || building === "dwellings" || building === "longhouses") {
    site.housing += 1;
  }
}
