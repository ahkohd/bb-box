import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
mkdirSync(out, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch();

async function open(page, hash) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  await page.locator(`[data-settings-view='${hash || "#"}']`).waitFor();
  await pause(800);
}

async function find(page, query) {
  const field = page.getByRole("combobox", { name: "Find a setting" });
  await field.click();
  await field.fill("");
  await page.keyboard.type(query);
  await pause(200);
}

const SCENES = [
  ["overview-results", "", "memory", false],
  ["kind-results", "#kind/linux", "mac-1", false],
  ["no-match", "#option/monitor", "zebra quartz", false],
  ["found-mac-field", "", "mac-1 cores", true],
  ["found-kind-size", "#kind/linux-desktop", "linux desktop gpu large disk", true],
];

for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 760, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    for (const [name, hash, query, enter] of SCENES) {
      await open(page, hash);
      await find(page, query);
      if (enter) {
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => document.querySelector("[data-found]") !== null, null, { timeout: 8_000 });
        await pause(150);
      }
      await page.screenshot({ path: join(out, `${name}-${width}-${scheme}.png`) });
    }
    await context.close();
  }
}
await browser.close();
console.log("done");
