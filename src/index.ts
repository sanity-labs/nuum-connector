#!/usr/bin/env node
/**
 * Nuum connector daemon: runs on a remote host (laptop, GPU box, on-prem
 * server) and dials into the Nuum/Persona connector-provider over a reverse
 * WebSocket, allowing agents to execute commands on this machine.
 *
 * Usage: nuum <slug> --url <server-url> [--cwd /path]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import type { UplinkCommandFrame, UplinkResultFrame } from "./protocol.js";

// --- Config storage ---

interface ConnectConfig {
  slug: string;
  url: string;
  key: string;
}

function configDir(): string {
  const dir = join(homedir(), ".nuum");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath(slug: string): string {
  return join(configDir(), slug + ".json");
}

function loadConfig(slug: string): ConnectConfig | null {
  const path = configPath(slug);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ConnectConfig;
  } catch {
    return null;
  }
}

function saveConfig(config: ConnectConfig): void {
  writeFileSync(configPath(config.slug), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

function generateKey(): string {
  return randomBytes(9).toString("base64url").slice(0, 12);
}

// --- Running commands (multiplexed by commandId) ---

const SIGKILL_DELAY = 5_000;
const MAX_OUTPUT = 10 * 1024 * 1024; // 10MB per command

interface RunningCommand {
  child: ChildProcess;
  bytes: number;
  killed: boolean;
}

const running = new Map<string, RunningCommand>();

/** Safe send: no-op if socket is closed. */
function safeSend(ws: WebSocket | null, frame: UplinkResultFrame | UplinkCommandFrame): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

function startCommand(
  ws: WebSocket,
  commandId: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string> | undefined,
): void {
  if (running.has(commandId)) return; // duplicate start
  const command = cmd.join(" ");
  console.log(`[cmd:${commandId}] ${command}`);

  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
  });
  const entry: RunningCommand = { child, bytes: 0, killed: false };
  running.set(commandId, entry);

  safeSend(ws, { type: "started", commandId });

  function killProc(reason: string): void {
    if (entry.killed) return;
    entry.killed = true;
    safeSend(ws, { type: "stderr", commandId, data: Buffer.from(`\n[nuum-connector] ${reason}\n`).toString("base64") });
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, SIGKILL_DELAY);
  }

  function onChunk(stream: "stdout" | "stderr", data: Buffer): void {
    entry.bytes += data.length;
    safeSend(ws, { type: stream, commandId, data: data.toString("base64") });
    if (entry.bytes > MAX_OUTPUT && !entry.killed) killProc("Output exceeded 10MB limit");
  }

  child.stdout?.on("data", (d: Buffer) => onChunk("stdout", d));
  child.stderr?.on("data", (d: Buffer) => onChunk("stderr", d));

  child.on("close", (code: number | null) => {
    running.delete(commandId);
    safeSend(ws, { type: "exit", commandId, code: code ?? 1 });
  });

  child.on("error", (err: Error) => {
    running.delete(commandId);
    safeSend(ws, { type: "error", commandId, code: "spawn_error", message: err.message });
  });
}

function writeStdin(commandId: string, dataBase64: string): void {
  const entry = running.get(commandId);
  if (!entry?.child.stdin) return;
  try { entry.child.stdin.write(Buffer.from(dataBase64, "base64")); } catch { /* closed */ }
}

function closeStdin(commandId: string): void {
  const entry = running.get(commandId);
  if (!entry?.child.stdin) return;
  try { entry.child.stdin.end(); } catch { /* closed */ }
}

/** The Ctrl-C path: deliver SIGINT, escalate to SIGKILL if it lingers. */
function cancelCommand(commandId: string): void {
  const entry = running.get(commandId);
  if (!entry || entry.killed) return;
  entry.killed = true;
  try { entry.child.kill("SIGINT"); } catch { /* gone */ }
  setTimeout(() => { try { entry.child.kill("SIGKILL"); } catch { /* gone */ } }, SIGKILL_DELAY);
}

/**
 * Reap every running command. Called when the uplink drops: the provider has
 * already failed all exec sessions, so in-flight output has nowhere to go and
 * the commands are orphaned. Killing + clearing here stops the orphans and
 * prevents a post-reconnect commandId collision.
 */
function reapAllCommands(): void {
  for (const entry of running.values()) {
    if (entry.killed) continue;
    entry.killed = true;
    const child = entry.child;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, SIGKILL_DELAY);
  }
  running.clear();
}

// --- WebSocket connection ---

function connect(config: ConnectConfig, cwd: string): void {
  let backoff = 1000;
  const maxBackoff = 30000;
  let ws: WebSocket | null = null;
  let lastPong = Date.now();

  function tryConnect() {
    const wsUrl = config.url.replace(/^http/, "ws") + "/connector/" + config.key + "/uplink";
    console.log(`Connecting to ${wsUrl}...`);

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log("Connected. Ready for commands.");
      lastPong = Date.now();
      backoff = 1000;
      safeSend(ws, { type: "ready" });
    };

    ws.onmessage = (event: WebSocket.MessageEvent) => {
      let frame: any;
      try {
        frame = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        return;
      }
      if (!frame || typeof frame.type !== "string") return;

      switch (frame.type) {
        case "pong":
          lastPong = Date.now();
          return;
        case "ping":
          lastPong = Date.now();
          safeSend(ws, { type: "pong" });
          return;
        case "start":
          if (typeof frame.commandId !== "string" || !Array.isArray(frame.cmd)) return;
          startCommand(ws!, frame.commandId, frame.cmd, frame.cwd || cwd, frame.env);
          return;
        case "stdin":
          if (typeof frame.commandId === "string" && typeof frame.data === "string") {
            writeStdin(frame.commandId, frame.data);
          }
          return;
        case "stdin_close":
          if (typeof frame.commandId === "string") closeStdin(frame.commandId);
          return;
        case "cancel":
          if (typeof frame.commandId === "string") cancelCommand(frame.commandId);
          return;
      }
    };

    ws.onclose = () => {
      // The uplink is gone: the provider has dropped every session, so all
      // in-flight commands are orphaned. Reap them before reconnecting.
      reapAllCommands();
      console.log(`Disconnected. Reconnecting in ${backoff / 1000}s...`);
      setTimeout(tryConnect, backoff);
      backoff = Math.min(backoff * 2, maxBackoff);
    };

    ws.onerror = () => {
      // onclose will fire after this
    };
  }

  // Keepalive ping every 30s + pong timeout check.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (Date.now() - lastPong > 60_000) {
        console.log("Pong timeout: forcing reconnect.");
        try { ws.close(); } catch { /* already closing */ }
        return;
      }
      safeSend(ws, { type: "ping" });
    }
  }, 30000);

  tryConnect();
}

// --- CLI ---

function main() {
  const args = process.argv.slice(2);

  let slug: string | undefined;
  let url: string | undefined;
  let cwd = process.cwd();

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--url" && i + 1 < args.length) {
      url = args[++i];
    } else if (args[i] === "--cwd" && i + 1 < args.length) {
      cwd = args[++i];
    } else if (!args[i].startsWith("-") && !slug) {
      slug = args[i];
    }
  }

  if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    console.error("Invalid slug. Use lowercase alphanumeric and hyphens only.");
    process.exit(1);
  }

  if (!slug) {
    console.log("Usage: nuum <slug> --url <server-url> [--cwd /path]");
    console.log("");
    console.log("  slug    Local name for this connector (e.g. 'laptop', 'build-server')");
    console.log("  --url   Nuum/Persona server URL (e.g. https://persona.example.com)");
    console.log("  --cwd   Working directory for command execution (default: current dir)");
    process.exit(1);
  }

  let config = loadConfig(slug);

  if (config) {
    if (url) config.url = url;
    console.log(`Nuum connector '${slug}' using stored key: ${config.key}`);
  } else {
    if (!url) {
      console.error("First run requires --url. Usage: nuum <slug> --url <server-url>");
      process.exit(1);
    }
    const key = generateKey();
    config = { slug, url, key };
    saveConfig(config);
    console.log(`New nuum connector '${slug}' created.`);
    console.log(`Key: ${key}`);
    console.log(`\nRun on the Persona side: connector set ${slug} ${key}`);
    console.log("");
  }

  console.log(`Working directory: ${cwd}`);
  connect(config, cwd);
}

main();
