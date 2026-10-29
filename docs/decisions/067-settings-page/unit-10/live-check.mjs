import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const cli = process.env.LIVE_BB_CLI ?? join(process.env.HOME ?? "", "bbc.sh");
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const chosen = process.argv.slice(2);
mkdirSync(shots, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const GET = "**/api/v1/plugins/bb-box/rpc/config.get";
const COPY_KEY = "config/migrated-from-bb-settings";
const FILE = ".cfg/live-import.json";

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

async function elsewhere(change) {
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await stored();
    const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
    if (result.ok) return result.state;
    if (result.reason === "problems") throw new Error(`the save made elsewhere was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("the save made elsewhere could not be made");
}

function bb(...args) {
  return execFileSync(cli, args, { encoding: "utf8" });
}

function database(write = false) {
  return new DatabaseSync(join(dataDir, "bb.db"), { readOnly: !write });
}

function storedSecrets() {
  const db = database();
  try {
    const row = db.prepare("select value from plugin_kv where plugin_id = 'bb-box' and key = 'config/secrets'").get();
    return row ? JSON.parse(row.value) : {};
  } finally {
    db.close();
  }
}

function keepCopy(at) {
  const db = database(true);
  try {
    const value = JSON.stringify({ at, version: "0.1.9", values: { "boxes-per-thread": 0, "enrol-boxes": true, "hetzner-token": { set: false } }, notes: [] });
    const columns = db.prepare("pragma table_info(plugin_kv)").all().map((column) => column.name);
    const now = Date.now();
    const extra = columns.filter((name) => !["plugin_id", "key", "value"].includes(name));
    const names = ["plugin_id", "key", "value", ...extra];
    const values = ["bb-box", COPY_KEY, value, ...extra.map((name) => (/at$/i.test(name) ? now : null))];
    db.prepare(`insert or replace into plugin_kv (${names.join(", ")}) values (${names.map(() => "?").join(", ")})`).run(...values);
  } finally {
    db.close();
  }
}

const secretWords = (run) => ({ token: `made-up-token-${run}-Aq7`, newToken: `made-up-token-${run}-Zp3`, content: `made-up-content-${run}-Lm2`, newContent: `made-up-content-${run}-Rk9`, key: `-----BEGIN OPENSSH PRIVATE KEY-----\nmade-up-key-${run}-Wd5\n-----END OPENSSH PRIVATE KEY-----\n` });

async function reset(run) {
  const words = secretWords(run);
  await elsewhere((document) => ({
    ...document,
    backends: [{ id: "hetzner", type: "hetzner", enabled: false, fields: { token: words.token } }],
    general: { files: [{ path: FILE, content: words.content }] },
    monitor: {},
  }));
}

const browser = await chromium.launch();

async function tab(viewport = { width: 1440, height: 1000 }, colorScheme = "light") {
  const context = await browser.newContext({ viewport, colorScheme, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const applies = [];
  let appliesHeld = null;
  await page.route(APPLY, async (route) => {
    applies.push(JSON.parse(route.request().postData() ?? "null"));
    if (appliesHeld) await appliesHeld;
    await route.continue();
  });
  let readsHeld = null;
  await page.route(GET, async (route) => {
    if (readsHeld) await readsHeld;
    await route.continue();
  });
  page.on("dialog", (dialog) => void dialog.accept());
  const hold = (set) => {
    const held = gate();
    set(held.promise);
    return () => {
      set(null);
      held.open();
    };
  };
  return {
    page,
    context,
    applies,
    holdReads: () => hold((value) => (readsHeld = value)),
    holdApplies: () => hold((value) => (appliesHeld = value)),
  };
}

let onboardingSkipped = false;

const heading = (page, title) => page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title}`) });

async function open(page, hash = "#option/configuration", title = "Configuration") {
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

const importBar = (page) => page.getByRole("region", { name: "Apply the import" });
const importText = (page) => page.getByRole("textbox", { name: "Import a configuration" });
const changeList = (page) => page.getByRole("region", { name: /^What it changes against revision \d+/ });

async function barSays(page, pattern, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    const result = page.locator('[data-draft-path="import/result"]');
    const said = (await result.count()) ? result : importBar(page).getByRole("status").first();
    text = (await said.textContent({ timeout: 1_000 }).catch(() => "")) ?? "";
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
  if (run === 1) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
}

async function storageText(page) {
  return page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
}

async function noSecretIn(page, secrets, where) {
  const kept = await storageText(page);
  const shown = await page.evaluate(() => document.body.innerText);
  for (const secret of secrets) {
    expect(!kept.includes(secret.split("\n")[0]) && !kept.includes(secret), `no pasted secret is in browser storage (${where})`);
    expect(!shown.includes(secret.split("\n")[1] ?? secret), `no pasted secret is shown outside the editor (${where})`);
  }
}

async function startImport(page) {
  await page.getByRole("button", { name: "Import…" }).click();
  await importText(page).waitFor();
  await waitFor(() => page.evaluate(() => document.activeElement?.id === "settings-import-text"), "focus in the import's text");
}

async function check(page, text) {
  await importText(page).fill(text);
  await page.getByRole("button", { name: /^Check( again)?$/ }).click();
}

async function exportedFile(page) {
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download" }).click()]);
  return { name: download.suggestedFilename(), text: readFileSync(await download.path(), "utf8") };
}

const checks = {
  async "export, change, import against a moved revision"({ run }) {
    const words = secretWords(run);
    const { page, holdReads } = await tab();
    await open(page);
    const exported = await exportedFile(page);
    const shown = bb("box", "config", "show", "--json");
    expect(exported.text.trim() === shown.trim(), "the download is what bb box config show --json prints");
    expect(!exported.text.includes(words.token) && !exported.text.includes(words.content), "the export has no secret in it");
    const give = (await page.getByText(/^To set BB Box up from it, give/).locator("..").textContent()).trim();
    expect(give.includes("Hetzner Cloud: the API token") && give.includes(`Files for every box: the content of ~/${FILE}`), `the export says which secrets to give again: ${give}`);

    const file = JSON.parse(exported.text);
    file.monitor = { refreshIntervalSeconds: 15 };
    file.general.boxesPerThread = 2;
    file.backends[0].fields.token = words.newToken;
    file.general.files[0].content = words.newContent;
    await startImport(page);
    await check(page, JSON.stringify(file, null, 2));
    const list = changeList(page);
    await list.waitFor();
    const listed = (await list.textContent()).trim();
    for (const part of ["Monitor", "Refresh every", "5 s", "15 s", "Boxes", "Boxes per thread", "Hetzner Cloud", "The API token", "A new value (not shown)", `~/${FILE}`, "New content (not shown)"]) expect(listed.includes(part), `the change list has ${part}: ${listed}`);
    expect(await page.getByRole("region", { name: /^What it changes against revision \d+: 4 changes$/ }).count(), "four changes");
    await noSecretIn(page, [words.newToken, words.newContent, words.token, words.content], "checked");
    await snap(page, run, "live-import-checked");

    const release = holdReads();
    const moved = await elsewhere((document) => ({ ...document, monitor: { ...document.monitor, backgroundMonitoring: true } }));
    await importBar(page).getByRole("button", { name: "Apply", exact: true }).click();
    const said = await barSays(page, /^Applied at revision \d+, on top of a change made elsewhere\./);
    release();
    const after = await stored();
    expect(after.revision === moved.revision + 1, "one revision more than the change made elsewhere");
    expect(after.document.monitor?.refreshIntervalSeconds === 15 && after.document.general.boxesPerThread === 2, "the import's changes are stored");
    expect(after.document.monitor?.backgroundMonitoring === true, "the change made elsewhere after the check is kept, not reverted by the file");
    const secrets = storedSecrets();
    expect(secrets.hetzner?.token === words.newToken && secrets["@general"]?.[`file:${FILE}`] === words.newContent, "the new token and content are stored");
    await waitFor(async () => !(await importText(page).count()), "the import to close once applied");
    await noSecretIn(page, [words.newToken, words.newContent], "applied");
    await snap(page, run, "live-import-applied");

    await startImport(page);
    const next = JSON.parse(bb("box", "config", "show", "--json"));
    next.monitor.refreshIntervalSeconds = 30;
    await check(page, JSON.stringify(next));
    await changeList(page).waitFor();
    await elsewhere((document) => ({ ...document, monitor: { ...document.monitor, refreshIntervalSeconds: 40 } }));
    const conflict = page.getByText("Changed elsewhere to 40 s while you edited.");
    await conflict.waitFor();
    const barNow = await barSays(page, /^A setting the import changes was changed elsewhere after you checked it\./);
    expect(await importBar(page).getByRole("button", { name: "Apply", exact: true }).isDisabled(), "Apply waits for a choice");
    await snap(page, run, "live-import-conflict");
    await page.getByRole("button", { name: "Keep mine" }).click();
    await importBar(page).getByRole("button", { name: "Apply", exact: true }).click();
    await barSays(page, /^Applied\./);
    expect((await stored()).document.monitor?.refreshIntervalSeconds === 30, "Keep mine applied the import's value");
    await page.context().close();
    return { file: exported.name, moved: said, conflict: barNow };
  },

  async "G8 import-newer-typing"({ run }) {
    const { page, holdApplies } = await tab();
    await open(page);
    const file = JSON.parse(bb("box", "config", "show", "--json"));
    file.monitor = { ...file.monitor, refreshIntervalSeconds: 15 };
    const text = JSON.stringify(file, null, 2);
    await startImport(page);
    await check(page, text);
    await changeList(page).waitFor();
    const before = await stored();
    const release = holdApplies();
    await importBar(page).getByRole("button", { name: "Apply", exact: true }).click();
    await barSays(page, /^Applying…/);
    const newer = text.replace('"refreshIntervalSeconds": 15', '"refreshIntervalSeconds": 20');
    await importText(page).fill(newer);
    release();
    const said = await barSays(page, /^Applied\. Your newer text is not applied yet\./);
    const after = await stored();
    expect(after.document.monitor?.refreshIntervalSeconds === 15, `15 is stored: ${after.document.monitor?.refreshIntervalSeconds}`);
    expect(after.revision === before.revision + 1, "one revision more");
    expect((await importText(page).inputValue()) === newer, "the editor stays open with 20");
    expect(!(await changeList(page).count()), "the newer text's changes are not listed until it is checked");
    expect((await page.getByRole("button", { name: "Check", exact: true }).count()) === 1, "the newer text can be checked");
    await snap(page, run, "live-g8");
    await page.context().close();
    return { said };
  },

  async "G9 import-secret-storage"({ run }) {
    const words = secretWords(run);
    const { page } = await tab();
    await open(page);
    const file = JSON.parse(bb("box", "config", "show", "--json"));
    file.backends[0].fields.token = words.newToken;
    file.backends.push({ id: "hetzner:second", type: "hetzner", enabled: false, fields: { token: words.token, "ssh-from": words.key } });
    file.general.files[0].content = words.newContent;
    await startImport(page);
    await importText(page).fill(JSON.stringify(file, null, 2));
    await pause(300);
    const pasted = [words.newToken, words.key, words.newContent, words.token];
    const kept = await storageText(page);
    for (const secret of pasted) expect(!kept.includes(secret.split("\n")[1] ?? secret), "valid text: nothing pasted is in browser storage");
    await page.reload({ waitUntil: "domcontentloaded" });
    await heading(page, "Configuration").waitFor();
    const note = page.getByText("The configuration you pasted was not kept, as it may hold secrets; paste it again.");
    await note.waitFor();
    expect((await importText(page).inputValue()) === "", "the page asks for the text again");
    const afterReload = await storageText(page);
    for (const secret of pasted) expect(!afterReload.includes(secret.split("\n")[1] ?? secret), "after the reload, nothing pasted is in browser storage");
    await snap(page, run, "live-g9-valid");

    await page.getByRole("button", { name: "Discard them" }).click();
    await startImport(page);
    const broken = `{"backends": [{"id": "hetzner", "fields": {"token": "${words.newToken}"}}], "general": {"files": [{"content": "${words.newContent}" ${words.key.replace(/\n/g, " ")}`;
    await importText(page).fill(broken);
    await pause(300);
    const keptBroken = await storageText(page);
    for (const secret of [words.newToken, words.newContent, `made-up-key-${run}`]) expect(!keptBroken.includes(secret), "text that is not JSON: nothing pasted is in browser storage");
    await page.reload({ waitUntil: "domcontentloaded" });
    await heading(page, "Configuration").waitFor();
    await note.waitFor();
    expect((await importText(page).inputValue()) === "", "the page asks for the text again");
    const afterBroken = await storageText(page);
    for (const secret of [words.newToken, words.newContent, `made-up-key-${run}`]) expect(!afterBroken.includes(secret), "after the reload, nothing pasted is in browser storage");
    expect(afterBroken.includes("import/text"), "the page remembers only that there was text to paste again");
    await snap(page, run, "live-g9-broken");
    await page.getByRole("button", { name: "Discard them" }).click();
    await page.context().close();
    return { storage: afterBroken.slice(0, 200) };
  },

  async "the kept copy removed after its confirmation"({ run }) {
    keepCopy(Date.now() - 86_400_000 * (3 + run));
    expect(/moved these BB settings/.test(bb("box", "config", "migrated")), "bb box config migrated shows the copy");
    const { page } = await tab();
    await open(page);
    await page.getByText("Settings moved from BB").waitFor();
    await page.getByRole("button", { name: "Remove copy…" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Remove the copy of BB's earlier settings?" });
    await dialog.waitFor();
    await snap(page, run, "live-copy-confirm");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect((await stored()).migrated !== null, "Cancel keeps the copy");
    await page.getByRole("button", { name: "Remove copy…" }).click();
    await dialog.getByRole("button", { name: "Remove copy" }).click();
    await page.getByText("Removed the copy of BB's earlier settings.").waitFor();
    await waitFor(async () => !(await page.getByText("Settings moved from BB").count()), "the row to go");
    expect((await stored()).migrated === null, "the copy is gone");
    expect(/There is no copy/.test(bb("box", "config", "migrated")), "bb box config migrated says there is no copy");
    const focused = await page.evaluate(() => document.activeElement?.textContent);
    expect(focused === "Removed the copy of BB's earlier settings.", `focus on the result: ${focused}`);
    await snap(page, run, "live-copy-removed");
    await page.context().close();
    return { focused };
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
        for (const page of context.pages()) await page.screenshot({ path: join(shots, `failed-${name.replace(/[^a-z0-9]+/gi, "-")}-${run}.png`), fullPage: true }).catch(() => {});
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
