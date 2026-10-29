import { chromium } from "playwright";
const base = "http://127.0.0.1:38990";
const out = "/home/box/bbtest/shots";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const log = [];
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const probe = async () => {
  const el = page.locator("[data-probe]").first();
  const found = await el.count();
  if (!found) return { url: page.url(), probe: null };
  return { url: page.url(), mount: await el.getAttribute("data-mount"), hash: await el.getAttribute("data-hash"), count: await el.getAttribute("data-count") };
};
const step = async (name, fn) => {
  try { await fn(); await page.waitForTimeout(900); log.push({ step: name, ...(await probe()) }); }
  catch (error) { log.push({ step: name, error: error.message.split("\n")[0], url: page.url() }); }
  console.log(JSON.stringify(log[log.length - 1]));
};
await step("0 open home", async () => { await page.goto(base + "/", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000); await page.getByRole("button", { name: "Skip setup" }).click({ timeout: 8000 }).catch(() => page.getByText("Skip setup").click({ timeout: 5000 })); await page.waitForTimeout(3000); await page.screenshot({ path: `${out}/00-home.png`, timeout: 10000 }); });
await step("1 deep link /settings/plugins/hashprobe#backend/x", async () => { await page.goto(base + "/settings/plugins/hashprobe#backend/x", { waitUntil: "domcontentloaded" }); await page.locator("[data-probe]").waitFor({ timeout: 20000 }); await page.screenshot({ path: `${out}/01-probe.png` }); });
await step("2 count", async () => { await page.locator('[data-act="count"]').click(); });
await step("3 pushState keeping router state -> #backend/docker", async () => { await page.locator('[data-act="push-keep"]').click(); });
await step("4 location.hash = option/monitor", async () => { await page.locator('[data-act="assign"]').click(); });
await step("5 pushState null state -> #kind/linux", async () => { await page.locator('[data-act="push-null"]').click(); });
await step("6 back", async () => { await page.goBack(); });
await step("7 back", async () => { await page.goBack(); });
await step("8 back", async () => { await page.goBack(); });
await step("9 forward", async () => { await page.goForward(); });
await step("10 reload", async () => { await page.reload({ waitUntil: "domcontentloaded" }); await page.locator("[data-probe]").waitFor({ timeout: 20000 }); });
await step("11 replaceState -> #backend/new", async () => { await page.locator('[data-act="replace"]').click(); });
await step("12 BB sidebar: General", async () => { await page.getByRole("link", { name: "General", exact: true }).first().click(); });
await step("13 back after BB sidebar", async () => { await page.goBack(); await page.locator("[data-probe]").waitFor({ timeout: 10000 }).catch(() => {}); });
await step("14 UrlLink to self with hash", async () => { await page.locator('[data-act="urllink-self"]').click(); });
await step("15 UrlLink to bb-box with hash", async () => { await page.locator('[data-act="urllink-bbbox"]').click(); await page.waitForTimeout(1500); await page.screenshot({ path: `${out}/15-bbbox.png`, fullPage: true }); });
await step("16 back to probe", async () => { await page.goBack(); await page.locator("[data-probe]").waitFor({ timeout: 10000 }).catch(() => {}); });
await step("17 openUrl with hash", async () => { await page.locator('[data-act="openurl"]').click(); log.push({ openUrlReturned: await page.evaluate(() => window.__openUrl) }); });
await step("18 bb-box settings page fresh", async () => { await page.goto(base + "/settings/plugins/bb-box", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(5000); await page.screenshot({ path: `${out}/18-bbbox-settings.png` }); });
await step("19 hash on bb-box after load", async () => { await page.goto(base + "/settings/plugins/bb-box#backend/docker", { waitUntil: "domcontentloaded" }); await page.waitForTimeout(4000); });
const header = await page.evaluate(() => { const main = document.querySelector("main"); return main ? main.innerText.slice(0, 600) : document.body.innerText.slice(0, 600); });
console.log(JSON.stringify({ log, errors, header }, null, 1));
await browser.close();
