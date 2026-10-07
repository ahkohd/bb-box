#!/usr/bin/env node
// A stand-in for bb-box's msb in tests, for the commands the microsandbox
// backend runs. Its state is under $FAKE_MSB_ROOT:
//
// - host.json: switches: neverReady (a box never writes its ready file) and
//   ghost (a name whose create fails as a failed create's leftover does).
// - images.json: each image msb has, and its labels.
// - sandboxes/<name>/: a box. config.json is what `msb inspect` prints;
//   home/ is the box user's home, run/ is /run, var-lib/ is /var/lib.
//
// `msb exec` runs the command on the test machine, in the box's home, with
// /home/box, /run/bb-box/ and /var/lib/bb-box/ in its arguments made the
// box's own, through the command line $FAKE_GROUP holds, as the fake docker
// does. Running bb-box-start writes the ready file, as the image's command
// does; neither create nor start runs it, as msb's do not. Every call is logged to log, one JSON array per line.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const root = process.env.FAKE_MSB_ROOT;
if (!root) {
  process.stderr.write("FAKE_MSB_ROOT is not set\n");
  process.exit(2);
}
mkdirSync(join(root, "sandboxes"), { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(root, "log"), `${JSON.stringify(args)}\n`);

const fail = (text, code = 1) => {
  process.stderr.write(`error: ${text}\n`);
  process.exit(code);
};
const read = (file, fallback) => (existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), "utf8")) : fallback);
const host = read("host.json", {});
const dir = (name) => join(root, "sandboxes", name);
const names = () => readdirSync(join(root, "sandboxes")).filter((name) => existsSync(join(dir(name), "config.json")));
const load = (name) => (existsSync(join(dir(name), "config.json")) ? JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8")) : null);
const save = (sandbox) => writeFileSync(join(dir(sandbox.name), "config.json"), JSON.stringify(sandbox, null, 2));
const found = (name) => load(name) ?? fail(`sandbox not found: ${name}`);
const labelled = (sandbox, filters) => filters.every((filter) => {
  const [key, ...value] = filter.split("=");
  return sandbox.config.labels[key] === value.join("=");
});

/** The flags before the first plain argument, and the rest. */
function flags(rest, takes) {
  const values = {};
  const many = { "--label": [], "--env": [], "--mount-owned": [], "--mount-disk": [] };
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    const flag = rest[i];
    if (flag === "--") break;
    if (flag in many) many[flag].push(rest[++i]);
    else if (takes.includes(flag)) values[flag] = rest[++i];
    else values[flag] = true;
  }
  return { values, many, rest: rest.slice(i) };
}

function create(rest) {
  const [image, ...after] = rest;
  const { values, many } = flags(after, ["--name", "--pull", "--hostname", "--cpus", "--memory", "--root-disk", "--tmpfs", "--net"]);
  const name = values["--name"];
  if (host.ghost === name && !values["--replace"]) fail(`sandbox already exists: sandbox '${name}' already exists; remove it, start the stopped sandbox, or recreate with .replace()`);
  if (load(name) && !values["--replace"]) fail(`sandbox already exists: sandbox '${name}' already exists; remove it, start the stopped sandbox, or recreate with .replace()`);
  const images = read("images.json", {});
  // Docker's own image, which a builder microVM runs, is pulled by digest.
  if (!(image in images) && !image.startsWith("docker:")) fail(`image not found: ${image}`);
  rmSync(dir(name), { recursive: true, force: true });
  mkdirSync(join(dir(name), "home"), { recursive: true });
  mkdirSync(join(dir(name), "run", "bb-box"), { recursive: true });
  const labels = { ...(images[image] ?? {}) };
  for (const label of many["--label"]) {
    const [key, ...value] = label.split("=");
    labels[key] = value.join("=");
  }
  const sizeMiB = (text, unit) => Number.parseInt(text, 10) * (unit === "G" ? 1024 : 1);
  save({
    name,
    status: "Running",
    config: {
      name,
      labels,
      env: many["--env"],
      mounts: many["--mount-owned"],
      disks: many["--mount-disk"],
      network: values["--net"],
      tmpfs: values["--tmpfs"],
      runtime: { hostname: values["--hostname"] },
      resources: { cpus: Number(values["--cpus"]), memory_mib: sizeMiB(values["--memory"], values["--memory"].slice(-1)) },
      image: { Oci: { reference: image, root_disk: { kind: "managed", size_mib: sizeMiB(values["--root-disk"], "G") } } },
    },
  });
  // As msb's, a create does not run the image's command, so no ready file yet.
}

function exec(rest) {
  const env = {};
  let workdir = null;
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    const flag = rest[i];
    if (flag === "--stream" || flag === "-t" || flag === "--no-tty") continue;
    if (flag === "-e" || flag === "--env") {
      const [key, ...parts] = rest[++i].split("=");
      env[key] = parts.join("=");
    } else if (flag === "-w" || flag === "--workdir") workdir = rest[++i];
    else if (flag === "-u" || flag === "--user") i++;
    else fail(`fake msb: unknown exec flag ${flag}`, 2);
  }
  const name = rest[i];
  const sandbox = found(name);
  // A builder's commands, which need Docker and the network: logged, not run.
  if (name.startsWith("bb-box-builder-")) {
    appendFileSync(join(root, "builder"), `${rest.slice(i + 2).join(" ")}\n`);
    process.stdin.resume();
    process.stdin.on("end", () => process.exit(host.failBuild && rest.join(" ").includes("build.sh") ? 1 : 0));
    return;
  }
  if (sandbox.status !== "Running") fail(`sandbox '${name}' is not running (status: ${sandbox.status})`);
  const command = rest.slice(i + 2);
  // The upkeep's reclaim, which needs root and the guest's /proc: logged, not run.
  if (command.some((arg) => arg.includes("drop_caches"))) {
    appendFileSync(join(root, "reclaims"), `${name}\n`);
    if (sandbox.config.labels["fake.cached"]) process.stdout.write(`reclaimed_kib=${sandbox.config.labels["fake.cached"]}\n`);
    return;
  }
  if (command.some((arg) => arg.includes("/usr/local/sbin/bb-box-start"))) {
    if (!host.neverReady) writeFileSync(join(dir(name), "run", "bb-box", "ready"), "");
    return;
  }
  const home = join(dir(name), "home");
  const own = (text) =>
    text
      .replaceAll("/run/bb-box/", `${join(dir(name), "run", "bb-box")}/`)
      .replaceAll("/var/lib/bb-box/", `${join(dir(name), "var-lib", "bb-box")}/`)
      .replaceAll("/home/box", home);
  const [program, ...programArgs] = [...JSON.parse(process.env.FAKE_GROUP ?? "[]"), ...command.map(own)];
  const child = spawn(program, programArgs, { cwd: workdir ? own(workdir) : home, env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: "inherit" });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(`exec failed: ${error.message}`, 126));
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
}

const [command, ...rest] = args;
switch (command) {
  case "--version":
    console.log("msb 0.7.7");
    break;
  case "create":
    create(rest);
    break;
  case "inspect":
    console.log(JSON.stringify(found(rest[0]), null, 2));
    break;
  case "ls": {
    const { many } = flags(rest, ["--format"]);
    console.log(JSON.stringify(names().map(load).filter((sandbox) => labelled(sandbox, many["--label"])).map((sandbox) => ({ name: sandbox.name, status: sandbox.status, image: sandbox.config.image.Oci.reference }))));
    break;
  }
  case "status":
    console.log(JSON.stringify(names().map(load).map((sandbox) => ({ name: sandbox.name, status: sandbox.status, cpus: sandbox.config.resources.cpus, memory_mib: sandbox.config.resources.memory_mib }))));
    break;
  case "start": {
    const sandbox = found(rest.at(-1));
    mkdirSync(join(dir(sandbox.name), "run", "bb-box"), { recursive: true });
    sandbox.status = "Running";
    save(sandbox);
    break;
  }
  case "stop": {
    const sandbox = found(rest.at(-1));
    rmSync(join(dir(sandbox.name), "run"), { recursive: true, force: true });
    sandbox.status = "Stopped";
    save(sandbox);
    break;
  }
  case "remove": {
    found(rest.at(-1));
    rmSync(dir(rest.at(-1)), { recursive: true, force: true });
    break;
  }
  case "ping": {
    const sandbox = found(rest.at(-1));
    if (sandbox.status !== "Running") fail(`sandbox '${sandbox.name}' is not running (status: ${sandbox.status}); cannot ping`);
    break;
  }
  case "modify": {
    const { many } = flags(rest.slice(1), []);
    const sandbox = found(rest[0]);
    for (const label of many["--label"]) {
      const [key, ...value] = label.split("=");
      sandbox.config.labels[key] = value.join("=");
    }
    save(sandbox);
    break;
  }
  case "exec":
    exec(rest);
    break;
  case "image": {
    const images = read("images.json", {});
    if (rest[0] !== "inspect") fail(`fake msb: unknown command image ${rest[0]}`, 2);
    if (!(rest[1] in images)) fail(`image not found: ${rest[1]}`);
    console.log(JSON.stringify({ reference: rest[1], config: { labels: images[rest[1]] } }));
    break;
  }
  default:
    fail(`fake msb: unknown command ${command}`, 2);
}
