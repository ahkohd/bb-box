import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { parseArgs } from "node:util";
import type { DeviceAnswer } from "../../../src/core/device.ts";
import { DeviceLink, type DeviceRequestBody } from "../../../src/core/device-link.ts";
import { DEVICE_RECORDING_LOG, RECORD_DIR, parseRecordingLog, type StepKind } from "../../../src/core/device-recording.ts";
import { deviceComposeScript, devicePrepared, parseComposed, planDeviceClip } from "../../../src/core/record-device.ts";
import { parseRecordResult, planClip, recordMakeScript } from "../../../src/core/record.ts";
import { devicePaths } from "../../../src/device/paths.ts";

const { positionals, values } = parseArgs({ allowPositionals: true, options: { position: { type: "string", default: "top" }, stills: { type: "string", default: "cut" }, dry: { type: "boolean", default: false }, out: { type: "string", default: homedir() } } });
const scenario = positionals[0] ?? "main";
const paths = devicePaths(homedir());
const dir = join(homedir(), RECORD_DIR);
const began = Date.now();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (line: string) => console.log(`${((Date.now() - began) / 1000).toFixed(1).padStart(6)} s  ${line}`);

async function open(): Promise<DeviceLink> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const socket = connect(paths.socket);
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      const web = Duplex.toWeb(socket);
      const link = await DeviceLink.open({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() }, { role: "control", started: Date.now(), instance: "record-check" });
      await link.request({ type: "owner", generation: Date.now(), holder: "agent" });
      return link;
    } catch {
      await wait(100);
    }
  }
  throw new Error("The device server did not answer within 10 s.");
}

let control = await open();
say(`connected: version ${control.hello.version}, the ${control.hello.state.model}, ${control.hello.state.power.is}`);

async function ask(body: DeviceRequestBody): Promise<DeviceAnswer> {
  const answer = await control.request(body);
  if (!answer.ok) say(`refused: ${answer.error.code}: ${answer.error.words}`);
  return answer;
}

const generation = () => control.state.geometry?.generation ?? 0;
const video = () => control.state.geometry?.video ?? { width: 1206, height: 2622 };
const caption = (kind: StepKind, text: string) => (say(`${kind}: ${text}`), values.dry ? null : ask({ type: "record", to: "caption", kind, text }));
const swipe = (fx: number, fy: number, tx: number, ty: number) => ask({ type: "input", input: { type: "swipe", from: { x: fx, y: fy, generation: generation() }, to: { x: tx, y: ty, generation: generation() }, ms: 450 }, owner: Date.now() });
const scroll = (up: boolean) => {
  const { width, height } = video();
  const [from, to] = up ? [0.75, 0.35] : [0.35, 0.75];
  return swipe(Math.round(width / 2), Math.round(height * from), Math.round(width / 2), Math.round(height * to));
};
const simctl = (...args: string[]) => spawnSync("xcrun", ["simctl", ...args], { encoding: "utf8" });

await ask({ type: "record", to: "stop" });
simctl("terminate", "booted", "com.apple.Preferences");
simctl("terminate", "booted", "com.apple.mobilesafari");
await ask({ type: "control", control: { action: "rotate", to: "upright" } });
await ask({ type: "control", control: { action: "home" } });
await wait(1500);
if (!values.dry) {
  const started = await ask({ type: "record", to: "start", position: values.position === "bottom" ? "bottom" : "top" });
  if (!started.ok) process.exit(1);
}
const zero = Date.now();
const at = async (second: number) => {
  const left = second * 1000 - (Date.now() - zero);
  if (left > 0) await wait(left);
};
say("recording");

if (scenario === "main") {
  await at(1);
  await caption("step", "It opens Settings and scrolls its list");
  simctl("launch", "booted", "com.apple.Preferences");
  await at(4);
  await scroll(true);
  await at(7);
  await scroll(true);
  await at(10);
  await scroll(false);
  await at(13);
  await caption("pass", "Settings opened and its list scrolled");
  await at(16);
  await caption("step", "It turns Safari to the right");
  simctl("openurl", "booted", "https://example.com");
  await at(20);
  await ask({ type: "control", control: { action: "rotate", turn: "right" } });
  await at(24);
  say(`turned: ${video().width}x${video().height}, ${control.state.geometry?.physical}, content ${control.state.geometry?.content}`);
  await scroll(true);
  await at(28);
  await caption("pass", "Safari turned with the device");
  await at(34);
  await ask({ type: "control", control: { action: "rotate", to: "upright" } });
  await at(42);
  await scroll(true);
  await at(50);
  await ask({ type: "control", control: { action: "home" } });
  await at(60);
} else if (scenario === "still") {
  await at(20);
} else if (scenario === "still-end") {
  await at(1);
  await caption("step", "It opens Settings, then waits a minute");
  simctl("launch", "booted", "com.apple.Preferences");
  await at(4);
  await scroll(true);
  await at(70);
} else if (scenario === "kill") {
  await at(1);
  await caption("step", "It scrolls Settings while the server is killed");
  simctl("launch", "booted", "com.apple.Preferences");
  await at(4);
  await scroll(true);
  await at(7);
  const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
  say(`killing the device server, pid ${pid}`);
  process.kill(pid, "SIGKILL");
  const killed = Date.now();
  await wait(200);
  control = await open();
  say(`the server is back ${Date.now() - killed} ms after the kill; the recording's pid is now ${existsSync(join(dir, "pid")) ? readFileSync(join(dir, "pid"), "utf8").trim() : "gone"}`);
  await at(10);
  await scroll(false);
  await at(13);
  await caption("pass", "Settings scrolled after the restart");
  await at(20);
} else {
  say(`no scenario ${scenario}: main, still, still-end or kill`);
}

if (values.dry) {
  say("done, with no recording");
  process.exit(0);
}
const stopped = await ask({ type: "record", to: "stop" });
say(`stopped: ${JSON.stringify(stopped.ok ? stopped.result : null)}`);
await control.close();
const log = parseRecordingLog(readFileSync(join(dir, DEVICE_RECORDING_LOG), "utf8"));
const composition = planDeviceClip(log);
if (typeof composition === "string") throw new Error(composition);
const run = (script: string) => spawnSync("sh", ["-c", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
let mark = Date.now();
const composed = run(deviceComposeScript(composition, values.stills === "keep" ? "keep" : "cut"));
const cuts = parseComposed(composed.stdout);
say(`framed in ${Date.now() - mark} ms: ${composed.stdout.trim()} ${composed.stderr.trim()}`);
if (!cuts) process.exit(1);
const plan = planClip(devicePrepared(composition, cuts.cuts), 1);
mark = Date.now();
const made = run(recordMakeScript(plan, "macos"));
say(`made in ${Date.now() - mark} ms: ${JSON.stringify(parseRecordResult(made.stdout))} ${made.stderr.trim().slice(-400)}`);
for (const entry of log.entries) if (entry.type === "segment" || entry.type === "lost" || entry.type === "end") say(`log: ${JSON.stringify(entry)}`);
say(`touches logged: ${log.entries.filter((entry) => entry.type === "touch").length}; canvas ${composition.width}x${composition.height}; recorded ${composition.length} s; cuts ${JSON.stringify(cuts.cuts)}; clip ${plan.length} s planned`);
const named = values.stills === "keep" ? `${scenario}-kept` : scenario;
copyFileSync(join(dir, "clip.mp4"), join(values.out!, `clip-${named}.mp4`));
copyFileSync(join(dir, DEVICE_RECORDING_LOG), join(values.out!, `log-${named}.jsonl`));
process.exit(0);
