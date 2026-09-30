// A fake Cua Driver for tests: `cua-driver mcp --socket <file>` speaks MCP on
// stdin and stdout, like the real proxy, with the tools and results bb-box
// uses. The desktop it drives lives in the JSON file named by --socket, so
// every session of a box sees one desktop, and a test can change it between
// calls. Element tokens hold a prefix of the process's own, so like Cua's
// they die with the session.
//
// The desktop has Tasks windows: a list of tasks, each with a "Delete Task N"
// button, a "New task" field that refuses background typing, an Add button
// and a "Clear all" button that opens a modal dialog. A window of app "wide"
// is wider than the longest edge bb-box gives the agent.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
}

export interface FakeDesktop {
  screen: { width: number; height: number };
  windows: FakeWindow[];
  /** The tasks of each Tasks window. */
  tasks: Record<string, string[]>;
  /** The "New task" field of each Tasks window. */
  fields: Record<string, string>;
  nextWindow: number;
  nextPid: number;
  /** Milliseconds a tool waits before it answers. */
  delays: Record<string, number>;
  /** The tools called, with their arguments, in order. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** How many sessions have started. */
  sessions: number;
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

function text(message: string, structured?: Record<string, unknown>, isError = false): Result {
  return { content: [{ type: "text", text: message }], structuredContent: structured, isError };
}

function tree(desktop: FakeDesktop, window: FakeWindow): Node {
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
  if (window.app !== "tasks") {
    return { key: "frame", role: "frame", label: window.title, actions: [], frame: frame(0, 0, window.width, window.height), children: [] };
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
          children: [{ key: `delete:${task}`, role: "push button", label: `Delete ${task}`, actions: ["click"], frame: frame(700, 45 + at * 40, 90, 30), children: [] }],
        })),
      },
      { key: "field", role: "text", label: "New task", value: desktop.fields[window.id] ?? "", actions: [], frame: frame(0, 520, 600, 40), children: [] },
      { key: "add", role: "push button", label: "Add", actions: ["click"], frame: frame(620, 520, 80, 40), children: [] },
      { key: "clear", role: "push button", label: "Clear all", actions: ["click"], frame: frame(710, 520, 80, 40), children: [] },
    ],
  };
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

export class FakeCua {
  readonly #file: string | null;
  #memory: FakeDesktop;
  readonly #prefix = randomBytes(4).toString("hex");
  /** Per window, the size of the screenshot of the latest get_window_state, or null for none. */
  readonly #shots = new Map<number, { width: number; height: number } | null>();

  constructor(socket: string) {
    // Only a file under the box's home holds the desktop; any other socket gets a desktop of its own.
    this.#file = isAbsolute(socket) ? null : socket;
    this.#memory = this.#file && existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as FakeDesktop) : emptyDesktop();
    this.#change((desktop) => desktop.sessions++);
  }

  #load(): FakeDesktop {
    if (this.#file && existsSync(this.#file)) this.#memory = JSON.parse(readFileSync(this.#file, "utf8")) as FakeDesktop;
    return this.#memory;
  }

  #change<T>(update: (desktop: FakeDesktop) => T): T {
    const desktop = this.#load();
    const result = update(desktop);
    if (this.#file) writeFileSync(this.#file, JSON.stringify(desktop));
    return result;
  }

  #token(window: FakeWindow, key: string): string {
    return `${this.#prefix}|${window.id}|${key}`;
  }

  #window(desktop: FakeDesktop, args: Args): FakeWindow | Result {
    const window = desktop.windows.find((candidate) => candidate.id === args.window_id);
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

  async call(tool: string, args: Args): Promise<Result> {
    const delay = this.#change((desktop) => {
      desktop.calls.push({ tool, args });
      return desktop.delays[tool] ?? 0;
    });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
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
      default:
        return text(`Unknown tool ${tool}.`, { code: "unknown_tool" }, true);
    }
  }

  #listWindows(): Result {
    const desktop = this.#load();
    const windows = desktop.windows.map((window) => this.#windowJson(window));
    return text(`${windows.length} windows.`, { windows });
  }

  #state(args: Args): Result {
    const desktop = this.#load();
    const window = this.#window(desktop, args);
    if (!("id" in window)) return window;
    const flat = flatten(tree(desktop, window));
    const elements = flat
      .filter((entry) => !entry.node.text)
      .map((entry) => ({
        element_index: entry.index,
        role: entry.node.role,
        depth: entry.depth,
        element_token: this.#token(window, entry.node.key),
        label: entry.node.label,
        value: entry.node.value ?? null,
        enabled: true,
        actions: entry.node.actions,
        parent_index: entry.parent,
        frame: entry.node.frame,
      }));
    const dialogs = desktop.windows
      .filter((other) => other.dialogOf === window.id)
      .map((dialog) => ({ window_id: dialog.id, title: dialog.title, transient_for: window.id, modal: true, bounds: { x: dialog.x, y: dialog.y, width: dialog.width, height: dialog.height } }));
    const structured: Record<string, unknown> = {
      window_id: window.id,
      pid: window.pid,
      element_count: elements.length,
      elements_complete: true,
      truncated: false,
      elements,
      snapshot_id: `${this.#prefix}-${Date.now()}`,
      app_name: window.app,
      window_title: window.title,
      window_bounds: { x: window.x, y: window.y, width: window.width, height: window.height },
      dialogs,
      popups: [],
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
        capture_id: `${this.#prefix}-desktop`,
      },
    };
  }

  /** The element a token names, in the window as it is now. */
  #element(desktop: FakeDesktop, window: FakeWindow, token: unknown): Node | Result {
    if (typeof token !== "string") return text("Give element_token or x and y.", { code: "invalid_arguments" }, true);
    const [prefix, id, key] = token.split("|");
    if (prefix !== this.#prefix) return text("element_token is not from this session. Call get_window_state again.", { code: "stale_token" }, true);
    if (Number(id) !== window.id) return text("element_token belongs to another window.", { code: "invalid_arguments" }, true);
    const node = flatten(tree(desktop, window)).find((entry) => entry.node.key === key)?.node;
    return node ?? text("The element is no longer in the window. Call get_window_state again.", { code: "stale_element" }, true);
  }

  #click(args: Args): Result {
    return this.#change((desktop) => {
      if (args.pid === undefined && args.window_id === undefined) {
        if (args.scope !== "desktop") return text('click: x,y given with no pid/window_id requires scope="desktop".', { code: "desktop_coordinate_scope_required" }, true);
        return text(`Sent screen-absolute click at (${String(args.x)},${String(args.y)}) (desktop scope).`, { effect: "unverifiable" });
      }
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      let node: Node | Result;
      if (typeof args.x === "number" && typeof args.y === "number") {
        const shot = this.#shots.get(window.id);
        if (!shot) return text("A pixel click needs a screenshot from get_window_state of this window first.", { code: "no_screenshot" }, true);
        const x = (args.x * window.width) / shot.width;
        const y = (args.y * window.height) / shot.height;
        const hits = flatten(tree(desktop, window)).filter(({ node: { frame } }) => x >= frame.x && x < frame.x + frame.width && y >= frame.y && y < frame.y + frame.height);
        node = hits[hits.length - 1]!.node;
      } else {
        node = this.#element(desktop, window, args.element_token);
      }
      if (!("key" in node)) return node;
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
        if (node.key === "clear") desktop.tasks[window.dialogOf] = [];
        desktop.windows = desktop.windows.filter((other) => other.id !== window.id);
      }
      return text(`Clicked ${node.role} "${node.label}" (delivery_mode=${String(args.delivery_mode ?? "background")}).`, { verified: true });
    });
  }

  #type(args: Args): Result {
    return this.#change((desktop) => {
      const window = this.#window(desktop, args);
      if (!("id" in window)) return window;
      if (args.element_token !== undefined) {
        const node = this.#element(desktop, window, args.element_token);
        if (!("key" in node)) return node;
        if (node.key !== "field") return text(`${node.role} "${node.label}" does not take text.`, { code: "not_editable" }, true);
      }
      if (args.delivery_mode !== "foreground") {
        return text('Background delivery is not available for this target; retry with delivery_mode:"foreground".', {
          code: "background_unavailable",
          effect: "none",
          escalation: { recommended: "foreground" },
        }, true);
      }
      desktop.fields[window.id] = `${desktop.fields[window.id] ?? ""}${String(args.text)}`;
      return text(`Typed ${String(args.text).length} characters.`, { delivery_mode: "foreground" });
    });
  }

  #press(args: Args): Result {
    return this.#change((desktop) => {
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
    if (Array.isArray(args.urls)) return text("Opened the URL.", { pid: null, running: true, windows: [], launcher_pid: 1 });
    const name = String(args.name ?? args.launch_path ?? "");
    if (name === "missing") return text("No app named missing.", { code: "not_found" }, true);
    return this.#change((desktop) => {
      if (name === "tasks") {
        const window = openTasks(desktop, []);
        return text("Launched tasks.", { pid: window.pid, running: true, windows: [this.#windowJson(window)] });
      }
      // Other apps open their window a little later, as a slow app does.
      const pid = desktop.nextPid++;
      const id = desktop.nextWindow++;
      const wide = name === "wide";
      setTimeout(() => {
        this.#change((later) => {
          later.windows.push({ id, pid, app: name, title: name, x: 0, y: 0, width: wide ? 4000 : 640, height: wide ? 200 : 480, onScreen: true });
        });
      }, 200);
      return text(`Launched ${name}.`, { pid, running: true, windows: [] });
    });
  }
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
