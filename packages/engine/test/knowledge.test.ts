import assert from "node:assert/strict";
import { test } from "node:test";
import { DEPOSITS, type ResourceKind } from "../src/geo-data.ts";
import {
  CAPABILITIES,
  CAPABILITY_BY_ID,
  FRONTIER_ANCHORS,
  FRONTIER_BASE_ERA,
  STARTING_CAPABILITIES,
  blockedBecause,
  frontierCapability,
  frontierId,
  frontierTier,
  researchable,
} from "../src/knowledge.ts";
import { generateWorld } from "../src/worldgen.ts";

const AUTHORED_IDS = new Set(CAPABILITIES.map((c) => c.id));
const yes = () => true;

/* ================================================================== *
 * The authored graph is sound
 * ================================================================== */

test("every needs id resolves to an authored capability and the graph is acyclic", () => {
  for (const c of CAPABILITIES) {
    for (const n of c.needs) {
      assert.ok(AUTHORED_IDS.has(n), `${c.id} needs unknown capability "${n}"`);
    }
  }
  for (const anchor of FRONTIER_ANCHORS) {
    assert.ok(AUTHORED_IDS.has(anchor), `frontier anchor "${anchor}" is not authored`);
  }

  // DFS three-colour cycle detection over `needs`.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id);
    if (s === "done") return;
    assert.notEqual(s, "visiting", `cycle through ${[...path, id].join(" -> ")}`);
    state.set(id, "visiting");
    const cap = CAPABILITY_BY_ID.get(id);
    assert.ok(cap);
    for (const n of cap.needs) visit(n, [...path, id]);
    state.set(id, "done");
  };
  for (const c of CAPABILITIES) visit(c.id, []);
});

test("the tree spans eras 0-12 with no thin era past the neolithic", () => {
  assert.ok(
    CAPABILITIES.length >= 130,
    `expected at least 130 capabilities, got ${CAPABILITIES.length}`,
  );
  const byEra = new Map<number, number>();
  for (const c of CAPABILITIES) byEra.set(c.era, (byEra.get(c.era) ?? 0) + 1);
  for (let era = 0; era <= 12; era++) {
    const n = byEra.get(era) ?? 0;
    assert.ok(n > 0, `era ${era} is empty`);
    if (era > 2) {
      assert.ok(n >= 4, `era ${era} has only ${n} capabilities — a single-file bottleneck`);
    }
  }
});

test("ids are unique and no capability needs itself", () => {
  assert.equal(AUTHORED_IDS.size, CAPABILITIES.length, "duplicate capability id");
  for (const c of CAPABILITIES) {
    assert.ok(!c.needs.includes(c.id), `${c.id} needs itself`);
  }
});

test("the whole authored tree is reachable when every physical gate is open", () => {
  const held = new Set(STARTING_CAPABILITIES);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of researchable(held, yes, yes, Number.POSITIVE_INFINITY)) {
      if (!AUTHORED_IDS.has(c.id)) continue; // the frontier is endless by design
      held.add(c.id);
      grew = true;
    }
  }
  const missing = CAPABILITIES.filter((c) => !held.has(c.id)).map((c) => c.id);
  assert.deepEqual(missing, [], `unreachable capabilities: ${missing.join(", ")}`);
});

/* ================================================================== *
 * Materials keep the possibility gates honest
 * ================================================================== */

test("every declared material has a real deposit somewhere on Earth", () => {
  const placeable = new Set(DEPOSITS.map((d) => d.kind));
  for (const c of CAPABILITIES) {
    for (const m of c.materials ?? []) {
      assert.ok(
        placeable.has(m),
        `${c.id} demands "${m}" but no deposit of it exists — the gate could never open`,
      );
    }
  }
});

test("the new resource kinds land on the generated Earth", () => {
  const world = generateWorld(12345);
  for (const kind of ["bauxite", "silica", "rare_earth"] as const) {
    assert.ok(
      world.deposits.some((d) => d.kind === kind),
      `no ${kind} deposit survived worldgen placement`,
    );
  }
});

test("the marquee modern capabilities each demand materials a civ must control", () => {
  const expects: [string, ResourceKind][] = [
    ["electricity", "copper"],
    ["internal_combustion", "oil"],
    ["flight", "oil"],
    ["electronics", "silica"],
    ["computing", "silica"],
    ["nuclear_fission", "uranium"],
    ["aluminium", "bauxite"],
    ["semiconductors", "silica"],
  ];
  for (const [id, material] of expects) {
    const cap = CAPABILITY_BY_ID.get(id);
    assert.ok(cap, `missing capability ${id}`);
    assert.ok(cap.materials?.includes(material), `${id} must demand ${material}`);
  }
});

test("no capability is researchable while its materials are out of reach", () => {
  // Hold everything authored except the uranium-gated pair, then take uranium away.
  const held = new Set(
    CAPABILITIES.map((c) => c.id).filter(
      (id) => id !== "nuclear_fission" && id !== "nuclear_power",
    ),
  );
  const noUranium = (m: string) => m !== "uranium";
  const open = researchable(held, noUranium, yes, Number.POSITIVE_INFINITY);
  assert.ok(
    !open.some((c) => c.id === "nuclear_fission"),
    "fission offered with no uranium in reach",
  );
  const fission = CAPABILITY_BY_ID.get("nuclear_fission");
  assert.ok(fission);
  assert.equal(
    blockedBecause(fission, held, noUranium, yes, Number.POSITIVE_INFINITY),
    "no reachable uranium",
  );
  // With uranium back in reach the same civ can pursue it.
  const openNow = researchable(held, yes, yes, Number.POSITIVE_INFINITY);
  assert.ok(openNow.some((c) => c.id === "nuclear_fission"));
});

/* ================================================================== *
 * The open frontier — the tree never closes
 * ================================================================== */

test("a civ that has learned everything authored still has a frontier", () => {
  const held = new Set(CAPABILITIES.map((c) => c.id));
  const open = researchable(held, yes, yes, Number.POSITIVE_INFINITY);
  assert.ok(open.length > 0, "researchable() went empty — the frontier closed");
  assert.ok(open.some((c) => c.id === frontierId(1)));

  // Completing a tier opens the next; the ladder never cheapens and never ends.
  held.add(frontierId(1));
  const next = researchable(held, yes, yes, Number.POSITIVE_INFINITY);
  assert.ok(next.some((c) => c.id === frontierId(2)));
  const t1 = frontierCapability(1);
  const t2 = frontierCapability(2);
  assert.ok(t2.effort > t1.effort, "the frontier must get more expensive, not less");
  assert.equal(t1.era, FRONTIER_BASE_ERA);
  assert.equal(t2.era, FRONTIER_BASE_ERA + 1);
});

test("the frontier does not open before its anchors are held", () => {
  const held = new Set(
    CAPABILITIES.map((c) => c.id).filter((id) => id !== "fusion_power"),
  );
  const open = researchable(held, yes, yes, Number.POSITIVE_INFINITY);
  assert.ok(!open.some((c) => c.id === frontierId(1)));
});

test("frontier ids resolve through CAPABILITY_BY_ID, as a snapshot resume needs", () => {
  // A resumed world may hold tiers this process has never generated.
  const cap = CAPABILITY_BY_ID.get("frontier_7");
  assert.ok(cap, "frontier_7 did not resolve");
  assert.equal(cap.id, "frontier_7");
  assert.deepEqual(cap.needs, ["frontier_6"]);
  assert.ok(CAPABILITY_BY_ID.has("frontier_7"));

  assert.equal(frontierTier("frontier_12"), 12);
  assert.equal(frontierTier("frontier_0"), null);
  assert.equal(frontierTier("frontier_01"), null);
  assert.equal(frontierTier("frontier_x"), null);
  assert.equal(frontierTier("steam"), null);
  assert.equal(CAPABILITY_BY_ID.get("frontier_0"), undefined);
  assert.ok(!CAPABILITY_BY_ID.has("frontier_x"));
});
