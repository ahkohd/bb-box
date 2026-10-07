// The machine's end of the msb relay (053), in bb-box's host entry.
// "msbRelay" opens a WebSocket out to bb-box's route, as "relay" does for
// Docker (src/host/relay.ts), and each channel the server opens is one run
// of bb-box's msb here, with the frames of src/relay/msb.ts. "microsandbox"
// runs one of bb-box's own scripts here (src/backends/microsandbox/release.ts):
// install the pinned msb, report on the machine, or import an image from
// Docker. The entry runs nothing else: msb's arguments come from bb-box,
// but the binary is always bin/msb in bb-box's own msb folder.
//
// That folder is in the plugin's data folder on this machine, with msb's
// state and images, so removing the plugin's data removes them too.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { Capture, quote } from "../transports/process.ts";
import { msbScript, scriptArgsOk } from "../backends/microsandbox/release.ts";
import type { Channel } from "../relay/mux.ts";
import { DATA_BYTES, FRAME, FrameReader, clamp, frame, parseRequest, type TtySize } from "../relay/msb.ts";
import { dial, type RelayWebSocket } from "./relay.ts";

export interface MsbOptions {
  /** bb-box's msb folder here; by default `microsandbox` in the plugin's data folder. */
  readonly dir?: string;
  readonly connect?: (url: string) => RelayWebSocket;
  readonly pingMs?: number;
  readonly deadMs?: number;
}

/** How long each script may take: an install downloads about 30 MB, and an import moves a desktop image of about 1.7 GB. */
const SCRIPT_MS: Readonly<Record<string, number>> = { install: 10 * 60_000, status: 60_000, images: 60_000, import: 30 * 60_000, disk: 30_000, undisk: 60_000, disks: 30_000, transfer: 30 * 60_000 };
/** How long a run that bb-box stopped waiting for has, after SIGTERM, before SIGKILL. */
const KILL_MS = 2_000;
const OUTPUT_BYTES = 256 * 1024;

const darwin = process.platform === "darwin";

/** The run's own PTY, as src/transports/terminal.ts makes one: `script`, which prints the PTY's path first. */
function scriptArgv(binary: string, args: readonly string[], size: TtySize): [string, ...string[]] {
  const inner = `tty; stty cols ${size.cols} rows ${size.rows}; exec ${[binary, ...args].map(quote).join(" ")}`;
  return darwin ? ["script", "-q", "/dev/null", "/bin/sh", "-c", inner] : ["script", "-qfc", inner, "/dev/null"];
}

/** Runs one request from `channel`, with `binary` as msb, until it exits or the channel goes. */
function serve(channel: Channel, binary: string): void {
  const reader = new FrameReader();
  let child: ChildProcess | null = null;
  let pty: string | null = null;
  let head = Buffer.alloc(0);
  let finished = false;
  const send = (type: number, payload?: Uint8Array | string) => {
    if (!channel.destroyed && !channel.writableEnded) return channel.write(frame(type, payload));
    return true;
  };
  const failed = (reason: string) => {
    if (finished) return;
    finished = true;
    send(FRAME.failed, reason);
    channel.end();
  };
  /** Sends a stream's output in frames, pausing it while the channel is full. */
  const forward = (stream: NodeJS.ReadableStream, type: number, chunk: Buffer) => {
    for (let at = 0; at < chunk.length; at += DATA_BYTES) {
      if (!send(type, chunk.subarray(at, at + DATA_BYTES))) {
        stream.pause();
        channel.once("drain", () => stream.resume());
      }
    }
  };
  const stop = () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // A PTY's run is a person's terminal: hung up at once, as terminal.ts does.
    child.kill(pty ? "SIGKILL" : "SIGTERM");
    const timer = setTimeout(() => child?.exitCode === null && child.signalCode === null && child.kill("SIGKILL"), KILL_MS);
    timer.unref?.();
  };
  channel.on("error", stop);
  channel.on("close", stop);

  const start = (args: readonly string[], tty: TtySize | undefined) => {
    if (!existsSync(binary)) return failed(`msb is not installed here (${binary}). bb-box installs it with its doctor's fix, or when it first needs it.`);
    const [program, ...rest] = tty ? scriptArgv(binary, args, tty) : [binary, ...args];
    const spawned = spawn(program!, rest, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(tty ? { TERM: "xterm-256color" } : {}) } });
    child = spawned;
    spawned.stdin.on("error", () => {});
    spawned.once("error", (error) => failed(`cannot run ${program}: ${error.message}`));
    spawned.stdout.on("data", (chunk: Buffer) => {
      if (!tty || pty) return forward(spawned.stdout, FRAME.stdout, chunk);
      // The first line is the PTY's path; the bytes after it are the terminal's.
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(0x0a);
      if (end === -1) return;
      pty = head.subarray(0, end).toString("utf8").trim();
      const rest = head.subarray(end + 1);
      head = Buffer.alloc(0);
      if (rest.length) forward(spawned.stdout, FRAME.stdout, rest);
    });
    spawned.stderr.on("data", (chunk: Buffer) => forward(spawned.stderr, FRAME.stderr, chunk));
    spawned.once("close", (code, signal) => {
      if (finished) return;
      finished = true;
      send(FRAME.exit, JSON.stringify({ code, signal }));
      channel.end();
    });
  };

  channel.on("data", (chunk: Buffer) => {
    let frames: { type: number; payload: Buffer }[];
    try {
      frames = reader.push(chunk);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
    for (const { type, payload } of frames) {
      if (!child) {
        if (finished) return;
        if (type !== FRAME.request) return failed("the first frame was not a request");
        const request = parseRequest(payload);
        if (typeof request === "string") return failed(request);
        start(request.args, request.tty);
        continue;
      }
      if (type === FRAME.stdin) {
        if (!child.stdin!.write(payload)) {
          channel.pause();
          child.stdin!.once("drain", () => channel.resume());
        }
      } else if (type === FRAME.stdinEnd) {
        // A PTY's input stays open: the end of the client's stdin is not the terminal's.
        if (!pty) child.stdin!.end();
      } else if (type === FRAME.resize && pty) {
        const parsed = parseRequest(Buffer.from(`{"args":[],"tty":${payload.toString("utf8")}}`));
        if (typeof parsed === "string" || !parsed.tty) continue;
        const size = clamp(parsed.tty);
        execFile("stty", [darwin ? "-f" : "-F", pty, "cols", String(size.cols), "rows", String(size.rows)], () => {});
      }
    }
  });
}

/** Runs one of bb-box's scripts with `args`, in `dir`, and gives its output. */
function runScript(dir: string, name: string, args: readonly string[], signal: AbortSignal): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    if (!scriptArgsOk(name, args)) return resolve({ exitCode: 2, stdout: "", stderr: `bb-box's host entry runs no script ${name} with those arguments.` });
    const stdout = new Capture(OUTPUT_BYTES);
    const stderr = new Capture(OUTPUT_BYTES);
    const child = spawn("sh", ["-c", msbScript(name), "bb-box-msb", ...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BBBOX_MSB_DIR: dir } });
    const timer = setTimeout(() => child.kill("SIGKILL"), SCRIPT_MS[name] ?? 60_000);
    const kill = () => child.kill("SIGKILL");
    signal.addEventListener("abort", kill, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve({ exitCode: null, stdout: "", stderr: `Cannot run sh: ${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text() });
    });
  });
}

export function msbHandlers(options: MsbOptions = {}) {
  const leases = new Set<ExperimentalHostWorkerLease>();
  const muxes = new Set<{ close(reason: string): void }>();
  const dirOf = (context: ExperimentalHostRpcContext) => options.dir ?? join(context.experimental_paths.dataDir, "microsandbox");
  return {
    handlers: {
      microsandbox: async ({ script, args }: { script: string; args: string[] }, context: ExperimentalHostRpcContext) => {
        const dir = dirOf(context);
        return { dir, ...(await runScript(dir, script, args, context.signal)) };
      },
      msbRelay: async ({ secret, path }: { secret: string; path: string }, context: ExperimentalHostRpcContext) => {
        const dir = dirOf(context);
        if (!process.env.BB_SERVER_URL) throw new Error("BB_SERVER_URL is not set in the worker, so it cannot reach bb-box.");
        const lease = context.experimental_retainWorker();
        leases.add(lease);
        const binary = join(dir, "bin", "msb");
        const mux = dial(path, secret, options.connect, {
          onOpen: (channel) => serve(channel, binary),
          pingMs: options.pingMs,
          deadMs: options.deadMs,
          onClose: () => {
            muxes.delete(mux);
            leases.delete(lease);
            void lease.dispose();
          },
        });
        muxes.add(mux);
        return { dir };
      },
    },
    async dispose() {
      for (const mux of muxes) mux.close("the worker stopped");
      for (const lease of leases) await lease.dispose();
    },
  };
}
