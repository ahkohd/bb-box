import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const side = process.env.LIVE_SIDE ?? "linux";
mkdirSync(out, { recursive: true });

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function otherTab(change) {
  const state = await rpc("config.get");
  const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.state;
}

async function resetLinux() {
  await otherTab((document) => {
    const { monitor: _monitor, ...rest } = document;
    return {
      ...rest,
      backends: [
        { id: "docker", type: "docker", enabled: true, fields: {} },
        { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { url: "https://127.0.0.1:9", "token-id": "bb-box@pve!made-up", "token-secret": "made-up-screens" } },
      ],
    };
  });
}

async function resetMac() {
  await otherTab((document) => {
    const tart = document.backends.find((backend) => backend.id === "tart");
    const mac = tart.hosts.find((host) => host.name === "mac-1");
    const { monitor: _monitor, ...rest } = document;
    return { ...rest, backends: [{ id: "tart", type: "tart", enabled: true, fields: {}, hosts: [{ name: "mac-1", enabled: true, fields: { address: mac.fields.address, user: mac.fields.user, "host-keys": mac.fields["host-keys"] } }] }] };
  });
}

const browser = await chromium.launch();
const shots = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shot(page, name) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
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

const field = (page, name) => page.getByRole("textbox", { name, exact: true });

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
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${label}`, ring };
  });
}

async function linuxScreens() {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      await resetLinux();
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      const tag = `${width}-${scheme}`;
      await open(page, "#backend/docker", "Docker");
      await shot(page, `docker-${tag}`);
      await page.getByRole("button", { name: /^Show Advanced/ }).click();
      await field(page, "Most boxes").fill("lots");
      await field(page, "Host").fill("tcp://192.0.2.1:2375");
      await page.getByRole("checkbox", { name: "Offer Wayland desktop image" }).uncheck();
      await field(page, "Most boxes").press("Enter");
      await page.getByText(/^Not saved: fix the 2 fields marked/).waitFor();
      await page.locator('[data-setting-row="backends/docker/fields/host"]').scrollIntoViewIfNeeded();
      await shot(page, `docker-refused-${tag}`);
      await page.getByRole("button", { name: "BB Box settings" }).click();
      await page.locator('[data-row-key="backend-docker"]').waitFor();
      await shot(page, `overview-unsaved-${tag}`);
      await page.goBack();
      await page.getByRole("button", { name: "Discard" }).click();
      await page.getByRole("button", { name: "More for Docker" }).click();
      await page.getByRole("menuitem", { name: "Remove backend…" }).waitFor();
      await shot(page, `docker-menu-${tag}`);
      await page.getByRole("menuitem", { name: "Remove backend…" }).click();
      await page.getByRole("alertdialog").waitFor();
      await shot(page, `remove-dialog-${tag}`);
      await page.getByRole("button", { name: "Cancel" }).click();

      await open(page, "#backend/proxmox-lxc", "Proxmox LXC");
      await page.getByRole("button", { name: "Replace the API token secret" }).click();
      await page.getByLabel("New API token secret", { exact: true }).fill("made-up-mine");
      await otherTab((document) => ({ ...document, backends: document.backends.map((backend) => (backend.id === "proxmox-lxc" ? { ...backend, fields: { ...backend.fields, "token-secret": "made-up-theirs" } } : backend)) }));
      await page.getByText(/^Replaced elsewhere while you edited/).waitFor();
      await page.getByText(/^Replaced elsewhere while you edited/).scrollIntoViewIfNeeded();
      await shot(page, `proxmox-secret-conflict-${tag}`);
      await page.getByRole("button", { name: "Keep the saved one" }).click();
      await context.close();
    }
  }
}

async function macScreens() {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      await resetMac();
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      const tag = `${width}-${scheme}`;
      await open(page, "#backend/tart", "Tart");
      await shot(page, `tart-${tag}`);
      await page.getByRole("button", { name: /^mac-1/ }).first().click();
      await page.locator('[data-setting-row="backends/tart/hosts/mac-1/fields/ios-hosts-cores"]').scrollIntoViewIfNeeded();
      await shot(page, `tart-mac-sizes-${tag}`);
      await page.getByRole("button", { name: "Add Mac" }).click();
      await field(page, "Name of the new Mac").fill("review-mac");
      await field(page, "Name of the new Mac").scrollIntoViewIfNeeded();
      await shot(page, `tart-new-mac-${tag}`);
      await page.getByRole("button", { name: "Check with my changes" }).click();
      await page.getByText(/against your unsaved changes/).waitFor({ timeout: 60_000 });
      await page.locator("[data-page-heading]").scrollIntoViewIfNeeded();
      await shot(page, `tart-checked-draft-${tag}`);
      await page.getByRole("button", { name: "Discard" }).click();
      await context.close();
    }
  }
}

async function linuxKeys() {
  await resetLinux();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const log = [];
  await open(page, "", null);
  await page.locator("[data-page-heading]").first().focus();
  let found = false;
  for (let stops = 0; stops < 30 && !found; stops += 1) {
    await page.keyboard.press("Tab");
    found = (await page.evaluate(() => document.activeElement?.getAttribute("data-row-key"))) === "backend-docker";
  }
  log.push(`Tab reached the Docker row: ${found}`);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"));
  log.push(`Enter opened its page with focus on: ${(await focusSummary(page)).name}`);
  const stops = [];
  for (let stop = 0; stop < 18; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  log.push(`Tab from the heading: ${stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ")}`);
  await page.getByRole("button", { name: /^Show Advanced/ }).focus();
  await page.keyboard.press("Enter");
  await field(page, "Most boxes").focus();
  await page.keyboard.type("13");
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: "Save Docker" }).getByText(/^Saved\./).waitFor();
  log.push(`Enter in Most boxes saved; focus then on: ${(await focusSummary(page)).name}`);
  await page.getByRole("button", { name: "More for Docker" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menu").waitFor();
  log.push(`Enter on the menu button opened it with focus on: ${(await focusSummary(page)).name}`);
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor();
  await page.keyboard.type("Docker test");
  await page.keyboard.press("Enter");
  await page.waitForFunction(async () => true);
  for (let tries = 0; tries < 50; tries += 1) {
    const label = (await rpc("config.get")).document.backends.find((backend) => backend.id === "docker")?.label;
    if (label === "Docker test") break;
    await pause(100);
  }
  log.push(`Rename by keys alone stored: ${(await rpc("config.get")).document.backends.find((backend) => backend.id === "docker")?.label}`);
  log.push(`Focus after the dialog: ${(await focusSummary(page)).name}`);
  log.push(`Animations running: ${await animations(page)}`);
  await page.getByRole("link", { name: "General", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/plugins/bb-box"));
  const bbBack = page.getByRole("button", { name: /^(Back|Go back)$/ }).first();
  const usedBbBack = (await bbBack.count()) > 0;
  if (usedBbBack) await bbBack.click();
  else await page.goBack();
  await page.waitForFunction(() => document.activeElement?.hasAttribute("data-page-heading"), null, { timeout: 15_000 });
  log.push(`Back through ${usedBbBack ? "BB's back button" : "the browser's back"} after BB's sidebar: focus on ${(await focusSummary(page)).name}`);
  await context.close();
  return log;
}

async function macKeys() {
  await resetMac();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const log = [];
  await open(page, "#backend/tart", "Tart");
  await page.getByRole("button", { name: "Add Mac" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-draft-path")?.endsWith("/name"));
  log.push(`Enter on Add Mac put focus on: ${(await focusSummary(page)).name}`);
  await page.keyboard.type("kbd-mac");
  const stops = [];
  for (let stop = 0; stop < 6; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  log.push(`Tab through the new Mac: ${stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" | ")}`);
  await page.getByRole("button", { name: /^mac-1/ }).first().focus();
  await page.keyboard.press("Enter");
  log.push(`Enter on mac-1's row: expanded ${await page.getByRole("button", { name: /^mac-1/ }).first().getAttribute("aria-expanded")}`);
  await page.keyboard.press("Tab");
  log.push(`Tab from mac-1's row: ${(await focusSummary(page)).name}`);
  await page.getByRole("button", { name: "Remove mac-1…" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor();
  log.push(`Enter on Remove mac-1… opened the dialog with focus on: ${(await focusSummary(page)).name}`);
  await page.getByRole("button", { name: "Remove when I save" }).focus();
  await page.keyboard.press("Enter");
  await page.getByText("Removed when you save").waitFor();
  await pause(300);
  log.push(`After the dialog, focus on: ${(await focusSummary(page)).name}`);
  await page.keyboard.press("Tab");
  log.push(`Tab from there: ${(await focusSummary(page)).name}`);
  log.push(`Animations running: ${await animations(page)}`);
  await context.close();
  return log;
}

const keys = side === "mac" ? await macKeys() : await linuxKeys();
if (side === "mac") await macScreens();
else await linuxScreens();
writeFileSync(join(out, `keys-${side}.txt`), keys.join("\n"));
console.log(keys.join("\n"));
console.log(`${shots.length} screenshots`);
await browser.close();
