import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const bbCli = process.env.LIVE_BB_CLI ?? join(process.env.HOME ?? "", "bbcli");
const projectDir = process.env.LIVE_PROJECT ?? join(process.env.HOME ?? "", "proj");
mkdirSync(out, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function ensureRustTools() {
  if ((await rpc("config.get")).document.images?.["rust-tools"]) return;
  execFileSync(bbCli, ["box", "image", "set", "rust-tools", "--kinds", "linux", "--script-file", ".bb/box-setup.sh", "--check-file", ".bb/box-check.sh", "--project", "proj_example"], { cwd: projectDir, stdio: "pipe" });
}

const browser = await chromium.launch();
const shots = [];

async function shot(page, name) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}

async function open(page, hash) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip setup" });
  await Promise.race([skip.waitFor({ timeout: 4_000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 4_000 }).catch(() => {})]);
  if (await skip.count()) {
    await skip.click();
    await pause(500);
    await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  }
  await page.locator("[data-settings-view]").waitFor();
  await pause(600);
}

async function animations(page) {
  await pause(400);
  return page.evaluate(() => {
    const running = document.getAnimations().map((animation) => `${animation.animationName ?? animation.transitionProperty ?? "animation"} on ${animation.effect?.target?.getAttribute?.("class")?.slice(0, 50) ?? "?"}`);
    return running.length ? `${running.length}: ${running.join("; ")}` : "none";
  });
}

async function focused(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { name: "(page)", ring: false };
    const style = getComputedStyle(element);
    const ring = (style.boxShadow && style.boxShadow !== "none") || (style.outlineStyle !== "none" && style.outlineWidth !== "0px");
    const name = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? element.tagName;
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()} "${name}"`, ring };
  });
}

await ensureRustTools();
for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 760, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await open(page, "#option/images");
    await shot(page, `images-${width}-${scheme}`);
    await page.getByRole("button", { name: "rust-tools", exact: true }).click();
    await page.getByRole("button", { name: "Remove rust-tools…" }).scrollIntoViewIfNeeded();
    await pause(300);
    await shot(page, `project-image-${width}-${scheme}`);
    await page.getByRole("button", { name: "Remove rust-tools…" }).click();
    await page.getByRole("alertdialog").waitFor();
    await pause(500);
    await shot(page, `remove-${width}-${scheme}`);
    await page.keyboard.press("Escape");
    await open(page, "");
    await shot(page, `status-${width}-${scheme}`);
    await context.close();
  }
}

const keys = [];
{
  const state = await rpc("config.get");
  const { bake: _bake, ...rust } = state.document.images["rust-tools"];
  await rpc("config.apply", { draft: { ...state.document, images: { ...state.document.images, "rust-tools": rust } }, revision: state.revision });
}
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
const page = await context.newPage();
await open(page, "#option/images");
await page.locator("[data-page-heading]").focus();
const tabs = [];
for (let step = 0; step < 9; step += 1) {
  await page.keyboard.press("Tab");
  tabs.push(await focused(page));
}
keys.push(`Tab from the heading: ${tabs.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" → ")}`);

await page.getByRole("switch", { name: "Rebuild each night" }).focus();
await page.keyboard.press("Space");
await page.getByText("Saved", { exact: true }).first().waitFor();
keys.push(`Space on Rebuild each night: stored ${(await rpc("config.get")).document.general.nightlyImages}`);
await page.keyboard.press("Space");
await pause(1500);
keys.push(`Space again: stored ${(await rpc("config.get")).document.general.nightlyImages ?? "the default (off)"}`);

await page.getByRole("button", { name: "rust-tools", exact: true }).focus();
await page.keyboard.press("Enter");
keys.push(`Enter on the rust-tools row: aria-expanded ${await page.getByRole("button", { name: "rust-tools", exact: true }).getAttribute("aria-expanded")}`);
await page.keyboard.press("Tab");
const menu = await focused(page);
await page.keyboard.press("Enter");
await page.getByRole("listbox").waitFor();
await pause(300);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await pause(1500);
keys.push(`Tab to ${menu.name}, Enter, ArrowDown, Enter: stored bake ${(await rpc("config.get")).document.images["rust-tools"].bake ?? "auto"}; focus on ${(await focused(page)).name}`);
await page.keyboard.press("Enter");
await page.getByRole("listbox").waitFor();
await pause(300);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Enter");
await pause(1500);
keys.push(`back by keys: stored bake ${(await rpc("config.get")).document.images["rust-tools"].bake ?? "auto"}`);

const after = [];
for (let step = 0; step < 4; step += 1) {
  await page.keyboard.press("Tab");
  after.push(await focused(page));
}
keys.push(`Tab on into the details: ${after.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" → ")}`);
await page.getByRole("button", { name: "Remove rust-tools…" }).focus();
await page.keyboard.press("Enter");
await page.getByRole("alertdialog").waitFor();
await pause(300);
keys.push(`Enter on Remove rust-tools…: the dialog opens with focus on ${(await focused(page)).name}`);
await page.keyboard.press("Escape");
await pause(500);
keys.push(`Escape: the dialog closes, focus on ${(await focused(page)).name}, rust-tools still stored: ${!!(await rpc("config.get")).document.images["rust-tools"]}`);
await page.getByRole("button", { name: "Remove rust-tools…" }).focus();
await page.keyboard.press("Enter");
await page.getByRole("alertdialog").waitFor();
await pause(300);
let guard = 0;
while (!(await focused(page)).name.includes("Remove image") && guard++ < 4) await page.keyboard.press("Tab");
await page.keyboard.press("Enter");
await page.getByText("Removed the image rust-tools.").waitFor();
await pause(500);
keys.push(`Tab to Remove image, Enter: removed (${!(await rpc("config.get")).document.images["rust-tools"]}), focus on ${(await focused(page)).name}`);
keys.push(`Animations after it all: ${await animations(page)}`);
await context.close();
await browser.close();
await ensureRustTools();

writeFileSync(join(out, "keys.txt"), `${keys.join("\n")}\n`);
console.log(keys.join("\n"));
console.log(`${shots.length} screenshots in ${out}`);
