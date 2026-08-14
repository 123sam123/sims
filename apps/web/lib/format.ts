/**
 * Isomorphic formatters and the wire shape the feed shares between the server
 * (which holds the `World` and the event log) and the client `Feed` component.
 *
 * Nothing here touches Node: it is safe to import from a `"use client"` module.
 * The only `@sim/engine` dependency is the `EventKind` *type*, which is erased
 * at build time, so no engine runtime leaks into the browser bundle.
 */

import type { EventKind } from "@sim/engine";

/**
 * One event, flattened for display: the durable headline plus the actor
 * civilisation and the settlement it touched, already resolved to names and a
 * colour so the client never needs the world to render a row.
 */
export interface FeedItem {
  id: number;
  year: number;
  kind: EventKind;
  weight: number;
  text: string;
  cell: number | null;
  civKey: string | null;
  civName: string | null;
  civColor: string | null;
  settlementId: number | null;
  settlementName: string | null;
}

const nf = new Intl.NumberFormat("en-US");

/** A count, rounded and grouped: `1,234`. */
export const formatNumber = (n: number): string => nf.format(Math.round(n));

/** A sim-year as a label: `Year 1,234`. Years count from the first tick. */
export const formatYear = (year: number): string => `Year ${nf.format(year)}`;

/** A 0..1 fraction as a percent: `72%`. */
export const formatPercent = (v: number): string => `${Math.round(v * 100)}%`;

const KIND_LABEL: Record<EventKind, string> = {
  founding: "Founding",
  discovery: "Discovery",
  settlement: "Settlement",
  war: "War",
  battle: "Battle",
  peace: "Peace",
  contact: "Contact",
  famine: "Famine",
  plague: "Plague",
  disaster: "Disaster",
  government: "Government",
  growth: "Growth",
  collapse: "Collapse",
  decision: "Decision",
  refusal: "Refusal",
  person: "Life",
  trade: "Trade",
  unrest: "Unrest",
  secession: "Secession",
  depletion: "Depletion",
  degradation: "Degradation",
};

/** A short human label for an event kind. */
export const kindLabel = (k: EventKind): string => KIND_LABEL[k] ?? k;

/** Coarse tone for colour-coding a row/badge by what the event means. */
export type Tone = "grave" | "conflict" | "discovery" | "growth" | "civic" | "neutral";

const KIND_TONE: Record<EventKind, Tone> = {
  collapse: "grave",
  famine: "grave",
  plague: "grave",
  disaster: "grave",
  war: "conflict",
  battle: "conflict",
  peace: "conflict",
  discovery: "discovery",
  founding: "growth",
  settlement: "growth",
  growth: "growth",
  government: "civic",
  contact: "civic",
  trade: "civic",
  decision: "civic",
  refusal: "civic",
  person: "neutral",
  unrest: "conflict",
  secession: "conflict",
  depletion: "grave",
  degradation: "grave",
};

export const kindTone = (k: EventKind): Tone => KIND_TONE[k] ?? "neutral";

/** Where an event's weight lands: what mattered vs. the year-to-year hum. */
export type WeightBand = "major" | "notable" | "routine";

export function weightBand(w: number): WeightBand {
  if (w >= 0.6) return "major";
  if (w >= 0.4) return "notable";
  return "routine";
}

/* --- link builders — one source of truth for every internal href --- */

export const civHref = (key: string): string => `/civ/${encodeURIComponent(key)}`;
export const settlementHref = (id: number): string => `/settlement/${id}`;
export const eventHref = (id: number): string => `/event/${id}`;

/** Grid cell -> a rounded `12°N, 4°W` label. The grid is equirectangular. */
export function cellCoords(cell: number, gridW: number): string {
  const x = cell % gridW;
  const y = Math.floor(cell / gridW);
  const lat = Math.round(90 - y - 0.5);
  const lon = Math.round(x - 180 + 0.5);
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat)}°${ns}, ${Math.abs(lon)}°${ew}`;
}
