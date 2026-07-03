/** provider -> daemon */
export type UplinkCommandFrame =
  | { type: "start"; commandId: string; cmd: string[]; cwd?: string; env?: Record<string, string> }
  | { type: "stdin"; commandId: string; data: string }
  | { type: "stdin_close"; commandId: string }
  | { type: "cancel"; commandId: string }
  | { type: "ping" };

/** daemon -> provider */
export type UplinkResultFrame =
  | { type: "ready" }
  | { type: "started"; commandId: string }
  | { type: "stdout"; commandId: string; data: string }
  | { type: "stderr"; commandId: string; data: string }
  | { type: "exit"; commandId: string; code: number }
  | { type: "error"; commandId: string; code: string; message: string }
  | { type: "pong" };
