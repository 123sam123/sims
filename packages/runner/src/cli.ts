/**
 * The world CLI: create, advance and inspect a simulation.
 *
 *   new    --seed <n> [--db <path>]     create a fresh world at year 0
 *   run    --years <year> [--db <path>] advance until year <year> (absolute)
 *   status [--db <path>]                year, per-civ population, settlements, caps
 *   history [--limit <n>] [--db <path>] recent events, newest first
 *
 * `--years` is an absolute target year, not a duration, so re-running `run` after
 * an interruption continues toward the same year rather than overshooting — which
 * is exactly what makes "kill it and re-run" resume to the same state.
 *
 * The store, timing and stdout all live here; none of it is on the tick path, so
 * the world stays deterministic no matter how a run is chopped up.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { civPopulation, generateWorld, type World } from "@sim/engine";
import { decideForWorld, makeBrains } from "@sim/agents";
import { advanceWorld, advanceWorldWithDecisions } from "./run.ts";
import { SNAPSHOT_INTERVAL, Store } from "./store.ts";

const DEFAULT_DB = "worlds/world.db";
const PROGRESS_EVERY = 100; // sim-years between progress lines during a run

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
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

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

function totalPopulation(world: World): number {
  let total = 0;
  for (const civ of world.civs) total += civPopulation(world, civ.id);
  return total;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

function cmdNew(flags: Record<string, string | boolean>): void {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  const seed = asNumber(flags.seed, "seed");

  // `new` is a fresh start: drop any world already at this path (and its WAL
  // sidecars) so we never resume onto a stale one by accident.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) rmSync(p);
  }
  const dir = dirname(dbPath);
  if (dir) mkdirSync(dir, { recursive: true });

  const store = new Store(dbPath);
  const world = generateWorld(seed);
  store.setMeta("seed", String(seed));
  store.setMeta("format", "1");
  // Worldgen emits no events today, but drain-then-snapshot keeps the invariant
  // that a snapshot never carries an event array.
  store.appendEvents(world.events);
  world.events.length = 0;
  store.saveSnapshot(world);
  store.close();

  process.stdout.write(
    `Created world (seed ${seed}) at ${dbPath}\n` +
      `  year ${world.year} · ${world.civs.length} civilisations · ${world.settlements.length} settlements\n`,
  );
}

/** Whether `--agents on` was passed (the flag also accepts a bare `--agents`). */
function agentsOn(flags: Record<string, string | boolean>): boolean {
  const v = flags.agents;
  if (v === true) return true;
  const s = asString(v);
  return s === "on" || s === "true" || s === "1";
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!existsSync(dbPath)) {
    fail(`no world at ${dbPath} — run \`pnpm new --seed <n>\` first`);
  }
  const target = asNumber(flags.years, "years");

  const store = new Store(dbPath);
  const world = store.loadLatest();
  if (!world) {
    store.close();
    fail(`${dbPath} has no snapshot — run \`pnpm new --seed <n>\` first`);
  }

  const start = world.year;
  if (start >= target) {
    store.close();
    process.stdout.write(`Already at year ${start} (target ${target}); nothing to do.\n`);
    return;
  }

  const withAgents = agentsOn(flags);
  const progress = (w: World) => {
    process.stdout.write(
      `  year ${w.year}  ·  pop ${fmt(totalPopulation(w))}  ·  ${w.settlements.length} settlements\n`,
    );
  };
  let lastLogged = start;
  const onTick = (w: World) => {
    if (w.year - lastLogged >= PROGRESS_EVERY || w.year >= target) {
      lastLogged = w.year;
      progress(w);
    }
  };

  process.stdout.write(
    `Advancing ${dbPath} from year ${start} to ${target} ` +
      `(snapshot every ${SNAPSHOT_INTERVAL} years)…\n`,
  );

  const t0 = performance.now();
  let result: { ticks: number; toYear: number };
  if (withAgents) {
    const { brain, fallback, usingLlm } = makeBrains({ model: asString(flags.model) });
    process.stdout.write(
      usingLlm
        ? "Agents: on (Claude driving; heuristic fallback).\n"
        : "Agents: on (no ANTHROPIC_API_KEY — deterministic heuristic brain).\n",
    );
    result = await advanceWorldWithDecisions(
      store,
      world,
      target,
      (w) => decideForWorld(w, { brain, fallback }),
      { onTick },
    );
  } else {
    result = advanceWorld(store, world, target, { onTick });
  }
  const seconds = (performance.now() - t0) / 1000;
  store.close();

  process.stdout.write(
    `Advanced ${result.ticks} years (${start} → ${result.toYear}) in ${seconds.toFixed(1)}s.\n`,
  );
}

function loadWorldOrFail(dbPath: string): { store: Store; world: World } {
  if (!existsSync(dbPath)) {
    fail(`no world at ${dbPath} — run \`pnpm new --seed <n>\` first`);
  }
  const store = new Store(dbPath);
  const world = store.loadLatest();
  if (!world) {
    store.close();
    fail(`${dbPath} has no snapshot — run \`pnpm new --seed <n>\` first`);
  }
  return { store, world };
}

function cmdStatus(flags: Record<string, string | boolean>): void {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  const { store, world } = loadWorldOrFail(dbPath);

  const lines: string[] = [`Year ${world.year}`];
  for (const civ of world.civs) {
    const pop = civPopulation(world, civ.id);
    const settlements = world.settlements.filter((s) => s.civ === civ.id).length;
    const caps = civ.capabilities.length;
    const tag = civ.alive ? "" : `  (extinct ${civ.extinctYear ?? "?"})`;
    lines.push(
      `  ${civ.name.padEnd(22)} pop ${fmt(pop).padStart(12)}` +
        `   settlements ${String(settlements).padStart(4)}` +
        `   capabilities ${String(caps).padStart(3)}${tag}`,
    );
  }
  store.close();
  process.stdout.write(`${lines.join("\n")}\n`);
}

function cmdHistory(flags: Record<string, string | boolean>): void {
  const dbPath = asString(flags.db) ?? DEFAULT_DB;
  if (!existsSync(dbPath)) {
    fail(`no world at ${dbPath} — run \`pnpm new --seed <n>\` first`);
  }
  const limit = flags.limit === undefined ? 40 : asNumber(flags.limit, "limit");

  const store = new Store(dbPath);
  const events = store.recentEvents(limit);
  store.close();

  if (events.length === 0) {
    process.stdout.write("(no events yet)\n");
    return;
  }
  const lines = events.map(
    (e) => `[${String(e.year).padStart(5)}] ${e.kind.padEnd(10)} ${e.text}`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case "new":
      cmdNew(flags);
      break;
    case "run":
      await cmdRun(flags);
      break;
    case "status":
      cmdStatus(flags);
      break;
    case "history":
      cmdHistory(flags);
      break;
    default:
      process.stderr.write(
        "usage: <new --seed N | run --years YEAR [--agents on] | status | history --limit N> [--db PATH]\n",
      );
      process.exit(command === "" || command === "--help" || command === "help" ? 0 : 1);
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
