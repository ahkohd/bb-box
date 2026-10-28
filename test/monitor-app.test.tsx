import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { Contract, Machine, MonitorSnapshot } from "../src/plugin/contract.ts";

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
  { id: SERVER_HOST, name: "bb", connected: true, isServer: true, isBox: false },
  { id: "host_lxc", name: "glad-coral", connected: true, isServer: false, isBox: true },
  { id: "host_slot", name: "keen-iris", connected: true, isServer: false, isBox: true },
  { id: "host_long", name: "a-shared-ios-box-with-a-very-long-name-1234", connected: true, isServer: false, isBox: true },
];

function handlers(readings: Record<string, MonitorSnapshot>): PluginRpcTestHandlers<Contract> {
  return {
    "monitor.state": () => ({ enabled: true, backgroundMonitoring: false, pressureNotifications: true }),
    "monitor.machines": () => ({ machines: MACHINES }),
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
