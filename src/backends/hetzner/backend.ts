import type { CheckId } from "../../core/checks.ts";
import { DockerBackend, dockerKinds, type DockerBackendOptions } from "../docker/backend.ts";
import type { DockerCli } from "../docker/cli.ts";
import type { DockerConfig } from "../docker/config.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type PowerState,
  type ReleaseHooks,
  type ResizePlan,
  type Resizing,
} from "../types.ts";
import { Hetzner, HetznerError, type EurosBeforeVat, type HetznerFetch, type ServerType } from "./api.ts";
import { HetznerHosts, type HostRecord } from "./hosts.ts";
import { euros, oneMoreToMonthEnd, serverAndIpv4, spentThisMonth, startOfMonthUtc, type BilledServer } from "./spend.ts";

export interface HetznerConfig {
  readonly token: string;
  readonly location: string;
  readonly serverType: string;
  readonly hostImage: string | number;
  readonly hostImageLabel: string;
  readonly mostHosts: number;
  readonly idleMinutes: number;
  readonly monthlyLimitEurosBeforeVat: number | null;
  readonly docker: DockerConfig;
}

export interface HetznerBackendOptions {
  readonly fetch?: HetznerFetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly reachHost: (host: HostRecord) => DockerCli;
  readonly userData?: (hostId: string, serverName: string) => Promise<string> | string;
  readonly dockerOptions?: Omit<DockerBackendOptions, "cliReachingAHostAnotherBackendMade">;
  readonly hostAnswersWithinMs?: number;
  readonly pollMs?: number;
}

type Pending = { readonly kind: string; readonly size: BoxSize };

interface HostPart {
  readonly record: HostRecord;
  readonly docker: DockerBackend;
}

interface HostRoom {
  readonly part: HostPart;
  readonly capacity: HostCapacity;
  readonly ok: boolean;
  readonly why: string | null;
  readonly freeMemoryMiB: number;
  readonly usedMemoryMiB: number;
  readonly totalMemoryMiB: number;
}

const HOST_KEY = "hetznerHost";
const BILLED_PREFIX = "billed:";
const PRICE_CACHE_MS = 3_600_000;
const MAKE_NEXT_AHEAD_ABOVE = 0.75;
const SILENT_HOST_DELETED_AFTER_MS = 24 * 3_600_000;
const ANSWERED_NOTED_EVERY_MS = 60_000;
const OS_MEMORY_MiB = 1024;
const NO_GPU_KINDS = (kind: BoxKind) => kind.id !== "linux-desktop";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopedStorage(storage: BackendStorage, prefix: string): BackendStorage {
  return {
    get: (key) => storage.get(prefix + key),
    set: (key, value) => storage.set(prefix + key, value),
    delete: (key) => storage.delete(prefix + key),
    list: async (inner = "") => (await storage.list(prefix + inner)).map((key) => key.slice(prefix.length)),
  };
}

export class HetznerBackend implements Backend {
  readonly id: string;
  readonly nature = "virtual" as const;
  readonly hostOs = "linux" as const;
  readonly #config: HetznerConfig;
  readonly #context: BackendContext;
  readonly #options: HetznerBackendOptions;
  readonly #api: Hetzner;
  readonly hostRecords: HetznerHosts;
  readonly #kinds: BoxKind[];
  readonly #parts = new Map<string, HostPart>();
  readonly #making = new Map<string, Promise<HostPart>>();
  readonly #now: () => number;
  #placement: Promise<unknown> = Promise.resolve();
  #prices: { at: number; price: EurosBeforeVat } | null = null;
  #serverType: ServerType | null = null;
  #readyNames: string[] = [];

  constructor(config: HetznerConfig, context: BackendContext, options: HetznerBackendOptions) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#api = new Hetzner({ token: config.token, fetch: options.fetch, sleep: options.sleep });
    this.hostRecords = new HetznerHosts({
      api: this.#api,
      storage: context.storage,
      installId: context.installId,
      now: this.#now,
      whenGone: (record, goneAtMs) => this.#billEnded(record, goneAtMs),
    });
    this.#kinds = dockerKinds(config.docker).filter(NO_GPU_KINDS);
  }

  get label(): string {
    return `Hetzner Cloud in ${this.#config.location}`;
  }

  get hosts(): readonly string[] {
    return this.#readyNames;
  }

  kinds(): BoxKind[] {
    return this.#kinds;
  }

  #kind(id: string): BoxKind {
    const kind = this.#kinds.find((each) => each.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  async capacity(kind: string, size: BoxSize, _pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const rooms = await this.#rooms(kind, size, signal);
    const hosts = rooms.map((room) => room.capacity);
    if (rooms.some((room) => room.ok)) return { ok: true, message: null, warm: null, hosts };
    const why = await this.#whyNoNewHost(size, signal);
    if (why === null) return { ok: true, message: null, warm: null, hosts: [...hosts, this.#newHostCapacity()] };
    const onHosts = rooms.map((room) => room.why).filter(Boolean);
    return { ok: false, message: `${this.label} cannot take this ${kind} box: ${[...onHosts, why].join("; ")}.`, warm: null, hosts };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#kind(box.kind);
    const resumedOn = typeof previous?.data?.[HOST_KEY] === "string" ? String(previous.data[HOST_KEY]) : null;
    const part = resumedOn ? await this.#partOf(resumedOn, signal) : await this.#place(box, hooks, signal);
    if (!part) throw new BackendError("gone", `The Hetzner Cloud host of ${box.name} is gone.`);
    const own = (guest: Guest): Guest => ({ ...guest, host: part.record.serverName, data: { ...guest.data, [HOST_KEY]: part.record.hostId } });
    await this.hostRecords.markBusy(part.record.hostId);
    const made = await part.docker.acquire(box, previous ? { ...previous, data: { ...previous.data } } : null, { ...hooks, claim: (guest) => hooks.claim(own(guest)) }, signal);
    void this.#makeNextAhead().catch((error) => this.#context.logError("make the next Hetzner Cloud host ahead", error));
    return own(made);
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const part = await this.#partOfGuest(guest, signal);
    if (!part) {
      hooks.timing("delete", 0);
      return;
    }
    await part.docker.release(guest, hooks, signal);
    await this.hostRecords.markBusy(part.record.hostId);
  }

  async relabel(guest: Guest, box: BoxIdentity): Promise<void> {
    const part = await this.#partOfGuest(guest);
    if (part) await part.docker.relabel(guest, box);
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const hostId = this.#hostIdOf(guest);
    if (!hostId) return null;
    const record = await this.hostRecords.record(hostId);
    if (!record || record.state === "deleting") return null;
    const part = await this.#partOf(hostId, signal).catch(() => null);
    return part ? part.docker.power(guest, signal) : "unknown";
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    await (await this.#requirePart(guest, signal)).docker.start(guest, signal);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    await (await this.#requirePart(guest, signal)).docker.stop(guest, signal);
  }

  resizing(kind: string): Resizing | null {
    return this.#kinds.some((each) => each.id === kind) ? { cores: "live", memory: "live", disk: "no", shrinks: true } : null;
  }

  async planResize(guest: Guest, kind: string, to: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<ResizePlan> {
    return (await this.#requirePart(guest, signal)).docker.planResize(guest, kind, to, pending, signal);
  }

  async resize(guest: Guest, kind: string, to: BoxSize, options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    const part = await this.#requirePart(guest, signal);
    const resized = await part.docker.resize(guest, kind, to, options, signal);
    return { ...resized, host: part.record.serverName, data: { ...resized.data, [HOST_KEY]: part.record.hostId } };
  }

  async fromCurrentBuild(guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean | null> {
    const part = await this.#partOfGuest(guest, signal);
    return part ? part.docker.fromCurrentBuild(guest, kind, signal) : null;
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    await this.hostRecords.adoptUnclaimedHosts(signal).catch((error: unknown) => {
      if (signal?.aborted) throw error;
      this.#context.logError("find this install's Hetzner Cloud hosts", error);
    });
    const all: HeldGuest[] = [];
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "ready") continue;
      try {
        const part = await this.#partOf(record.hostId, signal);
        if (!part) continue;
        for (const guest of await part.docker.held(signal)) all.push({ ...guest, host: record.serverName, data: { ...guest.data, [HOST_KEY]: record.hostId } });
        await this.#answered(record);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#context.logError(`list the boxes on Hetzner Cloud host ${record.serverName}`, error);
      }
    }
    return all;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    return (await this.#requirePart(guest)).docker.transports(guest, kind);
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    await this.hostRecords.sweep(signal);
    const idleMs = this.#config.idleMinutes * 60_000;
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "ready" || this.hostRecords.isMakingInThisProcess(record.hostId)) continue;
      if (this.#now() - record.lastBusyAtMs < idleMs) continue;
      await this.#placement.catch(() => undefined);
      const part = await this.#partOf(record.hostId, signal).catch(() => null);
      const boxes = part ? await part.docker.held(signal).catch(() => null) : null;
      if (boxes === null) {
        if (this.#neverAnsweredOrLongSilent(record, idleMs)) await this.#deleteHost(record, signal);
        continue;
      }
      await this.#answered(record);
      if (boxes.length > 0) {
        await this.hostRecords.markBusy(record.hostId);
        continue;
      }
      await this.#deleteHost(record, signal);
    }
    await this.#refreshNames();
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes = [`This install's ID is ${this.#context.installId}. Its servers carry the label bbbox-install=${this.#context.installId}.`];
    const push = (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) => checks.push({ id, name, status, detail, fix });

    let records: HostRecord[] = [];
    try {
      records = await this.hostRecords.records();
      const unclaimed = await this.hostRecords.unclaimedServers(signal);
      push("hetzner.api", "Hetzner Cloud API", "ok", `The token reads the project: ${records.length} host${records.length === 1 ? "" : "s"} of this install.`);
      if (unclaimed.length) {
        push(
          "hetzner.unclaimed",
          "Servers no host claims",
          "warn",
          `${unclaimed.map((each) => `${each.name} (made ${new Date(each.createdAtMs).toISOString()})`).join(", ")} carry this install's label, but are not hosts bb-box knows. The sweep adopts a host's server, as after lost storage, and deletes any other 10 minutes after it was made.`,
          "Wait for the next sweep, or delete them in Hetzner's Console.",
        );
      } else {
        push("hetzner.unclaimed", "Servers no host claims", "ok", "Every server with this install's label is a host bb-box knows.");
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      const unauthorised = error instanceof HetznerError && error.unauthorised;
      push("hetzner.api", "Hetzner Cloud API", "fail", message(error), unauthorised ? "Make a Read & Write API token in the project's Security page, and paste it into the backend's settings." : "Check that BB's server reaches api.hetzner.cloud.");
      push("hetzner.unclaimed", "Servers no host claims", "skipped", "Skipped until the checks above pass.");
    }

    const type = await this.#serverTypeNow(signal).catch((error: unknown) => error as Error);
    if (type instanceof Error || !type) {
      push("hetzner.type", `Server type ${this.#config.serverType}`, "fail", type instanceof Error ? message(type) : `Hetzner Cloud has no server type ${this.#config.serverType}.`, "Choose a server type Hetzner Cloud sells, such as cpx42.");
    } else if (!type.soldIn.includes(this.#config.location)) {
      push("hetzner.type", `Server type ${type.name}`, "fail", `${type.name} is not sold in ${this.#config.location}; it is in ${type.soldIn.join(", ")}.`, "Choose another location or server type.");
    } else {
      const price = await this.#price(signal).catch(() => null);
      push("hetzner.type", `Server type ${type.name}`, "ok", `${type.cores} cores, ${type.memoryGB} GB memory, ${type.diskGB} GB disk in ${this.#config.location}${price ? `, ${euros(price.hourly)} an hour and at most ${euros(price.monthly)} a month with its IPv4, before VAT` : ""}.`);
    }

    const price = await this.#price(signal).catch(() => null);
    const live = records.filter((record) => record.state !== "deleting");
    if (!live.length) {
      push("hetzner.hosts", "Hosts", "ok", `None now. One is made when a box needs it, up to ${this.#config.mostHosts} at once, and deleted after ${this.#config.idleMinutes} minutes with no box.`);
    } else {
      const lines = [];
      for (const record of live) {
        const part = record.state === "ready" ? await this.#partOf(record.hostId, signal).catch(() => null) : null;
        const boxes = part ? await part.docker.held(signal).then((held) => held.length).catch(() => null) : null;
        const ageMinutes = Math.round((this.#now() - record.claimedAtMs) / 60_000);
        const cost = price ? euros(spentThisMonth([{ hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: null }], price, this.#now())) : "an unknown cost";
        lines.push(`${record.serverName}: ${record.state}, ${ageMinutes} minutes old, ${boxes === null ? "boxes unknown" : `${boxes} box${boxes === 1 ? "" : "es"}`}, ${cost} this month`);
      }
      push("hetzner.hosts", "Hosts", "ok", `${lines.join("; ")}.`);
    }

    if (price) {
      const spent = await this.#spentThisMonth(price);
      const limit = this.#config.monthlyLimitEurosBeforeVat;
      const status = limit !== null && spent >= limit ? "warn" : "ok";
      push("hetzner.spend", "This month's spend", status, `${euros(spent)} before VAT so far this month${limit === null ? ", with no limit set" : ` of the ${euros(limit)} limit`}.`, status === "warn" ? "bb-box makes no host past the limit. Raise it in the backend's settings, or wait for next month." : null);
    }

    for (const record of live.filter((each) => each.state === "ready")) {
      const part = await this.#partOf(record.hostId, signal).catch(() => null);
      const report = part ? await part.docker.doctor(signal).catch((error: unknown) => error as Error) : new Error("bb-box cannot reach it");
      if (report instanceof Error) push(`hetzner.host.${record.serverName}`, `Docker on ${record.serverName}`, "fail", message(report), "Check the host's network, or let the sweep delete it.");
      else push(`hetzner.host.${record.serverName}`, `Docker on ${record.serverName}`, report.ok ? "ok" : "fail", report.summary, report.ok ? null : report.checks.find((each) => each.status === "fail")?.fix ?? null);
    }

    const failed = checks.find((each) => each.status === "fail");
    return { ok: !failed, summary: failed ? `${failed.name}: ${failed.detail}` : `${this.label}: ${live.length} host${live.length === 1 ? "" : "s"}`, checks, notes };
  }

  async #rooms(kind: string, size: BoxSize, signal?: AbortSignal): Promise<HostRoom[]> {
    const rooms: HostRoom[] = [];
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "ready") continue;
      const part = await this.#partOf(record.hostId, signal).catch(() => null);
      if (!part) continue;
      const capacity = await part.docker.capacity(kind, size, [], signal);
      const memory = capacity.hosts[0]?.limits.find((limit) => limit.resource === "memory");
      const total = memory?.total ?? 0;
      const used = memory?.used ?? 0;
      rooms.push({
        part,
        capacity: { ...(capacity.hosts[0] ?? { limits: [] }), host: record.serverName, ok: capacity.ok },
        ok: capacity.ok,
        why: capacity.message,
        freeMemoryMiB: total - used - (memory?.reserve ?? 0),
        usedMemoryMiB: used,
        totalMemoryMiB: total,
      });
    }
    return rooms;
  }

  #newHostCapacity(): HostCapacity {
    return { host: `a new ${this.#config.serverType} host`, ok: true, limits: [] };
  }

  #neverAnsweredOrLongSilent(record: HostRecord, idleMs: number): boolean {
    const now = this.#now();
    return record.answeredAtMs === null ? now - record.claimedAtMs > idleMs : now - record.answeredAtMs > SILENT_HOST_DELETED_AFTER_MS;
  }

  async #answered(record: HostRecord): Promise<void> {
    if (record.answeredAtMs === null || this.#now() - record.answeredAtMs > ANSWERED_NOTED_EVERY_MS) await this.hostRecords.markAnswered(record.hostId);
  }

  async #whyNoNewHost(size: BoxSize, signal?: AbortSignal): Promise<string | null> {
    if (size.diskGiB !== null) return `a Docker box shares its host's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk of its own. Ask for the base disk`;
    const live = (await this.hostRecords.records()).filter((record) => record.state !== "deleting");
    if (live.length >= this.#config.mostHosts) return `it has the ${this.#config.mostHosts} host${this.#config.mostHosts === 1 ? "" : "s"} it may have at once. Release a box, or raise the most hosts in the backend's settings`;
    const type = await this.#serverTypeNow(signal).catch(() => null);
    if (type) {
      const room = type.memoryGB * 1024 - OS_MEMORY_MiB - this.#config.docker.reserveMemoryMiB;
      if (size.cores > type.cores) return `a ${type.name} host has ${type.cores} cores, fewer than the ${size.cores} asked for`;
      if (size.memoryMiB > room) return `a ${type.name} host has room for at most ${Math.floor(room / 1024)} GiB of boxes, less than the box asks for`;
    }
    const limit = this.#config.monthlyLimitEurosBeforeVat;
    if (limit !== null) {
      const price = await this.#price(signal).catch(() => null);
      if (!price) return "bb-box could not read Hetzner Cloud's prices to keep to the monthly limit";
      const spent = await this.#spentThisMonth(price);
      const more = oneMoreToMonthEnd(price, this.#now());
      if (spent + more > limit) return `another host would take this month's spend from ${euros(spent)} to ${euros(spent + more)}, past the ${euros(limit)} limit`;
    }
    return null;
  }

  #place(box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<HostPart> {
    const placed = this.#placement.then(async () => {
      const rooms = (await this.#rooms(box.kind, box.size, signal)).filter((room) => room.ok);
      const roomiest = rooms.sort((a, b) => b.freeMemoryMiB - a.freeMemoryMiB)[0];
      if (roomiest) return roomiest.part;
      const inFlight = [...this.#making.values()][0];
      if (inFlight) return inFlight;
      const why = await this.#whyNoNewHost(box.size, signal);
      if (why !== null) throw new BackendError("no_capacity", `${this.label} cannot take this ${box.kind} box: ${why}.`);
      const started = performance.now();
      const part = await this.#makeHost(signal);
      hooks.timing("make a host", Math.round(performance.now() - started));
      return part;
    });
    this.#placement = placed.catch(() => undefined);
    return placed;
  }

  async #makeNextAhead(): Promise<void> {
    if (this.#making.size) return;
    const records = (await this.hostRecords.records()).filter((record) => record.state !== "deleting");
    if (!records.length || records.length >= this.#config.mostHosts) return;
    const kind = this.#kinds[0]!;
    const rooms = await this.#rooms(kind.id, { cores: 1, memoryMiB: 1, diskGiB: null }, undefined);
    const total = rooms.reduce((sum, room) => sum + room.totalMemoryMiB, 0);
    const used = rooms.reduce((sum, room) => sum + room.usedMemoryMiB, 0);
    if (!total || used / total <= MAKE_NEXT_AHEAD_ABOVE) return;
    if ((await this.#whyNoNewHost({ cores: 1, memoryMiB: 1, diskGiB: null })) !== null) return;
    await this.#makeHost(undefined);
  }

  #makeHost(signal: AbortSignal | undefined): Promise<HostPart> {
    const key = `making-${this.#making.size}-${this.#now()}`;
    const making = (async () => {
      const record = await this.hostRecords.create(
        {
          serverType: this.#config.serverType,
          location: this.#config.location,
          imageNameOrSnapshotId: this.#config.hostImage,
          imageLabel: this.#config.hostImageLabel,
          userData: this.#options.userData,
        },
        signal,
      );
      try {
        const part = this.#partFor(record);
        await this.#untilDockerAnswers(part, signal);
        await this.hostRecords.markAnswered(record.hostId);
        await this.#refreshNames();
        return part;
      } catch (error) {
        await this.#deleteHost(record).catch((cause) => this.#context.logError(`delete Hetzner Cloud host ${record.serverName} that did not answer`, cause));
        throw error;
      }
    })().finally(() => this.#making.delete(key));
    this.#making.set(key, making);
    return making;
  }

  async #untilDockerAnswers(part: HostPart, signal: AbortSignal | undefined): Promise<void> {
    const within = this.#options.hostAnswersWithinMs ?? 180_000;
    const pollMs = this.#options.pollMs ?? 2_000;
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    let last: unknown = null;
    for (let waited = 0; waited <= within; waited += pollMs) {
      const report = await part.docker.capacity(this.#kinds[0]!.id, { cores: 1, memoryMiB: 1, diskGiB: null }, [], signal).catch((error: unknown) => error);
      if (!(report instanceof Error) && (report as Capacity).hosts.length && !/did not answer/.test((report as Capacity).message ?? "")) return;
      last = report instanceof Error ? report : (report as Capacity).message;
      await sleep(pollMs, signal);
    }
    throw new Error(`Hetzner Cloud host ${part.record.serverName} ran, but its Docker did not answer within ${Math.round(within / 1000)} s: ${last instanceof Error ? last.message : String(last)}`);
  }

  async #deleteHost(record: HostRecord, signal?: AbortSignal): Promise<void> {
    this.#parts.delete(record.hostId);
    await this.hostRecords.delete(record.hostId, signal);
    await this.#refreshNames();
  }

  #partFor(record: HostRecord): HostPart {
    const known = this.#parts.get(record.hostId);
    if (known) return known;
    const context: BackendContext = {
      ...this.#context,
      id: `${this.#context.id}/${record.hostId}`,
      storage: scopedStorage(this.#context.storage, `docker/${record.hostId}/`),
      machines: undefined,
    };
    const docker = new DockerBackend({ ...this.#config.docker, host: `hetzner://${record.serverName}`, machine: null }, context, {
      ...this.#options.dockerOptions,
      cliReachingAHostAnotherBackendMade: this.#options.reachHost(record),
    });
    const part = { record, docker };
    this.#parts.set(record.hostId, part);
    return part;
  }

  async #partOf(hostId: string, _signal?: AbortSignal): Promise<HostPart | null> {
    const record = await this.hostRecords.record(hostId);
    if (!record || record.state !== "ready") return null;
    return this.#partFor(record);
  }

  #hostIdOf(guest: Guest): string | null {
    const value = guest.data?.[HOST_KEY];
    return typeof value === "string" ? value : null;
  }

  async #partOfGuest(guest: Guest, signal?: AbortSignal): Promise<HostPart | null> {
    const hostId = this.#hostIdOf(guest);
    return hostId ? this.#partOf(hostId, signal) : null;
  }

  async #requirePart(guest: Guest, signal?: AbortSignal): Promise<HostPart> {
    const part = await this.#partOfGuest(guest, signal);
    if (!part) throw new BackendError("gone", `The Hetzner Cloud host of ${guest.ref} is gone.`);
    return part;
  }

  async #refreshNames(): Promise<void> {
    this.#readyNames = (await this.hostRecords.records()).filter((record) => record.state === "ready").map((record) => record.serverName);
  }

  async #serverTypeNow(signal?: AbortSignal): Promise<ServerType | null> {
    this.#serverType ??= await this.#api.serverType(this.#config.serverType, signal);
    return this.#serverType;
  }

  async #price(signal?: AbortSignal): Promise<EurosBeforeVat> {
    if (this.#prices && this.#now() - this.#prices.at < PRICE_CACHE_MS) return this.#prices.price;
    const prices = await this.#api.pricesBeforeVat(this.#config.serverType, this.#config.location, signal);
    if (!prices) throw new Error(`Hetzner Cloud sells no ${this.#config.serverType} in ${this.#config.location}.`);
    this.#prices = { at: this.#now(), price: serverAndIpv4(prices) };
    return this.#prices.price;
  }

  async #spentThisMonth(price: EurosBeforeVat): Promise<number> {
    const now = this.#now();
    const ended = await Promise.all((await this.#context.storage.list(BILLED_PREFIX)).map((key) => this.#context.storage.get<BilledServer>(key)));
    const running = (await this.hostRecords.records()).filter((record) => record.serverId !== null || record.state === "ready").map((record) => ({ hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: null }));
    return spentThisMonth([...ended.filter((each): each is BilledServer => each !== undefined), ...running], price, now);
  }

  async #billEnded(record: HostRecord, goneAtMs: number): Promise<void> {
    if (record.serverId === null) return;
    await this.#context.storage.set(BILLED_PREFIX + record.hostId, { hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: goneAtMs } satisfies BilledServer);
    const before = startOfMonthUtc(startOfMonthUtc(goneAtMs) - 1);
    for (const key of await this.#context.storage.list(BILLED_PREFIX)) {
      const each = await this.#context.storage.get<BilledServer>(key);
      if (each && (each.endedAtMs ?? goneAtMs) < before) await this.#context.storage.delete(key);
    }
  }
}
