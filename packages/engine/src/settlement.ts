/**
 * Settlements: founding, growth, migration, territory and abandonment.
 *
 * Nobody places a city. People go where food, water and safety are, and a
 * village becomes a town because it kept being worth staying. This module is
 * the layer that makes that happen on its own, driven only by the physical
 * world (`grid`) and population pressure (`pop.ts`) — no LLM, no agent input.
 *
 * `stepSettlements(world)` advances every civ's settlements by one year:
 *
 *   1. Territory grows one ring outward from what a civ already holds, gated by
 *      a finite administrative reach measured from its largest settlement — the
 *      anti-snowball brake, so an empire cannot claim the globe from one capital.
 *   2. Every owned land cell is assigned to the settlement that works it, which
 *      gives each settlement a catchment and therefore a local carrying capacity.
 *   3. Each settlement's population is stepped against that capacity: a place
 *      well under its carrying capacity runs a food surplus and grows; a place
 *      over it goes hungry and sheds people. This module owns the population
 *      call precisely because migration — the release valve for that pressure —
 *      is the settlement layer's job (see `population.md`).
 *   4. Bands that cannot yet settle (no `settlement` capability) relocate their
 *      camp toward better foraging instead of founding anything.
 *   5. Saturated settlements found a colony at the best nearby site, or send
 *      people to a sibling with room.
 *   6. Overextension: settlements far from the capital, measured against an
 *      administrative reach that grows with governance capabilities, accrue
 *      unrest — and a settlement that boils over secedes, taking its people
 *      and its land out of the civilisation. Corruption and revolt are the
 *      failure mode of empire here, not a hard territory cap.
 *   7. A settlement whose local food supply collapses for `ABANDON_YEARS`
 *      running — or that simply empties out — is abandoned and its land freed.
 *
 * Determinism: the only stochastic input is a per-civ-per-year stream from
 * `hashSeed("settle", civId, year)`, and population uses its own per-settlement
 * stream, so a seed always replays to the same map. Settlements are persistent
 * objects with stable ids; they are never recreated tick to tick.
 */

import { emit } from "./events.ts";
import { foodDemand, PEOPLE_PER_DWELLING, stepPopulation } from "./pop.ts";
import { hashSeed, Rng } from "./rng.ts";
import {
  AGE_SLOTS,
  BIOMES,
  cellDistance,
  cellX,
  cellY,
  type Civ,
  type Grid,
  GRID_H,
  GRID_W,
  neighbors,
  refreshCohorts,
  type Settlement,
  settlementPop,
  type World,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunable constants. Everything the model can be argued about lives
 * here, named, calibrated against `settlement.test.ts`.
 * ------------------------------------------------------------------ */

/* --- Local carrying capacity ------------------------------------- *
 * How many people a settlement's land can feed. This is what a place
 * grows toward and shrinks back to; it is distinct from the civ-wide
 * grain store that `production.ts` keeps. A small settlement on rich
 * land sits far below capacity, so it runs a surplus and grows; as it
 * fills the land the surplus vanishes and growth stalls. */

/** People one fully-fertile cell feeds by foraging — extensive, thin. */
export const FORAGE_CAPACITY_PER_CELL = 60;
/** People one fully-fertile cell feeds once farmed — intensive, dense. */
export const FARM_CAPACITY_PER_CELL = 190;
/** Ratio handed to the population step is capped here: beyond twice
 *  subsistence the demographic model rewards nothing more. */
export const FOOD_RATIO_MAX = 2;
/** Guard against dividing capacity by a near-zero demand. */
const MIN_DEMAND = 1;

/* --- Territory: reach is finite ---------------------------------- */

/** Distance decay: a settlement's claim fades to nothing past this. */
export const TERRITORY_RADIUS_KM = 480;
/** Administrative reach from the civ's largest settlement. Nothing is
 *  claimed or founded beyond it — expansion is NOT free. */
export const ADMIN_REACH_KM = 1900;
/** Governance capabilities stretch how far a capital can administer: writing
 *  carries orders, roads carry them faster, law and coin make distant deputies
 *  behave. Each entry is a fractional bonus on `ADMIN_REACH_KM`. */
export const ADMIN_REACH_BONUS: Record<string, number> = {
  writing: 0.35,
  roads: 0.3,
  law_code: 0.25,
  currency: 0.15,
};

/* --- Overextension: unrest and secession --------------------------- *
 * Reach is not a wall; it is where governance thins out. A settlement
 * past `UNREST_STRAIN_FLOOR` of its civ's reach accrues unrest year on
 * year, a hungry one accrues more, and a settlement that boils over can
 * secede — taking its people and its catchment out of the civilisation.
 * This is the overextension brake: the price of empire is paid at the
 * rim, in revolt, with the cause written into the event log. */

/** Strain (distance / reach) below which the capital's grip is comfortable. */
export const UNREST_STRAIN_FLOOR = 0.55;
/** Unrest accrued per year per unit of strain beyond the floor. */
export const UNREST_STRAIN_RATE = 0.15;
/** Extra unrest per year at total local food collapse — hunger radicalises. */
export const UNREST_HUNGER_RATE = 0.03;
/** How much a fully legitimate government damps unrest accrual. */
export const UNREST_LEGITIMACY_RELIEF = 0.5;
/** Unrest that fades per year wherever grievance is not actively fed. */
export const UNREST_DECAY = 0.02;
/** Crossing this upward puts a standing unrest report in the log. */
export const UNREST_EVENT_THRESHOLD = 0.6;
/** Falling back below this clears the standing report (hysteresis). */
export const UNREST_CLEAR_THRESHOLD = 0.4;
/** At boiling point (unrest ~1), the yearly chance the place actually rises. */
export const SECESSION_CHANCE = 0.12;
/** A frontier cell is claimed when reach × distance-decay clears this. A civ
 *  controls its whole reachable region — the good land and the marginal land
 *  between its settlements — not only the fertile cells. Its cities then visibly
 *  cluster on the best of that land. */
export const CLAIM_THRESHOLD = 0.08;

/* --- Founding: where a colony goes -------------------------------- */

/** A settlement must exceed this before it can bud a colony. */
export const FOUND_MIN_POP = 260;
/** ...and be this full of its own land (population / capacity). */
export const FOUND_SATURATION = 0.45;
/** ...and even then only tries in a given year with this chance, so colonies
 *  are founded now and then rather than the instant a site opens up. Also
 *  keeps the site search — the module's one expensive step — occasional. */
export const FOUND_ATTEMPT_CHANCE = 0.1;
/** Share of a saturated settlement that leaves to found the colony. */
export const FOUND_MIGRANT_SHARE = 0.35;
/** How far a colony will look for a site. */
export const FOUND_SEARCH_RADIUS_KM = 520;
/** ...but never closer than this to any existing settlement, so sites
 *  spread across the good land instead of clumping. */
export const FOUND_MIN_SPACING_KM = 240;

/** Founding needs land good enough to keep — this floor keeps deserts,
 *  ice, tundra, taiga and bare mountain empty of settlements for good, and
 *  is what makes cities sit well above their territory's median fertility. */
export const SITE_MIN_FERTILITY = 0.35;
/** A site must score at least this to be worth founding. */
export const MIN_SITE_SCORE = 0.5;

/** Site-score weights. Fertility and fresh water dominate; the rest tilt. */
export const SITE_FERTILITY_WEIGHT = 1;
export const SITE_RIVER_WEIGHT = 0.6;
export const SITE_COAST_WEIGHT = 0.3;
export const SITE_DEFENSIBILITY_WEIGHT = 0.25;
export const SITE_SPACING_WEIGHT = 0.35;
/** Distance at which the spacing reward saturates. */
export const SITE_SPACING_SCALE = 700;
/** Penalty per neighbouring cell held by another civ. */
export const SITE_HOSTILE_WEIGHT = 0.5;

/* --- Migration between existing settlements ---------------------- */

/** Share of a saturated settlement redirected to a roomier sibling
 *  when no new site is worth founding. */
export const MIGRATION_SHARE = 0.15;

/* --- Growth: dwellings accumulate -------------------------------- */

/** Fraction of the housing shortfall a prospering settlement closes each
 *  year. Investment lags population, so a place has to keep being worth
 *  staying for its housing to catch up — that is what "growth" is here. */
export const HOUSING_GROWTH_RATE = 0.2;

/* --- Camp relocation: bands that cannot yet settle --------------- */

/** A camp moves to a neighbouring cell only if its foraging is this much
 *  better, so bands drift toward fertile land without jittering. */
export const CAMP_RELOCATE_GAIN = 0.12;

/* --- Abandonment ------------------------------------------------- */

/** A year is "collapsed" when local capacity covers less than this share
 *  of what the settlement needs to eat. */
export const ABANDON_FOOD_RATIO = 0.55;
/** Collapsed for this many years running and the site is abandoned. */
export const ABANDON_YEARS = 20;

/** Neutral placeholder name; the civilisation renames its own settlements
 *  once the agent loop exists. The field is left freely writable. */
export const PLACEHOLDER_NAME = "settlement";

const OCEAN = BIOMES.indexOf("ocean");
const ICE = BIOMES.indexOf("ice");

/** One grid cell spans one degree of latitude, ~111 km. Good enough to turn
 *  the cheap grid distance into kilometres for local spacing tests. */
const KM_PER_CELL = 111;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ *
 * Public surface
 * ------------------------------------------------------------------ */

export interface SettlementReport {
  /** Ids of settlements founded this year. */
  founded: number[];
  /** Ids of settlements abandoned this year. */
  abandoned: number[];
  /** Ids of settlements that seceded from their civilisation this year. */
  seceded: number[];
  /** Ids of camps that relocated this year. */
  relocated: number[];
  /** People moved between existing settlements this year. */
  migrated: number;
  /** Net land cells newly claimed this year. */
  claimed: number;
}

/**
 * How far a civilisation can administer from its capital, in km: the base
 * reach stretched by whichever governance capabilities it holds. This is what
 * territory claims, colony founding and the overextension strain are all
 * measured against — one definition, so the brake and the expansion agree.
 */
export function adminReach(held: ReadonlySet<string>): number {
  let bonus = 0;
  for (const [cap, b] of Object.entries(ADMIN_REACH_BONUS)) {
    if (held.has(cap)) bonus += b;
  }
  return ADMIN_REACH_KM * (1 + bonus);
}

/**
 * Food a single cell can feed, in people, for the civ that works it.
 * Farming lifts both the per-cell yield and (via `FARM_CAPACITY_PER_CELL`)
 * how many people the land will hold at all.
 */
export function cellFoodCapacity(grid: Grid, c: number, farming: boolean): number {
  const perCell = farming ? FARM_CAPACITY_PER_CELL : FORAGE_CAPACITY_PER_CELL;
  // Worn soil carries fewer people: `soil` starts pristine at 1 and is moved
  // only by the environment step, so long-settled land really does thin out.
  return grid.fertility[c] * grid.soil[c] * perCell;
}

/**
 * A settlement's local carrying capacity: how many people its catchment —
 * the cells it controls via `grid.settlement` — can feed. Pure; re-scans the
 * grid, so the tick uses the batched form in `assignCatchments` instead.
 */
export function carryingCapacity(world: World, s: Settlement, held: Set<string>): number {
  const farming = held.has("plant_domestication");
  let k = 0;
  for (let c = 0; c < world.grid.settlement.length; c++) {
    if (world.grid.settlement[c] === s.id) k += cellFoodCapacity(world.grid, c, farming);
  }
  return k;
}

/**
 * Record one year of food stress against a settlement and report whether it
 * has now collapsed for `ABANDON_YEARS` running. A fed year resets the count,
 * so the twenty years must be consecutive. Pure and side-effecting only on the
 * settlement's own counter — split out so the exact rule can be tested directly.
 */
export function recordFoodStress(s: Settlement, foodRatio: number): boolean {
  s.lastHarvest = foodRatio;
  if (foodRatio < ABANDON_FOOD_RATIO) s.leanYears = (s.leanYears ?? 0) + 1;
  else s.leanYears = 0;
  return (s.leanYears ?? 0) >= ABANDON_YEARS;
}

/**
 * Advance every civilisation's settlements by one year. Mutates `world` in
 * place: grid ownership and settlement assignment, settlement populations,
 * the settlement list (founding and abandonment), and the event log.
 */
export function stepSettlements(world: World): SettlementReport {
  const grid = world.grid;
  const report: SettlementReport = {
    founded: [],
    abandoned: [],
    seceded: [],
    relocated: [],
    migrated: 0,
    claimed: 0,
  };

  const heldByCiv = new Map<number, Set<string>>();
  for (const civ of world.civs) heldByCiv.set(civ.id, new Set(civ.capabilities));

  const settlementsByCiv = groupSettlements(world);

  // --- 1. Territory: one ring of dilation per settled civ, in id order -----
  // Only a civ that can settle administers territory; a foraging band keeps
  // just the home range it stands on. New claims are appended to `owned` so the
  // catchment pass sees them without a second full grid scan.
  const owned = collectOwned(grid);
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    if (!(heldByCiv.get(civ.id)?.has("settlement") ?? false)) continue;
    const sites = settlementsByCiv.get(civ.id);
    if (!sites || sites.length === 0) continue;
    const capital = largestSettlement(sites);
    const cells = owned.get(civ.id) ?? [];
    const reach = adminReach(heldByCiv.get(civ.id) ?? new Set());
    report.claimed += expandTerritory(grid, civ.id, cells, sites, capital, reach);
    owned.set(civ.id, cells);
  }

  // --- 2. Catchments + carrying capacity ----------------------------------
  const capacity = assignCatchments(grid, world.settlements, heldByCiv);

  // --- 3. Population step + growth, per settlement (stable id order) -------
  const decisions: Settlement[] = [...world.settlements].sort((a, b) => a.id - b.id);
  for (const s of decisions) {
    const held = heldByCiv.get(s.civ) ?? new Set<string>();
    const k = capacity.get(s.id) ?? 0;
    const demand = foodDemand(s);
    const foodRatio = clamp(k / Math.max(demand, MIN_DEMAND), 0, FOOD_RATIO_MAX);

    stepPopulation(s, {
      year: world.year,
      seed: world.seed,
      foodRatio,
      capabilities: held,
      freeCapacity: DEFAULT_CAMP_SHELTER,
    });

    recordFoodStress(s, k / Math.max(demand, MIN_DEMAND));
    growHousing(s, foodRatio);
  }

  // --- 4/5. Camp relocation, founding and migration -----------------------
  const founded: Settlement[] = [];
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    const held = heldByCiv.get(civ.id) ?? new Set<string>();
    const sites = settlementsByCiv.get(civ.id);
    if (!sites || sites.length === 0) continue;
    const rng = new Rng(hashSeed("settle", civ.id, world.year));

    if (!held.has("settlement")) {
      // A band that cannot settle wanders toward better foraging.
      for (const s of sites) {
        if (relocateCamp(grid, s, civ.id)) report.relocated.push(s.id);
      }
      continue;
    }

    const capital = largestSettlement(sites);
    for (const s of sites) {
      const pop = settlementPop(s);
      const k = capacity.get(s.id) ?? 0;
      const saturation = pop / Math.max(k, 1);
      if (pop < FOUND_MIN_POP || saturation < FOUND_SATURATION) continue;
      if (!rng.chance(FOUND_ATTEMPT_CHANCE)) continue;

      const site = bestSite(world, civ.id, s, capital, adminReach(held), rng);
      if (site >= 0) {
        founded.push(foundColony(world, civ, s, site));
      } else {
        report.migrated += emigrateToSibling(s, sites, capacity);
      }
    }
  }
  for (const s of founded) {
    world.settlements.push(s);
    report.founded.push(s.id);
    pushEvent(world, s.civ, s.cell, 0.4, `A new settlement was founded.`);
  }

  // --- 6. Overextension: unrest at the rim, secession past boiling --------
  const seceded = stepUnrest(world, heldByCiv, report);

  // --- 7. Abandonment and secession: freed land, removed settlements ------
  const survivors: Settlement[] = [];
  for (const s of world.settlements) {
    if (seceded.has(s.id)) {
      // The breakaway takes its people and its land out of the civilisation:
      // no dispersal to siblings — that is precisely what the civ lost.
      freeLand(world, s);
      continue;
    }
    const dead = settlementPop(s) <= 0;
    const starved = (s.leanYears ?? 0) >= ABANDON_YEARS;
    if (dead || starved) {
      abandon(world, s, settlementsByCiv);
      report.abandoned.push(s.id);
    } else {
      survivors.push(s);
    }
  }
  if (report.abandoned.length > 0 || seceded.size > 0) world.settlements = survivors;

  return report;
}

/**
 * The overextension brake. For every settled civilisation: measure each
 * settlement's strain — distance from the capital over the civ's
 * administrative reach — and accrue unrest where governance has thinned out
 * (faster when the place is also hungry, damped by a legitimate government).
 * Crossing the reporting threshold puts a standing `unrest` event in the log;
 * a settlement at boiling point can secede, which emits a `secession` event
 * causally linked to that report. Returns the ids that seceded this year;
 * the caller frees their land and removes them.
 */
function stepUnrest(
  world: World,
  heldByCiv: Map<number, Set<string>>,
  report: SettlementReport,
): Set<number> {
  const seceded = new Set<number>();
  const byCiv = groupSettlements(world);

  for (const civ of world.civs) {
    if (!civ.alive) continue;
    if (!(heldByCiv.get(civ.id)?.has("settlement") ?? false)) continue;
    const sites = byCiv.get(civ.id);
    if (!sites || sites.length === 0) continue;

    const capital = largestSettlement(sites);
    const reach = adminReach(heldByCiv.get(civ.id) ?? new Set());
    const damping = 1 - UNREST_LEGITIMACY_RELIEF * clamp(civ.government.legitimacy, 0, 1);
    const rng = new Rng(hashSeed("unrest", civ.id, world.year));

    for (const s of sites) {
      const strain = cellDistance(s.cell, capital.cell) / reach;
      const hunger = Math.max(0, 1 - Math.min(1, s.lastHarvest));
      const accrual =
        (UNREST_STRAIN_RATE * Math.max(0, strain - UNREST_STRAIN_FLOOR) +
          UNREST_HUNGER_RATE * hunger) *
        damping;
      const before = s.unrest;
      s.unrest = clamp(before + accrual - UNREST_DECAY, 0, 1);

      if (before < UNREST_EVENT_THRESHOLD && s.unrest >= UNREST_EVENT_THRESHOLD) {
        const e = emit(world, {
          kind: "unrest",
          civ: civ.id,
          cell: s.cell,
          magnitude: clamp(strain, 0, 1),
          fields: { place: s.name, civ: civ.name },
        });
        s.unrestEventId = e.id;
      } else if (s.unrest < UNREST_CLEAR_THRESHOLD) {
        s.unrestEventId = undefined;
      }

      // The capital never secedes from itself; everywhere else, a settlement
      // at boiling point may actually rise this year.
      if (s !== capital && s.unrest >= 1 && rng.chance(SECESSION_CHANCE)) {
        const civPop = Math.max(1, sites.reduce((t, x) => t + settlementPop(x), 0));
        emit(world, {
          kind: "secession",
          civ: civ.id,
          cell: s.cell,
          magnitude: clamp(settlementPop(s) / civPop, 0, 1),
          fields: { place: s.name, civ: civ.name },
          causedBy: s.unrestEventId !== undefined ? [s.unrestEventId] : [],
        });
        seceded.add(s.id);
        report.seceded.push(s.id);
      }
    }
  }
  return seceded;
}

/** Free a settlement's catchment and its own cell — ownership and assignment
 *  both — without touching its people. Shared by secession (people leave with
 *  the land) and abandonment (which disperses them first). */
function freeLand(world: World, s: Settlement): void {
  const grid = world.grid;
  for (let c = 0; c < grid.settlement.length; c++) {
    if (grid.settlement[c] === s.id) {
      grid.settlement[c] = -1;
      grid.owner[c] = -1;
    }
  }
  if (grid.owner[s.cell] === s.civ) grid.owner[s.cell] = -1;
  if (grid.settlement[s.cell] === s.id) grid.settlement[s.cell] = -1;
}

/** People a site shelters before any dwelling is built — a camp, caves, tents.
 *  Matches the population module's own default. */
const DEFAULT_CAMP_SHELTER = 40;

/* ------------------------------------------------------------------ *
 * Territory
 * ------------------------------------------------------------------ */

/** Group living settlements by civ, preserving id order within each civ. */
function groupSettlements(world: World): Map<number, Settlement[]> {
  const by = new Map<number, Settlement[]>();
  for (const s of [...world.settlements].sort((a, b) => a.id - b.id)) {
    let arr = by.get(s.civ);
    if (!arr) {
      arr = [];
      by.set(s.civ, arr);
    }
    arr.push(s);
  }
  return by;
}

/** One grid pass grouping every owned land cell by its civ. */
function collectOwned(grid: Grid): Map<number, number[]> {
  const owned = new Map<number, number[]>();
  for (let i = 0; i < grid.owner.length; i++) {
    const o = grid.owner[i];
    if (o < 0 || grid.land[i] === 0) continue;
    let arr = owned.get(o);
    if (!arr) {
      arr = [];
      owned.set(o, arr);
    }
    arr.push(i);
  }
  return owned;
}

/** The civ's largest settlement — the seat its administrative reach is measured
 *  from. Ties break to the lower id so the choice is deterministic. */
function largestSettlement(sites: Settlement[]): Settlement {
  let best = sites[0];
  let bestPop = settlementPop(best);
  for (let i = 1; i < sites.length; i++) {
    const p = settlementPop(sites[i]);
    if (p > bestPop) {
      best = sites[i];
      bestPop = p;
    }
  }
  return best;
}

/**
 * Claim one ring of new land for a civ. A frontier cell (unowned land next to
 * something the civ already holds) is taken when
 *   reach × distance-decay × habitability > CLAIM_THRESHOLD,
 * where `reach` falls off with distance from the capital (finite administrative
 * reach) and `distance-decay` falls off with distance from the nearest
 * settlement. Ocean and land held by another civ are never taken. Returns the
 * number of cells claimed.
 */
function expandTerritory(
  grid: Grid,
  civId: number,
  ownedCells: number[],
  sites: Settlement[],
  capital: Settlement,
  reachKm: number,
): number {
  const candidates = new Set<number>();
  for (const c of ownedCells) {
    for (const n of neighbors(c)) {
      if (grid.land[n] === 1 && grid.owner[n] === -1) candidates.add(n);
    }
  }
  let claimed = 0;
  for (const c of candidates) {
    const reach = 1 - cellDistance(c, capital.cell) / reachKm;
    if (reach <= 0) continue;
    let nearest = Infinity;
    for (const s of sites) {
      const d = cellDistance(c, s.cell);
      if (d < nearest) nearest = d;
    }
    const local = 1 - nearest / TERRITORY_RADIUS_KM;
    if (local <= 0) continue;
    if (reach * local > CLAIM_THRESHOLD) {
      grid.owner[c] = civId;
      ownedCells.push(c);
      claimed++;
    }
  }
  return claimed;
}

/**
 * Assign every owned land cell to the settlement that works it — its nearest
 * settlement by land steps within the same civ — and accumulate each
 * settlement's carrying capacity in the same pass. A multi-source breadth-first
 * flood from every settlement at once: O(owned cells), and it respects the
 * coastline, so a settlement never claims land across a bay it cannot walk to.
 */
function assignCatchments(
  grid: Grid,
  all: Settlement[],
  heldByCiv: Map<number, Set<string>>,
): Map<number, number> {
  const capacity = new Map<number, number>();
  const byId = new Map<number, Settlement>();
  for (const s of all) {
    capacity.set(s.id, 0);
    byId.set(s.id, s);
  }
  // Clear stale assignments so an abandoned site's cells do not linger.
  grid.settlement.fill(-1);
  const farmingOf = (civ: number) =>
    heldByCiv.get(civ)?.has("plant_domestication") ?? false;

  const queue: number[] = [];
  for (const s of all) {
    if (grid.settlement[s.cell] !== -1) continue; // two settlements, one cell: keep the first
    grid.settlement[s.cell] = s.id;
    capacity.set(
      s.id,
      (capacity.get(s.id) ?? 0) + cellFoodCapacity(grid, s.cell, farmingOf(s.civ)),
    );
    queue.push(s.cell);
  }
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head];
    const s = byId.get(grid.settlement[c]);
    if (!s) continue;
    const farming = farmingOf(s.civ);
    for (const n of neighbors(c)) {
      if (grid.land[n] === 0 || grid.owner[n] !== s.civ || grid.settlement[n] !== -1)
        continue;
      grid.settlement[n] = s.id;
      capacity.set(s.id, (capacity.get(s.id) ?? 0) + cellFoodCapacity(grid, n, farming));
      queue.push(n);
    }
  }
  return capacity;
}

/** Squared grid distance with east–west wrap. Cheap; for "which is nearest". */
function gridDist2(a: number, b: number): number {
  const ax = cellX(a);
  const ay = cellY(a);
  const bx = cellX(b);
  const by = cellY(b);
  let dx = Math.abs(ax - bx);
  if (dx > GRID_W - dx) dx = GRID_W - dx;
  const dy = Math.abs(ay - by);
  return dx * dx + dy * dy;
}

/* ------------------------------------------------------------------ *
 * Growth
 * ------------------------------------------------------------------ */

/** Grow a prospering settlement's housing toward what its population needs.
 *  Housing only ever climbs — dwellings do not vanish when a place shrinks —
 *  and it lags, so growth is an accumulation, not an instant fit. */
function growHousing(s: Settlement, foodRatio: number): void {
  if (foodRatio < 1) return;
  const target = settlementPop(s) / PEOPLE_PER_DWELLING;
  if (target > s.housing) s.housing += HOUSING_GROWTH_RATE * (target - s.housing);
}

/* ------------------------------------------------------------------ *
 * Founding
 * ------------------------------------------------------------------ */

/**
 * Find the best site for a colony budding off `parent`, or -1 if nowhere in
 * reach is worth it. Searches a window around the parent, skipping ocean, ice,
 * infertile land, cells already settled, land held by another civ, anything
 * outside administrative reach, and anything too close to an existing site.
 */
function bestSite(
  world: World,
  civId: number,
  parent: Settlement,
  capital: Settlement,
  reachKm: number,
  rng: Rng,
): number {
  const grid = world.grid;
  const radiusCells = Math.ceil(FOUND_SEARCH_RADIUS_KM / KM_PER_CELL) + 1;
  const px = cellX(parent.cell);
  const py = cellY(parent.cell);

  // The spacing rule can only be bound by settlements near the parent, so
  // collect their cells once with cheap grid distance; the per-candidate
  // nearest-settlement test then loops a short list instead of the whole world.
  const spacingCells = radiusCells + Math.ceil(SITE_SPACING_SCALE / KM_PER_CELL) + 2;
  const maxD2 = spacingCells * spacingCells;
  const near: number[] = [];
  for (const s of world.settlements) {
    if (gridDist2(parent.cell, s.cell) <= maxD2) near.push(s.cell);
  }

  let bestCell = -1;
  let bestScore = MIN_SITE_SCORE;
  for (let dy = -radiusCells; dy <= radiusCells; dy++) {
    const y = py + dy;
    if (y < 0 || y >= GRID_H) continue;
    for (let dx = -radiusCells; dx <= radiusCells; dx++) {
      const x = (((px + dx) % GRID_W) + GRID_W) % GRID_W;
      const c = y * GRID_W + x;
      if (grid.land[c] === 0) continue;
      const biome = grid.biome[c];
      if (biome === OCEAN || biome === ICE) continue;
      if (grid.fertility[c] < SITE_MIN_FERTILITY) continue;
      if (grid.settlement[c] !== -1) continue;
      const o = grid.owner[c];
      if (o !== -1 && o !== civId) continue;
      if (cellDistance(c, parent.cell) > FOUND_SEARCH_RADIUS_KM) continue;
      if (1 - cellDistance(c, capital.cell) / reachKm <= 0) continue;

      let nd2 = Infinity;
      for (const sc of near) {
        const d = gridDist2(c, sc);
        if (d < nd2) nd2 = d;
      }
      const nearestKm = Math.sqrt(nd2) * KM_PER_CELL;
      if (nearestKm < FOUND_MIN_SPACING_KM) continue;

      const score = siteScore(grid, c, nearestKm, civId);
      // A hair of deterministic noise breaks ties between equal cells without
      // touching Math.random; identical scores otherwise always pick the same
      // corner of the window.
      const jittered = score + rng.next() * 1e-6;
      if (jittered > bestScore) {
        bestScore = jittered;
        bestCell = c;
      }
    }
  }
  return bestCell;
}

/** Score a candidate site: fertility + fresh water + coast + defensibility,
 *  rewarded for spacing from other settlements and penalised for hostile
 *  neighbours. Weights are the named constants above. */
function siteScore(grid: Grid, c: number, nearestKm: number, civId: number): number {
  const spacing = clamp(nearestKm / SITE_SPACING_SCALE, 0, 1);
  let hostile = 0;
  for (const n of neighbors(c)) {
    const o = grid.owner[n];
    if (o !== -1 && o !== civId) hostile++;
  }
  return (
    SITE_FERTILITY_WEIGHT * grid.fertility[c] +
    SITE_RIVER_WEIGHT * Math.min(1, grid.river[c]) +
    SITE_COAST_WEIGHT * grid.coast[c] +
    SITE_DEFENSIBILITY_WEIGHT * grid.elevation[c] +
    SITE_SPACING_WEIGHT * spacing -
    SITE_HOSTILE_WEIGHT * hostile
  );
}

/** Move a share of a parent's people to a fresh settlement on `cell`. */
function foundColony(
  world: World,
  civ: Civ,
  parent: Settlement,
  cell: number,
): Settlement {
  const ages = new Float64Array(AGE_SLOTS);
  for (let a = 0; a < AGE_SLOTS; a++) {
    const move = parent.ages[a] * FOUND_MIGRANT_SHARE;
    ages[a] = move;
    parent.ages[a] -= move;
  }
  refreshCohorts(parent);

  const colony: Settlement = {
    id: world.nextSettlementId++,
    civ: civ.id,
    cell,
    name: PLACEHOLDER_NAME,
    founded: world.year,
    ages,
    cohorts: new Float64Array(16),
    housing: 0,
    buildings: {},
    unrest: 0,
    lastHarvest: 1,
    leanYears: 0,
  };
  refreshCohorts(colony);
  colony.housing = settlementPop(colony) / PEOPLE_PER_DWELLING;

  world.grid.owner[cell] = civ.id;
  world.grid.settlement[cell] = colony.id;
  return colony;
}

/**
 * Found a colony on command, budding off the civ's largest settlement toward the
 * best nearby site. This is the settlement layer's side of an accepted "settle"
 * directive: the autonomous founding above happens on its own schedule, but a
 * civilisation that *decides* to expand reaches it through here. Returns the new
 * settlement (already pushed onto the world and stamped on the grid) or null if
 * the civ cannot yet settle, has nowhere in reach worth founding, or has no
 * settlements to bud from. Deterministic — the site search's tie-break rng is
 * seeded from the civ and the year.
 */
export function foundDirectedColony(world: World, civId: number): Settlement | null {
  const civ = world.civs.find((c) => c.id === civId);
  if (!civ?.alive) return null;
  if (!civ.capabilities.includes("settlement")) return null;
  const sites = world.settlements.filter((s) => s.civ === civId);
  if (sites.length === 0) return null;

  const capital = largestSettlement(sites);
  const rng = new Rng(hashSeed("found-directed", civId, world.year));
  const cell = bestSite(
    world,
    civId,
    capital,
    capital,
    adminReach(new Set(civ.capabilities)),
    rng,
  );
  if (cell < 0) return null;

  const colony = foundColony(world, civ, capital, cell);
  world.settlements.push(colony);
  pushEvent(world, civId, cell, 0.5, "A new settlement was founded by decree.");
  return colony;
}

/* ------------------------------------------------------------------ *
 * Migration between existing settlements
 * ------------------------------------------------------------------ */

/** Send a slice of a saturated settlement to the sibling with the most room.
 *  Returns the number of people moved. The release valve when no new site is
 *  worth founding. */
function emigrateToSibling(
  s: Settlement,
  sites: Settlement[],
  capacity: Map<number, number>,
): number {
  let best: Settlement | null = null;
  let bestRoom = 0;
  for (const t of sites) {
    if (t.id === s.id) continue;
    const room = (capacity.get(t.id) ?? 0) - settlementPop(t);
    if (room > bestRoom && t.unrest < s.unrest + 0.5) {
      bestRoom = room;
      best = t;
    }
  }
  if (!best) return 0;
  let moved = 0;
  for (let a = 0; a < AGE_SLOTS; a++) {
    const move = s.ages[a] * MIGRATION_SHARE;
    s.ages[a] -= move;
    best.ages[a] += move;
    moved += move;
  }
  refreshCohorts(s);
  refreshCohorts(best);
  return moved;
}

/* ------------------------------------------------------------------ *
 * Camp relocation (bands that cannot yet settle)
 * ------------------------------------------------------------------ */

/**
 * A band that lacks the `settlement` capability wanders: it steps its single
 * camp to the neighbouring land cell with the best foraging, if that beats
 * where it stands by `CAMP_RELOCATE_GAIN`. Its small home range moves with it.
 * Returns whether it moved.
 */
function relocateCamp(grid: Grid, s: Settlement, civId: number): boolean {
  const here = grid.fertility[s.cell];
  let bestCell = -1;
  let bestFert = here * (1 + CAMP_RELOCATE_GAIN);
  for (const n of neighbors(s.cell)) {
    if (grid.land[n] === 0) continue;
    const o = grid.owner[n];
    if (o !== -1 && o !== civId) continue;
    if (grid.fertility[n] > bestFert) {
      bestFert = grid.fertility[n];
      bestCell = n;
    }
  }
  if (bestCell < 0) return false;

  // A band carries only a small home range, so free its whole current range —
  // a camp civ has just this one settlement — then claim the new cell and the
  // ring around it. It leaves no owned trail behind.
  for (let i = 0; i < grid.owner.length; i++) {
    if (grid.owner[i] === civId) {
      grid.owner[i] = -1;
      if (grid.settlement[i] === s.id) grid.settlement[i] = -1;
    }
  }
  s.cell = bestCell;
  grid.owner[bestCell] = civId;
  grid.settlement[bestCell] = s.id;
  for (const n of neighbors(bestCell)) {
    if (grid.land[n] === 1 && grid.owner[n] === -1) grid.owner[n] = civId;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Abandonment
 * ------------------------------------------------------------------ */

/**
 * Abandon a settlement: disperse any survivors to the nearest surviving
 * sibling, then free its catchment so the land returns to the wild (or to a
 * neighbouring settlement next year). The settlement itself is removed by the
 * caller.
 */
function abandon(world: World, s: Settlement, byCiv: Map<number, Settlement[]>): void {
  const pop = settlementPop(s);
  if (pop > 0) {
    const sibling = nearestSibling(s, byCiv);
    if (sibling) {
      for (let a = 0; a < AGE_SLOTS; a++) sibling.ages[a] += s.ages[a];
      refreshCohorts(sibling);
    }
  }
  // Its own cell may not be in its catchment if it was just founded;
  // `freeLand` clears both the catchment and the site itself.
  freeLand(world, s);

  pushEvent(world, s.civ, s.cell, 0.4, `A settlement was abandoned.`);
}

/** The nearest still-populated settlement of the same civ, or null. */
function nearestSibling(
  s: Settlement,
  byCiv: Map<number, Settlement[]>,
): Settlement | null {
  const sites = byCiv.get(s.civ);
  if (!sites) return null;
  let best: Settlement | null = null;
  let bestD = Infinity;
  for (const t of sites) {
    if (t.id === s.id || settlementPop(t) <= 0) continue;
    const d = gridDist2(s.cell, t.cell);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Conquest — the settlement layer's side of a lost war
 * ------------------------------------------------------------------ */

/** Share of a sacked settlement's people killed in the taking. */
export const SACK_DEATH_SHARE = 0.12;
/** Share who flee as refugees to the nearest surviving settlement of their
 *  own people. Whoever neither dies nor flees lives on under the conqueror. */
export const SACK_REFUGEE_SHARE = 0.3;
/** Unrest a captured settlement carries — conquered people are not content. */
export const CAPTURE_UNREST = 0.6;

export interface SackResult {
  /** People killed in the sack. */
  killed: number;
  /** People who fled to `refuge`; 0 when their civ had nowhere left to run. */
  fled: number;
  /** The settlement the refugees reached, or null. */
  refuge: Settlement | null;
  /** Cells of the old owner's land that changed hands with the place. */
  cells: number;
}

/**
 * Sack a settlement in a conquest: a share of its people are killed, a share
 * flee to the nearest surviving settlement of their own civ, and whoever
 * remains lives on under the conqueror — the settlement and every cell of its
 * catchment change hands on the map. The engine does not moralise the choice;
 * it prices it. The caller (`military.ts`) emits the events, so they can carry
 * the battle's causal links; a settlement emptied outright is culled by the
 * next settlement step like any other dead place.
 */
export function sackSettlement(
  world: World,
  s: Settlement,
  conquerorId: number,
): SackResult {
  let killed = 0;
  for (let a = 0; a < AGE_SLOTS; a++) {
    const d = s.ages[a] * SACK_DEATH_SHARE;
    s.ages[a] -= d;
    killed += d;
  }

  // Refugees run to the nearest surviving settlement of their own people.
  let refuge: Settlement | null = null;
  let bestD = Infinity;
  for (const t of world.settlements) {
    if (t.civ !== s.civ || t.id === s.id || settlementPop(t) <= 0) continue;
    const d = gridDist2(s.cell, t.cell);
    if (d < bestD) {
      bestD = d;
      refuge = t;
    }
  }
  let fled = 0;
  if (refuge) {
    for (let a = 0; a < AGE_SLOTS; a++) {
      const move = s.ages[a] * SACK_REFUGEE_SHARE;
      s.ages[a] -= move;
      refuge.ages[a] += move;
      fled += move;
    }
    refreshCohorts(refuge);
  }
  refreshCohorts(s);

  // The place, its catchment and the people still in it change hands.
  const oldCiv = s.civ;
  s.civ = conquerorId;
  s.unrest = Math.max(s.unrest, CAPTURE_UNREST);
  s.leanYears = 0;
  const grid = world.grid;
  let cells = 0;
  for (let c = 0; c < grid.settlement.length; c++) {
    if (grid.settlement[c] !== s.id) continue;
    if (grid.owner[c] === oldCiv) cells++;
    grid.owner[c] = conquerorId;
  }
  if (grid.owner[s.cell] !== conquerorId) {
    if (grid.owner[s.cell] === oldCiv) cells++;
    grid.owner[s.cell] = conquerorId;
  }
  return { killed, fled, refuge, cells };
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

function pushEvent(
  world: World,
  civ: number | null,
  cell: number | null,
  weight: number,
  text: string,
): void {
  // Route through the one event writer so weight, causal links and the log stay
  // in a single place; settlement events carry no antecedent.
  emit(world, { kind: "settlement", civ, cell, weight, text });
}
