/**
 * Persistence for a running world, on the built-in `node:sqlite` (Node 24, no
 * native dependency).
 *
 * Two things are stored, and the split is deliberate:
 *
 *   - **Snapshots** — the whole world state at a year, written every
 *     `SNAPSHOT_INTERVAL` years and on clean exit. The world is a "live present
 *     only" model — there is no rewind — so a snapshot is a resume point, not a
 *     history. Kept lean because the event log, not the snapshot, carries what
 *     happened: the runner drains events out of the world each tick, so the
 *     serialised snapshot's event array is empty.
 *
 *   - **Events** — an append-only log, keyed by the engine's own monotonic event
 *     id. Appending is idempotent (`ON CONFLICT(id) DO NOTHING`), which is what
 *     makes resume safe: after a crash the runner reloads the last snapshot and
 *     re-ticks the lost years, deterministically re-emitting the very same events
 *     with the very same ids, and the duplicates are dropped rather than doubled.
 *
 * The store never touches the tick's determinism: it reads and writes world
 * state as opaque base64+JSON via the engine's `serializeWorld`, and its only
 * clock use is nowhere near the tick.
 */

import { DatabaseSync } from "node:sqlite";
import {
  deserializeWorld,
  type EventKind,
  serializeWorld,
  type SerializedWorld,
  type World,
  type WorldEvent,
} from "@sim/engine";

/** Snapshot cadence, in sim-years. A crash loses at most this many years of
 *  wall-clock progress (never any determinism — the years are re-derived). */
export const SNAPSHOT_INTERVAL = 50;

/**
 * Sum a settlement's population from the base64 of its 16-band `cohorts`
 * Float64Array — the same encoding `serializeWorld` writes. Bytes are copied
 * into a fresh aligned buffer so the 8-byte Float64 read is always valid.
 */
function sumCohortsB64(b64: string): number {
  const bin = Buffer.from(b64, "base64");
  const bytes = new Uint8Array(bin.length);
  bytes.set(bin);
  const arr = new Float64Array(bytes.buffer, 0, bytes.byteLength / 8);
  let total = 0;
  for (let i = 0; i < arr.length; i++) total += arr[i];
  return total;
}

/** One metered model call, as the attention budget recorded it. `day` is the
 *  UTC calendar day (`YYYY-MM-DD`) the spend lands on — the budget's
 *  accounting unit, precomputed by the writer so reporting never re-derives
 *  timezone-dependent bucketing from `ts`. */
export interface SpendRecord {
  /** Wall-clock ms since epoch. The only clock use here; never on the tick path. */
  ts: number;
  day: string;
  /** What the call bought: "decision" (a civ mind) or "narration" (batched re-telling). */
  category: string;
  civ: number | null;
  model: string;
  /** Real dollars on API auth; CLI-reported notional dollars on subscription auth. */
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Per-day, per-category aggregate of the spend ledger. */
export interface SpendAggregate {
  day: string;
  category: string;
  calls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface EventRow {
  id: number;
  year: number;
  kind: string;
  civ: number | null;
  cell: number | null;
  weight: number;
  text: string;
  /** JSON-encoded number[] of causal-parent event ids. */
  causedBy: string | null;
}

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // WAL keeps a committed snapshot durable across a process kill (the resume
    // contract); NORMAL is the right sync level for that without paying an
    // fsync per write.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        year  INTEGER PRIMARY KEY,
        world TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY,
        year     INTEGER NOT NULL,
        kind     TEXT NOT NULL,
        civ      INTEGER,
        cell     INTEGER,
        weight   REAL NOT NULL,
        text     TEXT NOT NULL,
        causedBy TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS events_year ON events (year);
      CREATE TABLE IF NOT EXISTS spend (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       INTEGER NOT NULL,
        day      TEXT NOT NULL,
        category TEXT NOT NULL,
        civ      INTEGER,
        model    TEXT NOT NULL,
        costUsd  REAL NOT NULL,
        inputTokens         INTEGER NOT NULL,
        outputTokens        INTEGER NOT NULL,
        cacheReadTokens     INTEGER NOT NULL,
        cacheCreationTokens INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS spend_day ON spend (day);
    `);
  }

  /* --- meta ------------------------------------------------------------- */

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  /* --- snapshots -------------------------------------------------------- */

  /** Upsert the full world state at its current year. */
  saveSnapshot(world: World): void {
    const json = JSON.stringify(serializeWorld(world));
    this.db
      .prepare(
        "INSERT INTO snapshots (year, world) VALUES (?, ?) ON CONFLICT(year) DO UPDATE SET world = excluded.world",
      )
      .run(world.year, json);
  }

  /** The most advanced snapshot year, or null if none has been saved. */
  latestSnapshotYear(): number | null {
    const row = this.db.prepare("SELECT MAX(year) AS year FROM snapshots").get() as
      | { year: number | null }
      | undefined;
    return row && row.year != null ? Number(row.year) : null;
  }

  /** Load the most advanced snapshot, or null if the store is empty. */
  loadLatest(): World | null {
    const row = this.db
      .prepare("SELECT world FROM snapshots ORDER BY year DESC LIMIT 1")
      .get() as { world: string } | undefined;
    if (!row) return null;
    return deserializeWorld(JSON.parse(row.world) as SerializedWorld);
  }

  /** Load the snapshot at an exact year, or null if there is none. */
  loadAt(year: number): World | null {
    const row = this.db.prepare("SELECT world FROM snapshots WHERE year = ?").get(year) as
      | { world: string }
      | undefined;
    if (!row) return null;
    return deserializeWorld(JSON.parse(row.world) as SerializedWorld);
  }

  /**
   * Delete every snapshot older than `latestYear` that is not a keyframe
   * (a multiple of `keepEvery`). The daemon snapshots every tick so a crash
   * loses at most one year; without pruning that is a full world blob per year.
   * Keyframes stay so `settlementCensus` keeps its long history.
   */
  pruneSnapshots(latestYear: number, keepEvery: number): void {
    this.db
      .prepare("DELETE FROM snapshots WHERE year < ? AND year % ? != 0")
      .run(latestYear, keepEvery);
  }

  /**
   * Delete events at or above an id. The daemon's resume guard: a crash
   * between the event drain and the snapshot write leaves logged events from a
   * year the resumed run will re-decide — with a model in the loop the re-run
   * is not identical, and "same ids, different content" would make the
   * id-keyed dedupe silently keep the abandoned timeline's text. Pruning from
   * the loaded snapshot's own `nextEventId` closes that window.
   */
  pruneEventsFrom(id: number): void {
    this.db.prepare("DELETE FROM events WHERE id >= ?").run(id);
  }

  /* --- spend ledger ------------------------------------------------------ */

  /** Append one metered model call to the spend ledger. */
  recordSpend(r: SpendRecord): void {
    this.db
      .prepare(
        `INSERT INTO spend (ts, day, category, civ, model, costUsd,
           inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.ts,
        r.day,
        r.category,
        r.civ,
        r.model,
        r.costUsd,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
      );
  }

  /** Total dollars recorded on one UTC day — the hard-cap check reads this. */
  spentOnDay(day: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(costUsd), 0) AS c FROM spend WHERE day = ?")
      .get(day) as { c: number };
    return Number(row.c);
  }

  /** The ledger aggregated by day and category, oldest day first. */
  spendByDay(): SpendAggregate[] {
    return this.db
      .prepare(
        `SELECT day, category, COUNT(*) AS calls, SUM(costUsd) AS costUsd,
           SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens,
           SUM(cacheReadTokens) AS cacheReadTokens,
           SUM(cacheCreationTokens) AS cacheCreationTokens
         FROM spend GROUP BY day, category ORDER BY day ASC, category ASC`,
      )
      .all() as unknown as SpendAggregate[];
  }

  /* --- events ----------------------------------------------------------- */

  /** Append events, ignoring any whose id is already present. One transaction. */
  appendEvents(events: readonly WorldEvent[]): void {
    if (events.length === 0) return;
    const stmt = this.db.prepare(
      "INSERT INTO events (id, year, kind, civ, cell, weight, text, causedBy) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        stmt.run(
          e.id,
          e.year,
          e.kind,
          e.civ,
          e.cell,
          e.weight,
          e.text,
          JSON.stringify(e.causedBy),
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private static toEvent(r: EventRow): WorldEvent {
    return {
      id: r.id,
      year: r.year,
      kind: r.kind as EventKind,
      civ: r.civ,
      cell: r.cell,
      weight: r.weight,
      text: r.text,
      causedBy: r.causedBy ? (JSON.parse(r.causedBy) as number[]) : [],
    };
  }

  /** The most recent events, newest first. */
  recentEvents(limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events ORDER BY id DESC LIMIT ?",
      )
      .all(limit) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /**
   * A page of the feed, newest first, using the monotonic event id as the
   * cursor. `beforeId` returns events strictly older than that id (scroll back);
   * `afterId` returns events strictly newer, still newest-first (poll for new).
   * The two are mutually exclusive; pass at most one.
   */
  feedPage(
    limit: number,
    opts: { beforeId?: number; afterId?: number } = {},
  ): WorldEvent[] {
    let sql =
      "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events";
    const params: number[] = [];
    if (opts.beforeId !== undefined) {
      sql += " WHERE id < ?";
      params.push(opts.beforeId);
    } else if (opts.afterId !== undefined) {
      sql += " WHERE id > ?";
      params.push(opts.afterId);
    }
    sql += " ORDER BY id DESC LIMIT ?";
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /**
   * The most recent events at or above a weight — what the front page leads
   * with. Newest first; the caller re-sorts by weight for a headline band.
   */
  topEvents(minWeight: number, limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE weight >= ? ORDER BY id DESC LIMIT ?",
      )
      .all(minWeight, limit) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /** Events involving one civilisation, newest first. */
  eventsByCiv(civId: number, limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE civ = ? ORDER BY id DESC LIMIT ?",
      )
      .all(civId, limit) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /** Events that happened at one cell, newest first. */
  eventsByCell(cell: number, limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE cell = ? ORDER BY id DESC LIMIT ?",
      )
      .all(cell, limit) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /** One event by id, or null. */
  eventById(id: number): WorldEvent | null {
    const row = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE id = ?",
      )
      .get(id) as EventRow | undefined;
    return row ? Store.toEvent(row) : null;
  }

  /** A set of events by id (for causal-parent fetches). Order is unspecified. */
  eventsByIds(ids: readonly number[]): WorldEvent[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE id IN (${placeholders})`,
      )
      .all(...ids) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /**
   * The chronicle: every event at or above a weight, oldest first (chronological
   * order = ascending id), capped. This is the durable "what mattered" spine.
   */
  chronicle(minWeight: number, limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events WHERE weight >= ? ORDER BY id ASC LIMIT ?",
      )
      .all(minWeight, limit) as unknown as EventRow[];
    return rows.map(Store.toEvent);
  }

  /**
   * A settlement's population across every snapshot on record, oldest first.
   * Reads only the settlements slice of each snapshot and decodes the one
   * settlement's 16-band cohort array — never the full grid — so charting a
   * settlement's history is cheap even with many snapshots.
   */
  settlementCensus(settlementId: number): { year: number; pop: number }[] {
    const rows = this.db
      .prepare("SELECT year, world FROM snapshots ORDER BY year ASC")
      .all() as unknown as { year: number; world: string }[];
    const out: { year: number; pop: number }[] = [];
    for (const row of rows) {
      let parsed: {
        settlements?: { id: number; cohorts: string }[];
      };
      try {
        parsed = JSON.parse(row.world);
      } catch {
        continue;
      }
      const s = parsed.settlements?.find((x) => x.id === settlementId);
      if (!s) continue;
      out.push({ year: row.year, pop: sumCohortsB64(s.cohorts) });
    }
    return out;
  }

  /** Total events on record. */
  eventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events").get() as {
      n: number;
    };
    return Number(row.n);
  }

  close(): void {
    this.db.close();
  }
}
