/**
 * Daemon CLI parsing/startup: every value-taking flag must fail explicitly
 * when present without a following value. Spawns the real entrypoint (same
 * approach as large-output.test.ts) with a scratch HOME so nothing is written
 * to the developer's ~/.nuum.
 */

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

const homes: string[] = [];
after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<Run & { home: string }> {
  const home = mkdtempSync(join(tmpdir(), "nuum-connector-cli-test-home-"));
  homes.push(home);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`cli did not exit: ${JSON.stringify(args)}`));
    }, 20_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, home });
    });
  });
}

function wroteNoConfig(home: string): boolean {
  const dir = join(home, ".nuum");
  return !existsSync(dir) || readdirSync(dir).length === 0;
}

// Everything a value-taking flag needs so that, were the trailing flag
// silently skipped, startup would otherwise proceed past policy validation.
const VALID_AUTH = ["cli-test", "--auth", "otp", "--notify", "ntfy:t", "--lease", "30m"];

test("a trailing --lease or --max-lease with no value fails explicitly instead of being ignored", async () => {
  for (const flag of ["--lease", "--max-lease"]) {
    const r = await runCli([...VALID_AUTH, flag]);
    assert.equal(r.code, 1, `${flag}: exit code`);
    assert.match(r.stderr, new RegExp(`^${flag} requires a value$`, "m"), `${flag}: stderr`);
    assert.doesNotMatch(r.stdout, /Auth: ENABLED/, `${flag}: must not reach auth startup`);
    assert.ok(wroteNoConfig(r.home), `${flag}: must not write a config file`);
  }
});

test("every other value-taking flag also fails explicitly when trailing", async () => {
  for (const flag of ["--url", "--cwd", "--auth", "--notify"]) {
    const r = await runCli([...VALID_AUTH, flag]);
    assert.equal(r.code, 1, `${flag}: exit code`);
    assert.match(r.stderr, new RegExp(`^${flag} requires a value$`, "m"), `${flag}: stderr`);
    assert.ok(wroteNoConfig(r.home), `${flag}: must not write a config file`);
  }
});

test("positive control: the same flags with values parse and reach auth startup", async () => {
  // No --url and no stored config → exits 1 at "First run requires --url",
  // AFTER printing the resolved policy, which proves the values were consumed.
  const r = await runCli([...VALID_AUTH, "--max-lease", "indefinitely"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^Auth: ENABLED \(otp\), lease default 30m, max indefinitely, notify https:\/\/ntfy\.sh\/t$/m);
  assert.match(r.stderr, /First run requires --url/);
  assert.ok(wroteNoConfig(r.home));
});

test("startup fails closed on a policy whose expiry cannot be a valid date", async () => {
  // 100000000d is a valid safe-integer duration but cannot produce a valid
  // Date from any clock after the epoch; the authority rejects it at startup.
  const r = await runCli(["cli-test", "--auth", "otp", "--notify", "ntfy:t", "--lease", "100000000d"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--lease 100000000d cannot produce a valid expiry date/);
  assert.ok(wroteNoConfig(r.home));
  const m = await runCli(["cli-test", "--auth", "otp", "--notify", "ntfy:t", "--lease", "8h", "--max-lease", "100000000d"]);
  assert.equal(m.code, 1);
  assert.match(m.stderr, /--max-lease 100000000d cannot produce a valid expiry date/);
  // Overflow of the millisecond count is rejected at parse time.
  const o = await runCli(["cli-test", "--auth", "otp", "--notify", "ntfy:t", "--lease", "99999999999d"]);
  assert.equal(o.code, 1);
  assert.match(o.stderr, /--lease duration '99999999999d' is too long/);
});

// --------------------------------------------------------------------
// A missing value is also a defect when the NEXT token is another recognized
// value-taking flag: that flag must not be swallowed as the value.
// --------------------------------------------------------------------

const VALUE_FLAGS = ["--url", "--cwd", "--auth", "--lease", "--max-lease", "--notify"];

test("--notify with no value followed by --auth fails closed instead of starting with auth disabled", async () => {
  // Were `--auth` consumed as the value of `--notify`, the `--auth` branch
  // would never run: the daemon would write a config for the given --url and
  // start connecting UNAUTHENTICATED with the positional 'otp' ignored.
  const r = await runCli(["host", "--url", "https://example", "--notify", "--auth", "otp", "--cwd", "/valid"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^--notify requires a value$/m);
  assert.doesNotMatch(r.stdout, /New nuum connector|Key:|Working directory/, "must not reach startup");
  assert.doesNotMatch(r.stdout, /Auth: ENABLED/);
  assert.ok(wroteNoConfig(r.home), "must not write a config file");
});

test("every recognized value-taking flag rejects another recognized value-taking flag in its value position", async () => {
  for (const flag of VALUE_FLAGS) {
    const next = flag === "--auth" ? "--notify" : "--auth";
    const r = await runCli(["cli-test", flag, next, "otp", "--notify", "ntfy:t", "--lease", "30m"]);
    assert.equal(r.code, 1, `${flag}: exit code`);
    assert.match(r.stderr, new RegExp(`^${flag} requires a value$`, "m"), `${flag}: stderr`);
    assert.doesNotMatch(r.stdout, /Auth: ENABLED|Working directory/, `${flag}: must not reach startup`);
    assert.ok(wroteNoConfig(r.home), `${flag}: must not write a config file`);
  }
});

test("positive control: ordinary values in every position, including adjacent flag pairs, still parse", async () => {
  const r = await runCli([
    "cli-test", "--cwd", process.cwd(), "--auth", "otp", "--notify", "ntfy:t",
    "--lease", "30m", "--max-lease", "2h",
  ]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^Auth: ENABLED \(otp\), lease default 30m, max 2h, notify https:\/\/ntfy\.sh\/t$/m);
  assert.match(r.stderr, /First run requires --url/);
  assert.ok(wroteNoConfig(r.home));
});
