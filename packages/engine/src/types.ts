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

export interface Settlement {
  id: number;
  civ: number;
  cell: number;
  name: string;
  founded: number;
  cohorts: Float64Array; // length AGE_BANDS
  housing: number; // dwellings
  buildings: Record<string, number>;
  unrest: number; // 0..1
  lastHarvest: number;
}

export interface Relation {
  opinion: number; // -100..100
  atWar: boolean;
  treaty: string | null;
  /** Things that happened between these two. Diplomacy has memory. */
  grievances: { year: number; note: string; weight: number }[];
  contactYear: number;
}

export interface Government {
  /** Free text — the civilisation names its own system. */
  form: string;
  legitimacy: number; // 0..1
  centralization: number; // 0..1
  established: number;
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
      const nx = ((x + dx) % GRID_W + GRID_W) % GRID_W; // wrap east–west
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

export function civPopulation(world: World, civId: number): number {
  let total = 0;
  for (const s of world.settlements) {
    if (s.civ === civId) total += settlementPop(s);
  }
  return total;
}
