import { quote } from "../transports/process.ts";
import { freshFetch } from "./fresh-fetch.ts";
import { DEFAULT_TAILNET_TAGS } from "./tailnet-settings.ts";

export const TAILSCALE_API = "https://api.tailscale.com";
export { DEFAULT_TAILNET_TAGS };
export const KEY_LIFETIME_SECONDS = 600;
const TOKEN_EARLY_RENEWAL_MS = 60_000;
const ATTEMPT_TIMEOUT_MS = 15_000;
const DESCRIPTION_LIMIT = 50;
export const HOSTNAME_LIMIT = 63;

export interface TailnetResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

export type TailnetFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<TailnetResponse>;

export interface TailnetCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface TailnetOptions {
  readonly credentials: TailnetCredentials;
  readonly tags?: readonly string[];
  readonly fetch?: TailnetFetch;
  readonly now?: () => number;
  readonly apiUrl?: string;
  readonly attemptTimeoutMs?: number;
  readonly log?: (line: string) => void;
}

export interface MintedKey {
  readonly id: string;
  readonly key: string;
  readonly expiresAt: number;
}

export interface TailnetDevice {
  readonly id: string;
  readonly hostname: string;
  readonly tags: readonly string[];
  readonly lastSeen: number | null;
  readonly addresses: readonly string[];
}

export type TailnetCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export class TailnetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TailnetError";
  }
}

export class Tailnet {
  readonly tags: readonly string[];
  readonly #credentials: TailnetCredentials;
  readonly #fetch: TailnetFetch;
  readonly #now: () => number;
  readonly #apiUrl: string;
  readonly #attemptTimeoutMs: number;
  #token: { value: string; expiresAt: number } | null = null;
  #pendingToken: Promise<string> | null = null;

  constructor(options: TailnetOptions) {
    this.#credentials = options.credentials;
    this.tags = [...(options.tags?.length ? options.tags : DEFAULT_TAILNET_TAGS)];
    this.#fetch = options.fetch ?? freshFetch("Tailscale", options.log);
    this.#now = options.now ?? Date.now;
    this.#apiUrl = (options.apiUrl ?? TAILSCALE_API).replace(/\/+$/, "");
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
  }

  async mintKey(request: { readonly description: string; readonly expirySeconds?: number }, signal?: AbortSignal): Promise<MintedKey> {
    const body = {
      capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: this.tags } } },
      expirySeconds: request.expirySeconds ?? KEY_LIFETIME_SECONDS,
      description: keyDescription(request.description),
    };
    const answer = await this.#call("POST", "/api/v2/tailnet/-/keys", "make a key for the tailnet", JSON.stringify(body), signal);
    const parsed = answer as { id?: unknown; key?: unknown; expires?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.key !== "string") throw new TailnetError("Tailscale made a key but did not return it.");
    const expiresAt = typeof parsed.expires === "string" ? Date.parse(parsed.expires) : NaN;
    return { id: parsed.id, key: parsed.key, expiresAt: Number.isFinite(expiresAt) ? expiresAt : this.#now() + body.expirySeconds * 1000 };
  }

  async devices(signal?: AbortSignal): Promise<TailnetDevice[]> {
    const answer = (await this.#call("GET", "/api/v2/tailnet/-/devices", "list the tailnet's devices", undefined, signal)) as { devices?: unknown };
    const listed = Array.isArray(answer.devices) ? answer.devices : [];
    return listed.flatMap((raw): TailnetDevice[] => {
      const device = raw as { id?: unknown; nodeId?: unknown; hostname?: unknown; name?: unknown; tags?: unknown; lastSeen?: unknown; addresses?: unknown };
      const id = typeof device.nodeId === "string" ? device.nodeId : typeof device.id === "string" ? device.id : null;
      const tags = Array.isArray(device.tags) ? device.tags.filter((tag): tag is string => typeof tag === "string") : [];
      if (!id || !tags.some((tag) => this.tags.includes(tag))) return [];
      const hostname = typeof device.hostname === "string" ? device.hostname : typeof device.name === "string" ? device.name.split(".")[0]! : "";
      const lastSeen = typeof device.lastSeen === "string" ? Date.parse(device.lastSeen) : NaN;
      const addresses = Array.isArray(device.addresses) ? device.addresses.filter((address): address is string => typeof address === "string") : [];
      return [{ id, hostname, tags, lastSeen: Number.isFinite(lastSeen) ? lastSeen : null, addresses }];
    });
  }

  async removeDevice(id: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#call("DELETE", `/api/v2/device/${encodeURIComponent(id)}`, `remove device ${id} from the tailnet`, undefined, signal);
    } catch (error) {
      if (error instanceof DeviceGone) return;
      throw error;
    }
  }

  async check(signal?: AbortSignal): Promise<TailnetCheck> {
    try {
      await this.#accessToken(signal, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #accessToken(signal?: AbortSignal, fresh = false): Promise<string> {
    if (!fresh && this.#token && this.#token.expiresAt - TOKEN_EARLY_RENEWAL_MS > this.#now()) return this.#token.value;
    if (!fresh && this.#pendingToken) return this.#pendingToken;
    const pending = this.#requestToken(signal);
    if (!fresh) this.#pendingToken = pending;
    try {
      return await pending;
    } finally {
      if (this.#pendingToken === pending) this.#pendingToken = null;
    }
  }

  async #requestToken(signal?: AbortSignal): Promise<string> {
    const form = new URLSearchParams({ client_id: this.#credentials.clientId, client_secret: this.#credentials.clientSecret, grant_type: "client_credentials" });
    const response = await this.#send(`${this.#apiUrl}/api/v2/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form.toString(),
    }, "sign in to Tailscale with the OAuth client", signal);
    const text = await response.text();
    if (!response.ok) throw new TailnetError(`Tailscale refused the OAuth client (HTTP ${response.status}): ${this.#reason(text)}. Check its ID and secret, and that it has the auth_keys scope.`);
    const parsed = parseJson(text) as { access_token?: unknown; expires_in?: unknown };
    if (typeof parsed.access_token !== "string") throw new TailnetError("Tailscale signed in the OAuth client but gave no token.");
    const lifetime = typeof parsed.expires_in === "number" && parsed.expires_in > 0 ? parsed.expires_in * 1000 : 3_600_000;
    this.#token = { value: parsed.access_token, expiresAt: this.#now() + lifetime };
    return parsed.access_token;
  }

  async #call(method: string, path: string, doing: string, body: string | undefined, signal?: AbortSignal): Promise<unknown> {
    const token = await this.#accessToken(signal);
    const response = await this.#send(`${this.#apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body } : {}),
    }, doing, signal);
    const text = await response.text();
    if (response.status === 404 && method === "DELETE") throw new DeviceGone();
    if (response.status === 401) this.#token = null;
    if (!response.ok) throw new TailnetError(`Tailscale did not ${doing} (HTTP ${response.status}): ${this.#reason(text)}.${scopeHint(response.status, path)}`);
    return text ? parseJson(text) : {};
  }

  async #send(url: string, init: { method: string; headers: Record<string, string>; body?: string }, doing: string, signal?: AbortSignal): Promise<TailnetResponse> {
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(this.#attemptTimeoutMs);
      try {
        return await this.#fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (attempt < 2) continue;
        const seconds = Math.round(this.#attemptTimeoutMs / 1000);
        const reason = timeout.aborted ? `it did not answer within ${seconds} s, twice` : this.#redact(error instanceof Error ? error.message : String(error));
        throw new TailnetError(`Could not reach Tailscale to ${doing}: ${reason}.`);
      }
    }
  }

  #reason(text: string): string {
    const parsed = parseJson(text) as { message?: unknown; error?: unknown; error_description?: unknown };
    const said = [parsed.message, parsed.error_description, parsed.error].find((value): value is string => typeof value === "string" && value.length > 0);
    return this.#redact(said ?? "no reason given");
  }

  #redact(text: string): string {
    let redacted = text;
    for (const secret of [this.#credentials.clientSecret, this.#token?.value]) {
      if (secret) redacted = redacted.split(secret).join("<redacted>");
    }
    return redacted.replace(/tskey-[A-Za-z0-9_-]+/g, "<redacted>").slice(0, 300);
  }
}

class DeviceGone extends Error {}

function scopeHint(status: number, path: string): string {
  if (status !== 403) return "";
  return path.includes("/device") ? " The OAuth client needs the devices:core scope for this." : " The OAuth client needs the auth_keys scope, and the tags it is given.";
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export function keyDescription(text: string): string {
  return text.replace(/[^A-Za-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, DESCRIPTION_LIMIT) || "bb-box";
}

export function isInstallDevice(hostname: string, installId: string): boolean {
  const install = tailnetHostname(installId);
  return [`bb-box-${install}-`, `bb-box-hz-${install}-`, `bb-box-ns-${install}-`, `bb-box-nsb-${install}-`].some((prefix) => hostname.startsWith(prefix));
}

export function tailnetHostname(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, HOSTNAME_LIMIT) || "bb-box";
}

const AS_ROOT = `as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }`;

export function joinScript(hostname: string): string {
  return [
    "set -eu",
    "umask 077",
    AS_ROOT,
    'key_file=$(mktemp)',
    'trap \'rm -f "$key_file"\' EXIT',
    'cat > "$key_file"',
    `as_root tailscale up --auth-key="file:$key_file" --hostname=${quote(tailnetHostname(hostname))} --accept-dns=false --timeout=60s`,
    "as_root tailscale ip -4 | head -n 1",
  ].join("\n");
}

export function leaveScript(): string {
  return [AS_ROOT, "as_root tailscale logout 2>/dev/null || true"].join("\n");
}
