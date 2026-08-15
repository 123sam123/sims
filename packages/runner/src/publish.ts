/**
 * Remote publisher — mirrors the daemon's local SQLite store into a shared
 * Postgres so the website (on Vercel) can read the world without touching the
 * sim host. Enabled by `DATABASE_URL`; without it the daemon runs exactly as
 * before.
 *
 * The split of authority is deliberate and must hold:
 *
 *   - **SQLite on the sim host stays authoritative.** The daemon resumes from
 *     it, the resume/dedupe contract lives there, and none of that changes.
 *   - **Postgres is a read replica for the site.** It carries the latest
 *     world snapshot (one ~2.6 MB row), the append-only event log, keyframe
 *     census points and the `daemon.status` meta — everything the pages read,
 *     nothing the tick depends on.
 *
 * Resilience contract: publishing is fire-and-forget off the tick path. A
 * Postgres outage is logged once, ticking continues, and because events are
 * re-read from the local store by id (`eventsAfter`) the replica self-heals —
 * the next successful pump pushes everything missed. Snapshot writes are
 * throttled by wall clock so a floor-pace world (a tick every 2s) does not
 * stream 2.6 MB per tick over the wire.
 *
 * Clock note: `now` is wall-clock and lives here, never on the tick path —
 * same standing as the spend ledger.
 */

import { serializeWorld, settlementPop, type World, type WorldEvent } from "@sim/engine";
import { SNAPSHOT_INTERVAL, type Store } from "./store.ts";

/** Minimum wall-clock ms between snapshot/census/status publishes. */
export const PUBLISH_SNAPSHOT_MS = 30_000;
/** Events pushed per INSERT batch (8 params per row; well under pg's limit). */
const EVENT_BATCH = 500;

/** The slice of a `pg.Pool` the publisher uses — injectable for tests. */
export interface RemoteClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PublisherOptions {
  /** Wall-clock source (tests inject a fake). */
  now?: () => number;
  log?: (line: string) => void;
  /** Min ms between snapshot publishes. */
  snapshotMs?: number;
}

interface PendingSnapshot {
  year: number;
  world: string;
  census: { settlement: number; year: number; pop: number }[];
  status: string | null;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS world_latest (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    year       INTEGER NOT NULL,
    world      TEXT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id        BIGINT PRIMARY KEY,
    year      INTEGER NOT NULL,
    kind      TEXT NOT NULL,
    civ       INTEGER,
    cell      INTEGER,
    weight    DOUBLE PRECISION NOT NULL,
    text      TEXT NOT NULL,
    caused_by TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS events_year   ON events (year);
  CREATE INDEX IF NOT EXISTS events_civ    ON events (civ, id);
  CREATE INDEX IF NOT EXISTS events_cell   ON events (cell, id);
  CREATE INDEX IF NOT EXISTS events_weight ON events (weight, id);
  CREATE TABLE IF NOT EXISTS census (
    settlement INTEGER NOT NULL,
    year       INTEGER NOT NULL,
    pop        DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (settlement, year)
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export class RemotePublisher {
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly snapshotMs: number;

  private lastPublishedEventId = -1;
  private lastSnapshotAt = -Infinity;
  private lastSnapshotYear = -Infinity;
  private pendingSnapshot: PendingSnapshot | null = null;
  private pumping = false;
  private repump = false;
  private tail: Promise<void> = Promise.resolve();
  private down = false;

  constructor(
    private readonly client: RemoteClient,
    private readonly store: Store,
    opts: PublisherOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((line) => process.stdout.write(`${line}\n`));
    this.snapshotMs = opts.snapshotMs ?? PUBLISH_SNAPSHOT_MS;
  }

  /**
   * Create the schema, apply the same resume guard the local store applies
   * (drop remote events from the abandoned timeline at or past the loaded
   * snapshot's `nextEventId`), and find where the replica's event log ends so
   * pumping resumes from there. Must succeed before the daemon starts — a
   * broken DATABASE_URL should fail loudly at boot, not silently at tick 400.
   */
  async init(world: World): Promise<void> {
    await this.client.query(SCHEMA);
    await this.client.query("DELETE FROM events WHERE id >= $1", [world.nextEventId]);
    const r = await this.client.query("SELECT COALESCE(MAX(id), -1) AS id FROM events");
    this.lastPublishedEventId = Number(r.rows[0]?.id ?? -1);
  }

  /**
   * Called after each tick's drain+snapshot (the local store is fresh).
   * Synchronously captures a consistent snapshot when the throttle allows,
   * then kicks the async pump — never awaited by the loop.
   */
  onTick(world: World): void {
    const t = this.now();
    if (world.year > this.lastSnapshotYear && t - this.lastSnapshotAt >= this.snapshotMs) {
      this.captureSnapshot(world);
      this.lastSnapshotAt = t;
      this.lastSnapshotYear = world.year;
    }
    void this.pump();
  }

  /** Flush everything (snapshot included, throttle ignored) and stop. */
  async close(world: World): Promise<void> {
    this.captureSnapshot(world);
    this.lastSnapshotYear = world.year;
    await this.pump();
    // The first await may have joined a chain already past its re-run check;
    // if our capture is still pending, one fresh pump flushes it.
    if (this.pendingSnapshot) await this.pump();
  }

  /** Serialize now, on the loop's own schedule, so the row is a bit-exact
   *  peer of the SQLite snapshot — never a mid-decide world. */
  private captureSnapshot(world: World): void {
    this.pendingSnapshot = {
      year: world.year,
      world: JSON.stringify(serializeWorld(world)),
      census: world.settlements.map((s) => ({
        settlement: s.id,
        year: world.year,
        pop: settlementPop(s),
      })),
      status: this.store.getMeta("daemon.status"),
    };
  }

  /**
   * Serialized worker: one pump in flight; a tick landing mid-pump queues
   * exactly one re-run so nothing is lost and nothing piles up. Returns the
   * in-flight chain's promise, so `close()` can await work it did not start —
   * the re-run picks up anything captured after the chain began.
   */
  private pump(): Promise<void> {
    if (this.pumping) {
      this.repump = true;
      return this.tail;
    }
    this.pumping = true;
    this.tail = (async () => {
      try {
        do {
          this.repump = false;
          await this.pushEvents();
          await this.pushSnapshot();
        } while (this.repump);
        if (this.down) {
          this.down = false;
          this.log("  ✓ remote store reachable again — replica caught up");
        }
      } catch (err) {
        if (!this.down) {
          this.down = true;
          this.log(
            `  ⚠ remote store unreachable (${err instanceof Error ? err.message : String(err)}) — ticking continues, replica will catch up`,
          );
        }
      } finally {
        this.pumping = false;
      }
    })();
    return this.tail;
  }

  private async pushEvents(): Promise<void> {
    for (;;) {
      const batch = this.store.eventsAfter(this.lastPublishedEventId, EVENT_BATCH);
      if (batch.length === 0) return;
      await this.client.query(...insertEventsSql(batch));
      this.lastPublishedEventId = batch[batch.length - 1].id;
      if (batch.length < EVENT_BATCH) return;
    }
  }

  private async pushSnapshot(): Promise<void> {
    const snap = this.pendingSnapshot;
    if (!snap) return;
    await this.client.query(
      `INSERT INTO world_latest (id, year, world, updated_at) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET year = excluded.year, world = excluded.world, updated_at = excluded.updated_at`,
      [snap.year, snap.world, this.now()],
    );
    for (const c of snap.census) {
      await this.client.query(
        "INSERT INTO census (settlement, year, pop) VALUES ($1, $2, $3) ON CONFLICT (settlement, year) DO UPDATE SET pop = excluded.pop",
        [c.settlement, c.year, c.pop],
      );
    }
    // Same retention as pruneSnapshots: keyframe years plus the latest.
    await this.client.query("DELETE FROM census WHERE year < $1 AND year % $2 != 0", [
      snap.year,
      SNAPSHOT_INTERVAL,
    ]);
    if (snap.status !== null) {
      await this.client.query(
        "INSERT INTO meta (key, value) VALUES ('daemon.status', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        [snap.status],
      );
    }
    // Only clear if no fresher capture landed while the writes were in flight.
    if (this.pendingSnapshot === snap) this.pendingSnapshot = null;
  }
}

/** Build one multi-row idempotent INSERT for a batch of events. */
export function insertEventsSql(events: readonly WorldEvent[]): [string, unknown[]] {
  const values: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const base = i * 8;
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
    params.push(e.id, e.year, e.kind, e.civ, e.cell, e.weight, e.text, JSON.stringify(e.causedBy));
  }
  return [
    `INSERT INTO events (id, year, kind, civ, cell, weight, text, caused_by) VALUES ${values.join(", ")} ON CONFLICT (id) DO NOTHING`,
    params,
  ];
}
