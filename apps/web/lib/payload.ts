/**
 * The wire format between the server (which holds the live `World`) and the
 * canvas renderer in the browser.
 *
 * The heavy fields are the six per-cell grids — 64,800 bytes each. They travel
 * as base64 of raw `Uint8Array` bytes, never as JSON number arrays: the array
 * form is several times larger and parses far slower. Everything else
 * (deposits, civilisations, settlements) is small structured data and rides
 * along as ordinary JSON.
 *
 * This module is isomorphic: types plus a browser-only decode. The server-side
 * encode lives in `world-source.ts` because it needs Node's `Buffer`.
 */

export interface CivInfo {
  id: number;
  key: string;
  name: string;
  color: string;
  /** What the civ can build with derives from what it knows. */
  capabilities: string[];
  population: number;
  settlements: number;
}

export interface SettlementInfo {
  id: number;
  civ: number;
  cell: number;
  name: string;
  pop: number;
}

export interface DepositInfo {
  /** cell index */
  c: number;
  /** resource kind */
  k: string;
  /** name */
  n: string;
}

/** The JSON document served by `/api/world`. Grids are base64 `Uint8Array`s. */
export interface MapPayload {
  w: number;
  h: number;
  year: number;
  seed: number;
  /** biome index 0..11 (0 = ocean). */
  biome: string;
  /** elevation, 0..255. */
  elev: string;
  /** river flow, 0..255 (renderer treats > 40 as a river). */
  river: string;
  /** mean annual temperature, 0..255 mapping −40..+40 °C. */
  temp: string;
  /** owning civ id + 1, so 0 = unclaimed. */
  owner: string;
  /** farmland quality, 0..255. */
  fertility: string;
  deposits: DepositInfo[];
  civs: CivInfo[];
  settlements: SettlementInfo[];
}

/** The decoded, render-ready world held in the browser. */
export interface WorldData {
  w: number;
  h: number;
  year: number;
  seed: number;
  biome: Uint8Array;
  elev: Uint8Array;
  river: Uint8Array;
  temp: Uint8Array;
  owner: Uint8Array;
  fertility: Uint8Array;
  deposits: DepositInfo[];
  civs: CivInfo[];
  settlements: SettlementInfo[];
  civById: Map<number, CivInfo>;
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Turn the wire payload into typed arrays and lookup maps, once per fetch. */
export function decodePayload(p: MapPayload): WorldData {
  return {
    w: p.w,
    h: p.h,
    year: p.year,
    seed: p.seed,
    biome: fromBase64(p.biome),
    elev: fromBase64(p.elev),
    river: fromBase64(p.river),
    temp: fromBase64(p.temp),
    owner: fromBase64(p.owner),
    fertility: fromBase64(p.fertility),
    deposits: p.deposits,
    civs: p.civs,
    settlements: p.settlements,
    civById: new Map(p.civs.map((c) => [c.id, c])),
  };
}
