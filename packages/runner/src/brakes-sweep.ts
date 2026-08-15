/**
 * The anti-snowball sweep: does any single civilisation end up owning the map?
 *
 * Runs N independent worlds (different seeds, same engine) for a fixed span
 * and measures, per run, each civilisation's share of *settled land* — all
 * land cells any civ owns — plus the brake activity (plague / unrest /
 * secession / depletion / degradation events) that pushed back on the leaders.
 * This is the ticket's acceptance instrument: across ten 3,000-year runs, no
 * single civ should end holding more than ~60% of settled land in the
 * majority of runs, and the mechanism that stopped it must be identifiable in
 * the event log.
 *
 * Headless engine runs: no store, no agents — research advances on the
 * engine's own unsteered fallback, so the sweep is deterministic per seed and
 * measures the physics, not a brain. Events are counted and drained each year
 * to bound memory.
 *
 * Usage:
 *   pnpm tsx packages/runner/src/brakes-sweep.ts
 *     [--runs 10] [--years 3000] [--seed-base 1] [--out docs/brakes]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EventKind,
  civPopulation,
  generateWorld,
  landCellCount,
  tickWorld,
  type World,
  type WorldEvent,
} from "@sim/engine";

const BRAKE_KINDS: EventKind[] = [
  "plague",
  "unrest",
  "secession",
  "depletion",
  "degradation",
];
/** Brake-adjacent context worth counting alongside. */
const CONTEXT_KINDS: EventKind[] = ["famine", "collapse"];

interface RunResult {
  seed: number;
  years: number;
  /** Final owned-land cells per civ id. */
  ownedCells: Record<number, number>;
  /** Final share of settled land per civ id. */
  share: Record<number, number>;
  largestShare: number;
  largestCiv: number;
  /** Largest-civ share sampled every `SAMPLE_EVERY` years. */
  shareTimeline: { year: number; share: number }[];
  /** Event counts per kind (brakes + context), whole run. */
  events: Record<string, number>;
  /** Brake events against the run's final largest civ, per kind. */
  brakesOnLargest: Record<string, number>;
  /** The heaviest brake events of the run, for the report's receipts. */
  samples: { year: number; kind: string; civ: number | null; weight: number; text: string }[];
  populations: Record<number, number>;
  extinct: number[];
  seconds: number;
}

const SAMPLE_EVERY = 250;
const SAMPLE_KEEP = 8;

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[tok.slice(2)] = next;
      i++;
    } else {
      flags[tok.slice(2)] = "true";
    }
  }
  return flags;
}

function ownedByCiv(world: World): Record<number, number> {
  const owned: Record<number, number> = {};
  for (const civ of world.civs) owned[civ.id] = 0;
  const grid = world.grid;
  for (let i = 0; i < grid.owner.length; i++) {
    const o = grid.owner[i];
    if (o >= 0 && grid.land[i] === 1) owned[o] = (owned[o] ?? 0) + 1;
  }
  return owned;
}

function largestShareOf(world: World): number {
  const owned = ownedByCiv(world);
  const total = Object.values(owned).reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  return Math.max(...Object.values(owned)) / total;
}

function runOne(seed: number, years: number): RunResult {
  const t0 = performance.now();
  const world = generateWorld(seed);

  const events: Record<string, number> = {};
  const brakesOnCiv = new Map<number, Record<string, number>>();
  const samples: RunResult["samples"] = [];
  const shareTimeline: RunResult["shareTimeline"] = [];
  const counted = new Set<EventKind>([...BRAKE_KINDS, ...CONTEXT_KINDS]);

  const drain = (batch: WorldEvent[]) => {
    for (const e of batch) {
      if (!counted.has(e.kind)) continue;
      events[e.kind] = (events[e.kind] ?? 0) + 1;
      if (e.civ !== null && BRAKE_KINDS.includes(e.kind)) {
        const rec = brakesOnCiv.get(e.civ) ?? {};
        rec[e.kind] = (rec[e.kind] ?? 0) + 1;
        brakesOnCiv.set(e.civ, rec);
        samples.push({ year: e.year, kind: e.kind, civ: e.civ, weight: e.weight, text: e.text });
        samples.sort((a, b) => b.weight - a.weight);
        if (samples.length > SAMPLE_KEEP * 4) samples.length = SAMPLE_KEEP * 4;
      }
    }
  };

  while (world.year < years) {
    tickWorld(world);
    drain(world.events);
    world.events.length = 0;
    if (world.year % SAMPLE_EVERY === 0) {
      shareTimeline.push({
        year: world.year,
        share: Math.round(largestShareOf(world) * 1000) / 1000,
      });
    }
  }

  const ownedCells = ownedByCiv(world);
  const total = Object.values(ownedCells).reduce((a, b) => a + b, 0);
  const share: Record<number, number> = {};
  let largestCiv = -1;
  let largestShare = 0;
  for (const [id, n] of Object.entries(ownedCells)) {
    const s = total > 0 ? n / total : 0;
    share[Number(id)] = Math.round(s * 1000) / 1000;
    if (s > largestShare) {
      largestShare = s;
      largestCiv = Number(id);
    }
  }

  const populations: Record<number, number> = {};
  for (const civ of world.civs) populations[civ.id] = Math.round(civPopulation(world, civ.id));

  return {
    seed,
    years,
    ownedCells,
    share,
    largestShare: Math.round(largestShare * 1000) / 1000,
    largestCiv,
    shareTimeline,
    events,
    brakesOnLargest: brakesOnCiv.get(largestCiv) ?? {},
    samples: samples.slice(0, SAMPLE_KEEP),
    populations,
    extinct: world.civs.filter((c) => !c.alive).map((c) => c.id),
    seconds: Math.round((performance.now() - t0) / 100) / 10,
  };
}

function renderReport(results: RunResult[], years: number, landTotal: number): string {
  const shares = results.map((r) => r.largestShare).sort((a, b) => a - b);
  const over60 = results.filter((r) => r.largestShare > 0.6);
  const over80 = results.filter((r) => r.largestShare > 0.8);
  const median = shares[shares.length >> 1];

  const lines: string[] = [];
  lines.push("# Anti-snowball sweep — largest-civ share of settled land");
  lines.push("");
  lines.push(
    `${results.length} headless engine runs (no agents; research on the engine's ` +
      `unsteered fallback), each ${years} sim-years from its own seed. ` +
      `"Settled land" is every land cell owned by any civilisation ` +
      `(${landTotal.toLocaleString("en-US")} land cells exist worldwide). ` +
      `Deterministic: re-running a seed reproduces its row exactly.`,
  );
  lines.push("");
  lines.push("## Verdict");
  lines.push("");
  lines.push(`- Largest-civ share, distribution: min ${shares[0]}, median ${median}, max ${shares[shares.length - 1]}`);
  lines.push(`- Runs where one civ held > 60% of settled land: **${over60.length} of ${results.length}**`);
  lines.push(`- Runs where one civ held > 80%: **${over80.length} of ${results.length}**${over80.length ? ` (seeds ${over80.map((r) => r.seed).join(", ")})` : ""}`);
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| Seed | Largest share | Shares (all civs) | Plagues | Unrest | Secessions | Depletions | Degradations | Famines | Extinct | Runtime |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const shareList = Object.entries(r.share)
      .map(([id, s]) => `${id}:${(s * 100).toFixed(0)}%`)
      .join(" ");
    lines.push(
      `| ${r.seed} | **${(r.largestShare * 100).toFixed(1)}%** (civ ${r.largestCiv}) | ${shareList} ` +
        `| ${r.events.plague ?? 0} | ${r.events.unrest ?? 0} | ${r.events.secession ?? 0} ` +
        `| ${r.events.depletion ?? 0} | ${r.events.degradation ?? 0} | ${r.events.famine ?? 0} ` +
        `| ${r.extinct.length ? r.extinct.join(",") : "—"} | ${r.seconds}s |`,
    );
  }
  lines.push("");
  lines.push("## The brakes on each run's leader");
  lines.push("");
  lines.push(
    "Brake events recorded *against the run's final largest civ* — the log's answer to \"what pushed back on the winner\":",
  );
  lines.push("");
  for (const r of results) {
    const b = r.brakesOnLargest;
    const parts = BRAKE_KINDS.map((k) => `${k} ${b[k] ?? 0}`).join(" · ");
    lines.push(`- seed ${r.seed}, civ ${r.largestCiv} at ${(r.largestShare * 100).toFixed(1)}%: ${parts}`);
  }
  lines.push("");
  lines.push("## Largest-share trajectory (every " + SAMPLE_EVERY + " years)");
  lines.push("");
  for (const r of results) {
    lines.push(
      `- seed ${r.seed}: ` +
        r.shareTimeline.map((p) => `${p.year}:${(p.share * 100).toFixed(0)}%`).join(" → "),
    );
  }
  lines.push("");
  lines.push("## Receipts — heaviest brake events");
  lines.push("");
  for (const r of results) {
    lines.push(`### Seed ${r.seed}`);
    for (const s of r.samples) {
      lines.push(`- Year ${s.year} · ${s.kind} (weight ${s.weight.toFixed(2)}, civ ${s.civ}): ${s.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function main(): void {
  const flags = parseFlags(process.argv.slice(2));
  const runs = Number(flags.runs ?? 10);
  const years = Number(flags.years ?? 3000);
  const seedBase = Number(flags["seed-base"] ?? 1);
  const out = flags.out ?? "docs/brakes";

  const landTotal = landCellCount(generateWorld(seedBase).grid);
  const results: RunResult[] = [];
  for (let i = 0; i < runs; i++) {
    const seed = seedBase + i;
    process.stdout.write(`run ${i + 1}/${runs} (seed ${seed})… `);
    const r = runOne(seed, years);
    results.push(r);
    process.stdout.write(
      `largest ${(r.largestShare * 100).toFixed(1)}% (civ ${r.largestCiv}) · ` +
        `plagues ${r.events.plague ?? 0} · secessions ${r.events.secession ?? 0} · ${r.seconds}s\n`,
    );
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "report.json"), JSON.stringify({ years, results }, null, 2));
  writeFileSync(join(out, "report.md"), renderReport(results, years, landTotal));
  process.stdout.write(`\nReport written to ${join(out, "report.md")}\n`);
}

main();
