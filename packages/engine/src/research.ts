/**
 * Research and — more importantly — knowledge loss.
 *
 * A capability is physical possibility, not a rung on a fixed ladder. A civ can
 * only research what its prerequisites, materials, terrain and settled
 * population permit (the gates live in `knowledge.ts`), and nothing obliges it
 * to discover anything at all.
 *
 * What makes this layer more than a tech tree is that a held capability is not
 * owned in the abstract. It is carried by particular people and institutions.
 * When those carriers die — a plague, a sack, a slow decline — knowledge that
 * was never written down goes with them. That is how a dark age happens here
 * without anyone scripting one, and it is what makes `writing`, `schools` and
 * archives strategically valuable rather than decorative.
 *
 * The step is deterministic. The only stochastic input is a per-civ-per-year
 * research "fortune" (breakthroughs and blind alleys) drawn from
 * `hashSeed("research", civId, year)`, so a seed always replays to the same
 * history of discovery and loss. Diffusion of knowledge *between* civs is not
 * here — that belongs with contact and trade.
 */
import type { ResourceKind } from "./geo-data.ts";
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  type Capability,
  STARTING_CAPABILITIES,
  blockedBecause,
  researchable,
} from "./knowledge.ts";
import { emit } from "./events.ts";
import { prospectingLevel } from "./production.ts";
import { Rng, hashSeed } from "./rng.ts";
import {
  BIOMES,
  type CapabilityHolders,
  type Civ,
  type EventKind,
  type Grid,
  type World,
  civPopulation,
  settlementPop,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables — every arguable number, named, so it can be tuned rather
 * than hunted for. Calibrated so a stone-age band inches forward over
 * centuries while a large, literate civilisation advances in years.
 * ------------------------------------------------------------------ */

/** Research-units a single scholar-equivalent produces in a year at baseline
 * literacy and density. Capability `effort` is denominated in these units. */
export const RESEARCH_PER_SCHOLAR = 0.06;

/** Ideas compound where they are written, taught and argued over. Read from
 * what the civ holds — never from an era number. */
export const WRITING_MULT = 1.6;
export const SCHOOLS_MULT = 1.5;
export const PHILOSOPHY_MULT = 1.25;

/** Ideas need density: a village of specialists out-thinks the same heads
 * scattered across hamlets. Scales with the civ's largest settlement. */
export const DENSITY_FLOOR = 0.35;
export const DENSITY_CEIL = 2.0;
/** Settlement size at which density reaches the midpoint of floor..ceiling. */
export const DENSITY_HALF = 2000;

/** Year-to-year research luck: a breakthrough, or a decade down a dead end. */
export const FORTUNE_SPREAD = 0.2;
export const FORTUNE_MIN = 0.6;
export const FORTUNE_MAX = 1.4;

/** Share of a civ's population who plausibly carry a capability, by era. Basic
 * survival knowledge is held by nearly everyone; rarefied craft and scholarship
 * by a shrinking few — which is exactly why the advanced, unwritten stuff is the
 * first to vanish when a population crashes. */
export const SPREAD_BASE = 0.9;
export const SPREAD_DECAY = 0.5; // each era halves the share of carriers
export const SPREAD_MIN = 0.004;

/** Below this many effective holders, an unwritten capability's chain of
 * transmission breaks and it is lost. */
export const HOLDER_LOSS_THRESHOLD = 3;
/** Holder-equivalents an institution (archive, school, guild) is worth — the
 * resilience that organised knowledge buys over knowledge held only in heads. */
export const INSTITUTION_SUPPORT = 4;

/** A capability once held and lost is cheaper to re-discover: ruins, survivors
 * and half-memories remain. Fraction of the original effort it then costs. */
export const REDISCOVERY_DISCOUNT = 0.4;

/** Era at or above which a capability counts as scholarly for the purpose of a
 * school preserving it (below this, `writing` alone flags the record). */
export const SCHOLARLY_ERA_MIN = 4;

/** Terrain thresholds for the capability terrain gate, matching the biome and
 * grid semantics in `worldgen`/`production`. */
export const FERTILE_TERRAIN_MIN = 0.5;
export const FOREST_TERRAIN_MIN = 0.2;

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface ResearchResult {
  civ: number;
  /** Deterministic annual research effort, before this year's fortune. */
  capacity: number;
  /** `capacity` × this year's fortune — what was actually spent. */
  effort: number;
  /** The capability the civ is aiming for, or null when unsteered/idle. */
  target: string | null;
  /** Accumulated effort toward the current step after this year. */
  progress: number;
  /** Capabilities gained this year. */
  completed: string[];
  /** Capabilities lost this year (holders died, nothing written down). */
  lost: string[];
  /** If a directive cannot advance, the honest reason — else null. */
  blocked: string | null;
}

/**
 * Advance research for every living civilisation by one year: refresh who holds
 * what, lose unwritten knowledge whose carriers have died, then spend this
 * year's scholarship toward each civ's target. Mutates civs and the event log
 * in place; returns a per-civ summary for the chronicle and for tests.
 */
export function advanceResearch(world: World): ResearchResult[] {
  const results: ResearchResult[] = [];
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    results.push(stepResearch(world, civ));
  }
  return results;
}

/** Advance one civilisation by one year. Exposed for tests and orchestration. */
export function stepResearch(world: World, civ: Civ): ResearchResult {
  const grid = world.grid;
  const held = new Set(civ.capabilities);
  const population = civPopulation(world, civ.id);
  const terrains = terrainOf(grid, civ.id);
  const hasTerrain = (t: string) => terrains.has(t);
  const hasMaterial = (m: ResourceKind) => materialInReach(world, civ, m);
  const rng = new Rng(hashSeed("research", civ.id, world.year));

  // Holders track the living population and current institutions; refresh
  // before anything reads them so a crash this year is felt this year.
  refreshHolders(civ, held, population);

  // 1) Knowledge loss — unwritten capabilities with too few carriers vanish.
  const lost = applyKnowledgeLoss(world, civ, held);

  // 2) Research — spend this year's scholarship toward the target.
  const capacity = researchEffort(civ, world);
  const fortune = clamp(FORTUNE_MIN, FORTUNE_MAX, 1 + FORTUNE_SPREAD * rng.normal());
  const effort = capacity * fortune;

  let goal = civ.research.target;
  if (goal && (held.has(goal) || !CAPABILITY_BY_ID.has(goal))) goal = null; // reached or invalid
  if (!goal) {
    goal = pickAutoTarget(held, hasMaterial, hasTerrain, population); // unsteered: keep moving
    civ.research.target = goal;
  }

  const completed: string[] = [];
  let blocked: string | null = null;

  if (goal) {
    let step = nextStepToward(goal, held, hasMaterial, hasTerrain, population, new Set());
    if (!step) {
      blocked = blockReason(goal, held, hasMaterial, hasTerrain, population);
    } else {
      civ.research.progress += effort;
      let guard = 0;
      while (step && guard++ < CAPABILITIES.length + 1) {
        const cap = CAPABILITY_BY_ID.get(step);
        if (!cap) break;
        const cost =
          cap.effort * (civ.forgotten.includes(step) ? REDISCOVERY_DISCOUNT : 1);
        if (civ.research.progress < cost) break;
        civ.research.progress -= cost;
        gainCapability(world, civ, step, population);
        held.add(step);
        completed.push(step);
        if (step === goal) {
          goal = null;
          civ.research.target = null;
          break;
        }
        step = nextStepToward(goal, held, hasMaterial, hasTerrain, population, new Set());
      }
    }
  }

  return {
    civ: civ.id,
    capacity,
    effort,
    target: civ.research.target,
    progress: civ.research.progress,
    completed,
    lost,
    blocked,
  };
}

/** Deterministic annual research effort of a civ, in scholar-equivalent units.
 * Exposed so callers can compare civilisations without stepping them. */
export function researchCapacity(world: World, civId: number): number {
  const civ = world.civs.find((c) => c.id === civId);
  return civ ? researchEffort(civ, world) : 0;
}

/** Share of a population that carries a capability. Rarefied knowledge (high
 * era) is held by a vanishing few, which is what makes it fragile. */
export function capabilitySpread(cap: Capability): number {
  return clamp(SPREAD_MIN, SPREAD_BASE, SPREAD_BASE * SPREAD_DECAY ** cap.era);
}

/** Effective holders of a capability: living carriers plus the resilience its
 * institutions lend. This is what the loss threshold is measured against. */
export function holderStrength(civ: Civ, capId: string): number {
  const h = civ.holders[capId];
  if (!h) return 0;
  return h.people + INSTITUTION_SUPPORT * h.institutions.length;
}

/**
 * The gate inputs the research layer sees for a civ: what it holds, its
 * population, and the material/terrain predicates. Handy for driving
 * `researchable()`/`blockedBecause()` from `knowledge.ts` the same way this
 * module does.
 */
export function researchGates(
  world: World,
  civId: number,
): {
  civ: Civ;
  held: Set<string>;
  population: number;
  hasMaterial: (m: ResourceKind) => boolean;
  hasTerrain: (t: string) => boolean;
} {
  const civ = world.civs.find((c) => c.id === civId);
  if (!civ) throw new Error(`no civ ${civId}`);
  const terrains = terrainOf(world.grid, civId);
  return {
    civ,
    held: new Set(civ.capabilities),
    population: civPopulation(world, civId),
    hasMaterial: (m: ResourceKind) => materialInReach(world, civ, m),
    hasTerrain: (t: string) => terrains.has(t),
  };
}

/* ------------------------------------------------------------------ *
 * Effort — scholarship, not headcount
 * ------------------------------------------------------------------ */

function researchEffort(civ: Civ, world: World): number {
  const population = civPopulation(world, civ.id);
  if (population <= 0) return 0;
  const scholars = population * clamp(0, 1, civ.policy.research);
  if (scholars <= 0) return 0;

  let literacy = 1;
  if (civ.capabilities.includes("writing")) literacy *= WRITING_MULT;
  if (civ.capabilities.includes("schools")) literacy *= SCHOOLS_MULT;
  if (civ.capabilities.includes("philosophy")) literacy *= PHILOSOPHY_MULT;

  const largest = largestSettlement(world, civ.id);
  const density =
    DENSITY_FLOOR + (DENSITY_CEIL - DENSITY_FLOOR) * (largest / (largest + DENSITY_HALF));

  return scholars * RESEARCH_PER_SCHOLAR * literacy * density;
}

function largestSettlement(world: World, civId: number): number {
  let max = 0;
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    const p = settlementPop(s);
    if (p > max) max = p;
  }
  return max;
}

/* ------------------------------------------------------------------ *
 * Choosing what to work on
 * ------------------------------------------------------------------ */

/** Unsteered fallback: the cheapest capability the civ could research now, so a
 * civilisation with no directive still creeps forward. Deterministic. */
function pickAutoTarget(
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): string | null {
  const options = researchable(held, hasMaterial, hasTerrain, population);
  if (options.length === 0) return null;
  let best = options[0];
  for (const c of options) {
    if (c.effort < best.effort) best = c;
    else if (
      c.effort === best.effort &&
      (c.era < best.era || (c.era === best.era && c.id < best.id))
    ) {
      best = c;
    }
  }
  return best.id;
}

/**
 * The next capability a civ can actually research on the way to `goalId`,
 * decomposing prerequisites depth-first. Returns the goal itself when it is
 * directly researchable, the deepest researchable prerequisite otherwise, or
 * null when a material/terrain/population wall blocks the whole path.
 */
function nextStepToward(
  goalId: string,
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
  seen: Set<string>,
): string | null {
  if (held.has(goalId) || seen.has(goalId)) return null;
  seen.add(goalId);
  const cap = CAPABILITY_BY_ID.get(goalId);
  if (!cap) return null;

  const unmet = cap.needs.filter((n) => !held.has(n));
  if (unmet.length === 0) {
    return isResearchableNow(cap, held, hasMaterial, hasTerrain, population)
      ? goalId
      : null;
  }

  const ordered = unmet
    .map((id) => CAPABILITY_BY_ID.get(id))
    .filter((c): c is Capability => c !== undefined)
    .sort((a, b) => a.effort - b.effort || a.era - b.era || (a.id < b.id ? -1 : 1));

  for (const c of ordered) {
    const step = nextStepToward(c.id, held, hasMaterial, hasTerrain, population, seen);
    if (step) return step;
  }
  return null;
}

/** A single capability's version of the `researchable()` filter. */
function isResearchableNow(
  cap: Capability,
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): boolean {
  if (held.has(cap.id)) return false;
  if (!cap.needs.every((n) => held.has(n))) return false;
  if (cap.materials && !cap.materials.every(hasMaterial)) return false;
  if (cap.terrain && !cap.terrain.some(hasTerrain)) return false;
  if (cap.minPop && population < cap.minPop) return false;
  return true;
}

/** The honest reason a directive cannot advance: the first material/terrain/
 * population wall found in the goal's dependency closure. */
function blockReason(
  goalId: string,
  held: Set<string>,
  hasMaterial: (m: ResourceKind) => boolean,
  hasTerrain: (t: string) => boolean,
  population: number,
): string | null {
  const stack = [goalId];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const cap = CAPABILITY_BY_ID.get(id);
    if (!cap || held.has(id)) continue;
    const unmet = cap.needs.filter((n) => !held.has(n));
    if (unmet.length === 0) {
      const why = blockedBecause(cap, held, hasMaterial, hasTerrain, population);
      if (why) return why;
    } else {
      for (const n of unmet) stack.push(n);
    }
  }
  const cap = CAPABILITY_BY_ID.get(goalId);
  return cap ? blockedBecause(cap, held, hasMaterial, hasTerrain, population) : null;
}

/* ------------------------------------------------------------------ *
 * Holders — who carries what, and whether it is written down
 * ------------------------------------------------------------------ */

function refreshHolders(civ: Civ, held: Set<string>, population: number): void {
  // Drop entries for capabilities the civ no longer holds.
  for (const id of Object.keys(civ.holders)) {
    if (!held.has(id)) delete civ.holders[id];
  }
  for (const id of held) {
    const cap = CAPABILITY_BY_ID.get(id);
    if (!cap) continue;
    const h: CapabilityHolders = civ.holders[id] ?? {
      people: 0,
      institutions: [],
      written: false,
    };
    h.people = population * capabilitySpread(cap);
    h.institutions = institutionsFor(civ, cap);
    // Once written, records persist even if writing is later lost — never
    // force a capability back to unwritten here.
    if (civ.capabilities.includes("writing")) h.written = true;
    civ.holders[id] = h;
  }
}

function institutionsFor(civ: Civ, cap: Capability): string[] {
  const inst: string[] = [];
  if (civ.capabilities.includes("writing")) inst.push("archive");
  if (civ.capabilities.includes("schools") && isScholarly(cap)) inst.push("school");
  if (civ.capabilities.includes("granary") && cap.materials && cap.materials.length > 0) {
    inst.push("guild");
  }
  return inst;
}

const isScholarly = (cap: Capability): boolean =>
  cap.era >= SCHOLARLY_ERA_MIN || cap.needs.includes("writing");

/* ------------------------------------------------------------------ *
 * Knowledge loss
 * ------------------------------------------------------------------ */

/**
 * Lose unwritten capabilities whose carriers have thinned below the threshold.
 * Loss cascades from the most-derived capabilities down: a capability that
 * still underpins something the civ knows is protected, so the held set stays
 * prerequisite-closed and a civ forgets its fanciest applications before its
 * foundations. Starting capabilities are never lost.
 */
function applyKnowledgeLoss(world: World, civ: Civ, held: Set<string>): string[] {
  const lost: string[] = [];
  let changed = true;
  let guard = 0;
  while (changed && guard++ < CAPABILITIES.length + 1) {
    changed = false;
    const needed = prerequisitesOfHeld(civ);
    // Most-derived first (highest era) for a clean, deterministic cascade.
    const order = [...civ.capabilities].sort(
      (a, b) => eraOf(b) - eraOf(a) || (a < b ? -1 : 1),
    );
    for (const id of order) {
      if (STARTING_CAPABILITIES.includes(id)) continue;
      const h = civ.holders[id];
      if (!h || h.written) continue;
      if (needed.has(id)) continue; // still underpins held knowledge
      if (holderStrength(civ, id) >= HOLDER_LOSS_THRESHOLD) continue;

      const cap = CAPABILITY_BY_ID.get(id);
      const idx = civ.capabilities.indexOf(id);
      if (idx >= 0) civ.capabilities.splice(idx, 1);
      delete civ.holders[id];
      held.delete(id);
      if (!civ.forgotten.includes(id)) civ.forgotten.push(id);
      lost.push(id);
      pushEvent(
        world,
        "collapse",
        civ.id,
        null,
        clamp(0.3, 1, 0.3 + eraOf(id) * 0.1),
        `${civ.name} lost the knowledge of ${cap?.name ?? id}.`,
      );
      changed = true;
      break; // recompute `needed` and re-scan from the top
    }
  }
  return lost;
}

function prerequisitesOfHeld(civ: Civ): Set<string> {
  const needed = new Set<string>();
  for (const id of civ.capabilities) {
    const cap = CAPABILITY_BY_ID.get(id);
    if (!cap) continue;
    for (const n of cap.needs) needed.add(n);
  }
  return needed;
}

const eraOf = (id: string): number => CAPABILITY_BY_ID.get(id)?.era ?? 0;

/* ------------------------------------------------------------------ *
 * Gaining a capability
 * ------------------------------------------------------------------ */

function gainCapability(world: World, civ: Civ, id: string, population: number): void {
  civ.capabilities.push(id);
  const fi = civ.forgotten.indexOf(id);
  if (fi >= 0) civ.forgotten.splice(fi, 1);

  const cap = CAPABILITY_BY_ID.get(id);
  civ.holders[id] = {
    people: population * (cap ? capabilitySpread(cap) : SPREAD_MIN),
    institutions: cap ? institutionsFor(civ, cap) : [],
    written: civ.capabilities.includes("writing"),
  };

  pushEvent(
    world,
    "discovery",
    civ.id,
    null,
    clamp(0.3, 1, 0.3 + (cap?.era ?? 0) * 0.1),
    `${civ.name} learned ${cap?.name ?? id}.`,
  );
}

/* ------------------------------------------------------------------ *
 * Territory gates — materials and terrain the civ actually controls
 * ------------------------------------------------------------------ */

/** A material is in reach if the civ controls a deposit of it that it has found
 * or could find at its current prospecting level, with ore still remaining. */
function materialInReach(world: World, civ: Civ, kind: ResourceKind): boolean {
  const level = prospectingLevel(civ.capabilities);
  const grid = world.grid;
  for (const d of world.deposits) {
    if (d.kind !== kind || d.remaining <= 0) continue;
    if (grid.owner[d.cell] !== civ.id || grid.land[d.cell] !== 1) continue;
    if (d.discoveredBy.includes(civ.id) || level >= d.depth) return true;
  }
  return false;
}

/** The terrain kinds a civ controls at least one cell of. */
function terrainOf(grid: Grid, civId: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < grid.owner.length; i++) {
    if (grid.owner[i] !== civId || grid.land[i] !== 1) continue;
    if (grid.river[i] > 0) out.add("river");
    if (grid.coast[i] === 1) out.add("coast");
    if (grid.fertility[i] >= FERTILE_TERRAIN_MIN) out.add("fertile");
    if (grid.forest[i] >= FOREST_TERRAIN_MIN) out.add("forest");
    if (BIOMES[grid.biome[i]] === "mountain") out.add("mountain");
    // Everything a civ can control is already flagged; keep scanning is cheap
    // enough that early-exit on a full set isn't worth the branch.
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function pushEvent(
  world: World,
  kind: EventKind,
  civ: number | null,
  cell: number | null,
  weight: number,
  text: string,
): void {
  // The one event writer; a discovery or a knowledge loss records no antecedent.
  emit(world, { kind, civ, cell, weight, text });
}
