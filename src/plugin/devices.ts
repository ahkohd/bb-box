import { randomBytes } from "node:crypto";
import type { BoxRecord } from "../core/boxes.ts";
import { DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, SETTINGS_ASKED_SINCE_VERSION, isTestOffer, speaksProtocol, type BoxDevice, type ControlHolder, type DeviceAgentRequest, type DeviceAnswer, type DeviceControl, type DeviceRead, type DeviceHello, type DeviceInput, type DeviceState, type Intent, type ModelName, type OfferedDevice, type VideoStep } from "../core/device.ts";
import { DELIVERY_EXITS, connectScript, deliveryScript, deviceHubScript, parseDeviceHub, type DeviceHubSeen, deliveryStdin, parseStatus, restartScript, rollbackScript, statusScript, type ServerFile, type ServerStatus } from "../core/device-delivery.ts";
import { lostWords } from "../core/device-control.ts";
import { controlDeadlineMs } from "../core/device-settings.ts";
import { DeviceLink, DeviceLinkError, newRequestId, type DeviceRequestBody } from "../core/device-link.ts";
import type { ByteChannel, RunResult } from "../transports/types.ts";
import type { DoctorCheck } from "../backends/types.ts";
import { inSlot, placementOf } from "../core/device-host.ts";

export const IDLE_CLOSE_MS = 10 * 60_000;
export const SLOT_STREAM_CAP: VideoStep = "two-thirds";
export const ASKED_HOST_WORDS = "The device server for this box has not started. bb-box has asked the host to start it again.";
export const HELLO_TRIES = 2;
const SCRIPT_TIMEOUT_MS = 60_000;
const DEVICE_HUB_CHECK_MS = 15_000;
export const FRESH_SETTINGS_WAIT_MS = 3_000;
const BAD_KEY = (boxId: string) => `device-bad:${boxId}`;
const ANSWER_MARGIN_MS = 15_000;
const RESULT_ASK_MS = 10_000;
const RESULT_POLL_MS = 1_000;

export interface DeviceBoxes {
  find(boxId: string): Promise<BoxRecord | null>;
  all(): Promise<BoxRecord[]>;
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null>;
  spawnOwn(box: BoxRecord, script: string, options?: { signal?: AbortSignal }): Promise<ByteChannel>;
  runOwn(box: BoxRecord, script: string, options: { stdin?: string | Uint8Array; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult>;
  restartDeviceServer?(box: BoxRecord, signal?: AbortSignal): Promise<boolean>;
}

export interface DeviceKv {
  get<T>(key: string): Promise<T | undefined | null>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface DeviceServersDeps {
  readonly boxes: DeviceBoxes;
  readonly kv: DeviceKv;
  readonly files: () => Promise<readonly ServerFile[]>;
  readonly personHasControl: (boxId: string) => boolean;
  readonly log: (line: string) => void;
  readonly logError: (operation: string, error: unknown) => void;
  readonly started?: number;
  readonly instance?: string;
  readonly version?: number;
  readonly helloWaitMs?: number;
  readonly idleCloseMs?: number;
  readonly deviceHubWaitMs?: number;
}

export type DeviceServerView =
  | { readonly is: "none" }
  | { readonly is: "connected"; readonly version: number; readonly protocol: number; readonly state: DeviceState; readonly bootedHere?: readonly ModelName[] }
  | { readonly is: "waiting"; readonly version: number | null; readonly for: number; readonly why: "person" | "recording" }
  | { readonly is: "down"; readonly words: string }
  | { readonly is: "superseded" };

interface Held {
  link: DeviceLink | null;
  view: DeviceServerView;
  idle: ReturnType<typeof setTimeout> | null;
  work: Promise<unknown>;
  owner: { readonly generation: number; readonly holder: ControlHolder } | null;
}


function waitedWords(box: BoxRecord, waitMs: number): string {
  const placement = placementOf(box);
  const where = placement.on === "slot" ? ` as its slot's user on the shared iOS host ${placement.host}` : "";
  return `it waited ${Math.round(waitMs / 1000)} s for box ${box.name} to answer a command over SSH${where}, and stopped waiting`;
}

export function wantsDevice(box: BoxRecord): boolean {
  const offer = box.capabilities.device;
  return box.state === "ready" && !!offer && (!isTestOffer(offer) || !!box.askedDevice || !!box.device);
}

function boxDevice(hello: DeviceHello, state: DeviceState): BoxDevice | null {
  const offered = (hello.devices as readonly OfferedDevice[]).find((device) => device.model === state.model);
  return offered ? ({ platform: hello.platform, model: state.model, runtime: offered.runtime } as BoxDevice) : null;
}

export class DeviceServers {
  readonly #deps: DeviceServersDeps;
  readonly #held = new Map<string, Held>();
  readonly started: number;
  readonly instance: string;
  readonly version: number;
  #disposed = false;
  #generation = 0;

  constructor(deps: DeviceServersDeps) {
    this.#deps = deps;
    this.started = deps.started ?? Date.now();
    this.instance = deps.instance ?? randomBytes(4).toString("hex");
    this.version = deps.version ?? DEVICE_SERVER_VERSION;
  }

  view(boxId: string): DeviceServerView {
    return this.#held.get(boxId)?.view ?? { is: "none" };
  }

  #entry(boxId: string): Held {
    let held = this.#held.get(boxId);
    if (!held) {
      held = { link: null, view: { is: "none" }, idle: null, work: Promise.resolve(), owner: null };
      this.#held.set(boxId, held);
    }
    return held;
  }

  #serial<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    const held = this.#entry(boxId);
    const run = held.work.then(task, task);
    held.work = run.catch(() => undefined);
    return run;
  }

  async startAll(): Promise<void> {
    for (const box of await this.#deps.boxes.all()) if (wantsDevice(box)) void this.ensure(box).catch((error) => this.#deps.logError(`device server of box ${box.name}`, error));
  }

  recorded(box: BoxRecord, deleted: boolean): void {
    if (deleted || box.state !== "ready") {
      void this.forget(box.id);
      return;
    }
    if (wantsDevice(box) && !this.#held.get(box.id)?.link) void this.ensure(box).catch((error) => this.#deps.logError(`device server of box ${box.name}`, error));
  }

  controlChanged(boxId: string): void {
    const held = this.#held.get(boxId);
    if (held?.view.is === "waiting" && held.view.why === "person" && !this.#deps.personHasControl(boxId)) {
      this.#retry(boxId);
      return;
    }
    const owner = this.#owner(boxId);
    if (!owner.changed) return;
    void this.#deps.boxes
      .find(boxId)
      .then(async (box) => {
        if (!box || !wantsDevice(box)) return;
        await this.ensure(box);
        await this.#tellOwner(box);
      })
      .catch((error) => this.#deps.logError("tell the device server who has control", error));
  }

  #nextGeneration(): number {
    this.#generation = Math.max(this.#generation + 1, Date.now());
    return this.#generation;
  }

  #owner(boxId: string): { readonly generation: number; readonly holder: ControlHolder; readonly changed: boolean } {
    const held = this.#entry(boxId);
    const holder: ControlHolder = this.#deps.personHasControl(boxId) ? "person" : "agent";
    if (held.owner?.holder === holder) return { ...held.owner, changed: false };
    held.owner = { generation: this.#nextGeneration(), holder };
    return { ...held.owner, changed: true };
  }

  async #tellOwner(box: BoxRecord): Promise<void> {
    const held = this.#held.get(box.id);
    const link = held?.link;
    if (!held || !link || link.closed || !link.hello.lease) return;
    const owner = this.#owner(box.id);
    const answer = await link.request({ type: "owner", generation: owner.generation, holder: owner.holder }, { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (!answer.ok) this.#deps.log(`Box ${box.name}'s device server did not take control's owner, ${owner.holder} at generation ${owner.generation}: ${answer.error.words}`);
  }

  async input(box: BoxRecord, input: DeviceInput): Promise<DeviceAnswer> {
    if (this.#deps.personHasControl(box.id)) return { id: "", ok: false, error: { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS }, state: this.#held.get(box.id)?.link?.state ?? null };
    await this.ensure(box);
    const link = this.#held.get(box.id)?.link;
    if (!link || link.closed) return { id: "", ok: false, error: { code: "not-booted", words: `Box ${box.name}'s device server is not connected.` }, state: null };
    const owner = this.#owner(box.id);
    if (owner.changed) await this.#tellOwner(box);
    this.#touch(box.id);
    return link.request({ type: "input", input, owner: owner.generation }, { timeoutMs: SCRIPT_TIMEOUT_MS });
  }

  screenshot(box: BoxRecord): Promise<DeviceAnswer> {
    return this.read(box, { type: "screenshot" });
  }

  async read(box: BoxRecord, request: DeviceRead): Promise<DeviceAnswer> {
    const link = await this.#controlLink(box);
    if (!link) return { id: "", ok: false, error: { code: "not-booted", words: `Box ${box.name}'s device server is not connected.` }, state: null };
    this.#touch(box.id);
    return link.request(request, { timeoutMs: SCRIPT_TIMEOUT_MS });
  }

  async freshSettings(box: BoxRecord, waitMs = FRESH_SETTINGS_WAIT_MS): Promise<void> {
    const held = this.#held.get(box.id);
    const link = held?.link;
    if (!held || !link || held.view.is !== "connected" || held.view.version < SETTINGS_ASKED_SINCE_VERSION || held.view.state.power.is !== "booted") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
    try {
      const answer = await Promise.race([link.request({ type: "settings" }, { timeoutMs: waitMs }).catch(() => null), late]);
      if (answer?.ok && answer.state && held.view.is === "connected") held.view = { ...held.view, state: answer.state };
    } finally {
      clearTimeout(timer);
    }
  }

  async agentRequest(box: BoxRecord, request: DeviceAgentRequest): Promise<DeviceAnswer> {
    if (this.#deps.personHasControl(box.id)) return { id: "", ok: false, error: { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS }, state: this.#lastState(box.id) };
    const link = await this.#controlLink(box);
    if (!link) return { id: "", ok: false, error: { code: "not-booted", words: `Box ${box.name}'s device server is not connected.` }, state: null };
    const owner = this.#owner(box.id);
    if (owner.changed) await this.#tellOwner(box);
    this.#touch(box.id);
    return link.request(request, { timeoutMs: SCRIPT_TIMEOUT_MS });
  }

  async record(box: BoxRecord, request: Extract<DeviceRequestBody, { readonly type: "record" }>): Promise<DeviceAnswer> {
    const link = await this.#controlLink(box);
    if (!link) return { id: "", ok: false, error: { code: "not-booted", words: `Box ${box.name}'s device server is not connected.` }, state: null };
    this.#touch(box.id);
    return link.request(request, { timeoutMs: SCRIPT_TIMEOUT_MS });
  }

  async control(box: BoxRecord, control: DeviceControl, options: { readonly id?: string; readonly signal?: AbortSignal } = {}): Promise<DeviceAnswer> {
    const id = options.id ?? newRequestId();
    const last = () => this.#lastState(box.id);
    if (control.action !== "install" && this.#deps.personHasControl(box.id)) return { id, ok: false, error: { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS }, state: last() };
    const deadline = controlDeadlineMs(control) + ANSWER_MARGIN_MS;
    const began = Date.now();
    const link = await this.#controlLink(box);
    if (!link) return { id, ok: false, error: { code: "not-booted", words: `Box ${box.name}'s device server is not connected.` }, state: null };
    const owner = this.#owner(box.id);
    if (owner.changed) await this.#tellOwner(box);
    this.#touch(box.id);
    try {
      const answer = await link.request({ type: "control", control }, { id, timeoutMs: deadline });
      if (answer.ok || answer.error.code !== "in-progress") return answer;
    } catch (error) {
      if (!(error instanceof DeviceLinkError)) throw error;
      this.#deps.log(`Box ${box.name}'s device server: the connection ended during request ${id} (${error.message}); asking for its result again`);
    }
    while (Date.now() - began < deadline && !options.signal?.aborted) {
      const again = await this.#controlLink(box).catch(() => null);
      if (again) {
        const answer = await again.request({ type: "result" }, { id, timeoutMs: RESULT_ASK_MS }).catch(() => null);
        if (answer && (answer.ok || answer.error.code !== "in-progress")) return answer;
      }
      await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS));
    }
    return { id, ok: false, error: { code: "outcome-unknown", words: lostWords(control.action, last()) }, state: last() };
  }

  #lastState(boxId: string): DeviceState | null {
    const link = this.#held.get(boxId)?.link;
    if (link) return link.state;
    const view = this.view(boxId);
    return view.is === "connected" ? view.state : null;
  }

  async #controlLink(box: BoxRecord): Promise<DeviceLink | null> {
    await this.ensure(box);
    const link = this.#held.get(box.id)?.link;
    return link && !link.closed ? link : null;
  }

  #retry(boxId: string): void {
    void this.#deps.boxes
      .find(boxId)
      .then((box) => (box && wantsDevice(box) ? this.ensure(box) : null))
      .catch((error) => this.#deps.logError("deliver the device server", error));
  }

  recordingEnded(boxId: string): void {
    const held = this.#held.get(boxId);
    if (held?.view.is !== "waiting" || held.view.why !== "recording") return;
    this.#retry(boxId);
  }

  ensure(box: BoxRecord): Promise<DeviceServerView> {
    return this.#serial(box.id, () => this.#ensure(box));
  }

  #touch(boxId: string): void {
    const held = this.#entry(boxId);
    if (held.idle) clearTimeout(held.idle);
    held.idle = setTimeout(() => void this.#closeIdle(boxId), this.#deps.idleCloseMs ?? IDLE_CLOSE_MS);
    held.idle.unref?.();
  }

  async #closeIdle(boxId: string): Promise<void> {
    const held = this.#held.get(boxId);
    if (!held?.link) return;
    const link = held.link;
    held.link = null;
    await link.close();
  }

  async forget(boxId: string): Promise<void> {
    const held = this.#held.get(boxId);
    if (!held) return;
    this.#held.delete(boxId);
    if (held.idle) clearTimeout(held.idle);
    await held.link?.close();
  }

  async #open(box: BoxRecord): Promise<DeviceLink> {
    const channel = await this.#deps.boxes.spawnOwn(box, connectScript());
    return DeviceLink.open(channel, {
      role: "control",
      started: this.started,
      instance: this.instance,
      helloWaitMs: this.#deps.helloWaitMs,
      onState: (state) => void this.#copied(box, state).catch((error) => this.#deps.logError("record the device", error)),
      onClosed: (why) => this.#linkClosed(box, why),
    });
  }

  #linkClosed(box: BoxRecord, why: { readonly superseded: boolean; readonly words: string }): void {
    const held = this.#held.get(box.id);
    if (!held || this.#disposed) return;
    held.link = null;
    if (why.superseded) {
      held.view = { is: "superseded" };
      this.#deps.log(`Box ${box.name}'s device server: a bb-box instance started later holds it now, so this one lets it be.`);
    }
  }

  async #status(box: BoxRecord): Promise<ServerStatus> {
    const result = await this.#deps.boxes.runOwn(box, statusScript(), { timeoutMs: SCRIPT_TIMEOUT_MS });
    return parseStatus(result.exitCode, result.stdout, result.stderr);
  }

  async #copied(box: BoxRecord, state: DeviceState, hello?: DeviceHello): Promise<void> {
    const held = this.#held.get(box.id);
    const link = held?.link;
    const source = hello ?? link?.hello;
    if (!source) return;
    if (held?.view.is === "connected") held.view = { ...held.view, state };
    const device = boxDevice(source, state);
    if (!device) return;
    const same = (current: BoxRecord) => JSON.stringify(current.device ?? null) === JSON.stringify(device);
    const current = await this.#deps.boxes.find(box.id);
    if (!current || same(current)) return;
    await this.#deps.boxes.update(current, () => ({ device }));
  }

  #intentFor(box: BoxRecord): Intent | null {
    const offer = box.capabilities.device;
    if (!offer) return null;
    const target = box.askedDevice && (offer.devices as readonly OfferedDevice[]).some((device) => device.model === box.askedDevice) ? box.askedDevice : offer.devices[0].model;
    return { target, switching: null } as Intent;
  }

  async #bad(boxId: string): Promise<number | null> {
    const bad = await this.#deps.kv.get<number>(BAD_KEY(boxId));
    return typeof bad === "number" ? bad : null;
  }

  async badVersion(boxId: string): Promise<number | null> {
    return this.#bad(boxId);
  }

  async #ensure(box: BoxRecord): Promise<DeviceServerView> {
    if (this.#disposed) return { is: "none" };
    const held = this.#entry(box.id);
    if (held.view.is === "superseded") return held.view;
    if (held.link && !held.link.closed) {
      this.#touch(box.id);
      if (held.view.is !== "waiting" || !held.link.hello.lease) return held.view;
      return this.#deliverIfAllowed(box, held, held.link.hello.version, `it runs version ${held.link.hello.version}`);
    }
    let link: DeviceLink | null = null;
    try {
      link = await this.#open(box);
    } catch (error) {
      if (error instanceof DeviceLinkError && /^superseded/.test(error.message)) {
        held.view = { is: "superseded" };
        return held.view;
      }
      const status: ServerStatus = await this.#status(box).catch(() => ({ none: false, version: null, words: null }));
      if (status.words) {
        const told = held.view.is === "down" && held.view.words === status.words;
        held.view = { is: "down", words: status.words };
        if (!told) this.#deps.log(`Box ${box.name}'s device server is down: ${status.words}`);
        if (status.version !== null && status.version >= this.version) return held.view;
        return this.#deliverIfAllowed(box, held, status.version, `its service manager gave up on version ${status.version ?? "unknown"}`);
      }
      if (status.none) return this.#deliverIfAllowed(box, held, null, "it has none yet");
      if (inSlot(box) && (await this.#askHost(box))) {
        held.view = { is: "down", words: ASKED_HOST_WORDS };
        return held.view;
      }
      held.view = { is: "down", words: error instanceof Error ? error.message : String(error) };
      return this.#deliverIfAllowed(box, held, null, "it did not say hello");
    }
    const hello = link.hello;
    held.link = link;
    held.view = { is: "connected", version: hello.version, protocol: hello.protocol, state: hello.state, bootedHere: hello.bootedHere };
    this.#touch(box.id);
    await this.#copied(box, hello.state, hello);
    await this.#tellOwner(box).catch((error) => this.#deps.logError("tell the device server who has control", error));
    await this.#capSlot(box, link).catch((error) => this.#deps.logError("cap a shared box's video", error));
    const older = hello.version < this.version;
    const foreign = !speaksProtocol(hello.protocol);
    if (!older && !foreign) return held.view;
    if (!hello.lease) return held.view;
    return this.#deliverIfAllowed(box, held, hello.version, older ? `it runs version ${hello.version}` : `it speaks protocol ${hello.protocol}`);
  }

  async #askHost(box: BoxRecord): Promise<boolean> {
    try {
      const asked = (await this.#deps.boxes.restartDeviceServer?.(box)) ?? false;
      if (asked) this.#deps.log(`Box ${box.name}'s device server has not started; bb-box asked its shared iOS host to start it again.`);
      return asked;
    } catch (error) {
      this.#deps.logError(`ask box ${box.name}'s host to start its device server`, error);
      return false;
    }
  }

  async #capSlot(box: BoxRecord, link: DeviceLink): Promise<void> {
    if (!inSlot(box) || !link.hello.lease) return;
    const answer = await link.request({ type: "cap", most: SLOT_STREAM_CAP }, { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (!answer.ok) this.#deps.log(`Box ${box.name}'s device server did not take the cap at ${SLOT_STREAM_CAP}: ${answer.error.words}`);
  }

  async #deliverIfAllowed(box: BoxRecord, held: Held, running: number | null, why: string): Promise<DeviceServerView> {
    const bad = await this.#bad(box.id);
    if (bad !== null && bad >= this.version) {
      if (held.view.is === "none") held.view = { is: "down", words: `Version ${this.version} of the device server did not answer in this box, so bb-box does not deliver it again.` };
      return held.view;
    }
    if (this.#deps.personHasControl(box.id)) return this.#wait(box, held, running, "person");
    return this.#deliver(box, held, running, why);
  }

  #wait(box: BoxRecord, held: Held, running: number | null, why: "person" | "recording"): DeviceServerView {
    const already = held.view.is === "waiting";
    held.view = { is: "waiting", version: running, for: this.version, why };
    if (!already) this.#deps.log(`Box ${box.name}'s device server waits for version ${this.version} until ${why === "person" ? "the person hands back control" : "the recording ends"}.`);
    return held.view;
  }

  async #run(box: BoxRecord, script: string, stdin?: string | Uint8Array): Promise<RunResult> {
    return this.#deps.boxes.runOwn(box, script, { stdin, timeoutMs: SCRIPT_TIMEOUT_MS });
  }

  async #deliver(box: BoxRecord, held: Held, running: number | null, why: string): Promise<DeviceServerView> {
    const files = await this.#deps.files();
    const offer = box.capabilities.device!;
    const began = Date.now();
    const link = held.link;
    held.link = null;
    const result = await this.#run(box, deliveryScript(this.version), deliveryStdin({ version: this.version, files, offer, intent: this.#intentFor(box), choices: { slim: box.slim !== false } }));
    if (result.exitCode === DELIVERY_EXITS.recording) {
      held.link = link;
      return this.#wait(box, held, running, "recording");
    }
    await link?.close();
    if (result.exitCode !== DELIVERY_EXITS.delivered) {
      const words = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`).split("\n").slice(-3).join(" ");
      held.view = { is: "down", words };
      this.#deps.log(`Box ${box.name}'s device server: delivering version ${this.version} failed: ${words}`);
      return held.view;
    }
    this.#deps.log(`Box ${box.name}'s device server: delivered version ${this.version}, as ${why}.`);
    for (let attempt = 1; attempt <= HELLO_TRIES; attempt++) {
      try {
        const fresh = await this.#open(box);
        held.link = fresh;
        held.view = { is: "connected", version: fresh.hello.version, protocol: fresh.hello.protocol, state: fresh.hello.state, bootedHere: fresh.hello.bootedHere };
        this.#touch(box.id);
        await this.#copied(box, fresh.hello.state, fresh.hello);
        await this.#tellOwner(box).catch((error) => this.#deps.logError("tell the device server who has control", error));
        await this.#capSlot(box, fresh).catch((error) => this.#deps.logError("cap a shared box's video", error));
        this.#deps.log(`Box ${box.name}'s device server: version ${fresh.hello.version} said hello ${((Date.now() - began) / 1000).toFixed(1)} s after its delivery.`);
        return held.view;
      } catch (error) {
        const words = error instanceof Error ? error.message : String(error);
        this.#deps.log(`Box ${box.name}'s device server: version ${this.version} did not say hello (try ${attempt} of ${HELLO_TRIES}): ${words}`);
        if (attempt < HELLO_TRIES) await this.#run(box, restartScript()).catch(() => undefined);
      }
    }
    await this.#deps.kv.set(BAD_KEY(box.id), this.version);
    const back = await this.#run(box, rollbackScript());
    if (back.exitCode !== 0) {
      const words = back.stderr.trim() || `exit code ${back.exitCode}`;
      held.view = { is: "down", words: `Version ${this.version} did not answer, and going back failed: ${words}` };
      this.#deps.log(`Box ${box.name}'s device server: version ${this.version} did not answer, and going back failed: ${words}`);
      return held.view;
    }
    this.#deps.log(`Box ${box.name}'s device server: version ${this.version} did not answer within ${(this.#deps.helloWaitMs ?? 10_000) / 1000} s twice, so the box went back to its last version, and version ${this.version} is marked bad for it.`);
    try {
      const restored = await this.#open(box);
      held.link = restored;
      held.view = { is: "connected", version: restored.hello.version, protocol: restored.hello.protocol, state: restored.hello.state, bootedHere: restored.hello.bootedHere };
      this.#touch(box.id);
      await this.#tellOwner(box).catch((error) => this.#deps.logError("tell the device server who has control", error));
      await this.#capSlot(box, restored).catch((error) => this.#deps.logError("cap a shared box's video", error));
      return held.view;
    } catch (error) {
      held.view = { is: "down", words: error instanceof Error ? error.message : String(error) };
      return held.view;
    }
  }

  async checks(): Promise<DoctorCheck[]> {
    const boxes = (await this.#deps.boxes.all()).filter(wantsDevice);
    return (await Promise.all(boxes.map((box) => this.#boxChecks(box)))).flat();
  }

  async #boxChecks(box: BoxRecord): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const id = `device.${box.name}` as DoctorCheck["id"];
    const name = `Device server of ${box.name}`;
    const view = this.view(box.id);
    const bad = await this.#bad(box.id);
    const badWords = bad !== null ? ` Version ${bad} did not answer in this box, so it went back, and bb-box delivers no version before ${bad + 1} to it.` : "";
    if (view.is === "connected") {
      const behind = view.version < this.version;
      checks.push({
        id,
        name,
        status: behind || bad !== null ? "warn" : "ok",
        detail: `Version ${view.version}, protocol ${view.protocol}: the ${view.state.model}, ${view.state.power.is}.${behind && bad === null ? ` This bb-box delivers version ${this.version} when it next connects as the box's lease holder.` : ""}${badWords}`,
        fix: bad !== null ? `Read ~/.bb-box/device/server.log in box ${box.name} for why version ${bad} did not answer.` : null,
      });
    } else if (view.is === "waiting") {
      checks.push({ id, name, status: "ok", detail: `Version ${view.version ?? "none"}; version ${view.for} waits until ${view.why === "person" ? "the person hands back control" : "the recording ends"}.`, fix: null });
    } else if (view.is === "down") {
      checks.push({ id, name, status: "fail", detail: view.words + badWords, fix: `Read ~/.bb-box/device/server.log in box ${box.name}. Once the cause is fixed, sh ~/.bb-box/device/current/src/device/bb-box-device.sh restart in the box starts it again, as a newer bb-box's delivery does.` });
    } else if (view.is === "superseded") {
      checks.push({ id, name, status: "ok", detail: "A bb-box instance started later holds this box's device.", fix: null });
    } else {
      checks.push({ id, name, status: "skipped", detail: "bb-box has not connected to it since it started.", fix: null });
    }
    if (box.capabilities.device?.platform === "ios" && !isTestOffer(box.capabilities.device)) checks.push(await this.#deviceHubCheck(box));
    return checks;
  }

  async #deviceHubCheck(box: BoxRecord): Promise<DoctorCheck> {
    const id = `device-hub.${box.name}` as DoctorCheck["id"];
    const name = `Device Hub in ${box.name}`;
    let seen: DeviceHubSeen | null = null;
    let why = "";
    const waitMs = this.#deps.deviceHubWaitMs ?? DEVICE_HUB_CHECK_MS;
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), waitMs);
    try {
      const gaveUp = new Promise<never>((_, reject) => bound.signal.addEventListener("abort", () => reject(new Error(waitedWords(box, waitMs))), { once: true }));
      seen = parseDeviceHub((await Promise.race([this.#deps.boxes.runOwn(box, deviceHubScript(), { timeoutMs: waitMs, signal: bound.signal }), gaveUp])).stdout);
    } catch (error) {
      why = bound.signal.aborted ? `: ${waitedWords(box, waitMs)}` : `: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      clearTimeout(timer);
    }
    if (!seen) return { id, name, status: "skipped", detail: `bb-box could not look in box ${box.name}${why}.`, fix: null };
    const kills = seen.killed ? ` The device server has killed it ${seen.killed === 1 ? "once" : `${seen.killed} times`}, last at ${new Date(seen.last ?? 0).toISOString().slice(0, 16).replace("T", " ")} UTC: Xcode's Run opens it.` : "";
    if (seen.running) {
      return {
        id,
        name,
        status: "fail",
        detail: `Device Hub runs on box ${box.name}'s macOS host. It takes the device's pasteboard, so pasting into the device stops working.${kills}`,
        fix: `The device server kills it within 5 s. If it stays, its server is not running: read ~/.bb-box/device/server.log in box ${box.name}. Do not quit Device Hub: quitting it shuts the device down.`,
      };
    }
    return { id, name, status: "ok", detail: `Device Hub is not running.${kills}`, fix: null };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const [boxId] of this.#held) await this.forget(boxId);
  }
}
