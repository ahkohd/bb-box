import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { BoxRecord } from "../../../src/core/boxes.ts";
import { ComputerError, type ComputerResult } from "../../../src/core/computer.ts";
import { DeviceComputer, type DeviceActInput } from "../../../src/core/device-computer.ts";
import { DEVICE_SERVER_VERSION, deviceModels, type DeviceControl, type DeviceOffer, type OfferedDevices } from "../../../src/core/device.ts";
import { deviceServerFiles } from "../../../src/core/device-delivery.ts";
import { parseDeviceOffer } from "../../../src/core/device-parse.ts";
import { IosDriver } from "../../../src/device/ios-driver.ts";
import { devicePaths } from "../../../src/device/paths.ts";
import { DeviceServer } from "../../../src/device/server.ts";
import { DeviceServers } from "../../../src/plugin/devices.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const LAUNCHER = join(homedir(), ".bb-box", "device", "current", "src", "device", "bb-box-device.sh");
const RECORD = "/usr/local/share/bb-box/image.json";
const OUT = "/tmp/bb-box-computer";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    companion: { type: "string" },
    device: { type: "string", default: "iPhone 18 Pro" },
    person: { type: "boolean", default: false },
  },
});

type Step = { readonly tool: string; readonly [key: string]: unknown };

function simctlOffer(model: string): DeviceOffer {
  const listed = JSON.parse(spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" }).stdout) as { devices: Record<string, { name: string; deviceTypeIdentifier: string }[]> };
  const runtimes = JSON.parse(spawnSync("xcrun", ["simctl", "list", "runtimes", "--json"], { encoding: "utf8" }).stdout) as { runtimes: { identifier: string; version: string; buildversion: string }[] };
  const xcode = /Xcode (\S+)/.exec(spawnSync("xcodebuild", ["-version"], { encoding: "utf8" }).stdout)?.[1] ?? "27.0";
  const names: readonly string[] = deviceModels("ios").map((each) => each.name);
  const devices = Object.entries(listed.devices).flatMap(([runtime, list]) => {
    const found = runtimes.runtimes.find((each) => each.identifier === runtime);
    return found ? list.filter((each) => names.includes(each.name)).map((each) => ({ model: each.name, native: each.deviceTypeIdentifier, runtime: { platform: "ios", os: found.version, build: found.buildversion, xcode, companion: "1.7.7" } })) : [];
  });
  const first = devices.findIndex((each) => each.model === model);
  if (first > 0) devices.unshift(...devices.splice(first, 1));
  const parsed = parseDeviceOffer({ platform: "ios", devices });
  if (!parsed.ok) throw new Error(parsed.words);
  return parsed.value;
}

function recordOffer(): DeviceOffer {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as { devices: unknown[] };
  const parsed = parseDeviceOffer({ platform: "ios", devices: record.devices });
  if (!parsed.ok) throw new Error(parsed.words);
  return parsed.value;
}

function socketChannel(path: string): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      const web = Duplex.toWeb(socket);
      resolve({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() });
    });
  });
}

function launcherChannel(): ByteChannel {
  const child = spawn("/bin/sh", [LAUNCHER, "connect"], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    close: async () => void child.kill(),
  };
}

async function main(): Promise<void> {
  const steps = JSON.parse(readFileSync(positionals[0]!, "utf8")) as Step[];
  mkdirSync(OUT, { recursive: true });
  const inProcess = values.companion !== undefined;
  const offer = inProcess ? simctlOffer(values.device) : recordOffer();
  let server: DeviceServer | null = null;
  let socket = "";
  if (inProcess) {
    const paths = devicePaths(join(tmpdir(), `bb-box-computer-${process.pid}`));
    socket = paths.socket;
    const driver = new IosDriver({ paths, slim: false, companionProgram: values.companion, log: (line) => process.stderr.write(`server: ${line}\n`) });
    server = new DeviceServer({ paths, platform: "ios", devices: offer.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log: (line) => process.stderr.write(`server: ${line}\n`) });
    await server.start();
    for (let tries = 0; server.state.power.is !== "booted" && tries < 1200; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const box = { id: "bench-box", name: "bench", threadId: "bench", state: "ready", capabilities: { device: offer } } as unknown as BoxRecord;
  let personHasControl = values.person;
  const servers = new DeviceServers({
    boxes: {
      find: async () => box,
      all: async () => [box],
      update: async (_box, change) => ({ ...box, ...change(box) }),
      spawnOwn: async () => (inProcess ? socketChannel(socket) : launcherChannel()),
      runOwn: async (_box, script, options) => {
        const ran = spawnSync("/bin/sh", ["-c", script], { input: options.stdin, encoding: "utf8", timeout: options.timeoutMs });
        return { exitCode: ran.status, stdout: ran.stdout, stderr: ran.stderr, timedOut: false, durationMs: 0 } as never;
      },
    },
    kv: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    files: () => deviceServerFiles(ROOT),
    personHasControl: () => personHasControl,
    log: (line) => process.stderr.write(`plugin: ${line}\n`),
    logError: (operation, error) => process.stderr.write(`plugin: ${operation}: ${error}\n`),
    instance: `bench-computer-${process.pid}`,
  });
  const computer = new DeviceComputer({
    read: (each, request) => servers.read(each, request),
    input: (each, input) => servers.input(each, input),
    agentRequest: (each, request) => servers.agentRequest(each, request),
    personHasControl: () => personHasControl,
    takeBack: async () => {
      const had = personHasControl;
      personHasControl = false;
      servers.controlChanged(box.id);
      return had;
    },
  });
  await servers.ensure(box);
  let tree = "";
  const refFor = (wanted: unknown, nth: unknown): string | undefined => {
    if (typeof wanted !== "string" || !wanted.startsWith("/")) return wanted as string | undefined;
    const pattern = new RegExp(wanted.slice(1, wanted.lastIndexOf("/")), wanted.slice(wanted.lastIndexOf("/") + 1));
    const lines = tree.split("\n").filter((line) => pattern.test(line));
    const line = lines[typeof nth === "number" ? nth : 0];
    if (!line) throw new Error(`no line of the last tree matches ${wanted}`);
    return /\[(e\d+)\]/.exec(line)![1];
  };
  for (const [index, step] of steps.entries()) {
    if (step.tool === "person") {
      personHasControl = step.has === true;
      servers.controlChanged(box.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      process.stdout.write(`${JSON.stringify({ step: index, tool: "person", has: personHasControl })}\n`);
      continue;
    }
    if (step.tool === "control") {
      const answer = await servers.control(box, step.control as DeviceControl);
      process.stdout.write(`${JSON.stringify({ step: index, tool: "control", given: step, ok: answer.ok, error: answer.ok ? null : answer.error })}\n`);
      continue;
    }
    if (step.tool === "frames") {
      const began = performance.now();
      const seen: number[] = [];
      while (performance.now() - began < Number(step.ms)) {
        const answer = await servers.read(box, { type: "settle", quietMs: 0, mostMs: 0, fromNow: false });
        seen.push(answer.ok && answer.result.type === "settled" ? answer.result.frames : -1);
        await new Promise((resolve) => setTimeout(resolve, Number(step.everyMs ?? 100)));
      }
      process.stdout.write(`${JSON.stringify({ step: index, tool: "frames", given: step, frames: seen.map((count, at) => (at ? count - seen[at - 1]! : 0)) })}\n`);
      continue;
    }
    if (step.tool === "chars") {
      const began = performance.now();
      for (const character of String(step.text)) {
        const answer = await servers.input(box, { type: "text", text: character });
        if (!answer.ok) throw new Error(answer.error.words);
        await new Promise((resolve) => setTimeout(resolve, Number(step.gapMs)));
      }
      process.stdout.write(`${JSON.stringify({ step: index, tool: "chars", given: step, ms: Math.round(performance.now() - began) })}\n`);
      continue;
    }
    if (step.tool === "wait") {
      await new Promise((resolve) => setTimeout(resolve, Number(step.ms)));
      continue;
    }
    const ref = refFor(step.ref, step.nth);
    const began = performance.now();
    let result: ComputerResult | null = null;
    let refused: { code: string; words: string; hint: string | null } | null = null;
    try {
      switch (step.tool) {
        case "windows":
          result = await computer.windows(box);
          break;
        case "observe":
          result = await computer.observe(box, { window: 1, query: step.query as string | undefined, limit: step.limit as number | undefined, screenshot: step.screenshot === true });
          break;
        case "screenshot":
          result = await computer.screenshot(box, 1);
          break;
        case "act":
          result = await computer.act(box, { ...(step as unknown as DeviceActInput), ref });
          break;
        case "type":
          result = await computer.type(box, { text: step.text as string | undefined, keys: step.keys as string | undefined, ref });
          break;
        case "launch":
          result = await computer.launch(box, { app: step.app as string | undefined, url: step.url as string | undefined });
          break;
        case "take_control":
          result = await computer.takeControl(box);
          break;
        default:
          throw new Error(`no tool ${step.tool}`);
      }
    } catch (error) {
      if (!(error instanceof ComputerError)) throw error;
      refused = { code: error.code, words: error.message, hint: error.hint };
    }
    const ms = Math.round(performance.now() - began);
    if (step.tool === "observe" && result) tree = result.text;
    let image: string | null = null;
    if (result?.image) {
      image = join(OUT, `${String(index).padStart(2, "0")}-${step.tool}.png`);
      writeFileSync(image, Buffer.from(result.image.data, "base64"));
    }
    process.stdout.write(`${JSON.stringify({ step: index, tool: step.tool, given: { ...step, ref }, ms, text: result?.text, hints: result?.hints, refused, image })}\n`);
  }
  await servers.dispose();
  await server?.stop();
  process.exit(0);
}

await main();
