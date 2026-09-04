/**
 * Notification text: the human approves against the exact bound duration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatNotificationBody, parseNotifyConfig } from "../src/ntfy.ts";
import { formatLeaseDuration } from "../src/lease-duration.ts";

const base = {
  connector: "my-host",
  host: "my-host.local",
  spaceId: "space-1",
  reason: "debug production issue",
  otp: "ABCD-1234",
  pendingExpiresAt: 1_000_000 + 5 * 60_000,
};

test("finite lease shows the exact resolved duration and the separate OTP window", () => {
  const body = formatNotificationBody({ ...base, leaseDurationMs: 1_800_000, leaseLabel: "30m" }, 1_000_000);
  assert.match(body, /^Lease: 30m$/m);
  assert.match(body, /^Code: ABCD-1234$/m);
  assert.match(body, /^Code expires: 5 minutes$/m);
  assert.match(body, /^Space: space-1$/m);
  assert.match(body, /^Reason: debug production issue$/m);
});

test("non-whole-second leases are shown as exact milliseconds, never rounded", () => {
  for (const [ms, label] of [[1, "1ms"], [1499, "1499ms"], [1500, "1500ms"]] as const) {
    const body = formatNotificationBody({ ...base, leaseDurationMs: ms, leaseLabel: formatLeaseDuration(ms) }, 1_000_000);
    assert.match(body, new RegExp(`^Lease: ${label}$`, "m"), `expected exact label for ${ms}`);
    assert.doesNotMatch(body, /^Lease: [012]s$/m);
  }
});

test("indefinite lease is spelled out with its caveat", () => {
  const body = formatNotificationBody({ ...base, leaseDurationMs: null, leaseLabel: "indefinitely" }, 1_000_000);
  assert.match(body, /^Lease: indefinitely \(no expiry; lasts until replaced or the connector restarts\)$/m);
});

test("parseNotifyConfig resolves topics and URLs", () => {
  assert.equal(parseNotifyConfig("ntfy:mytopic").url, "https://ntfy.sh/mytopic");
  assert.equal(parseNotifyConfig("ntfy:https://n.example/topic/").url, "https://n.example/topic");
  assert.throws(() => parseNotifyConfig(undefined), /--notify is required/);
});
