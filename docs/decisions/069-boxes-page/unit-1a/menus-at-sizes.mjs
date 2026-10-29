import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const label = process.argv[2] ?? "run";
const shots = join(process.env.LIVE_SHOTS ?? join(process.cwd(), "shots"), `${label}-sizes`);
const thread = process.env.LIVE_THREAD;
const project = process.env.LIVE_PROJECT;
const names = JSON.parse(process.env.LIVE_BOXES ?? "{}");
mkdirSync(shots, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listed = {};

const browser = await chromium.launch();

async function shoot(page, file, name) {
  await page.getByRole("button", { name: `${name} actions`, exact: true }).click();
  const menu = page.getByRole("menu").or(page.getByRole("dialog"));
  await menu.first().waitFor();
  await pause(400);
  listed[file] = await page.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim()));
  await page.mouse.move(0, 0);
  await pause(150);
  await page.screenshot({ path: join(shots, `${file}.png`) });
  await page.keyboard.press("Escape");
  await pause(300);
}

async function openPanel(page) {
  await page.goto(`${base}/projects/${project}/threads/${thread}`, { waitUntil: "domcontentloaded" });
  await pause(2500);
  const boxTab = page.locator("button, [role=tab]").filter({ hasText: /^Box$/ });
  if (!(await boxTab.first().isVisible().catch(() => false))) await page.keyboard.press("Control+j");
  await pause(1000);
  if (await boxTab.count()) await boxTab.first().click();
  await page.getByRole("button", { name: `${names.threadBox} actions`, exact: true }).waitFor();
  await pause(500);
}

for (const width of [1440, 760, 390]) {
  for (const scheme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme, storageState: process.env.LIVE_STATE });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const tag = `${width}-${scheme}`;
    try {
      await page.goto(`${base}/plugins/bb-box/desktop`, { waitUntil: "domcontentloaded" });
      for (const [tab, boxes] of [["Machines", [names.machine, names.machineDesktop]], ["Threads", [names.threadBox, names.threadDesktop]]]) {
        await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).or(page.getByRole("button", { name: new RegExp(`^${tab}\\s*\\d`) })).first().click();
        await page.getByRole("button", { name: `${boxes[0]} actions`, exact: true }).waitFor();
        await pause(500);
        for (const name of boxes.filter(Boolean)) await shoot(page, `${tab.toLowerCase()}-${name}-${tag}`, name);
      }
      for (const name of [names.threadBox, names.threadDesktop].filter(Boolean)) {
        await openPanel(page);
        await shoot(page, `panel-${name}-${tag}`, name);
      }
    } catch (error) {
      await page.screenshot({ path: join(shots, `failure-${tag}.png`) }).catch(() => {});
      listed[`failure-${tag}`] = String(error);
      process.exitCode = 1;
    }
    await context.close();
  }
}
writeFileSync(join(shots, "menus.json"), JSON.stringify(listed, null, 2));
await browser.close();
