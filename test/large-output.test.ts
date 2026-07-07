import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { WebSocketServer } from "ws";

function waitFor<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}

test("daemon forwards stdout larger than 10 MiB without killing the command", async () => {
  const home = mkdtempSync(join(tmpdir(), "nuum-connector-test-home-"));
  const wss = new WebSocketServer({ port: 0 });
  const children: ChildProcess[] = [];
  after(() => {
    for (const child of children) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    wss.close();
    rmSync(home, { recursive: true, force: true });
  });

  await once(wss, "listening");
  const address = wss.address();
  assert.equal(typeof address, "object");
  assert.ok(address && "port" in address);
  const url = `http://127.0.0.1:${address.port}`;

  const size = 11 * 1024 * 1024;
  const result = new Promise<{ stdoutBytes: number; stderr: string; exitCode: number }>((resolve, reject) => {
    wss.once("connection", (ws) => {
      let stdoutBytes = 0;
      let stderr = "";
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          type: string;
          commandId?: string;
          data?: string;
          code?: number;
        };
        if (frame.type === "ready") {
          ws.send(JSON.stringify({
            type: "start",
            commandId: "cmd-large",
            cmd: [`node -e 'process.stdout.write(Buffer.alloc(${size}, 65))'`],
          }));
          return;
        }
        if (frame.type === "stdout" && frame.data) {
          stdoutBytes += Buffer.from(frame.data, "base64").length;
          return;
        }
        if (frame.type === "stderr" && frame.data) {
          stderr += Buffer.from(frame.data, "base64").toString("utf8");
          return;
        }
        if (frame.type === "exit") {
          resolve({ stdoutBytes, stderr, exitCode: frame.code ?? -1 });
          return;
        }
        if (frame.type === "error") {
          reject(new Error(`daemon error: ${JSON.stringify(frame)}`));
        }
      });
    });
  });

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "large-output-test", "--url", url], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);

  const { stdoutBytes, stderr, exitCode } = await waitFor(result, 15_000, "large stdout command");
  assert.equal(exitCode, 0);
  assert.equal(stdoutBytes, size);
  assert.equal(stderr, "");
});
