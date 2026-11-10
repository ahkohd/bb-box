import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { allowanceFrom, limitsFrom } from "../src/backends/boat/api.ts";
import { BoatBackend, IDENTITY_BOOT_SCRIPT, LABELS, LIMITS_KEPT_MS } from "../src/backends/boat/backend.ts";
import { IDENTITY_TOOL } from "../src/core/identity.ts";
import { BOAT_FORK_SAFE_FROM, SAVED_FACTS_KEY, TRIAL_NO_SAVED, forkStartWords, parseSavedName, savedName, startCostWords } from "../src/backends/boat/snapshots.ts";
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

function setup(options: { paid?: boolean; identityBootScript?: string } = {}) {
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
      identityBootScript: options.identityBootScript ?? "echo boot=kept",
      kinds: ["linux"],
      templates: { fingerprint: () => "fp1", setupArchive: async () => Buffer.from("") },
    }),
  );
  const template = fake.add({ labels: { [LABELS.install]: "inst1", [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: "fp1" }, state: "archived", type: "default" });
  const record: TemplateRecord = { kind: "linux", sandbox: template.id, key: "fp1", builtAt: START, buildMs: 600_000, usedAt: null };
  void storage.set("template/linux", record);
  return { fake, backend, storage, tick: (ms: number) => (clock += ms) };
}

function box(id = BOX): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "linux", createdAt: START, size: { ...SMALL, gpu: "none" } };
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
  assert.equal(limitsFrom({ sandboxPlanKey: "box_20" }).savedSnapshots, false, "no access tier: BB Box does not assume a plan");
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

test("on the trial, BB Box offers no restore and no Keep, and refuses a take in plain words before it asks boat to save", async () => {
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
  assert.equal(offer.fork, "none");
  assert.equal(offer.forkWhy, TRIAL_NO_SAVED);
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
  assert.equal(plan.fork.ok, true, "a box forks from a snapshot taken for it");
  assert.equal(plan.fork.why, null);
  assert.deepEqual(plan.fork.size, { cores: 2, memoryMiB: 4096, diskGiB: 51 });
  assert.equal(plan.keep.way, "as-is");
  assert.equal(plan.keep.why, null);
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

test("a boat.dev take saves the running sandbox live: it says it does not pause the box, measures no pause, and lists the saved snapshot's size", async () => {
  const { backend } = setup();
  const guest = await boxOn(backend);

  const plan = await backend.planSnapshots(guest, "linux", null);
  const taken = await backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const held = (await backend.heldSnapshots()).find((each) => each.id === SNAP);

  assert.deepEqual(plan.take.pause, { pauses: false });
  assert.equal(taken.pausedMs, 0);
  assert.deepEqual(held?.size, { bytes: 3_200_000_000, means: "own" });
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
  assert.deepEqual(deploy.body.env, { BBBOX_IDENTITY: BOX }, "the deployed sandbox gets the box's own identity value, so it is no copy to its reset");
  assert.deepEqual(fake.sandboxes.get(staging)!.labels, {}, "boat gives a deployed sandbox no labels");
  assert.equal(fake.sandboxes.get(staging)!.state, "deleted", "the deployed sandbox is deleted once copied");
  const copy = fake.calls.find((call) => call.method === "POST" && call.path === `/sandboxes/${staging}/fork`)!;
  assert.equal((copy.body.labels as Record<string, string>)[LABELS.box], BOX);
  assert.equal((copy.body.labels as Record<string, string>)[LABELS.guest], token);
  assert.equal(copy.headers["idempotency-key"], `bbbox-inst1-${BOX}-${token}`);
  assert.deepEqual(copy.body.env, { BBBOX_IDENTITY: BOX });
  assert.deepEqual(fake.sandboxes.get((fresh.data as { sandbox: string }).sandbox)!.env, { BBBOX_IDENTITY: BOX }, "a same-box swap passes the box's value on, so the new guest keeps the box's identity");
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

test("boat's offer: a paid plan restores by a new guest, forks from version 8 of the identity reset, keeps a snapshot as it is, and prices each saved snapshot past the plan's", async () => {
  const { backend } = setup();
  await boxOn(backend);
  const offer = backend.snapshotting("linux")!;
  assert.equal(offer.restore, "new-guest");
  assert.equal(offer.fork, "copy");
  assert.equal(offer.forkSafeFrom, BOAT_FORK_SAFE_FROM);
  assert.equal(BOAT_FORK_SAFE_FROM, 8);
  assert.equal(offer.keepsPastRelease, "as-is");
  assert.equal(offer.lives, "provider");
  assert.equal(offer.forkWhy, undefined);
  assert.deepEqual(offer.holds, ["disk"]);
  assert.deepEqual(offer.price, { amount: 0.056, currency: "USD", per: "day", known: true });
  assert.equal(backend.snapshotting("android"), null);
});

test("a release of a new guest cut short deletes the sandbox it deployed, and only one that is BB Box's by its name and lack of labels", async () => {
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
  assert.equal(fake.sandboxes.get(other.id)!.state, "archived", "a sandbox that is not BB Box's by its name is left, and the release goes on");
});

test("Astra 7: a failed save whose clean-up fails is incomplete, not failed, and a delete by its ID alone finishes it", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const name = savedName("inst1", BOX, SNAP);
  fake.savesFailWith = "disk capture failed";
  fake.failNext(`DELETE /saved-snapshots/${name}`, 503, "out_of_capacity", 50);
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: BOX, memory: false }, snapshotHooks()), (error: unknown) => error instanceof SnapshotIncomplete && /could not delete what it left/.test(error.message));
  assert.equal(fake.saved.has(name), true, "boat still holds it, so BB Box keeps counting it");
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
  assert.equal((claims[0]!.data as { staging?: string }).staging, undefined, "BB Box never learnt its ID");
  await backend.release(claims[0]!, { resetting: async () => {}, timing: () => {} });
  assert.equal(fake.sandboxes.get(staging.id)!.state, "deleted");
  assert.equal(await backend.power(old), "stopped");
});

test("Opus 2: a deployed sandbox that cannot be deleted once its copy runs the box leaves the restore whole, and BB Box's upkeep deletes it", async () => {
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

const FORK = "bxffffffffffff";

function forkBox(): BoxIdentity {
  return { boxId: FORK, threadId: "thr_2", name: "fork-of-box", kind: "linux", createdAt: START + 60_000, size: { ...SMALL, gpu: "none" } };
}

test("11b: every sandbox BB Box makes for a box carries the box's ID as BBBOX_IDENTITY, from the template's fork on, and a stop and start keeps it", async () => {
  const { fake, backend } = setup();
  const guest = await boxOn(backend);
  const fork = fake.calls.find((call) => call.method === "POST" && call.path.endsWith("/fork"))!;
  assert.deepEqual(fork.body.env, { BBBOX_IDENTITY: BOX });
  assert.equal(fork.body.noEnv, true, "still none of the account's own secrets");
  const sandbox = (guest.data as { sandbox: string }).sandbox;
  assert.deepEqual(fake.sandboxes.get(sandbox)!.env, { BBBOX_IDENTITY: BOX });
  await backend.stop(guest);
  await backend.start(guest);
  const resume = fake.calls.find((call) => call.method === "POST" && call.path === `/sandboxes/${sandbox}/resume`)!;
  assert.equal(resume.body.env, undefined, "a resume never replaces it");
  assert.deepEqual(fake.sandboxes.get(sandbox)!.env, { BBBOX_IDENTITY: BOX });
  assert.equal(backend.identitySource("linux"), "value");
  assert.deepEqual(await backend.guestIdentity(guest), { macs: {}, smbios: null, value: BOX }, "boat's MAC addresses are boat's, never compared; the value is the box's ID");
});

test("11b: a fork deploys the saved snapshot with the fork's own ID as its value, copies it with the fork's labels, and deletes the deployed sandbox; its source is left as it was", async () => {
  const { fake, backend } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const claims: Guest[] = [];
  const hooks: AcquireHooks = { ...acquireHooks(), claim: async (guest) => void claims.push(guest) };
  const made = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), null, hooks, new AbortController().signal);
  const token = (made.data as { guest: string }).guest;
  assert.equal(made.ref, `bbbox-${FORK}-${token}`);
  assert.equal(claims[0]!.ref, made.ref, "claimed before boat is asked");
  const staging = (claims[1]!.data as { staging: string }).staging;
  const deploy = fake.calls.find((call) => call.method === "POST" && call.path === "/sandboxes" && call.body.from === taken.ref)!;
  assert.deepEqual(deploy.body.env, { BBBOX_IDENTITY: FORK }, "the fork's value is not its source's, so its first boot resets it");
  assert.equal(deploy.body.name, `bb-box:restoring:${FORK}:${token}`);
  assert.equal(fake.sandboxes.get(staging)!.state, "deleted");
  const copied = fake.sandboxes.get((made.data as { sandbox: string }).sandbox)!;
  assert.equal(copied.labels[LABELS.box], FORK);
  assert.equal(copied.labels[LABELS.thread], "thr_2");
  assert.deepEqual(copied.env, { BBBOX_IDENTITY: FORK });
  const sourceSandbox = fake.sandboxes.get((source.data as { sandbox: string }).sandbox)!;
  assert.deepEqual(sourceSandbox.env, { BBBOX_IDENTITY: BOX });
  assert.equal(await backend.power(source), "running");
  assert.equal(fake.saved.size, 1, "the snapshot stays");
  const again = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), made, hooks, new AbortController().signal);
  assert.equal(again, made, "a fork asked again after a restart goes on with the sandbox it made");
  const redone = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), { ...made, data: { ...made.data, staging } }, acquireHooks(), new AbortController().signal);
  assert.notEqual(redone.ref, made.ref, "a fork cut short before its copy settled is made again");
  assert.equal(fake.sandboxes.get((made.data as { sandbox: string }).sandbox)!.state, "deleted", "what the first try made goes first, so no two sandboxes act as the fork");
});

test("11b: a kept snapshot outlives its box's sandbox as it is, and forks from boat's list alone", async () => {
  const { fake, backend } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  await backend.release(source, { resetting: async () => {}, timing: () => {} });
  const plan = await backend.planSnapshots(source, "linux", { id: SNAP, ref: taken.ref, guest: source });
  assert.equal(plan.take.ok, false);
  assert.equal(plan.fork.ok, true, "the sandbox is gone, and the saved snapshot still forks");
  assert.deepEqual(plan.fork.size, { cores: 2, memoryMiB: 4096, diskGiB: 51 });
  const made = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), null, acquireHooks(), new AbortController().signal);
  assert.deepEqual(fake.sandboxes.get((made.data as { sandbox: string }).sandbox)!.env, { BBBOX_IDENTITY: FORK });
});

test("11b: a fork needs 2 of boat's starts, said in its plan, and is refused before boat is asked when they are not there", async () => {
  const ok = limitsFrom(RECORDED_PAID_LIMITS);
  assert.deepEqual(forkStartWords(ok), { ok: true, words: "boat.dev counts 2 sandbox starts for this: free within your plan's starts, 12 of 12 left this minute" });
  const none = limitsFrom({ ...RECORDED_PAID_LIMITS, nextStartDollars: null, startLimitsWithWallet: null, starts: { minute: { limit: 12, used: 11, remaining: 1 } } });
  assert.deepEqual(forkStartWords(none), { ok: false, words: "A fork needs 2 of boat.dev's sandbox starts, to make the fork's sandbox from the saved snapshot. boat.dev allows 12 a minute, with 1 left, and no paid starts beyond them now. Try again when the minute is over" });
  const paid = limitsFrom({ ...RECORDED_PAID_LIMITS, starts: { minute: { limit: 12, used: 11, remaining: 1 } } });
  assert.deepEqual(forkStartWords(paid), { ok: true, words: "boat.dev counts 2 sandbox starts for this, past your plan's free starts (1 of 12 left this minute): 1 of them is paid from the wallet, about $0.03 each" });
  const { fake, backend, tick } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  fake.startsLeftThisMinute = 1;
  fake.nextStartDollars = null;
  tick(LIMITS_KEPT_MS + 1);
  const plan = await backend.planSnapshots(source, "linux", { id: SNAP, ref: taken.ref, guest: source });
  assert.equal(plan.fork.ok, false);
  assert.match(plan.fork.why!, /^A fork needs 2 of boat\.dev's sandbox starts/);
});

test("11b: a keep date lives in the backend's own storage, as boat's saved snapshots take no labels; boat's list carries it, and a delete clears it", async () => {
  const { backend, storage } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const ref = { id: SNAP, ref: taken.ref, guest: source };
  await backend.labelKept(ref, "2026-11-30");
  assert.equal((await storage.get<Record<string, { kept: string }>>(SAVED_FACTS_KEY))![taken.ref]!.kept, "2026-11-30");
  const held = await backend.heldSnapshots();
  assert.equal(held[0]!.keptUntil, Date.UTC(2026, 10, 30, 23, 59, 59, 999));
  await backend.labelKept(ref, null);
  assert.equal((await backend.heldSnapshots())[0]!.keptUntil, null);
  await backend.labelKept(ref, "2026-11-30");
  await backend.deleteSnapshot(ref, snapshotHooks());
  assert.deepEqual(await storage.get(SAVED_FACTS_KEY), {}, "a deleted snapshot keeps no record");
  await assert.rejects(backend.labelKept({ id: SNAP, ref: savedName("inst2", BOX, SNAP), guest: source }, "2026-11-30"), SnapshotFailed);
  await assert.rejects(backend.labelKept({ id: SNAP, ref: taken.ref, guest: source }, "2026-11-30"), /no saved snapshot/);
});

test("11b review, Astra 4 and Opus 2: Keep dates go through one queue, so two at once both last; a name is cleared only once boat says it is gone; a list with no array changes nothing", async () => {
  const { fake, backend, storage } = setup();
  const source = await boxOn(backend);
  const first = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const second = await backend.snapshot(source, { id: "sncccccccccccc", box: BOX, memory: false }, snapshotHooks());
  await Promise.all([backend.labelKept({ id: SNAP, ref: first.ref, guest: source }, "2026-11-30"), backend.labelKept({ id: "sncccccccccccc", ref: second.ref, guest: source }, "2026-12-01"), backend.heldSnapshots()]);
  const kept = (await storage.get<Record<string, { kept: string | null }>>(SAVED_FACTS_KEY))!;
  assert.equal(kept[first.ref]!.kept, "2026-11-30");
  assert.equal(kept[second.ref]!.kept, "2026-12-01", "neither write lost the other");
  fake.unlisted.add(second.ref);
  await backend.heldSnapshots();
  assert.equal((await storage.get<Record<string, { kept: string | null }>>(SAVED_FACTS_KEY))![second.ref]!.kept, "2026-12-01", "missing from one list, but boat still has it: the date stays");
  fake.savedListBroken = true;
  await assert.rejects(backend.heldSnapshots(), /held no list, so BB Box changes nothing by it/);
  fake.savedListBroken = false;
  assert.equal(Object.keys((await storage.get<Record<string, unknown>>(SAVED_FACTS_KEY))!).length, 2);
  fake.unlisted.clear();
  fake.saved.delete(second.ref);
  await backend.heldSnapshots();
  assert.deepEqual(Object.keys((await storage.get<Record<string, unknown>>(SAVED_FACTS_KEY))!), [first.ref], "gone, as boat says when asked by its name");
});

test("11b review, Astra 5: what a fork of a kept snapshot needs, the identity reset's version and the box's kind and name, is kept with it, so boat's list gives it back after the release", async () => {
  const { backend } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false, forkSafe: 8 }, snapshotHooks());
  await backend.labelKept({ id: SNAP, ref: taken.ref, guest: source }, "2026-11-30");
  await backend.release(source, { resetting: async () => {}, timing: () => {} });
  const [held] = await backend.heldSnapshots();
  assert.equal(held!.forkSafe, 8);
  assert.equal(held!.owner?.kind, "linux");
  assert.equal(held!.owner?.name, `box-${BOX}`);
  assert.equal(held!.owner?.threadId, "thr_1");
  assert.notEqual(held!.keptUntil, null);
});

test("11b review, Astra 3: upkeep never deletes a fork's staging sandbox while the fork is being made, though the fork's guest is on the box's record already", async () => {
  const { fake, backend } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  let swept = false;
  const hooks: AcquireHooks = {
    ...acquireHooks(),
    claim: async (guest) => {
      const staging = (guest.data as { staging?: string; sandbox?: string }).staging;
      if (!staging || (guest.data as { sandbox?: string }).sandbox || swept) return;
      swept = true;
      await backend.maintain(undefined, new Set([guest.ref]));
      assert.notEqual(fake.sandboxes.get(staging)!.state, "deleted", "the staging sandbox is still in use");
    },
  };
  const made = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), null, hooks, new AbortController().signal);
  assert.ok(swept);
  assert.equal(await backend.power(made), "running");
});

test("11b review, Astra 2 and Opus 5: a fork starts only as far as its identity check, as boat's user: no box user's SSH and no tailnet until core arms it, and a fork with no marker is never counted as decided", async () => {
  const { backend } = setup();
  const source = await boxOn(backend);
  const taken = await backend.snapshot(source, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const made = await backend.forkSnapshot({ id: SNAP, ref: taken.ref, guest: source }, forkBox(), null, acquireHooks(), new AbortController().signal);
  const host = `boat-${(made.data as { sandbox: string }).sandbox}`;
  await backend.startForForkCheck(made, new AbortController().signal);
  const check = await backend.forkCheckCommand(made);
  await check.run("true", { timeoutMs: 5000 });
  const before = readSshLog().filter((entry) => entry.target.endsWith(`@${host}`));
  assert.ok(before.length > 0);
  assert.deepEqual([...new Set(before.map((entry) => entry.target))], [`user@${host}`], "only boat's own user, before core's check");
  await backend.armFork(made, "boot");
  assert.ok(readSshLog().some((entry) => entry.target === `box@${host}`), "the box user once armed");
  const unarmed = setup({ identityBootScript: "echo boot=unarmed" });
  const other = await boxOn(unarmed.backend);
  const otherTaken = await unarmed.backend.snapshot(other, { id: SNAP, box: BOX, memory: false }, snapshotHooks());
  const fork = await unarmed.backend.forkSnapshot({ id: SNAP, ref: otherTaken.ref, guest: other }, forkBox(), null, acquireHooks(), new AbortController().signal);
  await assert.rejects(unarmed.backend.startForForkCheck(fork, new AbortController().signal), /a fork, says its identity check is unarmed, with no marker, so it has not shown that it gave up its source's identity/);
});

test("11b: the identity check runs as boat's user before BB Box lets the box user in, is started by BB Box if boat has not started it 10 s on, and a failed one stops the start", async () => {
  const script = 'n=$(cat identity-reads 2>/dev/null || echo 0); echo $((n + 1)) > identity-reads; if [ -e identity-failed ]; then echo boot=failed; elif [ "$n" -ge 60 ]; then echo boot=kept; else echo boot=none; fi';
  const { fake, backend } = setup({ identityBootScript: script });
  const guest = await boxOn(backend);
  const log = readSshLog();
  const host = `boat-${(guest.data as { sandbox: string }).sandbox}`;
  const checks = log.map((entry, at) => ({ entry, at })).filter(({ entry }) => entry.target === `user@${host}` && entry.command.includes("identity-reads"));
  const firstBox = log.findIndex((entry) => entry.target === `box@${host}`);
  assert.ok(checks.length > 40, "it waited while the check had not run");
  assert.ok(firstBox > checks.at(-1)!.at, "the box user is let in only once the check has decided");
  assert.ok(log.some((entry) => entry.target === `user@${host}` && entry.command.includes("start --no-block bb-box-identity-settle.service")), "BB Box started the check itself after 10 s");
  writeFileSync(join(process.env.FAKE_SSH_DIR!, "home", host, "identity-failed"), "");
  await backend.stop(guest);
  await assert.rejects(backend.start(guest), /could not finish its identity reset, so BB Box does not let its box user in/);
  assert.ok(fake.calls.length > 0);
});

test("11b: the identity check says off on an image without the reset, so boxes made before it start as they did", () => {
  const ran = spawnSync("sh", ["-c", IDENTITY_BOOT_SCRIPT.replaceAll(IDENTITY_TOOL, "/nonexistent/bb-box-identity")], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, "boot=off\n");
});

function readSshLog(): { target: string; command: string }[] {
  return readFileSync(join(process.env.FAKE_SSH_DIR!, "log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { target: string; command: string });
}
