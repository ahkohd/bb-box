// The panel, the desktop viewer and the settings section, rendered with the
// SDK's slot harness against fake RPC handlers and a fake noVNC. Run with
// vitest: npm run test:app.

import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ApplyResult, BoxResult, CheckResult, ConfigState, Contract, DesktopState, MachineEntry, PanelState, ThreadOnBox } from "../src/plugin/contract.ts";
import type { ConfigDocument, Problem } from "../src/core/document.ts";
import type { BackendView, BoxView, DoctorView, KindView } from "../src/plugin/views.ts";
import { forgetLive, isArm64Badge } from "../src/app/common.tsx";
type DesktopEntryLike = { threadId: string; box: BoxView; owner: "thread" | "yours" };
import { dropAllKept, HAND_BACK_MS, HIDDEN_MS } from "../src/app/kept.ts";
import { sparesWords } from "../src/app/settings-kinds.tsx";
import { statusOf } from "../src/app/status.ts";

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
    readonly target: HTMLElement;
    constructor(target: HTMLElement, url: string, options: unknown) {
      super();
      this.target = target;
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

// xterm draws nothing in jsdom: a fake keeps what was written and lets a test type and resize.
const xterm = vi.hoisted(() => {
  class FakeTerminal {
    static made: FakeTerminal[] = [];
    cols = 80;
    rows = 24;
    written: string[] = [];
    data: ((text: string) => void) | null = null;
    resized: ((size: { cols: number; rows: number }) => void) | null = null;
    target: HTMLElement | null = null;
    constructor() {
      FakeTerminal.made.push(this);
    }
    open(target: HTMLElement) {
      this.target = target;
    }
    loadAddon() {}
    focus() {}
    reset() {}
    dispose() {}
    write(data: string | Uint8Array) {
      this.written.push(typeof data === "string" ? data : new TextDecoder().decode(data));
    }
    onData(handler: (text: string) => void) {
      this.data = handler;
      return { dispose: () => {} };
    }
    onResize(handler: (size: { cols: number; rows: number }) => void) {
      this.resized = handler;
      return { dispose: () => {} };
    }
  }
  return { FakeTerminal };
});
vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

/** A WebSocket a test opens, feeds and closes. */
class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: (string | Uint8Array)[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.made.push(this);
  }
  send(data: string | Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(text: string) {
    this.onmessage?.({ data: new TextEncoder().encode(text).buffer });
  }
  end(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}
vi.stubGlobal("WebSocket", FakeSocket);

const THREAD = "thr_panel";
const DESKTOP_PATH = "/api/v1/plugins/bb-box/http/desktop";
const TERMINAL_PATH = "/api/v1/plugins/bb-box/http/terminal";
const app = await loadPluginApp(() => import("../app.tsx"));
afterEach(() => {
  cleanup();
  dropAllKept();
  forgetLive();
  vi.useRealTimers();
  applied = null;
  novnc.FakeRfb.made = [];
  xterm.FakeTerminal.made = [];
  FakeSocket.made = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
});

function box(overrides: Partial<BoxView> = {}): BoxView {
  return {
    id: "box_1",
    name: "calm-otter",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Fake host",
    nature: "virtual",
    form: "LXC",
    role: "box",
    state: "ready",
    error: null,
    createdAt: Date.now() - 12 * 60_000,
    readyAt: Date.now() - 12 * 60_000 + 2100,
    os: "linux",
    arch: "x86_64",
    gpu: false,
    requires: [],
    extras: ["docker"],
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "192.0.2.10",
    facts: [{ label: "Template", value: "9000" }],
    timings: { clone: 700, total: 2100, enrol: 5300 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    canStopStart: true,
    size: "2 cores, 4 GiB memory",
    ...overrides,
  };
}

function size(cores: number, memoryGiB: number, diskGiB: number | null = null) {
  return { cores, memoryGiB, diskGiB, words: `${cores} cores, ${memoryGiB} GiB memory${diskGiB === null ? "" : `, ${diskGiB} GiB disk`}` };
}

function kindView(id: string, label: string, description: string, cores: number, desktop: boolean): KindView {
  return {
    id,
    label,
    description,
    size: size(cores, cores * 2).words,
    presets: [
      { name: "small", ...size(cores, cores * 2) },
      { name: "medium", ...size(cores * 2, cores * 4) },
      { name: "large", ...size(cores * 4, cores * 8) },
    ],
    defaultPreset: "small",
    largest: size(cores * 8, cores * 16, 256),
    gpu: desktop,
    desktop,
    os: "linux",
    arch: id.includes("arm64") ? "arm64" : "x86_64",
    features: id === "linux-docker" ? ["docker"] : [],
    enrol: true,
    spares: { target: 0, ready: 0, making: 0 },
    admin: true,
    backends: ["Fake host"],
    forms: ["LXC"],
  };
}

const KINDS: KindView[] = [
  kindView("linux", "Linux", "For builds, servers, Docker and the agent's own work.", 2, false),
  kindView("linux-desktop", "Linux desktop", "A desktop on the GPU.", 4, true),
];

const BACKENDS: BackendView[] = [
  {
    id: "fake",
    type: "fake",
    label: "Fake host",
    nature: "virtual",
    state: "misconfigured",
    problems: ["Set the API URL.", "Set the API token."],
    fieldProblems: [
      { path: "backends.fake.url", message: "Set the API URL." },
      { path: "backends.fake.token", message: "Set the API token." },
    ],
    kinds: [],
    setup: { guide: "setup/fake/README.md", scripts: ["setup/fake/one.sh", "setup/fake/two.sh"] },
  },
];

/** RPC handlers over one thread's boxes, recording each change. */
function server(initial: BoxView[], options: { kinds?: KindView[]; failWith?: string; inUse?: ThreadOnBox[]; machines?: MachineEntry[]; runsOn?: PanelState["runsOn"]; config?: Partial<ConfigState>; checkWith?: CheckResult; applyWith?: ApplyResult; savedWith?: Problem[] } = {}) {
  let boxes = [...initial];
  let machines = [...(options.machines ?? [])];
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
    state: ({ threadId }): PanelState => ({ boxes: threadId === THREAD ? boxes : [], kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, runsOn: options.runsOn ?? null }),
    desktop: ({ box: ref }): DesktopState => ({ box: find(ref) ?? machines.find((entry) => entry.box.id === ref)?.box ?? null, desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH }),
    takeControl: ({ box: ref, viewer }) => change("takeControl", ref, (found) => ({ ...found, control: { owner: "human", holder: viewer } })),
    handBack: ({ box: ref }) => change("handBack", ref, (found) => ({ ...found, control: { owner: "agent", holder: null } })),
    desktops: () => boxes.filter((candidate) => candidate.desktop).map((found) => ({ threadId: THREAD, box: found, owner: "thread" as const })),
    // Your machines (036): `options.machines` to start with, kept as the tests add, stop, start and remove them.
    "machines.list": () => ({ machines, kinds: (options.kinds ?? KINDS).filter((kind) => kind.enrol) }),
    "machines.add": ({ kind, name }) => {
      changes.push(`machines.add ${kind}${name ? ` ${name}` : ""}`);
      if (options.failWith) return result(null);
      const made = box({ id: `box_m${machines.length + 1}`, name: name ?? "swift-crane", kind, kindLabel: KINDS.find((candidate) => candidate.id === kind)?.label ?? kind, state: "acquiring", createdAt: Date.now(), timings: {}, enrol: { state: "off", hostId: null, error: null } });
      machines = [...machines, { box: made, threads: [] }];
      return result(made);
    },
    "machines.remove": ({ box: ref, force }) => {
      const entry = machines.find((candidate) => candidate.box.id === ref || candidate.box.name === ref);
      if (entry && entry.threads.some((thread) => thread.running) && !force) return { box: entry.box, error: null, threads: entry.threads.filter((thread) => thread.running) };
      changes.push(`machines.remove${force ? " (forced)" : ""} ${ref}`);
      machines = machines.filter((candidate) => candidate !== entry);
      return result(null);
    },
    "machines.stop": ({ box: ref, force }) => {
      const entry = machines.find((candidate) => candidate.box.id === ref || candidate.box.name === ref);
      if (entry && entry.threads.some((thread) => thread.running) && !force) return { box: entry.box, error: null, threads: entry.threads.filter((thread) => thread.running) };
      changes.push(`machines.stop${force ? " (forced)" : ""} ${ref}`);
      machines = machines.map((candidate) => (candidate === entry ? { ...candidate, box: { ...candidate.box, state: "stopped" } } : candidate));
      return result(entry ? { ...entry.box, state: "stopped" } : null);
    },
    "machines.start": ({ box: ref }) => {
      changes.push(`machines.start ${ref}`);
      machines = machines.map((candidate) => (candidate.box.id === ref ? { ...candidate, box: { ...candidate.box, state: "ready" } } : candidate));
      return result(machines.find((candidate) => candidate.box.id === ref)?.box ?? null);
    },
    kinds: () => options.kinds ?? KINDS,
    thread: ({ box: ref, prompt }) => {
      changes.push(`thread ${ref} ${prompt}`);
      return { threadId: "thr_child", error: null };
    },
    acquire: ({ kind, size }) => {
      changes.push(`acquire ${kind}${size ? ` ${JSON.stringify(size)}` : ""}`);
      if (options.failWith) return result(null);
      const made = box({ id: `box_${boxes.length + 2}`, name: "new-box", kind, kindLabel: KINDS.find((candidate) => candidate.id === kind)?.label ?? kind, state: "acquiring", createdAt: Date.now(), timings: {}, enrol: { state: "off", hostId: null, error: null } });
      boxes = [...boxes, made];
      return result(made);
    },
    release: ({ box: ref, force }) =>
      options.inUse && !force ? { box: find(ref), error: null, threads: options.inUse } : change(force ? "release (forced)" : "release", ref, () => null),
    stop: ({ box: ref, force }) =>
      options.inUse && !force ? { box: find(ref), error: null, threads: options.inUse } : change(force ? "stop (forced)" : "stop", ref, (found) => ({ ...found, state: "stopped" })),
    start: ({ box: ref }) => change("start", ref, (found) => ({ ...found, state: "ready" })),
    refresh: ({ box: ref }) => change("refresh", ref, (found) => found),
    backends: () => BACKENDS,
    doctor: (): DoctorView => ({
      ok: false,
      sections: [
        {
          title: "Fake host on pve",
          report: {
            ok: false,
            summary: "Fake host 1.0",
            checks: [
              { id: "api", name: "API", status: "fail", detail: "No answer from the API.", fix: "Check the URL." },
              { id: "disk", name: "Disk", status: "ok", detail: "120 GiB free.", fix: null },
            ],
            notes: ["Install this public key in the templates: ssh-ed25519 AAAA bb-box"],
          },
        },
      ],
    }),
    "config.get": () => configState(options.config ?? {}),
    "config.check": ({ draft, test }): CheckResult => {
      changes.push(`check ${test ?? "-"} ${JSON.stringify(draft)}`);
      return options.checkWith ?? { problems: [], doctor: null };
    },
    "config.apply": ({ draft, revision }): ApplyResult => {
      changes.push(`apply ${revision} ${JSON.stringify(draft)}`);
      if (options.applyWith) return options.applyWith;
      applied = draft as ConfigDocument;
      return { ok: true, state: configState({ ...options.config, document: applied, revision: revision + 1 }), problems: options.savedWith ?? [] };
    },
  };
  return { handlers, changes };
}

let applied: ConfigDocument | null = null;

/** The configuration as the server gives it: one Proxmox-like driver set up with problems, one driver not set up, and two kinds. */
function configState(overrides: Partial<ConfigState> & { document?: ConfigDocument }): ConfigState {
  const document: ConfigDocument = overrides.document ??
    applied ?? {
      schema: 1,
      revision: 3,
      backends: [{ id: "fake", type: "fake", enabled: true, fields: { url: "https://192.0.2.10:8006", token: { set: false }, key: { set: true } }, warm: { linux: 1 } }],
      kinds: {},
      general: {},
    };
  const size = (cores: number, memoryGiB: number, diskGiB: number | null = null) => ({ cores, memoryMiB: memoryGiB * 1024, diskGiB });
  return {
    document,
    revision: document.revision,
    defaults: {
      general: { boxesPerThread: 0, enrol: true, defaultKind: "linux" },
      kinds: {
        linux: { enabled: true, presets: { small: size(2, 4), medium: size(4, 8), large: size(8, 16) }, default: "small", largest: size(16, 32, 256) },
        "linux-desktop": { enabled: true, presets: { small: size(4, 8), medium: size(8, 16), large: size(16, 32) }, default: "small", largest: size(32, 64, 256) },
      },
    },
    kinds: [
      { id: "linux", label: "Linux", description: "A Linux box.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [], drivers: ["fake", "other"], spares: { ready: 0, making: 0 } },
      { id: "linux-desktop", label: "Linux desktop", description: "A desktop on a GPU.", gpu: true, desktop: true, os: "linux", arch: "x86_64", features: [], drivers: ["fake"], spares: { ready: 0, making: 0 } },
    ],
    drivers: [
      {
        type: "fake",
        label: "Fake host",
        description: "Boxes on a fake host.",
        nature: "virtual",
        kinds: ["linux", "linux-desktop"],
        fields: [
          { key: "url", type: "string", label: "API URL", description: "For example https://192.0.2.10:8006.", group: "connection", default: "" },
          { key: "token", type: "string", label: "API token", secret: true, group: "credentials" },
          { key: "key", type: "string", label: "SSH key", secret: true, group: "credentials" },
          { key: "templates", type: "string", label: "Templates", description: "VMIDs, separated by spaces.", group: "boxes", default: "9100" },
          { key: "reserve", type: "number", label: "Memory kept free (MiB)", group: "advanced", default: 4096 },
        ],
        hostFields: [],
        setup: { guide: "setup/fake/README.md", scripts: ["setup/fake/one.sh"] },
      },
      {
        type: "other",
        label: "Other pool",
        description: "Your own machines over SSH.",
        nature: "real",
        kinds: ["linux"],
        fields: [{ key: "machines", type: "string", label: "Machines", group: "boxes", experimental_multiline: true, default: "" }],
        hostFields: [
          { key: "address", type: "string", label: "Address", group: "connection", default: "" },
          { key: "user", type: "string", label: "User", group: "connection", default: "" },
        ],
        setup: { guide: "setup/other/README.md", scripts: [] },
      },
    ],
    backends: document.backends.map((backend) => ({
      id: backend.id,
      type: backend.type,
      label: "Fake host",
      form: backend.type === "fake" ? "LXC" : "Physical",
      state: backend.enabled && (backend.fields.token as { set: boolean } | undefined)?.set === false ? "misconfigured" : backend.enabled ? "active" : "off",
      problems: backend.enabled && (backend.fields.token as { set: boolean } | undefined)?.set === false ? [{ path: "backends.fake.token", message: "Set the API token." }] : [],
      boxes: 2,
      kinds: backend.enabled ? ["linux", "linux-desktop"] : [],
      doctor: null,
    })),
    problems: document.backends.some((backend) => backend.enabled && (backend.fields.token as { set: boolean } | undefined)?.set === false) ? [{ path: "backends.fake.token", message: "Set the API token." }] : [],
    migrated: { at: 1_790_000_000_000, version: "0.2.0" },
    ...overrides,
  };
}

function panel(handlers: PluginRpcTestHandlers<Contract>) {
  const [action] = app.threadPanelActions;
  return renderSlot(action!, { threadId: THREAD, params: null }, { rpc: handlers, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
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
    facts: [
      { label: "GPU", value: "GPU-0a1b" },
      { label: "Display mode", value: "gpu" },
    ],
    ...overrides,
  });
}

/** Opens a row's menu with the keyboard, as Radix needs no pointer events for that. */
function openMenu(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.findByRole("menu");
}

test("the app registers the Boxes panel, a desktop tab, the Desktops page and the Backends settings section", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.title])).toEqual([
    ["boxes", "Box"],
    ["desktop", "Desktop"],
    ["terminal", "Terminal"],
  ]);
  expect(app.navPanels.map((page) => [page.id, page.title, page.path])).toEqual([["desktops", "Desktops", "desktop"]]);
  expect(app.settingsSections.map((section) => section.id)).toEqual(["configuration"]);
});

test("the status line says the state, the timings, BB enrolment and the display", () => {
  const now = Date.now();
  expect(statusOf(box(), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "BB machine in 5.3 s", "2 cores · 4 GiB"]);
  expect(statusOf(box({ enrol: { state: "enrolling", hostId: null, error: null } }), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "Joining BB…", "2 cores · 4 GiB"]);
  expect(statusOf(box({ enrol: { state: "failed", hostId: null, error: "no route" } }), now).items[1]).toEqual({ text: "Could not join BB", tone: "warn" });
  expect(statusOf(box({ enrol: { state: "off", hostId: null, error: null }, timings: {}, size: null }), now).items.map((item) => item.text)).toEqual(["Ready"]);
  expect(statusOf(box({ state: "acquiring", createdAt: now - 1400 }), now)).toEqual({ tone: "busy", items: [{ text: "Starting" }, { text: "1.4 s" }, { text: "2 cores · 4 GiB" }] });
  expect(statusOf(box({ state: "stopped", size: "8 cores, 16 GiB memory, 64 GiB disk" }), now)).toEqual({ tone: "off", items: [{ text: "Stopped" }, { text: "8 cores · 16 GiB · 64 GiB" }] });
  expect(statusOf(box({ state: "failed", error: "No GPU is left." }), now).items).toEqual([{ text: "Failed", tone: "danger" }]);
  expect(statusOf(box({ state: "gone" }), now).items.map((item) => item.text)).toEqual(["Gone", "deleted outside bb-box"]);
  expect(statusOf(desktopBox(), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "BB machine in 5.3 s", "2 cores · 4 GiB"]);
  expect(statusOf(desktopBox({ facts: [{ label: "Display mode", value: "cpu" }] }), now).items.at(-1)).toEqual({ text: "Display on the CPU", tone: "warn" });
  const held = desktopBox({ control: { owner: "human", holder: "viewer-1" } });
  expect(statusOf(held, now, new Set(["viewer-1"])).items.at(-1)).toEqual({ text: "You have control", tone: "fg" });
  expect(statusOf(held, now, new Set()).items.at(-1)).toEqual({ text: "Another viewer has control", tone: "fg" });
});

test("the panel lists the thread's boxes as rows, opens a row's details, and opens a desktop", async () => {
  const { handlers } = server([box(), desktopBox()]);
  const slot = panel(handlers);

  expect(await slot.findByText("calm-otter")).toBeTruthy();
  expect(slot.getByText("2 boxes")).toBeTruthy();
  expect(slot.getByText("bold-heron")).toBeTruthy();
  expect(slot.getAllByText("Ready in 2.1 s")).toHaveLength(2);
  expect(slot.getAllByText("BB machine in 5.3 s")).toHaveLength(2);
  expect(slot.getByText("GPU")).toBeTruthy();
  expect(slot.getAllByText("LXC")).toHaveLength(2);
  expect(slot.getByRole("button", { name: "New box" }).textContent).toBe("");
  expect(slot.queryByText("192.0.2.10")).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: "calm-otter: details" }));
  expect(slot.getByText("192.0.2.10")).toBeTruthy();
  expect(slot.getByText("2 cores, 4 GiB memory")).toBeTruthy();
  expect(slot.getByText("Fake host")).toBeTruthy();
  expect(slot.getByText("linux x86_64, with docker")).toBeTruthy();
  expect(slot.getByText("clone 0.7 s · total 2.1 s · BB enrolment 5.3 s")).toBeTruthy();
  expect(slot.getByText("12 minutes ago")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "calm-otter: details" }));
  expect(slot.queryByText("192.0.2.10")).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: "Open desktop" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "bold-heron", params: { box: "box_2" } } }]);

  const menu = await openMenu(slot.getByRole("button", { name: "bold-heron actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Open desktop",
    "Open desktop in a browser tab",
    "Open terminal",
    "Copy address",
    "New thread on this box…",
    "Stop",
    "Check now",
    "Release…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open desktop in a browser tab" }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "/plugins/bb-box/desktop/thr_panel/box_2" });
});

test("the panel makes a box of the chosen kind, and remembers the kind", async () => {
  const { handlers, changes } = server([]);
  const slot = panel(handlers);

  expect(await slot.findByText("No boxes yet")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const form = await screen.findByRole("radiogroup", { name: "Kind" });
  expect(within(form).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(within(form).getByText("GPU")).toBeTruthy();
  expect(within(form).getAllByText("LXC")).toHaveLength(2);
  fireEvent.click(within(form).getByRole("radio", { name: /^LinuxDesktop/ }));
  expect(screen.getByText("4 cores · 8 GiB memory · base disk")).toBeTruthy();
  expect(screen.queryByText(/A desktop on the GPU/)).toBeNull();
  const sizes = screen.getByRole("radiogroup", { name: "Size" });
  expect(within(sizes).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual(["Small:true", "Medium:false", "Large:false", "Custom:false"]);
  fireEvent.click(within(sizes).getByRole("radio", { name: "Large" }));
  expect(screen.getByText("16 cores · 32 GiB memory · base disk")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create" }));

  expect(await slot.findByText("new-box")).toBeTruthy();
  expect(changes).toEqual(['acquire linux-desktop {"preset":"large"}']);
  expect(slot.getByText("Starting")).toBeTruthy();
  expect(slot.getByText("1 box")).toBeTruthy();
  expect(JSON.parse(window.localStorage.getItem("bb-box:new-box") ?? "{}")).toEqual({ kind: "linux-desktop", size: "large" });
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());

  // The default preset sends no size at all.
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: "Small" }));
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(changes).toEqual(['acquire linux-desktop {"preset":"large"}', "acquire linux-desktop"]));
});

test("the New box popover marks a kind with a spare ready as Ready now (#121)", async () => {
  const [linux, desktop] = KINDS;
  const kinds = [{ ...linux!, spares: { target: 1, ready: 1, making: 0 } }, { ...desktop!, spares: { target: 1, ready: 0, making: 1 } }];
  const slot = panel(server([], { kinds }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const kindGroup = await screen.findByRole("radiogroup", { name: "Kind" });
  const options = within(kindGroup).getAllByRole("radio");
  expect(options.map((option) => within(option).queryByText("Ready now") !== null)).toEqual([true, false]);
});

test("a kind's spares read as ready, part ready or being made, and say nothing while none is coming (#121)", () => {
  expect(sparesWords(0, { ready: 0, making: 0 })).toEqual([]);
  expect(sparesWords(2, { ready: 2, making: 0 })).toEqual(["2 spares ready"]);
  expect(sparesWords(1, { ready: 1, making: 0 })).toEqual(["1 spare ready"]);
  expect(sparesWords(2, { ready: 1, making: 1 })).toEqual(["1 of 2 spares ready"]);
  expect(sparesWords(2, { ready: 0, making: 2 })).toEqual(["2 spares, being made"]);
  expect(sparesWords(2, { ready: 0, making: 0 })).toEqual([]);
});

test("a custom size starts from the preset in view, sends only its filled fields, and refuses a field that is not a whole number", async () => {
  const { handlers, changes } = server([]);
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const sizes = await screen.findByRole("radiogroup", { name: "Size" });
  fireEvent.click(within(sizes).getByRole("radio", { name: "Medium" }));
  fireEvent.click(within(sizes).getByRole("radio", { name: "Custom" }));
  const cores = screen.getByLabelText(/^Cores/) as HTMLInputElement;
  const memory = screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement;
  const disk = screen.getByLabelText(/^Disk, GiB/) as HTMLInputElement;
  expect([cores.value, memory.value, disk.value, disk.placeholder]).toEqual(["4", "8", "", "base"]);
  expect(screen.getByText("up to 16")).toBeTruthy();
  expect(screen.getByText("up to 256")).toBeTruthy();

  fireEvent.change(cores, { target: { value: "six" } });
  expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(cores, { target: { value: "6" } });
  fireEvent.change(memory, { target: { value: "12" } });

  // Custom fields belong to the kind: another kind starts from its own preset, and the edits come back with the kind.
  const kinds = screen.getByRole("radiogroup", { name: "Kind" });
  fireEvent.click(within(kinds).getByRole("radio", { name: /^LinuxDesktop/ }));
  expect([(screen.getByLabelText(/^Cores/) as HTMLInputElement).value, (screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement).value]).toEqual(["8", "16"]);
  expect(screen.getByText("up to 32")).toBeTruthy();
  fireEvent.click(within(kinds).getAllByRole("radio")[0]!);
  expect([(screen.getByLabelText(/^Cores/) as HTMLInputElement).value, (screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement).value]).toEqual(["6", "12"]);

  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await waitFor(() => expect(changes).toEqual(['acquire linux {"cores":6,"memoryGiB":12}']));
  expect(JSON.parse(window.localStorage.getItem("bb-box:new-box") ?? "{}")).toEqual({ kind: "linux", size: "custom", custom: { linux: { cores: "6", memoryGiB: "12", diskGiB: "" } } });
});

test("a refused box stays in the form with the reason", async () => {
  const { handlers } = server([], { failWith: "pve has no memory left. Release a box you no longer need." });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create" }));
  expect((await screen.findByRole("alert")).textContent).toBe("pve has no memory left. Release a box you no longer need.");
  expect(screen.getByRole("radiogroup", { name: "Kind" })).toBeTruthy();
});

test("releasing a box asks first", async () => {
  const { handlers, changes } = server([box()]);
  const slot = panel(handlers);
  await slot.findByText("calm-otter");

  let menu = await openMenu(slot.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Release…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Release calm-otter?")).toBeTruthy();
  expect(within(dialog).getByText("Its disk and everything on it will be deleted. Copy out anything you want to keep first.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(changes).toEqual([]);

  menu = await openMenu(slot.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Release…" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Release" }));
  expect(await slot.findByText("No boxes yet")).toBeTruthy();
  expect(changes).toEqual(["release box_1"]);
});

test("a box a thread runs on is released or stopped only once the user says so", async () => {
  const { handlers, changes } = server([box()], { inUse: [{ id: "thr_worker", title: "Build the app", running: true }] });
  const slot = panel(handlers);
  await slot.findByText("calm-otter");

  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Stop calm-otter anyway?")).toBeTruthy();
  expect(within(dialog).getByText("Build the app is working on it, and would lose its machine.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(changes).toEqual([]);

  const menu = await openMenu(slot.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Release…" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Release" }));
  dialog = await screen.findByRole("alertdialog", {}, { timeout: 2000 });
  await within(dialog).findByText("Release calm-otter anyway?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Release anyway" }));
  expect(await slot.findByText("No boxes yet")).toBeTruthy();
  expect(changes).toEqual(["release (forced) box_1"]);
});

test("the panel stops and starts a box that can, and not one that cannot", async () => {
  const { handlers, changes } = server([box()]);
  const slot = panel(handlers);

  fireEvent.click(await slot.findByRole("button", { name: "Stop" }));
  expect(await slot.findByText("Stopped")).toBeTruthy();
  fireEvent.click(await slot.findByRole("button", { name: "Start" }));
  await slot.findByRole("button", { name: "Stop" });
  expect(changes).toEqual(["stop box_1", "start box_1"]);

  cleanup();
  const fixed = panel(server([box({ id: "box_9", name: "real-box", canStopStart: false })]).handlers);
  await fixed.findByText("real-box");
  expect(fixed.queryByRole("button", { name: "Stop" })).toBeNull();
  const menu = await openMenu(fixed.getByRole("button", { name: "real-box actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open terminal", "Copy address", "New thread on this box…", "Check now", "Release…"]);
});

test("a row starts a child thread on its box, and opens it", async () => {
  const { handlers, changes } = server([box()]);
  const slot = panel(handlers);
  await slot.findByText("calm-otter");

  const menu = await openMenu(slot.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "New thread on this box…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("New thread on calm-otter")).toBeTruthy();
  const start = within(dialog).getByRole("button", { name: "Start thread" }) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Prompt" }), { target: { value: "Run uname -a" } });
  fireEvent.click(start);
  await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_child" }));
  expect(changes).toEqual(["thread box_1 Run uname -a"]);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("a box that is not a BB machine offers no thread", async () => {
  const slot = panel(server([box({ enrol: { state: "off", hostId: null, error: null } })]).handlers);
  await slot.findByText("calm-otter");
  const menu = await openMenu(slot.getByRole("button", { name: "calm-otter actions" }));
  expect(within(menu).queryByRole("menuitem", { name: "New thread on this box…" })).toBeNull();
});

test("the panel shows why a change failed", async () => {
  const { handlers } = server([box()], { failWith: "Stopping the box failed: the host did not answer." });
  const slot = panel(handlers);

  fireEvent.click(await slot.findByRole("button", { name: "Stop" }));
  expect((await slot.findByRole("alert")).textContent).toBe("Stopping the box failed: the host did not answer.");
});

test("the panel says so when no backend is on, and links the settings", async () => {
  const slot = panel(server([], { kinds: [] }).handlers);
  expect(await slot.findByText("BB Box is not set up yet")).toBeTruthy();
  expect(slot.queryByRole("button", { name: "New box" })).toBeNull();
  expect(slot.getByRole("link", { name: /Open BB Box settings/ }).getAttribute("href")).toBe("/settings/plugins/bb-box");
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

function settings(handlers: PluginRpcTestHandlers<Contract>) {
  const [section] = app.settingsSections;
  return renderSlot(section!, {}, { rpc: handlers, pluginId: "bb-box" });
}

test("the settings page lists each backend's state, the kinds and the general settings", async () => {
  const slot = settings(server([]).handlers);
  expect(await slot.findByText("Fake host")).toBeTruthy();
  expect(slot.getByText("Needs setting up")).toBeTruthy();
  expect(slot.getByText("Set the API token.")).toBeTruthy();
  expect(slot.getByText("2 boxes")).toBeTruthy();
  expect(slot.getByText("Other pool")).toBeTruthy();
  expect(slot.getByText("Not set up")).toBeTruthy();
  expect(slot.getByText("Your own machines over SSH.")).toBeTruthy();
  expect((slot.getByRole("switch", { name: "Fake host on" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
  expect((slot.getByRole("switch", { name: "Other pool on" }) as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");

  // Kinds are named by their OS; the badges say the rest.
  expect(slot.getAllByText("Linux")).toHaveLength(3);
  expect(slot.getByText("Desktop")).toBeTruthy();
  expect(slot.getByText("GPU")).toBeTruthy();
  expect(slot.getAllByText("LXC")).toHaveLength(2);
  expect(slot.queryByText("Physical")).toBeNull();
  expect(slot.getAllByText("From Fake host")).toHaveLength(2);
  expect(slot.getByText("1 warm on Fake host")).toBeTruthy();
  expect(slot.getByText("Small 2 cores · 4 GiB · base disk (default) · Medium 4 cores · 8 GiB · base disk · Large 8 cores · 16 GiB · base disk · up to 16 cores · 32 GiB · 256 GiB")).toBeTruthy();

  expect(slot.getByRole("combobox", { name: "Default kind" }).textContent).toBe("Linux");
  expect((slot.getByRole("textbox", { name: "Boxes per thread" }) as HTMLInputElement).value).toBe("0");
  expect(slot.getByRole("switch", { name: "Enrol boxes as BB machines" }).getAttribute("aria-checked")).toBe("true");
  expect(slot.queryByText(/moved its settings/)).toBeNull();
});

test("a backend's switch saves the document with the switch changed, and a problem shows", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("switch", { name: "Fake host on" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  const [method, revision, draft] = [changes[0]!.split(" ")[0], changes[0]!.split(" ")[1], JSON.parse(changes[0]!.slice(changes[0]!.indexOf("{")))];
  expect([method, revision]).toEqual(["apply", "3"]);
  expect(draft.backends[0]).toEqual({ id: "fake", type: "fake", enabled: false, fields: { url: "https://192.0.2.10:8006", token: { set: false }, key: { set: true } }, warm: { linux: 1 } });
  expect(await slot.findByText("Off")).toBeTruthy();

  // A driver that is not set up opens its setup instead of switching on.
  fireEvent.click(slot.getByRole("switch", { name: "Other pool on" }));
  expect(await slot.findByRole("heading", { name: "Hosts" }).catch(() => slot.findByText("Hosts"))).toBeTruthy();
  expect(changes).toHaveLength(1);
});

test("a backend's setup shows its fields by group with problems, saves the whole document, and checks a draft", async () => {
  const { handlers, changes } = server([], {
    checkWith: { problems: [], doctor: { ok: true, summary: "Fake host 1.0", checks: [{ id: "api", name: "API", status: "ok", detail: "Answers.", fix: null }], notes: ["Install this key: ssh-ed25519 AAAA"] } },
  });
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake host" }));
  const guideLink = slot.getByRole("link", { name: "Fake host setup guide" });
  expect(guideLink.getAttribute("href")).toBe("https://github.com/moonstead/bb-box/blob/main/setup/fake/README.md");
  expect(guideLink.closest("p")!.textContent).toBe("Follow the Fake host setup guide; it gives the values for this form. Its script: one.sh.");
  expect(slot.getByText("Connection")).toBeTruthy();
  expect(slot.getByText("Credentials")).toBeTruthy();
  expect(slot.getByText("Boxes")).toBeTruthy();
  const url = slot.getByLabelText(/API URL/) as HTMLInputElement;
  expect(url.value).toBe("https://192.0.2.10:8006");
  expect((slot.getByLabelText(/Templates/) as HTMLInputElement).placeholder).toBe("9100");
  expect(slot.getAllByText("secret")).toHaveLength(2);
  expect(slot.getByText("not set")).toBeTruthy();
  expect(slot.getByText("set")).toBeTruthy();
  expect(slot.getAllByRole("alert").map((alert) => alert.textContent)).toContain("Set the API token.");
  expect(slot.queryByLabelText(/Memory kept free/)).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Advanced" }));
  expect((slot.getByLabelText(/Memory kept free/) as HTMLInputElement).placeholder).toBe("4096");

  fireEvent.change(slot.getByLabelText(/API token/), { target: { value: "s3cret" } });
  fireEvent.click(slot.getByRole("button", { name: "Clear" }));
  expect(slot.getByText("Will be cleared when you save.")).toBeTruthy();
  fireEvent.change(slot.getByLabelText(/Memory kept free/), { target: { value: "2048" } });

  fireEvent.click(slot.getByRole("button", { name: "Check" }));
  expect(await slot.findByText("Answers.")).toBeTruthy();
  expect(slot.getByText("Install this key: ssh-ed25519 AAAA")).toBeTruthy();
  expect(slot.getByText(/checked just now, against the form/)).toBeTruthy();
  const check = JSON.parse(changes[0]!.slice(changes[0]!.indexOf("{")));
  expect(changes[0]!.startsWith("check fake ")).toBe(true);
  expect(check.backends[0].fields).toEqual({ url: "https://192.0.2.10:8006", token: "s3cret", key: null, reserve: 2048 });

  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(changes[1]!.startsWith("apply 3 ")).toBe(true);
  const saved = JSON.parse(changes[1]!.slice(changes[1]!.indexOf("{")));
  expect(saved.backends[0]).toEqual({ id: "fake", type: "fake", enabled: true, fields: { url: "https://192.0.2.10:8006", token: "s3cret", key: null, reserve: 2048 }, warm: { linux: 1 } });
  await waitFor(() => expect(slot.queryByRole("button", { name: "Save" })).toBeNull());
});

test("an empty field another backend fills says where its value comes from, until its set is filled here", async () => {
  const inherits = (set: string[]) => ({ from: "fake", label: "Fake host", set });
  const windows: ConfigState["drivers"][number] = {
    type: "win",
    label: "Fake Windows",
    description: "Windows boxes on the fake host.",
    nature: "virtual",
    kinds: ["linux"],
    fields: [
      { key: "url", type: "string", label: "API URL", group: "connection", default: "", inherits: inherits(["url", "key"]) },
      { key: "token", type: "string", label: "API token", secret: true, group: "credentials", inherits: inherits(["token"]) },
      { key: "key", type: "string", label: "SSH key", secret: true, group: "credentials", inherits: inherits(["url", "key"]) },
    ],
    hostFields: [],
    setup: { guide: "setup/win/README.md", scripts: [] },
  };
  const slot = settings(server([], { config: { drivers: [...configState({}).drivers, windows] } }).handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake Windows" }));
  const url = slot.getByLabelText(/API URL/) as HTMLInputElement;
  expect(url.value).toBe("");
  expect(url.placeholder).toBe("https://192.0.2.10:8006");
  // The fake host has a URL and a key, but no token.
  expect(slot.getAllByText("from Fake host")).toHaveLength(2);
  expect(slot.getAllByText("not set")).toHaveLength(1);

  // A URL set here takes its set with it: the key is this backend's now.
  fireEvent.change(url, { target: { value: "https://192.0.2.20:8006" } });
  expect(slot.queryByText("from Fake host")).toBeNull();
  expect(slot.getAllByText("not set")).toHaveLength(2);
});

test("a refused save shows each problem at its field, and a stale revision reloads", async () => {
  const { handlers } = server([], { applyWith: { ok: false, reason: "problems", problems: [{ path: "backends.fake.url", message: "Use an https URL." }, { path: "backends.fake", message: "bb-box runs one Fake host backend for now." }] } });
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake host" }));
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  expect(await slot.findByText("Use an https URL.")).toBeTruthy();
  expect(slot.getByText("bb-box runs one Fake host backend for now.")).toBeTruthy();
  cleanup();

  const stale = settings(server([], { applyWith: { ok: false, reason: "revision", state: configState({}) } }).handlers);
  fireEvent.click(await stale.findByRole("switch", { name: "Fake host on" }));
  expect(await stale.findByText(/Someone saved the configuration first/)).toBeTruthy();
});

test("a backend that is off saves part way, and the form says what is still missing", async () => {
  const { handlers } = server([], { savedWith: [{ path: "backends.fake.url", message: "Set the API URL." }] });
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake host" }));
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  expect(await slot.findByText("Saved. It stays off until these are fixed.")).toBeTruthy();
  expect(slot.getByText("Set the API URL.")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Save" })).toBeTruthy();
});

test("a backend that is off offers Save and turn on, which saves it on in one go, and a refusal saves nothing", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake host" }));
  expect(slot.queryByRole("button", { name: "Save and turn on" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Set up Other pool" }));
  fireEvent.click(await slot.findByRole("button", { name: "Save and turn on" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  const saved = JSON.parse(changes[0]!.slice(changes[0]!.indexOf("{")));
  expect(saved.backends.find((backend: { id: string }) => backend.id === "other")).toMatchObject({ id: "other", type: "other", enabled: true });
  await waitFor(() => expect(slot.queryByRole("button", { name: "Save and turn on" })).toBeNull());
  cleanup();
  applied = null;

  const refused = settings(server([], { applyWith: { ok: false, reason: "problems", problems: [{ path: "backends.other.machines", message: "Add a machine." }] } }).handlers);
  fireEvent.click(await refused.findByRole("button", { name: "Set up Other pool" }));
  fireEvent.click(refused.getByRole("button", { name: "Save and turn on" }));
  expect(await refused.findByText("Add a machine.")).toBeTruthy();
  expect(refused.getByText("Not saved: it cannot be on with these. Save keeps it off while you fix them.")).toBeTruthy();
  expect(refused.getByRole("button", { name: "Save and turn on" })).toBeTruthy();
});

test("a kind's editor saves its presets, default, largest size, warm counts and spares as changes from the shipped sizes", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  const edits = await slot.findAllByRole("button", { name: "Edit" });
  fireEvent.click(edits[0]!);
  expect((slot.getByRole("textbox", { name: "Small cores" }) as HTMLInputElement).value).toBe("2");
  expect((slot.getByRole("textbox", { name: "Largest disk" }) as HTMLInputElement).value).toBe("256");
  fireEvent.change(slot.getByRole("textbox", { name: "Large cores" }), { target: { value: "12" } });
  fireEvent.change(slot.getByRole("textbox", { name: "Large memory" }), { target: { value: "24" } });
  fireEvent.click(slot.getByRole("radio", { name: "Medium is the default" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Warm Linux boxes on Fake host" }), { target: { value: "2" } });
  expect((slot.getByRole("textbox", { name: "Spare Linux boxes" }) as HTMLInputElement).value).toBe("0");
  fireEvent.change(slot.getByRole("textbox", { name: "Spare Linux boxes" }), { target: { value: "1" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  const saved = JSON.parse(changes[0]!.slice(changes[0]!.indexOf("{")));
  expect(saved.kinds).toEqual({ linux: { spares: 1, presets: { large: { cores: 12, memoryMiB: 24576, diskGiB: null } }, default: "medium" } });
  expect(saved.backends[0].warm).toEqual({ linux: 2 });

  fireEvent.click(slot.getByRole("switch", { name: "Linux desktop on" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(JSON.parse(changes[1]!.slice(changes[1]!.indexOf("{"))).kinds["linux-desktop"]).toEqual({ enabled: false });
});

test("the general settings save at once, leaving out a value at its default", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  const limit = await slot.findByRole("textbox", { name: "Boxes per thread" });
  fireEvent.change(limit, { target: { value: "3" } });
  fireEvent.blur(limit);
  await waitFor(() => expect(changes).toHaveLength(1));
  expect(JSON.parse(changes[0]!.slice(changes[0]!.indexOf("{"))).general).toEqual({ boxesPerThread: 3 });
  fireEvent.click(slot.getByRole("switch", { name: "Enrol boxes as BB machines" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(JSON.parse(changes[1]!.slice(changes[1]!.indexOf("{"))).general).toEqual({ boxesPerThread: 3, enrol: false });
});

function desktopTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_2") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a desktop that cannot be resized says only that you have control, and noVNC does not resize it", async () => {
  const { handlers } = server([desktopBox({ kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: false } })]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  expect(await slot.findByText("You have control.")).toBeTruthy();
  expect(slot.queryByText(/follows this tab's size/)).toBeNull();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([false, false]);
});

test("a desktop tab shows the box through the relay, and takes and hands back control", async () => {
  const { handlers, changes } = server([desktopBox()]);
  const slot = desktopTab(handlers);

  expect(await slot.findByText("Connecting to the desktop…")).toBeTruthy();
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  const url = new URL(client!.url);
  expect(url.protocol).toBe("ws:");
  expect(url.pathname).toBe(DESKTOP_PATH);
  expect(url.searchParams.get("box")).toBe("box_2");
  const viewer = url.searchParams.get("viewer")!;
  expect(viewer).toMatch(/^[0-9a-f]{24}$/);
  expect(client!.options).toEqual({ shared: true });
  expect([client!.viewOnly, client!.scaleViewport]).toEqual([true, true]);
  expect(slot.getByText("Connecting…")).toBeTruthy();
  expect((slot.getByRole("button", { name: "Take control" }) as HTMLButtonElement).disabled).toBe(true);

  act(() => void client!.dispatchEvent(new Event("connect")));
  expect(slot.queryByText("Connecting to the desktop…")).toBeNull();
  expect(slot.getByText("The agent has control.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  expect(await slot.findByText("You have control. The desktop follows this tab's size.")).toBeTruthy();
  expect(slot.inspection.rpcCalls.find((call) => call.method === "takeControl")?.input).toEqual({ threadId: THREAD, box: "box_2", viewer });
  expect([client!.viewOnly, client!.resizeSession, client!.focused]).toEqual([false, true, 1]);
  expect(slot.getByTestId("control-ring")).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Hand back to the agent" }));
  expect(await slot.findByText("The agent has control.")).toBeTruthy();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([true, false]);
  expect(slot.queryByTestId("control-ring")).toBeNull();
  expect(changes).toEqual(["takeControl box_2", "handBack box_2"]);
});

test("the tab the agent took control back from says so, and takes it again; another tab does not (038)", async () => {
  const { handlers } = server([desktopBox()]);
  // No RPC makes the agent's take: the server shows it in the box's control.
  let takenFrom: string | undefined;
  const live: PluginRpcTestHandlers<Contract> = {
    ...handlers,
    desktop: async (input): Promise<DesktopState> => {
      const state = await handlers.desktop!(input);
      return takenFrom && state.box ? { ...state, box: { ...state.box, control: { owner: "agent", holder: null, takenFrom } } } : state;
    },
    takeControl: (input) => {
      takenFrom = undefined;
      return handlers.takeControl!(input);
    },
  };
  const slot = desktopTab(live);
  await slot.findByText("Connecting to the desktop…");
  const other = desktopTab(live);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
  const [mine, theirs] = [within(slot.container), within(other.container)];
  const [client, otherClient] = novnc.FakeRfb.made;
  const viewer = new URL(client!.url).searchParams.get("viewer")!;
  act(() => {
    client!.dispatchEvent(new Event("connect"));
    otherClient!.dispatchEvent(new Event("connect"));
  });
  fireEvent.click(mine.getByRole("button", { name: "Take control" }));
  expect(await mine.findByText("You have control. The desktop follows this tab's size.")).toBeTruthy();

  takenFrom = viewer;
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  await other.behavior.emitRealtime("changed", { threadId: THREAD });
  expect(await mine.findByText("The agent took control.")).toBeTruthy();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([true, false]);
  expect(mine.queryByTestId("control-ring")).toBeNull();
  expect(await theirs.findByText("The agent has control.")).toBeTruthy();
  expect(theirs.getByRole("button", { name: "Take control" })).toBeTruthy();

  fireEvent.click(mine.getByRole("button", { name: "Take control again" }));
  expect(await mine.findByText("You have control. The desktop follows this tab's size.")).toBeTruthy();
  expect(slot.inspection.rpcCalls.filter((call) => call.method === "takeControl").map((call) => call.input)).toEqual([
    { threadId: THREAD, box: "box_2", viewer },
    { threadId: THREAD, box: "box_2", viewer },
  ]);
});

test("a desktop tab keeps its viewer ID when it remounts, and two tabs never share one", async () => {
  const { handlers } = server([desktopBox()]);
  const first = desktopTab(handlers);
  await first.findByText("Connecting to the desktop…");
  const second = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
  const [a, b] = novnc.FakeRfb.made.map((client) => new URL(client.url).searchParams.get("viewer"));
  expect(a).not.toBe(b);

  first.unmount();
  second.unmount();
  expect(novnc.FakeRfb.made.map((client) => client.disconnected)).toEqual([false, false]);
  const again = desktopTab(handlers);
  // The tab takes back the kept session for its viewer ID at once, before its state has refetched: no new client, no handshake, no blank frame.
  expect(again.getByTestId("desktop-screen").contains(novnc.FakeRfb.made[1]!.target)).toBe(true);
  expect(again.getByText("Connecting…")).toBeTruthy();
  await again.findByText("Connecting to the desktop…");
  expect(novnc.FakeRfb.made).toHaveLength(2);
  expect(new URL(novnc.FakeRfb.made[1]!.url).searchParams.get("viewer")).toBe(b);
});

test("a hidden desktop tab keeps its stream, hands control back after a minute, and closes after ten", async () => {
  const { handlers, changes } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await slot.findByText("Connecting to the desktop…");
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText("You have control. The desktop follows this tab's size.");

  vi.useFakeTimers();
  slot.unmount();
  expect(client!.disconnected).toBe(false);
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS + 50);
  expect(changes).toEqual(["takeControl box_2", "handBack box_2"]);
  expect(client!.disconnected).toBe(false);
  vi.advanceTimersByTime(HIDDEN_MS);
  expect(client!.disconnected).toBe(true);
  vi.useRealTimers();

  // Coming back within the minute keeps control.
  const back = desktopTab(handlers);
  await back.findByText("Connecting to the desktop…");
  const [, next] = novnc.FakeRfb.made;
  act(() => void next!.dispatchEvent(new Event("connect")));
  fireEvent.click(back.getByRole("button", { name: "Take control" }));
  await back.findByText("You have control. The desktop follows this tab's size.");
  vi.useFakeTimers();
  back.unmount();
  vi.advanceTimersByTime(HAND_BACK_MS / 2);
  const returned = desktopTab(handlers);
  // The tab's state loads over promises; give the fake clock a few turns before the minute runs out.
  for (let turn = 0; turn < 5; turn++) await act(() => vi.advanceTimersByTimeAsync(5));
  expect(returned.getByText("You have control. The desktop follows this tab's size.")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS);
  expect(changes).toEqual(["takeControl box_2", "handBack box_2", "takeControl box_2"]);
  expect(novnc.FakeRfb.made).toHaveLength(2);
  returned.unmount();
});

test("a desktop tab shows why the desktop refused it, and reconnects", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await slot.findByText("Connecting to the desktop…");
  const [client] = novnc.FakeRfb.made;
  act(() => {
    client!.dispatchEvent(new CustomEvent("securityfailure", { detail: { status: 1, reason: "The box's desktop refused its VNC password." } }));
    client!.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } }));
  });
  expect(slot.getByText("The box's desktop refused its VNC password.")).toBeTruthy();
  expect(slot.getByText("Trying again in 1 s")).toBeTruthy();
  expect(slot.getByText("Disconnected")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Reconnect now" }));
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
});

test("a desktop tab says when its box is not running or gone, and starts a stopped box", async () => {
  const { handlers, changes } = server([desktopBox({ state: "stopped" })]);
  const stopped = desktopTab(handlers);
  expect(await stopped.findByText("bold-heron is stopped.")).toBeTruthy();
  expect(novnc.FakeRfb.made).toEqual([]);
  fireEvent.click(stopped.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(changes).toEqual(["start box_2"]));
  expect(await stopped.findByText("Connecting to the desktop…")).toBeTruthy();
  cleanup();
  const gone = desktopTab(server([]).handlers);
  expect(await gone.findByText("This box has been released.")).toBeTruthy();
});

test("a desktop tab opened bare lists the thread's desktops", async () => {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  const slot = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box(), desktopBox()]).handlers, pluginId: "bb-box" });
  expect(await slot.findByText("bold-heron")).toBeTruthy();
  expect(slot.queryByText("calm-otter")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Open" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "bold-heron", params: { box: "box_2" } } }]);
});

test("the Desktops page lists every desktop box with its thread, and shows one for a browser tab", async () => {
  const { handlers } = server([desktopBox()]);
  const [page] = app.navPanels;
  const list = renderSlot(page!, { subPath: "" }, { rpc: handlers, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
  expect(await list.findByText("bold-heron")).toBeTruthy();
  expect(list.getByText("Linux")).toBeTruthy();
  expect(list.getByText("Desktop")).toBeTruthy();
  expect(list.getByText("The agent has control")).toBeTruthy();
  expect(await list.findByText("UI thread")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Open" }));
  fireEvent.click(list.getByRole("button", { name: "Open thread" }));
  expect(list.inspection.navigateCalls).toEqual([
    { method: "toPluginPanel", path: "desktop", options: { subPath: "thr_panel/box_2" } },
    { method: "toThread", threadId: THREAD },
  ]);
  cleanup();

  const one = renderSlot(page!, { subPath: "thr_panel/box_2" }, { rpc: handlers, pluginId: "bb-box" });
  expect(await one.findByText("Connecting to the desktop…")).toBeTruthy();
  fireEvent.click(one.getByRole("button", { name: "Back to desktops" }));
  expect(one.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "desktop", options: { subPath: "" } }]);
});

function terminalTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_1") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "terminal");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a row opens a box's terminal tab, named after the box", async () => {
  const slot = panel(server([box()]).handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Open terminal" }));
  expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "terminal", title: "Terminal: calm-otter", params: { box: "box_1" } } }]);

  cleanup();
  const stopped = panel(server([box({ state: "stopped" })]).handlers);
  await stopped.findByText("calm-otter");
  expect(stopped.queryByRole("button", { name: "Open terminal" })).toBeNull();
});

test("the terminal tab streams the shell over the plugin's socket, sends what is typed and the size, and offers a new shell when it ends", async () => {
  const { handlers } = server([box()]);
  const slot = terminalTab(handlers);
  await waitFor(() => expect(FakeSocket.made).toHaveLength(1));
  const [socket] = FakeSocket.made;
  const url = new URL(socket!.url);
  expect(url.pathname).toBe(TERMINAL_PATH);
  expect(url.protocol).toBe("ws:");
  expect(url.searchParams.get("box")).toBe("box_1");
  expect(url.searchParams.get("cols")).toBe("80");
  expect(url.searchParams.get("rows")).toBe("24");
  const session = url.searchParams.get("session")!;
  expect(session).toMatch(/^[0-9a-f]{24}$/);
  expect(window.sessionStorage.getItem("bb-box:terminal:box_1")).toBe(session);
  expect(slot.getByText("Connecting…")).toBeTruthy();

  act(() => socket!.open());
  expect(slot.getByText("Connected")).toBeTruthy();
  act(() => socket!.receive("box@calm-otter:~$ "));
  const [view] = xterm.FakeTerminal.made;
  expect(view!.written.join("")).toBe("box@calm-otter:~$ ");

  act(() => view!.data!("ls\r"));
  expect(new TextDecoder().decode(socket!.sent[0] as Uint8Array)).toBe("ls\r");

  vi.useFakeTimers();
  act(() => view!.resized!({ cols: 100, rows: 30 }));
  act(() => view!.resized!({ cols: 120, rows: 40 }));
  act(() => {
    vi.advanceTimersByTime(150);
  });
  vi.useRealTimers();
  expect(socket!.sent.filter((frame) => typeof frame === "string")).toEqual([JSON.stringify({ type: "resize", cols: 120, rows: 40 })]);

  act(() => socket!.end(1000, "The shell exited."));
  expect(slot.getByText("The terminal has ended.")).toBeTruthy();
  expect(slot.getByText("The shell exited.")).toBeTruthy();
  expect(slot.getByText("Ended")).toBeTruthy();

  fireEvent.click(slot.getAllByRole("button", { name: "Start a new shell" })[0]!);
  await waitFor(() => expect(FakeSocket.made).toHaveLength(2));
  const next = new URL(FakeSocket.made[1]!.url).searchParams.get("session")!;
  expect(next).not.toBe(session);
  expect(window.sessionStorage.getItem("bb-box:terminal:box_1")).toBe(next);
});

test("a remounted terminal tab attaches to the same shell, and a stopped box offers Start", async () => {
  const { handlers } = server([box()]);
  const first = terminalTab(handlers);
  await waitFor(() => expect(FakeSocket.made).toHaveLength(1));
  const session = new URL(FakeSocket.made[0]!.url).searchParams.get("session");
  first.unmount();
  expect(FakeSocket.made[0]!.readyState).toBe(0);
  act(() => FakeSocket.made[0]!.open());
  const again = terminalTab(handlers);
  // The tab takes back the kept shell at once, before its state has refetched: the same socket, already connected, in the page.
  expect(again.getByTestId("terminal-screen").contains(xterm.FakeTerminal.made[0]!.target)).toBe(true);
  expect(again.getByText("Connected")).toBeTruthy();
  expect(again.getByTestId("terminal-screen").className).not.toContain("invisible");
  expect(FakeSocket.made).toHaveLength(1);
  expect(session).toBeTruthy();
  vi.useFakeTimers();
  again.unmount();
  vi.advanceTimersByTime(HIDDEN_MS + 50);
  expect(FakeSocket.made[0]!.readyState).toBe(3);
  vi.useRealTimers();

  // Another box, so the tab does not start from the first box's remembered state.
  const { handlers: stoppedHandlers, changes } = server([box({ id: "box_3", name: "wild-cove", state: "stopped" })]);
  const stopped = terminalTab(stoppedHandlers, "box_3");
  expect(await stopped.findByText("wild-cove is stopped.")).toBeTruthy();
  expect(FakeSocket.made).toHaveLength(1);
  fireEvent.click(stopped.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(changes).toEqual(["start box_3"]));

  cleanup();
  const none = terminalTab(server([box({ id: "box_5", name: "no-shell", terminal: false })]).handlers, "box_5");
  expect(await none.findByText("no-shell has no terminal.")).toBeTruthy();
  // Start made wild-cove ready, so its tab connected; no-shell never does.
  expect(FakeSocket.made.map((made) => new URL(made.url).searchParams.get("box"))).toEqual(["box_1", "box_3"]);
});

/** One of your machines: a ready desktop a thread is working on. */
function machine(overrides: Partial<BoxView> = {}, threads: ThreadOnBox[] = [{ id: "thr_a", title: "Fix the login form", running: true }, { id: "thr_b", title: "Docs pass", running: false }]): MachineEntry {
  return { box: desktopBox({ id: "box_m1", name: "build-1", ...overrides }), threads };
}

test("the settings page lists your machines with their threads and actions, and offers Add machine", async () => {
  const { handlers, changes } = server([], { machines: [machine(), machine({ id: "box_m2", name: "scratch", desktop: false, display: null, gpu: false, state: "stopped" }, [])] });
  const slot = settings(handlers);
  expect(await slot.findByText("build-1")).toBeTruthy();
  expect(slot.getByText("Your machines")).toBeTruthy();
  expect(slot.getByText("Working: Fix the login form · 1 more")).toBeTruthy();
  expect(slot.getByText("scratch")).toBeTruthy();
  // Said once for the section, not under each machine.
  expect(slot.getAllByText("To use one for a project with a repository, pick it in BB's new-thread picker and choose Set up on it once.")).toHaveLength(1);
  expect(slot.getByRole("button", { name: "Open desktop" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Open terminal" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(slot.getByRole("button", { name: "Start" })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Open desktop" }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "operator/box_m1/from-settings" } });
  fireEvent.click(slot.getByRole("button", { name: "Open terminal" }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "operator/box_m1/terminal/from-settings" } });

  // Stopping a machine a thread works on asks first, then sends force.
  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Stop build-1 anyway?")).toBeTruthy();
  expect(screen.getByText("Fix the login form is working on it, and would lose its machine.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop anyway" }));
  await waitFor(() => expect(changes).toEqual(["machines.stop (forced) box_m1"]));

  // Removing asks, and again when a thread works on it.
  const menu = await openMenu(slot.getByRole("button", { name: "scratch actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
  expect(await screen.findByText("Remove scratch?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(changes).toEqual(["machines.stop (forced) box_m1", "machines.remove box_m2"]));
  await waitFor(() => expect(slot.queryByText("scratch")).toBeNull());
});

test("Add machine takes a kind, a size and a name it checks as you type, and the empty state says what a machine is", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  expect(await slot.findByText(/Add a box as a BB machine of your own/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Add machine" }));
  const name = await screen.findByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Build 1" } });
  expect(screen.getByText("Lowercase letters, digits and hyphens, starting with a letter, up to 32 characters.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(name, { target: { value: "build-" } });
  expect(screen.getByText("A name cannot end with a hyphen.")).toBeTruthy();
  fireEvent.change(name, { target: { value: "build-1" } });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() => expect(changes).toEqual(["machines.add linux build-1"]));
  expect(await slot.findByText("build-1")).toBeTruthy();
  expect(slot.getByText("Starting")).toBeTruthy();
});

test("the Desktops page lists your machines first, without Open thread, and shows a machine's terminal", async () => {
  const { handlers } = server([desktopBox()], { machines: [machine()] });
  const mine = { threadId: "operator", box: desktopBox({ id: "box_m1", name: "build-1" }), owner: "yours" as const };
  const withMine: PluginRpcTestHandlers<Contract> = { ...handlers, desktops: () => [...(handlers.desktops as () => DesktopEntryLike[])(), mine] };
  const [page] = app.navPanels;
  const list = renderSlot(page!, { subPath: "" }, { rpc: withMine, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
  expect(await list.findByText("Your machines")).toBeTruthy();
  const rows = list.getAllByRole("button", { name: "Open" });
  expect(rows).toHaveLength(2);
  expect(list.getAllByRole("button", { name: "Open thread" })).toHaveLength(1);
  const names = list.getAllByText(/build-1|bold-heron/).map((node) => node.textContent);
  expect(names[0]).toBe("build-1");

  const terminal = renderSlot(page!, { subPath: "operator/box_m1/terminal/from-settings" }, { rpc: withMine, pluginId: "bb-box" });
  fireEvent.click(await terminal.findByRole("button", { name: "Back to settings" }));
  expect(terminal.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: "/settings/plugins/bb-box" });
  await waitFor(() => expect(FakeSocket.made.at(-1)?.url).toContain("box=box_m1"));
});

test("the panel shows the box this thread runs on first, without Release or Stop, and says where they are", async () => {
  const yours = desktopBox({ id: "box_m1", name: "build-1" });
  const { handlers } = server([box()], { runsOn: { box: yours, owner: "yours", threadId: null } });
  const slot = panel(handlers);
  expect(await slot.findByText("This thread runs on it")).toBeTruthy();
  expect(slot.getByText("build-1")).toBeTruthy();
  expect(slot.getByText("Yours")).toBeTruthy();
  expect(slot.getByText(/Remove or stop it in/)).toBeTruthy();
  expect(slot.getByRole("link", { name: "BB Box's settings" }).getAttribute("href")).toBe("/settings/plugins/bb-box");
  expect(slot.getByText("1 box")).toBeTruthy();
  const rows = slot.getAllByRole("button", { name: /: details$/ }).map((node) => node.getAttribute("aria-label"));
  expect(rows).toEqual(["build-1: details", "calm-otter: details"]);
  expect(slot.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
  const menu = await openMenu(slot.getByRole("button", { name: "build-1 actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open desktop", "Open desktop in a browser tab", "Open terminal", "Copy address", "Check now"]);

  cleanup();
  const theirs = panel(server([], { runsOn: { box: yours, owner: "thread", threadId: "thr_other" } }).handlers);
  expect(await theirs.findByText(/Held by/)).toBeTruthy();
  expect(await theirs.findByRole("button", { name: "UI thread" })).toBeTruthy();
  expect(theirs.queryByText("Yours")).toBeNull();
});

test("an arm64 kind carries an arm64 badge, and macOS, always arm64, does not (040)", async () => {
  expect(isArm64Badge("linux", "arm64")).toBe(true);
  expect(isArm64Badge("linux", "x86_64")).toBe(false);
  expect(isArm64Badge("macos", "arm64")).toBe(false);
  const { handlers } = server([], { kinds: [...KINDS, kindView("linux-arm64", "Linux on arm64", "A Linux box on a Mac.", 2, false)] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const form = await screen.findByRole("radiogroup", { name: "Kind" });
  expect(within(form).getAllByRole("radio").map((option) => option.textContent)).toEqual(["LinuxLXC", "LinuxDesktopGPULXC", "Linuxarm64LXC"]);
});
