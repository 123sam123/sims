/**
 * The attention budget: scoring, allocation, degradation and the ledger.
 *
 * The acceptance criteria these pin: daily model spend stays under the
 * configured cap across a 48-hour (simulated-clock) soak; when the budget is
 * exhausted, decisions below the bar resolve algorithmically and nothing
 * throws or stalls; the bar rises as bids compete; model failures — including
 * usage limits — degrade to the heuristic instead of stopping the world.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashSeed, Rng } from "@sim/engine";
import type { Brain, DecisionContext, DirectiveSet } from "@sim/agents";
import {
  AttentionAllocator,
  consequenceScore,
  createAttentiveBrain,
  type DecisionOutcome,
  utcDay,
} from "../src/attention.ts";
import { Store } from "../src/store.ts";

/* ------------------------------------------------------------------ *
 * Consequence scoring
 * ------------------------------------------------------------------ */

const baseInputs = {
  era: 2,
  popShare: 0.2,
  recentWeight: 0.5,
  yearsSinceModel: 20,
  interval: 20,
};

test("consequenceScore is bounded to [0,1]", () => {
  assert.equal(
    consequenceScore({ era: 0, popShare: 0, recentWeight: 0, yearsSinceModel: 0, interval: 20 }),
    0,
  );
  const max = consequenceScore({
    era: 99,
    popShare: 5,
    recentWeight: 99,
    yearsSinceModel: 9999,
    interval: 8,
  });
  assert.ok(max <= 1 && max > 0.99);
});

test("consequenceScore is monotone in every input", () => {
  const s0 = consequenceScore(baseInputs);
  for (const key of ["era", "popShare", "recentWeight", "yearsSinceModel"] as const) {
    const bumped = consequenceScore({ ...baseInputs, [key]: baseInputs[key] * 1.5 });
    assert.ok(bumped > s0, `${key} should raise the score (${bumped} vs ${s0})`);
  }
  // A tighter cadence (smaller interval) makes the same absence more stale.
  const tighter = consequenceScore({ ...baseInputs, interval: 10 });
  assert.ok(tighter > s0);
});

/* ------------------------------------------------------------------ *
 * Allocator — the 48h simulated soak
 * ------------------------------------------------------------------ */

const CALL_COST = 0.055; // the divergence experiment's measured per-call cost

interface SoakHarness {
  allocator: AttentionAllocator;
  spentByDay: Map<string, number>;
  clock: { now: number };
  cap: { usd: number };
}

function makeHarness(startMs: number, capUsd: number): SoakHarness {
  const spentByDay = new Map<string, number>();
  const clock = { now: startMs };
  const cap = { usd: capUsd };
  const allocator = new AttentionAllocator({
    dailyUsd: () => cap.usd,
    spentOnDay: (day) => spentByDay.get(day) ?? 0,
    now: () => clock.now,
  });
  return { allocator, spentByDay, clock, cap };
}

test("48h soak: spend never exceeds the daily cap, and refusals never throw", () => {
  // Midnight UTC start so "day" boundaries are clean.
  const start = Date.parse("2026-08-15T00:00:00Z");
  const h = makeHarness(start, 10);
  const rng = new Rng(hashSeed("attention-soak", 1));

  const stepMs = 30_000; // a bid every 30s — 2,880/day, far more than $10 affords
  let approvals = 0;
  let refusals = 0;
  for (let i = 0; i < (48 * 3_600_000) / stepMs; i++) {
    h.clock.now = start + i * stepMs;
    const score = rng.range(0, 1);
    const outcome = h.allocator.bid(score);
    if (outcome.approved) {
      approvals++;
      // Mirror the daemon's wiring: the metered call reports its real cost,
      // which lands in the ledger and settles the reservation.
      const day = utcDay(h.clock.now);
      h.spentByDay.set(day, (h.spentByDay.get(day) ?? 0) + CALL_COST);
      h.allocator.settle(CALL_COST);
    } else {
      refusals++;
    }
  }

  assert.ok(approvals > 50, `the budget should buy a real number of calls (got ${approvals})`);
  assert.ok(refusals > approvals, "most bids must resolve algorithmically");
  for (const [day, usd] of h.spentByDay) {
    assert.ok(usd <= 10 + 1e-9, `day ${day} spent $${usd.toFixed(2)} — over the $10 cap`);
  }
  // Two full days at ~$10 each: the budget was actually used, not just refused.
  const total = [...h.spentByDay.values()].reduce((a, b) => a + b, 0);
  assert.ok(total > 10, `48h should spend more than one day's cap (got $${total.toFixed(2)})`);
});

test("the bar rises when bids outnumber the budget, and high scores still pass", () => {
  const start = Date.parse("2026-08-15T00:00:00Z");
  const h = makeHarness(start, 10);
  const rng = new Rng(hashSeed("attention-bar", 2));

  // A few hours of dense bidding so the rate EWMA learns the arrival rate.
  let lastOutcome = h.allocator.bid(0.5);
  for (let i = 0; i < 600; i++) {
    h.clock.now = start + i * 30_000;
    lastOutcome = h.allocator.bid(rng.range(0, 1));
    if (lastOutcome.approved) h.allocator.settle(CALL_COST);
  }
  assert.ok(lastOutcome.bar > 0.3, `bar should have risen well above 0 (got ${lastOutcome.bar})`);

  // A civilisation-scale moment must clear the risen bar (budget permitting).
  h.clock.now = start + 601 * 30_000;
  const crisis = h.allocator.bid(0.99);
  assert.ok(
    crisis.approved || crisis.reason === "day-cap" || crisis.reason === "bucket",
    "a top score is only ever refused for money, not for the bar",
  );
});

test("the budget knob applies mid-run without a restart", () => {
  const start = Date.parse("2026-08-15T00:00:00Z");
  const h = makeHarness(start, 10);
  const first = h.allocator.bid(0.9);
  assert.equal(first.approved, true);
  h.allocator.settle(CALL_COST);

  h.cap.usd = 0; // the knob turns to zero…
  h.clock.now += 60_000;
  const second = h.allocator.bid(0.99);
  assert.equal(second.approved, false, "…and no further spend is approved");
});

test("allocator state round-trips, so a restart keeps a warm bucket and bar", () => {
  const start = Date.parse("2026-08-15T00:00:00Z");
  const h = makeHarness(start, 10);
  for (let i = 0; i < 50; i++) {
    h.clock.now = start + i * 30_000;
    const o = h.allocator.bid(i / 50);
    if (o.approved) h.allocator.settle(CALL_COST);
  }
  const saved = h.allocator.saveState();

  const h2 = makeHarness(start + 50 * 30_000, 10);
  h2.allocator.restoreState(saved);
  const a = h.allocator.stats();
  const b = h2.allocator.stats();
  assert.ok(Math.abs(a.bucketUsd - b.bucketUsd) < 0.01);
  assert.equal(a.bar, b.bar);
});

/* ------------------------------------------------------------------ *
 * The attentive brain — routing and degradation
 * ------------------------------------------------------------------ */

function stubCtx(civId = 0, year = 100): DecisionContext {
  return {
    world: { year } as DecisionContext["world"],
    civ: { id: civId } as DecisionContext["civ"],
    briefing: { system: [], context: "", civId },
  };
}

function stubBrain(kind: string, decide: (ctx: DecisionContext) => Promise<DirectiveSet>): Brain {
  return { kind, decide };
}

const heuristicSet: DirectiveSet = { directives: [{ type: "policy", research: 0.2 }] };
const modelSet: DirectiveSet = { directives: [{ type: "settle" }] };

interface BrainHarness {
  brain: Brain;
  outcomes: DecisionOutcome[];
  modelCalls: { count: number };
  clock: { now: number };
}

function makeBrainHarness(model: Brain | null, capUsd = 10): BrainHarness {
  const outcomes: DecisionOutcome[] = [];
  const modelCalls = { count: 0 };
  const clock = { now: Date.parse("2026-08-15T00:00:00Z") };
  const spent = new Map<string, number>();
  const allocator = new AttentionAllocator({
    dailyUsd: () => capUsd,
    spentOnDay: (d) => spent.get(d) ?? 0,
    now: () => clock.now,
  });
  const counting: Brain | null = model
    ? {
        kind: model.kind,
        decide(ctx) {
          modelCalls.count++;
          return model.decide(ctx);
        },
      }
    : null;
  const brain = createAttentiveBrain({
    model: counting,
    heuristic: stubBrain("stub-heuristic", () => Promise.resolve(heuristicSet)),
    allocator,
    score: () => 0.9,
    isUsageLimit: (err) => /usage limit|resets \d/i.test(String(err)),
    cooldownMs: 15 * 60_000,
    now: () => clock.now,
    onOutcome: (o) => outcomes.push(o),
  });
  return { brain, outcomes, modelCalls, clock };
}

test("attentive brain: no model configured → heuristic, reason no-model", async () => {
  const h = makeBrainHarness(null);
  const set = await h.brain.decide(stubCtx());
  assert.deepEqual(set, heuristicSet);
  assert.equal(h.outcomes[0].route, "heuristic");
  assert.equal(h.outcomes[0].reason, "no-model");
});

test("attentive brain: approved bid goes to the model", async () => {
  const h = makeBrainHarness(stubBrain("stub-model", () => Promise.resolve(modelSet)));
  const set = await h.brain.decide(stubCtx());
  assert.deepEqual(set, modelSet);
  assert.equal(h.outcomes[0].route, "model");
  assert.equal(h.modelCalls.count, 1);
});

test("attentive brain: a zero budget resolves everything heuristically, without stalling", async () => {
  const h = makeBrainHarness(stubBrain("stub-model", () => Promise.resolve(modelSet)), 0);
  for (let i = 0; i < 5; i++) {
    const set = await h.brain.decide(stubCtx(i));
    assert.deepEqual(set, heuristicSet);
  }
  assert.equal(h.modelCalls.count, 0);
  assert.ok(h.outcomes.every((o) => o.route === "heuristic"));
});

test("attentive brain: a model error degrades this decision to the heuristic", async () => {
  const h = makeBrainHarness(stubBrain("stub-model", () => Promise.reject(new Error("boom"))));
  const set = await h.brain.decide(stubCtx());
  assert.deepEqual(set, heuristicSet);
  assert.equal(h.outcomes[0].reason, "error");

  // The next decision tries the model again — one bad call is not a bench.
  await h.brain.decide(stubCtx(1));
  assert.equal(h.modelCalls.count, 2);
});

test("attentive brain: a usage limit benches the model for the cooldown", async () => {
  const limitError = new Error("claude CLI: You've hit your usage limit · resets 3pm");
  let fail = true;
  const h = makeBrainHarness(
    stubBrain("stub-model", () => (fail ? Promise.reject(limitError) : Promise.resolve(modelSet))),
  );

  const first = await h.brain.decide(stubCtx());
  assert.deepEqual(first, heuristicSet);
  assert.equal(h.outcomes[0].reason, "usage-limit");

  // Within the cooldown the model is not even attempted.
  fail = false;
  h.clock.now += 5 * 60_000;
  await h.brain.decide(stubCtx(1));
  assert.equal(h.modelCalls.count, 1);
  assert.equal(h.outcomes[1].reason, "cooldown");

  // After the cooldown the model is back.
  h.clock.now += 11 * 60_000;
  const third = await h.brain.decide(stubCtx(2));
  assert.deepEqual(third, modelSet);
  assert.equal(h.modelCalls.count, 2);
});

/* ------------------------------------------------------------------ *
 * The spend ledger
 * ------------------------------------------------------------------ */

test("spend ledger records, sums by day, and aggregates by category", () => {
  const dir = mkdtempSync(join(tmpdir(), "sim-attn-"));
  const store = new Store(join(dir, "w.db"));
  try {
    const ts = Date.parse("2026-08-15T10:00:00Z");
    store.recordSpend({
      ts,
      day: "2026-08-15",
      category: "decision",
      civ: 2,
      model: "claude-opus-5",
      costUsd: 0.05,
      inputTokens: 100,
      outputTokens: 300,
      cacheReadTokens: 2_000,
      cacheCreationTokens: 500,
    });
    store.recordSpend({
      ts: ts + 1000,
      day: "2026-08-15",
      category: "decision",
      civ: 3,
      model: "claude-opus-5",
      costUsd: 0.07,
      inputTokens: 50,
      outputTokens: 200,
      cacheReadTokens: 3_000,
      cacheCreationTokens: 100,
    });
    store.recordSpend({
      ts: ts + 2000,
      day: "2026-08-16",
      category: "narration",
      civ: null,
      model: "claude-opus-5",
      costUsd: 0.01,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    assert.ok(Math.abs(store.spentOnDay("2026-08-15") - 0.12) < 1e-9);
    assert.equal(store.spentOnDay("2026-08-17"), 0);

    const agg = store.spendByDay();
    assert.equal(agg.length, 2);
    assert.deepEqual(
      agg.map((r) => [r.day, r.category, Number(r.calls)]),
      [
        ["2026-08-15", "decision", 2],
        ["2026-08-16", "narration", 1],
      ],
    );
    assert.equal(agg[0].cacheReadTokens, 5_000);
    assert.equal(agg[0].cacheCreationTokens, 600);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
