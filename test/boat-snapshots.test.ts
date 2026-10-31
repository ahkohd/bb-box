import assert from "node:assert/strict";
import { test } from "node:test";
import { allowanceFrom, limitsFrom } from "../src/backends/boat/api.ts";
import { BoatBackend, LABELS } from "../src/backends/boat/backend.ts";
import { FORK_NOT_YET, TRIAL_NO_SAVED, parseSavedName, savedName, startCostWords } from "../src/backends/boat/snapshots.ts";
import { TEMPLATE_ROLE, type TemplateRecord } from "../src/backends/boat/templates.ts";
import { SnapshotFailed, SnapshotIncomplete, type AcquireHooks, type BoxIdentity, type CopyHooks, type Guest, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { FAKE_BOAT_KEY, FakeBoat } from "./fake-boat.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG = { key: FAKE_BOAT_KEY, mostBoxes: 3, leaseMinutes: 30, androidLicence: false };
const SMALL = { cores: 2, memoryMiB: 4096, diskGiB: null };
const START = Date.UTC(2026, 9, 31, 10, 0);
const BOX = "bxaaaaaaaaaaaa";
const SNAP = "snbbbbbbbbbbbb";

const RECORDED_PAID_LIMITS = {
  ok: true,
  type: "limits.info",
  accessTier: "standard",
  sandboxPlanKey: "box_20",
  sandboxPlanDollars: 20,
  maxActiveSandboxes: 100,
  startLimits: { perMinute: 12, perHour: 60, perDay: 200 },
  starts: { unlimited: false, minute: { limit: 12, used: 0, remaining: 12 }, hour: { limit: 60, used: 0, remaining: 60 }, day: { limit: 200, used: 30, remaining: 170 } },
  overagePrices: { vmHourDollars: 0.036, savedSnapshotDayDollars: 0.056, startBrackets: [{ aboveMultiple: 1, upToMultiple: 1.5, dollars: 0.03 }, { aboveMultiple: 1.5, upToMultiple: 2, dollars: 0.05 }, { aboveMultiple: 2, upToMultiple: 6, dollars: 0.07 }], startLimitMultiplier: 6, startMinuteLimitMultiplier: 3 },
  nextStartDollars: 0,
  startLimitsWithWallet: { perMinute: 36, perHour: 360, perDay: 1200 },
  planIncluded: { vmHours: 0, vmHoursRemaining: 0, periodEnd: null },
  machineTypes: [
    { type: "small", available: true, reason: null },
    { type: "default", available: true, reason: null },
    { type: "large", available: true, reason: null },
    { type: "xlarge", available: false, reason: "needs the $100/month plan or higher" },
  ],
  canStart: true,
  trialComputeCapSeconds: null,
  trialComputeUsedSeconds: null,
  currentLimits: { activeSandboxes: 100, creationRatePerMinute: 12, creationRequestsPerHour: 60, creationRequestsPerDay: 200 },
  unlimited: false,
};

const RECORDED_SAVED_LIST = {
  ok: true,
  type: "snapshot.saved.list",
  snapshots: [],
  allowance: { org: null, orgName: null, included: 10, free: 10, used: 0, extra: 0, extraMonthlyDollars: 0, extraDailyDollars: 0, pricePerExtraMonthlyDollars: 1.68, pricePerExtraDailyDollars: 0.056 },
};

const RECORDED_TRIAL_LIMITS = {
  accessTier: "trial",
  sandboxPlanKey: "trial",
  currentLimits: { activeSandboxes: 2 },
  starts: { minute: { limit: 5, remaining: 5 }, hour: { limit: 25, remaining: 24 }, day: { limit: 75, remaining: 74 } },
  trialComputeUsedSeconds: 490,
  trialComputeCapSeconds: 90000,
  overagePrices: { savedSnapshotDayDollars: 0.056 },
  nextStartDollars: null,
};

function setup(options: { paid?: boolean } = {}) {
  fakeSsh();
  let clock = START;
  const now = () => clock;
  const fake = new FakeBoat({ now });
  if (options.paid !== false) {
    fake.tier = "standard";
    fake.planKey = "box_20";
    fake.sizes = { small: true, default: true, large: true, xlarge: false };
  } else fake.planKey = "trial";
  const storage = new MemoryStorage();
  const context = testContext(storage, "inst1");
  const backend = disposed(
    new BoatBackend(CONFIG, context, {
      fetch: fake.fetch,
      sshBinary: FAKE_SSH_BINARY,
      sleep: async (ms) => {
        clock += ms;
      },
      now,
      readyTimeoutMs: 20_000,
      busyGivesUpAfterMs: 0,
      ownKeyScript: () => ":",
      settledScript: "true",
      cuaReadyScript: "true",
      kinds: ["linux"],
      templates: { fingerprint: () => "fp1", setupArchive: async () => Buffer.from("") },
    }),
  );
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived", type: "default" });
  const record: TemplateRecord = { kind: "linux", sandbox: template.id, key: "fp1", builtAt: START, buildMs: 600_000, usedAt: null };
  void storage.set("template/linux", record);
  return { fake, backend, tick: (ms: number) => (clock += ms) };
}

function box(id = BOX): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "linux", createdAt: START, size: SMALL };
}

function acquireHooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {}, waiting: async () => {} };
}

function snapshotHooks(): SnapshotHooks & { readonly tasks: TaskRef[]; readonly steps: string[] } {
  const tasks: TaskRef[] = [];
  const steps: string[] = [];
  return {
    tasks,
    steps,
    submitting: async () => void steps.push("submitting"),
    task: async (task) => {
      steps.push("task");
      tasks.push(task);
    },
  };
}

async function boxOn(backend: BoatBackend, id = BOX): Promise<Guest> {
  return backend.acquire(box(id), null, acquireHooks(), new AbortController().signal);
}

test("boat's recorded answers: the paid plan allows saved snapshots at $0.056 a day past the 10 it includes; the trial and an unread plan do not", () => {
  const paid = limitsFrom(RECORDED_PAID_LIMITS);
  assert.equal(paid.tier, "standard");
  assert.equal(paid.planKey, "box_20");
  assert.equal(paid.savedSnapshots, true);
  assert.equal(paid.nextStartDollars, 0);
  assert.equal(paid.savedSnapshotDayDollars, 0.056);
  assert.deepEqual(allowanceFrom(RECORDED_SAVED_LIST.allowance), { included: 10, used: 0, extra: 0, extraDailyDollars: 0, dailyEach: 0.056 });
  const trial = limitsFrom(RECORDED_TRIAL_LIMITS);
  assert.equal(trial.savedSnapshots, false);
  assert.equal(limitsFrom({ ...RECORDED_PAID_LIMITS, accessTier: "standard", sandboxPlanKey: "trial" }).savedSnapshots, false, "the plan key says trial");
  assert.equal(limitsFrom({ sandboxPlanKey: "box_20" }).savedSnapshots, false, "no access tier: bb-box does not assume a plan");
  assert.equal(limitsFrom({ accessTier: "standard" }).savedSnapshots, false, "Astra 8: no plan key");
  assert.equal(limitsFrom({ accessTier: "trial_2", sandboxPlanKey: "box_20" }).savedSnapshots, false, "Astra 8: an unfamiliar tier");
  assert.equal(limitsFrom({ accessTier: "standard", sandboxPlanKey: "starter" }).savedSnapshots, false, "Astra 8: an unfamiliar plan");
  assert.equal(limitsFrom({ accessTier: "standard", sandboxPlanKey: "box_100" }).savedSnapshots, true);
  assert.equal(allowanceFrom({ included: 10 }), null);
});

test("a saved snapshot's name carries the install, the box and the snapshot only, within boat's 63 characters", () => {
  const name = savedName("inst1", BOX, SNAP);
  assert.equal(name, `inst1-${BOX}-${SNAP}`);
  assert.match(name, /^[a-z0-9][a-z0-9-]{0,62}$/);
  assert.deepEqual(parseSavedName(name), { install: "inst1", box: BOX, snapshot: SNAP });
  assert.deepEqual(parseSavedName(savedName("a-b-c", BOX, SNAP)), { install: "a-b-c", box: BOX, snapshot: SNAP });
  assert.ok(savedName("a".repeat(32), BOX, SNAP).length <= 63);
  assert.equal(parseSavedName("my-template"), null);
});

test("on the trial, bb-box offers no restore and no Keep, and refuses a take in plain words before it asks boat to save", async () => {
  const { fake, backend } = setup({ paid: false });
  const guest = await boxOn(backend);
  const plan = await backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, `${TRIAL_NO_SAVED}.`);
  assert.equal(plan.restore.way, "none");
  assert.equal(plan.keep.way, "no");
  const offer = backend.snapshotting("linux")!;
  assert.equal(offer.restore, "none");
  assert.equal(offer.keepsPastRelease, "no");
  assert.equal(offer.price, null);
  const before = fake.calls.length;
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks()), (error: unknown) => error instanceof SnapshotFailed && error.message === `${TRIAL_NO_SAVED}.`);
  assert.ok(!fake.calls.slice(before).some((call) => call.path.startsWith("/saved-snapshots") && call.method === "POST"), "no save was asked for");
  await assert.rejects(backend.adoptSnapshot({ id: SNAP, ref: savedName("inst1", BOX, SNAP), guest }, box(), { macs: {}, smbios: null }, {} as CopyHooks), SnapshotFailed);
});

test("on a paid plan, a take saves the running sandbox under its name, waits until boat says ready, and keeps the capture's time and size", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const plan = await backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.take.ok, true);
  assert.equal(plan.storage.percentFull, 0);
  assert.equal(plan.fork.ok, false);
  assert.equal(plan.fork.why, `${FORK_NOT_YET}.`);
  fake.savesTakeReads = 3;
  const hooks = snapshotHooks();
  const taken = await backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, hooks);
  const name = savedName("inst1", BOX, SNAP);
  assert.deepEqual(hooks.steps, ["submitting", "task"]);
  assert.deepEqual(hooks.tasks, [{ ref: `save:${name}`, host: "boat.dev" }]);
  assert.equal(taken.ref, name);
  assert.equal(taken.holds, "disk");
  assert.equal(taken.capturedAt, fake.saved.get(name)!.capturedAt);
  assert.deepEqual(taken.size, { bytes: 3_200_000_000, means: "own" });
  const save = fake.calls.find((call) => call.method === "POST" && call.path === "/saved-snapshots")!;
  assert.deepEqual(save.body, { sandboxId: (guest.data as { sandbox: string }).sandbox, name });
  assert.deepEqual(await backend.providerTask({ ref: `save:${name}`, host: "boat.dev" }), { state: "ok" });
});

test("a save boat fails is deleted and said; a refused one changes nothing", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  fake.savesFailWith = "disk capture failed";
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks()), (error: unknown) => error instanceof SnapshotFailed && /disk capture failed/.test(error.message));
  assert.equal(fake.saved.size, 0);
  fake.savesFailWith = null;
  fake.failNext("POST /saved-snapshots", 402, "credit_required");
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks()), (error: unknown) => error instanceof SnapshotFailed && /wallet is empty/.test(error.message));
  assert.equal(fake.saved.size, 0);
});

test("the list holds this install's saved snapshots only, with their state, and the bill is boat's own allowance", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  await backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  fake.saved.set("other-template", { ...fake.saved.get(savedName("inst1", BOX, SNAP))!, name: "other-template" });
  fake.saved.set(savedName("inst2", BOX, "sncccccccccccc"), { ...fake.saved.get(savedName("inst1", BOX, SNAP))!, name: savedName("inst2", BOX, "sncccccccccccc") });
  const held = await backend.heldSnapshots();
  assert.equal(held.length, 1);
  assert.equal(held[0]!.id, SNAP);
  assert.equal(held[0]!.box, BOX);
  assert.equal(held[0]!.state, "complete");
  assert.equal(held[0]!.guest.ref, guest.ref);
  assert.deepEqual(await backend.snapshotsOn(guest), held);
  assert.deepEqual(await backend.snapshotBill(), { currency: "USD", included: 10, used: 3, dailyEach: 0.056, refs: [savedName("inst2", BOX, "sncccccccccccc"), "other-template", savedName("inst1", BOX, SNAP)] });
  assert.equal(backend.snapshotting("linux")!.price!.included, 10);
  fake.allowanceShown = false;
  await assert.rejects(backend.snapshotBill(), /no allowance/);
});

test("a delete removes the saved snapshot and confirms it gone; a name not of this install is never deleted", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const taken = await backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const hooks = snapshotHooks();
  await backend.deleteSnapshot({ id: SNAP, ref: taken.ref, guest }, hooks);
  assert.equal(fake.saved.size, 0);
  assert.deepEqual(hooks.tasks, [{ ref: `delete:${taken.ref}`, host: "boat.dev" }]);
  assert.deepEqual(await backend.providerTask({ ref: `delete:${taken.ref}`, host: "boat.dev" }), { state: "ok" });
  await assert.rejects(backend.deleteSnapshot({ id: SNAP, ref: "my-template", guest }, snapshotHooks()), SnapshotFailed);
  await assert.rejects(backend.deleteSnapshot({ id: SNAP, ref: savedName("inst2", BOX, SNAP), guest }, snapshotHooks()), SnapshotFailed);
});

test("a restore's plan deploys the snapshot as one start, says its cost, and refuses when boat allows no more starts", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const taken = await backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const ref = { id: SNAP, ref: taken.ref, guest };
  const plan = await backend.planSnapshots(guest, "linux", ref);
  assert.equal(plan.restore.way, "new-guest");
  assert.equal(plan.restore.undo, "snapshot");
  assert.equal(plan.restore.costWords, "boat.dev counts 2 sandbox starts for this: free within your plan's starts, 5 of 5 left this minute.");
  const limits = limitsFrom({ ...RECORDED_PAID_LIMITS, nextStartDollars: 0.03, starts: { hour: { limit: 60, used: 60, remaining: 0 } } });
  assert.deepEqual(startCostWords(limits), { ok: true, words: "boat.dev counts 2 sandbox starts for this, past your plan's free starts (0 of 60 left this hour): 2 of them are paid from the wallet, about $0.03 each" });
  assert.equal(startCostWords(limitsFrom({ ...RECORDED_PAID_LIMITS, nextStartDollars: null, startLimitsWithWallet: null, starts: { hour: { limit: 60, used: 60, remaining: 0 } } })).ok, false);
  const twoLeft = limitsFrom({ ...RECORDED_PAID_LIMITS, starts: { minute: { limit: 12, used: 10, remaining: 2 } } });
  assert.deepEqual(startCostWords(twoLeft), { ok: true, words: "boat.dev counts 2 sandbox starts for this, past your plan's free starts (2 of 12 left this minute): the start that may put the box back is paid from the wallet, about $0.03 each" }, "Opus 4: with 2 free starts left, the third is not free");
  const twoLeftNoMore = limitsFrom({ ...RECORDED_PAID_LIMITS, nextStartDollars: null, startLimitsWithWallet: null, starts: { minute: { limit: 12, used: 10, remaining: 2 } } });
  assert.deepEqual(startCostWords(twoLeftNoMore), { ok: false, words: "A restore needs 3 of boat.dev's sandbox starts: 2 to make the box's new sandbox, and 1 to start its old one again if that fails. boat.dev allows 12 a minute, with 2 left, and no paid starts beyond them now. Try again when the minute is over" });
  fake.saved.clear();
  const gone = await backend.planSnapshots(guest, "linux", ref);
  assert.equal(gone.restore.way, "none");
  assert.match(gone.restore.why!, /no saved snapshot/);
});

test("a restore's new guest is a copy, with the box's labels and a token of its own, of a sandbox deployed from the saved snapshot, as boat labels no deployed sandbox; the deployed one goes", async () => {
  const { fake, backend } = setup();
  const old = await boxOn(backend);
  const taken = await backend.snapshot(old, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.powerOff(old);
  const claims: Guest[] = [];
  const hooks: CopyHooks = { claimed: async (made) => void claims.push(made), submitting: async () => {}, task: async () => {} };
  const fresh = await backend.adoptSnapshot({ id: SNAP, ref: taken.ref, guest: old }, box(), { macs: {}, smbios: null }, hooks);
  const token = (fresh.data as { guest: string }).guest;
  assert.match(token, /^[a-z2-9]{8}$/);
  assert.equal(fresh.ref, `bbbox-${BOX}-${token}`);
  assert.notEqual(fresh.ref, old.ref);
  assert.equal(claims[0]!.ref, fresh.ref, "the new guest is claimed before boat is asked");
  const staging = (claims[1]!.data as { staging: string }).staging;
  assert.ok(staging, "the deployed sandbox is claimed before it is copied");
  assert.equal((claims.at(-1)!.data as { staging?: string }).staging, undefined);
  const deploy = fake.calls.find((call) => call.method === "POST" && call.path === "/sandboxes" && call.body.from === taken.ref)!;
  assert.equal(deploy.body.name, `bb-box:restoring:${BOX}:${token}`);
  assert.equal(deploy.body.noEnv, true);
  assert.deepEqual(fake.sandboxes.get(staging)!.labels, {}, "boat gives a deployed sandbox no labels");
  assert.equal(fake.sandboxes.get(staging)!.state, "deleted", "the deployed sandbox is deleted once copied");
  const copy = fake.calls.find((call) => call.method === "POST" && call.path === `/sandboxes/${staging}/fork`)!;
  assert.equal((copy.body.labels as Record<string, string>)[LABELS.box], BOX);
  assert.equal((copy.body.labels as Record<string, string>)[LABELS.guest], token);
  assert.equal(copy.headers["idempotency-key"], `bbbox-inst1-${BOX}-${token}`);
  const stops = fake.calls.filter((call) => call.method === "POST" && call.path === `/sandboxes/${staging}/stop`);
  assert.equal(stops.length, 1, "it is stopped before it is copied, so the copy holds all of it");
  await backend.start(fresh);
  assert.equal(await backend.power(fresh), "running");
  assert.equal(await backend.power(old), "stopped");
  const held = await backend.held();
  assert.deepEqual(held.map((each) => each.ref).sort(), [old.ref, fresh.ref].sort());
  await backend.release(old, { resetting: async () => {}, timing: () => {} });
  assert.equal(await backend.power(fresh), "running", "releasing the old guest leaves the new one");
  assert.equal(await backend.power(old), null);
  assert.equal(fake.saved.size, 1, "the saved snapshot outlives its sandbox");
});

test("boat's offer: a paid plan restores by a new guest and prices each saved snapshot past the plan's; forks and Keep wait for boat's identity reset", async () => {
  const { backend } = setup();
  await boxOn(backend);
  const offer = backend.snapshotting("linux")!;
  assert.equal(offer.restore, "new-guest");
  assert.equal(offer.fork, "none");
  assert.equal(offer.lives, "provider");
  assert.equal(offer.forkWhy, FORK_NOT_YET);
  assert.deepEqual(offer.holds, ["disk"]);
  assert.deepEqual(offer.price, { amount: 0.056, currency: "USD", per: "day", known: true });
  assert.equal(backend.snapshotting("android"), null);
});

test("a release of a new guest cut short deletes the sandbox it deployed, and only one that is bb-box's by its name and lack of labels", async () => {
  const { fake, backend } = setup();
  const old = await boxOn(backend);
  const taken = await backend.snapshot(old, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.powerOff(old);
  const claims: Guest[] = [];
  fake.failNext("POST /sandboxes/:id/fork", 400, "bad_request");
  await assert.rejects(backend.adoptSnapshot({ id: SNAP, ref: taken.ref, guest: old }, box(), { macs: {}, smbios: null }, { claimed: async (made) => void claims.push(made), submitting: async () => {}, task: async () => {} }), SnapshotFailed);
  const cut = claims.at(-1)!;
  const staging = (cut.data as { staging: string }).staging;
  assert.equal(fake.sandboxes.get(staging)!.state, "archived");
  await backend.release(cut, { resetting: async () => {}, timing: () => {} });
  assert.equal(fake.sandboxes.get(staging)!.state, "deleted");
  assert.equal(await backend.power(old), "stopped", "the box's own sandbox is left alone");
  const other = fake.add({ labels: {}, name: "someone's sandbox", state: "archived" });
  await backend.release({ ...cut, data: { ...cut.data, staging: other.id } }, { resetting: async () => {}, timing: () => {} });
  assert.equal(fake.sandboxes.get(other.id)!.state, "archived", "a sandbox that is not bb-box's by its name is left, and the release goes on");
});

test("Astra 7: a failed save whose clean-up fails is incomplete, not failed, and a delete by its ID alone finishes it", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const name = savedName("inst1", BOX, SNAP);
  fake.savesFailWith = "disk capture failed";
  fake.failNext(`DELETE /saved-snapshots/${name}`, 503, "out_of_capacity", 50);
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks()), (error: unknown) => error instanceof SnapshotIncomplete && /could not delete what it left/.test(error.message));
  assert.equal(fake.saved.has(name), true, "boat still holds it, so bb-box keeps counting it");
  fake.failures.clear();
  await backend.deleteSnapshot({ id: SNAP, ref: "", guest }, snapshotHooks());
  assert.equal(fake.saved.has(name), false);
});

test("Opus 1 and Astra 3: a deployed sandbox whose create answer was lost is found by its name, from the claimed guest, and deleted", async () => {
  const { fake, backend } = setup();
  const old = await boxOn(backend);
  const taken = await backend.snapshot(old, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.powerOff(old);
  const claims: Guest[] = [];
  fake.lostReplies.add("POST /sandboxes from");
  await assert.rejects(backend.adoptSnapshot({ id: SNAP, ref: taken.ref, guest: old }, box(), { macs: {}, smbios: null }, { claimed: async (made) => void claims.push(made), submitting: async () => {}, task: async () => {} }));
  const staging = [...fake.sandboxes.values()].find((sandbox) => sandbox.name.startsWith("bb-box:restoring:"))!;
  assert.ok(staging, "boat made it though its answer was lost");
  assert.equal((claims[0]!.data as { staging?: string }).staging, undefined, "bb-box never learnt its ID");
  await backend.release(claims[0]!, { resetting: async () => {}, timing: () => {} });
  assert.equal(fake.sandboxes.get(staging.id)!.state, "deleted");
  assert.equal(await backend.power(old), "stopped");
});

test("Opus 2: a deployed sandbox that cannot be deleted once its copy runs the box leaves the restore whole, and bb-box's upkeep deletes it", async () => {
  const { fake, backend } = setup();
  const old = await boxOn(backend);
  const taken = await backend.snapshot(old, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.powerOff(old);
  fake.failNext("DELETE /sandboxes/:id", 503, "out_of_capacity", 1);
  const fresh = await backend.adoptSnapshot({ id: SNAP, ref: taken.ref, guest: old }, box(), { macs: {}, smbios: null }, { claimed: async () => {}, submitting: async () => {}, task: async () => {} });
  const staging = (fresh.data as { staging: string }).staging;
  assert.ok(staging);
  assert.equal(fake.sandboxes.get(staging)!.state, "archived");
  await backend.maintain(undefined, new Set([fresh.ref]));
  assert.equal(fake.sandboxes.get(staging)!.state, "deleted");
  assert.notEqual(fake.sandboxes.get((fresh.data as { sandbox: string }).sandbox)!.state, "deleted");
});

test("R1: a release whose deployed sandbox cannot be deleted stops it, and fails while it may still run, so the old guest never starts beside it", async () => {
  const { fake, backend } = setup();
  const old = await boxOn(backend);
  const taken = await backend.snapshot(old, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.powerOff(old);
  const claims: Guest[] = [];
  fake.lostReplies.add("POST /sandboxes from");
  await assert.rejects(backend.adoptSnapshot({ id: SNAP, ref: taken.ref, guest: old }, box(), { macs: {}, smbios: null }, { claimed: async (made) => void claims.push(made), submitting: async () => {}, task: async () => {} }));
  const staging = [...fake.sandboxes.values()].find((sandbox) => sandbox.name.startsWith("bb-box:restoring:"))!;
  staging.state = "ready";
  fake.failNext("DELETE /sandboxes/:id", 503, "out_of_capacity", 50);
  fake.failNext("POST /sandboxes/:id/stop", 503, "out_of_capacity", 50);
  await assert.rejects(backend.release(claims[0]!, { resetting: async () => {}, timing: () => {} }), /may still run/);
  assert.equal(staging.state, "ready");
  fake.failures.delete("POST /sandboxes/:id/stop");
  await backend.release(claims[0]!, { resetting: async () => {}, timing: () => {} });
  assert.equal(staging.state, "archived", "stopped, so it cannot act as the box; the upkeep deletes it later");
});

test("R4: a restore needs 3 starts available in every window, free or paid by boat's own ceilings; one start left refuses", () => {
  const limited = limitsFrom({ accessTier: "standard", sandboxPlanKey: "box_20", nextStartDollars: 0, starts: { minute: { limit: 12, remaining: 1 }, hour: { limit: 60, remaining: 1 } } });
  assert.equal(startCostWords(limited).ok, false);
  assert.match(startCostWords(limited).words, /A restore needs 3 of boat\.dev's sandbox starts: .* with 1 left, and no paid starts beyond them now\./);
  const paid = limitsFrom({ accessTier: "standard", sandboxPlanKey: "box_20", nextStartDollars: 0, overagePrices: { startBrackets: [{ dollars: 0.03 }] }, starts: { minute: { limit: 12, used: 11, remaining: 1 }, hour: { limit: 60, used: 59, remaining: 1 } }, startLimitsWithWallet: { perMinute: 36, perHour: 360, perDay: 1200 } });
  assert.deepEqual(startCostWords(paid), { ok: true, words: "boat.dev counts 2 sandbox starts for this, past your plan's free starts (1 of 12 left this minute): 1 of them is paid from the wallet, about $0.03 each" });
});
