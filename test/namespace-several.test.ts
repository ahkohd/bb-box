import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEP_AHEAD_MS, LABELS, NamespaceBackend } from "../src/backends/namespace/backend.ts";
import { HOST_RECORD_KEY, NAMESPACE_HOST_ROLE, type NamespaceHostRecord } from "../src/backends/namespace/ios-hosts.ts";
import { NamespaceOwner } from "../src/backends/namespace/owner.ts";
import type { NamespaceConfig } from "../src/backends/namespace/config.ts";
import { reportKey, PROBE_VERSION, type MacReport } from "../src/core/mac-capabilities.ts";
import { Tailnet, isInstallDevice, tailnetHostname } from "../src/core/tailnet.ts";
import type { AcquireHooks, BackendStorage, BoxIdentity, Guest } from "../src/backends/types.ts";
import { ImageJobs } from "../src/plugin/images.ts";
import { ownImageLines } from "../src/plugin/views.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace, type FakeInstance } from "./fake-namespace.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG: NamespaceConfig = { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 2, longestLifeHours: 4, largestMachine: null };
const FIRST = "namespace";
const TEAM_B = "namespace:team-b";
const SECOND_TOKEN = "nsct_secondWORKSPACEtoken.0123456789";
const START = Date.parse("2030-01-01T00:00:00Z");
const IMAGE_SCRIPT = (target: string, tag: string) => `cat >/dev/null; echo "nscr.io/ws1/bbbox/${target}:${tag}"`;

const IOS_REPORT: MacReport = {
  mac: "Apple M4 Pro (Virtual)",
  chip: "Apple M4 Pro (Virtual)",
  macos: "26.3.1",
  at: 1,
  where: "mac",
  capabilities: {
    simulator: { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2"], newest: { os: "26.2", build: "23C54" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17"] } },
    hardwareEncoder: { is: "yes", what: { fullSizeFps: 141 } },
    softwareEncoder: { is: "no", why: "bb-box-h264 is not installed" },
  },
  probe: PROBE_VERSION,
};

interface BackendOptions {
  readonly config?: Partial<NamespaceConfig>;
  readonly now?: () => number;
  readonly storage?: BackendStorage;
  readonly tailnet?: Tailnet;
  readonly installId?: string;
  readonly logs?: string[];
}

function workspace(now?: () => number): FakeNamespace {
  return new FakeNamespace({ ...(now ? { now } : {}), lifeCapMs: 4 * 3600_000, maxCores: 64 });
}

function backendOn(fake: FakeNamespace, id: string, options: BackendOptions = {}): NamespaceBackend {
  fakeSsh();
  const context = {
    ...testContext(options.storage ?? new MemoryStorage(), options.installId ?? "inst1", { id }),
    bbUrl: () => "https://bb.example",
    images: { bbApp: async () => "a".repeat(64) },
    ...(options.tailnet ? { tailnet: () => options.tailnet! } : {}),
    ...(options.logs ? { log: (line: string) => void options.logs!.push(line) } : {}),
  } as never;
  return disposed(
    new NamespaceBackend({ ...CONFIG, token: fake.token, ...options.config }, context, {
      fetch: fake.fetch,
      sshBinary: FAKE_SSH_BINARY,
      sleep: async () => {},
      readyTimeoutMs: 20_000,
      cuaScript: ":",
      setupArchive: async () => Buffer.from("the setup scripts"),
      linuxImageScript: IMAGE_SCRIPT,
      ...(options.now ? { now: options.now } : {}),
    }),
  );
}

function box(id: string, kind = "macos"): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind, createdAt: START, size: { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "none" } };
}

const HOOKS: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
const RELEASE = { resetting: async () => {}, timing: () => {} };

function acquire(backend: NamespaceBackend, id: string): Promise<Guest> {
  return backend.acquire(box(id), null, HOOKS, new AbortController().signal);
}

function machineOf(fake: FakeInstance[] | FakeNamespace, boxId: string): FakeInstance {
  const instances = Array.isArray(fake) ? fake : [...fake.instances.values()];
  return instances.find((instance) => instance.labels[LABELS.box] === boxId)!;
}

function plant(fake: FakeNamespace, id: string, labels: Record<string, string>, createdAt = START): FakeInstance {
  const instance: FakeInstance = {
    id,
    status: "RUNNING",
    labels,
    shape: { os: "linux", machineArch: "amd64", virtualCpu: 4, memoryMegabytes: 8192, selectors: [] },
    uniqueTag: id,
    sshKeys: [],
    createdAt,
    deadline: createdAt + 3_600_000,
    continent: "us",
  };
  fake.instances.set(id, instance);
  return instance;
}

test("two Namespace backends on one workspace each label what they make with their own ID, and each lists, releases and keeps alive only its own machines", async () => {
  let now = START;
  const fake = workspace(() => now);
  const first = backendOn(fake, FIRST, { now: () => now });
  const second = backendOn(fake, TEAM_B, { now: () => now });

  const ownGuest = await acquire(first, "b1");
  const otherGuest = await acquire(second, "b2");

  assert.equal(machineOf(fake, "b1").labels[LABELS.backend], "namespace");
  assert.equal(machineOf(fake, "b2").labels[LABELS.backend], "namespace-team-b");
  assert.equal(machineOf(fake, "b1").uniqueTag, "bbbox-inst1-b1", "the first backend's names are as before");
  assert.equal(machineOf(fake, "b2").uniqueTag, "bbbox-inst1-namespace-team-b-b2");
  assert.deepEqual((await first.held()).map((guest) => guest.data?.box), ["b1"]);
  assert.deepEqual((await second.held()).map((guest) => guest.data?.box), ["b2"]);

  await second.release(ownGuest, RELEASE);
  assert.equal(machineOf(fake, "b1").status, "RUNNING", "a release by another backend leaves the machine");
  assert.equal(await second.power(ownGuest), null);

  now += 40 * 60_000;
  await second.maintain(undefined, new Set([ownGuest.ref, otherGuest.ref]));
  assert.equal(machineOf(fake, "b2").deadline, now + KEEP_AHEAD_MS, "its own machine is kept alive");
  assert.equal(machineOf(fake, "b1").deadline, START + KEEP_AHEAD_MS, "the other backend's is not");
});

test("after the upgrade, a machine labelled only with the install is the first Namespace backend's: it holds, releases and sweeps it, and a second backend never does", async () => {
  const fake = workspace();
  const first = backendOn(fake, FIRST);
  const second = backendOn(fake, TEAM_B);
  const older = plant(fake, "older1", { [LABELS.install]: "inst1", [LABELS.box]: "old", [LABELS.thread]: "thr_1", [LABELS.name]: "box-old", [LABELS.kind]: "linux", [LABELS.created]: String(START) });
  const guest: Guest = { ref: "bbbox-inst1-old", host: null, address: null, size: null, data: { box: "old", instance: older.id } };

  assert.deepEqual((await second.held()).map((held) => held.data?.box), []);
  assert.deepEqual((await first.held()).map((held) => held.owner?.boxId), ["old"]);

  await second.release(guest, RELEASE);
  assert.equal(older.status, "RUNNING");
  await first.release(guest, RELEASE);
  assert.equal(older.status, "DESTROYED");
});

test("Most machines counts the backend's own machines and other installs', but not another backend's of the same install", async () => {
  const fake = workspace();
  const first = backendOn(fake, FIRST, { config: { machines: 1 } });
  const second = backendOn(fake, TEAM_B, { config: { machines: 1 } });
  const size = { cores: 4, memoryMiB: 8192, diskGiB: null };

  await acquire(first, "b1");
  assert.equal((await first.capacity("macos", size, [])).ok, false);
  assert.equal((await second.capacity("macos", size, [])).ok, true, "the first backend's machine is not the second's");

  plant(fake, "elsewhere1", { [LABELS.install]: "inst2", [LABELS.backend]: "namespace" });
  const full = await second.capacity("macos", size, []);
  assert.equal(full.ok, false);
  assert.equal(full.message, "Namespace (team-b) has 1 of the 1 machines BB Box may have at once, counting other BB Box installs' in the workspace. Release a box, or raise the most machines in BB Box's settings.");
});

test("each backend builds its own Linux images, labelled and tagged with its ID, and its upkeep destroys only its own leftover build machines", async () => {
  const fake = workspace(() => START);
  const first = backendOn(fake, FIRST, { now: () => START });
  const logs: string[] = [];
  const second = backendOn(fake, TEAM_B, { now: () => START, logs });

  const image = await second.linuxImages.forBox("linux", new AbortController().signal);
  assert.ok(logs.some((line) => line.startsWith("Namespace (team-b): built and pushed the linux image")), logs.join("\n"));
  assert.match(image.ref, /^nscr\.io\/ws1\/bbbox\/linux:team-b-[0-9a-f]{12}-aaaaaaaaaaaa$/);
  const build = [...fake.instances.values()].find((instance) => instance.labels["bbbox-role"] === "image-build")!;
  assert.equal(build.labels[LABELS.backend], "namespace-team-b");
  assert.equal(build.uniqueTag, "bbbox-inst1-namespace-team-b-image-linux", "not the first backend's build of the same image");
  assert.equal(await first.linuxImages.record("linux"), undefined, "the first backend has no image from it");

  const earlier = START - 10 * 60_000;
  const firsts = plant(fake, "firstbuild", { [LABELS.install]: "inst1", [LABELS.backend]: "namespace", "bbbox-role": "image-build", "bbbox-target": "desktop" }, earlier);
  const older = plant(fake, "olderbuild", { [LABELS.install]: "inst1", "bbbox-role": "image-build", "bbbox-target": "desktop" }, earlier);
  const seconds = plant(fake, "secondbuild", { [LABELS.install]: "inst1", [LABELS.backend]: "namespace-team-b", "bbbox-role": "image-build", "bbbox-target": "desktop" }, earlier);
  await second.maintain();
  assert.deepEqual([firsts.status, older.status, seconds.status], ["RUNNING", "RUNNING", "DESTROYED"]);
  await first.maintain();
  assert.deepEqual([firsts.status, older.status], ["DESTROYED", "DESTROYED"]);
});

interface StaleDevice {
  readonly nodeId: string;
  readonly hostname: string;
}

function tailnetOf(devices: readonly StaleDevice[]): { readonly tailnet: Tailnet; readonly removed: string[] } {
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

function tailnetNameOf(backendId: string, installId: string, box: string): string {
  return tailnetHostname(`${new NamespaceOwner(backendId, installId).tailnetPrefix()}${box}`);
}

test("each backend's upkeep removes only its own machines' stale tailnet devices, and the doctor counts both as the install's", async () => {
  const secondPrefix = new NamespaceOwner(TEAM_B, "inst1").tailnetPrefix();
  const devices = [
    { nodeId: "first-gone", hostname: "bb-box-ns-inst1-gone-box" },
    { nodeId: "second-gone", hostname: `${secondPrefix}gone-box` },
  ];
  const { tailnet, removed } = tailnetOf(devices);
  const fake = workspace();

  assert.equal(secondPrefix, "bb-box-nsb-inst1-6-team-b-");
  assert.ok(devices.every((device) => isInstallDevice(device.hostname, "inst1")));
  await backendOn(fake, TEAM_B, { tailnet }).maintain();
  assert.deepEqual(removed, ["second-gone"]);
  await backendOn(fake, FIRST, { tailnet }).maintain();
  assert.deepEqual(removed, ["second-gone", "first-gone"]);
});

test("namespace:team-339 and namespace:team-3245, whose earlier tailnet codes matched, each remove only their own stale devices (#1455)", async () => {
  const devices = [
    { nodeId: "belongs-to-339", hostname: tailnetNameOf("namespace:team-339", "inst1", "gone-box") },
    { nodeId: "belongs-to-3245", hostname: tailnetNameOf("namespace:team-3245", "inst1", "gone-box") },
  ];
  const { tailnet, removed } = tailnetOf(devices);
  const fake = workspace();

  await backendOn(fake, "namespace:team-339", { tailnet }).maintain();
  assert.deepEqual(removed, ["belongs-to-339"]);

  await backendOn(fake, "namespace:team-3245", { tailnet }).maintain();
  assert.deepEqual(removed, ["belongs-to-339", "belongs-to-3245"]);
});

test("no Namespace backend's tailnet names start with another's prefix, for names that look alike and the longest install ID and name (#1455)", () => {
  const names = ["a", "a-1", "1-a", "1", "11", "1-1", "a1", "1a", "team-339", "team-3245", "team-b", "team-bb", "b-team", "10-x", "x-10", "a".repeat(14), "a".repeat(15), `${"a".repeat(14)}b`];
  const ids = [FIRST, ...names.map((name) => `namespace:${name}`)];

  for (const installId of ["inst1", "x".repeat(32)]) {
    for (const mine of ids) {
      const prefix = new NamespaceOwner(mine, installId).tailnetPrefix();
      assert.ok(prefix.length <= 63, `${mine}'s prefix fits a tailnet name on install ${installId}`);
      for (const theirs of ids.filter((id) => id !== mine)) {
        for (const box of ["", "b", "gone-box", "z".repeat(63)]) {
          const theirName = tailnetNameOf(theirs, installId, box);
          assert.ok(!theirName.startsWith(prefix), `${mine} would take ${theirs}'s ${theirName} on install ${installId}`);
        }
      }
    }
  }
});

test("two Namespace backends on two workspaces each start a shared iOS host with their own token, labelled with the backend and recorded as on it", async () => {
  const workspaces = { [FIRST]: workspace(), [TEAM_B]: workspace() };
  workspaces[TEAM_B].token = SECOND_TOKEN;
  const storages = { [FIRST]: new MemoryStorage(), [TEAM_B]: new MemoryStorage() };
  for (const storage of Object.values(storages)) await storage.set(reportKey(IOS_REPORT.mac), IOS_REPORT);

  for (const id of [FIRST, TEAM_B] as const) {
    const backend = backendOn(workspaces[id], id, { storage: storages[id], config: { iosHosts: { on: true, most: 2, ahead: 0, resettingMost: 1, diskReserveGiB: 0 } } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const signal = new AbortController().signal;
    const tier = await backend.slots.offer("ios", null, signal);
    assert.equal(tier.tier, "new-host", JSON.stringify(tier));
    await backend.slots.take(tier, box(`ios-${id}`, "ios"), signal);
    for (let wait = 0; wait < 200 && ![...workspaces[id].instances.values()].some((instance) => instance.labels[LABELS.role] === NAMESPACE_HOST_ROLE); wait++) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  for (const id of [FIRST, TEAM_B] as const) {
    const hosts = [...workspaces[id].instances.values()].filter((instance) => instance.labels[LABELS.role] === NAMESPACE_HOST_ROLE);
    assert.equal(hosts.length, 1, `${id} made one host in its own workspace`);
    assert.equal(hosts[0]!.labels[LABELS.backend], new NamespaceOwner(id, "inst1").backendMark);
    assert.equal((await storages[id].get<NamespaceHostRecord>(HOST_RECORD_KEY))?.backend, id);
  }
  assert.ok(workspaces[TEAM_B].calls.some((call) => call.method === "CreateInstance"), "the second backend's host was asked of its workspace, with its token");
});

test("a second Namespace backend is named by its ID in its label, and the first keeps the type's name", () => {
  const fake = workspace();
  assert.equal(backendOn(fake, FIRST).label, "Namespace");
  assert.equal(backendOn(fake, TEAM_B).label, "Namespace (team-b)");
});

test("bb box images list shows each Namespace backend's own Linux images, by backend, with where each is and whether it is due", async () => {
  const fake = workspace(() => START);
  const first = backendOn(fake, FIRST, { now: () => START });
  const second = backendOn(fake, TEAM_B, { now: () => START });
  await second.linuxImages.forBox("linux", new AbortController().signal);
  const jobs = new ImageJobs({ backends: () => [first, second], setup: "", bbUrl: () => null, facts: {} as never, storage: new MemoryStorage() });

  const lines = (await jobs.ownImages()).flatMap((of) => ownImageLines(of, START));

  assert.equal(lines.length, 6);
  assert.equal(lines[0], "namespace/linux (linux): not built yet; Namespace builds it when a box first needs it.");
  assert.match(lines[3]!, /^namespace:team-b\/linux \(linux\): nscr\.io\/ws1\/bbbox\/linux:team-b-[0-9a-f]{12}-a{12}, built today; not due; Namespace \(team-b\) builds and refreshes it by itself\.$/);
  assert.equal(lines[4], "namespace:team-b/linux-desktop-cpu (linux-desktop-cpu): not built yet; Namespace (team-b) builds it when a box first needs it.");
});
