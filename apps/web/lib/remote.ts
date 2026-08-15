/**
 * Server-side: the shared Postgres read store, when `DATABASE_URL` is set.
 *
 * On Vercel there is no filesystem shared with the sim host, so the site reads
 * the replica the daemon publishes (see `packages/runner/src/publish.ts`): the
 * latest world snapshot as one row, the append-only event log, keyframe census
 * points and the `daemon.status` meta. Everything here is read-only — the
 * daemon is the only writer, ever.
 *
 * The world row is ~2.6 MB, so it is memoised per warm server instance against
 * a cheap `(year, updated_at)` version probe; steady-state page loads cost a
 * couple of small queries. If the probe fails (store unreachable), the caller
 * falls back — last memoised world first, generated Earth last — so the site
 * degrades instead of erroring.
 *
 * This module uses Node APIs (`pg`) and must only ever run on the server.
 */

import { deserializeWorld, type SerializedWorld, type World, type WorldEvent } from "@sim/engine";
import { Pool } from "pg";

export function remoteEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

let pool: Pool | null = null;
function db(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 3,
      // A serverless instance should fail fast and fall back, not hang a page.
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

/* ------------------------------------------------------------------ *
 * The world — one row, memoised against its version
 * ------------------------------------------------------------------ */

interface RemoteWorldCache {
  key: string;
  world: World;
}
let worldCache: RemoteWorldCache | null = null;

/**
 * The replica's current version key, or null when the daemon has never
 * published (empty table). Throws when the store is unreachable — callers
 * catch and degrade.
 */
export async function remoteSourceKey(): Promise<string | null> {
  const r = await db().query("SELECT year, updated_at FROM world_latest WHERE id = 1");
  if (r.rows.length === 0) return null;
  const { year, updated_at } = r.rows[0] as { year: number; updated_at: string };
  return `pg:${year}:${updated_at}`;
}

/** The latest published world, deserialized, memoised per version key. */
export async function loadRemoteWorld(key: string): Promise<World | null> {
  if (worldCache?.key === key) return worldCache.world;
  const r = await db().query("SELECT world FROM world_latest WHERE id = 1");
  if (r.rows.length === 0) return null;
  const world = deserializeWorld(
    JSON.parse((r.rows[0] as { world: string }).world) as SerializedWorld,
  );
  worldCache = { key, world };
  return world;
}

/** The last world this instance managed to load, for store-down degradation. */
export function lastKnownRemoteWorld(): World | null {
  return worldCache?.world ?? null;
}

/* ------------------------------------------------------------------ *
 * Events — the same query surface the SQLite store exposes
 * ------------------------------------------------------------------ */

interface PgEventRow {
  id: string | number;
  year: number;
  kind: string;
  civ: number | null;
  cell: number | null;
  weight: number;
  text: string;
  caused_by: string | null;
}

function toEvent(r: PgEventRow): WorldEvent {
  return {
    id: Number(r.id),
    year: r.year,
    kind: r.kind as WorldEvent["kind"],
    civ: r.civ,
    cell: r.cell,
    weight: r.weight,
    text: r.text,
    causedBy: r.caused_by ? (JSON.parse(r.caused_by) as number[]) : [],
  };
}

const COLS = "id, year, kind, civ, cell, weight, text, caused_by";

async function rows(text: string, params: unknown[] = []): Promise<WorldEvent[]> {
  const r = await db().query(text, params);
  return (r.rows as unknown as PgEventRow[]).map(toEvent);
}

/** Postgres-backed event source, shaped exactly like the store's queries. */
export const remoteEvents = {
  feedPage(limit: number, opts: { beforeId?: number; afterId?: number } = {}) {
    if (opts.beforeId !== undefined) {
      return rows(`SELECT ${COLS} FROM events WHERE id < $1 ORDER BY id DESC LIMIT $2`, [
        opts.beforeId,
        limit,
      ]);
    }
    if (opts.afterId !== undefined) {
      return rows(`SELECT ${COLS} FROM events WHERE id > $1 ORDER BY id DESC LIMIT $2`, [
        opts.afterId,
        limit,
      ]);
    }
    return rows(`SELECT ${COLS} FROM events ORDER BY id DESC LIMIT $1`, [limit]);
  },
  topEvents(minWeight: number, limit: number) {
    return rows(`SELECT ${COLS} FROM events WHERE weight >= $1 ORDER BY id DESC LIMIT $2`, [
      minWeight,
      limit,
    ]);
  },
  eventsByCiv(civId: number, limit: number) {
    return rows(`SELECT ${COLS} FROM events WHERE civ = $1 ORDER BY id DESC LIMIT $2`, [
      civId,
      limit,
    ]);
  },
  eventsByCell(cell: number, limit: number) {
    return rows(`SELECT ${COLS} FROM events WHERE cell = $1 ORDER BY id DESC LIMIT $2`, [
      cell,
      limit,
    ]);
  },
  async eventById(id: number): Promise<WorldEvent | null> {
    const r = await rows(`SELECT ${COLS} FROM events WHERE id = $1`, [id]);
    return r[0] ?? null;
  },
  eventsByIds(ids: readonly number[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return rows(`SELECT ${COLS} FROM events WHERE id = ANY($1)`, [[...ids]]);
  },
  chronicle(minWeight: number, limit: number) {
    return rows(`SELECT ${COLS} FROM events WHERE weight >= $1 ORDER BY id ASC LIMIT $2`, [
      minWeight,
      limit,
    ]);
  },
  async settlementCensus(settlementId: number): Promise<{ year: number; pop: number }[]> {
    const r = await db().query(
      "SELECT year, pop FROM census WHERE settlement = $1 ORDER BY year ASC",
      [settlementId],
    );
    return (r.rows as { year: number; pop: number }[]).map((row) => ({
      year: Number(row.year),
      pop: Number(row.pop),
    }));
  },
};
