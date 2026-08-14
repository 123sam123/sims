/**
 * The divergence experiment — the gate on the whole project.
 *
 * The claim under test: AI-driven civilisations produce meaningfully different
 * histories. Same seed, same engine, same starting doctrines — if the five runs
 * with a model deciding still converge on one history, the premise is flat and
 * everything downstream is decoration.
 *
 * Four arms, all over the SAME seed:
 *
 *   engine     ×2  — no decision loop at all. The determinism gate: both runs
 *                    must be bit-identical (world hash + event-log hash), or
 *                    the experiment measures nothing and aborts.
 *   heuristic  ×N  — the ticket's control arm: the full decision loop with the
 *                    deterministic heuristic brain. Expected mutually identical;
 *                    verifies the decision *path* adds no hidden nondeterminism.
 *   perturbed  ×N  — heuristic plus a tiny seeded per-run perturbation (drop /
 *                    reorder a directive, jitter a policy share). This is the
 *                    chaos floor: how much divergence ANY nondeterminism buys.
 *                    LLM divergence must beat this floor to count as strategic
 *                    choice rather than snowballed noise.
 *   llm        ×N  — the measurement: the real model brain, instrumented.
 *
 * Interpretation note that strengthens both outcomes: the engine's RNG is
 * hash-keyed per (subsystem, entity, year), not a shared stream, so a perturbed
 * decision can NOT desync unrelated random draws. Divergence only ever flows
 * through real state differences — steered research, projects, settlements,
 * policy, chronicle.
 *
 * Instrumentation the production brain does not carry (and why it is here, not
 * in `@sim/agents`): the loop silently falls back to the heuristic when a brain
 * throws, and `parseDirectiveSet` never throws — so truncation, refusals and
 * dead keys all degrade a run *invisibly*. The experiment's own LLM brain mirrors
 * `createLlmBrain`'s request exactly (same briefing blocks, same output schema,
 * prompt caching included) but records stop_reason, token usage, cache hits,
 * retries and terminal failures per run, raises max_tokens so adaptive thinking
 * cannot eat the structured output, and the arm is preflighted so a dead key
 * fails loudly instead of producing five identical heuristic runs and a false
 * "no divergence" verdict.
 *
 * Every run persists a capture sidecar (`<db>.capture.json`) flushed on the
 * snapshot cadence: discovery/loss years per capability (diffed year-by-year —
 * event text is not machine-readable), checkpoints, telemetry, hashes. Crashed
 * runs resume from the sidecar's last flushed snapshot; because an LLM resume
 * re-decides the replayed span, events and snapshots from the abandoned
 * timeline are pruned first (cut at the snapshot's own nextEventId) so the log
 * never mixes two histories. Re-invoking the same command is always safe:
 * complete runs are skipped, partial ones resumed.
 *
 * Usage:
 *   pnpm tsx packages/runner/src/experiment.ts --seed 1 --runs 5 --years 1500
 *     [--llm auto|require|off]  default auto: run the llm arm when a transport
 *                               is available, else skip it — never silently
 *                               substitute the heuristic
 *     [--transport auto|api|cli] default auto: the metered API when
 *                               ANTHROPIC_API_KEY is set, else the Claude Code
 *                               CLI on the user's subscription auth
 *     [--model <id>]            default claude-opus-5 (matches createLlmBrain)
 *     [--max-tokens <n>]        default 12000 (thinking + output headroom)
 *     [--out <dir>]             report dir, default docs/divergence
 *     [--db-dir <dir>]          run DBs, default worlds/experiments (gitignored)
 *     [--report-only]           rebuild the report from existing runs
 *
 * Exit codes: 0 = requested work complete · 1 = gate/config failure ·
 * 2 = llm arm incomplete (re-invoke to resume).
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import {
  cellLat,
  cellLon,
  type Civ,
  civPopulation,
  generateWorld,
  hashSeed,
  Rng,
  serializeWorld,
  settlementPop,
  type World,
} from "@sim/engine";
import {
  type Brain,
  createHeuristicBrain,
  type DecisionContext,
  decideForWorld,
  DIRECTIVE_OUTPUT_SCHEMA,
  type Directive,
  type DirectiveSet,
  parseDirectiveSet,
} from "@sim/agents";
import { advanceWorld, advanceWorldWithDecisions } from "./run.ts";
import { SNAPSHOT_INTERVAL, Store } from "./store.ts";

/* ------------------------------------------------------------------ *
 * Types and constants
 * ------------------------------------------------------------------ */

type ArmMode = "engine" | "heuristic" | "perturbed" | "llm";

const DEFAULT_MODEL = "claude-opus-5"; // must match createLlmBrain's default
/** Thinking is billed against max_tokens; the production brain's 2048 lets it
 *  eat the structured output and silently return zero directives. */
const DEFAULT_MAX_TOKENS = 12000;
const LLM_ATTEMPTS = 3; // wrapper attempts per decision (SDK retries once more inside)
const BACKOFF_MS = [5_000, 20_000];
const CLI_TIMEOUT_MS = 300_000; // per decision, spawn to exit
/** Subscription usage limits reset on a rolling window: when a CLI call hits
 *  one, the run WAITS instead of degrading to the heuristic — a stalled run is
 *  honest, a half-heuristic run is not. */
const USAGE_WAIT_MS = 10 * 60_000;
const USAGE_WAIT_MAX = 48; // give up after ~8h of waiting on one decision
const PROGRESS_EVERY = 100; // sim-years between progress lines
const TOP_EVENTS = 20;
const TRAJECTORY_STEP = 250; // years between capability-trajectory samples
/** Fallback+degraded share of decisions above which a run is flagged / tainted. */
const CONTAMINATION_FLAG = 0.05;
const CONTAMINATION_TAINT = 0.1;

/** $/MTok, 2026-08 list prices — for the report's cost ESTIMATE only. */
const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  opus: { in: 5, out: 25, read: 0.5, write: 6.25 },
  sonnet: { in: 3, out: 15, read: 0.3, write: 3.75 },
  haiku: { in: 1, out: 5, read: 0.1, write: 1.25 },
};

interface LlmTelemetry {
  transport?: "api" | "cli";
  /** CLI transport only: the notional cost the CLI reports per call, summed.
   *  On subscription auth nothing is billed — this measures usage burned. */
  costUsd?: number;
  calls: number; // completed API decisions
  retries: number;
  /** Terminal throws — each one became a silent heuristic-fallback decision. */
  terminalFailures: number;
  degraded: number; // stop_reason max_tokens: output truncated
  refusals: number; // stop_reason refusal: empty set, loop never told
  emptySets: number; // parsed fine but proposed nothing
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  errors: string[]; // capped sample of terminal errors
}

interface Discovery {
  civ: number;
  cap: string;
  year: number;
}

interface CheckpointCiv {
  id: number;
  pop: number;
  settlements: number;
  caps: number;
}

interface Checkpoint {
  year: number;
  civs: CheckpointCiv[];
}

/** The persisted sidecar — the run's machine-readable history, flushed on the
 *  snapshot cadence so a crash never loses more than a snapshot's worth. */
interface RunCapture {
  mode: ArmMode;
  seed: number;
  runIndex: number;
  targetYears: number;
  model?: string;
  /** Last year flushed to disk; a matching snapshot exists at this year. */
  completeYear: number;
  done: boolean;
  initialCaps: Record<number, string[]>;
  discoveries: Discovery[];
  losses: Discovery[];
  checkpoints: Checkpoint[];
  resumes: { atYear: number }[];
  llm?: LlmTelemetry;
  worldHash?: string;
  eventLogHash?: string;
  wallSeconds?: number;
}

interface RunConfig {
  mode: ArmMode;
  seed: number;
  years: number;
  runIndex: number;
  dbPath: string;
  model?: string;
  maxTokens?: number;
  transport?: "api" | "cli";
}

interface SettlementSummary {
  cell: number;
  name: string;
  lat: number;
  lon: number;
  pop: number;
}

interface CivSummary {
  id: number;
  key: string;
  name: string;
  alive: boolean;
  pop: number;
  settlementCount: number;
  capCount: number;
  caps: string[];
  forgotten: string[];
  government: string;
  researchTarget: string | null;
  settlements: SettlementSummary[];
}

interface TopEvent {
  year: number;
  kind: string;
  civ: number | null;
  cell: number | null;
  weight: number;
  text: string;
}

interface RunSummary {
  mode: ArmMode;
  runIndex: number;
  incomplete: boolean;
  year: number;
  totalPop: number;
  totalSettlements: number;
  eventCount: number;
  decisionCount: number;
  refusalCount: number;
  civs: CivSummary[];
  topEvents: TopEvent[];
  capture: RunCapture;
}

/* ------------------------------------------------------------------ *
 * Small utilities
 * ------------------------------------------------------------------ */

const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

/** Every unordered pair (i<j) mapped through `f`. */
function pairwise<T>(items: T[], f: (a: T, b: T) => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) out.push(f(items[i], items[j]));
  }
  return out;
}

/** 1 − |∩|/|∪|; two empty sets count as identical (distance 0). */
function jaccardDistance(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return 1 - inter / (a.size + b.size - inter);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Capture sidecar I/O
 * ------------------------------------------------------------------ */

const capturePath = (dbPath: string): string => `${dbPath}.capture.json`;

function readCapture(path: string): RunCapture | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RunCapture;
  } catch {
    return null; // corrupt sidecar → treat the run as needing a fresh start
  }
}

function writeCapture(path: string, capture: RunCapture): void {
  writeFileSync(path, JSON.stringify(capture));
}

function newCapture(cfg: RunConfig, world: World): RunCapture {
  const initialCaps: Record<number, string[]> = {};
  for (const civ of world.civs) initialCaps[civ.id] = [...civ.capabilities];
  return {
    mode: cfg.mode,
    seed: cfg.seed,
    runIndex: cfg.runIndex,
    targetYears: cfg.years,
    model: cfg.mode === "llm" ? cfg.model : undefined,
    completeYear: world.year,
    done: false,
    initialCaps,
    discoveries: [],
    losses: [],
    checkpoints: [checkpointOf(world)],
    resumes: [],
    llm: cfg.mode === "llm" ? emptyTelemetry() : undefined,
  };
}

function emptyTelemetry(): LlmTelemetry {
  return {
    calls: 0,
    retries: 0,
    terminalFailures: 0,
    degraded: 0,
    refusals: 0,
    emptySets: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    errors: [],
  };
}

function checkpointOf(world: World): Checkpoint {
  return {
    year: world.year,
    civs: world.civs.map((civ) => ({
      id: civ.id,
      pop: Math.round(civPopulation(world, civ.id)),
      settlements: world.settlements.filter((s) => s.civ === civ.id).length,
      caps: civ.capabilities.length,
    })),
  };
}

/* ------------------------------------------------------------------ *
 * Brains: perturbed heuristic, instrumented LLM
 * ------------------------------------------------------------------ */

/**
 * The chaos-floor brain: the deterministic heuristic with the smallest
 * nondeterminism-equivalent injection we can define — seeded per run, so each
 * perturbed run is itself reproducible while the N runs differ. Per decision:
 * 20% drop one directive, 20% swap two, 10% jitter the research share ±0.05.
 * This stands in for "an agent whose choices vary without being strategic".
 */
function createPerturbedBrain(runIndex: number): Brain {
  const inner = createHeuristicBrain();
  return {
    kind: "perturbed-heuristic",
    async decide(ctx: DecisionContext): Promise<DirectiveSet> {
      const set = await inner.decide(ctx);
      const rng = new Rng(hashSeed("perturb", runIndex, ctx.civ.id, ctx.world.year));
      const ds: Directive[] = [...set.directives];
      if (ds.length > 1 && rng.chance(0.2)) ds.splice(rng.int(0, ds.length - 1), 1);
      if (ds.length > 1 && rng.chance(0.2)) {
        const i = rng.int(0, ds.length - 1);
        const j = rng.int(0, ds.length - 1);
        [ds[i], ds[j]] = [ds[j], ds[i]];
      }
      if (rng.chance(0.1)) {
        const research = Math.min(1, Math.max(0, ctx.civ.policy.research + rng.range(-0.05, 0.05)));
        ds.push({ type: "policy", research, rationale: "perturbation" });
      }
      return { directives: ds };
    },
  };
}

/** Transient = worth retrying: connection drops, rate limits, server errors. */
function isTransientError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true;
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    return status === 408 || status === 429 || status === 529 || (status !== undefined && status >= 500);
  }
  return false;
}

/**
 * Mirrors `createLlmBrain`'s request exactly — same cached briefing blocks,
 * same structured-output schema — but with telemetry, a transient-only retry
 * layer, and headroom for adaptive thinking. A terminal throw is rethrown so
 * the loop's heuristic fallback fires; every such throw is counted, because a
 * run that was half-heuristic must not be read as an LLM run.
 */
function createInstrumentedLlmBrain(
  model: string,
  maxTokens: number,
  telemetry: LlmTelemetry,
): Brain {
  const client = new Anthropic({ maxRetries: 1 });
  return {
    kind: "llm-instrumented",
    async decide({ briefing }: DecisionContext): Promise<DirectiveSet> {
      for (let attempt = 0; ; attempt++) {
        try {
          const message = await client.messages.create({
            model,
            max_tokens: maxTokens,
            system: briefing.system,
            messages: [{ role: "user", content: briefing.context }],
            output_config: {
              format: {
                type: "json_schema",
                schema: DIRECTIVE_OUTPUT_SCHEMA as Record<string, unknown>,
              },
            },
          });
          telemetry.calls++;
          const u = message.usage;
          telemetry.inputTokens += u.input_tokens;
          telemetry.outputTokens += u.output_tokens;
          telemetry.cacheReadTokens += u.cache_read_input_tokens ?? 0;
          telemetry.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
          if (message.stop_reason === "refusal") {
            telemetry.refusals++;
            return { directives: [] };
          }
          if (message.stop_reason === "max_tokens") telemetry.degraded++;
          let text = "";
          for (const block of message.content) {
            if (block.type === "text") text += block.text;
          }
          const set = parseDirectiveSet(text);
          if (set.directives.length === 0) telemetry.emptySets++;
          return set;
        } catch (err) {
          if (attempt < LLM_ATTEMPTS - 1 && isTransientError(err)) {
            telemetry.retries++;
            await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
            continue;
          }
          telemetry.terminalFailures++;
          if (telemetry.errors.length < 20) {
            telemetry.errors.push(String(err).slice(0, 300));
          }
          throw err; // → loop falls back to the heuristic for this one decision
        }
      }
    },
  };
}

/* --- CLI transport: the user's Claude subscription via the official CLI ---
 *
 * `claude -p` with a custom --system-prompt (which fully replaces Claude
 * Code's own) and all tools disallowed is a plain, supported way to run a
 * completion on subscription OAuth — no API key, nothing billed per token.
 * Differences from the API transport, stated for the findings: no structured-
 * output schema enforcement (the briefing must ask for bare JSON and
 * `parseDirectiveSet` does the decoding), no stop_reason:"refusal" channel,
 * and each decision is a fresh CLI process (~3–5s overhead). Same briefings,
 * same adjudication — the mind is the same model.
 */

const execFileAsync = promisify(execFile);

interface CliCallOutcome {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  maxTurnsHit: boolean;
}

const isUsageLimitText = (s: string): boolean =>
  /usage limit|rate limit|hit the limit|limit reached|too many requests|overloaded|429|529/i.test(
    s,
  );

async function callClaudeCli(
  model: string,
  system: string,
  prompt: string,
): Promise<CliCallOutcome> {
  const args = [
    "-p",
    prompt,
    "--model",
    model,
    "--output-format",
    "json",
    "--system-prompt",
    system,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disallowedTools",
    "*",
    "--max-turns",
    "1",
  ];
  // cwd outside the repo so no project-level Claude settings or hooks apply.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("claude", args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: tmpdir(),
    }));
  } catch (err) {
    // execFile's own message echoes the command (i.e. the whole prompt) and
    // drops stdout — where the CLI put the actual reason (e.g. a usage-limit
    // result JSON). Rebuild the error from what the CLI actually said, or the
    // usage-limit classifier upstream never sees the words it matches on.
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    let reason = `${e.stderr ?? ""}\n${e.stdout ?? ""}`.trim().slice(0, 500);
    try {
      const parsed = JSON.parse(e.stdout ?? "") as { result?: unknown };
      if (typeof parsed.result === "string") reason = parsed.result.slice(0, 500);
    } catch {
      // keep the raw stderr/stdout tail
    }
    throw new Error(
      `claude CLI exit ${e.code ?? "?"}${e.killed ? " (timeout)" : ""}: ${reason || "no output"}`,
    );
  }
  const parsed = JSON.parse(stdout) as {
    is_error?: boolean;
    subtype?: string;
    result?: string;
    total_cost_usd?: number;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  if (parsed.is_error || (parsed.subtype !== "success" && parsed.subtype !== "error_max_turns")) {
    throw new Error(`claude CLI ${parsed.subtype ?? "error"}: ${parsed.result ?? stdout.slice(0, 300)}`);
  }
  return {
    text: parsed.result ?? "",
    costUsd: parsed.total_cost_usd ?? 0,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
    cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    maxTurnsHit: parsed.subtype === "error_max_turns",
  };
}

/** The API transport enforces the output schema server-side; the CLI cannot,
 *  so the prompt carries the schema verbatim instead. */
const CLI_SCHEMA_NOTE = `Respond with ONLY a JSON object that matches this JSON Schema — no markdown fences, no prose before or after it:\n${JSON.stringify(DIRECTIVE_OUTPUT_SCHEMA)}`;

/** Tolerant twin of `parseDirectiveSet` for unenforced output: if the strict
 *  parse yields nothing, retry on the outermost {...} span (fences, prose). */
function decodeDirectives(text: string): DirectiveSet {
  const direct = parseDirectiveSet(text);
  if (direct.directives.length > 0) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return parseDirectiveSet(text.slice(start, end + 1));
  return direct;
}

/** The subscription-auth twin of the instrumented API brain: same briefing,
 *  same telemetry contract. On a usage-limit hit it waits and retries — a
 *  stalled run resumes when the window resets; it never quietly goes heuristic. */
function createCliLlmBrain(model: string, telemetry: LlmTelemetry): Brain {
  telemetry.transport = "cli";
  return {
    kind: "llm-cli",
    async decide({ briefing }: DecisionContext): Promise<DirectiveSet> {
      const system = briefing.system.map((b) => b.text).join("\n\n");
      const prompt = `${briefing.context}\n\n${CLI_SCHEMA_NOTE}`;
      let waits = 0;
      for (let attempt = 0; ; ) {
        try {
          const out = await callClaudeCli(model, system, prompt);
          telemetry.calls++;
          telemetry.costUsd = (telemetry.costUsd ?? 0) + out.costUsd;
          telemetry.inputTokens += out.inputTokens;
          telemetry.outputTokens += out.outputTokens;
          telemetry.cacheReadTokens += out.cacheReadTokens;
          telemetry.cacheCreationTokens += out.cacheCreationTokens;
          if (out.maxTurnsHit) telemetry.degraded++;
          const set = decodeDirectives(out.text);
          if (set.directives.length === 0) telemetry.emptySets++;
          return set;
        } catch (err) {
          const msg = String(err);
          if (isUsageLimitText(msg)) {
            if (waits++ >= USAGE_WAIT_MAX) {
              telemetry.terminalFailures++;
              if (telemetry.errors.length < 20) telemetry.errors.push(msg.slice(0, 300));
              throw err;
            }
            process.stdout.write(
              `    (usage limit — waiting ${USAGE_WAIT_MS / 60000} min, wait ${waits}/${USAGE_WAIT_MAX})\n`,
            );
            await sleep(USAGE_WAIT_MS);
            continue; // waits do not consume retry attempts
          }
          if (attempt < LLM_ATTEMPTS - 1) {
            attempt++;
            telemetry.retries++;
            await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
            continue;
          }
          telemetry.terminalFailures++;
          if (telemetry.errors.length < 20) telemetry.errors.push(msg.slice(0, 300));
          throw err;
        }
      }
    },
  };
}

/** One real call before the arm launches, so a dead key or bad model name fails
 *  loudly here instead of producing five silently-heuristic "LLM" runs. */
async function preflightLlm(model: string, transport: "api" | "cli"): Promise<string | null> {
  try {
    if (transport === "cli") {
      const out = await callClaudeCli(
        model,
        "You are a connectivity check.",
        "Reply with the single word OK.",
      );
      return out.text.includes("OK") ? null : `unexpected reply: ${out.text.slice(0, 100)}`;
    }
    const client = new Anthropic({ maxRetries: 1 });
    await client.messages.create({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word OK." }],
    });
    return null;
  } catch (err) {
    return String(err);
  }
}

/* ------------------------------------------------------------------ *
 * Running one arm instance
 * ------------------------------------------------------------------ */

/**
 * On resume we go back to the snapshot matching the sidecar's last flush and
 * delete everything the abandoned attempt wrote past it: events at or after
 * that snapshot's own nextEventId (an LLM resume re-decides the replayed span,
 * so the "same ids, different content" dedupe trick that protects deterministic
 * resume would silently keep the wrong history), and any later snapshots.
 * Returns false when the DB has no snapshot at that year (corrupt → fresh run).
 */
function pruneAbandonedTimeline(dbPath: string, year: number): boolean {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("SELECT world FROM snapshots WHERE year = ?").get(year) as
      | { world: string }
      | undefined;
    if (!row) return false;
    let nextEventId: number;
    try {
      nextEventId = (JSON.parse(row.world) as { nextEventId: number }).nextEventId;
    } catch {
      return false;
    }
    db.prepare("DELETE FROM events WHERE id >= ?").run(nextEventId);
    db.prepare("DELETE FROM snapshots WHERE year > ?").run(year);
    return true;
  } finally {
    db.close();
  }
}

/** SHA-256 over the full ordered event log — the history's fingerprint. */
function hashEventLog(dbPath: string): string {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db
      .prepare(
        "SELECT id, year, kind, civ, cell, weight, text, causedBy FROM events ORDER BY id ASC",
      )
      .all() as unknown as Record<string, unknown>[];
    const hash = createHash("sha256");
    for (const r of rows) hash.update(JSON.stringify(r));
    return hash.digest("hex");
  } finally {
    db.close();
  }
}

/** Advance one run to its target, fresh or resumed, and persist its capture.
 *  Idempotent: a run already at the target is returned as-is. */
async function runOne(cfg: RunConfig): Promise<RunCapture> {
  const capPath = capturePath(cfg.dbPath);
  const label = `${cfg.mode} #${cfg.runIndex}`;
  let capture = readCapture(capPath);
  if (capture && (capture.seed !== cfg.seed || capture.mode !== cfg.mode)) capture = null;
  if (capture?.done && capture.targetYears >= cfg.years) {
    process.stdout.write(`  [${label}] already complete at year ${capture.completeYear}\n`);
    return capture;
  }

  let store: Store | null = null;
  let world: World | null = null;

  if (capture && existsSync(cfg.dbPath)) {
    if (pruneAbandonedTimeline(cfg.dbPath, capture.completeYear)) {
      store = new Store(cfg.dbPath);
      world = store.loadAt(capture.completeYear);
    }
    if (world && store) {
      const atYear = world.year;
      capture.resumes.push({ atYear });
      capture.done = false;
      capture.targetYears = cfg.years;
      capture.discoveries = capture.discoveries.filter((d) => d.year <= atYear);
      capture.losses = capture.losses.filter((d) => d.year <= atYear);
      capture.checkpoints = capture.checkpoints.filter((c) => c.year <= atYear);
      process.stdout.write(`  [${label}] resuming from year ${atYear}\n`);
    } else {
      store?.close();
      store = null;
      capture = null;
    }
  }

  if (!world || !store || !capture) {
    // Fresh start — the same initialisation semantics as the CLI's `new`:
    // drop any stale DB and its WAL sidecars, drain worldgen events, snapshot.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(cfg.dbPath + suffix, { force: true });
    rmSync(capPath, { force: true });
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    store = new Store(cfg.dbPath);
    world = generateWorld(cfg.seed);
    store.setMeta("seed", String(cfg.seed));
    store.setMeta("format", "1");
    store.setMeta("experiment", `${cfg.mode}:${cfg.runIndex}`);
    if (cfg.mode === "llm" && cfg.model) store.setMeta("model", cfg.model);
    store.appendEvents(world.events);
    world.events.length = 0;
    store.saveSnapshot(world);
    capture = newCapture(cfg, world);
    writeCapture(capPath, capture);
  }

  const cap = capture;
  const w0 = world;
  const t0 = performance.now();
  const prevCaps = new Map<number, Set<string>>(
    w0.civs.map((c) => [c.id, new Set(c.capabilities)]),
  );
  let lastLogged = w0.year;

  const onTick = (w: World): void => {
    for (const civ of w.civs) {
      const prev = prevCaps.get(civ.id) ?? new Set<string>();
      const now = new Set(civ.capabilities);
      for (const c of now) {
        if (!prev.has(c)) cap.discoveries.push({ civ: civ.id, cap: c, year: w.year });
      }
      for (const c of prev) {
        if (!now.has(c)) cap.losses.push({ civ: civ.id, cap: c, year: w.year });
      }
      prevCaps.set(civ.id, now);
    }
    // Flush on the snapshot cadence, AFTER the loop wrote the snapshot for this
    // year — so the sidecar never runs ahead of a durable resume point.
    if (w.year % SNAPSHOT_INTERVAL === 0) {
      cap.checkpoints.push(checkpointOf(w));
      cap.completeYear = w.year;
      writeCapture(capPath, cap);
    }
    if (w.year - lastLogged >= PROGRESS_EVERY || w.year >= cfg.years) {
      lastLogged = w.year;
      let pop = 0;
      for (const civ of w.civs) pop += civPopulation(w, civ.id);
      const extra = cap.llm
        ? `  ·  calls ${cap.llm.calls}, fallbacks ${cap.llm.terminalFailures}`
        : "";
      process.stdout.write(`  [${label}] year ${w.year}  ·  pop ${fmt(pop)}${extra}\n`);
    }
  };

  if (cfg.mode === "engine") {
    advanceWorld(store, w0, cfg.years, { onTick });
  } else {
    let brain: Brain;
    let fallback: Brain | undefined;
    if (cfg.mode === "heuristic") {
      brain = createHeuristicBrain();
      fallback = brain;
    } else if (cfg.mode === "perturbed") {
      brain = createPerturbedBrain(cfg.runIndex);
      fallback = createHeuristicBrain();
    } else {
      const telemetry = cap.llm ?? emptyTelemetry();
      cap.llm = telemetry;
      brain =
        cfg.transport === "cli"
          ? createCliLlmBrain(cfg.model ?? DEFAULT_MODEL, telemetry)
          : createInstrumentedLlmBrain(
              cfg.model ?? DEFAULT_MODEL,
              cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
              telemetry,
            );
      fallback = createHeuristicBrain();
    }
    await advanceWorldWithDecisions(
      store,
      w0,
      cfg.years,
      (w) => decideForWorld(w, { brain, fallback }),
      { onTick },
    );
  }

  // Final flush: hash the world and the whole event log, mark done.
  if (cap.checkpoints[cap.checkpoints.length - 1]?.year !== w0.year) {
    cap.checkpoints.push(checkpointOf(w0));
  }
  cap.completeYear = w0.year;
  cap.wallSeconds = (cap.wallSeconds ?? 0) + (performance.now() - t0) / 1000;
  store.close();
  cap.worldHash = sha256(JSON.stringify(serializeWorld(w0)));
  cap.eventLogHash = hashEventLog(cfg.dbPath);
  cap.done = true;
  writeCapture(capPath, cap);
  process.stdout.write(
    `  [${label}] done — year ${w0.year}, ${cap.wallSeconds.toFixed(1)}s total\n`,
  );
  return cap;
}

/* ------------------------------------------------------------------ *
 * Per-run summaries (from DB + capture — never from process memory)
 * ------------------------------------------------------------------ */

function buildRunSummary(cfg: RunConfig): RunSummary | null {
  const capture = readCapture(capturePath(cfg.dbPath));
  if (!capture || !existsSync(cfg.dbPath)) return null;

  const store = new Store(cfg.dbPath);
  const world = store.loadLatest();
  store.close();
  if (!world) return null;

  const db = new DatabaseSync(cfg.dbPath);
  let eventCount = 0;
  let decisionCount = 0;
  let refusalCount = 0;
  let topEvents: TopEvent[] = [];
  try {
    const kinds = db
      .prepare("SELECT kind, COUNT(*) AS n FROM events GROUP BY kind")
      .all() as unknown as { kind: string; n: number }[];
    for (const k of kinds) {
      eventCount += Number(k.n);
      if (k.kind === "decision") decisionCount = Number(k.n);
      if (k.kind === "refusal") refusalCount = Number(k.n);
    }
    // Explicit tie-break (weight DESC, id ASC): weights come in per-kind bands,
    // so ties are pervasive and an unspecified order would change the set.
    topEvents = db
      .prepare(
        "SELECT year, kind, civ, cell, weight, text FROM events ORDER BY weight DESC, id ASC LIMIT ?",
      )
      .all(TOP_EVENTS) as unknown as TopEvent[];
  } finally {
    db.close();
  }

  const civs: CivSummary[] = world.civs.map((civ: Civ) => {
    const sites = world.settlements.filter((s) => s.civ === civ.id);
    return {
      id: civ.id,
      key: civ.key,
      name: civ.name,
      alive: civ.alive,
      pop: Math.round(civPopulation(world, civ.id)),
      settlementCount: sites.length,
      capCount: civ.capabilities.length,
      caps: [...civ.capabilities].sort(),
      forgotten: [...civ.forgotten].sort(),
      government: civ.government.form,
      researchTarget: civ.research.target,
      settlements: sites.map((s) => ({
        cell: s.cell,
        name: s.name,
        lat: Math.round(cellLat(s.cell) * 10) / 10,
        lon: Math.round(cellLon(s.cell) * 10) / 10,
        pop: Math.round(settlementPop(s)),
      })),
    };
  });

  return {
    mode: cfg.mode,
    runIndex: cfg.runIndex,
    incomplete: !capture.done || capture.completeYear < cfg.years,
    year: world.year,
    totalPop: civs.reduce((a, c) => a + c.pop, 0),
    totalSettlements: world.settlements.length,
    eventCount,
    decisionCount,
    refusalCount,
    civs,
    topEvents,
    capture,
  };
}

/* ------------------------------------------------------------------ *
 * Divergence metrics
 * ------------------------------------------------------------------ */

/** Reconstruct a civ's capability set at a year from the capture's initial set
 *  plus its dated discoveries and losses (both are end-of-year states). */
function capsAtYear(capture: RunCapture, civId: number, year: number): Set<string> {
  const held = new Set(capture.initialCaps[civId] ?? []);
  const changes: { year: number; cap: string; add: boolean }[] = [];
  for (const d of capture.discoveries) {
    if (d.civ === civId && d.year <= year) changes.push({ year: d.year, cap: d.cap, add: true });
  }
  for (const l of capture.losses) {
    if (l.civ === civId && l.year <= year) changes.push({ year: l.year, cap: l.cap, add: false });
  }
  changes.sort((a, b) => a.year - b.year);
  for (const c of changes) {
    if (c.add) held.add(c.cap);
    else held.delete(c.cap);
  }
  return held;
}

const normalizeGovernment = (form: string): string =>
  form.toLowerCase().trim().replace(/^(a|an|the)\s+/, "");

interface PairStat {
  mean: number;
  min: number;
  max: number;
}

function pairStat(values: number[]): PairStat {
  if (values.length === 0) return { mean: 0, min: 0, max: 0 };
  return { mean: mean(values), min: Math.min(...values), max: Math.max(...values) };
}

interface CivMetrics {
  civId: number;
  /** Pairwise Jaccard distance between final capability sets. */
  capJaccard: PairStat;
  /** Capabilities held in some runs but not all, at the end. */
  partialCaps: string[];
  /** Mean/max std-dev of discovery year, over caps discovered in ≥2 runs. */
  discoveryYearSd: { mean: number; max: number; caps: number };
  /** The ten most divergent discoveries: capability → per-run years. */
  mostDivergent: { cap: string; years: (number | null)[]; sd: number }[];
  /** Pairwise Jaccard distance between settled-cell sets. */
  settledCellJaccard: PairStat;
  settlementCounts: number[];
  popValues: number[];
  popCv: number;
  governmentForms: string[]; // raw, one per run
  distinctGovernments: number; // after normalization
  names: string[]; // self-chosen names, one per run
}

interface ArmMetrics {
  mode: ArmMode;
  runs: number;
  identical: boolean; // all runs share both hashes
  civs: CivMetrics[];
  /** Pairwise overlap distance of top-20 event identity tuples (kind:year:civ:cell). */
  topEventJaccard: PairStat;
  /** Mean pairwise capability-set Jaccard distance across civs, per sample year. */
  trajectory: { year: number; meanJaccard: number }[];
  eventCounts: number[];
  decisionCounts: number[];
  refusalCounts: number[];
}

function computeArmMetrics(mode: ArmMode, runs: RunSummary[]): ArmMetrics | null {
  const complete = runs.filter((r) => !r.incomplete);
  if (complete.length === 0) return null;
  const civIds = complete[0].civs.map((c) => c.id);

  const civs: CivMetrics[] = civIds.map((civId) => {
    const per = complete.map((r) => {
      const civ = r.civs.find((c) => c.id === civId);
      return {
        caps: new Set(civ?.caps ?? []),
        cells: new Set((civ?.settlements ?? []).map((s) => String(s.cell))),
        pop: civ?.pop ?? 0,
        settlements: civ?.settlementCount ?? 0,
        government: civ?.government ?? "",
        name: civ?.name ?? "",
        capture: r.capture,
      };
    });

    const union = new Set<string>();
    for (const p of per) for (const c of p.caps) union.add(c);
    const partialCaps = [...union]
      .filter((c) => !per.every((p) => p.caps.has(c)))
      .sort();

    // Discovery year per capability per run (null = never discovered there).
    // Initial capabilities are year-0 holdings, not discoveries; caps discovered
    // in only one run contribute to partialCaps, not to the year spread.
    const discoveryYears = new Map<string, (number | null)[]>();
    for (const c of union) {
      const years = per.map((p) => {
        const d = p.capture.discoveries.find((x) => x.civ === civId && x.cap === c);
        return d ? d.year : null;
      });
      discoveryYears.set(c, years);
    }
    const spreads: { cap: string; years: (number | null)[]; sd: number }[] = [];
    for (const [capId, years] of discoveryYears) {
      const known = years.filter((y): y is number => y !== null);
      if (known.length >= 2) spreads.push({ cap: capId, years, sd: stddev(known) });
    }
    spreads.sort((a, b) => b.sd - a.sd);

    const pops = per.map((p) => p.pop);
    const popMean = mean(pops);

    return {
      civId,
      capJaccard: pairStat(pairwise(per, (a, b) => jaccardDistance(a.caps, b.caps))),
      partialCaps,
      discoveryYearSd: {
        mean: mean(spreads.map((s) => s.sd)),
        max: spreads.length ? spreads[0].sd : 0,
        caps: spreads.length,
      },
      mostDivergent: spreads.slice(0, 10),
      settledCellJaccard: pairStat(
        pairwise(per, (a, b) => jaccardDistance(a.cells, b.cells)),
      ),
      settlementCounts: per.map((p) => p.settlements),
      popValues: pops,
      popCv: popMean > 0 ? stddev(pops) / popMean : 0,
      governmentForms: per.map((p) => p.government),
      distinctGovernments: new Set(per.map((p) => normalizeGovernment(p.government))).size,
      names: per.map((p) => p.name),
    };
  });

  // Event identity tuples, not raw text: LLM-chosen civ names are interpolated
  // into event text, which would score two same-shaped histories as disjoint.
  const topSets = complete.map(
    (r) => new Set(r.topEvents.map((e) => `${e.kind}:${e.year}:${e.civ}:${e.cell}`)),
  );

  const years: number[] = [];
  const target = complete[0].capture.targetYears;
  for (let y = TRAJECTORY_STEP; y <= target; y += TRAJECTORY_STEP) years.push(y);
  const trajectory = years.map((year) => {
    const perCiv = civIds.map((civId) => {
      const sets = complete.map((r) => capsAtYear(r.capture, civId, year));
      return mean(pairwise(sets, jaccardDistance));
    });
    return { year, meanJaccard: mean(perCiv) };
  });

  const hashes = new Set(
    complete.map((r) => `${r.capture.worldHash}:${r.capture.eventLogHash}`),
  );

  return {
    mode,
    runs: complete.length,
    identical: hashes.size === 1,
    civs,
    topEventJaccard: pairStat(pairwise(topSets, jaccardDistance)),
    trajectory,
    eventCounts: complete.map((r) => r.eventCount),
    decisionCounts: complete.map((r) => r.decisionCount),
    refusalCounts: complete.map((r) => r.refusalCount),
  };
}

/* ------------------------------------------------------------------ *
 * Cost estimate
 * ------------------------------------------------------------------ */

function estimateCost(model: string, t: LlmTelemetry): number {
  const family = model.includes("sonnet") ? "sonnet" : model.includes("haiku") ? "haiku" : "opus";
  const p = PRICES[family];
  const uncachedIn = Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheCreationTokens);
  return (
    (uncachedIn * p.in +
      t.cacheReadTokens * p.read +
      t.cacheCreationTokens * p.write +
      t.outputTokens * p.out) /
    1e6
  );
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const f3 = (v: number): string => v.toFixed(3);

function armTitle(mode: ArmMode): string {
  switch (mode) {
    case "engine":
      return "Engine only (determinism gate)";
    case "heuristic":
      return "Heuristic control (deterministic agent loop)";
    case "perturbed":
      return "Perturbed heuristic (chaos floor)";
    case "llm":
      return "LLM (the measurement)";
  }
}

function renderRunTable(runs: RunSummary[]): string[] {
  const lines = [
    "| run | year | population | settlements | events | decisions | refusals | caps per civ |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const r of runs) {
    const caps = r.civs.map((c) => c.capCount).join("/");
    const flag = r.incomplete ? " ⚠ incomplete" : "";
    lines.push(
      `| ${r.runIndex}${flag} | ${r.year} | ${fmt(r.totalPop)} | ${r.totalSettlements} | ${r.eventCount} | ${r.decisionCount} | ${r.refusalCount} | ${caps} |`,
    );
  }
  return lines;
}

function renderCivDetail(runs: RunSummary[]): string[] {
  const lines: string[] = [];
  for (const r of runs) {
    lines.push(`#### Run ${r.runIndex}${r.incomplete ? " (incomplete)" : ""}`, "");
    lines.push(
      "| civ | name | pop | settlements | caps | forgotten | government | researching |",
      "|---|---|---|---|---|---|---|---|",
    );
    for (const c of r.civs) {
      const dead = c.alive ? "" : " †";
      lines.push(
        `| ${c.key}${dead} | ${c.name} | ${fmt(c.pop)} | ${c.settlementCount} | ${c.capCount} | ${c.forgotten.length} | ${c.government} | ${c.researchTarget ?? "—"} |`,
      );
    }
    lines.push("");
  }
  return lines;
}

function renderTopEvents(r: RunSummary): string[] {
  const lines = [`#### Run ${r.runIndex} — top ${TOP_EVENTS} events by weight`, ""];
  for (const e of r.topEvents) {
    lines.push(`- \`${String(e.year).padStart(5)}\` **${e.kind}** (${e.weight.toFixed(2)}) ${e.text}`);
  }
  lines.push("");
  return lines;
}

function renderMetrics(m: ArmMetrics): string[] {
  const lines: string[] = [];
  lines.push(
    `Runs compared: ${m.runs}. Histories bit-identical: **${m.identical ? "yes" : "no"}**.`,
    "",
    "| civ | cap Jaccard (mean) | partial caps | discovery-yr σ (mean/max) | settled-cell Jaccard | settlement counts | pop CV | distinct governments |",
    "|---|---|---|---|---|---|---|---|",
  );
  for (const c of m.civs) {
    lines.push(
      `| ${c.civId} | ${f3(c.capJaccard.mean)} | ${c.partialCaps.length} | ${c.discoveryYearSd.mean.toFixed(1)} / ${c.discoveryYearSd.max.toFixed(1)} | ${f3(c.settledCellJaccard.mean)} | ${c.settlementCounts.join(", ")} | ${pct(c.popCv)} | ${c.distinctGovernments} |`,
    );
  }
  lines.push(
    "",
    `Top-${TOP_EVENTS}-event overlap distance (identity tuples): mean ${f3(m.topEventJaccard.mean)} (min ${f3(m.topEventJaccard.min)}, max ${f3(m.topEventJaccard.max)}).`,
    "",
    "Capability-set divergence over time (mean pairwise Jaccard across civs):",
    "",
    `| year | ${m.trajectory.map((t) => t.year).join(" | ")} |`,
    `|---|${m.trajectory.map(() => "---").join("|")}|`,
    `| Jaccard | ${m.trajectory.map((t) => f3(t.meanJaccard)).join(" | ")} |`,
    "",
  );
  return lines;
}

function renderLlmTelemetry(runs: RunSummary[], model: string): string[] {
  const lines: string[] = [
    "| run | calls | fallbacks | degraded | refusals | empty sets | retries | cache read | cache write | uncached in | out tokens | est. cost | wall |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  let cost = 0;
  for (const r of runs) {
    const t = r.capture.llm;
    if (!t) continue;
    const decisions = t.calls + t.terminalFailures;
    const contamination = decisions > 0 ? t.terminalFailures / decisions : 0;
    const flag =
      contamination >= CONTAMINATION_TAINT
        ? " ☠ TAINTED"
        : contamination >= CONTAMINATION_FLAG
          ? " ⚠"
          : "";
    const uncached = Math.max(0, t.inputTokens - t.cacheReadTokens - t.cacheCreationTokens);
    const c = t.transport === "cli" ? (t.costUsd ?? 0) : estimateCost(model, t);
    cost += c;
    lines.push(
      `| ${r.runIndex}${flag} | ${t.calls} | ${t.terminalFailures} | ${t.degraded} | ${t.refusals} | ${t.emptySets} | ${t.retries} | ${fmt(t.cacheReadTokens)} | ${fmt(t.cacheCreationTokens)} | ${fmt(uncached)} | ${fmt(t.outputTokens)} | $${c.toFixed(2)} | ${(r.capture.wallSeconds ?? 0).toFixed(0)}s |`,
    );
  }
  const viaCli = runs.some((r) => r.capture.llm?.transport === "cli");
  lines.push(
    "",
    viaCli
      ? `Model \`${model}\` via the Claude Code CLI on subscription auth — nothing billed per token; **$${cost.toFixed(2)}** is the CLI-reported notional usage.`
      : `Model \`${model}\`. Total estimated cost **$${cost.toFixed(2)}** (list prices; the console bill is authoritative).`,
    "A fallback is a decision the heuristic took after terminal API failure — a run flagged ☠ was ≥10% heuristic and is not a clean LLM run.",
    "Degraded = output truncated at max_tokens; refusals and empty sets are silent 'held course' decisions, disambiguated here because the event log cannot.",
    "",
  );
  return lines;
}

interface ReportInputs {
  seed: number;
  years: number;
  model: string;
  llmStatus: string;
  arms: Map<ArmMode, RunSummary[]>;
  metrics: Map<ArmMode, ArmMetrics>;
}

function renderReport(inp: ReportInputs): string {
  const lines: string[] = [];
  lines.push(
    "# Divergence experiment report",
    "",
    `Seed **${inp.seed}**, target year **${inp.years}**. Generated by \`packages/runner/src/experiment.ts\` — do not edit by hand; re-run with \`--report-only\` to regenerate.`,
    "",
    `LLM arm: ${inp.llmStatus}.`,
    "",
    "Reading guide: the **heuristic** arm must be identical across runs (it verifies the pipeline). The **perturbed** arm is the chaos floor — how much divergence any nondeterminism buys through sheer snowballing. The **llm** arm is the measurement: its numbers must clear the perturbed floor for 'agent choice shapes history' to hold. Engine RNG is hash-keyed per (subsystem, entity, year), so no divergence here can come from random-stream desync — only from real state differences.",
    "",
  );

  const order: ArmMode[] = ["engine", "heuristic", "perturbed", "llm"];
  for (const mode of order) {
    const runs = inp.arms.get(mode);
    if (!runs || runs.length === 0) continue;
    lines.push(`## ${armTitle(mode)}`, "");
    lines.push(...renderRunTable(runs), "");
    const m = inp.metrics.get(mode);
    if (m && runs.length > 1) {
      lines.push(`### Divergence metrics — ${mode}`, "");
      lines.push(...renderMetrics(m));
    }
    if (mode === "llm") {
      lines.push(`### Telemetry — ${mode}`, "");
      lines.push(...renderLlmTelemetry(runs, inp.model));
    }
    if (mode !== "engine") {
      lines.push(`### Final states — ${mode}`, "");
      lines.push(...renderCivDetail(runs));
      lines.push(`### Headline events — ${mode}`, "");
      const distinct = mode === "heuristic" ? runs.slice(0, 1) : runs;
      if (mode === "heuristic" && runs.length > 1) {
        lines.push("_All heuristic runs are identical; one shown._", "");
      }
      for (const r of distinct) lines.push(...renderTopEvents(r));
    }
  }

  lines.push(
    "## Cross-arm comparison",
    "",
    "| metric | heuristic | perturbed | llm |",
    "|---|---|---|---|",
  );
  const cell = (mode: ArmMode, f: (m: ArmMetrics) => string): string => {
    const m = inp.metrics.get(mode);
    return m ? f(m) : "—";
  };
  const rows: [string, (m: ArmMetrics) => string][] = [
    ["histories identical", (m) => (m.identical ? "yes" : "no")],
    ["mean final cap Jaccard", (m) => f3(mean(m.civs.map((c) => c.capJaccard.mean)))],
    ["mean discovery-yr σ", (m) => mean(m.civs.map((c) => c.discoveryYearSd.mean)).toFixed(1)],
    ["mean settled-cell Jaccard", (m) => f3(mean(m.civs.map((c) => c.settledCellJaccard.mean)))],
    ["mean pop CV", (m) => pct(mean(m.civs.map((c) => c.popCv)))],
    ["top-event overlap distance", (m) => f3(m.topEventJaccard.mean)],
    ["distinct governments (sum)", (m) => String(m.civs.reduce((a, c) => a + c.distinctGovernments, 0))],
  ];
  for (const [name, f] of rows) {
    lines.push(
      `| ${name} | ${cell("heuristic", f)} | ${cell("perturbed", f)} | ${cell("llm", f)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

const asString = (v: string | boolean | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;

function asNumber(v: string | boolean | undefined, fallback: number): number {
  const s = asString(v);
  if (s === undefined || s.trim() === "" || !Number.isFinite(Number(s))) return fallback;
  return Number(s);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const seed = asNumber(flags.seed, 1);
  const runs = asNumber(flags.runs, 5);
  const years = asNumber(flags.years, 1500);
  const model = asString(flags.model) ?? DEFAULT_MODEL;
  const maxTokens = asNumber(flags["max-tokens"], DEFAULT_MAX_TOKENS);
  const llmFlag = asString(flags.llm) ?? "auto";
  const outDir = asString(flags.out) ?? "docs/divergence";
  const dbDir = join(asString(flags["db-dir"]) ?? "worlds/experiments", `seed-${seed}`);
  const reportOnly = flags["report-only"] === true;

  if (!["auto", "require", "off"].includes(llmFlag)) fail("--llm must be auto|require|off");
  const haveKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const transportFlag = asString(flags.transport) ?? "auto";
  if (!["auto", "api", "cli"].includes(transportFlag)) fail("--transport must be auto|api|cli");
  // auto: a key means the metered API; no key falls back to the Claude Code CLI
  // on the user's subscription auth (validated by the preflight, never assumed).
  const transport: "api" | "cli" =
    transportFlag === "auto" ? (haveKey ? "api" : "cli") : (transportFlag as "api" | "cli");
  if (llmFlag === "require" && transport === "api" && !haveKey) {
    fail("--llm require with the api transport, but ANTHROPIC_API_KEY is not set");
  }
  const runLlm = llmFlag !== "off" && (transport === "cli" || haveKey);

  mkdirSync(dbDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const cfg = (mode: ArmMode, runIndex: number): RunConfig => ({
    mode,
    seed,
    years,
    runIndex,
    dbPath: join(dbDir, `${mode}-${runIndex}.db`),
    model: mode === "llm" ? model : undefined,
    maxTokens: mode === "llm" ? maxTokens : undefined,
    transport: mode === "llm" ? transport : undefined,
  });

  const armConfigs = new Map<ArmMode, RunConfig[]>([
    ["engine", [0, 1].map((i) => cfg("engine", i))],
    ["heuristic", Array.from({ length: runs }, (_, i) => cfg("heuristic", i))],
    ["perturbed", Array.from({ length: runs }, (_, i) => cfg("perturbed", i))],
    ["llm", Array.from({ length: runs }, (_, i) => cfg("llm", i))],
  ]);

  let llmStatus: string;
  let llmIncomplete = false;

  if (reportOnly) {
    llmStatus = "report rebuilt from existing runs";
  } else {
    // Arm A — the determinism gate. Everything else is meaningless if this fails.
    process.stdout.write(`Arm A: engine-only ×2 (determinism gate), seed ${seed} → year ${years}\n`);
    const engine: RunCapture[] = [];
    for (const c of armConfigs.get("engine") ?? []) engine.push(await runOne(c));
    const [e0, e1] = engine;
    if (e0.worldHash !== e1.worldHash || e0.eventLogHash !== e1.eventLogHash) {
      fail(
        "DETERMINISM GATE FAILED: two engine-only runs of the same seed differ.\n" +
          `  run 0: world ${e0.worldHash} events ${e0.eventLogHash}\n` +
          `  run 1: world ${e1.worldHash} events ${e1.eventLogHash}\n` +
          "The experiment measures nothing until the engine is deterministic again.",
      );
    }
    process.stdout.write("  gate passed: runs bit-identical\n");

    // Arm B — heuristic control through the full decision path.
    process.stdout.write(`Arm B: heuristic control ×${runs}\n`);
    const heuristic: RunCapture[] = [];
    for (const c of armConfigs.get("heuristic") ?? []) heuristic.push(await runOne(c));
    const hHashes = new Set(heuristic.map((h) => `${h.worldHash}:${h.eventLogHash}`));
    if (hHashes.size !== 1) {
      fail(
        "CONTROL ARM NONDETERMINISM: heuristic runs differ — the decision path " +
          "itself is nondeterministic, so LLM divergence cannot be attributed. Fix before measuring.",
      );
    }
    process.stdout.write("  control arm identical across runs, as expected\n");

    // Arm B′ — the chaos floor.
    process.stdout.write(`Arm B′: perturbed heuristic ×${runs}\n`);
    for (const c of armConfigs.get("perturbed") ?? []) await runOne(c);

    // Arm C — the measurement.
    if (!runLlm) {
      llmStatus =
        llmFlag === "off"
          ? "skipped (--llm off)"
          : "SKIPPED — no ANTHROPIC_API_KEY set; heuristic was NOT substituted";
      process.stdout.write(`Arm C: ${llmStatus}\n`);
    } else {
      const via = transport === "cli" ? "Claude Code CLI, subscription auth" : "Anthropic API";
      process.stdout.write(`Arm C: llm ×${runs} (model ${model} via ${via}) — preflight…\n`);
      const preflightError = await preflightLlm(model, transport);
      if (preflightError) fail(`LLM preflight failed: ${preflightError}`);
      process.stdout.write("  preflight ok; launching runs concurrently\n");
      const settled = await Promise.allSettled(
        (armConfigs.get("llm") ?? []).map((c) => runOne(c)),
      );
      const failures = settled.filter((s) => s.status === "rejected");
      for (const f of failures) {
        process.stderr.write(`  llm run failed: ${String((f as PromiseRejectedResult).reason).slice(0, 300)}\n`);
      }
      llmIncomplete = failures.length > 0;
      llmStatus = llmIncomplete
        ? `ran with model ${model} via ${via}; ${failures.length}/${runs} runs incomplete — re-invoke to resume`
        : `ran with model ${model} via ${via}`;
    }
  }

  // Report — always built from disk, so --report-only sees exactly what a
  // normal invocation would.
  const arms = new Map<ArmMode, RunSummary[]>();
  const metrics = new Map<ArmMode, ArmMetrics>();
  for (const [mode, configs] of armConfigs) {
    const summaries = configs
      .map((c) => buildRunSummary(c))
      .filter((s): s is RunSummary => s !== null);
    if (summaries.length === 0) continue;
    arms.set(mode, summaries);
    if (mode !== "engine") {
      const m = computeArmMetrics(mode, summaries);
      if (m) metrics.set(mode, m);
    }
  }
  if (reportOnly && !arms.has("llm")) {
    llmStatus = "no llm runs found on disk";
  } else if (reportOnly && arms.has("llm")) {
    const lr = arms.get("llm") ?? [];
    llmIncomplete = lr.some((r) => r.incomplete);
    llmStatus = `report rebuilt from ${lr.length} run(s) on disk${llmIncomplete ? " (some incomplete)" : ""}`;
  }

  const report = renderReport({ seed, years, model, llmStatus, arms, metrics });
  const mdPath = join(outDir, "report.md");
  writeFileSync(mdPath, report);
  const jsonPath = join(outDir, "report.json");
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        seed,
        years,
        model,
        llmStatus,
        metrics: Object.fromEntries(metrics),
        runs: Object.fromEntries(
          [...arms].map(([mode, rs]) => [
            mode,
            rs.map((r) => ({
              runIndex: r.runIndex,
              incomplete: r.incomplete,
              year: r.year,
              totalPop: r.totalPop,
              totalSettlements: r.totalSettlements,
              eventCount: r.eventCount,
              decisionCount: r.decisionCount,
              refusalCount: r.refusalCount,
              civs: r.civs,
              topEvents: r.topEvents,
              discoveries: r.capture.discoveries,
              losses: r.capture.losses,
              checkpoints: r.capture.checkpoints,
              resumes: r.capture.resumes,
              llm: r.capture.llm,
              worldHash: r.capture.worldHash,
              eventLogHash: r.capture.eventLogHash,
              wallSeconds: r.capture.wallSeconds,
            })),
          ]),
        ),
      },
      null,
      1,
    ),
  );

  process.stdout.write(`\nReport written: ${mdPath} and ${jsonPath}\n`);
  const show = (mode: ArmMode): void => {
    const m = metrics.get(mode);
    if (!m) return;
    process.stdout.write(
      `  ${mode.padEnd(10)} capJaccard ${f3(mean(m.civs.map((c) => c.capJaccard.mean)))}  ` +
        `discσ ${mean(m.civs.map((c) => c.discoveryYearSd.mean)).toFixed(1)}y  ` +
        `cellJaccard ${f3(mean(m.civs.map((c) => c.settledCellJaccard.mean)))}  ` +
        `identical ${m.identical}\n`,
    );
  };
  show("heuristic");
  show("perturbed");
  show("llm");

  if (llmIncomplete) process.exit(2);
}

main().catch((err) => {
  process.stderr.write(`error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
