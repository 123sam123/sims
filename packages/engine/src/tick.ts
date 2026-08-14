/**
 * The tick: one sim-year, advanced in a fixed, dependency-ordered sequence.
 *
 * This is the loop that turns a pile of subsystem functions into a world that
 * runs. Every stage runs in the same order every year, and a later stage reads
 * what an earlier stage wrote *this* year:
 *
 *   1. environment   — the physical planet. Relief and climate are fixed after
 *                      worldgen; the one living environmental process, forest
 *                      regrowth, runs inside production, so this stage is an
 *                      explicit no-op seam where future climate/season lands.
 *   2. production     — land + labour -> goods, into stores, deposits, forest.
 *   3. settlement     — population, migration, founding, territory. `stepSettlements`
 *                      OWNS the population step: migration is the release valve
 *                      for population pressure, so the two are one call, not two.
 *   4. research       — spend scholarship toward each civ's target; lose unwritten
 *                      knowledge whose carriers have died.
 *   5. diplomacy      — contact, opinions with decaying memory, trade, treaties,
 *                      technology diffusion and espionage resolution. Runs after
 *                      research so this year's discoveries can already leak, and
 *                      before extinction so a civ's last dealings are recorded.
 *   6. event emission — world-level events the subsystems don't own (extinctions).
 *   7. directive execution — draw down the standing projects an agent's accepted
 *                      directives enqueued in an EARLIER year. The decisions
 *                      themselves (LLM/heuristic) are made by the runner between
 *                      ticks and only enqueue work; executing it here, last, is
 *                      what stops an agent ever observing its own directive land
 *                      within the tick that issued it.
 *
 * Determinism is the contract. Every stochastic draw comes from a seeded stream
 * keyed by `(subsystem, ids, world.year)`, so the result never depends on the
 * order the tick happened to visit things in, and a seed always replays to the
 * same history. There is no `Math.random` and no `Date.now` anywhere on this
 * path — timing and wall-clock belong to the runner, never to the world.
 *
 * All stages run while `world.year` still holds the year being simulated; the
 * clock is advanced to `year + 1` only at the very end. So after N ticks from a
 * fresh world, `world.year === N`.
 */

import { type DiplomacyReport, stepDiplomacy } from "./diplomacy.ts";
import { emit } from "./events.ts";
import { advanceResearch, type ResearchResult } from "./research.ts";
import { runProduction, type ProductionResult } from "./production.ts";
import { executeDirectives, type ProjectResult } from "./projects.ts";
import { type SettlementReport, stepSettlements } from "./settlement.ts";
import { civPopulation, type World } from "./types.ts";

export interface TickReport {
  /** The year that was just simulated (the value of `world.year` on entry). */
  year: number;
  production: ProductionResult[];
  settlement: SettlementReport;
  research: ResearchResult[];
  /** Contact, trade, treaties, diffusion and espionage this year. */
  diplomacy: DiplomacyReport;
  /** Civ ids that died out this year. */
  extinctions: number[];
  /** Standing projects advanced this year, per civ. */
  projects: ProjectResult[];
}

/**
 * Advance `world` by exactly one year, mutating it in place, and return a
 * per-stage summary for the chronicle and for tests. Pure of IO and wall-clock.
 */
export function tickWorld(world: World): TickReport {
  const year = world.year;

  // 1. environment — fixed relief/climate; forest regrowth lives in production.

  // 2. production
  const production = runProduction(world);

  // 3. population + settlement / migration (one call; settlement owns population)
  const settlement = stepSettlements(world);

  // 4. research and knowledge loss
  const research = advanceResearch(world);

  // 5. diplomacy — contact, relations, trade, diffusion, espionage
  const diplomacy = stepDiplomacy(world);

  // 6. event emission — derived, world-level
  const extinctions = emitExtinctions(world, year);

  // 7. agent directive execution — advance projects accepted in an earlier year.
  const projects = executeDirectives(world);

  world.year = year + 1;

  return { year, production, settlement, research, diplomacy, extinctions, projects };
}

/**
 * Mark any living civilisation that has just run out of people as extinct and
 * log it. Deterministic: civs are visited in stable id order and the only input
 * is the population the earlier stages already settled. A dead civ is skipped by
 * every subsystem from the next tick on.
 */
function emitExtinctions(world: World, year: number): number[] {
  const extinct: number[] = [];
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    if (civPopulation(world, civ.id) > 0) continue;
    civ.alive = false;
    civ.extinctYear = year;
    // `world.year === year` here (the year is only advanced after this stage),
    // so the single event writer stamps the same year. The heaviest event there
    // is: a civilisation ending.
    emit(world, {
      kind: "collapse",
      civ: civ.id,
      weight: 1,
      text: `${civ.name} died out.`,
    });
    extinct.push(civ.id);
  }
  return extinct;
}
