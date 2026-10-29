import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const bbCli = process.env.LIVE_BB_CLI ?? join(process.env.HOME ?? "", "fbb");
const dataDir = process.env.LIVE_BB_DATA ?? join(process.env.HOME ?? "", "bbdata");
const shots = process.env.LIVE_SHOTS ?? join(process.cwd(), "shots");
const runs = Number(process.env.LIVE_RUNS ?? 3);
const chosen = process.argv.slice(2);
const exec = promisify(execFile);
mkdirSync(shots, { recursive: true });

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const GET = "**/api/v1/plugins/bb-box/rpc/config.get";

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

async function otherTab(change, operation) {
  for (let tries = 0; tries < 5; tries += 1) {
    const state = await stored();
    const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision, ...(operation ? { operation } : {}) });
    if (result.ok) return result.state;
    if (result.reason === "problems") throw new Error(`the other tab's save was refused: ${JSON.stringify(result.problems)}`);
  }
  throw new Error("the other tab could not save");
}

async function cli(...args) {
  const { stdout } = await exec(bbCli, args, { maxBuffer: 1 << 24 });
  return stdout;
}

async function agentApplies(change) {
  const document = JSON.parse(await cli("box", "config", "show", "--json"));
  const file = join(tmpdir(), `agent-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(change(document), null, 2));
  return cli("box", "config", "apply", file);
}

const armDroppedReply = () => cli("box", "config", "drop-replies");

function storedContentIs(path, expected) {
  const db = new DatabaseSync(join(dataDir, "bb.db"), { readOnly: true });
  try {
    const row = db.prepare("select value from plugin_kv where plugin_id = 'bb-box' and key = 'config/secrets'").get();
    const secrets = row ? JSON.parse(row.value) : {};
    return secrets["@general"]?.[`file:${path}`] === expected;
  } finally {
    db.close();
  }
}

const setMonitor = (patch) => (document) => ({ ...document, monitor: { ...document.monitor, ...patch } });
const setGeneral = (patch) => (document) => ({ ...document, general: { ...document.general, ...patch } });
const keptFiles = (document) => (document.general.files ?? []).map((file) => ({ path: file.path }));
const withFileContent = (path, content) => (document) => ({ ...document, general: { ...document.general, files: [...keptFiles(document).filter((file) => file.path !== path), { path, content }] } });

async function resetConfiguration() {
  await otherTab((document) => {
    const general = { ...document.general };
    delete general.files;
    delete general.boxesPerThread;
    const { monitor: _monitor, ...rest } = document;
    return { ...rest, general };
  });
}

const browser = await chromium.launch();

async function tab(viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const applies = [];
  const applyHandlers = [];
  await page.route(APPLY, async (route) => {
    const body = JSON.parse(route.request().postData() ?? "null");
    applies.push(body);
    const handler = applyHandlers.shift();
    if (handler) await handler(route, body);
    else await route.continue();
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

async function open(page, hash, heading) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

async function leaveBySidebar(page) {
  await page.getByRole("link", { name: "General", exact: true }).first().click();
  await page.waitForURL((url) => !url.pathname.includes("/plugins/bb-box"));
}

async function comeBack(page, heading) {
  await page.goBack();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

const bar = (page, name) => page.getByRole("region", { name });
const monitorBar = (page) => bar(page, "Save the Monitor");
const boxesBar = (page) => bar(page, "Save Boxes");
const filesBar = (page) => bar(page, "Save files for every box");
const refreshField = (page) => page.getByRole("textbox", { name: "Refresh every, in seconds" });
const boxesField = (page) => page.getByRole("textbox", { name: "Boxes per thread" });

const conflictNote = (page, pattern) => page.getByRole("status").filter({ hasText: pattern });

async function barSays(region, pattern, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = (await region.getByRole("status").first().textContent({ timeout: 1_000 }).catch(() => "")) ?? "";
    if (pattern.test(text)) return text;
    await pause(100);
  }
  throw new Error(`the bar never said ${pattern}; it said "${text}"`);
}

async function waitFor(check, what, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function snap(page, run, name) {
  if (run === 1) await page.screenshot({ path: join(shots, `${name}.png`) });
}

const receiptsOf = (state, operation) => state.receipts.filter((receipt) => receipt.operation === operation);

async function replaceFileContent(page, path, text) {
  const editor = page.getByRole("textbox", { name: `New content for ~/${path}` });
  if (!(await editor.count())) await page.getByRole("button", { name: `Replace the content of ~/${path}` }).click();
  await editor.fill(text);
}

const checks = {
  async "agent apply while a draft is open"() {
    const { page } = await tab();
    await open(page, "#option/monitor", "Monitor");
    await refreshField(page).fill("12");
    await agentApplies((document) => setGeneral({ boxesPerThread: 4 })(setMonitor({ refreshIntervalSeconds: 8, backgroundMonitoring: true })(document)));
    await conflictNote(page, /^Changed elsewhere to/).waitFor();
    const note = await conflictNote(page, /^Changed elsewhere to/).textContent();
    expect(note.includes("Changed elsewhere to 8 while you edited."), `the conflict says ${note}`);
    expect((await refreshField(page).inputValue()) === "12", "the field keeps the person's value");
    await waitFor(async () => (await page.getByRole("switch", { name: "Background monitoring" }).getAttribute("aria-checked")) === "true", "the switch nobody touched here to show the agent's value");
    const words = await barSays(monitorBar(page), /changed elsewhere too/);
    await page.getByRole("button", { name: "Keep mine" }).click();
    await monitorBar(page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(monitorBar(page), /^Saved\./);
    const after = await stored();
    expect(after.document.monitor.refreshIntervalSeconds === 12 && after.document.general.boxesPerThread === 4 && after.document.monitor.backgroundMonitoring === true, "mine and the agent's other changes are stored");
    await page.context().close();
    return { conflict: note, bar: words, stored: { refresh: 12, boxesPerThread: 4, backgroundMonitoring: true } };
  },

  async "two tabs save the same field"() {
    const a = await tab();
    const b = await tab();
    await open(a.page, "#option/monitor", "Monitor");
    await open(b.page, "#option/monitor", "Monitor");
    await refreshField(a.page).fill("12");
    await refreshField(b.page).fill("15");
    await monitorBar(a.page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(monitorBar(a.page), /^Saved\./);
    await conflictNote(b.page, /^Changed elsewhere to/).waitFor();
    const note = await conflictNote(b.page, /^Changed elsewhere to/).textContent();
    expect(note.includes("Changed elsewhere to 12"), `B's conflict says ${note}`);
    await b.page.getByRole("button", { name: "Keep mine" }).click();
    await monitorBar(b.page).getByRole("button", { name: "Save", exact: true }).click();
    await barSays(monitorBar(b.page), /^Saved\./);
    expect((await stored()).document.monitor.refreshIntervalSeconds === 15, "B's choice is stored");
    await waitFor(async () => (await refreshField(a.page).inputValue()) === "15", "A to show the stored value");
    await a.context.close();
    await b.context.close();
    return { conflictInB: note };
  },

  async "two tabs save different fields"({ run }) {
    const a = await tab();
    const b = await tab();
    const path = `.cfg/two-${run}.json`;
    await open(a.page, "#option/boxes", "Boxes");
    await open(b.page, "#option/boxes", "Boxes");
    await boxesField(a.page).fill("6");
    await b.page.getByRole("button", { name: "Add file" }).click();
    await b.page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(path);
    await b.page.getByRole("textbox", { name: `Content of ~/${path}` }).fill(`made-up-${run}`);
    await Promise.all([boxesBar(a.page).getByRole("button", { name: "Save", exact: true }).click(), filesBar(b.page).getByRole("button", { name: "Save files" }).click()]);
    const wordsA = await barSays(boxesBar(a.page), /^Saved/);
    const wordsB = await barSays(filesBar(b.page), /^Saved/);
    const after = await stored();
    expect(after.document.general.boxesPerThread === 6 && after.document.general.files?.some((file) => file.path === path), "both are stored");
    expect(storedContentIs(path, `made-up-${run}`), "the file's content is the one sent");
    await a.context.close();
    await b.context.close();
    return { a: wordsA, b: wordsB };
  },

  async "lost reply after a store, with the file replaced in another tab before the page looks"({ run }) {
    const path = `.cfg/lost-${run}.json`;
    await otherTab(withFileContent(path, "start"));
    const { page, applyHandlers, applies, holdReads } = await tab();
    await open(page, "#option/boxes", "Boxes");
    await replaceFileContent(page, path, `mine-${run}`);
    await armDroppedReply();
    let theirs = null;
    applyHandlers.push(async (route) => {
      const response = await route.fetch();
      theirs = await otherTab(withFileContent(path, `theirs-${run}`));
      await route.fulfill({ response });
    });
    const releaseReads = holdReads();
    await filesBar(page).getByRole("button", { name: "Save files" }).click();
    const looking = await barSays(filesBar(page), /^Save not confirmed: BB Box did not reply\. Looking for this save's receipt…/);
    releaseReads();
    const words = await barSays(filesBar(page), /^Saved at revision \d+\. The reply was lost; BB Box's receipt for this save confirms it\. Since then, changed elsewhere: the content of ~\/\.cfg\/lost-\d+\.json \(revision \d+\)\./);
    const after = await stored();
    const receipts = receiptsOf(after, applies[0].operation);
    expect(receipts.length === 1, "one receipt for the save");
    expect(words.includes(`Saved at revision ${receipts[0].revision}.`) && words.includes(`(revision ${theirs.revision})`), "the words name the receipt's revision and the other tab's");
    expect(storedContentIs(path, `theirs-${run}`), "the other tab's content is what is stored now");
    await snap(page, run, "live-lost-reply-receipt");
    await page.context().close();
    return { looking, bar: words };
  },

  async "a request that never arrives, then Save again applied once"() {
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#option/monitor", "Monitor");
    const before = await stored();
    await refreshField(page).fill("13");
    applyHandlers.push((route) => route.abort("failed"));
    await refreshField(page).press("Enter");
    const unknown = await barSays(monitorBar(page), /^Save not confirmed: BB Box has no receipt for it yet\. Your changes are still here\. Saving again resends the same request, which BB Box applies at most once\./);
    expect((await stored()).revision === before.revision, "nothing was stored");
    await monitorBar(page).getByRole("button", { name: "Save again" }).click();
    const saved = await barSays(monitorBar(page), /^Saved/);
    const after = await stored();
    expect(applies.length === 2 && applies[0].operation === applies[1].operation, "Save again sent the same operation");
    expect(JSON.stringify(applies[0].submission) === JSON.stringify(applies[1].submission), "with the same submission");
    expect(after.revision === before.revision + 1 && receiptsOf(after, applies[0].operation).length === 1, "applied once");
    expect(after.document.monitor.refreshIntervalSeconds === 13, "stored");
    await page.context().close();
    return { first: unknown, then: saved, operation: applies[0].operation };
  },

  async "the same request sent twice at once, applied once"() {
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#option/boxes", "Boxes");
    const before = await stored();
    await boxesField(page).fill("3");
    const answers = [];
    applyHandlers.push(async (route) => {
      const [first, second] = await Promise.all([route.fetch(), route.fetch()]);
      answers.push(await first.json(), await second.json());
      await route.fulfill({ response: first });
    });
    await boxesBar(page).getByRole("button", { name: "Save", exact: true }).click();
    const words = await barSays(boxesBar(page), /^Saved/);
    const after = await stored();
    expect(after.revision === before.revision + 1, `one revision more, not ${after.revision - before.revision}`);
    expect(receiptsOf(after, applies[0].operation).length === 1, "one receipt");
    expect(answers.filter((answer) => answer.result?.replayed === true).length === 1, "one of the two was a replay");
    await page.context().close();
    return { bar: words, replayed: 1 };
  },

  async "a late reply after leaving the page"() {
    const { page, applyHandlers, applies, holdReads } = await tab();
    await open(page, "#option/monitor", "Monitor");
    await refreshField(page).fill("14");
    const releaseReads = holdReads();
    const late = gate();
    const arrived = gate();
    applyHandlers.push(async (route) => {
      const response = await route.fetch();
      arrived.open();
      await late.promise;
      await route.fulfill({ response });
    });
    await monitorBar(page).getByRole("button", { name: "Save", exact: true }).click();
    await arrived.promise;
    await leaveBySidebar(page);
    await pause(1_000);
    late.open();
    await pause(1_000);
    releaseReads();
    await comeBack(page, "Monitor");
    const words = await barSays(monitorBar(page), /^Saved\.$/);
    expect(applies.length === 1, "one request, answered late");
    expect((await refreshField(page).inputValue()) === "14", "the field shows the saved value");
    expect((await page.getByText("Changed", { exact: true }).count()) === 0, "nothing is marked changed");
    await page.context().close();
    return { bar: words };
  },

  async "a receipt aged out, said as not confirmed"({ run }) {
    const { page, applies, holdReads } = await tab();
    await open(page, "#option/monitor", "Monitor");
    await refreshField(page).fill("16");
    await armDroppedReply();
    const releaseReads = holdReads();
    await monitorBar(page).getByRole("button", { name: "Save", exact: true }).click();
    const looking = await barSays(monitorBar(page), /^Save not confirmed: BB Box did not reply\. Looking for this save's receipt…/);
    await leaveBySidebar(page);
    const operation = applies[0].operation;
    const stamp = Date.now();
    for (let save = 0; save < 505; save += 1) await otherTab(setGeneral({ boxesPerThread: save % 5 }), `agent-${stamp}-${save}`);
    const now = await stored();
    expect(receiptsOf(now, operation).length === 0 && now.receipts.length === 500, "BB Box no longer lists the save's receipt");
    releaseReads();
    await comeBack(page, "Monitor");
    const words = await barSays(monitorBar(page), /^Save not confirmed: this save is older than the receipts BB Box keeps\./);
    await pause(1_500);
    expect(applies.length === 1, "the save was never sent again");
    expect(!(await monitorBar(page).getByRole("button", { name: "Save again" }).count()), "it offers no Save again");
    await snap(page, run, "live-receipt-aged-out");
    await page.context().close();
    return { looking, bar: words, receiptsListed: now.receipts.length };
  },

  async "three refusals in a row, for a form and for a switch"({ run }) {
    const { page, applyHandlers } = await tab();
    await open(page, "#option/monitor", "Monitor");
    const race = (step) => async (route) => {
      await otherTab(setGeneral({ boxesPerThread: 10 + step }));
      await route.continue();
    };
    await refreshField(page).fill("17");
    applyHandlers.push(race(1), race(2), race(3));
    await monitorBar(page).getByRole("button", { name: "Save", exact: true }).click();
    const form = await barSays(monitorBar(page), /^Not saved: the configuration changed three times while saving\. Your changes are still here\./);
    expect((await stored()).document.monitor?.refreshIntervalSeconds !== 17, "nothing of the form was stored");
    expect((await refreshField(page).inputValue()) === "17", "the change is still here");
    applyHandlers.push(race(4), race(5), race(6));
    const toggle = page.getByRole("switch", { name: "Background monitoring" });
    const before = await toggle.getAttribute("aria-checked");
    await toggle.click();
    const note = page.getByText(/^Background monitoring was not changed: the configuration changed 3 times while saving\./);
    await note.waitFor();
    const switchWords = await note.textContent();
    expect((await toggle.getAttribute("aria-checked")) === before, "the switch is put back");
    await snap(page, run, "live-three-refusals");
    await monitorBar(page).getByRole("button", { name: "Save again" }).click();
    await barSays(monitorBar(page), /^Saved/);
    await page.context().close();
    return { form, switch: switchWords };
  },

  async "typing during a save, a file included"({ run }) {
    const path = `.cfg/typing-${run}.json`;
    await otherTab(withFileContent(path, "start"));
    const { page, applyHandlers } = await tab();
    await open(page, "#option/boxes", "Boxes");
    const held = gate();
    const arrived = gate();
    const hold = async (route) => {
      arrived.open();
      await held.promise;
      await route.continue();
    };
    await boxesField(page).fill("6");
    applyHandlers.push(hold);
    await boxesBar(page).getByRole("button", { name: "Save", exact: true }).click();
    await arrived.promise;
    await boxesField(page).fill("7");
    held.open();
    const field = await barSays(boxesBar(page), /^Saved\. Your newer change is not saved yet\./);
    expect((await stored()).document.general.boxesPerThread === 6 && (await boxesField(page).inputValue()) === "7", "6 stored, 7 shown");

    const fileHeld = gate();
    const fileArrived = gate();
    await replaceFileContent(page, path, `A-${run}`);
    applyHandlers.push(async (route) => {
      fileArrived.open();
      await fileHeld.promise;
      await route.continue();
    });
    await filesBar(page).getByRole("button", { name: "Save files" }).click();
    await fileArrived.promise;
    await page.getByRole("textbox", { name: `New content for ~/${path}` }).fill(`B-${run}`);
    fileHeld.open();
    const file = await barSays(filesBar(page), /^Saved\. Your newer change is not saved yet\./);
    expect(storedContentIs(path, `A-${run}`), "A is stored");
    expect((await page.getByRole("textbox", { name: `New content for ~/${path}` }).inputValue()) === `B-${run}`, "B is still in the editor");
    await page.context().close();
    return { field, file };
  },

  async "a reload with a draft"({ run }) {
    const path = `.cfg/reload-${run}.json`;
    const secret = `made-up-reload-secret-${run}`;
    const { page } = await tab();
    await open(page, "#option/monitor", "Monitor");
    await refreshField(page).fill("18");
    await page.getByRole("button", { name: "BB Box settings" }).click();
    await page.locator('[data-row-key="option-boxes"]').click();
    await page.getByRole("heading", { name: "Boxes", exact: true }).waitFor();
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(path);
    await page.getByRole("textbox", { name: `Content of ~/${path}` }).fill(secret);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Boxes", exact: true }).waitFor();
    const lost = await page.getByText(/^Your unsaved changes to files for every box are back/).textContent();
    expect(lost.includes(`For safety the content of ~/${path} you pasted was not kept; paste it again.`), `the note says ${lost}`);
    const storage = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
    expect(!storage.includes(secret), "the pasted content is in neither session nor local storage");
    expect(storage.includes(path), "the new file's path is kept");
    await page.goto(`${base}/settings/plugins/bb-box#option/monitor`, { waitUntil: "domcontentloaded" });
    const back = await page.getByText(/^Your unsaved changes to the Monitor are back/).textContent();
    expect((await refreshField(page).inputValue()) === "18", "the Monitor's change is back");
    let asked = false;
    page.on("dialog", (dialog) => {
      if (dialog.type() === "beforeunload") asked = true;
    });
    await page.close({ runBeforeUnload: true });
    await waitFor(() => asked, "the browser's warning before closing");
    return { files: lost, monitor: back, warnedOnClose: asked };
  },

  async "G1 field: retry-submitted-version"() {
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#option/boxes", "Boxes");
    const held = gate();
    const retrying = gate();
    await boxesField(page).fill("6");
    applyHandlers.push(async (route) => {
      await otherTab(setMonitor({ refreshIntervalSeconds: 9 }));
      await route.continue();
    });
    applyHandlers.push(async (route) => {
      retrying.open();
      await held.promise;
      await route.continue();
    });
    await boxesBar(page).getByRole("button", { name: "Save", exact: true }).click();
    await retrying.promise;
    await boxesField(page).fill("7");
    held.open();
    const words = await barSays(boxesBar(page), /^Saved at revision \d+, on top of a change made elsewhere\. Your newer change is not saved yet\.$/);
    const after = await stored();
    expect(after.document.general.boxesPerThread === 6, "A is stored");
    expect((await boxesField(page).inputValue()) === "7" && (await page.getByText("Changed", { exact: true }).count()) === 1, "B shows as an unsaved change");
    expect(applies.length === 2 && JSON.stringify(applies[0].submission) === JSON.stringify(applies[1].submission) && applies[0].operation === applies[1].operation, "the retry sent the frozen submission with its ID");
    expect(!words.includes("Since then"), "the bar names only what changed elsewhere, and nothing of the save changed since");
    await page.context().close();
    return { bar: words };
  },

  async "G1 file: retry-submitted-version"({ run }) {
    const path = `.cfg/g1-${run}.json`;
    await otherTab(withFileContent(path, "start"));
    const { page, applyHandlers, applies } = await tab();
    await open(page, "#option/boxes", "Boxes");
    const held = gate();
    const retrying = gate();
    await replaceFileContent(page, path, `A-${run}`);
    applyHandlers.push(async (route) => {
      await otherTab(setMonitor({ refreshIntervalSeconds: 9 }));
      await route.continue();
    });
    applyHandlers.push(async (route) => {
      retrying.open();
      await held.promise;
      await route.continue();
    });
    await filesBar(page).getByRole("button", { name: "Save files" }).click();
    await retrying.promise;
    await page.getByRole("textbox", { name: `New content for ~/${path}` }).fill(`B-${run}`);
    held.open();
    const words = await barSays(filesBar(page), /^Saved at revision \d+, on top of a change made elsewhere\. Your newer change is not saved yet\.$/);
    expect(storedContentIs(path, `A-${run}`), "A is stored");
    expect(!storedContentIs(path, `B-${run}`), "B is not");
    expect((await page.getByRole("textbox", { name: `New content for ~/${path}` }).inputValue()) === `B-${run}`, "B shows as an unsaved change");
    expect(applies[0].operation === applies[1].operation && JSON.stringify(applies[0].submission) === JSON.stringify(applies[1].submission), "the retry sent the frozen submission");
    await page.context().close();
    return { bar: words };
  },

  async "G2 new-file-overwrites-existing"({ run }) {
    const path = `.cfg/g2-${run}.json`;
    const start = await otherTab(withFileContent(path, "start"));
    const startVersion = start.document.general.files.find((file) => file.path === path).content.version;
    const { page } = await tab();
    await open(page, "#option/boxes", "Boxes");
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(path);
    await page.getByText(`~/${path} is already a file here. Saving replaces it.`).waitFor();
    await page.getByRole("textbox", { name: `Content of ~/${path}` }).fill(`mine-${run}`);
    const theirs = await otherTab(withFileContent(path, `theirs-${run}`));
    await conflictNote(page, /^Replaced elsewhere while you edited, at revision \d+\. Saving yours replaces that one\./).waitFor();
    const conflict = await conflictNote(page, /^Replaced elsewhere while you edited/).textContent();
    expect(conflict.includes(`at revision ${theirs.revision}`), "the conflict names the other save's revision");
    const save = filesBar(page).getByRole("button", { name: "Save files" });
    expect(await save.isDisabled(), "Save waits until one is chosen");
    expect(storedContentIs(path, `theirs-${run}`) && theirs.document.general.files.find((file) => file.path === path).content.version !== startVersion, "nothing of mine is stored");
    expect((await page.getByRole("button", { name: "Keep the saved one" }).count()) === 1 && (await page.getByRole("button", { name: "Keep mine" }).count()) === 1, "both choices are offered");
    await snap(page, run, "live-g2-conflict");
    await page.getByRole("button", { name: "Keep mine" }).click();
    await save.click();
    await barSays(filesBar(page), /^Saved/);
    expect(storedContentIs(path, `mine-${run}`), "mine is stored once chosen");
    expect((await stored()).document.general.files.filter((file) => file.path === path).length === 1, "still one file at the path");
    await page.context().close();
    return { conflict };
  },

  async "G3 new-file-followup-conflict"({ run }) {
    const path = `.cfg/g3-${run}.json`;
    const { page, applyHandlers } = await tab();
    await open(page, "#option/boxes", "Boxes");
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(path);
    await page.getByRole("textbox", { name: `Content of ~/${path}` }).fill(`one-${run}`);
    const held = gate();
    const arrived = gate();
    applyHandlers.push(async (route) => {
      arrived.open();
      await held.promise;
      await route.continue();
    });
    await filesBar(page).getByRole("button", { name: "Save files" }).click();
    await arrived.promise;
    await page.getByRole("textbox", { name: `Content of ~/${path}` }).fill(`two-${run}`);
    held.open();
    await barSays(filesBar(page), /^Saved\. Your newer change is not saved yet\./);
    const provisional = await page.evaluate(() => {
      const inPage = [...document.querySelectorAll("[data-draft-path]")].map((element) => element.getAttribute("data-draft-path"));
      const inStorage = Object.values({ ...sessionStorage }).join("\n");
      return [...inPage, inStorage].filter((text) => text.includes("@new-")).length;
    });
    expect(provisional === 0, "no edit keeps an @new- identity after its save is confirmed");
    expect((await page.getByRole("textbox", { name: `New content for ~/${path}` }).inputValue()) === `two-${run}`, "the newer text is on the saved file");
    const theirs = await otherTab(withFileContent(path, `theirs-${run}`));
    await conflictNote(page, /^Replaced elsewhere while you edited/).waitFor();
    await barSays(filesBar(page), /changed elsewhere too/);
    const conflict = await conflictNote(page, /^Replaced elsewhere while you edited/).textContent();
    expect(conflict.includes(`at revision ${theirs.revision}`), "the second save meets the change made elsewhere");
    expect(await filesBar(page).getByRole("button", { name: "Save files" }).isDisabled(), "Save waits for a choice");
    expect(storedContentIs(path, `theirs-${run}`), "nothing of mine replaced theirs");
    expect((await stored()).document.general.files.filter((file) => file.path === path).length === 1, "one file, never a second");
    await page.context().close();
    return { conflict };
  },

  async "G4 save-leave-return-edit"({ run }) {
    const { page, applyHandlers, applies, holdReads } = await tab();
    await open(page, "#option/monitor", "Monitor");
    const before = await stored();
    await refreshField(page).fill("12");
    await armDroppedReply();
    const releaseReads = holdReads();
    const late = gate();
    const arrived = gate();
    applyHandlers.push(async (route) => {
      const response = await route.fetch();
      arrived.open();
      await late.promise;
      await route.fulfill({ response });
    });
    await monitorBar(page).getByRole("button", { name: "Save", exact: true }).click();
    await arrived.promise;
    await leaveBySidebar(page);
    await comeBack(page, "Monitor");
    const during = await barSays(monitorBar(page), /^Saving/);
    await refreshField(page).fill("15");
    late.open();
    await barSays(monitorBar(page), /^Save not confirmed: BB Box did not reply\. Looking for this save's receipt…/);
    releaseReads();
    await barSays(monitorBar(page), /^Saved at revision \d+\. The reply was lost/);
    await leaveBySidebar(page);
    await comeBack(page, "Monitor");
    const words = await barSays(monitorBar(page), /^Saved at revision \d+\. The reply was lost; BB Box's receipt for this save confirms it\. Your newer change is not saved yet\./);
    const after = await stored();
    expect(after.document.monitor.refreshIntervalSeconds === 12 && after.revision === before.revision + 1 && receiptsOf(after, applies[0].operation).length === 1 && applies.length === 1, "12 is stored once");
    expect((await refreshField(page).inputValue()) === "15" && (await page.getByText("Changed", { exact: true }).count()) === 1, "15 is still shown and still an unsaved change");
    await snap(page, run, "live-g4-after");
    await page.context().close();
    return { whileOut: during, after: words };
  },

  async "G5 file-save-across-remount"({ run }) {
    const path = `.cfg/g5-${run}.json`;
    await otherTab(withFileContent(path, "start"));
    const { page, applyHandlers } = await tab();
    await open(page, "#option/boxes", "Boxes");
    await replaceFileContent(page, path, `saved-${run}`);
    const held = gate();
    const arrived = gate();
    applyHandlers.push(async (route) => {
      arrived.open();
      await held.promise;
      await route.continue();
    });
    await filesBar(page).getByRole("button", { name: "Save files" }).click();
    await arrived.promise;
    await leaveBySidebar(page);
    await comeBack(page, "Boxes");
    const editor = page.getByRole("textbox", { name: `New content for ~/${path}` });
    expect((await editor.inputValue()) === `saved-${run}`, "the editor is open with the text being saved");
    await editor.fill(`newer-${run}`);
    held.open();
    const words = await barSays(filesBar(page), /^Saved\. Your newer change is not saved yet\./);
    expect((await editor.inputValue()) === `newer-${run}`, "the editor stays open with the newer content");
    expect(storedContentIs(path, `saved-${run}`), "the first content is stored");
    await page.context().close();
    return { bar: words };
  },
};

const results = [];
const names = chosen.length ? Object.keys(checks).filter((name) => chosen.some((word) => name.startsWith(word))) : Object.keys(checks);
for (const name of names) {
  for (let run = 1; run <= runs; run += 1) {
    await resetConfiguration();
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
