import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { BoxPageState, Contract, MonitorReach, MonitorSnapshot } from "../src/plugin/contract.ts";
import type { BoxView } from "../src/plugin/views.ts";
import { forgetLive } from "../src/app/common.tsx";
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

function handlers(page: BoxPageState): PluginRpcTestHandlers<Contract> {
  return {
    boxPage: () => page,
    "monitor.machine": () => snapshot(),
    "monitor.history": () => null,
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true, historyFull: null }),
    resize: () => ({ box: null, from: null, to: null, plan: null, changed: false, machine: false, needsRestart: false, presets: [], largest: null, error: null }),
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

const app = await loadPluginApp(() => import("../app.tsx"));

afterEach(() => {
  cleanup();
  forgetLive();
});

function open(state: BoxPageState) {
  const [panel] = app.navPanels;
  return renderSlot(panel!, { subPath: `box/${BOX}` }, { rpc: handlers(state), pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "Train the model" }) } } });
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
  expect(dialog.textContent).toContain("Changing the GPU comes later.");
  const gpu = dialog.querySelector("[data-gpu-section]");
  await waitFor(() => expect(document.activeElement).toBe(gpu));
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
