// A small in-memory Proxmox API with the behaviour bb-box relies on, for
// containers and VMs: linked clones that reject `storage`, need a template
// that is not locked and inherit its protection, "already exists" for used
// VMIDs, asynchronous tasks, tags, pools, /cluster/resources with the status
// daemon's lag, each node's own guest lists, a VM console's VNC proxy and a
// VM's suspend to disk, whose lock refuses config changes until a start.

import { rootDiskGiB, type FetchLike, type FetchResponse } from "../src/backends/proxmox/api.ts";

export interface FakeGuest {
  vmid: number;
  /** A container unless it says qemu. */
  type?: "lxc" | "qemu";
  name: string;
  pool?: string;
  status: "running" | "stopped";
  template: boolean;
  config: Record<string, string>;
  /** A started container's root filesystem size in bytes, as df gave it then. */
  filesystem?: number;
  snapshots?: FakeSnapshot[];
}

export interface FakeSnapshot {
  name: string;
  description: string;
  snaptime: number;
  snapstate?: string;
  vmstate?: boolean;
  config?: Record<string, string>;
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
  start: number;
}

export const TOKEN_ROLE = [
  "VM.Audit",
  "VM.Clone",
  "VM.Allocate",
  "VM.Config.CPU",
  "VM.Config.Memory",
  "VM.Config.Disk",
  "VM.Config.Network",
  "VM.Config.Options",
  "VM.Config.HWType",
  "VM.Console",
  "VM.PowerMgmt",
  "VM.Snapshot",
  "VM.Snapshot.Rollback",
  "Pool.Audit",
] as const;

export const FAKE_TOKEN = { tokenId: "bb-box@pve!plugin", tokenSecret: "s3cret-token-value" };

export class FakeProxmox {
  readonly node = "pve";
  readonly guests = new Map<number, FakeGuest>();
  /** Volumes made for new disks, for their names. */
  volumes = 0;
  /** VMIDs another pool claims: invisible to the token, but clone says "already exists". */
  readonly hidden = new Set<number>();
  readonly calls: FakeCall[] = [];
  /** The VNC proxies opened, oldest first. */
  readonly consoles: { vmid: number; port: number; ticket: string; password?: string }[] = [];
  readonly #tasks = new Map<string, FakeTask>();
  #taskCounter = 0;
  /**
   * Exit status for the next task of this type, for example "WARNINGS: 1" or
   * an error. A start, stop, suspend, disk resize or delete given one leaves
   * the guest as it was.
   */
  readonly nextTaskExit = new Map<string, string>();
  /** Polls before a task stops. */
  taskPolls = 1;
  /** Node memory in bytes, as /nodes/{node}/status reports it. */
  memory = { total: 64 * 2 ** 30, available: 48 * 2 ** 30 };
  /** CPU threads, as /nodes/{node}/status reports them. */
  cpus = 16;
  /** Storage in bytes by storage ID. */
  readonly storage = new Map<string, { total: number; avail: number }>([["local-lvm", { total: 900 * 2 ** 30, avail: 600 * 2 ** 30 }]]);
  /** Each storage's type, lvmthin unless it says. */
  readonly storageTypes = new Map<string, string>();
  readonly pools = new Set<string>(["bbbox"]);
  readonly privileges = new Map<string, Set<string>>([["/pool/bbbox", new Set(TOKEN_ROLE)]]);
  readonly bridges = new Set<string>(["vmbr0", "vmbr1"]);
  killNextSnapshot = false;
  #snapshotsTaken = 0;
  snapshotTaskFailsWhole = false;
  readonly storageConfigs = new Map<string, Record<string, unknown>>([["local-lvm", { storage: "local-lvm", type: "lvmthin", vgname: "pve", thinpool: "data", content: "rootdir,images" }]]);
  readonly thinPools: { lv: string; vg: string; metadata_size: number; metadata_used: number }[] = [{ lv: "data", vg: "pve", metadata_size: 1024 ** 3, metadata_used: 100 * 1024 ** 2 }];
  /** Optional hook to fail a request: return a response to short-circuit. */
  intercept?: (call: FakeCall) => FetchResponse | undefined;
  /**
   * What Proxmox's status daemon read of each guest on its last pass, by
   * VMID, which /cluster/resources gives. It reads every 10 s or so, so a new
   * guest has none until `statusPass()`.
   */
  readonly #listed = new Map<number, Record<string, unknown>>();

  /** A pass of the status daemon over every guest. */
  statusPass(): void {
    for (const guest of this.guests.values()) this.#listed.set(guest.vmid, this.#current(guest));
  }

  /** A guest as its node reads it now, for /nodes/{node}/lxc and /nodes/{node}/qemu. */
  #current(guest: FakeGuest): Record<string, unknown> {
    return {
      vmid: guest.vmid,
      type: guest.type ?? "lxc",
      name: guest.name,
      status: guest.status,
      ...(guest.template ? { template: 1 } : {}),
      // As Proxmox gives them: unset cores are the node's, and memory and disk are in bytes.
      cpus: Number(guest.config.cores) || this.cpus,
      maxmem: Number(guest.config.memory || 512) * 2 ** 20,
      // A running container's is its filesystem's.
      maxdisk:
        guest.status === "running" && guest.filesystem !== undefined
          ? guest.filesystem
          : (rootDiskGiB(guest.config) ?? Number(/size=(\d+)G/.exec(guest.config.scsi0 ?? "")?.[1] ?? 0)) * 2 ** 30,
      ...(guest.config.tags ? { tags: guest.config.tags } : {}),
    };
  }

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
    this.#listed.set(vmid, this.#current(this.guests.get(vmid)!));
  }

  /** A VM template, as setup/proxmox-qemu/build.sh leaves one. */
  addVmTemplate(vmid: number, config: Record<string, string> = {}): void {
    this.guests.set(vmid, {
      vmid,
      type: "qemu",
      name: `template-${vmid}`,
      status: "stopped",
      template: true,
      config: {
        scsi0: `local-lvm:base-${vmid}-disk-1,discard=on,iothread=1,size=64G`,
        efidisk0: `local-lvm:base-${vmid}-disk-0,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=4M`,
        ide2: "none,media=cdrom",
        boot: "order=scsi0;ide2",
        net0: "virtio=BC:24:11:00:00:01,bridge=vmbr1",
        ostype: "win11",
        agent: "1",
        cores: "4",
        memory: "8192",
        protection: "1",
        template: "1",
        ...config,
      },
    });
    this.#listed.set(vmid, this.#current(this.guests.get(vmid)!));
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
    this.#tasks.set(upid, { exitstatus: exit ?? this.nextTaskExit.get(type) ?? "OK", pollsLeft: this.taskPolls, start: Math.floor(Date.now() / 1000) });
    this.nextTaskExit.delete(type);
    return upid;
  }

  /** The token's rights come from the pool, so Proxmox refuses a VMID with no guest before it looks for one. */
  #missing(vmid: number, type = "lxc"): FetchResponse {
    if (!this.guests.has(vmid)) return respond(403, `Permission check failed (/vms/${vmid}, VM.Audit)`, { data: null });
    return respond(500, `Configuration file 'nodes/${this.node}/${type === "qemu" ? "qemu-server" : "lxc"}/${vmid}.conf' does not exist`, { data: null });
  }

  /** The guest at `vmid` if it is of `type`, as Proxmox finds a guest only under its own type. */
  #of(type: string, vmid: number): FakeGuest | undefined {
    const guest = this.guests.get(vmid);
    return guest && (guest.type ?? "lxc") === type ? guest : undefined;
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
      return ok({ ...storage, used: storage.total - storage.avail, active: 1, enabled: 1, type: this.storageTypes.get(decodeURIComponent(match[1]!)) ?? "lvmthin" });
    }

    if (method === "GET" && path === "/access/permissions") {
      const privileges = (paths: string[]) => Object.fromEntries(paths.map((each) => [each, Object.fromEntries([...this.privileges.get(each)!].map((privilege) => [privilege, 1]))]));
      if (!params.path) return ok(privileges([...this.privileges.keys()]));
      return ok(this.privileges.has(params.path) ? privileges([params.path]) : {});
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
        [...this.guests.values()].map((guest) => {
          // The guest, its pool and its tags are current; the rest is as the status daemon last read it.
          const listed = this.#listed.get(guest.vmid);
          return {
            id: `${guest.type ?? "lxc"}/${guest.vmid}`,
            type: guest.type ?? "lxc",
            vmid: guest.vmid,
            node: this.node,
            status: "unknown",
            ...(listed
              ? { name: listed.name, status: listed.status, template: listed.template ?? 0, maxcpu: listed.cpus, maxmem: listed.maxmem, maxdisk: listed.maxdisk }
              : {}),
            ...(guest.pool ? { pool: guest.pool } : {}),
            ...(guest.config.tags ? { tags: guest.config.tags } : {}),
          };
        }),
      );
    }

    if (method === "GET" && (match = /^\/nodes\/[^/]+\/disks\/lvmthin$/.exec(path))) return ok(this.thinPools);

    if (method === "GET" && path === "/storage") return ok([...this.storageConfigs.values()]);

    if (method === "GET" && (match = /^\/nodes\/[^/]+\/tasks$/.exec(path))) {
      const all = params.source === "all";
      const listed = [...this.#tasks.entries()].filter(
        ([upid, task]) =>
          (all || task.pollsLeft > 0) &&
          (!params.vmid || upid.split(":")[6] === params.vmid) &&
          (!params.typefilter || upid.split(":")[5] === params.typefilter) &&
          (!params.since || task.start >= Number(params.since)),
      );
      return ok(listed.map(([upid, task]) => ({ upid, type: upid.split(":")[5], id: upid.split(":")[6], user: upid.split(":")[7], starttime: task.start, ...(task.pollsLeft > 0 ? { status: "RUNNING" } : { status: task.exitstatus, endtime: task.start + 1 }) })));
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/snapshot\/([^/]+)\/(rollback|config)$/.exec(path))) {
      const [, type = "lxc", id, encoded, action] = match;
      const vmid = Number(id);
      const guest = this.#of(type, vmid);
      if (!guest) return this.#missing(vmid, type);
      const name = decodeURIComponent(encoded!);
      const snapshot = guest.snapshots?.find((each) => each.name === name);
      if (!snapshot) return respond(500, `snapshot '${name}' does not exist`, { data: null });
      if (action === "config" && method === "GET") return ok({ ...(snapshot.config ?? {}) });
      if (action === "rollback" && method === "POST") {
        const prefix = type === "qemu" ? "qm" : "vz";
        const what = type === "qemu" ? "VM" : "CT";
        if (guest.config.lock) return ok(this.#task(`${prefix}rollback`, vmid, `${what} is locked (${guest.config.lock})`));
        if (this.nextTaskExit.has(`${prefix}rollback`)) {
          guest.config.lock = "rollback";
          return ok(this.#task(`${prefix}rollback`, vmid));
        }
        guest.config = { ...(snapshot.config ?? guest.config), parent: name };
        guest.status = "stopped";
        return ok(this.#task(`${prefix}rollback`, vmid));
      }
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/snapshot(?:\/([^/]+))?$/.exec(path))) {
      const [, type = "lxc", id, name] = match;
      const vmid = Number(id);
      const guest = this.#of(type, vmid);
      if (!guest) return this.#missing(vmid, type);
      const prefix = type === "qemu" ? "qm" : "vz";
      const what = type === "qemu" ? "VM" : "CT";
      const snapshots = (guest.snapshots ??= []);
      if (method === "GET" && !name) {
        return ok([
          ...snapshots.map((snapshot) => ({ name: snapshot.name, description: snapshot.description, snaptime: snapshot.snaptime, ...(snapshot.snapstate ? { snapstate: snapshot.snapstate } : {}), ...(type === "qemu" ? { vmstate: snapshot.vmstate ? 1 : 0 } : {}) })),
          { name: "current", digest: "d1", running: guest.status === "running" ? 1 : 0 },
        ]);
      }
      if (method === "POST" && !name) {
        if (guest.config.lock) return ok(this.#task(`${prefix}snapshot`, vmid, `${what} is locked (${guest.config.lock})`));
        if (snapshots.some((snapshot) => snapshot.name === params.snapname)) return ok(this.#task(`${prefix}snapshot`, vmid, `snapshot name '${params.snapname}' already used`));
        const taken: FakeSnapshot = { name: params.snapname!, description: params.description ?? "", snaptime: Math.floor(Date.now() / 1000) + this.#snapshotsTaken++, config: { ...guest.config }, ...(params.vmstate === "1" ? { vmstate: true } : {}) };
        if (this.snapshotTaskFailsWhole) {
          this.snapshotTaskFailsWhole = false;
          snapshots.push(taken);
          return ok(this.#task(`${prefix}snapshot`, vmid, "vmstate save failed"));
        }
        if (this.killNextSnapshot) {
          this.killNextSnapshot = false;
          snapshots.push({ ...taken, snapstate: "prepare" });
          guest.config.lock = "snapshot";
          return ok(this.#task(`${prefix}snapshot`, vmid, "received interrupt"));
        }
        if (!this.nextTaskExit.has(`${prefix}snapshot`)) snapshots.push(taken);
        return ok(this.#task(`${prefix}snapshot`, vmid));
      }
      if (method === "DELETE" && name) {
        const index = snapshots.findIndex((snapshot) => snapshot.name === decodeURIComponent(name));
        if (index < 0) return respond(500, `snapshot '${name}' does not exist`, { data: null });
        if (guest.config.lock) return ok(this.#task(`${prefix}delsnapshot`, vmid, `${what} is locked (${guest.config.lock})`));
        if (this.nextTaskExit.has(`${prefix}delsnapshot`)) snapshots[index]!.snapstate = "delete";
        else snapshots.splice(index, 1);
        return ok(this.#task(`${prefix}delsnapshot`, vmid));
      }
    }

    if (method === "GET" && (match = /^\/nodes\/([^/]+)\/(lxc|qemu)$/.exec(path))) {
      if (match[1] !== this.node) return respond(500, `hostname lookup '${match[1]}' failed`, { data: null });
      return ok([...this.guests.values()].filter((guest) => (guest.type ?? "lxc") === match![2]).map((guest) => this.#current(guest)));
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

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/clone$/.exec(path)) && method === "POST") {
      const type = match[1]!;
      const source = this.#of(type, Number(match[2]));
      if (!source) return this.#missing(Number(match[2]), type);
      if (params.full !== "1" && (params.storage || params.format)) {
        return respond(400, "Parameter verification failed.", {
          data: null,
          errors: { storage: "option is only allowed for full clones" },
        });
      }
      const newid = Number(params.newid);
      if (this.guests.has(newid) || this.hidden.has(newid)) {
        const what = type === "qemu" ? "VM" : "CT";
        return respond(500, `unable to create ${what} ${newid} - ${what} ${newid} already exists on node '${this.node}'`, {
          data: null,
        });
      }
      if (source.config.lock) return respond(500, `CT is locked (${source.config.lock})`, { data: null });
      if (params.full === "0" && !source.template) {
        return ok(this.#task("vzclone", source.vmid, `Linked clone feature for 'local-lvm:vm-${source.vmid}-disk-0' is not available`));
      }
      const config = { ...source.config };
      delete config.template;
      let name: string;
      if (type === "qemu") {
        name = config.name = params.name ?? `VM${newid}`;
        config.scsi0 = config.scsi0!.replace(/^local-lvm:base-(\d+)-disk-(\d+)/, `local-lvm:base-$1-disk-$2/vm-${newid}-disk-$2`);
        // A clone's NIC gets a MAC of its own.
        if (config.net0) config.net0 = config.net0.replace(/=[0-9A-F:]{17}/, `=BC:24:11:${String(newid).padStart(6, "0").replace(/(..)(?!$)/g, "$1:")}`);
      } else {
        name = config.hostname = params.hostname ?? `CT${newid}`;
        // A full clone is a copy, on the storage asked for.
        const size = /size=([^,]+)/.exec(source.config.rootfs ?? "")?.[1] ?? "8G";
        config.rootfs = params.full === "1" ? `${params.storage ?? "local-lvm"}:vm-${newid}-disk-0,size=${size}` : `local-lvm:base-${source.vmid}-disk-0/vm-${newid}-disk-0,size=${size}`;
      }
      if (params.description) config.description = params.description;
      this.guests.set(newid, {
        vmid: newid,
        ...(type === "qemu" ? { type: "qemu" as const } : {}),
        name,
        pool: params.pool,
        status: "stopped",
        template: false,
        config,
      });
      return ok(this.#task(type === "qemu" ? "qmclone" : "vzclone", source.vmid));
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/config$/.exec(path))) {
      const vmid = Number(match[2]);
      const guest = this.#of(match[1]!, vmid);
      if (!guest) return this.#missing(vmid, match[1]);
      if (method === "GET") return ok({ ...guest.config });
      if (method === "PUT") {
        // Deleting `vmstate` discards a suspended VM's state, and so its lock.
        if (match[1] === "qemu" && guest.config.lock && !params.delete?.split(",").includes("vmstate")) {
          return respond(500, `VM is locked (${guest.config.lock})`, { data: null });
        }
        // A disk given as <storage>:<GiB> is a new volume, as Proxmox allocates one.
        for (const [key, value] of Object.entries(params)) {
          if (key === "delete") continue;
          const fresh = /^efidisk\d$/.test(key) && typeof value === "string" ? /^([^:,]+):\d+(,.*)?$/.exec(value) : null;
          guest.config[key] = fresh ? `${fresh[1]}:vm-${vmid}-disk-${++this.volumes},${(fresh[2] ?? ",").slice(1)}${fresh[2] ? "," : ""}size=4M` : value;
        }
        for (const key of params.delete?.split(",") ?? []) {
          // A disk taken off a VM stays as an unused disk, which goes when it is deleted in turn.
          const disk = /^efidisk\d$/.test(key) ? guest.config[key] : undefined;
          delete guest.config[key];
          if (disk) {
            let n = 0;
            while (guest.config[`unused${n}`] !== undefined) n++;
            guest.config[`unused${n}`] = disk.split(",")[0]!;
          }
        }
        if (params.delete?.split(",").includes("vmstate")) delete guest.config.lock;
        if (params.hostname) guest.name = params.hostname;
        if (params.name) guest.name = params.name;
        return ok(null);
      }
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/resize$/.exec(path)) && method === "PUT") {
      const vmid = Number(match[2]);
      const guest = this.#of(match[1]!, vmid);
      if (!guest) return this.#missing(vmid, match[1]);
      const disk = params.disk ?? "";
      if (!guest.config[disk]) return respond(500, `disk '${disk}' does not exist`, { data: null });
      if (!this.nextTaskExit.has("resize")) guest.config[disk] = guest.config[disk]!.replace(/size=[^,]+/, `size=${params.size}`);
      return ok(this.#task("resize", vmid));
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/template$/.exec(path)) && method === "POST") {
      const [, type = "lxc", id] = match;
      const guest = this.#of(type, Number(id));
      if (!guest) return this.#missing(Number(id), type);
      if (guest.status === "running") return respond(500, `CT ${id} is running`, { data: null });
      if (guest.template) return respond(500, `CT ${id} is already a template`, { data: null });
      guest.template = true;
      guest.config.template = "1";
      // Its disk becomes a base volume, which linked clones name.
      const disk = type === "qemu" ? "scsi0" : "rootfs";
      if (guest.config[disk]) guest.config[disk] = guest.config[disk]!.replace(/\bvm-(\d+)-disk/, "base-$1-disk");
      return ok(null);
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/status\/(shutdown)$/.exec(path)) && method === "POST") {
      const [, type = "lxc", id] = match;
      const guest = this.#of(type, Number(id));
      if (!guest) return this.#missing(Number(id), type);
      guest.status = "stopped";
      return ok(this.#task(type === "qemu" ? "qmshutdown" : "vzshutdown", Number(id)));
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)\/status\/(start|stop|suspend|current)$/.exec(path))) {
      const [, type = "lxc", id, action] = match;
      const vmid = Number(id);
      const guest = this.#of(type, vmid);
      if (!guest) return this.#missing(vmid, type);
      const prefix = type === "qemu" ? "qm" : "vz";
      if (action === "current" && method === "GET") {
        return ok({ vmid, name: guest.name, status: guest.status, uptime: guest.status === "running" ? 5 : 0, ...(guest.config.lock ? { lock: guest.config.lock } : {}) });
      }
      if (method === "POST" && action === "start") {
        if (!this.nextTaskExit.has(`${prefix}start`)) {
          guest.status = "running";
          // A suspended VM resumes.
          delete guest.config.lock;
          delete guest.config.vmstate;
          // ext4 keeps about 2.5% of a disk for itself.
          if (type === "lxc") guest.filesystem = Math.floor((rootDiskGiB(guest.config) ?? 0) * 0.975 * 2 ** 30);
        }
        return ok(this.#task(`${prefix}start`, vmid));
      }
      if (method === "POST" && action === "stop") {
        if (!this.nextTaskExit.has(`${prefix}stop`)) guest.status = "stopped";
        return ok(this.#task(`${prefix}stop`, vmid));
      }
      if (method === "POST" && action === "suspend" && type === "qemu") {
        if (guest.status !== "running") return respond(500, `VM ${vmid} not running`, { data: null });
        if (params.todisk !== "1") return respond(501, "the fake suspends only to disk", { data: null });
        if (!this.nextTaskExit.has("qmsuspend")) {
          guest.status = "stopped";
          guest.config.lock = "suspended";
          guest.config.vmstate = `local-lvm:vm-${vmid}-state-suspend-2026-10-01`;
        }
        return ok(this.#task("qmsuspend", vmid));
      }
    }

    if ((match = /^\/nodes\/[^/]+\/qemu\/(\d+)\/vncproxy$/.exec(path)) && method === "POST") {
      const vmid = Number(match[1]);
      const guest = this.#of("qemu", vmid);
      if (!guest) return this.#missing(vmid, "qemu");
      if (guest.status !== "running") return respond(500, `VM ${vmid} not running`, { data: null });
      const n = this.consoles.length;
      // A ticket has characters a URL must encode.
      const answer = { port: 5900 + n, ticket: `PVEVNC:68F1A2B${n}::c2ln+bmF/0dXJl=`, ...(params["generate-password"] === "1" ? { password: `p4ss~!${n}` } : {}) };
      this.consoles.push({ vmid, ...answer });
      return ok({
        ...answer,
        cert: "-----BEGIN CERTIFICATE-----\nnot the API's\n-----END CERTIFICATE-----\n",
        upid: this.#task("vncproxy", vmid),
        user: FAKE_TOKEN.tokenId,
      });
    }

    if ((match = /^\/nodes\/[^/]+\/(lxc|qemu)\/(\d+)$/.exec(path)) && method === "DELETE") {
      const [, type = "lxc", id] = match;
      const vmid = Number(id);
      const guest = this.#of(type, vmid);
      if (!guest) return this.#missing(vmid, type);
      const what = type === "qemu" ? "VM" : "CT";
      if (guest.status === "running") return respond(500, `${what} ${vmid} is running - destroy failed`, { data: null });
      if (guest.config.protection === "1") return respond(500, `can't remove ${what} ${vmid} - protection mode enabled`, { data: null });
      const task = type === "qemu" ? "qmdestroy" : "vzdestroy";
      if (!this.nextTaskExit.has(task)) this.guests.delete(vmid);
      return ok(this.#task(task, vmid));
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
