import { chromium } from "playwright";
const file = process.argv[2];
const out = process.argv[3];
const only = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
const browser = await chromium.launch();
const results = [];
const pageErrors = [];
function record(test, pass, seen) {
  results.push({ test, pass, seen });
  console.log(`${pass ? "PASS" : "FAIL"} ${test} :: ${JSON.stringify(seen)}`);
}
async function fresh({ width = 1280, height = 900, scenario, hash = "" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(`${error.message}`));
  page.on("dialog", (dialog) => (dialog.type() === "beforeunload" ? dialog.accept() : dialog.dismiss()));
  await page.goto(`file://${file}?closed${hash}`);
  await page.waitForTimeout(300);
  if (scenario) await panel(page, async () => page.getByRole("button", { name: scenario, exact: true }).click());
  return page;
}
async function panel(page, fn) {
  const toggle = page.getByRole("button", { name: /Prototype/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await fn();
  await toggle.click();
  await page.waitForTimeout(200);
}
const agent = (page) => panel(page, () => page.getByRole("button", { name: "An agent runs bb box config apply" }).click());
const nextSave = (page, label) => panel(page, () => page.getByRole("button", { name: label, exact: true }).click());
const bar = (page) => page.locator("[role=region][aria-label^=Save] [role=status]").first().innerText().catch(() => "(no bar)");
const openRow = async (page, name) => { await page.getByRole("button", { name }).first().click(); await page.waitForTimeout(400); };
const tb = (page, name) => page.getByRole("textbox", { name, exact: true }).first();
const center = async (locator) => locator.evaluate((el) => el.scrollIntoView({ block: "center" }));
const shot = async (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const tests = {
  async "1a lost reply, racing secret: confirmed by receipt, change since named"() {
    const page = await fresh();
    await openRow(page, /^Proxmox LXC/);
    await nextSave(page, "Saves, reply lost");
    const replace = page.getByRole("button", { name: "Replace the API token secret" });
    await center(replace); await replace.click();
    await page.getByLabel("API token secret").first().fill("token-A");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);
    await agent(page);
    await page.waitForTimeout(2600);
    const words = await bar(page);
    await shot(page, "r3-1a-receipt-and-race");
    record("1a lost reply, racing secret: confirmed by receipt, change since named", /receipt/.test(words) && /Since then, changed elsewhere: API token secret \(revision/.test(words) && !/your changes are there/.test(words), words);
    await page.close();
  },
  async "1b request never arrives: not confirmed, Save again applies once"() {
    const page = await fresh();
    await openRow(page, /^Proxmox LXC/);
    await nextSave(page, "Never arrives");
    await tb(page, "Node").fill("pve-9");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(3500);
    const first = await bar(page);
    await shot(page, "r3-1b-not-confirmed");
    await page.getByRole("button", { name: "Save again" }).click();
    await page.waitForTimeout(1200);
    const second = await bar(page);
    record("1b request never arrives: not confirmed, Save again applies once", /no receipt/.test(first) && /^Saved/.test(second), { first, second });
    await page.close();
  },
  async "1c retries exhausted: form and switch both show failure"() {
    const page = await fresh();
    await openRow(page, /^Proxmox LXC/);
    await panel(page, () => page.getByRole("button", { name: /Someone saves first, 3 times/ }).click());
    await tb(page, "Node").fill("pve-8");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(3500);
    const form = await bar(page);
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await page.waitForTimeout(300);
    await openRow(page, /^Monitor/);
    await panel(page, () => page.getByRole("button", { name: /Someone saves first, 3 times/ }).click());
    const toggle = page.getByRole("switch", { name: "Background monitoring" });
    await toggle.click();
    await page.waitForTimeout(3500);
    const alert = await page.getByRole("alert").first().innerText().catch(() => "none");
    const state = await toggle.getAttribute("aria-checked");
    await shot(page, "r3-1c-switch-exhausted");
    record("1c retries exhausted: form and switch both show failure", /changed three times/.test(form) && /changed three times/.test(alert) && state === "false", { form, alert, state });
    await page.close();
  },
  async "1d removal, image and import refusals are shown"() {
    const page = await fresh();
    const step = (name) => console.log(`  1d: ${name}`);
    await openRow(page, /^Namespace/);
    await nextSave(page, "Is refused");
    await page.getByRole("button", { name: /More for Namespace/ }).click();
    await page.getByRole("menuitem", { name: /Remove backend/ }).click();
    step("confirm");
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove backend" }).click();
    await page.waitForTimeout(1200);
    const removal = await page.getByRole("alert").first().innerText().catch(() => "none");
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await openRow(page, /^Images/);
    await nextSave(page, "Is refused");
    step("images");
    await page.getByRole("combobox", { name: /When web-app is built ahead/ }).click();
    await page.getByRole("option", { name: "Always built ahead" }).click();
    await page.waitForTimeout(1200);
    const image = await page.getByRole("alert").first().innerText().catch(() => "none");
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await openRow(page, /^Configuration/);
    step("import");
    await page.getByRole("button", { name: "Paste a file…" }).click();
    await page.getByRole("button", { name: "Check it" }).click();
    await agent(page);
    await page.getByRole("button", { name: /^Apply/ }).click();
    await page.waitForTimeout(1200);
    const imported = await page.getByRole("alert").first().innerText().catch(() => "none");
    record("1d removal, image and import refusals are shown", /Namespace was not removed: BB Box refused/.test(removal) && /was not changed: BB Box refused/.test(image) && /Not imported: the configuration changed after you checked/.test(imported), { removal, image, imported });
    await page.close();
  },
  async "2 newer secret and file typing survive a save"() {
    const page = await fresh();
    await openRow(page, /^Proxmox LXC/);
    const replace = page.getByRole("button", { name: "Replace the API token secret" });
    await center(replace); await replace.click();
    const secret = page.getByLabel("API token secret").first();
    await secret.fill("token-A");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(150);
    await secret.fill("token-AB");
    await page.waitForTimeout(1200);
    const secretBar = await bar(page);
    const secretValue = await secret.inputValue().catch(() => "gone");
    await shot(page, "r3-2-newer-secret");
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await openRow(page, /^Boxes/);
    await page.getByRole("button", { name: "Add file" }).click();
    await tb(page, "New file's path under the box user's home").fill(".cfg/new.json");
    await tb(page, "New file's content").fill("one");
    await page.getByRole("button", { name: "Save files" }).click();
    await page.waitForTimeout(150);
    await tb(page, "New file's content").fill("two").catch(() => {});
    await page.waitForTimeout(1200);
    const fileValue = await tb(page, "New file's content").inputValue().catch(() => "gone");
    const fileBar = await page.locator("[role=region][aria-label='Save files for every box'] [role=status]").innerText().catch(() => "none");
    record("2 newer secret and file typing survive a save", secretValue === "token-AB" && /newer change is not saved yet/.test(secretBar) && fileValue === "two" && /newer change is not saved yet/.test(fileBar), { secretValue, secretBar, fileValue, fileBar });
    await page.close();
  },
  async "3 creation end to end: a new backend on with its secret, and a named Mac"() {
    const page = await fresh({ scenario: "First run" });
    await page.getByRole("button", { name: /Choose another backend/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Proxmox LXC/ }).first().click();
    await page.waitForTimeout(300);
    await tb(page, "API URL").fill("https://192.0.2.10:8006/api2/json");
    await tb(page, "API token ID").fill("bbbox@pve!plugin");
    await page.getByLabel("API token secret").first().fill("token-secret");
    await page.getByRole("button", { name: "Save and turn on" }).click();
    await page.waitForTimeout(2600);
    const url = page.url().split("#")[1];
    const on = await page.getByRole("switch", { name: /takes new boxes/ }).first().getAttribute("aria-checked").catch(() => "none");
    const status = await page.locator("[data-page-heading]").first().innerText().catch(() => "none");
    await shot(page, "r3-3-created-on");
    const tart = await fresh();
    await openRow(tart, /^Tart/);
    await tart.getByRole("button", { name: "Add Mac" }).click();
    await tart.waitForTimeout(200);
    await tart.getByRole("textbox", { name: "Name of the new Mac" }).fill("mac-2");
    await tart.getByRole("textbox", { name: "Address on mac-2" }).fill("192.0.2.31");
    await tart.getByRole("textbox", { name: "User on mac-2" }).fill("admin");
    await tart.getByRole("button", { name: "Save", exact: true }).click();
    await tart.waitForTimeout(1200);
    const macBar = await bar(tart);
    const macRow = await tart.getByRole("switch", { name: "Mac mac-2: takes new boxes" }).count();
    await shot(tart, "r3-3-mac-added");
    record("3 creation end to end: a new backend on with its secret, and a named Mac", url === "backend/proxmox-lxc" && on === "true" && macRow === 1 && /Saved/.test(macBar) && !pageErrors.length, { url, on, status, macBar, macRow, pageErrors: pageErrors.slice(0, 2) });
    await page.close(); await tart.close();
  },
  async "4 check binds to the full candidate and clears on any edit"() {
    const page = await fresh();
    await openRow(page, /^Tart/);
    await page.getByRole("button", { name: /^mac-1/ }).first().click();
    await tb(page, "Cores of a shared iOS host on mac-1").fill("1");
    await page.getByRole("button", { name: "Check with my changes" }).click();
    await page.waitForTimeout(1600);
    const macCheck = await page.getByText("Not working").count();
    await tb(page, "Cores of a shared iOS host on mac-1").fill("4");
    await page.waitForTimeout(200);
    const cleared = await page.getByText("Your form changed after you checked it").count();
    await shot(page, "r3-4-check-cleared");
    record("4 check binds to the full candidate and clears on any edit", macCheck >= 1 && cleared === 1, { macCheck, cleared });
    await page.close();
  },
  async "5 every edited path has conflict controls and reveal: Mac field and file"() {
    const page = await fresh();
    await openRow(page, /^Tart/);
    await page.getByRole("button", { name: /^mac-1/ }).first().click();
    await tb(page, "Cores of a shared iOS host on mac-1").fill("8");
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await agent(page);
    await openRow(page, /^Tart/);
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await page.waitForTimeout(400);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const keepMine = await page.getByRole("button", { name: "Keep mine" }).count();
    await shot(page, "r3-5-mac-conflict");
    const boxes = await fresh();
    await openRow(boxes, /^Boxes/);
    await boxes.getByRole("button", { name: "Replace the content of ~/.pi/agent/models.json" }).click();
    await tb(boxes, "New content for ~/.pi/agent/models.json").fill("new content");
    await agent(boxes);
    await boxes.waitForTimeout(300);
    const fileConflict = await boxes.getByText(/Replaced elsewhere while you edited/).count();
    record("5 every edited path has conflict controls and reveal: Mac field and file", focused === "Cores of a shared iOS host on mac-1" && keepMine >= 1 && fileConflict === 1, { focused, keepMine, fileConflict });
    await page.close(); await boxes.close();
  },
  async "6 files and imports keep their drafts through leaving and reload"() {
    const page = await fresh();
    await openRow(page, /^Boxes/);
    await page.getByRole("button", { name: "Add file" }).click();
    await tb(page, "New file's path under the box user's home").fill(".cfg/a.json");
    await tb(page, "New file's content").fill("secret text");
    await page.reload();
    await page.getByText(/are back/).first().waitFor({ timeout: 5000 }).catch(() => {});
    const note = await page.getByText(/are back/).first().innerText().catch(() => "none");
    const path = await tb(page, "New file's path under the box user's home").inputValue().catch(() => "none");
    await page.getByRole("button", { name: "BB Box settings" }).first().click();
    await openRow(page, /^Configuration/);
    await page.getByRole("button", { name: "Paste a file…" }).click();
    await page.getByRole("textbox", { name: "Configuration JSON" }).fill('{"monitor":{"refreshIntervalSeconds":20}}');
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("button", { name: "BB Box", exact: true }).click();
    await openRow(page, /^Configuration/);
    const afterLeave = await page.getByRole("textbox", { name: "Configuration JSON" }).inputValue().catch(() => "none");
    await page.reload();
    await page.getByRole("textbox", { name: "Configuration JSON" }).waitFor({ timeout: 5000 }).catch(() => {});
    const afterReload = await page.getByRole("textbox", { name: "Configuration JSON" }).inputValue().catch(() => "none");
    await shot(page, "r3-6-import-restored");
    record("6 files and imports keep their drafts through leaving and reload", /content of ~\/\.cfg\/a\.json/.test(note) && path === ".cfg/a.json" && /refreshIntervalSeconds/.test(afterLeave) && /refreshIntervalSeconds/.test(afterReload), { note, path, afterLeave, afterReload });
    await page.close();
  },
  async "7 Find reveals on the same page, scrolls, bounds keys, narrow synonyms"() {
    const page = await fresh();
    await openRow(page, /^Tart/);
    const box = page.getByRole("combobox", { name: "Find a setting" });
    await box.fill("mac-1 cores");
    await box.press("Enter");
    await page.waitForTimeout(600);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const visible = await page.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
    await shot(page, "r3-7-find-same-page");
    await box.fill("memory");
    for (let index = 0; index < 60; index += 1) await box.press("ArrowDown");
    const active = await box.getAttribute("aria-activedescendant");
    const rendered = await page.getByRole("option").count();
    await box.fill("ram");
    await page.waitForTimeout(150);
    const ram = await page.getByRole("option").count();
    record("7 Find reveals on the same page, scrolls, bounds keys, narrow synonyms", focused === "Cores of a shared iOS host on mac-1" && visible && Number(active?.split("-").pop()) < rendered && ram <= 20, { focused, visible, active, rendered, ram });
    await page.close();
  },
  async "8 status words, established all-off, Linux-only Docker"() {
    const problems = await fresh({ scenario: "Problems" });
    const headline = await problems.locator("section[aria-label=Status] p").first().innerText();
    await problems.close();
    const page = await fresh();
    for (const name of ["Proxmox LXC on pve-1", "Tart on mac-1", "SSH host pool", "Docker on docker-1", "Docker on pc-1", "microsandbox on mac-1", "Proxmox QEMU on pve-1", "Hetzner Cloud"]) {
      await page.getByRole("switch", { name: `${name}: takes new boxes` }).click();
      await page.waitForTimeout(950);
    }
    const allOff = await page.locator("section[aria-label=Status]").innerText().catch(() => "none");
    const onboarding = await page.getByText("Set up BB Box").count();
    await shot(page, "r3-8-all-off");
    const first = await fresh({ scenario: "First run" });
    await first.getByRole("button", { name: "Use Docker on bb-1" }).click();
    await first.waitForTimeout(6500);
    const warnings = await first.getByText(/Not offered now/).count();
    record("8 status words, established all-off, Linux-only Docker", /6 of 8 backends passed their last check/.test(headline) && /Every backend is off/.test(allOff) && onboarding === 0 && warnings === 0, { headline, allOff: allOff.slice(0, 120), onboarding, warnings });
    await page.close(); await first.close();
  },
  async "9 accessibility: radio names, error ties, Show focus, help and Mac names"() {
    const page = await fresh({ width: 390, height: 844 });
    await openRow(page, /^Windows desktop\s/);
    const radios = await page.getByRole("radio").evaluateAll((els) => els.filter((el) => el.offsetParent !== null).map((el) => el.getAttribute("aria-label")));
    await page.getByRole("textbox", { name: "Small Cores" }).fill("0");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1100);
    await page.locator("main").evaluate(() => document.querySelector("main > div.overflow-y-auto").scrollTo({ top: 0 }));
    await page.getByRole("button", { name: "Show", exact: true }).click();
    await page.waitForTimeout(300);
    const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const described = await page.evaluate(() => { const id = document.activeElement?.getAttribute("aria-describedby"); return id ? document.getElementById(id)?.textContent : null; });
    const wide = await fresh();
    await openRow(wide, /^Proxmox LXC/);
    const more = await wide.getByRole("button", { name: "More about TLS fingerprint" }).count();
    await openRow(wide, /^BB Box settings/);
    await openRow(wide, /^Tart/);
    await wide.getByRole("button", { name: /^mac-1/ }).first().click();
    const macField = await wide.getByRole("textbox", { name: "Address on mac-1" }).count();
    record("9 accessibility: radio names, error ties, Show focus, help and Mac names", new Set(radios).size === radios.length && radios.every((name) => /is the default size/.test(name)) && focused === "Small Cores" && /Use at least 1 core/.test(described ?? "") && more === 1 && macField === 1, { radios, focused, described, more, macField });
    await page.close(); await wide.close();
  },
  async "10 smaller: effective values shown, rule words, Monitor link, invalid route, titles, full stops"() {
    const page = await fresh();
    await openRow(page, /^Tart/);
    await page.getByRole("button", { name: /^mac-1/ }).first().click();
    const estimate = await page.getByText(/Empty: 10 cores, bb-box's estimate for mac-1/).count();
    const rule = await page.getByText("Switches, and menus that stand alone, act at once. Fields, checkboxes and radio choices wait for Save.").count();
    await page.getByRole("button", { name: "Machine status: its settings" }).click();
    await page.waitForTimeout(400);
    const monitor = { url: page.url().split("#")[1], heading: await page.locator("[data-page-heading]").first().innerText() };
    const invalid = await fresh({ hash: "#kind/no-such-kind" });
    const gone = await invalid.getByText("This kind is not here").count();
    const first = await fresh({ scenario: "First run" });
    await panel(first, () => first.getByRole("button", { name: "Low disk", exact: true }).click());
    const title = await first.getByText("Not enough disk on bb-1").count();
    await first.getByRole("button", { name: /Choose another backend/ }).click();
    await first.getByRole("button", { name: /^Proxmox LXC/ }).first().click();
    await first.getByRole("button", { name: "Save, keep it off" }).click();
    await first.waitForTimeout(1200);
    const health = await first.locator("main").innerText();
    record("10 smaller: effective values shown, rule words, Monitor link, invalid route, titles, full stops", estimate === 1 && rule >= 1 && monitor.url === "option/monitor" && monitor.heading === "Monitor" && gone === 1 && title === 1 && !/\.\./.test(health), { estimate, rule, monitor, gone, title, doubleStop: /\.\./.test(health) });
    await page.close(); await invalid.close(); await first.close();
  },
};
for (const [name, test] of Object.entries(tests).filter(([name]) => !only || [...only].some((key) => name.startsWith(key)))) {
  try { await test(); } catch (error) { record(name, false, { error: error.message.split("\n")[0] }); }
}
console.log(`SUMMARY ${results.filter((each) => each.pass).length} of ${results.length} passed; page errors: ${JSON.stringify([...new Set(pageErrors)])}`);
await browser.close();
