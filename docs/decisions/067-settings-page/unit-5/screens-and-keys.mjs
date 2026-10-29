import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const machine = process.env.LIVE_MACHINE ?? "lab";
const [what, tag = "now"] = process.argv.slice(2);
const backendId = `docker:${machine}`;
mkdirSync(out, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch();

async function open(page, hash) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip setup" });
  await Promise.race([skip.waitFor({ timeout: 4_000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 4_000 }).catch(() => {})]);
  if (await skip.count()) {
    await skip.click();
    await pause(500);
    await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  }
  await page.locator("[data-settings-view]").waitFor();
  await page.getByText(/Looking for Docker|Looking…/).first().waitFor({ state: "detached", timeout: 15_000 }).catch(() => {});
  await pause(1_200);
}

async function focusSummary(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { name: "(body)", ring: false };
    const style = getComputedStyle(element);
    const ring = (style.boxShadow && style.boxShadow !== "none") || (style.outlineStyle !== "none" && style.outlineWidth !== "0px");
    const label = element.getAttribute("aria-label") || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 60) || element.tagName;
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${label}`, ring };
  });
}

async function tabTo(page, test, arg, most = 60) {
  for (let stop = 1; stop <= most; stop += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(test, arg)) return stop;
  }
  return null;
}

async function screens() {
  const pages = [
    ["overview", ""],
    ["page", `#backend/${encodeURIComponent(backendId)}`],
    ["add", "#add"],
  ];
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      for (const [name, hash] of pages) {
        await open(page, hash);
        await page.screenshot({ path: join(out, `${tag}-${name}-${width}-${scheme}.png`), fullPage: true });
      }
      await context.close();
    }
  }
}

async function keys() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const log = [];
  await open(page, "");
  await page.locator("[data-page-heading]").first().focus();
  const toRow = await tabTo(page, (id) => document.activeElement?.getAttribute("data-row-key") === `backend-${id}`, backendId, 40).catch(() => null);
  log.push(`Tab from the overview's heading reached the ${machine} row: ${toRow !== null}, ring: ${(await focusSummary(page)).ring}`);
  await page.locator("[data-page-heading]").first().focus();
  const stops = [];
  for (let stop = 0; stop < 12; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  log.push(`Overview stops: ${stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ")}`);
  await page.locator(`[data-row-key="backend-${backendId}"]`).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"));
  log.push(`Enter opened its page with focus on: ${(await focusSummary(page)).name}`);
  const pageStops = [];
  for (let stop = 0; stop < 10; stop += 1) {
    await page.keyboard.press("Tab");
    pageStops.push(await focusSummary(page));
  }
  log.push(`Page stops from the heading: ${pageStops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ")}`);
  const again = page.getByRole("button", { name: `Check Docker on ${machine} again` });
  if (await again.count()) {
    await again.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: `Check Docker on ${machine} again` }).filter({ hasText: "Check again" }).waitFor({ timeout: 30_000 }).catch(() => {});
    log.push(`Enter on Check again checked it; focus then on: ${(await focusSummary(page)).name}`);
  }
  await page.getByRole("button", { name: "BB Box settings" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction((id) => document.activeElement?.getAttribute("data-row-key") === `backend-${id}`, backendId, { timeout: 10_000 }).catch(() => {});
  log.push(`BB Box settings by Enter returned focus to: ${(await focusSummary(page)).name}`);
  const line = page.locator('[data-row-key="machines-line"]');
  if (await line.count()) {
    await line.focus();
    log.push(`The machines line's link: ${(await focusSummary(page)).name}, ring ${(await focusSummary(page)).ring}`);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"));
    log.push(`Enter opened: ${(await focusSummary(page)).name}`);
    const addStops = [];
    for (let stop = 0; stop < 6; stop += 1) {
      await page.keyboard.press("Tab");
      addStops.push(await focusSummary(page));
    }
    log.push(`Add backend stops: ${addStops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ")}`);
    await page.goBack();
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-row-key") === "machines-line", null, { timeout: 10_000 }).catch(() => {});
    log.push(`Back returned focus to: ${(await focusSummary(page)).name}`);
  }
  await pause(400);
  const animations = await page.evaluate(() => document.getAnimations().length);
  log.push(`Animations running: ${animations}`);
  await context.close();
  return log;
}

try {
  if (what === "screens") await screens();
  else if (what === "keys") {
    const log = await keys();
    console.log(log.join("\n"));
    writeFileSync(join(out, `keys-${tag}.txt`), `${log.join("\n")}\n`);
  } else throw new Error("screens or keys");
} finally {
  await browser.close();
}
