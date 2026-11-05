import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult } from "../src/transports/types.ts";

export const GUEST_TOOLS_HERE = ["sh", "bash", "flock", "setsid", "nohup", "base64", "tar"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0);

const SUDO_AS_ITSELF = '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n';

const STUB_TEMPLATE_SCRIPT = [
  "#!/bin/bash",
  "set -u",
  "step=$1",
  "kind=$2",
  'here=$(cd "$(dirname "$0")" && pwd)',
  'root=$(cd "$here/../../../.." && pwd)',
  'control=$root/control',
  'src=$here/../proxmox-lxc/template',
  "say() { printf '%s  %s\\n' \"$(date -u +%H:%M:%S)\" \"$*\"; }",
  'echo "$step $kind $$ $(pwd)" >> "$control/runs"',
  'case "$step" in',
  "  customize)",
  '    for file in build.env plugin-key.pub android-sdk-license; do [ ! -f "$src/$file" ] || cp "$src/$file" "$control/$file"; done',
  '    say "customize-base.sh"',
  '    [ ! -f "$control/customize-says" ] || cat "$control/customize-says"',
  '    while [ ! -e "$control/customize-exit" ]; do sleep 0.02; done',
  '    say "customized"',
  '    exit "$(cat "$control/customize-exit")" ;;',
  "  finalize)",
  '    say "finalize.sh"',
  '    while [ ! -e "$control/finalize-exit" ]; do sleep 0.02; done',
  '    if [ -f "$control/android-devices.json" ]; then mkdir -p "$root/usr/share/bb-box" && cp "$control/android-devices.json" "$root/usr/share/bb-box/"; fi',
  '    rm -rf "$(dirname "$here")"',
  '    say "finalized"',
  '    exit "$(cat "$control/finalize-exit")" ;;',
  "esac",
  "",
].join("\n");

let scriptsArchive: Buffer | null = null;

export function guestScriptsArchive(): Buffer {
  if (scriptsArchive) return scriptsArchive;
  const setup = mkdtempSync(join(tmpdir(), "boat-guest-setup-"));
  try {
    mkdirSync(join(setup, "boat"), { recursive: true });
    mkdirSync(join(setup, "proxmox-lxc/template"), { recursive: true });
    writeFileSync(join(setup, "boat/template.sh"), STUB_TEMPLATE_SCRIPT);
    writeFileSync(join(setup, "proxmox-lxc/template/pins.json"), "{}\n");
    scriptsArchive = execFileSync("tar", ["-czf", "-", "-C", setup, "boat", "proxmox-lxc"]);
    return scriptsArchive;
  } finally {
    rmSync(setup, { recursive: true, force: true });
  }
}

export interface GuestRun {
  readonly script: string;
  readonly exitCode: number | null;
  readonly stdout: string;
}

export class FakeBoatGuest {
  readonly root: string;
  readonly control: string;
  readonly ran: GuestRun[] = [];
  readonly #bin: string;
  #beforeRun: ((script: string) => Promise<void>) | null = null;
  #stdinHeld: ((script: string, stdin: Buffer | string | undefined) => Promise<Buffer | string | undefined>) | null = null;

  constructor(options: { readonly holdSteps?: boolean } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "boat-guest-"));
    this.control = join(this.root, "control");
    this.#bin = join(this.root, "bin");
    for (const dir of [this.control, this.#bin, join(this.root, "var/tmp"), join(this.root, "run")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(this.#bin, "sudo"), SUDO_AS_ITSELF);
    chmodSync(join(this.#bin, "sudo"), 0o755);
    if (!options.holdSteps) {
      this.finish("customize", 0);
      this.finish("finalize", 0);
    }
  }

  get buildDir(): string {
    return join(this.root, "var/tmp/bb-box-build");
  }

  get stateDir(): string {
    return join(this.root, "run/bb-box-build");
  }

  beforeEachRun(wait: ((script: string) => Promise<void>) | null): void {
    this.#beforeRun = wait;
  }

  holdStdin(wait: ((script: string, stdin: Buffer | string | undefined) => Promise<Buffer | string | undefined>) | null): void {
    this.#stdinHeld = wait;
  }

  finish(step: "customize" | "finalize", code: number): void {
    writeFileSync(join(this.control, `${step}-exit`), `${code}\n`);
  }

  runs(step?: "customize" | "finalize"): string[] {
    const path = join(this.control, "runs");
    const lines = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean) : [];
    return step ? lines.filter((line) => line.startsWith(`${step} `)) : lines;
  }

  controlFile(name: string): string | null {
    const path = join(this.control, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  jobPid(): number | null {
    const path = join(this.stateDir, "pid");
    const pid = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : NaN;
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  killJob(): void {
    const pid = this.jobPid();
    if (pid === null) return;
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
  }

  stagings(): GuestRun[] {
    return this.ran.filter((run) => run.script.includes("tar -xzf -"));
  }

  async run(script: string, options: { readonly stdin?: Buffer | string; readonly timeoutMs: number }): Promise<RunResult> {
    await this.#beforeRun?.(script);
    const local = script.replaceAll("/var/tmp/bb-box-build", this.buildDir).replaceAll("/run/bb-box-build", this.stateDir).replaceAll("/usr/share/bb-box/", `${this.root}/usr/share/bb-box/`);
    const started = Date.now();
    const child = spawn("sh", ["-c", local], { cwd: this.root, env: { ...process.env, PATH: `${this.#bin}:${process.env.PATH ?? ""}` }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.stdin.on("error", () => undefined);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    const ended = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
    const held = this.#stdinHeld;
    void (async () => {
      const stdin = held ? await held(script, options.stdin) : options.stdin;
      if (stdin !== undefined) child.stdin.write(stdin);
      child.stdin.end();
    })();
    const exitCode = await ended;
    clearTimeout(timer);
    this.ran.push({ script, exitCode, stdout });
    return { exitCode, stdout, stderr, timedOut: false, truncated: false, durationMs: Date.now() - started };
  }

  dispose(): void {
    this.killJob();
    rmSync(this.root, { recursive: true, force: true });
  }
}
