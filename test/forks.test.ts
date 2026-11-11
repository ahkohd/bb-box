import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BackendError, type Backend, type Guest, type GuestIdentity, type LeasedAddressNow } from "../src/backends/types.ts";
import { BoxError, OPERATOR, errorForAgent, type BoxRecord } from "../src/core/boxes.ts";
import type { Caller, Standing } from "../src/core/snapshot.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { quote } from "../src/transports/process.ts";
import { tempDir } from "./helpers.ts";
import { forkCheckText, forkedText } from "../src/plugin/snapshot-words.ts";
import { forkPreview, forkWhyOf } from "../src/plugin/snapshot-card.ts";
import { IDENTITY_TOOL, forkCheckScript, forkSafetyOf, forkSafetyScript, forkVerdict, parseForkSeen, type ForkSeen } from "../src/core/identity.ts";
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
  readonly macsAfterRestart: () => void;
  firstBoot: FirstBoot;
  forkClientId: string | null;
}

function withLease(root: string, clientId: string): void {
  mkdirSync(join(root, "run/systemd/netif/leases"), { recursive: true });
  writeFileSync(join(root, "run/systemd/netif/leases/2"), `# This is private data. Do not parse.\nADDRESS=10.0.0.5\nCLIENTID=${clientId}\n`);
}

function forkWorld(options: { readonly forkWaitMs?: number; readonly markersOn?: boolean; readonly wholeCards?: boolean; readonly projectsFromBb?: boolean } = {}): Forks {
  const source = identityGuest();
  withIdentity(source.root);
  const state = world({ identityTool: source.tool, identityRoot: source.root, forkWaitMs: options.forkWaitMs ?? 300, ...(options.markersOn === false ? { markersOn: false } : {}), ...(options.wholeCards !== undefined ? { wholeCards: options.wholeCards } : {}), ...(options.projectsFromBb ? { projectsFromBb: true } : {}) });
  withIdentitySource(state, "eth");
  const macs = new Map<string, string>();
  const roots = new Map<string, string>();
  const giveMacs = () => {
    (state.backend as unknown as Record<string, unknown>).guestIdentity = async (guest: Guest): Promise<GuestIdentity> => ({ macs: { net0: macs.get(guest.ref) ?? SOURCE_MAC.toUpperCase() }, smbios: null });
  };
  giveMacs();
  const forks: Forks = { state, source, roots, macsAfterRestart: giveMacs, firstBoot: "reset", forkClientId: null };
  let count = 0;
  state.provider.onForked = async (made) => {
    const root = join(tempDir("fork-root"), "root");
    cpSync(source.root, root, { recursive: true });
    rmSync(join(root, "run"), { recursive: true, force: true });
    if (forks.forkClientId) withLease(root, forks.forkClientId);
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

test("070 unit 7, G14: a fork resets at its first boot, BB Box checks that before it is ready, writes its own marker, and its source keeps its identity", async () => {
  const forks = forkWorld();
  const { state, source } = forks;
  const box = await readyBox(state);
  writeIn(state, box, "work/state.txt", "set up");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" })).snapshot!;
  assert.equal(taken.forkSafe, 9);
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
  assert.equal(fileOf(root, "home/box/.config/bb-box/env"), null, "the source's access file is gone, and BB Box writes none before the check");
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
  const steps = state.provider.order.filter((step) => /^(fork|arm|start)/.test(step));
  assert.deepEqual(steps, [`fork ${taken.id}`, `arm network ${fork.guest!.ref}`, "start within 180 s", `arm boot ${fork.guest!.ref}`], "links come up just before the first start, and onboot only once the check passed");
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
    assert.match(fork.error ?? "", /BB Box released it, so nothing of it acts as /);
    assert.equal(fork.guest, null);
    assert.equal(state.backend.identities.size, 1);
    const [ref] = [...state.backend.identities.keys()];
    assert.equal(await state.backend.power({ ref: ref!, host: null, address: null, size: null, data: { box: fork.id } }), null, `${each.firstBoot}: the fork's guest is gone`);
    assert.equal(state.store.operation(answer.operation.id)?.state, "failed");
    assert.deepEqual(state.kinds(box!.id).filter((kind) => kind.startsWith("fork")), ["fork-asked", "fork-failed"]);
    assert.equal(fileOf(forks.source.root, "home/box/.bb-machines/bb.example/host-id"), "host_source\n");
  }
});

const SOURCE_CLIENT_ID = "01bc2411aaf1b6";
const FORK_CLIENT_ID = "01bc24110f012c";

test("where addresses are leased, a fork on its stopped source's last address is handed over only when the snapshot holds its source's DHCP client IDs and the fork shows its own; it is refused while its source runs or is suspended on its lease or recorded address, when the source cannot be read, and always where addresses are static", async () => {
  type Source = LeasedAddressNow | "unreadable" | "static";
  const cases: { readonly name: string; readonly source: Source; readonly recorded?: string; readonly held: boolean; readonly fork: string | null; readonly why: RegExp | null }[] = [
    { name: "stopped, its own client ID", source: { power: "stopped", leased: null }, held: true, fork: FORK_CLIENT_ID, why: null },
    { name: "gone, its own client ID", source: { power: "gone", leased: null }, held: true, fork: FORK_CLIENT_ID, why: null },
    { name: "stopped, a snapshot that holds no client ID", source: { power: "stopped", leased: null }, held: false, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take what is sent to \S+/ },
    { name: "gone, a snapshot that holds no client ID", source: { power: "gone", leased: null }, held: false, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take/ },
    { name: "stopped, a fork with no lease file", source: { power: "stopped", leased: null }, held: true, fork: null, why: /after 0 s: it holds \S+'s last address 10\.0\.0\.5, and has no DHCP lease on record yet to show that it asked for it as itself/ },
    { name: "stopped, a fork with its source's client ID", source: { power: "stopped", leased: null }, held: true, fork: SOURCE_CLIENT_ID, why: /it asked for its address with \S+'s DHCP client ID/ },
    { name: "running, on its recorded address", source: { power: "running", leased: "10.0.0.8" }, held: true, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take/ },
    { name: "running, on its lease", source: { power: "running", leased: SOURCE_ADDRESS }, recorded: "10.0.0.8", held: true, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take/ },
    { name: "suspended, on its recorded address", source: { power: "suspended", leased: null }, held: true, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take/ },
    { name: "unreadable", source: "unreadable", held: true, fork: FORK_CLIENT_ID, why: /it could not read the address \S+ holds now, so it cannot tell that the fork does not take it: Reading it failed: the Mac did not answer\. BB Box released it/ },
    { name: "static", source: "static", held: true, fork: FORK_CLIENT_ID, why: /it holds \S+'s address 10\.0\.0\.5, so it would take/ },
  ];
  for (const each of cases) {
    const forks = forkWorld({ forkWaitMs: 0 });
    forks.firstBoot = "source-address";
    forks.forkClientId = each.fork;
    const { state } = forks;
    if (each.held) withLease(forks.source.root, SOURCE_CLIENT_ID);
    const asked: string[] = [];
    const source = each.source;
    if (source !== "static") {
      Object.assign(state.backend, {
        leasedAddressNow: async (guest: Guest): Promise<LeasedAddressNow> => {
          asked.push(guest.ref);
          if (source === "unreadable") throw new Error("the Mac did not answer");
          return source;
        },
      });
    }
    const recorded = each.recorded ?? SOURCE_ADDRESS;
    const box = (await state.boxes.update(await readyBox(state), (current) => ({ guest: { ...current.guest!, address: recorded } })))!;
    const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" })).snapshot!;
    assert.equal(taken.identity?.dhcpClientIds?.length ?? 0, each.held ? 1 : 0, `${each.name}: the client IDs the snapshot holds`);
    const fork = await forked(state, (await state.snapshots.fork(COMMAND, box, standing(box), "set up")).box);
    assert.ok(source === "static" ? asked.length === 0 : asked.every((ref) => ref === box.guest!.ref) && asked.length > 0, `${each.name}: the source's guest is asked`);
    if (each.why === null) {
      assert.equal(fork.state, "ready", `${each.name}: ${fork.error ?? ""}`);
      continue;
    }
    assert.equal(fork.state, "failed", each.name);
    assert.match(fork.error ?? "", each.why, each.name);
    assert.equal(fork.guest, null, `${each.name}: the fork's guest is released`);
    if (each.fork === null) assert.ok(asked.length > 1, `${each.name}: the source is read again at each look, ${asked.length} times`);
  }
});

test("a source's start waits until its fork's check has passed and the fork is armed", async () => {
  const forks = forkWorld();
  forks.firstBoot = "source-address";
  forks.forkClientId = FORK_CLIENT_ID;
  const { state } = forks;
  withLease(forks.source.root, SOURCE_CLIENT_ID);
  const box = (await state.boxes.update(await readyBox(state), (current) => ({ guest: { ...current.guest!, address: SOURCE_ADDRESS } })))!;
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  await state.boxes.stop(THREAD, box.name);
  const order: string[] = [];
  const start = state.backend.start!.bind(state.backend);
  const armFork = (state.backend as Backend).armFork!.bind(state.backend);
  let starting: Promise<unknown> | null = null;
  Object.assign(state.backend, {
    start: async (guest: Guest, ...rest: [AbortSignal?, ((step: string, ms: number) => void)?, (() => Promise<void>)?]) => {
      const started = await start(guest, ...rest);
      if (guest.ref === box.guest!.ref) order.push("source started");
      return started;
    },
    armFork: async (guest: Guest, arming: "network" | "boot", signal?: AbortSignal) => {
      await armFork(guest, arming, signal);
      if (arming === "boot") order.push("fork armed");
    },
    leasedAddressNow: async (guest: Guest): Promise<LeasedAddressNow> => {
      order.push("source read");
      const power = await state.backend.power(guest);
      if (!starting) {
        starting = state.boxes.start(THREAD, box.name);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { power: power === "running" ? "running" : "stopped", leased: power === "running" ? SOURCE_ADDRESS : null };
    },
  });
  const fork = await forked(state, (await state.snapshots.fork(COMMAND, box, standing(box), "set up")).box);
  await starting;
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.deepEqual(order, ["source read", "fork armed", "source started"]);
});

test("a fork records the address its first start found, as a Tart VM's from the Mac's DHCP, and is refused when it does not hold it", async () => {
  for (const [address, why] of [["10.0.0.11", null], ["10.0.0.99", /it does not hold its own address 10\.0\.0\.99, only 10\.0\.0\.11/]] as const) {
    const forks = forkWorld();
    const { state } = forks;
    const box = await readyBox(state);
    await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
    state.backend.startAddress = address;
    const fork = await forked(state, (await state.snapshots.fork(COMMAND, box, standing(box), "set up")).box);
    if (why === null) {
      assert.equal(fork.state, "ready", fork.error ?? "");
      assert.equal(fork.guest?.address, address);
      continue;
    }
    assert.equal(fork.state, "failed");
    assert.match(fork.error ?? "", why);
  }
});

test("a fork that asked for its address with its source's DHCP client ID is refused, as a DHCP server would take it for its source; one with a client ID of its own is handed over", () => {
  const sourceClientId = createHash("sha256").update("01bc2411aaf1b6").digest("hex");
  const own = createHash("sha256").update("01bc24110f012c").digest("hex");
  const expected = { ...EXPECTED, held: { ...EXPECTED.held, dhcpClientIds: [sourceClientId] } };
  assert.deepEqual(forkVerdict(parseForkSeen(seenLines([...WHOLE, `dhcp_client_id=${own}`]), 0), expected), { is: "ready" });
  const same = forkVerdict(parseForkSeen(seenLines([...WHOLE, `dhcp_client_id=${sourceClientId}`]), 0), expected);
  assert.equal(same.is, "refused");
  assert.match((same as { why: string }).why, /^it asked for its address with amber-fox's DHCP client ID, so a DHCP server takes it for amber-fox and may give it amber-fox's address$/);
  assert.deepEqual(forkVerdict(parseForkSeen(seenLines([...WHOLE, `dhcp_client_id=${sourceClientId}`]), 0), EXPECTED), { is: "ready" }, "a snapshot that held no client ID, from before BB Box read them, is checked as before");
  const unreadable = forkVerdict(parseForkSeen(seenLines([...WHOLE, "unreadable=/run/systemd/netif/leases/2"]), 0), expected);
  assert.match((unreadable as { why: string }).why, /could not read \/run\/systemd\/netif\/leases\/2 in it/);
});

test("a fork may hold its source's freed address only when its source is gone and its provider says it gave that address to the fork", () => {
  const freed = { ...EXPECTED, sourceAddresses: [], freedSourceAddresses: ["10.0.0.6"], ownAddress: null, boxAddresses: [] };
  const holdsFreed = parseForkSeen(seenLines(WHOLE), 0);

  const gone = forkVerdict(holdsFreed, { ...freed, sourceGone: true, givenByProvider: ["10.0.0.6"] });
  const stopped = forkVerdict(holdsFreed, { ...freed, sourceGone: false, givenByProvider: ["10.0.0.6"] });
  const unproven = forkVerdict(holdsFreed, { ...freed, sourceGone: true, givenByProvider: ["10.0.0.7"] });
  const running = forkVerdict(holdsFreed, { ...freed, sourceAddresses: ["10.0.0.6"], freedSourceAddresses: [], sourceGone: false, givenByProvider: ["10.0.0.6"] });

  assert.deepEqual(gone, { is: "ready" });
  for (const verdict of [stopped, unproven, running]) assert.deepEqual(verdict, { is: "refused", why: "it holds amber-fox's address 10.0.0.6, so it would take what is sent to amber-fox" });
});

test("the identity a snapshot holds and the fork check read the DHCP client ID of each systemd-networkd lease, hashed", () => {
  const root = join(tempDir("client-id"), "root");
  const bin = join(root, "..", "bin");
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, { mode });
  };
  put(join(root, "etc/machine-id"), `${SOURCE_MACHINE_ID}\n`);
  put(join(root, "etc/ssh/ssh_host_ed25519_key.pub"), `${SOURCE_HOST_KEY}\n`);
  put(join(root, "run/systemd/netif/leases/2"), "# This is private data. Do not parse.\nADDRESS=192.168.64.5\nSERVER_ADDRESS=192.168.64.1\nLIFETIME=1h\nCLIENTID=01f6839d58e72c\n");
  put(join(root, "run/systemd/netif/leases/3"), "ADDRESS=10.0.0.9\n");
  put(join(root, "etc/bb-box/identity"), "bb-box identity 1\nsource eth\nmac bc:24:11:0f:01:2c\n");
  put(join(bin, "bb-box-identity"), `#!/bin/sh\nprintf '${STATUS_RESET.replaceAll("\n", "\\n")}\\n'\n`, 0o755);
  put(join(bin, "id"), "#!/bin/sh\necho 0\n", 0o755);
  const run = (script: string) => spawnSync("/bin/sh", ["-c", script.replaceAll(IDENTITY_TOOL, join(bin, "bb-box-identity"))], { encoding: "utf8", env: { BBBOX_IDENTITY_ROOT: root, PATH: `${bin}:${process.env.PATH ?? ""}` } });
  const clientId = createHash("sha256").update("01f6839d58e72c").digest("hex");
  const held = run(forkSafetyScript());
  assert.deepEqual(forkSafetyOf(held.stdout, held.status).identity?.dhcpClientIds, [clientId], held.stderr);
  const checked = run(forkCheckScript());
  const seen = parseForkSeen(checked.stdout, checked.status);
  assert.deepEqual([seen.identity.dhcpClientIds, seen.unreadable], [[clientId], []], checked.stderr);
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
  assert.equal(refused.message, `${box.name} had no working identity reset when "unarmed" was taken, so BB Box does not fork it: a copy of it would not give up ${box.name}'s identity, and could act as ${box.name}.`);
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
  assert.equal(taken.forkSafe, 9);
  assert.equal(taken.unflushed, "sync: Input/output error");
  const check = await state.snapshots.checkFork(COMMAND, box, standing(box), "unflushed");
  assert.match(forkCheckText(check), /\nThe snapshot may miss what the box wrote in its last seconds before it: BB Box could not flush the box's writes to its disk before it \(sync: Input\/output error\), so the fork may lack them too\.\n/);
  state.provider.order.length = 0;
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "unflushed");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.ok(state.provider.order.includes("start within 180 s"), state.provider.order.join(", "));
  assert.match(forkedText(answer, fork), /so the fork may lack them too\.$/);
  assert.match(state.log.events(box.id).find((event) => event.kind === "fork-asked")?.words ?? "", /The snapshot may miss the box's last writes before it\.$/);
});

function seenLines(lines: readonly string[]): string {
  return [...lines, "probes=done"].join("\n");
}

const STATUS_RESET = "version=7\nenabled=yes\nboot=reset\nmarker=matches\narmed=yes\npending=no\nbox=\nsource=eth";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const EXPECTED = { forkMacs: ["BC:24:11:0F:01:2C"], forkValue: null, sourceMacs: ["BC:24:11:AA:F1:B6"], sourceBox: "bxsource", sourceName: "amber-fox", sourceAddresses: ["10.0.0.5"], freedSourceAddresses: [], ownAddress: "10.0.0.6", boxAddresses: ["10.0.0.5", "10.0.0.6", "10.0.0.7"], held: { machineId: HASH_A, hostKeys: [HASH_A] }, safeFrom: 7 };
const WHOLE = [STATUS_RESET, `machine_id=${HASH_B}`, `host_key=${HASH_B}`, "tailnet_node=no", "marker_mac=bc:24:11:0f:01:2c", "address=10.0.0.6", "addresses_read=yes"];

test("070 unit 7 reviews: the check before ready needs every observation read, its own address and no other box's, an armed marker, and a version the backend forks from; an address or MAC of another box refuses at once, before any wait", () => {
  assert.deepEqual(forkVerdict(parseForkSeen(seenLines(WHOLE), 0), EXPECTED), { is: "ready" });
  const cases: readonly [string, readonly string[], RegExp][] = [
    ["the check stopped part way", WHOLE, /its check stopped part way/],
    ["no address read", WHOLE.filter((line) => line !== "addresses_read=yes"), /could not read its addresses/],
    ["no Tailscale read", WHOLE.filter((line) => line !== "tailnet_node=no"), /could not read its Tailscale state/],
    ["an unreadable host key", [...WHOLE, "unreadable=/etc/ssh/ssh_host_ed25519_key.pub"], /could not read \/etc\/ssh\/ssh_host_ed25519_key\.pub in it/],
    ["an empty machine ID", WHOLE.map((line) => (line.startsWith("machine_id=") ? "machine_id=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" : line)), /could not read machine-id/],
    ["no host keys", [...WHOLE.filter((line) => !line.startsWith("host_key=")), "missing=ssh-host-keys"], /it has no SSH host keys, which its reset makes/],
    ["no address of its own", WHOLE.filter((line) => line !== "address=10.0.0.6"), /it does not hold its own address 10\.0\.0\.6, nor any other/],
    ["another box's address", [...WHOLE, "address=10.0.0.7"], /it holds 10\.0\.0\.7, another box's address/],
    ["a marker not armed", WHOLE.map((line) => line.replace("armed=yes", "armed=no")), /its identity marker is not armed/],
    ["an older version", WHOLE.map((line) => line.replace("version=7", "version=6")), /it has version 6 of the identity reset, and BB Box forks only from version 7 there/],
    ["the reset off", WHOLE.map((line) => line.replace("enabled=yes", "enabled=no")), /its identity reset is off/],
  ];
  for (const [name, lines, why] of cases) {
    const stdout = name === "the check stopped part way" ? lines.join("\n") : seenLines(lines);
    const verdict = forkVerdict(parseForkSeen(stdout, 0), EXPECTED);
    assert.equal(verdict.is, "refused", name);
    assert.match((verdict as { why: string }).why, why, name);
  }
  const unknown = WHOLE.map((line) => line.replace("boot=reset", "boot=unknown")).filter((line) => line !== "address=10.0.0.6");
  assert.equal(forkVerdict(parseForkSeen(seenLines(unknown), 0), EXPECTED).is, "wait", "a boot that cannot tell yet, with no address yet, is waited for");
  const stolen = forkVerdict(parseForkSeen(seenLines([...unknown, "address=10.0.0.5"]), 0), EXPECTED);
  assert.equal(stolen.is, "refused", "its source's address refuses at once, even while it waits");
  assert.match((stolen as { why: string }).why, /it holds amber-fox's address 10\.0\.0\.5/);
  const sharedMac = forkVerdict(parseForkSeen(seenLines(unknown), 0), { ...EXPECTED, forkMacs: ["BC:24:11:AA:F1:B6"] });
  assert.match((sharedMac as { why: string }).why, /it has amber-fox's MAC address/);
});

test("070 unit 7 reviews: a snapshot from an identity reset older than its backend forks from is refused before anything is copied, and the page says why", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "older" })).snapshot!;
  const backend = state.backend as Backend;
  const offered = backend.snapshotting!(box.kind)!;
  (state.backend as unknown as Record<string, unknown>).snapshotting = () => ({ ...offered, forkSafeFrom: 10 });
  const refused = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "older"));
  assert.equal(refused.code, "unsupported");
  assert.match(refused.message, new RegExp(`^${box.name} had version 9 of the identity reset when "older" was taken, and BB Box forks .+ only from version 10`));
  assert.equal(state.provider.order.some((step) => step.startsWith("fork")), false);
  assert.match(forkWhyOf(state.store.record(taken.id)!, backend.snapshotting!(box.kind)) ?? "", /had an identity reset older than version 10 when it was taken/);
  const ofBox = await rejection(state.snapshots.checkForkOfBox(COMMAND, box, standing(box)));
  assert.match(ofBox.message, /has version 9 of the identity reset, and BB Box forks .+ only from version 10/);
});

test("070 unit 7 reviews: a fork whose guest cannot be deleted keeps its guest and its operation unsettled, says so, and the sweep deletes it later", async () => {
  const forks = forkWorld();
  forks.firstBoot = "same-mac";
  const { state } = forks;
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" })).snapshot!;
  state.backend.faults.release = new Error("CT is locked (clone)");
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "failed");
  assert.ok(fork.guest, "the guest is kept on the record, so it is not lost");
  assert.match(fork.error ?? "", /BB Box could not delete its guest \S+ yet \(CT is locked \(clone\)\), so it stopped it\. It tries again at each sweep, and never hands the fork over\.$/);
  assert.doesNotMatch(fork.error ?? "", /released it/);
  assert.equal(await state.backend.power(fork.guest!), "stopped");
  assert.equal(state.store.operation(answer.operation.id)?.state, "unknown");
  assert.equal(state.store.pins().has(taken.id), true, "its snapshot stays pinned while a copy of it is left");
  await state.snapshots.recover();
  assert.equal(state.store.operation(answer.operation.id)?.state, "unknown", "recovery does not settle it while the guest is there");
  await state.boxes.sweep();
  const after = (await state.boxes.find(fork.id))!;
  assert.equal(after.guest, null);
  assert.match(after.error ?? "", /BB Box released it, so nothing of it acts as /);
  assert.equal(await state.backend.power(fork.guest!), null);
  assert.equal(state.store.operation(answer.operation.id)?.state, "failed");
  assert.equal(state.store.pins().has(taken.id), false);
});

test("070 unit 7 reviews: a person's fork of a kept snapshot is one of their machines, with no choice of thread; a bad name is refused before anything is recorded", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept" })).snapshot!;
  state.store.updateRecord(taken.id, { keptUntil: state.now + 30 * 24 * 60 * 60_000, keptAt: state.now, owner: "person" });
  const check = await state.snapshots.checkFork(COMMAND, box, standing(box), "kept");
  assert.equal(check.asMachine, true);
  assert.equal(check.threadId, OPERATOR);
  const preview = await forkPreview(state.snapshots, box, standing(box), "kept", false);
  assert.equal(preview.check?.asMachine, true);
  assert.equal(preview.check?.canBeMachine, false, "the page offers no thread for it");
  for (const name of ["Calm Otter", "calm_otter", "otter-", "a".repeat(33), "bxsome\nthing"]) {
    const refused = await rejection(state.snapshots.fork(COMMAND, box, standing(box), "kept", { name }));
    assert.equal(refused.code, "invalid_name", JSON.stringify(name));
  }
  assert.deepEqual(state.store.operations({ box: box.id, kind: "fork" }), [], "nothing recorded");
  assert.equal((await state.boxes.all()).length, 1);
});

test("070 unit 7 reviews: before box_fork takes a snapshot, the box is checked as a fork of it would be: who may, a box an agent runs on, its reset now", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.checkForkOfBox(COMMAND, box, standing(box));
  const agent: Caller = { is: "agent", threadId: THREAD };
  const runsOn: Standing = { box: { id: box.id, threadId: THREAD }, runsOn: true };
  assert.equal((await rejection(state.snapshots.checkForkOfBox(agent, box, runsOn))).code, "not_owner");
  assert.equal((await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box), { asMachine: true }))).code, "not_owner");
  state.provider.forkWhy = "The Proxmox token lacks VM.Clone on /pool/bbbox.";
  assert.match((await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box)))).message, /lacks VM\.Clone/);
  state.provider.forkWhy = null;
  writeFileSync(join(forks.source.root, "etc/bb-box/identity"), "garbled\n");
  assert.match((await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box)))).message, /has no working identity reset now/);
  assert.equal(state.store.records({ box: box.id }).length, 0, "the checks take nothing");
});

function probedFork(): { readonly root: string; readonly breakTool: (name: string) => void; readonly seen: () => ForkSeen } {
  const root = join(tempDir("fork-probe"), "root");
  const bin = join(root, "..", "bin");
  mkdirSync(bin, { recursive: true });
  const put = (path: string, text: string, mode?: number) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text, mode === undefined ? {} : { mode });
  };
  put(join(root, "etc/machine-id"), "fedcba9876543210fedcba9876543210\n");
  put(join(root, "etc/ssh/ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAInewkey fork\n");
  put(join(root, "etc/bb-box/identity"), "mac bc:24:11:0f:01:2c\n");
  put(join(root, "var/lib/tailscale/tailscaled.state"), '{"_current-profile":"cHJvZmlsZQ=="}\n');
  const tool = join(bin, "bb-box-identity");
  put(tool, `#!/bin/sh\nprintf '%s\\n' ${quote(STATUS_RESET)}\n`, 0o755);
  put(join(bin, "id"), "#!/bin/sh\necho 0\n", 0o755);
  put(join(bin, "ip"), `#!/bin/sh\necho ${quote(addressLine("10.0.0.6").trim())}\n`, 0o755);
  return {
    root,
    breakTool: (name) => put(join(bin, name), `#!/bin/sh\necho "${name}: simulated Input/output error" >&2\nexit 2\n`, 0o755),
    seen: () => {
      const ran = spawnSync("sh", ["-c", forkCheckScript().replaceAll(IDENTITY_TOOL, tool)], { encoding: "utf8", env: { ...process.env, BBBOX_IDENTITY_ROOT: root, PATH: `${bin}:${process.env.PATH}` } });
      return parseForkSeen(ran.stdout, ran.status);
    },
  };
}

test("070 unit 7 re-review: a probe that fails to read the fork's Tailscale state, hash its machine ID or read its marker says it could not, and the fork is refused, never taken as clean", () => {
  const expected = { ...EXPECTED, held: null };
  const clean = probedFork();
  rmSync(join(clean.root, "var/lib/tailscale/tailscaled.state"));
  assert.deepEqual(forkVerdict(clean.seen(), expected), { is: "ready" }, "the probe itself passes a clean fork");
  const loggedIn = probedFork();
  assert.match((forkVerdict(loggedIn.seen(), expected) as { why: string }).why, /still holds a tailnet node/);
  const cases: readonly [string, string, RegExp][] = [
    ["grep", "tailscale-state", /could not read tailscale-state/],
    ["sha256sum", "machine-id", /could not read machine-id/],
    ["sed", "identity-marker", /could not read identity-marker/],
  ];
  for (const [tool, item, why] of cases) {
    const probe = probedFork();
    probe.breakTool(tool);
    const seen = probe.seen();
    assert.ok(seen.unreadable.includes(item), `${tool}: ${JSON.stringify(seen.unreadable)}`);
    const verdict = forkVerdict(seen, expected);
    assert.equal(verdict.is, "refused", tool);
    assert.match((verdict as { why: string }).why, why, tool);
  }
});

test("070 unit 7 re-review: a fork cut off by BB Box stopping during its first start keeps its guest on its record, and recovery deletes that guest before it copies the snapshot again", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const backend = state.backend as unknown as { start: (guest: Guest, signal?: AbortSignal, ...rest: unknown[]) => Promise<unknown> };
  const start = backend.start.bind(state.backend);
  let first: Guest | null = null;
  let started: () => void = () => {};
  const starting = new Promise<void>((resolve) => (started = resolve));
  backend.start = async (guest: Guest, signal?: AbortSignal) => {
    first = guest;
    await start(guest);
    started();
    await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  await starting;
  await state.boxes.dispose();
  backend.start = start;
  const cut = first as Guest | null;
  assert.ok(cut);
  const kept = (await state.boxes.find(answer.box!.id))!;
  assert.equal(kept.guest?.ref, cut.ref, "the record keeps the guest it was starting");
  assert.equal(await state.backend.power(cut), "running");
  await state.restart();
  forks.macsAfterRestart();
  assert.equal(await state.backend.power(cut), "running", "BB Box's restart leaves the guest as it was");
  const copy = state.provider.onForked!;
  let cutAtCopy: string | null = "not copied again";
  state.provider.onForked = async (made, ref) => {
    cutAtCopy = await state.backend.power(cut);
    await copy(made, ref);
  };
  await state.boxes.sweep();
  const fork = await forked(state, await state.boxes.find(answer.box!.id));
  assert.equal(cutAtCopy, null, "the guest it was starting was deleted before the snapshot was copied again");
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.notEqual(fork.guest?.ref, cut.ref);
  assert.equal(await state.backend.power(cut), null);
});

test("070 unit 7 re-review: box_fork's check before its take refuses a fork with no room or no place for it, so the take never deletes an older snapshot for a fork that is then refused", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  const agent: Caller = { is: "agent", threadId: THREAD };
  state.settings = { perBox: 2 };
  const oldest = (await state.snapshots.take(agent, box, standing(box), { name: "oldest" })).snapshot!;
  state.tick(1000);
  await state.snapshots.take(agent, box, standing(box), { name: "second" });
  const capacity = state.backend.capacity.bind(state.backend);
  state.backend.capacity = async () => ({ ok: false, message: "No room for any new guest", warm: null, hosts: [] });
  const refused = await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box)));
  assert.equal(refused.code, "no_capacity");
  assert.match(refused.message, /has no room for the fork: No room for any new guest/);
  for (const caller of [agent, COMMAND]) {
    state.backend.capacity = async () => ({ ok: false, message: "Every GPU is full. Release a desktop box, or raise the desktops per GPU.", warm: null, hosts: [] });
    const full = await rejection(state.snapshots.checkForkOfBox(caller, box, standing(box), { gpu: "shared" }));
    assert.match(full.message, /^Not forked: .*Every GPU is full\. Fork it with gpu none, or ask the user\. BB Box copied nothing\.$/);
    assert.doesNotMatch(full.message, /Release|raise|settings/);
  }
  state.backend.capacity = capacity;
  assert.equal((await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box), { name: box.name }))).code, "invalid_name", "a name its thread already has");
  assert.ok(state.store.record(oldest.id), "nothing was taken or deleted");
  assert.equal(state.store.records({ box: box.id }).filter((record) => record.state === "ready").length, 2);
});

test("071 unit 8: a fork's room refused by its provider reaches an agent in the provider's words for an agent, never the person's with their threads", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  const agent: Caller = { is: "agent", threadId: THREAD };
  const asked: (string | undefined)[] = [];
  (state.backend as unknown as { capacity: Backend["capacity"] }).capacity = async (_kind, _size, _pending, _signal, asking) => {
    asked.push(asking?.threadId);
    return {
      ok: false,
      message: 'No card on pve is free for a whole card now: card 0 has lone-pine (in thread "Train the model") running. Release a box on one of the cards, ask for gpu shared, or ask for gpu none.',
      agentMessage: "Not made: no card on pve is free for a whole card now: card 0 has lone-pine running. Ask for gpu shared, or ask the user. BB Box changed nothing.",
      warm: null,
      hosts: [],
    };
  };
  const refused = await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box), { gpu: "whole" }));
  assert.equal(refused.code, "no_capacity");
  assert.match(refused.message, /lone-pine \(in thread "Train the model"\) running\. Fork it with gpu shared or none, or ask the user\. BB Box copied nothing\.$/);
  assert.equal((refused as BoxError).agentMessage, "Not forked: Fake host has no room for the fork: no card on pve is free for a whole card now: card 0 has lone-pine running. Fork it with gpu shared or none, or ask the user. BB Box copied nothing.");
  assert.deepEqual(asked, [THREAD]);
  const person = await rejection(state.snapshots.checkForkOfBox(COMMAND, box, standing(box), { gpu: "whole" }));
  assert.equal((person as BoxError).agentMessage, null, "the person's refusal carries no agent's words");
});

test("071 unit 8, lead: a fork with a whole card is refused while whole cards are off, before the take and before any record, in words for each audience", async () => {
  const forks = forkWorld({ wholeCards: false });
  const { state } = forks;
  const box = await readyBox(state);
  const agent: Caller = { is: "agent", threadId: THREAD };
  const records = state.store.records().length;
  const live = await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box), { gpu: "whole" }));
  assert.equal(live.code, "unsupported");
  assert.equal(live.message, "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or turn Whole cards on in the backend's GPUs section in BB Box's settings, or with bb box backend set <backend> --field whole-cards=true. BB Box copied nothing.");
  assert.equal((live as BoxError).agentMessage, "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or ask the user. BB Box copied nothing.");
  assert.equal(state.store.records().length, records, "nothing was taken");
  assert.equal((await state.boxes.list(THREAD)).length, 1, "no fork's record was made");
  await state.snapshots.take(agent, box, standing(box), { name: "set up" });
  const ofSnapshot = await rejection(state.snapshots.checkFork(agent, box, standing(box), "set up", { gpu: "whole" }));
  assert.equal(ofSnapshot.message, "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or ask the user. BB Box copied nothing.");
});

test("070 unit 7 re-review: a fork's guest is disarmed before each attempt to delete it, when the fork fails and at each sweep after", async () => {
  const forks = forkWorld();
  forks.firstBoot = "same-mac";
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  state.backend.faults.release = new Error("CT is locked (clone)");
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  const ref = fork.guest!.ref;
  await state.boxes.sweep();
  const steps = state.backend.calls.filter((call) => call === `disarm ${ref}` || call === `release ${ref}`);
  assert.deepEqual(steps, [`disarm ${ref}`, `release ${ref}`, `disarm ${ref}`, `release ${ref}`]);
});

test("070 unit 8, G15: Keep, release, restart bb-box, then fork the kept snapshot from its held copy: the fork is one of your machines, resets, and has the file written before the take", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  writeIn(state, box, "work/state.txt", "written before the take");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "release candidate" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), taken.id);
  writeIn(state, box, "work/state.txt", "written after the take");
  await state.boxes.release(THREAD, box.id, "done with it", { is: "command" });
  assert.equal(await state.backend.power(box.guest!), null, "the box is gone");
  await state.restart();
  forks.macsAfterRestart();
  withIdentitySource(state, "eth");
  await state.snapshots.sweep();
  const kept = state.snapshots.findGone(box.name, "release candidate");
  assert.equal(kept.guest, "held-copy");
  assert.equal(kept.forkSafe, 9, "a held copy keeps its snapshot's identity reset version");
  const agent: Caller = { is: "agent", threadId: THREAD };
  assert.match((await rejection(state.snapshots.fork(agent, { id: box.id }, standing(box), taken.id))).message, /has no snapshot/, "an agent cannot see a released box's kept snapshot");
  const answer = await state.snapshots.forkGone(kept, { is: "command" }, { name: "from-kept" });
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(fork.threadId, OPERATOR, "a fork of a kept snapshot is one of the person's machines");
  assert.equal(fork.fork?.snapshot.from, "held-copy");
  assert.equal(readIn(state, fork, "work/state.txt"), "written before the take");
  const root = forks.roots.get(fork.guest!.ref)!;
  assert.equal(fileOf(root, "home/box/.bb-machines/bb.example/host-id"), null, "it reset");
  assert.equal(state.store.operation(answer.operation.id)?.state, "done");
  assert.equal(state.store.pins().has(taken.id), false);
  assert.deepEqual(state.kinds(box.id).filter((kind) => kind === "fork-asked" || kind === "forked"), ["fork-asked", "forked"]);
});

test("070 unit 8: a fork's release disarms its guest before every attempt to delete it, the sweep's retries included", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  state.holds.step = null;
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  state.backend.calls.length = 0;
  state.backend.faults.release = new Error("CT is locked (clone)");
  const left = await state.boxes.release(fork.threadId, fork.id, "cancelled", { is: "command" });
  assert.equal(left?.state, "releasing");
  await state.boxes.sweep();
  const order = state.backend.calls.filter((call) => call.startsWith("disarm ") || call.startsWith("release "));
  assert.deepEqual(order, [`disarm ${fork.guest!.ref}`, `release ${fork.guest!.ref}`, `disarm ${fork.guest!.ref}`, `release ${fork.guest!.ref}`], "disarmed before the first delete and before the sweep's retry");
  assert.equal(await state.backend.power(fork.guest!), null);
});

test("070 unit 11b: on a backend whose identity source is a value, the check before ready compares the marker's value with the fork's own box ID, not MAC addresses or addresses the provider gives", () => {
  const status = "version=8\nenabled=yes\nboot=kept\nmarker=matches\narmed=yes\npending=no\nbox=\nsource=value";
  const whole = [status, `machine_id=${HASH_B}`, `host_key=${HASH_B}`, "tailnet_node=no", "marker_value=bxfork00000001", "address=203.0.113.9", "addresses_read=yes"];
  const expected = { forkMacs: [], sourceMacs: [], sourceBox: "bxsource", sourceName: "amber-fox", sourceAddresses: [], freedSourceAddresses: [], ownAddress: null, boxAddresses: [], held: { machineId: HASH_A, hostKeys: [HASH_A] }, safeFrom: 8, forkValue: "bxfork00000001" };
  assert.deepEqual(forkVerdict(parseForkSeen(seenLines(whole), 0), expected), { is: "ready" });
  const cases: readonly [string, readonly string[], RegExp][] = [
    ["the source's value", whole.map((line) => line.replace("marker_value=bxfork00000001", "marker_value=bxsource")), /its identity marker holds amber-fox's value, so its identity reset did not tell it is a copy/],
    ["no value", whole.filter((line) => !line.startsWith("marker_value=")), /its identity marker holds no value, not its own bxfork00000001/],
    ["the marker still names a box", whole.map((line) => line.replace("box=", "box=bxsource")), /its identity marker names box bxsource, amber-fox, which a reset would have removed/],
    ["BB's machine still there", [...whole, "bb_file=/home/box/.bb-machines/bb.example.com/host-id"], /BB's machine credentials are still on its disk/],
    ["the access file still there", [...whole, "access_file=/home/box/.config/bb-box/env"], /the thread's access file is still on its disk/],
    ["a tailnet node", whole.map((line) => line.replace("tailnet_node=no", "tailnet_node=yes")), /its Tailscale state still holds a tailnet node/],
    ["the source's machine ID", whole.map((line) => line.replace(`machine_id=${HASH_B}`, `machine_id=${HASH_A}`)), /its machine ID is amber-fox's/],
    ["the source's host key", whole.map((line) => line.replace(`host_key=${HASH_B}`, `host_key=${HASH_A}`)), /it has amber-fox's SSH host keys/],
    ["version 7", whole.map((line) => line.replace("version=8", "version=7")), /it has version 7 of the identity reset, and BB Box forks only from version 8 there/],
  ];
  for (const [name, lines, why] of cases) {
    const verdict = forkVerdict(parseForkSeen(seenLines(lines), 0), expected);
    assert.equal(verdict.is, "refused", name);
    assert.match((verdict as { why: string }).why, why, name);
  }
  assert.equal(parseForkSeen(seenLines(WHOLE), 0).markerValue, null, "a MAC marker has no value line");
  assert.deepEqual(forkVerdict(parseForkSeen(seenLines(WHOLE), 0), EXPECTED), { is: "ready" }, "Proxmox's MAC check is as it was");
});

test("070 unit 11b review, Astra 2 and Opus 5: where the backend can, a fork starts only as far as its identity check, core checks it through the backend's own check command, and only then arms it to finish its start", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  const backend = state.backend as unknown as Record<string, unknown> & Backend;
  const start = backend.start!.bind(backend);
  const transports = backend.transports.bind(backend);
  backend.startForForkCheck = async (guest: Guest, signal: AbortSignal) => {
    state.provider.order.push("start up to the check");
    await start(guest, signal);
  };
  backend.forkCheckCommand = async (guest: Guest) => {
    state.provider.order.push("the check's own command");
    return (await transports(guest, box.kind)).command!;
  };
  state.provider.order.length = 0;
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  const order = state.provider.order.filter((step) => step.startsWith("start ") || step.startsWith("the check") || step.startsWith("arm boot"));
  assert.deepEqual(order, ["start up to the check", "the check's own command", `arm boot ${fork.guest!.ref}`], state.provider.order.join(", "));
  assert.equal(state.provider.order.includes("start within 180 s"), false, "core never starts the fork whole before its check");
});

test("071 unit 7 round 2, Astra 4: a fork whose card the backend refuses keeps the person's words and the agent's, and the agent's tools get the agent's", async () => {
  const forks = forkWorld();
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  (state.backend as unknown as Record<string, unknown>).placeForkGpu = async () => {
    throw new BackendError("no_capacity", "Not forked: no card has room. Release a desktop box. BB Box copied nothing.", "Not forked: no card has room. Fork it with gpu none, or ask the user. BB Box copied nothing.");
  };
  const answer = await state.snapshots.fork(COMMAND, box, standing(box), "set up");
  const fork = await forked(state, answer.box);
  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", /^Not forked: no card has room\. Release a desktop box\./);
  assert.match(errorForAgent(fork) ?? "", /^Not forked: no card has room\. Fork it with gpu none, or ask the user\. BB Box copied nothing\. BB Box released it, so nothing of it acts as /);
  assert.doesNotMatch(errorForAgent(fork) ?? "", /release a desktop/i);
});

test("a fork of a box or a snapshot on a backend kept for other projects goes to no thread outside them, the check refusing as the fork would; the person may still fork it as one of their machines (#1458)", async () => {
  const forks = forkWorld({ projectsFromBb: true });
  const { state } = forks;
  const box = await readyBox(state);
  await state.snapshots.take(COMMAND, box, standing(box), { name: "set up" });
  state.keptFor = ["proj_work"];
  const agent: Caller = { is: "agent", threadId: THREAD };
  const keptForOthers = /is kept for certain projects, and this thread('s project is not one of them| has no project), so a fork there cannot be this thread's box\. Only the person can fork it, as one of their machines\./;

  for (const projectId of [null, "proj_home"]) {
    state.threadProjects.set(THREAD, projectId);
    assert.match((await rejection(state.snapshots.checkFork(agent, box, standing(box), "set up", { projectId: "proj_work" }))).message, keptForOthers, "the project BB gives now, not one the caller says");
    assert.match((await rejection(state.snapshots.fork(agent, box, standing(box), "set up", { projectId: "proj_work" }))).message, keptForOthers);
    assert.match((await rejection(state.snapshots.checkForkOfBox(agent, box, standing(box), { projectId: "proj_work" }))).message, keptForOthers);
  }
  state.threadProjects.set(THREAD, "proj_home");
  assert.match((await rejection(state.snapshots.fork(COMMAND, box, standing(box), "set up"))).message, keptForOthers, "the person's fork into the box's own thread");
  assert.deepEqual(state.store.operations({ box: box.id, kind: "fork" }), [], "nothing recorded");

  const mine = await forked(state, (await state.snapshots.fork(COMMAND, box, standing(box), "set up", { asMachine: true })).box);
  assert.equal(mine.threadId, OPERATOR);
  assert.equal(mine.state, "ready", mine.error ?? "");

  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept" })).snapshot!;
  state.store.updateRecord(kept.id, { keptUntil: state.now + 30 * 24 * 60 * 60_000, keptAt: state.now, owner: "person" });
  const keptCheck = await state.snapshots.checkFork(COMMAND, box, standing(box), "kept");
  assert.equal(keptCheck.threadId, OPERATOR, "a kept snapshot's fork is the person's machine, which may be on any backend");

  state.threadProjects.set(THREAD, "proj_work");
  const work = await forked(state, (await state.snapshots.fork(agent, box, standing(box), "set up", { projectId: "proj_work" })).box);
  assert.equal(work.threadId, THREAD, "a thread of the project the backend is kept for may fork there");
  assert.equal(work.projectId, "proj_work");
});

test("a command's or the panel's fork of a box whose thread moved out of the project its backend is kept for is refused, though the box was made in that project, and one BB cannot place has no project (#1458)", async () => {
  const forks = forkWorld({ projectsFromBb: true });
  const { state } = forks;
  state.threadProjects.set(THREAD, "proj_work");
  state.keptFor = ["proj_work"];
  const box = await state.boxes.settled(await state.boxes.acquire({ threadId: THREAD, projectId: "proj_work", kind: "linux", who: BY_COMMAND }));
  assert.equal(box?.projectId, "proj_work");
  await state.snapshots.take(COMMAND, box!, standing(box!), { name: "set up" });
  const person: Caller = { is: "person" };
  const keptForOthers = /is kept for certain projects, and this thread('s project is not one of them| has no project), so a fork there cannot be this thread's box\./;
  assert.equal((await state.snapshots.checkFork(COMMAND, box!, standing(box!), "set up")).threadId, THREAD, "allowed while the thread is in the project");

  for (const now of ["proj_home", new Error("BB did not answer")]) {
    state.threadProjects.set(THREAD, now);
    for (const caller of [COMMAND, person]) {
      assert.match((await rejection(state.snapshots.checkFork(caller, box!, standing(box!), "set up"))).message, keptForOthers);
      assert.match((await rejection(state.snapshots.fork(caller, box!, standing(box!), "set up"))).message, keptForOthers);
    }
  }
  assert.deepEqual(state.store.operations({ box: box!.id, kind: "fork" }), [], "nothing recorded");
});
