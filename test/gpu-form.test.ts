import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { CardRoom, GpuResizing, GpuRoom } from "../src/backends/types.ts";
import { GPU_LINE_CLASS, GPU_MENU_LABELS, gpuFormLine, gpuMenuParts, gpuMenuShows, gpuRowReason, gpuWaysLine, withGpuPrograms, type GpuFormOffer } from "../src/app/gpu-choice.ts";
import { boxResizing } from "../src/core/gpu.ts";

const NOW = 1_700_000_000_000;

function card(patch: Partial<CardRoom> & Pick<CardRoom, "index" | "boxes">): CardRoom {
  return { whole: false, freeMiB: 18_227, totalMiB: 24_576, freeForWhole: false, ...patch };
}

function room(cards: readonly CardRoom[], patch: Partial<GpuRoom> = {}): GpuRoom {
  return { readings: [], fullUntil: null, parts: ["none", "shared", "whole"], host: "pve-1", at: NOW - 20_000, neededMiB: 512, cards, ...patch };
}

function offer(patch: Partial<GpuFormOffer> = {}): GpuFormOffer {
  return {
    host: "pve-1",
    label: "Proxmox on pve-1",
    gpuParts: ["none", "shared", "whole"],
    gpuRoom: room([card({ index: 0, boxes: 0, wholeBy: "quiet-elm" }), card({ index: 1, boxes: 2 })]),
    unread: false,
    reachesEveryCard: false,
    canAddGpu: true,
    ...patch,
  };
}

const kind = { os: "linux", arch: "x86_64", desktop: false, windowing: "x11" as const };

test("071 unit 13: a CPU desktop takes the GPU rows from the GPU desktop on its backend", () => {
  const sizes = { cores: "live" as const, memory: "live" as const, disk: "live" as const, shrinks: true };
  const gpu = { add: "restart" as const, share: "live" as const, move: "restart" as const };
  const backend = {
    resizing(kind: string) {
      if (kind === "linux-desktop-cpu") return sizes;
      if (kind === "linux-desktop") return { ...sizes, gpu };
      return null;
    },
  };
  assert.deepEqual(boxResizing(backend, "linux-desktop-cpu")?.gpu, gpu);
  assert.equal(boxResizing({ resizing: () => sizes }, "linux-desktop-cpu")?.gpu, undefined);
  assert.equal(boxResizing({ resizing: (kind) => (kind === "linux-desktop" ? { ...sizes, gpu: { add: "no" as const, share: "live" as const, move: "no" as const } } : sizes) }, "linux-desktop-cpu")?.gpu, undefined);
  assert.equal(gpuFormLine([offer({ canAddGpu: false, addKnown: false })], "none", NOW).words, "No GPU.");
});

test("071 unit 13: the GPU line keeps one height", () => {
  assert.equal(GPU_LINE_CLASS, "h-[3lh] overflow-hidden text-xs leading-snug @sm:h-[2lh]");
});

test("071 unit 13: guests outside this install do not fill a card", () => {
  const crowded = offer({
    gpuRoom: room(
      [card({ index: 0, boxes: 5, own: 0, freeMiB: 97_026, totalMiB: 97_887 }), card({ index: 1, boxes: 3, own: 0, freeMiB: 97_056, totalMiB: 97_887 })],
      { limit: 2, parts: ["none", "shared"], wholeOff: true },
    ),
  });
  const shared = gpuFormLine([crowded], "shared", NOW);
  assert.equal(shared.state, "shared");
  assert.equal(shared.blocked, false);
  assert.match(shared.words, /^Card 1 on pve-1, shared with 3 boxes; 94\.8 GiB free when read, 20 s ago\. Boxes on a card share its memory\.$/);
  const ours = offer({ gpuRoom: room([card({ index: 0, boxes: 5, own: 2 })], { limit: 2, parts: ["none", "shared"] }) });
  assert.equal(gpuFormLine([ours], "shared", NOW).state, "refused");
  assert.equal(gpuRowReason(ours, "shared"), "Card 0 is full");
  const counted = offer({ gpuRoom: room([card({ index: 0, boxes: 2 })], { limit: 2, parts: ["none", "shared"] }) });
  assert.equal(gpuFormLine([counted], "shared", NOW).state, "refused");
  assert.equal(gpuRowReason(counted, "shared"), "Card 0 is full");
});

test("071 unit 13: the GPU line keeps one height, and each state says what the note says", () => {
  assert.deepEqual(GPU_MENU_LABELS, { none: "None", shared: "Shared", whole: "Whole card" });
  const held = offer();
  assert.equal(gpuMenuShows(kind, [held]), true);
  assert.deepEqual(gpuMenuParts([held]), ["none", "shared", "whole"]);
  assert.equal(gpuMenuShows({ ...kind, arch: "arm64" }, [held]), false);
  assert.equal(gpuMenuShows({ ...kind, desktop: true, windowing: "wayland" }, [held]), false);
  assert.equal(gpuMenuShows(kind, [offer({ gpuParts: ["none"], gpuRoom: room([]) })]), false);

  const none = gpuFormLine([held], "none", NOW);
  assert.equal(none.state, "none");
  assert.equal(none.blocked, false);
  assert.equal(none.words, "No GPU. You can add one later with Resize.");

  const shared = gpuFormLine([held], "shared", NOW);
  assert.equal(shared.state, "shared");
  assert.equal(shared.words, "Card 1 on pve-1, shared with 2 boxes; 17.8 GiB free when read, 20 s ago. Boxes on a card share its memory.");

  const refused = gpuFormLine([held], "whole", NOW);
  assert.equal(refused.state, "refused");
  assert.equal(refused.blocked, true);
  assert.equal(refused.words, "pve-1 has no free card now: see below.");
  assert.equal(gpuRowReason(held, "whole"), "Card 0 is quiet-elm's; card 1 has 2 boxes");
  assert.equal(gpuRowReason(held, "none"), null);
  assert.equal(gpuRowReason(held, "shared"), null);

  const free = offer({ gpuRoom: room([card({ index: 0, boxes: 0, freeMiB: 24_576, totalMiB: 24_576, freeForWhole: true })]) });
  const whole = gpuFormLine([free], "whole", NOW);
  assert.equal(whole.state, "whole");
  assert.equal(whole.words, "Card 0 on pve-1, to itself: bb-box places no other box on it.");
  const outside = offer({ gpuRoom: room([card({ index: 0, boxes: 0, freeMiB: 3_486, totalMiB: 24_576, freeForWhole: true })]) });
  assert.equal(gpuFormLine([outside], "whole", NOW).words, "Card 0 on pve-1, to itself. 20.6 GiB of it is in use outside bb-box's boxes.");

  const reading = gpuFormLine([offer({ gpuRoom: null, unread: true })], "shared", NOW);
  assert.equal(reading.state, "reading");
  assert.equal(reading.blocked, true);
  assert.equal(reading.words, "Reading the cards on pve-1…");
  assert.equal(gpuRowReason(offer({ gpuRoom: null, unread: true }), "shared"), "Reading its cards…");
  assert.equal(gpuFormLine([offer({ gpuRoom: null, unread: false, gpuParts: ["none", "shared"] })], "shared", NOW).state, "refused");

  const docker = offer({ reachesEveryCard: true, canAddGpu: false, label: "Docker on the host" });
  assert.match(gpuFormLine([docker], "none", NOW).words, /^No GPU, and none can be added later on Docker on the host\. Boxes with Docker in them can still open every card\.$/);
  assert.match(gpuFormLine([offer({ reachesEveryCard: true })], "none", NOW).words, /You can add one later with Resize\. Boxes with Docker in them can still open every card\.$/);
  const reached = offer({ reachesEveryCard: true, gpuRoom: room([card({ index: 0, boxes: 0, freeMiB: 24_576, totalMiB: 24_576, freeForWhole: true })]) });
  assert.match(gpuFormLine([reached], "whole", NOW).words, /to itself: bb-box places no other box on it\. Boxes with Docker in them can still open every card\.$/);

  const second = offer({ host: "other", label: "Other", gpuRoom: room([], { host: "other", withheld: "No card is free." }) });
  const both = gpuFormLine([held, second], "whole", NOW);
  assert.equal(both.words, "No provider has a free card now: see each below.");
  assert.deepEqual([...gpuMenuParts([offer({ gpuRoom: room([], { wholeOff: true }), gpuParts: ["none", "shared", "whole"] })])], ["none", "shared"]);
});

test("071 unit 13: Resize names the way, and a move confirmation names the programs that have the GPU open", () => {
  const proxmox: GpuResizing = { add: "restart", share: "live", move: "restart" };
  assert.match(gpuWaysLine(proxmox, "LXC"), /switch at once/);
  assert.match(gpuWaysLine(proxmox, "LXC"), /Adding, removing or moving a card restarts the box/);
  const docker: GpuResizing = { add: "no", share: "live", move: "no" };
  assert.match(gpuWaysLine(docker, "Docker"), /cannot be added, removed or moved/);
  assert.match(gpuWaysLine(docker, "Docker"), /every box with Docker in it can open every card/);
  const words = "amber-fox restarts without card 1. Everything running in it stops.";
  assert.equal(withGpuPrograms(words, ": python3 (3310) has the GPU open"), "amber-fox restarts without card 1. Everything running in it stops: python3 (3310) has the GPU open.");
  assert.equal(withGpuPrograms("Everything running in amber-fox stops.", ": python3 (3310) has the GPU open"), "Everything running in amber-fox stops: python3 (3310) has the GPU open.");
});

test("071 unit 13: None is a GPU part only when an offer lists it, unless a CPU desktop stands beside it", () => {
  const shared = offer({ gpuParts: ["shared"], gpuRoom: room([card({ index: 0, boxes: 0 })], { parts: ["shared"] }) });
  const proxmox = offer({ gpuParts: ["shared", "whole"], gpuRoom: room([card({ index: 0, boxes: 0, freeForWhole: true })], { parts: ["shared", "whole"] }) });
  assert.deepEqual(gpuMenuParts([shared]), ["shared"]);
  assert.deepEqual(gpuMenuParts([shared], true), ["none", "shared"]);
  assert.deepEqual(gpuMenuParts([proxmox]), ["shared", "whole"]);
  assert.deepEqual(gpuMenuParts([proxmox], true), ["none", "shared", "whole"]);
});

test("071 unit 13: a ready spare of this GPU does not fill its card, and None does not wait on a reading", () => {
  const full = offer({
    spare: true,
    gpuRoom: room([card({ index: 0, boxes: 2, own: 2 })], { limit: 2, parts: ["none", "shared"] }),
  });
  const shared = gpuFormLine([full], "shared", NOW);
  assert.equal(shared.state, "shared");
  assert.equal(shared.blocked, false);
  assert.equal(gpuRowReason(full, "shared"), null);
  const other = gpuFormLine([{ ...full, spare: false }], "shared", NOW);
  assert.equal(other.state, "refused");
  const unread = offer({ unread: true, gpuRoom: null });
  assert.equal(gpuFormLine([unread], "none", NOW).state, "none");
  assert.equal(gpuFormLine([unread], "none", NOW).blocked, false);
  const failed = offer({ failed: true, gpuRoom: null, unread: false });
  assert.equal(gpuFormLine([failed], "none", NOW).state, "none");
  const again = gpuFormLine([failed], "shared", NOW);
  assert.equal(again.state, "failed");
  assert.equal(again.blocked, true);
  assert.equal(again.words, "The cards could not be read.");
});

test("071 unit 13: the GPU form adds no doc comments, and the acquire helpers sit inside registerRpc", () => {
  const gpu = readFileSync(new URL("../src/app/gpu-choice.ts", import.meta.url), "utf8");
  const form = readFileSync(new URL("../src/app/new-box.tsx", import.meta.url), "utf8");
  const rpc = readFileSync(new URL("../src/plugin/rpc.ts", import.meta.url), "utf8");
  const contract = readFileSync(new URL("../src/plugin/contract.ts", import.meta.url), "utf8");
  assert.equal(gpu.includes("The line under the GPU menu keeps this height"), false);
  assert.equal(form.includes("The GPU the person last chose"), false);
  assert.equal(form.includes("A fresh reading of the kind's cards"), false);
  assert.equal(rpc.includes("The form's size, with its GPU taken off"), false);
  assert.equal(contract.includes("A GPU change the Resize dialog shows"), false);
  assert.equal(contract.includes("A fresh reading of one kind's cards"), false);
  assert.match(rpc, /\n {2}function sizeAndGpu/);
  assert.match(rpc, /\n {2}function gpuChangeView/);
});
