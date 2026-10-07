#!/usr/bin/env node
// Stand-ins for a Mac's `qemu-system-aarch64`, `qemu-img` and `nc` in tests,
// chosen by the first argument. With the fake ssh they run the Tart backend's
// QEMU scripts (qemu.ts) on the test machine, in the Mac's fake home.
//
// - `qemu-system-aarch64 --version` says 11.1.0, or the version in
//   ~/.fake-qemu-version, and `-machine help` that virt stands for virt-11.1,
//   or the machine in ~/.fake-qemu-virt. A run writes its pid file and
//   serves QMP on its -qmp socket, answering as QEMU does, with an event
//   before some answers: stop, cont, migrate-set-parameters, migrate (to a
//   file), query-migrate, query-status, migrate-incoming and quit. A save is
//   cancelled while ~/.fake-qemu-cancel is there. With -incoming defer it
//   waits for migrate-incoming, then loads the file for a moment, and is
//   paused; a file that holds "corrupt" does not load, and QEMU exits, as it
//   does. It ends on quit, on SIGTERM, when its pid file goes, or after two
//   minutes, so no test leaves one running.
// - `qemu-img create -f qcow2 -F qcow2 -b <base> <file> [<n>G]` writes an
//   overlay that names its base, and its size when given. `qemu-img info -U
//   <file>` says a disk is that size, or 64 GiB.
// - `nc -U <socket>` joins its input and output to a Unix socket; `nc -z
//   <host> <port>` says whether something listens there.
//
// Each run's arguments go to ~/.fake-qemu-log, and each QMP command to
// ~/.fake-qmp-log, for tests to read.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

const [tool, ...args] = process.argv.slice(2);
const home = process.env.HOME;
const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const fail = (text, code = 1) => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};

function qemu() {
  if (args.includes("--version")) {
    const version = existsSync(join(home, ".fake-qemu-version")) ? readFileSync(join(home, ".fake-qemu-version"), "utf8").trim() : "11.1.0";
    return console.log(`QEMU emulator version ${version}\nCopyright (c) 2003-2026 Fabrice Bellard and the QEMU Project developers`);
  }
  if (option("-machine") === "help") {
    const virt = existsSync(join(home, ".fake-qemu-virt")) ? readFileSync(join(home, ".fake-qemu-virt"), "utf8").trim() : "virt-11.1";
    return console.log(
      ["Supported machines are:", "virt-11.0            QEMU 11.0 ARM Virtual Machine", `virt                 QEMU ARM Virtual Machine (alias of ${virt})`, `${virt}            QEMU ARM Virtual Machine`].join("\n"),
    );
  }
  appendFileSync(join(home, ".fake-qemu-log"), `${JSON.stringify(args)}\n`);
  const pidfile = option("-pidfile");
  const qmp = /^unix:([^,]+)/.exec(option("-qmp") ?? "")?.[1];
  if (!pidfile || !qmp) fail("qemu-system-aarch64: the fake needs -pidfile and -qmp unix:<path>");
  writeFileSync(pidfile, `${process.pid}\n`);
  let status = option("-incoming") === "defer" ? "inmigrate" : "running";
  let migrated = null;
  const end = (code = 0) => {
    rmSync(pidfile, { force: true });
    rmSync(qmp, { force: true });
    process.exit(code);
  };
  const event = (name) => JSON.stringify({ timestamp: { seconds: Math.floor(Date.now() / 1000), microseconds: 0 }, event: name });
  const answer = (value) => JSON.stringify({ return: value });
  const reply = (line) => {
    appendFileSync(join(home, ".fake-qmp-log"), `${line}\n`);
    const { execute, arguments: given = {} } = JSON.parse(line);
    switch (execute) {
      case "qmp_capabilities":
      case "migrate-set-parameters":
        return [answer({})];
      case "stop":
        status = "paused";
        return [event("STOP"), answer({})];
      case "cont":
        status = "running";
        return [event("RESUME"), answer({})];
      case "query-status":
        return [answer({ status, singlestep: false, running: status === "running" })];
      case "migrate": {
        const file = /^file:(.+)$/.exec(given.uri ?? "")?.[1];
        if (!file) return [JSON.stringify({ error: { class: "GenericError", desc: `fake QEMU cannot migrate to ${given.uri}` } })];
        if (existsSync(join(home, ".fake-qemu-cancel"))) {
          writeFileSync(file, "part of a save\n");
          migrated = "cancelled";
          return [event("MIGRATION"), answer({})];
        }
        writeFileSync(file, `saved ${status}\n`);
        migrated = "completed";
        status = "postmigrate";
        return [event("MIGRATION"), answer({})];
      }
      case "query-migrate":
        return [answer(migrated ? { status: migrated } : {})];
      case "migrate-incoming": {
        const file = /^file:(.+)$/.exec(given.uri ?? "")?.[1];
        if (status !== "inmigrate" || !file) return [JSON.stringify({ error: { class: "GenericError", desc: "fake QEMU is not waiting for a migration" } })];
        // It loads for a moment, then is paused, as it was saved, or exits when the file does not load.
        setTimeout(() => {
          if (!existsSync(file) || readFileSync(file, "utf8").includes("corrupt")) {
            process.stderr.write("qemu-system-aarch64: load of migration failed: Invalid argument\n");
            end(1);
          }
          status = "paused";
        }, 150);
        return [answer({})];
      }
      case "quit":
        setTimeout(() => end(0), 20);
        return [answer({}), event("SHUTDOWN")];
      // The guest shuts down, as Windows does at an ACPI power button, unless the Mac's ~/.fake-qemu-no-powerdown says it ignores it.
      case "system_powerdown":
        if (!existsSync(join(home, ".fake-qemu-no-powerdown"))) setTimeout(() => end(0), 100);
        return [answer({}), event("POWERDOWN")];
      default:
        return [JSON.stringify({ error: { class: "CommandNotFound", desc: `The command ${execute} has not been found` } })];
    }
  };
  rmSync(qmp, { force: true });
  const server = createServer((socket) => {
    socket.write(`${JSON.stringify({ QMP: { version: { qemu: { micro: 0, minor: 1, major: 11 }, package: "" }, capabilities: ["oob"] } })}\r\n`);
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (line) for (const out of reply(line)) socket.write(`${out}\r\n`);
      }
    });
    socket.on("error", () => {});
  });
  server.listen(qmp);
  process.on("SIGTERM", () => end(0));
  setInterval(() => {
    if (!existsSync(pidfile)) end(0);
  }, 50);
  setTimeout(() => end(0), 120_000);
}

function qemuImg() {
  const [command, ...rest] = args;
  // The arguments that are neither an option nor its value.
  const [file, size] = rest.filter((arg, i) => !arg.startsWith("-") && !["-f", "-F", "-b"].includes(rest[i - 1]));
  // convert -O qcow2 <overlay> <file>: a disk of its own, from the overlay and its base.
  if (command === "convert") {
    const [source, target] = rest.filter((arg, i) => !arg.startsWith("-") && rest[i - 1] !== "-O");
    if (!source || !target || !existsSync(source)) fail(`qemu-img: Could not open '${source}'`);
    return writeFileSync(target, `flattened from ${readFileSync(source, "utf8")}`);
  }
  if (command === "info" && file) {
    if (!existsSync(file)) fail(`qemu-img: Could not open '${file}': No such file or directory`);
    const gib = Number(/^size (\d+)G$/m.exec(readFileSync(file, "utf8"))?.[1] ?? 64);
    return console.log(`image: ${file}\nfile format: qcow2\nvirtual size: ${gib} GiB (${gib * 2 ** 30} bytes)\ndisk size: 196 KiB`);
  }
  const base = option("-b");
  if (command !== "create" || !base || !file || (size && !/^\d+G$/.test(size))) fail(`fake qemu-img does not know ${args.join(" ")}`);
  if (!existsSync(base)) fail(`qemu-img: ${file}: Could not open backing file: Could not open '${base}': No such file or directory`);
  writeFileSync(file, `overlay on ${base}\n${size ? `size ${size}\n` : ""}`);
}

function nc() {
  const socket = option("-U");
  if (socket) {
    const connection = createConnection(socket);
    connection.on("error", () => process.exit(1));
    connection.on("connect", () => {
      process.stdin.pipe(connection);
      connection.pipe(process.stdout);
    });
    connection.on("end", () => process.exit(0));
    process.stdin.on("end", () => connection.end());
    return;
  }
  if (args.includes("-z")) {
    const [host, port] = args.slice(-2);
    const connection = createConnection({ host, port: Number(port) });
    connection.setTimeout(1_000, () => process.exit(1));
    connection.on("connect", () => {
      connection.destroy();
      process.exit(0);
    });
    connection.on("error", () => process.exit(1));
    return;
  }
  fail(`fake nc does not know ${args.join(" ")}`);
}

switch (tool) {
  case "qemu-system-aarch64":
    qemu();
    break;
  case "qemu-img":
    qemuImg();
    break;
  case "nc":
    nc();
    break;
  default:
    fail(`fake-qemu does not stand in for ${tool}`);
}
