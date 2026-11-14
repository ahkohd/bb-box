import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mock, test } from "node:test";
import type { BbPluginApi, PluginSettingValue } from "@get-bb/plugin-sdk";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { DRIVERS } from "../src/backends/index.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import type { BackendDriver } from "../src/backends/types.ts";
import { draftFields } from "../src/app/config.ts";
import { withoutSecretVersions, type ConfigDocument, type SecretState } from "../src/core/document.ts";
import { INSTALL_ID_KEY } from "../src/core/install.ts";
import { DOCUMENT_KEY, SECRETS_KEY } from "../src/core/move.ts";
import { RECEIPTS_KEPT_AT_LEAST, RECEIPTS_KEPT_MS, SAVED_KEY, keptReceipts, type SavedRecord, type StoredReceipt } from "../src/core/saves.ts";
import { driverFields, type ApplyResult, type CheckResult, type ConfigState } from "../src/plugin/configuration.ts";
import { DROPPED_REPLY_MESSAGE, ReplyDrops, liveChecksOn } from "../src/plugin/live-checks.ts";
import { setup, type BbBox } from "../src/plugin/setup.ts";
import { fakeDriver } from "./fake-backend.ts";
import { tempDir } from "./helpers.ts";

const THREAD = "thr_saves";
const TOKEN = "made-up-token-0001";

interface Started {
  readonly app: () => BbBox;
  readonly rpc: <T>(method: string, input: unknown) => Promise<T>;
  readonly cli: (args: string[]) => Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
  readonly kv: () => BbPluginApi["storage"]["kv"];
  readonly failWrites: Set<string>;
  readonly restart: () => Promise<BbBox>;
}

const disposals: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose().catch(() => {});
});

function withFailingWrites(bb: BbPluginApi, failWrites: ReadonlySet<string>): BbPluginApi {
  const kv = bb.storage.kv;
  const storage = {
    ...bb.storage,
    kv: {
      get: <T,>(key: string) => kv.get<T>(key),
      list: (prefix?: string) => kv.list(prefix),
      delete: (key: string) => kv.delete(key),
      async set(key: string, value: unknown) {
        if (failWrites.has(key)) throw new Error(`the write of ${key} failed`);
        await kv.set(key, value);
      },
    },
  };
  return Object.create(bb, { storage: { value: storage } }) as BbPluginApi;
}

async function start(settings: Record<string, PluginSettingValue>, options: { liveChecks?: boolean; drivers?: BackendDriver<any>[] } = {}): Promise<Started> {
  const root = tempDir("saves");
  const threads = new Map([[THREAD, makeThreadResponse({ id: THREAD, projectId: "prj_saves", environmentId: "env_saves" })]]);
  const { bb, harness } = createFakePluginHost({
    pluginId: "bb-box",
    settings,
    sdk: {
      threads: { get: async ({ threadId }: { threadId: string }) => threads.get(threadId)! },
      system: { machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, variables: [] }) },
      projects: { machineEnvironment: async () => ({ builtInGit: { status: "logged in", statusMessage: "" }, inheritedVariables: [], variables: [] }) },
    } as never,
  });
  await bb.storage.kv.set(INSTALL_ID_KEY, "earlier01");
  const failWrites = new Set<string>();
  const drivers = [fakeDriver(root), ...(options.drivers ?? [])];
  const begin = (on: BbPluginApi) => setup(withFailingWrites(on, failWrites), { drivers, daemonParent: join(root, "no-daemon"), ...(options.liveChecks === undefined ? {} : { liveChecks: options.liveChecks }) });
  let app = await begin(bb);
  let current = harness;
  let kv = bb.storage.kv;
  disposals.push(() => current.lifecycle.dispose());
  return {
    app: () => app,
    rpc: <T,>(method: string, input: unknown) => current.behavior.callRpc(method as never, input as never) as Promise<T>,
    cli: (args) => current.behavior.runCli(args),
    kv: () => kv,
    failWrites,
    restart: async () => {
      const replacement = await current.lifecycle.reload(async (fresh) => {
        kv = fresh.storage.kv;
        app = await begin(fresh);
      });
      current = replacement.harness;
      return app;
    },
  };
}

const ON = { "fake-enabled": true, "fake-token": TOKEN, "enrol-boxes": false };

function tokenState(state: ConfigState): SecretState {
  return state.document.backends.find((backend) => backend.id === "fake")!.fields.token as SecretState;
}

function withBoxesPerThread(document: ConfigDocument, boxesPerThread: number): ConfigDocument {
  return { ...document, general: { ...document.general, boxesPerThread } };
}

test("an apply with an operation ID stores its receipt in the same write as the document, and config.get lists it without the submission's hash", async () => {
  const { rpc, kv, app } = await start(ON);
  const before = await rpc<ConfigState>("config.get", null);
  const saved = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 2), revision: before.revision, operation: "op-1", submission: { "general/boxesPerThread": 2 } });
  assert.ok(saved.ok && saved.receipt, JSON.stringify(saved));
  assert.equal(saved.receipt.operation, "op-1");
  assert.equal(saved.receipt.revision, before.revision + 1);
  assert.equal(saved.replayed, undefined);

  const record = (await kv().get<SavedRecord>(SAVED_KEY))!;
  assert.equal(record.document.revision, before.revision + 1);
  assert.deepEqual(record.ledger.receipts.map((receipt) => [receipt.operation, receipt.revision]), [["op-1", before.revision + 1]]);
  assert.match(record.ledger.receipts[0]!.submission, /^[0-9a-f]{64}$/);
  assert.deepEqual(await kv().get(DOCUMENT_KEY), record.document, "today's document key is a copy, for an earlier bb-box");

  const state = await rpc<ConfigState>("config.get", null);
  assert.deepEqual(state.receipts, [saved.receipt]);
  assert.deepEqual(Object.keys(state.receipts[0]!).sort(), ["at", "operation", "revision"]);
  assert.equal(app().configuration.general().perThreadLimit, 2);
});

test("a save whose write fails stores neither the document nor its receipt, and a start after it has neither", async () => {
  const started = await start(ON);
  const before = await started.rpc<ConfigState>("config.get", null);
  started.failWrites.add(SAVED_KEY);
  await assert.rejects(started.rpc("config.apply", { draft: withBoxesPerThread(before.document, 3), revision: before.revision, operation: "op-lost" }));
  started.failWrites.clear();
  const after = await started.rpc<ConfigState>("config.get", null);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.receipts, []);
  await started.restart();
  const restarted = await started.rpc<ConfigState>("config.get", null);
  assert.deepEqual(restarted.receipts, []);
  assert.equal(restarted.document.general.boxesPerThread, before.document.general.boxesPerThread);

  const retried = await started.rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(restarted.document, 3), revision: restarted.revision, operation: "op-lost" });
  assert.ok(retried.ok && retried.receipt && !retried.replayed, "with no receipt, the same operation is applied when sent again");
});

test("the same operation sent twice at once is applied once, and both answers carry its one receipt", async () => {
  const { rpc } = await start(ON);
  const before = await rpc<ConfigState>("config.get", null);
  const request = { draft: withBoxesPerThread(before.document, 4), revision: before.revision, operation: "op-twice", submission: { "general/boxesPerThread": 4 } };
  const [first, second] = await Promise.all([rpc<ApplyResult>("config.apply", request), rpc<ApplyResult>("config.apply", request)]);
  assert.ok(first.ok && second.ok, JSON.stringify([first, second]));
  assert.deepEqual(first.receipt, second.receipt);
  assert.deepEqual([first.replayed, second.replayed].sort(), [true, undefined].sort());
  const after = await rpc<ConfigState>("config.get", null);
  assert.equal(after.revision, before.revision + 1, "one save, one revision");
  assert.equal(after.receipts.length, 1);
});

test("an operation sent again after its save, rebased on a newer revision, gets the first receipt and changes nothing", async () => {
  const { rpc } = await start(ON);
  const before = await rpc<ConfigState>("config.get", null);
  const submission = { "general/boxesPerThread": 5 };
  const first = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 5), revision: before.revision, operation: "op-rebased", submission });
  assert.ok(first.ok);
  const other = await rpc<ApplyResult>("config.apply", { draft: { ...first.state.document, general: { ...first.state.document.general, enrol: true } }, revision: first.state.revision });
  assert.ok(other.ok && other.receipt === undefined, "a save without an operation ID has no receipt");

  const again = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(other.state.document, 5), revision: before.revision, operation: "op-rebased", submission });
  assert.ok(again.ok && again.replayed, JSON.stringify(again));
  assert.deepEqual(again.receipt, first.receipt);
  assert.equal(again.state.revision, other.state.revision, "the old revision it names is not refused, and nothing is saved");
});

test("the same operation ID with another submission is refused, and saves nothing", async () => {
  const { rpc } = await start(ON);
  const before = await rpc<ConfigState>("config.get", null);
  const first = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 6), revision: before.revision, operation: "op-once", submission: { "general/boxesPerThread": 6 } });
  assert.ok(first.ok);
  const other = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(first.state.document, 7), revision: first.state.revision, operation: "op-once", submission: { "general/boxesPerThread": 7 } });
  assert.ok(!other.ok && other.reason === "problems", JSON.stringify(other));
  assert.deepEqual(other.problems.map((problem) => problem.path), ["operation"]);
  assert.match(other.problems[0]!.message, /^Operation op-once was saved at revision \d+ with other changes, so these were not saved\./);
  const after = await rpc<ConfigState>("config.get", null);
  assert.equal(after.revision, first.state.revision);
  assert.equal(after.document.general.boxesPerThread, 6);

  const withoutSubmission = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(after.document, 8), revision: after.revision, operation: "op-draft" });
  assert.ok(withoutSubmission.ok);
  const changedDraft = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(withoutSubmission.state.document, 9), revision: withoutSubmission.state.revision, operation: "op-draft" });
  assert.ok(!changedDraft.ok, "without a submission, the draft is the submission");
});

test("receipts are kept for 24 hours and at least the last 100, and one aged out is no longer listed", async () => {
  const t0 = Date.parse("2026-10-29T09:00:00Z");
  mock.timers.enable({ apis: ["Date"], now: t0 });
  try {
    const { rpc } = await start(ON);
    let state = await rpc<ConfigState>("config.get", null);
    for (let n = 1; n <= RECEIPTS_KEPT_AT_LEAST + 5; n += 1) {
      const saved = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(state.document, n), revision: state.revision, operation: `op-${n}` });
      assert.ok(saved.ok);
      state = saved.state;
    }
    assert.equal(state.receipts.length, RECEIPTS_KEPT_AT_LEAST + 5, "all of the last 24 hours are kept, over 100");

    mock.timers.setTime(t0 + RECEIPTS_KEPT_MS + 60_000);
    const late = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(state.document, 1), revision: state.revision, operation: "op-late" });
    assert.ok(late.ok);
    const kept = (await rpc<ConfigState>("config.get", null)).receipts.map((receipt) => receipt.operation);
    assert.equal(kept.length, RECEIPTS_KEPT_AT_LEAST);
    assert.ok(!kept.includes("op-1") && !kept.includes("op-6"), "the oldest, over 24 hours old, aged out");
    assert.equal(kept.at(-1), "op-late");
  } finally {
    mock.timers.reset();
  }
});

test("keptReceipts keeps the last 100 whatever their age, and any of the last 24 hours, at most 500", () => {
  const now = 10 * RECEIPTS_KEPT_MS;
  const receipt = (n: number, at: number): StoredReceipt => ({ operation: `op-${n}`, revision: n, at, submission: "x" });
  const old = Array.from({ length: 150 }, (_, n) => receipt(n, 0));
  assert.deepEqual(keptReceipts(old, now).map((each) => each.revision), Array.from({ length: 100 }, (_, n) => n + 50));
  const fresh = Array.from({ length: 600 }, (_, n) => receipt(n, now - 1000));
  assert.equal(keptReceipts(fresh, now).length, 500);
});

test("a secret's version is the revision that last set or cleared it: replaced and cleared, it moves, and a value set again gets a new one", async () => {
  const { rpc, cli } = await start(ON);
  const first = await rpc<ConfigState>("config.get", null);
  const initial = tokenState(first);
  assert.equal(initial.set, true);
  assert.equal(typeof initial.version, "number");
  assert.ok(!JSON.stringify(first).includes(TOKEN));

  const untouched = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(first.document, 2), revision: first.revision });
  assert.ok(untouched.ok);
  assert.deepEqual(tokenState(untouched.state), initial, "a draft that sends the secret's state back keeps it and its version");

  const draftWithToken = (document: ConfigDocument, token: unknown) => ({ ...document, backends: document.backends.map((backend) => (backend.id === "fake" ? { ...backend, fields: { ...backend.fields, token } } : backend)) });
  const replaced = await rpc<ApplyResult>("config.apply", { draft: draftWithToken(untouched.state.document, "made-up-token-0002"), revision: untouched.state.revision });
  assert.ok(replaced.ok);
  assert.deepEqual(tokenState(replaced.state), { set: true, version: replaced.state.revision });

  const cleared = await rpc<ApplyResult>("config.apply", { draft: draftWithToken(replaced.state.document, null), revision: replaced.state.revision });
  assert.ok(cleared.ok, JSON.stringify(cleared));
  assert.deepEqual(tokenState(cleared.state), { set: false, version: cleared.state.revision });

  const back = await rpc<ApplyResult>("config.apply", { draft: draftWithToken(cleared.state.document, TOKEN), revision: cleared.state.revision });
  assert.ok(back.ok);
  const versions = [initial.version, tokenState(replaced.state).version, tokenState(cleared.state).version, tokenState(back.state).version];
  assert.equal(new Set(versions).size, 4, `the same value set again is a new version: ${versions.join(", ")}`);

  const shown = await cli(["config", "show", "--json"]);
  assert.deepEqual((JSON.parse(shown.stdout ?? "") as ConfigDocument).backends[0]!.fields.token, { set: true }, "bb box config show --json is as it was");
  assert.ok(!(shown.stdout ?? "").includes("version"));
  assert.ok(!JSON.stringify(back).includes(TOKEN));
});

test("a file's content and the tailnet's credentials carry versions too, and an export drops them", async () => {
  const { rpc } = await start(ON);
  const state = await rpc<ConfigState>("config.get", null);
  const withFile = { ...state.document, general: { ...state.document.general, files: [{ path: ".config/tool/a.json", content: "{\"made\":\"up\"}" }], tailnet: { mode: "oauth", clientId: "made-up-id", clientSecret: "made-up-secret" } } };
  const saved = await rpc<ApplyResult>("config.apply", { draft: withFile, revision: state.revision });
  assert.ok(saved.ok, JSON.stringify(saved));
  const general = saved.state.document.general;
  assert.deepEqual(general.files, [{ path: ".config/tool/a.json", content: { set: true, version: saved.state.revision } }]);
  assert.deepEqual(general.tailnet?.clientSecret, { set: true, version: saved.state.revision });
  const bare = withoutSecretVersions(saved.state.document);
  assert.deepEqual(bare.general.files, [{ path: ".config/tool/a.json", content: { set: true } }]);
  assert.deepEqual(bare.general.tailnet?.clientId, { set: true });
  assert.ok(!JSON.stringify(saved).includes("made-up-secret"));

  const again = await rpc<ApplyResult>("config.apply", { draft: saved.state.document, revision: saved.state.revision });
  assert.ok(again.ok, "a draft may send the versions back");
  assert.deepEqual(again.state.document.general.files, general.files);
});

test("a secret changed outside BB Box's saves, as by a write cut short, gets a version no save used, on a new revision", async () => {
  const started = await start(ON);
  const before = await started.rpc<ConfigState>("config.get", null);
  const saved = await started.rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 2), revision: before.revision });
  assert.ok(saved.ok);
  const version = tokenState(saved.state).version!;
  await started.kv().set(SECRETS_KEY, { fake: { token: "made-up-token-0003" } });
  await started.restart();
  const after = await started.rpc<ConfigState>("config.get", null);
  assert.equal(after.revision, saved.state.revision + 1);
  assert.deepEqual(tokenState(after), { set: true, version: after.revision });
  assert.ok(tokenState(after).version! > version);

  await started.restart();
  assert.equal((await started.rpc<ConfigState>("config.get", null)).revision, after.revision, "a start with nothing changed outside writes nothing");
});

test("a document an earlier BB Box saved since is read, and the receipts kept", async () => {
  const started = await start(ON);
  const before = await started.rpc<ConfigState>("config.get", null);
  const saved = await started.rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 2), revision: before.revision, operation: "op-before" });
  assert.ok(saved.ok);
  const stored = (await started.kv().get<ConfigDocument>(DOCUMENT_KEY))!;
  await started.kv().set(DOCUMENT_KEY, { ...stored, revision: stored.revision + 3, general: { ...stored.general, boxesPerThread: 9 } });
  await started.restart();
  const after = await started.rpc<ConfigState>("config.get", null);
  assert.equal(after.document.general.boxesPerThread, 9);
  assert.equal(after.revision, stored.revision + 3);
  assert.deepEqual(after.receipts.map((receipt) => receipt.operation), ["op-before"]);
});

test("a backend's state names the revision its configuration last changed at, and its last check the revision it tested", async () => {
  const { rpc, cli } = await start(ON);
  const first = await rpc<ConfigState>("config.get", null);
  const backend = (state: ConfigState) => state.backends.find((each) => each.id === "fake")!;
  assert.equal(backend(first).changed, first.revision);

  const general = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(first.document, 2), revision: first.revision });
  assert.ok(general.ok);
  assert.equal(backend(general.state).changed, first.revision, "a change elsewhere leaves it");

  await rpc<CheckResult>("config.check", { draft: general.state.document, test: "fake" });
  const checked = await rpc<ConfigState>("config.get", null);
  assert.equal(backend(checked).doctor?.revision, general.state.revision);

  const moved = { ...checked.document, backends: checked.document.backends.map((each) => (each.id === "fake" ? { ...each, fields: { ...each.fields, address: "elsewhere" } } : each)) };
  const changed = await rpc<ApplyResult>("config.apply", { draft: moved, revision: checked.revision });
  assert.ok(changed.ok);
  assert.equal(backend(changed.state).changed, changed.state.revision);
  assert.ok(backend(changed.state).doctor!.revision! < backend(changed.state).changed, "so the page can say it was not checked since it changed");

  const doctor = await cli(["doctor"]);
  assert.ok(doctor.exitCode !== undefined);
  assert.equal(backend(await rpc<ConfigState>("config.get", null)).doctor?.revision, changed.state.revision, "bb box doctor checks the live backend, built from this revision");
});

test("setup is done once a backend that is on makes a kind, and stays done when every backend is off, across a start", async () => {
  const started = await start({ "enrol-boxes": false });
  const empty = await started.rpc<ConfigState>("config.get", null);
  assert.equal(empty.setupDone, null);
  const fake = { id: "fake", type: "fake", enabled: false, fields: {} };
  const off = await started.rpc<ApplyResult>("config.apply", { draft: { ...empty.document, backends: [fake] }, revision: empty.revision });
  assert.ok(off.ok);
  assert.equal(off.state.setupDone, null, "a backend that is off makes nothing");
  const on = await started.rpc<ApplyResult>("config.apply", { draft: { ...off.state.document, backends: [{ ...fake, enabled: true }] }, revision: off.state.revision });
  assert.ok(on.ok);
  assert.equal(on.state.setupDone?.revision, on.state.revision);
  const allOff = await started.rpc<ApplyResult>("config.apply", { draft: { ...on.state.document, backends: [fake] }, revision: on.state.revision });
  assert.ok(allOff.ok);
  assert.deepEqual(allOff.state.setupDone, on.state.setupDone);
  await started.restart();
  assert.deepEqual((await started.rpc<ConfigState>("config.get", null)).setupDone, on.state.setupDone);
});

test("config.migrated.remove removes the copy of BB's settings, as bb box config migrated --remove does", async () => {
  const { rpc } = await start(ON);
  assert.ok((await rpc<ConfigState>("config.get", null)).migrated);
  const removed = await rpc<{ removed: boolean; state: ConfigState }>("config.migrated.remove", null);
  assert.equal(removed.removed, true);
  assert.equal(removed.state.migrated, null);
  assert.equal((await rpc<{ removed: boolean }>("config.migrated.remove", null)).removed, false);
});

test("in a live check, the reply-drop switch stores the save and then drops its reply, and the receipt is there after", async () => {
  const { rpc, cli } = await start(ON, { liveChecks: true });
  const armed = await cli(["config", "drop-replies"]);
  assert.equal(armed.exitCode, 0, armed.stderr);
  assert.match(armed.stdout ?? "", /^The next save's reply is dropped after storing\./);
  const before = await rpc<ConfigState>("config.get", null);
  const request = { draft: withBoxesPerThread(before.document, 3), revision: before.revision, operation: "op-dropped" };
  await assert.rejects(rpc("config.apply", request), (error: Error) => error.message.includes(DROPPED_REPLY_MESSAGE));
  const after = await rpc<ConfigState>("config.get", null);
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.receipts.map((receipt) => [receipt.operation, receipt.revision]), [["op-dropped", before.revision + 1]]);

  const resent = await rpc<ApplyResult>("config.apply", request);
  assert.ok(resent.ok && resent.replayed, "the switch drops one reply, and a replay is answered");
  assert.equal(resent.receipt?.revision, before.revision + 1);

  await cli(["config", "drop-replies", "--count", "2"]);
  await cli(["config", "drop-replies", "--off"]);
  const next = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(after.document, 4), revision: after.revision, operation: "op-kept" });
  assert.ok(next.ok);
});

test("the reply-drop switch is off by default, and outside live checks it does not exist", async () => {
  assert.equal(liveChecksOn({}), false);
  assert.equal(liveChecksOn({ BB_BOX_LIVE_CHECKS: "true" }), false);
  assert.equal(liveChecksOn({ BB_BOX_LIVE_CHECKS: "1" }), true);
  const drops = new ReplyDrops();
  assert.equal(drops.take(), false);

  const { rpc, cli, app } = await start(ON, { liveChecks: false });
  assert.equal(app().replyDrops, null);
  const command = await cli(["config", "drop-replies"]);
  assert.notEqual(command.exitCode, 0);
  const before = await rpc<ConfigState>("config.get", null);
  const saved = await rpc<ApplyResult>("config.apply", { draft: withBoxesPerThread(before.document, 3), revision: before.revision, operation: "op-normal" });
  assert.ok(saved.ok);

  const unset = await start(ON);
  assert.equal(unset.app().replyDrops === null, !liveChecksOn(), "without the option, BB's server's environment decides");
});

test("fields where empty turns boxes off are marked, and exist in their drivers", () => {
  for (const driver of DRIVERS) {
    for (const key of driver.offWhenEmpty ?? []) assert.ok(driver.fields[key], `${driver.type} has no field ${key}`);
    const marked = driverFields(driver, DRIVERS).filter((field) => field.offWhenEmpty).map((field) => field.key);
    assert.deepEqual(marked, Object.keys(driver.fields).filter((key) => driver.offWhenEmpty?.includes(key)));
  }
  assert.deepEqual(dockerDriver.offWhenEmpty, ["linux-image", "desktop-image", "wayland-desktop-image"]);
});

test("draftFields keeps an explicit empty where empty turns boxes off and the field is stored, and drops it where unset, so the default stays", () => {
  const fields = driverFields(dockerDriver, DRIVERS);
  const values = { "linux-image": "", "desktop-image": "", "wayland-desktop-image": "my/wayland:1", network: "" };
  assert.deepEqual(draftFields(values, fields, { "linux-image": "", "desktop-image": undefined as never }), { "linux-image": "", "wayland-desktop-image": "my/wayland:1" });
  assert.deepEqual(draftFields(values, fields, { "linux-image": "bbbox/linux:1" }), { "linux-image": "", "wayland-desktop-image": "my/wayland:1" }, "a value cleared is saved as off");
  assert.deepEqual(draftFields(values, fields), { "wayland-desktop-image": "my/wayland:1" }, "today's page with nothing stored sends what it sent before");
});

test("a Docker backend saved with its Linux image empty keeps it empty, and its check finds no problem with it", async () => {
  const { rpc } = await start({ "enrol-boxes": false }, { drivers: [dockerDriver] });
  const state = await rpc<ConfigState>("config.get", null);
  const docker = { id: "docker", type: "docker", enabled: false, fields: { "linux-image": "" } };
  const saved = await rpc<ApplyResult>("config.apply", { draft: { ...state.document, backends: [docker] }, revision: state.revision });
  assert.ok(saved.ok, JSON.stringify(saved));
  assert.equal(saved.state.document.backends[0]!.fields["linux-image"], "");
  const checked = await rpc<CheckResult>("config.check", { draft: { ...saved.state.document, backends: [{ ...docker, enabled: true }] } });
  assert.ok(!checked.problems.some((problem) => problem.path === "backends.docker.linux-image"), JSON.stringify(checked.problems));
});

test("the shared iOS host fields of Tart, the SSH host pool and Namespace are one group, and no other field is in it", () => {
  for (const driver of DRIVERS) {
    for (const [key, field] of [...Object.entries(driver.fields), ...Object.entries(driver.hostFields ?? {})]) {
      assert.equal(field.group === "ios-hosts", key.startsWith("ios-hosts-"), `${driver.type} ${key} is in ${field.group}`);
    }
  }
  const grouped = DRIVERS.filter((driver) => Object.values(driver.fields).some((field) => field.group === "ios-hosts")).map((driver) => driver.type);
  assert.deepEqual(grouped.sort(), ["namespace", "ssh-pool", "tart"]);
});
