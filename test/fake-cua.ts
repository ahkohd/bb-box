// A fake Cua Driver for tests: `cua-driver mcp --socket <file>` speaks MCP on
// stdin and stdout, like the real proxy, with the tools and results bb-box
// uses. The desktop it drives lives in the JSON file named by --socket, so
// every session of a box sees one desktop, and a test can change it between
// calls. Element tokens hold a prefix of the process's own, so like Cua's
// they die with the session, and the number of the window's read they came
// from, so like Cua's they go stale when the window is read again. Element
// frames are in the screen's pixels, unless the window has ownFrames. A read
// stops at max_elements.
//
// The desktop has Tasks windows: a list of tasks, each with a "Delete Task N"
// button, a "New task" field that refuses background typing, an Add button
// and a "Clear all" button that opens a modal dialog. A right click in one
// opens a context menu, which, like a real one, is missing from the window
// list and never becomes the active window: keys reach it only on the
// desktop, where Escape closes it. With misreadPopups, a read of a menu gives
// its window's elements instead, as Cua does for some popups. A window of
// app "wide" is wider than the longest edge BB Box gives the agent. A click
// on the desktop works only in the foreground. Like Cua, it takes pixels of
// the session's latest image of the desktop, or of the screen before one.
//
// App "editor" is like Mousepad, as is app "mousepad", which the conformance
// suite opens: a text area named after its text, inside a tab named after the
// document, which gains a "*" once edited, as does the editor's title. Both
// are single-instance: launched again while open, they show a new document
// in the window they have and fail as Cua does when it hands a launch to a
// running app over D-Bus and no new window appears. A URL
// opens in app "browser", whose window is titled "Untitled" until its page
// loads; a URL with "slow" in it never does. A second URL goes to the browser
// window already open, whose title is the URL while it loads, as Chrome's is.
// Its page gives each word, and each letter, of some text a line of its own,
// as Chrome does, and has names made only of U+FFFC.
//
// With mac, it is like Cua on macOS: launch_app takes a name or bundle ID,
// not a path, and finds by name only apps in /Applications and
// /System/Applications, not Finder or Archive Utility in
// /System/Library/CoreServices. Finder always runs, and opens a new window
// only for a folder in urls that no window of its own shows already, a
// little after the launch, which gives no new window. Each
// Finder launch also has CursorUIViewService, another process, open a small
// window off screen. Calculator, launched again while open, opens no window
// and gives its window as the launch's.
//
// Like Cua, it finds a window's tree by where the window is: of two windows
// of one app within 20 pixels of each other, a read of either gives the
// first's tree. set_window_frame moves a window, unless it is maximised.
//
// With wayland, it is like Cua on a Wayland desktop: a click on an element
// with no action fails, as Cua clicks it through X11, and a click by pixels
// and typing work only in the foreground. A window with noActions has
// elements with no actions, as a GTK tab or row has none. A window with
// ownFrames gives its elements' frames in its own pixels, as a GTK 3 app on
// Wayland does. A read of a window that has closed gives another of its
// app's windows' tree, with no title, bounds or app (#402).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

export interface FakeWindow {
  id: number;
  pid: number;
  app: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onScreen: boolean;
  /** The Tasks window a dialog belongs to. */
  dialogOf?: number;
  /** The window a context menu belongs to. */
  menuOf?: number;
  /** Every task's button is named "Delete", as rows' buttons often are. */
  plainButtons?: boolean;
  /** set_window_frame leaves it where it is. */
  maximised?: boolean;
  /** Its elements have no actions. */
  noActions?: boolean;
  /** Its elements' frames are in its own pixels, as a GTK 3 app's are on Wayland. */
  ownFrames?: boolean;
  /** A "Show older tasks" button lies partly above it, scrolled out of view. */
  olderTasks?: boolean;
}

export interface FakeDesktop {
  screen: { width: number; height: number };
  windows: FakeWindow[];
  /** The tasks of each Tasks window. */
  tasks: Record<string, string[]>;
  /** The "New task" field of each Tasks window, or the text of each editor. */
  fields: Record<string, string>;
  /** The URL each browser window shows. */
  pages?: Record<string, string>;
  nextWindow: number;
  nextPid: number;
  delays: Record<string, number>;
  armReadDelay?: boolean;
  /** The tools called, with their arguments, in order. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** How many sessions have started. */
  sessions: number;
  /** A session the driver has ended by itself, by number, while keeping its connection: every call in it is refused (#662). */
  endedSession?: number;
  /** A read of a menu gives its window's elements, moved to the menu. */
  misreadPopups?: boolean;
  /** A Tasks window's tree holds the items of its open menu, as a GTK app's does. */
  menusInWindow?: boolean;
  /** Cua is on Wayland. */
  wayland?: boolean;
  /** Cua is on macOS. */
  mac?: boolean;
  sessionlessLikeCuaBefore030?: boolean;
  endedNamedSessions?: string[];
  agentCursorShownBySession?: Record<string, boolean>;
  cursorShowsRefused?: number;
  /** How many more launches by name Windows' shell cannot look up yet, as just after a box starts. */
  lookupBusy?: number;
  /** As Cua on Windows: a window with no title is neither listed nor read (#365). */
  untitledUnlisted?: boolean;
  /** A dialog's button closes it 100 ms after the click, as a GTK dialog does, not at once. */
  closesLate?: boolean;
  /** Meanwhile a read of the closing dialog fails with no reason, as Cua on Windows does. */
  closingUnreadable?: boolean;
  /** Dialogs closing late, by window ID. */
  closing?: number[];
  /**
   * A click opens another process's panel, as a Windows tray icon does, and
   * Cua on Windows then says the click failed its foreground check (#484).
   */
  trayMenus?: boolean;
  passwords?: Record<string, string>;
  signInFocus?: Record<string, string>;
  showsPasswords?: boolean;
  typingFailsEchoingText?: boolean;
}

const desktopPause = new Int32Array(new SharedArrayBuffer(4));

export function writeDesktopFile(file: string, desktop: FakeDesktop): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(desktop));
  renameSync(temp, file);
}

export function readDesktopFile(file: string): FakeDesktop {
  const deadline = performance.now() + 1_000;
  for (;;) {
    try {
      return JSON.parse(readFileSync(file, "utf8")) as FakeDesktop;
    } catch (error) {
      if (!(error instanceof SyntaxError) || performance.now() >= deadline) throw error;
    }
    Atomics.wait(desktopPause, 0, 0, 2);
  }
}

export function emptyDesktop(): FakeDesktop {
  return {
    screen: { width: 1920, height: 1080 },
    windows: [],
    tasks: {},
    fields: {},
    nextWindow: 100,
    nextPid: 5000,
    delays: {},
    calls: [],
    sessions: 0,
  };
}

/** A desktop with one Tasks window of three tasks. */
export function tasksDesktop(): FakeDesktop {
  const desktop = emptyDesktop();
  openTasks(desktop, ["Task 1", "Task 2", "Task 3"]);
  return desktop;
}

export function openTasks(desktop: FakeDesktop, tasks: string[]): FakeWindow {
  const window: FakeWindow = { id: desktop.nextWindow++, pid: desktop.nextPid++, app: "tasks", title: "Tasks", x: 100, y: 100, width: 800, height: 600, onScreen: true };
  desktop.windows.push(window);
  desktop.tasks[window.id] = tasks;
  desktop.fields[window.id] = "";
  return window;
}

export function openSignIn(desktop: FakeDesktop): FakeWindow {
  const window: FakeWindow = { id: desktop.nextWindow++, pid: desktop.nextPid++, app: "signin", title: "Sign in", x: 100, y: 100, width: 600, height: 400, onScreen: true };
  desktop.windows.push(window);
  desktop.fields[window.id] = "";
  desktop.passwords = { ...desktop.passwords, [window.id]: "" };
  return window;
}

/** A solid PNG of the size. */
export function png(width: number, height: number): string {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3, 0x80);
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

interface Node {
  key: string;
  role: string;
  label: string;
  value?: string;
  actions: string[];
  frame: { x: number; y: number; width: number; height: number };
  children: Node[];
  /** A line without an index: text that cannot be acted on. */
  text?: boolean;
}

interface Flat {
  node: Node;
  index: number;
  depth: number;
  parent: number | null;
}

type Args = Record<string, unknown>;
interface Result {
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Another process's panel opens, as Explorer's overflow does, and Cua on Windows says the click failed its foreground check (#484). */
function trayPanel(desktop: FakeDesktop, target: number): Result {
  const panel = { id: desktop.nextWindow++, pid: desktop.nextPid++, app: "explorer", title: "Notification overflow", x: 1600, y: 900, width: 200, height: 120, onScreen: true };
  desktop.windows.push(panel);
  const hex = (id: number) => `0x${id.toString(16)}`;
  return text(`Exact target HWND ${hex(target)} or a verified same-process post-action window was not foreground after the click (actual foreground HWND ${hex(panel.id)}).`, undefined, true);
}

function text(message: string, structured?: Record<string, unknown>, isError = false): Result {
  return { content: [{ type: "text", text: message }], structuredContent: structured, isError };
}

/** Whether the window is an editor's, which takes text in the background but on Wayland. */
function isEditor(window: FakeWindow): boolean {
  return window.app === "editor" || window.app === "mousepad";
}

function tree(desktop: FakeDesktop, window: FakeWindow): Node {
  const strip = (node: Node): Node => ({ ...node, actions: [], children: node.children.map(strip) });
  return window.noActions ? strip(shape(desktop, window)) : shape(desktop, window);
}

function shape(desktop: FakeDesktop, window: FakeWindow): Node {
  const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  if (window.dialogOf !== undefined) {
    return {
      key: "dialog",
      role: "dialog",
      label: window.title,
      actions: [],
      frame: frame(0, 0, window.width, window.height),
      children: [
        { key: "question", role: "label", label: "Delete every task?", actions: [], frame: frame(20, 20, 260, 20), children: [], text: true },
        { key: "cancel", role: "push button", label: "Cancel", actions: ["click"], frame: frame(20, 100, 100, 30), children: [] },
        { key: "clear", role: "push button", label: "Clear", actions: ["click"], frame: frame(180, 100, 100, 30), children: [] },
      ],
    };
  }
  if (window.menuOf !== undefined) {
    return {
      key: "menu",
      role: "menu",
      label: "",
      actions: [],
      frame: frame(0, 0, window.width, window.height),
      children: ["Rename", "Delete"].map((item, at) => ({ key: `menu:${item}`, role: "menu item", label: item, actions: ["click"], frame: frame(0, at * 30, window.width, 30), children: [] })),
    };
  }
  const whole = frame(0, 0, window.width, window.height);
  if (isEditor(window)) {
    const edited = desktop.fields[window.id] ? "*" : "";
    const typed = desktop.fields[window.id] ?? "";
    const area: Node = { key: "document", role: "text", label: typed, value: typed, actions: [], frame: frame(0, 60, window.width, window.height - 60), children: [] };
    const pane: Node = { key: "pane", role: "scroll pane", label: "", actions: [], frame: area.frame, children: [area] };
    const tab: Node = { key: "tab", role: "page tab", label: `${edited}Untitled 1`, actions: ["click"], frame: frame(0, 30, 120, 30), children: [pane] };
    return { key: "frame", role: "frame", label: window.title, actions: [], frame: whole, children: [tab] };
  }
  if (window.app === "browser") {
    const url = desktop.pages?.[window.id] ?? "about:blank";
    const statics = (key: string, pieces: string[]): Node[] =>
      pieces.map((piece, at) => ({ key: `${key}:${at}`, role: "static", label: piece, actions: [], frame: whole, children: [], text: true }));
    const results: Node[] = Array.from({ length: 60 }, (_, at) => ({
      key: `result:${at + 1}`,
      role: "list item",
      label: "",
      actions: [],
      frame: whole,
      children: statics(`result:${at + 1}`, ["Result", String(at + 1)]),
    }));
    const page: Node = {
      key: "page",
      role: "document web",
      label: hostname(url),
      actions: [],
      frame: whole,
      children: [
        { key: "heading", role: "heading", label: "Welcome", actions: [], frame: whole, children: [], text: true },
        ...statics("words", "The quick brown fox jumps over the lazy dog.".split(" ")),
        { key: "more", role: "link", label: "Read more", actions: ["click"], frame: whole, children: [] },
        ...statics("letters", [..."Hello world"]),
        { key: "object", role: "link", label: "\uFFFC", actions: ["click"], frame: whole, children: [] },
        { key: "objects", role: "static", label: "\uFFFC\uFFFC", actions: [], frame: whole, children: [], text: true },
        { key: "results", role: "list", label: "Results", actions: [], frame: whole, children: results },
      ],
    };
    return { key: "frame", role: "frame", label: window.title, actions: [], frame: whole, children: [page] };
  }
  if (window.app === "signin") {
    const password = desktop.passwords?.[window.id] ?? "";
    const shown = desktop.showsPasswords ? password : "\u2022".repeat([...password].length);
    return {
      key: "frame",
      role: "frame",
      label: window.title,
      actions: [],
      frame: whole,
      children: [
        { key: "email", role: "text", label: "Email", value: desktop.fields[window.id] ?? "", actions: [], frame: frame(20, 40, 400, 40), children: [] },
        { key: "password", role: desktop.mac ? "AXSecureTextField" : "password text", label: "Password", value: shown, actions: [], frame: frame(20, 100, 400, 40), children: [] },
        { key: "signin", role: "push button", label: "Sign in", actions: ["click"], frame: frame(20, 160, 120, 40), children: [] },
      ],
    };
  }
  if (window.app !== "tasks") {
    return { key: "frame", role: "frame", label: window.title, actions: [], frame: whole, children: [] };
  }
  const tasks = desktop.tasks[window.id] ?? [];
  return {
    key: "frame",
    role: "frame",
    label: window.title,
    actions: [],
    frame: frame(0, 0, window.width, window.height),
    children: [
      { key: "heading", role: "heading", label: "My tasks", actions: [], frame: frame(0, 0, 800, 30), children: [], text: true },
      ...(window.olderTasks ? [{ key: "older", role: "push button", label: "Show older tasks", actions: ["click"], frame: frame(20, -10, 200, 40), children: [] }] : []),
      {
        key: "list",
        role: "list",
        label: "Tasks",
        actions: [],
        frame: frame(0, 40, 800, 440),
        children: tasks.map((task, at) => ({
          key: `item:${task}`,
          role: "list item",
          label: task,
          actions: [],
          frame: frame(0, 40 + at * 40, 800, 40),
          children: [{ key: `delete:${task}`, role: "push button", label: window.plainButtons ? "Delete" : `Delete ${task}`, actions: ["click"], frame: frame(700, 45 + at * 40, 90, 30), children: [] }],
        })),
      },
      { key: "field", role: "text", label: "New task", value: desktop.fields[window.id] ?? "", actions: [], frame: frame(0, 520, 600, 40), children: [] },
      { key: "add", role: "push button", label: "Add", actions: ["click"], frame: frame(620, 520, 80, 40), children: [] },
      { key: "clear", role: "push button", label: "Clear all", actions: ["click"], frame: frame(710, 520, 80, 40), children: [] },
      ...(desktop.menusInWindow ? desktop.windows.filter((menu) => menu.menuOf === window.id).map((menu) => tree(desktop, menu)) : []),
    ],
  };
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function flatten(root: Node): Flat[] {
  const out: Flat[] = [];
  const walk = (node: Node, depth: number, parent: number | null) => {
    const index = out.length;
    out.push({ node, index, depth, parent });
    for (const child of node.children) walk(child, depth + 1, index);
  };
  walk(root, 0, null);
  return out;
}

function markdown(flat: Flat[]): string {
  return flat
    .map(({ node, index, depth }) => {
      const indent = "  ".repeat(depth);
      if (node.text) return `${indent}- ${node.role} = "${node.label}"`;
      const value = node.value !== undefined ? ` value="${node.value}"` : "";
      return `${indent}- [${index}] ${node.role} "${node.label}"${value} [actions=[${node.actions.join(",")}]]`;
    })
    .join("\n");
}

/** The size Cua gives a window's image: at most 1.15 MP, or at most `max` on the longest edge when given. */
function shotSize(width: number, height: number, max: number | undefined): { width: number; height: number } {
  const scale = max !== undefined ? Math.min(1, max / Math.max(width, height)) : Math.min(1, Math.sqrt(1_150_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const LIFECYCLE_TOOLS = ["start_session", "set_agent_cursor_enabled", "end_session"];
const TOOLS_TAKING_SESSION = ["get_window_state", "get_desktop_state", "click", "scroll", "type_text", "press_key", "set_value", "set_window_frame", ...LIFECYCLE_TOOLS];
const TOOLS_WITHOUT_SESSION = ["list_windows", "launch_app", "list_apps", "bring_to_front", "kill_app"];

export class FakeCua {
  readonly #file: string | null;
  #memory: FakeDesktop;
  readonly #prefix = randomBytes(4).toString("hex");
  /** Per window, the size of the screenshot of the latest get_window_state, or null for none. */
  readonly #shots = new Map<number, { width: number; height: number } | null>();
  /** Per window, how many times this session read it. */
  readonly #reads = new Map<number, number>();
  /** How this session's latest image of the desktop scales to the screen, as Cua maps desktop pixels by it; null before the first. */
  #frame: { x: number; y: number } | null = null;
  #captures = 0;

  constructor(socket: string) {
    // Only a file under the box's home holds the desktop; any other socket gets a desktop of its own.
    this.#file = isAbsolute(socket) ? null : socket;
    this.#memory = this.#file && existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as FakeDesktop) : emptyDesktop();
    this.#session = this.#change((desktop) => ++desktop.sessions);
  }

  readonly #session: number;

  #load(): FakeDesktop {
    if (this.#file && existsSync(this.#file)) this.#memory = readDesktopFile(this.#file);
    return this.#memory;
  }

  #change<T>(update: (desktop: FakeDesktop) => T): T {
    const desktop = this.#load();
    const result = update(desktop);
    if (this.#file) writeDesktopFile(this.#file, desktop);
    return result;
  }

  #callSession = "";

  #token(window: FakeWindow, key: string): string {
    return `${this.#prefix}|${window.id}|${this.#reads.get(window.id) ?? 0}|${key}|${this.#callSession}`;
  }

  #window(desktop: FakeDesktop, args: Args): FakeWindow | Result {
    const window = desktop.windows.find((candidate) => candidate.id === args.window_id);
    if (window && desktop.untitledUnlisted && !window.title.trim() && window.menuOf === undefined) {
      return text(`No window with window_id ${window.id} exists. Call \`list_windows({"pid": ${window.pid}})\` for candidates.`, { code: "window_not_found" }, true);
    }
    if (!window || (args.pid !== undefined && window.pid !== args.pid)) {
      return text(`window_id ${String(args.window_id)} is stale or no longer running; refresh list_windows.`, { code: "stale_window" }, true);
    }
    return window;
  }

  #windowJson(window: FakeWindow) {
    return {
      window_id: window.id,
      pid: window.pid,
      app_name: window.app,
      title: window.title,
      bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
      is_on_screen: window.onScreen,
      z_index: window.id,
    };
  }

  tools(): { name: string; inputSchema: { type: "object"; properties: Record<string, unknown> } }[] {
    const sessions = !this.#load().sessionlessLikeCuaBefore030;
    const names = [...TOOLS_WITHOUT_SESSION, ...(sessions ? TOOLS_TAKING_SESSION : TOOLS_TAKING_SESSION.filter((name) => !LIFECYCLE_TOOLS.includes(name)))];
    return names.map((name) => ({ name, inputSchema: { type: "object", properties: sessions && TOOLS_TAKING_SESSION.includes(name) ? { session: { type: "string" } } : {} } }));
  }

  #lifecycle(tool: string, args: Args): Result | null {
    const session = typeof args.session === "string" ? args.session : null;
    const desktop = this.#load();
    if (session !== null && (desktop.sessionlessLikeCuaBefore030 || !TOOLS_TAKING_SESSION.includes(tool))) return text(`${tool} takes no session.`, { code: "invalid_arguments" }, true);
    if (!LIFECYCLE_TOOLS.includes(tool) && !(session !== null && desktop.endedNamedSessions?.includes(session))) return null;
    if (desktop.sessionlessLikeCuaBefore030) return text(`Unknown tool ${tool}.`, { code: "unknown_tool" }, true);
    if (tool === "start_session") {
      this.#change((changed) => void (changed.endedNamedSessions = (changed.endedNamedSessions ?? []).filter((name) => name !== session)));
      return text(`Session '${session ?? "implicit"}' is active.`, { active: true, session: session ?? "implicit" });
    }
    if (session !== null && desktop.endedNamedSessions?.includes(session)) return text(`session has ended; tool call '${tool}' was rejected. Call start_session with session '${session}' to start it again, or use a new session label.`, undefined, true);
    if (tool === "set_agent_cursor_enabled") {
      if (args.enabled === true && (desktop.cursorShowsRefused ?? 0) > 0) {
        this.#change((changed) => void (changed.cursorShowsRefused = (changed.cursorShowsRefused ?? 1) - 1));
        return text("The agent cursor's overlay is not ready.", { code: "overlay_unavailable" }, true);
      }
      this.#change((changed) => void (changed.agentCursorShownBySession = { ...changed.agentCursorShownBySession, [session ?? ""]: args.enabled === true }));
      return text(`Agent cursor for session '${session}' ${args.enabled === true ? "enabled" : "disabled"}.`);
    }
    this.#change((changed) => {
      const left = { ...changed.agentCursorShownBySession };
      delete left[session ?? ""];
      changed.agentCursorShownBySession = left;
      changed.endedNamedSessions = [...(changed.endedNamedSessions ?? []), session ?? ""];
    });
    return text(`Session '${session}' ended.`);
  }

  async call(tool: string, args: Args): Promise<Result> {
    const delay = this.#change((desktop) => {
      desktop.calls.push({ tool, args });
      const afterRead = desktop.delays.afterRead ?? 0;
      if (tool === "get_window_state" && desktop.armReadDelay) {
        desktop.armReadDelay = false;
        return afterRead;
      }
      if (afterRead && (tool === "type_text" || tool === "press_key" || tool === "click")) desktop.armReadDelay = true;
      return desktop.delays[tool] ?? 0;
    });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (this.#load().endedSession === this.#session) return text(`Session 'mcp-${this.#session}' has ended; tool call '${tool}' was rejected.`, undefined, true);
    this.#callSession = typeof args.session === "string" ? args.session : "";
    const lifecycle = this.#lifecycle(tool, args);
    if (lifecycle) return lifecycle;
    switch (tool) {
      case "list_windows":
        return this.#listWindows();
      case "get_window_state":
        return this.#state(args);
      case "get_desktop_state":
        return this.#desktop(args);
      case "click":
        return this.#click(args);
      case "scroll":
        return text(`Scrolled ${String(args.direction)}.`, { verified: false });
      case "type_text":
        return this.#type(args);
      case "press_key":
        return this.#press(args);
      case "set_value":
        return this.#setValue(args);
      case "launch_app":
        return this.#launch(args);
      case "list_apps":
        return this.#apps();
      case "set_window_frame":
        return this.#move(args);
      case "bring_to_front":
        return this.#front(args);
      case "kill_app":
        return this.#kill(args);
      default:
        return text(`Unknown tool ${tool}.`, { code: "unknown_tool" }, true);
    }
  }

  #front(args: Args): Result {
    const desktop = this.#load();
    const window = this.#window(desktop, args);
    if (!("id" in window)) return window;
    return text(`Brought window ${window.id} to the front.`, { platform: "linux", session: desktop.wayland ? "wayland" : "x11", window_id: window.id });
  }

  #kill(args: Args): Result {
    return this.#change((desktop) => {
      if (!desktop.windows.some((window) => window.pid === args.pid)) return text(`No process ${String(args.pid)}.`, { code: "no_such_process" }, true);
      desktop.windows = desktop.windows.filter((window) => window.pid !== args.pid);
      return text(`Killed ${String(args.pid)}.`, { pid: args.pid, killed: true });
    });
  }

  #move(args: Args): Result {
    return this.#change((desktop) => {
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      if (window.maximised) return text("The window frame did not settle at the requested geometry.", { effect: "suspected_noop" });
      Object.assign(window, { x: args.x, y: args.y, width: args.width, height: args.height });
      return text("Set and verified the requested window frame.", { effect: "confirmed" });
    });
  }

  #listWindows(): Result {
    const desktop = this.#load();
    const windows = desktop.windows.filter((window) => window.menuOf === undefined && !(desktop.untitledUnlisted && !window.title.trim())).map((window) => this.#windowJson(window));
    return text(`${windows.length} windows.`, { windows });
  }

  #state(args: Args): Result {
    const desktop = this.#load();
    let window = this.#window(desktop, args);
    // As Cua on Sway: a window it no longer lists reads as another of its app's windows, with no title, bounds or app of its own (#402).
    const standIn = !("id" in window) && desktop.wayland ? desktop.windows.find((other) => other.pid === args.pid && other.menuOf === undefined) : undefined;
    if (standIn) window = standIn;
    if (!("id" in window)) return window;
    if (desktop.closingUnreadable && desktop.closing?.includes(window.id)) return text("", undefined, true);
    this.#reads.set(window.id, (this.#reads.get(window.id) ?? 0) + 1);
    const owner = desktop.windows.find((other) => other.id === window.menuOf);
    const placed = owner
      ? window
      : (desktop.windows.find((other) => other.pid === window.pid && other.menuOf === undefined && Math.abs(other.x - window.x) <= 20 && Math.abs(other.y - window.y) <= 20) ?? window);
    let flat = flatten(tree(desktop, desktop.misreadPopups && owner ? owner : placed));
    const all = flat.filter((entry) => !entry.node.text);
    const budget = typeof args.max_elements === "number" ? args.max_elements : Infinity;
    const truncated = all.length > budget;
    if (truncated) flat = flat.filter((entry) => entry.index <= all[budget - 1]!.index);
    const elements = all.slice(0, budget).map((entry) => ({
      element_index: entry.index,
      role: entry.node.role,
      depth: entry.depth,
      element_token: this.#token(window, entry.node.key),
      label: entry.node.label,
      value: entry.node.value ?? null,
      enabled: true,
      actions: entry.node.actions,
      parent_index: entry.parent,
      frame: { x: (placed.ownFrames ? 0 : placed.x) + entry.node.frame.x, y: (placed.ownFrames ? 0 : placed.y) + entry.node.frame.y, w: entry.node.frame.width, h: entry.node.frame.height },
    }));
    const dialogs = desktop.windows
      .filter((other) => other.dialogOf === window.id)
      .map((dialog) => ({ window_id: dialog.id, title: dialog.title, transient_for: window.id, modal: true, bounds: { x: dialog.x, y: dialog.y, width: dialog.width, height: dialog.height } }));
    const structured: Record<string, unknown> = {
      window_id: standIn ? args.window_id : window.id,
      pid: window.pid,
      element_count: elements.length,
      // As on macOS and Windows, where Cua cannot prove that nothing is missing.
      elements_complete: false,
      truncated,
      ...(truncated ? { truncation_reason: "node_budget" } : {}),
      elements,
      snapshot_id: `${this.#prefix}-${Date.now()}`,
      ...(standIn ? {} : { app_name: window.app, window_title: window.title, window_bounds: { x: window.x, y: window.y, width: window.width, height: window.height } }),
      dialogs,
      popups: desktop.windows.filter((other) => other.menuOf === window.id).map((menu) => ({ ...this.#windowJson(menu), override_redirect: true })),
      tree_markdown: markdown(flat),
    };
    const content: Result["content"] = [{ type: "text", text: `${elements.length} elements.` }];
    if (args.include_screenshot === false) {
      this.#shots.set(window.id, null);
    } else {
      const size = shotSize(window.width, window.height, typeof args.max_image_dimension === "number" ? args.max_image_dimension : undefined);
      this.#shots.set(window.id, size);
      structured.screenshot_width = size.width;
      structured.screenshot_height = size.height;
      content.push({ type: "image", data: png(size.width, size.height), mimeType: "image/png" });
    }
    return { content, structuredContent: structured };
  }

  #desktop(args: Args): Result {
    const desktop = this.#load();
    const { width, height } = desktop.screen;
    const size = shotSize(width, height, typeof args.max_image_dimension === "number" ? args.max_image_dimension : undefined);
    this.#frame = { x: width / size.width, y: height / size.height };
    return {
      content: [
        { type: "text", text: "The desktop." },
        { type: "image", data: png(size.width, size.height), mimeType: "image/png" },
      ],
      structuredContent: {
        screenshot_width: size.width,
        screenshot_height: size.height,
        screen_width: width,
        screen_height: height,
        scale_factor: 1,
        windows: desktop.windows.map((window) => this.#windowJson(window)),
        capture_id: `${this.#prefix}-desktop-${++this.#captures}`,
      },
    };
  }

  /** The element a token names, in the window as it is now. */
  #element(desktop: FakeDesktop, window: FakeWindow, token: unknown): Node | Result {
    if (typeof token !== "string") return text("Give element_token or x and y.", { code: "invalid_arguments" }, true);
    const [prefix, id, read, key, session] = token.split("|");
    if (prefix !== this.#prefix) return text("element_token is not from this session. Call get_window_state again.", { code: "stale_token" }, true);
    if (session && desktop.endedNamedSessions?.includes(session)) return text("element_token is stale; call get_window_state again to refresh", { status: "refused", refusal: { code: "stale_element_token" } }, true);
    if (Number(id) !== window.id) return text("element_token belongs to another window.", { code: "invalid_arguments" }, true);
    if (Number(read) !== this.#reads.get(window.id)) {
      return text("element_token is stale; call get_window_state again to refresh", { status: "refused", refusal: { code: "stale_element_token" } }, true);
    }
    const node = flatten(tree(desktop, window)).find((entry) => entry.node.key === key)?.node;
    return node ?? text("The element is no longer in the window. Call get_window_state again.", { code: "stale_element" }, true);
  }

  #click(args: Args): Result {
    return this.#change((desktop) => {
      if (args.pid === undefined && args.window_id === undefined) {
        if (args.scope !== "desktop") return text('click: x,y given with no pid/window_id requires scope="desktop".', { code: "desktop_coordinate_scope_required" }, true);
        if (args.delivery_mode !== "foreground") {
          return text('Background delivery is not available for scope="desktop"; retry with delivery_mode:"foreground".', {
            code: "background_unavailable",
            effect: "none",
            escalation: { recommended: "foreground" },
          }, true);
        }
        // x and y are pixels of the latest image of the desktop, or of the screen before one.
        const x = Math.round(Number(args.x) * (this.#frame?.x ?? 1));
        const y = Math.round(Number(args.y) * (this.#frame?.y ?? 1));
        // The topmost window at the point gets it, as on a real screen.
        const under = desktop.windows
          .filter((window) => window.onScreen && x >= window.x && x < window.x + window.width && y >= window.y && y < window.y + window.height)
          .sort((a, b) => b.id - a.id)[0];
        if (desktop.trayMenus) return trayPanel(desktop, under?.id ?? 0);
        if (under) this.#activate(desktop, under, hit(desktop, under, x - under.x, y - under.y), args);
        return text(`Sent screen-absolute click at (${x},${y}) (desktop scope).`, { effect: "unverifiable" });
      }
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      let node: Node | Result;
      if (typeof args.x === "number" && typeof args.y === "number") {
        if (desktop.wayland && args.delivery_mode !== "foreground") {
          return text("Background delivery is not available: the requested target has no focus-free input backend.", {
            code: "background_unavailable",
            effect: "none",
            escalation: { recommended: "foreground" },
          }, true);
        }
        const shot = this.#shots.get(window.id);
        if (!shot) return text("A pixel click needs a screenshot from get_window_state of this window first.", { code: "no_screenshot" }, true);
        node = hit(desktop, window, (args.x * window.width) / shot.width, (args.y * window.height) / shot.height);
      } else {
        node = this.#element(desktop, window, args.element_token);
        if (desktop.wayland && "key" in node && !node.actions.length) {
          return text("AT-SPI element click failed: cannot inject input: X11 connection failed (DISPLAY=None): No such file or directory (os error 2)", undefined, true);
        }
      }
      if (!("key" in node)) return node;
      if (desktop.trayMenus) return trayPanel(desktop, window.id);
      this.#activate(desktop, window, node, args);
      return text(`Clicked ${node.role} "${node.label}" (delivery_mode=${String(args.delivery_mode ?? "background")}).`, { verified: true });
    });
  }

  /** What a click on a node does. */
  #activate(desktop: FakeDesktop, window: FakeWindow, node: Node, args: Args): void {
    if (args.button === "right" && window.app === "tasks" && window.dialogOf === undefined && window.menuOf === undefined) {
      desktop.windows.push({ id: desktop.nextWindow++, pid: window.pid, app: window.app, title: "", x: window.x + 50, y: window.y + 50, width: 120, height: 60, onScreen: true, menuOf: window.id });
      return;
    }
    // Any other click closes a context menu.
    desktop.windows = desktop.windows.filter((other) => other.menuOf === undefined || (other.menuOf !== window.id && other.id !== window.id));
    if (window.app === "signin" && (node.key === "email" || node.key === "password")) desktop.signInFocus = { ...desktop.signInFocus, [window.id]: node.key };
    const tasks = desktop.tasks[window.id];
    if (node.key.startsWith("delete:") && tasks) {
      desktop.tasks[window.id] = tasks.filter((task) => `delete:${task}` !== node.key);
    } else if (node.key === "add" && tasks) {
      const name = desktop.fields[window.id];
      if (name) desktop.tasks[window.id] = [...tasks, name];
      desktop.fields[window.id] = "";
    } else if (node.key === "clear" && window.dialogOf === undefined) {
      desktop.windows.push({ id: desktop.nextWindow++, pid: window.pid, app: window.app, title: "Clear all tasks?", x: 300, y: 300, width: 300, height: 150, onScreen: true, dialogOf: window.id });
    } else if (window.dialogOf !== undefined && (node.key === "clear" || node.key === "cancel")) {
      const close = (later: FakeDesktop) => {
        if (node.key === "clear") later.tasks[window.dialogOf!] = [];
        later.windows = later.windows.filter((other) => other.id !== window.id);
      };
      if (desktop.closesLate) {
        desktop.closing = [...(desktop.closing ?? []), window.id];
        setTimeout(() => this.#change(close), 100);
      } else close(desktop);
    }
  }

  #type(args: Args): Result {
    return this.#change((desktop) => {
      if (args.scope === "desktop") return this.#onDesktop(desktop, args, () => {});
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      if (args.element_token !== undefined) {
        const node = this.#element(desktop, window, args.element_token);
        if (!("key" in node)) return node;
        if (node.key !== "field" && node.key !== "document" && node.key !== "email" && node.key !== "password") return text(`${node.role} "${node.label}" does not take text.`, { code: "not_editable" }, true);
        if (window.app === "signin") desktop.signInFocus = { ...desktop.signInFocus, [window.id]: node.key };
      }
      if (desktop.typingFailsEchoingText) return text(`Could not type "${String(args.text)}": the app is not responding.`, undefined, true);
      if (args.delivery_mode !== "foreground" && (!isEditor(window) || desktop.wayland)) {
        return text('Background delivery is not available for this target; retry with delivery_mode:"foreground".', {
          code: "background_unavailable",
          effect: "none",
          escalation: { recommended: "foreground" },
        }, true);
      }
      if (window.app === "signin" && (desktop.signInFocus?.[window.id] ?? "password") === "password") {
        desktop.passwords = { ...desktop.passwords, [window.id]: `${desktop.passwords?.[window.id] ?? ""}${String(args.text)}` };
        return text(`Typed ${String(args.text).length} characters.`, { delivery_mode: String(args.delivery_mode ?? "background") });
      }
      desktop.fields[window.id] = `${desktop.fields[window.id] ?? ""}${String(args.text)}`;
      if (window.app === "editor") window.title = "*Untitled 1 - Editor";
      return text(`Typed ${String(args.text).length} characters.`, { delivery_mode: String(args.delivery_mode ?? "background") });
    });
  }

  #press(args: Args): Result {
    return this.#change((desktop) => {
      if (args.scope === "desktop") {
        return this.#onDesktop(desktop, args, () => {
          // Escape closes the menu on top, where the focus is.
          const menu = desktop.windows.filter((window) => window.menuOf !== undefined).at(-1);
          if (String(args.key).toLowerCase() === "escape" && menu) desktop.windows = desktop.windows.filter((window) => window !== menu);
        });
      }
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      const key = String(args.key).toLowerCase();
      const tasks = desktop.tasks[window.id];
      if ((key === "return" || key === "enter") && tasks) {
        const name = desktop.fields[window.id];
        if (name) desktop.tasks[window.id] = [...tasks, name];
        desktop.fields[window.id] = "";
      } else if (key === "a" && Array.isArray(args.modifiers) && args.modifiers.includes("ctrl")) {
        // Select all, then the next typing replaces it.
        desktop.fields[window.id] = "";
      }
      return text(`Pressed ${String(args.key)}.`, { delivery_mode: String(args.delivery_mode ?? "background") });
    });
  }

  /** Keys or text sent to the desktop, to whatever has the focus: only in the foreground. */
  #onDesktop(desktop: FakeDesktop, args: Args, effect: () => void): Result {
    if (args.pid !== undefined || args.window_id !== undefined) return text('scope="desktop" takes no pid or window_id.', { code: "invalid_arguments" }, true);
    if (args.delivery_mode !== "foreground") {
      return text('Background delivery is not available for scope="desktop"; retry with delivery_mode:"foreground".', {
        code: "background_unavailable",
        effect: "none",
        escalation: { recommended: "foreground" },
      }, true);
    }
    effect();
    return text("Sent to the focused window (desktop scope).", { delivery_mode: "foreground", effect: "unverifiable" });
  }

  #setValue(args: Args): Result {
    return this.#change((desktop) => {
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      const node = this.#element(desktop, window, args.element_token);
      if (!("key" in node)) return node;
      if (node.key !== "field") return text(`${node.role} "${node.label}" has no value to set.`, { code: "not_settable" }, true);
      desktop.fields[window.id] = String(args.value);
      return text("Set the value.", { verified: true });
    });
  }

  #launch(args: Args): Result {
    if (this.#load().mac) return this.#launchMac(args);
    if (Array.isArray(args.urls)) return this.#openUrl(String(args.urls[0]));
    const name = String(args.name ?? args.launch_path ?? "").toLowerCase();
    if (name === "missing") {
      return text(
        `Failed to launch: 'missing' is not an executable on PATH and matches no installed .desktop application. Call list_apps and round-trip its launch_path.`,
        undefined,
        true,
      );
    }
    return this.#change((desktop) => {
      if (desktop.lookupBusy) {
        desktop.lookupBusy--;
        return text(`App name lookup for '${name}' is temporarily unavailable: Windows did not respond to the shell:AppsFolder query within 4s. No app was launched; retry after the shell recovers, or pass an explicit path or aumid.`, undefined, true);
      }
      if (name === "tasks") {
        const window = openTasks(desktop, []);
        return text("Launched tasks.", { pid: window.pid, running: true, windows: [this.#windowJson(window)] });
      }
      if (name === "early") {
        // As Cua on a fresh Wayland box can: the launch names the window as its accessibility side saw it, under an ID
        // no listing has, as Sway's own window, which list_windows gives, has another (#737).
        const pid = desktop.nextPid++;
        const own: FakeWindow = { id: desktop.nextWindow++, pid, app: "early", title: "Untitled 1 - Early [early]", x: 0, y: 0, width: 640, height: 480, onScreen: true };
        desktop.windows.push(own);
        return text("Launched early.", { pid, running: true, windows: [{ ...this.#windowJson(own), window_id: 142278656, title: "Untitled 1 - Early" }] });
      }
      if (name === "textedit") {
        // As on a Mac: a helper of another process opens a window off screen, listed before the app's own.
        const pid = desktop.nextPid++;
        const helper: FakeWindow = { id: desktop.nextWindow++, pid: desktop.nextPid++, app: "CursorUIViewService", title: "", x: 0, y: 0, width: 40, height: 40, onScreen: false };
        const own: FakeWindow = { id: desktop.nextWindow++, pid, app: "TextEdit", title: "Untitled", x: 0, y: 0, width: 640, height: 480, onScreen: true };
        desktop.windows.push(helper, own);
        return text("Launched TextEdit.", { pid, running: true, windows: [this.#windowJson(helper), this.#windowJson(own)] });
      }
      const running = (name === "editor" || name === "mousepad") && desktop.windows.find((window) => window.app === name);
      if (running) {
        const shown = Number(/^Untitled (\d+)/.exec(running.title)?.[1] ?? 1);
        if (name === "editor") running.title = `Untitled ${shown + 1} - Editor`;
        desktop.fields[running.id] = "";
        return text(`'${name}' was handed off for D-Bus activation but no new window appeared within 8s; the launch could not be confirmed.`, {
          code: "launch_handoff_timeout",
          effect: "refused",
          handoff: "dbus_activation",
          launcher_pid: desktop.nextPid++,
          name,
          pid: null,
          running: null,
          waited_secs: 8,
        }, true);
      }
      // Other apps open their window a little later, as a slow app does.
      const pid = desktop.nextPid++;
      const id = desktop.nextWindow++;
      const wide = name === "wide";
      setTimeout(() => {
        this.#change((later) => {
          const title = name === "editor" ? "Untitled 1 - Editor" : name === "untitled" ? "" : name;
          later.windows.push({ id, pid, app: name, title, x: 0, y: 0, width: wide ? 4000 : 640, height: wide ? 200 : 480, onScreen: true });
        });
      }, 200);
      return text(`Launched ${name}.`, { pid, running: true, windows: [] });
    });
  }

  #launchMac(args: Args): Result {
    const byName: Record<string, string> = { calculator: "com.apple.calculator", textedit: "com.apple.TextEdit" };
    const known = ["com.apple.finder", "com.apple.archiveutility", ...Object.values(byName)];
    if (args.bundle_id === undefined && args.name === undefined) return text("Provide either bundle_id or name to identify the app to launch.", undefined, true);
    const bundle = args.bundle_id !== undefined ? String(args.bundle_id) : (byName[String(args.name).toLowerCase()] ?? known.find((id) => id === args.name));
    if (!bundle || !known.includes(bundle)) {
      const [field, value] = args.bundle_id !== undefined ? ["bundle_id", args.bundle_id] : ["name", args.name];
      return text(`No installed macOS app found for ${field} '${String(value)}'.`, { error: "APP_NOT_INSTALLED", [field]: value }, true);
    }
    return this.#change((desktop) => {
      const app = { "com.apple.finder": "Finder", "com.apple.archiveutility": "Archive Utility", "com.apple.calculator": "Calculator", "com.apple.TextEdit": "TextEdit" }[bundle]!;
      const open = desktop.windows.find((window) => window.app === app);
      const pid = open?.pid ?? (app === "Finder" ? 400 : desktop.nextPid++);
      const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
      if (open && !(app === "Finder" && urls.length)) return text(`Launched ${app}.`, { pid, bundle_id: bundle, running: true, windows: [this.#windowJson(open)] });
      if (app === "Finder") desktop.windows.push({ id: desktop.nextWindow++, pid: 401, app: "CursorUIViewService", title: "", x: 0, y: 0, width: 64, height: 64, onScreen: false });
      if (app === "Finder" && !urls.length) return text("Launched Finder.", { pid, bundle_id: bundle, running: true, windows: [] });
      if (app === "Finder" && desktop.windows.some((each) => each.app === "Finder" && each.title === "box")) return text("Launched Finder.", { pid, bundle_id: bundle, running: true, windows: [] });
      const window: FakeWindow = { id: desktop.nextWindow++, pid, app, title: app === "Finder" ? "box" : app, x: 0, y: 0, width: 640, height: 480, onScreen: true };
      if (app === "Finder") {
        setTimeout(() => this.#change((later) => void later.windows.push(window)), 300);
        return text("Launched Finder.", { pid, bundle_id: bundle, running: true, windows: [] });
      }
      desktop.windows.push(window);
      return text(`Launched ${app}.`, { pid, bundle_id: bundle, running: true, windows: [this.#windowJson(window)] });
    });
  }

  /** Opens a URL in the browser window already open, or in a new one a little later. */
  #openUrl(url: string): Result {
    return this.#change((desktop) => {
      const loaded = (id: number) => {
        if (url.includes("slow")) return;
        setTimeout(() => {
          this.#change((later) => {
            const window = later.windows.find((candidate) => candidate.id === id);
            if (window && later.pages?.[id] === url) window.title = `Welcome to ${hostname(url)} - Browser`;
          });
        }, 600);
      };
      const open = desktop.windows.find((window) => window.app === "browser");
      if (open) {
        (desktop.pages ??= {})[open.id] = url;
        open.title = `${url.replace(/^[a-z]+:\/\//i, "")} - Browser`;
        loaded(open.id);
      } else {
        const pid = desktop.nextPid++;
        const id = desktop.nextWindow++;
        setTimeout(() => {
          this.#change((later) => {
            (later.pages ??= {})[id] = url;
            later.windows.push({ id, pid, app: "browser", title: "Untitled - Browser", x: 0, y: 0, width: 1280, height: 800, onScreen: true });
          });
        }, 200);
        loaded(id);
      }
      return text("Opened the URL.", { pid: null, running: true, windows: [], launcher_pid: 1 });
    });
  }

  #apps(): Result {
    if (this.#load().mac) {
      const apps = [
        { name: "Finder", bundle_id: "com.apple.finder", launch_path: "/System/Library/CoreServices/Finder.app", running: true },
        { name: "Archive Utility", bundle_id: "com.apple.archiveutility", launch_path: "/System/Library/CoreServices/Applications/Archive Utility.app", running: false },
        { name: "Calculator", bundle_id: "com.apple.calculator", launch_path: "/System/Applications/Calculator.app", running: false },
        { name: "TextEdit", bundle_id: "com.apple.TextEdit", launch_path: "/System/Applications/TextEdit.app", running: false },
      ].map((app) => ({ ...app, kind: "desktop" }));
      return text(`${apps.length} apps.`, { apps });
    }
    const installed = ["Tasks", "Editor", "Browser", "Wide", "Editor"].map((name) => ({ name, kind: "desktop", bundle_id: name.toLowerCase(), launch_path: name.toLowerCase(), running: false }));
    const apps = [
      ...installed,
      { name: "Settings Manager", kind: "desktop", bundle_id: "xfce-settings-manager", launch_path: "xfce4-settings-manager", running: false },
      { name: "Log Out", kind: "desktop", bundle_id: "xfce4-session-logout", launch_path: "xfce4-session-logout", running: false },
      { name: "Xvfb", kind: null, launch_path: null, running: true },
    ];
    return text(`${apps.length} apps.`, { apps });
  }
}

/** The deepest node of a window at a point of it. */
function hit(desktop: FakeDesktop, window: FakeWindow, x: number, y: number): Node {
  const hits = flatten(tree(desktop, window)).filter(({ node: { frame } }) => x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height);
  return hits[hits.length - 1]!.node;
}

/** Serves MCP on stdin and stdout, as `cua-driver mcp --socket <file>` does. */
function serve(socket: string): void {
  const cua = new FakeCua(socket);
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line) as { id?: number; method?: string; params?: { name?: string; arguments?: Args } };
      if (message.id === undefined) continue;
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cua-driver", version: "test" } } });
      } else if (message.method === "tools/list") {
        send({ jsonrpc: "2.0", id: message.id, result: { tools: cua.tools() } });
      } else if (message.method === "tools/call") {
        void cua
          .call(message.params?.name ?? "", message.params?.arguments ?? {})
          .then((result) => send({ jsonrpc: "2.0", id: message.id, result }));
      } else {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unknown method ${message.method}.` } });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, flag, socket] = process.argv.slice(2);
  if (command !== "mcp" || flag !== "--socket" || !socket) {
    process.stderr.write("usage: cua-driver mcp --socket <path>\n");
    process.exit(2);
  }
  serve(socket);
}
