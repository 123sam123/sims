/**
 * Directives and their adjudication — "the agent proposes, the engine disposes".
 *
 * A brain (LLM or heuristic) returns a small set of *directives*: things the
 * civilisation wants to do. None of them touch the world directly. Every one is
 * run past six named gates, and only the survivors are applied:
 *
 *   knowledge  — do they know how? (reuses the capability gates in `knowledge.ts`)
 *   materials  — is the stuff physically in reach? (deposits / stores)
 *   labour     — are there hands to spare for it?
 *   capital    — is anything stockpiled to fund it?
 *   authority  — does their government have the standing to command it?
 *   time       — is their society large / advanced enough yet?
 *
 * A refusal comes back naming its gate and a plain reason, so a civilisation
 * learns the shape of the world by hitting its walls — which is the whole point.
 * An accepted directive returns an `apply` that mutates only bounded, engine-
 * owned state: a research target, a queued `Project`, clamped policy weights, or
 * a name/record. It never invents new mechanics; construction and settlement
 * become `Project`s the tick executes over the following years.
 */

import {
  blockedBecause,
  CAPABILITY_BY_ID,
  type Capability,
  type Civ,
  civPopulation,
  declareWar,
  offerTreaty,
  orderEspionage,
  type Project,
  breakTreaty,
  sueForPeace,
  relayMessage,
  researchGates,
  type StoreKey,
  type World,
  workingAgePopulation,
} from "@sim/engine";

/* ------------------------------------------------------------------ *
 * The directive vocabulary
 * ------------------------------------------------------------------ */

export interface ResearchDirective {
  type: "research";
  /** A capability id to steer research toward. */
  target: string;
  rationale?: string;
}
export interface ConstructDirective {
  type: "construct";
  /** A structure or item to build — free text; gated ones need the capability. */
  building: string;
  /** Settlement id to build at; defaults to the civ's largest. */
  settlement?: number;
  rationale?: string;
}
export interface SettleDirective {
  type: "settle";
  rationale?: string;
}
export interface PolicyDirective {
  type: "policy";
  /** Effort weights, each clamped to 0..1. Only the fields given are changed. */
  farming?: number;
  building?: number;
  research?: number;
  military?: number;
  rationale?: string;
}
export interface ProclaimDirective {
  type: "proclaim";
  /** A name the civilisation gives itself. */
  name?: string;
  /** A form of government it declares. */
  governmentForm?: string;
  /** A line for the chronicle — a law, an institution, an event named. */
  record?: string;
  rationale?: string;
}

export interface EnvoyDirective {
  type: "envoy";
  /** Civ id the message is for — must be a people this civ has met. */
  towards: number;
  /** The message itself. Relayed through the engine, bounded, never a
   *  side-channel: only civs with contact can hear each other. */
  message: string;
  rationale?: string;
}
export interface PactDirective {
  type: "pact";
  towards: number;
  /** Offer a treaty, tear up the one that stands, declare war, or sue for
   *  peace in a war being fought. The engine never blocks the choice of war —
   *  it prices it. */
  action: "offer" | "break" | "war" | "peace";
  rationale?: string;
}
export interface SpyDirective {
  type: "spy";
  towards: number;
  /** Steal a capability, or assess the target (sharpen beliefs about it). */
  mission: "steal" | "assess";
  /** For `steal`: the capability hoped for (optional). */
  capability?: string;
  rationale?: string;
}

export type Directive =
  | ResearchDirective
  | ConstructDirective
  | SettleDirective
  | PolicyDirective
  | ProclaimDirective
  | EnvoyDirective
  | PactDirective
  | SpyDirective;

export interface DirectiveSet {
  directives: Directive[];
}

/** The gate inputs the research layer exposes — held caps, population and the
 *  material/terrain predicates for a civ. */
type ResearchGates = ReturnType<typeof researchGates>;

export type Gate = "knowledge" | "materials" | "labour" | "capital" | "authority" | "time";

export type Adjudication =
  | { ok: true; summary: string; apply: (world: World, civ: Civ) => void }
  | { ok: false; gate: Gate; reason: string };

/* ------------------------------------------------------------------ *
 * The structured-output schema the model must return
 * ------------------------------------------------------------------ */

/**
 * The JSON schema handed to the model via `output_config.format`. Flat by
 * design: one object shape covers all five directive kinds, keyed by `type`,
 * so structured outputs never have to choose between branches. `normalize`
 * below maps this raw shape onto the tagged `Directive` union.
 */
export const DIRECTIVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    directives: {
      type: "array",
      description: "The orders your civilisation issues this decision. Keep it to a handful.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: {
            type: "string",
            enum: ["research", "construct", "settle", "policy", "proclaim", "envoy", "pact", "spy"],
          },
          target: { type: "string", description: "research: a capability to pursue" },
          building: { type: "string", description: "construct: what to build" },
          atSettlement: { type: "number", description: "construct: settlement id (optional)" },
          farmShare: { type: "number", description: "policy: 0..1 effort on food" },
          buildShare: { type: "number", description: "policy: 0..1 effort on building" },
          researchShare: { type: "number", description: "policy: 0..1 effort on learning" },
          militaryShare: { type: "number", description: "policy: 0..1 effort on the military" },
          name: { type: "string", description: "proclaim: a name for your people" },
          governmentForm: { type: "string", description: "proclaim: a form of government" },
          record: { type: "string", description: "proclaim: a line for the chronicle" },
          towards: { type: "number", description: "envoy/pact/spy: the civ id it concerns" },
          message: { type: "string", description: "envoy: words carried to that people" },
          action: { type: "string", enum: ["offer", "break", "war", "peace"], description: "pact: offer a treaty, break the standing one, declare war, or sue for peace" },
          mission: { type: "string", enum: ["steal", "assess"], description: "spy: steal a capability, or assess their strength" },
          capability: { type: "string", description: "spy steal: the capability hoped for (optional)" },
          rationale: { type: "string", description: "one short sentence of why" },
        },
      },
    },
  },
  required: ["directives"],
} as const;

interface RawDirective {
  type?: string;
  target?: unknown;
  building?: unknown;
  atSettlement?: unknown;
  farmShare?: unknown;
  buildShare?: unknown;
  researchShare?: unknown;
  militaryShare?: unknown;
  name?: unknown;
  governmentForm?: unknown;
  record?: unknown;
  towards?: unknown;
  message?: unknown;
  action?: unknown;
  mission?: unknown;
  capability?: unknown;
  rationale?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Map one raw object onto a `Directive`, or null if it is not a usable order. */
function toDirective(raw: RawDirective): Directive | null {
  const rationale = str(raw.rationale);
  switch (raw.type) {
    case "research": {
      const target = str(raw.target);
      return target ? { type: "research", target, rationale } : null;
    }
    case "construct": {
      const building = str(raw.building);
      const settlement = num(raw.atSettlement);
      return building ? { type: "construct", building, settlement, rationale } : null;
    }
    case "settle":
      return { type: "settle", rationale };
    case "policy": {
      const d: PolicyDirective = { type: "policy", rationale };
      if (num(raw.farmShare) !== undefined) d.farming = num(raw.farmShare);
      if (num(raw.buildShare) !== undefined) d.building = num(raw.buildShare);
      if (num(raw.researchShare) !== undefined) d.research = num(raw.researchShare);
      if (num(raw.militaryShare) !== undefined) d.military = num(raw.militaryShare);
      const hasAny =
        d.farming !== undefined ||
        d.building !== undefined ||
        d.research !== undefined ||
        d.military !== undefined;
      return hasAny ? d : null;
    }
    case "proclaim": {
      const d: ProclaimDirective = {
        type: "proclaim",
        name: str(raw.name),
        governmentForm: str(raw.governmentForm),
        record: str(raw.record),
        rationale,
      };
      return d.name || d.governmentForm || d.record ? d : null;
    }
    case "envoy": {
      const towards = num(raw.towards);
      const message = str(raw.message);
      return towards !== undefined && message
        ? { type: "envoy", towards, message, rationale }
        : null;
    }
    case "pact": {
      const towards = num(raw.towards);
      const action = str(raw.action);
      return towards !== undefined &&
        (action === "offer" || action === "break" || action === "war" || action === "peace")
        ? { type: "pact", towards, action, rationale }
        : null;
    }
    case "spy": {
      const towards = num(raw.towards);
      const mission = str(raw.mission);
      return towards !== undefined && (mission === "steal" || mission === "assess")
        ? { type: "spy", towards, mission, capability: str(raw.capability), rationale }
        : null;
    }
    default:
      return null;
  }
}

/** Parse a model's raw text (structured JSON) into a validated `DirectiveSet`.
 *  Never throws: malformed output yields an empty set, and the civ simply
 *  drifts on its standing orders that year. */
export function parseDirectiveSet(text: string): DirectiveSet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { directives: [] };
  }
  return normalize(parsed);
}

/** Coerce an already-parsed value into a `DirectiveSet`. */
export function normalize(parsed: unknown): DirectiveSet {
  const list =
    parsed && typeof parsed === "object" && Array.isArray((parsed as { directives?: unknown }).directives)
      ? ((parsed as { directives: unknown[] }).directives as RawDirective[])
      : [];
  const directives: Directive[] = [];
  for (const raw of list) {
    if (raw && typeof raw === "object") {
      const d = toDirective(raw);
      if (d) directives.push(d);
    }
  }
  return { directives };
}

/* ------------------------------------------------------------------ *
 * Buildable things — cost, and what a gated one demands to know
 * ------------------------------------------------------------------ */

/** Structures/items whose making needs a capability first. A stone-age band
 *  ordering "bronze tools" trips the knowledge gate here. Keys are matched
 *  case-insensitively against the requested building. */
const BUILDING_CAPABILITY: Record<string, string> = {
  "bronze tools": "bronze",
  "bronze weapons": "bronze",
  bronze: "bronze",
  "iron tools": "iron_smelting",
  "iron weapons": "iron_smelting",
  iron: "iron_smelting",
  "steel tools": "steel",
  steel: "steel",
  walls: "fortification",
  wall: "fortification",
  fortifications: "fortification",
  fort: "fortification",
  aqueduct: "aqueduct",
  granary: "granary",
  granaries: "granary",
  road: "roads",
  roads: "roads",
  temple: "masonry",
  monument: "masonry",
  ship: "sailing",
  ships: "sailing",
};

/** Buildings whose scale needs real central authority to command. */
const MONUMENTAL = new Set(["temple", "monument", "palace", "pyramid", "wonder", "cathedral", "ziggurat"]);

interface BuildSpec {
  labour: number;
  cost: Partial<Record<StoreKey, number>>;
}

/** Labour-years and materials a building takes. Sized so an ordinary structure
 *  is several years of a modest civ's building effort — never instant. */
function buildSpec(building: string): BuildSpec {
  const b = building.toLowerCase();
  if (MONUMENTAL.has(b)) return { labour: 140, cost: { wood: 80, stone: 160 } };
  if (b.includes("wall") || b.includes("fort")) return { labour: 90, cost: { wood: 20, stone: 140 } };
  if (b.includes("aqueduct") || b.includes("road")) return { labour: 110, cost: { wood: 30, stone: 120 } };
  if (b.includes("granary") || b.includes("storehouse") || b.includes("store")) {
    return { labour: 45, cost: { wood: 50, stone: 30 } };
  }
  if (b.includes("house") || b.includes("dwelling") || b.includes("longhouse")) {
    return { labour: 30, cost: { wood: 45, stone: 10 } };
  }
  if (b.includes("tool") || b.includes("weapon") || b.includes("ship")) {
    return { labour: 40, cost: { wood: 30, stone: 20 } };
  }
  return { labour: 45, cost: { wood: 40, stone: 30 } };
}

/* ------------------------------------------------------------------ *
 * The six gates
 * ------------------------------------------------------------------ */

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Queue a project on a civ, creating the queue on first use. */
function enqueue(civ: Civ, project: Project): void {
  if (!civ.projects) civ.projects = [];
  civ.projects.push(project);
}

/** Least building-labour a project needs to be worth beginning (labour gate). */
const MIN_BUILD_LABOUR = 1;
/** Fraction of a project's material bill a civ must have stockpiled to begin. */
const CAPITAL_FLOOR = 0.1;
/** Centralization a monumental work demands (authority gate). */
const MONUMENT_CENTRALIZATION = 0.25;
/** Legitimacy a proclamation demands (authority gate). */
const PROCLAIM_LEGITIMACY = 0.25;
/** Centralization an espionage operation demands — spies need a hand that can
 *  direct them and keep the secret (authority gate). */
const SPY_CENTRALIZATION = 0.2;
/** Provisions a mission abroad consumes, drawn from stores (capital gate). */
const SPY_FOOD_COST = 20;

/**
 * Run a directive past the six gates. Pure — it reads world/civ state and
 * returns a verdict; nothing is mutated until the caller invokes `apply` on an
 * accepted one.
 */
export function adjudicate(world: World, civ: Civ, d: Directive): Adjudication {
  switch (d.type) {
    case "research":
      return adjudicateResearch(world, civ, d);
    case "construct":
      return adjudicateConstruct(world, civ, d);
    case "settle":
      return adjudicateSettle(world, civ, d);
    case "policy":
      return adjudicatePolicy(d);
    case "proclaim":
      return adjudicateProclaim(civ, d);
    case "envoy":
      return adjudicateEnvoy(world, civ, d);
    case "pact":
      return adjudicatePact(world, civ, d);
    case "spy":
      return adjudicateSpy(world, civ, d);
  }
}

/** The knowledge gate every dealing with another people shares: you cannot
 *  treat with, speak to or spy on a people you have never met. */
function knownCounterpart(world: World, civ: Civ, towards: number): Civ | { gate: Gate; reason: string } {
  const other = world.civs[towards];
  if (!other || towards === civ.id) {
    return { gate: "knowledge", reason: "no such people is known to you" };
  }
  if (!civ.known.includes(towards)) {
    return { gate: "knowledge", reason: "you have never met that people" };
  }
  if (!other.alive) {
    return { gate: "knowledge", reason: `${other.name} is no more` };
  }
  return other;
}

const isRefusal = (v: Civ | { gate: Gate; reason: string }): v is { gate: Gate; reason: string } =>
  !("id" in v);

function adjudicateEnvoy(world: World, civ: Civ, d: EnvoyDirective): Adjudication {
  const other = knownCounterpart(world, civ, d.towards);
  if (isRefusal(other)) return { ok: false, ...other };
  return {
    ok: true,
    summary: `send an envoy to ${other.name}`,
    apply: (w, c) => {
      relayMessage(w, c.id, d.towards, d.message);
    },
  };
}

function adjudicatePact(world: World, civ: Civ, d: PactDirective): Adjudication {
  const other = knownCounterpart(world, civ, d.towards);
  if (isRefusal(other)) return { ok: false, ...other };
  if (civ.government.legitimacy < PROCLAIM_LEGITIMACY) {
    return { ok: false, gate: "authority", reason: "your leadership lacks the standing to bind your people's word" };
  }
  const rel = civ.relations[d.towards];
  if (d.action === "break") {
    if (!rel?.treaty) {
      return { ok: false, gate: "authority", reason: `no pact stands with ${other.name} to break` };
    }
    return {
      ok: true,
      summary: `break the pact with ${other.name}`,
      apply: (w, c) => {
        breakTreaty(w, c.id, d.towards);
      },
    };
  }
  if (d.action === "war") {
    if (rel?.atWar) {
      return { ok: true, summary: `you are already at war with ${other.name}`, apply: () => {} };
    }
    // The engine does not moralise war — it prices it. The only gates are the
    // ones every dealing has: a known counterpart and the standing to command.
    return {
      ok: true,
      summary: `declare war on ${other.name}`,
      apply: (w, c) => {
        declareWar(w, c.id, d.towards, "chose war against us");
      },
    };
  }
  if (d.action === "peace") {
    if (!rel?.atWar) {
      return { ok: false, gate: "authority", reason: `no war with ${other.name} to end` };
    }
    return {
      ok: true,
      summary: `sue for peace with ${other.name}`,
      apply: (w, c) => {
        sueForPeace(w, c.id, d.towards);
      },
    };
  }
  if (rel?.treaty) {
    return { ok: true, summary: `a pact already stands with ${other.name}`, apply: () => {} };
  }
  return {
    ok: true,
    summary: `offer ${other.name} a pact`,
    apply: (w, c) => {
      offerTreaty(w, c.id, d.towards);
    },
  };
}

function adjudicateSpy(world: World, civ: Civ, d: SpyDirective): Adjudication {
  const other = knownCounterpart(world, civ, d.towards);
  if (isRefusal(other)) return { ok: false, ...other };
  if (d.capability && !CAPABILITY_BY_ID.has(d.capability)) {
    return { ok: false, gate: "knowledge", reason: `"${d.capability}" is not something that can be learned` };
  }
  if (civ.government.centralization < SPY_CENTRALIZATION) {
    return { ok: false, gate: "authority", reason: "your rule is too loose to direct agents abroad and keep the secret" };
  }
  if (civ.stores.food < SPY_FOOD_COST) {
    return { ok: false, gate: "capital", reason: "your stores cannot provision a mission abroad" };
  }
  return {
    ok: true,
    summary: d.mission === "steal" ? `send spies to steal from ${other.name}` : `send spies to assess ${other.name}`,
    apply: (w, c) => {
      c.stores.food = Math.max(0, c.stores.food - SPY_FOOD_COST);
      orderEspionage(c, {
        target: d.towards,
        mission: d.mission,
        capability: d.capability,
        year: w.year,
      });
    },
  };
}

function adjudicateResearch(world: World, civ: Civ, d: ResearchDirective): Adjudication {
  const cap = CAPABILITY_BY_ID.get(d.target);
  if (!cap) {
    return { ok: false, gate: "knowledge", reason: `"${d.target}" is not something that can be learned` };
  }
  if (civ.capabilities.includes(d.target)) {
    return { ok: true, summary: `${cap.name} is already known`, apply: () => {} };
  }
  const g = researchGates(world, civ.id);
  const wall = closureWall(cap, g);
  if (wall) return { ok: false, gate: wall.gate, reason: `${cap.name} is out of reach: ${wall.reason}` };
  return {
    ok: true,
    summary: `pursue ${cap.name}`,
    apply: (_w, c) => {
      c.research.target = d.target;
    },
  };
}

function adjudicateConstruct(world: World, civ: Civ, d: ConstructDirective): Adjudication {
  // knowledge — a gated structure needs its capability.
  const required = BUILDING_CAPABILITY[d.building.toLowerCase()];
  if (required && !civ.capabilities.includes(required)) {
    const cap = CAPABILITY_BY_ID.get(required);
    return { ok: false, gate: "knowledge", reason: missingKnowledgeReason(civ, d.building, cap) };
  }
  // authority — a monument needs a centralised hand.
  if (MONUMENTAL.has(d.building.toLowerCase()) && civ.government.centralization < MONUMENT_CENTRALIZATION) {
    return {
      ok: false,
      gate: "authority",
      reason: `your leadership is too diffuse to command a ${d.building}`,
    };
  }
  // where — need a settlement to build in.
  const site = pickSettlement(world, civ, d.settlement);
  if (site === null) {
    return { ok: false, gate: "labour", reason: "you have no settlement able to build" };
  }
  // labour — hands must be free to build.
  const buildLabour = workingAgePopulation(world, civ.id) * clamp01(civ.policy.building);
  if (buildLabour < MIN_BUILD_LABOUR) {
    return {
      ok: false,
      gate: "labour",
      reason: "no hands can be spared from feeding the people to build",
    };
  }
  // capital — some materials must already be stockpiled.
  const spec = buildSpec(d.building);
  const bill = materialBill(spec.cost);
  const stocked = materialOnHand(civ, spec.cost);
  if (bill > 0 && stocked < bill * CAPITAL_FLOOR) {
    return { ok: false, gate: "capital", reason: "your stores are too bare to begin the work" };
  }
  const project: Project = {
    kind: "construct",
    building: d.building,
    settlement: site,
    remaining: spec.labour,
    total: spec.labour,
    cost: spec.cost,
    started: world.year,
    note: d.rationale ?? "",
  };
  return {
    ok: true,
    summary: `build ${d.building}`,
    apply: (_w, c) => {
      enqueue(c, project);
    },
  };
}

function adjudicateSettle(world: World, civ: Civ, d: SettleDirective): Adjudication {
  if (!civ.capabilities.includes("settlement")) {
    return {
      ok: false,
      gate: "knowledge",
      reason: "your people have not learned to build permanent settlements",
    };
  }
  const buildLabour = workingAgePopulation(world, civ.id) * clamp01(civ.policy.building);
  if (buildLabour < MIN_BUILD_LABOUR) {
    return { ok: false, gate: "labour", reason: "no hands can be spared to found a new settlement" };
  }
  if (civ.stores.wood < 20) {
    return { ok: false, gate: "capital", reason: "not enough timber to raise a new settlement" };
  }
  const project: Project = {
    kind: "settle",
    building: "settlement",
    settlement: -1,
    remaining: 60,
    total: 60,
    cost: { wood: 80 },
    started: world.year,
    note: d.rationale ?? "",
  };
  return {
    ok: true,
    summary: "found a new settlement",
    apply: (_w, c) => {
      enqueue(c, project);
    },
  };
}

function adjudicatePolicy(d: PolicyDirective): Adjudication {
  const parts: string[] = [];
  const set: Partial<Record<"farming" | "building" | "research" | "military", number>> = {};
  for (const key of ["farming", "building", "research", "military"] as const) {
    const v = d[key];
    if (v === undefined) continue;
    set[key] = clamp01(v);
    parts.push(`${key} ${(clamp01(v) * 100).toFixed(0)}%`);
  }
  if (parts.length === 0) {
    return { ok: false, gate: "authority", reason: "the directive changed no policy" };
  }
  return {
    ok: true,
    summary: `set effort — ${parts.join(", ")}`,
    apply: (_w, c) => {
      for (const key of ["farming", "building", "research", "military"] as const) {
        if (set[key] !== undefined) c.policy[key] = set[key] as number;
      }
    },
  };
}

function adjudicateProclaim(civ: Civ, d: ProclaimDirective): Adjudication {
  if (civ.government.legitimacy < PROCLAIM_LEGITIMACY) {
    return { ok: false, gate: "authority", reason: "your leadership lacks the standing to proclaim" };
  }
  const name = d.name && d.name.length <= 40 ? d.name : undefined;
  const form = d.governmentForm && d.governmentForm.length <= 40 ? d.governmentForm : undefined;
  const record = d.record && d.record.length <= 200 ? d.record : undefined;
  if (!name && !form && !record) {
    return { ok: false, gate: "authority", reason: "nothing lawful to proclaim" };
  }
  const parts: string[] = [];
  if (name) parts.push(`take the name ${name}`);
  if (form) parts.push(`become a ${form}`);
  if (record) parts.push(`record: ${record}`);
  return {
    ok: true,
    summary: parts.join("; "),
    apply: (w, c) => {
      if (name) c.name = name;
      if (form) {
        c.government.form = form;
        c.government.established = w.year;
      }
      if (record) c.chronicle.push(`[${w.year}] ${record}`);
    },
  };
}

/* ------------------------------------------------------------------ *
 * Gate helpers
 * ------------------------------------------------------------------ */

/**
 * Walk a capability's prerequisite closure for the first hard wall — a
 * material, terrain or population limit that no amount of research can lift
 * here — and classify which gate it is. Missing *prerequisites* are not a wall
 * (they can be researched), so only material/terrain/population limits refuse.
 */
function closureWall(cap: Capability, g: ResearchGates): { gate: Gate; reason: string } | null {
  const stack: string[] = [cap.id];
  const seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const c = CAPABILITY_BY_ID.get(id);
    if (!c || g.held.has(id)) continue;
    const unmet = c.needs.filter((n) => !g.held.has(n));
    if (unmet.length === 0) {
      const why = blockedBecause(c, g.held, g.hasMaterial, g.hasTerrain, g.population);
      if (why) return { gate: classifyWall(why), reason: why };
    } else {
      for (const n of unmet) stack.push(n);
    }
  }
  return null;
}

/** Which of the six gates a `blockedBecause` reason belongs to. */
function classifyWall(reason: string): Gate {
  if (reason.includes("population")) return "time";
  if (reason.includes("territory")) return "materials";
  return "materials"; // "no reachable <ore>"
}

/** A knowledge-gate refusal that names the missing capability — and, for a
 *  metalworking order, calls out smelting explicitly, because "you have never
 *  smelted anything" is the honest reason a stone-age band cannot make bronze. */
function missingKnowledgeReason(civ: Civ, building: string, cap: Capability | undefined): string {
  const capName = cap?.name ?? building;
  const held = new Set(civ.capabilities);
  const metal = cap ? dependsOn(cap.id, "smelting") : false;
  if (metal && !held.has("smelting")) {
    return `cannot make ${building}: it needs ${capName}, and your people have never smelted metal`;
  }
  const missing = missingPrerequisites(cap);
  if (missing.length) {
    return `cannot make ${building}: it needs ${capName}, which requires ${missing.join(" and ")} first`;
  }
  return `cannot make ${building}: your people have not developed ${capName}`;
}

/** Whether `id`'s prerequisite closure includes `ancestor`. */
function dependsOn(id: string, ancestor: string): boolean {
  const stack = [id];
  const seen = new Set<string>();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === undefined || seen.has(cur)) continue;
    seen.add(cur);
    if (cur === ancestor) return true;
    const c = CAPABILITY_BY_ID.get(cur);
    if (c) for (const n of c.needs) stack.push(n);
  }
  return false;
}

/** The immediate prerequisites of `cap`, by display name. */
function missingPrerequisites(cap: Capability | undefined): string[] {
  if (!cap) return [];
  return cap.needs.map((n) => CAPABILITY_BY_ID.get(n)?.name ?? n);
}

function materialBill(cost: Partial<Record<StoreKey, number>>): number {
  let total = 0;
  for (const good of Object.keys(cost) as StoreKey[]) total += cost[good] ?? 0;
  return total;
}

function materialOnHand(civ: Civ, cost: Partial<Record<StoreKey, number>>): number {
  let total = 0;
  for (const good of Object.keys(cost) as StoreKey[]) total += civ.stores[good];
  return total;
}

/** The settlement a construction should rise in: the requested one if it
 *  belongs to the civ, otherwise its largest. Null if it has none. */
function pickSettlement(world: World, civ: Civ, requested: number | undefined): number | null {
  const sites = world.settlements.filter((s) => s.civ === civ.id);
  if (sites.length === 0) return null;
  if (requested !== undefined) {
    const match = sites.find((s) => s.id === requested);
    if (match) return match.id;
  }
  let best = sites[0];
  let bestPop = 0;
  for (const s of sites) {
    let pop = 0;
    for (const c of s.cohorts) pop += c;
    if (pop >= bestPop) {
      bestPop = pop;
      best = s;
    }
  }
  return best.id;
}

/** Rough era of a civ, its most advanced capability. Drives decision cadence. */
export function civEra(civ: Civ): number {
  let era = 0;
  for (const id of civ.capabilities) {
    const c = CAPABILITY_BY_ID.get(id);
    if (c && c.era > era) era = c.era;
  }
  return era;
}

/** Total population, re-exported through here so the loop needn't reach into
 *  the engine barrel for one helper. */
export function population(world: World, civId: number): number {
  return civPopulation(world, civId);
}
