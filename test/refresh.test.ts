import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { ImageRecord } from "../src/backends/images.ts";
import type { BackendImages, ImageBox, ImageBuild } from "../src/backends/types.ts";
import { buildScript, recordChecks, refreshImage } from "../src/core/refresh.ts";
import type { CommandTransport, RunResult } from "../src/transports/types.ts";

const SETUP = fileURLToPath(new URL("../setup/", import.meta.url));
const APP = "a".repeat(64);

const record = (build: string, tools: Record<string, string>, changes: Partial<ImageRecord> = {}): ImageRecord => ({
  contract: 1,
  image: "standard",
  kind: "linux",
  arch: "x86_64",
  build,
  built: "2026-10-03T02:15:00Z",
  base: null,
  os: "Ubuntu 24.04.5 LTS",
  aptSnapshot: "20261003T000000Z",
  pins: "p".repeat(64),
  bbApp: APP,
  tools,
  nvidia: null,
  layer: null,
  sizeGiB: 2.4,
  ...changes,
});
const OLD = record("build.20260926-060000-a1b2", { node: "24.21.0", "claude-code": "2.1.283" });
const CURRENT: ImageBuild = { ref: "9100", image: "standard", kind: "linux", build: OLD.build, record: OLD, current: true };

/**
 * Image operations on a fake backend that record what happens, with boxes
 * that answer the build script, the kind's check and BB's app, and a clock
 * that a box from the new build moves on by `slowerMs` more.
 */
function fake(options: { buildExit?: number; check?: string; app?: string; captured?: ImageRecord; slowerMs?: number } = {}) {
  const events: string[] = [];
  let clock = 0;
  let next = 7000;
  const written = new Map<string, Uint8Array>();
  const command = (ref: string): CommandTransport => ({
    probe: async () => true,
    run: async (script) => {
      events.push(`run ${ref} ${script.includes("bb-box-check-headless") ? "check" : script.includes("host-artifact") ? "app" : script}`);
      // A check that is an echo prints what it echoes.
      const echoed = /^echo '(.*)'$/.exec(script)?.[1];
      const stdout = echoed !== undefined ? `${echoed}\n` : script.includes("bb-box-check") ? (options.check ?? "docker stopped after boot   ok   docker.socket active\nservices   ok   ssh\n") : script.includes("host-artifact") ? `${options.app ?? APP}\n` : "";
      return { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
    },
    stream: async (script, { onOutput }) => {
      events.push(`stream ${ref}`);
      assert.match(script, /customize-base\.sh/);
      onOutput(new TextEncoder().encode("fetched claude\ninstalled claude-code 2.1.288 in /opt/bb-box-tools/claude-code-2.1.288\n"), "stdout");
      onOutput(new TextEncoder().encode("finalize: done (linux)"), "stderr");
      return { exitCode: options.buildExit ?? 0, timedOut: false };
    },
    writeFile: async (path, data) => {
      events.push(`write ${ref} ${path}`);
      written.set(path, data);
    },
    readFile: async () => new Uint8Array(),
  });
  const images: BackendImages = {
    list: async () => ({ builds: [CURRENT], boxes: [] }),
    box: async (build, label) => {
      const ref = String(next++);
      events.push(`box ${ref} from ${build.ref}: ${label}`);
      clock += build.ref === CURRENT.ref ? 1_000 : 1_000 + (options.slowerMs ?? 0);
      return { ref, command: command(ref) } satisfies ImageBox;
    },
    capture: async (box, from, image) => {
      events.push(`capture ${box.ref} from ${from.ref} as ${image}`);
      const captured = options.captured ?? record("build.20261003-021500-3f9c", { node: "24.21.0", "claude-code": "2.1.288" });
      return { ref: box.ref, image, kind: from.kind, build: captured.build, record: captured, current: false };
    },
    replace: async (build, current) => {
      events.push(`replace ${current.ref} with ${build.ref}`);
      return { ...build, ref: current.ref, current: true };
    },
    remove: async (ref) => void events.push(`remove ${ref}`),
  };
  return { images, events, written, now: () => clock };
}

const refresh = (made: ReturnType<typeof fake>, extra: { replace?: boolean } = {}) =>
  refreshImage({ images: made.images, current: CURRENT, setup: SETUP, bbUrl: "https://bb.example.com", bbApp: APP, pinned: true, signal: AbortSignal.timeout(60_000), now: made.now, ...extra });

test("a refresh builds in a box of the image, captures it, checks a trial box against a box of the old build, and replaces the image (049)", async () => {
  const made = fake();
  const result = await refresh(made);
  assert.equal(result.ok, true, result.reason ?? "");
  assert.deepEqual([result.build?.ref, result.build?.build, result.build?.current], ["9100", "build.20261003-021500-3f9c", true]);
  assert.deepEqual(made.events, [
    "box 7000 from 9100: refresh of 9100",
    "write 7000 bb-box-setup.tgz",
    "stream 7000",
    "capture 7000 from 9100 as standard",
    "box 7001 from 9100: answer time of build.20260926-060000-a1b2",
    "remove 7001",
    "box 7002 from 7000: trial of build.20261003-021500-3f9c",
    "run 7002 check",
    "run 7002 app",
    "remove 7002",
    "replace 9100 with 7000",
  ]);
  assert.ok(made.written.get("bb-box-setup.tgz")!.length > 1000, "the staged setup, packed");
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ["answers as quickly", true],
    ["the kind's check (bb-box-check-headless)", true],
    ["BB's app", true],
    ["the record", true],
    ["no tool older", true],
  ]);
  assert.ok(result.output.includes("installed claude-code 2.1.288 in /opt/bb-box-tools/claude-code-2.1.288"));
  assert.ok(result.output.includes("finalize: done (linux)"), "the last line, without a newline");
  assert.equal(result.output.at(-1), "replaced 9100 with build.20261003-021500-3f9c");
});

test("a try builds and checks, then removes the build, and the image stays", async () => {
  const made = fake();
  const result = await refresh(made, { replace: false });
  assert.deepEqual([result.ok, result.build], [true, null]);
  assert.ok(!made.events.some((event) => event.startsWith("replace")));
  assert.equal(made.events.at(-1), "remove 7000", "the build goes");
});

test("a failed build, or a failed check, keeps the image and removes what the refresh made", async () => {
  const failed = fake({ buildExit: 1 });
  const build = await refresh(failed);
  assert.equal(build.ok, false);
  assert.equal(build.reason, "The build failed with exit code 1: finalize: done (linux)");
  assert.deepEqual(failed.events.slice(-1), ["remove 7000"]);
  assert.ok(!failed.events.some((event) => event.startsWith("capture")));

  const check = fake({ check: "docker stopped after boot   FAIL dockerd runs\n" });
  const checked = await refresh(check);
  assert.equal(checked.ok, false);
  assert.match(checked.reason!, /^The new build failed the kind's check \(bb-box-check-headless\): docker stopped after boot +FAIL dockerd runs$/);
  assert.ok(!check.events.some((event) => event.startsWith("replace")));
  assert.deepEqual(check.events.slice(-2), ["remove 7002", "remove 7000"], "the trial box, then the build");

  const slow = await refresh(fake({ slowerMs: 5_001 }));
  assert.match(slow.reason!, /answers as quickly: A box of the new build answered in 6\.0 s, of the old in 1\.0 s\./);

  const app = await refresh(fake({ app: "b".repeat(64) }));
  assert.match(app.reason!, /BB's app: The box has BB's app bbbbbbbbbbbb, the record aaaaaaaaaaaa, the server aaaaaaaaaaaa\./);

  const older = await refresh(fake({ captured: record("build.x", { node: "24.21.0", "claude-code": "2.1.280" }) }));
  assert.match(older.reason!, /no tool older: claude-code 2\.1\.280 is older than 2\.1\.283\./);
});

test("a refresh on a backend whose standard images come from a build script, as Docker's do, builds with it and checks with the backend's own check", async () => {
  const made = fake();
  const staged: string[] = [];
  const images: BackendImages = {
    ...made.images,
    build: async (current, setup, { log }) => {
      made.events.push(`build from ${current.ref}`);
      staged.push(setup);
      log("built bbbox/linux:refresh-x");
      return { ref: "bbbox/linux:refresh-x", image: "standard", kind: current.kind, build: "build.20261003-021500-3f9c", record: record("build.20261003-021500-3f9c", { node: "24.21.0", "claude-code": "2.1.288" }), current: false };
    },
    check: () => "echo 'node ok   v24.21.0'",
  };
  const result = await refreshImage({ images, current: CURRENT, setup: SETUP, bbUrl: "https://bb.example.com", bbApp: APP, pinned: true, signal: AbortSignal.timeout(60_000), now: made.now });
  assert.equal(result.ok, true, result.reason ?? "");
  assert.deepEqual(made.events, [
    "build from 9100",
    "box 7000 from 9100: answer time of build.20260926-060000-a1b2",
    "remove 7000",
    "box 7001 from bbbox/linux:refresh-x: trial of build.20261003-021500-3f9c",
    "run 7001 echo 'node ok   v24.21.0'",
    "run 7001 app",
    "remove 7001",
    "replace 9100 with bbbox/linux:refresh-x",
  ]);
  assert.match(staged[0]!, /bb-box-refresh-.*\/setup$/, "a staged copy of setup/");
  assert.equal(result.checks[1]!.name, "the kind's check");
});

test("the record's checks: whole, and no tool older or missing than in the old build", () => {
  const ok = recordChecks(record("build.y", { node: "24.21.0", "claude-code": "2.1.288", pi: "1.0.0" }), OLD, "linux");
  assert.ok(ok.every((check) => check.ok), JSON.stringify(ok));
  const missing = recordChecks(record("build.y", { node: "24.21.0" }), OLD, "linux");
  assert.equal(missing[1]!.detail, "claude-code is missing.");
  assert.equal(recordChecks(null, OLD, "linux")[0]!.ok, false);
  assert.equal(recordChecks(record("build.y", {}, { os: "" }), null, "linux")[0]!.ok, false);
});

test("the build script runs the guest scripts as build.sh does for each kind", () => {
  const wayland = buildScript("linux-desktop-wayland-cpu", "https://bb.example.com", "build.20261003-021500-3f9c");
  for (const line of ["DESKTOP_GPU=none", "DESKTOP_SESSION=wayland", "BUILD_ID=build.20261003-021500-3f9c", "BB_URL='https://bb.example.com'", 'BOX_DNS="$dns"']) assert.ok(wayland.split("\n").includes(line), line);
  assert.match(wayland, /fetch-artifacts\.sh \S+ desktop-wayland-cpu "\$arch"/);
  assert.match(wayland, /customize-desktop\.sh/);
  assert.match(wayland, /finalize\.sh \S+ desktop$/m);
  const gpu = buildScript("linux-desktop", null, "build.x");
  assert.ok(gpu.split("\n").includes("DESKTOP_GPU=nvidia"));
  assert.ok(gpu.split("\n").includes("BB_URL=''"));
  const linux = buildScript("linux", null, "build.x");
  assert.doesNotMatch(linux, /customize-desktop|DESKTOP_/);
  assert.match(linux, /finalize\.sh \S+ linux$/m);
  assert.throws(() => buildScript("macos", null, "build.x"), /bb-box refreshes no macos image/);
});
