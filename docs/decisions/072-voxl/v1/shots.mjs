import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const { BOX, LIVE_THREAD } = process.env;
const shots = join(process.env.HOME, "live-results", "shots");
mkdirSync(shots, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SIZES = [
  [1440, 1000],
  [760, 1000],
  [390, 844],
];

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await page.goto(base);
if (await page.getByText("Skip setup").waitFor({ timeout: 6000 }).then(() => true, () => false)) await page.getByText("Skip setup").click();

const viewer = `${base}/plugins/bb-box/desktop/${LIVE_THREAD}/${BOX}`;
for (const theme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await page.goto(viewer);
    await page.getByText("The agent has control.").waitFor();
    await pause(2500);
    await page.screenshot({ path: join(shots, `viewer-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "Desktop actions" }).click();
    await pause(300);
    const display = page.getByRole("menuitem", { name: "Display" });
    if (await display.count()) await display.click();
    await page.getByRole("menuitemcheckbox", { name: "Stream with voxl" }).waitFor();
    await pause(400);
    await page.screenshot({ path: join(shots, `viewer-menu-${width}-${theme}.png`) });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${base}/settings/plugins/bb-box#backend/docker`);
  const field = page.getByText("Stream desktops with voxl").first();
  await field.waitFor();
  await field.scrollIntoViewIfNeeded();
  await pause(800);
  await page.screenshot({ path: join(shots, `settings-docker-1440-${theme}.png`) });
}
await browser.close();
console.log("shots written");
