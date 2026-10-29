import assert from "node:assert/strict";
import { test } from "node:test";
import { Backends } from "../src/backends/index.ts";
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
  submittedWrite,
  type ApplyRequest,
  type DraftStorage,
  type InstantWrite,
  type SaveTransport,
  type StoredPart,
} from "../src/app/settings-drafts.ts";
import { filePath, newFilePath, plain, problemPath, storedAt, type EditValue } from "../src/app/settings-paths.ts";
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

  static async start(clock: { now: number }, files: readonly { readonly path: string; readonly content: string }[] = []): Promise<Server> {
    const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {} });
    const configuration = await Configuration.load({ kv: new MemoryStorage(), backends, drivers: [], boxes: async () => [], changed: () => {}, logError: () => {}, now: () => clock.now });
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
  assert.deepEqual(reloaded.registry.part(FILES_PART).restored, { count: 2, lost: ["the content of ~/.cfg/a.json", "the content of ~/.cfg/new.json"] });
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
