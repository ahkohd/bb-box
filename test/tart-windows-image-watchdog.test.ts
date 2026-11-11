import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/tart/prepare-windows-image.sh", import.meta.url));

function watchdogSignal(): string {
  const found = /^signal_pidfile\(\) \{\n[\s\S]*?\n\}\n/m.exec(readFileSync(SCRIPT, "utf8"));
  assert.ok(found, "prepare-windows-image.sh signals QEMU through signal_pidfile");
  return found[0];
}

async function inOwnProcessGroup(script: string): Promise<{ readonly stdout: string; readonly signal: NodeJS.Signals | null }> {
  const child = spawn("sh", ["-c", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  const [, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  return { stdout, signal };
}

test("the Windows image build's disk watchdog signals QEMU only through a pid file holding a positive whole number (#1064)", async () => {
  const dir = tempDir("windows-watchdog");
  const pidfile = join(dir, "pid");
  const signalOf = watchdogSignal();
  const survivors: string[] = [];

  for (const held of ["", "0", "00", "abc", "-5", "12 34"]) {
    writeFileSync(pidfile, held);
    const run = await inOwnProcessGroup(`${signalOf}signal_pidfile '${pidfile}'; echo survived`);
    if (run.signal === null && run.stdout.trim() === "survived") survivors.push(held);
  }

  assert.deepEqual(survivors, ["", "0", "00", "abc", "-5", "12 34"], "no pid file that is not a positive whole number signals the build's own process group");
});

test("the Windows image build's disk watchdog ends the QEMU its pid file names", async () => {
  const dir = tempDir("windows-watchdog");
  const pidfile = join(dir, "pid");
  const qemu = spawn("sleep", ["30"], { stdio: "ignore" });
  const qemuEnded = once(qemu, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  writeFileSync(pidfile, `${qemu.pid}\n`);

  const run = await inOwnProcessGroup(`${watchdogSignal()}signal_pidfile '${pidfile}' && echo signalled`);
  const [, ended] = await qemuEnded;

  assert.equal(run.stdout.trim(), "signalled");
  assert.equal(ended, "SIGTERM");
});

function scriptFunction(name: string): string {
  const found = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(readFileSync(SCRIPT, "utf8"));
  assert.ok(found, `prepare-windows-image.sh has ${name}`);
  return found[0];
}

test("the Windows image build never says older builds can go, as a snapshot may stand on one no VM uses", async () => {
  const images = tempDir("windows-builds");
  for (const build of ["build.1", "build.2", "build.3"]) mkdirSync(join(images, build));

  const run = await inOwnProcessGroup(`step() { printf '%s\\n' "$*"; }\n${scriptFunction("note_older_builds")}images='${images}'; build=build.3; note_older_builds`);

  assert.doesNotMatch(run.stdout, /can go/);
  assert.equal(run.stdout.trim(), `older builds stay in ${images} while a VM, a snapshot or a restore stands on them, and BB Box's next image refresh removes those that nothing stands on. Do not delete them by hand: build.1 build.2`);
});
