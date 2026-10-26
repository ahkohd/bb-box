import { randomBytes } from "node:crypto";
import type { BoxRecord } from "../core/boxes.ts";
import { DEVICE_SERVER_VERSION, isTestOffer, speaksProtocol, type BoxDevice, type DeviceHello, type DeviceState, type Intent, type OfferedDevice } from "../core/device.ts";
import { DELIVERY_EXITS, connectScript, deliveryScript, deviceHubScript, parseDeviceHub, type DeviceHubSeen, deliveryStdin, parseStatus, restartScript, rollbackScript, statusScript, type ServerFile, type ServerStatus } from "../core/device-delivery.ts";
import { DeviceLink, DeviceLinkError } from "../core/device-link.ts";
import type { ByteChannel, RunResult } from "../transports/types.ts";
import type { DoctorCheck } from "../backends/types.ts";

export const IDLE_CLOSE_MS = 10 * 60_000;
export const HELLO_TRIES = 2;
const SCRIPT_TIMEOUT_MS = 60_000;
const DEVICE_HUB_CHECK_MS = 15_000;
const BAD_KEY = (boxId: string) => `device-bad:${boxId}`;

export interface DeviceBoxes {
  find(boxId: string): Promise<BoxRecord | null>;
  all(): Promise<BoxRecord[]>;
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null>;
  spawnOwn(box: BoxRecord, script: string, options?: { signal?: AbortSignal }): Promise<ByteChannel>;
  runOwn(box: BoxRecord, script: string, options: { stdin?: string | Uint8Array; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult>;
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
}

export type DeviceServerView =
  | { readonly is: "none" }
  | { readonly is: "connected"; readonly version: number; readonly protocol: number; readonly state: DeviceState }
  | { readonly is: "waiting"; readonly version: number | null; readonly for: number; readonly why: "person" | "recording" }
  | { readonly is: "down"; readonly words: string }
  | { readonly is: "superseded" };

interface Held {
  link: DeviceLink | null;
  view: DeviceServerView;
  idle: ReturnType<typeof setTimeout> | null;
  work: Promise<unknown>;
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
      held = { link: null, view: { is: "none" }, idle: null, work: Promise.resolve() };
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
    if (held?.view.is !== "waiting" || held.view.why !== "person" || this.#deps.personHasControl(boxId)) return;
    this.#retry(boxId);
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
      held.view = { is: "down", words: error instanceof Error ? error.message : String(error) };
      return this.#deliverIfAllowed(box, held, null, "it did not say hello");
    }
    const hello = link.hello;
    held.link = link;
    held.view = { is: "connected", version: hello.version, protocol: hello.protocol, state: hello.state };
    this.#touch(box.id);
    await this.#copied(box, hello.state, hello);
    const older = hello.version < this.version;
    const foreign = !speaksProtocol(hello.protocol);
    if (!older && !foreign) return held.view;
    if (!hello.lease) return held.view;
    return this.#deliverIfAllowed(box, held, hello.version, older ? `it runs version ${hello.version}` : `it speaks protocol ${hello.protocol}`);
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

  async #run(box: BoxRecord, script: string, stdin?: string): Promise<RunResult> {
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
        held.view = { is: "connected", version: fresh.hello.version, protocol: fresh.hello.protocol, state: fresh.hello.state };
        this.#touch(box.id);
        await this.#copied(box, fresh.hello.state, fresh.hello);
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
      held.view = { is: "connected", version: restored.hello.version, protocol: restored.hello.protocol, state: restored.hello.state };
      this.#touch(box.id);
      return held.view;
    } catch (error) {
      held.view = { is: "down", words: error instanceof Error ? error.message : String(error) };
      return held.view;
    }
  }

  async checks(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const box of await this.#deps.boxes.all()) {
      if (!wantsDevice(box)) continue;
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
    }
    return checks;
  }

  async #deviceHubCheck(box: BoxRecord): Promise<DoctorCheck> {
    const id = `device-hub.${box.name}` as DoctorCheck["id"];
    const name = `Device Hub in ${box.name}`;
    let seen: DeviceHubSeen | null = null;
    let why = "";
    try {
      seen = parseDeviceHub((await this.#deps.boxes.runOwn(box, deviceHubScript(), { timeoutMs: DEVICE_HUB_CHECK_MS })).stdout);
    } catch (error) {
      why = `: ${error instanceof Error ? error.message : String(error)}`;
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
