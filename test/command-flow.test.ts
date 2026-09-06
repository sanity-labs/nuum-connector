import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CommandFlow } from "../src/command-flow.js";
import { TRANSFER_FRAME_BYTES as F, TRANSFER_WINDOW_BYTES as W } from "../src/flow-control.js";

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await delay(5);
  assert.ok(predicate(), "condition did not become true");
}

test("pull output stops at credit, splits oversized pipe chunks, and keeps stdout/stderr exact", async () => {
  const out = new PassThrough({ highWaterMark: F });
  const err = new PassThrough({ highWaterMark: F });
  const input = new PassThrough();
  const frames: Array<{ type: string; data?: string; bytes?: number }> = [];
  const failures: Error[] = [];
  const flow = new CommandFlow(out, err, input, f => frames.push(f), e => failures.push(e));
  try {
    const data = Buffer.from(Array.from({ length: W * 2 + 31 }, (_, i) => i % 251));
    out.end(data); err.end(Buffer.from([0, 255, 17]));
    await delay(5);
    assert.equal(frames.length, 0, "no unsolicited output");
    flow.grantOutput(W);
    assert.equal(frames.reduce((sum, f) => sum + Buffer.from(f.data ?? "", "base64").length, 0), W);
    const count = frames.length;
    await delay(10);
    assert.equal(frames.length, count, "blocked sink cannot cause another frame");
    flow.grantOutput(W); flow.grantOutput(W);
    assert.deepEqual(Buffer.concat(frames.filter(f => f.type === "stdout").map(f => Buffer.from(f.data!, "base64"))), data);
    assert.deepEqual(Buffer.concat(frames.filter(f => f.type === "stderr").map(f => Buffer.from(f.data!, "base64"))), Buffer.from([0, 255, 17]));
    assert.ok(frames.every(f => Buffer.from(f.data!, "base64").length <= F));
    assert.deepEqual(failures, []);
  } finally { flow.dispose(); }
});

test("stdin credit is bounded by writes AND drain, with exact ordered bytes and EOF", async () => {
  const pending: Array<() => void> = [];
  const received: Buffer[] = [];
  const stdin = new Writable({ highWaterMark: F,
    write(chunk, _encoding, callback) { received.push(Buffer.from(chunk)); pending.push(callback); },
  });
  const credits: number[] = [];
  const failures: Error[] = [];
  const flow = new CommandFlow(new PassThrough(), new PassThrough(), stdin,
    f => { if (f.type === "stdin_credit") credits.push(f.bytes); }, e => failures.push(e));
  try {
    flow.start();
    const data = Array.from({ length: W / F }, (_, i) => Buffer.alloc(F, i));
    for (const chunk of data) flow.writeInput(chunk.toString("base64"));
    assert.deepEqual(credits, [W]);
    assert.equal(stdin.writableLength, W);
    for (let i = 0; i < data.length - 1; i++) {
      pending.shift()!();
      assert.deepEqual(credits, [W], "no credit while child stdin still needs drain");
    }
    pending.shift()!();
    assert.equal(credits.slice(1).reduce((a, b) => a + b, 0), W);
    assert.deepEqual(Buffer.concat(received), Buffer.concat(data));
    flow.closeInput();
    await until(() => stdin.writableFinished);
    assert.deepEqual(failures, []);
  } finally { flow.dispose(); }
});

test("violations fail one command and disposing clears paused pipes and pending acknowledgements", async () => {
  for (const invalid of ["", Buffer.alloc(F + 1).toString("base64"), "?==="]) {
    const errors: Error[] = [];
    const flow = new CommandFlow(new PassThrough(), new PassThrough(), new PassThrough(), () => {}, e => errors.push(e));
    flow.writeInput(invalid);
    assert.equal(errors.length, 1);
    flow.dispose();
  }
  let done!: () => void;
  const input = new Writable({ highWaterMark: 1, write(_chunk, _encoding, callback) { done = callback; } });
  const output = new PassThrough();
  const frames: unknown[] = [];
  const flow = new CommandFlow(output, new PassThrough(), input, f => frames.push(f), () => {});
  flow.start(); flow.writeInput(Buffer.alloc(F).toString("base64"));
  output.write(Buffer.alloc(F));
  flow.dispose(); done(); flow.grantOutput(W);
  await delay(5);
  assert.equal(frames.length, 1);
  assert.ok(input.destroyed && output.destroyed);
  assert.equal(output.listenerCount("readable"), 0);
});

test("real child pipes preserve bytes across exit under zero/slow output credit", async () => {
  const size = W * 4 + 73;
  const child = spawn(process.execPath, ["-e", `process.stdout.write(Buffer.from(Array.from({length:${size}},(_,i)=>i%251))); process.stderr.write('end');`]);
  const stdout: Buffer[] = [];
  let stderr = "";
  let received = 0;
  let closed = false;
  let exitCode: number | null = null;
  const errors: Error[] = [];
  const flow = new CommandFlow(child.stdout, child.stderr, child.stdin, f => {
    if (f.type === "stdin_credit") return;
    const bytes = Buffer.from(f.data, "base64");
    received += bytes.length;
    if (f.type === "stdout") stdout.push(bytes); else stderr += bytes.toString();
  }, e => errors.push(e));
  child.on("close", code => { closed = true; exitCode = code; });
  try {
    flow.start(); flow.closeInput();
    await delay(100);
    assert.equal(received, 0);
    // Node pipes can prefetch HWM plus one native read; no transfer remainder exists.
    assert.ok(child.stdout.readableLength <= child.stdout.readableHighWaterMark + 64 * 1024);
    for (let offered = 0; offered < size + 3; offered += W) {
      flow.grantOutput(W);
      await until(() => received >= Math.min(offered + W, size + 3));
    }
    await until(() => closed);
    assert.equal(exitCode, 0);
    assert.deepEqual(Buffer.concat(stdout), Buffer.from(Array.from({ length: size }, (_, i) => i % 251)));
    assert.equal(stderr, "end");
    assert.deepEqual(errors, []);
  } finally { flow.dispose(); child.kill("SIGKILL"); }
});

test("child exit with all output still uncredited cannot make Node flush/drop its buffered tail", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(111, 251))"]);
  const output: Buffer[] = [];
  let exited = false;
  let closed = false;
  const flow = new CommandFlow(child.stdout, child.stderr, child.stdin,
    f => { if (f.type === "stdout") output.push(Buffer.from(f.data, "base64")); }, error => { throw error; });
  child.on("exit", () => { exited = true; });
  child.on("close", () => { closed = true; });
  try {
    await until(() => exited);
    await delay(20);
    assert.deepEqual(output, []);
    assert.equal(closed, false, "terminal waits for exact tail delivery");
    flow.grantOutput(111);
    await until(() => closed);
    assert.deepEqual(Buffer.concat(output), Buffer.alloc(111, 251));
  } finally { flow.dispose(); child.kill("SIGKILL"); }
});
