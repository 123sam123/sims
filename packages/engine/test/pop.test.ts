import assert from "node:assert/strict";
import test from "node:test";
import {
  AGE_SPECIFIC_FERTILITY,
  BASE_MORTALITY,
  DEFAULT_FREE_CAPACITY,
  FERTILE_AGE_MAX,
  FERTILE_AGE_MIN,
  foodDemand,
  type PopContext,
  shelterCapacity,
  stepPopulation,
} from "../src/pop.ts";
import {
  AGE_BANDS,
  AGE_SLOTS,
  refreshCohorts,
  type Settlement,
  seedAges,
  settlementPop,
} from "../src/types.ts";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** The shape worldgen seeds a founding camp with: young, because life is short. */
const CAMP_SHAPE = [22, 19, 16, 14, 12, 10, 9, 7, 5, 3, 2, 1, 0.5, 0.2, 0.1, 0];
const NO_CAPABILITIES: ReadonlySet<string> = new Set();

function settlement(pop = 120, housing = 200, id = 1): Settlement {
  const s: Settlement = {
    id,
    civ: 0,
    cell: 0,
    name: "test",
    founded: 0,
    ages: seedAges(CAMP_SHAPE, pop),
    cohorts: new Float64Array(AGE_BANDS),
    housing,
    buildings: {},
    unrest: 0,
    lastHarvest: 1,
  };
  refreshCohorts(s);
  return s;
}

function ctx(over: Partial<PopContext> = {}): PopContext {
  return { year: 0, seed: 1, foodRatio: 1, capabilities: NO_CAPABILITIES, ...over };
}

/**
 * Run a settlement forward, rescaling to a constant size each year so it settles
 * into its stable age structure without the measurement being swamped by growth.
 * Standard demographic practice: the seeded pyramid is not the stable one, and
 * the transient off it is worth ~0.1 pp/yr — more than the whole target band.
 */
function burnIn(
  s: Settlement,
  seed: number,
  years = 300,
  over: Partial<PopContext> = {},
): void {
  const size = settlementPop(s);
  for (let y = 0; y < years; y++) {
    stepPopulation(s, ctx({ year: y, seed, ...over }));
    const total = settlementPop(s);
    if (total <= 0) throw new Error("settlement died during burn-in");
    for (let a = 0; a < AGE_SLOTS; a++) s.ages[a] *= size / total;
    refreshCohorts(s);
  }
}

/**
 * Annualised growth rate over `years`, starting from the stable age structure.
 * Throws rather than returning a sentinel if the settlement dies out — every
 * caller here is measuring a settlement that is supposed to survive.
 */
function growthRate(seed: number, years: number, over: Partial<PopContext> = {}): number {
  const s = settlement();
  burnIn(s, seed);
  const before = settlementPop(s);
  for (let y = 0; y < years; y++)
    stepPopulation(s, ctx({ year: 300 + y, seed, ...over }));
  const after = settlementPop(s);
  if (after <= 0) throw new Error(`settlement died out at seed ${seed}`);
  return (after / before) ** (1 / years) - 1;
}

/** Population-weighted mean band index — the settlement's age in one number. */
function meanBand(s: Settlement): number {
  const pop = settlementPop(s);
  let m = 0;
  for (let b = 0; b < AGE_BANDS; b++) m += (s.cohorts[b] / pop) * b;
  return m;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/* ------------------------------------------------------------------ *
 * Growth
 * ------------------------------------------------------------------ */

test("intrinsic growth without noise or epidemics is a plausible pre-modern rate", () => {
  // Exact: no random draws are taken at all, so this cannot flake. It is the
  // structural guard — an ageing or hazard regression moves it immediately.
  const r = growthRate(1, 500, { mortalityNoise: 0, epidemicChance: 0 });
  assert.ok(
    r > 0.0007 && r < 0.0015,
    `epidemic-free growth ${(r * 100).toFixed(4)}%/yr outside 0.07-0.15%/yr`,
  );
});

test("a well-fed settlement of 120 grows at 0.04-0.1%/yr over centuries", () => {
  // The ticket's own acceptance figure, measured on the full stochastic model.
  // Median over many seeds: per-seed spread is ~0.05 pp because epidemics are
  // rare and heavy, so one seed says nothing. 256 seeds puts the standard
  // error of the median near 0.004 pp, an order of magnitude inside the band.
  const rates: number[] = [];
  for (let i = 0; i < 256; i++) rates.push(growthRate(2000 + i, 400));
  const m = median(rates);
  assert.ok(
    m >= 0.0004 && m <= 0.001,
    `median growth ${(m * 100).toFixed(4)}%/yr outside the ticket's 0.04-0.1%/yr`,
  );
});

test("epidemics measurably drag long-run growth below the epidemic-free rate", () => {
  const clean = growthRate(1, 500, { mortalityNoise: 0, epidemicChance: 0 });
  const rates: number[] = [];
  for (let i = 0; i < 128; i++) rates.push(growthRate(3000 + i, 400));
  assert.ok(
    median(rates) < clean,
    "a world with plagues should not grow as fast as one without",
  );
});

test("food surplus is what lets a farming settlement outgrow a foraging one", () => {
  const subsistence = growthRate(7, 300, { mortalityNoise: 0, epidemicChance: 0 });
  const surplus = growthRate(7, 300, {
    foodRatio: 1.3,
    mortalityNoise: 0,
    epidemicChance: 0,
  });
  assert.ok(
    surplus > subsistence * 3,
    `surplus ${surplus} should far exceed ${subsistence}`,
  );
  assert.ok(surplus < 0.02, "even abundant food should not give modern growth rates");
});

/* ------------------------------------------------------------------ *
 * Age structure
 * ------------------------------------------------------------------ */

test("the stable age structure is a pre-industrial pyramid", () => {
  // The test that catches an ageing-model regression. A model that lets people
  // skip up the pyramid produces a plausible growth rate with an implausible
  // shape, so growth alone is not enough of a guard.
  // Deterministic: the stable structure is a property of the vital rates, and
  // a recent plague year would leave a hole in the pyramid that is real but
  // has nothing to do with what this test is checking.
  const quiet = { mortalityNoise: 0, epidemicChance: 0 };
  const s = settlement();
  burnIn(s, 4, 800, quiet);
  const pop = settlementPop(s);

  let under15 = 0;
  let over65 = 0;
  for (let a = 0; a < AGE_SLOTS; a++) {
    if (a < 15) under15 += s.ages[a];
    if (a >= 65) over65 += s.ages[a];
  }
  assert.ok(
    under15 / pop > 0.32 && under15 / pop < 0.42,
    `under-15 share ${(under15 / pop).toFixed(3)} is not pre-industrial`,
  );
  assert.ok(
    over65 / pop > 0.025 && over65 / pop < 0.06,
    `over-65 share ${(over65 / pop).toFixed(3)} is not pre-industrial`,
  );

  // Every band should be smaller than the one below it: nobody gets younger.
  for (let b = 1; b < AGE_BANDS; b++) {
    assert.ok(
      s.cohorts[b] < s.cohorts[b - 1],
      `band ${b} is not smaller than band ${b - 1}`,
    );
  }
});

test("the absorbing 75+ band reaches a steady state instead of piling up", () => {
  const s = settlement();
  burnIn(s, 4, 1500, { mortalityNoise: 0, epidemicChance: 0 });
  const share = s.cohorts[AGE_BANDS - 1] / settlementPop(s);
  assert.ok(
    share > 0.002 && share < 0.03,
    `75+ share ${share.toFixed(4)} is implausible`,
  );
});

/* ------------------------------------------------------------------ *
 * Mortality
 * ------------------------------------------------------------------ */

test("infants die at more than 5x the rate of adults in their late twenties", () => {
  // Measured from realised deaths, not read off the constant table: a
  // settlement holding only one band reports that band's death rate directly.
  const only = (band: number) => {
    const shape = new Array(AGE_BANDS).fill(0);
    shape[band] = 1;
    const s = settlement(100, 200, 2);
    s.ages.set(seedAges(shape, 100));
    refreshCohorts(s);
    const r = stepPopulation(s, ctx({ mortalityNoise: 0, epidemicChance: 0 }));
    return r.deaths / 100;
  };
  const infant = only(0);
  const prime = only(5);
  assert.ok(
    infant > prime * 5,
    `infant ${infant.toFixed(4)} vs prime ${prime.toFixed(4)}`,
  );
  // and the constants they come from agree
  assert.ok(BASE_MORTALITY[0] > BASE_MORTALITY[5] * 5);
});

test("stressors never drive a cohort negative, however extreme", () => {
  const s = settlement(4000, 1, 3);
  for (let y = 0; y < 40; y++) {
    const r = stepPopulation(
      s,
      ctx({ year: y, seed: 9, foodRatio: 0, freeCapacity: 0, epidemicChance: 1 }),
    );
    for (let a = 0; a < AGE_SLOTS; a++) {
      assert.ok(
        Number.isFinite(s.ages[a]) && s.ages[a] >= 0,
        `slot ${a} = ${s.ages[a]} in year ${y}`,
      );
    }
    assert.ok(r.deaths >= 0 && r.births >= 0 && r.population >= 0);
    if (r.population === 0) return;
  }
  assert.fail("total famine at four times shelter capacity should empty a settlement");
});

test("sanitation and medicine lower the death rate, and only where they should", () => {
  // Held at a fixed population so relief is not confounded by the extra people
  // a healthier settlement goes on to produce.
  const crudeDeathRate = (capabilities: string[], pop: number, housing: number) => {
    const s = settlement(pop, housing, 3);
    let sum = 0;
    const years = 200;
    for (let y = 0; y < years; y++) {
      const before = settlementPop(s);
      const r = stepPopulation(
        s,
        ctx({
          year: y,
          seed: 13,
          capabilities: new Set(capabilities),
          mortalityNoise: 0,
          epidemicChance: 0,
        }),
      );
      sum += r.deaths / before;
      const total = settlementPop(s);
      for (let a = 0; a < AGE_SLOTS; a++) s.ages[a] *= pop / total;
      refreshCohorts(s);
    }
    return sum / years;
  };

  const cityNone = crudeDeathRate([], 12000, 2600);
  assert.ok(
    crudeDeathRate(["sanitation"], 12000, 2600) < cityNone * 0.9,
    "sanitation in a city",
  );
  assert.ok(
    crudeDeathRate(["medicine"], 12000, 2600) < cityNone * 0.95,
    "medicine in a city",
  );
  assert.ok(
    crudeDeathRate(["sanitation", "medicine"], 12000, 2600) < cityNone * 0.8,
    "both together",
  );

  // Sanitation acts on crowding and density, so in a hamlet it should barely
  // register — that is the point of reading capabilities instead of an era.
  const campNone = crudeDeathRate([], 120, 200);
  const campSanitation = crudeDeathRate(["sanitation"], 120, 200);
  assert.ok(
    campSanitation > campNone * 0.97,
    "sanitation should hardly matter in a hamlet",
  );
});

/* ------------------------------------------------------------------ *
 * Famine
 * ------------------------------------------------------------------ */

test("a decade of famine shrinks a settlement and leaves it older", () => {
  const starved = settlement();
  burnIn(starved, 5);
  const popBefore = settlementPop(starved);
  const ageBefore = meanBand(starved);

  let starvationDeaths = 0;
  for (let y = 0; y < 10; y++) {
    const r = stepPopulation(starved, ctx({ year: 300 + y, seed: 5, foodRatio: 0.6 }));
    starvationDeaths += r.starvationDeaths;
  }

  assert.ok(
    settlementPop(starved) < popBefore * 0.7,
    `famine left ${settlementPop(starved).toFixed(1)} of ${popBefore.toFixed(1)}`,
  );
  assert.ok(
    meanBand(starved) > ageBefore + 0.3,
    `mean band ${ageBefore.toFixed(2)} -> ${meanBand(starved).toFixed(2)} is not older`,
  );
  assert.ok(starvationDeaths > 0, "starvation deaths should be attributed");

  // The same decade with food behind it does none of that.
  const fed = settlement();
  burnIn(fed, 5);
  const fedAge = meanBand(fed);
  for (let y = 0; y < 10; y++) stepPopulation(fed, ctx({ year: 300 + y, seed: 5 }));
  assert.ok(
    settlementPop(fed) > popBefore * 0.95,
    "a fed settlement should hold its numbers",
  );
  assert.ok(Math.abs(meanBand(fed) - fedAge) < 0.15, "a fed settlement should not age");
});

test("starvation deaths are zero on full rations and rise as food runs short", () => {
  const at = (foodRatio: number) => {
    const s = settlement();
    burnIn(s, 6);
    return stepPopulation(s, ctx({ year: 300, seed: 6, foodRatio, mortalityNoise: 0 }))
      .starvationDeaths;
  };
  assert.equal(at(1), 0);
  assert.equal(at(1.4), 0);
  assert.ok(at(0.8) > 0);
  assert.ok(at(0.5) > at(0.8));
});

test("hunger suppresses births far more sharply than it raises deaths", () => {
  const at = (foodRatio: number) => {
    const s = settlement();
    burnIn(s, 6);
    return stepPopulation(s, ctx({ year: 300, seed: 6, foodRatio, mortalityNoise: 0 }));
  };
  const fed = at(1);
  const hungry = at(0.7);
  assert.ok(hungry.births < fed.births * 0.7, "births should collapse under hunger");
  assert.ok(hungry.deaths > fed.deaths, "deaths should rise under hunger");
});

/* ------------------------------------------------------------------ *
 * Determinism
 * ------------------------------------------------------------------ */

test("the same seed replays to byte-identical cohorts after 500 years", () => {
  const run = () => {
    const s = settlement();
    for (let y = 0; y < 500; y++) {
      stepPopulation(s, ctx({ year: y, seed: 0xc0ffee, foodRatio: 1.05 }));
    }
    return s;
  };
  // Two live runs, never a stored fixture: floating-point results are stable
  // within a build but not guaranteed across engine versions.
  const a = run();
  const b = run();
  assert.deepEqual(Array.from(a.ages), Array.from(b.ages));
  assert.deepEqual(Array.from(a.cohorts), Array.from(b.cohorts));
  assert.ok(settlementPop(a) > 0);
});

test("a settlement's history does not depend on what else the tick stepped first", () => {
  // No Rng is threaded through the caller, so stepping order cannot leak in.
  const target = () => settlement(120, 200, 42);
  const others = [settlement(300, 60, 7), settlement(80, 20, 8)];

  const alone = target();
  for (let y = 0; y < 200; y++) stepPopulation(alone, ctx({ year: y, seed: 5150 }));

  const amongst = target();
  for (let y = 0; y < 200; y++) {
    for (const o of others) stepPopulation(o, ctx({ year: y, seed: 5150 }));
    stepPopulation(amongst, ctx({ year: y, seed: 5150 }));
  }
  assert.deepEqual(Array.from(amongst.ages), Array.from(alone.ages));
});

test("different seeds and different settlements diverge", () => {
  const run = (seed: number, id: number) => {
    const s = settlement(120, 200, id);
    for (let y = 0; y < 200; y++) stepPopulation(s, ctx({ year: y, seed }));
    return settlementPop(s);
  };
  assert.notEqual(run(1, 1), run(2, 1));
  assert.notEqual(run(1, 1), run(1, 2));
});

/* ------------------------------------------------------------------ *
 * Bookkeeping
 * ------------------------------------------------------------------ */

test("population only ever changes by births minus deaths", () => {
  const s = settlement();
  burnIn(s, 11);
  for (let y = 0; y < 300; y++) {
    const before = settlementPop(s);
    const r = stepPopulation(s, ctx({ year: 300 + y, seed: 11, foodRatio: 1.1 }));
    assert.ok(
      Math.abs(r.population - (before - r.deaths + r.births)) < 1e-9,
      `year ${y}: ${r.population} != ${before} - ${r.deaths} + ${r.births}`,
    );
  }
});

test("the books still balance on the year a settlement dies out", () => {
  // The viability floor must report the remnant as dead, not quietly delete it,
  // or the tick's death accounting goes wrong on exactly the year that matters.
  const s = settlement(6, 200, 34);
  for (let y = 0; y < 200; y++) {
    const before = settlementPop(s);
    const r = stepPopulation(s, ctx({ year: y, seed: 35, foodRatio: 0.3 }));
    assert.ok(
      Math.abs(r.population - (before - r.deaths + r.births)) < 1e-9,
      `year ${y}: ${r.population} != ${before} - ${r.deaths} + ${r.births}`,
    );
    if (r.population === 0) return;
  }
  assert.fail("six people on a third rations should not last two centuries");
});

test("the cohorts view stays in step with the authoritative ages", () => {
  const s = settlement();
  for (let y = 0; y < 50; y++) stepPopulation(s, ctx({ year: y, seed: 3 }));
  for (let b = 0; b < AGE_BANDS; b++) {
    let sum = 0;
    for (let a = b * 5; a < b * 5 + 5; a++) sum += s.ages[a];
    assert.ok(Math.abs(s.cohorts[b] - sum) < 1e-12, `band ${b}`);
  }
  assert.equal(s.ages.length, AGE_SLOTS);
  assert.equal(s.cohorts.length, AGE_BANDS);
});

test("a settlement below the viability floor is emptied, not left in fractions", () => {
  const s = settlement(5, 200, 12);
  for (let y = 0; y < 200; y++) {
    const r = stepPopulation(s, ctx({ year: y, seed: 4, foodRatio: 0.2 }));
    if (r.population === 0) {
      assert.ok(
        s.ages.every((v) => v === 0),
        "an emptied settlement should hold no fractional people",
      );
      return;
    }
  }
  assert.fail("a settlement of five on a fifth rations should not survive two centuries");
});

test("nobody is born once the fertile population is gone", () => {
  const s = settlement(120, 200, 13);
  // Wipe everyone of childbearing age.
  for (let a = FERTILE_AGE_MIN; a < FERTILE_AGE_MAX; a++) s.ages[a] = 0;
  refreshCohorts(s);
  const r = stepPopulation(s, ctx({ seed: 2 }));
  assert.equal(r.births, 0);
});

test("food demand counts children and the very old as smaller mouths", () => {
  const children = settlement(100, 200, 14);
  children.ages.set(seedAges([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 100));
  refreshCohorts(children);

  const adults = settlement(100, 200, 15);
  adults.ages.set(seedAges([0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 100));
  refreshCohorts(adults);

  assert.ok(foodDemand(children) < foodDemand(adults));
  assert.equal(foodDemand(adults), 100);
  assert.equal(foodDemand(settlement(0, 200, 16)), 0);
});

test("food demand is reported for the population that was actually fed", () => {
  // The demand echoed back must match what foodDemand() said before the step,
  // or a caller that trusts it will always be feeding last year's settlement.
  const s = settlement();
  burnIn(s, 17);
  const expected = foodDemand(s);
  const r = stepPopulation(s, ctx({ year: 300, seed: 17 }));
  assert.ok(Math.abs(r.foodDemand - expected) < 1e-9);
});

test("a non-finite number from an upstream system cannot poison the population", () => {
  // NaN in `ages` is unrecoverable and would be written straight into a saved
  // world, so the context boundary has to absorb it rather than propagate it.
  const s = settlement();
  const junk = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let year = 0;
  for (const bad of junk) {
    stepPopulation(
      s,
      ctx({
        year: year++,
        seed: 31,
        foodRatio: bad,
        prosperity: bad,
        freeCapacity: bad,
        mortalityNoise: bad,
        epidemicChance: bad,
      }),
    );
    for (let a = 0; a < AGE_SLOTS; a++) {
      assert.ok(Number.isFinite(s.ages[a]), `slot ${a} went non-finite on ${bad}`);
    }
  }
  assert.ok(settlementPop(s) > 0, "junk input should not wipe the settlement out");

  // A NaN housing count must not silently read as roomy either.
  const broken = settlement(500, Number.NaN, 32);
  const r = stepPopulation(broken, ctx({ seed: 33 }));
  assert.ok(Number.isFinite(r.crowding) && r.crowding > 0);
  assert.ok(Number.isFinite(r.migrationPressure));
});

/* ------------------------------------------------------------------ *
 * Crowding and pressure
 * ------------------------------------------------------------------ */

test("more housing is always better, and a site shelters some people unbuilt", () => {
  const s = settlement(120, 0, 18);
  assert.equal(shelterCapacity(s), DEFAULT_FREE_CAPACITY);
  let previous = shelterCapacity(s);
  for (const housing of [1, 10, 100]) {
    s.housing = housing;
    const capacity = shelterCapacity(s);
    assert.ok(capacity > previous, "building a dwelling must never make things worse");
    previous = capacity;
  }
});

test("crowding and hunger both push people to leave", () => {
  const roomy = settlement(120, 200, 19);
  const packed = settlement(1200, 20, 20);
  const roomyStep = stepPopulation(roomy, ctx({ seed: 21 }));
  const packedStep = stepPopulation(packed, ctx({ seed: 21 }));
  assert.equal(roomyStep.crowding, 0);
  assert.equal(roomyStep.migrationPressure, 0);
  assert.ok(packedStep.crowding > 0);
  assert.ok(packedStep.migrationPressure > roomyStep.migrationPressure);

  const hungry = settlement(120, 200, 22);
  const hungryStep = stepPopulation(hungry, ctx({ seed: 21, foodRatio: 0.5 }));
  assert.ok(hungryStep.migrationPressure > 0);
  assert.ok(hungryStep.migrationPressure <= 1);
});

test("crowding raises the death rate and sanitation takes most of it back", () => {
  const deathRate = (housing: number, capabilities: string[]) => {
    const s = settlement(3000, housing, 23);
    const before = settlementPop(s);
    return (
      stepPopulation(
        s,
        ctx({
          seed: 24,
          capabilities: new Set(capabilities),
          mortalityNoise: 0,
          epidemicChance: 0,
        }),
      ).deaths / before
    );
  };
  const roomy = deathRate(700, []);
  const packed = deathRate(100, []);
  assert.ok(packed > roomy * 1.2, "crowding should hurt");
  assert.ok(
    deathRate(100, ["sanitation"]) < packed * 0.85,
    "sanitation should help most here",
  );
});

/* ------------------------------------------------------------------ *
 * Constants sanity
 * ------------------------------------------------------------------ */

test("the vital-rate tables are the right shape and plausible", () => {
  assert.equal(BASE_MORTALITY.length, AGE_BANDS);
  assert.equal(AGE_SPECIFIC_FERTILITY.length, (FERTILE_AGE_MAX - FERTILE_AGE_MIN) / 5);
  assert.ok(BASE_MORTALITY.every((m) => m > 0 && m < 1));

  // Mortality is U-shaped: it falls through childhood then climbs for good.
  const trough = BASE_MORTALITY.indexOf(Math.min(...BASE_MORTALITY));
  for (let b = 1; b <= trough; b++) assert.ok(BASE_MORTALITY[b] <= BASE_MORTALITY[b - 1]);
  for (let b = trough + 1; b < AGE_BANDS; b++) {
    assert.ok(BASE_MORTALITY[b] > BASE_MORTALITY[b - 1]);
  }

  // Natural fertility: a total fertility rate near six or seven births.
  const tfr = 5 * AGE_SPECIFIC_FERTILITY.reduce((a, b) => a + b, 0);
  assert.ok(tfr > 5.5 && tfr < 7.5, `TFR ${tfr}`);
});
