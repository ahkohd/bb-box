import { chromium } from "playwright";

const [, , threadId, action, shot] = process.argv;
const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const title = process.env.THREAD_TITLE ?? "Asks";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(base, { waitUntil: "domcontentloaded" });
try {
  await page.getByText("Skip setup").click({ timeout: 8000 });
  await page.waitForTimeout(2000);
} catch {
  console.log("no setup to skip");
}
await page.getByText(title, { exact: true }).first().click({ timeout: 15000 });
const dialog = page.getByRole("alertdialog", { name: /^Restore / });
try {
  await dialog.waitFor({ timeout: 15000 });
} catch {
  if (shot) await page.screenshot({ path: shot });
  console.log(`no form in thread ${threadId}; url ${page.url()}`);
  await browser.close();
  process.exit(2);
}
console.log((await dialog.innerText()).replace(/\n+/g, " | "));
if (shot) await page.screenshot({ path: shot });
if (action === "cancel") await dialog.getByRole("button", { name: "Cancel" }).click();
if (action === "restore") await dialog.getByRole("button", { name: /^Restore / }).click();
await page.waitForTimeout(3000);
console.log(`clicked ${action ?? "nothing"} at ${new Date().toISOString()}`);
await browser.close();
