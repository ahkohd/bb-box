// The msb relay (053): bb-box's msb client on BB's server (src/relay/msb-client.mjs),
// the server's hub (src/relay/hub.ts) and the machine's worker
// (src/host/msb.ts), joined by a WebSocket stand-in, with a fake bb-box msb
// on the machine.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { hostEntry } from "../src/host/entry.ts";
import { RelayHub } from "../src/relay/hub.ts";
import { MSB_ROUTE, msbClientArgv, refuseMsb } from "../src/relay/msb.ts";
import { openTerminal } from "../src/transports/terminal.ts";
import { joined, tempDir } from "./helpers.ts";

/** A bb-box msb folder with a fake bin/msb, which acts on its first argument. */
function fakeMsbDir(): string {
  const dir = tempDir("msb-dir");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(
    join(dir, "bin", "msb"),
    `#!/bin/sh
case "$1" in
  --version) echo "msb 0.7.7" ;;
  echo) shift; printf '%s\\n' "$@" ;;
  cat) cat ;;
  fail) echo "it failed" >&2; exit 7 ;;
  killed) kill -9 $$ ;;
  tty) [ -t 0 ] && echo "on a tty"; stty size; read line; echo "got $line"; stty size ;;
esac
`,
  );
  chmodSync(join(dir, "bin", "msb"), 0o755);
  return dir;
}

function setUp(t: TestContext, dir: string) {
  const saved = process.env.BB_SERVER_URL;
  process.env.BB_SERVER_URL = "https://bb.example.com/";
  t.after(() => (saved === undefined ? delete process.env.BB_SERVER_URL : (process.env.BB_SERVER_URL = saved)));
  let hub!: RelayHub;
  const { urls, connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ msb: { dir, connect: connectTo } }));
  t.after(() => worker.experimental_dispose());
  const opened: string[] = [];
  hub = new RelayHub({
    what: "msb",
    refuse: refuseMsb,
    dir: tempDir("msb-hub"),
    open: async (hostId, secret) => {
      opened.push(hostId);
      return worker.experimental_call("msbRelay", { secret, path: `/api/v1/plugins/bb-box/http${MSB_ROUTE}` });
    },
    keep: async () => false,
    logError: () => {},
  });
  t.after(() => hub.dispose());
  return { hub, worker, urls, opened };
}

/** Runs the client as the backend would, and gives what it printed and how it exited. */
function run(argv: readonly string[], stdin: string | Buffer = ""): Promise<{ code: number | null; signal: string | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(stdin);
  });
}

test("msb runs on the machine through the relay: its arguments, stdin, stdout, stderr and exit, over one relay", async (t) => {
  const { hub, opened, urls, worker } = setUp(t, fakeMsbDir());
  const socket = (await hub.endpoint("host_msb")).slice("unix://".length);

  const echoed = await run(msbClientArgv(socket, { args: ["echo", "one two", "it's", "--flag"] }));
  assert.equal(echoed.code, 0);
  assert.equal(echoed.stdout.toString(), "one two\nit's\n--flag\n", "each argument reaches msb as it was");

  const failed = await run(msbClientArgv(socket, { args: ["fail"] }));
  assert.deepEqual([failed.code, failed.stderr], [7, "it failed\n"]);

  const big = Buffer.alloc(1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = i % 253;
  const [copied, again] = await Promise.all([run(msbClientArgv(socket, { args: ["cat"] }), big), run(msbClientArgv(socket, { args: ["cat"] }), big)]);
  assert.ok(copied.stdout.equals(big) && again.stdout.equals(big), "1 MiB each way, on two runs at once");

  const killed = await run(msbClientArgv(socket, { args: ["killed"] }));
  assert.deepEqual([killed.code, killed.signal], [null, "SIGKILL"], "a run killed on the machine ends the client the same way");

  assert.deepEqual(opened, ["host_msb"], "one relay carries every run");
  assert.match(urls[0]!, /^wss:\/\/bb\.example\.com\/api\/v1\/plugins\/bb-box\/http\/msb-relay\?s=[0-9a-f]{32}$/);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1, "the worker holds a lease while the relay is open");
});

test("a machine without msb, or a relay that cannot open, ends the client with 255 and the reason", async (t) => {
  const empty = tempDir("msb-empty");
  const { hub } = setUp(t, empty);
  const missing = await run(msbClientArgv((await hub.endpoint("host_new")).slice("unix://".length), { args: ["--version"] }));
  assert.equal(missing.code, 255);
  assert.match(missing.stderr, /^bb-box could not run msb on the BB machine: msb is not installed here \(.+\/bin\/msb\)/);

  const failing = new RelayHub({ what: "msb", refuse: refuseMsb, dir: tempDir("msb-fail"), open: async () => Promise.reject(new Error("Host is not connected")), keep: async () => false, logError: () => {} });
  t.after(() => failing.dispose());
  const offline = await run(msbClientArgv((await failing.endpoint("host_off")).slice("unix://".length), { args: ["--version"] }));
  assert.deepEqual([offline.code, offline.stderr], [255, "bb-box could not run msb on the BB machine: Host is not connected\n"]);
});

test("a terminal's msb runs on a PTY on the machine, at the terminal's size, and follows its resizes", async (t) => {
  const { hub } = setUp(t, fakeMsbDir());
  const socket = (await hub.endpoint("host_tty")).slice("unix://".length);
  const terminal = await openTerminal(msbClientArgv(socket, { args: ["tty"], tty: true }), { cols: 100, rows: 30 });
  t.after(() => terminal.close());
  const reader = terminal.readable.getReader();
  let seen = "";
  const until = async (pattern: RegExp) => {
    const deadline = Date.now() + 10_000;
    while (!pattern.test(seen)) {
      assert.ok(Date.now() < deadline, `waited for ${pattern} in ${JSON.stringify(seen)}`);
      const { value, done } = await Promise.race([reader.read(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`waited for ${pattern} in ${JSON.stringify(seen)}`)), deadline - Date.now()))]);
      if (done) break;
      seen += Buffer.from(value).toString("utf8");
    }
  };
  await until(/on a tty\r\n30 100\r\n/);
  await terminal.resize({ cols: 120, rows: 40 });
  // The resize goes as SIGWINCH to the client, then as a frame to the machine's PTY.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const writer = terminal.writable.getWriter();
  await writer.write(new TextEncoder().encode("hello\r"));
  await until(/hello\r\ngot hello\r\n40 120\r\n/);
});

test("the host entry runs bb-box's msb scripts, and no other", async (t) => {
  const dir = fakeMsbDir();
  const { worker } = setUp(t, dir);
  const status = await worker.experimental_call("microsandbox", { script: "status", args: [] });
  assert.equal(status.exitCode, 0);
  assert.equal(status.dir, dir);
  assert.match(status.stdout, /^installed=0\.7\.7$/m);
  assert.match(status.stdout, /^pinned=0\.7\.7$/m);
  assert.match(status.stdout, /^reflink=[01]$/m);

  const refused = await worker.experimental_call("microsandbox", { script: "import", args: ["--output=/etc/passwd"] });
  assert.equal(refused.exitCode, 2);
  assert.match(refused.stderr, /runs no script import with those arguments/);
  const extra = await worker.experimental_call("microsandbox", { script: "status", args: ["x"] });
  assert.equal(extra.exitCode, 2);
});

test("the install script refuses an archive whose SHA-256 is not the one bb-box was tested with, and leaves no msb", async () => {
  const { msbScript } = await import("../src/backends/microsandbox/release.ts");
  const dir = tempDir("msb-install");
  const tools = tempDir("msb-tools");
  // A curl that writes some other archive where it is asked to.
  writeFileSync(join(tools, "curl"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { echo "not msb" >"$2"; exit 0; }; shift; done\nexit 1\n`);
  chmodSync(join(tools, "curl"), 0o755);
  const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
    const child = spawn("sh", ["-c", msbScript("install")], { env: { ...process.env, PATH: `${tools}:${process.env.PATH}`, BBBOX_MSB_DIR: dir } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.once("close", (code) => resolve({ code, stderr }));
  });
  assert.equal(result.code, 3);
  assert.match(result.stderr, /archive's SHA-256 is [0-9a-f]{64}, not [0-9a-f]{64} as bb-box was tested with, so bb-box did not install it/);
  const { existsSync, readdirSync } = await import("node:fs");
  assert.equal(existsSync(join(dir, "bin", "msb")), false);
  assert.deepEqual(readdirSync(dir), [], "the download is gone too");
});
