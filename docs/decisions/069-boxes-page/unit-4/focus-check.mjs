import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { boxes, containerOf, docker, expect, home, makeReport, pause, rpc, skipSetup, waitFor } from "./live-lib.mjs";

const name = process.argv[2];
const { line, check } = makeReport("focus");
const shots = join(home, "live-results", "shots");
mkdirSync(shots, { recursive: true });

const entry = (await rpc("allBoxes")).find((each) => each.box.name === name);
expect(entry, `no box ${name}`);
const container = containerOf(entry.box.id);
line(`Box: ${name} (${entry.box.id}), container ${container}.`);
line("");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(20_000);
await skipSetup(page);

await check("reason", "a box stopped outside bb-box says Unexpected stop on its line, with the warning mark", async () => {
  if (docker(["inspect", "-f", "{{.State.Running}}", container]) === "true") docker(["stop", container]);
  const stopped = await waitFor(async () => (await rpc("allBoxes")).find((each) => each.box.id === entry.box.id && each.box.stopped)?.box, "bb-box to see the stop", 6 * 60_000);
  await page.goto(`${boxes}/threads`);
  const row = page.locator("[data-resource-row]", { hasText: name }).first();
  await waitFor(async () => (await row.locator("[data-row-line]").textContent()).includes("Unexpected stop"), "Unexpected stop on the line", 30_000);
  expect((await row.locator("[data-reason-mark]").count()) === 1, "no warning mark");
  return `state ${stopped.state}; line "${(await row.locator("[data-row-line]").textContent()).replaceAll("·", " · ").replace(/\s+/g, " ").replace(/^ · /, "").trim()}"`;
});

const tooltip = page.getByRole("tooltip").filter({ hasText: "Unexpected stop" });
const nameFocused = () => page.evaluate((boxName) => document.activeElement?.getAttribute("aria-label") === boxName && document.activeElement.hasAttribute("data-row-name"), name);

await check("keys", "keyboard only: the name's focus shows the line's tooltip with its reason, Escape hides it, and it goes when focus moves on", async () => {
  await page.locator("input[aria-label='Search boxes']").focus();
  for (let index = 0; index < 40 && !(await nameFocused()); index++) await page.keyboard.press("Tab");
  expect(await nameFocused(), "Tab did not reach the name");
  await tooltip.waitFor({ state: "visible", timeout: 5000 });
  const said = (await tooltip.textContent()).replace(/\s+/g, " ").trim();
  expect(said.startsWith("Unexpected stop:"), `the tooltip said ${said}`);
  for (const dark of [false, true]) {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
    await pause(600);
    await page.screenshot({ path: join(shots, `focus-tooltip-1440-${dark ? "dark" : "light"}.png`) });
  }
  await page.keyboard.press("Escape");
  await tooltip.waitFor({ state: "hidden", timeout: 5000 });
  expect(await nameFocused(), "Escape moved focus");
  await page.keyboard.press("Tab");
  await tooltip.waitFor({ state: "hidden", timeout: 5000 });
  await page.keyboard.press("Shift+Tab");
  expect(await nameFocused(), "Shift+Tab did not come back to the name");
  await tooltip.waitFor({ state: "visible", timeout: 5000 });
  await page.keyboard.press("Tab");
  await tooltip.waitFor({ state: "hidden", timeout: 5000 });
  return `"${said.slice(0, 160)}${said.length > 160 ? "…" : ""}"`;
});

await check("pointer", "a click on the search field and a pointer resting away from the row show no tooltip", async () => {
  await page.locator("input[aria-label='Search boxes']").click();
  await page.mouse.move(5, 5);
  await pause(800);
  expect((await tooltip.count()) === 0, "the row's tooltip showed");
});

await browser.close();
