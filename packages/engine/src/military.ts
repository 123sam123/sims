/**
 * War: armies, logistics, battle and consequences.
 *
 * An army here is never an abstraction. It is working-age population that
 * stopped farming (production subtracts every soldier from the labour force),
 * carrying equipment that had to be manufactured from felled, quarried and
 * mined goods the civilisation actually held, fed out of the granary while it
 * stays within reach of friendly land and out of its ration carts beyond it,
 * moving at a pace the terrain sets. A civilisation without ironworking cannot
 * arm in iron however much it wishes; one without sailing cannot carry a war
 * across the sea at all.
 *
 * Three commitments shape the module:
 *
 * - **No unit without its supply chain.** Muster is capped by people,
 *   equipment by capability AND stock, campaigns by food. An army beyond
 *   supply range starves before it fights — which is how most armies have
 *   always died.
 *
 * - **Combat is attritional and legible.** A year of war resolves as a
 *   casualty exchange proportional to relative strength — troops × equipment
 *   quality × morale, shaped by terrain, fortification and the commander — so
 *   a reader can always say *why* a battle went the way it did. There is no
 *   single dice roll that hands a stone-age band victory over a steel army.
 *
 * - **The engine does not moralise.** Settlements are sacked and their people
 *   subjugated; the engine models the price — the dead, the refugees, the
 *   grievance that outlives everyone who fought — and never blocks the choice.
 *
 * Wars begin two ways: the engine itself lights one when hostility (a deeply
 * negative opinion, i.e. an unforgotten ledger of grievances) meets believed
 * advantage — beliefs, not truth, so a civ can start a war it was wrong about
 * — and the agent layer may call `declareWar` directly. Both run through
 * diplomacy's relation bookkeeping, so war and peace are remembered exactly
 * like every other dealing, and every battle points back at its declaration.
 *
 * Determinism: pair-level draws come from `hashSeed("war", lo, hi, year)` with
 * the pair in stable id order (sub-streams add a tag: "declare", "battle",
 * "peace"); per-civ draws use `hashSeed("war", civId, year, tag)`. Armies are
 * visited in stable (civ, army id) order. Event kinds are reused: declarations
 * emit `war`, fighting emits `battle`, endings emit `peace`, refugee flight
 * emits `settlement`, and commanders live and die as `person` events.
 */

import { declareWar, makePeace, addGrievance } from "./diplomacy.ts";
import { emit } from "./events.ts";
import { workingAgePopulation } from "./production.ts";
import { Rng, hashSeed } from "./rng.ts";
import { sackSettlement } from "./settlement.ts";
import {
  type Army,
  BIOMES,
  type Civ,
  type Commander,
  type Grid,
  GRID_H,
  GRID_W,
  type Person,
  type Settlement,
  type StoreKey,
  type World,
  cellDistance,
  cellIndex,
  cellX,
  cellY,
  neighbors,
  refreshCohorts,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * Tunables — every arguable number, named.
 * ------------------------------------------------------------------ */

/* --- Muster: soldiers are people who stopped producing ------------- */

/** Share of the working-age population under arms at full military effort
 * (policy.military = 1). Total war, and it guts production accordingly. */
export const MOBILISATION_SCALE = 0.3;
/** Without organised warfare a people fields warbands, not armies: the share
 * of the workforce that can be under arms is capped here. */
export const WARBAND_CAP = 0.02;
/** Fraction of the shortfall to the muster target raised per year — an army
 * takes years to raise, not a decree. */
export const MUSTER_RATE = 0.25;
/** Fraction of any excess over the target sent home per year. */
export const DISBAND_RATE = 0.5;

/* --- Equipment: capability sets the ceiling, stores pay the bill ---- */

/** Quality of a full stone-age weapon set (spears, axes, hide shields). */
export const EQUIP_TIER_STONE = 1;
/** Bows lift a stone-age kit a little. */
export const EQUIP_TIER_BOW_BONUS = 0.2;
export const EQUIP_TIER_BRONZE = 2;
export const EQUIP_TIER_IRON = 2.8;
export const EQUIP_TIER_STEEL = 3.6;
/** Share of the arsenal shortfall the smiths close per year. */
export const EQUIP_RATE = 0.25;
/** Yearly rust, rot and breakage of the arsenal. */
export const EQUIP_DECAY = 0.03;
/** Share of a fallen soldier's kit lost with them. */
export const EQUIPMENT_LOSS_SHARE = 0.8;

/* --- Fielding and movement ----------------------------------------- */

/** Fewer troops than this is not an army worth marching. */
export const MIN_ARMY = 50;
/** Share of the home reserve an army takes to the field. */
export const FIELD_SHARE = 0.65;
/** Rations loaded at departure, in years of food per soldier — drawn from the
 * granary, so a campaign is paid for before it starts. */
export const SUPPLY_CARRY_YEARS = 1.5;
/** Campaign marching over easy ground, km per year. */
export const MARCH_KM_PER_YEAR = 900;
/** Under sail, the sea is a road. */
export const SEA_KM_PER_YEAR = 2600;
export const ROADS_MARCH_MULT = 1.3;
export const CAVALRY_MARCH_MULT = 1.4;

/* --- Supply: the constraint that matters --------------------------- */

/** How far from friendly-held land the granary can feed an army. */
export const SUPPLY_RANGE_KM = 700;
export const ROADS_SUPPLY_MULT = 1.5;
/** Food one soldier on campaign eats in a year, out of `stores.food`. */
export const SOLDIER_RATION = 1;
/** Troops lost per fully unsupplied year — hunger, sickness, desertion. */
export const ATTRITION_RATE = 0.18;
/** Morale lost per fully unsupplied year. */
export const ATTRITION_MORALE = 0.15;

/* --- Battle -------------------------------------------------------- */

/** An army this close to an enemy settlement assaults it. */
export const ENGAGE_RANGE_KM = 140;
/** Opposing armies this close seek each other out and fight. */
export const INTERCEPT_RANGE_KM = 260;
/** Overall lethality of a year of fighting: an evenly matched side loses
 * about half this share of its force per year. */
export const BATTLE_INTENSITY = 0.5;
/** No single year of battle destroys more than this share of a force. */
export const MAX_BATTLE_LOSS = 0.45;
/** Seeded fog of battle: casualty rolls swing by up to this share. */
export const BATTLE_NOISE = 0.2;
/** Strength multiplier is `MORALE_FLOOR + morale` — a broken-spirited army
 * fights at roughly half the strength of an ardent one. */
export const MORALE_FLOOR = 0.5;
/** Commander effect on strength: ×(0.85 + COMMANDER_SWING × skill). */
export const COMMANDER_SWING = 0.3;
/** Defender bonus from high ground, per unit of elevation at the site. */
export const TERRAIN_DEFENSE = 0.5;
/** Defender bonus from forest cover at the site. */
export const FOREST_DEFENSE = 0.2;
/** Defence multiplier for holding the `fortification` capability. */
export const FORTIFICATION_MULT = 1.35;
/** Further multiplier when the assaulted settlement has built walls. */
export const WALLS_MULT = 1.3;
/** Share of the fortification/terrain advantage an attacker with `siegecraft`
 * cancels — making it expensive anyway. */
export const SIEGECRAFT_OFFSET = 0.5;
/** Share of a threatened settlement's working-age people who take up what
 * they have to defend their homes. */
export const MILITIA_SHARE = 0.08;
/** Farm tools are not weapons. */
export const MILITIA_QUALITY = 0.4;
/** Army morale lost per share of it fallen this year. */
export const MORALE_LOSS_SCALE = 0.9;
/** National morale lost per share of a force fallen. */
export const NATION_MORALE_LOSS = 0.3;
/** Morale the winning side of a battle recovers. */
export const MORALE_VICTORY_GAIN = 0.05;
/** An army below this morale breaks and goes home. */
export const BREAK_MORALE = 0.25;
/** Chance the commander falls in a year of battle, × the army's loss share. */
export const COMMANDER_DEATH_CHANCE = 0.6;

/* --- Conquest ------------------------------------------------------ */

/** The attacker must outmatch the standing defence by this much, after the
 * year's fighting, to storm and hold the place. */
export const CONQUEST_RATIO = 1.8;
/** Enemy land within this range of a stormed settlement changes hands. */
export const OCCUPATION_RADIUS_KM = 240;
/** Grievance weight of being sacked and losing land — the one wars leave. */
export const CONQUEST_GRIEVANCE_WEIGHT = 0.6;

/* --- War and peace ------------------------------------------------- */

/** Engine-lit wars need hostility at least this deep (opinion at or below). */
export const WAR_OPINION_THRESHOLD = -30;
/** Yearly ignition chance at total hostility (opinion −100), scaled down
 * linearly with lesser grudges. */
export const WAR_BASE_CHANCE = 0.05;
/** Believed strength ratio a civ wants before daring a war. Beliefs, not
 * truth — a stale belief starts wars that should not have been. */
export const WAR_ADVANTAGE_REQUIRED = 1.25;
/** The engine's own ignition also waits for recovered war spirit: a nation
 * bled white does not march again the same decade (morale heals at
 * {@link MORALE_RECOVERY}/yr, so this spaces recurring border wars ~15 years
 * apart instead of three). An agent's declared war is never gated on this —
 * minds may choose foolish wars. */
export const WAR_MORALE_MIN = 0.5;
/** A nation whose war spirit falls below this sues for peace. */
export const PEACE_MORALE = 0.28;
/** A standing peace plea is accepted once the other side's war spirit has
 * sunk this low — tired enough to take the offered way out. */
export const PEACE_ACCEPT_MORALE = 0.5;
/** After this many years of war, exhaustion alone can end it... */
export const WAR_WEARY_YEARS = 8;
/** ...at this yearly chance. */
export const PEACE_WEARY_CHANCE = 0.25;
/** How fast national morale heals in peacetime, toward its baseline. */
export const MORALE_RECOVERY = 0.06;
export const MORALE_BASELINE = 0.7;

const clamp = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

export interface MilitaryReport {
  /** Wars the engine ignited this year. */
  wars: { attacker: number; defender: number }[];
  /** Battles fought this year — field meetings and assaults alike. */
  battles: {
    attacker: number;
    defender: number;
    cell: number;
    attackerLosses: number;
    defenderLosses: number;
    /** True when the defended settlement fell. */
    stormed: boolean;
  }[];
  /** Losses to hunger and distance, not fighting. */
  attrition: { civ: number; losses: number }[];
  /** Territory taken this year. */
  conquests: {
    winner: number;
    loser: number;
    cells: number;
    settlement: number | null;
    refugees: number;
  }[];
  /** Wars that ended this year, lower id first. */
  peaces: [number, number][];
}

/**
 * Advance war for the whole world by one year: ignite wars where hostility
 * meets believed advantage, muster and equip from what each civ actually has,
 * field and march armies, fight the battles they force, transfer occupied
 * land, and let exhaustion make peace. Mutates civs, settlements, the grid and
 * the event log in place; returns a summary for tests and the chronicle.
 */
export function stepMilitary(world: World): MilitaryReport {
  const report: MilitaryReport = {
    wars: [],
    battles: [],
    attrition: [],
    conquests: [],
    peaces: [],
  };

  pruneWars(world);
  igniteWars(world, report);

  const alive = world.civs.filter((c) => c.alive).sort((a, b) => a.id - b.id);
  for (const civ of alive) {
    muster(world, civ);
    forgeEquipment(civ);
  }
  for (const civ of alive) fieldArmies(world, civ, report);

  const anyArmies = alive.some((c) => armiesOf(c).length > 0);
  if (anyArmies) {
    for (const civ of alive) {
      for (const army of armiesOf(civ)) march(world, civ, army);
    }
    resolveBattles(world, alive, report);
    const owned = ownedCellsByCiv(world.grid);
    for (const civ of alive) {
      for (const army of armiesOf(civ)) {
        supplyArmy(world, civ, army, owned.get(civ.id) ?? [], report);
      }
    }
    cullArmies(world, alive);
  }

  resolvePeace(world, alive, report);

  // Peace heals; a nation at war does not recover its spirit.
  for (const civ of alive) {
    const atWar = Object.values(civ.relations).some((r) => r.atWar);
    if (!atWar) {
      civ.military.morale = clamp(
        0,
        1,
        civ.military.morale + MORALE_RECOVERY * (MORALE_BASELINE - civ.military.morale),
      );
    }
  }
  return report;
}

/** A civ's fielded armies, oldest first. Missing queue = none. */
export function armiesOf(civ: Civ): Army[] {
  return civ.military.armies ?? [];
}

/**
 * The best weapon set a civ knows how to make — the knowledge ceiling on
 * equipment quality. Holding steel with no iron in the stores still arms
 * nobody; see `forgeEquipment`.
 */
export function equipmentTier(civ: Civ): number {
  const held = new Set(civ.capabilities);
  let tier = EQUIP_TIER_STONE;
  if (held.has("bow")) tier += EQUIP_TIER_BOW_BONUS;
  if (held.has("bronze")) tier = Math.max(tier, EQUIP_TIER_BRONZE);
  if (held.has("iron_smelting")) tier = Math.max(tier, EQUIP_TIER_IRON);
  if (held.has("steel")) tier = Math.max(tier, EQUIP_TIER_STEEL);
  return tier;
}

/**
 * What a force is worth in the field. Every term is legible: heads, the
 * quality of what they carry, whether their heart is in it, and who leads.
 */
export function forceStrength(
  troops: number,
  quality: number,
  morale: number,
  commanderSkill = 0.5,
): number {
  if (troops <= 0) return 0;
  return (
    troops *
    (1 + Math.max(0, quality)) *
    (MORALE_FLOOR + clamp(0, 1, morale)) *
    (0.85 + COMMANDER_SWING * clamp(0, 1, commanderSkill))
  );
}

/* ------------------------------------------------------------------ *
 * War ignition and hygiene
 * ------------------------------------------------------------------ */

/** Clear wars against the dead and drop armies with no one left to fight. */
function pruneWars(world: World): void {
  for (const civ of world.civs) {
    if (!civ.alive) continue;
    for (const [idStr, rel] of Object.entries(civ.relations)) {
      const other = world.civs[Number(idStr)];
      if (rel.atWar && !other?.alive) {
        rel.atWar = false;
        rel.warSince = null;
      }
    }
    if (civ.military.armies) {
      civ.military.armies = civ.military.armies.filter((a) => {
        const enemy = world.civs[a.target];
        return enemy?.alive && (civ.relations[a.target]?.atWar ?? false);
      });
    }
  }
}

/**
 * The engine's own ignition: where an unforgotten ledger of grievances has
 * driven opinion deep below zero, and the aggrieved side *believes* itself
 * clearly stronger, war becomes possible. The belief may be stale or wrong —
 * that is how misjudged wars start.
 */
function igniteWars(world: World, report: MilitaryReport): void {
  const alive = world.civs.filter((c) => c.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const lo = alive[i].id < alive[j].id ? alive[i] : alive[j];
      const hi = alive[i].id < alive[j].id ? alive[j] : alive[i];
      if (!lo.known.includes(hi.id)) continue;
      const rl = lo.relations[hi.id];
      const rh = hi.relations[lo.id];
      if (!rl || !rh || rl.atWar || rh.atWar) continue;
      const rng = new Rng(hashSeed("war", lo.id, hi.id, world.year, "declare"));
      for (const [att, ra] of [
        [lo, rl],
        [hi, rh],
      ] as const) {
        const def = att === lo ? hi : lo;
        if (!att.capabilities.includes("military_org")) continue;
        // A standing pact restrains the engine; tearing it up is a mind's choice.
        if (ra.treaty) continue;
        if (ra.opinion > WAR_OPINION_THRESHOLD) continue;
        if (att.military.morale < WAR_MORALE_MIN) continue;
        if (att.military.troops < MIN_ARMY) continue;
        const believed = ra.belief?.military;
        if (believed === undefined) continue; // no estimate of them — no confidence
        if (att.military.troops < WAR_ADVANTAGE_REQUIRED * Math.max(1, believed)) continue;
        const hostility = Math.max(0, -ra.opinion);
        if (!rng.chance(WAR_BASE_CHANCE * (hostility / 100))) continue;
        if (declareWar(world, att.id, def.id)) {
          report.wars.push({ attacker: att.id, defender: def.id });
        }
        break; // one declaration per pair-year
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Muster and the arsenal
 * ------------------------------------------------------------------ */

/**
 * Raise or send home troops toward the civ's policy target. Soldiers are a
 * standing claim on the workforce (production subtracts them), so the target
 * is a share of working-age people — and never more soldiers than there are
 * people to be them.
 */
function muster(world: World, civ: Civ): void {
  const m = civ.military;
  const workforce = workingAgePopulation(world, civ.id);
  let share = clamp(0, 1, civ.policy.military) * MOBILISATION_SCALE;
  if (!civ.capabilities.includes("military_org")) share = Math.min(share, WARBAND_CAP);
  const target = share * workforce;

  const fielded = armiesOf(civ).reduce((sum, a) => sum + a.troops, 0);
  if (m.troops < target) {
    m.troops += (target - m.troops) * MUSTER_RATE;
  } else {
    // Only the home reserve can be sent back to the fields.
    const excess = m.troops - Math.max(target, fielded);
    if (excess > 0) m.troops -= excess * DISBAND_RATE;
  }
  m.troops = Math.min(m.troops, workforce);
  if (fielded > m.troops) {
    // Catastrophe at home shrank the people below the armies abroad: the
    // armies thin (desertion to family) rather than outnumber their nation.
    const scale = m.troops / fielded;
    for (const a of armiesOf(civ)) {
      a.troops *= scale;
      a.equipment *= scale;
    }
  }
}

/** Weapon-set recipes a civ can work, best first. Each set of quality `tier`
 * costs the listed goods — no metal in the stores, no metal kit, whatever the
 * smiths know. The stone recipe is always last: anyone can knap and haft. */
function equipmentRecipes(civ: Civ): { tier: number; cost: Partial<Record<StoreKey, number>> }[] {
  const held = new Set(civ.capabilities);
  const out: { tier: number; cost: Partial<Record<StoreKey, number>> }[] = [];
  if (held.has("steel")) {
    out.push({ tier: EQUIP_TIER_STEEL, cost: { wood: 0.25, iron: 0.3, coal: 0.12 } });
  }
  if (held.has("iron_smelting")) {
    out.push({ tier: EQUIP_TIER_IRON, cost: { wood: 0.25, iron: 0.3 } });
  }
  if (held.has("bronze")) {
    out.push({ tier: EQUIP_TIER_BRONZE, cost: { wood: 0.25, copper: 0.22, tin: 0.08 } });
  }
  const stone = EQUIP_TIER_STONE + (held.has("bow") ? EQUIP_TIER_BOW_BONUS : 0);
  out.push({ tier: stone, cost: { wood: 0.5, stone: 0.2 } });
  return out;
}

/**
 * One year at the forges: decay the arsenal, then close a share of the gap to
 * a fully equipped army — paying for every set out of real stores, falling
 * back to lesser recipes when the good materials run out. This is where both
 * gates bind: capability caps the tier, stores cap the count.
 */
function forgeEquipment(civ: Civ): number {
  const m = civ.military;
  m.equipment = Math.max(0, m.equipment * (1 - EQUIP_DECAY));
  const tier = equipmentTier(civ);
  const shortfall = m.troops * tier - m.equipment;
  if (shortfall <= 0) return 0;

  let points = shortfall * EQUIP_RATE;
  let added = 0;
  for (const recipe of equipmentRecipes(civ)) {
    if (points <= 1e-9) break;
    // A lesser recipe cannot fill the arsenal past its own ceiling: forging
    // stone kit twice over does not make a bronze-quality army.
    const ceiling = m.troops * recipe.tier - m.equipment;
    let sets = Math.min(points, Math.max(0, ceiling)) / recipe.tier;
    for (const good of Object.keys(recipe.cost) as StoreKey[]) {
      const per = recipe.cost[good] ?? 0;
      if (per > 0) sets = Math.min(sets, civ.stores[good] / per);
    }
    if (sets <= 0) continue;
    for (const good of Object.keys(recipe.cost) as StoreKey[]) {
      const per = recipe.cost[good] ?? 0;
      if (per > 0) civ.stores[good] = Math.max(0, civ.stores[good] - per * sets);
    }
    m.equipment += sets * recipe.tier;
    added += sets * recipe.tier;
    points -= sets * recipe.tier;
  }
  return added;
}

/* ------------------------------------------------------------------ *
 * Fielding — an army leaves home with everything it will have
 * ------------------------------------------------------------------ */

function fieldArmies(world: World, civ: Civ, _report: MilitaryReport): void {
  const m = civ.military;
  const enemies = Object.entries(civ.relations)
    .filter(([, r]) => r.atWar)
    .map(([id]) => Number(id))
    .filter((id) => world.civs[id]?.alive)
    .sort((a, b) => a - b);
  if (enemies.length === 0) return;

  const home = musterPoint(world, civ);
  if (home === null) return;

  for (const enemyId of enemies) {
    if (armiesOf(civ).some((a) => a.target === enemyId)) continue;
    const fielded = armiesOf(civ).reduce((sum, a) => sum + a.troops, 0);
    const reserve = m.troops - fielded;
    const size = reserve * FIELD_SHARE;
    if (size < MIN_ARMY) continue;
    const objective = nearestSettlementCell(world, enemyId, home);
    if (objective === null) continue;

    // The army strips the armoury of what it can carry and loads the carts
    // from the granary — a campaign is provisioned before it moves an inch.
    const armouryFree = Math.max(0, m.equipment - armiesOf(civ).reduce((s, a) => s + a.equipment, 0));
    const equipment = Math.min(size * equipmentTier(civ), armouryFree);
    const supplies = Math.min(size * SUPPLY_CARRY_YEARS, civ.stores.food * 0.5);
    civ.stores.food = Math.max(0, civ.stores.food - supplies);

    const rng = new Rng(hashSeed("war", civ.id, world.year, "commander", enemyId));
    const commander = appointCommander(world, civ, rng);

    if (!m.armies) m.armies = [];
    if (m.nextArmyId === undefined) m.nextArmyId = 0;
    const army: Army = {
      id: m.nextArmyId++,
      troops: size,
      equipment,
      morale: m.morale,
      cell: home,
      target: enemyId,
      objective,
      home,
      supplies,
      commander,
      raised: world.year,
      warEvent: civ.relations[enemyId]?.warEvent,
    };
    m.armies.push(army);

    const enemy = world.civs[enemyId];
    emit(world, {
      kind: "decision",
      civ: civ.id,
      cell: home,
      magnitude: 0.6,
      text: `${civ.name} marched an army of some ${Math.round(size)} against ${enemy.name}.`,
      causedBy: army.warEvent !== undefined ? [army.warEvent] : [],
    });
  }
}

/** Where a civ's armies muster: its most populous settlement. */
function musterPoint(world: World, civ: Civ): number | null {
  let best: Settlement | null = null;
  let bestPop = -1;
  for (const s of world.settlements) {
    if (s.civ !== civ.id) continue;
    let pop = 0;
    for (const c of s.cohorts) pop += c;
    if (pop > bestPop) {
      bestPop = pop;
      best = s;
    }
  }
  return best ? best.cell : null;
}

/** The enemy settlement nearest `from`, or null when they hold none. */
function nearestSettlementCell(world: World, civId: number, from: number): number | null {
  let best: number | null = null;
  let bestKm = Infinity;
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    const d = cellDistance(from, s.cell);
    if (d < bestKm) {
      bestKm = d;
      best = s.cell;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Commanders — minimal Person-backed agency
 * ------------------------------------------------------------------ */

const NAME_STARTS = [
  "Ash", "Bel", "Dar", "Ek", "Gor", "Har", "Ib", "Kal", "Lun", "Mar",
  "Nur", "Or", "Par", "Rau", "Sar", "Tem", "Ul", "Var", "Yor", "Zan",
];
const NAME_ENDS = ["a", "ai", "an", "ar", "eth", "ia", "ik", "im", "on", "or", "u", "ur"];

/** Appoint a named commander: a real `Person` record who can later fall. */
function appointCommander(world: World, civ: Civ, rng: Rng): Commander {
  const name = `${rng.pick(NAME_STARTS)}${rng.pick(NAME_ENDS)}`;
  const person: Person = {
    id: world.nextPersonId++,
    civ: civ.id,
    name,
    born: world.year - rng.int(25, 45),
    died: null,
    role: "commander",
    note: `led the armies of ${civ.name}`,
  };
  world.people.push(person);
  emit(world, {
    kind: "person",
    civ: civ.id,
    magnitude: 0.3,
    fields: { subject: `${name} took command of the armies of ${civ.name}` },
  });
  return { person: person.id, skill: 0.2 + 0.6 * rng.next() };
}

/* ------------------------------------------------------------------ *
 * Movement — terrain prices every kilometre
 * ------------------------------------------------------------------ */

/** How fast ground lets an army pass, 0..1 of open-country pace. */
export function terrainFactor(grid: Grid, c: number): number {
  if (grid.land[c] === 0) return 1; // at sea, the ship sets the pace
  const b = BIOMES[grid.biome[c]];
  let f = 1;
  if (b === "mountain") f = 0.4;
  else if (b === "wetland") f = 0.5;
  else if (b === "taiga" || b === "tundra" || b === "ice") f = 0.55;
  else if (b === "desert" || b === "tropical_forest") f = 0.6;
  else if (b === "temperate_forest") f = 0.8;
  return f * (1 - 0.4 * grid.elevation[c]);
}

/**
 * One campaign year of marching: greedily step cell-to-cell toward the
 * objective, each step priced by the terrain entered — or by the ship, where
 * the civ can sail. An army that cannot cross the water in its way simply
 * stands: a wall of the world, not an error.
 */
function march(world: World, civ: Civ, army: Army): void {
  const grid = world.grid;
  const sails = civ.capabilities.includes("sailing");
  let budget = MARCH_KM_PER_YEAR;
  if (civ.capabilities.includes("roads")) budget *= ROADS_MARCH_MULT;
  if (civ.capabilities.includes("cavalry")) budget *= CAVALRY_MARCH_MULT;

  let guard = 0;
  while (budget > 0 && army.cell !== army.objective && guard++ < 80) {
    const step = bestStep(grid, army.cell, army.objective, sails);
    if (step < 0) break;
    const km = cellDistance(army.cell, step);
    const cost =
      grid.land[step] === 0
        ? km * (MARCH_KM_PER_YEAR / SEA_KM_PER_YEAR)
        : km / Math.max(0.2, terrainFactor(grid, step));
    if (cost > budget) break;
    budget -= cost;
    army.cell = step;
  }
}

/** The neighbouring cell that brings the army nearest its objective, among
 * cells it can enter at all (land, or open water when the civ sails). */
function bestStep(grid: Grid, from: number, objective: number, sails: boolean): number {
  let best = -1;
  let bestD = cellDistance(from, objective);
  for (const n of neighbors(from)) {
    if (grid.land[n] === 0 && !sails) continue;
    const d = cellDistance(n, objective);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * Battle — attritional, legible, and never free
 * ------------------------------------------------------------------ */

const pairKey = (a: number, b: number) => Math.min(a, b) * 1024 + Math.max(a, b);

/**
 * Fight everything the year's marching forced: opposing armies that came
 * within reach intercept each other; an army that reached an enemy settlement
 * assaults it. Each army fights at most once a year, in stable order, with
 * every roll drawn from the pair's seeded battle stream.
 */
function resolveBattles(world: World, alive: Civ[], report: MilitaryReport): void {
  const rngs = new Map<number, Rng>();
  const battleRng = (a: number, b: number): Rng => {
    const key = pairKey(a, b);
    let rng = rngs.get(key);
    if (!rng) {
      rng = new Rng(hashSeed("war", Math.min(a, b), Math.max(a, b), world.year, "battle"));
      rngs.set(key, rng);
    }
    return rng;
  };

  const fought = new Set<Army>();
  for (const civ of alive) {
    for (const army of armiesOf(civ)) {
      if (fought.has(army) || army.troops <= 0) continue;
      const enemy = world.civs[army.target];
      if (!enemy?.alive) continue;

      // Interception first: an enemy army within reach must be met.
      const foe = nearestEnemyArmy(enemy, civ.id, army.cell);
      if (foe && !fought.has(foe) && cellDistance(army.cell, foe.cell) <= INTERCEPT_RANGE_KM) {
        fieldBattle(world, civ, army, enemy, foe, battleRng(civ.id, enemy.id), report);
        fought.add(army);
        fought.add(foe);
        continue;
      }

      // Otherwise, assault whatever enemy settlement is in reach.
      const site = settlementInReach(world, enemy.id, army.cell);
      if (site) {
        assault(world, civ, army, enemy, site, battleRng(civ.id, enemy.id), report);
        fought.add(army);
      }
    }
  }
}

function nearestEnemyArmy(enemy: Civ, targetCiv: number, cell: number): Army | null {
  let best: Army | null = null;
  let bestKm = Infinity;
  for (const a of armiesOf(enemy)) {
    if (a.target !== targetCiv || a.troops <= 0) continue;
    const d = cellDistance(cell, a.cell);
    if (d < bestKm) {
      bestKm = d;
      best = a;
    }
  }
  return best;
}

function settlementInReach(world: World, civId: number, cell: number): Settlement | null {
  let best: Settlement | null = null;
  let bestKm = ENGAGE_RANGE_KM;
  for (const s of world.settlements) {
    if (s.civ !== civId) continue;
    const d = cellDistance(cell, s.cell);
    if (d <= bestKm) {
      bestKm = d;
      best = s;
    }
  }
  return best;
}

/** Quality of the kit an army actually carries, capped by what its civ knows. */
function armyQuality(civ: Civ, army: Army): number {
  if (army.troops <= 0) return 0;
  return Math.min(equipmentTier(civ), army.equipment / army.troops);
}

/** One year's casualty exchange: each side's loss share is the battle's
 * intensity weighted by the *other* side's share of total strength. */
function exchange(
  sA: number,
  sB: number,
  rng: Rng,
): { lossA: number; lossB: number } {
  const total = Math.max(1e-9, sA + sB);
  const noise = () => 1 + BATTLE_NOISE * (rng.next() * 2 - 1);
  return {
    lossA: clamp(0, MAX_BATTLE_LOSS, BATTLE_INTENSITY * (sB / total) * noise()),
    lossB: clamp(0, MAX_BATTLE_LOSS, BATTLE_INTENSITY * (sA / total) * noise()),
  };
}

/** Apply a loss share to an army and its nation: troops fall, kit is lost,
 * spirits sink, real people die at home in the census, and the commander may
 * fall. Returns the number of dead. */
function bleedArmy(
  world: World,
  civ: Civ,
  army: Army,
  lossShare: number,
  rng: Rng,
  battleEvent: number | undefined,
): number {
  const quality = armyQuality(civ, army);
  const dead = army.troops * lossShare;
  const kitLost = dead * quality * EQUIPMENT_LOSS_SHARE;
  army.troops -= dead;
  army.equipment = Math.max(0, army.equipment - kitLost);
  army.morale = clamp(0, 1, army.morale - MORALE_LOSS_SCALE * lossShare);
  civ.military.troops = Math.max(0, civ.military.troops - dead);
  civ.military.equipment = Math.max(0, civ.military.equipment - kitLost);
  civ.military.morale = clamp(0, 1, civ.military.morale - NATION_MORALE_LOSS * lossShare);
  killPeople(world, civ.id, dead);

  if (army.commander && rng.chance(COMMANDER_DEATH_CHANCE * lossShare)) {
    const person = world.people.find((p) => p.id === army.commander?.person);
    if (person && person.died === null) {
      person.died = world.year;
      emit(world, {
        kind: "person",
        civ: civ.id,
        cell: army.cell,
        magnitude: 0.5,
        fields: { subject: `${person.name}, commander of ${civ.name}, fell in battle` },
        causedBy: battleEvent !== undefined ? [battleEvent] : [],
      });
    }
    army.commander = null;
  }
  return dead;
}

/** Two armies meet in the open field. */
function fieldBattle(
  world: World,
  attCiv: Civ,
  att: Army,
  defCiv: Civ,
  def: Army,
  rng: Rng,
  report: MilitaryReport,
): void {
  const sA = forceStrength(att.troops, armyQuality(attCiv, att), att.morale, att.commander?.skill);
  const sD = forceStrength(def.troops, armyQuality(defCiv, def), def.morale, def.commander?.skill);
  const { lossA, lossB } = exchange(sA, sD, rng);

  const total = att.troops * lossA + def.troops * lossB;
  const event = emit(world, {
    kind: "battle",
    civ: attCiv.id,
    cell: att.cell,
    magnitude: clamp(0, 1, total / Math.max(1, att.troops + def.troops)) * 2,
    text: `The armies of ${attCiv.name} and ${defCiv.name} met in battle; some ${Math.round(total)} fell.`,
    causedBy: att.warEvent !== undefined ? [att.warEvent] : [],
  });

  const attDead = bleedArmy(world, attCiv, att, lossA, rng, event.id);
  const defDead = bleedArmy(world, defCiv, def, lossB, rng, event.id);
  if (lossA < lossB) att.morale = clamp(0, 1, att.morale + MORALE_VICTORY_GAIN);
  else if (lossB < lossA) def.morale = clamp(0, 1, def.morale + MORALE_VICTORY_GAIN);

  report.battles.push({
    attacker: attCiv.id,
    defender: defCiv.id,
    cell: att.cell,
    attackerLosses: attDead,
    defenderLosses: defDead,
    stormed: false,
  });
}

/**
 * An army assaults a settlement. The defence is whatever actually stands
 * there: the home reserve armed from what is left of the arsenal, a militia of
 * the settlement's own people with whatever they hold, the ground itself, and
 * any walls — an attacker with siegecraft cancels part of that advantage. If,
 * after the year's fighting, the attacker still overmatches the defence by
 * {@link CONQUEST_RATIO}, the place is stormed: sacked, its people scattered
 * or subjugated, and the land around it changes hands.
 */
function assault(
  world: World,
  attCiv: Civ,
  att: Army,
  defCiv: Civ,
  site: Settlement,
  rng: Rng,
  report: MilitaryReport,
): void {
  const grid = world.grid;

  // The standing defence.
  const fielded = armiesOf(defCiv).reduce((s, a) => s + a.troops, 0);
  const reserve = Math.max(0, defCiv.military.troops - fielded);
  const armouryFree = Math.max(
    0,
    defCiv.military.equipment - armiesOf(defCiv).reduce((s, a) => s + a.equipment, 0),
  );
  const reserveQuality =
    reserve > 0 ? Math.min(equipmentTier(defCiv), armouryFree / reserve) : 0;
  let militia = 0;
  for (let b = 3; b <= 12; b++) militia += site.cohorts[b];
  militia *= MILITIA_SHARE;

  let sD =
    forceStrength(reserve, reserveQuality, defCiv.military.morale) +
    forceStrength(militia, MILITIA_QUALITY, 0.6);

  // The ground and the walls.
  let works =
    1 + TERRAIN_DEFENSE * grid.elevation[site.cell] + FOREST_DEFENSE * grid.forest[site.cell];
  if (defCiv.capabilities.includes("fortification")) works *= FORTIFICATION_MULT;
  if (hasWalls(site)) works *= WALLS_MULT;
  if (attCiv.capabilities.includes("siegecraft")) {
    works = 1 + (works - 1) * (1 - SIEGECRAFT_OFFSET);
  }
  sD *= works;

  const sA = forceStrength(att.troops, armyQuality(attCiv, att), att.morale, att.commander?.skill);
  const { lossA, lossB } = exchange(sA, sD, rng);

  const defenders = reserve + militia;
  const defDead = defenders * lossB;
  const total = att.troops * lossA + defDead;
  const stormedNow = sA * (1 - lossA) > CONQUEST_RATIO * sD * (1 - lossB);

  const event = emit(world, {
    kind: "battle",
    civ: attCiv.id,
    cell: site.cell,
    magnitude: clamp(0, 1, (total / Math.max(1, att.troops + defenders)) * 2 + (stormedNow ? 0.3 : 0)),
    text: stormedNow
      ? `${attCiv.name} stormed a settlement of ${defCiv.name}.`
      : `${attCiv.name} assaulted a settlement of ${defCiv.name} and was held at the walls.`,
    causedBy: att.warEvent !== undefined ? [att.warEvent] : [],
  });

  const attDead = bleedArmy(world, attCiv, att, lossA, rng, event.id);

  // The defence bleeds: soldiers from the reserve and militia from this very
  // settlement — all of them real people in the census.
  defCiv.military.troops = Math.max(0, defCiv.military.troops - reserve * lossB);
  defCiv.military.equipment = Math.max(
    0,
    defCiv.military.equipment - reserve * lossB * reserveQuality * EQUIPMENT_LOSS_SHARE,
  );
  defCiv.military.morale = clamp(0, 1, defCiv.military.morale - NATION_MORALE_LOSS * lossB);
  killPeople(world, defCiv.id, defDead);

  report.battles.push({
    attacker: attCiv.id,
    defender: defCiv.id,
    cell: site.cell,
    attackerLosses: attDead,
    defenderLosses: defDead,
    stormed: stormedNow,
  });

  if (!stormedNow) return;

  // --- The place falls -------------------------------------------------
  const sack = sackSettlement(world, site, attCiv.id);
  const cells = sack.cells + occupy(grid, attCiv.id, defCiv.id, site.cell);
  addGrievance(world, defCiv.id, attCiv.id, "sacked our homes and took our lands", CONQUEST_GRIEVANCE_WEIGHT);
  if (sack.fled > 0 && sack.refuge) {
    emit(world, {
      kind: "settlement",
      civ: defCiv.id,
      cell: sack.refuge.cell,
      magnitude: 0.8,
      text: `Some ${Math.round(sack.fled)} of ${defCiv.name}'s people fled the sack and crowded into a neighbouring settlement.`,
      causedBy: [event.id],
    });
  }
  report.conquests.push({
    winner: attCiv.id,
    loser: defCiv.id,
    cells,
    settlement: site.id,
    refugees: sack.fled,
  });

  // March on, if the enemy still holds anywhere worth marching on.
  const next = nearestSettlementCell(world, defCiv.id, att.cell);
  if (next !== null) att.objective = next;
}

/** Whether a settlement has built any wall-like structure. */
function hasWalls(site: Settlement): boolean {
  for (const name of Object.keys(site.buildings)) {
    const b = name.toLowerCase();
    if ((b.includes("wall") || b.includes("fort")) && site.buildings[name] > 0) return true;
  }
  return false;
}

/** Transfer the loser's land around a stormed settlement to the winner.
 * Windowed like diplomacy's contact scan; the km check is the real gate. */
function occupy(grid: Grid, winnerId: number, loserId: number, center: number): number {
  const R = Math.ceil(OCCUPATION_RADIUS_KM / 78);
  const cx = cellX(center);
  const cy = cellY(center);
  let cells = 0;
  for (let dy = -R; dy <= R; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= GRID_H) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x = (((cx + dx) % GRID_W) + GRID_W) % GRID_W;
      const c = cellIndex(x, y);
      if (grid.owner[c] !== loserId) continue;
      if (cellDistance(center, c) > OCCUPATION_RADIUS_KM) continue;
      grid.owner[c] = winnerId;
      cells++;
    }
  }
  return cells;
}

/* ------------------------------------------------------------------ *
 * Supply — the constraint that matters
 * ------------------------------------------------------------------ */

/** One grid pass grouping every owned cell by civ, for supply distances. */
function ownedCellsByCiv(grid: Grid): Map<number, number[]> {
  const owned = new Map<number, number[]>();
  for (let i = 0; i < grid.owner.length; i++) {
    const o = grid.owner[i];
    if (o < 0) continue;
    let arr = owned.get(o);
    if (!arr) {
      arr = [];
      owned.set(o, arr);
    }
    arr.push(i);
  }
  return owned;
}

/**
 * Feed an army for a year: from the granary while within supply range of any
 * friendly-held cell (conquered land counts — a beachhead is a supply line),
 * from its own carts beyond that, and after the carts are empty, not at all.
 * Hunger is attrition: troops die without a battle being fought.
 */
function supplyArmy(
  world: World,
  civ: Civ,
  army: Army,
  owned: number[],
  report: MilitaryReport,
): void {
  if (army.troops <= 0) return;
  const range = SUPPLY_RANGE_KM * (civ.capabilities.includes("roads") ? ROADS_SUPPLY_MULT : 1);
  let nearest = Infinity;
  for (const c of owned) {
    const d = cellDistance(c, army.cell);
    if (d < nearest) nearest = d;
    if (nearest === 0) break;
  }

  const need = army.troops * SOLDIER_RATION;
  let fed = 0;
  if (nearest <= range) {
    const drawn = Math.min(need, civ.stores.food);
    civ.stores.food -= drawn;
    fed = need > 0 ? drawn / need : 1;
  } else if (army.supplies > 0) {
    const drawn = Math.min(need, army.supplies);
    army.supplies -= drawn;
    fed = need > 0 ? drawn / need : 1;
  }

  const shortfall = 1 - fed;
  if (shortfall > 0.01) {
    const losses = army.troops * ATTRITION_RATE * shortfall;
    army.troops -= losses;
    army.morale = clamp(0, 1, army.morale - ATTRITION_MORALE * shortfall);
    civ.military.troops = Math.max(0, civ.military.troops - losses);
    killPeople(world, civ.id, losses);
    report.attrition.push({ civ: civ.id, losses });
  }
}

/** Broken or spent armies leave the field; their survivors melt back into the
 * reserve (they were never subtracted from `military.troops`). */
function cullArmies(_world: World, alive: Civ[]): void {
  for (const civ of alive) {
    if (!civ.military.armies) continue;
    civ.military.armies = civ.military.armies.filter(
      (a) => a.troops >= MIN_ARMY / 2 && a.morale > BREAK_MORALE,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Peace — exhaustion ends most wars
 * ------------------------------------------------------------------ */

function resolvePeace(world: World, alive: Civ[], report: MilitaryReport): void {
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const lo = alive[i].id < alive[j].id ? alive[i] : alive[j];
      const hi = alive[i].id < alive[j].id ? alive[j] : alive[i];
      const rl = lo.relations[hi.id];
      const rh = hi.relations[lo.id];
      if (!rl || !rh || (!rl.atWar && !rh.atWar)) continue;

      const rng = new Rng(hashSeed("war", lo.id, hi.id, world.year, "peace"));
      const years = world.year - (rl.warSince ?? world.year);
      const pleaLo = rl.peaceOffer !== undefined && rl.peaceOffer !== null;
      const pleaHi = rh.peaceOffer !== undefined && rh.peaceOffer !== null;
      let end =
        lo.military.morale < PEACE_MORALE || hi.military.morale < PEACE_MORALE;
      // A plea for peace ends the war when it is mutual, or when the other
      // side is worn down enough to take the offered way out.
      if (!end) {
        end =
          (pleaLo && pleaHi) ||
          (pleaLo && hi.military.morale < PEACE_ACCEPT_MORALE) ||
          (pleaHi && lo.military.morale < PEACE_ACCEPT_MORALE);
      }
      if (!end && years >= WAR_WEARY_YEARS) end = rng.chance(PEACE_WEARY_CHANCE);
      if (!end) continue;

      makePeace(world, lo.id, hi.id);
      for (const civ of [lo, hi]) {
        if (!civ.military.armies) continue;
        civ.military.armies = civ.military.armies.filter(
          (a) => a.target !== (civ === lo ? hi.id : lo.id),
        );
      }
      report.peaces.push([lo.id, hi.id]);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The dead are real dead
 * ------------------------------------------------------------------ */

/**
 * War deaths come out of the census: remove `count` working-age people across
 * the civ's settlements, proportional to where its people actually live. The
 * demographic consequences — the missing generation, the fall in births —
 * follow from the population model on their own.
 */
function killPeople(world: World, civId: number, count: number): number {
  if (count <= 0) return 0;
  const sites = world.settlements.filter((s) => s.civ === civId);
  let pool = 0;
  for (const s of sites) {
    for (let a = 15; a < 65; a++) pool += s.ages[a];
  }
  if (pool <= 0) return 0;
  const share = Math.min(1, count / pool);
  let removed = 0;
  for (const s of sites) {
    let touched = false;
    for (let a = 15; a < 65; a++) {
      const d = s.ages[a] * share;
      if (d > 0) {
        s.ages[a] -= d;
        removed += d;
        touched = true;
      }
    }
    if (touched) refreshCohorts(s);
  }
  return removed;
}
