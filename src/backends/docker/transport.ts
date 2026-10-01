// A Docker box's CommandTransport: `docker exec` as the box user, through
// the same docker CLI the backend uses, so it needs no network path to the
// box, over the local socket or ssh:// alike (031).
//
// sshd gives an LXC box's commands the box user's environment: PAM reads
// /etc/environment, and bash reads ~/.bashrc, which reads the display path's
// settings. `docker exec` gives only the image's environment, so each script
// starts with a prelude that reads both files.

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
import type { DockerCli } from "./cli.ts";

export const BOX_USER = "box";
export const BOX_HOME = `/home/${BOX_USER}`;

const PRELUDE =
  "set -a; [ ! -r /etc/environment ] || . /etc/environment; " +
  "[ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a; ";

/** What docker says when the command never ran in the container. */
const NOT_RUN =
  /Error response from daemon:|Cannot connect to the Docker daemon|error during connect|failed to connect to the docker API|No such container|is not running/i;

export class DockerTransport implements CommandTransport {
  readonly #cli: DockerCli;
  readonly #container: string;
  readonly #line: CommandLine;

  /** `container` is its name or ID on the backend's Docker host. */
  constructor(cli: DockerCli, container: string) {
    this.#cli = cli;
    this.#container = container;
    this.#line = new CommandLine({ argv: (script) => this.#exec(["/bin/sh", "-c", PRELUDE + script]) });
  }

  /** `docker exec` of `command` as the box user, in the box user's home, with stdin open. */
  #exec(command: readonly string[]): [string, ...string[]] {
    return this.#cli.argv([
      "exec", "-i",
      "-u", BOX_USER,
      "-w", BOX_HOME,
      "-e", "SHELL=/bin/bash",
      "-e", `USER=${BOX_USER}`,
      "-e", `LOGNAME=${BOX_USER}`,
      "-e", "LANG=C.UTF-8",
      this.#container,
      ...command,
    ]);
  }

  #unreachable(): TransportError {
    return new TransportError("unreachable", `The box ${this.#container} did not answer through docker exec.`);
  }

  /**
   * When docker could not run the script, its CLI exits non-zero and says why
   * on stderr. A script can fail the same way, so a probe decides.
   */
  async #reachable(result: { exitCode: number | null; timedOut: boolean; stderr?: string }, signal?: AbortSignal): Promise<void> {
    const suspect = result.timedOut || (result.exitCode !== 0 && (result.stderr === undefined || NOT_RUN.test(result.stderr)));
    if (suspect && !(await this.probe(signal))) throw this.#unreachable();
  }

  probe(signal?: AbortSignal): Promise<boolean> {
    return this.#line.probe(signal);
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    const result = await this.#line.run(script, options);
    await this.#reachable(result, options.signal);
    return result;
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
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
    try {
      await this.#line.writeFile(path, data, options);
    } catch (error) {
      if (!(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    try {
      return await this.#line.readFile(path, options);
    } catch (error) {
      if (!(error instanceof Error && /larger than/.test(error.message)) && !(await this.probe(options.signal))) throw this.#unreachable();
      throw error;
    }
  }

  /** A route to `port` inside the box, carried by socat under `docker exec`. */
  async route(port: number): Promise<Route> {
    return { type: "command", argv: this.#exec(["socat", "-", `TCP:127.0.0.1:${port}`]) };
  }

  /**
   * Runs `script` in the box user's shell with its stdin and stdout as the
   * channel. Closing the channel stops the docker CLI, and the daemon then
   * closes the script's stdin.
   */
  spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    return openRoute({ type: "command", argv: this.#exec(["/bin/sh", "-c", `${PRELUDE}exec "\${SHELL:-/bin/sh}" -c ${quote(script)}`]) }, signal);
  }

  /** The box user's login shell through `docker exec -it`, on a PTY here. docker passes the size on. */
  terminal(size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
    const argv = this.#cli.argv([
      "exec", "-it",
      "-u", BOX_USER,
      "-w", BOX_HOME,
      "-e", "SHELL=/bin/bash",
      "-e", `USER=${BOX_USER}`,
      "-e", `LOGNAME=${BOX_USER}`,
      "-e", "LANG=C.UTF-8",
      "-e", "TERM=xterm-256color",
      this.#container,
      "/bin/sh", "-c", `${PRELUDE}exec "\${SHELL:-/bin/sh}" -l`,
    ]);
    return openTerminal(argv, size, signal);
  }
}
