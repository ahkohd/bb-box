import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
  DEVICE_PROTOCOL,
  PERSON_HAS_CONTROL_WORDS,
  STILLS_EVERY_MS,
  deviceModel,
  stillsAsked,
  listWords,
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
  type LaunchedApp,
  type ModelName,
  type OfferedDevice,
  type OfferedDevices,
  type Power,
  type SwitchStep,
  type TableModel,
  type TouchContact,
} from "../core/device.ts";
import { CONTROL_DEADLINES_MS, controlDeadlineMs, deviceStateWords } from "../core/device-settings.ts";
import { deviceServerMessageText, parseDeviceRequest, parseIntent } from "../core/device-parse.ts";
import { DriverError, type DeviceDriver, type EncodedFrame } from "./driver.ts";
import { InputLane, splitByCharacters, TEXT_BATCH } from "./input-lane.ts";
import { keyOfCharacter, typedOnUsKeyboard } from "./keys.ts";
import { PersonInput, WHEEL_SWIPE, easedOut, waitFor } from "./person-input.ts";
import { pixelsWithin, pngPixels, rgbaPng } from "../core/png.ts";
import type { DevicePaths } from "./paths.ts";
import { ServerWebSocket, type WsMessage } from "./ws.ts";

export const KEPT_ANSWERS = 200;
export const DEADLINES_MS = CONTROL_DEADLINES_MS;
const FIRST_FRAME_MS = 10_000;
const VIDEO = 4;
const H264 = 1;
const FRAME_HEADER_BYTES = 12;
const SUPERSEDED_CLOSE = 4000;
const TAP_MS = 60;
export const PASTE_PUT_BACK_MS = 100;
const GESTURE_STEP_MS = 16;
export const SWIPE_HELD_MS = 120;
export const TYPED_KEY_GAP_MS = 15;
const SETTLE_POLL_MS = 20;
const GEOMETRY_WAIT_MS = 130_000;
const GEOMETRY_SETTLE_MS = 1_500;
const GEOMETRY_ACTIONS: ReadonlySet<DeviceControl["action"]> = new Set(["rotate", "posture", "switch", "reboot"]);
const MODIFIER_NAMES = { shift: "Shift", control: "Control", alt: "Alt", meta: "Meta" } as const;
export const SETTINGS_READ_EVERY_MS = 10_000;

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
  readonly settingsEveryMs?: number;
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
}

type InputSource = "agent" | "person";

export type TextRun = { readonly keys: boolean; readonly text: string };

export function textRuns(text: string, typesAsKeys: (character: string) => boolean): readonly TextRun[] {
  const runs: { keys: boolean; text: string }[] = [];
  for (const character of text) {
    const keys = typesAsKeys(character);
    const last = runs.at(-1);
    if (last && last.keys === keys) last.text += character;
    else runs.push({ keys, text: character });
  }
  const joinsPastes = (run: TextRun) => run.keys && !/[\p{L}\p{N}]/u.test(run.text);
  for (let at = 1; at < runs.length - 1; at++) {
    if (!joinsPastes(runs[at]!) || runs[at - 1]!.keys || runs[at + 1]!.keys) continue;
    runs[at - 1]!.text += runs[at]!.text + runs[at + 1]!.text;
    runs.splice(at, 2);
    at--;
  }
  return runs;
}

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
  return deviceStateWords(state);
}

export type Deadlines = { readonly [Kind in keyof typeof DEADLINES_MS]: number };

function deadlineFor(control: DeviceControl, deadlines: Deadlines): number {
  return controlDeadlineMs(control, deadlines);
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
  readonly #lanes: { readonly [Source in InputSource]: InputLane };
  readonly #person: PersonInput;
  readonly #keysDown = new Set<string>();
  #touching: InputSource | null = null;
  #seenGeneration: number | null = null;
  #geometryWait: { readonly from: number; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  #lastStateText = "";
  #stillTimer: ReturnType<typeof setTimeout> | null = null;
  #lastStillAt = -Infinity;
  #settingsTimer: ReturnType<typeof setInterval> | null = null;
  #readingSettings: Promise<void> | null = null;
  readonly #bootedHere = new Set<ModelName>();
  #framesSeen = 0;
  #lastFrameAt = -Infinity;

  constructor(options: DeviceServerOptions) {
    this.#options = options;
    this.#clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
    const first = options.devices[0];
    this.#intent = { target: first.model, switching: null } as Intent;
    this.#state = placeholderState(deviceModel(first.model), { is: "booting", since: this.#clock.now() }, this.#clock.now(), "The device is starting.");
    options.driver.onChange(() => void this.#refresh());
    const lane = (source: InputSource) =>
      new InputLane({ paste: (text, signal) => this.#paste(text, signal, source), failed: (error) => this.#log(`${source}: a paste did not finish: ${error instanceof Error ? error.message : String(error)}`) });
    this.#lanes = { agent: lane("agent"), person: lane("person") };
    this.#person = new PersonInput({
      lane: this.#lanes.person,
      geometry: () => this.#state.geometry,
      waitingForGeometry: () => this.#geometryWait !== null || this.#switching !== null,
      touch: (contacts) => this.#touch(contacts, "person"),
      typesAsKeys: (character) => this.#typesAsKeys(character),
      key: (key, down) => this.#key(key, down),
      setClipboard: (text) => this.#options.driver.setClipboard(text),
      acting: () => this.#personActs(),
      log: (line) => this.#log(line),
    });
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
    await this.#readBootedHere();
    await this.#listen();
    this.#settingsTimer = setInterval(() => {
      if ([...this.#connections].some((connection) => connection.role === "viewer" && connection.wantsVideo)) void this.#readSettings();
    }, this.#options.settingsEveryMs ?? SETTINGS_READ_EVERY_MS);
    this.#settingsTimer.unref?.();
    void this.#boot(intent);
  }

  #readSettings(): Promise<void> {
    const driver = this.#options.driver;
    if (!driver.readSettings || this.#switching || this.#controlBusy !== null || this.#state.power.is !== "booted") return Promise.resolve();
    if (this.#readingSettings) return this.#readingSettings;
    const began = this.#clock.monotonic();
    this.#readingSettings = driver
      .readSettings(AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.control)]))
      .then(() => this.#log(`settings: read back in ${Math.round(this.#clock.monotonic() - began)} ms`))
      .catch((error) => this.#log(`settings: not read: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => (this.#readingSettings = null));
    return this.#readingSettings;
  }

  async #readBootedHere(): Promise<void> {
    const text = await readFile(this.#options.paths.bootedHere, "utf8").catch(() => null);
    if (text === null) return;
    try {
      const read: unknown = JSON.parse(text);
      for (const model of Array.isArray(read) ? read : []) if (typeof model === "string" && this.#offered(model as ModelName)) this.#bootedHere.add(model as ModelName);
    } catch {
      this.#log("booted here: not JSON; starting the list again");
    }
  }

  #bootedHereWrites: Promise<void> = Promise.resolve();

  #bootedIn(model: ModelName): Promise<void> {
    if (this.#bootedHere.has(model)) return this.#bootedHereWrites;
    this.#bootedHere.add(model);
    const text = `${JSON.stringify([...this.#bootedHere])}\n`;
    this.#bootedHereWrites = this.#bootedHereWrites.then(() => writeWhole(this.#options.paths.bootedHere, text)).catch((error) => this.#log(`booted here: could not write: ${error}`));
    return this.#bootedHereWrites;
  }

  async #boot(intent: Intent): Promise<void> {
    const target = this.#offered(intent.target)!;
    try {
      const how = await this.#options.driver.attach(target, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.switch)]));
      this.#log(`device: ${how === "reattached" ? "reattached to" : "booted"} the ${target.model}`);
      void this.#bootedIn(target.model);
      if (intent.switching) await this.#writeIntent({ target: intent.target, switching: null } as Intent);
      await this.#liftAll("the server started");
    } catch (error) {
      const words = error instanceof Error ? error.message : String(error);
      if (intent.switching) {
        this.#log(`device: the ${intent.target} did not start after a restart mid-switch (${words}); starting the ${intent.switching.from} again`);
        await this.#writeIntent({ target: intent.switching.from, switching: null } as Intent);
        await this.#boot(this.#intent);
        return;
      }
      this.#log(`device: the ${target.model} did not start: ${words}`);
      const read = await this.#options.driver.readBack().catch(() => null);
      this.#setState(read?.power.is === "failed" ? read : placeholderState(deviceModel(target.model), { is: "failed", error: { code: "boot-failed", words }, since: this.#clock.now() }, this.#clock.now(), words));
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
    for (const source of ["agent", "person"] as const) this.#lanes[source].cancel(new Refused("superseded", "The device server is stopping."));
    if (this.#geometryWait) clearTimeout(this.#geometryWait.timer);
    if (this.#stillTimer) clearTimeout(this.#stillTimer);
    if (this.#settingsTimer) clearInterval(this.#settingsTimer);
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
      bootedHere: [...this.#bootedHere],
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
    const connection: Connection = { ws, role, started: Number.isFinite(started) ? started : 0, instance: upgrade.query.get("instance") ?? "", wantsVideo: false, stills: false, needsKey: true, frameId: 0 };
    this.#connections.add(connection);
    ws.onClose = () => this.#closed(connection);
    ws.onMessage = (message) => this.#message(connection, message);
    if (role === "control" && !this.#takeLease(connection)) return;
    if (role === "viewer") ws.send("MODE websockets");
    this.#send(connection, { verb: "BB_DEVICE_HELLO", hello: this.#hello(connection) });
    if (role !== "input") void this.#readSettings();
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
    if (connection.role === "input") this.#personStops("its input connection ended");
  }

  #message(connection: Connection, message: WsMessage): void {
    if (typeof message !== "string") return;
    if (connection.role === "viewer") {
      this.#viewerMessage(connection, message);
      return;
    }
    if (connection.role === "input" && this.#person.message(message)) return;
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
    this.#framesSeen++;
    this.#lastFrameAt = this.#clock.monotonic();
    if (this.#seenGeneration !== frame.generation) this.#newGeneration(frame.generation);
    this.#stillsDue();
    for (const connection of this.#connections) {
      if (!connection.wantsVideo || connection.stills) continue;
      if (connection.needsKey && !frame.key) continue;
      connection.needsKey = false;
      connection.frameId = (connection.frameId + 1) & 0xffff;
      const message = new Uint8Array(FRAME_HEADER_BYTES + frame.data.byteLength);
      message.set([VIDEO, (H264 << 4) | (frame.key ? 1 : 0), connection.frameId >> 8, connection.frameId & 255, 0, 0, frame.width >> 8, frame.width & 255, frame.height >> 8, frame.height & 255, (frame.generation >> 8) & 255, frame.generation & 255]);
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
        await this.#setOwner(request.generation, request.holder);
        return { type: "done" };
      case "record":
        this.#leaseOnly(connection, "record the device");
        throw new Refused("unsupported", "This device server cannot record yet.");
      case "screenshot": {
        this.#booted();
        const generation = this.#state.geometry?.generation ?? 0;
        const png = await this.#options.driver.screenshot();
        if (request.longestEdge === undefined) return { type: "screenshot", png: Buffer.from(png).toString("base64"), generation };
        const pixels = pngPixels(png);
        const within = pixelsWithin(pixels, request.longestEdge);
        const shown = within === pixels ? png : rgbaPng(within.width, within.height, within.rgba);
        return { type: "screenshot", png: Buffer.from(shown).toString("base64"), generation, source: { width: pixels.width, height: pixels.height } };
      }
      case "settle":
        return this.#settle(request.quietMs, request.mostMs, request.fromNow);
      case "launch":
        return { type: "launched", app: await this.#launch(request.app, connection) };
      case "tree":
        this.#booted();
        return { type: "tree", elements: await this.#options.driver.tree(), generation: this.#state.geometry?.generation ?? 0 };
      case "at": {
        this.#booted();
        const driver = this.#options.driver;
        if (!driver.elementAt) throw new Refused("unsupported", `The ${this.#state.model} cannot say what is at a point yet.`);
        return { type: "at", element: await driver.elementAt({ x: request.x, y: request.y }), generation: this.#state.geometry?.generation ?? 0 };
      }
      case "touch":
        this.#personOnly(connection);
        this.#booted();
        await this.#personTouches(request.contacts, request.generation);
        return { type: "done" };
      case "text":
        this.#personOnly(connection);
        this.#booted();
        this.#personActs();
        await this.#lanes.person.run((signal) => this.#committedText(request.text, signal));
        return { type: "done" };
      case "input":
        this.#leaseOnly(connection, "send the agent's input");
        if (this.#owner.holder === "person") throw new Refused("person-has-control", "A person has control of this box's device, so the agent's input was dropped.");
        if (request.owner < this.#owner.generation) throw new Refused("superseded", "Control changed hands since this input was sent, so it was dropped.");
        this.#booted();
        await this.#agentInput(request.input);
        return { type: "done" };
      case "control":
        return this.#control(request.id, request.control, connection);
      case "open":
        await this.#open(request.url, connection);
        return { type: "done" };
      case "result":
        return { type: "done" };
    }
  }

  async #open(url: string, from: Connection): Promise<void> {
    if (from.role === "control") {
      this.#leaseOnly(from, "open a link on the device");
      if (this.#owner.holder === "person") throw new Refused("person-has-control", PERSON_HAS_CONTROL_WORDS);
    }
    this.#booted();
    const driver = this.#options.driver;
    if (!driver.openUrl) throw new Refused("unsupported", `The ${this.#state.model} cannot open links yet.`);
    if (from.role === "input") this.#personActs();
    await driver.openUrl(url, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.control)]));
  }

  async #settle(quietMs: number, mostMs: number, fromNow: boolean): Promise<AnswerResult> {
    const began = this.#clock.monotonic();
    const until = began + mostMs;
    for (;;) {
      const now = this.#clock.monotonic();
      const quiet = now - (fromNow ? Math.max(began, this.#lastFrameAt) : this.#lastFrameAt) >= quietMs;
      if (quiet || now >= until || this.#stop.signal.aborted) return { type: "settled", frames: this.#framesSeen, quiet };
      await new Promise((resolve) => setTimeout(resolve, Math.min(SETTLE_POLL_MS, Math.max(1, until - now))));
    }
  }

  async #launch(app: string, from: Connection): Promise<LaunchedApp> {
    this.#leaseOnly(from, "launch an app on the device");
    if (this.#owner.holder === "person") throw new Refused("person-has-control", PERSON_HAS_CONTROL_WORDS);
    this.#booted();
    const driver = this.#options.driver;
    if (!driver.launchApp) throw new Refused("unsupported", `The ${this.#state.model} cannot launch apps yet.`);
    return driver.launchApp(app, AbortSignal.any([this.#stop.signal, AbortSignal.timeout(DEADLINES_MS.control)]));
  }

  #booted(): void {
    if (this.#switching) throw new Refused("busy", `The box is switching to the ${this.#switching.to}. Try again when it has booted.`);
    if (this.#state.power.is !== "booted") throw new Refused("not-booted", `The ${this.#state.model} is ${stateWords(this.#state)}. Try again in a few seconds.`);
  }

  #personOnly(connection: Connection): void {
    if (connection.role !== "input") throw new Refused("bad-value", "Touches and committed text come from the person's input connection. Send the agent's as an input request.");
  }

  async #touch(contacts: readonly TouchContact[], by: InputSource): Promise<void> {
    await this.#options.driver.touch(contacts);
    this.#touching = contacts.length ? by : null;
    this.#echo(contacts, by);
  }

  async #key(key: string, down: boolean): Promise<void> {
    await this.#options.driver.key(key, down);
    if (down) this.#keysDown.add(key);
    else this.#keysDown.delete(key);
  }

  async #liftAll(why: string): Promise<void> {
    const keys = [...this.#keysDown];
    this.#keysDown.clear();
    const touching = this.#touching;
    this.#touching = null;
    await this.#options.driver.touch([]).catch(() => undefined);
    if (touching) this.#echo([], touching);
    for (const key of keys.reverse()) await this.#options.driver.key(key, false).catch(() => undefined);
    if (touching || keys.length) this.#log(`input: lifted ${touching ? `the ${touching}'s touch` : "no touch"} and ${keys.length} key${keys.length === 1 ? "" : "s"}, as ${why}`);
  }

  #stopSource(source: InputSource, why: string): void {
    this.#lanes[source].cancel(new Refused(source === "agent" ? "person-has-control" : "superseded", why));
    if (source === "person") this.#person.forget();
  }

  #personActs(): void {
    if (!this.#lanes.agent.busy) return;
    this.#stopSource("agent", "A person acted on the device, so the agent's input under way was stopped.");
    void this.#liftAll("a person acted on the device");
  }

  #personStops(why: string): void {
    this.#stopSource("person", `The person's input stopped: ${why}.`);
    void this.#liftAll(why);
  }

  async #setOwner(generation: number, holder: "agent" | "person"): Promise<void> {
    if (generation === this.#owner.generation && holder === this.#owner.holder) return;
    const was = this.#owner.holder;
    this.#owner = { generation, holder };
    if (holder === "person") {
      this.#stopSource("agent", "A person took control of the device, so the agent's input was stopped.");
      await this.#liftAll("a person took control");
      void this.#options.driver.prepareInput().catch((error) => this.#log(`input: could not get the device's input ready: ${error instanceof Error ? error.message : String(error)}`));
    } else if (was === "person") {
      this.#stopSource("person", "The person handed control back.");
      await this.#liftAll("the person handed control back");
    } else {
      this.#stopSource("agent", "Control changed hands since this input was sent, so it was dropped.");
      await this.#liftAll("control changed hands");
    }
    this.#log(`owner: ${holder}, generation ${generation}`);
  }

  async #personTouches(contacts: readonly TouchContact[], generation: number): Promise<void> {
    if (contacts.length && (this.#geometryWait || generation !== this.#state.geometry?.generation)) {
      await this.#lanes.person.run(() => this.#touch([], "person"));
      throw new Refused("stale-geometry", "The device turned or changed since that touch began, so it was ended.");
    }
    this.#personActs();
    await this.#lanes.person.run(() => this.#touch(contacts, "person"));
  }

  #typesAsKeys(character: string): boolean {
    return typedOnUsKeyboard(character) || !!this.#options.driver.typesAsKeys?.(character);
  }

  async #committedText(text: string, signal: AbortSignal): Promise<void> {
    if ([...text].every((character) => this.#typesAsKeys(character))) {
      await this.#typeKeys(text, signal);
      return;
    }
    for (const part of splitByCharacters(text, TEXT_BATCH.most)) await this.#paste(part, signal, "person");
  }

  async #typeKeys(text: string, signal: AbortSignal): Promise<void> {
    let first = true;
    for (const character of text) {
      signal.throwIfAborted();
      if (!first) await waitFor(TYPED_KEY_GAP_MS, signal);
      first = false;
      const key = keyOfCharacter(character);
      await this.#key(key, true);
      await this.#key(key, false);
    }
  }

  async #typeText(text: string, signal: AbortSignal, source: InputSource): Promise<void> {
    for (const run of textRuns(text, (character) => this.#typesAsKeys(character))) {
      if (run.keys) await this.#typeKeys(run.text, signal);
      else for (const part of splitByCharacters(run.text, TEXT_BATCH.most)) await this.#paste(part, signal, source);
    }
  }

  async #paste(text: string, signal: AbortSignal, source: InputSource): Promise<void> {
    const driver = this.#options.driver;
    const saved = await driver.clipboard().catch(() => null);
    await driver.setClipboard(text);
    if (signal.aborted) {
      if (saved !== null) await driver.setClipboard(saved).catch(() => undefined);
      this.#log(`${source}: a paste of ${[...text].length} characters was abandoned before its paste key, and the clipboard put back`);
      throw signal.reason;
    }
    await driver.paste();
    await new Promise((resolve) => setTimeout(resolve, PASTE_PUT_BACK_MS));
    if (saved !== null && saved !== text) await driver.setClipboard(saved).catch((error) => this.#log(`${source}: the clipboard was not put back after a paste: ${error instanceof Error ? error.message : String(error)}`));
  }

  #newGeneration(generation: number): void {
    const before = this.#seenGeneration;
    this.#seenGeneration = generation;
    if (this.#geometryWait && generation !== this.#geometryWait.from) {
      clearTimeout(this.#geometryWait.timer);
      this.#geometryWait = null;
    }
    if (before === null) return;
    if (this.#touching) {
      if (this.#touching === "person") this.#person.forget();
      void this.#liftAll(`the picture changed to generation ${generation}`);
    }
  }

  #awaitGeometry(ms = GEOMETRY_WAIT_MS, from = this.#seenGeneration ?? this.#state.geometry?.generation ?? 0): void {
    if (this.#geometryWait) clearTimeout(this.#geometryWait.timer);
    const timer = setTimeout(() => (this.#geometryWait = null), ms);
    timer.unref?.();
    this.#geometryWait = { from, timer };
  }

  #geometryControlDone(): void {
    const wait = this.#geometryWait;
    if (wait) this.#awaitGeometry(GEOMETRY_SETTLE_MS, wait.from);
  }

  #agentInput(input: DeviceInput): Promise<void> {
    void this.#options.driver.prepareInput().catch(() => undefined);
    const lane = this.#lanes.agent;
    if (input.type === "text") return lane.run((signal) => this.#typeText(input.text, signal, "agent"));
    return lane.run(async (signal) => {
      try {
        await this.#agentGesture(input, signal);
      } catch (error) {
        if (this.#touching === "agent") await this.#touch([], "agent").catch(() => undefined);
        throw error;
      }
    });
  }

  async #agentGesture(input: Exclude<DeviceInput, { readonly type: "text" }>, signal: AbortSignal): Promise<void> {
    const driver = this.#options.driver;
    const generation = this.#state.geometry?.generation;
    const current = () => {
      if (this.#geometryWait || this.#state.geometry?.generation !== generation) throw new Refused("stale-geometry", "The device turned or changed since that point was taken. Take another screenshot.");
    };
    const point = (at: { readonly x: number; readonly y: number; readonly generation: number }): TouchContact => {
      if (at.generation !== generation) throw new Refused("stale-geometry", "The device turned or changed since that point was taken. Take another screenshot.");
      current();
      return { id: 0, x: at.x, y: at.y };
    };
    const hold = (ms: number) => waitFor(ms, signal);
    const steps = (ms: number) => Math.max(2, Math.round(ms / GESTURE_STEP_MS));
    switch (input.type) {
      case "tap":
        await this.#touch([point(input.at)], "agent");
        await hold(TAP_MS);
        await this.#touch([], "agent");
        return;
      case "long_press":
        await this.#touch([point(input.at)], "agent");
        await hold(input.ms);
        await this.#touch([], "agent");
        return;
      case "swipe": {
        const from = point(input.from);
        const to = point(input.to);
        const count = steps(input.ms);
        for (let step = 0; step <= count; step++) {
          current();
          const along = easedOut(step, count);
          await this.#touch([{ id: 0, x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along }], "agent");
          await hold(input.ms / count);
        }
        for (let held = 0, wobble: number = WHEEL_SWIPE.stillWobblePixels; held < SWIPE_HELD_MS; held += GESTURE_STEP_MS, wobble = -wobble) {
          current();
          await this.#touch([{ id: 0, x: to.x, y: to.y + Math.max(0, wobble) }], "agent");
          await hold(GESTURE_STEP_MS);
        }
        await this.#touch([], "agent");
        return;
      }
      case "pinch": {
        const centre = point(input.centre);
        if (driver.pinch) {
          const ends = (span: number): readonly TouchContact[] => [
            { id: 0, x: centre.x - span / 2, y: centre.y },
            { id: 1, x: centre.x + span / 2, y: centre.y },
          ];
          this.#echo(ends(input.from), "agent");
          await driver.pinch({ centre, from: input.from, to: input.to, ms: input.ms }, signal);
          this.#echo(ends(input.to), "agent");
          this.#echo([], "agent");
          return;
        }
        const count = steps(input.ms);
        for (let step = 0; step <= count; step++) {
          current();
          const half = (input.from + ((input.to - input.from) * step) / count) / 2;
          await this.#touch(
            [
              { id: 0, x: centre.x - half, y: centre.y },
              { id: 1, x: centre.x + half, y: centre.y },
            ],
            "agent",
          );
          await hold(input.ms / count);
        }
        await this.#touch([], "agent");
        return;
      }
      case "key": {
        const modifiers = input.modifiers.map((modifier) => MODIFIER_NAMES[modifier]);
        for (const modifier of modifiers) await this.#key(modifier, true);
        await this.#key(input.key, true);
        await this.#key(input.key, false);
        for (const modifier of modifiers.reverse()) await this.#key(modifier, false);
        return;
      }
    }
  }

  #echo(contacts: readonly TouchContact[], by: InputSource): void {
    const generation = this.#state.geometry?.generation ?? 0;
    for (const connection of this.#connections) if (connection.role === "viewer") this.#send(connection, { verb: "BB_DEVICE_TOUCH", contacts, by, generation });
  }

  async #control(id: string, control: DeviceControl, from: Connection): Promise<AnswerResult> {
    const model = deviceModel(this.#state.model);
    const support = supports(model, control);
    if (!support.supported) throw new Refused(support.error.code, support.error.words);
    const personHasControl = this.#owner.holder === "person";
    const byAgent = from.role === "control";
    if (byAgent && personHasControl && control.action !== "install") throw new Refused("person-has-control", PERSON_HAS_CONTROL_WORDS);
    if (this.#controlBusy !== null) throw new Refused("busy", this.#switching ? `The box is switching to the ${this.#switching.to}. Try again when it has booted.` : "Another control is under way on this device. Try again when it has finished.");
    if (control.action !== "switch" && control.action !== "reboot") this.#booted();
    this.#controlBusy = id;
    if (GEOMETRY_ACTIONS.has(control.action)) {
      this.#awaitGeometry();
      this.#stopSource("agent", `The device is about to ${control.action.replace("_", " ")}, so the agent's input under way was stopped.`);
      this.#person.forget();
      await this.#liftAll(`the device is about to ${control.action.replace("_", " ")}`);
    }
    const work = (control.action === "switch" ? this.#switch(id, control.device) : this.#options.driver.control(control, this.#stop.signal, { personHasControl: byAgent && personHasControl }).then(() => this.#refresh())).finally(() => {
      this.#controlBusy = null;
      if (GEOMETRY_ACTIONS.has(control.action)) this.#geometryControlDone();
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
      await this.#liftAll("the box switches its device");
      await driver.shutdown(signal);
      await this.#step(id, from, device, "booting", since);
      await driver.attach(target, signal);
      void this.#bootedIn(device);
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

