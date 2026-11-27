import { PRODUCT } from "../../brand.ts";
import { BackendError, type BackendContext, type GuestOs } from "../types.ts";
import { sleep as defaultSleep, type GuestStatus, type GuestType, type Proxmox } from "./api.ts";

const MIB = 2 ** 20;
const DEFAULT_GUEST_MEMORY_MIB = 512;

export const START_MEMORY_MARGIN_DEFAULT_MIB = 16_384;
export const START_MEMORY_WAIT_DEFAULT_S = 600;
export const HEAVY_START_SETTLE_DEFAULT_S = 120;
export const START_GATE_POLL_MS = 10_000;
export const RECENT_BOOT_WINDOW_MS = 10 * 60_000;
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
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

interface RecentBoot {
  readonly vmid: number;
  readonly type: GuestType;
  readonly memoryMiB: number;
  readonly startedAt: number;
  readonly readStatus: (signal?: AbortSignal) => Promise<GuestStatus | null>;
}

interface MemoryReading {
  readonly availableBytes: number;
  readonly recentHeldBytes: number;
}

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
  readonly now: () => number;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly runStart: (permit: StartPermit) => Promise<void>;
  readonly resolve: (waitedMs: number) => void;
  readonly reject: (error: unknown) => void;
  readonly enqueuedAt: number;
  readonly detachAbort: () => void;
  memoryWaitElapsedMs: number;
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

function evaluateAdmission(reading: MemoryReading, memoryMiB: number, marginMiB: number): Admission {
  const guestBytes = memoryMiB * MIB;
  const marginBytes = marginMiB * MIB;
  const needBytes = guestBytes + marginBytes;
  const effectiveAvailableBytes = Math.max(0, reading.availableBytes - reading.recentHeldBytes);
  const shortfallBytes = Math.max(0, needBytes - effectiveAvailableBytes);
  return {
    ok: reading.availableBytes - reading.recentHeldBytes >= needBytes,
    needBytes,
    guestBytes,
    marginBytes,
    availableBytes: reading.availableBytes,
    recentHeldBytes: reading.recentHeldBytes,
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

function queueWaitWords(node: string): string {
  return `Waiting in the start queue on ${node}.`;
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

async function readRecentStatus(
  boot: RecentBoot,
  callerApi: Proxmox,
  signal?: AbortSignal,
): Promise<GuestStatus | "gone-or-stopped" | "unread"> {
  try {
    const status = await boot.readStatus(signal);
    return !status || status.status !== "running" ? "gone-or-stopped" : status;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  try {
    const status = await callerApi.guestStatus(boot.type, boot.vmid, signal);
    return !status || status.status !== "running" ? "gone-or-stopped" : status;
  } catch (error) {
    if (signal?.aborted) throw error;
    return "unread";
  }
}

export class ProxmoxStartGate {
  #nextSeq = 1;
  #pumping = false;
  #wakeController: AbortController | null = null;
  #lastHeavyStartAt: number | null = null;
  #heavySettleElapsedMs = 0;
  readonly #recentBoots = new Map<number, RecentBoot>();
  readonly #waiters: StartWaiter[] = [];

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
        now,
        sleep,
        runStart: execute,
        resolve,
        reject,
        enqueuedAt: now(),
        detachAbort,
        memoryWaitElapsedMs: 0,
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
    const heavy = request.heavy !== undefined ? (api.type === "qemu" && request.heavy) : isHeavyGuest(api.type, config, memoryMiB, request.kind, request.os);
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
    this.#wakeController?.abort();
  }

  #remove(waiter: StartWaiter): boolean {
    const index = this.#waiters.indexOf(waiter);
    if (index < 0) return false;
    this.#waiters.splice(index, 1);
    waiter.detachAbort();
    return true;
  }

  #settleRemainingFor(waiter: StartWaiter): number {
    if (!waiter.heavy || this.#lastHeavyStartAt === null) return 0;
    const settleMs = waiter.config.heavySettleSeconds * 1000;
    if (settleMs <= 0) return 0;
    const clockElapsed = Math.max(0, waiter.now() - this.#lastHeavyStartAt);
    const elapsed = Math.max(clockElapsed, this.#heavySettleElapsedMs);
    return Math.max(0, settleMs - elapsed);
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

  async #readMemory(api: Proxmox, startingVmid: number, now: number, signal?: AbortSignal): Promise<MemoryReading> {
    const node = await api.nodeStatus(signal);
    let recentHeldBytes = 0;

    for (const [vmid, boot] of [...this.#recentBoots.entries()]) {
      if (vmid === startingVmid || now - boot.startedAt >= RECENT_BOOT_WINDOW_MS) {
        this.#recentBoots.delete(vmid);
        continue;
      }

      const status = await readRecentStatus(boot, api, signal);
      if (status === "gone-or-stopped") {
        this.#recentBoots.delete(vmid);
        continue;
      }

      const usedBytes = status === "unread" ? 0 : (status.memoryUsed ?? 0);
      recentHeldBytes += Math.max(0, boot.memoryMiB * MIB - usedBytes);
    }

    return { availableBytes: node.memoryAvailable, recentHeldBytes };
  }

  async #executeStart(waiter: StartWaiter): Promise<boolean> {
    const waitedMs = Math.max(0, waiter.now() - waiter.enqueuedAt);
    const permit = {} as StartPermit;
    issuedPermits.add(permit);

    try {
      await waiter.runStart(permit);
    } catch (error) {
      waiter.reject(error);
      return false;
    } finally {
      issuedPermits.delete(permit);
    }

    this.#recordStarted(waiter);
    waiter.resolve(waitedMs);
    return true;
  }

  #recordStarted(waiter: StartWaiter): void {
    const startedAt = waiter.now();
    this.#recentBoots.set(waiter.vmid, {
      vmid: waiter.vmid,
      type: waiter.api.type,
      memoryMiB: waiter.memoryMiB,
      startedAt,
      readStatus: (signal) => waiter.api.guestStatus(waiter.api.type, waiter.vmid, signal),
    });

    if (waiter.heavy) {
      this.#lastHeavyStartAt = startedAt;
      this.#heavySettleElapsedMs = 0;
    }
  }

  async #pump(): Promise<void> {
    while (this.#waiters.length > 0) {
      this.#dropAborted();
      if (this.#waiters.length === 0) break;

      this.#waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);

      const eligible: StartWaiter[] = [];
      const settleBlocked: StartWaiter[] = [];
      for (const waiter of this.#waiters) {
        if (this.#settleRemainingFor(waiter) > 0) settleBlocked.push(waiter);
        else eligible.push(waiter);
      }

      for (const waiter of settleBlocked) {
        const remainingSeconds = Math.max(1, Math.ceil(this.#settleRemainingFor(waiter) / 1000));
        await this.#reportWaiting(waiter, heavyWaitWords(waiter.api.node, remainingSeconds));
      }

      if (eligible.length > 0) {
        const head = eligible[0]!;
        let reading: MemoryReading;
        try {
          reading = await this.#readMemory(head.api, head.vmid, head.now(), head.signal);
        } catch (error) {
          if (this.#remove(head)) {
            await this.#clearWaitingQuietly(head);
            head.reject(head.signal?.aborted ? head.signal.reason : error);
          }
          continue;
        }

        if (head.aborted) continue;

        const headAdmission = evaluateAdmission(reading, head.memoryMiB, head.config.memoryMarginMiB);
        if (headAdmission.ok) {
          if (!this.#remove(head)) continue;
          await this.#clearWaitingQuietly(head);
          await this.#executeStart(head);
          continue;
        }

        let expiredAny = false;
        for (const waiter of eligible) {
          if (waiter.aborted) continue;
          const admission = waiter === head
            ? headAdmission
            : evaluateAdmission(reading, waiter.memoryMiB, waiter.config.memoryMarginMiB);
          const maxWaitMs = waiter.config.memoryWaitSeconds * 1000;
          if (!admission.ok && waiter.memoryWaitElapsedMs >= maxWaitMs) {
            if (this.#remove(waiter)) {
              await this.#clearWaitingQuietly(waiter);
              waiter.reject(noCapacityError(waiter.api.node, admission, waiter.config.memoryWaitSeconds));
              expiredAny = true;
            }
          } else if (!admission.ok) {
            await this.#reportWaiting(waiter, memoryWaitWords(waiter.api.node, admission));
          } else {
            await this.#reportWaiting(waiter, queueWaitWords(waiter.api.node));
          }
        }
        if (expiredAny) continue;
      }

      if (this.#waiters.length === 0) break;

      const stepMs = this.#nextStepMs();
      if (!Number.isFinite(stepMs) || stepMs <= 0) continue;

      const sleeper = this.#waiters[0]!;
      const before = sleeper.now();
      const wake = new AbortController();
      this.#wakeController = wake;
      const memoryWaitersBeforeSleep = new Set(eligible);
      let wokenEarly = false;

      try {
        await sleeper.sleep(stepMs, wake.signal);
      } catch {
        wokenEarly = wake.signal.aborted;
      } finally {
        if (this.#wakeController === wake) this.#wakeController = null;
      }

      const after = sleeper.now();
      const clockDelta = Math.max(0, after - before);
      const effectiveDelta = wokenEarly ? clockDelta : Math.max(clockDelta, stepMs);
      if (this.#lastHeavyStartAt !== null) this.#heavySettleElapsedMs += effectiveDelta;
      for (const waiter of memoryWaitersBeforeSleep) {
        if (!waiter.aborted) waiter.memoryWaitElapsedMs += effectiveDelta;
      }
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

  #nextStepMs(): number {
    let stepMs = Infinity;
    for (const waiter of this.#waiters) {
      const settle = this.#settleRemainingFor(waiter);
      if (settle > 0) {
        stepMs = Math.min(stepMs, settle);
      } else {
        const maxWaitMs = waiter.config.memoryWaitSeconds * 1000;
        const remaining = Math.max(0, maxWaitMs - waiter.memoryWaitElapsedMs);
        stepMs = Math.min(stepMs, Math.min(START_GATE_POLL_MS, remaining));
      }
    }
    return stepMs;
  }
}
