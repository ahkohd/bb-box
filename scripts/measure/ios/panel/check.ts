import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9334);
const HARNESS = process.env.HARNESS ?? "http://127.0.0.1:8770";
const OUT = process.env.OUT ?? "/tmp/bb-box-panel";
const CHROME_PID = `${OUT}-chrome.pid`;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Target {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

async function targets(): Promise<Target[]> {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Promise<Target[]>;
}

async function pageSocket(): Promise<string> {
  try {
    const page = (await targets()).find((target) => target.type === "page");
    if (page) return page.webSocketDebuggerUrl;
  } catch {}
  const child = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/bb-box-panel-chrome", "--no-first-run", "--force-renderer-accessibility", "about:blank"], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(CHROME_PID, String(child.pid));
  for (let tries = 0; tries < 100; tries++) {
    await wait(100);
    try {
      const page = (await targets()).find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error("Chrome did not start");
}

class Cdp {
  readonly #socket: WebSocket;
  #id = 0;
  readonly #waiting = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
      if (message.id !== undefined) this.#waiting.get(message.id)?.(message);
    });
  }

  static async open(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.#id;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#waiting.set(id, (message) => (message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result))));
  }

  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}: ${expression}`);
    return result.result.value;
  }
}

const FIND = `(name) => {
  const all = [...document.querySelectorAll("button, [role=menuitem], [role=menuitemcheckbox], [role=slider], [role=textbox], input, textarea")];
  const label = (element) => (element.getAttribute("aria-label") || element.textContent || "").replace(/\\s+/g, " ").trim();
  return all.find((element) => label(element) === name) ?? all.find((element) => label(element).startsWith(name));
}`;

async function centreOf(cdp: Cdp, name: string): Promise<{ x: number; y: number }> {
  const at = await cdp.evaluate<{ x: number; y: number } | null>(`(() => { const element = (${FIND})(${JSON.stringify(name)}); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  if (!at) throw new Error(`nothing named ${name}`);
  return at;
}

let touching = false;

async function press(cdp: Cdp, x: number, y: number): Promise<void> {
  if (touching) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await wait(60);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return;
  }
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

const KEYS: Readonly<Record<string, { key: string; code: string; keyCode: number }>> = {
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
};

async function key(cdp: Cdp, name: string): Promise<void> {
  const shift = name.startsWith("Shift+");
  const known = KEYS[shift ? name.slice(6) : name];
  if (!known) throw new Error(`no key ${name}`);
  const modifiers = shift ? 8 : 0;
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers });
  if (known.key === " " || known.key === "Enter") await cdp.send("Input.dispatchKeyEvent", { type: "char", text: known.key === " " ? " " : "\r", modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode, modifiers });
}

interface AxNode {
  readonly nodeId: string;
  readonly ignored: boolean;
  readonly role?: { readonly value: string };
  readonly name?: { readonly value: string };
  readonly properties?: readonly { readonly name: string; readonly value: { readonly value: unknown } }[];
  readonly childIds?: readonly string[];
}

async function accessibility(cdp: Cdp): Promise<string[]> {
  const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AxNode[] };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines: string[] = [];
  const walk = (node: AxNode, depth: number, inside: boolean) => {
    const role = node.role?.value ?? "";
    const within = inside || role === "toolbar" || role === "menu" || role === "dialog" || role === "alertdialog";
    if (!node.ignored && within && role !== "generic" && role !== "none" && role !== "InlineTextBox" && role !== "StaticText") {
      const states = (node.properties ?? []).filter((property) => ["pressed", "checked", "disabled", "busy", "expanded", "haspopup", "focused", "orientation", "valuetext", "describedby"].includes(property.name)).map((property) => `${property.name}=${String(property.value.value)}`);
      lines.push(`${"  ".repeat(depth)}${role} "${node.name?.value ?? ""}"${states.length ? ` [${states.join(", ")}]` : ""}`);
    }
    for (const child of node.childIds ?? []) {
      const next = byId.get(child);
      if (next) walk(next, within && !node.ignored ? depth + 1 : depth, within);
    }
  };
  const root = nodes[0];
  if (root) walk(root, 0, false);
  const live = nodes.filter((node) => node.properties?.some((property) => property.name === "live" && property.value.value !== "off")).map((node) => `live region: "${node.name?.value ?? ""}"`);
  return [...lines, ...live];
}

function quitChrome(): void {
  if (!existsSync(CHROME_PID)) return;
  try {
    process.kill(-Number(readFileSync(CHROME_PID, "utf8")), "SIGTERM");
  } catch {}
  rmSync(CHROME_PID, { force: true });
}

async function run(steps: readonly string[]): Promise<void> {
  if (steps[0] === "quit") {
    quitChrome();
    process.exit(0);
  }
  const cdp = await Cdp.open(await pageSocket());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Accessibility.enable");
  for (const step of steps) {
    const [verb, ...rest] = step.split(":");
    const arg = rest.join(":");
    const began = performance.now();
    switch (verb) {
      case "open": {
        const [theme, width, height, zoom, input] = arg.split(",");
        const scale = Number(zoom || 1);
        touching = input === "touch";
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: Math.round(Number(width) / scale), height: Math.round(Number(height) / scale), deviceScaleFactor: 2 * scale, mobile: touching });
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touching, maxTouchPoints: touching ? 5 : 1 });
        await cdp.send("Emulation.setEmulatedMedia", { features: touching ? [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }, { name: "any-pointer", value: "coarse" }] : [{ name: "pointer", value: "fine" }, { name: "hover", value: "hover" }] });
        await cdp.send("Page.navigate", { url: `${HARNESS}/panel/page.html?theme=${theme}` });
        await wait(2500);
        break;
      }
      case "reload":
        await cdp.send("Page.reload");
        await wait(2500);
        break;
      case "shot": {
        const { data } = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
        writeFileSync(`${OUT}-${arg}.png`, Buffer.from(data, "base64"));
        break;
      }
      case "click":
      case "tap": {
        const at = await centreOf(cdp, arg);
        await press(cdp, at.x, at.y);
        break;
      }
      case "hover": {
        const at = await centreOf(cdp, arg);
        await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
        break;
      }
      case "key":
        await key(cdp, arg);
        break;
      case "type":
        await cdp.send("Input.insertText", { text: arg });
        break;
      case "focus":
        await cdp.evaluate(`(${FIND})(${JSON.stringify(arg)})?.focus()`);
        break;
      case "ax":
        writeFileSync(`${OUT}-${arg}.txt`, `${(await accessibility(cdp)).join("\n")}\n`);
        break;
      case "focused":
        process.stdout.write(`focused: ${await cdp.evaluate<string>(`(() => { const element = document.activeElement; return element ? (element.getAttribute("aria-label") || element.textContent || element.tagName).trim() : "none"; })()`)}\n`);
        break;
      case "text":
        process.stdout.write(`${await cdp.evaluate<string>(`document.querySelector(${JSON.stringify(arg)})?.textContent ?? ""`)}\n`);
        break;
      case "toasts":
        process.stdout.write(`toasts: ${JSON.stringify(await cdp.evaluate<string[]>(`[...document.querySelectorAll("[data-sonner-toast]")].map((toast) => toast.textContent.trim())`))}\n`);
        break;
      case "box":
        process.stdout.write(`${arg}: ${JSON.stringify(await cdp.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(arg)}); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }; })()`))}\n`);
        break;
      case "eval":
        process.stdout.write(`${JSON.stringify(await cdp.evaluate(arg))}\n`);
        break;
      case "api": {
        const [path, query] = arg.split("?");
        const response = await fetch(`${HARNESS}/api/${path}${query ? `?${query}` : ""}`, { method: "POST", body: rest.length > 1 ? rest.slice(1).join(":") : undefined });
        process.stdout.write(`api ${path}: ${(await response.text()).slice(0, 400)}\n`);
        break;
      }
      case "agent": {
        const response = await fetch(`${HARNESS}/api/control`, { method: "POST", body: arg });
        process.stdout.write(`agent ${arg}: ${(await response.text()).slice(0, 600)}\n`);
        break;
      }
      case "wait":
        await wait(Number(arg));
        break;
      default:
        throw new Error(`no step ${verb}`);
    }
    if (verb !== "wait") process.stdout.write(`${step} (${Math.round(performance.now() - began)} ms)\n`);
  }
  process.exit(0);
}

await run(process.argv.slice(2));
