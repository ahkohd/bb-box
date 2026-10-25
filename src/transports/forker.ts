// Starts bb-box's short-lived child processes from a small helper process,
// not from BB's server. On Linux, libuv starts a child with fork, on the
// loop's thread, and the fork copies the parent's page tables: with BB's
// server at 3.5 GB, each spawn held every desktop's frames and input for
// about 49 ms, and bb-box spawned about 47 a minute, an ssh client for each
// command (measured 22 October 2026). The helper is started once, and forks
// in a few hundred microseconds; the child's output comes back over its IPC
// channel. Should the helper not start, or end, bb-box spawns directly, as
// before. Long-lived streams, a desktop's route or a terminal, are few and keep
// their own pipes.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { timedSpawn } from "./spawns.ts";

/** What bb-box uses of a child process. */
export interface ChildLike extends EventEmitter {
  readonly stdin: Writable;
  readonly stdout: PassThrough | NonNullable<ChildProcess["stdout"]>;
  readonly stderr: PassThrough | NonNullable<ChildProcess["stderr"]>;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * The helper, run as `node -e`: it spawns what it is asked to, and sends each
 * child's output and end back. While the parent has not taken a child's output,
 * it reads no more of it. It ends its children, and itself, when the parent goes.
 */
export const HELPER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const children = new Map();
const AHEAD = 16;
const signalOnceStarted = (child, signal) => { if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return; try { child.kill(signal); } catch {} };
const send = (message, child) => {
  if (child) {
    child.bbAhead = (child.bbAhead || 0) + 1;
    if (child.bbAhead > AHEAD) { child.stdout.pause(); child.stderr.pause(); }
  }
  process.send(message, undefined, undefined, () => {
    if (!child) return;
    child.bbAhead--;
    if (child.bbAhead <= AHEAD / 2 && !child.bbClosed) { child.stdout.resume(); child.stderr.resume(); }
  });
};
process.on("message", (m) => {
  if (m.op === "spawn") {
    let child;
    try {
      child = spawn(m.binary, m.args, { stdio: m.ignore ? "ignore" : ["pipe", "pipe", "pipe"], env: m.env || process.env, cwd: m.cwd || undefined });
    } catch (e) {
      send({ op: "error", id: m.id, message: e.message, code: e.code });
      send({ op: "close", id: m.id, code: null, signal: null });
      return;
    }
    children.set(m.id, child);
    child.on("spawn", () => send({ op: "spawn", id: m.id, pid: child.pid }));
    if (!m.ignore) {
      child.stdout.on("data", (data) => send({ op: "out", id: m.id, data }, child));
      child.stderr.on("data", (data) => send({ op: "err", id: m.id, data }, child));
      child.stdin.on("error", () => {});
    }
    child.on("error", (e) => send({ op: "error", id: m.id, message: e.message, code: e.code }));
    child.on("exit", (code, signal) => send({ op: "exit", id: m.id, code, signal }));
    child.on("close", (code, signal) => { child.bbClosed = true; children.delete(m.id); send({ op: "close", id: m.id, code, signal }); });
    return;
  }
  const child = children.get(m.id);
  if (!child) return;
  if (m.op === "in") child.stdin?.write(Buffer.from(m.data));
  else if (m.op === "end") child.stdin?.end();
  else if (m.op === "kill") signalOnceStarted(child, m.signal);
  else if (m.op === "drop") { child.stdout?.destroy(); child.stderr?.destroy(); }
});
process.on("message", (m) => { if (m.op === "stop") stop(); });
const stop = () => {
  for (const child of children.values()) signalOnceStarted(child, "SIGKILL");
  process.exit(0);
};
process.on("disconnect", stop);
`;

type Message =
  | { op: "spawn"; id: number; pid: number }
  | { op: "out" | "err"; id: number; data: Uint8Array }
  | { op: "error"; id: number; message: string; code?: string }
  | { op: "exit" | "close"; id: number; code: number | null; signal: NodeJS.Signals | null };

/** A child the helper runs, as bb-box sees it. */
class ForkedChild extends EventEmitter implements ChildLike {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly #id: number;
  readonly #helper: Helper;
  readonly argv: readonly string[];

  constructor(id: number, helper: Helper, argv: readonly string[]) {
    super();
    this.#id = id;
    this.#helper = helper;
    this.argv = argv;
    this.stdin = new Writable({
      write: (chunk: Buffer, _encoding, done) => {
        helper.send({ op: "in", id, data: new Uint8Array(chunk) });
        done();
      },
      final: (done) => {
        helper.send({ op: "end", id });
        done();
      },
    });
    // bb-box destroys the output streams when it has what it wants: the helper reads no more.
    for (const stream of [this.stdout, this.stderr]) stream.once("close", () => helper.send({ op: "drop", id }));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.#helper.send({ op: "kill", id: this.#id, signal });
    return true;
  }

  /** A message from the helper about this child. */
  take(message: Message): void {
    switch (message.op) {
      case "spawn":
        this.pid = message.pid;
        this.emit("spawn");
        return;
      case "out":
        if (!this.stdout.destroyed) this.stdout.write(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
        return;
      case "err":
        if (!this.stderr.destroyed) this.stderr.write(Buffer.from(message.data.buffer, message.data.byteOffset, message.data.byteLength));
        return;
      case "error":
        this.emit("error", Object.assign(new Error(message.message), message.code ? { code: message.code } : {}));
        return;
      case "exit":
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.emit("exit", message.code, message.signal);
        return;
      case "close":
        this.stdout.end();
        this.stderr.end();
        this.emit("close", message.code, message.signal);
        return;
    }
  }

  /** The helper ended: the child is gone with it. */
  lost(): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.signalCode = "SIGKILL";
    this.emit("exit", null, "SIGKILL");
    this.stdout.end();
    this.stderr.end();
    this.emit("close", null, "SIGKILL");
  }
}

/** The helper process, started once, and its children by ID. */
class Helper {
  readonly #process: ChildProcess;
  readonly #children = new Map<number, ForkedChild>();
  #next = 0;
  alive = true;

  constructor(onEnd: () => void) {
    this.#process = timedSpawn(() =>
      spawn(process.execPath, ["-e", HELPER_SOURCE], { stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced", env: process.env }),
      "spawn helper",
    );
    this.#process.on("message", (message: Message) => {
      const child = this.#children.get(message.id);
      if (!child) return;
      child.take(message);
      if (message.op === "close") {
        this.#children.delete(message.id);
        if (!this.#children.size) this.#hold(false);
      }
    });
    const end = () => {
      if (!this.alive) return;
      this.alive = false;
      for (const child of this.#children.values()) child.lost();
      this.#children.clear();
      onEnd();
    };
    this.#process.on("exit", end);
    this.#process.on("error", end);
    this.#hold(false);
  }

  /** The helper and its channel keep the process running only while a child runs, as a child of its own would. */
  #hold(on: boolean): void {
    const channel = (this.#process as unknown as { channel?: { ref(): void; unref(): void } }).channel;
    if (on) {
      this.#process.ref();
      channel?.ref();
    } else {
      this.#process.unref();
      channel?.unref();
    }
  }

  start(binary: string, args: readonly string[], options: StartOptions): ForkedChild {
    const id = ++this.#next;
    const child = new ForkedChild(id, this, [binary, ...args]);
    this.#children.set(id, child);
    if (this.#children.size === 1) this.#hold(true);
    // The environment as it is now, not as it was when the helper started.
    this.send({ op: "spawn", id, binary, args: [...args], env: options.env ?? process.env, cwd: options.cwd ?? null, ignore: options.stdio === "ignore" });
    return child;
  }

  send(message: object): void {
    if (!this.alive || !this.#process.connected) return;
    this.#process.send(message);
  }

  get pid(): number | undefined {
    return this.#process.pid;
  }

  get waitingOn(): string[] {
    return [...this.#children.values()].map((child) => {
      const ended = child.exitCode ?? child.signalCode;
      const command = child.argv.join(" ");
      return `${child.pid ?? "unstarted"}, ${ended === null ? "not exited" : `exited with ${ended}`}: ${command.slice(0, 120)} ... ${command.slice(-700)}`;
    });
  }

  /** Ends the helper and its children: it kills them when told to stop, or when its channel closes. */
  stop(): void {
    if (!this.alive) return;
    this.alive = false;
    for (const child of this.#children.values()) child.lost();
    this.#children.clear();
    if (this.#process.connected) {
      this.#process.send({ op: "stop" });
      this.#process.disconnect();
    }
    const unresponsive = setTimeout(() => this.#process.kill("SIGKILL"), STOP_WAIT_MS);
    unresponsive.unref();
    this.#process.once("exit", () => clearTimeout(unresponsive));
  }
}

let helper: Helper | null = null;
/** When the helper last ended: it is not started again for a while, and bb-box spawns directly meanwhile. */
let endedAt = 0;
const RESTART_AFTER_MS = 30_000;
/** How long a helper told to stop has before it is killed. */
const STOP_WAIT_MS = 2_000;

/** Whether children go through the helper: not where BB_BOX_DIRECT_SPAWN=1, as to compare. */
const useHelper = () => process.env.BB_BOX_DIRECT_SPAWN !== "1";

export interface StartOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Where bb-box starts it, as the loop watch counts it, such as "ssh command". */
  readonly site: string;
  /** Its standard streams go nowhere, as for a process that stays in the background, rather than piped. */
  readonly stdio?: "ignore";
}

/**
 * Starts `binary` with `args`, its three standard streams piped unless ignored, from the helper, or directly when
 * the helper is not running.
 */
export function startChild(binary: string, args: readonly string[], options: StartOptions): ChildLike {
  if (useHelper() && Date.now() - endedAt >= RESTART_AFTER_MS) {
    try {
      helper ??= new Helper(() => {
        helper = null;
        endedAt = Date.now();
      });
      if (helper.alive) return timedSpawn(() => helper!.start(binary, args, options), options.site, true);
    } catch {
      helper = null;
      endedAt = Date.now();
    }
  }
  return timedSpawn(() => spawn(binary, args, { stdio: options.stdio ?? ["pipe", "pipe", "pipe"], env: options.env, cwd: options.cwd }) as ChildLike, options.site);
}

export function helperChildrenNotClosed(): string[] {
  return helper?.alive ? helper.waitingOn : [];
}

/** The helper's process ID, while it runs. */
export function helperPid(): number | undefined {
  return helper?.alive ? helper.pid : undefined;
}

/** Ends the helper, and so its children, as when bb-box stops. */
export function stopForker(): void {
  helper?.stop();
  helper = null;
}
