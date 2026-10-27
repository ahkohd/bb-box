import assert from "node:assert/strict";
import { test } from "node:test";
import type { VideoStep } from "../src/core/device.ts";
import {
  CHIP_BUDGETS,
  ENCODER_FULL_WORDS,
  EncoderLedgers,
  NO_DECISION,
  RISE_AFTER_MS,
  UNMEASURED_BUDGET,
  VM_STARTING_WORDS,
  VM_START_WARNING_MS,
  allot,
  frameCost,
  heldAfter,
  loweredWords,
  roomWords,
  stepPixels,
  streamRate,
  type Decision,
  type LedgerStream,
  type VideoWant,
} from "../src/core/encoder-ledger.ts";

const IPHONE = { width: 1206, height: 2622 };
const IPAD = { width: 2064, height: 2752 };

function stream(box: string, wants: readonly VideoWant[], options: { readonly fps?: number; readonly controlled?: boolean; readonly pixels?: { width: number; height: number } } = {}): LedgerStream {
  return { box, name: box, pixels: options.pixels ?? IPHONE, wants, fps: options.fps ?? 60, controlled: options.controlled ?? false };
}

const viewer = (step: VideoStep): VideoWant => ({ for: "viewer", step });
const recording: VideoWant = { for: "recording", step: "two-thirds" };
const wait: VideoWant = { for: "wait", step: "third" };

test("a frame's cost follows 064's table, against a full iPhone frame", () => {
  assert.equal(frameCost(stepPixels(IPHONE, "full")), 1);
  assert.ok(Math.abs(frameCost(stepPixels(IPHONE, "two-thirds")) - 0.57) < 0.01);
  assert.ok(Math.abs(frameCost(stepPixels(IPHONE, "half")) - 0.33) < 0.01);
  assert.ok(Math.abs(frameCost(stepPixels(IPHONE, "third")) - 0.18) < 0.01);
  assert.ok(Math.abs(frameCost(stepPixels(IPAD, "full")) - 1.75) < 0.01);
  assert.ok(frameCost(10) > 0 && frameCost(10) < 0.01);
});

test("a stream counts its frames a second over the last 10 s, with a floor of 20", () => {
  assert.equal(streamRate({ pixels: IPHONE, fps: 60 }, "full"), 60);
  assert.equal(streamRate({ pixels: IPHONE, fps: 2 }, "full"), 20);
  assert.equal(streamRate({ pixels: IPHONE, fps: 0 }, "full"), 20);
});

test("the budgets by chip, and a quarter kept free", () => {
  assert.equal(CHIP_BUDGETS["Apple M4 Max"], 320);
  assert.equal(CHIP_BUDGETS["Apple M5 Max"], 375);
  assert.equal(UNMEASURED_BUDGET, 320);
  assert.equal(allot([], 320).cap, 240);
  assert.equal(allot([], 375).cap, 281.25);
});

test("streams within the cap keep what they want", () => {
  const streams = [stream("a", [viewer("full")]), stream("b", [viewer("half")]), stream("c", [wait])];
  const allotment = allot(streams, 320);
  assert.equal(allotment.beyond, false);
  assert.deepEqual([...allotment.streams.values()].map((each) => each.step), ["full", "half", "third"]);
});

test("over the cap, passive viewers step down first; the person in control keeps full size and a recording keeps its step", () => {
  const viewers = Array.from({ length: 8 }, (_, at) => stream(`viewer-${at}`, [viewer("two-thirds")]));
  const streams = [stream("held", [viewer("full")], { controlled: true }), stream("recorded", [recording]), ...viewers];
  const allotment = allot(streams, 320);
  assert.ok(allotment.used <= allotment.cap, `${allotment.used} within ${allotment.cap}`);
  assert.equal(allotment.streams.get("held")!.step, "full");
  assert.equal(allotment.streams.get("held")!.room, "control");
  assert.equal(allotment.streams.get("recorded")!.step, "two-thirds");
  const steps = viewers.map((each) => allotment.streams.get(each.box)!.step);
  assert.ok(steps.every((step) => step === "half" || step === "third"), steps.join(", "));
  assert.ok(steps.includes("third"));
});

test("a recording steps down before the person in control, and never below a half", () => {
  const streams = [stream("held", [viewer("full")], { controlled: true }), ...Array.from({ length: 6 }, (_, at) => stream(`recorded-${at}`, [recording]))];
  const allotment = allot(streams, 200);
  assert.equal(allotment.streams.get("held")!.step, "full");
  for (let at = 0; at < 6; at++) assert.equal(allotment.streams.get(`recorded-${at}`)!.step, "half");
  assert.equal(allotment.beyond, true);
});

test("at most two streams are at full size, the person in control first, then those already at full", () => {
  const three = [stream("a", [viewer("full")]), stream("b", [viewer("full")]), stream("c", [viewer("full")], { fps: 20 })];
  const plain = allot(three, 1000);
  assert.deepEqual(["a", "b", "c"].map((box) => plain.streams.get(box)!.step), ["full", "full", "two-thirds"]);
  const kept = allot(three, 1000, new Set(["c"]));
  assert.deepEqual(["a", "b", "c"].map((box) => kept.streams.get(box)!.step), ["full", "two-thirds", "full"]);
  const controlled = allot([...three, stream("d", [viewer("full")], { controlled: true })], 1000, new Set(["b", "c"]));
  assert.equal(controlled.streams.get("d")!.step, "full");
  assert.equal([...controlled.streams.values()].filter((each) => each.step === "full").length, 2);
});

test("beyond the cap every stream is at its floor, and the allotment says so", () => {
  const streams = Array.from({ length: 25 }, (_, at) => stream(`busy-${at}`, [viewer("half")]));
  const allotment = allot(streams, 320);
  assert.equal(allotment.beyond, true);
  assert.ok([...allotment.streams.values()].every((each) => each.step === "third"));
});

test("a stream nothing wants is not counted", () => {
  const allotment = allot([stream("idle", [])], 320);
  assert.equal(allotment.streams.size, 0);
  assert.equal(allotment.used, 0);
});

test("a lowered stream rises only after 10 s of room; a lower step and the person in control take effect at once", () => {
  const lowered = { step: "half" as VideoStep, wanted: "full" as VideoStep, risingSince: null };
  const room = { box: "a", wanted: "full" as VideoStep, step: "full" as VideoStep, room: "viewer" as const, rate: 60 };
  const first = heldAfter(lowered, room, 1_000);
  assert.equal(first.step, "half");
  assert.equal(first.risingSince, 1_000);
  assert.equal(heldAfter(first, room, 1_000 + RISE_AFTER_MS - 1).step, "half");
  assert.equal(heldAfter(first, room, 1_000 + RISE_AFTER_MS).step, "full");
  assert.equal(heldAfter(lowered, { ...room, step: "third" }, 2_000).step, "third");
  assert.equal(heldAfter(lowered, { ...room, room: "control" }, 2_000).step, "full");
  const unlowered = { step: "half" as VideoStep, wanted: "half" as VideoStep, risingSince: null };
  assert.equal(heldAfter(unlowered, room, 2_000).step, "full");
});

test("the words name the boxes using the room, and the room in use", () => {
  assert.equal(loweredWords(["ios-2", "ios-5", "ios-7"]), "Shown at a lower resolution: this Mac's video encoder is busy with 3 other devices (box ios-2, box ios-5, box ios-7).");
  assert.equal(loweredWords(["a", "b", "c", "d", "e", "f"]), "Shown at a lower resolution: this Mac's video encoder is busy with 6 other devices (box a, box b, box c, box d and 2 more).");
  assert.equal(roomWords(240, 320), "On this Mac: 4 of about 5 full-size streams' room in use.");
  assert.equal(roomWords(10, 375), "On this Mac: under 1 of about 6 full-size streams' room in use.");
});

function ledgers(options: { on?: () => boolean; controlled?: (box: string) => boolean; probe?: (mac: string) => Promise<number | null> } = {}) {
  let now = 1_000_000;
  const sent = new Map<string, Decision>();
  const probes: string[] = [];
  const ledger = new EncoderLedgers({
    on: options.on ?? (() => true),
    controlled: options.controlled ?? (() => false),
    send: (box, decision) => sent.set(box, decision),
    probe: async (mac) => {
      probes.push(mac);
      return options.probe ? options.probe(mac) : null;
    },
    log: () => {},
    logError: () => {},
    now: () => now,
  });
  return { ledger, sent, probes, advance: (ms: number) => (now += ms) };
}

const MAC = { mac: "tart\u0000mac-1", label: "mac-1", chip: "Apple M4 Max" };

test("the ledger caps the passive viewers on one Mac and says which boxes use the room", () => {
  let controlled = "ios-0";
  const { ledger, sent } = ledgers({ controlled: (box) => box === controlled });
  ledger.report({ id: "ios-0", name: "ios-0" }, MAC, { pixels: IPHONE, wants: [viewer("full")], fps: 60 });
  for (let at = 1; at < 10; at++) ledger.report({ id: `ios-${at}`, name: `ios-${at}` }, MAC, { pixels: IPHONE, wants: [viewer("two-thirds")], fps: 60 });
  assert.equal(sent.get("ios-0")?.cap ?? null, null);
  assert.equal(sent.get("ios-0")?.words ?? null, null);
  const capped = [...Array(9).keys()].map((at) => sent.get(`ios-${at + 1}`)!);
  assert.ok(capped.every((decision) => decision.cap === "half" || decision.cap === "third"));
  assert.match(capped[0]!.words!, /^Shown at a lower resolution: this Mac's video encoder is busy with 9 other devices \(box ios-0, box ios-2, box ios-3, box ios-4 and 5 more\)\.$/);
  assert.match(ledger.roomWords("ios-1")!, /^On this Mac: 4 of about 5 full-size streams' room in use\.$/);
  assert.ok(ledger.load(MAC.mac) <= 240);
  controlled = "ios-1";
  ledger.controlChanged("ios-1");
  assert.equal(sent.get("ios-1")?.cap ?? null, null);
  assert.equal(sent.get("ios-0")?.cap, "half");
});

test("a dedicated box and a host's slots on one Mac share one ledger; the pool's Mac has its own", () => {
  const { ledger } = ledgers();
  const POOL = { mac: "ssh-pool\u0000studio", label: "studio", chip: "Apple M5 Max" };
  ledger.report({ id: "dedicated", name: "dedicated" }, MAC, { pixels: IPHONE, wants: [viewer("full")], fps: 60 });
  ledger.report({ id: "slot", name: "slot" }, MAC, { pixels: IPHONE, wants: [viewer("full")], fps: 60 });
  ledger.report({ id: "pool", name: "pool" }, POOL, { pixels: IPHONE, wants: [viewer("full")], fps: 60 });
  assert.equal(ledger.load(MAC.mac), 120);
  assert.equal(ledger.load(POOL.mac), 60);
  assert.equal(ledger.budget(POOL.mac).budget, 375);
  ledger.forget("slot");
  assert.equal(ledger.load(MAC.mac), 60);
});

test("a VM starting on the Mac warns its viewers for 30 s", async () => {
  const { ledger, sent, advance } = ledgers();
  ledger.report({ id: "ios-1", name: "ios-1" }, MAC, { pixels: IPHONE, wants: [viewer("half")], fps: 60 });
  ledger.vmStarting(MAC.mac);
  assert.equal(sent.get("ios-1")?.words, VM_STARTING_WORDS);
  advance(VM_START_WARNING_MS);
  ledger.report({ id: "ios-1", name: "ios-1" }, MAC, { pixels: IPHONE, wants: [viewer("half")], fps: 60 });
  assert.equal(sent.get("ios-1")?.words, null);
  ledger.dispose();
});

test("beyond the cap, every viewer is told that frames come more slowly", () => {
  const { ledger, sent } = ledgers();
  for (let at = 0; at < 25; at++) ledger.report({ id: `busy-${at}`, name: `busy-${at}` }, MAC, { pixels: IPHONE, wants: [viewer("third")], fps: 60 });
  assert.ok(sent.get("busy-0")?.words?.includes(ENCODER_FULL_WORDS));
});

test("off, the ledger sends no cap and no words", () => {
  let on = true;
  const { ledger, sent } = ledgers({ on: () => on });
  for (let at = 0; at < 10; at++) ledger.report({ id: `ios-${at}`, name: `ios-${at}` }, MAC, { pixels: IPHONE, wants: [viewer("full")], fps: 60 });
  assert.ok([...sent.values()].some((decision) => decision.cap !== null));
  on = false;
  ledger.refresh();
  assert.ok([...sent.values()].every((decision) => decision.cap === NO_DECISION.cap && decision.words === null));
  assert.equal(ledger.roomWords("ios-0"), null);
});

test("a chip not in the table is probed only while its Mac's ledger is empty, once", async () => {
  const UNKNOWN = { mac: "tart\u0000mac-2", label: "mac-2", chip: "Apple M9 Ultra" };
  const { ledger, probes } = ledgers({ probe: async () => 640 });
  ledger.report({ id: "busy", name: "busy" }, UNKNOWN, { pixels: IPHONE, wants: [viewer("half")], fps: 60 });
  assert.deepEqual(probes, []);
  assert.equal(ledger.budget(UNKNOWN.mac).from, "assumed");
  assert.equal(ledger.checks()[0]!.status, "warn");
  ledger.report({ id: "busy", name: "busy" }, UNKNOWN, { pixels: IPHONE, wants: [], fps: 0 });
  assert.deepEqual(probes, [UNKNOWN.mac]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ledger.budget(UNKNOWN.mac), { budget: 640, from: "probe" });
  ledger.report({ id: "busy", name: "busy" }, UNKNOWN, { pixels: IPHONE, wants: [], fps: 0 });
  assert.deepEqual(probes, [UNKNOWN.mac]);
  const known = ledgers();
  known.ledger.report({ id: "idle", name: "idle" }, MAC, { pixels: IPHONE, wants: [], fps: 0 });
  assert.deepEqual(known.probes, []);
});

test("the doctor names each Mac's room and the boxes shown lower", () => {
  const { ledger } = ledgers();
  for (let at = 0; at < 10; at++) ledger.report({ id: `ios-${at}`, name: `ios-${at}` }, MAC, { pixels: IPHONE, wants: [viewer("two-thirds")], fps: 60 });
  const [check] = ledger.checks();
  assert.equal(check!.id, "encoder.mac-1");
  assert.equal(check!.status, "ok");
  assert.match(check!.detail, /^On this Mac: 4 of about 5 full-size streams' room in use\. 10 streams; an Apple M4 Max, about 320 full-size iPhone frames a second\. Shown at a lower resolution: /);
});
