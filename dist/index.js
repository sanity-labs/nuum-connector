#!/usr/bin/env node
/**
 * Nuum connector daemon: runs on a remote host (laptop, GPU box, on-prem
 * server) and dials into the Nuum/Persona connector-provider over a reverse
 * WebSocket, allowing agents to execute commands on this machine.
 *
 * Usage: nuum <slug> --url <server-url> [--cwd /path]
 *             [--auth otp --lease 8h [--max-lease 2d|indefinitely] --notify ntfy:<topic-or-url>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { CommandFlow } from "./command-flow.js";
import { BOUNDED_TRANSFER, TRANSFER_WIRE_BYTES } from "./flow-control.js";
import { LeaseAuthority } from "./auth.js";
import { parseNotifyConfig, createNtfyNotifier } from "./ntfy.js";
import { formatLeaseDuration, isValidLeaseDurationMs, parseLeaseDuration, } from "./lease-duration.js";
function configDir() {
    const dir = join(homedir(), ".nuum");
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
function configPath(slug) {
    return join(configDir(), slug + ".json");
}
function loadConfig(slug) {
    const path = configPath(slug);
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, "utf-8"));
    }
    catch {
        return null;
    }
}
function saveConfig(config) {
    writeFileSync(configPath(config.slug), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}
function generateKey() {
    return randomBytes(9).toString("base64url").slice(0, 12);
}
// --- Running commands (multiplexed by commandId) ---
const SIGKILL_DELAY = 5_000;
const running = new Map();
/** Safe send: no-op if socket is closed. */
function safeSend(ws, frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN)
        return false;
    try {
        ws.send(JSON.stringify(frame));
        return true;
    }
    catch {
        return false;
    }
}
function startCommand(ws, commandId, cmd, cwd, env, flowControl) {
    if (running.has(commandId))
        return; // duplicate start
    if (flowControl !== undefined && flowControl !== BOUNDED_TRANSFER) {
        safeSend(ws, { type: "error", commandId, code: "unsupported_flow_control", message: "unsupported transfer flow control" });
        return;
    }
    const bounded = flowControl === BOUNDED_TRANSFER;
    const command = cmd.join(" ");
    console.log(`[cmd:${commandId}] ${command}`);
    const child = spawn("/bin/sh", ["-c", command], {
        cwd,
        detached: bounded, // bounded cancellation reaches the transfer shell and its children
        env: env ? { ...process.env, ...env } : process.env,
    });
    const entry = { child, killed: false };
    running.set(commandId, entry);
    let terminal = false;
    const clearKillTimer = () => {
        if (entry.killTimer)
            clearTimeout(entry.killTimer);
        entry.killTimer = undefined;
    };
    const finish = (frame) => {
        if (terminal)
            return;
        terminal = true;
        running.delete(commandId);
        // A terminal error acknowledges cancellation, not process exit. Keep the
        // guarded escalation alive until the child actually terminates.
        if (child.exitCode !== null || child.signalCode !== null)
            clearKillTimer();
        entry.flow?.dispose();
        safeSend(ws, frame);
    };
    const failFlow = (error, code = "transfer_error") => {
        if (terminal)
            return;
        terminateCommand(entry, "SIGINT");
        finish({ type: "error", commandId, code, message: error.message });
    };
    if (bounded) {
        entry.flow = new CommandFlow(child.stdout, child.stderr, child.stdin, (frame) => {
            if (!safeSend(ws, { ...frame, commandId }))
                failFlow(new Error("connector uplink closed"));
        }, failFlow);
        entry.failFlow = failFlow;
        entry.cancelFlow = () => failFlow(new Error("connector transfer cancelled"), "cancelled");
    }
    safeSend(ws, { type: "started", commandId, ...(bounded ? { flowControl: BOUNDED_TRANSFER } : {}) });
    if (entry.flow)
        entry.flow.start();
    else {
        child.stdout?.on("data", (data) => safeSend(ws, { type: "stdout", commandId, data: data.toString("base64") }));
        child.stderr?.on("data", (data) => safeSend(ws, { type: "stderr", commandId, data: data.toString("base64") }));
    }
    // close waits for the output pipes to finish: exit never overtakes file bytes.
    child.on("close", (code) => {
        clearKillTimer();
        finish({ type: "exit", commandId, code: code ?? 1 });
    });
    child.on("error", (err) => finish({ type: "error", commandId, code: "spawn_error", message: err.message }));
}
function writeStdin(commandId, dataBase64) {
    const entry = running.get(commandId);
    if (!entry?.child.stdin)
        return;
    if (entry.flow) {
        entry.flow.writeInput(dataBase64);
        return;
    }
    try {
        entry.child.stdin.write(Buffer.from(dataBase64, "base64"));
    }
    catch { /* closed */ }
}
function closeStdin(commandId) {
    const entry = running.get(commandId);
    if (!entry?.child.stdin)
        return;
    if (entry.flow) {
        entry.flow.closeInput();
        return;
    }
    try {
        entry.child.stdin.end();
    }
    catch { /* closed */ }
}
/** Preserve legacy signals; bounded commands own a process group and paused pipes. */
function terminateCommand(entry, signal) {
    if (entry.killed)
        return;
    entry.killed = true;
    const kill = (sig) => {
        if (entry.child.exitCode !== null || entry.child.signalCode !== null)
            return;
        try {
            if (entry.flow && entry.child.pid)
                process.kill(-entry.child.pid, sig);
            else
                entry.child.kill(sig);
        }
        catch { /* gone */ }
    };
    kill(signal);
    entry.flow?.dispose();
    entry.killTimer = setTimeout(() => {
        entry.killTimer = undefined;
        kill("SIGKILL");
    }, SIGKILL_DELAY);
    entry.killTimer.unref();
}
function cancelCommand(commandId) {
    const entry = running.get(commandId);
    if (!entry)
        return;
    if (entry.cancelFlow)
        entry.cancelFlow();
    else
        terminateCommand(entry, "SIGINT");
}
function reapAllCommands() {
    for (const entry of running.values())
        terminateCommand(entry, "SIGTERM");
    running.clear();
}
// --- WebSocket connection ---
/**
 * When auth is enabled, mint a pending lease and notify the human. Async so
 * the ntfy publish can complete before the result frame is sent. Errors are
 * reported to persona as an `error` frame, never left hanging.
 */
async function handleRenew(ws, authority, commandId, spaceId, message, requestedLeaseDurationMs) {
    // Safe log: space, reason, and the exact requested duration (or "default" /
    // "invalid" for a malformed wire value). Never the token/OTP.
    const requestedLabel = requestedLeaseDurationMs === undefined
        ? "default"
        : isValidLeaseDurationMs(requestedLeaseDurationMs)
            ? formatLeaseDuration(requestedLeaseDurationMs)
            : "invalid";
    console.log(`[renew:${commandId}] space=${spaceId} requested=${requestedLabel} reason=${JSON.stringify(message)}`);
    try {
        const r = await authority.renew(spaceId, message, requestedLeaseDurationMs);
        if (r.ok) {
            console.log(`[renew:${commandId}] pending created, lease=${formatLeaseDuration(r.leaseDurationMs)}, notification sent`);
            safeSend(ws, {
                type: "renew_result",
                commandId,
                leaseToken: r.leaseToken,
                pendingExpiresAt: r.pendingExpiresAt,
                leaseDurationMs: r.leaseDurationMs,
            });
        }
        else {
            console.log(`[renew:${commandId}] rejected: ${r.code}`);
            safeSend(ws, { type: "error", commandId, code: r.code, message: r.message });
        }
    }
    catch (e) {
        safeSend(ws, { type: "error", commandId, code: "renew_error", message: e.message });
    }
}
/** Verify hidden token + OTP; promote pending → active on success. */
function handleAuth(ws, authority, commandId, spaceId, leaseToken, otp) {
    const r = authority.verifyAuth(spaceId, leaseToken, otp);
    if (r.ok) {
        const until = r.leaseExpiresAt === null ? "never (until replaced or restart)" : new Date(r.leaseExpiresAt).toISOString();
        console.log(`[auth:${commandId}] space=${spaceId} authorized lease=${formatLeaseDuration(r.leaseDurationMs)} expires=${until}`);
        safeSend(ws, {
            type: "auth_result",
            commandId,
            leaseExpiresAt: r.leaseExpiresAt,
            leaseDurationMs: r.leaseDurationMs,
        });
    }
    else {
        console.log(`[auth:${commandId}] space=${spaceId} failed: ${r.message}`);
        safeSend(ws, { type: "error", commandId, code: r.code, message: r.message });
    }
}
function connect(config, cwd, authority) {
    let backoff = 1000;
    const maxBackoff = 30000;
    let ws = null;
    let lastPong = Date.now();
    function tryConnect() {
        const wsUrl = config.url.replace(/^http/, "ws") + "/connector/" + config.key + "/uplink";
        console.log(`Connecting to ${wsUrl}...`);
        ws = new WebSocket(wsUrl);
        ws.onopen = () => {
            console.log("Connected. Ready for commands.");
            lastPong = Date.now();
            backoff = 1000;
            safeSend(ws, { type: "ready", capabilities: [BOUNDED_TRANSFER] });
        };
        ws.onmessage = (event) => {
            let frame;
            const raw = typeof event.data === "string" ? event.data : event.data.toString();
            try {
                frame = JSON.parse(raw);
            }
            catch {
                return;
            }
            if (!frame || typeof frame.type !== "string")
                return;
            const active = typeof frame.commandId === "string" ? running.get(frame.commandId) : undefined;
            if (active?.flow && Buffer.byteLength(raw) > TRANSFER_WIRE_BYTES) {
                active.failFlow?.(new Error("oversized transfer frame"));
                return;
            }
            switch (frame.type) {
                case "pong":
                    lastPong = Date.now();
                    return;
                case "ping":
                    lastPong = Date.now();
                    safeSend(ws, { type: "pong" });
                    return;
                case "start": {
                    if (typeof frame.commandId !== "string" || !Array.isArray(frame.cmd))
                        return;
                    // Auth gate: only when enabled. Disabled → unchanged behavior, the
                    // spaceId/leaseToken fields (if any) are simply ignored.
                    if (authority) {
                        const decision = authority.authorizeStart(frame.spaceId, frame.leaseToken);
                        if (!decision.ok) {
                            console.log(`[cmd:${frame.commandId}] denied: ${decision.message}`);
                            safeSend(ws, {
                                type: "error",
                                commandId: frame.commandId,
                                code: "auth_required",
                                message: "connector authorization required; run: connector renew",
                            });
                            return;
                        }
                    }
                    if (frame.flowControl !== undefined && Buffer.byteLength(JSON.stringify(frame)) > TRANSFER_WIRE_BYTES) {
                        safeSend(ws, { type: "error", commandId: frame.commandId, code: "transfer_error", message: "oversized transfer start" });
                        return;
                    }
                    startCommand(ws, frame.commandId, frame.cmd, frame.cwd || cwd, frame.env, frame.flowControl);
                    return;
                }
                case "renew": {
                    if (typeof frame.commandId !== "string")
                        return;
                    if (!authority) {
                        safeSend(ws, {
                            type: "error",
                            commandId: frame.commandId,
                            code: "auth_disabled",
                            message: "connector auth is not enabled on this daemon",
                        });
                        return;
                    }
                    if (typeof frame.spaceId !== "string" || typeof frame.message !== "string")
                        return;
                    // `leaseDurationMs` is optional: undefined → daemon default. The
                    // authority validates the raw value and answers with an explicit
                    // error frame on anything malformed, so Persona never has to time out.
                    void handleRenew(ws, authority, frame.commandId, frame.spaceId, frame.message, frame.leaseDurationMs);
                    return;
                }
                case "auth": {
                    if (typeof frame.commandId !== "string")
                        return;
                    if (!authority) {
                        safeSend(ws, {
                            type: "error",
                            commandId: frame.commandId,
                            code: "auth_disabled",
                            message: "connector auth is not enabled on this daemon",
                        });
                        return;
                    }
                    if (typeof frame.spaceId !== "string" ||
                        typeof frame.leaseToken !== "string" ||
                        typeof frame.otp !== "string") {
                        return;
                    }
                    handleAuth(ws, authority, frame.commandId, frame.spaceId, frame.leaseToken, frame.otp);
                    return;
                }
                case "output_credit":
                    if (typeof frame.commandId === "string")
                        running.get(frame.commandId)?.flow?.grantOutput(frame.bytes);
                    return;
                case "stdin":
                    if (typeof frame.commandId === "string" && typeof frame.data === "string") {
                        writeStdin(frame.commandId, frame.data);
                    }
                    return;
                case "stdin_close":
                    if (typeof frame.commandId === "string")
                        closeStdin(frame.commandId);
                    return;
                case "cancel":
                    if (typeof frame.commandId === "string")
                        cancelCommand(frame.commandId);
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
                try {
                    ws.close();
                }
                catch { /* already closing */ }
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
    let slug;
    let url;
    let cwd = process.cwd();
    let authMode;
    let leaseArg = "8h";
    let maxLeaseArg;
    let notifyArg;
    // Every value-taking flag must be followed by its value. A flag with
    // nothing after it, or with another recognized value-taking flag in its
    // value position, is a malformed invocation, not an omission, so it fails
    // closed here instead of being silently ignored (e.g. a trailing
    // `--max-lease` must not quietly collapse to "max equals --lease", and
    // `--notify --auth otp` must not swallow `--auth` and start unauthenticated).
    const VALUE_FLAGS = ["--url", "--cwd", "--auth", "--lease", "--max-lease", "--notify"];
    const valueAfter = (i) => {
        const next = args[i + 1];
        if (next === undefined || VALUE_FLAGS.includes(next)) {
            console.error(`${args[i]} requires a value`);
            process.exit(1);
        }
        return next;
    };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--url") {
            url = valueAfter(i++);
        }
        else if (args[i] === "--cwd") {
            cwd = valueAfter(i++);
        }
        else if (args[i] === "--auth") {
            authMode = valueAfter(i++);
        }
        else if (args[i] === "--lease") {
            leaseArg = valueAfter(i++);
        }
        else if (args[i] === "--max-lease") {
            maxLeaseArg = valueAfter(i++);
        }
        else if (args[i] === "--notify") {
            notifyArg = valueAfter(i++);
        }
        else if (!args[i].startsWith("-") && !slug) {
            slug = args[i];
        }
    }
    if (slug && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        console.error("Invalid slug. Use lowercase alphanumeric and hyphens only.");
        process.exit(1);
    }
    if (!slug) {
        console.log("Usage: nuum <slug> --url <server-url> [--cwd /path]");
        console.log("            [--auth otp --lease 8h [--max-lease <duration|indefinitely>]");
        console.log("             --notify ntfy:<topic-or-url>]");
        console.log("");
        console.log("  slug      Local name for this connector (e.g. 'laptop', 'build-server')");
        console.log("  --url     Nuum/Persona server URL (e.g. https://persona.example.com)");
        console.log("  --cwd     Working directory for command execution (default: current dir)");
        console.log("  --auth    Enable opt-in lease-token auth ('otp'). Off by default.");
        console.log("  --lease   Default lease duration when a request omits one (default 8h; finite).");
        console.log("  --max-lease");
        console.log("            Longest lease an agent may request: a duration or 'indefinitely'.");
        console.log("            Defaults to --lease. Longer requests are rejected, never clamped.");
        console.log("  --notify  OTP carrier when auth is on, e.g. ntfy:<topic-or-url>.");
        console.log("");
        console.log("  Durations: <n>s, <n>m, <n>h, <n>d (e.g. 30m, 2h, 8h, 2d).");
        process.exit(1);
    }
    // Build the opt-in auth layer. Auth is OFF unless --auth is set; when on, a
    // notify carrier is REQUIRED, so we fail closed with a clear message.
    let authority = null;
    if (authMode !== undefined) {
        if (authMode !== "otp") {
            console.error(`Unsupported --auth mode '${authMode}'. Only 'otp' is supported.`);
            process.exit(1);
        }
        // Lease policy: --lease is the finite default for requests that omit a
        // duration; --max-lease is the ceiling (may be 'indefinitely') and defaults
        // to --lease so an unconfigured daemon keeps today's fixed upper bound.
        // Any invalid or inconsistent policy fails startup (fail closed): grammar
        // and safe-integer overflow here, then the authority's constructor checks
        // that both values can produce a valid expiry date from this clock.
        let defaultLeaseMs;
        let maxLeaseMs;
        try {
            const parsedDefault = parseLeaseDuration(leaseArg, { flag: "--lease", allowIndefinite: false });
            // parseLeaseDuration only returns null when indefinite is allowed.
            defaultLeaseMs = parsedDefault;
            maxLeaseMs =
                maxLeaseArg === undefined
                    ? defaultLeaseMs
                    : parseLeaseDuration(maxLeaseArg, { flag: "--max-lease", allowIndefinite: true });
        }
        catch (e) {
            console.error(e.message);
            process.exit(1);
        }
        try {
            const ntfy = parseNotifyConfig(notifyArg);
            authority = new LeaseAuthority({
                connector: slug,
                host: hostname(),
                defaultLeaseMs,
                maxLeaseMs,
                notify: createNtfyNotifier(ntfy),
            });
            console.log(`Auth: ENABLED (otp), lease ${authority.describePolicy()}, notify ${ntfy.url}`);
        }
        catch (e) {
            console.error(`Auth enabled but misconfigured: ${e.message}`);
            process.exit(1);
        }
    }
    let config = loadConfig(slug);
    if (config) {
        if (url)
            config.url = url;
        console.log(`Nuum connector '${slug}' using stored key: ${config.key}`);
    }
    else {
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
    connect(config, cwd, authority);
}
main();
