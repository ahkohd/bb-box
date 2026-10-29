import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const [what, tag = "now"] = process.argv.slice(2);
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
    const label = element.getAttribute("aria-label") || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 70) || element.tagName;
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${label}`, ring };
  });
}

async function tabTo(page, test, arg, most = 80) {
  for (let stop = 1; stop <= most; stop += 1) {
    await page.keyboard.press("Tab");
    if (await page.evaluate(test, arg)) return stop;
  }
  return null;
}

const SETUP_PAGES = {
  first: [
    ["overview", "", null],
    ["add", "#add", null],
    ["setup", "#setup/proxmox-lxc", null],
    ["setup-refused", "#setup/proxmox-lxc", "Save and turn on"],
    ["setup-tart", "#setup/tart", null],
  ],
  done: [
    ["overview", "", null],
    ["unfinished", "#backend/proxmox-lxc", null],
    ["add", "#add", null],
  ],
};

async function screens() {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      for (const [name, hash, press] of SETUP_PAGES[tag]) {
        await open(page, hash);
        if (press) {
          await page.getByRole("button", { name: press }).click();
          await page.getByText(/^Not saved/).first().waitFor({ timeout: 15_000 });
          await pause(500);
        }
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
  const stops = [];
  for (let stop = 0; stop < 8; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  log.push(`From the overview's heading, Tab went: ${stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" → ")}`);
  await page.locator("[data-page-heading]").first().focus();
  const toChoose = await tabTo(page, () => document.activeElement?.getAttribute("data-row-key") === "first-run-add");
  await page.keyboard.press("Enter");
  await pause(800);
  log.push(`Enter on Choose another backend (stop ${toChoose}): ${new URL(page.url()).hash}, focus ${(await focusSummary(page)).name}`);
  await page.screenshot({ path: join(out, `keys-01-add.png`) });
  const toLxc = await tabTo(page, () => document.activeElement?.getAttribute("data-row-key") === "add-proxmox-lxc");
  log.push(`Tab reached Proxmox LXC in ${toLxc} stops, ring ${(await focusSummary(page)).ring}`);
  await page.keyboard.press("Enter");
  await pause(800);
  log.push(`Enter: ${new URL(page.url()).hash}, focus ${(await focusSummary(page)).name}`);
  const setupStops = [];
  for (let stop = 0; stop < 12; stop += 1) {
    await page.keyboard.press("Tab");
    setupStops.push(await focusSummary(page));
  }
  log.push(`On the setup page Tab went: ${setupStops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" → ")}`);
  await page.locator("[data-page-heading]").first().focus();
  await tabTo(page, () => document.activeElement?.getAttribute("aria-label") === null && document.activeElement?.id && document.querySelector(`label[for="${document.activeElement.id}"]`)?.textContent === "API URL");
  await page.keyboard.type("https://192.0.2.10:8006/api2/json");
  await page.keyboard.press("Enter");
  await pause(1_000);
  log.push(`Typed the API URL and pressed Enter: still ${new URL(page.url()).hash}; the bar says "${(await page.getByRole("region", { name: /^Save Proxmox LXC/ }).innerText()).replace(/\s+/g, " ").slice(0, 120)}"`);
  await page.screenshot({ path: join(out, `keys-02-setup.png`) });
  const toOff = await tabTo(page, () => document.activeElement?.textContent?.trim() === "Save, keep it off", null, 120);
  log.push(`Tab reached Save, keep it off in ${toOff} stops, ring ${(await focusSummary(page)).ring}`);
  await page.keyboard.press("Enter");
  await page.waitForURL(/#backend\/proxmox-lxc$/, { timeout: 30_000 });
  await pause(1_000);
  log.push(`Enter saved it off: ${new URL(page.url()).hash}, focus ${(await focusSummary(page)).name}`);
  await page.screenshot({ path: join(out, `keys-03-saved.png`) });
  log.push(`Animations running: ${await page.evaluate(() => document.getAnimations().map((animation) => animation.animationName ?? animation.constructor.name).join(", ") || "none")}`);
  writeFileSync(join(out, "keys.txt"), `${log.join("\n")}\n`);
  console.log(log.join("\n"));
  await context.close();
}

try {
  if (what === "screens") await screens();
  else if (what === "keys") await keys();
  else throw new Error("screens <first|done> or keys");
} finally {
  await browser.close();
}
