import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const shotDir = join(process.env.HOME, "shots");
mkdirSync(shotDir, { recursive: true });
const [name, boxId] = process.argv.slice(2);
const TALL = { 1440: 1900, 760: 2300, 390: 3300 };
const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 760, 390]) {
    const context = await browser.newContext({ viewport: { width, height: TALL[width] ?? 1000 }, colorScheme: scheme, reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${base}/plugins/bb-box/desktop/box/${boxId}`);
    const skip = page.getByText("Skip setup");
    if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await skip.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await page.route("**/rpc/monitor.machine", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      await route.continue().catch(() => undefined);
    });
    await page.goto(`${base}/plugins/bb-box/desktop/box/${boxId}`);
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark");
    await page.locator('[aria-label="Facts"]').waitFor({ timeout: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 800));
    await page.screenshot({ path: join(shotDir, `${name}-${width}-${scheme}.png`) });
    await context.close();
  }
}
await browser.close();
