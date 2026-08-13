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

  /** The most recent events, newest first. */
  recentEvents(limit: number): WorldEvent[] {
    const rows = this.db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events ORDER BY year DESC, id DESC LIMIT ?",
      )
      .all(limit) as unknown as EventRow[];
    return rows.map((r) => ({
      id: r.id,
      year: r.year,
      kind: r.kind as EventKind,
      civ: r.civ,
      cell: r.cell,
      weight: r.weight,
      text: r.text,
      causedBy: r.causedBy ? (JSON.parse(r.causedBy) as number[]) : [],
    }));
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
