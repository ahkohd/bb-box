import assert from "node:assert/strict";
import { test } from "node:test";
import { BoatBackend, LABELS, stagingName } from "../src/backends/boat/backend.ts";
import { BoatOwner, LONGEST_BOAT_BACKEND_NAME } from "../src/backends/boat/owner.ts";
import { savedName } from "../src/backends/boat/snapshots.ts";
import { TEMPLATE_ROLE, templateName, type TemplateRecord } from "../src/backends/boat/templates.ts";
import { BackendError, SnapshotFailed, type AcquireHooks, type BoxIdentity, type CopyHooks, type Guest, type SnapshotHooks } from "../src/backends/types.ts";
import { LONGEST_INSTALL_ID } from "../src/core/install.ts";
import { Tailnet } from "../src/core/tailnet.ts";
import { providerName } from "../src/core/provider-name.ts";
import { ImageJobs } from "../src/plugin/images.ts";
import { ownImageLines } from "../src/plugin/views.ts";
import { FAKE_BOAT_KEY, FakeBoat, type FakeSandbox } from "./fake-boat.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, tempDir, testContext } from "./helpers.ts";
import { hostCommandsRecorded, recordingStandInsForHostTools, withHostToolsFirstOnPath } from "./host-stubs.mjs";

const disposed = disposedOnceTheFileEnds();
const CONFIG = { key: FAKE_BOAT_KEY, mostBoxes: 3, leaseMinutes: 30, androidLicence: false };
const FIRST = "boat";
const TEAM_B = "boat:team-b";
const START = Date.UTC(2030, 0, 1, 10, 0);
const HOUR = 3_600_000;
const BOX_A = "bxaaaaaaaaaaaa";
const BOX_B = "bxbbbbbbbbbbbb";
const BOX_C = "bxcccccccccccc";
const SNAP_A = "snaaaaaaaaaaaa";
const SNAP_B = "snbbbbbbbbbbbb";
const SMALL = { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "none" as const };
const RELEASE = { resetting: async () => {}, timing: () => {} };
const LEGACY_LABELS = { [LABELS.install]: "inst1" };

interface Account {
  readonly fake: FakeBoat;
  readonly now: () => number;
  tick(ms: number): void;
}

interface BackendOptions {
  readonly config?: Partial<typeof CONFIG>;
  readonly storage?: MemoryStorage;
  readonly tailnet?: Tailnet;
  readonly templateLabels?: Record<string, string> | null;
  readonly logs?: string[];
  readonly kinds?: readonly ("linux" | "linux-desktop-cpu" | "android")[];
  readonly installId?: string;
}

function account(options: { paid?: boolean } = {}): Account {
  fakeSsh();
  let clock = START;
  const now = () => clock;
  const fake = new FakeBoat({ now });
  if (options.paid) {
    fake.tier = "standard";
    fake.planKey = "box_20";
    fake.activeSandboxes = 100;
  }
  return { fake, now, tick: (ms) => void (clock += ms) };
}

function plantTemplate(on: Account, labels: Record<string, string>, key = "fp1", createdAt = on.now()): FakeSandbox {
  return on.fake.add({ labels: { ...labels, [LABELS.role]: TEMPLATE_ROLE, [LABELS.kind]: "linux", [LABELS.key]: key }, name: templateName("linux", "ready"), state: "archived", type: "default", createdAt });
}

function backendOn(on: Account, id: string, options: BackendOptions = {}): BoatBackend {
  const storage = options.storage ?? new MemoryStorage();
  const installId = options.installId ?? "inst1";
  const templateLabels = options.templateLabels === undefined ? new BoatOwner(id, installId).labels() : options.templateLabels;
  if (templateLabels) {
    const template = plantTemplate(on, templateLabels);
    const record: TemplateRecord = { kind: "linux", sandbox: template.id, key: "fp1", builtAt: on.now(), buildMs: 600_000, usedAt: null };
    void storage.set("template/linux", record);
  }
  const context = {
    ...testContext(storage, installId, { id }),
    ...(options.tailnet ? { tailnet: () => options.tailnet! } : {}),
    ...(options.logs ? { log: (line: string) => void options.logs!.push(line) } : {}),
  };
  return disposed(
    new BoatBackend({ ...CONFIG, ...options.config }, context, {
      fetch: on.fake.fetch,
      sshBinary: FAKE_SSH_BINARY,
      sleep: async (ms) => on.tick(ms),
      now: on.now,
      readyTimeoutMs: 20_000,
      busyGivesUpAfterMs: 0,
      ownKeyScript: () => ":",
      settledScript: "true",
      cuaReadyScript: "true",
      identityBootScript: "echo boot=kept",
      kinds: options.kinds ?? ["linux"],
      templates: { fingerprint: () => "fp1", setupArchive: async () => Buffer.from("") },
    }),
  );
}

function box(id: string): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "linux", createdAt: START, size: SMALL };
}

const HOOKS: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {}, waiting: async () => {} };

function acquire(backend: BoatBackend, id: string): Promise<Guest> {
  return backend.acquire(box(id), null, HOOKS, new AbortController().signal);
}

function sandboxOf(on: Account, guest: Guest): FakeSandbox {
  return on.fake.sandboxes.get(String(guest.data?.sandbox))!;
}

function snapshotHooks(): SnapshotHooks {
  return { submitting: async () => {}, task: async () => {} };
}

test("two boat.dev backends on one account each label what they make with their own ID, and each lists, releases and keeps alive only its own sandboxes", async () => {
  const on = account();
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B);

  const ownGuest = await acquire(first, BOX_A);
  const otherGuest = await acquire(second, BOX_B);

  assert.equal(sandboxOf(on, ownGuest).labels[LABELS.backend], "boat");
  assert.equal(sandboxOf(on, otherGuest).labels[LABELS.backend], "boat-team-b");
  assert.equal(sandboxOf(on, ownGuest).idempotencyKey, `bbbox-inst1-${BOX_A}`, "the first backend's keys are as before");
  assert.equal(sandboxOf(on, otherGuest).idempotencyKey, `bbbox-inst1-boat-team-b-${BOX_B}`);
  assert.deepEqual((await first.held()).map((guest) => guest.data?.box), [BOX_A]);
  assert.deepEqual((await second.held()).map((guest) => guest.data?.box), [BOX_B]);

  await second.release(ownGuest, RELEASE);
  assert.notEqual(sandboxOf(on, ownGuest).state, "deleted", "a release by another backend leaves the sandbox");
  assert.equal(await second.power(ownGuest), null);

  for (const guest of [ownGuest, otherGuest]) sandboxOf(on, guest).archiveAfter = on.now() + 60_000;
  await second.maintain(undefined, new Set([ownGuest.ref, otherGuest.ref]));
  assert.equal(sandboxOf(on, otherGuest).archiveAfter, on.now() + 30 * 60_000, "its own sandbox's auto-stop is renewed");
  assert.equal(sandboxOf(on, ownGuest).archiveAfter, on.now() + 60_000, "the other backend's is not");
});

test("after the upgrade, a sandbox or template labelled only with the install is the boat backend's: it holds, releases and forks it, and a second backend never does", async () => {
  const on = account();
  const first = backendOn(on, FIRST, { templateLabels: null });
  const second = backendOn(on, TEAM_B, { templateLabels: null });
  const legacyTemplate = plantTemplate(on, LEGACY_LABELS);
  const older = on.fake.add({ labels: { ...LEGACY_LABELS, [LABELS.box]: BOX_A, [LABELS.thread]: "thr_1", [LABELS.name]: "box-old", [LABELS.kind]: "linux", [LABELS.created]: String(START) }, state: "ready" });
  const guest: Guest = { ref: `bbbox-${BOX_A}`, host: null, address: null, size: null, data: { box: BOX_A, sandbox: older.id } };

  assert.deepEqual((await second.held()).map((held) => held.data?.box), []);
  assert.deepEqual((await first.held()).map((held) => held.data?.box), [BOX_A]);
  assert.equal(await second.templates.adoptable("linux"), null, "a second backend never forks a template from before");
  assert.equal((await first.templates.adoptable("linux"))?.id, legacyTemplate.id);

  await second.release(guest, RELEASE);
  assert.equal(older.state, "ready");
  await first.release(guest, RELEASE);
  assert.equal(older.state, "deleted");
});

test("a second boat.dev backend builds and forks only its own templates on a shared account, and another install's of the same backend ID", async () => {
  const on = account();
  const logs: string[] = [];
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B, { templateLabels: null, logs });

  assert.equal(await second.templates.adoptable("linux"), null, "the first backend's template is not the second's");

  const anotherInstalls = plantTemplate(on, new BoatOwner(TEAM_B, "inst2").labels());
  assert.equal((await second.templates.adoptable("linux"))?.id, anotherInstalls.id);
  assert.notEqual((await first.templates.adoptable("linux"))?.id, anotherInstalls.id);
  assert.equal((await second.templates.keepAdoptable("linux"))?.sandbox, anotherInstalls.id);
  assert.ok(logs.includes(`boat.dev (team-b): using the linux template ${anotherInstalls.id}, which bb-box built for another install on this account.`), logs.join("\n"));
});

test("each backend's upkeep deletes only its own old templates and its own abandoned restore sandboxes, even on one account", async () => {
  const on = account();
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B);
  const long = { createdAt: on.now() - 2 * HOUR };
  const oldKey = (labels: Record<string, string>) => plantTemplate(on, labels, "fp0", long.createdAt);
  const firsts = oldKey(new BoatOwner(FIRST, "inst1").labels());
  const legacy = oldKey(LEGACY_LABELS);
  const seconds = oldKey(new BoatOwner(TEAM_B, "inst1").labels());
  const firstStaging = on.fake.add({ labels: {}, name: stagingName(BOX_A, "aaaaaaaa"), state: "archived", ...long });
  const secondStaging = on.fake.add({ labels: {}, name: stagingName(BOX_B, "bbbbbbbb", "boat-team-b"), state: "archived", ...long });

  await second.maintain(undefined, new Set());
  assert.deepEqual([firsts.state, legacy.state, seconds.state, firstStaging.state, secondStaging.state], ["archived", "archived", "deleted", "archived", "deleted"]);

  await first.maintain(undefined, new Set());
  assert.deepEqual([firsts.state, legacy.state, firstStaging.state], ["deleted", "deleted", "deleted"]);
});

test("Most boxes counts the backend's own sandboxes only, while the plan's sandboxes at once count the whole account and say whose they are", async () => {
  const on = account();
  const first = backendOn(on, FIRST, { config: { mostBoxes: 1 } });
  const second = backendOn(on, TEAM_B, { config: { mostBoxes: 1 } });
  const size = { cores: 2, memoryMiB: 4096, diskGiB: null };

  await acquire(first, BOX_A);
  assert.equal((await first.capacity("linux", size, [])).ok, false);
  assert.equal((await second.capacity("linux", size, [])).ok, true, "the first backend's sandbox is not the second's");

  on.fake.add({ labels: { [LABELS.install]: "inst2" }, state: "ready" });
  const full = await second.capacity("linux", size, []);
  assert.equal(full.ok, false);
  assert.match(full.message!, /boat's free trial allows 2 sandboxes at once, and 2 are running or starting, 1 of them not BB Box's and 1 another boat.dev backend's\./);
});

test("each backend's saved snapshots carry its ID in their names, and each lists, changes and deletes only its own; names from before are the boat backend's", async () => {
  const on = account({ paid: true });
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B);
  const firstGuest = await acquire(first, BOX_A);
  const secondGuest = await acquire(second, BOX_B);

  const firstTaken = await first.snapshot(firstGuest, { id: SNAP_A, box: BOX_A, memory: false }, snapshotHooks());
  const secondTaken = await second.snapshot(secondGuest, { id: SNAP_B, box: BOX_B, memory: false }, snapshotHooks());

  assert.equal(firstTaken.ref, savedName("inst1", BOX_A, SNAP_A), "the first backend's names are as before");
  assert.equal(secondTaken.ref, `inst1-boat-team-b-${BOX_B}-${SNAP_B}`);
  assert.deepEqual((await first.heldSnapshots()).map((held) => held.ref), [firstTaken.ref]);
  assert.deepEqual((await second.heldSnapshots()).map((held) => held.ref), [secondTaken.ref]);
  await assert.rejects(second.deleteSnapshot({ id: SNAP_A, ref: firstTaken.ref, guest: firstGuest }, snapshotHooks()), SnapshotFailed);
  await assert.rejects(first.deleteSnapshot({ id: SNAP_B, ref: secondTaken.ref, guest: secondGuest }, snapshotHooks()), SnapshotFailed);
  await assert.rejects(second.labelKept({ id: SNAP_A, ref: firstTaken.ref, guest: firstGuest }, "2030-02-01"), SnapshotFailed);
  assert.equal(on.fake.saved.size, 2);
});

function notTheirs(backend: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.message.includes(`is not a saved snapshot of ${backend}'s on this install`);
}

function refusedAsUnsupported(error: unknown): boolean {
  return error instanceof BackendError && error.code === "unsupported";
}

test("a boat.dev backend refuses to restore or fork another backend's saved snapshot, and names from before are the boat backend's alone", async () => {
  const on = account({ paid: true });
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B);
  const firstGuest = await acquire(first, BOX_A);
  const secondGuest = await acquire(second, BOX_B);
  const fromBefore = await first.snapshot(firstGuest, { id: SNAP_A, box: BOX_A, memory: false }, snapshotHooks());
  const seconds = await second.snapshot(secondGuest, { id: SNAP_B, box: BOX_B, memory: false }, snapshotHooks());
  const legacyRef = { id: SNAP_A, ref: fromBefore.ref, guest: firstGuest };
  const secondRef = { id: SNAP_B, ref: seconds.ref, guest: secondGuest };
  const hooks: CopyHooks = { claimed: async () => {}, submitting: async () => {}, task: async () => {} };
  const identity = { macs: {}, smbios: null };
  const signal = new AbortController().signal;
  const sandboxesBefore = on.fake.sandboxes.size;

  await assert.rejects(second.adoptSnapshot(legacyRef, box(BOX_C), identity, hooks), (error) => error instanceof SnapshotFailed && notTheirs("boat.dev (team-b)")(error));
  await assert.rejects(second.forkSnapshot(legacyRef, box(BOX_C), null, HOOKS, signal), (error) => refusedAsUnsupported(error) && notTheirs("boat.dev (team-b)")(error));
  await assert.rejects(first.adoptSnapshot(secondRef, box(BOX_C), identity, hooks), (error) => error instanceof SnapshotFailed && notTheirs("boat.dev")(error));
  await assert.rejects(first.forkSnapshot(secondRef, box(BOX_C), null, HOOKS, signal), (error) => refusedAsUnsupported(error) && notTheirs("boat.dev")(error));
  assert.equal(on.fake.sandboxes.size, sandboxesBefore, "no backend deployed another's snapshot");

  const forked = await first.forkSnapshot(legacyRef, box(BOX_C), null, HOOKS, signal);

  assert.equal(sandboxOf(on, forked).labels[LABELS.box], BOX_C);
  assert.ok([...on.fake.sandboxes.values()].some((sandbox) => sandbox.forkedFrom === `saved:${fromBefore.ref}`), "the boat backend forks a name from before");
});

test("a second backend's restore deploys a sandbox named with its ID, which only it finds, copies and deletes", async () => {
  const on = account({ paid: true });
  const second = backendOn(on, TEAM_B);
  const old = await acquire(second, BOX_B);
  const taken = await second.snapshot(old, { id: SNAP_B, box: BOX_B, memory: false }, snapshotHooks());
  await second.powerOff(old);
  const hooks: CopyHooks = { claimed: async () => {}, submitting: async () => {}, task: async () => {} };

  const fresh = await second.adoptSnapshot({ id: SNAP_B, ref: taken.ref, guest: old }, box(BOX_B), { macs: {}, smbios: null }, hooks);

  const token = (fresh.data as { guest: string }).guest;
  const deployed = [...on.fake.sandboxes.values()].find((sandbox) => sandbox.forkedFrom === `saved:${taken.ref}`)!;
  assert.equal(deployed.name, `bb-box:restoring:boat-team-b:${BOX_B}:${token}`);
  assert.equal(deployed.state, "deleted");
  assert.equal(sandboxOf(on, fresh).labels[LABELS.backend], "boat-team-b");
  assert.equal(sandboxOf(on, fresh).idempotencyKey, `bbbox-inst1-boat-team-b-${BOX_B}-${token}`);
});

interface Device {
  readonly nodeId: string;
  readonly hostname: string;
}

function tailnetOf(devices: readonly Device[]): { readonly tailnet: Tailnet; readonly removed: string[] } {
  const removed: string[] = [];
  const listed = () => devices.filter((device) => !removed.includes(device.nodeId)).map((device) => ({ ...device, tags: ["tag:bb-box"], lastSeen: "2020-01-01T00:00:00Z" }));
  const tailnet = new Tailnet({
    credentials: { clientId: "id", clientSecret: "secret" },
    fetch: async (url) => {
      const path = new URL(url).pathname;
      const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (path === "/api/v2/oauth/token") return reply({ access_token: "tok", expires_in: 3600 });
      if (path === "/api/v2/tailnet/-/devices") return reply({ devices: listed() });
      if (path.startsWith("/api/v2/device/")) return removed.push(path.split("/").at(-1)!), reply({});
      return { ok: false, status: 404, text: async () => "{}" };
    },
  });
  return { tailnet, removed };
}

function tailnetNameOf(backendId: string, installId: string, name: string): string {
  return new BoatOwner(backendId, installId).tailnetHostname(name);
}

test("each boat.dev backend's upkeep removes only its own sandboxes' stale tailnet devices, and the boat backend's names are as before", async () => {
  const devices = [
    { nodeId: "first-gone", hostname: "bb-box-boat-inst1-gone-box" },
    { nodeId: "second-gone", hostname: tailnetNameOf(TEAM_B, "inst1", "gone-box") },
  ];
  const { tailnet, removed } = tailnetOf(devices);
  const on = account();

  assert.equal(new BoatOwner(TEAM_B, "inst1").tailnetPrefix(), "bb-box-boatb-inst1-6-team-b-");
  await backendOn(on, TEAM_B, { tailnet }).maintain(undefined, new Set());
  assert.deepEqual(removed, ["second-gone"]);
  await backendOn(on, FIRST, { tailnet }).maintain(undefined, new Set());
  assert.deepEqual(removed, ["second-gone", "first-gone"]);
});

test("no boat.dev backend holds another's tailnet names, for names that look alike and the longest install ID and name", () => {
  const names = ["a", "a-1", "1-a", "1", "11", "b", "team-b", "team-bb", "b-team", "10-x", "x-10", "a".repeat(12), "a".repeat(13)];
  const ids = [FIRST, ...names.map((name) => `boat:${name}`)];

  for (const installId of ["inst1", "x".repeat(LONGEST_INSTALL_ID)]) {
    for (const mine of ids) {
      const owner = new BoatOwner(mine, installId);
      for (const theirs of ids.filter((id) => id !== mine)) {
        for (const name of ["", "b", "gone-box", "z".repeat(63)]) {
          const theirName = tailnetNameOf(theirs, installId, name);
          assert.ok(!owner.holdsTailnetHostname(theirName), `${mine} would take ${theirs}'s ${theirName} on install ${installId}`);
        }
      }
    }
  }
});

test("on the longest install ID, each boat.dev backend gives every box its own tailnet name, which it holds, and keeps names that fit as they were", () => {
  const longest = "x".repeat(LONGEST_INSTALL_ID);
  const ids = [FIRST, "boat:a", "boat:team-b", `boat:${"n".repeat(LONGEST_BOAT_BACKEND_NAME)}`];
  const boxes = ["gentle-marsh", "happy-reef", "nimble-sparrow-a1b2", "nimble-sparrow-a1b3", `box-${BOX_A}`, `box-${BOX_B}`];

  for (const id of ids) {
    const owner = new BoatOwner(id, longest);
    const hostnames = boxes.map((name) => owner.tailnetHostname(name));
    assert.equal(new Set(hostnames).size, boxes.length, `${id} gives each box its own name: ${hostnames.join(", ")}`);
    for (const hostname of hostnames) {
      assert.ok(hostname.length <= 63 && /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(hostname), `${hostname} is a tailnet name`);
      assert.ok(owner.holdsTailnetHostname(hostname), `${id} holds ${hostname}`);
    }
  }
  assert.equal(tailnetNameOf(FIRST, "inst1", "gentle-marsh"), "bb-box-boat-inst1-gentle-marsh");
  assert.equal(tailnetNameOf(TEAM_B, "inst1", "gentle-marsh"), "bb-box-boatb-inst1-6-team-b-gentle-marsh");
  assert.equal(tailnetNameOf(FIRST, longest, "gentle-marsh"), `bb-box-boat-${longest}-gentle-marsh`);
});

test("on the longest install ID with the longest backend name, releasing one of two boxes removes only its own tailnet device", async () => {
  const longest = "x".repeat(LONGEST_INSTALL_ID);
  const id = `boat:${"n".repeat(LONGEST_BOAT_BACKEND_NAME)}`;
  const on = account({ paid: true });
  const storage = new MemoryStorage();
  const maker = backendOn(on, id, { storage, installId: longest });
  const first = await acquire(maker, BOX_A);
  await acquire(maker, BOX_B);
  const { tailnet, removed } = tailnetOf([
    { nodeId: "box-a", hostname: tailnetNameOf(id, longest, `box-${BOX_A}`) },
    { nodeId: "box-b", hostname: tailnetNameOf(id, longest, `box-${BOX_B}`) },
  ]);

  await backendOn(on, id, { storage, installId: longest, tailnet, templateLabels: null }).release(first, RELEASE);

  assert.deepEqual(removed, ["box-a"]);
});

test("releasing a box on the tailnet logs it out through the fake ssh's stubs, never the test machine's own sudo or tailscale", async () => {
  const testMachine = recordingStandInsForHostTools(tempDir("test-machine-tools"));
  const on = account({ paid: true });
  const storage = new MemoryStorage();
  const { tailnet, removed } = tailnetOf([{ nodeId: "box-a", hostname: tailnetNameOf(FIRST, "inst1", `box-${BOX_A}`) }]);

  await withHostToolsFirstOnPath(testMachine, async () => {
    const first = await acquire(backendOn(on, FIRST, { storage }), BOX_A);
    await backendOn(on, FIRST, { storage, tailnet, templateLabels: null }).release(first, RELEASE);
  });

  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
  assert.ok(hostCommandsRecorded(process.env.FAKE_SSH_DIR!).includes("tailscale logout"), hostCommandsRecorded(process.env.FAKE_SSH_DIR!).join("; "));
  assert.deepEqual(removed, ["box-a"]);
});

test("a second boat.dev backend is named by its ID, as a provider and in its label; the first keeps the type's name", () => {
  const on = account();

  assert.equal(backendOn(on, FIRST).label, "boat.dev");
  assert.equal(backendOn(on, TEAM_B).label, "boat.dev (team-b)");
  assert.equal(providerName({ label: "boat.dev", hosts: [], id: TEAM_B }), "boat.dev (team-b)");
  assert.equal(providerName({ label: "boat.dev", hosts: [], id: FIRST }), "boat.dev");
});

test("bb box images list shows each boat.dev backend's own templates, by backend", async () => {
  const on = account();
  const first = backendOn(on, FIRST);
  const second = backendOn(on, TEAM_B);
  const jobs = new ImageJobs({ backends: () => [first, second], setup: "", bbUrl: () => null, facts: {} as never, storage: new MemoryStorage() });

  const own = await jobs.ownImages();

  const secondTemplate = (await second.templates.record("linux"))!.sandbox;
  assert.notEqual((await first.templates.record("linux"))!.sandbox, secondTemplate);
  assert.deepEqual(own.map((of) => [of.backend, of.images.map((image) => image.ref)]), [
    [FIRST, [(await first.templates.record("linux"))!.sandbox]],
    [TEAM_B, [secondTemplate]],
  ]);
  assert.match(ownImageLines(own[1]!, on.now()).join("\n"), new RegExp(`^boat:team-b/linux \\(linux\\): ${secondTemplate}, built today; not due; boat\\.dev \\(team-b\\) builds and refreshes it by itself\\.$`));
});

test("bb box images list leaves out the Android template while the Android SDK's licence is off, as no backend builds it then", async () => {
  const on = account();
  const kinds = ["linux", "android"] as const;

  const off = await backendOn(on, TEAM_B, { kinds }).ownImages();
  const accepted = await backendOn(on, TEAM_B, { kinds, config: { androidLicence: true } }).ownImages();

  assert.deepEqual(off.map((image) => image.kind), ["linux"]);
  assert.deepEqual(accepted.map((image) => image.kind), ["linux", "android"]);
});
