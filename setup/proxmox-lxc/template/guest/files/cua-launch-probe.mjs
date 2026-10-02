// bb-box: open an app or a URL through Cua Driver's daemon, as computer use
// does, wait for its new window, and count the elements of its accessibility
// tree. With --type, types the text into the window's focused element, in the
// foreground, and waits for it in the tree. Closes the app it opened. Prints
// {app, title, pid, bounds, elements, ms, typedMs} as JSON and exits 1 below
// --min elements or when the typed text does not show.
// With --title, the new window's title must match the pattern, as an app's
// own window does and a dialog in front of it does not.
// usage: node cua-launch-probe.mjs --socket <path> (--app <name> | --url <url>) [--min 1] [--type <text>] [--title <regex>]
import { spawn } from "node:child_process";
import readline from "node:readline";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const socketPath = arg("--socket", null);
const app = arg("--app", null);
const url = arg("--url", null);
const min = Number(arg("--min", "1"));
const text = arg("--type", null);
const title = arg("--title", null);

const driver = spawn("cua-driver", ["mcp", ...(socketPath ? ["--socket", socketPath] : [])], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
let next = 1;
readline.createInterface({ input: driver.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (message) => driver.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => reject(new Error(`${method} timed out`)), 30000);
  });
const call = async (name, args) => {
  const reply = await request("tools/call", { name, arguments: args });
  const text = reply.result?.content?.map((part) => part.text ?? "").join(" ") ?? "";
  if (reply.error || reply.result?.isError) throw new Error(`${name}: ${reply.error?.message ?? text}`);
  return reply.result.structuredContent ?? {};
};
const windows = async () => (await call("list_windows", {})).windows ?? [];

// What to close at the end: the process launch_app started, and the window's
// own, which differ when a URL opens through xdg-open.
const opened = new Set();
try {
  await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "bb-box-cua-launch-probe", version: "1" } });
  send({ method: "notifications/initialized" });
  const before = new Set((await windows()).map((window) => window.window_id));
  const started = performance.now();
  const result = await call("launch_app", url ? { urls: [url] } : { name: app });
  if (result.pid) opened.add(result.pid);
  let window = null;
  for (let i = 0; i < 100 && !window; i++) {
    window = (await windows()).find((w) => !before.has(w.window_id) && w.pid > 0 && (w.bounds?.width ?? w.width ?? 0) > 1);
    if (!window) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!window) throw new Error("no new window with a process and bounds within 20 s");
  opened.add(window.pid);
  if (title && !new RegExp(title).test(window.title ?? "")) throw new Error(`the new window is "${window.title}", not one titled like /${title}/`);
  // The tree fills in as the app finishes drawing.
  let elements = 0;
  for (let i = 0; i < 20 && elements < min; i++) {
    const state = await call("get_window_state", { pid: window.pid, window_id: window.window_id, include_screenshot: false });
    elements = state.element_count ?? state.elements?.length ?? 0;
    if (elements < min) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const ms = Math.round(performance.now() - started);
  let typedMs = null;
  if (text) {
    // Input goes only to the focused window on Wayland, so in the foreground.
    const typing = performance.now();
    await call("type_text", { pid: window.pid, window_id: window.window_id, text, delivery_mode: "foreground" });
    for (let i = 0; i < 40 && typedMs === null; i++) {
      const reply = await request("tools/call", { name: "get_window_state", arguments: { pid: window.pid, window_id: window.window_id, include_screenshot: false } });
      if (JSON.stringify(reply.result ?? {}).includes(text)) typedMs = Math.round(performance.now() - typing);
      else await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (typedMs === null) throw new Error(`typed "${text}", but the window's tree does not show it within 10 s`);
  }
  console.log(JSON.stringify({ app: window.app_name, title: window.title, pid: window.pid, bounds: window.bounds, elements, ms, typedMs }));
  process.exitCode = elements >= min ? 0 : 1;
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
} finally {
  for (const pid of opened) {
    try {
      process.kill(pid);
    } catch {
      // gone already
    }
  }
  driver.stdin.end();
  setTimeout(() => process.exit(), 500);
}
