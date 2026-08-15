/**
 * The remote publisher: the replica the deployed website reads.
 *
 * What these pin: events reach the remote idempotently and in id order via the
 * store-cursor read (so a replica that missed writes catches up by itself);
 * snapshot publishing is wall-clock throttled but a `close()` flushes
 * unconditionally; the resume guard prunes the remote's abandoned timeline
 * exactly like the local one; and a remote outage never throws into the tick
 * path — the next pump repairs everything.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateWorld, tickWorld } from "@sim/engine";
import { insertEventsSql, RemotePublisher } from "../src/publish.ts";
import { Store } from "../src/store.ts";

/** A fake pg client: records queries, optionally fails, answers MAX(id). */
class FakeClient {
  calls: { text: string; params?: unknown[] }[] = [];
  failing = false;
  maxId = -1;

  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    if (this.failing) throw new Error("connection refused");
    this.calls.push({ text, params });
    if (text.includes("MAX(id)")) return { rows: [{ id: this.maxId }] };
    return { rows: [] };
  }

  /** Ids of every event row inserted so far, in insert order. */
  insertedEventIds(): number[] {
    const ids: number[] = [];
    for (const c of this.calls) {
      if (!c.text.startsWith("INSERT INTO events")) continue;
      for (let i = 0; i < (c.params?.length ?? 0); i += 8) ids.push(Number(c.params?.[i]));
    }
    return ids;
  }

  snapshotYears(): number[] {
    return this.calls
      .filter((c) => c.text.includes("INSERT INTO world_latest"))
      .map((c) => Number(c.params?.[0]));
  }
}

function tmpStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "publish-test-"));
  return { store: new Store(join(dir, "world.db")), dir };
}

/** A settled world with a real event log in the store. */
function seededWorld(store: Store, years = 300) {
  const world = generateWorld(7);
  for (let i = 0; i < years; i++) {
    tickWorld(world);
    store.appendEvents(world.events);
    world.events.length = 0;
  }
  store.saveSnapshot(world);
  return world;
}

const drainTasks = () => new Promise((r) => setImmediate(r));

test("events reach the remote in id order and the cursor advances across pumps", async () => {
  const { store, dir } = tmpStore();
  try {
    const world = seededWorld(store);
    const total = store.eventCount();
    assert.ok(total > 10, "seeded world should have a real event log");

    const client = new FakeClient();
    const pub = new RemotePublisher(client, store, { now: () => 0, log: () => {} });
    await pub.init(world);
    await pub.close(world);

    const ids = client.insertedEventIds();
    assert.equal(ids.length, total);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      "ascending id order",
    );

    // A later tick publishes only what is new.
    tickWorld(world);
    store.appendEvents(world.events);
    const newCount = world.events.length;
    world.events.length = 0;
    await pub.close(world);
    assert.equal(client.insertedEventIds().length, total + newCount);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init resumes the cursor from the remote MAX(id) and applies the resume guard", async () => {
  const { store, dir } = tmpStore();
  try {
    const world = seededWorld(store);
    const client = new FakeClient();
    client.maxId = 4; // the remote already holds events 0..4
    const pub = new RemotePublisher(client, store, { now: () => 0, log: () => {} });
    await pub.init(world);

    const guard = client.calls.find((c) => c.text.startsWith("DELETE FROM events"));
    assert.ok(guard, "remote resume-guard prune ran");
    assert.deepEqual(guard?.params, [world.nextEventId]);

    await pub.close(world);
    const ids = client.insertedEventIds();
    assert.equal(Math.min(...ids), 5, "backfill starts after the remote cursor");
    assert.equal(ids.length, store.eventCount() - 5);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot publishing is wall-clock throttled; close flushes regardless", async () => {
  const { store, dir } = tmpStore();
  try {
    const world = seededWorld(store, 100);
    const client = new FakeClient();
    let t = 0;
    const pub = new RemotePublisher(client, store, {
      now: () => t,
      log: () => {},
      snapshotMs: 30_000,
    });
    await pub.init(world);

    // Three ticks inside one throttle window: one snapshot (the first).
    for (let i = 0; i < 3; i++) {
      tickWorld(world);
      store.appendEvents(world.events);
      world.events.length = 0;
      store.saveSnapshot(world);
      pub.onTick(world);
      await drainTasks();
      t += 1_000;
    }
    assert.equal(client.snapshotYears().length, 1);

    // Past the window: the next tick publishes again.
    t += 30_000;
    tickWorld(world);
    store.appendEvents(world.events);
    world.events.length = 0;
    pub.onTick(world);
    await drainTasks();
    assert.equal(client.snapshotYears().length, 2);

    // close() ignores the throttle and lands the final year.
    tickWorld(world);
    store.appendEvents(world.events);
    world.events.length = 0;
    await pub.close(world);
    assert.equal(client.snapshotYears().at(-1), world.year);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a remote outage never throws into the loop and the replica self-heals", async () => {
  const { store, dir } = tmpStore();
  try {
    const world = seededWorld(store, 200);
    const client = new FakeClient();
    let t = 0;
    const pub = new RemotePublisher(client, store, { now: () => t, log: () => {} });
    await pub.init(world);

    client.failing = true;
    pub.onTick(world); // must not throw, sync or async
    await drainTasks();
    assert.equal(client.insertedEventIds().length, 0);

    client.failing = false;
    t += 60_000;
    pub.onTick(world);
    await drainTasks();
    assert.equal(client.insertedEventIds().length, store.eventCount(), "caught up after outage");
    assert.equal(client.snapshotYears().at(-1), world.year);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("insertEventsSql builds one idempotent multi-row insert", () => {
  const [sql, params] = insertEventsSql([
    { id: 1, year: 10, kind: "founding", civ: 0, cell: 5, weight: 0.5, text: "a", causedBy: [] },
    { id: 2, year: 11, kind: "war", civ: 1, cell: 6, weight: 0.9, text: "b", causedBy: [1] },
  ]);
  assert.ok(sql.includes("ON CONFLICT (id) DO NOTHING"));
  assert.equal(params.length, 16);
  assert.equal(params[8], 2);
  assert.equal(params[15], "[1]");
});
