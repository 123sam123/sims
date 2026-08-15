/**
 * Attention — model intelligence as a budgeted, scarce resource.
 *
 * The world is designed never to stop, so model cost must not track world
 * complexity. The deal: every due decision *bids* for model attention with a
 * consequence score; a fixed daily dollar budget approves only the highest
 * bids, and everything below the bar resolves through the deterministic
 * heuristic. The cap is hard by construction — approval requires the money to
 * actually be there — and the bar is adaptive: the richer and faster the world
 * gets, the more bids compete for the same dollars and the higher the bar
 * rises. A decision that would have been model-driven in a quiet stone age is
 * a formula in a crowded industrial one.
 *
 * Three pieces, all wall-clock-aware and none on the tick path:
 *   - {@link consequenceScore} — how much a decision matters (pure).
 *   - {@link AttentionAllocator} — the budget: a continuous USD token bucket
 *     under a per-calendar-day hard cap, plus the adaptive bar.
 *   - {@link createAttentiveBrain} — a {@link Brain} that routes each decision
 *     to the model or the heuristic through the allocator, and degrades to the
 *     heuristic on any model failure. The world never stalls on a model.
 */

import type { Brain, DecisionContext, DirectiveSet } from "@sim/agents";

/* ------------------------------------------------------------------ *
 * Consequence scoring
 * ------------------------------------------------------------------ */

export interface ConsequenceInputs {
  /** The civ's era (its most advanced capability), 0..~6. */
  era: number;
  /** This civ's share of world population, 0..1. */
  popShare: number;
  /** EWMA of event weight involving this civ, in weight per sim-year. */
  recentWeight: number;
  /** Sim-years since this civ last got a model-driven decision. */
  yearsSinceModel: number;
  /** This civ's decision cadence in sim-years (see `decisionInterval`). */
  interval: number;
}

/** Saturation point for the recent-event term: ~1.5 weight/yr is a civ in the
 *  thick of history (the LLM arm peaked around 1.8 across the whole world). */
const RECENT_WEIGHT_FULL = 1.5;
/** A civ starved of model attention for this many of its own decision
 *  intervals bids at full staleness. */
const STALENESS_FULL_INTERVALS = 4;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * How much this decision matters, 0..1. Monotone in every input: more advanced,
 * more populous, more eventful and more model-starved civs all bid higher.
 * The staleness term is the fairness valve — a quiet civ's score rises until
 * it clears any bar the busy civs set, so nobody is starved forever.
 */
export function consequenceScore(i: ConsequenceInputs): number {
  const era = clamp01(i.era / 5);
  const pop = clamp01(i.popShare);
  const recent = clamp01(i.recentWeight / RECENT_WEIGHT_FULL);
  const staleness = clamp01(
    i.yearsSinceModel / (STALENESS_FULL_INTERVALS * Math.max(1, i.interval)),
  );
  return 0.25 * era + 0.15 * pop + 0.35 * recent + 0.25 * staleness;
}

/* ------------------------------------------------------------------ *
 * The allocator — a USD token bucket with an adaptive bar
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
/** Time constant for the bid arrival-rate EWMA (2 wall-clock hours). */
const RATE_TAU_MS = 2 * 3_600_000;
/** How many recent bid scores the bar quantile is computed over. */
const SCORE_WINDOW = 240;
/** Below this many observed scores the bar stays at zero (cold start). */
const SCORE_WARMUP = 8;
/** Seed for the average-cost EWMA — the divergence experiment measured
 *  ~$0.055 per decision on the CLI transport. */
const AVG_COST_SEED_USD = 0.06;

/** UTC calendar day of a wall-clock ms timestamp, `YYYY-MM-DD`. */
export function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export interface AllocatorOptions {
  /** The daily cap in dollars, re-read on every bid so the knob can be turned
   *  while the daemon runs (it lives in store meta, not in code). */
  dailyUsd: () => number;
  /** Dollars already recorded against a UTC day — the ledger, so a restart
   *  never forgets what today already spent. */
  spentOnDay: (day: string) => number;
  now?: () => number;
}

/** Everything the allocator needs to survive a restart warm. */
export interface AllocatorState {
  bucketUsd: number;
  lastRefillMs: number;
  avgCostUsd: number;
  ratePerDay: number;
  lastBidMs: number;
  recentScores: number[];
}

export interface BidOutcome {
  approved: boolean;
  reason: "ok" | "bar" | "bucket" | "day-cap";
  /** The bar this bid was measured against. */
  bar: number;
  score: number;
}

/**
 * The budget. Two independent guards, both of which must pass:
 *
 *   - **Calendar-day hard cap** — the ledger's dollars for today plus this
 *     call's expected cost must fit under `dailyUsd()`. This is the invariant
 *     the acceptance criteria name, and it is checked against *persisted*
 *     spend, so restarts cannot double-spend a day.
 *   - **Token bucket** — capacity `dailyUsd`, refilled continuously at
 *     `dailyUsd` per 24h. This smooths spend across the day so a fast-ticking
 *     morning cannot burn the whole cap in twenty minutes.
 *
 * On top sits the bar: the score quantile that admits roughly as many bids as
 * the budget can afford, estimated from the observed bid arrival rate and the
 * observed average call cost. More bids per dollar → higher bar.
 */
export class AttentionAllocator {
  private opts: Required<Pick<AllocatorOptions, "now">> & AllocatorOptions;
  private bucketUsd: number;
  private lastRefillMs: number;
  private avgCostUsd = AVG_COST_SEED_USD;
  private ratePerDay = 0;
  private lastBidMs = 0;
  private recentScores: number[] = [];

  constructor(options: AllocatorOptions) {
    this.opts = { now: () => Date.now(), ...options };
    this.bucketUsd = Math.max(0, options.dailyUsd());
    this.lastRefillMs = this.opts.now();
  }

  /** Current bar: the score needed for approval right now. */
  bar(): number {
    if (this.recentScores.length < SCORE_WARMUP) return 0;
    const cap = Math.max(0, this.opts.dailyUsd());
    if (cap <= 0) return 1; // no budget: nothing clears the bar
    const affordablePerDay = cap / Math.max(1e-6, this.avgCostUsd);
    const share = Math.min(1, affordablePerDay / Math.max(1e-6, this.ratePerDay));
    if (share >= 1) return 0;
    const sorted = [...this.recentScores].sort((a, b) => a - b);
    const idx = Math.min(
      sorted.length - 1,
      Math.max(0, Math.floor((1 - share) * (sorted.length - 1))),
    );
    return sorted[idx];
  }

  /** One decision asks for the model. Approval reserves the expected cost;
   *  {@link settle} trues it up when the real cost is known. Never throws —
   *  a refused bid is the normal, healthy case. */
  bid(score: number): BidOutcome {
    const now = this.opts.now();
    this.refill(now);
    this.observe(score, now);

    const bar = this.bar();
    if (score < bar) return { approved: false, reason: "bar", bar, score };

    const cap = Math.max(0, this.opts.dailyUsd());
    const day = utcDay(now);
    if (this.opts.spentOnDay(day) + this.avgCostUsd > cap) {
      return { approved: false, reason: "day-cap", bar, score };
    }
    if (this.bucketUsd < this.avgCostUsd) {
      return { approved: false, reason: "bucket", bar, score };
    }

    this.bucketUsd -= this.avgCostUsd;
    return { approved: true, reason: "ok", bar, score };
  }

  /** True up a previously approved bid with the call's actual dollars. Pass 0
   *  when the call failed outright, refunding the reservation. Also feeds the
   *  average-cost EWMA the bar arithmetic runs on. */
  settle(actualUsd: number): void {
    const cap = Math.max(0, this.opts.dailyUsd());
    this.bucketUsd = Math.min(cap, Math.max(0, this.bucketUsd + this.avgCostUsd - actualUsd));
    if (actualUsd > 0) {
      this.avgCostUsd = this.avgCostUsd * 0.9 + actualUsd * 0.1;
    }
  }

  /** Continuous refill at `dailyUsd` per 24h, capped at one day's budget. */
  private refill(now: number): void {
    const cap = Math.max(0, this.opts.dailyUsd());
    const elapsed = Math.max(0, now - this.lastRefillMs);
    this.bucketUsd = Math.min(cap, this.bucketUsd + (cap * elapsed) / DAY_MS);
    this.lastRefillMs = now;
  }

  /** Feed the arrival-rate EWMA and the rolling score window. */
  private observe(score: number, now: number): void {
    if (this.lastBidMs > 0) {
      const dtMs = Math.max(1, now - this.lastBidMs);
      const instantaneous = DAY_MS / dtMs; // bids/day if this gap were typical
      const alpha = 1 - Math.exp(-dtMs / RATE_TAU_MS);
      this.ratePerDay += (instantaneous - this.ratePerDay) * alpha;
    }
    this.lastBidMs = now;
    this.recentScores.push(score);
    if (this.recentScores.length > SCORE_WINDOW) this.recentScores.shift();
  }

  /** Observability for logs, the status meta and the report. */
  stats(): { bucketUsd: number; avgCostUsd: number; ratePerDay: number; bar: number } {
    this.refill(this.opts.now());
    return {
      bucketUsd: this.bucketUsd,
      avgCostUsd: this.avgCostUsd,
      ratePerDay: this.ratePerDay,
      bar: this.bar(),
    };
  }

  /** Persistable state, so a restarted daemon keeps a warm bar and bucket. */
  saveState(): AllocatorState {
    return {
      bucketUsd: this.bucketUsd,
      lastRefillMs: this.lastRefillMs,
      avgCostUsd: this.avgCostUsd,
      ratePerDay: this.ratePerDay,
      lastBidMs: this.lastBidMs,
      recentScores: [...this.recentScores],
    };
  }

  restoreState(state: AllocatorState): void {
    this.bucketUsd = Math.max(0, state.bucketUsd);
    this.lastRefillMs = state.lastRefillMs;
    this.avgCostUsd = state.avgCostUsd > 0 ? state.avgCostUsd : AVG_COST_SEED_USD;
    this.ratePerDay = Math.max(0, state.ratePerDay);
    this.lastBidMs = state.lastBidMs;
    this.recentScores = Array.isArray(state.recentScores) ? state.recentScores.slice(-SCORE_WINDOW) : [];
  }
}

/* ------------------------------------------------------------------ *
 * The attentive brain — routing one decision through the budget
 * ------------------------------------------------------------------ */

export type DecisionRoute = "model" | "heuristic";

export interface DecisionOutcome {
  civ: number;
  year: number;
  route: DecisionRoute;
  /** Why the route was taken: "ok" is a model decision; everything else names
   *  the reason the heuristic decided instead. */
  reason: "ok" | "bar" | "bucket" | "day-cap" | "cooldown" | "error" | "usage-limit" | "no-model";
  score: number;
  bar: number;
}

export interface AttentiveBrainOptions {
  /** The model transport, or null to run all-heuristic (no key, no CLI). */
  model: Brain | null;
  heuristic: Brain;
  allocator: AttentionAllocator;
  /** Consequence score for a decision — see {@link consequenceScore}. */
  score: (ctx: DecisionContext) => number;
  /** Classify a model error as a usage/rate limit — those open the cooldown
   *  instead of being retried per-decision. */
  isUsageLimit?: (err: unknown) => boolean;
  /** How long after a usage-limit hit the model is left alone (default 15 min).
   *  During the cooldown every decision resolves heuristically; the world
   *  never waits on a limit window. */
  cooldownMs?: number;
  now?: () => number;
  onOutcome?: (outcome: DecisionOutcome) => void;
}

/** Milliseconds the model is benched after a usage-limit classified failure. */
export const DEFAULT_COOLDOWN_MS = 15 * 60_000;

/**
 * A {@link Brain} that spends the budget. Every decision: score → bid → model
 * if approved, heuristic otherwise. A model failure settles the reservation at
 * $0 and falls back to the heuristic for *this* decision; a usage-limit
 * failure additionally benches the model for `cooldownMs` so a rate-limited
 * daemon does not pay a failed spawn per decision. This brain never throws and
 * never waits: pacing belongs to the daemon loop, liveness to this contract.
 */
export function createAttentiveBrain(opts: AttentiveBrainOptions): Brain {
  const now = opts.now ?? (() => Date.now());
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const isUsageLimit = opts.isUsageLimit ?? (() => false);
  let cooldownUntil = 0;

  const emit = (
    ctx: DecisionContext,
    route: DecisionRoute,
    reason: DecisionOutcome["reason"],
    score: number,
    bar: number,
  ): void => {
    opts.onOutcome?.({ civ: ctx.civ.id, year: ctx.world.year, route, reason, score, bar });
  };

  return {
    kind: "attentive",
    async decide(ctx: DecisionContext): Promise<DirectiveSet> {
      const score = opts.score(ctx);

      if (!opts.model) {
        emit(ctx, "heuristic", "no-model", score, 0);
        return opts.heuristic.decide(ctx);
      }
      if (now() < cooldownUntil) {
        emit(ctx, "heuristic", "cooldown", score, 0);
        return opts.heuristic.decide(ctx);
      }

      const bid = opts.allocator.bid(score);
      if (!bid.approved) {
        emit(ctx, "heuristic", bid.reason as DecisionOutcome["reason"], score, bid.bar);
        return opts.heuristic.decide(ctx);
      }

      try {
        const set = await opts.model.decide(ctx);
        emit(ctx, "model", "ok", score, bid.bar);
        return set;
      } catch (err) {
        // The metered transport reports cost only on success, so a throw means
        // nothing was recorded: refund the reservation in full.
        opts.allocator.settle(0);
        if (isUsageLimit(err)) {
          cooldownUntil = now() + cooldownMs;
          emit(ctx, "heuristic", "usage-limit", score, bid.bar);
        } else {
          emit(ctx, "heuristic", "error", score, bid.bar);
        }
        return opts.heuristic.decide(ctx);
      }
    },
  };
}
