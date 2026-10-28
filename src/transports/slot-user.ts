import { quote } from "./process.ts";
import type { ByteChannel, CommandTransport, RunOptions, RunResult, StreamOptions } from "./types.ts";

const READ_MARK = "bb-box-read:";

export function asSlotUser(user: string, script: string): string {
  return `sudo -n -H -u ${quote(user)} -- /bin/zsh -c ${quote(`cd ~ 2>/dev/null || exit 1\n${script}`)}`;
}

function inHome(path: string): string {
  return `p=${quote(path)}; case "$p" in /*) ;; *) p="$HOME/$p" ;; esac`;
}

export class SlotUserTransport implements CommandTransport {
  readonly #host: CommandTransport;
  readonly #user: string;

  constructor(host: CommandTransport, user: string) {
    this.#host = host;
    this.#user = user;
  }

  async probe(signal?: AbortSignal): Promise<boolean> {
    try {
      return (await this.#host.run(asSlotUser(this.#user, "true"), { timeoutMs: 20_000, signal })).exitCode === 0;
    } catch {
      return false;
    }
  }

  run(script: string, options: RunOptions = {}): Promise<RunResult> {
    return this.#host.run(asSlotUser(this.#user, script), options);
  }

  stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return this.#host.stream(asSlotUser(this.#user, script), options);
  }

  async writeFile(path: string, data: Uint8Array, options: { mode?: string; signal?: AbortSignal } = {}): Promise<void> {
    const mode = options.mode ? ` && chmod ${quote(options.mode)} "$p"` : "";
    const result = await this.run(`${inHome(path)}; mkdir -p "$(dirname "$p")" && cat > "$p"${mode}`, { stdin: data, timeoutMs: 600_000, signal: options.signal });
    if (result.exitCode !== 0) throw new Error(`Could not write ${path} as ${this.#user}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    const result = await this.run(`${inHome(path)}; size=$(wc -c < "$p") || exit 1; [ "$size" -le ${options.maxBytes} ] || { echo "$p is larger than ${options.maxBytes} bytes" >&2; exit 3; }; printf '${READ_MARK}'; base64 < "$p"`, {
      timeoutMs: 600_000,
      signal: options.signal,
      maxOutputBytes: Math.ceil(options.maxBytes * 1.4) + 1024,
    });
    if (result.exitCode !== 0) throw new Error(`Could not read ${path} as ${this.#user}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    const at = result.stdout.indexOf(READ_MARK);
    return new Uint8Array(Buffer.from(result.stdout.slice(at + READ_MARK.length).replace(/\s+/g, ""), "base64"));
  }

  spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    if (!this.#host.spawn) throw new Error("The host's transport cannot start a long-running command.");
    return this.#host.spawn(asSlotUser(this.#user, script), signal);
  }
}
