import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import type { BoxRecord } from "../../../src/core/boxes.ts";
import { answerText, controlFromParameters, type DeviceControlParameters } from "../../../src/core/device-control.ts";
import { deviceStateWords } from "../../../src/core/device-settings.ts";
import { deviceModel, offeredModels, type DeviceOffer, type DeviceState } from "../../../src/core/device.ts";
import { deviceServerFiles } from "../../../src/core/device-delivery.ts";
import { DeviceLink, newRequestId } from "../../../src/core/device-link.ts";
import { parseDeviceOffer } from "../../../src/core/device-parse.ts";
import { DeviceServers } from "../../../src/plugin/devices.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(homedir(), ".bb-box", "device");
const LAUNCHER = join(DIR, "current", "src", "device", "bb-box-device.sh");
const RECORD = "/usr/local/share/bb-box/image.json";
const SHOTS = "/tmp/bb-box-controls";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    times: { type: "string", default: "5" },
    shot: { type: "string" },
    person: { type: "boolean", default: false },
  },
});

function offer(): DeviceOffer {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as { devices: { runtime: { platform: string } }[] };
  const parsed = parseDeviceOffer({ platform: record.devices[0]!.runtime.platform, devices: record.devices });
  if (!parsed.ok) throw new Error(parsed.words);
  return parsed.value;
}

function channel(): ByteChannel {
  const child = spawn("/bin/sh", [LAUNCHER, "connect"], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    close: async () => {
      child.kill();
    },
  };
}

function report(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

const box = { id: "bench-box", name: "bench", threadId: "bench", state: "ready", capabilities: { device: offer() } } as unknown as BoxRecord;
let personHasControl = values.person;

const servers = new DeviceServers({
  boxes: {
    find: async () => box,
    all: async () => [box],
    update: async (_box, change) => ({ ...box, ...change(box) }),
    spawnOwn: async () => channel(),
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
  instance: "bench-controls",
});

function udid(): string {
  const listed = JSON.parse(spawnSync("xcrun", ["simctl", "list", "devices", "booted", "--json"], { encoding: "utf8" }).stdout) as { devices: Record<string, { udid: string }[]> };
  return Object.values(listed.devices).flat()[0]!.udid;
}

function screenshot(name: string): string {
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${name}.png`);
  spawnSync("xcrun", ["simctl", "io", udid(), "screenshot", path], { encoding: "utf8" });
  return path;
}

function timed(program: string, args: readonly string[]): { readonly ms: number; readonly out: string } {
  const began = performance.now();
  const ran = spawnSync(program, args, { encoding: "utf8" });
  return { ms: Math.round(performance.now() - began), out: (ran.stdout || ran.stderr).trim() };
}

function readBacks(): Record<string, { readonly ms: number; readonly out: string }> {
  const device = udid();
  return {
    appearance: timed("xcrun", ["simctl", "ui", device, "appearance"]),
    contentSize: timed("xcrun", ["simctl", "ui", device, "content_size"]),
    statusBar: timed("xcrun", ["simctl", "status_bar", device, "list"]),
    locked: timed("xcrun", ["simctl", "spawn", device, "notifyutil", "-g", "com.apple.springboard.lockstate"]),
  };
}

async function state(): Promise<DeviceState> {
  await servers.ensure(box);
  const view = servers.view(box.id);
  if (view.is !== "connected") throw new Error(`not connected: ${JSON.stringify(view)}`);
  return view.state;
}

async function control(): Promise<void> {
  const parameters = JSON.parse(positionals[1] ?? "{}") as DeviceControlParameters;
  const before = await state();
  const model = deviceModel(before.model);
  const parsed = controlFromParameters(parameters, model, offeredModels(box.capabilities.device!));
  if (!parsed.ok) {
    report({ step: "control", parameters, ok: false, refused: parsed.error });
    return;
  }
  if (personHasControl) servers.controlChanged(box.id);
  const began = performance.now();
  const answer = await servers.control(box, parsed.control);
  const ms = Math.round(performance.now() - began);
  const shot = values.shot ? screenshot(values.shot) : null;
  report({
    step: "control",
    parameters,
    ok: answer.ok,
    text: answer.ok ? answerText(parsed.control, model, answer) : `${answer.error.code}: ${answer.error.words}`,
    serverMs: answer.ok ? answer.ms : null,
    roundTripMs: ms,
    shot,
    state: answer.state ? deviceStateWords(answer.state) : null,
    settings: answer.state?.settings,
  });
}

async function readBack(): Promise<void> {
  const rounds = Array.from({ length: Number(values.times) }, () => readBacks());
  const keys = Object.keys(rounds[0]!) as (keyof ReturnType<typeof readBacks>)[];
  const summary = Object.fromEntries(keys.map((key) => [key, { msEach: rounds.map((round) => round[key].ms), last: rounds.at(-1)![key].out }]));
  report({ step: "read-back", at: new Date().toISOString(), ...summary });
}

async function twice(): Promise<void> {
  const parameters = JSON.parse(positionals[1] ?? "{}") as DeviceControlParameters;
  const before = await state();
  const parsed = controlFromParameters(parameters, deviceModel(before.model), offeredModels(box.capabilities.device!));
  if (!parsed.ok) throw new Error(parsed.error.words);
  const link = await DeviceLink.open(channel(), { role: "control", started: Date.now(), instance: "bench-twice" });
  const id = newRequestId();
  const first = await link.request({ type: "control", control: parsed.control }, { id, timeoutMs: 30_000 });
  const second = await link.request({ type: "control", control: parsed.control }, { id, timeoutMs: 30_000 });
  const asked = await link.request({ type: "result" }, { id, timeoutMs: 30_000 });
  const after = link.state;
  report({
    step: "twice",
    id,
    parameters,
    before: deviceStateWords(before),
    first: first.ok ? { ok: true, ms: first.ms } : first.error,
    second: second.ok ? { ok: true, ms: second.ms, sameAnswer: JSON.stringify(second) === JSON.stringify(first) } : second.error,
    result: asked.ok ? { ok: true, sameAnswer: JSON.stringify(asked) === JSON.stringify(first) } : asked.error,
    after: deviceStateWords(after),
  });
  await link.close();
}

async function lost(): Promise<void> {
  const parameters = JSON.parse(positionals[1] ?? "{}") as DeviceControlParameters;
  const before = await state();
  const parsed = controlFromParameters(parameters, deviceModel(before.model), offeredModels(box.capabilities.device!));
  if (!parsed.ok) throw new Error(parsed.error.words);
  const began = performance.now();
  const answering = servers.control(box, parsed.control);
  await new Promise((resolve) => setTimeout(resolve, Number(values.times)));
  await servers.forget(box.id);
  const answer = await answering;
  report({ step: "lost", parameters, closedAfterMs: Number(values.times), ok: answer.ok, answer: answer.ok ? { ms: answer.ms } : answer.error, totalMs: Math.round(performance.now() - began), before: deviceStateWords(before), now: answer.state ? deviceStateWords(answer.state) : null });
}

async function native(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "viewer" });
  const control = await DeviceLink.open(channel(), { role: "control", started: Date.now(), instance: "bench-native" });
  const answer = await control.request({ type: "screenshot" }, { timeoutMs: 30_000 });
  mkdirSync(SHOTS, { recursive: true });
  const path = join(SHOTS, `${positionals[1] ?? "native"}.png`);
  if (answer.ok && answer.result.type === "screenshot") writeFileSync(path, Buffer.from(answer.result.png, "base64"));
  report({ step: "native", path, ok: answer.ok, physical: answer.state?.geometry?.physical ?? null });
  await control.close();
  await link.close();
}

async function watch(): Promise<void> {
  const seen: Record<string, unknown>[] = [];
  const began = performance.now();
  const link = await DeviceLink.open(channel(), {
    role: "viewer",
    onState: (now) => seen.push({ afterMs: Math.round(performance.now() - began), appearance: now.settings.appearance, words: deviceStateWords(now) }),
  });
  await link.send("START_VIDEO");
  const outside = positionals[1];
  if (outside) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    spawnSync("/bin/sh", ["-c", outside]);
    seen.push({ afterMs: Math.round(performance.now() - began), ran: outside });
  }
  await new Promise((resolve) => setTimeout(resolve, Number(values.times) * 1000));
  report({ step: "watch", hello: deviceStateWords(link.hello.state), seen });
  await link.close();
}

async function tap(): Promise<void> {
  const now = await state();
  const answer = await servers.input(box, { type: "tap", at: { x: Number(positionals[1]), y: Number(positionals[2]), generation: now.geometry?.generation ?? 0 } });
  report({ step: "tap", ok: answer.ok, error: answer.ok ? null : answer.error });
}

async function input(): Promise<void> {
  const now = await state();
  const generation = now.geometry?.generation ?? 0;
  const raw = JSON.stringify(JSON.parse(positionals[1] ?? "{}")).replaceAll('"generation":0', `"generation":${generation}`);
  const answer = await servers.input(box, JSON.parse(raw));
  report({ step: "input", ok: answer.ok, error: answer.ok ? null : answer.error });
}

async function shot(): Promise<void> {
  report({ step: "shot", path: screenshot(positionals[1] ?? "shot") });
}

const steps: Record<string, () => Promise<void>> = { control, "read-back": readBack, twice, lost, shot, native, tap, watch, input };
const step = steps[positionals[0] ?? ""];
if (!step) {
  process.stderr.write(`usage: controls.ts ${Object.keys(steps).join(" | ")} '<box_device parameters as JSON>'\n`);
  process.exit(2);
}
try {
  await step();
} finally {
  await servers.dispose();
}
process.exit(0);
