import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Guest, GuestIdentity } from "../src/backends/types.ts";
import { OPERATOR, type BoxRecord } from "../src/core/boxes.ts";
import type { Caller, Standing } from "../src/core/snapshot.ts";
import { quote } from "../src/transports/process.ts";
import { tempDir } from "./helpers.ts";
import { forkCheckText, forkedText } from "../src/plugin/snapshot-words.ts";
import { COMMAND, THREAD, flushing, identityGuest, readIn, readyBox, rejection, standing, withIdentitySource, world, writeIn, type World } from "./snapshot-world.ts";

const IDENTITY_SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-identity.sh", import.meta.url));
const SOURCE_MAC = "bc:24:11:aa:f1:b6";
const SOURCE_MACHINE_ID = "0123456789abcdef0123456789abcdef";
const SOURCE_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIsourcekey source";

type FirstBoot = "reset" | "same-mac" | "off" | "no-card" | "late-card" | "source-address";
const SOURCE_ADDRESS = "10.0.0.5";

function links(mac: string | null): string {
  return JSON.stringify(mac ? [{ ifindex: 2, link_index: 900, ifname: "eth0", link_type: "ether", address: mac, link_netnsid: 0, linkinfo: { info_kind: "veth" } }] : []);
}

function toolFor(root: string): { readonly tool: string; readonly bin: string } {
  const dir = tempDir("fork-tool");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ip"), `#!/bin/sh\nif [ "$1" = -o ]; then cat ${quote(join(root, "ip-addr.txt"))} 2>/dev/null; exit 0; fi\nexec cat ${quote(join(root, "ip-link.json"))}\n`, { mode: 0o755 });
  const tool = join(dir, "bb-box-identity");
  writeFileSync(tool, `#!/bin/sh\nPATH=${quote(bin)}:$PATH BBBOX_IDENTITY_ROOT=${quote(root)} BBBOX_IDENTITY_NIC_WAIT_SECONDS=0 BBBOX_IDENTITY_SETTLE_SECONDS=0 exec bash ${quote(IDENTITY_SCRIPT)} "$@"\n`, { mode: 0o755 });
  return { tool, bin };
}

function addressLine(address: string): string {
  return `2: eth0    inet ${address}/24 brd 10.0.0.255 scope global eth0\\       valid_lft forever preferred_lft forever\n`;
}

function withIdentity(root: string): void {
  const write = (path: string, text: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  write("home/box/.bb-machines/bb.example/host-id", "host_source\n");
  write("home/box/.bb-machines/bb.example/auth.json", '{"token":"source"}\n');
  write("home/box/.bb-machines/bb.example/host-artifact.sha256", "abc\n");
  write("home/box/.config/bb-box/env", "GH_TOKEN=source\n");
  write("etc/machine-id", `${SOURCE_MACHINE_ID}\n`);
  write("etc/ssh/ssh_host_ed25519_key", "private\n");
  write("etc/ssh/ssh_host_ed25519_key.pub", `${SOURCE_HOST_KEY}\n`);
  write("var/lib/tailscale/tailscaled.state", '{"_current-profile":"cHJvZmlsZQ==","profile-a1b2":"bm9kZQ=="}\n');
}

interface Forks {
  readonly state: World;
  readonly source: { readonly root: string; readonly tool: string };
  readonly roots: Map<string, string>;
  firstBoot: FirstBoot;
}

function forkWorld(options: { readonly forkWaitMs?: number; readonly markersOn?: boolean } = {}): Forks {
  const source = identityGuest();
  withIdentity(source.root);
  const state = world({ identityTool: source.tool, identityRoot: source.root, forkWaitMs: options.forkWaitMs ?? 300, ...(options.markersOn === false ? { markersOn: false } : {}) });
  withIdentitySource(state, "eth");
  const macs = new Map<string, string>();
  const roots = new Map<string, string>();
  const forks: Forks = { state, source, roots, firstBoot: "reset" };
  let count = 0;
  (state.backend as unknown as Record<string, unknown>).guestIdentity = async (guest: Guest): Promise<GuestIdentity> => ({ macs: { net0: macs.get(guest.ref) ?? SOURCE_MAC.toUpperCase() }, smbios: null });
  state.provider.onForked = async (made) => {
    const root = join(tempDir("fork-root"), "root");
    cpSync(source.root, root, { recursive: true });
    rmSync(join(root, "run"), { recursive: true, force: true });
    const mac = forks.firstBoot === "same-mac" ? SOURCE_MAC : `bc:24:11:0f:0${++count}:2c`;
    writeFileSync(join(root, "ip-link.json"), links(forks.firstBoot === "no-card" || forks.firstBoot === "late-card" ? null : mac));
    macs.set(made.ref, mac.toUpperCase());
    roots.set(made.ref, root);
    writeFileSync(join(root, "ip-addr.txt"), `${addressLine(`10.0.0.${10 + count}`)}${forks.firstBoot === "source-address" ? addressLine(SOURCE_ADDRESS) : ""}`);
    const { tool, bin } = toolFor(root);
    if (forks.firstBoot === "off") assert.equal(spawnSync(tool, ["disable"]).status, 0);
    assert.equal(spawnSync(tool, ["boot"]).status, 0, "the fork's first boot");
    if (forks.firstBoot === "late-card") {
      setTimeout(() => {
        writeFileSync(join(root, "ip-link.json"), links(mac));
        spawnSync(tool, ["settle"]);
      }, 30);
    }
    state.backend.identities.set(made.ref, { tool, root, bin });
  };
  return forks;
}

function fileOf(root: string, path: string): string | null {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
}

async function forked(state: World, box: BoxRecord | null): Promise<BoxRecord> {
  assert.ok(box, "the fork has a box");
  const settled = await state.boxes.settled(box);
  assert.ok(settled);
  return settled;
}

test("070 unit 7, G14: a fork resets at its first boot, bb-box checks that before it is ready, writes its own marker, and its source keeps its identity", async () => {
  const forks = forkWorld();
  const { state, source } = forks;
  const box = await readyBox(state);
  writeIn(state, box, "work/state.txt", "set up");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" })).snapshot!;
  assert.equal(taken.forkSafe, 6);
  assert.deepEqual(taken.identity, { machineId: createHash("sha256").update(`${SOURCE_MACHINE_ID}\n`).digest("hex"), hostKeys: [createHash("sha256").update("AAAAC3NzaC1lZDI1NTE5AAAAIsourcekey\n").digest("hex")] });
  assert.deepEqual(state.store.record(taken.id)?.identity, taken.identity, "kept on the record");
  writeIn(state, box, "work/state.txt", "changed after the take");
  let pinned: string | null = null;
  const onForked = state.provider.onForked!;
  state.provider.onForked = async (made, ref) => {
    const pin = state.store.pins().get(taken.id);
    pinned = pin ? `${pin.kind} ${pin.state}` : null;
    await onForked(made, ref);
  };
  const named = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "set up", { name: box.name }));
  assert.match(named.message, new RegExp(`There is a box called ${box.name} already in this thread`));
  assert.equal(state.store.operations({ box: box.id, kind: "fork" })[0]?.state, "failed", "a fork its box refused is settled at once, so nothing stays pinned");
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up", { name: box.name, asMachine: true });
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(fork.threadId, OPERATOR, "a fork given its source's name, as one of your machines");
  assert.equal(fork.name, box.name);
  assert.notEqual(fork.id, box.id);
  assert.equal(pinned, "fork running", "the source snapshot is pinned while it is forked, so nothing deletes it under the copy");
  assert.equal(readIn(state, fork, "work/state.txt"), "set up", "the fork has the snapshot's files");
  assert.equal(typeof fork.timings.check, "number");
  assert.equal(typeof fork.timings.identity, "number");
  assert.deepEqual(fork.fork?.source, { id: box.id, name: box.name, threadId: THREAD, macs: [SOURCE_MAC.toUpperCase()], address: null });
  const root = forks.roots.get(fork.guest!.ref)!;
  assert.match(fileOf(root, "etc/bb-box/identity") ?? "", new RegExp(`^bb-box identity 1\\nbox ${fork.id}\\nsource eth\\nmac bc:24:11:0f:01:2c\\n$`), "its own marker, written once the check passed");
  assert.equal(fileOf(root, "home/box/.bb-machines/bb.example/host-id"), null);
  assert.equal(fileOf(root, "home/box/.bb-machines/bb.example/auth.json"), null);
  assert.equal(fileOf(root, "home/box/.config/bb-box/env"), null, "the source's access file is gone, and bb-box writes none before the check");
  assert.notEqual(fileOf(root, "etc/machine-id"), `${SOURCE_MACHINE_ID}\n`);
  assert.notEqual(fileOf(root, "etc/ssh/ssh_host_ed25519_key.pub"), `${SOURCE_HOST_KEY}\n`);
  assert.match(fileOf(root, "var/lib/bb-box/identity-resets") ?? "", /BB machines removed: host_source$/m);
  assert.equal(fileOf(source.root, "home/box/.bb-machines/bb.example/host-id"), "host_source\n", "the source keeps its BB machine");
  assert.match(fileOf(source.root, "etc/bb-box/identity") ?? "", new RegExp(`box ${box.id}`));
  const operation = state.store.operation(answer.operation.id)!;
  assert.equal(operation.state, "done");
  assert.equal(state.store.pins().has(taken.id), false, "the pin ends with the fork");
  assert.deepEqual(state.kinds(box.id).filter((kind) => kind.startsWith("fork")), ["fork-asked", "forked"]);
  assert.match(state.log.events(fork.id)[0]?.words ?? "", new RegExp(`^Forked from ${box.name}, "set up" \\(taken 2026-10-30 10:42 UTC\\)\\.$`));
  assert.deepEqual(state.provider.order.filter((step) => step.startsWith("fork")), [`fork ${taken.id}`]);
});

test("070 unit 7, G14: a fork is never handed over when its first boot did not reset (its source's MAC address, its image's reset off, a boot that could not tell) or when it holds its source's address; each is released and the fork fails", async () => {
  const cases: { readonly firstBoot: FirstBoot; readonly why: RegExp }[] = [
    { firstBoot: "same-mac", why: /it has .+'s MAC address bc:24:11:aa:f1:b6, so its identity reset cannot tell it is a copy/ },
    { firstBoot: "off", why: /its boot's identity check says "off", not that it reset/ },
    { firstBoot: "no-card", why: /after 0 s: its first boot could not tell yet whether it is a copy, so no reset has run/ },
    { firstBoot: "source-address", why: /it holds \S+'s address 10\.0\.0\.5, so it would take what is sent to \S+/ },
  ];
  for (const each of cases) {
    const forks = forkWorld();
    forks.firstBoot = each.firstBoot;
    const { state } = forks;
    const box = await state.boxes.update(await readyBox(state), (current) => ({ guest: { ...current.guest!, address: SOURCE_ADDRESS } }));
    await state.snapshots.take(COMMAND, box!, standing(box!), { name: "set up" });
    const answer = await state.snapshots.fork(COMMAND, box!, standing(box!), "set up");
    const fork = await forked(state, answer.box);
    assert.equal(fork.fork?.source.address, SOURCE_ADDRESS);
    assert.equal(fork.state, "failed", each.firstBoot);
    assert.match(fork.error ?? "", each.why, each.firstBoot);
    assert.match(fork.error ?? "", /bb-box released it, so nothing of it acts as /);
    assert.equal(fork.guest, null);
    assert.equal(state.backend.identities.size, 1);
    const [ref] = [...state.backend.identities.keys()];
    assert.equal(await state.backend.power({ ref: ref!, host: null, address: null, size: null, data: { box: fork.id } }), null, `${each.firstBoot}: the fork's guest is gone`);
    assert.equal(state.store.operation(answer.operation.id)?.state, "failed");
    assert.deepEqual(state.kinds(box!.id).filter((kind) => kind.startsWith("fork")), ["fork-asked", "fork-failed"]);
    assert.equal(fileOf(forks.source.root, "home/box/.bb-machines/bb.example/host-id"), "host_source\n");
  }
});

test("070 unit 7: a fork whose card comes after its first boot is held until its settle resets it, then handed over", async () => {
  const forks = forkWorld({ forkWaitMs: 6_000 });
  forks.firstBoot = "late-card";
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const fork = await forked(state, (await state.snapshots.fork(COMMAND, box, standing(box), "set up")).box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.match(fileOf(forks.roots.get(fork.guest!.ref)!, "run/bb-box-identity/boot") ?? "", /^reset/);
});

test("070 unit 7, G14: a snapshot taken without a working identity reset never forks, and nothing is copied", async () => {
  const forks = forkWorld({ markersOn: false });
  const { state } = forks;
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "unarmed" })).snapshot!;
  assert.equal(taken.forkSafe, null);
  assert.equal(taken.identity, null);
  const refused = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "unarmed"));
  assert.equal(refused.code, "unsupported");
  assert.equal(refused.message, `${box.name} had no working identity reset when "unarmed" was taken, so bb-box does not fork it: a copy of it would not give up ${box.name}'s identity, and could act as ${box.name}.`);
  assert.equal(state.provider.order.some((step) => step.startsWith("fork")), false);
  assert.deepEqual(state.store.operations({ box: box.id, kind: "fork" }), []);
  assert.deepEqual((await state.boxes.all()).map((each) => each.id), [box.id]);
});

test("070 unit 7, section 3: an agent forks its own box into its own thread, never one it runs on, another thread's, or as the person's machine; the check refuses as the fork would", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const agent: Caller = { is: "agent", threadId: THREAD };
  const runsOn: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: true };
  assert.match((await rejection(state.snapshots.fork(agent, box, runsOn, "set up"))).message, /That box has no snapshot "set up"/, "on a box it runs on, an agent sees only what it took");
  await state.snapshots.take(agent, box, runsOn, { name: "mine" });
  const own = await rejection(state.snapshots.fork(agent, box, runsOn, "mine"));
  assert.equal(own.code, "not_owner");
  assert.match(own.message, /That is the person's to do/, "a fork of a box an agent runs on is the person's");
  const other: Caller = { is: "agent", threadId: "thr_other" };
  assert.match((await rejection(state.snapshots.fork(other, box, standing(box), "set up"))).message, /This thread has no such snapshot|That box has no snapshot/);
  assert.equal((await rejection(state.snapshots.fork(agent, box, standing(box), "set up", { asMachine: true }))).code, "not_owner");
  const check = await state.snapshots.checkFork(agent, box, standing(box), "set up");
  assert.equal(check.threadId, THREAD);
  assert.equal(check.asMachine, false);
  assert.deepEqual(state.provider.order.filter((step) => step.startsWith("fork")), [], "a check changes nothing");
  const answer = await state.snapshots.fork(agent, box, standing(box), "set up", { request: "fork-1" });
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(fork.threadId, THREAD);
  const again = await state.snapshots.fork(agent, box, standing(box), "set up", { request: "fork-1" });
  assert.equal(again.repeated, true);
  assert.equal(again.box?.id, fork.id, "a repeated request is the same fork");
  assert.equal((await state.boxes.list(THREAD)).length, 2);
});

test("070 unit 7: a fork its backend cannot copy fails with the backend's words, leaves nothing, and settles its operation", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  state.provider.forkWhy = "The Proxmox token lacks VM.Clone on /pool/bbbox.";
  assert.match((await rejection(state.snapshots.fork(COMMAND, box, standing(box), "set up"))).message, /cannot fork "set up" of box .+: The Proxmox token lacks VM\.Clone/);
  state.provider.forkWhy = null;
  state.provider.forkFault = new Error("Proxmox's copy of snapshot bbsn of guest g1 failed: out of space");
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", /out of space/);
  assert.equal(state.store.operation(answer.operation.id)?.state, "failed");
  assert.equal(state.store.pins().size, 0);
});

test("070 unit 7: after a restart a fork's operation is settled by its box: done once ready, failed once gone, and left while it is still acquiring", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready");
  state.store.updateOperation(answer.operation.id, { state: "running", step: "acquiring", endedAt: null });
  await state.restart();
  assert.equal(await state.snapshots.recover(), 1);
  assert.equal(state.store.operation(answer.operation.id)?.state, "done");
  state.store.updateOperation(answer.operation.id, { state: "running", step: "acquiring", endedAt: null });
  await state.boxes.release(fork.threadId, fork.id, "a test");
  await state.boxes.settled(fork);
  await state.snapshots.recover();
  assert.equal(state.store.operation(answer.operation.id)?.state, "failed");
  assert.match(state.store.operation(answer.operation.id)?.error ?? "", /its box is gone|released/);
});

test("070 unit 7: a fork starts with up to 180 s for its first boot, and a fork of a snapshot taken without a flush says it may lack the last writes too", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  flushing(state, async () => ({ exitCode: 1, stdout: "", stderr: "sync: Input/output error" }));
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "unflushed" })).snapshot!;
  assert.equal(taken.forkSafe, 6);
  assert.equal(taken.unflushed, "sync: Input/output error");
  const check = await state.snapshots.checkFork(COMMAND, box, standing(box), "unflushed");
  assert.match(forkCheckText(check), /\nThe snapshot may miss what the box wrote in its last seconds before it: bb-box could not flush the box's writes to its disk before it \(sync: Input\/output error\), so the fork may lack them too\.\n/);
  state.provider.order.length = 0;
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "unflushed");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.ok(state.provider.order.includes("start within 180 s"), state.provider.order.join(", "));
  assert.match(forkedText(answer, fork), /so the fork may lack them too\.$/);
  assert.match(state.log.events(box.id).find((event) => event.kind === "fork-asked")?.words ?? "", /The snapshot may miss the box's last writes before it\.$/);
});
