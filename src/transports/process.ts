// Runs a box's scripts through a local command line: `ssh user@host -- script`,
// `docker exec -i container sh -c script`, or plain `sh -c script`. Output
// capture, timeouts, cancellation and file copies are the same for all of
// them. File copies use POSIX tools, so they suit Linux and macOS boxes.

import { spawn } from "node:child_process";
import type { RunOptions, RunResult, StreamOptions } from "./types.ts";

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandError";
  }
}

export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Keeps the first and last `limit / 2` bytes of a stream. */
export class Capture {
  readonly #half: number;
  #head: Buffer[] = [];
  #headBytes = 0;
  #tail: Buffer[] = [];
  #tailBytes = 0;
  truncated = false;

  constructor(limit: number) {
    this.#half = Math.max(1, Math.floor(limit / 2));
  }

  push(chunk: Buffer): void {
    if (this.#headBytes < this.#half) {
      const take = chunk.subarray(0, this.#half - this.#headBytes);
      this.#head.push(take);
      this.#headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.#tail.push(chunk);
    this.#tailBytes += chunk.length;
    while (this.#tailBytes > this.#half && this.#tail.length) {
      const extra = this.#tailBytes - this.#half;
      const first = this.#tail[0]!;
      this.truncated = true;
      if (first.length <= extra) {
        this.#tail.shift();
        this.#tailBytes -= first.length;
      } else {
        this.#tail[0] = first.subarray(extra);
        this.#tailBytes -= extra;
      }
    }
  }

  text(): string {
    const head = Buffer.concat(this.#head).toString("utf8");
    const tail = Buffer.concat(this.#tail).toString("utf8");
    return this.truncated ? `${head}\n[... output truncated ...]\n${tail}` : head + tail;
  }
}

type Spawned = Omit<RunResult, "stdout" | "stderr" | "truncated">;

export interface CommandLineOptions {
  /** The command line that runs `script`, for example ["ssh", ..., "--", script]. */
  readonly argv: (script: string) => readonly [string, ...string[]];
  /** Makes the errors this command line throws, so each transport keeps its own error type. */
  readonly error?: (message: string) => Error;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export class CommandLine {
  readonly #options: CommandLineOptions;

  constructor(options: CommandLineOptions) {
    this.#options = options;
  }

  #error(message: string): Error {
    return this.#options.error?.(message) ?? new CommandError(message);
  }

  run(script: string, options: RunOptions = {}): Promise<RunResult> {
    const stdout = new Capture(options.maxOutputBytes ?? 128 * 1024);
    const stderr = new Capture(options.maxOutputBytes ?? 128 * 1024);
    return this.#spawn(script, options, (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk)).then((result) => ({
      ...result,
      stdout: stdout.text(),
      stderr: stderr.text(),
      truncated: stdout.truncated || stderr.truncated,
    }));
  }

  /** Runs `script` and passes its output on as it arrives. */
  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    const result = await this.#spawn(
      script,
      options,
      (chunk) => options.onOutput(chunk, "stdout"),
      (chunk) => options.onOutput(chunk, "stderr"),
    );
    return { exitCode: result.exitCode, timedOut: result.timedOut };
  }

  /** Writes `data` to `path`, creating parent directories. */
  async writeFile(path: string, data: Uint8Array, options: { mode?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const target = quote(path);
    const chmod = options.mode ? ` && chmod ${quote(options.mode)} ${target}` : "";
    const script = `mkdir -p -- "$(dirname -- ${target})" && cat > ${target}${chmod}`;
    const result = await this.run(script, { stdin: data, timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal });
    if (result.exitCode !== 0) throw this.#error(failure(`write ${path}`, result));
  }

  /** Reads `path`. Fails when it is larger than `maxBytes`. */
  async readFile(path: string, options: { maxBytes: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const errors = new Capture(8 * 1024);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const result = await this.#spawn(
      `cat -- ${quote(path)}`,
      { timeoutMs: options.timeoutMs ?? 120_000, signal },
      (chunk) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          tooLarge = true;
          controller.abort(this.#error("too large"));
          return;
        }
        chunks.push(chunk);
      },
      (chunk) => errors.push(chunk),
    ).catch((error) => {
      if (tooLarge) return null;
      throw error;
    });
    if (tooLarge) throw this.#error(`${path} is larger than ${options.maxBytes} bytes.`);
    if (!result || result.exitCode !== 0) {
      throw this.#error(failure(`read ${path}`, { ...result!, stdout: "", stderr: errors.text(), truncated: false }));
    }
    return Buffer.concat(chunks);
  }

  /** True when the command line runs a script. */
  async probe(signal?: AbortSignal): Promise<boolean> {
    const result = await this.run("true", { timeoutMs: 5_000, signal });
    return result.exitCode === 0;
  }

  #spawn(script: string, options: RunOptions, onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): Promise<Spawned> {
    const started = Date.now();
    const [binary, ...args] = this.#options.argv(script);
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: this.#options.env, cwd: this.#options.cwd });
      let timedOut = false;
      let killed = false;
      let settled = false;
      // After a kill, anything that inherited the pipes could hold them open,
      // so the result is settled on exit rather than on close.
      const kill = () => {
        killed = true;
        child.kill("SIGKILL");
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs)
        : undefined;
      const abort = () => kill();
      options.signal?.addEventListener("abort", abort, { once: true });
      const finish = (error: Error | null, exitCode: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) return reject(error);
        if (options.signal?.aborted && !timedOut) return reject(options.signal.reason);
        resolve({ exitCode, timedOut, durationMs: Date.now() - started });
      };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      child.on("error", (error) => finish(this.#error(`Cannot run ${binary}: ${error.message}`), null));
      child.on("close", (code) => finish(null, code));
      child.on("exit", (code) => {
        if (!killed) return;
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, code);
      });
      child.stdin.on("error", () => {
        // The other side may exit before reading all of stdin.
      });
      if (options.stdin !== undefined) child.stdin.end(options.stdin);
      else child.stdin.end();
    });
  }
}

export function failure(action: string, result: Omit<RunResult, "stdout"> & { stdout?: string }): string {
  if (result.timedOut) return `Could not ${action}: timed out.`;
  const detail = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
  return `Could not ${action}: exit ${result.exitCode}${detail ? ` (${detail})` : ""}.`;
}
