import assert from "node:assert/strict";
import { test } from "node:test";
import { Backends } from "../src/backends/index.ts";
import type { Backend, BackendDriver } from "../src/backends/types.ts";
import { GENERAL_SECRETS, contentKey } from "../src/core/box-files.ts";
import { withoutSecretVersions, type ConfigDocument } from "../src/core/document.ts";
import { Configuration, type ApplyResult, type ConfigState } from "../src/plugin/configuration.ts";
import { withMonitor } from "../src/app/config.ts";
import { DraftRegistry, type ApplyRequest, type DraftStorage, type SaveTransport, type StoredPart } from "../src/app/settings-drafts.ts";
import { IMPORT_PART, IMPORT_TEXT, exportedText, importChanges, importPlan, importedPaths, invalidWords, parseImport, secretsToGive } from "../src/app/settings-import.ts";
import { BACKEND_ORDER_PATH, backendFieldPath, backendPath, filePath, imageDefinitionPath, sizePath, type Path } from "../src/app/settings-paths.ts";
import { MemoryStorage } from "./helpers.ts";

const TOKEN = "made-up-token-7Qx2";
const NEW_TOKEN = "made-up-token-9Zk4";
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up-key-line\n-----END OPENSSH PRIVATE KEY-----\n";
const CONTENT = "made-up-file-content-3Lp8";

function cloudDriver(type: string, label: string): BackendDriver<unknown> {
  return {
    type,
    label,
    description: "Boxes rented by the minute.",
    nature: "virtual",
    form: "VM",
    kinds: ["linux"],
    warmKinds: ["linux"],
    fields: {
      host: { type: "string", label: "Host", group: "connection", default: "" },
      token: { type: "string", label: "API token secret", secret: true, group: "credentials" },
      key: { type: "string", label: "SSH private key", secret: true, group: "credentials" },
      image: { type: "string", label: "Linux image", group: "boxes", default: "base" },
      reserve: { type: "number", label: "Memory kept free (MiB)", group: "advanced", default: 4096 },
    },
    offWhenEmpty: ["image"],
    hostFields: { address: { type: "string", label: "Address", group: "connection", default: "" } },
    setup: { guide: "", scripts: [] },
    several: (fields: Readonly<Record<string, unknown>>) => (typeof fields.host === "string" ? fields.host : ""),
    parse: () => ({ ok: true, config: {} }),
    create: (_config, context) => ({ id: context.id, label, nature: "virtual", kinds: () => [] }) as unknown as Backend,
  };
}

class Server {
  readonly configuration: Configuration;
  readonly arrived: ApplyRequest[] = [];
  hold: Promise<void> | null = null;

  private constructor(configuration: Configuration) {
    this.configuration = configuration;
  }

  static async start(): Promise<Server> {
    const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {} });
    const drivers = [cloudDriver("cloud", "Cloud"), cloudDriver("other", "Other cloud")];
    const configuration = await Configuration.load({ kv: new MemoryStorage(), backends, drivers, boxes: async () => [], changed: () => {}, logError: () => {}, now: () => 1_800_000_000_000 });
    return new Server(configuration);
  }

  state(): Promise<ConfigState> {
    return this.configuration.state();
  }

  stored(): ConfigDocument {
    return this.configuration.document;
  }

  async elsewhere(change: (document: ConfigDocument) => ConfigDocument): Promise<ConfigState> {
    const state = await this.state();
    const result = await this.configuration.apply(change(state.document), state.revision);
    assert.equal(result.ok, true, "the write made elsewhere is saved");
    return (result as { state: ConfigState }).state;
  }

  transport(): SaveTransport {
    return {
      apply: async (request): Promise<ApplyResult> => {
        if (this.hold) await this.hold;
        this.arrived.push(request);
        return this.configuration.apply(request.draft, request.revision, { id: request.operation, submission: request.submission });
      },
      read: () => this.state(),
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let ids = 0;

async function page(server: Server, storage = new MemoryDraftStorage()) {
  const registry = new DraftRegistry({ storage, now: () => 1_800_000_000_000, newId: () => `op-${++ids}`, later: () => {} });
  registry.connect(server.transport());
  registry.observe(await server.state());
  return { registry, storage };
}

function seeded(document: ConfigDocument): ConfigDocument {
  return {
    ...document,
    backends: [
      { id: "cloud", type: "cloud", enabled: false, fields: { host: "a.example", token: TOKEN }, warm: { linux: 1 }, hosts: [{ name: "h-1", enabled: true, fields: { address: "h-1.example" } }] },
      { id: "other", type: "other", enabled: false, fields: { token: TOKEN } },
    ],
    general: { ...document.general, boxesPerThread: 3, files: [{ path: ".cfg/a.json", content: CONTENT }] },
    images: { tools: { kinds: ["linux"], script: "echo one\n", projects: ["proj_1"] } },
  } as ConfigDocument;
}

function exported(state: ConfigState): Record<string, any> {
  return JSON.parse(exportedText(withoutSecretVersions(state.document)));
}

async function check(server: Server, file: unknown) {
  const result = await server.configuration.check(file, undefined, undefined, { read: true });
  assert.ok(result.read, `the file reads: ${JSON.stringify(result.problems)}`);
  return result.read;
}

function setText(registry: DraftRegistry, text: string): void {
  registry.set(IMPORT_PART, IMPORT_TEXT, { kind: "secret", text });
}

async function checked(server: Server, registry: DraftRegistry, file: unknown, text = JSON.stringify(file)) {
  setText(registry, text);
  const plan = importPlan(registry.latest!, await check(server, JSON.parse(text)), JSON.parse(text));
  registry.replace(IMPORT_PART, (path) => path === IMPORT_TEXT, plan.values);
  return plan;
}

test("config.check reads a draft for an import with no secret value in it, and does not read one whose shape is wrong (067 unit 10)", async () => {
  const server = await Server.start();
  await server.elsewhere(seeded);
  const file = exported(await server.state());
  file.backends[0].fields.token = NEW_TOKEN;
  file.backends[0].fields.key = KEY;
  file.backends[1].fields.token = "";
  file.general.files[0].content = CONTENT.toUpperCase();
  file.backends.push({ id: "gone-type", type: "gone-type", enabled: false, fields: { token: TOKEN } });
  const read = await check(server, file);
  const shown = JSON.stringify(read);
  for (const secret of [NEW_TOKEN, KEY, CONTENT.toUpperCase(), TOKEN]) assert.ok(!shown.includes(secret), "no secret value is in what config.check reads");
  assert.deepEqual(read.secrets.cloud, { token: "set", key: "set" });
  assert.deepEqual(read.secrets.other, { token: "cleared", key: "cleared" }, "an export gives a secret not set as cleared");
  assert.deepEqual(read.secrets[GENERAL_SECRETS], { [contentKey(".cfg/a.json")]: "set" });
  assert.deepEqual(read.unknownTypes, ["gone-type"]);
  assert.deepEqual(read.document.backends.map((backend) => backend.id), ["cloud", "other"]);

  const wrong = await server.configuration.check({ ...file, general: { boxesPerThread: "many" } }, undefined, undefined, { read: true });
  assert.equal(wrong.read, null);
  assert.ok(wrong.problems.some((problem) => problem.path === "general.boxesPerThread"));
  const without = await server.configuration.check(file);
  assert.equal(without.read, undefined, "a check that does not ask is as before");
});

test("an export imported unchanged changes nothing; changed, the import lists each change with before and after, never a secret, and applies them", async () => {
  const server = await Server.start();
  await server.elsewhere(seeded);
  const { registry } = await page(server);
  const state = registry.latest!;
  assert.equal(importPlan(state, await check(server, exported(state)), exported(state)).values.length, 0, "an export changes nothing");
  assert.deepEqual(
    secretsToGive(state).map((secret) => `${secret.owner}: ${secret.what}`),
    ["cloud: the API token secret", "other: the API token secret", "Files for every box: the content of ~/.cfg/a.json"],
  );

  const file = exported(state);
  file.monitor = { refreshIntervalSeconds: 15 };
  file.general.boxesPerThread = 0;
  file.backends[0].fields.host = "b.example";
  file.backends[0].fields.token = NEW_TOKEN;
  file.backends[0].hosts.push({ name: "h-2", enabled: false, fields: { address: "h-2.example" } });
  file.backends = [{ id: "cloud:second", type: "cloud", label: "Second cloud", enabled: false, fields: { host: "c.example", key: KEY } }, file.backends[0]];
  file.kinds = { linux: { presets: { medium: { memoryMiB: 12288 } } } };
  file.general.files[0].content = CONTENT.toUpperCase();
  file.images.tools.script = "echo two\n";
  file.images.more = { kinds: ["linux"], script: "echo more\n", projects: ["proj_2"] };
  const plan = await checked(server, registry, file);
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.unset, ["the API token secret of Second cloud"]);

  const edits = registry.part(IMPORT_PART).edits;
  const paths = importedPaths(edits);
  for (const path of ["monitor/refreshIntervalSeconds", "general/boxesPerThread", backendFieldPath("cloud", "host"), backendFieldPath("cloud", "token"), backendPath("other"), backendPath("cloud:second"), filePath(".cfg/a.json"), sizePath("linux", "medium", "memoryGiB"), imageDefinitionPath("tools"), imageDefinitionPath("more"), BACKEND_ORDER_PATH] as Path[]) {
    assert.ok(paths.includes(path), `the import changes ${path}`);
  }
  const changes = importChanges(registry.latest!, edits).flatMap((group) => group.changes.map((change) => ({ place: group.place, ...change })));
  const find = (path: Path) => changes.find((change) => change.path === path)!;
  assert.deepEqual([find("monitor/refreshIntervalSeconds").place, find("monitor/refreshIntervalSeconds").before, find("monitor/refreshIntervalSeconds").after], ["Monitor", "5 s", "15 s"]);
  assert.deepEqual([find(backendFieldPath("cloud", "token")).before, find(backendFieldPath("cloud", "token")).after, find(backendFieldPath("cloud", "token")).secret], ["Set", "A new value (not shown)", true]);
  assert.equal(find(backendPath("other")).after, "Removed: its secrets are deleted and its warm boxes go");
  assert.equal(find(backendPath("cloud:second")).place, "Second cloud");
  assert.equal(find(imageDefinitionPath("tools")).after, "Its script changes: On linux, for 1 project");
  assert.equal(find(BACKEND_ORDER_PATH).after, "Second cloud, then cloud");
  assert.deepEqual([find(sizePath("linux", "medium", "memoryGiB")).before.endsWith("GiB"), find(sizePath("linux", "medium", "memoryGiB")).after], [true, "12 GiB"]);
  const words = JSON.stringify(changes);
  for (const secret of [NEW_TOKEN, KEY, CONTENT, CONTENT.toUpperCase(), TOKEN]) assert.ok(!words.includes(secret), "the change list shows no secret");

  await registry.save(IMPORT_PART);
  assert.equal(registry.part(IMPORT_PART).outcome?.kind, "saved");
  assert.equal(registry.part(IMPORT_PART).edits.size, 0, "the import is cleared once applied");
  const stored = server.stored();
  assert.equal(stored.monitor?.refreshIntervalSeconds, 15);
  assert.equal(stored.general.boxesPerThread, undefined, "the default is stored as left out");
  assert.deepEqual(stored.backends.map((backend) => backend.id), ["cloud:second", "cloud"]);
  assert.equal(stored.backends[1]!.fields.host, "b.example");
  assert.deepEqual(stored.backends[1]!.hosts?.map((host) => [host.name, host.enabled]), [["h-1", true], ["h-2", false]]);
  assert.equal(server.configuration.secrets.cloud?.token, NEW_TOKEN);
  assert.equal(server.configuration.secrets["cloud:second"]?.key, KEY);
  assert.equal(server.configuration.secrets.other, undefined, "the removed backend's secrets are gone");
  assert.equal(server.configuration.secrets[GENERAL_SECRETS]?.[contentKey(".cfg/a.json")], CONTENT.toUpperCase());
  assert.equal(stored.images?.tools?.script, "echo two\n");
  assert.equal(stored.images?.more?.projects[0], "proj_2");
  const again = importPlan(await server.state(), await check(server, file), file).values;
  assert.deepEqual(
    again.map(([path, value]) => [path, value.kind]),
    [
      [filePath(".cfg/a.json"), "secret"],
      [backendFieldPath("cloud:second", "key"), "secret"],
      [backendFieldPath("cloud", "token"), "secret"],
    ],
    "the same file again only gives its secrets again, as a secret is never compared",
  );
});

test("an import applied against a moved revision keeps a change made elsewhere to another setting, and stops at one made to a setting it changes", async () => {
  const server = await Server.start();
  const { registry } = await page(server);
  const file = exported(registry.latest!);
  file.monitor = { refreshIntervalSeconds: 15 };
  await checked(server, registry, file);
  registry.observe(await server.elsewhere((document) => ({ ...document, general: { ...document.general, boxesPerThread: 4 } })));
  assert.deepEqual(registry.conflicts(IMPORT_PART), []);
  await registry.save(IMPORT_PART);
  const outcome = registry.part(IMPORT_PART).outcome;
  assert.equal(outcome?.kind, "saved");
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 15);
  assert.equal(server.stored().general.boxesPerThread, 4, "the change made elsewhere after the check is kept, not reverted by the file");

  file.monitor = { refreshIntervalSeconds: 25 };
  await checked(server, registry, file);
  const held = deferred();
  server.hold = held.promise;
  const saving = registry.save(IMPORT_PART);
  await server.elsewhere((document) => withMonitor(document, { refreshIntervalSeconds: 40 }));
  server.hold = null;
  held.resolve();
  await saving;
  assert.equal(registry.part(IMPORT_PART).outcome?.kind, "conflicts");
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 40, "nothing is applied over the change made elsewhere");
  assert.deepEqual(registry.conflictAt(IMPORT_PART, "monitor/refreshIntervalSeconds"), { kind: "changed", stored: 40 });
  registry.keepMine(IMPORT_PART, "monitor/refreshIntervalSeconds");
  await registry.save(IMPORT_PART);
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 25);
});

test("G8 import-newer-typing: text changed while its import applies stays, with its change list cleared, and only what was checked is stored", async () => {
  const server = await Server.start();
  const { registry } = await page(server);
  const file = exported(registry.latest!);
  file.monitor = { refreshIntervalSeconds: 15 };
  await checked(server, registry, file, JSON.stringify(file, null, 2));
  const held = deferred();
  server.hold = held.promise;
  const saving = registry.save(IMPORT_PART);
  const newer = JSON.stringify({ ...file, monitor: { refreshIntervalSeconds: 20 } }, null, 2);
  setText(registry, newer);
  registry.replace(IMPORT_PART, (path) => path === IMPORT_TEXT, []);
  server.hold = null;
  held.resolve();
  await saving;
  assert.equal(server.stored().monitor?.refreshIntervalSeconds, 15, "15 is stored");
  const part = registry.part(IMPORT_PART);
  assert.deepEqual([...part.edits.keys()], [IMPORT_TEXT]);
  assert.deepEqual(part.edits.get(IMPORT_TEXT)?.value, { kind: "secret", text: newer }, "the editor keeps the newer text");
  assert.deepEqual(part.outcome, { kind: "saved", revision: server.stored().revision, lostReply: false, rebased: false, changedElsewhere: [], newer: 1 });
  assert.equal(server.arrived.length, 1);
});

test("G9 import-secret-storage: pasted text, valid or not, never reaches draft storage; a checked import keeps only what it changes, without secrets", async () => {
  const server = await Server.start();
  await server.elsewhere(seeded);
  const storage = new MemoryDraftStorage();
  const { registry } = await page(server, storage);
  const file = exported(registry.latest!);
  file.backends[0].fields.token = NEW_TOKEN;
  file.backends[0].fields.key = KEY;
  file.general.files[0].content = CONTENT.toUpperCase();
  const text = JSON.stringify(file, null, 2);
  setText(registry, text);
  for (const secret of [NEW_TOKEN, KEY, CONTENT.toUpperCase(), "refreshIntervalSeconds"]) assert.ok(!storage.text().includes(secret));
  setText(registry, `${text.slice(0, 200)} not json ${NEW_TOKEN}`);
  assert.ok(!storage.text().includes(NEW_TOKEN), "text that does not parse is not kept either");
  const parsed = parseImport(`${text.slice(0, 200)} not json ${NEW_TOKEN}`);
  assert.equal(parsed.ok, false);
  assert.ok(!invalidWords(parsed as Extract<typeof parsed, { ok: false }>).includes(NEW_TOKEN));

  const reloaded = new DraftRegistry({ storage, now: () => 1_800_000_000_000, newId: () => "op-x", later: () => {} });
  assert.deepEqual(reloaded.part(IMPORT_PART).restored, { count: 1, lost: [IMPORT_TEXT] }, "after a reload the page asks for the text again");
  assert.deepEqual(reloaded.part(IMPORT_PART).edits.get(IMPORT_TEXT)?.value, { kind: "secret", text: null });

  await checked(server, registry, file, text);
  assert.ok(importedPaths(registry.part(IMPORT_PART).edits).includes(backendFieldPath("cloud", "key")));
  for (const secret of [NEW_TOKEN, KEY, CONTENT.toUpperCase(), TOKEN, CONTENT]) assert.ok(!storage.text().includes(secret), "the checked form kept has no secret");
  const restored = new DraftRegistry({ storage, now: () => 1_800_000_000_000, newId: () => "op-y", later: () => {} });
  restored.observe(await server.state());
  assert.ok(restored.part(IMPORT_PART).restored?.lost.includes(IMPORT_TEXT));
  assert.ok(importChanges(restored.latest!, restored.part(IMPORT_PART).edits).length > 0, "after a reload the page can still say what the import would have changed");
});

test("an import the page cannot apply as it is says why: a new file without its content, and a backend type this BB Box lacks", async () => {
  const server = await Server.start();
  const { registry } = await page(server);
  const file = exported(registry.latest!);
  file.general.files = [{ path: ".cfg/new.json", content: { set: true } }];
  file.backends = [{ id: "gone-type", type: "gone-type", enabled: false, fields: {} }];
  const plan = importPlan(registry.latest!, await check(server, file), file);
  assert.deepEqual(plan.problems, [
    "~/.cfg/new.json is a new file for every box, and the file gives no content for it. Give its content, or leave the file out.",
    "It has a backend of type gone-type, which this BB Box has no driver for, so the page cannot import it.",
  ]);
  assert.deepEqual(plan.values, []);
});
