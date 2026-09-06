import type { BOUNDED_TRANSFER } from "./flow-control.js";

/**
 * provider -> daemon
 *
 * `start` carries optional `spaceId`/`leaseToken`: old daemons ignore unknown
 * fields (existing behavior), auth-enabled daemons gate on them. `renew`/`auth`
 * are v1 lease-token auth control ops correlated by the existing `commandId`
 * (no separate request/response system — see design/connector-lease-token-auth).
 *
 * Lease duration (additive, optional):
 *   `renew.leaseDurationMs`  omitted → this daemon's finite `--lease` default;
 *                            positive safe-integer ms → finite request;
 *                            null → indefinitely. Enforced against `--max-lease`.
 *   `renew_result.leaseDurationMs` / `auth_result.leaseDurationMs` echo the
 *   duration bound to the pending approval / active lease.
 *   `auth_result.leaseExpiresAt` is epoch ms, or null for an indefinite lease.
 * Old daemons ignore the request field and omit the echoes; old Persona
 * ignores the additive result fields (it never requests a duration, so the
 * daemon's default — always finite — yields a numeric `leaseExpiresAt`).
 */
export type UplinkCommandFrame =
  | {
      type: "start";
      commandId: string;
      cmd: string[];
      cwd?: string;
      env?: Record<string, string>;
      spaceId?: string;
      leaseToken?: string;
      flowControl?: typeof BOUNDED_TRANSFER;
    }
  | { type: "output_credit"; commandId: string; bytes: number }
  | { type: "stdin"; commandId: string; data: string }
  | { type: "stdin_close"; commandId: string }
  | { type: "cancel"; commandId: string }
  | {
      type: "renew";
      commandId: string;
      spaceId: string;
      message: string;
      leaseDurationMs?: number | null;
    }
  | { type: "auth"; commandId: string; spaceId: string; leaseToken: string; otp: string }
  | { type: "ping" };

/** daemon -> provider */
export type UplinkResultFrame =
  | { type: "ready"; capabilities?: string[] }
  | { type: "started"; commandId: string; flowControl?: typeof BOUNDED_TRANSFER }
  | { type: "stdin_credit"; commandId: string; bytes: number }
  | { type: "stdout"; commandId: string; data: string }
  | { type: "stderr"; commandId: string; data: string }
  | { type: "exit"; commandId: string; code: number }
  | { type: "error"; commandId: string; code: string; message: string }
  | {
      type: "renew_result";
      commandId: string;
      leaseToken: string;
      pendingExpiresAt: number;
      leaseDurationMs: number | null;
    }
  | {
      type: "auth_result";
      commandId: string;
      leaseExpiresAt: number | null;
      leaseDurationMs: number | null;
    }
  | { type: "pong" };
