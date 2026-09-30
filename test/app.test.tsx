// The panel and settings section, rendered with the SDK's slot harness
// against fake RPC handlers. Run with vitest: npm run test:app.

import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { BoxResult, Contract, PanelState } from "../src/plugin/contract.ts";
import type { BackendView, BoxView, DoctorView, KindView } from "../src/plugin/views.ts";

const THREAD = "thr_panel";
const app = await loadPluginApp(() => import("../app.tsx"));
afterEach(cleanup);

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
    const found = boxes.find((candidate) => candidate.id === ref || candidate.name === ref) ?? null;
    if (!found) return { box: null, error: `There is no box "${ref}".` };
    const updated = next(found);
    boxes = updated ? boxes.map((candidate) => (candidate === found ? updated : candidate)) : boxes.filter((candidate) => candidate !== found);
    return result(updated);
  };
  const handlers: PluginRpcTestHandlers<Contract> = {
    state: ({ threadId }): PanelState => ({ boxes: threadId === THREAD ? boxes : [], kinds: options.kinds ?? KINDS, backends: BACKENDS }),
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

test("the app registers the Boxes panel and the Backends settings section", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.title])).toEqual([["boxes", "Boxes"]]);
  expect(app.settingsSections.map((section) => section.id)).toEqual(["backends"]);
});

test("the panel lists the thread's boxes, with a placeholder for a desktop", async () => {
  const { handlers } = server([box(), box({ id: "box_2", name: "bold-heron", kind: "linux-desktop", kindLabel: "Linux desktop", desktop: true, gpu: true })]);
  const slot = panel(handlers);

  expect(await slot.findByText("calm-otter")).toBeTruthy();
  expect(slot.getByText("bold-heron")).toBeTruthy();
  expect(slot.getAllByText("Ready")).toHaveLength(2);
  expect(slot.getAllByText("192.0.2.10").length).toBeGreaterThan(0);
  expect(slot.getAllByText("Enrolled").length).toBe(2);
  expect(slot.getByText(/The desktop viewer comes in a later version/)).toBeTruthy();
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
