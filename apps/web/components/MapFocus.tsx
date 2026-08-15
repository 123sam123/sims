"use client";

/**
 * Renders nothing; flies the map to a cell when an overlay panel opens. Server
 * pages (event, settlement, civilisation) drop this in with the place their
 * subject lives, so opening a deep link — or clicking an event in the feed —
 * swings the world underneath to where it happened.
 */

import { useEffect } from "react";
import { flyToCell } from "@/lib/map-bus";

export default function MapFocus({ cell }: { cell: number | null }) {
  useEffect(() => {
    if (cell != null) flyToCell(cell);
  }, [cell]);
  return null;
}
