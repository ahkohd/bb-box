#!/usr/bin/env node
// A stand-in for bb-box's msb in tests, for the commands the microsandbox
// backend runs. Its state is under $FAKE_MSB_ROOT:
//
// - host.json: switches: neverReady (a box never writes its ready file),
//   ghost (a name whose create fails as a failed create's leftover does)
//   and failStart (a start fails with that message).
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
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
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
/**
 * A sandbox's config, or null when there is none. Other fake msb runs may
 * remove a sandbox as this one reads it, as the backend's builder and
 * helpers are removed in the background, so a config that goes as it is
 * read is none.
 */
const load = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
/** Writes a config whole, through a file of its own renamed over it, so another run never reads half of one. */
const save = (sandbox) => {
  const file = join(dir(sandbox.name), "config.json");
  writeFileSync(`${file}.${process.pid}`, JSON.stringify(sandbox, null, 2));
  renameSync(`${file}.${process.pid}`, file);
};
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
  const { values, many } = flags(after, ["--name", "--pull", "--hostname", "--cpus", "--memory", "--root-disk", "--tmpfs", "--net", "--mount-dir"]);
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
  const mounts = [
    ...(values["--tmpfs"] ? [{ guest: values["--tmpfs"], type: "Tmpfs" }] : []),
    ...many["--mount-owned"].map((spec) => ({ guest: spec.split(":")[0], type: "Owned", storage: { kind: spec.includes("kind=disk") ? "disk" : "dir" } })),
    ...many["--mount-disk"].map((spec) => ({ guest: spec.split(":")[1], host: spec.split(":")[0], type: "DiskImage" })),
  ];
  save({
    name,
    status: "Running",
    config: {
      name,
      labels,
      env: many["--env"],
      mounts,
      owned: many["--mount-owned"],
      disks: many["--mount-disk"],
      mountDir: values["--mount-dir"] ?? null,
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
  // The helper that makes the Docker disks' template: the template appears in the folder it sees.
  if (name.startsWith("bb-box-mkfs-")) {
    const made = /\/work\/(docker-\d+G\.ext4)( |$)/.exec(rest.slice(i + 2).join(" "));
    const [source] = (sandbox.config.mountDir ?? "").split(":");
    if (made && source) {
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, made[1]), "template");
    }
    appendFileSync(join(root, "mkfs"), `${rest.slice(i + 2).join(" ")}\n`);
    return;
  }
  // A builder's commands, which need Docker and the network: logged, not run.
  if (name.startsWith("bb-box-builder-")) {
    appendFileSync(join(root, "builder"), `${rest.slice(i + 2).join(" ")}\n`);
    process.stdin.resume();
    const command = rest.join(" ");
    process.stdin.on("end", async () => {
      // A build held until the test writes "release", to act while it runs.
      while (host.holdBuild && command.includes("nohup sh -c") && !existsSync(join(root, "release"))) await new Promise((resolve) => setTimeout(resolve, 20));
      // A detached build's exit code, and a guest whose kernel killed a process for memory.
      if (command.includes("cat /build/build.exit")) process.stdout.write(host.failBuild ? "1\n" : "0\n");
      if (command.includes("dmesg")) process.stdout.write("[  98.1] Out of memory: Killed process 812 (node) total-vm:6000000kB\n");
      process.exit(0);
    });
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

const snapshotsFile = join(root, "snapshots.json");
const snapshots = () => read("snapshots.json", []);
const saveSnapshots = (list) => writeFileSync(snapshotsFile, JSON.stringify(list, null, 2));
const heads = () => read("heads.json", {});
const snapshotDir = (id) => join(root, "snapshot-data", id);
const findSnapshot = (selector) => {
  const list = snapshots();
  const [group, member] = selector.split(":");
  if (host.homeThroughLink && member === undefined && list.some((each) => each.id === selector)) fail(`invalid config: snapshot identity ${selector} has 2 local copies; use group:member or an explicit artifact path`);
  return list.find((each) => each.id === selector || (member !== undefined && each.group === group && each.name === member)) ?? null;
};

function snapshot(rest) {
  const [sub, ...more] = rest;
  if (sub === "list" || sub === "ls") {
    console.log(JSON.stringify(snapshots().map((each) => ({ ...each.listed }))));
    return;
  }
  if (sub === "create") {
    const positional = more[0] && !more[0].startsWith("-") ? more[0] : null;
    const { values, many } = flags(positional ? more.slice(1) : more, ["--sandbox", "--group", "--name"]);
    const name = positional ?? values["--name"] ?? `snap-${randomBytes(3).toString("hex")}`;
    const sandbox = found(values["--sandbox"]);
    const group = values["--group"] ?? sandbox.name;
    if (host.failSnapshot) fail(host.failSnapshot);
    if (values["--full"]) {
      if (sandbox.status !== "Running") fail(`full snapshot requires a running sandbox: '${sandbox.name}' is ${sandbox.status}`);
      const disk = (sandbox.config.mounts ?? []).find((mount) => mount.type === "DiskImage");
      if (disk) fail(`control client error: control operation rejected by peer: additional block resource var_lib_doc_00000000 has no immutable-generation provider`);
    }
    const list = snapshots();
    if (list.some((each) => each.group === group && each.name === name)) fail(`snapshot ${group}:${name} already exists; installed members are immutable`);
    const id = `snap_${randomBytes(16).toString("hex")}`;
    mkdirSync(snapshotDir(id), { recursive: true });
    for (const part of ["home", "var-lib", ...(values["--full"] ? ["run"] : [])]) if (existsSync(join(dir(sandbox.name), part))) cpSync(join(dir(sandbox.name), part), join(snapshotDir(id), part), { recursive: true });
    const labels = Object.fromEntries(many["--label"].map((label) => [label.split("=")[0], label.split("=").slice(1).join("=")]));
    const parent = sandbox.lastSnapshot ?? sandbox.config.snapshot_parent ?? null;
    const at = new Date(Date.now() + list.length).toISOString();
    list.unshift({
      id,
      group,
      name,
      labels,
      source: sandbox.name,
      config: { resources: { ...sandbox.config.resources }, owned: sandbox.config.owned ?? [], disk_mib: sandbox.config.image.Oci.root_disk.size_mib, image: sandbox.config.image.Oci.reference },
      listed: { artifact_path: snapshotDir(id), availability: host.snapshotAvailability ?? "ready", created_at: at, group, name, parent_digest: parent, scope: values["--full"] ? "full" : "disk", size_bytes: values["--full"] ? null : 4294967296, snapshot_id: id },
    });
    saveSnapshots(list);
    const allHeads = heads();
    if (!allHeads[group] || allHeads[group] === parent) allHeads[group] = id;
    writeFileSync(join(root, "heads.json"), JSON.stringify(allHeads));
    sandbox.lastSnapshot = id;
    save(sandbox);
    if (!values["--quiet"]) console.log(id);
    return;
  }
  if (sub === "head") {
    const [group, member] = more[0].split(":");
    const allHeads = heads();
    const previous = allHeads[group] ?? null;
    if (member !== undefined) {
      const chosen = findSnapshot(`${group}:${member}`) ?? fail(`snapshot not found: ${more[0]}`);
      allHeads[group] = chosen.id;
      writeFileSync(join(root, "heads.json"), JSON.stringify(allHeads));
    }
    console.log(JSON.stringify({ group, previous, head: allHeads[group] ?? null, reason: member === undefined ? "unchanged" : "selected", changed: member !== undefined && previous !== allHeads[group] }));
    return;
  }
  if (sub === "remove" || sub === "rm") {
    const { values, rest: positional } = flags(more, []);
    const target = findSnapshot(positional[0]) ?? fail(`snapshot not found: ${positional[0]}`);
    const list = snapshots();
    const members = list.filter((each) => each.group === target.group && each.id !== target.id);
    if (heads()[target.group] === target.id && members.length) fail(`invalid config: cannot remove current head ${target.id}; first select another snapshot with 'msb snapshot head ${target.group}:<snapshot>'`);
    const children = list.filter((each) => each.listed.parent_digest === target.id);
    if (children.length && !values["--force"]) fail(`snapshot ${target.id} has ${children.length} indexed child snapshot(s); pass --force to remove anyway`);
    saveSnapshots(list.filter((each) => each.id !== target.id));
    rmSync(snapshotDir(target.id), { recursive: true, force: true });
    if (!members.length) {
      const allHeads = heads();
      delete allHeads[target.group];
      writeFileSync(join(root, "heads.json"), JSON.stringify(allHeads));
    }
    return;
  }
  if (sub === "inspect") {
    const target = findSnapshot(more[0]) ?? fail(`snapshot not found: ${more[0]}`);
    const labels = Object.entries(target.labels).map(([key, value]) => `${key}=${value}`).join(", ");
    process.stdout.write(`Snapshot ID:          ${target.id}\nScope:                ${target.listed.scope}\nParent:               ${target.listed.parent_digest ?? "-"}\nVirtual Size:         ${(target.config.disk_mib / 1024).toFixed(1)} GiB\nSource Sandbox:       ${target.source}\nLabels:               ${labels || "-"}\n`);
    return;
  }
  if (sub === "restore") {
    const { values } = flags(more.slice(1), ["--name", "--cpus", "--memory", "--net-default", "--net-rule"]);
    const target = findSnapshot(more[0]) ?? fail(`snapshot not found: ${more[0]}`);
    const name = values["--name"];
    if (load(name)) fail(`sandbox already exists: sandbox '${name}' already exists; remove it, start the stopped sandbox, or recreate with .replace()`);
    if (host.failRestore) fail(host.failRestore);
    const full = target.listed.scope === "full" && !values["--disk-only"];
    const memoryMiB = values["--memory"] ? Number.parseInt(values["--memory"], 10) * (values["--memory"].endsWith("G") ? 1024 : 1) : null;
    if (full && ((values["--cpus"] && Number(values["--cpus"]) !== target.config.resources.cpus) || (memoryMiB !== null && memoryMiB !== target.config.resources.memory_mib))) fail("invalid config: a full snapshot must restore with its captured CPU and memory geometry");
    rmSync(dir(name), { recursive: true, force: true });
    mkdirSync(dir(name), { recursive: true });
    for (const part of ["home", "var-lib", ...(full ? ["run"] : [])]) if (existsSync(join(snapshotDir(target.id), part))) cpSync(join(snapshotDir(target.id), part), join(dir(name), part), { recursive: true });
    mkdirSync(join(dir(name), "home"), { recursive: true });
    mkdirSync(join(dir(name), "run", "bb-box"), { recursive: true });
    const resources = full ? { ...target.config.resources } : { cpus: Number(values["--cpus"] ?? 1), memory_mib: memoryMiB ?? 512 };
    save({
      name,
      status: "Running",
      config: {
        name,
        labels: {},
        env: [],
        mounts: target.config.owned.map((spec) => ({ guest: spec.split(":")[0], type: "Owned", storage: { kind: "disk" } })),
        owned: target.config.owned,
        disks: [],
        network: "public",
        tmpfs: null,
        runtime: { hostname: null },
        resources,
        snapshot_parent: target.id,
        restoredFrom: target.id,
        image: { Oci: { reference: target.config.image, root_disk: { kind: "managed", size_mib: target.config.disk_mib } } },
      },
    });
    return;
  }
  fail(`fake msb: unknown command snapshot ${sub}`, 2);
}

const [command, ...rest] = args;
switch (command) {
  case "--version":
    console.log(`msb ${host.version ?? "0.7.7"}`);
    break;
  case "create":
    create(rest);
    break;
  case "inspect":
    console.log(JSON.stringify(found(rest[0]), null, 2));
    break;
  case "ls": {
    const { many } = flags(rest, ["--format"]);
    console.log(JSON.stringify(names().map(load).filter((sandbox) => sandbox && labelled(sandbox, many["--label"])).map((sandbox) => ({ name: sandbox.name, status: sandbox.status, image: sandbox.config.image.Oci.reference }))));
    break;
  }
  case "status":
    console.log(JSON.stringify(names().map(load).filter(Boolean).map((sandbox) => ({ name: sandbox.name, status: sandbox.status, cpus: sandbox.config.resources.cpus, memory_mib: sandbox.config.resources.memory_mib }))));
    break;
  case "start": {
    const sandbox = found(rest.at(-1));
    if (host.failStart) fail(`sandbox '${sandbox.name}' failed to start: ${host.failStart}`);
    mkdirSync(join(dir(sandbox.name), "run", "bb-box"), { recursive: true });
    // Changes saved for the next start take effect now.
    if (sandbox.pending) {
      Object.assign(sandbox.config.resources, sandbox.pending);
      delete sandbox.pending;
    }
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
    const { values, many } = flags(rest.slice(1), ["--cpus", "--memory", "--root-disk", "--format"]);
    const sandbox = found(rest[0]);
    const running = sandbox.status === "Running";
    const later = values["--next-start"] || values["--restart"];
    // As msb 0.7.7's: a root disk grows live; CPUs and memory change only for the next start, so on a running box
    // without --next-start or --restart they are refused, with exit 1, and nothing is applied.
    if (running && !later && (values["--cpus"] || values["--memory"])) {
      process.stdout.write(JSON.stringify({ sandbox: sandbox.name, applied: false, warnings: [{ message: "live CPU and memory resize are not available in this runtime yet" }] }) + "\n");
      process.exit(1);
    }
    if (values["--root-disk"]) sandbox.config.image.Oci.root_disk.size_mib = Number.parseInt(values["--root-disk"], 10) * 1024;
    const resources = {
      ...(values["--cpus"] ? { cpus: Number(values["--cpus"]) } : {}),
      ...(values["--memory"] ? { memory_mib: Number.parseInt(values["--memory"], 10) * (values["--memory"].endsWith("G") ? 1024 : 1) } : {}),
    };
    // As msb's one desired config: a change saved for the next start, or made while stopped, replaces any saved before.
    if (running && later) sandbox.pending = { ...(sandbox.pending ?? {}), ...resources };
    else {
      Object.assign(sandbox.config.resources, resources);
      for (const key of Object.keys(resources)) delete sandbox.pending?.[key];
    }
    // As msb's: a running box takes other changes only with --next-start or --restart, and without them msb applies nothing but exits 0.
    if (running && !later && !values["--root-disk"]) {
      process.stderr.write("  → no changes were applied\n");
      break;
    }
    for (const label of many["--label"]) {
      const [key, ...value] = label.split("=");
      sandbox.config.labels[key] = value.join("=");
    }
    for (const each of many["--env"]) {
      const key = each.split("=")[0];
      sandbox.config.env = [...sandbox.config.env.filter((other) => other.split("=")[0] !== key), each];
    }
    save(sandbox);
    break;
  }
  case "snapshot":
    snapshot(rest);
    break;
  case "exec":
    exec(rest);
    break;
  case "logs":
    // Its runtime's system log, as a builder that died mid-build would leave.
    found(rest.at(-1));
    console.log("INFO microsandbox_runtime::runner::relay: agent relay: client disconnected slot=0 error=agent relay: unexpected EOF");
    break;
  case "image": {
    const images = read("images.json", {});
    if (rest[0] === "remove") {
      if (!(rest[1] in images)) fail(`image not found: ${rest[1]}`);
      delete images[rest[1]];
      writeFileSync(join(root, "images.json"), JSON.stringify(images));
      break;
    }
    if (rest[0] !== "inspect") fail(`fake msb: unknown command image ${rest[0]}`, 2);
    if (!(rest[1] in images)) fail(`image not found: ${rest[1]}`);
    console.log(JSON.stringify({ reference: rest[1], config: { labels: images[rest[1]] } }));
    break;
  }
  default:
    fail(`fake msb: unknown command ${command}`, 2);
}
