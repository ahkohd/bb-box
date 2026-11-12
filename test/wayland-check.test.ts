import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const GUEST = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/", import.meta.url));
const SWAY_WRITES_ITS_ENVIRONMENT_AFTER_MS = 500;
const CHECK_LINES_WITHIN_MS = 60_000;
const SWAY_LINE = "Sway and its output";

function sandbox(): { root: string; run: string; libexec: string; bin: string } {
  const root = tempDir("wayland-check");
  const run = join(root, "run");
  const libexec = join(root, "libexec");
  const bin = join(root, "bin");
  for (const dir of [run, libexec, bin]) mkdirSync(dir);
  copyFileSync(join(GUEST, "files", "display-wayland"), join(libexec, "display"));
  writeFileSync(
    join(bin, "swaymsg"),
    `#!/bin/bash
[ "\${SWAYSOCK:-}" = "$BBBOX_RUN_DIR/sway.sock" ] || { echo "[swaymsg/main.c:509] Unable to retrieve socket path" >&2; exit 1; }
case "$*" in
  *get_version*) echo '{"human_readable": "1.11"}' ;;
  *get_outputs*) echo '[{"name": "HEADLESS-1", "rect": {"width": 1920, "height": 1080}}]' ;;
esac
`,
    { mode: 0o755 },
  );
  return { root, run, libexec, bin };
}

function swayWritesItsEnvironment(run: string): void {
  writeFileSync(join(run, "display.env"), `WAYLAND_DISPLAY=wayland-1\nSWAYSOCK=${join(run, "sway.sock")}\n`);
}

async function checkLinesUpToSway(box: ReturnType<typeof sandbox>): Promise<string[]> {
  const check = spawn("bash", [join(GUEST, "check-desktop-wayland.sh")], {
    detached: true,
    env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.root, BBBOX_RUN_DIR: box.run, BBBOX_LIBEXEC: box.libexec },
    stdio: ["ignore", "pipe", "ignore"],
  });
  const lines: string[] = [];
  let pending = "";

  try {
    return await new Promise<string[]>((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error(`no "${SWAY_LINE}" line within ${CHECK_LINES_WITHIN_MS} ms: ${lines.join(" | ")}`)), CHECK_LINES_WITHIN_MS);
      check.stdout.setEncoding("utf8");
      check.stdout.on("data", (chunk: string) => {
        pending += chunk;
        const whole = pending.split("\n");
        pending = whole.pop()!;
        lines.push(...whole);
        if (whole.some((line) => line.startsWith(SWAY_LINE))) {
          clearTimeout(giveUp);
          resolve(lines);
        }
      });
      check.on("exit", () => {
        clearTimeout(giveUp);
        resolve(lines);
      });
    });
  } finally {
    try {
      process.kill(-check.pid!, "SIGKILL");
    } catch {}
  }
}

test("the Wayland check waits for Sway to write display.env before it reads it", async () => {
  const box = sandbox();
  const sway = setTimeout(() => swayWritesItsEnvironment(box.run), SWAY_WRITES_ITS_ENVIRONMENT_AFTER_MS);

  const lines = await checkLinesUpToSway(box);
  clearTimeout(sway);

  assert.match(lines[0] ?? "", /^Sway ready +ok +Sway answers, and has written display\.env$/);
  assert.match(lines.find((line) => line.startsWith(SWAY_LINE)) ?? "", /^Sway and its output +ok +1\.11 HEADLESS-1 1920x1080$/);
});

test("the Wayland check says so when Sway never writes display.env", async () => {
  const box = sandbox();

  const lines = await checkLinesUpToSway(box);

  assert.match(lines[0] ?? "", /^Sway ready +FAIL display: Sway did not answer within 10 s$/);
  assert.match(lines.find((line) => line.startsWith(SWAY_LINE)) ?? "", /^Sway and its output +FAIL .*Unable to retrieve socket path/);
});
