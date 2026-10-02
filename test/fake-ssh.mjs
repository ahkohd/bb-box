#!/usr/bin/env node
// A stand-in for `ssh` in tests. It runs the remote command locally with
// `sh -c`, in a home directory per host under $FAKE_SSH_DIR. A host is down
// while $FAKE_SSH_DIR/down/<host> exists; $FAKE_SSH_DIR/up-after/<host> holds
// how many more dials fail before it answers. Paths under /run/bb-box/ map to
// run/bb-box/ in the host's home, where the desktop's display mode starts as
// gpu, or as $FAKE_SSH_DIR/display/<host> holds it (a mode line, then a reason).
// Starting a shared connection (-N) dials like a command and makes its
// socket, a plain file, once $FAKE_SSH_DIR/hold-share/<host> is gone; -O
// succeeds, and -O exit removes the socket. Their log entries have an empty
// command and say which they were.
//
// A host is Windows while $FAKE_SSH_DIR/windows/<host> exists. It refuses a
// command line over 32,767 characters, as Windows does, and stands in for
// PowerShell with bb-box's own commands: it decodes a script, or stages one
// in tmp/ in the host's home, then runs the script, less its PowerShell exit
// check, with `sh -c`. When $FAKE_SSH_DIR/powershell/<host> exists, a sh
// script that stands in for PowerShell, it runs that with the script as $1.
//
// The command runs in the test process's group of fakes, through the command
// line $FAKE_GROUP holds, so what it starts ends with the test process,
// though a timeout kills only this (#320).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const control = args.includes("-O") ? args[args.indexOf("-O") + 1] : args.includes("-N") ? "master" : null;
const split = control ? args.length : args.indexOf("--");
const target = args[split - 1];
const command = args.slice(split + 1).join(" ");
const host = target.slice(target.indexOf("@") + 1);
const root = process.env.FAKE_SSH_DIR;
appendFileSync(join(root, "log"), JSON.stringify({ target, command, args: args.slice(0, split - 1), ...(control ? { control } : {}) }) + "\n");
const socket = args.find((arg) => arg.startsWith("ControlPath="))?.slice("ControlPath=".length);
if (control === "exit") rmSync(socket, { force: true });
if (control && control !== "master") process.exit(0);

const refuse = () => {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`);
  process.exit(255);
};
if (existsSync(join(root, "down", host))) refuse();
const upAfter = join(root, "up-after", host);
if (existsSync(upAfter)) {
  const left = Number(readFileSync(upAfter, "utf8"));
  if (left > 0) {
    writeFileSync(upAfter, String(left - 1));
    refuse();
  }
}
if (control) {
  while (existsSync(join(root, "hold-share", host))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  writeFileSync(socket, "");
  process.exit(0);
}
const home = join(root, "home", host);
const run = join(home, "run", "bb-box");
mkdirSync(run, { recursive: true });
if (!existsSync(join(run, "display-mode"))) {
  const forced = join(root, "display", host);
  const [mode, reason] = existsSync(forced) ? readFileSync(forced, "utf8").split("\n") : ["gpu", "GPU has 7800 MiB free"];
  writeFileSync(join(run, "display-mode"), `${mode}\n`);
  writeFileSync(join(run, "display-reason"), `${reason ?? ""}\n`);
}
let script = command;
if (existsSync(join(root, "windows", host))) {
  if (command.length > 32_767) {
    process.stderr.write("The command line is too long.\n");
    process.exit(1);
  }
  const tmp = join(home, "tmp");
  mkdirSync(tmp, { recursive: true });
  const stage = /GetTempPath\(\)\) '([^']+)';\$f=/.exec(command);
  const staged = /GetTempPath\(\)\) '([^']+)';\$s=/.exec(command);
  const encoded = /FromBase64String\('([A-Za-z0-9+/=]*)'\)/.exec(command);
  if (stage) {
    writeFileSync(join(tmp, stage[1]), readFileSync(0));
    process.exit(0);
  }
  const text = staged ? readFileSync(join(tmp, staged[1]), "utf8") : encoded ? Buffer.from(encoded[1], "base64").toString("utf8") : command;
  if (staged) rmSync(join(tmp, staged[1]));
  script = text.replace(/\nif\(-not \$\?\)\{.*\}$/, "");
}
const powershell = join(root, "powershell", host);
const shell = existsSync(powershell) ? [powershell] : ["-c"];
const [binary, ...argv] = [...JSON.parse(process.env.FAKE_GROUP ?? "[]"), "sh", ...shell, script.replaceAll("/run/bb-box/", `${run}/`)];
const result = spawnSync(binary, argv, {
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, USER: target.split("@")[0] },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
