import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const bbCli = process.env.LIVE_BB_CLI ?? join(process.env.HOME ?? "", "bbcli");
const projectDir = process.env.LIVE_PROJECT ?? join(process.env.HOME ?? "", "proj");
const WAITS = "docker/bb-live/waits:1";
const FAILS = "docker:second/bb-live/fails:1";
mkdirSync(shots, { recursive: true });

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

const stored = async () => (await rpc("config.get")).document;

async function otherTab(change) {
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await rpc("config.get");
    const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
    if (result.ok) return result.state;
    if (result.reason === "problems") throw new Error(`the other tab's save was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("the other tab could not save");
}

function forgetRebuilds() {
  const db = new DatabaseSync(join(dataDir, "bb.db"));
  try {
    db.prepare("delete from plugin_kv where plugin_id = 'bb-box' and (key like 'images/state/%' or key = 'images/last-run')").run();
  } finally {
    db.close();
  }
}

function setRustTools() {
  execFileSync(bbCli, ["box", "image", "set", "rust-tools", "--kinds", "linux", "--script-file", ".bb/box-setup.sh", "--check-file", ".bb/box-check.sh", "--project", "proj_example"], { cwd: projectDir, stdio: "pipe" });
}

async function waitFor(check, what, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const browser = await chromium.launch();
let onboardingSkipped = false;

async function tab(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  return { page, context };
}

const heading = (page, title) => page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title}`) });

async function open(page, hash, title) {
  const url = `${base}/settings/plugins/bb-box${hash}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!onboardingSkipped) {
    const skip = page.getByRole("button", { name: "Skip setup" });
    await Promise.race([skip.waitFor({ timeout: 6_000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 6_000 }).catch(() => {})]);
    if (await skip.count()) {
      await skip.click();
      await pause(500);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    onboardingSkipped = true;
  }
  if (title) await heading(page, title).waitFor();
  else await page.locator("[data-settings-view]").waitFor();
  await pause(300);
}

const imageRow = (page, name) => page.locator(`[data-image-row="${name}"]`);

const checks = {
  async "Rebuild each night switched"(run) {
    await otherTab((document) => ({ ...document, general: { ...document.general, nightlyImages: undefined } }));
    const { page, context } = await tab();
    await open(page, "#option/images", "Images");
    const nightly = page.getByRole("switch", { name: "Rebuild each night" });
    expect((await nightly.getAttribute("aria-checked")) === "false", "the switch starts off");
    await nightly.click();
    await page.getByText("Saved", { exact: true }).first().waitFor();
    await waitFor(async () => (await stored()).general.nightlyImages === true, "nightlyImages stored on");
    await page.reload({ waitUntil: "domcontentloaded" });
    await heading(page, "Images").waitFor();
    await waitFor(async () => (await nightly.getAttribute("aria-checked")) === "true", "the switch on after a reload");
    if (run === 1) await page.screenshot({ path: join(shots, "live-nightly-on.png") });
    await nightly.click();
    await waitFor(async () => (await stored()).general.nightlyImages === undefined, "nightlyImages stored off, as the default");
    await context.close();
    return "on: Saved, stored true, on after a reload; off: stored as the default";
  },

  async "a run with a waiting and a failing image, on the page and in Status"(run) {
    forgetRebuilds();
    const { page, context } = await tab();
    await open(page, "#option/images", "Images");
    await page.getByText("2 of 2 images due.").waitFor();
    const before = await imageRow(page, WAITS).textContent();
    const lastRun = (await rpc("images.progress")).progress;
    expect(lastRun ? before.includes("Waits:") : before.includes("Due: it has no record, so its age is not known"), `before the run the waiting image's row says ${before}`);
    const seen = new Set();
    const started = Date.now();
    await page.getByRole("button", { name: "Rebuild 2 images" }).click();
    await waitFor(async () => {
      const { progress } = await rpc("images.progress");
      if (!progress || progress.started < started - 1_000) return false;
      if (await page.getByRole("progressbar", { name: "Rebuilding images" }).count()) seen.add("bar");
      for (const name of [WAITS, FAILS]) {
        const text = (await imageRow(page, name).textContent().catch(() => "")) ?? "";
        for (const words of ["Next", "Rebuilding", "Waits:", "Failed:"]) if (text.includes(words)) seen.add(`${name.split("/")[0]} ${words}`);
      }
      return progress.ended !== null && (await page.getByText(/The last rebuild ended just now/).count()) > 0;
    }, "the run to end", 240_000);
    await pause(1_000);
    const seconds = Math.round((Date.now() - started) / 1000);
    const waits = await imageRow(page, WAITS).textContent();
    const fails = await imageRow(page, FAILS).textContent();
    expect(/Waits: no room for its trial box: /.test(waits), `the waiting row says ${waits}`);
    expect(/Failed: setup\/docker\/build\.sh exited with \d+\./.test(fails), `the failing row says ${fails}`);
    const summary = await page.getByText(/The last rebuild ended/).textContent();
    expect(summary.includes("1 waited for room, 1 failed."), `the summary says ${summary}`);
    const progress = await rpc("images.progress");
    expect(progress.failures.length === 1 && progress.failures[0].name === FAILS, `images.progress lists ${JSON.stringify(progress.failures)}`);
    if (run === 1) await page.screenshot({ path: join(shots, "live-run-ended.png"), fullPage: true });

    await open(page, "", null);
    const things = page.getByRole("region", { name: "Things that need you" });
    await things.getByText("The Linux image on Docker for the failing image did not rebuild").waitFor();
    const callout = await things.textContent();
    expect(callout.includes(`Fix: Fix the cause, then run bb box images build ${FAILS}.`), `the callout says ${callout}`);
    expect(!callout.includes("bb-live/waits"), "a waiting image is not a problem in Status");
    const option = await page.locator("#settings-option-images").textContent();
    expect(option.includes("1 failed"), `the Images row says ${option}`);
    if (run === 1) await page.screenshot({ path: join(shots, "live-status.png") });
    await things.getByRole("button", { name: "Open The Linux image on Docker for the failing image did not rebuild" }).click();
    await heading(page, "Images").waitFor();
    expect(page.url().endsWith("#option/images"), `Open went to ${page.url()}`);
    await context.close();
    return `${seconds} s; seen on the page: ${[...seen].sort().join(", ")}; waits: "${waits.match(/Waits:[^·]*/)?.[0]?.trim()}"; fails: "${fails.match(/Failed:[^·]*/)?.[0]?.trim()}"; ${summary}; Status: the failing one with its fix, not the waiting one; the Images row: ${option.trim()}`;
  },

  async "a project's image removed after its confirmation"(run) {
    if (!(await stored()).images?.["rust-tools"]) setRustTools();
    const { page, context } = await tab();
    await open(page, "#option/images", "Images");
    const row = page.getByRole("button", { name: "rust-tools", exact: true });
    await row.click();
    expect((await row.getAttribute("aria-expanded")) === "true", "the row opens");
    await page.getByLabel("Script of rust-tools, run as root").getByText("apt-get install -y ripgrep").waitFor();
    await page.getByRole("button", { name: "Remove rust-tools…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove the image rust-tools?" });
    await dialog.waitFor();
    const says = await dialog.textContent();
    expect(says.includes("New Linux boxes in proj_example start from the standard images again, without its script. Its builds are deleted."), `the dialog says ${says}`);
    await pause(500);
    if (run === 1) await page.screenshot({ path: join(shots, "live-remove-dialog.png") });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await pause(500);
    expect((await stored()).images?.["rust-tools"], "Cancel removes nothing");
    expect((await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "rust-tools", "Cancel puts focus back on the row");
    await page.getByRole("button", { name: "Remove rust-tools…" }).click();
    await dialog.getByRole("button", { name: "Remove image" }).click();
    await waitFor(async () => !(await stored()).images?.["rust-tools"], "rust-tools gone from the configuration");
    await page.getByText("Removed the image rust-tools.").waitFor();
    await waitFor(async () => (await page.getByRole("button", { name: "rust-tools", exact: true }).count()) === 0, "its row gone");
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    expect(focused === "go-tools", `focus went to ${focused}`);
    const left = Object.keys((await stored()).images ?? {});
    await context.close();
    return `Cancel kept it; Remove image removed it; images now ${left.join(", ")}; focus on go-tools`;
  },

  async "when a project's image is built ahead, changed at once"() {
    const { page, context } = await tab();
    await open(page, "#option/images", "Images");
    const menu = page.getByRole("combobox", { name: "When go-tools is built ahead" });
    expect((await menu.textContent()) === "Run at each box's start", "go-tools starts as never");
    await menu.click();
    await page.getByRole("option", { name: "Built when used often" }).click();
    await waitFor(async () => (await stored()).images["go-tools"].bake === undefined, "go-tools stored as auto");
    await page.getByText("Saved", { exact: true }).first().waitFor();
    await menu.click();
    await page.getByRole("option", { name: "Run at each box's start" }).click();
    await waitFor(async () => (await stored()).images["go-tools"].bake === "never", "go-tools stored as never again");
    await context.close();
    return "auto stored as the default, then never again";
  },
};

const chosen = process.argv.slice(2);
const results = [];
for (let run = 1; run <= runs; run += 1) {
  for (const [name, check] of Object.entries(checks)) {
    if (chosen.length && !chosen.some((one) => name.includes(one))) continue;
    try {
      const said = await check(run);
      results.push({ run, name, ok: true, said });
      console.log(`run ${run} ok   ${name}: ${said}`);
    } catch (error) {
      results.push({ run, name, ok: false, said: error.message });
      console.log(`run ${run} FAIL ${name}: ${error.message}`);
    }
  }
}
writeFileSync(join(shots, "results.json"), JSON.stringify(results, null, 2));
await browser.close();
console.log(`${results.filter((result) => result.ok).length} of ${results.length} passed`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
