import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTACT_RANGE_KM,
  INBOX_MAX,
  MESSAGE_MAX_LENGTH,
  TREATY_BREAK_WEIGHT,
  addGrievance,
  breakTreaty,
  effectiveOpinion,
  establishContact,
  offerTreaty,
  orderEspionage,
  relayMessage,
  stepDiplomacy,
} from "../src/diplomacy.ts";
import { STARTING_CAPABILITIES } from "../src/knowledge.ts";
import { tickWorld } from "../src/tick.ts";
import type { Relation, World } from "../src/types.ts";
import { generateWorld } from "../src/worldgen.ts";

const SEED = 12345;

/** Give a civ an exact capability set with a clean research slate. */
function setCapabilities(world: World, civId: number, caps: string[]): void {
  const civ = world.civs[civId];
  civ.capabilities = [...caps];
  civ.holders = {};
  civ.forgotten = [];
  civ.research = { target: null, progress: 0 };
}

const NEOLITHIC = [
  ...STARTING_CAPABILITIES,
  "hafting",
  "shelter",
  "plant_domestication",
  "settlement",
];

/** Contact plus an already-running trade route — the common fixture. */
function connect(world: World, a: number, b: number): void {
  establishContact(world, a, b);
  const ra = world.civs[a].relations[b];
  const rb = world.civs[b].relations[a];
  ra.tradeSince = world.year;
  rb.tradeSince = world.year;
}

/* ================================================================== *
 * Contact — territories drifting within range
 * ================================================================== */

test("two civs whose territories come within range make contact: one event, mutual known", () => {
  const world = generateWorld(SEED);
  // Plant a greatlakes toehold two cells east of the aquitaine camp — ~160 km
  // at that latitude, inside CONTACT_RANGE_KM.
  const home = world.settlements.find((s) => s.civ === 0);
  assert.ok(home);
  world.grid.owner[home.cell + 2] = 1;

  const report = stepDiplomacy(world);

  assert.deepEqual(report.contacts, [[0, 1]]);
  assert.ok(world.civs[0].known.includes(1), "civ 0 now knows civ 1");
  assert.ok(world.civs[1].known.includes(0), "civ 1 now knows civ 0");

  const contactEvents = world.events.filter((e) => e.kind === "contact");
  assert.equal(contactEvents.length, 1, "exactly one contact event for the pair");
  assert.match(contactEvents[0].text, /met .* for the first time/);

  const r01 = world.civs[0].relations[1];
  const r10 = world.civs[1].relations[0];
  assert.equal(r01.contactYear, world.year);
  assert.equal(r10.contactYear, world.year);
  assert.equal(r01.contactEvent, contactEvents[0].id);
  // First impressions were formed — noisy, but formed — on both sides.
  assert.ok(r01.belief && r01.belief.asOf === world.year);
  assert.ok(r10.belief && r10.belief.asOf === world.year);
  assert.ok(CONTACT_RANGE_KM > 160, "the fixture really is inside base range");
});

test("a people that can navigate discovers a distant shore by expedition", () => {
  const world = generateWorld(SEED);
  setCapabilities(world, 0, [...NEOLITHIC, "boats", "weaving", "sailing", "navigation"]);
  const camp = world.settlements.find((s) => s.civ === 0);
  assert.ok(camp);
  world.grid.coast[camp.cell] = 1; // the navigator's camp is a port
  const farShore = camp.cell + 30; // ~2,400 km east — far beyond sail range
  world.grid.owner[farShore] = 1;
  world.grid.coast[farShore] = 1;

  let met: number | null = null;
  for (let y = 1; y <= 80 && met === null; y++) {
    world.year = y;
    if (stepDiplomacy(world).contacts.length > 0) met = y;
  }

  assert.ok(met !== null, "an expedition eventually found them");
  assert.ok(world.civs[0].known.includes(1) && world.civs[1].known.includes(0));
  const contact = world.events.find((e) => e.kind === "contact");
  assert.equal(contact?.cell, farShore, "the meeting happened on the discovered shore");
});

test("civs far beyond contact range do not meet", () => {
  const world = generateWorld(SEED);
  const report = stepDiplomacy(world);
  assert.deepEqual(report.contacts, []);
  for (const civ of world.civs) assert.equal(civ.known.length, 0);
});

/* ================================================================== *
 * Grievances — memory that decays, not a mood that resets
 * ================================================================== */

test("a grievance still depresses opinion 200 years on, and has decayed by 600", () => {
  const base: Relation = {
    opinion: 0,
    atWar: false,
    treaty: null,
    grievances: [],
    contactYear: 0,
  };
  const wronged: Relation = {
    ...base,
    grievances: [{ year: 100, note: "broke the pact sworn between us", weight: 0.8 }],
  };

  const at200 = effectiveOpinion(base, 300) - effectiveOpinion(wronged, 300);
  const at600 = effectiveOpinion(base, 700) - effectiveOpinion(wronged, 700);

  assert.ok(at200 >= 10, `still measurably depressed at +200 (got ${at200})`);
  assert.ok(at600 <= 5, `mostly faded by +600 (got ${at600})`);
  assert.ok(at600 < at200 * 0.2, "the sting at +600 is a shadow of the sting at +200");
});

test("the decaying memory flows through the yearly step, not just the pure function", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  addGrievance(world, 1, 0, "broke the pact sworn between us", 0.8);

  world.year = 200;
  stepDiplomacy(world);
  const depressed = world.civs[1].relations[0].opinion;
  assert.ok(depressed <= -10, `opinion at +200 is depressed (got ${depressed})`);

  world.year = 600;
  stepDiplomacy(world);
  const faded = world.civs[1].relations[0].opinion;
  assert.ok(faded >= 5, `opinion at +600 has recovered (got ${faded})`);
  assert.ok(
    world.civs[1].relations[0].grievances.length === 1,
    "the grievance is remembered even once it barely stings",
  );
});

/* ================================================================== *
 * Treaties — sworn by consent, broken at a price
 * ================================================================== */

test("mutual offers become a treaty; breaking it plants a grievance the other side keeps", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  assert.ok(offerTreaty(world, 0, 1));
  assert.ok(offerTreaty(world, 1, 0));

  world.year = 1;
  const report = stepDiplomacy(world);
  assert.deepEqual(report.treaties, [[0, 1]]);
  assert.ok(world.civs[0].relations[1].treaty, "treaty stands on one side");
  assert.ok(world.civs[1].relations[0].treaty, "and on the other");

  assert.ok(breakTreaty(world, 0, 1), "the pact can be broken");
  assert.equal(world.civs[0].relations[1].treaty, null);
  assert.equal(world.civs[1].relations[0].treaty, null);

  const grievances = world.civs[1].relations[0].grievances;
  assert.equal(grievances.length, 1, "the wronged side records the betrayal");
  assert.equal(grievances[0].weight, TREATY_BREAK_WEIGHT);
  assert.ok(
    world.civs[1].relations[0].opinion <= -50,
    `a fresh betrayal poisons opinion (got ${world.civs[1].relations[0].opinion})`,
  );
  assert.equal(
    world.civs[0].relations[1].grievances.length,
    0,
    "the breaker carries no grievance of its own",
  );
  assert.ok(
    world.events.some((e) => e.kind === "peace" && /broke its pact/.test(e.text)),
    "the betrayal is on the record",
  );
});

/* ================================================================== *
 * Trade — real goods out of one store, into another
 * ================================================================== */

test("trade opens by itself between civilised neighbours, caused by the contact", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  const contactId = world.civs[0].relations[1].contactEvent;

  let opened: number | null = null;
  for (let y = 1; y <= 15 && opened === null; y++) {
    world.year = y;
    const report = stepDiplomacy(world);
    if (report.tradeOpened.length > 0) opened = y;
  }
  assert.equal(opened, 10, "the route opens ten years after contact");
  const tradeEvent = world.events.find((e) => e.kind === "trade");
  assert.ok(tradeEvent);
  assert.match(tradeEvent.text, /opened trade/);
  assert.deepEqual(tradeEvent.causedBy, [contactId], "the route remembers the meeting");
});

test("trade moves real goods out of one civ's stores and into the other's", () => {
  const world = generateWorld(SEED);
  connect(world, 0, 1);
  const a = world.civs[0];
  const b = world.civs[1];
  a.stores.copper = 100; // a has metal b lacks
  b.stores.food = 5000; // b has grain to spare

  const copperBefore = a.stores.copper + b.stores.copper;
  const foodBefore = a.stores.food + b.stores.food;
  const aCopper = a.stores.copper;
  const bFood = b.stores.food;
  const aFood = a.stores.food;

  world.year = 5;
  const report = stepDiplomacy(world);

  assert.equal(report.trades.length, 1, "the route carried goods this year");
  assert.ok(report.trades[0].value > 0);
  assert.ok(a.stores.copper < aCopper, "copper left the seller");
  assert.ok(b.stores.copper > 0, "and reached the buyer");
  assert.ok(b.stores.food < bFood, "grain went the other way");
  assert.ok(a.stores.food > aFood, "and arrived");
  // Barter conserves goods — nothing is minted or burned in transit.
  assert.ok(Math.abs(a.stores.copper + b.stores.copper - copperBefore) < 1e-9);
  assert.ok(Math.abs(a.stores.food + b.stores.food - foodBefore) < 1e-9);
});

/* ================================================================== *
 * Diffusion — ideas leak, but only through the possibility gates
 * ================================================================== */

test("a capability spreads to a trading partner without that partner researching it", () => {
  const world = generateWorld(SEED);
  setCapabilities(world, 0, [...NEOLITHIC, "pottery"]);
  setCapabilities(world, 1, NEOLITHIC);
  connect(world, 0, 1);

  let leaked = false;
  for (let y = 1; y <= 800 && !leaked; y++) {
    world.year = y;
    const report = stepDiplomacy(world);
    leaked = report.diffused.some(
      (d) => d.to === 1 && d.from === 0 && d.capability === "pottery",
    );
  }

  assert.ok(leaked, "pottery leaked along the trade route");
  assert.ok(world.civs[1].capabilities.includes("pottery"));
  assert.equal(world.civs[1].research.progress, 0, "no research was spent on it");
  assert.equal(world.civs[1].research.target, null, "and none was ever steered");
  assert.ok(world.civs[1].holders.pottery, "the adopters actually hold it");
  assert.ok(
    world.events.some((e) => e.kind === "discovery" && /learned Pottery from/.test(e.text)),
    "the log says where it came from",
  );
});

test("diffusion never crosses a material gate: no copper in reach, no copperworking", () => {
  const world = generateWorld(SEED);
  const smiths = [...NEOLITHIC, "pottery", "kiln", "smelting"];
  setCapabilities(world, 0, [...smiths, "copper_working"]);
  setCapabilities(world, 1, smiths); // knows how to smelt — owns no copper
  connect(world, 0, 1);

  for (let y = 1; y <= 500; y++) {
    world.year = y;
    const report = stepDiplomacy(world);
    assert.equal(report.diffused.length, 0, `year ${y}: nothing diffusible exists`);
  }
  assert.ok(
    !world.civs[1].capabilities.includes("copper_working"),
    "five centuries beside a master smith taught nothing the land cannot support",
  );
});

/* ================================================================== *
 * Espionage — ordered by a mind, resolved by the world
 * ================================================================== */

test("espionage resolves probabilistically, steals through the gates, and detection leaves a grievance", () => {
  const world = generateWorld(SEED);
  setCapabilities(world, 0, NEOLITHIC); // the spy can adopt pottery
  setCapabilities(world, 1, [...NEOLITHIC, "pottery"]);
  establishContact(world, 0, 1);
  const spy = world.civs[0];
  spy.government.centralization = 0.5;
  // At war: the trade and diffusion channels are shut, so anything the spy
  // learns arrived by espionage alone.
  world.civs[0].relations[1].atWar = true;
  world.civs[1].relations[0].atWar = true;

  let successes = 0;
  let failures = 0;
  let detections = 0;
  let stolePottery = false;
  const attempts = 120;
  for (let y = 1; y <= attempts; y++) {
    world.year = y;
    orderEspionage(spy, { target: 1, mission: "steal", capability: "pottery", year: y });
    const report = stepDiplomacy(world);
    assert.equal(report.espionage.length, 1, "one order in, one resolution out");
    const op = report.espionage[0];
    if (op.success) successes++;
    else failures++;
    if (op.detected) detections++;
    if (op.stole === "pottery") stolePottery = true;
  }

  assert.ok(successes > 0 && failures > 0, "success is a roll, not a certainty either way");
  assert.ok(stolePottery, "a successful mission carried the capability home");
  assert.ok(world.civs[0].capabilities.includes("pottery"));
  assert.ok(detections > 0, "some missions were caught");
  const grievances = world.civs[1].relations[0].grievances;
  assert.ok(
    grievances.some((g) => g.note === "sent spies among us"),
    "being caught plants a grievance",
  );
  assert.ok(
    world.events.some((e) => /caught spies sent by/.test(e.text)),
    "the catch is on the record",
  );
});

test("a successful assessment sharpens beliefs; isolation just lets them age", () => {
  const world = generateWorld(SEED);
  establishContact(world, 0, 1);
  const spy = world.civs[0];
  spy.government.centralization = 0.6;
  // At war, so trade never opens and no traders' gossip refreshes anything.
  world.civs[0].relations[1].atWar = true;
  world.civs[1].relations[0].atWar = true;
  const firstImpression = spy.relations[1].belief;
  assert.ok(firstImpression);

  // No trade route: with no ops, the belief is never refreshed — it only ages.
  world.year = 50;
  stepDiplomacy(world);
  assert.equal(spy.relations[1].belief?.asOf, firstImpression.asOf, "isolation refreshes nothing");

  let assessed: number | null = null;
  for (let y = 51; y <= 90 && assessed === null; y++) {
    world.year = y;
    orderEspionage(spy, { target: 1, mission: "assess", year: y });
    const report = stepDiplomacy(world);
    if (report.espionage[0]?.success) assessed = y;
  }
  assert.ok(assessed !== null, "an assessment eventually lands");
  assert.equal(spy.relations[1].belief?.asOf, assessed, "spies brought back a fresh estimate");
});

/* ================================================================== *
 * Messages — relayed through the engine, only between civs in contact
 * ================================================================== */

test("messages are relayed only after contact, bounded in length and number", () => {
  const world = generateWorld(SEED);
  assert.equal(relayMessage(world, 0, 1, "hello?"), false, "no contact, no channel");

  establishContact(world, 0, 1);
  assert.equal(relayMessage(world, 0, 1, "we come in peace"), true);
  const inbox = world.civs[1].relations[0].inbox;
  assert.ok(inbox && inbox.length === 1);
  assert.equal(inbox[0].text, "we come in peace");

  relayMessage(world, 0, 1, "x".repeat(MESSAGE_MAX_LENGTH * 2));
  assert.equal(
    world.civs[1].relations[0].inbox?.at(-1)?.text.length,
    MESSAGE_MAX_LENGTH,
    "a message cannot exceed the bound",
  );

  for (let i = 0; i < INBOX_MAX + 3; i++) relayMessage(world, 0, 1, `note ${i}`);
  assert.equal(world.civs[1].relations[0].inbox?.length, INBOX_MAX, "the inbox is capped");
});

/* ================================================================== *
 * Determinism and integration
 * ================================================================== */

test("the same seed and dealings replay to the same diplomatic history", () => {
  const run = (): string => {
    const world = generateWorld(SEED);
    setCapabilities(world, 0, [...NEOLITHIC, "pottery"]);
    setCapabilities(world, 1, NEOLITHIC);
    connect(world, 0, 1);
    for (let y = 1; y <= 120; y++) {
      world.year = y;
      stepDiplomacy(world);
    }
    return JSON.stringify({
      events: world.events.map((e) => e.text),
      relations: [world.civs[0].relations, world.civs[1].relations],
      caps: world.civs.map((c) => c.capabilities),
    });
  };
  assert.equal(run(), run(), "byte-identical across two runs");
});

test("the tick runs the diplomacy stage and reports it", () => {
  const world = generateWorld(SEED);
  const report = tickWorld(world);
  assert.ok(report.diplomacy, "the tick carries a diplomacy report");
  assert.deepEqual(report.diplomacy.contacts, [], "nobody meets in year zero");
  assert.equal(world.year, 1);
});
