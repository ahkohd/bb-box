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
const result = spawnSync("sh", ["-c", command.replaceAll("/run/bb-box/", `${run}/`)], {
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, USER: target.split("@")[0] },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
