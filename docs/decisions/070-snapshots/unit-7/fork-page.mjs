import { join } from "node:path";
import { boxesUrl, browser, focused, generic, line, pause, rpc, shots, tabTo, waitFor } from "./live-lib.mjs";

const [boxId, snapshot, width = "1440", newName = ""] = process.argv.slice(2);
const narrow = Number(width) < 640;
const snap = async (page, name) => {
  await generic(page);
  await page.screenshot({ path: join(shots, `${name}-${width}-dark.png`) });
};
const { launched, page } = await browser();
await page.setViewportSize({ width: Number(width), height: narrow ? 844 : 1000 });
line(`\n## Fork "${snapshot}" from the page at ${width} px, keyboard only (${new Date().toISOString()})`);
await page.goto(`${boxesUrl}/box/${boxId}`);
await page.locator("h1[data-page-heading]").waitFor({ timeout: 60_000 });
await pause(2000);
const name = (await page.locator("h1[data-page-heading]").textContent()).trim();
let presses;
if (narrow) {
  presses = await tabTo(page, (now) => now === `button ${snapshot} actions`);
  await page.keyboard.press("Enter");
  await page.getByText("Fork…").first().waitFor({ timeout: 10_000 });
  await pause(500);
  const items = [];
  for (let step = 0; step < 12 && !/^\w+ Fork…/.test(await focused(page)); step++) {
    items.push(await focused(page));
    await page.keyboard.press(step < 6 ? "ArrowDown" : "Tab");
    await pause(200);
  }
  line(`- The row's menu reached in ${presses} Tab presses; at ${width} px it shows as ${(await page.getByRole("menu").count()) ? "a menu" : "a sheet"}; focus went ${[...items, await focused(page)].join(" > ")}.`);
  await page.keyboard.press("Enter");
} else {
  presses = await tabTo(page, (now) => now === `button Fork ${snapshot} into a new box`);
  line(`- Fork reached in ${presses} Tab presses.`);
  await page.keyboard.press("Enter");
}
const dialog = page.getByRole("alertdialog");
await dialog.waitFor();
line(`- The dialog: "${(await dialog.getByRole("heading").textContent()).trim()}", first focus "${await focused(page)}".`);
if (newName) await page.keyboard.type(newName);
await dialog.getByText(/as the snapshot holds/).waitFor({ timeout: 20_000 });
line(`- It said: "${(await dialog.locator("p").allTextContents()).map((text) => text.trim()).filter(Boolean).join(" / ")}".`);
await snap(page, "fork-dialog");
const before = page.url();
await tabTo(page, (now) => now.startsWith("button Fork "), 12);
const began = Date.now();
await page.keyboard.press("Enter");
await waitFor(async () => page.url() !== before, "the new box's page", 30_000);
const opened = Date.now() - began;
const forkId = page.url().split("/box/")[1]?.split(/[/?#]/)[0];
line(`- Fork opened the new box's page ${(opened / 1000).toFixed(1)} s after Enter: ${forkId}.`);
await snap(page, "fork-starting");
const ready = await waitFor(async () => {
  const state = await rpc("boxPage", { box: forkId });
  return state.box?.state === "ready" || state.box?.state === "failed" ? state.box : null;
}, "the fork ready", 240_000);
const facts = page.locator("section[aria-label=Facts]");
await facts.waitFor({ timeout: 30_000 });
await pause(1500);
line(`- The fork is ${ready.state} ${((Date.now() - began) / 1000).toFixed(1)} s after Enter${ready.error ? `: ${ready.error}` : ""}; its facts say "${(await facts.innerText()).match(/Forked from [^)]*\)/)?.[0] ?? "nothing of a fork"}".`);
await snap(page, "fork-ready");
line(`- From ${name}.`);
await launched.close();
