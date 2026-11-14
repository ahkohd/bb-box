// Loaded into each test file's process (npm test): once the file's tests are
// done, a process that does not end within a while, kept alive by a child
// process, a server or a timer a test left behind, says what keeps it and
// fails, rather than holding the whole run until CI's limit (twice on
// 19 October 2026). Its own timer is unref'd, so a process that ends as it
// should never sees it.

import { readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach } from "node:test";
import { OWNER_FILE, TEMP_PREFIX, shortTempBase } from "../src/core/temp-folders.ts";
import { helperChildrenNotClosed } from "../src/transports/forker.ts";
import { installHostGuard, reachedTestMachineMessage } from "./host-guard.ts";

/** How long a test file's process may run on after its last test. */
const EXIT_WAIT_MS = 60_000;

function foldersThisProcessLeft(): string[] {
  const left: string[] = [];
  for (const base of new Set([tmpdir(), shortTempBase()])) {
    let names: string[] = [];
    try {
      names = readdirSync(base).filter((name) => name.startsWith(TEMP_PREFIX));
    } catch {}
    for (const name of names) {
      try {
        if (readFileSync(join(base, name, OWNER_FILE), "utf8").split(" ")[0] === String(process.pid)) left.push(join(base, name));
      } catch {}
    }
  }
  return left;
}

const hostGuard = installHostGuard();

process.once("exit", () => {
  const reached = hostGuard.reached();
  hostGuard.dispose();
  if (!reached.length) return;
  process.stderr.write(`${reachedTestMachineMessage(reached)}\n`);
  process.exitCode = 1;
});

process.once("exit", () => {
  const left = foldersThisProcessLeft();
  if (!left.length) return;
  for (const dir of left) rmSync(dir, { recursive: true, force: true });
  process.stderr.write(`This test file left ${left.length} of BB Box's temporary folders that nothing disposed: ${left.join(", ")}. Dispose what made them, as BB Box does when it stops.\n`);
  process.exitCode = 1;
});

const testsRunning = { count: 0, lastEndedAt: Date.now() };
beforeEach(() => {
  testsRunning.count++;
});
afterEach(() => {
  testsRunning.count--;
  testsRunning.lastEndedAt = Date.now();
});

let waiting = false;
function failIfStillRunningAfterLastTest(): void {
  setTimeout(() => {
    if (testsRunning.count > 0 || Date.now() - testsRunning.lastEndedAt < EXIT_WAIT_MS) return failIfStillRunningAfterLastTest();
    const handles = (process as unknown as { _getActiveHandles(): object[] })._getActiveHandles().map((handle) => {
      const each = handle as { constructor?: { name?: string }; pid?: number; spawnargs?: string[]; address?: () => unknown };
      const what = [each.constructor?.name ?? "handle"];
      if (each.pid) what.push(`pid ${each.pid}: ${(each.spawnargs ?? []).join(" ").slice(-400)}`);
      if (typeof each.address === "function") what.push(JSON.stringify(each.address()));
      return what.join(" ");
    });
    process.stderr.write(
      `This test file's process still runs ${EXIT_WAIT_MS / 1000} s after its last test: ${JSON.stringify(process.getActiveResourcesInfo())}\n` +
        handles.map((line) => `  ${line}\n`).join("") +
        helperChildrenNotClosed().map((line) => `  the spawn helper's child not closed, ${line}\n`).join(""),
    );
    process.exit(1);
  }, EXIT_WAIT_MS).unref();
}

after(() => {
  if (waiting) return;
  waiting = true;
  failIfStillRunningAfterLastTest();
});
