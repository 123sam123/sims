/**
 * Demography. People are born, age one year, get sick, go hungry, and die.
 *
 * This is the layer everything else reads from, so it is deterministic, has no
 * IO, never asks an LLM anything, and never calls Math.random. One call
 * advances one settlement by one year.
 *
 * Two modelling decisions are worth knowing before reading the constants.
 *
 * **Age is tracked in single years, not five-year bands.** `Settlement.cohorts`
 * is the 16-band view the rest of the simulation reads, but the state that
 * actually advances is `Settlement.ages`, 80 single-year slots. The tempting
 * cheap alternative — move a fifth of each five-year band up every tick —
 * makes band residence exponentially distributed instead of exactly five
 * years. People then reach the fertile bands years early (measured mean age at
 * entry to "15-19" was 12.6), generation time collapses, and intrinsic growth
 * comes out several times too high; papering over that with harsher mortality
 * lands you at a life expectancy below any human population ever recorded.
 * Eighty float slots cost 640 bytes per settlement and one pass per year.
 *
 * **Stressors multiply hazards, never probabilities.** A 0.148 annual death
 * probability times a famine multiplier of 7 is 1.036 — more than everyone.
 * Every rate below is converted to a hazard once at module load; stressors
 * scale the hazard and the probability comes back out through
 * `1 - exp(-H)`, which is bounded in [0, 1) for any multiplier however brutal.
 *
 * The rates themselves are ordinary pre-modern demography, and because the
 * ageing model is honest they can be read as what they claim to be. Measured
 * off the tables below: total fertility 6.3, 46% of children alive at five,
 * 41% at fifteen, life expectancy at birth 22.4 years, 37% of the population
 * under 15, 4% over 65, mean age 26. A settlement on exactly subsistence
 * rations with no famine, no crowding and no epidemics grows 0.11%/yr;
 * epidemics drag that to a median 0.06%/yr, which is the rate the ticket
 * asks for. Surplus food is what breaks out of it — at 1.3x rations the same
 * settlement grows about 0.5%/yr, which is how farming outruns foraging.
 */

import { hashSeed, Rng } from "./rng.ts";
import {
  AGE_BANDS,
  AGE_SLOTS,
  refreshCohorts,
  type Settlement,
  settlementPop,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunable constants. Everything the model can be argued about lives
 * here, named, so it can be tuned rather than hunted for.
 * ------------------------------------------------------------------ */

/**
 * Annual probability of death at baseline health, by five-year age band.
 * U-shaped: dangerous to be very young, safe in your twenties, dangerous
 * again past sixty. Band 15 is absorbing (75+), so its rate also sets how
 * long the oldest band persists — at 0.17 it settles at ~1% of the
 * population, roughly the size of band 14.
 */
export const BASE_MORTALITY: readonly number[] = [
  0.1425, // 0-4    infancy and early childhood
  0.016, // 5-9
  0.01, // 10-14
  0.012, // 15-19
  0.013, // 20-24
  0.014, // 25-29  childbirth keeps this from being the floor
  0.016, // 30-34
  0.019, // 35-39
  0.023, // 40-44
  0.028, // 45-49
  0.035, // 50-54
  0.045, // 55-59
  0.058, // 60-64
  0.078, // 65-69
  0.105, // 70-74
  0.17, // 75+    absorbing
];

/**
 * Births per woman per year by five-year band, ages 15-44. Natural fertility:
 * nobody is limiting family size, so the curve is biology, not intent. Sums
 * (x5 years) to a total fertility rate of ~6.3, which is what pre-modern
 * populations needed just to replace themselves.
 */
export const AGE_SPECIFIC_FERTILITY: readonly number[] = [
  0.08, // 15-19
  0.28, // 20-24
  0.32, // 25-29
  0.29, // 30-34
  0.21, // 35-39
  0.08, // 40-44
];

/** First fertile band (15-19) and the first age slot in it. */
export const FERTILE_BAND_MIN = 3;
export const FERTILE_AGE_MIN = FERTILE_BAND_MIN * 5;
export const FERTILE_AGE_MAX = (FERTILE_BAND_MIN + AGE_SPECIFIC_FERTILITY.length) * 5;

/** Share of the population that can bear children. */
export const FEMALE_SHARE = 0.5;

/**
 * Relative famine vulnerability by band. Hunger kills the smallest and the
 * oldest first. Note this works *against* the ageing that famine causes —
 * the reason a starved settlement still skews old is the collapse in births,
 * not the pattern of deaths.
 */
export const FAMINE_VULNERABILITY: readonly number[] = [
  2.2, 1.3, 0.95, 0.8, 0.8, 0.8, 0.85, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.4, 2.9,
];

/** Food a person eats in a year, by band. 1.0 = one adult ration. */
export const CONSUMPTION: readonly number[] = [
  0.5, 0.7, 0.9, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.95, 0.9, 0.85, 0.8, 0.75,
];

/** Hazard added at total starvation, before age vulnerability. */
export const STARVATION_HAZARD = 0.85;
/** Hunger bites super-linearly: half rations is far worse than 10% short. */
export const STARVATION_EXPONENT = 2;
/** How sharply conception falls away with hunger. */
export const FAMINE_FERTILITY_EXPONENT = 2.5;

/** Surplus food is how a farming civilisation actually outgrows a foraging one. */
export const SURPLUS_CAP = 1; // ignore food beyond twice subsistence
export const SURPLUS_FERTILITY = 0.35; // +35% births at double rations
export const SURPLUS_HEALTH = 0.2; // -20% mortality at double rations

/**
 * Fertility's response to wealth is guesswork until the economy exists.
 * `prosperity` defaults to neutral, so today this term does nothing; it is
 * here so the economy has one place to tune rather than a new mechanism.
 */
export const PROSPERITY_NEUTRAL = 0.5;
export const PROSPERITY_FERTILITY = 0.2;

/** People one dwelling shelters. */
export const PEOPLE_PER_DWELLING = 5;
/** People a site shelters with no dwellings built — a camp, caves, tents. */
export const DEFAULT_FREE_CAPACITY = 40;
/** Crowding past this is not modelled any further. */
export const CROWDING_MAX = 3;

/** Population at which density alone contributes a full unit of disease load. */
export const DENSITY_SCALE = 5000;
/** Weight of crowding, relative to raw density, in disease load. */
export const CROWDING_DISEASE = 1.2;
/** Mortality multiplier per unit of disease load. */
export const DISEASE_MORTALITY = 0.45;

/** Capability relief. Read from what the civ holds — never from an era number. */
export const SANITATION_RELIEF = 0.6; // of the disease term
export const MEDICINE_RELIEF = 0.12; // of all-cause mortality

/** Year-to-year variation in mortality: hard winters, mild ones. */
export const MORTALITY_NOISE = 0.15;
/** Floor on the yearly shock, so a lucky draw cannot make a year deathless. */
export const MORTALITY_SHOCK_MIN = 0.35;

/** Chance of an epidemic year, before disease load. */
export const EPIDEMIC_BASE_CHANCE = 0.004;
export const EPIDEMIC_LOAD_CHANCE = 0.02;
export const EPIDEMIC_SEVERITY_MIN = 2.5;
export const EPIDEMIC_SEVERITY_MAX = 7;

/**
 * Below this many people a settlement is not a viable community and is
 * emptied. Applies to the settlement total, NEVER per band: a healthy
 * settlement of 120 has under two people in its oldest bands, and flooring
 * those to zero would decapitate the age pyramid every single year.
 */
export const MIN_VIABLE_POPULATION = 4;
/** Below this many people of fertile age, nobody is having children. */
export const MIN_BREEDING_POPULATION = 2;

/** Migration pressure weights. Crowding pushes harder than hunger. */
export const MIGRATION_CROWDING = 0.55;
export const MIGRATION_HUNGER = 0.35;

/* ------------------------------------------------------------------ *
 * Derived tables — computed once, never per call.
 * ------------------------------------------------------------------ */

/** Baseline hazards. Stressors scale these; probabilities come back out via 1-exp(-H). */
const BASE_HAZARD = Float64Array.from(BASE_MORTALITY, (p) => -Math.log(1 - p));

/** Band index for each single year of age. */
const BAND_OF_AGE = Uint8Array.from({ length: AGE_SLOTS }, (_, a) => (a / 5) | 0);

/** Scratch, module-level so a step allocates nothing. Not re-entrant, and the
 *  tick is single-threaded, so that is fine. */
const deathProb = new Float64Array(AGE_BANDS);
const deathProbFed = new Float64Array(AGE_BANDS);

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Guard against a non-finite number reaching state that is persisted forever. */
const finite = (v: number | undefined, fallback: number) =>
  v === undefined || !Number.isFinite(v) ? fallback : v;

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export interface PopContext {
  /** Simulation year. Part of the deterministic key for this step. */
  year: number;
  /** World seed. Part of the deterministic key for this step. */
  seed: number;
  /**
   * Food available to this settlement divided by what it needs — 1.0 is
   * exactly fed. Compute it with `foodDemand(settlement)` BEFORE stepping;
   * the `foodDemand` echoed back in the result is for reporting only, and
   * feeding it into next year's allocation lags every famine by a year.
   */
  foodRatio: number;
  /** Capability ids the owning civilisation holds. */
  capabilities: ReadonlySet<string>;
  /** People the site shelters before any dwelling is built. */
  freeCapacity?: number;
  /** 0..1 material comfort; 0.5 is neutral and is the default. */
  prosperity?: number;
  /** Override year-to-year mortality variation. 0 removes it. */
  mortalityNoise?: number;
  /** Override the chance of an epidemic year. 0 removes epidemics. */
  epidemicChance?: number;
}

export interface PopStep {
  /** Population after the step. */
  population: number;
  births: number;
  deaths: number;
  /** Of `deaths`, those that would not have happened on full rations. */
  starvationDeaths: number;
  /** What this settlement needed to eat this year, in adult rations. */
  foodDemand: number;
  /** 0 when housed, rising to CROWDING_MAX. */
  crowding: number;
  /** 0..1. This settlement wants to send people somewhere else. */
  migrationPressure: number;
  /** An epidemic struck this year. */
  plague: boolean;
}

/**
 * Food this settlement needs for a year, in adult rations. Pure and cheap:
 * call it before `stepPopulation` to work out `foodRatio`.
 */
export function foodDemand(s: Settlement): number {
  let total = 0;
  for (let b = 0; b < AGE_BANDS; b++) total += s.cohorts[b] * CONSUMPTION[b];
  return total;
}

/** Shelter capacity, in people. More housing is always better than less. */
export function shelterCapacity(
  s: Settlement,
  freeCapacity = DEFAULT_FREE_CAPACITY,
): number {
  return freeCapacity + s.housing * PEOPLE_PER_DWELLING;
}

/**
 * Advance one settlement by one year: deaths, births, and one year of ageing.
 * Mutates `settlement.ages` in place and refreshes the `cohorts` view.
 *
 * There is deliberately no `rng` parameter. The stream is derived per
 * settlement-year from the world seed, so the result does not depend on how
 * many settlements were stepped first, how many random draws they happened to
 * consume, or what order the tick visits them in. That is what makes a seed
 * replay to the same history.
 */
export function stepPopulation(s: Settlement, ctx: PopContext): PopStep {
  const rng = new Rng(hashSeed("pop", ctx.seed, s.id, ctx.year));

  // `ages` is authoritative; resync the view first so a caller that seeded or
  // edited ages directly cannot make this step read a stale pyramid.
  refreshCohorts(s);
  const popBefore = settlementPop(s);
  const demand = foodDemand(s);

  // --- stressors ---------------------------------------------------
  // A NaN or Infinity arriving from an upstream system (a food ratio computed
  // as 0/0 for a settlement with nobody in it, say) would poison `ages`
  // irreversibly and then be written straight into a saved world, so every
  // numeric input is forced back to something finite at the boundary.
  const foodRatio = Math.max(0, finite(ctx.foodRatio, 1));
  const hunger = clamp(1 - foodRatio, 0, 1);
  const surplus = clamp(foodRatio - 1, 0, SURPLUS_CAP);

  const capacity = shelterCapacity(
    s,
    Math.max(0, finite(ctx.freeCapacity, DEFAULT_FREE_CAPACITY)),
  );
  const crowding =
    capacity > 0 ? clamp(popBefore / capacity - 1, 0, CROWDING_MAX) : CROWDING_MAX;

  const diseaseLoad = popBefore / DENSITY_SCALE + CROWDING_DISEASE * crowding;
  const sanitation = ctx.capabilities.has("sanitation") ? SANITATION_RELIEF : 0;
  const medicine = ctx.capabilities.has("medicine") ? MEDICINE_RELIEF : 0;

  let healthMult =
    (1 + DISEASE_MORTALITY * diseaseLoad * (1 - sanitation)) *
    (1 - medicine) *
    (1 - SURPLUS_HEALTH * surplus);

  const noise = Math.max(0, finite(ctx.mortalityNoise, MORTALITY_NOISE));
  if (noise > 0) healthMult *= Math.max(MORTALITY_SHOCK_MIN, 1 + rng.normal() * noise);

  const epidemicChance = clamp(
    finite(ctx.epidemicChance, EPIDEMIC_BASE_CHANCE + EPIDEMIC_LOAD_CHANCE * diseaseLoad),
    0,
    1,
  );
  const plague = epidemicChance > 0 && rng.chance(epidemicChance);
  if (plague) healthMult *= rng.range(EPIDEMIC_SEVERITY_MIN, EPIDEMIC_SEVERITY_MAX);

  // Starvation is a separate cause of death, so it ADDS hazard rather than
  // scaling what is already there — otherwise a famine would somehow spare a
  // population that was healthy to begin with.
  const famineHazard = hunger > 0 ? STARVATION_HAZARD * hunger ** STARVATION_EXPONENT : 0;

  for (let b = 0; b < AGE_BANDS; b++) {
    const fed = BASE_HAZARD[b] * healthMult;
    deathProbFed[b] = 1 - Math.exp(-fed);
    deathProb[b] =
      famineHazard > 0
        ? 1 - Math.exp(-(fed + famineHazard * FAMINE_VULNERABILITY[b]))
        : deathProbFed[b];
  }

  // --- deaths ------------------------------------------------------
  let deaths = 0;
  let starvationDeaths = 0;
  for (let a = 0; a < AGE_SLOTS; a++) {
    const n = s.ages[a];
    if (n <= 0) continue;
    const b = BAND_OF_AGE[a];
    const d = n * deathProb[b];
    deaths += d;
    starvationDeaths += n * (deathProb[b] - deathProbFed[b]);
    s.ages[a] = n - d;
  }

  // --- births ------------------------------------------------------
  // Read from the survivors of this year's mortality, before ageing, so that
  // turning 15 does not also make you a parent in the same tick.
  let fertileStock = 0;
  let births = 0;
  for (let a = FERTILE_AGE_MIN; a < FERTILE_AGE_MAX; a++) {
    const n = s.ages[a];
    fertileStock += n;
    births += n * AGE_SPECIFIC_FERTILITY[BAND_OF_AGE[a] - FERTILE_BAND_MIN];
  }
  births *= FEMALE_SHARE;

  if (fertileStock * FEMALE_SHARE < MIN_BREEDING_POPULATION) {
    // Continuous cohorts will otherwise breed a settlement back from a
    // fraction of a person, which over ten thousand years happens constantly.
    births = 0;
  } else {
    const prosperity =
      clamp(finite(ctx.prosperity, PROSPERITY_NEUTRAL), 0, 1) - PROSPERITY_NEUTRAL;
    const fertilityMult =
      (foodRatio < 1 ? Math.min(1, foodRatio) ** FAMINE_FERTILITY_EXPONENT : 1) *
      (1 + SURPLUS_FERTILITY * surplus) *
      (1 + PROSPERITY_FERTILITY * prosperity);
    births *= Math.max(0, fertilityMult);
  }

  // --- one year of ageing -----------------------------------------
  // The oldest slot is absorbing: it is "75-79 and everyone older".
  s.ages[AGE_SLOTS - 1] += s.ages[AGE_SLOTS - 2];
  for (let a = AGE_SLOTS - 2; a >= 1; a--) s.ages[a] = s.ages[a - 1];
  s.ages[0] = births;

  // --- viability ---------------------------------------------------
  let population = 0;
  for (let a = 0; a < AGE_SLOTS; a++) population += s.ages[a];
  if (population < MIN_VIABLE_POPULATION) {
    // The remnant is counted as dead rather than silently deleted, so
    // `population === before - deaths + births` holds even here.
    deaths += population;
    s.ages.fill(0);
    population = 0;
  }

  refreshCohorts(s);

  return {
    population,
    births,
    deaths,
    starvationDeaths,
    foodDemand: demand,
    crowding,
    migrationPressure: clamp(
      MIGRATION_CROWDING * crowding + MIGRATION_HUNGER * hunger,
      0,
      1,
    ),
    plague,
  };
}
