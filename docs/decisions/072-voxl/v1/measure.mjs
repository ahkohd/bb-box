import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { inBox, inBoxLater } from "./in-box.mjs";

const [stream, workload, secondsText = "20", label = `${stream}-${workload}`] = process.argv.slice(2);
const seconds = Number(secondsText);
const { BOX, VIEWER } = process.env;
const out = process.env.OUT ?? join(process.env.HOME, "live-results", "measure");
const proxy = process.env.PROXY ?? "http://127.0.0.1:7000";
const WARMUP_MS = 4000;
const SCENE_SETTLE_MS = 6000;
const CLOCK_TICKS = 100;
const MARKER_RANGE = 1 << 24;
mkdirSync(out, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const sceneProfile = `/tmp/scene-profile-${Date.now()}`;

function stopScene() {
  inBox(`pid=$(cat /tmp/scene.pid 2>/dev/null); if [ -n "$pid" ]; then kill "$pid" 2>/dev/null; for i in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done; fi; rm -f /tmp/scene.pid; true`);
}

function startScene() {
  stopScene();
  const scene = readFileSync(new URL("./scene.html", import.meta.url)).toString("base64");
  inBox(`echo ${scene} | base64 -d > /tmp/scene.html`);
  inBox(`rm -rf /tmp/scene-profile-* 2>/dev/null; true`);
  inBox(`(setsid sh -c 'echo $$ > /tmp/scene.pid; exec google-chrome --kiosk --no-first-run --no-default-browser-check --disable-features=Translate --password-store=basic --user-data-dir=${sceneProfile} "file:///tmp/scene.html?work=${workload}"' </dev/null >/tmp/scene.log 2>&1 &)`);
}

function sampleCpu(durationSeconds) {
  const script = `end=$(( $(date +%s) + ${durationSeconds} )); while [ "$(date +%s)" -lt "$end" ]; do echo "t $(date +%s.%N)"; cat /proc/[0-9]*/stat 2>/dev/null; sleep 1; done`;
  return inBoxLater(script, durationSeconds + 60);
}

function groupOf(command) {
  if (command === "voxl") return "voxl";
  if (command === "Xtigervnc" || command === "Xvnc" || command === "Xorg") return "X server";
  if (command === "selkies" || command === "python3") return "selkies";
  if (command === "socat") return "relay route (socat)";
  if (command.startsWith("chrome")) return "chrome (the workload)";
  return null;
}

function cpuCores(text) {
  const samples = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("t ")) samples.push({ at: Number(line.slice(2)), ticks: new Map() });
    const match = /^(\d+) \((.*)\) \S+ (.*)$/.exec(line);
    if (!match || !samples.length) continue;
    const fields = match[3].split(" ");
    const group = groupOf(match[2]);
    if (!group) continue;
    const ticks = Number(fields[10]) + Number(fields[11]);
    const key = `${group}\t${match[1]}`;
    samples.at(-1).ticks.set(key, ticks);
  }
  if (samples.length < 2) return {};
  const [first, last] = [samples[0], samples.at(-1)];
  const span = last.at - first.at;
  const cores = {};
  for (const [key, ticks] of last.ticks) {
    const group = key.split("\t")[0];
    const before = first.ticks.get(key) ?? 0;
    cores[group] = (cores[group] ?? 0) + (ticks - before) / CLOCK_TICKS / span;
  }
  return Object.fromEntries(Object.entries(cores).map(([group, value]) => [group, Math.round(value * 100) / 100]));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

function summarise(markers, bytes, from, to) {
  const shown = [];
  let last = null;
  let unreadable = 0;
  for (const [at, value] of markers) {
    if (at < from || at > to) continue;
    if (value === null) {
      unreadable++;
      continue;
    }
    if (value === last) continue;
    last = value;
    shown.push({ at, latency: ((at & (MARKER_RANGE - 1)) - value + MARKER_RANGE) % MARKER_RANGE });
  }
  const span = (to - from) / 1000;
  const perSecond = new Map();
  for (const frame of shown) {
    const second = Math.floor((frame.at - from) / 1000);
    perSecond.set(second, (perSecond.get(second) ?? 0) + 1);
  }
  const wholeSeconds = Array.from({ length: Math.floor(span) }, (_, index) => perSecond.get(index) ?? 0);
  const latencies = shown.map((frame) => frame.latency).sort((a, b) => a - b);
  const received = bytes.filter(([at]) => at >= from && at <= to).reduce((sum, [, size]) => sum + size, 0);
  const gaps = shown.slice(1).map((frame, index) => ({ ms: frame.at - shown[index].at, atSecond: Math.round((shown[index].at - from) / 100) / 10 }));
  const longest = gaps.reduce((most, gap) => (gap.ms > most.ms ? gap : most), { ms: 0, atSecond: null });
  return {
    framesPerSecond: Math.round((shown.length / span) * 10) / 10,
    longestGapMs: longest.ms,
    longestGapAtSecond: longest.atSecond,
    worstSecond: wholeSeconds.length ? Math.min(...wholeSeconds) : null,
    latencyMs: { p50: percentile(latencies, 0.5), p99: percentile(latencies, 0.99), max: latencies.at(-1) ?? null },
    megabitsPerSecond: Math.round(((received * 8) / span / 1e6) * 100) / 100,
    framesShown: shown.length,
    unreadableFrames: unreadable,
  };
}

startScene();
await pause(SCENE_SETTLE_MS);
const browser = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const query = new URLSearchParams({ box: BOX, viewer: VIEWER, stream });
await page.goto(`${proxy}/viewer.html?${query}`);
await page.waitForFunction(() => window.ready === true && window.connected(), null, { timeout: 40_000 });
await pause(WARMUP_MS);
const cpu = sampleCpu(seconds + 1);
const from = await page.evaluate(() => Date.now());
await pause(seconds * 1000);
const to = await page.evaluate(() => Date.now());
const { markers, bytes, sizes } = await page.evaluate(() => ({ markers: window.markers, bytes: window.bytes, sizes: [...new Set(window.frameSizes)] }));
const sceneTitle = inBox("xdotool search --name '^scene ' getwindowname 2>/dev/null | head -n 1 || true");
await browser.close();
stopScene();
const result = { label, stream, workload, link: process.env.LINK ?? "lan", seconds, startedAt: new Date(from).toISOString(), endedAt: new Date(to).toISOString(), sizes, scene: sceneTitle, ...summarise(markers, bytes, from, to), cpuCores: cpuCores(await cpu) };
writeFileSync(join(out, `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
