import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

export const home = process.env.HOME;
export const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
export const boxesUrl = `${base}/plugins/bb-box/desktop`;
export const shots = join(home, "live-results", "shots");
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = join(home, "live-results", "unit-6.md");
mkdirSync(shots, { recursive: true });

export function line(text) {
  console.log(text);
  appendFileSync(report, `${text}\n`);
}

export function bb(args) {
  return execFileSync(join(home, "bbc"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function inBox(box, command) {
  return bb(["box", "run", box, "--machine", command]).trim();
}

export async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

export async function machineId(name) {
  const { machines } = await rpc("machines.list");
  return machines.find((entry) => entry.box.name === name).box.id;
}

export async function waitFor(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
    await pause(300);
  }
}

export async function browser() {
  const launched = await chromium.launch();
  const context = await launched.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark", reducedMotion: "reduce" });
  await context.addInitScript(() => {
    window.__shifts = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__shifts.push({ value: entry.value, at: entry.startTime, sources: (entry.sources ?? []).map((source) => source.node?.nodeName ?? "?") });
    }).observe({ type: "layout-shift", buffered: true });
  });
  const page = await context.newPage();
  await page.goto(base);
  if (await page.getByText("Skip setup").waitFor({ timeout: 6000 }).then(() => true, () => false)) {
    await page.getByText("Skip setup").click();
    await pause(1500);
  }
  return { launched, context, page };
}

const hostNames = (process.env.LIVE_HOST_NAMES ?? "").split(",").filter(Boolean);

export async function generic(page) {
  await page.evaluate((names) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const name of names) if (node.nodeValue?.includes(name)) node.nodeValue = node.nodeValue.split(name).join("pve-1");
  }, hostNames);
}

export async function shoot(page, name, sizes = [[1440, 1000], [760, 1000], [390, 844]], themes = ["dark", "light"]) {
  for (const theme of themes) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await pause(350);
      await generic(page);
      await page.screenshot({ path: join(shots, `${name}-${width}-${theme}.png`) });
    }
  }
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function focused(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    return element ? `${element.tagName.toLowerCase()} ${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? ""}` : "none";
  });
}

export async function tabTo(page, matches, most = 80) {
  const path = [];
  for (let presses = 1; presses <= most; presses++) {
    await page.keyboard.press("Tab");
    const now = await focused(page);
    path.push(now);
    if (matches(now)) return presses;
  }
  throw new Error(`Tab never reached it; the path: ${[...new Set(path)].join(" > ")}`);
}

export async function snapshotsOf(boxId) {
  return (await rpc("boxPage", { box: boxId })).snapshots;
}
