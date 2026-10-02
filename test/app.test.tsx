// The panel, the desktop viewer and the settings section, rendered with the
// SDK's slot harness against fake RPC handlers and a fake noVNC. Run with
// vitest: npm run test:app.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ApplyResult, BoxResult, CheckResult, ConfigState, Contract, DesktopState, MachineEntry, PanelState, ThreadOnBox } from "../src/plugin/contract.ts";
import type { ConfigDocument, Problem } from "../src/core/document.ts";
import type { BackendView, BoxView, DoctorView, KindView, ProviderProfile } from "../src/plugin/views.ts";
import type { DockerHostView } from "../src/plugin/docker-hosts.ts";
import { forgetLive, isArm64Badge, lacksDocker } from "../src/app/common.tsx";
import { SETTLE_MS } from "../src/app/desktop.tsx";
import { choiceOf, formFilterOf, kindFor, nearest, offersShown, providerTitle, runsOnOptions, systemsOf } from "../src/app/box-form.tsx";
import { limitWords, makesWords, roomWords, runsOnWords, statusWords, usuallyWords } from "../src/app/provider-profile.tsx";
import { providerKeys, providerName } from "../src/core/provider-name.ts";
type DesktopEntryLike = { threadId: string; box: BoxView; owner: "thread" | "yours" };
import { dropAllKept, HAND_BACK_MS, HIDDEN_MS } from "../src/app/kept.ts";
import { sparesWords } from "../src/app/settings-kinds.tsx";
import { statusOf } from "../src/app/status.ts";
import { sourceName } from "../src/app/config.ts";
import { FieldControl } from "../src/app/settings-fields.tsx";
import type { BackendConfig } from "../src/core/document.ts";
import type { FieldView } from "../src/plugin/configuration.ts";

/** noVNC's RFB, recording each client the viewer makes. */
const novnc = vi.hoisted(() => {
  class FakeRfb extends EventTarget {
    static made: FakeRfb[] = [];
    viewOnly = false;
    scaleViewport = false;
    #resizeSession = false;
    /** How often the viewer turned resizeSession on, each of which makes noVNC check the desktop's size. */
    resizeChecks = 0;
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
    get resizeSession() {
      return this.#resizeSession;
    }
    set resizeSession(value: boolean) {
      this.#resizeSession = value;
      if (value) this.resizeChecks++;
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {
      this.focused++;
    }
    blur() {}
    /** noVNC's own measure: the element's rect, fractional. */
    _screenSize() {
      return { w: 851.5, h: 1007.25 };
    }
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

/** ResizeObserver, which jsdom lacks: a test gives each observer its elements' new size. */
class FakeObserver {
  static made: FakeObserver[] = [];
  readonly targets: Element[] = [];
  disconnected = false;
  readonly #callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.#callback = callback;
    FakeObserver.made.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  resize(width: number, height: number) {
    const entries = this.targets.map((target) => ({ target, contentRect: { width, height } }) as unknown as ResizeObserverEntry);
    this.#callback(entries, this as unknown as ResizeObserver);
  }
}
vi.stubGlobal("ResizeObserver", FakeObserver);

/** The observer of the element noVNC draws in. */
function observerOf(client: { target: HTMLElement }): FakeObserver {
  return FakeObserver.made.find((observer) => observer.targets.includes(client.target))!;
}

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
  FakeObserver.made = [];
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
    docker: true,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: "192.0.2.10",
    facts: [{ label: "Template", value: "9000" }],
    timings: { clone: 700, total: 2100, enrol: 5300 },
    enrol: { state: "enrolled", hostId: "host_1", error: null },
    enrols: true,
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
    docker: true,
    enrol: true,
    spares: { target: 0, ready: 0, making: 0 },
    admin: true,
    backends: ["Fake host"],
    forms: ["LXC"],
    offers: [
      {
        backend: "fake",
        name: "Fake host on pve",
        type: "fake",
        label: "Fake host",
        hosts: ["pve"],
        form: "LXC",
        ready: 0,
        free: null,
        admin: true,
        resizable: desktop ? true : null,
        typicalReadyMs: desktop ? 3100 : 2200,
        docker: true,
        hostOs: "linux",
      },
    ],
    computerUse: desktop,
  };
}

// jsdom has no scrollIntoView, which a menu calls on its chosen item.
Element.prototype.scrollIntoView = () => {};

/** Opens the labelled menu with the keyboard and picks the option. */
async function choose(label: string, option: string): Promise<void> {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  const item = (await screen.findAllByRole("option")).find((candidate) => candidate.textContent === option);
  if (!item) throw new Error(`No option "${option}" under ${label}`);
  fireEvent.click(item);
  // A filter's trigger carries its label ("Kind: All"); the GPU's carries the value alone.
  await waitFor(() => expect(screen.getByRole("combobox", { name: label }).textContent?.endsWith(option)).toBe(true));
}

/** The menu's options, with "disabled" after one that cannot be chosen, and the menu closed again. */
async function optionsOf(label: string): Promise<string[]> {
  fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "ArrowDown" });
  const items = (await screen.findAllByRole("option")).map((candidate) => `${candidate.textContent}${candidate.getAttribute("aria-disabled") ? ":disabled" : ""}`);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("option")).toBeNull());
  return items;
}

/** The form's one button: Create box, or Add machine (the settings page has a button of that name that opens the form too). */
const submitButton = () => document.querySelector('form button[type="submit"]') as HTMLButtonElement;

const KINDS: KindView[] = [
  kindView("linux", "Linux", "For builds, servers, Docker and the agent's own work.", 2, false),
  kindView("linux-desktop", "Linux desktop", "A desktop on the GPU.", 4, true),
];

/** The LXC host's profile, as the (i) on its row shows it. */
const PROFILE: ProviderProfile = {
  backend: "fake",
  name: "Fake host on pve",
  technology: "Linux containers on a test host.",
  nature: "virtual",
  hosts: ["pve"],
  hostOs: "linux",
  makes: [
    { id: "linux", label: "Linux", form: "LXC", typicalReadyMs: 2200, ready: 1 },
    { id: "linux-desktop", label: "Linux desktop (GPU)", form: "LXC", typicalReadyMs: 3100, ready: 0 },
  ],
  boxes: 2,
  room: {
    ok: true,
    message: null,
    warm: null,
    hosts: [{ host: "pve", ok: true, limits: [{ resource: "memory", used: 12 * 1024, total: 64 * 1024, reserve: 4 * 1024, unit: "MiB" }, { resource: "cpu", used: 6, total: 16, reserve: 0, unit: "count" }] }],
  },
  status: { state: "active", problem: null, ok: true, summary: "Proxmox VE 9.2 on pve", checkedAt: 0 },
};

/** Linux as two backends offer it: the LXC host and a pool of real machines. */
const POOLED: KindView = {
  ...KINDS[0]!,
  offers: [
    KINDS[0]!.offers[0]!,
    { backend: "ssh-pool", name: "SSH host pool", type: "ssh-pool", label: "SSH host pool", hosts: [], form: "Physical", ready: 0, free: 1, admin: false, resizable: null, typicalReadyMs: null, docker: true, hostOs: "linux" },
  ],
  admin: null,
  forms: ["LXC", "Physical"],
};

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
function server(initial: BoxView[], options: { kinds?: KindView[]; failWith?: string; inUse?: ThreadOnBox[]; machines?: MachineEntry[]; runsOn?: PanelState["runsOn"]; config?: Partial<ConfigState>; checkWith?: CheckResult; applyWith?: ApplyResult; savedWith?: Problem[]; dockerHosts?: DockerHostView[] } = {}) {
  let boxes = [...initial];
  let machines = [...(options.machines ?? [])];
  let dockerHosts = [...(options.dockerHosts ?? [])];
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
    provider: ({ backend }) => {
      changes.push(`provider ${backend}`);
      return { ...PROFILE, backend, status: { ...PROFILE.status, checkedAt: Date.now() - 120_000 } };
    },
    thread: ({ box: ref, prompt }) => {
      changes.push(`thread ${ref} ${prompt}`);
      return { threadId: "thr_child", error: null };
    },
    acquire: ({ kind, size, on }) => {
      changes.push(`acquire ${kind}${size ? ` ${JSON.stringify(size)}` : ""}${on ? ` on ${on}` : ""}`);
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
    // BB machines that can host Docker boxes (042), switched as the tests ask.
    "docker.hosts": () => ({ hosts: dockerHosts }),
    "docker.host.set": ({ hostId, enabled }) => {
      changes.push(`docker.host.set ${hostId} ${enabled}`);
      dockerHosts = dockerHosts.map((host) => (host.hostId === hostId ? { ...host, backend: enabled ? { id: `docker:${host.name}`, enabled: true, boxes: 0 } : null } : host));
      return { result: { ok: true, state: configState(options.config ?? {}), problems: [] }, hosts: dockerHosts };
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
      { id: "linux", label: "Linux", description: "A Linux box.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [], docker: true, drivers: ["fake", "other"], spares: { ready: 0, making: 0 } },
      { id: "linux-desktop", label: "Linux desktop", description: "A desktop on a GPU.", gpu: true, desktop: true, os: "linux", arch: "x86_64", features: [], docker: true, drivers: ["fake"], spares: { ready: 0, making: 0 } },
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
  const { handlers } = server([box({ timings: { clone: 700, total: 2100, enrol: 5300, "start.resume": 4100, "start.ssh": 1200, "start.clock": 600, "start.total": 6000 } }), desktopBox({ docker: false })]);
  const slot = panel(handlers);

  expect(await slot.findByText("calm-otter")).toBeTruthy();
  expect(slot.getByText("2 boxes")).toBeTruthy();
  expect(slot.getByText("bold-heron")).toBeTruthy();
  expect(slot.getAllByText("Ready in 2.1 s")).toHaveLength(2);
  expect(slot.getAllByText("BB machine in 5.3 s")).toHaveLength(2);
  expect(slot.getByText("GPU")).toBeTruthy();
  expect(slot.getAllByText("No Docker")).toHaveLength(1);
  expect(slot.getAllByText("LXC")).toHaveLength(2);
  expect(slot.getByRole("button", { name: "New box" }).textContent).toBe("");
  expect(slot.queryByText("192.0.2.10")).toBeNull();

  fireEvent.click(slot.getByRole("button", { name: "calm-otter: details" }));
  expect(slot.getByText("192.0.2.10")).toBeTruthy();
  expect(slot.getByText("2 cores, 4 GiB memory")).toBeTruthy();
  expect(slot.getByText("Fake host")).toBeTruthy();
  expect(slot.getByText("Linux x86_64, with docker")).toBeTruthy();
  expect(slot.getByText("clone 0.7 s · total 2.1 s · BB enrolment 5.3 s")).toBeTruthy();
  expect(slot.getByText("resume 4.1 s · ssh 1.2 s · setting the clock 0.6 s · total 6.0 s")).toBeTruthy();
  expect(slot.getByText("Last start")).toBeTruthy();
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

test("the panel makes a box by steps, System, Architecture, Type and Resources, and remembers the kind", async () => {
  const { handlers, changes } = server([]);
  const slot = panel(handlers);

  expect(await slot.findByText("No boxes yet")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  // Each step shows what exists: the one system with its host under it; an architecture no kind has greys out and says so.
  const systems = await screen.findByRole("radiogroup", { name: "System" });
  expect(within(systems).getAllByRole("radio").map((option) => option.textContent)).toEqual(["Linuxpve"]);
  const archs = screen.getByRole("radiogroup", { name: "Architecture" });
  expect(within(archs).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}:${option.getAttribute("aria-disabled")}`)).toEqual(["x86_6464-bit Intel / AMD:true:null", "arm64Not available:false:true"]);
  fireEvent.click(within(archs).getByRole("radio", { name: /^arm64/ }));
  expect(within(archs).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  // A terminal is access, not a type (the operator's note): Server and Desktop are the types, with what each gives under it.
  const types = screen.getByRole("radiogroup", { name: "Type" });
  expect(within(types).getAllByRole("radio").map((option) => option.textContent)).toEqual(["ServerTerminal", "DesktopScreen · Terminal · Computer use"]);
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  // One provider is no choice: its row stands alone, checked, named by its host and never by an ID.
  const providers = screen.getByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual(["pveContainer · usually ~3.1 s:true"]);
  const sizes = screen.getByRole("radiogroup", { name: "Size" });
  expect(within(sizes).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual(["Small4 cores · 8 GiB:true", "Medium8 cores · 16 GiB:false", "Large16 cores · 32 GiB:false", "Customup to 32 cores:false"]);
  fireEvent.click(within(sizes).getByRole("radio", { name: /^Large/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));

  expect(await slot.findByText("new-box")).toBeTruthy();
  expect(changes).toEqual(['acquire linux-desktop {"preset":"large"}']);
  expect(slot.getByText("Starting")).toBeTruthy();
  expect(slot.getByText("1 box")).toBeTruthy();
  expect(JSON.parse(window.localStorage.getItem("bb-box:new-box") ?? "{}")).toEqual({ kind: "linux-desktop", size: "large" });
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());

  // The form opens on the remembered kind; the default preset sends no size at all.
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  expect(within(await screen.findByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Small/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(['acquire linux-desktop {"preset":"large"}', "acquire linux-desktop"]));
});

test("a desktop whose system has a GPU desktop and a CPU one takes the GPU from a menu", async () => {
  const cpu: KindView = { ...kindView("linux-desktop-cpu", "Linux desktop", "A desktop on the CPU.", 4, true), gpu: false };
  const { handlers, changes } = server([], { kinds: [...KINDS, cpu] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "Type" });
  expect(screen.queryByRole("combobox", { name: "GPU" })).toBeNull();
  expect(screen.queryByText("GPU")).toBeNull();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }));
  // Desktop opens on the CPU desktop; the GPU is a resource, a sub-label and menu under the presets, and 1 GPU names the GPU kind.
  expect(screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["System", "Architecture", "Type", "Resources", "Provider"]);
  expect(screen.getByText("GPU").tagName).toBe("P");
  expect(screen.getByRole("combobox", { name: "GPU" }).textContent).toBe("None");
  expect(await optionsOf("GPU")).toEqual(["None", "1 GPU"]);
  await choose("GPU", "1 GPU");
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux-desktop"]));
});

test("one Escape closes the form whatever was used last: a card, a menu, a field", async () => {
  const { handlers } = server([], { kinds: [POOLED, KINDS[1]!] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  const isOpen = () => screen.queryByRole("radiogroup", { name: "System" }) !== null;
  const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "System" });
  escape();
  await waitFor(() => expect(isOpen()).toBe(false));

  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "System" });
  await choose("Kind", "Physical");
  expect(isOpen()).toBe(true);
  escape();
  await waitFor(() => expect(isOpen()).toBe(false));

  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const types = await screen.findByRole("radiogroup", { name: "Type" });
  const card = within(types).getByRole("radio", { name: /^Desktop/ });
  fireEvent.click(card);
  card.focus();
  escape();
  await waitFor(() => expect(isOpen()).toBe(false));
});

test("the (i) on a provider row opens its profile, asked once while the form is open, in plain rows; Escape closes the profile first", async () => {
  const { handlers, changes } = server([], { kinds: [POOLED, KINDS[1]!] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "Provider" });
  expect(changes).toEqual([]);
  // Nothing is asked until the (i) opens; then the profile comes once.
  fireEvent.click(screen.getByRole("button", { name: "About pve" }));
  expect(await screen.findByText("Fake host on pve")).toBeTruthy();
  expect(screen.getByText("Linux containers on a test host.")).toBeTruthy();
  const rows = screen.getAllByRole("definition").map((row) => row.textContent);
  expect(rows).toEqual([
    "pve (a Linux machine)",
    "Linux, Linux desktop (GPU) · LXC containers",
    "pve: memory 12 of 64 GiB, 4 GiB kept back · cores 6 of 16",
    "Linux ~2.2 s (1 ready now) · Linux desktop (GPU) ~3.1 s",
    "Ready · Proxmox VE 9.2 on pve · 2 boxes on it · checked 2 minutes ago",
  ]);
  expect(changes).toEqual(["provider fake"]);
  // The (i) does not choose the row; it keeps its place in the card, shown on hover, focus or while its profile is open.
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  const holder = screen.getByRole("button", { name: "About pve" }).parentElement!;
  expect(holder.getAttribute("data-testid")).toBe("provider-info");
  expect(holder.className).toMatch(/\bopacity-0\b/);
  expect(holder.className).toMatch(/group-hover:opacity-100/);
  expect(holder.className).toMatch(/group-focus-within:opacity-100/);
  expect(holder.className).toMatch(/has-\[\[data-state=open\]\]:opacity-100/);
  // Escape closes the profile and leaves the form; opening the profile again asks nothing more.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Linux containers on a test host.")).toBeNull());
  expect(screen.getByRole("radiogroup", { name: "System" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "About pve" }));
  expect(await screen.findByText("Linux containers on a test host.")).toBeTruthy();
  expect(changes).toEqual(["provider fake"]);
  // The pool's (i) asks for the pool.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Linux containers on a test host.")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "About SSH host pool" }));
  await waitFor(() => expect(changes).toEqual(["provider fake", "provider ssh-pool"]));
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Fake host on pve")).toBeNull());

  // The pointer resting on the (i) opens the profile as a preview after a moment; leaving closes it; a click keeps it.
  fireEvent.pointerEnter(screen.getByRole("button", { name: "About pve" }));
  expect(screen.queryByText("Linux containers on a test host.")).toBeNull();
  await waitFor(() => expect(screen.getByText("Linux containers on a test host.")).toBeTruthy(), { timeout: 1500 });
  fireEvent.pointerLeave(screen.getByRole("button", { name: "About pve" }));
  await waitFor(() => expect(screen.queryByText("Linux containers on a test host.")).toBeNull(), { timeout: 1500 });
  fireEvent.pointerEnter(screen.getByRole("button", { name: "About pve" }));
  await waitFor(() => expect(screen.getByText("Linux containers on a test host.")).toBeTruthy(), { timeout: 1500 });
  fireEvent.click(screen.getByRole("button", { name: "About pve" }));
  fireEvent.pointerLeave(screen.getByRole("button", { name: "About pve" }));
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(screen.getByText("Linux containers on a test host.")).toBeTruthy();
  expect(changes).toEqual(["provider fake", "provider ssh-pool"]);
});

test("the profile's words: limits, room, where it runs, what it makes, the usual start and the status", () => {
  expect(limitWords({ resource: "memory", used: 12 * 1024, total: 64 * 1024, reserve: 4 * 1024, unit: "MiB" })).toBe("memory 12 of 64 GiB, 4 GiB kept back");
  expect(limitWords({ resource: "disk", used: 100 * 1024, total: null, reserve: 0, unit: "MiB" })).toBe("disk 100 GiB used");
  expect(limitWords({ resource: "machines", used: 1, total: 2, reserve: 0, unit: "count" })).toBe("machines 1 of 2");
  expect(limitWords({ resource: "gpu-desktops", id: "0", used: 1, total: 1, reserve: 0, unit: "count" })).toBe("GPU desktops 0 1 of 1");
  expect(roomWords(null)).toEqual(["Not known: the provider did not answer."]);
  expect(roomWords({ ok: false, message: "pve has no memory left.", warm: { ready: 1, target: 2 }, hosts: [{ host: "pve", ok: false, limits: [] }] })).toEqual(["pve: full", "pve has no memory left.", "1 of 2 warm"]);
  expect(roomWords({ ok: true, message: null, warm: null, hosts: [] })).toEqual(["Room for one more box."]);
  expect(runsOnWords({ hosts: ["devpc"], hostOs: "windows", nature: "virtual" })).toBe("devpc (a Windows PC)");
  expect(runsOnWords({ hosts: ["devpc"], hostOs: null, nature: "virtual" })).toBe("devpc (not known yet)");
  expect(runsOnWords({ hosts: [], hostOs: "linux", nature: "real" })).toBe("machines of its own (Linux machine)");
  expect(makesWords({ makes: [] })).toBe("Nothing now.");
  expect(makesWords({ makes: [{ id: "macos", label: "macOS", form: "VM", typicalReadyMs: null, ready: 0 }] })).toBe("macOS · VMs");
  expect(usuallyWords({ makes: [{ id: "macos", label: "macOS", form: "VM", typicalReadyMs: null, ready: 0 }] })).toBe("No cold start recorded yet.");
  expect(statusWords({ status: { state: "off", problem: null, ok: null, summary: null, checkedAt: null }, boxes: 1 }, 0)).toBe("Off · 1 box on it");
  expect(statusWords({ status: { state: "misconfigured", problem: "Set the API token.", ok: null, summary: null, checkedAt: null }, boxes: 0 }, 0)).toBe("Needs setting up: Set the API token. · 0 boxes on it");
  expect(statusWords({ status: { state: "active", problem: null, ok: false, summary: "Template 9101 has no build tag.", checkedAt: 0 }, boxes: 3 }, 60_000)).toBe("Needs attention · Template 9101 has no build tag. · 3 boxes on it · checked 1 minute ago");
});

test("a provider row says how many spares it has ready now (#121)", async () => {
  const [linux, desktop] = KINDS;
  const kinds = [{ ...linux!, spares: { target: 1, ready: 1, making: 0 }, offers: [{ ...linux!.offers[0]!, ready: 1 }] }, desktop!];
  const slot = panel(server([], { kinds }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · 1 ready now · usually ~2.2 s"]);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }));
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · usually ~3.1 s"]);
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
  fireEvent.click(within(sizes).getByRole("radio", { name: /^Medium/ }));
  fireEvent.click(within(sizes).getByRole("radio", { name: /^Custom/ }));
  const cores = screen.getByLabelText(/^Cores/) as HTMLInputElement;
  const memory = screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement;
  const disk = screen.getByLabelText(/^Disk, GiB/) as HTMLInputElement;
  expect([cores.value, memory.value, disk.value, disk.placeholder]).toEqual(["4", "8", "", "base"]);
  expect(screen.getByText("up to 16")).toBeTruthy();
  expect(screen.getByText("up to 256")).toBeTruthy();

  fireEvent.change(cores, { target: { value: "six" } });
  expect(submitButton().disabled).toBe(true);
  fireEvent.change(cores, { target: { value: "6" } });
  fireEvent.change(memory, { target: { value: "12" } });

  // Custom fields belong to the kind: another kind starts from its own preset, and the edits come back with the kind.
  const types = screen.getByRole("radiogroup", { name: "Type" });
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  expect([(screen.getByLabelText(/^Cores/) as HTMLInputElement).value, (screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement).value]).toEqual(["8", "16"]);
  expect(screen.getByText("up to 32")).toBeTruthy();
  fireEvent.click(within(types).getByRole("radio", { name: /^Server/ }));
  expect([(screen.getByLabelText(/^Cores/) as HTMLInputElement).value, (screen.getByLabelText(/^Memory, GiB/) as HTMLInputElement).value]).toEqual(["6", "12"]);

  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(['acquire linux {"cores":6,"memoryGiB":12}']));
  expect(JSON.parse(window.localStorage.getItem("bb-box:new-box") ?? "{}")).toEqual({ kind: "linux", size: "custom", custom: { linux: { cores: "6", memoryGiB: "12", diskGiB: "" } } });
});

test("a refused box stays in the form with the reason", async () => {
  const { handlers } = server([], { failWith: "pve has no memory left. Release a box you no longer need." });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(await screen.findByRole("button", { name: "Create box" }));
  expect((await screen.findByRole("alert")).textContent).toBe("pve has no memory left. Release a box you no longer need.");
  expect(screen.getByRole("radiogroup", { name: "System" })).toBeTruthy();
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

test("a Windows box, whose kind cannot enrol, says its BB machine is not for this kind", async () => {
  const slot = panel(server([box({ kind: "windows-desktop", kindLabel: "Windows desktop", os: "windows", enrols: false, enrol: { state: "off", hostId: null, error: null } })]).handlers);
  await slot.findByText("calm-otter");
  fireEvent.click(slot.getByRole("button", { name: "calm-otter: details" }));
  expect(await slot.findByText("not for this kind")).toBeTruthy();
  expect(slot.getByText(/Windows x86_64/)).toBeTruthy();
  expect(slot.queryByText("off")).toBeNull();
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

test("a backend that is off offers Save and turn on, which Enter and the button save on in one go, and a refusal saves nothing", async () => {
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Set up Fake host" }));
  expect(slot.queryByRole("button", { name: "Save and turn on" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Set up Other pool" }));
  // Enter in a field submits the form, which does what the main button does (#193).
  fireEvent.submit((await slot.findByRole("button", { name: "Save and turn on" })).closest("form")!);
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
  vi.useFakeTimers();
  act(() => observerOf(client!).resize(1037, 746));
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(client!.resizeChecks).toBe(0);
});

test("once the tab's size holds, a desktop in your control asks for it once; while it moves, noVNC may not ask", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  const observer = observerOf(client!);
  // The viewer measures its screen in whole pixels, as noVNC floors what it asks for, so a size that holds is asked for once (#353).
  expect(client!._screenSize()).toEqual({ w: 851, h: 1007 });
  act(() => void client!.dispatchEvent(new Event("connect")));
  vi.useFakeTimers();
  act(() => observer.resize(1037, 746));
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(client!.resizeChecks).toBe(0);
  vi.useRealTimers();

  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  expect(await slot.findByText("You have control. The desktop follows this tab's size.")).toBeTruthy();
  const taken = client!.resizeChecks;
  vi.useFakeTimers();
  // The size as it was, observed again (a mount's first observation), is no move: noVNC keeps asking, and the settle asks once more.
  act(() => observer.resize(1037, 746));
  expect(client!.resizeSession).toBe(true);
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  const held = client!.resizeChecks;
  expect(held).toBe(taken + 1);
  // A pane opening: while the size moves noVNC may not ask (1.7 would ask on the first frame, and the box would set that size first), each frame puts the wait back, and the one request comes once the size holds.
  act(() => observer.resize(1006, 746));
  expect(client!.resizeSession).toBe(false);
  act(() => void vi.advanceTimersByTime(SETTLE_MS - 50));
  act(() => observer.resize(1037, 746));
  expect(client!.resizeSession).toBe(false);
  act(() => void vi.advanceTimersByTime(SETTLE_MS - 50));
  expect(client!.resizeChecks).toBe(held);
  act(() => void vi.advanceTimersByTime(50));
  expect([client!.resizeChecks, client!.resizeSession]).toEqual([held + 1, true]);
  // Out of the page the element has no size, which is not asked for.
  act(() => observer.resize(0, 0));
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect(client!.resizeChecks).toBe(held + 1);

  act(() => observer.resize(518, 722));
  dropAllKept();
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect([client!.resizeChecks, observer.disconnected]).toEqual([held + 1, true]);
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
  expect(slot.getAllByText("To use one for a project with a repository, pick it in BB's new-thread picker.")).toHaveLength(1);
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
  expect(await screen.findByText("Of the kinds whose boxes join BB.")).toBeTruthy();
  expect(screen.getByText("Optional; bb-box picks one when it is left empty.")).toBeTruthy();
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Build 1" } });
  expect(screen.getByText("Lowercase letters, digits and hyphens, starting with a letter, up to 32 characters.")).toBeTruthy();
  expect(submitButton().disabled).toBe(true);
  fireEvent.change(name, { target: { value: "build-" } });
  expect(screen.getByText("A name cannot end with a hyphen.")).toBeTruthy();
  fireEvent.change(name, { target: { value: "build-1" } });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(submitButton().textContent).toBe("Add machine");
  fireEvent.click(submitButton());
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

test("an arm64 kind carries an arm64 badge, and macOS, always arm64, does not (040); the form offers arm64 when a kind has it", async () => {
  expect(isArm64Badge("linux", "arm64")).toBe(true);
  expect(isArm64Badge("linux", "x86_64")).toBe(false);
  expect(isArm64Badge("macos", "arm64")).toBe(false);
  const { handlers, changes } = server([], { kinds: [...KINDS, kindView("linux-arm64", "Linux on arm64", "A Linux box on a Mac.", 2, false)] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const archs = await screen.findByRole("radiogroup", { name: "Architecture" });
  expect(within(archs).getAllByRole("radio").map((option) => option.textContent)).toEqual(["x86_6464-bit Intel / AMD", "arm6464-bit ARM"]);
  fireEvent.click(within(archs).getByRole("radio", { name: /^arm64/ }));
  // arm64 has no desktop here, so Desktop greys out, and the summary follows the choice.
  const types = screen.getByRole("radiogroup", { name: "Type" });
  expect(within(types).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-disabled")}`)).toEqual(["ServerTerminal:null", "DesktopNot available:true"]);
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  expect(within(types).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux-arm64"]));
});

test("the steps narrow each other: a system with no server snaps to Desktop, the Kind chips grey out, and Physical hides Runs on and names the provider left", async () => {
  const windows: KindView = {
    ...kindView("windows-desktop", "Windows desktop", "A Windows desktop.", 4, true),
    os: "windows",
    gpu: false,
    forms: ["VM"],
    enrol: false,
    computerUse: true,
    docker: false,
    offers: [{ backend: "proxmox-qemu", name: "Proxmox QEMU on pve1", type: "proxmox-qemu", label: "Proxmox QEMU", hosts: ["pve1"], form: "VM", ready: 0, free: null, admin: true, resizable: true, typicalReadyMs: 30000, docker: false, hostOs: "linux" }],
  };
  const { handlers, changes } = server([], { kinds: [POOLED, KINDS[1]!, windows] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  // A system's card names its hosts, or counts its providers when there are many.
  const systems = await screen.findByRole("radiogroup", { name: "System" });
  expect(within(systems).getAllByRole("radio").map((option) => option.textContent)).toEqual(["Linuxpve, SSH host pool", "Windowspve1"]);
  fireEvent.click(within(systems).getByRole("radio", { name: /^Windows/ }));
  const types = screen.getByRole("radiogroup", { name: "Type" });
  expect(within(types).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual(["ServerNot available:false", "DesktopScreen · Terminal · Computer use:true"]);
  // The Kind menu keeps an option no provider makes, but it cannot be chosen; Runs on lists the machines the providers run on.
  const filters = screen.getByRole("group", { name: "Filter" });
  expect(within(filters).getAllByRole("combobox").map((menu) => menu.textContent)).toEqual(["Kind:All", "Runs on:Any machine"]);
  expect(await optionsOf("Kind")).toEqual(["All", "Container:disabled", "VM", "Physical:disabled"]);
  expect(screen.getByRole("combobox", { name: "Runs on" }).textContent).toBe("Runs on:Any machine");
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pve1VM · usually ~30.0 s"]);
  expect(screen.queryByRole("combobox", { name: "GPU" })).toBeNull();

  // Back on Linux, Physical keeps the pool only, hides Runs on, and the request names the one provider left.
  fireEvent.click(within(systems).getByRole("radio", { name: /^Linux/ }));
  fireEvent.click(within(types).getByRole("radio", { name: /^Server/ }));
  await choose("Kind", "Physical");
  expect(screen.queryByRole("combobox", { name: "Runs on" })).toBeNull();
  const providers = screen.getByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual(["First with roomThe one below:true", "SSH host poolPhysical · 1 free:false"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux on ssh-pool"]));
});

test("the providers are a choice, First with room first, which goes with the request and resets with the type and when the form closes (044)", async () => {
  const { handlers, changes } = server([], { kinds: [POOLED, KINDS[1]!] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-checked")}`)).toEqual([
    "First with roomAny of the 2 below, in order:true",
    "pveContainer · usually ~2.2 s:false",
    "SSH host poolPhysical · 1 free:false",
  ]);
  fireEvent.click(within(providers).getByRole("radio", { name: /^SSH host pool/ }));
  expect(within(providers).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "false", "true"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux on ssh-pool"]));

  // The choice is not remembered: the form opens on First with room again, and another type puts it back too.
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const again = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(again).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
  fireEvent.click(within(again).getByRole("radio", { name: /^SSH host pool/ }));
  const types = screen.getByRole("radiogroup", { name: "Type" });
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · usually ~3.1 s"]);
  fireEvent.click(within(types).getByRole("radio", { name: /^Server/ }));
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
});

test("Runs on keeps the providers on that machine, and one that does not know its machine yet; a Docker machine without a name is an unnamed machine", async () => {
  const mixed: KindView = {
    ...KINDS[0]!,
    admin: null,
    forms: ["LXC", "VM", "Docker"],
    offers: [
      KINDS[0]!.offers[0]!,
      { backend: "tart", name: "Tart on mac-mini", type: "tart", label: "Tart", hosts: ["mac-mini"], form: "VM", ready: 0, free: null, admin: true, resizable: false, typicalReadyMs: 26000, docker: true, hostOs: "macos" },
      { backend: "docker:host_1", name: "Docker", type: "docker", label: "Docker", hosts: [], form: "Docker", ready: 0, free: null, admin: true, resizable: true, typicalReadyMs: null, docker: true, hostOs: null },
    ],
  };
  const { handlers, changes } = server([], { kinds: [mixed, KINDS[1]!] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => option.textContent)).toEqual(["First with roomAny of the 3 below, in order", "pveContainer · usually ~2.2 s", "mac-miniVM · usually ~26.0 s", "an unnamed machineContainer"]);
  expect(screen.queryByText(/host_1/)).toBeNull();
  // The menu lists the machines the providers run on, Macs first; the one that does not know yet adds none.
  expect(await optionsOf("Runs on")).toEqual(["Any machine", "a Mac", "a Linux machine"]);
  await choose("Runs on", "a Mac");
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["First with roomAny of the 2 below, in order", "mac-miniVM · usually ~26.0 s", "an unnamed machineContainer"]);
  // First with room among the providers the filters left sends them as a list, so the box never lands outside the filter (044).
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux on tart,docker:host_1"]));
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());

  // Reopened, the filters are back; Container on a Mac leaves the Docker machine, which the request then names alone.
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  expect((await screen.findByRole("combobox", { name: "Runs on" })).textContent).toBe("Runs on:Any machine");
  expect(screen.getByRole("combobox", { name: "Kind" }).textContent).toBe("Kind:All");
  await choose("Runs on", "a Mac");
  await choose("Kind", "Container");
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["First with roomThe one below", "an unnamed machineContainer"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux on tart,docker:host_1", "acquire linux on docker:host_1"]));
});

test("filters that leave no provider disable Create and say so", async () => {
  const pair: KindView = {
    ...KINDS[0]!,
    admin: null,
    forms: ["LXC", "VM"],
    offers: [KINDS[0]!.offers[0]!, { backend: "tart", name: "Tart on mac-mini", type: "tart", label: "Tart", hosts: ["mac-mini"], form: "VM", ready: 0, free: null, admin: true, resizable: false, typicalReadyMs: 26000, docker: true, hostOs: "macos" }],
  };
  const { handlers, changes } = server([], { kinds: [pair, KINDS[1]!] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("combobox", { name: "Kind" });
  await choose("Kind", "Container");
  await choose("Runs on", "a Mac");
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).queryAllByRole("radio")).toEqual([]);
  expect(screen.getByText("No provider matches these filters.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(submitButton().disabled).toBe(true);
  fireEvent.click(submitButton());
  expect(changes).toEqual([]);
  // All brings the Mac back, and Create box with it.
  await choose("Kind", "All");
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["First with roomThe one below", "mac-miniVM · usually ~26.0 s"]);
  expect(screen.queryByText("No provider matches these filters.")).toBeNull();
  expect(submitButton().disabled).toBe(false);
});

test("the form's words: a provider's title, the systems' hosts, the nearest choice and the filters", () => {
  const linux = KINDS[0]!;
  const offer = linux.offers[0]!;
  expect(providerTitle(offer)).toBe("pve");
  expect(providerTitle({ ...offer, type: "tart", hosts: ["mac-mini", "studio"] })).toBe("2 Macs");
  expect(providerTitle({ ...offer, hosts: ["pve1", "pve2", "pve3"] })).toBe("3 hosts");
  // A Docker machine BB has not named yet is never shown by its ID (the operator's rule).
  expect(providerTitle({ ...offer, type: "docker", label: "Docker", hosts: [] })).toBe("an unnamed machine");
  expect(providerTitle({ ...offer, type: "ssh-pool", label: "SSH host pool", hosts: [] })).toBe("SSH host pool");
  const mac: KindView = { ...linux, id: "macos", os: "macos", arch: "arm64", offers: [{ ...offer, backend: "tart", type: "tart", label: "Tart", hosts: ["mac-mini"], hostOs: "macos" }] };
  const many: KindView = { ...linux, id: "linux-arm64", arch: "arm64", offers: [offer, { ...offer, backend: "b", hosts: ["pve2"] }, { ...offer, backend: "c", hosts: ["pve3"] }] };
  expect(systemsOf([mac, many, linux]).map((system) => [system.label, system.words])).toEqual([
    ["Linux", "3 providers"],
    ["macOS", "mac-mini"],
  ]);
  // The nearest choice that exists: the system stays when it can, then the arch, the type and the GPU snap to what there is.
  expect(nearest(KINDS, { os: "linux", arch: "arm64", desktop: true, gpu: false })).toEqual({ os: "linux", arch: "x86_64", desktop: true, gpu: true });
  expect(nearest([mac], { os: "windows", arch: "x86_64", desktop: true, gpu: true })).toEqual({ os: "macos", arch: "arm64", desktop: false, gpu: false });
  expect(choiceOf(KINDS[1]!)).toEqual({ os: "linux", arch: "x86_64", desktop: true, gpu: true });
  expect(kindFor(KINDS, { os: "linux", arch: "x86_64", desktop: true, gpu: false })?.id).toBe("linux-desktop");
  // The filters: a Kind chip keeps its form; Runs on keeps the machine's OS and an offer that does not know it yet; Physical ignores Runs on.
  const pool = { ...offer, backend: "ssh-pool", type: "ssh-pool", form: "Physical" as const };
  const docker = { ...offer, backend: "docker:1", type: "docker", form: "Docker" as const, hostOs: null };
  const tart = { ...offer, backend: "tart", type: "tart", form: "VM" as const, hostOs: "macos" as const };
  expect((["LXC", "Docker", "VM", "Physical"] as const).map((form) => formFilterOf({ ...offer, form }))).toEqual(["container", "container", "vm", "physical"]);
  expect(runsOnOptions([offer, pool, docker, tart])).toEqual(["macos", "linux"]);
  expect(offersShown([offer, pool, docker, tart], "all", "macos").map((shown) => shown.backend)).toEqual(["docker:1", "tart"]);
  expect(offersShown([offer, pool, docker, tart], "container", "any").map((shown) => shown.backend)).toEqual(["fake", "docker:1"]);
  expect(offersShown([offer, pool, docker, tart], "physical", "macos").map((shown) => shown.backend)).toEqual(["ssh-pool"]);
  // The name the server made, which `on` takes too (044).
  expect(providerName({ type: "tart", label: "Tart", hosts: ["mac-mini", "studio"] })).toBe("Tart on 2 Macs");
  expect(providerName({ type: "tart", label: "Tart (VMs on a Mac)", hosts: ["mac-mini"] })).toBe("Tart on mac-mini");
  expect(providerName({ type: "ssh-pool", label: "SSH host pool", hosts: [] })).toBe("SSH host pool");
  expect(providerKeys("docker:devpc", { type: "docker", label: "Docker", hosts: ["devpc"] })).toEqual(["docker on devpc", "docker:devpc", "devpc"]);
  // The badge: a Linux kind or box without Docker, not one whose offers differ, nor another OS (041).
  expect([lacksDocker({ os: "linux", docker: false }), lacksDocker({ os: "linux", docker: null }), lacksDocker({ os: "linux", docker: true }), lacksDocker({ os: "windows", docker: false })]).toEqual([true, false, false, false]);
});

test("a field that takes a value from another backend names that backend when there are two of its type (#197)", () => {
  const lxc = (id: string, label?: string): BackendConfig => ({ id, type: "proxmox-lxc", ...(label ? { label } : {}), enabled: true, fields: {} });
  const document = (...backends: BackendConfig[]) => ({ schema: 1, revision: 1, backends, kinds: {}, general: {} }) as unknown as ConfigDocument;
  expect(sourceName(document(lxc("proxmox-lxc")), lxc("proxmox-lxc"), "Proxmox LXC")).toBe("Proxmox LXC");
  const two = document(lxc("proxmox-lxc"), lxc("proxmox-lxc:lab", "Lab"));
  expect(sourceName(two, lxc("proxmox-lxc"), "Proxmox LXC")).toBe("proxmox-lxc");
  expect(sourceName(two, lxc("proxmox-lxc:lab", "Lab"), "Proxmox LXC")).toBe("Lab");

  const inherits = { from: "proxmox-lxc", label: "Proxmox LXC", set: ["url", "token-secret"] };
  const url: FieldView = { key: "url", type: "string", label: "API URL", group: "connection", inherits } as unknown as FieldView;
  const secret: FieldView = { key: "token-secret", type: "string", secret: true, label: "Token secret", group: "credentials", inherits } as unknown as FieldView;
  render(<FieldControl field={url} value="" onChange={() => {}} problem={null} inherited="https://lab.example.com:8006/" from="Lab" />);
  render(<FieldControl field={secret} value="" onChange={() => {}} problem={null} inherited={{ set: true }} from="Lab" />);
  expect(screen.getAllByText("from Lab")).toHaveLength(2);
  cleanup();
  render(<FieldControl field={url} value="" onChange={() => {}} problem={null} inherited="https://pve.example.com:8006/" />);
  expect(screen.getByText("from Proxmox LXC")).toBeTruthy();
});

test("Docker on BB machines lists each machine with Docker's facts, and its switch makes it a Docker host (042)", async () => {
  const machine = (hostId: string, name: string, more: Partial<DockerHostView> = {}): DockerHostView => ({
    hostId,
    name,
    connected: true,
    docker: { version: "29.8.1", os: "Arch Linux", arch: "x86_64", cpus: 16, memoryMiB: 100 * 1024 },
    problem: null,
    absent: false,
    backend: null,
    images: null,
    ...more,
  });
  const { handlers, changes } = server([], {
    dockerHosts: [
      machine("host_b", "devpc"),
      machine("host_p", "plain", { docker: null, problem: null, absent: true }),
      machine("host_n", "no-docker", { docker: null, problem: "Docker did not answer: connect: no such file or directory" }),
      machine("host_o", "sleepy", { connected: false, docker: null, problem: "The machine is offline in BB.", backend: { id: "docker:sleepy", enabled: true, boxes: 1 } }),
      machine("host_g", "builder", { backend: { id: "docker:builder", enabled: true, boxes: 0 }, images: { state: "building", targets: ["linux", "desktop"], detail: "#5 [linux 2/9] RUN apt-get install", startedAt: 0, endedAt: null } }),
      machine("host_f", "broken", { backend: { id: "docker:broken", enabled: true, boxes: 0 }, images: { state: "failed", targets: ["linux"], detail: "build.sh exited with 1: ERROR: failed to solve", startedAt: 0, endedAt: 1 } }),
    ],
  });
  const slot = settings(handlers);
  expect(await slot.findByText("Docker on BB machines")).toBeTruthy();
  const row = (name: string) => slot.getByText(name).closest("[data-resource-row]") as HTMLElement;
  expect(within(row("devpc")).getByText("Can host boxes")).toBeTruthy();
  expect(within(row("devpc")).getByText("Docker 29.8.1")).toBeTruthy();
  expect(within(row("devpc")).getByText("16 cores")).toBeTruthy();
  expect(within(row("devpc")).getByText("100 GiB memory")).toBeTruthy();
  // Docker that is there but fails is red with its words; a machine with no Docker reads "No Docker", muted, and sits last.
  expect(within(row("no-docker")).getByText("Cannot host boxes")).toBeTruthy();
  expect(within(row("no-docker")).getByText(/Docker did not answer/)).toBeTruthy();
  expect((within(row("no-docker")).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect(within(row("plain")).getByText("No Docker")).toBeTruthy();
  expect(within(row("plain")).queryByText(/did not answer/)).toBeNull();
  expect((within(row("plain")).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  const names = slot.getAllByText(/^(devpc|plain|no-docker|sleepy|builder|broken)$/).map((node) => node.textContent);
  expect(names.indexOf("plain")).toBe(names.length - 1);
  expect(within(row("sleepy")).getByText("Offline in BB, 1 box on it")).toBeTruthy();
  // A machine turned on builds the images it lacks, and the row says so until the build ends.
  expect(within(row("builder")).getByText("Building linux and desktop images: #5 [linux 2/9] RUN apt-get install")).toBeTruthy();
  expect(within(row("broken")).getByText("Building its images failed: build.sh exited with 1: ERROR: failed to solve")).toBeTruthy();

  fireEvent.click(within(row("devpc")).getByRole("switch", { name: "Host boxes on devpc" }));
  await waitFor(() => expect(changes).toContain("docker.host.set host_b true"));
  expect(await within(row("devpc")).findByText("Hosts boxes")).toBeTruthy();
});
