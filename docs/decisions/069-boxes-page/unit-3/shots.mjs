import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const home = process.env.HOME;
const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const shotDir = join(home, "shots");
mkdirSync(shotDir, { recursive: true });
const [name, boxId, range, read, widthsArg] = process.argv.slice(2);
const widths = (widthsArg ?? "1440,760,390").split(",").map(Number);
const TALL = { 1440: 1900, 760: 2300, 390: 3300 };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function skipSetup(page, url) {
  await page.goto(url);
  const skip = page.getByText("Skip setup");
  if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await skip.click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const path = boxId === "settings" ? `${base}/settings/plugins/bb-box#option/monitor` : `${base}/plugins/bb-box/desktop/box/${boxId}`;
await skipSetup(page, path);
const rangeName = (range ?? "live") === "live" ? "Live" : range.replace("h", " h").replace("d", " d");
async function chooseRange() {
  const activity = page.getByRole("region", { name: "Activity" });
  await activity.waitFor({ timeout: 60_000 });
  const radio = activity.getByRole("radio", { name: rangeName });
  if ((await radio.getAttribute("aria-checked")) !== "true") await radio.click();
  await activity.getByRole("application").first().waitFor({ timeout: 60_000 });
  await pause(1500);
}
if (boxId !== "settings") {
  await chooseRange();
} else {
  await page.getByText("Keep each box's history").first().waitFor({ timeout: 60_000 });
}
const said = [];
for (const scheme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: scheme });
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark");
  for (const width of widths) {
    await page.setViewportSize({ width, height: TALL[width] ?? 1000 });
    await pause(700);
    if (boxId !== "settings") await chooseRange();
    if (read) {
      const chart = page.getByRole("application").first();
      await chart.scrollIntoViewIfNeeded();
      const box = await chart.boundingBox();
      if (box) await page.mouse.move(box.x + box.width * Number(read), box.y + box.height / 2);
      await pause(300);
      said.push(await chart.locator("[data-chart-tip]").innerText().catch(() => ""));
    }
    const path = join(shotDir, `${name}-${width}-${scheme}.png`);
    if (process.env.ONLY_ACTIVITY) await page.locator("[data-activity]").screenshot({ path });
    else await page.screenshot({ path });
  }
}
const summary = boxId === "settings" ? "" : await page.getByRole("application").first().evaluate((element) => document.getElementById(element.getAttribute("aria-describedby"))?.textContent ?? "");
console.log(JSON.stringify({ name, summary, said: said[0] ?? null }));
await browser.close();
