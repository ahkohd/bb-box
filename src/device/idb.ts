import { execFile, spawn } from "node:child_process";
import { closeSync, openSync, statSync, truncateSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import type { Orientation } from "../core/device.ts";
import { DriverError } from "./driver.ts";
import { GrpcClient } from "./grpc.ts";
import { decode, encode } from "./protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "./schemas.ts";

export const COMPANION_PROGRAM = "/usr/local/bin/idb_companion";
const START_WAIT_MS = 30_000;
const SOCKET_POLL_MS = 50;
const LOG_MOST_BYTES = 1024 * 1024;
const H264 = 0;
const STREAM_QUALITY = 0.2;
const PNG = 0;

export interface CompanionPaths {
  readonly socket: string;
  readonly record: string;
  readonly log: string;
}

interface CompanionRecord {
  readonly pid: number;
  readonly udid: string;
}

function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolve) => execFile("ps", ["-p", String(pid), "-o", "command="], (error, stdout) => resolve(error ? null : stdout.trim())));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Companion {
  readonly #program: string;
  readonly #paths: CompanionPaths;
  readonly #log: (line: string) => void;
  #record: CompanionRecord | null = null;
  #client: GrpcClient | null = null;

  constructor(options: { readonly program?: string; readonly paths: CompanionPaths; readonly log: (line: string) => void }) {
    this.#program = options.program ?? COMPANION_PROGRAM;
    this.#paths = options.paths;
    this.#log = options.log;
  }

  get client(): GrpcClient {
    if (!this.#client) throw new DriverError("not-booted", "idb_companion is not running for this device.");
    return this.#client;
  }

  get pid(): number | null {
    return this.#record?.pid ?? null;
  }

  async #recorded(): Promise<CompanionRecord | null> {
    if (this.#record) return this.#record;
    try {
      const parsed = JSON.parse(await readFile(this.#paths.record, "utf8")) as Partial<CompanionRecord>;
      return typeof parsed.pid === "number" && typeof parsed.udid === "string" ? { pid: parsed.pid, udid: parsed.udid } : null;
    } catch {
      return null;
    }
  }

  async #ours(pid: number): Promise<boolean> {
    const command = await commandOf(pid);
    return !!command && command.includes("--grpc-domain-sock") && command.includes(this.#paths.socket);
  }

  async alive(): Promise<boolean> {
    const record = await this.#recorded();
    return !!record && (await this.#ours(record.pid));
  }

  async ensure(udid: string, signal: AbortSignal): Promise<"reused" | "started"> {
    const known = await this.#recorded();
    if (known && (await this.#ours(known.pid))) {
      if (known.udid === udid && (await socketAnswers(this.#paths.socket))) {
        this.#record = known;
        this.#connect();
        return "reused";
      }
      this.#kill(known.pid);
    }
    await this.#start(udid, signal);
    return "started";
  }

  #connect(): void {
    this.#client?.close();
    this.#client = new GrpcClient({ socket: this.#paths.socket });
  }

  #kill(pid: number): void {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }

  #trimLog(): void {
    try {
      if (statSync(this.#paths.log).size > LOG_MOST_BYTES) truncateSync(this.#paths.log, 0);
    } catch {}
  }

  async #start(udid: string, signal: AbortSignal): Promise<void> {
    await rm(this.#paths.socket, { force: true });
    this.#trimLog();
    const log = openSync(this.#paths.log, "a");
    const began = performance.now();
    const child = spawn(this.#program, ["--udid", udid, "--grpc-domain-sock", this.#paths.socket], { detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    const exited = new Promise<string>((resolve) => {
      child.once("exit", (code, why) => resolve(`it stopped with ${why ?? `exit code ${code}`}`));
      child.once("error", (error) => resolve(error.message));
    });
    child.unref();
    if (child.pid === undefined) throw new DriverError("failed", `idb_companion did not start: ${await exited}.`);
    this.#record = { pid: child.pid, udid };
    const fresh = `${this.#paths.record}.new`;
    await writeFile(fresh, `${JSON.stringify(this.#record)}\n`, { mode: 0o600 });
    await rename(fresh, this.#paths.record);
    let early: string | null = null;
    void exited.then((why) => (early = why));
    const until = performance.now() + START_WAIT_MS;
    while (!(await socketAnswers(this.#paths.socket))) {
      if (early) throw new DriverError("failed", `idb_companion did not start: ${early}. Its log is ${this.#paths.log}.`);
      if (signal.aborted) throw signal.reason;
      if (performance.now() > until) {
        this.#kill(child.pid);
        throw new DriverError("failed", `idb_companion did not listen within ${START_WAIT_MS / 1000} s. Its log is ${this.#paths.log}.`);
      }
      await wait(SOCKET_POLL_MS);
    }
    this.#connect();
    this.#log(`companion: idb_companion ${child.pid} listens for the device ${udid}, ${Math.round(performance.now() - began)} ms after its start`);
  }

  async restart(udid: string, signal: AbortSignal): Promise<void> {
    const known = await this.#recorded();
    this.#client?.close();
    this.#client = null;
    if (known && (await this.#ours(known.pid))) this.#kill(known.pid);
    await this.#start(udid, signal);
  }

  async stop(): Promise<void> {
    const record = await this.#recorded();
    this.#client?.close();
    this.#client = null;
    this.#record = null;
    if (record && (await this.#ours(record.pid))) {
      try {
        process.kill(record.pid, "SIGTERM");
      } catch {}
    }
    await rm(this.#paths.record, { force: true });
  }

  close(): void {
    this.#client?.close();
    this.#client = null;
  }
}

export function videoStreamStart(): Uint8Array {
  return encode(IDB_SCHEMA, "idb.VideoStreamRequest", { start: { format: H264, compression_quality: STREAM_QUALITY, scale_factor: 1 } });
}

export function videoStreamStop(): Uint8Array {
  return encode(IDB_SCHEMA, "idb.VideoStreamRequest", { stop: {} });
}

export interface StreamOutput {
  readonly data: Uint8Array | null;
  readonly log: string | null;
}

export function streamOutput(message: Uint8Array): StreamOutput {
  const decoded = decode(IDB_SCHEMA, "idb.VideoStreamResponse", message) as { log_output?: Uint8Array; payload?: { data?: Uint8Array } };
  if (decoded.log_output) return { data: null, log: Buffer.from(decoded.log_output).toString("utf8").trim() };
  return { data: decoded.payload?.data ?? null, log: null };
}

export async function* videoStream(client: GrpcClient, stopped: Promise<void>, signal: AbortSignal): AsyncIterable<StreamOutput> {
  async function* requests() {
    yield videoStreamStart();
    await stopped;
    yield videoStreamStop();
  }
  for await (const message of client.call(GRPC_METHODS.idb.videoStream, requests(), { signal })) yield streamOutput(message);
}

export async function screenshot(client: GrpcClient, signal?: AbortSignal): Promise<Uint8Array> {
  const answer = await client.unary(GRPC_METHODS.idb.screenshot, encode(IDB_SCHEMA, "idb.ScreenshotRequest", { format: PNG }), { signal });
  const decoded = decode(IDB_SCHEMA, "idb.ScreenshotResponse", answer) as { image_data?: Uint8Array };
  if (!decoded.image_data?.byteLength) throw new DriverError("failed", "idb_companion sent an empty screenshot.");
  return decoded.image_data;
}

const ORIENTATIONS: Readonly<Record<number, Orientation>> = { 1: "upright", 2: "upside-down", 3: "turned-left", 4: "turned-right" };

export async function orientation(client: GrpcClient, signal?: AbortSignal): Promise<Orientation | null> {
  const answer = await client.unary(GRPC_METHODS.idb.getOrientation, encode(IDB_SCHEMA, "idb.GetOrientationRequest", {}), { signal });
  const decoded = decode(IDB_SCHEMA, "idb.GetOrientationResponse", answer) as { orientation?: number };
  return ORIENTATIONS[decoded.orientation ?? 0] ?? null;
}

const SET_ORIENTATIONS: Readonly<Record<Orientation, number>> = { upright: 0, "upside-down": 1, "turned-left": 2, "turned-right": 3 };

export async function setOrientation(client: GrpcClient, to: Orientation, signal?: AbortSignal): Promise<void> {
  await client.unary(GRPC_METHODS.idb.setOrientation, encode(IDB_SCHEMA, "idb.SetOrientationRequest", { orientation: SET_ORIENTATIONS[to] }), { signal });
}
