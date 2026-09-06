import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { BOUNDED_TRANSFER, TRANSFER_FRAME_BYTES as F, TRANSFER_WINDOW_BYTES as W } from "../src/flow-control.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "condition did not become true");
}

// Actual packaged daemon on loopback and modest generated data, no live installation.
test("daemon negotiation, bounded duplex frames, independent peer/control and cancellation", { timeout: 15000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "nuum-flow-"));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const address = wss.address(); assert.ok(address && typeof address === "object");
  const connected = once(wss, "connection");
  const entrypoint = process.env.CONNECTOR_TEST_DIST === "1" ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"];
  const daemon = spawn(process.execPath, [...entrypoint, "flow-test", "--url", `http://127.0.0.1:${address.port}`], {
    env: { ...process.env, HOME: scratch }, stdio: "ignore",
  });
  const [ws] = await connected;
  const frames: Array<any> = [];
  ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const forId = (id: string, type: string) => frames.filter(f => f.commandId === id && f.type === type);
  const bytes = (id: string) => forId(id, "stdout").reduce((sum, f) => sum + Buffer.from(f.data, "base64").length, 0);
  const start = (id: string, cmd: string) => send({ type: "start", commandId: id, cmd: [cmd], flowControl: BOUNDED_TRANSFER });
  try {
    await until(() => frames.some(f => f.type === "ready"));
    assert.ok(frames.find(f => f.type === "ready").capabilities.includes(BOUNDED_TRANSFER));
    const data = Buffer.from(Array.from({ length: W * 3 + 79 }, (_, i) => i % 251));
    writeFileSync(join(scratch, "source.bin"), data);
    start("slow", `cat '${join(scratch, "source.bin")}'`);
    await until(() => forId("slow", "started").length === 1);
    assert.equal(forId("slow", "started")[0].flowControl, BOUNDED_TRANSFER);
    await delay(20); assert.equal(bytes("slow"), 0);
    send({ type: "output_credit", commandId: "slow", bytes: W });
    await until(() => bytes("slow") === W);
    await delay(20); assert.equal(bytes("slow"), W);
    // A slow command cannot block the shared uplink or a command with no data.
    send({ type: "ping" }); start("peer", "exit 7");
    await until(() => frames.some(f => f.type === "pong") && forId("peer", "exit").length === 1);
    assert.equal(forId("peer", "exit")[0].code, 7);
    // Cancel an output-paused command: terminal error cannot require more credit.
    start("cancel", `cat '${join(scratch, "source.bin")}'`);
    await until(() => forId("cancel", "started").length === 1);
    send({ type: "cancel", commandId: "cancel" });
    await until(() => forId("cancel", "error").length === 1);
    assert.equal(forId("cancel", "error")[0].code, "cancelled");
    send({ type: "output_credit", commandId: "cancel", bytes: W });
    await delay(20); assert.equal(bytes("cancel"), 0);
    for (let offered = W; offered < data.length; offered += W) {
      send({ type: "output_credit", commandId: "slow", bytes: W });
      await until(() => bytes("slow") === Math.min(offered + W, data.length));
    }
    await until(() => forId("slow", "exit").length === 1);
    assert.equal(forId("slow", "exit")[0].code, 0);
    assert.deepEqual(Buffer.concat(forId("slow", "stdout").map(f => Buffer.from(f.data, "base64"))), data);
    assert.ok(forId("slow", "stdout").every(f => Buffer.from(f.data, "base64").length <= F));
    // Upload consumes only advertised credit; the remote child's file is exact.
    start("upload", `cat > '${join(scratch, "uploaded.bin")}'`);
    await until(() => forId("upload", "stdin_credit").length > 0);
    let offset = 0;
    while (offset < data.length) {
      const granted = forId("upload", "stdin_credit").reduce((sum, f) => sum + f.bytes, 0);
      const size = Math.min(F, data.length - offset);
      if (granted - offset < size) { await delay(5); continue; }
      send({ type: "stdin", commandId: "upload", data: data.subarray(offset, offset + size).toString("base64") });
      offset += size;
    }
    send({ type: "stdin_close", commandId: "upload" });
    await until(() => forId("upload", "exit").length === 1);
    assert.equal(forId("upload", "exit")[0].code, 0);
    assert.deepEqual(readFileSync(join(scratch, "uploaded.bin")), data);
    // Unknown requested versions fail before executing even a marker-file command.
    send({ type: "start", commandId: "bad-version", cmd: [`touch '${join(scratch, "must-not-exist")}'`], flowControl: "unknown-v2" });
    await until(() => forId("bad-version", "error").length === 1);
    assert.equal(existsSync(join(scratch, "must-not-exist")), false);
  } finally {
    ws.terminate(); daemon.kill("SIGTERM"); await once(daemon, "close");
    await new Promise<void>(resolve => wss.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});


test("daemon preserves child exit when bounded stdin closes before granted input drains", { timeout: 15000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "nuum-flow-"));
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  const address = wss.address(); assert.ok(address && typeof address === "object");
  const connected = once(wss, "connection");
  const entrypoint = process.env.CONNECTOR_TEST_DIST === "1" ? ["dist/index.js"] : ["--import", "tsx", "src/index.ts"];
  const daemon = spawn(process.execPath, [...entrypoint, "flow-test", "--url", `http://127.0.0.1:${address.port}`], {
    env: { ...process.env, HOME: scratch }, stdio: "ignore",
  });
  const [ws] = await connected;
  const frames: Array<any> = [];
  ws.on("message", raw => frames.push(JSON.parse(raw.toString())));
  const send = (frame: unknown) => ws.send(JSON.stringify(frame));
  const forId = (id: string, type: string) => frames.filter(f => f.commandId === id && f.type === type);
  try {
    await until(() => frames.some(f => f.type === "ready"));
    send({
      type: "start",
      commandId: "early-close",
      cmd: ["exec 0<&-; echo destination exists >&2; sleep 0.05; exit 4"],
      flowControl: BOUNDED_TRANSFER,
    });
    await until(() => forId("early-close", "stdin_credit").length > 0);
    send({ type: "output_credit", commandId: "early-close", bytes: W });
    const payload = Buffer.alloc(F, 9);
    for (let i = 0; i < 4; i += 1) {
      send({ type: "stdin", commandId: "early-close", data: payload.toString("base64") });
    }

    await until(() => forId("early-close", "exit").length === 1);
    assert.equal(forId("early-close", "exit")[0].code, 4);
    assert.equal(forId("early-close", "error").length, 0);
    assert.match(Buffer.concat(forId("early-close", "stderr").map(f => Buffer.from(f.data, "base64"))).toString(), /destination exists/);
  } finally {
    ws.terminate(); daemon.kill("SIGTERM"); await once(daemon, "close");
    await new Promise<void>(resolve => wss.close(() => resolve()));
    rmSync(scratch, { recursive: true, force: true });
  }
});
