import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { test } from "node:test";
import { BoatApi, limitsFrom, reachFrom, sandboxFrom } from "../src/backends/boat/api.ts";
import { BOAT_KEYS, parseBoatPart } from "../src/backends/boat/config.ts";
import { BoatBackend, LABELS, knownHostsLine, ownKeyScript, powerOf, sandboxName, sizeFor } from "../src/backends/boat/backend.ts";
import { ARCHIVE_WITHIN_MS, BoatTemplates, BuildLeftRunning, LEFT_BUILD_WHY, TEMPLATE_FILES, TEMPLATE_ROLE, TRIAL_ROLE, buildWaitWords, failedChecks, guestBuildFrom, guestStep, templateArchive, templateFingerprint, templateName, type Reached, type TemplateDeps, type TemplateRecord } from "../src/backends/boat/templates.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest } from "../src/backends/types.ts";
import { bbReach, isPrivateAddress } from "../src/backends/boat/reach-bb.ts";
import { setupDir } from "../src/backends/setup-dir.ts";
import { FAKE_BOAT_KEY, FakeBoat } from "./fake-boat.ts";
import { FakeBoatGuest, GUEST_TOOLS_HERE, guestScriptsArchive } from "./fake-boat-guest.ts";
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
      const made = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: kind, [LABELS.key]: "fp1" }, name: templateName(kind, "ready"), state: "archived", type: "default" });
      templates[kind] = made.id;
      const record: TemplateRecord = { kind, sandbox: made.id, key: "fp1", builtAt: (options.now ?? Date.now)(), buildMs: 600_000, usedAt: null };
      void storage.set(`template/${kind}`, record);
    }
  }
  return { fake, backend, context, storage, templates };
}

function box(id: string, kind = "linux", size = SMALL): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind, createdAt: Date.parse("2030-01-01T00:00:00Z"), size: { ...size, gpu: "none" } };
}

function hooks() {
  const claims: Guest[] = [];
  const steps: string[] = [];
  const waiting: (string | null)[] = [];
  const recorded: AcquireHooks = { claim: async (guest) => void claims.push(guest), starting: async () => {}, timing: (step) => void steps.push(step), waiting: async (words) => void waiting.push(words) };
  return { claims, steps, waiting, hooks: recorded };
}

const signal = () => new AbortController().signal;
const LABEL_KEYS = { install: LABELS.install, role: LABELS.role, kind: LABELS.kind, key: LABELS.key, template: LABELS.template };

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
  assert.deepEqual(limits.starts, [{ window: "minute", limit: 5, remaining: 4, withWallet: null }]);
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
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle", "display", "restore", "computer use"]);
  assert.ok(guest.facts?.some((fact) => fact.label === "Display"));
  const transports = await backend.transports(guest, "linux-desktop-cpu");
  assert.deepEqual(transports.displays.map((display) => display.protocol), ["rfb", "selkies"]);
});

test("a desktop box checks Cua Driver only once boat has finished restoring the template, when it is made and when it starts again", async () => {
  const { fake, backend } = setup();
  fake.startsRestoreForReads = 3;
  const recorded = hooks();
  const guest = await backend.acquire(box("d1", "linux-desktop-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, recorded.hooks, signal());
  const made = fake.sandboxes.get(String(guest.data?.sandbox))!;
  assert.equal(made.restoringReads, 0, "the acquire waited until boat said the sandbox was restored");
  assert.deepEqual(recorded.steps.slice(-2), ["restore", "computer use"]);
  await backend.stop!(guest);
  const steps: string[] = [];
  await backend.start!(guest, undefined, (step) => void steps.push(step));
  assert.equal(made.restoringReads, 0, "the start waited until boat said the sandbox was restored");
  assert.deepEqual(steps, ["resume", "identity check", "ssh", "settle", "display", "restore", "computer use"]);
});

test("a Linux box without a desktop does not wait for boat's restore", async () => {
  const { fake, backend } = setup();
  fake.startsRestoreForReads = 3;
  const recorded = hooks();
  const guest = await backend.acquire(box("b1"), null, recorded.hooks, signal());
  assert.ok(fake.sandboxes.get(String(guest.data?.sandbox))!.restoringReads > 0);
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle"]);
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
  assert.deepEqual(steps, ["resume", "identity check", "ssh", "settle"]);
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

const GUEST_SKIP = GUEST_TOOLS_HERE ? false : "boat's guest scripts need flock, setsid and base64 here, as boat's Ubuntu has";
const OK_RUN = { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 };
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, done: () => boolean, withinMs = 20_000): Promise<void> {
  const end = Date.now() + withinMs;
  while (!done()) {
    if (Date.now() > end) throw new Error(`${what} did not happen within ${withinMs} ms`);
    await pause(10);
  }
}

type TrialRun = (sandbox: string, script: string) => Promise<Awaited<ReturnType<Reached["run"]>> | null>;

function templateWorld(options: { readonly holdSteps?: boolean; readonly guestReady?: (guest: FakeBoatGuest) => void } = {}) {
  const fake = new FakeBoat();
  const storage = new MemoryStorage();
  const guests = new Map<string, FakeBoatGuest>();
  const logs: string[] = [];
  const trialRuns: { sandbox: string; user: string; script: string }[] = [];
  let trialRun: TrialRun | null = null;
  const guestOf = (sandbox: string): FakeBoatGuest => {
    let guest = guests.get(sandbox);
    if (!guest) {
      guest = new FakeBoatGuest(options.holdSteps ? { holdSteps: true } : {});
      options.guestReady?.(guest);
      guests.set(sandbox, guest);
    }
    return guest;
  };
  const reached = (sandbox: string, user: "user" | "box"): Reached => ({
    run: async (script, runOptions) => {
      if (fake.sandboxes.get(sandbox)?.labels[LABELS.role] === TEMPLATE_ROLE) return guestOf(sandbox).run(script, runOptions);
      trialRuns.push({ sandbox, user, script });
      const answered = await trialRun?.(sandbox, script);
      if (answered) return answered;
      if (script.startsWith("bb-box-check")) return { ...OK_RUN, stdout: "Docker                             ok\n" };
      return OK_RUN;
    },
  });
  const deps = (overrides: Partial<TemplateDeps> = {}): TemplateDeps => ({
    api: new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch, sleep: async () => {} }),
    storage,
    installId: "inst1",
    labelKeys: LABEL_KEYS,
    publicKey: async () => "ssh-ed25519 AAAAkey",
    reach: async (sandbox, user) => reached(sandbox, user),
    forget: async () => {},
    answers: async () => {},
    settled: async () => {},
    restored: async () => {},
    now: Date.now,
    sleep: () => pause(15),
    log: (line) => void logs.push(line),
    fingerprint: () => "fp1",
    setupArchive: async () => guestScriptsArchive(),
    ...overrides,
  });
  const templateSandboxes = () => [...fake.sandboxes.values()].filter((sandbox) => sandbox.labels[LABELS.role] === TEMPLATE_ROLE);
  const creates = () => fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length;
  const forks = () => fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/fork"));
  const dispose = () => {
    for (const guest of guests.values()) guest.dispose();
  };
  return { fake, storage, guests, logs, trialRuns, deps, guestOf, templateSandboxes, creates, forks, dispose, answerTrials: (answer: TrialRun | null) => void (trialRun = answer) };
}

test("with no template, the first box waits for its build and says so; the build's scripts run in order in the guest, and a failed check deletes the build", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld();
  let checkFails = false;
  let finalizedWhenChecked: number | null = null;
  world.answerTrials(async (sandbox, script) => {
    if (!script.startsWith("bb-box-check")) return null;
    finalizedWhenChecked = [...world.guests.values()].reduce((sum, guest) => sum + guest.runs("finalize").length, 0);
    return checkFails ? { ...OK_RUN, stdout: "Docker                             FAIL no daemon\n" } : null;
  });
  const templates = new BoatTemplates(world.deps({ restored: async (sandbox) => void world.trialRuns.push({ sandbox, user: "bb-box", script: "boat restored" }) }));
  try {
    const waiting: (string | null)[] = [];
    const record = await templates.forBox("linux", signal(), async (words) => void waiting.push(words));
    assert.deepEqual(waiting, [buildWaitWords("linux", null), null]);

    const built = world.fake.sandboxes.get(record.sandbox)!;
    assert.equal(built.state, "archived", "a template waits stopped");
    assert.deepEqual(built.labels, { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" });
    assert.equal(built.type, "default");
    assert.equal(built.name, templateName("linux", "ready"), "named a template only once its fork passed the check");

    const guest = world.guests.get(record.sandbox)!;
    assert.deepEqual(guest.runs().map((line) => line.replace(/ \d+ /, " ")), ["customize linux /", "finalize linux /"], "customize, then finalize, both from /, as the box user cannot enter boat's home, where the emulator then fails to start");
    assert.equal(finalizedWhenChecked, 1, "the check runs once the template is finalized");
    assert.match(guest.controlFile("build.env") ?? "", /^BOX_USER=box$/m);
    assert.equal(guest.controlFile("plugin-key.pub"), "ssh-ed25519 AAAAkey\n");
    assert.equal(guest.controlFile("android-sdk-license"), null, "only Android's build accepts the SDK licence");
    assert.equal(guest.stagings().length, 1);

    const check = world.trialRuns.find((each) => each.script.startsWith("bb-box-check-headless"))!;
    assert.notEqual(check.sandbox, record.sandbox, "the check runs in a fork of the template, as a box is");
    assert.equal(check.user, "box", "the check runs as the box user");
    assert.equal(world.fake.sandboxes.get(check.sandbox)?.state, "deleted", "the trial fork goes");
    assert.equal(world.fake.sandboxes.get(check.sandbox)?.labels[LABELS.template], record.sandbox, "the trial is labelled with its template");
    assert.deepEqual(await templates.whyBuild("linux"), null);
    assert.equal((await templates.forBox("linux", signal())).sandbox, record.sandbox, "a second box forks the same template");

    checkFails = true;
    await world.storage.delete("template/linux-desktop-cpu");
    await assert.rejects(templates.build("linux-desktop-cpu", "test"), /failed its check in a fork of it: Docker +FAIL no daemon/);
    const restoredAt = world.trialRuns.findIndex((each) => each.script === "boat restored");
    const cuaAt = world.trialRuns.findIndex((each) => each.script.includes("cua-probe"));
    assert.ok(restoredAt >= 0 && restoredAt < cuaAt, "the desktop's trial fork checks Cua Driver once boat has restored it");
    assert.equal(world.trialRuns.filter((each) => each.script === "boat restored").length, 1, "a Linux template's trial does not wait for it");
    assert.equal([...world.fake.sandboxes.values()].filter((each) => each.labels[LABELS.kind] === "linux-desktop-cpu" && each.state !== "deleted").length, 0);
    assert.ok(await templates.failedBuild("linux-desktop-cpu"), "a real failure is recorded");
    assert.deepEqual(failedChecks("a ok\nb FAIL x\n"), ["b FAIL x"]);
  } finally {
    world.dispose();
  }
});

test("a bb-box that starts while the template's guest scripts run follows that build: no second sandbox and one customize, and the bb-box that stopped leaves it running and records no failure", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld({ holdSteps: true });
  try {
    const first = new BoatTemplates(world.deps());
    const building = first.build("linux", "a box needs it");
    await until("customize starts", () => world.templateSandboxes().length === 1 && world.guestOf(world.templateSandboxes()[0]!.id).runs("customize").length === 1);
    const made = world.templateSandboxes()[0]!;
    const guest = world.guestOf(made.id);

    first.dispose();
    await assert.rejects(building, BuildLeftRunning);
    assert.equal(made.state, "ready", "the build's sandbox is left running for the next bb-box");
    assert.equal(made.name, templateName("linux", "building"));
    assert.equal(await first.failedBuild("linux"), null, "a stop is not a failed build, so the upkeep does not wait hours");

    const second = new BoatTemplates(world.deps());
    assert.deepEqual(await second.due(), [{ kind: "linux", why: LEFT_BUILD_WHY }], "the upkeep follows it at once");
    const following = second.build("linux", LEFT_BUILD_WHY);
    await until("the follower probes the running build", () => guest.ran.filter((run) => run.stdout.startsWith("running=yes")).length >= 2);
    guest.finish("customize", 0);
    guest.finish("finalize", 0);
    const record = await following;

    assert.equal(record.sandbox, made.id);
    assert.equal(world.creates(), 1, "no second sandbox");
    assert.equal(guest.runs("customize").length, 1, "one customize");
    assert.equal(guest.runs("finalize").length, 1);
    assert.equal(guest.stagings().length, 1, "the follower staged nothing");
    assert.equal(made.name, templateName("linux", "ready"));
    assert.ok(world.logs.some((line) => line.includes(`following the linux template build ${made.id}`)));
  } finally {
    world.dispose();
  }
});

test("a box that stops waiting for its template, as bb-box stops and aborts its acquires before its backends, leaves the build going, so the stop is not held up for the build's minutes", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld({ holdSteps: true });
  try {
    const templates = new BoatTemplates(world.deps());
    const acquire = new AbortController();
    const waiting = templates.forBox("linux", acquire.signal);
    await until("customize starts", () => world.templateSandboxes().length === 1 && world.guestOf(world.templateSandboxes()[0]!.id).runs("customize").length === 1);
    const made = world.templateSandboxes()[0]!;

    let ended = false;
    waiting.catch(() => undefined).finally(() => (ended = true));
    acquire.abort(new Error("bb-box is stopping."));
    await until("the box stops waiting", () => ended, 2_000);
    await assert.rejects(waiting, /bb-box is stopping\./);
    assert.equal(templates.building("linux"), true, "the build goes on");
    assert.equal(made.state, "ready");

    world.guestOf(made.id).finish("customize", 0);
    world.guestOf(made.id).finish("finalize", 0);
    await until("the build ends", () => !templates.building("linux"));
    assert.equal((await templates.record("linux"))?.sandbox, made.id, "and is the template the next box forks");
  } finally {
    world.dispose();
  }
});

test("a reload during the staging: the follower waits on the build's lock rather than stage again, so the one customize is the first bb-box's", { skip: GUEST_SKIP }, async () => {
  let releaseUpload: (() => void) | null = null;
  let uploadsHeld = 0;
  const world = templateWorld({ holdSteps: true, guestReady: (guest) => guest.holdStdin(async (script, stdin) => {
    if (!script.includes("tar -xzf -") || uploadsHeld++ > 0) return stdin;
    await new Promise<void>((resolve) => (releaseUpload = resolve));
    return stdin;
  }) });
  try {
    const first = new BoatTemplates(world.deps());
    const building = first.build("linux", "a box needs it");
    await until("the build's sandbox is made", () => world.templateSandboxes().length === 1);
    const made = world.templateSandboxes()[0]!;
    const guest = world.guestOf(made.id);
    await until("the first bb-box is mid-upload, holding the lock, its log made", () => releaseUpload !== null && existsSync(join(guest.buildDir, "log")));

    first.dispose();
    const second = new BoatTemplates(world.deps());
    const following = second.build("linux", LEFT_BUILD_WHY);
    await until("the follower sees the staging hold the lock", () => guest.ran.filter((run) => run.stdout.startsWith("running=yes")).length >= 3);
    assert.equal(uploadsHeld, 1, "the follower did not stage beside it");

    releaseUpload!();
    await assert.rejects(building, BuildLeftRunning);
    await until("customize starts", () => guest.runs("customize").length === 1);
    guest.finish("customize", 0);
    guest.finish("finalize", 0);
    const record = await following;

    assert.equal(record.sandbox, made.id);
    assert.equal(guest.runs("customize").length, 1, "one customize in the sandbox");
    assert.deepEqual(guest.stagings().map((run) => run.exitCode), [0], "one staging, the first bb-box's");
    assert.equal(world.creates(), 1);
  } finally {
    world.dispose();
  }
});

test("an upload cut off by the reload leaves the build to the next bb-box, which stages it again in the same sandbox, and a stopped bb-box starts no staging of its own", { skip: GUEST_SKIP }, async () => {
  let releaseUpload: (() => void) | null = null;
  let releaseArchive: (() => void) | null = null;
  let uploadsHeld = 0;
  const world = templateWorld({ guestReady: (guest) => guest.holdStdin(async (script, stdin) => {
    if (!script.includes("tar -xzf -") || !Buffer.isBuffer(stdin) || uploadsHeld++ > 0) return stdin;
    await new Promise<void>((resolve) => (releaseUpload = resolve));
    return stdin.subarray(0, 20);
  }) });
  try {
    const first = new BoatTemplates(world.deps({ publicKey: async () => "ssh-ed25519 AAAAfirst" }));
    const building = first.build("linux", "a box needs it");
    await until("the build's sandbox is made", () => world.templateSandboxes().length === 1);
    const made = world.templateSandboxes()[0]!;
    const guest = world.guestOf(made.id);
    await until("the first bb-box is mid-upload", () => releaseUpload !== null);
    first.dispose();
    releaseUpload!();
    await assert.rejects(building, (error: unknown) => error instanceof BuildLeftRunning && /could not unpack bb-box's template scripts/.test(error.message));
    assert.equal(made.state, "ready", "a step that failed as bb-box stopped is not the build failing");
    assert.equal(await first.failedBuild("linux"), null);

    const late = new BoatTemplates(world.deps({ publicKey: async () => "ssh-ed25519 AAAAlate", setupArchive: async () => {
      await new Promise<void>((resolve) => (releaseArchive = resolve));
      return guestScriptsArchive();
    } }));
    const lateBuild = late.build("linux", LEFT_BUILD_WHY);
    await until("a second bb-box reads the archive to stage again", () => releaseArchive !== null);
    late.dispose();
    releaseArchive!();
    await assert.rejects(lateBuild, BuildLeftRunning);
    assert.equal(guest.stagings().length, 1, "a bb-box stopped while it read the archive did not stage");

    const second = new BoatTemplates(world.deps({ publicKey: async () => "ssh-ed25519 AAAAsecond" }));
    const record = await second.build("linux", LEFT_BUILD_WHY);
    assert.equal(record.sandbox, made.id);
    assert.equal(world.creates(), 1);
    assert.equal(guest.runs("customize").length, 1);
    assert.equal(guest.controlFile("plugin-key.pub"), "ssh-ed25519 AAAAsecond\n", "the bb-box that ran on staged it");
  } finally {
    world.dispose();
  }
});

test("a build whose guest scripts died is given up at the next look, not after the build's 110 minutes", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld({ holdSteps: true });
  let killed = false;
  let looksAfterTheKill = 0;
  try {
    const templates = new BoatTemplates(world.deps({ sleep: async () => {
      if (killed && ++looksAfterTheKill > 5) throw new Error("still waiting on a dead build");
      await pause(15);
    } }));
    const building = templates.build("linux", "a box needs it");
    await until("customize starts", () => world.templateSandboxes().length === 1 && world.guestOf(world.templateSandboxes()[0]!.id).runs("customize").length === 1);
    const made = world.templateSandboxes()[0]!;
    await until("the job's PID is recorded", () => world.guestOf(made.id).jobPid() !== null);

    world.guestOf(made.id).killJob();
    killed = true;
    await assert.rejects(building, /stopped without an exit code: no process holds it, so its guest scripts died/);
    assert.ok(looksAfterTheKill <= 2, `${looksAfterTheKill} looks after the kill`);
    assert.equal(made.state, "deleted");
    assert.match((await templates.failedBuild("linux"))?.why ?? "", /guest scripts died/);
  } finally {
    world.dispose();
  }
});

test("a trial fork left by a reload is checked again by the next bb-box, which reuses only a trial of that template", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld();
  let checking: ((answer: Awaited<ReturnType<Reached["run"]>>) => void) | null = null;
  try {
    world.answerTrials(async (_sandbox, script) => (script.startsWith("bb-box-check") && !checking ? new Promise((resolve) => (checking = resolve)) : null));
    const first = new BoatTemplates(world.deps());
    const building = first.build("linux", "a box needs it");
    await until("the check runs in the trial", () => checking !== null);
    const template = world.templateSandboxes()[0]!;
    const trial = [...world.fake.sandboxes.values()].find((sandbox) => sandbox.labels[LABELS.role] === TRIAL_ROLE)!;
    const decoy = world.fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TRIAL_ROLE, [LABELS.kind]: "linux", [LABELS.template]: "bx_another" }, state: "ready", createdAt: Date.now() + 60_000 });
    assert.equal(template.name, templateName("linux", "checking"));

    first.dispose();
    checking!({ ...OK_RUN, exitCode: 255, stderr: "Connection to the trial closed." });
    await assert.rejects(building, BuildLeftRunning);
    assert.equal(trial.state, "ready", "the trial is left for the next bb-box");
    assert.equal(template.state, "archived");
    assert.equal(await first.adoptable("linux"), null, "a template whose check has not passed is not forked");

    const second = new BoatTemplates(world.deps());
    const record = await second.build("linux", LEFT_BUILD_WHY);
    assert.equal(record.sandbox, template.id);
    assert.equal(world.forks().length, 1, "no second trial fork");
    assert.deepEqual(world.trialRuns.filter((run) => run.script.startsWith("bb-box-check")).map((run) => run.sandbox), [trial.id, trial.id]);
    assert.equal(world.trialRuns.some((run) => run.sandbox === decoy.id), false, "a trial of another template is not used");
    assert.equal(decoy.state, "ready");
    assert.equal(trial.state, "deleted");
    assert.equal(template.name, templateName("linux", "ready"));
    assert.equal(world.guestOf(template.id).runs("customize").length, 1);
  } finally {
    world.dispose();
  }
});

test("a failed trial leaves a template another instance recorded, named ready, or is still checking", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld();
  const mode: { current: "record" | "ready" | "trial" } = { current: "record" };
  world.answerTrials(async (sandbox, script) => {
    if (!script.startsWith("bb-box-check")) return null;
    const templateId = world.fake.sandboxes.get(sandbox)?.labels[LABELS.template];
    const template = templateId ? world.fake.sandboxes.get(templateId) : undefined;
    assert.ok(template);
    if (mode.current === "record") await world.storage.set("template/linux", { kind: "linux", sandbox: template.id, key: "fp1", builtAt: Date.now(), buildMs: 1, usedAt: null });
    if (mode.current === "ready") template.name = templateName("linux", "ready");
    if (mode.current === "trial") world.fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TRIAL_ROLE, [LABELS.kind]: "linux", [LABELS.template]: template.id }, state: "ready" });
    return { ...OK_RUN, exitCode: 1, stdout: "services                          FAIL ssh\n" };
  });
  const templates = new BoatTemplates(world.deps());
  try {
    await assert.rejects(templates.build("linux", "test"), /failed its check/);
    const recorded = world.templateSandboxes()[0]!;
    assert.notEqual(recorded.state, "deleted", "a template another instance recorded stays");
    assert.equal((await templates.record("linux"))?.sandbox, recorded.id);

    mode.current = "ready";
    await world.storage.delete("template/linux");
    await assert.rejects(templates.build("linux", "test"), /failed its check/);
    const named = world.templateSandboxes().find((sandbox) => sandbox.name === templateName("linux", "ready"));
    assert.ok(named && named.state !== "deleted", "a template already named ready stays");

    mode.current = "trial";
    await assert.rejects(templates.build("linux", "test"), /failed its check/);
    const held = world.templateSandboxes().filter((sandbox) => sandbox.state !== "deleted" && sandbox.name === templateName("linux", "checking"));
    assert.equal(held.length, 1, "a template another instance is still trialing stays");
    assert.equal([...world.fake.sandboxes.values()].filter((sandbox) => sandbox.labels[LABELS.role] === TRIAL_ROLE && sandbox.state === "ready").length, 1);
  } finally {
    world.dispose();
  }
});

test("a trial retries its check once when the first Docker start cannot start its scope", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld();
  let checks = 0;
  world.answerTrials(async (_sandbox, script) => {
    if (!script.startsWith("bb-box-check")) return null;
    checks += 1;
    if (checks === 1) return { ...OK_RUN, exitCode: 1, stdout: "first docker command                 FAIL unable to start unit docker-abc123.scope\n" };
    return null;
  });
  const templates = new BoatTemplates(world.deps());
  try {
    const record = await templates.build("linux", "test");
    assert.equal(checks, 2);
    assert.equal(world.fake.sandboxes.get(record.sandbox)?.name, templateName("linux", "ready"));
    checks = 0;
    world.answerTrials(async (_sandbox, script) => {
      if (!script.startsWith("bb-box-check")) return null;
      checks += 1;
      return { ...OK_RUN, exitCode: 1, stderr: "unable to start unit docker-def456.scope" };
    });
    await world.storage.delete("template/linux-desktop-cpu");
    await assert.rejects(templates.build("linux-desktop-cpu", "test"), /unable to start unit docker-def456.scope/);
    assert.equal(checks, 2, "one retry, then the failure stands");
  } finally {
    world.dispose();
  }
});

test("a left Android build whose licence was cleared is not due, and following it leaves the sandbox and records no failure", async () => {
  const world = templateWorld();
  try {
    const made = world.fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, name: templateName("android", "building"), state: "ready" });
    const templates = new BoatTemplates(world.deps({ androidLicence: () => null }));
    assert.deepEqual(await templates.due(), []);
    await assert.rejects(templates.build("android", LEFT_BUILD_WHY), (error: unknown) => error instanceof BuildLeftRunning && error.message.includes(made.id) && /licence is not accepted/.test(error.message));
    assert.equal(made.state, "ready");
    assert.equal(await templates.failedBuild("android"), null);
  } finally {
    world.dispose();
  }
});

test("the Android template's build stages the licence's acceptance with the guest scripts, and keeps the devices its build made", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld({ guestReady: (guest) => writeFileSync(join(guest.control, "android-devices.json"), JSON.stringify(ANDROID_DEVICES)) });
  try {
    await assert.rejects(new BoatTemplates(world.deps({ androidLicence: () => null })).build("android", "test"), /licence accepted/);
    world.fake.stopsArchiveForReads = 4;
    const record = await new BoatTemplates(world.deps({ androidLicence: () => "abc123" })).build("android", "test");
    const guest = world.guests.get(record.sandbox)!;
    assert.equal(guest.controlFile("android-sdk-license"), "abc123\n", "the acceptance is there when the guest scripts start");
    assert.deepEqual(record.devices, ANDROID_DEVICES);
    assert.equal(world.fake.sandboxes.get(record.sandbox)?.state, "archived", "the build waited while boat saved the template's disk");
    const trial = [...world.fake.sandboxes.values()].find((each) => each.labels[LABELS.role] === TRIAL_ROLE)!;
    assert.equal(trial.type, "default", "the Android trial runs at the size an Android box will have, not the smallest");
  } finally {
    world.dispose();
  }
});

test("a template build that fails writes the last lines of its log to bb-box's log before its sandbox is deleted, so the cause is not only the last 600 characters", { skip: GUEST_SKIP }, async () => {
  const world = templateWorld({ guestReady: (guest) => {
    writeFileSync(join(guest.control, "customize-says"), "the line that says why\nthe end of the log\n");
    guest.finish("customize", 1);
  } });
  try {
    await assert.rejects(new BoatTemplates(world.deps()).build("linux", "test"), /failed with exit 1: [\s\S]*the line that says why\nthe end of the log/);
    const written = world.logs.find((line) => line.includes("the last 120 lines of its log"));
    assert.match(written ?? "", /which bb-box deletes now:\n[\s\S]*the line that says why\nthe end of the log\n\d\d:\d\d:\d\d  customized$/);
    assert.equal([...world.fake.sandboxes.values()].filter((each) => each.state !== "deleted").length, 0, "the failed build is still deleted");
  } finally {
    world.dispose();
  }
});

test("the upkeep keeps a build and a trial the next bb-box follows, and deletes a build of other scripts, an unfinished one boat stopped, and trials of other templates", async () => {
  const fake = new FakeBoat();
  const long = Date.now() - 11 * 60_000;
  const template = (name: string, state: string, key = "fp1", createdAt = long) => fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: key }, name, state, createdAt });
  const trial = (of: string | null) => fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TRIAL_ROLE, [LABELS.kind]: "linux", ...(of ? { [LABELS.template]: of } : {}) }, state: "ready", createdAt: long });
  const running = template(templateName("linux", "building"), "ready", "fp1", long + 1000);
  const checking = template(templateName("linux", "checking"), "archived");
  const unfinished = template(templateName("linux", "building"), "archived");
  const older = template(templateName("linux", "building"), "ready", "old");
  const ofChecking = trial(checking.id);
  const ofAnother = trial("bx_another");
  const unlabelled = trial(null);
  const templates = new BoatTemplates({
    api: new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch, sleep: async () => {} }),
    storage: new MemoryStorage(),
    installId: "inst1",
    labelKeys: LABEL_KEYS,
    publicKey: async () => "ssh-ed25519 AAAAkey",
    reach: async () => ({ run: async () => OK_RUN }),
    forget: async () => {},
    answers: async () => {},
    settled: async () => {},
    restored: async () => {},
    now: Date.now,
    sleep: async () => {},
    log: () => {},
    fingerprint: () => "fp1",
  });

  assert.equal((await templates.leftBuild("linux"))?.id, running.id, "the newest build left behind is followed");
  await templates.tidy((await new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch }).list({ [LABELS.install]: "inst1" })).filter((sandbox) => [TEMPLATE_ROLE, TRIAL_ROLE].includes(sandbox.labels[LABELS.role] ?? "")));
  assert.equal(running.state, "ready", "a running build of these scripts is followed, not deleted");
  assert.equal(checking.state, "archived", "and a finalized one whose check had not passed");
  assert.equal(ofChecking.state, "ready", "and its trial");
  for (const gone of [unfinished, older, ofAnother, unlabelled]) assert.equal(gone.state, "deleted", gone.name);
  assert.equal(await templates.adoptable("linux"), null, "no box forks a template that is not named ready");
  assert.equal((await templates.due())[0]?.why, LEFT_BUILD_WHY);
});

test("the guest's answers read as the build's step: a code wins, then a process holding the build, and no process means dead once customize started", () => {
  const answer = (fields: Record<string, string>, tail = "12:00:00  customize-base.sh") => `${Object.entries({ running: "no", started: "no", staged: "no", state: "no", customized: "", finalized: "", ...fields }).map(([key, value]) => `${key}=${value}`).join("\n")}\n--\n${tail}\n`;
  const step = (fields: Record<string, string>) => guestStep(guestBuildFrom(answer(fields))!);
  assert.equal(step({}), "unstaged");
  assert.equal(step({ running: "yes", staged: "yes", state: "yes" }), "running", "a staging that holds the lock");
  assert.equal(step({ staged: "yes", state: "yes" }), "unstaged", "a staging that ended before customize started");
  assert.equal(step({ running: "yes", started: "yes", staged: "yes", state: "yes" }), "running");
  assert.equal(step({ started: "yes", staged: "yes", state: "yes" }), "died");
  assert.equal(step({ staged: "yes" }), "died", "a log without the build's state: an older bb-box's build, or a restarted sandbox");
  assert.equal(step({ started: "yes", state: "yes", customized: "0" }), "died", "it died between customize and finalize");
  assert.equal(step({ running: "yes", started: "yes", state: "yes", customized: "2" }), "customize-failed");
  assert.equal(step({ started: "yes", state: "yes", customized: "0", finalized: "1" }), "finalize-failed");
  assert.equal(step({ started: "yes", state: "yes", customized: "0", finalized: "0" }), "finished");
  assert.equal(guestBuildFrom("exit=0\n12:00:00  customized\n"), null, "an answer without the fields is no answer");
  assert.deepEqual(guestBuildFrom(answer({}))?.tail, ["12:00:00  customize-base.sh"]);
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
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, name: templateName("linux", "ready"), state: "archived" });
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
  adoptable.fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, name: templateName("linux", "ready"), state: "archived" });
  adoptable.fake.add({ labels: { other: "x" } });
  assert.equal((await adoptable.backend.capacity("linux", SMALL, [])).ok, true, "a template another install built counts as built");
  const left = setup({ templates: false });
  left.fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, name: templateName("linux", "building"), state: "ready" });
  assert.equal((await left.backend.capacity("linux", SMALL, [])).ok, true, "a build an earlier bb-box left running is the template's sandbox, not one more");
  const built = setup();
  built.fake.add({ labels: { other: "x" } });
  built.fake.add({ labels: { other: "y" } });
  assert.match((await built.backend.capacity("linux", SMALL, [])).message!, /allows 2 sandboxes at once, and 2 are running or starting, 2 of them not bb-box's\. Release or stop a boat box/);
});

test("with no record of its template, as after lost storage or for another install on the account, bb-box forks the newest stopped template its labels match, and gives the box only its own key", async () => {
  const { fake, backend } = setup({ templates: false });
  fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "old" }, state: "archived" });
  const matching = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, name: templateName("linux", "ready"), state: "archived" });
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
  const leftBuild = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "old" }, state: "ready" });
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
  const current = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, name: templateName("linux", "ready"), state: "archived" });
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

const ALL_ANDROID_DEVICES = [
  ...ANDROID_DEVICES,
  { model: "Pixel Fold", native: "pixel_fold", runtime: { platform: "android", api: 36 } },
  { model: "Pixel Tablet", native: "pixel_tablet", runtime: { platform: "android", api: 36 } },
];

test("boat offers each Android device only where the plan's largest size meets that device's least size, and the doctor and box_list say which and why", async () => {
  const { fake, backend, storage } = setup({ config: { androidLicence: true } });
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, name: templateName("android", "ready"), state: "archived", type: "default" });
  await storage.set("template/android", { kind: "android", sandbox: template.id, key: "fp1", builtAt: Date.now(), buildMs: 1, usedAt: null, devices: ALL_ANDROID_DEVICES });
  await backend.maintain(undefined, new Set());
  const offered = backend.kinds().find((kind) => kind.id === "android")?.capabilities.device;
  assert.deepEqual(offered?.devices.map((device) => device.model), ["Pixel 8"], "on the trial's 4 cores and 8 GB, only the phone");
  const detail = (await backend.doctor()).checks.find((check) => check.id === "boat.android")?.detail ?? "";
  assert.match(detail, /^Offered, with the Pixel 8 from the template\./);
  assert.match(detail, /Not offered: the Pixel Fold needs 4 cores and 10 GiB; the Pixel Tablet needs 4 cores and 10 GiB, more than the plan's largest size, 4 cores and 8 GB \(boat's default\), so boat\.dev does not offer them; a paid plan allows boat's large size, 8 cores and 16 GB\./);

  const small = setup({ config: { androidLicence: true } });
  small.fake.sizes = { small: true, default: false, large: false, xlarge: false };
  await small.backend.maintain(undefined, new Set());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(small.fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length, 0, "no Android template is built when no device fits the plan");
  assert.match((await small.backend.withheldKinds("android"))[0]?.why ?? "", /^The Pixel 8 needs 4 cores and 8 GiB; the Pixel Fold needs 4 cores and 10 GiB; the Pixel Tablet needs 4 cores and 10 GiB, more than the plan's largest size, 2 cores and 4 GB \(boat's small\), so boat\.dev does not offer them\. A paid plan allows/);
});

test("an Android box forks the template, and shows its device, not a desktop", async () => {
  const { fake, backend, storage } = setup({ config: { androidLicence: true } });
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, name: templateName("android", "ready"), state: "archived", type: "default" });
  await storage.set("template/android", { kind: "android", sandbox: template.id, key: "fp1", builtAt: Date.now(), buildMs: 1, usedAt: null, devices: ANDROID_DEVICES });
  await backend.maintain(undefined, new Set());
  const android = backend.kinds().find((kind) => kind.id === "android")!;
  assert.deepEqual(android.capabilities.device, { platform: "android", devices: ANDROID_DEVICES });
  assert.deepEqual(android.capabilities.features, ["docker", "kernel", "kvm"]);
  const recorded = hooks();
  fake.startsRestoreForReads = 3;
  const guest = await backend.acquire(box("a1", "android", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, recorded.hooks, signal());
  assert.equal(fake.sandboxes.get(String(guest.data?.sandbox))?.forkedFrom, template.id);
  assert.deepEqual(recorded.steps, ["fork", "ready", "ssh", "settle", "restore"], "no desktop to wait for, but boat's restore, as the device server starts after the acquire and must find the box's own files, not boat's while it restores them");
  assert.equal(fake.sandboxes.get(String(guest.data?.sandbox))?.restoringReads, 0);
  const displays = (await backend.transports(guest, "android")).displays;
  assert.deepEqual(displays.map((display) => [display.id, display.protocol]), [["device", "selkies"]]);
  assert.equal((await backend.capacity("android", { cores: 8, memoryMiB: 16384, diskGiB: null }, [])).ok, false, "the kind's own preset needs a paid plan");
});

test("another install's Android template is forked once its devices are read from its snapshot", async () => {
  const { fake, backend } = setup({ config: { androidLicence: true } });
  const theirs = fake.add({ labels: { [LABELS.install]: "other", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "android", [LABELS.key]: "fp1" }, name: templateName("android", "ready"), state: "archived" });
  theirs.files["usr/share/bb-box/android-devices.json"] = JSON.stringify(ANDROID_DEVICES);
  await backend.maintain(undefined, new Set());
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "android")?.capabilities.device, { platform: "android", devices: ANDROID_DEVICES });
  assert.equal(fake.calls.filter((call) => call.method === "POST" && call.path === "/sandboxes").length, 0, "nothing was built");
});


test("a stop waits while boat saves the sandbox's disk, up to an hour for a template, and says how boat's stop stands when it is still saving", async () => {
  const fake = new FakeBoat();
  let clock = 0;
  const api = new BoatApi({ key: FAKE_BOAT_KEY, fetch: fake.fetch, now: () => clock, sleep: async (ms) => void (clock += ms) });
  const sandbox = fake.add({ labels: {} });
  fake.stopsArchiveForReads = 1000;
  await api.stop(sandbox.id);
  sandbox.archivingReads = Math.round((ARCHIVE_WITHIN_MS * 0.9) / 500);
  assert.equal((await api.waitArchived(sandbox.id, clock + ARCHIVE_WITHIN_MS)).state, "archived");
  assert.ok(clock > 30 * 60_000, "a template's disk can take boat more than half an hour to save");

  const slow = fake.add({ labels: {} });
  await api.stop(slow.id);
  await assert.rejects(api.waitArchived(slow.id, clock + 60_000), /boat's sandbox bx_\w+ is still archiving: boat is still saving its disk\./);

  fake.stopsFailWith = "snapshot upload failed";
  const failing = fake.add({ labels: {} });
  await api.stop(failing.id);
  await assert.rejects(api.waitArchived(failing.id, clock + 60_000), /still archiving: boat's last attempt to save its disk failed, snapshot upload failed, and boat tries again by itself\./);
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

const WAYLAND_ONLY = "proxmox-lxc/template/guest/customize-desktop-wayland.sh";

function filesTheBuildReads(setup: string): string[] {
  const reference = /\$\{?(src|build|here)\}?\/([A-Za-z0-9_./-]+)/g;
  const localInclude = /^#(?:include|import) "([^"]+)"/gm;
  const seen = new Set<string>();
  const todo = ["boat/template.sh"];
  while (todo.length) {
    const file = todo.pop()!;
    if (seen.has(file) || file === WAYLAND_ONLY) continue;
    seen.add(file);
    const text = readFileSync(join(setup, file), "utf8");
    const targets = [
      ...[...text.matchAll(reference)].map(([, from, path]) => join(from === "here" ? dirname(file) : "proxmox-lxc/template", path!.replace(/\.+$/, ""))),
      ...[...text.matchAll(localInclude)].map(([, path]) => join(dirname(file), path!)),
    ].map((target) => normalize(target));
    for (const target of targets) if (existsSync(join(setup, target)) && statSync(join(setup, target)).isFile()) todo.push(target);
  }
  return [...seen].sort();
}

test("boat's template fingerprint and archive are the files its build reads: what boat's template.sh runs, what those scripts read and the headers its C includes, not the Wayland desktop's or Proxmox's own build", async () => {
  assert.deepEqual([...TEMPLATE_FILES].sort(), filesTheBuildReads(setupDir()), "the list follows the scripts; a script that reads another file adds it here");
  const packed = execFileSync("tar", ["-tzf", "-"], { input: await templateArchive(), encoding: "utf8" }).trim().split("\n").filter((line) => !line.endsWith("/")).sort();
  assert.deepEqual(packed, [...TEMPLATE_FILES].sort(), "the build gets exactly these");

  const copy = mkdtempSync(join(tmpdir(), "boat-setup-"));
  try {
    cpSync(setupDir(), copy, { recursive: true });
    const before = templateFingerprint(copy);
    const proxmoxBuild = join(copy, "proxmox-lxc/template/build.sh");
    const original = readFileSync(proxmoxBuild, "utf8");
    assert.ok(original.includes("env PATH=/home/box/.local/bin:/home/box/.cargo/bin:"), "78e74984's line is still in build.sh");
    writeFileSync(proxmoxBuild, original.replace("env PATH=/home/box/.local/bin:/home/box/.cargo/bin:", "env PATH=/home/box/.cargo/bin:"));
    assert.equal(templateFingerprint(copy), before, "78e74984 changed only Proxmox's own build, which boat never runs");
    writeFileSync(join(copy, WAYLAND_ONLY), `${readFileSync(join(copy, WAYLAND_ONLY), "utf8")}\n:\n`);
    assert.equal(templateFingerprint(copy), before, "nor the Wayland desktop, which boat does not build");
    const guest = join(copy, "proxmox-lxc/template/guest/customize-base.sh");
    writeFileSync(guest, `${readFileSync(guest, "utf8")}\n:\n`);
    assert.notEqual(templateFingerprint(copy), before, "a guest script boat runs is part of it");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("a boat box is resized by starting it again on a machine of the new size, as boat.dev resumes a stopped sandbox at another size, and planResize says so first", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(box("r1"), null, hooks().hooks, signal());
  const made = fake.sandboxes.get(String(guest.data?.sandbox))!;
  assert.deepEqual(backend.resizing("linux"), { cores: "restart", memory: "restart", disk: "restart", shrinks: true });
  const bigger = { cores: 4, memoryMiB: 8192, diskGiB: null };
  const plan = await backend.planResize(guest, "linux", bigger, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: 2, to: 4, way: "restart" },
    { part: "memory", from: 4096, to: 8192, way: "restart" },
  ]);
  assert.equal(plan.room.ok, true);
  assert.equal(plan.downSeconds, 60);
  assert.match((await backend.planResize(guest, "linux", { cores: 8, memoryMiB: 16384, diskGiB: null }, [], signal())).room.message ?? "", /large/, "a size the plan does not allow has no room");

  await assert.rejects(backend.resize(guest, "linux", bigger, { restart: false }, signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
  assert.equal(made.type, "small");
  const resized = await backend.resize(guest, "linux", bigger, { restart: true }, signal());
  assert.equal(made.type, "default");
  assert.equal(made.state, "ready", "it runs again");
  assert.deepEqual(resized.size, { cores: 4, memoryMiB: 8192, diskGiB: 51 });
  const resume = fake.calls.filter((call) => call.path.endsWith("/resume")).at(-1);
  assert.equal(resume?.body.type, "default");
  assert.ok(fake.calls.findIndex((call) => call.path.endsWith("/stop")) < fake.calls.lastIndexOf(resume!), "stopped first, as a running sandbox keeps its size");

  made.type = "large";
  made.usedDiskGB = 80;
  const refused = await backend.resize(guest, "linux", bigger, { restart: true }, signal()).catch((error: unknown) => error);
  assert.ok(refused instanceof BackendError && refused.code === "unsupported");
  assert.match((refused as Error).message, /would not fit the smaller disk\. It keeps its size\./);
  assert.equal(made.type, "large");
  assert.equal(made.state, "ready", "started again at its old size");

  made.usedDiskGB = 0;
  await backend.stop!(guest);
  await backend.resize(guest, "linux", { cores: 2, memoryMiB: 4096, diskGiB: null }, { restart: true }, signal());
  assert.equal(made.type, "small");
  assert.equal(made.state, "archived", "a stopped box is stopped again at its new size");
});
