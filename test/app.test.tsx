// The panel, the desktop viewer and the settings section, rendered with the
// SDK's slot harness against fake RPC handlers and a fake noVNC. Run with
// vitest: npm run test:app.

import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { BoxResult, Contract, DesktopState, PanelState } from "../src/plugin/contract.ts";
import type { BackendView, BoxView, DoctorView, KindView } from "../src/plugin/views.ts";

/** noVNC's RFB, recording each client the viewer makes. */
const novnc = vi.hoisted(() => {
  class FakeRfb extends EventTarget {
    static made: FakeRfb[] = [];
    viewOnly = false;
    scaleViewport = false;
    resizeSession = false;
    focused = 0;
    disconnected = false;
    readonly url: string;
    readonly options: unknown;
    constructor(_target: HTMLElement, url: string, options: unknown) {
      super();
      this.url = url;
      this.options = options;
      FakeRfb.made.push(this);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {
      this.focused++;
    }
    blur() {}
  }
  return { FakeRfb };
});
vi.mock("@novnc/novnc", () => ({ default: novnc.FakeRfb }));

const THREAD = "thr_panel";
const DESKTOP_PATH = "/api/v1/plugins/bb-box/http/desktop";
const app = await loadPluginApp(() => import("../app.tsx"));
afterEach(() => {
  cleanup();
  novnc.FakeRfb.made = [];
  window.sessionStorage.clear();
});

function box(overrides: Partial<BoxView> = {}): BoxView {
  return {
    id: "box_1",
    name: "calm-otter",
    kind: "linux-headless",
    kindLabel: "Linux headless",
    backendLabel: "Fake host",
    nature: "virtual",
    role: "box",
    state: "ready",
    error: null,
    createdAt: 1_790_000_000_000,
    readyAt: 1_790_000_002_000,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: [],
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    address: "192.0.2.10",
    facts: [{ label: "Template", value: "9000" }],
    timings: { clone: 700, total: 2100, enrol: 5300 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    canStopStart: true,
    ...overrides,
  };
}

const KINDS: KindView[] = [
  { id: "linux-headless", label: "Linux headless", description: "A Linux box without a desktop.", size: "2 cores, 4 GiB", gpu: false, desktop: false, backends: ["Fake host"] },
  { id: "linux-desktop", label: "Linux desktop", description: "A desktop with a GPU.", size: "4 cores, 8 GiB", gpu: true, desktop: true, backends: ["Fake host"] },
];

const BACKENDS: BackendView[] = [
  {
    type: "fake",
    label: "Fake host",
    nature: "virtual",
    state: "misconfigured",
    problems: ["Set the API URL."],
    setup: { guide: "setup/fake/README.md", scripts: ["setup/fake/one.sh", "setup/fake/two.sh"] },
  },
];

/** RPC handlers over one thread's boxes, recording each change. */
function server(initial: BoxView[], options: { kinds?: KindView[]; failWith?: string } = {}) {
  let boxes = [...initial];
  const changes: string[] = [];
  const result = (found: BoxView | null): BoxResult => (options.failWith ? { box: null, error: options.failWith } : { box: found, error: null });
  const change = (method: string, ref: string, next: (found: BoxView) => BoxView | null): BoxResult => {
    changes.push(`${method} ${ref}`);
    if (options.failWith) return result(null);
    const found = find(ref);
    if (!found) return { box: null, error: `There is no box "${ref}".` };
    const updated = next(found);
    boxes = updated ? boxes.map((candidate) => (candidate === found ? updated : candidate)) : boxes.filter((candidate) => candidate !== found);
    return result(updated);
  };
  const find = (ref: string) => boxes.find((candidate) => candidate.id === ref || candidate.name === ref) ?? null;
  const handlers: PluginRpcTestHandlers<Contract> = {
    state: ({ threadId }): PanelState => ({ boxes: threadId === THREAD ? boxes : [], kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH }),
    desktop: ({ box: ref }): DesktopState => ({ box: find(ref), desktopPath: DESKTOP_PATH }),
    takeControl: ({ box: ref, viewer }) => change("takeControl", ref, (found) => ({ ...found, control: { owner: "human", holder: viewer } })),
    handBack: ({ box: ref }) => change("handBack", ref, (found) => ({ ...found, control: { owner: "agent", holder: null } })),
    desktops: () => boxes.filter((candidate) => candidate.desktop).map((found) => ({ threadId: THREAD, box: found })),
    acquire: ({ kind }) => {
      changes.push(`acquire ${kind}`);
      if (options.failWith) return result(null);
      const made = box({ id: `box_${boxes.length + 2}`, name: "new-box", kind, state: "acquiring" });
      boxes = [...boxes, made];
      return result(made);
    },
    release: ({ box: ref }) => change("release", ref, () => null),
    stop: ({ box: ref }) => change("stop", ref, (found) => ({ ...found, state: "stopped" })),
    start: ({ box: ref }) => change("start", ref, (found) => ({ ...found, state: "ready" })),
    refresh: ({ box: ref }) => change("refresh", ref, (found) => found),
    backends: () => BACKENDS,
    doctor: (): DoctorView => ({
      ok: false,
      sections: [
        {
          title: "Fake host",
          report: {
            ok: false,
            summary: "Fake host 1.0",
            checks: [{ id: "api", name: "API", status: "fail", detail: "No answer from the API.", fix: "Check the URL." }],
            notes: ["Install this public key in the templates."],
          },
        },
      ],
    }),
  };
  return { handlers, changes };
}

function panel(handlers: PluginRpcTestHandlers<Contract>) {
  const [action] = app.threadPanelActions;
  return renderSlot(action!, { threadId: THREAD, params: null }, { rpc: handlers });
}

function stateCalls(slot: ReturnType<typeof panel>): number {
  return slot.inspection.rpcCalls.filter((call) => call.method === "state").length;
}

/** A running desktop box. */
function desktopBox(overrides: Partial<BoxView> = {}): BoxView {
  return box({
    id: "box_2",
    name: "bold-heron",
    kind: "linux-desktop",
    kindLabel: "Linux desktop",
    desktop: true,
    gpu: true,
    display: { protocol: "rfb", resizable: true },
    control: { owner: "agent", holder: null },
    ...overrides,
  });
}

test("the app registers the Boxes panel, a desktop tab, the Desktops page and the Backends settings section", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.title])).toEqual([
    ["boxes", "Boxes"],
    ["desktop", "Desktop"],
  ]);
  expect(app.navPanels.map((page) => [page.id, page.title, page.path])).toEqual([["desktops", "Desktops", "desktop"]]);
  expect(app.settingsSections.map((section) => section.id)).toEqual(["backends"]);
});

test("the panel lists the thread's boxes, and opens a desktop box's desktop", async () => {
  const { handlers } = server([box(), desktopBox()]);
  const [action] = app.threadPanelActions;
  const slot = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: handlers, pluginId: "bb-box" });

  expect(await slot.findByText("calm-otter")).toBeTruthy();
  expect(slot.getByText("bold-heron")).toBeTruthy();
  expect(slot.getAllByText("Ready")).toHaveLength(2);
  expect(slot.getAllByText("192.0.2.10").length).toBeGreaterThan(0);
  expect(slot.getAllByText("Enrolled").length).toBe(2);
  expect(slot.getByText("The agent")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open desktop" }));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop: bold-heron", params: { box: "box_2" } } },
  ]);
  const link = slot.getByRole("link", { name: "New browser tab" });
  expect(link.getAttribute("href")).toBe("/plugins/bb-box/desktop/thr_panel/box_2");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(slot.getAllByText("2.1 s").length).toBe(2);
  expect(slot.getAllByText("BB enrolment").length).toBe(2);
  expect(slot.getAllByText("5.3 s").length).toBe(2);
});

test("the panel makes a box of the chosen kind", async () => {
  const { handlers, changes } = server([]);
  const slot = panel(handlers);

  expect(await slot.findByText(/This thread has no boxes/)).toBeTruthy();
  fireEvent.change(slot.getByLabelText("Kind of box"), { target: { value: "linux-desktop" } });
  expect(slot.getByText("A desktop with a GPU.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "New box" }));

  expect(await slot.findByText("new-box")).toBeTruthy();
  expect(changes).toEqual(["acquire linux-desktop"]);
  expect(slot.getByText("Acquiring")).toBeTruthy();
});

test("releasing a box asks first", async () => {
  const { handlers, changes } = server([box()]);
  const slot = panel(handlers);

  fireEvent.click(await slot.findByRole("button", { name: "Release" }));
  expect(changes).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "Keep" }));
  expect(slot.queryByRole("button", { name: "Release and delete its disk" })).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: "Release" }));
  fireEvent.click(slot.getByRole("button", { name: "Release and delete its disk" }));
  expect(await slot.findByText(/This thread has no boxes/)).toBeTruthy();
  expect(changes).toEqual(["release box_1"]);
});

test("the panel stops and starts a box that can, and not one that cannot", async () => {
  const { handlers, changes } = server([box()]);
  const slot = panel(handlers);

  fireEvent.click(await slot.findByRole("button", { name: "Stop" }));
  fireEvent.click(await slot.findByRole("button", { name: "Start" }));
  await slot.findByRole("button", { name: "Stop" });
  expect(changes).toEqual(["stop box_1", "start box_1"]);

  cleanup();
  const fixed = panel(server([box({ id: "box_9", name: "real-box", canStopStart: false })]).handlers);
  await fixed.findByText("real-box");
  expect(fixed.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(fixed.getByRole("button", { name: "Release" })).toBeTruthy();
});

test("the panel shows why a change failed", async () => {
  const { handlers } = server([box()], { failWith: "Stopping the box failed: the host did not answer." });
  const slot = panel(handlers);

  fireEvent.click(await slot.findByRole("button", { name: "Stop" }));
  expect(await slot.findByText("Stopping the box failed: the host did not answer.")).toBeTruthy();
});

test("the panel says so when no backend is on", async () => {
  const slot = panel(server([], { kinds: [] }).handlers);
  expect(await slot.findByText(/No backend is on/)).toBeTruthy();
  expect(slot.queryByRole("button", { name: "New box" })).toBeNull();
});

test("the panel refetches on its thread's change signals and after a reconnect", async () => {
  const { handlers } = server([box()]);
  const slot = panel(handlers);
  await slot.findByText("calm-otter");
  await waitFor(() => expect(stateCalls(slot)).toBe(1));

  await slot.behavior.emitRealtime("changed", { threadId: "thr_other" });
  expect(stateCalls(slot)).toBe(1);
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  await waitFor(() => expect(stateCalls(slot)).toBe(2));
  await slot.behavior.emitRealtime("changed", { threadId: null });
  await waitFor(() => expect(stateCalls(slot)).toBe(3));

  await slot.behavior.setRealtimeConnectionState("reconnecting");
  await slot.behavior.setRealtimeConnectionState("connected");
  await waitFor(() => expect(stateCalls(slot)).toBe(4));
});

test("the settings section shows each backend's problems and setup, and runs the doctor", async () => {
  const { handlers } = server([]);
  const [section] = app.settingsSections;
  const slot = renderSlot(section!, {}, { rpc: handlers });

  expect(await slot.findByText("Fake host")).toBeTruthy();
  expect(slot.getByText("Needs its settings fixed")).toBeTruthy();
  expect(slot.getByText("Set the API URL.")).toBeTruthy();
  expect(slot.getByText("setup/fake/README.md")).toBeTruthy();
  expect(slot.getByText("setup/fake/two.sh")).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Check the backends" }));
  expect(await slot.findByText(/\[fail\] API: No answer from the API\./)).toBeTruthy();
  expect(slot.getByText("Fix: Check the URL.")).toBeTruthy();
  expect(slot.getByText("Note: Install this public key in the templates.")).toBeTruthy();
});

function desktopTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_2") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a desktop tab shows the box through the relay, and takes and hands back control", async () => {
  const { handlers, changes } = server([desktopBox()]);
  const slot = desktopTab(handlers);

  expect(await slot.findByText("Connecting to the desktop...")).toBeTruthy();
  const [client] = novnc.FakeRfb.made;
  const url = new URL(client!.url);
  expect(url.protocol).toBe("ws:");
  expect(url.pathname).toBe(DESKTOP_PATH);
  expect(url.searchParams.get("box")).toBe("box_2");
  const viewer = url.searchParams.get("viewer")!;
  expect(viewer).toMatch(/^[0-9a-f]{24}$/);
  expect(client!.options).toEqual({ shared: true });
  expect([client!.viewOnly, client!.scaleViewport]).toEqual([true, true]);
  expect(slot.getByText("The agent has control. You are watching.")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(true);

  act(() => void client!.dispatchEvent(new Event("connect")));
  expect(slot.queryByText("Connecting to the desktop...")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  expect(await slot.findByText("You have control. Hand it back when you are done.")).toBeTruthy();
  expect(slot.inspection.rpcCalls.find((call) => call.method === "takeControl")?.input).toEqual({ threadId: THREAD, box: "box_2", viewer });
  expect([client!.viewOnly, client!.resizeSession, client!.focused]).toEqual([false, true, 1]);

  fireEvent.click(slot.getByRole("button", { name: "Hand back to the agent" }));
  expect(await slot.findByText("The agent has control. You are watching.")).toBeTruthy();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([true, false]);
  expect(changes).toEqual(["takeControl box_2", "handBack box_2"]);
});

test("a desktop tab keeps its viewer ID when it remounts, and two tabs never share one", async () => {
  const { handlers } = server([desktopBox()]);
  const first = desktopTab(handlers);
  await first.findByText("Connecting to the desktop...");
  const second = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
  const [a, b] = novnc.FakeRfb.made.map((client) => new URL(client.url).searchParams.get("viewer"));
  expect(a).not.toBe(b);

  first.unmount();
  second.unmount();
  desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(3));
  expect(new URL(novnc.FakeRfb.made[2]!.url).searchParams.get("viewer")).toBe(b);
});

test("a desktop tab shows why the desktop refused it, and reconnects", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await slot.findByText("Connecting to the desktop...");
  const [client] = novnc.FakeRfb.made;
  act(() => {
    client!.dispatchEvent(new CustomEvent("securityfailure", { detail: { status: 1, reason: "The box's desktop refused its VNC password." } }));
    client!.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } }));
  });
  expect(slot.getByText("The box's desktop refused its VNC password. Trying again...")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
});

test("a desktop tab says when its box is not running or gone", async () => {
  const stopped = desktopTab(server([desktopBox({ state: "stopped" })]).handlers);
  expect(await stopped.findByText("The desktop shows when box bold-heron is running.")).toBeTruthy();
  expect(novnc.FakeRfb.made).toEqual([]);
  cleanup();
  const gone = desktopTab(server([]).handlers);
  expect(await gone.findByText("This thread has no such box. It may have been released.")).toBeTruthy();
});

test("a desktop tab opened bare lists the thread's desktops", async () => {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  const slot = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box(), desktopBox()]).handlers });
  fireEvent.click(await slot.findByRole("button", { name: "bold-heron" }));
  expect(slot.inspection.navigateCalls).toEqual([
    { method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop: bold-heron", params: { box: "box_2" } } },
  ]);
});

test("the Desktops page lists every desktop box, and shows one for a browser tab", async () => {
  const { handlers } = server([desktopBox()]);
  const [page] = app.navPanels;
  const list = renderSlot(page!, { subPath: "" }, { rpc: handlers, pluginId: "bb-box" });
  expect(await list.findByText("Linux desktop, running")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "bold-heron" }));
  fireEvent.click(list.getByRole("button", { name: "Open its thread" }));
  expect(list.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desktop", options: { subPath: "thr_panel/box_2" } },
    { method: "toThread", threadId: THREAD },
  ]);
  cleanup();

  const one = renderSlot(page!, { subPath: "thr_panel/box_2" }, { rpc: handlers, pluginId: "bb-box" });
  expect(await one.findByText("Connecting to the desktop...")).toBeTruthy();
  expect(one.queryByRole("link", { name: "New browser tab" })).toBeNull();
});
