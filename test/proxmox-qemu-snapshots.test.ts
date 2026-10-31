import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProxmoxQemuBackend, type QemuBackendOptions } from "../src/backends/proxmox-qemu/backend.ts";
import { parseQemuPart } from "../src/backends/proxmox-qemu/config.ts";
import { BackendError, type AcquireHooks, type Guest, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, KEY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const made: ProxmoxQemuBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

const SNAPSHOT = "sn7kq2m6xa4pdq";

function world() {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) ssh.windows(`192.0.2.${last}`);
  const proxmox = new FakeProxmox();
  proxmox.addVmTemplate(9104);
  proxmox.addVmTemplate(9120);
  const parsed = parseQemuPart({
    id: "proxmox-qemu",
    fields: {
      url: "https://pve.example.com:8006/api2/json",
      "token-id": FAKE_TOKEN.tokenId,
      "token-secret": FAKE_TOKEN.tokenSecret,
      "windows-templates": "9104",
      "linux-templates": "9120",
      bridge: "vmbr1",
      subnet: "192.0.2.0/24",
      gateway: "192.0.2.1",
      addresses: "192.0.2.150-192.0.2.159",
      "vmid-first": 9700,
      "vmid-last": 9709,
      "ssh-private-key": KEY,
    } as never,
    hosts: [],
  });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const context = testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" });
  const options: QemuBackendOptions = { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 };
  const backend = new ProxmoxQemuBackend(parsed.config, context, options);
  made.push(backend);
  return { ssh, proxmox, backend, context };
}

const quiet: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

async function linuxBox(state: ReturnType<typeof world>): Promise<{ guest: Guest; vmid: number; box: string }> {
  rmSync(join(state.ssh.dir, "windows", "192.0.2.150"), { force: true });
  const box = { boxId: "bxlinuxvmaaaaa", threadId: "thr_abc123", name: "calm-otter", kind: "linux", createdAt: 1_790_000_000_000, size: defaultSize(kindSizes("linux")) };
  const guest = await state.backend.acquire(box, null, quiet, new AbortController().signal);
  return { guest, vmid: Number(guest.ref), box: box.boxId };
}

function tasks(): { hooks: SnapshotHooks; seen: TaskRef[]; submitted: number[] } {
  const seen: TaskRef[] = [];
  const submitted: number[] = [];
  return { seen, submitted, hooks: { submitting: async () => void submitted.push(seen.length), task: async (task) => void seen.push(task) } };
}

test("a Linux VM offers snapshots of its disk, or its disk and memory, taken while it runs, and forks by a full copy from version 5 of the identity reset; a Windows VM offers none yet", () => {
  const { backend } = world();
  assert.deepEqual(backend.snapshotting("linux"), { scope: "box", holds: ["disk", "disk-and-memory"], whileRunning: "live", restore: "in-place", fork: "copy", forkSafeFrom: 5, keepsPastRelease: "held-copy", lives: "host", price: null, excludes: null });
  assert.equal(backend.snapshotting("windows-desktop"), null);
});

test("the plan reads the VM's boot disk's storage and scales a memory snapshot's time to its memory, about a second a GiB", async () => {
  const state = world();
  const { guest } = await linuxBox(state);
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.storage.name, "local-lvm");
  assert.equal(plan.storage.type, "lvmthin");
  assert.equal(plan.take.ok, true);
  const memoryGiB = Number(state.proxmox.guests.get(Number(guest.ref))!.config.memory) / 1024;
  assert.equal(plan.take.memoryAboutMs, 1000 + memoryGiB * 1000);
  await assert.rejects(state.backend.planSnapshots(guest, "windows-desktop", null), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("a take with memory asks Proxmox for the VM's state and holds disk and memory; one without holds the disk; both delete", async () => {
  const state = world();
  const { guest, vmid, box } = await linuxBox(state);
  const { hooks, seen } = tasks();
  const withMemory = await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: true }, hooks);
  assert.equal(withMemory.holds, "disk-and-memory");
  const memoryCall = state.proxmox.calls.find((call) => call.method === "POST" && call.path === `/nodes/pve/qemu/${vmid}/snapshot`);
  assert.equal(memoryCall?.params.vmstate, "1");
  assert.match(seen[0]!.ref, new RegExp(`^UPID:pve:.*:qmsnapshot:${vmid}:`));
  const diskOnly = await state.backend.snapshot(guest, { id: "snbbbbbbbbbbbb", box, memory: false }, hooks);
  assert.equal(diskOnly.holds, "disk");
  assert.equal(state.proxmox.calls.filter((call) => call.method === "POST" && call.path.endsWith("/snapshot")).at(-1)?.params.vmstate, "0");
  const held = await state.backend.heldSnapshots();
  assert.deepEqual(held.map((each) => [each.id, each.holds, each.state]).sort(), [
    ["sn7kq2m6xa4pdq", "disk-and-memory", "complete"],
    ["snbbbbbbbbbbbb", "disk", "complete"],
  ]);
  await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, hooks);
  await state.backend.deleteSnapshot({ id: "snbbbbbbbbbbbb", ref: "", guest }, hooks);
  assert.deepEqual(await state.backend.heldSnapshots(), []);
});

test("a VM's take killed part way is incomplete, and a locked VM names qm unlock", async () => {
  const state = world();
  const { guest, vmid, box } = await linuxBox(state);
  state.proxmox.killNextSnapshot = true;
  await assert.rejects(state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: true }, tasks().hooks), /part-made \(snapstate prepare\)/);
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.deepEqual(plan.locked, { lock: "snapshot", fix: `Run \`qm unlock ${vmid}\` on pve.` });
  await assert.rejects(state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks), new RegExp(`Run \`qm unlock ${vmid}\` on pve, then delete it again\\.`));
});

function addStorage(proxmox: FakeProxmox, name: string, type: string, extra: Record<string, unknown> = {}): void {
  proxmox.storage.set(name, { total: 100 * 2 ** 30, avail: 50 * 2 ** 30 });
  proxmox.storageTypes.set(name, type);
  proxmox.storageConfigs.set(name, { storage: name, type, ...extra });
}

test("the plan checks every disk's storage: an EFI disk on raw files refuses the take", async () => {
  const state = world();
  const { guest, vmid } = await linuxBox(state);
  addStorage(state.proxmox, "files", "dir", { path: "/srv/files" });
  state.proxmox.guests.get(vmid)!.config.efidisk0 = `files:${vmid}/vm-${vmid}-disk-9.raw,efitype=4m,size=4M`;
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, `Guest ${vmid}'s efidisk0 is on files, and files (directory, raw files) takes no snapshots, so bb-box takes no snapshot of it.`);
});

test("a memory snapshot is planned on the storage Proxmox saves it to, at twice the VM's memory and 500 MiB, or refused where bb-box cannot tell", async () => {
  const state = world();
  const { guest, vmid } = await linuxBox(state);
  const memoryMiB = Number(state.proxmox.guests.get(vmid)!.config.memory);
  const first = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(first.take.memory?.storage.name, "local-lvm", "the disks' own storage, with no vmstatestorage");
  assert.equal(first.take.memory?.addsBytes, (memoryMiB * 2 + 500) * 2 ** 20);
  addStorage(state.proxmox, "state", "lvmthin", { vgname: "pve", thinpool: "data" });
  state.proxmox.guests.get(vmid)!.config.vmstatestorage = "state";
  const set = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(set.take.memory?.storage.name, "state");
  assert.equal(set.take.memory?.storage.key, "proxmox:pve:state");
  delete state.proxmox.guests.get(vmid)!.config.vmstatestorage;
  addStorage(state.proxmox, "second", "lvmthin", { vgname: "pve2", thinpool: "data" });
  state.proxmox.guests.get(vmid)!.config.scsi1 = `second:vm-${vmid}-disk-5,size=8G`;
  const ambiguous = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(ambiguous.take.memory, null);
  assert.equal(ambiguous.take.memoryWhy, "Proxmox would save its memory on one of local-lvm, second, and bb-box cannot tell which. Set vmstatestorage on the VM, or take one without memory.");
  assert.equal(ambiguous.take.ok, true, "a disk take is still planned");
  addStorage(state.proxmox, "ceph", "rbd", { shared: 1 });
  state.proxmox.guests.get(vmid)!.config.scsi2 = `ceph:vm-${vmid}-disk-6,size=8G`;
  const shared = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(shared.take.memory?.storage.name, "ceph", "shared storage first, as Proxmox chooses");
  assert.equal(shared.take.memory?.storage.key, "proxmox:shared:ceph");
  state.proxmox.storageConfigs.delete("ceph");
  assert.match((await state.backend.planSnapshots(guest, "linux", null)).take.memoryWhy ?? "", /^bb-box cannot read the settings of ceph, where one of its disks is/);
});

test("a stopped VM's take is refused in words about the box, and its storage key is the pool's, as the container backend's is", async () => {
  const state = world();
  const { guest, vmid } = await linuxBox(state);
  assert.equal((await state.backend.planSnapshots(guest, "linux", null)).storage.key, "proxmox:pve:local-lvm");
  state.proxmox.guests.get(vmid)!.config.lock = "suspended";
  const plan = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, "a stopped Proxmox QEMU box is kept suspended to disk, so start it first.");
  assert.equal(plan.locked, null);
});

test("a VM's held copy cut short before its own labels still carries its source's tags, and the sweep sees it as a guest that names no box, never one to restore", async () => {
  const state = world();
  const { guest, vmid, box } = await linuxBox(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: false }, tasks().hooks);
  state.proxmox.intercept = (call) =>
    call.method === "PUT" && /\/qemu\/\d+\/config$/.test(call.path) && !call.path.endsWith(`/qemu/${vmid}/config`)
      ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "cut short" }) }
      : undefined;
  const cut = await state.backend.copySnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, { box, snapshot: SNAPSHOT, kept: "2026-11-30" }, { ...tasks().hooks, claimed: async () => {} }).catch((caught: unknown) => caught);
  state.proxmox.intercept = undefined;
  assert.ok(cut instanceof Error);
  const part = [...state.proxmox.guests.values()].find((each) => each.vmid !== vmid && each.name.startsWith("bb-box-copy-"))!;
  assert.match(part.config.tags ?? "", new RegExp(`(^|;)box\\.${box}(;|$)`), "it still carries its source's tags");
  const listed = (await state.backend.held()).find((each) => each.ref === String(part.vmid));
  assert.ok(listed, "the sweep sees it");
  assert.equal(listed.owner, null, "as a guest that names no box");
});

test("070 unit 7: a VM's fork is a full copy of its snapshot's disk, disarmed first, with new MAC addresses, a new SMBIOS UUID and the address of its own VMID, then armed in two late steps; a Windows VM forks none", async () => {
  const state = world();
  const { guest, vmid, box } = await linuxBox(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: true }, tasks().hooks);
  const source = state.proxmox.guests.get(vmid)!;
  const sourceUuid = /uuid=([^,]+)/.exec(source.config.smbios1 ?? "")?.[1];
  const sourceMac = /=([0-9A-F:]{17})/i.exec(source.config.net0 ?? "")?.[1];
  const forked = { boxId: "bxforkedvmaaaa", threadId: "thr_abc123", name: "calm-otter", kind: "linux", createdAt: 1_790_000_100_000, size: defaultSize(kindSizes("linux")) };
  const made = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, forked, null, quiet, new AbortController().signal);
  const clone = [...state.proxmox.calls].reverse().find((call) => call.method === "POST" && /\/clone$/.test(call.path))!;
  assert.equal(clone.params.snapname, `bb${SNAPSHOT}`);
  const after = state.proxmox.calls.slice(state.proxmox.calls.lastIndexOf(clone) + 1).find((call) => call.method === "PUT");
  assert.equal(after!.params.onboot, "0", "disarmed in the first request after the clone");
  assert.match(after!.params.net0 ?? "", /link_down=1/);
  const config = state.proxmox.guests.get(Number(made.ref))!.config;
  assert.equal(config.onboot, "0");
  assert.match(config.net0 ?? "", /link_down=1/, "its own MAC and address, with its link still down");
  await state.backend.armFork(made, "network");
  assert.doesNotMatch(state.proxmox.guests.get(Number(made.ref))!.config.net0 ?? "", /link_down/);
  await state.backend.armFork(made, "boot");
  assert.equal(state.proxmox.guests.get(Number(made.ref))!.config.onboot, "1");
  assert.ok(sourceMac && !(config.net0 ?? "").toUpperCase().includes(sourceMac.toUpperCase()), "a MAC of its own");
  assert.match(config.net0 ?? "", /bridge=vmbr1/);
  const uuid = /uuid=([^,]+)/.exec(config.smbios1 ?? "")?.[1];
  assert.ok(uuid && uuid !== sourceUuid, "a new SMBIOS UUID");
  assert.match(config.smbios1 ?? "", new RegExp(`serial=${Buffer.from(`${made.address}/24 192.0.2.1`).toString("base64")}`), "the address of its own VMID, as the VM reads it");
  assert.equal(config.vmstate, undefined, "it starts from the disk, never the saved memory");
  assert.match(config.tags ?? "", /box\.bxforkedvmaaaa/);
  const refused = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, { ...forked, kind: "windows-desktop" }, null, quiet, new AbortController().signal).catch((caught: unknown) => caught);
  assert.ok(refused instanceof BackendError);
});
