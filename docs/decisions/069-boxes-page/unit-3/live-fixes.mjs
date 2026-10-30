import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = "http://127.0.0.1:7801";
const shotDir = join(process.env.HOME, "shots");
mkdirSync(shotDir, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const [name, boxId, range, ...stepTimes] = process.argv.slice(2);
const stepMs = range === "1h" ? 60_000 : range === "24h" ? 600_000 : 3_600_000;
const steps = range === "1h" ? 60 : range === "24h" ? 144 : 168;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1900 } });
await page.goto(`${base}/plugins/bb-box/desktop/box/${boxId}`);
const skip = page.getByText("Skip setup");
if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
  await skip.click();
  await pause(1500);
}
const activity = page.getByRole("region", { name: "Activity" });
await activity.waitFor({ timeout: 60_000 });
await activity.getByRole("radio", { name: range.replace("h", " h").replace("d", " d") }).click();
await page.locator("[data-history-ready]").waitFor({ timeout: 60_000 });
await pause(1500);
const chart = activity.getByRole("application").first();
const summary = await chart.evaluate((element) => document.getElementById(element.getAttribute("aria-describedby"))?.textContent ?? "");
const words = await activity.locator("[data-chart-words]").first().innerText();
const bands = await chart.locator("[data-band]").evaluateAll((rects) => rects.map((rect) => rect.getAttribute("data-band")));
const to = Math.ceil(Date.now() / stepMs) * stepMs;
const from = to - steps * stepMs;
const readOuts = [];
for (const time of stepTimes) {
  const at = Date.parse(time);
  const index = Math.floor((at - from) / stepMs);
  await chart.focus();
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step++) await page.keyboard.press("ArrowRight");
  await pause(200);
  readOuts.push(`${time} -> ${await chart.locator("[data-read-out]").innerText().catch(() => "")}`);
}
await page.keyboard.press("Escape");
await page.locator("body").click({ position: { x: 5, y: 5 } });
await pause(300);
await activity.screenshot({ path: join(shotDir, `${name}-1440-light.png`) });
console.log(JSON.stringify({ name, words, summary, bands, readOuts }, null, 1));
await browser.close();
