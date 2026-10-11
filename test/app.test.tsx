// The panel, the desktop viewer and the settings section, rendered with the
// SDK's slot harness against fake RPC handlers and a fake noVNC. Run with
// vitest: npm run test:app.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ImageOptionView } from "../src/plugin/views.ts";
import type { ApplyResult, BoxResult, CheckResult, ConfigState, Contract, DesktopState, MachineEntry, PanelState, ThreadOnBox } from "../src/plugin/contract.ts";
import type { ConfigDocument, Problem } from "../src/core/document.ts";
import type { BackendView, BoxView, DoctorView, KindView, ProviderProfile } from "../src/plugin/views.ts";
import type { GpuRoom } from "../src/backends/types.ts";
import type { DockerHostView } from "../src/plugin/docker-hosts.ts";
import type { MachineAccessProblem, MachineSetup } from "../src/plugin/setup-offer.ts";
import { buildStep, roughly } from "../src/app/first-run.tsx";
import { forgetLive, isArm64Badge, lacksDocker, Meta } from "../src/app/common.tsx";
import { PASTE_CHORD_DELAY_MS, SETTLE_MS, forgetStreams, streamChoiceKey } from "../src/app/desktop.tsx";
import { CLIPBOARD_MAX_BYTES, SelkiesSession } from "../src/app/selkies.ts";
import { IMAGE_REQUEST } from "../src/app/new-box.tsx";
import { choiceOf, displayChoices, formFilterOf, gpuChoices, gpuFullNote, kindFor, nearest, offersShown, providerTitle, runsOnOptions, systemsOf } from "../src/app/box-form.tsx";
import { backendName } from "../src/app/settings-backends.tsx";
import { limitWords, makesWords, roomWords, runsOnWords, statusWords, usuallyWords } from "../src/app/provider-profile.tsx";
import { providerKeys, providerName } from "../src/core/provider-name.ts";
type BoxEntryLike = { threadId: string; box: BoxView; owner: "thread" | "yours" };
import { dropAllKept, HAND_BACK_MS, HIDDEN_MS } from "../src/app/kept.ts";
import { sparesWords } from "../src/app/settings-kinds.tsx";
import { statusOf, timingWords } from "../src/app/status.ts";
import { choices, NO_FILTERS, shown, stateGroup } from "../src/app/boxes-filter.ts";
import { sourceName, warmShortWords } from "../src/app/config.ts";
import { FieldControl } from "../src/app/settings-fields.tsx";
import type { BackendConfig } from "../src/core/document.ts";
import type { FieldView } from "../src/plugin/configuration.ts";
import packageJson from "../package.json";

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
    /** Keys sent with sendKey, in order. */
    keys: { keysym: number; code: string | null; down: boolean }[] = [];
    /** Text sent as the viewer's clipboard. */
    pasted: string[] = [];
    /** What the keyboard handler's events became, after the viewer's own mapping. */
    keyEvents: { keysym: number; code: string; down: boolean }[] = [];
    sendKey(keysym: number, code: string | null, down?: boolean) {
      if (down === undefined) {
        this.keys.push({ keysym, code, down: true }, { keysym, code, down: false });
        return;
      }
      this.keys.push({ keysym, code, down });
    }
    clipboardPasteFrom(text: string) {
      this.pasted.push(text);
    }
    _handleKeyEvent(keysym: number, code: string, down: boolean) {
      this.keyEvents.push({ keysym, code, down });
    }
    /** noVNC's canvas and cursor state: the box's cursor is none until it sends one; the connection state is connected throughout. */
    _canvas = document.createElement("canvas");
    _cursorImage = { rgbaPixels: new Uint8Array(), hotx: 0, hoty: 0, w: 0, h: 0 };
    _rfbConnectionState = "connected";
    cursorRefreshes = 0;
    /** As noVNC's own: the box's cursor goes on the canvas (a keyword stands in for its image URL, which jsdom's CSS would reject), an empty one as "none". */
    _refreshCursor() {
      this.cursorRefreshes++;
      this._canvas.style.cursor = this._cursorImage.w && this._cursorImage.h ? "crosshair" : "none";
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
    /** noVNC's defaults: the JPEG quality and zlib level it asks for. */
    qualityLevel = 6;
    compressionLevel = 2;
    /** Each SetEncodings and FramebufferUpdateRequest sent, in order, as noVNC's client messages would send them. */
    static sent: string[] = [];
    static messages = {
      clientEncodings: (_sock: unknown, encodings: number[]) => void FakeRfb.sent.push(`encodings ${encodings.join(",")}`),
      fbUpdateRequest: (_sock: unknown, incremental: boolean, x: number, y: number, w: number, h: number) =>
        void FakeRfb.sent.push(`${incremental ? "incremental" : "full"} ${x},${y},${w},${h}`),
    };
    _sock = {};
    /** As noVNC's: Tight, then the quality level, then a pseudo-encoding. */
    _sendEncodings() {
      FakeRfb.messages.clientEncodings(this._sock, [7, -32 + this.qualityLevel, -223]);
    }
    _display = { imageRect(..._rect: unknown[]) {}, blitImage(..._rect: unknown[]) {}, fillRect(..._rect: unknown[]) {}, videoFrame(..._rect: unknown[]) {} };
    /** One FramebufferUpdate read whole. */
    _framebufferUpdate() {
      return true;
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
  novnc.FakeRfb.sent = [];
  xterm.FakeTerminal.made = [];
  FakeSocket.made = [];
  FakeObserver.made = [];
  window.sessionStorage.clear();
  window.localStorage.clear();
  forgetStreams();
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
    stopped: null,
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
    windowing: id.includes("wayland") ? "wayland" : "x11",
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
        gpuRoom: null,
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
    { backend: "ssh-pool", name: "SSH host pool", type: "ssh-pool", label: "SSH host pool", hosts: [], form: "Physical", ready: 0, free: 1, admin: false, resizable: null, typicalReadyMs: null, docker: true, hostOs: "linux", gpuRoom: null },
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
function server(initial: BoxView[], options: { profileFailsOnce?: Set<string>; kinds?: KindView[]; failWith?: string; inUse?: ThreadOnBox[]; machines?: MachineEntry[]; runsOn?: PanelState["runsOn"]; imageOffer?: boolean; images?: ImageOptionView[]; config?: Partial<ConfigState>; checkWith?: CheckResult; applyWith?: ApplyResult; savedWith?: Problem[]; dockerHosts?: DockerHostView[]; setups?: MachineSetup[]; access?: MachineAccessProblem; video?: boolean } = {}) {
  let boxes = [...initial];
  let machines = [...(options.machines ?? [])];
  let dockerHosts = [...(options.dockerHosts ?? [])];
  let setups = [...(options.setups ?? [])];
  const changes: string[] = [];
  /** The providers whose profiles the form asked for, in order. */
  const asked: string[] = [];
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
  /** A box's clipboard where bb-box moves it with commands (#464): as the viewer pasted, or as the box copied. */
  let boxClipboard: { text: string; serial: number } | null = null;
  const copyInBox = (text: string) => (boxClipboard = { text, serial: (boxClipboard?.serial ?? 0) + 1 });
  const handlers: PluginRpcTestHandlers<Contract> = {
    state: ({ threadId }): PanelState => ({ boxes: threadId === THREAD ? boxes : [], kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, runsOn: options.runsOn ?? null, imageOffer: options.imageOffer ?? false, images: options.images ?? [] }),
    desktop: ({ box: ref }): DesktopState => ({ box: find(ref) ?? machines.find((entry) => entry.box.id === ref)?.box ?? (options.runsOn?.box.id === ref ? options.runsOn.box : null), desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, video: options.video ?? false }),
    profile: async () => ({ lines: [] }),
    "setup.offer": () => ({ machines: setups, access: options.access ?? null }),
    "setup.docker": ({ hostId }) => {
      changes.push(`setup.docker ${hostId}`);
      setups = setups.map((setup) => (setup.hostId === hostId ? { ...setup, state: "on" as const, build: { state: "building" as const, targets: ["linux"], detail: "#14 12.3 Setting up git (1:2.43.0) ...", step: { at: 7, of: 12 }, startedAt: Date.now() - 75_000, endedAt: null } } : setup));
      return { result: { ok: true, state: {} as ConfigState, problems: [] }, machines: setups };
    },
    ping: async () => {
      return null;
    },
    takeControl: ({ box: ref, viewer }) => change("takeControl", ref, (found) => ({ ...found, control: { owner: "human", holder: viewer } })),
    handBack: ({ box: ref }) => change("handBack", ref, (found) => ({ ...found, control: { owner: "agent", holder: null } })),
    desktopClipboard: () => boxClipboard,
    desktopPaste: ({ box: ref, viewer, text }) => {
      changes.push(`desktopPaste ${ref} ${viewer} ${text}`);
      boxClipboard = { text, serial: boxClipboard?.serial ?? 1 };
      return null;
    },
    images: () => options.images ?? [],
    allBoxes: () => boxes.map((found) => ({ threadId: THREAD, box: found, owner: "thread" as const })),
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
      asked.push(backend);
      if (options.profileFailsOnce?.has(backend)) {
        options.profileFailsOnce.delete(backend);
        throw new Error("The provider did not answer.");
      }
      return { ...PROFILE, backend, status: { ...PROFILE.status, checkedAt: Date.now() - 120_000 } };
    },
    thread: ({ box: ref, prompt }) => {
      changes.push(`thread ${ref} ${prompt}`);
      return { threadId: "thr_child", error: null };
    },
    acquire: ({ kind, size, on, image }) => {
      changes.push(`acquire ${kind}${size ? ` ${JSON.stringify(size)}` : ""}${on ? ` on ${on}` : ""}${image ? ` image ${image}` : ""}`);
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
              { id: "proxmox.api", name: "API", status: "fail", detail: "No answer from the API.", fix: "Check the URL." },
              { id: "proxmox.memory", name: "Disk", status: "ok", detail: "120 GiB free.", fix: null },
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
  return { handlers, changes, asked, copyInBox };
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
      general: { boxesPerThread: 0, enrol: true, defaultKind: "linux", video: true },
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
      warmShort: [],
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
    display: { protocol: "rfb", resizable: true, clipboard: null, refresh: null, quality: null },
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

test("the app registers the Boxes panel, a desktop tab, the Boxes page and the Backends settings section", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.title])).toEqual([
    ["boxes", "Box"],
    ["desktop", "Desktop"],
    ["terminal", "Terminal"],
  ]);
  expect(app.navPanels.map((page) => [page.id, page.title, page.path])).toEqual([["boxes", "Boxes", "desktop"]]);
  expect(app.settingsSections.map((section) => section.id)).toEqual(["configuration"]);
  // BB resolves a plugin's icons by the names it declares: the Boxes page's is the cube, and every plugin icon used is declared.
  expect(app.navPanels[0]!.icon).toBe("bb-box/box");
  const declared = Object.keys((packageJson as { bb: { branding: { experimental_icons: Record<string, string> } } }).bb.branding.experimental_icons);
  const used = [...app.navPanels, ...app.threadPanelActions].flatMap((slot) => (typeof slot.icon === "string" && slot.icon.startsWith("bb-box/") ? [slot.icon.slice("bb-box/".length)] : []));
  expect(used.filter((name) => !declared.includes(name))).toEqual([]);
  expect(declared).toContain("box");
});

test("a row keeps its name and kind on one line, and its status on one, dropping whole items from the end, with the whole line in a tooltip when it does", async () => {
  const slot = panel(server([desktopBox({ control: { owner: "human", holder: "viewer-9" } })]).handlers);
  await slot.findByText("bold-heron");
  // The first line does not wrap; the name gives way first.
  const name = slot.getByText("bold-heron");
  expect(name.className).toContain("truncate");
  expect(name.parentElement!.className).not.toContain("flex-wrap");
  // The second is one line high: the state, what to act on, then the rest; what does not fit drops whole from the end.
  const line = slot.getByText("Ready in 2.1 s").closest<HTMLElement>("[data-status-line]")!;
  expect(line.className).toContain("overflow-hidden");
  expect(line.className).toContain("h-[1.375em]");
  expect(line.textContent).toBe("Ready in 2.1 s·Another viewer has control·BB machine in 5.3 s·2 cores · 4 GiB");
  // A line that shows all of it has no tooltip on hover; one that lost an item shows the whole of it.
  fireEvent.pointerMove(line);
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.pointerLeave(line);
  Object.defineProperty(line, "scrollHeight", { configurable: true, value: 33 });
  Object.defineProperty(line, "clientHeight", { configurable: true, value: 16 });
  fireEvent.pointerMove(line);
  expect((await screen.findByRole("tooltip")).textContent).toBe("Ready in 2.1 s · Another viewer has control · BB machine in 5.3 s · 2 cores · 4 GiB");
});

test("a list of items separated by dots never starts a line with a dot: each item's dot sits before it, and the one that starts a line is clipped", () => {
  const { container } = render(<Meta items={["Ready in 2.1 s", null, "Threads: Shopping bot", false, "2 more"]} />);
  const clip = container.firstElementChild as HTMLElement;
  expect(clip.className).toContain("overflow-hidden");
  const list = clip.firstElementChild as HTMLElement;
  // The list sits one dot's width to the left, in the clip, so the dot of whichever item starts a line is out of sight.
  expect(list.className).toContain("-ml-[1.25em]");
  expect(list.className).toContain("flex-wrap");
  const items = Array.from(list.children);
  expect(items.map((item) => item.textContent)).toEqual(["·Ready in 2.1 s", "·Threads: Shopping bot", "·2 more"]);
  for (const item of items) expect(item.firstElementChild!.className).toContain("w-[1.25em]");
});

test("the status line says the state, then what to act on, then BB enrolment and the size", () => {
  const now = Date.now();
  expect(statusOf(box(), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "BB machine in 5.3 s", "2 cores · 4 GiB"]);
  expect(statusOf(box({ enrol: { state: "enrolling", hostId: null, error: null } }), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "Joining BB…", "2 cores · 4 GiB"]);
  // A claimed spare that waited stopped says how long its BB machine took to reconnect with the thread's access, as a new box says
  // how long it took to join (#539); one that ran has no such time, and says "BB machine".
  const resumed = box({ timings: { spare: 3, spareResume: 4100, total: 4100, spareReconnect: 17_200 } });
  expect(statusOf(resumed, now).items.map((item) => item.text)).toEqual(["Ready in 4.1 s", "BB machine in 17.2 s", "2 cores · 4 GiB"]);
  expect(timingWords(resumed)).toBe("claiming a spare\u00a03\u00a0ms · resuming it\u00a04.1\u00a0s · total\u00a04.1\u00a0s · BB machine reconnecting\u00a017.2\u00a0s");
  expect(statusOf(box({ timings: { spare: 3, total: 3 } }), now).items.map((item) => item.text)).toEqual(["Ready in 3 ms", "BB machine", "2 cores · 4 GiB"]);
  expect(statusOf(box({ enrol: { state: "failed", hostId: null, error: "no route" } }), now).items[1]).toEqual({ text: "Could not join BB", tone: "warn" });
  expect(statusOf(box({ enrol: { state: "off", hostId: null, error: null }, timings: {}, size: null }), now).items.map((item) => item.text)).toEqual(["Ready"]);
  expect(statusOf(box({ state: "acquiring", createdAt: now - 1400 }), now)).toEqual({ tone: "busy", items: [{ text: "Starting" }, { text: "1.4 s" }, { text: "2 cores · 4 GiB" }] });
  expect(statusOf(box({ state: "stopped", size: "8 cores, 16 GiB memory, 64 GiB disk" }), now)).toEqual({ tone: "off", items: [{ text: "Stopped" }, { text: "8 cores · 16 GiB · 64 GiB" }] });
  expect(statusOf(box({ state: "failed", error: "No GPU is left." }), now).items).toEqual([{ text: "Failed", tone: "danger" }]);
  expect(statusOf(box({ state: "gone" }), now).items.map((item) => item.text)).toEqual(["Gone", "deleted outside bb-box"]);
  expect(statusOf(desktopBox(), now).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "BB machine in 5.3 s", "2 cores · 4 GiB"]);
  // What to act on comes straight after the state, so a narrow row, which cuts the line from its end, keeps it.
  expect(statusOf(desktopBox({ facts: [{ label: "Display mode", value: "cpu" }] }), now).items[1]).toEqual({ text: "Display on the CPU", tone: "warn" });
  const held = desktopBox({ control: { owner: "human", holder: "viewer-1" } });
  expect(statusOf(held, now, new Set(["viewer-1"])).items[1]).toEqual({ text: "You have control", tone: "fg" });
  expect(statusOf(held, now, new Set()).items.map((item) => item.text)).toEqual(["Ready in 2.1 s", "Another viewer has control", "BB machine in 5.3 s", "2 cores · 4 GiB"]);
});

test("the panel lists the thread's boxes as rows, opens a row's details, and opens a desktop", async () => {
  const { handlers } = server([box({ timings: { clone: 700, total: 2100, enrol: 5300, "start.resume": 4100, "start.ssh": 1200, "start.clock": 600, "start.total": 6000 } }), desktopBox({ docker: false })]);
  const slot = panel(handlers);

  expect(await slot.findByText("calm-otter")).toBeTruthy();
  expect(slot.queryByText(/^\d+ box(es)?$/)).toBeNull();
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
    "Open in browser",
    "Open terminal",
    "Copy address",
    "New thread on this box…",
    "Stop",
    "Check now",
    "Release…",
  ]);
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Open in browser" }));
  // A full URL: BB's openUrl opens only http(s) URLs, by the person's browser preference, and returns false for a path.
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "openUrl", url: new URL("/plugins/bb-box/desktop/thr_panel/box_2", window.location.origin).href });
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
  expect(JSON.parse(window.localStorage.getItem("bb-box:new-box") ?? "{}")).toEqual({ kind: "linux-desktop", size: "large" });
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());

  // The form opens on the remembered kind; the default preset sends no size at all.
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  expect(within(await screen.findByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Small/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(['acquire linux-desktop {"preset":"large"}', "acquire linux-desktop"]));
});

test("New box offers to ask an agent to make the project a box image when it has none, in a new thread's composer (049)", async () => {
  const slot = panel(server([], { imageOffer: true }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "Type" });
  // One dim link in the footer, no sentence (the operator's note of 3 October 2026).
  expect(screen.queryByText(/standard tools/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Make a box image for this project" }));
  await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toCompose", options: { initialPrompt: IMAGE_REQUEST, focusPrompt: true } }));
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());

  // A project with an image, or none, gets no offer.
  const plain = panel(server([]).handlers);
  await plain.findAllByText("No boxes yet");
  fireEvent.click(plain.getAllByRole("button", { name: "New box" }).at(-1)!);
  await screen.findByRole("radiogroup", { name: "Type" });
  expect(screen.queryByRole("button", { name: "Make a box image for this project" })).toBeNull();
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

test("with 1 GPU chosen, the form says when no GPU has room, and only then (#603)", async () => {
  const now = Date.now();
  const reading = (id: string, freeMiB: number) => ({ id, freeMiB, totalMiB: 8192, at: now, neededMiB: 384, source: "desktop" as const });
  const full = { readings: [reading("gpu-a", 103)], fullUntil: now + 4 * 60_000 - 1_000 };
  const withRoom = (gpuRoom: GpuRoom) => KINDS.map((kind) => (kind.id === "linux-desktop" ? { ...kind, offers: kind.offers.map((offer) => ({ ...offer, gpuRoom })) } : kind));
  const cpu: KindView = { ...kindView("linux-desktop-cpu", "Linux desktop", "A desktop on the CPU.", 4, true), gpu: false };
  const { handlers } = server([], { kinds: [...withRoom(full), cpu] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "Type" });
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }));
  const note = "No GPU has room now: 103 MiB free, and a desktop needs 384 MiB. Choose None, or try again in 4 minutes.";
  expect(screen.queryByText(note)).toBeNull();
  await choose("GPU", "1 GPU");
  expect(screen.getByText(note).tagName).toBe("P");
  expect(screen.getByRole("combobox", { name: "GPU" }).textContent).toBe("1 GPU");
  await choose("GPU", "None");
  expect(screen.queryByText(note)).toBeNull();

  // Several GPUs give the most free; room on one, a refusal that has ended, or no reading say nothing.
  expect(gpuFullNote([{ ...KINDS[1]!.offers[0]!, gpuRoom: { readings: [reading("gpu-a", 103), reading("gpu-b", 21)], fullUntil: now + 60_000 } }], now)).toBe(
    "No GPU has room now: at most 103 MiB free, and a desktop needs 384 MiB. Choose None, or try again in 1 minute.",
  );
  expect(gpuFullNote([{ ...KINDS[1]!.offers[0]!, gpuRoom: { readings: [reading("gpu-a", 6100)], fullUntil: null } }], now)).toBeNull();
  expect(gpuFullNote([{ ...KINDS[1]!.offers[0]!, gpuRoom: full }], full.fullUntil)).toBeNull();
  expect(gpuFullNote([{ ...KINDS[1]!.offers[0]!, gpuRoom: null }], now)).toBeNull();
  expect(gpuFullNote([], now)).toBeNull();
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

test("the (i) on a provider row opens its profile, fetched for every provider once the form opens and kept, in plain rows; Escape closes the profile first", async () => {
  const { handlers, changes, asked } = server([], { kinds: [POOLED, KINDS[1]!], profileFailsOnce: new Set(["ssh-pool"]) });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  // Nothing is asked while the form is closed; once it opens, every listed provider's profile is fetched in the background.
  expect(asked).toEqual([]);
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("radiogroup", { name: "Provider" });
  await waitFor(() => expect(asked).toEqual(["fake", "ssh-pool"]));
  // The (i) opens filled, with no asking.
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
  expect(asked).toEqual(["fake", "ssh-pool"]);
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
  expect(asked).toEqual(["fake", "ssh-pool"]);
  // The pool's profile failed in the background; opening its (i) asks again, and the profile comes.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Linux containers on a test host.")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "About SSH host pool" }));
  await waitFor(() => expect(asked).toEqual(["fake", "ssh-pool", "ssh-pool"]));
  expect(await screen.findByText("Fake host on pve")).toBeTruthy();
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
  expect(asked).toEqual(["fake", "ssh-pool", "ssh-pool"]);
  // Closed and opened again, the form fetches afresh: the profiles live with the open form.
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByText("Linux containers on a test host.")).toBeNull());
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("radiogroup", { name: "System" })).toBeNull());
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await waitFor(() => expect(asked).toEqual(["fake", "ssh-pool", "ssh-pool", "fake", "ssh-pool"]));
});

test("the warm-short note names how short a pool is and why, in the operator's voice", () => {
  expect(warmShortWords({ kinds: ["linux-desktop"], count: 1, have: 0, reason: "pve has no memory left." })).toBe("Has 0 of 1 ready: no room. pve has no memory left.");
  expect(warmShortWords({ kinds: ["linux"], count: 2, have: 1, reason: "No host has room for a warm box." })).toBe("Has 1 of 2 ready: no room. No host has room for a warm box.");
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

test("a provider row says it has a spare ready now, with no count (#121, #440)", async () => {
  const [linux, desktop] = KINDS;
  const kinds = [{ ...linux!, spares: { target: 1, ready: 1, making: 0 }, offers: [{ ...linux!.offers[0]!, ready: 1 }] }, desktop!];
  const slot = panel(server([], { kinds }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · ready now · usually ~2.2 s"]);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }));
  expect(within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · usually ~3.1 s"]);
});

test("a provider row whose spares wait stopped says ready in seconds, as the claim resumes the spare first (#539)", async () => {
  const [linux] = KINDS;
  const kinds = [{ ...linux!, spares: { target: 1, ready: 1, making: 0 }, offers: [{ ...linux!.offers[0]!, ready: 1, spareStarts: true }] }];
  const slot = panel(server([], { kinds }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  expect(within(providers).getAllByRole("radio").map((option) => option.textContent)).toEqual(["pveContainer · ready in seconds · usually ~2.2 s"]);
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
  // It moves as BB's own dialogs do: a fade and a slight scale from the centre, no shadcn diagonal slide, none under reduced motion.
  expect(dialog.className).toContain("data-[state=open]:zoom-in-95");
  expect(dialog.className).toContain("duration-200");
  expect(dialog.className).not.toMatch(/slide-in-from|slide-out-to/);
  expect(dialog.className).toContain("motion-reduce:data-[state=open]:animate-none");
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

function setup(overrides: Partial<MachineSetup> = {}): MachineSetup {
  return { hostId: "host_bb", name: "bb", here: true, state: "ready", docker: "29.8.1", problem: null, fix: null, restart: null, kvm: "ok", freeGb: 120, build: null, ...overrides };
}

test("first run: the panel offers Docker on the machine that runs BB, and one click turns it on and shows the Linux image's build", async () => {
  const { handlers, changes } = server([], { kinds: [], setups: [setup({ hostId: "host_far", name: "far", here: false }), setup()] });
  const slot = panel(handlers);
  expect(await slot.findByText("This machine has Docker 29.8.1. BB Box can make Linux boxes there.")).toBeTruthy();
  expect(slot.getByText("Builds the Linux image first, about 5 to 8 min.")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Other backends" }).getAttribute("href")).toBe("/settings/plugins/bb-box");
  fireEvent.click(slot.getByRole("button", { name: "Use Docker on this machine" }));
  await waitFor(() => expect(changes).toEqual(["setup.docker host_bb"]));
  expect(await slot.findByText("Setting up Docker on this machine")).toBeTruthy();
  // The step is the one the build kept, not its last line; the time is what it usually takes, as it varies with the host.
  expect(slot.getByText("Building the Linux image · Step 7 of 12")).toBeTruthy();
  expect(slot.getByText("Started 1 min ago. It usually takes 5 to 8 min, and goes on if you close this panel.")).toBeTruthy();
  expect(slot.getByRole("progressbar", { name: "Building the Linux image" })).toBeTruthy();
});

test("first run: where BB's user cannot use Docker, the panel gives that machine's own fix and restart lines, says a restart ends turns, and checks again", async () => {
  const fix = setup({ state: "fix", problem: "Docker is on bb, but BB's user, dev, cannot use it. Add dev to the docker group, then restart BB's daemon there.", fix: "sudo usermod -aG docker dev", restart: "sudo systemctl restart user@1000.service" });
  const { handlers } = server([], { kinds: [], setups: [fix] });
  const slot = panel(handlers);
  expect(await slot.findByText(/^Docker is on bb, but BB's user, dev, cannot use it\./)).toBeTruthy();
  expect(slot.getByText("sudo usermod -aG docker dev")).toBeTruthy();
  expect(slot.getByText("sudo systemctl restart user@1000.service")).toBeTruthy();
  expect(slot.getByText(/^The second line restarts all of that user's services, BB's daemon among them\. That ends the turns of threads running there and, if the user has a desktop there, its audio, notifications and other services too\. Logging out and in again, or rebooting, does the same more gently\.$/)).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "setup.offer").length).toBeGreaterThan(1));
  cleanup();
  // Where bb-box cannot tell how BB runs, it says so in words, with the usermod line alone.
  const words = panel(server([], { kinds: [], setups: [{ ...fix, restart: null }] }).handlers);
  expect(await words.findByText("Then restart BB there, or log out and in again, or reboot. That ends the turns of threads running there.")).toBeTruthy();
  expect(words.queryByText(/systemctl/)).toBeNull();
});

test("a box that could not join BB says why in its row; for bb connect without a sign-in, in words with the two ways out and the guide", async () => {
  const signIn = "Enrolling box calm-otter failed: Sign in to your bb account to use bb connect";
  const slot = panel(server([box({ enrol: { state: "failed", hostId: null, error: signIn } })]).handlers);
  expect(await slot.findByText(/^BB's machine access, bb connect, needs you signed in to your bb account\. Sign in to it in BB, or set Machine access to Manual/)).toBeTruthy();
  expect(slot.getByRole("link", { name: "How boxes join BB" }).getAttribute("href")).toMatch(/docs\/guide\/boxes\.md#when-a-box-does-not-join-bb$/);
  cleanup();
  // Any other reason is BB's own words.
  const other = panel(server([box({ enrol: { state: "failed", hostId: null, error: "BB removed the machine before it connected" } })]).handlers);
  expect(await other.findByText(/^BB removed the machine before it connected\. See Machine access in BB's settings, under Machines\./)).toBeTruthy();
});

test("first run: where BB's machine access will not let boxes join, the offer says so up front", async () => {
  const slot = panel(server([], { kinds: [], setups: [setup()], access: { provider: "bb connect", message: "Sign in to your bb account to use bb connect" } }).handlers);
  expect(await slot.findByText(/^Boxes will not join BB yet\. BB's machine access, bb connect, needs you signed in to your bb account\./)).toBeTruthy();
  cleanup();
  const fine = panel(server([], { kinds: [], setups: [setup()] }).handlers);
  await fine.findByRole("button", { name: "Use Docker on this machine" });
  expect(fine.queryByText(/Boxes will not join BB yet/)).toBeNull();
});

test("first run in settings: with no backend on, the offer leads the page, without the link to settings itself; with one on, it is not there", async () => {
  const none = settings(server([], { setups: [setup()], config: { document: { schema: 1, revision: 1, backends: [], kinds: {}, general: {} } } }).handlers);
  expect(await none.findByRole("button", { name: "Use Docker on this machine" })).toBeTruthy();
  expect(none.queryByRole("link", { name: "Other backends" })).toBeNull();
  cleanup();
  const on = settings(server([], { setups: [setup({ state: "on" })] }).handlers);
  await on.findByText("Backends");
  expect(on.queryByRole("button", { name: "Use Docker on this machine" })).toBeNull();
});

test("once the Linux image is built, the panel says it is ready until the thread has a box", async () => {
  const built = setup({ state: "on", build: { state: "built", targets: ["linux"], detail: null, startedAt: Date.now() - 400_000, endedAt: Date.now() - 5_000 } });
  const slot = panel(server([], { setups: [built] }).handlers);
  expect(await slot.findByText("The Linux image is ready")).toBeTruthy();
  expect(slot.getByText("Make a box with the plus.")).toBeTruthy();
  cleanup();
  const withBox = panel(server([box()], { setups: [built] }).handlers);
  await withBox.findByText("calm-otter");
  expect(withBox.queryByText("The Linux image is ready")).toBeNull();
});

test("first run: with no machine to set up, the panel says BB Box is not set up yet, as before", async () => {
  const slot = panel(server([], { kinds: [], setups: [setup({ state: "none", docker: null })] }).handlers);
  expect(await slot.findByText("BB Box is not set up yet")).toBeTruthy();
});

test("a build's time reads in whole seconds under a minute and minutes after, and its step comes from Docker's build line", () => {
  expect([roughly(800), roughly(45_400), roughly(75_000), roughly(4 * 60_000)]).toEqual(["1 s", "45 s", "1 min", "4 min"]);
  expect(buildStep("#14 [linux 7/12] RUN /tmp/install-tools.sh")).toEqual({ step: 7, of: 12 });
  expect(buildStep("Sending build context")).toBeNull();
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
    checkWith: { problems: [], doctor: { ok: true, summary: "Fake host 1.0", checks: [{ id: "proxmox.api", name: "API", status: "ok", detail: "Answers.", fix: null }], notes: ["Install this key: ssh-ed25519 AAAA"] } },
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

test("a kind's warm pool short of room shows a note under that backend's warm count, and none when it has room", async () => {
  const short = { kinds: ["linux"], count: 1, have: 0, reason: "pve has no memory left." };
  const withShort = configState({}).backends.map((backend) => (backend.id === "fake" ? { ...backend, warmShort: [short] } : backend));
  const slot = settings(server([], { config: { backends: withShort } }).handlers);
  fireEvent.click((await slot.findAllByRole("button", { name: "Edit" }))[0]!);
  expect(slot.getByText("Has 0 of 1 ready: no room. pve has no memory left.")).toBeTruthy();

  const ok = settings(server([]).handlers);
  fireEvent.click((await ok.findAllByRole("button", { name: "Edit" }))[0]!);
  expect(ok.queryByText(/no room/)).toBeNull();
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

test("files for every box show each path and whether it is set, never a content, and save at once, sending a kept file's path alone (#455)", async () => {
  // As saved: config.get gives the document last applied.
  applied = { schema: 1, revision: 3, backends: [], kinds: {}, general: { files: [{ path: ".pi/agent/models.json", content: { set: true } }] } };
  const { handlers, changes } = server([]);
  const slot = settings(handlers);
  expect(await slot.findByText(".pi/agent/models.json")).toBeTruthy();
  expect(slot.getByText("Set")).toBeTruthy();
  const sent = (at: number) => JSON.parse(changes[at]!.slice(changes[at]!.indexOf("{"))).general.files;

  fireEvent.click(slot.getByRole("button", { name: "Add file" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Path under the box user's home" }), { target: { value: " .config/tool/config.toml " } });
  fireEvent.change(slot.getByRole("textbox", { name: "The file's content" }), { target: { value: "key = 1" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(changes).toHaveLength(1));
  expect(sent(0)).toEqual([{ path: ".pi/agent/models.json" }, { path: ".config/tool/config.toml", content: "key = 1" }]);
  await waitFor(() => expect(slot.queryByRole("textbox", { name: "The file's content" })).toBeNull());
  expect(slot.queryByText(/key = 1/)).toBeNull();

  // Replace keeps the path; Remove sends the rest, each by its path alone.
  fireEvent.click(slot.getAllByRole("button", { name: "Replace" })[0]!);
  expect((slot.getByRole("textbox", { name: "Path under the box user's home" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(slot.getByRole("textbox", { name: "The file's content" }), { target: { value: "{}" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(changes).toHaveLength(2));
  expect(sent(1)).toEqual([{ path: ".pi/agent/models.json", content: "{}" }, { path: ".config/tool/config.toml" }]);
  fireEvent.click(slot.getAllByRole("button", { name: "Remove" })[1]!);
  await waitFor(() => expect(changes).toHaveLength(3));
  expect(sent(2)).toEqual([{ path: ".pi/agent/models.json" }]);
});

function desktopTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_2") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a desktop that cannot be resized says only that you have control, and noVNC does not resize it", async () => {
  const { handlers } = server([desktopBox({ kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: false, clipboard: null, refresh: null, quality: null } })]);
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

test("every desktop is asked for JPEG quality 2, and an X11 one, whose server sends a still area again itself, is not asked again (056)", async () => {
  const { handlers } = server([desktopBox()]);
  desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  expect([client!.qualityLevel, client!.compressionLevel]).toEqual([2, 2]);
  act(() => void client!.dispatchEvent(new Event("connect")));
  vi.useFakeTimers();
  client!._display.imageRect(0, 0, 100, 50, "image/jpeg", new Uint8Array());
  client!._framebufferUpdate();
  act(() => void vi.advanceTimersByTime(1000));
  expect(novnc.FakeRfb.sent).toEqual([]);
});

test("a Wayland desktop's viewer asks for a still area it drew as JPEG again with no quality level, then for JPEG again (056)", async () => {
  const wayland = desktopBox({ kind: "linux-desktop-wayland-cpu", gpu: false, display: { protocol: "rfb", resizable: true, clipboard: null, refresh: "viewer", quality: null } });
  const { handlers } = server([wayland]);
  desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  vi.useFakeTimers();
  // A scroll: JPEG rects, then nothing for a moment.
  client!._display.imageRect(0, 0, 100, 50, "image/jpeg", new Uint8Array());
  client!._display.imageRect(0, 50, 200, 50, "image/jpeg", new Uint8Array());
  client!._framebufferUpdate();
  act(() => void vi.advanceTimersByTime(249));
  expect(novnc.FakeRfb.sent).toEqual([]);
  act(() => void vi.advanceTimersByTime(1));
  expect(novnc.FakeRfb.sent).toEqual(["encodings 7,-223", "full 0,0,200,100"]);
  // wayvnc answers losslessly: the viewer asks for quality 2 again, and nothing more.
  client!._display.blitImage(0, 0, 200, 100, new Uint8Array(), 0);
  client!._framebufferUpdate();
  act(() => void vi.advanceTimersByTime(1000));
  expect(novnc.FakeRfb.sent).toEqual(["encodings 7,-223", "full 0,0,200,100", "encodings 7,-30,-223"]);
});

test("a desktop whose display names a JPEG quality is asked for that one, as Windows on a Mac's 4 (056)", async () => {
  const windows = desktopBox({ kind: "windows-arm64-desktop", os: "windows", gpu: false, display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4 } });
  const { handlers } = server([windows]);
  desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  await waitFor(() => expect(client!.qualityLevel).toBe(4));
  // Its refresh returns to quality 4, not the viewer's own 2.
  vi.useFakeTimers();
  client!._display.imageRect(0, 0, 64, 64, "image/jpeg", new Uint8Array());
  client!._framebufferUpdate();
  act(() => void vi.advanceTimersByTime(250));
  client!._display.blitImage(0, 0, 64, 64, new Uint8Array(), 0);
  client!._framebufferUpdate();
  expect(novnc.FakeRfb.sent).toEqual(["encodings 7,-223", "full 0,0,64,64", "encodings 7,-28,-223"]);
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

/** This computer's clipboard, as the tests stand in for it. */
function fakeClipboard(readText: () => Promise<string>) {
  const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { readText, writeText }, configurable: true });
  return { writeText };
}

/** A keydown on the desktop's canvas, as noVNC would see it. */
function keyOnCanvas(slot: ReturnType<typeof desktopTab>, init: KeyboardEventInit) {
  const screen = slot.getByTestId("desktop-screen").firstElementChild!;
  const canvas = document.createElement("canvas");
  screen.appendChild(canvas);
  const reached = vi.fn();
  canvas.addEventListener("keydown", reached);
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  canvas.dispatchEvent(event);
  return { event, reached };
}

function pasteEvent(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => (type === "text/plain" ? text : "") } });
  return event;
}

type FakeClient = { pasted: string[]; keys: { keysym: number; code: string | null; down: boolean }[]; keyEvents: { keysym: number; code: string; down: boolean }[]; _handleKeyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void } & EventTarget;

test("with control, Cmd+V on a Mac pastes this computer's text into a Linux box with the box's Ctrl+V, and Cmd stands for Ctrl there", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  try {
    const { handlers } = server([desktopBox()]);
    const slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    // Before control, a Cmd+V is noVNC's to drop.
    expect(keyOnCanvas(slot, { key: "v", metaKey: true }).reached).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    // Cmd is Ctrl in the box: noVNC's Meta becomes Control_L, code and all, so QEMU's scancode follows too.
    client._handleKeyEvent(0xffe7, "MetaLeft", true, null, null);
    client._handleKeyEvent(0x63, "KeyC", true, null, null);
    expect(client.keyEvents).toEqual([
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 0x63, code: "KeyC", down: true },
    ]);
    // Cmd+V: kept from noVNC, left to the browser, whose paste event brings the text; the box gets it, then its own Ctrl+V.
    vi.useFakeTimers();
    const { event, reached } = keyOnCanvas(slot, { key: "v", metaKey: true });
    expect(reached).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    const paste = pasteEvent("hello from the Mac");
    act(() => void document.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    expect(client.pasted).toEqual(["hello from the Mac"]);
    expect(client.keys).toEqual([]);
    act(() => void vi.advanceTimersByTime(PASTE_CHORD_DELAY_MS));
    expect(client.keys).toEqual([
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 0x76, code: "KeyV", down: true },
      { keysym: 0x76, code: "KeyV", down: false },
      { keysym: 0xffe3, code: "ControlLeft", down: false },
    ]);
    expect(slot.getByText("Pasted")).toBeTruthy();
    // A paste event meant for a field elsewhere is not the desktop's.
    const elsewhere = pasteEvent("for the composer");
    act(() => void document.dispatchEvent(elsewhere));
    expect(elsewhere.defaultPrevented).toBe(false);
    expect(client.pasted).toEqual(["hello from the Mac"]);
  } finally {
    platform.mockRestore();
    vi.useRealTimers();
  }
});

test("a macOS box keeps Cmd, and the menu's Paste reads this computer's clipboard on the click and presses the box's Cmd+V", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  fakeClipboard(() => Promise.resolve("from the menu"));
  try {
    // A pool Mac (real), whose own input takes the clipboard as noVNC sends it.
    const { handlers } = server([desktopBox({ os: "macos", nature: "real", kind: "macos-desktop", kindLabel: "macOS desktop" })]);
    const slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    client._handleKeyEvent(0xffe7, "MetaLeft", true, null, null);
    expect(client.keyEvents).toEqual([{ keysym: 0xffe7, code: "MetaLeft", down: true }]);
    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
    await waitFor(() => expect(client.pasted).toEqual(["from the menu"]));
    expect(await slot.findByText("Pasted")).toBeTruthy();
    // The chord follows after its short wait, on real timers here.
    await waitFor(() => expect(client.keys).toHaveLength(4));
    expect(client.keys.map((key) => `${key.code}:${key.down ? "down" : "up"}`)).toEqual(["MetaLeft:down", "KeyV:down", "KeyV:up", "MetaLeft:up"]);
  } finally {
    platform.mockRestore();
  }
});

test("when this computer's clipboard cannot be read, the menu's Paste offers a field whose text goes to the box", async () => {
  fakeClipboard(() => Promise.reject(new Error("Read permission denied.")));
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Paste into bold-heron")).toBeTruthy();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Text to paste" }), { target: { value: "typed into the field" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Paste into the box" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(client.pasted).toEqual(["typed into the field"]);
});

test("what the box copies reaches this computer's clipboard quietly; the menu's Copy writes it on the click and says Copied, or says why when nothing came", async () => {
  const { writeText } = fakeClipboard(() => Promise.resolve(""));
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  // Nothing yet: Copy says to copy in the box first.
  let menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy to this computer" }));
  expect((await slot.findByText("Nothing has come from the box's clipboard yet. Copy something in the box first.")).getAttribute("role")).toBe("status");
  // The box's cut text, as noVNC gives it to the viewer with control: it can come with no copy of the person's, so no note.
  act(() => void client.dispatchEvent(new CustomEvent("clipboard", { detail: { text: "from the box" } })));
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("from the box"));
  expect(slot.queryByText("Copied")).toBeNull();
  menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy to this computer" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
  expect(await slot.findByText("Copied")).toBeTruthy();

  cleanup();
  dropAllKept();
  // A Windows box through QEMU's console: the message says the console does not send it.
  const windows = desktopTab(server([desktopBox({ id: "box_7", name: "win-7", os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: false, clipboard: null, refresh: null, quality: null } })]).handlers, "box_7");
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
  act(() => void novnc.FakeRfb.made[1]!.dispatchEvent(new Event("connect")));
  menu = await openMenu(windows.getByRole("button", { name: "Desktop actions" }));
  expect(within(menu).getByRole("menuitem", { name: "Paste from this computer" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy to this computer" }));
  expect(await windows.findByText(/does not report its clipboard to viewers/)).toBeTruthy();

});

test("clipboard outcomes are toolbar notes that go after about 3 s, never from taking control; a paste the box refused is a lasting problem with Dismiss", async () => {
  fakeClipboard(() => Promise.resolve(""));
  const { handlers } = server([desktopBox({ id: "box_8", name: "mac-8", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null } })]);
  const refusing: PluginRpcTestHandlers<Contract> = {
    ...handlers,
    desktopPaste: () => {
      throw new Error("Box mac-8 did not take the text for its clipboard: no desktop session.");
    },
  };
  const slot = desktopTab(refusing, "box_8");
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  // Taking control tried this computer's empty clipboard, and says nothing of it.
  expect(slot.queryByRole("status")).toBeNull();
  expect(slot.queryByRole("alert")).toBeNull();

  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
    const note = await slot.findByText("This computer's clipboard has no text.");
    expect(note.getAttribute("role")).toBe("status");
    expect(slot.queryByRole("alert")).toBeNull();
    act(() => void vi.advanceTimersByTime(3_000));
    expect(slot.queryByText("This computer's clipboard has no text.")).toBeNull();
  } finally {
    vi.useRealTimers();
  }

  // A Ctrl+V (Cmd+V on a Mac) whose text the box refused needs action: it stays, in red, until dismissed.
  keyOnCanvas(slot, { key: "v", ctrlKey: true });
  act(() => void document.dispatchEvent(pasteEvent("for the box")));
  const problem = await slot.findByRole("alert");
  expect(problem.textContent).toBe("Box mac-8 did not take the text for its clipboard: no desktop session.");
  expect(slot.queryByText("Pasted")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  expect(slot.queryByRole("alert")).toBeNull();
});

test("a macOS VM on Tart, whose VNC server moves no clipboard, has it through bb-box: Paste and Cmd+V send the text as UTF-8 by RPC, then press Cmd+V, and Copy reads the box's (#464)", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  const { writeText } = fakeClipboard(() => Promise.resolve("héllo, wörld ✓ 日本"));
  try {
    const { handlers, changes, copyInBox } = server([desktopBox({ id: "box_8", name: "mac-8", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null } })]);
    const slot = desktopTab(handlers, "box_8");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    const viewer = new URL(novnc.FakeRfb.made[0]!.url).searchParams.get("viewer");
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    // Taking control sends this computer's clipboard to the box, by RPC and not as noVNC's Latin-1 cut text.
    await waitFor(() => expect(changes).toContain(`desktopPaste box_8 ${viewer} héllo, wörld ✓ 日本`));

    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
    await waitFor(() => expect(client.keys).toHaveLength(4));
    expect(client.keys.map((key) => `${key.code}:${key.down ? "down" : "up"}`)).toEqual(["MetaLeft:down", "KeyV:down", "KeyV:up", "MetaLeft:up"]);
    expect(await slot.findByText("Pasted")).toBeTruthy();
    expect(changes.filter((change) => change.startsWith("desktopPaste"))).toHaveLength(2);

    // Cmd+V on the desktop: the browser's paste event's text goes the same way.
    keyOnCanvas(slot, { key: "v", metaKey: true });
    act(() => void document.dispatchEvent(pasteEvent("ünïcode → box")));
    await waitFor(() => expect(changes).toContain(`desktopPaste box_8 ${viewer} ünïcode → box`));
    await waitFor(() => expect(client.keys).toHaveLength(8));
    expect(client.pasted).toEqual([]);

    // What the box copies comes back through the RPC, and Copy writes it here.
    copyInBox("from the Mac ✓");
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Copy to this computer" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("from the Mac ✓"));
  } finally {
    platform.mockRestore();
  }
});

test("a Windows box, whose QEMU console moves no clipboard, has it through bb-box: Cmd+V from a Mac and the menu's Paste send UTF-8 by RPC, then press the box's Ctrl+V, and Copy reads the box's (#461)", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  const { writeText } = fakeClipboard(() => Promise.resolve("from the Mac ✓"));
  try {
    const { handlers, changes, copyInBox } = server([desktopBox({ id: "box_7", name: "win-7", os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: null, quality: null } })]);
    const slot = desktopTab(handlers, "box_7");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    const viewer = new URL(novnc.FakeRfb.made[0]!.url).searchParams.get("viewer");
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    // The menu's items are live here, not the old "does not report its clipboard" words.
    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    expect(within(menu).getByRole("menuitem", { name: "Paste from this computer" }).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
    await waitFor(() => expect(changes).toContain(`desktopPaste box_7 ${viewer} from the Mac ✓`));
    // Windows' paste chord is Ctrl+V, whatever the browser's platform.
    await waitFor(() => expect(client.keys).toHaveLength(4));
    expect(client.keys.map((key) => `${key.code}:${key.down ? "down" : "up"}`)).toEqual(["ControlLeft:down", "KeyV:down", "KeyV:up", "ControlLeft:up"]);
    // Cmd+V on the desktop: the browser's paste event's text goes by RPC too, not as noVNC's Latin-1 cut text.
    keyOnCanvas(slot, { key: "v", metaKey: true });
    act(() => void document.dispatchEvent(pasteEvent("日本 → Windows")));
    await waitFor(() => expect(changes).toContain(`desktopPaste box_7 ${viewer} 日本 → Windows`));
    await waitFor(() => expect(client.keys).toHaveLength(8));
    expect(client.pasted).toEqual([]);
    // What the box copies comes back through the RPC, and Copy writes it here.
    copyInBox("copied in Windows ✓");
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Copy to this computer" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copied in Windows ✓"));
    expect(slot.queryByText(/does not report its clipboard/)).toBeNull();
  } finally {
    platform.mockRestore();
  }
});

test("the pointer over the desktop: the local arrow without control whatever the box sends, the box's cursor with control, and never an invisible one", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient & { _canvas: HTMLCanvasElement; _cursorImage: { rgbaPixels: Uint8Array; hotx: number; hoty: number; w: number; h: number }; _refreshCursor(): void };
  act(() => void client.dispatchEvent(new Event("connect")));
  // Without control: the arrow, even once the box sends a cursor of its own, and even an empty one.
  expect(client._canvas.style.cursor).toBe("default");
  const arrow = { rgbaPixels: new Uint8Array([0, 0, 0, 255]), hotx: 0, hoty: 0, w: 1, h: 1 };
  const hidden = { rgbaPixels: new Uint8Array([0, 0, 0, 0]), hotx: 0, hoty: 0, w: 1, h: 1 };
  client._cursorImage = arrow;
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("default");
  client._cursorImage = hidden;
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("default");
  // With control: the box's cursor, as noVNC puts it; an empty one, or none, is the arrow instead.
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  client._cursorImage = arrow;
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("crosshair");
  client._cursorImage = hidden;
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("default");
  client._cursorImage = { rgbaPixels: new Uint8Array(), hotx: 0, hoty: 0, w: 0, h: 0 };
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("default");
  // Handing back puts the arrow back at once, without waiting for the box to send a cursor.
  client._cursorImage = arrow;
  client._refreshCursor();
  expect(client._canvas.style.cursor).toBe("crosshair");
  fireEvent.click(slot.getByRole("button", { name: "Hand back to the agent" }));
  await slot.findByText("The agent has control.");
  expect(client._canvas.style.cursor).toBe("default");
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

/** WebCodecs, which jsdom lacks: each decoder shows each chunk at once, as a 1280x800 frame. */
class FakeDecoder {
  static made: FakeDecoder[] = [];
  state = "unconfigured";
  readonly chunks: { type: string; timestamp: number }[] = [];
  readonly #output: (frame: unknown) => void;
  constructor(init: { output: (frame: unknown) => void }) {
    this.#output = init.output;
    FakeDecoder.made.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
    this.chunks.push(chunk);
    this.#output({ displayWidth: 1280, displayHeight: 800, timestamp: chunk.timestamp, close() {} });
  }
  close() {
    this.state = "closed";
  }
}

/** Puts WebCodecs and a secure context in place for a test that shows video, and takes them away after. */
function withVideo() {
  FakeDecoder.made = [];
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal("EncodedVideoChunk", class {
    readonly type: string;
    readonly timestamp: number;
    constructor(init: { type: string; timestamp: number }) {
      this.type = init.type;
      this.timestamp = init.timestamp;
    }
  });
  vi.stubGlobal("isSecureContext", true);
  return () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("ResizeObserver", FakeObserver);
  };
}

/** A Selkies video message: type 4, H.264, its frame id. */
function videoFrame(id: number, key: boolean): ArrayBuffer {
  const bytes = new Uint8Array(20);
  bytes[0] = 4;
  bytes[1] = 0x10 | (key ? 1 : 0);
  bytes[2] = id >> 8;
  bytes[3] = id & 0xff;
  return bytes.buffer;
}

/** The video socket the viewer opened: through the relay, with &stream=selkies. */
function videoSocket(): FakeSocket {
  const socket = FakeSocket.made.find((made) => new URL(made.url).searchParams.get("stream") === "selkies");
  if (!socket) throw new Error("no video socket");
  return socket;
}

test("with the setting on, a desktop shows as video whatever the round trip to BB's server, and over VNC with the setting off (056)", async () => {
  const undo = withVideo();
  try {
    // The setting off: VNC.
    const off = server([desktopBox()]);
    desktopTab(off.handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    cleanup();
    dropAllKept();
    forgetStreams();
    forgetLive();
    novnc.FakeRfb.made = [];
    FakeSocket.made = [];

    // On: video, through the relay, with no round trips timed, however quick BB's server answers.
    const on = server([desktopBox()], { video: true });
    const slot = desktopTab(on.handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    expect(novnc.FakeRfb.made).toHaveLength(0);
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "ping")).toEqual([]);
    const socket = videoSocket();
    const url = new URL(socket.url);
    expect([url.pathname, url.searchParams.get("box")]).toEqual([DESKTOP_PATH, "box_2"]);
    act(() => socket.open());
    expect(socket.sent).toEqual(['SETTINGS,{"displayId":"primary"}', "START_VIDEO"]);
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    // A delta before the first key frame is dropped; the key frame shows, and the desktop is connected.
    act(() => void socket.onmessage?.({ data: videoFrame(4, false) }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    expect(FakeDecoder.made.at(-1)!.chunks).toEqual([{ type: "key", timestamp: 5 }]);
    expect(await slot.findByText("The agent has control.")).toBeTruthy();
    // It says which frame it has shown.
    await waitFor(() => expect(socket.sent).toContain("CLIENT_FRAME_ACK 5 0"));

    // With control, keys go as Selkies' kd and ku, and the pointer as m; without, nothing goes.
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(socket.sent.filter((sent) => typeof sent === "string" && sent.startsWith("kd,"))).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA" });
    expect(socket.sent).toContain("kd,97");
    expect(socket.sent).toContain("ku,97");
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(socket.sent.at(-1)).toBe("m,0,0,1,0");
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    expect(socket.sent.at(-1)).toBe("m,0,0,0,0");

    // The box's clipboard, for the viewer with control, goes to this computer's.
    const { writeText } = fakeClipboard(() => Promise.resolve(""));
    act(() => void socket.onmessage?.({ data: `clipboard,${btoa("from the box")}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("from the box"));

    // The menu's "Show as VNC", unticked while video shows, turns it to VNC, which the tab keeps for this box only.
    const item = within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(window.sessionStorage.getItem(streamChoiceKey("box_2"))).toBe("rfb");
    expect(window.localStorage.length).toBe(0);
    expect(socket.readyState).toBe(3);
    expect(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }).getAttribute("aria-checked")).toBe("true");
  } finally {
    undo();
  }
});

test("a desktop whose video does not start shows over VNC, and says why (056)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => socket.end(1011, "This box's desktop has no Selkies stream"));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    // The outcome first, the reason in its tooltip.
    const note = slot.getByText("Video did not start, so this shows VNC.");
    expect(note.getAttribute("title")).toBe("This box's desktop has no Selkies stream.");
  } finally {
    undo();
  }
});

test("a video session stops its video while hidden, and starts again from a key frame; it pastes as Selkies' cw and the box's chord (056)", async () => {
  const undo = withVideo();
  vi.useFakeTimers();
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    socket.onmessage?.({ data: videoFrame(1, true) });
    expect(session.connection.state).toBe("connected");
    socket.sent.length = 0;
    session.hidden = true;
    expect(socket.sent).toEqual(["STOP_VIDEO"]);
    session.hidden = false;
    expect(socket.sent).toEqual(["STOP_VIDEO", "START_VIDEO", "REQUEST_KEYFRAME"]);
    socket.sent.length = 0;
    session.setControl(true, true);
    session.paste("héllo");
    vi.advanceTimersByTime(PASTE_CHORD_DELAY_MS);
    // Acknowledgements go on meanwhile, every 50 ms.
    expect(socket.sent.filter((sent) => !String(sent).startsWith("CLIENT_FRAME_ACK"))).toEqual([
      `cw,${btoa(String.fromCharCode(...new TextEncoder().encode("héllo")))}`,
      "kd,65507",
      "kd,118",
      "ku,118",
      "ku,65507",
    ]);
    session.dispose();
  } finally {
    vi.useRealTimers();
    undo();
  }
});

test("a video viewer sends its size as it takes control, and as its video connects with control already held, as VNC does", async () => {
  const undo = withVideo();
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    // jsdom lays nothing out: the viewer's size, as a browser gives it.
    Object.defineProperty(session.element, "clientWidth", { value: 1366.5, configurable: true });
    Object.defineProperty(session.element, "clientHeight", { value: 768, configurable: true });
    const socket = FakeSocket.made.at(-1)!;
    const sizes = () => socket.sent.filter((sent) => String(sent).startsWith("r,"));
    act(() => socket.open());
    session.setControl(true, true);
    expect(sizes()).toEqual([]);
    socket.onmessage?.({ data: videoFrame(1, true) });
    expect(session.connection.state).toBe("connected");
    expect(sizes()).toEqual(["r,1366x768"]);
    session.setControl(false, true);
    session.setControl(true, true);
    expect(sizes()).toEqual(["r,1366x768", "r,1366x768"]);
    // A desktop that cannot follow the viewer is not asked to.
    session.setControl(false, false);
    session.setControl(true, false);
    expect(sizes()).toHaveLength(2);
    session.dispose();
  } finally {
    undo();
  }
});

/** Bytes as Selkies sends them in a clipboard message: base64. */
function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** An image's bytes, as a test stands in for a PNG: any bytes, in a Blob of its type. */
function fakePng(size: number): Uint8Array<ArrayBuffer> {
  return Uint8Array.from({ length: size }, (_, index) => index % 251);
}

test("the video client takes the box's images and long text from Selkies, whole or in parts, and the text beside copied markup (#609)", async () => {
  const undo = withVideo();
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const texts: string[] = [];
    const images: Blob[] = [];
    session.onClipboard = (text) => texts.push(text);
    session.onClipboardImage = (image) => images.push(image);
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    const say = (data: string) => socket.onmessage?.({ data });
    // An image in one message.
    const small = fakePng(100);
    say(`clipboard_binary,image/png,${b64(small)}`);
    // An image in parts, as Selkies sends anything over a chunk.
    const large = fakePng(40_000);
    say(`clipboard_start,image/png,${large.byteLength}`);
    for (let offset = 0; offset < large.byteLength; offset += 16_383) say(`clipboard_data,${b64(large.subarray(offset, offset + 16_383))}`);
    say("clipboard_finish");
    // Long text in parts, and markup with its text beside it.
    const long = "x".repeat(20_000);
    say(`clipboard_start,text/plain,${long.length}`);
    say(`clipboard_data,${btoa(long.slice(0, 16_383))}`);
    say(`clipboard_data,${btoa(long.slice(16_383))}`);
    say("clipboard_finish");
    say(`clipboard_binary,application/x-selkies-clipboard-flavours,${btoa(JSON.stringify({ "text/html": "<b>bold</b>", "text/plain": "bold" }))}`);
    // Parts that do not add up are dropped.
    say("clipboard_start,image/png,10");
    say(`clipboard_data,${b64(fakePng(4))}`);
    say("clipboard_finish");
    expect(texts).toEqual([long, "bold"]);
    expect(images.map((image) => image.type)).toEqual(["image/png", "image/png"]);
    expect(new Uint8Array(await images[0]!.arrayBuffer())).toEqual(small);
    expect(new Uint8Array(await images[1]!.arrayBuffer())).toEqual(large);
    session.dispose();
  } finally {
    undo();
  }
});

test("the video client pastes an image as Selkies' cb, or cbs, cbd and cbe when it is over a chunk, then the box's chord; Cmd+V takes an image too (#609)", async () => {
  const undo = withVideo();
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const pasted: (string | Blob | null)[] = [];
    const failed: unknown[] = [];
    session.onPaste = (what) => pasted.push(what);
    session.onPasteFailed = (error) => failed.push(error);
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    socket.onmessage?.({ data: videoFrame(1, true) });
    session.setControl(true, true);
    const clipboardSent = () => socket.sent.filter((sent): sent is string => typeof sent === "string" && /^c[wb][sde]?,/.test(sent));

    const small = new Blob([fakePng(100)], { type: "image/png" });
    await session.pasteImage(small);
    expect(clipboardSent()).toEqual([`cb,image/png,${b64(fakePng(100))}`]);
    await waitFor(() => expect(socket.sent).toContain("ku,118"));
    expect(pasted).toEqual([small]);

    socket.sent.length = 0;
    const bytes = fakePng(40_000);
    await session.pasteImage(new Blob([bytes], { type: "image/png" }));
    const [start, ...rest] = clipboardSent();
    const id = start!.split(",")[1]!;
    expect(start).toBe(`cbs,${id},image/png,40000`);
    expect(rest).toEqual([
      `cbd,${id},${b64(bytes.subarray(0, 16_383))}`,
      `cbd,${id},${b64(bytes.subarray(16_383, 32_766))}`,
      `cbd,${id},${b64(bytes.subarray(32_766))}`,
      `cbe,${id}`,
    ]);

    // Too big for the desktop: nothing goes, and the viewer says why.
    socket.sent.length = 0;
    const huge = { size: CLIPBOARD_MAX_BYTES + 1, type: "image/png", arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Blob;
    await session.pasteImage(huge);
    expect(clipboardSent()).toEqual([]);
    expect(String(failed[0])).toMatch(/more than the 64 MiB the desktop takes/);

    // Cmd+V, or Ctrl+V, with an image on this computer's clipboard.
    socket.sent.length = 0;
    const image = new File([fakePng(10)], "copied.png", { type: "image/png" });
    session.element.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [image], getData: () => "" } });
    document.dispatchEvent(paste);
    await waitFor(() => expect(clipboardSent()).toEqual([`cb,image/png,${b64(fakePng(10))}`]));
    session.dispose();
  } finally {
    undo();
  }
});

test("with video, an image the box copies reaches this computer's clipboard, and the menu's Copy and Paste carry images, with their notes (#609)", async () => {
  const undo = withVideo();
  const written: unknown[] = [];
  vi.stubGlobal(
    "ClipboardItem",
    class {
      readonly items: Record<string, Blob | Promise<Blob>>;
      constructor(items: Record<string, Blob | Promise<Blob>>) {
        this.items = items;
      }
      get types() {
        return Object.keys(this.items);
      }
      async getType(type: string) {
        return this.items[type]!;
      }
    },
  );
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: videoFrame(1, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const fromComputer = new Blob([fakePng(30)], { type: "image/png" });
    const write = vi.fn(async (items: { items: Record<string, Blob | Promise<Blob>> }[]) => void written.push(await items[0]!.items["image/png"]));
    Object.defineProperty(navigator, "clipboard", {
      value: { read: async () => [{ types: ["text/plain", "image/png"], getType: async () => fromComputer }], readText: async () => "", writeText: vi.fn(), write },
      configurable: true,
    });

    // The box copies an image: it goes to this computer's clipboard with no note.
    const copied = fakePng(50);
    act(() => void socket.onmessage?.({ data: `clipboard_binary,image/png,${b64(copied)}` }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(new Uint8Array(await (written[0] as Blob).arrayBuffer())).toEqual(copied);
    expect(slot.queryByText("Copied")).toBeNull();

    // The menu's Copy writes it again, and says so.
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Copy to this computer" }));
    expect(await slot.findByText("Copied")).toBeTruthy();
    expect(written).toHaveLength(2);

    // The menu's Paste takes this computer's image before its text, and says so.
    socket.sent.length = 0;
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
    expect(await slot.findByText("Pasted")).toBeTruthy();
    expect(socket.sent).toContain(`cb,image/png,${b64(fakePng(30))}`);
  } finally {
    undo();
  }
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

test("the Desktop tab opened bare opens the thread's one desktop, lists several, and offers the Box panel with none", async () => {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  // One desktop (next to a server): the desktop opens straight away, a shortcut, not a chooser.
  const one = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box(), desktopBox()]).handlers, pluginId: "bb-box" });
  expect(await one.findByText("Connecting to the desktop…")).toBeTruthy();
  cleanup();

  // Two desktops: a chooser with an Open button each.
  const many = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([desktopBox(), desktopBox({ id: "box_9", name: "wild-cove" })]).handlers, pluginId: "bb-box" });
  expect(await many.findByText("bold-heron")).toBeTruthy();
  expect(many.getByText("wild-cove")).toBeTruthy();
  fireEvent.click(many.getAllByRole("button", { name: "Open" })[0]!);
  expect(many.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "bold-heron", params: { box: "box_2" } } }]);
  cleanup();

  // No desktop: a button to the Box panel.
  const none = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box()]).handlers, pluginId: "bb-box" });
  expect(await none.findByText("No desktop box")).toBeTruthy();
  fireEvent.click(none.getByRole("button", { name: "Open the Box panel" }));
  expect(none.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "boxes", title: "Box" } }]);
});

test("the Boxes page lists every box under its thread, servers as well as desktops, and shows one desktop for a browser tab", async () => {
  const { handlers } = server([box(), desktopBox()]);
  const [page] = app.navPanels;
  const list = renderSlot(page!, { subPath: "" }, { rpc: handlers, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
  expect(await list.findByText("bold-heron")).toBeTruthy();
  expect(list.getByText("calm-otter")).toBeTruthy(); // a server box, not only desktops
  expect(list.getByText("Desktop")).toBeTruthy();
  expect(list.getByText("The agent has control")).toBeTruthy();
  // With no machines of yours, the page opens on Threads: one card for the thread, headed by its title, which opens it.
  expect(list.getByRole("tab", { name: "Threads 1" }).getAttribute("aria-selected")).toBe("true");
  await waitFor(() => expect(list.getAllByText("UI thread")).toHaveLength(1));
  const card = list.getByRole("region", { name: "UI thread" });
  expect(within(card).getByText("calm-otter")).toBeTruthy();
  // The title and its boxes are one group: no line under the title, and the first row sits close under it.
  expect(within(card).getByRole("button", { name: "UI thread" }).parentElement!.className).not.toContain("border-b");
  expect(card.querySelector("[data-resource-row]")!.parentElement!.className).toContain("[&>*:first-child]:pt-1");
  fireEvent.click(within(card).getByRole("button", { name: "UI thread" }));
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: THREAD });

  fireEvent.click(list.getByRole("button", { name: "Open desktop" }));
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "thr_panel/box_2" } });
  // The rows sort by name, so bold-heron's terminal comes first.
  fireEvent.click(list.getAllByRole("button", { name: "Open terminal" })[0]!);
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "thr_panel/box_2/terminal" } });
  fireEvent.click(list.getAllByRole("button", { name: "Open thread" })[0]!);
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: THREAD });
  cleanup();

  const one = renderSlot(page!, { subPath: "thr_panel/box_2" }, { rpc: handlers, pluginId: "bb-box" });
  expect(await one.findByText("Connecting to the desktop…")).toBeTruthy();
  fireEvent.click(one.getByRole("button", { name: "Back to boxes" }));
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

test("the Terminal tab opened bare opens the thread's one terminal, lists several, and offers the Box panel with none", async () => {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "terminal");
  // One box with a terminal: its terminal opens straight away, a shortcut, not a chooser.
  const one = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box()]).handlers, pluginId: "bb-box" });
  expect(await one.findByText("Connecting…")).toBeTruthy();
  await waitFor(() => expect(new URL(FakeSocket.made.at(-1)!.url).searchParams.get("box")).toBe("box_1"));
  cleanup();

  // Two boxes with a terminal: a chooser with an Open button each.
  const many = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box(), box({ id: "box_6", name: "swift-fox" })]).handlers, pluginId: "bb-box" });
  expect(await many.findByText("calm-otter")).toBeTruthy();
  expect(many.getByText("swift-fox")).toBeTruthy();
  fireEvent.click(many.getAllByRole("button", { name: "Open" })[0]!);
  expect(many.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "terminal", title: "Terminal: calm-otter", params: { box: "box_1" } } }]);
  cleanup();

  // No box with a terminal: a button to the Box panel.
  const none = renderSlot(action!, { threadId: THREAD, params: null }, { rpc: server([box({ terminal: false })]).handlers, pluginId: "bb-box" });
  expect(await none.findByText("No box with a terminal")).toBeTruthy();
  fireEvent.click(none.getByRole("button", { name: "Open the Box panel" }));
  expect(none.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "boxes", title: "Box" } }]);
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
  expect(slot.getByText("Machines")).toBeTruthy();
  expect(slot.getByText("Working: Fix the login form · 1 more")).toBeTruthy();
  expect(slot.getByText("scratch")).toBeTruthy();
  // Said once for the section, not under each machine.
  // No line inside the list about the new-thread picker (the operator, 4 October 2026).
  expect(slot.queryByText(/pick it in BB's new-thread picker/)).toBeNull();
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
  const name = screen.getByRole("textbox", { name: "Name" });
  expect(name.getAttribute("placeholder")).toBe("Optional: bb-box picks a name like calm-tundra");
  expect(name.getAttribute("aria-describedby")).toBe("new-machine-name-hint");
  expect(screen.getByText("Optional. If left empty, bb-box picks a name.")).toBeTruthy();
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

test("the Boxes page's New box adds one of your machines with settings' Add machine form, and the new machine shows under Machines", async () => {
  const { handlers, changes } = server([box()], { machines: [machine()] });
  // The page lists your machines from allBoxes; here they come from the harness's machines, so a machine added shows up.
  const yours = () => (handlers["machines.list"] as (input: null) => { machines: MachineEntry[] })(null).machines.map((entry) => ({ threadId: "operator", box: entry.box, owner: "yours" as const }));
  const withMine: PluginRpcTestHandlers<Contract> = { ...handlers, allBoxes: () => [...yours(), ...(handlers.allBoxes as () => BoxEntryLike[])()] };
  const [page] = app.navPanels;
  const list = renderSlot(page!, { subPath: "" }, { rpc: withMine, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
  expect(await list.findByText("build-1")).toBeTruthy();
  expect(list.queryByText(/^\d+ box(es)?$/)).toBeNull();
  expect(list.queryByText("BB machine")).toBeNull();
  // New box at the top right, as Automations' New automation: settings' Add machine form, machine mode, with the Name step (the operator, 4 October 2026).
  fireEvent.click(list.getByRole("button", { name: "New box" }));
  expect(await screen.findByText("Of the kinds whose boxes join BB.")).toBeTruthy();
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "build-2" } });
  expect(submitButton().textContent).toBe("Create box");
  fireEvent.click(submitButton());
  await waitFor(() => expect(changes).toEqual(["machines.add linux build-2"]));
  // It shows under Machines, starting; the threads' boxes are on the other tab.
  expect(await list.findByText("build-2")).toBeTruthy();
  expect(list.getAllByText(/build-1|build-2|calm-otter/).map((node) => node.textContent)).toEqual(["build-1", "build-2"]);
  expect(list.getByRole("tab", { name: "Machines 2" }).getAttribute("aria-selected")).toBe("true");
});

/** The Boxes page, with thread titles from the SDK. */
function boxesPage(handlers: PluginRpcTestHandlers<Contract>) {
  const [page] = app.navPanels;
  return renderSlot(page!, { subPath: "" }, { rpc: handlers, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
}

test("the Boxes page manages a thread's boxes with the Box panel's menu: Stop, Start, Release with its question, as that thread", async () => {
  const { handlers, changes } = server([box(), box({ id: "box_6", name: "swift-fox", state: "stopped" })]);
  const list = boxesPage(handlers);
  expect(await list.findByText("calm-otter")).toBeTruthy();
  // The panel's menu, without "New thread on this box…", whose "this thread" names none here; the Open thread arrow heads the thread's card, once.
  let menu = await openMenu(list.getByRole("button", { name: "calm-otter actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open terminal", "Copy address", "Stop", "Check now", "Release…"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(list.getAllByRole("button", { name: "Open thread" })).toHaveLength(1);
  // A stopped box offers Start.
  menu = await openMenu(list.getByRole("button", { name: "swift-fox actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Start" }));
  await waitFor(() => expect(changes).toEqual(["start box_6"]));
  // Release asks first, as the panel does, and acts as the box's thread.
  menu = await openMenu(list.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Release…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Release calm-otter?")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));
  await waitFor(() => expect(changes).toEqual(["start box_6", "release box_1"]));
  expect(list.inspection.rpcCalls.find((call) => call.method === "release")?.input).toEqual({ threadId: THREAD, box: "box_1" });
  await waitFor(() => expect(list.queryByText("calm-otter")).toBeNull());
});

test("on the Boxes page, a box another thread is working on is released only after 'Release anyway?'", async () => {
  const { handlers, changes } = server([box()], { inUse: [{ id: "thr_worker", title: "Build the app", running: true }] });
  const list = boxesPage(handlers);
  await list.findByText("calm-otter");
  const menu = await openMenu(list.getByRole("button", { name: "calm-otter actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Release…" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Release" }));
  const dialog = await screen.findByRole("alertdialog", {}, { timeout: 2000 });
  await within(dialog).findByText("Release calm-otter anyway?");
  expect(within(dialog).getByText("Build the app is working on it, and would lose its machine.")).toBeTruthy();
  expect(changes).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Release anyway" }));
  await waitFor(() => expect(changes).toEqual(["release (forced) box_1"]));
  expect(list.inspection.rpcCalls.filter((call) => call.method === "release").at(-1)?.input).toEqual({ threadId: THREAD, box: "box_1", force: true });
});

test("the Boxes page's Machines have settings' rows and warnings: Stop, Start and Remove, each asking when threads work there", async () => {
  const { handlers, changes } = server([], { machines: [machine(), machine({ id: "box_m2", name: "scratch", desktop: false, display: null, state: "stopped" }, [])] });
  const list = boxesPage(handlers);
  expect(await list.findByText("Machines")).toBeTruthy();
  expect(list.getByText(/Working: Fix the login form/)).toBeTruthy();
  // Every row has the same padding above and below, in Automations' card (px-4 py-1, rows py-3): none loses it as first or last.
  const rows = Array.from(list.container.querySelectorAll("[data-resource-row]"));
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.className).toContain("py-3");
    expect(row.className).not.toMatch(/first:pt-0|last:pb-0/);
  }
  expect(rows[0]!.parentElement!.parentElement!.className).toContain("px-4 py-1");
  // A machine's desktop opens on the page, with the way back to the page, not settings.
  fireEvent.click(list.getAllByRole("button", { name: "Open desktop" })[0]!);
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "operator/box_m1" } });
  // Remove asks with settings' words, then again, since a thread works there.
  let menu = await openMenu(list.getByRole("button", { name: "build-1 actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toContain("Open in browser");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Remove build-1?")).toBeTruthy();
  expect(within(dialog).getByText(/Its machine leaves BB, and its disk and everything on it will be deleted/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  dialog = await screen.findByRole("alertdialog", {}, { timeout: 2000 });
  await within(dialog).findByText("Remove build-1 anyway?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(changes).toEqual([]);
  // Stop asks too; Stop anyway goes on.
  fireEvent.click(list.getAllByRole("button", { name: "Stop" })[0]!);
  dialog = await screen.findByRole("alertdialog");
  await within(dialog).findByText("Stop build-1 anyway?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Stop anyway" }));
  await waitFor(() => expect(changes).toEqual(["machines.stop (forced) box_m1"]));
  // A stopped machine offers Start; one nobody works on is removed after the first question.
  menu = await openMenu(list.getByRole("button", { name: "scratch actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Start" }));
  await waitFor(() => expect(changes).toEqual(["machines.stop (forced) box_m1", "machines.start box_m2"]));
  menu = await openMenu(list.getByRole("button", { name: "scratch actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Remove…" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(changes.at(-1)).toBe("machines.remove box_m2"));
});

test("the Boxes page's tab row has the settings gear, then New box at the far right, a plain button where Automations has New automation; the gear is a link to Settings > BB Box", async () => {
  const [page] = app.navPanels;
  expect(page!.headerContent).toBeUndefined();
  const list = boxesPage(server([box()]).handlers);
  await list.findByText("calm-otter");
  expect(list.getByText("Computers for your threads, and machines of your own.")).toBeTruthy();
  const gear = list.getByRole("link", { name: "BB Box settings" });
  expect(gear.getAttribute("href")).toBe("/settings/plugins/bb-box");
  expect(gear.textContent).toBe("");
  // A pair at the tab row's end: the gear first, then New box, a plain button with no menu, as BB's new-thread screen offers New box.
  const newBox = list.getByRole("button", { name: "New box" });
  const pair = gear.closest("div.flex")!;
  expect(pair.contains(newBox)).toBe(true);
  expect(gear.compareDocumentPosition(newBox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(list.queryByRole("button", { name: "New box options" })).toBeNull();
  const row = pair.parentElement!;
  expect(row.contains(list.getByRole("tablist"))).toBe(true);
  expect(row.className).toContain("justify-between");
  // Before the lists, not under them.
  expect(gear.compareDocumentPosition(list.getByRole("button", { name: "calm-otter: details" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});




test("the Boxes page's search matches a box's name, kind, provider and thread; its filters tick kinds, providers and states; its sort orders by name or age", () => {
  const hour = 3_600_000;
  const rows = [
    { box: box({ id: "box_1", name: "calm-otter", createdAt: 3 * hour }), words: ["Add dark mode"] },
    { box: desktopBox({ id: "box_2", name: "bold-heron", backendLabel: "Proxmox LXC on pve", createdAt: 1 * hour }), words: ["Add dark mode"] },
    { box: box({ id: "box_3", name: "still-pond", state: "stopped", createdAt: 2 * hour }), words: ["Docs pass"] },
    { box: box({ id: "box_4", name: "quiet-fern", state: "acquiring", createdAt: 4 * hour }), words: ["Docs pass"] },
  ];
  const names = (found: readonly { box: BoxView }[]) => found.map((row) => row.box.name);
  const byName = { key: "name", ascending: true } as const;
  // Every word typed must match, in any field, whatever its case.
  expect(names(shown(rows, "", NO_FILTERS, byName))).toEqual(["bold-heron", "calm-otter", "quiet-fern", "still-pond"]);
  expect(names(shown(rows, "docs", NO_FILTERS, byName))).toEqual(["quiet-fern", "still-pond"]);
  expect(names(shown(rows, "PVE desktop", NO_FILTERS, byName))).toEqual(["bold-heron"]);
  expect(names(shown(rows, "dark pond", NO_FILTERS, byName))).toEqual([]);
  // A filter keeps what it ticks; ticks in one filter widen, filters together narrow.
  expect(names(shown(rows, "", { ...NO_FILTERS, states: ["Stopped", "Starting"] }, byName))).toEqual(["quiet-fern", "still-pond"]);
  expect(names(shown(rows, "", { ...NO_FILTERS, kinds: ["Linux"], states: ["Ready"] }, byName))).toEqual(["calm-otter"]);
  expect(names(shown(rows, "", { ...NO_FILTERS, providers: ["Proxmox LXC on pve"] }, byName))).toEqual(["bold-heron"]);
  // The sort: name either way, or age, oldest first when ascending.
  expect(names(shown(rows, "", NO_FILTERS, { key: "name", ascending: false }))).toEqual(["still-pond", "quiet-fern", "calm-otter", "bold-heron"]);
  expect(names(shown(rows, "", NO_FILTERS, { key: "created", ascending: true }))).toEqual(["bold-heron", "still-pond", "calm-otter", "quiet-fern"]);
  // The filters offer what is listed, each once; the states in a fixed order.
  expect(choices(rows.map((row) => row.box))).toEqual({ kinds: ["Linux", "Linux desktop"], providers: ["Fake host", "Proxmox LXC on pve"], states: ["Ready", "Starting", "Stopped"] });
  expect([box({ state: "starting" }), box({ state: "stopping" }), box({ state: "releasing" }), box({ state: "gone" }), box({ state: "failed" })].map(stateGroup)).toEqual(["Starting", "Stopped", "Stopped", "Failed", "Failed"]);
});

test("on the Boxes page, the search narrows the list, says when nothing matches, and the filters and sort act on the rows", async () => {
  const { handlers } = server([box(), desktopBox(), box({ id: "box_6", name: "swift-fox", state: "stopped", createdAt: Date.now() - 60 * 60_000 })]);
  const list = boxesPage(handlers);
  await list.findByText("calm-otter");
  // An open menu hides the page from the accessibility tree, so the rows are read hidden or not.
  const rowNames = () => list.getAllByRole("button", { name: /: details$/, hidden: true }).map((node) => node.getAttribute("aria-label")!.replace(/: details$/, ""));
  // Name, ascending, at first, as on the Automations page.
  expect(rowNames()).toEqual(["bold-heron", "calm-otter", "swift-fox"]);
  expect(list.getByRole("button", { name: "Sort: Name, ascending" })).toBeTruthy();
  const search = list.getByRole("textbox", { name: "Search boxes" });
  fireEvent.change(search, { target: { value: "fox" } });
  expect(rowNames()).toEqual(["swift-fox"]);
  fireEvent.change(search, { target: { value: "nothing like it" } });
  expect(list.getByText("No boxes match.")).toBeTruthy();
  fireEvent.click(list.getByRole("button", { name: "Clear search" }));
  expect(rowNames()).toHaveLength(3);
  // The tab counts stay totals.
  expect(list.getByRole("tab", { name: "Threads 1" })).toBeTruthy();
  // Filters: State, from the states listed; Kind too; Provider has one choice, so no group.
  let menu = await openMenu(list.getByRole("button", { name: "Filters" }));
  expect(within(menu).queryByText("Provider")).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Stopped" }));
  expect(rowNames()).toEqual(["swift-fox"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Stopped" }));
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(rowNames()).toHaveLength(3);
  // Sort: Created, oldest first; the same again reverses it.
  menu = await openMenu(list.getByRole("button", { name: "Sort: Name, ascending" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Created" }));
  expect(rowNames()[0]).toBe("swift-fox");
  menu = await openMenu(list.getByRole("button", { name: "Sort: Created, ascending" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Created" }));
  expect(list.getByRole("button", { name: "Sort: Created, descending" })).toBeTruthy();
  expect(rowNames().at(-1)).toBe("swift-fox");
});

test("a refusal in the Box panel or on the Boxes page is a red line with Dismiss", async () => {
  const failure = "Stopping the box failed: the host did not answer.";
  const slot = panel(server([box()], { failWith: failure }).handlers);
  await slot.findByText("calm-otter");
  fireEvent.click(slot.getByRole("button", { name: "Stop" }));
  expect(await slot.findByRole("alert")).toBeTruthy();
  expect(slot.getByRole("alert").textContent).toBe(failure);
  fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(slot.queryByRole("alert")).toBeNull());

  cleanup();
  const list = boxesPage(server([box()], { failWith: failure }).handlers);
  await list.findByText("calm-otter");
  fireEvent.click(list.getByRole("button", { name: "Stop" }));
  expect((await list.findByRole("alert")).textContent).toBe(failure);
  fireEvent.click(list.getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(list.queryByRole("alert")).toBeNull());
});

test("the Boxes page has a Machines tab and a Threads tab with counts, opens on the tab chosen last, and shows a machine's terminal", async () => {
  const { handlers } = server([desktopBox()], { machines: [machine()] });
  const mine = { threadId: "operator", box: desktopBox({ id: "box_m1", name: "build-1" }), owner: "yours" as const };
  const withMine: PluginRpcTestHandlers<Contract> = { ...handlers, allBoxes: () => [...(handlers.allBoxes as () => BoxEntryLike[])(), mine] };
  const [page] = app.navPanels;
  const render = () => renderSlot(page!, { subPath: "" }, { rpc: withMine, pluginId: "bb-box", sdk: { threads: { get: async () => makeThreadResponse({ title: "UI thread" }) } } });
  // Your machines first, without Open thread.
  let list = render();
  expect(await list.findByText("build-1")).toBeTruthy();
  expect(list.getAllByRole("tab").map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
    ["Machines1", "true"],
    ["Threads1", "false"],
  ]);
  expect(list.getAllByRole("button", { name: "Open desktop" })).toHaveLength(1);
  expect(list.queryByRole("button", { name: "Open thread" })).toBeNull();
  expect(list.queryByText("bold-heron")).toBeNull();
  // The threads' boxes on the other tab.
  fireEvent.click(list.getByRole("tab", { name: "Threads 1" }));
  expect(await list.findByText("bold-heron")).toBeTruthy();
  expect(list.queryByText("build-1")).toBeNull();
  expect(list.getAllByRole("button", { name: "Open thread" })).toHaveLength(1);
  // The page opens again on the tab chosen last, so the way back from a desktop lands there.
  cleanup();
  list = render();
  expect(await list.findByText("bold-heron")).toBeTruthy();
  expect(list.getByRole("tab", { name: "Threads 1" }).getAttribute("aria-selected")).toBe("true");
  cleanup();

  const terminal = renderSlot(page!, { subPath: "operator/box_m1/terminal/from-settings" }, { rpc: withMine, pluginId: "bb-box" });
  // Back to settings is a link to the app's settings page, for the same reason.
  expect((await terminal.findByRole("link", { name: "Back to settings" })).getAttribute("href")).toBe("/settings/plugins/bb-box");
  await waitFor(() => expect(FakeSocket.made.at(-1)?.url).toContain("box=box_m1"));
});

test("the panel lists the box this thread runs on first in the one list with a BB machine badge, no heading and no count, without Release or Stop, and says where they are", async () => {
  const yours = desktopBox({ id: "box_m1", name: "build-1" });
  const { handlers } = server([box()], { runsOn: { box: yours, owner: "yours", threadId: null } });
  const slot = panel(handlers);
  expect(await slot.findByText("build-1")).toBeTruthy();
  // No heading, no card of its own and no count (the operator, 4 October 2026): one list, the machine first, its badge "BB machine" among the others.
  expect(slot.queryByText("This thread runs on it")).toBeNull();
  expect(slot.getByText("BB machine")).toBeTruthy();
  expect(slot.queryByText("Yours")).toBeNull();
  expect(slot.getByText(/Remove or stop it in/)).toBeTruthy();
  expect(slot.getByRole("link", { name: "BB Box's settings" }).getAttribute("href")).toBe("/settings/plugins/bb-box");
  expect(slot.queryByText(/^\d+ box(es)?$/)).toBeNull();
  const rows = slot.getAllByRole("button", { name: /: details$/ }).map((node) => node.getAttribute("aria-label"));
  expect(rows).toEqual(["build-1: details", "calm-otter: details"]);
  expect(slot.getAllByRole("button", { name: "Stop" })).toHaveLength(1);
  const menu = await openMenu(slot.getByRole("button", { name: "build-1 actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open desktop", "Open in browser", "Open terminal", "Copy address", "Check now"]);

  cleanup();
  // Only the machine it runs on, no boxes of its own: the list, not the empty state.
  const only = panel(server([], { runsOn: { box: yours, owner: "yours", threadId: null } }).handlers);
  expect(await only.findByText("build-1")).toBeTruthy();
  expect(only.queryByText("No boxes yet")).toBeNull();

  cleanup();
  const theirs = panel(server([], { runsOn: { box: yours, owner: "thread", threadId: "thr_other" } }).handlers);
  expect(await theirs.findByText(/Held by/)).toBeTruthy();
  expect(await theirs.findByRole("button", { name: "UI thread" })).toBeTruthy();
  expect(theirs.getByText("BB machine")).toBeTruthy();
  expect(theirs.queryByText("No boxes yet")).toBeNull();
});

test("the bare Desktop and Terminal tabs count the box this thread runs on: alone it opens straight away, with others it is listed first (036)", async () => {
  const yours = desktopBox({ id: "box_m1", name: "build-1" });
  const desktopAction = app.threadPanelActions.find((candidate) => candidate.id === "desktop");
  const terminalAction = app.threadPanelActions.find((candidate) => candidate.id === "terminal");
  // Alone: the thread's own boxes have no desktop, so the machine's desktop opens straight away.
  const alone = renderSlot(desktopAction!, { threadId: THREAD, params: null }, { rpc: server([box()], { runsOn: { box: yours, owner: "yours", threadId: null } }).handlers, pluginId: "bb-box" });
  expect(await alone.findByText("Connecting to the desktop…")).toBeTruthy();
  await waitFor(() => expect(new URL(novnc.FakeRfb.made.at(-1)!.url).searchParams.get("box")).toBe("box_m1"));
  cleanup();
  // With a desktop of the thread's own: a chooser, the machine first.
  const many = renderSlot(desktopAction!, { threadId: THREAD, params: null }, { rpc: server([desktopBox()], { runsOn: { box: yours, owner: "yours", threadId: null } }).handlers, pluginId: "bb-box" });
  expect(await many.findByText("build-1")).toBeTruthy();
  expect(many.getByText("bold-heron")).toBeTruthy();
  expect(many.getByText("BB machine")).toBeTruthy();
  expect(many.getAllByRole("button", { name: "Open" })).toHaveLength(2);
  fireEvent.click(many.getAllByRole("button", { name: "Open" })[0]!);
  expect(many.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "build-1", params: { box: "box_m1" } } }]);
  cleanup();
  // The Terminal tab: alone, the machine's terminal opens straight away.
  const terminal = renderSlot(terminalAction!, { threadId: THREAD, params: null }, { rpc: server([box({ terminal: false })], { runsOn: { box: yours, owner: "yours", threadId: null } }).handlers, pluginId: "bb-box" });
  expect(await terminal.findByText("Connecting…")).toBeTruthy();
  await waitFor(() => expect(new URL(FakeSocket.made.at(-1)!.url).searchParams.get("box")).toBe("box_m1"));
  cleanup();
  // With a box of the thread's own: a chooser, the machine first.
  const both = renderSlot(terminalAction!, { threadId: THREAD, params: null }, { rpc: server([box()], { runsOn: { box: yours, owner: "yours", threadId: null } }).handlers, pluginId: "bb-box" });
  expect(await both.findByText("build-1")).toBeTruthy();
  expect(both.getByText("BB machine")).toBeTruthy();
  fireEvent.click(both.getAllByRole("button", { name: "Open" })[0]!);
  expect(both.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "terminal", title: "Terminal: build-1", params: { box: "box_m1" } } }]);
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
    offers: [{ backend: "proxmox-qemu", name: "Proxmox QEMU on pve1", type: "proxmox-qemu", label: "Proxmox QEMU", hosts: ["pve1"], form: "VM", ready: 0, free: null, admin: true, resizable: true, typicalReadyMs: 30000, docker: false, hostOs: "linux", gpuRoom: null }],
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
      { backend: "tart", name: "Tart on mac-mini", type: "tart", label: "Tart", hosts: ["mac-mini"], form: "VM", ready: 0, free: null, admin: true, resizable: false, typicalReadyMs: 26000, docker: true, hostOs: "macos", gpuRoom: null },
      { backend: "docker:host_1", name: "Docker", type: "docker", label: "Docker", hosts: [], form: "Docker", ready: 0, free: null, admin: true, resizable: true, typicalReadyMs: null, docker: true, hostOs: null, gpuRoom: null },
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
    offers: [KINDS[0]!.offers[0]!, { backend: "tart", name: "Tart on mac-mini", type: "tart", label: "Tart", hosts: ["mac-mini"], form: "VM", ready: 0, free: null, admin: true, resizable: false, typicalReadyMs: 26000, docker: true, hostOs: "macos", gpuRoom: null }],
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

test("the Display choice shows only when a system offers X11 and Wayland, defaults to X11, and Wayland drops the GPU (048)", async () => {
  const offer = KINDS[1]!.offers[0]!;
  const x11Cpu: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11", offers: [offer] };
  const waylandCpu: KindView = { ...KINDS[1]!, id: "linux-desktop-wayland-cpu", label: "Linux desktop on Wayland", gpu: false, windowing: "wayland", offers: [offer] };
  const { handlers, changes } = server([], { kinds: [KINDS[0]!, KINDS[1]!, x11Cpu, waylandCpu] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  // A server has no windowing, so the Display choice is hidden.
  const types = await screen.findByRole("radiogroup", { name: "Type" });
  expect(screen.queryByRole("combobox", { name: "Display" })).toBeNull();
  // A desktop offers it, X11 by default, with the GPU still a choice. It is a sub-label of Type, not a section of its
  // own (the operator's notes of 3 October 2026), so it is no heading, and it carries no description.
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  expect((await screen.findByRole("combobox", { name: "Display" })).textContent).toBe("X11");
  expect(screen.queryByRole("heading", { name: "Display" })).toBeNull();
  expect(screen.getByRole("combobox", { name: "GPU" })).toBeTruthy();
  // Wayland: the GPU choice goes (Wayland is CPU-only), still no description, and Create makes the Wayland kind.
  await choose("Display", "Wayland");
  expect(screen.queryByRole("combobox", { name: "GPU" })).toBeNull();
  expect(screen.queryByText(/X11 desktop|XFCE|Sway/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux-desktop-wayland-cpu"]));
});

/** Two projects' images for Linux (049): this project's, and another project's. */
const IMAGES: ImageOptionView[] = [
  { name: "rust-tools", kinds: ["linux"], projects: [{ id: "proj_1", name: "Example" }], mine: true, builds: [{ kind: "linux", backend: "proxmox-lxc", build: "b1", built: "2026-10-02T10:00:00Z" }], spares: [] },
  { name: "go-tools", kinds: ["linux"], projects: [{ id: "proj_2", name: "Another project" }], mine: false, builds: [], spares: [] },
];

test("the Image choice shows under Type where an image covers the kind, this project's first and chosen, and Create sends the choice (049)", async () => {
  const { handlers, changes } = server([], { images: IMAGES });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const types = await screen.findByRole("radiogroup", { name: "Type" });
  // A Linux server: two images cover it. A dim sub-label of Type, no heading, this project's image chosen at first.
  const menu = await screen.findByRole("combobox", { name: "Image" });
  expect(menu.textContent).toBe("rust-tools");
  expect(screen.queryByRole("heading", { name: "Image" })).toBeNull();
  // The options in order: this project's, Standard, the other project's with its name.
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
  expect(options).toEqual(["rust-tools", "Standard", "go-tools · Another project"]);
  fireEvent.click(screen.getAllByRole("option").find((option) => option.textContent === "Standard")!);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Image" }).textContent).toBe("Standard"));
  // A desktop: no image covers it, so no choice and no image sent.
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Image" })).toBeNull());
  // Back to the server: the hand's choice stands. Create sends it.
  fireEvent.click(within(types).getByRole("radio", { name: /^Server/ }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Image" }).textContent).toBe("Standard"));
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes).toEqual(["acquire linux image standard"]));
});

test("ready now follows the box: a spare of the chosen image, at the default size, and none for your machines (#440)", async () => {
  const [linux] = KINDS;
  const offer = linux!.offers[0]!;
  const rows = () => within(screen.getByRole("radiogroup", { name: "Provider" })).getAllByRole("radio").map((option) => option.textContent);
  // This project's image has a spare ready there; the kind has none.
  const images = [{ ...IMAGES[0]!, spares: [{ kind: "linux", backend: offer.backend, ready: 1, making: 0 }] }, IMAGES[1]!];
  const slot = panel(server([], { images }).handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  await screen.findByRole("combobox", { name: "Image" });
  expect(rows()).toEqual(["pveContainer · ready now · usually ~2.2 s"]);
  // Another size claims no spare.
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Medium/ }));
  expect(rows()).toEqual(["pveContainer · usually ~2.2 s"]);
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Small/ }));
  // Standard claims only the kind's spares.
  const menu = screen.getByRole("combobox", { name: "Image" });
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  fireEvent.click((await screen.findAllByRole("option")).find((option) => option.textContent === "Standard")!);
  await waitFor(() => expect(rows()).toEqual(["pveContainer · usually ~2.2 s"]));
  cleanup();
  // A machine claims none, though the kind has one ready.
  const settingsSlot = settings(server([], { kinds: [{ ...linux!, offers: [{ ...offer, ready: 1 }] }] }).handlers);
  await settingsSlot.findByText(/Add a box as a BB machine of your own/);
  fireEvent.click(settingsSlot.getByRole("button", { name: "Add machine" }));
  await screen.findByRole("radiogroup", { name: "Provider" });
  expect(rows()).toEqual(["pveContainer · usually ~2.2 s"]);
});

test("New box's new-thread inputs offer the Image group with the project's image chosen, and nothing chosen without a project (049)", async () => {
  const [inputs] = app.machineProviderInputs;
  const values: unknown[] = [];
  const onChange = (next: { status: string; value?: unknown }) => values.push(next.status === "ready" ? next.value : next.status);
  // In a project: its image is the choice at first, and it goes in the value.
  renderSlot(inputs!, { value: null, onChange }, { rpc: server([], { images: IMAGES }).handlers, pluginId: "bb-box", context: { projectId: "proj_1" } });
  await waitFor(() => expect(values.at(-1)).toEqual({ kind: "linux", size: "small", image: "rust-tools" }));
  const trigger = screen.getByRole("button", { name: "New box options" });
  expect(trigger.textContent).toContain("rust-tools");
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const items = (await screen.findAllByRole("menuitem")).map((item) => item.textContent);
  expect(items.slice(-3)).toEqual(["rust-tools", "Standard", "go-tools · Another project"]);
  fireEvent.click(screen.getAllByRole("menuitem").find((item) => item.textContent === "Standard")!);
  await waitFor(() => expect(values.at(-1)).toEqual({ kind: "linux", size: "small", image: "standard" }));
  cleanup();
  // Outside a project: no image is this project's, nothing is chosen, and no image goes in the value until the person picks one.
  const outside: unknown[] = [];
  const nobody = IMAGES.map((image) => ({ ...image, mine: false }));
  renderSlot(inputs!, { value: null, onChange: (next: { status: string; value?: unknown }) => outside.push(next.status === "ready" ? next.value : next.status) }, { rpc: server([], { images: nobody }).handlers, pluginId: "bb-box", context: { projectId: null } });
  await waitFor(() => expect(outside.at(-1)).toEqual({ kind: "linux", size: "small" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "New box options" }), { key: "ArrowDown" });
  fireEvent.click((await screen.findAllByRole("menuitem")).find((item) => item.textContent === "go-tools · Another project")!);
  await waitFor(() => expect(outside.at(-1)).toEqual({ kind: "linux", size: "small", image: "go-tools" }));
});

test("a second backend of a type shows the name in its ID, unless its label already says it (053)", () => {
  expect(backendName("microsandbox:homestead", "microsandbox on homestead")).toBeNull();
  expect(backendName("docker:attic", "Docker")).toBe("attic");
  expect(backendName("microsandbox", "microsandbox on behemoth")).toBeNull();
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
  // Docker and microsandbox on one host: each says which it is; a host of its own needs no more (053).
  const onBehemoth = { ...offer, backend: "docker", type: "docker", label: "Docker", hosts: ["behemoth"] };
  const msb = { ...offer, backend: "microsandbox", type: "microsandbox", label: "microsandbox", hosts: ["behemoth"] };
  const all = [offer, onBehemoth, msb];
  expect([providerTitle(onBehemoth, all), providerTitle(msb, all), providerTitle(offer, all)]).toEqual(["behemoth (Docker)", "behemoth (microsandbox)", "pve"]);
  const mac: KindView = { ...linux, id: "macos", os: "macos", arch: "arm64", offers: [{ ...offer, backend: "tart", type: "tart", label: "Tart", hosts: ["mac-mini"], hostOs: "macos", gpuRoom: null }] };
  const many: KindView = { ...linux, id: "linux-arm64", arch: "arm64", offers: [offer, { ...offer, backend: "b", hosts: ["pve2"] }, { ...offer, backend: "c", hosts: ["pve3"] }] };
  expect(systemsOf([mac, many, linux]).map((system) => [system.label, system.words])).toEqual([
    ["Linux", "3 providers"],
    ["macOS", "mac-mini"],
  ]);
  // The nearest choice that exists: the system stays when it can, then the arch, the type and the GPU snap to what there is.
  expect(nearest(KINDS, { os: "linux", arch: "arm64", desktop: true, gpu: false, windowing: "x11" })).toEqual({ os: "linux", arch: "x86_64", desktop: true, gpu: true, windowing: "x11" });
  expect(nearest([mac], { os: "windows", arch: "x86_64", desktop: true, gpu: true, windowing: "x11" })).toEqual({ os: "macos", arch: "arm64", desktop: false, gpu: false, windowing: "x11" });
  expect(choiceOf(KINDS[1]!)).toEqual({ os: "linux", arch: "x86_64", desktop: true, gpu: true, windowing: "x11" });
  expect(kindFor(KINDS, { os: "linux", arch: "x86_64", desktop: true, gpu: false, windowing: "x11" })?.id).toBe("linux-desktop");
  // The Display choice (048): a backend offering X11 and Wayland CPU desktops shows both; Wayland is CPU-only, so it snaps the GPU off.
  const waylandCpu: KindView = { ...KINDS[1]!, id: "linux-desktop-wayland-cpu", label: "Linux desktop on Wayland", gpu: false, windowing: "wayland" };
  const x11Cpu: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11" };
  const both = [KINDS[0]!, KINDS[1]!, x11Cpu, waylandCpu];
  expect(displayChoices(both, "linux", "x86_64")).toEqual({ x11: true, wayland: true });
  expect(displayChoices(KINDS, "linux", "x86_64")).toEqual({ x11: true, wayland: false });
  expect(gpuChoices(both, "linux", "x86_64", "x11")).toEqual({ none: true, gpu: true });
  expect(gpuChoices(both, "linux", "x86_64", "wayland")).toEqual({ none: true, gpu: false });
  expect(nearest(both, { os: "linux", arch: "x86_64", desktop: true, gpu: true, windowing: "wayland" })).toEqual({ os: "linux", arch: "x86_64", desktop: true, gpu: false, windowing: "wayland" });
  expect(kindFor(both, { os: "linux", arch: "x86_64", desktop: true, gpu: false, windowing: "wayland" })?.id).toBe("linux-desktop-wayland-cpu");
  expect(kindFor(both, { os: "linux", arch: "x86_64", desktop: true, gpu: true, windowing: "x11" })?.id).toBe("linux-desktop");
  // The filters: a Kind chip keeps its form; Runs on keeps the machine's OS and an offer that does not know it yet; Physical ignores Runs on.
  const pool = { ...offer, backend: "ssh-pool", type: "ssh-pool", form: "Physical" as const };
  const docker = { ...offer, backend: "docker:1", type: "docker", form: "Docker" as const, hostOs: null, gpuRoom: null };
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
