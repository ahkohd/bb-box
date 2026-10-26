import { execFile } from "node:child_process";
import { DriverError } from "./driver.ts";

export const XCRUN = "/usr/bin/xcrun";
const COMMAND_MS = 120_000;
const SPAWN_TRIES = 5;
const SPAWN_RETRY_MS = 1_000;
const UTF8 = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

export interface SimDevice {
  readonly udid: string;
  readonly name: string;
  readonly type: string;
  readonly runtime: string;
  readonly state: string;
  readonly available: boolean;
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstalledApp {
  readonly id: string;
  readonly name: string;
  readonly system: boolean;
}

export function installedApps(listed: unknown): readonly InstalledApp[] {
  if (typeof listed !== "object" || listed === null) return [];
  return Object.entries(listed as Record<string, Record<string, unknown>>).map(([id, info]) => {
    const name = [info?.CFBundleDisplayName, info?.CFBundleName].find((each): each is string => typeof each === "string" && each.trim() !== "");
    return { id, name: name?.trim() ?? id, system: info?.ApplicationType === "System" };
  });
}

export type Runner = (program: string, args: readonly string[], options: { readonly timeoutMs: number; readonly input?: string; readonly env?: Readonly<Record<string, string>>; readonly signal?: AbortSignal }) => Promise<Ran>;

export const runProgram: Runner = (program, args, options) =>
  new Promise((resolve) => {
    const child = execFile(
      program,
      [...args],
      { timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, signal: options.signal, env: { ...process.env, ...options.env } },
      (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error && code === 1 && !stderr ? error.message : "") });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function disabledLabels(printed: string): ReadonlySet<string> {
  return new Set([...printed.matchAll(/"([^"]+)" => (?:disabled|true)/g)].map((match) => match[1]!));
}

type SimctlOptions = { readonly timeoutMs?: number; readonly input?: string; readonly env?: Readonly<Record<string, string>>; readonly signal?: AbortSignal };

export class Simctl {
  readonly #xcrun: string;
  readonly #run: Runner;

  constructor(options: { readonly xcrun?: string; readonly run?: Runner } = {}) {
    this.#xcrun = options.xcrun ?? XCRUN;
    this.#run = options.run ?? runProgram;
  }

  async #simctl(args: readonly string[], options: SimctlOptions = {}): Promise<Ran> {
    return this.#run(this.#xcrun, ["simctl", ...args], { timeoutMs: options.timeoutMs ?? COMMAND_MS, ...options });
  }

  async #must(what: string, args: readonly string[], options: SimctlOptions = {}): Promise<string> {
    const ran = await this.#simctl(args, options);
    if (ran.code !== 0) throw new DriverError("failed", `simctl could not ${what}: ${(ran.stderr || ran.stdout).trim().split("\n").slice(-2).join(" ") || `exit code ${ran.code}`}`);
    return ran.stdout;
  }

  async devices(signal?: AbortSignal): Promise<SimDevice[]> {
    const text = await this.#must("list its devices", ["list", "devices", "--json"], { signal, timeoutMs: 30_000 });
    const listed = JSON.parse(text) as { devices?: Record<string, { udid: string; name: string; deviceTypeIdentifier?: string; state: string; isAvailable?: boolean }[]> };
    return Object.entries(listed.devices ?? {}).flatMap(([runtime, devices]) =>
      devices.map((device) => ({ udid: device.udid, name: device.name, type: device.deviceTypeIdentifier ?? "", runtime, state: device.state, available: device.isAvailable !== false })),
    );
  }

  async device(udid: string, signal?: AbortSignal): Promise<SimDevice | null> {
    return (await this.devices(signal)).find((device) => device.udid === udid) ?? null;
  }

  async boot(udid: string, signal?: AbortSignal): Promise<void> {
    const ran = await this.#simctl(["boot", udid], { signal });
    if (ran.code !== 0 && !/current state: Booted/i.test(ran.stderr)) throw new DriverError("failed", `simctl could not boot the device: ${ran.stderr.trim().split("\n").slice(-2).join(" ")}`);
    await this.#must("wait for the device to boot", ["bootstatus", udid, "-b"], { signal });
  }

  async shutdown(udid: string, signal?: AbortSignal): Promise<void> {
    const ran = await this.#simctl(["shutdown", udid], { signal });
    if (ran.code !== 0 && !/current state: Shutdown/i.test(ran.stderr)) throw new DriverError("failed", `simctl could not shut the device down: ${ran.stderr.trim().split("\n").slice(-2).join(" ")}`);
  }

  async reboot(udid: string, signal?: AbortSignal): Promise<void> {
    await this.shutdown(udid, signal);
    await this.boot(udid, signal);
  }

  async #spawn(udid: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    let last = "";
    for (let attempt = 1; attempt <= SPAWN_TRIES; attempt++) {
      const ran = await this.#simctl(["spawn", udid, ...args], { signal, timeoutMs: 30_000 });
      if (ran.code === 0) return ran.stdout;
      last = (ran.stderr || ran.stdout).trim();
      if (signal?.aborted) break;
      await wait(SPAWN_RETRY_MS);
    }
    throw new DriverError("failed", `simctl spawn ${args.join(" ")} failed ${SPAWN_TRIES} times: ${last}`);
  }

  async disabled(udid: string, signal?: AbortSignal): Promise<ReadonlySet<string>> {
    return disabledLabels(await this.#spawn(udid, ["launchctl", "print-disabled", "system"], signal));
  }

  async setService(udid: string, label: string, on: boolean, signal?: AbortSignal): Promise<void> {
    await this.#spawn(udid, ["launchctl", on ? "enable" : "disable", `system/${label}`], signal);
  }

  async ui(udid: string, option: "appearance" | "content_size", value?: string, signal?: AbortSignal): Promise<string> {
    const args = ["ui", udid, option, ...(value === undefined ? [] : [value])];
    return (await this.#must(value === undefined ? `read the device's ${option.replace("_", " ")}` : `set the device's ${option.replace("_", " ")} to ${value}`, args, { signal, timeoutMs: 30_000 })).trim();
  }

  async statusBar(udid: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
    return this.#must(args[0] === "list" ? "read the status bar's overrides" : args[0] === "clear" ? "clear the status bar's overrides" : "override the status bar", ["status_bar", udid, ...args], { signal, timeoutMs: 30_000 });
  }

  async location(udid: string, to: { readonly latitude: number; readonly longitude: number } | null, signal?: AbortSignal): Promise<void> {
    await this.#must(to ? "set the device's location" : "clear the device's location", ["location", udid, ...(to ? ["set", `${to.latitude},${to.longitude}`] : ["clear"])], { signal, timeoutMs: 30_000 });
  }

  async openUrl(udid: string, url: string, signal?: AbortSignal): Promise<void> {
    await this.#must(`open ${url}`, ["openurl", udid, url], { signal, timeoutMs: 30_000 });
  }

  async launch(udid: string, bundleId: string, signal?: AbortSignal): Promise<Ran> {
    return this.#simctl(["launch", udid, bundleId], { signal, timeoutMs: 60_000 });
  }

  async apps(udid: string, signal?: AbortSignal): Promise<readonly InstalledApp[]> {
    const listed = await this.#must("list the device's apps", ["listapps", udid], { signal, timeoutMs: 30_000 });
    const json = await this.#run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], { timeoutMs: 30_000, input: listed, signal });
    if (json.code !== 0) throw new DriverError("failed", `plutil could not read the device's list of apps: ${json.stderr.trim() || `exit code ${json.code}`}`);
    return installedApps(JSON.parse(json.stdout));
  }

  async install(udid: string, app: string, signal?: AbortSignal): Promise<void> {
    await this.#must(`install ${app}`, ["install", udid, app], { signal, timeoutMs: 300_000 });
  }

  async installed(udid: string, bundleId: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.#simctl(["get_app_container", udid, bundleId], { signal, timeoutMs: 30_000 })).code === 0;
  }

  async notifyState(udid: string, name: string, signal?: AbortSignal): Promise<number | null> {
    const printed = await this.#spawn(udid, ["notifyutil", "-g", name], signal);
    const value = Number(printed.trim().split(/\s+/).at(-1));
    return Number.isFinite(value) ? value : null;
  }

  async setClipboard(udid: string, text: string): Promise<void> {
    await this.#must("set the device's clipboard", ["pbcopy", udid], { input: text, env: UTF8, timeoutMs: 30_000 });
  }

  async clipboard(udid: string): Promise<string> {
    return this.#must("read the device's clipboard", ["pbpaste", udid], { env: UTF8, timeoutMs: 30_000 });
  }
}
