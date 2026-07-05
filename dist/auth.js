/**
 * Lease-token authorization core (opt-in connector auth, v1).
 *
 * This module is the connector-local authorization layer described in
 * design/connector-lease-token-auth.md. It is deliberately pure and
 * clock-injected so it can be unit-tested without sockets, timers, or a
 * real notification carrier:
 *
 *   - `authorizeStart` gates `exec` on an active, unexpired lease for a space.
 *   - `renew` mints a >=256-bit lease token, stores only its hash as a pending
 *     renewal, generates an OTP, and asks the injected notifier to deliver it.
 *   - `verifyAuth` checks the hidden token + OTP and promotes pending → active.
 *
 * Security properties (mirrors the design doc):
 *   - Only token/OTP HASHES are held, in memory. Restart clears everything.
 *   - OTP alone is useless (needs the matching hidden token) and vice-versa.
 *   - Newest renewal for a space replaces the prior pending one.
 *   - Wrong OTP (or wrong hidden token) burns an attempt; the limit blocks it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// Crockford base32, minus the ambiguous I L O U — read-aloud friendly.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DEFAULT_LEASE_MS = 8 * 60 * 60 * 1000;
const DEFAULT_PENDING_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RENEW_COOLDOWN_MS = 30 * 1000;
function sha256(input) {
    return createHash("sha256").update(input, "utf8").digest("hex");
}
/** Constant-time string compare (equal-length hex digests). */
function hashesEqual(a, b) {
    const ab = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
function defaultMintToken() {
    // 32 bytes = 256 bits, base64url — never the 12-char connector key generator.
    return randomBytes(32).toString("base64url");
}
function defaultMintOtp() {
    const bytes = randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++)
        out += CROCKFORD[bytes[i] % 32];
    return `${out.slice(0, 4)}-${out.slice(4)}`;
}
/**
 * Normalize a user-typed OTP for comparison: uppercase, drop separators, and
 * fold the Crockford-ambiguous characters (I/L→1, O→0) so a human reading the
 * code aloud can't trivially fail on glyph confusion.
 */
export function normalizeOtp(raw) {
    return raw
        .toUpperCase()
        .replace(/[\s-]/g, "")
        .replace(/[IL]/g, "1")
        .replace(/O/g, "0");
}
export class LeaseAuthority {
    cfg;
    pending = new Map(); // by spaceId
    active = new Map(); // by tokenHash
    lastRenewAt = new Map(); // by spaceId
    constructor(config) {
        this.cfg = {
            connector: config.connector,
            host: config.host,
            leaseMs: config.leaseMs ?? DEFAULT_LEASE_MS,
            leaseLabel: config.leaseLabel ?? "8h",
            pendingMs: config.pendingMs ?? DEFAULT_PENDING_MS,
            maxAttempts: config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
            renewCooldownMs: config.renewCooldownMs ?? DEFAULT_RENEW_COOLDOWN_MS,
            notify: config.notify,
            now: config.now ?? Date.now,
            mintToken: config.mintToken ?? defaultMintToken,
            mintOtp: config.mintOtp ?? defaultMintOtp,
        };
    }
    /** Decide whether an exec `start` may run for this space + hidden token. */
    authorizeStart(spaceId, leaseToken) {
        if (!leaseToken) {
            return { ok: false, code: "auth_required", message: "no lease token" };
        }
        const tokenHash = sha256(leaseToken);
        const lease = this.active.get(tokenHash);
        if (!lease || lease.spaceId !== spaceId) {
            return { ok: false, code: "auth_required", message: "no active lease" };
        }
        if (this.cfg.now() >= lease.leaseExpiresAt) {
            this.active.delete(tokenHash);
            return { ok: false, code: "auth_required", message: "lease expired" };
        }
        return { ok: true };
    }
    /**
     * Create (or replace) a pending renewal for a space: mint a lease token +
     * OTP, store hashes, notify the human, return the raw token to persona.
     */
    async renew(spaceId, message) {
        const now = this.cfg.now();
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
        const renewal = {
            tokenHash: sha256(leaseToken),
            spaceId,
            otpHash: sha256(normalizeOtp(otp)),
            message,
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
                leaseLabel: this.cfg.leaseLabel,
                reason: message,
                otp,
                pendingExpiresAt,
            });
        }
        catch (e) {
            // No notification means the human never receives the OTP — the pending
            // renewal is useless, so drop it and surface the failure.
            this.pending.delete(spaceId);
            return {
                ok: false,
                code: "notify_failed",
                message: `notification failed: ${e.message}`,
            };
        }
        this.lastRenewAt.set(spaceId, now);
        return { ok: true, leaseToken, pendingExpiresAt };
    }
    /** Verify hidden token + OTP; on success promote pending → active lease. */
    verifyAuth(spaceId, leaseToken, otp) {
        const pending = this.pending.get(spaceId);
        if (!pending) {
            return { ok: false, code: "auth_failed", message: "no pending renewal" };
        }
        if (this.cfg.now() >= pending.pendingExpiresAt) {
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
        this.pending.delete(spaceId);
        const leaseExpiresAt = this.cfg.now() + this.cfg.leaseMs;
        this.active.set(pending.tokenHash, {
            tokenHash: pending.tokenHash,
            spaceId,
            leaseExpiresAt,
        });
        return { ok: true, leaseExpiresAt };
    }
    // --- introspection (tests / audit) ---
    hasPending(spaceId) {
        const p = this.pending.get(spaceId);
        return !!p && this.cfg.now() < p.pendingExpiresAt;
    }
    hasActiveLease(spaceId, leaseToken) {
        return this.authorizeStart(spaceId, leaseToken).ok;
    }
}
