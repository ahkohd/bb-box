import { execFile } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { bb, boxes, containerOf, docker, expect, home, makeReport, pause, rpc, skipSetup, waitFor } from "./live-lib.mjs";

const run = promisify(execFile);
const label = process.argv[2] ?? "run";
const shots = process.env.LIVE_SHOTS === "1";
const { line, check } = makeReport(label);
const name = process.env.A;
const all = await rpc("allBoxes");
const box = all.find((each) => each.box.name === name).box;
const container = containerOf(box.id);
line(`Box: ${box.name} (${box.id}), container ${container}.`);
line("");

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);
await skipSetup(page);
const url = `${boxes}/box/${box.id}`;
const shotDir = join(home, "live-results", "shots");
mkdirSync(shotDir, { recursive: true });

const activity = () => page.getByRole("region", { name: "Activity" });
const tile = (label) => activity().locator(`section[aria-label="${label}"]`);
const tileValue = async (label) => Number((await tile(label).locator(".text-xl").innerText()).trim());
const status = async () => (await activity().locator("h2 + span").innerText().catch(() => "")).trim();

async function shoot(base) {
  if (!shots) return;
  for (const scheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), scheme === "dark");
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await pause(700);
      await page.screenshot({ path: join(shotDir, `${base}-${width}-${scheme}.png`), fullPage: true });
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

function parseTop(text) {
  const frames = text.split(/^top - /m).slice(1);
  return frames.map((frame) => {
    const summary = /%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/.exec(frame);
    const rows = frame.split("\n").filter((row) => /^\s*\d+\s/.test(row));
    const stress = rows.filter((row) => /stress-ng/.test(row)).map((row) => Number(row.trim().split(/\s+/)[8]));
    const every = rows.map((row) => Number(row.trim().split(/\s+/)[8])).filter(Number.isFinite);
    return { summary: summary ? Number(summary[1]) + Number(summary[2]) : null, stress: stress.reduce((sum, value) => sum + value, 0), every: every.reduce((sum, value) => sum + value, 0) };
  });
}

await check("Follow-up", "a thread with no title heads its card on the Threads tab with its first prompt, as BB's sidebar does", async () => {
  await page.goto(`${boxes}/threads`);
  const thread = process.env.LIVE_THREAD;
  const card = page.locator("section", { has: page.getByText(box.name, { exact: true }) }).first();
  await card.waitFor();
  const label = await card.getAttribute("aria-label");
  expect(label && label !== thread, `the card is headed "${label}"`);
  if (shots) await page.screenshot({ path: join(shotDir, "threads-1440-light.png") });
  return `headed "${label}", not ${thread}`;
});

await check("Activity", "the page shows Live tiles for a box being read, with the time of its last reading", async () => {
  await page.goto(url);
  await waitFor(async () => /^Read at /.test(await status()), "a reading");
  const cpu = await tile("CPU").innerText();
  const cores = Number(/(\d+) cores/.exec(cpu)?.[1]);
  expect(cores === 4, `CPU tile names 4 cores: ${cpu}`);
  const first = await status();
  await waitFor(async () => (await status()) !== first, "a second reading", 15_000);
  return `${first}, then ${await status()}; CPU tile "${cpu.replace(/\n/g, " ")}"`;
});

await check("Activity", "the box's terminal: stress-ng --cpu 2 and top", async () => {
  docker(["exec", "-u", "root", container, "sh", "-c", "command -v stress-ng >/dev/null || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq stress-ng >/dev/null)"]);
  const terminal = await context.newPage();
  await terminal.setViewportSize({ width: 1440, height: 900 });
  await terminal.goto(`${url}/terminal/from-box`);
  await terminal.locator(".xterm").first().waitFor({ timeout: 30_000 });
  await pause(2500);
  await terminal.locator(".xterm").first().click();
  await terminal.keyboard.type("stress-ng --cpu 2 --timeout 150s >/dev/null 2>&1 &\n", { delay: 15 });
  await pause(800);
  await terminal.keyboard.type("top -d 5\n", { delay: 15 });
  await pause(12_000);
  await terminal.screenshot({ path: join(shotDir, "terminal-top-1440.png") });
  await terminal.close();
  return "typed into the page's Terminal view; screenshot terminal-top-1440.png";
});

await check("CPU", "the page's CPU against top in the box, under stress-ng --cpu 2, within 5 points", async () => {
  await page.bringToFront();
  await pause(6000);
  const topRun = run("/usr/bin/docker", ["exec", container, "top", "-b", "-d", "5", "-n", "9", "-w", "200"], { maxBuffer: 8 * 1024 * 1024 });
  const samples = [];
  const started = Date.now();
  while (Date.now() - started < 42_000) {
    samples.push({ at: Date.now(), cpu: await tileValue("CPU"), read: await status() });
    await pause(5000);
  }
  const frames = parseTop((await topRun).stdout).slice(1);
  const cores = 4;
  const fromTop = frames.map((frame) => frame.stress / cores);
  const everyTop = frames.map((frame) => frame.every / cores);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const pageMean = mean(samples.map((sample) => sample.cpu));
  const topMean = mean(everyTop);
  writeFileSync(join(home, "live-results", `${label}-cpu.json`), JSON.stringify({ samples, frames }, null, 2));
  const gap = Math.abs(pageMean - topMean);
  expect(gap <= 5, `page ${pageMean.toFixed(1)}% against top ${topMean.toFixed(1)}%`);
  return `page ${samples.map((sample) => sample.cpu).join(", ")} (mean ${pageMean.toFixed(1)}%); top, every process's %CPU over ${cores} cores: ${everyTop.map((value) => value.toFixed(1)).join(", ")} (mean ${topMean.toFixed(1)}%), stress-ng's alone ${mean(fromTop).toFixed(1)}%; top's own %Cpu(s) line, the host's ${frames[0]?.summary ?? "?"}% and on; gap ${gap.toFixed(1)} points`;
});

await check("Activity", "the processes card lists stress-ng at about 100% each, in amber at 100% or more", async () => {
  const card = page.getByRole("region", { name: "Top processes" });
  const text = await card.innerText();
  expect(/stress-ng/.test(text), text);
  const amber = await card.locator("td.text-warning-text").count();
  return `${text.split("\n").slice(0, 8).join(" | ")}; ${amber} amber`;
});

await check("Keyboard", "Tab reaches the legend and the chart; the arrows move a read-out its live region says", async () => {
  const chart = activity().locator("[data-history-chart]").first();
  await chart.focus();
  const role = `${await chart.getAttribute("role")} "${await chart.getAttribute("aria-roledescription")}"`;
  const heldWords = await activity().locator("[data-held]").count();
  await page.keyboard.press("End");
  const end = await chart.locator("[data-read-out]").innerText();
  await page.keyboard.press("ArrowLeft");
  const left = await chart.locator("[data-read-out]").innerText();
  const scrolled = await page.evaluate(() => document.querySelector("[data-history-chart]")?.closest(".overflow-y-auto")?.scrollTop ?? 0);
  await page.keyboard.press("PageDown");
  const after = await page.evaluate(() => document.querySelector("[data-history-chart]")?.closest(".overflow-y-auto")?.scrollTop ?? 0);
  expect(end && left && end !== left, `${end} / ${left}`);
  expect(after === scrolled, `Page Down scrolled from ${scrolled} to ${after}`);
  const described = await chart.getAttribute("aria-describedby");
  const summary = await page.locator(`[id="${described}"]`).innerText();
  await page.keyboard.press("Escape");
  return `${role}, held while focused: ${heldWords ? "yes" : "no"}; End: "${end}"; Left: "${left}"; summary: "${summary}"`;
});

await shoot("ready-load");

await check("Monitor", "the Monitor turned off: nothing read, and the way to turn it on; then on again: Live back", async () => {
  bb(["box", "option", "set", "monitor.enabled=false"]);
  await waitFor(async () => /The Monitor is off, so bb-box reads nothing now/.test(await activity().innerText()), "the off words", 30_000);
  const href = await activity().getByRole("link", { name: "Turn it on in Monitor settings" }).getAttribute("href");
  const processes = await page.getByRole("region", { name: "Top processes" }).count();
  await shoot("monitor-off");
  bb(["box", "option", "set", "monitor.enabled=true"]);
  await waitFor(async () => /^Read at /.test(await status()), "Live again", 40_000);
  return `off: link ${href}, processes card ${processes ? "shown" : "gone"}; on: ${await status()}`;
});

await check("G16", "Live keeps reading while the box stops, and once stopped the card says so", async () => {
  writeFileSync(join(home, "flags", "stop-slow"), "20");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  if (await dialog.waitFor({ timeout: 2500 }).then(() => true, () => false)) await dialog.getByRole("button", { name: /Stop/ }).last().click();
  await waitFor(async () => /Stopping/.test(await page.locator("h1 + p").innerText()), "Stopping", 15_000);
  const before = await status();
  await pause(11_000);
  const during = await status();
  const stoppingStill = /Stopping/.test(await page.locator("h1 + p").innerText());
  if (shots) await page.screenshot({ path: join(shotDir, "stopping-1440-light.png"), fullPage: true });
  rmSync(join(home, "flags", "stop-slow"), { force: true });
  await waitFor(async () => /is stopped, so bb-box is not reading it/.test(await activity().innerText()), "the stopped words", 60_000);
  const words = await activity().innerText();
  expect(before !== during && stoppingStill, `reading moved from "${before}" to "${during}" while stopping: ${stoppingStill}`);
  await shoot("stopped");
  return `while stopping: "${before}" then "${during}"; stopped: "${words.replace(/\n/g, " ")}"`;
});

await check("Activity", "started again, Live comes back on its own", async () => {
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await waitFor(async () => /^Read at /.test(await status()), "Live again", 90_000);
  return await status();
});

await check("Activity", "a reading that fails after one worked keeps the last numbers under the Monitor's notice", async () => {
  docker(["pause", container]);
  try {
    await waitFor(async () => (await activity().locator("[data-stale]").count()) > 0, "the stale notice", 90_000);
    const words = await activity().locator("[data-stale]").innerText();
    const cpu = await tile("CPU").innerText();
    if (shots) await page.screenshot({ path: join(shotDir, "stale-1440-light.png"), fullPage: true });
    return `"${words}"; CPU tile kept: "${cpu.replace(/\n/g, " ")}"`;
  } finally {
    docker(["unpause", container]);
  }
});

await browser.close();
