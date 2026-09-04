/**
 * Lease duration grammar + policy validation (pure, no timers).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatLeaseDuration,
  isValidLeaseDurationMs,
  leaseExpiryAt,
  parseLeaseDuration,
  validateLeasePolicy,
} from "../src/lease-duration.ts";

const lease = { flag: "--lease" };
const max = { flag: "--max-lease", allowIndefinite: true };

// Largest epoch-ms a JavaScript Date represents (ECMA-262 TimeClip): 8.64e15.
const MAX_DATE_MS = 8_640_000_000_000_000;
const DAY = 86_400_000;

test("parses the four units into exact milliseconds", () => {
  assert.equal(parseLeaseDuration("45s", lease), 45_000);
  assert.equal(parseLeaseDuration("30m", lease), 1_800_000);
  assert.equal(parseLeaseDuration("8h", lease), 28_800_000);
  assert.equal(parseLeaseDuration("2d", lease), 172_800_000);
  assert.equal(parseLeaseDuration("  8h  ", lease), 28_800_000);
});

test("'indefinitely' is accepted only where allowed", () => {
  assert.equal(parseLeaseDuration("indefinitely", max), null);
  assert.throws(() => parseLeaseDuration("indefinitely", lease), /--lease cannot be 'indefinitely'/);
});

test("rejects zero, signs, decimals, bare numbers, spaces, case, compound and unknown units", () => {
  for (const bad of ["0m", "00h", "-5m", "+5m", "1.5h", "30", "5 m", "8H", "1h30m", "1w", "", "abc", "Indefinitely", "INDEFINITELY"]) {
    assert.throws(() => parseLeaseDuration(bad, max), /invalid --max-lease duration/, `expected rejection for '${bad}'`);
  }
});

test("no product ceiling: long durations parse exactly; only safe-integer overflow is rejected", () => {
  // Formerly rejected by an unsourced 100-year cap; both are valid safe-integer durations.
  assert.equal(parseLeaseDuration("36501d", lease), 36_501 * DAY);
  assert.equal(parseLeaseDuration("100000000d", lease), MAX_DATE_MS); // 1e8 days = the Date limit from epoch 0
  // Multiplication overflow past Number.MAX_SAFE_INTEGER is rejected at parse time.
  assert.throws(() => parseLeaseDuration("99999999999d", lease), /too long \(not a safe integer/);
  assert.throws(() => parseLeaseDuration("9007199254740992s", lease), /too long/);
  assert.throws(() => parseLeaseDuration(`${"9".repeat(400)}s`, lease), /too long/);
});

test("isValidLeaseDurationMs accepts null and every positive safe integer; nothing else", () => {
  assert.equal(isValidLeaseDurationMs(null), true);
  assert.equal(isValidLeaseDurationMs(1), true);
  assert.equal(isValidLeaseDurationMs(1499), true);
  assert.equal(isValidLeaseDurationMs(101 * 365 * DAY), true);
  assert.equal(isValidLeaseDurationMs(Number.MAX_SAFE_INTEGER), true);
  for (const bad of [undefined, 0, -1, 1.5, NaN, Infinity, "30m", true, {}, Number.MAX_SAFE_INTEGER + 2]) {
    assert.equal(isValidLeaseDurationMs(bad), false, `expected invalid for ${String(bad)}`);
  }
});

test("leaseExpiryAt: the expiry when representable as a valid Date, else null", () => {
  assert.equal(leaseExpiryAt(1_000_000, 1_800_000), 2_800_000);
  assert.equal(leaseExpiryAt(0, MAX_DATE_MS), MAX_DATE_MS);
  assert.equal(new Date(MAX_DATE_MS).toISOString(), "+275760-09-13T00:00:00.000Z");
  // One millisecond past the Date limit: safe integer, but not a valid Date.
  assert.equal(leaseExpiryAt(1, MAX_DATE_MS), null);
  assert.equal(Number.isSafeInteger(MAX_DATE_MS + 1), true);
  // Safe-integer overflow of the sum.
  assert.equal(leaseExpiryAt(1_000_000, Number.MAX_SAFE_INTEGER), null);
  // From roughly today's clock, 100000000d is no longer representable.
  assert.equal(leaseExpiryAt(1_756_000_000_000, 100_000_000 * DAY), null);
  assert.equal(leaseExpiryAt(1_756_000_000_000, 99_979_000 * DAY), 1_756_000_000_000 + 99_979_000 * DAY);
});

test("formatLeaseDuration renders the canonical label", () => {
  assert.equal(formatLeaseDuration(null), "indefinitely");
  assert.equal(formatLeaseDuration(45_000), "45s");
  assert.equal(formatLeaseDuration(90_000), "90s");
  assert.equal(formatLeaseDuration(1_800_000), "30m");
  assert.equal(formatLeaseDuration(28_800_000), "8h");
  assert.equal(formatLeaseDuration(172_800_000), "2d");
  assert.equal(formatLeaseDuration(90 * 60_000), "90m");
  assert.equal(formatLeaseDuration(36_501 * DAY), "36501d");
});

test("formatLeaseDuration never rounds: non-whole-second values are exact milliseconds", () => {
  assert.equal(formatLeaseDuration(1), "1ms");
  assert.equal(formatLeaseDuration(1499), "1499ms");
  assert.equal(formatLeaseDuration(1500), "1500ms");
  assert.equal(formatLeaseDuration(1000), "1s");
  assert.equal(formatLeaseDuration(999), "999ms");
  assert.equal(formatLeaseDuration(60_001), "60001ms");
  assert.equal(formatLeaseDuration(3_600_500), "3600500ms");
});

test("validateLeasePolicy: finite default, default <= finite max, indefinite max allowed", () => {
  const at = 1_000_000 + 5 * 60_000;
  assert.deepEqual(validateLeasePolicy({ defaultMs: 28_800_000, maxMs: 28_800_000 }, at), { defaultMs: 28_800_000, maxMs: 28_800_000 });
  assert.deepEqual(validateLeasePolicy({ defaultMs: 1_800_000, maxMs: null }, at), { defaultMs: 1_800_000, maxMs: null });
  assert.throws(() => validateLeasePolicy({ defaultMs: 28_800_000, maxMs: 7_200_000 }, at), /--lease 8h exceeds --max-lease 2h/);
  assert.throws(() => validateLeasePolicy({ defaultMs: 0, maxMs: null }, at), /--lease must be a finite positive duration/);
  assert.throws(() => validateLeasePolicy({ defaultMs: null as unknown as number, maxMs: null }, at), /--lease must be a finite positive duration/);
  assert.throws(() => validateLeasePolicy({ defaultMs: 1_800_000, maxMs: 0 }, at), /--max-lease must be a positive duration/);
  assert.throws(() => validateLeasePolicy({ defaultMs: Number.MAX_SAFE_INTEGER + 2, maxMs: null }, at), /--lease must be a finite positive duration/);
});

test("validateLeasePolicy: default and finite max must produce a valid expiry from the given clock", () => {
  // Exactly representable at the latest lease start → accepted.
  assert.deepEqual(validateLeasePolicy({ defaultMs: MAX_DATE_MS - 10, maxMs: null }, 10), { defaultMs: MAX_DATE_MS - 10, maxMs: null });
  // One ms later the same default can no longer produce a valid Date → fail closed.
  assert.throws(() => validateLeasePolicy({ defaultMs: MAX_DATE_MS - 10, maxMs: null }, 11), /--lease .* cannot produce a valid expiry date/);
  assert.throws(() => validateLeasePolicy({ defaultMs: 1_800_000, maxMs: MAX_DATE_MS }, 1), /--max-lease .* cannot produce a valid expiry date/);
  assert.throws(() => validateLeasePolicy({ defaultMs: 1_800_000, maxMs: Number.MAX_SAFE_INTEGER }, 1_000_000), /--max-lease .* cannot produce a valid expiry date/);
  // A finite max at the limit is fine when it is representable.
  assert.deepEqual(validateLeasePolicy({ defaultMs: 1_800_000, maxMs: MAX_DATE_MS - 1 }, 1), { defaultMs: 1_800_000, maxMs: MAX_DATE_MS - 1 });
});
