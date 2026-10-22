import { randomInt } from "node:crypto";
import type { BackendStorage } from "../types.ts";
import { HetznerError, type Hetzner, type HetznerServer, type Labels } from "./api.ts";

export const LABEL = {
  install: "bbbox-install",
  host: "bbbox-host",
  role: "bbbox-role",
  image: "bbbox-image",
} as const;

export type HostState = "creating" | "ready" | "deleting";

export interface HostRecord {
  readonly hostId: string;
  readonly serverName: string;
  readonly state: HostState;
  readonly serverId: number | null;
  readonly claimedAtMs: number;
  readonly serverType: string;
  readonly location: string;
  readonly ipv4: string | null;
  readonly ipv6: string | null;
}

export interface HostSpec {
  readonly serverType: string;
  readonly location: string;
  readonly imageNameOrSnapshotId: string | number;
  readonly imageLabel: string;
  readonly sshKeys?: readonly number[];
  readonly firewalls?: readonly number[];
  readonly userData?: (hostId: string, serverName: string) => Promise<string> | string;
}

export interface SweepOutcome {
  readonly deletedUnclaimedServers: readonly string[];
  readonly finishedDeletes: readonly string[];
  readonly abandonedCreates: readonly string[];
  readonly droppedRecordsOfGoneServers: readonly string[];
  readonly adoptedServers: readonly string[];
}

export const UNCLAIMED_SERVER_GRACE_MS = 10 * 60_000;

const RECORD_PREFIX = "host:";
const HOST_ID_LETTERS = "abcdefghijklmnopqrstuvwxyz0123456789";

export function newHostId(): string {
  return Array.from({ length: 8 }, () => HOST_ID_LETTERS[randomInt(HOST_ID_LETTERS.length)]).join("");
}

export function serverNameFor(installId: string, hostId: string): string {
  return `bb-box-${installId.replace(/-+$/, "")}-${hostId}`;
}

export class HetznerHosts {
  readonly #api: Hetzner;
  readonly #storage: BackendStorage;
  readonly #installId: string;
  readonly #now: () => number;
  readonly #inThisProcess = new Set<string>();
  #sweeping: Promise<SweepOutcome> | null = null;

  constructor(options: { api: Hetzner; storage: BackendStorage; installId: string; now?: () => number }) {
    this.#api = options.api;
    this.#storage = options.storage;
    this.#installId = options.installId;
    this.#now = options.now ?? Date.now;
  }

  get installLabels(): Labels {
    return { [LABEL.install]: this.#installId };
  }

  async records(): Promise<HostRecord[]> {
    const keys = await this.#storage.list(RECORD_PREFIX);
    const found = await Promise.all(keys.map((key) => this.#storage.get<HostRecord>(key)));
    return found.filter((each): each is HostRecord => each !== undefined).sort((a, b) => a.claimedAtMs - b.claimedAtMs);
  }

  async record(hostId: string): Promise<HostRecord | null> {
    return (await this.#storage.get<HostRecord>(RECORD_PREFIX + hostId)) ?? null;
  }

  async create(spec: HostSpec, signal?: AbortSignal): Promise<HostRecord> {
    const hostId = newHostId();
    const serverName = serverNameFor(this.#installId, hostId);
    this.#inThisProcess.add(hostId);
    let record: HostRecord = {
      hostId,
      serverName,
      state: "creating",
      serverId: null,
      claimedAtMs: this.#now(),
      serverType: spec.serverType,
      location: spec.location,
      ipv4: null,
      ipv6: null,
    };
    try {
      await this.#save(record);
      try {
        const server = await this.#createOrFindServer(record, spec, signal);
        record = { ...record, serverId: server.server.id, ipv4: server.server.ipv4, ipv6: server.server.ipv6 };
        await this.#save(record);
        for (const action of server.startActions) await this.#api.waitAction(action, signal);
        const running = await this.#api.waitUntilRunning(server.server.id, signal);
        record = { ...record, state: "ready", ipv4: running.ipv4, ipv6: running.ipv6 };
        await this.#save(record);
        return record;
      } catch (error) {
        await this.delete(hostId).catch(() => undefined);
        throw error;
      }
    } finally {
      this.#inThisProcess.delete(hostId);
    }
  }

  async delete(hostId: string, signal?: AbortSignal): Promise<void> {
    const record = await this.record(hostId);
    if (!record) return;
    this.#inThisProcess.add(hostId);
    try {
      await this.#save({ ...record, state: "deleting" });
      const serverId = record.serverId ?? (await this.#serverOfHost(hostId, signal))?.id ?? null;
      if (serverId !== null) await this.#api.deleteServer(serverId, signal);
      await this.#storage.delete(RECORD_PREFIX + hostId);
    } finally {
      this.#inThisProcess.delete(hostId);
    }
  }

  sweep(signal?: AbortSignal): Promise<SweepOutcome> {
    this.#sweeping ??= this.#sweep(signal).finally(() => {
      this.#sweeping = null;
    });
    return this.#sweeping;
  }

  async #sweep(signal?: AbortSignal): Promise<SweepOutcome> {
    const outcome = {
      deletedUnclaimedServers: [] as string[],
      finishedDeletes: [] as string[],
      abandonedCreates: [] as string[],
      droppedRecordsOfGoneServers: [] as string[],
      adoptedServers: [] as string[],
    };
    const servers = await this.#api.servers(this.installLabels, signal);
    const records = new Map((await this.records()).map((each) => [each.hostId, each]));
    const now = this.#now();
    const pastGrace = (sinceMs: number) => now - sinceMs > UNCLAIMED_SERVER_GRACE_MS;

    for (const server of servers) {
      const hostId = server.labels[LABEL.host] ?? "";
      const record = records.get(hostId);
      if (record && record.serverName === server.name) {
        if (record.serverId === null && !this.#inThisProcess.has(hostId)) {
          const adopted = { ...record, serverId: server.id, ipv4: server.ipv4, ipv6: server.ipv6 };
          await this.#save(adopted);
          records.set(hostId, adopted);
          outcome.adoptedServers.push(server.name);
        }
        continue;
      }
      if (this.#inThisProcess.has(hostId) || !pastGrace(server.createdAtMs)) continue;
      await this.#api.deleteServer(server.id, signal);
      outcome.deletedUnclaimedServers.push(server.name);
    }

    const listed = new Map(servers.map((server) => [server.labels[LABEL.host] ?? "", server]));
    for (const record of records.values()) {
      if (this.#inThisProcess.has(record.hostId)) continue;
      const server = listed.get(record.hostId);
      if (record.state === "deleting") {
        await this.delete(record.hostId, signal);
        outcome.finishedDeletes.push(record.serverName);
      } else if (record.state === "creating" && pastGrace(record.claimedAtMs)) {
        await this.delete(record.hostId, signal);
        outcome.abandonedCreates.push(record.serverName);
      } else if (record.state === "ready" && !server) {
        await this.#storage.delete(RECORD_PREFIX + record.hostId);
        outcome.droppedRecordsOfGoneServers.push(record.serverName);
      }
    }
    return outcome;
  }

  async unclaimedServers(signal?: AbortSignal): Promise<HetznerServer[]> {
    const servers = await this.#api.servers(this.installLabels, signal);
    const records = new Map((await this.records()).map((each) => [each.hostId, each]));
    return servers.filter((server) => records.get(server.labels[LABEL.host] ?? "")?.serverName !== server.name);
  }

  async #createOrFindServer(record: HostRecord, spec: HostSpec, signal?: AbortSignal): Promise<{ server: HetznerServer; startActions: number[] }> {
    const labels = { ...this.installLabels, [LABEL.host]: record.hostId, [LABEL.role]: "host", [LABEL.image]: spec.imageLabel };
    try {
      return await this.#api.createServer(
        {
          name: record.serverName,
          serverType: spec.serverType,
          location: spec.location,
          imageNameOrSnapshotId: spec.imageNameOrSnapshotId,
          labels,
          sshKeys: spec.sshKeys,
          firewalls: spec.firewalls,
          userData: spec.userData ? await spec.userData(record.hostId, record.serverName) : undefined,
        },
        signal,
      );
    } catch (error) {
      if (!(error instanceof HetznerError) || !(error.taken || error.unreachable)) throw error;
      const made = await this.#serverOfHost(record.hostId, signal);
      if (!made || made.name !== record.serverName) throw error;
      return { server: made, startActions: [] };
    }
  }

  async #serverOfHost(hostId: string, signal?: AbortSignal): Promise<HetznerServer | null> {
    const [found] = await this.#api.servers({ ...this.installLabels, [LABEL.host]: hostId }, signal);
    return found ?? null;
  }

  async #save(record: HostRecord): Promise<void> {
    await this.#storage.set(RECORD_PREFIX + record.hostId, record);
  }
}
