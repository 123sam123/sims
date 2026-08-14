import type { ResourceKind } from "./geo-data.ts";

export const GRID_W = 360;
export const GRID_H = 180;
export const CELL_COUNT = GRID_W * GRID_H;

export type Biome =
  | "ocean"
  | "ice"
  | "tundra"
  | "taiga"
  | "temperate_forest"
  | "grassland"
  | "steppe"
  | "desert"
  | "savanna"
  | "tropical_forest"
  | "mountain"
  | "wetland";

/**
 * The physical planet. Typed arrays because there are 64,800 cells and the tick
 * touches most of them. Index = y * GRID_W + x, y=0 is the north pole.
 */
export interface Grid {
  land: Uint8Array;
  elevation: Float32Array; // 0..1
  temperature: Float32Array; // mean annual °C
  rainfall: Float32Array; // 0..1
  river: Float32Array; // 0..1 flow, 0 = none
  coast: Uint8Array;
  fertility: Float32Array; // 0..1, what farming yields here
  forest: Float32Array; // 0..1, depletes when cut
  biome: Uint8Array; // index into BIOMES
  owner: Int16Array; // civ id, -1 = unclaimed
  settlement: Int16Array; // settlement id, -1 = none
}

export const BIOMES: Biome[] = [
  "ocean",
  "ice",
  "tundra",
  "taiga",
  "temperate_forest",
  "grassland",
  "steppe",
  "desert",
  "savanna",
  "tropical_forest",
  "mountain",
  "wetland",
];

export interface Deposit {
  kind: ResourceKind;
  name: string;
  cell: number;
  richness: number;
  depth: number; // capability threshold needed to find/extract
  remaining: number; // finite
  discoveredBy: number[]; // civ ids
}

/** Goods a civilisation actually holds. Everything is produced from something. */
export interface Stores {
  food: number;
  wood: number;
  stone: number;
  copper: number;
  tin: number;
  iron: number;
  coal: number;
  tools: number;
  cloth: number;
  luxury: number;
}

export const EMPTY_STORES: Stores = {
  food: 0,
  wood: 0,
  stone: 0,
  copper: 0,
  tin: 0,
  iron: 0,
  coal: 0,
  tools: 0,
  cloth: 0,
  luxury: 0,
};

export type StoreKey = keyof Stores;

/** 16 five-year bands, 0-4 .. 75-79. Anyone older is folded into the last band. */
export const AGE_BANDS = 16;

/**
 * Single years of age, 0..79. The band view above is what the rest of the
 * simulation reads, but ageing has to happen at one-year resolution: moving a
 * fixed fraction of a five-year band each tick makes band residence
 * exponential rather than five years, which lets people reach the fertile
 * bands years early and inflates growth several-fold. So `ages` is the
 * authoritative state and `cohorts` is a derived view.
 */
export const AGE_SLOTS = AGE_BANDS * 5;

export interface Settlement {
  id: number;
  civ: number;
  cell: number;
  name: string;
  founded: number;
  /** Authoritative population state: one slot per year of age, 0..79. */
  ages: Float64Array; // length AGE_SLOTS
  /** Derived five-year view of `ages`, refreshed by every population step. */
  cohorts: Float64Array; // length AGE_BANDS
  housing: number; // dwellings
  buildings: Record<string, number>;
  unrest: number; // 0..1
  /** Last local food ratio (carrying capacity / need). 1 = exactly fed. */
  lastHarvest: number;
  /**
   * Consecutive years this settlement's local food supply has collapsed.
   * The settlement layer resets it on any fed year and abandons the site once
   * it reaches `ABANDON_YEARS`. Optional so older constructors keep working.
   */
  leanYears?: number;
}

/**
 * What one civilisation believes about another. Never the truth — a snapshot
 * taken through some channel (first contact, trade, spies), noisy at capture
 * and staler every year after `asOf`. The world moves on; the belief does not.
 */
export interface CivBelief {
  /** Believed total population. */
  population: number;
  /** Believed sophistication (rough era of their most advanced capability). */
  era: number;
  /** Believed military strength (troops). */
  military: number;
  /** Year the estimate was taken. Staleness IS the inaccuracy. */
  asOf: number;
}

export interface Relation {
  opinion: number; // -100..100
  atWar: boolean;
  treaty: string | null;
  /** Things that happened between these two. Diplomacy has memory. */
  grievances: { year: number; note: string; weight: number }[];
  contactYear: number;
  /**
   * All fields below are optional so pre-diplomacy snapshots keep loading;
   * the diplomacy layer treats a missing field as its empty value.
   */
  /** Year the current treaty was sworn. */
  treatySince?: number;
  /** A standing treaty offer made by this civ, awaiting the counterpart. */
  treatyOffer?: number | null;
  /** Year an active trade route with this civ opened; null/absent = none. */
  tradeSince?: number | null;
  /** What this civ believes about the other. See {@link CivBelief}. */
  belief?: CivBelief | null;
  /** Messages received from the other, relayed by the engine. Bounded. */
  inbox?: { year: number; text: string }[];
  /** Event ids of first contact / route opening — causal anchors. */
  contactEvent?: number;
  tradeEvent?: number;
}

/**
 * A standing espionage order. The agent proposes it (a `spy` directive); the
 * engine resolves it in a later tick with a seeded roll of the sender's agency
 * against the target's counter-intelligence — success is never an agent
 * decision, and detection leaves a grievance behind.
 */
export interface EspionageOp {
  /** Civ id the operation is run against. */
  target: number;
  /** Steal a capability, or assess the target (refresh beliefs). */
  mission: "steal" | "assess";
  /** For `steal`: the capability hoped for. Unset = whatever the spies find. */
  capability?: string;
  /** Year the order was given. */
  year: number;
}

/**
 * A unit of accepted, standing work the engine executes over several years.
 *
 * An agent *proposes* a directive; the agent layer adjudicates it against the
 * six gates and, when a construction or settlement directive survives, turns it
 * into a `Project` queued on the civ. The tick's directive-execution stage draws
 * the civ's building labour and materials against it each year until it
 * completes — which is exactly what makes an accepted order take effect over the
 * *following* years rather than instantly. Plain JSON, so it rides along in the
 * civ snapshot with no serialisation change.
 */
export interface Project {
  kind: "construct" | "settle";
  /** What is being raised — a free-text structure name, or "settlement". */
  building: string;
  /** Settlement it is built at (the civ's seat, for a new-colony project). */
  settlement: number;
  /** Labour-years of building effort still required. */
  remaining: number;
  /** Labour-years the project needed in total — for progress and reporting. */
  total: number;
  /** Materials still owed, drawn from `Civ.stores` as they become available. */
  cost: Partial<Stores>;
  /** Year the directive that spawned this was accepted. */
  started: number;
  /** The civilisation's own words for why — carried into the completion event. */
  note: string;
}

export interface Government {
  /** Free text — the civilisation names its own system. */
  form: string;
  legitimacy: number; // 0..1
  centralization: number; // 0..1
  established: number;
}

/**
 * Who actually carries a held capability — and whether losing them loses it.
 *
 * A capability is not owned by a civilisation in the abstract; it is held by
 * particular people and institutions. If the carriers die and it was never
 * written down, the knowledge is gone. This is how a dark age happens here
 * without anyone scripting one.
 */
export interface CapabilityHolders {
  /** Rough number of living people who carry this knowledge. */
  people: number;
  /** Institutions that also hold it — an archive, a school, a craft guild. */
  institutions: string[];
  /** Recorded in writing? Written knowledge survives its last practitioner. */
  written: boolean;
}

export interface Civ {
  id: number;
  key: string;
  /** Chosen by the civilisation itself once it can name things. */
  name: string;
  color: string;
  /** Starting disposition. Influences, does not determine. */
  doctrine: string;
  capabilities: string[];
  research: { target: string | null; progress: number };
  /**
   * Per held capability: who holds it and whether it is written down. Kept in
   * step with `capabilities` by the research layer; the key set mirrors what the
   * civ currently knows.
   */
  holders: Record<string, CapabilityHolders>;
  /**
   * Capabilities this civ once held and lost. Ruins and survivors remain, so
   * these are cheaper to re-discover than to invent from nothing.
   */
  forgotten: string[];
  stores: Stores;
  government: Government;
  policy: {
    farming: number;
    building: number;
    research: number;
    military: number;
  };
  military: { troops: number; equipment: number; morale: number };
  relations: Record<number, Relation>;
  /** What this civ believes about the world. Never the truth, only its view. */
  known: number[]; // other civ ids it has met
  /** Institutional memory — what survives a leader's death. */
  chronicle: string[];
  /** Standing orders from the last decision, executed over following years. */
  agenda: string[];
  /**
   * Accepted construction/settlement work, executed by the tick's directive
   * stage over the following years. Optional so pre-agent snapshots still load;
   * the executor treats a missing queue as empty.
   */
  projects?: Project[];
  /**
   * Standing espionage orders, resolved by the tick's diplomacy stage in a
   * later year. Optional for the same snapshot-compatibility reason.
   */
  espionage?: EspionageOp[];
  alive: boolean;
  extinctYear?: number;
}

export interface Person {
  id: number;
  civ: number;
  name: string;
  born: number;
  died: number | null;
  role: string;
  note: string;
}

export type EventKind =
  | "founding"
  | "discovery"
  | "settlement"
  | "war"
  | "battle"
  | "peace"
  | "contact"
  | "famine"
  | "plague"
  | "disaster"
  | "government"
  | "growth"
  | "collapse"
  | "decision"
  | "refusal"
  | "person"
  | "trade";

export interface WorldEvent {
  id: number;
  year: number;
  kind: EventKind;
  civ: number | null;
  cell: number | null;
  /** Magnitude 0..1 — drives what the news feed leads with. */
  weight: number;
  text: string;
  /**
   * Ids of the events that produced this one — the world's causal memory.
   * A famine points at the harvest failure behind it; a war at the grievance
   * that lit it. Empty when the event has no recorded antecedent. Append-only:
   * set once at emission, never mutated.
   */
  causedBy: number[];
}

export interface World {
  seed: number;
  year: number;
  grid: Grid;
  deposits: Deposit[];
  civs: Civ[];
  settlements: Settlement[];
  people: Person[];
  events: WorldEvent[];
  nextSettlementId: number;
  nextPersonId: number;
  nextEventId: number;
}

export const cellIndex = (x: number, y: number) => y * GRID_W + x;
export const cellX = (i: number) => i % GRID_W;
export const cellY = (i: number) => Math.floor(i / GRID_W);
/** Grid is equirectangular: x=0 is 180°W, y=0 is 90°N. */
export const cellLat = (i: number) => 90 - (Math.floor(i / GRID_W) + 0.5);
export const cellLon = (i: number) => (i % GRID_W) - 180 + 0.5;

export function latLonToCell(lat: number, lon: number): number {
  const y = Math.min(GRID_H - 1, Math.max(0, Math.floor(90 - lat)));
  let lx = Math.floor(lon + 180);
  lx = ((lx % GRID_W) + GRID_W) % GRID_W;
  return cellIndex(lx, y);
}

/** Great-circle-ish distance in km between two cells. */
export function cellDistance(a: number, b: number): number {
  const la = (cellLat(a) * Math.PI) / 180;
  const lb = (cellLat(b) * Math.PI) / 180;
  const dLat = lb - la;
  let dLon = ((cellLon(b) - cellLon(a)) * Math.PI) / 180;
  if (dLon > Math.PI) dLon -= 2 * Math.PI;
  if (dLon < -Math.PI) dLon += 2 * Math.PI;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function neighbors(i: number): number[] {
  const x = cellX(i);
  const y = cellY(i);
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const ny = y + dy;
      if (ny < 0 || ny >= GRID_H) continue;
      const nx = (((x + dx) % GRID_W) + GRID_W) % GRID_W; // wrap east–west
      out.push(cellIndex(nx, ny));
    }
  }
  return out;
}

export function settlementPop(s: Settlement): number {
  let total = 0;
  for (let i = 0; i < AGE_BANDS; i++) total += s.cohorts[i];
  return total;
}

/** Recompute the five-year `cohorts` view from the authoritative `ages` slots. */
export function refreshCohorts(s: Settlement): void {
  for (let b = 0; b < AGE_BANDS; b++) {
    const base = b * 5;
    s.cohorts[b] =
      s.ages[base] +
      s.ages[base + 1] +
      s.ages[base + 2] +
      s.ages[base + 3] +
      s.ages[base + 4];
  }
}

/**
 * Build a settlement's age state from a coarse five-year shape, spreading each
 * band evenly across its five single-year slots and scaling the whole thing to
 * `total` people. This is how worldgen and tests seed a population.
 */
export function seedAges(shape: readonly number[], total: number): Float64Array {
  const ages = new Float64Array(AGE_SLOTS);
  let sum = 0;
  for (let b = 0; b < AGE_BANDS; b++) sum += shape[b] ?? 0;
  if (sum <= 0) return ages;
  for (let b = 0; b < AGE_BANDS; b++) {
    const per = (((shape[b] ?? 0) / sum) * total) / 5;
    for (let i = 0; i < 5; i++) ages[b * 5 + i] = per;
  }
  return ages;
}

export function civPopulation(world: World, civId: number): number {
  let total = 0;
  for (const s of world.settlements) {
    if (s.civ === civId) total += settlementPop(s);
  }
  return total;
}
