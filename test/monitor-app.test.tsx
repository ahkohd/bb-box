import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { BoxEntry, Contract, Machine, MonitorSnapshot } from "../src/plugin/contract.ts";
import type { BoxView } from "../src/plugin/views.ts";

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
  { threadId: "thr_lxc", owner: "thread", box: boxView({ id: "bx_lxc", name: "glad-coral", terminal: true }) },
  { threadId: "thr_slot", owner: "thread", box: boxView({ id: "bx_slot", name: "keen-iris", os: "macos", terminal: false, device: { platform: "ios", model: "iPhone 17", simulatorHost: false } }) },
  { threadId: "operator", owner: "yours", box: boxView({ id: "bx_desk", name: "quiet-moth", desktop: true }) },
  { threadId: "thr_both", owner: "thread", box: boxView({ id: "bx_both", name: "brisk-wren", desktop: true, device: { platform: "android", model: "Pixel 9", simulatorHost: false } }) },
  { threadId: "thr_stopped", owner: "thread", box: boxView({ id: "bx_stopped", name: "deep-elm", desktop: true, state: "stopped" }) },
];

function handlers(readings: Record<string, MonitorSnapshot>): PluginRpcTestHandlers<Contract> {
  return {
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true }),
    "monitor.machines": () => ({ machines: MACHINES }),
    allBoxes: () => BOX_ENTRIES,
    "monitor.server": () => readings.server ?? snapshot(),
    "monitor.machine": ({ machineId }: { machineId: string }) => readings[machineId] ?? snapshot(),
    "monitor.alerts": () => ({ enabled: false, notifications: true, cursor: 0, active: [], recent: [] }),
  } as unknown as PluginRpcTestHandlers<Contract>;
}

let footer: { component: ComponentType<ExperimentalSidebarFooterDisclosureProps>; label: string; icon: string; id: string } | undefined;

beforeAll(async () => {
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
  const app = await loadPluginApp(() => import("../app.tsx"));
  footer = app.experimentalSidebarFooterItems.find((item) => item.id === "status") as typeof footer;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test("the footer keeps Beacon's entry: Machine status, with the server icon under a name of bb-box's own", async () => {
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

test("with the Monitor off, BB's next load of bb-box's app has no machine status in the footer", async () => {
  localStorage.setItem("bb-box:monitor:on", "off");
  const app = await loadPluginApp(() => import("../app.tsx"));
  expect(app.experimentalSidebarFooterItems.some((item) => item.id === "status")).toBe(false);
  expect(app.appOverlays.some((overlay) => overlay.id === "monitor")).toBe(true);
});

test("the overlay remembers the server's switch for the next load", async () => {
  const app = await loadPluginApp(() => import("../app.tsx"));
  const overlay = app.appOverlays.find((entry) => entry.id === "monitor")!;
  const off = { ...handlers({}), "monitor.state": () => ({ enabled: false, backgroundMonitoring: false, pressureNotifications: true }) } as unknown as PluginRpcTestHandlers<Contract>;
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

function openMonitor(machineId: string | null) {
  if (machineId) localStorage.setItem("bb-box:monitor:machine", machineId);
  return renderSlot(footer!, { dismiss: vi.fn() }, { rpc: handlers({}), pluginId: "bb-box" });
}

function header(): HTMLElement {
  return document.querySelector<HTMLElement>("[data-bb-box-monitor-header]")!;
}

async function openButton(): Promise<HTMLElement> {
  return await waitFor(() => within(header()).getByRole("button", { name: "Open" }));
}

async function openViews(): Promise<HTMLElement> {
  fireEvent.keyDown(await openButton(), { key: "Enter" });
  return await screen.findByRole("menu");
}

function items(menu: HTMLElement): string[] {
  return within(menu).getAllByRole("menuitem").map((item) => `${item.textContent}${item.hasAttribute("data-disabled") ? " (disabled)" : ""}`);
}

const TO_BOXES_PAGE = (subPath: string) => ({ method: "toPluginPanel", path: "desktop", options: { subPath } });

test("a desktop box's Open menu offers its desktop and terminal, each opening the Boxes page's view as the Boxes row does", async () => {
  const monitor = openMonitor("box:bx_desk");
  expect(items(await openViews())).toEqual(["Open desktop", "Open terminal"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open desktop" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("operator/bx_desk"));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await openViews();
  fireEvent.click(screen.getByRole("menuitem", { name: "Open terminal" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("operator/bx_desk/terminal"));
  expect(localStorage.getItem("bb-box:monitor:machine")).toBe("box:bx_desk");
});

test("a device box's Open menu offers its Simulator alone when it has no terminal, and it opens the device view", async () => {
  const monitor = openMonitor("host_slot");
  expect(items(await openViews())).toEqual(["Open simulator"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open simulator" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("thr_slot/bx_slot/device"));
});

test("a box with a desktop and an Emulator offers both, then its terminal", async () => {
  const monitor = openMonitor("box:bx_both");
  expect(items(await openViews())).toEqual(["Open emulator", "Open desktop", "Open terminal"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Open emulator" }));
  expect(monitor.inspection.navigateCalls.at(-1)).toEqual(TO_BOXES_PAGE("thr_both/bx_both/device"));
});

test("the Open button's tooltip names the box", async () => {
  openMonitor("box:bx_both");
  fireEvent.pointerMove(await openButton());
  await waitFor(() => expect(screen.queryAllByRole("tooltip", { hidden: true }).some((tooltip) => tooltip.textContent === "Open a view of brisk-wren")).toBe(true));
});

test("a stopped box's views are in the menu, disabled, each with the reason, and open nothing", async () => {
  const monitor = openMonitor("host_stopped");
  const menu = await openViews();
  expect(items(menu)).toEqual(["Open desktopdeep-elm is stopped (disabled)", "Open terminaldeep-elm is stopped (disabled)"]);
  fireEvent.click(within(menu).getAllByRole("menuitem")[0]!);
  expect(monitor.inspection.navigateCalls.filter((call) => call.method === "toPluginPanel")).toEqual([]);
});

test("BB's server and a BB machine that is not a box get no Open button, and the header keeps its own", async () => {
  openMonitor(null);
  await screen.findByText("load 0.50");
  await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("bb"));
  expect(within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Machine", "Reload machine status", "Hide machine status"]);
  cleanup();
  openMonitor("host_build");
  await waitFor(() => expect(within(header()).getByRole("button", { name: "Machine" }).textContent).toContain("build-server"));
  expect(within(header()).queryByRole("button", { name: "Open" })).toBeNull();
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
  expect(tabbable(header()).map((element) => element.getAttribute("aria-label"))).toEqual(["Machine", "Open", "Reload machine status", "Machine status settings", "Hide machine status"]);
  open.focus();
  fireEvent.keyDown(open, { key: " " });
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Open emulator"));
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("Open desktop"));
  const escapeBeyondMenu = vi.fn();
  window.addEventListener("keydown", escapeBeyondMenu);
  fireEvent.keyDown(menu, { key: "Escape" });
  window.removeEventListener("keydown", escapeBeyondMenu);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(open));
  expect(escapeBeyondMenu).not.toHaveBeenCalled();
  expect(header()).toBeTruthy();
});
