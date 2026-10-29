import assert from "node:assert/strict";
import { test } from "node:test";
import { Backends } from "../src/backends/index.ts";
import type { Backend, BackendDriver, FieldProblem } from "../src/backends/types.ts";
import { GENERAL_SECRETS, contentKey } from "../src/core/box-files.ts";
import type { ConfigDocument } from "../src/core/document.ts";
import { RECEIPTS_KEPT_AT_MOST, RECEIPTS_KEPT_MS } from "../src/core/receipt-window.ts";
import { Configuration, type ApplyResult, type ConfigState } from "../src/plugin/configuration.ts";
import { withGeneral, withMonitor } from "../src/app/config.ts";
import {
  BOXES_PART,
  DraftRegistry,
  FILES_PART,
  MONITOR_PART,
  NETWORK_PART,
  submittedWrite,
  type ApplyRequest,
  type DraftStorage,
  type InstantWrite,
  type SaveTransport,
  type StoredPart,
} from "../src/app/settings-drafts.ts";
import { backendFieldPath, filePath, hostFieldPath, hostPath, labelOf, newFilePath, newHostPath, plain, problemPath, storedAt, tailnetPath, type EditValue } from "../src/app/settings-paths.ts";
import { TAILNET_CLIENT_ID, TAILNET_CLIENT_SECRET } from "../src/core/tailnet-settings.ts";
import { MemoryStorage } from "./helpers.ts";

interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Fault {
  readonly before?: () => Promise<void>;
  readonly after?: () => Promise<void>;
  readonly lose?: true;
  readonly drop?: true;
  readonly twice?: true;
}

class Server {
  readonly configuration: Configuration;
  readonly arrived: ApplyRequest[] = [];
  readonly faults: Fault[] = [];
  readFails = false;
  #elsewhere = 0;

  private constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  static async start(clock: { now: number }, files: readonly { readonly path: string; readonly content: string }[] = [], drivers: readonly BackendDriver<unknown>[] = []): Promise<Server> {
    const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {} });
    const configuration = await Configuration.load({ kv: new MemoryStorage(), backends, drivers, boxes: async () => [], changed: () => {}, logError: () => {}, now: () => clock.now });
    const server = new Server(configuration);
    if (files.length) await server.elsewhere((document) => withGeneral(document, { files }));
    return server;
  }

  state(): Promise<ConfigState> {
    return this.configuration.state();
  }

  stored(): ConfigDocument {
    return this.configuration.document;
  }

  content(path: string): string | undefined {
    return this.configuration.secrets[GENERAL_SECRETS]?.[contentKey(path)];
  }

  secret(backend: string, key: string): string | undefined {
    return this.configuration.secrets[backend]?.[key];
  }

  async elsewhere(change: (document: ConfigDocument) => ConfigDocument, operation?: string): Promise<ConfigState> {
    const state = await this.state();
    const result = await this.configuration.apply(change(state.document), state.revision, operation ? { id: operation } : undefined);
    assert.equal(result.ok, true, "the write made elsewhere is saved");
    this.#elsewhere += 1;
    return (result as { state: ConfigState }).state;
  }

  async #apply(request: ApplyRequest): Promise<ApplyResult> {
    const result = await this.configuration.apply(request.draft, request.revision, { id: request.operation, submission: request.submission });
    this.arrived.push(request);
    return result;
  }

  transport(): SaveTransport {
    return {
      apply: async (request) => {
        const fault = this.faults.shift() ?? {};
        await fault.before?.();
        if (fault.lose) throw new Error("The connection closed.");
        const sent = fault.twice ? await Promise.all([this.#apply(request), this.#apply(request)]) : [await this.#apply(request)];
        await fault.after?.();
        if (fault.drop && sent[0]!.ok) throw new Error("BB Box saved this and dropped its reply, as a live check asked.");
        return sent[0]!;
      },
      read: async () => {
        if (this.readFails) throw new Error("The connection closed.");
        return this.state();
      },
    };
  }
}

class MemoryDraftStorage implements DraftStorage {
  readonly values = new Map<string, string>();
  load(): Record<string, StoredPart> {
    return Object.fromEntries([...this.values].map(([part, text]) => [part, JSON.parse(text) as StoredPart]));
  }
  save(part: string, value: StoredPart | null): void {
    if (value) this.values.set(part, JSON.stringify(value));
    else this.values.delete(part);
  }
  text(): string {
    return [...this.values.values()].join("\n");
  }
}

interface Page {
  readonly registry: DraftRegistry;
  readonly server: Server;
  readonly clock: { now: number };
  readonly storage: MemoryDraftStorage;
}

let ids = 0;

async function page(server: Server, clock: { now: number }, storage = new MemoryDraftStorage()): Promise<Page> {
  const registry = new DraftRegistry({ storage, now: () => clock.now, newId: () => `op-${++ids}`, later: () => {} });
  registry.connect(server.transport());
  registry.observe(await server.state());
  return { registry, server, clock, storage };
}

async function started(files: readonly { readonly path: string; readonly content: string }[] = []): Promise<Page> {
  const clock = { now: 1_800_000_000_000 };
  return page(await Server.start(clock, files), clock);
}

const withFile = (path: string, content: string) => [{ path, content }];

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("the condition never held");
}

function setRefresh(seconds: number) {
  return (document: ConfigDocument) => withMonitor(document, { refreshIntervalSeconds: seconds });
}

test("a form's edit is saved with an operation ID, BB Box's receipt lists it, and the draft is cleared", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  assert.equal(registry.changeCount(MONITOR_PART), 1);
  await registry.save(MONITOR_PART);
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 12);
  const part = registry.part(MONITOR_PART);
  assert.equal(part.edits.size, 0);
  assert.deepEqual(part.outcome, { kind: "saved", revision: server.stored().revision, lostReply: false, rebased: false, changedElsewhere: [], newer: 0 });
  const state = await server.state();
  assert.deepEqual(state.receipts.map((receipt) => receipt.operation), [server.arrived[0]!.operation]);
});

test("a change made elsewhere to another setting merges; to the same setting it is a conflict on that setting alone, with both choices", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  registry.set(BOXES_PART, "general/boxesPerThread", plain("3"));
  registry.observe(await server.elsewhere((document) => withGeneral(document, { enrol: false })));
  assert.deepEqual(registry.conflicts(MONITOR_PART), []);
  registry.observe(await server.elsewhere(setRefresh(8)));
  assert.deepEqual(registry.conflictAt(MONITOR_PART, "monitor/refreshIntervalSeconds"), { kind: "changed", stored: 8 });
  assert.deepEqual(registry.conflicts(BOXES_PART), [], "the other part's edit stays as it is");

  const before = server.stored().revision;
  await registry.save(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).outcome?.kind, "conflicts", "Save waits until each conflict is chosen");
  assert.equal(server.stored().revision, before);

  registry.keepMine(MONITOR_PART, "monitor/refreshIntervalSeconds");
  assert.deepEqual(registry.conflicts(MONITOR_PART), []);
  await registry.save(MONITOR_PART);
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 12);
  assert.equal(server.stored().general.enrol, false, "the change made elsewhere is kept");

  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("20"));
  registry.observe(await server.elsewhere(setRefresh(30)));
  registry.forget(MONITOR_PART, "monitor/refreshIntervalSeconds");
  assert.equal(registry.part(MONITOR_PART).edits.size, 0, "Use theirs drops the edit");
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 30);
});

test("G1: a retry rebases the frozen submission on the newer document, and typing during the retry stays a change of its own", async () => {
  const { registry, server } = await started();
  registry.set(BOXES_PART, "general/boxesPerThread", plain("3"));
  const held = deferred();
  server.faults.push({ before: async () => void (await server.elsewhere(setRefresh(9))) }, { before: () => held.promise });
  const saving = registry.save(BOXES_PART);
  await until(() => {
    const phase = registry.part(BOXES_PART).operation?.phase;
    return phase?.at === "sending" && phase.attempt === 2;
  });
  registry.set(BOXES_PART, "general/boxesPerThread", plain("7"));
  held.release();
  await saving;
  assert.equal(server.stored().general.boxesPerThread, 3, "A is stored");
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 9, "the independent write is kept");
  const part = registry.part(BOXES_PART);
  assert.deepEqual([...part.edits], [["general/boxesPerThread", { value: plain("7"), base: { kind: "value", value: 3 } }]], "B is not stored, and shows as a change");
  assert.deepEqual(part.outcome, { kind: "saved", revision: server.stored().revision, lostReply: false, rebased: true, changedElsewhere: [], newer: 1 });
  assert.equal(server.arrived.length, 2);
  assert.deepEqual(server.arrived[0]!.submission, server.arrived[1]!.submission, "the retry sends the same submission");
  assert.equal(server.arrived[1]!.operation, server.arrived[0]!.operation);
});

test("G1 with a file: a replaced content saved through a retry is the one sent, and newer text waits with the saved version as its base", async () => {
  const { registry, server } = await started(withFile(".cfg/a.json", "first"));
  const path = filePath(".cfg/a.json");
  registry.set(FILES_PART, path, { kind: "secret", text: "A" });
  const held = deferred();
  server.faults.push({ before: async () => void (await server.elsewhere(setRefresh(9))) }, { before: () => held.promise });
  const saving = registry.save(FILES_PART);
  await until(() => (registry.part(FILES_PART).operation?.phase as { attempt?: number } | undefined)?.attempt === 2);
  registry.set(FILES_PART, path, { kind: "secret", text: "B" });
  held.release();
  await saving;
  assert.equal(server.content(".cfg/a.json"), "A");
  const revision = server.stored().revision;
  assert.deepEqual(registry.part(FILES_PART).edits.get(path), { value: { kind: "secret", text: "B" }, base: { kind: "version", version: revision } });
  assert.deepEqual(registry.conflicts(FILES_PART), []);
  assert.equal(registry.part(FILES_PART).outcome?.kind, "saved");
});

test("a conflict found while retrying stops the save with nothing stored, and three refusals in a row stop it with the draft kept", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  server.faults.push({ before: async () => void (await server.elsewhere(setRefresh(8))) });
  await registry.save(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).outcome?.kind, "conflicts");
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 8);
  assert.equal(registry.part(MONITOR_PART).edits.size, 1);

  registry.keepMine(MONITOR_PART, "monitor/refreshIntervalSeconds");
  for (let race = 0; race < 3; race += 1) server.faults.push({ before: async () => void (await server.elsewhere((document) => withGeneral(document, { boxesPerThread: race + 1 }))) });
  await registry.save(MONITOR_PART);
  assert.deepEqual(registry.part(MONITOR_PART).outcome, { kind: "exhausted" });
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 8);
  assert.equal(registry.part(MONITOR_PART).edits.size, 1, "the changes are still here");
});

test("a lost reply after a store is confirmed by the receipt, and a file replaced elsewhere before the page looked is named", async () => {
  const { registry, server } = await started(withFile(".cfg/a.json", "first"));
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  server.faults.push({ drop: true });
  await registry.save(MONITOR_PART);
  assert.deepEqual(registry.part(MONITOR_PART).outcome, { kind: "saved", revision: server.stored().revision, lostReply: true, rebased: false, changedElsewhere: [], newer: 0 });

  const path = filePath(".cfg/a.json");
  registry.set(FILES_PART, path, { kind: "secret", text: "mine" });
  server.faults.push({ drop: true, after: async () => void (await server.elsewhere((document) => withGeneral(document, { files: [{ path: ".cfg/a.json", content: "theirs" }] }))) });
  await registry.save(FILES_PART);
  const outcome = registry.part(FILES_PART).outcome;
  assert.equal(outcome?.kind, "saved");
  assert.equal((outcome as { lostReply: boolean }).lostReply, true);
  assert.deepEqual((outcome as { changedElsewhere: readonly string[] }).changedElsewhere, [`the content of ~/.cfg/a.json (revision ${server.stored().revision})`]);
  assert.equal(server.content(".cfg/a.json"), "theirs");
});

test("a request that never arrives is not confirmed; Save again resends it with the same ID, and it is applied once", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  server.faults.push({ lose: true });
  const before = server.stored().revision;
  await registry.save(MONITOR_PART);
  const pending = registry.part(MONITOR_PART).operation;
  assert.equal(pending?.phase.at, "unconfirmed");
  assert.equal(registry.part(MONITOR_PART).edits.size, 1, "the changes are still here");
  assert.equal(server.stored().revision, before);
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("15"));
  await registry.save(MONITOR_PART);
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 12, "Save again sends the frozen submission, not newer typing");
  assert.equal(server.stored().revision, before + 1);
  assert.deepEqual(server.arrived.map((request) => request.operation), [pending!.id]);
  assert.deepEqual([...registry.part(MONITOR_PART).edits.values()].map((edit) => edit.value), [plain("15")]);
});

test("the same request sent twice at once is applied once", async () => {
  const { registry, server } = await started();
  registry.set(BOXES_PART, "general/boxesPerThread", plain("4"));
  server.faults.push({ twice: true });
  const before = server.stored().revision;
  await registry.save(BOXES_PART);
  assert.equal(server.stored().revision, before + 1);
  assert.equal(server.arrived.length, 2);
  assert.equal((await server.state()).receipts.length, 1);
  assert.equal(registry.part(BOXES_PART).outcome?.kind, "saved");
});

test("a reply that comes late, after the page saw the receipt, is ignored, and the save's state is in the registry for the page that comes back", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  const late = deferred();
  server.faults.push({ after: () => late.promise });
  const saving = registry.save(MONITOR_PART);
  await until(() => server.arrived.length === 1);
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("15"));
  registry.observe(await server.state());
  assert.equal(registry.part(MONITOR_PART).outcome?.kind, "saved", "the change signal's reload finds the receipt");
  late.release();
  await saving;
  const part = registry.part(MONITOR_PART);
  assert.deepEqual([...part.edits.values()], [{ value: plain("15"), base: { kind: "value", value: 12 } }]);
  assert.equal(part.operation, null);
});

test("G4: a lost reply that finishes after newer typing stores the first value once and keeps the newer one as a change", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  const slow = deferred();
  server.faults.push({ drop: true, after: () => slow.promise });
  const before = server.stored().revision;
  const saving = registry.save(MONITOR_PART);
  await until(() => server.arrived.length === 1);
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("15"));
  slow.release();
  await saving;
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 12);
  assert.equal(server.stored().revision, before + 1);
  const part = registry.part(MONITOR_PART);
  assert.equal(part.outcome?.kind, "saved");
  assert.equal((part.outcome as { lostReply: boolean }).lostReply, true);
  assert.deepEqual([...part.edits.values()].map((edit) => edit.value), [plain("15")]);
  assert.equal(registry.changeCount(MONITOR_PART), 1);
});

test("a receipt aged out is not confirmed, the save is never sent again, and its edits are checked against what is stored", async () => {
  const { registry, server, clock } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  server.faults.push({ drop: true });
  server.readFails = true;
  await registry.save(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).operation?.phase.at, "unconfirmed");
  for (let save = 0; save < RECEIPTS_KEPT_AT_MOST + 5; save += 1) await server.elsewhere((document) => withGeneral(document, { boxesPerThread: save % 7 }), `agent-${save}`);
  server.readFails = false;
  registry.observe(await server.state());
  const part = registry.part(MONITOR_PART);
  assert.deepEqual(part.outcome, { kind: "expired", left: 1 });
  assert.equal(part.operation, null);
  assert.equal(part.edits.size, 0, "what is stored already matches the edit");
  const arrived = server.arrived.length;
  await registry.save(MONITOR_PART);
  assert.equal(server.arrived.length, arrived, "never sent again");

  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("20"));
  server.faults.push({ lose: true });
  await registry.save(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).operation?.phase.at, "unconfirmed");
  clock.now += RECEIPTS_KEPT_MS;
  registry.observe(await server.elsewhere(setRefresh(25)));
  assert.equal(registry.part(MONITOR_PART).outcome?.kind, "expired");
  assert.deepEqual(registry.conflictAt(MONITOR_PART, "monitor/refreshIntervalSeconds"), { kind: "changed", stored: 25 });
});

test("G2: a new file with the path of an existing file replaces it from that file's version, and a change elsewhere is a conflict until chosen", async () => {
  const { registry, server } = await started(withFile(".cfg/a.json", "first"));
  const fresh = newFilePath("k3x9");
  registry.set(FILES_PART, fresh, { kind: "new-file", path: "", text: "" });
  registry.set(FILES_PART, fresh, { kind: "new-file", path: ".cfg/a.json", text: "" });
  registry.set(FILES_PART, fresh, { kind: "new-file", path: ".cfg/a.json", text: "mine" });
  const state = await server.state();
  assert.deepEqual(registry.part(FILES_PART).edits.get(fresh)?.base, storedAt(state, filePath(".cfg/a.json")));
  assert.deepEqual(registry.conflicts(FILES_PART), []);
  registry.observe(await server.elsewhere((document) => withGeneral(document, { files: [{ path: ".cfg/a.json", content: "theirs" }] })));
  assert.deepEqual(registry.conflictAt(FILES_PART, fresh), { kind: "replaced", version: server.stored().revision });
  await registry.save(FILES_PART);
  assert.equal(registry.part(FILES_PART).outcome?.kind, "conflicts");
  assert.equal(server.content(".cfg/a.json"), "theirs", "nothing is replaced until one is chosen");
  registry.keepMine(FILES_PART, fresh);
  await registry.save(FILES_PART);
  assert.equal(server.content(".cfg/a.json"), "mine");
  assert.equal(server.stored().general.files?.length, 1);
});

test("G3: a new file's saved identity replaces its provisional one, newer text moves to it, and a second save meets a change made elsewhere", async () => {
  const { registry, server } = await started();
  const fresh = newFilePath("p2m4");
  registry.set(FILES_PART, fresh, { kind: "new-file", path: ".cfg/b.json", text: "one" });
  const held = deferred();
  server.faults.push({ before: () => held.promise });
  const saving = registry.save(FILES_PART);
  await until(() => registry.part(FILES_PART).operation?.phase.at === "sending");
  registry.set(FILES_PART, fresh, { kind: "new-file", path: ".cfg/b.json", text: "two" });
  held.release();
  await saving;
  const revision = server.stored().revision;
  assert.equal(server.content(".cfg/b.json"), "one");
  const edits = registry.part(FILES_PART).edits;
  assert.equal([...edits.keys()].some((path) => path.includes("@new-")), false, "no edit keeps an @new- identity");
  assert.deepEqual(edits.get(filePath(".cfg/b.json")), { value: { kind: "secret", text: "two" }, base: { kind: "version", version: revision } });
  assert.equal(registry.savedIdentity(fresh), filePath(".cfg/b.json"));
  registry.observe(await server.elsewhere((document) => withGeneral(document, { files: [{ path: ".cfg/b.json", content: "theirs" }] })));
  await registry.save(FILES_PART);
  assert.equal(registry.part(FILES_PART).outcome?.kind, "conflicts");
  assert.equal(server.content(".cfg/b.json"), "theirs");
  assert.equal(server.stored().general.files?.length, 1, "a second save never makes another file");
});

test("G5: a file's newer text typed while its save is out stays, marked unsaved", async () => {
  const { registry, server } = await started(withFile(".cfg/a.json", "first"));
  const path = filePath(".cfg/a.json");
  registry.set(FILES_PART, path, { kind: "secret", text: "second" });
  const held = deferred();
  server.faults.push({ after: () => held.promise });
  const saving = registry.save(FILES_PART);
  await until(() => server.arrived.length === 1);
  registry.set(FILES_PART, path, { kind: "secret", text: "third" });
  held.release();
  await saving;
  assert.equal(server.content(".cfg/a.json"), "second");
  assert.deepEqual(registry.part(FILES_PART).edits.get(path)?.value, { kind: "secret", text: "third" });
  assert.equal(registry.changeCount(FILES_PART), 1);
});

test("new files are refused at their fields for an empty path, a bad path or no content, and the server's problems resolve to the draft identity", async () => {
  const { registry } = await started();
  registry.set(FILES_PART, newFilePath("a"), { kind: "new-file", path: "", text: "x" });
  registry.set(FILES_PART, newFilePath("b"), { kind: "new-file", path: "/etc/passwd", text: "" });
  await registry.save(FILES_PART);
  assert.deepEqual(
    registry.part(FILES_PART).problems.map((problem) => problem.path),
    [`${newFilePath("a")}/path`, `${newFilePath("b")}/path`, `${newFilePath("b")}/content`],
  );
  assert.equal(problemPath("general.files.1.content", { "general.files.0": filePath("a"), "general.files.1": newFilePath("q") }), `${newFilePath("q")}/content`);
  assert.equal(problemPath("monitor.refreshIntervalSeconds", {}), "monitor/refreshIntervalSeconds");

  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("90"));
  await registry.save(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).outcome?.kind, "problems");
  assert.deepEqual(registry.part(MONITOR_PART).problems.map((problem) => problem.path), ["monitor/refreshIntervalSeconds"]);
  assert.equal(registry.part(MONITOR_PART).edits.size, 1, "a refusal keeps the draft");
});

test("secrets, file contents and new files' text are kept in memory only; a reload brings back the rest and says what to paste again", async () => {
  const clock = { now: 1_800_000_000_000 };
  const server = await Server.start(clock, withFile(".cfg/a.json", "first"));
  const storage = new MemoryDraftStorage();
  const first = await page(server, clock, storage);
  first.registry.set(FILES_PART, filePath(".cfg/a.json"), { kind: "secret", text: "made-up-secret-1" });
  first.registry.set(FILES_PART, newFilePath("n1"), { kind: "new-file", path: ".cfg/new.json", text: "made-up-secret-2" });
  first.registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  assert.equal(storage.text().includes("made-up-secret"), false);
  assert.equal(storage.text().includes(".cfg/new.json"), true, "a new file's path is kept");

  const reloaded = await page(server, clock, storage);
  const restored = reloaded.registry.part(FILES_PART);
  assert.deepEqual(restored.restored, { count: 2, lost: [filePath(".cfg/a.json"), newFilePath("n1")] });
  assert.deepEqual(restored.restored!.lost.map((path) => labelOf(path, restored.edits.get(path)?.value)), ["the content of ~/.cfg/a.json", "the content of ~/.cfg/new.json"]);
  assert.deepEqual(reloaded.registry.part(MONITOR_PART).restored, { count: 1, lost: [] });
  await reloaded.registry.save(MONITOR_PART);
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 12);
  await reloaded.registry.save(FILES_PART);
  assert.equal(reloaded.registry.part(FILES_PART).outcome?.kind, "problems", "what was not kept must be pasted again");
  assert.equal(server.content(".cfg/a.json"), "first");
});

test("after a reload a pending save looks for its receipt: found, it is saved; missing, Save again resends it; missing with a pasted secret, it cannot be resent", async () => {
  const clock = { now: 1_800_000_000_000 };
  const server = await Server.start(clock, withFile(".cfg/a.json", "first"));
  const storage = new MemoryDraftStorage();
  const before = await page(server, clock, storage);
  before.registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  server.faults.push({ drop: true });
  server.readFails = true;
  await before.registry.save(MONITOR_PART);
  server.readFails = false;
  const found = await page(server, clock, storage);
  assert.equal(found.registry.part(MONITOR_PART).outcome?.kind, "saved");
  assert.equal(found.registry.part(MONITOR_PART).edits.size, 0);

  found.registry.set(BOXES_PART, "general/boxesPerThread", plain("5"));
  server.faults.push({ lose: true });
  await found.registry.save(BOXES_PART);
  const id = found.registry.part(BOXES_PART).operation?.id;
  const missing = await page(server, clock, storage);
  assert.equal(missing.registry.part(BOXES_PART).operation?.phase.at, "unconfirmed");
  await missing.registry.save(BOXES_PART);
  assert.equal(server.stored().general.boxesPerThread, 5);
  assert.equal(server.arrived.at(-1)?.operation, id, "the same operation, sent again after the reload");

  missing.registry.set(FILES_PART, filePath(".cfg/a.json"), { kind: "secret", text: "made-up-secret-3" });
  server.faults.push({ lose: true });
  await missing.registry.save(FILES_PART);
  const secretLost = await page(server, clock, storage);
  assert.equal(secretLost.registry.part(FILES_PART).outcome?.kind, "unsendable");
  assert.equal(secretLost.registry.part(FILES_PART).operation, null);
  assert.equal(server.content(".cfg/a.json"), "first");
});

function switchWrite(state: ConfigState, path: string, value: EditValue, what: string): InstantWrite {
  return { key: path, what, pending: value, say: (latest) => String((storedAt(latest, path) as { value: unknown }).value), ...submittedWrite({ part: `instant:${path}`, edits: [{ path, value, base: storedAt(state, path) }] }) };
}

test("a switch is saved with its receipt; refusals, three refusals in a row and a lost request put it back and say why", async () => {
  const { registry, server } = await started();
  const latest = () => registry.latest!;
  assert.deepEqual(await registry.runInstant(switchWrite(latest(), "monitor/backgroundMonitoring", plain(true), "Background monitoring")), { kind: "saved", revision: server.stored().revision });
  assert.equal(server.stored().monitor?.backgroundMonitoring, true);
  assert.equal(registry.instant("monitor/backgroundMonitoring").saved, true);
  assert.equal((await server.state()).receipts.length, 1);

  for (let race = 0; race < 3; race += 1) server.faults.push({ before: async () => void (await server.elsewhere((document) => withGeneral(document, { boxesPerThread: race + 1 }))) });
  assert.deepEqual(await registry.runInstant(switchWrite(latest(), "monitor/enabled", plain(false), "Machine status")), { kind: "exhausted" });
  assert.equal(registry.instant("monitor/enabled").note?.text, "Machine status was not changed: the configuration changed 3 times while saving. It is true; try again.");
  assert.equal(server.stored().monitor?.enabled, undefined);

  server.faults.push({ lose: true });
  assert.deepEqual(await registry.runInstant(switchWrite(latest(), "monitor/enabled", plain(false), "Machine status")), { kind: "unconfirmed" });
  assert.match(registry.instant("monitor/enabled").note!.text, /^Not confirmed: BB Box did not reply \(The connection closed\), and has no receipt for this change\. Machine status is true now, at revision \d+\.$/);

  server.faults.push({ drop: true });
  assert.deepEqual(await registry.runInstant(switchWrite(latest(), "monitor/enabled", plain(false), "Machine status")), { kind: "saved", revision: server.stored().revision });
  assert.match(registry.instant("monitor/enabled").note!.text, /BB Box did not reply, and its receipt for this change confirms it/);

  registry.observe(await server.elsewhere((document) => withGeneral(document, { video: false })));
  const already = await registry.runInstant(switchWrite(latest(), "general/video", plain(false), "Linux desktops as video"));
  assert.equal(already?.kind, "already");

  assert.deepEqual(await registry.runInstant(switchWrite(latest(), "general/boxesPerThread", plain(-1), "Boxes per thread")), { kind: "refused" });
  assert.match(registry.instant("general/boxesPerThread").note!.text, /^Boxes per thread was not changed: /);
});

test("Discard puts back the saved values of a part's edits and nothing else", async () => {
  const { registry, server } = await started();
  registry.set(MONITOR_PART, "monitor/refreshIntervalSeconds", plain("12"));
  registry.set(BOXES_PART, "general/boxesPerThread", plain("3"));
  registry.discard(MONITOR_PART);
  assert.equal(registry.part(MONITOR_PART).edits.size, 0);
  assert.equal(registry.part(BOXES_PART).edits.size, 1);
  assert.deepEqual(registry.partsWithDrafts(), [BOXES_PART]);
  assert.equal(server.stored().monitor, undefined);
});

function macsDriver(): BackendDriver<unknown> {
  return {
    type: "macs",
    label: "Macs",
    description: "Boxes on Macs.",
    nature: "virtual",
    form: "VM",
    kinds: ["linux"],
    fields: {
      token: { type: "string", label: "API token secret", secret: true, group: "credentials" },
      image: { type: "string", label: "Linux image", group: "boxes", default: "base" },
      reserve: { type: "number", label: "Memory kept free (MiB)", group: "advanced", default: 4096 },
    },
    offWhenEmpty: ["image"],
    hostFields: {
      address: { type: "string", label: "Address", group: "connection", default: "" },
      cores: { type: "number", label: "Cores of a shared iOS host", group: "ios-hosts" },
    },
    setup: { guide: "", scripts: [] },
    parse(part) {
      const problems: FieldProblem[] = [];
      part.hosts.forEach((host, n) => {
        const cores = host.fields.cores;
        if (cores !== undefined && (typeof cores !== "number" || cores < 2 || cores > 64)) problems.push({ path: `hosts.${n}.cores`, message: `Mac ${host.name}: the cores of a shared iOS host on it must be a whole number from 2 to 64.` });
      });
      return problems.length ? { ok: false, problems } : { ok: true, config: {} };
    },
    create: (_config, context) => ({ id: context.id, label: "Macs", nature: "virtual", kinds: () => [] }) as unknown as Backend,
  };
}

const MACS = "macs";
const BACKEND_PART = "backend/macs";

async function withMacs(enabled = true, hosts: readonly string[] = ["mac-1"]): Promise<Page> {
  const clock = { now: 1_800_000_000_000 };
  const server = await Server.start(clock, [], [macsDriver()]);
  await server.elsewhere((document) => ({ ...document, backends: [{ id: MACS, type: MACS, enabled, fields: { token: "made-up-token-0" }, hosts: hosts.map((name) => ({ name, enabled: true, fields: { address: `${name}.example` } })) }] }));
  return page(server, clock);
}

test("a backend's fields save through the registry: text, a number typed as text, an explicit off that stays off, and the secret's version as its base", async () => {
  const { registry, server } = await withMacs(false);
  const image = backendFieldPath(MACS, "image");
  const reserve = backendFieldPath(MACS, "reserve");
  assert.deepEqual(registry.part(BACKEND_PART).edits.size, 0);
  registry.set(BACKEND_PART, reserve, plain("2048"));
  registry.set(BACKEND_PART, image, plain(""));
  assert.equal(registry.changeCount(BACKEND_PART), 2);
  await registry.save(BACKEND_PART);
  assert.equal(registry.part(BACKEND_PART).outcome?.kind, "saved");
  assert.deepEqual(server.stored().backends[0]!.fields, { image: "", reserve: 2048 });
  assert.equal(server.secret(MACS, "token"), "made-up-token-0", "the secret not edited is kept");

  registry.set(BACKEND_PART, image, plain(null));
  await registry.save(BACKEND_PART);
  assert.deepEqual(server.stored().backends[0]!.fields, { reserve: 2048 }, "offered again with the default: the field is left out");
  registry.set(BACKEND_PART, reserve, plain("2048"));
  assert.equal(registry.changeCount(BACKEND_PART), 0, "typing the stored value is no change");

  const token = backendFieldPath(MACS, "token");
  const version = (registry.latest!.document.backends[0]!.fields.token as { version: number }).version;
  registry.set(BACKEND_PART, token, { kind: "secret", text: "made-up-token-1" });
  assert.deepEqual(registry.part(BACKEND_PART).edits.get(token)?.base, { kind: "version", version });
  await registry.save(BACKEND_PART);
  assert.equal(server.secret(MACS, "token"), "made-up-token-1");
  registry.set(BACKEND_PART, token, { kind: "removed" });
  await registry.save(BACKEND_PART);
  assert.equal(server.secret(MACS, "token"), undefined, "Clear removes it");
});

test("G1 with a secret: the secret sent is the one stored through a retry, and newer typing waits with the saved version as its base", async () => {
  const { registry, server } = await withMacs(false);
  const token = backendFieldPath(MACS, "token");
  registry.set(BACKEND_PART, token, { kind: "secret", text: "made-up-A" });
  const held = deferred();
  server.faults.push({ before: async () => void (await server.elsewhere(setRefresh(9))) }, { before: () => held.promise });
  const saving = registry.save(BACKEND_PART);
  await until(() => (registry.part(BACKEND_PART).operation?.phase as { attempt?: number } | undefined)?.attempt === 2);
  registry.set(BACKEND_PART, token, { kind: "secret", text: "made-up-B" });
  held.release();
  await saving;
  assert.equal(server.secret(MACS, "token"), "made-up-A", "A is stored");
  const revision = server.stored().revision;
  assert.deepEqual(registry.part(BACKEND_PART).edits.get(token), { value: { kind: "secret", text: "made-up-B" }, base: { kind: "version", version: revision } }, "B is not stored, and shows as a change");
  const outcome = registry.part(BACKEND_PART).outcome;
  assert.deepEqual(outcome, { kind: "saved", revision, lostReply: false, rebased: true, changedElsewhere: [], newer: 1 }, "the bar names nothing else");
  assert.deepEqual(server.arrived[0]!.submission, server.arrived[1]!.submission);
  assert.equal(JSON.stringify(server.arrived[0]!.submission).includes("made-up-B"), false);
});

test("a secret replaced in two tabs: the second is a conflict that names the revision, with both choices", async () => {
  const clock = { now: 1_800_000_000_000 };
  const first = await withMacs(false);
  const second = await page(first.server, clock);
  const token = backendFieldPath(MACS, "token");
  first.registry.set(BACKEND_PART, token, { kind: "secret", text: "made-up-first" });
  second.registry.set(BACKEND_PART, token, { kind: "secret", text: "made-up-second" });
  await second.registry.save(BACKEND_PART);
  first.registry.observe(await first.server.state());
  const revision = first.server.stored().revision;
  assert.deepEqual(first.registry.conflictAt(BACKEND_PART, token), { kind: "replaced", version: revision });
  await first.registry.save(BACKEND_PART);
  assert.equal(first.registry.part(BACKEND_PART).outcome?.kind, "conflicts");
  assert.equal(first.server.secret(MACS, "token"), "made-up-second");
  first.registry.keepMine(BACKEND_PART, token);
  await first.registry.save(BACKEND_PART);
  assert.equal(first.server.secret(MACS, "token"), "made-up-first");
});

test("G6: a new Mac saved while its cores are typed becomes the saved Mac, and the second Save updates it", async () => {
  const { registry, server } = await withMacs(true);
  const fresh = newHostPath(MACS, "k3x9");
  registry.set(BACKEND_PART, fresh, { kind: "new-host", name: "review-mac", enabled: true });
  registry.set(BACKEND_PART, hostFieldPath(fresh, "address"), plain("review.example"));
  const held = deferred();
  server.faults.push({ before: () => held.promise });
  const saving = registry.save(BACKEND_PART);
  await until(() => registry.part(BACKEND_PART).operation?.phase.at === "sending");
  registry.set(BACKEND_PART, hostFieldPath(fresh, "cores"), plain("8"));
  held.release();
  await saving;
  const saved = hostPath(MACS, "review-mac");
  assert.deepEqual(server.stored().backends[0]!.hosts!.map((host) => host.name), ["mac-1", "review-mac"]);
  assert.equal(registry.savedIdentity(fresh), saved);
  const part = registry.part(BACKEND_PART);
  assert.deepEqual([...part.edits.keys()], [hostFieldPath(saved, "cores")], "no edit keeps an @new- identity");
  assert.deepEqual(part.edits.get(hostFieldPath(saved, "cores"))?.base, { kind: "value", value: null });
  assert.equal((part.outcome as { newer: number }).newer, 1);
  await registry.save(BACKEND_PART);
  const hosts = server.stored().backends[0]!.hosts!;
  assert.equal(hosts.filter((host) => host.name === "review-mac").length, 1, "one review-mac");
  assert.deepEqual(hosts.find((host) => host.name === "review-mac")!.fields, { address: "review.example", cores: 8 });
  assert.equal(registry.part(BACKEND_PART).edits.size, 0);
});

test("G7: a new Mac with 1 core is refused at its cores field, and a Mac named like another is refused at its name before anything is sent", async () => {
  const { registry, server } = await withMacs(true);
  const fresh = newHostPath(MACS, "a1");
  registry.set(BACKEND_PART, fresh, { kind: "new-host", name: "small-mac", enabled: true });
  registry.set(BACKEND_PART, hostFieldPath(fresh, "cores"), plain("1"));
  await registry.save(BACKEND_PART);
  const refused = registry.part(BACKEND_PART);
  assert.equal(refused.outcome?.kind, "problems");
  assert.deepEqual(refused.problems.map((problem) => problem.path), [hostFieldPath(fresh, "cores")]);
  assert.equal(server.stored().backends[0]!.hosts!.length, 1, "nothing saved");
  assert.equal(problemPath("backends.macs.hosts.1.cores", { "backends.macs.hosts.1": fresh }), hostFieldPath(fresh, "cores"));

  registry.forgetUnder(BACKEND_PART, fresh);
  const twin = newHostPath(MACS, "b2");
  registry.set(BACKEND_PART, twin, { kind: "new-host", name: "mac-1", enabled: true });
  const sent = server.arrived.length;
  await registry.save(BACKEND_PART);
  assert.deepEqual(registry.part(BACKEND_PART).problems, [{ path: `${twin}/name`, message: "mac-1 is already a host on Macs." }]);
  assert.equal(server.arrived.length, sent, "nothing was sent");
});

test("a Mac removed when the form is saved, a Mac's own field changed elsewhere is a conflict, and a removed backend is gone", async () => {
  const { registry, server } = await withMacs(false, ["mac-1", "mac-2"]);
  const address = hostFieldPath(hostPath(MACS, "mac-1"), "address");
  registry.set(BACKEND_PART, address, plain("new.example"));
  registry.observe(await server.elsewhere((document) => ({ ...document, backends: document.backends.map((backend) => ({ ...backend, hosts: backend.hosts!.map((host) => (host.name === "mac-1" ? { ...host, fields: { address: "other.example" } } : host)) })) })));
  assert.deepEqual(registry.conflictAt(BACKEND_PART, address), { kind: "changed", stored: "other.example" });
  registry.forget(BACKEND_PART, address);
  registry.set(BACKEND_PART, hostPath(MACS, "mac-2"), { kind: "removed" });
  await registry.save(BACKEND_PART);
  assert.deepEqual(server.stored().backends[0]!.hosts!.map((host) => host.name), ["mac-1"]);

  registry.set(BACKEND_PART, backendFieldPath(MACS, "reserve"), plain("1024"));
  const removal = switchWrite(registry.latest!, `backends/${MACS}`, { kind: "removed" }, "Macs");
  assert.equal((await registry.runInstant(removal))?.kind, "saved");
  assert.deepEqual(server.stored().backends, []);
  assert.deepEqual(registry.conflictAt(BACKEND_PART, backendFieldPath(MACS, "reserve")), { kind: "removed" });
});

function tailnetSecret(server: Server, key: string): string | undefined {
  return server.configuration.secrets[GENERAL_SECRETS]?.[key];
}

test("the tailnet's choice, tags and OAuth client save together: refused part way, nothing is stored and every edit stays; then saved, with the secrets' versions as later bases (067 unit 9)", async () => {
  const { registry, server } = await started();
  const before = server.stored().revision;
  registry.set(NETWORK_PART, tailnetPath("mode"), plain("oauth"));
  registry.set(NETWORK_PART, tailnetPath("tags"), plain("tag:bb-box,  tag:ci tag:ci"));
  registry.set(NETWORK_PART, tailnetPath("clientId"), { kind: "secret", text: "made-up-id" });
  await registry.save(NETWORK_PART);
  const refused = registry.part(NETWORK_PART);
  assert.deepEqual(refused.outcome, { kind: "problems", count: 1 });
  assert.deepEqual(refused.problems, [{ path: tailnetPath("clientSecret"), message: "Set the Tailscale OAuth client's secret, as the guide shows." }]);
  assert.equal(refused.edits.size, 3);
  assert.equal(server.stored().revision, before);
  assert.equal(server.stored().general.tailnet, undefined);
  assert.equal(tailnetSecret(server, TAILNET_CLIENT_ID), undefined);

  registry.set(NETWORK_PART, tailnetPath("clientSecret"), { kind: "secret", text: "made-up-secret" });
  await registry.save(NETWORK_PART);
  assert.equal(registry.part(NETWORK_PART).outcome?.kind, "saved");
  assert.equal(registry.part(NETWORK_PART).edits.size, 0);
  assert.deepEqual(server.stored().general.tailnet, { mode: "oauth", tags: ["tag:bb-box", "tag:ci"] });
  assert.equal(tailnetSecret(server, TAILNET_CLIENT_ID), "made-up-id");
  assert.equal(tailnetSecret(server, TAILNET_CLIENT_SECRET), "made-up-secret");
  assert.equal(server.arrived.length, 2);
  assert.notEqual(server.arrived[0]!.operation, server.arrived[1]!.operation);
  const saved = server.stored().revision;
  assert.deepEqual(storedAt(await server.state(), tailnetPath("clientSecret")), { kind: "version", version: saved });

  registry.set(NETWORK_PART, tailnetPath("tags"), plain(""));
  await registry.save(NETWORK_PART);
  assert.deepEqual(server.stored().general.tailnet, { mode: "oauth" }, "empty tags go back to the default, and the secrets stay");
  assert.equal(tailnetSecret(server, TAILNET_CLIENT_SECRET), "made-up-secret");

  registry.set(NETWORK_PART, tailnetPath("mode"), plain("off"));
  await registry.save(NETWORK_PART);
  assert.equal(server.stored().general.tailnet, undefined);
  assert.equal(tailnetSecret(server, TAILNET_CLIENT_ID), undefined, "No deletes the OAuth client");
});

test("a tailnet secret replaced in two tabs: the second is a conflict that names the revision; Keep mine saves mine, and the other secret is kept (067 unit 9)", async () => {
  const clock = { now: 1_800_000_000_000 };
  const first = await page(await Server.start(clock), clock);
  await first.server.elsewhere((document) => withGeneral(document, { tailnet: { mode: "oauth", clientId: "made-up-id", clientSecret: "made-up-0" } as never }));
  first.registry.observe(await first.server.state());
  const second = await page(first.server, clock);
  const secret = tailnetPath("clientSecret");
  first.registry.set(NETWORK_PART, secret, { kind: "secret", text: "made-up-first" });
  second.registry.set(NETWORK_PART, secret, { kind: "secret", text: "made-up-second" });
  await second.registry.save(NETWORK_PART);
  first.registry.observe(await first.server.state());
  const revision = first.server.stored().revision;
  assert.deepEqual(first.registry.conflictAt(NETWORK_PART, secret), { kind: "replaced", version: revision });
  await first.registry.save(NETWORK_PART);
  assert.equal(first.registry.part(NETWORK_PART).outcome?.kind, "conflicts");
  assert.equal(tailnetSecret(first.server, TAILNET_CLIENT_SECRET), "made-up-second");
  first.registry.keepMine(NETWORK_PART, secret);
  await first.registry.save(NETWORK_PART);
  assert.equal(tailnetSecret(first.server, TAILNET_CLIENT_SECRET), "made-up-first");
  assert.equal(tailnetSecret(first.server, TAILNET_CLIENT_ID), "made-up-id");
  assert.equal(labelOf(secret), "the OAuth client secret");
  assert.equal(problemPath("general.tailnet.clientId", {}), tailnetPath("clientId"));
  assert.equal(problemPath("general.tailnet", {}), tailnetPath("mode"));
});

test("the tailnet's pasted secrets are kept in memory only; after a reload the page asks for them again before it saves (067 unit 9)", async () => {
  const { registry, server, clock, storage } = await started();
  registry.set(NETWORK_PART, tailnetPath("mode"), plain("oauth"));
  registry.set(NETWORK_PART, tailnetPath("clientId"), { kind: "secret", text: "made-up-id" });
  registry.set(NETWORK_PART, tailnetPath("clientSecret"), { kind: "secret", text: "made-up-secret" });
  assert.equal(storage.text().includes("made-up"), false);
  const reloaded = await page(server, clock, storage);
  assert.deepEqual(reloaded.registry.part(NETWORK_PART).restored, { count: 3, lost: [tailnetPath("clientId"), tailnetPath("clientSecret")] });
  await reloaded.registry.save(NETWORK_PART);
  assert.deepEqual(
    reloaded.registry.part(NETWORK_PART).problems.map((problem) => problem.message),
    ["Paste the OAuth client ID again: what you pasted was not kept when the page reloaded.", "Paste the OAuth client secret again: what you pasted was not kept when the page reloaded."],
  );
  assert.equal(server.arrived.length, 0);
});
