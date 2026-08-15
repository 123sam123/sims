/**
 * Metered model transports for the daemon — the same mind over two auths,
 * both reporting what every call cost so the attention budget can meter it.
 *
 *   - **API** ({@link createMeteredApiBrain}) — the production `createLlmBrain`
 *     with its `onUsage` hook; dollars are estimated from token usage at list
 *     prices. Requires `ANTHROPIC_API_KEY`.
 *   - **CLI** ({@link createCliSessionBrain}) — `claude -p` on the user's
 *     subscription OAuth; dollars are the CLI-reported notional
 *     `total_cost_usd` (nothing is billed per token).
 *
 * The CLI transport carries the cache strategy this ticket exists to fix. The
 * divergence experiment measured a ~4% cache hit rate: the per-civ identity
 * and chronicle rode in `--system-prompt`, so every call's cached prefix broke
 * on the first civ-specific byte. Two changes repair it:
 *
 *   1. The system prompt is now **bit-stable across all civs and all years** —
 *      the world rules plus the directive schema, nothing else. The volatile
 *      identity/context moves into the user message.
 *   2. Each civ keeps a **resumed CLI session** (`claude -p --resume`): its
 *      decisions form one conversation, so every call reads its whole prior
 *      transcript from cache and pays uncached tokens only for the new turn.
 *      Sessions reset after {@link MAX_SESSION_TURNS} turns to bound growth;
 *      the civ's chronicle (in the briefing) remains the durable memory across
 *      resets, exactly as the agent-loop design intends.
 *
 * Failure contract: throw, promptly. The attentive brain catches, refunds the
 * reservation and resolves the decision heuristically — the world never waits
 * on a transport. Usage-limit errors are classified by {@link isUsageLimitError}
 * so the caller can bench the model for a cooldown instead of paying a failed
 * process spawn per decision.
 */

import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  type Brain,
  type BrainUsage,
  createLlmBrain,
  type DecisionContext,
  DIRECTIVE_OUTPUT_SCHEMA,
  type DirectiveSet,
  parseDirectiveSet,
} from "@sim/agents";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ *
 * Cost estimation (API transport)
 * ------------------------------------------------------------------ */

/** $/MTok, 2026-08 list prices — an estimate for budgeting; the console bill
 *  is authoritative. Keyed by model family substring. */
const PRICES: Record<string, { in: number; out: number; read: number; write: number }> = {
  opus: { in: 5, out: 25, read: 0.5, write: 6.25 },
  sonnet: { in: 3, out: 15, read: 0.3, write: 3.75 },
  haiku: { in: 1, out: 5, read: 0.1, write: 1.25 },
};

export function estimateCostUsd(model: string, u: BrainUsage): number {
  const family = model.includes("sonnet") ? "sonnet" : model.includes("haiku") ? "haiku" : "opus";
  const p = PRICES[family];
  return (
    (u.inputTokens * p.in +
      u.cacheReadTokens * p.read +
      u.cacheCreationTokens * p.write +
      u.outputTokens * p.out) /
    1e6
  );
}

/* ------------------------------------------------------------------ *
 * The metering contract
 * ------------------------------------------------------------------ */

/** One completed model call, as reported to the daemon for ledger + budget. */
export interface MeteredCall {
  civ: number;
  model: string;
  costUsd: number;
  usage: BrainUsage;
}

export const DEFAULT_MODEL = "claude-opus-5";
/** Thinking is billed against max_tokens; the production default of 2048 lets
 *  it eat the structured output (divergence-experiment lesson). */
const API_MAX_TOKENS = 12_000;

/** The production API brain with per-call metering attached. */
export function createMeteredApiBrain(opts: {
  model?: string;
  onCall: (call: MeteredCall) => void;
}): Brain {
  const model = opts.model ?? DEFAULT_MODEL;
  let last: BrainUsage | null = null;
  const inner = createLlmBrain({ model, maxTokens: API_MAX_TOKENS, onUsage: (u) => (last = u) });
  return {
    kind: "llm-api-metered",
    async decide(ctx: DecisionContext): Promise<DirectiveSet> {
      last = null;
      const set = await inner.decide(ctx);
      if (last) {
        opts.onCall({ civ: ctx.civ.id, model, costUsd: estimateCostUsd(model, last), usage: last });
      }
      return set;
    },
  };
}

/* ------------------------------------------------------------------ *
 * CLI transport (subscription auth) with per-civ resumed sessions
 * ------------------------------------------------------------------ */

/** Turns before a civ's CLI session is reset. Bounds transcript growth (and
 *  therefore per-call cache reads); the chronicle carries memory across. */
export const MAX_SESSION_TURNS = 30;
const CLI_TIMEOUT_MS = 300_000;
const CLI_RETRY_BACKOFF_MS = 5_000;

/** Broad on purpose — throttle texts vary ("session limit", "usage limit",
 *  "resets 3pm", …) and a missed match turns a wait-worthy condition into a
 *  failed call per decision. */
export function isUsageLimitError(err: unknown): boolean {
  return /usage limit|session limit|rate limit|hit (the|your).*limit|limit reached|resets \d|· resets|too many requests|overloaded|429|529/i.test(
    String(err),
  );
}

/** The CLI cannot enforce an output schema server-side, so the prompt carries
 *  it verbatim. Constant, so it rides in the stable cached prefix. */
const CLI_SCHEMA_NOTE = `Respond with ONLY a JSON object that matches this JSON Schema — no markdown fences, no prose before or after it:\n${JSON.stringify(DIRECTIVE_OUTPUT_SCHEMA)}`;

/** Tolerant twin of `parseDirectiveSet` for unenforced output: if the strict
 *  parse yields nothing, retry on the outermost {...} span (fences, prose). */
export function decodeDirectives(text: string): DirectiveSet {
  const direct = parseDirectiveSet(text);
  if (direct.directives.length > 0) return direct;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return parseDirectiveSet(text.slice(start, end + 1));
  return direct;
}

/** Per-civ CLI conversation state. The daemon persists this in store meta so
 *  sessions survive a restart. Keys are civ ids as strings (JSON-friendly). */
export type CivSessions = Record<string, { sessionId: string; turns: number }>;

interface CliResult {
  text: string;
  costUsd: number;
  sessionId: string | null;
  usage: BrainUsage;
}

async function callClaudeCli(
  model: string,
  system: string,
  prompt: string,
  resumeSessionId: string | null,
): Promise<CliResult> {
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
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  // cwd outside the repo so no project-level Claude settings or hooks apply,
  // and constant so `--resume` always looks the session up in the same place.
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("claude", args, {
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      cwd: tmpdir(),
    }));
  } catch (err) {
    // execFile's own message echoes the command (the whole prompt) and drops
    // stdout — where the CLI put the actual reason. Rebuild the error from
    // what the CLI said, or the usage-limit classifier matches nothing.
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
    session_id?: string;
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
    sessionId: parsed.session_id ?? null,
    usage: {
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
      cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
      stopReason: parsed.subtype === "error_max_turns" ? "max_tokens" : "end_turn",
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The subscription-auth brain. The briefing's stable block (world rules) plus
 * the schema note form the constant system prompt; identity + context ride in
 * the user message as one turn of the civ's resumed conversation.
 */
export function createCliSessionBrain(opts: {
  model?: string;
  onCall: (call: MeteredCall) => void;
  /** Mutated in place; persist it to survive restarts. */
  sessions: CivSessions;
  maxSessionTurns?: number;
}): Brain {
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTurns = opts.maxSessionTurns ?? MAX_SESSION_TURNS;

  return {
    kind: "llm-cli-sessions",
    async decide(ctx: DecisionContext): Promise<DirectiveSet> {
      const { briefing } = ctx;
      const system = `${briefing.system[0]?.text ?? ""}\n\n${CLI_SCHEMA_NOTE}`;
      const volatile = briefing.system
        .slice(1)
        .map((b) => b.text)
        .concat(briefing.context)
        .join("\n\n");

      const key = String(ctx.civ.id);
      let resume: string | null = opts.sessions[key]?.sessionId ?? null;

      let freshAttempts = 0;
      while (true) {
        try {
          const out = await callClaudeCli(model, system, volatile, resume);
          const turns = resume ? (opts.sessions[key]?.turns ?? 0) + 1 : 1;
          if (out.sessionId && turns < maxTurns) {
            // `--resume` forks to a fresh session id each call; track the new one.
            opts.sessions[key] = { sessionId: out.sessionId, turns };
          } else {
            delete opts.sessions[key];
          }
          opts.onCall({ civ: ctx.civ.id, model, costUsd: out.costUsd, usage: out.usage });
          return decodeDirectives(out.text);
        } catch (err) {
          if (isUsageLimitError(err)) throw err; // cooldown is the caller's job
          // A dead/aged-out session shows up as an immediate CLI error; retry
          // the same decision with a fresh conversation (doesn't count as a
          // transient-retry attempt).
          if (resume) {
            delete opts.sessions[key];
            resume = null;
            continue;
          }
          if (freshAttempts < 1) {
            freshAttempts++;
            await sleep(CLI_RETRY_BACKOFF_MS);
            continue;
          }
          throw err;
        }
      }
    },
  };
}
