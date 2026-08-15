/**
 * The world's calendar.
 *
 * `World.year` is and stays an internal tick count from 0 — determinism,
 * serialisation and every stored event key off it, so it must never carry a
 * calendar offset. This module is the single place that turns a tick into the
 * date a human reads.
 *
 * The world opens in **2000 BC**. Tick 0 is 2000 BC, tick 2000 is 1 AD, and
 * present day falls around tick 4025.
 */

/** Historical year the simulation opens in. Negative is BC. */
export const START_YEAR = -2000;

/**
 * Tick → historical year.
 *
 * The historical calendar has no year zero: 1 BC is followed directly by 1 AD.
 * So once the running year reaches 0 we step over it, which keeps the returned
 * number a real calendar year rather than an astronomical one.
 */
export function historicalYear(tick: number): number {
  const y = START_YEAR + tick;
  return y >= 0 ? y + 1 : y;
}

/** Inverse of `historicalYear` — the tick a given calendar year falls on. */
export function tickForYear(year: number): number {
  const y = year > 0 ? year - 1 : year;
  return y - START_YEAR;
}

/** `2000 BC`, `1 BC`, `1 AD`, `2026 AD`. */
export function formatYear(tick: number): string {
  const y = historicalYear(tick);
  const n = Math.abs(y).toLocaleString("en-US");
  return y < 0 ? `${n} BC` : `${n} AD`;
}

/**
 * A span, collapsing the era suffix when both ends share one:
 * `2000–1900 BC`, but `50 BC – 50 AD`.
 */
export function formatYearSpan(fromTick: number, toTick: number): string {
  const a = historicalYear(fromTick);
  const b = historicalYear(toTick);
  const na = Math.abs(a).toLocaleString("en-US");
  const nb = Math.abs(b).toLocaleString("en-US");
  if (a < 0 && b < 0) return `${na}–${nb} BC`;
  if (a > 0 && b > 0) return `${na}–${nb} AD`;
  return `${na} BC – ${nb} AD`;
}
