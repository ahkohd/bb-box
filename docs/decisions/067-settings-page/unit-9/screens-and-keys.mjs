import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
mkdirSync(out, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function elsewhere(change) {
  const state = await rpc("config.get");
  const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.state;
}

const withTailnet = (tailnet) => (document) => {
  const { tailnet: _tailnet, iosEncoder: _encoder, encoderLedger: _ledger, testDevice: _test, ...general } = document.general;
  return { ...document, general: tailnet ? { ...general, tailnet } : general };
};

const browser = await chromium.launch();
const shots = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(page, name, full = false) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
}

async function open(page, hash, title) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip setup" });
  await Promise.race([skip.waitFor({ timeout: 4_000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 4_000 }).catch(() => {})]);
  if (await skip.count()) {
    await skip.click();
    await pause(500);
    await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  }
  if (title) await page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title}`) }).waitFor();
  else await page.locator("[data-settings-view]").waitFor();
  await pause(400);
}

const secretInput = (page, label) => page.locator(`input[type=password][aria-label="${label}"], input[type=password][aria-label="New ${label}"]`);

async function setSecret(page, label, text) {
  const input = secretInput(page, label);
  if (!(await input.count())) await page.getByRole("button", { name: new RegExp(`^(Set|Replace) the ${label}$`) }).click();
  await input.fill(text);
}

async function animations(page) {
  await pause(400);
  return page.evaluate(() => {
    const running = document.getAnimations().map((animation) => `${animation.animationName ?? animation.transitionProperty ?? "animation"} on ${animation.effect?.target?.getAttribute?.("class")?.slice(0, 50) ?? "?"}`);
    return running.length ? `${running.length}: ${running.join("; ")}` : "none";
  });
}

async function focusSummary(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { name: "(body)", ring: false };
    const style = getComputedStyle(element);
    const ring = (style.boxShadow && style.boxShadow !== "none") || (style.outlineStyle !== "none" && style.outlineWidth !== "0px");
    const label = element.getAttribute("aria-label") || element.getAttribute("data-draft-path") || element.textContent?.trim().slice(0, 60) || element.tagName;
    const type = element.getAttribute("type");
    return { name: `${element.getAttribute("role") ?? (type ? `${element.tagName.toLowerCase()}[${type}]` : element.tagName.toLowerCase())}: ${label}`, ring };
  });
}

const tabs = async (page, count) => {
  const stops = [];
  for (let stop = 0; stop < count; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  return stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ");
};

async function screens() {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      await elsewhere(withTailnet(null));
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      const tag = `${width}-${scheme}`;
      await open(page, "#option/devices", "Devices");
      await shot(page, `devices-${tag}`);
      if (width === 390) {
        await page.getByRole("switch", { name: "Test device" }).scrollIntoViewIfNeeded();
        await shot(page, `devices-end-${tag}`);
      }
      await open(page, "#option/network", "Network");
      await shot(page, `network-off-${tag}`);
      await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).check();
      await page.getByRole("textbox", { name: "Tags" }).fill("tag:bb-box, tag:ci-check");
      await setSecret(page, "OAuth client ID", "made-up-id-screens");
      await shot(page, `network-draft-${tag}`);
      await page.getByRole("region", { name: "Save the tailnet" }).getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText(/^Not saved: fix the field marked/).waitFor();
      await shot(page, `network-refused-${tag}`);
      await page.getByRole("button", { name: "BB Box settings" }).click();
      await page.locator('[data-row-key="option-network"]').waitFor();
      await page.locator('[data-row-key="option-network"]').scrollIntoViewIfNeeded();
      await shot(page, `overview-unsaved-${tag}`);
      await page.goBack();
      await page.getByRole("region", { name: "Save the tailnet" }).getByRole("button", { name: "Discard" }).click();

      await elsewhere(withTailnet({ mode: "oauth", clientId: "made-up-id-screens", clientSecret: "made-up-secret-screens" }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator("[data-page-heading]").filter({ hasText: /^Network/ }).waitFor();
      await setSecret(page, "OAuth client secret", "made-up-mine");
      await elsewhere((document) => ({ ...document, general: { ...document.general, tailnet: { ...document.general.tailnet, clientId: { set: true }, clientSecret: "made-up-theirs" } } }));
      await page.getByText(/^Replaced elsewhere while you edited/).waitFor();
      await page.getByRole("button", { name: "Keep mine" }).evaluate((button) => button.scrollIntoView({ block: "center" }));
      await shot(page, `network-secret-conflict-${tag}`);
      await page.getByRole("button", { name: "Keep the saved one" }).click();
      await page.getByRole("radio", { name: "No: BB is reached without one" }).check();
      await shot(page, `network-no-deletes-${tag}`);
      await context.close();
    }
  }
}

async function keys() {
  await elsewhere(withTailnet(null));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const applies = [];
  await page.route(APPLY, async (route) => {
    applies.push(JSON.parse(route.request().postData() ?? "null"));
    await route.continue();
  });
  const log = [];
  const note = log.push.bind(log);
  log.push = (line) => {
    console.log(line);
    return note(line);
  };
  await open(page, "", null);
  let found = false;
  for (let stop = 0; stop < 80 && !found; stop += 1) {
    await page.keyboard.press("Tab");
    found = (await page.evaluate(() => document.activeElement?.getAttribute("data-row-key"))) === "option-devices";
  }
  log.push(`Tab reached the Devices row: ${found}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"));
  log.push(`Enter opened Devices with focus on: ${(await focusSummary(page)).name}`);
  log.push(`Tab from the heading: ${await tabs(page, 6)}`);
  await page.getByRole("combobox", { name: "iOS video encoding" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("listbox").waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  log.push(`Enter on iOS video encoding opened its menu with focus on: ${(await focusSummary(page)).name}`);
  await pause(300);
  await page.keyboard.press("ArrowDown");
  await pause(300);
  await page.keyboard.press("Enter");
  for (let tries = 0; tries < 50 && (await rpc("config.get")).document.general.iosEncoder !== "hardware"; tries += 1) await pause(100);
  await pause(300);
  log.push(`Enter, ArrowDown, Enter on iOS video encoding stored: ${(await rpc("config.get")).document.general.iosEncoder}; focus on ${(await focusSummary(page)).name}`);
  await page.getByRole("switch", { name: "Test device" }).focus();
  await page.keyboard.press("Space");
  for (let tries = 0; tries < 50 && (await rpc("config.get")).document.general.testDevice !== true; tries += 1) await pause(100);
  log.push(`Space on Test device stored: ${(await rpc("config.get")).document.general.testDevice}`);
  await page.getByRole("button", { name: "Spare iOS Simulator boxes" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"));
  log.push(`Enter on Spare iOS Simulator boxes opened ${new URL(page.url()).hash}, focus on ${(await focusSummary(page)).name}`);
  await page.goBack();
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-row-key") === "devices-ios", null, { timeout: 10_000 }).catch(() => {});
  log.push(`Back: focus on ${await page.evaluate(() => document.activeElement?.getAttribute("data-row-key") ?? document.activeElement?.tagName)}`);

  await open(page, "#option/network", "Network");
  await page.locator("[data-page-heading]").focus();
  log.push(`Network, Tab from the heading: ${await tabs(page, 1)}`);
  await page.keyboard.press("ArrowDown");
  log.push(`ArrowDown chose: ${(await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).isChecked()) ? "Yes" : "No"}`);
  log.push(`Tab on: ${await tabs(page, 3)}`);
  await page.getByRole("textbox", { name: "Tags" }).focus();
  await page.keyboard.type("tag:bb-box");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await pause(100);
  log.push(`Enter on Set the OAuth client ID put focus on: ${(await focusSummary(page)).name}`);
  await page.keyboard.type("made-up-id-keys");
  const before = applies.length;
  await page.keyboard.press("Enter");
  await page.getByText(/^Not saved: fix the field marked/).waitFor();
  log.push(`Enter saved (${applies.length - before} request), refused part way; focus on: ${(await focusSummary(page)).name}`);
  await page.keyboard.press("Enter");
  await pause(100);
  await page.keyboard.type("made-up-secret-keys");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Save the tailnet" }).getByText(/^Saved\./).waitFor();
  const stored = (await rpc("config.get")).document.general.tailnet;
  log.push(`Enter in the secret saved: ${JSON.stringify({ mode: stored.mode, tags: stored.tags, clientId: stored.clientId?.set, clientSecret: stored.clientSecret?.set })}; focus on ${(await focusSummary(page)).name}`);
  log.push(`Animations running: ${await animations(page)}`);
  await context.close();
  return log;
}

const log = await keys();
await screens();
writeFileSync(join(out, "keys.txt"), log.join("\n"));
console.log(`${shots.length} screenshots`);
await browser.close();
