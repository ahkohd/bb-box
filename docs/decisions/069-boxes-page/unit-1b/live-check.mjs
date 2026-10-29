import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const home = process.env.HOME;
const base = process.env.LIVE_BASE ?? "http://127.0.0.1:7801";
const project = process.env.LIVE_PROJECT;
const shots = join(home, "shots");
mkdirSync(shots, { recursive: true });
const report = join(home, "live-report.md");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const line = (text) => {
  console.log(text);
  appendFileSync(report, `${text}\n`);
};
const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

function bb(args) {
  return execFileSync(process.env.LIVE_BBC ?? join(home, "bbc"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function rpc(method, input = null) {
  const response = await fetch(`${base}/api/v1/plugins/bb-box/rpc/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  const body = await response.json();
  if (!body.ok) throw new Error(body.error?.message ?? JSON.stringify(body));
  return body.result;
}

async function view(boxId) {
  const entry = (await rpc("allBoxes")).find((candidate) => candidate.box.id === boxId);
  return entry?.box ?? null;
}

async function waitFor(check, what, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(500);
  }
}

const tracePath = join(home, "agent-trace.log");
async function agent(thread, tool, args = {}) {
  const before = existsSync(tracePath) ? readFileSync(tracePath, "utf8").length : 0;
  bb(["thread", "tell", thread, `CALL ${tool} ${JSON.stringify(args)}`]);
  return waitFor(() => {
    const added = readFileSync(tracePath, "utf8").slice(before);
    const match = new RegExp(`result ${tool}: (.*)`).exec(added);
    return match ? match[1] : null;
  }, `the agent's ${tool}`, 600_000);
}

function events(boxId) {
  const db = new DatabaseSync(join(process.env.LIVE_DATA ?? join(home, "bbdata"), "plugins", "bb-box", "box-log.db"), { readOnly: true });
  try {
    return db.prepare("SELECT seq, at, kind, who, agent, why, words, observed FROM box_events WHERE box = ? ORDER BY seq").all(boxId);
  } finally {
    db.close();
  }
}

const who = (by) => (by ? (by.is === "agent" ? `agent in ${by.threadId}` : by.is === "bb-box" ? `bb-box: ${by.why}` : by.is) : "nothing said");

writeFileSync(report, `# Live check, ${new Date().toISOString()}\n\n`);
await waitFor(async () => (await rpc("kinds")).some((kind) => kind.id === "linux"), "the linux kind", 1_200_000);

const spawned = JSON.parse(bb(["thread", "spawn", "--project", project, "--environment", join(home, "proj"), "--provider", "acp-tools", "--prompt", "CALL box_list", "--json"]));
const thread = spawned.id;
await waitFor(() => existsSync(tracePath) && readFileSync(tracePath, "utf8").includes("result box_list"), "the first turn");
line(`Thread ${thread}, on the custom ACP agent acp-tools.`);
const acquired = await agent(thread, "box_acquire", { kind: "linux" });
const name = /^Box (\S+) \((bx[a-z2-7]{12})\)/.exec(acquired)?.[1];
const boxId = /^Box \S+ \((bx[a-z2-7]{12})\)/.exec(acquired)?.[1];
expect(name && boxId, `box_acquire said: ${acquired}`);
line(`box_acquire by the agent: ${name} (${boxId}).`);
let box = await view(boxId);
expect(box.state === "ready", `state ${box.state}`);
line(`- made and ready: lastStart by ${who(box.log.lastStart.by)}, first ${box.log.lastStart.first}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${base}/plugins/bb-box/desktop`);
if (await page.getByText("Skip setup").waitFor({ timeout: 8000 }).then(() => true, () => false)) {
  await page.getByText("Skip setup").click();
  await pause(2000);
  await page.goto(`${base}/plugins/bb-box/desktop`);
}
const row = page.locator("[data-resource-row]", { hasText: name }).first();
await row.waitFor({ timeout: 60_000 });
await row.getByRole("button", { name: "Stop", exact: true }).click();
box = await waitFor(async () => {
  const now = await view(boxId);
  return now?.state === "stopped" ? now : null;
}, "the person's stop");
await page.screenshot({ path: join(shots, "person-stopped.png") });
line(`- the person, Stop on the Boxes page: ${box.state}, lastStop by ${who(box.log.lastStop.by)}`);
expect(box.log.lastStop.by?.is === "person", "the person's stop");

await row.getByRole("button", { name: "Start", exact: true }).click();
box = await waitFor(async () => {
  const now = await view(boxId);
  return now?.state === "ready" && now.log.lastStart?.readyAt ? now : null;
}, "the person's start");
line(`- the person, Start on the Boxes page: ${box.state}, lastStart by ${who(box.log.lastStart.by)}, asked ${new Date(box.log.lastStart.askedAt).toISOString()}, ready ${new Date(box.log.lastStart.readyAt).toISOString()} (${box.log.lastStart.readyAt - box.log.lastStart.askedAt} ms)`);
expect(box.log.lastStart.by?.is === "person", "the person's start");

const stopped = bb(["box", "stop", name, "--thread", thread]);
box = await view(boxId);
line(`- a command, bb box stop: "${stopped.trim()}", lastStop by ${who(box.log.lastStop.by)}`);
expect(box.log.lastStop.by?.is === "command", "the command's stop");
const started = JSON.parse(bb(["box", "start", name, "--thread", thread, "--json"]));
line(`- a command, bb box start --json: ${started.state}, lastStart by ${who(started.log.lastStart.by)}, ready after ${started.log.lastStart.readyAt - started.log.lastStart.askedAt} ms`);
expect(started.log.lastStart.by?.is === "command", "the command's start");

const agentStop = await agent(thread, "box_stop", { box: name });
box = await view(boxId);
line(`- an agent, box_stop: "${agentStop.slice(0, 60)}", lastStop by ${who(box.log.lastStop.by)}`);
expect(box.log.lastStop.by?.is === "agent" && box.log.lastStop.by.threadId === thread, "the agent's stop");
await agent(thread, "box_start", { box: name });
box = await view(boxId);
line(`- an agent, box_start: ${box.state}, lastStart by ${who(box.log.lastStart.by)}`);
expect(box.log.lastStart.by?.is === "agent", "the agent's start");

const container = execFileSync("/usr/bin/docker", ["ps", "--filter", `label=bbbox.box=${boxId}`, "--format", "{{.Names}}"], { encoding: "utf8" }).trim() || execFileSync("/usr/bin/docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n").find((each) => each.includes(boxId.slice(2, 8))) || "";
expect(container, "the box's container");
execFileSync("/usr/bin/docker", ["stop", container]);
line(`- outside bb-box: docker stop ${container} on the host`);
bb(["box", "sweep"]);
box = await waitFor(async () => {
  const now = await view(boxId);
  return now?.state === "stopped" ? now : null;
}, "the sweep to find it stopped");
line(`  the sweep found it ${box.state}; lastStop by ${who(box.log.lastStop.by)}, asked ${box.log.lastStop.asked}; the row says: ${box.stopped}`);
expect(box.log.lastStop.by?.is === "outside" && !box.log.lastStop.asked, "the outside stop");
await page.reload();
await page.locator("[data-resource-row]", { hasText: name }).first().waitFor();
await page.screenshot({ path: join(shots, "outside-stopped.png") });

line("");
line("Every event of the box, from box-log.db:");
line("");
line("| # | Time (UTC) | Kind | Who | Why or words |");
line("| --- | --- | --- | --- | --- |");
for (const event of events(boxId)) line(`| ${event.seq} | ${new Date(event.at).toISOString().slice(11, 23)} | ${event.kind} | ${event.who}${event.agent ? ` (${event.agent})` : ""} | ${(event.why ?? event.words ?? "").slice(0, 80)} |`);
writeFileSync(join(home, "live-box.json"), JSON.stringify({ boxId, name, thread, container }));
await browser.close();
