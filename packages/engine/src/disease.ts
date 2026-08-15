/**
 * Epidemic disease: the brake that success itself pays for.
 *
 * The demographic layer (`pop.ts`) already carries the endemic background —
 * crowding and density quietly raising each settlement's own mortality. This
 * module is the other thing disease does: the epidemic wave. An outbreak
 * starts in one settlement and travels — through the civ's own settlement
 * network, and across civilisations that are in contact — killing a share of
 * every place it reaches.
 *
 * The mechanism is the point, not a side effect: outbreak chance rises with a
 * settlement's density and with how many peoples its civilisation has met, and
 * spread follows proximity plus contact. A large, dense, connected empire gets
 * struck more often and more widely than a scatter of isolated bands — exactly
 * the anti-snowball asymmetry real history ran on. Nothing here reads who is
 * "winning"; a hermit civilisation the same size would suffer far less.
 *
 * Determinism: every draw comes from a stream keyed by
 * `("plague", world.seed, settlementId, year)`, so no settlement's dice depend
 * on how many draws another settlement consumed, and a seed always replays to
 * the same pandemics. Deaths are applied directly to `ages` (with
 * `refreshCohorts`), never through the population step.
 */

import { emit } from "./events.ts";
import { hashSeed, Rng } from "./rng.ts";
import {
  AGE_SLOTS,
  cellDistance,
  type Civ,
  refreshCohorts,
  type Settlement,
  settlementPop,
  type World,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables. Everything the model can be argued about lives here,
 * named, calibrated against `brakes.test.ts`.
 * ------------------------------------------------------------------ */

/** Crowd disease needs a crowd: below this population a settlement neither
 *  starts nor catches an epidemic. Foraging bands stay clean — epidemics are
 *  something agriculture and density buy. */
export const EPIDEMIC_MIN_POP = 150;

/** Per-settlement-year floor on outbreak chance, before density and contact. */
export const OUTBREAK_BASE_CHANCE = 0.0012;

/** Density term: chance added per unit of `population / OUTBREAK_DENSITY_SCALE`.
 *  A city of 5,000 adds the full increment; a village of 500 a tenth of it. */
export const OUTBREAK_DENSITY_CHANCE = 0.006;
export const OUTBREAK_DENSITY_SCALE = 5000;

/** Contact term: chance added per civilisation this civ has met. Trade routes
 *  are also disease routes — meeting the world raises the odds it makes you
 *  sick. */
export const OUTBREAK_CONTACT_CHANCE = 0.0015;

/** Survivors of a wave carry immunity: within this many years of the last
 *  epidemic a settlement's outbreak and spread chances are multiplied by
 *  `IMMUNITY_SUPPRESSION`. Plagues arrive in waves, not annually. */
export const IMMUNITY_YEARS = 30;
export const IMMUNITY_SUPPRESSION = 0.15;

/** How far one infected settlement can pass the disease in a year, and the
 *  chance per exposed link. Spread crosses civ borders only where the two
 *  civilisations are in contact. */
export const SPREAD_KM = 650;
export const SPREAD_CHANCE = 0.5;

/** Share of a settlement an epidemic kills, before capability relief. */
export const EPIDEMIC_KILL_MIN = 0.06;
export const EPIDEMIC_KILL_MAX = 0.3;

/** Capability relief — read from what the civ holds, never from an era. */
export const SANITATION_OUTBREAK_RELIEF = 0.5; // halves outbreak chance
export const SANITATION_KILL_RELIEF = 0.4; // takes 40% off the death share
export const MEDICINE_KILL_RELIEF = 0.15; // takes 15% off the death share

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export interface DiseaseReport {
  /** Epidemics that broke out this year. */
  outbreaks: number;
  /** Settlement ids struck this year (origin and spread alike). */
  struck: number[];
  /** People killed this year across all epidemics. */
  deaths: number;
}

/** Whether two civilisations are in contact (either has met the other). */
function inContact(a: Civ, b: Civ): boolean {
  return a.id === b.id || a.known.includes(b.id) || b.known.includes(a.id);
}

/** The immunity multiplier a settlement currently enjoys, 1 = fully naive. */
function immunity(s: Settlement, year: number): number {
  if (s.lastPlagueYear === undefined) return 1;
  return year - s.lastPlagueYear < IMMUNITY_YEARS ? IMMUNITY_SUPPRESSION : 1;
}

/**
 * Advance epidemic disease by one year: roll each settlement for an outbreak,
 * spread every outbreak through the settlement network, apply the deaths and
 * write the `plague` events. Mutates settlements and the event log in place.
 */
export function stepDisease(world: World): DiseaseReport {
  const report: DiseaseReport = { outbreaks: 0, struck: [], deaths: 0 };
  const year = world.year;

  const civById = new Map<number, Civ>();
  for (const civ of world.civs) civById.set(civ.id, civ);
  const contactsOf = new Map<number, number>();
  for (const civ of world.civs) contactsOf.set(civ.id, civ.known.length);

  // Stable id order: outbreak draws are per-settlement streams (order-free),
  // but spread claims settlements first-come, so the visit order must be fixed.
  const settlements = [...world.settlements].sort((a, b) => a.id - b.id);
  const infected = new Set<number>();

  for (const origin of settlements) {
    if (infected.has(origin.id)) continue;
    const civ = civById.get(origin.civ);
    if (!civ?.alive) continue;
    const pop = settlementPop(origin);
    if (pop < EPIDEMIC_MIN_POP) continue;

    const rng = new Rng(hashSeed("plague", world.seed, origin.id, year));
    let chance =
      OUTBREAK_BASE_CHANCE +
      OUTBREAK_DENSITY_CHANCE * (pop / OUTBREAK_DENSITY_SCALE) +
      OUTBREAK_CONTACT_CHANCE * (contactsOf.get(civ.id) ?? 0);
    if (civ.capabilities.includes("sanitation")) chance *= SANITATION_OUTBREAK_RELIEF;
    chance *= immunity(origin, year);
    if (!rng.chance(chance)) continue;

    // --- an epidemic begins ---------------------------------------
    report.outbreaks++;
    const severity = rng.range(EPIDEMIC_KILL_MIN, EPIDEMIC_KILL_MAX);

    // Sweep outward: every settlement within reach of an infected one, in the
    // same civ or a contacted one, may catch it this year. Breadth-first with
    // candidates in id order, all draws from the origin's stream.
    const wave: Settlement[] = [origin];
    infected.add(origin.id);
    for (let head = 0; head < wave.length; head++) {
      const from = wave[head];
      for (const t of settlements) {
        if (infected.has(t.id)) continue;
        const tCiv = civById.get(t.civ);
        if (!tCiv?.alive) continue;
        if (settlementPop(t) < EPIDEMIC_MIN_POP) continue;
        const fromCiv = civById.get(from.civ);
        if (!fromCiv || !inContact(fromCiv, tCiv)) continue;
        if (cellDistance(from.cell, t.cell) > SPREAD_KM) continue;
        if (rng.chance(SPREAD_CHANCE * immunity(t, year))) {
          infected.add(t.id);
          wave.push(t);
        }
      }
    }

    // --- the dying, per civilisation ------------------------------
    const byCiv = new Map<number, Settlement[]>();
    for (const s of wave) {
      const arr = byCiv.get(s.civ);
      if (arr) arr.push(s);
      else byCiv.set(s.civ, [s]);
    }

    let originEventId: number | undefined;
    const civIds = [...byCiv.keys()].sort((a, b) =>
      a === origin.civ ? -1 : b === origin.civ ? 1 : a - b,
    );
    for (const civId of civIds) {
      const struck = byCiv.get(civId);
      const c = civById.get(civId);
      if (!struck || !c) continue;

      let kill = severity;
      if (c.capabilities.includes("sanitation")) kill *= 1 - SANITATION_KILL_RELIEF;
      if (c.capabilities.includes("medicine")) kill *= 1 - MEDICINE_KILL_RELIEF;

      let civDeaths = 0;
      for (const s of struck) {
        for (let a = 0; a < AGE_SLOTS; a++) {
          civDeaths += s.ages[a] * kill;
          s.ages[a] -= s.ages[a] * kill;
        }
        refreshCohorts(s);
        s.lastPlagueYear = year;
        report.struck.push(s.id);
      }
      report.deaths += civDeaths;

      // Weight scales with how much of the civilisation this wave carried off:
      // a one-town outbreak in a wide empire is a footnote, a civ-wide wave at
      // full severity is a Black Death. `popTotal` runs post-deaths, so add
      // them back to get the year's starting population.
      const civPopBefore = popTotal(world, civId) + civDeaths;
      const e = emit(world, {
        kind: "plague",
        civ: civId,
        cell: struck[0].cell,
        magnitude: clamp01(civDeaths / civPopBefore / EPIDEMIC_KILL_MAX),
        fields: { civ: c.name },
        causedBy: originEventId !== undefined ? [originEventId] : [],
      });
      if (civId === origin.civ) originEventId = e.id;
    }
  }

  return report;
}

/** Total population of a civ, post-deaths — the denominator for event weight. */
function popTotal(world: World, civId: number): number {
  let total = 0;
  for (const s of world.settlements) {
    if (s.civ === civId) total += settlementPop(s);
  }
  return Math.max(1, total);
}
