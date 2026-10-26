import { execFile } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect as connectSocket, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEVICE_PROTOCOL, DEVICE_SERVER_VERSION, isTestDevice, platformWord, type DeviceOffer, type DevicePlatform, type DeviceState, type OfferedDevice } from "../core/device.ts";
import { parseDeviceOffer } from "../core/device-parse.ts";
import { DriverError, type DeviceDriver, type VideoSource } from "./driver.ts";
import { EXITS, devicePaths, type DevicePaths } from "./paths.ts";
import { DeviceServer, placeholderState } from "./server.ts";
import { AndroidDriver } from "./android-driver.ts";
import { IosDriver } from "./ios-driver.ts";
import { TestDriver } from "./test-driver.ts";
import { deviceModel } from "../core/device.ts";

const IMAGE_RECORDS = ["/usr/share/bb-box/image.json", "/usr/local/share/bb-box/image.json"];
const CONNECT_WAIT_MS = 10_000;
const CONNECT_POLL_MS = 50;
const LAUNCHER = join(dirname(fileURLToPath(import.meta.url)), "bb-box-device.sh");

function log(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function offerOfImage(record: { readonly devices?: readonly { readonly runtime?: { readonly platform?: unknown } }[] }): unknown {
  const devices = record.devices;
  return devices?.length ? { platform: devices[0]?.runtime?.platform, devices } : null;
}

async function readOffer(paths: DevicePaths): Promise<DeviceOffer | string> {
  const own = await readFile(paths.devices, "utf8").catch(() => null);
  const sources: { readonly from: string; readonly value: () => unknown }[] = [];
  if (own !== null) sources.push({ from: paths.devices, value: () => JSON.parse(own) });
  for (const path of IMAGE_RECORDS) {
    const record = await readFile(path, "utf8").catch(() => null);
    if (record !== null) sources.push({ from: path, value: () => offerOfImage(JSON.parse(record)) });
  }
  const problems: string[] = [];
  for (const source of sources) {
    try {
      const parsed = parseDeviceOffer(source.value());
      if (parsed.ok) return parsed.value;
      problems.push(`${source.from}: ${parsed.words}`);
    } catch (error) {
      problems.push(`${source.from}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems.length ? `This box's devices could not be read. ${problems.join(" ")}` : `This box lists no devices: there is no ${paths.devices} and no image record with them.`;
}

class AbsentDriver implements DeviceDriver {
  readonly #platform: DevicePlatform;
  readonly #words: string;
  #target: OfferedDevice | null = null;

  constructor(platform: DevicePlatform, words: string) {
    this.#platform = platform;
    this.#words = words;
  }

  async attach(target: OfferedDevice): Promise<"booted"> {
    this.#target = target;
    throw new DriverError("failed", this.#words);
  }
  async shutdown(): Promise<void> {}
  video(): VideoSource {
    return {
      async *frames(signal: AbortSignal) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
      keyframe() {},
    };
  }
  async touch(): Promise<void> {}
  async key(): Promise<void> {}
  async paste(): Promise<void> {}
  async prepareInput(): Promise<void> {}
  async setClipboard(): Promise<void> {}
  async clipboard(): Promise<string> {
    return "";
  }
  async control(): Promise<void> {
    throw new DriverError("not-booted", this.#words);
  }
  async screenshot(): Promise<Uint8Array> {
    throw new DriverError("not-booted", this.#words);
  }
  async tree(): Promise<never[]> {
    throw new DriverError("not-booted", this.#words);
  }
  async readBack(): Promise<DeviceState> {
    const model = deviceModel(this.#target?.model ?? (this.#platform === "ios" ? "iPhone 18 Pro" : "Pixel 8"));
    return placeholderState(model, { is: "failed", error: { code: "incompatible", words: this.#words }, since: Date.now() }, Date.now(), this.#words);
  }
  onChange(): void {}
  close(): void {}
}

async function choices(paths: DevicePaths): Promise<{ readonly slim: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(paths.choices, "utf8")) as { slim?: unknown };
    return { slim: parsed.slim !== false };
  } catch {
    return { slim: true };
  }
}

async function driverFor(offer: DeviceOffer, paths: DevicePaths): Promise<DeviceDriver> {
  if (offer.devices.every(isTestDevice)) return new TestDriver(offer.platform);
  if (offer.platform === "ios" && process.platform === "darwin") return new IosDriver({ paths, slim: (await choices(paths)).slim, log });
  if (offer.platform === "android" && process.platform === "linux") return new AndroidDriver({ paths, log });
  return new AbsentDriver(offer.platform, `This device server has no ${platformWord(offer.platform)} driver yet.`);
}

async function serve(paths: DevicePaths): Promise<void> {
  const offer = await readOffer(paths);
  if (typeof offer === "string") {
    log(offer);
    process.exit(1);
  }
  const server = new DeviceServer({ paths, platform: offer.platform, devices: offer.devices, driver: await driverFor(offer, paths), version: DEVICE_SERVER_VERSION, log });
  const stop = () => {
    void server.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("uncaughtException", (error) => {
    const words = `${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
    log(`crashed: ${words}`);
    try {
      writeFileSync(paths.lastError, `${words}\n`);
    } catch {}
    process.exit(1);
  });
  await server.start();
  log(`serving version ${DEVICE_SERVER_VERSION}, protocol ${DEVICE_PROTOCOL}, ${offer.devices.length} ${platformWord(offer.platform)} devices, the ${server.intent.target} first`);
}

function launcher(command: string): Promise<{ readonly code: number; readonly out: string }> {
  return new Promise((resolve) =>
    execFile("/bin/sh", [LAUNCHER, command], { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((error as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    }),
  );
}

function tryConnect(path: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connectSocket(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", () => resolve(null));
  });
}

async function lastLog(paths: DevicePaths): Promise<string> {
  const text = await readFile(paths.log, "utf8").catch(() => "");
  return text.trim().split("\n").filter((line) => !line.startsWith("bb-box-device: start ")).slice(-3).join(" ");
}

async function connect(paths: DevicePaths): Promise<void> {
  let socket = await tryConnect(paths.socket);
  if (!socket) {
    const status = await launcher("status");
    if (status.code === EXITS.gaveUp) {
      process.stderr.write(`${status.out}\n`);
      process.exit(EXITS.gaveUp);
    }
    await launcher("start");
    const until = Date.now() + CONNECT_WAIT_MS;
    while (!socket && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_MS));
      socket = await tryConnect(paths.socket);
      if (!socket) {
        const again = await launcher("status");
        if (again.code === EXITS.gaveUp) {
          process.stderr.write(`${again.out}\n`);
          process.exit(EXITS.gaveUp);
        }
      }
    }
    if (!socket) {
      const words = existsSync(paths.hostManaged)
        ? `The device server for this box has not started within ${CONNECT_WAIT_MS / 1000} s. Its host's daemon runs it, and starts it again within a second when it stops.`
        : `The device server did not start within ${CONNECT_WAIT_MS / 1000} s.`;
      process.stderr.write(`${words} Its log ends: ${(await lastLog(paths)) || "nothing"}\n`);
      process.exit(EXITS.noServer);
    }
  }
  const joined = socket;
  process.stdin.pipe(joined);
  joined.pipe(process.stdout);
  process.stdin.on("end", () => joined.end());
  joined.on("close", () => process.exit(0));
  joined.on("error", () => process.exit(0));
}

const paths = devicePaths(homedir());
switch (process.argv[2]) {
  case "serve":
    await serve(paths);
    break;
  case "connect":
    await connect(paths);
    break;
  case "version":
    process.stdout.write(`${JSON.stringify({ version: DEVICE_SERVER_VERSION, protocol: DEVICE_PROTOCOL })}\n`);
    break;
  default:
    appendFileSync(process.stderr.fd, "usage: main.ts serve | connect | version\n");
    process.exit(2);
}
