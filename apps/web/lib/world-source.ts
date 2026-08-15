/**
 * Server-side: get the current world and pack it into the wire payload.
 *
 * Where the world comes from, in order:
 *   1. the shared Postgres replica, when `DATABASE_URL` is set — the deployed
 *      site's path; the daemon on the sim host publishes into it (`remote.ts`).
 *   2. the live store — a `node:sqlite` file the runner writes as it ticks. Its
 *      most-advanced snapshot is the present. This is the path that makes the
 *      map update as the simulation advances in local dev.
 *   3. failing that, a fresh `generateWorld(seed)` at year 0 — so the site still
 *      renders a recognisable Earth with nothing running behind it (e.g. on a
 *      host that carries the app but not the tick loop).
 *
 * The built payload is cached against the store file's size+mtime, so polling
 * the API every few seconds costs a `stat`, not a re-read, until the sim moves.
 *
 * This module uses Node APIs and must only ever run on the server.
 */

import { statSync } from "node:fs";
import path from "node:path";
import {
  civPopulation,
  generateWorld,
  GRID_H,
  GRID_W,
  settlementPop,
  type World,
} from "@sim/engine";
import type { CivInfo, DepositInfo, MapPayload, SettlementInfo } from "./payload";
import {
  lastKnownRemoteWorld,
  loadRemoteWorld,
  remoteEnabled,
  remoteSourceKey,
} from "./remote";

const SEED = Number(process.env.WORLD_SEED ?? 1);
const DB_PATH =
  process.env.WORLD_DB ?? path.resolve(process.cwd(), "../../worlds/world.db");

const clampByte = (v: number) => {
  const n = Math.round(v);
  return n < 0 ? 0 : n > 255 ? 255 : n;
};

function encodeGrid(world: World) {
  const { grid } = world;
  const n = grid.biome.length;
  const elev = new Uint8Array(n);
  const river = new Uint8Array(n);
  const temp = new Uint8Array(n);
  const owner = new Uint8Array(n);
  const fertility = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    elev[i] = clampByte(grid.elevation[i] * 255);
    river[i] = clampByte(grid.river[i] * 255);
    temp[i] = clampByte(((grid.temperature[i] + 40) / 80) * 255);
    const ow = grid.owner[i];
    owner[i] = ow < 0 ? 0 : ow + 1;
    fertility[i] = clampByte(grid.fertility[i] * 255);
  }
  const b64 = (a: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
  return {
    biome: b64(grid.biome),
    elev: b64(elev),
    river: b64(river),
    temp: b64(temp),
    owner: b64(owner),
    fertility: b64(fertility),
  };
}

function buildPayload(world: World): MapPayload {
  const civs: CivInfo[] = world.civs.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    color: c.color,
    capabilities: c.capabilities,
    population: Math.round(civPopulation(world, c.id)),
    settlements: world.settlements.filter((s) => s.civ === c.id).length,
  }));

  const settlements: SettlementInfo[] = world.settlements.map((s) => ({
    id: s.id,
    civ: s.civ,
    cell: s.cell,
    name: s.name,
    pop: Math.round(settlementPop(s)),
  }));

  const deposits: DepositInfo[] = world.deposits.map((d) => ({
    c: d.cell,
    k: d.kind,
    n: d.name,
  }));

  return {
    w: GRID_W,
    h: GRID_H,
    year: world.year,
    seed: world.seed,
    ...encodeGrid(world),
    deposits,
    civs,
    settlements,
  };
}

interface Cache {
  key: string;
  payload: MapPayload;
}
let cache: Cache | null = null;

/** Load the current world from the store if present, else generate year 0. */
async function loadWorld(): Promise<World> {
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(DB_PATH);
  } catch {
    stat = null;
  }
  if (stat?.isFile()) {
    try {
      const { Store } = await import("@sim/runner");
      const store = new Store(DB_PATH);
      const world = store.loadLatest();
      store.close();
      if (world) return world;
    } catch {
      // fall through to a generated world
    }
  }
  return generateWorld(SEED);
}

function sourceKey(): string {
  try {
    const s = statSync(DB_PATH);
    if (s.isFile()) return `db:${s.size}:${s.mtimeMs}`;
  } catch {
    // no store yet
  }
  return `gen:${SEED}`;
}

/** The current world as a wire payload, cached until the store changes. */
export async function getMapPayload(): Promise<MapPayload> {
  if (remoteEnabled()) {
    try {
      const remoteKey = await remoteSourceKey();
      if (remoteKey !== null) {
        if (cache && cache.key === remoteKey) return cache.payload;
        const world = await loadRemoteWorld(remoteKey);
        if (world) {
          const payload = buildPayload(world);
          cache = { key: remoteKey, payload };
          return payload;
        }
      }
      // Reachable but never published: fall through to sqlite/generated.
    } catch {
      // Store unreachable: keep serving what this instance last built.
      if (cache) return cache.payload;
      const last = lastKnownRemoteWorld();
      if (last) {
        cache = { key: "pg:last-known", payload: buildPayload(last) };
        return cache.payload;
      }
    }
  }

  const key = sourceKey();
  if (cache && cache.key === key) return cache.payload;
  const world = await loadWorld();
  const payload = buildPayload(world);
  cache = { key, payload };
  return payload;
}
