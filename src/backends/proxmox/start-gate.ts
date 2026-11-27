import { PRODUCT } from "../../brand.ts";
import { BackendError, type BackendContext, type GuestOs } from "../types.ts";
import { sleep as defaultSleep, type GuestType, type NodeGuest, type NodeStatus, type Proxmox } from "./api.ts";

const MIB = 2 ** 20;
const DEFAULT_GUEST_MEMORY_MIB = 512;

export const START_MEMORY_MARGIN_DEFAULT_MIB = 16_384;
export const START_MEMORY_WAIT_DEFAULT_S = 600;
export const HEAVY_START_SETTLE_DEFAULT_S = 120;
export const START_GATE_POLL_MS = 10_000;
export const RECENT_BOOT_WINDOW_S = 10 * 60;
export const RECENT_BOOT_WINDOW_MS = RECENT_BOOT_WINDOW_S * 1000;
export const HEAVY_BALLOON_OFF_MEMORY_MIB = 4_096;

declare const START_PERMIT: unique symbol;

export interface StartPermit {
  readonly [START_PERMIT]: true;
}

const issuedPermits = new WeakSet<object>();

export function assertStartPermit(permit: StartPermit): void {
  if (typeof permit !== "object" || permit === null || !issuedPermits.has(permit)) {
    throw new Error("A Proxmox guest start must go through the node start gate.");
  }
}

export type StartPriority = "acquire" | "refill";

export interface StartGateConfig {
  readonly memoryMarginMiB: number;
  readonly memoryWaitSeconds: number;
  readonly heavySettleSeconds: number;
}

export interface StartGuestRequest {
  readonly vmid: number;
  readonly memoryMiB?: number;
  readonly heavy?: boolean;
  readonly kind?: string;
  readonly os?: GuestOs;
  readonly priority: StartPriority;
  readonly config: StartGateConfig;
  readonly signal?: AbortSignal;
  readonly waiting?: (words: string | null) => Promise<void>;
  readonly onAdmitted?: () => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CanStartRequest {
  readonly vmid?: number;
  readonly memoryMiB: number;
  readonly heavy?: boolean;
  readonly kind?: string;
  readonly os?: GuestOs;
  readonly priority: StartPriority;
  readonly config: StartGateConfig;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export type CanStartResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

interface InFlightStart {
  readonly vmid: number;
  readonly memoryMiB: number;
  readonly heavy: boolean;
  readonly admittedAt: number;
}

interface RecentStart {
  readonly vmid: number;
  readonly heavy: boolean;
  readonly uptimeSeconds: number;
  readonly untouchedBytes: number;
  readonly inFlight: boolean;
}

interface NodeReading {
  readonly nodeStatus: NodeStatus;
  readonly recent: readonly RecentStart[];
}

interface HeavyVerdict {
  readonly heavy: boolean;
  readonly memoryMaxBytes: number;
  readonly uptimeSeconds: number;
}

const CONFIG_READS_AT_ONCE = 4;

interface Admission {
  readonly ok: boolean;
  readonly needBytes: number;
  readonly guestBytes: number;
  readonly marginBytes: number;
  readonly availableBytes: number;
  readonly recentHeldBytes: number;
  readonly effectiveAvailableBytes: number;
  readonly shortfallBytes: number;
}

interface StartWaiter {
  readonly seq: number;
  readonly priority: number;
  readonly heavy: boolean;
  readonly api: Proxmox;
  readonly vmid: number;
  readonly memoryMiB: number;
  readonly config: StartGateConfig;
  readonly signal?: AbortSignal;
  readonly waiting?: (words: string | null) => Promise<void>;
  readonly onAdmitted?: () => void;
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly runStart: (permit: StartPermit) => Promise<void>;
  readonly resolve: (waitedMs: number) => void;
  readonly reject: (error: unknown) => void;
  readonly enqueuedAt: number;
  readonly detachAbort: () => void;
  lastWaitingWords: string | null;
  aborted: boolean;
}

export function startGateKey(apiUrl: string, node: string): string {
  return `proxmox-start-gate:${new URL(apiUrl).host.toLowerCase()}/${node}`;
}

export function sharedStartGate(
  context: Pick<BackendContext, "shared">,
  apiUrl: string,
  node: string,
  fallback: Map<string, ProxmoxStartGate>,
): ProxmoxStartGate {
  const key = startGateKey(apiUrl, node);
  if (context.shared) return context.shared(key, () => new ProxmoxStartGate());
  let gate = fallback.get(key);
  if (!gate) {
    gate = new ProxmoxStartGate();
    fallback.set(key, gate);
  }
  return gate;
}

export function effectiveStartMemoryMarginMiB(configuredMarginMiB: number, nodeTotalBytes: number): number {
  const configured = Math.max(0, configuredMarginMiB);
  const nodeTotalMiB = Math.floor(nodeTotalBytes / MIB);
  if (nodeTotalMiB <= 0) return configured;
  return Math.min(configured, Math.floor(nodeTotalMiB / 4));
}

export function configuredMemoryMiB(config: Readonly<Record<string, unknown>>): number {
  const match = /(?:^|current=)(\d+)/.exec(String(config.memory ?? ""));
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GUEST_MEMORY_MIB;
}

export function isBalloonOff(config: Readonly<Record<string, unknown>>): boolean {
  return config.balloon === 0 || config.balloon === "0";
}

export function isHeavyGuest(
  type: GuestType,
  config: Readonly<Record<string, unknown>>,
  memoryMiB: number,
  kind?: string,
  os?: GuestOs,
): boolean {
  if (type !== "qemu") return false;
  if (os === "windows" || kind === "windows-desktop" || kind === "android") return true;
  if (/^win/i.test(String(config.ostype ?? ""))) return true;
  return isBalloonOff(config) && memoryMiB > HEAVY_BALLOON_OFF_MEMORY_MIB;
}

function formatGiBFromBytes(bytes: number, floorNonZero = false): string {
  const positive = Math.max(0, bytes);
  const raw = positive / (1024 * MIB);
  const rounded = Math.round(raw * 10) / 10;
  const shown = floorNonZero && positive > 0 && rounded < 0.1 ? 0.1 : rounded;
  return `${shown.toFixed(1).replace(/\.0$/, "")} GiB`;
}

function formatMiBLabel(mib: number): string {
  return formatGiBFromBytes(mib * MIB);
}

export function placementMemoryProblem(input: {
  readonly node: string;
  readonly memoryTotalMiB: number;
  readonly memoryFreeMiB: number;
  readonly needMiB: number;
  readonly boxWords: string;
  readonly grown: boolean;
  readonly reserveMiB: number;
  readonly effectiveMarginMiB: number;
}): string | null {
  const { node, memoryTotalMiB, memoryFreeMiB, needMiB, boxWords, grown, reserveMiB, effectiveMarginMiB } = input;
  if (needMiB <= 0) return null;

  const keepMiB = grown ? reserveMiB : Math.max(reserveMiB, effectiveMarginMiB);
  const marginBinds = !grown && effectiveMarginMiB > reserveMiB;

  if (!grown && memoryTotalMiB > 0 && needMiB + effectiveMarginMiB > memoryTotalMiB) {
    return (
      `${node} has ${formatMiBLabel(memoryTotalMiB)} of memory and keeps a ${formatMiBLabel(effectiveMarginMiB)} start memory margin, ` +
      `so ${boxWords} cannot fit. Ask for less memory, or lower the start memory margin in ${PRODUCT}'s settings.`
    );
  }

  if (memoryFreeMiB - needMiB >= keepMiB) return null;

  if (needMiB > memoryFreeMiB) {
    const needs = grown ? `the ${formatMiBLabel(needMiB)} more ${boxWords} needs` : `${boxWords} needs`;
    return `${node} has ${formatMiBLabel(Math.max(0, memoryFreeMiB))} of memory free, less than ${needs}. Release a box or ask for less memory.`;
  }

  if (marginBinds) {
    const shortfall = formatGiBFromBytes((needMiB + effectiveMarginMiB - memoryFreeMiB) * MIB, true);
    return (
      `${node} is short by ${shortfall} of free memory ` +
      `(needs ${formatMiBLabel(needMiB + effectiveMarginMiB)}: ${formatMiBLabel(needMiB)} for ${boxWords} plus ${formatMiBLabel(effectiveMarginMiB)} margin; ` +
      `${formatMiBLabel(memoryFreeMiB)} available). ` +
      `Stop or release a box on ${node}, ask for less memory, or lower the start memory margin in ${PRODUCT}'s settings.`
    );
  }

  return (
    `${node} has ${formatMiBLabel(memoryFreeMiB)} of memory free and keeps ${formatMiBLabel(reserveMiB)} free, ` +
    `so ${boxWords}${grown ? `, which needs ${formatMiBLabel(needMiB)} more,` : ""} does not fit. ` +
    (grown || memoryFreeMiB > reserveMiB
      ? `Release a box, ask for less memory, or lower the memory kept free in ${PRODUCT}'s settings.`
      : `Release a box, or lower the memory kept free in ${PRODUCT}'s settings.`)
  );
}

function evaluateAdmission(availableBytes: number, recentHeldBytes: number, memoryMiB: number, effectiveMarginMiB: number): Admission {
  const guestBytes = memoryMiB * MIB;
  const marginBytes = effectiveMarginMiB * MIB;
  const needBytes = guestBytes + marginBytes;
  const effectiveAvailableBytes = Math.max(0, availableBytes - recentHeldBytes);
  const shortfallBytes = Math.max(0, needBytes - effectiveAvailableBytes);
  return {
    ok: availableBytes - recentHeldBytes >= needBytes,
    needBytes,
    guestBytes,
    marginBytes,
    availableBytes,
    recentHeldBytes,
    effectiveAvailableBytes,
    shortfallBytes,
  };
}

function memoryWaitWords(node: string, admission: Admission): string {
  const need = formatGiBFromBytes(admission.needBytes);
  const guest = formatGiBFromBytes(admission.guestBytes);
  const margin = formatGiBFromBytes(admission.marginBytes);
  const available = formatGiBFromBytes(admission.availableBytes);
  const recent = formatGiBFromBytes(admission.recentHeldBytes);
  const needDetail = admission.marginBytes > 0 ? `${need} (${guest} plus ${margin} margin)` : need;
  const heldDetail = admission.recentHeldBytes > 0 ? ` (${recent} still held by recent starts)` : "";
  return `Waiting for free memory on ${node}: needs ${needDetail}, ${available} available${heldDetail}.`;
}

function heavyWaitWords(node: string, remainingSeconds: number): string {
  return `Waiting ${remainingSeconds} s for a recent heavy VM start on ${node} to settle.`;
}

function settleTimeoutError(node: string, waitSeconds: number): BackendError {
  const waited = waitSeconds > 0 ? ` within ${waitSeconds} s` : "";
  return new BackendError(
    "no_capacity",
    `A heavy VM on ${node} started too recently${waited}, and ${PRODUCT} boots one heavy VM at a time. ` +
      `Try again in a few minutes, or lower the heavy start settle time in ${PRODUCT}'s settings.`,
  );
}

function queueTimeoutError(node: string, waitSeconds: number): BackendError {
  const waited = waitSeconds > 0 ? ` for ${waitSeconds} s` : "";
  return new BackendError("no_capacity", `The guest waited in ${node}'s start queue${waited} behind other starts. Try again in a few minutes.`);
}

function unreadNodeError(node: string, error: unknown): BackendError {
  const why = error instanceof Error ? error.message : String(error);
  return new BackendError("no_capacity", `${PRODUCT} could not read ${node}'s memory and recent VM starts, so it did not start the guest: ${why}`);
}

function noCapacityError(node: string, admission: Admission, waitSeconds: number): BackendError {
  const shortfall = formatGiBFromBytes(admission.shortfallBytes, true);
  const need = formatGiBFromBytes(admission.needBytes);
  const guest = formatGiBFromBytes(admission.guestBytes);
  const margin = formatGiBFromBytes(admission.marginBytes);
  const available = formatGiBFromBytes(admission.availableBytes);
  const recent = formatGiBFromBytes(admission.recentHeldBytes);
  const waited = waitSeconds > 0 ? ` after waiting ${waitSeconds} s` : "";
  const marginPart = admission.marginBytes > 0 ? `${guest} for the guest plus ${margin} margin` : `${guest} for the guest`;
  const heldPart = admission.recentHeldBytes > 0 ? `, with ${recent} still held by recent starts` : "";
  return new BackendError(
    "no_capacity",
    `${node} is short by ${shortfall} of free memory${waited} (needs ${need}: ${marginPart}; ${available} available${heldPart}). ` +
      `Stop or release a box on ${node}, ask for less memory, or lower the start memory margin in ${PRODUCT}'s settings.`,
  );
}

function kindFromTags(tags: readonly string[]): string | undefined {
  return tags.find((tag) => tag.startsWith("kind."))?.slice("kind.".length);
}

async function readNodeGuestHeavy(api: Proxmox, guest: NodeGuest, signal?: AbortSignal): Promise<boolean> {
  const kind = kindFromTags(guest.tags);
  if (kind === "windows-desktop" || kind === "android") return true;

  const memoryMiB = guest.memoryMaxBytes > 0 ? Math.round(guest.memoryMaxBytes / MIB) : DEFAULT_GUEST_MEMORY_MIB;
  const read = await api.guestConfig("qemu", guest.vmid, signal);
  if (read.ok) {
    const configured = guest.memoryMaxBytes > 0 ? memoryMiB : configuredMemoryMiB(read.config);
    return isHeavyGuest("qemu", read.config, configured, kind);
  }
  if (read.reason === "not_found") return false;
  return memoryMiB > HEAVY_BALLOON_OFF_MEMORY_MIB;
}

function settleRemainingForReading(
  reading: NodeReading,
  startingVmid: number | undefined,
  heavy: boolean,
  heavySettleSeconds: number,
): number {
  if (!heavy) return 0;
  const others = reading.recent.filter((entry) => entry.heavy && entry.vmid !== startingVmid);
  if (others.length === 0) return 0;
  if (others.some((entry) => entry.inFlight)) return Math.max(1, heavySettleSeconds);
  if (heavySettleSeconds <= 0) return 0;

  let youngest = Infinity;
  for (const entry of others) {
    if (entry.uptimeSeconds < youngest) youngest = entry.uptimeSeconds;
  }
  return youngest < heavySettleSeconds ? Math.max(1, Math.ceil(heavySettleSeconds - youngest)) : 0;
}

function heldBytesForReading(reading: NodeReading, startingVmid: number | undefined): number {
  let sum = 0;
  for (const entry of reading.recent) {
    if (entry.vmid !== startingVmid) sum += entry.untouchedBytes;
  }
  return sum;
}

export class ProxmoxStartGate {
  #nextSeq = 1;
  #pumping = false;
  #wakeSeq = 0;
  #wakeController: AbortController | null = null;
  readonly #inFlight = new Map<number, InFlightStart>();
  readonly #waiters: StartWaiter[] = [];
  readonly #heavyVerdicts = new Map<number, HeavyVerdict>();

  async canStartNow(api: Proxmox, request: CanStartRequest): Promise<CanStartResult> {
    if (request.signal?.aborted) throw request.signal.reason;
    if (request.priority === "refill" && this.#waiters.some((waiter) => !waiter.aborted && waiter.priority === 0)) {
      return { ok: false, reason: `Another start is waiting on ${api.node}.` };
    }

    if (request.vmid !== undefined && this.#inFlight.has(request.vmid)) {
      return { ok: false, reason: `Guest ${request.vmid} is already starting on ${api.node}.` };
    }

    const now = (request.now ?? Date.now)();
    const heavy = request.heavy !== undefined
      ? (api.type === "qemu" && request.heavy)
      : isHeavyGuest(api.type, {}, request.memoryMiB, request.kind, request.os);

    let reading: NodeReading;
    try {
      reading = await this.#readNodeState(api, now, Math.max(RECENT_BOOT_WINDOW_S, request.config.heavySettleSeconds), request.signal);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      return { ok: false, reason: unreadNodeError(api.node, error).message };
    }
    const settleSeconds = settleRemainingForReading(reading, request.vmid, heavy, request.config.heavySettleSeconds);
    if (settleSeconds > 0) {
      return { ok: false, reason: heavyWaitWords(api.node, settleSeconds) };
    }

    const effectiveMarginMiB = effectiveStartMemoryMarginMiB(request.config.memoryMarginMiB, reading.nodeStatus.memoryTotal);
    const recentHeldBytes = heldBytesForReading(reading, request.vmid);
    const admission = evaluateAdmission(reading.nodeStatus.memoryAvailable, recentHeldBytes, request.memoryMiB, effectiveMarginMiB);
    if (!admission.ok) {
      return { ok: false, reason: noCapacityError(api.node, admission, 0).message };
    }

    return { ok: true };
  }

  async start(
    api: Proxmox,
    request: StartGuestRequest,
    runStart?: (permit: StartPermit) => Promise<void>,
  ): Promise<number> {
    if (request.signal?.aborted) throw request.signal.reason;

    const { memoryMiB, heavy } = await this.#resolveGuest(api, request);
    if (request.signal?.aborted) throw request.signal.reason;

    const now = request.now ?? Date.now;
    const sleep = request.sleep ?? defaultSleep;
    const execute = runStart ?? ((permit: StartPermit) => api.start(request.vmid, permit, request.signal));

    return new Promise<number>((resolve, reject) => {
      let waiter!: StartWaiter;
      const onAbort = () => {
        if (waiter.aborted) return;
        waiter.aborted = true;
        this.#remove(waiter);
        void this.#clearWaitingQuietly(waiter);
        reject(request.signal!.reason);
        this.#wake();
      };
      const detachAbort = () => {
        request.signal?.removeEventListener("abort", onAbort);
      };

      waiter = {
        seq: this.#nextSeq++,
        priority: request.priority === "acquire" ? 0 : 1,
        heavy,
        api,
        vmid: request.vmid,
        memoryMiB,
        config: request.config,
        signal: request.signal,
        waiting: request.waiting,
        onAdmitted: request.onAdmitted,
        now,
        sleep,
        runStart: execute,
        resolve,
        reject,
        enqueuedAt: now(),
        detachAbort,
        lastWaitingWords: null,
        aborted: false,
      };

      request.signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#wake();
      this.#ensurePumping();
    });
  }

  async #resolveGuest(api: Proxmox, request: StartGuestRequest): Promise<{ readonly memoryMiB: number; readonly heavy: boolean }> {
    const needConfig = request.memoryMiB === undefined || (api.type === "qemu" && request.heavy === undefined);
    const config = needConfig ? await api.config(request.vmid, request.signal) : {};
    const memoryMiB = request.memoryMiB ?? configuredMemoryMiB(config);
    const heavy = request.heavy !== undefined
      ? (api.type === "qemu" && request.heavy)
      : isHeavyGuest(api.type, config, memoryMiB, request.kind, request.os);
    return { memoryMiB, heavy };
  }

  #ensurePumping(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    void this.#pump().finally(() => {
      this.#pumping = false;
      if (this.#waiters.length > 0) this.#ensurePumping();
    });
  }

  #wake(): void {
    this.#wakeSeq++;
    this.#wakeController?.abort();
  }

  #remove(waiter: StartWaiter): boolean {
    const index = this.#waiters.indexOf(waiter);
    if (index < 0) return false;
    this.#waiters.splice(index, 1);
    waiter.detachAbort();
    return true;
  }

  async #reportWaiting(waiter: StartWaiter, words: string | null): Promise<void> {
    if (!waiter.waiting || waiter.lastWaitingWords === words) return;
    waiter.lastWaitingWords = words;
    try {
      await waiter.waiting(words);
    } catch {
      return;
    }
  }

  async #clearWaitingQuietly(waiter: StartWaiter): Promise<void> {
    if (!waiter.waiting || waiter.lastWaitingWords === null) return;
    waiter.lastWaitingWords = null;
    try {
      await waiter.waiting(null);
    } catch {
      return;
    }
  }

  async #readNodeState(api: Proxmox, now: number, maxWindowSeconds: number, signal?: AbortSignal): Promise<NodeReading> {
    const [nodeStatus, qemuGuests] = await Promise.all([api.nodeStatus(signal), api.nodeGuests("qemu", signal)]);

    const running = qemuGuests.filter((guest) => guest.status === "running" && !guest.template);
    const seenRunning = new Set(running.map((guest) => guest.vmid));
    for (const vmid of [...this.#heavyVerdicts.keys()]) if (!seenRunning.has(vmid)) this.#heavyVerdicts.delete(vmid);

    const young = running.filter((guest) => guest.uptime < maxWindowSeconds);
    const verdicts = await this.#heavyOf(api, young, signal);

    const recent: RecentStart[] = [];
    for (const guest of young) {
      if (!verdicts.get(guest.vmid)) continue;
      const untouchedBytes = guest.uptime < RECENT_BOOT_WINDOW_S ? Math.max(0, guest.memoryMaxBytes - guest.memoryUsedBytes) : 0;
      recent.push({ vmid: guest.vmid, heavy: true, uptimeSeconds: guest.uptime, untouchedBytes, inFlight: this.#inFlight.has(guest.vmid) });
    }

    for (const [vmid, flight] of this.#inFlight) {
      if (flight.heavy && seenRunning.has(vmid)) continue;
      const uptimeSeconds = Math.max(0, Math.floor((now - flight.admittedAt) / 1000));
      recent.push({ vmid, heavy: flight.heavy, uptimeSeconds, untouchedBytes: flight.memoryMiB * MIB, inFlight: true });
    }

    return { nodeStatus, recent };
  }

  async #heavyOf(api: Proxmox, guests: readonly NodeGuest[], signal?: AbortSignal): Promise<Map<number, boolean>> {
    const verdicts = new Map<number, boolean>();
    const unknown: NodeGuest[] = [];
    for (const guest of guests) {
      const known = this.#heavyVerdicts.get(guest.vmid);
      if (known && known.memoryMaxBytes === guest.memoryMaxBytes && guest.uptime >= known.uptimeSeconds) verdicts.set(guest.vmid, known.heavy);
      else unknown.push(guest);
    }

    for (let at = 0; at < unknown.length; at += CONFIG_READS_AT_ONCE) {
      const batch = unknown.slice(at, at + CONFIG_READS_AT_ONCE);
      const heavy = await Promise.all(batch.map((guest) => readNodeGuestHeavy(api, guest, signal)));
      batch.forEach((guest, index) => {
        verdicts.set(guest.vmid, heavy[index]!);
        this.#heavyVerdicts.set(guest.vmid, { heavy: heavy[index]!, memoryMaxBytes: guest.memoryMaxBytes, uptimeSeconds: guest.uptime });
      });
    }
    return verdicts;
  }

  async #runAdmitted(waiter: StartWaiter, permit: StartPermit, flight: InFlightStart): Promise<void> {
    const waitedMs = Math.max(0, flight.admittedAt - waiter.enqueuedAt);
    await this.#clearWaitingQuietly(waiter);
    waiter.onAdmitted?.();

    try {
      await waiter.runStart(permit);
    } catch (error) {
      waiter.reject(error);
      return;
    } finally {
      issuedPermits.delete(permit);
      if (this.#inFlight.get(waiter.vmid) === flight) this.#inFlight.delete(waiter.vmid);
      this.#wake();
    }

    waiter.resolve(waitedMs);
  }

  async #pump(): Promise<void> {
    while (this.#waiters.length > 0) {
      const seenWakeSeq = this.#wakeSeq;
      this.#dropAborted();
      if (this.#waiters.length === 0) break;

      this.#waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

      const reader = this.#waiters[0]!;
      const maxWindowSeconds = Math.max(
        RECENT_BOOT_WINDOW_S,
        ...this.#waiters.map((waiter) => waiter.config.heavySettleSeconds),
      );

      let reading: NodeReading | null = null;
      let unread: unknown = null;
      try {
        reading = await this.#readNodeState(reader.api, reader.now(), maxWindowSeconds, reader.signal);
      } catch (error) {
        if (reader.signal?.aborted) {
          this.#dropAborted();
          continue;
        }
        unread = error;
      }

      if (!reading) {
        await this.#expireUnread(unread);
        if (this.#waiters.length === 0) break;
        await this.#sleepUnlessWoken(seenWakeSeq);
        continue;
      }

      this.#dropAborted();
      if (this.#waiters.length === 0) break;
      if (this.#wakeSeq !== seenWakeSeq) continue;

      this.#waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

      let admittedAny = false;
      const acquireWaiting = this.#waiters.some((waiter) => !waiter.aborted && waiter.priority === 0);
      for (const candidate of [...this.#waiters]) {
        if (candidate.aborted) continue;
        if (candidate.priority > 0 && acquireWaiting) break;
        if (this.#inFlight.has(candidate.vmid)) continue;
        const settleSeconds = settleRemainingForReading(reading, candidate.vmid, candidate.heavy, candidate.config.heavySettleSeconds);
        if (settleSeconds > 0) continue;

        const effectiveMarginMiB = effectiveStartMemoryMarginMiB(candidate.config.memoryMarginMiB, reading.nodeStatus.memoryTotal);
        const recentHeldBytes = heldBytesForReading(reading, candidate.vmid);
        const admission = evaluateAdmission(reading.nodeStatus.memoryAvailable, recentHeldBytes, candidate.memoryMiB, effectiveMarginMiB);
        if (!admission.ok) continue;

        if (!this.#remove(candidate)) continue;
        const permit = {} as StartPermit;
        issuedPermits.add(permit);
        const flight: InFlightStart = {
          vmid: candidate.vmid,
          memoryMiB: candidate.memoryMiB,
          heavy: candidate.heavy,
          admittedAt: candidate.now(),
        };
        this.#inFlight.set(candidate.vmid, flight);
        void this.#runAdmitted(candidate, permit, flight);
        admittedAny = true;
        break;
      }

      if (admittedAny) continue;

      for (const waiter of [...this.#waiters]) {
        if (waiter.aborted) continue;
        const waitedMs = Math.max(0, waiter.now() - waiter.enqueuedAt);
        const timedOut = waitedMs >= waiter.config.memoryWaitSeconds * 1000;
        const settleSeconds = settleRemainingForReading(reading, waiter.vmid, waiter.heavy, waiter.config.heavySettleSeconds);
        if (settleSeconds > 0) {
          if (timedOut) await this.#expire(waiter, settleTimeoutError(waiter.api.node, waiter.config.memoryWaitSeconds));
          else await this.#reportWaiting(waiter, heavyWaitWords(waiter.api.node, settleSeconds));
          continue;
        }

        const effectiveMarginMiB = effectiveStartMemoryMarginMiB(waiter.config.memoryMarginMiB, reading.nodeStatus.memoryTotal);
        const recentHeldBytes = heldBytesForReading(reading, waiter.vmid);
        const admission = evaluateAdmission(reading.nodeStatus.memoryAvailable, recentHeldBytes, waiter.memoryMiB, effectiveMarginMiB);
        if (admission.ok && !timedOut) continue;
        if (timedOut) await this.#expire(waiter, admission.ok ? queueTimeoutError(waiter.api.node, waiter.config.memoryWaitSeconds) : noCapacityError(waiter.api.node, admission, waiter.config.memoryWaitSeconds));
        else await this.#reportWaiting(waiter, memoryWaitWords(waiter.api.node, admission));
      }

      if (this.#waiters.length === 0) break;
      await this.#sleepUnlessWoken(seenWakeSeq);
    }
  }

  async #expire(waiter: StartWaiter, error: BackendError): Promise<void> {
    if (!this.#remove(waiter)) return;
    await this.#clearWaitingQuietly(waiter);
    waiter.reject(error);
  }

  async #expireUnread(error: unknown): Promise<void> {
    for (const waiter of [...this.#waiters]) {
      if (waiter.aborted) continue;
      const waitedMs = Math.max(0, waiter.now() - waiter.enqueuedAt);
      if (waitedMs >= waiter.config.memoryWaitSeconds * 1000) await this.#expire(waiter, unreadNodeError(waiter.api.node, error));
    }
  }

  async #sleepUnlessWoken(seenWakeSeq: number): Promise<void> {
    if (this.#wakeSeq !== seenWakeSeq || this.#waiters.length === 0) return;
    const sleeper = this.#waiters[0]!;
    const wake = new AbortController();
    this.#wakeController = wake;
    try {
      await sleeper.sleep(START_GATE_POLL_MS, wake.signal);
    } catch {
      undefined;
    } finally {
      if (this.#wakeController === wake) this.#wakeController = null;
    }
  }

  #dropAborted(): void {
    for (const waiter of [...this.#waiters]) {
      if (!waiter.aborted && !waiter.signal?.aborted) continue;
      waiter.aborted = true;
      if (this.#remove(waiter)) {
        void this.#clearWaitingQuietly(waiter);
        waiter.reject(waiter.signal?.reason);
      }
    }
  }
}
