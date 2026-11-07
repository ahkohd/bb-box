import assert from "node:assert/strict";
import { test } from "node:test";
import { LXC_FIELDS, parseLxcPart } from "../src/backends/proxmox-lxc/config.ts";
import { DOCKER_FIELDS } from "../src/backends/docker/config.ts";
import { Backends } from "../src/backends/index.ts";
import { overLimitWords } from "../src/backends/card-limit.ts";
import type { AcquireHooks, BoxIdentity, CardsInUse, GpuPart } from "../src/backends/types.ts";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import { backendPart, backendWholeCards, emptyDocument, generalConfig, readDraft, wholeCardsAnywhere, type ConfigDocument } from "../src/core/document.ts";
import { chooseGpu, gpuForSpare } from "../src/core/gpu.ts";
import { setKind } from "../src/plugin/config-edits.ts";
import { settingsCards } from "../src/plugin/gpu-settings.ts";
import { candidateOf, plain } from "../src/app/settings-paths.ts";
import { draftLimit, kindGpuChoices, kindGpuWords, loweredLimitWords, readAgo, wholeCardsNow, wholeKeptWords } from "../src/app/gpu-settings-words.ts";
import type { ConfigState } from "../src/plugin/configuration.ts";
import { ClaimsBridge, CARD_A } from "./gpu-helper/claims-bridge.ts";
import { MemoryStorage, lxcConfig } from "./helpers.ts";

const KINDS = ["linux", "linux-desktop", "linux-desktop-cpu", "macos"];

function lxcPart(fields: Record<string, unknown>) {
  const parsed = parseLxcPart({ id: "proxmox-lxc", hosts: [], fields: { url: "https://pve.example.com:8006", "token-id": "bb-box@pve!plugin", "token-secret": "s3cret", "linux-templates": "9000", ...fields } as never });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}

function documentWith(backends: ConfigDocument["backends"], general: ConfigDocument["general"] = {}, kinds: ConfigDocument["kinds"] = {}): ConfigDocument {
  return { ...emptyDocument(4), backends, general, kinds };
}

test("071 unit 15: Proxmox LXC's boxes per card is 4 where never set, and an explicit old desktops per GPU is kept, 0 for no limit included", () => {
  assert.deepEqual(lxcConfig().desktop, { perGpu: 4 }, "never set: the new default");
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktops-per-gpu": 0 }).desktop, { perGpu: null }, "an explicit old 0 stays no limit");
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktops-per-gpu": 2 }).desktop, { perGpu: 2 });
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktops-per-gpu": 0, "proxmox-lxc-boxes-per-card": 3 }).desktop, { perGpu: 3 }, "the new key wins once set");
  assert.deepEqual(lxcConfig({ "proxmox-lxc-boxes-per-card": 0 }).desktop, { perGpu: null });
  assert.deepEqual(lxcPart({ "desktops-per-gpu": 0 }).desktop, { perGpu: null }, "the document's field reads the same");
  assert.deepEqual(lxcPart({}).desktop, { perGpu: 4 });
  const refused = parseLxcPart({ id: "proxmox-lxc", hosts: [], fields: { url: "https://pve.example.com:8006", "token-id": "bb-box@pve!plugin", "token-secret": "s3cret", "boxes-per-card": 1.5 } as never });
  assert.ok(!refused.ok);
  assert.ok(refused.problems.some((problem) => problem.path === "boxes-per-card"), JSON.stringify(refused.problems));
});

test("071 unit 15: through the driver, as bb-box builds a backend, an old key that is set is read though the new key has a default, and the new key wins once set", () => {
  const lxcFields = { url: "https://pve.example.com:8006", "token-id": "bb-box@pve!plugin", "linux-templates": "9000" };
  const lxc = (fields: Record<string, unknown>) => {
    const parsed = proxmoxLxcDriver.parse(backendPart({ id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: { ...lxcFields, ...fields } as never }, proxmoxLxcDriver, { "proxmox-lxc": { "token-secret": "s3cret" } }));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return parsed.config;
  };
  assert.deepEqual(lxc({ "desktops-per-gpu": 0 }).desktop, { perGpu: null });
  assert.deepEqual(lxc({ "desktops-per-gpu": 2 }).desktop, { perGpu: 2 });
  assert.deepEqual(lxc({}).desktop, { perGpu: 4 });
  assert.deepEqual(lxc({ "desktops-per-gpu": 2, "boxes-per-card": 3 }).desktop, { perGpu: 3 });
  const docker = (fields: Record<string, unknown>) => {
    const parsed = dockerDriver.parse(backendPart({ id: "docker", type: "docker", enabled: true, fields: fields as never }, dockerDriver, {}));
    assert.ok(parsed.ok, JSON.stringify(parsed));
    return parsed.config;
  };
  assert.deepEqual([docker({ "gpu-desktops": true, "desktops-per-gpu": 2 }).gpus, docker({ "gpu-desktops": true, "desktops-per-gpu": 2 }).boxesPerCard], [true, 2]);
  assert.deepEqual([docker({}).gpus, docker({}).boxesPerCard], [false, 4]);
  assert.deepEqual([docker({ "gpu-desktops": true, gpus: false }).gpus, docker({ "desktops-per-gpu": 2, "boxes-per-card": 1 }).boxesPerCard], [false, 1]);
});

test("071 unit 15: Proxmox LXC's GPU memory a new box needs is a field, 1,024 MiB unset", () => {
  assert.equal(lxcConfig().gpuMemoryMiB, 1024);
  assert.equal(lxcConfig({ "proxmox-lxc-gpu-memory-mib": 4096 }).gpuMemoryMiB, 4096);
  const refused = parseLxcPart({ id: "proxmox-lxc", hosts: [], fields: { url: "https://pve.example.com:8006", "token-id": "bb-box@pve!plugin", "token-secret": "s3cret", "gpu-memory-mib": -1 } as never });
  assert.ok(!refused.ok && refused.problems.some((problem) => problem.path === "gpu-memory-mib"));
});

test("071 unit 15: the GPUs fields are in their own group, the old keys stay fields the settings page does not show, and each new field names the one it replaces", () => {
  assert.deepEqual(["boxes-per-card", "whole-cards", "gpu-memory-mib"].map((key) => LXC_FIELDS[key]?.group), ["gpus", "gpus", "gpus"]);
  assert.equal(LXC_FIELDS["desktops-per-gpu"]?.replacedBy, "boxes-per-card");
  assert.equal(LXC_FIELDS["boxes-per-card"]?.replaces, "desktops-per-gpu");
  assert.ok(!("default" in LXC_FIELDS["desktops-per-gpu"]!), "the old key has no default of its own, so only a value set is read");
  assert.ok(!("default" in LXC_FIELDS["whole-cards"]!), "whole cards unset falls back to the install-wide option");
  assert.deepEqual(["gpus", "boxes-per-card", "whole-cards", "gpu-memory-mib"].map((key) => DOCKER_FIELDS[key]?.group), ["gpus", "gpus", "gpus", "gpus"]);
  assert.deepEqual([DOCKER_FIELDS["gpu-desktops"]?.replacedBy, DOCKER_FIELDS["desktops-per-gpu"]?.replacedBy], ["gpus", "boxes-per-card"]);
});

test("071 unit 15: the old key is left in place: a document that sets it reads with no problem, and a save of the new key keeps it", () => {
  const backend = { id: "docker", type: "docker", enabled: true, fields: { "gpu-desktops": true, "desktops-per-gpu": 2 } };
  const read = readDraft({ schema: emptyDocument().schema, revision: 0, backends: [backend], kinds: {}, general: {} }, [{ type: "docker", fields: DOCKER_FIELDS } as never]);
  assert.deepEqual(read.problems.filter((problem) => /gpu-desktops|desktops-per-gpu/.test(problem.path)), []);
  assert.deepEqual(read.document.backends[0]!.fields, { "gpu-desktops": true, "desktops-per-gpu": 2 });
});

test("071 unit 15: whole cards are each backend's: its own field wins where set, else the install-wide option, off unless set; any backend that is on with them on turns them on for the install", () => {
  assert.deepEqual(backendWholeCards({ fields: {} }, {}), { on: false, from: "install" });
  assert.deepEqual(backendWholeCards({ fields: {} }, { wholeCards: true }), { on: true, from: "install" });
  assert.deepEqual(backendWholeCards({ fields: { "whole-cards": false } }, { wholeCards: true }), { on: false, from: "backend" });
  assert.deepEqual(backendWholeCards({ fields: { "whole-cards": true } }, {}), { on: true, from: "backend" });
  const lxc = { id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: {} };
  const docker = { id: "docker", type: "docker", enabled: true, fields: { "whole-cards": true } };
  assert.equal(wholeCardsAnywhere(documentWith([lxc])), false, "nothing changes on upgrade: unset everywhere is off");
  assert.equal(wholeCardsAnywhere(documentWith([lxc, docker])), true);
  assert.equal(wholeCardsAnywhere(documentWith([lxc, { ...docker, enabled: false }])), false, "a backend that is off gives no whole card");
  assert.equal(generalConfig(documentWith([lxc, docker])).wholeCards, true);
  assert.equal(generalConfig(documentWith([lxc], { wholeCards: true })).wholeCards, true);
});

test("071 unit 15: each backend's context reads its own whole-cards field, then general.wholeCards", async () => {
  const backends = new Backends({ storage: new MemoryStorage(), installId: "i15", logError: () => {}, drivers: [] });
  await backends.configure(documentWith([{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: {} }, { id: "docker", type: "docker", enabled: true, fields: { "whole-cards": true } }]), {});
  assert.equal(backends.context("proxmox-lxc").wholeCards?.(), false);
  assert.equal(backends.context("docker").wholeCards?.(), true);
  await backends.configure(documentWith([{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: {} }, { id: "docker", type: "docker", enabled: true, fields: { "whole-cards": false } }], { wholeCards: true }), {});
  assert.equal(backends.context("proxmox-lxc").wholeCards?.(), true, "unset: the install-wide option");
  assert.equal(backends.context("docker").wholeCards?.(), false, "set: its own, whatever the install-wide option says");
});

test("071 unit 15: a kind's GPU when not asked for is none, shared or whole, only for linux and linux-desktop, and core reads it", () => {
  const read = (kinds: unknown) => readDraft({ schema: emptyDocument().schema, revision: 0, backends: [], kinds, general: {} }, []);
  const set = read({ linux: { gpu: "shared" }, "linux-desktop": { gpu: "whole" } });
  assert.deepEqual(set.problems, []);
  assert.deepEqual(generalConfig(set.document).gpuWhenNotAsked, { linux: "shared", "linux-desktop": "whole" });
  assert.deepEqual(read({ linux: { gpu: "two" } }).problems.map((problem) => problem.path), ["kinds.linux.gpu"]);
  assert.deepEqual(generalConfig(read({}).document).gpuWhenNotAsked, {});
  assert.deepEqual(chooseGpu("linux", undefined, { linux: "shared" }), { ok: true, gpu: "shared" });
  assert.deepEqual(chooseGpu("linux", undefined, {}), { ok: true, gpu: "none" });
  assert.deepEqual(chooseGpu("linux-desktop-cpu", undefined, { "linux-desktop": "whole" }), { ok: true, gpu: "none" }, "linux-desktop-cpu is still a desktop with no GPU");
  assert.deepEqual(chooseGpu("linux", "none", { linux: "whole" }), { ok: true, gpu: "none" }, "a part that is asked for wins");
  assert.equal(gpuForSpare("whole"), "shared", "a spare of a kind whose GPU is whole is made shared");
  assert.equal(gpuForSpare("none"), "none");
});

test("071 unit 15: bb box kind set --gpu sets a kind's GPU when not asked for, and refuses a kind with no GPU part", () => {
  const document = documentWith([]);
  const edited = setKind(document, KINDS, "linux", { gpu: "shared" });
  assert.equal(edited.document.kinds.linux?.gpu, "shared");
  assert.deepEqual(edited.changes, [{ path: "kinds.linux.gpu", words: "GPU when not asked for none → shared" }]);
  assert.throws(() => setKind(document, KINDS, "macos", { gpu: "shared" }), /macos boxes have no GPU part, so --gpu is only for linux and linux-desktop/);
});

function stateOf(document: ConfigDocument): ConfigState {
  const size = { cores: 2, memoryMiB: 4096, diskGiB: null };
  return { document, revision: document.revision, defaults: { general: {}, monitor: {}, kinds: { linux: { enabled: true, presets: { small: size, medium: size, large: size }, default: "small", largest: { cores: 16, memoryMiB: 32768, diskGiB: 256 } } } }, kinds: [], drivers: [], backends: [], problems: [], migrated: null, receipts: [], setupDone: null } as unknown as ConfigState;
}

test("071 unit 15: a kind's page that saves its sizes keeps the kind's GPU, and choosing bb-box's own default stores none", () => {
  const state = stateOf(documentWith([], {}, { linux: { gpu: "shared" } }));
  const sized = candidateOf(state, [{ path: "kinds/linux/presets/small/cores", value: plain(3), base: { kind: "value", value: 2 } }]);
  assert.equal(sized.document.kinds.linux?.gpu, "shared");
  assert.equal(sized.document.kinds.linux?.presets?.small?.cores, 3);
  const chose = candidateOf(state, [{ path: "kinds/linux/gpu", value: plain("whole"), base: { kind: "value", value: "shared" } }]);
  assert.equal(chose.document.kinds.linux?.gpu, "whole");
  const back = candidateOf(state, [{ path: "kinds/linux/gpu", value: plain(null), base: { kind: "value", value: "shared" } }]);
  assert.equal(back.document.kinds.linux, undefined);
});

test("071 unit 15: the kind's menu lists Whole card only where a backend has whole cards on, or the kind has it now, and says when it would refuse", () => {
  const off = documentWith([{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: {} }]);
  const on = documentWith([{ id: "proxmox-lxc", type: "proxmox-lxc", enabled: true, fields: { "whole-cards": true } }]);
  assert.deepEqual(kindGpuChoices(off, "none"), ["none", "shared"]);
  assert.deepEqual(kindGpuChoices(on, "none"), ["none", "shared", "whole"]);
  assert.deepEqual(kindGpuChoices(off, "whole"), ["none", "shared", "whole"]);
  assert.match(kindGpuWords("linux", "whole", false), /Whole cards are off on every backend, so a box that leaves gpu out is refused/);
  assert.match(kindGpuWords("linux", "whole", true), /Spare boxes of the kind are made shared/);
  assert.match(kindGpuWords("linux-desktop", "shared", true), /Shared is bb-box's own default for linux-desktop\./);
});

const IN_USE: CardsInUse = {
  is: "read",
  host: "pve-1",
  source: "helper",
  at: 1_000,
  limit: 2,
  counts: "this-install-running",
  cards: [
    { uuid: "GPU-a", index: 0, model: null, totalMiB: 24_576, freeMiB: 3_480, holders: [{ is: "box", name: "quiet-elm", part: "whole", running: true, counts: true }], counted: 1 },
    {
      uuid: "GPU-b",
      index: 1,
      model: null,
      totalMiB: 24_576,
      freeMiB: 18_227,
      holders: [
        { is: "box", name: "amber-fox", part: "shared", running: true, counts: true },
        { is: "box", name: "lone-pine", part: "shared", running: true, counts: true },
        { is: "box", name: "calm-reef", part: "shared", running: true, counts: true },
        { is: "other-install", guest: "CT 9311", part: "shared", running: true, counts: false },
      ],
      counted: 3,
    },
    { uuid: "GPU-c", index: 2, model: null, totalMiB: 24_576, freeMiB: 3_480, holders: [], counted: 0 },
  ],
};

test("071 unit 15 gate: a lowered limit names the boxes over it, which keep running, in the cards list and the doctor's words", () => {
  const view = settingsCards(IN_USE, "proxmox-lxc", [{ id: "bxamber", name: "amber-fox", backend: "proxmox-lxc" }, { id: "bxelsewhere", name: "lone-pine", backend: "docker" }]);
  assert.equal(view.is, "read");
  if (view.is !== "read") return;
  assert.deepEqual(view.cards.map((card) => card.over), [0, 1, 0]);
  assert.equal(view.cards[1]!.overWords, "Card 1 has 3 of this install's boxes running, 1 over the limit of 2: amber-fox, lone-pine and calm-reef. They keep running; no new box goes on card 1 until it has room.", "another install's guest is on the card but not in this install's count");
  assert.deepEqual(view.cards[1]!.holders.map((holder) => holder.box), ["bxamber", null, null, null], "a box links to its page only where it is this backend's");
  assert.equal(view.cards[2]!.outsideMiB, 21_096, "memory in use on a card that holds no box of bb-box's is outside bb-box's boxes");
  assert.equal(view.cards[0]!.outsideMiB, null, "where bb-box's boxes are on the card, one reading cannot split it");
  assert.equal(overLimitWords({ index: 0, counted: 2, holders: [] }, 1, "every-install"), "Card 0 has 2 boxes, 1 over the limit of 1. They keep running; no new box goes on card 0 until it has room.");
  const unlimited = settingsCards({ ...IN_USE, limit: null }, "proxmox-lxc", []);
  assert.deepEqual(unlimited.is === "read" ? unlimited.cards.map((card) => [card.over, card.overWords]) : null, [[0, null], [0, null], [0, null]], "no limit: no card is over it");
  assert.deepEqual(view.wholeKept, [{ box: null, name: "quiet-elm" }]);
});

test("071 unit 15: a limit typed lower than a card's boxes names them before Save, and a limit raised or unchanged says nothing", () => {
  const view = settingsCards({ ...IN_USE, limit: 4 }, "proxmox-lxc", []);
  assert.ok(view.is === "read");
  if (view.is !== "read") return;
  assert.equal(loweredLimitWords(view.cards, 2, 4, "this-install-running"), "With 2, card 1 has 3 of this install's boxes running, 1 over: amber-fox, lone-pine and calm-reef. They keep running; no new box goes on a card over the limit until it has room.");
  assert.equal(loweredLimitWords(view.cards, 3, 4, "this-install-running"), null, "no card is over 3");
  assert.equal(loweredLimitWords(view.cards, 4, 4, "this-install-running"), null);
  assert.equal(loweredLimitWords(view.cards, 0, 4, "this-install-running"), null, "0 is no limit");
  assert.equal(loweredLimitWords(view.cards, 1, null, "this-install-running")?.startsWith("With 1, card 1 has 3 of this install's boxes running, 2 over"), true, "from no limit, any limit is lower");
  assert.deepEqual([draftLimit("3"), draftLimit(" 2 "), draftLimit(""), draftLimit("x"), draftLimit(-1)], [3, 2, null, null, null]);
  assert.deepEqual([readAgo(1_000, 6_000), readAgo(0, 120_000)], ["5 s ago", "2 minutes ago"]);
});

test("071 unit 15: Whole cards shows its value with where it comes from, and off lists the boxes that keep their whole card", () => {
  assert.deepEqual(wholeCardsNow({ general: {} }, { fields: {} }, null), { on: false, fromInstall: true });
  assert.deepEqual(wholeCardsNow({ general: { wholeCards: true } }, { fields: { "whole-cards": false } }, null), { on: false, fromInstall: false });
  assert.deepEqual(wholeCardsNow({ general: {} }, { fields: {} }, true), { on: true, fromInstall: false }, "while a switch is being saved it shows what was asked");
  assert.equal(wholeKeptWords([{ name: "quiet-elm" }]), " quiet-elm keeps its card until changed or released.");
  assert.equal(wholeKeptWords([{ name: "quiet-elm" }, { name: "tidy-glade" }]), " quiet-elm and tidy-glade keep their cards until changed or released.");
  assert.equal(wholeKeptWords([]), "");
});

let counter = 0;

function identity(kind: string, gpu: GpuPart): BoxIdentity {
  counter++;
  return { boxId: `bxsettings${counter}`, threadId: "thr_settings", name: `settings-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 7), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

function withUserspace(bridge: ClaimsBridge): void {
  const record = JSON.stringify({ contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261105-090000-1a2b", built: "2026-11-05T09:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia: "580.142" });
  bridge.proxmox.guests.get(9000)!.config.description = `bb-box linux template (NVIDIA 580.142, no card), built 2026-11-05. See /usr/share/bb-box/template-release inside.\n${record}`;
}

test("071 unit 15 gate: Proxmox LXC's cards in use name each card's holders, and the doctor warns of a card over a lowered limit, stopping nothing", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const roomy = bridge.backend({ perGpu: 0 });
  const made = [];
  for (let index = 0; index < 4; index++) {
    made.push(await roomy.acquire(identity("linux", "shared"), null, hooks(), new AbortController().signal));
    bridge.pass();
  }
  const lowered = bridge.backend({ perGpu: 1 });
  const inUse = await lowered.cardsInUse();
  assert.equal(inUse.is, "read");
  if (inUse.is !== "read") return;
  assert.equal(inUse.limit, 1);
  assert.deepEqual(inUse.cards.map((card) => card.counted), [2, 2]);
  assert.deepEqual(inUse.cards.map((card) => card.holders.filter((holder) => holder.is === "box" && holder.part === "shared" && holder.running).length), [2, 2]);
  const doctor = await lowered.doctor();
  const over = doctor.checks.filter((check) => check.id.endsWith(".limit"));
  assert.equal(over.length, 2, JSON.stringify(doctor.checks.map((check) => check.id)));
  assert.ok(over.every((check) => check.status === "warn" && /has 2 of this install's boxes running, 1 over the limit of 1: .+ and .+\. They keep running; no new box goes on card \d until it has room\./.test(check.detail ?? "")), JSON.stringify(over));
  for (const guest of made) assert.equal(bridge.proxmox.guests.get(Number(guest.ref))?.status, "running", "a lower limit stops nothing that runs");
  const roomyDoctor = await roomy.doctor();
  assert.deepEqual(roomyDoctor.checks.filter((check) => check.id.endsWith(".limit")), [], "no limit: no warning");
});

test("071 unit 15 gate: turning whole cards off leaves a whole box as it is: its claim, its start on its card, and the list of boxes that keep their whole card", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const options: { wholeCards?: boolean } = { wholeCards: true };
  const backend = bridge.backend(options);
  const asked = identity("linux", "whole");
  const whole = await backend.acquire(asked, null, hooks(), new AbortController().signal);
  bridge.pass();
  assert.equal(whole.claim?.part, "whole");
  options.wholeCards = false;
  await assert.rejects(backend.acquire(identity("linux", "whole"), null, hooks(), new AbortController().signal), /Whole cards are off on this install/);
  const inUse = await backend.cardsInUse();
  assert.ok(inUse.is === "read");
  if (inUse.is !== "read") return;
  const view = settingsCards(inUse, "proxmox-lxc", []);
  assert.deepEqual(view.is === "read" ? view.wholeKept.map((box) => box.name) : null, [asked.name]);
  await backend.stop(whole);
  bridge.pass();
  const started = await backend.start(whole, new AbortController().signal);
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: CARD_A.uuid, part: "whole", generation: 1, answer: "granted" }, "it starts on its card, whole, with no new claim");
});
