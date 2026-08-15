/**
 * Contact, diplomacy, trade and the leak of ideas between civilisations.
 *
 * Everything a civ knows of another arrives through here. Territories that
 * drift within reach of each other establish *contact*; contact opens trade;
 * trade carries goods one way and ideas both ways; and every dealing — the
 * pacts, the betrayals, the spies caught in the night — is remembered.
 *
 * Three commitments shape the module:
 *
 * - **Relations have memory, not a mood.** `opinion` is recomputed every year
 *   from durable components: slow familiarity, an active treaty, a living trade
 *   route, war — and a ledger of grievances that decay on a half-life of
 *   {@link GRIEVANCE_HALF_LIFE} years. A betrayal three centuries old still
 *   colours diplomacy today; six centuries on it has faded to almost nothing.
 *
 * - **Diffusion respects the possibility gates.** A capability leaks to a
 *   neighbour only if that neighbour could research it right now — the same
 *   `researchable()` check research itself uses, prerequisites, materials,
 *   terrain and population included. Being next to the leader changes *how* you
 *   learn ironworking, never *whether* you can without iron. This is one of the
 *   load-bearing anti-snowball forces.
 *
 * - **What a civ believes about another may be wrong.** Beliefs are noisy
 *   snapshots (`Relation.belief`) taken at contact, refreshed by trade and
 *   sharpened by espionage; isolation simply lets them go stale while the real
 *   world moves on. The briefing layer reads only these beliefs — never truth.
 *
 * Espionage follows the propose/dispose contract: an agent *orders* an
 * operation (`Civ.espionage`), and this module resolves it with a seeded roll
 * of agency against counter-intelligence. Detection plants a grievance.
 *
 * Determinism: every stochastic draw for a pair comes from
 * `hashSeed("diplo", lo, hi, year)` with the pair in stable id order, so the
 * result never depends on visit order and a seed always replays. Event kinds
 * are reused rather than invented: pacts sworn and broken emit `peace`, trade
 * opening emits `trade`, a capability that leaks emits `discovery` (via
 * `adoptCapability`), and a spy caught emits `decision`.
 */

import { emit } from "./events.ts";
import { CAPABILITY_BY_ID, type Capability, researchable } from "./knowledge.ts";
import { adoptCapability, researchGates } from "./research.ts";
import { Rng, hashSeed } from "./rng.ts";
import {
  GRID_H,
  GRID_W,
  type Civ,
  type EspionageOp,
  type Relation,
  type StoreKey,
  type World,
  type WorldEvent,
  cellDistance,
  cellIndex,
  cellX,
  cellY,
  civPopulation,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables — every arguable number, named.
 * ------------------------------------------------------------------ */

/** How near two territories must drift (km) before their peoples meet. */
export const CONTACT_RANGE_KM = 260;
/** Contact reach of a civilisation that sails — the sea stops being a wall. */
export const SAIL_CONTACT_RANGE_KM = 620;
/**
 * Expedition reach of a civilisation that can NAVIGATE — arriving where you
 * intended, across open ocean. The five start continents apart and territorial
 * growth is deliberately brake-limited, so proximity alone would never connect
 * the world; deep-water navigation is what does, exactly as it did on the real
 * Earth. An expedition sails from one of the navigator's coastal settlements
 * and can discover any people holding a shore within this range.
 */
export const NAVIGATION_CONTACT_RANGE_KM = 4500;
/** Yearly chance a navigator's expeditions find a reachable unmet people. */
export const EXPEDITION_CHANCE = 0.15;

/** Years for a grievance to lose half its sting. At 0.8 weight a betrayal is
 * worth −80 opinion fresh, still −25 two centuries on, −2.5 after six. */
export const GRIEVANCE_HALF_LIFE = 120;
/** Opinion points per unit of grievance weight, before decay. */
export const GRIEVANCE_OPINION_SCALE = 100;
/** A grievance whose decayed sting falls below this many opinion points is
 * finally forgotten (pruned), so the ledger stays bounded. */
export const GRIEVANCE_FORGOTTEN_BELOW = 1;

/** Grievance weight of a broken treaty — the one they do not forget. */
export const TREATY_BREAK_WEIGHT = 0.8;
/** Grievance weight of catching another civ's spies. */
export const SPY_CAUGHT_WEIGHT = 0.35;

/** Opinion drift from mere peaceful acquaintance, per year and its cap. */
export const FAMILIARITY_RATE = 0.1;
export const FAMILIARITY_CAP = 10;
/** Opinion worth of a standing treaty. */
export const TREATY_OPINION = 15;
/** Opinion worth of an active trade route, plus a slow bonus as it ages. */
export const TRADE_OPINION_BASE = 10;
export const TRADE_OPINION_RATE = 0.1;
export const TRADE_OPINION_CAP = 10;
/** Opinion cost of being at war. */
export const WAR_OPINION = -40;

/** Trade opens on its own between peaceful neighbours: both opinions at or
 * above this, this many years after contact. Trade is the natural state. */
export const TRADE_OPEN_MIN_OPINION = 0;
export const TRADE_OPEN_CONTACT_YEARS = 10;
/** A route lapses when either side's opinion sours below this, or at war. */
export const TRADE_CLOSE_OPINION = -20;

/** Base value a route can move per year, scaled by what both ends have built. */
export const TRADE_CAPACITY_BASE = 30;
/** Share of any stockpile a civ will offer to the caravans in one year. */
export const TRADABLE_SHARE = 0.25;
/** Exchange below this value is not worth the walk. */
export const MIN_TRADE_VALUE = 1;

/** Barter value of one unit of each good. */
export const TRADE_VALUES: Record<StoreKey, number> = {
  food: 1,
  wood: 1.2,
  stone: 1.2,
  copper: 4,
  tin: 6,
  iron: 4,
  coal: 2.5,
  tools: 6,
  cloth: 5,
  luxury: 10,
};

/** Stable good order for deterministic barter. */
const GOOD_ORDER: StoreKey[] = [
  "food",
  "wood",
  "stone",
  "copper",
  "tin",
  "iron",
  "coal",
  "tools",
  "cloth",
  "luxury",
];

/** A trading pair swears a pact once the route has run this long and both
 * sides think this well of each other; an agent's offer can shortcut it. */
export const TREATY_TRADE_YEARS = 40;
export const TREATY_OPINION_MIN = 20;

/** Yearly chance an era-0 capability leaks along an active trade route /
 * through mere contact, halved per era — rarefied craft travels poorly. */
export const DIFFUSION_TRADE_RATE = 0.05;
export const DIFFUSION_CONTACT_RATE = 0.012;
export const DIFFUSION_ERA_DECAY = 0.5;

/** Noise of a belief snapshot by channel: a first meeting is half guesswork,
 * traders' gossip is better, spies best of all. */
export const BELIEF_CONTACT_NOISE = 0.5;
export const BELIEF_TRADE_NOISE = 0.25;
export const BELIEF_SPY_NOISE = 0.05;
/** How often traders' gossip refreshes a belief, in years. */
export const BELIEF_TRADE_INTERVAL = 5;

/** Espionage: success is a roll of agency against counter-intelligence. */
export const SPY_SUCCESS_BASE = 0.5;
export const SPY_SUCCESS_SLOPE = 0.08;
export const SPY_SUCCESS_MIN = 0.15;
export const SPY_SUCCESS_MAX = 0.85;
/** Detection chance, by outcome, shifted by the same score gap. */
export const SPY_DETECT_ON_SUCCESS = 0.15;
export const SPY_DETECT_ON_FAIL = 0.5;
export const SPY_DETECT_SLOPE = 0.05;
export const SPY_DETECT_MIN = 0.05;
export const SPY_DETECT_MAX = 0.9;

/** Engine-relayed messages: kept short and few. Bounded state, not a channel. */
export const MESSAGE_MAX_LENGTH = 240;
export const INBOX_MAX = 5;

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface DiplomacyReport {
  /** Pairs that met for the first time this year, lower id first. */
  contacts: [number, number][];
  /** Trade routes opened / lapsed this year. */
  tradeOpened: [number, number][];
  tradeClosed: [number, number][];
  /** Treaties sworn this year. */
  treaties: [number, number][];
  /** Value bartered along each active route this year (each way). */
  trades: { a: number; b: number; value: number }[];
  /** Capabilities that leaked between civs this year. */
  diffused: { to: number; from: number; capability: string }[];
  /** Espionage operations resolved this year. */
  espionage: {
    civ: number;
    target: number;
    mission: EspionageOp["mission"];
    success: boolean;
    detected: boolean;
    stole?: string;
  }[];
}

/**
 * Advance diplomacy for the whole world by one year: detect new contacts,
 * refresh every relation's opinion from its memory, open and work trade
 * routes, swear treaties, leak ideas, and resolve standing espionage orders.
 * Mutates civs and the event log in place; returns a summary for tests and
 * the chronicle.
 */
export function stepDiplomacy(world: World): DiplomacyReport {
  const report: DiplomacyReport = {
    contacts: [],
    tradeOpened: [],
    tradeClosed: [],
    treaties: [],
    trades: [],
    diffused: [],
    espionage: [],
  };

  detectContacts(world, report);
  pruneEspionage(world);

  // The research gates scan the whole grid, so compute them at most once per
  // civ per year — and drop a civ's entry when it adopts something, so the
  // prerequisite-closed invariant is judged against fresh state.
  const gatesCache = new Map<number, GateView>();
  const gates: GateAccess = {
    of: (id: number) => {
      let g = gatesCache.get(id);
      if (!g) {
        g = researchGates(world, id);
        gatesCache.set(id, g);
      }
      return g;
    },
    invalidate: (id: number) => {
      gatesCache.delete(id);
    },
  };

  const alive = world.civs.filter((c) => c.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const lo = alive[i].id < alive[j].id ? alive[i] : alive[j];
      const hi = alive[i].id < alive[j].id ? alive[j] : alive[i];
      if (!lo.known.includes(hi.id)) continue;
      const rng = new Rng(hashSeed("diplo", lo.id, hi.id, world.year));
      stepPair(world, lo, hi, rng, gates, report);
    }
  }
  return report;
}

type GateView = ReturnType<typeof researchGates>;
interface GateAccess {
  of: (civId: number) => GateView;
  invalidate: (civId: number) => void;
}

/**
 * The opinion a relation's memory adds up to in `year`: familiarity, treaty,
 * trade and war, minus every grievance at its decayed weight. Pure.
 */
export function effectiveOpinion(rel: Relation, year: number): number {
  let o = Math.min(FAMILIARITY_CAP, Math.max(0, year - rel.contactYear) * FAMILIARITY_RATE);
  if (rel.treaty) o += TREATY_OPINION;
  if (rel.tradeSince !== undefined && rel.tradeSince !== null) {
    o +=
      TRADE_OPINION_BASE +
      Math.min(TRADE_OPINION_CAP, Math.max(0, year - rel.tradeSince) * TRADE_OPINION_RATE);
  }
  if (rel.atWar) o += WAR_OPINION;
  for (const g of rel.grievances) o -= grievanceSting(g, year);
  return clamp(-100, 100, Math.round(o));
}

/** A grievance's present cost in opinion points — decayed, never erased early. */
export function grievanceSting(
  g: { year: number; weight: number },
  year: number,
): number {
  return (
    GRIEVANCE_OPINION_SCALE * g.weight * 0.5 ** (Math.max(0, year - g.year) / GRIEVANCE_HALF_LIFE)
  );
}

/**
 * Record a wrong done to `aggrieved` by `offender` — the single write path
 * into a relation's memory, used by treaty breaks and spy catches here and by
 * war later. Refreshes the aggrieved side's opinion immediately.
 */
export function addGrievance(
  world: World,
  aggrievedId: number,
  offenderId: number,
  note: string,
  weight: number,
): void {
  const aggrieved = world.civs[aggrievedId];
  const rel = aggrieved?.relations[offenderId];
  if (!rel) return;
  rel.grievances.push({ year: world.year, note, weight });
  rel.opinion = effectiveOpinion(rel, world.year);
}

/**
 * Establish first contact between two civs: both learn the other exists, both
 * open a relation, both form a first (noisy) belief, and one `contact` event
 * is emitted. Returns the event, or null when they had already met.
 */
export function establishContact(
  world: World,
  aId: number,
  bId: number,
  cell: number | null = null,
): WorldEvent | null {
  const a = world.civs[aId];
  const b = world.civs[bId];
  if (!a || !b || aId === bId || a.known.includes(bId)) return null;

  a.known.push(bId);
  b.known.push(aId);
  a.relations[bId] = newRelation(world.year);
  b.relations[aId] = newRelation(world.year);

  const lo = Math.min(aId, bId);
  const hi = Math.max(aId, bId);
  const event = emit(world, {
    kind: "contact",
    civ: lo,
    cell,
    fields: { civ: world.civs[lo].name, other: world.civs[hi].name },
  });
  a.relations[bId].contactEvent = event.id;
  b.relations[aId].contactEvent = event.id;

  // First impressions: each sizes the other up, badly. Its own seeded stream
  // so the pair's regular yearly stream is not consumed out of turn.
  const rng = new Rng(hashSeed("diplo", lo, hi, world.year, "meet"));
  captureBelief(world, world.civs[lo], world.civs[hi], BELIEF_CONTACT_NOISE, rng);
  captureBelief(world, world.civs[hi], world.civs[lo], BELIEF_CONTACT_NOISE, rng);
  return event;
}

/**
 * Tear up the treaty between `breaker` and `other`. The wronged side records a
 * heavy grievance ({@link TREATY_BREAK_WEIGHT}) that outlasts generations.
 * Returns false when there was no treaty to break.
 */
export function breakTreaty(
  world: World,
  breakerId: number,
  otherId: number,
  note = "broke the pact sworn between us",
): boolean {
  const breaker = world.civs[breakerId];
  const other = world.civs[otherId];
  const ra = breaker?.relations[otherId];
  const rb = other?.relations[breakerId];
  if (!ra || !rb || (!ra.treaty && !rb.treaty)) return false;

  ra.treaty = null;
  rb.treaty = null;
  ra.treatySince = undefined;
  rb.treatySince = undefined;
  ra.treatyOffer = null;
  rb.treatyOffer = null;

  addGrievance(world, otherId, breakerId, note, TREATY_BREAK_WEIGHT);
  ra.opinion = effectiveOpinion(ra, world.year);
  emit(world, {
    kind: "peace",
    civ: breakerId,
    magnitude: 1,
    text: `${breaker.name} broke its pact with ${other.name}.`,
    causedBy: rb.contactEvent !== undefined ? [rb.contactEvent] : [],
  });
  return true;
}

/** Record a standing treaty offer from one civ to another it has met. The
 * engine weighs it on the next diplomacy step. */
export function offerTreaty(world: World, fromId: number, toId: number): boolean {
  const rel = world.civs[fromId]?.relations[toId];
  if (!rel || rel.treaty) return false;
  rel.treatyOffer = world.year;
  return true;
}

/**
 * Relay a message from one civ to another — the ONLY channel minds have to
 * speak to each other, and it runs through the engine: contact required, text
 * bounded, inbox capped. Returns whether it was delivered.
 */
export function relayMessage(
  world: World,
  fromId: number,
  toId: number,
  text: string,
): boolean {
  const from = world.civs[fromId];
  const to = world.civs[toId];
  if (!from || !to || !from.known.includes(toId)) return false;
  const rel = to.relations[fromId];
  if (!rel) return false;
  if (!rel.inbox) rel.inbox = [];
  const inbox = rel.inbox;
  inbox.push({ year: world.year, text: text.slice(0, MESSAGE_MAX_LENGTH) });
  if (inbox.length > INBOX_MAX) inbox.splice(0, inbox.length - INBOX_MAX);
  return true;
}

/** Queue an espionage order on a civ; the tick's diplomacy stage resolves it
 * in a later year. The agent proposes, the engine disposes. */
export function orderEspionage(civ: Civ, op: EspionageOp): void {
  if (!civ.espionage) civ.espionage = [];
  civ.espionage.push(op);
}

/* ------------------------------------------------------------------ *
 * Contact detection — territories drifting within reach
 * ------------------------------------------------------------------ */

const pairKey = (a: number, b: number) => Math.min(a, b) * 1024 + Math.max(a, b);

/**
 * Scan for unmet pairs whose territories have come within contact range. One
 * pass over owned cells with a local window, verified in real kilometres —
 * and skipped entirely once every living pair has met, which is where long
 * runs spend almost all their years.
 */
function detectContacts(world: World, report: DiplomacyReport): void {
  const alive = world.civs.filter((c) => c.alive);
  const unmet = new Set<number>();
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      if (!alive[i].known.includes(alive[j].id)) unmet.add(pairKey(alive[i].id, alive[j].id));
    }
  }
  if (unmet.size === 0) return;

  const range = new Map<number, number>();
  let maxKm = 0;
  for (const c of alive) {
    const km = c.capabilities.includes("sailing") ? SAIL_CONTACT_RANGE_KM : CONTACT_RANGE_KM;
    range.set(c.id, km);
    if (km > maxKm) maxKm = km;
  }
  // Window in cells, sized so mid-latitude east–west shrink cannot hide a
  // pair; the km check below is the real gate.
  const R = Math.ceil(maxKm / 78);

  const owner = world.grid.owner;
  const met = new Map<number, number>(); // pairKey -> meeting cell
  for (let i = 0; i < owner.length; i++) {
    const a = owner[i];
    if (a < 0 || !world.civs[a]?.alive) continue;
    const x = cellX(i);
    const y = cellY(i);
    for (let dy = -R; dy <= R; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= GRID_H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const nx = (((x + dx) % GRID_W) + GRID_W) % GRID_W;
        const j = cellIndex(nx, ny);
        const b = owner[j];
        if (b < 0 || b === a) continue;
        const key = pairKey(a, b);
        if (!unmet.has(key) || met.has(key)) continue;
        const reach = Math.max(range.get(a) ?? 0, range.get(b) ?? 0);
        if (cellDistance(i, j) <= reach) met.set(key, i);
      }
    }
  }

  for (const [key, cell] of [...met.entries()].sort((p, q) => p[0] - q[0])) {
    const lo = Math.floor(key / 1024);
    const hi = key % 1024;
    if (establishContact(world, lo, hi, cell)) report.contacts.push([lo, hi]);
  }

  detectExpeditions(world, alive, report);
}

/**
 * The long-range channel: a people that can navigate mounts expeditions from
 * its ports and, sooner rather than later, finds any unmet people whose shore
 * lies within {@link NAVIGATION_CONTACT_RANGE_KM}. Its own seeded stream per
 * pair-year, so it neither disturbs nor depends on the pair's dealings.
 */
function detectExpeditions(world: World, alive: Civ[], report: DiplomacyReport): void {
  const shores = new Map<number, number[]>(); // civ id -> coastal owned cells
  const shoresOf = (id: number): number[] => {
    let cells = shores.get(id);
    if (!cells) {
      cells = [];
      const { owner, coast } = world.grid;
      for (let i = 0; i < owner.length; i++) {
        if (owner[i] === id && coast[i] === 1) cells.push(i);
      }
      shores.set(id, cells);
    }
    return cells;
  };
  const ports = (civ: Civ): number[] =>
    world.settlements
      .filter((s) => s.civ === civ.id && world.grid.coast[s.cell] === 1)
      .map((s) => s.cell);

  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const lo = alive[i].id < alive[j].id ? alive[i] : alive[j];
      const hi = alive[i].id < alive[j].id ? alive[j] : alive[i];
      if (lo.known.includes(hi.id)) continue;
      const rng = new Rng(hashSeed("diplo", lo.id, hi.id, world.year, "expedition"));
      for (const [nav, other] of [
        [lo, hi],
        [hi, lo],
      ] as const) {
        if (!nav.capabilities.includes("navigation")) continue;
        const landing = nearestLanding(ports(nav), shoresOf(other.id));
        if (landing === null) continue;
        if (!rng.chance(EXPEDITION_CHANCE)) continue;
        if (establishContact(world, lo.id, hi.id, landing)) {
          report.contacts.push([lo.id, hi.id]);
        }
        break; // the pair has met; the other direction has nothing to add
      }
    }
  }
}

/** The other people's nearest reachable shore cell, or null when every shore
 *  is beyond expedition range (or someone has no ports / no coast at all). */
function nearestLanding(ports: number[], shore: number[]): number | null {
  let best: number | null = null;
  let bestKm = NAVIGATION_CONTACT_RANGE_KM;
  for (const p of ports) {
    for (const s of shore) {
      const d = cellDistance(p, s);
      if (d <= bestKm) {
        bestKm = d;
        best = s;
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * One pair, one year — fixed op order so the seeded stream replays
 * ------------------------------------------------------------------ */

function stepPair(
  world: World,
  lo: Civ,
  hi: Civ,
  rng: Rng,
  gates: GateAccess,
  report: DiplomacyReport,
): void {
  if (!lo.relations[hi.id]) lo.relations[hi.id] = newRelation(world.year);
  if (!hi.relations[lo.id]) hi.relations[lo.id] = newRelation(world.year);
  const rl = lo.relations[hi.id];
  const rh = hi.relations[lo.id];

  // 1. Memory becomes opinion — prune what is finally forgotten, then refresh.
  refreshOpinion(rl, world.year);
  refreshOpinion(rh, world.year);

  const atWar = rl.atWar || rh.atWar;

  // 2. Treaties — an offer met with goodwill, or a long partnership ripening.
  updateTreaty(world, lo, hi, rl, rh, atWar, report);

  // 3. Trade routes open and lapse.
  updateTradeRoute(world, lo, hi, rl, rh, atWar, report);

  // 4. Caravans move real goods.
  if (rl.tradeSince !== undefined && rl.tradeSince !== null) {
    exchangeGoods(world, lo, hi, report);
  }

  // 5. Ideas leak — along the route if there is one, more faintly by contact.
  if (!atWar) {
    diffuseKnowledge(world, lo, hi, rl, rng, gates, report);
    diffuseKnowledge(world, hi, lo, rh, rng, gates, report);
  }

  // 6. Standing espionage orders resolve.
  resolveEspionage(world, lo, hi, rng, gates, report);
  resolveEspionage(world, hi, lo, rng, gates, report);

  // 7. Traders' gossip keeps beliefs roughly current; isolation lets them rot.
  if (rl.tradeSince !== undefined && rl.tradeSince !== null) {
    refreshTradeBelief(world, lo, hi, rl, rng);
    refreshTradeBelief(world, hi, lo, rh, rng);
  }
}

function newRelation(year: number): Relation {
  return {
    opinion: 0,
    atWar: false,
    treaty: null,
    grievances: [],
    contactYear: year,
  };
}

function refreshOpinion(rel: Relation, year: number): void {
  rel.grievances = rel.grievances.filter(
    (g) => grievanceSting(g, year) >= GRIEVANCE_FORGOTTEN_BELOW,
  );
  rel.opinion = effectiveOpinion(rel, year);
}

/* ------------------------------------------------------------------ *
 * Treaties
 * ------------------------------------------------------------------ */

function updateTreaty(
  world: World,
  lo: Civ,
  hi: Civ,
  rl: Relation,
  rh: Relation,
  atWar: boolean,
  report: DiplomacyReport,
): void {
  if (atWar || rl.treaty || rh.treaty) return;

  const tradeYears =
    rl.tradeSince !== undefined && rl.tradeSince !== null
      ? world.year - rl.tradeSince
      : 0;
  const ripened =
    tradeYears >= TREATY_TRADE_YEARS &&
    rl.opinion >= TREATY_OPINION_MIN &&
    rh.opinion >= TREATY_OPINION_MIN;
  // An offer is accepted when it is mutual, or the counterpart is warm enough.
  const offered =
    (rl.treatyOffer !== undefined && rl.treatyOffer !== null && rh.opinion >= TREATY_OPINION_MIN) ||
    (rh.treatyOffer !== undefined && rh.treatyOffer !== null && rl.opinion >= TREATY_OPINION_MIN) ||
    (rl.treatyOffer !== undefined &&
      rl.treatyOffer !== null &&
      rh.treatyOffer !== undefined &&
      rh.treatyOffer !== null);

  if (!ripened && !offered) return;

  const name = "pact of peace and trade";
  rl.treaty = name;
  rh.treaty = name;
  rl.treatySince = world.year;
  rh.treatySince = world.year;
  rl.treatyOffer = null;
  rh.treatyOffer = null;
  refreshOpinion(rl, world.year);
  refreshOpinion(rh, world.year);
  emit(world, {
    kind: "peace",
    civ: lo.id,
    magnitude: 0.5,
    text: `${lo.name} and ${hi.name} swore a ${name}.`,
    causedBy: rl.tradeEvent !== undefined ? [rl.tradeEvent] : [],
  });
  report.treaties.push([lo.id, hi.id]);
}

/* ------------------------------------------------------------------ *
 * Trade — routes, then real goods out of one store into another
 * ------------------------------------------------------------------ */

function updateTradeRoute(
  world: World,
  lo: Civ,
  hi: Civ,
  rl: Relation,
  rh: Relation,
  atWar: boolean,
  report: DiplomacyReport,
): void {
  const active = rl.tradeSince !== undefined && rl.tradeSince !== null;
  if (!active) {
    if (
      !atWar &&
      rl.opinion >= TRADE_OPEN_MIN_OPINION &&
      rh.opinion >= TRADE_OPEN_MIN_OPINION &&
      world.year - rl.contactYear >= TRADE_OPEN_CONTACT_YEARS
    ) {
      rl.tradeSince = world.year;
      rh.tradeSince = world.year;
      const event = emit(world, {
        kind: "trade",
        civ: lo.id,
        fields: { civ: lo.name, other: hi.name },
        causedBy: rl.contactEvent !== undefined ? [rl.contactEvent] : [],
      });
      rl.tradeEvent = event.id;
      rh.tradeEvent = event.id;
      report.tradeOpened.push([lo.id, hi.id]);
    }
    return;
  }
  if (atWar || rl.opinion < TRADE_CLOSE_OPINION || rh.opinion < TRADE_CLOSE_OPINION) {
    rl.tradeSince = null;
    rh.tradeSince = null;
    emit(world, {
      kind: "trade",
      civ: lo.id,
      magnitude: 0.15,
      text: `The caravans between ${lo.name} and ${hi.name} stopped coming.`,
    });
    report.tradeClosed.push([lo.id, hi.id]);
  }
}

/** How much a civ's infrastructure multiplies a route's carrying capacity. */
function routeFactor(civ: Civ): number {
  const held = new Set(civ.capabilities);
  let f = 1;
  if (held.has("wheel")) f += 0.2;
  if (held.has("roads")) f += 0.4;
  if (held.has("sailing")) f += 0.4;
  if (held.has("navigation")) f += 0.3;
  if (held.has("currency")) f += 0.5;
  return f;
}

/**
 * One year of barter along an active route. Each side offers a share of the
 * goods it holds in real per-head abundance over the other, and equal value
 * moves each way — no credit, no money the world doesn't have. Goods actually
 * leave one civ's `Stores` and land in the other's.
 */
function exchangeGoods(world: World, a: Civ, b: Civ, report: DiplomacyReport): void {
  const capacity = (TRADE_CAPACITY_BASE * (routeFactor(a) + routeFactor(b))) / 2;
  const popA = Math.max(1, civPopulation(world, a.id));
  const popB = Math.max(1, civPopulation(world, b.id));

  const wantsFromA = goodsWanted(a, popA, b, popB);
  const wantsFromB = goodsWanted(b, popB, a, popA);
  const value = Math.min(
    capacity,
    offerableValue(a, wantsFromA),
    offerableValue(b, wantsFromB),
  );
  if (value < MIN_TRADE_VALUE) return;

  moveGoods(a, b, wantsFromA, value);
  moveGoods(b, a, wantsFromB, value);
  report.trades.push({ a: a.id, b: b.id, value });
}

/** The goods `buyer` would take from `seller`: what the seller holds in clear
 * per-head abundance over the buyer. Stable order. */
function goodsWanted(seller: Civ, sellerPop: number, buyer: Civ, buyerPop: number): StoreKey[] {
  const out: StoreKey[] = [];
  for (const g of GOOD_ORDER) {
    const s = seller.stores[g] / sellerPop;
    const b = buyer.stores[g] / buyerPop;
    if (seller.stores[g] > 0 && s > 2 * b + 1e-9) out.push(g);
  }
  return out;
}

function offerableValue(civ: Civ, goods: StoreKey[]): number {
  let v = 0;
  for (const g of goods) v += TRADE_VALUES[g] * civ.stores[g] * TRADABLE_SHARE;
  return v;
}

/** Move `value` worth of `goods` from one store to the other, in stable order. */
function moveGoods(from: Civ, to: Civ, goods: StoreKey[], value: number): void {
  let remaining = value;
  for (const g of goods) {
    if (remaining <= 0) break;
    const sendable = from.stores[g] * TRADABLE_SHARE;
    const amount = Math.min(sendable, remaining / TRADE_VALUES[g]);
    if (amount <= 0) continue;
    from.stores[g] -= amount;
    to.stores[g] += amount;
    remaining -= amount * TRADE_VALUES[g];
  }
}

/* ------------------------------------------------------------------ *
 * Diffusion — ideas leak, but only through the possibility gates
 * ------------------------------------------------------------------ */

/**
 * One direction of leak for one year: a capability `from` holds may dawn on
 * `to` — but only one that `to` could research right now, the same gate
 * check research itself uses. No reachable iron still means no ironworking,
 * however rich the neighbour.
 */
function diffuseKnowledge(
  world: World,
  from: Civ,
  to: Civ,
  relToward: Relation,
  rng: Rng,
  gates: GateAccess,
  report: DiplomacyReport,
): void {
  const g = gates.of(to.id);
  const candidates = researchable(g.held, g.hasMaterial, g.hasTerrain, g.population)
    .filter((c) => from.capabilities.includes(c.id))
    .sort((a, b) => a.era - b.era || (a.id < b.id ? -1 : 1));
  if (candidates.length === 0) return;

  const trading = relToward.tradeSince !== undefined && relToward.tradeSince !== null;
  const rate = trading ? DIFFUSION_TRADE_RATE : DIFFUSION_CONTACT_RATE;
  for (const cap of candidates) {
    if (!rng.chance(rate * DIFFUSION_ERA_DECAY ** cap.era)) continue;
    if (adoptCapability(world, to, cap.id, `from ${from.name}`)) {
      gates.invalidate(to.id);
      report.diffused.push({ to: to.id, from: from.id, capability: cap.id });
    }
    break; // at most one idea takes root per neighbour per year
  }
}

/* ------------------------------------------------------------------ *
 * Espionage — ordered by a mind, resolved by the world
 * ------------------------------------------------------------------ */

/** Drop orders against the dead or the never-met so they cannot linger. */
function pruneEspionage(world: World): void {
  for (const civ of world.civs) {
    if (!civ.espionage || civ.espionage.length === 0) continue;
    civ.espionage = civ.espionage.filter(
      (op) => world.civs[op.target]?.alive && civ.known.includes(op.target),
    );
  }
}

/** Rough era of a civ — its most advanced capability. */
function civEraOf(civ: Civ): number {
  let era = 0;
  for (const id of civ.capabilities) {
    const cap = CAPABILITY_BY_ID.get(id);
    if (cap && cap.era > era) era = cap.era;
  }
  return era;
}

/** What a civ's spies can do: sophistication plus organised, literate rule. */
function agencyScore(civ: Civ): number {
  let s = civEraOf(civ) + 2 * civ.government.centralization;
  if (civ.capabilities.includes("writing")) s += 1;
  if (civ.capabilities.includes("currency")) s += 0.5;
  return s;
}

/** What its counter-intelligence can catch. */
function counterIntelScore(civ: Civ): number {
  let s = civEraOf(civ) + 2 * civ.government.centralization;
  if (civ.capabilities.includes("writing")) s += 0.5;
  return s;
}

function resolveEspionage(
  world: World,
  spy: Civ,
  target: Civ,
  rng: Rng,
  gates: GateAccess,
  report: DiplomacyReport,
): void {
  const queue = spy.espionage;
  if (!queue || queue.length === 0) return;
  const ops = queue.filter((op) => op.target === target.id);
  if (ops.length === 0) return;
  spy.espionage = queue.filter((op) => op.target !== target.id);

  const gap = agencyScore(spy) - counterIntelScore(target);
  for (const op of ops) {
    const pSuccess = clamp(
      SPY_SUCCESS_MIN,
      SPY_SUCCESS_MAX,
      SPY_SUCCESS_BASE + SPY_SUCCESS_SLOPE * gap,
    );
    const success = rng.chance(pSuccess);
    let stole: string | undefined;

    if (success) {
      if (op.mission === "steal") {
        stole = stealCapability(world, spy, target, op.capability, gates);
        // Spies who found nothing to carry home at least bring an assessment.
        if (!stole) captureBelief(world, spy, target, BELIEF_SPY_NOISE, rng);
      } else {
        captureBelief(world, spy, target, BELIEF_SPY_NOISE, rng);
      }
    }

    const pDetect = clamp(
      SPY_DETECT_MIN,
      SPY_DETECT_MAX,
      (success ? SPY_DETECT_ON_SUCCESS : SPY_DETECT_ON_FAIL) - SPY_DETECT_SLOPE * gap,
    );
    const detected = rng.chance(pDetect);
    if (detected) {
      addGrievance(world, target.id, spy.id, "sent spies among us", SPY_CAUGHT_WEIGHT);
      emit(world, {
        kind: "decision",
        civ: target.id,
        magnitude: 0.8,
        text: `${target.name} caught spies sent by ${spy.name}.`,
      });
    }

    report.espionage.push({
      civ: spy.id,
      target: target.id,
      mission: op.mission,
      success,
      detected,
      stole,
    });
  }
}

/** Carry a capability home from a raid on another civ's knowledge — gated
 * exactly like diffusion. Returns the capability id, or undefined. */
function stealCapability(
  world: World,
  spy: Civ,
  target: Civ,
  wanted: string | undefined,
  gates: GateAccess,
): string | undefined {
  const g = gates.of(spy.id);
  const stealable = researchable(g.held, g.hasMaterial, g.hasTerrain, g.population).filter(
    (c) => target.capabilities.includes(c.id),
  );
  if (stealable.length === 0) return undefined;
  let cap: Capability | undefined = wanted
    ? stealable.find((c) => c.id === wanted)
    : undefined;
  if (!cap) {
    // Uninstructed spies go for the most advanced thing they can carry.
    cap = stealable.reduce((best, c) =>
      c.era > best.era || (c.era === best.era && c.id < best.id) ? c : best,
    );
  }
  if (!adoptCapability(world, spy, cap.id, `from spies sent among ${target.name}`)) {
    return undefined;
  }
  gates.invalidate(spy.id);
  return cap.id;
}

/* ------------------------------------------------------------------ *
 * Beliefs — noisy snapshots of another people, never the truth
 * ------------------------------------------------------------------ */

function captureBelief(
  world: World,
  observer: Civ,
  subject: Civ,
  noise: number,
  rng: Rng,
): void {
  const rel = observer.relations[subject.id];
  if (!rel) return;
  const wobble = () => 1 + noise * rng.range(-1, 1);
  const eraSlip = noise >= 0.4 ? rng.int(-1, 1) : 0;
  rel.belief = {
    population: Math.max(0, Math.round(civPopulation(world, subject.id) * wobble())),
    era: Math.max(0, civEraOf(subject) + eraSlip),
    military: Math.max(0, Math.round(subject.military.troops * wobble())),
    asOf: world.year,
  };
}

function refreshTradeBelief(
  world: World,
  observer: Civ,
  subject: Civ,
  rel: Relation,
  rng: Rng,
): void {
  const asOf = rel.belief?.asOf ?? Number.NEGATIVE_INFINITY;
  if (world.year - asOf < BELIEF_TRADE_INTERVAL) return;
  captureBelief(world, observer, subject, BELIEF_TRADE_NOISE, rng);
}
