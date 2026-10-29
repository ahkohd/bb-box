import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const label = process.argv[2] ?? "run";
const shots = join(process.env.LIVE_SHOTS ?? join(process.cwd(), "shots"), label);
const thread = process.env.LIVE_THREAD;
const project = process.env.LIVE_PROJECT;
const names = JSON.parse(process.env.LIVE_BOXES ?? "{}");
mkdirSync(shots, { recursive: true });

const results = { label, menus: {}, effects: [] };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function stateOf(name) {
  const all = await rpc("allBoxes");
  const entry = (all.boxes ?? all).find((each) => each.box.name === name);
  if (entry) return entry.box.state;
  const machines = await rpc("machines.list");
  return machines.machines.find((each) => each.box.name === name)?.box.state ?? "absent";
}

async function waitForState(name, state, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    last = await stateOf(name);
    if (last === state) return last;
    await pause(300);
  }
  throw new Error(`${name} stayed ${last}, not ${state}`);
}

function effect(place, box, item, outcome) {
  results.effects.push({ place, box, item, outcome });
  console.log(`${place} · ${box} · ${item}: ${outcome}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, storageState: process.env.LIVE_STATE });
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
const rpcCalls = [];
page.on("request", (request) => {
  const match = request.url().match(/\/rpc\/([^/?]+)/);
  if (match && request.method() === "POST") rpcCalls.push({ method: match[1], body: request.postData() ?? "" });
});

async function openMenu(name) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `${name} actions`, exact: true }).click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  await pause(250);
  return menu;
}

async function recordMenu(place, name, state) {
  const menu = await openMenu(name);
  const items = await menu.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent?.trim(), disabled: node.getAttribute("aria-disabled") === "true" || node.hasAttribute("data-disabled") })));
  const separators = await menu.locator("[role=separator]").count();
  results.menus[`${place} · ${name} · ${state}`] = { items, separators };
  await page.mouse.move(0, 999);
  await pause(150);
  await page.screenshot({ path: join(shots, `${place}-${name}-${state}.png`) });
  return menu;
}

async function choose(name, item) {
  const menu = await openMenu(name);
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
}

async function clipboard() {
  return page.evaluate(() => navigator.clipboard.readText());
}

async function popupAfter(action) {
  const popup = context.waitForEvent("page", { timeout: 10_000 });
  await action();
  const opened = await popup;
  const url = opened.url() === "about:blank" ? (await opened.waitForURL(/http/, { timeout: 10_000 }).then(() => opened.url())) : opened.url();
  await opened.close();
  return url;
}

async function panelTabs() {
  return page.locator("button, [role=tab]").evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() ?? "").filter((text) => /^(Terminal|Desktop|Simulator|Emulator)(: .+)?$/.test(text)));
}

async function callsDuring(action, wait = 1500) {
  const from = rpcCalls.length;
  await action();
  await pause(wait);
  return rpcCalls.slice(from);
}

async function boxPanel() {
  await page.goto(`${base}/projects/${project}/threads/${thread}`, { waitUntil: "domcontentloaded" });
  await pause(2500);
  const show = page.getByRole("button", { name: /Show right panel/ });
  if (await show.count()) await show.click();
  await pause(800);
  const boxTab = page.getByRole("tab", { name: /^Box$/ });
  if (await boxTab.count()) await boxTab.first().click();
  else {
    await page.getByRole("button", { name: /Open new tab/ }).click();
    await page.getByText("Box", { exact: true }).first().click();
  }
  await page.getByRole("button", { name: `${names.threadBox} actions`, exact: true }).waitFor();
  await pause(500);
}

async function boxesPage(tab) {
  await page.goto(`${base}/plugins/bb-box/desktop`, { waitUntil: "domcontentloaded" });
  const tabs = page.getByRole("tab", { name: new RegExp(`^${tab === "machines" ? "Machines" : "Threads"}`) });
  await tabs.or(page.getByRole("button", { name: new RegExp(`^${tab === "machines" ? "Machines" : "Threads"}\\s*\\d`) })).first().click();
  await page.getByRole("button", { name: `${tab === "machines" ? names.machine : names.threadBox} actions`, exact: true }).waitFor();
  await pause(500);
}

async function threadBoxItems(place, reopen) {
  const name = names.threadBox;
  await recordMenu(place, name, "ready");
  await page.keyboard.press("Escape");

  await choose(name, "Copy address");
  effect(place, name, "Copy address", `clipboard ${await clipboard()}`);

  const checks = await callsDuring(() => choose(name, "Check now"));
  effect(place, name, "Check now", `calls ${checks.map((call) => `${call.method} ${call.body}`).join("; ")}`);

  const resizeCalls = await callsDuring(async () => {
    await choose(name, "Resize…");
    await page.getByRole("alertdialog").waitFor();
  }, 2500);
  const dialogTitle = await page.getByRole("alertdialog").getByRole("heading").first().textContent();
  effect(place, name, "Resize…", `dialog "${dialogTitle}", calls ${resizeCalls.filter((call) => call.method.includes("resize")).map((call) => `${call.method} ${call.body}`).join("; ")}`);
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await pause(300);

  await choose(name, "Stop");
  await waitForState(name, "stopped");
  await reopen();
  effect(place, name, "Stop", "stopped");
  await recordMenu(place, name, "stopped");
  await page.keyboard.press("Escape");
  await choose(name, "Start");
  await waitForState(name, "ready");
  effect(place, name, "Start", "ready");
  await reopen();

  const terminalCalls = await callsDuring(() => choose(name, "Open terminal"), 2000);
  effect(place, name, "Open terminal", `url ${page.url().replace(base, "")}, panel tabs [${(await panelTabs()).join(", ")}], calls ${terminalCalls.map((call) => call.method).join(", ")}`);
  await page.screenshot({ path: join(shots, `${place}-${name}-terminal.png`) });
  await reopen();

  if (names.threadDesktop) {
    const desktop = names.threadDesktop;
    await recordMenu(place, desktop, "ready");
    await page.keyboard.press("Escape");
    const browserUrl = await popupAfter(() => choose(desktop, "Open in browser"));
    effect(place, desktop, "Open in browser", `new tab ${browserUrl.replace(base, "")}`);
    await choose(desktop, "Open desktop");
    await pause(2000);
    effect(place, desktop, "Open desktop", `url ${page.url().replace(base, "")}, panel tabs [${(await panelTabs()).join(", ")}]`);
    await page.screenshot({ path: join(shots, `${place}-${desktop}-desktop.png`) });
    await reopen();
  }

  const doomed = names.release[place];
  if (doomed) {
    await recordMenu(place, doomed, "ready");
    await page.keyboard.press("Escape");
    await choose(doomed, "Release…");
    const dialog = page.getByRole("alertdialog");
    const words = (await dialog.textContent())?.trim();
    await page.screenshot({ path: join(shots, `${place}-${doomed}-release-dialog.png`) });
    await dialog.getByRole("button", { name: "Release", exact: true }).click();
    await waitForState(doomed, "absent");
    effect(place, doomed, "Release…", `asked "${words}", then released`);
  }
}

async function machineItems() {
  const place = "machines";
  const name = names.machine;
  const reopen = () => boxesPage("machines");
  await recordMenu(place, name, "ready");
  await page.keyboard.press("Escape");

  await choose(name, "Copy address");
  effect(place, name, "Copy address", `clipboard ${await clipboard()}`);

  const resizeCalls = await callsDuring(async () => {
    await choose(name, "Resize…");
    await page.getByRole("alertdialog").waitFor();
  }, 2500);
  const dialogTitle = await page.getByRole("alertdialog").getByRole("heading").first().textContent();
  effect(place, name, "Resize…", `dialog "${dialogTitle}", calls ${resizeCalls.filter((call) => call.method.includes("resize")).map((call) => `${call.method} ${call.body}`).join("; ")}`);
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await pause(300);

  await choose(name, "Stop");
  await waitForState(name, "stopped");
  await reopen();
  effect(place, name, "Stop", "stopped");
  await recordMenu(place, name, "stopped");
  await page.keyboard.press("Escape");
  await choose(name, "Start");
  await waitForState(name, "ready");
  effect(place, name, "Start", "ready");
  await reopen();

  await choose(name, "Open terminal");
  await pause(2000);
  effect(place, name, "Open terminal", `url ${page.url().replace(base, "")}`);
  await reopen();

  if (names.machineDesktop) {
    const desktop = names.machineDesktop;
    await recordMenu(place, desktop, "ready");
    await page.keyboard.press("Escape");
    const browserUrl = await popupAfter(() => choose(desktop, "Open in browser"));
    effect(place, desktop, "Open in browser", `new tab ${browserUrl.replace(base, "")}`);
    await choose(desktop, "Open desktop");
    await pause(2000);
    effect(place, desktop, "Open desktop", `url ${page.url().replace(base, "")}`);
    await page.screenshot({ path: join(shots, `${place}-${desktop}-desktop.png`) });
    await reopen();
  }

  const doomed = names.remove;
  if (doomed) {
    await recordMenu(place, doomed, "ready");
    await page.keyboard.press("Escape");
    await choose(doomed, "Remove…");
    const dialog = page.getByRole("alertdialog");
    const words = (await dialog.textContent())?.trim();
    await page.screenshot({ path: join(shots, `${place}-${doomed}-remove-dialog.png`) });
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await waitForState(doomed, "absent");
    effect(place, doomed, "Remove…", `asked "${words}", then removed`);
  }
}

async function settingsMenus() {
  await page.goto(`${base}/settings/plugins/bb-box`, { waitUntil: "domcontentloaded" });
  await page.locator("[data-page-heading]").first().waitFor();
  await pause(1500);
  const menus = await page.getByRole("button", { name: / actions$/ }).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
  results.menus["settings"] = { buttons: menus };
  await page.screenshot({ path: join(shots, "settings.png") });
  effect("settings", "-", "box menus on the page", menus.length ? menus.join(", ") : "none");
}

try {
  await boxPanel();
  await threadBoxItems("panel", boxPanel);
  await boxesPage("threads");
  await threadBoxItems("threads", () => boxesPage("threads"));
  await boxesPage("machines");
  await machineItems();
  await settingsMenus();
} catch (error) {
  await page.screenshot({ path: join(shots, "failure.png") }).catch(() => {});
  results.failure = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  writeFileSync(join(shots, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
