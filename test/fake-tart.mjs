#!/usr/bin/env node
// Stand-ins for a Mac's `tart`, `sysctl`, `sw_vers` and `uname`
// in tests, chosen by the first argument. With the fake ssh they run the Tart
// backend's host scripts on the test machine, in the host's fake home. VMs are
// directories under $HOME/.tart/vms, as Tart keeps them:
//
// - `tart run` writes `running` with its PID, prints the VNC URL and waits
//   until `running` goes; `tart stop` removes it, and `tart suspend` also
//   writes state.vzvmsave. A run refuses when $FAKE_TART_LIMIT (2) VMs of the
//   host run already, as the Virtualization framework does.
// - `tart ip` gives each VM an address of its own, 192.168.64.<n>.
// - A saved state that holds "corrupt" fails to restore, as Tart reports it.
// - `sw_vers -buildVersion` says 27A1, or what the Mac's ~/.fake-macos-build holds.
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const home = process.env.HOME;
const vms = join(home, ".tart", "vms");
mkdirSync(vms, { recursive: true });
if (process.env.FAKE_SSH_DIR) appendFileSync(join(process.env.FAKE_SSH_DIR, "tart-log"), `${JSON.stringify([tool, ...args])}\n`);

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
const running = (name) => existsSync(join(dir(name), "running")) && alive(Number(readFileSync(join(dir(name), "running"), "utf8")));
const stateOf = (name) => (running(name) ? "running" : existsSync(join(dir(name), "state.vzvmsave")) ? "suspended" : "stopped");
const names = () => readdirSync(vms).filter((name) => existsSync(join(dir(name), "config.json")));
const config = (name) => JSON.parse(readFileSync(join(dir(name), "config.json"), "utf8"));
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

function tart() {
  const [command, ...rest] = args;
  switch (command) {
    case "--version":
      return console.log("2.30.0");
    case "list": {
      const list = names().map((name) => ({ Source: "local", Name: name, Disk: 50, Size: 20, Accessed: "1 minute ago", Running: running(name), State: stateOf(name) }));
      if (rest.includes("--quiet")) return list.forEach((vm) => console.log(vm.Name));
      if (option("--format") === "json") return console.log(JSON.stringify(list, null, 2).replaceAll('": ', '" : '));
      console.log("Source Name Disk Size Accessed State");
      return list.forEach((vm) => console.log(`local ${vm.Name} 50 20 1 minute ago ${vm.State}`));
    }
    case "clone": {
      const [from, to] = rest;
      if (!existsSync(dir(from))) fail(`the specified VM "${from}" does not exist`);
      if (existsSync(dir(to))) fail(`VM "${to}" already exists`);
      mkdirSync(dir(to));
      cpSync(join(dir(from), "config.json"), join(dir(to), "config.json"));
      return;
    }
    case "set": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      const value = config(name);
      if (option("--cpu")) value.cpuCount = Number(option("--cpu"));
      if (option("--memory")) value.memorySize = Number(option("--memory")) * 1024 * 1024;
      return writeFileSync(join(dir(name), "config.json"), JSON.stringify(value));
    }
    case "run": {
      const name = rest[rest.length - 1];
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (running(name)) fail(`VM "${name}" is already running`);
      const limit = Number(process.env.FAKE_TART_LIMIT ?? 2);
      const others = names().filter(running);
      if (others.length >= limit) fail(`The number of VMs exceeds the system limit (other running VMs: ${others.join(", ")})`);
      const saved = join(dir(name), "state.vzvmsave");
      if (existsSync(saved) && readFileSync(saved, "utf8") === "corrupt") {
        console.log("restoring VM state from a snapshot...");
        fail('Error Domain=VZErrorDomain Code=12 "The virtual machine failed to restore with error \u201cinvalid argument\u201d."');
      }
      writeFileSync(join(dir(name), "running"), String(process.pid));
      rmSync(join(dir(name), "state.vzvmsave"), { force: true });
      const port = 5900 + (names().indexOf(name) % 100);
      console.log(`VNC server is running at vnc://:fake-pass-word-${port}@127.0.0.1:${port}`);
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
    case "ip": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      const file = join(dir(name), "lease");
      if (!existsSync(file)) {
        const counter = join(vms, ".lease");
        const next = existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 2;
        writeFileSync(counter, String(next));
        writeFileSync(file, `192.168.64.${next}`);
      }
      return console.log(readFileSync(file, "utf8"));
    }
    case "stop":
    case "suspend": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (!running(name)) fail(`VM "${name}" is not running`);
      if (command === "suspend") writeFileSync(join(dir(name), "state.vzvmsave"), "");
      rmSync(join(dir(name), "running"), { force: true });
      return;
    }
    case "delete": {
      const [name] = rest;
      if (!existsSync(dir(name))) fail(`the specified VM "${name}" does not exist`);
      if (running(name)) fail(`VM "${name}" is running`);
      return rmSync(dir(name), { recursive: true, force: true });
    }
    default:
      fail(`fake tart does not know ${command}`);
  }
}

switch (tool) {
  case "tart":
    tart();
    break;
  case "sysctl":
    console.log(args.includes("hw.ncpu") ? "16" : String(128 * 1024 * 1024 * 1024));
    break;
  case "sw_vers":
    console.log(args.includes("-buildVersion") ? (existsSync(join(home, ".fake-macos-build")) ? readFileSync(join(home, ".fake-macos-build"), "utf8").trim() : "27A1") : "27.0");
    break;
  case "uname":
    console.log(args.includes("-m") ? "arm64" : "Darwin");
    break;
  default:
    fail(`fake-tart does not stand in for ${tool}`);
}
