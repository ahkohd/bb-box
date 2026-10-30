import type { BoatFetch } from "../src/backends/boat/api.ts";

export const FAKE_BOAT_KEY = "boat_fakeKEYvalue0123456789";

export interface FakeSandbox {
  id: string;
  name: string;
  state: string;
  type: string;
  labels: Record<string, string>;
  ttlSeconds: number | null;
  archiveAfter: number | null;
  createdAt: number;
  stoppedAt: number | null;
  error: string | null;
  host: string;
  hostKey: string;
  keys: string[];
  forkedFrom: string | null;
  idempotencyKey: string | null;
  files: Record<string, string>;
  restoringReads: number;
  archivingReads: number;
  stopError: string | null;
}

export interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

interface Failure {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  times: number;
}

export class FakeBoat {
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly calls: FakeCall[] = [];
  readonly failures = new Map<string, Failure>();
  key = FAKE_BOAT_KEY;
  tier = "trial";
  activeSandboxes = 2;
  computeUsedSeconds = 600;
  sizes: Record<string, boolean> = { small: true, default: true, large: false, xlarge: false };
  startsLeftThisMinute = 5;
  hostKeysChangeOnResume = true;
  startsRestoreForReads = 0;
  stopsArchiveForReads = 0;
  stopsFailWith: string | null = null;
  #next = 0;
  readonly #now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
  }

  failNext(route: string, status: number, code: string, times = 1, details: Record<string, unknown> = {}): void {
    this.failures.set(route, { status, code, details, times });
  }

  add(partial: Partial<FakeSandbox> & { labels: Record<string, string> }): FakeSandbox {
    const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
    let n = this.#next++;
    let id = "";
    for (let i = 0; i < 8; i++, n = Math.floor(n / alphabet.length)) id = alphabet[n % alphabet.length] + id;
    id = `bx_${id}`;
    const sandbox: FakeSandbox = {
      id,
      name: `Boat ${id}`,
      state: "ready",
      type: "small",
      ttlSeconds: 3600,
      archiveAfter: this.#now() + 3_600_000,
      createdAt: this.#now(),
      stoppedAt: null,
      error: null,
      host: `boat-${id}`,
      hostKey: `ssh-ed25519 AAAA${id}`,
      keys: [],
      forkedFrom: null,
      idempotencyKey: null,
      files: {},
      restoringReads: 0,
      archivingReads: 0,
      stopError: null,
      ...partial,
    };
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  running(): FakeSandbox[] {
    return [...this.sandboxes.values()].filter((sandbox) => ["provisioning", "cloning", "ready", "idle", "running"].includes(sandbox.state));
  }

  #view(sandbox: FakeSandbox): Record<string, unknown> {
    const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
    return {
      id: sandbox.id,
      name: sandbox.name,
      state: sandbox.state,
      error: sandbox.error,
      labels: sandbox.labels,
      type: sandbox.type,
      ip: "2001:db8::1",
      sshEndpoint: `${sandbox.host}:22`,
      createdAt: iso(sandbox.createdAt),
      stoppedAt: iso(sandbox.stoppedAt),
      archiveAfter: iso(sandbox.archiveAfter),
      ttlSeconds: sandbox.ttlSeconds,
      dataExpiredAt: null,
      hydrated: sandbox.restoringReads === 0,
      stop: sandbox.state === "archiving" ? { id: `stop_${sandbox.id}`, status: sandbox.stopError ? "failing" : "pending", error: sandbox.stopError } : null,
      desktopAvailable: true,
      snapshotAvailable: true,
    };
  }

  readonly fetch: BoatFetch = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/api\/v1/, "");
    const body = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(init.headers).map(([key, value]) => [key.toLowerCase(), value]));
    this.calls.push({ method: init.method, path: `${path}${parsed.search}`, body, headers });
    const reply = (status: number, value: Record<string, unknown>) => ({ ok: status < 300, status, text: async () => JSON.stringify(status < 300 ? { ok: true, ...value } : value) });
    const refuse = (status: number, code: string, details: Record<string, unknown> = {}) => reply(status, { ok: false, type: "sandbox.error", status, code, message: code, error: { code, message: code, status, details }, requestId: "req_fake" });
    if (headers.authorization !== `Bearer ${this.key}`) return refuse(401, "unauthorized");
    const parts = path.split("/").filter(Boolean);
    const route = parts[0] === "snapshots" ? `${init.method} /snapshots` : `${init.method} /${parts.map((part, index) => (index === 1 && parts[0] === "sandboxes" ? ":id" : part)).join("/")}`;
    const failure = this.failures.get(route);
    if (failure && failure.times > 0) {
      failure.times -= 1;
      return refuse(failure.status, failure.code, failure.details);
    }
    const sandbox = parts[0] === "sandboxes" && parts[1] ? this.sandboxes.get(parts[1]) : undefined;
    const ttl = (value: unknown) => (typeof value === "number" ? value : value === null ? null : 3600);
    switch (route) {
      case "GET /snapshots": {
        const [, snapshot, what] = parts;
        const owner = this.sandboxes.get(String(snapshot).replace(/^snap-/, ""));
        if (what === "files" && owner) {
          const content = owner.files[(parsed.searchParams.get("path") ?? "").replace(/^\/+/, "")];
          if (content !== undefined) return { ok: true, status: 200, text: async () => content };
        }
        return refuse(404, "not_found");
      }
      case "GET /me":
        return reply(200, { type: "user.info", user: { id: "sandbox_fake" } });
      case "GET /limits":
        return reply(200, {
          accessTier: this.tier,
          currentLimits: { activeSandboxes: this.activeSandboxes },
          starts: { minute: { limit: 5, used: 5 - this.startsLeftThisMinute, remaining: this.startsLeftThisMinute }, hour: { limit: 25, used: 1, remaining: 24 }, day: { limit: 75, used: 1, remaining: 74 } },
          trialComputeUsedSeconds: this.computeUsedSeconds,
          trialComputeCapSeconds: 90_000,
          planIncluded: { vmHoursRemaining: 500, periodEnd: "2030-01-08T00:00:00.000Z" },
          machineTypes: Object.entries(this.sizes).map(([type, available]) => ({ type, available, reason: available ? null : "not during the free trial" })),
        });
      case "GET /sandboxes": {
        const wanted = parsed.searchParams.getAll("label").map((pair) => pair.split("="));
        const found = [...this.sandboxes.values()].filter((each) => each.state !== "deleted" && wanted.every(([key, value]) => each.labels[key!] === value));
        return reply(200, { type: "sandbox.list", sandboxes: found.map((each) => this.#view(each)), pageInfo: { nextCursor: null, hasMore: false, limit: 200 } });
      }
      case "POST /sandboxes": {
        const made = this.add({ labels: (body.labels as Record<string, string>) ?? {}, name: String(body.name ?? ""), type: String(body.type ?? "default"), ttlSeconds: ttl(body.ttlSeconds), state: "provisioning", idempotencyKey: headers["idempotency-key"] ?? null });
        return reply(202, { type: "sandbox.created", status: "provisioning", sandbox: this.#view(made) });
      }
    }
    if (parts[0] === "sandboxes" && (!sandbox || sandbox.state === "deleted")) return refuse(404, "not_found");
    const id = sandbox!;
    switch (route) {
      case "GET /sandboxes/:id/snapshots/latest":
        return reply(200, { type: "snapshot.latest", snapshot: id.state === "archived" ? { id: `snap-${id.id}`, sandboxId: id.id, status: "completed" } : null });
      case "GET /sandboxes/:id": {
        const view = this.#view(id);
        if (id.state === "provisioning") id.state = "ready";
        else if (id.state === "archiving" && !id.stopError && --id.archivingReads <= 0) id.state = "archived";
        else if (id.restoringReads > 0) id.restoringReads--;
        return reply(200, { type: "sandbox.info", sandbox: view });
      }
      case "PATCH /sandboxes/:id":
        if (typeof body.name === "string") id.name = body.name;
        if ("ttlSeconds" in body) {
          id.ttlSeconds = ttl(body.ttlSeconds);
          id.archiveAfter = id.ttlSeconds === null ? null : this.#now() + id.ttlSeconds * 1000;
        }
        return reply(200, { type: "sandbox.info", sandbox: this.#view(id) });
      case "DELETE /sandboxes/:id":
        if (headers["x-ascii-confirm-delete"] !== id.id) return refuse(400, "confirmation_required");
        id.state = "deleted";
        return reply(202, { type: "sandbox.deleting" });
      case "POST /sandboxes/:id/fork": {
        const repeat = [...this.sandboxes.values()].find((each) => each.idempotencyKey !== null && each.idempotencyKey === headers["idempotency-key"]);
        if (repeat) return reply(202, { type: "sandbox.forking", sandbox: this.#view(repeat) });
        const made = this.add({ labels: (body.labels as Record<string, string>) ?? {}, name: `${id.name} fork`, type: String(body.type ?? id.type), ttlSeconds: ttl(body.ttlSeconds), state: "provisioning", forkedFrom: id.id, idempotencyKey: headers["idempotency-key"] ?? null, restoringReads: this.startsRestoreForReads });
        made.archiveAfter = made.ttlSeconds === null ? null : this.#now() + made.ttlSeconds * 1000;
        return reply(202, { type: "sandbox.forking", sandbox: this.#view(made) });
      }
      case "POST /sandboxes/:id/stop":
        id.archivingReads = this.stopsArchiveForReads;
        id.stopError = this.stopsFailWith;
        id.state = id.archivingReads > 0 || id.stopError ? "archiving" : "archived";
        id.stoppedAt = this.#now();
        return reply(202, { type: "sandbox.stopping", status: "archiving" });
      case "POST /sandboxes/:id/resume":
        id.state = "ready";
        id.restoringReads = this.startsRestoreForReads;
        id.stoppedAt = null;
        if ("ttlSeconds" in body) id.ttlSeconds = ttl(body.ttlSeconds);
        id.archiveAfter = id.ttlSeconds === null ? null : this.#now() + id.ttlSeconds * 1000;
        if (this.hostKeysChangeOnResume) id.hostKey = `${id.hostKey}x`;
        return reply(200, { type: "sandbox.resuming", status: "running" });
      case "POST /sandboxes/:id/sshkey":
        if (!["ready", "idle", "running"].includes(id.state)) return refuse(400, "machine_not_running");
        id.keys.push(String(body.key));
        return reply(200, { type: "ssh_key.configured", success: true, machineIp: "2001:db8::1", sshUser: "user", sshEndpoint: `${id.host}:22`, hostKey: id.hostKey });
    }
    return refuse(404, "not_found");
  };
}
