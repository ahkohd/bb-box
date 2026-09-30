#!/usr/bin/env node
// A stand-in for `ssh` in tests. It runs the remote command locally with
// `sh -c`, in a home directory per host under $FAKE_SSH_DIR. A host is down
// while $FAKE_SSH_DIR/down/<host> exists; $FAKE_SSH_DIR/up-after/<host> holds
// how many more dials fail before it answers.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const split = args.indexOf("--");
const target = args[split - 1];
const command = args.slice(split + 1).join(" ");
const host = target.slice(target.indexOf("@") + 1);
const root = process.env.FAKE_SSH_DIR;
appendFileSync(join(root, "log"), JSON.stringify({ target, command, args: args.slice(0, split - 1) }) + "\n");

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
const home = join(root, "home", host);
mkdirSync(home, { recursive: true });
const result = spawnSync("sh", ["-c", command], {
  cwd: home,
  env: { PATH: process.env.PATH, HOME: home, USER: target.split("@")[0] },
  stdio: "inherit",
});
process.exit(result.status ?? 1);
