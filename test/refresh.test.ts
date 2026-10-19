import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pinsDigest, type ImageRecord } from "../src/backends/images.ts";
import { BackendError, type BackendImages, type ImageBox, type ImageBuild } from "../src/backends/types.ts";
import { buildScript, recordChecks, refreshImage, windowsRecord } from "../src/core/refresh.ts";
import { TransportError, type CommandTransport, type RunResult } from "../src/transports/types.ts";

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
function fake(options: { buildExit?: number; check?: string; app?: string; captured?: ImageRecord; slowerMs?: number; stalls?: number[]; full?: number; steps?: boolean } = {}) {
  // Each box's own stall, in the order the boxes are made, as a host's SSH can have one.
  const stalls = [...(options.stalls ?? [])];
  let full = options.full ?? 0;
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
      // The backend has no room for its first `full` boxes, as when threads' boxes take a Mac's two macOS slots.
      if (full-- > 0) throw new BackendError("no_capacity", "mac1 already runs as many VMs as macOS allows, two.");
      const ref = String(next++);
      events.push(`box ${ref} from ${build.ref}: ${label}`);
      const slower = build.ref === CURRENT.ref ? 0 : (options.slowerMs ?? 0);
      clock += 1_000 + slower + (stalls.shift() ?? 0);
      // A backend that times its steps: the new build's box is slower to come up.
      const steps = options.steps ? [{ name: "clone", ms: 400 }, { name: "ssh", ms: 600 + slower }] : undefined;
      return { ref, command: command(ref), ...(steps ? { steps } : {}) } satisfies ImageBox;
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

const refresh = (made: ReturnType<typeof fake>, extra: { replace?: boolean; room?: { waitMs: number; pollMs: number } } = {}) =>
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

test("a refresh waits for room for its boxes, saying so, and times only the box that came; with no room in time it fails, and the image stays (#650)", async () => {
  const waited = fake({ full: 3 });
  const result = await refresh(waited, { room: { waitMs: 60_000, pollMs: 1 } });
  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(waited.events[0], "box 7000 from 9100: refresh of 9100");
  assert.deepEqual(
    result.output.filter((line) => line.startsWith("no room")),
    ["no room for the refresh of 9100 box: mac1 already runs as many VMs as macOS allows, two. Waiting for room, up to 1 more minutes."],
  );
  assert.equal(result.checks.find((check) => check.name === "answers as quickly")?.ok, true);

  const full = fake({ full: 1000 });
  const failed = await refresh(full, { room: { waitMs: 50, pollMs: 1 } });
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? "", /mac1 already runs as many VMs as macOS allows, two\./);
  assert.deepEqual(full.events, [], "no box was made, and nothing was replaced");
});

test("one stall on the host is not the build's: a second box of each, and the better of each, before answers as quickly fails (the nightly of 19 October 2026)", async () => {
  // The build's box, the old build's, then the new build's stalls 38 s, as a Mac's SSH did; its second does not.
  const stalled = fake({ stalls: [0, 0, 38_000] });
  const result = await refresh(stalled, { replace: false });
  assert.equal(result.ok, true, result.reason ?? "");
  assert.deepEqual(
    stalled.events.filter((event) => event.startsWith("box ")).map((event) => event.replace(/^box \d+ from \S+: /, "")),
    ["refresh of 9100", `answer time of ${OLD.build}`, "trial of build.20261003-021500-3f9c", `second answer time of ${OLD.build}`, "second answer time of build.20261003-021500-3f9c"],
  );
  // The old build's box stalls instead: the new one is not slower.
  const old = await refresh(fake({ stalls: [0, 38_000] }), { replace: false });
  assert.equal(old.ok, true);
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
  // A build that is slower still fails on its second boxes, and says both of each.
  assert.match(slow.reason!, /answers as quickly: Boxes of the new build answered in 6\.0 s and 6\.0 s, of the old in 1\.0 s and 1\.0 s\./);
  // With the backend's steps, which of them took the time.
  const timedSteps = await refresh(fake({ slowerMs: 5_001, steps: true }));
  assert.match(timedSteps.reason!, /answered in 6\.0 s \(clone 0\.4 s, ssh 5\.6 s\) and 6\.0 s \(clone 0\.4 s, ssh 5\.6 s\), of the old in 1\.0 s \(clone 0\.4 s, ssh 0\.6 s\) and 1\.0 s \(clone 0\.4 s, ssh 0\.6 s\)\./);

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
  // A tool named by a hash of its source has no order, so a new hash is not older (#771).
  const hashed = { ...OLD, tools: { ...OLD.tools, "bb-box-stream": "464979ceb555" } };
  const rebuilt = recordChecks(record("build.y", { node: "24.21.0", "claude-code": "2.1.288", pi: "1.0.0", "bb-box-stream": "bf343f0d36dc" }), hashed, "linux");
  assert.ok(rebuilt.every((check) => check.ok), JSON.stringify(rebuilt));
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

test("the build script runs the guest scripts in a VM's way in a VM, and in a container's in a container (057)", () => {
  const script = buildScript("linux", null, "build.x");
  assert.ok(script.split("\n").includes("BOX_RUNTIME=$runtime"));
  assert.match(script, /^\[ "\$runtime" != vm \] \|\| sudo bash \S+\/proxmox-qemu\/linux\/customize-vm\.sh \S+$/m);
  assert.ok(script.indexOf("customize-vm.sh") > script.indexOf("customize-base.sh"), "after customize-base.sh");
  // The runtime as systemd-detect-virt says: "none" in a VM, the container's name in one.
  const line = script.split("\n").find((one) => one.startsWith("runtime="))!;
  const bin = mkdtempSync(join(tmpdir(), "detect-virt-"));
  try {
    const runtime = (says: string) => {
      writeFileSync(join(bin, "systemd-detect-virt"), `#!/bin/sh\necho ${says}\n[ ${says} != none ]\n`, { mode: 0o755 });
      return execFileSync("bash", ["-c", `${line}; echo $runtime`], { env: { PATH: `${bin}:/usr/bin:/bin` } }).toString().trim();
    };
    assert.equal(runtime("none"), "vm");
    assert.equal(runtime("lxc"), "lxc");
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

const WINDOWS_OLD = record("build.20260901-020000-77aa", { pwsh: "7.6.6", git: "2.56.0", "cua-driver": "0.30.4" }, { kind: "windows-desktop", os: "Windows 11 Pro", aptSnapshot: null, bbApp: null, sizeGiB: null });
const WINDOWS: ImageBuild = { ref: "9200", image: "standard", kind: "windows-desktop", build: WINDOWS_OLD.build, record: WINDOWS_OLD, current: true };

/**
 * A fake backend with Windows boxes: refresh.ps1 exits with each of `exits`
 * in turn, and each restart moves the box's boot time on.
 */
function fakeWindows(exits: number[], options: { readonly after?: (string | null)[]; readonly cut?: number; readonly drops?: number; readonly steadyMs?: number } = {}) {
  const made = fake();
  let boots = 0;
  const left = [...exits];
  // What the box answers when asked its boot time after a restart, in turn, before its own: null for no answer.
  let after: (string | null)[] = [];
  let streams = 0;
  let drops = options.drops ?? 0;
  // The detached run of refresh.ps1 (#707): its exit code, or null when it ended without one, and its log.
  let detached: { exit: number | null; log: string } = { exit: null, log: "" };
  const windowsCommand = (ref: string): CommandTransport => ({
    probe: async () => true,
    run: async (script) => {
      if (script.includes("Start-Detached")) {
        made.events.push(`start ${ref}`);
        assert.match(script, /Start-Detached -Command '& ''C:\\bb-box\\build\\refresh\.ps1'' -Pins ''C:\\bb-box\\build\\pins\.json'' -Record ''C:\\bb-box\\build\\image\.json''; Set-Content -LiteralPath ''C:\\bb-box\\build\\refresh\.exit'' -Value \$LASTEXITCODE' -Log 'C:\\bb-box\\build\\refresh\.log'/);
        if (++streams === options.cut) detached = { exit: null, log: "" };
        else {
          const exit = left.shift() ?? 0;
          detached = { exit, log: exit === 3010 ? "12:00:00 a restart, then this again\n" : exit ? "12:00:00 FAILED: no network\n" : "12:00:00 Done\n" };
        }
        return { exitCode: 0, stdout: "pid=4321 start=133000000000000000\n", stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
      }
      if (script.includes("@alive")) {
        // The link drops for a few looks: the run goes on in the box.
        if (drops > 0) {
          drops--;
          throw new TransportError("unreachable", "The box at 192.0.2.9 did not answer on SSH.");
        }
        const offset = Number(/Seek\((\d+), 'Begin'\)/.exec(script)![1]);
        const bytes = Buffer.from(detached.log).subarray(offset);
        const stdout = `@alive=False\n@status=${detached.exit ?? ""}\n@size=${Buffer.byteLength(detached.log)}\n@log\n${bytes.length ? bytes.toString("base64") : ""}\n`;
        return { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
      }
      // check.ps1 reads the boot time too, in its boot line, so it is told first.
      const what = script.includes("Check 'Node.js") ? "check.ps1" : script.includes("LastBootUpTime") ? "booted" : script.startsWith("Restart-Computer") ? "restart" : script.startsWith("Remove-Item") ? "clean" : script;
      made.events.push(`run ${ref} ${what}`);
      if (what === "restart") {
        boots++;
        after = [...(options.after ?? [])];
      }
      if (what === "booted" && after.length) {
        const said = after.shift()!;
        if (said === null) return { exitCode: 255, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
        return { exitCode: 0, stdout: `${said}\n`, stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
      }
      const stdout = what === "booted" ? `boot ${boots}\n` : what === "check.ps1" ? "ok    PowerShell 7 over SSH  7.6.6\nok    Node.js 22.19 or later on PATH  node v24.21.0, npm 11.6.2\n" : "";
      return { exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 } satisfies RunResult;
    },
    stream: async (script, { onOutput }) => {
      made.events.push(`stream ${ref}`);
      if (++streams === options.cut) throw new TransportError("unreachable", "The box at 192.0.2.9 did not answer on SSH.");
      assert.equal(script, "& 'C:\\bb-box\\build\\refresh.ps1' -Pins 'C:\\bb-box\\build\\pins.json' -Record 'C:\\bb-box\\build\\image.json'; exit $LASTEXITCODE");
      const exit = left.shift() ?? 0;
      onOutput(new TextEncoder().encode(exit === 3010 ? "12:00:00 a restart, then this again\n" : exit ? "12:00:00 FAILED: no network\n" : "12:00:00 Done\n"), "stdout");
      return { exitCode: exit, timedOut: false };
    },
    writeFile: async (path, data) => {
      made.events.push(`write ${ref} ${path}`);
      made.written.set(path, data);
    },
    readFile: async () => new Uint8Array(),
  });
  const images: BackendImages = {
    ...made.images,
    box: async (build, label) => {
      const box = await made.images.box(build, label, AbortSignal.timeout(1000));
      return { ref: box.ref, command: windowsCommand(box.ref) };
    },
    capture: async (box, from, image) => {
      made.events.push(`capture ${box.ref} from ${from.ref} as ${image}`);
      const written = JSON.parse(new TextDecoder().decode(made.written.get("C:\\bb-box\\build\\image.json"))) as ImageRecord;
      return { ref: box.ref, image, kind: from.kind, build: written.build, record: written, current: false };
    },
    // Tart's builds its Linux and macOS images with a script: a Windows refresh still takes a box.
    build: async () => assert.fail("a Windows refresh does not build with the backend's script"),
  };
  const run = () =>
    refreshImage({ images, current: WINDOWS, setup: SETUP, bbUrl: "https://bb.example.com", bbApp: APP, signal: AbortSignal.timeout(60_000), now: made.now, restart: { timeoutMs: 1_000, pollMs: 0, steadyMs: options.steadyMs ?? 0 } });
  return { ...made, run };
}

test("a Windows refresh runs refresh.ps1 in a box of the image, restarts it while Windows asks, then captures, checks with check.ps1 and replaces (054)", async () => {
  const made = fakeWindows([3010, 0]);
  const result = await made.run();
  assert.equal(result.ok, true, result.reason ?? "");
  assert.deepEqual(made.events, [
    "box 7000 from 9200: refresh of 9200",
    "write 7000 C:\\bb-box\\build\\refresh.ps1",
    "write 7000 C:\\bb-box\\build\\bb-box-stream.cs",
    "write 7000 C:\\bb-box\\build\\install-stream.ps1",
    "write 7000 C:\\bb-box\\build\\hardware-cursor.ps1",
    "write 7000 C:\\bb-box\\build\\pins.json",
    "write 7000 C:\\bb-box\\build\\image.json",
    "start 7000",
    "run 7000 booted",
    "run 7000 restart",
    "run 7000 booted",
    "start 7000",
    "run 7000 clean",
    "capture 7000 from 9200 as standard",
    "box 7001 from 9200: answer time of build.20260901-020000-77aa",
    "remove 7001",
    `box 7002 from 7000: trial of ${result.build!.build}`,
    "run 7002 check.ps1",
    "remove 7002",
    "replace 9200 with 7000",
  ]);
  assert.deepEqual(result.checks.map((check) => [check.name, check.ok]), [
    ["answers as quickly", true],
    ["the kind's check (check.ps1)", true],
    ["the record", true],
    ["no tool older", true],
  ]);
  assert.ok(result.output.includes("restarting the box (round 1 of 5)"));

  const pins = JSON.parse(new TextDecoder().decode(made.written.get("C:\\bb-box\\build\\pins.json"))) as { tools: { name: string; arch: string; version: string }[] };
  assert.ok(pins.tools.length > 5 && pins.tools.every((pin) => pin.arch === "x86_64"), "the x86_64 pins alone");
  const written = result.build!.record!;
  assert.match(written.build, /^build\.\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.deepEqual([written.kind, written.arch, written.os, written.pins], ["windows-desktop", "x86_64", "Windows 11 Pro", await pinsDigest(SETUP, "windows")]);
  assert.equal(written.tools.node, "24.21.0");
  assert.equal(written.tools.pwsh, pins.tools.find((pin) => pin.name === "pwsh")!.version);
  assert.equal(written.tools["hardware-cursor"], "1", "refresh.ps1 turns on the hardware cursor, so the record lists it (060)");
  assert.equal(new TextDecoder().decode(made.written.get("C:\\bb-box\\build\\refresh.ps1")), readFileSync(join(SETUP, "windows", "refresh.ps1"), "utf8"));
});

test("a Windows refresh waits for the box to stay up after a restart, through the restart Windows makes by itself to finish its updates", async () => {
  // As live: the box answers started anew, then restarts by itself, then answers started anew once more, as "boot 1".
  const made = fakeWindows([3010, 0], { after: [null, "boot 0a", null, null], steadyMs: 30 });
  const result = await made.run();
  assert.equal(result.ok, true, result.reason ?? "");
  const said = result.output.join("\n");
  assert.match(said, /\nthe box answers again \d+ s after the restart; waiting for it to stay up 0 s, as Windows may restart again to finish its updates\nWindows restarted again by itself, as it finishes its updates: the box answers again \d+ s after the restart; waiting for it to stay up 0 s\n12:00:00 Done\n/);
  // The second round runs only once the box has answered with its last boot time.
  const events = made.events.filter((event) => event === "run 7000 booted" || event === "start 7000");
  assert.equal(events.filter((event) => event === "start 7000").length, 2);
  assert.ok(events.indexOf("start 7000", 1) > 5, events.join(", "));
});

test("a Windows refresh round that finds the box gone waits for it to stay up, then runs again", async () => {
  const made = fakeWindows([3010, 0], { cut: 2 });
  const result = await made.run();
  assert.equal(result.ok, true, result.reason ?? "");
  assert.ok(result.output.includes("refresh.ps1 ended without an exit code in round 2, as when Windows restarts by itself; waiting for the box"), result.output.join("\n"));
  assert.equal(made.events.filter((event) => event === "start 7000").length, 3);
});

test("a Windows refresh's refresh.ps1 runs detached, so a link that drops for a few looks costs no round, and its lines come once (#707)", async () => {
  const made = fakeWindows([0], { drops: 3 });
  const result = await made.run();
  assert.equal(result.ok, true, result.reason ?? "");
  assert.equal(made.events.filter((event) => event === "start 7000").length, 1, "one round");
  assert.equal(result.output.filter((line) => line === "12:00:00 Done").length, 1);
});

test("a Windows refresh takes 194, 3010 as ssh's 8-bit exit code gives it, as a restart (054)", async () => {
  const made = fakeWindows([194, 0]);
  const result = await made.run();
  assert.equal(result.ok, true, result.reason ?? "");
  assert.ok(result.output.includes("restarting the box (round 1 of 5)"));
});

test("a Windows refresh that fails, or that Windows keeps asking to restart, keeps the image", async () => {
  const failed = fakeWindows([1]);
  const result = await failed.run();
  assert.equal(result.reason, "The build failed with exit code 1: 12:00:00 FAILED: no network");
  assert.ok(!failed.events.some((event) => event.startsWith("capture")));
  assert.equal(failed.events.at(-1), "remove 7000");

  const restarts = fakeWindows([3010, 3010, 3010, 3010, 3010]);
  const looped = await restarts.run();
  assert.equal(looped.reason, "Windows still wanted a restart after 5 rounds of updates.");
  assert.equal(restarts.events.filter((event) => event === "run 7000 restart").length, 4);
});

test("the Windows refresh gives an image built before the OneDrive policy what the first logon gives a new one, and ends a running OneDrive (#707)", () => {
  const policy = /'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\OneDrive'[^\n]*\n?[^\n]*DisableFileSyncNGSC/;
  const refresh = readFileSync(join(SETUP, "windows", "refresh.ps1"), "utf8");
  assert.match(readFileSync(join(SETUP, "proxmox-qemu", "answer", "bb-box", "firstlogon.ps1"), "utf8"), policy);
  assert.match(refresh, /New-ItemProperty -Path \$onedrive -Name DisableFileSyncNGSC -Value 1 -PropertyType DWord -Force/);
  assert.match(refresh, /Get-Process OneDrive -ErrorAction SilentlyContinue \| Stop-Process -Force/);
  assert.match(readFileSync(join(SETUP, "windows", "check.ps1"), "utf8"), /Check 'no OneDrive'/);
});

test("a Windows image's first logon and its refresh turn on the VirtIO GPU's hardware cursor, its record lists it, and its check sees the pointer out of the captured image (060)", () => {
  const firstLogon = readFileSync(join(SETUP, "proxmox-qemu", "answer", "bb-box", "firstlogon.ps1"), "utf8");
  const refresh = readFileSync(join(SETUP, "windows", "refresh.ps1"), "utf8");
  const build = readFileSync(join(SETUP, "proxmox-qemu", "build.sh"), "utf8");
  const script = readFileSync(join(SETUP, "windows", "hardware-cursor.ps1"), "utf8");
  assert.match(firstLogon, /& C:\\bb-box\\hardware-cursor\.ps1/);
  assert.match(refresh, /& "\$dir\\hardware-cursor\.ps1"/);
  assert.match(build, /cp [^\n]*"\$here\/\.\.\/windows\/hardware-cursor\.ps1" "\$work\/answer\/bb-box\/"/);
  assert.match(build, /openh264: \$openh264, "hardware-cursor": "1"\}/);
  assert.match(script, /-Name HWCursor -Value 1 -PropertyType DWord/);
  assert.match(script, /Control\\Class\\\$driver/);
  assert.match(script, /Control\\Video\\\$video\\0000/);
  assert.match(script, /pnputil \/restart-device/);
  assert.match(readFileSync(join(SETUP, "windows", "check.ps1"), "utf8"), /Check 'pointer out of the captured image'[\s\S]*bb-box-stream\.exe[\s\S]*pointer > pointer\.txt/);
  assert.match(readFileSync(join(SETUP, "windows", "bb-box-stream.cs"), "utf8"), /if \(mode == "pointer"\) return PointerTest\(\);/);
});

test("bb-box-stream.exe says where the pointer is only to a client that follows it, as Proxmox's video draws it in (#865)", () => {
  const source = readFileSync(join(SETUP, "windows", "bb-box-stream.cs"), "utf8");
  assert.match(source, /case "BB_POINTER_FOLLOW":\n\s+client\.FollowsPointer = true;\n\s+client\.Text\(pointerMessage \?\? Capture\.PointerAt\(\)\);/, "it asks, and gets where it is at once");
  assert.match(source, /foreach \(Client client in all\) if \(client\.FollowsPointer\) client\.Text\(message\);/, "then each move, to followers only");
  assert.match(source, /return "BB_POINTER," \+ \(cursor\.at\.x - GetSystemMetrics\(76\)\) \+ "," \+ \(cursor\.at\.y - GetSystemMetrics\(77\)\);/, "in the desktop's pixels");
});

test("a Windows first logon builds bb-box-stream and sets the hardware cursor where its build pins OpenH264, as both builds do, Tart's arm64 one with its files copied (060)", () => {
  const firstLogon = readFileSync(join(SETUP, "proxmox-qemu", "answer", "bb-box", "firstlogon.ps1"), "utf8");
  const tart = readFileSync(join(SETUP, "tart", "prepare-windows-image.sh"), "utf8");
  const guarded = /\nif \(\$build\.openh264\) \{\n([\s\S]*?)\n\} else \{\n/.exec(firstLogon);
  assert.ok(guarded, "the stream's steps are inside if ($build.openh264)");
  const outside = firstLogon.replace(guarded[0], "\n");
  for (const file of ["install-stream.ps1", "hardware-cursor.ps1", "bb-box-stream.cs"]) {
    assert.ok(guarded[1]!.includes(`C:\\bb-box\\${file}`), `${file} inside`);
    assert.ok(!outside.includes(`C:\\bb-box\\${file}`), `${file} nowhere else`);
    assert.match(tart, new RegExp(`cp [^\n]*"\\$here/\\.\\./windows/${file.replace(".", "\\.")}"[^\n]*"\\$a/bb-box/"`), `Tart's build copies ${file} for the first logon`);
  }
  assert.match(tart, /^OPENH264_URL=https:\/\/ciscobinary\.openh264\.org\/openh264-2\.6\.0-win-arm64\.dll\.bz2$/m, "Tart's build pins Cisco's arm64 OpenH264");
  assert.match(tart, /pin openh264 "\$OPENH264_VERSION" "\$OPENH264_SHA256" "\$OPENH264_URL"/, "and hands it to the first logon");
});

test("a refreshed arm64 Windows record lists the hardware cursor once OpenH264 is pinned for it, as refresh.ps1 then turns it on (060)", () => {
  const current = { kind: "windows-arm64-desktop", record: null } as unknown as Parameters<typeof windowsRecord>[0];
  const pin = (name: string) => ({ name, arch: "arm64", version: "1", url: "https://example.invalid/x", sha256: "0" }) as unknown as Parameters<typeof windowsRecord>[1][number];
  const without = windowsRecord(current, [pin("git")], "build.1", 0, "digest");
  assert.equal(without.tools["hardware-cursor"], undefined, "no stream, no hardware cursor");
  const withStream = windowsRecord(current, [pin("git"), pin("openh264")], "build.2", 0, "digest");
  assert.equal(withStream.tools["hardware-cursor"], "1");
  assert.equal(withStream.arch, "arm64");
});

test("setup/windows/pins.json has the Windows build scripts' pins, Node.js included", () => {
  const pins = (JSON.parse(readFileSync(join(SETUP, "windows", "pins.json"), "utf8")) as { tools: { name: string; arch: string; version: string; url: string; sha256: string }[] }).tools;
  const common: Record<string, string> = { PWSH: "pwsh", GIT: "git", GH: "gh", CUA: "cua-driver", VS: "vs-buildtools", LLVM: "llvm", RUSTUP: "rustup", NODE: "node", CLAUDE: "claude-code", CODEX: "codex", PI: "pi", FFMPEG: "ffmpeg" };
  // bb-box-stream's encoder (060) on both: Cisco's x64 and arm64 builds.
  for (const [script, arch, names] of [
    ["proxmox-qemu/build.sh", "x86_64", { ...common, OPENH264: "openh264" }],
    ["tart/prepare-windows-image.sh", "arm64", { ...common, OPENH264: "openh264" }],
  ] as [string, string, Record<string, string>][]) {
    const lines = Object.fromEntries([...readFileSync(join(SETUP, script), "utf8").matchAll(/^([A-Z0-9]+)_(VERSION|SHA256|URL)=(\S+)$/gm)].map((match) => [`${match[1]}_${match[2]}`, match[3]!]));
    const ours = pins.filter((pin) => pin.arch === arch);
    assert.deepEqual(ours.map((pin) => pin.name).sort(), Object.values(names).sort(), `${arch}: one pin per tool`);
    for (const [prefix, name] of Object.entries(names)) {
      const pin = ours.find((one) => one.name === name)!;
      assert.equal(pin.version, lines[`${prefix}_VERSION`], `${script}'s ${name} version`);
      assert.equal(pin.sha256.toUpperCase(), lines[`${prefix}_SHA256`]?.toUpperCase(), `${script}'s ${name} SHA-256`);
      assert.ok(pin.url.startsWith("https://") && (name === "vs-buildtools" || pin.url.includes(pin.version)), `${name}'s URL names its version`);
      if (lines[`${prefix}_URL`] && name !== "vs-buildtools") assert.equal(pin.url, lines[`${prefix}_URL`], `${script}'s ${name} URL`);
    }
  }
});
