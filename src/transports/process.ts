// Runs a box's scripts through a local command line: `ssh user@host -- script`,
// `docker exec -i container sh -c script`, or plain `sh -c script`. Output
// capture, timeouts, cancellation and file copies are the same for all of
// them. File copies use POSIX tools, so they suit Linux and macOS boxes.
//
// A run ends when the script's shell exits, even while something the script
// left in the background still holds the session's output. bash, for one,
// keeps a subshell for `cd web && nohup server >log 2>&1 &` that waits for the
// server with the session's stdout and stderr open, so ssh would not return
// until the server stopped. A POSIX script therefore runs in a child shell,
// and after it exits the wrapper writes an end mark with its exit status to
// both streams. Once both marks arrive, all the shell wrote has too: the run
// returns and stops the local command line, and the box keeps what the
// script started.

import { basename } from "node:path";
import { startChild } from "./forker.ts";
import { randomBytes } from "node:crypto";
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

type Spawned = Omit<RunResult, "stdout" | "stderr" | "truncated"> & { readonly stdoutWhole: boolean };

const NOTHING = Buffer.alloc(0);

/** A script that succeeds in sh and PowerShell alike. */
export const PROBE = "exit 0";

/**
 * What a script that loads the box's env file itself starts with. An
 * enrolled box's shell startup file does not load it again in a shell whose
 * command starts with this, so a command loads the thread's environment
 * once, not once more in each shell around it (#100).
 */
export const LOADS_ENV = ": bb-box-env; ";

/**
 * Runs `script` in a child of the login shell, then writes `mark` and its
 * exit status to stdout and stderr. Without stdin, the script reads
 * /dev/null, so nothing it starts holds the session's input either. The mark
 * goes into the command line in two halves, so a script that prints command
 * lines, as `ps aux` does, never prints it whole. The login shell only
 * starts the script's, so it skips the env file too when the script loads
 * it itself.
 */
export function endMarked(script: string, mark: string, stdin: boolean): string {
  const input = stdin ? "" : " </dev/null";
  const half = Math.ceil(mark.length / 2);
  const pieces = `${quote(mark.slice(0, half))} ${quote(mark.slice(half))}`;
  return (
    `${script.startsWith(LOADS_ENV) ? LOADS_ENV : ""}"\${SHELL:-/bin/sh}" -c ${quote(script)}${input}; bb_box_status=$?; ` +
    `printf '%s%s%s\\n' ${pieces} "$bb_box_status"; printf '%s%s%s\\n' ${pieces} "$bb_box_status" >&2; exit "$bb_box_status"`
  );
}

/** Finds the end mark in one stream: passes on the output before it, and reads the exit status after it. */
export class EndMark {
  readonly #mark: Buffer;
  /** The end of the output so far, held back while it could be the start of the mark. */
  #held: Buffer = NOTHING;
  /** After the mark, the status read so far. */
  #after: Buffer | null = null;
  /** The script's exit status, once the whole mark has arrived. */
  status: number | null = null;

  constructor(mark: string) {
    this.#mark = Buffer.from(mark);
  }

  /** The output in `chunk` before the mark. Anything after the mark is dropped. */
  push(chunk: Buffer): Buffer {
    if (this.status !== null) return NOTHING;
    if (this.#after) {
      this.#status(chunk);
      return NOTHING;
    }
    const data = this.#held.length ? Buffer.concat([this.#held, chunk]) : chunk;
    const at = data.indexOf(this.#mark);
    if (at >= 0) {
      this.#held = NOTHING;
      this.#after = NOTHING;
      this.#status(data.subarray(at + this.#mark.length));
      return data.subarray(0, at);
    }
    let keep = Math.min(this.#mark.length - 1, data.length);
    while (keep > 0 && !data.subarray(data.length - keep).equals(this.#mark.subarray(0, keep))) keep--;
    this.#held = Buffer.from(data.subarray(data.length - keep));
    return data.subarray(0, data.length - keep);
  }

  #status(chunk: Buffer): void {
    const after = Buffer.concat([this.#after!, chunk]);
    const end = after.indexOf(10);
    if (end < 0) {
      this.#after = after;
      return;
    }
    const status = Number(after.subarray(0, end).toString("ascii"));
    this.status = Number.isInteger(status) ? status : -1;
  }

  /** What was held back, when the stream ends without the mark. */
  rest(): Buffer {
    const rest = this.#held;
    this.#held = NOTHING;
    return rest;
  }
}

export interface CommandLineOptions {
  /** The command line that runs `script`, for example ["ssh", ..., "--", script]. */
  readonly argv: (script: string) => readonly [string, ...string[]];
  /** Makes the errors this command line throws, so each transport keeps its own error type. */
  readonly error?: (message: string) => Error;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /**
   * False when scripts run in a shell that is not POSIX, such as PowerShell.
   * Their runs end only once nothing holds the output open.
   */
  readonly posix?: boolean;
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
    return this.#spawn(script, options, (chunk) => stdout.push(chunk), (chunk) => stderr.push(chunk)).then(({ stdoutWhole: _, ...result }) => ({
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

  /**
   * Writes `data` to `path`, creating parent directories. In a shell that is
   * not POSIX, `script` writes stdin to the file, and `mode` is its concern.
   */
  async writeFile(path: string, data: Uint8Array, options: { mode?: string; script?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const target = quote(path);
    const chmod = options.mode ? ` && chmod ${quote(options.mode)} ${target}` : "";
    const script = options.script ?? `mkdir -p -- "$(dirname -- ${target})" && cat > ${target}${chmod}`;
    const result = await this.run(script, { stdin: data, timeoutMs: options.timeoutMs ?? 120_000, signal: options.signal });
    if (result.exitCode !== 0) throw this.#error(failure(`write ${path}`, result));
  }

  /** Reads `path`. Fails when it is larger than `maxBytes`. In a shell that is not POSIX, `script` writes the file to stdout. */
  async readFile(path: string, options: { maxBytes: number; script?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    const errors = new Capture(8 * 1024);
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const result = await this.#spawn(
      options.script ?? `cat -- ${quote(path)}`,
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
    if (!result.stdoutWhole) throw this.#error(`Could not read ${path}: the connection ended before all of it arrived. Try again.`);
    return Buffer.concat(chunks);
  }

  /** True when the command line runs a script. */
  async probe(signal?: AbortSignal): Promise<boolean> {
    const result = await this.run(PROBE, { timeoutMs: 5_000, signal });
    return result.exitCode === 0;
  }

  #spawn(script: string, options: RunOptions, onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): Promise<Spawned> {
    const started = Date.now();
    const mark = this.#options.posix === false ? null : `bb-box-end-${randomBytes(12).toString("hex")}:`;
    const marks = mark ? { stdout: new EndMark(mark), stderr: new EndMark(mark) } : null;
    const [binary, ...args] = this.#options.argv(mark ? endMarked(script, mark, options.stdin !== undefined) : script);
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      // From the helper, which forks in place of BB's server (forker.ts).
      const child = startChild(binary, args, { env: this.#options.env, cwd: this.#options.cwd, site: `${basename(binary)} command` });
      let timedOut = false;
      let killed = false;
      let settled = false;
      // After a kill, anything that inherited the pipes could hold them open,
      // so the result is settled on exit rather than on close. A command line
      // that has exited already is settled at once.
      const kill = () => {
        killed = true;
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          return;
        }
        child.stdout.destroy();
        child.stderr.destroy();
        ended(child.exitCode);
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
        resolve({ exitCode, timedOut, durationMs: Date.now() - started, stdoutWhole: !marks || marks.stdout.status !== null });
      };
      // Once both marks are in, the script's shell has exited and everything
      // it wrote has arrived. What it left running keeps running in the box.
      const marked = () => {
        if (!marks || marks.stdout.status === null || marks.stderr.status === null) return;
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill();
        finish(null, marks.stdout.status);
      };
      const pass = (from: EndMark | undefined, onOutput: (chunk: Buffer) => void) => (chunk: Buffer) => {
        const output = from ? from.push(chunk) : chunk;
        if (output.length) onOutput(output);
        marked();
      };
      /** Ends a run without both marks: output held back as a possible mark was output after all. */
      const ended = (code: number | null) => {
        if (settled) return;
        if (marks) {
          const [out, err] = [marks.stdout.rest(), marks.stderr.rest()];
          if (out.length) onStdout(out);
          if (err.length) onStderr(err);
        }
        finish(null, marks?.stdout.status ?? marks?.stderr.status ?? code);
      };
      child.stdout.on("data", pass(marks?.stdout, onStdout));
      child.stderr.on("data", pass(marks?.stderr, onStderr));
      child.on("error", (error) => finish(this.#error(`Cannot run ${binary}: ${error.message}`), null));
      child.on("close", (code) => ended(code));
      child.on("exit", (code) => {
        if (!killed) return;
        child.stdout.destroy();
        child.stderr.destroy();
        ended(code);
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
