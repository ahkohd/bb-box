import { boxesUrl, browser, generic, machineId, pause, shots } from "./live-lib.mjs";
import { join } from "node:path";

const [name, label = name] = process.argv.slice(2);
const id = await machineId(name);
const { launched, page } = await browser();

async function at(width, height, theme) {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.setViewportSize({ width, height });
  await page.goto(`${boxesUrl}/box/${id}`);
  await page.locator("[data-snapshots-card]").waitFor({ timeout: 20_000 });
  await pause(1500);
}

async function shot(what, width, theme, full = false) {
  await generic(page);
  await page.screenshot({ path: join(shots, `${what}-${label}-${width}-${theme}.png`), fullPage: full });
}

for (const theme of ["dark", "light"]) {
  for (const [width, height] of [[1440, 1000], [760, 1000], [390, 844]]) {
    await at(width, height, theme);
    await shot("page", width, theme);
    await page.locator("[data-snapshots-card]").evaluate((card) => card.scrollIntoView({ block: "start" }));
    await pause(300);
    await shot("card", width, theme);
    await page.getByRole("button", { name: "Take snapshot", exact: true }).click();
    await page.getByRole("alertdialog").getByText(/of \d+ for/).waitFor({ timeout: 20_000 }).catch(() => null);
    await shot("take-dialog", width, theme);
    await page.keyboard.press("Escape");
    const restore = page.getByRole("button", { name: new RegExp(`^Restore ${name} to `) }).first();
    if (await restore.count()) {
      await restore.click({ force: true });
      await page.getByRole("alertdialog").getByText(/goes back to|threads run on|cannot/).first().waitFor({ timeout: 30_000 }).catch(() => null);
      await shot("restore-dialog", width, theme);
      await page.keyboard.press("Escape");
    }
    const tile = page.getByRole("button", { name: new RegExp(`^Show ${name}'s screen around`) }).first();
    if (width === 1440 && (await tile.count())) {
      await page.mouse.move(0, 0);
      await tile.click();
      await pause(400);
      await page.locator("figure img").waitFor({ timeout: 5000 }).catch(() => null);
      await shot("picture", width, theme);
      await page.keyboard.press("Escape");
    }
  }
}
await launched.close();
