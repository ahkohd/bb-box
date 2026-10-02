// bb-box's configuration document (029): the move from BB's settings, each
// start cut short after each of its steps, the settings RPC and the
// `bb box config` commands. Values are made up; addresses come from
// 192.0.2.0/24, which is reserved for documentation.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { DRIVERS, layeredStorage } from "../src/backends/index.ts";
import { parseLxcSettings } from "../src/backends/proxmox-lxc/config.ts";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { sshPoolDriver } from "../src/backends/ssh-pool/index.ts";
import { parseTartSettings } from "../src/backends/tart/config.ts";
import { tartDriver } from "../src/backends/tart/index.ts";
import type { BackendContext, BackendDriver, DoctorReport } from "../src/backends/types.ts";
import { backendPart, checkDocument, exported, generalConfig, readDraft, upgradeDocument, withSecretChanges, type ConfigDocument, type Secrets } from "../src/core/document.ts";
import { CLEARED_KEY, COPY_KEY, DOCUMENT_KEY, SECRETS_KEY, SIZES_ADOPTED_KEY, fromSettings, type MovedCopy } from "../src/core/move.ts";
import { boundedDoctor, type ApplyResult, type CheckResult, type ConfigState } from "../src/plugin/configuration.ts";
import { setup, type BbBox } from "../src/plugin/setup.ts";
import { FakeBackend, fakeDriver } from "./fake-backend.ts";
import { KEY, MemoryStorage, tempDir } from "./helpers.ts";

const THREAD = "thr_config";
const TOKEN = "0a1b2c3d-made-up-token-secret";
const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7 + 16).toString(16).toUpperCase().padStart(2, "0")).join(":");

/**
 * BB's settings as an install before 029 has them, in the shape BB gives a
 * plugin: every declared key, with its default when unset. Proxmox LXC was
 * set up with the setup guide, then its Linux keys renamed by 027 while the
 * keys before 027 kept their old values, and its sizes saved before 028.
 */
const SAVED: Record<string, PluginSettingValue> = {
  "boxes-per-thread": 0,
  "enrol-boxes": false,
  "proxmox-lxc-enabled": true,
  "proxmox-lxc-url": "https://192.0.2.10:8006/api2/json",
  "proxmox-lxc-token-id": "bbbox@pve!plugin",
  "proxmox-lxc-token-secret": TOKEN,
  "proxmox-lxc-tls-fingerprint": FINGERPRINT,
  "proxmox-lxc-ca-certificate": "",
  "proxmox-lxc-node": "pve-test",
  "proxmox-lxc-pool": "bbbox",
  "proxmox-lxc-linux-templates": "9100",
  "proxmox-lxc-linux-warm": 1,
  "proxmox-lxc-desktop-templates": "9101 GPU-00000000-0000-0000-0000-000000000001\n9102 GPU-00000000-0000-0000-0000-000000000002",
  "proxmox-lxc-desktop-warm": 1,
  "proxmox-lxc-desktop-cpu-templates": "9103",
  "proxmox-lxc-desktop-cpu-warm": 0,
  "proxmox-lxc-desktops-per-gpu": 2,
  "proxmox-lxc-vmid-first": 9900,
  "proxmox-lxc-vmid-last": 9999,
  "proxmox-lxc-bridge": "vmbr9",
  "proxmox-lxc-subnet": "192.0.2.0/24",
  "proxmox-lxc-gateway": "192.0.2.1",
  "proxmox-lxc-addresses": "192.0.2.100-192.0.2.199",
  "proxmox-lxc-ssh-private-key": KEY,
  "proxmox-lxc-ssh-user": "box",
  "proxmox-lxc-reserve-memory-mib": 8192,
  "proxmox-lxc-reserve-disk-gib": 50,
  "proxmox-lxc-linux-cores": 4,
  "proxmox-lxc-linux-memory-mib": 8192,
  "proxmox-lxc-linux-disk-gib": 0,
  "proxmox-lxc-headless-templates": "9000",
  "proxmox-lxc-headless-warm": 3,
  "ssh-pool-enabled": false,
  "ssh-pool-machines": "",
  "ssh-pool-known-hosts": "",
};

/** Faults a start can meet: a storage write or BB's settings write that fails, as when the server stops then. */
interface Faults {
  failWrite?: string;
  failClear?: boolean;
}

/** BB's settings handles each start declared, to read what BB keeps. */
type Handle = { get(): Promise<Record<string, unknown>> };

function withFaults(bb: BbPluginApi, faults: Faults, handles: Handle[]): BbPluginApi {
  const kv = bb.storage.kv;
  const storage = {
    ...bb.storage,
    kv: {
      get: <T,>(key: string) => kv.get<T>(key),
      list: (prefix?: string) => kv.list(prefix),
      delete: (key: string) => kv.delete(key),
      async set(key: string, value: unknown) {
        if (key === faults.failWrite) throw new Error(`cut short before ${key}`);
        await kv.set(key, value);
      },
    },
  };
  const settings = {
    define(descriptors: never) {
      const handle = bb.settings.define(descriptors);
      handles.push(handle as Handle);
      return {
        get: () => handle.get(),
        onChange: (listener: never) => handle.onChange(listener),
        async experimental_set(values: never) {
          if (faults.failClear) throw new Error("cut short before clearing");
          return handle.experimental_set(values);
        },
      };
    },
  };
  return Object.create(bb, { storage: { value: storage }, settings: { value: settings } }) as BbPluginApi;
}

/** A driver made like Proxmox LXC's, whose backend is the fake one, so the move reads realistic settings. */
function lxcLike(root: string, built: FakeBackend[]): BackendDriver<any> {
  return {
    ...proxmoxLxcDriver,
    create: (_config, context) => {
      const backend = new FakeBackend({ root, id: context.id, storage: context.storage, installId: context.installId });
      built.push(backend);
      return backend;
    },
  };
}

/**
 * Starts the plugin with the fake backend, a Proxmox LXC driver whose
 * backends are fake ones, and the SSH host pool, as the plugin's drivers.
 */
async function start(settings: Record<string, PluginSettingValue>, options: { faults?: Faults; seed?: Record<string, unknown>; drivers?: BackendDriver<any>[] } = {}) {
  const root = tempDir("config");
  const threads = new Map([[THREAD, makeThreadResponse({ id: THREAD, projectId: "prj_config", environmentId: "env_config" })]]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-box",
    settings,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads.get(threadId);
          if (!thread) throw Object.assign(new Error("HTTP 404: Thread not found"), { status: 404, code: "thread_not_found" });
          return thread;
        },
      },
      system: { machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, variables: [] }) },
      projects: { machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, inheritedVariables: [], variables: [] }) },
    } as never,
  });
  const world = {
    backend: null as FakeBackend | null,
    contexts: [] as BackendContext[],
    built: [] as FakeBackend[],
    /** The context each backend of the other drivers was built with, by backend ID. */
    real: new Map<string, BackendContext>(),
    handles: [] as Handle[],
    kv: bb.storage.kv,
  };
  for (const [key, value] of Object.entries(options.seed ?? {})) await bb.storage.kv.set(key, value);
  const recorded = (driver: BackendDriver<any>): BackendDriver<any> => ({
    ...driver,
    create: (config, context) => {
      world.real.set(context.id, context);
      return driver.create(config, context);
    },
  });
  const drivers = [fakeDriver(root, world), recorded(lxcLike(root, world.built)), recorded(sshPoolDriver), recorded(tartDriver), ...(options.drivers ?? [])];
  const options_ = { drivers, daemonParent: join(root, "no-daemon") };
  const begin = (on: BbPluginApi, faults: Faults = {}) => setup(withFaults(on, faults, world.handles), options_);
  let app: BbBox | null = null;
  let failure: unknown = null;
  try {
    app = await begin(bb, options.faults);
  } catch (error) {
    failure = error;
  }
  /** Starts the plugin again on the same storage and settings. */
  let current = harness;
  const restart = async (faults: Faults = {}) => {
    let next: BbBox | null = null;
    const replacement = await current.lifecycle.reload(async (fresh) => {
      world.kv = fresh.storage.kv;
      next = await begin(fresh, faults);
    });
    current = replacement.harness;
    app = next;
    return next!;
  };
  t_dispose.push(() => current.lifecycle.dispose());
  return { harness, latest: () => current, world, failure, app: () => app!, restart, rpc: <T,>(method: string, input: unknown) => harness.behavior.callRpc(method, input) as Promise<T> };
}

const t_dispose: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const dispose of t_dispose.splice(0)) await dispose().catch(() => {});
});

/** The storage of the latest start. */
const kvOf = (world: { kv: BbPluginApi["storage"]["kv"] }) => world.kv;

/** Every storage key and value outside the configuration's own keys. */
async function outsideConfig(world: { kv: BbPluginApi["storage"]["kv"] }): Promise<Record<string, unknown>> {
  const kv = kvOf(world);
  const all: Record<string, unknown> = {};
  for (const key of await kv.list("")) if (!key.startsWith("config/")) all[key] = await kv.get(key);
  return all;
}

// The move.

test("the move builds the document from realistic saved settings, keeping secrets apart and the backend's config as it was", () => {
  const { document, secrets, notes } = fromSettings(SAVED, DRIVERS, false);
  assert.deepEqual(notes, []);
  assert.deepEqual(document.general, { enrol: false });
  assert.deepEqual(document.kinds, { linux: { presets: { small: { cores: 4, memoryMiB: 8192 } } } });
  assert.equal(document.revision, 1);
  assert.equal(document.backends.length, 1, "the SSH host pool was never set, so it is not in the document");
  const [lxc] = document.backends;
  assert.equal(lxc!.id, "proxmox-lxc", "boxes, storage and guests keep their backend ID");
  assert.equal(lxc!.enabled, true);
  assert.deepEqual(lxc!.warm, { linux: 1, "linux-desktop": 1 }, "a set Linux key wins over its key before 027");
  assert.equal(lxc!.fields["linux-templates"], undefined, "a value equal to its default is left out");
  assert.equal(lxc!.fields.pool, undefined);
  assert.equal(lxc!.fields["reserve-memory-mib"], 8192);
  for (const value of Object.values(lxc!.fields)) assert.notEqual(value, TOKEN);
  assert.deepEqual(secrets, { "proxmox-lxc": { "token-secret": TOKEN, "ssh-private-key": KEY } });

  // The backend is built from the same config as before, so nothing is rebuilt differently.
  const before = parseLxcSettings(SAVED);
  const after = proxmoxLxcDriver.parse(backendPart(lxc!, proxmoxLxcDriver, secrets));
  assert.ok(before.enabled && before.ok && after.ok, JSON.stringify(after));
  assert.deepEqual(after.config, before.config);
  assert.deepEqual(checkDocument(document, secrets, DRIVERS), []);
});

test("Tart's Macs move in as hosts, each with its host keys, and parse to the config they had", () => {
  const keys = ["192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne", "[192.0.2.21]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITwo", "|1|abc=|def= ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHashed"];
  const values = {
    "tart-enabled": true,
    "tart-hosts": "mac1 bbbox-admin@192.0.2.20\nmac2 admin@192.0.2.21:2222",
    "tart-host-keys": keys.join("\n"),
    "tart-ssh-private-key": KEY,
    "tart-vms-per-host": 1,
  };
  const { document, secrets } = fromSettings(values, DRIVERS, true);
  const [tart] = document.backends;
  assert.equal(tart!.id, "tart");
  assert.deepEqual(tart!.fields, { "vms-per-host": 1 });
  assert.deepEqual(secrets, { tart: { "ssh-private-key": KEY } });
  assert.deepEqual(tart!.hosts, [
    { name: "mac1", enabled: true, fields: { address: "192.0.2.20", user: "bbbox-admin", "host-keys": `${keys[0]}\n${keys[2]}` } },
    { name: "mac2", enabled: true, fields: { address: "192.0.2.21:2222", user: "admin", "host-keys": `${keys[1]}\n${keys[2]}` } },
  ]);
  const before = parseTartSettings(values);
  const after = tartDriver.parse(backendPart(tart!, tartDriver, secrets));
  assert.ok(before.enabled && before.ok && after.ok, JSON.stringify(after));
  assert.deepEqual({ ...after.config, hostKeys: [...after.config.hostKeys].sort() }, { ...before.config, hostKeys: [...before.config.hostKeys].sort() });

  const missing = tartDriver.parse(backendPart({ ...tart!, hosts: [{ name: "mac3", enabled: true, fields: { address: "192.0.2.22" } }] }, tartDriver, secrets));
  assert.ok(!missing.ok);
  assert.deepEqual(missing.problems.map((problem) => problem.path), ["hosts.0.user", "hosts.0.host-keys"]);
});

test("the move does 028's size move first when that never ran, and only then", () => {
  assert.deepEqual(fromSettings(SAVED, DRIVERS, true).document.kinds, {}, "box-sizes is empty, and 028 already read the size keys");
  const adopted = JSON.stringify({ linux: { default: "medium" } });
  assert.deepEqual(fromSettings({ ...SAVED, "box-sizes": adopted }, DRIVERS, true).document.kinds, { linux: { default: "medium" } });
  // An earlier kind ID counts where the current one has no entry.
  assert.deepEqual(fromSettings({ "box-sizes": JSON.stringify({ "linux-headless": { default: "large" } }) }, DRIVERS, true).document.kinds, { linux: { default: "large" } });
});

test("a new install moves to a document with no backends", () => {
  const defaults = { "boxes-per-thread": 0, "enrol-boxes": true, "proxmox-lxc-enabled": true, "proxmox-lxc-pool": "bbbox", "ssh-pool-enabled": false };
  const { document, secrets } = fromSettings(defaults, DRIVERS, false);
  assert.deepEqual(document, { schema: 1, revision: 1, backends: [], kinds: {}, general: {} });
  assert.deepEqual(secrets, {});
});

test("an off backend moves in off, and a value that is not valid moves as it is", () => {
  const { document } = fromSettings({ ...SAVED, "proxmox-lxc-enabled": false, "proxmox-lxc-subnet": "not a subnet" }, DRIVERS, true);
  assert.equal(document.backends[0]!.enabled, false);
  assert.equal(document.backends[0]!.fields.subnet, "not a subnet");
});

test("the first start moves BB's settings: secrets, then the copy, then the document, then clears them; the next start changes nothing", async () => {
  const { app, world, harness, latest, restart } = await start(SAVED);
  const kv = kvOf(world);

  const document = (await kv.get<ConfigDocument>(DOCUMENT_KEY))!;
  assert.equal(document.revision, 1);
  assert.equal(document.backends[0]!.id, "proxmox-lxc");
  assert.deepEqual(await kv.get<Secrets>(SECRETS_KEY), { "proxmox-lxc": { "token-secret": TOKEN, "ssh-private-key": KEY } });
  const copy = (await kv.get<MovedCopy>(COPY_KEY))!;
  assert.equal(copy.version, "0.2.0");
  assert.equal(copy.values["proxmox-lxc-url"], SAVED["proxmox-lxc-url"]);
  assert.deepEqual(copy.values["proxmox-lxc-token-secret"], { set: true });
  assert.deepEqual(copy.values["ssh-pool-ssh-private-key"], { set: false });
  assert.ok(!JSON.stringify(copy).includes(TOKEN) && !JSON.stringify(copy).includes("OPENSSH PRIVATE KEY"), "the copy holds no secret");
  assert.ok(await kv.get(CLEARED_KEY));
  assert.equal(await kv.get(SIZES_ADOPTED_KEY), undefined, "the mark 028 reads is left as it was, for a version that goes back to BB's settings");
  const cleared = await world.handles[0]!.get();
  assert.equal(cleared["proxmox-lxc-url"], "", "BB's settings are back to their defaults");
  assert.equal(cleared["proxmox-lxc-token-secret"], undefined, "no second copy of a secret is left");
  assert.equal(app().backends.get("proxmox-lxc")?.id, "proxmox-lxc");
  assert.ok(!harness.inspection.logEntries.some((entry) => entry.message.includes(TOKEN)), "no secret is logged");

  await app().boxes.settled(await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const outside = await outsideConfig(world);
  const again = await restart();
  assert.ok(Object.keys(harness.inspection.registrations.settingsDescriptors).includes("proxmox-lxc-url"), "the first start declared the old keys");
  assert.deepEqual(Object.keys(latest().inspection.registrations.settingsDescriptors), [], "and once they are cleared, no start declares them");
  assert.equal(world.handles.length, 1, "the second start declared nothing, so cleared nothing");
  assert.deepEqual(await kvOf(world).get(DOCUMENT_KEY), document);
  assert.deepEqual(await kvOf(world).get(COPY_KEY), copy);
  assert.deepEqual(await outsideConfig(world), outside, "box records and backend storage are as they were");
  assert.equal((await again.boxes.list(THREAD)).length, 1);
});

for (const step of [SECRETS_KEY, COPY_KEY, DOCUMENT_KEY]) {
  test(`a first start cut short before writing ${step} leaves BB's settings, and the next start moves them`, async () => {
    const { world, failure, restart } = await start(SAVED, { faults: { failWrite: step } });
    assert.match(String(failure), new RegExp(`cut short before ${step}`), "the start fails rather than run without its configuration");
    const kv = kvOf(world);
    assert.equal(await kv.get(DOCUMENT_KEY), undefined);
    assert.equal(await kv.get(CLEARED_KEY), undefined);
    assert.equal((await world.handles[0]!.get())["proxmox-lxc-token-secret"], TOKEN, "BB's settings are as they were");

    const app = await restart();
    assert.equal(app.configuration.document.revision, 1);
    assert.deepEqual(app.configuration.secrets, { "proxmox-lxc": { "token-secret": TOKEN, "ssh-private-key": KEY } });
    assert.ok(await kvOf(world).get(COPY_KEY));
    assert.ok(await kvOf(world).get(CLEARED_KEY));
  });
}

test("a start cut short before clearing BB's settings keeps its boxes working, and the next start clears them", async () => {
  const { app, world, harness, restart } = await start({ ...SAVED, "fake-enabled": true }, { faults: { failClear: true } });
  const kv = kvOf(world);
  assert.ok(await kv.get(DOCUMENT_KEY));
  assert.equal(await kv.get(CLEARED_KEY), undefined);
  assert.ok(harness.inspection.logEntries.some((entry) => /clear the settings bb-box moved: cut short before clearing/.test(entry.message)));

  const box = await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await app().boxes.settled(box);
  const backend = app().backends.get("fake");
  // BB's settings still exist and someone changes them: they drive nothing now.
  await harness.behavior.setSettings({ "fake-enabled": false, "proxmox-lxc-enabled": false });
  assert.equal(app().backends.get("fake"), backend, "the backend was not rebuilt or disposed");
  assert.equal((await app().boxes.run(THREAD, box.name, "echo still here")).result.stdout.trim(), "still here");

  const again = await restart();
  assert.ok(await kvOf(world).get(CLEARED_KEY));
  assert.equal((await world.handles.at(-1)!.get())["proxmox-lxc-token-secret"], undefined, "the second start cleared them");
  assert.equal(again.configuration.document.revision, 1, "the document was not made again");
  assert.equal((await again.boxes.run(THREAD, box.name, "echo after the clear")).result.stdout.trim(), "after the clear");
});

test("a start cut short after clearing, before the mark, clears again on the next start and changes nothing else", async () => {
  const { world, restart } = await start(SAVED, { faults: { failWrite: CLEARED_KEY } });
  const document = await kvOf(world).get(DOCUMENT_KEY);
  assert.equal(await kvOf(world).get(CLEARED_KEY), undefined);
  await restart();
  assert.ok(await kvOf(world).get(CLEARED_KEY));
  assert.deepEqual(await kvOf(world).get(DOCUMENT_KEY), document);
  assert.deepEqual((await kvOf(world).get<Secrets>(SECRETS_KEY))!["proxmox-lxc"]!["token-secret"], TOKEN, "the secrets kept their values");
});

test("a document lost after the move starts empty, and keeps the secrets", async () => {
  const { world, restart } = await start(SAVED);
  await kvOf(world).delete(DOCUMENT_KEY);
  const app = await restart();
  assert.deepEqual(app.configuration.document, { schema: 1, revision: 1, backends: [], kinds: {}, general: {} });
  assert.equal(app.configuration.secrets["proxmox-lxc"]!["token-secret"], TOKEN);
});

test("a key a backend generated survives the move and the restarts unchanged, for Tart and the SSH host pool", async () => {
  // bb-box made these keys, so BB's settings have none; each is in its backend's own storage.
  const tartKey = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nTART\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAATART bb-box" };
  const poolKey = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nPOOL\n-----END OPENSSH PRIVATE KEY-----\n", publicKey: "ssh-ed25519 AAAAPOOL bb-box" };
  const seed = { "backend/tart/ssh-key": tartKey, "backend/ssh-pool/ssh-key": poolKey, "backend/ssh-pool/machine/build-1": { generation: 3 } };
  const settings = {
    ...SAVED,
    "tart-enabled": true,
    "tart-hosts": "mac1 bbbox-admin@192.0.2.20",
    "tart-host-keys": "192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMac",
    "tart-reserve-disk-gib": 80,
    "ssh-pool-enabled": true,
    "ssh-pool-machines": "build-1 192.0.2.21 linux",
    "ssh-pool-known-hosts": "192.0.2.21 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPool",
  };
  const { app, world, restart } = await start(settings, { seed });
  const document = app().configuration.document;
  assert.deepEqual(document.backends.map((backend) => [backend.id, backend.enabled]), [["proxmox-lxc", true], ["ssh-pool", true], ["tart", true]]);
  assert.deepEqual(Object.keys(app().configuration.secrets), ["proxmox-lxc"], "a generated key is no secret setting, so nothing replaces it");
  for (const id of ["tart", "ssh-pool"]) {
    assert.equal(app().backends.get(id)?.id, id, `${id} keeps its backend ID`);
    assert.deepEqual(await world.real.get(id)!.storage.get("ssh-key"), seed[`backend/${id}/ssh-key` as keyof typeof seed], `${id} reads the key it made`);
  }
  for (const [key, value] of Object.entries(seed)) assert.deepEqual(await kvOf(world).get(key), value, key);
  // Proxmox LXC keeps the warm guests it kept: one per flavour that had one.
  const lxc = world.real.get("proxmox-lxc")!;
  assert.deepEqual(["linux", "linux-desktop", "linux-desktop-cpu"].map((kind) => lxc.warm(kind)), [1, 1, 0]);

  world.real.clear();
  const again = await restart();
  for (const id of ["tart", "ssh-pool"]) {
    assert.deepEqual(await world.real.get(id)!.storage.get("ssh-key"), seed[`backend/${id}/ssh-key` as keyof typeof seed], `${id} still reads its key after a restart`);
  }
  for (const [key, value] of Object.entries(seed)) assert.deepEqual(await kvOf(world).get(key), value, key);
  assert.equal(again.configuration.document.revision, 1);
});

test("a warm count out of range moves into range and is noted, and a moved document saves as it is (review F3)", async () => {
  const { document, notes } = fromSettings({ ...SAVED, "proxmox-lxc-linux-warm": 25 }, DRIVERS, true);
  assert.deepEqual(document.backends[0]!.warm, { linux: 20, "linux-desktop": 1 });
  assert.deepEqual(notes, ["Proxmox LXC kept 25 warm linux boxes; bb-box keeps 0 to 20, so it is 20."]);
  const moved = fromSettings(SAVED, DRIVERS, false);
  const again = readDraft(exported(moved.document, moved.secrets, DRIVERS), DRIVERS);
  assert.deepEqual(again.problems, [], "the export of a moved document reads back with no problem");
  assert.deepEqual(checkDocument(again.document, withSecretChanges(moved.secrets, again.secrets, again.document), DRIVERS), []);
  const stored = { ...moved.document, backends: [{ ...moved.document.backends[0]!, warm: { linux: 25 } }] };
  assert.deepEqual(checkDocument(stored, moved.secrets, DRIVERS).map((problem) => problem.path), ["backends.proxmox-lxc.warm.linux"], "a stored document is held to the same range");
});

test("a Mac line with a mistake is left out of the move, and the copy says so (review F4)", () => {
  const { document, notes } = fromSettings(
    { "tart-enabled": true, "tart-hosts": "mac1 bbbox-admin@192.0.2.20\nmac2 192.0.2.21", "tart-host-keys": "192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMac" },
    DRIVERS,
    true,
  );
  assert.deepEqual(document.backends[0]!.hosts!.map((host) => host.name), ["mac1"]);
  assert.deepEqual(notes, ['Tart: Mac line "mac2 192.0.2.21" is not a name, a space and user@address, so the Mac was left out; add it on the settings page.']);
  // Any other mistake keeps the Mac, and the note says to fix it.
  const kept = fromSettings({ "tart-enabled": true, "tart-hosts": "mac1 bbbox-admin@192.0.2.20\nmac1 admin@192.0.2.21" }, DRIVERS, true);
  assert.deepEqual(kept.document.backends[0]!.hosts!.map((host) => host.name), ["mac1", "mac1"]);
  assert.ok(kept.notes.includes('Tart: Mac name "mac1" is listed twice. Fix it on the settings page.'));
  assert.ok(!kept.notes.some((note) => note.includes("left out")));
});

test("a backend of a type this version lacks is a problem, not a failure, and a draft that keeps it saves (review F1)", async () => {
  const { app, world, latest, restart } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const rpc = <T,>(method: string, input: unknown) => latest().behavior.callRpc(method, input) as Promise<T>;
  const stored = (await kvOf(world).get<ConfigDocument>(DOCUMENT_KEY))!;
  const later = { id: "nonesuch", type: "nonesuch", enabled: true, fields: { url: "x" }, warm: { linux: 2 } };
  await kvOf(world).set(DOCUMENT_KEY, { ...stored, backends: [...stored.backends, later] });
  await restart();
  const state = await rpc<ConfigState>("config.get", null);
  assert.deepEqual(state.problems.map((problem) => problem.path), ["backends.nonesuch"]);
  assert.equal(state.backends.find((backend) => backend.id === "nonesuch")!.state, "misconfigured");
  assert.equal(state.backends.find((backend) => backend.id === "fake")!.state, "active", "the other backends run");
  const doctor = await rpc<{ ok: boolean }>("doctor", null);
  assert.equal(doctor.ok, false);
  const tested = await rpc<CheckResult>("config.check", { draft: state.document, test: "nonesuch" });
  assert.equal(tested.doctor, null, "a test of it says why rather than fail");
  assert.deepEqual(tested.problems.map((problem) => problem.path), ["backends.nonesuch"]);

  const draft = { ...state.document, general: { boxesPerThread: 2 } };
  const applied = await rpc<ApplyResult>("config.apply", { draft, revision: state.revision });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.deepEqual(app().configuration.document.backends.at(-1), later, "it is kept as it was");
});

test("apply answers once the backends are rebuilt, and lists the problems an off backend was saved with (review F5, F6)", async () => {
  const { rpc, app } = await start({ "fake-enabled": false, "fake-token": "t0ken", "enrol-boxes": false });
  const base = app().configuration.exported();
  assert.equal((await rpc<ConfigState>("config.get", null)).backends[0]!.state, "off");
  const on = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], enabled: true }] }, revision: 1 });
  assert.ok(on.ok);
  assert.equal(on.state.backends[0]!.state, "active", "the answer has the backend as it is now");
  assert.deepEqual(on.problems, []);
  const partway = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], enabled: false, fields: { address: 5 } }] }, revision: 2 });
  assert.ok(partway.ok);
  assert.deepEqual(partway.problems.map((problem) => problem.path), ["backends.fake.address"], "a field it could not save is named");
});

test("apply tops the warm pools up at once, and a pool short of room is in the log once, the doctor and the settings (#355, #356)", async () => {
  const { rpc, app, world, latest } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const base = app().configuration.exported();
  const applied = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0]!, warm: { linux: 2 } }] }, revision: 1 });
  assert.ok(applied.ok, JSON.stringify(applied));
  assert.equal(world.backend!.warmGuests.get("linux"), 2, "the pool was topped up without waiting for the sweep");

  const logs = () => latest().inspection.logEntries.map((entry) => entry.message).filter((line) => line.includes("warm pool"));
  const signals = () => latest().inspection.realtimeSignals.length;
  const context = world.contexts.at(-1)!;
  const before = signals();
  context.warmShortfalls([{ kinds: ["linux"], count: 2, have: 1, reason: "pve has 3.5 GiB of memory free, and a warm box needs 4 GiB" }]);
  assert.ok(signals() > before, "the settings page is told");
  const shown = (await rpc<ConfigState>("config.get", null)).backends[0]!.warmShort;
  assert.deepEqual(shown, [{ kinds: ["linux"], count: 2, have: 1, reason: "pve has 3.5 GiB of memory free, and a warm box needs 4 GiB" }]);
  const doctor = await rpc<{ ok: boolean; sections: { title: string; report: DoctorReport }[] }>("doctor", null);
  assert.equal(doctor.ok, true, "a short pool is a warning");
  assert.deepEqual(doctor.sections[0]!.report.checks.at(-1), {
    id: "warm.linux",
    name: "Warm pool of linux",
    status: "warn",
    detail: "It has 1 of its 2 boxes, and no room for another: pve has 3.5 GiB of memory free, and a warm box needs 4 GiB",
    fix: "Make room there, or lower the warm count in bb-box's settings.",
  });

  // Another sweep with other figures but the same reason says nothing more.
  const quiet = signals();
  context.warmShortfalls([{ kinds: ["linux"], count: 2, have: 1, reason: "pve has 3.2 GiB of memory free, and a warm box needs 4 GiB" }]);
  assert.equal(signals(), quiet);
  context.warmShortfalls([]);
  assert.deepEqual(logs(), [
    "The warm pool of linux on fake has 1 of its 2 boxes, and no room for another: pve has 3.5 GiB of memory free, and a warm box needs 4 GiB",
    "The warm pool of linux on fake is no longer short of room.",
  ]);
  assert.deepEqual((await rpc<ConfigState>("config.get", null)).backends[0]!.warmShort, []);
});

test("every driver's fields have labels for the settings page: a capital first, and no backend name in front", () => {
  for (const driver of DRIVERS) {
    for (const [key, field] of [...Object.entries(driver.fields), ...Object.entries(driver.hostFields ?? {})]) {
      assert.match(field.label, /^(?:[A-Z]|macOS)/, `${driver.type}.${key}: "${field.label}"`);
      assert.doesNotMatch(field.label, /^[^:]+: /, `${driver.type}.${key}: "${field.label}"`);
    }
  }
  assert.equal(proxmoxLxcDriver.fields["reserve-memory-mib"]!.label, "Memory kept free (MiB)");
  assert.equal(tartDriver.fields["macos-desktop-image"]!.label, "macOS desktop image");
});

// The document and its checks.

test("a draft's problems are at their fields' paths", () => {
  const draft = readDraft(
    {
      general: { boxesPerThread: -1, defaultKind: "linux-headless" },
      kinds: {
        "linux-headless": {},
        linux: { presets: { small: { cores: 64 } }, default: "huge" },
        "linux-desktop": { enabled: false },
        "linux-docker": { spares: 11 },
        "linux-desktop-cpu": { spares: "two" },
      },
      backends: [
        { id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: { url: "", nope: 1 }, warm: { linux: 50, macos: 1 } },
        { id: "ssh-pool:lab", type: "proxmox-lxc", enabled: false },
        { id: "fake", type: "fake", enabled: true, hosts: [{ name: "a", fields: {} }, { name: "a", fields: {} }, { name: "Bad Name" }] },
      ],
    },
    [...DRIVERS, fakeDriver(tempDir("draft"))],
  );
  const paths = draft.problems.map((problem) => problem.path);
  for (const path of [
    "general.boxesPerThread",
    "kinds.linux.default",
    "kinds.linux-desktop-cpu.spares",
    "backends.proxmox-lxc.nope",
    "backends.1.id",
    "backends.fake.hosts.2.name",
  ]) {
    assert.ok(paths.includes(path), `${path} in ${paths.join(", ")}`);
  }
  const checked = checkDocument(draft.document, {}, [...DRIVERS, fakeDriver(tempDir("draft"))]).map((problem) => `${problem.path}: ${problem.message}`);
  assert.ok(checked.includes("kinds.linux-headless: linux-headless is now called linux. Use that."));
  assert.ok(checked.includes("general.defaultKind: linux-headless is now called linux. Use that."));
  assert.ok(checked.some((line) => line.startsWith("kinds.linux.presets.small: The small linux preset, 64 cores")));
  assert.ok(checked.includes("kinds.linux-docker: linux-docker is now linux with Docker, not a kind of its own. Use linux."));
  assert.ok(checked.includes("backends.proxmox-lxc.url: Set the Proxmox API URL."));
  assert.ok(checked.includes("backends.proxmox-lxc.warm.linux: Keep 0 to 20 warm linux boxes."));
  assert.ok(checked.some((line) => line.startsWith("backends.proxmox-lxc.warm.macos: Proxmox LXC makes ")));
  assert.ok(checked.includes("backends.fake.hosts.1.name: Host a is listed twice. Give each host its own name."));

  const off = checkDocument(readDraft({ general: { defaultKind: "linux-desktop" }, kinds: { "linux-desktop": { enabled: false } } }, DRIVERS).document, {}, DRIVERS);
  assert.deepEqual(off.map((problem) => problem.path), ["general.defaultKind"], "a default kind that is off is a problem");
  const unoffered = checkDocument(readDraft({ general: { defaultKind: "linux-desktop-cpu" } }, DRIVERS).document, {}, DRIVERS);
  assert.deepEqual(unoffered, [], "a kind no backend offers just now is fine");
});

test("an earlier kind ID's entries move to its kind once, unless the kind has its own (041)", () => {
  const stored = readDraft(
    {
      general: { defaultKind: "linux-docker" },
      kinds: {
        "linux-docker": { enabled: false, spares: 2, presets: { small: { cores: 4 } } },
        "linux-arm64-docker": { spares: 1 },
        "linux-arm64": { spares: 3 },
      },
      backends: [{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, warm: { linux: 1, "linux-docker": 2, "linux-desktop": 1 } }],
    },
    DRIVERS,
  ).document;
  const upgraded = upgradeDocument(stored)!;
  assert.deepEqual(upgraded.kinds, {
    "linux-arm64": { spares: 3 },
    linux: { spares: 2, presets: { small: { cores: 4 } } },
  }, "linux-docker's entry moves without turning linux off; linux-arm64 keeps its own");
  assert.deepEqual(upgraded.general, { defaultKind: "linux" });
  assert.deepEqual(upgraded.backends[0]!.warm, { linux: 3, "linux-desktop": 1 }, "a warm count adds to its kind's, as they were the same guests");
  assert.equal(upgradeDocument(upgraded), null, "once");
  assert.equal(upgradeDocument(readDraft({ kinds: { linux: { spares: 1 } } }, DRIVERS).document), null, "nothing to move, nothing written");
  assert.deepEqual(checkDocument(upgraded, {}, DRIVERS).filter((problem) => !problem.path.startsWith("backends.")), []);
});

test("a start moves a stored document's earlier kind IDs once, as a write would (041)", async () => {
  const { world, restart } = await start(SAVED);
  const kv = kvOf(world);
  const document = (await kv.get<ConfigDocument>(DOCUMENT_KEY))!;
  await kv.set(DOCUMENT_KEY, { ...document, kinds: { "linux-docker": { spares: 1 } } });
  const app = await restart();
  const moved = (await kvOf(world).get<ConfigDocument>(DOCUMENT_KEY))!;
  assert.deepEqual(moved.kinds, { linux: { spares: 1 } });
  assert.equal(moved.revision, document.revision + 1);
  assert.deepEqual(app.configuration.document, moved);
  await restart();
  assert.deepEqual(await kvOf(world).get(DOCUMENT_KEY), moved, "the next start changes nothing");
});

test("only a kind that is on keeps spare boxes (032)", () => {
  const { document, problems } = readDraft({ kinds: { linux: { spares: 2 }, "linux-desktop-cpu": { spares: 0 }, "linux-desktop": { enabled: false, spares: 1 } } }, DRIVERS);
  assert.deepEqual(problems, []);
  assert.deepEqual(generalConfig(document).spares, { linux: 2 });
  assert.deepEqual(generalConfig(readDraft({}, DRIVERS).document).spares, {}, "none by default");
});

test("a secret in a draft is kept, replaced or cleared, and never leaves bb-box", () => {
  const stored: Secrets = { "proxmox-lxc": { "token-secret": "old", "ssh-private-key": KEY } };
  const draft = readDraft(
    { backends: [{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { "token-secret": "new", "ssh-private-key": null } }] },
    DRIVERS,
  );
  assert.deepEqual(withSecretChanges(stored, draft.secrets, draft.document), { "proxmox-lxc": { "token-secret": "new" } });
  const kept = readDraft({ backends: [{ id: "proxmox-lxc", type: "proxmox-lxc", fields: { "token-secret": { set: true } } }] }, DRIVERS);
  assert.deepEqual(withSecretChanges(stored, kept.secrets, kept.document), stored);
  assert.deepEqual(kept.document.backends[0]!.fields, {}, "the document holds no secret");
  const shown = exported(draft.document, stored, DRIVERS);
  assert.deepEqual(shown.backends[0]!.fields["token-secret"], { set: true });
  assert.ok(!JSON.stringify(shown).includes("old") && !JSON.stringify(shown).includes(KEY));
  const removed = readDraft({ backends: [] }, DRIVERS);
  assert.deepEqual(withSecretChanges(stored, removed.secrets, removed.document), {}, "a removed backend's secrets go with it");
});

test("a checked backend's storage is the backend's own for a new key, and a layer for everything else", async () => {
  const storage = new MemoryStorage();
  await storage.set("record", "live");
  const layer = layeredStorage(storage);
  await layer.set("ssh-key", "made by the check");
  await layer.set("record", "the check's");
  await layer.delete("record");
  assert.equal(await storage.get("ssh-key"), "made by the check", "a key the backend did not have yet is kept");
  assert.equal(await storage.get("record"), "live", "the live record is untouched");
  assert.equal(await layer.get("record"), undefined);
  assert.deepEqual(await layer.list(), ["ssh-key"]);
});

test("a doctor that takes too long is cut off at its time limit", async () => {
  const report = await boundedDoctor((signal) => new Promise<DoctorReport>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))), 20);
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.detail, /longer than 0 s/);
  const ignoring = await boundedDoctor(() => new Promise<DoctorReport>(() => {}), 20);
  assert.equal(ignoring.ok, false, "a doctor that ignores the abort is not waited for");
});

// The RPC.

test("config.get gives the document with each secret as set or not, the defaults, the kinds and each backend's state", async () => {
  const { rpc } = await start({ "fake-enabled": true, "fake-token": "t0ken", "enrol-boxes": false });
  const state = await rpc<ConfigState>("config.get", null);
  assert.equal(state.revision, 1);
  assert.deepEqual(state.document.backends, [{ id: "fake", type: "fake", enabled: true, fields: { token: { set: true } } }]);
  assert.ok(!JSON.stringify(state).includes("t0ken"));
  assert.deepEqual(state.defaults.general, { boxesPerThread: 0, enrol: true, defaultKind: "linux" });
  assert.deepEqual(state.defaults.kinds.linux!.presets.small, { cores: 2, memoryMiB: 4096, diskGiB: null });
  assert.deepEqual(state.kinds.find((kind) => kind.id === "linux-desktop"), {
    id: "linux-desktop",
    label: "Linux desktop",
    description: "A Linux desktop on a GPU, for computer use, browsers and app development.",
    gpu: true,
    desktop: true,
    os: "linux",
    arch: "x86_64",
    windowing: "x11",
    features: [],
    docker: false,
    drivers: ["fake", "proxmox-lxc"],
    spares: { ready: 0, making: 0 },
  });
  assert.deepEqual(state.drivers[0]!.fields.map((field) => [field.key, field.group]), [["address", "connection"], ["token", "credentials"]]);
  assert.deepEqual(state.backends, [{ id: "fake", type: "fake", label: "Fake host", form: "VM", state: "active", problems: [], boxes: 0, kinds: ["linux", "linux-desktop"], doctor: null, warmShort: [] }]);
  assert.deepEqual(state.problems, []);
  assert.ok(state.migrated);
});

test("config.check finds problems without saving, and with test runs the backend's doctor against the draft", async () => {
  const { rpc, app, world } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const draft = { backends: [{ id: "fake", type: "fake", enabled: true, fields: { address: "broken" } }] };
  const broken = await rpc<CheckResult>("config.check", { draft, test: "fake" });
  assert.deepEqual(broken.problems, [{ path: "backends.fake.address", message: "Fill in the fake host's address." }]);
  assert.equal(broken.doctor, null, "a backend whose fields are not valid is not built");
  assert.equal(app().configuration.document.revision, 1, "nothing was saved");

  const live = world.backend;
  const tested = await rpc<CheckResult>("config.check", { draft: { backends: [{ id: "fake", type: "fake", enabled: true, fields: { address: "there" } }] }, test: "fake" });
  assert.deepEqual(tested.problems, []);
  assert.equal(tested.doctor?.ok, true);
  assert.notEqual(world.backend, live, "the check built a backend of its own");
  assert.equal(app().backends.get("fake"), live, "and left the live one alone");
  assert.equal((await rpc<ConfigState>("config.get", null)).backends[0]!.doctor, null, "a draft that differs is not the backend's own report");

  await rpc<CheckResult>("config.check", { draft: app().configuration.exported(), test: "fake" });
  assert.equal((await rpc<ConfigState>("config.get", null)).backends[0]!.doctor?.report.ok, true, "the saved backend's own check is kept as its last report");
});

/** A driver whose address and token, left empty, take the fake host's, as Proxmox QEMU's take Proxmox LXC's. */
function heirDriver(root: string): BackendDriver<{ address: string }> {
  return {
    type: "heir",
    label: "Heir",
    description: "Guests on the fake host's machine.",
    nature: "virtual",
    form: "VM",
    kinds: [],
    fields: {
      address: { type: "string", label: "Address", group: "connection", default: "" },
      token: { type: "string", label: "Token", group: "credentials", secret: true },
    },
    inherits: { from: "fake", sets: [["address", "token"]] },
    setup: { guide: "setup/fake/README.md", scripts: [] },
    parse(part) {
      if (!part.fields.address || !part.fields.token) return { ok: false, problems: [{ path: "address", message: "Set the address and token, or the fake host's." }] };
      return { ok: true, config: { address: String(part.fields.address) } };
    },
    create: (_config, context) => new FakeBackend({ root, id: context.id, storage: context.storage, installId: context.installId, warm: context.warm }),
  };
}

test("config.check fills a backend's empty fields from the draft's backend it inherits from, and keeps the saved one's report", async () => {
  const { rpc, app } = await start({ "fake-enabled": true, "fake-token": "t0ken", "enrol-boxes": false }, { drivers: [heirDriver(tempDir("heir"))] });
  const fake = { id: "fake", type: "fake", enabled: true, fields: { address: "there", token: { set: true } } };
  const heir = { id: "heir", type: "heir", enabled: false, fields: {} };
  const alone = await rpc<CheckResult>("config.check", { draft: { backends: [{ ...fake, fields: { address: "there", token: null } }, heir] }, test: "heir" });
  assert.deepEqual(alone.problems.map((problem) => problem.path), ["backends.heir.address"], "the draft clears the fake host's token, so none comes");
  assert.equal(alone.doctor, null);

  const tested = await rpc<CheckResult>("config.check", { draft: { backends: [fake, heir] }, test: "heir" });
  assert.deepEqual(tested.problems, []);
  assert.equal(tested.doctor?.ok, true, "the check took the fake host's address and its stored token");

  const saved = await rpc<ApplyResult>("config.apply", { draft: { ...app().configuration.exported(), backends: [fake, heir] }, revision: 1 });
  assert.ok(saved.ok, JSON.stringify(saved));
  await rpc<CheckResult>("config.check", { draft: app().configuration.exported(), test: "heir" });
  const state = await rpc<ConfigState>("config.get", null);
  assert.equal(state.backends.find((backend) => backend.id === "heir")!.doctor?.report.ok, true, "the saved backend's own check is kept as its last report");
});

test("config.apply saves a checked draft whole, and refuses an old revision, problems where they matter, and removing a backend with boxes", async () => {
  const { rpc, app, world } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const base = app().configuration.exported();

  const stale = await rpc<ApplyResult>("config.apply", { draft: base, revision: 0 });
  assert.ok(!stale.ok && stale.reason === "revision" && stale.state.revision === 1);

  const wrong = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], fields: { address: "broken" } }] }, revision: 1 });
  assert.ok(!wrong.ok && wrong.reason === "problems");
  assert.deepEqual(wrong.problems.map((problem) => problem.path), ["backends.fake.address"], "a backend that is on cannot be saved with problems");

  // An off backend without boxes saves part way through its setup.
  const partway = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], enabled: false, fields: { address: "broken" } }] }, revision: 1 });
  assert.ok(partway.ok, JSON.stringify(partway));
  assert.equal(partway.state.revision, 2);
  assert.equal((await rpc<ConfigState>("config.get", null)).backends[0]!.state, "off");

  const fixed = await rpc<ApplyResult>("config.apply", { draft: { ...base, general: { boxesPerThread: 2 } }, revision: 2 });
  assert.ok(fixed.ok);
  await app().boxes.settled(await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));

  const removed = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [] }, revision: 3 });
  assert.ok(!removed.ok && removed.reason === "problems");
  assert.match(removed.problems[0]!.message, /^Backend fake has 1 box, so it cannot be removed or renamed\. Turn it off and release them first\./);
  const renamed = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], id: "fake:other" }] }, revision: 3 });
  assert.ok(!renamed.ok && renamed.reason === "problems");

  // Two writes from one revision: one is saved, the other told the revision moved on.
  const [first, second] = await Promise.all([
    rpc<ApplyResult>("config.apply", { draft: base, revision: 3 }),
    rpc<ApplyResult>("config.apply", { draft: base, revision: 3 }),
  ]);
  assert.deepEqual([first.ok, second.ok].sort(), [false, true]);
  assert.ok(world.backend);
});

test("switches stop new boxes only: an off backend or kind keeps its boxes working and is not built again", async () => {
  const { rpc, app } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const box = await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await app().boxes.settled(box);
  const backend = app().backends.get("fake");
  const base = app().configuration.exported();

  const kindOff = await rpc<ApplyResult>("config.apply", { draft: { ...base, kinds: { "linux-desktop": { enabled: false } } }, revision: 1 });
  assert.ok(kindOff.ok);
  await app().configuration.state();
  assert.deepEqual((await app().kinds()).map((kind) => kind.id), ["linux"], "an off kind is not offered");

  const off = await rpc<ApplyResult>("config.apply", { draft: { ...base, backends: [{ ...base.backends[0], enabled: false }] }, revision: 2 });
  assert.ok(off.ok);
  const state = await app().configuration.state();
  assert.equal(state.backends[0]!.state, "off");
  assert.deepEqual(state.backends[0]!.kinds, []);
  assert.equal(app().backends.get("fake"), backend, "the backend was kept, not built again");
  assert.deepEqual(await app().kinds(), [], "no kind is offered from an off backend");
  assert.equal((await app().boxes.run(THREAD, box.name, "echo on an off backend")).result.stdout.trim(), "on an off backend");
  await assert.rejects(app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }), /No backend is set up/);
  assert.equal(await app().boxes.release(THREAD, box.name, "the test asked"), null, "a box of an off backend can be released");
});

test("the sweep retires the warm guests of a backend turned off, and leaves its boxes alone (#85)", async () => {
  const { rpc, app, world } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const base = app().configuration.exported();
  const warm = { ...base, backends: [{ ...base.backends[0], warm: { linux: 2 } }] };
  assert.ok((await rpc<ApplyResult>("config.apply", { draft: warm, revision: 1 })).ok);
  const backend = world.backend!;
  await app().boxes.sweep();
  assert.deepEqual([...backend.warmGuests], [["linux", 2]]);
  const box = await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await app().boxes.settled(box);

  const off = { ...warm, backends: [{ ...warm.backends[0], enabled: false }] };
  assert.ok((await rpc<ApplyResult>("config.apply", { draft: off, revision: 2 })).ok);
  await app().boxes.sweep();
  assert.equal(world.backend, backend, "the off backend is the same one, still built");
  assert.deepEqual([...backend.warmGuests], [], "its warm guests are retired");
  assert.equal((await app().boxes.run(THREAD, box.name, "echo kept")).result.stdout.trim(), "kept", "its box still works");
  assert.equal((await app().boxes.list(THREAD)).length, 1);
});

test("a backend reads its warm counts, kinds and hosts live from the configuration", async () => {
  const { rpc, app, world } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const context = world.contexts.at(-1)!;
  const base = app().configuration.exported();
  assert.equal(context.warm("linux"), 0);
  const draft = {
    ...base,
    kinds: { linux: { presets: { small: { cores: 3 } } } },
    backends: [{ ...base.backends[0], warm: { linux: 2 }, hosts: [{ name: "fake", enabled: false, fields: { address: "192.0.2.5" } }] }],
  };
  assert.ok((await rpc<ApplyResult>("config.apply", { draft, revision: 1 })).ok);
  await app().configuration.state();
  assert.equal(world.contexts.at(-1), context, "the backend was not built again");
  assert.equal(context.warm("linux"), 2);
  assert.equal(context.hostOn("fake"), false);
  assert.deepEqual(context.kind("linux"), {
    enabled: true,
    defaultSize: { cores: 3, memoryMiB: 4096, diskGiB: null },
    presets: [
      { cores: 3, memoryMiB: 4096, diskGiB: null },
      { cores: 4, memoryMiB: 8192, diskGiB: null },
      { cores: 8, memoryMiB: 16384, diskGiB: null },
    ],
  });
  assert.ok((await rpc<ApplyResult>("config.apply", { draft: { ...draft, kinds: { ...draft.kinds, linux: { enabled: false } } }, revision: 2 })).ok);
  await app().configuration.state();
  assert.equal(context.warm("linux"), 0, "an off kind keeps no warm guests");
  assert.equal(context.kind("linux").enabled, false);
});

test("a host with boxes cannot be removed or renamed", async () => {
  const { rpc, app } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const base = app().configuration.exported();
  const withHost = { ...base, backends: [{ ...base.backends[0], hosts: [{ name: "fake", enabled: true, fields: {} }] }] };
  assert.ok((await rpc<ApplyResult>("config.apply", { draft: withHost, revision: 1 })).ok);
  await app().boxes.settled(await app().boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const removed = await rpc<ApplyResult>("config.apply", { draft: { ...withHost, backends: [{ ...withHost.backends[0], hosts: [] }] }, revision: 2 });
  assert.ok(!removed.ok && removed.reason === "problems");
  assert.deepEqual(removed.problems, [{ path: "backends.fake.hosts", message: "Host fake has 1 box, so it cannot be removed or renamed. Turn it off and release them first." }]);
  const off = await rpc<ApplyResult>("config.apply", { draft: { ...withHost, backends: [{ ...withHost.backends[0], hosts: [{ name: "fake", enabled: false, fields: {} }] }] }, revision: 2 });
  assert.ok(off.ok, "turning it off is fine");
});

// The CLI.

test("bb box config show prints the configuration, and --json the export, with no secret in either", async () => {
  const { harness } = await start({ "fake-enabled": true, "fake-token": "t0ken", "enrol-boxes": false, "boxes-per-thread": 3 });
  const shown = await harness.behavior.runCli(["config", "show"]);
  assert.equal(shown.exitCode, 0, shown.stderr);
  assert.match(shown.stdout ?? "", /^bb-box's configuration, revision 1\./);
  assert.match(shown.stdout ?? "", /- fake \(Fake host\): on, ready, offers linux, linux-desktop\.\n {4}token: set/);
  assert.match(shown.stdout ?? "", /Boxes per thread: 3\. Enrol boxes as BB machines: no\. Default kind: linux\./);
  assert.match(shown.stdout ?? "", /bb-box keeps a copy of the BB settings it moved .* bb box config migrated shows it, and --remove removes it\./);
  const json = await harness.behavior.runCli(["config", "show", "--json"]);
  const exportedDocument = JSON.parse(json.stdout ?? "") as ConfigDocument;
  assert.deepEqual(exportedDocument.backends[0]!.fields, { token: { set: true } });
  assert.ok(!(json.stdout ?? "").includes("t0ken") && !(shown.stdout ?? "").includes("t0ken"));
});

test("bb box config check and apply read a file from where bb runs, and migrated shows and removes the copy", async () => {
  const { harness, app } = await start({ "fake-enabled": true, "enrol-boxes": false });
  const dir = tempDir("config-cli");
  const document = app().configuration.exported();
  writeFileSync(join(dir, "wrong.json"), JSON.stringify({ ...document, backends: [{ ...document.backends[0], fields: { address: "broken" } }] }));
  writeFileSync(join(dir, "right.json"), JSON.stringify({ ...document, general: { boxesPerThread: 4 }, revision: undefined }));
  writeFileSync(join(dir, "stale.json"), JSON.stringify({ ...document, revision: 0 }));

  const wrong = await harness.behavior.runCli(["config", "check", "wrong.json"], { cwd: dir });
  assert.equal(wrong.exitCode, 1);
  assert.match(wrong.stdout ?? "", /backends\.fake\.address: Fill in the fake host's address\./);
  const tested = await harness.behavior.runCli(["config", "check", "right.json", "--test"], { cwd: dir });
  assert.equal(tested.exitCode, 0, tested.stdout);
  assert.match(tested.stdout ?? "", /^No problems\.\nfake: Fake host 1\.0|^No problems\.\nfake: /);
  const refused = await harness.behavior.runCli(["config", "apply", "wrong.json"], { cwd: dir });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", /^Nothing was saved\. Fix these first:\n {2}backends\.fake\.address/);
  const stale = await harness.behavior.runCli(["config", "apply", join(dir, "stale.json")]);
  assert.match(stale.stderr ?? "", /it is at revision 1\. .* remove its revision or use --replace\./);
  const applied = await harness.behavior.runCli(["config", "apply", "right.json"], { cwd: dir });
  assert.equal(applied.exitCode, 0, applied.stderr);
  assert.match(applied.stdout ?? "", /^Saved revision 2\./);
  assert.equal(app().configuration.general().perThreadLimit, 4);
  // An export from another install, or from before a reinstall, names a revision of its own (review F2).
  writeFileSync(join(dir, "export.json"), JSON.stringify({ ...document, revision: 9, general: { boxesPerThread: 5 } }));
  const replaced = await harness.behavior.runCli(["config", "apply", "export.json", "--replace"], { cwd: dir });
  assert.equal(replaced.exitCode, 0, replaced.stderr);
  assert.match(replaced.stdout ?? "", /^Saved revision 3\./);
  assert.equal(app().configuration.general().perThreadLimit, 5);

  const migrated = await harness.behavior.runCli(["config", "migrated"]);
  assert.match(migrated.stdout ?? "", /^bb-box 0\.2\.0 moved these BB settings into its configuration on /);
  assert.match(migrated.stdout ?? "", /\nfake-enabled: true\n/);
  assert.match((await harness.behavior.runCli(["config", "migrated", "--remove"])).stdout ?? "", /Removed the copy/);
  assert.match((await harness.behavior.runCli(["config", "migrated"])).stdout ?? "", /There is no copy/);
  assert.doesNotMatch((await harness.behavior.runCli(["config", "show"])).stdout ?? "", /keeps a copy/);
});

test("a field a backend does not have names the backend, and the key it has now when it is its old name in BB's settings", () => {
  const { problems } = readDraft(
    {
      schema: 1,
      backends: [
        { id: "tart", type: "tart", enabled: true, fields: { "tart-linux-image": "ghcr.io/example/linux:1" }, hosts: [{ name: "mac1", fields: { address: "192.0.2.20", "tart-user": "admin" } }] },
        { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { "proxmox-lxc-vmid-first": 3000 } },
      ],
      kinds: {},
      general: {},
    },
    DRIVERS,
  );
  assert.deepEqual(
    problems.map((problem) => `${problem.path}: ${problem.message}`),
    [
      `backends.tart.tart-linux-image: Backend tart has no field "tart-linux-image". That was its name in BB's settings; here it is "linux-image".`,
      `backends.tart.hosts.0.tart-user: Host mac1 of backend tart has no field "tart-user". The fields are address, user, host-keys.`,
      `backends.proxmox-lxc.proxmox-lxc-vmid-first: Backend proxmox-lxc has no field "proxmox-lxc-vmid-first". That was its name in BB's settings; here it is "vmid-first".`,
    ],
  );
});

test("the configuration takes several Docker backends, one per host, and still one of any other type (042)", () => {
  const docker = (id: string, host?: string) => ({ id, type: "docker", enabled: true, fields: host === undefined ? {} : { host } });
  const problems = (backends: unknown[]) =>
    checkDocument(readDraft({ schema: 1, backends, kinds: {}, general: {} }, DRIVERS).document, {}, DRIVERS).filter((problem) => /both Docker|one .* backend for now/.test(problem.message));
  assert.deepEqual(problems([docker("docker"), docker("docker:devpc", "bb:host_m1"), docker("docker:lab", "ssh://me@lab")]), []);
  assert.deepEqual(problems([docker("docker:one", "bb:host_m1"), docker("docker:two", "bb:host_m1")]).map((problem) => `${problem.path}: ${problem.message}`), [
    "backends.docker:two: docker:two and docker:one are both Docker on bb:host_m1. Give each its own host, or remove one.",
  ]);
  assert.match(problems([docker("docker"), docker("docker:local", "")])[0]?.message ?? "", /both Docker on the default host/);
  const lxc = { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: {} };
  assert.match(problems([lxc, { ...lxc, id: "proxmox-lxc:two" }])[0]?.message ?? "", /bb-box runs one Proxmox LXC backend for now/);
});
