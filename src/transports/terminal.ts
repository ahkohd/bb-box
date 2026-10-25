// A terminal in a box, with its PTY on BB's server: the transport's own
// command line (`ssh -tt`, `docker exec -it`) runs under `script`, which
// gives it a PTY and relays that PTY over its own stdin and stdout. Nothing
// runs in the box, so every guest OS has one. The first line of the output
// is the PTY's path, from `tty`; a resize is `stty` on that path here, which
// SIGWINCHes the command, and ssh and docker pass the size on to the shell.

import { execFile, spawn } from "node:child_process";
import { timedSpawn } from "./spawns.ts";
import { quote } from "./process.ts";
import type { Terminal, TerminalSize } from "./types.ts";

/** How long the PTY's path may take to arrive. */
const OPEN_MS = 10_000;
const LARGEST = 1_000;
const HIGH_WATER_BYTES = 256 * 1024;

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalError";
  }
}

/** A size `stty` takes: whole numbers from 1 to 1000; 80 by 24 for anything else. */
export function clampSize(size: TerminalSize): TerminalSize {
  const whole = (value: number, fallback: number) => (Number.isFinite(value) && value >= 1 ? Math.min(LARGEST, Math.round(value)) : fallback);
  return { cols: whole(size.cols, 80), rows: whole(size.rows, 24) };
}

const darwin = process.platform === "darwin";

/**
 * macOS's `script` gives up when its stdin is a socket, as Node's pipe to a
 * child is: "tcgetattr/ioctl: Operation not supported on socket" (#914).
 * util-linux's takes one. So on macOS this Perl, which macOS has, gives
 * `script` a pipe: it copies its own stdin into the pipe, and exits with
 * `script`'s status when `script` ends. On SIGTERM or SIGHUP it kills
 * `script`, which hangs the PTY up, as killing `script` itself does.
 */
const PIPE_RELAY =
  `my $pid; my $status = sub { $? & 127 ? 128 + ($? & 127) : $? >> 8 }; ` +
  `$SIG{CHLD} = sub { exit $status->() if waitpid(-1, 0) > 0 }; ` +
  `$SIG{TERM} = $SIG{HUP} = sub { $SIG{CHLD} = "DEFAULT"; kill "KILL", $pid if $pid; exit 129 }; ` +
  `pipe(my $r, my $w) or die "pipe: $!\\n"; $pid = fork; defined $pid or die "fork: $!\\n"; ` +
  `if (!$pid) { close $w; open(STDIN, "<&", $r) or die "stdin: $!\\n"; close $r; exec @ARGV or die "exec $ARGV[0]: $!\\n" } ` +
  `close $r; $SIG{PIPE} = "IGNORE"; my $buf; while (sysread STDIN, $buf, 65536) { defined(syswrite $w, $buf) or last } ` +
  `close $w; waitpid $pid, 0; exit $status->()`;

/**
 * `script` runs `inner` in /bin/sh on a PTY of its own, its stdin a pipe on
 * macOS. util-linux and BSD spell it differently. src/host/msb.ts runs its
 * terminals the same way.
 */
export function ptyArgv(inner: string, platform: NodeJS.Platform = process.platform): [string, ...string[]] {
  return platform === "darwin" ? ["perl", "-e", PIPE_RELAY, "script", "-q", "/dev/null", "/bin/sh", "-c", inner] : ["script", "-qfc", inner, "/dev/null"];
}

/** What ends a ptyArgv run at once, hanging its PTY up: on macOS the relay passes SIGTERM on as a kill, which SIGKILL would not. */
export const HANG_UP: NodeJS.Signals = darwin ? "SIGTERM" : "SIGKILL";

function stty(pty: string, size: TerminalSize): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("stty", [darwin ? "-f" : "-F", pty, "cols", String(size.cols), "rows", String(size.rows)], (error, _stdout, stderr) => {
      if (error) reject(new TerminalError(`Resizing the terminal failed: ${String(stderr).trim() || error.message}`));
      else resolve();
    });
  });
}

/**
 * Runs `argv` on a PTY here, at `size`. Resolves once the PTY exists. Closing
 * the terminal kills `script` outright: a SIGTERM would make it write
 * "Session terminated" into the stream and wait, while a kill hangs the
 * command up at once, so ssh ends and the box's shell gets SIGHUP.
 */
export function openTerminal(argv: readonly [string, ...string[]], size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
  if (signal?.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new TerminalError("Opening the terminal was cancelled."));
  const first = clampSize(size);
  const inner = `tty; stty cols ${first.cols} rows ${first.rows}; exec ${argv.map(quote).join(" ")}`;
  const [binary, ...args] = ptyArgv(inner);
  return new Promise((resolve, reject) => {
    const child = timedSpawn(() => spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SHELL: "/bin/sh", TERM: "xterm-256color" } }), "terminal");
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    child.stdin.on("error", () => {
      // The shell may exit before it reads everything.
    });
    const exited = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
    const kill = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill(HANG_UP);
    };
    signal?.addEventListener("abort", kill, { once: true });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      kill();
      reject(error);
    };
    const timer = setTimeout(() => fail(new TerminalError("The terminal did not start within 10 s.")), OPEN_MS);
    child.once("error", (error) => fail(new TerminalError(`Cannot run ${binary} for the terminal: ${error.message}`)));

    // The first line is the PTY's path; the bytes after it are the terminal's.
    let head = Buffer.alloc(0);
    let pty: string | null = null;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let done = false;
    const deliver = (chunk: Buffer) => {
      if (done || !controller) return;
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if ((controller.desiredSize ?? 1) <= 0) child.stdout.pause();
    };
    const readable = new ReadableStream<Uint8Array>(
      {
        start(given) {
          controller = given;
        },
        pull() {
          child.stdout.resume();
        },
        cancel() {
          done = true;
          kill();
        },
      },
      { highWaterMark: HIGH_WATER_BYTES, size: (chunk) => chunk.byteLength },
    );
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => new Promise((written, failed) => child.stdin.write(chunk, (error) => (error ? failed(error) : written()))),
      close: () => new Promise((closed) => child.stdin.end(closed)),
      abort: () => {
        child.stdin.destroy();
      },
    });

    // Resizes run one at a time, and the latest asked for wins.
    let wanted: TerminalSize | null = null;
    let resizing: Promise<void> | null = null;
    const resize = (size: TerminalSize): Promise<void> => {
      wanted = clampSize(size);
      if (resizing) return resizing;
      resizing = (async () => {
        while (wanted && pty) {
          const next = wanted;
          wanted = null;
          await stty(pty, next);
        }
      })().finally(() => {
        resizing = null;
      });
      return resizing;
    };
    const terminal: Terminal = {
      readable,
      writable,
      resize,
      close: async () => {
        kill();
        await exited;
      },
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (pty) return deliver(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf(0x0a);
      if (end === -1) return;
      const line = head.subarray(0, end).toString("utf8").trim();
      const rest = head.subarray(end + 1);
      head = Buffer.alloc(0);
      if (!line.startsWith("/dev/")) return fail(new TerminalError(`The terminal gave no PTY: ${line || stderr.trim() || "no output"}`));
      pty = line;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      resolve(terminal);
      if (rest.length) deliver(Buffer.from(rest));
    });
    child.stdout.once("end", () => {
      void exited.then((code) => {
        if (!pty) return fail(new TerminalError(`The terminal ended before it started${code !== null ? ` (exit ${code})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
        if (done) return;
        done = true;
        controller?.close();
      });
    });
  });
}
