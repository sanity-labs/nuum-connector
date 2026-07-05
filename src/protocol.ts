/**
 * provider -> daemon
 *
 * `start` carries optional `spaceId`/`leaseToken`: old daemons ignore unknown
 * fields (existing behavior), auth-enabled daemons gate on them. `renew`/`auth`
 * are v1 lease-token auth control ops correlated by the existing `commandId`
 * (no separate request/response system — see design/connector-lease-token-auth).
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
    }
  | { type: "stdin"; commandId: string; data: string }
  | { type: "stdin_close"; commandId: string }
  | { type: "cancel"; commandId: string }
  | { type: "renew"; commandId: string; spaceId: string; message: string }
  | { type: "auth"; commandId: string; spaceId: string; leaseToken: string; otp: string }
  | { type: "ping" };

/** daemon -> provider */
export type UplinkResultFrame =
  | { type: "ready" }
  | { type: "started"; commandId: string }
  | { type: "stdout"; commandId: string; data: string }
  | { type: "stderr"; commandId: string; data: string }
  | { type: "exit"; commandId: string; code: number }
  | { type: "error"; commandId: string; code: string; message: string }
  | { type: "renew_result"; commandId: string; leaseToken: string; pendingExpiresAt: number }
  | { type: "auth_result"; commandId: string; leaseExpiresAt: number }
  | { type: "pong" };
