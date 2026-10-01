// A small in-memory Proxmox API with the LXC behaviour bb-box relies on:
// linked clones that reject `storage`, need a template that is not locked and
// inherit its protection, "already exists" for used VMIDs, asynchronous
// tasks, tags, pools and /cluster/resources.

import { rootDiskGiB, type FetchLike, type FetchResponse } from "../src/backends/proxmox/api.ts";

export interface FakeGuest {
  vmid: number;
  name: string;
  pool?: string;
  status: "running" | "stopped";
  template: boolean;
  config: Record<string, string>;
}

export interface FakeCall {
  method: string;
  path: string;
  params: Record<string, string>;
  auth: string | undefined;
}

interface FakeTask {
  exitstatus: string;
  pollsLeft: number;
}

export const FAKE_TOKEN = { tokenId: "bb-box@pve!plugin", tokenSecret: "s3cret-token-value" };

export class FakeProxmox {
  readonly node = "pve";
  readonly guests = new Map<number, FakeGuest>();
  /** VMIDs another pool claims: invisible to the token, but clone says "already exists". */
  readonly hidden = new Set<number>();
  readonly calls: FakeCall[] = [];
  readonly #tasks = new Map<string, FakeTask>();
  #taskCounter = 0;
  /** Exit status for the next task of this type, for example "WARNINGS: 1" or an error. */
  readonly nextTaskExit = new Map<string, string>();
  /** Polls before a task stops. */
  taskPolls = 1;
  /** Node memory in bytes, as /nodes/{node}/status reports it. */
  memory = { total: 64 * 2 ** 30, available: 48 * 2 ** 30 };
  /** CPU threads, as /nodes/{node}/status reports them. */
  cpus = 16;
  /** Storage in bytes by storage ID. */
  readonly storage = new Map<string, { total: number; avail: number }>([["local-lvm", { total: 900 * 2 ** 30, avail: 600 * 2 ** 30 }]]);
  readonly pools = new Set<string>(["bbbox"]);
  readonly bridges = new Set<string>(["vmbr0", "vmbr1"]);
  /** Optional hook to fail a request: return a response to short-circuit. */
  intercept?: (call: FakeCall) => FetchResponse | undefined;

  addTemplate(vmid: number, config: Record<string, string> = {}): void {
    this.guests.set(vmid, {
      vmid,
      name: `template-${vmid}`,
      status: "stopped",
      template: true,
      config: {
        rootfs: `local-lvm:base-${vmid}-disk-0,size=8G`,
        features: "nesting=1",
        // As build.sh leaves a template.
        cores: "2",
        memory: "4096",
        protection: "1",
        template: "1",
        ...config,
      },
    });
  }

  readonly fetch: FetchLike = async (url, init) => {
    init.signal?.throwIfAborted();
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api2\/json/, "");
    const params: Record<string, string> = {};
    for (const [key, value] of parsed.searchParams) params[key] = value;
    if (init.body) for (const [key, value] of new URLSearchParams(init.body)) params[key] = value;
    const call: FakeCall = { method: init.method, path, params, auth: init.headers.Authorization };
    this.calls.push(call);
    const intercepted = this.intercept?.(call);
    if (intercepted) return intercepted;
    if (call.auth !== `PVEAPIToken=${FAKE_TOKEN.tokenId}=${FAKE_TOKEN.tokenSecret}`) {
      return respond(401, "authentication failure", { data: null });
    }
    return this.#route(call);
  };

  #task(type: string, id: number | string, exit?: string): string {
    const upid = `UPID:${this.node}:0000${++this.#taskCounter}:00:00:${type}:${id}:bb-box@pve!plugin:`;
    this.#tasks.set(upid, { exitstatus: exit ?? this.nextTaskExit.get(type) ?? "OK", pollsLeft: this.taskPolls });
    this.nextTaskExit.delete(type);
    return upid;
  }

  #missing(vmid: number): FetchResponse {
    return respond(500, `Configuration file 'nodes/${this.node}/lxc/${vmid}.conf' does not exist`, { data: null });
  }

  #route(call: FakeCall): FetchResponse {
    const { method, path, params } = call;
    let match: RegExpExecArray | null;
    if (method === "GET" && path === "/version") return ok({ version: "9.2.0", release: "9.2" });
    if (method === "GET" && path === "/nodes") return ok([{ node: this.node, status: "online", type: "node" }]);

    if (method === "GET" && (match = /^\/nodes\/([^/]+)\/status$/.exec(path))) {
      if (match[1] !== this.node) return respond(500, `hostname lookup '${match[1]}' failed`, { data: null });
      const used = this.memory.total - this.memory.available;
      return ok({
        memory: { total: this.memory.total, used, free: this.memory.available / 2, available: this.memory.available },
        cpuinfo: { cpus: this.cpus, cores: this.cpus / 2, sockets: 1 },
        uptime: 100,
      });
    }

    if (method === "GET" && (match = /^\/nodes\/[^/]+\/storage\/([^/]+)\/status$/.exec(path))) {
      const storage = this.storage.get(decodeURIComponent(match[1]!));
      if (!storage) return respond(500, `storage '${match[1]}' does not exist`, { data: null });
      return ok({ ...storage, used: storage.total - storage.avail, active: 1, enabled: 1, type: "lvmthin" });
    }

    if (method === "GET" && path === "/pools") {
      const pool = params.poolid;
      if (pool && !this.pools.has(pool)) return respond(500, `pool '${pool}' does not exist`, { data: null });
      return ok([...this.pools].filter((id) => !pool || id === pool).map((poolid) => ({ poolid, members: [] })));
    }

    if (method === "GET" && (match = /^\/nodes\/([^/]+)\/network\/([^/]+)$/.exec(path))) {
      if (!this.bridges.has(decodeURIComponent(match[2]!))) {
        return respond(400, "Parameter verification failed.", { data: null, errors: { iface: "interface does not exist" } });
      }
      return ok({ iface: match[2], type: "bridge", active: 1 });
    }

    if (method === "GET" && path === "/cluster/resources") {
      return ok(
        [...this.guests.values()].map((guest) => ({
          id: `lxc/${guest.vmid}`,
          type: "lxc",
          vmid: guest.vmid,
          name: guest.name,
          node: this.node,
          status: guest.status,
          template: guest.template ? 1 : 0,
          // As Proxmox gives them: unset cores are the node's, and memory and disk are in bytes.
          maxcpu: Number(guest.config.cores) || this.cpus,
          maxmem: Number(guest.config.memory || 512) * 2 ** 20,
          maxdisk: (rootDiskGiB(guest.config) ?? 0) * 2 ** 30,
          ...(guest.pool ? { pool: guest.pool } : {}),
          ...(guest.config.tags ? { tags: guest.config.tags } : {}),
        })),
      );
    }

    if ((match = /^\/nodes\/([^/]+)\/tasks\/([^/]+)\/status$/.exec(path)) && method === "GET") {
      const upid = decodeURIComponent(match[2]!);
      const task = this.#tasks.get(upid);
      if (!task) return respond(500, "no such task", { data: null });
      if (task.pollsLeft > 0) {
        task.pollsLeft--;
        return ok({ status: "running", upid });
      }
      return ok({ status: "stopped", exitstatus: task.exitstatus, upid });
    }

    if ((match = /^\/nodes\/[^/]+\/lxc\/(\d+)\/clone$/.exec(path)) && method === "POST") {
      const source = this.guests.get(Number(match[1]));
      if (!source) return this.#missing(Number(match[1]));
      if (params.full === "0" && (params.storage || params.format)) {
        return respond(400, "Parameter verification failed.", {
          data: null,
          errors: { storage: "option is only allowed for full clones" },
        });
      }
      const newid = Number(params.newid);
      if (this.guests.has(newid) || this.hidden.has(newid)) {
        return respond(500, `unable to create CT ${newid} - CT ${newid} already exists on node '${this.node}'`, {
          data: null,
        });
      }
      if (source.config.lock) return respond(500, `CT is locked (${source.config.lock})`, { data: null });
      if (params.full === "0" && !source.template) {
        return ok(this.#task("vzclone", source.vmid, `Linked clone feature for 'local-lvm:vm-${source.vmid}-disk-0' is not available`));
      }
      const config = { ...source.config };
      delete config.template;
      config.hostname = params.hostname ?? `CT${newid}`;
      config.rootfs = `local-lvm:base-${source.vmid}-disk-0/vm-${newid}-disk-0,size=${/size=([^,]+)/.exec(source.config.rootfs ?? "")?.[1] ?? "8G"}`;
      if (params.description) config.description = params.description;
      this.guests.set(newid, {
        vmid: newid,
        name: config.hostname,
        pool: params.pool,
        status: "stopped",
        template: false,
        config,
      });
      return ok(this.#task("vzclone", source.vmid));
    }

    if ((match = /^\/nodes\/[^/]+\/lxc\/(\d+)\/config$/.exec(path))) {
      const vmid = Number(match[1]);
      const guest = this.guests.get(vmid);
      if (!guest) return this.#missing(vmid);
      if (method === "GET") return ok({ ...guest.config });
      if (method === "PUT") {
        for (const [key, value] of Object.entries(params)) if (key !== "delete") guest.config[key] = value;
        for (const key of params.delete?.split(",") ?? []) delete guest.config[key];
        if (params.hostname) guest.name = params.hostname;
        return ok(null);
      }
    }

    if ((match = /^\/nodes\/[^/]+\/lxc\/(\d+)\/resize$/.exec(path)) && method === "PUT") {
      const vmid = Number(match[1]);
      const guest = this.guests.get(vmid);
      if (!guest) return this.#missing(vmid);
      guest.config.rootfs = guest.config.rootfs!.replace(/size=[^,]+/, `size=${params.size}`);
      return ok(this.#task("resize", vmid));
    }

    if ((match = /^\/nodes\/[^/]+\/lxc\/(\d+)\/status\/(start|stop|current)$/.exec(path))) {
      const vmid = Number(match[1]);
      const guest = this.guests.get(vmid);
      if (!guest) return this.#missing(vmid);
      if (match[2] === "current" && method === "GET") {
        return ok({ vmid, name: guest.name, status: guest.status, uptime: guest.status === "running" ? 5 : 0 });
      }
      if (method === "POST" && match[2] === "start") {
        if (!this.nextTaskExit.has("vzstart")) guest.status = "running";
        return ok(this.#task("vzstart", vmid));
      }
      if (method === "POST" && match[2] === "stop") {
        guest.status = "stopped";
        return ok(this.#task("vzstop", vmid));
      }
    }

    if ((match = /^\/nodes\/[^/]+\/lxc\/(\d+)$/.exec(path)) && method === "DELETE") {
      const vmid = Number(match[1]);
      const guest = this.guests.get(vmid);
      if (!guest) return this.#missing(vmid);
      if (guest.status === "running") return respond(500, `CT ${vmid} is running - destroy failed`, { data: null });
      if (guest.config.protection === "1") return respond(500, `can't remove CT ${vmid} - protection mode enabled`, { data: null });
      this.guests.delete(vmid);
      return ok(this.#task("vzdestroy", vmid));
    }

    return respond(501, `fake has no route for ${method} ${path}`, { data: null });
  }
}

function ok(data: unknown): FetchResponse {
  return respond(200, "OK", { data });
}

function respond(status: number, statusText: string, body: unknown): FetchResponse {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, statusText, text: async () => text };
}
