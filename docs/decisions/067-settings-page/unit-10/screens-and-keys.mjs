import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const cli = process.env.LIVE_BB_CLI ?? join(process.env.HOME ?? "", "bbc.sh");
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
const [what] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const browser = await chromium.launch();

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
}

function keepCopy() {
  const db = new DatabaseSync(join(dataDir, "bb.db"));
  try {
    const value = JSON.stringify({ at: Date.now() - 86_400_000 * 21, version: "0.1.9", values: { "boxes-per-thread": 0 }, notes: [] });
    const columns = db.prepare("pragma table_info(plugin_kv)").all().map((column) => column.name);
    const extra = columns.filter((name) => !["plugin_id", "key", "value"].includes(name));
    const names = ["plugin_id", "key", "value", ...extra];
    db.prepare(`insert or replace into plugin_kv (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`).run("bb-box", "config/migrated-from-bb-settings", value, ...extra.map(() => Date.now()));
  } finally {
    db.close();
  }
}

async function seed() {
  await elsewhere((document) => ({
    ...document,
    backends: [{ id: "hetzner", type: "hetzner", enabled: false, fields: { token: "made-up-token-screens" } }],
    kinds: {},
    general: { files: [{ path: ".cfg/tools.json", content: "made-up-content" }] },
    monitor: {},
  }));
  keepCopy();
}

function changedFile() {
  const file = JSON.parse(execFileSync(cli, ["box", "config", "show", "--json"], { encoding: "utf8" }));
  file.monitor = { refreshIntervalSeconds: 15 };
  file.general.boxesPerThread = 2;
  file.backends[0].fields.token = "made-up-token-new";
  file.backends[0].fields.location = "hel1";
  file.general.files.push({ path: ".cfg/new.json", content: "made-up-new-content" });
  file.kinds = { linux: { presets: { medium: { memoryMiB: 12288 } } } };
  return JSON.stringify(file, null, 2);
}

async function open(page, hash = "#option/configuration") {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip setup" });
  await Promise.race([skip.waitFor({ timeout: 4_000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 4_000 }).catch(() => {})]);
  if (await skip.count()) {
    await skip.click();
    await pause(500);
    await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  }
  await page.locator("[data-page-heading]").filter({ hasText: /^Configuration/ }).waitFor();
  await pause(600);
}

async function whole(page, width, path) {
  const height = await page.evaluate(() => {
    const view = document.querySelector("[data-settings-view]");
    let scroller = view?.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement;
    return Math.ceil((scroller?.scrollHeight ?? document.body.scrollHeight) + 80);
  });
  const before = page.viewportSize();
  await page.setViewportSize({ width, height: Math.min(Math.max(height, before.height), 5000) });
  await pause(300);
  await page.screenshot({ path });
  await page.setViewportSize(before);
}

async function startImport(page, text) {
  await page.getByRole("button", { name: "Import…" }).click();
  const box = page.getByRole("textbox", { name: "Import a configuration" });
  await box.fill(text);
  return box;
}

const SCENES = {
  async page() {},
  async invalid(page) {
    await startImport(page, '{"monitor": {"refreshIntervalSeconds": 15,, }');
    await page.getByRole("button", { name: "Check" }).click();
    await page.getByText(/^This is not a configuration file/).waitFor();
  },
  async checked(page) {
    await startImport(page, changedFile());
    await page.getByRole("button", { name: "Check" }).click();
    await page.getByRole("region", { name: /^What it changes against revision/ }).waitFor();
  },
  async conflict(page) {
    await SCENES.checked(page);
    await elsewhere((document) => ({ ...document, monitor: { ...document.monitor, refreshIntervalSeconds: 40 } }));
    await page.getByText(/^Changed elsewhere to/).waitFor();
  },
  async restored(page) {
    await SCENES.checked(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("The configuration you pasted was not kept, as it may hold secrets; paste it again.").waitFor();
  },
  async copy(page) {
    await page.getByRole("button", { name: "Remove copy…" }).click();
    await page.getByRole("alertdialog").waitFor();
  },
};

async function screens() {
  await seed();
  for (const scheme of ["light", "dark"]) {
    for (const width of [1440, 760, 390]) {
      for (const [name, scene] of Object.entries(SCENES)) {
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
        const page = await context.newPage();
        await elsewhere((document) => ({ ...document, monitor: {} }));
        await open(page);
        await scene(page);
        await pause(400);
        const path = join(out, `configuration-${name}-${width}-${scheme}.png`);
        if (name === "copy") await page.screenshot({ path });
        else await whole(page, width, path);
        await context.close();
      }
    }
  }
}

async function focusSummary(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return { name: "(body)", ring: false };
    const style = getComputedStyle(element);
    const ring = (style.boxShadow && style.boxShadow !== "none") || (style.outlineStyle !== "none" && style.outlineWidth !== "0px");
    const label = element.getAttribute("aria-label") || (element.id && document.querySelector(`label[for="${element.id}"]`)?.textContent) || element.textContent?.replace(/\s+/g, " ").trim().slice(0, 60) || element.tagName;
    return { name: `${element.getAttribute("role") ?? element.tagName.toLowerCase()}: ${label}`, ring };
  });
}

async function tabTo(page, name, most = 60) {
  for (let stop = 1; stop <= most; stop += 1) {
    await page.keyboard.press("Tab");
    const now = await focusSummary(page);
    if (now.name.endsWith(`: ${name}`)) return { stop, ring: now.ring };
  }
  throw new Error(`Tab never reached ${name}`);
}

async function keys() {
  await seed();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "dark" });
  const page = await context.newPage();
  const log = [];
  const say = (line) => {
    log.push(line);
    console.log(line);
  };
  await open(page);
  await page.locator("[data-page-heading]").first().focus();
  const stops = [];
  for (let stop = 0; stop < 5; stop += 1) {
    await page.keyboard.press("Tab");
    stops.push(await focusSummary(page));
  }
  say(`From the page's heading, Tab went: ${stops.map((stop) => `${stop.name}${stop.ring ? "" : " (NO RING)"}`).join(" → ")}`);
  await page.locator("[data-page-heading]").first().focus();
  await tabTo(page, "Import…");
  await page.keyboard.press("Enter");
  await pause(300);
  say(`Enter on Import…: focus ${(await focusSummary(page)).name}`);
  await page.keyboard.insertText(changedFile());
  const toCheck = await tabTo(page, "Check");
  say(`Pasted a file; Tab reached Check in ${toCheck.stop} stops, ring ${toCheck.ring}`);
  await page.keyboard.press("Enter");
  await page.getByRole("region", { name: /^What it changes against revision/ }).waitFor();
  say(`Enter on Check: the list "${(await page.getByRole("region", { name: /^What it changes/ }).locator("h3").textContent()).trim()}"; focus stayed on ${(await focusSummary(page)).name}`);
  await page.screenshot({ path: join(out, "keys-01-checked.png") });
  const toApply = await tabTo(page, "Apply");
  say(`Tab reached Apply in ${toApply.stop} stops, ring ${toApply.ring}`);
  await page.keyboard.press("Enter");
  await page.getByText(/^Applied/).waitFor();
  await pause(300);
  const after = await focusSummary(page);
  say(`Enter on Apply: "${(await page.locator('[data-draft-path="import/result"]').textContent()).trim()}", focus ${after.name}, ring ${after.ring}`);
  await page.screenshot({ path: join(out, "keys-02-applied.png") });
  await page.locator("[data-page-heading]").first().focus();
  await tabTo(page, "Remove copy…");
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor();
  say(`Enter on Remove copy…: the dialog, focus ${(await focusSummary(page)).name}`);
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "hidden" });
  await pause(200);
  say(`Escape: the dialog closed, focus ${(await focusSummary(page)).name}`);
  await page.keyboard.press("Enter");
  await page.getByRole("alertdialog").waitFor();
  const toRemove = await tabTo(page, "Remove copy", 4);
  await page.keyboard.press("Enter");
  await page.getByText("Removed the copy of BB's earlier settings.").waitFor();
  await pause(300);
  const removed = await focusSummary(page);
  say(`Tab to Remove copy (${toRemove.stop} stop) and Enter: focus ${removed.name}, ring ${removed.ring}`);
  await page.screenshot({ path: join(out, "keys-03-copy-removed.png") });
  say(`Animations running: ${await page.evaluate(() => document.getAnimations().map((animation) => animation.animationName ?? animation.constructor.name).join(", ") || "none")}`);
  writeFileSync(join(out, "keys.txt"), `${log.join("\n")}\n`);
  await context.close();
}

try {
  if (what === "screens") await screens();
  else if (what === "keys") await keys();
  else throw new Error("screens or keys");
} finally {
  await browser.close();
}
