import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const home = process.env.HOME;
export const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
export const boxes = `${base}/plugins/bb-box/desktop`;
export const settingsUrl = `${base}/settings/plugins/bb-box`;
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function bb(args) {
  return execFileSync(join(home, "bbc"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function bbMay(args) {
  try {
    return { ok: true, out: bb(args) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

export async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

export async function waitFor(check, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ""}`);
    await pause(400);
  }
}

export function flag(name) {
  mkdirSync(join(home, "flags"), { recursive: true });
  writeFileSync(join(home, "flags", name), "");
}

export function docker(args) {
  return execFileSync("/usr/bin/docker", args, { encoding: "utf8" }).trim();
}

export function containerOf(boxId) {
  const lines = docker(["ps", "-a", "--format", "{{.Names}} {{.Labels}}"]).split("\n");
  return lines.find((line) => line.includes(boxId))?.split(" ")[0] ?? null;
}

const tracePath = join(home, "agent-trace.log");

export function agentStart(thread, tool, args = {}) {
  const before = existsSync(tracePath) ? readFileSync(tracePath, "utf8").length : 0;
  bb(["thread", "tell", thread, `CALL ${tool} ${JSON.stringify(args)}`]);
  return before;
}

export async function agentResult(tool, before, timeout = 600_000) {
  return waitFor(() => {
    const added = readFileSync(tracePath, "utf8").slice(before);
    return new RegExp(`result ${tool}: (.*)`).exec(added)?.[1] ?? null;
  }, `the agent's ${tool}`, timeout);
}

export async function agent(thread, tool, args = {}) {
  return agentResult(tool, agentStart(thread, tool, args));
}

export function events(boxId) {
  const db = new DatabaseSync(join(home, "bbdata", "plugins", "bb-box", "box-log.db"), { readOnly: true });
  try {
    return db.prepare("SELECT seq, at, kind, who, agent, words FROM box_events WHERE box = ? ORDER BY seq").all(boxId);
  } finally {
    db.close();
  }
}

export function makeReport(label) {
  const dir = join(home, "live-results");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${label}.md`);
  const json = join(dir, `${label}.json`);
  writeFileSync(file, `# Live check ${label}, ${new Date().toISOString()}\n\n`);
  const results = [];
  const line = (text) => {
    console.log(text);
    appendFileSync(file, `${text}\n`);
  };
  const check = async (gate, name, run) => {
    const began = Date.now();
    try {
      const detail = await run();
      results.push({ gate, name, ok: true, detail: detail ?? null, ms: Date.now() - began });
      line(`- PASS [${gate}] ${name}${detail ? `: ${detail}` : ""}`);
    } catch (error) {
      results.push({ gate, name, ok: false, detail: error.message, ms: Date.now() - began });
      line(`- FAIL [${gate}] ${name}: ${error.message}`);
    }
    writeFileSync(json, JSON.stringify(results, null, 2));
  };
  return { line, check, results };
}

export function expect(condition, message) {
  if (!condition) throw new Error(message);
}

export const pathOf = (page) => decodeURIComponent(new URL(page.url()).pathname);

export async function historyLength(page) {
  return page.evaluate(() => window.history.length);
}

export async function skipSetup(page) {
  await page.goto(base);
  if (await page.getByText("Skip setup").waitFor({ timeout: 6000 }).then(() => true, () => false)) {
    await page.getByText("Skip setup").click();
    await pause(1500);
  }
}

export async function heading(page) {
  const h1 = page.locator("h1[data-page-heading]");
  await h1.waitFor({ timeout: 20_000 });
  return h1;
}

export async function focusIsHeading(page) {
  return page.evaluate(() => document.activeElement?.hasAttribute("data-page-heading") ?? false);
}

export async function menuItems(page) {
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu.getByRole("menuitem").evaluateAll((nodes) => nodes.map((node) => `${node.textContent?.trim()}${node.hasAttribute("data-disabled") ? " (disabled)" : ""}`));
}

export async function openBoxMenu(page, name) {
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: `${name} actions`, exact: true }).first().click();
  return menuItems(page);
}

export async function closeMenu(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached", timeout: 5000 }).catch(() => null);
}
