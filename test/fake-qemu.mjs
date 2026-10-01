#!/usr/bin/env node
// Stand-ins for a Mac's `qemu-system-aarch64`, `qemu-img` and `nc` in tests,
// chosen by the first argument. With the fake ssh they run the Tart backend's
// QEMU scripts (qemu.ts) on the test machine, in the Mac's fake home.
//
// - `qemu-system-aarch64 --version` says 11.1.0. A run writes its pid file
//   and serves QMP on its -qmp socket, answering as QEMU does, with an event
//   before some answers: stop, cont, migrate-set-parameters, migrate (to a
//   file), query-migrate, query-status, migrate-incoming and quit. With
//   -incoming defer it waits for migrate-incoming, then loads the file for a
//   moment, and is paused; a file that holds "corrupt" does not load, and
//   QEMU exits, as it does. It ends on quit, on SIGTERM, when its pid file
//   goes, or after two minutes, so no test leaves one running.
// - `qemu-img create -f qcow2 -F qcow2 -b <base> <file>` writes an overlay that
//   names its base.
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
  if (args.includes("--version")) return console.log("QEMU emulator version 11.1.0\nCopyright (c) 2003-2026 Fabrice Bellard and the QEMU Project developers");
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
  const base = option("-b");
  const file = rest[rest.length - 1];
  if (command !== "create" || !base || !file) fail(`fake qemu-img does not know ${args.join(" ")}`);
  if (!existsSync(base)) fail(`qemu-img: ${file}: Could not open backing file: Could not open '${base}': No such file or directory`);
  writeFileSync(file, `overlay on ${base}\n`);
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
