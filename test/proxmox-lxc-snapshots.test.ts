import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, type LxcBackendOptions } from "../src/backends/proxmox-lxc/backend.ts";
import { cloneWaitMs, keptUntilOf, parseSnapshotLabel, snapshotLabel, snapshotName } from "../src/backends/proxmox/snapshotting.ts";
import { Proxmox } from "../src/backends/proxmox/api.ts";
import { untilTemplate } from "../src/backends/proxmox/copies.ts";
import type { FetchResponse } from "../src/backends/proxmox/api.ts";
import { RestoreChanged, SnapshotFailed, SnapshotIncomplete, type AcquireHooks, type BoxIdentity, type Guest, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { FAKE_TOKEN, FakeProxmox, TOKEN_ROLE } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

const SNAPSHOT = "sn7kq2m6xa4pdq";

function world() {
  fakeSsh();
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  const config = lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009 });
  const options: LxcBackendOptions = { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 };
  const context = testContext(new MemoryStorage(), "test", { id: "proxmox-lxc" });
  const backend = new ProxmoxLxcBackend(config, context, options);
  made.push(backend);
  return { proxmox, backend, context };
}

let boxes = 0;
function identity(): BoxIdentity {
  boxes++;
  return { boxId: `bxsnapshotbox${boxes}`, threadId: "thr_abc123", name: `calm-otter-${boxes}`, kind: "linux", createdAt: 1_790_000_000_000, size: { ...defaultSize(kindSizes("linux")), gpu: "none" } };
}

const quiet: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

async function box(state: ReturnType<typeof world>): Promise<{ guest: Guest; vmid: number; id: BoxIdentity }> {
  tempDir("lxc-snapshots");
  const id = identity();
  const guest = await state.backend.acquire(id, null, quiet, new AbortController().signal);
  return { guest, vmid: Number(guest.ref), id };
}

function tasks(): { hooks: SnapshotHooks; seen: TaskRef[]; submitted: number[] } {
  const seen: TaskRef[] = [];
  const submitted: number[] = [];
  return { seen, submitted, hooks: { submitting: async () => void submitted.push(seen.length), task: async (task) => void seen.push(task) } };
}

test("a snapshot's Proxmox name and label carry IDs and dates only, and the label reads back", () => {
  assert.equal(snapshotName(SNAPSHOT), "bbsn7kq2m6xa4pdq");
  const label = snapshotLabel({ install: "inst1", box: "bxamberfox2q7k", snapshot: SNAPSHOT, kept: null });
  assert.equal(label, `bb-box install inst1 box bxamberfox2q7k snapshot ${SNAPSHOT}`);
  assert.deepEqual(parseSnapshotLabel(label), { install: "inst1", box: "bxamberfox2q7k", snapshot: SNAPSHOT, reset: null, kept: null });
  const versioned = snapshotLabel({ install: "inst1", box: "bxamberfox2q7k", snapshot: SNAPSHOT, reset: 7, kept: "2026-11-29" });
  assert.equal(versioned, `bb-box install inst1 box bxamberfox2q7k snapshot ${SNAPSHOT} reset 7 kept 2026-11-29`);
  assert.deepEqual(parseSnapshotLabel(versioned), { install: "inst1", box: "bxamberfox2q7k", snapshot: SNAPSHOT, reset: 7, kept: "2026-11-29" }, "the identity reset's version is a number, not a name or a secret");
  assert.deepEqual(parseSnapshotLabel(`${label} kept 2026-11-29`)?.kept, "2026-11-29");
  assert.equal(keptUntilOf("2026-11-29"), Date.UTC(2026, 10, 30) - 1, "kept until the end of the day");
  assert.equal(parseSnapshotLabel("bb-box snapshot research"), null);
  assert.equal(parseSnapshotLabel(`bb-box install inst1 box bx1 snapshot notanid`), null);
});

test("a container offers disk snapshots taken while it runs, forks by a full copy from version 7 of the identity reset, and nothing it cannot do yet", () => {
  const { backend } = world();
  assert.deepEqual(backend.snapshotting("linux"), { scope: "box", holds: ["disk"], whileRunning: "live", restore: "in-place", fork: "copy", forkSafeFrom: 7, keepsPastRelease: "held-copy", lives: "host", price: null, excludes: null });
  assert.equal(backend.snapshotting("windows"), null);
});

test("the plan reads the root disk's storage, its use and its thin metadata, and can take a snapshot", async () => {
  const state = world();
  const { guest } = await box(state);
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.deepEqual(plan.storage, { key: "proxmox:pve:local-lvm", name: "local-lvm", type: "lvmthin", percentFull: 33.3, metadataPercentFull: 9.8, metadataUnread: null, totalBytes: 900 * 2 ** 30, usedBytes: 300 * 2 ** 30 });
  assert.deepEqual(plan.take, { ok: true, why: null, aboutMs: 1000, memoryAboutMs: null, addsBytes: 0, memory: null, memoryWhy: null });
  assert.equal(plan.locked, null);
  assert.equal(plan.restore.way, "rollback");
  assert.equal(plan.restore.undo, "snapshot");
  assert.equal(plan.fork.ok, true);
});

test("the plan refuses a take on storage that takes none, on a locked guest with the host's command, and without VM.Snapshot", async () => {
  const state = world();
  const { guest, vmid } = await box(state);
  state.proxmox.storageTypes.set("local-lvm", "dir");
  const directory = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(directory.take.ok, false);
  assert.equal(directory.take.why, "local-lvm (directory) takes no snapshots of containers, so bb-box takes no snapshot there.");
  state.proxmox.storageTypes.delete("local-lvm");

  state.proxmox.guests.get(vmid)!.config.lock = "rollback";
  const locked = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(locked.take.ok, false);
  assert.deepEqual(locked.locked, { lock: "rollback", fix: `Run \`pct unlock ${vmid}\` on pve.` });
  delete state.proxmox.guests.get(vmid)!.config.lock;

  state.proxmox.privileges.set("/pool/bbbox", new Set(TOKEN_ROLE.filter((privilege) => privilege !== "VM.Snapshot")));
  const fresh = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009 }),
    state.context,
    { fetch: state.proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  made.push(fresh);
  const noRight = await fresh.planSnapshots(guest, "linux", null);
  assert.equal(noRight.take.ok, false);
  assert.equal(noRight.take.why, "The Proxmox token lacks VM.Snapshot on /pool/bbbox, so bb-box cannot take snapshots there. Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on pve.");
});

test("a take records its task before it waits, and is complete only once Proxmox lists it without a snapstate", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  const { hooks, seen } = tasks();
  const taken = await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks);
  assert.equal(taken.ref, "bbsn7kq2m6xa4pdq");
  assert.equal(taken.holds, "disk");
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.ref, /^UPID:pve:.*:vzsnapshot:7000:/);
  const listed = state.proxmox.guests.get(vmid)!.snapshots!;
  assert.deepEqual(listed.map((snapshot) => [snapshot.name, snapshot.description]), [["bbsn7kq2m6xa4pdq", `bb-box install ${state.context.installId} box ${id.boxId} snapshot ${SNAPSHOT}\n`]]);
  assert.deepEqual(await state.backend.providerTask(seen[0]!), { state: "ok" });
  const held = await state.backend.heldSnapshots();
  assert.deepEqual(
    held.map(({ id: snapshot, ref, box, where, state: was, holds, keptUntil }) => ({ snapshot, ref, box, where, was, holds, keptUntil })),
    [{ snapshot: SNAPSHOT, ref: "bbsn7kq2m6xa4pdq", box: id.boxId, where: "current", was: "complete", holds: "disk", keptUntil: null }],
  );
  assert.equal(held[0]!.owner?.boxId, id.boxId);
  assert.equal(held[0]!.guest.ref, String(vmid));
});

test("G1: a take whose task is killed part way is incomplete, never complete; delete refuses while the guest is locked, with the host's command, and finishes Proxmox's clean-up after", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  state.proxmox.killNextSnapshot = true;
  const { hooks } = tasks();
  const error = await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks).catch((caught: unknown) => caught);
  assert.ok(error instanceof SnapshotIncomplete, String(error));
  assert.equal((error as Error).message, "Proxmox left it part-made (snapstate prepare): received interrupt.");
  const [held] = await state.backend.heldSnapshots();
  assert.equal(held?.state, "incomplete");
  assert.equal(held?.words, "Proxmox left it part-made (snapstate prepare).");

  const locked = await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, hooks).catch((caught: unknown) => caught);
  assert.ok(locked instanceof SnapshotIncomplete);
  assert.match((locked as Error).message, new RegExp(`locked \\(snapshot\\), so it cannot delete the snapshot\\. Run \`pct unlock ${vmid}\` on pve, then delete it again\\.`));
  assert.equal(state.proxmox.guests.get(vmid)!.snapshots!.length, 1, "nothing changed");

  delete state.proxmox.guests.get(vmid)!.config.lock;
  await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, hooks);
  assert.equal(state.proxmox.guests.get(vmid)!.snapshots!.length, 0);
  const forced = state.proxmox.calls.find((call) => call.method === "DELETE" && call.path.endsWith(`/snapshot/bbsn7kq2m6xa4pdq`));
  assert.equal(forced?.params.force, "1", "a part-made snapshot is deleted with force, which finishes Proxmox's clean-up");
});

test("a take Proxmox refuses holds nothing, and one whose task fails and leaves nothing failed", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  state.proxmox.nextTaskExit.set("vzsnapshot", "snapshot feature is not available");
  const failed = await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks).catch((caught: unknown) => caught);
  assert.ok(failed instanceof SnapshotFailed);
  assert.equal((failed as Error).message, "snapshot feature is not available");
  assert.equal(state.proxmox.guests.get(vmid)!.snapshots!.length, 0);
});

test("a delete of a snapshot whose guest is gone is done: it went with its guest", async () => {
  const state = world();
  const { guest, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  await state.backend.release(guest, { resetting: async () => {}, timing: () => {} });
  await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "bbsn7kq2m6xa4pdq", guest }, tasks().hooks);
  assert.deepEqual(await state.backend.heldSnapshots(), []);
});

test("the listing finds only this install's labelled snapshots, a kept date as kept, and a snapshot whose task still runs as in progress", async () => {
  const state = world();
  const { vmid, id } = await box(state);
  const snapshots = (state.proxmox.guests.get(vmid)!.snapshots ??= []);
  snapshots.push({ name: "manual", description: "taken by hand", snaptime: 1_790_000_000 });
  snapshots.push({ name: "bbsnaaaaaaaaaaaa", description: `bb-box install another box ${id.boxId} snapshot snaaaaaaaaaaaa`, snaptime: 1_790_000_000 });
  snapshots.push({ name: "bbsnbbbbbbbbbbbb", description: `bb-box install ${state.context.installId} box ${id.boxId} snapshot snbbbbbbbbbbbb kept 2026-11-29`, snaptime: 1_790_000_000 });
  const held = await state.backend.heldSnapshots();
  assert.deepEqual(held.map((each) => [each.id, each.keptUntil, each.takenAt]), [["snbbbbbbbbbbbb", Date.UTC(2026, 10, 30) - 1, 1_790_000_000_000]]);

  snapshots.push({ name: "bbsn7kq2m6xa4pdq", description: `bb-box install ${state.context.installId} box ${id.boxId} snapshot ${SNAPSHOT}`, snaptime: 1_790_000_000, snapstate: "prepare" });
  state.proxmox.intercept = (call) =>
    call.method === "GET" && call.path === "/nodes/pve/tasks" && call.params.vmid === String(vmid)
      ? { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data: [{ upid: `UPID:pve:1:0:0:vzsnapshot:${vmid}:bb-box@pve!plugin:`, type: "vzsnapshot", status: "running" }] }) }
      : undefined;
  const during = (await state.backend.heldSnapshots()).find((each) => each.id === SNAPSHOT);
  assert.equal(during?.state, "in-progress", "a part-made snapshot whose task is still running is not incomplete yet");
  state.proxmox.intercept = undefined;
  assert.equal((await state.backend.heldSnapshots()).find((each) => each.id === SNAPSHOT)?.state, "incomplete");
});

function answer(status: number, data: unknown): FetchResponse {
  return { ok: status < 300, status, statusText: status < 300 ? "OK" : "Forbidden", text: async () => JSON.stringify(status < 300 ? { data } : { data: null, message: "Permission check failed" }) };
}

test("a lock a running task holds gets no unlock advice: the plan and the delete say to try again when it ends", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  state.proxmox.guests.get(vmid)!.config.lock = "backup";
  state.proxmox.intercept = (call) => (call.method === "GET" && call.path === "/nodes/pve/tasks" && call.params.source === "active" ? answer(200, [{ upid: `UPID:pve:1:0:0:vzdump:${vmid}:root@pam:`, type: "vzdump" }]) : undefined);
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.locked, null);
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, `Proxmox is running a backup on guest ${vmid}, which holds its lock (backup). Try again when it ends.`);
  const refused = await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks).catch((caught: unknown) => caught);
  assert.ok(refused instanceof SnapshotFailed);
  assert.doesNotMatch((refused as Error).message, /unlock/);
  state.proxmox.intercept = (call) => (call.method === "GET" && call.path === "/nodes/pve/tasks" ? answer(403, null) : undefined);
  const unsure = await state.backend.planSnapshots(guest, "linux", null);
  assert.deepEqual(unsure.locked, { lock: "backup", fix: `If no task is running on guest ${vmid}, run \`pct unlock ${vmid}\` on pve.` });
});

test("thin metadata is read from the storage's own thin pool; when it cannot be, the plan and the doctor say so", async () => {
  const state = world();
  const { guest } = await box(state);
  state.proxmox.thinPools.push({ lv: "other", vg: "pve", metadata_size: 100, metadata_used: 99 });
  assert.equal((await state.backend.planSnapshots(guest, "linux", null)).storage.metadataPercentFull, 9.8, "its own pool, not another one on the node");
  state.proxmox.storageConfigs.set("local-lvm", { storage: "local-lvm", type: "lvmthin", content: "rootdir" });
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.storage.metadataPercentFull, null);
  assert.equal(plan.storage.metadataUnread, "bb-box cannot read which thin pool local-lvm is");
  const check = (await state.backend.doctor()).checks.find((each) => each.id === "proxmox.snapshots")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /bb-box cannot read local-lvm's thin metadata \(bb-box cannot read which thin pool local-lvm is\), so a take checks the pool's data use but not that its metadata is under 80% full\./);
  assert.match(check.fix!, /Sys\.Audit on \/, a read of the whole cluster/);
});

test("a delete checks the snapshot's own label before it deletes: one named as ours but labelled otherwise is left alone", async () => {
  const state = world();
  const { guest, vmid } = await box(state);
  (state.proxmox.guests.get(vmid)!.snapshots ??= []).push({ name: snapshotName(SNAPSHOT), description: "made by hand", snaptime: 1_790_000_000 });
  const refused = await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks).catch((caught: unknown) => caught);
  assert.ok(refused instanceof SnapshotFailed);
  assert.equal((refused as Error).message, `The snapshot named bbsn7kq2m6xa4pdq on guest ${vmid} is not bb-box's snapshot ${SNAPSHOT}: its description says "made by hand". bb-box deleted nothing.`);
  assert.equal(state.proxmox.guests.get(vmid)!.snapshots!.length, 1);
  state.proxmox.guests.get(vmid)!.snapshots![0]!.description = `bb-box install ${state.context.installId} box bxanotherboxaa snapshot ${SNAPSHOT}`;
  assert.ok((await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks).catch((caught: unknown) => caught)) instanceof SnapshotFailed, "another box's label");
});

test("a take is complete only when its task succeeded; the provider is told before the request goes, and the task can be found by guest and time", async () => {
  const state = world();
  const { guest, id } = await box(state);
  const since = Date.now() - 1000;
  state.proxmox.snapshotTaskFailsWhole = true;
  const { hooks, submitted, seen } = tasks();
  const failed = await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks).catch((caught: unknown) => caught);
  assert.ok(failed instanceof SnapshotIncomplete);
  assert.equal((failed as Error).message, "Proxmox's task failed (vmstate save failed), though it left the snapshot with no part-made state, so bb-box does not count it as taken.");
  assert.deepEqual(submitted, [0], "submitting came before any task was recorded");
  assert.deepEqual((await state.backend.findTasks(guest, "take", since)).map((task) => task.ref), [seen[0]!.ref]);
  assert.deepEqual(await state.backend.findTasks(guest, "delete", since), []);
  assert.deepEqual(await state.backend.providerTask({ ref: "UPID:pve:00000000:0:0:vzsnapshot:7000:x:", host: "pve" }), { state: "missing", words: "Proxmox has no task UPID:pve:00000000:0:0:vzsnapshot:7000:x:." });
});


test("a restore's plan: rollback to any snapshot on LVM-thin, the size it goes back to from the snapshot's own config, how many are newer, and why it cannot", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  const { hooks } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks);
  state.proxmox.guests.get(vmid)!.config.memory = "8192";
  await state.backend.snapshot(guest, { id: "snbbbbbbbbbbbb", box: id.boxId, memory: false }, hooks);
  const plan = await state.backend.planSnapshots(guest, "linux", { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest });
  assert.equal(plan.restore.way, "rollback");
  assert.equal(plan.restore.why, null);
  assert.equal(plan.restore.undo, "snapshot");
  assert.equal(plan.restore.undoBytes, 0);
  assert.equal(plan.restore.newer, 1);
  assert.notEqual(plan.restore.sizeBack?.memoryMiB, 8192, "the size it goes back to is the snapshot's");
  const missing = await state.backend.planSnapshots(guest, "linux", { id: "sncccccccccccc", ref: "", guest });
  assert.equal(missing.restore.way, "none");
  assert.equal(missing.restore.why, `Guest ${vmid} has no snapshot bbsncccccccccccc.`);
  state.proxmox.storageTypes.set("local-lvm", "zfspool");
  const zfs = await state.backend.planSnapshots(guest, "linux", { id: SNAPSHOT, ref: "", guest });
  assert.equal(zfs.restore.way, "rollback-newest-only");
  assert.equal(zfs.restore.undo, "held-copy");
  state.proxmox.storageTypes.delete("local-lvm");
  state.proxmox.privileges.set("/pool/bbbox", new Set(TOKEN_ROLE.filter((privilege) => privilege !== "VM.Snapshot.Rollback")));
  const fresh = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009 }),
    state.context,
    { fetch: state.proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  made.push(fresh);
  const noRight = await fresh.planSnapshots(guest, "linux", { id: SNAPSHOT, ref: "", guest });
  assert.equal(noRight.restore.way, "none");
  assert.match(noRight.restore.why!, /^The Proxmox token lacks VM\.Snapshot\.Rollback on \/pool\/bbbox, so bb-box cannot restore snapshots there\./);
});

test("a rollback refuses a running guest, records its task before it waits, puts the snapshot's config back, and says when its task failed part way", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  const { hooks, seen } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks);
  state.proxmox.guests.get(vmid)!.config.memory = "8192";
  const ref = { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest };
  const running = await state.backend.rollbackSnapshot(guest, ref, hooks).catch((caught: unknown) => caught);
  assert.ok(running instanceof SnapshotFailed);
  assert.equal((running as Error).message, `Guest ${vmid} is running, and bb-box restores a guest only once it has stopped.`);
  await state.backend.powerOff(guest);
  assert.equal(state.proxmox.guests.get(vmid)!.status, "stopped");
  state.proxmox.guests.get(vmid)!.config.lock = "backup";
  const locked = await state.backend.rollbackSnapshot(guest, ref, hooks).catch((caught: unknown) => caught);
  assert.ok(locked instanceof SnapshotFailed);
  assert.match((locked as Error).message, new RegExp(`Proxmox has guest ${vmid} locked \\(backup\\), so it cannot restore the snapshot\\. Run \`pct unlock ${vmid}\` on pve\\.`));
  delete state.proxmox.guests.get(vmid)!.config.lock;
  seen.length = 0;
  await state.backend.rollbackSnapshot(guest, ref, hooks);
  assert.match(seen[0]!.ref, /^UPID:pve:.*:vzrollback:7000:/);
  assert.notEqual(state.proxmox.guests.get(vmid)!.config.memory, "8192");
  assert.deepEqual(await state.backend.findTasks(guest, "rollback", Date.now() - 60_000), [seen[0]]);
  state.proxmox.nextTaskExit.set("vzrollback", "unable to rollback: interrupted");
  const failed = await state.backend.rollbackSnapshot(guest, ref, hooks).catch((caught: unknown) => caught);
  assert.ok(failed instanceof RestoreChanged, String(failed));
  assert.equal((failed as Error).message, "Proxmox's rollback task failed: unable to rollback: interrupted.");
});

test("G13: rollbacks of this install's guests are read from the node's task list with their user, time and status", async () => {
  const state = world();
  const { guest, id } = await box(state);
  const { hooks } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks);
  await state.backend.powerOff(guest);
  const since = Date.now() - 60_000;
  await state.backend.rollbackSnapshot(guest, { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, hooks);
  state.proxmox.nextTaskExit.set("vzrollback", "unable to rollback");
  await state.backend.rollbackSnapshot(guest, { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, hooks).catch(() => undefined);
  const found = await state.backend.outsideRollbacks(since);
  assert.deepEqual(
    found.map((each) => ({ guest: each.guest, user: each.user, outcome: each.outcome })),
    [
      { guest: guest.ref, user: "bb-box@pve!plugin", outcome: { state: "ok" } },
      { guest: guest.ref, user: "bb-box@pve!plugin", outcome: { state: "failed", words: "unable to rollback" } },
    ],
  );
});

test("G13: a rollback the node lists as running, with no end time, is read as running from its own status", async () => {
  const state = world();
  const { guest } = await box(state);
  const upid = `UPID:pve:0000AAAA:00:6AE53BE9:vzrollback:${guest.ref}:root@pam:`;
  state.proxmox.intercept = (call) => {
    const json = (data: unknown) => ({ ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data }) });
    if (call.method === "GET" && /\/tasks$/.test(call.path) && call.params.typefilter === "vzrollback") return json([{ upid, type: "vzrollback", id: guest.ref, user: "root@pam", starttime: Math.floor(Date.now() / 1000), status: "RUNNING" }]);
    if (call.method === "GET" && call.path.endsWith("/status") && call.path.includes("/tasks/")) return json({ status: "running", upid });
    return undefined;
  };
  const [found] = await state.backend.outsideRollbacks(Date.now() - 60_000);
  assert.deepEqual(found?.outcome, { state: "running" });
  assert.equal(found?.user, "root@pam");
});

test("G16 on Proxmox LXC: a held copy is cloned into the box range, labelled, disarmed and made a template; a new guest made from it takes the box's MAC and address; the old guest is disarmed with a new MAC as the earlier guest", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  const { hooks: snapshotHooks } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, snapshotHooks);
  const mac = "BC:24:11:AA:BB:CC";
  state.proxmox.guests.get(vmid)!.config.net0 = `${state.proxmox.guests.get(vmid)!.config.net0},hwaddr=${mac}`;
  const identity = await state.backend.guestIdentity(guest);
  assert.equal(identity.macs.net0, mac);
  const running = await state.backend.copyGuest(guest, { box: id.boxId, snapshot: "snbbbbbbbbbbbb", kept: null }, { ...tasks().hooks, claimed: async () => {} }).catch((caught: unknown) => caught);
  assert.ok(running instanceof SnapshotFailed, "a running guest is never copied");
  await state.backend.powerOff(guest);
  const claimed: string[] = [];
  const copy = await state.backend.copyGuest(guest, { box: id.boxId, snapshot: "snbbbbbbbbbbbb", kept: null }, { ...tasks().hooks, claimed: async (made) => void claimed.push(made.ref) });
  assert.deepEqual(claimed, [copy.ref], "the copy's VMID is recorded before the clone");
  const copied = state.proxmox.guests.get(Number(copy.ref))!;
  assert.match(copied.config.tags ?? "", /held-copy/);
  assert.match(copied.config.tags ?? "", /snapshot\.snbbbbbbbbbbbb/);
  assert.equal(copied.config.onboot, "0");
  assert.equal(await state.backend.copyState(copy), "copy");
  await state.backend.disarmCopy(copy);
  assert.match(copied.config.net0 ?? "", /link_down=1/);
  await state.backend.templateCopy(copy);
  assert.equal(await state.backend.copyState(copy), "template");
  assert.equal((await state.backend.held()).some((held) => held.ref === copy.ref), false, "the box sweep never sees a held copy");
  const listed = await state.backend.heldSnapshots();
  assert.deepEqual(listed.filter((held) => held.where === "held-copy").map((held) => ({ id: held.id, ref: held.ref, state: held.state })), [{ id: "snbbbbbbbbbbbb", ref: copy.ref, state: "complete" }]);
  const fresh = await state.backend.adoptCopy(copy, id, identity, { ...tasks().hooks, claimed: async () => {} });
  const made = state.proxmox.guests.get(Number(fresh.ref))!;
  assert.match(made.config.net0 ?? "", new RegExp(`hwaddr=${mac}`), "the new guest has the box's MAC");
  assert.doesNotMatch(made.config.net0 ?? "", /link_down/);
  assert.match(made.config.net0 ?? "", new RegExp(`ip=${fresh.address}/`), "and the address of its own VMID");
  assert.equal(made.config.onboot, "1");
  assert.match(made.config.tags ?? "", new RegExp(`box\\.${id.boxId}`));
  assert.doesNotMatch(made.config.tags ?? "", /held-copy/);
  await state.backend.retireGuest(guest, id);
  const old = state.proxmox.guests.get(vmid)!;
  assert.match(old.config.net0 ?? "", /link_down=1/);
  assert.doesNotMatch(old.config.net0 ?? "", new RegExp(`hwaddr=${mac}`), "the earlier guest has a MAC of its own");
  assert.equal(old.config.onboot, "0");
  assert.match(old.config.tags ?? "", /earlier-guest/);
  assert.equal((await state.backend.held()).some((held) => held.ref === guest.ref), false, "nor an earlier guest");
  assert.deepEqual((await state.backend.heldSnapshots()).filter((held) => held.where === "earlier").map((held) => held.id), [SNAPSHOT]);
  await state.backend.deleteCopy({ ...copy, data: { ...copy.data, box: "bxanotherbox" } });
  assert.ok(state.proxmox.guests.has(Number(copy.ref)), "a copy that names another box is left alone");
  await state.backend.deleteCopy(copy);
  assert.equal(state.proxmox.guests.has(Number(copy.ref)), false);
});

test("review A3: a restore's task is looked up among the token's own, never another user's", async () => {
  const state = world();
  const { guest } = await box(state);
  const now = Math.floor(Date.now() / 1000);
  state.proxmox.intercept = (call) => {
    if (call.method !== "GET" || !/\/tasks$/.test(call.path) || call.params.typefilter !== "vzrollback") return undefined;
    const data = [
      { upid: `UPID:pve:0000AAAA:00:00:vzrollback:${guest.ref}:root@pam:`, type: "vzrollback", id: guest.ref, user: "root@pam", starttime: now, status: "OK", endtime: now },
      { upid: `UPID:pve:0000BBBB:00:00:vzrollback:${guest.ref}:bb-box@pve!plugin:`, type: "vzrollback", id: guest.ref, user: "bb-box@pve", starttime: now, status: "OK", endtime: now },
    ];
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data }) };
  };
  assert.deepEqual(
    (await state.backend.findTasks(guest, "rollback", Date.now())).map((task) => task.ref),
    [`UPID:pve:0000BBBB:00:00:vzrollback:${guest.ref}:bb-box@pve!plugin:`],
  );
});

test("review A6: a lock a running backup holds refuses a restore as it does a take, without unlock advice", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  const { hooks } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, hooks);
  state.proxmox.guests.get(vmid)!.config.lock = "backup";
  state.proxmox.intercept = (call) =>
    call.method === "GET" && /\/tasks$/.test(call.path) && call.params.source === "active"
      ? { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data: [{ upid: `UPID:pve:1:0:0:vzdump:${vmid}:root@pam:`, type: "vzdump" }] }) }
      : undefined;
  const plan = await state.backend.planSnapshots(guest, "linux", { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest });
  assert.equal(plan.locked, null);
  assert.equal(plan.restore.way, "none");
  assert.match(plan.restore.why!, /running a backup on guest \d+, which holds its lock \(backup\)\. Try again when it ends\./);
});

test("Opus 1: deleteCopy destroys only a held copy or an earlier guest, never the box's own guest", async () => {
  const state = world();
  const { guest, vmid } = await box(state);
  const refused = await state.backend.deleteCopy(guest).catch((caught: unknown) => caught);
  assert.ok(refused instanceof SnapshotFailed, String(refused));
  assert.match((refused as Error).message, /is not a held copy or an earlier guest of box/);
  assert.ok(state.proxmox.guests.has(vmid));
});

test("070 unit 7: a fork is a full copy of the snapshot in a VMID of its own, recorded before the clone, disarmed in the first request after it, given a new MAC and its own address with its link still down, labelled as its new box, and armed only later: links before its start, onboot after its check", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  const source = state.proxmox.guests.get(vmid)!;
  source.config.net0 = `${source.config.net0},hwaddr=BC:24:11:AA:BB:CC`;
  source.snapshots![0]!.config = { ...source.snapshots![0]!.config, net0: `${source.config.net0},link_down=1`, onboot: "0", memory: "4096", cores: "2" };
  const plan = await state.backend.planSnapshots(guest, "linux", { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest });
  assert.equal(plan.fork.ok, true, plan.fork.why ?? "");
  assert.deepEqual(plan.fork.size, { cores: 2, memoryMiB: 4096, diskGiB: plan.fork.size?.diskGiB ?? null }, "the fork has the size the snapshot holds");
  const forked: BoxIdentity = { ...identity(), name: id.name, size: { ...plan.fork.size!, gpu: "none" } };
  const claimed: string[] = [];
  let listedDuring: boolean | null = null;
  state.proxmox.intercept = (call) => {
    if (call.method === "POST" && /\/clone$/.test(call.path)) void state.backend.held().then((held) => (listedDuring = held.some((each) => each.ref !== guest.ref && each.owner?.boxId === id.boxId)));
    return undefined;
  };
  const made = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, { ...quiet, claim: async (each) => void claimed.push(each.ref) }, new AbortController().signal);
  state.proxmox.intercept = undefined;
  assert.deepEqual(claimed, [made.ref], "the fork's VMID is recorded before the clone");
  assert.equal(listedDuring, false, "the sweep never takes the half-made fork, whose copied tags still name its source, for a leftover");
  const clone = [...state.proxmox.calls].reverse().find((call) => call.method === "POST" && /\/clone$/.test(call.path))!;
  assert.equal(clone.params.snapname, snapshotName(SNAPSHOT));
  assert.equal(clone.params.full, "1");
  const cloneAt = state.proxmox.calls.lastIndexOf(clone);
  const after = state.proxmox.calls.slice(cloneAt + 1).filter((call) => call.method !== "GET" && !/\/tasks\//.test(call.path));
  assert.equal(after[0]?.method, "PUT", "the first change after the clone");
  assert.match(after[0]!.path, new RegExp(`/lxc/${made.ref}/config$`));
  assert.equal(after[0]!.params.onboot, "0", "disarmed: it would not start with its node");
  assert.match(after[0]!.params.net0 ?? "", /link_down=1/, "and its link is down");
  const config = state.proxmox.guests.get(Number(made.ref))!.config;
  assert.equal(config.onboot, "0", "not armed yet");
  assert.match(config.net0 ?? "", /link_down=1/, "its own address, with its link still down");
  assert.doesNotMatch(config.net0 ?? "", /BC:24:11:AA:BB:CC/i, "a MAC of its own, so its identity reset runs at its first boot");
  assert.match(config.net0 ?? "", /hwaddr=BC:24:11:/);
  assert.match(config.net0 ?? "", new RegExp(`ip=${made.address}/`), "the address of its own VMID");
  assert.match(config.tags ?? "", new RegExp(`box\\.${forked.boxId}`));
  assert.doesNotMatch(config.tags ?? "", new RegExp(`box\\.${id.boxId}`));
  assert.match(String(config.description), new RegExp(`box ${forked.boxId}`));
  assert.equal(config.hostname, id.name, "a fork may have its source's name");
  assert.equal(made.data?.box, forked.boxId);
  assert.ok((await state.backend.held()).some((held) => held.ref === made.ref && held.owner?.boxId === forked.boxId), "once labelled, the sweep sees it as its own box's guest");
  assert.equal(state.proxmox.guests.get(vmid)!.config.net0, source.config.net0, "the source is untouched");
  await state.backend.armFork(made, "network");
  assert.doesNotMatch(state.proxmox.guests.get(Number(made.ref))!.config.net0 ?? "", /link_down/, "its link comes up before its first start");
  assert.equal(state.proxmox.guests.get(Number(made.ref))!.config.onboot, "0", "onboot waits for the check");
  await state.backend.armFork(made, "boot");
  assert.equal(state.proxmox.guests.get(Number(made.ref))!.config.onboot, "1", "armed at the end");
});

test("070 unit 7 reviews: a held copy is disarmed in the first request after its clone, before its labels", async () => {
  const state = world();
  const { guest, id } = await box(state);
  await state.backend.powerOff(guest);
  const copy = await state.backend.copyGuest(guest, { box: id.boxId, snapshot: "snbbbbbbbbbbbb", kept: null }, { ...tasks().hooks, claimed: async () => {} });
  const clone = [...state.proxmox.calls].reverse().find((call) => call.method === "POST" && /\/clone$/.test(call.path))!;
  const first = state.proxmox.calls.slice(state.proxmox.calls.lastIndexOf(clone) + 1).find((call) => call.method === "PUT");
  assert.match(first!.path, new RegExp(`/lxc/${copy.ref}/config$`));
  assert.equal(first!.params.onboot, "0");
  assert.match(first!.params.net0 ?? "", /link_down=1/);
  assert.equal(first!.params.tags, undefined, "its labels come after");
});

test("070 unit 7: a fork cut short is not left behind: a failed copy is deleted, and a half-made one from before a restart is deleted before the copy is made again", async () => {
  const state = world();
  const { guest, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  const forked = identity();
  const before = new Set(state.proxmox.guests.keys());
  state.proxmox.nextTaskExit.set("vzclone", "copy failed: out of space");
  const failed = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, quiet, new AbortController().signal).catch((caught: unknown) => caught);
  assert.match(String(failed), /copy of snapshot bbsn7kq2m6xa4pdq of guest \d+ failed: copy failed: out of space/);
  assert.deepEqual(new Set(state.proxmox.guests.keys()), before, "nothing of the failed fork is left");
  const missing = await state.backend.forkSnapshot({ id: "snzzzzzzzzzzzz", ref: snapshotName("snzzzzzzzzzzzz"), guest }, forked, null, quiet, new AbortController().signal).catch((caught: unknown) => caught);
  assert.match(String(missing), /Proxmox refused to copy snapshot bbsnzzzzzzzzzzzz/);
  const first = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, quiet, new AbortController().signal);
  const again = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, first, quiet, new AbortController().signal);
  assert.equal(state.proxmox.guests.has(Number(first.ref)), false, "the half-made fork from before the restart is deleted");
  assert.ok(state.proxmox.guests.has(Number(again.ref)));
  const other = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, identity(), guest, quiet, new AbortController().signal);
  assert.ok(state.proxmox.guests.has(vmidOf(guest)), "a guest that is not this fork's is never deleted as a half-made fork");
  assert.ok(state.proxmox.guests.has(Number(other.ref)));
});

function vmidOf(guest: Guest): number {
  return Number(guest.ref);
}

test("070 unit 7: an LXC fork's first start waits up to 180 s for SSH, as a VM's does, so a card that comes late is waited for; any other start waits 30 s", async (t) => {
  fakeSsh();
  tempDir("lxc-fork-start");
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  const config = lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009 });
  let clock = Date.now();
  let open = true;
  t.mock.method(Date, "now", () => clock);
  const options: LxcBackendOptions = { fetch: proxmox.fetch, sleep: async (ms) => void (clock += Math.max(ms, 1)), sshBinary: FAKE_SSH_BINARY, portCheck: async () => open };
  const backend = new ProxmoxLxcBackend(config, testContext(new MemoryStorage(), "test", { id: "proxmox-lxc" }), options);
  made.push(backend);
  const guest = await backend.acquire(identity(), null, quiet, new AbortController().signal);
  open = false;
  for (const [within, said] of [[undefined, "30 s"], [180_000, "180 s"]] as const) {
    await backend.stop(guest);
    const began = clock;
    const failed = await backend.start(guest, undefined, undefined, undefined, within).catch((caught: unknown) => caught);
    assert.match(String(failed), new RegExp(`Nothing answered on port 22 of \\S+ within ${said}\\.`));
    assert.ok(clock - began >= (within ?? 30_000), "it waited that long");
  }
});

test("070 unit 7 re-review: a fork's clone is disarmed before each attempt to delete it, so one whose delete fails cannot start with its node; recovery disarms a half-made fork first too, and disarmFork acts only on a guest its description names as that fork's", async () => {
  const state = world();
  const { guest, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  const source = state.proxmox.guests.get(vmidOf(guest))!;
  source.snapshots![0]!.config = { ...source.snapshots![0]!.config, onboot: "1" };
  const forked = identity();
  const before = new Set(state.proxmox.guests.keys());
  const refuseDelete = (vmid: () => number | null) => (call: { method: string; path: string }) =>
    call.method === "DELETE" && call.path.endsWith(`/lxc/${vmid()}`) ? { ok: false, status: 500, statusText: "CT is locked (clone)", text: async () => JSON.stringify({ data: null }) } : undefined;
  const newVmid = () => [...state.proxmox.guests.keys()].find((vmid) => !before.has(vmid)) ?? null;
  state.proxmox.nextTaskExit.set("vzclone", "copy failed: out of space");
  state.proxmox.intercept = refuseDelete(newVmid);
  const failed = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, quiet, new AbortController().signal).catch((caught: unknown) => caught);
  state.proxmox.intercept = undefined;
  assert.match(String(failed), /out of space/);
  const left = newVmid()!;
  assert.ok(left, "the delete failed, so the clone is still there");
  assert.equal(state.proxmox.guests.get(left)!.config.onboot, "0", "but it would not start with its node");
  assert.match(state.proxmox.guests.get(left)!.config.net0 ?? "", /link_down=1/);
  const changes = (vmid: number) => state.proxmox.calls.filter((call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`)) || (call.method === "DELETE" && call.path.endsWith(`/lxc/${vmid}`))).map((call) => call.method);
  assert.deepEqual(changes(left), ["PUT", "DELETE"], "disarmed, then the delete tried");
  state.proxmox.guests.delete(left);

  const first = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, quiet, new AbortController().signal);
  const half = state.proxmox.guests.get(Number(first.ref))!;
  half.config.onboot = "1";
  half.config.net0 = (half.config.net0 ?? "").replace(",link_down=1", "");
  half.config.tags = source.config.tags ?? "";
  await state.backend.disarmFork!(first);
  assert.equal(half.config.onboot, "0", "disarmFork finds a half-made fork by its description, while its copied tags still name its source");
  assert.match(half.config.net0 ?? "", /link_down=1/);
  const sourceNet = source.config.net0;
  await state.backend.disarmFork!({ ...guest, data: { ...guest.data, box: forked.boxId } });
  assert.equal(source.config.net0, sourceNet, "a guest whose description names another box is left alone");
  half.config.onboot = "1";
  const calls = state.proxmox.calls.length;
  const again = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, first, quiet, new AbortController().signal);
  assert.equal(state.proxmox.guests.has(Number(first.ref)), false);
  const recovery = state.proxmox.calls.slice(calls).filter((call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${first.ref}/config`)) || (call.method === "DELETE" && call.path.endsWith(`/lxc/${first.ref}`)));
  assert.deepEqual(recovery.map((call) => call.method), ["PUT", "DELETE"], "recovery disarms the half-made fork before it deletes it");
  assert.equal(recovery[0]!.params.onboot, "0");
  assert.ok(state.proxmox.guests.has(Number(again.ref)));
});

test("a fork's later release disarms it again before deleting it", async () => {
  const state = world();
  const { guest, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  const forked = identity();
  const made = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, forked, null, quiet, new AbortController().signal);
  const vmid = Number(made.ref);
  const config = state.proxmox.guests.get(vmid)!;
  config.config.onboot = "1";
  let refuse = true;
  state.proxmox.intercept = (call) => (refuse && call.method === "DELETE" && call.path.endsWith(`/lxc/${vmid}`) ? { ok: false, status: 500, statusText: "CT is locked", text: async () => JSON.stringify({ data: null }) } : undefined);
  const hooks = { resetting: async () => {}, timing: () => {} };
  await assert.rejects(state.backend.release(made, hooks), /locked|delete|500|Proxmox/i);
  assert.equal(config.config.onboot, "0", "the release that could not delete still disarmed it");
  config.config.onboot = "1";
  const calls = state.proxmox.calls.length;
  refuse = false;
  await state.backend.release(made, hooks);
  const again = state.proxmox.calls.slice(calls).filter((call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`)) || (call.method === "DELETE" && call.path.endsWith(`/lxc/${vmid}`)));
  assert.deepEqual(again.map((call) => call.method), ["PUT", "DELETE"]);
  assert.equal(again[0]!.params.onboot, "0");
});

test("a held copy cut short before its own labels still carries its source's tags, and the sweep sees it as a guest that names no box, never one to restore", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  state.proxmox.intercept = (call) =>
    call.method === "PUT" && /\/lxc\/\d+\/config$/.test(call.path) && !call.path.endsWith(`/lxc/${vmid}/config`)
      ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "cut short" }) }
      : undefined;
  let claimed: Guest | null = null;
  const cut = await state.backend.copySnapshot({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, { box: id.boxId, snapshot: SNAPSHOT, kept: "2026-11-30" }, { ...tasks().hooks, claimed: async (made) => void (claimed = made) }).catch((caught: unknown) => caught);
  state.proxmox.intercept = undefined;
  assert.ok(cut instanceof Error);
  const part = [...state.proxmox.guests.values()].find((each) => each.vmid !== vmid && each.name.startsWith("bb-box-copy-"))!;
  assert.match(part.config.tags ?? "", new RegExp(`(^|;)box\\.${id.boxId}(;|$)`), "it still carries its source's tags");
  const listed = (await state.backend.held()).find((each) => each.ref === String(part.vmid));
  assert.ok(listed, "the sweep sees it");
  assert.equal(listed.owner, null, "as a guest that names no box");
  await assert.rejects(state.backend.labelCopy(claimed!, { box: id.boxId, snapshot: "snbbbbbbbbbbbb", kept: null }), /is not the copy bb-box made of snapshot snbbbbbbbbbbbb/);
  await state.backend.labelCopy(claimed!, { box: id.boxId, snapshot: SNAPSHOT, kept: "2026-11-30", forkSafe: 7, kind: "linux" });
  for (const tag of ["held-copy", `snapshot.${SNAPSHOT}`, "kept.2026-11-30", "reset.7"]) assert.match(part.config.tags ?? "", new RegExp(`(^|;)${tag.replace(/\./g, "\\.")}(;|$)`), `labelled once its clone ends well: ${tag}`);
  assert.equal(part.config.onboot, "0");
  assert.match(part.config.net0 ?? "", /link_down=1/);
  assert.equal((await state.backend.held()).some((each) => each.ref === String(part.vmid)), false, "and then a held copy, which the box sweep never sees");
});

test("a release's label check lists one guest's own snapshots with their keep dates, and fails when Proxmox cannot list them", async () => {
  const state = world();
  const { guest, vmid, id } = await box(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, tasks().hooks);
  await state.backend.labelKept({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, "2026-11-30");
  assert.deepEqual((await state.backend.snapshotsOn(guest)).map((held) => ({ id: held.id, keptUntil: held.keptUntil, forkSafe: held.forkSafe })), [{ id: SNAPSHOT, keptUntil: Date.UTC(2026, 10, 30, 23, 59, 59, 999), forkSafe: null }]);
  state.proxmox.intercept = (call) =>
    call.method === "GET" && call.path.endsWith(`/lxc/${vmid}/snapshot`) ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "cannot read" }) } : undefined;
  await assert.rejects(state.backend.snapshotsOn(guest));
  state.proxmox.intercept = undefined;
});

test("070 unit 8: Keep's held copy is a full copy of the snapshot into the box range, recorded before the clone, disarmed, labelled with its box, snapshot, keep date, kind and reset version, and a template only once Proxmox says so", async () => {
  const state = world();
  const { guest, id } = await box(state);
  const { hooks: snapshotHooks } = tasks();
  await state.backend.snapshot(guest, { id: SNAPSHOT, box: id.boxId, memory: false }, snapshotHooks);
  await state.backend.labelKept({ id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest }, "2026-11-30");
  const vmid = Number(guest.ref);
  const label = state.proxmox.guests.get(vmid)!.snapshots!.find((each) => each.name === snapshotName(SNAPSHOT))!.description;
  assert.deepEqual({ ...parseSnapshotLabel(label)!, install: "" }, { install: "", box: id.boxId, snapshot: SNAPSHOT, reset: null, kept: "2026-11-30" }, "the keep date is on the snapshot's own label");
  const claimed: string[] = [];
  const copy = await state.backend.copySnapshot(
    { id: SNAPSHOT, ref: snapshotName(SNAPSHOT), guest },
    { box: id.boxId, snapshot: SNAPSHOT, kept: "2026-11-30", takenAt: Date.UTC(2026, 9, 31, 14, 21), forkSafe: 7, kind: "linux" },
    { ...tasks().hooks, claimed: async (made) => void claimed.push(made.ref) },
  );
  assert.deepEqual(claimed, [copy.ref], "the copy's VMID is recorded before the clone");
  assert.equal(state.proxmox.calls.filter((call) => call.method === "POST" && call.path.endsWith(`/lxc/${vmid}/clone`) && call.params.snapname === snapshotName(SNAPSHOT)).length, 1, "a clone of the snapshot itself");
  const copied = state.proxmox.guests.get(Number(copy.ref))!;
  for (const tag of ["held-copy", `box.${id.boxId}`, `snapshot.${SNAPSHOT}`, "kept.2026-11-30", "reset.7", "kind.linux", `taken.${Date.UTC(2026, 9, 31, 14, 21) / 1000}`]) assert.match(copied.config.tags ?? "", new RegExp(`(^|;)${tag.replace(/\./g, "\\.")}(;|$)`), tag);
  assert.equal(copied.config.onboot, "0");
  assert.match(copied.config.net0 ?? "", /link_down=1/);
  assert.match(copied.config.description ?? "", new RegExp(`held copy of snapshot ${SNAPSHOT} kept 2026-11-30\n$`));
  state.proxmox.templateLag = 3;
  await state.backend.templateCopy(copy);
  assert.equal(await state.backend.copyState(copy), "template", "templateCopy returns once Proxmox lists it as a template, not when its call answers");
  assert.deepEqual(await state.backend.copyPlan(copy), { state: "template", size: (await state.backend.copyPlan(copy)).size, running: false });
  await state.backend.labelKept({ id: SNAPSHOT, ref: copy.ref, guest: copy, from: "held-copy" }, "2027-01-15");
  assert.match(state.proxmox.guests.get(Number(copy.ref))!.config.tags ?? "", /(^|;)kept\.2027-01-15(;|$)/);
  assert.doesNotMatch(state.proxmox.guests.get(Number(copy.ref))!.config.tags ?? "", /kept\.2026-11-30/);
  const listed = (await state.backend.heldSnapshots()).find((held) => held.where === "held-copy")!;
  assert.equal(listed.keptUntil, Date.UTC(2027, 0, 15, 23, 59, 59, 999));
  assert.equal(listed.forkSafe, 7);
  assert.equal(listed.owner?.kind, "linux");
  assert.equal(listed.takenAt, Date.UTC(2026, 9, 31, 14, 21));
});

test("review 6: the wait for a held copy's template is bounded by 120 s of elapsed time, slow reads included, and stops when it is cancelled", async () => {
  let clock = 0;
  let reads = 0;
  const slow = untilTemplate(
    async () => {
      clock += 5_000;
      reads++;
      return {};
    },
    () => false,
    async (ms) => {
      clock += ms;
    },
    250,
    7001,
    () => clock,
  );
  await assert.rejects(slow, /Proxmox did not make guest 7001 a template within 120 s\./);
  assert.ok(clock >= 120_000 && clock <= 125_000, `stopped after ${clock} ms`);
  assert.equal(reads, 23);
  const stop = new AbortController();
  const cancelled = untilTemplate(
    async () => ({}),
    () => false,
    async () => {
      stop.abort(new Error("bb-box is stopping."));
      throw stop.signal.reason;
    },
    250,
    7002,
    () => 0,
  );
  await assert.rejects(cancelled, /bb-box is stopping/);
  let ready = 0;
  await untilTemplate(async () => (++ready >= 3 ? { template: 1 } : {}), (config) => config.template === 1, async () => {}, 250, 7003, () => 0);
  assert.equal(ready, 3);
});

test("review: a clone's wait grows with its disk, at 3 times bb-box's estimate and never under 180 s, and the task is waited for that long in the same run", async () => {
  assert.equal(cloneWaitMs(null), 180_000);
  assert.equal(cloneWaitMs(16), 180_000);
  assert.equal(cloneWaitMs(100), 720_000, "a 100 GiB disk: 3 times 240 s");
  assert.equal(cloneWaitMs(500), 3_600_000);
  let polls = 0;
  const fetch = async (url: string) => {
    const running = url.includes("/tasks/") && ++polls < 6;
    const body = url.includes("/tasks/") ? { data: running ? { status: "running" } : { status: "stopped", exitstatus: "OK" } } : { data: null };
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
  };
  const options = { apiUrl: "https://pve.example.com:8006/", tokenId: "a@pve!b", tokenSecret: "c", node: "pve", fetch, taskPollMs: 2, taskTimeoutMs: 1, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
  const upid = "UPID:pve:00001:00002:00003:vzclone:7000:root@pam:";
  await assert.rejects(new Proxmox(options).waitTask(upid), /task did not finish in time/, "the default wait gives up");
  polls = 0;
  await new Proxmox(options).waitTask(upid, undefined, 60_000);
  assert.equal(polls, 6, "a longer wait keeps polling until the task ends");
});
