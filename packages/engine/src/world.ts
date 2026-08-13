/**
 * Serialise a `World` to a JSON-safe object and back.
 *
 * A world is mostly typed arrays: the grid holds eleven arrays of 64,800 cells
 * each, and every settlement carries an 80-slot age pyramid. Written as JSON
 * number arrays those blow up several-fold in size and lose their exact bit
 * pattern to the encoder. So the typed arrays are stored as base64 of their raw
 * bytes — compact, and byte-for-byte reversible, which is what lets a snapshot
 * restore to a state the tick then replays identically. Everything else
 * (deposits, civs, events, scalar counters) is already plain data and rides
 * along as ordinary JSON.
 *
 * The format carries a version so a future shape change is a migration, not a
 * silent misread of old bytes.
 */

import {
  AGE_BANDS,
  AGE_SLOTS,
  CELL_COUNT,
  type Civ,
  type Deposit,
  type Grid,
  type Person,
  type Settlement,
  type World,
  type WorldEvent,
} from "./types.ts";

/** Bump when the serialised shape changes incompatibly. */
export const WORLD_FORMAT_VERSION = 1;

type TypedArray = Uint8Array | Int16Array | Float32Array | Float64Array;

interface TypedArrayCtor<T extends TypedArray> {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): T;
  readonly BYTES_PER_ELEMENT: number;
}

/** Raw bytes of a typed array as a base64 string. */
function encodeTA(ta: TypedArray): string {
  return Buffer.from(ta.buffer, ta.byteOffset, ta.byteLength).toString("base64");
}

/**
 * Rebuild a typed array from base64. The bytes are copied into a fresh,
 * zero-offset `ArrayBuffer` so element alignment (Float32/Float64 need 4/8-byte
 * offsets) is guaranteed regardless of how Node pooled the decode buffer.
 */
function decodeTA<T extends TypedArray>(
  Ctor: TypedArrayCtor<T>,
  b64: string,
  expectedLength: number,
): T {
  const bin = Buffer.from(b64, "base64");
  const bytes = new Uint8Array(bin.length);
  bytes.set(bin);
  const arr = new Ctor(bytes.buffer, 0, bytes.byteLength / Ctor.BYTES_PER_ELEMENT);
  if (arr.length !== expectedLength) {
    throw new Error(
      `world: corrupt array — expected ${expectedLength} elements, got ${arr.length}`,
    );
  }
  return arr;
}

interface SerializedGrid {
  land: string;
  elevation: string;
  temperature: string;
  rainfall: string;
  river: string;
  coast: string;
  fertility: string;
  forest: string;
  biome: string;
  owner: string;
  settlement: string;
}

/** A settlement with its two typed-array fields swapped for base64. */
type SerializedSettlement = Omit<Settlement, "ages" | "cohorts"> & {
  ages: string;
  cohorts: string;
};

export interface SerializedWorld {
  v: number;
  seed: number;
  year: number;
  grid: SerializedGrid;
  deposits: Deposit[];
  civs: Civ[];
  settlements: SerializedSettlement[];
  people: Person[];
  events: WorldEvent[];
  nextSettlementId: number;
  nextPersonId: number;
  nextEventId: number;
}

function serializeGrid(g: Grid): SerializedGrid {
  return {
    land: encodeTA(g.land),
    elevation: encodeTA(g.elevation),
    temperature: encodeTA(g.temperature),
    rainfall: encodeTA(g.rainfall),
    river: encodeTA(g.river),
    coast: encodeTA(g.coast),
    fertility: encodeTA(g.fertility),
    forest: encodeTA(g.forest),
    biome: encodeTA(g.biome),
    owner: encodeTA(g.owner),
    settlement: encodeTA(g.settlement),
  };
}

function deserializeGrid(s: SerializedGrid): Grid {
  return {
    land: decodeTA(Uint8Array, s.land, CELL_COUNT),
    elevation: decodeTA(Float32Array, s.elevation, CELL_COUNT),
    temperature: decodeTA(Float32Array, s.temperature, CELL_COUNT),
    rainfall: decodeTA(Float32Array, s.rainfall, CELL_COUNT),
    river: decodeTA(Float32Array, s.river, CELL_COUNT),
    coast: decodeTA(Uint8Array, s.coast, CELL_COUNT),
    fertility: decodeTA(Float32Array, s.fertility, CELL_COUNT),
    forest: decodeTA(Float32Array, s.forest, CELL_COUNT),
    biome: decodeTA(Uint8Array, s.biome, CELL_COUNT),
    owner: decodeTA(Int16Array, s.owner, CELL_COUNT),
    settlement: decodeTA(Int16Array, s.settlement, CELL_COUNT),
  };
}

function serializeSettlement(s: Settlement): SerializedSettlement {
  return { ...s, ages: encodeTA(s.ages), cohorts: encodeTA(s.cohorts) };
}

function deserializeSettlement(s: SerializedSettlement): Settlement {
  return {
    ...s,
    ages: decodeTA(Float64Array, s.ages, AGE_SLOTS),
    cohorts: decodeTA(Float64Array, s.cohorts, AGE_BANDS),
  };
}

/** World -> JSON-safe object. Typed arrays become base64; nothing is deep-copied
 *  beyond what swapping those fields requires — the caller stringifies next. */
export function serializeWorld(world: World): SerializedWorld {
  return {
    v: WORLD_FORMAT_VERSION,
    seed: world.seed,
    year: world.year,
    grid: serializeGrid(world.grid),
    deposits: world.deposits,
    civs: world.civs,
    settlements: world.settlements.map(serializeSettlement),
    people: world.people,
    events: world.events,
    nextSettlementId: world.nextSettlementId,
    nextPersonId: world.nextPersonId,
    nextEventId: world.nextEventId,
  };
}

/** JSON-safe object -> World. Rejects a version it does not understand. */
export function deserializeWorld(s: SerializedWorld): World {
  if (s.v !== WORLD_FORMAT_VERSION) {
    throw new Error(
      `world: unsupported format version ${s.v} (this build reads ${WORLD_FORMAT_VERSION})`,
    );
  }
  return {
    seed: s.seed,
    year: s.year,
    grid: deserializeGrid(s.grid),
    deposits: s.deposits,
    civs: s.civs,
    settlements: s.settlements.map(deserializeSettlement),
    people: s.people,
    events: s.events,
    nextSettlementId: s.nextSettlementId,
    nextPersonId: s.nextPersonId,
    nextEventId: s.nextEventId,
  };
}
