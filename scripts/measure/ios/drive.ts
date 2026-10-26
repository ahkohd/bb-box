import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE = process.env.PAGE ?? "http://127.0.0.1:8770/device.html";
const HARNESS = process.env.HARNESS ?? "http://127.0.0.1:8770";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets(): Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]> {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Promise<{ type: string; url: string; webSocketDebuggerUrl: string }[]>;
}

async function chrome(): Promise<string> {
  try {
    const page = (await targets()).find((target) => target.type === "page" && target.url.startsWith(PAGE));
    if (page) return page.webSocketDebuggerUrl;
  } catch {}
  const child = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/bb-box-device-chrome", "--window-size=600,1100", "--no-first-run", PAGE], { detached: true, stdio: "ignore" });
  child.unref();
  for (let tries = 0; tries < 100; tries++) {
    await wait(100);
    try {
      const page = (await targets()).find((target) => target.type === "page" && target.url.startsWith(PAGE));
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
  }
  throw new Error("Chrome did not open the page");
}

class Cdp {
  readonly #socket: WebSocket;
  #id = 0;
  readonly #waiting = new Map<number, (value: { result?: unknown; error?: { message: string } }) => void>();
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
    return new Promise((resolve, reject) => this.#waiting.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result))));
  }
  async evaluate<T>(expression: string): Promise<T> {
    const result = (await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { text: string } };
    if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text}: ${expression}`);
    return result.result.value;
  }
  close(): void {
    this.#socket.close();
  }
}

type Rect = { left: number; top: number; scale: number; width: number; height: number };
const SCALE = Number(process.env.DEVICE_SCALE ?? 3);

async function at(cdp: Cdp, x: number, y: number): Promise<{ x: number; y: number }> {
  const rect = await cdp.evaluate<Rect>("screenRect()");
  return { x: rect.left + x * SCALE * rect.scale, y: rect.top + y * SCALE * rect.scale };
}

async function mouse(cdp: Cdp, type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, ...extra });
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]!;

async function tapToScreen(cdp: Cdp, x: number, y: number, times: number, gapMs: number, label: string): Promise<void> {
  const point = await at(cdp, x, y);
  await cdp.evaluate(`window.probe = { x: ${Math.round(x * SCALE + 30)}, y: ${Math.round(y * SCALE + 30)} }; window.drawn.length = 0; window.downs.length = 0; true`);
  const results: { ms: number | null; down: number }[] = [];
  for (let tap = 0; tap < times; tap++) {
    const before = await cdp.evaluate<number>("shadeNow()");
    await mouse(cdp, "mousePressed", point);
    await wait(40);
    await mouse(cdp, "mouseReleased", point);
    await wait(gapMs);
    const found = await cdp.evaluate<{ ms: number | null; down: number }>(`(() => { const down = window.downs.at(-1); const changed = window.drawn.find(([t, shade]) => t >= down && shade >= 0 && Math.abs(shade - ${before}) > 60); return { ms: changed ? changed[0] - down : null, down }; })()`);
    results.push(found);
  }
  const times_ = results.map((result) => result.ms).filter((ms): ms is number => ms !== null);
  const drawn = await cdp.evaluate<[number, number, number, number][]>("window.drawn");
  const gaps = drawn.slice(1).map((frame, index) => frame[0] - drawn[index]![0]);
  const summary = {
    label,
    taps: times,
    seen: times_.length,
    first: results[0]?.ms ?? null,
    median: times_.length ? Math.round(percentile(times_, 0.5)) : null,
    p95: times_.length ? Math.round(percentile(times_, 0.95)) : null,
    worst: times_.length ? Math.round(Math.max(...times_)) : null,
    frames: drawn.length,
    gapP95: gaps.length ? Math.round(percentile(gaps, 0.95)) : null,
    gapWorst: gaps.length ? Math.round(Math.max(...gaps)) : null,
  };
  console.log(JSON.stringify(summary));
  writeFileSync(`/tmp/e14-${label}.json`, JSON.stringify({ summary, results, drawn }));
}

async function main(): Promise<void> {
  const cdp = await Cdp.open(await chrome());
  await cdp.send("Runtime.enable");
  for (let tries = 0; tries < 100 && !(await cdp.evaluate<boolean>("typeof screenRect === 'function' && window.drawn.length > 0").catch(() => false)); tries++) await wait(100);
  for (const step of process.argv.slice(2)) {
    const [verb, ...rest] = step.split(":");
    const numbers = rest.map(Number);
    const began = performance.now();
    switch (verb) {
      case "owner": {
        const answer = await (await fetch(`${HARNESS}/api/owner?holder=${rest[0]}`)).json();
        await cdp.evaluate(`control(${rest[0] === "person"})`);
        console.log(JSON.stringify(answer).slice(0, 200));
        break;
      }
      case "tap": {
        const point = await at(cdp, numbers[0]!, numbers[1]!);
        await mouse(cdp, "mousePressed", point);
        await wait(50);
        await mouse(cdp, "mouseReleased", point);
        break;
      }
      case "press":
        await mouse(cdp, "mousePressed", await at(cdp, numbers[0]!, numbers[1]!));
        break;
      case "move":
        await mouse(cdp, "mouseMoved", await at(cdp, numbers[0]!, numbers[1]!), { buttons: 1, button: "left" });
        break;
      case "release":
        await mouse(cdp, "mouseReleased", await at(cdp, numbers[0]!, numbers[1]!));
        break;
      case "drag": {
        const [x1, y1, x2, y2, ms = 400] = numbers as [number, number, number, number, number?];
        const alt = rest[5] === "alt";
        if (alt) await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 1 });
        const modifiers = alt ? 1 : 0;
        const from = await at(cdp, x1, y1);
        const to = await at(cdp, x2, y2);
        await mouse(cdp, "mousePressed", from, { modifiers });
        const steps = Math.max(2, Math.round(ms / 16));
        for (let step = 1; step <= steps; step++) {
          await mouse(cdp, "mouseMoved", { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps }, { buttons: 1, button: "left", modifiers });
          await wait(16);
        }
        await mouse(cdp, "mouseReleased", to, { modifiers });
        if (alt) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18 });
        break;
      }
      case "wheel": {
        const [x, y, deltaY, count, everyMs = 16] = numbers as [number, number, number, number, number?];
        const point = await at(cdp, x, y);
        await mouse(cdp, "mouseMoved", point);
        for (let each = 0; each < count; each++) {
          await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
          await wait(everyMs);
        }
        break;
      }
      case "ime": {
        const [reading, committed] = rest as [string, string];
        for (let length = 1; length <= reading.length; length++) {
          await cdp.send("Input.imeSetComposition", { text: reading.slice(0, length), selectionStart: length, selectionEnd: length });
          await wait(30);
        }
        await cdp.send("Input.insertText", { text: committed });
        break;
      }
      case "insert":
        await cdp.send("Input.insertText", { text: rest.join(":") });
        break;
      case "type":
        for (const character of rest.join(":")) {
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: character, text: character, code: /[a-z]/i.test(character) ? `Key${character.toUpperCase()}` : undefined });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: character, code: /[a-z]/i.test(character) ? `Key${character.toUpperCase()}` : undefined });
        }
        break;
      case "typetext":
        await cdp.evaluate(`session.typeText(${JSON.stringify(rest.join(":"))}); true`);
        break;
      case "agent": {
        const body = rest.join(":");
        const answer = await (await fetch(`${HARNESS}/api/input`, { method: "POST", body })).json();
        console.log(JSON.stringify(answer).slice(0, 300));
        break;
      }
      case "e14":
        await tapToScreen(cdp, numbers[0]!, numbers[1]!, numbers[2] ?? 100, numbers[3] ?? 600, rest[4] ?? "run");
        break;
      case "wait":
        await wait(numbers[0]!);
        break;
      case "eval":
        console.log(JSON.stringify(await cdp.evaluate(rest.join(":"))));
        break;
      default:
        throw new Error(`no step ${verb}`);
    }
    console.log(`${verb} ${Math.round(performance.now() - began)} ms`);
  }
  cdp.close();
}

await main();
