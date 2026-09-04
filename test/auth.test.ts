/**
 * Unit tests for the lease-token authorization core.
 *
 * Run: npm test  (node --test with the tsx loader — no bundler needed).
 *
 * Everything here uses an injected clock and injected token/OTP minters, so
 * expiry and attempt-limit behavior is deterministic without real timers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LeaseAuthority, normalizeOtp, type NotificationPayload } from "../src/auth.ts";
import { formatNotificationBody } from "../src/ntfy.ts";

interface Harness {
  auth: LeaseAuthority;
  sent: NotificationPayload[];
  setNow: (t: number) => void;
  failNotify: (fail: boolean) => void;
}

function makeAuth(overrides: {
  leaseMs?: number;
  maxLeaseMs?: number | null;
  pendingMs?: number;
  maxAttempts?: number;
  renewCooldownMs?: number;
  token?: string;
  otp?: string;
} = {}): Harness {
  let now = 1_000_000;
  let fail = false;
  const sent: NotificationPayload[] = [];
  const auth = new LeaseAuthority({
    connector: "laptop",
    host: "test-host",
    defaultLeaseMs: overrides.leaseMs ?? 8 * 3600_000,
    // Omitted → equals the default (today's fixed upper bound).
    ...(overrides.maxLeaseMs !== undefined ? { maxLeaseMs: overrides.maxLeaseMs } : {}),
    pendingMs: overrides.pendingMs ?? 5 * 60_000,
    maxAttempts: overrides.maxAttempts ?? 5,
    renewCooldownMs: overrides.renewCooldownMs ?? 0,
    now: () => now,
    mintToken: () => overrides.token ?? "TESTTOKEN-256bit",
    mintOtp: () => overrides.otp ?? "K7M2-QP9A",
    notify: async (p) => {
      if (fail) throw new Error("boom");
      sent.push(p);
    },
  });
  return {
    auth,
    sent,
    setNow: (t) => { now = t; },
    failNotify: (f) => { fail = f; },
  };
}

test("normalizeOtp folds separators and ambiguous glyphs", () => {
  assert.equal(normalizeOtp("k7m2-qp9a"), "K7M2QP9A");
  assert.equal(normalizeOtp("iLo0"), "1100");
});

test("start denied with auth_required when no lease exists", () => {
  const { auth } = makeAuth();
  const d = auth.authorizeStart("space-1", "TESTTOKEN-256bit");
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "auth_required");
});

test("start denied when leaseToken missing", () => {
  const { auth } = makeAuth();
  const d = auth.authorizeStart("space-1", undefined);
  assert.equal(d.ok, false);
  assert.equal((d as any).code, "auth_required");
});

test("renew stores pending, notifies, returns raw token", async () => {
  const { auth, sent } = makeAuth();
  const r = await auth.renew("space-1", "need logs");
  assert.equal(r.ok, true);
  assert.equal((r as any).leaseToken, "TESTTOKEN-256bit");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].otp, "K7M2-QP9A");
  assert.equal(sent[0].reason, "need logs");
  assert.equal(auth.hasPending("space-1"), true);
});

test("full renew -> auth -> start success path", async () => {
  const { auth } = makeAuth();
  const r = await auth.renew("space-1", "reason");
  assert.equal(r.ok, true);
  const token = (r as any).leaseToken as string;

  // Hidden token alone cannot execute before auth.
  assert.equal(auth.authorizeStart("space-1", token).ok, false);

  const a = auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, true);

  // Now exec is authorized.
  assert.equal(auth.authorizeStart("space-1", token).ok, true);
});

test("wrong OTP fails and does not promote", async () => {
  const { auth } = makeAuth();
  const r = await auth.renew("space-1", "reason");
  const token = (r as any).leaseToken as string;
  const a = auth.verifyAuth("space-1", token, "WRON-GOTP");
  assert.equal(a.ok, false);
  assert.equal((a as any).code, "auth_failed");
  assert.equal(auth.authorizeStart("space-1", token).ok, false);
});

test("OTP alone (wrong hidden token) cannot authorize", async () => {
  const { auth } = makeAuth();
  await auth.renew("space-1", "reason");
  const a = auth.verifyAuth("space-1", "WRONG-TOKEN", "K7M2-QP9A");
  assert.equal(a.ok, false);
});

test("attempt limit blocks the pending renewal", async () => {
  const { auth } = makeAuth({ maxAttempts: 3 });
  const r = await auth.renew("space-1", "reason");
  const token = (r as any).leaseToken as string;
  assert.equal(auth.verifyAuth("space-1", token, "BADO-NE11").ok, false);
  assert.equal(auth.verifyAuth("space-1", token, "BADO-NE22").ok, false);
  // 3rd failure trips the limit and drops the pending renewal.
  const third = auth.verifyAuth("space-1", token, "BADO-NE33");
  assert.equal(third.ok, false);
  assert.match((third as any).message, /too many/);
  // Even the correct OTP now fails — pending is gone.
  assert.equal(auth.verifyAuth("space-1", token, "K7M2-QP9A").ok, false);
});

test("pending renewal expires", async () => {
  const h = makeAuth({ pendingMs: 60_000 });
  const r = await h.auth.renew("space-1", "reason");
  const token = (r as any).leaseToken as string;
  h.setNow(1_000_000 + 60_001);
  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, false);
  assert.match((a as any).message, /expired/);
});

test("active lease expires", async () => {
  const h = makeAuth({ leaseMs: 100_000 });
  const r = await h.auth.renew("space-1", "reason");
  const token = (r as any).leaseToken as string;
  h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(h.auth.authorizeStart("space-1", token).ok, true);
  h.setNow(1_000_000 + 100_001);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, false);
});

test("renew is rate-limited within the cooldown window", async () => {
  const h = makeAuth({ renewCooldownMs: 30_000 });
  const first = await h.auth.renew("space-1", "a");
  assert.equal(first.ok, true);
  const second = await h.auth.renew("space-1", "b");
  assert.equal(second.ok, false);
  assert.equal((second as any).code, "rate_limited");
  // After the cooldown, renew is allowed again.
  h.setNow(1_000_000 + 30_001);
  const third = await h.auth.renew("space-1", "c");
  assert.equal(third.ok, true);
});

test("notify failure drops the pending renewal", async () => {
  const h = makeAuth();
  h.failNotify(true);
  const r = await h.auth.renew("space-1", "reason");
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "notify_failed");
  assert.equal(h.auth.hasPending("space-1"), false);
});

test("newest renewal replaces the prior pending one", async () => {
  let n = 0;
  let otpN = 0;
  const auth = new LeaseAuthority({
    connector: "laptop",
    host: "test-host",
    renewCooldownMs: 0,
    now: () => 1_000_000,
    mintToken: () => `TOK-${++n}`,
    mintOtp: () => `OTP0-000${++otpN}`,
    notify: async () => {},
  });
  const r1 = await auth.renew("space-1", "first");
  const t1 = (r1 as any).leaseToken as string;
  const r2 = await auth.renew("space-1", "second");
  const t2 = (r2 as any).leaseToken as string;
  assert.notEqual(t1, t2);
  // The first (now-replaced) token+OTP no longer authorizes.
  assert.equal(auth.verifyAuth("space-1", t1, "OTP0-0001").ok, false);
  // The newest token+OTP does.
  assert.equal(auth.verifyAuth("space-1", t2, "OTP0-0002").ok, true);
});

test("wrong space cannot use another space's lease", async () => {
  const { auth } = makeAuth();
  const r = await auth.renew("space-1", "reason");
  const token = (r as any).leaseToken as string;
  auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(auth.authorizeStart("space-2", token).ok, false);
  assert.equal(auth.authorizeStart("space-1", token).ok, true);
});

// --------------------------------------------------------------------
// Configurable lease durations: request resolution, policy, binding.
// --------------------------------------------------------------------

const H = 3600_000;

test("omitted request resolves to the finite default and echoes it", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 8 * H });
  const r = await auth.renew("space-1", "reason");
  assert.equal(r.ok, true);
  assert.equal((r as any).leaseDurationMs, 8 * H);
  assert.equal(sent[0].leaseDurationMs, 8 * H);
  assert.equal(sent[0].leaseLabel, "8h");
});

test("omitted --max-lease means max == default: longer request rejected before any mutation", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 8 * H });
  const r = await auth.renew("space-1", "reason", 9 * H);
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "lease_duration_exceeds_max");
  assert.match((r as any).message, /8h/);
  assert.equal(sent.length, 0);
  assert.equal(auth.hasPending("space-1"), false);
  // Rejection did not stamp the cooldown: an allowed request right after works.
  const ok = await auth.renew("space-1", "reason", 8 * H);
  assert.equal(ok.ok, true);
});

test("finite request at or below the finite max is accepted exactly (no clamping)", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 30 * 60_000, maxLeaseMs: 2 * H });
  const below = await auth.renew("space-1", "r", 10 * 60_000);
  assert.equal(below.ok, true);
  assert.equal((below as any).leaseDurationMs, 10 * 60_000);
  assert.equal(sent[0].leaseLabel, "10m");
  const equal = await auth.renew("space-2", "r", 2 * H);
  assert.equal(equal.ok, true);
  assert.equal((equal as any).leaseDurationMs, 2 * H);
  assert.equal(sent[1].leaseLabel, "2h");
});

test("finite request above the finite max is rejected, not clamped", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 30 * 60_000, maxLeaseMs: 2 * H });
  const r = await auth.renew("space-1", "r", 2 * H + 1);
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "lease_duration_exceeds_max");
  assert.equal(sent.length, 0);
});

test("indefinite request under a finite max is rejected", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 30 * 60_000, maxLeaseMs: 2 * H });
  const r = await auth.renew("space-1", "r", null);
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "lease_duration_exceeds_max");
  assert.equal(sent.length, 0);
});

test("indefinite max accepts every valid finite request and explicit indefinite", async () => {
  const { auth, sent } = makeAuth({ leaseMs: 30 * 60_000, maxLeaseMs: null });
  const finite = await auth.renew("space-1", "r", 30 * 86_400_000);
  assert.equal(finite.ok, true);
  assert.equal((finite as any).leaseDurationMs, 30 * 86_400_000);
  assert.equal(sent[0].leaseLabel, "30d");
  const indefinite = await auth.renew("space-2", "r", null);
  assert.equal(indefinite.ok, true);
  assert.equal((indefinite as any).leaseDurationMs, null);
  assert.equal(sent[1].leaseDurationMs, null);
  assert.equal(sent[1].leaseLabel, "indefinitely");
});

test("invalid wire values are rejected as invalid_lease_duration before any mutation", async () => {
  const { auth, sent } = makeAuth({ leaseMs: H, maxLeaseMs: null });
  for (const bad of [0, -1, 1.5, "30m", true, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
    const r = await auth.renew("space-1", "r", bad);
    assert.equal(r.ok, false, `expected rejection for ${String(bad)}`);
    assert.equal((r as any).code, "invalid_lease_duration");
  }
  assert.equal(sent.length, 0);
  assert.equal(auth.hasPending("space-1"), false);
});

test("auth-time expiry uses the pending-bound duration and the daemon clock at auth", async () => {
  const h = makeAuth({ leaseMs: 8 * H, maxLeaseMs: 2 * 86_400_000 });
  const r = await h.auth.renew("space-1", "r", 10 * 60_000);
  const token = (r as any).leaseToken as string;
  // The OTP is approved 2 minutes later: the lease clock starts at auth, not at renew.
  h.setNow(1_000_000 + 120_000);
  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, true);
  assert.equal((a as any).leaseDurationMs, 10 * 60_000);
  assert.equal((a as any).leaseExpiresAt, 1_000_000 + 120_000 + 10 * 60_000);
  h.setNow(1_000_000 + 120_000 + 10 * 60_000 - 1);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, true);
  h.setNow(1_000_000 + 120_000 + 10 * 60_000);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, false);
});

test("indefinite lease: null expiry, authorized far in the future, still exact space + token", async () => {
  const h = makeAuth({ leaseMs: H, maxLeaseMs: null });
  const r = await h.auth.renew("space-1", "r", null);
  const token = (r as any).leaseToken as string;
  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, true);
  assert.equal((a as any).leaseExpiresAt, null);
  assert.equal((a as any).leaseDurationMs, null);
  h.setNow(1_000_000 + 1000 * 365 * 86_400_000);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, true);
  assert.equal(h.auth.authorizeStart("space-2", token).ok, false);
  assert.equal(h.auth.authorizeStart("space-1", "WRONG-TOKEN").ok, false);
});

test("newest pending replaces the prior pending duration", async () => {
  let n = 0;
  let otpN = 0;
  const sent: NotificationPayload[] = [];
  const auth = new LeaseAuthority({
    connector: "laptop",
    host: "test-host",
    defaultLeaseMs: H,
    maxLeaseMs: null,
    renewCooldownMs: 0,
    now: () => 1_000_000,
    mintToken: () => `TOK-${++n}`,
    mintOtp: () => `OTP0-000${++otpN}`,
    notify: async (p) => { sent.push(p); },
  });
  const r1 = await auth.renew("space-1", "first", 10 * 60_000);
  const r2 = await auth.renew("space-1", "second", null);
  assert.equal(sent[0].leaseLabel, "10m");
  assert.equal(sent[1].leaseLabel, "indefinitely");
  // Approving with the first OTP fails; the second binds the second duration.
  assert.equal(auth.verifyAuth("space-1", (r1 as any).leaseToken, "OTP0-0001").ok, false);
  const a = auth.verifyAuth("space-1", (r2 as any).leaseToken, "OTP0-0002");
  assert.equal(a.ok, true);
  assert.equal((a as any).leaseExpiresAt, null);
});

test("successful auth replaces the prior active lease for the same space", async () => {
  let n = 0;
  const auth = new LeaseAuthority({
    connector: "laptop",
    host: "test-host",
    defaultLeaseMs: H,
    maxLeaseMs: null,
    renewCooldownMs: 0,
    now: () => 1_000_000,
    mintToken: () => `TOK-${++n}`,
    mintOtp: () => "K7M2-QP9A",
    notify: async () => {},
  });
  const r1 = await auth.renew("space-1", "first");
  const t1 = (r1 as any).leaseToken as string;
  assert.equal(auth.verifyAuth("space-1", t1, "K7M2-QP9A").ok, true);
  assert.equal(auth.authorizeStart("space-1", t1).ok, true);

  const r2 = await auth.renew("space-1", "second", 10 * 60_000);
  const t2 = (r2 as any).leaseToken as string;
  // Until auth, the prior active lease still works (renew is only a request).
  assert.equal(auth.authorizeStart("space-1", t1).ok, true);
  assert.equal(auth.verifyAuth("space-1", t2, "K7M2-QP9A").ok, true);
  // One active lease per space: the old token no longer authorizes.
  assert.equal(auth.authorizeStart("space-1", t1).ok, false);
  assert.equal(auth.authorizeStart("space-1", t2).ok, true);
});

test("pending TTL is independent of the requested lease duration", async () => {
  const h = makeAuth({ leaseMs: H, maxLeaseMs: null, pendingMs: 5 * 60_000 });
  const r = await h.auth.renew("space-1", "r", null);
  const token = (r as any).leaseToken as string;
  h.setNow(1_000_000 + 5 * 60_000);
  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, false);
  assert.match((a as any).message, /expired/);
});

test("constructor rejects an invalid policy (default above finite max)", () => {
  assert.throws(
    () =>
      new LeaseAuthority({
        connector: "laptop",
        host: "h",
        defaultLeaseMs: 8 * H,
        maxLeaseMs: 2 * H,
        notify: async () => {},
      }),
    /exceeds --max-lease/,
  );
});

test("describePolicy renders default and max without secrets", () => {
  const { auth } = makeAuth({ leaseMs: 30 * 60_000, maxLeaseMs: null });
  assert.equal(auth.describePolicy(), "default 30m, max indefinitely");
  const fixed = makeAuth({ leaseMs: 8 * H });
  assert.equal(fixed.auth.describePolicy(), "default 8h, max 8h");
});

// --------------------------------------------------------------------
// Exact millisecond durations and actual expiry representability.
// --------------------------------------------------------------------

const DAY = 86_400_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

test("non-whole-second durations are bound and notified exactly, never rounded", async () => {
  const { auth, sent } = makeAuth({ leaseMs: H, maxLeaseMs: null });
  const cases: Array<[number, string]> = [[1, "1ms"], [1499, "1499ms"], [1500, "1500ms"]];
  for (const [i, [ms, label]] of cases.entries()) {
    const r = await auth.renew(`space-${i}`, "r", ms);
    assert.equal(r.ok, true, `expected ${ms} to be accepted`);
    assert.equal((r as any).leaseDurationMs, ms);
    assert.equal(sent[i].leaseDurationMs, ms);
    assert.equal(sent[i].leaseLabel, label);
    const body = formatNotificationBody(sent[i], 1_000_000);
    assert.match(body, new RegExp(`^Lease: ${label}$`, "m"));
    assert.doesNotMatch(body, /^Lease: [012]s$/m);
  }
});

test("no 100-year ceiling: a 101-year request is a valid duration under an indefinite max", async () => {
  const { auth, sent } = makeAuth({ leaseMs: H, maxLeaseMs: null });
  const r = await auth.renew("space-1", "r", 101 * 365 * DAY);
  assert.equal(r.ok, true);
  assert.equal((r as any).leaseDurationMs, 101 * 365 * DAY);
  assert.equal(sent[0].leaseLabel, "36865d");
});

test("exceeds_max text names the exact requested millisecond value", async () => {
  const { auth } = makeAuth({ leaseMs: 1_000, maxLeaseMs: 1_000 });
  const r = await auth.renew("space-1", "r", 1_499);
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "lease_duration_exceeds_max");
  assert.match((r as any).message, /requested lease 1499ms exceeds this connector's maximum 1s/);
});

test("a duration representable at renew but not at the end of the pending window is rejected before any mutation", async () => {
  const pendingMs = 5 * 60_000;
  const h = makeAuth({ leaseMs: H, maxLeaseMs: null, pendingMs });
  // now = 1_000_000. Representable if approved instantly, but an auth at the
  // last millisecond of the window would land 1 ms past the Date limit.
  const edge = MAX_DATE_MS - 1_000_000 - pendingMs + 1;
  const r = await h.auth.renew("space-1", "r", edge);
  assert.equal(r.ok, false);
  assert.equal((r as any).code, "invalid_lease_duration");
  assert.match((r as any).message, /cannot produce a valid expiry date/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.auth.hasPending("space-1"), false);
  // Rejection did not stamp the cooldown or touch state: a representable request right after works.
  const ok = await h.auth.renew("space-1", "r", edge - 1);
  assert.equal(ok.ok, true);
});

test("a duration representable through the whole window yields a valid Date even when approved at the last moment", async () => {
  const pendingMs = 5 * 60_000;
  const h = makeAuth({ leaseMs: H, maxLeaseMs: null, pendingMs });
  const longest = MAX_DATE_MS - 1_000_000 - pendingMs;
  const r = await h.auth.renew("space-1", "r", longest);
  assert.equal(r.ok, true);
  const token = (r as any).leaseToken as string;
  h.setNow(1_000_000 + pendingMs - 1); // last instant the OTP is still valid
  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, true);
  const expiresAt = (a as any).leaseExpiresAt as number;
  assert.equal(expiresAt, MAX_DATE_MS - 1);
  assert.equal(Number.isSafeInteger(expiresAt), true);
  assert.equal(Number.isNaN(new Date(expiresAt).getTime()), false);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, true);
});

test("unrepresentable is invalid_lease_duration even under a finite max; above-max but representable is exceeds_max", async () => {
  const { auth } = makeAuth({ leaseMs: H, maxLeaseMs: 2 * H });
  const unrepresentable = await auth.renew("space-1", "r", MAX_DATE_MS);
  assert.equal((unrepresentable as any).code, "invalid_lease_duration");
  const tooLong = await auth.renew("space-1", "r", 3 * H);
  assert.equal((tooLong as any).code, "lease_duration_exceeds_max");
});

test("long-running daemon: the default is re-checked at renew time with the live clock", async () => {
  // Valid at construction (now = 1_000_000, pending 5m) …
  const pendingMs = 5 * 60_000;
  const defaultMs = MAX_DATE_MS - 1_000_000 - pendingMs;
  const h = makeAuth({ leaseMs: defaultMs, maxLeaseMs: null, pendingMs });
  const before = await h.auth.renew("space-1", "r");
  assert.equal(before.ok, true);
  // … but after the clock moves on, an omitted request can no longer produce a valid expiry.
  h.setNow(1_000_001);
  const after = await h.auth.renew("space-2", "r");
  assert.equal(after.ok, false);
  assert.equal((after as any).code, "invalid_lease_duration");
  assert.equal(h.sent.length, 1);
  assert.equal(h.auth.hasPending("space-2"), false);
});

test("constructor fails closed on a default or finite max that cannot produce a valid expiry now", () => {
  const base = { connector: "laptop", host: "h", now: () => 1_000_000, pendingMs: 5 * 60_000, notify: async () => {} };
  assert.throws(
    () => new LeaseAuthority({ ...base, defaultLeaseMs: MAX_DATE_MS, maxLeaseMs: null }),
    /--lease .* cannot produce a valid expiry date/,
  );
  assert.throws(
    () => new LeaseAuthority({ ...base, defaultLeaseMs: H, maxLeaseMs: MAX_DATE_MS }),
    /--max-lease .* cannot produce a valid expiry date/,
  );
  // The longest representable default at this clock constructs fine.
  const longest = MAX_DATE_MS - 1_000_000 - 5 * 60_000;
  assert.doesNotThrow(() => new LeaseAuthority({ ...base, defaultLeaseMs: longest, maxLeaseMs: null }));
});

// --------------------------------------------------------------------
// Auth reads the daemon clock once: the instant that proves the OTP is still
// inside the pending window is the instant the active lease clock starts.
// --------------------------------------------------------------------

/**
 * A LeaseAuthority whose clock returns a fixed value until `script()` arms a
 * sequence of readings that are consumed one per call (the last repeats).
 * Every call is counted, so a test can prove how many times a code path reads.
 */
function makeScriptedClockAuth(initialNow: number, pendingMs: number) {
  let fixed = initialNow;
  let queue: number[] = [];
  let reads = 0;
  const auth = new LeaseAuthority({
    connector: "laptop",
    host: "test-host",
    defaultLeaseMs: H,
    maxLeaseMs: null,
    pendingMs,
    maxAttempts: 5,
    renewCooldownMs: 0,
    now: () => {
      reads += 1;
      if (queue.length === 0) return fixed;
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    mintToken: () => "TESTTOKEN-256bit",
    mintOtp: () => "K7M2-QP9A",
    notify: async () => {},
  });
  return {
    auth,
    reads: () => reads,
    script: (readings: number[]) => { queue = [...readings]; },
  };
}

test("auth uses one clock reading for the pending-window check and the expiry, so a clock crossing the window boundary between reads cannot mint an invalid Date", async () => {
  const pendingMs = 5 * 60_000;
  // Renew at 1_000_000: the latest possible auth (1_300_000) lands exactly on
  // the Date limit, so the duration is admitted. The scripted clock then
  // returns 1_299_999 (inside the window) followed by 1_300_001 (outside it):
  // a second read at auth time would compute MAX_DATE_MS + 1, an invalid Date.
  const { auth, reads, script } = makeScriptedClockAuth(1_000_000, pendingMs);
  const longest = MAX_DATE_MS - 1_000_000 - pendingMs;
  const r = await auth.renew("space-1", "r", longest);
  assert.equal(r.ok, true);
  const token = (r as any).leaseToken as string;

  // Arm the boundary-crossing sequence for the auth call only. The unfixed
  // two-read path consumed both values and installed MAX_DATE_MS + 1.
  script([1_299_999, 1_300_001]);
  const before = reads();
  const a = auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(reads() - before, 1, "verifyAuth must read the clock exactly once");
  assert.equal(a.ok, true);
  const expiresAt = (a as any).leaseExpiresAt as number;
  assert.equal(expiresAt, MAX_DATE_MS - 1, "expiry derives from the same instant that admitted the OTP");
  assert.equal(Number.isSafeInteger(expiresAt), true);
  assert.equal(Number.isNaN(new Date(expiresAt).getTime()), false);
  assert.equal(new Date(expiresAt).toISOString(), "+275760-09-12T23:59:59.999Z");
  // The clock now reads 1_300_001: the lease is installed and honored until its expiry.
  assert.equal(auth.authorizeStart("space-1", token).ok, true);
});

test("defensive: an unrepresentable expiry at auth time fails closed — no active lease, no success, pending consumed", async () => {
  // Unreachable through renew (which admits only durations representable at
  // the END of the window), so the bound duration is tampered with directly to
  // exercise the guard: a matched OTP must never install an invalid Date.
  const h = makeAuth({ leaseMs: H, maxLeaseMs: null });
  const r = await h.auth.renew("space-1", "r", H);
  assert.equal(r.ok, true);
  const token = (r as any).leaseToken as string;
  (h.auth as any).pending.get("space-1").leaseDurationMs = MAX_DATE_MS;

  const a = h.auth.verifyAuth("space-1", token, "K7M2-QP9A");
  assert.equal(a.ok, false);
  assert.equal((a as any).code, "auth_failed");
  assert.match((a as any).message, /cannot produce a valid expiry date/);
  assert.equal(h.auth.authorizeStart("space-1", token).ok, false, "no active lease may be installed");
  assert.equal(h.auth.hasPending("space-1"), false, "the matched OTP is consumed, not left redeemable");
  // Recovery is a fresh renew, which re-validates the duration against the live clock.
  const again = await h.auth.renew("space-1", "r", H);
  assert.equal(again.ok, true);
});
