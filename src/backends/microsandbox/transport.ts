// A microsandbox box's CommandTransport: `msb exec --stream` as the box
// user, through the backend's msb command line (cli.ts), so it needs no
// network path to the box, as Docker's `docker exec` (031). --stream gives
// stdout and stderr as the command writes them; without it msb gives them
// only when the command exits.
//
// `msb exec` of a stopped box boots it for the command and stops it again,
// so a probe first asks `msb ping`, which fails on a stopped box. `msb exec`
// gives only the image's environment, so each script starts with the same
// prelude as a Docker box's.

import { CommandLine, quote } from "../../transports/process.ts";
import { openRoute } from "../../transports/route.ts";
import { openTerminal } from "../../transports/terminal.ts";
import {
  TransportError,
  type ByteChannel,
  type CommandTransport,
  type Route,
  type RunOptions,
  type RunResult,
  type StreamOptions,
  type Terminal,
  type TerminalSize,
} from "../../transports/types.ts";
import type { MsbCli } from "./cli.ts";

export const BOX_USER = "box";
export const BOX_HOME = `/home/${BOX_USER}`;

const PRELUDE =
  "set -a; [ ! -r /etc/environment ] || . /etc/environment; " +
  "[ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a; ";

/** What msb or the msb client says when the command never ran in the box. */
const NOT_RUN = /^error: |bb-box could not run msb|is not running|sandbox not found|ssh: |Connection (refused|closed)/im;

const ENV = ["-e", "SHELL=/bin/bash", "-e", `USER=${BOX_USER}`, "-e", `LOGNAME=${BOX_USER}`, "-e", "LANG=C.UTF-8"];

export class MsbTransport implements CommandTransport {
  readonly #cli: MsbCli;
  readonly #name: string;
  readonly #line: CommandLine;

  /** `name` is the box's sandbox on the backend's host. */
  constructor(cli: MsbCli, name: string) {
    this.#cli = cli;
    this.#name = name;
    this.#line = new CommandLine({ argv: (script) => this.#exec(["/bin/sh", "-c", PRELUDE + script]) });
  }

  /** `msb exec --stream` of `command` as the box user, in the box user's home. */
  #exec(command: readonly string[]): [string, ...string[]] {
    return this.#cli.argv(["exec", "--stream", "-u", BOX_USER, "-w", BOX_HOME, ...ENV, this.#name, "--", ...command]);
  }

  #unreachable(): TransportError {
    return new TransportError("unreachable", `The box ${this.#name} did not answer through msb exec.`);
  }

  async #reachable(result: { exitCode: number | null; timedOut: boolean; stderr?: string }, signal?: AbortSignal): Promise<void> {
    const suspect = result.timedOut || (result.exitCode !== 0 && (result.stderr === undefined || NOT_RUN.test(result.stderr)));
    if (suspect && !(await this.probe(signal))) throw this.#unreachable();
  }

  /** Whether the box runs and its user's shell answers. */
  async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      const ping = await this.#cli.run(["ping", "--quiet", this.#name], { timeoutMs: 15_000, signal });
      if (ping.exitCode !== 0) return false;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
    return this.#line.probe(signal);
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    await this.#cli.prepare(options.signal);
    const result = await this.#line.run(script, options);
    await this.#reachable(result, options.signal);
    return result;
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    await this.#cli.prepare(options.signal);
    let stderr = "";
    const result = await this.#line.stream(script, {
      ...options,
      onOutput: (chunk, from) => {
        if (from === "stderr") stderr = (stderr + Buffer.from(chunk).toString("utf8")).slice(-2_000);
        options.onOutput(chunk, from);
      },
    });
    await this.#reachable({ ...result, stderr }, options.signal);
    return result;
  }

  async writeFile(path: string, data: Uint8Array, options: { mode?: string; signal?: AbortSignal } = {}): Promise<void> {
    await this.#cli.prepare(options.signal);
    try {
      await this.#line.writeFile(path, data, options);
    } catch (error) {
      if (!(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    await this.#cli.prepare(options.signal);
    try {
      return await this.#line.readFile(path, options);
    } catch (error) {
      if (!(error instanceof Error && /larger than/.test(error.message)) && !(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  /** A route to `port` inside the box, carried by socat under `msb exec`. */
  async route(port: number, signal?: AbortSignal): Promise<Route> {
    await this.#cli.prepare(signal);
    return { type: "command", argv: this.#exec(["socat", "-", `TCP:127.0.0.1:${port}`]) };
  }

  /** Runs `script` in the box user's shell with its stdin and stdout as the channel. Closing the channel ends the run. */
  async spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    await this.#cli.prepare(signal);
    return openRoute({ type: "command", argv: this.#exec(["/bin/sh", "-c", `${PRELUDE}exec "\${SHELL:-/bin/sh}" -c ${quote(script)}`]) }, signal);
  }

  /** The box user's login shell through `msb exec -t`, on a PTY here, which msb passes the size of to the box. */
  async terminal(size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
    await this.#cli.prepare(signal);
    const argv = this.#cli.argv(
      ["exec", "-t", "-u", BOX_USER, "-w", BOX_HOME, ...ENV, "-e", "TERM=xterm-256color", this.#name, "--", "/bin/sh", "-c", `${PRELUDE}exec "\${SHELL:-/bin/sh}" -l`],
      { tty: true },
    );
    return openTerminal(argv, size, signal);
  }
}
