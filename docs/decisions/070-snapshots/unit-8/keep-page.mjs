import { join } from "node:path";
import { boxesUrl, browser, focused, generic, line, machineId, pause, rpc, shoot, shots, tabTo, waitFor } from "./live-lib.mjs";

const [machine, snapshot, width = "1440", tabSnapshot = ""] = process.argv.slice(2);
const narrow = Number(width) < 640;
const snap = async (page, name) => {
  await generic(page);
  await page.screenshot({ path: join(shots, `${name}-${width}-dark.png`) });
};

async function menuTo(page, item, most = 12) {
  const seen = [];
  for (let step = 0; step < most; step++) {
    const now = await focused(page);
    seen.push(now);
    if (now.slice(now.indexOf(" ") + 1) === item) return seen;
    await page.keyboard.press((await page.getByRole("menu").count()) ? "ArrowDown" : "Tab");
    await pause(150);
  }
  throw new Error(`the menu never reached ${item}: ${seen.join(" > ")}`);
}

const { launched, page } = await browser();
await page.setViewportSize({ width: Number(width), height: narrow ? 844 : 1000 });
const boxId = await machineId(machine);

line(`\n## Keep "${snapshot}" from ${machine}'s page at ${width} px, keyboard only (${new Date().toISOString()})`);
await page.goto(`${boxesUrl}/box/${boxId}`);
await page.locator("h1[data-page-heading]").waitFor({ timeout: 60_000 });
await pause(2000);
const presses = await tabTo(page, (now) => now === `button ${snapshot} actions`);
await page.keyboard.press("Enter");
await pause(400);
const path = await menuTo(page, "Keep…");
line(`- The row's menu reached in ${presses} Tab presses; ${(await page.getByRole("menu").count()) ? "a menu" : "a sheet"}, focus went ${path.join(" > ")}.`);
await page.keyboard.press("Enter");
const dialog = page.getByRole("alertdialog");
await dialog.waitFor();
await dialog.getByText(/copies this snapshot in full|lives on as a held copy/).waitFor({ timeout: 20_000 });
line(`- The dialog "${(await dialog.getByRole("heading").textContent()).trim()}", first focus ${await focused(page)}, date ${await dialog.locator("input[type=date]").inputValue()}.`);
line(`- It said: "${(await dialog.locator("p").allTextContents()).map((text) => text.trim()).filter(Boolean).join(" / ")}".`);
await snap(page, "keep-dialog");
await tabTo(page, (now) => now.startsWith("button Keep until"), 8);
const began = Date.now();
await page.keyboard.press("Enter");
await waitFor(async () => !(await dialog.count()), "the dialog to close", 20_000);
const kept = await waitFor(async () => (await rpc("boxPage", { box: boxId })).snapshots.records.find((row) => row.name === snapshot && row.keptUntil !== null), "the keep", 20_000);
line(`- Kept until ${new Date(kept.keptUntil).toISOString().slice(0, 10)}, ${((Date.now() - began) / 1000).toFixed(1)} s after Enter; focus back on ${await focused(page)}.`);
await pause(800);
await snap(page, "kept-row");

if (tabSnapshot) {
  line(`\n## The Snapshots tab at ${width} px, keyboard only: Select, then Keep "${tabSnapshot}"`);
  await page.goto(`${boxesUrl}/snapshots`);
  await page.getByRole("tab", { name: /Snapshots/ }).waitFor({ timeout: 30_000 });
  await page.getByText(/snapshots?( and \d+ undos?)?(, \d+ by agents)? · /).first().waitFor({ timeout: 30_000 });
  await pause(1500);
  line(`- The tab: "${(await page.getByRole("tab", { name: /Snapshots/ }).textContent()).trim()}"; the line under it: "${(await page.locator("p.text-muted-foreground").first().textContent()).trim()}".`);
  const regions = await page.locator("section[aria-label$=\"'s snapshots\"]").evaluateAll((all) => all.map((each) => each.getAttribute("aria-label")));
  line(`- Cards: ${regions.join(", ")}.`);
  await snap(page, "tab");
  const selectPresses = await tabTo(page, (now) => now === "button Select");
  await page.keyboard.press("Enter");
  const box = (await rpc("snapshots.tab")).groups.find((group) => group.rows.some((row) => row.name === tabSnapshot)).box.name;
  await tabTo(page, (now) => now === `input Select ${tabSnapshot} of ${box}`, 120);
  await page.keyboard.press("Space");
  await pause(300);
  line(`- Select reached in ${selectPresses} Tab presses; ticked "${tabSnapshot}" of ${box}; the bar says "${(await page.getByRole("toolbar").innerText()).split("\n")[0]}".`);
  await page.keyboard.press("Shift+Tab");
  await tabTo(page, (now) => now === "button Keep…", 120).catch(async () => {
    for (let back = 0; back < 120; back++) {
      await page.keyboard.press("Shift+Tab");
      if ((await focused(page)) === "button Keep…") return;
    }
    throw new Error("never reached the bar's Keep…");
  });
  await page.keyboard.press("Enter");
  const bulk = page.getByRole("alertdialog");
  await bulk.waitFor();
  await bulk.getByText(/Each is kept on its own backend|Skipped, and why/).waitFor({ timeout: 30_000 });
  line(`- The bulk dialog "${(await bulk.getByRole("heading").textContent()).trim()}", first focus ${await focused(page)}: "${(await bulk.locator("li").allTextContents()).join(" / ")}".`);
  await snap(page, "tab-bulk-keep");
  await tabTo(page, (now) => /^button Keep \d+ until/.test(now), 10);
  await page.keyboard.press("Enter");
  await waitFor(async () => !(await bulk.count()), "the bulk dialog to close", 30_000);
  const row = (await rpc("snapshots.tab")).groups.flatMap((group) => group.rows).find((each) => each.name === tabSnapshot);
  line(`- After Keep: "${tabSnapshot}" kept until ${row.keptUntil ? new Date(row.keptUntil).toISOString().slice(0, 10) : "none"}; focus on ${await focused(page)}.`);
  await shoot(page, "tab-after", [[1440, 1000], [760, 1000], [390, 844]], ["dark", "light"]);
}
await launched.close();
