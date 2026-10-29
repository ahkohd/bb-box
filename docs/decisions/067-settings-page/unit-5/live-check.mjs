import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const machine = process.env.LIVE_MACHINE ?? "lab";
const phase = process.argv[2];
const backendId = `docker:${machine}`;
const label = `Docker on ${machine}`;
mkdirSync(out, { recursive: true });

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const seen = { phase, at: new Date().toISOString(), steps: [] };

function note(step, detail) {
  seen.steps.push({ step, ...detail });
  console.log(`${step}: ${JSON.stringify(detail)}`);
}

async function shot(name) {
  await page.screenshot({ path: join(out, `live-${phase}-${name}.png`), fullPage: true });
}

async function open(hash) {
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

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const groupOf = (title) => page.getByRole("heading", { name: title, exact: true }).locator("xpath=ancestor::section[1]");
const backendsGroup = () => groupOf("Backends").first();
const rowOf = () => backendsGroup().getByRole("button", { name: label, exact: true }).locator("xpath=..");
const machineCard = () => groupOf("BB machine");
const offers = () => groupOf("Docker on your BB machines");

async function waitFor(what, read, test, seconds) {
  const until = Date.now() + seconds * 1000;
  let last = "";
  while (Date.now() < until) {
    last = await read().catch((error) => `(${error.message.split("\n")[0]})`);
    if (test(last)) return last;
    await pause(1_000);
  }
  throw new Error(`${what}: still "${last}" after ${seconds} s`);
}

async function checkAll() {
  await open("");
  await page.getByRole("button", { name: "Check all" }).click();
  await waitFor("Check all", () => text(page.getByRole("button", { name: /^(Check all|Checking…)$/ })), (value) => value === "Check all", 90);
}

async function overview(expect, seconds = 30) {
  await open("");
  const row = await waitFor("the overview row", () => text(rowOf()), (value) => expect.test(value), seconds);
  const callout = page.getByRole("region", { name: "Things that need you" });
  const status = await text(page.getByRole("status").first());
  note("overview", { row, status, callout: (await callout.count()) ? await text(callout) : null });
  await shot("overview");
}

async function backendPage(expect, seconds = 30) {
  await open(`#backend/${encodeURIComponent(backendId)}`);
  const card = await waitFor("the BB machine card", () => text(machineCard()), (value) => expect.test(value), seconds);
  const health = await text(groupOf("Health"));
  note("page", { card, health });
  await shot("page");
}

async function stored() {
  const state = await rpc("config.get");
  const backend = state.document.backends.find((each) => each.id === backendId) ?? null;
  note("stored", { backend: backend ? { id: backend.id, enabled: backend.enabled, host: backend.fields.host } : null, revision: state.revision });
  return backend;
}

try {
  if (phase === "add") {
    await open("#add");
    const before = await text(offers());
    note("add backend", { offers: before });
    await shot("offers");
    await offers().getByRole("button", { name: `Add Docker on ${machine}` }).click();
    const row = await waitFor("the added row", () => text(offers().getByRole("button", { name: new RegExp(`^${machine}`) })), (value) => /Added: open it/.test(value), 60);
    await pause(1_000);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-row-key") ?? document.activeElement?.tagName ?? null);
    note("added", { row, focused });
    await shot("added");
    const backend = await stored();
    if (!backend?.enabled) throw new Error("the backend was not stored on");
    await overview(/BB machine/);
    await backendPage(/Hosts boxes|Building/);
  } else if (phase === "built") {
    await overview(/Not checked|Ready|Last check passed/, 1_800);
    await checkAll();
    await overview(/Ready/, 90);
    await backendPage(/Hosts boxes/);
  } else if (phase === "broken") {
    await checkAll();
    await overview(/Cannot host boxes/, 90);
    await backendPage(/Cannot host boxes/);
  } else if (phase === "fixed") {
    await open(`#backend/${encodeURIComponent(backendId)}`);
    await machineCard().getByRole("button", { name: `Check Docker on ${machine} again` }).click();
    const health = await waitFor("the health card", () => text(groupOf("Health")), (value) => /^Health Ready/.test(value), 60);
    note("after one Check again", { health });
    await backendPage(/Hosts boxes/, 60);
    await overview(/Ready/, 30);
  } else if (phase === "off") {
    await open("");
    await rowOf().getByRole("switch", { name: `${label}: takes new boxes` }).click();
    await waitFor("the switch", async () => String(await rowOf().getByRole("switch").getAttribute("aria-checked")), (value) => value === "false", 30);
    await overview(/Off/);
    await backendPage(/Off: takes no new boxes/);
    const backend = await stored();
    if (!backend || backend.enabled) throw new Error("turned off should keep the backend, off");
  } else if (phase === "on") {
    await open(`#backend/${encodeURIComponent(backendId)}`);
    await page.getByRole("switch", { name: `${label}: takes new boxes` }).click();
    await waitFor("the switch", async () => String(await page.getByRole("switch", { name: `${label}: takes new boxes` }).getAttribute("aria-checked")), (value) => value === "true", 60);
    await backendPage(/Hosts boxes/);
    const backend = await stored();
    if (!backend?.enabled) throw new Error("turned on should store it on");
  } else {
    throw new Error(`no phase ${phase}: add, built, broken, fixed, off or on`);
  }
  seen.ok = true;
} catch (error) {
  seen.ok = false;
  seen.error = error.message;
  await shot("failed").catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, `live-${phase}.json`), JSON.stringify(seen, null, 2));
  await browser.close();
}
