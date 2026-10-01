#!/usr/bin/env node
// A stand-in for the SSH pool's helper, setup/ssh-pool/machine.sh, in tests.
// It speaks the same protocol, keeping its state in $HOME/.bb-box-state, so
// with test/fake-ssh.mjs each fake host is a pool machine. It makes no users.
// Files in .bb-box-state/flags/ change what it does:
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

function status() {
  const slow = Number(flag("slow-status") ?? 0);
  if (slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, slow);
  const kind = marker();
  const lines = [`helper=${flag("helper") ?? 1}`, `arch=${flag("arch") ?? "x86_64"}`, "boot=fake", `generation=${generation() ?? ""}`, `marker=${kind}`];
  if (kind !== "none") lines.push(...read(kind).trim().split("\n").map((line) => `marker.${line}`));
  lines.push(`hook=${flag("hook") !== null ? 1 : 0}`, `docker=${flag("docker") !== null ? 1 : 0}`, "systemd=0", `cores=${flag("cores") ?? 4}`, `memory=${flag("memory") ?? 7861}`, `disk=${flag("disk") ?? 40}`, `missing=${flag("missing") ?? ""}`);
  if (flag("no-enrolment") === null) lines.push(`node=${flag("node") ?? "v24.21.0"}`, `lacks=${flag("lacks") ?? ""}`);
  lines.push(`dirty=${kind === "none" ? (flag("dirty") ?? "") : ""}`);
  console.log(lines.join("\n"));
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
  if (mode === "machine") {
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
  if (!/^\d+$/.test(expected ?? "")) quit(EXIT.usage, "usage: machine release <generation> [machine]");
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
if (verb === "status") status();
else if (verb === "claim") claim(...args);
else if (verb === "release") release(...args);
else if (verb === "reset") reset(...args);
else if (verb === "init") {
  if (generation() === null) writeFileSync(join(state, "generation"), "0\n");
  console.log(`generation=${generation()}`);
} else quit(EXIT.usage, "usage: machine status | claim | release | reset | init");
