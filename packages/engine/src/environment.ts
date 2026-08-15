/**
 * The living environment: soil that wears out under the plough.
 *
 * This is one of the four anti-snowball brakes, and like the others it is a
 * mechanism, not a fudge factor: nothing here reads who is "winning". Land that
 * is farmed year after year loses soil health — fastest where the forest that
 * held the topsoil has been cut (`production.ts` does the cutting) — and land
 * left alone slowly recovers. Effective yield everywhere is `fertility × soil`
 * (see `cellFoodCapacity` and `produceFood`), so a civilisation that sits on
 * the same rich valley for five centuries watches its carrying capacity sag,
 * and the event log says why.
 *
 * Damage is *located*: `grid.soil` is per-cell state, so the map can show
 * exactly which hinterlands are worn out, and abandoning a region genuinely
 * lets it heal. No LLM, no randomness at all — pure accumulation, deterministic
 * from the state alone.
 *
 * `stepEnvironment(world)` is tick stage 1, the seam the tick always reserved
 * for the physical planet's own processes.
 */

import { emit } from "./events.ts";
import { forestClimax } from "./production.ts";
import type { Settlement, World } from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables. Everything the model can be argued about lives here,
 * named, calibrated against `brakes.test.ts`.
 * ------------------------------------------------------------------ */

/** Soil health lost per year on a cell worked by a farming civilisation.
 *  Alone this wears a pristine cell to the floor in ~600 years — degradation
 *  is generational, not seasonal. */
export const SOIL_CULTIVATION_WEAR = 0.0012;

/** How much faster worked soil erodes when the cell's forest is gone. At full
 *  deforestation (no standing forest on a naturally forested cell) the wear
 *  rate is `1 + SOIL_EROSION_WEIGHT` times the base — cutting the trees is
 *  what turns slow wear into real erosion. */
export const SOIL_EROSION_WEIGHT = 1.5;

/** Soil never falls below this: land is degraded, not destroyed. The Fertile
 *  Crescent still grows wheat — at a fraction of what it once carried. */
export const SOIL_FLOOR = 0.25;

/** Fraction of the gap back to pristine that unworked land closes each year.
 *  Fallow heals on a ~250-year time constant: leaving a valley for a
 *  generation buys back a little; only abandonment buys back everything. */
export const SOIL_RECOVERY = 0.004;

/** Below this climax cover a biome has no forest worth speaking of, and the
 *  erosion term does not apply (a steppe was never held together by trees). */
export const EROSION_MIN_CLIMAX = 0.1;

/** A settlement whose catchment's mean soil drops below this has visibly worn
 *  its land out, and the log says so (once per decline). */
export const SOIL_STRESS_THRESHOLD = 0.7;
/** Mean soil must recover past this to clear the latch, so an oscillation on
 *  the threshold does not spam the log. */
export const SOIL_RECOVERED_THRESHOLD = 0.8;

export interface EnvironmentReport {
  /** Cells degraded by cultivation this year. */
  workedCells: number;
  /** Settlement ids whose soil exhaustion was newly reported this year. */
  reported: number[];
}

/**
 * Advance the environment by one year: wear the soil under every farmed cell,
 * let fallow land recover, and report catchments that have visibly worn out.
 * Mutates `grid.soil`, settlement latches and the event log in place.
 */
export function stepEnvironment(world: World): EnvironmentReport {
  const grid = world.grid;
  const report: EnvironmentReport = { workedCells: 0, reported: [] };

  // Which settlements' civs actually farm — foragers range too thinly to wear
  // land out, which is also why the map stays pristine until agriculture.
  const byId = new Map<number, Settlement>();
  for (const s of world.settlements) byId.set(s.id, s);
  const farms = new Map<number, boolean>();
  for (const civ of world.civs) {
    farms.set(civ.id, civ.capabilities.includes("plant_domestication"));
  }

  // One pass: degrade worked cells, recover the rest, and accumulate each
  // settlement's mean soil for the reporting step below.
  const soilSum = new Map<number, { sum: number; n: number }>();
  for (let c = 0; c < grid.land.length; c++) {
    if (grid.land[c] === 0) continue;
    const sid = grid.settlement[c];
    const owner = byId.get(sid);
    const worked = owner !== undefined && (farms.get(owner.civ) ?? false);

    if (worked) {
      const climax = forestClimax(grid.biome[c]);
      const deforested =
        climax > EROSION_MIN_CLIMAX
          ? Math.max(0, (climax - grid.forest[c]) / climax)
          : 0;
      const wear = SOIL_CULTIVATION_WEAR * (1 + SOIL_EROSION_WEIGHT * deforested);
      if (grid.soil[c] > SOIL_FLOOR) {
        grid.soil[c] = Math.max(SOIL_FLOOR, grid.soil[c] - wear);
      }
      report.workedCells++;
    } else if (grid.soil[c] < 1) {
      grid.soil[c] = Math.min(1, grid.soil[c] + SOIL_RECOVERY * (1 - grid.soil[c]));
    }

    if (owner !== undefined) {
      const acc = soilSum.get(sid);
      if (acc) {
        acc.sum += grid.soil[c];
        acc.n++;
      } else {
        soilSum.set(sid, { sum: grid.soil[c], n: 1 });
      }
    }
  }

  // Report a catchment that has worn out — once per decline, in id order so
  // the log is deterministic.
  const settlements = [...world.settlements].sort((a, b) => a.id - b.id);
  for (const s of settlements) {
    const acc = soilSum.get(s.id);
    if (!acc || acc.n === 0) continue;
    const mean = acc.sum / acc.n;
    if (!s.soilStressed && mean < SOIL_STRESS_THRESHOLD) {
      s.soilStressed = true;
      const civ = world.civs.find((c) => c.id === s.civ);
      emit(world, {
        kind: "degradation",
        civ: s.civ,
        cell: s.cell,
        magnitude:
          (SOIL_STRESS_THRESHOLD - mean) / (SOIL_STRESS_THRESHOLD - SOIL_FLOOR),
        fields: { place: s.name, civ: civ?.name ?? "" },
      });
      report.reported.push(s.id);
    } else if (s.soilStressed && mean > SOIL_RECOVERED_THRESHOLD) {
      s.soilStressed = false;
    }
  }

  return report;
}
