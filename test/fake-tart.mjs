#!/usr/bin/env node
// Stand-ins for a Mac's `tart`, `arp`, `sysctl`, `sw_vers`, `uname`, `mdutil` and `mdfind`
// in tests, chosen by the first argument. With the fake ssh they run the Tart
// backend's host scripts on the test machine, in the host's fake home. VMs are
// directories under $HOME/.tart/vms, as Tart keeps them:
//
// - A VM has config.json, nvram.bin and a raw disk.img, a sparse file of the
//   disk's size, 64 GB unless `tart set --disk-size` grew it.
// - `tart run` writes `running` with its PID, takes Tart's run lock, an fcntl
//   write lock on config.json, through fake-run-lock.pl, prints the VNC URL
//   when given --vnc-experimental, and waits until `running` goes; `tart
//   stop` removes it, and `tart suspend` also writes state.vzvmsave. A run of a macOS VM
//   refuses when $FAKE_TART_LIMIT (2) macOS VMs run already, counting those
//   another app runs (the number in ~/.fake-other-macos-vms), as the
//   Virtualization framework does; Linux VMs do not count. A Linux VM refuses
//   --suspendable and a saved state, as Tart 2.30.0 does (040).
// - `tart ip` gives each VM an address of its own, 192.168.64.<n>, and fails while
//   ~/.fake-tart-ip-fails exists, as for a VM with no lease.
// - A saved state that holds "corrupt" fails to restore, as Tart reports it.
// - `sw_vers -buildVersion` says 27A1, or what the Mac's ~/.fake-macos-build holds.
// - `sysctl` says the Mac has 16 cores, 12 of them performance cores unless
//   ~/.fake-performance-cores says otherwise, 128 GiB and the Hypervisor
//   framework, unless the Mac's ~/.fake-no-hvf exists, and started in
//   November 2023.
// - `tart list` fails as Tart 2.30.0's does when a VM is deleted while it
//   reads, while ~/.fake-tart-list-fails exists; `tart get` of a VM whose
//   config.json is gone fails so too, and of the VM ~/.fake-tart-get-fails
//   names fails with what it holds after the name.
// - `tart run` of a macOS VM fails as Virtualization's internal error does
//   while ~/.fake-tart-run-fails holds a count above 0, taking one from it.
// - `tart delete` waits while ~/.fake-tart-delete-waits exists, once as
//   many deletes as it holds have gone through, taking one from it for each.
// - `tart ip` writes the VM's name to ~/.fake-tart-ip-held and waits while
//   ~/.fake-tart-ip-holds exists, as for a VM that has no lease yet.
// - Spotlight indexes every volume, but not one ~/.fake-spotlight-off names,
//   and `mdfind -onlyin` finds files by name there, none while
//   ~/.fake-spotlight-excluded exists.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const home = process.env.HOME;
const vms = join(home, ".tart", "vms");
mkdirSync(vms, { recursive: true });
// What it was asked, for tests to read: in the Mac's home, since the fake ssh passes only PATH, HOME and USER.
appendFileSync(join(home, ".fake-tart-log"), `${JSON.stringify([tool, ...args])}\n`);

const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const dir = (name) => join(vms, name);
const MISSING_CONFIG = "Error: The file “config.json” couldn’t be opened because there is no such file.";
const running = (name) => existsSync(join(dir(name), "running")) && alive(Number(readFileSync(join(dir(name), "running"), "utf8")));
const stateOf = (name) => (running(name) ? "running" : existsSync(join(dir(name), "state.vzvmsave")) ? "suspended" : "stopped");
const names = () => readdirSync(vms).filter((name) => existsSync(join(dir(name), "config.json")));
const config = (name) => JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8"));
const diskOf = (name) => Math.floor(statSync(join(dir(name), "disk.img")).size / 1e9);
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function tart() {
  const [command, ...rest] = args;
  switch (command) {
    case "--version":
      return console.log("2.30.0");
    case "list": {
      if (existsSync(join(home, ".fake-tart-list-fails"))) fail(MISSING_CONFIG);
      const list = names().map((name) => ({ Source: "local", Name: name, Disk: diskOf(name), Size: 20, Accessed: "1 minute ago", Running: running(name), State: stateOf(name) }));
      if (rest.includes("--quiet")) return list.forEach((vm) => console.log(vm.Name));
      if (option("--format") === "json") return console.log(JSON.stringify(list, null, 2).replaceAll('": ', '" : '));
      console.log("Source Name Disk Size Accessed State");
      return list.forEach((vm) => console.log(`local ${vm.Name} ${vm.Disk} 20 1 minute ago ${vm.State}`));
    }
    case "clone": {
      const [from, to] = rest;
      if (!existsSync(dir(from))) fail(`the specified VM "${from}" does not exist`);
      if (existsSync(dir(to))) fail(`VM "${to}" already exists`);
      mkdirSync(dir(to));
      // A clone of a local VM gets a MAC address of its own, as Tart gives one when another VM has the same.
      const cloned = config(from);
      cloned.macAddress = Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x02 : Math.floor(Math.random() * 256)).toString(16).padStart(2, "0")).join(":");
      writeFileSync(join(dir(to), "config.json"), JSON.stringify(cloned));
      copyFileSync(join(dir(from), "nvram.bin"), join(dir(to), "nvram.bin"));
      writeFileSync(join(dir(to), "disk.img"), "");
      truncateSync(join(dir(to), "disk.img"), statSync(join(dir(from), "disk.img")).size);
      return;
    }
    case "set": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      const value = config(name);
      if (option("--cpu")) value.cpuCount = Number(option("--cpu"));
      if (option("--memory")) value.memorySize = Number(option("--memory")) * 1024 * 1024;
      if (rest.includes("--random-mac")) value.macAddress = Array.from({ length: 6 }, (_, i) => (i === 0 ? 0x02 : Math.floor(Math.random() * 256)).toString(16).padStart(2, "0")).join(":");
      if (rest.includes("--random-serial")) {
        if (value.os === "linux") fail("Error: --random-serial is only supported for macOS VMs");
        value.ecid = Math.random().toString(36).slice(2);
      }
      // As Tart's: the disk, in decimal GB, only grows.
      if (option("--disk-size")) {
        if (Number(option("--disk-size")) < diskOf(name)) fail("the disk size can only be increased");
        truncateSync(join(dir(name), "disk.img"), Number(option("--disk-size")) * 1e9);
      }
      return writeFileSync(join(dir(name), "config.json"), JSON.stringify(value));
    }
    case "get": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (!existsSync(join(dir(name), "config.json"))) fail(MISSING_CONFIG);
      const [failing, ...why] = existsSync(join(home, ".fake-tart-get-fails")) ? readFileSync(join(home, ".fake-tart-get-fails"), "utf8").trim().split(" ") : [];
      if (failing === name) fail(why.join(" "));
      const value = config(name);
      const running = existsSync(join(dir(name), "running"));
      return console.log(JSON.stringify({ CPU: value.cpuCount, Memory: Math.round(value.memorySize / 1024 / 1024), Disk: diskOf(name), DiskFormat: "raw", OS: value.os, Running: running, State: running ? "running" : "stopped" }));
    }
    case "run": {
      const name = rest[rest.length - 1];
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (running(name)) fail(`VM "${name}" is already running`);
      const linux = config(name).os === "linux";
      const saved = join(dir(name), "state.vzvmsave");
      if (linux && (rest.includes("--suspendable") || existsSync(saved))) fail("Error: You can only suspend macOS VMs");
      const limit = Number(process.env.FAKE_TART_LIMIT ?? 2);
      const others = names().filter((other) => running(other) && config(other).os !== "linux");
      const elsewhere = existsSync(join(home, ".fake-other-macos-vms")) ? Number(readFileSync(join(home, ".fake-other-macos-vms"), "utf8")) : 0;
      if (!linux && others.length + elsewhere >= limit) fail(`The number of VMs exceeds the system limit (other running VMs: ${others.join(", ") || "another app's"})`);
      const failsLeft = join(home, ".fake-tart-run-fails");
      if (!linux && existsSync(failsLeft) && Number(readFileSync(failsLeft, "utf8")) > 0) {
        writeFileSync(failsLeft, String(Number(readFileSync(failsLeft, "utf8")) - 1));
        fail('Error Domain=VZErrorDomain Code=1 "The virtual machine failed to start." UserInfo={NSLocalizedFailure=Internal Virtualization error., NSLocalizedFailureReason=The virtual machine failed to start.}');
      }
      if (existsSync(saved) && readFileSync(saved, "utf8") === "corrupt") {
        console.log("restoring VM state from a snapshot...");
        fail('Error Domain=VZErrorDomain Code=12 "The virtual machine failed to restore with error \u201cinvalid argument\u201d."');
      }
      writeFileSync(join(dir(name), "running"), String(process.pid));
      rmSync(join(dir(name), "state.vzvmsave"), { force: true });
      const booted = new Date();
      if (existsSync(join(dir(name), "nvram.bin"))) utimesSync(join(dir(name), "nvram.bin"), booted, booted);
      const lock = spawn("perl", [new URL("./fake-run-lock.pl", import.meta.url).pathname, join(dir(name), "config.json"), join(dir(name), "running"), String(process.pid)], { stdio: ["ignore", "pipe", "inherit"] });
      lock.on("exit", (code) => code && fail(`fake-run-lock.pl exited ${code}`));
      lock.stdout.once("data", () => {
        // A test that serves a fake VNC server names its port in ~/.fake-vnc-port.
        const port = existsSync(join(home, ".fake-vnc-port")) ? Number(readFileSync(join(home, ".fake-vnc-port"), "utf8")) : 5900 + (names().indexOf(name) % 100);
        if (rest.includes("--vnc-experimental")) console.log(`VNC server is running at vnc://:fake-pass-word-${port}@127.0.0.1:${port}`);
      });
      const stop = () => {
        rmSync(join(dir(name), "running"), { force: true });
        process.exit(0);
      };
      process.on("SIGTERM", stop);
      setInterval(() => {
        if (!existsSync(join(dir(name), "running"))) process.exit(0);
      }, 20);
      return;
    }
    case "exec": {
      // Answers while the VM runs, as its guest agent does.
      const name = rest.find((arg) => !arg.startsWith("-"));
      if (!running(name)) fail(`the VM "${name}" is not running`);
      process.exit(0);
    }
    case "ip": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (existsSync(join(home, ".fake-tart-ip-fails"))) fail(`no IP address found for "${name}"`);
      const file = join(dir(name), "lease");
      if (!existsSync(file)) {
        const counter = join(vms, ".lease");
        const next = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 2;
        writeFileSync(counter, String(next));
        writeFileSync(file, `192.168.64.${next}`);
      }
      const holds = join(home, ".fake-tart-ip-holds");
      if (!existsSync(holds)) return console.log(readFileSync(file, "utf8"));
      writeFileSync(join(home, ".fake-tart-ip-held"), name);
      const check = setInterval(() => {
        if (existsSync(holds)) return;
        clearInterval(check);
        console.log(readFileSync(file, "utf8"));
      }, 20);
      return;
    }
    case "stop":
    case "suspend": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (!running(name)) fail(`VM "${name}" is not running`);
      if (command === "suspend" && existsSync(join(home, ".fake-tart-suspend-fails"))) fail("Error: the virtual machine could not be paused");
      if (command === "suspend") writeFileSync(join(dir(name), "state.vzvmsave"), "");
      rmSync(join(dir(name), "running"), { force: true });
      return;
    }
    case "rename": {
      const [from, to] = rest;
      if (!existsSync(join(vms, from))) fail(`the specified VM "${from}" does not exist`);
      if (existsSync(join(vms, to))) fail(`VM "${to}" already exists`);
      renameSync(join(vms, from), join(vms, to));
      return;
    }
    case "delete": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (running(name)) fail(`VM "${name}" is running`);
      const waits = join(home, ".fake-tart-delete-waits");
      const passing = existsSync(waits) ? Number(readFileSync(waits, "utf8") || 0) : 0;
      if (passing > 0) writeFileSync(waits, String(passing - 1));
      else if (existsSync(waits)) {
        const check = setInterval(() => {
          if (existsSync(waits)) return;
          clearInterval(check);
          rmSync(dir(name), { recursive: true, force: true });
        }, 20);
        return;
      }
      return rmSync(dir(name), { recursive: true, force: true });
    }
    default:
      fail(`fake tart does not know ${command}`);
  }
}

/** `arp -n <address>`: the MAC of the VM that holds the address, the newest lease when several do, without leading zeros as arp prints it. */
function arp() {
  const address = args[args.length - 1];
  const holders = names()
    .filter((name) => existsSync(join(dir(name), "lease")) && readFileSync(join(dir(name), "lease"), "utf8").trim() === address)
    .sort((a, b) => statSync(join(dir(b), "lease")).mtimeMs - statSync(join(dir(a), "lease")).mtimeMs);
  const mac = holders.length ? config(holders[0]).macAddress : null;
  if (!mac) return console.log(`${address} (${address}) -- no entry`);
  console.log(`? (${address}) at ${mac.split(":").map((byte) => byte.replace(/^0/, "")).join(":")} on bridge100 ifscope [ethernet]`);
}

function clonefile() {
  const [src, dst] = args.slice(-2);
  if (existsSync(join(home, ".fake-clone-fails"))) fail("clonefile: Operation not supported");
  const copied = spawnSync("cp", ["--sparse=always", src, dst], { stdio: "inherit" });
  process.exit(copied.status ?? 1);
}

const DISKS = join(home, ".fake-diskutil.json");
const disks = () => (existsSync(DISKS) ? JSON.parse(readFileSync(DISKS, "utf8")) : {});
const MAC_CONTAINER = "disk3";

function diskutil() {
  const [verb, ...rest] = args;
  const attached = disks();
  const byDevice = (name) => Object.values(attached).find((disk) => name === disk.device || name === disk.store || name === disk.container || name === disk.data);
  if (verb === "info") {
    const name = rest.at(-1);
    if (name === "/") return console.log(`   APFS Container:           ${MAC_CONTAINER}`);
    const disk = byDevice(name);
    if (!disk) fail(`Could not find disk: ${name}`);
    return console.log(`   APFS Container:           ${disk.container}`);
  }
  if (verb === "image" && existsSync(join(home, ".fake-diskutil-no-image"))) fail(`diskutil: did not recognize verb "image"; type "diskutil" for a list`);
  if (verb === "image" && rest[0] === "attach" && rest.includes("--help")) return console.log("OVERVIEW: Attach a disk image as a device.");
  if (verb === "image" && rest[0] === "attach") {
    if (existsSync(join(home, ".fake-diskutil-attach-fails"))) fail("Could not attach the image");
    const image = rest.at(-1);
    const number = 10 + Object.keys(attached).length * 4;
    const container = existsSync(join(home, ".fake-diskutil-container")) ? readFileSync(join(home, ".fake-diskutil-container"), "utf8").trim() : `disk${number + 3}`;
    const disk = { image, device: `disk${number}`, store: `disk${number}s2`, container, data: `${container}s5`, mounted: null };
    const volume = `${image}.data`;
    if (!existsSync(volume)) {
      if (existsSync(join(home, ".fake-data-volume"))) cpSync(join(home, ".fake-data-volume"), volume, { recursive: true });
      else mkdirSync(join(volume, "Users"), { recursive: true });
    }
    attached[disk.device] = disk;
    writeFileSync(DISKS, JSON.stringify(attached));
    return console.log(`/dev/${disk.device}\tGUID_partition_scheme\n/dev/${disk.store}\tApple_APFS\n/dev/${disk.container}\tApple_APFS_Container`);
  }
  if (verb === "list") {
    const disk = byDevice(rest.at(-1));
    if (!disk) fail("Could not find disk");
    return console.log(`/dev/${disk.device} (disk image):\n   #:                       TYPE NAME                    SIZE       IDENTIFIER\n   0:      GUID_partition_scheme                        +140.0 GB   ${disk.device}\n   2:                 Apple_APFS Container ${disk.container}        134.1 GB   ${disk.store}`);
  }
  if (verb === "apfs" && rest[0] === "list") {
    const disk = byDevice(rest.at(-1));
    if (!disk) fail("Could not find container");
    return console.log(`    |   APFS Volume Disk (Role):   ${disk.container}s1 (System)\n    |   APFS Volume Disk (Role):   ${disk.data} (Data)`);
  }
  if (verb === "mount") {
    const point = rest[rest.indexOf("-mountPoint") + 1];
    const disk = byDevice(rest.at(-1));
    if (!disk || disk.data !== rest.at(-1)) fail("Could not mount");
    if (!existsSync(`${disk.image}.data`)) mkdirSync(`${disk.image}.data`);
    rmSync(point, { recursive: true, force: true });
    symlinkSync(`${disk.image}.data`, point);
    disk.mounted = point;
    writeFileSync(DISKS, JSON.stringify(attached));
    return console.log(`Volume Data on ${disk.data} mounted`);
  }
  if (verb === "unmount") {
    const point = rest.at(-1);
    const disk = Object.values(attached).find((each) => each.mounted === point);
    if (!disk) fail("Could not unmount");
    rmSync(point, { force: true });
    mkdirSync(point);
    disk.mounted = null;
    writeFileSync(DISKS, JSON.stringify(attached));
    return;
  }
  if (verb === "eject") {
    const disk = byDevice(rest.at(-1));
    if (!disk) fail("Could not eject");
    if (disk.mounted) fail("Volume busy");
    delete attached[disk.device];
    writeFileSync(DISKS, JSON.stringify(attached));
    return;
  }
  fail(`fake diskutil does not know ${verb}`);
}

switch (tool) {
  case "tart":
    tart();
    break;
  case "python3":
    clonefile();
    break;
  case "diskutil":
    diskutil();
    break;
  case "arp":
    arp();
    break;
  case "sysctl":
    if (args.includes("kern.boottime")) console.log("{ sec = 1700000000, usec = 0 } Tue Nov 14 22:13:20 2023");
    else if (args.includes("machdep.cpu.brand_string")) console.log(existsSync(join(home, ".fake-chip")) ? readFileSync(join(home, ".fake-chip"), "utf8").trim() : "Apple M4 Max");
    else if (args.includes("hw.perflevel0.physicalcpu")) console.log(existsSync(join(home, ".fake-performance-cores")) ? readFileSync(join(home, ".fake-performance-cores"), "utf8").trim() : "12");
    else console.log(args.includes("hw.ncpu") ? "16" : args.includes("kern.hv_support") ? (existsSync(join(home, ".fake-no-hvf")) ? "0" : "1") : String(128 * 1024 * 1024 * 1024));
    break;
  case "sw_vers":
    console.log(args.includes("-buildVersion") ? (existsSync(join(home, ".fake-macos-build")) ? readFileSync(join(home, ".fake-macos-build"), "utf8").trim() : "27A1") : "27.0");
    break;
  case "mdutil": {
    const volume = args.at(-1);
    const off = existsSync(join(home, ".fake-spotlight-off")) && readFileSync(join(home, ".fake-spotlight-off"), "utf8").trim() === volume;
    console.log(`${volume}:\n\tIndexing ${off ? "disabled." : "enabled. "}`);
    break;
  }
  case "mdfind": {
    if (existsSync(join(home, ".fake-spotlight-excluded"))) break;
    const under = args[args.indexOf("-onlyin") + 1];
    const name = args[args.indexOf("-name") + 1];
    for (const entry of readdirSync(under, { recursive: true })) if (String(entry).split("/").at(-1) === name) console.log(join(under, String(entry)));
    break;
  }
  case "uname":
    console.log(args.includes("-m") ? "arm64" : "Darwin");
    break;
  default:
    fail(`fake-tart does not stand in for ${tool}`);
}
