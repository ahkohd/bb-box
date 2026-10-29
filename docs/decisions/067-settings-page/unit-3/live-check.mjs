import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const side = process.env.LIVE_SIDE ?? "linux";
const chosen = process.argv.slice(2);
mkdirSync(shots, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const GET = "**/api/v1/plugins/bb-box/rpc/config.get";
const CHECK = "**/api/v1/plugins/bb-box/rpc/config.check";

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function gate() {
  let open = () => {};
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
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
    if (result.reason === "problems") throw new Error(`the other tab's save was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("the other tab could not save");
}

function storedSecret(backend, key) {
  const db = new DatabaseSync(join(dataDir, "bb.db"), { readOnly: true });
  try {
    const row = db.prepare("select value from plugin_kv where plugin_id = 'bb-box' and key = 'config/secrets'").get();
    return (row ? JSON.parse(row.value) : {})[backend]?.[key];
  } finally {
    db.close();
  }
}

const backendIn = (state, id) => state.document.backends.find((backend) => backend.id === id);
const setMonitor = (patch) => (document) => ({ ...document, monitor: { ...document.monitor, ...patch } });

async function resetLinux(run) {
  for (const machine of (await rpc("machines.list")).machines) await rpc("machines.remove", { box: machine.box.id, force: true }).catch(() => {});
  await otherTab((document) => {
    const { monitor: _monitor, ...rest } = document;
    return {
      ...rest,
      backends: [
        { id: "docker", type: "docker", enabled: true, fields: {} },
        { id: "proxmox-lxc", type: "proxmox-lxc", enabled: false, fields: { url: "https://127.0.0.1:9", "token-id": "bb-box@pve!made-up", "token-secret": `made-up-start-${run}` } },
      ],
    };
  });
}

async function resetMac() {
  await otherTab((document) => {
    const tart = document.backends.find((backend) => backend.id === "tart");
    const mac = tart.hosts.find((host) => host.name === "mac-1");
    const { monitor: _monitor, ...rest } = document;
    return { ...rest, backends: [{ id: "tart", type: "tart", enabled: true, fields: {}, hosts: [{ name: "mac-1", enabled: true, fields: { address: mac.fields.address, user: mac.fields.user, "host-keys": mac.fields["host-keys"] } }] }] };
  });
}

const browser = await chromium.launch();

async function tab(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const applies = [];
  const applyHandlers = [];
  const checks = [];
  await page.route(APPLY, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "null");
    applies.push(body);
    const handler = applyHandlers.shift();
    if (handler) await handler(route, body);
    else await route.continue();
  });
  await page.route(CHECK, async (route) => {
    checks.push(JSON.parse(route.request().postData() ?? "null"));
    await route.continue();
  });
  let readsHeld = null;
  await page.route(GET, async (route) => {
    if (readsHeld) await readsHeld;
    await route.continue();
  });
  page.on("dialog", (dialog) => void dialog.accept());
  return {
    page,
    context,
    applies,
    applyHandlers,
    checks,
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

async function open(page, hash, title) {
  const url = `${base}/settings/plugins/bb-box${hash}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!onboardingSkipped) {
    const skip = page.getByRole("button", { name: "Skip setup" });
    await Promise.race([skip.waitFor({ timeout: 6_000 }).catch(() => {}), page.locator("[data-page-heading]").first().waitFor({ timeout: 6_000 }).catch(() => {})]);
    if (await skip.count()) {
      await skip.click();
      await pause(500);
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    onboardingSkipped = true;
  }
  await heading(page, title).waitFor();
}

const heading = (page, title) => page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });

async function leaveBySidebar(page) {
  await page.getByRole("link", { name: "General", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/plugins/bb-box"));
}

const bar = (page, what) => page.getByRole("region", { name: `Save ${what}` });
const field = (page, name) => page.getByRole("textbox", { name, exact: true });
const row = (page, path) => page.locator(`[data-setting-row="${path}"]`);

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

async function waitFor(check, what, timeout = 30_000) {
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

async function save(page, what) {
  await bar(page, what).getByRole("button", { name: "Save", exact: true }).click();
}

async function replaceSecret(page, label, text) {
  const input = page.getByLabel(`New ${label}`, { exact: true });
  if (!(await input.count())) await page.getByRole("button", { name: `Replace the ${label}` }).click();
  await input.fill(text);
  return input;
}

async function openMenu(page, label) {
  await page.getByRole("button", { name: `More for ${label}` }).click();
  return page.getByRole("menu");
}

const receiptsOf = (state, operation) => state.receipts.filter((receipt) => receipt.operation === operation);

async function boxesOn(id) {
  const state = await stored();
  return state.backends.find((backend) => backend.id === id)?.boxes ?? 0;
}

async function macHostKeys() {
  return backendIn(await stored(), "tart").hosts.find((host) => host.name === "mac-1").fields["host-keys"];
}

async function addMac(page, name, { address = "127.0.0.1", user = "admin", keys } = {}) {
  await page.getByRole("button", { name: "Add Mac" }).click();
  const nameField = field(page, "Name of the new Mac");
  await nameField.waitFor();
  await waitFor(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-draft-path") ?? "")).endsWith("/name"), "focus on the new Mac's name");
  await nameField.fill(name);
  await field(page, `Address on ${name}`).fill(address);
  await field(page, `User on ${name}`).fill(user);
  await field(page, `Host keys on ${name}`).fill(keys ?? (await macHostKeys()));
  return nameField;
}

async function macRowOpen(page, name) {
  const button = page.getByRole("button", { name: new RegExp(`^${name}`) }).first();
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
}

const linuxChecks = {
  async "a Docker backend edited, refused and saved"({ run }) {
    const { page, applies } = await tab();
    await open(page, "#backend/docker", "Docker");
    const before = await stored();
    await page.getByRole("button", { name: /^Show Advanced/ }).click();
    await field(page, "Most boxes").fill("lots");
    await field(page, "Host").fill("tcp://192.0.2.1:2375");
    await field(page, "Most boxes").press("Enter");
    const refused = await barSays(bar(page, "Docker"), /^Not saved: fix the 2 fields marked\. Your changes are still here\./);
    const boxesProblem = await row(page, "backends/docker/fields/boxes").getByRole("alert").textContent();
    const hostProblem = await row(page, "backends/docker/fields/host").getByRole("alert").textContent();
    expect((await field(page, "Most boxes").getAttribute("aria-invalid")) === "true" && (await field(page, "Host").getAttribute("aria-invalid")) === "true", "both fields are marked invalid");
    expect((await stored()).revision === before.revision, "nothing was stored");
    await snap(page, run, "live-docker-refused");
    await field(page, "Most boxes").fill(String(10 + run));
    await field(page, "Host").fill("");
    await page.getByRole("checkbox", { name: "Offer Wayland desktop image" }).uncheck();
    await bar(page, "Docker").getByRole("button", { name: /^Save/ }).click();
    const saved = await barSays(bar(page, "Docker"), /^Saved\./);
    const after = await stored();
    const docker = backendIn(after, "docker");
    expect(docker.fields.boxes === 10 + run, `Most boxes is stored as ${docker.fields.boxes}`);
    expect(docker.fields["wayland-desktop-image"] === "", "the image turned off is stored empty");
    expect(docker.fields.host === undefined, "the host is left out");
    expect(receiptsOf(after, applies.at(-1).operation).length === 1, "the save has its receipt");
    expect(new URL(page.url()).hash === "#backend/docker", "the page stays on the backend");
    await snap(page, run, "live-docker-saved");
    await page.reload({ waitUntil: "domcontentloaded" });
    await heading(page, "Docker").waitFor();
    expect(!(await page.getByRole("checkbox", { name: "Offer Wayland desktop image" }).isChecked()), "after a reload the image is still off");
    expect((await field(page, "Wayland desktop image").getAttribute("placeholder")) === "Off", "and its field says Off");
    await page.context().close();
    return { refused, problems: [boxesProblem, hostProblem], saved, stored: { boxes: docker.fields.boxes, wayland: docker.fields["wayland-desktop-image"] } };
  },

  async "a secret replaced in two tabs"({ run }) {
    const a = await tab();
    const b = await tab();
    await open(a.page, "#backend/proxmox-lxc", "Proxmox LXC");
    await open(b.page, "#backend/proxmox-lxc", "Proxmox LXC");
    await replaceSecret(a.page, "API token secret", `made-up-a-${run}`);
    await replaceSecret(b.page, "API token secret", `made-up-b-${run}`);
    await save(b.page, "Proxmox LXC");
    await barSays(bar(b.page, "Proxmox LXC"), /^Saved\./);
    const replaced = a.page.getByText(/^Replaced elsewhere while you edited, at revision \d+\. Saving yours replaces that one\./);
    await replaced.waitFor();
    const note = await replaced.textContent();
    const revision = (await stored()).revision;
    expect(note.includes(`at revision ${revision}.`), `the note names revision ${revision}: ${note}`);
    const waits = await barSays(bar(a.page, "Proxmox LXC"), /changed elsewhere too\. Choose for each, then save\./);
    expect(storedSecret("proxmox-lxc", "token-secret") === `made-up-b-${run}`, "B's secret is stored");
    await snap(a.page, run, "live-secret-conflict");
    await a.page.getByRole("button", { name: "Keep mine" }).click();
    await save(a.page, "Proxmox LXC");
    const mine = await barSays(bar(a.page, "Proxmox LXC"), /^Saved\./);
    expect(storedSecret("proxmox-lxc", "token-secret") === `made-up-a-${run}`, "Keep mine stores A's secret");

    await replaceSecret(a.page, "API token secret", `made-up-c-${run}`);
    await replaceSecret(b.page, "API token secret", `made-up-d-${run}`);
    await save(b.page, "Proxmox LXC");
    await barSays(bar(b.page, "Proxmox LXC"), /^Saved\./);
    await a.page.getByText(/^Replaced elsewhere while you edited/).waitFor();
    await a.page.getByRole("button", { name: "Keep the saved one" }).click();
    await waitFor(async () => !(await a.page.getByLabel("New API token secret", { exact: true }).count()), "A's typed secret to go");
    expect(storedSecret("proxmox-lxc", "token-secret") === `made-up-d-${run}`, "Keep the saved one leaves D stored");
    const html = await a.page.content();
    expect(!html.includes(`made-up-c-${run}`) && !html.includes(`made-up-d-${run}`), "no secret is in the page");
    await a.context.close();
    await b.context.close();
    return { conflict: note, bar: waits, keepMine: mine };
  },

  async "G1 retry-submitted-version with a secret"({ run }) {
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#backend/proxmox-lxc", "Proxmox LXC");
    const input = await replaceSecret(page, "API token secret", `made-up-g1a-${run}`);
    const held = gate();
    const second = gate();
    applyHandlers.push(async (route) => {
      await otherTab(setMonitor({ refreshIntervalSeconds: 9 + run }));
      await route.continue();
    });
    applyHandlers.push(async (route) => {
      second.open();
      await held.promise;
      await route.continue();
    });
    await save(page, "Proxmox LXC");
    await second.promise;
    await input.fill(`made-up-g1b-${run}`);
    held.open();
    const words = await barSays(bar(page, "Proxmox LXC"), /^Saved at revision \d+, on top of a change made elsewhere\. Your newer change is not saved yet\./);
    expect(storedSecret("proxmox-lxc", "token-secret") === `made-up-g1a-${run}`, "A is stored");
    expect(applies.length === 2 && applies[0].operation === applies[1].operation, "the retry is the same operation");
    expect(JSON.stringify(applies[0].submission) === JSON.stringify(applies[1].submission), "with the same submission");
    expect(!JSON.stringify(applies).includes(`made-up-g1b-${run}`), "B was never sent");
    expect((await input.inputValue()) === `made-up-g1b-${run}`, "B is still in the field");
    expect((await row(page, "backends/proxmox-lxc/fields/token-secret").getByText("Changed", { exact: true }).count()) === 1, "B is marked as an unsaved change");
    expect(!/Since then, changed elsewhere/.test(words), "the bar names nothing else");
    await snap(page, run, "live-g1-secret");
    await page.context().close();
    return { bar: words, operation: applies[0].operation };
  },

  async "remove refused with boxes and confirmed without"({ run }) {
    const { page, holdReads } = await tab();
    await open(page, "#backend/docker", "Docker");
    expect((await boxesOn("docker")) === 0, "the backend starts with no box");
    const releaseReads = holdReads();
    const made = await rpc("machines.add", { kind: "linux", on: "docker", name: `held-${run}` });
    expect(made.box && !made.error, `a box was made: ${made.error}`);
    await waitFor(async () => (await boxesOn("docker")) === 1, "the box to count");
    let menu = await openMenu(page, "Docker");
    await menu.getByRole("menuitem", { name: "Remove backend…" }).click();
    await page.getByRole("button", { name: "Remove backend", exact: true }).click();
    const refusal = page.getByText(/^Docker was not removed: /);
    await refusal.waitFor();
    const refused = await refusal.textContent();
    expect(/Backend docker has 1 box, so it cannot be removed or renamed\. Turn it off and release them first\./.test(refused), `the refusal says why: ${refused}`);
    expect(backendIn(await stored(), "docker"), "the backend is still stored");
    expect(new URL(page.url()).hash === "#backend/docker", "the page stays");
    await page.getByRole("alertdialog").waitFor({ state: "detached" });
    await snap(page, run, "live-remove-refused");
    releaseReads();
    await waitFor(async () => (await page.getByText("1 box", { exact: true }).count()) > 0, "the page to show the box");
    menu = await openMenu(page, "Docker");
    const disabled = menu.getByRole("menuitem", { name: "Remove: release its 1 box first" });
    expect((await disabled.getAttribute("aria-disabled")) === "true", "Remove is not offered while it has a box");
    await page.keyboard.press("Escape");
    await rpc("machines.remove", { box: made.box.id, force: true });
    await waitFor(async () => (await boxesOn("docker")) === 0, "the box to go", 120_000);
    await waitFor(async () => (await page.getByText("None", { exact: true }).count()) > 0, "the page to show no box");
    menu = await openMenu(page, "Docker");
    await menu.getByRole("menuitem", { name: "Remove backend…" }).click();
    const dialog = page.getByRole("alertdialog");
    const words = await dialog.textContent();
    await page.getByRole("button", { name: "Remove backend", exact: true }).click();
    await waitFor(async () => new URL(page.url()).hash === "", "the overview after the removal");
    expect(!backendIn(await stored(), "docker"), "the backend is gone");
    await page.context().close();
    return { refused, dialog: words };
  },
};

const macChecks = {
  async "a Tart backend with a real Mac's own sizes"({ run }) {
    const { page } = await tab();
    await open(page, "#backend/tart", "Tart");
    let estimates = null;
    await waitFor(async () => (estimates = (await stored()).backends.find((backend) => backend.id === "tart")?.hostEstimates?.["mac-1"] ?? null) !== null, "bb-box to have read mac-1", 90_000);
    await macRowOpen(page, "mac-1");
    const cores = field(page, "Cores of a shared iOS host on mac-1");
    await waitFor(async () => (await cores.getAttribute("placeholder")) === String(estimates["ios-hosts-cores"]), "the estimate inside the field");
    const coresRow = row(page, "backends/tart/hosts/mac-1/fields/ios-hosts-cores");
    const estimateWords = (await coresRow.getByText(/^Empty: /).textContent()).trim();
    expect(estimateWords === `Empty: ${estimates["ios-hosts-cores"]} cores, bb-box's estimate for mac-1`, `the estimate says ${estimateWords}`);
    await page.getByRole("button", { name: /^Show Shared iOS hosts/ }).click();
    await field(page, "Cores of a shared iOS host").fill("6");
    const fromTart = (await coresRow.getByText(/^Empty: /).textContent()).trim();
    expect(fromTart === "Empty: 6 cores, Tart's setting", `the Mac's field follows Tart's own: ${fromTart}`);
    await field(page, "Cores of a shared iOS host").fill("");
    await cores.fill("2");
    await field(page, "Memory of a shared iOS host (GiB) on mac-1").fill("8");
    await snap(page, run, "live-tart-own-sizes");
    await save(page, "Tart");
    const saved = await barSays(bar(page, "Tart"), /^Saved\./);
    const mac = backendIn(await stored(), "tart").hosts.find((host) => host.name === "mac-1");
    expect(mac.fields["ios-hosts-cores"] === 2 && mac.fields["ios-hosts-memory-gib"] === 8, `the Mac's own sizes are stored: ${JSON.stringify(mac.fields)}`);
    await waitFor(async () => (await page.getByText("127.0.0.1 · its own shared iOS host size", { exact: false }).count()) > 0, "the Mac's row to say it has its own size");
    await page.context().close();
    return { estimates, estimate: estimateWords, tartsSetting: fromTart, saved };
  },

  async "a Mac added by name, then removed"({ run }) {
    const { page, applies } = await tab();
    await open(page, "#backend/tart", "Tart");
    const name = `extra-${run}`;
    await addMac(page, name);
    await save(page, "Tart");
    const saved = await barSays(bar(page, "Tart"), /^Saved\./);
    const hosts = backendIn(await stored(), "tart").hosts;
    expect(hosts.some((host) => host.name === name && host.fields.address === "127.0.0.1"), `${name} is stored`);
    await page.getByRole("switch", { name: `Mac ${name}: takes new boxes` }).waitFor();
    expect(!(await page.content()).includes("@new-"), "no provisional identity is left in the page");
    await macRowOpen(page, name);
    await page.getByRole("button", { name: `Remove ${name}…` }).click();
    await page.getByRole("button", { name: "Remove when I save" }).click();
    await page.getByText("Removed when you save").waitFor();
    await save(page, "Tart");
    await barSays(bar(page, "Tart"), /^Saved\./);
    expect(!backendIn(await stored(), "tart").hosts.some((host) => host.name === name), `${name} is removed`);
    return { saved, operations: applies.map((apply) => apply.operation) };
  },

  async "Check with a Mac's change, cleared by a later edit"({ run }) {
    const { page, checks } = await tab();
    await open(page, "#backend/tart", "Tart");
    await macRowOpen(page, "mac-1");
    await field(page, "Cores of a shared iOS host on mac-1").fill("3");
    await page.getByRole("button", { name: "Check with my changes" }).click();
    const checked = page.getByText(/against your unsaved changes\. Nothing is saved yet\./);
    await checked.waitFor({ timeout: 60_000 });
    const sent = checks.at(-1);
    const mac = sent.draft.backends.find((backend) => backend.id === "tart").hosts.find((host) => host.name === "mac-1");
    expect(mac.fields["ios-hosts-cores"] === 3, `the check was of the Mac's change: ${JSON.stringify(mac.fields)}`);
    expect(sent.test === "tart", "and of this backend");
    const result = await page.getByRole("status").filter({ hasText: /with your changes|pass its checks|Could not check/ }).first().textContent();
    await snap(page, run, "live-check-with-mac-change");
    await field(page, "User on mac-1").fill("admin2");
    const cleared = page.getByText("Your form changed after you checked it, so that result was cleared. Check again.");
    await cleared.waitFor();
    expect(!(await checked.count()), "the result against the old form is gone");
    await snap(page, run, "live-check-cleared");
    const clearedWords = (await cleared.textContent()).trim();
    await page.context().close();
    return { result: result.trim(), cleared: clearedWords };
  },

  async "G6 new-mac-two-saves"({ run }) {
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#backend/tart", "Tart");
    const name = "review-mac";
    await addMac(page, name);
    const held = gate();
    const arrived = gate();
    applyHandlers.push(async (route) => {
      arrived.open();
      await held.promise;
      await route.continue();
    });
    await save(page, "Tart");
    await arrived.promise;
    expect(await field(page, `Name of the new Mac`).isDisabled(), "the name waits while its save is out");
    await field(page, `Cores of a shared iOS host on ${name}`).fill("8");
    held.open();
    const first = await barSays(bar(page, "Tart"), /^Saved\. Your newer change is not saved yet\./);
    const after = backendIn(await stored(), "tart").hosts.filter((host) => host.name === name);
    expect(after.length === 1 && after[0].fields["ios-hosts-cores"] === undefined, "the first save made review-mac without the newer cores");
    const session = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
    expect(!session.includes("@new-"), "no edit keeps an @new- identity after the save");
    await save(page, "Tart");
    const second = await barSays(bar(page, "Tart"), /^Saved\./);
    const hosts = backendIn(await stored(), "tart").hosts.filter((host) => host.name === name);
    expect(hosts.length === 1 && hosts[0].fields["ios-hosts-cores"] === 8, `one review-mac with 8 cores: ${JSON.stringify(hosts)}`);
    expect(applies.length === 2 && applies[0].operation !== applies[1].operation, "two saves, each its own operation");
    await snap(page, run, "live-g6");
    await page.context().close();
    return { first, second };
  },

  async "G7 new-mac-invalid-reveal"({ run }) {
    const { page, applies } = await tab();
    await open(page, "#backend/tart", "Tart");
    await addMac(page, "small-mac");
    await field(page, "Cores of a shared iOS host on small-mac").fill("1");
    await save(page, "Tart");
    const refused = await barSays(bar(page, "Tart"), /^Not saved: fix the field marked\. Your changes are still here\./);
    const cores = field(page, "Cores of a shared iOS host on small-mac");
    const problem = (await page.locator(`[data-setting-row$="/fields/ios-hosts-cores"]`).filter({ has: cores }).getByRole("alert").textContent()).trim();
    expect(/whole number from 2 to 64/.test(problem), `the error is under the new Mac's cores: ${problem}`);
    expect(!backendIn(await stored(), "tart").hosts.some((host) => host.name === "small-mac"), "nothing saved");
    await bar(page, "Tart").getByRole("button", { name: "Save again" }).focus();
    await bar(page, "Tart").getByRole("button", { name: "Show" }).click();
    await waitFor(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-draft-path") ?? "")).endsWith("/fields/ios-hosts-cores"), "Show to focus the new Mac's cores");
    await snap(page, run, "live-g7-show");
    const sent = applies.length;
    await cores.fill("4");
    await field(page, "Name of the new Mac").fill("mac-1");
    await bar(page, "Tart").getByRole("button", { name: /^Save/ }).click();
    const nameProblem = page.getByText("mac-1 is already a Mac on Tart.");
    await nameProblem.waitFor();
    expect(applies.length === sent, "the second is refused before anything is sent");
    expect((await field(page, "Name of the new Mac").getAttribute("aria-invalid")) === "true", "at its name field");
    await snap(page, run, "live-g7-name");
    await page.context().close();
    return { refused, problem, name: "mac-1 is already a Mac on Tart." };
  },
};

const checks = side === "mac" ? macChecks : linuxChecks;
const results = [];
const names = chosen.length ? Object.keys(checks).filter((name) => chosen.some((word) => name.startsWith(word))) : Object.keys(checks);
for (const name of names) {
  for (let run = 1; run <= runs; run += 1) {
    if (side === "mac") await resetMac();
    else await resetLinux(run);
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
writeFileSync(join(shots, `results-${side}.json`), JSON.stringify(results, null, 1));
await browser.close();
const failed = results.filter((result) => !result.pass).length;
console.log(`${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
