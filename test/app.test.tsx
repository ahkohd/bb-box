// The panel, the desktop viewer and the settings section, rendered with the
// SDK's slot harness against fake RPC handlers and a fake noVNC. Run with
// vitest: npm run test:app.

import { useState, type ComponentType } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, test, vi } from "vitest";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot, type PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { ImageOptionView } from "../src/plugin/views.ts";
import type { ApplyResult, BoxResult, CheckResult, ConfigState, Contract, DesktopState, MachineEntry, PanelState, ResizeResult, ThreadOnBox } from "../src/plugin/contract.ts";
import type { ConfigDocument, Problem } from "../src/core/document.ts";
import type { BackendView, BoxView, DoctorView, KindView, ProviderProfile } from "../src/plugin/views.ts";
import type { GpuRoom } from "../src/backends/types.ts";
import type { DockerHostView } from "../src/plugin/docker-hosts.ts";
import type { MachineAccessProblem, MachineSetup } from "../src/plugin/setup-offer.ts";
import type { ImagesStatus } from "../src/plugin/contract.ts";
import { buildPlace, roughly } from "../src/app/first-run.tsx";
import { boxTitleBadges, fitTitle, forgetLive, isArm64Badge, lacksDocker, Meta } from "../src/app/common.tsx";
import { BoxLine, DESKTOP_OWN_PASTE_WORDS, DEVICE_OWN_PASTE_WORDS, DEVICE_PASTE_FIELD_WORDS, DesktopSession, HIGH_RESOLUTION_WORDS, PASTE_CHORD_DELAY_MS, SETTLE_MS, WINDOWS_HIGH_RESOLUTION_WORDS, forgetInsecurePageNote, forgetStreams, streamChoiceKey } from "../src/app/desktop.tsx";
import { rgbaPng } from "../src/core/png.ts";
import { CLIPBOARD_MAX_BYTES, FIRST_FRAME_MS, FIT_WAIT_MS, HOLD_NO_SIZE_MS, HOLD_SETTLE_MS, RESTART_GAP_MS, SLOW_VIDEO_RETRY_MS, SLOW_VIDEO_STILLS_WORDS, STALL_MS, STILLS_WORDS, SelkiesSession, decodesMacroblocks, devicePasteTooLongWords, forgetFullColour, spsCodec, unicodeKeysym } from "../src/app/selkies.ts";
import { DEVICE_CLIPBOARD_MOST, PASTE_REQUEST_SINCE_VERSION } from "../src/core/device.ts";
import { KeysAfterPaste, MAX_RETRY_MS, OptionComposer, PASTE_HOLD_MS, PASTE_LANDS_MS, boxKey, macBrowser, pasteShortcut, retryWait } from "../src/app/viewer.ts";
import { checkWords, forgetResizesAsked } from "../src/app/resize.tsx";
import { IMAGE_REQUEST } from "../src/app/new-box.tsx";
import { choiceOf, displayChoices, formFilterOf, gpuChoices, gpuFullNote, kindFor, nearest, offersShown, providerTitle, runsOnOptions, systemsOf } from "../src/app/box-form.tsx";
import { backendName } from "../src/app/settings-backends.tsx";
import { limitWords, makesWords, roomWords, runsOnWords, statusWords, usuallyWords } from "../src/app/provider-profile.tsx";
import { providerKeys, providerName } from "../src/core/provider-name.ts";
type BoxEntryLike = { threadId: string; box: BoxView; owner: "thread" | "yours" };
import { dropAllKept, HAND_BACK_MS, HIDDEN_MS } from "../src/app/kept.ts";
import { sparesWords } from "../src/app/settings-kinds.tsx";
import { statusOf, timingWords } from "../src/app/status.ts";
import { choices, NO_FILTERS, shown, splitGroups, stateGroup, tagCounts, tagsOf } from "../src/app/boxes-filter.ts";
import { screensOf, screenTitle, screenWord } from "../src/app/screens.ts";
import { terminalTitle } from "../src/app/terminal.tsx";
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
    /** How often noVNC's keyboard was told to let go of every key it holds. */
    keysLetGo = 0;
    readonly _keyboard = { _allKeysUp: () => void this.keysLetGo++ };
    readonly url: string;
    readonly options: unknown;
    readonly target: HTMLElement;
    /** How many of the next clients fail as noVNC makes them, as a client that cannot start would. */
    static refuse = 0;
    constructor(target: HTMLElement, url: string, options: unknown) {
      super();
      if (FakeRfb.refuse > 0) {
        FakeRfb.refuse--;
        throw new Error("noVNC could not start.");
      }
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
    /** Keys sent with sendKey and the keyboard handler's events together, in the order they went. */
    input: string[] = [];
    sendKey(keysym: number, code: string | null, down?: boolean) {
      this.input.push(`sent ${code}${down === false ? " up" : ""}`);
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
      this.input.push(`typed ${code}${down ? "" : " up"}`);
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
  /** xterm's WebGL addon: loading it fails where `FakeWebgl.missing`, as it does without WebGL 2; `lose` loses its context. */
  class FakeWebgl {
    static missing = false;
    disposed = false;
    lose: (() => void) | null = null;
    onContextLoss(handler: () => void) {
      this.lose = handler;
      return { dispose: () => {} };
    }
    dispose() {
      this.disposed = true;
    }
  }
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
    addons: unknown[] = [];
    loadAddon(addon: unknown) {
      if (addon instanceof FakeWebgl && FakeWebgl.missing) throw new Error("WebGL2 not supported");
      this.addons.push(addon);
    }
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
  return { FakeTerminal, FakeWebgl };
});
vi.mock("@xterm/xterm", () => ({ Terminal: xterm.FakeTerminal }));
vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: xterm.FakeWebgl }));
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

/**
 * BB's toaster, which the host gives plugins as sonner's `toast`: each toast in a polite live region, under its id, so the next with
 * that id takes its place, with its description under it, until its duration has passed or it is dismissed.
 */
vi.mock("sonner", () => {
  const shown = new Map<string | number, { readonly node: HTMLElement; readonly timer: ReturnType<typeof setTimeout> }>();
  const dismiss = (id?: string | number) => {
    for (const [key, entry] of shown) {
      if (id !== undefined && key !== id) continue;
      clearTimeout(entry.timer);
      entry.node.remove();
      shown.delete(key);
    }
  };
  const toast = (message: string, options: { id?: string | number; description?: unknown; duration?: number } = {}) => {
    const id = options.id ?? message;
    (globalThis as { lastToastDescription?: unknown }).lastToastDescription = options.description;
    dismiss(id);
    let region = document.querySelector<HTMLElement>("section[data-toaster]");
    if (!region) {
      region = document.createElement("section");
      region.dataset.toaster = "";
      region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    const node = document.createElement("li");
    node.dataset.toastId = String(id);
    const title = document.createElement("div");
    title.textContent = message;
    node.appendChild(title);
    if (typeof options.description === "string" && options.description) {
      const description = document.createElement("div");
      description.textContent = options.description;
      node.appendChild(description);
    }
    region.appendChild(node);
    shown.set(id, { node, timer: setTimeout(() => dismiss(id), options.duration ?? 4_000) });
    return id;
  };
  return { toast: Object.assign(toast, { dismiss }) };
});

/** The toasts shown now, each as its text. */
function toasts(): string[] {
  return Array.from(document.querySelectorAll("section[data-toaster] li"), (node) => node.textContent ?? "");
}

const THREAD = "thr_panel";
const DESKTOP_PATH = "/api/v1/plugins/bb-box/http/desktop";
const TERMINAL_PATH = "/api/v1/plugins/bb-box/http/terminal";
const app = await loadPluginApp(() => import("../app.tsx"));
afterEach(() => {
  cleanup();
  toast.dismiss();
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
  forgetResizesAsked();
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
    shared: false,
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
    devices: null,
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
function server(initial: BoxView[], options: { rooms?: Record<string, string> | ((size: unknown) => Record<string, string>); profileFailsOnce?: Set<string>; kinds?: KindView[]; failWith?: string; inUse?: ThreadOnBox[]; machines?: MachineEntry[]; runsOn?: PanelState["runsOn"]; imageOffer?: boolean; images?: ImageOptionView[]; config?: Partial<ConfigState>; checkWith?: CheckResult; applyWith?: ApplyResult; savedWith?: Problem[]; dockerHosts?: DockerHostView[]; setups?: MachineSetup[]; access?: MachineAccessProblem; desktopOnDemand?: PanelState["desktopOnDemand"]; desktopProblem?: PanelState["desktopProblem"]; sharp?: boolean | null; rebuildable?: ImagesStatus["images"]; progress?: ImagesStatus["progress"]; refusal?: string; video?: boolean; videoByDefault?: boolean; switching?: { on: boolean }; resize?: (input: ResizeInput) => ResizeResult; deviceClipboard?: string } = {}) {
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
    state: ({ threadId }): PanelState => ({ boxes: threadId === THREAD ? boxes : [], kinds: options.kinds ?? KINDS, backends: BACKENDS, desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, runsOn: options.runsOn ?? null, imageOffer: options.imageOffer ?? false, images: options.images ?? [], desktopOnDemand: options.desktopOnDemand ?? null, desktopProblem: options.desktopProblem ?? null, access: options.access ?? null }),
    desktop: ({ box: ref }): DesktopState => ({ box: find(ref) ?? machines.find((entry) => entry.box.id === ref)?.box ?? (options.runsOn?.box.id === ref ? options.runsOn.box : null), desktopPath: DESKTOP_PATH, terminalPath: TERMINAL_PATH, video: options.video ?? false, videoByDefault: options.videoByDefault ?? options.video ?? false, sharp: options.sharp ?? null, switching: options.switching?.on ?? false }),
    profile: async () => ({ lines: [] }),
    "setup.offer": () => ({ machines: setups, access: options.access ?? null }),
    "images.list": () => ({ images: options.rebuildable ?? [] }),
    "images.progress": () => ({ progress: options.progress ?? null, running: options.progress && options.progress.ended === null ? options.progress.started : null }),
    "images.refresh": () => {
      changes.push("images.refresh");
      return options.refusal ? { started: false, message: options.refusal } : { started: true, message: null };
    },
    "desktop.sharp": ({ on }) => {
      changes.push(`desktop.sharp ${on}`);
      return { error: null };
    },
    "setup.desktop": ({ threadId, hostId, kind, size, name }) => {
      changes.push(`setup.desktop ${hostId}${kind && kind !== "linux-desktop-cpu" ? ` ${kind}` : ""}${size ? ` ${JSON.stringify(size)}` : ""}${threadId === "operator" ? " for operator" : ""}${name ? ` named ${name}` : ""}`);
      return { result: { ok: true, state: {} as ConfigState, problems: [] } };
    },
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
    deviceClipboard: ({ box: ref, viewer }) => {
      changes.push("deviceClipboard");
      const control = find(ref)?.control;
      if (control?.owner !== "human" || control.holder !== viewer) return { text: null, error: "Take control first, then copy: only the tab with control reads the device's clipboard." };
      return { text: options.deviceClipboard ?? "", error: null };
    },
    deviceScreenshot: () => {
      changes.push("deviceScreenshot");
      return { png: "iVBORw0KGgo=", model: "Pixel 8", error: null };
    },
    desktopPaste: ({ box: ref, viewer, text }) => {
      changes.push(`desktopPaste ${ref} ${viewer} ${text}`);
      boxClipboard = { text, serial: boxClipboard?.serial ?? 1 };
      return null;
    },
    images: () => options.images ?? [],
    allBoxes: () => boxes.map((found) => ({ threadId: THREAD, box: found, owner: "thread" as const })),
    // Your machines (036): `options.machines` to start with, kept as the tests add, stop, start and remove them.
    "machines.list": () => ({ machines, kinds: (options.kinds ?? KINDS).filter((kind) => kind.enrol), desktopOnDemand: options.desktopOnDemand ?? null, desktopProblem: options.desktopProblem ?? null, access: options.access ?? null }),
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
    resize: (input) => {
      changes.push(`resize ${input.box} ${JSON.stringify({ ...input, threadId: undefined, box: undefined })}`);
      const resized = options.resize?.(input);
      if (resized?.changed && resized.box) boxes = boxes.map((candidate) => (candidate.id === resized.box!.id ? resized.box! : candidate));
      return resized ?? { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: "No resize in this test." };
    },
    "machines.resize": (input) => {
      changes.push(`machines.resize ${input.box} ${JSON.stringify({ ...input, box: undefined })}`);
      return options.resize ? options.resize(input) : { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null, error: "No resize in this test." };
    },
    "machines.start": ({ box: ref }) => {
      changes.push(`machines.start ${ref}`);
      machines = machines.map((candidate) => (candidate.box.id === ref ? { ...candidate, box: { ...candidate.box, state: "ready" } } : candidate));
      return result(machines.find((candidate) => candidate.box.id === ref)?.box ?? null);
    },
    kinds: () => options.kinds ?? KINDS,
    rooms: ({ kind, size }) => {
      changes.push(`rooms ${kind}${size ? ` ${JSON.stringify(size)}` : ""}`);
      const blocked = typeof options.rooms === "function" ? options.rooms(size) : (options.rooms ?? {});
      return ((options.kinds ?? KINDS).find((candidate) => candidate.id === kind)?.offers ?? []).map((offer) => ({ backend: offer.backend, available: !blocked[offer.backend], reason: blocked[offer.backend] ?? null }));
    },
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
    acquire: ({ kind, size, on, image, dedicated, shared }) => {
      changes.push(`acquire ${kind}${size ? ` ${JSON.stringify(size)}` : ""}${on ? ` on ${on}` : ""}${image ? ` image ${image}` : ""}${dedicated ? " dedicated" : ""}${shared ? " shared" : ""}`);
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
    "monitor.state": () => ({ enabled: false, backgroundMonitoring: false, pressureNotifications: true }),
    "monitor.server": () => {
      throw new Error("The Monitor is off.");
    },
    "monitor.machines": () => ({ machines: [] }),
    "monitor.machine": () => {
      throw new Error("The Monitor is off.");
    },
    "monitor.alerts": () => ({ enabled: false, notifications: true, cursor: 0, active: [], recent: [] }),
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
      general: { boxesPerThread: 0, enrol: true, defaultKind: "linux", video: true, nightlyImages: false, testDevice: false, encoderLedger: true, iosEncoder: "auto" },
      monitor: { enabled: true, refreshIntervalSeconds: 5, backgroundMonitoring: false, pressureNotifications: true },
      kinds: {
        linux: { enabled: true, presets: { small: size(2, 4), medium: size(4, 8), large: size(8, 16) }, default: "small", largest: size(16, 32, 256) },
        "linux-desktop": { enabled: true, presets: { small: size(4, 8), medium: size(8, 16), large: size(16, 32) }, default: "small", largest: size(32, 64, 256) },
      },
    },
    kinds: [
      { id: "linux", label: "Linux", description: "A Linux box.", gpu: false, desktop: false, os: "linux", arch: "x86_64", features: [], device: null, docker: true, drivers: ["fake", "other"], spares: { ready: 0, making: 0 } },
      { id: "linux-desktop", label: "Linux desktop", description: "A desktop on a GPU.", gpu: true, desktop: true, os: "linux", arch: "x86_64", features: [], device: null, docker: true, drivers: ["fake"], spares: { ready: 0, making: 0 } },
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
    display: { protocol: "rfb", resizable: true, clipboard: null, refresh: null, quality: null, macKeys: null },
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

/** The desktop menu's Display submenu, opened from the keyboard as Radix's tests do. */
async function openDisplay(trigger: HTMLElement) {
  const menu = await openMenu(trigger);
  fireEvent.keyDown(within(menu).getByRole("menuitem", { name: "Display" }), { key: "ArrowRight" });
  return waitFor(() => {
    const menus = screen.getAllByRole("menu");
    expect(menus.length).toBeGreaterThan(1);
    return menus.at(-1)!;
  });
}

test("the app registers the Boxes panel, a desktop tab, a device tab with a phone for its icon, the Boxes page and the Backends settings section", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.title])).toEqual([
    ["boxes", "Box"],
    ["desktop", "Desktop"],
    ["device", "Device"],
    ["terminal", "Terminal"],
  ]);
  expect(app.threadPanelActions.find((action) => action.id === "device")!.icon).toBe("bb-box/phone");
  expect(app.navPanels.map((page) => [page.id, page.title, page.path])).toEqual([["boxes", "Boxes", "desktop"]]);
  expect(app.settingsSections.map((section) => section.id)).toEqual(["configuration"]);
  // BB resolves a plugin's icons by the names it declares: the Boxes page's is the cube, and every plugin icon used is declared.
  expect(app.navPanels[0]!.icon).toBe("bb-box/box");
  const declared = Object.keys((packageJson as { bb: { branding: { experimental_icons: Record<string, string> } } }).bb.branding.experimental_icons);
  const used = [...app.navPanels, ...app.threadPanelActions].flatMap((slot) => (typeof slot.icon === "string" && slot.icon.startsWith("bb-box/") ? [slot.icon.slice("bb-box/".length)] : []));
  expect(used.filter((name) => !declared.includes(name))).toEqual([]);
  expect(declared).toContain("box");
});

test("a row keeps its name and kind on one line, the name whole first (F-22b), and its status on one, dropping whole items from the end, with the whole line in a tooltip when it does", async () => {
  const slot = panel(server([desktopBox({ control: { owner: "human", holder: "viewer-9" } })]).handlers);
  await slot.findByText("bold-heron");
  const name = slot.getByText("bold-heron");
  expect(name.className).toContain("truncate");
  const title = name.closest<HTMLElement>("[data-row-title]")!;
  expect(title.className.split(" ")).toEqual(expect.arrayContaining(["flex", "overflow-hidden", "whitespace-nowrap"]));
  expect(title.className).not.toContain("flex-wrap");
  expect(title.querySelector<HTMLElement>("[data-row-badges]")!.textContent).toBe("DesktopGPULXC");
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
  await waitFor(() => expect(slot.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop", params: { box: "box_2" } } }]));

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

test("a device box's row names its device beside its system, then its form as a desktop's row does (F-22), and its details have a Device line, for android and ios", async () => {
  const android = box({ id: "box_a", name: "pixel-box", kind: "android", kindLabel: "Android emulator", form: "VM", desktop: false, display: null, device: { platform: "android", model: "Pixel 8", simulatorHost: false }, control: { owner: "agent", holder: null } });
  const ios = box({ id: "box_i", name: "phone-box", kind: "ios", kindLabel: "iOS Simulator", os: "macos", arch: "arm64", form: "VM", desktop: true, device: { platform: "ios", model: "iPhone 18 Pro", simulatorHost: true }, control: { owner: "agent", holder: null } });
  const plain = box({ id: "box_p", name: "plain-vm", form: "VM" });
  const slot = panel(server([android, ios, plain]).handlers);

  expect(await slot.findByText("pixel-box")).toBeTruthy();
  expect(slot.getByText("Pixel 8")).toBeTruthy();
  expect(slot.getByText("iPhone 18 Pro")).toBeTruthy();
  expect(slot.getAllByText("VM")).toHaveLength(3);

  fireEvent.click(slot.getByRole("button", { name: "pixel-box: details" }));
  expect(slot.getByText("Device")).toBeTruthy();
  expect(slot.getAllByText("Pixel 8")).toHaveLength(2);
  fireEvent.click(slot.getByRole("button", { name: "plain-vm: details" }));
  expect(slot.getByText("Fake host")).toBeTruthy();
  expect(slot.queryByText("Device")).toBeNull();
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
  expect(archs.querySelector("[data-option-words]")!.className.split(" ")).toEqual(expect.arrayContaining(["truncate", "max-sm:line-clamp-2", "max-sm:whitespace-normal"]));
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

test("New box offers a desktop whose image is not built yet: it says it builds first and how long, and Create builds it, then the box follows", async () => {
  const desktop: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11" };
  const { handlers, changes } = server([], { kinds: [KINDS[0]!], desktopOnDemand: { hostId: "host_bb", name: "devpc", kinds: [{ kind: desktop, took: null }] } });
  const slot = panel(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "New box" }));
  const types = await screen.findByRole("radiogroup", { name: "Type" });
  expect(within(types).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-disabled")}`)).toEqual(["ServerTerminal:null", "DesktopBuilds first, usually 4 to 10 min:null"]);
  // A server is made as ever.
  expect(screen.getByRole("button", { name: "Create box" })).toBeTruthy();
  fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
  expect(screen.getByText("BB Box builds the desktop image on devpc first, usually 4 to 10 min, then makes the box.")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Large/ }));
  fireEvent.click(screen.getByRole("button", { name: "Build and create" }));
  await waitFor(() => expect(changes).toEqual(['setup.desktop host_bb {"preset":"large"}']));
  await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
});

test("New box offers the Wayland desktop beside the X11 one where both build first, under Display, and builds the one chosen", async () => {
  const x11: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11" };
  const wayland: KindView = { ...KINDS[1]!, id: "linux-desktop-wayland-cpu", gpu: false, windowing: "wayland" };
  const { handlers, changes } = server([], { kinds: [KINDS[0]!], desktopOnDemand: { hostId: "host_bb", name: "devpc", kinds: [{ kind: x11, took: null }, { kind: wayland, took: 360_000 }] } });
  const slot = panel(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }));
  expect((await screen.findByRole("combobox", { name: "Display" })).textContent).toBe("X11");
  expect(screen.getByText("BB Box builds the desktop image on devpc first, usually 4 to 10 min, then makes the box.")).toBeTruthy();
  await choose("Display", "Wayland");
  expect(screen.getByText("BB Box builds the Wayland desktop image on devpc first, about 6 min, then makes the box.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Build and create" }));
  await waitFor(() => expect(changes).toEqual(["setup.desktop host_bb linux-desktop-wayland-cpu"]));
});

test("a host that has built an image before gives its own last time as the estimate, in the offer, the form and the build's card", async () => {
  const slot = panel(server([], { kinds: [], setups: [setup({ took: { linux: 540_000 } })] }).handlers);
  expect(await slot.findByText("Builds the Linux image first, about 9 min.")).toBeTruthy();
  cleanup();
  const building = setup({ state: "on", took: { desktop: 480_000 }, build: { state: "building", targets: ["desktop"], detail: null, step: { at: 2, of: 5 }, startedAt: Date.now() - 60_000, endedAt: null } });
  const card = panel(server([box()], { setups: [building] }).handlers);
  expect(await card.findByText(/It took 8 min last time here, and goes on if you close this panel\./)).toBeTruthy();
  cleanup();
  const desktop: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11" };
  const form = panel(server([], { kinds: [KINDS[0]!], desktopOnDemand: { hostId: "host_bb", name: "devpc", kinds: [{ kind: desktop, took: 480_000 }] } }).handlers);
  fireEvent.click(await form.findByRole("button", { name: "New box" }));
  expect(within(await screen.findByRole("radiogroup", { name: "Type" })).getByRole("radio", { name: /^Desktop/ }).textContent).toBe("DesktopBuilds first, about 8 min");
});

test("a desktop box not made after its image was built shows in the panel with its reason, as a refused box does", async () => {
  const message = "The desktop image is built, but the box was not made: No room on devpc for 16 cores.";
  const slot = panel(server([box()], { desktopProblem: { message, at: 1 } }).handlers);
  expect(await slot.findByText(message)).toBeTruthy();
});

test("while a desktop's image builds, the panel says so with its step and time; a failed one says why and how to try again", async () => {
  const building = setup({ state: "on", boxFollows: true, build: { state: "building", targets: ["desktop"], detail: "#9 [desktop 3/9] RUN apt-get install", step: { at: 3, of: 9 }, startedAt: Date.now() - 125_000, endedAt: null } });
  const slot = panel(server([box()], { setups: [building] }).handlers);
  expect(await slot.findByText("Building the desktop image on this machine")).toBeTruthy();
  expect(slot.getByText("Step 3 of 9")).toBeTruthy();
  expect(slot.getByText("Started 2 min ago. It usually takes 4 to 10 min, and goes on if you close this panel. The desktop box that was asked for follows.")).toBeTruthy();
  cleanup();
  // Built from bb box docker-build, with no box asked for, and both desktop images in one build.
  const both = setup({ state: "on", build: { state: "building", targets: ["desktop", "desktop-wayland"], detail: null, step: { at: 3, of: 9 }, startedAt: Date.now() - 125_000, endedAt: null } });
  const unasked = panel(server([box()], { setups: [both] }).handlers);
  expect(await unasked.findByText("Started 2 min ago. It usually takes 8 to 16 min, and goes on if you close this panel.")).toBeTruthy();
  cleanup();
  const failed = setup({ state: "on", build: { state: "failed", targets: ["desktop"], detail: "build.sh exited with 1: no space left on device", startedAt: Date.now() - 300_000, endedAt: Date.now() - 5_000 } });
  const after = panel(server([box()], { setups: [failed] }).handlers);
  expect(await after.findByText("The desktop image did not build")).toBeTruthy();
  expect(after.getByText("build.sh exited with 1: no space left on device")).toBeTruthy();
  expect(after.getByText("So the desktop box was not made. To try again, choose Desktop in New box.")).toBeTruthy();
});

test("New box as a sheet on a narrow screen: Tab skips the radio cards that are not chosen, the Android device's among them, as a wide screen's popover does (F-4)", async () => {
  const narrow = (query: string) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  const wide = window.matchMedia;
  window.matchMedia = narrow as unknown as typeof window.matchMedia;
  try {
    const android: KindView = { ...KINDS[0]!, id: "android", label: "Android emulator", devices: { platform: "android", models: ["Pixel 8", "Pixel Fold"] } };
    const { handlers } = server([], { kinds: [...KINDS, android] });
    const slot = panel(handlers);
    await slot.findByText("No boxes yet");
    fireEvent.click(slot.getByRole("button", { name: "New box" }));
    const systems = await screen.findByRole("radiogroup", { name: "System" });
    const cards = within(systems).getAllByRole("radio");
    expect(within(systems).getByRole("radio", { name: /^Android device/ }).tabIndex).toBe(-1);
    const chosen = cards.find((card) => card.getAttribute("aria-checked") === "true")!;
    chosen.focus();
    const reached: HTMLElement[] = [];
    for (let press = 0; press < 40; press++) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
      reached.push(document.activeElement as HTMLElement);
    }
    expect(reached.filter((element) => element.tabIndex < 0)).toEqual([]);
    expect(reached.filter((element) => element.getAttribute("role") === "radio" && element.getAttribute("aria-checked") !== "true")).toEqual([]);
    expect(reached).toContain(screen.getByRole("button", { name: "Create box" }));
  } finally {
    window.matchMedia = wide;
  }
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

type ResizeInput = { box: string; size?: { preset?: string; cores?: number; memoryGiB?: number; diskGiB?: number }; check?: boolean; restart?: boolean; force?: boolean };

/**
 * A backend's resize, as the panel's RPC answers it: `ways` per part, the box's size `now`, a host with room unless `full`,
 * threads working on the box until forced, and a refusal for memory below use when it shrinks below `inUseGiB`.
 */
function fakeResizer(now: { cores: number; memoryGiB: number; diskGiB: number | null }, options: { ways: { cores: "live" | "restart" | "no"; memory: "live" | "restart" | "no"; disk: "live" | "restart" | "no" }; full?: string; threads?: ThreadOnBox[]; inUseGiB?: number; machine?: string }) {
  const presets = [
    { name: "small", ...size(2, 4) },
    { name: "medium", ...size(4, 8) },
    { name: "large", ...size(8, 16) },
  ];
  const largest = size(16, 32, 256);
  const view = (parts: { cores: number; memoryGiB: number; diskGiB: number | null }) => ({ ...parts, words: `${parts.cores} cores, ${parts.memoryGiB} GiB memory${parts.diskGiB === null ? "" : `, ${parts.diskGiB} GiB disk`}` });
  let current = now;
  let resizedWith: { restart: boolean } | null = null;
  const boxNow = () => box({ sizeNow: view(current), resizing: { ...options.ways, shrinks: true }, lastResize: resizedWith ? { to: view(current), at: Date.now(), state: "done", restart: resizedWith.restart, ms: 800, error: null } : null });
  return (input: ResizeInput): ResizeResult => {
    const preset = presets.find((candidate) => candidate.name === input.size?.preset);
    const to = { cores: input.size?.cores ?? preset?.cores ?? current.cores, memoryGiB: input.size?.memoryGiB ?? preset?.memoryGiB ?? current.memoryGiB, diskGiB: input.size?.diskGiB ?? current.diskGiB };
    const base = { box: boxNow(), from: view(current), to: view(to), changed: false, machine: null, needsRestart: false, presets, largest, error: null };
    if (to.diskGiB !== null && current.diskGiB !== null && to.diskGiB < current.diskGiB) return { ...base, to: null, plan: null, error: `A box's disk only grows, and this box's is ${current.diskGiB} GiB, more than the ${to.diskGiB} GiB asked for.` };
    const parts = (["cores", "memory", "disk"] as const)
      .map((part) => {
        const key = part === "memory" ? "memoryGiB" : part === "disk" ? "diskGiB" : "cores";
        return { part, from: current[key], to: to[key]!, way: options.ways[part] };
      })
      .filter((part) => part.from !== part.to);
    if (!parts.length) return { ...base, plan: null };
    const restart = parts.some((part) => part.way === "restart");
    const plan = { parts, room: options.full ? { ok: false, message: options.full } : { ok: true, message: null }, downSeconds: restart ? 8 : null };
    if (input.check) return { ...base, plan };
    if (options.full) return { ...base, plan: null, error: options.full };
    if (options.inUseGiB !== undefined && to.memoryGiB < current.memoryGiB && to.memoryGiB - 0.5 < options.inUseGiB) {
      return { ...base, plan: null, error: `Box calm-otter uses ${options.inUseGiB} GiB of memory now, so ${to.memoryGiB} GiB would leave less than 512 MiB free, and the kernel could end its processes. Give it at least ${Math.ceil(options.inUseGiB + 0.5)} GiB, or free memory in it first. bb-box changed nothing.` };
    }
    if (restart && !input.restart) return { ...base, plan: null, needsRestart: true, error: "Resizing box calm-otter needs a restart." };
    if (restart && options.threads?.length && !input.force) return { ...base, plan: null, threads: options.threads };
    current = to;
    resizedWith = { restart };
    return { ...base, box: boxNow(), plan, changed: true, machine: options.machine ?? null };
  };
}

function checkedRadio(dialog: HTMLElement): string | null {
  return within(dialog).getAllByRole("radio").find((radio) => radio.getAttribute("aria-checked") === "true")?.textContent ?? null;
}

/** Opens a box's Resize dialog from its menu, and waits for its first check. */
async function openResize(slot: ReturnType<typeof panel>, name = "calm-otter") {
  const menu = await openMenu(slot.getByRole("button", { name: `${name} actions` }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Resize…" }));
  const dialog = await screen.findByRole("alertdialog");
  await waitFor(() => expect(within(dialog).getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["Small2 cores · 4 GiB", "Medium4 cores · 8 GiB", "Large8 cores · 16 GiB", "Customup to 16 cores"]));
  return dialog;
}

test("Resize changes a box live at once: the presets, cores, memory and disk within the kind's largest, and each part's way (061)", async () => {
  const resize = fakeResizer({ cores: 2, memoryGiB: 4, diskGiB: 20 }, { ways: { cores: "live", memory: "live", disk: "live" } });
  const { handlers, changes } = server([box({ sizeNow: size(2, 4, 20), resizing: { cores: "live", memory: "live", disk: "live", shrinks: true } })], { resize });
  const slot = panel(handlers);
  await slot.findByText("calm-otter");
  const dialog = await openResize(slot);
  expect(within(dialog).getByText("Resize calm-otter")).toBeTruthy();
  expect(within(dialog).getByText("Now 2 cores · 4 GiB · 20 GiB disk.")).toBeTruthy();
  expect(within(dialog).getByText("Cores, memory and disk live. The disk only grows.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Resize" }).hasAttribute("disabled")).toBe(true);
  // A box exactly a preset opens on it, and says so no more than Custom would.
  await waitFor(() => expect(checkedRadio(dialog)).toBe("Small2 cores · 4 GiB"));
  expect(within(dialog).getByText("Cores, memory and disk live. The disk only grows.")).toBeTruthy();
  expect(within(dialog).queryByText("Nothing: the box has this size.")).toBeNull();
  fireEvent.click(within(dialog).getByRole("radio", { name: /Custom/ }));
  expect(within(dialog).getByText("20 to 256")).toBeTruthy();

  fireEvent.change(within(dialog).getByRole("textbox", { name: "Cores" }), { target: { value: "6" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Disk, GiB" }), { target: { value: "40" } });
  const list = await within(dialog).findByRole("list", { name: "What changes" });
  await waitFor(() => expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Cores2 → 6Live", "Disk20 GiB → 40 GiBLive"]));
  expect(within(dialog).getByText("Changes at once. Everything running in calm-otter carries on.")).toBeTruthy();
  expect(within(dialog).getByText("Its host has room for it to grow.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize" }));
  expect(await within(dialog).findByText("Resized calm-otter")).toBeTruthy();
  expect(within(dialog).getByText("It has 6 cores · 4 GiB · 40 GiB disk now, changed live.")).toBeTruthy();
  expect(changes.filter((change) => !change.includes('"check":true'))).toEqual(['resize box_1 {"size":{"cores":6,"diskGiB":40}}']);
  fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  // The dialog said how it went, so its row does not say it again, though the panel refetches the box with it.
  const calls = stateCalls(slot);
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  await waitFor(() => expect(stateCalls(slot)).toBe(calls + 1));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(slot.queryByText(/^Resized to/)).toBeNull();
});

test("a starting box's row says what its acquire waits on, with how long it takes, and a ready box's row does not (#1117)", async () => {
  const words = "Building Namespace's Linux desktop image first, which takes about 7 minutes. Later boxes of this kind use it and start in under a minute.";
  const slot = panel(server([box({ state: "starting", waitingOn: words }), box({ id: "box_2", name: "quiet-heron", waitingOn: null })]).handlers);
  expect(await slot.findByText(words)).toBeTruthy();
  expect(slot.getAllByText(/^Building Namespace's/)).toHaveLength(1);
});

test("a row says how a resize that ended in the last two minutes went, for a panel that reloaded while its dialog waited (061)", async () => {
  const ended = (minutesAgo: number, state: "done" | "failed", error: string | null = null) => ({ to: size(4, 8, 64), at: Date.now() - minutesAgo * 60_000 - 15_000, state, restart: true, ms: 15_000, error });
  const ways = { cores: "restart", memory: "restart", disk: "restart", shrinks: false } as const;
  const boxes = [
    box({ sizeNow: size(4, 8, 64), resizing: ways, lastResize: ended(0.5, "done") }),
    box({ id: "box_2", name: "quiet-heron", sizeNow: size(2, 4, 64), resizing: ways, lastResize: ended(1, "failed", "The Mac has 2 GiB of memory left. bb-box changed nothing.") }),
    box({ id: "box_3", name: "old-wren", sizeNow: size(4, 8, 64), resizing: ways, lastResize: ended(5, "done") }),
    box({ id: "box_4", name: "busy-finch", sizeNow: size(2, 4, 64), resizing: ways, lastResize: { ...ended(0, "done"), state: "resizing", ms: null } }),
  ];
  const first = server(boxes);
  let slot = panel(first.handlers);
  expect(await slot.findByText("Resized to 4 cores · 8 GiB · 64 GiB disk after a restart, in 15 s.")).toBeTruthy();
  expect(slot.getByText("Not resized to 4 cores · 8 GiB · 64 GiB disk: The Mac has 2 GiB of memory left.").className).toContain("text-destructive-text");
  expect(slot.getAllByText(/^(Not r|R)esized to/)).toHaveLength(2);
  slot.unmount();

  // BB's panel can mount a row again: it says it again, within the two minutes (a row said it, was mounted again, and kept quiet).
  slot = panel(server(boxes).handlers);
  expect(await slot.findByText("Resized to 4 cores · 8 GiB · 64 GiB disk after a restart, in 15 s.")).toBeTruthy();
  expect(slot.getAllByText(/^(Not r|R)esized to/)).toHaveLength(2);
});

test("Resize asks before a restart, in the record's words, then names the threads working on the box before it goes ahead anyway (061)", async () => {
  const resize = fakeResizer({ cores: 2, memoryGiB: 4, diskGiB: 20 }, { ways: { cores: "restart", memory: "restart", disk: "live" }, threads: [{ id: "thr_worker", title: "Build the app", running: true }] });
  const { handlers, changes } = server([box({ sizeNow: size(2, 4, 20), resizing: { cores: "restart", memory: "restart", disk: "live", shrinks: true } })], { resize });
  const slot = panel(handlers);
  await slot.findByText("calm-otter");
  const dialog = await openResize(slot);
  expect(within(dialog).getByText("Disk live; cores and memory with a restart. The disk only grows.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("radio", { name: /Large/ }));
  await waitFor(() => expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Cores2 → 8Restart", "Memory4 GiB → 16 GiBRestart"]));
  expect(within(dialog).getByText("Needs a restart: everything running in calm-otter stops, for about 8 s.")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize…" }));
  expect(within(dialog).getByText("Restart calm-otter to resize it?")).toBeTruthy();
  expect(within(dialog).getByText("Everything running in it stops, and it is back in about 8 s.")).toBeTruthy();
  expect(changes.filter((change) => !change.includes('"check":true'))).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Restart and resize" }));
  expect(await within(dialog).findByText("Restart calm-otter anyway?")).toBeTruthy();
  expect(within(dialog).getByText("A thread is working on it, and its work stops while it restarts.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /Build the app/ })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Restart anyway" }));
  expect(await within(dialog).findByText("It has 8 cores · 16 GiB · 20 GiB disk now, after a restart.")).toBeTruthy();
  expect(changes.filter((change) => !change.includes('"check":true'))).toEqual(['resize box_1 {"size":{"preset":"large"},"restart":true}', 'resize box_1 {"size":{"preset":"large"},"restart":true,"force":true}']);
});

test("Resize shows refusals plainly: no room, memory below use, and a disk that would shrink (061)", async () => {
  const full = fakeResizer({ cores: 2, memoryGiB: 8, diskGiB: 20 }, { ways: { cores: "live", memory: "live", disk: "live" }, full: "pve has 2 GiB of memory left, and calm-otter would grow by 8 GiB. Release a box you no longer need." });
  const first = server([box({ sizeNow: size(2, 8, 20), resizing: { cores: "live", memory: "live", disk: "live", shrinks: true } })], { resize: full });
  let slot = panel(first.handlers);
  await slot.findByText("calm-otter");
  let dialog = await openResize(slot);
  expect(checkedRadio(dialog), "a box that is no preset opens on Custom").toBe("Customup to 16 cores");
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Memory, GiB" }), { target: { value: "16" } });
  expect((await within(dialog).findByRole("alert")).textContent).toBe("pve has 2 GiB of memory left, and calm-otter would grow by 8 GiB. Release a box you no longer need.");
  expect(within(dialog).getByRole("button", { name: "Resize" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Disk, GiB" }), { target: { value: "10" } });
  await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toBe("A box's disk only grows, and this box's is 20 GiB, more than the 10 GiB asked for."));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  slot.unmount();

  const using = fakeResizer({ cores: 2, memoryGiB: 8, diskGiB: 20 }, { ways: { cores: "live", memory: "live", disk: "live" }, inUseGiB: 3.6 });
  const second = server([box({ sizeNow: size(2, 8, 20), resizing: { cores: "live", memory: "live", disk: "live", shrinks: true } })], { resize: using });
  slot = panel(second.handlers);
  await slot.findByText("calm-otter");
  dialog = await openResize(slot);
  fireEvent.click(within(dialog).getByRole("radio", { name: /Small/ }));
  await within(dialog).findByRole("list", { name: "What changes" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize" }));
  // The answer to Resize, headed as one: the plan's "changes at once" goes, as nothing changed.
  expect((await within(dialog).findByRole("alert")).textContent).toBe(
    "Not resizedBox calm-otter uses 3.6 GiB of memory now, so 4 GiB would leave less than 512 MiB free, and the kernel could end its processes. Give it at least 5 GiB, or free memory in it first. bb-box changed nothing.",
  );
  expect(within(dialog).queryByText("Changes at once. Everything running in calm-otter carries on.")).toBeNull();
  expect(within(dialog).getByText("Resize calm-otter")).toBeTruthy();
  // The same size again would be refused again: Resize waits for another.
  expect(within(dialog).getByRole("button", { name: "Resize" }).hasAttribute("disabled")).toBe(true);
});

test("a refusal while the person chooses never says bb-box changed nothing: nothing was tried (061)", () => {
  expect(checkWords("Resizing box calm-otter needs a restart for its memory. bb-box changed nothing.")).toBe("Resizing box calm-otter needs a restart for its memory.");
  expect(checkWords("A box's disk only grows, and this box's is 20 GiB, more than the 10 GiB asked for.")).toBe("A box's disk only grows, and this box's is 20 GiB, more than the 10 GiB asked for.");
});

test("Resize is offered only where the box's backend changes a part, for a ready or stopped box (061)", async () => {
  const { handlers } = server([
    box({ id: "box_1", name: "calm-otter", resizing: { cores: "live", memory: "live", disk: "no", shrinks: true } }),
    box({ id: "box_2", name: "bold-heron", resizing: { cores: "no", memory: "no", disk: "no", shrinks: false } }),
    box({ id: "box_3", name: "busy-wren", state: "starting", resizing: { cores: "live", memory: "live", disk: "live", shrinks: true } }),
  ]);
  const slot = panel(handlers);
  await slot.findByText("calm-otter");
  for (const [name, offered] of [["calm-otter", true], ["bold-heron", false], ["busy-wren", false]] as const) {
    const menu = await openMenu(slot.getByRole("button", { name: `${name} actions` }));
    expect(within(menu).queryByRole("menuitem", { name: "Resize…" }) !== null).toBe(offered);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  }
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
  expect(within(dialog).getByText("A thread is working on it, and would lose its machine.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /Build the app/ })).toBeTruthy();
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
  return { hostId: "host_bb", name: "bb", here: true, state: "ready", docker: "29.8.1", problem: null, fix: null, restart: null, kvm: "ok", freeGb: 120, build: null, took: {}, ...overrides };
}

test("first run: the panel offers Docker on the machine that runs BB, and one click turns it on and shows the Linux image's build", async () => {
  const { handlers, changes } = server([], { kinds: [], setups: [setup({ hostId: "host_far", name: "far", here: false }), setup()] });
  const slot = panel(handlers);
  expect(await slot.findByText("This machine has Docker 29.8.1. BB Box can make Linux boxes there.")).toBeTruthy();
  expect(slot.getByText("Builds the Linux image first, usually 5 to 12 min.")).toBeTruthy();
  expect(slot.getByRole("link", { name: "Other backends" }).getAttribute("href")).toBe("/settings/plugins/bb-box");
  fireEvent.click(slot.getByRole("button", { name: "Use Docker on this machine" }));
  await waitFor(() => expect(changes).toEqual(["setup.docker host_bb"]));
  expect(await slot.findByText("Setting up Docker on this machine")).toBeTruthy();
  // The step is the one the build kept, not its last line; the time is what it usually takes, as it varies with the host.
  expect(slot.getByText("Building the Linux image · Step 7 of 12")).toBeTruthy();
  expect(slot.getByText("Started 1 min ago. It usually takes 5 to 12 min, and goes on if you close this panel.")).toBeTruthy();
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

test("New box says before making a box that it will not join BB, in the offer's words with both ways out and the guide, and still makes it", async () => {
  const access = { provider: "bb connect", message: "Sign in to your bb account to use bb connect" };
  const { handlers, changes } = server([], { access });
  const slot = panel(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "New box" }));
  const note = await screen.findByRole("note");
  expect(note.textContent).toBe(
    "Boxes will not join BB yet. BB's machine access, bb connect, needs you signed in to your bb account. Sign in to it in BB, or set Machine access to Manual in BB's settings, under Machines, with an address boxes can reach, and have BB listen there: started with npx bb-app, add --server-bind-host 0.0.0.0. How boxes join BB",
  );
  expect(within(note).getByRole("link", { name: "How boxes join BB" }).getAttribute("href")).toMatch(/docs\/guide\/boxes\.md#when-a-box-does-not-join-bb$/);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.some((change) => change.startsWith("acquire"))).toBe(true));
  cleanup();
  const fine = panel(server([]).handlers);
  fireEvent.click(await fine.findByRole("button", { name: "New box" }));
  await screen.findByRole("button", { name: "Create box" });
  expect(screen.queryByText(/Boxes will not join BB yet/)).toBeNull();
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

test("a build's time reads in whole seconds under a minute and minutes after, and its place reads as its image and that image's step, with a bar that only grows", () => {
  expect([roughly(800), roughly(45_400), roughly(75_000), roughly(4 * 60_000)]).toEqual(["1 s", "45 s", "1 min", "4 min"]);
  expect(buildPlace({})).toEqual({ words: null, share: 0.03 });
  expect(buildPlace({ step: { at: 7, of: 12 } })).toEqual({ words: "Step 7 of 12", share: 0.5 });
  const places = [
    { image: { at: 1, of: 2 }, step: { at: 2, of: 4 } },
    { image: { at: 1, of: 2 }, step: { at: 4, of: 4 } },
    { image: { at: 2, of: 2 }, step: { at: 1, of: 9 } },
    { image: { at: 2, of: 2 }, step: { at: 5, of: 9 } },
  ].map(buildPlace);
  expect(places.map((place) => place.words)).toEqual(["Image 1 of 2: step 2 of 4", "Image 1 of 2: step 4 of 4", "Image 2 of 2: step 1 of 9", "Image 2 of 2: step 5 of 9"]);
  expect(places.map((place) => place.share)).toEqual([...places.map((place) => place.share)].sort((a, b) => a - b));
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
  // The nightly rebuilds are off unless set; on saves true, and off again leaves the value out.
  const nightly = slot.getByRole("switch", { name: "Rebuild images each night" });
  expect(nightly.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(nightly);
  await waitFor(() => expect(changes).toHaveLength(3));
  expect(JSON.parse(changes[2]!.slice(changes[2]!.indexOf("{"))).general).toEqual({ boxesPerThread: 3, enrol: false, nightlyImages: true });
});

test("Rebuild now lists the due images and why, starts the night's refresh, and says why when one is going already", async () => {
  const images: ImagesStatus["images"] = [
    { name: "docker/linux", kind: "linux", built: "build.2026-10-01, 10 days old", due: "it is 10 days old, past its 7-day interval", last: null },
    { name: "docker/desktop", kind: "linux-desktop-cpu", built: "build.2026-10-10, 1 day old", due: null, last: "Last rebuilt 2026-10-10" },
  ];
  const { handlers, changes } = server([], { rebuildable: images, refusal: "A rebuild has gone on since 02:00 UTC, one image at a time. Start another once it ends." });
  const slot = settings(handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Rebuild now" }));
  expect(await slot.findByText("1 of 2 images are due. A rebuild takes them one at a time, as the night does.")).toBeTruthy();
  expect(slot.getByText("Due, as it is 10 days old, past its 7-day interval")).toBeTruthy();
  expect(slot.queryByText("docker/desktop")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Rebuild 1 image" }));
  await waitFor(() => expect(changes).toContain("images.refresh"));
  expect(await slot.findByText("A rebuild has gone on since 02:00 UTC, one image at a time. Start another once it ends.")).toBeTruthy();
});

test("while a rebuild runs, Rebuild now shows it image by image, with the step of the one being rebuilt", async () => {
  const progress: ImagesStatus["progress"] = {
    started: Date.now() - 125_000,
    ended: null,
    only: null,
    images: [
      { name: "docker/linux", kind: "linux", state: "refreshed", detail: "now build.2026-10-11, in 300 s" },
      { name: "docker/desktop", kind: "linux-desktop-cpu", state: "refreshing", detail: "it is 40 days old", since: Date.now() - 20_000, line: "#9 [desktop 3/9] RUN", step: { at: 3, of: 9 } },
      { name: "pve/9100", kind: "linux", state: "next", detail: "it fails the doctor" },
    ],
  };
  const slot = settings(server([], { progress }).handlers);
  fireEvent.click(await slot.findByRole("button", { name: "Rebuild now" }));
  expect(await slot.findByText("Rebuilding images")).toBeTruthy();
  expect(slot.getByText("2 of 3 · docker/desktop")).toBeTruthy();
  expect(slot.getByText("Started 2 min ago. One image at a time; it goes on if you leave this page.")).toBeTruthy();
  expect(slot.getByText("Rebuilt, now build.2026-10-11, in 300 s")).toBeTruthy();
  expect(slot.getByText("Rebuilding · step 3 of 9")).toBeTruthy();
  expect(slot.getByText("Next")).toBeTruthy();
  expect(slot.getByRole("progressbar", { name: "Rebuilding images" })).toBeTruthy();
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

function deviceTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_2") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "device");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a desktop that cannot be resized says you have control, and noVNC does not resize it", async () => {
  const { handlers } = server([desktopBox({ kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: false, clipboard: null, refresh: null, quality: null, macKeys: null } })]);
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
  const wayland = desktopBox({ kind: "linux-desktop-wayland-cpu", gpu: false, display: { protocol: "rfb", resizable: true, clipboard: null, refresh: "viewer", quality: null, macKeys: null } });
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
  const windows = desktopBox({ kind: "windows-arm64-desktop", os: "windows", gpu: false, display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: "viewer", quality: 4, macKeys: null } });
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

test("taking control keeps the desktop's size; once the tab's size changes and holds, a desktop in your control asks for it once; while it moves, noVNC may not ask", async () => {
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
  expect(await slot.findByText("You have control.")).toBeTruthy();
  // Taking control leaves the desktop's size as it is, so the picture stays as it was (the owner's note of 16 October 2026).
  expect(client!.resizeSession).toBe(false);
  const taken = client!.resizeChecks;
  vi.useFakeTimers();
  // The size as it was, observed again (a mount's first observation), is no move: nothing is asked.
  act(() => observer.resize(1037, 746));
  act(() => void vi.advanceTimersByTime(SETTLE_MS));
  expect([client!.resizeChecks, client!.resizeSession]).toEqual([taken, false]);
  const held = client!.resizeChecks;
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

test("a character above U+FFFF, as an emoji from the keyboard or the emoji picker, goes to the box as its Unicode keysym, down and up, while dead keys and composition stay noVNC's", async () => {
  for (const os of ["linux", "macos", "windows"] as const) {
    novnc.FakeRfb.made.length = 0;
    const { handlers } = server([desktopBox({ id: `box_${os}`, name: `${os}-1`, os })]);
    const slot = desktopTab(handlers, `box_${os}`);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    const without = keyOnCanvas(slot, { key: "😀", code: "" });
    expect(without.reached).not.toHaveBeenCalled();
    expect(client.keyEvents).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const emoji = keyOnCanvas(slot, { key: "😀", code: "" });
    expect(emoji.reached).not.toHaveBeenCalled();
    expect(emoji.event.defaultPrevented).toBe(true);
    keyOnCanvas(slot, { key: "🇲", code: "" });
    expect(client.keyEvents).toEqual([
      { keysym: 0x101f600, code: "Unidentified", down: true },
      { keysym: 0x101f600, code: "Unidentified", down: false },
      { keysym: 0x101f1f2, code: "Unidentified", down: true },
      { keysym: 0x101f1f2, code: "Unidentified", down: false },
    ]);
    expect(keyOnCanvas(slot, { key: "Dead", code: "BracketLeft" }).reached).toHaveBeenCalledTimes(1);
    expect(keyOnCanvas(slot, { key: "😀", code: "", isComposing: true }).reached).toHaveBeenCalledTimes(1);
    expect(keyOnCanvas(slot, { key: "é", code: "KeyE" }).reached).toHaveBeenCalledTimes(1);
    expect(client.keyEvents).toHaveLength(4);
    cleanup();
  }
});

test("Type text opens a field over the desktop for input methods and emoji: Enter types its text into the box and keeps it open, Shift+Enter a new line, Esc closes, and long text goes as a paste", async () => {
  const { handlers } = server([desktopBox({ id: "box_t", name: "type-1", os: "linux" })]);
  const slot = desktopTab(handlers, "box_t");
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(await slot.findByRole("button", { name: "Type text: take control first" }));
  expect(slot.queryByRole("textbox", { name: "Text to type" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  const letGo = client.keysLetGo;
  fireEvent.click(slot.getByRole("button", { name: "Type text (Ctrl+Alt+Space)" }));
  const field = await slot.findByRole("textbox", { name: "Text to type" });
  expect(slot.getByRole("group", { name: "Type text into type-1" })).toBeTruthy();
  expect(document.activeElement).toBe(field);
  expect(client.keysLetGo).toBe(letGo + 1);
  const focusedWhileOpen = client.focused;
  fireEvent.change(field, { target: { value: "aé😀\nb" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  expect(client.keyEvents).toEqual([]);
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", shiftKey: true });
  expect(client.keyEvents).toEqual([]);
  fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  const keysyms = client.keyEvents.map((key) => `${key.keysym.toString(16)}${key.down ? "" : " up"}`);
  expect(keysyms).toEqual(["61", "61 up", "e9", "e9 up", "101f600", "101f600 up", "ff0d", "ff0d up", "62", "62 up"]);
  expect((field as HTMLTextAreaElement).value).toBe("");
  expect(slot.getByRole("textbox", { name: "Text to type" })).toBe(field);

  client.keyEvents.length = 0;
  fireEvent.change(field, { target: { value: "AbC" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
  expect(client.keyEvents.map((key) => `${key.keysym.toString(16)}${key.down ? "" : " up"}`)).toEqual(["ffe1", "41", "41 up", "ffe1 up", "62", "62 up", "ffe1", "43", "43 up", "ffe1 up"]);

  client.keyEvents.length = 0;
  fireEvent.change(field, { target: { value: "日本" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: true, keyCode: 229 });
  fireEvent.compositionEnd(field);
  expect(client.keyEvents).toEqual([]);
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", keyCode: 229 });
  expect(client.keyEvents.map((key) => key.keysym.toString(16))).toEqual(["10065e5", "10065e5", "100672c", "100672c"]);

  client.keyEvents.length = 0;
  fireEvent.change(field, { target: { value: "日本" } });
  fireEvent.compositionEnd(field);
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", keyCode: 229 });
  expect(client.keyEvents).toEqual([]);
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", keyCode: 229 });
  expect(client.keyEvents).toHaveLength(4);
  const sent = client.keyEvents.length;

  const long = "x".repeat(250);
  fireEvent.change(field, { target: { value: long } });
  expect(slot.getByText("Long text goes as a paste.")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Send" }));
  expect(client.pasted).toEqual([long]);
  expect(client.keyEvents).toHaveLength(sent);
  expect(client.focused).toBe(focusedWhileOpen);

  fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
  expect(slot.queryByRole("textbox", { name: "Text to type" })).toBeNull();
  expect(client.keysLetGo).toBe(letGo + 2);
  expect(client.focused).toBeGreaterThan(focusedWhileOpen);

  const shortcut = keyOnCanvas(slot, { key: " ", code: "Space", ctrlKey: true, altKey: true });
  expect(shortcut.reached).not.toHaveBeenCalled();
  expect(await slot.findByRole("textbox", { name: "Text to type" })).toBeTruthy();
  expect(client.keysLetGo).toBe(letGo + 3);
  expect(client.keyEvents).toHaveLength(sent);
  fireEvent.click(slot.getByRole("button", { name: "Close" }));
  expect(client.keysLetGo).toBe(letGo + 4);
  expect(keyOnCanvas(slot, { key: " ", code: "Space", ctrlKey: true }).reached).toHaveBeenCalledTimes(1);
  expect(keyOnCanvas(slot, { key: "Dead", code: "BracketLeft" }).reached).toHaveBeenCalledTimes(1);

  fireEvent.click(slot.getByRole("button", { name: "Hand back to the agent" }));
  await slot.findByRole("button", { name: "Type text: take control first" });
});

test("on a Mac, Ctrl+Cmd+Space with the desktop focused opens Type text rather than going to the box, and the field says to press it again for emoji", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  try {
    const { handlers } = server([desktopBox({ id: "box_m", name: "mac-type", os: "macos", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } })]);
    const slot = desktopTab(handlers, "box_m");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    expect(keyOnCanvas(slot, { key: " ", code: "Space", ctrlKey: true, altKey: true }).reached).toHaveBeenCalledTimes(1);
    expect(slot.queryByRole("textbox", { name: "Text to type" })).toBeNull();
    const shortcut = keyOnCanvas(slot, { key: " ", code: "Space", ctrlKey: true, metaKey: true });
    expect(shortcut.reached).not.toHaveBeenCalled();
    const field = await slot.findByRole("textbox", { name: "Text to type" });
    expect(field.getAttribute("placeholder")).toBe("Type or paste text. Press Ctrl+Cmd+Space again for emoji.");
    expect(slot.getByRole("button", { name: "Type text (Ctrl+Cmd+Space)" })).toBeTruthy();
  } finally {
    platform.mockRestore();
  }
});

type FakeClient = { input: string[]; pasted: string[]; keysLetGo: number; focused: number; keys: { keysym: number; code: string | null; down: boolean }[]; keyEvents: { keysym: number; code: string; down: boolean }[]; _handleKeyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void } & EventTarget;

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
    // Cmd is Ctrl in the box, code and all, so QEMU's scancode follows too. In a Mac's browser noVNC sends the left
    // Cmd as Alt_L and the right one as Super_L, as Safari on macOS showed.
    client._handleKeyEvent(0xffe9, "MetaLeft", true, null, null);
    client._handleKeyEvent(0x63, "KeyC", true, null, null);
    client._handleKeyEvent(0xffeb, "MetaRight", true, null, null);
    // The left Option (Mode_switch) composes: held back, then only the character it made; the right one is Alt.
    client._handleKeyEvent(0xffe9, "MetaLeft", false, null, null);
    client._handleKeyEvent(0xffeb, "MetaRight", false, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", true, null, null);
    client._handleKeyEvent(0xe7, "KeyC", true, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", false, null, null);
    client._handleKeyEvent(0xfe03, "AltRight", true, null, null);
    expect(client.keyEvents).toEqual([
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 0x63, code: "KeyC", down: true },
      { keysym: 0xffe4, code: "ControlRight", down: true },
      { keysym: 0xffe3, code: "ControlLeft", down: false },
      { keysym: 0xffe4, code: "ControlRight", down: false },
      { keysym: 0xe7, code: "KeyC", down: true },
      { keysym: 0xffea, code: "AltRight", down: true },
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
    // The right Option, still held, goes up for the chord and down again after, so the box gets Ctrl+V alone.
    expect(client.keys).toEqual([
      { keysym: 0xffea, code: "AltRight", down: false },
      { keysym: 0xffe3, code: "ControlLeft", down: true },
      { keysym: 0x76, code: "KeyV", down: true },
      { keysym: 0x76, code: "KeyV", down: false },
      { keysym: 0xffe3, code: "ControlLeft", down: false },
      { keysym: 0xffea, code: "AltRight", down: true },
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
    // Cmd and Option go as Screen Sharing names Command and Option: Meta and Alt, not noVNC's Alt_L and Mode_switch.
    client._handleKeyEvent(0xffe9, "MetaLeft", true, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", true, null, null);
    client._handleKeyEvent(0xfe03, "AltRight", true, null, null);
    expect(client.keyEvents).toEqual([
      { keysym: 0xffe7, code: "MetaLeft", down: true },
      { keysym: 0xffe9, code: "AltLeft", down: true },
      { keysym: 0xffea, code: "AltRight", down: true },
    ]);
    client._handleKeyEvent(0xffe9, "MetaLeft", false, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", false, null, null);
    client._handleKeyEvent(0xfe03, "AltRight", false, null, null);
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
  // A toast, BB's own, so the toolbar keeps its height (the owner's note of 18 October 2026).
  expect((await slot.findByText("Nothing has come from the box's clipboard yet. Copy something in the box first.")).closest("[aria-live=polite]")).not.toBeNull();
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
  const windows = desktopTab(server([desktopBox({ id: "box_7", name: "win-7", os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: false, clipboard: null, refresh: null, quality: null, macKeys: null } })]).handlers, "box_7");
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
  act(() => void novnc.FakeRfb.made[1]!.dispatchEvent(new Event("connect")));
  menu = await openMenu(windows.getByRole("button", { name: "Desktop actions" }));
  expect(within(menu).getByRole("menuitem", { name: "Paste from this computer" }).getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy to this computer" }));
  expect(await windows.findByText(/does not report its clipboard to viewers/)).toBeTruthy();

});

test("clipboard outcomes are toolbar notes that go after about 3 s, never from taking control; a paste the box refused is a lasting problem with Dismiss", async () => {
  fakeClipboard(() => Promise.resolve(""));
  const { handlers } = server([desktopBox({ id: "box_8", name: "mac-8", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } })]);
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
  expect(toasts()).toEqual([]);
  expect(slot.queryByRole("alert")).toBeNull();

  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
    const note = await slot.findByText("This computer's clipboard has no text.");
    expect(note.closest("[aria-live=polite]")).not.toBeNull();
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
    const { handlers, changes, copyInBox } = server([desktopBox({ id: "box_8", name: "mac-8", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } })]);
    const slot = desktopTab(handlers, "box_8");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    const viewer = new URL(novnc.FakeRfb.made[0]!.url).searchParams.get("viewer");
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    act(() => void window.dispatchEvent(new Event("focus")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(changes.filter((change) => change.startsWith("desktopPaste"))).toEqual([]);

    // Tart's VNC server takes Alt as Command and Meta as Option: Cmd goes as Alt, Option as Meta, and the paste chord is Alt+V.
    client._handleKeyEvent(0xffe9, "MetaLeft", true, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", true, null, null);
    // € goes as its Unicode keysym, which bb-box's input in the Mac types as the character.
    client._handleKeyEvent(0x20ac, "KeyE", true, null, null);
    expect(client.keyEvents).toEqual([
      { keysym: 0xffe9, code: "AltLeft", down: true },
      { keysym: 0xffe7, code: "MetaLeft", down: true },
      { keysym: 0x10020ac, code: "KeyE", down: true },
    ]);
    client._handleKeyEvent(0xffe9, "MetaLeft", false, null, null);
    client._handleKeyEvent(0xff7e, "AltLeft", false, null, null);
    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
    await waitFor(() => expect(client.keys).toHaveLength(4));
    expect(client.keys.map((key) => `${key.code}:${key.down ? "down" : "up"}`)).toEqual(["AltLeft:down", "KeyV:down", "KeyV:up", "AltLeft:up"]);
    expect(await slot.findByText("Pasted")).toBeTruthy();
    expect(changes.filter((change) => change.startsWith("desktopPaste"))).toEqual([`desktopPaste box_8 ${viewer} héllo, wörld ✓ 日本`]);

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

test("a desktop gets this computer's clipboard only with a paste, not on taking control or the focus, and the menu says a paste from the box's own menu uses the box's clipboard (F-15)", async () => {
  const readText = vi.fn(() => Promise.resolve("a test value"));
  fakeClipboard(readText);
  const { handlers, changes } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  act(() => void window.dispatchEvent(new Event("focus")));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readText).not.toHaveBeenCalled();
  expect(client.pasted).toEqual([]);
  const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
  const paste = within(menu).getByRole("menuitem", { name: "Paste from this computer" });
  expect(document.getElementById(paste.getAttribute("aria-describedby")!)?.textContent).toBe(DESKTOP_OWN_PASTE_WORDS);
  fireEvent.click(paste);
  await waitFor(() => expect(client.pasted).toEqual(["a test value"]));
  expect(readText).toHaveBeenCalledTimes(1);
  expect(changes.filter((change) => change.startsWith("desktopPaste"))).toEqual([]);
});

test("a Mac's first copy reaches this computer when its clipboard was empty as the tab took control, within a poll", async () => {
  const { writeText } = fakeClipboard(() => Promise.resolve(""));
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  try {
    const { handlers, copyInBox } = server([desktopBox({ id: "box_9", name: "mac-9", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } })]);
    const slot = desktopTab(handlers, "box_9");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    copyInBox("the first copy ✓");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("the first copy ✓"), { timeout: 900 });
  } finally {
    focus.mockRestore();
  }
});

test("a Windows box, whose QEMU console moves no clipboard, has it through bb-box: Cmd+V from a Mac and the menu's Paste send UTF-8 by RPC, then press the box's Ctrl+V, and Copy reads the box's (#461)", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  const { writeText } = fakeClipboard(() => Promise.resolve("from the Mac ✓"));
  try {
    const { handlers, changes, copyInBox } = server([desktopBox({ id: "box_7", name: "win-7", os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: null, quality: null, macKeys: null } })]);
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

test("keys typed straight after a paste land after it, though the box's clipboard takes a while; with no paste pending a key goes at once (#915)", async () => {
  const { handlers, changes } = server([desktopBox({ id: "box_7", name: "win-7", os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: null, quality: null, macKeys: null } })]);
  // Only the paste's own text waits for the test; the clipboard that goes to the box as control is taken answers at once, so
  // under load it cannot take the paste's place. This computer's clipboard starts empty, whatever an earlier test left there.
  fakeClipboard(() => Promise.resolve(""));
  let landed: (() => void) | null = null;
  const slow: PluginRpcTestHandlers<Contract> = {
    ...handlers,
    desktopPaste: ({ box: ref, viewer, text }) => {
      const land = () => changes.push(`desktopPaste ${ref} ${viewer} ${text}`);
      if (text !== "[PASTE]") {
        land();
        return null;
      }
      return new Promise<null>((resolve) => {
        landed = () => {
          land();
          resolve(null);
        };
      });
    },
  };
  const slot = desktopTab(slow, "box_7");
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  client.input.length = 0;

  client._handleKeyEvent(0x61, "KeyA", true, null, null);
  expect(client.input).toEqual(["typed KeyA"]);
  client._handleKeyEvent(0x61, "KeyA", false, null, null);

  client.input.length = 0;
  keyOnCanvas(slot, { key: "v", ctrlKey: true });
  act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
  await waitFor(() => expect(landed).not.toBeNull());
  for (const [code, down] of [["KeyX", true], ["KeyX", false], ["Enter", true], ["Enter", false]] as const) client._handleKeyEvent(code === "Enter" ? 0xff0d : 0x78, code, down, null, null);
  expect(client.input).toEqual([]);
  landed!();
  await waitFor(() => expect(changes).toContain(`desktopPaste box_7 ${new URL(novnc.FakeRfb.made[0]!.url).searchParams.get("viewer")} [PASTE]`));
  await waitFor(() => expect(client.input).toHaveLength(8));
  expect(client.input).toEqual(["sent ControlLeft", "sent KeyV", "sent KeyV up", "sent ControlLeft up", "typed KeyX", "typed KeyX up", "typed Enter", "typed Enter up"]);
});

test("a person's Ctrl+V from Linux or Windows into a Mac on Tart pastes with Command+V alone: their Ctrl, still down at the box while its release waits behind the chord, goes up first and down again after (#915)", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("Linux x86_64");
  try {
    const { handlers, changes } = server([desktopBox({ id: "box_8", name: "mac-8", os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } })]);
    const slot = desktopTab(handlers, "box_8");
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    client.input.length = 0;

    client._handleKeyEvent(0xffe3, "ControlLeft", true, null, null);
    keyOnCanvas(slot, { key: "v", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
    client._handleKeyEvent(0xffe3, "ControlLeft", false, null, null);
    client._handleKeyEvent(0x78, "KeyX", true, null, null);
    client._handleKeyEvent(0x78, "KeyX", false, null, null);
    await waitFor(() => expect(client.input).toHaveLength(10));
    expect(changes).toContain(`desktopPaste box_8 ${new URL(novnc.FakeRfb.made[0]!.url).searchParams.get("viewer")} [PASTE]`);
    expect(client.input).toEqual([
      "typed ControlLeft",
      "sent ControlLeft up",
      "sent AltLeft",
      "sent KeyV",
      "sent KeyV up",
      "sent AltLeft up",
      "sent ControlLeft",
      "typed ControlLeft up",
      "typed KeyX",
      "typed KeyX up",
    ]);
  } finally {
    platform.mockRestore();
  }
});

test("over VNC, a letter typed with Shift held and Caps Lock off goes as its capital, released as pressed; with Caps Lock on it stays as named (#913)", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
  act(() => void client.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  client.keyEvents.length = 0;
  client._handleKeyEvent(0xffe1, "ShiftLeft", true, null, false);
  client._handleKeyEvent(0x61, "KeyA", true, null, false);
  client._handleKeyEvent(0xffe1, "ShiftLeft", false, null, false);
  client._handleKeyEvent(0x61, "KeyA", false, null, false);
  client._handleKeyEvent(0xffe1, "ShiftLeft", true, null, true);
  client._handleKeyEvent(0x62, "KeyB", true, null, true);
  client._handleKeyEvent(0x62, "KeyB", false, null, true);
  client._handleKeyEvent(0xffe1, "ShiftLeft", false, null, true);
  client._handleKeyEvent(0x63, "KeyC", true, null, false);
  client._handleKeyEvent(0x63, "KeyC", false, null, false);
  expect(client.keyEvents.map((key) => `${key.keysym.toString(16)}${key.down ? "" : " up"}`)).toEqual(["ffe1", "41", "ffe1 up", "41 up", "ffe1", "62", "62 up", "ffe1 up", "63", "63 up"]);

  // A capital with no Shift press, as CDP and soft keyboards send it, goes inside Shift; not with Caps Lock on, and no symbol.
  client.keyEvents.length = 0;
  client._handleKeyEvent(0x53, "KeyS", true, null, false);
  client._handleKeyEvent(0x53, "KeyS", false, null, false);
  client._handleKeyEvent(0x54, "KeyT", true, null, true);
  client._handleKeyEvent(0x54, "KeyT", false, null, true);
  client._handleKeyEvent(0x21, "Digit1", true, null, false);
  client._handleKeyEvent(0x21, "Digit1", false, null, false);
  expect(client.keyEvents.map((key) => `${key.keysym.toString(16)}${key.down ? "" : " up"}`)).toEqual(["ffe1", "53", "53 up", "ffe1 up", "54", "54 up", "21", "21 up"]);
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
  expect(await slot.findByText("You have control.")).toBeTruthy();
  expect(slot.inspection.rpcCalls.find((call) => call.method === "takeControl")?.input).toEqual({ threadId: THREAD, box: "box_2", viewer });
  // Input goes to the box now; the desktop keeps its size until this tab's size changes (the owner's note of 16 October 2026).
  expect([client!.viewOnly, client!.resizeSession, client!.focused]).toEqual([false, false, 1]);
  expect(slot.getByTestId("control-ring")).toBeTruthy();

  fireEvent.click(slot.getByRole("button", { name: "Hand back to the agent" }));
  expect(await slot.findByText("The agent has control.")).toBeTruthy();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([true, false]);
  expect(slot.queryByTestId("control-ring")).toBeNull();
  expect(changes).toEqual(["takeControl box_2", "handBack box_2"]);
});

/** WebCodecs, which jsdom lacks: each decoder shows each chunk at once, as a frame of the desktop's size, 1280x800 unless a test changes it. */
class FakeDecoder {
  static made: FakeDecoder[] = [];
  static size = { width: 1280, height: 800 };
  /** Whether this browser decodes 4:4:4, as isConfigSupported answers. */
  static fullColour = true;
  /** Codecs this browser does not decode, as Safari's level 6 (#864). */
  static refused = new Set<string>();
  static async isConfigSupported(config: { codec: string }) {
    return { supported: (!/^avc1\.f4/i.test(config.codec) || FakeDecoder.fullColour) && !FakeDecoder.refused.has(config.codec), config };
  }
  state = "unconfigured";
  readonly codecs: string[] = [];
  readonly chunks: { type: string; timestamp: number }[] = [];
  readonly #output: (frame: unknown) => void;
  readonly #error: (error: unknown) => void;
  /** What the decoder's error callback threw, as a browser reports it and goes on. */
  static thrown: unknown[] = [];
  /** Whether decoders take frames and give none back, with no error: a video that stalled. */
  static silent = false;
  /** How many of the next decoders fail as they are made, as a browser that cannot make one now would. */
  static refuse = 0;
  constructor(init: { output: (frame: unknown) => void; error: (error: unknown) => void }) {
    if (FakeDecoder.refuse > 0) {
      FakeDecoder.refuse--;
      throw new DOMException("No decoder now.", "NotSupportedError");
    }
    this.#output = init.output;
    this.#error = init.error;
    FakeDecoder.made.push(this);
  }
  /** A frame it cannot decode, or a decoder the browser takes back: as WebCodecs says, it closes, then calls its error callback. */
  fail(name = "EncodingError") {
    this.state = "closed";
    try {
      this.#error(new DOMException("The decoder failed.", name));
    } catch (error) {
      FakeDecoder.thrown.push(error);
    }
  }
  configure(config: { codec: string }) {
    this.codecs.push(config.codec);
    this.state = "configured";
  }
  decode(chunk: { type: string; timestamp: number }) {
    this.chunks.push(chunk);
    if (FakeDecoder.silent) return;
    this.#output({ displayWidth: FakeDecoder.size.width, displayHeight: FakeDecoder.size.height, timestamp: chunk.timestamp, close() {} });
  }
  close() {
    // As WebCodecs says: a closed decoder cannot be closed again.
    if (this.state === "closed") throw new DOMException("The decoder is closed.", "InvalidStateError");
    this.state = "closed";
  }
}

/** Puts WebCodecs and a secure context in place for a test that shows video, and takes them away after. */
function withVideo() {
  FakeDecoder.made = [];
  FakeDecoder.thrown = [];
  FakeDecoder.refuse = 0;
  FakeDecoder.silent = false;
  FakeDecoder.refused = new Set();
  FakeDecoder.fullColour = true;
  FakeDecoder.size = { width: 1280, height: 800 };
  forgetFullColour();
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

/** A Selkies video message: type 4, H.264, its frame id, and the frame's size when given. */
function videoFrame(id: number, key: boolean, width = 0, height = 0): ArrayBuffer {
  const bytes = new Uint8Array(20);
  bytes[0] = 4;
  bytes[1] = 0x10 | (key ? 1 : 0);
  bytes[2] = id >> 8;
  bytes[3] = id & 0xff;
  bytes[6] = width >> 8;
  bytes[7] = width & 0xff;
  bytes[8] = height >> 8;
  bytes[9] = height & 0xff;
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
    fireEvent.click(slot.getByRole("button", { name: "Type text (Ctrl+Alt+Space)" }));
    const typed = await slot.findByRole("textbox", { name: "Text to type" });
    fireEvent.change(typed, { target: { value: "日本" } });
    fireEvent.keyDown(typed, { key: "Enter", code: "Enter" });
    expect(socket.sent.filter((sent) => typeof sent === "string" && /^k[du],(16803301|16803628)$/.test(sent))).toEqual(["kd,16803301", "ku,16803301", "kd,16803628", "ku,16803628"]);
    fireEvent.keyDown(typed, { key: "Escape", code: "Escape" });
    const emoji = 0x1000000 + 0x1f600;
    fireEvent.keyDown(canvas, { key: "😀", code: "" });
    fireEvent.keyUp(canvas, { key: "😀", code: "" });
    expect(socket.sent.filter((sent) => sent === `kd,${emoji}` || sent === `ku,${emoji}`)).toEqual([`kd,${emoji}`, `ku,${emoji}`]);
    canvas.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    expect(socket.sent.at(-1)).toBe("m,0,0,1,0");
    canvas.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }));
    expect(socket.sent.at(-1)).toBe("m,0,0,0,0");

    // The box's clipboard, for the viewer with control, goes to this computer's.
    const { writeText } = fakeClipboard(() => Promise.resolve(""));
    act(() => void socket.onmessage?.({ data: `clipboard,${btoa("from the box")}` }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("from the box"));

    // The menu's "Show as VNC", unticked while video shows, turns it to VNC, which the tab keeps for this box only.
    const item = within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(item);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(window.sessionStorage.getItem(streamChoiceKey("box_2"))).toBe("rfb");
    expect(window.localStorage.length).toBe(0);
    expect(socket.readyState).toBe(3);
    expect(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }).getAttribute("aria-checked")).toBe("true");
  } finally {
    undo();
  }
});

test("on a device, an input method's committed text, an emoji and Type text each go as one text message, and a person watching sees the agent's touches (063)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.clear();
    const { handlers } = server([desktopBox({ device: { platform: "android", model: "Pixel 8", simulatorHost: false } })], { video: true });
    const slot = deviceTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
    const device = deviceSocket();
    act(() => device.open());
    act(() => void device.onmessage?.({ data: "MODE websockets" }));
    act(() => void device.onmessage?.({ data: videoFrame(1, true, 360, 800) }));
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STATE ${JSON.stringify({ state: PIXEL_8_STATE })}` }));
    expect(await slot.findByText("The agent has control.")).toBeTruthy();
    const screen = slot.getByTestId("desktop-screen");
    const circles = () => screen.querySelectorAll('[aria-hidden="true"] > div').length;
    const sized = (name: "clientWidth" | "clientHeight", value: number) => vi.spyOn(HTMLElement.prototype, name, "get").mockReturnValue(value);
    const spies = [sized("clientWidth", 360), sized("clientHeight", 800)];
    act(() => void device.onmessage?.({ data: `BB_DEVICE_TOUCH ${JSON.stringify({ contacts: [{ id: 0, x: 180, y: 400 }], by: "agent", generation: 1 })}` }));
    expect(circles()).toBe(1);
    const circle = screen.querySelector<HTMLElement>('[aria-hidden="true"] > div')!;
    expect(circle.style.width).toBe("36px");

    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    act(() => void device.onmessage?.({ data: `BB_DEVICE_TOUCH ${JSON.stringify({ contacts: [{ id: 0, x: 10, y: 10 }], by: "person", generation: 1 })}` }));
    expect(circles()).toBe(1);
    for (const spy of spies) spy.mockRestore();
    const strings = () => device.sent.filter((sent): sent is string => typeof sent === "string");
    const texts = () => strings().filter((sent) => sent.startsWith("BB_DEVICE ")).map((sent) => JSON.parse(sent.slice("BB_DEVICE ".length)) as { type: string; text?: string });
    const keys = slot.getByLabelText("Keyboard input for the device");
    expect(document.activeElement).toBe(keys);
    fireEvent.keyDown(keys, { key: "Process", code: "KeyN", keyCode: 229, isComposing: true });
    expect(strings().some((sent) => sent.startsWith("kd,"))).toBe(false);
    fireEvent.compositionEnd(keys, { data: "日本語" });
    fireEvent.input(keys, { data: "😀", inputType: "insertText" });
    expect(texts()).toEqual([expect.objectContaining({ type: "text", text: "日本語" }), expect.objectContaining({ type: "text", text: "😀" })]);

    fireEvent.click(slot.getByRole("button", { name: "Type text (Ctrl+Alt+Space)" }));
    const field = await slot.findByRole("textbox", { name: "Text to type" });
    fireEvent.change(field, { target: { value: "مرحبا ".repeat(40) } });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(texts().at(-1)).toEqual(expect.objectContaining({ type: "text", text: "مرحبا ".repeat(40) }));
    expect(strings().some((sent) => sent.startsWith("cw,"))).toBe(false);
  } finally {
    undo();
  }
});

function deviceSocket(): FakeSocket {
  const socket = FakeSocket.made.find((made) => new URL(made.url).searchParams.get("display") === "device");
  if (!socket) throw new Error("no device socket");
  return socket;
}

const PIXEL_8_STATE = {
  platform: "android",
  form: "phone",
  model: "Pixel 8",
  power: { is: "booted", awake: true },
  geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 360, height: 800 } },
  settings: {
    appearance: { known: true, value: "light", at: 1, by: "bb-box" },
    fontScale: { known: true, value: 1, at: 1, by: "bb-box" },
    location: { known: true, value: null, at: 1, by: "bb-box" },
    battery: { known: true, value: { level: 100, charging: true }, at: 1, by: "bb-box" },
    network: { known: true, value: "online", at: 1, by: "bb-box" },
    statusBar: { set: null, at: null },
  },
  at: 1,
};

const IPHONE_STATE = {
  platform: "ios",
  model: "iPhone 18 Pro",
  power: { is: "booted", awake: true },
  geometry: { generation: 1, physical: "upright", content: "upright", video: { width: 1206, height: 2622 } },
  settings: {
    appearance: { known: true, value: "light", at: 1, by: "bb-box" },
    textSize: { known: true, value: "large", at: 1, by: "bb-box" },
    location: { set: null, at: null },
    statusBar: { set: null, at: null },
  },
  at: 1,
};

const IOS_RUNTIME = { platform: "ios", os: "27.0", build: "25A1", xcode: "27.0", companion: "1.7.7" };

function iosHello(bootedHere?: readonly string[]) {
  const devices = ["iPhone 18 Pro", "iPhone 17", "iPad Pro 13-inch (M5)"].map((model) => ({ model, native: model, runtime: IOS_RUNTIME }));
  return `BB_DEVICE_HELLO ${JSON.stringify({ protocol: 1, version: 10, platform: "ios", devices, state: IPHONE_STATE, lease: false, ...(bootedHere ? { bootedHere } : {}) })}`;
}

function sizedPanel(width: number, height: number) {
  const sized = (name: "clientWidth" | "clientHeight", value: number) => vi.spyOn(HTMLElement.prototype, name, "get").mockReturnValue(value);
  const spies = [sized("clientWidth", width), sized("clientHeight", height)];
  return () => {
    for (const spy of spies) spy.mockRestore();
  };
}

async function deviceShown(model: string, state: object, hello?: string, deviceClipboard?: string) {
  const { handlers, changes } = server([desktopBox({ device: { platform: model.startsWith("Pixel") ? "android" : "ios", model, simulatorHost: false } })], { video: true, ...(deviceClipboard !== undefined ? { deviceClipboard } : {}) });
  const slot = deviceTab(handlers);
  await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
  const device = deviceSocket();
  act(() => device.open());
  act(() => void device.onmessage?.({ data: "MODE websockets" }));
  const video = (state as { geometry: { video: { width: number; height: number } } }).geometry.video;
  act(() => void device.onmessage?.({ data: videoFrame(1, true, video.width, video.height) }));
  if (hello) act(() => void device.onmessage?.({ data: hello }));
  act(() => void device.onmessage?.({ data: `BB_DEVICE_STATE ${JSON.stringify({ state })}` }));
  await slot.findByRole("toolbar");
  const requests = () =>
    device.sent
      .filter((sent): sent is string => typeof sent === "string" && sent.startsWith("BB_DEVICE "))
      .map((sent) => JSON.parse(sent.slice("BB_DEVICE ".length)) as { id: string; type: string; control?: { action: string }; url?: string });
  const answer = (id: string, ok = true, words = "") =>
    act(() => void device.onmessage?.({ data: `BB_DEVICE_ANSWER ${JSON.stringify(ok ? { id, ok, ms: 412, state, result: { type: "done" } } : { id, ok, error: { code: "busy", words }, state })}` }));
  return { slot, device, changes, requests, answer };
}

test("a device gets this computer's clipboard only with a paste: taking control and the focus send none, Cmd+V and Paste send it once as one paste, and a refused paste sends nothing (F-15)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const readText = vi.fn(() => Promise.resolve("a test value"));
    fakeClipboard(readText);
    const { slot, device, requests, answer } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello().replace('"version":10', `"version":${PASTE_REQUEST_SINCE_VERSION}`));
    const clipboardSent = () => device.sent.filter((sent) => typeof sent === "string" && /^c[wb]/.test(sent));
    const pastes = () => requests().filter((request) => request.type === "paste" || request.type === "text") as { id: string; type: string; text?: string }[];
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    act(() => void window.dispatchEvent(new Event("focus")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readText).not.toHaveBeenCalled();
    expect(clipboardSent()).toEqual([]);
    expect(pastes()).toEqual([]);

    const keys = slot.getByLabelText("Keyboard input for the device");
    fireEvent.keyDown(keys, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("pasted by keys")));
    await waitFor(() => expect(pastes()).toHaveLength(1));
    expect(pastes()[0]).toMatchObject({ type: "paste", text: "pasted by keys" });
    answer(pastes()[0]!.id);
    expect(await slot.findByText("Pasted")).toBeTruthy();

    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    const paste = within(menu).getByRole("menuitem", { name: "Paste from this computer" });
    expect(document.getElementById(paste.getAttribute("aria-describedby")!)?.textContent).toBe(DEVICE_OWN_PASTE_WORDS);
    fireEvent.click(paste);
    await waitFor(() => expect(pastes()).toHaveLength(2));
    expect(readText).toHaveBeenCalledTimes(1);
    expect(pastes()[1]).toMatchObject({ type: "paste", text: "a test value" });
    answer(pastes()[1]!.id, false, "The device is busy.");
    expect(await slot.findByText("The device is busy.")).toBeTruthy();

    fireEvent.keyDown(keys, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("x".repeat(DEVICE_CLIPBOARD_MOST + 1))));
    expect(await slot.findByText(devicePasteTooLongWords(DEVICE_CLIPBOARD_MOST + 1))).toBeTruthy();
    expect(pastes()).toHaveLength(2);
    expect(clipboardSent()).toEqual([]);
  } finally {
    unsize();
    undo();
  }
});

test("on a device, the field Paste offers when this computer's clipboard cannot be read says the device's clipboard is put back, and sends one paste (F-16)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    fakeClipboard(() => Promise.reject(new Error("Read permission denied.")));
    const { slot, requests } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello().replace('"version":10', `"version":${PASTE_REQUEST_SINCE_VERSION}`));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Paste from this computer" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(DEVICE_PASTE_FIELD_WORDS)).toBeTruthy();
    expect(within(dialog).queryByText(/goes to the box's clipboard/)).toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Text to paste" }), { target: { value: "typed into the field" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Paste into the device" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    await waitFor(() => expect(requests().filter((request) => request.type === "paste")).toHaveLength(1));
    expect(requests().find((request) => request.type === "paste")).toMatchObject({ type: "paste", text: "typed into the field" });
  } finally {
    unsize();
    undo();
  }
});

function barButtons(slot: ReturnType<typeof desktopTab>): string[] {
  return within(slot.getByRole("toolbar")).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? "");
}

test("an iPhone's toolbar has Home, both rotations, Appearance, Text size, Screenshot and More beside the frame, and nothing iOS lacks (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    const toolbar = slot.getByRole("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("iPhone 18 Pro controls");
    expect(toolbar.getAttribute("aria-orientation")).toBe("vertical");
    expect(toolbar.dataset.arrangement).toBe("beside");
    expect(barButtons(slot)).toEqual(["Home", "Rotate left", "Rotate right", "Dark appearance", "Text size", "Copy screenshot", "More device controls"]);
    expect(within(toolbar).getByRole("button", { name: "Dark appearance" }).getAttribute("aria-pressed")).toBe("false");
  } finally {
    unsize();
    undo();
  }
});

test("a Pixel 8's toolbar adds Back and Recent apps, and a narrow panel puts the most used in one row with the rest in More (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(400, 800);
  try {
    window.sessionStorage.clear();
    const { slot } = await deviceShown("Pixel 8", PIXEL_8_STATE);
    const toolbar = slot.getByRole("toolbar");
    expect(toolbar.dataset.arrangement).toBe("below");
    expect(toolbar.getAttribute("aria-orientation")).toBe("horizontal");
    expect(barButtons(slot)).toEqual(["Home", "Back", "Recent apps", "Rotate left", "More device controls"]);
    const more = await openMenu(within(toolbar).getByRole("button", { name: "More device controls" }));
    for (const name of ["Rotate right", "Copy screenshot", "Lock", "Open link…", /^Reboot device ?Takes about 18 s\. Keeps apps and data\.$/]) expect(within(more).getByRole("menuitem", { name })).toBeTruthy();
    expect(within(more).getByRole("menuitemcheckbox", { name: "Dark appearance" })).toBeTruthy();
    expect(within(more).getByRole("menuitemcheckbox", { name: /Clean status bar/ })).toBeTruthy();
  } finally {
    unsize();
    undo();
  }
});

test("a toolbar click takes control and sends its control once control comes, says so in the top bar, and shows a refusal's words (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot, changes, requests, answer } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    expect(slot.getByText("The agent has control.")).toBeTruthy();
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Home" }));
    await slot.findByText("You have control. Hand back when done.");
    expect(changes).toEqual(["takeControl box_2"]);
    await waitFor(() => expect(requests().filter((request) => request.type === "control")).toHaveLength(1));
    const home = requests().find((request) => request.type === "control")!;
    expect(home.control).toEqual({ action: "home" });
    expect(within(slot.getByRole("toolbar")).getByRole("button", { name: "Home" }).getAttribute("aria-busy")).toBe("true");
    answer(home.id);
    await waitFor(() => expect(within(slot.getByRole("toolbar")).getByRole("button", { name: "Home" }).getAttribute("aria-busy")).toBeNull());
    expect(toasts()).toEqual([]);
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Dark appearance" }));
    await waitFor(() => expect(requests().at(-1)?.control).toEqual({ action: "appearance", to: "dark" }));
    answer(requests().at(-1)!.id, false, "Another control is under way on this device. Try again when it has finished.");
    await waitFor(() => expect(toasts()).toEqual(["Another control is under way on this device. Try again when it has finished."]));
    expect(changes).toEqual(["takeControl box_2"]);
  } finally {
    unsize();
    undo();
  }
});

test("More holds Show frame and Pixel for pixel, kept per box, and settings with no picture of their own say what they did (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot, requests, answer } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    const more = () => openMenu(within(slot.getByRole("toolbar")).getByRole("button", { name: "More device controls" }));
    const menu = await more();
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Show frame" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Pixel for pixel" }));
    const viewKey = Object.keys(window.localStorage).find((key) => key.startsWith("bb-box:device-view:"))!;
    expect(JSON.parse(window.localStorage.getItem(viewKey)!)).toEqual({ frame: true, pixelForPixel: true });
    window.localStorage.removeItem(viewKey);
    const again = await more();
    fireEvent.click(within(again).getByRole("menuitemcheckbox", { name: /Clean status bar/ }));
    await waitFor(() => expect(requests().at(-1)?.control).toEqual({ action: "status_bar", to: "clean" }));
    answer(requests().at(-1)!.id);
    await waitFor(() => expect(toasts()).toEqual([`Made the iPhone 18 Pro's status bar clean in 0.4 s. It shows 9:41, full signal and Wi-Fi, and a full battery unless battery set one.`]));
  } finally {
    unsize();
    undo();
  }
});

test("Open link opens a typed address on the device, with https:// added, and refuses one with spaces in words (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot, requests, answer } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    const more = await openMenu(within(slot.getByRole("toolbar")).getByRole("button", { name: "More device controls" }));
    fireEvent.click(within(more).getByRole("menuitem", { name: "Open link…" }));
    const field = await screen.findByRole("textbox", { name: "Link" });
    fireEvent.change(field, { target: { value: "example.com/two words" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect((await screen.findByRole("alert")).textContent).toBe("A link has no spaces. Write %20 for a space.");
    fireEvent.change(field, { target: { value: "example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(requests().at(-1)).toEqual(expect.objectContaining({ type: "open", url: "https://example.com" })));
    answer(requests().at(-1)!.id);
    await waitFor(() => expect(toasts()).toEqual(["Opened https://example.com on the iPhone 18 Pro."]));
  } finally {
    unsize();
    undo();
  }
});

test("the device picker lists the box's models, warns of one not started in this box, and switches with control taken (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot, requests, answer } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello(["iPhone 18 Pro", "iPhone 17"]));
    const picker = await openMenu(slot.getByRole("button", { name: "Device: iPhone 18 Pro. Choose another" }));
    expect(within(picker).getByRole("menuitemcheckbox", { name: "iPhone 18 Pro" }).getAttribute("aria-checked")).toBe("true");
    expect(within(picker).getByRole("menuitemcheckbox", { name: "iPhone 17" })).toBeTruthy();
    const ipad = within(picker).getByRole("menuitemcheckbox", { name: /^iPad Pro 13-inch \(M5\) ?Not started in this box yet, so it may take a minute\.$/ });
    expect(within(picker).getByText(/Apps are per device/)).toBeTruthy();
    fireEvent.click(ipad);
    await waitFor(() => expect(requests().at(-1)?.control).toEqual({ action: "switch", device: "iPad Pro 13-inch (M5)" }));
    answer(requests().at(-1)!.id);
    await waitFor(() => expect(toasts()).toEqual(["Switched to the iPad Pro 13-inch (M5) in 0.4 s.Apps are per device. Install your app again on the iPad Pro 13-inch (M5) if it needs it."]));
  } finally {
    unsize();
    undo();
  }
});

test("Screenshot asks bb-box for the device's own pixels without taking control, and copies them as a PNG (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  const write = vi.fn<(items: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { write, readText: () => Promise.resolve(""), writeText: () => Promise.resolve() }, configurable: true });
  vi.stubGlobal("ClipboardItem", class {
    readonly items: Record<string, unknown>;
    constructor(items: Record<string, unknown>) {
      this.items = items;
    }
  });
  try {
    window.sessionStorage.clear();
    const { slot, changes } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    fireEvent.click(within(slot.getByRole("toolbar")).getByRole("button", { name: "Copy screenshot" }));
    await waitFor(() => expect(toasts()).toEqual(["Copied the iPhone 18 Pro's screen."]));
    expect(changes).toEqual(["deviceScreenshot"]);
    expect(write).toHaveBeenCalledTimes(1);
  } finally {
    unsize();
    undo();
  }
});

test("Copy to this computer reads the device's clipboard for the tab with control, says how much it copied, and Cmd+C in the device copies it too (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  const { writeText } = fakeClipboard(() => Promise.resolve(""));
  try {
    window.sessionStorage.clear();
    const { slot, changes } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello(), "Hello from the device");
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Copy to this computer" }));
    await waitFor(() => expect(toasts()).toEqual(["Take control first, then copy: only the tab with control reads the device's clipboard."]));
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Copy to this computer" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Hello from the device"));
    await waitFor(() => expect(toasts()).toContain("Copied 21 characters from the iPhone 18 Pro."));

    const keyboard = slot.getByRole("textbox", { name: "Keyboard input for the device", hidden: true });
    keyboard.focus();
    fireEvent.keyDown(keyboard, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2));
    expect(changes.filter((change) => change === "deviceClipboard")).toHaveLength(3);

    fireEvent.keyDown(keyboard, { key: "c", metaKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(writeText).toHaveBeenCalledTimes(2);
  } finally {
    unsize();
    undo();
  }
});

test("the toolbar moves by arrow keys as one tab stop, and the device's changes are read out (063)", async () => {
  const undo = withVideo();
  const unsize = sizedPanel(900, 800);
  try {
    window.sessionStorage.clear();
    const { slot, device } = await deviceShown("iPhone 18 Pro", IPHONE_STATE, iosHello());
    const toolbar = slot.getByRole("toolbar");
    const buttons = within(toolbar).getAllByRole("button");
    expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1, -1, -1, -1]);
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: "End" });
    expect(document.activeElement).toBe(buttons.at(-1));
    const dark = { ...IPHONE_STATE, settings: { ...IPHONE_STATE.settings, appearance: { known: true, value: "dark", at: 2, by: "bb-box" } }, geometry: { ...IPHONE_STATE.geometry, generation: 2, physical: "turned-left" } };
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STATE ${JSON.stringify({ state: dark })}` }));
    await waitFor(() => expect(slot.getByTestId("device-announcer").textContent).toBe("Turned left. Dark appearance."));
    expect(within(toolbar).getByRole("button", { name: "Dark appearance" }).getAttribute("aria-pressed")).toBe("true");
  } finally {
    unsize();
    undo();
  }
});

test("a tab from before the device tab, for a box with a device and a desktop, opens on the screen last chosen, and its Desktop and Emulator buttons switch between two kept sessions, each with its own socket, input and clipboard, with no hand-back (063)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.clear();
    window.sessionStorage.setItem("bb-box:display:box_2", "device");
    const { handlers, changes } = server([desktopBox({ device: { platform: "android", model: "Pixel 8", simulatorHost: false } })], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
    expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(false);
    expect(novnc.FakeRfb.made).toHaveLength(0);
    const device = deviceSocket();
    expect(device.url).not.toContain("stream=");
    expect((await slot.findAllByText("Pixel 8")).length).toBeGreaterThan(0);
    expect(slot.getByText("Connecting")).toBeTruthy();
    act(() => device.open());
    expect(device.sent).toEqual(["START_VIDEO"]);
    act(() => void device.onmessage?.({ data: "MODE websockets" }));
    act(() => void device.onmessage?.({ data: videoFrame(1, true, 360, 800) }));
    expect(await slot.findByText("The agent has control.")).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Emulator" })).toBeNull();
    const actions = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    expect(within(actions).queryByRole("menuitem", { name: "Display" })).toBeNull();
    fireEvent.keyDown(actions, { key: "Escape" });

    const readText = vi.fn(() => Promise.resolve("for the device"));
    fakeClipboard(readText);
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const keys = slot.getByLabelText("Keyboard input for the device");
    fireEvent.keyDown(keys, { key: "a", code: "KeyA" });
    fireEvent.keyUp(keys, { key: "a", code: "KeyA" });
    expect(device.sent).toContain("kd,97");

    vi.useFakeTimers();
    fireEvent.click(slot.getByRole("button", { name: "Desktop" }));
    vi.useRealTimers();
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    expect(slot.queryByRole("button", { name: "Desktop" })).toBeNull();
    const desktop = videoSocket();
    expect(window.sessionStorage.getItem("bb-box:display:box_2")).toBe("desktop");
    expect(device.readyState).toBe(1);
    expect(device.sent.at(-1)).toBe("STOP_VIDEO");
    act(() => desktop.open());
    act(() => void desktop.onmessage?.({ data: videoFrame(1, true) }));
    act(() => void window.dispatchEvent(new Event("focus")));
    const desktopCanvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    const keysBefore = device.sent.filter((sent) => sent === "kd,98").length;
    fireEvent.keyDown(desktopCanvas, { key: "b", code: "KeyB" });
    expect(desktop.sent).toContain("kd,98");
    expect(device.sent.filter((sent) => sent === "kd,98").length).toBe(keysBefore);
    expect(desktop.sent.some((sent) => typeof sent === "string" && sent.startsWith("cw"))).toBe(false);
    fireEvent.keyDown(desktopCanvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("for the desktop")));
    await waitFor(() => expect(desktop.sent).toContain(`cw,${btoa("for the desktop")}`));
    expect(device.sent.filter((sent) => typeof sent === "string" && sent.startsWith("BB_DEVICE "))).toEqual([]);

    vi.useFakeTimers();
    fireEvent.click(slot.getByRole("button", { name: "Emulator" }));
    await vi.advanceTimersByTimeAsync(HAND_BACK_MS + 50);
    vi.useRealTimers();
    expect(changes).toEqual(["takeControl box_2"]);
    expect(FakeSocket.made.filter((made) => made.url.includes("display=device"))).toHaveLength(1);
    const back = device.sent.slice(device.sent.lastIndexOf("STOP_VIDEO") + 1);
    expect(back.filter((sent) => sent === "START_VIDEO" || sent === "REQUEST_KEYFRAME")).toEqual(["START_VIDEO", "REQUEST_KEYFRAME"]);
    expect(device.sent.some((sent) => typeof sent === "string" && sent.startsWith("cw"))).toBe(false);
    expect(readText).not.toHaveBeenCalled();
    expect(desktop.readyState).toBe(1);
    expect(desktop.sent.at(-1)).toBe("STOP_VIDEO");
  } finally {
    undo();
  }
});

test("where the browser has no WebCodecs, the device shows stills over its own connection, with words above it, and never the desktop (063)", async () => {
  window.sessionStorage.clear();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 360, height: 800, close() {} }));
  try {
    const { handlers } = server([desktopBox({ device: { platform: "android", model: "Pixel 8", simulatorHost: false } })], { video: true });
    const slot = deviceTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
    const device = deviceSocket();
    act(() => device.open());
    expect(device.sent).toEqual(['BB_DEVICE_STILLS {"on":true}', "START_VIDEO"]);
    act(() => void device.onmessage?.({ data: `BB_DEVICE_HELLO ${JSON.stringify({ protocol: 1, version: 2, platform: "android", devices: [{ model: "Pixel 8", native: "bb-box-test-device", runtime: { platform: "android", api: 35, image: "google_apis", revision: 1, abi: "x86_64", emulator: "bb-box test driver", snapshot: null } }], state: { ...PIXEL_8_STATE, power: { is: "booting", since: 1 } }, lease: false })}` }));
    expect(await slot.findByText("Booting")).toBeTruthy();
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STATE ${JSON.stringify({ state: PIXEL_8_STATE })}` }));
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STILL ${JSON.stringify({ png: "iVBORw0KGgo=", generation: 1 })}` }));
    expect(await slot.findByText("This browser cannot play the device's video, so it shows a picture a few times a second.")).toBeTruthy();
    expect(slot.getByText("The agent has control.")).toBeTruthy();
    expect(novnc.FakeRfb.made).toHaveLength(0);
    expect(FakeSocket.made.some((made) => made.url.includes("stream="))).toBe(false);
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal("WebSocket", FakeSocket);
    vi.stubGlobal("ResizeObserver", FakeObserver);
  }
});

test("a device whose first frame does not decode within 3 s asks for stills instead, on the same connection (063)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.clear();
    FakeDecoder.silent = true;
    const { handlers } = server([desktopBox({ device: { platform: "android", model: "Pixel 8", simulatorHost: false } })], { video: true });
    deviceTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
    const device = deviceSocket();
    act(() => device.open());
    vi.useFakeTimers();
    act(() => void device.onmessage?.({ data: videoFrame(1, true, 360, 800) }));
    await vi.advanceTimersByTimeAsync(3_050);
    vi.useRealTimers();
    expect(device.sent).toContain('BB_DEVICE_STILLS {"on":true}');
    expect(FakeSocket.made.filter((made) => made.url.includes("display=device"))).toHaveLength(1);
    expect(novnc.FakeRfb.made).toHaveLength(0);
  } finally {
    undo();
  }
});

test("a device whose first frame came too late for its stills tries its video again: the words say why, and video shows once a frame decodes (F-9, H8)", async () => {
  const undo = withVideo();
  vi.stubGlobal("createImageBitmap", async () => ({ width: 360, height: 800, close() {} }));
  try {
    window.sessionStorage.clear();
    FakeDecoder.silent = true;
    const { handlers } = server([desktopBox({ device: { platform: "android", model: "Pixel 8", simulatorHost: false } })], { video: true });
    const slot = deviceTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("display=device"))).toBe(true));
    const device = deviceSocket();
    act(() => device.open());
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STATE ${JSON.stringify({ state: PIXEL_8_STATE })}` }));
    vi.useFakeTimers();
    act(() => void device.onmessage?.({ data: videoFrame(1, true, 360, 800) }));
    await vi.advanceTimersByTimeAsync(3_050);
    expect(device.sent).toContain('BB_DEVICE_STILLS {"on":true}');
    act(() => void device.onmessage?.({ data: `BB_DEVICE_STILL ${JSON.stringify({ png: "iVBORw0KGgo=", generation: 1 })}` }));
    await vi.advanceTimersByTimeAsync(50);
    expect(slot.getByText(SLOW_VIDEO_STILLS_WORDS)).toBeTruthy();
    expect(slot.queryByText(STILLS_WORDS)).toBeNull();

    FakeDecoder.silent = false;
    await act(async () => void (await vi.advanceTimersByTimeAsync(SLOW_VIDEO_RETRY_MS)));
    expect(device.sent.at(-1)).toBe('BB_DEVICE_STILLS {"on":false}');
    expect(slot.queryByText(SLOW_VIDEO_STILLS_WORDS)).toBeNull();
    act(() => void device.onmessage?.({ data: videoFrame(2, true, 360, 800) }));
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    expect(device.sent.filter((sent) => sent === 'BB_DEVICE_STILLS {"on":true}')).toHaveLength(1);
    expect(FakeDecoder.made.at(-1)!.chunks.map((chunk) => chunk.timestamp)).toEqual([2]);
    expect(FakeSocket.made.filter((made) => made.url.includes("display=device"))).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    undo();
  }
});

test("a desktop whose video is shown only by choice, as a Tart Mac's, opens over VNC with Show as VNC ticked, and unticking it shows video, kept for the box", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.clear();
    const on = server([desktopBox()], { video: true, videoByDefault: false });
    const slot = desktopTab(on.handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(false);
    const item = within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" });
    expect(item.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(item);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    expect(window.sessionStorage.getItem(streamChoiceKey("box_2"))).toBe("selkies");
    expect(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }).getAttribute("aria-checked")).toBe("false");

    // The choice stays for the box: a viewer opened again shows video.
    cleanup();
    dropAllKept();
    forgetStreams();
    forgetLive();
    novnc.FakeRfb.made = [];
    FakeSocket.made = [];
    desktopTab(server([desktopBox()], { video: true, videoByDefault: false }).handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    expect(novnc.FakeRfb.made).toHaveLength(0);
  } finally {
    window.sessionStorage.clear();
    undo();
  }
});

test("a video desktop whose decoder failed shows again when its tab comes back, rather than crashing the panel", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    let slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    // The decoder fails, as Safari's can after the window's size changes or while its tab is away, and closes.
    act(() => FakeDecoder.made.at(-1)!.fail());
    expect(FakeDecoder.thrown).toEqual([]);
    // The person switches to another tab and back: the kept session shows again, with a decoder of its own.
    cleanup();
    slot = desktopTab(handlers);
    expect(await slot.findByText("The agent has control.")).toBeTruthy();
    expect(FakeDecoder.made.at(-1)!.state).toBe("configured");
    act(() => void socket.onmessage?.({ data: videoFrame(6, true) }));
    expect(FakeDecoder.made.at(-1)!.chunks).toEqual([{ type: "key", timestamp: 6 }]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a video desktop whose stream this browser cannot decode, as Safari past H.264 level 5.2, shows over VNC, and its decoder is not made again and again", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const slot = desktopTab(server([desktopBox()], { video: true }).handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    const made = FakeDecoder.made.length;
    act(() => FakeDecoder.made.at(-1)!.fail("NotSupportedError"));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(FakeDecoder.made).toHaveLength(made);
    expect(socket.readyState).toBe(3);
    expect(toasts()).toEqual(["Video did not start, so this shows VNC.This browser cannot decode the desktop's video at its size (avc1.42E01F)."]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a video viewer says how large a frame its browser decodes, and waits for a frame it decodes while the box makes its desktop smaller for it (#864)", async () => {
  const undo = withVideo();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    // A browser that decodes no more than level 5.2, as Safari.
    FakeDecoder.refused = new Set(["avc1.42C03D", "avc1.42C03C"]);
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const slot = desktopTab(server([desktopBox()], { video: true }).handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    await waitFor(() => expect(socket.sent).toContain("BB_DECODES,34560"));
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true, 1920, 1080) }));
    await slot.findByText("The agent has control.");
    // The desktop is at twice a Chrome viewer's tab, past what this browser decodes: its decoder refuses it, and the viewer waits.
    act(() => void socket.onmessage?.({ data: videoFrame(6, true, 5200, 3000) }));
    act(() => FakeDecoder.made.at(-1)!.fail("NotSupportedError"));
    act(() => void socket.onmessage?.({ data: videoFrame(7, true, 5200, 3000) }));
    const made = FakeDecoder.made.length;
    expect(novnc.FakeRfb.made).toHaveLength(0);
    // The box makes it smaller: the next key frame of a size it decodes shows, with a decoder of its own.
    act(() => void socket.onmessage?.({ data: videoFrame(8, true, 3904, 2256) }));
    expect(FakeDecoder.made).toHaveLength(made + 1);
    expect(FakeDecoder.made.at(-1)!.chunks).toEqual([{ type: "key", timestamp: 8 }]);
    expect(novnc.FakeRfb.made).toHaveLength(0);
    // Too large again, and no frame it decodes comes: after a while, the desktop shows over VNC.
    act(() => void socket.onmessage?.({ data: videoFrame(9, true, 5200, 3000) }));
    act(() => FakeDecoder.made.at(-1)!.fail("NotSupportedError"));
    act(() => void vi.advanceTimersByTime(FIT_WAIT_MS));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  } finally {
    vi.useRealTimers();
    undo();
    window.sessionStorage.clear();
  }
});

test("a video viewer whose browser decodes level 6.1 says so (#864)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    desktopTab(server([desktopBox()], { video: true }).handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    await waitFor(() => expect(socket.sent).toContain("BB_DECODES,139264"));
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("video that this browser cannot decode while its tab is away shows over VNC as the tab comes back, rather than a frozen picture", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    let slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    cleanup();
    act(() => FakeDecoder.made.at(-1)!.fail("NotSupportedError"));
    expect(novnc.FakeRfb.made).toHaveLength(0);
    slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(toasts()).toEqual(["Video did not start, so this shows VNC.This browser cannot decode the desktop's video at its size (avc1.42E01F)."]);
    // Back again later, it shows over VNC at once, its kept session, with no new try at video.
    const videos = FakeSocket.made.filter((made) => made.url.includes("stream=selkies")).length;
    cleanup();
    slot = desktopTab(handlers);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(novnc.FakeRfb.made).toHaveLength(1);
    expect(FakeSocket.made.filter((made) => made.url.includes("stream=selkies"))).toHaveLength(videos);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("over video, keys typed straight after a paste go after the box's paste chord (#915)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
    fireEvent.keyDown(canvas, { key: "x", code: "KeyX" });
    expect(socket.sent).not.toContain("kd,120");
    await waitFor(() => expect(socket.sent).toContain("ku,118"));
    const chord = performance.now();
    await waitFor(() => expect(socket.sent).toContain("kd,120"));
    expect(performance.now() - chord).toBeGreaterThanOrEqual(PASTE_LANDS_MS - 60);
    const keys = socket.sent.filter((sent): sent is string => typeof sent === "string" && /^k[du],/.test(sent));
    expect(keys.slice(-5)).toEqual(["kd,65507", "kd,118", "ku,118", "ku,65507", "kd,120"]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("over video, a letter typed with Shift held and Caps Lock off goes as its capital; with Caps Lock on it stays as named (#913)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    const sent = socket.sent.length;
    fireEvent.keyDown(canvas, { key: "Shift", code: "ShiftLeft", shiftKey: true });
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA", shiftKey: true });
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA", shiftKey: true });
    fireEvent.keyDown(canvas, { key: "b", code: "KeyB", shiftKey: true, modifierCapsLock: true } as KeyboardEventInit);
    fireEvent.keyUp(canvas, { key: "b", code: "KeyB", shiftKey: true, modifierCapsLock: true } as KeyboardEventInit);
    fireEvent.keyUp(canvas, { key: "Shift", code: "ShiftLeft" });
    // A capital with no Shift press goes inside Shift.
    fireEvent.keyDown(canvas, { key: "S", code: "KeyS", shiftKey: true });
    fireEvent.keyUp(canvas, { key: "S", code: "KeyS", shiftKey: true });
    const keys = socket.sent.slice(sent).filter((message): message is string => typeof message === "string" && /^k[du],/.test(message));
    expect(keys).toEqual(["kd,65505", "kd,65", "ku,65", "kd,98", "ku,98", "ku,65505", "kd,65505", "kd,83", "ku,83", "ku,65505"]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a paste on its way as the stream switches to VNC is pressed before the video goes, and keys typed over VNC go after it (#933)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
    fireEvent.click(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const keys = socket.sent.filter((message): message is string => typeof message === "string" && /^k[du],/.test(message));
    expect(keys.slice(-4)).toEqual(["kd,65507", "kd,118", "ku,118", "ku,65507"]);
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    client._handleKeyEvent(0x78, "KeyX", true, null, false);
    expect(client.keyEvents.some((key) => key.keysym === 0x78)).toBe(false);
    await waitFor(() => expect(client.keyEvents.some((key) => key.keysym === 0x78)).toBe(true));
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("with localStorage bb-box-keylog set to 1, the video viewer logs each key it sends and asks the relay to log them too; without it, neither (a diagnostic)", async () => {
  const undo = withVideo();
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    window.localStorage.setItem("bb-box-keylog", "1");
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    expect(new URL(FakeSocket.made.find((made) => made.url.includes("stream=selkies"))!.url).searchParams.get("keylog")).toBe("1");
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    fireEvent.keyDown(canvas, { key: "a", code: "KeyA" });
    expect(logged.mock.calls.some(([line]) => /^bb-box key video: down 0x61 'a', held \[97\]|^bb-box key video: down 0x61 'a', held \[0x61\]/.test(String(line)))).toBe(true);
    window.localStorage.removeItem("bb-box-keylog");
    logged.mockClear();
    fireEvent.keyUp(canvas, { key: "a", code: "KeyA" });
    expect(logged).not.toHaveBeenCalled();
  } finally {
    window.localStorage.removeItem("bb-box-keylog");
    logged.mockRestore();
    undo();
    window.sessionStorage.clear();
  }
});

test("a viewer in control lets go of the keys it holds down as its tab goes, so the box keeps no Ctrl held, over video and VNC", async () => {
  const undo = withVideo();
  try {
    // Video: Ctrl goes down in the box; the tab goes before it comes up.
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    let slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
    fireEvent.keyDown(canvas, { key: "Control", code: "ControlLeft" });
    expect(socket.sent).toContain("kd,65507");
    cleanup();
    expect(socket.sent).toContain("ku,65507");
    window.sessionStorage.clear();
    dropAllKept();
    forgetStreams();

    // VNC: noVNC's keyboard lets go of what it holds as the tab goes, while this tab has control; not without.
    slot = desktopTab(server([desktopBox()]).handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]!;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    cleanup();
    expect(client.keysLetGo).toBe(1);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a kept video session that fails as its tab comes back gives way to a fresh one, and the panel does not crash", async () => {
  const undo = withVideo();
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    let slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const first = videoSocket();
    act(() => first.open());
    act(() => void first.onmessage?.({ data: "MODE websockets" }));
    act(() => void first.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    cleanup();
    // Back on the tab, the kept session starts its video again, and its new decoder cannot be made.
    FakeDecoder.refuse = 1;
    slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.filter((made) => made.url.includes("stream=selkies"))).toHaveLength(2));
    expect(first.readyState).toBe(3);
    expect((await slot.findAllByText(/Connecting/)).length).toBeGreaterThan(0);
    expect(slot.queryByText(/crashed/)).toBeNull();
    expect(logged.mock.calls.some(([words]) => String(words).includes("failed as it showed again, so a fresh one starts"))).toBe(true);
  } finally {
    logged.mockRestore();
    undo();
    window.sessionStorage.clear();
  }
});

test("a kept VNC session that fails as it connects again when its tab comes back gives way to a fresh one, and the panel does not crash", async () => {
  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { handlers } = server([desktopBox()]);
    let slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const [client] = novnc.FakeRfb.made;
    act(() => void client!.dispatchEvent(new Event("connect")));
    await slot.findByText("The agent has control.");
    // Its connection ends, and the person switches to another tab before it connects again; back on the tab, connecting again
    // fails as noVNC makes its client.
    act(() => void client!.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } })));
    cleanup();
    novnc.FakeRfb.refuse = 1;
    slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
    act(() => void novnc.FakeRfb.made[1]!.dispatchEvent(new Event("connect")));
    expect(await slot.findByText("The agent has control.")).toBeTruthy();
    expect(logged.mock.calls.some(([words]) => String(words).includes("failed as it showed again, so a fresh one starts"))).toBe(true);
  } finally {
    novnc.FakeRfb.refuse = 0;
    logged.mockRestore();
  }
});

test("a desktop that would show as video on a page that is not secure shows over VNC and says so once for the page, with the desktops guide's Video", async () => {
  const undo = withVideo();
  forgetInsecurePageNote();
  vi.stubGlobal("isSecureContext", false);
  try {
    const { handlers } = server([desktopBox()], { video: true });
    desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(false);
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatch(/^This desktop shows over VNC: video needs a secure connection to BB\./);
    const link = (globalThis as { lastToastDescription?: { props?: { href?: string; children?: unknown } } }).lastToastDescription;
    expect(link?.props?.href).toMatch(/docs\/guide\/desktops\.md#video$/);
    expect(link?.props?.children).toBe("Video, in the desktops guide");
    cleanup();
    act(() => void toast.dismiss());
    dropAllKept();
    desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
    expect(toasts()).toEqual([]);
  } finally {
    undo();
  }
});

test("a desktop's notes are BB's toasts, one at a time, with their reason under them, and the toolbar keeps its height (the owner's note of 18 October 2026)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const slot = desktopTab(server([desktopBox()], { video: true }).handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    // The video ends before its first frame: the desktop shows over VNC, and says why in a toast, not in its toolbar.
    act(() => socket.end(1011, "Selkies is not running"));
    await waitFor(() => expect(toasts()).toEqual(["Video did not start, so this shows VNC.Selkies is not running."]));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const toolbar = slot.getByRole("button", { name: "Desktop actions" }).closest("div.border-b")!;
    expect(toolbar.textContent).not.toContain("Video did not start");
    // The next note of this tab takes its place.
    act(() => void novnc.FakeRfb.made[0]!.dispatchEvent(new Event("connect")));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    fakeClipboard(() => Promise.resolve(""));
    fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
    await waitFor(() => expect(toasts()).toEqual(["This computer's clipboard has no text."]));
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a video desktop's Display holds Show as VNC, and no choice of the box's pointer: the video leaves it out while you hold control, with its shape on your own", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const display = within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" })));
    expect(display.getAllByRole("menuitemcheckbox").map((item) => item.textContent?.trim())).toEqual(["Show as VNC"]);
    expect(socket.sent.some((sent) => String(sent).startsWith("BB_SHOWPOINTER"))).toBe(false);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("Cmd and Option reach a Mac as its server names Command and Option, from a Mac's browser or another, and Cmd is Ctrl elsewhere from a Mac", () => {
  const keys = (keysym: number, code: string, os: string, mac: boolean, macKeys: "alt-command" | null) => {
    const key = boxKey(keysym, code, os, mac, macKeys);
    return `${key.keysym.toString(16)} ${key.code}`;
  };
  // From a Mac: noVNC's Alt_L (left Cmd), Super_L (right Cmd), Mode_switch (left Option), ISO_Level3_Shift (right Option).
  expect([keys(0xffe9, "MetaLeft", "macos", true, null), keys(0xffeb, "MetaRight", "macos", true, null), keys(0xff7e, "AltLeft", "macos", true, null), keys(0xfe03, "AltRight", "macos", true, null)]).toEqual([
    "ffe7 MetaLeft",
    "ffe8 MetaRight",
    "ffe9 AltLeft",
    "ffea AltRight",
  ]);
  expect([keys(0xffe9, "MetaLeft", "macos", true, "alt-command"), keys(0xff7e, "AltLeft", "macos", true, "alt-command")]).toEqual(["ffe9 AltLeft", "ffe7 MetaLeft"]);
  // From another browser: Alt is Option and the Windows key Command, on Tart's VNC as anywhere.
  expect([keys(0xffe9, "AltLeft", "macos", false, null), keys(0xffeb, "MetaLeft", "macos", false, null)]).toEqual(["ffe9 AltLeft", "ffe7 MetaLeft"]);
  expect([keys(0xffe9, "AltLeft", "macos", false, "alt-command"), keys(0xffeb, "MetaLeft", "macos", false, "alt-command")]).toEqual(["ffe7 MetaLeft", "ffe9 AltLeft"]);
  // Chrome on a Mac says "macOS", Safari "MacIntel".
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("Linux x86_64");
  Object.defineProperty(navigator, "userAgentData", { value: { platform: "macOS" }, configurable: true });
  try {
    expect(macBrowser()).toBe(true);
  } finally {
    delete (navigator as { userAgentData?: unknown }).userAgentData;
    platform.mockRestore();
  }
  // Elsewhere: from a Mac, Cmd is Ctrl; from another browser, keys go as they are.
  expect([keys(0xffe9, "MetaLeft", "linux", true, null), keys(0xffe9, "AltLeft", "windows", false, null), keys(0xffeb, "MetaLeft", "linux", false, null), keys(0x61, "KeyA", "macos", true, null)]).toEqual([
    "ffe3 ControlLeft",
    "ffe9 AltLeft",
    "ffeb MetaLeft",
    "61 KeyA",
  ]);
});

test("a Mac's left Option on a desktop that is not a Mac composes: a character alone, Alt before any other key, nothing alone (the desktop sweep)", () => {
  const option = new OptionComposer();
  const sent = (keysym: number, code: string, down: boolean) => option.keys({ keysym, code }, down).map((each) => `${each.down ? "d" : "u"}:${each.key.keysym.toString(16)}`);
  // Option+E then E: the dead key, which noVNC drops in Safari and gives no keysym in Chrome, sends nothing; é goes
  // alone, and Option sends nothing.
  expect([...sent(0xffe9, "AltLeft", true), ...sent(null as unknown as number, "KeyE", true), ...sent(0, "KeyE", false), ...sent(0xe9, "KeyE", true), ...sent(0xe9, "KeyE", false), ...sent(0xffe9, "AltLeft", false)]).toEqual(["d:e9", "u:e9"]);
  // Option+Left: Alt, then the arrow, and Alt up after.
  expect([...sent(0xffe9, "AltLeft", true), ...sent(0xff51, "ArrowLeft", true), ...sent(0xff51, "ArrowLeft", false), ...sent(0xffe9, "AltLeft", false)]).toEqual(["d:ffe9", "d:ff51", "u:ff51", "u:ffe9"]);
  // The right Option is Alt, and a key with it goes as its US character: Alt+F, not the ƒ a Mac makes.
  const plain = (keysym: number, code: string, down: boolean) => option.keys({ keysym, code }, down).map((each) => `${each.down ? "d" : "u"}:${each.key.keysym.toString(16)}`);
  expect([...plain(0xffea, "AltRight", true), ...plain(0x8f6, "KeyF", true), ...plain(0x8f6, "KeyF", false), ...plain(0xffea, "AltRight", false)]).toEqual(["d:ffea", "d:66", "u:66", "u:ffea"]);
  // With Ctrl (a Mac's Cmd) held, a letter is a shortcut: Ctrl+Alt+T.
  expect([...sent(0xffe3, "ControlLeft", true), ...sent(0xffe9, "AltLeft", true), ...sent(0x74, "KeyT", true)]).toEqual(["d:ffe3", "d:ffe9", "d:74"]);
});

test("a Windows box's video gets a character X names itself, such as €, as its Unicode keysym, and Latin-1 and keys as they are (the desktop sweep)", () => {
  expect(unicodeKeysym(0x20ac)).toBe(0x10020ac);
  expect(unicodeKeysym(0x6d6)).toBe(0x1000436);
  expect([unicodeKeysym(97), unicodeKeysym(0xe9), unicodeKeysym(0xff0d), unicodeKeysym(0xffe1)]).toEqual([97, 0xe9, 0xff0d, 0xffe1]);
  expect(unicodeKeysym(0x100263a)).toBe(0x100263a);
});

test("High resolution's tooltip gives its cost for the box's system: Windows' frame rate and keys, Linux's CPU", async () => {
  for (const [os, words] of [
    ["windows", WINDOWS_HIGH_RESOLUTION_WORDS],
    ["linux", HIGH_RESOLUTION_WORDS],
  ] as const) {
    const { handlers } = server([desktopBox({ os, kind: os === "windows" ? "windows-desktop" : "linux-desktop-cpu" })], { sharp: false });
    const slot = desktopTab(handlers);
    const display = within(await openDisplay(await slot.findByRole("button", { name: "Desktop actions" })));
    const item = display.getByRole("menuitemcheckbox", { name: /High resolution/ });
    expect(document.getElementById(item.getAttribute("aria-describedby")!)?.textContent).toBe(words);
    cleanup();
  }
  expect(WINDOWS_HIGH_RESOLUTION_WORDS).toMatch(/half the frame rate, and keys about 85 ms, while on; more cores do not help/);
});

test("through a High resolution switch, the video holds its last picture until the desktop has its new size and has drawn at its new scale, here or in another tab (the owner's note of 18 October 2026)", async () => {
  const undo = withVideo();
  try {
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const switching = { on: false };
    const { handlers } = server([desktopBox()], { video: true, sharp: false, switching });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    const screen = slot.getByTestId("desktop-screen");
    const pictures = () => screen.querySelectorAll("canvas").length;
    expect(pictures()).toBe(1);

    // Another tab switches it: this one holds its picture over the video while the box changes, and through the new size's first frames.
    switching.on = true;
    await slot.behavior.emitRealtime("changed", { threadId: THREAD });
    await waitFor(() => expect(pictures()).toBe(2));
    FakeDecoder.size = { width: 2560, height: 1600 };
    act(() => void socket.onmessage?.({ data: videoFrame(6, true) }));
    switching.on = false;
    await slot.behavior.emitRealtime("changed", { threadId: THREAD });
    await new Promise((resolve) => setTimeout(resolve, HOLD_SETTLE_MS / 2));
    expect(pictures()).toBe(2);
    // Once the desktop has had time to draw at its new scale, the new picture shows.
    await waitFor(() => expect(pictures()).toBe(1), { timeout: HOLD_SETTLE_MS * 2 });

    // Asked here, it holds at once; a switch whose new size never comes lets go soon after it ends, so the view never freezes.
    fireEvent.click(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: /High resolution/ }));
    expect(pictures()).toBe(2);
    await waitFor(() => expect(pictures()).toBe(1), { timeout: HOLD_NO_SIZE_MS * 2 });
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("as a desktop in your control takes the tab's new size, the video holds its last picture, stretched to the tab, until a frame of the new size comes (the owner's note of 18 October 2026)", async () => {
  const undo = withVideo();
  const size = FakeDecoder.size;
  try {
    FakeDecoder.size = { width: 800, height: 800 };
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const screen = slot.getByTestId("desktop-screen");
    const video = screen.querySelector("canvas")!.parentElement!;
    const observer = FakeObserver.made.find((made) => made.targets.includes(video))!;
    const pictures = () => Array.from(screen.querySelectorAll("canvas"));
    const tab = (width: number, height: number) => {
      Object.defineProperty(video, "clientWidth", { value: width, configurable: true });
      Object.defineProperty(video, "clientHeight", { value: height, configurable: true });
      act(() => observer.resize(width, height));
    };
    tab(740, 800);

    // Expand: the picture shown is held over the video, filling the tab, not left at its old size in the middle.
    tab(1840, 800);
    await waitFor(() => expect(socket.sent).toContain("r,1840x800"));
    expect(pictures()).toHaveLength(2);
    expect(pictures()[1]!.style.objectFit).toBe("fill");
    // Frames of the old size, as Selkies may send while the desktop changes, stay under it.
    act(() => void socket.onmessage?.({ data: videoFrame(6, true) }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pictures()).toHaveLength(2);
    // The first frame of the new size shows at once.
    FakeDecoder.size = { width: 1840, height: 800 };
    act(() => void socket.onmessage?.({ data: videoFrame(7, true) }));
    await waitFor(() => expect(pictures()).toHaveLength(1));

    // A tab whose size the desktop has already, once made a multiple of 8 wide, holds nothing.
    tab(1845, 801);
    await waitFor(() => expect(socket.sent).toContain("r,1845x801"));
    expect(pictures()).toHaveLength(1);

    // A size that never comes, as one below the desktop's smallest, lets go soon, so the view never freezes.
    tab(700, 800);
    await waitFor(() => expect(socket.sent).toContain("r,700x800"));
    expect(pictures()).toHaveLength(2);
    await waitFor(() => expect(pictures()).toHaveLength(1), { timeout: HOLD_NO_SIZE_MS * 2 });
  } finally {
    FakeDecoder.size = size;
    undo();
    window.sessionStorage.clear();
  }
});

test("a person watching a Wayland desktop with bb-box-cursor sees the box's pointer drawn over the video, where bb-box says it is, scaled with the picture; the person in control does not (060)", async () => {
  const undo = withVideo();
  const size = FakeDecoder.size;
  try {
    FakeDecoder.size = { width: 1920, height: 1080 };
    window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
    const { handlers } = server([desktopBox()], { video: true });
    const slot = desktopTab(handlers);
    await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
    const socket = videoSocket();
    act(() => socket.open());
    act(() => void socket.onmessage?.({ data: "MODE websockets" }));
    act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
    await slot.findByText("The agent has control.");
    const screen = slot.getByTestId("desktop-screen");
    const video = screen.querySelector("canvas")!.parentElement!;
    // The pane, half the desktop's size: the picture fills it at half scale.
    Object.defineProperty(video, "clientWidth", { value: 960, configurable: true });
    Object.defineProperty(video, "clientHeight", { value: 540, configurable: true });
    const drawn = () => video.querySelector("img");
    // The box's cursor, a PNG of 2 by 1 with its hotspot at (1, 0), then where the pointer is.
    const png = rgbaPng(2, 1, Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0])).toString("base64");
    act(() => void socket.onmessage?.({ data: `cursor,${JSON.stringify({ curdata: png, hotx: 1, hoty: 0 })}` }));
    act(() => void socket.onmessage?.({ data: "BB_POINTER,640,360" }));
    await waitFor(() => expect(drawn()?.style.display).toBe("block"));
    const style = drawn()!.style;
    expect([style.left, style.top, style.width, style.height]).toEqual(["319.5px", "180px", "1px", "0.5px"]);
    expect(drawn()!.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
    // It moves as the box's pointer does, and goes when it leaves the desktop.
    act(() => void socket.onmessage?.({ data: "BB_POINTER,1001,1" }));
    expect([drawn()!.style.left, drawn()!.style.top]).toEqual(["500px", "0.5px"]);
    act(() => void socket.onmessage?.({ data: "BB_POINTER," }));
    expect(drawn()!.style.display).toBe("none");
    // The person in control has their own pointer, in the box's shape: none is drawn for them.
    act(() => void socket.onmessage?.({ data: "BB_POINTER,640,360" }));
    expect(drawn()!.style.display).toBe("block");
    fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    await waitFor(() => expect(drawn()!.style.display).toBe("none"));
    act(() => void socket.onmessage?.({ data: "BB_POINTER,700,360" }));
    expect(drawn()!.style.display).toBe("none");
  } finally {
    FakeDecoder.size = size;
    undo();
    window.sessionStorage.clear();
  }
});

test("a person watching a Wayland desktop with bb-box-cursor over VNC sees the box's pointer drawn over the picture, from a pointer stream of its own, which a desktop without the helper ends for good (060)", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  const rfb = novnc.FakeRfb.made[0]!;
  // noVNC's canvas, the desktop's 1920 by 1080 pixels fitted at half scale, 60 px down the pane.
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  rfb.target.appendChild(canvas);
  const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => null }) as DOMRect;
  rfb.target.getBoundingClientRect = rect(0, 0, 960, 660);
  canvas.getBoundingClientRect = rect(0, 60, 960, 540);
  act(() => void rfb.dispatchEvent(new Event("connect")));
  const stream = await waitFor(() => {
    const made = FakeSocket.made.find((each) => each.url.endsWith("&stream=pointer"));
    expect(made).toBeTruthy();
    return made!;
  });
  expect(stream.url).toBe(`${rfb.url}&stream=pointer`);
  act(() => stream.open());
  const png = rgbaPng(2, 1, Uint8Array.from([255, 0, 0, 255, 0, 0, 0, 0])).toString("base64");
  act(() => void stream.onmessage?.({ data: `cursor,${JSON.stringify({ curdata: png, hotx: 1, hoty: 0 })}` }));
  act(() => void stream.onmessage?.({ data: "BB_POINTER,640,360" }));
  const drawn = () => rfb.target.querySelector("img");
  await waitFor(() => expect(drawn()?.style.display).toBe("block"));
  expect([drawn()!.style.left, drawn()!.style.top, drawn()!.style.width, drawn()!.style.height]).toEqual(["319.5px", "240px", "1px", "0.5px"]);
  // The person in control has their own pointer, in the box's shape from wayvnc: none is drawn for them.
  fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  await waitFor(() => expect(drawn()!.style.display).toBe("none"));

  // A desktop whose image has no helper ends the stream at once, saying so: the next connection opens none.
  const before = FakeSocket.made.length;
  act(() => stream.end(1000, "This desktop's pointer comes with its picture."));
  act(() => void rfb.dispatchEvent(new Event("disconnect")));
  await waitFor(() => expect(novnc.FakeRfb.made.length).toBeGreaterThan(1), { timeout: 5000 });
  act(() => void novnc.FakeRfb.made.at(-1)!.dispatchEvent(new Event("connect")));
  expect(FakeSocket.made.slice(before).some((each) => each.url.endsWith("&stream=pointer"))).toBe(false);
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

test("a hidden video session closes its decoder, which holds a decoder of the browser's while nothing shows, and makes a new one as it shows again", async () => {
  const undo = withVideo();
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    await decodesMacroblocks();
    socket.onmessage?.({ data: videoFrame(0, true) });
    const shown = FakeDecoder.made.at(-1)!;
    expect(shown.state).toBe("configured");

    socket.sent.length = 0;
    session.hidden = true;
    expect(socket.sent).toEqual(["STOP_VIDEO"]);
    expect(shown.state).toBe("closed");
    const made = FakeDecoder.made.length;
    socket.onmessage?.({ data: videoFrame(1, false) });
    expect(FakeDecoder.made).toHaveLength(made);
    expect(FakeDecoder.thrown).toEqual([]);

    socket.sent.length = 0;
    session.hidden = false;
    expect(socket.sent.slice(-2)).toEqual(["START_VIDEO", "REQUEST_KEYFRAME"]);
    expect(FakeDecoder.made).toHaveLength(made + 1);
    socket.onmessage?.({ data: videoFrame(0, true) });
    expect(FakeDecoder.made.at(-1)!.chunks).toEqual([{ type: "key", timestamp: 0 }]);
    session.dispose();
  } finally {
    undo();
  }
});

test("the video client starts its video again when it stalls, as control is taken and as the window regains focus (the owner's note of 19 October 2026)", async () => {
  const undo = withVideo();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    // What this browser decodes, asked as the socket opens.
    await decodesMacroblocks();
    let id = 0;
    const frames = (ms: number) => {
      for (let at = 0; at < ms; at += 100) {
        socket.onmessage?.({ data: videoFrame(id, id === 0) });
        id++;
        act(() => vi.advanceTimersByTime(100));
      }
    };
    const restarts = () => socket.sent.filter((sent) => sent === "REQUEST_KEYFRAME").length;
    frames(5_000);
    expect(session.connection.state).toBe("connected");
    // Frames that come and show: the video is left alone.
    expect(restarts()).toBe(0);

    // Control taken: the video starts again, from a key frame, with a new decoder, and the viewer says which frame came last.
    socket.sent.length = 0;
    const decoders = FakeDecoder.made.length;
    session.setControl(true, true);
    expect(socket.sent).toEqual([`CLIENT_FRAME_ACK ${id - 1} 0`, "START_VIDEO", "REQUEST_KEYFRAME"]);
    expect(FakeDecoder.made.length).toBe(decoders + 1);
    id = 0;
    frames(1_000);

    // Frames come but the decoder shows none, with no error: after STALL_MS the video starts again; then not again within RESTART_GAP_MS.
    FakeDecoder.silent = true;
    socket.sent.length = 0;
    // Within RESTART_GAP_MS of the last start it waits; then starts again.
    frames(RESTART_GAP_MS - 1_000 - 200);
    expect(restarts()).toBe(0);
    frames(1_000);
    expect(restarts()).toBe(1);
    frames(RESTART_GAP_MS - 1_000);
    expect(restarts()).toBe(1);
    FakeDecoder.silent = false;
    id = 0;
    frames(1_000);

    // Input goes and no frame comes back: after STALL_MS the video starts again.
    act(() => vi.advanceTimersByTime(RESTART_GAP_MS));
    socket.sent.length = 0;
    session.element.querySelector("canvas")!.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    expect(socket.sent.some((sent) => typeof sent === "string" && sent.startsWith("m,"))).toBe(true);
    act(() => vi.advanceTimersByTime(STALL_MS - 1_000));
    expect(restarts()).toBe(0);
    // The watch looks each second.
    act(() => vi.advanceTimersByTime(2_000));
    expect(restarts()).toBe(1);

    // The window regains focus: the video starts again, once in RESTART_GAP_MS.
    id = 0;
    frames(RESTART_GAP_MS);
    socket.sent.length = 0;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    expect(restarts()).toBe(1);

    // Disposed: no watch, no focus.
    session.dispose();
    act(() => vi.advanceTimersByTime(RESTART_GAP_MS));
    window.dispatchEvent(new Event("focus"));
    expect(restarts()).toBe(1);
  } finally {
    vi.useRealTimers();
    undo();
  }
});

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
  expect(await mine.findByText("You have control.")).toBeTruthy();

  takenFrom = viewer;
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  await other.behavior.emitRealtime("changed", { threadId: THREAD });
  expect(await mine.findByText("The agent took control.")).toBeTruthy();
  expect([client!.viewOnly, client!.resizeSession]).toEqual([true, false]);
  expect(mine.queryByTestId("control-ring")).toBeNull();
  expect(await theirs.findByText("The agent has control.")).toBeTruthy();
  expect(theirs.getByRole("button", { name: "Take control" })).toBeTruthy();

  fireEvent.click(mine.getByRole("button", { name: "Take control again" }));
  expect(await mine.findByText("You have control.")).toBeTruthy();
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

test("a desktop tab that BB moves to another place in one commit, as at the phone breakpoint, keeps its viewer, its connection and its control", async () => {
  const { handlers, changes } = server([desktopBox()]);
  const Desktop = app.threadPanelActions.find((candidate) => candidate.id === "desktop")!.component as ComponentType<{ threadId: string; params: { box: string } }>;
  let turn!: () => void;
  function Layout(props: { threadId: string; params: { box: string } }) {
    const [wide, setWide] = useState(true);
    turn = () => setWide((now) => !now);
    return wide ? (
      <div data-layout="wide">
        <Desktop {...props} />
      </div>
    ) : (
      <section data-layout="phone">
        <Desktop {...props} />
      </section>
    );
  }
  const slot = renderSlot({ component: Layout }, { threadId: THREAD, params: { box: "box_2" } }, { rpc: handlers, pluginId: "bb-box" });
  await slot.findByText("Connecting to the desktop…");
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText("You have control.");

  for (const layout of ["phone", "wide"]) {
    act(() => turn());
    expect(slot.container.querySelector(`[data-layout="${layout}"]`)!.contains(client!.target)).toBe(true);
    expect(slot.getByText("You have control.")).toBeTruthy();
  }
  vi.useFakeTimers();
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS + 50);
  vi.useRealTimers();
  expect(novnc.FakeRfb.made).toHaveLength(1);
  expect(client!.disconnected).toBe(false);
  expect(changes).toEqual(["takeControl box_2"]);
  expect(slot.getByText("You have control.")).toBeTruthy();
});

test("a hidden desktop tab keeps its stream, hands control back after a minute, and closes after ten", async () => {
  const { handlers, changes } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await slot.findByText("Connecting to the desktop…");
  const [client] = novnc.FakeRfb.made;
  act(() => void client!.dispatchEvent(new Event("connect")));
  fireEvent.click(slot.getByRole("button", { name: "Take control" }));
  await slot.findByText("You have control.");

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
  await back.findByText("You have control.");
  vi.useFakeTimers();
  back.unmount();
  vi.advanceTimersByTime(HAND_BACK_MS / 2);
  const returned = desktopTab(handlers);
  // The tab's state loads over promises; give the fake clock a few turns before the minute runs out.
  for (let turn = 0; turn < 5; turn++) await act(() => vi.advanceTimersByTimeAsync(5));
  expect(returned.getByText("You have control.")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS);
  expect(changes).toEqual(["takeControl box_2", "handBack box_2", "takeControl box_2"]);
  expect(novnc.FakeRfb.made).toHaveLength(2);
  returned.unmount();
});

test("a paste in one of a tab's sessions holds the keys typed in another until its chord has gone, though the session goes meanwhile (#933)", () => {
  vi.useFakeTimers();
  try {
    const sent: string[] = [];
    const video = new KeysAfterPaste<string>((key) => sent.push(`video ${key}`));
    const vnc = new KeysAfterPaste<string>((key) => sent.push(`vnc ${key}`));
    const elsewhere = new KeysAfterPaste<string>((key) => sent.push(`elsewhere ${key}`));
    video.join("box_2:viewer-one");
    vnc.join("box_2:viewer-one");
    elsewhere.join("box_9:viewer-two");
    video.hold();
    expect(vnc.keep("a")).toBe(true);
    expect(elsewhere.keep("z")).toBe(false);
    // The video session goes, as the stream switches, having sent its chord: the tab's keys wait for the paste to land.
    video.releaseIn(PASTE_LANDS_MS);
    video.close();
    expect(vnc.keep("b")).toBe(true);
    vi.advanceTimersByTime(PASTE_LANDS_MS);
    expect(sent).toEqual(["vnc a", "vnc b"]);
    expect(vnc.keep("c")).toBe(false);
    vnc.close();
    elsewhere.close();
  } finally {
    vi.useRealTimers();
  }
});

test("keys typed while a paste is on its way wait for it, at most PASTE_HOLD_MS, and go in order; with none pending they go at once (#915)", () => {
  vi.useFakeTimers();
  try {
    const sent: string[] = [];
    const keys = new KeysAfterPaste<string>((key) => sent.push(key));
    expect(keys.keep("a")).toBe(false);
    keys.hold();
    expect([keys.keep("b"), keys.keep("c")]).toEqual([true, true]);
    keys.release();
    expect(sent).toEqual(["b", "c"]);
    keys.hold();
    keys.keep("d");
    vi.advanceTimersByTime(PASTE_HOLD_MS - 1);
    expect(sent).toEqual(["b", "c"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["b", "c", "d"]);
    keys.hold();
    keys.keep("e");
    keys.drop();
    vi.advanceTimersByTime(PASTE_HOLD_MS);
    expect(sent).toEqual(["b", "c", "d"]);
    // Once the chord has gone, they go after the paste has had time to land.
    keys.hold();
    keys.keep("f");
    keys.releaseIn(PASTE_LANDS_MS);
    vi.advanceTimersByTime(PASTE_LANDS_MS - 1);
    expect(sent).toEqual(["b", "c", "d"]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(["b", "c", "d", "f"]);
  } finally {
    vi.useRealTimers();
  }
});

test("a reconnect waits 1 s, doubling to MAX_RETRY_MS, and up to a quarter more at random, so pages that lose the plugin together do not retry in step", () => {
  expect([0, 1, 2, 3, 4, 5].map((failures) => retryWait(failures, () => 0))).toEqual([1000, 2000, 4000, 8000, MAX_RETRY_MS, MAX_RETRY_MS]);
  expect([0, 1, 4].map((failures) => retryWait(failures, () => 1))).toEqual([1250, 2500, MAX_RETRY_MS * 1.25]);
  expect(retryWait(2, () => 0.5)).toBe(4500);
});

test("both viewers wait with jitter before they reconnect", async () => {
  const undo = withVideo();
  const random = vi.spyOn(Math, "random").mockReturnValue(1);
  try {
    const session = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    const socket = FakeSocket.made.at(-1)!;
    act(() => socket.open());
    socket.onmessage?.({ data: videoFrame(0, true) });
    await decodesMacroblocks();
    socket.onclose?.({ code: 1012, reason: "Plugin reloaded" });
    expect(session.connection).toMatchObject({ state: "disconnected", retryMs: 1250 });
    session.dispose();
  } finally {
    random.mockRestore();
    undo();
  }
  const random2 = vi.spyOn(Math, "random").mockReturnValue(1);
  try {
    const vnc = new DesktopSession("ws://bb/desktop?box=box_2&viewer=v");
    act(() => void novnc.FakeRfb.made.at(-1)!.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } })));
    expect(vnc.connection).toMatchObject({ state: "disconnected", retryMs: 1250 });
    vnc.dispose();
  } finally {
    random2.mockRestore();
  }
});

test("both viewers leave the area around the picture to the pane, in the theme's neutral, not noVNC's dark grey (#916)", () => {
  const undo = withVideo();
  try {
    const video = new SelkiesSession("ws://bb/desktop?box=box_2&viewer=v&stream=selkies");
    expect(video.element.style.background).toBe("transparent");
    video.dispose();
  } finally {
    undo();
  }
  const vnc = new DesktopSession("ws://bb/desktop?box=box_2&viewer=v");
  expect((novnc.FakeRfb.made.at(-1) as unknown as { background: string }).background).toBe("transparent");
  vnc.dispose();
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
  expect(slot.getByText(/^Trying again in [12] s$/)).toBeTruthy();
  expect(slot.getByText("Disconnected")).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Reconnect now" }));
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(2));
});

test("a desktop tab's note counts down to its next try, rather than show the same number throughout (#916)", async () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    const { handlers } = server([desktopBox()]);
    const slot = desktopTab(handlers);
    await slot.findByText("Connecting to the desktop…");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // Three ends in a row: the waits are 1 s, 2 s and then 4 s.
    for (let end = 0; end < 3; end++) {
      act(() => void novnc.FakeRfb.made.at(-1)!.dispatchEvent(new CustomEvent("disconnect", { detail: { clean: false } })));
      if (end < 2) act(() => vi.advanceTimersByTime(1000 * 2 ** end));
    }
    expect(slot.getByText("Trying again in 4 s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(slot.getByText("Trying again in 3 s")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(slot.getByText("Trying again in 1 s")).toBeTruthy();
  } finally {
    vi.useRealTimers();
    random.mockRestore();
  }
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
  expect(await gone.findByText(/has been released\.$/)).toBeTruthy();
  expect(gone.getByText("Released")).toBeTruthy();
});

test("a desktop tab whose box is released while it is open says Released, keeps the box's name, and offers nothing that needs the box", async () => {
  const { handlers } = server([desktopBox()]);
  const slot = desktopTab(handlers);
  await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
  act(() => void novnc.FakeRfb.made[0]!.dispatchEvent(new Event("connect")));
  expect(await slot.findByRole("button", { name: "Take control" })).toBeTruthy();
  // The thread's agent releases the box.
  await handlers.release!({ threadId: THREAD, box: "box_2" } as never);
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  expect(await slot.findByText("bold-heron has been released.")).toBeTruthy();
  expect(slot.getByText("Close this tab when you are done with it.")).toBeTruthy();
  expect(slot.getByText("Released")).toBeTruthy();
  expect(slot.getAllByText("bold-heron").length).toBeGreaterThan(0);
  expect(slot.queryByText("Loading…")).toBeNull();
  expect(slot.queryByRole("button", { name: "Take control" })).toBeNull();
  expect(slot.queryByRole("button", { name: "Desktop actions" })).toBeNull();
});

test("a desktop tab whose box is gone or failed says so, with no Take control and no desktop items in its menu", async () => {
  for (const [state, words] of [
    ["gone", "Gone"],
    ["failed", "Failed"],
  ] as const) {
    const slot = desktopTab(server([desktopBox({ state, ...(state === "failed" ? { error: "it did not start" } : {}) })]).handlers);
    expect(await slot.findByText(words)).toBeTruthy();
    expect(slot.queryByText("Loading…")).toBeNull();
    expect(slot.queryByRole("button", { name: "Take control" })).toBeNull();
    const menu = await openMenu(slot.getByRole("button", { name: "Desktop actions" }));
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["Open in browser"]);
    cleanup();
    dropAllKept();
  }
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
  expect(many.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop · bold-heron", params: { box: "box_2" } } }]);
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
  cleanup();

  await handlers.release!({ threadId: "thr_panel", box: "box_2" } as never);
  for (const subPath of ["thr_panel/box_2", "thr_panel/box_2/terminal"]) {
    const gone = renderSlot(page!, { subPath }, { rpc: handlers, pluginId: "bb-box" });
    expect(await gone.findByText(/has been released\.$/)).toBeTruthy();
    expect(gone.queryByText("Close this tab when you are done with it.")).toBeNull();
    const backs = gone.getAllByRole("button", { name: "Back to boxes" });
    expect(backs).toHaveLength(2);
    fireEvent.click(backs[1]!);
    expect(gone.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "desktop", options: { subPath: "" } });
    cleanup();
  }
});

function terminalTab(handlers: PluginRpcTestHandlers<Contract>, boxId = "box_1") {
  const action = app.threadPanelActions.find((candidate) => candidate.id === "terminal");
  return renderSlot(action!, { threadId: THREAD, params: { box: boxId } }, { rpc: handlers, pluginId: "bb-box" });
}

test("a terminal tab whose box is released while it is open names the box and says to close the tab, as the desktop's does (#916)", async () => {
  const { handlers } = server([box()]);
  const slot = terminalTab(handlers);
  await waitFor(() => expect(FakeSocket.made).toHaveLength(1));
  await handlers.release!({ threadId: THREAD, box: "box_1" } as never);
  await slot.behavior.emitRealtime("changed", { threadId: THREAD });
  expect(await slot.findByText("calm-otter has been released.")).toBeTruthy();
  expect(slot.getByText("Close this tab when you are done with it.")).toBeTruthy();
  // Its header says so too, with the box's name, not "Connecting…".
  expect(slot.getByText("Released")).toBeTruthy();
  expect(slot.queryByText("Connecting…")).toBeNull();
  expect(slot.getAllByText("calm-otter").length).toBeGreaterThan(0);
});

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

test("a terminal tab for a box the panel lists as ready connects at once, without waiting for the box's state (#916)", async () => {
  const { handlers } = server([box({ id: "box_4", name: "quick-fox" })]);
  const listing = panel(handlers);
  expect(await listing.findByText("quick-fox")).toBeTruthy();
  listing.unmount();
  let answer!: () => void;
  const slow: PluginRpcTestHandlers<Contract> = {
    ...handlers,
    desktop: (input) => new Promise<DesktopState>((resolve) => (answer = () => resolve(handlers.desktop!(input) as DesktopState))),
  };
  const tab = terminalTab(slow, "box_4");
  await waitFor(() => expect(FakeSocket.made).toHaveLength(1));
  expect(answer).toBeTypeOf("function");
  expect(new URL(FakeSocket.made[0]!.url).pathname).toBe(TERMINAL_PATH);
  act(() => FakeSocket.made[0]!.open());
  expect(tab.getByText("Connected")).toBeTruthy();
  answer();
  await waitFor(() => expect(tab.getByText("Connected")).toBeTruthy());
  expect(FakeSocket.made).toHaveLength(1);
});

test("a terminal draws with WebGL, and with xterm's DOM renderer where WebGL is missing or its context is lost", async () => {
  const { handlers } = server([box(), box({ id: "box_2", name: "bold-heron" })]);
  terminalTab(handlers);
  await waitFor(() => expect(xterm.FakeTerminal.made).toHaveLength(1));
  const webgl = xterm.FakeTerminal.made[0]!.addons.find((addon) => addon instanceof xterm.FakeWebgl) as InstanceType<typeof xterm.FakeWebgl>;
  expect(webgl).toBeTruthy();
  webgl.lose!();
  expect(webgl.disposed, "a lost context gives the terminal back to the DOM renderer").toBe(true);

  xterm.FakeWebgl.missing = true;
  try {
    terminalTab(handlers, "box_2");
    await waitFor(() => expect(xterm.FakeTerminal.made).toHaveLength(2));
    expect(xterm.FakeTerminal.made[1]!.addons.some((addon) => addon instanceof xterm.FakeWebgl)).toBe(false);
    await waitFor(() => expect(FakeSocket.made).toHaveLength(2));
  } finally {
    xterm.FakeWebgl.missing = false;
  }
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
  const chips = within(slot.getByRole("list", { name: "Threads on this box" }));
  expect(chips.getAllByRole("button").map((chip) => [chip.textContent, chip.getAttribute("title"), !!within(chip).queryByLabelText("Working")])).toEqual([
    ["Fix the login form", "Fix the login form", true],
    ["Docs pass", "Docs pass", false],
    ["+1 more", null, false],
  ]);
  fireEvent.click(chips.getByRole("button", { name: /Docs pass/ }));
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_b" });
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
  expect(screen.getByText("A thread is working on it, and would lose its machine.")).toBeTruthy();
  expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: /Fix the login form/ })).toBeTruthy();
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

test("the Boxes page's New box and settings' Add machine offer a desktop whose image is not built yet, as the Box panel does, and build it for a machine with its name", async () => {
  const desktop: KindView = { ...KINDS[1]!, id: "linux-desktop-cpu", gpu: false, windowing: "x11" };
  const onDemand = { hostId: "host_bb", name: "devpc", kinds: [{ kind: desktop, took: null }] };
  for (const [where, open, submit] of [
    ["the Boxes page", (handlers: PluginRpcTestHandlers<Contract>) => boxesPage(handlers).findByRole("button", { name: "New box" }), "Build and create"],
    ["settings", (handlers: PluginRpcTestHandlers<Contract>) => settings(handlers).findByRole("button", { name: "Add machine" }), "Build and add"],
  ] as const) {
    const { handlers, changes } = server([], { kinds: [KINDS[0]!], desktopOnDemand: onDemand });
    fireEvent.click(await open(handlers));
    const types = await screen.findByRole("radiogroup", { name: "Type" });
    fireEvent.click(within(types).getByRole("radio", { name: /^Desktop/ }));
    expect(screen.getByText("BB Box builds the desktop image on devpc first, usually 4 to 10 min, then makes the box."), where).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "desk-1" } });
    fireEvent.click(screen.getByRole("button", { name: submit }));
    await waitFor(() => expect(changes, where).toEqual(["setup.desktop host_bb for operator named desk-1"]));
    cleanup();
  }
});

test("the Boxes page shows a desktop image's build while it runs, as the Box panel and settings do", async () => {
  const building = setup({ state: "on", build: { state: "building", targets: ["desktop"], detail: null, step: { at: 3, of: 9 }, startedAt: Date.now() - 125_000, endedAt: null } });
  const list = boxesPage(server([], { setups: [building] }).handlers);
  expect(await list.findByText("Building the desktop image on this machine")).toBeTruthy();
  expect(list.getByText("Step 3 of 9")).toBeTruthy();
});

test("a desktop machine not made after its image was built says why on the Boxes page, once", async () => {
  const list = boxesPage(server([], { desktopProblem: { message: "The desktop image is built, but the box was not made: no room", at: 1 } }).handlers);
  expect(await list.findByText("The desktop image is built, but the box was not made: no room")).toBeTruthy();
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
  expect(within(dialog).getByText("A thread is working on it, and would lose its machine.")).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: /Build the app/ })).toBeTruthy();
  expect(changes).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Release anyway" }));
  await waitFor(() => expect(changes).toEqual(["release (forced) box_1"]));
  expect(list.inspection.rpcCalls.filter((call) => call.method === "release").at(-1)?.input).toEqual({ threadId: THREAD, box: "box_1", force: true });
});

test("settings' Machines resize one of your machines through machines.resize (061)", async () => {
  const resize = fakeResizer({ cores: 2, memoryGiB: 4, diskGiB: 20 }, { ways: { cores: "live", memory: "live", disk: "live" }, machine: "BB's daemon on machine build-1 is restarting, so BB counts its 4 processors." });
  const { handlers, changes } = server([], { machines: [machine({ sizeNow: size(2, 4, 20), resizing: { cores: "live", memory: "live", disk: "live", shrinks: true } }, [])], resize });
  const slot = settings(handlers);
  const menu = await openMenu(await slot.findByRole("button", { name: "build-1 actions" }));
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Resize…" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Resize build-1")).toBeTruthy();
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Cores" }), { target: { value: "4" } });
  await within(dialog).findByRole("list", { name: "What changes" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Resize" }));
  expect(await within(dialog).findByText("BB's daemon on machine build-1 is restarting, so BB counts its 4 processors.")).toBeTruthy();
  expect(changes.filter((change) => !change.includes('"check":true'))).toEqual(['machines.resize box_m1 {"size":{"cores":4}}']);
});

test("a machine's threads show as up to 3 chips, working first, then the latest, and +N more lists them all, searchable when long; each opens its thread", async () => {
  const threads: ThreadOnBox[] = Array.from({ length: 12 }, (_, index) => ({ id: `thr_${index}`, title: `Thread number ${index}`, running: false, activeAt: 1_000 + index }));
  threads[2] = { id: "thr_2", title: "Replying to this earlier message in the conversation: > Check the release notes", running: true, activeAt: 10 };
  threads[5] = { id: "thr_5", title: null, running: false, activeAt: 2_000 };
  const { handlers } = server([], { machines: [machine({}, threads)] });
  const list = boxesPage(handlers);
  const chips = within(await list.findByRole("list", { name: "Threads on this box" }));
  expect(chips.getAllByRole("button").map((chip) => chip.textContent)).toEqual(["Check the release notes", "thr_5", "Thread number 11", "+11 more", "+9 more"]);
  const where = (text: string) => chips.getAllByRole("button").find((chip) => chip.textContent === text)!.closest("[role=listitem], span.flex")!.className;
  expect(where("Check the release notes")).not.toMatch(/@(max-)?md:hidden/);
  expect(["thr_5", "Thread number 11", "+9 more"].map(where)).toEqual(Array(3).fill(expect.stringContaining("@max-md:hidden")));
  expect(where("+11 more")).toContain("@md:hidden");
  fireEvent.click(chips.getByRole("button", { name: "9 more threads" }));
  const search = await screen.findByRole("textbox", { name: "Search threads" });
  const all = () => within(screen.getByRole("list", { name: "All threads on this box" })).getAllByRole("button");
  expect(all()).toHaveLength(12);
  fireEvent.change(search, { target: { value: "number 1" } });
  const found = all();
  expect(found.map((button) => button.textContent)).toEqual(["Thread number 11", "Thread number 10", "Thread number 1"]);
  fireEvent.click(found[2]!);
  expect(list.inspection.navigateCalls.at(-1)).toEqual({ method: "toThread", threadId: "thr_1" });
});

test("the Boxes page's Machines have settings' rows and warnings: Stop, Start and Remove, each asking when threads work there", async () => {
  const { handlers, changes } = server([], { machines: [machine(), machine({ id: "box_m2", name: "scratch", desktop: false, display: null, state: "stopped" }, [])] });
  const list = boxesPage(handlers);
  expect(await list.findByText("Machines")).toBeTruthy();
  expect(list.getAllByRole("button", { name: /Fix the login form/ })).toHaveLength(1);
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




test("the Boxes page's search matches a box's name, kind, provider and thread; its filters tick tags, providers and states; its sort orders by name or age", () => {
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
  expect(names(shown(rows, "", { ...NO_FILTERS, has: ["Desktop"], states: ["Ready"] }, byName))).toEqual(["bold-heron"]);
  expect(names(shown(rows, "", { ...NO_FILTERS, providers: ["Proxmox LXC on pve"] }, byName))).toEqual(["bold-heron"]);
  // The sort: name either way, or age, oldest first when ascending.
  expect(names(shown(rows, "", NO_FILTERS, { key: "name", ascending: false }))).toEqual(["still-pond", "quiet-fern", "calm-otter", "bold-heron"]);
  expect(names(shown(rows, "", NO_FILTERS, { key: "created", ascending: true }))).toEqual(["bold-heron", "still-pond", "calm-otter", "quiet-fern"]);
  // The filters offer what is listed, each once; the states in a fixed order.
  expect(choices(rows.map((row) => row.box))).toEqual({ systems: ["Linux"], forms: ["Container"], has: ["Desktop", "GPU"], providers: ["Fake host", "Proxmox LXC on pve"], states: ["Ready", "Starting", "Stopped"] });
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
  let menu = await openMenu(list.getByRole("button", { name: "Filters" }));
  expect(within(menu).getAllByText(/^(System|Tags|Provider|State)$/).map((node) => node.textContent)).toEqual(["System", "Tags", "Provider", "State"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /^Stopped/ }));
  expect(rowNames()).toEqual(["swift-fox"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: /^Stopped/ }));
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

function tagged(id: string, name: string, facts: Partial<BoxView>): BoxView {
  return box({ id, name, ...facts });
}

const TAGGED = [
  tagged("box_t1", "linux-vm", { os: "linux", form: "VM", backendLabel: "Proxmox QEMU on pve", provider: "Proxmox", requires: ["kvm"] }),
  tagged("box_t2", "linux-lxc", { os: "linux", form: "LXC", backendLabel: "Proxmox LXC on pve", provider: "Proxmox", desktop: true }),
  tagged("box_t3", "pool-mac", { os: "macos", form: "Physical", arch: "arm64", backendLabel: "SSH host pool", provider: "SSH pool", desktop: true }),
  tagged("box_t4", "tart-mac", { os: "macos", form: "VM", arch: "arm64", backendLabel: "Tart on studio", provider: "Tart" }),
  tagged("box_t5", "win-vm", { os: "windows", form: "VM", backendLabel: "Proxmox QEMU on pve", provider: "Proxmox", desktop: true, extras: [] }),
  tagged("box_t6", "arm-micro", { os: "linux", form: "microVM", arch: "arm64", backendLabel: "microsandbox on studio", provider: "microsandbox" }),
  tagged("box_t7", "cloud-box", { os: "linux", form: "Docker", backendLabel: "Hetzner Cloud", provider: "Hetzner Cloud", gpu: true }),
];

test("the Boxes page's tags come from a box's facts, not its backend's name: system, form, what it has, provider and state", () => {
  expect(TAGGED.map((one) => { const tags = tagsOf(one); return `${one.name}: ${tags.systems.join()} | ${tags.forms.join()} | ${tags.has.join()}`; })).toEqual([
    "linux-vm: Linux | VM | KVM",
    "linux-lxc: Linux | Container | Desktop",
    "pool-mac: macOS | Physical | Desktop,arm64",
    "tart-mac: macOS | VM | arm64",
    "win-vm: Windows | VM | Desktop",
    "arm-micro: Linux | microVM | arm64",
    "cloud-box: Linux | Container | GPU",
  ]);
  expect(choices(TAGGED)).toEqual({
    systems: ["Linux", "macOS", "Windows"],
    forms: ["VM", "Container", "microVM", "Physical"],
    has: ["Desktop", "GPU", "KVM", "arm64"],
    providers: ["Hetzner Cloud", "microsandbox", "Proxmox", "SSH pool", "Tart"],
    states: ["Ready"],
  });
  expect([...splitGroups(TAGGED)]).toEqual(["systems", "forms", "has", "providers"]);
});

test("a Wayland desktop has a Wayland tag beside Desktop, so it reads differently from an X11 desktop of the same backend", () => {
  const x11 = tagged("box_x", "xfce-box", { os: "linux", form: "Docker", kind: "linux-desktop-cpu", desktop: true });
  const wayland = tagged("box_w", "sway-box", { os: "linux", form: "Docker", kind: "linux-desktop-wayland-cpu", desktop: true });
  expect(tagsOf(x11).has).toEqual(["Desktop"]);
  expect(tagsOf(wayland).has).toEqual(["Desktop", "Wayland"]);
  expect(choices([x11, wayland]).has).toEqual(["Desktop", "Wayland"]);
});

test("ticks in one tag group widen (Linux or macOS) and groups together narrow (Linux and VM); each tag counts what ticking it would show", () => {
  const rows = TAGGED.map((one) => ({ box: one, words: [] }));
  const names = (filters: typeof NO_FILTERS) => shown(rows, "", filters, { key: "name", ascending: true }).map((row) => row.box.name);
  expect(names({ ...NO_FILTERS, systems: ["Linux"] })).toEqual(["arm-micro", "cloud-box", "linux-lxc", "linux-vm"]);
  expect(names({ ...NO_FILTERS, systems: ["Linux", "macOS"] })).toEqual(["arm-micro", "cloud-box", "linux-lxc", "linux-vm", "pool-mac", "tart-mac"]);
  expect(names({ ...NO_FILTERS, systems: ["Linux"], forms: ["VM"] })).toEqual(["linux-vm"]);
  expect(names({ ...NO_FILTERS, systems: ["macOS"], forms: ["Physical"] })).toEqual(["pool-mac"]);
  expect(names({ ...NO_FILTERS, forms: ["VM", "microVM"], has: ["arm64"] })).toEqual(["arm-micro", "tart-mac"]);
  expect(names({ ...NO_FILTERS, has: ["Desktop", "GPU"] })).toEqual(["cloud-box", "linux-lxc", "pool-mac", "win-vm"]);
  expect(names({ ...NO_FILTERS, providers: ["Hetzner Cloud"] })).toEqual(["cloud-box"]);
  expect(names({ ...NO_FILTERS, providers: ["Proxmox"] })).toEqual(["linux-lxc", "linux-vm", "win-vm"]);
  expect(names({ ...NO_FILTERS, providers: ["Proxmox"], forms: ["VM"] })).toEqual(["linux-vm", "win-vm"]);

  const none = tagCounts(rows, "", NO_FILTERS);
  expect(none.systems).toEqual({ Linux: 4, macOS: 2, Windows: 1 });
  expect(none.forms).toEqual({ VM: 3, Container: 2, Physical: 1, microVM: 1 });
  expect(none.has).toEqual({ KVM: 1, Desktop: 3, arm64: 3, GPU: 1 });
  const linux = tagCounts(rows, "", { ...NO_FILTERS, systems: ["Linux"] });
  expect(linux.systems).toEqual({ Linux: 4, macOS: 2, Windows: 1 });
  expect(linux.forms).toEqual({ VM: 1, Container: 2, microVM: 1 });
  expect(linux.forms.Physical ?? 0).toBe(0);
  expect(tagCounts(rows, "mac", NO_FILTERS).systems).toEqual({ macOS: 2 });
});

test("on the Boxes page, the Filters menu lists the tags under one Tags heading, without counts, then the providers by type under Provider; greys a tag that would show none, and keeps its ticks across the tabs", async () => {
  const { handlers } = server(TAGGED.slice(0, 4), { machines: [machine({ id: "box_m2", name: "cloud-machine", form: "Docker", backendLabel: "Hetzner Cloud" }, []), machine({ id: "box_m3", name: "vm-machine", form: "VM", backendLabel: "Proxmox QEMU on pve" }, [])] });
  const list = boxesPage(handlers);
  await list.findByText("cloud-machine");
  fireEvent.click(list.getByRole("tab", { name: /^Threads/ }));
  await list.findByText("linux-vm");
  const rowNames = () => list.getAllByRole("button", { name: /: details$/, hidden: true }).map((node) => node.getAttribute("aria-label")!.replace(/: details$/, ""));
  const menu = await openMenu(list.getByRole("button", { name: "Filters" }));
  expect(menu.className).toContain("min-w-56");
  expect(within(menu).getByRole("menuitemcheckbox", { name: "Proxmox" }).className).toContain("whitespace-nowrap");
  expect(within(menu).queryByText(/^(Form|Has)$/)).toBeNull();
  expect(within(menu).getAllByText(/^(System|Tags|Provider|State)$/).map((node) => node.textContent)).toEqual(["System", "Tags", "Provider"]);
  expect(within(menu).queryByRole("menuitem", { name: "Clear filters" })).toBeNull();
  expect(within(menu).getAllByRole("menuitemcheckbox").map((option) => option.textContent)).toEqual([
    "Linux",
    "macOS",
    "VM",
    "Container",
    "Physical",
    "Desktop",
    "KVM",
    "arm64",
    "Proxmox",
    "SSH pool",
    "Tart",
  ]);
  const item = (name: string) => within(menu).getByRole("menuitemcheckbox", { name });
  fireEvent.click(item("Linux"));
  fireEvent.click(item("VM"));
  expect(rowNames()).toEqual(["linux-vm"]);
  expect(item("macOS").getAttribute("aria-disabled")).toBeNull();
  expect(item("Physical").getAttribute("aria-disabled")).toBe("true");
  expect(item("Desktop").getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(item("macOS"));
  expect(rowNames()).toEqual(["linux-vm", "tart-mac"]);
  fireEvent.keyDown(menu, { key: "Escape" });
  fireEvent.click(list.getByRole("tab", { name: /^Machines/ }));
  await waitFor(() => expect(list.queryByText("cloud-machine")).toBeNull());
  expect(list.getByText("vm-machine")).toBeTruthy();
  fireEvent.click(list.getByRole("tab", { name: /^Threads/ }));
  await waitFor(() => expect(rowNames()).toEqual(["linux-vm", "tart-mac"]));
  const again = await openMenu(list.getByRole("button", { name: "Filters" }));
  for (const name of ["Linux", "VM", "macOS"]) fireEvent.click(within(again).getByRole("menuitemcheckbox", { name }));
  await waitFor(() => expect(rowNames()).toHaveLength(4));
  fireEvent.click(within(again).getByRole("menuitemcheckbox", { name: "Proxmox" }));
  await waitFor(() => expect(rowNames()).toEqual(["linux-lxc", "linux-vm"]));
});

test("on the Boxes page, a value every listed box shares is still listed under System, Tags and Provider; State shows only when the states differ", async () => {
  const macs = [
    tagged("box_s1", "mac-one", { os: "macos", form: "VM", arch: "arm64", backendLabel: "Tart on studio", provider: "Tart" }),
    tagged("box_s2", "mac-two", { os: "macos", form: "VM", arch: "arm64", backendLabel: "Tart on studio", provider: "Tart" }),
  ];
  const list = boxesPage(server(macs).handlers);
  await list.findByText("mac-one");
  const menu = await openMenu(list.getByRole("button", { name: "Filters" }));
  expect(within(menu).getAllByText(/^(System|Tags|Provider|State)$/).map((node) => node.textContent)).toEqual(["System", "Tags", "Provider"]);
  expect(within(menu).getAllByRole("menuitemcheckbox").map((option) => option.textContent)).toEqual(["macOS", "VM", "arm64", "Tart"]);
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
  expect(many.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop · build-1", params: { box: "box_m1" } } }]);
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

test("a provider that cannot take the box now is greyed, after the ones that can, says why in place of its free count, and First with room counts only those that can", async () => {
  const pool = { ...POOLED.offers[1]!, free: 0 };
  const cloud = { ...KINDS[0]!.offers[0]!, backend: "namespace", name: "Namespace", type: "namespace", label: "Namespace", hosts: [], form: "VM" as const, typicalReadyMs: null };
  const crowded: KindView = { ...POOLED, offers: [pool, KINDS[0]!.offers[0]!, cloud], forms: ["Physical", "LXC", "VM"] };
  const { handlers, changes } = server([], { kinds: [crowded, KINDS[1]!], rooms: { "ssh-pool": "In use by swift-fox", namespace: "Namespace has 3 of the 3 machines bb-box may have at once" } });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  await waitFor(() =>
    expect(within(providers).getAllByRole("radio").map((option) => `${option.textContent}:${option.getAttribute("aria-disabled") ?? "-"}`)).toEqual([
      "First with roomThe one below:-",
      "pveContainer · usually ~2.2 s:-",
      "SSH host poolPhysical · In use by swift-fox:true",
      "NamespaceVM · Namespace has 3 of the 3 machines bb-box may have at once:true",
    ]),
  );
  fireEvent.click(within(providers).getByRole("radio", { name: /^SSH host pool/ }));
  expect(within(providers).getAllByRole("radio").map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire linux"]));
});

test("the providers are checked at the size chosen, again after it changes: a cloud that refuses the default size takes another", async () => {
  const cloud = { ...KINDS[0]!.offers[0]!, backend: "namespace", name: "Namespace", type: "namespace", label: "Namespace", hosts: [], form: "VM" as const, typicalReadyMs: null };
  const two: KindView = { ...KINDS[0]!, offers: [KINDS[0]!.offers[0]!, cloud], forms: ["LXC", "VM"] };
  const { handlers, changes } = server([], { kinds: [two, KINDS[1]!], rooms: (size): Record<string, string> => (size ? {} : { namespace: "Namespace's workspace allows machines of at most 2 cores" }) });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const providers = await screen.findByRole("radiogroup", { name: "Provider" });
  await waitFor(() => expect(within(providers).getByRole("radio", { name: /^Namespace/ }).getAttribute("aria-disabled")).toBe("true"));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Medium/ }));
  await waitFor(() => expect(within(providers).getByRole("radio", { name: /^Namespace/ }).getAttribute("aria-disabled")).toBeNull());
  expect(within(providers).getByRole("radio", { name: /^Namespace/ }).textContent).toBe("NamespaceVM");
  expect(changes.filter((change) => change.startsWith("rooms"))).toEqual(["rooms linux", 'rooms linux {"preset":"medium"}']);
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
  expect(backendName("microsandbox:mac-mini", "microsandbox on mac-mini")).toBeNull();
  expect(backendName("docker:attic", "Docker")).toBe("attic");
  expect(backendName("microsandbox", "microsandbox on gpu-host")).toBeNull();
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
  const onGpuHost = { ...offer, backend: "docker", type: "docker", label: "Docker", hosts: ["gpu-host"] };
  const msb = { ...offer, backend: "microsandbox", type: "microsandbox", label: "microsandbox", hosts: ["gpu-host"] };
  const all = [offer, onGpuHost, msb];
  expect([providerTitle(onGpuHost, all), providerTitle(msb, all), providerTitle(offer, all)]).toEqual(["gpu-host (Docker)", "gpu-host (microsandbox)", "pve"]);
  const mac: KindView = { ...linux, id: "macos", os: "macos", arch: "arm64", offers: [{ ...offer, backend: "tart", type: "tart", label: "Tart", hosts: ["mac-mini"], hostOs: "macos", gpuRoom: null }] };
  const many: KindView = { ...linux, id: "linux-arm64", arch: "arm64", offers: [offer, { ...offer, backend: "b", hosts: ["pve2"] }, { ...offer, backend: "c", hosts: ["pve3"] }] };
  expect(systemsOf([mac, many, linux]).map((system) => [system.label, system.words])).toEqual([
    ["Linux", "3 providers"],
    ["macOS", "mac-mini"],
  ]);
  const android: KindView = { ...linux, id: "android", devices: { platform: "android", models: ["Pixel 8", "Pixel Fold", "Pixel Tablet"] } };
  expect(systemsOf([linux, android]).map((system) => [system.label, system.device ?? null, system.words])).toEqual([
    ["Linux", null, "pve"],
    ["Android device", "android", "pve"],
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

// The review of 22 October 2026: the paste hold, Shift and the stream switch together.

/** The video tab in control, for the review's tests: its socket, canvas and slot. */
async function videoInControl(handlers: PluginRpcTestHandlers<Contract>) {
  window.sessionStorage.setItem(streamChoiceKey("box_2"), "selkies");
  const slot = desktopTab(handlers);
  await waitFor(() => expect(FakeSocket.made.some((made) => made.url.includes("stream=selkies"))).toBe(true));
  const socket = videoSocket();
  act(() => socket.open());
  act(() => void socket.onmessage?.({ data: "MODE websockets" }));
  act(() => void socket.onmessage?.({ data: videoFrame(5, true) }));
  fireEvent.click(await slot.findByRole("button", { name: "Take control" }));
  await slot.findByText(/You have control/);
  const canvas = slot.getByTestId("desktop-screen").querySelector("canvas")!;
  return { slot, socket, canvas };
}

test("keys typed over video after a paste, before the stream switches to VNC, reach the box over VNC after the chord, not the closed video (the review of 22 October 2026)", async () => {
  const undo = withVideo();
  try {
    const { handlers } = server([desktopBox()], { video: true });
    const { slot, socket, canvas } = await videoInControl(handlers);
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
    fireEvent.keyDown(canvas, { key: "y", code: "KeyY" });
    fireEvent.keyUp(canvas, { key: "y", code: "KeyY" });
    expect(socket.sent).not.toContain("kd,121");
    fireEvent.click(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    await new Promise((resolve) => setTimeout(resolve, PASTE_LANDS_MS + 100));
    expect([socket.sent.includes("kd,121"), client.keyEvents.some((key) => key.keysym === 0x79)]).toEqual([false, true]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("a paste whose text is still on its way to the box as the stream switches to VNC is pressed over VNC once it lands (the review of 22 October 2026)", async () => {
  const undo = withVideo();
  try {
    const { handlers } = server([desktopBox({ display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: null, quality: null, macKeys: null } })], { video: true });
    let landed: (() => void) | null = null;
    const slow: PluginRpcTestHandlers<Contract> = { ...handlers, desktopPaste: () => new Promise<null>((resolve) => (landed = () => resolve(null))) };
    const { slot, socket, canvas } = await videoInControl(slow);
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[PASTE]")));
    await waitFor(() => expect(landed).not.toBeNull());
    fireEvent.click(within(await openDisplay(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitemcheckbox", { name: "Show as VNC" }));
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    act(() => landed!());
    await new Promise((resolve) => setTimeout(resolve, PASTE_CHORD_DELAY_MS + 100));
    expect([socket.sent.includes("kd,118"), client.keys.some((key) => key.keysym === 0x76)]).toEqual([false, true]);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

test("two pastes in quick succession press the box's chord twice, not once (the review of 22 October 2026)", async () => {
  const undo = withVideo();
  try {
    const { handlers } = server([desktopBox()], { video: true });
    const { socket, canvas } = await videoInControl(handlers);
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[ONE]")));
    await new Promise((resolve) => setTimeout(resolve, 60));
    fireEvent.keyDown(canvas, { key: "v", code: "KeyV", ctrlKey: true, repeat: true });
    act(() => void document.dispatchEvent(pasteEvent("[ONE]")));
    await new Promise((resolve) => setTimeout(resolve, PASTE_CHORD_DELAY_MS + PASTE_LANDS_MS + 100));
    expect(socket.sent.filter((sent) => sent === "kd,118")).toHaveLength(2);
  } finally {
    undo();
    window.sessionStorage.clear();
  }
});

/** The box keyboard modes the review covers: each box's system, and how a Mac's server names Command. */
const KEYBOARD_MODES = [
  { name: "a Linux box", box: {}, command: { keysym: 0xffe3, code: "ControlLeft" } },
  {
    name: "a Windows box",
    box: { os: "windows", kind: "windows-desktop", kindLabel: "Windows desktop", display: { protocol: "rfb", resizable: true, clipboard: "commands", refresh: null, quality: null, macKeys: null } },
    command: { keysym: 0xffe3, code: "ControlLeft" },
  },
  {
    name: "a Mac on Tart",
    box: { os: "macos", nature: "virtual", kind: "macos-desktop", kindLabel: "macOS desktop", display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" } },
    command: { keysym: 0xffe9, code: "AltLeft" },
  },
  { name: "a pool Mac", box: { os: "macos", nature: "real", kind: "macos-desktop", kindLabel: "macOS desktop" }, command: { keysym: 0xffe7, code: "MetaLeft" } },
] as const;
const BROWSERS = [
  { name: "Linux", platform: "Linux x86_64" },
  { name: "a Mac", platform: "MacIntel" },
] as const;

test.each(KEYBOARD_MODES.flatMap((mode) => BROWSERS.map((browser) => ({ mode, browser }))))(
  "over VNC to $mode.name from $browser.name: Shift and AltGr held through a paste go up for the chord and down again, keys repeated while it is on its way follow it in order, and Shift and Caps Lock type capitals after it",
  async ({ mode, browser }) => {
    const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue(browser.platform);
    fakeClipboard(() => Promise.resolve("[TEXT]"));
    try {
      const { handlers, changes } = server([desktopBox(mode.box as Partial<BoxView>)]);
      const slot = desktopTab(handlers);
      // The text is on its way once noVNC or bb-box's RPC has it.
      const textSent = () => client.pasted.length + changes.filter((change) => change.startsWith("desktopPaste")).length;
      await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
      const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
      act(() => void client.dispatchEvent(new Event("connect")));
      fireEvent.click(slot.getByRole("button", { name: "Take control" }));
      await slot.findByText(/You have control/);
      const keys = () => client.keys.map((key) => `${key.code}${key.down ? "" : " up"}`);
      const typed = () => client.keyEvents.map((key) => `${key.keysym.toString(16)}${key.down ? "" : " up"}`);
      const menuPaste = async () => fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
      const command = mode.command.code;

      // Shift held through the paste; X held down, its repeats while the paste is on its way.
      client._handleKeyEvent(0xffe1, "ShiftLeft", true, null, false);
      client.keyEvents.length = 0;
      await menuPaste();
      await waitFor(() => expect(textSent()).toBeGreaterThan(0));
      for (let repeat = 0; repeat < 3; repeat++) client._handleKeyEvent(0x58, "KeyX", true, null, false);
      client._handleKeyEvent(0x58, "KeyX", false, null, false);
      expect(typed()).toEqual([]);
      await waitFor(() => expect(typed()).toHaveLength(4));
      expect(keys()).toEqual(["ShiftLeft up", command, "KeyV", "KeyV up", `${command} up`, "ShiftLeft"]);
      expect(typed()).toEqual(["58", "58", "58", "58 up"]);
      // A letter the browser names lower case with Shift held goes as its capital.
      client.keyEvents.length = 0;
      client._handleKeyEvent(0x61, "KeyA", true, null, false);
      client._handleKeyEvent(0x61, "KeyA", false, null, false);
      client._handleKeyEvent(0xffe1, "ShiftLeft", false, null, false);
      // Caps Lock on, no Shift: the capital goes as named, with no Shift around it.
      client._handleKeyEvent(0x42, "KeyB", true, null, true);
      client._handleKeyEvent(0x42, "KeyB", false, null, true);
      expect(typed()).toEqual(["41", "41 up", "ffe1 up", "42", "42 up"]);

      // AltGr held from Linux, as noVNC names it there; from a Mac the right Option is plain Alt on a box that is not a Mac.
      client.keys.length = 0;
      client.keyEvents.length = 0;
      client._handleKeyEvent(0xfe03, "AltRight", true, null, false);
      const held = client.keyEvents.at(-1)!;
      await menuPaste();
      await waitFor(() => expect(client.keys).toHaveLength(6));
      expect(keys()).toEqual([`${held.code} up`, command, "KeyV", "KeyV up", `${command} up`, held.code]);
      expect(client.keys[0]!.keysym).toBe(held.keysym);
    } finally {
      platform.mockRestore();
    }
  },
);


test.each(KEYBOARD_MODES.flatMap((mode) => BROWSERS.map((browser) => ({ mode, browser }))))(
  "over video to $mode.name from $browser.name: Shift and AltGr held through a paste go up for the chord and down again, keys repeated while it is on its way follow it in order, and Shift and Caps Lock type capitals after it",
  async ({ mode, browser }) => {
    const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue(browser.platform);
    fakeClipboard(() => Promise.resolve("[TEXT]"));
    const undo = withVideo();
    try {
      const { handlers, changes } = server([desktopBox(mode.box as Partial<BoxView>)], { video: true });
      const { slot, socket, canvas } = await videoInControl(handlers);
      const keys = () => socket.sent.filter((sent): sent is string => typeof sent === "string" && /^k[du],/.test(sent));
      const menuPaste = async () => fireEvent.click(within(await openMenu(slot.getByRole("button", { name: "Desktop actions" }))).getByRole("menuitem", { name: "Paste from this computer" }));
      const textSent = () => socket.sent.filter((sent) => typeof sent === "string" && /^c[bw]/.test(sent)).length + changes.filter((change) => change.startsWith("desktopPaste")).length;
      // bb-box's own Mac input for video takes Meta as Command.
      const command = (mode.box as Partial<BoxView>).os === "macos" ? 65511 : 65507;

      fireEvent.keyDown(canvas, { key: "Shift", code: "ShiftLeft", shiftKey: true });
      const shift = keys().at(-1)!.slice(3);
      await menuPaste();
      await waitFor(() => expect(textSent()).toBeGreaterThan(0));
      const before = keys().length;
      for (let repeat = 0; repeat < 3; repeat++) fireEvent.keyDown(canvas, { key: "X", code: "KeyX", shiftKey: true, repeat: repeat > 0 });
      fireEvent.keyUp(canvas, { key: "X", code: "KeyX", shiftKey: true });
      expect(keys()).toHaveLength(before);
      await waitFor(() => expect(keys().length).toBeGreaterThanOrEqual(before + 10));
      expect(keys().slice(before)).toEqual([`ku,${shift}`, `kd,${command}`, "kd,118", "ku,118", `ku,${command}`, `kd,${shift}`, "kd,88", "kd,88", "kd,88", "ku,88"]);

      // A letter the browser names lower case with Shift held goes as its capital; with Caps Lock on, a capital as named.
      fireEvent.keyDown(canvas, { key: "a", code: "KeyA", shiftKey: true });
      fireEvent.keyUp(canvas, { key: "a", code: "KeyA", shiftKey: true });
      fireEvent.keyUp(canvas, { key: "Shift", code: "ShiftLeft" });
      fireEvent.keyDown(canvas, { key: "B", code: "KeyB", modifierCapsLock: true });
      fireEvent.keyUp(canvas, { key: "B", code: "KeyB", modifierCapsLock: true });
      expect(keys().slice(before + 10)).toEqual(["kd,65", "ku,65", `ku,${shift}`, "kd,66", "ku,66"]);

      // AltGr held through a second paste.
      fireEvent.keyDown(canvas, { key: "AltGraph", code: "AltRight" });
      const altGr = keys().at(-1)!.slice(3);
      const second = keys().length;
      await menuPaste();
      await waitFor(() => expect(keys().length).toBeGreaterThanOrEqual(second + 6));
      expect(keys().slice(second)).toEqual([`ku,${altGr}`, `kd,${command}`, "kd,118", "ku,118", `ku,${command}`, `kd,${altGr}`]);
    } finally {
      undo();
      window.sessionStorage.clear();
      platform.mockRestore();
    }
  },
);

test("a session that goes with its paste on its way hands the keys it held to the tab's newest session, before that session's own, and the chord too once the text lands (the review of 22 October 2026)", () => {
  vi.useFakeTimers();
  try {
    const sent: string[] = [];
    const video = new KeysAfterPaste<string>((key) => sent.push(`video ${key}`));
    video.join("box_2:viewer-one");
    video.hold();
    expect(video.keep("a")).toBe(true);
    // The stream switches before the text lands: the video session goes, and VNC comes.
    video.close();
    const vnc = new KeysAfterPaste<string>((key) => sent.push(`vnc ${key}`));
    let pressed = 0;
    vnc.pressChord = () => {
      pressed++;
      vnc.hold();
    };
    vnc.join("box_2:viewer-one");
    expect(vnc.keep("b")).toBe(true);
    // The text lands: VNC presses the chord, and sends the video's key, then its own, once that has landed.
    video.handChord(false);
    expect(pressed).toBe(1);
    expect(sent).toEqual([]);
    vnc.releaseIn(PASTE_LANDS_MS);
    vi.advanceTimersByTime(PASTE_LANDS_MS);
    expect(sent).toEqual(["vnc a", "vnc b"]);
    expect(vnc.keep("c")).toBe(false);
    // The video session has left the tab: a new paste there holds only VNC's keys.
    vnc.close();
  } finally {
    vi.useRealTimers();
  }
});

test("Ctrl+V, Cmd+V from a Mac, is a paste of this computer's clipboard, and with Shift too on a box that is not a Mac, as Linux terminals paste; Cmd+Shift+V on a Mac box is the person's own", () => {
  const press = (init: Partial<KeyboardEvent>) => ({ key: "v", altKey: false, shiftKey: false, ctrlKey: false, metaKey: false, ...init });
  for (const os of ["linux", "windows"]) {
    expect(pasteShortcut(press({ ctrlKey: true }), os, false)).toBe("plain");
    expect(pasteShortcut(press({ key: "V", ctrlKey: true, shiftKey: true }), os, false)).toBe("shifted");
    expect(pasteShortcut(press({ key: "V", metaKey: true, shiftKey: true }), os, true)).toBe("shifted");
    expect(pasteShortcut(press({ ctrlKey: true, altKey: true }), os, false)).toBeNull();
  }
  expect(pasteShortcut(press({ metaKey: true }), "macos", true)).toBe("plain");
  expect(pasteShortcut(press({ ctrlKey: true }), "macos", false)).toBe("plain");
  expect(pasteShortcut(press({ key: "V", metaKey: true, shiftKey: true }), "macos", true)).toBeNull();
  expect(pasteShortcut(press({ key: "V", ctrlKey: true, shiftKey: true }), "macos", false)).toBeNull();
  expect(pasteShortcut(press({ ctrlKey: true }), "linux", true)).toBeNull();
});

test("over VNC, Ctrl+Shift+V from Linux pastes this computer's text into a Linux box with the box's Ctrl+Shift+V, the person's own Ctrl and Shift up for it; on a Mac box Cmd+Shift+V goes to the box as typed", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("Linux x86_64");
  try {
    const { handlers } = server([desktopBox()]);
    const slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    client._handleKeyEvent(0xffe3, "ControlLeft", true, null, false);
    client._handleKeyEvent(0xffe1, "ShiftLeft", true, null, false);
    const { reached } = keyOnCanvas(slot, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    expect(reached).not.toHaveBeenCalled();
    act(() => void document.dispatchEvent(pasteEvent("[TERMINAL]")));
    await waitFor(() => expect(client.keys).toHaveLength(10));
    expect(client.pasted).toContain("[TERMINAL]");
    expect(client.keys.map((key) => `${key.code}${key.down ? "" : " up"}`)).toEqual([
      "ControlLeft up",
      "ShiftLeft up",
      "ControlLeft",
      "ShiftLeft",
      "KeyV",
      "KeyV up",
      "ShiftLeft up",
      "ControlLeft up",
      "ControlLeft",
      "ShiftLeft",
    ]);
  } finally {
    platform.mockRestore();
  }
});

test("on a Mac box, Cmd+Shift+V from a Mac goes to the box as the person's own keys, paste and match style, not a paste of this computer's clipboard", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("MacIntel");
  try {
    const { handlers } = server([desktopBox({ os: "macos", nature: "real", kind: "macos-desktop", kindLabel: "macOS desktop" })]);
    const slot = desktopTab(handlers);
    await waitFor(() => expect(novnc.FakeRfb.made).toHaveLength(1));
    const client = novnc.FakeRfb.made[0]! as unknown as FakeClient;
    act(() => void client.dispatchEvent(new Event("connect")));
    fireEvent.click(slot.getByRole("button", { name: "Take control" }));
    await slot.findByText(/You have control/);
    const { reached } = keyOnCanvas(slot, { key: "V", code: "KeyV", metaKey: true, shiftKey: true });
    expect(reached).toHaveBeenCalled();
    act(() => void document.dispatchEvent(pasteEvent("[TEXT]")));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client.keys).toEqual([]);
  } finally {
    platform.mockRestore();
  }
});

test("over video, Ctrl+Shift+V from Linux pastes this computer's text into a Windows box with the box's Ctrl+Shift+V", async () => {
  const platform = vi.spyOn(Navigator.prototype, "platform", "get").mockReturnValue("Linux x86_64");
  const undo = withVideo();
  try {
    const { handlers, changes } = server([desktopBox(KEYBOARD_MODES[1].box as Partial<BoxView>)], { video: true });
    const { socket, canvas } = await videoInControl(handlers);
    const keys = () => socket.sent.filter((sent): sent is string => typeof sent === "string" && /^k[du],/.test(sent));
    fireEvent.keyDown(canvas, { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true });
    act(() => void document.dispatchEvent(pasteEvent("[TERMINAL]")));
    await waitFor(() => expect(keys()).toContain("ku,65507"));
    expect(changes.some((change) => change.startsWith("desktopPaste") && change.endsWith("[TERMINAL]"))).toBe(true);
    expect(keys()).toEqual(["kd,65507", "kd,65505", "kd,118", "ku,118", "ku,65505", "ku,65507"]);
  } finally {
    undo();
    window.sessionStorage.clear();
    platform.mockRestore();
  }
});

test("the tailnet saves its mode, tags and OAuth client as secrets; a set secret shows only as set and is kept until replaced; off saves none", async () => {
  const fresh = server([]);
  const slot = settings(fresh.handlers);
  await slot.findByRole("combobox", { name: "Tailnet" });
  await choose("Tailnet", "Yes, with a Tailscale OAuth client");
  fireEvent.change(slot.getByLabelText("Tags"), { target: { value: "tag:bb-box, tag:bb-box-mac" } });
  fireEvent.change(slot.getByLabelText("OAuth client ID"), { target: { value: "kCLIENTid" } });
  fireEvent.change(slot.getByLabelText("OAuth client secret"), { target: { value: "tskey-client-SECRET" } });
  expect(slot.getByLabelText("OAuth client secret").id).toBe("tailnet-oauth-client-secret");
  fireEvent.click(slot.getByRole("button", { name: "Save the tailnet" }));
  await waitFor(() => expect(fresh.changes).toHaveLength(1));
  expect(JSON.parse(fresh.changes[0]!.slice(fresh.changes[0]!.indexOf("{"))).general.tailnet).toEqual({
    mode: "oauth",
    tags: ["tag:bb-box", "tag:bb-box-mac"],
    clientId: "kCLIENTid",
    clientSecret: "tskey-client-SECRET",
  });
  cleanup();

  const document = { ...configState({}).document, general: { tailnet: { mode: "oauth" as const, clientId: { set: true }, clientSecret: { set: true } } } };
  const stored = server([], { config: configState({ document }) });
  const again = settings(stored.handlers);
  await again.findByRole("combobox", { name: "Tailnet" });
  expect(again.getAllByText("Set")).toHaveLength(2);
  expect(again.queryByDisplayValue(/tskey/)).toBeNull();
  fireEvent.click(again.getByRole("button", { name: "Save the tailnet" }));
  await waitFor(() => expect(stored.changes).toHaveLength(1));
  expect(JSON.parse(stored.changes[0]!.slice(stored.changes[0]!.indexOf("{"))).general.tailnet).toEqual({ mode: "oauth", clientId: { set: true }, clientSecret: { set: true } });
  await choose("Tailnet", "No: BB is reached without one");
  fireEvent.click(again.getByRole("button", { name: "Save the tailnet" }));
  await waitFor(() => expect(stored.changes).toHaveLength(2));
  expect(JSON.parse(stored.changes[1]!.slice(stored.changes[1]!.indexOf("{"))).general.tailnet).toBeUndefined();
});

test("an ios box's New box form chooses Shared or a VM of its own before the device; Shared is off with its words until a shared host is set up, and a VM of its own sends dedicated with its size (064, unit 2)", async () => {
  const linux = KINDS[0]!;
  const ios: KindView = {
    ...linux,
    id: "ios",
    label: "iOS Simulator",
    os: "macos",
    arch: "arm64",
    devices: { platform: "ios", models: ["iPhone 18 Pro", "iPhone 17"] },
    placement: { kind: "ios", shared: false, why: "No shared iOS host is set up", sizeNeedsDedicated: false },
  };
  const { handlers, changes } = server([], { kinds: [linux, ios] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  const systems = await screen.findByRole("radiogroup", { name: "System" });
  expect(screen.queryByRole("radiogroup", { name: "Machine" })).toBeNull();
  fireEvent.click(within(systems).getByRole("radio", { name: /^iOS/ }));
  const machine = screen.getByRole("radiogroup", { name: "Machine" });
  const options = within(machine).getAllByRole("radio");
  expect(options.map((option) => [option.textContent, option.getAttribute("aria-checked"), option.getAttribute("aria-disabled"), option.tabIndex])).toEqual([
    ["SharedNo shared iOS host is set up.", "false", "true", -1],
    ["A VM of its ownsudo, Homebrew, its own cores, ports and desktop. Takes one of the Mac's two VMs, so it can wait for one.", "true", null, 0],
  ]);
  const placement = screen.getByText("Machine");
  const device = screen.getByText("Device");
  expect(placement.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(options[0]!);
  fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
  expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  expect(screen.getByRole("radiogroup", { name: "Size" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire ios dedicated"]));
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^iOS/ }));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Size" })).getByRole("radio", { name: /^Large/ }));
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire ios dedicated", 'acquire ios {"preset":"large"} dedicated']));
});

test("a macos box's New box form offers Shared beside a VM of its own once a host lends slots, by click and by keyboard; Shared sends shared with no size, and a VM of its own sends neither shared nor dedicated (064, unit 8)", async () => {
  const linux = KINDS[0]!;
  const macos: KindView = {
    ...linux,
    id: "macos",
    label: "macOS",
    os: "macos",
    arch: "arm64",
    placement: { kind: "macos", shared: true, why: null, sizeNeedsDedicated: false },
  };
  const { handlers, changes } = server([], { kinds: [linux, macos] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^macOS/ }));
  const options = within(screen.getByRole("radiogroup", { name: "Machine" })).getAllByRole("radio");
  expect(options.map((option) => [option.textContent, option.getAttribute("aria-checked"), option.getAttribute("aria-disabled"), option.tabIndex])).toEqual([
    ["SharedReady in seconds, for commands, builds and the iOS Simulator. No sudo, Homebrew installs, desktop or app windows. Other boxes on the host share its cores and ports, and see its processes.", "false", null, -1],
    ["A VM of its ownsudo, Homebrew, its own cores and ports. Takes one of the Mac's two VMs, so it can wait for one.", "true", null, 0],
  ]);
  expect(screen.getByRole("radiogroup", { name: "Size" })).toBeTruthy();
  options[1]!.focus();
  fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
  expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(document.activeElement).toBe(options[0]);
  expect(options.map((option) => option.tabIndex)).toEqual([0, -1]);
  expect(screen.queryByRole("radiogroup", { name: "Size" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire macos shared"]));
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^macOS/ }));
  const again = within(screen.getByRole("radiogroup", { name: "Machine" })).getAllByRole("radio");
  fireEvent.click(again[0]!);
  fireEvent.keyDown(again[0]!, { key: "ArrowDown" });
  expect(again.map((option) => option.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire macos shared", "acquire macos"]));
});

test("a macos kind with no host lending slots shows no Machine choice (064, unit 8)", async () => {
  const linux = KINDS[0]!;
  const macos: KindView = { ...linux, id: "macos", label: "macOS", os: "macos", arch: "arm64", placement: null };
  const { handlers } = server([], { kinds: [linux, macos] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^macOS/ }));
  expect(screen.queryByRole("radiogroup", { name: "Machine" })).toBeNull();
});

test("with a shared iOS host set up, Shared can be chosen and sends shared with no size; A VM of its own stays the first choice until shared is the default (064, unit 4)", async () => {
  const linux = KINDS[0]!;
  const ios: KindView = {
    ...linux,
    id: "ios",
    label: "iOS Simulator",
    os: "macos",
    arch: "arm64",
    devices: { platform: "ios", models: ["iPhone 18 Pro", "iPhone 17"] },
    placement: { kind: "ios", shared: true, why: null, sizeNeedsDedicated: false },
  };
  const { handlers, changes } = server([], { kinds: [linux, ios] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^iOS/ }));
  const options = within(screen.getByRole("radiogroup", { name: "Machine" })).getAllByRole("radio");
  expect(options.map((option) => [option.textContent, option.getAttribute("aria-checked"), option.getAttribute("aria-disabled")])).toEqual([
    ["SharedReady in seconds. No sudo or Homebrew installs. Other iOS boxes on the host share its cores and ports, and see its processes.", "false", null],
    ["A VM of its ownsudo, Homebrew, its own cores, ports and desktop. Takes one of the Mac's two VMs, so it can wait for one.", "true", null],
  ]);
  fireEvent.keyDown(options[1]!, { key: "ArrowUp" });
  expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(screen.queryByRole("radiogroup", { name: "Size" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire ios shared"]));
});

test("with shared the default and a shared iOS host set up, Shared is chosen first and sends shared with no size; A VM of its own sends dedicated with its size (064, unit 6)", async () => {
  const linux = KINDS[0]!;
  const ios: KindView = {
    ...linux,
    id: "ios",
    label: "iOS Simulator",
    os: "macos",
    arch: "arm64",
    devices: { platform: "ios", models: ["iPhone 18 Pro", "iPhone 17"] },
    placement: { kind: "ios", shared: true, why: null, sizeNeedsDedicated: true },
  };
  const { handlers, changes } = server([], { kinds: [linux, ios] });
  const slot = panel(handlers);
  await slot.findByText("No boxes yet");
  fireEvent.click(slot.getByRole("button", { name: "New box" }));
  fireEvent.click(within(await screen.findByRole("radiogroup", { name: "System" })).getByRole("radio", { name: /^iOS/ }));
  const options = within(screen.getByRole("radiogroup", { name: "Machine" })).getAllByRole("radio");
  expect(options.map((option) => option.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  expect(screen.queryByRole("radiogroup", { name: "Size" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create box" }));
  await waitFor(() => expect(changes.filter((change) => change.startsWith("acquire"))).toEqual(["acquire ios shared"]));
});

const SHARED_IOS = box({ id: "box_si", name: "brisk-wren", kind: "ios", kindLabel: "iOS Simulator", os: "macos", arch: "arm64", form: null, shared: true, backendLabel: "SSH host pool", provider: "SSH pool", desktop: false, display: null, device: { platform: "ios", model: "iPhone 18 Pro", simulatorHost: true }, control: { owner: "agent", holder: null } });
const DEDICATED_IOS = box({ id: "box_di", name: "tall-ridge", kind: "ios", kindLabel: "iOS Simulator", os: "macos", arch: "arm64", form: "VM", backendLabel: "Tart on studio", provider: "Tart", desktop: true, display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" }, device: { platform: "ios", model: "iPhone 17", simulatorHost: true }, control: { owner: "agent", holder: null } });
const ANDROID = box({ id: "box_an", name: "green-bay", kind: "android", kindLabel: "Android emulator", os: "linux", form: "VM", backendLabel: "Proxmox QEMU on pve", provider: "Proxmox", requires: ["kvm"], desktop: false, display: null, device: { platform: "android", model: "Pixel 8", simulatorHost: false }, control: { owner: "agent", holder: null } });
const ANDROID_WITH_DESKTOP = desktopBox({ id: "box_ad", name: "wide-dune", kind: "android", kindLabel: "Android emulator", device: { platform: "android", model: "Pixel Fold", simulatorHost: false } });
const MAC_DESKTOP = box({ id: "box_md", name: "pool-mac", kind: "macos-desktop", kindLabel: "macOS desktop", os: "macos", arch: "arm64", form: "VM", desktop: true, display: { protocol: "rfb", resizable: false, clipboard: "commands", refresh: null, quality: null, macKeys: "alt-command" }, control: { owner: "agent", holder: null } });
const LINUX_DESKTOP = desktopBox();

test("F-19: iOS and Android are systems in the Boxes page's filters, after Linux, macOS and Windows; a device box is its device's system, with counts, and the search finds it by its device", () => {
  const rows = [box(), LINUX_DESKTOP, MAC_DESKTOP, SHARED_IOS, DEDICATED_IOS, ANDROID].map((one) => ({ box: one, words: [] }));
  const names = (search: string, filters: typeof NO_FILTERS) => shown(rows, search, filters, { key: "name", ascending: true }).map((row) => row.box.name);
  expect(rows.map((row) => `${row.box.name}: ${tagsOf(row.box).systems.join()}`)).toEqual(["calm-otter: Linux", "bold-heron: Linux", "pool-mac: macOS", "brisk-wren: iOS", "tall-ridge: iOS", "green-bay: Android"]);
  expect(choices(rows.map((row) => row.box)).systems).toEqual(["Linux", "macOS", "iOS", "Android"]);
  expect(tagCounts(rows, "", NO_FILTERS).systems).toEqual({ Linux: 2, macOS: 1, iOS: 2, Android: 1 });
  expect(names("", { ...NO_FILTERS, systems: ["iOS"] })).toEqual(["brisk-wren", "tall-ridge"]);
  expect(names("", { ...NO_FILTERS, systems: ["Android"] })).toEqual(["green-bay"]);
  expect(names("", { ...NO_FILTERS, systems: ["iOS", "Android"] })).toEqual(["brisk-wren", "green-bay", "tall-ridge"]);
  expect(names("", { ...NO_FILTERS, systems: ["macOS"] })).toEqual(["pool-mac"]);
  expect(names("", { ...NO_FILTERS, systems: ["iOS"], has: ["Desktop"] })).toEqual(["tall-ridge"]);
  expect(tagCounts(rows, "", { ...NO_FILTERS, has: ["Desktop"] }).systems).toEqual({ Linux: 1, macOS: 1, iOS: 1 });
  expect(names("iphone 18", NO_FILTERS)).toEqual(["brisk-wren"]);
  expect(names("pixel", NO_FILTERS)).toEqual(["green-bay"]);
  expect(tagCounts(rows, "iphone", NO_FILTERS).systems).toEqual({ iOS: 2 });
});

test("a device box's Simulator or Emulator badge and a shared box's Shared badge are tags in the Boxes page's filters too", () => {
  const rows = [box(), MAC_DESKTOP, SHARED_IOS, DEDICATED_IOS, ANDROID].map((one) => ({ box: one, words: [] }));
  const names = (filters: typeof NO_FILTERS) => shown(rows, "", filters, { key: "name", ascending: true }).map((row) => row.box.name);
  expect(rows.map((row) => { const tags = tagsOf(row.box); return `${row.box.name}: ${tags.forms.join()} | ${tags.has.join()}`; })).toEqual([
    "calm-otter: Container | ",
    "pool-mac: VM | Desktop,arm64",
    "brisk-wren: Shared | Simulator,arm64",
    "tall-ridge: VM | Simulator,Desktop,arm64",
    "green-bay: VM | Emulator,KVM",
  ]);
  const listed = choices(rows.map((row) => row.box));
  expect(listed.forms).toEqual(["VM", "Container", "Shared"]);
  expect(listed.has).toEqual(["Simulator", "Emulator", "Desktop", "KVM", "arm64"]);
  expect(names({ ...NO_FILTERS, has: ["Simulator"] })).toEqual(["brisk-wren", "tall-ridge"]);
  expect(names({ ...NO_FILTERS, has: ["Emulator"] })).toEqual(["green-bay"]);
  expect(names({ ...NO_FILTERS, forms: ["Shared"] })).toEqual(["brisk-wren"]);
});

test("F-19: on the Boxes page, the Filters menu offers iOS and Android under System, and ticking one lists only its device boxes", async () => {
  const { handlers } = server([box(), MAC_DESKTOP, SHARED_IOS, DEDICATED_IOS, ANDROID]);
  const list = boxesPage(handlers);
  await list.findByText("brisk-wren");
  const rowNames = () => list.getAllByRole("button", { name: /: details$/, hidden: true }).map((node) => node.getAttribute("aria-label")!.replace(/: details$/, ""));
  const menu = await openMenu(list.getByRole("button", { name: "Filters" }));
  expect(within(menu).getAllByRole("menuitemcheckbox").map((option) => option.textContent).slice(0, 4)).toEqual(["Linux", "macOS", "iOS", "Android"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "iOS" }));
  expect(rowNames()).toEqual(["brisk-wren", "tall-ridge"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "iOS" }));
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Android" }));
  expect(rowNames()).toEqual(["green-bay"]);
  fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "Android" }));
  fireEvent.keyDown(menu, { key: "Escape" });
  fireEvent.change(list.getByRole("textbox", { name: "Search boxes" }), { target: { value: "iPhone 17" } });
  expect(rowNames()).toEqual(["tall-ridge"]);
});

test("F-19: a box's tabs say what they show: Simulator for an iOS device, Emulator for an Android one, Desktop for a desktop, a box with both has both, and the box's name follows only when another box's tab would say the same", () => {
  const tabs = (one: BoxView) => screensOf(one).map((each) => screenWord(one, each));
  expect(tabs(SHARED_IOS)).toEqual(["Simulator"]);
  expect(tabs(DEDICATED_IOS)).toEqual(["Simulator", "Desktop"]);
  expect(tabs(ANDROID)).toEqual(["Emulator"]);
  expect(tabs(ANDROID_WITH_DESKTOP)).toEqual(["Emulator", "Desktop"]);
  expect(tabs(MAC_DESKTOP)).toEqual(["Desktop"]);
  expect(tabs(LINUX_DESKTOP)).toEqual(["Desktop"]);
  expect(tabs(box())).toEqual([]);
  expect(screenTitle(SHARED_IOS, "device", [SHARED_IOS, ANDROID, LINUX_DESKTOP])).toBe("Simulator");
  expect(screenTitle(SHARED_IOS, "device", [SHARED_IOS, DEDICATED_IOS])).toBe("Simulator · brisk-wren");
  expect(screenTitle(DEDICATED_IOS, "desktop", [DEDICATED_IOS, SHARED_IOS])).toBe("Desktop");
  expect(screenTitle(DEDICATED_IOS, "desktop", [DEDICATED_IOS, LINUX_DESKTOP])).toBe("Desktop · tall-ridge");
  expect(screenTitle(ANDROID, "device", [ANDROID, SHARED_IOS])).toBe("Emulator");
});

test("F-19: the panel's rows open each screen in a tab of its own, titled by what it shows: a dedicated iOS box's Simulator and Desktop, a shared one's Simulator, an Android box's Emulator, and a Linux desktop's Desktop", async () => {
  const slot = panel(server([SHARED_IOS, DEDICATED_IOS, ANDROID, LINUX_DESKTOP]).handlers);
  await slot.findByText("brisk-wren");
  const opened = async (label: string, index = 0) => {
    const before = slot.inspection.navigateCalls.length;
    fireEvent.click(slot.getAllByRole("button", { name: label })[index]!);
    await waitFor(() => expect(slot.inspection.navigateCalls.length).toBe(before + 1));
    return slot.inspection.navigateCalls.at(-1);
  };
  expect(slot.getAllByRole("button", { name: "Open simulator" })).toHaveLength(2);
  expect(slot.getAllByRole("button", { name: "Open desktop" })).toHaveLength(2);
  expect(slot.getAllByRole("button", { name: "Open emulator" })).toHaveLength(1);
  expect(await opened("Open simulator", 0)).toEqual({ method: "openThreadPanel", options: { actionId: "device", title: "Simulator · brisk-wren", params: { box: "box_si" } } });
  expect(await opened("Open simulator", 1)).toEqual({ method: "openThreadPanel", options: { actionId: "device", title: "Simulator · tall-ridge", params: { box: "box_di" } } });
  expect(await opened("Open desktop", 0)).toEqual({ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop · tall-ridge", params: { box: "box_di", shows: "desktop" } } });
  expect(await opened("Open emulator")).toEqual({ method: "openThreadPanel", options: { actionId: "device", title: "Emulator", params: { box: "box_an" } } });
  expect(await opened("Open desktop", 1)).toEqual({ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop · bold-heron", params: { box: "box_2" } } });
  const menu = await openMenu(slot.getByRole("button", { name: "tall-ridge actions" }));
  expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent).slice(0, 2)).toEqual(["Open simulator", "Open desktop"]);
});

test("F-19: a dedicated iOS box's Simulator tab has a Desktop button that opens its Desktop tab, and that tab's Simulator button opens the Simulator tab; a shared box's and a Linux desktop's tabs have neither", async () => {
  const handlers = server([DEDICATED_IOS, SHARED_IOS, LINUX_DESKTOP]).handlers;
  const device = app.threadPanelActions.find((candidate) => candidate.id === "device")!;
  const desktop = app.threadPanelActions.find((candidate) => candidate.id === "desktop")!;
  const simulator = renderSlot(device, { threadId: THREAD, params: { box: "box_di" } }, { rpc: handlers, pluginId: "bb-box" });
  fireEvent.click(await simulator.findByRole("button", { name: "Desktop" }));
  await waitFor(() => expect(simulator.inspection.navigateCalls.at(-1)).toEqual({ method: "openThreadPanel", options: { actionId: "desktop", title: "Desktop · tall-ridge", params: { box: "box_di", shows: "desktop" } } }));
  expect(simulator.queryByRole("button", { name: "Simulator" })).toBeNull();
  cleanup();
  const ownDesktop = renderSlot(desktop, { threadId: THREAD, params: { box: "box_di", shows: "desktop" } }, { rpc: handlers, pluginId: "bb-box" });
  expect(await ownDesktop.findByText("Connecting to the desktop…")).toBeTruthy();
  fireEvent.click(ownDesktop.getByRole("button", { name: "Simulator" }));
  await waitFor(() => expect(ownDesktop.inspection.navigateCalls.at(-1)).toEqual({ method: "openThreadPanel", options: { actionId: "device", title: "Simulator · tall-ridge", params: { box: "box_di" } } }));
  cleanup();
  const shared = renderSlot(device, { threadId: THREAD, params: { box: "box_si" } }, { rpc: handlers, pluginId: "bb-box" });
  await shared.findByText("brisk-wren");
  expect(shared.queryByRole("button", { name: "Desktop" })).toBeNull();
  cleanup();
  const linux = renderSlot(desktop, { threadId: THREAD, params: { box: "box_2" } }, { rpc: handlers, pluginId: "bb-box" });
  expect(await linux.findByText("Connecting to the desktop…")).toBeTruthy();
  expect(linux.queryByRole("button", { name: /^(Simulator|Emulator)$/ })).toBeNull();
});

test("F-19: a bare Desktop tab whose one box is a shared iOS box shows its device and retitles itself Simulator; a bare Device tab with an Android box retitles itself Emulator; a bare Desktop tab with a dedicated iOS box shows its desktop and keeps its title", async () => {
  const desktop = app.threadPanelActions.find((candidate) => candidate.id === "desktop")!;
  const device = app.threadPanelActions.find((candidate) => candidate.id === "device")!;
  const shared = renderSlot(desktop, { threadId: THREAD, params: null }, { rpc: server([box(), SHARED_IOS]).handlers, pluginId: "bb-box" });
  await waitFor(() => expect(shared.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "desktop", title: "Simulator" } }]));
  expect(await shared.findByText("brisk-wren")).toBeTruthy();
  cleanup();
  forgetLive();
  const android = renderSlot(device, { threadId: THREAD, params: null }, { rpc: server([ANDROID, LINUX_DESKTOP]).handlers, pluginId: "bb-box" });
  await waitFor(() => expect(android.inspection.navigateCalls).toEqual([{ method: "openThreadPanel", options: { actionId: "device", title: "Emulator" } }]));
  cleanup();
  forgetLive();
  const dedicated = renderSlot(desktop, { threadId: THREAD, params: null }, { rpc: server([DEDICATED_IOS]).handlers, pluginId: "bb-box" });
  expect(await dedicated.findByText("Connecting to the desktop…")).toBeTruthy();
  expect(dedicated.getByRole("button", { name: "Simulator" })).toBeTruthy();
  expect(dedicated.inspection.navigateCalls).toEqual([]);
  cleanup();
  forgetLive();
  const none = renderSlot(device, { threadId: THREAD, params: null }, { rpc: server([LINUX_DESKTOP]).handlers, pluginId: "bb-box" });
  expect(await none.findByText("No device box")).toBeTruthy();
  expect(none.inspection.navigateCalls).toEqual([]);
});

test("F-19: moving from a box's Desktop tab with control to its Simulator tab keeps control past the hidden tab's minute; closing that tab too hands it back", async () => {
  const both = desktopBox({ kind: "ios", os: "macos", device: { platform: "ios", model: "iPhone 17", simulatorHost: true } });
  const { handlers, changes } = server([both]);
  const desktop = app.threadPanelActions.find((candidate) => candidate.id === "desktop")!;
  const device = app.threadPanelActions.find((candidate) => candidate.id === "device")!;
  const ownDesktop = renderSlot(desktop, { threadId: THREAD, params: { box: "box_2", shows: "desktop" } }, { rpc: handlers, pluginId: "bb-box" });
  await ownDesktop.findByText("Connecting to the desktop…");
  act(() => void novnc.FakeRfb.made[0]!.dispatchEvent(new Event("connect")));
  fireEvent.click(ownDesktop.getByRole("button", { name: "Take control" }));
  await ownDesktop.findByText("You have control.");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  ownDesktop.unmount();
  const simulator = renderSlot(device, { threadId: THREAD, params: { box: "box_2" } }, { rpc: handlers, pluginId: "bb-box" });
  expect(await simulator.findByRole("button", { name: "Hand back to the agent" })).toBeTruthy();
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS + 50);
  expect(changes).toEqual(["takeControl box_2"]);
  simulator.unmount();
  await vi.advanceTimersByTimeAsync(HAND_BACK_MS + 50);
  vi.useRealTimers();
  await waitFor(() => expect(changes).toEqual(["takeControl box_2", "handBack box_2"]));
});

function rowTitle(details: HTMLElement): { system: string[]; badges: string[] } {
  const title = details.querySelector("[data-row-title]")!;
  const system = ["system", "model"].flatMap((part) => Array.from(title.querySelectorAll(`[data-title-part="${part}"]`)).map((each) => each.textContent ?? ""));
  const badges = Array.from(title.querySelectorAll("[data-badge-rank]")).map((badge) => badge.textContent ?? "");
  return { system, badges };
}

const F22_ROWS: readonly [BoxView, { system: string[]; badges: string[] }][] = [
  [SHARED_IOS, { system: ["iOS", "iPhone 18 Pro"], badges: ["Simulator", "Shared"] }],
  [DEDICATED_IOS, { system: ["iOS", "iPhone 17"], badges: ["Simulator", "Desktop", "VM"] }],
  [ANDROID, { system: ["Android", "Pixel 8"], badges: ["Emulator", "VM"] }],
  [MAC_DESKTOP, { system: ["macOS"], badges: ["Desktop", "VM"] }],
  [box(), { system: ["Linux"], badges: ["LXC"] }],
];

test("F-22: a device box's row reads as a desktop's does: its device's system, its model, then Simulator or Emulator where Desktop goes and Shared or VM where VM goes, and a dedicated ios box keeps its Desktop badge", async () => {
  const slot = panel(server(F22_ROWS.map(([one]) => one)).handlers);
  await slot.findByText("brisk-wren");
  for (const [one, expected] of F22_ROWS) expect([one.name, rowTitle(slot.getByRole("button", { name: `${one.name}: details` }))]).toEqual([one.name, expected]);
});

test("F-22: the Boxes page's rows and the bare tabs' choosers badge a device box as the Box panel does", async () => {
  const list = boxesPage(server(F22_ROWS.map(([one]) => one)).handlers);
  await list.findByText("brisk-wren");
  for (const [one, expected] of F22_ROWS) expect([one.name, rowTitle(list.getByRole("button", { name: `${one.name}: details`, hidden: true }))]).toEqual([one.name, expected]);
  cleanup();
  for (const [one, expected] of F22_ROWS) {
    const line = render(<BoxLine box={one} />);
    expect([one.name, rowTitle(line.container as HTMLElement)]).toEqual([one.name, expected]);
    line.unmount();
  }
});

test("F-22: where BB's viewport is compact, a tab that would name its box says the box's name alone, as its icon says what it shows; a terminal's tab too", () => {
  expect(screenTitle(SHARED_IOS, "device", [SHARED_IOS, DEDICATED_IOS], true)).toBe("brisk-wren");
  expect(screenTitle(DEDICATED_IOS, "desktop", [DEDICATED_IOS, LINUX_DESKTOP], true)).toBe("tall-ridge");
  expect(screenTitle(SHARED_IOS, "device", [SHARED_IOS, ANDROID], true)).toBe("Simulator");
  expect(screenTitle(DEDICATED_IOS, "desktop", [DEDICATED_IOS, SHARED_IOS], true)).toBe("Desktop");
  expect(screenTitle(SHARED_IOS, "device", [SHARED_IOS, DEDICATED_IOS], false)).toBe("Simulator · brisk-wren");
  expect(terminalTitle(box(), true)).toBe("calm-otter");
  expect(terminalTitle(box(), false)).toBe("Terminal: calm-otter");
});

test("F-22: at 360 px the panel's rows open tabs titled by the box's name where a wide panel would say 'Simulator · ' and the name, and a terminal by its box's name", async () => {
  const compact = (query: string) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  const wide = window.matchMedia;
  window.matchMedia = compact as unknown as typeof window.matchMedia;
  try {
    const slot = panel(server([SHARED_IOS, DEDICATED_IOS, ANDROID, LINUX_DESKTOP]).handlers);
    await slot.findByText("brisk-wren");
    const opened = async (label: string, index = 0) => {
      const before = slot.inspection.navigateCalls.length;
      fireEvent.click(slot.getAllByRole("button", { name: label })[index]!);
      await waitFor(() => expect(slot.inspection.navigateCalls.length).toBe(before + 1));
      return (slot.inspection.navigateCalls.at(-1) as { options: { title: string } }).options.title;
    };
    expect(await opened("Open simulator", 0)).toBe("brisk-wren");
    expect(await opened("Open simulator", 1)).toBe("tall-ridge");
    expect(await opened("Open emulator")).toBe("Emulator");
    expect(await opened("Open desktop", 0)).toBe("bold-heron");
    fireEvent.click(slot.getByRole("button", { name: "tall-ridge actions" }));
    const before = slot.inspection.navigateCalls.length;
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open desktop" }));
    await waitFor(() => expect(slot.inspection.navigateCalls.length).toBe(before + 1));
    expect((slot.inspection.navigateCalls.at(-1) as { options: { title: string } }).options.title).toBe("tall-ridge");
    fireEvent.click(slot.getByRole("button", { name: "brisk-wren actions" }));
    const beforeTerminal = slot.inspection.navigateCalls.length;
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open terminal" }));
    await waitFor(() => expect(slot.inspection.navigateCalls.length).toBe(beforeTerminal + 1));
    expect((slot.inspection.navigateCalls.at(-1) as { options: { title: string } }).options.title).toBe("brisk-wren");
    cleanup();
  } finally {
    window.matchMedia = wide;
  }
});

test("F-22: each panel tab has an icon of its own: a monitor for Desktop, a phone for Device, a terminal for Terminal, each a name bb-box declares, and the Box tab keeps BB's default", () => {
  expect(app.threadPanelActions.map((action) => [action.id, action.icon ?? null])).toEqual([
    ["boxes", null],
    ["desktop", "bb-box/monitor"],
    ["device", "bb-box/phone"],
    ["terminal", "bb-box/terminal"],
  ]);
  const declared = (packageJson as { bb: { branding: { experimental_icons: Record<string, string> } } }).bb.branding.experimental_icons;
  expect([declared.monitor, declared.phone, declared.terminal]).toEqual(["./assets/monitor.svg", "./assets/phone.svg", "./assets/terminal.svg"]);
});

test("F-22b: a row title keeps the name whole, then badges by rank, Simulator, Emulator, Shared and the form before Desktop, and cuts the model, then drops it, before any badge", () => {
  const shared = { name: 70, system: 18, model: 91, badges: [{ width: 66, rank: 0 }, { width: 48, rank: 0 }] };
  expect(fitTitle({ room: 400, ...shared })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: true, showsBadge: [true, true] });
  expect(fitTitle({ room: 300, ...shared })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: 70, showsModel: true, showsBadge: [true, true] });
  expect(fitTitle({ room: 250, ...shared })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: false, showsBadge: [true, true] });
  expect(fitTitle({ room: 170, ...shared })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: false, showsBadge: [true, false] });
  const dedicated = { name: 70, system: 18, model: 63, badges: [{ width: 66, rank: 0 }, { width: 54, rank: 1 }, { width: 24, rank: 0 }] };
  expect(fitTitle({ room: 240, ...dedicated })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: 34, showsModel: true, showsBadge: [true, false, true] });
  expect(fitTitle({ room: 262, ...dedicated })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: false, showsBadge: [true, true, true] });
  expect(fitTitle({ room: 185, ...dedicated })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: false, showsBadge: [true, false, false] });
  expect(fitTitle({ room: 90, ...dedicated })).toEqual({ nameRoom: null, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: [false, false, false] });
  expect(fitTitle({ room: 60, ...dedicated })).toEqual({ nameRoom: 60, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: [false, false, false] });
});

function withRowLayout<T>(room: number, run: () => Promise<T>): Promise<T> {
  const restore: (() => void)[] = [];
  const stub = (target: object, key: string, get: (this: HTMLElement) => unknown) => {
    const before = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, get });
    restore.push(() => (before ? Object.defineProperty(target, key, before) : delete (target as Record<string, unknown>)[key]));
  };
  stub(HTMLElement.prototype, "clientWidth", function () {
    return this.hasAttribute("data-row-title") ? room : 0;
  });
  stub(Element.prototype, "scrollWidth", function () {
    return (this.textContent ?? "").length * 7;
  });
  const rect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    const width = (this.textContent ?? "").length * 6 + (this.hasAttribute("data-badge-rank") ? 12 : 0);
    return { width, height: 18, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 18, toJSON: () => ({}) } as DOMRect;
  };
  restore.push(() => (Element.prototype.getBoundingClientRect = rect));
  const observer = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  restore.push(() => (globalThis.ResizeObserver = observer));
  return run().finally(() => {
    cleanup();
    for (const undo of restore.reverse()) undo();
  });
}

function shownTitle(details: HTMLElement): { name: string; parts: string[]; cut: string | null } {
  const title = details.querySelector("[data-row-title]")!;
  const shown = (element: Element) => !element.className.includes("invisible");
  const parts = Array.from(title.querySelectorAll('[data-title-part="system"], [data-title-part="model"], [data-badge-rank]')).filter(shown).map((part) => part.textContent ?? "");
  const model = title.querySelector<HTMLElement>('[data-title-part="model"]');
  const name = title.querySelector<HTMLElement>('[data-title-part="name"]')!;
  return { name: name.style.maxWidth ? `${name.textContent} cut to ${name.style.maxWidth}` : (name.textContent ?? ""), parts, cut: model && shown(model) && model.style.maxWidth ? model.style.maxWidth : null };
}

test("F-22b: in the thread pane's 506 px a shared ios row shows its name, iOS, Simulator and Shared, with the model cut to the room left", async () => {
  await withRowLayout(300, async () => {
    const slot = panel(server([SHARED_IOS]).handlers);
    await slot.findByText("brisk-wren");
    expect(shownTitle(slot.getByRole("button", { name: "brisk-wren: details" }))).toEqual({ name: "brisk-wren", parts: ["iOS", "iPhone 18 Pro", "Simulator", "Shared"], cut: "70px" });
  });
});

test("F-22b: at 360 px a dedicated ios row shows its name, iOS and Simulator, its model and the badges after them giving way, and one quick action beside the menu", async () => {
  const compact = (query: string) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  const wide = window.matchMedia;
  window.matchMedia = compact as unknown as typeof window.matchMedia;
  try {
    await withRowLayout(185, async () => {
      const slot = panel(server([DEDICATED_IOS, box()]).handlers);
      await slot.findByText("tall-ridge");
      expect(shownTitle(slot.getByRole("button", { name: "tall-ridge: details" }))).toEqual({ name: "tall-ridge", parts: ["iOS", "Simulator"], cut: null });
      const actions = (name: string) => Array.from(slot.getByRole("button", { name: `${name}: details` }).closest("[data-resource-row]")!.querySelectorAll("[data-row-action] button")).map((button) => button.getAttribute("aria-label"));
      expect(actions("tall-ridge")).toEqual(["Open simulator", "tall-ridge actions"]);
      expect(actions("calm-otter")).toEqual(["Open terminal", "calm-otter actions"]);
      fireEvent.click(slot.getByRole("button", { name: "tall-ridge actions" }));
      expect((await screen.findAllByRole("menuitem")).map((item) => item.textContent)).toEqual(expect.arrayContaining(["Open simulator", "Open desktop", "Open terminal", "Stop"]));
    });
  } finally {
    window.matchMedia = wide;
  }
});

test("F-22c: a row's badges rank its device's word first, then Shared, then its form, then Desktop, then the rest", () => {
  const ranks = (one: BoxView, machine = false) => boxTitleBadges(one, machine).map((badge) => `${badge.label} ${badge.rank}`);
  expect(ranks(SHARED_IOS)).toEqual(["Simulator 0", "Shared 1"]);
  expect(ranks(DEDICATED_IOS)).toEqual(["Simulator 0", "Desktop 3", "VM 2"]);
  expect(ranks(ANDROID)).toEqual(["Emulator 0", "VM 2"]);
  expect(ranks(LINUX_DESKTOP, true)).toEqual(["Desktop 3", "GPU 4", "LXC 2", "BB machine 2"]);
});

test("F-22c: at 360 px an android row shows Emulator before VM, and a shared ios row Simulator, then Shared, before anything else", async () => {
  const compact = (query: string) => ({ matches: query === "(max-width: 767px)", media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false });
  const wide = window.matchMedia;
  window.matchMedia = compact as unknown as typeof window.matchMedia;
  try {
    await withRowLayout(188, async () => {
      const slot = panel(server([ANDROID, SHARED_IOS]).handlers);
      await slot.findByText("green-bay");
      expect(shownTitle(slot.getByRole("button", { name: "green-bay: details" }))).toEqual({ name: "green-bay", parts: ["Android", "Emulator"], cut: null });
      expect(shownTitle(slot.getByRole("button", { name: "brisk-wren: details" }))).toEqual({ name: "brisk-wren", parts: ["iOS", "Simulator"], cut: null });
    });
    await withRowLayout(250, async () => {
      const slot = panel(server([ANDROID, SHARED_IOS]).handlers);
      await slot.findByText("green-bay");
      expect(shownTitle(slot.getByRole("button", { name: "green-bay: details" }))).toEqual({ name: "green-bay", parts: ["Android", "Pixel 8", "Emulator", "VM"], cut: "33px" });
      expect(shownTitle(slot.getByRole("button", { name: "brisk-wren: details" }))).toEqual({ name: "brisk-wren", parts: ["iOS", "Simulator", "Shared"], cut: null });
    });
  } finally {
    window.matchMedia = wide;
  }
});

test("F-22d: on a device box the system word gives way before the device badge, which says it already; a row with room keeps both", () => {
  const android = { name: 80, system: 45, model: 38, badges: [{ width: 56, rank: 0, outranksSystem: true }, { width: 30, rank: 2 }] };
  expect(fitTitle({ room: 188, ...android })).toEqual({ nameRoom: null, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: [true, true] });
  expect(fitTitle({ room: 300, ...android })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: true, showsBadge: [true, true] });
  expect(fitTitle({ room: 188, ...android, badges: android.badges.map(({ width, rank }) => ({ width, rank })) })).toEqual({ nameRoom: null, showsSystem: true, modelRoom: null, showsModel: false, showsBadge: [false, true] });
  expect(fitTitle({ room: 120, ...android })).toEqual({ nameRoom: null, showsSystem: false, modelRoom: null, showsModel: false, showsBadge: [false, false] });
});

test("F-22d: at 360 px an android row whose name leaves no room for Emulator beside Android shows its name, Emulator and VM", async () => {
  await withRowLayout(188, async () => {
    const slot = panel(server([{ ...ANDROID, name: "vivid-badger" }, box()]).handlers);
    await slot.findByText("vivid-badger");
    expect(shownTitle(slot.getByRole("button", { name: "vivid-badger: details" }))).toEqual({ name: "vivid-badger", parts: ["Emulator", "VM"], cut: null });
    expect(shownTitle(slot.getByRole("button", { name: "calm-otter: details" }))).toEqual({ name: "calm-otter", parts: ["Linux", "LXC"], cut: null });
  });
});
