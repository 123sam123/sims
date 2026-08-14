/**
 * Server-only read layer over the live world.
 *
 * Everything the spectator pages show is derived here from two sources, both
 * read-only:
 *   - the current `World` (the runner's most-advanced snapshot, or a freshly
 *     generated year-0 Earth when no store exists), and
 *   - the append-only event log (queried straight out of the `node:sqlite`
 *     store, or read off the in-memory world when there is no store yet).
 *
 * The app NEVER writes world state. This module uses Node APIs (`node:fs`, and
 * the runner's `Store`) and must only ever run on the server — it is imported by
 * server components and route handlers, never by a `"use client"` module.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
  blockedBecause,
  BIOMES,
  type Capability,
  CAPABILITIES,
  CAPABILITY_BY_ID,
  type Civ,
  cellLat,
  civPopulation,
  generateWorld,
  GRID_W,
  researchable,
  researchGates,
  settlementPop,
  type World,
  type WorldEvent,
} from "@sim/engine";
import {
  cellCoords,
  type FeedItem,
  formatPercent,
  kindLabel,
} from "./format";

const SEED = Number(process.env.WORLD_SEED ?? 1);
const DB_PATH =
  process.env.WORLD_DB ?? path.resolve(process.cwd(), "../../worlds/world.db");

/** The weight above which an event is "what mattered" — the chronicle spine. */
export const CHRONICLE_WEIGHT = 0.6;

/* ------------------------------------------------------------------ *
 * Event access — one interface, two backings (sqlite store / in-memory)
 * ------------------------------------------------------------------ */

interface EventSource {
  feedPage(limit: number, opts?: { beforeId?: number; afterId?: number }): WorldEvent[];
  topEvents(minWeight: number, limit: number): WorldEvent[];
  eventsByCiv(civId: number, limit: number): WorldEvent[];
  eventsByCell(cell: number, limit: number): WorldEvent[];
  eventById(id: number): WorldEvent | null;
  eventsByIds(ids: readonly number[]): WorldEvent[];
  chronicle(minWeight: number, limit: number): WorldEvent[];
  settlementCensus(settlementId: number): { year: number; pop: number }[];
}

/** Fallback backing when there is no store: query the world's own event array. */
class MemoryEvents implements EventSource {
  constructor(private readonly all: readonly WorldEvent[]) {}
  private desc() {
    return [...this.all].sort((a, b) => b.id - a.id);
  }
  feedPage(limit: number, opts: { beforeId?: number; afterId?: number } = {}) {
    let rows = this.desc();
    if (opts.beforeId !== undefined) rows = rows.filter((e) => e.id < opts.beforeId!);
    else if (opts.afterId !== undefined) rows = rows.filter((e) => e.id > opts.afterId!);
    return rows.slice(0, limit);
  }
  topEvents(minWeight: number, limit: number) {
    return this.desc().filter((e) => e.weight >= minWeight).slice(0, limit);
  }
  eventsByCiv(civId: number, limit: number) {
    return this.desc().filter((e) => e.civ === civId).slice(0, limit);
  }
  eventsByCell(cell: number, limit: number) {
    return this.desc().filter((e) => e.cell === cell).slice(0, limit);
  }
  eventById(id: number) {
    return this.all.find((e) => e.id === id) ?? null;
  }
  eventsByIds(ids: readonly number[]) {
    const want = new Set(ids);
    return this.all.filter((e) => want.has(e.id));
  }
  chronicle(minWeight: number, limit: number) {
    return this.all.filter((e) => e.weight >= minWeight).slice(0, limit);
  }
  settlementCensus() {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Loading the current world (heavy) is cached against the store file
 * ------------------------------------------------------------------ */

interface WorldCache {
  key: string;
  world: World;
}
let worldCache: WorldCache | null = null;

function dbFileStat(): ReturnType<typeof statSync> | null {
  try {
    const s = statSync(DB_PATH);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

function sourceKey(): string {
  const s = dbFileStat();
  return s ? `db:${s.size}:${s.mtimeMs}` : `gen:${SEED}`;
}

interface Source {
  world: World;
  events: EventSource;
  close: () => void;
}

/**
 * Open the current world and an event source. The world (a heavy typed-array
 * snapshot) is memoised against the store file's size+mtime so repeated page
 * loads between ticks cost only a cheap store open, not a re-deserialize.
 */
async function openSource(): Promise<Source> {
  const key = sourceKey();
  const cachedWorld = worldCache?.key === key ? worldCache.world : null;

  if (dbFileStat()) {
    try {
      const { Store } = await import("@sim/runner");
      const store = new Store(DB_PATH);
      let world = cachedWorld;
      if (!world) {
        world = store.loadLatest() ?? generateWorld(SEED);
        worldCache = { key, world };
      }
      return { world, events: store, close: () => store.close() };
    } catch {
      // fall through to a generated world with no events
    }
  }

  const world = cachedWorld ?? generateWorld(SEED);
  if (!cachedWorld) worldCache = { key, world };
  return { world, events: new MemoryEvents(world.events), close: () => {} };
}

/* ------------------------------------------------------------------ *
 * Lookups + the flat FeedItem mapping
 * ------------------------------------------------------------------ */

function civById(world: World): Map<number, Civ> {
  return new Map(world.civs.map((c) => [c.id, c]));
}

/** cell index -> the settlement standing on it (for linking an event to a place). */
function settlementByCell(world: World): Map<number, { id: number; name: string }> {
  const m = new Map<number, { id: number; name: string }>();
  for (const s of world.settlements) m.set(s.cell, { id: s.id, name: s.name });
  return m;
}

function toFeedItem(
  e: WorldEvent,
  civs: Map<number, Civ>,
  places: Map<number, { id: number; name: string }>,
): FeedItem {
  const civ = e.civ != null ? civs.get(e.civ) : undefined;
  const place = e.cell != null ? places.get(e.cell) : undefined;
  return {
    id: e.id,
    year: e.year,
    kind: e.kind,
    weight: e.weight,
    text: e.text,
    cell: e.cell,
    civKey: civ?.key ?? null,
    civName: civ?.name ?? null,
    civColor: civ?.color ?? null,
    settlementId: place?.id ?? null,
    settlementName: place?.name ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Shared civ chip (header rail)
 * ------------------------------------------------------------------ */

export interface CivChip {
  key: string;
  name: string;
  color: string;
  alive: boolean;
  population: number;
  settlements: number;
  capabilities: number;
}

function civChips(world: World): CivChip[] {
  return world.civs
    .map((c) => ({
      key: c.key,
      name: c.name,
      color: c.color,
      alive: c.alive,
      population: Math.round(civPopulation(world, c.id)),
      settlements: world.settlements.filter((s) => s.civ === c.id).length,
      capabilities: c.capabilities.length,
    }))
    .sort((a, b) => b.population - a.population);
}

/* ------------------------------------------------------------------ *
 * Front page — headlines + live stream
 * ------------------------------------------------------------------ */

export interface FeedBundle {
  year: number;
  hasHistory: boolean;
  civs: CivChip[];
  headlines: FeedItem[];
  stream: FeedItem[];
}

export async function getFeedBundle(): Promise<FeedBundle> {
  const { world, events, close } = await openSource();
  try {
    const civs = civById(world);
    const places = settlementByCell(world);
    const headlines = events
      .topEvents(CHRONICLE_WEIGHT, 8)
      .map((e) => toFeedItem(e, civs, places))
      .sort((a, b) => b.weight - a.weight || b.id - a.id);
    const stream = events.feedPage(40).map((e) => toFeedItem(e, civs, places));
    return {
      year: world.year,
      hasHistory: stream.length > 0,
      civs: civChips(world),
      headlines,
      stream,
    };
  } finally {
    close();
  }
}

/** A page of the feed for polling (`after` = newer) or scroll-back (`before`). */
export async function getFeedPage(opts: {
  before?: number;
  after?: number;
  limit?: number;
}): Promise<{ year: number; items: FeedItem[] }> {
  const { world, events, close } = await openSource();
  try {
    const civs = civById(world);
    const places = settlementByCell(world);
    const rows = events.feedPage(opts.limit ?? 40, {
      beforeId: opts.before,
      afterId: opts.after,
    });
    return { year: world.year, items: rows.map((e) => toFeedItem(e, civs, places)) };
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Civilisation page
 * ------------------------------------------------------------------ */

export interface CapEntry {
  id: string;
  name: string;
  era: number;
  what: string;
}
export interface WallEntry extends CapEntry {
  reason: string;
}
export interface RelationEntry {
  key: string;
  name: string;
  color: string;
  alive: boolean;
  opinion: number;
  atWar: boolean;
  treaty: string | null;
}
export interface CivSettlement {
  id: number;
  name: string;
  pop: number;
  founded: number;
  coords: string;
}
export interface CivPage {
  key: string;
  name: string;
  color: string;
  alive: boolean;
  extinctYear: number | null;
  doctrine: string;
  year: number;
  population: number;
  settlementCount: number;
  territoryCells: number;
  territoryKm2: number;
  terrains: string[];
  government: {
    form: string;
    legitimacy: string;
    centralization: string;
    established: number;
  };
  research: { target: string | null; progress: string } | null;
  held: CapEntry[];
  reach: CapEntry[];
  walls: WallEntry[];
  forgotten: CapEntry[];
  capsHeld: number;
  capsTotal: number;
  relations: RelationEntry[];
  chronicleLines: string[];
  notable: FeedItem[];
  settlements: CivSettlement[];
}

const TERRAIN_KINDS = ["river", "coast", "fertile", "forest", "mountain"] as const;

function toCapEntry(id: string): CapEntry {
  const c = CAPABILITY_BY_ID.get(id);
  return {
    id,
    name: c?.name ?? id,
    era: c?.era ?? 0,
    what: c?.what ?? "",
  };
}

/** A ~1°×1° cell's ground area in km², shrinking toward the poles. */
function cellAreaKm2(cell: number): number {
  const latRad = (cellLat(cell) * Math.PI) / 180;
  return 111.32 * 111.32 * Math.max(0, Math.cos(latRad));
}

export async function getCivPage(key: string): Promise<CivPage | null> {
  const { world, events, close } = await openSource();
  try {
    const civ = world.civs.find((c) => c.key === key);
    if (!civ) return null;

    const gates = researchGates(world, civ.id);
    const held = new Set(civ.capabilities);

    // Territory: one pass over ownership for cell count + poleward-shrunk area.
    let cells = 0;
    let km2 = 0;
    const owner = world.grid.owner;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] === civ.id) {
        cells++;
        km2 += cellAreaKm2(i);
      }
    }

    // Capabilities: held / within-reach-now / walled-off-by-the-physical-world.
    const reachSet = new Set(
      researchable(held, gates.hasMaterial, gates.hasTerrain, gates.population).map(
        (c) => c.id,
      ),
    );
    const reach: CapEntry[] = [];
    const walls: WallEntry[] = [];
    for (const cap of CAPABILITIES) {
      if (held.has(cap.id)) continue;
      if (reachSet.has(cap.id)) {
        reach.push(toCapEntry(cap.id));
        continue;
      }
      const reason = blockedBecause(
        cap as Capability,
        held,
        gates.hasMaterial,
        gates.hasTerrain,
        gates.population,
      );
      // A "requires X first" block is just tree depth — implied, not shown.
      // Surface only the physical walls: no ore, no coastline, too few people.
      if (reason && !reason.startsWith("requires")) {
        walls.push({ ...toCapEntry(cap.id), reason });
      }
    }
    reach.sort((a, b) => a.era - b.era || a.name.localeCompare(b.name));
    walls.sort((a, b) => a.era - b.era || a.name.localeCompare(b.name));

    const civs = civById(world);
    const places = settlementByCell(world);
    const notable = events
      .eventsByCiv(civ.id, 400)
      .filter((e) => e.weight >= 0.4)
      .slice(0, 40)
      .map((e) => toFeedItem(e, civs, places));

    const relations: RelationEntry[] = Object.entries(civ.relations)
      .map(([otherId, rel]) => {
        const other = civs.get(Number(otherId));
        if (!other) return null;
        return {
          key: other.key,
          name: other.name,
          color: other.color,
          alive: other.alive,
          opinion: Math.round(rel.opinion),
          atWar: rel.atWar,
          treaty: rel.treaty,
        };
      })
      .filter((r): r is RelationEntry => r !== null)
      .sort((a, b) => b.opinion - a.opinion);

    const target = civ.research.target
      ? CAPABILITY_BY_ID.get(civ.research.target)?.name ?? civ.research.target
      : null;

    return {
      key: civ.key,
      name: civ.name,
      color: civ.color,
      alive: civ.alive,
      extinctYear: civ.extinctYear ?? null,
      doctrine: civ.doctrine,
      year: world.year,
      population: Math.round(civPopulation(world, civ.id)),
      settlementCount: world.settlements.filter((s) => s.civ === civ.id).length,
      territoryCells: cells,
      territoryKm2: km2,
      terrains: TERRAIN_KINDS.filter((t) => gates.hasTerrain(t)),
      government: {
        form: civ.government.form,
        legitimacy: formatPercent(civ.government.legitimacy),
        centralization: formatPercent(civ.government.centralization),
        established: civ.government.established,
      },
      research: civ.research.target
        ? { target, progress: formatPercent(civ.research.progress) }
        : null,
      held: civ.capabilities.map(toCapEntry).sort((a, b) => a.era - b.era),
      reach,
      walls,
      forgotten: civ.forgotten.map(toCapEntry).sort((a, b) => a.era - b.era),
      capsHeld: civ.capabilities.length,
      capsTotal: CAPABILITIES.length,
      relations,
      chronicleLines: civ.chronicle,
      notable,
      settlements: world.settlements
        .filter((s) => s.civ === civ.id)
        .map((s) => ({
          id: s.id,
          name: s.name,
          pop: Math.round(settlementPop(s)),
          founded: s.founded,
          coords: cellCoords(s.cell, GRID_W),
        }))
        .sort((a, b) => b.pop - a.pop),
    };
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Settlement page
 * ------------------------------------------------------------------ */

export interface SettlementPage {
  id: number;
  name: string;
  founded: number;
  year: number;
  pop: number;
  housing: number;
  unrest: string;
  coords: string;
  biome: string;
  river: boolean;
  civ: { key: string; name: string; color: string } | null;
  census: { year: number; pop: number }[];
  events: FeedItem[];
}

export async function getSettlementPage(id: number): Promise<SettlementPage | null> {
  const { world, events, close } = await openSource();
  try {
    const s = world.settlements.find((x) => x.id === id);
    if (!s) return null;
    const civ = world.civs.find((c) => c.id === s.civ) ?? null;

    const census = events.settlementCensus(id);
    const pop = Math.round(settlementPop(s));
    // Keep the chart current: append the live year if the last snapshot is older.
    if (census.length === 0 || census[census.length - 1].year < world.year) {
      census.push({ year: world.year, pop });
    }

    const civs = civById(world);
    const places = settlementByCell(world);

    return {
      id: s.id,
      name: s.name,
      founded: s.founded,
      year: world.year,
      pop,
      housing: s.housing,
      unrest: formatPercent(s.unrest),
      coords: cellCoords(s.cell, GRID_W),
      biome: BIOMES[world.grid.biome[s.cell]] ?? "land",
      river: world.grid.river[s.cell] > 0,
      civ: civ ? { key: civ.key, name: civ.name, color: civ.color } : null,
      census: census.map((c) => ({ year: c.year, pop: Math.round(c.pop) })),
      events: events.eventsByCell(s.cell, 100).map((e) => toFeedItem(e, civs, places)),
    };
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Event page — the causal walk
 * ------------------------------------------------------------------ */

export interface EventPage {
  item: FeedItem;
  kindLabel: string;
  causes: FeedItem[];
  ancestry: FeedItem[];
}

/** Walk `causedBy` transitively out of the store, nearest cause first. */
function traceAncestry(events: EventSource, start: WorldEvent): WorldEvent[] {
  const out: WorldEvent[] = [];
  const seen = new Set<number>([start.id]);
  let frontier = [...start.causedBy];
  while (frontier.length > 0) {
    const parents = events.eventsByIds(frontier.filter((id) => !seen.has(id)));
    const next: number[] = [];
    for (const p of parents) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
      next.push(...p.causedBy);
    }
    if (parents.length === 0) break;
    frontier = next;
  }
  return out;
}

export async function getEventPage(id: number): Promise<EventPage | null> {
  const { world, events, close } = await openSource();
  try {
    const e = events.eventById(id);
    if (!e) return null;
    const civs = civById(world);
    const places = settlementByCell(world);

    // Immediate causes in the order they were recorded.
    const parentById = new Map(events.eventsByIds(e.causedBy).map((p) => [p.id, p]));
    const causes = e.causedBy
      .map((pid) => parentById.get(pid))
      .filter((p): p is WorldEvent => p !== undefined)
      .map((p) => toFeedItem(p, civs, places));

    const ancestry = traceAncestry(events, e).map((p) => toFeedItem(p, civs, places));

    return {
      item: toFeedItem(e, civs, places),
      kindLabel: kindLabel(e.kind),
      causes,
      ancestry,
    };
  } finally {
    close();
  }
}

/* ------------------------------------------------------------------ *
 * Chronicle — the durable spine of what mattered
 * ------------------------------------------------------------------ */

export interface ChroniclePage {
  year: number;
  from: number | null;
  to: number | null;
  entries: FeedItem[];
}

export async function getChroniclePage(): Promise<ChroniclePage> {
  const { world, events, close } = await openSource();
  try {
    const civs = civById(world);
    const places = settlementByCell(world);
    const rows = events.chronicle(CHRONICLE_WEIGHT, 600);
    const entries = rows.map((e) => toFeedItem(e, civs, places));
    return {
      year: world.year,
      from: rows.length ? rows[0].year : null,
      to: rows.length ? rows[rows.length - 1].year : null,
      entries,
    };
  } finally {
    close();
  }
}
