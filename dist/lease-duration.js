/**
 * Lease duration grammar + policy (connector lease auth).
 *
 * One normalized representation crosses the wire and lives in memory:
 *
 *   type LeaseDurationMs = number | null
 *     positive safe-integer milliseconds  → finite lease
 *     null                                → indefinitely (no time expiry)
 *
 * `undefined` is allowed only on a renew REQUEST and means "use the daemon's
 * configured finite default". A missing field is never read as indefinite.
 *
 * CLI spelling (both `--lease`/`--max-lease` here and Persona's `--for`):
 *   <n><unit>   n = positive integer, unit = s|m|h|d, lower-case, no spaces
 *   indefinitely  (only where explicitly allowed: --max-lease, --for)
 *
 * There is no product ceiling on a finite duration. A finite value is valid
 * when it is a positive safe integer AND, from the instant its lease clock
 * would start, it produces an expiry that is a valid JavaScript `Date`. That
 * second check depends on the clock, so it is applied where the clock is
 * known (`leaseExpiryAt`), not baked into the grammar.
 *
 * Deliberately lease-specific — not a general duration library.
 */
export const INDEFINITELY = "indefinitely";
const FINITE_RE = /^([1-9]\d*)(s|m|h|d)$/;
const UNIT_MS = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};
/** True for a finite lease value that is valid on the wire: positive safe-integer ms. */
export function isValidFiniteLeaseMs(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** Validate a raw wire value: `null` (indefinite) or a valid finite number. */
export function isValidLeaseDurationMs(value) {
    return value === null || isValidFiniteLeaseMs(value);
}
/**
 * The epoch-ms expiry a finite lease would have if its clock started at
 * `atMs`, or `null` when that instant cannot be represented: the sum must
 * remain a safe integer and must be a valid JavaScript `Date` (the engine
 * limit is ±8.64e15 ms from the epoch; `new Date(t).getTime()` is NaN past it).
 */
export function leaseExpiryAt(atMs, durationMs) {
    const expiresAt = atMs + durationMs;
    if (!Number.isSafeInteger(expiresAt) || Number.isNaN(new Date(expiresAt).getTime()))
        return null;
    return expiresAt;
}
/**
 * Parse a CLI duration. Throws an Error with an operator-facing message on
 * anything outside the grammar: zero, signs, decimals, bare numbers, compound
 * or spaced values, upper-case units, unknown units, or a value whose
 * millisecond count overflows a safe integer. Whether the value can produce a
 * valid expiry from a given clock is checked separately (`leaseExpiryAt`,
 * `validateLeasePolicy`).
 */
export function parseLeaseDuration(raw, opts) {
    const value = raw.trim();
    const allowed = opts.allowIndefinite
        ? "use e.g. 30m, 2h, 8h, 2d, or 'indefinitely'"
        : "use e.g. 30m, 2h, 8h, 2d";
    if (value === INDEFINITELY) {
        if (opts.allowIndefinite)
            return null;
        throw new Error(`${opts.flag} cannot be '${INDEFINITELY}' (${allowed})`);
    }
    const m = value.match(FINITE_RE);
    if (!m) {
        throw new Error(`invalid ${opts.flag} duration '${raw}' (${allowed})`);
    }
    const n = Number(m[1]);
    const ms = n * UNIT_MS[m[2]];
    if (!isValidFiniteLeaseMs(ms)) {
        throw new Error(`${opts.flag} duration '${raw}' is too long (not a safe integer number of milliseconds)`);
    }
    return ms;
}
/**
 * Canonical human label for a normalized duration: the largest unit that
 * divides it exactly (`2d`, `8h`, `30m`, `90s`), otherwise the exact
 * millisecond count (`1499ms`) — never rounded, so the label always names
 * the precise value bound into the approval. `null` → `indefinitely`.
 */
export function formatLeaseDuration(ms) {
    if (ms === null)
        return INDEFINITELY;
    for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1_000]]) {
        if (ms % size === 0)
            return `${ms / size}${unit}`;
    }
    return `${ms}ms`;
}
/**
 * Validate the daemon's lease policy. The default must be finite and, when
 * the maximum is finite, must not exceed it. Both must be able to produce a
 * valid expiry for a lease clock starting at `latestStartMs` (the end of the
 * pending approval window for a renew issued now). Throws with an
 * operator-facing message so startup fails closed.
 */
export function validateLeasePolicy(policy, latestStartMs) {
    if (!isValidFiniteLeaseMs(policy.defaultMs)) {
        throw new Error("--lease must be a finite positive duration (it is the default when a request omits one)");
    }
    if (policy.maxMs !== null && !isValidFiniteLeaseMs(policy.maxMs)) {
        throw new Error("--max-lease must be a positive duration or 'indefinitely'");
    }
    if (policy.maxMs !== null && policy.defaultMs > policy.maxMs) {
        throw new Error(`--lease ${formatLeaseDuration(policy.defaultMs)} exceeds --max-lease ${formatLeaseDuration(policy.maxMs)}`);
    }
    if (leaseExpiryAt(latestStartMs, policy.defaultMs) === null) {
        throw new Error(`--lease ${formatLeaseDuration(policy.defaultMs)} cannot produce a valid expiry date from now`);
    }
    if (policy.maxMs !== null && leaseExpiryAt(latestStartMs, policy.maxMs) === null) {
        throw new Error(`--max-lease ${formatLeaseDuration(policy.maxMs)} cannot produce a valid expiry date from now`);
    }
    return policy;
}
