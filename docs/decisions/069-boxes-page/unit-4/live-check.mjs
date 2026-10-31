import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { agentResult, agentStart, bb, boxes, containerOf, docker, expect, home, makeReport, pause, rpc, skipSetup, waitFor } from "./live-lib.mjs";

const label = process.argv[2] ?? "run";
const only = new Set((process.env.LIVE_ONLY ?? "").split(",").filter(Boolean));
const thread = process.env.LIVE_THREAD;
const names = JSON.parse(process.env.LIVE_BOXES);
const loadMinutes = Number(process.env.LIVE_LOAD_MINUTES ?? 8);
const { line, check } = makeReport(label);
const section = (name) => !only.size || only.has(name);
const clock = () => new Date().toISOString().slice(11, 19);

async function entryOf(name) {
  const entry = (await rpc("allBoxes")).find((each) => each.box.name === name);
  if (!entry) throw new Error(`no box ${name}`);
  return entry;
}

const loaded = await entryOf(names.L);
const desktop = names.D ? await entryOf(names.D) : null;
line(`Boxes: ${names.L} (${loaded.box.id}, ${loaded.box.size}); ${desktop ? `${names.D} (${desktop.box.id})` : "no desktop"}; thread ${thread}.`);
line("");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await skipSetup(page);

const shotsDir = join(home, "live-results", "shots");
mkdirSync(shotsDir, { recursive: true });
const SIZES = [
  [1440, 1000],
  [760, 1000],
  [390, 844],
];
async function theme(dark) {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
  await page.evaluate((on) => document.documentElement.classList.toggle("dark", on), dark);
}
async function shoot(name) {
  for (const dark of [false, true]) {
    await theme(dark);
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await pause(1200);
      await page.screenshot({ path: join(shotsDir, `${name}-${width}-${dark ? "dark" : "light"}.png`) });
    }
  }
  await theme(false);
  await page.setViewportSize({ width: 1440, height: 1000 });
}

const row = (name) => page.locator("[data-resource-row]", { hasText: name }).first();
const lineOf = (name) => row(name).locator("[data-row-line]");
const card = () => page.locator("section[aria-label]").filter({ has: page.locator("[data-resource-row]") }).first();
async function openList(tab = "threads") {
  await page.goto(`${boxes}/${tab}`);
  await row(names.L).waitFor({ timeout: 30_000 });
}

const SAMPLE_FRAMES = `
  window.__frames = [];
  let first = null;
  const sample = () => {
    const rows = [...document.querySelectorAll("[data-resource-row]")];
    if (rows.length) {
      first ??= performance.now();
      const list = rows[0].closest(".overflow-y-auto");
      window.__frames.push(rows.map((each) => { const box = each.getBoundingClientRect(); return Math.round(box.top) + ":" + Math.round(box.height); }).join("|") + "#" + (list ? Math.round(list.scrollHeight) : 0));
    }
    if (first === null || performance.now() - first < 5000) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
`;

if (section("frame")) {
  await check("list", "the list's rows and height do not move as data arrives: each row's top and height, and the list's height, sampled every frame for 5 s from the first frame with a row, on a fresh load", async () => {
    const said = [];
    for (const tab of ["threads", "machines"]) {
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      await fresh.addInitScript(SAMPLE_FRAMES);
      const view = await fresh.newPage();
      await view.goto(`${boxes}/${tab}`);
      await view.locator("[data-resource-row]").first().waitFor({ timeout: 30_000 }).catch(() => undefined);
      await pause(5500);
      const frames = await view.evaluate(() => window.__frames);
      await fresh.close();
      if (!frames.length && tab === "machines") {
        said.push("machines: none listed");
        continue;
      }
      const shapes = [...new Set(frames)];
      said.push(`${tab}: ${frames.length} frames, ${shapes.length} shape${shapes.length === 1 ? "" : "s"}`);
      expect(frames.length > 0, `${tab}: no rows`);
      expect(shapes.length === 1, `${tab}: the rows moved: ${shapes.join(" / ")}`);
    }
    return said.join("; ");
  });
}

if (section("thread")) {
  await check("list", "a thread working on its box says Working on its card, and Idle once it finishes", async () => {
    await openList();
    const before = agentStart(thread, "box_run", { box: names.L, command: "sleep 45" });
    const started = Date.now();
    await waitFor(async () => (await card().locator("[data-thread-state]").textContent()) === "Working", "Working", 40_000);
    const working = Date.now() - started;
    await agentResult("box_run", before, 120_000);
    const ended = Date.now();
    await waitFor(async () => /^Idle/.test((await card().locator("[data-thread-state]").textContent()) ?? ""), "Idle", 40_000);
    return `Working ${(working / 1000).toFixed(1)} s after the agent's call; "${await card().locator("[data-thread-state]").textContent()}" ${((Date.now() - ended) / 1000).toFixed(1)} s after its result`;
  });
}

if (section("control") && desktop) {
  await check("list", "a person takes control: the row says You have control, then nothing once handed back", async () => {
    await openList();
    expect(!(await lineOf(names.D).textContent()).includes("control"), "the agent's control says nothing");
    await row(names.D).getByRole("button", { name: "Open desktop" }).click();
    await page.getByRole("button", { name: "Take control" }).click();
    await page.getByRole("button", { name: /Hand back/ }).first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => (await lineOf(names.D).textContent()).includes("You have control"), "You have control", 30_000);
    const words = await lineOf(names.D).textContent();
    await shoot("control");
    await row(names.D).getByRole("button", { name: "Open desktop" }).click();
    await page.getByRole("button", { name: /Hand back/ }).first().click();
    await page.getByRole("button", { name: "Take control" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Back to boxes" }).click();
    await waitFor(async () => !(await lineOf(names.D).textContent()).includes("control"), "no control words", 30_000);
    return words.replaceAll("·", " · ").replace(/\s+/g, " ").trim();
  });
}

async function busyOf(name) {
  return (await entryOf(name)).busy ?? null;
}

if (section("busy")) {
  const container = containerOf(loaded.box.id);
  const cores = Number((loaded.box.size ?? "2 cores").split(" ")[0]);
  await check("G15", `a loaded box says busy after 5 minutes of load and stops after the load ends (${cores} yes on ${cores} cores for ${loadMinutes} min, read through allBoxes every 5 s)`, async () => {
    expect(container, "no container for the loaded box");
    expect((await busyOf(names.L)) === null, "busy before any load");
    const began = Date.now();
    docker(["exec", "-d", container, "sh", "-c", `for i in $(seq ${cores}); do timeout ${loadMinutes * 60} yes > /dev/null & done; wait`]);
    line(`  ${clock()} load started`);
    const busy = await waitFor(() => busyOf(names.L), "busy", (loadMinutes + 1) * 60_000);
    const after = (Date.now() - began) / 60_000;
    line(`  ${clock()} busy after ${after.toFixed(1)} min: ${JSON.stringify(busy)}`);
    expect(after >= 5, `busy after only ${after.toFixed(1)} min`);
    await openList();
    const words = await lineOf(names.L).textContent();
    expect(/Busy: CPU \d+% for \d+ min/.test(words), `the row says ${words}`);
    await shoot("busy-list");
    await page.goto(`${boxes}/box/${loaded.box.id}`);
    await page.locator("[data-busy]").waitFor({ timeout: 30_000 });
    const header = await page.locator("[data-busy]").textContent();
    let onBusy = false;
    for (let index = 0; index < 20 && !onBusy; index++) {
      await page.keyboard.press("Tab");
      onBusy = await page.evaluate(() => !!document.activeElement?.closest("[data-busy]"));
    }
    expect(onBusy, "Tab did not reach the busy words");
    await page.keyboard.press("Enter");
    await waitFor(() => page.evaluate(() => document.activeElement?.id === "processes-heading"), "focus on the processes", 5000);
    await shoot("busy-page");
    await page.goto(`${boxes}/threads`);
    await row(names.L).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await pause(1000);
    const shown = await lineOf(names.L).evaluate((element) => {
      const clip = element.getBoundingClientRect();
      const busyItem = [...element.querySelectorAll("[data-row-item]")].find((item) => item.textContent.includes("Busy"));
      if (!busyItem) return null;
      const box = busyItem.getBoundingClientRect();
      return { inside: box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && box.right <= clip.right + 1, lines: Math.round(clip.height / 16.5), text: busyItem.textContent };
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    expect(shown?.inside, `at 390 px the busy words are cut: ${JSON.stringify(shown)}`);
    const loadEnds = began + loadMinutes * 60_000;
    await waitFor(async () => Date.now() > loadEnds, "the load's end", (loadMinutes + 2) * 60_000);
    line(`  ${clock()} load ended`);
    await waitFor(async () => (await busyOf(names.L)) === null, "calm", 4 * 60_000);
    const calm = (Date.now() - loadEnds) / 1000;
    return `busy ${after.toFixed(1)} min after the load began; row "${words.replaceAll("·", " · ").replace(/\s+/g, " ").trim()}"; page "${header.replace(/^\W+/, "")}", reached by Tab, and Enter moved focus to Top processes; at 390 px "${shown.text.replace(/^·/, "")}" shown whole on a line of ${shown.lines}; calm ${calm.toFixed(0)} s after the load ended`;
  });
}

if (section("history-off")) {
  const container = containerOf(loaded.box.id);
  await check("G15", "turning box history off removes Busy from the row and the page within a minute", async () => {
    docker(["exec", "-d", container, "sh", "-c", "for i in $(seq 4); do timeout 600 yes > /dev/null & done; wait"]);
    await waitFor(() => busyOf(names.L), "busy", 9 * 60_000);
    await openList();
    await waitFor(async () => (await lineOf(names.L).textContent()).includes("Busy"), "the row's busy words", 30_000);
    const off = Date.now();
    bb(["box", "option", "set", "monitor.boxHistory=false"]);
    await waitFor(async () => !(await lineOf(names.L).textContent()).includes("Busy"), "no busy words on the row", 60_000);
    const row = (Date.now() - off) / 1000;
    await page.goto(`${boxes}/box/${loaded.box.id}`);
    await page.locator("h1[data-page-heading]").waitFor();
    await pause(1500);
    const onPage = await page.locator("[data-busy]").count();
    bb(["box", "option", "set", "monitor.boxHistory=true"]);
    docker(["exec", container, "pkill", "yes"]);
    expect(onPage === 0, "the page still says busy");
    return `the row lost its busy words ${row.toFixed(1)} s after the switch; the page says nothing`;
  });
}

if (section("keyboard")) {
  await check("keys", "keyboard only: Tab reaches a row's name with its line as its description, and Enter opens the page", async () => {
    await openList();
    await page.locator("input[aria-label='Search boxes']").focus();
    let described = null;
    for (let index = 0; index < 40 && !described; index++) {
      await page.keyboard.press("Tab");
      described = await page.evaluate(() => {
        const active = document.activeElement;
        if (!active?.hasAttribute("data-row-name")) return null;
        const ids = (active.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
        return `${active.getAttribute("aria-label")}: ${ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ")}`;
      });
    }
    expect(described, "Tab did not reach a row's name");
    await page.keyboard.press("Enter");
    await page.locator("h1[data-page-heading]").waitFor();
    return `the first name reached said "${described.replaceAll("·", " · ").replace(/\s+/g, " ")}"`;
  });
}

if (section("shots")) {
  await openList();
  await shoot("list-threads");
  await page.goto(`${boxes}/machines`);
  if (await page.locator("[data-resource-row]").first().waitFor({ timeout: 15_000 }).then(() => true, () => false)) await shoot("list-machines");
}

await browser.close();
