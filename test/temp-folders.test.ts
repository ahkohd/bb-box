import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { OWNER_FILE, linuxProcessView, makeTempFolder, makeTempFolderSync, ownerMark, sweepStaleTempFolders } from "../src/core/temp-folders.ts";
import { KeyFile } from "../src/transports/ssh.ts";
import { RelayHub } from "../src/relay/hub.ts";
import { tempDir } from "./helpers.ts";

const DAY_MS = 24 * 3_600_000;

function folder(base: string, name: string, mark?: string, ageMs = 0): string {
  const dir = join(base, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "id"), "a key\n");
  if (mark !== undefined) writeFileSync(join(dir, OWNER_FILE), mark);
  if (ageMs) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(dir, when, when);
  }
  return dir;
}

function deadPid(): number {
  const done = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(done.stdout.trim());
}

test("a folder BB Box makes says which process owns it, so a later run can tell whether that process is gone", async () => {
  const base = tempDir("temp-owner");
  const dir = await makeTempFolder("bb-box-ssh-", base);
  const view = linuxProcessView();
  assert.equal(readFileSync(join(dir, OWNER_FILE), "utf8"), ownerMark(view));
  assert.match(readFileSync(join(dir, OWNER_FILE), "utf8"), new RegExp(`^${process.pid} \\S+\\n$`));
  const sync = makeTempFolderSync("bb-box-relay-", base);
  assert.ok(existsSync(join(sync, OWNER_FILE)));
  assert.deepEqual(sweepStaleTempFolders({ bases: [base] }).removed, [], "this process's own folders stay");
});

test("at start, BB Box removes its folders whose process is gone, or whose process ID another process has taken, and keeps a live one's", async () => {
  const base = tempDir("temp-sweep");
  const view = linuxProcessView();
  const gone = folder(base, "bb-box-ssh-gone", `${deadPid()} 12345\n`);
  const reused = folder(base, "bb-box-cm-reused", `${process.pid + 0} not-its-start\n`);
  const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    const live = folder(base, "bb-box-relay-live", `${sleeper.pid} ${view.startToken(sleeper.pid!)}\n`);
    const result = sweepStaleTempFolders({ bases: [base], view: { ...view, pid: -1 } });
    assert.deepEqual([...result.removed].sort(), [gone, reused].sort());
    assert.deepEqual(result.kept, [live]);
    assert.equal(existsSync(gone), false);
    assert.equal(existsSync(live), true);
  } finally {
    sleeper.kill();
  }
});

test("a folder an earlier BB Box left with no owner goes once it is a day old and nothing uses it", async () => {
  const base = tempDir("temp-unmarked");
  const young = folder(base, "bb-box-ssh-young");
  const old = folder(base, "bb-box-ssh-old", undefined, 2 * DAY_MS);
  const other = folder(base, "someone-else-old", undefined, 2 * DAY_MS);
  const result = sweepStaleTempFolders({ bases: [base] });
  assert.deepEqual(result.removed, [old]);
  assert.ok(existsSync(young), "younger than a day: maybe a running older BB Box's");
  assert.ok(existsSync(other), "only BB Box's folders");
});

test("an old folder with no owner stays while a socket is bound in it or a process holds a file in it", async () => {
  const base = tempDir("temp-in-use");
  const withSocket = folder(base, "bb-box-cm-master", undefined, 2 * DAY_MS);
  const withFile = folder(base, "bb-box-ssh-open", undefined, 2 * DAY_MS);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(join(withSocket, "cm.sock"), resolve));
  const fd = openSync(join(withFile, "id"), "r");
  try {
    const old = (when: Date) => utimesSync(withSocket, when, when);
    old(new Date(Date.now() - 2 * DAY_MS));
    const result = sweepStaleTempFolders({ bases: [base] });
    assert.deepEqual(result.removed, []);
    assert.deepEqual([...result.kept].sort(), [withFile, withSocket].sort());
  } finally {
    closeSync(fd);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of [withSocket, withFile]) utimesSync(dir, new Date(Date.now() - 2 * DAY_MS), new Date(Date.now() - 2 * DAY_MS));
  assert.deepEqual([...sweepStaleTempFolders({ bases: [base] }).removed].sort(), [withFile, withSocket].sort(), "once nothing uses them, they go");
});

test("another user's folders are never touched", () => {
  const base = tempDir("temp-other-user");
  const old = folder(base, "bb-box-ssh-theirs", `${deadPid()} 1\n`, 2 * DAY_MS);
  const result = sweepStaleTempFolders({ bases: [base], view: { ...linuxProcessView(), uid: (process.getuid?.() ?? 0) + 1 } });
  assert.deepEqual(result.removed, []);
  assert.ok(existsSync(old));
});

test("dispose removes the key folder and the shared connections' folder, and the relay's own folder", async () => {
  const keys = new KeyFile();
  const keyPath = await keys.path("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
  const share = await keys.shareDir();
  assert.ok(existsSync(join(keyPath, "..", OWNER_FILE)));
  assert.ok(existsSync(join(share, OWNER_FILE)));
  await keys.dispose();
  assert.equal(existsSync(keyPath), false);
  assert.equal(existsSync(share), false);

  const hub = new RelayHub({ connect: async () => { throw new Error("unused"); }, what: "Docker API" } as unknown as ConstructorParameters<typeof RelayHub>[0]);
  const socket = hub.address("host_abc").replace(/^unix:\/\//, "");
  const dir = join(socket, "..");
  assert.ok(existsSync(join(dir, OWNER_FILE)));
  await hub.dispose();
  assert.equal(existsSync(dir), false);
});
