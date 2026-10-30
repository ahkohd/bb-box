import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

const out = process.argv[2] ?? "screenshots";
mkdirSync(out, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.DEMO_CDP_URL ?? "http://127.0.0.1:9222");
const context = browser.contexts()[0];
const page = context.pages()[0];
const theme = process.env.DEMO_THEME === "light" ? "light" : "dark";
await page.emulateMedia({ colorScheme: theme });
const fileFor = (name) => `${out}/${theme === "light" ? name.replace(/(-2x)?$/, "-light$1") : name}.png`;
const pause = (ms) => page.waitForTimeout(ms);
const shoot = async (name) => {
  await page.mouse.move(1279, 799);
  await pause(800);
  await page.screenshot({ path: fileFor(name) });
  console.log(name);
};
const button = (name, options = {}) => page.getByRole("button", { name, ...options });
const bb = (...args) => execFileSync(process.env.BB_CLI ?? "bb", args, { encoding: "utf8" });
const bbJson = (...args) => JSON.parse(bb(...args, "--json"));
const monitorHeader = page.locator("[data-bb-box-monitor-header]");
const threadsOnServer = [
  ["Write the release notes", true],
  ["Run the test suite", true],
  ["Fix the sign-in redirect", false],
  ["Resize the hero images", false],
  ["Update the changelog", false],
  ["Check the broken links", false],
  ["Tidy the build cache", false],
];

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

await button("Box", { exact: true }).click();
await pause(800);
const desktopBox = (await page.locator('button[aria-label$=": details"]').first().getAttribute("aria-label")).replace(/: details$/, "");
await button("Open terminal").first().click();
await page.getByText("Connected").first().waitFor({ timeout: 60000 });
await pause(1500);
await page.locator(".xterm").last().click();
await page.keyboard.type("clear; sudo apt-get install -y -qq stress-ng >/dev/null 2>&1; stress-ng --cpu 3 --vm 1 --vm-bytes 3G --timeout 120s >/dev/null 2>&1 &", { delay: 10 });
await page.keyboard.press("Enter");
await pause(25000);

await button("Desktop", { exact: true }).click();
await pause(1500);
await button("Machine status").click();
await pause(1500);
await monitorHeader.getByRole("button", { name: "Machine", exact: true }).click();
await pause(800);
await page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").filter({ hasText: desktopBox }).first().click();
await pause(15000);
await button("Open", { exact: true }).click();
await pause(1000);
await page.screenshot({ path: fileFor("monitor") });
console.log("monitor");

await page.keyboard.press("Escape");
await pause(500);
await button("Box", { exact: true }).click();
await pause(800);

const server = bbJson("machine", "list").find((machine) => machine.machineProviderId === null);
const root = process.env.DEMO_PROJECT_ROOT ?? `${homedir()}/website`;
mkdirSync(root, { recursive: true });
const project = bbJson("project", "create", "--name", "website", "--root", root, "--machine", server.name);
for (const [title, working] of threadsOnServer) {
  const thread = bbJson("thread", "spawn", "--project", project.id, "--machine", server.name, "--environment", root, "--provider", "acp-demo", "--prompt", working ? "WORK" : "Done");
  bb("thread", "update", thread.id, "--title", title);
  await pause(1500);
}
await pause(5000);

await monitorHeader.getByRole("button", { name: "Machine", exact: true }).click();
await pause(800);
await page.getByRole("listbox", { name: "Machines" }).locator("[data-machine-index]").filter({ hasText: server.name }).first().click();
await pause(8000);
await monitorHeader.getByRole("button", { name: `Threads on ${server.name}`, exact: true }).click();
await pause(1500);
const panel = await page.locator("[data-bb-box-monitor-shell]").boundingBox();
const menu = await page.getByRole("menu").boundingBox();
const left = Math.min(panel.x, menu.x) - 8;
const top = Math.min(panel.y, menu.y) - 8;
const right = Math.max(panel.x + panel.width, menu.x + menu.width) + 8;
const bottom = Math.max(menu.y + menu.height, panel.y + 200) + 8;
await page.screenshot({ path: fileFor("monitor-threads-2x"), clip: { x: left, y: top, width: right - left, height: bottom - top } });
console.log("monitor-threads-2x");

await browser.close().catch(() => {});
