import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { DriverError } from "./driver.ts";
import { runProgram, type Runner } from "./simctl.ts";

export const ANDROID_SDK = "/opt/android-sdk";
export const FIREWALL_PROGRAM = "/usr/local/bin/bb-box-device-firewall";
export const EMULATOR_SERIAL = "emulator-5554";
export const CONSOLE_PORT = 5554;
export const GRPC_PORT = 8554;
export const EMULATOR_UNIT = "bb-box-emulator@.service";
export const STOP_WAIT_MS = 60_000;
export const UNSAVED_PREFIX = "emulator-unsaved-";
export const KEPT_DISCOVERY = "emulator-discovery.ini";
const COMMAND_MS = 30_000;
const POLL_MS = 200;
const LOG_MOST_BYTES = 1024 * 1024;

export interface RunningEmulator {
  readonly pid: number;
  readonly avd: string;
  readonly grpcPort: number;
  readonly token: string | null;
  readonly discovery: string | null;
}

export interface HostProcess {
  readonly pid: number;
  readonly argv: readonly string[];
}

export type EmulatorManager = "systemd" | "detached";

export type EmulatorControl = Pick<Emulator, "running" | "start" | "waitRunning" | "waitBooted" | "snapshotLoaded" | "stop" | "alive" | "shell" | "adbRun">;

export interface EmulatorOptions {
  readonly dir: string;
  readonly sdk?: string;
  readonly firewall?: string;
  readonly home?: string;
  readonly run?: Runner;
  readonly alive?: (pid: number) => boolean;
  readonly manager?: () => Promise<EmulatorManager>;
  readonly processes?: () => Promise<readonly HostProcess[]>;
  readonly log: (line: string) => void;
}

export function emulatorFlags(avd: string, cold: boolean): readonly string[] {
  return [
    "-avd",
    avd,
    "-port",
    String(CONSOLE_PORT),
    "-grpc",
    String(GRPC_PORT),
    "-grpc-use-token",
    "-gpu",
    "swiftshader_indirect",
    "-no-window",
    "-no-audio",
    "-no-boot-anim",
    ...(cold ? ["-no-snapshot-load"] : []),
  ];
}

export function emulatorUnit(sdk: string, firewall: string): string {
  const adb = `${sdk}/platform-tools/adb`;
  return `[Unit]
Description=bb-box: the Android emulator, AVD %i

[Service]
Type=simple
Environment=ANDROID_HOME=${sdk} ANDROID_SDK_ROOT=${sdk}
EnvironmentFile=-%h/.bb-box/device/emulator-boot.env
ExecStartPre=${firewall} check
ExecStart=${sdk}/emulator/emulator ${emulatorFlags("%i", false).join(" ")} $BB_BOX_EMULATOR_BOOT
ExecStop=/bin/sh -c 'if ${adb} -s ${EMULATOR_SERIAL} emu kill >/dev/null 2>&1; then while kill -0 $MAINPID 2>/dev/null; do sleep 0.1; done; rm -f %h/.bb-box/device/${UNSAVED_PREFIX}%i; fi; while kill -0 $MAINPID 2>/dev/null; do sleep 0.1; done'
TimeoutStopSec=${STOP_WAIT_MS / 1000}
KillMode=mixed
Restart=no
StandardOutput=truncate:%h/.bb-box/device/emulator.log
StandardError=inherit
`;
}

export function discoveryValues(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  return values;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function processesOnHost(): Promise<readonly HostProcess[]> {
  const names = await readdir("/proc").catch(() => [] as string[]);
  const found: HostProcess[] = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const argv = (await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "")).split("\0").filter(Boolean);
    if (argv.length) found.push({ pid: Number(name), argv });
  }
  return found;
}

function flagValue(argv: readonly string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  return at >= 0 ? (argv[at + 1] ?? null) : null;
}

function isEmulatorProgram(argv: readonly string[]): boolean {
  return /^(qemu-system-|emulator$)/.test(basename(argv[0] ?? ""));
}

export function emulatorOnConsolePort(processes: readonly HostProcess[]): { readonly pid: number; readonly avd: string } | null {
  const emulators = processes.filter((each) => isEmulatorProgram(each.argv) && flagValue(each.argv, "-port") === String(CONSOLE_PORT) && flagValue(each.argv, "-avd"));
  const chosen = emulators.find((each) => basename(each.argv[0]!).startsWith("qemu-system-")) ?? emulators[0];
  return chosen ? { pid: chosen.pid, avd: flagValue(chosen.argv, "-avd")! } : null;
}

async function systemdOrDetached(): Promise<EmulatorManager> {
  const ran = await runProgram("systemctl", ["--user", "show-environment"], { timeoutMs: 5_000 });
  return ran.code === 0 ? "systemd" : "detached";
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function words(ran: { readonly stdout: string; readonly stderr: string }): string {
  return (ran.stderr.trim() || ran.stdout.trim()).split("\n").slice(-3).join(" ");
}

export class Emulator {
  readonly #options: EmulatorOptions;
  readonly #sdk: string;
  readonly #home: string;
  readonly #run: Runner;
  readonly #alive: (pid: number) => boolean;
  readonly #processes: () => Promise<readonly HostProcess[]>;
  #manager: EmulatorManager | null = null;
  #saidUndiscovered: number | null = null;

  constructor(options: EmulatorOptions) {
    this.#options = options;
    this.#sdk = options.sdk ?? ANDROID_SDK;
    this.#home = options.home ?? homedir();
    this.#run = options.run ?? runProgram;
    this.#alive = options.alive ?? pidAlive;
    this.#processes = options.processes ?? processesOnHost;
  }

  get adb(): string {
    return join(this.#sdk, "platform-tools", "adb");
  }

  get log(): string {
    return join(this.#options.dir, "emulator.log");
  }

  #discoveryDirs(): readonly string[] {
    const uid = process.getuid?.() ?? 0;
    const user = userInfo().username;
    return [...new Set([process.env.XDG_RUNTIME_DIR, `/run/user/${uid}`, join(this.#home, ".android"), `/tmp/android-${user}`].filter((dir): dir is string => !!dir))].map((dir) =>
      join(dir, "avd", "running"),
    );
  }

  get keptDiscovery(): string {
    return join(this.#options.dir, KEPT_DISCOVERY);
  }

  async running(): Promise<RunningEmulator | null> {
    const discovered = await this.#discovered();
    if (discovered) {
      await this.#keepDiscovery(discovered);
      return discovered;
    }
    const undiscovered = (await this.#fromKeptDiscovery()) ?? (await this.#onConsolePort());
    if (undiscovered && this.#saidUndiscovered !== undiscovered.pid) {
      this.#saidUndiscovered = undiscovered.pid;
      this.#options.log(
        undiscovered.token
          ? `emulator: ${undiscovered.avd} runs as process ${undiscovered.pid} without its discovery file; bb-box reaches it by its own copy of that file`
          : `emulator: ${undiscovered.avd} runs as process ${undiscovered.pid} on console port ${CONSOLE_PORT} without its discovery file, and bb-box has no copy of it, so its gRPC token is unknown`,
      );
    }
    return undiscovered;
  }

  async #keepDiscovery(running: RunningEmulator): Promise<void> {
    const text = `pid=${running.pid}\navd.name=${running.avd}\ngrpc.port=${running.grpcPort}\ngrpc.token=${running.token}\n`;
    if ((await readFile(this.keptDiscovery, "utf8").catch(() => null)) === text) return;
    await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
    await writeFile(`${this.keptDiscovery}.new`, text, { mode: 0o600 });
    await rename(`${this.keptDiscovery}.new`, this.keptDiscovery);
  }

  async #fromKeptDiscovery(): Promise<RunningEmulator | null> {
    const values = discoveryValues(await readFile(this.keptDiscovery, "utf8").catch(() => ""));
    const pid = Number(values.get("pid"));
    const avd = values.get("avd.name");
    const token = values.get("grpc.token");
    if (!pid || !avd || !token || !this.#alive(pid)) return null;
    const emulator = (await this.#processes()).find((each) => each.pid === pid);
    if (!emulator || !isEmulatorProgram(emulator.argv) || flagValue(emulator.argv, "-avd") !== avd) return null;
    return { pid, avd, grpcPort: Number(values.get("grpc.port") ?? GRPC_PORT), token, discovery: null };
  }

  async #onConsolePort(): Promise<RunningEmulator | null> {
    const found = emulatorOnConsolePort(await this.#processes());
    return found && this.#alive(found.pid) ? { ...found, grpcPort: GRPC_PORT, token: null, discovery: null } : null;
  }

  async #discovered(): Promise<RunningEmulator | null> {
    let found: RunningEmulator | null = null;
    for (const dir of this.#discoveryDirs()) {
      const names = await readdir(dir).catch(() => [] as string[]);
      for (const name of names) {
        const match = /^pid_(\d+)\.ini$/.exec(name);
        if (!match) continue;
        const path = join(dir, name);
        const pid = Number(match[1]);
        if (!this.#alive(pid)) {
          await rm(path, { force: true });
          this.#options.log(`emulator: removed the discovery file of process ${pid}, which has ended`);
          continue;
        }
        const values = discoveryValues(await readFile(path, "utf8").catch(() => ""));
        const avd = values.get("avd.name");
        const token = values.get("grpc.token");
        const grpcPort = Number(values.get("grpc.port") ?? GRPC_PORT);
        if (avd && token && !found) found = { pid, avd, grpcPort, token, discovery: path };
      }
    }
    return found;
  }

  async #managerOf(): Promise<EmulatorManager> {
    this.#manager ??= await (this.#options.manager ?? systemdOrDetached)();
    return this.#manager;
  }

  async firewallInPlace(): Promise<string | null> {
    const ran = await this.#run(this.#options.firewall ?? FIREWALL_PROGRAM, ["check"], { timeoutMs: COMMAND_MS });
    return ran.code === 0 ? null : words(ran) || "bb-box-device-firewall check failed";
  }

  async #freshConsoleToken(): Promise<void> {
    await writeFile(join(this.#home, ".emulator_console_auth_token"), randomBytes(24).toString("base64url"), { mode: 0o600 });
  }

  async #bootFlags(cold: boolean): Promise<void> {
    const file = join(this.#options.dir, "emulator-boot.env");
    if (cold) await writeFile(file, `BB_BOX_EMULATOR_BOOT=-no-snapshot-load\n`, { mode: 0o600 });
    else await rm(file, { force: true });
  }

  unsavedMarker(avd: string): string {
    return join(this.#options.dir, `${UNSAVED_PREFIX}${avd}`);
  }

  async endedUnsaved(avd: string): Promise<boolean> {
    return access(this.unsavedMarker(avd)).then(
      () => true,
      () => false,
    );
  }

  async #writeUnit(): Promise<void> {
    const dir = join(this.#home, ".config", "systemd", "user");
    const path = join(dir, EMULATOR_UNIT);
    const unit = emulatorUnit(this.#sdk, this.#options.firewall ?? FIREWALL_PROGRAM);
    if ((await readFile(path, "utf8").catch(() => null)) === unit) return;
    await mkdir(dir, { recursive: true });
    await writeFile(path, unit);
    await this.#run("systemctl", ["--user", "daemon-reload"], { timeoutMs: COMMAND_MS });
  }

  async start(avd: string, options: { readonly cold: boolean; readonly signal: AbortSignal }): Promise<{ readonly cold: boolean; readonly unsaved: boolean }> {
    const refused = await this.firewallInPlace();
    if (refused) throw new EmulatorRefused("firewall-missing", `The device's firewall is not in place, so the emulator does not start: ${refused}. Run sudo systemctl restart bb-box-device-firewall in the box, or acquire another box.`);
    await mkdir(this.#options.dir, { recursive: true, mode: 0o700 });
    const unsaved = await this.endedUnsaved(avd);
    const cold = options.cold || unsaved;
    await writeFile(this.unsavedMarker(avd), "", { mode: 0o600 });
    await this.#freshConsoleToken();
    await this.#run(this.adb, ["start-server"], { timeoutMs: COMMAND_MS });
    if ((await this.#managerOf()) === "systemd") {
      await this.#writeUnit();
      await this.#bootFlags(cold);
      const unit = `bb-box-emulator@${avd}.service`;
      await this.#run("systemctl", ["--user", "reset-failed", unit], { timeoutMs: COMMAND_MS });
      const ran = await this.#run("systemctl", ["--user", "start", unit], { timeoutMs: COMMAND_MS, signal: options.signal });
      await this.#bootFlags(false);
      if (ran.code !== 0) throw new EmulatorRefused("emulator-failed", `systemd did not start the emulator for ${avd}: ${words(ran)}`);
      return { cold, unsaved };
    }
    await this.#trimLog();
    const log = await open(this.log, "w", 0o600);
    const child = spawn(join(this.#sdk, "emulator", "emulator"), [...emulatorFlags(avd, cold)], {
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, ANDROID_HOME: this.#sdk, ANDROID_SDK_ROOT: this.#sdk },
    });
    child.unref();
    await log.close();
    return { cold, unsaved };
  }

  async #trimLog(): Promise<void> {
    await rm(`${this.log}.old`, { force: true });
    const text = await readFile(this.log).catch(() => null);
    if (text && text.byteLength > LOG_MOST_BYTES) await writeFile(`${this.log}.old`, text.subarray(text.byteLength - LOG_MOST_BYTES));
  }

  async waitRunning(avd: string, signal: AbortSignal): Promise<RunningEmulator> {
    while (!signal.aborted) {
      const found = await this.#discovered();
      if (found?.avd === avd) {
        await this.#keepDiscovery(found);
        return found;
      }
      if ((await this.#managerOf()) === "systemd" && !(await this.unitActive(avd))) throw new EmulatorRefused("emulator-failed", `The emulator for ${avd} ended as it started. ${await this.lastLines()}`);
      await wait(POLL_MS, signal);
    }
    throw new EmulatorRefused("boot-failed", `The emulator for ${avd} did not start in time. ${await this.lastLines()}`);
  }

  async unitActive(avd: string): Promise<boolean> {
    const ran = await this.#run("systemctl", ["--user", "is-active", `bb-box-emulator@${avd}.service`], { timeoutMs: COMMAND_MS });
    return ["active", "activating", "reloading", "deactivating"].includes(ran.stdout.trim());
  }

  async lastLines(): Promise<string> {
    const text = await readFile(this.log, "utf8").catch(() => "");
    const lines = text.trim().split("\n").filter((line) => /ERROR|FATAL|error|failed/i.test(line)).slice(-3);
    return lines.length ? `Its log says: ${lines.join(" ")}` : "";
  }

  async shell(command: string, options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<string> {
    const ran = await this.#run(this.adb, ["-s", EMULATOR_SERIAL, "shell", command], { timeoutMs: options.timeoutMs ?? COMMAND_MS, signal: options.signal });
    if (ran.code !== 0) throw new DriverError("failed", `adb shell ${command} failed: ${words(ran)}`);
    return ran.stdout.replace(/\r/g, "");
  }

  async adbRun(args: readonly string[], options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}): Promise<{ readonly code: number; readonly output: string }> {
    const ran = await this.#run(this.adb, ["-s", EMULATOR_SERIAL, ...args], { timeoutMs: options.timeoutMs ?? COMMAND_MS, signal: options.signal });
    return { code: ran.code, output: `${ran.stdout}\n${ran.stderr}`.replace(/\r/g, "").trim() };
  }

  async booted(signal?: AbortSignal): Promise<boolean> {
    const ran = await this.#run(this.adb, ["-s", EMULATOR_SERIAL, "shell", "getprop", "sys.boot_completed"], { timeoutMs: 5_000, signal });
    return ran.code === 0 && ran.stdout.trim() === "1";
  }

  async waitBooted(avd: string, pid: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.booted(signal)) return;
      if (!this.#alive(pid)) throw new EmulatorRefused("emulator-failed", `The emulator for ${avd} ended before Android booted. ${await this.lastLines()}`);
      await wait(POLL_MS, signal);
    }
    throw new EmulatorRefused("boot-failed", `Android on ${avd} did not finish booting in time. ${await this.lastLines()}`);
  }

  async snapshotLoaded(): Promise<boolean | null> {
    const text = await readFile(this.log, "utf8").catch(() => null);
    if (text === null) return null;
    return /Successfully loaded snapshot/.test(text);
  }

  async stop(running: RunningEmulator, signal: AbortSignal): Promise<void> {
    const bySystemd = (await this.#managerOf()) === "systemd" && (await this.unitActive(running.avd));
    let answered = false;
    if (bySystemd) {
      const ran = await this.#run("systemctl", ["--user", "stop", `bb-box-emulator@${running.avd}.service`], { timeoutMs: STOP_WAIT_MS + COMMAND_MS, signal });
      if (ran.code !== 0) this.#options.log(`emulator: systemd did not stop ${running.avd} cleanly: ${words(ran)}`);
    } else {
      answered = (await this.#run(this.adb, ["-s", EMULATOR_SERIAL, "emu", "kill"], { timeoutMs: COMMAND_MS, signal })).code === 0;
    }
    const until = Date.now() + STOP_WAIT_MS;
    while (this.#alive(running.pid) && Date.now() < until && !signal.aborted) await wait(100, signal);
    if (answered && !this.#alive(running.pid)) await rm(this.unsavedMarker(running.avd), { force: true });
    if (this.#alive(running.pid)) {
      this.#options.log(`emulator: ${running.avd} (process ${running.pid}) did not end within ${STOP_WAIT_MS / 1000} s of being asked; killing it`);
      try {
        process.kill(running.pid, "SIGKILL");
      } catch {}
    }
    if (running.discovery) await rm(running.discovery, { force: true });
    await rm(this.keptDiscovery, { force: true });
  }

  alive(pid: number): boolean {
    return this.#alive(pid);
  }
}

export class EmulatorRefused extends DriverError {
  readonly failure: "firewall-missing" | "emulator-failed" | "boot-failed";
  constructor(failure: "firewall-missing" | "emulator-failed" | "boot-failed", words: string) {
    super("failed", words);
    this.failure = failure;
  }
}
