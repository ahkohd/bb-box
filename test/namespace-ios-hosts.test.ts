import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_HOST_EXITS } from "../src/backends/tart/device-host.ts";
import type { Instance } from "../src/backends/namespace/api.ts";
import { HOST_RECORD_KEY, NamespaceHosts, UNPACK_SETUP, hostSetupScript, namespaceDeviceOffer, namespaceSlotOf, type NamespaceHostRecord, type NamespaceHostsAccess } from "../src/backends/namespace/ios-hosts.ts";
import type { AcquireHooks, BoxIdentity, Guest } from "../src/backends/types.ts";
import { readPlacement } from "../src/core/device-host.ts";
import { NOT_MEASURED, type MacReport } from "../src/core/mac-capabilities.ts";
import { SlotUserTransport, asSlotUser } from "../src/transports/slot-user.ts";
import type { RunOptions, RunResult } from "../src/transports/types.ts";
import { MemoryStorage } from "./helpers.ts";

const REPORT: MacReport = {
  mac: "Apple M4 Pro (Virtual)",
  chip: "Apple M4 Pro (Virtual)",
  macos: "26.3.1",
  at: 1,
  where: "mac",
  capabilities: {
    simulator: { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2"], newest: { os: "26.2", build: "23C54" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", "com.apple.CoreSimulator.SimDeviceType.iPhone-17"] } },
    hardwareEncoder: { is: "no", why: "VideoToolbox's encoder is not available here (-12915)" },
    softwareEncoder: { is: "no", why: "bb-box-h264 is not installed" },
  },
};

interface StubSlot {
  id: string;
  is: "making" | "ready" | "held";
  box: string | null;
  madeFor: string | null;
}

class StubHost {
  readonly scripts: string[] = [];
  slots: StubSlot[] = [];
  promises: string[] = [];
  most = 4;
  generation = 0;
  setUp = false;
  setUpFailures = 0;

  #field(stdin: unknown, key: string): string {
    return new RegExp(`^${key}=(.*)$`, "m").exec(String(stdin ?? ""))?.[1] ?? "";
  }

  #last(): boolean {
    return !this.slots.some((slot) => slot.is === "held" || (slot.is === "making" && slot.madeFor)) && !this.promises.length;
  }

  status(): string {
    const lines = [`helper=5`, `boot=b`, `most=${this.most}`, `ahead=1`, `resetting-most=2`, `disk-reserve-gib=20`, `generation=${this.generation}`, `disk=80`, `counted=${this.slots.length}`];
    for (const box of this.promises) lines.push(`promise=${box}\tinst1\t1`);
    for (const slot of this.slots) {
      lines.push(`slot=${slot.id}\tbbd-${slot.id}\t${80000 + Number(slot.id)}\t0\t${20000 + 100 * (Number(slot.id) - 1)}\t${slot.is}\t\t${slot.box ?? ""}\t${slot.madeFor ?? ""}\t1\tiPhone 17\tU-${slot.id}\t1\t1\t0.1\t500\t`);
      if (slot.is === "held") lines.push(`claim=${slot.id}\tinst1\t${slot.box}\tthr_1\tbox-${slot.box}\tios\t1`);
    }
    return `${lines.join("\n")}\n`;
  }

  async run(script: string, options: RunOptions = {}): Promise<RunResult> {
    this.scripts.push(script);
    const answer = (exitCode: number, stdout = "", stderr = ""): RunResult => ({ exitCode, stdout, stderr, timedOut: false }) as RunResult;
    if (script === UNPACK_SETUP) return answer(0);
    if (script.includes("mac-ios.sh")) {
      if (this.setUpFailures > 0) {
        this.setUpFailures--;
        return answer(1, "", "mac-ios.sh: xcrun simctl runtime add failed");
      }
      this.setUp = true;
      return answer(0, "ios=26.2 23C54 ios-26.2-23C54 companion=1.7.7\n");
    }
    if (script.startsWith("sudo -n launchctl asuser ")) return answer(0);
    const verb = /device-host (\w[\w-]*)(?: (\S+))?/.exec(script);
    if (!verb) return answer(1, "", `the stub has no answer to ${script}`);
    const box = this.#field(options.stdin, "box");
    switch (verb[1]) {
      case "status":
        return answer(0, this.status());
      case "promise":
        if (this.slots.length + this.promises.length >= this.most) return answer(DEVICE_HOST_EXITS.full, "", "full");
        if (!this.promises.includes(box)) this.promises.push(box);
        return answer(0);
      case "make": {
        if (!this.promises.includes(box)) return answer(DEVICE_HOST_EXITS.lost, "", "no promise");
        this.promises = this.promises.filter((each) => each !== box);
        this.generation++;
        this.slots.push({ id: String(this.generation), is: "ready", box: null, madeFor: box });
        return answer(0);
      }
      case "claim": {
        const slot = this.slots.find((each) => each.id === verb[2] && each.is === "ready");
        if (!slot) return answer(DEVICE_HOST_EXITS.lost, "", "taken");
        slot.is = "held";
        slot.box = box;
        return answer(0, `slot=${slot.id}\nports=${20000 + 100 * (Number(slot.id) - 1)}\n`);
      }
      case "release":
        this.slots = this.slots.filter((each) => each.id !== verb[2]);
        return answer(0, this.#last() ? "last=yes\n" : "last=no\n");
      case "unpromise":
        this.promises = this.promises.filter((each) => each !== box);
        return answer(0, this.#last() ? "last=yes\n" : "last=no\n");
      case "vacate":
        return answer(0, this.#last() ? "last=yes\n" : "last=no\n");
      default:
        return answer(2, "", `no verb ${verb[1]}`);
    }
  }
}

function instance(id: string, status = "running"): Instance {
  return { id, status, labels: {}, createdAt: 0, deadline: null, continent: null, shape: null } as unknown as Instance;
}

function harness(options: { report?: MacReport | null; room?: string | null; measured?: MacReport; now?: () => number; access?: Partial<NamespaceHostsAccess> } = {}) {
  const host = new StubHost();
  const storage = new MemoryStorage();
  const destroyed: string[] = [];
  const logs: string[] = [];
  const tags: string[] = [];
  let made = 0;
  let clock = options.now ?? (() => 1_000_000);
  const access: NamespaceHostsAccess = {
    installId: "inst1",
    backendId: "namespace",
    storage,
    settings: () => ({ on: true, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 }),
    longestLifeMs: () => 4 * 3600_000,
    now: () => clock(),
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
    report: () => (options.report === undefined ? REPORT : options.report),
    room: async () => ({ shape: { cores: 6, memoryGB: 14 }, words: options.room ?? null }),
    create: async (tag) => (tags.push(tag), instance(`ns-${++made}`)),
    wait: async (id) => instance(id),
    describe: async (id) => (destroyed.includes(id) ? null : instance(id)),
    destroy: async (id) => void destroyed.push(id),
    extend: async () => {},
    answers: async () => {},
    command: async () => host as never,
    measure: async () => options.measured ?? REPORT,
    setupArchive: async () => Buffer.from("archive"),
    publicKey: async () => "ssh-ed25519 AAAA bb-box",
    log: (line) => void logs.push(line),
    logError: (operation, error) => void logs.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
  };
  const hosts = new NamespaceHosts({ ...access, ...options.access }, { machinePollMs: 20 });
  return { hosts, host, storage, destroyed, logs, tags, setClock: (next: () => number) => (clock = next) };
}

function box(id: string): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "ios", createdAt: 1, size: { cores: 6, memoryMiB: 14336, diskGiB: null, gpu: "none" } };
}

const hooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(20_000);

async function serving(hosts: NamespaceHosts): Promise<NamespaceHostRecord> {
  for (let tries = 0; tries < 200; tries++) {
    const record = await hosts.record();
    if (record?.phase === "serving") return record;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the host did not serve");
}

const HOST_RECORD_WRITTEN_BEFORE_SEVERAL_WORKSPACES = {
  tag: "bbbox-inst1-ios-host-a1b2c3",
  instance: "ns-1",
  made: 1_000_000,
  endsAt: 1_000_000 + 4 * 3600_000,
  phase: "serving",
  promised: [],
  most: 2,
  ahead: 1,
  resettingMost: 2,
  diskReserveGiB: 20,
  failure: null,
  startBy: null,
  startBeat: null,
  hardware: true,
} as const;

test("a shared iOS host recorded before several workspaces, with no backend, reads as the first Namespace backend's, whichever backend reads it (#1455)", async () => {
  for (const backendId of ["namespace", "namespace:team-b"]) {
    const { hosts, storage } = harness({ access: { backendId } });
    await storage.set(HOST_RECORD_KEY, HOST_RECORD_WRITTEN_BEFORE_SEVERAL_WORKSPACES);

    const record = await hosts.record();

    assert.deepEqual(record, { ...HOST_RECORD_WRITTEN_BEFORE_SEVERAL_WORKSPACES, backend: "namespace" }, backendId);
    assert.deepEqual(hosts.known(), record);
  }
});

test("Namespace's ios offer comes from its last Mac measured: a model its Xcode makes, its newest runtime, and BB Box's list for it (065, unit 7)", () => {
  const offer = namespaceDeviceOffer(REPORT);
  assert.ok(offer.ok);
  const device = offer.device.devices[0];
  assert.equal(device.model, "iPhone 17");
  assert.deepEqual("os" in device.runtime && [device.runtime.os, device.runtime.build, device.runtime.xcode, device.runtime.companion], ["26.2", "23C54", "26.1.1", "1.7.7"]);
  assert.equal("slim" in device && device.slim?.list, "ios-26.2-23C54");
  assert.match((namespaceDeviceOffer(null) as { why: string }).why, /has not measured a Namespace Mac yet/);
  const noList = { ...REPORT, capabilities: { ...REPORT.capabilities, simulator: { is: "yes" as const, what: { xcode: "26.4", runtimes: ["iOS 26.4"], newest: { os: "26.4", build: "23E1" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17"] } } } };
  assert.match((namespaceDeviceOffer(noList) as { why: string }).why, /no slimming list for iOS 26\.4 \(23E1\)/);
  const noModel = { ...REPORT, capabilities: { ...REPORT.capabilities, simulator: { is: "yes" as const, what: { xcode: "26.1.1", runtimes: ["iOS 26.2"], newest: { os: "26.2", build: "23C54" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-8"] } } } };
  assert.match((namespaceDeviceOffer(noModel) as { why: string }).why, /can make none of BB Box's iOS devices/);
  assert.match((namespaceDeviceOffer({ ...REPORT, capabilities: NOT_MEASURED }) as { why: string }).why, /cannot run the iOS Simulator/);
});

test("a host's setup unpacks BB Box's setup and runs mac-ios.sh as root with the host's settings, as a host deleted after its last box", () => {
  const script = hostSetupScript({ most: 4, ahead: 1, resettingMost: 2, diskReserveGiB: 20 });
  assert.match(script, /sudo -n env HOST_SETTINGS='most=4\nahead=1\nresetting-most=2\ndisk-reserve-gib=20' \/bin\/sh "\$here\/ssh-pool\/mac-ios\.sh" "\$here\/ssh-pool" "\$\(id -un\)"/);
  assert.match(UNPACK_SETUP, /tar -xzf - -C "\$HOME\/bb-box-setup"/);
});

test("a slot's commands run as its user, in its launchd session, through the host's own SSH and sudo, as Namespace's Macs have no sshd for other users", async () => {
  assert.equal(asSlotUser("bbd-3", "echo hi"), "sudo -n launchctl asuser \"$(id -u 'bbd-3')\" /usr/bin/sudo -n -H -u 'bbd-3' -- /bin/zsh -c 'cd ~ 2>/dev/null || exit 1\necho hi'");
  const ran: { script: string; stdin: unknown }[] = [];
  const host = { run: async (script: string, options: RunOptions = {}) => (ran.push({ script, stdin: options.stdin }), { exitCode: 0, stdout: "x\nbb-box-read:aGVsbG8=\n", stderr: "", timedOut: false }) };
  const slot = new SlotUserTransport(host as never, "bbd-3");
  await slot.writeFile("notes/a.txt", new TextEncoder().encode("hello"), { mode: "600" });
  assert.match(ran[0]!.script, /^sudo -n launchctl asuser "\$\(id -u 'bbd-3'\)" \/usr\/bin\/sudo -n -H -u 'bbd-3' -- \/bin\/zsh -c /);
  assert.match(ran[0]!.script, /cat > "\$p" && chmod '\\''600'\\'' "\$p"/);
  assert.equal(new TextDecoder().decode(await slot.readFile("notes/a.txt", { maxBytes: 100 })), "hello");
  assert.equal(await slot.probe(), true);
});

test("the first ios box starts a Namespace host and the next joins it while it starts; each gets a slot; the last release deletes the host (065, unit 7)", async () => {
  const { hosts, host, destroyed, storage, logs } = harness();
  assert.equal(hosts.lends("ios"), true);
  assert.equal(hosts.lends("macos"), false);
  const first = await hosts.offer("ios", null, signal());
  assert.deepEqual(first, { tier: "new-host", where: "Namespace", waitMs: 240_000, cost: "namespace-mac" });
  const promise1 = await hosts.take(first, box("b1"), signal());
  assert.ok(!("lost" in promise1));
  const joined = await hosts.offer("ios", null, signal());
  assert.equal(joined.tier, "join");
  const promise2 = await hosts.take(joined, box("b2"), signal());
  assert.ok(!("lost" in promise2));
  assert.deepEqual(await hosts.offer("ios", "iPhone 18 Pro", signal()), { tier: "wait", words: "A shared ios box has the iPhone 17, the model every slot is made with. Leave device out for it, or ask for dedicated: true for the iPhone 18 Pro." });
  const record = await serving(hosts);
  assert.ok(host.setUp, "mac-ios.sh ran");
  assert.equal(record.instance, "ns-1");
  assert.equal(record.most, 4);
  assert.equal(record.hardware, false);
  assert.ok(logs.some((line) => /^The Namespace host on ns-1 serves, .* for 2 boxes: ios=26\.2 23C54/.test(line)), logs.join("\n"));
  const guest1 = await hosts.acquire(box("b1"), promise1 as Guest, hooks, signal());
  const placement = readPlacement(guest1.data);
  assert.ok(placement.ok && placement.value.on === "slot" && placement.value.hostOn === "namespace");
  assert.deepEqual(namespaceSlotOf(guest1), { tag: record.tag, instance: "ns-1", slot: "1", box: "b1" });
  assert.equal(guest1.endsAt, record.endsAt);
  assert.match(guest1.facts?.[0]?.value ?? "", /^\d\d:\d\d UTC, when its Namespace host does$/);
  const transports = await hosts.transports(guest1);
  assert.ok(transports.command instanceof SlotUserTransport);
  assert.equal(transports.access, null);
  assert.equal(transports.daemonKeptByHost?.daemonPort, 38900);
  const guest2 = await hosts.acquire(box("b2"), promise2 as Guest, hooks, signal());
  assert.equal(namespaceSlotOf(guest2)?.slot, "2");
  assert.equal((await hosts.transports(guest2)).daemonKeptByHost?.daemonPort, 38901, "two slots enrolling at once never pick the same port for BB's daemon");
  assert.deepEqual((await hosts.held(signal())).map((each) => [each.owner?.boxId, namespaceSlotOf(each)?.slot]).sort(), [["b1", "1"], ["b2", "2"]]);
  assert.equal((await hosts.doctor(signal())).status, "ok");
  assert.match((await hosts.doctor(signal())).detail, /2 held, 0 ready, 0 making, 0 sweeping, of 4; ends at \d\d:\d\d UTC; video by software, as its Mac has no hardware H\.264 encoder\./);
  assert.deepEqual(await hosts.release(guest1), { last: false });
  assert.deepEqual(destroyed, []);
  assert.deepEqual(await hosts.release(guest2), { last: true });
  assert.deepEqual(destroyed, ["ns-1"]);
  assert.equal(await storage.get(HOST_RECORD_KEY), undefined);
});

test("the box that started a Namespace host is served first, though the boxes that joined it reach its ready slots before it (F-11)", async () => {
  const { hosts, host } = harness();
  host.most = 5;
  const boxes = ["b1", "b2", "b3"].map(box);
  const promised: Guest[] = [];
  for (const each of boxes) promised.push((await hosts.take(await hosts.offer("ios", null, signal()), each, signal())) as Guest);
  host.slots = [1, 2].map((n) => ({ id: String(n), is: "ready" as const, box: null, madeFor: null }));
  host.generation = 2;
  await serving(hosts);
  const joiners = await Promise.all([1, 2].map((n) => hosts.acquire(boxes[n]!, promised[n]!, hooks, signal())));
  assert.deepEqual(joiners.map((guest) => namespaceSlotOf(guest)?.slot), ["2", "3"], "the joiners leave the first ready slot to the first box, and the last makes one");
  const first = await hosts.acquire(boxes[0]!, promised[0]!, hooks, signal());
  assert.equal(namespaceSlotOf(first)?.slot, "1");
});

function gate(): { readonly opened: Promise<void>; open(): void } {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function until(met: () => boolean | Promise<boolean>, words: string): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    if (await met()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(words);
}

test("a Namespace host whose first Mac fails to start starts once more on a fresh Namespace Mac, still taking boxes meanwhile, and the log and doctor say why (F-11)", async () => {
  const held = gate();
  let measures = 0;
  const { hosts, host, destroyed, logs, tags } = harness({
    access: {
      measure: async () => {
        if (++measures === 2) await held.opened;
        return REPORT;
      },
    },
  });
  host.setUpFailures = 1;
  const first = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  await until(() => measures === 2, "the fresh Mac's start reaches its measure");
  assert.deepEqual(destroyed, ["ns-1"], "the first Mac is destroyed before the fresh one is made, as the workspace has one Mac");
  const record = (await hosts.record())!;
  assert.deepEqual([record.phase, record.instance, tags], ["starting", "ns-2", [record.tag, `${record.tag}-fresh`]]);
  const joined = await hosts.offer("ios", null, signal());
  assert.equal(joined.tier, "join", "the host is still starting, so a box joins it");
  const second = await hosts.take(joined, box("b2"), signal());
  assert.match((await hosts.doctor(signal())).detail, /^The Namespace host is starting, with 2 boxes promised, made \d+ s ago, on a fresh Namespace Mac as its first start failed \(its iOS slots were not set up: mac-ios\.sh: xcrun simctl runtime add failed\)\.$/);
  assert.ok(logs.includes("The Namespace host's Mac ns-1 did not start, so bb-box destroys it and starts a fresh Namespace Mac, once: its iOS slots were not set up: mac-ios.sh: xcrun simctl runtime add failed"), logs.join("\n"));
  held.open();
  const slots = await Promise.all([hosts.acquire(box("b1"), first as Guest, hooks, signal()), hosts.acquire(box("b2"), second as Guest, hooks, signal())]);
  assert.deepEqual(slots.map((slot) => namespaceSlotOf(slot)?.instance), ["ns-2", "ns-2"]);
  for (const slot of slots) await hosts.release(slot);
  assert.deepEqual(destroyed, ["ns-1", "ns-2"]);
});

test("a Namespace host whose fresh Mac fails too fails its boxes with both failures, and destroys both Macs (F-11)", async () => {
  let measures = 0;
  const { hosts, host, destroyed } = harness({ access: { measure: async () => (++measures === 2 ? Promise.reject(new Error("the probe did not answer")) : REPORT) } });
  host.setUpFailures = 1;
  const promised = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  await assert.rejects(
    hosts.acquire(box("b1"), promised as Guest, hooks, signal()),
    /^Error: The Namespace host failed: the probe did not answer That was a fresh Namespace Mac's start; the first one's failed too: its iOS slots were not set up: mac-ios\.sh: xcrun simctl runtime add failed$/,
  );
  assert.deepEqual(destroyed, ["ns-1", "ns-2"]);
  assert.match((await hosts.doctor(signal())).detail, /^The Namespace host is failed: the probe did not answer That was a fresh Namespace Mac's start/);
});

test("a Namespace Mac that stops or goes before the host serves is noticed within a poll, not at the start's deadline, and a fresh Mac replaces it (F-11)", async () => {
  const ended = new Set<string>();
  const { hosts, destroyed, logs } = harness({
    access: {
      describe: async (id) => (ended.has(id) ? instance(id, "suspended") : instance(id)),
      answers: async (id, _deadline, signal) => {
        if (id !== "ns-1") return;
        ended.add(id);
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  });
  const began = Date.now();
  const promised = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  const slot = await hosts.acquire(box("b1"), promised as Guest, hooks, signal());
  assert.ok(Date.now() - began < 5_000, "seen within a poll");
  assert.equal(namespaceSlotOf(slot)?.instance, "ns-2");
  assert.ok(logs.some((line) => /^Namespace's Mac ns-1 is suspended before the host served: Namespace lists it suspended\. bb-box saw it \d+\.\d s after the Mac ran, and stops waiting for it\.$/.test(line)), logs.join("\n"));
  assert.ok(logs.some((line) => line.startsWith("The Namespace host's Mac ns-1 did not start, so bb-box destroys it and starts a fresh Namespace Mac, once: Namespace's Mac ns-1 is suspended before the host served")), logs.join("\n"));
  assert.deepEqual(destroyed, ["ns-1"]);
  await hosts.release(slot);
});

test("a Namespace Mac Namespace no longer lists, or that its API cannot describe, is told apart: gone fails the start's try, a failed read does not (F-11)", async () => {
  let reads = 0;
  const { hosts, logs } = harness({
    access: {
      describe: async (id) => {
        reads++;
        if (id === "ns-1" && reads > 3) return null;
        if (reads <= 3) throw new Error("Namespace's API answered 503");
        return instance(id);
      },
      answers: async (id, _deadline, signal) => {
        if (id !== "ns-1") return;
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    },
  });
  const promised = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  const slot = await hosts.acquire(box("b1"), promised as Guest, hooks, signal());
  assert.equal(namespaceSlotOf(slot)?.instance, "ns-2");
  assert.ok(reads > 3, "failed reads were not taken as gone");
  assert.ok(logs.some((line) => line.startsWith("Namespace's Mac ns-1 is gone before the host served: Namespace no longer lists it.")), logs.join("\n"));
  await hosts.release(slot);
});

test("a host lends no new slot in the hour before its end, and a box asked for then waits with words (065, unit 7)", async () => {
  let now = 1_000_000;
  const { hosts, setClock } = harness({ now: () => now });
  const promised = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  await serving(hosts);
  await hosts.acquire(box("b1"), promised as Guest, hooks, signal());
  setClock(() => now + 3.5 * 3600_000);
  const late = await hosts.offer("ios", null, signal());
  assert.equal(late.tier, "wait");
  assert.match("words" in late ? late.words : "", /^The Namespace host ends at \d\d:\d\d UTC, within the hour/);
  now = 0;
});

test("a host whose Mac cannot run the iOS Simulator fails with words, its machine destroyed, and the upkeep clears it (065, unit 7)", async () => {
  const measured = { ...REPORT, capabilities: { ...REPORT.capabilities, simulator: { is: "no" as const, why: "it has no Xcode" } } };
  const { hosts, destroyed } = harness({ measured });
  const promised = await hosts.take(await hosts.offer("ios", null, signal()), box("b1"), signal());
  await assert.rejects(hosts.acquire(box("b1"), promised as Guest, hooks, signal()), /The Namespace host failed: its Mac cannot run the iOS Simulator: it has no Xcode That was a fresh Namespace Mac's start; the first one's failed too: its Mac cannot run the iOS Simulator: it has no Xcode/);
  assert.deepEqual(destroyed, ["ns-1", "ns-2"]);
  const after = await hosts.offer("ios", null, signal());
  assert.match("words" in after ? after.words : "", /^The last Namespace host failed/);
  await hosts.maintain(signal());
  assert.equal(await hosts.record(), null);
  assert.equal((await hosts.offer("ios", null, signal())).tier, "new-host");
});

test("no host starts while the workspace's Mac is taken, or before a Namespace Mac is measured (065, unit 7)", async () => {
  const taken = harness({ room: "Namespace's workspace has 6 of its 6 Mac cores in use." });
  const words = await taken.hosts.offer("ios", null, signal());
  assert.deepEqual(words, { tier: "wait", words: "No Namespace host can start now: Namespace's workspace has 6 of its 6 Mac cores in use." });
  const unmeasured = harness({ report: null });
  assert.equal(unmeasured.hosts.lends("ios"), false);
  assert.match("words" in (await unmeasured.hosts.offer("ios", null, signal())) ? ((await unmeasured.hosts.offer("ios", null, signal())) as { words: string }).words : "", /has not measured a Namespace Mac yet/);
});
