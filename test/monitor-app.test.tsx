import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalSidebarFooterDisclosureProps, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { BoxEntry, Contract, Machine, MachinesState, MonitorSnapshot, ThreadOnBox } from "../src/plugin/contract.ts";
import type { BoxView } from "../src/plugin/views.ts";
import { forgetMonitorReadings } from "../src/app/monitor/use-snapshot.ts";

const SERVER_HOST = "host_server";

function snapshot(patch: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    timestamp: "2026-10-28T12:00:00.000Z",
    refreshIntervalMs: 5000,
    host: { hostname: "box", platform: "linux", release: "6.17", arch: "x64", uptimeSeconds: 3600 },
    cpu: { model: "AMD EPYC 9654", cores: 2, speedMHz: 0, usagePercent: 20, perCoreUsagePercent: [], loadAverage: [0.5, 0.4, 0.3], stallPercent: null },
    memory: { totalBytes: 4 * 1024 ** 3, usedBytes: 1024 ** 3, freeBytes: 3 * 1024 ** 3, availableBytes: 3 * 1024 ** 3, cachedBytes: 0, buffersBytes: 0, swapTotalBytes: 0, swapUsedBytes: 0, usagePercent: 25, stallPercent: null },
    disk: { mount: "/", totalBytes: 16 * 1024 ** 3, usedBytes: 4 * 1024 ** 3, freeBytes: 12 * 1024 ** 3, usagePercent: 25 },
    network: { interface: "eth0", rxBytesPerSecond: 1024, txBytesPerSecond: 512, rxTotalBytes: 1, txTotalBytes: 1 },
    battery: null,
    sensors: null,
    tailscale: null,
    processes: { available: true, total: 2, running: 1, top: [{ pid: 77, name: "node", cpuPercent: 12.5, memoryPercent: 1, rssBytes: 120 * 1024 ** 2 }] },
    runtime: null,
    health: { status: "healthy", issues: [] },
    history: [],
    ...patch,
  };
}

const MACHINES: Machine[] = [
  { id: SERVER_HOST, name: "bb", connected: true, isServer: true, isBox: false, boxId: null },
  { id: "host_build", name: "build-server", connected: true, isServer: false, isBox: false, boxId: null },
  { id: "host_lxc", name: "glad-coral", connected: true, isServer: false, isBox: true, boxId: "bx_lxc" },
  { id: "host_slot", name: "keen-iris", connected: true, isServer: false, isBox: true, boxId: "bx_slot" },
  { id: "host_long", name: "a-shared-ios-box-with-a-very-long-name-1234", connected: true, isServer: false, isBox: true, boxId: "bx_long" },
  { id: "box:bx_desk", name: "quiet-moth", connected: true, isServer: false, isBox: true, boxId: "bx_desk" },
  { id: "box:bx_both", name: "brisk-wren", connected: true, isServer: false, isBox: true, boxId: "bx_both" },
  { id: "host_stopped", name: "deep-elm", connected: true, isServer: false, isBox: true, boxId: "bx_stopped" },
];

function boxView(patch: Partial<BoxView> & Pick<BoxView, "id" | "name">): BoxView {
  return {
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Fake host",
    nature: "virtual",
    form: "LXC",
    shared: false,
    role: "box",
    state: "ready",
    error: null,
    stopped: null,
    createdAt: Date.now() - 60_000,
    readyAt: Date.now() - 50_000,
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
    address: null,
    facts: [],
    timings: {},
    enrol: { state: "off", hostId: null, error: null },
    enrols: false,
    canStopStart: true,
    size: null,
    ...patch,
  } as BoxView;
}

const BOX_ENTRIES: BoxEntry[] = [
  { threadId: "thr_lxc", owner: "thread", box: boxView({ id: "bx_lxc", name: "glad-coral", terminal: true, enrol: { state: "enrolled", hostId: "host_lxc", error: null } }) },
  { threadId: "thr_slot", owner: "thread", box: boxView({ id: "bx_slot", name: "keen-iris", os: "macos", terminal: false, device: { platform: "ios", model: "iPhone 17", simulatorHost: false } }) },
  { threadId: "operator", owner: "yours", box: boxView({ id: "bx_desk", name: "quiet-moth", desktop: true, enrol: { state: "enrolled", hostId: "host_desk", error: null } }) },
  { threadId: "thr_both", owner: "thread", box: boxView({ id: "bx_both", name: "brisk-wren", desktop: true, device: { platform: "android", model: "Pixel 9", simulatorHost: false } }) },
  { threadId: "thr_stopped", owner: "thread", box: boxView({ id: "bx_stopped", name: "deep-elm", desktop: true, state: "stopped" }) },
];

const CHIPS_ON_QUIET_MOTH: ThreadOnBox[] = [
  { id: "thr_chip_idle", title: "Idle on the chips", running: false, activeAt: 5 },
  { id: "thr_chip_busy", title: "Busy on the chips", running: true, activeAt: 1 },
];

const MACHINES_STATE = {
  machines: [{ box: BOX_ENTRIES[2]!.box, threads: CHIPS_ON_QUIET_MOTH }],
  kinds: [],
  desktopOnDemand: null,
  desktopProblem: null,
  access: null,
} as unknown as MachinesState;

function handlers(readings: Record<string, MonitorSnapshot>): PluginRpcTestHandlers<Contract> {
  return {
    "machines.list": () => MACHINES_STATE,
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true, historyFull: null }),
    "monitor.machines": () => ({ machines: MACHINES }),
    allBoxes: () => BOX_ENTRIES,
    "monitor.server": () => readings.server ?? snapshot(),
    "monitor.machine": ({ machineId }: { machineId: string }) => readings[machineId] ?? snapshot(),
    "monitor.alerts": () => ({ enabled: false, notifications: true, cursor: 0, active: [], recent: [] }),
  } as unknown as PluginRpcTestHandlers<Contract>;
}

globalThis.IntersectionObserver = class {
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
  }
  observe() {
    this.#callback([{ isIntersecting: true, intersectionRect: { width: 300, height: 600 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
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
window.matchMedia = ((query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
const footer = (await loadPluginApp(() => import("../app.tsx"))).experimentalSidebarFooterItems.find((item) => item.id === "status") as { component: ComponentType<ExperimentalSidebarFooterDisclosureProps>; label: string; icon: string; id: string } | undefined;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("the footer keeps Beacon's entry: Machine status, with the server icon under a name of BB Box's own", async () => {
  expect(footer?.label).toBe("Machine status");
  expect(footer?.icon).toBe("bb-box-machine-status");
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.icons.map((icon) => icon.name)).toContain("bb-box-machine-status");
  expect(app.icons.map((icon) => icon.name)).not.toContain("Server");
  expect(app.appOverlays.some((overlay) => overlay.id === "monitor")).toBe(true);
});

test("a container box shows its own pressure where the host's load was, and no load", async () => {
  localStorage.setItem("bb-box:monitor:machine", "host_lxc");
  const lxc = snapshot({ host: { ...snapshot().host, container: true }, cpu: { ...snapshot().cpu, loadAverage: null, stallPercent: [0.17, 0.35, 0.1] } });
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({ host_lxc: lxc }), pluginId: "bb-box" });
  expect(await screen.findByText("pressure 0%")).toBeTruthy();
  expect(screen.queryByText(/^load /)).toBeNull();
  expect(screen.getByText("Healthy")).toBeTruthy();
});

test("a machine of its own keeps Beacon's load pill", async () => {
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({}), pluginId: "bb-box" });
  expect(await screen.findByText("load 0.50")).toBeTruthy();
});

test("a shared slot shows its host's load, the host it is on and the Mac's encoder room", async () => {
  localStorage.setItem("bb-box:monitor:machine", "host_slot");
  const slot = snapshot({ host: { ...snapshot().host, platform: "darwin", arch: "arm64" }, cpu: { ...snapshot().cpu, cores: 8, loadAverage: [3.1, 2.8, 2.5] }, slot: { host: "ios-host-1", encoder: { usedPercent: 40, words: "On this Mac: 2 of about 5 full-size streams' room in use." } } });
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({ host_slot: slot }), pluginId: "bb-box" });
  expect(await screen.findByText("host load 3.10")).toBeTruthy();
  expect(screen.getByText("on ios-host-1")).toBeTruthy();
  expect(screen.getByText("encoder 40%")).toBeTruthy();
});

test("long names and addresses truncate in the middle, keeping both ends, with the ellipsis right against the kept end", async () => {
  const widths = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.hasAttribute("data-middle-truncate") ? 120 : (this.textContent?.length ?? 0) * 8;
    return { width, height: 16, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 16, toJSON: () => ({}) } as DOMRect;
  });
  try {
    localStorage.setItem("bb-box:monitor:machine", "host_long");
    const tailscale = { dnsName: "a-shared-ios-box.example-net.ts.net", ipv4: "100.64.0.7", ipv6: "fd7a:115c:a1e0::403a:fd53", tags: [] };
    renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({ host_long: snapshot({ tailscale }) }), pluginId: "bb-box" });
    await screen.findByText("Tailscale");
    expect(screen.getByText("a-sha…name-1234")).toBeTruthy();
    expect(screen.getAllByText("a-shared-ios-box-with-a-very-long-name-1234").length).toBeGreaterThan(0);
    expect(screen.getByText("a-sha…et.ts.net")).toBeTruthy();
    expect(screen.getAllByText("100.64.0.7").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Show IPv6" }));
    expect(await screen.findByText("fd7a:…403a:fd53")).toBeTruthy();
  } finally {
    widths.mockRestore();
  }
});

test("with the Monitor off, BB's next load of BB Box's app has no machine status in the footer", async () => {
  localStorage.setItem("bb-box:monitor:on", "off");
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.experimentalSidebarFooterItems.some((item) => item.id === "status")).toBe(false);
  expect(app.appOverlays.some((overlay) => overlay.id === "monitor")).toBe(true);
});

test("the overlay remembers the server's switch for the next load", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const overlay = app.appOverlays.find((entry) => entry.id === "monitor")!;
  const off = { ...handlers({}), "monitor.state": () => ({ enabled: false, backgroundMonitoring: false, pressureNotifications: true, boxHistory: true, historyFull: null }) } as unknown as PluginRpcTestHandlers<Contract>;
  renderSlot(overlay, {} as never, { rpc: off, pluginId: "bb-box" });
  await waitFor(() => expect(localStorage.getItem("bb-box:monitor:on")).toBe("off"));
});

const PORT_TOP = 100;
const PORT_BOTTOM = 500;
const HEADER_BOTTOM = 136;
const CPU_TOP_UNSCROLLED = 300;
const CPU_HEIGHT = 120;

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 280, x: 0, y: top, width: 280, height: bottom - top, toJSON: () => ({}) } as DOMRect;
}

function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function scrolledHud() {
  const geometry = { scrollTop: 0 };
  const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.querySelector(":scope > [data-bb-box-monitor-shell]")) return rect(PORT_TOP, PORT_BOTTOM);
    if (this.hasAttribute("data-bb-box-monitor-header")) return rect(PORT_TOP, HEADER_BOTTOM);
    if (this.getAttribute("aria-label") === "CPU") {
      const top = CPU_TOP_UNSCROLLED - geometry.scrollTop;
      return rect(top, top + CPU_HEIGHT);
    }
    return rect(0, 0);
  });
  const viewportWidth = vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(1280);
  const viewportHeight = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({}), pluginId: "bb-box" });
  await screen.findByText("load 0.50");
  const port = document.querySelector("[data-bb-box-monitor-shell]")!.parentElement!;
  port.style.overflowY = "auto";
  const cpu = screen.getByRole("region", { name: "CPU" });
  const scrollTo = (scrollTop: number) => {
    geometry.scrollTop = scrollTop;
    fireEvent.scroll(port);
  };
  const restore = () => {
    rects.mockRestore();
    viewportWidth.mockRestore();
    viewportHeight.mockRestore();
  };
  return { cpu, scrollTo, restore };
}

function cpuTooltip() {
  return screen.queryAllByRole("tooltip", { hidden: true }).find((tooltip) => tooltip.textContent?.includes("AMD EPYC 9654")) ?? null;
}

function tooltipPlace(): { side: string | null; top: number | null } {
  const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
  const match = wrapper?.style.transform.match(/translate\(\s*[-\d.]+px,\s*([-\d.]+)px\)/);
  return { side: wrapper?.firstElementChild?.getAttribute("data-side") ?? null, top: match ? Number(match[1]) : null };
}

test("F-24: a scroll in the panel closes a section's tooltip at once, and it shows again only when the pointer rests after the scroll", async () => {
  const { cpu, scrollTo, restore } = await scrolledHud();
  try {
    fireEvent.pointerMove(cpu);
    await waitFor(() => expect(cpuTooltip()).toBeTruthy());

    scrollTo(40);
    expect(cpuTooltip()).toBeNull();

    for (const scrollTop of [80, 120, 160, 200]) {
      fireEvent.pointerMove(cpu);
      await pause(100);
      scrollTo(scrollTop);
      expect(cpuTooltip()).toBeNull();
    }

    await waitFor(() => expect(cpuTooltip()).toBeTruthy(), { timeout: 1500 });
    await waitFor(() => expect(tooltipPlace()).toEqual({ side: "right", top: HEADER_BOTTOM }));
  } finally {
    restore();
  }
});

test("F-24: a section's tooltip does not show while its section has scrolled out of the panel's visible area", async () => {
  const { cpu, scrollTo, restore } = await scrolledHud();
  try {
    scrollTo(CPU_TOP_UNSCROLLED + CPU_HEIGHT - HEADER_BOTTOM);
    await pause(200);
    fireEvent.pointerMove(cpu);
    await pause(700);
    expect(cpuTooltip()).toBeNull();

    scrollTo(0);
    await pause(200);
    fireEvent.pointerLeave(cpu);
    fireEvent.pointerMove(cpu);
    await waitFor(() => expect(cpuTooltip()).toBeTruthy());
    await waitFor(() => expect(tooltipPlace()).toEqual({ side: "right", top: CPU_TOP_UNSCROLLED }));
  } finally {
    restore();
  }
});

function openMonitor(machineId: string | null, threads: readonly PluginSidebarThread[] = []) {
  if (machineId) localStorage.setItem("bb-box:monitor:machine", machineId);
  return renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({}), pluginId: "bb-box", sidebarThreads: { threads } });
}

function header(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-bb-box-monitor-header]")!;
}

async function openButton(name = "Open"): Promise<HTMLElement> {
  return await waitFor(() => within(header()).getByRole("button", { name }));
}

async function openViews(name = "Open"): Promise<HTMLElement> {
  fireEvent.keyDown(await openButton(name), { key: "Enter" });
  return await screen.findByRole("menu");
}

function items(menu: HTMLElement): string[] {
  return within(menu).getAllByRole("menuitem").map((item) => `${item.textContent}${item.hasAttribute("data-disabled") ? " (disabled)" : ""}`);
}

const TO_BOXES_PAGE = (subPath: string) => ({ method: "toPluginPanel", path: "desktop", options: { subPath } });

test("a desktop box's Open menu offers its page first, then its desktop and terminal, each opening the box's view, whose way back is its page", async () => {
  const monitor = openMonitor("box:bx_desk");
  expect(items(await openViews())).toEqual(["Open details", "Open desktop", "Open terminal", "Open files"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open desktop" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_desk/desktop"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openViews();
  fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_desk/terminal"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openViews();
  fireEvent.click(screen.getByRole("menuitem", { name: "Open details" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_desk"));
  expect(localStorage.getItem("bb-box:monitor:machine")).toBe("box:bx_desk");
});

test("a device box's Open menu offers its Simulator alone when it has no terminal, and it opens the device view", async () => {
  const monitor = openMonitor("host_slot");
  expect(items(await openViews())).toEqual(["Open details", "Open simulator"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open simulator" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_slot/device"));
});

test("a box with a desktop and an Emulator offers both, then its terminal", async () => {
  const monitor = openMonitor("box:bx_both");
  expect(items(await openViews())).toEqual(["Open details", "Open emulator", "Open desktop", "Open terminal"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open emulator" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_both/device"));
});

test("the Open button's tooltip names the box, as a view of it when its menu lists no threads", async () => {
  openMonitor("box:bx_both");
  fireEvent.pointerMove(await openButton());
  await waitFor(() => expect(screen.queryAllByRole("tooltip", { hidden: true }).some((tooltip) => tooltip.textContent === "Open a view of brisk-wren")).toBe(true));
});

test("a stopped box's views are in the menu, disabled, each with the reason, and open nothing", async () => {
  const monitor = openMonitor("host_stopped");
  const menu = await openViews();
  expect(items(menu)).toEqual(["Open details", "Open desktopdeep-elm is stopped (disabled)", "Open terminaldeep-elm is stopped (disabled)", "Open filesdeep-elm is stopped (disabled)"]);
  fireEvent.click(within(menu).getAllByRole("menuitem")[1]!);
  expect(monitor.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel")).toEqual([]);
});

test("BB's server and a BB machine that is not a box, with no threads on them, get no Open button, and the header keeps its own", async () => {
  openMonitor(null, [sidebarThread("thr_on_box", "Runs on a box", { hostId: "host_lxc", status: "active" })]);
  await screen.findByText("load 0.50");
  await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("bb"));
  expect(within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
  cleanup();
  openMonitor("host_build", [sidebarThread("thr_archived", "Archived", { hostId: "host_build", archived: true })]);
  await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("build-server"));
  expect(within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
});

test("a box's icon says what it is: a phone for a device box, a monitor for a desktop box, the box icon otherwise, in the picker and the header", async () => {
  openMonitor("box:bx_desk");
  await waitFor(() => expect(within(header()).getByRole("img", { name: "Desktop box" })).toBeTruthy());
  fireEvent.click(await screen.findByRole("button", { name: "Machine" }));
  const list = await screen.findByRole("listbox", { name: "Machines" });
  const iconOf = (name: string) => within(within(list).getAllByRole("option").find((option) => option.textContent?.includes(name))!).getByRole("img").getAttribute("aria-label");
  await waitFor(() => expect(iconOf("keen-iris")).toBe("Device box"));
  expect([iconOf("brisk-wren"), iconOf("quiet-moth"), iconOf("glad-coral"), iconOf("build-server")]).toEqual(["Device box", "Desktop box", "Box", "Machine"]);
});

test("the picker lists names only, as options, and pressing one still switches the Monitor", async () => {
  openMonitor(null);
  fireEvent.click(await screen.findByRole("button", { name: "Machine" }));
  const list = await screen.findByRole("listbox", { name: "Machines" });
  expect(within(list).queryAllByRole("button", { name: /^Open/ })).toEqual([]);
  fireEvent.click(within(list).getAllByRole("option").find((option) => option.textContent?.includes("brisk-wren"))!);
  expect(localStorage.getItem("bb-box:monitor:machine")).toBe("box:bx_both");
  await openButton();
});

function tabbable(container: ParentNode): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("button, input, a[href], [tabindex]")).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
}

test("the keyboard reaches Open after the name; Enter or Space opens the menu, arrows move, Escape closes only the menu and focus returns to Open", async () => {
  openMonitor("box:bx_both");
  const open = await openButton();
  expect(tabbable(header()).map((element) => element.getAttribute("aria-label"))).toEqual(["Machine", "Open", "Reload machine status", "Hide machine status"]);
  open.focus();
  fireEvent.keyDown(open, { key: " " });
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Open details"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Open emulator"));
  const escapeBeyondMenu = vi.fn();
  window.addEventListener("keydown", escapeBeyondMenu);
  fireEvent.keyDown(menu, { key: "Escape" });
  window.removeEventListener("keydown", escapeBeyondMenu);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(open));
  expect(escapeBeyondMenu).not.toHaveBeenCalled();
  expect(header()).toBeTruthy();
});

test("Escape in the machine picker closes only the picker: the Monitor stays open and focus returns to the name", async () => {
  openMonitor(null);
  const trigger = await screen.findByRole("button", { name: "Machine" });
  fireEvent.click(trigger);
  const search = await screen.findByRole("textbox", { name: "Search machines" });
  const escapeBeyondPicker = vi.fn();
  window.addEventListener("keydown", escapeBeyondPicker);
  fireEvent.keyDown(search, { key: "Escape" });
  window.removeEventListener("keydown", escapeBeyondPicker);
  await waitFor(() => expect(screen.queryByRole("listbox", { name: "Machines" })).toBeNull());
  expect(escapeBeyondPicker).not.toHaveBeenCalled();
  expect(header()).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

test("the header has no settings gear: the Monitor's settings are on BB Box's settings page", async () => {
  openMonitor(null);
  await screen.findByText("load 0.50");
  expect(within(header()).queryByRole("link")).toBeNull();
  expect(within(header()).queryByRole("link", { name: "Machine status settings" })).toBeNull();
  expect(tabbable(header()).map((element) => element.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
});

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): number {
  return Date.now() - hours * HOUR_MS;
}

function sidebarThread(id: string, title: string, patch: { hostId?: string; status?: string; pending?: boolean; updatedAt?: number; archived?: boolean; hidden?: boolean } = {}): PluginSidebarThread {
  return {
    id,
    projectId: "proj_one",
    title,
    titleFallback: null,
    displayTitle: title,
    status: patch.status ?? "idle",
    hasPendingInteraction: patch.pending ?? false,
    isArchived: patch.archived ?? false,
    isHidden: patch.hidden ?? false,
    host: patch.hostId ? { id: patch.hostId, name: patch.hostId } : null,
    href: `/projects/proj_one/threads/${id}`,
    createdAt: 0,
    updatedAt: patch.updatedAt ?? 0,
  } as unknown as PluginSidebarThread;
}

function threadLabels(menu: HTMLElement): string[] {
  const group = within(menu).queryByRole("group", { name: "Threads" });
  return group ? within(group).getAllByRole("menuitem").map((item) => item.getAttribute("aria-label") ?? item.textContent ?? "") : [];
}

const HOLDER = sidebarThread("thr_lxc", "Builds the release", { status: "idle", updatedAt: 9 });
const ON_GLAD_CORAL = sidebarThread("thr_child", "Runs the tests on the box", { hostId: "host_lxc", status: "active", updatedAt: 3 });
const ELSEWHERE = sidebarThread("thr_other", "Works somewhere else", { hostId: "host_build", status: "active" });

test("a thread's box lists, after a divider and a Threads label, the thread that holds it, then the threads running on it, each with whether it is working", async () => {
  openMonitor("host_lxc", [ELSEWHERE, ON_GLAD_CORAL, HOLDER]);
  const menu = await openViews();
  expect(within(menu).getAllByRole("separator")).toHaveLength(1);
  expect(within(menu).getByText("Threads")).toBeTruthy();
  expect(items(menu)).toEqual(["Open details", "Open terminal", "Open files", "Builds the release", "Runs the tests on the box"]);
  expect(threadLabels(menu)).toEqual(["Builds the release, idle", "Runs the tests on the box, working"]);
  const working = within(menu).getByRole("menuitem", { name: "Runs the tests on the box, working" });
  expect(within(working).getByLabelText("Working")).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: "Builds the release, idle" })).queryByLabelText("Working")).toBeNull();
});

test("a kept machine lists the threads running on it, working first, then the most recent, as its Boxes row's chips do; archived threads are not listed", async () => {
  openMonitor("box:bx_desk", [
    sidebarThread("thr_old", "Finished last week", { hostId: "host_desk", updatedAt: 1 }),
    sidebarThread("thr_new", "Finished today", { hostId: "host_desk", updatedAt: 8 }),
    sidebarThread("thr_ask", "Waits on a question", { hostId: "host_desk", pending: true, updatedAt: 2 }),
    sidebarThread("thr_busy", "Starts the server", { hostId: "host_desk", status: "starting", updatedAt: 4 }),
    sidebarThread("thr_gone", "Archived", { hostId: "host_desk", archived: true, updatedAt: 9 }),
  ]);
  expect(threadLabels(await openViews())).toEqual(["Starts the server, working", "Waits on a question, working", "Finished today, idle", "Finished last week, idle"]);
});

test("more than 5 threads: the first 5, then N more on the Boxes page, which opens the box's page", async () => {
  const seven = Array.from({ length: 7 }, (_, index) => sidebarThread(`thr_${index}`, `Thread ${index}`, { hostId: "host_desk", updatedAt: 10 - index }));
  const kept = openMonitor("box:bx_desk", seven);
  const menu = await openViews();
  expect(threadLabels(menu)).toEqual(["Thread 0, idle", "Thread 1, idle", "Thread 2, idle", "Thread 3, idle", "Thread 4, idle", "2 more on the Boxes page"]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "2 more on the Boxes page" }));
  expect(kept.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_desk"));
  cleanup();
  const children = Array.from({ length: 6 }, (_, index) => sidebarThread(`thr_${index}`, `Child ${index}`, { hostId: "host_lxc", updatedAt: 10 - index }));
  const held = openMonitor("host_lxc", [HOLDER, ...children]);
  const heldMenu = await openViews();
  expect(threadLabels(heldMenu).at(0)).toBe("Builds the release, idle");
  fireEvent.click(within(heldMenu).getByRole("menuitem", { name: "2 more on the Boxes page" }));
  expect(held.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("box/bx_lxc"));
});

test("when the menu lists threads, the Open button's tooltip says views and threads of the box", async () => {
  openMonitor("host_lxc", [HOLDER, ON_GLAD_CORAL]);
  fireEvent.pointerMove(await openButton());
  await waitFor(() => expect(screen.queryAllByRole("tooltip", { hidden: true }).some((tooltip) => tooltip.textContent === "Views and threads of glad-coral")).toBe(true));
});

test("a box with no threads has no divider and no Threads section", async () => {
  openMonitor("box:bx_both", [ELSEWHERE]);
  const menu = await openViews();
  expect(items(menu)).toEqual(["Open details", "Open emulator", "Open desktop", "Open terminal"]);
  expect(within(menu).queryByRole("separator")).toBeNull();
  expect(within(menu).queryByText("Threads")).toBeNull();
});

test("a thread item opens that thread through BB's navigation, as a thread chip does", async () => {
  const monitor = openMonitor("host_lxc", [HOLDER, ON_GLAD_CORAL]);
  await openViews();
  fireEvent.click(screen.getByRole("menuitem", { name: "Runs the tests on the box, working" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_child" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("the keyboard moves from the views to the threads in order, past the divider and the label", async () => {
  openMonitor("box:bx_desk", [sidebarThread("thr_a", "First thread", { hostId: "host_desk", status: "active" }), sidebarThread("thr_b", "Second thread", { hostId: "host_desk" })]);
  const open = await openButton();
  open.focus();
  fireEvent.keyDown(open, { key: "Enter" });
  await screen.findByRole("menu");
  const focused = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;
  await waitFor(() => expect(focused()).toBe("Open details"));
  for (const next of ["Open desktop", "Open terminal", "Open files", "First thread, working", "Second thread, idle"]) {
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(focused()).toBe(next));
  }
});

function withoutLiveThreads(replacement: (() => never) | undefined, run: () => Promise<void>): Promise<void> {
  const app = (globalThis as unknown as { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } }).__bbPluginRuntime.pluginSdkApp;
  const live = app.experimental_useSidebarThreads;
  if (replacement) app.experimental_useSidebarThreads = replacement;
  else delete app.experimental_useSidebarThreads;
  return run().finally(() => {
    app.experimental_useSidebarThreads = live;
  });
}

for (const [why, replacement] of [["missing", undefined], ["throws", () => { throw new Error("no sidebar here"); }]] as const) {
  test(`when BB's live thread list is ${why}, a kept machine lists its Boxes row's chips, and a thread's box and a machine that is not a box list none`, async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withoutLiveThreads(replacement, async () => {
      openMonitor("box:bx_desk");
      const menu = await openViews();
      await waitFor(() => expect(threadLabels(menu)).toEqual(["Busy on the chips, working", "Idle on the chips, idle"]));
      cleanup();
      openMonitor("host_lxc");
      const held = await openViews();
      expect(items(held)).toEqual(["Open details", "Open terminal", "Open files"]);
      expect(within(held).queryByRole("separator")).toBeNull();
      cleanup();
      openMonitor("host_build");
      await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("build-server"));
      expect(within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
    });
    vi.mocked(console.error).mockRestore();
  });
}

const ON_BUILD_SERVER = [
  sidebarThread("thr_build_idle", "Finished the build", { hostId: "host_build", updatedAt: hoursAgo(1) }),
  sidebarThread("thr_build_busy", "Runs the benchmarks", { hostId: "host_build", status: "active", updatedAt: hoursAgo(2) }),
  sidebarThread("thr_build_old", "Cleaned the cache", { hostId: "host_build", updatedAt: hoursAgo(20) }),
  sidebarThread("thr_build_soak", "Runs the soak test", { hostId: "host_build", status: "active", updatedAt: hoursAgo(48) }),
  sidebarThread("thr_build_stale", "Finished last week", { hostId: "host_build", updatedAt: hoursAgo(30) }),
  sidebarThread("thr_build_hidden", "A plugin's helper", { hostId: "host_build", hidden: true, updatedAt: hoursAgo(1) }),
  sidebarThread("thr_build_gone", "Archived on build-server", { hostId: "host_build", archived: true, updatedAt: hoursAgo(1) }),
  ON_GLAD_CORAL,
];

test("a BB machine that is not a box lists its threads alone, working or active in the past 24 hours, working first, then the most recent, with no views, no Open details and no divider; hidden and archived threads are not listed", async () => {
  openMonitor("host_build", ON_BUILD_SERVER);
  const menu = await openViews("Threads on build-server");
  expect(items(menu)).toEqual(["Runs the benchmarks", "Runs the soak test", "Finished the build", "Cleaned the cache"]);
  expect(threadLabels(menu)).toEqual(["Runs the benchmarks, working", "Runs the soak test, working", "Finished the build, idle", "Cleaned the cache, idle"]);
  expect(within(menu).queryByRole("separator")).toBeNull();
  expect(within(menu).getByText("Threads")).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: "Runs the benchmarks, working" })).getByLabelText("Working")).toBeTruthy();
  expect(within(within(menu).getByRole("menuitem", { name: "Finished the build, idle" })).queryByLabelText("Working")).toBeNull();
});

test("the button of a machine that is not a box is named, and its tooltip says, threads on the machine", async () => {
  openMonitor("host_build", ON_BUILD_SERVER);
  const button = await openButton("Threads on build-server");
  expect(within(header()).queryByRole("button", { name: "Open" })).toBeNull();
  fireEvent.pointerMove(button);
  await waitFor(() => expect(screen.queryAllByRole("tooltip", { hidden: true }).some((tooltip) => tooltip.textContent === "Threads on build-server")).toBe(true));
});

test("BB's server lists the threads on it", async () => {
  openMonitor(null, [
    sidebarThread("thr_server_busy", "Answers a question", { hostId: SERVER_HOST, pending: true, updatedAt: hoursAgo(3) }),
    sidebarThread("thr_server_idle", "Wrote the release notes", { hostId: SERVER_HOST, updatedAt: hoursAgo(1) }),
    sidebarThread("thr_server_stale", "Wrote last month's notes", { hostId: SERVER_HOST, updatedAt: hoursAgo(25) }),
    ON_GLAD_CORAL,
  ]);
  const menu = await openViews("Threads on bb");
  expect(threadLabels(menu)).toEqual(["Answers a question, working", "Wrote the release notes, idle"]);
});

test("more than 5 threads on a machine that is not a box: the first 5, then how many more are in BB's sidebar, counting only those working or active in the past 24 hours, which is not an item", async () => {
  const seven = Array.from({ length: 7 }, (_, index) => sidebarThread(`thr_${index}`, `Thread ${index}`, { hostId: "host_build", updatedAt: hoursAgo(index + 1) }));
  const stale = Array.from({ length: 3 }, (_, index) => sidebarThread(`thr_stale_${index}`, `Stale ${index}`, { hostId: "host_build", updatedAt: hoursAgo(25 + index) }));
  const monitor = openMonitor("host_build", [...seven, ...stale]);
  const menu = await openViews("Threads on build-server");
  expect(threadLabels(menu)).toEqual(["Thread 0, idle", "Thread 1, idle", "Thread 2, idle", "Thread 3, idle", "Thread 4, idle"]);
  expect(within(menu).getByText("2 more in BB's sidebar")).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: /more/ })).toBeNull();
  fireEvent.click(within(menu).getByText("2 more in BB's sidebar"));
  expect(monitor.inspection.navigateCalls).toEqual([]);
});

test("a thread item of a machine that is not a box opens that thread", async () => {
  const monitor = openMonitor("host_build", ON_BUILD_SERVER);
  await openViews("Threads on build-server");
  fireEvent.click(screen.getByRole("menuitem", { name: "Finished the build, idle" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_build_idle" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
});

test("the keyboard reaches the threads button after the name; Enter opens it on the first thread, arrows move through the threads, and Escape returns focus to the button", async () => {
  openMonitor("host_build", ON_BUILD_SERVER);
  const button = await openButton("Threads on build-server");
  expect(tabbable(header()).map((element) => element.getAttribute("aria-label"))).toEqual(["Machine", "Threads on build-server", "Reload machine status", "Hide machine status"]);
  button.focus();
  fireEvent.keyDown(button, { key: "Enter" });
  const menu = await screen.findByRole("menu");
  const focused = () => document.activeElement?.getAttribute("aria-label");
  await waitFor(() => expect(focused()).toBe("Runs the benchmarks, working"));
  for (const next of ["Runs the soak test, working", "Finished the build, idle", "Cleaned the cache, idle"]) {
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(focused()).toBe(next));
  }
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(button));
});

test("a machine that is not a box, whose threads are all idle for more than 24 hours, hidden or archived, has no button", async () => {
  openMonitor("host_build", [
    sidebarThread("thr_stale", "Finished yesterday", { hostId: "host_build", updatedAt: hoursAgo(25) }),
    sidebarThread("thr_hidden", "A plugin's helper", { hostId: "host_build", hidden: true, status: "active", updatedAt: hoursAgo(1) }),
    sidebarThread("thr_gone", "Archived", { hostId: "host_build", archived: true, updatedAt: hoursAgo(1) }),
  ]);
  await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("build-server"));
  expect(within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
});

test("a box lists none of its hidden threads, its holder included, and keeps the rest however long ago they were active", async () => {
  openMonitor("host_lxc", [
    sidebarThread("thr_lxc", "Builds the release", { hidden: true, updatedAt: 9 }),
    sidebarThread("thr_helper", "A plugin's helper", { hostId: "host_lxc", hidden: true, status: "active" }),
    sidebarThread("thr_last_year", "Finished last year", { hostId: "host_lxc", updatedAt: 1 }),
  ]);
  const menu = await openViews();
  expect(threadLabels(menu)).toEqual(["Finished last year, idle"]);
});

const MiB = 1024 ** 2;

function cards(shared: boolean): Partial<MonitorSnapshot> {
  return {
    gpus: {
      cards: [
        { index: 0, name: "NVIDIA GeForce RTX 4090", usagePercent: 97, memoryUsedBytes: 20_000 * MiB, memoryTotalBytes: 24_564 * MiB, temperatureC: 81, powerWatts: 410, powerLimitWatts: 450, shared, ownMemoryBytes: shared ? 0 : 19_000 * MiB, ownProcesses: shared ? 0 : 1 },
        { index: 1, name: "NVIDIA GeForce RTX 4090", usagePercent: 2, memoryUsedBytes: 300 * MiB, memoryTotalBytes: 24_564 * MiB, temperatureC: 38, powerWatts: 21, powerLimitWatts: 450, shared: false, ownMemoryBytes: 0, ownProcesses: 0 },
      ],
      processes: shared ? [] : [{ pid: 4242, name: "python3", card: 0, memoryBytes: 19_000 * MiB }],
    },
  };
}

test("a machine with NVIDIA cards has a section for each, with its use, memory and power, and its processes' card memory in Top processes", async () => {
  forgetMonitorReadings();
  localStorage.setItem("bb-box:monitor:machine", "host_build");
  const reading = snapshot({ ...cards(false), processes: { available: true, total: 2, running: 1, top: [{ pid: 4242, name: "python3", cpuPercent: 101, memoryPercent: 10, rssBytes: 2 * 1024 * MiB }] } });
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({ host_build: reading }), pluginId: "bb-box" });
  const first = await screen.findByRole("region", { name: "GPU 0" });
  expect(first.textContent).toContain("97");
  expect(first.textContent).toContain("81°C");
  expect(screen.getByRole("region", { name: "GPU 1" }).textContent).toContain("2");
  const processes = screen.getByRole("region", { name: "Top processes" });
  expect(processes.textContent).toMatch(/^Top processesMemoryGPU% CPU/);
  expect(processes.querySelector("[data-gpu-memory]")!.textContent).toMatch(/GB$/);
  expect(localStorage.getItem("bb-box:monitor:shape:host_build")).toContain('"gpuCards":2');
});

test("a box that shares its card says the numbers are the whole card's, and its two sections are there before the reading lands", async () => {
  forgetMonitorReadings();
  localStorage.setItem("bb-box:monitor:machine", "host_lxc");
  localStorage.setItem("bb-box:monitor:shape:host_lxc", JSON.stringify({ gpu: true, gpuCards: 2, battery: false, tailscaleRows: 0 }));
  let release: () => void = () => {};
  const landed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = snapshot(cards(true));
  const rpc = { ...handlers({}), "monitor.machine": async () => (await landed, reading) } as never;
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc, pluginId: "bb-box" });
  expect(await screen.findByRole("region", { name: "GPU 0" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "GPU 1" })).toBeTruthy();
  release();
  const shared = await screen.findByRole("region", { name: "GPU 0, whole card" });
  expect(shared.textContent).toContain("shared card");
  expect(shared.textContent).toMatch(/This box: 0 B of [\d.]+ GB$/);
});

test("a reading that misses the cards keeps their sections and the GPU column, says they were not read, and the remembered count stays", async () => {
  forgetMonitorReadings();
  localStorage.setItem("bb-box:monitor:machine", "host_build");
  let readings = 0;
  const rpc = { ...handlers({}), "monitor.machine": () => (++readings === 1 ? snapshot(cards(false)) : snapshot({ gpus: null, refreshIntervalMs: 2000 })) } as never;
  renderSlot(footer!, { dismiss: vi.fn() }, { rpc, pluginId: "bb-box" });
  expect(await screen.findByRole("region", { name: "GPU 0" })).toBeTruthy();
  await waitFor(() => expect(screen.getByRole("region", { name: "GPU 1" }).textContent).toContain("not read"), { timeout: 15_000 });
  expect(screen.getByRole("region", { name: "GPU 0" }).textContent).toContain("No reading of this card this time");
  expect(screen.getByRole("region", { name: "Top processes" }).textContent).toMatch(/^Top processesMemoryGPU% CPU/);
  expect(localStorage.getItem("bb-box:monitor:shape:host_build")).toContain('"gpuCards":2');
}, 20_000);
