#!/usr/bin/env node
// A stand-in for the docker CLI in tests, for the commands the Docker
// backend runs. Its daemon's state is under $FAKE_DOCKER_ROOT:
//
// - host.json: what `docker info` says, and switches: down (the daemon does
//   not answer), failStart (a container stops as it starts), neverReady
//   (a container never writes its ready file) and failUpdate (an update
//   fails with that message, and changes nothing).
// - images.json: each image and its labels. image-ids.json: each image's ID,
//   which a tag shares; an image without one has an ID of its name's.
//   networks.json: each network and its labels.
// - containers/<name>/: a container. config.json is what `container inspect`
//   prints; home/ is the box user's home, run/ is /run, var-lib/ is /var/lib
//   and libexec/ is /usr/local/libexec.
//
// `docker exec` runs the command on the test machine as the real user, in the
// container's home, with /home/box, /etc/environment, /run/bb-box/,
// /var/lib/bb-box/, /usr/share/bb-box/ and /usr/local/libexec/bb-box/ in its arguments made the
// container's own, in
// the test process's group of fakes, through the command line $FAKE_GROUP
// holds, so what it starts ends with the test process, though a timeout kills
// only this (#320). Every call is logged to log, one JSON array per line.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
const writeWhole = (path, text) => {
  const partial = `${path}.${process.pid}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, path);
};
const write = (file, value) => writeWhole(join(root, file), JSON.stringify(value, null, 2));
const host = read("host.json", {});
const dir = (name) => join(root, "containers", name);
const names = () => readdirSync(join(root, "containers")).filter((name) => existsSync(join(dir(name), "config.json")));
const load = (name) => JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8"));
const save = (container) => writeWhole(join(dir(container.Name.slice(1)), "config.json"), JSON.stringify(container, null, 2));
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
      ID: host.daemonId ?? `fake-${createHash("sha256").update(root).digest("hex").slice(0, 16)}`,
      Name: host.name ?? "fake-docker",
      DockerRootDir: host.rootDir ?? "/var/lib/docker",
      ServerVersion: "29.0.0",
      OperatingSystem: host.operatingSystem ?? "Ubuntu 24.04 LTS",
      OSType: host.osType ?? "linux",
      KernelVersion: host.kernelVersion ?? "6.8.0-generic",
      Architecture: host.arch ?? "x86_64",
      NCPU: hostCpus().length,
      MemTotal: (host.memoryMiB ?? 65536) * MiB,
      SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns", ...(host.apparmor ? ["name=apparmor"] : []), ...(host.rootless ? ["name=rootless"] : [])],
      CpuCfsQuota: host.cpuLimit ?? true,
      MemoryLimit: host.memoryLimit ?? true,
      CPUSet: host.cpuset ?? true,
      DiscoveredDevices: gpus.length || host.allGpus ? [{ Source: "cdi", ID: "nvidia.com/gpu=all" }, ...gpus.map((id) => ({ Source: "cdi", ID: id }))] : null,
    }),
  );
}

function cpusOf(list) {
  return list.split(",").flatMap((part) => {
    const [first, last = first] = part.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
}

function hostCpus() {
  return host.cpuList ? cpusOf(host.cpuList) : Array.from({ length: host.cpus ?? 16 }, (_, cpu) => cpu);
}

function checkCpus(list) {
  if (list === undefined) return;
  if (!(host.cpuset ?? true)) fail("Error response from daemon: Your kernel does not support cpuset in the cgroup.");
  const daemonList = host.daemonCpuList ?? host.cpuList;
  const available = daemonList ? cpusOf(daemonList) : hostCpus();
  if (cpusOf(list).some((cpu) => !available.includes(cpu))) fail(`Error response from daemon: Requested CPUs are not available - requested ${list}, available: ${daemonList ?? `0-${available.length - 1}`}`);
}

function mountOf(spec) {
  const fields = Object.fromEntries(spec.split(",").map((field) => (field.includes("=") ? field.split("=") : [field, true])));
  return { Type: fields.type, Source: fields.source, Target: fields.target, ReadOnly: fields.readonly === true };
}

function checkMounts(mounts) {
  for (const mount of mounts) {
    if (mount.Source.startsWith("/var/lib/lxcfs") && !host.lxcfs) fail(`Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${mount.Source}`);
  }
}

function hostCards() {
  if (host.cards) return host.cards;
  return (host.gpus ?? []).map((device, at) => {
    const uuid = /=GPU-([0-9a-f-]{36})$/i.exec(device)?.[1];
    const named = /=(\d+)$/.exec(device)?.[1];
    const index = named === undefined ? at : Number(named);
    return { index, uuid: (uuid ?? `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`).toLowerCase(), name: "NVIDIA Fake Card", totalMiB: 24576, freeMiB: 24000, device };
  });
}

function cardsGiven(devices, privileged) {
  const cards = hostCards();
  if (privileged || devices.includes("nvidia.com/gpu=all")) return cards;
  return cards.filter((card) => devices.includes(card.device ?? `nvidia.com/gpu=GPU-${card.uuid}`) || devices.includes(`nvidia.com/gpu=${card.index}`));
}

function probeCards(devices) {
  if (host.probeFails) fail(host.probeFails, 125);
  for (const card of cardsGiven(devices, false)) console.log(`${card.index}, GPU-${card.uuid}, ${card.name}, ${card.totalMiB}, ${card.freeMiB}`);
}

function run(rest) {
  appendFileSync(join(root, "probes"), `${JSON.stringify(rest)}\n`);
  const runDevices = rest.flatMap((arg, i) => (rest[i - 1] === "--device" ? [arg] : []));
  if (rest.at(-1)?.includes("--query-gpu=index,uuid,name,memory.total,memory.free")) {
    for (const device of runDevices) {
      if (!(host.gpus ?? []).includes(device) && !(device === "nvidia.com/gpu=all" && (host.gpus?.length || host.allGpus))) fail(`docker: Error response from daemon: could not select device driver "cdi" with capabilities: []: unresolvable CDI devices ${device}`, 125);
    }
    return probeCards(runDevices);
  }
  const mounts = rest.flatMap((arg, i) => (rest[i - 1] === "--mount" ? [mountOf(arg)] : []));
  if (mounts.some((mount) => mount.Source === "/var/lib/lxcfs")) {
    checkMounts(mounts);
    console.log("MemTotal:        4194304 kB");
    if (host.lxcfsCpuOnline ?? true) console.log("cpu-online");
    return;
  }
  let at = 0;
  while (at < rest.length && rest[at].startsWith("--")) at += ["--rm", "--privileged", "--init"].includes(rest[at]) ? 1 : 2;
  const [image, ...command] = rest.slice(at);
  if (command.join(" ") === "cat /proc/self/mountinfo") {
    for (const [i, mount] of mounts.entries()) {
      const lxcfs = host.containerLxcfs && mount.Source.startsWith("/proc/") ? "fuse.lxcfs lxcfs" : host.containerLxcfs && mount.Source === "/sys/devices/system/cpu/online" ? "fuse.lxcfs lxcfs" : mount.Source.startsWith("/proc/") ? "proc proc" : "sysfs sysfs";
      console.log(`${200 + i} 190 0:${60 + i} ${mount.Source} ${mount.Target} ro,relatime - ${lxcfs} rw`);
    }
    return;
  }
  if (!(image in read("images.json", {}))) fail(`Unable to find image '${image}' locally\ndocker: Error response from daemon: No such image: ${image}`, 125);
  if (command.includes("/usr/sbin/unix_chkpwd")) {
    if (host.apparmorRefusesSetgid) fail("/usr/sbin/unix_chkpwd: error while loading shared libraries: /usr/lib/x86_64-linux-gnu/libc.so.6: cannot apply additional memory protection after relocation: Permission denied", 127);
    return console.log("-1");
  }
  if (command.join(" ") === "cat /sys/fs/cgroup/cpuset.cpus.effective") {
    if (host.cgroupV1) fail("cat: /sys/fs/cgroup/cpuset.cpus.effective: No such file or directory", 1);
    return console.log(host.cpuList ?? `0-${hostCpus().length - 1}`);
  }
  fail(`fake docker: no run for ${command.join(" ")}`, 2);
}

function volumeMount(spec) {
  const colon = spec.indexOf(":");
  if (colon === -1) {
    const id = randomBytes(32).toString("hex");
    const volumes = read("volumes.json", {});
    volumes[id] = { Name: id, Labels: null, Anonymous: true };
    write("volumes.json", volumes);
    return { Type: "volume", Name: id, Source: id, Target: spec, ReadOnly: false, Anonymous: true };
  }
  const name = spec.slice(0, colon);
  const [target, mode] = spec.slice(colon + 1).split(":");
  if (name.startsWith("/")) return { Type: "bind", Name: "", Source: name, Target: target, ReadOnly: mode === "ro", Anonymous: false };
  const volumes = read("volumes.json", {});
  if (!(name in volumes)) {
    volumes[name] = { Name: name, Labels: null, Anonymous: false };
    write("volumes.json", volumes);
  }
  return { Type: "volume", Name: name, Source: name, Target: target, ReadOnly: mode === "ro", Anonymous: false };
}

function create(rest) {
  const labels = {};
  const env = [];
  const devices = [];
  const mounts = [];
  const volumeSpecs = [];
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
    else if (flag === "--mount") mounts.push(mountOf(value()));
    else if (flag === "--volume" || flag === "-v") volumeSpecs.push(value());
    else if (["--init", "--privileged"].includes(flag)) options[flag] = true;
    else options[flag] = value();
  }
  const [image, ...command] = rest.slice(i);
  const name = options["--name"];
  checkCpus(options["--cpuset-cpus"]);
  checkMounts(mounts);
  const images = read("images.json", {});
  if (!(image in images)) fail(`Error response from daemon: No such image: ${image}`);
  const network = options["--network"];
  if (!(network in read("networks.json", {}))) fail(`Error response from daemon: network ${network} not found`);
  for (const device of devices) {
    if (!(host.gpus ?? []).includes(device) && !(device === "nvidia.com/gpu=all" && host.allGpus)) fail(`Error response from daemon: could not select device driver "cdi" with capabilities: []: unresolvable CDI devices ${device}`);
  }
  const id = typeof host.containerId === "string" ? host.containerId : randomBytes(32).toString("hex");
  try {
    mkdirSync(dir(name));
  } catch {
    fail(`Error response from daemon: Conflict. The container name "/${name}" is already in use by container "${find(name)?.Id ?? "?"}". You have to remove (or rename) that container to be able to reuse that name.`);
  }
  mounts.push(...volumeSpecs.map(volumeMount));
  mkdirSync(join(dir(name), "home"));
  mkdirSync(join(dir(name), "etc"));
  const count = names().length + 1;
  save({
    Id: id,
    Name: `/${name}`,
    // The ID of the image it was made from, as docker gives it: a tag moved later names another.
    Image: read("image-ids.json", {})[image] ?? `sha256:${createHash("sha256").update(image).digest("hex")}`,
    State: { Status: "created", ExitCode: 0 },
    Config: { Hostname: options["--hostname"], Image: image, Labels: labels, Env: env, Cmd: command },
    HostConfig: {
      NanoCpus: Math.round(Number(options["--cpus"]) * 1e9),
      CpusetCpus: options["--cpuset-cpus"] ?? "",
      Memory: Number.parseInt(options["--memory"], 10) * MiB,
      MemorySwap: Number.parseInt(options["--memory-swap"], 10) * MiB,
      ShmSize: Number.parseInt(options["--shm-size"], 10) * MiB,
      Privileged: options["--privileged"] === true,
      Init: options["--init"] === true,
      RestartPolicy: { Name: options["--restart"] },
      Devices: devices,
      Mounts: mounts,
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
    case "run":
      return run(rest.filter((arg) => arg !== "--rm"));
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
    case "update": {
      // As Docker's: --cpus, --memory and --memory-swap, and memory never above memory-swap.
      const options = {};
      let i = 0;
      for (; i < rest.length - 1 && rest[i].startsWith("--"); i += 2) options[rest[i]] = rest[i + 1];
      const ref = rest.at(-1);
      const found = find(ref) ?? fail(`Error response from daemon: No such container: ${ref}`);
      if (host.failUpdate) fail(`Error response from daemon: Cannot update container ${found.Id}: ${host.failUpdate}`);
      const config = { ...found.HostConfig };
      if (options["--cpus"] !== undefined) config.NanoCpus = Math.round(Number(options["--cpus"]) * 1e9);
      if (options["--cpuset-cpus"] !== undefined) {
        checkCpus(options["--cpuset-cpus"]);
        config.CpusetCpus = options["--cpuset-cpus"];
      }
      if (options["--memory"] !== undefined) config.Memory = Number.parseInt(options["--memory"], 10) * MiB;
      if (options["--memory-swap"] !== undefined) config.MemorySwap = Number.parseInt(options["--memory-swap"], 10) * MiB;
      if (config.MemorySwap > 0 && config.Memory > config.MemorySwap) {
        fail(`Error response from daemon: Cannot update container ${found.Id}: Memory limit should be smaller than already set memoryswap limit, update the memoryswap at the same time`);
      }
      found.HostConfig = config;
      save(found);
      return console.log(ref);
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
      const ref = rest.filter((arg) => !arg.startsWith("-")).at(-1);
      const found = find(ref) ?? fail(`Error response from daemon: No such container: ${ref}`);
      if (rest.includes("--volumes")) {
        const volumes = read("volumes.json", {});
        let changed = false;
        for (const mount of found.HostConfig.Mounts ?? []) {
          if (mount.Anonymous && volumes[mount.Name]) {
            delete volumes[mount.Name];
            changed = true;
          }
        }
        if (changed) write("volumes.json", volumes);
      }
      rmSync(dir(found.Name.slice(1)), { recursive: true, force: true });
      return console.log(ref);
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
  if (host.dropAttach) process.exit(0);
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
  const lxcfsBroken = host.lxcfsBroken === true || (Array.isArray(host.lxcfsBroken) && host.lxcfsBroken.includes(found.Name.slice(1)));
  if (lxcfsBroken && (found.HostConfig.Mounts ?? []).some((mount) => mount.Target === "/proc/meminfo") && rest.slice(i + 1).includes("/proc/meminfo")) {
    fail("head: cannot open '/proc/meminfo' for reading: Transport endpoint is not connected", 1);
  }
  const name = found.Name.slice(1);
  const home = join(dir(name), "home");
  const own = (text) =>
    text
      .replaceAll("/etc/environment", join(dir(name), "etc", "environment"))
      .replaceAll("/run/bb-box/", `${join(dir(name), "run", "bb-box")}/`)
      .replaceAll("/var/lib/bb-box/", `${join(dir(name), "var-lib", "bb-box")}/`)
      .replaceAll("/usr/share/bb-box/", `${join(dir(name), "usr-share", "bb-box")}/`)
      .replaceAll("/usr/local/libexec/bb-box/", `${join(dir(name), "libexec", "bb-box")}/`)
      .replaceAll("/home/box", home);
  const [command, ...commandArgs] = [...JSON.parse(process.env.FAKE_GROUP ?? "[]"), ...rest.slice(i + 1).map(own)];
  const cards = cardsGiven(found.HostConfig.Devices ?? [], found.HostConfig.Privileged === true);
  const gpuEnv = Object.fromEntries((found.Config.Env ?? []).filter((pair) => /^(CUDA_VISIBLE_DEVICES|NVIDIA_VISIBLE_DEVICES)=/.test(pair)).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]));
  const cardEnv = cards.length ? { PATH: `${join(root, "gpu-bin")}:${process.env.PATH}`, FAKE_CARDS: JSON.stringify(host.smiListsNone ? [] : cards), FAKE_CUDA_IGNORES_VISIBLE: host.cudaIgnoresVisible ? "1" : "", FAKE_CUDA_NO_DEVICE: host.cudaNoDevice ? "1" : "", FAKE_CUDA_ERROR: host.cudaError ? String(host.cudaError) : "", FAKE_REAL_PYTHON: process.env.FAKE_REAL_PYTHON ?? "python3" } : {};
  const child = spawn(command, commandArgs, {
    cwd: workdir ? own(workdir) : home,
    env: { PATH: process.env.PATH, HOME: home, ...gpuEnv, ...env, ...cardEnv },
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
  case "volume": {
    const volumes = () => read("volumes.json", {});
    const [sub, ...more] = rest;
    const inUse = (name) => names().map(load).some((container) => (container.HostConfig.Mounts ?? []).some((mount) => mount.Name === name));
    if (sub === "create") {
      const labels = {};
      let name = null;
      for (let i = 0; i < more.length; i++) {
        if (more[i] === "--label") {
          const [key, ...parts] = more[++i].split("=");
          labels[key] = parts.join("=");
        } else if (!more[i].startsWith("--")) name = more[i];
        else fail(`fake docker: unknown volume create flag ${more[i]}`, 2);
      }
      if (!name) fail("docker: 'docker volume create' requires 1 argument");
      const known = volumes();
      if (host.volumeCreateLabels && !(name in known)) known[name] = { Name: name, Labels: host.volumeCreateLabels, Anonymous: false };
      if (!(name in known)) known[name] = { Name: name, Labels: labels, Anonymous: false };
      write("volumes.json", known);
      console.log(name);
    } else if (sub === "inspect") {
      const formatAt = more.indexOf("--format");
      const format = formatAt >= 0 ? more[formatAt + 1] : null;
      const wanted = more.filter((arg, i) => !arg.startsWith("--") && more[i - 1] !== "--format");
      const known = volumes();
      for (const name of wanted) if (!(name in known)) fail(`Error response from daemon: get ${name}: no such volume`);
      if (format === "{{json .Labels}}") {
        for (const name of wanted) console.log(JSON.stringify(known[name].Labels));
      } else if (format === "{{.Name}}") {
        for (const name of wanted) console.log(known[name].Name);
      } else console.log(JSON.stringify(wanted.map((name) => ({ Name: known[name].Name, Labels: known[name].Labels })), null, 2));
    } else if (sub === "ls") {
      const filters = [];
      let format = null;
      for (let i = 0; i < more.length; i++) {
        if (more[i] === "--filter") filters.push(more[++i]);
        else if (more[i] === "--format") format = more[++i];
      }
      if (format && format !== "{{.Name}}") fail(`fake docker: volume ls format ${format} is not {{.Name}}`, 2);
      for (const [name, volume] of Object.entries(volumes())) {
        const labels = volume.Labels ?? {};
        const matches = filters.every((filter) => {
          if (!filter.startsWith("label=")) return true;
          const body = filter.slice("label=".length);
          const [key, ...parts] = body.split("=");
          return parts.length ? labels[key] === parts.join("=") : key in labels;
        });
        if (!matches) continue;
        console.log(name);
      }
    } else if (sub === "rm") {
      const wanted = more.filter((arg) => !arg.startsWith("-"));
      const known = volumes();
      const errors = [];
      for (const name of wanted) {
        if (host.volumeDisappearOnRemove === name) delete known[name];
        if (!(name in known)) errors.push(`Error response from daemon: get ${name}: no such volume`);
        else if (inUse(name)) errors.push(`Error response from daemon: remove ${name}: volume is in use`);
        else {
          delete known[name];
          console.log(name);
        }
      }
      write("volumes.json", known);
      if (errors.length) fail(errors.join("\n"));
    } else fail(`fake docker: unknown command volume ${sub}`, 2);
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
