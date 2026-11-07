import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { BoxPageState, Contract, MonitorReach, MonitorSnapshot } from "../src/plugin/contract.ts";
import type { BoxView } from "../src/plugin/views.ts";
import { forgetLive } from "../src/app/common.tsx";
import { forgetMonitorReadings } from "../src/app/monitor/use-snapshot.ts";
import { resizedNow } from "../src/app/resize.tsx";
import { rowLine, rowWords } from "../src/app/row-line.ts";
import { HOLDS_NO_CARD, USERSPACE_UPDATE_REFUSAL } from "../src/plugin/gpu-page.ts";

const BOX = "bxamberfox01";
const THREAD = "thr_ui";
const READ_AT = Date.UTC(2026, 10, 6, 16, 0, 0);
const MiB = 1024 * 1024;

function boxView(patch: Partial<BoxView> = {}): BoxView {
  return {
    id: BOX,
    name: "amber-fox",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Proxmox LXC on pve",
    nature: "virtual",
    form: "LXC",
    shared: false,
    role: "box",
    state: "ready",
    error: null,
    stopped: null,
    createdAt: READ_AT - 3_600_000,
    readyAt: READ_AT - 3_500_000,
    os: "linux",
    arch: "x86_64",
    gpu: true,
    gpuPart: "shared",
    claim: { card: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", part: "shared", generation: 1, answer: "granted" },
    requires: [],
    extras: [],
    docker: false,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "10.0.0.8",
    facts: [{ label: "GPU", value: "card 1, shared, NVIDIA RTX 4090, 24 GiB" }],
    timings: { total: 2000 },
    enrol: { state: "enrolled", hostId: "host_calm", error: null },
    enrols: true,
    canStopStart: true,
    size: "4 cores, 8 GiB memory",
    sizeNow: { cores: 4, memoryGiB: 8, diskGiB: null, words: "4 cores, 8 GiB memory" },
    ...patch,
  } as BoxView;
}

function snapshot(): MonitorSnapshot {
  return {
    timestamp: new Date(READ_AT).toISOString(),
    refreshIntervalMs: 5000,
    host: { hostname: "amber-fox", platform: "linux", release: "6.17", arch: "x64", uptimeSeconds: 3600 },
    cpu: { model: "AMD EPYC", cores: 4, speedMHz: 0, usagePercent: 10, perCoreUsagePercent: [], loadAverage: [0.2, 0.2, 0.2], stallPercent: null },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 2 * 1024 ** 3, freeBytes: 6 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 25, stallPercent: null },
    disk: { mount: "/", totalBytes: 32 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, freeBytes: 28 * 1024 ** 3, usagePercent: 12 },
    network: { interface: "eth0", rxBytesPerSecond: 0, txBytesPerSecond: 0, rxTotalBytes: 0, txTotalBytes: 0 },
    battery: null,
    sensors: null,
    tailscale: null,
    processes: { available: true, total: 2, running: 1, top: [{ pid: 3310, name: "python3", cpuPercent: 4, memoryPercent: 2, rssBytes: 80 * MiB }] },
    runtime: null,
    health: { status: "healthy", issues: [] },
    history: [],
    gpus: {
      cards: [{ index: 1, uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "NVIDIA RTX 4090", usagePercent: 40, memoryUsedBytes: 6 * 1024 ** 3, memoryTotalBytes: 24 * 1024 ** 3, temperatureC: 55, powerWatts: 80, powerLimitWatts: 450, shared: true, ownMemoryBytes: 2 * 1024 ** 3, ownProcesses: 1 }],
      processes: [{ pid: 3310, name: "python3", card: 1, memoryBytes: 2 * 1024 ** 3 }],
    },
  };
}

const read: MonitorReach = { is: "read", machineId: "host_amber", why: null };
const stoppedReach: MonitorReach = { is: "not-running", machineId: null, why: null };

function handlers(page: BoxPageState, reading: MonitorSnapshot = snapshot()): PluginRpcTestHandlers<Contract> {
  return {
    boxPage: () => page,
    "monitor.machine": () => reading,
    "monitor.history": () => null,
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true, historyFull: null }),
    resize: (input: { size?: { gpu?: string } }) => {
      const empty = { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: null };
      const gpu = input.size?.gpu;
      if (gpu === "none") {
        return {
          ...empty,
          plan: {
            parts: [],
            room: { ok: true, message: null },
            downSeconds: 15,
            gpu: {
              from: "shared",
              to: "none",
              way: "restart",
              stopped: false,
              installs: null,
              words: "GPU: shared, card 1 → none · Restart. amber-fox restarts without card 1. Everything running in it stops.",
              fromIndex: 1,
              toIndex: null,
              refusal: null,
              others: [],
              changed: null,
            },
          },
        };
      }
      if (gpu === "whole") {
        return {
          ...empty,
          plan: {
            parts: [],
            room: { ok: true, message: null },
            downSeconds: null,
            gpu: {
              from: "shared",
              to: "whole",
              way: "no",
              stopped: false,
              installs: null,
              words: "No card is free for amber-fox alone. Release one of them, or keep the GPU shared.",
              fromIndex: 1,
              toIndex: null,
              refusal: "No card is free for amber-fox alone. Release one of them, or keep the GPU shared.",
              others: [{ box: "bxlonepine01", name: "lone-pine", stopped: false }],
              changed: null,
            },
          },
        };
      }
      return empty;
    },
  } as unknown as PluginRpcTestHandlers<Contract>;
}

function page(box: BoxView, monitor: MonitorReach = read, gpuMates: BoxPageState["gpuMates"] = []): BoxPageState {
  return { box, threadId: THREAD, owner: "thread", thread: { id: THREAD, title: "Train the model", running: true }, threads: [], monitor, deviceFailed: null, ended: null, gpuMates };
}

globalThis.IntersectionObserver = class {
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  observe() {
    this.#callback([{ isIntersecting: true, intersectionRect: { width: 900, height: 400 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
} as unknown as typeof IntersectionObserver;
window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
Element.prototype.scrollIntoView = () => {};

const app = await loadPluginApp(() => import("../app.tsx"));

afterEach(() => {
  cleanup();
  forgetLive();
  forgetMonitorReadings();
});

function open(state: BoxPageState, reading?: MonitorSnapshot) {
  const [panel] = app.navPanels;
  return renderSlot(panel!, { subPath: `box/${BOX}` }, { rpc: handlers(state, reading), pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "Train the model" }) } } });
}

test("071 unit 14: a stopped shared row says it holds no card while stopped", () => {
  expect(rowWords(rowLine(boxView({ state: "stopped" }), { now: READ_AT }))).toContain(HOLDS_NO_CARD);
  expect(rowWords(rowLine(boxView({ state: "stopped", form: "Docker", backendLabel: "Docker on devpc" }), { now: READ_AT }))).not.toContain(HOLDS_NO_CARD);
});

test("071 unit 14: the box page shows the GPU fact and card, and Change opens Resize at the GPU", async () => {
  const slot = open(page(boxView(), read, [{ id: "bxlonepine01", name: "lone-pine", state: "ready" }]));
  const facts = await slot.findByRole("region", { name: "Facts" });
  expect(within(facts).getByText("4 cores, 8 GiB memory")).toBeTruthy();
  expect(within(facts).getByText("Card 1, shared")).toBeTruthy();
  expect(within(facts).getByText("with lone-pine")).toBeTruthy();
  expect(within(facts).getByText("GPU").closest("div")?.textContent).not.toMatch(/cores/);
  const card = slot.getByRole("region", { name: "GPU card" });
  expect(card.textContent).toContain("Card 1 · NVIDIA RTX 4090 · 24 GiB");
  expect(card.textContent).toContain("lone-pine");
  await waitFor(() => expect(card.textContent).toContain("python3"));
  expect(card.textContent).toContain("PID");
  expect(card.textContent).not.toMatch(/Index/);
  expect(card.textContent).toContain("share its memory");
  expect(slot.getByRole("heading", { level: 1 }).textContent).toContain("GPU");
  expect(slot.getByRole("heading", { level: 1 }).textContent).not.toContain("Whole GPU");
  fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.getAttribute("data-resize-at")).toBe("gpu");
  expect(dialog.textContent).toContain("Resize amber-fox");
  expect(dialog.textContent).not.toContain("Changing the GPU comes later.");
  expect(within(dialog).getByRole("combobox", { name: "GPU" }).textContent).toBe("Shared");
  expect(dialog.textContent).toContain("This box's backend does not change its GPU.");
  const gpu = dialog.querySelector("[data-gpu-section]");
  await waitFor(() => expect(document.activeElement).toBe(gpu));
});

test("071 unit 13: Resize keeps the button enabled when the size snaps to the box's preset", async () => {
  let gpuNone = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const empty = { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: null };
  const rpc = handlers(
    page(
      boxView({
        resizing: { cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "restart", share: "live", move: "restart" } },
      }),
    ),
  );
  rpc.resize = async (input: { size?: { gpu?: string } }) => {
    if (input.size?.gpu === "none") {
      gpuNone += 1;
      return {
        ...empty,
        presets: [{ name: "small", cores: 4, memoryGiB: 8, diskGiB: null, words: "4 cores, 8 GiB memory" }],
        plan: {
          parts: [],
          room: { ok: true, message: null },
          downSeconds: 15,
          gpu: {
            from: "shared",
            to: "none",
            way: "restart",
            stopped: false,
            installs: null,
            words: "GPU: shared, card 1 → none · Restart. amber-fox restarts without card 1. Everything running in it stops.",
            fromIndex: 1,
            toIndex: null,
            refusal: null,
            others: [],
            changed: null,
          },
        },
      };
    }
    await gate;
    return empty;
  };
  const [panel] = app.navPanels;
  const slot = renderSlot(panel!, { subPath: `box/${BOX}` }, { rpc, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "Train the model" }) } } });
  const card = await slot.findByRole("region", { name: "GPU card" });
  fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "GPU" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "None" }));
  await waitFor(() => expect(dialog.textContent).toContain("Everything running in it stops"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(within(dialog).getByRole("button", { name: "Resize…" }).hasAttribute("disabled")).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(gpuNone).toBe(1);
  release();
});

test("071 unit 13: a resize that changes the GPU names it when it has finished", async () => {
  const sizeNow = { cores: 2, memoryGiB: 4, diskGiB: 16, words: "2 cores, 4 GiB memory, 16 GiB disk" };
  const box = boxView({
    sizeNow,
    size: "2 cores, 4 GiB memory, 16 GiB disk",
    resizing: { cores: "live", memory: "live", disk: "live", shrinks: true, gpu: { add: "restart", share: "live", move: "restart" } },
  });
  const empty = { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: null };
  const presets = [{ name: "small", cores: 2, memoryGiB: 4, diskGiB: 16, words: sizeNow.words }];
  const gpu = {
    from: "shared" as const,
    to: "none" as const,
    way: "restart" as const,
    stopped: false,
    installs: null,
    words: "GPU: shared, card 1 → none · Restart. amber-fox restarts without card 1. Everything running in it stops.",
    fromIndex: 1,
    toIndex: null,
    refusal: null,
    others: [],
    changed: null,
  };
  const rpc = handlers(page(box));
  rpc.resize = (input: { size?: { gpu?: string }; check?: boolean; restart?: boolean }) => {
    const plan = input.size?.gpu === "none" ? { parts: [], room: { ok: true, message: null }, downSeconds: 15, gpu } : null;
    if (input.check || !input.restart) return { ...empty, from: sizeNow, to: sizeNow, presets, plan };
    return {
      ...empty,
      from: sizeNow,
      to: sizeNow,
      presets,
      plan,
      changed: true,
      box: { ...box, gpu: false, gpuPart: "none", lastResize: { to: sizeNow, at: Date.now(), state: "done", restart: true, ms: 1000, error: null } },
    };
  };
  const [panel] = app.navPanels;
  const slot = renderSlot(panel!, { subPath: `box/${BOX}` }, { rpc, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "Train the model" }) } } });
  const card = await slot.findByRole("region", { name: "GPU card" });
  fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "GPU" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "None" }));
  await waitFor(() => expect(dialog.textContent).toContain("Everything running in it stops"));
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize…" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "Restart and resize" }));
  expect(await within(dialog).findByText("It has 2 cores · 4 GiB · 16 GiB disk and no GPU now, after a restart.")).toBeTruthy();
  expect(resizedNow("2 cores · 4 GiB · 16 GiB disk", { ...gpu, from: "none", to: "shared", fromIndex: null, toIndex: 1, words: "GPU: none → shared, card 1 · Restart." }, true, true)).toBe(
    "It has 2 cores · 4 GiB · 16 GiB disk and a shared GPU on card 1 now, after a restart.",
  );
});

test("071 unit 13: Resize shows the plan's words", async () => {
  const slot = open(
    page(
      boxView({
        resizing: { cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "restart", share: "live", move: "restart" } },
      }),
    ),
    snapshot(),
  );
  const card = await slot.findByRole("region", { name: "GPU card" });
  await waitFor(() => expect(card.textContent).toContain("python3"));
  fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "GPU" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "None" }));
  await waitFor(() => expect(dialog.textContent).toContain("amber-fox restarts without card 1. Everything running in it stops: python3 (3310) has the GPU open."));
  expect(dialog.textContent).toContain("shared, card 1 → none");
  expect(dialog.textContent).toContain("Restart");
});

test("071 unit 13: Resize shows the GPU change, names a program that has it open, and refuses a card that is not free", async () => {
  const refusal = "No card is free for amber-fox alone. Release one of them, or keep the GPU shared.";
  const slot = open(
    page(
      boxView({
        resizing: { cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "restart", share: "live", move: "restart" } },
      }),
    ),
    snapshot(),
  );
  const card = await slot.findByRole("region", { name: "GPU card" });
  await waitFor(() => expect(card.textContent).toContain("python3"));
  fireEvent.click(within(card).getByRole("button", { name: "Change…" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "GPU" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "None" }));
  await waitFor(() => expect(dialog.textContent).toContain("python3 (3310) has the GPU open"));
  expect(dialog.textContent).toContain("shared, card 1 → none");
  expect(dialog.textContent).toContain("Restart");
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize…" }));
  expect(await within(dialog).findByText("Restart amber-fox to change its GPU?")).toBeTruthy();
  expect(dialog.textContent).toContain("python3 (3310) has the GPU open");
  fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
  fireEvent.keyDown(within(dialog).getByRole("combobox", { name: "GPU" }), { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: "Whole card" }));
  await waitFor(() => expect(dialog.textContent).toContain(refusal));
  expect(within(dialog).getByRole("link", { name: "lone-pine" })).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Resize" }).hasAttribute("disabled")).toBe(true);
});

test("071 unit 14: a box with no GPU keeps its facts when Docker reports every card", async () => {
  const reach = "On devpc, every box with Docker in it can open every card, with a GPU or without. None and Whole card are what bb-box places, not what a box can reach.";
  const slot = open(page(boxView({ gpu: false, gpuPart: "none", claim: null, form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "Cards", value: reach }] })));
  const facts = await slot.findByRole("region", { name: "Facts" });
  expect(facts.textContent).not.toContain("Cards");
  expect(facts.textContent).not.toContain("every box");
  expect(slot.queryByRole("region", { name: "GPU card" })).toBeNull();
  expect(facts.textContent).toContain("4 cores, 8 GiB memory");
});

test("071 unit 14: a GPU box puts the every-card sentence on the card, and an unmatched reading is unavailable", async () => {
  const reach = "On devpc, every box with Docker in it can open every card, with a GPU or without. None and Whole card are what bb-box places, not what a box can reach.";
  const slot = open(page(boxView({ form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "GPU", value: "card 1, shared, NVIDIA RTX 4090, 24 GiB" }, { label: "Cards", value: reach }] })));
  const facts = await slot.findByRole("region", { name: "Facts" });
  expect(facts.textContent).not.toContain("every box");
  const card = await slot.findByRole("region", { name: "GPU card" });
  expect(card.textContent).toContain(reach);
  cleanup();
  forgetLive();
  const other = open(page(boxView({ claim: { card: "ffffffff-ffff-ffff-ffff-ffffffffffff", part: "shared", generation: 1, answer: "granted" } })));
  const missed = await other.findByRole("region", { name: "GPU card" });
  await waitFor(() => expect(missed.textContent).toContain("Unavailable."));
  expect(missed.textContent).not.toContain("python3");
});

test("071 unit 14: a stopped shared box's words, and each notice", async () => {
  const stopped = open(page(boxView({ state: "stopped", address: null }), stoppedReach));
  const facts = await stopped.findByRole("region", { name: "Facts" });
  expect(within(facts).getByText("Card 1 when it starts, if it has room")).toBeTruthy();
  const card = stopped.getByRole("region", { name: "GPU card" });
  expect(card.textContent).toContain("holds no place on the card");
  expect(card.textContent).toContain("None now.");
  expect(card.textContent).toContain("Not read while it is stopped.");
  expect(card.textContent).not.toContain("Card use");
  expect(card.textContent).not.toContain("Used");
  cleanup();

  const wrong = "card 1, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed no card, not its card aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const userspace = "card 1, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142";
  open(page(boxView({ facts: [{ label: "GPU", value: wrong }] })));
  expect((await screen.findByRole("region", { name: "On the wrong card" })).textContent).toMatch(/does not stop it/);
  cleanup();
  forgetLive();

  const mismatch = open(page(boxView({ facts: [{ label: "GPU", value: userspace }] })));
  const notice = await mismatch.findByRole("region", { name: "NVIDIA's userspace does not match the host's driver" });
  expect(notice.textContent).toMatch(/570\.86/);
  fireEvent.click(within(notice).getByRole("button", { name: "Update NVIDIA's userspace…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain("over 570.86");
  fireEvent.click(within(dialog).getByRole("button", { name: "Update and restart" }));
  expect(dialog.textContent).toContain(USERSPACE_UPDATE_REFUSAL);
});

test("071 unit 14: the wrong-card notice uses the reading the GPU card loads", async () => {
  const GiB = 1024 ** 3;
  const listed = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const claim = "11111111-1111-1111-1111-111111111111";
  const reading = snapshot();
  reading.gpus = {
    cards: [{ index: 1, uuid: listed, name: "NVIDIA RTX 4090", usagePercent: 10, memoryUsedBytes: GiB, memoryTotalBytes: 24 * GiB, temperatureC: 40, powerWatts: 30, powerLimitWatts: 450, shared: true, ownMemoryBytes: 0, ownProcesses: 0 }],
    processes: [],
  };
  const fact = `card 0, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed card GPU-${listed}, not its card GPU-${claim}`;
  const slot = open(page(boxView({ form: "Docker", backendLabel: "Docker on devpc", docker: true, claim: { card: claim, part: "shared", generation: 1, answer: "granted" }, facts: [{ label: "GPU", value: fact }] })), reading);
  const notice = await slot.findByRole("region", { name: "On the wrong card" });
  await waitFor(() => expect(notice.textContent).toContain("listed card 1, not its card 0"));
  expect(notice.textContent).not.toContain("a card");
});

test("071 unit 14: the activity tiles and the GPU card agree on this box's use of a card", async () => {
  const GiB = 1024 ** 3;
  const reading = snapshot();
  reading.gpus = {
    cards: [
      { index: 0, uuid: "11111111-1111-1111-1111-111111111111", name: "NVIDIA RTX 4090", usagePercent: 90, memoryUsedBytes: 20 * GiB, memoryTotalBytes: 24 * GiB, temperatureC: 70, powerWatts: 200, powerLimitWatts: 450, shared: true, ownMemoryBytes: 0, ownProcesses: 0 },
      { index: 1, uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", name: "NVIDIA RTX 4090", usagePercent: 40, memoryUsedBytes: 6 * GiB, memoryTotalBytes: 24 * GiB, temperatureC: 55, powerWatts: 80, powerLimitWatts: 450, shared: true, ownMemoryBytes: 2 * GiB, ownProcesses: 1 },
    ],
    processes: [{ pid: 3310, name: "python3", card: 1, memoryBytes: 2 * GiB }],
  };
  const docker = open(page(boxView({ form: "Docker", backendLabel: "Docker on devpc", docker: true })), reading);
  const other = await docker.findByRole("region", { name: "GPU 0, whole card" });
  const held = await docker.findByRole("region", { name: "GPU 1, whole card" });
  const card = await docker.findByRole("region", { name: "GPU card" });
  expect(other.textContent).toContain("This box: 0 B of 20 GiB");
  expect(other.textContent).not.toContain("18 GiB");
  expect(held.textContent).toContain("This box: 2 GiB of 6 GiB");
  expect(card.textContent).toContain("This box");
  expect(card.textContent).toContain("2 GiB");
  expect(card.textContent).not.toContain("This box: 18 GiB");
  expect(card.textContent).not.toContain("20 GiB");
  cleanup();
  forgetLive();

  const lxc = open(page(boxView()), reading);
  const otherCard = await lxc.findByRole("region", { name: "GPU 0, whole card" });
  expect(otherCard.textContent).not.toContain("This box:");
  expect(otherCard.textContent).toContain("20 of 24 GiB");
  expect((await lxc.findByRole("region", { name: "GPU 1, whole card" })).textContent).toContain("This box: 2 GiB of 6 GiB");
  expect((await lxc.findByRole("region", { name: "GPU card" })).textContent).toContain("2 GiB");
});
