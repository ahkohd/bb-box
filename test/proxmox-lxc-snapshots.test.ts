import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, type LxcBackendOptions } from "../src/backends/proxmox-lxc/backend.ts";
import { keptUntilOf, parseSnapshotLabel, snapshotLabel, snapshotName } from "../src/backends/proxmox/snapshotting.ts";
import type { FetchResponse } from "../src/backends/proxmox/api.ts";
import { SnapshotFailed, SnapshotIncomplete, type AcquireHooks, type BoxIdentity, type Guest, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
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
  return { boxId: `bxsnapshotbox${boxes}`, threadId: "thr_abc123", name: `calm-otter-${boxes}`, kind: "linux", createdAt: 1_790_000_000_000, size: defaultSize(kindSizes("linux")) };
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
  assert.deepEqual(parseSnapshotLabel(label), { install: "inst1", box: "bxamberfox2q7k", snapshot: SNAPSHOT, kept: null });
  assert.deepEqual(parseSnapshotLabel(`${label} kept 2026-11-29`)?.kept, "2026-11-29");
  assert.equal(keptUntilOf("2026-11-29"), Date.UTC(2026, 10, 30) - 1, "kept until the end of the day");
  assert.equal(parseSnapshotLabel("bb-box snapshot research"), null);
  assert.equal(parseSnapshotLabel(`bb-box install inst1 box bx1 snapshot notanid`), null);
});

test("a container offers disk snapshots taken while it runs, and nothing it cannot do yet", () => {
  const { backend } = world();
  assert.deepEqual(backend.snapshotting("linux"), { scope: "box", holds: ["disk"], whileRunning: "live", restore: "none", fork: "none", keepsPastRelease: "no", lives: "host", price: null, excludes: null });
  assert.equal(backend.snapshotting("windows"), null);
});

test("the plan reads the root disk's storage, its use and its thin metadata, and can take a snapshot", async () => {
  const state = world();
  const { guest } = await box(state);
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.deepEqual(plan.storage, { key: "proxmox:pve:local-lvm", name: "local-lvm", type: "lvmthin", percentFull: 33.3, metadataPercentFull: 9.8, metadataUnread: null, totalBytes: 900 * 2 ** 30, usedBytes: 300 * 2 ** 30 });
  assert.deepEqual(plan.take, { ok: true, why: null, aboutMs: 1000, memoryAboutMs: null, addsBytes: 0, memory: null, memoryWhy: null });
  assert.equal(plan.locked, null);
  assert.equal(plan.restore.way, "none");
  assert.equal(plan.fork.ok, false);
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
  assert.deepEqual(listed.map((snapshot) => [snapshot.name, snapshot.description]), [["bbsn7kq2m6xa4pdq", `bb-box install ${state.context.installId} box ${id.boxId} snapshot ${SNAPSHOT}`]]);
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

