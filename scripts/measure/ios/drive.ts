import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GrpcClient } from "../../../src/device/grpc.ts";
import { encode } from "../../../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../../../src/device/schemas.ts";
import { VIDEO_STEP_SCALES, drawnShare, deviceModel, screensOf, stepCovering } from "../../../src/core/device.ts";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE = process.env.PAGE ?? "http://127.0.0.1:8770/device.html";
const HARNESS = process.env.HARNESS ?? "http://127.0.0.1:8770";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets(): Promise<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }[]> {
  return (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Promise<{ id: string; type: string; url: string; webSocketDebuggerUrl: string }[]>;
}

async function chrome(): Promise<string> {
  try {
    const page = (await targets()).find((target) => target.type === "page" && target.url.startsWith(PAGE));
    if (page) {
      await fetch(`http://127.0.0.1:${PORT}/json/activate/${page.id}`);
      return page.webSocketDebuggerUrl;
    }
    const opened = (await (await fetch(`http://127.0.0.1:${PORT}/json/new?${PAGE}`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string };
    await wait(1500);
    return opened.webSocketDebuggerUrl;
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
const PROBE_OFFSET = { x: Number(process.env.PROBE_DX ?? 30), y: Number(process.env.PROBE_DY ?? 30) };

async function at(cdp: Cdp, x: number, y: number): Promise<{ x: number; y: number }> {
  const point = await cdp.evaluate<{ x: number; y: number } | null>(`clientOfVideo(${x * SCALE}, ${y * SCALE})`);
  if (point) return point;
  const rect = await cdp.evaluate<Rect>("screenRect()");
  return { x: rect.left + x * SCALE * rect.scale, y: rect.top + y * SCALE * rect.scale };
}

const IDB_HID_ORIENTATION: Readonly<Record<string, number>> = { upright: 0, "upside-down": 1, "turned-right": 2, "turned-left": 3 };

async function turnWithIdb(to: string): Promise<void> {
  const value = IDB_HID_ORIENTATION[to];
  if (value === undefined) throw new Error(`turn takes ${Object.keys(IDB_HID_ORIENTATION).join(", ")}`);
  const client = new GrpcClient({ socket: join(homedir(), ".bb-box", "device", "idb.sock") });
  try {
    for await (const _ of client.call(GRPC_METHODS.idb.hid, [encode(IDB_SCHEMA, "idb.HIDEvent", { orientation: { orientation: value } })])) void _;
  } finally {
    client.close();
  }
}

const RECORD_FRAMES = `(() => {
  const device = session.element.querySelector(".bb-device-stage > div > div");
  const veil = device.querySelectorAll("div")[0].querySelectorAll("div")[1];
  window.turnLog = [];
  const began = performance.now();
  const step = (now) => {
    const style = getComputedStyle(device);
    const matrix = new DOMMatrixReadOnly(style.transform === "none" ? undefined : style.transform);
    window.turnLog.push([Math.round((now - began) * 10) / 10, Math.round(Math.atan2(matrix.b, matrix.a) * 1800 / Math.PI) / 10, Number(getComputedStyle(veil).opacity), session.deviceStage.shownGeneration, window.drawn.length]);
    if (window.turnLog.length < 2000 && !window.turnStop) requestAnimationFrame(step);
  };
  window.turnStop = false;
  requestAnimationFrame(step);
  return true;
})()`;

async function turnFrames(cdp: Cdp, to: string, ms: number, label: string): Promise<void> {
  await cdp.evaluate(RECORD_FRAMES);
  const sent = performance.now();
  await turnWithIdb(to);
  const sentMs = Math.round(performance.now() - sent);
  await wait(ms);
  await cdp.evaluate("window.turnStop = true");
  const log = await cdp.evaluate<[number, number, number, number | null, number][]>("window.turnLog");
  const times = await cdp.evaluate<{ began: number; turned: number | null; pictured: number | null; veiled: number | null } | null>("session.deviceStage.times");
  const moving = log.filter((entry, index) => index > 0 && entry[1] !== log[index - 1]![1]);
  const first = moving[0]?.[0] ?? null;
  const last = moving.at(-1)?.[0] ?? null;
  const during = first === null || last === null ? [] : log.filter((entry) => entry[0] >= first - 20 && entry[0] <= last + 20);
  const gaps = during.slice(1).map((entry, index) => entry[0] - during[index]![0]);
  const summary = {
    label,
    to,
    sentMs,
    angle: log.at(-1)?.[1],
    turnStartMs: first,
    turnEndMs: last,
    animationMs: first !== null && last !== null ? Math.round(last - first) : null,
    framesDuring: during.length,
    frameGapMedian: gaps.length ? percentile(gaps, 0.5) : null,
    frameGapWorst: gaps.length ? Math.max(...gaps) : null,
    pictureAfterChangeMs: times?.pictured != null ? Math.round(times.pictured - times.began) : null,
    veiledAfterChangeMs: times?.veiled != null ? Math.round(times.veiled - times.began) : null,
    generation: log.at(-1)?.[3],
  };
  console.log(JSON.stringify(summary));
  writeFileSync(`/tmp/turn-${label}.json`, JSON.stringify({ summary, times, log }));
}

async function landing(cdp: Cdp, x: number, y: number): Promise<void> {
  const point = await cdp.evaluate<{ x: number; y: number } | null>(`clientOfVideo(${x}, ${y})`);
  if (!point) throw new Error(`video pixel ${x},${y} is not on the drawn screen`);
  const before = await cdp.evaluate<number[]>(`pixel(${x}, ${y})`);
  await mouse(cdp, "mousePressed", point);
  await wait(60);
  await mouse(cdp, "mouseReleased", point);
  await wait(700);
  const after = await cdp.evaluate<number[]>(`pixel(${x}, ${y})`);
  const red = (rgb: number[]) => rgb[0]! > 180 && rgb[1]! < 90 && rgb[2]! < 90;
  const geometry = await cdp.evaluate<unknown>("session.device.state.geometry");
  console.log(JSON.stringify({ step: "landing", video: [x, y], client: [Math.round(point.x), Math.round(point.y)], before, after, landedWhereDrawn: red(after), geometry }));
}

async function mouse(cdp: Cdp, type: string, point: { x: number; y: number }, extra: Record<string, unknown> = {}): Promise<void> {
  await cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: type === "mouseMoved" ? "none" : "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1, ...extra });
}

const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length - 1) * p))]!;

async function tapToScreen(cdp: Cdp, x: number, y: number, times: number, gapMs: number, label: string): Promise<void> {
  const point = await at(cdp, x, y);
  await cdp.evaluate(`window.probe = { x: ${Math.round(x * SCALE + PROBE_OFFSET.x)}, y: ${Math.round(y * SCALE + PROBE_OFFSET.y)} }; window.drawn.length = 0; window.downs.length = 0; true`);
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

type Sized = { width: number; height: number; own: { width: number; height: number }; drawn: { width: number; height: number } | null };

async function follow(cdp: Cdp, label: string, width: number, height: number, ratio: number, view: string): Promise<void> {
  const before = await cdp.evaluate<Sized>("frameSize()");
  const began = await cdp.evaluate<number>("window.drawn.length = 0; performance.now()");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: ratio, mobile: false });
  await cdp.evaluate(`view(${view !== "noframe"}, ${view === "pfp"}); true`);
  let sized = await cdp.evaluate<Sized>("frameSize()");
  let drawnAt: number | null = null;
  const sameDrawn = (a: Sized["drawn"], b: Sized["drawn"]) => a?.width === b?.width && a?.height === b?.height;
  for (let tries = 0; tries < 150; tries++) {
    if (!sameDrawn(sized.drawn, before.drawn)) {
      drawnAt = await cdp.evaluate<number>("performance.now()");
      break;
    }
    await wait(20);
    sized = await cdp.evaluate<Sized>("frameSize()");
  }
  const model = process.env.MODEL ?? "iPhone 18 Pro";
  const step = sized.drawn ? stepCovering(drawnShare(sized.drawn, screensOf(deviceModel(model as never)))) : "full";
  const even = (value: number) => Math.max(2, Math.round((value * VIDEO_STEP_SCALES[step]) / 2) * 2);
  const expected = { width: even(sized.own.width), height: even(sized.own.height) };
  let arrived: number | null = null;
  for (let tries = 0; tries < 300 && arrived === null; tries++) {
    await wait(20);
    arrived = await cdp.evaluate<number | null>(`(() => { const hit = window.drawn.find(([, , w, h]) => w === ${expected.width} && h === ${expected.height}); return hit ? hit[0] : null; })()`);
  }
  await wait(1500);
  const drawn = await cdp.evaluate<[number, number, number, number][]>("window.drawn");
  const sizes = [...new Set(drawn.map(([, , w, h]) => `${w}x${h}`))];
  const gaps = drawn.slice(1).map((frame, index) => ({ gap: frame[0] - drawn[index]![0], from: `${drawn[index]![2]}x${drawn[index]![3]}`, to: `${frame[2]}x${frame[3]}` }));
  const change = gaps.find((each) => each.from !== each.to) ?? null;
  const steady = gaps.filter((each) => each.from === each.to).map((each) => each.gap);
  const summary = {
    label,
    viewport: `${width}x${height}@${ratio}`,
    view,
    drawn: sized.drawn,
    share: sized.drawn ? Math.round(drawnShare(sized.drawn, screensOf(deviceModel(model as never))) * 1000) / 1000 : null,
    step,
    before: `${before.width}x${before.height}`,
    expected: `${expected.width}x${expected.height}`,
    sizes,
    msToDrawn: drawnAt === null ? null : Math.round(drawnAt - began),
    msToStep: arrived === null ? null : Math.round(arrived - began),
    stallAtChangeMs: change ? Math.round(change.gap) : null,
    steadyGapMedianMs: steady.length ? Math.round(percentile(steady, 0.5)) : null,
    frames: drawn.length,
  };
  console.log(JSON.stringify(summary));
  writeFileSync(`/tmp/follow-${label}.json`, JSON.stringify({ summary, drawn }));
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
      case "shot": {
        const shot = (await cdp.send("Page.captureScreenshot", { format: "png" })) as { data: string };
        writeFileSync(rest.join(":"), Buffer.from(shot.data, "base64"));
        break;
      }
      case "theme":
        await cdp.evaluate(`theme(${JSON.stringify(rest[0])}); true`);
        break;
      case "view":
        await cdp.evaluate(`view(${rest[0] !== "noframe"}, ${rest[1] === "pfp"}); true`);
        break;
      case "size":
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: numbers[0]!, height: numbers[1]!, deviceScaleFactor: numbers[2] ?? 1, mobile: false });
        break;
      case "turn":
        await turnFrames(cdp, rest[0]!, numbers[1] || 1500, rest[2] ?? rest[0]!);
        break;
      case "freehid": {
        const pid = Number(readFileSync(join(homedir(), ".bb-box", "device", "server.pid"), "utf8").trim());
        await fetch(`${HARNESS}/api/owner?holder=agent`);
        await cdp.evaluate("control(false)");
        process.kill(pid, "SIGTERM");
        for (let tries = 0; tries < 100 && spawnSync("kill", ["-0", String(pid)]).status === 0; tries++) await wait(50);
        spawnSync("launchctl", ["kickstart", `gui/${process.getuid!()}/app.bb-box.device`]);
        await wait(1500);
        await cdp.send("Page.reload");
        for (let tries = 0; tries < 150 && !(await cdp.evaluate<boolean>("typeof session !== 'undefined' && session.connection.state === 'connected' && window.drawn.length > 0").catch(() => false)); tries++) await wait(100);
        await wait(1000);
        break;
      }
      case "idbturn":
        await turnWithIdb(rest[0]!);
        break;
      case "landing":
        await landing(cdp, numbers[0]!, numbers[1]!);
        break;
      case "follow":
        await follow(cdp, rest[0]!, numbers[1]!, numbers[2]!, numbers[3] ?? 1, rest[4] ?? "frame");
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
