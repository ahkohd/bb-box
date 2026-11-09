import { randomBytes } from "node:crypto";
import type { BoxRecord, SpareSettling } from "../core/boxes.ts";
import { CLIPBOARD_READ_SINCE_VERSION, DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, listWords, SETTINGS_ASKED_SINCE_VERSION, VIDEO_REPORTS_SINCE_VERSION, deviceModel, isTestOffer, speaksProtocol, type BoxDevice, type ControlHolder, type DeviceAgentRequest, type DeviceAnswer, type DeviceControl, type DeviceOffer, type DeviceRead, type DeviceHello, type DeviceInput, type DeviceState, type Intent, type ModelName, type OfferedDevice, type VideoReport, type VideoStep } from "../core/device.ts";
import { DELIVERY_EXITS, connectScript, deliveryScript, deviceHubScript, parseDeviceHub, type DeviceHubSeen, deliveryStdin, parseStatus, restartScript, rollbackScript, statusScript, type DeviceChoices, iosEncoderChoice, type ServerFile, type ServerStatus } from "../core/device-delivery.ts";
import { lostWords } from "../core/device-control.ts";
import { controlDeadlineMs } from "../core/device-settings.ts";
import { belowLeast } from "../core/sizes.ts";
import { DeviceLink, DeviceLinkError, newRequestId, type DeviceRequestBody } from "../core/device-link.ts";
import type { ByteChannel, RunResult } from "../transports/types.ts";
import type { DoctorCheck } from "../backends/types.ts";
import { inSlot, placementOf } from "../core/device-host.ts";
import { NO_DECISION, type Decision, type EncoderLedgers, type EncoderPlace } from "../core/encoder-ledger.ts";
import { PRODUCT } from "../brand.ts";


export const IDLE_CLOSE_MS = 10 * 60_000;
export const SLOT_STREAM_CAP: VideoStep = "two-thirds";
export const ASKED_HOST_WORDS = `The device server for this box has not started. ${PRODUCT} has asked the host to start it again.`;
export const HELLO_TRIES = 2;
export const DEVICE_COPY_NEEDS_CONTROL_WORDS = "Take control first, then copy: only the tab with control reads the device's clipboard.";
const SCRIPT_TIMEOUT_MS = 60_000;
const DEVICE_HUB_CHECK_MS = 15_000;
export const FRESH_SETTINGS_WAIT_MS = 3_000;
const DOCTOR_STATE_WAIT_MS = 3_000;
const BAD_KEY = (boxId: string) => `device-bad:${boxId}`;
const ANSWER_MARGIN_MS = 15_000;
const RESULT_ASK_MS = 10_000;
const RESULT_POLL_MS = 1_000;
export const SPARE_SETTLE_WAIT_MS = 60_000;
export const SPARE_BOOT_MOST_MS = 10 * 60_000;
export const CLAIM_BOOT_WAIT_MS = 120_000;
const DEVICE_POLL_MS = 250;

export interface DeviceBoxes {
  find(boxId: string): Promise<BoxRecord | null>;
  all(): Promise<BoxRecord[]>;
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null>;
  spawnOwn(box: BoxRecord, script: string, options?: { signal?: AbortSignal }): Promise<ByteChannel>;
  runOwn(box: BoxRecord, script: string, options: { stdin?: string | Uint8Array; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult>;
  restartDeviceServer?(box: BoxRecord, signal?: AbortSignal): Promise<boolean>;
  encoderOf?(box: BoxRecord): EncoderPlace | null;
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
  readonly ledger?: EncoderLedgers;
  readonly iosEncoder?: () => "auto" | "hardware" | "software";
  readonly log: (line: string) => void;
  readonly logError: (operation: string, error: unknown) => void;
  readonly started?: number;
  readonly instance?: string;
  readonly version?: number;
  readonly helloWaitMs?: number;
  readonly idleCloseMs?: number;
  readonly deviceHubWaitMs?: number;
  readonly deviceStateWaitMs?: number;
  readonly spareSettleWaitMs?: number;
  readonly spareBootMostMs?: number;
  readonly claimBootWaitMs?: number;
}

export type ClaimSwitch =
  | { readonly is: "switching"; readonly from: ModelName; readonly to: ModelName }
  | { readonly is: "switched"; readonly from: ModelName; readonly to: ModelName; readonly ms: number }
  | { readonly is: "failed"; readonly from: ModelName | null; readonly to: ModelName; readonly words: string };

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
  linkEnded?: { readonly at: number; readonly idle: true } | { readonly at: number; readonly idle: false; readonly words: string };
}

export function hostCheckWords(box: BoxRecord): string {
  const placement = placementOf(box);
  if (placement.on !== "slot") return "";
  return placement.hostOn === "tart" ? " The check of shared iOS hosts says whether its host's VM runs." : " The iOS slots check of its Mac says how the Mac's slots are.";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcWords(at: number): string {
  return `${new Date(at).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}


function waitedWords(box: BoxRecord, waitMs: number): string {
  const placement = placementOf(box);
  const where = placement.on === "slot" ? ` as its slot's user on the shared iOS host ${placement.host}` : "";
  return `it waited ${Math.round(waitMs / 1000)} s for box ${box.name} to answer a command over SSH${where}, and stopped waiting`;
}

function videoWanted(video: VideoReport | null): boolean {
  return !!video && (video.step !== null || video.wants.length > 0);
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
  readonly #claimSwitches = new Map<string, ClaimSwitch>();
  readonly #priming = new Map<string, Promise<void>>();
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
    if (deleted) {
      this.#claimSwitches.delete(box.id);
      this.#priming.delete(box.id);
    }
    if (deleted || box.state !== "ready") {
      void this.forget(box.id);
      return;
    }
    if (wantsDevice(box) && !this.#held.get(box.id)?.link) void this.ensure(box).catch((error) => this.#deps.logError(`device server of box ${box.name}`, error));
  }

  controlChanged(boxId: string): void {
    this.#deps.ledger?.controlChanged(boxId);
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

  async clipboard(box: BoxRecord): Promise<{ readonly text: string | null; readonly error: string | null }> {
    const view = await this.ensure(box);
    if (view.is === "connected" && view.version < CLIPBOARD_READ_SINCE_VERSION) {
      return { text: null, error: `Box ${box.name}'s device server is version ${view.version}, which cannot read the device's clipboard. ${PRODUCT} delivers version ${this.version} once no person has control and no recording runs.` };
    }
    const answer = await this.read(box, { type: "clipboard" });
    if (!answer.ok) return { text: null, error: answer.error.words };
    return answer.result.type === "clipboard" ? { text: answer.result.text, error: null } : { text: null, error: "The device server answered without the clipboard." };
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

  async #stateNow(boxId: string, waitMs: number): Promise<DeviceState | null> {
    const held = this.#held.get(boxId);
    const link = held?.link;
    if (!held || !link || link.closed || held.view.is !== "connected") return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), waitMs)));
    try {
      const answer = await Promise.race([link.request({ type: "settings" }, { timeoutMs: waitMs }).catch(() => null), late]);
      if (!answer) return null;
      if (answer.state && held.view.is === "connected") held.view = { ...held.view, state: answer.state };
      return held.view.is === "connected" ? held.view.state : null;
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
    const switchingTo = control.action === "switch" ? control.device : null;
    const tooSmall = switchingTo && box.guest?.size ? belowLeast(box.kind, box.guest.size, undefined, switchingTo) : null;
    if (tooSmall) return { id, ok: false, error: { code: "unsupported", words: `${tooSmall} Box ${box.name} stays on its device; acquire a box of at least that size for the ${switchingTo}.` }, state: last() };
    const deadline = controlDeadlineMs(control, undefined, last()) + ANSWER_MARGIN_MS;
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

  async spareSettled(box: BoxRecord): Promise<SpareSettling> {
    if (!wantsDevice(box)) return { is: "settled" };
    const began = Date.now();
    await this.ensure(box);
    for (;;) {
      const view = this.view(box.id);
      if (view.is === "connected" && view.state.power.is === "booted") {
        await this.#everyModelBootedOnce(box);
        const after = this.view(box.id);
        if (after.is === "connected" && after.state.power.is === "booted") return { is: "settled" };
        continue;
      }
      if (view.is === "connected" && view.state.power.is === "failed") return { is: "failed", words: `its ${view.state.model} did not boot: ${view.state.power.error.words}` };
      if (this.#disposed || Date.now() - began >= (this.#deps.spareSettleWaitMs ?? SPARE_SETTLE_WAIT_MS)) break;
      await sleep(DEVICE_POLL_MS);
      if (this.view(box.id).is !== "connected") await this.ensure(box);
    }
    const sinceReady = Date.now() - (box.readyAt ?? box.createdAt);
    const most = this.#deps.spareBootMostMs ?? SPARE_BOOT_MOST_MS;
    if (sinceReady < most) return { is: "settling" };
    const view = this.view(box.id);
    const why = view.is === "down" ? `: its device server is down: ${view.words}` : "";
    return { is: "failed", words: `its device had not booted ${Math.round(sinceReady / 60_000)} minutes after the box was ready${why}` };
  }

  #everyModelBootedOnce(box: BoxRecord): Promise<void> {
    let priming = this.#priming.get(box.id);
    if (!priming) {
      priming = this.#bootEachModelOnce(box).catch((error) => this.#deps.logError(`boot spare ${box.name}'s devices once each`, error));
      this.#priming.set(box.id, priming);
    }
    return priming;
  }

  async #bootEachModelOnce(box: BoxRecord): Promise<void> {
    const offer = box.capabilities.device;
    const first = this.view(box.id);
    if (!offer || first.is !== "connected") return;
    const held = first.state.model;
    const bootedHere = new Set<ModelName>([...(first.bootedHere ?? []), held]);
    const stillSpare = async () => !this.#disposed && (await this.#deps.boxes.find(box.id))?.threadId === box.threadId;
    const unbooted = (offer.devices as readonly OfferedDevice[]).map((device) => device.model).filter((model) => !bootedHere.has(model));
    if (!unbooted.length) return;
    const began = Date.now();
    for (const model of [...unbooted, held]) {
      if (!(await stillSpare())) return;
      const answer = await this.control(box, { action: "switch", device: model });
      if (!answer.ok) {
        this.#deps.log(`Spare box ${box.name} did not boot the ${model} once ahead: ${answer.error.words}`);
        if (model === held) return;
      }
    }
    this.#deps.log(`Spare box ${box.name} booted the ${listWords(unbooted)} once each and is back on the ${held}, in ${Math.round((Date.now() - began) / 1000)} s, so a claim of any of its devices switches as one booted before.`);
  }

  claimSwitch(boxId: string): ClaimSwitch | null {
    return this.#claimSwitches.get(boxId) ?? null;
  }

  async switchClaimed(box: BoxRecord): Promise<ClaimSwitch | null> {
    const asked = box.askedDevice ?? box.capabilities.device?.devices[0].model;
    if (!asked || !wantsDevice(box)) return null;
    await this.#priming.get(box.id);
    const began = Date.now();
    const deadline = began + (this.#deps.claimBootWaitMs ?? CLAIM_BOOT_WAIT_MS);
    let model: ModelName | null = null;
    while (Date.now() < deadline && !this.#disposed) {
      const view = this.view(box.id).is === "connected" ? this.view(box.id) : await this.ensure(box);
      if (view.is === "connected" && view.state.power.is === "booted") {
        model = view.state.model;
        break;
      }
      if (view.is === "connected" && view.state.power.is === "failed") break;
      await sleep(DEVICE_POLL_MS);
    }
    if (model === asked) return null;
    if (model === null) {
      const failed: ClaimSwitch = { is: "failed", from: null, to: asked, words: `the spare's device had not booted ${Math.round((Date.now() - began) / 1000)} s after the claim, so ${PRODUCT} did not switch it` };
      this.#claimSwitches.set(box.id, failed);
      this.#deps.log(`Box ${box.name}, a claimed spare: ${failed.words}.`);
      return failed;
    }
    this.#claimSwitches.set(box.id, { is: "switching", from: model, to: asked });
    this.#deps.log(`Box ${box.name}, a claimed spare, has the ${model}; switching it to the ${asked}, which its thread asked for.`);
    const switchBegan = Date.now();
    const answer = await this.control(box, { action: "switch", device: asked }).catch(
      (error): DeviceAnswer => ({ id: "", ok: false, error: { code: "failed", words: error instanceof Error ? error.message : String(error) }, state: null }),
    );
    const outcome: ClaimSwitch = answer.ok
      ? { is: "switched", from: model, to: asked, ms: Date.now() - switchBegan }
      : { is: "failed", from: answer.state?.model ?? model, to: asked, words: answer.error.words };
    this.#claimSwitches.set(box.id, outcome);
    if (outcome.is === "switched") {
      this.#deps.log(`Box ${box.name}, a claimed spare, switched from the ${model} to the ${asked} in ${outcome.ms} ms.`);
      await this.#deps.boxes.update(box, ({ timings }) => ({ timings: { ...timings, spareSwitch: outcome.ms } })).catch((error) => this.#deps.logError("record a claimed spare's switch", error));
    } else this.#deps.log(`Box ${box.name}, a claimed spare, did not switch from the ${model} to the ${asked}: ${outcome.words}`);
    return outcome;
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
    if (this.#deps.ledger?.on && videoWanted(held.link.video)) {
      this.#touch(boxId);
      return;
    }
    const link = held.link;
    held.link = null;
    await link.close();
    held.linkEnded = { at: Date.now(), idle: true };
  }

  async forget(boxId: string): Promise<void> {
    const held = this.#held.get(boxId);
    if (!held) return;
    this.#held.delete(boxId);
    this.#deps.ledger?.forget(boxId);
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
      onVideo: (video) => this.#videoReported(box, video),
      onClosed: (why) => this.#linkClosed(box, why),
    });
  }

  #videoReported(box: BoxRecord, video: VideoReport): void {
    const ledger = this.#deps.ledger;
    const offer = box.capabilities.device;
    if (!ledger || offer?.platform !== "ios" || isTestOffer(offer)) return;
    const place = this.#deps.boxes.encoderOf?.(box) ?? null;
    if (!place) return;
    const model = deviceModel(this.#held.get(box.id)?.link?.state.model ?? box.device?.model ?? offer.devices[0].model);
    if (model.form === "foldable") return;
    ledger.report(box, place, { pixels: model.screen.pixels, wants: video.wants, fps: video.fps, ...(video.encoding ? { encoding: video.encoding } : {}) });
  }

  decided(boxId: string, decision: Decision): void {
    if (!this.#deps.ledger?.on) return;
    const held = this.#held.get(boxId);
    const link = held?.link;
    if (!link || link.closed || !link.hello.lease) return;
    void this.#deps.boxes
      .find(boxId)
      .then((box) => (box ? this.#capVideo(box, link, decision) : undefined))
      .catch((error) => this.#deps.logError("cap a device's video", error));
  }

  encoderWords(box: BoxRecord): string | null {
    return this.#deps.ledger?.roomWords(box.id) ?? null;
  }

  ledgerSwitched(): void {
    this.#deps.ledger?.refresh();
    for (const [boxId, held] of this.#held) {
      const link = held.link;
      if (!link || link.closed || !link.hello.lease) continue;
      void this.#deps.boxes
        .find(boxId)
        .then((box) => (box ? this.#capSlot(box, link) : undefined))
        .catch((error) => this.#deps.logError("cap a device's video", error));
    }
  }

  #linkClosed(box: BoxRecord, why: { readonly superseded: boolean; readonly words: string }): void {
    const held = this.#held.get(box.id);
    if (!held || this.#disposed) return;
    held.link = null;
    held.linkEnded = { at: Date.now(), idle: false, words: why.words };
    this.#deps.ledger?.forget(box.id);
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
    if (!link.hello.lease) return;
    const ledger = this.#deps.ledger;
    if (ledger?.on && link.hello.version >= VIDEO_REPORTS_SINCE_VERSION) {
      await this.#capVideo(box, link, ledger.decision(box.id));
      return;
    }
    if (inSlot(box)) await this.#capVideo(box, link, { cap: SLOT_STREAM_CAP, words: null });
    else if (link.hello.version >= VIDEO_REPORTS_SINCE_VERSION) await this.#capVideo(box, link, NO_DECISION);
  }

  async #capVideo(box: BoxRecord, link: DeviceLink, decision: Decision): Promise<void> {
    const words = link.hello.version >= VIDEO_REPORTS_SINCE_VERSION ? { words: decision.words } : {};
    const answer = await link.request({ type: "cap", most: decision.cap, ...words }, { timeoutMs: SCRIPT_TIMEOUT_MS });
    if (!answer.ok) this.#deps.log(`Box ${box.name}'s device server did not take the cap at ${decision.cap ?? "nothing"}: ${answer.error.words}`);
  }

  async #deliverIfAllowed(box: BoxRecord, held: Held, running: number | null, why: string): Promise<DeviceServerView> {
    const bad = await this.#bad(box.id);
    if (bad !== null && bad >= this.version) {
      if (held.view.is === "none") held.view = { is: "down", words: `Version ${this.version} of the device server did not answer in this box, so ${PRODUCT} does not deliver it again.` };
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

  #choicesFor(box: BoxRecord, offer: DeviceOffer): DeviceChoices {
    const slim = box.slim !== false;
    if (offer.platform !== "ios") return { slim };
    return { slim, iosEncoder: iosEncoderChoice(this.#deps.iosEncoder?.() ?? "auto", this.#deps.boxes.encoderOf?.(box)?.hardware) };
  }

  async #deliver(box: BoxRecord, held: Held, running: number | null, why: string): Promise<DeviceServerView> {
    const files = await this.#deps.files();
    const offer = box.capabilities.device!;
    const began = Date.now();
    const link = held.link;
    held.link = null;
    const result = await this.#run(box, deliveryScript(this.version), deliveryStdin({ version: this.version, files, offer, intent: this.#intentFor(box), choices: this.#choicesFor(box, offer) }));
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
    return [...(await Promise.all(boxes.map((box) => this.#boxChecks(box)))).flat(), ...(this.#deps.ledger?.checks() ?? [])];
  }

  async #boxChecks(box: BoxRecord): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const id = `device.${box.name}` as DoctorCheck["id"];
    const name = `Device server of ${box.name}`;
    const view = this.view(box.id);
    const bad = await this.#bad(box.id);
    const badWords = bad !== null ? ` Version ${bad} did not answer in this box, so it went back, and ${PRODUCT} delivers no version before ${bad + 1} to it.` : "";
    if (view.is === "connected") {
      const behind = view.version < this.version;
      const waitMs = this.#deps.deviceStateWaitMs ?? DOCTOR_STATE_WAIT_MS;
      const now = await this.#stateNow(box.id, waitMs);
      const said = `Version ${view.version}, protocol ${view.protocol}: `;
      const deliveryWords = behind && bad === null ? ` This ${PRODUCT} delivers version ${this.version} when it next connects as the box's lease holder.` : "";
      if (now) {
        checks.push({
          id,
          name,
          status: behind || bad !== null ? "warn" : "ok",
          detail: `${said}the ${now.model}, ${now.power.is}.${deliveryWords}${badWords}`,
          fix: bad !== null ? `Read ~/.bb-box/device/server.log in box ${box.name} for why version ${bad} did not answer.` : null,
        });
      } else {
        const last = view.state;
        const lastWords = `It last said the ${last.model} was ${last.power.is}, at ${utcWords(last.at)}.`;
        const ended = this.#held.get(box.id)?.linkEnded ?? null;
        const linkOpen = !!this.#held.get(box.id)?.link;
        const idle = !linkOpen && ended?.idle === true;
        const why = linkOpen
          ? `it did not answer within ${Math.round(waitMs / 1000)} s`
          : !ended
            ? `${PRODUCT} has no connection to it now`
            : ended.idle
              ? `${PRODUCT} closed its connection at ${utcWords(ended.at)}, as nothing used it`
              : `its connection ended at ${utcWords(ended.at)}: ${ended.words.replace(/\.$/, "")}`;
        checks.push({
          id,
          name,
          status: idle ? "ok" : "warn",
          detail: `${said}${why}, so the device's state now is not known. ${lastWords}${deliveryWords}${badWords}`,
          fix: idle ? null : `box_status ${box.name} says whether the box runs.${hostCheckWords(box)}`,
        });
      }
    } else if (view.is === "waiting") {
      checks.push({ id, name, status: "ok", detail: `Version ${view.version ?? "none"}; version ${view.for} waits until ${view.why === "person" ? "the person hands back control" : "the recording ends"}.`, fix: null });
    } else if (view.is === "down") {
      checks.push({ id, name, status: "fail", detail: view.words + badWords, fix: `Read ~/.bb-box/device/server.log in box ${box.name}. Once the cause is fixed, sh ~/.bb-box/device/current/src/device/bb-box-device.sh restart in the box starts it again, as a newer ${PRODUCT}'s delivery does.` });
    } else if (view.is === "superseded") {
      checks.push({ id, name, status: "ok", detail: `A ${PRODUCT} instance started later holds this box's device.`, fix: null });
    } else {
      checks.push({ id, name, status: "skipped", detail: `${PRODUCT} has not connected to it since it started.`, fix: null });
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
    if (!seen) return { id, name, status: "skipped", detail: `${PRODUCT} could not look in box ${box.name}${why}.`, fix: null };
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
