import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type EmitSpec,
  describeEvent,
  emit,
  filterByWeight,
  renderChronicle,
  traceCauses,
  weightFor,
  weightRange,
} from "../src/events.ts";
import { runProduction } from "../src/production.ts";
import type { EventKind, World, WorldEvent } from "../src/types.ts";
import { Rng, hashSeed } from "../src/rng.ts";
import { generateWorld } from "../src/worldgen.ts";

const ALL_KINDS: EventKind[] = [
  "founding",
  "discovery",
  "settlement",
  "war",
  "battle",
  "peace",
  "contact",
  "famine",
  "plague",
  "disaster",
  "government",
  "growth",
  "collapse",
  "decision",
  "refusal",
  "person",
  "trade",
];

/** emit() only touches year/events/nextEventId, so a log is all a test needs. */
function makeLog(): World {
  return { year: 0, events: [], nextEventId: 0 } as unknown as World;
}

/* ------------------------------------------------------------------ *
 * The primitive: emit, template, weight, causal link
 * ------------------------------------------------------------------ */

test("emit appends an append-only, well-formed event and returns it", () => {
  const world = makeLog();
  world.year = 400;
  const e = emit(world, {
    kind: "founding",
    civ: 2,
    cell: 17,
    fields: { civ: "Aeland", place: "Ur" },
  });

  assert.equal(world.events.length, 1);
  assert.equal(world.events[0], e);
  assert.equal(e.id, 0);
  assert.equal(e.year, 400);
  assert.equal(e.kind, "founding");
  assert.equal(e.civ, 2);
  assert.equal(e.cell, 17);
  assert.equal(e.text, "Aeland founded Ur.");
  assert.deepEqual(e.causedBy, []);
  assert.ok(e.weight >= 0 && e.weight <= 1);

  // Ids increase, the log is the single source of order.
  const e2 = emit(world, { kind: "growth", civ: 2 });
  assert.equal(e2.id, 1);
  assert.equal(world.nextEventId, 2);
});

test("every EventKind renders a non-empty templated headline with no LLM", () => {
  const kinds = ALL_KINDS;
  const fields = {
    civ: "Aeland",
    other: "Borea",
    place: "the Ford",
    subject: "ironworking",
  };
  for (const kind of kinds) {
    const text = describeEvent(kind, fields);
    assert.ok(text.length > 0, `${kind} renders text`);
    assert.ok(text.endsWith("."), `${kind} headline is a sentence`);
  }
  // Missing fields must not throw — the template falls back to a neutral noun.
  for (const kind of kinds) {
    assert.ok(describeEvent(kind).length > 0, `${kind} survives empty fields`);
  }
});

test("weight is calibrated: a founding never outweighs a collapse", () => {
  // The bands themselves are ordered, so this holds for every instance.
  assert.ok(weightRange("founding").max < weightRange("collapse").min);
  assert.ok(weightRange("growth").max < weightRange("war").min);
  assert.ok(weightRange("settlement").max < weightRange("plague").min);

  // Even the most dramatic founding loses to the mildest collapse.
  const grandFounding = weightFor("founding", 1);
  const barestCollapse = weightFor("collapse", 0);
  assert.ok(grandFounding < barestCollapse, `${grandFounding} < ${barestCollapse}`);

  // Magnitude moves weight monotonically inside the band, and stays in [0,1].
  assert.ok(weightFor("famine", 0.2) < weightFor("famine", 0.9));
  assert.equal(weightFor("collapse", 5), weightRange("collapse").max); // clamped
  assert.equal(weightFor("collapse", -5), weightRange("collapse").min);
});

test("traceCauses walks causedBy back to the root", () => {
  const world = makeLog();
  const drought = emit(world, {
    kind: "disaster",
    text: "A drought held for three years.",
  });
  const harvest = emit(world, {
    kind: "disaster",
    text: "The harvest failed.",
    causedBy: [drought.id],
  });
  const famine = emit(world, { kind: "famine", causedBy: [harvest.id] });

  const causes = traceCauses(world.events, famine.id);
  const ids = causes.map((c) => c.id);
  assert.deepEqual(ids, [harvest.id, drought.id], "nearest cause first, then its cause");

  // A root event has no causes; an unknown id yields none.
  assert.deepEqual(traceCauses(world.events, drought.id), []);
  assert.deepEqual(traceCauses(world.events, 999), []);
});

/* ------------------------------------------------------------------ *
 * Integration: production emits the real famine <- harvest-failure chain
 * ------------------------------------------------------------------ */

test("a real production famine is caused by a traceable harvest failure", () => {
  const world = generateWorld(9001);
  // Pile far too many mouths onto the land so the harvest cannot feed them.
  for (const s of world.settlements) {
    for (let b = 0; b < s.cohorts.length; b++) s.cohorts[b] *= 100;
  }
  runProduction(world);

  const famine = world.events.find((e) => e.kind === "famine");
  assert.ok(famine, "overloading the land produces a famine event");
  assert.ok(famine.text.length > 0);
  assert.ok(famine.weight >= 0 && famine.weight <= 1);
  assert.ok(famine.causedBy.length > 0, "the famine records a cause");

  const causes = traceCauses(world.events, famine.id);
  const harvest = causes.find((c) => c.kind === "disaster" && /harvest/i.test(c.text));
  assert.ok(harvest, "following causedBy reaches the harvest failure");
  // The mechanism is emitted before, and outweighed by, its human consequence.
  assert.ok(harvest.id < famine.id, "cause precedes effect in the log");
  assert.ok(harvest.year === famine.year, "same tick");
  assert.ok(
    famine.weight > harvest.weight,
    "the famine leads; the failed harvest is the why",
  );
});

/* ------------------------------------------------------------------ *
 * A 2,000-year run: the acceptance chronicle
 * ------------------------------------------------------------------ */

const CIV_NAMES = ["Aeland", "Borea", "Cyrn", "Dhagar", "Eshun"];

interface FakeCiv {
  id: number;
  name: string;
  alive: boolean;
  pop: number;
  gov: string;
}

/**
 * A deterministic synthetic history. It is NOT the real engine — the tick
 * orchestrator that drives the real subsystems lands in a sibling ticket — but
 * it exercises the event log exactly as the engine will: the same `emit`, the
 * same weight calibration, the same famine<-harvest causal wiring, at the scale
 * the acceptance criteria demand.
 */
function runTwoThousandYears(seed: number): World {
  const world = makeLog();
  const rng = new Rng(hashSeed("chronicle", seed));
  const civs: FakeCiv[] = CIV_NAMES.map((name, id) => ({
    id,
    name,
    alive: true,
    pop: 200 + rng.int(0, 200),
    gov: "a band of kin",
  }));
  const met = new Set<string>();

  // The dawn: every people founds its first hearth.
  world.year = 0;
  for (const c of civs) {
    emit(world, {
      kind: "founding",
      civ: c.id,
      magnitude: 0.4,
      fields: { civ: c.name, place: `${c.name}'s first hearth` },
    });
  }

  for (let year = 1; year <= 2000; year++) {
    world.year = year;
    for (const c of civs) {
      if (!c.alive) continue;

      // The background hum: growth and ordinary lives. High-volume, low-weight —
      // exactly the chatter the weight filter is meant to drop.
      if (rng.chance(0.6)) {
        c.pop *= 1 + rng.range(-0.01, 0.03);
        emit(world, {
          kind: "growth",
          civ: c.id,
          magnitude: rng.next() * 0.4,
          fields: { place: `${c.name}'s heartland` },
        });
      }
      if (rng.chance(0.4)) {
        const trade = rng.pick(["potter", "elder", "smith", "singer", "hunter"]);
        emit(world, {
          kind: "person",
          civ: c.id,
          magnitude: rng.next() * 0.5,
          fields: { subject: `A ${trade} of ${c.name} lived and was remembered` },
        });
      }
      if (rng.chance(0.2)) {
        const verb = rng.pick([
          "build a granary",
          "raid the coast",
          "move upriver",
          "wait",
        ]);
        emit(world, {
          kind: rng.chance(0.5) ? "decision" : "refusal",
          civ: c.id,
          magnitude: rng.next() * 0.6,
          fields: { civ: c.name, subject: verb },
        });
      }

      // Discoveries span the spectrum; a rare few are epochal.
      if (rng.chance(0.05)) {
        const epochal = rng.chance(0.2);
        const what = epochal
          ? rng.pick(["ironworking", "the wheel", "writing", "the sail"])
          : rng.pick(["fire-hardening", "the bow", "pottery", "the fish-weir"]);
        emit(world, {
          kind: "discovery",
          civ: c.id,
          magnitude: epochal ? rng.range(0.75, 1) : rng.range(0.1, 0.4),
          fields: { civ: c.name, subject: what },
        });
      }

      // Famine, with its cause: the fields fail, then the people go hungry.
      if (rng.chance(0.03)) {
        const shortfall = rng.range(0.15, 0.9);
        const harvest = emit(world, {
          kind: "disaster",
          civ: c.id,
          magnitude: shortfall,
          text: `The harvest failed across ${c.name}.`,
        });
        emit(world, {
          kind: "famine",
          civ: c.id,
          magnitude: shortfall,
          causedBy: [harvest.id],
        });
        c.pop *= 1 - shortfall * 0.1;
      }
      if (rng.chance(0.01)) {
        emit(world, {
          kind: "plague",
          civ: c.id,
          magnitude: rng.range(0.3, 1),
          fields: { civ: c.name },
        });
        c.pop *= 0.85;
      }
      if (rng.chance(0.008)) {
        c.gov = rng.pick(["a chiefdom", "a kingdom", "a republic", "an empire"]);
        emit(world, {
          kind: "government",
          civ: c.id,
          magnitude: rng.range(0.3, 0.9),
          fields: { civ: c.name, subject: c.gov },
        });
      }
    }

    // Between peoples: contact once, then the long story of war and peace.
    const alive = civs.filter((c) => c.alive);
    if (alive.length >= 2 && rng.chance(0.3)) {
      const a = rng.pick(alive);
      const b = rng.pick(alive);
      if (a.id !== b.id) {
        const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
        if (!met.has(key)) {
          met.add(key);
          emit(world, {
            kind: "contact",
            civ: a.id,
            magnitude: rng.range(0.5, 0.9),
            fields: { civ: a.name, other: b.name },
          });
        } else {
          const roll = rng.next();
          const common = { civ: a.name, other: b.name };
          if (roll < 0.4) {
            emit(world, {
              kind: "war",
              civ: a.id,
              magnitude: rng.range(0.4, 1),
              fields: common,
            });
          } else if (roll < 0.6) {
            emit(world, {
              kind: "battle",
              civ: a.id,
              magnitude: rng.range(0.3, 1),
              fields: { ...common, place: "the border marches" },
            });
          } else if (roll < 0.78) {
            emit(world, {
              kind: "peace",
              civ: a.id,
              magnitude: rng.range(0.4, 0.9),
              fields: common,
            });
          } else {
            emit(world, {
              kind: "trade",
              civ: a.id,
              magnitude: rng.next() * 0.6,
              fields: common,
            });
          }
        }
      }
    }

    // Collapse is rare and never wipes the board — history must keep moving.
    if (alive.length > 2 && rng.chance(0.0015)) {
      const victim = rng.pick(alive);
      victim.alive = false;
      emit(world, {
        kind: "collapse",
        civ: victim.id,
        magnitude: rng.range(0.7, 1),
        fields: { civ: victim.name },
      });
    }
  }

  return world;
}

test("a 2,000-year run produces a readable, traceable, filterable chronicle", () => {
  const world = runTwoThousandYears(42);
  const events = world.events;

  // Something actually happened.
  assert.ok(events.length > 8000, `a busy world logs a lot (${events.length})`);

  // At least 6 distinct kinds.
  const kinds = new Set(events.map((e) => e.kind));
  assert.ok(
    kinds.size >= 6,
    `at least 6 kinds (${kinds.size}: ${[...kinds].join(", ")})`,
  );

  // Every event is well-formed: a year, a valid kind, weight in 0..1, real text.
  const kindSet = new Set<EventKind>(ALL_KINDS);
  let prevId = -1;
  for (const e of events) {
    assert.ok(Number.isInteger(e.year) && e.year >= 0, "has a year");
    assert.ok(kindSet.has(e.kind), `valid kind: ${e.kind}`);
    assert.ok(e.weight >= 0 && e.weight <= 1, `weight in 0..1: ${e.weight}`);
    assert.ok(typeof e.text === "string" && e.text.length > 0, "non-empty text");
    assert.ok(Array.isArray(e.causedBy), "causedBy is an array");
    assert.ok(e.id > prevId, "ids strictly increase (append-only order)");
    prevId = e.id;
  }

  // The chronicle — "things that actually mattered" — is hundreds, not 10,000s.
  const mattered = filterByWeight(events, 0.6);
  assert.ok(mattered.length >= 100, `chronicle has real substance (${mattered.length})`);
  assert.ok(
    mattered.length < 3000,
    `chronicle stays readable in one sitting (${mattered.length})`,
  );
  assert.ok(
    events.length > mattered.length * 5,
    `the filter is doing real work (${events.length} down to ${mattered.length})`,
  );

  // A founding never outweighs a collapse, in the actual data.
  const maxFounding = Math.max(
    ...events.filter((e) => e.kind === "founding").map((e) => e.weight),
  );
  const minCollapse = Math.min(
    ...events.filter((e) => e.kind === "collapse").map((e) => e.weight),
  );
  assert.ok(maxFounding < minCollapse, `${maxFounding} < ${minCollapse}`);

  // Following causedBy from a famine reaches the harvest failure that caused it.
  const famine = events.find((e) => e.kind === "famine" && e.causedBy.length > 0);
  assert.ok(famine, "the run produced famines with recorded causes");
  const harvest = traceCauses(events, famine.id).find(
    (c) => c.kind === "disaster" && /harvest/i.test(c.text),
  );
  assert.ok(harvest, "the famine traces back to a harvest failure");

  // The chronicle renders to readable, chronological text.
  const text = renderChronicle(events, { minWeight: 0.6 });
  const lines = text.split("\n");
  assert.equal(lines.length, mattered.length, "one line per chronicled event");
  assert.match(lines[0], /^Year \d+ {2}·/, "each line is dated");
});

test("the run replays identically from the same seed (append-only, deterministic)", () => {
  const a = runTwoThousandYears(7).events;
  const b = runTwoThousandYears(7).events;
  assert.equal(a.length, b.length);
  const key = (e: WorldEvent) =>
    `${e.id}:${e.year}:${e.kind}:${e.weight.toFixed(6)}:${e.text}`;
  assert.deepEqual(a.map(key), b.map(key));
});

// EmitSpec is part of the public surface downstream (the web feed) builds on.
const _typecheckSpec: EmitSpec = { kind: "growth" };
void _typecheckSpec;
