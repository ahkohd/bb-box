import { join } from "node:path";
import { chromium } from "playwright";
import { boxes, home, pause, rpc, skipSetup, waitFor } from "./live-lib.mjs";

const [thread, name] = process.argv.slice(2);
const id = (await rpc("allBoxes")).find((entry) => entry.box.name === name).box.id;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
await skipSetup(page);
await page.goto(`${boxes}/box/${id}`);
await page.locator("h1[data-page-heading]").waitFor();
await page.getByRole("button", { name: "Stop", exact: true }).click();
await waitFor(async () => (await rpc("boxPage", { box: id })).box.state === "stopped", "stopped", 60_000);
await page.getByRole("button", { name: "Start", exact: true }).waitFor();
for (const theme of ["light", "dark"]) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  for (const [width, height] of [[1440, 1000], [760, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await pause(400);
    await page.screenshot({ path: join(home, "live-results", "shots", `stopped-${width}-${theme}.png`) });
  }
}
await rpc("start", { threadId: thread, box: id });
await browser.close();
