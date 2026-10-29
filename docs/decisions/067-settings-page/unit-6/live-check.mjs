import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const chosen = process.argv.slice(2);
mkdirSync(shots, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const GET = "**/api/v1/plugins/bb-box/rpc/config.get";
const STAYS_ON = "The default kind stays on. Choose another default to turn it off.";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gate() {
  let open = () => {};
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

const stored = () => rpc("config.get");
const backendIn = (state, id) => state.document.backends.find((backend) => backend.id === id);

async function otherTab(change) {
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await stored();
    const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
    if (result.ok) return result.state;
    if (result.reason === "problems") throw new Error(`the other tab's save was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("the other tab could not save");
}

async function reset(run) {
  await otherTab((document) => ({
    ...document,
    kinds: {},
    general: {},
    backends: [
      { id: "docker", type: "docker", enabled: true, fields: {} },
      { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { url: "https://127.0.0.1:9", "token-id": "bb-box@pve!made-up", "token-secret": `made-up-secret-${run}` } },
      { id: "tart", type: "tart", enabled: false, fields: {} },
      { id: "ssh-pool", type: "ssh-pool", enabled: false, fields: {} },
      { id: "namespace", type: "namespace", enabled: false, fields: {} },
    ],
  }));
}

const browser = await chromium.launch();

async function tab(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const applies = [];
  await page.route(APPLY, async (route) => {
    applies.push(JSON.parse(route.request().postData() ?? "null"));
    await route.continue();
  });
  let readsHeld = null;
  await page.route(GET, async (route) => {
    if (readsHeld) await readsHeld;
    await route.continue();
  });
  return {
    page,
    applies,
    holdReads: () => {
      const held = gate();
      readsHeld = held.promise;
      return () => {
        readsHeld = null;
        held.open();
      };
    },
  };
}

let onboardingSkipped = false;

const heading = (page, title) => page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

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
  else await page.locator("[data-settings-view='#']").waitFor();
  await pause(300);
}

const bar = (page, what) => page.getByRole("region", { name: `Save ${what}` });
const field = (page, name) => page.getByRole("textbox", { name, exact: true });
const row = (page, path) => page.locator(`[data-setting-row="${path}"]`);
const focused = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-draft-path") ?? document.activeElement?.getAttribute("aria-label") ?? "");
const described = (locator) => locator.evaluate((element) => (element.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" "));

async function barSays(region, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = (await region.getByRole("status").first().textContent({ timeout: 1_000 }).catch(() => "")) ?? "";
    if (pattern.test(text)) return text;
    await pause(100);
  }
  throw new Error(`the bar never said ${pattern}; it said "${text}"`);
}

async function waitFor(check, what, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function snap(page, run, name) {
  if (run === 1) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function leaveBySidebar(page) {
  await page.getByRole("link", { name: "General", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/plugins/bb-box"));
  await page.locator("[data-settings-view]").waitFor({ state: "detached" });
}

const checks = {
  async "a kind edit racing a warm-count edit in another tab"({ run }) {
    const a = await tab();
    const b = await tab();
    await open(a.page, "#kind/linux", "Linux");
    await open(b.page, "#kind/linux", "Linux");
    const release = a.holdReads();
    await field(a.page, "Small size: cores").fill("3");
    await field(b.page, "Warm boxes on Proxmox LXC").fill("2");
    await bar(b.page, "Linux").getByRole("button", { name: "Save", exact: true }).click();
    const other = await barSays(bar(b.page, "Linux"), /^Saved\./);
    expect(backendIn(await stored(), "proxmox-lxc").warm?.linux === 2, "the other tab's warm count is stored");
    const sent = a.applies.length;
    await bar(a.page, "Linux").getByRole("button", { name: "Save", exact: true }).click();
    await waitFor(() => a.applies.length > sent, "tab A to send its save");
    release();
    const merged = await barSays(bar(a.page, "Linux"), /^Saved at revision \d+, on top of a change made elsewhere\./);
    const after = await stored();
    expect(after.document.kinds.linux?.presets?.small?.cores === 3, `small cores stored: ${JSON.stringify(after.document.kinds.linux)}`);
    expect(backendIn(after, "proxmox-lxc").warm?.linux === 2, "the other tab's warm count is kept");
    expect(a.applies.at(-1).operation === a.applies[sent].operation, "the retry kept its operation ID");
    await snap(a.page, run, "live-race-merged");

    await field(a.page, "Warm boxes on Proxmox LXC").fill("4");
    await field(b.page, "Warm boxes on Proxmox LXC").fill("5");
    await bar(b.page, "Linux").getByRole("button", { name: "Save", exact: true }).click();
    await barSays(bar(b.page, "Linux"), /^Saved\./);
    const warmRow = row(a.page, "backends/proxmox-lxc/warm/linux");
    await warmRow.getByText("Changed elsewhere to").waitFor();
    const conflict = (await warmRow.getByText("Changed elsewhere to").textContent()).trim();
    const conflictBar = await barSays(bar(a.page, "Linux"), /^A setting you changed was changed elsewhere too\./);
    await snap(a.page, run, "live-race-conflict");
    const before = (await stored()).revision;
    await warmRow.getByRole("button", { name: "Keep mine" }).click();
    expect((await stored()).revision === before, "nothing is stored until Save");
    await bar(a.page, "Linux").getByRole("button", { name: "Save", exact: true }).click();
    await barSays(bar(a.page, "Linux"), /^Saved/);
    expect(backendIn(await stored(), "proxmox-lxc").warm?.linux === 4, "Keep mine stored 4");
    await a.page.context().close();
    await b.page.context().close();
    return { other, merged, conflict, conflictBar };
  },

  async "the default kind's switch on the overview and the kind page"({ run }) {
    const { page, applies } = await tab();
    await open(page, "", null);
    const rowSwitch = page.getByRole("switch", { name: "Linux: offered to threads" });
    expect((await rowSwitch.getAttribute("aria-disabled")) === "true" && (await rowSwitch.getAttribute("aria-checked")) === "true", "the overview's switch is on and disabled");
    const rowWhy = await described(rowSwitch);
    expect(rowWhy.includes(STAYS_ON), `the overview's switch says why: ${rowWhy}`);
    await rowSwitch.click({ force: true });
    await rowSwitch.focus();
    await page.keyboard.press("Space");
    await pause(500);
    expect(applies.length === 0 && (await rowSwitch.getAttribute("aria-checked")) === "true", "a click and Space send nothing");
    await page.getByRole("button", { name: "Change the default" }).click();
    await page.waitForURL((url) => url.hash === "#option/boxes");
    await waitFor(async () => (await focused(page)) === "general/defaultKind", "focus on the Default kind menu");

    await open(page, "#kind/linux", "Linux");
    const own = page.getByRole("switch", { name: "Linux: offered to threads" });
    const ownWhy = await described(own);
    expect((await own.getAttribute("aria-disabled")) === "true" && ownWhy.includes("The default kind stays on. Choose another default to turn it off."), `the page's switch: ${ownWhy}`);
    await own.focus();
    await page.keyboard.press("Space");
    await pause(500);
    expect(applies.length === 0, "Space on the page's switch sends nothing");
    expect(!(await page.getByRole("button", { name: "Make default" }).count()), "no Make default on the default kind");
    await snap(page, run, "live-default-kind");
    await page.getByRole("button", { name: "Choose another default" }).click();
    await page.waitForURL((url) => url.hash === "#option/boxes");
    await waitFor(async () => (await focused(page)) === "general/defaultKind", "focus on the Default kind menu from the page");

    await open(page, "#kind/linux-desktop-cpu", "Linux desktop");
    await page.getByRole("button", { name: "Make default" }).click();
    const name = "Linux desktop (CPU): offered to threads";
    await waitFor(async () => (await focused(page)) === name, "focus on the new default's switch");
    expect((await stored()).document.general.defaultKind === "linux-desktop-cpu", "Make default is stored at once");
    expect((await page.getByRole("switch", { name }).getAttribute("aria-disabled")) === "true", "its switch stays on now");
    await open(page, "#kind/linux", "Linux");
    expect((await page.getByRole("switch", { name: "Linux: offered to threads" }).getAttribute("aria-disabled")) === null, "Linux's switch can be turned off now");
    await page.context().close();
    return { overview: rowWhy.trim(), page: ownWhy.trim(), madeDefault: "linux-desktop-cpu" };
  },

  async "a kind turned off stays in place until the person leaves"({ run }) {
    const { page } = await tab();
    await open(page, "", null);
    const cpu = "Linux desktop (CPU)";
    await page.getByRole("switch", { name: `${cpu}: offered to threads` }).click();
    await waitFor(async () => (await stored()).document.kinds["linux-desktop-cpu"]?.enabled === false, "the kind stored off");
    const cpuRow = page.getByRole("button", { name: cpu, exact: true });
    await waitFor(async () => (await described(cpuRow)).includes("Off: no new boxes"), "the row to say Off");
    const dimmed = await cpuRow.evaluate((element) => getComputedStyle(element.parentElement.parentElement).opacity);
    expect(Number(dimmed) < 1, `the row is dimmed: ${dimmed}`);
    expect(!(await page.getByRole("button", { name: /kinds? off/ }).count()), "nothing folded yet");
    await snap(page, run, "live-kept-in-place");
    await cpuRow.click();
    await heading(page, "Linux desktop").waitFor();
    await page.getByText("Off: no new boxes").first().waitFor();
    await page.getByRole("button", { name: "BB Box settings" }).click();
    await page.getByRole("button", { name: "Linux desktop on Wayland", exact: true }).click();
    await heading(page, "Linux desktop on Wayland").waitFor();
    await page.getByRole("switch", { name: "Linux desktop on Wayland: offered to threads" }).click();
    await waitFor(async () => (await stored()).document.kinds["linux-desktop-wayland-cpu"]?.enabled === false, "the second kind stored off");
    await page.getByRole("button", { name: "BB Box settings" }).click();
    await page.locator("[data-settings-view='#']").waitFor();
    expect(await page.getByRole("button", { name: cpu, exact: true }).count(), "the first kind is still in place");
    expect(await page.getByRole("button", { name: "Linux desktop on Wayland", exact: true }).count(), "the kind turned off on its page is in place too");
    await leaveBySidebar(page);
    await page.goBack();
    await page.locator("[data-settings-view='#']").waitFor();
    const folded = page.getByRole("button", { name: /2 kinds off/ });
    await folded.waitFor();
    expect(!(await page.getByRole("button", { name: cpu, exact: true }).count()), "after leaving, the kinds off are folded");
    await snap(page, run, "live-folded-after-leaving");
    const foldedWords = (await folded.textContent()).trim();
    await page.context().close();
    return { dimmed, folded: foldedWords };
  },

  async "every backend that makes a kind is listed in its warm boxes"({ run }) {
    const { page } = await tab();
    await open(page, "#kind/ios", "iOS Simulator");
    const where = page.getByRole("region", { name: "Where it runs" });
    const listed = (await where.locator("[data-row-key^='runs-on-']").allTextContents()).map((text) => text.trim());
    expect(listed.join() === "Tart,SSH host pool,Namespace", `iOS Simulator lists ${listed}`);
    const iosNotes = await where.getByText("No warm boxes: its shared iOS hosts keep slots ready instead.").count();
    expect(iosNotes === 3, `each says why it keeps no warm boxes: ${iosNotes}`);
    expect(!(await where.getByRole("textbox").count()), "no warm count where none is kept");
    await snap(page, run, "live-ios-where");
    await where.getByRole("button", { name: "Open its shared iOS hosts" }).first().click();
    await heading(page, "Tart").waitFor();
    await waitFor(async () => (await focused(page)).endsWith("ios-hosts-ahead"), "focus on Tart's ready slots");
    const focusedOn = await focused(page);

    await open(page, "#kind/macos", "macOS");
    const macos = (await page.locator("[data-row-key^='runs-on-']").allTextContents()).map((text) => text.trim());
    expect(macos.join() === "Tart,SSH host pool,Namespace", `macOS lists ${macos}`);
    expect(await field(page, "Warm boxes on Tart").count(), "Tart keeps warm macOS boxes");

    await otherTab((document) => ({ ...document, backends: document.backends.map((backend) => (backend.id === "docker" ? { ...backend, warm: { linux: 2 } } : backend)) }));
    await open(page, "#kind/linux", "Linux");
    const docker = row(page, "backends/docker/warm/linux");
    await docker.getByText("Makes it now").waitFor();
    const dockerNote = (await docker.getByText(/^No warm boxes of this kind/).textContent()).trim();
    expect((await field(page, "Warm boxes on Docker").inputValue()) === "2", "a stored count where none is kept stays editable");
    await snap(page, run, "live-linux-where");
    await field(page, "Warm boxes on Docker").fill("0");
    await bar(page, "Linux").getByRole("button", { name: "Save", exact: true }).click();
    await barSays(bar(page, "Linux"), /^Saved\./);
    expect(backendIn(await stored(), "docker").warm === undefined, "set to 0, it is left out");
    expect(!(await field(page, "Warm boxes on Docker").count()), "and its field goes");
    expect(await field(page, "Warm boxes on Proxmox LXC").count(), "Proxmox LXC keeps warm Linux boxes, even while off");
    await page.context().close();
    return { ios: listed, macos, focusedOn, dockerNote };
  },

  async "a size above the largest is refused at its row"({ run }) {
    const { page } = await tab();
    await open(page, "#kind/linux", "Linux");
    const before = (await stored()).revision;
    await field(page, "Medium size: cores").fill("40");
    await field(page, "Medium size: cores").press("Enter");
    const refused = await barSays(bar(page, "Linux"), /^Not saved: fix the field marked\./);
    const problem = (await row(page, "kinds/linux/presets/medium").getByRole("alert").textContent()).trim();
    expect(problem.startsWith("Medium: "), `the problem is under Medium: ${problem}`);
    expect((await field(page, "Medium size: cores").getAttribute("aria-invalid")) === "true", "its cores are marked invalid");
    expect((await stored()).revision === before, "nothing stored");
    await bar(page, "Linux").getByRole("button", { name: "Show" }).click();
    await waitFor(async () => (await focused(page)).startsWith("kinds/linux/presets/medium"), "Show to focus the medium size");
    await snap(page, run, "live-refused-at-row");
    await page.context().close();
    return { refused, problem };
  },
};

const results = [];
const names = chosen.length ? Object.keys(checks).filter((name) => chosen.some((word) => name.startsWith(word))) : Object.keys(checks);
for (const name of names) {
  for (let run = 1; run <= runs; run += 1) {
    await reset(run);
    const started = Date.now();
    try {
      const details = await checks[name]({ run });
      results.push({ check: name, run, pass: true, ms: Date.now() - started, details });
    } catch (error) {
      results.push({ check: name, run, pass: false, ms: Date.now() - started, error: String(error.message ?? error).split("\n")[0] });
      for (const context of browser.contexts()) {
        for (const page of context.pages()) await page.screenshot({ path: join(shots, `failed-${name.replace(/[^a-z0-9]+/gi, "-")}-${run}.png`) }).catch(() => {});
        await context.close().catch(() => {});
      }
    }
    console.log(JSON.stringify(results.at(-1)));
  }
}
writeFileSync(join(shots, "results.json"), JSON.stringify(results, null, 1));
await browser.close();
const failed = results.filter((result) => !result.pass).length;
console.log(`${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
