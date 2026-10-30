import { randomUUID } from "node:crypto";
import { freshFetch } from "../../core/fresh-fetch.ts";

export const BOAT_API = "https://boat.dev/api/v1";
const REQUEST_TIMEOUT_MS = 60_000;
const LIST_PAGE = 200;
const POLL_MS = 500;

export interface BoatResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type BoatFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<BoatResponse>;

export interface BoatApiOptions {
  readonly key: string;
  readonly fetch?: BoatFetch;
  readonly endpoint?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export const SANDBOX_SIZES = ["small", "default", "large", "xlarge"] as const;
export type SandboxSize = (typeof SANDBOX_SIZES)[number];

export interface SizeShape {
  readonly size: SandboxSize;
  readonly cores: number;
  readonly memoryGB: number;
  readonly diskGB: number;
  readonly dollarsPerHour: number;
}

export const SIZE_SHAPES: readonly SizeShape[] = [
  { size: "small", cores: 2, memoryGB: 4, diskGB: 51, dollarsPerHour: 0.018 },
  { size: "default", cores: 4, memoryGB: 8, diskGB: 51, dollarsPerHour: 0.036 },
  { size: "large", cores: 8, memoryGB: 16, diskGB: 111, dollarsPerHour: 0.072 },
  { size: "xlarge", cores: 16, memoryGB: 32, diskGB: 251, dollarsPerHour: 0.2 },
];

export function shapeOf(size: string | null): SizeShape | null {
  return SIZE_SHAPES.find((shape) => shape.size === size) ?? null;
}

export const STARTING_STATES = ["init", "provisioning", "provisioned", "cloning"] as const;
export const RUNNING_STATES = ["ready", "idle", "running"] as const;
export const STOPPING_STATES = ["archiving"] as const;
export const STOPPED_STATES = ["archived"] as const;
export type SandboxState = (typeof STARTING_STATES)[number] | (typeof RUNNING_STATES)[number] | (typeof STOPPING_STATES)[number] | (typeof STOPPED_STATES)[number] | "error" | "cancelled";

export function isRunning(state: SandboxState): boolean {
  return (RUNNING_STATES as readonly string[]).includes(state);
}

export function isStarting(state: SandboxState): boolean {
  return (STARTING_STATES as readonly string[]).includes(state);
}

export function isStopped(state: SandboxState): boolean {
  return (STOPPED_STATES as readonly string[]).includes(state) || (STOPPING_STATES as readonly string[]).includes(state);
}

export interface Sandbox {
  readonly id: string;
  readonly name: string;
  readonly state: SandboxState;
  readonly error: string | null;
  readonly labels: Readonly<Record<string, string>>;
  readonly size: SandboxSize | null;
  readonly ip: string | null;
  readonly sshEndpoint: string | null;
  readonly createdAt: number | null;
  readonly stoppedAt: number | null;
  readonly archiveAfter: number | null;
  readonly dataExpiredAt: number | null;
  readonly hydrated: boolean;
  readonly stop: SandboxStop | null;
}

export interface SandboxStop {
  readonly status: string;
  readonly error: string | null;
}

export interface SshReach {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly hostKey: string;
}

export interface StartWindow {
  readonly window: "minute" | "hour" | "day";
  readonly limit: number;
  readonly remaining: number;
}

export interface BoatLimits {
  readonly tier: string;
  readonly activeSandboxes: number;
  readonly sizes: readonly { readonly size: SandboxSize; readonly available: boolean; readonly reason: string | null }[];
  readonly starts: readonly StartWindow[];
  readonly computeUsedSeconds: number | null;
  readonly computeCapSeconds: number | null;
  readonly includedHoursLeft: number | null;
  readonly periodEndsAt: number | null;
  readonly savedSnapshots: boolean;
}

export type BoatErrorKind = "gone" | "refused" | "unpaid" | "full" | "busy" | "unreachable" | "failed";

export class BoatError extends Error {
  readonly kind: BoatErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(kind: BoatErrorKind, status: number, code: string, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "BoatError";
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const FULL_CODES = new Set(["limit_reached", "member_limit_reached", "trial_compute_limit_reached", "rate_limited", "IP_RATE_LIMIT_EXCEEDED"]);
const BUSY_CODES = new Set(["out_of_capacity", "no_ready_machine", "sandbox_starting", "sandbox_resuming", "sandbox_stopping", "idempotency_in_progress", "ssh_host_key_unavailable"]);

function kindOf(status: number, code: string): BoatErrorKind {
  if (status === 404 || code === "not_found" || code === "snapshot_data_expired") return "gone";
  if (status === 401) return "refused";
  if (status === 402) return "unpaid";
  if (status === 403 && code !== "trial_machine_class_not_allowed" && code !== "machine_class_plan_required") return "refused";
  if (status === 429 || FULL_CODES.has(code) || code === "trial_machine_class_not_allowed" || code === "machine_class_plan_required") return "full";
  if (status === 503 || BUSY_CODES.has(code) || (status === 502 && code === "sandbox_direct_failed")) return "busy";
  return "failed";
}

const WORDS: Readonly<Record<string, string>> = {
  unauthorized: "boat refused the API key: it is wrong, has expired or was revoked. Make a new key in boat's dashboard and set it in BB Box's settings.",
  billing_required: "boat wants a payment before it starts more sandboxes. Pay in boat's dashboard, or use another backend.",
  limit_reached: "the boat plan's sandboxes at once are all in use. Release a boat box, or raise the plan.",
  trial_compute_limit_reached: "the boat trial's 25 hours of compute are used up. Make a payment to end the trial, or use another backend.",
  out_of_capacity: "boat has no machine free just now.",
  no_ready_machine: "boat has no machine of this size ready just now.",
  trial_machine_class_not_allowed: "the boat trial allows only the small and default sizes.",
  machine_class_plan_required: "this boat size needs a larger plan.",
};

export function perWindow(window: string): string {
  return window === "hour" ? "an hour" : `a ${window}`;
}

function windowWords(details: Readonly<Record<string, unknown>>): string {
  const window = typeof details.window === "string" ? details.window : null;
  const limit = typeof details.limit === "number" ? details.limit : null;
  return window && limit !== null ? `boat allows ${limit} sandbox starts ${perWindow(window)}, and they are used up.` : "boat's limit on sandbox starts is used up.";
}

function retryAfterOf(details: Readonly<Record<string, unknown>>, body: Readonly<Record<string, unknown>>): number | null {
  for (const value of [details.retryAfterSeconds, details.retryAfter, body.retryAfterSeconds, body.retryAfter]) if (typeof value === "number" && value >= 0) return value * 1000;
  return null;
}

function time(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export function sandboxFrom(raw: Readonly<Record<string, unknown>>): Sandbox {
  const labels: Record<string, string> = {};
  if (raw.labels && typeof raw.labels === "object") for (const [key, value] of Object.entries(raw.labels as Record<string, unknown>)) if (typeof value === "string") labels[key] = value;
  const size = (SANDBOX_SIZES as readonly string[]).includes(String(raw.type)) ? (raw.type as SandboxSize) : null;
  return {
    id: String(raw.id),
    name: typeof raw.name === "string" ? raw.name : "",
    state: String(raw.state ?? "error") as SandboxState,
    error: text(raw.error),
    labels,
    size,
    ip: text(raw.ip),
    sshEndpoint: text(raw.sshEndpoint),
    createdAt: time(raw.createdAt),
    stoppedAt: time(raw.stoppedAt),
    archiveAfter: time(raw.archiveAfter),
    dataExpiredAt: time(raw.dataExpiredAt),
    hydrated: raw.hydrated !== false,
    stop: stopFrom(raw.stop),
  };
}

function stopFrom(raw: unknown): SandboxStop | null {
  if (!raw || typeof raw !== "object") return null;
  const stop = raw as Record<string, unknown>;
  return typeof stop.status === "string" ? { status: stop.status, error: text(stop.error) } : null;
}

export function stillArchivingWords(id: string, stop: SandboxStop | null): string {
  if (stop?.status === "failing") return `boat's sandbox ${id} is still archiving: boat's last attempt to save its disk failed${stop.error ? `, ${stop.error}` : ""}, and boat tries again by itself.`;
  return `boat's sandbox ${id} is still archiving: boat is still saving its disk.`;
}

export function reachFrom(raw: Readonly<Record<string, unknown>>): SshReach {
  const endpoint = text(raw.sshEndpoint);
  const ip = text(raw.machineIp);
  const hostKey = text(raw.hostKey);
  if (!hostKey) throw new BoatError("busy", 503, "ssh_host_key_unavailable", "boat gave no SSH host key for the sandbox yet.");
  const user = text(raw.sshUser) ?? "user";
  if (endpoint) {
    const at = endpoint.lastIndexOf(":");
    return { host: endpoint.slice(0, at), port: Number(endpoint.slice(at + 1)), user, hostKey };
  }
  if (!ip) throw new BoatError("busy", 503, "machine_not_running", "boat gave no address for the sandbox yet.");
  return { host: ip, port: 22, user, hostKey };
}

export function limitsFrom(raw: Readonly<Record<string, unknown>>): BoatLimits {
  const record = (value: unknown): Readonly<Record<string, unknown>> => (value && typeof value === "object" ? (value as Record<string, unknown>) : {});
  const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const current = record(raw.currentLimits);
  const starts = record(raw.starts);
  const startLimits = record(raw.startLimits);
  const windows: StartWindow[] = [];
  for (const window of ["minute", "hour", "day"] as const) {
    const used = record(starts[window]);
    const limit = number(used.limit) ?? number(startLimits[`per${window[0]!.toUpperCase()}${window.slice(1)}`]);
    const remaining = number(used.remaining);
    if (limit !== null) windows.push({ window, limit, remaining: remaining ?? limit });
  }
  const sizes = Array.isArray(raw.machineTypes)
    ? (raw.machineTypes as unknown[]).flatMap((entry) => {
        const type = record(entry);
        return (SANDBOX_SIZES as readonly string[]).includes(String(type.type)) ? [{ size: type.type as SandboxSize, available: type.available === true, reason: text(type.reason) }] : [];
      })
    : [];
  const included = record(raw.planIncluded);
  const tier = text(raw.accessTier) ?? "unknown";
  return {
    tier,
    activeSandboxes: number(current.activeSandboxes) ?? number(raw.maxActiveSandboxes) ?? 0,
    sizes,
    starts: windows,
    computeUsedSeconds: number(raw.trialComputeUsedSeconds),
    computeCapSeconds: tier === "trial" ? number(raw.trialComputeCapSeconds) : null,
    includedHoursLeft: number(included.vmHoursRemaining),
    periodEndsAt: time(included.periodEnd),
    savedSnapshots: tier !== "trial",
  };
}

export interface MakeSandbox {
  readonly size: SandboxSize;
  readonly ttlSeconds: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly name: string;
  readonly idempotencyKey?: string;
}

export class BoatApi {
  readonly #options: BoatApiOptions;
  readonly #fetch: BoatFetch;
  readonly #endpoint: string;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #now: () => number;

  constructor(options: BoatApiOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? freshFetch("boat", options.log);
    this.#endpoint = options.endpoint ?? BOAT_API;
    this.#sleep = options.sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    }));
    this.#now = options.now ?? Date.now;
  }

  async #call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: BoatResponse;
    try {
      response = await this.#fetch(`${this.#endpoint}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.#options.key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: both,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new BoatError("unreachable", 0, "unreachable", `boat's API at ${this.#endpoint} did not answer: ${error instanceof Error ? error.message : String(error)}.`);
    }
    const raw = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      parsed = {};
    }
    if (response.ok && parsed.ok !== false) return parsed;
    const error = (parsed.error && typeof parsed.error === "object" ? parsed.error : {}) as Record<string, unknown>;
    const details = (error.details && typeof error.details === "object" ? error.details : {}) as Record<string, unknown>;
    const code = text(parsed.code) ?? text(error.code) ?? `http_${response.status}`;
    const said = text(parsed.message) ?? text(error.message) ?? `HTTP ${response.status}`;
    const words = code === "rate_limited" ? windowWords(details) : (WORDS[code] ?? `boat answered ${response.status} ${code}: ${said}`);
    throw new BoatError(kindOf(response.status, code), response.status, code, words, retryAfterOf(details, parsed));
  }

  async me(signal?: AbortSignal): Promise<{ readonly id: string }> {
    const answer = await this.#call("GET", "/me", undefined, {}, signal);
    const user = (answer.user ?? {}) as Record<string, unknown>;
    return { id: String(user.id ?? "") };
  }

  async limits(signal?: AbortSignal): Promise<BoatLimits> {
    return limitsFrom(await this.#call("GET", "/limits", undefined, {}, signal));
  }

  async list(labels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<Sandbox[]> {
    const found: Sandbox[] = [];
    let cursor: string | null = null;
    for (;;) {
      const query = new URLSearchParams({ limit: String(LIST_PAGE) });
      for (const [key, value] of Object.entries(labels)) query.append("label", `${key}=${value}`);
      if (cursor) query.set("cursor", cursor);
      const page = await this.#call("GET", `/sandboxes?${query.toString()}`, undefined, {}, signal);
      for (const raw of Array.isArray(page.sandboxes) ? (page.sandboxes as Record<string, unknown>[]) : []) {
        const sandbox = sandboxFrom(raw);
        if (Object.entries(labels).every(([key, value]) => sandbox.labels[key] === value)) found.push(sandbox);
      }
      const info = (page.pageInfo ?? {}) as Record<string, unknown>;
      cursor = info.hasMore === true && typeof info.nextCursor === "string" ? info.nextCursor : null;
      if (!cursor) return found;
    }
  }

  async get(id: string, signal?: AbortSignal): Promise<Sandbox | null> {
    try {
      const sandbox = sandboxFrom(((await this.#call("GET", `/sandboxes/${encodeURIComponent(id)}`, undefined, {}, signal)).sandbox ?? {}) as Record<string, unknown>);
      return sandbox.state === "cancelled" ? null : sandbox;
    } catch (error) {
      if (error instanceof BoatError && error.kind === "gone") return null;
      throw error;
    }
  }

  async create(make: MakeSandbox, signal?: AbortSignal): Promise<Sandbox> {
    const answer = await this.#call(
      "POST",
      "/sandboxes",
      { type: make.size, ttlSeconds: make.ttlSeconds, labels: make.labels, name: make.name, noEnv: true, monitoring: false },
      { "idempotency-key": make.idempotencyKey ?? randomUUID() },
      signal,
    );
    return sandboxFrom((answer.sandbox ?? {}) as Record<string, unknown>);
  }

  async fork(from: string, make: MakeSandbox, signal?: AbortSignal): Promise<Sandbox> {
    const answer = await this.#call(
      "POST",
      `/sandboxes/${encodeURIComponent(from)}/fork`,
      { type: make.size, ttlSeconds: make.ttlSeconds, labels: make.labels, noEnv: true, monitoring: false },
      { "idempotency-key": make.idempotencyKey ?? randomUUID() },
      signal,
    );
    const sandbox = sandboxFrom((answer.sandbox ?? { id: answer.id, state: answer.status }) as Record<string, unknown>);
    if (make.name && sandbox.name !== make.name) await this.rename(sandbox.id, make.name, signal).catch(() => undefined);
    return sandbox;
  }

  async rename(id: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.#call("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { name: name.slice(0, 120) }, {}, signal);
  }

  async extend(id: string, ttlSeconds: number, signal?: AbortSignal): Promise<Sandbox> {
    return sandboxFrom(((await this.#call("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { ttlSeconds }, {}, signal)).sandbox ?? {}) as Record<string, unknown>);
  }

  async stop(id: string, signal?: AbortSignal): Promise<void> {
    await this.#call("POST", `/sandboxes/${encodeURIComponent(id)}/stop`, {}, {}, signal);
  }

  async resume(id: string, options: { readonly ttlSeconds: number; readonly size?: SandboxSize }, signal?: AbortSignal): Promise<void> {
    await this.#call("POST", `/sandboxes/${encodeURIComponent(id)}/resume`, { ttlSeconds: options.ttlSeconds, ...(options.size ? { type: options.size } : {}) }, {}, signal);
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#call("DELETE", `/sandboxes/${encodeURIComponent(id)}`, undefined, { "x-ascii-confirm-delete": id }, signal);
    } catch (error) {
      if (error instanceof BoatError && error.kind === "gone") return;
      throw error;
    }
  }

  async latestSnapshotFile(id: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const latest = await this.#call("GET", `/sandboxes/${encodeURIComponent(id)}/snapshots/latest`, undefined, {}, signal);
    const snapshot = latest.snapshot && typeof latest.snapshot === "object" ? String((latest.snapshot as Record<string, unknown>).id ?? "") : "";
    if (!snapshot) return null;
    const response = await this.#fetch(`${this.#endpoint}/snapshots/${encodeURIComponent(snapshot)}/files?${new URLSearchParams({ path: path.replace(/^\/+/, "") })}`, {
      method: "GET",
      headers: { authorization: `Bearer ${this.#options.key}` },
      ...(signal ? { signal } : {}),
    });
    return response.ok ? response.text() : null;
  }

  async sshKey(id: string, publicKey: string, signal?: AbortSignal): Promise<SshReach> {
    return reachFrom(await this.#call("POST", `/sandboxes/${encodeURIComponent(id)}/sshkey`, { key: publicKey }, {}, signal));
  }

  async waitArchived(id: string, deadline: number, signal?: AbortSignal): Promise<Sandbox> {
    try {
      return await this.waitFor(id, (sandbox) => sandbox.state === "archived", deadline, signal);
    } catch (error) {
      if (!(error instanceof BoatError && error.kind === "busy")) throw error;
      const sandbox = await this.get(id, signal).catch(() => null);
      throw new BoatError("busy", 504, "timeout", stillArchivingWords(id, sandbox?.stop ?? null));
    }
  }

  async waitFor(id: string, wanted: (sandbox: Sandbox) => boolean, deadline: number, signal?: AbortSignal): Promise<Sandbox> {
    let last: Sandbox | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const sandbox = await this.get(id, signal);
      if (!sandbox) throw new BoatError("gone", 404, "not_found", `boat's sandbox ${id} is gone${last?.error ? `: ${last.error}` : "."}`);
      if (wanted(sandbox)) return sandbox;
      if (sandbox.state === "error") throw new BoatError("failed", 409, "sandbox_error", `boat's sandbox ${id} failed${sandbox.error ? `: ${sandbox.error}` : "."}`);
      last = sandbox;
      if (this.#now() >= deadline) throw new BoatError("busy", 504, "timeout", `boat's sandbox ${id} is still ${sandbox.state}.`);
      await this.#sleep(POLL_MS, signal);
    }
  }
}
