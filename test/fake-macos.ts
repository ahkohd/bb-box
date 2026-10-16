// A fake Mac for the SSH host pool's Mac helper and setup (047): a directory
// laid out as a Mac's disk, and stub macOS tools that keep the Mac's state in
// files (test/fake-macos.sh), so the helper runs on Linux.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const POOL = fileURLToPath(new URL("../setup/ssh-pool/", import.meta.url));
const TOOLS = fileURLToPath(new URL("./fake-macos.sh", import.meta.url));
const TOOL_NAMES = [
  "id", "dscl", "sysadminctl", "dseditgroup", "createhomedir", "defaults", "launchctl", "sudo", "stat", "sysctl", "sw_vers",
  "uname", "fdesetup", "ioreg", "visudo", "chflags", "chown", "find", "crontab", "ipcs", "ipcrm", "pgrep",
  "pkill", "date", "shutdown", "node", "npm", "git", "gh", "brew", "pmset", "softwareupdate", "mdutil", "xcode-select",
  "xcodebuild", "xcrun", "DevToolsSecurity", "open", "scutil", "ipconfig", "curl", "shasum", "osascript",
  "dsmemberutil", "csrutil", "lsof", "plutil", "codesign", "csreq",
];
/** Where the Data volume's folders appear at the top of a Mac's disk. */
const FIRMLINKS = ["Users", "private", "Library", "Applications", "opt", "usr"];

export interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface FakeMacos {
  /** The Mac's disk, with ROOT set to it in the helper and setup. */
  readonly root: string;
  /** The Data volume, where the helper sweeps. */
  readonly data: string;
  /** The tools' state, as test/fake-macos.sh describes it. */
  readonly state: string;
  /** Runs the helper, as root, with `input` on stdin. */
  helper(args: readonly string[], input?: string): Run;
  /** Runs setup-mac.sh, as root through sudo by `sudoUser`. */
  setup(args: readonly string[], sudoUser?: string): Run;
  /** A file under the Mac's disk, such as /var/db/bb-box/generation, or null when it is missing. */
  file(path: string): string | null;
  /** A user's attributes, or null when there is no such user. */
  user(name: string): Record<string, string> | null;
  users(): string[];
  members(group: string): string[];
  console(): string;
  setConsole(user: string): void;
  /** Turns one of test/fake-macos.sh's flags on, with `content`, or off. */
  flag(name: string, on?: boolean, content?: string): void;
  /** Each tool call, as "<tool> <arguments>". */
  calls(): string[];
  /** Records that `uid` owns a path on the Mac's disk, as a box's file. */
  own(path: string, uid: number): void;
  /** Adds a line to one of the state's files, such as processes. */
  add(file: string, line: string): void;
  lines(file: string): string[];
  clock(seconds: number): void;
}

/** Copies a script with its ROOT= and PATH= lines pointing at the fake Mac. */
function rewrite(from: string, to: string, root: string, bin: string): void {
  let text = readFileSync(from, "utf8");
  for (const [pattern, line] of [[/^ROOT=$/m, `ROOT='${root}'`], [/^PATH=.*$/m, `PATH=${bin}:/usr/bin:/bin`]] as const) {
    assert.equal(text.match(new RegExp(pattern.source, "gm"))?.length, 1, `${from} has one ${pattern.source} line`);
    text = text.replace(pattern, line);
  }
  writeFileSync(to, text, { mode: 0o755 });
}

/**
 * A fresh fake Mac: Apple silicon, FileVault off, Remote Login on with Full
 * Disk Access, nobody at the console, a person's account `person` (UID 501), and the groups every
 * Mac has. `template` installs bb-box's home template, as setup would.
 */
export function fakeMacos(options: { template?: boolean } = {}): FakeMacos {
  const dir = realpathSync(tempDir("macos"));
  const root = join(dir, "root");
  const data = join(root, "System", "Volumes", "Data");
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  const pool = join(dir, "pool");

  for (const path of [
    "Users/Shared", "private/tmp", "private/var/db", "private/var/folders", "private/var/at/tabs", "private/etc/sudoers.d", "private/etc/ssh",
    "Library/LaunchDaemons", "Library/Preferences", "Library/Application Support/com.apple.TCC", "Applications", "opt", "usr/local/bin",
    "usr/local/share",
  ]) {
    mkdirSync(join(data, path), { recursive: true });
  }
  // The privacy database, which the helper reads only with Full Disk Access.
  writeFileSync(join(data, "Library/Application Support/com.apple.TCC/TCC.db"), "SQLite format 3\0");
  for (const name of FIRMLINKS) symlinkSync(join("System", "Volumes", "Data", name), join(root, name));
  for (const name of ["var", "tmp", "etc"]) symlinkSync(join("private", name), join(root, name));

  for (const path of ["users", "groups/_developer", "groups/staff", "groups/admin", "defaults", "flags", "secrets"]) mkdirSync(join(state, path), { recursive: true });
  for (const [name, value] of Object.entries({ UniqueID: "501", PrimaryGroupID: "20", RealName: "Person", NFSHomeDirectory: "/Users/person" })) {
    mkdirSync(join(state, "users", "person"), { recursive: true });
    writeFileSync(join(state, "users", "person", name), `${value}\n`);
  }
  writeFileSync(join(state, "groups", "admin", "GroupMembership"), "root\nperson\n");
  writeFileSync(join(state, "console"), "root\n");
  for (const file of ["calls", "owners", "processes", "at", "ipc"]) writeFileSync(join(state, file), "");

  mkdirSync(bin);
  for (const tool of TOOL_NAMES) symlinkSync(TOOLS, join(bin, tool));

  mkdirSync(pool);
  rewrite(join(POOL, "machine-mac.sh"), join(pool, "machine-mac.sh"), root, bin);
  rewrite(join(POOL, "setup-mac.sh"), join(pool, "setup-mac.sh"), root, bin);
  cpSync(join(POOL, "mac-home"), join(pool, "mac-home"), { recursive: true });
  if (options.template !== false) cpSync(join(POOL, "mac-home"), join(data, "usr", "local", "share", "bb-box", "home"), { recursive: true });

  const env = { FAKE_MAC_STATE: state, FAKE_MAC_ROOT: root, FAKE_MAC_BIN: bin, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" };
  const run = (script: string, args: readonly string[], input: string, more: Record<string, string> = {}): Run => {
    const result = spawnSync("/bin/sh", [script, ...args], { input, encoding: "utf8", env: { ...env, ...more }, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  const lines = (file: string) => (read(join(state, file)) ?? "").split("\n").filter(Boolean);

  return {
    root,
    data,
    state,
    helper: (args, input = "") => run(join(pool, "machine-mac.sh"), args, input),
    setup: (args, sudoUser = "person") => run(join(pool, "setup-mac.sh"), args, "", { SUDO_USER: sudoUser }),
    file: (path) => read(join(root, path)),
    user(name) {
      const record = join(state, "users", name);
      if (!existsSync(record)) return null;
      return Object.fromEntries(readdirSync(record).map((attribute) => [attribute, readFileSync(join(record, attribute), "utf8").trim()]));
    },
    users: () => readdirSync(join(state, "users")).sort(),
    members: (group) => lines(join("groups", group, "GroupMembership")),
    console: () => readFileSync(join(state, "console"), "utf8").trim(),
    setConsole: (user) => writeFileSync(join(state, "console"), `${user}\n`),
    flag(name, on = true, content = "") {
      if (on) writeFileSync(join(state, "flags", name), content);
      else rmSync(join(state, "flags", name), { force: true });
    },
    calls: () => lines("calls"),
    own: (path, uid) => appendFileSync(join(state, "owners"), `${uid} ${realpathSync(join(root, path))}\n`),
    add: (file, line) => appendFileSync(join(state, file), `${line}\n`),
    lines,
    clock: (seconds) => writeFileSync(join(state, "clock"), `${seconds}\n`),
  };
}
