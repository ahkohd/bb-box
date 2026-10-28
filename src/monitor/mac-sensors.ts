import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { MAC_SENSORS_BINARY, MAC_SENSORS_DIGEST } from "./mac-sensors-binary.ts";

const READING_TIMEOUT_MS = 3000;

export interface MacSensors {
  cpuTempC: number | null;
  gpuTempC: number | null;
  cpuWatts: number | null;
  gpuWatts: number | null;
  gpuPercent: number | null;
}

function finiteOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

export function parseSensorOutput(source: string): MacSensors | null {
  try {
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed !== "object" || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    return {
      cpuTempC: finiteOrNull(value.cpuTempC, 150),
      gpuTempC: finiteOrNull(value.gpuTempC, 150),
      cpuWatts: finiteOrNull(value.cpuWatts, 1000),
      gpuWatts: finiteOrNull(value.gpuWatts, 1000),
      gpuPercent: finiteOrNull(value.gpuPercent, 100),
    };
  } catch {
    return null;
  }
}

let helperPath: Promise<string | null> | null = null;

const HELPER_DIRECTORY = join(homedir(), "Library", "Caches", "bb-box");
const WRITABLE_BY_OTHERS = 0o022;

async function ownedAndPrivate(path: string, kind: "file" | "directory"): Promise<boolean> {
  try {
    const stats = await lstat(path);
    const rightKind = kind === "file" ? stats.isFile() : stats.isDirectory();
    return rightKind && stats.uid === process.getuid?.() && (stats.mode & WRITABLE_BY_OTHERS) === 0;
  } catch {
    return false;
  }
}

async function holdsHelper(path: string): Promise<boolean> {
  if (!(await ownedAndPrivate(path, "file"))) return false;
  try {
    const digest = createHash("sha256").update(await readFile(path)).digest("hex");
    return digest === MAC_SENSORS_DIGEST;
  } catch {
    return false;
  }
}

const HELPER_NAME = `bb-box-sensors-${MAC_SENSORS_DIGEST.slice(0, 16)}`;

const UNUSED_HELPER_AGE_MS = 24 * 60 * 60_000;

async function removeUnusedHelpers(): Promise<void> {
  const names = await readdir(HELPER_DIRECTORY).catch(() => []);
  await Promise.all(names
    .filter((name) => name.startsWith("bb-box-sensors-") && name !== HELPER_NAME)
    .map(async (name) => {
      const path = join(HELPER_DIRECTORY, name);
      const stats = await lstat(path).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > UNUSED_HELPER_AGE_MS) await rm(path, { force: true }).catch(() => undefined);
    }));
}

async function writeHelper(): Promise<string | null> {
  await mkdir(HELPER_DIRECTORY, { recursive: true, mode: 0o700 }).catch(() => undefined);
  if (!(await ownedAndPrivate(HELPER_DIRECTORY, "directory"))) return null;
  await removeUnusedHelpers();
  const path = join(HELPER_DIRECTORY, HELPER_NAME);
  if (await holdsHelper(path)) return path;
  const partial = `${path}.${process.pid}.${Date.now()}.partial`;
  try {
    await writeFile(partial, Buffer.from(MAC_SENSORS_BINARY, "base64"), { mode: 0o700, flag: "wx" });
    await rename(partial, path);
    return (await holdsHelper(path)) ? path : null;
  } catch {
    await rm(partial, { force: true });
    return null;
  }
}

export interface SensorHelper {
  request(timeoutMs: number): Promise<string | null>;
  stop(): void;
}

export function startHelper(path: string, onExit: () => void = () => undefined): SensorHelper {
  const child = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting: Array<(line: string | null) => void> = [];
  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    for (const resolve of waiting.splice(0)) resolve(null);
    onExit();
  };
  const stop = () => {
    child.kill("SIGKILL");
    finish();
  };
  child.on("exit", finish);
  child.on("error", finish);
  child.stdin?.on("error", finish);
  if (child.stdout) createInterface({ input: child.stdout }).on("line", (line) => waiting.shift()?.(line));
  child.unref();
  (child.stdin as unknown as Socket | null)?.unref();
  (child.stdout as unknown as Socket | null)?.unref();
  return {
    request(timeoutMs) {
      if (exited || !child.stdin) return Promise.resolve(null);
      return new Promise((resolve) => {
        const timer = setTimeout(stop, timeoutMs);
        waiting.push((line) => {
          clearTimeout(timer);
          resolve(line);
        });
        child.stdin.write("\n");
      });
    },
    stop,
  };
}

let runningHelper: SensorHelper | null = null;
let lifetime = 0;

export function stopMacSensors(): void {
  lifetime += 1;
  runningHelper?.stop();
  runningHelper = null;
}

async function helperFor(signal: AbortSignal): Promise<SensorHelper | null> {
  if (runningHelper) return runningHelper;
  const requestedIn = lifetime;
  helperPath ??= writeHelper().catch(() => null).then((path) => {
    if (path === null) helperPath = null;
    return path;
  });
  const path = await helperPath;
  if (path === null || signal.aborted || lifetime !== requestedIn) return null;
  if (runningHelper) return runningHelper;
  const helper = startHelper(path, () => {
    if (runningHelper !== helper) return;
    runningHelper = null;
    helperPath = null;
  });
  runningHelper = helper;
  return helper;
}

export async function readMacSensors(signal: AbortSignal): Promise<MacSensors | null> {
  if (platform() !== "darwin" || arch() !== "arm64") return null;
  try {
    const helper = await helperFor(signal);
    const line = helper ? await helper.request(READING_TIMEOUT_MS) : null;
    return line === null ? null : parseSensorOutput(line);
  } catch {
    return null;
  }
}
