import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const run = process.env.LIVE_RUN ?? "1";
const machine = process.env.LIVE_MACHINE ?? "bb-1";
const phase = process.argv[2];
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
const seen = { phase, run, at: new Date().toISOString(), steps: [] };

function note(step, detail = {}) {
  seen.steps.push({ step, ...detail });
  console.log(`${step}: ${JSON.stringify(detail)}`);
}

function check(that, what) {
  if (!that) throw new Error(what);
}

async function shot(name) {
  await page.screenshot({ path: join(out, `run${run}-${phase}-${name}.png`), fullPage: true });
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
  await pause(800);
}

const text = async (locator) => (await locator.innerText()).replace(/\s+/g, " ").trim();
const view = () => page.locator("[data-settings-view]");
const firstRun = () => page.locator("section[aria-labelledby='settings-first-run']");

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

async function stored() {
  const state = await rpc("config.get");
  return {
    revision: state.revision,
    setupDone: state.setupDone,
    backends: state.document.backends.map((backend) => ({
      id: backend.id,
      enabled: backend.enabled,
      secrets: Object.fromEntries(Object.entries(backend.fields).filter(([, value]) => value && typeof value === "object" && "set" in value)),
    })),
    receipts: state.receipts.length,
  };
}

async function noFirstRunKinds() {
  check((await page.getByRole("heading", { name: "Kinds", exact: true }).count()) === 0, "Kinds shows in first run");
  check((await page.getByRole("button", { name: /^Sizes and options: kinds, images/ }).count()) === 1, "no Sizes and options for later");
}

async function sessionText() {
  return page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }));
}

async function setSecret(label, value) {
  await page.getByRole("button", { name: `Set the ${label}` }).click();
  await page.getByLabel(label, { exact: true }).fill(value);
}

try {
  if (phase === "missing") {
    await open("");
    const card = await waitFor("the first-run card", () => text(firstRun()), (value) => value.includes(`${machine} has no Docker`), 60);
    check(card.includes("curl -fsSL https://get.docker.com | sudo sh"), "no install line");
    check(card.includes("Choose another backend"), "no Choose another backend");
    await noFirstRunKinds();
    note("missing", { card });
    await shot("card");
  } else if (phase === "missing-fixed") {
    await open("");
    await page.getByRole("button", { name: `Check ${machine} for Docker again` }).click();
    const card = await waitFor("the card after Check again", () => text(firstRun()), (value) => value.includes("Use Docker on this machine"), 60);
    note("after Check again", { card });
    await shot("card");
  } else if (phase === "access") {
    await open("");
    const card = await waitFor("the first-run card", () => text(firstRun()), (value) => value.includes(`BB cannot use Docker on ${machine}`), 60);
    check(/sudo usermod -aG docker box/.test(card), "no usermod line");
    check((await page.getByRole("button", { name: `Check Docker on ${machine} again` }).count()) === 1, "no Check again");
    await noFirstRunKinds();
    note("no access", { card });
    await shot("card");
  } else if (phase === "disk") {
    await open("");
    const card = await waitFor("the first-run card", () => text(firstRun()), (value) => value.includes(`Not enough disk on ${machine}`), 60);
    note("low disk", { card });
    await shot("card");
  } else if (phase === "disk-fixed") {
    await open("");
    await page.getByRole("button", { name: `Check Docker on ${machine} again` }).click();
    const card = await waitFor("the card after Check again", () => text(firstRun()), (value) => value.includes("Use Docker on this machine"), 60);
    note("after Check again", { card });
  } else if (phase === "saved-off") {
    await open("");
    await page.getByRole("button", { name: /^Choose another backend/ }).click();
    await page.getByRole("heading", { name: "Add a backend" }).waitFor();
    note("add backend", { groups: await page.locator("h3").allInnerTexts() });
    await shot("add");
    await page.getByRole("button", { name: /^Proxmox LXC/ }).click();
    await page.getByRole("heading", { name: "Set up Proxmox LXC" }).waitFor();
    const steps = await page.getByRole("region", { name: /^Step \d/ }).evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    check(steps.length === 4, `steps: ${steps}`);
    const url = page.getByRole("textbox", { name: "API URL" });
    await url.fill("https://192.0.2.10:8006/api2/json");
    await url.press("Enter");
    await pause(1_500);
    const afterEnter = await stored();
    check(afterEnter.backends.length === 0, "Enter saved the setup");
    await shot("form");
    await page.getByRole("button", { name: "Save, keep it off" }).click();
    await page.waitForURL(/#backend\/proxmox-lxc$/, { timeout: 30_000 });
    const health = await waitFor("its health", () => text(page.getByRole("status").filter({ hasText: "Not finished" }).first()), (value) => value.includes("Not finished"), 30);
    const after = await stored();
    check(after.backends.some((backend) => backend.id === "proxmox-lxc" && !backend.enabled), "not stored off");
    note("saved off", { steps, health, stored: after });
    await shot("page");
    await page.goBack();
    await pause(1_000);
    note("back", { hash: new URL(page.url()).hash });
    check(new URL(page.url()).hash === "#add", "back did not return to Add backend");
    await open("");
    const card = await waitFor("first run", () => text(firstRun()), (value) => value.includes("Finish setting up Proxmox LXC"), 30);
    await noFirstRunKinds();
    note("first run resumes", { card });
    await shot("overview");
  } else if (phase === "use-docker") {
    await open("");
    await page.getByRole("button", { name: `Use Docker on ${machine}` }).click();
    const building = await waitFor("the build", () => text(view()), (value) => /Setting up Docker on this machine/.test(value), 60);
    const state = await stored();
    note("building", { overview: building.slice(0, 700), firstRunShown: (await firstRun().count()) > 0, setupDone: state.setupDone });
    await shot("building");
    const ready = await waitFor("Docker ready", async () => {
      await open("");
      return text(view());
    }, (value) => value.includes("Docker on this machine is ready"), 1_800);
    note("built", { overview: ready.slice(0, 600) });
    await shot("built");
    check((await stored()).setupDone !== null, "setup done not recorded");
    await page.getByRole("button", { name: "Check all" }).click();
    const status = await waitFor("Status", () => text(page.locator("section[aria-label='Status']")), (value) => /^Docker on this machine is ready/.test(value) || /^Docker on this machine is not working/.test(value), 120);
    const callout = page.getByRole("region", { name: "Things that need you" });
    const things = (await callout.count()) ? await text(callout) : "";
    check(!/desktop|Not offered/i.test(things), `a warning about desktops: ${things}`);
    const kinds = await text(page.locator("section").filter({ has: page.getByRole("heading", { name: "Kinds", exact: true }) }).first());
    check(!/Not offered/.test(kinds), `Kinds warns: ${kinds}`);
    note("linux only", { status, things, kinds });
    await shot("ready");
  } else if (phase === "resume") {
    await open("");
    await page.getByRole("button", { name: "Open Proxmox LXC is not finished" }).click();
    await page.waitForURL(/#backend\/proxmox-lxc$/);
    await page.getByRole("textbox", { name: "API token ID" }).fill("bbbox@pve!plugin");
    await setSecret("API token secret", "00000000-made-up-0000-0000-000000000000");
    await page.getByRole("region", { name: /^Save Proxmox LXC/ }).getByRole("button", { name: "Save" }).click();
    const bar = await waitFor("the save", () => text(page.getByRole("region", { name: /^Save Proxmox LXC/ })), (value) => /Saved|Not saved/.test(value), 30);
    note("resumed", { bar });
    await shot("saved");
    const toggle = page.getByRole("switch", { name: "Proxmox LXC: takes new boxes" });
    await toggle.click();
    await waitFor("the switch", async () => String(await toggle.getAttribute("aria-checked")), (value) => value === "true", 60);
    await pause(2_000);
    const state = await stored();
    check(state.backends.find((backend) => backend.id === "proxmox-lxc")?.enabled === true, "not stored on");
    check(!(await sessionText()).includes("made-up"), "the secret is in browser storage");
    note("turned on", { stored: state, note: await text(page.locator("header, [data-page-heading]").first()).catch(() => null) });
    await shot("on");
  } else if (phase === "save-on") {
    await open("#add");
    await page.getByRole("button", { name: /^Hetzner Cloud/ }).click();
    await page.getByRole("heading", { name: "Set up Hetzner Cloud" }).waitFor();
    await setSecret("API token", "madeup0token0for0a0live0check0only0000000000000000000000000000ab");
    await shot("form");
    await page.getByRole("button", { name: "Save and turn on" }).click();
    const landed = await page.waitForURL(/#backend\/hetzner$/, { timeout: 30_000 }).then(() => true, () => false);
    if (!landed) {
      note("refused", { bar: await text(page.getByRole("region", { name: /^Save Hetzner/ })) });
      throw new Error("Save and turn on did not land on the backend's page");
    }
    await pause(1_500);
    const state = await stored();
    const hetzner = state.backends.find((backend) => backend.id === "hetzner");
    check(hetzner?.enabled === true, "not stored on");
    check(hetzner?.secrets.token?.set === true && typeof hetzner.secrets.token.version === "number", "the token is not set with its version");
    check(!(await sessionText()).includes("madeup0token"), "the token is in browser storage");
    check(!(await page.content()).includes("madeup0token"), "the token is in the page");
    note("saved on in one go", { hetzner, receipts: state.receipts, bar: await text(page.getByRole("region", { name: /^Save Hetzner/ })).catch(() => null) });
    await shot("page");
  } else if (phase === "all-off") {
    await open("");
    for (const backend of (await stored()).backends.filter((each) => each.enabled)) {
      const toggle = page.getByRole("switch", { name: /: takes new boxes$/ }).and(page.locator(`[aria-checked="true"]`)).first();
      await toggle.click();
      await waitFor(`${backend.id} off`, async () => String((await stored()).backends.find((each) => each.id === backend.id)?.enabled), (value) => value === "false", 60).catch(() => null);
      await pause(1_500);
    }
    const state = await stored();
    check(state.backends.every((backend) => !backend.enabled), `still on: ${JSON.stringify(state.backends)}`);
    for (const reload of [false, true]) {
      if (reload) await open("");
      const status = await waitFor("Status", () => text(page.locator("section[aria-label='Status']")), (value) => value.includes("Every backend is off"), 30);
      check((await page.locator("section[aria-labelledby='settings-first-run']").count()) === 0, "first run came back");
      check((await page.getByRole("heading", { name: "Kinds", exact: true }).count()) === 1, "Kinds is hidden");
      note(reload ? "after a reload" : "all off", { status, setupDone: state.setupDone });
    }
    await shot("overview");
  } else {
    throw new Error(`no phase ${phase}`);
  }
  seen.ok = true;
} catch (error) {
  seen.ok = false;
  seen.error = error.message;
  await shot("failed").catch(() => {});
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeFileSync(join(out, `run${run}-${phase}.json`), JSON.stringify(seen, null, 2));
  await browser.close();
}
