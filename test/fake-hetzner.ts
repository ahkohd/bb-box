import type { HetznerFetch, HetznerResponse } from "../src/backends/hetzner/api.ts";

export const FAKE_HETZNER_TOKEN = "hcloud-fake-token-0123456789abcdefghijklmnopqrstuvwxyz";

export interface FakeHetznerCall {
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: Record<string, unknown> | undefined;
  readonly auth: string | undefined;
}

export interface FakeServer {
  id: number;
  name: string;
  status: string;
  created: string;
  labels: Record<string, string>;
  serverType: string;
  location: string;
  image: number | null;
  userData?: string;
  sshKeys: number[];
  firewalls: number[];
  ipv4: string | null;
}

interface FakeAction {
  id: number;
  command: string;
  pollsLeft: number;
  error: { code: string; message: string } | null;
  done?: () => void;
}

interface Labelled {
  id: number;
  name: string;
  labels: Record<string, string>;
}

interface FakeImage {
  id: number;
  description: string;
  status: string;
  created: string;
  labels: Record<string, string>;
  imageSize: number | null;
  createdFrom: number;
}

export type Interception = { respond: HetznerResponse } | "hang" | "lose" | "hang after acting";

export const FAKE_SERVER_TYPES = [
  { name: "cpx32", cores: 4, memory: 8, disk: 160, hourly: "0.0569000000", monthly: "35.4900000000" },
  { name: "cpx42", cores: 8, memory: 16, disk: 320, hourly: "0.1114000000", monthly: "69.4900000000" },
  { name: "cpx52", cores: 12, memory: 24, disk: 480, hourly: "0.1610000000", monthly: "100.4900000000" },
];
export const FAKE_LOCATIONS = ["nbg1", "fsn1", "hel1"];

export class FakeHetzner {
  readonly servers = new Map<number, FakeServer>();
  readonly sshKeys = new Map<number, Labelled & { publicKey: string }>();
  readonly firewalls = new Map<number, Labelled & { rules: unknown[] }>();
  readonly images = new Map<number, FakeImage>();
  readonly actions = new Map<number, FakeAction>();
  readonly calls: FakeHetznerCall[] = [];
  pollsUntilCreatedServerRuns = 2;
  pollsUntilOtherActionsFinish = 1;
  projectServerLimit = 10;
  readonly soldOutTypeAtLocation = new Set<string>();
  requestsLeftThisHour = 3600;
  readonly requestsPerHour = 3600;
  intercept?: (call: FakeHetznerCall) => Interception | undefined;
  readonly #creatingAction = new Map<number, FakeAction>();
  #nextId = 1000;
  #clock = Date.parse("2026-10-22T10:00:00Z");

  advanceClock(ms: number): void {
    this.#clock += ms;
  }

  get now(): number {
    return this.#clock;
  }

  readonly fetch: HetznerFetch = async (url, init) => {
    init.signal?.throwIfAborted();
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/v1/, "");
    const query: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) query[key] = value;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: FakeHetznerCall = { method: init.method, path, query, body, auth: init.headers.Authorization };
    this.calls.push(call);
    const interception = this.intercept?.(call);
    if (interception === "hang") {
      return new Promise<HetznerResponse>((_, reject) => {
        if (!init.signal) return;
        init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
    }
    if (interception && typeof interception === "object") return interception.respond;
    if (call.auth !== `Bearer ${FAKE_HETZNER_TOKEN}`) return this.#failure(401, "unauthorized", "unable to authenticate");
    if (this.requestsLeftThisHour <= 0) return this.#failure(429, "rate_limit_exceeded", "limit of 3600 requests per hour reached", { "Retry-After": "1" });
    this.requestsLeftThisHour--;
    const response = this.#route(call);
    if (interception === "lose") throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
    if (interception === "hang after acting") return new Promise<HetznerResponse>(() => {});
    return response;
  };

  #route(call: FakeHetznerCall): HetznerResponse {
    const { method, path, query, body } = call;
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/servers") {
      const all = [...this.servers.values()].filter((each) => (query.name === undefined || each.name === query.name) && selectorMatches(each.labels, query.label_selector));
      return this.#page(all.map((each) => this.#server(each)), "servers", query);
    }
    if (method === "POST" && path === "/servers") return this.#createServer(body ?? {});
    if ((match = /^\/servers\/(\d+)$/.exec(path))) {
      const found = this.servers.get(Number(match[1]));
      if (!found) return this.#failure(404, "not_found", "server not found");
      if (method === "GET") {
        const creating = this.#creatingAction.get(found.id);
        if (creating) this.#tick(creating);
        return this.#ok({ server: this.#server(found) });
      }
      if (method === "PUT") {
        if (body?.labels) found.labels = { ...(body.labels as Record<string, string>) };
        return this.#ok({ server: this.#server(found) });
      }
      if (method === "DELETE") {
        found.status = "deleting";
        const action = this.#action("delete_server", this.pollsUntilOtherActionsFinish, () => this.servers.delete(found.id));
        return this.#ok({ action: this.#actionJson(action) });
      }
    }
    if (method === "POST" && (match = /^\/servers\/(\d+)\/actions\/create_image$/.exec(path))) {
      const found = this.servers.get(Number(match[1]));
      if (!found) return this.#failure(404, "not_found", "server not found");
      const made: FakeImage = {
        id: this.#id(),
        description: String(body?.description ?? ""),
        status: "creating",
        created: this.#iso(),
        labels: { ...((body?.labels as Record<string, string>) ?? {}) },
        imageSize: null,
        createdFrom: found.id,
      };
      this.images.set(made.id, made);
      const action = this.#action("create_image", this.pollsUntilOtherActionsFinish, () => {
        made.status = "available";
        made.imageSize = 4.2;
      });
      return this.#ok({ image: this.#image(made), action: this.#actionJson(action) }, 201);
    }
    if (method === "GET" && (match = /^\/actions\/(\d+)$/.exec(path))) {
      const action = this.actions.get(Number(match[1]));
      if (!action) return this.#failure(404, "not_found", "action not found");
      this.#tick(action);
      return this.#ok({ action: this.#actionJson(action) });
    }
    if (path === "/ssh_keys" || /^\/ssh_keys\/\d+$/.test(path)) return this.#labelled(call, this.sshKeys, "ssh_key", (input) => ({ publicKey: String(input.public_key ?? "") }));
    if (method === "POST" && (match = /^\/firewalls\/(\d+)\/actions\/set_rules$/.exec(path))) {
      const found = this.firewalls.get(Number(match[1]));
      if (!found) return this.#failure(404, "not_found", "firewall not found");
      found.rules = (body?.rules as unknown[]) ?? [];
      return this.#ok({ actions: [this.#actionJson(this.#action("set_firewall_rules", 0))] }, 201);
    }
    if (path === "/firewalls" || /^\/firewalls\/\d+$/.test(path)) {
      if (method === "DELETE") {
        const id = Number(path.split("/")[2]);
        if ([...this.servers.values()].some((each) => each.firewalls.includes(id))) return this.#failure(422, "resource_in_use", "firewall is still applied");
      }
      return this.#labelled(call, this.firewalls, "firewall", (input) => ({ rules: (input.rules as unknown[]) ?? [] }));
    }
    if (method === "GET" && path === "/images") {
      const all = [...this.images.values()].filter((each) => (query.type === undefined || query.type === "snapshot") && selectorMatches(each.labels, query.label_selector));
      return this.#page(all.map((each) => this.#image(each)), "images", query);
    }
    if ((match = /^\/images\/(\d+)$/.exec(path))) {
      const found = this.images.get(Number(match[1]));
      if (!found) return this.#failure(404, "not_found", "image not found");
      if (method === "GET") return this.#ok({ image: this.#image(found) });
      if (method === "DELETE") {
        this.images.delete(found.id);
        return this.#empty();
      }
    }
    if (method === "GET" && path === "/server_types") {
      const all = FAKE_SERVER_TYPES.filter((each) => query.name === undefined || each.name === query.name).map((each, index) => ({
        id: index + 1,
        name: each.name,
        cores: each.cores,
        memory: each.memory,
        disk: each.disk,
        architecture: "x86",
        deprecation: null,
        prices: FAKE_LOCATIONS.map((location) => this.#price(location, each)),
      }));
      return this.#page(all, "server_types", query);
    }
    if (method === "GET" && path === "/pricing") {
      return this.#ok({
        pricing: {
          currency: "EUR",
          vat_rate: "19.00",
          server_types: FAKE_SERVER_TYPES.map((each, index) => ({ id: index + 1, name: each.name, prices: FAKE_LOCATIONS.map((location) => this.#price(location, each)) })),
          primary_ips: [
            { type: "ipv4", prices: FAKE_LOCATIONS.map((location) => ({ location, price_hourly: { net: "0.0008000000", gross: "0.0009520000" }, price_monthly: { net: "0.5000000000", gross: "0.5950000000" } })) },
            { type: "ipv6", prices: FAKE_LOCATIONS.map((location) => ({ location, price_hourly: { net: "0.0000000000", gross: "0.0000000000" }, price_monthly: { net: "0.0000000000", gross: "0.0000000000" } })) },
          ],
        },
      });
    }
    return this.#failure(404, "not_found", `no route for ${method} ${path}`);
  }

  #createServer(body: Record<string, unknown>): HetznerResponse {
    const name = String(body.name ?? "");
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(name)) return this.#failure(400, "invalid_input", "invalid input in field 'name'");
    if ([...this.servers.values()].some((each) => each.name === name)) return this.#failure(409, "uniqueness_error", "server name is already used");
    const type = FAKE_SERVER_TYPES.find((each) => each.name === body.server_type);
    if (!type) return this.#failure(400, "invalid_input", "unknown server type");
    const location = String(body.location ?? "");
    if (!FAKE_LOCATIONS.includes(location)) return this.#failure(400, "invalid_input", "unknown location");
    if (this.servers.size >= this.projectServerLimit) return this.#failure(403, "resource_limit_exceeded", "server limit exceeded");
    if (this.soldOutTypeAtLocation.has(`${type.name}@${location}`)) return this.#failure(412, "resource_unavailable", "server type unavailable in location");
    const imageRef = String(body.image ?? "");
    const snapshot = /^\d+$/.test(imageRef) ? this.images.get(Number(imageRef)) : undefined;
    if (/^\d+$/.test(imageRef) && !snapshot) return this.#failure(400, "invalid_input", "image not found");
    for (const key of (body.ssh_keys as string[] | undefined) ?? []) {
      if (!this.sshKeys.has(Number(key)) && ![...this.sshKeys.values()].some((each) => each.name === key)) return this.#failure(400, "invalid_input", "ssh key not found");
    }
    const firewalls = ((body.firewalls as { firewall: number }[] | undefined) ?? []).map((each) => each.firewall);
    for (const id of firewalls) if (!this.firewalls.has(id)) return this.#failure(400, "invalid_input", "firewall not found");
    const id = this.#id();
    const made: FakeServer = {
      id,
      name,
      status: "initializing",
      created: this.#iso(),
      labels: { ...((body.labels as Record<string, string>) ?? {}) },
      serverType: type.name,
      location,
      image: snapshot ? snapshot.id : 1,
      userData: typeof body.user_data === "string" ? body.user_data : undefined,
      sshKeys: ((body.ssh_keys as string[] | undefined) ?? []).map(Number),
      firewalls,
      ipv4: (body.public_net as { enable_ipv4?: boolean } | undefined)?.enable_ipv4 === false ? null : `203.0.113.${(id % 250) + 1}`,
    };
    this.servers.set(id, made);
    const action = this.#action("create_server", this.pollsUntilCreatedServerRuns, () => {
      if (this.servers.has(id)) made.status = "running";
      this.#creatingAction.delete(id);
    });
    if (action.done) this.#creatingAction.set(id, action);
    const start = this.#action("start_server", 0);
    return this.#ok({ server: this.#server(made), action: this.#actionJson(action), next_actions: [this.#actionJson(start)], root_password: null }, 201);
  }

  #labelled<T extends Labelled>(call: FakeHetznerCall, store: Map<number, T>, key: string, extra: (body: Record<string, unknown>) => Omit<T, keyof Labelled>): HetznerResponse {
    const { method, path, query, body } = call;
    const id = Number(path.split("/")[2]);
    if (method === "GET" && !id) {
      return this.#page([...store.values()].filter((each) => selectorMatches(each.labels, query.label_selector)).map(publicJson), `${key}s`, query);
    }
    if (method === "POST" && !id) {
      const name = String(body?.name ?? "");
      if ([...store.values()].some((each) => each.name === name)) return this.#failure(409, "uniqueness_error", `${key} name is already used`);
      const made = { id: this.#id(), name, labels: { ...((body?.labels as Record<string, string>) ?? {}) }, ...extra(body ?? {}) } as T;
      store.set(made.id, made);
      return this.#ok({ [key]: publicJson(made) }, 201);
    }
    const found = store.get(id);
    if (!found) return this.#failure(404, "not_found", `${key} not found`);
    if (method === "GET") return this.#ok({ [key]: publicJson(found) });
    if (method === "DELETE") {
      store.delete(id);
      return this.#empty();
    }
    return this.#failure(404, "not_found", `no route for ${method} ${path}`);
  }

  #page(all: unknown[], key: string, query: Record<string, string>): HetznerResponse {
    const perPage = Math.min(50, Number(query.per_page ?? 25));
    const page = Number(query.page ?? 1);
    const last = Math.max(1, Math.ceil(all.length / perPage));
    return this.#ok({
      [key]: all.slice((page - 1) * perPage, page * perPage),
      meta: { pagination: { page, per_page: perPage, previous_page: page > 1 ? page - 1 : null, next_page: page < last ? page + 1 : null, last_page: last, total_entries: all.length } },
    });
  }

  #server(each: FakeServer): Record<string, unknown> {
    const type = FAKE_SERVER_TYPES.find((entry) => entry.name === each.serverType)!;
    return {
      id: each.id,
      name: each.name,
      status: each.status,
      created: each.created,
      labels: each.labels,
      public_net: { ipv4: each.ipv4 ? { ip: each.ipv4 } : null, ipv6: { ip: `2001:db8:${each.id.toString(16)}::/64` } },
      server_type: { name: type.name, cores: type.cores, memory: type.memory, disk: type.disk },
      datacenter: { name: `${each.location}-dc3`, location: { name: each.location } },
      image: each.image === null ? null : { id: each.image },
    };
  }

  #image(each: FakeImage): Record<string, unknown> {
    return { id: each.id, type: "snapshot", description: each.description, status: each.status, created: each.created, labels: each.labels, image_size: each.imageSize, created_from: { id: each.createdFrom } };
  }

  #price(location: string, type: (typeof FAKE_SERVER_TYPES)[number]): Record<string, unknown> {
    return { location, price_hourly: { net: type.hourly, gross: type.hourly }, price_monthly: { net: type.monthly, gross: type.monthly } };
  }

  #action(command: string, polls: number, done?: () => void): FakeAction {
    const action: FakeAction = { id: this.#id(), command, pollsLeft: polls, error: null, done };
    this.actions.set(action.id, action);
    if (polls === 0 && done) {
      done();
      action.done = undefined;
    }
    return action;
  }

  failActionOnNextPoll(id: number, code: string, message: string): void {
    const action = this.actions.get(id);
    if (!action) return;
    action.error = { code, message };
    action.pollsLeft = 0;
    action.done = undefined;
  }

  #tick(action: FakeAction): void {
    if (action.pollsLeft > 0) action.pollsLeft--;
    if (action.pollsLeft === 0 && action.done) {
      action.done();
      action.done = undefined;
    }
  }

  #actionJson(action: FakeAction): Record<string, unknown> {
    const status = action.error ? "error" : action.pollsLeft > 0 ? "running" : "success";
    return { id: action.id, command: action.command, status, progress: status === "running" ? 50 : 100, error: action.error };
  }

  #id(): number {
    return ++this.#nextId;
  }

  #iso(): string {
    return new Date(this.#clock).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "RateLimit-Limit": String(this.requestsPerHour),
      "RateLimit-Remaining": String(Math.max(0, this.requestsLeftThisHour)),
      "RateLimit-Reset": String(Math.floor(this.#clock / 1000) + (this.requestsPerHour - this.requestsLeftThisHour)),
      ...extra,
    };
  }

  #ok(body: unknown, status = 200): HetznerResponse {
    return respond(status, status === 201 ? "Created" : "OK", body, this.#headers());
  }

  #empty(): HetznerResponse {
    return respond(204, "No Content", undefined, this.#headers());
  }

  #failure(status: number, code: string, message: string, extra: Record<string, string> = {}): HetznerResponse {
    return respond(status, message, { error: { code, message, details: {} } }, this.#headers(extra));
  }
}

export function respond(status: number, statusText: string, body: unknown, headers: Record<string, string> = {}): HetznerResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

function publicJson(each: Labelled): Record<string, unknown> {
  const { publicKey: _publicKey, ...rest } = each as Labelled & { publicKey?: string };
  return { ...rest, fingerprint: "b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2c", created: "2026-10-22T10:00:00+00:00" };
}

export function selectorMatches(labels: Record<string, string>, selector: string | undefined): boolean {
  if (!selector) return true;
  return splitTerms(selector).every((term) => {
    let match: RegExpExecArray | null;
    if ((match = /^([^!=\s]+)\s*(==|=|!=)\s*(.*)$/.exec(term))) return match[2] === "!=" ? labels[match[1]!] !== match[3] : labels[match[1]!] === match[3];
    if ((match = /^([^\s]+)\s+(in|notin)\s+\((.*)\)$/.exec(term))) {
      const values = match[3]!.split(",").map((each) => each.trim());
      const has = match[1]! in labels && values.includes(labels[match[1]!]!);
      return match[2] === "in" ? has : !has;
    }
    if (term.startsWith("!")) return !(term.slice(1) in labels);
    return term in labels;
  });
}

function splitTerms(selector: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of selector) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      terms.push(current.trim());
      current = "";
    } else current += char;
  }
  if (current.trim()) terms.push(current.trim());
  return terms;
}
