// bb-box's msb client (053): stands in for the msb CLI on BB's server, for
// a BB machine's msb, which bb-box's host entry runs there. It runs as
//
//   node msb-client.mjs <socket> '{"args":[...],"tty":true}'
//
// and connects to the machine's msb relay socket (src/relay/hub.ts). It
// sends the request, then its stdin, and writes the run's stdout and stderr
// as its own, and exits as the run did. With "tty", it sends its terminal's
// size, puts its terminal in raw mode, and sends each new size: msb then
// runs on a PTY on the machine. The frames are those of src/relay/msb.ts.
// Plain JavaScript, so node runs it as it is.

import { spawnSync } from "node:child_process";
import { connect } from "node:net";

const REQUEST = 1;
const STDIN = 2;
const STDIN_END = 3;
const RESIZE = 4;
const STDOUT = 16;
const STDERR = 17;
const EXIT = 18;
const FAILED = 19;
const DATA_BYTES = 64 * 1024;
/** What the client exits with when msb did not run, as ssh does. */
const NOT_RUN = 255;

const [socketPath, json] = process.argv.slice(2);

function frame(type, payload = Buffer.alloc(0)) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const out = Buffer.alloc(5 + body.length);
  out[0] = type;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

function fail(reason) {
  restore();
  process.stderr.write(`bb-box could not run msb on the BB machine: ${reason}\n`, () => process.exit(NOT_RUN));
}

/**
 * The terminal's settings before the client made it raw, as `stty -g` gives
 * them. Raw as ssh makes it: Node's raw mode leaves output processing on,
 * so each newline would gain a second carriage return from this PTY.
 */
let saved = null;
function makeRaw() {
  const got = spawnSync("stty", ["-g"], { stdio: ["inherit", "pipe", "ignore"] });
  if (got.status !== 0) return;
  saved = got.stdout.toString().trim();
  spawnSync("stty", ["raw", "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
}
function restore() {
  if (saved) spawnSync("stty", [saved], { stdio: ["inherit", "ignore", "ignore"] });
  saved = null;
}

let request;
try {
  request = JSON.parse(json ?? "");
  if (!socketPath || !Array.isArray(request.args)) throw new Error("no args");
} catch {
  process.stderr.write("usage: node msb-client.mjs <socket> '{\"args\":[...]}'\n");
  process.exit(2);
}

const tty = request.tty === true;
const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 });
const socket = connect({ path: socketPath, allowHalfOpen: true });
let done = false;

socket.once("connect", () => {
  socket.write(frame(REQUEST, JSON.stringify({ args: request.args, ...(tty ? { tty: size() } : {}) })));
  if (tty && process.stdin.isTTY) makeRaw();
  if (tty) process.on("SIGWINCH", () => socket.write(frame(RESIZE, JSON.stringify(size()))));
  process.stdin.on("data", (chunk) => {
    for (let at = 0; at < chunk.length; at += DATA_BYTES) {
      if (!socket.write(frame(STDIN, chunk.subarray(at, at + DATA_BYTES)))) {
        process.stdin.pause();
        socket.once("drain", () => process.stdin.resume());
      }
    }
  });
  process.stdin.once("end", () => {
    if (!socket.destroyed) socket.write(frame(STDIN_END));
  });
  process.stdin.on("error", () => {});
});

let pending = Buffer.alloc(0);
socket.on("data", (chunk) => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= 5) {
    const length = pending.readUInt32BE(1);
    if (pending.length < 5 + length) break;
    const type = pending[0];
    const payload = pending.subarray(5, 5 + length);
    pending = pending.subarray(5 + length);
    if (type === STDOUT || type === STDERR) {
      const out = type === STDOUT ? process.stdout : process.stderr;
      if (!out.write(payload)) {
        socket.pause();
        out.once("drain", () => socket.resume());
      }
    } else if (type === EXIT) {
      done = true;
      const { code, signal } = JSON.parse(payload.toString("utf8"));
      restore();
      socket.destroy();
      // Both streams flushed, then the run's own exit: its code, or its signal, as if msb ran here.
      process.stdout.write("", () =>
        process.stderr.write("", () => {
          if (typeof code === "number") process.exit(code);
          try {
            process.kill(process.pid, signal || "SIGKILL");
          } catch {
            process.exit(NOT_RUN);
          }
        }),
      );
      return;
    } else if (type === FAILED) {
      done = true;
      socket.destroy();
      fail(payload.toString("utf8"));
      return;
    }
  }
});
socket.on("error", (error) => {
  if (!done) {
    done = true;
    fail(error.message);
  }
});
socket.on("close", () => {
  if (!done) {
    done = true;
    fail("the relay closed before msb ended");
  }
});
