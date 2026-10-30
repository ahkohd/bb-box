import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "screenshots";
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.DEMO_CDP_URL ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0];
await page.emulateMedia({ colorScheme: "dark" });
const pause = (ms) => page.waitForTimeout(ms);
const shoot = async (name) => {
  await page.mouse.move(1279, 799);
  await pause(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name);
};
const button = (name, options = {}) => page.getByRole("button", { name, ...options });

await page.goto(process.env.DEMO_BB_URL ?? "http://localhost:4999/", { waitUntil: "networkidle" });
await pause(1500);
await page.getByRole("textbox", { name: "Ask anything." }).click();
await page.keyboard.type("Get a Linux desktop box and open getbb.app on it.");
await page.keyboard.press("Enter");
await page.getByText(/is open on/).first().waitFor({ timeout: 240000 });
await pause(1000);

await button("Show right panel (Ctrl + J)").click();
await pause(600);
await button("Open new tab (Ctrl + T)").click();
await pause(400);
await button("Box", { exact: true }).click();
await pause(800);
await button("Maximize pane").click();
await pause(1200);

await button("New box").click();
await pause(1500);
await shoot("new-box-form");

await button("Create box").click();
await page.getByRole("button", { name: "Open terminal" }).nth(1).waitFor({ timeout: 120000 });
await page.getByText(/BB machine in/).nth(1).waitFor({ timeout: 120000 });
await pause(1500);
await shoot("box-panel");

await button("Open desktop").first().click();
await pause(6000);
await shoot("desktop-box");

await button("Box", { exact: true }).click();
await pause(800);
await button("Open terminal").nth(1).click();
await page.getByText("Connected").first().waitFor({ timeout: 60000 });
await pause(1500);
await page.locator(".xterm").last().click();
await page.keyboard.type("uname -sm && nproc", { delay: 40 });
await page.keyboard.press("Enter");
await pause(2000);
await shoot("terminal-box");

await browser.close().catch(() => {});
