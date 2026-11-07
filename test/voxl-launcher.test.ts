import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { VOXL_START_TIMEOUT_MS } from "../src/backends/voxl.ts";
import { VOXL_CONNECT_MS } from "../src/core/voxl.ts";

const LAUNCHER = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/files/voxl", import.meta.url));
const PANEL_CLIENT = fileURLToPath(new URL("../src/app/selkies.ts", import.meta.url));
const folders: string[] = [];
after(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const FAKE_VOXL = `#!/usr/bin/env node
const http = require("node:http");
const port = Number(process.argv.find((arg) => arg.startsWith("--port=")).slice(7));
if (process.env.FAKE_VOXL_FAILS) {
  console.error("[ERROR voxl] X connect: no display :99");
  process.exit(1);
}
if (process.env.FAKE_VOXL_HANGS) {
  console.error("[ERROR voxl] capture: XShm GetImage failed");
  process.on("SIGTERM", () => undefined);
  require("node:fs").writeFileSync(process.env.FAKE_VOXL_HANGS, String(process.pid));
  http.createServer(() => undefined).listen(port, "127.0.0.1");
  return;
}
http.createServer((request, response) => response.end(request.url === "/stats" ? JSON.stringify({ clients: [] }) : "ok")).listen(port, "127.0.0.1");
`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function world(extra: Record<string, string> = {}) {
  const folder = mkdtempSync(join(tmpdir(), "bb-box-voxl-"));
  folders.push(folder);
  const binary = join(folder, "fake-voxl");
  writeFileSync(binary, FAKE_VOXL);
  chmodSync(binary, 0o755);
  const port = await freePort();
  const env = { ...process.env, XDG_RUNTIME_DIR: folder, BBBOX_VOXL_BINARY: binary, BBBOX_VOXL_PORT: String(port), BBBOX_VOXL_CHECK_SECONDS: "0.2", BBBOX_VOXL_IDLE_SECONDS: "1", ...extra };
  const start = () => {
    const started = Date.now();
    const result = spawnSync("bash", [LAUNCHER, "start"], { env, encoding: "utf8", timeout: 60_000 });
    return { ...result, ms: Date.now() - started };
  };
  const answers = async () => fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok, () => false);
  const stopped = async () => {
    const deadline = Date.now() + 15_000;
    while ((await answers()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
    return !(await answers());
  };
  return { folder, start, answers, stopped };
}

test("a start while an earlier run loop still holds its lock, as one stopping for want of viewers, waits for it and brings voxl up", async () => {
  const { folder, start, answers, stopped } = await world();
  const holder = spawn("flock", [join(folder, "bb-box-voxl.run"), "sleep", "1.5"], { stdio: "ignore" });
  const released = new Promise((resolve) => holder.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = start();
  assert.equal(started.status, 0, started.stderr);
  assert.equal(await answers(), true);
  await released;
  assert.ok(started.ms >= 1000, `${started.ms} ms: it waited for the earlier loop`);
  assert.equal(await stopped(), true, "it stops once it has had no viewer for its idle time");
});

const firstFrameMs = () => Number(/export const FIRST_FRAME_MS = ([\d_]+);/.exec(readFileSync(PANEL_CLIENT, "utf8"))![1]!.replaceAll("_", ""));

function failedInTime(started: { status: number | null; stderr: string; ms: number }, said: RegExp): void {
  assert.notEqual(started.status, 0);
  assert.match(started.stderr, /voxl did not answer on 127\.0\.0\.1:\d+ within 7 s: its log: /);
  assert.match(started.stderr, said);
  assert.ok(started.ms < firstFrameMs() - 1500, `${started.ms} ms, against the panel's ${firstFrameMs()} ms`);
}

test("a start whose voxl exits at once fails within the panel's wait for a first frame, and says why from voxl's log", async () => {
  const { start, stopped } = await world({ FAKE_VOXL_FAILS: "1", BBBOX_VOXL_IDLE_SECONDS: "0" });
  failedInTime(start(), /no display :99/);
  await stopped();
});

test("a start whose voxl takes connections and never answers, and outlasts the start, fails within the panel's wait for a first frame, and says why from voxl's log", async () => {
  const pidFile = join(mkdtempSync(join(tmpdir(), "bb-box-voxl-pid-")), "fake.pid");
  folders.push(join(pidFile, ".."));
  const { start, stopped } = await world({ FAKE_VOXL_HANGS: pidFile, BBBOX_VOXL_IDLE_SECONDS: "0" });
  try {
    failedInTime(start(), /XShm GetImage failed/);
  } finally {
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    await stopped();
  }
});

test("the launcher's longest start fits inside the start command's budget, which fits inside the relay's", () => {
  const script = readFileSync(LAUNCHER, "utf8");
  const budgetMs = Number(/^start_budget_ms=(\d+)$/m.exec(script)![1]);
  assert.ok(budgetMs < firstFrameMs() - 1500);
  assert.ok(budgetMs < VOXL_START_TIMEOUT_MS);
  assert.ok(VOXL_START_TIMEOUT_MS < VOXL_CONNECT_MS);
});
