import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  DEVICE_PROTOCOL,
  STILLS_EVERY_MS,
  deviceModel,
  stillsAsked,
  listWords,
  orientationWord,
  supports,
  type AnswerResult,
  type DeviceAnswer,
  type DeviceControl,
  type DeviceErrorCode,
  type DeviceHello,
  type DeviceInput,
  type DevicePlatform,
  type DeviceRequest,
  type DeviceServerMessage,
  type DeviceState,
  type Intent,
  type ModelName,
  type OfferedDevice,
  type OfferedDevices,
  type Power,
  type SwitchStep,
  type TableModel,
  type TouchContact,
} from "../core/device.ts";
import { deviceServerMessageText, parseDeviceRequest, parseIntent } from "../core/device-parse.ts";
import { DriverError, type DeviceDriver, type EncodedFrame } from "./driver.ts";
import type { DevicePaths } from "./paths.ts";
import { ServerWebSocket, type WsMessage } from "./ws.ts";

export const KEPT_ANSWERS = 200;
export const DEADLINES_MS = { control: 10_000, switch: 120_000, reboot: 120_000, install: 300_000 } as const;
const FIRST_FRAME_MS = 10_000;
const VIDEO = 4;
const H264 = 1;
const FRAME_HEADER_BYTES = 12;
const SUPERSEDED_CLOSE = 4000;
const TAP_MS = 60;

export type Role = "viewer" | "input" | "control";

export interface ServerClock {
  now(): number;
  monotonic(): number;
}

export interface DeviceServerOptions {
  readonly paths: DevicePaths;
  readonly platform: DevicePlatform;
  readonly devices: OfferedDevices;
  readonly driver: DeviceDriver;
  readonly version: number;
  readonly clock?: ServerClock;
  readonly log?: (line: string) => void;
  readonly deadlines?: Partial<Deadlines>;
}

interface Connection {
  readonly ws: ServerWebSocket;
  readonly role: Role;
  readonly started: number;
  readonly instance: string;
  wantsVideo: boolean;
  stills: boolean;
  needsKey: boolean;
  frameId: number;
  readonly clipboardParts: Map<string, string[]>;
}

const CLIPBOARD_PARTS_MOST = 4096;

function watchesStills(connection: Connection): boolean {
  return connection.role === "viewer" && connection.wantsVideo && connection.stills;
}

type Kept = { readonly done: true; readonly answer: DeviceAnswer } | { readonly done: false; readonly type: DeviceRequest["type"] };

class Refused extends Error {
  readonly code: DeviceErrorCode;
  constructor(code: DeviceErrorCode, words: string) {
    super(words);
    this.code = code;
  }
}

function unknownSettings(platform: DevicePlatform, why: string) {
  const unknown = { known: false as const, why };
  const none = { set: null, at: null };
  return platform === "ios"
    ? { appearance: unknown, textSize: unknown, location: none, statusBar: none }
    : { appearance: unknown, fontScale: unknown, location: unknown, battery: unknown, network: unknown, statusBar: none };
}

export function placeholderState(model: TableModel, power: Power, at: number, why: string): DeviceState {
  const settings = unknownSettings(model.platform, why);
  if (model.platform === "ios") return { platform: "ios", model: model.name, power, geometry: null, settings, at } as DeviceState;
  if (model.form === "foldable") return { platform: "android", form: "foldable", model: model.name, power, geometry: null, posture: { known: false, why }, settings, at } as DeviceState;
  return { platform: "android", form: model.form, model: model.name, power, geometry: null, settings, at } as DeviceState;
}

export function stateWords(state: DeviceState): string {
  const power = state.power;
  const parts: string[] = [];
  if (power.is === "booted") parts.push(power.awake ? "booted" : "booted, asleep");
  else if (power.is === "switching") parts.push(`switching to the ${power.to}, ${power.step}`);
  else if (power.is === "failed") parts.push(`failed: ${power.error.words}`);
  else parts.push(power.is);
  if (state.geometry) parts.push(orientationWord(state.geometry.physical), `${state.geometry.video.width}x${state.geometry.video.height}`);
  const appearance = state.settings.appearance;
  if (appearance.known) parts.push(appearance.value);
  return parts.join(", ");
}

export type Deadlines = { readonly [Kind in keyof typeof DEADLINES_MS]: number };

function deadlineFor(control: DeviceControl, deadlines: Deadlines): number {
  return control.action === "switch" ? deadlines.switch : control.action === "reboot" ? deadlines.reboot : control.action === "install" ? deadlines.install : deadlines.control;
}

let written = 0;

async function writeWhole(path: string, text: string): Promise<void> {
  const fresh = `${path}.${process.pid}.${++written}.new`;
  await writeFile(fresh, text, { mode: 0o600 });
  await rename(fresh, path);
}

export class DeviceServer {
  readonly #options: DeviceServerOptions;
  readonly #clock: ServerClock;
  readonly #connections = new Set<Connection>();
  readonly #kept = new Map<string, Kept>();
  readonly #stop = new AbortController();
  #server: Server | null = null;
  #intent: Intent;
  #state: DeviceState;
  #stateWrites: Promise<void> = Promise.resolve();
  #switching: { readonly to: ModelName; readonly step: SwitchStep; readonly since: number } | null = null;
  #controlBusy: string | null = null;
  #lease: Connection | null = null;
  #owner = { generation: 0, holder: "agent" as "agent" | "person" };
  #inputQueue: Promise<unknown> = Promise.resolve();
  #lastStateText = "";
  #stillTimer: ReturnType<typeof setTimeout> | null = null;
  #lastStillAt = -Infinity;

  constructor(options: DeviceServerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
    const first = options.devices[0];
    this.#intent = { target: first.model, switching: null } as Intent;
    this.#state = placeholderState(deviceModel(first.model), { is: "booting", since: this.#clock.now() }, this.#clock.now(), "The device is starting.");
    options.driver.onChange(() => void this.#refresh());
  }

  #log(line: string): void {
    this.#options.log?.(line);
  }

  get state(): DeviceState {
    return this.#state;
  }

  get intent(): Intent {
    return this.#intent;
  }

  get leaseHolder(): { readonly started: number; readonly instance: string } | null {
    return this.#lease ? { started: this.#lease.started, instance: this.#lease.instance } : null;
  }

  #offered(model: ModelName): OfferedDevice | null {
    return (this.#options.devices as readonly OfferedDevice[]).find((device) => device.model === model) ?? null;
  }

  async #readIntent(): Promise<Intent | null> {
    const text = await readFile(this.#options.paths.intent, "utf8").catch(() => null);
    if (text === null) return null;
    try {
      const parsed = parseIntent(JSON.parse(text), this.#options.platform);
      if (parsed.ok && this.#offered(parsed.value.target)) return parsed.value;
      this.#log(`intent: ${parsed.ok ? `the ${parsed.value.target} is not one of this box's devices` : parsed.words}; starting the first device`);
    } catch {
      this.#log("intent: not JSON; starting the first device");
    }
    return null;
  }

  async #writeIntent(intent: Intent): Promise<void> {
    this.#intent = intent;
    await writeWhole(this.#options.paths.intent, `${JSON.stringify(intent)}\n`);
  }

  async start(): Promise<void> {
    await mkdir(this.#options.paths.dir, { recursive: true, mode: 0o700 });
    const intent = (await this.#readIntent()) ?? this.#intent;
    await this.#writeIntent(intent);
    await this.#listen();
    void this.#boot(intent);
  }

  async #boot(intent: Intent): Promise<void> {
    const target = this.#offered(intent.target)!;
    try {
      await this.#options.driver.touch([]).catch(() => undefined);
      const how = await this.#options.driver.attach(target, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.switch)]));
      this.#log(`device: ${how === "reattached" ? "reattached to" : "booted"} the ${target.model}`);
      await this.#options.driver.touch([]).catch(() => undefined);
      if (intent.switching) await this.#writeIntent({ target: intent.target, switching: null } as Intent);
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      if (intent.switching) {
        this.#log(`device: the ${intent.target} did not start after a restart mid-switch (${words}); starting the ${intent.switching.from} again`);
        await this.#writeIntent({ target: intent.switching.from, switching: null } as Intent);
        await this.#boot(this.#intent);
        return;
      }
      this.#log(`device: the ${target.model} did not start: ${words}`);
      this.#setState(placeholderState(deviceModel(target.model), { is: "failed", error: { code: "boot-failed", words }, since: this.#clock.now() }, this.#clock.now(), words));
      return;
    }
    await this.#refresh();
    void this.#pumpFrames();
  }

  async #listen(): Promise<void> {
    await rm(this.#options.paths.socket, { force: true });
    const server = createServer((socket) => void this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#options.paths.socket, () => resolve());
    });
    this.#server = server;
    this.#log(`listening on ${this.#options.paths.socket}`);
  }

  async stop(): Promise<void> {
    this.#stop.abort();
    if (this.#stillTimer) clearTimeout(this.#stillTimer);
    for (const connection of this.#connections) connection.ws.close(1001, "the device server is stopping");
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#options.driver.close();
  }

  async #refresh(): Promise<void> {
    if (this.#switching) return;
    try {
      this.#setState(await this.#options.driver.readBack());
    } catch {
      return;
    }
  }

  #setState(state: DeviceState): void {
    const shown = this.#switching ? { ...state, power: { is: "switching", to: this.#switching.to, step: this.#switching.step, since: this.#switching.since } } as DeviceState : state;
    this.#state = shown;
    const { at: _, ...rest } = shown;
    const compared = JSON.stringify(rest);
    if (compared === this.#lastStateText) return;
    this.#lastStateText = compared;
    this.#broadcast({ verb: "BB_DEVICE_STATE", state: shown });
    const text = `${JSON.stringify(shown)}\n`;
    this.#stateWrites = this.#stateWrites.then(() => writeWhole(this.#options.paths.state, text)).catch((error) => this.#log(`state: could not write: ${error}`));
  }

  #send(connection: Connection, message: DeviceServerMessage): void {
    connection.ws.send(deviceServerMessageText(message));
  }

  #broadcast(message: DeviceServerMessage): void {
    for (const connection of this.#connections) this.#send(connection, message);
  }

  #hello(connection: Connection): DeviceHello {
    return {
      protocol: DEVICE_PROTOCOL,
      version: this.#options.version,
      platform: this.#options.platform,
      devices: this.#options.devices,
      state: this.#state,
      lease: this.#lease === connection,
    } as DeviceHello;
  }

  async #accept(socket: Socket): Promise<void> {
    const accepted = await ServerWebSocket.accept(socket);
    if (!accepted) return;
    const { ws, upgrade } = accepted;
    const role = upgrade.query.get("role");
    if (upgrade.path !== "/device" || (role !== "viewer" && role !== "input" && role !== "control")) {
      ws.close(1008, "The device server takes /device?role=viewer, input or control.");
      return;
    }
    const started = Number(upgrade.query.get("started") ?? "0");
    const connection: Connection = { ws, role, started: Number.isFinite(started) ? started : 0, instance: upgrade.query.get("instance") ?? "", wantsVideo: false, stills: false, needsKey: true, frameId: 0, clipboardParts: new Map() };
    this.#connections.add(connection);
    ws.onClose = () => this.#closed(connection);
    ws.onMessage = (message) => this.#message(connection, message);
    if (role === "control" && !this.#takeLease(connection)) return;
    if (role === "viewer") ws.send("MODE websockets");
    this.#send(connection, { verb: "BB_DEVICE_HELLO", hello: this.#hello(connection) });
  }

  #takeLease(connection: Connection): boolean {
    const holder = this.#lease;
    if (holder && !holder.ws.closed) {
      const later = connection.started > holder.started || (connection.started === holder.started && connection.instance === holder.instance);
      if (!later) {
        this.#log(`lease: a control connection of an instance started earlier (${connection.instance || "unnamed"}) was refused; ${holder.instance || "unnamed"} holds it`);
        connection.ws.close(SUPERSEDED_CLOSE, "superseded: a bb-box instance started later holds this box's device");
        return false;
      }
      this.#log(`lease: ${connection.instance || "unnamed"} takes it from ${holder.instance || "unnamed"}, which is superseded`);
      this.#lease = connection;
      holder.ws.close(SUPERSEDED_CLOSE, "superseded: a bb-box instance started later holds this box's device");
      return true;
    }
    this.#lease = connection;
    this.#log(`lease: ${connection.instance || "unnamed"} holds it`);
    return true;
  }

  #closed(connection: Connection): void {
    this.#connections.delete(connection);
    if (this.#lease === connection) this.#lease = null;
    if (connection.role === "input") void this.#options.driver.touch([]).catch(() => undefined);
  }

  #message(connection: Connection, message: WsMessage): void {
    if (typeof message !== "string") return;
    if (connection.role === "viewer") {
      this.#viewerMessage(connection, message);
      return;
    }
    if (connection.role === "input" && this.#clipboardMessage(connection, message)) return;
    if (!message.startsWith("BB_DEVICE ")) return;
    const parsed = parseDeviceRequest(message);
    if (!parsed.ok) {
      const id = /"id"\s*:\s*"([A-Za-z0-9._:-]{1,64})"/.exec(message)?.[1];
      if (id) this.#answer(connection, { id, ok: false, error: { code: "bad-value", words: parsed.words }, state: this.#state });
      return;
    }
    void this.#request(connection, parsed.value);
  }

  #viewerMessage(connection: Connection, message: string): void {
    const stills = stillsAsked(message);
    if (stills !== null) {
      connection.stills = stills;
      connection.needsKey = true;
      if (stills) this.#stillsDue();
      else this.#options.driver.video().keyframe();
      return;
    }
    const verb = message.split(",")[0];
    if (verb === "START_VIDEO") {
      connection.wantsVideo = true;
      connection.needsKey = true;
      if (connection.stills) this.#stillsDue();
      else this.#options.driver.video().keyframe();
    } else if (verb === "STOP_VIDEO") connection.wantsVideo = false;
    else if (verb === "REQUEST_KEYFRAME") {
      connection.needsKey = true;
      if (connection.stills) this.#stillsDue();
      else this.#options.driver.video().keyframe();
    }
  }

  #clipboardMessage(connection: Connection, message: string): boolean {
    const fields = message.split(",");
    const [verb, id = "", data = ""] = fields;
    const set = (base64: string) => {
      const text = Buffer.from(base64, "base64").toString("utf8");
      void this.#options.driver
        .setClipboard(text)
        .then(() => this.#log(`clipboard: the person's, ${[...text].length} characters, is the device's now`))
        .catch((error) => this.#log(`clipboard: could not set the device's: ${error}`));
    };
    switch (verb) {
      case "cw":
        set(fields[1] ?? "");
        return true;
      case "cws":
        connection.clipboardParts.set(id, []);
        return true;
      case "cwd": {
        const parts = connection.clipboardParts.get(id);
        if (parts && parts.length < CLIPBOARD_PARTS_MOST) parts.push(Buffer.from(data, "base64").toString("latin1"));
        else connection.clipboardParts.delete(id);
        return true;
      }
      case "cwe": {
        const parts = connection.clipboardParts.get(id);
        connection.clipboardParts.delete(id);
        if (parts) set(Buffer.from(parts.join(""), "latin1").toString("base64"));
        return true;
      }
      default:
        return false;
    }
  }

  #stillsDue(): void {
    if (this.#stillTimer || ![...this.#connections].some(watchesStills)) return;
    const wait = Math.max(0, this.#lastStillAt + STILLS_EVERY_MS - performance.now());
    this.#stillTimer = setTimeout(() => {
      this.#stillTimer = null;
      void this.#sendStills();
    }, wait);
  }

  async #sendStills(): Promise<void> {
    this.#lastStillAt = performance.now();
    if (this.#state.power.is !== "booted" || this.#switching) return;
    let png: Uint8Array;
    try {
      png = await this.#options.driver.screenshot();
    } catch (error) {
      this.#log(`stills: no screenshot: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const still: DeviceServerMessage = { verb: "BB_DEVICE_STILL", png: Buffer.from(png).toString("base64"), generation: this.#state.geometry?.generation ?? 0 };
    for (const connection of this.#connections) {
      if (!watchesStills(connection)) continue;
      connection.needsKey = false;
      this.#send(connection, still);
    }
  }

  async #pumpFrames(): Promise<void> {
    const source = this.#options.driver.video();
    for await (const frame of source.frames(this.#stop.signal)) this.#frame(frame);
  }

  #frame(frame: EncodedFrame): void {
    this.#stillsDue();
    for (const connection of this.#connections) {
      if (!connection.wantsVideo || connection.stills) continue;
      if (connection.needsKey && !frame.key) continue;
      connection.needsKey = false;
      connection.frameId = (connection.frameId + 1) & 0xffff;
      const message = new Uint8Array(FRAME_HEADER_BYTES + frame.data.byteLength);
      message.set([VIDEO, (H264 << 4) | (frame.key ? 1 : 0), connection.frameId >> 8, connection.frameId & 255, 0, 0, frame.width >> 8, frame.width & 255, frame.height >> 8, frame.height & 255, 0, 0]);
      message.set(frame.data, FRAME_HEADER_BYTES);
      connection.ws.send(message);
    }
  }

  #answer(connection: Connection | null, answer: DeviceAnswer): void {
    if (connection && !connection.ws.closed) this.#send(connection, { verb: "BB_DEVICE_ANSWER", answer });
  }

  #keep(id: string, kept: Kept): void {
    this.#kept.delete(id);
    this.#kept.set(id, kept);
    while (this.#kept.size > KEPT_ANSWERS) this.#kept.delete(this.#kept.keys().next().value!);
  }

  async #request(connection: Connection, request: DeviceRequest): Promise<void> {
    if (request.type === "result") {
      this.#answer(connection, this.#result(request.id));
      return;
    }
    const kept = this.#kept.get(request.id);
    if (kept) {
      this.#answer(connection, kept.done ? kept.answer : { id: request.id, ok: false, error: { code: "in-progress", words: "That request is still under way. Ask for its result again in a moment." }, state: this.#state });
      return;
    }
    this.#keep(request.id, { done: false, type: request.type });
    const began = this.#clock.monotonic();
    let answer: DeviceAnswer;
    try {
      const result = await this.#run(connection, request);
      answer = { id: request.id, ok: true, ms: Math.round(this.#clock.monotonic() - began), state: this.#state, result };
    } catch (error) {
      const refusal = error instanceof Refused ? { code: error.code, words: error.message } : error instanceof DriverError ? { code: error.code, words: error.message } : { code: "failed" as const, words: error instanceof Error ? error.message : String(error) };
      answer = { id: request.id, ok: false, error: refusal, state: this.#state };
    }
    this.#keep(request.id, { done: true, answer });
    this.#answer(connection, answer);
  }

  #result(id: string): DeviceAnswer {
    const kept = this.#kept.get(id);
    if (kept?.done) return kept.answer;
    if (kept) return { id, ok: false, error: { code: "in-progress", words: "That request is still under way. Ask for its result again in a moment." }, state: this.#state };
    const switching = this.#intent.switching;
    if (switching?.id === id) return { id, ok: false, error: { code: "in-progress", words: `The box is still switching to the ${this.#intent.target}, at ${switching.step}.` }, state: this.#state };
    return {
      id,
      ok: false,
      error: { code: "outcome-unknown", words: `The device server has no answer for that request: it restarted, or the request is older than its last ${KEPT_ANSWERS}. The device is now ${stateWords(this.#state)}. Read its state before trying again.` },
      state: this.#state,
    };
  }

  #leaseOnly(connection: Connection, what: string): void {
    if (connection.role !== "control" || this.#lease !== connection) throw new Refused("superseded", `Only the bb-box instance that holds this box's device may ${what}.`);
  }

  async #run(connection: Connection, request: DeviceRequest): Promise<AnswerResult> {
    switch (request.type) {
      case "owner":
        this.#leaseOnly(connection, "set who has control");
        if (request.generation < this.#owner.generation) throw new Refused("superseded", `Control's owner is at generation ${this.#owner.generation} already, past ${request.generation}.`);
        this.#owner = { generation: request.generation, holder: request.holder };
        this.#inputQueue = Promise.resolve();
        await this.#options.driver.touch([]).catch(() => undefined);
        return { type: "done" };
      case "record":
        this.#leaseOnly(connection, "record the device");
        throw new Refused("unsupported", "This device server cannot record yet.");
      case "screenshot": {
        this.#booted();
        const png = await this.#options.driver.screenshot();
        return { type: "screenshot", png: Buffer.from(png).toString("base64"), generation: this.#state.geometry?.generation ?? 0 };
      }
      case "tree":
        this.#booted();
        return { type: "tree", elements: await this.#options.driver.tree(), generation: this.#state.geometry?.generation ?? 0 };
      case "touch":
        this.#booted();
        await this.#options.driver.touch(request.contacts);
        return { type: "done" };
      case "text":
        this.#booted();
        await this.#typeText(request.text);
        return { type: "done" };
      case "input":
        if (request.owner < this.#owner.generation) throw new Refused("superseded", "Control changed hands since this input was sent, so it was dropped.");
        this.#booted();
        await this.#queueInput(request.input);
        return { type: "done" };
      case "control":
        return this.#control(request.id, request.control);
      case "result":
        return { type: "done" };
    }
  }

  #booted(): void {
    if (this.#switching) throw new Refused("busy", `The box is switching to the ${this.#switching.to}. Try again when it has booted.`);
    if (this.#state.power.is !== "booted") throw new Refused("not-booted", `The ${this.#state.model} is ${stateWords(this.#state)}. Try again in a few seconds.`);
  }

  async #typeText(text: string): Promise<void> {
    for (const character of text) {
      await this.#options.driver.key(character, true);
      await this.#options.driver.key(character, false);
    }
  }

  #queueInput(input: DeviceInput): Promise<void> {
    const run = this.#inputQueue.then(() => this.#input(input));
    this.#inputQueue = run.catch(() => undefined);
    return run;
  }

  async #input(input: DeviceInput): Promise<void> {
    const driver = this.#options.driver;
    const generation = this.#state.geometry?.generation;
    const point = (at: { readonly x: number; readonly y: number; readonly generation: number }): TouchContact => {
      if (at.generation !== generation) throw new Refused("stale-geometry", "The device turned or changed since that point was taken. Take another screenshot.");
      return { id: 0, x: at.x, y: at.y };
    };
    const hold = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    switch (input.type) {
      case "tap":
        await driver.touch([point(input.at)]);
        await hold(TAP_MS);
        await driver.touch([]);
        return;
      case "long_press":
        await driver.touch([point(input.at)]);
        await hold(input.ms);
        await driver.touch([]);
        return;
      case "swipe": {
        const from = point(input.from);
        const to = point(input.to);
        const steps = Math.max(2, Math.round(input.ms / 16));
        for (let step = 0; step <= steps; step++) {
          await driver.touch([{ id: 0, x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }]);
          await hold(input.ms / steps);
        }
        await driver.touch([]);
        return;
      }
      case "pinch": {
        const centre = point(input.centre);
        const steps = Math.max(2, Math.round(input.ms / 16));
        for (let step = 0; step <= steps; step++) {
          const half = (input.from + ((input.to - input.from) * step) / steps) / 2;
          await driver.touch([
            { id: 0, x: centre.x - half, y: centre.y },
            { id: 1, x: centre.x + half, y: centre.y },
          ]);
          await hold(input.ms / steps);
        }
        await driver.touch([]);
        return;
      }
      case "key":
        await driver.key(input.key, true);
        await driver.key(input.key, false);
        return;
      case "text":
        await this.#typeText(input.text);
        return;
    }
  }

  async #control(id: string, control: DeviceControl): Promise<AnswerResult> {
    const model = deviceModel(this.#state.model);
    const support = supports(model, control);
    if (!support.supported) throw new Refused(support.error.code, support.error.words);
    if (this.#controlBusy !== null) throw new Refused("busy", this.#switching ? `The box is switching to the ${this.#switching.to}. Try again when it has booted.` : "Another control is under way on this device. Try again when it has finished.");
    if (control.action !== "switch" && control.action !== "reboot") this.#booted();
    this.#controlBusy = id;
    const work = (control.action === "switch" ? this.#switch(id, control.device) : this.#options.driver.control(control, this.#stop.signal).then(() => this.#refresh())).finally(() => {
      this.#controlBusy = null;
    });
    const deadline = deadlineFor(control, { ...DEADLINES_MS, ...this.#options.deadlines });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), deadline)));
    const outcome = await Promise.race([work.then(() => "done" as const), late]).finally(() => clearTimeout(timer));
    if (outcome === "late") {
      work.catch(() => undefined);
      await this.#refresh();
      throw new Refused("outcome-unknown", `The ${control.action} did not finish within ${Math.round(deadline / 100) / 10} s, so bb-box cannot tell whether it took effect. The device is now ${stateWords(this.#state)}. Read its state before trying again.`);
    }
    return { type: "done" };
  }

  async #step(id: string, from: ModelName, to: ModelName, step: SwitchStep, since: number): Promise<void> {
    this.#switching = { to, step, since };
    await this.#writeIntent({ target: to, switching: { id, from, step, since } } as Intent);
    this.#setState(this.#state);
  }

  async #switch(id: string, device: ModelName): Promise<void> {
    const from = this.#state.model;
    if (device === from) return;
    const target = this.#offered(device);
    if (!target) {
      const own = (this.#options.devices as readonly OfferedDevice[]).map((each) => each.model);
      throw new Refused("unknown-device", `This box has no ${device}. Its devices are: ${listWords(own)}.`);
    }
    const since = this.#clock.now();
    const driver = this.#options.driver;
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.switch)]);
    try {
      await this.#step(id, from, device, "stopping", since);
      await driver.touch([]).catch(() => undefined);
      await driver.shutdown(signal);
      await this.#step(id, from, device, "booting", since);
      await driver.attach(target, signal);
      await this.#step(id, from, device, "waiting", since);
      await this.#step(id, from, device, "streaming", since);
      await this.#firstFrame(signal);
      this.#switching = null;
      await this.#writeIntent({ target: device, switching: null } as Intent);
      await this.#refresh();
      this.#log(`switch: now the ${device}`);
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      this.#switching = null;
      this.#log(`switch: the ${device} did not start (${words}); starting the ${from} again`);
      try {
        await driver.attach(this.#offered(from)!, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.switch)]));
        await this.#writeIntent({ target: from, switching: null } as Intent);
        await this.#refresh();
      } catch (again) {
        const why = again instanceof Error ? again.message : String(again);
        await this.#writeIntent({ target: from, switching: null } as Intent);
        this.#setState(placeholderState(deviceModel(from), { is: "failed", error: { code: "boot-failed", words: why }, since: this.#clock.now() }, this.#clock.now(), why));
        throw new Refused("failed", `Could not start the ${device}: ${words}. The ${from} did not start again either: ${why}.`);
      }
      throw new Refused("failed", `Could not start the ${device}: ${words}. The ${from} is back.`);
    }
  }

  async #firstFrame(signal: AbortSignal): Promise<void> {
    const source = this.#options.driver.video();
    const waiting = AbortSignal.any([signal, AbortSignal.timeout(FIRST_FRAME_MS)]);
    source.keyframe();
    for await (const frame of source.frames(waiting)) if (frame.key) return;
    throw new Error(`no frame came within ${FIRST_FRAME_MS / 1000} s`);
  }
}

