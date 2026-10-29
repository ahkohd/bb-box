import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const chosen = process.argv.slice(2);
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

const stored = () => rpc("config.get");

async function otherTab(change) {
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await stored();
    const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
    if (result.ok) return result.state;
    if (result.reason === "problems") throw new Error(`the save was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("could not save");
}

async function reset(run) {
  await otherTab((document) => ({
    ...document,
    kinds: {},
    general: {},
    backends: [
      { id: "docker", type: "docker", enabled: true, fields: {} },
      { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { url: "https://192.0.2.10:8006", node: "pve-1", "token-id": "bb-box@pve!made-up", "token-secret": `made-up-secret-${run}` } },
      { id: "tart", type: "tart", enabled: false, fields: {}, hosts: [{ name: "mac-1", enabled: true, fields: { address: "192.0.2.20", user: "admin" } }] },
    ],
  }));
}

const browser = await chromium.launch();
let onboardingSkipped = false;

async function tab(viewport = { width: 1440, height: 1000 }, colorScheme = "dark") {
  const context = await browser.newContext({ viewport, colorScheme });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  return page;
}

async function open(page, hash) {
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
  await page.locator(`[data-settings-view='${hash || "#"}']`).waitFor();
  await pause(400);
}

const findField = (page) => page.getByRole("combobox", { name: "Find a setting" });

async function typeQuery(page, query) {
  const field = findField(page);
  await field.click();
  await field.fill("");
  await page.keyboard.type(query);
  await pause(150);
}

async function optionsShown(page) {
  return page.getByRole("listbox", { name: "Settings that match" }).getByRole("option").allTextContents();
}

async function choose(page, query, label, where = "") {
  await typeQuery(page, query);
  const options = await optionsShown(page);
  const at = options.findIndex((text) => text.startsWith(label) && text.slice(label.length).startsWith(where));
  expect(at >= 0, `"${query}" listed no ${label}: ${options.slice(0, 8).join(" / ")}`);
  for (let step = 0; step < at; step += 1) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  return { options: options.length, at, first: options[0] };
}

async function onScreen(page, path) {
  const deadline = Date.now() + 6_000;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await page.evaluate((wanted) => {
      const active = document.activeElement;
      const path = active?.getAttribute("data-draft-path") ?? null;
      const ring = active?.closest("[data-found]");
      const rect = active?.getBoundingClientRect();
      const visible = rect ? rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 0 : false;
      return { path, ringed: Boolean(ring), visible, top: rect ? Math.round(rect.top) : null, hash: location.hash, wanted };
    }, path);
    if ((path === null ? seen.path !== null : seen.path === path) && seen.ringed && seen.visible) return seen;
    await pause(60);
  }
  throw new Error(`the setting ${path} was not on screen, focused and ringed: ${JSON.stringify(seen)}`);
}

async function snap(page, run, name) {
  if (run === 1) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function firstAdvanced(type) {
  const state = await stored();
  const driver = state.drivers.find((each) => each.type === type);
  return driver.fields.find((field) => field.group === "advanced" && !field.secret && field.type !== "boolean");
}

const checks = {
  async "every field: a backend's secret, and a folded field, from the overview"({ run }) {
    const page = await tab();
    await open(page, "");
    const secret = await choose(page, "proxmox token secret", "API token secret");
    await page.waitForURL(/#backend\/proxmox-lxc$/);
    const seen = await onScreen(page, "backends/proxmox-lxc/fields/token-secret");
    await snap(page, run, "live-secret");
    const advanced = await firstAdvanced("proxmox-lxc");
    await open(page, "");
    const folded = await choose(page, `proxmox ${advanced.label}`, advanced.label);
    await page.waitForURL(/#backend\/proxmox-lxc$/);
    const unfolded = await onScreen(page, `backends/proxmox-lxc/fields/${advanced.key}`);
    await snap(page, run, "live-folded");
    await page.context().close();
    return { secret: { ...secret, top: seen.top }, folded: { label: advanced.label, ...folded, top: unfolded.top } };
  },

  async "a Mac's own field, from the overview"({ run }) {
    const page = await tab();
    await open(page, "");
    const picked = await choose(page, "mac-1 cores", "Cores of a shared iOS host on mac-1");
    await page.waitForURL(/#backend\/tart$/);
    const seen = await onScreen(page, "backends/tart/hosts/mac-1/fields/ios-hosts-cores");
    const expanded = await page.getByRole("button", { name: "mac-1", exact: true }).getAttribute("aria-expanded");
    expect(expanded === "true", "mac-1 is open");
    await snap(page, run, "live-mac-field");
    await page.context().close();
    return { ...picked, top: seen.top, expanded };
  },

  async "a kind's size, by several words, from the overview"({ run }) {
    const page = await tab();
    await open(page, "");
    const picked = await choose(page, "linux desktop gpu medium ram", "Medium size");
    await page.waitForURL(/#kind\/linux-desktop$/);
    const seen = await onScreen(page, "kinds/linux-desktop/presets/medium/memoryGiB");
    await snap(page, run, "live-kind-size");
    await open(page, "");
    const off = await choose(page, "turn off monitor", "Machine status");
    await page.waitForURL(/#option\/monitor$/);
    const switched = await onScreen(page, "monitor/enabled");
    const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
    expect(role === "switch", "Machine status's switch is focused");
    await page.context().close();
    return { size: { ...picked, top: seen.top }, monitor: { ...off, top: switched.top, role } };
  },

  async "the Configuration page's export and import"({ run }) {
    const page = await tab();
    await open(page, "#kind/linux");
    const exported = await choose(page, "export json", "Export");
    await page.waitForURL(/#option\/configuration$/);
    const exportSeen = await onScreen(page, "configuration/export");
    await snap(page, run, "live-export");
    const imported = await choose(page, "import file", "Import");
    expect(new URL(page.url()).hash === "#option/configuration", "the page stayed");
    const importSeen = await onScreen(page, "import/open");
    await page.context().close();
    return { export: { ...exported, top: exportSeen.top }, import: { ...imported, top: importSeen.top } };
  },

  async "no match"({ run }) {
    const page = await tab();
    await open(page, "");
    await typeQuery(page, "zebra quartz");
    const said = await page.getByText(/^No setting matches “zebra quartz”/).textContent();
    expect((await page.getByRole("listbox").count()) === 0, "no list");
    const announced = await page.getByRole("status").filter({ hasText: /^No setting matches$/ }).count();
    expect(announced === 1, "the count is announced");
    await snap(page, run, "live-no-match");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    expect(new URL(page.url()).hash === "", "Enter opened nothing");
    await page.keyboard.press("Escape");
    expect((await findField(page).inputValue()) === "", "Escape cleared");
    await page.context().close();
    return { said };
  },

  async "from the target's own page"({ run }) {
    const page = await tab();
    const advanced = await firstAdvanced("proxmox-lxc");
    await open(page, "#backend/proxmox-lxc");
    const hidden = await page.locator(`[data-draft-path="backends/proxmox-lxc/fields/${advanced.key}"]`).count();
    expect(hidden === 0, "the field starts folded");
    await page.evaluate(() => (document.scrollingElement ?? document.documentElement).scrollTo({ top: 0 }));
    const picked = await choose(page, advanced.label, advanced.label, "Proxmox LXC");
    expect(new URL(page.url()).hash === "#backend/proxmox-lxc", "the page stayed");
    const seen = await onScreen(page, `backends/proxmox-lxc/fields/${advanced.key}`);
    await snap(page, run, "live-same-page");
    await open(page, "#backend/tart");
    const mac = await choose(page, "mac-1 address", "Address on mac-1");
    expect(new URL(page.url()).hash === "#backend/tart", "the page stayed");
    const macSeen = await onScreen(page, "backends/tart/hosts/mac-1/fields/address");
    await page.context().close();
    return { folded: { label: advanced.label, ...picked, top: seen.top }, mac: { ...mac, top: macSeen.top } };
  },

  async "arrow keys at the end of the list"({ run }) {
    const page = await tab();
    await open(page, "");
    await typeQuery(page, "linux");
    const many = await optionsShown(page);
    const header = await page.getByText(/listed; add a word to narrow them$/).textContent();
    for (let step = 0; step < many.length + 10; step += 1) await page.keyboard.press("ArrowDown");
    const last = await page.evaluate(() => {
      const field = document.activeElement;
      const option = document.getElementById(field.getAttribute("aria-activedescendant"));
      const list = option.closest("[role=listbox]");
      const options = [...list.querySelectorAll("[role=option]")];
      const box = option.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      return { at: options.indexOf(option), of: options.length, selected: option.getAttribute("aria-selected"), inView: box.top >= frame.top && box.bottom <= frame.bottom + 1 };
    });
    expect(last.at === last.of - 1 && last.selected === "true" && last.inView, `ArrowDown stopped at the last shown, in view: ${JSON.stringify(last)}`);
    await snap(page, run, "live-arrow-end");
    for (let step = 0; step < many.length + 10; step += 1) await page.keyboard.press("ArrowUp");
    const first = await page.evaluate(() => {
      const option = document.getElementById(document.activeElement.getAttribute("aria-activedescendant"));
      return [...option.parentElement.children].indexOf(option);
    });
    expect(first === 0, "ArrowUp stopped at the first");
    await typeQuery(page, "mac-1");
    const few = await optionsShown(page);
    for (let step = 0; step < few.length + 5; step += 1) await page.keyboard.press("ArrowDown");
    const lastFew = await page.evaluate(() => {
      const option = document.getElementById(document.activeElement.getAttribute("aria-activedescendant"));
      return [...option.parentElement.children].indexOf(option);
    });
    expect(lastFew === few.length - 1, `ArrowDown stopped at ${lastFew} of ${few.length}`);
    await page.context().close();
    return { many: many.length, header, last, few: few.length, lastFew };
  },

  async "keyboard only, and the query kept on return"({ run }) {
    const page = await tab();
    await open(page, "");
    await page.locator("body").click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.evaluate(() => document.activeElement?.blur());
    let stops = 0;
    for (; stops < 80; stops += 1) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "Find a setting")) break;
    }
    expect(stops < 80, "Tab reached Find");
    await page.keyboard.type("templates proxmox");
    await pause(150);
    const options = await optionsShown(page);
    await page.keyboard.press("ArrowDown");
    const second = options[1];
    await page.keyboard.press("Enter");
    await page.waitForURL(/#backend\/proxmox-lxc$/);
    const seen = (await onScreen(page, null)).path;
    let back = 0;
    for (; back < 40; back += 1) {
      await page.keyboard.press("Shift+Tab");
      if (await page.evaluate(() => document.activeElement?.textContent?.trim() === "BB Box settings")) break;
    }
    expect(back < 40, "Shift+Tab reached BB Box settings");
    await page.keyboard.press("Enter");
    await page.waitForURL((url) => url.hash === "");
    await pause(500);
    const kept = await page.evaluate(() => ({ focused: document.activeElement?.getAttribute("aria-label"), value: document.activeElement?.value }));
    expect(kept.focused === "Find a setting" && kept.value === "templates proxmox", `back on the overview: ${JSON.stringify(kept)}`);
    await snap(page, run, "live-query-kept");
    await page.goForward();
    await page.waitForURL(/#backend\/proxmox-lxc$/);
    await page.goBack();
    await page.waitForURL((url) => url.hash === "");
    await pause(500);
    const browserBack = await findField(page).inputValue();
    expect(browserBack === "templates proxmox", "the query is kept after the browser's back");
    const animations = await page.evaluate(() => document.getAnimations().map((animation) => animation.effect?.target?.getAttribute?.("data-setting-row") ?? animation.effect?.target?.tagName));
    await page.context().close();
    return { stops: stops + 1, opened: second, focused: seen, shiftTabs: back + 1, kept, browserBack, animations };
  },
};

const results = {};
for (const [name, check] of Object.entries(checks)) {
  if (chosen.length && !chosen.some((word) => name.includes(word))) continue;
  results[name] = [];
  for (let run = 1; run <= runs; run += 1) {
    await reset(run);
    try {
      results[name].push({ run, ok: true, ...(await check({ run })) });
      console.log(`ok   ${name} (run ${run})`);
    } catch (caught) {
      results[name].push({ run, ok: false, error: String(caught?.message ?? caught) });
      console.log(`FAIL ${name} (run ${run}): ${caught?.message ?? caught}`);
    }
  }
}
writeFileSync(join(shots, `results-${Date.now()}.json`), JSON.stringify(results, null, 2));
await browser.close();
const failed = Object.values(results).flat().filter((result) => !result.ok).length;
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
