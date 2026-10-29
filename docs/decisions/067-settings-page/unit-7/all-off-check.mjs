import { chromium } from "playwright";
const base = "http://127.0.0.1:38990";
const run = process.env.LIVE_RUN ?? "1";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}
const here = (await rpc("setup.offer")).machines.find((machine) => machine.here);
await rpc("setup.docker", { hostId: here.hostId });
for (let i = 0; i < 120 && !(await rpc("config.get")).setupDone; i += 1) await pause(1000);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const out = {};
try {
  await page.goto(`${base}/settings/plugins/bb-box`, { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip setup" });
  await Promise.race([skip.waitFor({ timeout: 6000 }).catch(() => {}), page.locator("[data-settings-view]").waitFor({ timeout: 6000 }).catch(() => {})]);
  if (await skip.count()) {
    await skip.click();
    await pause(500);
    await page.goto(`${base}/settings/plugins/bb-box`, { waitUntil: "domcontentloaded" });
  }
  await page.locator("[data-settings-view]").waitFor();
  await pause(1500);
  const toggle = page.getByRole("switch", { name: /: takes new boxes$/ }).first();
  await toggle.click();
  const callout = page.getByRole("region", { name: "Things that need you" });
  await callout.getByText("Every backend is off").waitFor({ timeout: 30000 });
  out.callout = (await callout.innerText()).replace(/\s+/g, " ");
  out.stored = (await rpc("config.get")).document.backends.map((backend) => [backend.id, backend.enabled]);
  await page.screenshot({ path: `run${run}-all-off.png`, fullPage: true });
  await callout.getByRole("button", { name: "Show the backends' switches" }).click();
  out.focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  out.hash = new URL(page.url()).hash;
  await page.keyboard.press("Space");
  for (let i = 0; i < 30 && !(await rpc("config.get")).document.backends.some((backend) => backend.enabled); i += 1) await pause(1000);
  out.after = (await rpc("config.get")).document.backends.map((backend) => [backend.id, backend.enabled]);
  await pause(1500);
  out.calloutAfter = (await callout.count()) ? (await callout.innerText()).replace(/\s+/g, " ") : null;
  out.ok = out.callout.includes("Fix: Turn a backend on with its switch below.") && /takes new boxes$/.test(out.focused ?? "") && out.hash === "" && out.after.every(([, on]) => on) && !(out.calloutAfter ?? "").includes("Every backend is off");
} catch (error) {
  out.ok = false;
  out.error = error.message;
}
console.log(JSON.stringify(out));
await browser.close();
process.exitCode = out.ok ? 0 : 1;
