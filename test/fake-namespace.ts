import { COMPUTE_SERVICE, type NamespaceFetch } from "../src/backends/namespace/api.ts";

export const FAKE_NAMESPACE_TOKEN = "nsct_fakeTOKENvalue.0123456789";

export interface FakeInstance {
  id: string;
  status: "CREATING" | "RUNNING" | "DESTROYING" | "DESTROYED";
  labels: Record<string, string>;
  shape: { os: string; machineArch: string; virtualCpu: number; memoryMegabytes: number; selectors: { name: string; value: string }[] };
  uniqueTag: string;
  sshKeys: string[];
  createdAt: number;
  deadline: number;
  continent: string;
}

export interface FakeNamespaceOptions {
  readonly now?: () => number;
  readonly lifeCapMs?: number;
  readonly maxCores?: number;
  readonly continent?: string;
}

export class FakeNamespace {
  readonly instances = new Map<string, FakeInstance>();
  readonly calls: { method: string; body: Record<string, unknown> }[] = [];
  readonly failures = new Map<string, { code: string; message: string; times: number }>();
  token = FAKE_NAMESPACE_TOKEN;
  #next = 0;
  readonly #now: () => number;
  readonly #lifeCapMs: number;
  readonly #maxCores: number;
  readonly #continent: string;

  constructor(options: FakeNamespaceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#lifeCapMs = options.lifeCapMs ?? 4 * 3600_000;
    this.#maxCores = options.maxCores ?? 12;
    this.#continent = options.continent ?? "us";
  }

  failNext(method: string, code: string, message = `${method} failed`, times = 1): void {
    this.failures.set(method, { code, message, times });
  }

  running(): FakeInstance[] {
    this.#expire();
    return [...this.instances.values()].filter((instance) => instance.status !== "DESTROYED" && instance.status !== "DESTROYING");
  }

  readonly fetch: NamespaceFetch = async (url, init) => {
    const method = url.slice(url.indexOf(`${COMPUTE_SERVICE}/`) + COMPUTE_SERVICE.length + 1);
    const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    this.calls.push({ method, body });
    const reply = (status: number, value: unknown) => ({ ok: status === 200, status, text: async () => JSON.stringify(value) });
    const refuse = (status: number, code: string, message: string) => reply(status, { code, message });
    if (init.headers.Authorization !== `Bearer ${this.token}`) return refuse(401, "unauthenticated", "invalid token");
    const failure = this.failures.get(method);
    if (failure) {
      failure.times -= 1;
      if (failure.times <= 0) this.failures.delete(method);
      return refuse(failure.code === "not_found" ? 404 : 400, failure.code, failure.message);
    }
    this.#expire();
    const id = typeof body.instanceId === "string" ? body.instanceId : "";
    const found = this.instances.get(id);
    switch (method) {
      case "CreateInstance": {
        const experimental = (body.experimental ?? {}) as { uniqueTag?: string; authorizedSshKeys?: string[] };
        const tag = experimental.uniqueTag ?? "";
        const same = tag ? this.running().find((instance) => instance.uniqueTag === tag) : undefined;
        if (same) return reply(200, { metadata: this.#metadata(same, false) });
        const shape = body.shape as FakeInstance["shape"];
        const used = this.running().reduce((sum, instance) => sum + instance.shape.virtualCpu, 0);
        if (used + shape.virtualCpu > this.#maxCores) return refuse(400, "resource_exhausted", "concurrency limit reached");
        const created = this.#now();
        const requested = Date.parse(String(body.deadline));
        const instance: FakeInstance = {
          id: `fake${(++this.#next).toString(36).padStart(8, "0")}`,
          status: "CREATING",
          labels: Object.fromEntries(((body.labels ?? []) as { name: string; value: string }[]).map((label) => [label.name, label.value])),
          shape: { ...shape, selectors: shape.selectors ?? [] },
          uniqueTag: tag,
          sshKeys: experimental.authorizedSshKeys ?? [],
          createdAt: created,
          deadline: Math.min(Number.isFinite(requested) ? requested : created + 600_000, created + this.#lifeCapMs),
          continent: this.#continent,
        };
        this.instances.set(instance.id, instance);
        return reply(200, { metadata: this.#metadata(instance, false) });
      }
      case "WaitInstanceSync":
      case "DescribeInstance": {
        if (!found) return refuse(404, "not_found", "instance not found");
        if (method === "WaitInstanceSync" && found.status === "CREATING") found.status = "RUNNING";
        return reply(200, { metadata: this.#metadata(found, true) });
      }
      case "ListInstances": {
        const filters = (body.labelFilter ?? []) as { name: string; value: string }[];
        const matching = this.running().filter((instance) => filters.every((filter) => instance.labels[filter.name] === filter.value));
        return reply(200, { instances: matching.map((instance) => this.#metadata(instance, true)) });
      }
      case "ExtendInstance": {
        if (!found || found.status === "DESTROYED") return refuse(404, "not_found", "instance not found");
        const minimum = Number.parseFloat(String(body.ensureMinimum ?? "0")) * 1000;
        found.deadline = Math.min(Math.max(found.deadline, this.#now() + minimum), found.createdAt + this.#lifeCapMs);
        return reply(200, { newDeadline: new Date(found.deadline).toISOString() });
      }
      case "DestroyInstance": {
        if (!found || found.status === "DESTROYED") return refuse(404, "not_found", "instance not found");
        found.status = "DESTROYED";
        return reply(200, {});
      }
      case "GetVNCConfig": {
        if (!found || found.status !== "RUNNING") return refuse(404, "not_found", "instance not found");
        return reply(200, { endpoint: "127.0.0.1:5900", username: "runner", password: `vnc-${found.id}` });
      }
      default:
        return refuse(404, "unimplemented", `no method ${method}`);
    }
  };

  #expire(): void {
    const now = this.#now();
    for (const instance of this.instances.values()) if (instance.status !== "DESTROYED" && instance.deadline <= now) instance.status = "DESTROYED";
  }

  #metadata(instance: FakeInstance, described: boolean): Record<string, unknown> {
    return {
      instanceId: instance.id,
      ...(described ? { status: instance.status } : {}),
      labels: Object.entries(instance.labels).map(([name, value]) => ({ name, value })),
      createdAt: new Date(instance.createdAt).toISOString(),
      ...(instance.status === "RUNNING" ? { readyAt: new Date(instance.createdAt + 20_000).toISOString() } : {}),
      deadline: new Date(instance.deadline).toISOString(),
      shape: instance.shape,
      ...(described ? { hwDeployment: { geoContinent: instance.continent, majorHwplatform: "fake" } } : {}),
    };
  }
}
