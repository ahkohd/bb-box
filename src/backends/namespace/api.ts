import { freshFetch } from "../../core/fresh-fetch.ts";

export const COMPUTE_SERVICE = "namespace.cloud.compute.v1beta.ComputeService";
export const USAGE_SERVICE = "namespace.cloud.compute.v1beta.UsageService";
const MAC_PLATFORM = "macos/arm64";
const REQUEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 10 * 60_000;
const LIST_PAGE = 100;

export interface NamespaceResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type NamespaceFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<NamespaceResponse>;

export interface NamespaceApiOptions {
  readonly token: string;
  readonly region?: string;
  readonly fetch?: NamespaceFetch;
  readonly endpoint?: string;
  readonly log?: (line: string) => void;
}

export interface InstanceShape {
  readonly os: "macos" | "linux";
  readonly arch: "arm64" | "amd64";
  readonly cores: number;
  readonly memoryMiB: number;
  readonly selectors?: Readonly<Record<string, string>>;
}

export type InstanceStatus = "pending" | "creating" | "running" | "destroying" | "destroyed" | "suspending" | "suspended" | "error" | "unknown";

export interface Instance {
  readonly id: string;
  readonly status: InstanceStatus;
  readonly labels: Readonly<Record<string, string>>;
  readonly createdAt: number | null;
  readonly readyAt: number | null;
  readonly deadline: number | null;
  readonly continent: string | null;
  readonly shape: InstanceShape | null;
}

export interface CreateInstance {
  readonly shape: InstanceShape;
  readonly labels: Readonly<Record<string, string>>;
  readonly deadline: number;
  readonly purpose: string;
  readonly uniqueTag: string;
  readonly sshPublicKeys: readonly string[];
}

export interface PlatformConcurrency {
  readonly maxCores: number;
  readonly maxMemoryMiB: number;
  readonly usedCores: number;
  readonly usedMemoryMiB: number;
}

export interface VncSignIn {
  readonly user: string;
  readonly password: string;
}

export type NamespaceErrorKind = "gone" | "refused" | "full" | "unreachable" | "failed";

export class NamespaceError extends Error {
  readonly kind: NamespaceErrorKind;

  constructor(kind: NamespaceErrorKind, message: string) {
    super(message);
    this.name = "NamespaceError";
    this.kind = kind;
  }
}

const STATUSES: Readonly<Record<string, InstanceStatus>> = {
  PENDING: "pending",
  CREATING: "creating",
  RUNNING: "running",
  DESTROYING: "destroying",
  DESTROYED: "destroyed",
  SUSPENDING: "suspending",
  SUSPENDED: "suspended",
  ERROR: "error",
};

const KINDS_BY_CODE: Readonly<Record<string, NamespaceErrorKind>> = {
  not_found: "gone",
  unauthenticated: "refused",
  permission_denied: "refused",
  resource_exhausted: "full",
  failed_precondition: "full",
  unavailable: "unreachable",
  deadline_exceeded: "unreachable",
};

export class NamespaceApi {
  readonly region: string;
  readonly #token: string;
  readonly #fetch: NamespaceFetch;
  readonly #endpoint: string;

  constructor(options: NamespaceApiOptions) {
    if (!options.token) throw new NamespaceError("refused", "Namespace has no API token: set it in BB Box's settings.");
    this.#token = options.token;
    this.region = options.region ?? "us";
    this.#fetch = options.fetch ?? freshFetch("Namespace", options.log);
    this.#endpoint = (options.endpoint ?? `https://${this.region}.compute.namespaceapis.com`).replace(/\/+$/, "");
  }

  get sshGateway(): string {
    return `ssh.${this.region}.namespace.so`;
  }

  async create(request: CreateInstance, signal?: AbortSignal): Promise<Instance> {
    const body = {
      shape: shapeBody(request.shape),
      documentedPurpose: request.purpose,
      labels: labelsBody(request.labels),
      deadline: new Date(request.deadline).toISOString(),
      experimental: { uniqueTag: request.uniqueTag, authorizedSshKeys: [...request.sshPublicKeys] },
    };
    const answer = (await this.#call("CreateInstance", body, "make an instance", signal)) as { metadata?: unknown };
    return instanceFrom(answer.metadata);
  }

  async describe(id: string, signal?: AbortSignal): Promise<Instance> {
    const answer = (await this.#call("DescribeInstance", { instanceId: id }, `read instance ${id}`, signal)) as { metadata?: unknown };
    return instanceFrom(answer.metadata);
  }

  async wait(id: string, signal?: AbortSignal): Promise<Instance> {
    const answer = (await this.#call("WaitInstanceSync", { instanceId: id }, `wait for instance ${id}`, signal, WAIT_TIMEOUT_MS)) as { metadata?: unknown };
    return instanceFrom(answer.metadata);
  }

  async list(labels: Readonly<Record<string, string | null>>, signal?: AbortSignal): Promise<Instance[]> {
    const found: Instance[] = [];
    let cursor: string | undefined;
    do {
      const body = { maxEntries: LIST_PAGE, labelFilter: Object.entries(labels).map(([name, value]) => (value === null ? { name, op: "EXIST" } : { name, value, op: "EQUAL" })), ...(cursor ? { paginationCursor: cursor } : {}) };
      const answer = (await this.#call("ListInstances", body, "list instances", signal)) as { instances?: unknown; paginationCursor?: unknown };
      for (const raw of Array.isArray(answer.instances) ? answer.instances : []) found.push(instanceFrom(raw));
      cursor = typeof answer.paginationCursor === "string" && answer.paginationCursor ? answer.paginationCursor : undefined;
    } while (cursor);
    return found;
  }

  async extend(id: string, aheadMs: number, signal?: AbortSignal): Promise<number | null> {
    const ensureMinimum = `${Math.max(1, Math.round(aheadMs / 1000))}s`;
    const answer = (await this.#call("ExtendInstance", { instanceId: id, ensureMinimum }, `extend instance ${id}`, signal)) as { newDeadline?: unknown };
    return timestamp(answer.newDeadline);
  }

  async destroy(id: string, reason: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#call("DestroyInstance", { instanceId: id, reason }, `destroy instance ${id}`, signal);
    } catch (error) {
      if (error instanceof NamespaceError && error.kind === "gone") return;
      throw error;
    }
  }

  async vncSignIn(id: string, signal?: AbortSignal): Promise<VncSignIn> {
    const answer = (await this.#call("GetVNCConfig", { instanceId: id }, `read instance ${id}'s desktop sign-in`, signal)) as { username?: unknown; password?: unknown };
    if (typeof answer.username !== "string" || typeof answer.password !== "string") throw new NamespaceError("failed", `Namespace gave no desktop sign-in for instance ${id}.`);
    return { user: answer.username, password: answer.password };
  }

  async macConcurrency(signal?: AbortSignal): Promise<PlatformConcurrency | null> {
    const answer = (await this.#call("GetConcurrency", {}, "read the workspace's limits", signal, REQUEST_TIMEOUT_MS, USAGE_SERVICE)) as { concurrency?: unknown };
    const platforms = (Array.isArray(answer.concurrency) ? answer.concurrency : []) as { platforms?: unknown; limits?: Record<string, unknown>; activeConcurrency?: Record<string, unknown> }[];
    const mac = platforms.find((platform) => Array.isArray(platform.platforms) && platform.platforms.includes(MAC_PLATFORM));
    if (!mac?.limits) return null;
    const count = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    return {
      maxCores: count(mac.limits.maxCpu),
      maxMemoryMiB: count(mac.limits.maxMemoryMb),
      usedCores: count(mac.activeConcurrency?.cpu),
      usedMemoryMiB: count(mac.activeConcurrency?.memoryMb),
    };
  }

  async #call(method: string, body: unknown, doing: string, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS, service = COMPUTE_SERVICE): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: NamespaceResponse;
    try {
      response = await this.#fetch(`${this.#endpoint}/${service}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1", Authorization: `Bearer ${this.#token}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      const reason = timeout.aborted ? `it did not answer within ${Math.round(timeoutMs / 1000)} s` : this.#redact(error instanceof Error ? error.message : String(error));
      throw new NamespaceError("unreachable", `Could not reach Namespace to ${doing}: ${reason}.`);
    }
    const text = await response.text();
    if (response.ok) return text ? parseJson(text) : {};
    const failure = parseJson(text) as { code?: unknown; message?: unknown };
    const code = typeof failure.code === "string" ? failure.code : "";
    const kind = KINDS_BY_CODE[code] ?? (response.status === 404 ? "gone" : response.status === 401 || response.status === 403 ? "refused" : "failed");
    const said = this.#redact(typeof failure.message === "string" && failure.message ? failure.message : `HTTP ${response.status}`);
    throw new NamespaceError(kind, `Namespace did not ${doing}: ${said}.${hint(kind)}`);
  }

  #redact(text: string): string {
    return text.split(this.#token).join("<redacted>").replace(/nsct_[A-Za-z0-9._-]+/g, "<redacted>").slice(0, 300);
  }
}

function hint(kind: NamespaceErrorKind): string {
  if (kind === "refused") return " Check the Namespace token in BB Box's settings: that it has not expired, and that it may manage instances.";
  if (kind === "full") return " The workspace may be at its plan's limit of machines at once, or have none of this shape free.";
  return "";
}

function shapeBody(shape: InstanceShape): Record<string, unknown> {
  return {
    os: shape.os,
    machineArch: shape.arch,
    virtualCpu: shape.cores,
    memoryMegabytes: shape.memoryMiB,
    selectors: Object.entries(shape.selectors ?? {}).map(([name, value]) => ({ name, value })),
  };
}

function labelsBody(labels: Readonly<Record<string, string>>): { name: string; value: string }[] {
  return Object.entries(labels).map(([name, value]) => ({ name, value }));
}

function instanceFrom(raw: unknown): Instance {
  const metadata = (raw ?? {}) as Record<string, unknown>;
  if (typeof metadata.instanceId !== "string" || !metadata.instanceId) throw new NamespaceError("failed", "Namespace answered with no instance.");
  const labels: Record<string, string> = {};
  for (const label of Array.isArray(metadata.labels) ? metadata.labels : []) {
    const { name, value } = label as { name?: unknown; value?: unknown };
    if (typeof name === "string") labels[name] = typeof value === "string" ? value : "";
  }
  const deployment = (metadata.hwDeployment ?? {}) as { geoContinent?: unknown };
  return {
    id: metadata.instanceId,
    status: STATUSES[String(metadata.status ?? "")] ?? "unknown",
    labels,
    createdAt: timestamp(metadata.createdAt),
    readyAt: timestamp(metadata.readyAt),
    deadline: timestamp(metadata.deadline),
    continent: typeof deployment.geoContinent === "string" && deployment.geoContinent ? deployment.geoContinent : null,
    shape: shapeFrom(metadata.shape),
  };
}

function shapeFrom(raw: unknown): InstanceShape | null {
  if (!raw || typeof raw !== "object") return null;
  const shape = raw as { os?: unknown; machineArch?: unknown; virtualCpu?: unknown; memoryMegabytes?: unknown };
  if ((shape.os !== "macos" && shape.os !== "linux") || (shape.machineArch !== "arm64" && shape.machineArch !== "amd64")) return null;
  return { os: shape.os, arch: shape.machineArch, cores: Number(shape.virtualCpu) || 0, memoryMiB: Number(shape.memoryMegabytes) || 0 };
}

function timestamp(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}
