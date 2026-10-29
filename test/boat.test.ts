import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatApi, limitsFrom, reachFrom, sandboxFrom } from "../src/backends/boat/api.ts";
import { BOAT_KEYS, parseBoatPart } from "../src/backends/boat/config.ts";
import { BoatBackend, LABELS, knownHostsLine, ownKeyScript, powerOf, sandboxName, sizeFor } from "../src/backends/boat/backend.ts";
import { BoatTemplates, TEMPLATE_ROLE, buildWaitWords, failedChecks, type Reached, type TemplateRecord } from "../src/backends/boat/templates.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest } from "../src/backends/types.ts";
import { bbReach, isPrivateAddress } from "../src/backends/boat/reach-bb.ts";
import { FAKE_BOAT_KEY, FakeBoat } from "./fake-boat.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG = { key: FAKE_BOAT_KEY, mostBoxes: 2, leaseMinutes: 30, androidLicence: false };
const SMALL = { cores: 2, memoryMiB: 4096, diskGiB: null };
const NO_BUILDS = async (): Promise<Buffer> => {
  throw new Error("These tests build no template over SSH: the fake ssh runs commands on this machine.");
};

function setup(options: { now?: () => number; config?: Partial<typeof CONFIG>; templates?: boolean } = {}) {
  fakeSsh();
  const fake = new FakeBoat(options.now ? { now: options.now } : {});
  const storage = new MemoryStorage();
  const context = testContext(storage, "inst1");
  const backend = disposed(new BoatBackend({ ...CONFIG, ...options.config }, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, busyGivesUpAfterMs: 0, ownKeyScript: () => ":", settledScript: "true", cuaReadyScript: "true", kinds: ["linux", "linux-desktop-cpu", "android"], templates: { fingerprint: () => "fp1", setupArchive: NO_BUILDS }, ...(options.now ? { now: options.now } : {}) }));
  const templates: Record<string, string> = {};
  if (options.templates !== false) {
    for (const kind of ["linux", "linux-desktop-cpu"] as const) {
      const made = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: kind, [LABELS.key]: "fp1" }, state: "archived", type: "default" });
      templates[kind] = made.id;
      const record: TemplateRecord = { kind, sandbox: made.id, key: "fp1", builtAt: (options.now ?? Date.now)(), buildMs: 600_000, usedAt: null };
      void storage.set(`template/${kind}`, record);
    }
  }
  return { fake, backend, context, storage, templates };
}

function box(id: string, kind = "linux", size = SMALL): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind, createdAt: Date.parse("2030-01-01T00:00:00Z"), size };
}

function hooks() {
  const claims: Guest[] = [];
  const steps: string[] = [];
  const waiting: (string | null)[] = [];
  const recorded: AcquireHooks = { claim: async (guest) => void claims.push(guest), starting: async () => {}, timing: (step) => void steps.push(step), waiting: async (words) => void waiting.push(words) };
  return { claims, steps, waiting, hooks: recorded };
}

const signal = () => new AbortController().signal;

test("a box takes boat's smallest size with its cores, memory and disk, among the sizes the plan allows", () => {
  assert.equal(sizeFor({ cores: 2, memoryMiB: 4096, diskGiB: null })?.size, "small");
  assert.equal(sizeFor({ cores: 3, memoryMiB: 4096, diskGiB: null })?.size, "default");
  assert.equal(sizeFor({ cores: 2, memoryMiB: 4096, diskGiB: 80 })?.size, "large");
  assert.equal(sizeFor({ cores: 8, memoryMiB: 16384, diskGiB: null }, (shape) => shape.size !== "large")?.size, "xlarge");
  assert.equal(sizeFor({ cores: 32, memoryMiB: 4096, diskGiB: null }), null);
});

test("boat's answers read as sandboxes, an SSH reach through the IPv4 forward, and limits", () => {
  const sandbox = sandboxFrom({ id: "bx_23456789", name: "n", state: "archived", labels: { a: "b", n: 1 }, type: "small", createdAt: "2030-01-01T00:00:00Z", archiveAfter: null, hydrated: false });
  assert.deepEqual(sandbox.labels, { a: "b" });
  assert.equal(sandbox.size, "small");
  assert.equal(sandbox.createdAt, Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(powerOf(sandbox), "stopped");
  assert.equal(powerOf({ ...sandbox, state: "cloning" }), "running");
  assert.equal(powerOf({ ...sandbox, state: "error" }), "unknown");
  assert.deepEqual(reachFrom({ machineIp: "2001:db8::1", sshUser: "user", sshEndpoint: "203.0.113.10:22001", hostKey: "ssh-ed25519 AAAA" }), { host: "203.0.113.10", port: 22001, user: "user", hostKey: "ssh-ed25519 AAAA" });
  assert.deepEqual(reachFrom({ machineIp: "203.0.113.11", sshUser: "user", sshEndpoint: null, hostKey: "ssh-ed25519 AAAA" }), { host: "203.0.113.11", port: 22, user: "user", hostKey: "ssh-ed25519 AAAA" });
  assert.equal(knownHostsLine({ host: "203.0.113.10", port: 22001, user: "box", hostKey: "ssh-ed25519 AAAA" }), "[203.0.113.10]:22001 ssh-ed25519 AAAA");
  assert.equal(knownHostsLine({ host: "203.0.113.11", port: 22, user: "box", hostKey: "ssh-ed25519 AAAA" }), "203.0.113.11 ssh-ed25519 AAAA");
  const limits = limitsFrom({ accessTier: "trial", currentLimits: { activeSandboxes: 2 }, starts: { minute: { limit: 5, remaining: 4 } }, trialComputeUsedSeconds: 490, trialComputeCapSeconds: 90000, machineTypes: [{ type: "large", available: false, reason: "not during the free trial" }] });
  assert.equal(limits.activeSandboxes, 2);
  assert.deepEqual(limits.starts, [{ window: "minute", limit: 5, remaining: 4 }]);
  assert.deepEqual(limits.sizes, [{ size: "large", available: false, reason: "not during the free trial" }]);
  assert.equal(limits.computeCapSeconds, 90000);
  assert.equal(limits.savedSnapshots, false);
});

test("the settings need a boat_ key, and an auto-stop within what the trial allows", () => {
  const part = (fields: Record<string, unknown>) => parseBoatPart({ id: "boat", hosts: [], fields: fields as never });
  assert.deepEqual(part({ [BOAT_KEYS.key]: "boat_abc" }), { ok: true, config: { key: "boat_abc", mostBoxes: 2, leaseMinutes: 30, androidLicence: false } });
  assert.equal(part({}).ok, false);
  assert.equal(part({ [BOAT_KEYS.key]: "sk-123" }).ok, false);
  assert.equal(part({ [BOAT_KEYS.key]: "boat_abc", [BOAT_KEYS.leaseMinutes]: 121 }).ok, false);
  assert.equal(part({ [BOAT_KEYS.key]: "boat_abc", [BOAT_KEYS.mostBoxes]: 0 }).ok, false);
});

test("an acquire claims the box before boat makes anything, forks the kind's template with the box's labels, the lease and a key that makes a retry safe, and reaches it as the box user with the host key pinned", async () => {
  const { fake, backend, templates } = setup();
  const recorded = hooks();
  const guest = await backend.acquire(box("b1"), null, recorded.hooks, signal());
  assert.equal(recorded.claims[0]?.data?.sandbox, undefined, "the first claim is made before the sandbox");
  const made = fake.sandboxes.get(String(guest.data?.sandbox))!;
  assert.equal(made.forkedFrom, templates.linux);
  assert.equal(made.type, "small");
  assert.equal(made.ttlSeconds, 30 * 60);
  assert.equal(made.idempotencyKey, "bbbox-inst1-b1");
  assert.deepEqual(made.labels, { [LABELS.install]: "inst1", [LABELS.box]: "b1", [LABELS.thread]: "thr_1", [LABELS.name]: "box-b1", [LABELS.kind]: "linux", [LABELS.created]: String(Date.parse("2030-01-01T00:00:00Z")) });
  assert.equal(made.name, sandboxName(box("b1")));
  assert.equal(fake.calls.find((call) => call.path.endsWith("/fork"))?.body.noEnv, true, "a box never gets the account's secrets");
  assert.equal(fake.calls.find((call) => call.path.endsWith("/fork"))?.body.monitoring, false, "boat keeps no process log of a box, which costs it CPU");
  assert.deepEqual(guest.data, { box: "b1", sandbox: made.id });
  assert.equal(guest.ref, "bbbox-b1");
  assert.deepEqual(guest.size, { cores: 2, memoryMiB: 4096, diskGiB: 51 });
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle"]);
  const transports = await backend.transports(guest, "linux");
  assert.deepEqual(transports.access?.ssh, { host: made.host, port: 22, user: "box", hostKeys: [`${made.host} ${made.hostKey}`] });
  assert.equal(transports.displays.length, 0);
  assert.equal((await transports.command!.run("echo hi", { timeoutMs: 10_000 })).stdout.trim(), "hi");
});

test("a desktop box waits for its display and offers bb-box's VNC and Selkies through SSH", async () => {
  const { backend } = setup();
  const recorded = hooks();
  const guest = await backend.acquire(box("d1", "linux-desktop-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, recorded.hooks, signal());
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle", "display", "computer use"]);
  assert.ok(guest.facts?.some((fact) => fact.label === "Display"));
  const transports = await backend.transports(guest, "linux-desktop-cpu");
  assert.deepEqual(transports.displays.map((display) => display.protocol), ["rfb", "selkies"]);
});

test("boat's busy answers are tried again, then refused as no capacity so another backend can take the box, and the sandbox goes", async () => {
  const { fake, backend } = setup();
  fake.failNext("POST /sandboxes/:id/fork", 503, "out_of_capacity", 1, { retryAfterSeconds: 120 });
  const error = await backend.acquire(box("b1"), null, hooks().hooks, signal()).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof BackendError && error.code === "no_capacity", String(error));
  assert.match((error as Error).message, /no machine free/);
  assert.deepEqual(fake.running(), []);

  fake.failNext("POST /sandboxes/:id/sshkey", 500, "http_500", 99);
  await assert.rejects(backend.acquire(box("b2"), null, hooks().hooks, signal()));
  assert.deepEqual(fake.running(), [], "a box that did not start leaves no sandbox");
});

test("capacity says when bb-box's most boxes, the plan's sandboxes, the starts a minute or the trial's compute are used up, and refuses a size the plan does not allow before asking boat", async () => {
  const { fake, backend } = setup({ config: { mostBoxes: 1 } });
  assert.equal((await backend.capacity("linux", SMALL, [])).ok, true);
  await backend.acquire(box("b1"), null, hooks().hooks, signal());
  const full = await backend.capacity("linux", SMALL, []);
  assert.equal(full.ok, false);
  assert.match(full.message!, /1 of the 1 boat sandboxes/);
  const large = await setup().backend.capacity("linux", { cores: 8, memoryMiB: 16384, diskGiB: null }, []);
  assert.equal(large.ok, false);
  assert.match(large.message!, /large size would hold 8 cores and 16 GiB, but the plan does not allow it now/);
  const out = setup();
  out.fake.computeUsedSeconds = 90_000;
  assert.match((await out.backend.capacity("linux", SMALL, [])).message!, /compute hours are used up/);
  const starts = setup();
  starts.fake.startsLeftThisMinute = 0;
  assert.match((await starts.backend.capacity("linux", SMALL, [])).message!, /5 sandbox starts a minute/);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/fork")).length, 1);
});

test("release deletes the sandbox with boat's confirmation, and again is nothing; power, held and relabel read the sandbox's labels and name", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, signal());
  const id = String(guest.data?.sandbox);
  assert.equal(await backend.power(guest), "running");
  const held = await backend.held();
  assert.equal(held.length, 1, "templates are not boxes");
  assert.deepEqual(held[0]!.owner, { boxId: "b1", threadId: "thr_1", name: "box-b1", kind: "linux", createdAt: Date.parse("2030-01-01T00:00:00Z") });
  await backend.relabel(guest, { ...box("b1"), threadId: "thr_2", name: "kept" }, "thr_1");
  assert.equal((await backend.held())[0]!.owner?.threadId, "thr_2");
  assert.equal((await backend.held())[0]!.owner?.name, "kept");
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(fake.sandboxes.get(id)?.state, "deleted");
  assert.equal(fake.calls.find((call) => call.method === "DELETE")?.headers["x-ascii-confirm-delete"], id);
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(await backend.power(guest), null);
});

test("a sandbox that names another box or install is not this guest", async () => {
  const { fake, backend } = setup();
  const other = fake.add({ labels: { [LABELS.install]: "inst2", [LABELS.box]: "b1" } });
  const guest: Guest = { ref: "bbbox-b1", host: null, address: null, size: null, data: { box: "b1", sandbox: other.id } };
  assert.equal(await backend.power(guest), null);
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(other.state, "ready");
});

test("stop is boat's stop, and start resumes the sandbox and pins its new host key", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, signal());
  const made = fake.sandboxes.get(String(guest.data?.sandbox))!;
  await backend.stop!(guest);
  assert.equal(made.state, "archived");
  assert.equal(await backend.power(guest), "stopped");
  assert.equal(backend.keepsSession(), false);
  assert.match((await backend.stopped(guest))?.reason ?? "", /auto-stop/);
  const steps: string[] = [];
  await backend.start!(guest, undefined, (step) => void steps.push(step));
  assert.deepEqual(steps, ["resume", "ssh", "settle"]);
  assert.equal(made.state, "ready");
  assert.equal(made.ttlSeconds, 30 * 60);
  assert.deepEqual((await backend.transports(guest, "linux")).access?.ssh?.hostKeys, [`${made.host} ${made.hostKey}`]);
  assert.match(made.hostKey, /x$/);
});

test("the upkeep renews the auto-stop of the running boxes bb-box holds, once it is near, and lets a sandbox no record names run out", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const { fake, backend } = setup({ now: () => now });
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, signal());
  const stray = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.box]: "b9", [LABELS.thread]: "thr_9" }, archiveAfter: now + 60_000 });
  const made = fake.sandboxes.get(String(guest.data?.sandbox))!;
  await backend.maintain(undefined, new Set([guest.ref]));
  assert.equal(fake.calls.filter((call) => call.method === "PATCH" && "ttlSeconds" in call.body).length, 0, "30 minutes ahead needs no renewal");
  now += 20 * 60_000;
  await backend.maintain(undefined, new Set([guest.ref]));
  assert.equal(made.archiveAfter, now + 30 * 60_000);
  assert.equal(stray.archiveAfter, Date.parse("2030-01-01T00:01:00Z"));
});

test("with no template, the first box waits for its build and says so; the build's scripts run in order, and a failed check deletes the build", async () => {
  const fake = new FakeBoat();
  const storage = new MemoryStorage();
  const scripts: { sandbox: string; user: string; script: string }[] = [];
  let checkFails = false;
  const reached = (sandbox: string, user: "user" | "box"): Reached => ({
    run: async (script) => {
      scripts.push({ sandbox, user, script });
      const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
      if (script.includes("exit=")) return { ...ok, stdout: "exit=0\n12:00:00  customized\n" };
      if (script.startsWith("bb-box-check")) return checkFails ? { ...ok, stdout: "Docker                             FAIL no daemon\n" } : { ...ok, stdout: "Docker                             ok\n" };
      return ok;
    },
  });
  const templates = new BoatTemplates({
    api: new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch, sleep: async () => {} }),
    storage,
    installId: "inst1",
    labelKeys: { install: LABELS.install, role: LABELS.role, kind: LABELS.kind, key: LABELS.key },
    publicKey: async () => "ssh-ed25519 AAAAkey",
    reach: async (sandbox, user) => reached(sandbox, user),
    forget: async () => {},
    answers: async () => {},
    settled: async () => {},
    now: Date.now,
    sleep: async () => {},
    log: () => {},
    fingerprint: () => "fp1",
    setupArchive: async () => Buffer.from("tar"),
  });
  const waiting: (string | null)[] = [];
  const record = await templates.forBox("linux", signal(), async (words) => void waiting.push(words));
  assert.deepEqual(waiting, [buildWaitWords("linux", null), null]);
  const built = fake.sandboxes.get(record.sandbox)!;
  assert.equal(built.state, "archived", "a template waits stopped");
  assert.deepEqual(built.labels, { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" });
  assert.equal(built.type, "default");
  const customize = scripts.findIndex((each) => each.user === "user" && each.script.includes("template.sh\" customize linux"));
  const check = scripts.findIndex((each) => each.script.startsWith("bb-box-check-headless"));
  const finalize = scripts.findIndex((each) => each.user === "user" && each.script.includes("template.sh finalize linux"));
  assert.ok(customize >= 0 && customize < finalize && finalize < check, "customize, finalize, then the check");
  assert.notEqual(scripts[check]!.sandbox, record.sandbox, "the check runs in a fork of the template, as a box is");
  assert.equal(fake.sandboxes.get(scripts[check]!.sandbox)?.state, "deleted", "the trial fork goes");
  assert.equal(scripts.find((each) => each.script.startsWith("bb-box-check"))?.user, "box", "the check runs as the box user");
  assert.ok(scripts.some((each) => each.script.includes("template.sh finalize linux")));
  assert.deepEqual(await templates.whyBuild("linux"), null);
  assert.equal((await templates.forBox("linux", signal())).sandbox, record.sandbox, "a second box forks the same template");

  checkFails = true;
  await storage.delete("template/linux-desktop-cpu");
  await assert.rejects(templates.build("linux-desktop-cpu", "test"), /failed its check in a fork of it: Docker +FAIL no daemon/);
  assert.equal([...fake.sandboxes.values()].filter((each) => each.labels[LABELS.kind] === "linux-desktop-cpu" && each.state !== "deleted").length, 0);
  assert.deepEqual(failedChecks("a ok\nb FAIL x\n"), ["b FAIL x"]);
});

test("boat offers linux and the CPU desktop, both VMs with KVM, the desktop with bb-box's own VNC, Selkies and Cua Driver", () => {
  fakeSsh();
  const backend = disposed(new BoatBackend(CONFIG, testContext(new MemoryStorage(), "inst1"), { fetch: new FakeBoat().fetch, sshBinary: FAKE_SSH_BINARY, templates: { setupArchive: NO_BUILDS } }));
  assert.deepEqual(backend.kinds().map((kind) => kind.id), ["linux", "linux-desktop-cpu"]);
  assert.deepEqual(backend.kinds()[0]!.capabilities.features, ["docker", "kernel", "kvm"]);
  const desktop = backend.kinds()[1]!.capabilities;
  assert.deepEqual(desktop.displays.map((display) => display.protocol), ["rfb", "selkies"]);
  assert.equal(desktop.computerUse?.version, "0.28.3");
});

test("the doctor says what the plan allows and what the key is missing, in words", async () => {
  const { fake, backend } = setup();
  const report = await backend.doctor();
  assert.equal(report.ok, true);
  assert.match(report.checks.find((check) => check.id === "boat.limits")!.detail, /2 sandboxes at once; starts left: 5 of 5 a minute.*small: 2 cores, 4 GB, 51 GB disk, \$0.018 an hour.*Not allowed: large \(not during the free trial\).*24.8 of its 25 compute hours left/);
  assert.match(report.checks.find((check) => check.id === "boat.templates")!.detail, /linux: bx_\w+, built 0 days ago in 10 minutes/);
  fake.key = "boat_other";
  const refused = await backend.doctor();
  assert.equal(refused.ok, false);
  const api = refused.checks.find((check) => check.id === "boat.api")!;
  assert.match(api.detail, /wrong, has expired or was revoked/);
  assert.match(api.fix ?? "", /Make a new API key/);
});

test("BB's URL on a private network, with no tailnet, is said plainly with its fix, in the doctor and on each box", async () => {
  assert.equal(isPrivateAddress("10.0.0.69"), true);
  assert.equal(isPrivateAddress("100.101.102.103"), true);
  assert.equal(isPrivateAddress("fd7a:115c:a1e0::1"), true);
  assert.equal(isPrivateAddress("203.0.113.10"), false);
  assert.deepEqual(await bbReach("https://bb.example.com", true), { from: "tailnet" });
  assert.deepEqual(await bbReach("https://bb.example.com", false, async () => ["203.0.113.10"]), { from: "url", host: "bb.example.com" });
  assert.deepEqual(await bbReach("https://bb.example.com", false, async () => ["100.101.102.103"]), { from: "nowhere", host: "bb.example.com", why: "bb.example.com points at 100.101.102.103, on a private network" });
  assert.equal((await bbReach("http://10.0.0.5:7777", false)).from, "nowhere");
  assert.deepEqual(await bbReach(null, false), { from: "unknown" });

  fakeSsh();
  const fake = new FakeBoat();
  const context = { ...testContext(new MemoryStorage(), "inst1"), bbUrl: () => "https://bb.example.com" };
  const backend = disposed(new BoatBackend(CONFIG, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, busyGivesUpAfterMs: 0, resolve: async () => ["10.0.0.69"], ownKeyScript: () => ":", settledScript: "true", templates: { fingerprint: () => "fp1", setupArchive: NO_BUILDS } }));
  const check = (await backend.doctor()).checks.find((each) => each.id === "boat.bb")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /cannot reach BB's server: bb.example.com points at 10.0.0.69, on a private network. So boat boxes run commands and copy files, but do not become BB machines/);
  assert.match(check.fix ?? "", /Turn the tailnet on/);
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived" });
  await context.storage.set("template/linux", { kind: "linux", sandbox: template.id, key: "fp1", builtAt: Date.now(), buildMs: 1, usedAt: null });
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, signal());
  assert.match(guest.facts?.find((fact) => fact.label === "BB machine")?.value ?? "", /^No\. boat's sandboxes cannot reach BB's server/);
});

test("on the trial's 2 sandboxes at once, a box whose template must be built first, or one beside sandboxes that are not bb-box's, is refused with why", async () => {
  const none = setup({ templates: false });
  none.fake.add({ labels: { other: "x" } });
  const refused = await none.backend.capacity("linux", SMALL, []);
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /boat's free trial allows 2 sandboxes at once, and 1 is running or starting, 1 of them not bb-box's. This box's template must be built first, in a sandbox of its own: building boat's Linux template first/);
  const adoptable = setup({ templates: false });
  adoptable.fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived" });
  adoptable.fake.add({ labels: { other: "x" } });
  assert.equal((await adoptable.backend.capacity("linux", SMALL, [])).ok, true, "a template another install built counts as built");
  const built = setup();
  built.fake.add({ labels: { other: "x" } });
  built.fake.add({ labels: { other: "y" } });
  assert.match((await built.backend.capacity("linux", SMALL, [])).message!, /allows 2 sandboxes at once, and 2 are running or starting, 2 of them not bb-box's\. Release or stop a boat box/);
});

test("with no record of its template, as after lost storage or for another install on the account, bb-box forks the newest stopped template its labels match, and gives the box only its own key", async () => {
  const { fake, backend } = setup({ templates: false });
  fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "old" }, state: "archived" });
  const matching = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived" });
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, signal());
  assert.equal(fake.sandboxes.get(String(guest.data?.sandbox))?.forkedFrom, matching.id);
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length, 0, "nothing was built");
  const script = ownKeyScript("ssh-ed25519 AAAAmine bb-box");
  assert.match(script, /printf '%s\\n' 'ssh-ed25519 AAAAmine bb-box' \| sudo -n tee "\$home\/.ssh\/authorized_keys"/);
  assert.doesNotMatch(script, /tee -a/, "the template builder's key is replaced, not kept");
});

test("the upkeep keeps the newest stopped template of the current scripts, even with no record of it, and deletes old ones and builds nothing follows", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const { fake, backend, storage, templates } = setup({ now: () => now });
  await storage.delete("template/linux");
  const old = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "old" }, state: "archived" });
  const leftBuild = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "ready" });
  now += 11 * 60_000;
  await backend.maintain(undefined, new Set());
  assert.equal(fake.sandboxes.get(templates.linux!)?.state, "archived", "the current scripts' template stays, though no record names it");
  assert.equal(fake.sandboxes.get(templates["linux-desktop-cpu"]!)?.state, "archived");
  assert.equal(old.state, "deleted");
  assert.equal(leftBuild.state, "deleted");
});

test("the upkeep forks a template of the current scripts that the account already has rather than build one, and builds one template at a time", async () => {
  const { fake, backend, storage, templates } = setup();
  await storage.set("template/linux", { kind: "linux", sandbox: templates.linux, key: "old", builtAt: Date.now(), buildMs: 1, usedAt: null });
  await storage.set("template/linux-desktop-cpu", { kind: "linux-desktop-cpu", sandbox: templates["linux-desktop-cpu"], key: "old", builtAt: Date.now(), buildMs: 1, usedAt: null });
  const current = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived" });
  fake.sandboxes.get(templates["linux-desktop-cpu"]!)!.labels[LABELS.key] = "old";
  fake.sandboxes.get(templates.linux!)!.labels[LABELS.key] = "old";
  fake.failNext("POST /sandboxes", 503, "out_of_capacity", 5);
  await backend.maintain(undefined, new Set());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await storage.get<TemplateRecord>("template/linux"))?.sandbox, current.id, "the account's current template is forked from now on");
  const builds = fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes");
  assert.equal(builds.length, 1, "only the desktop's template is built, and only one at a time");
  assert.equal((builds[0]!.body.labels as Record<string, string>)[LABELS.kind], "linux-desktop-cpu");
});

const ANDROID_DEVICES = [{ model: "Pixel 8", native: "pixel_8", runtime: { platform: "android", api: 36 } }];

test("android is offered only once the Android SDK's licence is accepted and a template lists its devices; until then box_list and the doctor say why", async () => {
  const off = setup();
  assert.deepEqual(off.backend.kinds().map((kind) => kind.id), ["linux", "linux-desktop-cpu"]);
  assert.match((await off.backend.withheldKinds("android"))[0]?.why ?? "", /licence is not accepted/);
  assert.match((await off.backend.doctor()).checks.find((check) => check.id === "boat.android")?.detail ?? "", /^Off/);

  const on = setup({ config: { androidLicence: true } });
  assert.match((await on.backend.withheldKinds("android"))[0]?.why ?? "", /no Android template yet/);
  on.fake.failNext("POST /sandboxes", 503, "out_of_capacity", 5);
  await on.backend.maintain(undefined, new Set());
  await new Promise((resolve) => setTimeout(resolve, 50));
  const build = on.fake.calls.find((call) => call.method === "POST" && call.path === "/sandboxes");
  assert.equal((build?.body.labels as Record<string, string>)[LABELS.kind], "android", "the upkeep builds the Android template, as no box can ask for a kind not offered");
  assert.equal(build?.body.type, "default", "at the largest size the trial allows");
  assert.match((await on.backend.doctor()).checks.find((check) => check.id === "boat.android")?.detail ?? "", /at most 4 cores and 8 GB \(boat's default\), less than the kind's presets: ask for cores 4 and memory_gib 8/);
});

test("an Android box forks the template, and shows its device, not a desktop", async () => {
  const { fake, backend, storage } = setup({ config: { androidLicence: true } });
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, state: "archived", type: "default" });
  await storage.set("template/android", { kind: "android", sandbox: template.id, key: "fp1", builtAt: Date.now(), buildMs: 1, usedAt: null, devices: ANDROID_DEVICES });
  await backend.maintain(undefined, new Set());
  const android = backend.kinds().find((kind) => kind.id === "android")!;
  assert.deepEqual(android.capabilities.device, { platform: "android", devices: ANDROID_DEVICES });
  assert.deepEqual(android.capabilities.features, ["docker", "kernel", "kvm"]);
  const recorded = hooks();
  const guest = await backend.acquire(box("a1", "android", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, recorded.hooks, signal());
  assert.equal(fake.sandboxes.get(String(guest.data?.sandbox))?.forkedFrom, template.id);
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle"], "no desktop to wait for");
  const displays = (await backend.transports(guest, "android")).displays;
  assert.deepEqual(displays.map((display) => [display.id, display.protocol]), [["device", "selkies"]]);
  assert.equal((await backend.capacity("android", { cores: 8, memoryMiB: 16384, diskGiB: null }, [])).ok, false, "the kind's own preset needs a paid plan");
});

test("another install's Android template is forked once its devices are read from its snapshot", async () => {
  const { fake, backend } = setup({ config: { androidLicence: true } });
  const theirs = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, state: "archived" });
  theirs.files["usr/share/bb-box/android-devices.json"] = JSON.stringify(ANDROID_DEVICES);
  await backend.maintain(undefined, new Set());
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "android")?.capabilities.device, { platform: "android", devices: ANDROID_DEVICES });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length, 0, "nothing was built");
});


test("the Android template's build writes the licence's acceptance before the guest scripts, and keeps the devices its build made", async () => {
  const fake = new FakeBoat();
  const scripts: { script: string; stdin: string }[] = [];
  const reached = (): Reached => ({
    run: async (script, options) => {
      scripts.push({ script, stdin: String(options.stdin ?? "") });
      const ok = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
      if (script.includes("exit=")) return { ...ok, stdout: "exit=0\n" };
      if (script.startsWith("cat /usr/share/bb-box/android-devices.json")) return { ...ok, stdout: JSON.stringify(ANDROID_DEVICES) };
      return ok;
    },
  });
  const deps = {
    api: new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch, sleep: async () => {} }),
    storage: new MemoryStorage(),
    installId: "inst1",
    labelKeys: { install: LABELS.install, role: LABELS.role, kind: LABELS.kind, key: LABELS.key },
    publicKey: async () => "ssh-ed25519 AAAAkey",
    reach: async () => reached(),
    forget: async () => {},
    answers: async () => {},
    settled: async () => {},
    now: Date.now,
    sleep: async () => {},
    log: () => {},
    fingerprint: () => "fp1",
    setupArchive: async () => Buffer.from("tar"),
  };
  await assert.rejects(new BoatTemplates({ ...deps, androidLicence: () => null }).build("android", "test"), /licence accepted/);
  const record = await new BoatTemplates({ ...deps, androidLicence: () => "abc123" }).build("android", "test");
  const licence = scripts.findIndex((each) => each.script.includes("android-sdk-license"));
  const customize = scripts.findIndex((each) => each.script.includes("customize android"));
  assert.ok(licence >= 0 && licence < customize, "the acceptance is written before the guest scripts run");
  assert.equal(scripts[licence]!.stdin, "abc123\n");
  assert.deepEqual(record.devices, ANDROID_DEVICES);
});

test("a template build that failed is not tried again by the upkeep for hours, and the doctor says why", async () => {
  const { fake, backend, storage, templates } = setup();
  await storage.set("template/linux", { kind: "linux", sandbox: templates.linux, key: "old", builtAt: Date.now(), buildMs: 1, usedAt: null });
  fake.failNext("POST /sandboxes", 503, "out_of_capacity", 1);
  await backend.maintain(undefined, new Set());
  await new Promise((resolve) => setTimeout(resolve, 50));
  await backend.maintain(undefined, new Set());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length, 1, "one try, not one every upkeep");
  const check = (await backend.doctor()).checks.find((each) => each.id === "boat.templates")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /linux's last build failed at \d\d:\d\d UTC, and is tried again 6 hours later or when a box needs it: boat has no machine free/);
});
