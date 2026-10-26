import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { BoxRecord } from "../../../src/core/boxes.ts";
import { ComputerError, type ComputerResult } from "../../../src/core/computer.ts";
import { DeviceComputer, type DeviceActInput } from "../../../src/core/device-computer.ts";
import { DEVICE_SERVER_VERSION, type DeviceControl, type DeviceOffer, type OfferedDevices } from "../../../src/core/device.ts";
import { deviceServerFiles } from "../../../src/core/device-delivery.ts";
import { parseDeviceOffer } from "../../../src/core/device-parse.ts";
import { AndroidDriver } from "../../../src/device/android-driver.ts";
import { devicePaths } from "../../../src/device/paths.ts";
import { DeviceServer } from "../../../src/device/server.ts";
import { DeviceServers } from "../../../src/plugin/devices.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const LAUNCHER = join(homedir(), ".bb-box", "device", "current", "src", "device", "bb-box-device.sh");
const RECORDS = ["/usr/share/bb-box/image.json", "/usr/share/bb-box/android-devices.json"];
const SERVER_UNIT = "bb-box-device.service";
const OUT = "/tmp/bb-box-computer";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    tree: { type: "string" },
    person: { type: "boolean", default: false },
  },
});

type Step = { readonly tool: string; readonly [key: string]: unknown };

function offer(): DeviceOffer {
  for (const path of RECORDS) {
    if (!existsSync(path)) continue;
    const read = JSON.parse(readFileSync(path, "utf8")) as { devices?: unknown[] } | unknown[];
    const devices = Array.isArray(read) ? read : read.devices;
    if (!devices?.length) continue;
    const parsed = parseDeviceOffer({ platform: "android", devices });
    if (!parsed.ok) throw new Error(parsed.words);
    return parsed.value;
  }
  throw new Error(`No record of the box's devices at ${RECORDS.join(" or ")}.`);
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

function report(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function main(): Promise<void> {
  const steps = JSON.parse(readFileSync(positionals[0]!, "utf8")) as Step[];
  mkdirSync(OUT, { recursive: true });
  const inProcess = values.tree === "dump" || values.tree === "server";
  const devices = offer();
  const paths = devicePaths(homedir());
  let server: DeviceServer | null = null;
  if (inProcess) {
    spawnSync("systemctl", ["--user", "stop", SERVER_UNIT]);
    const log = (line: string) => process.stderr.write(`server: ${line}\n`);
    const driver = new AndroidDriver({ paths, log, tree: { onlyDump: values.tree === "dump" } });
    server = new DeviceServer({ paths, platform: "android", devices: devices.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log });
    await server.start();
    for (let tries = 0; server.state.power.is !== "booted" && tries < 1200; tries++) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const box = { id: "bench-box", name: "bench", threadId: "bench", state: "ready", capabilities: { device: devices } } as unknown as BoxRecord;
  let personHasControl = values.person;
  const servers = new DeviceServers({
    boxes: {
      find: async () => box,
      all: async () => [box],
      update: async (_box, change) => ({ ...box, ...change(box) }),
      spawnOwn: async () => (inProcess ? socketChannel(paths.socket) : launcherChannel()),
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
    instance: `bench-android-computer-${process.pid}`,
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
    const line = typeof nth === "number" ? lines.at(nth) : lines[0];
    const found = line ? /\[(e\d+)\]/.exec(line)?.[1] : undefined;
    if (!found) throw new Error(`no line of the last tree matches ${wanted}`);
    return found;
  };
  for (const [index, step] of steps.entries()) {
    if (step.tool === "person") {
      personHasControl = step.has === true;
      servers.controlChanged(box.id);
      await new Promise((resolve) => setTimeout(resolve, 300));
      report({ step: index, tool: "person", has: personHasControl });
      continue;
    }
    if (step.tool === "control") {
      const answer = await servers.control(box, step.control as DeviceControl);
      report({ step: index, tool: "control", given: step, ok: answer.ok, error: answer.ok ? null : answer.error });
      continue;
    }
    if (step.tool === "wait") {
      await new Promise((resolve) => setTimeout(resolve, Number(step.ms)));
      continue;
    }
    if (step.tool === "shell" && step.background === true) {
      spawn("/bin/sh", ["-c", `${String(step.command)} >${String(step.out ?? "/dev/null")} 2>&1`], { stdio: "ignore", detached: true }).unref();
      report({ step: index, tool: "shell", given: step, background: true });
      continue;
    }
    if (step.tool === "shell") {
      const ran = spawnSync("/bin/sh", ["-c", String(step.command)], { encoding: "utf8" });
      report({ step: index, tool: "shell", given: step, out: `${ran.stdout}${ran.stderr}`.trim().slice(0, 2_000) });
      continue;
    }
    if (step.tool === "reads") {
      const times: number[] = [];
      for (let time = 0; time < Number(step.times ?? 10); time++) {
        const began = performance.now();
        const answer = await servers.read(box, { type: "tree" });
        if (!answer.ok) throw new Error(answer.error.words);
        times.push(Math.round((performance.now() - began) * 10) / 10);
        await new Promise((resolve) => setTimeout(resolve, Number(step.gapMs ?? 200)));
      }
      report({ step: index, tool: "reads", given: step, ms: times });
      continue;
    }
    if (step.tool === "watch") {
      const reads: { readonly at: number; readonly ms: number; readonly ok: boolean; readonly elements: number; readonly words: string | null }[] = [];
      const began = performance.now();
      while (performance.now() - began < Number(step.seconds ?? 10) * 1000) {
        const at = performance.now();
        const answer = await servers.read(box, { type: "tree" });
        const elements = answer.ok && answer.result.type === "tree" ? JSON.stringify(answer.result.elements).split('"role"').length - 1 : 0;
        reads.push({ at: Math.round(at - began), ms: Math.round(performance.now() - at), ok: answer.ok, elements, words: answer.ok ? null : answer.error.words.slice(0, 160) });
        await new Promise((resolve) => setTimeout(resolve, Number(step.gapMs ?? 500)));
      }
      report({ step: index, tool: "watch", given: step, reads });
      continue;
    }
    let ref: string | undefined;
    try {
      ref = refFor(step.ref, step.nth);
    } catch (error) {
      report({ step: index, tool: step.tool, given: step, skipped: (error as Error).message, optional: step.optional === true });
      continue;
    }
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
    report({ step: index, tool: step.tool, given: { ...step, ref }, ms, text: result?.text, hints: result?.hints, refused, image });
  }
  await servers.dispose();
  await server?.stop();
  if (inProcess) spawnSync("systemctl", ["--user", "start", SERVER_UNIT]);
  process.exit(0);
}

await main();
