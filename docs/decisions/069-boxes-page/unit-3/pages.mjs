import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const home = process.env.HOME;
const seconds = Number(process.argv[2] ?? 3600);
const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const boxes = JSON.parse(readFileSync(join(home, "run", "boxes.json"), "utf8")).filter((box) => box.role === "page").slice(0, 5);
const note = (event) => appendFileSync(join(home, "run", "events.jsonl"), `${JSON.stringify({ at: Date.now(), event })}\n`);


async function skipSetup(page, url) {
  await page.goto(url);
  const skip = page.getByText("Skip setup");
  if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    await skip.click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await skipSetup(await context.newPage(), `${base}/plugins/bb-box/desktop`);
for (const box of boxes) {
  const page = await context.newPage();
  await page.goto(`${base}/plugins/bb-box/desktop/box/${box.id}`);
  await page.getByText(/^Read at /).first().waitFor({ timeout: 60_000 }).catch(() => note(`page ${box.name} did not say Read at`));
}
note(`${boxes.length} pages open on Live`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
await browser.close();
note("pages closed");
