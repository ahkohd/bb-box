import type { CheckId } from "../../core/checks.ts";
import { keyDescription, tailnetHostname } from "../../core/tailnet.ts";
import { hostUserData } from "./cloud-init.ts";
import { BUILD_ABANDONED_AFTER_MS, bbBoxIsStopping, HostImages, localRemoteBuild, runBuildScript, scriptRemoteBuild, type Architecture, type BuildImage, type RemoteBuild } from "./host-image.ts";
import { setupArchive } from "../namespace/linux-images.ts";
import { HostReach } from "./reach.ts";
import { DockerBackend, dockerKinds, type DockerBackendOptions } from "../docker/backend.ts";
import type { DockerCli } from "../docker/cli.ts";
import type { DockerConfig, DockerKind } from "../docker/config.ts";
import { kindInfo } from "../kinds.ts";
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
import { HetznerHosts, IMAGE_BUILD_ROLE, serverNamePrefix, serverNamePrefixBeforeHz, type HostRecord } from "./hosts.ts";
import { euros, serverAndIpv4, spentThisMonth, startOfMonthUtc, type BilledServer } from "./spend.ts";

export interface HetznerConfig {
  readonly token: string;
  readonly location: string;
  readonly serverType: string;
  readonly armServerType?: string | null;
  readonly hostImage: string | number;
  readonly hostImageLabel: string;
  readonly mostHosts: number;
  readonly idleMinutes: number;
  readonly monthlyLimitEurosBeforeVat: number | null;
  readonly sshFrom: readonly string[];
  readonly docker: DockerConfig;
}

export interface HetznerBackendOptions {
  readonly fetch?: HetznerFetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly reachHost?: (host: HostRecord) => DockerCli;
  readonly sshBinary?: string;
  readonly hostImageFingerprint?: () => string;
  readonly buildImage?: BuildImage;
  readonly remoteBuild?: RemoteBuild;
  readonly runOnHost?: (host: HostRecord, script: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<{ exitCode: number | null; stdout?: string; stderr: string }>;
  readonly userData?: (hostId: string, serverName: string) => Promise<string> | string;
  readonly dockerOptions?: Omit<DockerBackendOptions, "cliReachingAHostAnotherBackendMade">;
  readonly hostAnswersWithinMs?: number;
  readonly pollMs?: number;
}

type Pending = { readonly kind: string; readonly size: BoxSize };

interface HostPart {
  readonly record: HostRecord;
  readonly architecture: Architecture;
  readonly cli: DockerCli;
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

interface BilledServerOfType extends BilledServer {
  readonly serverType?: string;
}

const HOST_KEY = "hetznerHost";
const BILLED_PREFIX = "billed:";
const PRICE_CACHE_MS = 3_600_000;
const MAKE_NEXT_AHEAD_ABOVE = 0.75;
const SILENT_HOST_DELETED_AFTER_MS = 24 * 3_600_000;
const ANSWERED_NOTED_EVERY_MS = 60_000;
const OS_MEMORY_MiB = 1024;
const PLAIN_IMAGE_HOST_ANSWERS_WITHIN_MS = 600_000;
const HOST_IMAGE_CACHE_MS = 10 * 60_000;
const HOST_IMAGE_FAILED_KEY: Readonly<Record<Architecture, string>> = { x86: "host-image-failed-at:x86", arm: "host-image-failed-at:arm" };
const HOST_IMAGE_RETRIES_AFTER_MS = [10, 20, 40, 60].map((minutes) => minutes * 60_000);

interface HostImageFailures {
  readonly atMs: number;
  readonly inARow: number;
}

function retryAfterMs(failures: HostImageFailures): number {
  return HOST_IMAGE_RETRIES_AFTER_MS[Math.min(failures.inARow, HOST_IMAGE_RETRIES_AFTER_MS.length) - 1]!;
}
const HOST_IMAGE_WAITING_KEY: Readonly<Record<Architecture, string>> = { x86: "host-image-waiting", arm: "host-image-waiting:arm" };

const BOXES_REFUSED_FOR_ROOM_KEY = "boxes-refused-for-room-at";
const BUILDS_WAIT_AFTER_BOXES_REFUSED_MS = 30 * 60_000;
const BUILD_TAKES_ABOUT_MS: Readonly<Record<Architecture, number>> = { x86: 45 * 60_000, arm: 20 * 60_000 };
const ROOM_ADVICE = "Hetzner limits the shared vCPUs of the whole account, 20 for a new one, across all its projects: free some, or ask Hetzner for more on the account's Limits page in the Console.";

interface WaitingForRoom {
  readonly atMs: number;
  readonly why: string;
}
const HOST_IMAGE_BUILD_HOURS = 2;
const SNAPSHOT_EUROS_A_GB_A_MONTH = 0.0119;
const BUILD_TARGET: Readonly<Record<string, string>> = { linux: "linux", "linux-desktop-cpu": "desktop", "linux-desktop-wayland-cpu": "desktop-wayland" };
const DOCKER_TARGETS: Readonly<Record<Architecture, readonly DockerKind[]>> = { x86: ["linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu"], arm: ["linux", "linux-desktop-cpu"] };
const ARM_KIND_OF: Readonly<Record<string, string>> = { linux: "linux-arm64", "linux-desktop-cpu": "linux-arm64-desktop-cpu" };
const DOCKER_KIND_OF_ARM: Readonly<Record<string, DockerKind>> = { "linux-arm64": "linux", "linux-arm64-desktop-cpu": "linux-desktop-cpu" };
const ARCHITECTURE_WORDS: Readonly<Record<Architecture, string>> = { x86: "x86", arm: "Arm" };

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

export function armImageOf(image: string | null): string | null {
  return image ? `${image}-arm64` : null;
}

export function dockerConfigForArm(config: DockerConfig): DockerConfig {
  return {
    ...config,
    images: {
      linux: armImageOf(config.images.linux),
      "linux-desktop-cpu": armImageOf(config.images["linux-desktop-cpu"]),
      "linux-desktop": null,
      "linux-desktop-wayland-cpu": null,
    },
  };
}

function armKind(kind: BoxKind): BoxKind {
  const id = ARM_KIND_OF[kind.id]!;
  const info = kindInfo(id);
  return { ...kind, id, label: info.label, description: info.description, capabilities: { ...kind.capabilities, arch: "arm64" } };
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
  readonly #dockerConfig: Readonly<Record<Architecture, DockerConfig>>;
  readonly #parts = new Map<string, HostPart>();
  readonly #making = new Map<string, { readonly architecture: Architecture; readonly part: Promise<HostPart> }>();
  readonly #building = new Map<string, Promise<void>>();
  readonly #reach: HostReach | null;
  readonly #hostImages: HostImages;
  readonly #newestHostImage = new Map<Architecture, { at: number; image: { id: number; label: string } | null }>();
  readonly #buildingHostImage = new Map<Architecture, Promise<void>>();
  readonly #now: () => number;
  #placement: Promise<unknown> = Promise.resolve();
  readonly #prices = new Map<string, { at: number; price: EurosBeforeVat }>();
  readonly #serverTypes = new Map<string, ServerType | null>();

  constructor(config: HetznerConfig, context: BackendContext, options: HetznerBackendOptions) {
    this.id = context.id;
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#api = new Hetzner({ token: config.token, fetch: options.fetch, sleep: options.sleep, ...(context.log ? { log: (line: string) => context.log!(line) } : {}) });
    this.hostRecords = new HetznerHosts({
      api: this.#api,
      storage: context.storage,
      installId: context.installId,
      now: this.#now,
      whenGone: (record, goneAtMs) => this.#billEnded(record, goneAtMs),
      rolesManagedElsewhere: [IMAGE_BUILD_ROLE],
    });
    this.#hostImages = new HostImages({
      api: this.#api,
      builds: new HetznerHosts({ api: this.#api, storage: context.storage, installId: context.installId, now: this.#now, whenGone: (record, goneAtMs) => this.#billEnded(record, goneAtMs), role: IMAGE_BUILD_ROLE, readyAbandonedAfterMs: BUILD_ABANDONED_AFTER_MS }),
      installLabels: { "bbbox-install": context.installId },
      storage: context.storage,
      now: this.#now,
      fingerprint: options.hostImageFingerprint,
    });
    this.#dockerConfig = { x86: config.docker, arm: dockerConfigForArm(config.docker) };
    const x86Kinds = dockerKinds(config.docker).filter((kind) => kind.id !== "linux-desktop");
    const armKinds = config.armServerType ? dockerKinds(this.#dockerConfig.arm).filter((kind) => ARM_KIND_OF[kind.id]).map(armKind) : [];
    this.#kinds = [...x86Kinds, ...armKinds];
    this.#reach = options.reachHost
      ? null
      : new HostReach({ api: this.#api, storage: context.storage, installId: context.installId, tailnet: () => context.tailnet?.() ?? null, sshFrom: config.sshFrom, sshBinary: options.sshBinary, dockerBinary: options.dockerOptions?.binary });
  }

  async dispose(): Promise<void> {
    await this.#reach?.dispose();
  }

  get label(): string {
    return "Hetzner Cloud";
  }

  kinds(): BoxKind[] {
    return this.#kinds;
  }

  get #architectures(): Architecture[] {
    return this.#config.armServerType ? ["x86", "arm"] : ["x86"];
  }

  #kind(id: string): BoxKind {
    const kind = this.#kinds.find((each) => each.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  #architectureOfKind(kind: string): Architecture {
    return DOCKER_KIND_OF_ARM[kind] ? "arm" : "x86";
  }

  #dockerKindOf(kind: string): string {
    return DOCKER_KIND_OF_ARM[kind] ?? kind;
  }

  #architectureOfType(serverType: string): Architecture {
    return serverType === this.#config.armServerType || /^cax/.test(serverType) ? "arm" : "x86";
  }

  #typeOf(architecture: Architecture): string {
    return architecture === "arm" ? this.#config.armServerType! : this.#config.serverType;
  }

  async capacity(kind: string, size: BoxSize, _pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const rooms = await this.#rooms(kind, size, signal);
    const hosts = rooms.map((room) => room.capacity);
    if (rooms.some((room) => room.ok)) return { ok: true, message: null, warm: null, hosts };
    const architecture = this.#architectureOfKind(kind);
    const why = await this.#whyNoNewHost(size, architecture, signal);
    if (why === null || (await this.#idleHostToFree(size, architecture, signal))) return { ok: true, message: null, warm: null, hosts: [...hosts, this.#newHostCapacity(architecture)] };
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
    const dockerKind = this.#dockerKindOf(box.kind);
    if (!resumedOn) {
      const started = performance.now();
      if (await this.#imageReady(part, dockerKind, signal)) hooks.timing("build image", Math.round(performance.now() - started));
    }
    const made = await part.docker.acquire({ ...box, kind: dockerKind }, previous ? { ...previous, data: { ...previous.data } } : null, { ...hooks, claim: (guest) => hooks.claim(own(guest)) }, signal);
    void this.#makeNextAhead(part.architecture).catch((error) => this.#context.logError("make the next Hetzner Cloud host ahead", error));
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
    if (part) await part.docker.relabel(guest, { ...box, kind: this.#dockerKindOf(box.kind) });
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
    return (await this.#requirePart(guest, signal)).docker.planResize(guest, this.#dockerKindOf(kind), to, pending, signal);
  }

  async resize(guest: Guest, kind: string, to: BoxSize, options: { readonly restart: boolean }, signal?: AbortSignal): Promise<Guest> {
    const part = await this.#requirePart(guest, signal);
    const resized = await part.docker.resize(guest, this.#dockerKindOf(kind), to, options, signal);
    return { ...resized, host: part.record.serverName, data: { ...resized.data, [HOST_KEY]: part.record.hostId } };
  }

  async fromCurrentBuild(guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean | null> {
    const part = await this.#partOfGuest(guest, signal);
    return part ? part.docker.fromCurrentBuild(guest, this.#dockerKindOf(kind), signal) : null;
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
        for (const guest of await part.docker.held(signal)) {
          const owner = guest.owner && part.architecture === "arm" && guest.owner.kind && ARM_KIND_OF[guest.owner.kind] ? { ...guest.owner, kind: ARM_KIND_OF[guest.owner.kind]! } : guest.owner;
          all.push({ ...guest, owner, host: record.serverName, data: { ...guest.data, [HOST_KEY]: record.hostId } });
        }
        await this.#answered(record);
      } catch (error) {
        if (signal?.aborted) throw error;
        this.#context.logError(`list the boxes on Hetzner Cloud host ${record.serverName}`, error);
      }
    }
    return all;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    return (await this.#requirePart(guest)).docker.transports(guest, this.#dockerKindOf(kind));
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    await this.hostRecords.sweep(signal);
    await this.#hostImages.reconcile((line) => this.#context.log?.(line), signal).catch((error) => this.#context.logError("reconcile host image snapshots", error));
    await this.#hostImages.builds.sweep(signal);
    await this.#removeFromTailnet("every one this install has no host for", signal);
    const idleMs = this.#config.idleMinutes * 60_000;
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "ready" || this.hostRecords.isMakingInThisProcess(record.hostId)) continue;
      const tended = await this.#partOf(record.hostId, signal).catch(() => null);
      await tended?.docker.maintain(signal).catch(() => undefined);
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
    for (const architecture of this.#architectures) {
      const due = await this.#hostImageBuildDue(architecture, signal).catch(() => null);
      if (due) void this.buildHostImage(due, undefined, architecture).catch((error) => this.#context.logError(`build a Hetzner Cloud ${ARCHITECTURE_WORDS[architecture]} host image`, error));
    }
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

    const unreachable = this.#reach?.canReach() ?? null;
    const tailnetOn = (this.#context.tailnet?.() ?? null) !== null;
    if (unreachable) push("hetzner.reach", "Reaching hosts", "fail", unreachable + ".", "Turn the tailnet on, or set SSH from.");
    else push("hetzner.reach", "Reaching hosts", "ok", tailnetOn ? "Over the tailnet: each host joins it as it starts, with a key bb-box makes for it, and its SSH is closed to the internet." : `Over the internet, from ${this.#config.sshFrom.join(", ")}, with bb-box's own SSH key.`);

    for (const architecture of this.#architectures) {
      await this.#serverTypeCheck(architecture, push, signal);
      await this.#hostImageCheck(architecture, push, signal);
    }

    const live = records.filter((record) => record.state !== "deleting");
    if (!live.length) {
      push("hetzner.hosts", "Hosts", "ok", `None now. One is made when a box needs it, up to ${this.#config.mostHosts} at once, and deleted after ${this.#config.idleMinutes} minutes with no box.`);
    } else {
      const lines = [];
      for (const record of live) {
        const part = record.state === "ready" ? await this.#partOf(record.hostId, signal).catch(() => null) : null;
        const boxes = part ? await part.docker.held(signal).then((held) => held.length).catch(() => null) : null;
        const ageMinutes = Math.round((this.#now() - record.claimedAtMs) / 60_000);
        const price = await this.#price(record.serverType, signal).catch(() => null);
        const cost = price ? euros(spentThisMonth([{ hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: null }], price, this.#now())) : "an unknown cost";
        lines.push(`${record.serverName} (${record.serverType}): ${record.state}, ${ageMinutes} minutes old, ${boxes === null ? "boxes unknown" : `${boxes} box${boxes === 1 ? "" : "es"}`}, ${cost} this month`);
      }
      push("hetzner.hosts", "Hosts", "ok", `${lines.join("; ")}.`);
    }

    const spent = await this.#spentThisMonth(signal).catch(() => null);
    if (spent !== null) {
      const limit = this.#config.monthlyLimitEurosBeforeVat;
      const status = limit !== null && spent >= limit ? "warn" : "ok";
      const running = live.length;
      const projected = spent + (await this.#nextHourWithANewHost("x86", signal).catch(() => 0));
      const projection = `An hour more of ${running ? `the ${running} host${running === 1 ? "" : "s"} and ` : ""}a new one would take it to ${euros(projected)}${limit !== null && projected > limit ? ", past the limit, so no new host is made now" : ""}.`;
      push("hetzner.spend", "This month's spend", status, `${euros(spent)} before VAT so far this month${limit === null ? ", with no limit set" : ` of the ${euros(limit)} limit`}. ${projection}`, status === "warn" ? "bb-box makes no host past the limit. Raise it in the backend's settings, or wait for next month." : null);
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

  async #serverTypeCheck(architecture: Architecture, push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void, signal?: AbortSignal): Promise<void> {
    const id: CheckId = architecture === "arm" ? "hetzner.arm-type" : "hetzner.type";
    const wanted = this.#typeOf(architecture);
    const type = await this.#serverTypeNow(wanted, signal).catch((error: unknown) => error as Error);
    const example = architecture === "arm" ? "cax31" : "cpx42";
    if (type instanceof Error || !type) {
      push(id, `Server type ${wanted}`, "fail", type instanceof Error ? message(type) : `Hetzner Cloud has no server type ${wanted}.`, `Choose a server type Hetzner Cloud sells, such as ${example}.`);
    } else if (this.#architectureOfType(type.name) !== architecture || (type.architecture !== "" && (type.architecture === "arm") !== (architecture === "arm"))) {
      push(id, `Server type ${type.name}`, "fail", `${type.name} is not an ${ARCHITECTURE_WORDS[architecture]} server type.`, `Choose an ${ARCHITECTURE_WORDS[architecture]} server type, such as ${example}.`);
    } else if (!type.soldIn.includes(this.#config.location)) {
      push(id, `Server type ${type.name}`, "fail", `${type.name} is not sold in ${this.#config.location}; it is in ${type.soldIn.join(", ")}.`, "Choose another location or server type.");
    } else {
      const price = await this.#price(type.name, signal).catch(() => null);
      push(id, `Server type ${type.name}`, "ok", `${type.cores} cores, ${type.memoryGB} GB memory, ${type.diskGB} GB disk in ${this.#config.location}${price ? `, ${euros(price.hourly)} an hour and at most ${euros(price.monthly)} a month with its IPv4, before VAT` : ""}.`);
    }
  }

  async #rooms(kind: string, size: BoxSize, signal?: AbortSignal): Promise<HostRoom[]> {
    const rooms: HostRoom[] = [];
    const architecture = this.#architectureOfKind(kind);
    const dockerKind = this.#dockerKindOf(kind);
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "ready" || this.#architectureOfType(record.serverType) !== architecture) continue;
      const part = await this.#partOf(record.hostId, signal).catch(() => null);
      if (!part) continue;
      const capacity = await part.docker.capacity(dockerKind, size, [], signal);
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

  #newHostCapacity(architecture: Architecture): HostCapacity {
    return { host: `a new ${this.#typeOf(architecture)} host`, ok: true, limits: [] };
  }

  #neverAnsweredOrLongSilent(record: HostRecord, idleMs: number): boolean {
    const now = this.#now();
    return record.answeredAtMs === null ? now - record.claimedAtMs > idleMs : now - record.answeredAtMs > SILENT_HOST_DELETED_AFTER_MS;
  }

  async #answered(record: HostRecord): Promise<void> {
    if (record.answeredAtMs === null || this.#now() - record.answeredAtMs > ANSWERED_NOTED_EVERY_MS) await this.hostRecords.markAnswered(record.hostId);
  }

  async #whyNoNewHost(size: BoxSize, architecture: Architecture, signal?: AbortSignal, options: { readonly hostLimit?: boolean } = {}): Promise<string | null> {
    const unreachable = this.#reach?.canReach() ?? null;
    if (unreachable) return unreachable;
    if (size.diskGiB !== null) return `a Docker box shares its host's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk of its own. Ask for the base disk`;
    const live = (await this.hostRecords.records()).filter((record) => record.state !== "deleting");
    if (options.hostLimit !== false && live.length >= this.#config.mostHosts) return `it has the ${this.#config.mostHosts} host${this.#config.mostHosts === 1 ? "" : "s"} it may have at once. Release a box, or raise the most hosts in the backend's settings`;
    const type = await this.#serverTypeNow(this.#typeOf(architecture), signal).catch(() => null);
    if (type) {
      const room = type.memoryGB * 1024 - OS_MEMORY_MiB - this.#config.docker.reserveMemoryMiB;
      if (size.cores > type.cores) return `a ${type.name} host has ${type.cores} cores, fewer than the ${size.cores} asked for`;
      if (size.memoryMiB > room) return `a ${type.name} host has room for at most ${Math.floor(room / 1024)} GiB of boxes, less than the box asks for`;
    }
    const limit = this.#config.monthlyLimitEurosBeforeVat;
    if (limit !== null) {
      const spent = await this.#spentThisMonth(signal).catch(() => null);
      const more = await this.#nextHourWithANewHost(architecture, signal).catch(() => null);
      if (spent === null || more === null) return "bb-box could not read Hetzner Cloud's prices to keep to the monthly limit";
      if (spent + more > limit) return `another host would take this month's spend from ${euros(spent)} to ${euros(spent + more)} within the hour, past the ${euros(limit)} limit`;
    }
    return null;
  }

  async #idleHostToFree(size: BoxSize, architecture: Architecture, signal?: AbortSignal): Promise<HostRecord | null> {
    const live = (await this.hostRecords.records()).filter((record) => record.state !== "deleting");
    if (live.length < this.#config.mostHosts) return null;
    if ((await this.#whyNoNewHost(size, architecture, signal, { hostLimit: false })) !== null) return null;
    for (const record of live) {
      if (record.state !== "ready" || this.#architectureOfType(record.serverType) === architecture || this.hostRecords.isMakingInThisProcess(record.hostId)) continue;
      const part = await this.#partOf(record.hostId, signal).catch(() => null);
      const boxes = part ? await part.docker.held(signal).catch(() => null) : null;
      if (boxes !== null && boxes.length === 0) return record;
    }
    return null;
  }

  async #nextHourWithANewHost(architecture: Architecture, signal?: AbortSignal): Promise<number> {
    let sum = (await this.#price(this.#typeOf(architecture), signal)).hourly;
    for (const record of await this.hostRecords.records()) {
      if (record.state !== "deleting") sum += (await this.#price(record.serverType, signal)).hourly;
    }
    return sum;
  }

  #place(box: BoxIdentity, hooks: AcquireHooks, signal: AbortSignal): Promise<HostPart> {
    const architecture = this.#architectureOfKind(box.kind);
    const placed = this.#placement.then(async () => {
      const rooms = (await this.#rooms(box.kind, box.size, signal)).filter((room) => room.ok);
      const roomiest = rooms.sort((a, b) => b.freeMemoryMiB - a.freeMemoryMiB)[0];
      if (roomiest) return roomiest.part;
      const inFlight = [...this.#making.values()].find((each) => each.architecture === architecture);
      if (inFlight) return inFlight.part;
      let why = await this.#whyNoNewHost(box.size, architecture, signal);
      const idle = why === null ? null : await this.#idleHostToFree(box.size, architecture, signal);
      if (idle) {
        this.#context.log?.(`Deleting ${this.label} host ${idle.serverName}, which holds no box, to make room for a ${this.#typeOf(architecture)} host for box ${box.name}: the most hosts at once is ${this.#config.mostHosts}.`);
        await this.#deleteHost(idle, signal);
        why = await this.#whyNoNewHost(box.size, architecture, signal);
      }
      if (why !== null) throw new BackendError("no_capacity", `${this.label} cannot take this ${box.kind} box: ${why}.`);
      const started = performance.now();
      const part = await this.#makeHost(architecture, signal);
      hooks.timing("make a host", Math.round(performance.now() - started));
      return part;
    });
    this.#placement = placed.catch(() => undefined);
    return placed;
  }

  async #makeNextAhead(architecture: Architecture): Promise<void> {
    if ([...this.#making.values()].some((each) => each.architecture === architecture)) return;
    const records = (await this.hostRecords.records()).filter((record) => record.state !== "deleting");
    if (!records.length || records.length >= this.#config.mostHosts) return;
    const kind = this.#kinds.find((each) => this.#architectureOfKind(each.id) === architecture);
    if (!kind) return;
    const rooms = await this.#rooms(kind.id, { cores: 1, memoryMiB: 1, diskGiB: null }, undefined);
    const total = rooms.reduce((sum, room) => sum + room.totalMemoryMiB, 0);
    const used = rooms.reduce((sum, room) => sum + room.usedMemoryMiB, 0);
    if (!total || used / total <= MAKE_NEXT_AHEAD_ABOVE) return;
    if ((await this.#whyNoNewHost({ cores: 1, memoryMiB: 1, diskGiB: null }, architecture)) !== null) return;
    await this.#makeHost(architecture, undefined);
  }

  #makeHost(architecture: Architecture, signal: AbortSignal | undefined): Promise<HostPart> {
    const key = `making-${architecture}-${this.#making.size}-${this.#now()}`;
    const making = (async () => {
      const record = await this.#createOrSayWhyNoRoom(
        {
          serverType: this.#typeOf(architecture),
          location: this.#config.location,
          ...(await this.#hostImageForNewHost(architecture, signal)),
          sshKeys: this.#reach ? [await this.#reach.hetznerSshKeyId(signal)] : undefined,
          firewalls: this.#reach ? [await this.#reach.firewallId(signal)] : undefined,
          userData: this.#options.userData ?? ((_hostId, serverName) => this.#userData(serverName, signal)),
        },
        signal,
      );
      try {
        const part = this.#partFor(record);
        await this.#untilDockerAnswers(part, signal);
        await this.hostRecords.markAnswered(record.hostId);
        return part;
      } catch (error) {
        await this.#deleteHost(record).catch((cause) => this.#context.logError(`delete Hetzner Cloud host ${record.serverName} that did not answer`, cause));
        throw error;
      }
    })().finally(() => this.#making.delete(key));
    this.#making.set(key, { architecture, part: making });
    return making;
  }

  async #createOrSayWhyNoRoom(spec: Parameters<HetznerHosts["create"]>[0], signal: AbortSignal | undefined): Promise<HostRecord> {
    try {
      return await this.hostRecords.create(spec, signal);
    } catch (error) {
      if (error instanceof HetznerError && (error.overLimit || error.unavailable)) {
        const building = error.overLimit ? await this.#ownBuildHoldingRoom(signal).catch(() => "") : "";
        if (error.overLimit) await this.#context.storage.set(BOXES_REFUSED_FOR_ROOM_KEY, this.#now());
        throw new BackendError("no_capacity", `${this.label} could not make a ${spec.serverType} host: ${error.overLimit ? "the account is at Hetzner's limit" : `Hetzner has no ${spec.serverType} free in ${spec.location} now`} (${error.message.replace(/^Hetzner Cloud POST \/servers failed /, "")}).${building} ${error.overLimit ? ROOM_ADVICE : "Try again later, or choose another location or server type."}`);
      }
      throw error;
    }
  }

  async #ownBuildHoldingRoom(signal: AbortSignal | undefined): Promise<string> {
    const builds = (await this.#hostImages.builds.records()).filter((record) => record.state === "ready" || record.state === "creating");
    if (!builds.length) return "";
    const told = await Promise.all(
      builds.map(async (record) => {
        const cores = (await this.#serverTypeNow(record.serverType, signal).catch(() => null))?.cores;
        const architecture = this.#architectureOfType(record.serverType);
        const endsBy = new Date(record.claimedAtMs + BUILD_TAKES_ABOUT_MS[architecture]).toISOString();
        return `${record.serverName}, a ${record.serverType}${cores ? ` of ${cores} vCPUs` : ""}, since ${new Date(record.claimedAtMs).toISOString()}, which ends by about ${endsBy}`;
      }),
    );
    return ` bb-box's own host image build holds some of that room: ${told.join("; ")}. bb-box starts no other build while boxes wait for room.`;
  }

  async #boxesWaitedForRoomAt(): Promise<number | null> {
    const at = await this.#context.storage.get<number>(BOXES_REFUSED_FOR_ROOM_KEY);
    return typeof at === "number" && this.#now() - at < BUILDS_WAIT_AFTER_BOXES_REFUSED_MS ? at : null;
  }

  async #userData(serverName: string, signal: AbortSignal | undefined): Promise<string> {
    const tailnet = this.#context.tailnet?.() ?? null;
    const minted = tailnet ? await tailnet.mintKey({ description: keyDescription(`bb-box host ${serverName}`) }, signal) : null;
    return hostUserData({ serverName, tailnetKey: minted?.key ?? null });
  }

  async #imageReady(part: HostPart, dockerKind: string, signal: AbortSignal): Promise<boolean> {
    const image = this.#dockerConfig[part.architecture].images[dockerKind as DockerKind];
    const target = BUILD_TARGET[dockerKind];
    if (!image || !target) return false;
    const has = await part.cli.run(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 60_000, signal });
    if (has.exitCode === 0) return false;
    const key = `${part.record.hostId}/${image}`;
    let building = this.#building.get(key);
    if (!building) {
      const log = (line: string) => this.#context.log?.(`${part.record.serverName}: ${line}`);
      building = this.#buildImageOn(part.record, part.cli, image, target, log, signal, part.architecture).finally(() => this.#building.delete(key));
      this.#building.set(key, building);
    }
    await building;
    return true;
  }

  readonly #buildImageOn: BuildImage = async (record, cli, image, target, log, signal, architecture) => {
    if (this.#options.buildImage) return this.#options.buildImage(record, cli, image, target, log, signal, architecture);
    await cli.prepare(signal);
    const code = await runBuildScript(cli, image, target, this.#context.bbUrl?.() ?? null, log, signal, undefined, architecture);
    if (code !== 0) throw new Error(`setup/docker/build.sh could not build ${image} on ${record.serverName}: it exited with ${code ?? "a signal"}.`);
  };

  async #hostImageCheck(architecture: Architecture, push: (id: CheckId, name: string, status: DoctorCheck["status"], detail: string, fix?: string | null) => void, signal?: AbortSignal): Promise<void> {
    const id: CheckId = architecture === "arm" ? "hetzner.arm-image" : "hetzner.image";
    const name = architecture === "arm" ? "Arm host image" : "Host image";
    if (typeof this.#config.hostImage === "number" && architecture === "x86") {
      push(id, name, "ok", `Hosts start from snapshot ${this.#config.hostImage}, as the settings say; bb-box builds none.`);
      return;
    }
    const snapshots = await this.#hostImages.snapshots(signal, architecture).catch((error: unknown) => error as Error);
    if (snapshots instanceof Error) {
      push(id, name, "skipped", `Hetzner Cloud did not list the snapshots: ${snapshots.message}`);
      return;
    }
    const failures = await this.#failures(architecture);
    const failedAt = failures?.atMs;
    const newest = snapshots[0] ?? null;
    const sizes = snapshots.reduce((sum, each) => sum + (each.compressedSizeGB ?? 0), 0);
    const kept = snapshots.length ? ` ${snapshots.length} kept, ${sizes.toFixed(1)} GB, about ${euros(sizes * SNAPSHOT_EUROS_A_GB_A_MONTH)} a month.` : "";
    const making = this.#buildingHostImage.has(architecture) ? null : await this.#hostImages.beingMade(signal, architecture).catch(() => null);
    const building = this.#buildingHostImage.has(architecture) ? " A new one is being built." : making ? ` Hetzner Cloud is making a new one, snapshot ${making.id}, which bb-box takes once it is ready.` : "";
    const failed = failures
      ? ` The last build failed at ${new Date(failures.atMs).toISOString()}${failures.inARow > 1 ? `, the ${failures.inARow}${ordinal(failures.inARow)} failure in a row` : ""}${building ? "." : `; bb-box tries again at ${new Date(failures.atMs + retryAfterMs(failures)).toISOString()}.`}`
      : "";
    const waiting = await this.#context.storage.get<WaitingForRoom>(HOST_IMAGE_WAITING_KEY[architecture]);
    const waits = waiting && !this.#buildingHostImage.has(architecture) ? ` The last build waited for room: at ${new Date(waiting.atMs).toISOString()} Hetzner Cloud refused its server (${waiting.why.replace(/^Hetzner Cloud POST \/servers failed /, "")}); bb-box tries again at its next check. ${ROOM_ADVICE}` : "";
    const fix = failedAt !== undefined ? "See BB Box's log for the build's last lines." : null;
    const why = this.#hostImages.whyBuild(newest, this.#now(), await this.#bbApp(signal));
    const held = why && !building ? await this.#whyBuildWaits(architecture) : "";
    if (!newest) {
      push(id, name, failedAt !== undefined ? "warn" : "ok", `None yet: ${this.#whichHosts(architecture)} start from ${this.#baseImage()} and install Docker and Tailscale, and build each kind's image, as they start.${held}${building}${waits}${failed}`, fix);
      return;
    }
    const days = Math.floor((this.#now() - newest.createdAtMs) / (24 * 3_600_000));
    const whichHosts = this.#whichHosts(architecture);
    push(id, name, failedAt !== undefined ? "warn" : "ok", `${whichHosts === "hosts" ? "Hosts" : whichHosts} start from snapshot ${newest.id}, built ${days} day${days === 1 ? "" : "s"} ago.${kept}${why ? ` A new one is due, as ${why}.` : ""}${held}${building}${waits}${failed}`, fix);
  }

  async #whyBuildWaits(architecture: Architecture): Promise<string> {
    const otherBuilding = [...this.#buildingHostImage.keys()].find((other) => other !== architecture);
    if (otherBuilding) return ` It waits for the ${ARCHITECTURE_WORDS[otherBuilding]} host image's build to finish, as bb-box builds one at a time.`;
    const boxesWaited = await this.#boxesWaitedForRoomAt();
    if (boxesWaited === null) return "";
    return ` It waits until ${new Date(boxesWaited + BUILDS_WAIT_AFTER_BOXES_REFUSED_MS).toISOString()}, as boxes waited for room at ${new Date(boxesWaited).toISOString()}, and they come first.`;
  }

  #whichHosts(architecture: Architecture): string {
    return this.#architectures.length > 1 ? `${ARCHITECTURE_WORDS[architecture]} hosts` : "hosts";
  }

  #baseImage(): string {
    return typeof this.#config.hostImage === "string" ? this.#config.hostImage : "ubuntu-26.04";
  }

  async #bbApp(signal?: AbortSignal): Promise<string | null> {
    if (!this.#context.bbUrl?.()) return null;
    return (await this.#context.images?.bbApp(signal).catch(() => null)) ?? null;
  }

  #buildsHostImages(architecture: Architecture): boolean {
    return (typeof this.#config.hostImage === "string" || architecture === "arm") && (this.#reach !== null || this.#options.runOnHost !== undefined);
  }

  async #hostImageForNewHost(architecture: Architecture, signal?: AbortSignal): Promise<{ imageNameOrSnapshotId: string | number; imageLabel: string }> {
    if (typeof this.#config.hostImage === "number" && architecture === "x86") return { imageNameOrSnapshotId: this.#config.hostImage, imageLabel: this.#config.hostImageLabel };
    const cached = this.#newestHostImage.get(architecture);
    let image = cached?.image ?? null;
    if (!cached || this.#now() - cached.at > HOST_IMAGE_CACHE_MS) {
      const newest = await this.#hostImages.newest(signal, architecture).catch(() => null);
      image = newest ? { id: newest.id, label: `build-${newest.labels["bbbox-build"] ?? newest.id}` } : null;
      this.#newestHostImage.set(architecture, { at: this.#now(), image });
    }
    return image ? { imageNameOrSnapshotId: image.id, imageLabel: image.label } : { imageNameOrSnapshotId: this.#baseImage(), imageLabel: this.#baseImage() };
  }

  async #hostImageBuildDue(architecture: Architecture, signal?: AbortSignal): Promise<string | null> {
    if (!this.#buildsHostImages(architecture) || this.#buildingHostImage.size > 0 || (this.#reach?.canReach() ?? null) !== null) return null;
    for (const other of this.#architectures) if (other !== architecture && (await this.#hostImages.resumable(other))) return null;
    if ((await this.#boxesWaitedForRoomAt()) !== null) return null;
    const failures = await this.#failures(architecture);
    if (failures && this.#now() - failures.atMs < retryAfterMs(failures)) return null;
    if (await this.#hostImages.beingMade(signal, architecture)) return null;
    const why = this.#hostImages.whyBuild(await this.#hostImages.newest(signal, architecture), this.#now(), await this.#bbApp(signal));
    if (!why) return null;
    const limit = this.#config.monthlyLimitEurosBeforeVat;
    if (limit !== null) {
      const price = await this.#price(this.#typeOf(architecture), signal).catch(() => null);
      const spent = await this.#spentThisMonth(signal).catch(() => null);
      if (!price || spent === null || spent + HOST_IMAGE_BUILD_HOURS * price.hourly > limit) return null;
    }
    return why;
  }

  #remoteBuild(): RemoteBuild {
    if (this.#options.remoteBuild) return this.#options.remoteBuild;
    if (this.#options.buildImage) return localRemoteBuild(this.#buildImageOn, (record) => (this.#options.reachHost ? this.#options.reachHost(record) : this.#reach!.cli(record)));
    return scriptRemoteBuild((record, script, options) => (this.#options.runOnHost ? this.#options.runOnHost(record, script, options) : this.#reach!.run(record, script, options)), () => setupArchive());
  }

  async #failures(architecture: Architecture): Promise<HostImageFailures | null> {
    const stored = await this.#context.storage.get<HostImageFailures | number>(HOST_IMAGE_FAILED_KEY[architecture]);
    if (stored === undefined || stored === null) return null;
    return typeof stored === "number" ? { atMs: stored, inARow: 1 } : stored;
  }

  buildHostImage(why: string, signal?: AbortSignal, architecture: Architecture = "x86"): Promise<void> {
    const running = this.#buildingHostImage.get(architecture);
    if (running) return running;
    const build = (async () => {
      this.#context.log?.(`Building a Hetzner Cloud ${ARCHITECTURE_WORDS[architecture]} host image, as ${why}.`);
      const images = DOCKER_TARGETS[architecture].flatMap((kind) => {
        const image = this.#dockerConfig[architecture].images[kind];
        return image ? [{ image, target: BUILD_TARGET[kind]! }] : [];
      });
      try {
        await this.#hostImages.build(
          {
            spec: {
              serverType: this.#typeOf(architecture),
              location: this.#config.location,
              imageNameOrSnapshotId: this.#baseImage(),
              imageLabel: this.#baseImage(),
              sshKeys: this.#reach ? [await this.#reach.hetznerSshKeyId(signal)] : undefined,
              firewalls: this.#reach ? [await this.#reach.firewallId(signal)] : undefined,
              userData: this.#options.userData ?? ((_hostId, serverName) => this.#userData(serverName, signal)),
            },
            images,
            architecture,
            cliOf: (record) => (this.#options.reachHost ? this.#options.reachHost(record) : this.#reach!.cli(record)),
            run: (record, script, options) => (this.#options.runOnHost ? this.#options.runOnHost(record, script, options) : this.#reach!.run(record, script, options)),
            remote: this.#remoteBuild(),
            bbUrl: this.#context.bbUrl?.() ?? null,
            appSha256: await this.#bbApp(signal),
            log: (line) => this.#context.log?.(line),
            sleep: this.#options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
          },
          signal ?? new AbortController().signal,
        );
        this.#newestHostImage.delete(architecture);
        await this.#hostImages.prune(undefined, signal, architecture);
        await this.#context.storage.delete(HOST_IMAGE_FAILED_KEY[architecture]);
        await this.#context.storage.delete(HOST_IMAGE_WAITING_KEY[architecture]);
      } catch (error) {
        if (bbBoxIsStopping(error, signal)) return;
        if (error instanceof HetznerError && (error.overLimit || error.unavailable)) {
          await this.#context.storage.set(HOST_IMAGE_WAITING_KEY[architecture], { atMs: this.#now(), why: error.message } satisfies WaitingForRoom);
          this.#context.log?.(`The ${ARCHITECTURE_WORDS[architecture]} host image waits for room in the Hetzner Cloud project: ${error.message}`);
          return;
        }
        const making = await this.#hostImages.beingMade(signal, architecture).catch(() => null);
        if (making) {
          this.#context.log?.(`The ${ARCHITECTURE_WORDS[architecture]} host image build stopped waiting for snapshot ${making.id}, which Hetzner Cloud is still making: bb-box takes it once it is ready.`);
          return;
        }
        const before = await this.#failures(architecture);
        await this.#context.storage.set(HOST_IMAGE_FAILED_KEY[architecture], { atMs: this.#now(), inARow: (before?.inARow ?? 0) + 1 } satisfies HostImageFailures);
        throw error;
      }
    })().finally(() => this.#buildingHostImage.delete(architecture));
    this.#buildingHostImage.set(architecture, build);
    return build;
  }

  async #untilDockerAnswers(part: HostPart, signal: AbortSignal | undefined): Promise<void> {
    const within = this.#options.hostAnswersWithinMs ?? PLAIN_IMAGE_HOST_ANSWERS_WITHIN_MS;
    const pollMs = this.#options.pollMs ?? 2_000;
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const probeKind = part.docker.kinds()[0]?.id ?? "linux";
    let last: unknown = null;
    for (let waited = 0; waited <= within; waited += pollMs) {
      const report = await part.docker.capacity(probeKind, { cores: 1, memoryMiB: 1, diskGiB: null }, [], signal).catch((error: unknown) => error);
      if (!(report instanceof Error) && (report as Capacity).hosts.length && !/did not answer/.test((report as Capacity).message ?? "")) return;
      last = report instanceof Error ? report : (report as Capacity).message;
      await sleep(pollMs, signal);
    }
    throw new Error(`Hetzner Cloud host ${part.record.serverName} ran, but its Docker did not answer within ${Math.round(within / 1000)} s: ${last instanceof Error ? last.message : String(last)}`);
  }

  async #deleteHost(record: HostRecord, signal?: AbortSignal): Promise<void> {
    this.#parts.delete(record.hostId);
    await this.#reach?.forget(record.hostId);
    await this.hostRecords.delete(record.hostId, signal);
    await this.#removeFromTailnet([record.serverName], signal);
  }

  async #removeFromTailnet(serverNames: readonly string[] | "every one this install has no host for", signal?: AbortSignal): Promise<void> {
    const tailnet = this.#context.tailnet?.() ?? null;
    if (!tailnet) return;
    try {
      const prefixes = [serverNamePrefix(this.#context.installId), serverNamePrefixBeforeHz(this.#context.installId)].map(tailnetHostname);
      const records = [...(await this.hostRecords.records()), ...(await this.#hostImages.builds.records())];
      const known = new Set(records.map((record) => tailnetHostname(record.serverName)));
      const wanted = serverNames === "every one this install has no host for" ? null : new Set(serverNames.map(tailnetHostname));
      for (const device of await tailnet.devices(signal)) {
        const gone = wanted ? wanted.has(device.hostname) : prefixes.some((prefix) => device.hostname.startsWith(prefix)) && !known.has(device.hostname);
        if (gone) await tailnet.removeDevice(device.id, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#context.logError("remove a deleted Hetzner Cloud host from the tailnet", error);
    }
  }

  #partFor(record: HostRecord): HostPart {
    const known = this.#parts.get(record.hostId);
    if (known) return known;
    const architecture = this.#architectureOfType(record.serverType);
    const context: BackendContext = {
      ...this.#context,
      id: `${this.#context.id}/${record.hostId}`,
      storage: scopedStorage(this.#context.storage, `docker/${record.hostId}/`),
      machines: undefined,
    };
    const cli = this.#options.reachHost ? this.#options.reachHost(record) : this.#reach!.cli(record);
    const docker = new DockerBackend({ ...this.#dockerConfig[architecture], host: `hetzner://${record.serverName}`, machine: null }, context, {
      ...this.#options.dockerOptions,
      cliReachingAHostAnotherBackendMade: cli,
    });
    const part = { record, architecture, cli, docker };
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

  async #serverTypeNow(name: string, signal?: AbortSignal): Promise<ServerType | null> {
    if (!this.#serverTypes.has(name)) this.#serverTypes.set(name, await this.#api.serverType(name, signal));
    return this.#serverTypes.get(name) ?? null;
  }

  async #price(serverType: string, signal?: AbortSignal): Promise<EurosBeforeVat> {
    const cached = this.#prices.get(serverType);
    if (cached && this.#now() - cached.at < PRICE_CACHE_MS) return cached.price;
    const prices = await this.#api.pricesBeforeVat(serverType, this.#config.location, signal);
    if (!prices) throw new Error(`Hetzner Cloud sells no ${serverType} in ${this.#config.location}.`);
    const price = serverAndIpv4(prices);
    this.#prices.set(serverType, { at: this.#now(), price });
    return price;
  }

  async #spentThisMonth(signal?: AbortSignal): Promise<number> {
    const now = this.#now();
    const ended = (await Promise.all((await this.#context.storage.list(BILLED_PREFIX)).map((key) => this.#context.storage.get<BilledServerOfType>(key)))).filter((each): each is BilledServerOfType => each !== undefined);
    const records = [...(await this.hostRecords.records()), ...(await this.#hostImages.builds.records())];
    const running: BilledServerOfType[] = records.filter((record) => record.serverId !== null || record.state === "ready").map((record) => ({ hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: null, serverType: record.serverType }));
    let sum = 0;
    for (const server of [...ended, ...running]) sum += spentThisMonth([server], await this.#price(server.serverType ?? this.#config.serverType, signal), now);
    return sum;
  }

  async #billEnded(record: HostRecord, goneAtMs: number): Promise<void> {
    if (record.serverId === null) return;
    await this.#context.storage.set(BILLED_PREFIX + record.hostId, { hostId: record.hostId, startedAtMs: record.claimedAtMs, endedAtMs: goneAtMs, serverType: record.serverType } satisfies BilledServerOfType);
    const before = startOfMonthUtc(startOfMonthUtc(goneAtMs) - 1);
    for (const key of await this.#context.storage.list(BILLED_PREFIX)) {
      const each = await this.#context.storage.get<BilledServer>(key);
      if (each && (each.endedAtMs ?? goneAtMs) < before) await this.#context.storage.delete(key);
    }
  }
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
}
