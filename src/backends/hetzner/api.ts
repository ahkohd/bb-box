import { freshFetch } from "../../core/fresh-fetch.ts";
import { sleep } from "../proxmox/api.ts";

export interface HetznerResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type HetznerFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HetznerResponse>;

export interface HetznerOptions {
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: HetznerFetch;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly actionPollMs?: number;
  readonly actionTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly triesWhenRateLimited?: number;
  readonly log?: (line: string) => void;
}

export const HETZNER_API_URL = "https://api.hetzner.cloud/v1";
const PAGE_SIZE = 50;
const ONE_REQUEST_REFILL_MS = 1_000;

export class HetznerError extends Error {
  readonly status: number;
  readonly code: string;
  readonly method: string;
  readonly path: string;
  constructor(method: string, path: string, status: number, code: string, message: string) {
    super(`Hetzner Cloud ${method} ${path} failed (${status}${code ? ` ${code}` : ""}): ${message}`);
    this.name = "HetznerError";
    this.status = status;
    this.code = code;
    this.method = method;
    this.path = path;
  }

  get taken(): boolean {
    return this.code === "uniqueness_error";
  }

  get notFound(): boolean {
    return this.status === 404 || this.code === "not_found";
  }

  get overLimit(): boolean {
    return this.code === "resource_limit_exceeded";
  }

  get unavailable(): boolean {
    return this.code === "resource_unavailable";
  }

  get rateLimited(): boolean {
    return this.status === 429 || this.code === "rate_limit_exceeded";
  }

  get unauthorised(): boolean {
    return this.status === 401 || this.code === "unauthorized";
  }

  get readOnly(): boolean {
    return this.code === "token_readonly" || this.code === "forbidden";
  }

  get unreachable(): boolean {
    return this.status === 0;
  }
}

export type Labels = Readonly<Record<string, string>>;

export type Deletion = "deleted" | "already gone";

export type ServerStatus = "initializing" | "starting" | "running" | "stopping" | "off" | "deleting" | "migrating" | "rebuilding" | "unknown";

export interface HetznerServer {
  readonly id: number;
  readonly name: string;
  readonly status: ServerStatus;
  readonly createdAtMs: number;
  readonly labels: Labels;
  readonly ipv4: string | null;
  readonly ipv6: string | null;
  readonly serverType: string;
  readonly location: string;
  readonly imageId: number | null;
}

export interface HetznerAction {
  readonly id: number;
  readonly command: string;
  readonly status: "running" | "success" | "error";
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface HetznerSshKey {
  readonly id: number;
  readonly name: string;
  readonly fingerprint: string;
  readonly labels: Labels;
}

export interface FirewallRule {
  readonly direction: "in" | "out";
  readonly protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  readonly port?: string;
  readonly sourceIps?: readonly string[];
  readonly destinationIps?: readonly string[];
  readonly description?: string;
}

export interface HetznerFirewall {
  readonly id: number;
  readonly name: string;
  readonly labels: Labels;
}

export interface HetznerImage {
  readonly id: number;
  readonly description: string;
  readonly status: "available" | "creating" | "unavailable" | string;
  readonly createdAtMs: number;
  readonly labels: Labels;
  readonly compressedSizeGB: number | null;
}

export interface ServerType {
  readonly name: string;
  readonly cores: number;
  readonly memoryGB: number;
  readonly diskGB: number;
  readonly architecture: "x86" | "arm" | string;
  readonly soldIn: readonly string[];
  readonly deprecated: boolean;
}

export interface EurosBeforeVat {
  readonly hourly: number;
  readonly monthly: number;
}

export interface NewServer {
  readonly name: string;
  readonly serverType: string;
  readonly location: string;
  readonly imageNameOrSnapshotId: string | number;
  readonly labels: Labels;
  readonly sshKeys?: readonly number[];
  readonly firewalls?: readonly number[];
  readonly userData?: string;
  readonly ipv4?: boolean;
  readonly ipv6?: boolean;
}

type Json = Record<string, unknown>;

export function selectorMatchingAll(labels: Labels): string {
  return Object.entries(labels).map(([key, value]) => `${key}=${value}`).join(",");
}

export class Hetzner {
  readonly #base: string;
  readonly #auth: string;
  readonly #token: string;
  readonly #fetch: HetznerFetch;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #actionPollMs: number;
  readonly #actionTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #triesWhenRateLimited: number;
  #remaining: number | null = null;

  constructor(options: HetznerOptions) {
    this.#base = (options.apiUrl ?? HETZNER_API_URL).replace(/\/+$/, "");
    this.#token = options.token;
    this.#auth = `Bearer ${options.token}`;
    this.#fetch = options.fetch ?? freshFetch("Hetzner Cloud", options.log);
    this.#sleep = options.sleep ?? sleep;
    this.#actionPollMs = Math.max(ONE_REQUEST_REFILL_MS, options.actionPollMs ?? ONE_REQUEST_REFILL_MS);
    this.#actionTimeoutMs = options.actionTimeoutMs ?? 600_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#triesWhenRateLimited = options.triesWhenRateLimited ?? 10;
  }

  get requestsLeftThisHour(): number | null {
    return this.#remaining;
  }

  async servers(labels: Labels, signal?: AbortSignal): Promise<HetznerServer[]> {
    return (await this.#list("/servers", "servers", { label_selector: selectorMatchingAll(labels) }, signal)).map(server);
  }

  async serverNamed(name: string, signal?: AbortSignal): Promise<HetznerServer | null> {
    const found = await this.#list("/servers", "servers", { name }, signal);
    return found.length ? server(found[0]!) : null;
  }

  async server(id: number, signal?: AbortSignal): Promise<HetznerServer | null> {
    const data = await this.#orNullWhenGone<Json>("GET", `/servers/${id}`, undefined, signal);
    return data ? server(data.server as Json) : null;
  }

  async createServer(input: NewServer, signal?: AbortSignal): Promise<{ server: HetznerServer; startActions: number[] }> {
    const body: Json = {
      name: input.name,
      server_type: input.serverType,
      location: input.location,
      image: String(input.imageNameOrSnapshotId),
      labels: input.labels,
      start_after_create: true,
      public_net: { enable_ipv4: input.ipv4 ?? true, enable_ipv6: input.ipv6 ?? true },
    };
    if (input.sshKeys?.length) body.ssh_keys = input.sshKeys.map(String);
    if (input.firewalls?.length) body.firewalls = input.firewalls.map((firewall) => ({ firewall }));
    if (input.userData !== undefined) body.user_data = input.userData;
    const data = await this.#request<Json>("POST", "/servers", body, signal);
    const startActions = [data.action, ...((data.next_actions as unknown[]) ?? [])].filter(Boolean).map((each) => Number((each as Json).id));
    return { server: server(data.server as Json), startActions };
  }

  async deleteServer(id: number, signal?: AbortSignal): Promise<Deletion> {
    const data = await this.#orNullWhenGone<Json>("DELETE", `/servers/${id}`, undefined, signal);
    if (!data) return "already gone";
    if (data.action) await this.waitAction(Number((data.action as Json).id), signal);
    return "deleted";
  }

  async shutDown(id: number, signal?: AbortSignal): Promise<void> {
    const data = await this.#request<Json>("POST", `/servers/${id}/actions/shutdown`, {}, signal);
    await this.waitAction(Number((data.action as Json).id), signal);
  }

  async powerOff(id: number, signal?: AbortSignal): Promise<void> {
    const data = await this.#request<Json>("POST", `/servers/${id}/actions/poweroff`, {}, signal);
    await this.waitAction(Number((data.action as Json).id), signal);
  }

  async setServerLabels(id: number, labels: Labels, signal?: AbortSignal): Promise<void> {
    await this.#request("PUT", `/servers/${id}`, { labels }, signal);
  }

  async action(id: number, signal?: AbortSignal): Promise<HetznerAction> {
    const data = await this.#request<Json>("GET", `/actions/${id}`, undefined, signal);
    return action(data.action as Json);
  }

  async waitAction(id: number, signal?: AbortSignal, timeoutMs = this.#actionTimeoutMs, pollMs = this.#actionPollMs): Promise<HetznerAction> {
    const every = Math.max(this.#actionPollMs, pollMs);
    for (let waited = 0; ; waited += every) {
      const each = await this.action(id, signal);
      if (each.status === "success") return each;
      if (each.status === "error") {
        throw new HetznerError("GET", `/actions/${id}`, 200, each.error?.code ?? "action_failed", `${each.command} failed: ${this.#redact(each.error?.message ?? "no reason given")}`);
      }
      if (waited >= timeoutMs) throw new HetznerError("GET", `/actions/${id}`, 0, "timeout", `${each.command} did not finish in ${Math.round(timeoutMs / 1000)} s`);
      await this.#sleep(every, signal);
    }
  }

  async waitUntilRunning(id: number, signal?: AbortSignal): Promise<HetznerServer> {
    for (let waited = 0; ; waited += this.#actionPollMs) {
      const found = await this.server(id, signal);
      if (!found) throw new HetznerError("GET", `/servers/${id}`, 404, "not_found", "the server went before it ran");
      if (found.status === "running") return found;
      if (waited >= this.#actionTimeoutMs) throw new HetznerError("GET", `/servers/${id}`, 0, "timeout", `${found.name} was not running after ${Math.round(this.#actionTimeoutMs / 1000)} s`);
      await this.#sleep(this.#actionPollMs, signal);
    }
  }

  async sshKeys(labels: Labels, signal?: AbortSignal): Promise<HetznerSshKey[]> {
    return (await this.#list("/ssh_keys", "ssh_keys", { label_selector: selectorMatchingAll(labels) }, signal)).map(sshKey);
  }

  async createSshKey(input: { name: string; publicKey: string; labels: Labels }, signal?: AbortSignal): Promise<HetznerSshKey> {
    const data = await this.#request<Json>("POST", "/ssh_keys", { name: input.name, public_key: input.publicKey, labels: input.labels }, signal);
    return sshKey(data.ssh_key as Json);
  }

  async deleteSshKey(id: number, signal?: AbortSignal): Promise<Deletion> {
    return (await this.#orNullWhenGone("DELETE", `/ssh_keys/${id}`, undefined, signal)) === null ? "already gone" : "deleted";
  }

  async firewalls(labels: Labels, signal?: AbortSignal): Promise<HetznerFirewall[]> {
    return (await this.#list("/firewalls", "firewalls", { label_selector: selectorMatchingAll(labels) }, signal)).map(firewall);
  }

  async createFirewall(input: { name: string; labels: Labels; rules: readonly FirewallRule[] }, signal?: AbortSignal): Promise<HetznerFirewall> {
    const data = await this.#request<Json>("POST", "/firewalls", { name: input.name, labels: input.labels, rules: input.rules.map(ruleJson) }, signal);
    return firewall(data.firewall as Json);
  }

  async setFirewallRules(id: number, rules: readonly FirewallRule[], signal?: AbortSignal): Promise<void> {
    const data = await this.#request<Json>("POST", `/firewalls/${id}/actions/set_rules`, { rules: rules.map(ruleJson) }, signal);
    for (const each of (data.actions as Json[] | undefined) ?? []) await this.waitAction(Number(each.id), signal);
  }

  async deleteFirewall(id: number, signal?: AbortSignal): Promise<Deletion> {
    return (await this.#orNullWhenGone("DELETE", `/firewalls/${id}`, undefined, signal)) === null ? "already gone" : "deleted";
  }

  async snapshots(labels: Labels, signal?: AbortSignal): Promise<HetznerImage[]> {
    return (await this.#list("/images", "images", { type: "snapshot", label_selector: selectorMatchingAll(labels) }, signal)).map(image);
  }

  async startSnapshot(serverId: number, input: { description: string; labels: Labels }, signal?: AbortSignal): Promise<{ imageId: number; actionId: number }> {
    const data = await this.#request<Json>("POST", `/servers/${serverId}/actions/create_image`, { type: "snapshot", description: input.description, labels: input.labels }, signal);
    return { imageId: Number((data.image as Json).id), actionId: Number((data.action as Json).id) };
  }

  async image(id: number, signal?: AbortSignal): Promise<HetznerImage | null> {
    const found = await this.#orNullWhenGone("GET", `/images/${id}`, undefined, signal);
    return found === null ? null : image((found as Json).image as Json);
  }

  async createSnapshot(serverId: number, input: { description: string; labels: Labels }, signal?: AbortSignal, timeoutMs?: number): Promise<HetznerImage> {
    const started = await this.startSnapshot(serverId, input, signal);
    await this.waitAction(started.actionId, signal, timeoutMs);
    const made = await this.image(started.imageId, signal);
    if (!made) throw new HetznerError("GET", `/images/${started.imageId}`, 404, "not_found", "the snapshot went as it was made");
    return made;
  }

  async deleteImage(id: number, signal?: AbortSignal): Promise<Deletion> {
    return (await this.#orNullWhenGone("DELETE", `/images/${id}`, undefined, signal)) === null ? "already gone" : "deleted";
  }

  async serverType(name: string, signal?: AbortSignal): Promise<ServerType | null> {
    const found = await this.#list("/server_types", "server_types", { name }, signal);
    return found.length ? serverType(found[0]!) : null;
  }

  async pricesBeforeVat(type: string, location: string, signal?: AbortSignal): Promise<{ server: EurosBeforeVat; ipv4: EurosBeforeVat } | null> {
    const data = await this.#request<Json>("GET", "/pricing", undefined, signal);
    const pricing = (data.pricing ?? {}) as Json;
    const at = (entries: unknown) => ((entries as Json[] | undefined) ?? []).find((each) => each.location === location);
    const serverPrice = at(((pricing.server_types as Json[] | undefined) ?? []).find((each) => each.name === type)?.prices);
    if (!serverPrice) return null;
    const ipv4Price = at(((pricing.primary_ips as Json[] | undefined) ?? []).find((each) => each.type === "ipv4")?.prices);
    return { server: eurosBeforeVat(serverPrice), ipv4: ipv4Price ? eurosBeforeVat(ipv4Price) : { hourly: 0, monthly: 0 } };
  }

  async #list(path: string, key: string, query: Record<string, string>, signal?: AbortSignal): Promise<Json[]> {
    const all: Json[] = [];
    for (let page: number | null = 1; page !== null; ) {
      const data: Json = await this.#request<Json>("GET", path, undefined, signal, { ...query, page: String(page), per_page: String(PAGE_SIZE) });
      all.push(...((data[key] as Json[] | undefined) ?? []));
      const next = ((data.meta as Json | undefined)?.pagination as Json | undefined)?.next_page;
      page = typeof next === "number" && next > page ? next : null;
    }
    return all;
  }

  async #orNullWhenGone<T>(method: string, path: string, body: Json | undefined, signal?: AbortSignal): Promise<T | null> {
    try {
      return (await this.#request<T>(method, path, body, signal)) ?? ({} as T);
    } catch (error) {
      if (error instanceof HetznerError && error.notFound) return null;
      throw error;
    }
  }

  async #request<T>(method: string, path: string, body: Json | undefined, signal?: AbortSignal, query?: Record<string, string>): Promise<T> {
    const search = query ? new URLSearchParams(Object.entries(query).filter(([, value]) => value !== "")).toString() : "";
    const url = `${this.#base}${path}${search ? `?${search}` : ""}`;
    const headers: Record<string, string> = { Authorization: this.#auth, Accept: "application/json" };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    for (let tries = 1; ; tries++) {
      if (tries === 1 && this.#remaining !== null && this.#remaining < 1) await this.#sleep(ONE_REQUEST_REFILL_MS, signal);
      const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: HetznerResponse;
      try {
        response = await this.#fetch(url, { method, headers, body: payload, signal: combined });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        const reason = timeout.aborted ? "timed out" : this.#redact(fetchFailure(error));
        throw new HetznerError(method, path, 0, "", `cannot reach the Hetzner Cloud API: ${reason}`);
      }
      const remaining = Number(response.headers.get("RateLimit-Remaining") ?? NaN);
      this.#remaining = Number.isFinite(remaining) ? remaining : this.#remaining;
      const text = await response.text();
      let parsed: Json | undefined;
      try {
        parsed = text ? (JSON.parse(text) as Json) : undefined;
      } catch {
        parsed = undefined;
      }
      if (response.ok) return parsed as T;
      const failure = (parsed?.error ?? {}) as Json;
      const code = typeof failure.code === "string" ? failure.code : "";
      const message = this.#redact(typeof failure.message === "string" && failure.message.trim() ? failure.message.trim() : response.statusText || "request failed").slice(0, 500);
      const error = new HetznerError(method, path, response.status, code, message);
      if (error.rateLimited && tries < this.#triesWhenRateLimited) {
        await this.#sleep(retryAfterMs(response) ?? ONE_REQUEST_REFILL_MS * tries, signal);
        continue;
      }
      throw error;
    }
  }

  #redact(text: string): string {
    return this.#token ? text.split(this.#token).join("[token]") : text;
  }
}

function retryAfterMs(response: HetznerResponse): number | null {
  const seconds = Number(response.headers.get("Retry-After") ?? NaN);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : null;
}

function fetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && error.message === "fetch failed" ? cause : [error.message, cause].filter(Boolean).join(": ");
}

function labelsOf(value: unknown): Labels {
  return value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Json).map(([key, each]) => [key, String(each)])) : {};
}

function time(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function server(data: Json): HetznerServer {
  const net = (data.public_net ?? {}) as Json;
  const ipv4 = (net.ipv4 as Json | null | undefined)?.ip;
  const ipv6 = (net.ipv6 as Json | null | undefined)?.ip;
  const type = (data.server_type ?? {}) as Json;
  const location = (((data.datacenter ?? {}) as Json).location ?? data.location ?? {}) as Json;
  const imageId = (data.image as Json | null | undefined)?.id;
  return {
    id: Number(data.id),
    name: String(data.name ?? ""),
    status: String(data.status ?? "unknown") as ServerStatus,
    createdAtMs: time(data.created),
    labels: labelsOf(data.labels),
    ipv4: typeof ipv4 === "string" ? ipv4 : null,
    ipv6: typeof ipv6 === "string" ? ipv6 : null,
    serverType: String(type.name ?? ""),
    location: String(location.name ?? ""),
    imageId: typeof imageId === "number" ? imageId : null,
  };
}

function action(data: Json): HetznerAction {
  const error = data.error as Json | null | undefined;
  return {
    id: Number(data.id),
    command: String(data.command ?? "action"),
    status: String(data.status ?? "running") as HetznerAction["status"],
    error: error ? { code: String(error.code ?? ""), message: String(error.message ?? "") } : null,
  };
}

function sshKey(data: Json): HetznerSshKey {
  return { id: Number(data.id), name: String(data.name ?? ""), fingerprint: String(data.fingerprint ?? ""), labels: labelsOf(data.labels) };
}

function ruleJson(rule: FirewallRule): Json {
  return {
    direction: rule.direction,
    protocol: rule.protocol,
    ...(rule.port !== undefined ? { port: rule.port } : {}),
    ...(rule.sourceIps ? { source_ips: rule.sourceIps } : {}),
    ...(rule.destinationIps ? { destination_ips: rule.destinationIps } : {}),
    ...(rule.description ? { description: rule.description } : {}),
  };
}

function firewall(data: Json): HetznerFirewall {
  return { id: Number(data.id), name: String(data.name ?? ""), labels: labelsOf(data.labels) };
}

function image(data: Json): HetznerImage {
  const size = Number(data.image_size);
  return {
    id: Number(data.id),
    description: String(data.description ?? ""),
    status: String(data.status ?? ""),
    createdAtMs: time(data.created),
    labels: labelsOf(data.labels),
    compressedSizeGB: data.image_size === null || data.image_size === undefined || !Number.isFinite(size) ? null : size,
  };
}

function serverType(data: Json): ServerType {
  return {
    name: String(data.name ?? ""),
    cores: Number(data.cores ?? 0),
    memoryGB: Number(data.memory ?? 0),
    diskGB: Number(data.disk ?? 0),
    architecture: String(data.architecture ?? ""),
    soldIn: ((data.prices as Json[] | undefined) ?? []).map((each) => String(each.location)),
    deprecated: Boolean(data.deprecation),
  };
}

function eurosBeforeVat(data: Json): EurosBeforeVat {
  const net = (value: unknown) => Number(((value ?? {}) as Json).net ?? 0);
  return { hourly: net(data.price_hourly), monthly: net(data.price_monthly) };
}
