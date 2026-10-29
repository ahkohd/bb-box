import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const base = process.env.LIVE_BB ?? "http://127.0.0.1:38990";
const out = process.env.LIVE_SHOTS ?? join(process.cwd(), "screens");
mkdirSync(out, { recursive: true });

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function otherTab(change) {
  const state = await rpc("config.get");
  const result = await rpc("config.apply", { draft: change(structuredClone(state.document)), revision: state.revision });
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.state;
}

async function reset() {
  await otherTab((document) => {
    const { monitor: _monitor, ...rest } = document;
    return { ...rest, general: { files: [{ path: ".pi/agent/models.json", content: "{}" }, { path: ".cfg/tool.json", content: "{}" }] } };
  });
}

const APPLY = "**/api/v1/plugins/bb-box/rpc/config.apply";
const browser = await chromium.launch();
const shots = [];

async function shot(page, name) {
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  shots.push(file);
}

async function open(page, hash, heading) {
  await page.goto(`${base}/settings/plugins/bb-box${hash}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

async function scrollToBottom(page) {
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) if (element.scrollHeight > element.clientHeight + 10 && getComputedStyle(element).overflowY !== "visible") element.scrollTop = element.scrollHeight;
  });
}

for (const scheme of ["light", "dark"]) {
  for (const width of [1440, 760, 390]) {
    await reset();
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: scheme });
    const page = await context.newPage();
    const tag = `${width}-${scheme}`;

    await open(page, "#option/monitor", "Monitor");
    await page.getByRole("textbox", { name: "Refresh every, in seconds" }).fill("12");
    await shot(page, `monitor-draft-${tag}`);
    await otherTab((document) => ({ ...document, monitor: { refreshIntervalSeconds: 8 } }));
    await page.getByText(/^Changed elsewhere to/).first().waitFor();
    await shot(page, `monitor-conflict-${tag}`);
    await page.getByRole("button", { name: "Keep mine" }).click();
    await page.route(APPLY, (route) => route.abort("failed"), { times: 1 });
    await page.getByRole("region", { name: "Save the Monitor" }).getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/^Save not confirmed: BB Box has no receipt for it yet/).waitFor();
    await shot(page, `monitor-not-confirmed-${tag}`);
    await page.getByRole("button", { name: "BB Box settings" }).click();
    await page.locator('[data-row-key="option-monitor"]').waitFor();
    await shot(page, `overview-unsaved-${tag}`);

    await page.locator('[data-row-key="option-boxes"]').click();
    await page.getByRole("heading", { name: "Boxes", exact: true }).waitFor();
    await page.getByRole("textbox", { name: "Boxes per thread" }).fill("4");
    await page.getByRole("button", { name: "Replace the content of ~/.cfg/tool.json" }).click();
    await page.getByRole("textbox", { name: "New content for ~/.cfg/tool.json" }).fill('{ "made-up": true }');
    await page.getByRole("button", { name: "Add file" }).click();
    await page.getByRole("textbox", { name: "New file's path under the box user's home" }).fill(".pi/agent/models.json");
    await page.getByRole("textbox", { name: "Content of ~/.pi/agent/models.json" }).fill("{}");
    await scrollToBottom(page);
    await shot(page, `boxes-drafts-${tag}`);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText(/^Your unsaved changes to files for every box are back/).waitFor();
    await shot(page, `boxes-restored-${tag}`);
    await context.close();
  }
}

await reset();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const focused = async () =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return "(nothing: the page's body)";
    const name = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 60) ?? "";
    const role = element.getAttribute("role") ?? element.tagName.toLowerCase();
    const ring = getComputedStyle(element).boxShadow !== "none" || getComputedStyle(element).outlineStyle !== "none";
    return `${role} "${name}"${ring ? " (ring)" : ""}`;
  });
const keys = [];
const press = async (key, note) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(150);
  keys.push(`${key}${note ? ` (${note})` : ""} → ${await focused()}`);
};

await open(page, "#option/monitor", "Monitor");
await page.getByRole("heading", { name: "Monitor", exact: true }).focus();
keys.push(`start → ${await focused()}`);
for (let step = 0; step < 6; step += 1) {
  await press("Tab");
  if ((await focused()).includes("Refresh every")) break;
}
await page.keyboard.type("12");
keys.push(`type 12 → ${await focused()}`);
await shot(page, "keys-01-field-focused");
await press("Enter", "saves");
await page.getByText(/^Saved\.$/).waitFor();
keys.push(`bar → ${await page.getByRole("region", { name: "Save the Monitor" }).getByRole("status").textContent()}`);
await page.keyboard.press("Control+a");
await page.keyboard.type("20");
await otherTab((document) => ({ ...document, monitor: { refreshIntervalSeconds: 30 } }));
await page.getByText(/^Changed elsewhere to/).first().waitFor();
for (let step = 0; step < 8; step += 1) {
  await press("Tab");
  if ((await focused()).includes("Keep mine")) break;
}
await shot(page, "keys-02-keep-mine-focused");
await press("Enter", "Keep mine");
for (let step = 0; step < 12; step += 1) {
  await press("Tab");
  if (/button "Save"/.test(await focused())) break;
}
await press("Enter", "Save");
await page.getByText(/^Saved\./).first().waitFor();
await page.waitForTimeout(300);
keys.push(`after Save → ${await focused()}`);
await shot(page, "keys-03-after-save");
const animations = await page.evaluate(() => document.getAnimations().length);
keys.push(`animations running: ${animations}`);

await open(page, "#option/boxes", "Boxes");
await page.getByRole("button", { name: "Add file" }).focus();
await press("Enter", "Add file");
for (let step = 0; step < 14 && !(await focused()).includes("New file's path"); step += 1) await press("Tab");
await page.keyboard.type(".cfg/keys.json");
await press("Tab");
await page.keyboard.type('{"made-up": 1}');
for (let step = 0; step < 6; step += 1) {
  await press("Tab");
  if ((await focused()).includes("Save files")) break;
}
await shot(page, "keys-04-save-files-focused");
await press("Enter", "Save files");
await page.getByText("~/.cfg/keys.json").waitFor();
keys.push(`saved file listed → yes`);
const stored = await rpc("config.get");
keys.push(`stored: refresh ${stored.document.monitor?.refreshIntervalSeconds}, files ${stored.document.general.files.map((file) => file.path).join(", ")}`);
await context.close();
await browser.close();
writeFileSync(join(out, "keys.txt"), keys.join("\n") + "\n");
console.log(keys.join("\n"));
console.log(`${shots.length} screenshots in ${out}`);
