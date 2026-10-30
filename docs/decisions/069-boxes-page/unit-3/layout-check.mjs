import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const [boxId, widthsArg, holdArg] = process.argv.slice(2);
const widths = (widthsArg ?? "1440,390").split(",").map(Number);
const holdMs = Number(holdArg ?? 4000);
const out = join(process.env.HOME, "run", "layout-check.jsonl");

async function positions(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('[aria-label="Facts"]')?.closest(".overflow-y-auto");
    const top = (element) => (element ? Math.round(element.getBoundingClientRect().top + (scroller?.scrollTop ?? 0) - (scroller?.getBoundingClientRect().top ?? 0)) : null);
    return {
      facts: top(document.querySelector('[aria-label="Facts"]')),
      threads: top(document.querySelector('[aria-labelledby="threads-heading"]')),
      started: top(document.querySelector('[aria-labelledby="started-heading"]')),
      processes: top(document.querySelector("[data-processes]")),
      height: scroller?.scrollHeight ?? null,
      reading: document.querySelector("[data-activity] h2 + span")?.textContent ?? null,
    };
  });
}

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  for (const width of widths) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${base}/plugins/bb-box/desktop/box/${boxId}`);
    const skip = page.getByText("Skip setup");
    if (await skip.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      await skip.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await page.route("**/rpc/monitor.machine", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      await route.continue();
    });
    await page.goto(`${base}/plugins/bb-box/desktop/box/${boxId}`);
    await page.getByRole("region", { name: "Activity" }).waitFor({ timeout: 60_000 });
    await page.locator('[aria-label="Facts"]').waitFor({ timeout: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const before = await positions(page);
    await page.getByText(/^Read at /).first().waitFor({ timeout: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const after = await positions(page);
    const same = ["facts", "threads", "started", "processes", "height"].every((key) => before[key] === after[key]);
    const line = { at: Date.now(), box: boxId, width, scheme, same, before, after };
    appendFileSync(out, `${JSON.stringify(line)}\n`);
    console.log(JSON.stringify(line));
    await context.close();
  }
}
await browser.close();
