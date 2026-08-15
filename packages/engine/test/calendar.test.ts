import assert from "node:assert/strict";
import { test } from "node:test";
import { START_YEAR, formatYear, formatYearSpan, historicalYear, tickForYear } from "../src/calendar.ts";

test("the world opens in 2000 BC", () => {
  assert.equal(START_YEAR, -2000);
  assert.equal(historicalYear(0), -2000);
  assert.equal(formatYear(0), "2,000 BC");
});

test("there is no year zero — 1 BC is followed by 1 AD", () => {
  assert.equal(historicalYear(1999), -1, "tick 1999 is 1 BC");
  assert.equal(historicalYear(2000), 1, "tick 2000 is 1 AD, not year 0");
  assert.equal(formatYear(1999), "1 BC");
  assert.equal(formatYear(2000), "1 AD");
});

test("present day lands where it should", () => {
  assert.equal(formatYear(4025), "2,026 AD");
});

test("tickForYear inverts historicalYear across the epoch", () => {
  for (const tick of [0, 1, 999, 1999, 2000, 2001, 4025, 12000]) {
    assert.equal(tickForYear(historicalYear(tick)), tick, `round-trip failed at tick ${tick}`);
  }
});

test("spans collapse a shared era suffix", () => {
  assert.equal(formatYearSpan(0, 100), "2,000–1,900 BC");
  assert.equal(formatYearSpan(2000, 2100), "1–101 AD");
  assert.equal(formatYearSpan(1950, 2050), "50 BC – 51 AD");
});
