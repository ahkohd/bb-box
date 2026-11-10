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

function world(android = false) {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) ssh.windows(`192.0.2.${last}`);
  const proxmox = new FakeProxmox();
  proxmox.addVmTemplate(9104);
  proxmox.addVmTemplate(9120);
  const runtime = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: null };
  const record = { contract: 1, image: "standard", kind: "android", arch: "x86_64", build: "build.20261026-051500-1a2b", built: "2026-10-26T05:15:00Z", os: "Ubuntu 24.04", pins: "p".repeat(64), tools: {}, devices: [{ model: "Pixel 8", native: "pixel_8", runtime }] };
  proxmox.guests.get(9120)!.config.description = JSON.stringify(record);
  const parsed = parseQemuPart({
    id: "proxmox-qemu",
    fields: {
      url: "https://pve.example.com:8006/api2/json",
      "token-id": FAKE_TOKEN.tokenId,
      "token-secret": FAKE_TOKEN.tokenSecret,
      "windows-templates": "9104",
      "linux-templates": android ? "" : "9120",
      "android-templates": android ? "9120" : "",
      "linux-kvm": android,
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

async function windowsBox(state: ReturnType<typeof world>): Promise<{ guest: Guest; vmid: number; box: string }> {
  const box = { boxId: "bxwindowsvmaaa", threadId: "thr_abc123", name: "calm-otter", kind: "windows-desktop", createdAt: 1_790_000_000_000, size: { ...defaultSize(kindSizes("windows-desktop")), gpu: "none" as const } };
  const guest = await state.backend.acquire(box, null, quiet, new AbortController().signal);
  return { guest, vmid: Number(guest.ref), box: box.boxId };
}

async function linuxBox(state: ReturnType<typeof world>): Promise<{ guest: Guest; vmid: number; box: string }> {
  rmSync(join(state.ssh.dir, "windows", "192.0.2.150"), { force: true });
  const box = { boxId: "bxlinuxvmaaaaa", threadId: "thr_abc123", name: "calm-otter", kind: "linux", createdAt: 1_790_000_000_000, size: { ...defaultSize(kindSizes("linux")), gpu: "none" as const } };
  const guest = await state.backend.acquire(box, null, quiet, new AbortController().signal);
  return { guest, vmid: Number(guest.ref), box: box.boxId };
}

function tasks(): { hooks: SnapshotHooks; seen: TaskRef[]; submitted: number[] } {
  const seen: TaskRef[] = [];
  const submitted: number[] = [];
  return { seen, submitted, hooks: { submitting: async () => void submitted.push(seen.length), task: async (task) => void seen.push(task) } };
}

test("a Linux VM offers snapshots of its disk, or its disk and memory, taken while it runs, and forks by a full copy from version 5 of the identity reset; a Windows desktop offers its disk only, with no fork and no Keep", () => {
  const { backend } = world();
  assert.deepEqual(backend.snapshotting("linux"), { scope: "box", holds: ["disk", "disk-and-memory"], whileRunning: "live", restore: "in-place", fork: "copy", forkSafeFrom: 5, keepsPastRelease: "held-copy", lives: "host", price: null, excludes: null });
  assert.deepEqual(backend.snapshotting("windows-desktop"), {
    scope: "box",
    holds: ["disk"],
    whileRunning: "live",
    restore: "in-place",
    fork: "none",
    keepsPastRelease: "no",
    lives: "host",
    price: null,
    excludes: null,
    forkWhy: "a Windows box has no identity reset BB Box has checked, so a copy of it would keep the box's identity",
  });
  assert.equal(backend.snapshotting("android"), null);
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
  const windows = await state.backend.planSnapshots(guest, "windows-desktop", null);
  assert.equal(windows.take.memoryAboutMs, null);
  assert.equal(windows.take.memory, null);
  assert.equal(windows.keep.way, "no");
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
  assert.equal(plan.take.why, `Guest ${vmid}'s efidisk0 is on files, and files (directory, raw files) takes no snapshots, so BB Box takes no snapshot of it.`);
});

test("a memory snapshot is planned on the storage Proxmox saves it to, at twice the VM's memory and 500 MiB, or refused where BB Box cannot tell", async () => {
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
  assert.equal(ambiguous.take.memoryWhy, "Proxmox would save its memory on one of local-lvm, second, and BB Box cannot tell which. Set vmstatestorage on the VM, or take one without memory.");
  assert.equal(ambiguous.take.ok, true, "a disk take is still planned");
  addStorage(state.proxmox, "ceph", "rbd", { shared: 1 });
  state.proxmox.guests.get(vmid)!.config.scsi2 = `ceph:vm-${vmid}-disk-6,size=8G`;
  const shared = await state.backend.planSnapshots(guest, "linux", null);
  assert.equal(shared.take.memory?.storage.name, "ceph", "shared storage first, as Proxmox chooses");
  assert.equal(shared.take.memory?.storage.key, "proxmox:shared:ceph");
  state.proxmox.storageConfigs.delete("ceph");
  assert.match((await state.backend.planSnapshots(guest, "linux", null)).take.memoryWhy ?? "", /^BB Box cannot read the settings of ceph, where one of its disks is/);
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
  let claimed: Guest | null = null;
  const cut = await state.backend.copySnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, { box, snapshot: SNAPSHOT, kept: "2026-11-30" }, { ...tasks().hooks, claimed: async (made) => void (claimed = made) }).catch((caught: unknown) => caught);
  state.proxmox.intercept = undefined;
  assert.ok(cut instanceof Error);
  const part = [...state.proxmox.guests.values()].find((each) => each.vmid !== vmid && each.name.startsWith("bb-box-copy-"))!;
  assert.match(part.config.tags ?? "", new RegExp(`(^|;)box\\.${box}(;|$)`), "it still carries its source's tags");
  const listed = (await state.backend.held()).find((each) => each.ref === String(part.vmid));
  assert.ok(listed, "the sweep sees it");
  assert.equal(listed.owner, null, "as a guest that names no box");
  await state.backend.labelCopy(claimed!, { box, snapshot: SNAPSHOT, kept: "2026-11-30", forkSafe: 7, kind: "linux" });
  for (const tag of ["held-copy", `snapshot.${SNAPSHOT}`, "kept.2026-11-30", "reset.7"]) assert.match(part.config.tags ?? "", new RegExp(`(^|;)${tag.replace(/\./g, "\\.")}(;|$)`), `labelled once its clone ends well: ${tag}`);
  assert.equal(part.config.onboot, "0");
  assert.equal((await state.backend.held()).some((each) => each.ref === String(part.vmid)), false);
  assert.deepEqual((await state.backend.snapshotsOn(guest)).map((held) => held.id), [SNAPSHOT], "one guest's own snapshots, for a release's label check");
});

test("070 unit 7: a VM's fork is a full copy of its snapshot's disk, disarmed first, with new MAC addresses, a new SMBIOS UUID and the address of its own VMID, then armed in two late steps; a Windows VM forks none", async () => {
  const state = world();
  const { guest, vmid, box } = await linuxBox(state);
  await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: true }, tasks().hooks);
  const source = state.proxmox.guests.get(vmid)!;
  const sourceUuid = /uuid=([^,]+)/.exec(source.config.smbios1 ?? "")?.[1];
  const sourceMac = /=([0-9A-F:]{17})/i.exec(source.config.net0 ?? "")?.[1];
  const forked = { boxId: "bxforkedvmaaaa", threadId: "thr_abc123", name: "calm-otter", kind: "linux", createdAt: 1_790_000_100_000, size: { ...defaultSize(kindSizes("linux")), gpu: "none" as const } };
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

  const clones = () => state.proxmox.calls.filter((call) => call.method === "POST" && /\/clone$/.test(call.path)).length;
  const before = clones();
  const refused = await state.backend.forkSnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, { ...forked, kind: "windows-desktop" }, null, quiet, new AbortController().signal).catch((caught: unknown) => caught);
  if (!(refused instanceof BackendError)) throw refused;
  assert.match(refused.message, /forks no windows-desktop boxes: a Windows box has no identity reset BB Box has checked/);
  assert.equal(clones(), before, "a refused Windows fork copies nothing");
});

const UNDO = "snwinundoaaaaa";

test("a Windows desktop on LVM-thin plans a disk snapshot and a snapshot undo, and plans no memory, fork or Keep; Ceph does too", async () => {
  const state = world();
  const { guest } = await windowsBox(state);

  const plan = await state.backend.planSnapshots(guest, "windows-desktop", null);

  assert.equal(plan.storage.type, "lvmthin");
  assert.equal(plan.take.ok, true);
  assert.equal(plan.take.memory, null);
  assert.equal(plan.take.memoryAboutMs, null);
  assert.equal(plan.take.memoryWhy, "A Windows desktop's snapshot holds its disk only.");
  assert.equal(plan.restore.way, "rollback");
  assert.equal(plan.restore.undo, "snapshot");
  assert.equal(plan.fork.ok, false);
  assert.match(plan.fork.why ?? "", /A Windows box has no identity reset BB Box has checked/);
  assert.equal(plan.keep.way, "no");
  assert.match(plan.keep.why ?? "", /keeps a snapshot past a release only when it can fork/);

  state.proxmox.storageTypes.set("local-lvm", "rbd");
  const ceph = await state.backend.planSnapshots(guest, "windows-desktop", null);
  assert.equal(ceph.restore.way, "rollback");
  assert.equal(ceph.restore.undo, "snapshot");
});

test("a Windows desktop's EFI and TPM state volumes are part of its snapshot, and one on raw files refuses the take", async () => {
  const state = world();
  state.proxmox.guests.get(9104)!.config.tpmstate0 = "local-lvm:base-9104-disk-2,size=4M,version=v2.0";
  const { guest, vmid } = await windowsBox(state);
  const vm = state.proxmox.guests.get(vmid)!;

  const ready = await state.backend.planSnapshots(guest, "windows-desktop", null);

  assert.equal(ready.take.ok, true);
  assert.match(String(vm.config.efidisk0), /^local-lvm:/);
  assert.match(String(vm.config.tpmstate0), /^local-lvm:/);

  addStorage(state.proxmox, "files", "dir", { path: "/srv/files" });
  vm.config.tpmstate0 = `files:${vmid}/vm-${vmid}-disk-2.raw,size=4M,version=v2.0`;
  const tpm = await state.backend.planSnapshots(guest, "windows-desktop", null);
  assert.equal(tpm.take.ok, false);
  assert.match(tpm.take.why ?? "", new RegExp(`Guest ${vmid}'s tpmstate0 is on files`));

  vm.config.tpmstate0 = "local-lvm:base-9104-disk-2,size=4M,version=v2.0";
  vm.config.efidisk0 = `files:${vmid}/vm-${vmid}-disk-9.raw,efitype=4m,size=4M`;
  const efi = await state.backend.planSnapshots(guest, "windows-desktop", null);
  assert.equal(efi.take.ok, false);
  assert.match(efi.take.why ?? "", new RegExp(`Guest ${vmid}'s efidisk0 is on files`));
});

test("a Windows desktop on ZFS takes and deletes a snapshot, and restore is refused", async () => {
  const state = world();
  const { guest, vmid, box } = await windowsBox(state);
  state.proxmox.storageTypes.set("local-lvm", "zfspool");

  const plan = await state.backend.planSnapshots(guest, "windows-desktop", null);

  assert.equal(plan.take.ok, true);
  assert.equal(plan.restore.way, "none");
  assert.equal(plan.restore.undo, "none");
  assert.match(plan.restore.why ?? "", /local-lvm is ZFS, which restores only the newest snapshot/);
  assert.match(plan.restore.why ?? "", /held copy/);
  assert.match(plan.restore.why ?? "", /no identity reset BB Box has checked/);
  assert.match(plan.restore.why ?? "", /Take and delete still work here/);

  const taken = await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: false }, tasks().hooks);
  assert.equal(taken.holds, "disk");
  await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks);
  assert.deepEqual(await state.backend.heldSnapshots(), []);
  assert.equal(state.proxmox.guests.has(vmid), true);
});

test("a Windows desktop restores in place to a snapshot and then to its undo, and the VM keeps its identity; a memory take is refused, and Keep is refused", async () => {
  const state = world();
  state.proxmox.guests.get(9104)!.config.tpmstate0 = "local-lvm:base-9104-disk-2,size=4M,version=v2.0";
  const { guest, vmid, box } = await windowsBox(state);
  const vm = state.proxmox.guests.get(vmid)!;

  const memory = await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: true }, tasks().hooks).catch((caught: unknown) => caught);
  if (!(memory instanceof BackendError)) throw memory;
  assert.match(memory.message, /disk only/);
  assert.match(memory.message, /Leave memory out/);
  assert.equal(state.proxmox.calls.some((call) => call.method === "POST" && call.path.endsWith("/snapshot")), false);

  await state.backend.snapshot(guest, { id: SNAPSHOT, box, memory: false }, tasks().hooks);
  assert.equal(state.proxmox.calls.filter((call) => call.method === "POST" && call.path.endsWith("/snapshot")).at(-1)?.params.vmstate, "0");
  const original = { smbios1: vm.config.smbios1, efidisk0: vm.config.efidisk0, tpmstate0: vm.config.tpmstate0, net0: vm.config.net0 };
  vm.config.smbios1 = String(vm.config.smbios1).replace(/uuid=[^,]+/, "uuid=later-uuid");
  vm.config.efidisk0 = "local-lvm:vm-later-efi,efitype=4m,size=4M";
  vm.config.tpmstate0 = "local-lvm:vm-later-tpm,size=4M,version=v2.0";
  const later = { smbios1: vm.config.smbios1, efidisk0: vm.config.efidisk0, tpmstate0: vm.config.tpmstate0 };
  await state.backend.snapshot(guest, { id: UNDO, box, memory: false }, tasks().hooks);

  await state.backend.powerOff(guest);
  await state.backend.rollbackSnapshot(guest, { id: SNAPSHOT, ref: "", guest }, tasks().hooks);
  assert.equal(vm.config.smbios1, original.smbios1);
  assert.equal(vm.config.efidisk0, original.efidisk0);
  assert.equal(vm.config.tpmstate0, original.tpmstate0);
  assert.equal(vm.config.net0, original.net0);
  assert.equal(guest.ref, String(vmid));

  await state.backend.rollbackSnapshot(guest, { id: UNDO, ref: "", guest }, tasks().hooks);
  assert.equal(vm.config.smbios1, later.smbios1);
  assert.equal(vm.config.efidisk0, later.efidisk0);
  assert.equal(vm.config.tpmstate0, later.tpmstate0);
  assert.equal(vm.config.net0, original.net0);
  assert.equal(guest.ref, String(vmid));

  const guests = state.proxmox.guests.size;
  const kept = await state.backend.copySnapshot({ id: SNAPSHOT, ref: `bb${SNAPSHOT}`, guest }, { box, snapshot: SNAPSHOT, kept: "2026-11-30" }, { ...tasks().hooks, claimed: async () => {} }).catch((caught: unknown) => caught);
  if (!(kept instanceof BackendError)) throw kept;
  assert.match(kept.message, /keeps no snapshot of a windows-desktop box past its release: a Windows box has no identity reset BB Box has checked/);
  assert.equal(state.proxmox.guests.size, guests);

  await state.backend.deleteSnapshot({ id: SNAPSHOT, ref: "", guest }, tasks().hooks);
  await state.backend.deleteSnapshot({ id: UNDO, ref: "", guest }, tasks().hooks);
  assert.deepEqual(await state.backend.heldSnapshots(), []);
});


test("Android offers the whole disk live and plans only a snapshot undo, with reasons for memory, fork, Keep and ZFS restore refusals", async () => {
  const state = world(true);
  await state.backend.withheldKinds("android");

  const offer = state.backend.snapshotting("android");
  assert.ok(offer);
  assert.equal(offer.scope, "box");
  assert.deepEqual(offer.holds, ["disk"]);
  assert.equal(offer.whileRunning, "live");
  assert.equal(offer.restore, "in-place");
  assert.equal(offer.fork, "none");
  assert.equal(offer.keepsPastRelease, "no");
  assert.match(offer.forkWhy ?? "", /identity reset/);

  rmSync(join(state.ssh.dir, "windows", "192.0.2.150"), { force: true });
  const guest = await state.backend.acquire({ boxId: "bxandroidaaaaa", threadId: "thr_abc123", name: "calm-otter", kind: "android", createdAt: 1790000000000, size: { ...defaultSize(kindSizes("android")), gpu: "none" } }, null, quiet, new AbortController().signal);

  const plan = await state.backend.planSnapshots(guest, "android", null);
  assert.equal(plan.restore.way, "rollback");
  assert.equal(plan.restore.undo, "snapshot");
  assert.equal(plan.take.memory, null);
  assert.match(plan.take.memoryWhy ?? "", /disk only/);
  assert.equal(plan.fork.ok, false);
  assert.match(plan.fork.why ?? "", /identity reset/);
  assert.equal(plan.keep.way, "no");
  assert.match(plan.keep.why ?? "", /identity reset/);

  state.proxmox.storageTypes.set("local-lvm", "zfspool");
  const zfs = await state.backend.planSnapshots(guest, "android", null);
  assert.equal(zfs.restore.way, "none");
  assert.match(zfs.restore.why ?? "", /ZFS/);
  await assert.rejects(state.backend.snapshot(guest, { id: SNAPSHOT, box: "bxandroidaaaaa", memory: true }, tasks().hooks), /disk only/);
});
