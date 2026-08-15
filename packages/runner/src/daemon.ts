/**
 * The daemon — live operation. One long-lived process that ticks the world
 * forever, paces itself by event density, and spends a bounded daily model
 * budget on the decisions that matter most.
 *
 *   pnpm daemon                      run continuously (default command)
 *   pnpm daemon report               cost report: spend by day and category,
 *                                    decision routing, cache hit rate
 *   pnpm daemon budget --daily-usd N set the daily cap (picked up live by a
 *                                    running daemon — no restart, no redeploy)
 *
 * **Pacing.** A fixed tick rate cannot work: at a year a minute prehistory is
 * days of empty map, and a busy industrial era is an unreadable firehose. The
 * daemon keeps an EWMA of emitted event weight per sim-year (the same weights
 * the chronicle ranks by) and maps it through {@link paceMsPerYear}: seconds
 * per year when the world is quiet, decelerating smoothly toward a sim-year
 * per real day as history thickens. The map is log-space — pace spans four
 * orders of magnitude — and pure, so tests can pin the deceleration.
 *
 * **Attention.** Model calls ride through `attention.ts`: each due civ's
 * decision bids with a consequence score; the allocator approves what the
 * daily budget affords, and everything else resolves through the
 * deterministic heuristic. Model failures degrade, never stall.
 *
 * **Persistence.** Every tick ends with a snapshot (previous non-keyframe
 * snapshots pruned), so `kill -9` at any moment loses at most the tick in
 * flight. On start the daemon prunes logged events at or above the loaded
 * snapshot's `nextEventId` — the crash window between drain and snapshot
 * would otherwise mix an abandoned timeline's text into the re-decided one.
 *
 * **This does not run on Vercel.** It is a long-lived process for a VM or
 * container; Vercel hosts the website, which reads the same SQLite file's
 * snapshots and never runs the loop.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  civPopulation,
  deserializeWorld,
  type SerializedWorld,
  tickWorld,
  type World,
  type WorldEvent,
} from "@sim/engine";
import {
  type Brain,
  civEra,
  createHeuristicBrain,
  type DecisionContext,
  decideForWorld,
  decisionInterval,
} from "@sim/agents";
import {
  AttentionAllocator,
  type AllocatorState,
  consequenceScore,
  createAttentiveBrain,
  type DecisionOutcome,
  utcDay,
} from "./attention.ts";
import {
  type CivSessions,
  createCliSessionBrain,
  createMeteredApiBrain,
  DEFAULT_MODEL,
  isUsageLimitError,
  type MeteredCall,
} from "./llm.ts";
import { RemotePublisher } from "./publish.ts";
import { SNAPSHOT_INTERVAL, Store } from "./store.ts";

/* ------------------------------------------------------------------ *
 * Pacing — density in, milliseconds per sim-year out
 * ------------------------------------------------------------------ */

/** Fastest the world runs: one sim-year per two real seconds. An empty
 *  prehistory (density ~0.04 weight/yr in engine-only runs) clears in minutes,
 *  not days. */
export const PACE_FLOOR_MS = 2_000;
/** Slowest the world runs: one sim-year per real day — the modern-era target
 *  where "come back in three days" means something. */
export const PACE_CEIL_MS = 86_400_000;
/** Density (weight/sim-year) at which pace sits halfway up the log scale.
 *  Calibration: engine-only worlds idle at 0.03–0.7; the LLM-driven arm ran
 *  0.3–1.8 and rises with era. */
export const DENSITY_HALF = 1.2;
const DENSITY_EXP = 2;
/** Halflife of the density EWMA, in sim-years — long enough that one loud
 *  year doesn't slam the brakes, short enough that an age change is felt. */
export const DENSITY_HALFLIFE_YEARS = 25;

const DAY_MS = 86_400_000;

/** One EWMA step: fold one tick's emitted weight into the running density. */
export function decayDensity(prev: number, tickWeight: number): number {
  const keep = Math.exp(-Math.LN2 / DENSITY_HALFLIFE_YEARS);
  return prev * keep + tickWeight * (1 - keep);
}

/**
 * Density → pace. A Hill curve picks a position s ∈ [0,1), and the pace
 * interpolates floor→ceiling in log space — linear interpolation over a
 * 43,000× range would pin everything to the ceiling. Monotone by construction:
 * more history per year, more real time per year, for everyone at once.
 */
export function paceMsPerYear(
  density: number,
  floorMs: number = PACE_FLOOR_MS,
  ceilMs: number = PACE_CEIL_MS,
): number {
  if (!(density > 0)) return floorMs;
  const dk = density ** DENSITY_EXP;
  const s = dk / (dk + DENSITY_HALF ** DENSITY_EXP);
  return Math.round(floorMs * (ceilMs / floorMs) ** s);
}

/** Human pace: "2.0s/yr", "4.3m/yr", "3.1h/yr", "1.0d/yr". */
export function formatPace(msPerYear: number): string {
  if (msPerYear < 60_000) return `${(msPerYear / 1000).toFixed(1)}s/yr`;
  if (msPerYear < 3_600_000) return `${(msPerYear / 60_000).toFixed(1)}m/yr`;
  if (msPerYear < DAY_MS) return `${(msPerYear / 3_600_000).toFixed(1)}h/yr`;
  return `${(msPerYear / DAY_MS).toFixed(1)}d/yr`;
}

/* ------------------------------------------------------------------ *
 * Consequence inputs — the daemon-side state scoring reads
 * ------------------------------------------------------------------ */

/** Halflife of the per-civ recent-event-weight EWMA, in sim-years. */
const CIV_WEIGHT_HALFLIFE_YEARS = 15;

/** Tracks, per civ, how eventful its recent history is and when the model
 *  last decided for it — the volatile inputs to {@link consequenceScore}. */
export class AttentionTracker {
  private recent = new Map<number, number>();
  private lastModelYear = new Map<number, number>();

  constructor(world: World) {
    // Seed staleness at one interval so a fresh daemon neither starves nor
    // floods: every civ starts moderately hungry for attention.
    for (const civ of world.civs) {
      this.lastModelYear.set(civ.id, world.year - decisionInterval(civ));
    }
  }

  /** Fold one tick's drained events into the per-civ weight EWMAs. */
  update(world: World, events: readonly WorldEvent[]): void {
    const perCiv = new Map<number, number>();
    for (const e of events) {
      if (e.civ != null) perCiv.set(e.civ, (perCiv.get(e.civ) ?? 0) + e.weight);
    }
    const keep = Math.exp(-Math.LN2 / CIV_WEIGHT_HALFLIFE_YEARS);
    for (const civ of world.civs) {
      const w = perCiv.get(civ.id) ?? 0;
      this.recent.set(civ.id, (this.recent.get(civ.id) ?? 0) * keep + w * (1 - keep));
    }
  }

  notedModelDecision(civId: number, year: number): void {
    this.lastModelYear.set(civId, year);
  }

  score(ctx: DecisionContext): number {
    const { world, civ } = ctx;
    let total = 0;
    for (const c of world.civs) total += civPopulation(world, c.id);
    const interval = decisionInterval(civ);
    return consequenceScore({
      era: civEra(civ),
      popShare: total > 0 ? civPopulation(world, civ.id) / total : 0,
      recentWeight: this.recent.get(civ.id) ?? 0,
      yearsSinceModel: world.year - (this.lastModelYear.get(civ.id) ?? world.year - interval),
      interval,
    });
  }
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

export interface DaemonHooks {
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

export interface DaemonOptions {
  /** The mind for due civs — typically the attentive brain. */
  primary: Brain;
  /** Used when `primary.decide` throws (it shouldn't; belt and braces). */
  fallback: Brain;
  /** Abort to stop after the tick in flight. */
  signal?: AbortSignal;
  /** Absolute target year to stop at (tests, smokes). Omit to run forever. */
  untilYear?: number;
  floorMs?: number;
  ceilMs?: number;
  /** Called after each tick's events are drained — the wiring layer updates
   *  its tracker and persists allocator/session/counter state here. */
  onTick?: (world: World, drained: readonly WorldEvent[]) => void;
  /** Extra fields merged into the `daemon.status` meta each tick (budget
   *  numbers, decision counters) — what the site shows viewers. */
  statusExtra?: () => Record<string, unknown>;
  hooks?: DaemonHooks;
}

export interface DaemonResult {
  fromYear: number;
  toYear: number;
  ticks: number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/**
 * Tick forever (or to `untilYear`): tick → decide → drain → snapshot → pace.
 * Every iteration ends durable — snapshot written, non-keyframe predecessors
 * pruned, density and status meta updated — so stopping this loop at any
 * point, gracefully or not, is recoverable to the last completed tick.
 */
export async function runDaemon(
  store: Store,
  world: World,
  opts: DaemonOptions,
): Promise<DaemonResult> {
  const now = opts.hooks?.now ?? (() => Date.now());
  const sleep = opts.hooks?.sleep ?? defaultSleep;
  const log = opts.hooks?.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const floorMs = opts.floorMs ?? PACE_FLOOR_MS;
  const ceilMs = opts.ceilMs ?? PACE_CEIL_MS;

  let density = Number(store.getMeta("daemon.density")) || 0;
  const fromYear = world.year;
  let lastLogged = -Infinity;

  while (!opts.signal?.aborted && (opts.untilYear === undefined || world.year < opts.untilYear)) {
    const t0 = now();
    tickWorld(world);
    await decideForWorld(world, { brain: opts.primary, fallback: opts.fallback });

    const drained = world.events.slice();
    let weight = 0;
    for (const e of drained) weight += e.weight;
    store.appendEvents(drained);
    world.events.length = 0;
    density = decayDensity(density, weight);

    store.saveSnapshot(world);
    store.pruneSnapshots(world.year, SNAPSHOT_INTERVAL);

    const pace = paceMsPerYear(density, floorMs, ceilMs);
    store.setMeta("daemon.density", density.toFixed(6));
    store.setMeta(
      "daemon.status",
      JSON.stringify({
        year: world.year,
        density: Number(density.toFixed(4)),
        paceMsPerYear: pace,
        simYearsPerRealDay: Number((DAY_MS / pace).toFixed(2)),
        updatedAt: now(),
        ...opts.statusExtra?.(),
      }),
    );
    opts.onTick?.(world, drained);

    // Slow world: narrate every tick. Fast world: a line every 25 years.
    if (pace >= 30_000 || world.year - lastLogged >= 25) {
      lastLogged = world.year;
      let pop = 0;
      for (const civ of world.civs) pop += civPopulation(world, civ.id);
      log(
        `year ${world.year}  ·  pop ${Math.round(pop).toLocaleString("en-US")}  ·  ` +
          `${drained.length} events  ·  density ${density.toFixed(2)}  ·  pace ${formatPace(pace)}`,
      );
    }

    const elapsed = now() - t0;
    const waitMs = Math.min(pace, Math.max(0, pace - elapsed));
    if (waitMs > 0) await sleep(waitMs, opts.signal);
  }

  return { fromYear, toYear: world.year, ticks: world.year - fromYear };
}

/* ------------------------------------------------------------------ *
 * Wiring — budget, brains, counters (the `run` command)
 * ------------------------------------------------------------------ */

export const DEFAULT_DAILY_USD = 10;
const DEFAULT_DB = "worlds/world.db";

/** Decision routing tallies, persisted in meta `daemon.counters` and shown by
 *  the report: how many decisions the model took vs the heuristic, and why. */
interface DecisionCounters {
  model: number;
  heuristic: number;
  byReason: Record<string, number>;
}

const emptyCounters = (): DecisionCounters => ({ model: 0, heuristic: 0, byReason: {} });

/** The daily cap: meta `budget.dailyUsd` when set (and sane), else the default.
 *  `Number(null)` is 0, so an unset knob must not be read as a zero budget. */
function readDailyUsd(store: Store): number {
  const raw = store.getMeta("budget.dailyUsd");
  if (raw === null) return DEFAULT_DAILY_USD;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_DAILY_USD;
}

function readJsonMeta<T>(store: Store, key: string): T | null {
  const raw = store.getMeta(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

type TransportChoice = "api" | "cli" | "heuristic";

/** api when a key is present, else the subscription CLI. `--brain` overrides. */
function pickTransport(flag: string | undefined): TransportChoice {
  if (flag === "heuristic" || flag === "api" || flag === "cli") return flag;
  return process.env.ANTHROPIC_API_KEY ? "api" : "cli";
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!existsSync(dbPath)) fail(`no world at ${dbPath} — run \`pnpm new --seed <n>\` first`);
  const store = new Store(dbPath);
  const world = store.loadLatest();
  if (!world) {
    store.close();
    fail(`${dbPath} has no snapshot — run \`pnpm new --seed <n>\` first`);
  }

  if (flags["daily-usd"] !== undefined) {
    store.setMeta("budget.dailyUsd", String(asNumber(flags["daily-usd"], "daily-usd")));
  }
  const dailyUsd = (): number => readDailyUsd(store);

  // Resume guard: drop any logged events past the snapshot we loaded (see
  // module docs — the crash window between drain and snapshot).
  store.pruneEventsFrom(world.nextEventId);

  const model = asString(flags.model) ?? DEFAULT_MODEL;
  const transport = pickTransport(asString(flags.brain));
  const heuristic = createHeuristicBrain();
  const tracker = new AttentionTracker(world);
  const counters = readJsonMeta<DecisionCounters>(store, "daemon.counters") ?? emptyCounters();
  const sessions: CivSessions = readJsonMeta<CivSessions>(store, "daemon.sessions") ?? {};

  const allocator = new AttentionAllocator({
    dailyUsd,
    spentOnDay: (day) => store.spentOnDay(day),
  });
  const allocState = readJsonMeta<AllocatorState>(store, "daemon.allocator");
  if (allocState) allocator.restoreState(allocState);

  const onCall = (call: MeteredCall): void => {
    const ts = Date.now();
    allocator.settle(call.costUsd);
    store.recordSpend({
      ts,
      day: utcDay(ts),
      category: "decision",
      civ: call.civ,
      model: call.model,
      costUsd: call.costUsd,
      inputTokens: call.usage.inputTokens,
      outputTokens: call.usage.outputTokens,
      cacheReadTokens: call.usage.cacheReadTokens,
      cacheCreationTokens: call.usage.cacheCreationTokens,
    });
  };

  let modelBrain: Brain | null = null;
  if (transport === "api") modelBrain = createMeteredApiBrain({ model, onCall });
  else if (transport === "cli") modelBrain = createCliSessionBrain({ model, onCall, sessions });

  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const primary = createAttentiveBrain({
    model: modelBrain,
    heuristic,
    allocator,
    score: (ctx) => tracker.score(ctx),
    isUsageLimit: isUsageLimitError,
    onOutcome: (o: DecisionOutcome) => {
      if (o.route === "model") {
        counters.model++;
        tracker.notedModelDecision(o.civ, o.year);
        log(
          `  ↯ model decided for civ ${o.civ} (year ${o.year}, score ${o.score.toFixed(2)} ≥ bar ${o.bar.toFixed(2)})`,
        );
      } else {
        counters.heuristic++;
        counters.byReason[o.reason] = (counters.byReason[o.reason] ?? 0) + 1;
        if (o.reason === "usage-limit" || o.reason === "error") {
          log(`  ⚠ ${o.reason} — civ ${o.civ} resolved heuristically; the world keeps running`);
        }
      }
    },
  });

  const controller = new AbortController();
  const stop = (sig: string): void => {
    log(`received ${sig} — stopping after the tick in flight`);
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  // Shared read store for the website (see publish.ts). Enabled by
  // DATABASE_URL; a bad URL fails here, at boot, not mid-run.
  let publisher: RemotePublisher | null = null;
  let pool: { end(): Promise<void> } | null = null;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    pool = pgPool;
    publisher = new RemotePublisher(pgPool, store, { log });
    await publisher.init(world);
    log(`Publishing to remote store (snapshot + events + census).`);
  }

  log(
    `Daemon on ${dbPath} from year ${world.year} — brain ${transport}` +
      `${transport === "heuristic" ? "" : ` (${model})`}, budget $${dailyUsd().toFixed(2)}/day.`,
  );

  const untilYear = flags["until-year"] !== undefined ? asNumber(flags["until-year"], "until-year") : undefined;
  const floorMs = flags["floor-ms"] !== undefined ? asNumber(flags["floor-ms"], "floor-ms") : undefined;

  const result = await runDaemon(store, world, {
    primary,
    fallback: heuristic,
    signal: controller.signal,
    untilYear,
    floorMs,
    onTick: (w, drained) => {
      tracker.update(w, drained);
      store.setMeta("daemon.sessions", JSON.stringify(sessions));
      store.setMeta("daemon.allocator", JSON.stringify(allocator.saveState()));
      store.setMeta("daemon.counters", JSON.stringify(counters));
      publisher?.onTick(w);
    },
    statusExtra: () => {
      const stats = allocator.stats();
      return {
        dailyCapUsd: dailyUsd(),
        spentTodayUsd: Number(store.spentOnDay(utcDay(Date.now())).toFixed(4)),
        bucketUsd: Number(stats.bucketUsd.toFixed(4)),
        bar: Number(stats.bar.toFixed(3)),
        decisions: { model: counters.model, heuristic: counters.heuristic },
      };
    },
    hooks: { log },
  });

  if (publisher) {
    // Final flush so the site's replica ends exactly where the run stopped.
    try {
      await publisher.close(world);
    } catch {
      // remote down at shutdown — the next start's pump catches it up
    }
    await pool?.end();
  }
  store.close();
  log(`Stopped at year ${result.toYear} (${result.ticks} ticks this run).`);
}

/* ------------------------------------------------------------------ *
 * report / budget commands
 * ------------------------------------------------------------------ */

const money = (v: number): string => `$${v.toFixed(2)}`;
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const fmtInt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Cache hit rate: what share of input tokens were served from cache. The
 *  API reports uncached input, cache reads and cache writes disjointly. */
function hitRate(cacheRead: number, cacheWrite: number, uncachedIn: number): number {
  const total = cacheRead + cacheWrite + uncachedIn;
  return total > 0 ? cacheRead / total : 0;
}

function cmdReport(flags: Record<string, string | boolean>): void {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!existsSync(dbPath)) fail(`no world at ${dbPath}`);
  const store = new Store(dbPath);

  const rows = store.spendByDay();
  const counters = readJsonMeta<DecisionCounters>(store, "daemon.counters") ?? emptyCounters();
  const cap = readDailyUsd(store);

  const lines: string[] = [`Cost report — ${dbPath}`, `Daily budget: ${money(cap)}`, ""];
  lines.push(
    "day         category    calls      cost   cache read  cache write  uncached in   out tokens  hit rate",
  );
  const categories = new Map<string, { calls: number; cost: number; read: number; write: number; uncached: number; out: number }>();
  for (const r of rows) {
    lines.push(
      `${r.day}  ${r.category.padEnd(10)} ${String(r.calls).padStart(6)}  ${money(r.costUsd).padStart(8)}  ` +
        `${fmtInt(r.cacheReadTokens).padStart(11)}  ${fmtInt(r.cacheCreationTokens).padStart(11)}  ` +
        `${fmtInt(r.inputTokens).padStart(11)}  ${fmtInt(r.outputTokens).padStart(11)}  ` +
        `${pct(hitRate(r.cacheReadTokens, r.cacheCreationTokens, r.inputTokens)).padStart(8)}`,
    );
    const c = categories.get(r.category) ?? { calls: 0, cost: 0, read: 0, write: 0, uncached: 0, out: 0 };
    c.calls += Number(r.calls);
    c.cost += r.costUsd;
    c.read += r.cacheReadTokens;
    c.write += r.cacheCreationTokens;
    c.uncached += r.inputTokens;
    c.out += r.outputTokens;
    categories.set(r.category, c);
  }
  if (rows.length === 0) lines.push("(no model spend recorded)");

  lines.push("", "By category:");
  for (const name of ["decision", "narration"]) {
    const c = categories.get(name);
    if (!c) {
      lines.push(`  ${name.padEnd(10)} ${money(0)} (no calls)`);
      continue;
    }
    lines.push(
      `  ${name.padEnd(10)} ${money(c.cost)} across ${c.calls} calls · cache hit rate ${pct(hitRate(c.read, c.write, c.uncached))}`,
    );
  }
  for (const [name, c] of categories) {
    if (name === "decision" || name === "narration") continue;
    lines.push(
      `  ${name.padEnd(10)} ${money(c.cost)} across ${c.calls} calls · cache hit rate ${pct(hitRate(c.read, c.write, c.uncached))}`,
    );
  }

  const total = counters.model + counters.heuristic;
  lines.push("", "Decision routing:");
  lines.push(
    `  model ${counters.model} · heuristic ${counters.heuristic}` +
      (total > 0 ? ` · model share ${pct(counters.model / total)}` : ""),
  );
  const reasons = Object.entries(counters.byReason)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`)
    .join(" · ");
  if (reasons) lines.push(`  heuristic because: ${reasons}`);

  store.close();
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Rebuild a local world DB from the remote replica's latest published
 * snapshot — the recovery path when the sim host is lost entirely. Loses at
 * most one publish interval of history. The daemon's startup resume guard
 * then prunes remote events past the restored snapshot's `nextEventId`, so
 * the replica's log and the restored timeline stay consistent.
 */
async function cmdRestore(flags: Record<string, string | boolean>): Promise<void> {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set");
  if (existsSync(dbPath)) fail(`${dbPath} already exists — refusing to overwrite a world`);

  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const r = await pool.query("SELECT year, world FROM world_latest WHERE id = 1");
  await pool.end();
  if (r.rows.length === 0) fail("the remote store has no published world to restore from");

  const world = deserializeWorld(
    JSON.parse((r.rows[0] as { world: string }).world) as SerializedWorld,
  );
  mkdirSync(dirname(dbPath), { recursive: true });
  const store = new Store(dbPath);
  store.saveSnapshot(world);
  store.close();
  process.stdout.write(`Restored world at year ${world.year} into ${dbPath}.\n`);
}

function cmdBudget(flags: Record<string, string | boolean>): void {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!existsSync(dbPath)) fail(`no world at ${dbPath}`);
  const store = new Store(dbPath);
  if (flags["daily-usd"] !== undefined) {
    const v = asNumber(flags["daily-usd"], "daily-usd");
    if (v < 0) fail("--daily-usd must be ≥ 0");
    store.setMeta("budget.dailyUsd", String(v));
    process.stdout.write(
      `Daily budget set to ${money(v)} — a running daemon picks this up on its next bid.\n`,
    );
  } else {
    process.stdout.write(`Daily budget: ${money(readDailyUsd(store))}\n`);
  }
  store.close();
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  let command = "run";
  let rest = argv;
  if (argv.length > 0 && !argv[0].startsWith("--")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

const asString = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function asNumber(v: string | boolean | undefined, name: string): number {
  const s = asString(v);
  if (s === undefined || s.trim() === "" || !Number.isFinite(Number(s))) {
    fail(`--${name} requires a number`);
  }
  return Number(s);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "run":
      await cmdRun(flags);
      break;
    case "report":
      cmdReport(flags);
      break;
    case "budget":
      cmdBudget(flags);
      break;
    case "restore":
      await cmdRestore(flags);
      break;
    default:
      process.stderr.write(
        "usage: pnpm daemon [run] [--db PATH] [--brain auto|api|cli|heuristic] [--model ID] [--daily-usd N] [--floor-ms N] [--until-year Y]\n" +
          "       pnpm daemon report [--db PATH]\n" +
          "       pnpm daemon budget [--daily-usd N] [--db PATH]\n" +
          "       pnpm daemon restore [--db PATH]   (rebuild a lost world DB from the remote replica)\n",
      );
      process.exit(command === "help" || command === "--help" ? 0 : 1);
  }
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
