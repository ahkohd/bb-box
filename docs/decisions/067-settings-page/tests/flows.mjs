import { chromium } from "playwright";
const file = process.argv[2];
const out = process.argv[3];
const browser = await chromium.launch();
const results = [];
const errors = [];
const note = (step, data) => { results.push({ step, ...data }); console.log(JSON.stringify({ step, ...data })); };
async function fresh({ width = 1280, height = 900, query = "?closed", scenario } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") {
      note("leave-warning", { shown: true });
      void dialog.accept();
    } else void dialog.dismiss();
  });
  await page.goto(`file://${file}${query}`);
  await page.waitForTimeout(300);
  if (scenario) await panel(page, async () => { await page.getByRole("button", { name: scenario, exact: true }).click(); });
  return page;
}
async function panel(page, fn) {
  const toggle = page.getByRole("button", { name: /Prototype/ });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await fn();
  await toggle.click();
  await page.waitForTimeout(250);
}
async function shot(page, name, full = true) {
  const column = await page.locator("main div.max-w-3xl").boundingBox();
  if (full) {
    const height = await page.evaluate(() => document.querySelector("main > div.overflow-y-auto").scrollHeight + 60);
    await page.setViewportSize({ width: page.viewportSize().width, height: Math.min(Math.max(700, height), 4200) });
    await page.waitForTimeout(250);
  }
  const box = await page.locator("main div.max-w-3xl").boundingBox();
  const viewport = page.viewportSize();
  await page.screenshot({ path: `${out}/${name}.png`, clip: { x: Math.max(0, box.x - 8), y: 48, width: Math.min(box.width + 16, viewport.width), height: viewport.height - 48 } });
}
const open = async (page, name) => { await page.getByRole("button", { name }).first().click(); await page.waitForTimeout(350); };
const field = (page, label) => page.getByRole("textbox", { name: label, exact: true }).first();
const steps = {
  async overview() {
    const page = await fresh();
    note("status-initial", { text: await page.locator("section[aria-label=Status] p").first().innerText() });
    await shot(page, "01-overview");
    await page.getByRole("button", { name: "Check all" }).click();
    await page.waitForTimeout(400);
    note("status-checking", { text: await page.locator("section[aria-label=Status] p").first().innerText() });
    await page.waitForTimeout(2200);
    note("status-after", { text: await page.locator("section[aria-label=Status] p").first().innerText() });
    note("default-switch", { disabled: await page.getByRole("switch", { name: "Linux: offered to threads" }).isDisabled() });
    await page.getByRole("switch", { name: "Linux on arm64: offered to threads" }).click();
    await page.waitForTimeout(1100);
    note("kind-off-stays", { visible: await page.getByRole("switch", { name: "Linux on arm64: offered to threads" }).isVisible(), checked: await page.getByRole("switch", { name: "Linux on arm64: offered to threads" }).getAttribute("aria-checked") });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole("switch", { name: "Linux on arm64: offered to threads" }).scrollIntoViewIfNeeded();
    await shot(page, "02-kind-off-stays", false);
    await page.close();
  },
  async merge() {
    const page = await fresh();
    await open(page, /^Proxmox LXC/);
    note("hash", { url: page.url().split("#")[1] });
    note("focus-after-open", { active: await page.evaluate(() => document.activeElement?.textContent?.slice(0, 40)) });
    await field(page, "Node").fill("pve-3");
    await page.getByRole("button", { name: /Show 10 settings/ }).click();
    await field(page, "Memory kept free (MiB)").fill("6144");
    await page.waitForTimeout(200);
    await shot(page, "03-backend-two-edits", false);
    await panel(page, async () => { await page.getByRole("button", { name: "An agent runs bb box config apply" }).click(); });
    await page.waitForTimeout(400);
    await page.getByText("Changed elsewhere to").first().scrollIntoViewIfNeeded();
    note("conflict-shown", { notes: await page.getByText("Changed elsewhere to").count(), node: await field(page, "Node").inputValue(), bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText() });
    await shot(page, "04-conflict-inline", false);
    await page.getByRole("button", { name: "Use theirs" }).first().click();
    await page.waitForTimeout(200);
    note("after-use-theirs", { memory: await field(page, "Memory kept free (MiB)").inputValue(), node: await field(page, "Node").inputValue(), bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText() });
    await page.getByRole("button", { name: "Replace the API token secret" }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.getByRole("button", { name: "Replace the API token secret" }).first().click();
    await page.getByLabel("API token secret").first().fill("new-token");
    await panel(page, async () => { await page.getByRole("button", { name: "An agent runs bb box config apply" }).click(); });
    await page.waitForTimeout(400);
    note("secret-conflict", { text: (await page.getByText(/Replaced elsewhere while you edited/).first().innerText().catch(() => "none")) });
    await page.getByText(/Replaced elsewhere while you edited/).first().scrollIntoViewIfNeeded();
    await shot(page, "05-secret-conflict", false);
    await page.getByRole("button", { name: "Keep mine" }).first().click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1300);
    note("saved", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText().catch(() => "gone") });
    await shot(page, "06-saved", false);
    await page.close();
  },
  async rebased() {
    const page = await fresh();
    await open(page, /^Proxmox LXC/);
    await field(page, "Node").fill("pve-4");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(200);
    await panel(page, async () => { await page.getByRole("button", { name: "An agent runs bb box config apply" }).click(); });
    await page.waitForTimeout(1800);
    note("rebased", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText().catch(() => "gone") });
    await page.close();
  },
  async lost() {
    const page = await fresh();
    await panel(page, async () => { await page.getByRole("button", { name: "Saves, reply lost" }).click(); });
    await open(page, /^Proxmox LXC/);
    await field(page, "Node").fill("pve-5");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(2250);
    note("lost-pending", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText() });
    await shot(page, "07-not-confirmed", false);
    await page.waitForTimeout(1000);
    note("lost-reconciled", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText().catch(() => "gone") });
    await shot(page, "08-reconciled", false);
    await page.close();
  },
  async refused() {
    const page = await fresh();
    await panel(page, async () => { await page.getByRole("button", { name: "Is refused" }).click(); });
    await open(page, /^Proxmox LXC/);
    await field(page, "Node").fill("pve-6");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(1000);
    note("refused", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText(), node: await field(page, "Node").inputValue() });
    await shot(page, "09-refused", false);
    await page.close();
  },
  async submitted() {
    const page = await fresh();
    await open(page, /^Monitor/);
    const input = page.getByRole("textbox", { name: "Refresh every, in seconds" });
    await input.fill("10");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForTimeout(150);
    await input.fill("15");
    await page.waitForTimeout(1200);
    note("submitted-version", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText(), value: await input.inputValue() });
    await shot(page, "10-saved-earlier-change", false);
    await page.waitForTimeout(2600);
    await input.fill("20");
    await input.press("Enter");
    await page.waitForTimeout(1100);
    note("enter-saves", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText().catch(() => "gone") });
    await page.close();
  },
  async drafts() {
    const page = await fresh();
    await open(page, /^Proxmox LXC/);
    await field(page, "Node").fill("pve-7");
    await page.getByRole("button", { name: "Replace the API token secret" }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
    await page.getByRole("button", { name: "Replace the API token secret" }).first().click();
    await page.getByLabel("API token secret").first().fill("pasted-secret");
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "BB Box", exact: true }).click();
    await page.waitForTimeout(400);
    note("overview-chip", { chips: await page.getByText("Unsaved changes").count() });
    await shot(page, "11-unsaved-chip", false);
    await open(page, /^Proxmox LXC/);
    note("draft-after-sidebar", { node: await field(page, "Node").inputValue() });
    await page.reload();
    await page.waitForTimeout(600);
    note("after-reload", { url: page.url().split("#")[1], restored: await page.getByText(/unsaved changes to .* are back/).innerText().catch(() => "none"), node: await field(page, "Node").inputValue().catch(() => "none") });
    await shot(page, "12-restored-after-reload", false);
    await page.goBack();
    await page.waitForTimeout(400);
    note("back", { url: page.url().split("#")[1] ?? "(overview)", focused: await page.evaluate(() => document.activeElement?.getAttribute("data-row-key")) });
    await page.close();
  },
  async files() {
    const page = await fresh();
    await open(page, /^Boxes/);
    await panel(page, async () => { await page.getByRole("button", { name: "Is refused" }).click(); });
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(".config/tool.json");
    await page.getByRole("textbox", { name: "New file's content" }).fill('{"token":"x"}');
    await page.getByRole("button", { name: "Save files" }).click();
    await page.waitForTimeout(1000);
    note("file-refused", { content: await page.getByRole("textbox", { name: "New file's content" }).inputValue(), message: await page.locator("[role=region][aria-label='Save files for every box'] [role=status]").innerText() });
    await page.getByRole("textbox", { name: "New file's content" }).scrollIntoViewIfNeeded();
    await shot(page, "13-file-kept", false);
    await page.close();
  },
  async setup() {
    const page = await fresh({ scenario: "First run" });
    await shot(page, "14-first-run");
    await page.getByRole("button", { name: /Choose another backend/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /^Proxmox LXC/ }).first().click();
    await page.waitForTimeout(300);
    await shot(page, "15-setup");
    await page.getByRole("button", { name: "Save and turn on" }).click();
    await page.waitForTimeout(1000);
    note("setup-problems", { focused: await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText() });
    await shot(page, "16-setup-problems", false);
    await field(page, "API URL").fill("https://192.0.2.10:8006/api2/json");
    await page.getByRole("button", { name: "Save, keep it off" }).click();
    await page.waitForTimeout(1200);
    note("landed", { url: page.url().split("#")[1], heading: await page.locator("[data-page-heading]").first().innerText() });
    await shot(page, "17-not-finished", false);
    await page.goBack();
    await page.waitForTimeout(400);
    note("back-from-new", { url: page.url().split("#")[1] ?? "(overview)" });
    await shot(page, "18-first-run-resume");
    await page.close();
  },
  async firstrunStates() {
    for (const [label, name] of [["Missing", "19-docker-missing"], ["No access", "20-docker-permission"], ["Low disk", "21-docker-disk"]]) {
      const page = await fresh({ scenario: "First run" });
      await panel(page, async () => { await page.getByRole("button", { name: label, exact: true }).click(); });
      await shot(page, name, false);
      await page.close();
    }
    const page = await fresh({ scenario: "First run" });
    await page.getByRole("button", { name: "Use Docker on bb-1" }).click();
    await page.waitForTimeout(6500);
    note("after-docker", { status: await page.locator("section[aria-label=Status] p").first().innerText().catch(() => "none") });
    await shot(page, "22-docker-ready");
    await page.close();
  },
  async problems() {
    const page = await fresh({ scenario: "Problems" });
    await shot(page, "23-problems");
    await page.getByRole("button", { name: /^Open Tart/ }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Check again" }).click();
    await page.waitForTimeout(1700);
    note("tart-still-failing", { words: await page.getByText("Not working").count() });
    await panel(page, async () => { await page.getByRole("button", { name: /Bring mac-1 back/ }).click(); });
    await page.getByRole("button", { name: "Check again" }).click();
    await page.waitForTimeout(1700);
    note("tart-recovered", { ready: await page.getByText("Ready", { exact: true }).count() });
    await page.close();
  },
  async kindPage() {
    const page = await fresh();
    await open(page, /^Windows desktop\s/);
    await shot(page, "24-kind");
    await page.close();
    const narrow = await fresh({ width: 390, height: 844, scenario: "Problems" });
    await narrow.getByRole("button", { name: /^Windows desktop\s/ }).first().click();
    await narrow.waitForTimeout(300);
    await narrow.getByRole("textbox", { name: "Small Cores" }).fill("0");
    await narrow.getByRole("button", { name: "Save", exact: true }).click();
    await narrow.waitForTimeout(1100);
    note("narrow-kind-error", { focused: await narrow.evaluate(() => document.activeElement?.getAttribute("aria-label")), inView: await narrow.evaluate(() => { const r = document.activeElement.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }) });
    await shot(narrow, "25-narrow-kind", false);
    await narrow.close();
  },
  async narrowBackend() {
    const page = await fresh({ width: 390, height: 844 });
    await open(page, /^Proxmox LXC/);
    await shot(page, "26-narrow-backend");
    await page.close();
    const overview = await fresh({ width: 390, height: 844 });
    await shot(overview, "27-narrow-overview");
    await overview.close();
  },
  async find() {
    const page = await fresh();
    const box = page.getByRole("combobox", { name: "Find a setting" });
    for (const query of ["iOS memory", "CPU desktop", "turn off monitor", "mac-1 cores", "memory"]) {
      await box.fill(query);
      await page.waitForTimeout(200);
      note(`find:${query}`, { count: await page.getByRole("option").count(), first: await page.getByRole("option").first().innerText().catch(() => "none") });
    }
    await box.fill("mac-1 cores");
    await page.waitForTimeout(200);
    await shot(page, "28-find", false);
    await box.press("Enter");
    await page.waitForTimeout(600);
    note("find-open", { url: page.url().split("#")[1], focused: await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), query: await page.getByRole("combobox", { name: "Find a setting" }).inputValue() });
    await shot(page, "29-found-mac-field", false);
    await page.close();
  },
  async keyboard() {
    const page = await fresh();
    for (let index = 0; index < 60; index += 1) {
      await page.keyboard.press("Tab");
      if ((await page.evaluate(() => document.activeElement?.getAttribute("data-row-key") ?? "")).startsWith("backend-")) break;
    }
    note("tab-row", { focused: await page.evaluate(() => document.activeElement?.getAttribute("data-row-key")), ring: await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow) });
    await shot(page, "30-focus-ring", false);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    note("enter-opens", { focused: await page.evaluate(() => document.activeElement?.hasAttribute("data-page-heading")), url: page.url().split("#")[1] });
    await page.goBack();
    await page.waitForTimeout(300);
    note("back-restores-row", { focused: await page.evaluate(() => document.activeElement?.getAttribute("data-row-key")) });
    await page.close();
  },
  async monitorRow() {
    const page = await fresh();
    await page.getByRole("switch", { name: "Monitor: machine status in BB's sidebar" }).click();
    await page.waitForTimeout(1100);
    note("monitor-row", { note: await page.getByText("The sidebar's machine status changes").innerText().catch(() => "none") });
    await page.getByRole("switch", { name: "Monitor: machine status in BB's sidebar" }).scrollIntoViewIfNeeded();
    await shot(page, "31-monitor-row", false);
    await page.close();
  },
  async remove() {
    const page = await fresh();
    await open(page, /^Namespace/);
    await page.getByRole("button", { name: /More for Namespace/ }).click();
    await page.getByRole("menuitem", { name: /Remove backend/ }).click();
    await page.waitForTimeout(300);
    await shot(page, "32-remove-confirm", false);
    await page.close();
  },
  async tailnet() {
    const page = await fresh();
    await open(page, /^Network/);
    await page.getByRole("radio", { name: "No: BB is reached without one" }).click();
    await page.waitForTimeout(200);
    note("tailnet-staged", { bar: await page.locator("[role=region][aria-label^=Save] [role=status]").innerText() });
    await shot(page, "33-tailnet-staged", false);
    await page.close();
  },
};
const only = process.argv[4] ? new Set(process.argv[4].split(",")) : null;
for (const [name, step] of Object.entries(steps).filter(([name]) => !only || only.has(name))) {
  try { await step(); } catch (error) { errors.push(`step ${name}: ${error.message.split("\n")[0]}`); console.log(`FAILED ${name}: ${error.message.split("\n")[0]}`); }
}
console.log("ERRORS", JSON.stringify([...new Set(errors)]));
await browser.close();
