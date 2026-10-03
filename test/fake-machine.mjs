#!/usr/bin/env node
// A stand-in for the SSH pool's helper, setup/ssh-pool/machine.sh, in tests.
// It speaks the same protocol, keeping its state in $HOME/.bb-box-state, so
// with test/fake-ssh.mjs each fake host is a pool machine. It makes no users.
// With the macos flag it stands in for machine-mac.sh: status says what a
// Mac's does, display gives the box's sign-in, and there is no `machine`
// mode. Files in .bb-box-state/flags/ change what it does:
//
//   helper           the helper version status reports instead of 1
//   arch, missing    what status reports instead of x86_64 and nothing missing
//   cores, memory, disk  what status reports instead of 4 cores, 7861 MiB and 40 GiB free
//   node, lacks      what status reports instead of Node.js v24.21.0 and none of npm, git and gh lacking
//   no-enrolment     status leaves out node and lacks, as an older helper does
//   docker, hook     status reports Docker and a reset-machine command
//   dirty            what an earlier box left; claim refuses, status reports it
//   restore-steps    how many more times a whole-machine reset says it is running
//   fail-reset       the reset fails after marking the machine resetting
//   cut-reset        as fail-reset, but as if the connection dropped, once
//   slow-status      how many milliseconds status waits before it answers
//   macos            a Mac: status adds os=macos and the rest, as below
//   no-user          the Mac's box user for this generation is not made
//   console          who is at the Mac's console instead of the box user ("" for nobody)
//   console-after    how many more times status says root is at the console
//   autologin        the automatic login instead of the box user
//   filevault-on, no-screensharing, no-fulldisk  what status reports instead of off, on and on
//   grants           the grants for `status grants`, as accessibility,screenrecording,input, instead of 1,1,1
//   xcode            the Mac's Xcode version instead of no Xcode
//   runtimes         the Simulator runtimes Xcode has instead of "iOS 26.0,watchOS 26.0" ("" for none)
//   simctl-fails     `status xcode` fails, as when simctl does not answer
//   no-status-xcode  status says nothing of Xcode, and `status xcode` is a usage error, as in an older helper
//   password         the password display gives instead of a made-up one
//   display-user     the user display gives instead of the box user
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXIT = { ok: 0, failed: 1, usage: 2, held: 3, notOurs: 4, dirty: 5, moved: 6, restoring: 10 };
const state = join(process.env.HOME, ".bb-box-state");
const flags = join(state, "flags");
mkdirSync(flags, { recursive: true });

const quit = (code, message) => {
  if (message) process.stderr.write(`${message}\n`);
  process.exit(code);
};
const read = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), "utf8") : null);
const flag = (name) => (existsSync(join(flags, name)) ? readFileSync(join(flags, name), "utf8").trim() : null);
const field = (text, name) => text?.split("\n").find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
const generation = () => {
  const text = read("generation")?.trim();
  return text && /^\d+$/.test(text) ? Number(text) : null;
};
const input = () => {
  const values = {};
  for (const line of readFileSync(0, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values[line.slice(0, at)] = line.slice(at + 1);
  }
  return values;
};
const marker = () => (read("owner") !== null ? "owner" : read("resetting") !== null ? "resetting" : "none");
const mac = flag("macos") !== null;
const PASSWORD = "fake-display-password";

/** machine-mac.sh's `status xcode`: Xcode's version and runtimes, found again and kept for plain status. */
function foundXcode() {
  const version = flag("xcode") ?? "";
  if (version && flag("simctl-fails") !== null) quit(EXIT.failed, "xcrun simctl did not list the Simulator's runtimes within 10 seconds.");
  const lines = [`xcode=${version}`, `runtimes=${version ? (flag("runtimes") ?? "iOS 26.0,watchOS 26.0") : ""}`];
  writeFileSync(join(state, "xcode"), `${lines.join("\n")}\n`);
  return lines;
}

/** What plain status says of Xcode: its version now, and the runtimes `status xcode` last found for that version. */
function knownXcode() {
  const version = flag("xcode") ?? "";
  const kept = read("xcode");
  return [`xcode=${version}`, `runtimes=${version && field(kept, "xcode") === version ? field(kept, "runtimes") : ""}`];
}

/** What machine-mac.sh's status adds, with Cua's grants only for `status grants`, and Xcode found again only for `status xcode`. */
function macLines(extra) {
  const user = flag("no-user") === null ? `bbx-${generation() ?? 0}` : "";
  let console = flag("console") ?? user;
  const after = Number(flag("console-after") ?? 0);
  if (after > 0) {
    writeFileSync(join(flags, "console-after"), String(after - 1));
    console = "root";
  }
  const lines = ["os=macos", "macos=26.0", `user=${user}`, `console=${console}`, `autologin=${flag("autologin") ?? user}`];
  lines.push(`filevault=${flag("filevault-on") !== null ? 1 : 0}`, `screensharing=${flag("no-screensharing") !== null ? 0 : 1}`, `fulldisk=${flag("no-fulldisk") !== null ? 0 : 1}`);
  if (flag("no-status-xcode") === null) lines.push(...(extra === "xcode" ? foundXcode() : knownXcode()));
  if (extra === "grants") {
    const [accessibility, screenRecording, input = "1"] = (flag("grants") ?? "1,1,1").split(",");
    lines.push(`accessibility=${console === user ? accessibility : ""}`, `screenrecording=${console === user ? screenRecording : ""}`, `input=${console === user ? input : ""}`);
  }
  return lines;
}

function status(...args) {
  if (mac && flag("no-status-xcode") !== null && args[0] === "xcode") quit(EXIT.usage, "usage: machine status [grants]");
  if (mac && !(args.length === 0 || (args.length === 1 && ["grants", "xcode"].includes(args[0])))) quit(EXIT.usage, "usage: machine status [grants | xcode]");
  const slow = Number(flag("slow-status") ?? 0);
  if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow);
  const kind = marker();
  const lines = [`helper=${flag("helper") ?? 1}`, `arch=${flag("arch") ?? (mac ? "arm64" : "x86_64")}`, "boot=fake", `generation=${generation() ?? ""}`, `marker=${kind}`];
  if (kind !== "none") lines.push(...read(kind).trim().split("\n").map((line) => `marker.${line}`));
  lines.push(`hook=${flag("hook") !== null ? 1 : 0}`, `docker=${flag("docker") !== null ? 1 : 0}`, "systemd=0", `cores=${flag("cores") ?? 4}`, `memory=${flag("memory") ?? 7861}`, `disk=${flag("disk") ?? 40}`, `missing=${flag("missing") ?? ""}`);
  if (flag("no-enrolment") === null) lines.push(`node=${flag("node") ?? "v24.21.0"}`, `lacks=${flag("lacks") ?? ""}`);
  lines.push(`dirty=${kind === "none" ? (flag("dirty") ?? "") : ""}`);
  if (mac) lines.push(...macLines(args[0]));
  console.log(lines.join("\n"));
}

/** machine-mac.sh's display: the box user's sign-in, only for the box that holds the Mac. */
function display(expected) {
  if (!mac) quit(EXIT.usage, "usage: machine status | claim | release | reset | init");
  if (!/^\d+$/.test(expected ?? "")) quit(EXIT.usage, "usage: machine display <generation>");
  const values = input();
  const text = read("owner");
  if (text === null || field(text, "install") !== values.install || field(text, "box") !== values.box || field(text, "generation") !== expected) {
    quit(EXIT.notOurs, "The Mac is not this box's.");
  }
  console.log(`user=${flag("display-user") ?? field(text, "user")}\npassword=${flag("password") ?? PASSWORD}`);
}

function claim(expected, extra) {
  if (!/^\d+$/.test(expected ?? "")) quit(EXIT.usage, "usage: machine claim <generation> [docker]");
  const values = input();
  if (!values.install || !values.box || !/^ssh-/.test(values.key ?? "")) quit(EXIT.usage, "The claim needs install=, box= and key=.");
  if (marker() !== "none") quit(EXIT.held, "Another box holds the machine.");
  const current = generation();
  if (current === null) quit(EXIT.dirty, "The machine has no reset generation.");
  if (String(current) !== expected) quit(EXIT.moved, `The machine is at reset generation ${current}, not ${expected}.`);
  if (flag("dirty")) quit(EXIT.dirty, `An earlier box left ${flag("dirty")}.`);
  if (extra === "docker" && mac) quit(EXIT.usage, "Boxes on a Mac have no Docker.");
  if (extra === "docker" && flag("hook") === null) quit(EXIT.dirty, "Docker is offered only where reset-machine restores the whole machine.");
  const user = `bbx-${current}`;
  const text = ["install", "box", "thread", "name", "kind", "created"].map((name) => `${name}=${values[name] ?? ""}`);
  text.push(`generation=${current}`, `user=${user}`, `uid=${70000 + current}`);
  writeFileSync(join(state, "owner.new"), `${text.join("\n")}\n`);
  try {
    linkSync(join(state, "owner.new"), join(state, "owner"));
  } catch {
    quit(EXIT.held, "Another box holds the machine.");
  } finally {
    rmSync(join(state, "owner.new"), { force: true });
  }
  console.log(`user=${user}\nuid=${70000 + current}`);
}

function finish(kind, mode) {
  const held = Number(field(read(kind), "generation"));
  if (kind === "owner") renameSync(join(state, "owner"), join(state, "resetting"));
  if (flag("cut-reset") !== null) {
    rmSync(join(flags, "cut-reset"));
    quit(255, "Connection to the machine closed.");
  }
  if (flag("fail-reset") !== null) quit(EXIT.failed, `reset-machine exited with 1: ${flag("fail-reset") || "the disk is full"}`);
  // A Mac's reset says it is running until the next box user is at the console.
  if (mode === "machine" || mac) {
    const steps = Number(flag("restore-steps") ?? 0);
    if (steps > 0) {
      writeFileSync(join(flags, "restore-steps"), String(steps - 1));
      quit(EXIT.restoring, "");
    }
  }
  if (flag("dirty")) quit(EXIT.failed, `The reset left ${flag("dirty")}.`);
  writeFileSync(join(state, "generation"), `${held + 1}\n`);
  rmSync(join(state, "resetting"));
  console.log(`generation=${held + 1}\nreleased=yes`);
}

function release(expected, mode) {
  if (!/^\d+$/.test(expected ?? "") || (mac && mode !== undefined)) quit(EXIT.usage, `usage: machine release <generation>${mac ? "" : " [machine]"}`);
  const values = input();
  const kind = marker();
  if (kind === "none") {
    const current = generation();
    console.log(`generation=${current ?? ""}\nreleased=${current !== null && current > Number(expected) ? "already" : "none"}`);
    return;
  }
  const text = read(kind);
  if (kind === "owner" && !values.box) quit(EXIT.notOurs, "A box holds the machine.");
  if (field(text, "install") !== values.install) quit(EXIT.notOurs, "Another bb-box install holds the machine.");
  if (values.box && field(text, "box") !== values.box) quit(EXIT.notOurs, "Another box holds the machine.");
  if (field(text, "generation") !== expected) quit(EXIT.notOurs, "The machine has moved on to a later box.");
  finish(kind, mode);
}

function reset(mode) {
  if (mac && mode !== undefined) quit(EXIT.usage, "usage: machine reset");
  const values = input();
  let kind = marker();
  if (kind === "owner") quit(EXIT.notOurs, "A box holds the machine. Release the box first.");
  if (kind === "none") {
    writeFileSync(join(state, "resetting"), `install=${values.install ?? ""}\ngeneration=${generation() ?? 0}\n`);
    kind = "resetting";
  }
  if (values.install && field(read(kind), "install") !== values.install) quit(EXIT.notOurs, "Another bb-box install holds the machine.");
  finish(kind, mode);
}

const [verb, ...args] = process.argv.slice(2);
if (verb === "status") status(...args);
else if (verb === "display") display(...args);
else if (verb === "claim") claim(...args);
else if (verb === "release") release(...args);
else if (verb === "reset") reset(...args);
else if (verb === "init") {
  if (generation() === null) writeFileSync(join(state, "generation"), "0\n");
  console.log(`generation=${generation()}`);
} else quit(EXIT.usage, "usage: machine status | claim | release | reset | init");
