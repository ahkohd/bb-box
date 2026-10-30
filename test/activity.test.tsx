import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { BoxHistoryView, BoxPageState, Contract, HistoryRange, HistoryStep, MetricPoint, MonitorReach, MonitorSnapshot } from "../src/plugin/contract.ts";
import { HISTORY_RANGES } from "../src/monitor/history-view.ts";
import type { BoxView } from "../src/plugin/views.ts";
import { forgetLive } from "../src/app/common.tsx";
import { forgetChosenRanges } from "../src/app/activity.tsx";
import { upWords } from "../src/app/monitor/status.tsx";
import { sidebarTitle } from "../src/app/desktop.tsx";

const BOX_ID = "bxcalmotter001";
const THREAD = "thr_ui";
const READ_AT = Date.UTC(2026, 9, 30, 16, 6, 0);

function points(count: number, make: (index: number) => Partial<MetricPoint> = () => ({})): MetricPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    timestamp: READ_AT - (count - 1 - index) * 5000,
    cpuPercent: 20 + (index % 5),
    memoryPercent: 40,
    networkRxBytesPerSecond: 1024,
    networkTxBytesPerSecond: 512,
    ...make(index),
  }));
}

function snapshot(patch: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    timestamp: new Date(READ_AT).toISOString(),
    refreshIntervalMs: 5000,
    host: { hostname: "calm-otter", platform: "linux", release: "6.17", arch: "x64", uptimeSeconds: 3600 },
    cpu: { model: "AMD EPYC", cores: 4, speedMHz: 0, usagePercent: 31, perCoreUsagePercent: [], loadAverage: [1.24, 1, 0.8], stallPercent: null },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 4.64 * 1024 ** 3, freeBytes: 3 * 1024 ** 3, availableBytes: 3.36 * 1024 ** 3, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 58, stallPercent: null },
    disk: { mount: "/", totalBytes: 32 * 1024 ** 3, usedBytes: 13 * 1024 ** 3, freeBytes: 19 * 1024 ** 3, usagePercent: 40 },
    network: { interface: "eth0", rxBytesPerSecond: 820 * 1024, txBytesPerSecond: 96 * 1024, rxTotalBytes: 1, txTotalBytes: 1 },
    battery: null,
    sensors: null,
    tailscale: null,
    processes: { available: true, total: 3, running: 1, top: [{ pid: 4242, name: "stress-ng-cpu", cpuPercent: 199.5, memoryPercent: 1, rssBytes: 12 * 1024 ** 2 }, { pid: 77, name: "node", cpuPercent: 3.1, memoryPercent: 2, rssBytes: 180 * 1024 ** 2 }] },
    runtime: null,
    health: { status: "healthy", issues: [] },
    history: points(72),
    ...patch,
  };
}

function boxView(patch: Partial<BoxView> = {}): BoxView {
  return {
    id: BOX_ID,
    name: "calm-otter",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Docker on devpc",
    nature: "virtual",
    form: "Docker",
    shared: false,
    role: "box",
    state: "ready",
    error: null,
    stopped: null,
    createdAt: READ_AT - 3_600_000,
    readyAt: READ_AT - 3_590_000,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: [],
    docker: false,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "10.0.0.31",
    facts: [],
    timings: {},
    enrol: { state: "enrolled", hostId: "host_calm", error: null },
    enrols: true,
    canStopStart: true,
    size: null,
    ...patch,
  } as BoxView;
}

let machines = 0;

function read(): MonitorReach {
  machines++;
  return { is: "read", machineId: `host_calm_${machines}`, why: null };
}

function historyView(range: HistoryRange, patch: Partial<BoxHistoryView> = {}, make: (index: number) => Partial<HistoryStep> = () => ({})): BoxHistoryView {
  const { stepMs, steps } = HISTORY_RANGES[range];
  const to = Math.ceil(READ_AT / stepMs) * stepMs;
  const from = to - steps * stepMs;
  return {
    range,
    stepMs,
    from,
    to,
    steps: Array.from({ length: steps }, (_, index) => ({ at: from + index * stepMs, covered: stepMs / 1000, cpu: 30, cpuBusiest: range === "1h" ? null : 33, memory: 50, memoryHighest: 55, disk: 20, down: 1024, up: 512, host: null, high: 0, partial: false, ...make(index) })),
    gaps: [],
    stops: [],
    kept: true,
    monitor: true,
    full: null,
    slot: null,
    newest: READ_AT,
    now: READ_AT,
    ...patch,
  };
}

function handlers(state: { page: () => BoxPageState; reading: () => MonitorSnapshot; history?: (range: HistoryRange) => BoxHistoryView | null }): PluginRpcTestHandlers<Contract> {
  return {
    boxPage: () => state.page(),
    "monitor.history": ({ range }: { range: HistoryRange }) => (state.history ?? ((asked: HistoryRange) => historyView(asked)))(range),
    "monitor.machine": () => state.reading(),
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true, historyFull: null }),
    "monitor.machines": () => ({ machines: [] }),
    "monitor.alerts": () => ({ enabled: false, notifications: true, cursor: 0, active: [], recent: [] }),
  } as unknown as PluginRpcTestHandlers<Contract>;
}

let reach: MonitorReach = read();

function page(box: BoxView, monitor: MonitorReach = reach): BoxPageState {
  return { box, threadId: THREAD, owner: "thread", thread: { id: THREAD, title: "Fix the sign-in flow", running: false }, threads: [], monitor, deviceFailed: null, ended: null };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let app: Awaited<ReturnType<typeof loadPluginApp>>;

beforeAll(async () => {
  globalThis.IntersectionObserver = class {
    readonly #callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.#callback = callback;
    }
    observe() {
      this.#callback([{ isIntersecting: true, intersectionRect: { width: 900, height: 600 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
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
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  app = await loadPluginApp(() => import("../app.tsx"));
});

beforeEach(() => {
  reach = read();
});

afterEach(() => {
  cleanup();
  forgetLive();
  forgetChosenRanges();
});

function open(rpc: PluginRpcTestHandlers<Contract>) {
  const [panel] = app.navPanels;
  return renderSlot(panel!, { subPath: `box/${BOX_ID}` }, { rpc, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "Fix the sign-in flow" }) } } });
}

async function activity(): Promise<HTMLElement> {
  return (await screen.findByRole("region", { name: "Activity" })) as HTMLElement;
}

test("Live: the Monitor's numbers now, in tiles with their pills, and the time of the last reading (069 section 4)", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const card = await activity();
  await waitFor(() => expect(within(card).getByText(/^Read at /)).toBeTruthy());
  const cpu = within(card).getByRole("region", { name: "CPU" });
  expect(cpu.textContent).toContain("31");
  expect(cpu.textContent).toContain("load 1.24");
  expect(cpu.textContent).toContain("4 cores");
  expect(within(card).getByRole("region", { name: "Memory" }).textContent).toMatch(/58%.*Normal|Normal.*58/);
  expect(within(card).getByRole("region", { name: "Disk" }).textContent).toContain("19GiB free");
  expect(within(card).getByRole("region", { name: "Network" }).textContent).toMatch(/820.*KB\/s down.*96 KB\/s up/);
});

test("the chart is one image named for what it shows, described by its numbers; the network chart by its own (G17)", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const card = await activity();
  const usage = await within(card).findByRole("application", { name: "CPU and memory, the last 6 min, every 5 s" });
  const described = document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent!;
  expect(described).toMatch(/^Over the last 6 min, every 5 s: CPU averaged 22%, highest 24% at .*; memory last 40%\./);
  const network = within(card).getByRole("application", { name: "Download and upload, the last 6 min, every 5 s" });
  expect(document.getElementById(network.getAttribute("aria-describedby")!)!.textContent).toMatch(/download averaged 1 KB\/s, highest 1 KB\/s at .*; upload averaged 512 B\/s/);
  expect(within(card).getByRole("button", { name: "CPU" }).getAttribute("aria-pressed")).toBe("true");
});

test("the read-out: arrow keys, Home, End, Page Up and Page Down move it, none scrolls the page, Escape clears it, and a polite live region says each point", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot({ history: points(72, (index) => ({ cpuPercent: index })) }) }));
  const card = await activity();
  const usage = await within(card).findByRole("application", { name: /^CPU and memory/ });
  const said = usage.querySelector("[data-read-out]")!;
  expect(said.getAttribute("aria-live")).toBe("polite");
  expect(said.textContent).toBe("");
  usage.focus();
  expect(fireEvent.keyDown(usage, { key: "End" })).toBe(false);
  expect(said.textContent).toMatch(/: CPU 71%, Memory 40%$/);
  expect(fireEvent.keyDown(usage, { key: "PageDown" })).toBe(false);
  expect(said.textContent).toMatch(/: CPU 61%/);
  expect(fireEvent.keyDown(usage, { key: "ArrowLeft" })).toBe(false);
  expect(said.textContent).toMatch(/: CPU 60%/);
  expect(fireEvent.keyDown(usage, { key: "Home" })).toBe(false);
  expect(said.textContent).toMatch(/: CPU 0%/);
  expect(fireEvent.keyDown(usage, { key: "PageUp" })).toBe(false);
  expect(said.textContent).toMatch(/: CPU 10%/);
  fireEvent.keyDown(usage, { key: "Escape" });
  expect(said.textContent).toBe("");
  expect(fireEvent.keyDown(usage, { key: "Tab" })).toBe(true);
});

test("a hidden line leaves the chart, and its legend chip says it is off", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const card = await activity();
  const memory = await within(card).findByRole("button", { name: "Memory" });
  fireEvent.click(memory);
  expect(memory.getAttribute("aria-pressed")).toBe("false");
  const usage = within(card).getByRole("application", { name: /^CPU and memory/ });
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).not.toContain("Memory");
});

test("top processes: name, PID, CPU and memory, a CPU of 100% or more in amber, and the note that CPU is per core (069 section 5)", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const table = await screen.findByRole("region", { name: "Top processes" });
  const rows = within(table).getAllByRole("row");
  expect(rows[0]!.textContent).toBe("ProcessPIDCPUMemory");
  expect(rows[1]!.textContent).toContain("stress-ng-cpu");
  expect(rows[1]!.textContent).toContain("4242");
  expect(within(rows[1]!).getByText("200%").className).toContain("text-warning-text");
  expect(table.textContent).toContain("CPU is per core, so a process using four cores shows 400%.");
});

test("G1: a shared slot's tiles are its own against its share, then the Mac's for all slots, which never make it busy", async () => {
  const slot = snapshot({
    cpu: { model: "Apple M4 Pro", cores: 12, speedMHz: 0, usagePercent: 90, perCoreUsagePercent: [], loadAverage: [13.1, 12, 11], stallPercent: null },
    memory: { totalBytes: 36 * 1024 ** 3, usedBytes: 30 * 1024 ** 3, freeBytes: 6 * 1024 ** 3, availableBytes: 6 * 1024 ** 3, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 83, stallPercent: null },
    own: { cpuCores: 2, memoryBytes: 1.5 * 1024 ** 3, processes: 9 },
    slot: { host: "mac-1", encoder: { usedPercent: 40, words: "2 of about 5 full-size streams' room in use." }, share: { slots: 3, cores: 4, memoryBytes: 12 * 1024 ** 3 } },
    history: points(72, () => ({ cpuPercent: 90, ownCpuCores: 2, ownMemoryBytes: 1.5 * 1024 ** 3 })),
  });
  open(handlers({ page: () => page(boxView({ shared: true, os: "macos", device: { platform: "ios", model: "iPhone 17", simulatorHost: false } } as Partial<BoxView>)), reading: () => slot }));
  const card = await activity();
  const own = await within(card).findByRole("region", { name: "This slot's CPU" });
  expect(own.textContent).toContain("50% of its share");
  expect(own.textContent).toContain("2.0 of its 4 cores, of mac-1's 12");
  expect(within(card).getByRole("region", { name: "This slot's memory" }).textContent).toMatch(/1\.5GiB.*of its 12 GiB · 13%/);
  const mac = within(card).getByRole("region", { name: "mac-1, all slots" });
  expect(mac.textContent).toContain("busy");
  expect(mac.textContent).toContain("90% CPU");
  expect(within(card).getByRole("region", { name: "mac-1's encoder" }).textContent).toContain("40% used");
  expect(card.querySelector("[data-slot-line]")!.textContent).toContain("never make this slot busy");
  expect(within(card).getByRole("button", { name: "mac-1's CPU, all slots" }).getAttribute("aria-pressed")).toBe("false");
  const usage = within(card).getByRole("application", { name: /^This slot's CPU and memory/ });
  expect(document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent).toMatch(/This slot's CPU averaged 50%/);
  expect(await screen.findByRole("region", { name: "This slot's processes" })).toBeTruthy();
});

test("the Monitor off: nothing read, and the way to turn it on in Monitor settings", async () => {
  open(handlers({ page: () => page(boxView(), { is: "off", machineId: null, why: "The Monitor is off." }), reading: () => snapshot() }));
  const card = await activity();
  expect(card.textContent).toContain("The Monitor is off, so bb-box reads nothing now.");
  expect(within(card).getByRole("link", { name: "Turn it on in Monitor settings" }).getAttribute("href")).toBe("/settings/plugins/bb-box#option/monitor");
  expect(screen.queryByRole("region", { name: "Top processes" })).toBeNull();
});

test("G16: Live keeps reading while the box stops; once the stop is confirmed the card says it is stopped and not read, and when", async () => {
  const state = { page: () => page(boxView({ state: "stopping" })), reading: () => snapshot() };
  const slot = open(handlers({ page: () => state.page(), reading: () => state.reading() }));
  const card = await activity();
  await waitFor(() => expect(within(card).getByRole("region", { name: "CPU" }).textContent).toContain("31"));
  const stoppedAt = Date.now() - 60_000;
  state.page = () => page(boxView({ state: "stopped", log: { lastStop: { at: stoppedAt, by: { is: "person" } } } } as Partial<BoxView>), { is: "not-running", machineId: null, why: "calm-otter is not running." });
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  await waitFor(() => expect(screen.getByRole("region", { name: "Activity" }).textContent).toMatch(/calm-otter is stopped, so bb-box is not reading it\. It stopped 1 min ago, today at /));
});

test("a box bb-box cannot read says the Monitor's words instead of a chart; one it read before keeps its history", async () => {
  const unreadable: MonitorReach = { is: "unreadable", machineId: null, why: "bb-box cannot read box calm-otter now: its BB machine is not answering BB, and it runs no shell bb-box can read without it." };
  open(handlers({ page: () => page(boxView({ os: "windows" }), unreadable), reading: () => snapshot(), history: (range) => historyView(range, { newest: null }, () => ({ cpu: null, cpuBusiest: null, memory: null, memoryHighest: null, disk: null, down: null, up: null, covered: 0 })) }));
  const card = await activity();
  expect(card.textContent).toContain("its BB machine is not answering BB");
  await waitFor(() => expect(card.querySelector("[data-history-none]")).toBeTruthy());
  expect(within(card).queryByRole("application")).toBeNull();
  cleanup();
  forgetLive();
  open(handlers({ page: () => page(boxView({ os: "windows" }), unreadable), reading: () => snapshot() }));
  expect(await within(await activity()).findByRole("application", { name: /^CPU and memory, the last 24 hours/ })).toBeTruthy();
});

test("a reading that fails after one worked keeps the last numbers under the Monitor's notice", async () => {
  let calls = 0;
  const slot = open(handlers({
    page: () => page(boxView()),
    reading: () => {
      calls++;
      if (calls > 1) throw new Error("Host is not connected");
      return snapshot();
    },
  }));
  const card = await activity();
  await waitFor(() => expect(within(card).getByRole("region", { name: "CPU" }).textContent).toContain("31"));
  void slot;
  await vi.waitFor(() => expect(card.querySelector("[data-stale]")?.textContent).toMatch(/^Can't reach calm-otter\. Showing data from /), { timeout: 15_000, interval: 200 });
  expect(within(card).getByRole("region", { name: "CPU" }).textContent).toContain("31");
}, 20_000);

test("a chart holds still while it has focus, so a screen reader does not hear its summary again at each reading, and goes on when focus leaves", async () => {
  let reading = 0;
  open(handlers({ page: () => page(boxView()), reading: () => snapshot({ timestamp: new Date(READ_AT + ++reading * 5000).toISOString(), history: points(72, (index) => ({ cpuPercent: (index + reading) % 50 })) }) }));
  const card = await activity();
  const usage = await within(card).findByRole("application", { name: /^CPU and memory/ });
  expect(usage.getAttribute("aria-roledescription")).toBe("chart");
  const summary = () => document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent;
  fireEvent.focus(usage);
  const held = summary();
  expect(card.textContent).toMatch(/Held at .* while you read it/);
  const readings = reading;
  await vi.waitFor(() => expect(reading).toBeGreaterThan(readings), { timeout: 12_000, interval: 250 });
  await pause(300);
  expect(summary()).toBe(held);
  fireEvent.blur(usage, { relatedTarget: document.body });
  await waitFor(() => expect(card.textContent).toMatch(/% used, the last 6 min/));
}, 20_000);

test("the Monitor's up label says whose clock it counts, so it does not contradict the page's up from the last start", () => {
  expect(upWords(snapshot(), false)).toBe("up 1h 0m");
  expect(upWords(snapshot(), true)).toBe("system up 1h 0m");
  expect(upWords(snapshot({ host: { hostname: "c", platform: "linux", release: "6", arch: "x64", uptimeSeconds: 3600, container: true } }), true)).toBe("host up 1h 0m");
  expect(upWords(snapshot({ slot: { host: "mac-1", encoder: null } }), true)).toBe("host up 1h 0m");
});

test("a thread with no title of its own is headed by the words BB's sidebar shows, its first prompt, else its ID", () => {
  expect(sidebarTitle({ title: "Fix the sign-in flow", titleFallback: "fix it" }, "thr_1")).toBe("Fix the sign-in flow");
  expect(sidebarTitle({ title: null, titleFallback: "CALL box_list" }, "thr_1")).toBe("CALL box_list");
  expect(sidebarTitle({ title: "  ", titleFallback: null }, "thr_1")).toBe("thr_1");
});

test("a slot far over its share says so in its words: the tile, the summary and the read-out keep 787% and 125%, and only the drawn line stops at the top", async () => {
  const share = { slots: 9, cores: 12 / 9, memoryBytes: 2 * 1024 ** 3 };
  const over = snapshot({
    cpu: { model: "Apple M4 Pro", cores: 12, speedMHz: 0, usagePercent: 100, perCoreUsagePercent: [], loadAverage: [20, 20, 20], stallPercent: null },
    own: { cpuCores: 10.49, memoryBytes: 2.5 * 1024 ** 3, processes: 12 },
    slot: { host: "mac-1", encoder: null, share },
    history: points(72, () => ({ cpuPercent: 100, ownCpuCores: 10.49, ownMemoryBytes: 2.5 * 1024 ** 3 })),
  });
  open(handlers({ page: () => page(boxView({ shared: true, os: "macos" } as Partial<BoxView>)), reading: () => over }));
  const card = await activity();
  expect((await within(card).findByRole("region", { name: "This slot's CPU" })).textContent).toContain("787% of its share");
  const usage = within(card).getByRole("application", { name: /^This slot's CPU and memory/ });
  expect(document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent).toMatch(/This slot's CPU averaged 787%, highest 787% at .*; This slot's memory last 125%/);
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).toMatch(/This slot's CPU 787%, This slot's memory 125%/);
  const drawn = Array.from(usage.querySelectorAll("svg path")).map((path) => path.getAttribute("d") ?? "");
  expect(drawn[0]).toMatch(/^M[\d.]+,2 /);
});

test("a slot whose own reading failed says its CPU is not read, not the Mac's", async () => {
  const unread = snapshot({ own: null, slot: { host: "mac-1", encoder: null, share: { slots: 3, cores: 4, memoryBytes: 12 * 1024 ** 3 } } });
  open(handlers({ page: () => page(boxView({ shared: true, os: "macos" } as Partial<BoxView>)), reading: () => unread }));
  const card = await activity();
  expect((await within(card).findByRole("region", { name: "This slot's CPU" })).textContent).toMatch(/–not read/);
  expect(within(card).getByRole("region", { name: "This slot's memory" }).textContent).toContain("not read");
});

test("the range is a radio group of Live, 1 h, 24 h and 7 d, on Live for a box being read; the arrow keys choose another (069 section 4)", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const card = await activity();
  const group = await within(card).findByRole("radiogroup", { name: "Time range" });
  const radios = within(group).getAllByRole("radio");
  expect(radios.map((radio) => radio.textContent)).toEqual(["Live", "1 h", "24 h", "7 d"]);
  expect(radios[0]!.getAttribute("aria-checked")).toBe("true");
  expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1, -1]);
  radios[0]!.focus();
  expect(fireEvent.keyDown(radios[0]!, { key: "ArrowRight" })).toBe(false);
  expect(within(group).getByRole("radio", { name: "1 h" }).getAttribute("aria-checked")).toBe("true");
  expect(document.activeElement?.textContent).toBe("1 h");
  expect(await within(card).findByRole("application", { name: "CPU and memory, the last hour, by the minute" })).toBeTruthy();
  expect(within(card).getByRole("region", { name: "CPU" }), "the tiles still say how it is now").toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(await within(card).findByRole("application", { name: "CPU and memory, the last 24 hours, by 10 minutes" })).toBeTruthy();
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(within(group).getByRole("radio", { name: "Live" }).getAttribute("aria-checked")).toBe("true");
  expect(await within(card).findByRole("application", { name: "CPU and memory, the last 6 min, every 5 s" })).toBeTruthy();
  expect(await screen.findByRole("region", { name: "Top processes" })).toBeTruthy();
});

test("a stopped box opens on 24 h with its stops shown, and Live says why it cannot be chosen (069 sections 4 and 7)", async () => {
  const stoppedAt = READ_AT - 3 * 3_600_000;
  const view = historyView("24h", { gaps: [{ from: Math.floor(stoppedAt / 600_000) * 600_000, to: Math.ceil(READ_AT / 600_000) * 600_000, kind: "stopped" }] }, (index) => (index >= 144 - 19 ? { cpu: null, cpuBusiest: null, memory: null, memoryHighest: null, disk: null, down: null, up: null, covered: 0 } : {}));
  open(handlers({ page: () => page(boxView({ state: "stopped" }), { is: "not-running", machineId: null, why: "calm-otter is not running." }), reading: () => snapshot(), history: () => view }));
  const card = await activity();
  const group = await within(card).findByRole("radiogroup", { name: "Time range" });
  expect(within(group).getByRole("radio", { name: "24 h" }).getAttribute("aria-checked")).toBe("true");
  const live = within(group).getByRole("radio", { name: "Live" });
  expect(live.getAttribute("aria-disabled")).toBe("true");
  expect(live.getAttribute("aria-description")).toBe("calm-otter is not running");
  fireEvent.click(live);
  expect(live.getAttribute("aria-checked")).toBe("false");
  const usage = await within(card).findByRole("application", { name: "CPU and memory, the last 24 hours, by 10 minutes" });
  expect(document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent).toMatch(/^Over the last 24 hours, by 10 minutes: CPU averaged 30%, highest 33% at .*; memory last 50%\. Stopped from (today|yesterday) at .*\.$/);
  expect(usage.querySelector('[data-band="Stopped"]')).toBeTruthy();
  expect(usage.textContent).toContain("Stopped");
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).toMatch(/: Stopped$/);
  expect(screen.queryByRole("region", { name: "Top processes" })).toBeNull();
});

test("over 24 h the light band is each step's busiest minute, said where it is 5 points or more above the mean, and a partly read step says so", async () => {
  const view = historyView("24h", {}, (index) => (index === 143 ? { cpuBusiest: 78 } : index === 142 ? { partial: true, covered: 120 } : {}));
  open(handlers({ page: () => page(boxView({ state: "stopped" }), { is: "not-running", machineId: null, why: null }), reading: () => snapshot(), history: () => view }));
  const card = await activity();
  const usage = await within(card).findByRole("application", { name: /^CPU and memory, the last 24 hours/ });
  expect(usage.querySelectorAll("[data-busiest]").length).toBeGreaterThan(0);
  expect(card.textContent).toContain("the light band is each step's busiest minute");
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  const said = usage.querySelector("[data-read-out]")!;
  expect(said.textContent).toMatch(/: CPU 30%, busiest minute 78%, Memory 50%$/);
  fireEvent.keyDown(usage, { key: "ArrowLeft" });
  expect(said.textContent).toMatch(/: CPU 30%, Memory 50%; partly read, 2 min of 10 minutes$/);
  expect(document.getElementById(usage.getAttribute("aria-describedby")!)!.textContent).toMatch(/highest 78% at /);
});

test("7 d is by the hour, with each midnight marked; a missing hour says why in the read-out", async () => {
  const view = historyView("7d", {}, (index) => (index === 167 ? { cpu: null, memory: null, disk: null, down: null, up: null, covered: 0 } : {}));
  const gaps = [{ from: view.steps[167]!.at, to: view.to, kind: "not-read" as const }];
  open(handlers({ page: () => page(boxView({ state: "stopped" }), { is: "not-running", machineId: null, why: null }), reading: () => snapshot(), history: () => ({ ...view, gaps }) }));
  const card = await activity();
  fireEvent.click(await within(card).findByRole("radio", { name: "7 d" }));
  const usage = await within(card).findByRole("application", { name: "CPU and memory, the last 7 days, by the hour" });
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).toMatch(/: Not read$/);
  const ticks = usage.parentElement!.querySelectorAll("[data-ticks] span");
  expect(ticks.length).toBeGreaterThanOrEqual(6);
});

test("with box history off, 1 h, 24 h and 7 d keep what was read before under the words that say so; a full history file says so too", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot(), history: (range) => historyView(range, { kept: false, full: "Box history's file is full, so bb-box stopped keeping box history." }) }));
  const card = await activity();
  fireEvent.click(await within(card).findByRole("radio", { name: "24 h" }));
  await waitFor(() => expect(card.querySelector("[data-history-off]")).toBeTruthy());
  expect(card.querySelector("[data-history-off]")!.textContent).toContain("Box history is off, so bb-box keeps nothing new. What it kept stays until it ages out.");
  expect(within(card).getByRole("link", { name: "Monitor settings" }).getAttribute("href")).toBe("/settings/plugins/bb-box#option/monitor");
  expect(card.querySelector("[data-history-full]")!.textContent).toContain("file is full");
  expect(within(card).getByRole("application", { name: /^CPU and memory, the last 24 hours/ })).toBeTruthy();
});

test("with the Monitor off, Live cannot be chosen and what was read before stays on show", async () => {
  open(handlers({ page: () => page(boxView(), { is: "off", machineId: null, why: "The Monitor is off." }), reading: () => snapshot(), history: (range) => historyView(range, { monitor: false }) }));
  const card = await activity();
  expect(card.textContent).toContain("The Monitor is off, so bb-box reads nothing now. What it read before stays.");
  expect(within(card).getByRole("radio", { name: "Live" }).getAttribute("aria-description")).toBe("The Monitor is off");
  expect(await within(card).findByRole("application", { name: /^CPU and memory, the last 24 hours/ })).toBeTruthy();
  expect(card.querySelector("[data-history-off]")).toBeNull();
});

test("a slot's history is its own CPU and memory against its share, with the Mac's CPU for all slots as a third line hidden at first, and no network of the Mac's", async () => {
  open(handlers({ page: () => page(boxView({ shared: true, os: "macos", state: "stopped" } as Partial<BoxView>), { is: "not-running", machineId: null, why: null }), reading: () => snapshot(), history: (range) => historyView(range, { slot: { host: "mac-1" } }, () => ({ host: 70, disk: null })) }));
  const card = await activity();
  const usage = await within(card).findByRole("application", { name: /^This slot's CPU and memory, the last 24 hours/ });
  expect(within(card).getByRole("button", { name: "mac-1's CPU, all slots" }).getAttribute("aria-pressed")).toBe("false");
  expect(within(card).queryByRole("button", { name: "Disk" })).toBeNull();
  expect(within(card).queryByRole("application", { name: /^Download and upload/ })).toBeNull();
  fireEvent.click(within(card).getByRole("button", { name: "mac-1's CPU, all slots" }));
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).toMatch(/This slot's CPU 30%.*mac-1's CPU, all slots 70%/);
});

test("disk starts hidden as it moves slowly, and its chip shows it", async () => {
  open(handlers({ page: () => page(boxView({ state: "stopped" }), { is: "not-running", machineId: null, why: null }), reading: () => snapshot() }));
  const card = await activity();
  const disk = await within(card).findByRole("button", { name: "Disk" });
  expect(disk.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(disk);
  const usage = within(card).getByRole("application", { name: /^CPU and memory, the last 24 hours/ });
  usage.focus();
  fireEvent.keyDown(usage, { key: "End" });
  expect(usage.querySelector("[data-read-out]")!.textContent).toMatch(/Disk 20%$/);
});

test("the range chosen for a box is kept while the session lasts, as BB may draw the page again when the window narrows", async () => {
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  fireEvent.click(await within(await activity()).findByRole("radio", { name: "7 d" }));
  expect(await within(await activity()).findByRole("application", { name: "CPU and memory, the last 7 days, by the hour" })).toBeTruthy();
  cleanup();
  forgetLive();
  open(handlers({ page: () => page(boxView()), reading: () => snapshot() }));
  const group = await within(await activity()).findByRole("radiogroup", { name: "Time range" });
  expect(within(group).getByRole("radio", { name: "7 d" }).getAttribute("aria-checked")).toBe("true");
});
