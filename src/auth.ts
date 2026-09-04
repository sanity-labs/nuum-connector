/**
 * Lease-token authorization core (opt-in connector auth, v1).
 *
 * This module is the connector-local authorization layer described in
 * design/connector-lease-token-auth.md. It is deliberately pure and
 * clock-injected so it can be unit-tested without sockets, timers, or a
 * real notification carrier:
 *
 *   - `authorizeStart` gates `exec` on an active, unexpired lease for a space.
 *   - `renew` resolves + enforces the requested lease duration against this
 *     daemon's policy, mints a >=256-bit lease token, stores only its hash as
 *     a pending renewal bound to that exact duration, generates an OTP, and
 *     asks the injected notifier to deliver it (showing the same duration).
 *   - `verifyAuth` checks the hidden token + OTP and promotes pending → active,
 *     starting the lease clock (or installing an indefinite lease) using the
 *     duration bound at renew time.
 *
 * Security properties (mirrors the design doc):
 *   - Only token/OTP HASHES are held, in memory. Restart clears everything —
 *     including indefinite leases.
 *   - OTP alone is useless (needs the matching hidden token) and vice-versa.
 *   - Newest renewal for a space replaces the prior pending one.
 *   - Successful auth installs ONE active lease per space, replacing any prior
 *     active lease for that space.
 *   - Wrong OTP (or wrong hidden token) burns an attempt; the limit blocks it.
 *   - The daemon is the policy authority: a request above `--max-lease` is
 *     rejected before any state changes or notification. It is never clamped,
 *     because the human approves the exact duration shown in the notification.
 *   - A finite duration is accepted only if a successful auth at ANY instant
 *     inside the pending approval window would yield an expiry that is a valid
 *     epoch-ms `Date`. This is re-checked on every renew with the daemon's own
 *     clock, so a long-running daemon never relies on startup-time validation.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  formatLeaseDuration,
  isValidLeaseDurationMs,
  leaseExpiryAt,
  validateLeasePolicy,
  type LeaseDurationMs,
} from "./lease-duration.js";

// Crockford base32, minus the ambiguous I L O U — read-aloud friendly.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface NotificationPayload {
  connector: string;
  host: string;
  spaceId: string;
  /** Exact resolved lease duration bound to this approval (null = indefinitely). */
  leaseDurationMs: LeaseDurationMs;
  /** Human label for `leaseDurationMs`, e.g. "8h", "30m", "indefinitely". */
  leaseLabel: string;
  reason: string;
  otp: string;
  /** Epoch ms the pending renewal expires. */
  pendingExpiresAt: number;
}

export type Notifier = (payload: NotificationPayload) => Promise<void>;

export interface LeaseAuthorityConfig {
  /** Connector slug (for notification text). */
  connector: string;
  /** Host name (for notification text). */
  host: string;
  /** Finite default lease duration in ms, used when a request omits one (default 8h). */
  defaultLeaseMs?: number;
  /** Hard maximum lease duration in ms; `null` allows indefinite requests.
   *  Defaults to `defaultLeaseMs` (today's fixed upper bound). */
  maxLeaseMs?: LeaseDurationMs;
  /** Pending renewal lifetime in ms (default 5m). Independent of lease duration. */
  pendingMs?: number;
  /** Max OTP/token attempts before a pending renewal is blocked (default 5). */
  maxAttempts?: number;
  /** Minimum gap between renews for one space, ms (default 30s) — anti-spam. */
  renewCooldownMs?: number;
  /** Delivers the OTP out-of-band. Required. */
  notify: Notifier;
  /** Injectable clock (default Date.now) for tests. */
  now?: () => number;
  /** Injectable token minter (default 32 random bytes, base64url). */
  mintToken?: () => string;
  /** Injectable OTP minter (default 8 Crockford chars XXXX-XXXX). */
  mintOtp?: () => string;
}

interface PendingRenewal {
  tokenHash: string;
  spaceId: string;
  otpHash: string;
  message: string;
  /** Exact duration the human is asked to approve; used verbatim at auth. */
  leaseDurationMs: LeaseDurationMs;
  pendingExpiresAt: number;
  attempts: number;
}

interface ActiveLease {
  tokenHash: string;
  spaceId: string;
  leaseDurationMs: LeaseDurationMs;
  /** Epoch ms; `null` = indefinite (lives until replaced or daemon restart). */
  leaseExpiresAt: number | null;
}

export type StartDecision =
  | { ok: true }
  | { ok: false; code: "auth_required"; message: string };

export type RenewResult =
  | { ok: true; leaseToken: string; pendingExpiresAt: number; leaseDurationMs: LeaseDurationMs }
  | {
      ok: false;
      code: "rate_limited" | "notify_failed" | "invalid_lease_duration" | "lease_duration_exceeds_max";
      message: string;
    };

export type AuthResult =
  | { ok: true; leaseExpiresAt: number | null; leaseDurationMs: LeaseDurationMs }
  | { ok: false; code: "auth_failed"; message: string };

const DEFAULT_LEASE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_PENDING_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RENEW_COOLDOWN_MS = 30 * 1000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Constant-time string compare (equal-length hex digests). */
function hashesEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function defaultMintToken(): string {
  // 32 bytes = 256 bits, base64url — never the 12-char connector key generator.
  return randomBytes(32).toString("base64url");
}

function defaultMintOtp(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i] % 32];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/**
 * Normalize a user-typed OTP for comparison: uppercase, drop separators, and
 * fold the Crockford-ambiguous characters (I/L→1, O→0) so a human reading the
 * code aloud can't trivially fail on glyph confusion.
 */
export function normalizeOtp(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

export class LeaseAuthority {
  private readonly cfg: Required<
    Omit<LeaseAuthorityConfig, "notify">
  > & { notify: Notifier };
  private readonly pending = new Map<string, PendingRenewal>(); // by spaceId
  private readonly active = new Map<string, ActiveLease>(); // by spaceId
  private readonly lastRenewAt = new Map<string, number>(); // by spaceId

  constructor(config: LeaseAuthorityConfig) {
    const defaultLeaseMs = config.defaultLeaseMs ?? DEFAULT_LEASE_MS;
    // Omitted maximum → equals the default: exactly today's fixed upper bound.
    const maxLeaseMs = config.maxLeaseMs === undefined ? defaultLeaseMs : config.maxLeaseMs;
    const pendingMs = config.pendingMs ?? DEFAULT_PENDING_MS;
    const now = config.now ?? Date.now;
    // Fail closed at startup: the default (and a finite max) must be able to
    // produce a valid expiry for a renew issued now and approved at the very
    // end of its pending window. Renew re-checks this against the live clock.
    validateLeasePolicy({ defaultMs: defaultLeaseMs, maxMs: maxLeaseMs }, now() + pendingMs);
    this.cfg = {
      connector: config.connector,
      host: config.host,
      defaultLeaseMs,
      maxLeaseMs,
      pendingMs,
      maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      renewCooldownMs: config.renewCooldownMs ?? DEFAULT_RENEW_COOLDOWN_MS,
      notify: config.notify,
      now,
      mintToken: config.mintToken ?? defaultMintToken,
      mintOtp: config.mintOtp ?? defaultMintOtp,
    };
  }

  /** Human-readable policy summary for startup logs (no secrets). */
  describePolicy(): string {
    return `default ${formatLeaseDuration(this.cfg.defaultLeaseMs)}, max ${formatLeaseDuration(this.cfg.maxLeaseMs)}`;
  }

  /** Decide whether an exec `start` may run for this space + hidden token. */
  authorizeStart(spaceId: string, leaseToken: string | undefined): StartDecision {
    if (!leaseToken) {
      return { ok: false, code: "auth_required", message: "no lease token" };
    }
    const lease = this.active.get(spaceId);
    if (!lease || lease.spaceId !== spaceId || !hashesEqual(sha256(leaseToken), lease.tokenHash)) {
      return { ok: false, code: "auth_required", message: "no active lease" };
    }
    if (lease.leaseExpiresAt !== null && this.cfg.now() >= lease.leaseExpiresAt) {
      this.active.delete(spaceId);
      return { ok: false, code: "auth_required", message: "lease expired" };
    }
    return { ok: true };
  }

  /**
   * Resolve the requested duration against policy at daemon time `now`.
   * `undefined` (field omitted) → the finite default. Anything that is not
   * `null` or a valid finite value is invalid. A finite value (default
   * included) is also invalid when a successful auth at any instant inside
   * the pending window — latest `now + pendingMs` — could not produce an
   * expiry that is a valid epoch-ms `Date`; expiry grows with the auth
   * instant, so checking the latest one covers the whole window. A valid
   * value above the maximum is rejected, never clamped.
   */
  resolveLeaseDuration(
    requested: unknown,
    now: number,
  ):
    | { ok: true; leaseDurationMs: LeaseDurationMs }
    | { ok: false; code: "invalid_lease_duration" | "lease_duration_exceeds_max"; message: string } {
    const value: unknown = requested === undefined ? this.cfg.defaultLeaseMs : requested;
    if (!isValidLeaseDurationMs(value)) {
      return {
        ok: false,
        code: "invalid_lease_duration",
        message: "invalid lease duration: expected positive integer milliseconds or null (indefinitely)",
      };
    }
    if (value !== null && leaseExpiryAt(now + this.cfg.pendingMs, value) === null) {
      return {
        ok: false,
        code: "invalid_lease_duration",
        message:
          `invalid lease duration: ${formatLeaseDuration(value)} cannot produce a valid expiry date ` +
          `from this connector's clock; request a shorter lease`,
      };
    }
    const max = this.cfg.maxLeaseMs;
    if (max !== null && (value === null || value > max)) {
      return {
        ok: false,
        code: "lease_duration_exceeds_max",
        message:
          `requested lease ${formatLeaseDuration(value)} exceeds this connector's maximum ` +
          `${formatLeaseDuration(max)}; request a shorter lease`,
      };
    }
    return { ok: true, leaseDurationMs: value };
  }

  /**
   * Create (or replace) a pending renewal for a space: resolve + enforce the
   * requested duration, mint a lease token + OTP, store hashes bound to that
   * duration, notify the human (showing it), return the raw token to persona.
   *
   * `requestedLeaseDurationMs` is the raw wire value: omitted (`undefined`)
   * means the daemon default; `null` means indefinitely; a positive
   * safe-integer means that many milliseconds. It is validated here.
   */
  async renew(spaceId: string, message: string, requestedLeaseDurationMs?: unknown): Promise<RenewResult> {
    const now = this.cfg.now();
    // Policy first: a rejected request must leave pending/active/cooldown state untouched.
    const resolved = this.resolveLeaseDuration(requestedLeaseDurationMs, now);
    if (!resolved.ok) return resolved;
    const leaseDurationMs = resolved.leaseDurationMs;

    const last = this.lastRenewAt.get(spaceId);
    if (last !== undefined && now - last < this.cfg.renewCooldownMs) {
      return {
        ok: false,
        code: "rate_limited",
        message: "renew requested too frequently; try again shortly",
      };
    }

    const leaseToken = this.cfg.mintToken();
    const otp = this.cfg.mintOtp();
    const pendingExpiresAt = now + this.cfg.pendingMs;
    const renewal: PendingRenewal = {
      tokenHash: sha256(leaseToken),
      spaceId,
      otpHash: sha256(normalizeOtp(otp)),
      message,
      leaseDurationMs,
      pendingExpiresAt,
      attempts: 0,
    };
    // Newest renewal wins — replace any prior pending for this space.
    this.pending.set(spaceId, renewal);

    try {
      await this.cfg.notify({
        connector: this.cfg.connector,
        host: this.cfg.host,
        spaceId,
        leaseDurationMs,
        leaseLabel: formatLeaseDuration(leaseDurationMs),
        reason: message,
        otp,
        pendingExpiresAt,
      });
    } catch (e) {
      // No notification means the human never receives the OTP — the pending
      // renewal is useless, so drop it and surface the failure.
      this.pending.delete(spaceId);
      return {
        ok: false,
        code: "notify_failed",
        message: `notification failed: ${(e as Error).message}`,
      };
    }

    this.lastRenewAt.set(spaceId, now);
    return { ok: true, leaseToken, pendingExpiresAt, leaseDurationMs };
  }

  /**
   * Verify hidden token + OTP; on success promote pending → active lease using
   * the duration bound at renew time. The lease clock starts NOW (successful
   * auth), not at renew. The new lease replaces any prior active lease for
   * this space.
   */
  verifyAuth(spaceId: string, leaseToken: string, otp: string): AuthResult {
    const pending = this.pending.get(spaceId);
    if (!pending) {
      return { ok: false, code: "auth_failed", message: "no pending renewal" };
    }
    // ONE clock reading decides both whether the OTP is still inside the
    // pending window and, on success, where the active lease clock starts. A
    // second reading could land past the window boundary that renew's
    // representability check relied on.
    const now = this.cfg.now();
    if (now >= pending.pendingExpiresAt) {
      this.pending.delete(spaceId);
      return { ok: false, code: "auth_failed", message: "pending renewal expired" };
    }

    const tokenMatches = hashesEqual(sha256(leaseToken), pending.tokenHash);
    const otpMatches = hashesEqual(sha256(normalizeOtp(otp)), pending.otpHash);
    if (!tokenMatches || !otpMatches) {
      pending.attempts += 1;
      if (pending.attempts >= this.cfg.maxAttempts) {
        this.pending.delete(spaceId);
        return {
          ok: false,
          code: "auth_failed",
          message: "too many failed attempts; pending renewal blocked",
        };
      }
      return { ok: false, code: "auth_failed", message: "invalid token or code" };
    }

    // The matched token + OTP are single-use: consumed here whatever follows.
    this.pending.delete(spaceId);
    const leaseDurationMs = pending.leaseDurationMs;
    // Representable by construction: renew accepted this duration only if an
    // auth at the END of the pending window yields a valid Date, and `now` is
    // strictly inside that window (checked above). Still derive the expiry
    // through the same guard rather than trusting the addition, and fail
    // closed — no active lease, no success — if it ever comes back null.
    const leaseExpiresAt = leaseDurationMs === null ? null : leaseExpiryAt(now, leaseDurationMs);
    if (leaseDurationMs !== null && leaseExpiresAt === null) {
      return {
        ok: false,
        code: "auth_failed",
        message:
          `lease ${formatLeaseDuration(leaseDurationMs)} cannot produce a valid expiry date ` +
          `from this connector's clock; renew again`,
      };
    }
    this.active.set(spaceId, {
      tokenHash: pending.tokenHash,
      spaceId,
      leaseDurationMs,
      leaseExpiresAt,
    });
    return { ok: true, leaseExpiresAt, leaseDurationMs };
  }

  // --- introspection (tests / audit) ---

  hasPending(spaceId: string): boolean {
    const p = this.pending.get(spaceId);
    return !!p && this.cfg.now() < p.pendingExpiresAt;
  }

  hasActiveLease(spaceId: string, leaseToken: string): boolean {
    return this.authorizeStart(spaceId, leaseToken).ok;
  }
}
