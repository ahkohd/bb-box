import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:7801";
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
mkdirSync(shots, { recursive: true });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function check(name, run) {
  try {
    const detail = await run();
    results.push({ name, ok: true, detail });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

const browser = await chromium.launch();
async function open(page, hash) {
  const url = `${base}/settings/plugins/bb-box${hash}`;
  const view = page.locator(hash.startsWith("#backend/") ? "[data-settings-view^='#backend/']" : `[data-settings-view='${hash || "#"}']`);
  const skip = page.getByRole("button", { name: "Skip setup" });
  for (let tries = 0; tries < 3; tries += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await Promise.race([view.waitFor(), skip.waitFor()]).catch(() => undefined);
    if (await view.isVisible()) return;
    if (await skip.isVisible()) {
      await skip.click();
      await pause(1_000);
    }
  }
  await view.waitFor();
}

const rowNames = (page) => page.locator("[data-image-row]").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-image-row")));

const listed = (await rpc("images.list")).images;
const healthy = listed.filter((image) => !image.due && image.outcome?.state !== "failed" && image.outcome?.state !== "waiting");
const needing = listed.filter((image) => !healthy.includes(image));
console.log(`images.list: ${listed.map((image) => `${image.name} due=${image.due ?? "-"} outcome=${image.outcome?.state ?? "-"}`).join("; ")}`);

const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20_000);

await check("Images page: only the images that need you have rows, the rest one fold row", async () => {
  await open(page, "#option/images");
  const fold = page.getByRole("button", { name: `${healthy.length} images up to date` });
  await fold.waitFor();
  await page.locator("[data-image-row]").first().waitFor();
  const rows = await rowNames(page);
  expect(JSON.stringify(rows) === JSON.stringify(needing.map((image) => image.name)), `rows ${rows.join(", ")} against ${needing.map((image) => image.name).join(", ")}`);
  expect((await fold.getAttribute("aria-expanded")) === "false", "fold not closed");
  const chevronLast = await fold.evaluate((button) => button.lastElementChild?.tagName.toLowerCase() === "svg");
  expect(chevronLast, "the chevron is not last");
  const order = await page.evaluate(() => {
    const at = (element) => Array.from(document.querySelectorAll("button, [role=switch], [data-image-row]")).indexOf(element);
    const nightly = document.querySelector("[role=switch][aria-label='Rebuild each night']");
    const fold = Array.from(document.querySelectorAll("button")).find((button) => / up to date$/.test(button.textContent ?? ""));
    const rebuild = Array.from(document.querySelectorAll("button")).find((button) => /^Rebuild( \d+ images?| what is due)/.test(button.textContent?.trim() ?? ""));
    const rows = Array.from(document.querySelectorAll("[data-image-row]"));
    return [at(nightly), ...rows.map(at), at(fold), at(rebuild)];
  });
  expect(order.every((value, index) => index === 0 || value > order[index - 1]), `order ${order.join(" < ")}`);
  return `${rows.length} rows (${rows.join(", ")}), then "${healthy.length} images up to date", closed, chevron last; nightly first and Rebuild last`;
});

await check("the fold opens and closes by keys, in place, with no animation", async () => {
  const fold = page.getByRole("button", { name: `${healthy.length} images up to date` });
  await fold.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("button[aria-expanded='true'][aria-controls]") !== null);
  const opened = await rowNames(page);
  const running = await page.evaluate(() => document.getAnimations().map((animation) => ({ kind: animation.constructor.name, property: animation.transitionProperty ?? animation.animationName ?? "", on: animation.effect?.target?.tagName ?? "?" })));
  const COLOUR = /color$/;
  const animations = running.filter((each) => !(each.kind === "CSSTransition" && COLOUR.test(each.property))).length;
  console.log(`animations: ${JSON.stringify(running)}`);
  const controlled = await fold.evaluate((button) => Array.from(document.getElementById(button.getAttribute("aria-controls")).querySelectorAll("[data-image-row]"), (row) => row.getAttribute("data-image-row")));
  expect(JSON.stringify(controlled.sort()) === JSON.stringify(healthy.map((image) => image.name).sort()), `opened ${controlled.join(", ")}`);
  expect(animations === 0, `${animations} animations`);
  await page.screenshot({ path: join(shots, "live-open.png"), fullPage: true });
  const focused = await page.evaluate(() => document.activeElement?.textContent);
  await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelector("button[aria-expanded='false']") !== null);
  const closed = await rowNames(page);
  expect(closed.length === needing.length, `closed shows ${closed.length}`);
  return `Enter opened ${opened.length} rows (${controlled.length} under the fold), focus kept on "${focused}"; Space closed it back to ${closed.length}; motion ${animations}, colour transitions ${running.length - animations} (${running.map((each) => `${each.property} on ${each.on}`).join(", ") || "none"})`;
});

const failed = listed.find((image) => image.outcome?.state === "failed");
const failedBackend = failed.backend;
const healthyBackend = healthy[0].backend;

await check("a backend's page lists its own image with Try again, which rebuilds it", async () => {
  await open(page, `#backend/${failedBackend}`);
  const group = page.getByRole("region", { name: "Images" });
  await group.locator("[data-image-row]").first().waitFor();
  const rows = await group.locator("[data-image-row]").evaluateAll((each) => each.map((row) => row.getAttribute("data-image-row")));
  expect(JSON.stringify(rows) === JSON.stringify(listed.filter((image) => image.backend === failedBackend).map((image) => image.name)), `rows ${rows.join(", ")}`);
  const line = (await group.locator("[data-image-row]").first().innerText()).replace(/\s+/g, " ");
  const again = group.getByRole("button", { name: /^Try the .* again$/ });
  const before = (await rpc("images.progress")).progress?.started ?? null;
  await again.click();
  const deadline = Date.now() + 120_000;
  let progress = await rpc("images.progress");
  while ((progress.progress?.started ?? null) === before || progress.running) {
    expect(Date.now() < deadline, "no new run ended within 120 s");
    await pause(500);
    progress = await rpc("images.progress");
  }
  const ran = progress.progress.images.map((image) => `${image.name} ${image.state}`).join(", ");
  expect(progress.progress.only === failed.name || (progress.progress.images.length === 1 && progress.progress.images[0].name === failed.name), `the run was ${ran}`);
  await page.waitForFunction(() => document.querySelector("[data-image-row]")?.textContent?.includes("Failed:"), null, { timeout: 30_000 });
  const after = (await group.locator("[data-image-row]").first().innerText()).replace(/\s+/g, " ");
  const tookSeconds = Math.round((progress.progress.ended - progress.progress.started) / 1000);
  return `before: "${line}"; Try again started a new run of ${ran}, ended in ${tookSeconds} s; after: "${after}"`;
});

await check("a backend with an image that is up to date lists it, and its link opens the Images page", async () => {
  await open(page, `#backend/${healthyBackend}`);
  const group = page.getByRole("region", { name: "Images" });
  await group.locator("[data-image-row]").first().waitFor();
  const text = (await group.innerText()).replace(/\s+/g, " ");
  expect(/Up to date/.test(text), text);
  await group.getByRole("button", { name: "Open the Images page" }).click();
  await page.locator("[data-settings-view='#option/images']").waitFor();
  return `"${text}" then ${new URL(page.url()).hash}`;
});

await check("Find finds an image by its kind and backend and opens its row on the backend's page", async () => {
  await open(page, "");
  const field = page.getByRole("combobox", { name: "Find a setting" });
  await field.click();
  await pause(1_500);
  const label = (await rpc("config.get")).document.backends.find((backend) => backend.id === healthyBackend).label ?? "Docker";
  const query = `linux image ${label.split(" ").at(-1)}`;
  await page.keyboard.type(query);
  const options = page.getByRole("listbox", { name: "Settings that match" }).getByRole("option");
  await options.first().waitFor();
  const texts = (await options.allInnerTexts()).map((text) => text.replace(/\s+/g, " "));
  const at = texts.findIndex((text) => text.startsWith("Standard Linux image"));
  expect(at >= 0, `no image among ${texts.join(" / ")}`);
  for (let step = 0; step < at; step += 1) await page.keyboard.press("ArrowDown");
  const words = `${texts[at]}, result ${at + 1} of ${texts.length}: ${texts.slice(0, 3).join(" / ")}`;
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector("[data-found]") !== null, null, { timeout: 8_000 });
  const found = await page.evaluate(() => ({ path: document.activeElement?.getAttribute("data-draft-path"), hash: location.hash, top: document.activeElement?.getBoundingClientRect().top, height: innerHeight }));
  expect(found.path === `standard-images/${healthy.find((image) => image.backend === healthyBackend).name}`, JSON.stringify(found));
  expect(found.top > 0 && found.top < found.height, `off screen ${found.top}`);
  await page.screenshot({ path: join(shots, "live-found.png") });
  return `"${query}": chosen result "${words}"; Enter opened ${found.hash} with ${found.path} focused and ringed, ${Math.round(found.top)} px down`;
});

await context.close();

for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 760, 390]) {
    const shot = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
    const tab = await shot.newPage();
    await open(tab, "#option/images");
    const fold = tab.getByRole("button", { name: / images up to date$/ });
    await fold.waitFor();
    await pause(600);
    await tab.screenshot({ path: join(shots, `images-folded-${width}-${scheme}.png`), fullPage: true });
    await fold.click();
    await tab.mouse.move(0, 0);
    await pause(300);
    await tab.screenshot({ path: join(shots, `images-open-${width}-${scheme}.png`), fullPage: true });
    for (const [name, id] of [["backend-failed", failedBackend], ["backend-healthy", healthyBackend]]) {
      await open(tab, `#backend/${id}`);
      const group = tab.getByRole("region", { name: "Images" });
      await group.locator("[data-image-row]").first().waitFor();
      await group.scrollIntoViewIfNeeded();
      await pause(400);
      await tab.screenshot({ path: join(shots, `${name}-${width}-${scheme}.png`) });
    }
    await shot.close();
  }
}
await browser.close();
const passed = results.filter((each) => each.ok).length;
console.log(`${passed} of ${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
