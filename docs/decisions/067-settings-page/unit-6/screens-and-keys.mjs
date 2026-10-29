import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
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

async function reset({ dockerWarm = false } = {}) {
  await otherTab((document) => ({
    ...document,
    kinds: {},
    general: {},
    backends: [
      { id: "docker", type: "docker", enabled: true, fields: {}, ...(dockerWarm ? { warm: { linux: 2 } } : {}) },
      { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { url: "https://127.0.0.1:9", "token-id": "bb-box@pve!made-up", "token-secret": "made-up-screens" }, warm: { linux: 1 } },
      { id: "tart", type: "tart", enabled: false, fields: {} },
      { id: "ssh-pool", type: "ssh-pool", enabled: false, fields: {} },
      { id: "namespace", type: "namespace", enabled: false, fields: {} },
    ],
  }));
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

async function scrollTo(page, locator) {
  await locator.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await pause(200);
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
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${label}`, ring };
  });
}

async function screens() {
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      await reset({ dockerWarm: true });
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
      const page = await context.newPage();
      const tag = `${width}-${scheme}`;
      await open(page, "#kind/linux", "Linux");
      await shot(page, `kind-${tag}`);
      await scrollTo(page, page.getByRole("region", { name: "Where it runs" }));
      await shot(page, `kind-where-${tag}`);
      await open(page, "#kind/ios", "iOS Simulator");
      await scrollTo(page, page.getByRole("region", { name: "Where it runs" }));
      await shot(page, `ios-where-${tag}`);
      await open(page, "", null);
      await page.getByRole("switch", { name: "Linux desktop (CPU): offered to threads" }).click();
      await pause(800);
      await scrollTo(page, page.getByRole("region", { name: "Kinds" }));
      await shot(page, `overview-kept-${tag}`);
      await context.close();
    }
  }
  for (const [width, scheme] of [[390, "dark"], [760, "light"], [1440, "light"]]) {
    await reset();
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    await open(page, "#kind/linux", "Linux");
    await field(page, "Small size: cores").fill("0");
    await field(page, "Medium size: cores").fill("40");
    await field(page, "Medium size: cores").press("Enter");
    await page.getByText(/^Not saved: fix the/).waitFor();
    await page.getByRole("region", { name: "Save Linux" }).getByRole("button", { name: "Show" }).click();
    await pause(300);
    await shot(page, `refused-${width}-${scheme}`);
    await context.close();
  }
  await reset();
  const one = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await one.newPage();
  await open(page, "#kind/linux", "Linux");
  await field(page, "Warm boxes on Proxmox LXC").fill("4");
  await otherTab((document) => ({ ...document, backends: document.backends.map((backend) => (backend.id === "proxmox-lxc" ? { ...backend, warm: { linux: 5 } } : backend)) }));
  await page.getByText("Changed elsewhere to", { exact: false }).first().waitFor();
  await scrollTo(page, page.getByRole("region", { name: "Where it runs" }));
  await shot(page, "warm-conflict-1440-dark");
  await one.close();
}

async function keys() {
  await reset();
  const steps = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  await open(page, "", null);
  await page.locator("[data-page-heading]").first().focus();
  let found = false;
  for (let tab = 0; tab < 60 && !found; tab += 1) {
    await page.keyboard.press("Tab");
    found = (await focusSummary(page)).name === "button: Linux desktop (CPU)";
  }
  steps.push(["Tab from the top to the Linux desktop (CPU) row", await focusSummary(page)]);
  await page.keyboard.press("Enter");
  await page.locator("[data-page-heading]").filter({ hasText: /^Linux desktop \(CPU\)/ }).waitFor();
  await pause(300);
  steps.push(["Enter opens its page", await focusSummary(page)]);
  const order = [];
  for (let tab = 0; tab < 26; tab += 1) {
    await page.keyboard.press("Tab");
    const focus = await focusSummary(page);
    order.push(`${focus.name}${focus.ring ? "" : " (no ring)"}`);
  }
  steps.push(["Tab order on the page", order]);
  await field(page, "Spares to keep").focus();
  await page.keyboard.type("1");
  await page.keyboard.press("Enter");
  await page.getByText(/^Saved\./).waitFor();
  steps.push(["Typing 1 in Spares to keep and Enter", { saved: (await rpc("config.get")).document.kinds["linux-desktop-cpu"], focus: await focusSummary(page) }]);
  await page.getByRole("radio", { name: "Small is the default size" }).focus();
  await page.keyboard.press("ArrowDown");
  steps.push(["Arrow down in the default size", { focus: await focusSummary(page), checked: await page.getByRole("radio", { name: "Medium is the default size" }).isChecked() }]);
  await page.keyboard.press("Enter");
  await page.getByText(/^Saved\./).waitFor();
  steps.push(["Enter saves the default size", { default: (await rpc("config.get")).document.kinds["linux-desktop-cpu"]?.default }]);
  await page.getByRole("button", { name: "Make default" }).focus();
  await page.keyboard.press("Enter");
  await pause(800);
  steps.push(["Enter on Make default", { focus: await focusSummary(page), defaultKind: (await rpc("config.get")).document.general.defaultKind }]);
  await page.keyboard.press("Space");
  await pause(500);
  steps.push(["Space on the default kind's switch", { on: await page.getByRole("switch", { name: "Linux desktop (CPU): offered to threads" }).getAttribute("aria-checked") }]);
  await page.getByRole("button", { name: "Choose another default" }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL((url) => url.hash === "#option/boxes");
  await pause(500);
  steps.push(["Enter on Choose another default", await focusSummary(page)]);
  steps.push(["Animations running", await animations(page)]);
  await context.close();
  return steps;
}

const steps = await keys();
await screens();
writeFileSync(join(out, "keys.json"), JSON.stringify(steps, null, 1));
console.log(JSON.stringify(steps, null, 1));
console.log(`${shots.length} screenshots`);
await browser.close();
