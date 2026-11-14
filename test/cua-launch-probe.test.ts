import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const PROBE = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/files/cua-launch-probe.mjs", import.meta.url));
const THE_PROBES_OWN_GROUP = "-process.ppid";

function fakeCuaDriver(launchedPid: string): string {
  const bin = tempDir("fake-cua-driver");
  const driver = `#!${process.execPath}
const readline = require("node:readline");
const window = { window_id: 7, pid: process.pid, title: "probe", app_name: "probe", bounds: { width: 640, height: 480 } };
let listed = 0;
const answers = {
  initialize: () => ({}),
  launch_app: () => ({ structuredContent: { pid: ${launchedPid} } }),
  list_windows: () => ({ structuredContent: { windows: listed++ === 0 ? [] : [window] } }),
  get_window_state: () => ({ structuredContent: { element_count: 3 } }),
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id == null) return;
  const answer = answers[message.method === "tools/call" ? message.params.name : message.method];
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answer() }) + "\\n");
});
`;
  writeFileSync(join(bin, "cua-driver"), driver, { mode: 0o755 });
  return bin;
}

function probeEnded(bin: string): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
  const probe = spawn(process.execPath, [PROBE, "--app", "probe"], { detached: true, stdio: "ignore", env: { PATH: `${bin}:${process.env.PATH}` } });
  return new Promise((resolve) => probe.once("exit", (code, signal) => resolve({ code, signal })));
}

test("the Cua launch probe signals no pid that is not a positive whole number, so a launch that reports a negative pid signals no process group (#1064)", async () => {
  const ended = await probeEnded(fakeCuaDriver(THE_PROBES_OWN_GROUP));

  assert.deepEqual(ended, { code: 0, signal: null });
});
