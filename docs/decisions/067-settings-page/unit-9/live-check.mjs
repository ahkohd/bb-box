import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const chosen = process.argv.slice(2);
mkdirSync(shots, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const GET = "**/api/v1/plugins/bb-box/rpc/config.get";
const CLIENT_ID = "tailnet:client-id";
const CLIENT_SECRET = "tailnet:client-secret";

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

const withGeneral = (patch) => (document) => ({ ...document, general: { ...document.general, ...patch } });

function storedSecret(key) {
  const db = new DatabaseSync(join(dataDir, "bb.db"), { readOnly: true });
  try {
    const row = db.prepare("select value from plugin_kv where plugin_id = 'bb-box' and key = 'config/secrets'").get();
    return (row ? JSON.parse(row.value) : {})["@general"]?.[key];
  } finally {
    db.close();
  }
}

async function reset(run) {
  await elsewhere((document) => {
    const { tailnet: _tailnet, iosEncoder: _encoder, encoderLedger: _ledger, testDevice: _test, ...general } = document.general;
    return { ...document, general };
  });
  return run;
}

async function withTailnet(run) {
  await elsewhere(withGeneral({ tailnet: { mode: "oauth", clientId: `made-up-id-${run}`, clientSecret: `made-up-secret-${run}` } }));
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
  page.on("dialog", (dialog) => void dialog.accept());
  return {
    page,
    context,
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

const heading = (page, title) => page.locator("[data-page-heading]").filter({ hasText: new RegExp(`^${title}`) });

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

async function leaveBySidebar(page) {
  await page.getByRole("link", { name: "General", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/plugins/bb-box"));
}

const tailnetBar = (page) => page.getByRole("region", { name: "Save the tailnet" });
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

const secretInput = (page, label) => page.locator(`input[type=password][aria-label="${label}"], input[type=password][aria-label="New ${label}"]`);

async function setSecret(page, label, text) {
  const input = secretInput(page, label);
  if (!(await input.count())) await page.getByRole("button", { name: new RegExp(`^(Set|Replace) the ${label}$`) }).click();
  await input.fill(text);
  return input;
}

async function storageText(page) {
  return page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }));
}

const receiptsOf = (state, operation) => state.receipts.filter((receipt) => receipt.operation === operation);

const checks = {
  async "the tailnet's choice and credentials saved together, refused part way"({ run }) {
    const { page, applies } = await tab();
    await open(page, "#option/network", "Network");
    const before = await stored();
    await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).check();
    await page.getByRole("textbox", { name: "Tags" }).fill("tag:bb-box, tag:ci-check");
    await setSecret(page, "OAuth client ID", `made-up-id-${run}`);
    const pending = await barSays(tailnetBar(page), /^3 changes to the tailnet not saved/);
    await tailnetBar(page).getByRole("button", { name: "Save", exact: true }).click();
    const refused = await barSays(tailnetBar(page), /^Not saved: fix the field marked\. Your changes are still here\./);
    const problem = (await row(page, "general/tailnet/clientSecret").getByRole("alert").textContent()).trim();
    expect(problem === "Set the Tailscale OAuth client's secret, as the guide shows.", `the reason is under the secret: ${problem}`);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-draft-path"));
    expect(focused === "general/tailnet/clientSecret", `focus went to the field it names: ${focused}`);
    const after = await stored();
    expect(after.revision === before.revision, "nothing was stored");
    expect(after.document.general.tailnet === undefined && storedSecret(CLIENT_ID) === undefined, "neither the choice nor the ID was stored");
    expect((await secretInput(page, "OAuth client ID").inputValue()) === `made-up-id-${run}`, "the pasted ID is still in its field");
    expect(await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).isChecked(), "the choice is still Yes");
    await snap(page, run, "live-tailnet-refused");

    await leaveBySidebar(page);
    await page.goBack();
    await heading(page, "Network").waitFor();
    expect(await secretInput(page, "OAuth client ID").count(), "the draft waited while the page was left");

    await setSecret(page, "OAuth client secret", `made-up-secret-${run}`);
    expect(!(await storageText(page)).includes("made-up"), "no pasted credential is in browser storage");
    await secretInput(page, "OAuth client secret").press("Enter");
    const saved = await barSays(tailnetBar(page), /^Saved\./);
    const now = await stored();
    expect(JSON.stringify(now.document.general.tailnet?.tags) === JSON.stringify(["tag:bb-box", "tag:ci-check"]), `the tags stored: ${JSON.stringify(now.document.general.tailnet)}`);
    expect(now.document.general.tailnet?.mode === "oauth", "the choice stored");
    expect(storedSecret(CLIENT_ID) === `made-up-id-${run}` && storedSecret(CLIENT_SECRET) === `made-up-secret-${run}`, "both credentials stored, in one save");
    expect(now.revision === before.revision + 1, `one revision for the whole form: ${before.revision} to ${now.revision}`);
    expect(applies.length === 2 && applies[0].operation !== applies[1].operation, "the refused save and the saved one are two operations");
    expect(receiptsOf(now, applies[1].operation).length === 1 && receiptsOf(now, applies[0].operation).length === 0, "only the saved one has a receipt");
    expect(!(await page.content()).includes("made-up-secret"), "the secret is not in the page");
    const sets = await page.getByText("Set", { exact: true }).count();
    expect(sets === 2, `both credentials say Set: ${sets}`);
    await snap(page, run, "live-tailnet-saved");
    await page.context().close();
    return { pending, refused, problem, saved, tags: now.document.general.tailnet.tags, revisions: [before.revision, now.revision] };
  },

  async "No deletes the saved credentials, and says so first"({ run }) {
    await withTailnet(run);
    const { page } = await tab();
    await open(page, "#option/network", "Network");
    await page.getByRole("radio", { name: "No: BB is reached without one" }).check();
    const warning = (await page.getByText("Saving No deletes the saved OAuth client ID and secret.").textContent()).trim();
    expect(storedSecret(CLIENT_SECRET) === `made-up-secret-${run}`, "nothing is deleted before Save");
    await tailnetBar(page).getByRole("button", { name: "Save", exact: true }).click();
    const saved = await barSays(tailnetBar(page), /^Saved\./);
    const now = await stored();
    expect(now.document.general.tailnet === undefined && storedSecret(CLIENT_ID) === undefined && storedSecret(CLIENT_SECRET) === undefined, "the choice and both credentials are gone");
    await page.context().close();
    return { warning, saved };
  },

  async "a tailnet secret replaced in two tabs"({ run }) {
    await withTailnet(run);
    const a = await tab();
    const b = await tab();
    await open(a.page, "#option/network", "Network");
    await open(b.page, "#option/network", "Network");
    await setSecret(a.page, "OAuth client secret", `made-up-a-${run}`);
    await setSecret(b.page, "OAuth client secret", `made-up-b-${run}`);
    await tailnetBar(b.page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(tailnetBar(b.page), /^Saved\./);
    const revision = (await stored()).revision;
    const conflict = a.page.getByText(`Replaced elsewhere while you edited, at revision ${revision}. Saving yours replaces that one.`);
    await conflict.waitFor();
    const barWords = await barSays(tailnetBar(a.page), /^A setting you changed was changed elsewhere too\. Choose for each, then save\./);
    expect(await tailnetBar(a.page).getByRole("button", { name: "Save", exact: true }).isDisabled(), "Save waits for the choice");
    await snap(a.page, run, "live-tailnet-secret-conflict");
    await a.page.getByRole("button", { name: "Keep mine" }).click();
    await tailnetBar(a.page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(tailnetBar(a.page), /^Saved\./);
    expect(storedSecret(CLIENT_SECRET) === `made-up-a-${run}`, "Keep mine stored A's secret");
    expect(storedSecret(CLIENT_ID) === `made-up-id-${run}`, "the ID was kept");

    await setSecret(a.page, "OAuth client secret", `made-up-a2-${run}`);
    await setSecret(b.page, "OAuth client secret", `made-up-b2-${run}`);
    await tailnetBar(b.page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(tailnetBar(b.page), /^Saved\./);
    await a.page.getByText(/^Replaced elsewhere while you edited, at revision/).waitFor();
    await a.page.getByRole("button", { name: "Keep the saved one" }).click();
    await waitFor(async () => (await secretInput(a.page, "OAuth client secret").count()) === 0, "A's typed secret to go");
    expect(storedSecret(CLIENT_SECRET) === `made-up-b2-${run}`, "Keep the saved one left B's secret stored");
    expect(!(await a.page.content()).includes("made-up-") && !(await b.page.content()).includes("made-up-"), "no secret is in either page");
    await a.context.close();
    await b.context.close();
    return { conflict: `Replaced elsewhere while you edited, at revision ${revision}. Saving yours replaces that one.`, bar: barWords };
  },

  async "a reload with a tailnet draft"({ run }) {
    const { page } = await tab();
    await open(page, "#option/network", "Network");
    await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).check();
    await setSecret(page, "OAuth client secret", `made-up-reload-${run}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await heading(page, "Network").waitFor();
    const note = (await page.getByText(/^Your unsaved changes to the tailnet are back/).textContent()).trim();
    expect(/For safety the OAuth client secret you pasted was not kept; paste it again\./.test(note), `the note asks for the secret again: ${note}`);
    expect(await page.getByRole("radio", { name: "Yes, with a Tailscale OAuth client" }).isChecked(), "the choice came back");
    expect(!(await storageText(page)).includes("made-up"), "the secret is in no browser storage");
    await page.getByRole("button", { name: "Discard them" }).click();
    await page.context().close();
    return { note };
  },

  async "the device settings saved, and conflicting with a change made elsewhere"({ run }) {
    const { page, applies, holdReads } = await tab();
    await open(page, "#option/devices", "Devices");
    const spareRows = page.getByRole("button", { name: /^Spare .* boxes$/ });
    const spares = await spareRows.count();
    expect(spares === 2, `a spares row for each device kind: ${spares}`);
    const offByDefault = await page.getByText("None, as by default").count();
    expect(offByDefault === 2, `both say none, as by default: ${offByDefault}`);
    await page.getByRole("button", { name: "Spare Android emulator boxes" }).click();
    await heading(page, "Android emulator").waitFor();
    expect(new URL(page.url()).hash === "#kind/android", "the row opens the kind's page");
    await page.goBack();
    await heading(page, "Devices").waitFor();
    await page.getByRole("switch", { name: "Share each Mac's encoder fairly" }).click();
    await page.getByText("Saved", { exact: true }).first().waitFor();
    await page.getByRole("switch", { name: "Test device" }).click();
    await waitFor(async () => (await stored()).document.general.testDevice === true, "the test device to be stored on");
    let now = await stored();
    expect(now.document.general.encoderLedger === false, "encoder sharing stored off");
    expect(applies.length === 2 && applies.every((apply) => receiptsOf(now, apply.operation).length === 1), "each switch saved once, with its receipt");

    await elsewhere(withGeneral({ testDevice: undefined }));
    await waitFor(async () => (await page.getByRole("switch", { name: "Test device" }).getAttribute("aria-checked")) === "false", "the test device switch to follow the change made elsewhere");

    const release = holdReads();
    await elsewhere(withGeneral({ iosEncoder: "hardware" }));
    await page.getByRole("combobox", { name: "iOS video encoding" }).click();
    await page.getByRole("option", { name: "Software only" }).click();
    const note = page.getByText(/^iOS video encoding was not changed: it was changed elsewhere while you chose\. It is hardware only now\./);
    await note.waitFor();
    release();
    const noteText = (await note.textContent()).trim();
    now = await stored();
    expect(now.document.general.iosEncoder === "hardware", "the change made elsewhere stays");
    await waitFor(async () => (await page.getByRole("combobox", { name: "iOS video encoding" }).textContent()) === "Hardware only", "the menu to show what is stored");
    await snap(page, run, "live-devices-conflict");
    await page.getByRole("combobox", { name: "iOS video encoding" }).click();
    await page.getByRole("option", { name: "Software only" }).click();
    await waitFor(async () => (await stored()).document.general.iosEncoder === "software", "software to be stored");
    await page.getByText("Saved", { exact: true }).first().waitFor();
    await page.context().close();
    return { note: noteText, spareRows: spares };
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
