#!/usr/bin/env node
// A stand-in for the docker CLI in tests, for the commands the Docker
// backend runs. Its daemon's state is under $FAKE_DOCKER_ROOT:
//
// - host.json: what `docker info` says, and switches: down (the daemon does
//   not answer), failStart (a container stops as it starts) and neverReady
//   (a container never writes its ready file).
// - images.json: each image and its labels. image-ids.json: each image's ID,
//   which a tag shares; an image without one has an ID of its name's.
//   networks.json: each network and its labels.
// - containers/<name>/: a container. config.json is what `container inspect`
//   prints; home/ is the box user's home, run/ is /run, var-lib/ is /var/lib
//   and libexec/ is /usr/local/libexec.
//
// `docker exec` runs the command on the test machine as the real user, in the
// container's home, with /home/box, /run/bb-box/, /var/lib/bb-box/,
// /usr/share/bb-box/ and /usr/local/libexec/bb-box/ in its arguments made the
// container's own, in
// the test process's group of fakes, through the command line $FAKE_GROUP
// holds, so what it starts ends with the test process, though a timeout kills
// only this (#320). Every call is logged to log, one JSON array per line.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";

const root = process.env.FAKE_DOCKER_ROOT;
if (!root) {
  process.stderr.write("FAKE_DOCKER_ROOT is not set\n");
  process.exit(2);
}
mkdirSync(join(root, "containers"), { recursive: true });
let args = process.argv.slice(2);
appendFileSync(join(root, "log"), `${JSON.stringify(args)}\n`);
if (args[0] === "-H") args = args.slice(2);

const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const read = (file, fallback) => (existsSync(join(root, file)) ? JSON.parse(readFileSync(join(root, file), "utf8")) : fallback);
const write = (file, value) => writeFileSync(join(root, file), JSON.stringify(value, null, 2));
const host = read("host.json", {});
const dir = (name) => join(root, "containers", name);
const names = () => readdirSync(join(root, "containers")).filter((name) => existsSync(join(dir(name), "config.json")));
const load = (name) => JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8"));
const save = (container) => writeFileSync(join(dir(container.Name.slice(1)), "config.json"), JSON.stringify(container, null, 2));
/** A container by name, full ID or ID prefix of 12 or more. */
const find = (ref) => names().map(load).find((container) => container.Name === `/${ref}` || (ref.length >= 12 && container.Id.startsWith(ref))) ?? null;
const MiB = 1024 * 1024;

if (host.down && args[0] !== "--version") {
  fail("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?");
}

function info() {
  const gpus = host.gpus ?? [];
  console.log(
    JSON.stringify({
      Name: host.name ?? "fake-docker",
      ServerVersion: "29.0.0",
      OperatingSystem: host.operatingSystem ?? "Ubuntu 24.04 LTS",
      OSType: host.osType ?? "linux",
      Architecture: host.arch ?? "x86_64",
      NCPU: host.cpus ?? 16,
      MemTotal: (host.memoryMiB ?? 65536) * MiB,
      SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns", ...(host.rootless ? ["name=rootless"] : [])],
      CpuCfsQuota: host.cpuLimit ?? true,
      MemoryLimit: host.memoryLimit ?? true,
      DiscoveredDevices: gpus.length ? [{ Source: "cdi", ID: "nvidia.com/gpu=all" }, ...gpus.map((id) => ({ Source: "cdi", ID: id }))] : null,
    }),
  );
}

function create(rest) {
  const labels = {};
  const env = [];
  const devices = [];
  const options = {};
  let i = 0;
  const value = () => rest[++i];
  for (; i < rest.length && rest[i].startsWith("--"); i++) {
    const flag = rest[i];
    if (flag === "--label") {
      const [key, ...parts] = value().split("=");
      labels[key] = parts.join("=");
    } else if (flag === "--env") env.push(value());
    else if (flag === "--device") devices.push(value());
    else if (["--init", "--privileged"].includes(flag)) options[flag] = true;
    else options[flag] = value();
  }
  const [image, ...command] = rest.slice(i);
  const name = options["--name"];
  const images = read("images.json", {});
  if (!(image in images)) fail(`Error response from daemon: No such image: ${image}`);
  const network = options["--network"];
  if (!(network in read("networks.json", {}))) fail(`Error response from daemon: network ${network} not found`);
  for (const device of devices) {
    if (!(host.gpus ?? []).includes(device)) fail(`Error response from daemon: could not select device driver "cdi" with capabilities: []: unresolvable CDI devices ${device}`);
  }
  const id = randomBytes(32).toString("hex");
  try {
    mkdirSync(dir(name));
  } catch {
    fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${find(name)?.Id ?? "?"}". You have to remove (or rename) that container to be able to reuse that name.`);
  }
  mkdirSync(join(dir(name), "home"));
  const count = names().length + 1;
  save({
    Id: id,
    Name: `/${name}`,
    State: { Status: "created", ExitCode: 0 },
    Config: { Hostname: options["--hostname"], Image: image, Labels: labels, Env: env, Cmd: command },
    HostConfig: {
      NanoCpus: Math.round(Number(options["--cpus"]) * 1e9),
      Memory: Number.parseInt(options["--memory"], 10) * MiB,
      MemorySwap: Number.parseInt(options["--memory-swap"], 10) * MiB,
      ShmSize: Number.parseInt(options["--shm-size"], 10) * MiB,
      Privileged: options["--privileged"] === true,
      Init: options["--init"] === true,
      RestartPolicy: { Name: options["--restart"] },
      Devices: devices,
    },
    NetworkSettings: { Networks: { [network]: { IPAddress: "" } } },
    // Kept for the address it gets when it starts.
    FakeAddress: `172.30.0.${count + 1}`,
  });
  console.log(id);
}

function container(command, rest) {
  switch (command) {
    case "create":
      return create(rest);
    case "ls": {
      const filters = [];
      for (let i = 0; i < rest.length; i++) if (rest[i] === "--filter") filters.push(rest[++i].replace(/^label=/, ""));
      for (const found of names().map(load)) {
        const labels = found.Config.Labels;
        if (filters.every((filter) => {
          const [key, ...parts] = filter.split("=");
          return labels[key] === parts.join("=");
        })) console.log(found.Id);
      }
      return;
    }
    case "inspect": {
      const refs = rest.filter((ref) => !ref.startsWith("-"));
      const found = refs.map((ref) => [ref, find(ref)]);
      console.log(JSON.stringify(found.filter(([, entry]) => entry).map(([, entry]) => entry), null, 2));
      const missing = found.find(([, entry]) => !entry);
      if (missing) fail(`Error response from daemon: No such container: ${missing[0]}`);
      return;
    }
    case "start": {
      const found = find(rest.at(-1)) ?? fail(`Error response from daemon: No such container: ${rest.at(-1)}`);
      const name = found.Name.slice(1);
      mkdirSync(join(dir(name), "run", "bb-box"), { recursive: true });
      if (host.failStart) {
        writeFileSync(join(dir(name), "logs"), "bb-box-start: something went wrong\n");
        found.State = { Status: "exited", ExitCode: 1 };
      } else {
        if (!host.neverReady) writeFileSync(join(dir(name), "run", "bb-box", "ready"), "");
        found.State = { Status: "running", ExitCode: 0 };
        for (const network of Object.values(found.NetworkSettings.Networks)) network.IPAddress = found.FakeAddress;
      }
      save(found);
      return console.log(name);
    }
    case "stop": {
      const found = find(rest.at(-1)) ?? fail(`Error response from daemon: No such container: ${rest.at(-1)}`);
      rmSync(join(dir(found.Name.slice(1)), "run"), { recursive: true, force: true });
      found.State = { Status: "exited", ExitCode: 0 };
      for (const network of Object.values(found.NetworkSettings.Networks)) network.IPAddress = "";
      save(found);
      return console.log(rest.at(-1));
    }
    case "rm": {
      const found = find(rest.at(-1)) ?? fail(`Error response from daemon: No such container: ${rest.at(-1)}`);
      rmSync(dir(found.Name.slice(1)), { recursive: true, force: true });
      return console.log(rest.at(-1));
    }
    case "commit": {
      // The image of a container: its image's labels, the container's, then each --change LABEL.
      const [ref, tag] = rest.filter((arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--change");
      const found = find(ref) ?? fail(`Error response from daemon: No such container: ${ref}`);
      const images = read("images.json", {});
      const labels = { ...(images[found.Config.Image] ?? {}), ...found.Config.Labels };
      for (let i = 0; i < rest.length; i++) {
        const change = rest[i] === "--change" ? rest[++i] : null;
        const label = change && /^LABEL ([^=]+)=(.*)$/s.exec(change);
        if (label) labels[label[1]] = JSON.parse(label[2]);
      }
      write("images.json", { ...images, [tag]: labels });
      write("image-ids.json", { ...read("image-ids.json", {}), [tag]: `sha256:${randomBytes(32).toString("hex")}` });
      return console.log(`sha256:${randomBytes(32).toString("hex")}`);
    }
    case "logs": {
      const found = find(rest.at(-1)) ?? fail(`Error response from daemon: No such container: ${rest.at(-1)}`);
      const logs = join(dir(found.Name.slice(1)), "logs");
      if (existsSync(logs)) process.stdout.write(readFileSync(logs));
      return;
    }
    default:
      fail(`fake docker: unknown command container ${command}`, 2);
  }
}

function exec(rest) {
  const env = {};
  let workdir = null;
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    const flag = rest[i];
    if (flag === "-i") continue;
    if (flag === "-e" || flag === "--env") {
      const [key, ...parts] = rest[++i].split("=");
      env[key] = parts.join("=");
    } else if (flag === "-w" || flag === "--workdir") workdir = rest[++i];
    else if (flag === "-u" || flag === "--user") i++;
    else fail(`fake docker: unknown exec flag ${flag}`, 2);
  }
  const ref = rest[i];
  const found = find(ref) ?? fail(`Error response from daemon: No such container: ${ref}`);
  if (found.State.Status !== "running") fail(`Error response from daemon: container ${found.Id} is not running`);
  const name = found.Name.slice(1);
  const home = join(dir(name), "home");
  const own = (text) =>
    text
      .replaceAll("/run/bb-box/", `${join(dir(name), "run", "bb-box")}/`)
      .replaceAll("/var/lib/bb-box/", `${join(dir(name), "var-lib", "bb-box")}/`)
      .replaceAll("/usr/share/bb-box/", `${join(dir(name), "usr-share", "bb-box")}/`)
      .replaceAll("/usr/local/libexec/bb-box/", `${join(dir(name), "libexec", "bb-box")}/`)
      .replaceAll("/home/box", home);
  const [command, ...commandArgs] = [...JSON.parse(process.env.FAKE_GROUP ?? "[]"), ...rest.slice(i + 1).map(own)];
  const child = spawn(command, commandArgs, {
    cwd: workdir ? own(workdir) : home,
    env: { PATH: process.env.PATH, HOME: home, ...env },
    stdio: "inherit",
  });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(`OCI runtime exec failed: ${error.message}`, 126));
  child.on("exit", (code, signal) => process.exit(code ?? 128 + (constants.signals[signal] ?? 0)));
}

const [command, ...rest] = args;
switch (command) {
  case "--version":
    console.log("Docker version 29.0.0, build fake");
    break;
  case "info":
    info();
    break;
  case "container":
    container(rest[0], rest.slice(1));
    break;
  case "exec":
    exec(rest);
    break;
  case "network": {
    const [sub, ...more] = rest;
    const networks = read("networks.json", {});
    const network = more.at(-1);
    if (sub === "inspect") {
      if (!(network in networks)) fail(`Error response from daemon: network ${network} not found`);
      const format = more[more.indexOf("--format") + 1];
      console.log(format === "{{json .Labels}}" ? JSON.stringify(networks[network]) : network);
    } else if (sub === "create") {
      if (network in networks) fail(`Error response from daemon: network with name ${network} already exists`);
      const labels = {};
      for (let i = 0; i < more.length; i++) {
        if (more[i] === "--label") {
          const [key, ...parts] = more[++i].split("=");
          labels[key] = parts.join("=");
        }
      }
      write("networks.json", { ...networks, [network]: labels });
      console.log(randomBytes(32).toString("hex"));
    } else fail(`fake docker: unknown command network ${sub}`, 2);
    break;
  }
  case "image": {
    const images = read("images.json", {});
    const ids = read("image-ids.json", {});
    const idOf = (name) => ids[name] ?? `sha256:${createHash("sha256").update(name).digest("hex")}`;
    /** The names of an image, by a name or an ID. */
    const named = (ref) => (ref in images ? [ref] : Object.keys(images).filter((name) => idOf(name) === ref));
    const used = (names) => names.find((name) => (names.length === Object.keys(images).filter((other) => idOf(other) === idOf(name)).length) && containersOf(name));
    const containersOf = (name) => listContainers().some((container) => container.Config.Image === name);
    const listContainers = () => readdirSync(join(root, "containers")).filter((n) => existsSync(join(root, "containers", n, "config.json"))).map((n) => JSON.parse(readFileSync(join(root, "containers", n, "config.json"), "utf8")));
    const [sub, ...more] = rest;
    if (sub === "inspect") {
      const image = more.at(-1);
      const [name] = named(image);
      if (!name) fail(`Error response from daemon: No such image: ${image}`);
      const format = more[more.indexOf("--format") + 1];
      // Its size, in bytes, from image-sizes.json where a test sets it, else as a desktop image's (#474).
      const size = read("image-sizes.json", {})[name] ?? 6_500_000_000;
      console.log(format === "{{.Id}}" ? idOf(name) : format === "{{.Size}} {{json .Config.Labels}}" ? `${size} ${JSON.stringify(images[name])}` : JSON.stringify(images[name]));
    } else if (sub === "tag") {
      const [source, target] = more;
      const [name] = named(source);
      if (!name) fail(`Error response from daemon: No such image: ${source}`);
      write("images.json", { ...images, [target]: images[name] });
      write("image-ids.json", { ...ids, [target]: idOf(name) });
    } else if (sub === "rm") {
      const ref = more.at(-1);
      const names = named(ref);
      if (!names.length) fail(`Error response from daemon: No such image: ${ref}`);
      // By ID, every name goes, unless a container uses the image; by name, the name goes, as a tag, unless it is the image's last and a container uses it.
      const gone = ref in images ? [ref] : names;
      const busy = ref in images ? (used([ref]) ? ref : null) : names.find(containersOf) ?? null;
      if (busy) fail(`Error response from daemon: conflict: unable to delete ${ref} - image is being used by stopped container`);
      const left = { ...images };
      for (const name of gone) delete left[name];
      write("images.json", left);
      console.log(`Untagged: ${gone.join(" ")}`);
    } else if (sub === "ls") {
      const filters = [];
      for (let i = 0; i < more.length; i++) if (more[i] === "--filter") filters.push(more[++i].replace(/^label=/, ""));
      for (const [name, labels] of Object.entries(images)) {
        const matches = filters.every((filter) => {
          const [key, ...parts] = filter.split("=");
          return parts.length ? labels[key] === parts.join("=") : key in labels;
        });
        if (matches) console.log(name);
      }
    } else fail(`fake docker: unknown command image ${sub}`, 2);
    break;
  }
  default:
    fail(`fake docker: unknown command ${command}`, 2);
}
