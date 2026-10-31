import type { AcquireHooks, BoxIdentity, BoxSize, ForkArming, Guest, SnapshotRef } from "../types.ts";
import { ProxmoxError, type Proxmox } from "./api.ts";
import { netKeys, netWith } from "./copies.ts";
import { describe, installFromDescription, ownerFromDescription } from "./owner.ts";
import { cloneWaitMs, storageOfVolume } from "./snapshotting.ts";

export interface ForkGuests {
  readonly installId: string;
  readonly pool: string;
  client(): Promise<Proxmox>;
  vmid(guest: Guest): number;
  ownConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  sourceConfig(api: Proxmox, guest: Guest, signal?: AbortSignal): Promise<Record<string, unknown>>;
  rootDisk(config: Record<string, unknown>): string | null;
  claimVmid(api: Proxmox, signal?: AbortSignal): Promise<number>;
  unreserve(vmid: number): void;
  forget(vmid: number): Promise<void>;
  guest(node: string, vmid: number, template: number | null, box: string, build: string | null): Guest;
  addressed(api: Proxmox, vmid: number, made: Record<string, unknown>, box: BoxIdentity, template: number | null, signal?: AbortSignal): Promise<void>;
  sizeOf(config: Record<string, unknown>): BoxSize | null;
  logError(operation: string, error: unknown): void;
}

function proxmoxWords(error: ProxmoxError): string {
  return /failed \(\d+\): (.*)$/s.exec(error.message)?.[1]?.trim() || error.message;
}

function madeFor(config: Record<string, unknown> | null, boxId: string, installId: string): boolean {
  return !!config && ownerFromDescription(config.description)?.boxId === boxId && installFromDescription(config.description) === installId;
}

async function configOrNull(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<Record<string, unknown> | null> {
  try {
    return await api.config(vmid, signal);
  } catch (error) {
    if (error instanceof ProxmoxError && error.gone) return null;
    throw error;
  }
}

async function dropHalfMadeFork(guests: ForkGuests, api: Proxmox, previous: Guest, box: BoxIdentity, signal: AbortSignal): Promise<void> {
  const vmid = Number(previous.ref);
  if (!Number.isInteger(vmid)) return;
  if (!madeFor(await configOrNull(api, vmid, signal), box.boxId, guests.installId)) return;
  await guests.forget(vmid);
  const cannot = (why: string) => new Error(`bb-box could not delete guest ${vmid}, the copy a fork of box ${box.name} had begun before bb-box restarted, so it makes no other: ${why}`);
  const { lockOutlasted } = await disarmBeforeDelete(guests, api, vmid, "a fork cut short by a restart", signal);
  if (lockOutlasted) throw cannot("Proxmox still holds its lock.");
  try {
    await api.destroy(vmid, signal);
  } catch (error) {
    if (error instanceof ProxmoxError && error.gone) return;
    throw cannot(error instanceof ProxmoxError ? proxmoxWords(error) : String(error));
  }
  if (madeFor(await configOrNull(api, vmid, signal), box.boxId, guests.installId)) throw cannot("it is still there after its delete.");
}

async function disarmBeforeDelete(guests: Pick<ForkGuests, "logError">, api: Proxmox, vmid: number, what: string, signal?: AbortSignal): Promise<{ readonly lockOutlasted: boolean }> {
  try {
    await disarm(api, vmid, signal);
    return { lockOutlasted: false };
  } catch (error) {
    guests.logError(`disarm guest ${vmid}, ${what}, before deleting it`, error);
    return { lockOutlasted: error instanceof ProxmoxError && error.locked };
  }
}

export async function disarmFork(guests: Pick<ForkGuests, "client" | "vmid" | "installId">, guest: Guest, signal?: AbortSignal): Promise<void> {
  const box = typeof guest.data?.box === "string" ? guest.data.box : null;
  if (!box) return;
  const api = await guests.client();
  const vmid = guests.vmid(guest);
  if (madeFor(await configOrNull(api, vmid, signal), box, guests.installId)) await disarm(api, vmid, signal);
}

export async function disarm(api: Proxmox, vmid: number, signal?: AbortSignal): Promise<void> {
  const made = await api.config(vmid, signal);
  const nets = Object.fromEntries(netKeys(made).map((key) => [key, netWith(String(made[key]), { up: false })]));
  await api.setNetwork(vmid, { ...nets, onboot: "0" }, signal);
}

export async function armFork(guests: Pick<ForkGuests, "client" | "vmid" | "ownConfig">, guest: Guest, arming: ForkArming, signal?: AbortSignal): Promise<void> {
  const api = await guests.client();
  const vmid = guests.vmid(guest);
  const config = await guests.ownConfig(api, guest, signal);
  if (arming === "boot") {
    await api.setNetwork(vmid, { onboot: "1" }, signal);
    return;
  }
  const nets = Object.fromEntries(netKeys(config).map((key) => [key, netWith(String(config[key]), { up: true })]));
  await api.setNetwork(vmid, nets, signal);
}

export async function forkByFullClone(guests: ForkGuests, ref: SnapshotRef, box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
  const api = await guests.client();
  if (previous) await dropHalfMadeFork(guests, api, previous, box, signal);
  const from = guests.vmid(ref.guest);
  const fromCopy = ref.from === "held-copy";
  const source = await guests.sourceConfig(api, ref.guest, signal);
  const disk = guests.rootDisk(source);
  const template = typeof ref.guest.data?.template === "number" ? ref.guest.data.template : null;
  const build = typeof ref.guest.data?.build === "string" ? ref.guest.data.build : null;
  const vmid = await guests.claimVmid(api, signal);
  try {
    const guest = guests.guest(api.node, vmid, template, box.boxId, build);
    await hooks.claim(guest);
    const began = performance.now();
    let upid: string;
    try {
      upid = await api.startFullClone({ source: from, vmid, hostname: box.name, pool: guests.pool, storage: disk ? storageOfVolume(source[disk]) : null, description: describe(box, guests.installId), ...(fromCopy ? {} : { snapshot: ref.ref }) }, signal);
    } catch (error) {
      if (error instanceof ProxmoxError && error.status >= 400) throw new Error(`Proxmox refused to copy ${fromCopy ? "held copy" : `snapshot ${ref.ref} of guest`} ${from}: ${proxmoxWords(error)}`);
      throw error;
    }
    try {
      await api.waitTask(upid, signal, cloneWaitMs(guests.sizeOf(source)?.diskGiB ?? null));
    } catch (error) {
      if (error instanceof ProxmoxError && error.method === "TASK" && error.status === 500) throw new Error(`Proxmox's copy of snapshot ${ref.ref} of guest ${from} failed: ${proxmoxWords(error)}`);
      throw error;
    }
    hooks.timing("copy", Math.round(performance.now() - began));
    const addressing = performance.now();
    await disarm(api, vmid, signal);
    await guests.addressed(api, vmid, await api.config(vmid, signal), box, template, signal);
    hooks.timing("address", Math.round(performance.now() - addressing));
    return { ...guest, size: guests.sizeOf(await api.config(vmid, signal)) };
  } catch (error) {
    const made = await configOrNull(api, vmid).catch(() => null);
    if (madeFor(made, box.boxId, guests.installId)) {
      await guests.forget(vmid);
      const { lockOutlasted } = await disarmBeforeDelete(guests, api, vmid, "a fork that failed");
      if (lockOutlasted) guests.logError(`delete guest ${vmid}, a fork that failed; bb-box tries again`, new Error("Proxmox still holds its lock, so bb-box neither disarmed nor deleted it yet."));
      else await api.destroy(vmid).catch((cause) => guests.logError(`delete guest ${vmid}, a fork that failed; bb-box tries again`, cause));
    }
    throw error;
  } finally {
    guests.unreserve(vmid);
  }
}
