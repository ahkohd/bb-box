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
      this.setUp = true;
      return answer(0, "ios=26.2 23C54 ios-26.2-23C54 companion=1.7.7\n");
    }
    if (script.startsWith("sudo -n -H -u ")) return answer(0);
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

function harness(options: { report?: MacReport | null; room?: string | null; measured?: MacReport; now?: () => number } = {}) {
  const host = new StubHost();
  const storage = new MemoryStorage();
  const destroyed: string[] = [];
  const logs: string[] = [];
  let made = 0;
  let clock = options.now ?? (() => 1_000_000);
  const access: NamespaceHostsAccess = {
    installId: "inst1",
    storage,
    settings: () => ({ on: true, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 }),
    longestLifeMs: () => 4 * 3600_000,
    now: () => clock(),
    sleep: async () => {},
    report: () => (options.report === undefined ? REPORT : options.report),
    room: async () => ({ shape: { cores: 6, memoryGB: 14 }, words: options.room ?? null }),
    create: async () => instance(`ns-${++made}`),
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
  const hosts = new NamespaceHosts(access);
  return { hosts, host, storage, destroyed, logs, setClock: (next: () => number) => (clock = next) };
}

function box(id: string): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "ios", createdAt: 1, size: { cores: 6, memoryMiB: 14336, diskGiB: null } };
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

test("Namespace's ios offer comes from its last Mac measured: a model its Xcode makes, its newest runtime, and bb-box's list for it (065, unit 7)", () => {
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
  assert.match((namespaceDeviceOffer(noModel) as { why: string }).why, /can make none of bb-box's iOS devices/);
  assert.match((namespaceDeviceOffer({ ...REPORT, capabilities: NOT_MEASURED }) as { why: string }).why, /cannot run the iOS Simulator/);
});

test("a host's setup unpacks bb-box's setup and runs mac-ios.sh as root with the host's settings, as a host deleted after its last box", () => {
  const script = hostSetupScript({ most: 4, ahead: 1, resettingMost: 2, diskReserveGiB: 20 });
  assert.match(script, /sudo -n env HOST_SETTINGS='most=4\nahead=1\nresetting-most=2\ndisk-reserve-gib=20' \/bin\/sh "\$here\/ssh-pool\/mac-ios\.sh" "\$here\/ssh-pool" "\$\(id -un\)"/);
  assert.match(UNPACK_SETUP, /tar -xzf - -C "\$HOME\/bb-box-setup"/);
});

test("a slot's commands run as its user through the host's own SSH and sudo, as Namespace's Macs have no sshd for other users", async () => {
  assert.equal(asSlotUser("bbd-3", "echo hi"), "sudo -n -H -u 'bbd-3' -- /bin/zsh -c 'cd ~ 2>/dev/null || exit 1\necho hi'");
  const ran: { script: string; stdin: unknown }[] = [];
  const host = { run: async (script: string, options: RunOptions = {}) => (ran.push({ script, stdin: options.stdin }), { exitCode: 0, stdout: "x\nbb-box-read:aGVsbG8=\n", stderr: "", timedOut: false }) };
  const slot = new SlotUserTransport(host as never, "bbd-3");
  await slot.writeFile("notes/a.txt", new TextEncoder().encode("hello"), { mode: "600" });
  assert.match(ran[0]!.script, /^sudo -n -H -u 'bbd-3' -- \/bin\/zsh -c /);
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
  assert.ok(transports.daemonKeptByHost);
  const guest2 = await hosts.acquire(box("b2"), promise2 as Guest, hooks, signal());
  assert.equal(namespaceSlotOf(guest2)?.slot, "2");
  assert.deepEqual((await hosts.held(signal())).map((each) => [each.owner?.boxId, namespaceSlotOf(each)?.slot]).sort(), [["b1", "1"], ["b2", "2"]]);
  assert.equal((await hosts.doctor(signal())).status, "ok");
  assert.match((await hosts.doctor(signal())).detail, /2 held, 0 ready, 0 making, 0 sweeping, of 4; ends at \d\d:\d\d UTC; video by software, as its Mac has no hardware H\.264 encoder\./);
  assert.deepEqual(await hosts.release(guest1), { last: false });
  assert.deepEqual(destroyed, []);
  assert.deepEqual(await hosts.release(guest2), { last: true });
  assert.deepEqual(destroyed, ["ns-1"]);
  assert.equal(await storage.get(HOST_RECORD_KEY), undefined);
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
  await assert.rejects(hosts.acquire(box("b1"), promised as Guest, hooks, signal()), /The Namespace host failed: its Mac cannot run the iOS Simulator: it has no Xcode/);
  assert.deepEqual(destroyed, ["ns-1"]);
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
