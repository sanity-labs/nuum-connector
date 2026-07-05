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

interface Harness {
  auth: LeaseAuthority;
  sent: NotificationPayload[];
  setNow: (t: number) => void;
  failNotify: (fail: boolean) => void;
}

function makeAuth(overrides: {
  leaseMs?: number;
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
    leaseMs: overrides.leaseMs ?? 8 * 3600_000,
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
