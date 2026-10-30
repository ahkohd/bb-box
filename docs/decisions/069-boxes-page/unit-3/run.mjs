import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";

const HOME = process.env.HOME;
const RUN = join(HOME, "run");
const run = promisify(execFile);
const Database = createRequire(join(HOME, "bb-box", "package.json"))("better-sqlite3");
const TICKS = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const MINUTE = 60_000;
const plan = JSON.parse(readFileSync(join(RUN, "plan.json"), "utf8"));
const boxes = JSON.parse(readFileSync(join(RUN, "boxes.json"), "utf8"));
const startedAt = plan.startedAt ?? Date.now();
if (!plan.startedAt) writeFileSync(join(RUN, "plan.json"), JSON.stringify({ ...plan, startedAt }, null, 2));

const note = (event, data = {}) => appendFileSync(join(RUN, "events.jsonl"), `${JSON.stringify({ at: Date.now(), minute: Math.round((Date.now() - startedAt) / MINUTE), event, ...data })}\n`);
const bbc = async (...args) => (await run(join(HOME, "bbc"), args, { encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 })).stdout;

function stat(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = text.lastIndexOf(")");
    const comm = text.slice(text.indexOf("(") + 1, close);
    const fields = text.slice(close + 2).split(" ");
    const rssPages = Number(fields[21]);
    return { pid, comm, ppid: Number(fields[1]), utime: Number(fields[11]), stime: Number(fields[12]), cutime: Number(fields[13]), cstime: Number(fields[14]), rssBytes: rssPages * 4096 };
  } catch {
    return null;
  }
}

function processes() {
  return readdirSync("/proc").filter((name) => /^\d+$/.test(name)).map(stat).filter(Boolean);
}

function historyFile() {
  const found = [];
  const walk = (folder, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === "box-history.db") found.push(path);
    }
  };
  walk(join(HOME, "bbdata"), 0);
  return found[0] ?? null;
}

const HISTORY = historyFile();

function serverPid() {
  for (const process of processes()) {
    try {
      for (const fd of readdirSync(`/proc/${process.pid}/fd`)) {
        if (readlinkSync(`/proc/${process.pid}/fd/${fd}`) === HISTORY) return process.pid;
      }
    } catch {
      continue;
    }
  }
  return null;
}

let server = serverPid();
let containers = new Map();

async function refreshContainers() {
  const ids = (await run("docker", ["ps", "-q", "--no-trunc"], { encoding: "utf8" })).stdout.trim().split("\n").filter(Boolean);
  const names = new Map();
  for (const id of ids) {
    const name = (await run("docker", ["inspect", "--format", "{{.Name}}", id], { encoding: "utf8" })).stdout.trim().replace(/^\//, "");
    names.set(id, name);
  }
  containers = names;
}

function containerCpu(id) {
  for (const path of [`/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat`, `/sys/fs/cgroup/docker/${id}/cpu.stat`]) {
    if (!existsSync(path)) continue;
    const usage = /^usage_usec (\d+)/m.exec(readFileSync(path, "utf8"));
    if (usage) return Number(usage[1]);
  }
  return null;
}

function historyNow() {
  if (!HISTORY) return null;
  const db = new Database(HISTORY, { readonly: true, fileMustExist: true });
  try {
    const newest = db.prepare("SELECT s.key AS key, MAX(m.at) AS at, COUNT(*) AS points FROM series s JOIN minutes m ON m.n = s.n GROUP BY s.key").all();
    const tallies = db.prepare("SELECT * FROM tallies ORDER BY hour DESC LIMIT 2").all();
    const rows = db.prepare("SELECT (SELECT COUNT(*) FROM minutes) AS minutes, (SELECT COUNT(*) FROM hours) AS hours").get();
    return { newest, tallies, rows };
  } finally {
    db.close();
  }
}

function size(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function sample() {
  const all = processes();
  const byPid = new Map(all.map((each) => [each.pid, each]));
  if (!server || !byPid.has(server)) server = serverPid();
  const main = server ? byPid.get(server) : null;
  const ssh = all.filter((each) => each.comm === "ssh");
  const docker = all.filter((each) => each.comm === "dockerd" || each.comm === "containerd" || each.comm.startsWith("containerd-shim"));
  const cpu = Object.fromEntries([...containers].map(([id, name]) => [name, containerCpu(id)]));
  let history = null;
  try {
    history = historyNow();
  } catch (error) {
    history = { error: error.message };
  }
  const line = {
    at: Date.now(),
    server: main ? { pid: main.pid, own: (main.utime + main.stime) / TICKS, children: (main.cutime + main.cstime) / TICKS, rssBytes: main.rssBytes } : null,
    ssh: { processes: ssh.length, seconds: ssh.reduce((sum, each) => sum + (each.utime + each.stime) / TICKS, 0) },
    docker: docker.reduce((sum, each) => sum + (each.utime + each.stime) / TICKS, 0),
    containers: cpu,
    history,
    file: HISTORY ? { db: size(HISTORY), wal: size(`${HISTORY}-wal`) } : null,
  };
  appendFileSync(join(RUN, "samples.jsonl"), `${JSON.stringify(line)}\n`);
}

const execs = spawn("docker", ["events", "--filter", "type=container", "--filter", "event=exec_create", "--format", "{{.TimeNano}} {{.Actor.Attributes.name}}"], { stdio: ["ignore", "pipe", "ignore"] });
execs.stdout.on("data", (chunk) => appendFileSync(join(RUN, "docker-execs.log"), chunk));

const role = (name) => boxes.find((box) => box.role === name);

const steps = [
  { at: 60, name: "history off, for the A/B of cost", run: () => bbc("box", "option", "set", "monitor.boxHistory=false") },
  { at: 120, name: "history on again", run: () => bbc("box", "option", "set", "monitor.boxHistory=true") },
  { at: 150, name: "stop a box for an hour", run: () => bbc("box", "stop", role("stopped").name, "--thread", plan.thread, "--force") },
  { at: 210, name: "start it again", run: () => bbc("box", "start", role("stopped").name, "--thread", plan.thread) },
  { at: 240, name: "load a box for 10 minutes", run: () => run("docker", ["exec", "-d", role("loaded").container, "sh", "-c", "timeout 600 yes > /dev/null & timeout 600 yes > /dev/null & wait"]) },
  { at: 270, name: "cut a box's host off for an hour", run: () => run("sudo", ["iptables", "-I", "OUTPUT", "-d", role("cut").address, "-j", "DROP"]) },
  { at: 330, name: "join it again", run: () => run("sudo", ["iptables", "-D", "OUTPUT", "-d", role("cut").address, "-j", "DROP"]) },
  { at: 360, name: "five pages open on Live for an hour", run: () => spawn("node", [join(HOME, "live", "pages.mjs"), "3600"], { stdio: "ignore", detached: true }).unref() },
  { at: 480, name: "the Monitor off for 10 minutes", run: () => bbc("box", "option", "set", "monitor.enabled=false") },
  { at: 490, name: "the Monitor on again", run: () => bbc("box", "option", "set", "monitor.enabled=true") },
  { at: 500, name: "history off for 3 minutes", run: () => bbc("box", "option", "set", "monitor.boxHistory=false") },
  { at: 503, name: "history on after 3 minutes", run: () => bbc("box", "option", "set", "monitor.boxHistory=true") },
  { at: 720, name: "bb-box restarted half way", run: () => bbc("plugin", "reload", "bb-box") },
  { at: 1440, name: "24 hours", run: async () => undefined },
];

const done = new Set(plan.done ?? []);

async function tick() {
  const minute = (Date.now() - startedAt) / MINUTE;
  for (const step of steps) {
    if (done.has(step.name) || minute < step.at) continue;
    done.add(step.name);
    writeFileSync(join(RUN, "plan.json"), JSON.stringify({ ...plan, startedAt, done: [...done] }, null, 2));
    try {
      await step.run();
      note(step.name);
    } catch (error) {
      note(step.name, { error: String(error.message ?? error).slice(0, 500) });
    }
  }
}

await refreshContainers();
note("sampler started", { server, history: HISTORY, containers: containers.size });
let minutes = 0;
for (;;) {
  const next = Math.ceil(Date.now() / MINUTE) * MINUTE + 30_000;
  await new Promise((resolve) => setTimeout(resolve, Math.max(1000, next - Date.now())));
  if (minutes % 10 === 0) await refreshContainers().catch(() => undefined);
  minutes++;
  await sample().catch((error) => note("sample failed", { error: error.message }));
  await tick();
}
