import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  MacProbeCache,
  NOT_MEASURED,
  capabilityCheck,
  capabilityWords,
  deviceRoom,
  imageCapabilities,
  PROBE_VERSION,
  loadReports,
  macProbeScript,
  measuredByOlderProbe,
  reportFromJson,
  offeredWords,
  parseMacProbe,
  reportKey,
  streamWay,
  type MacCapabilities,
  type MacReport,
} from "../src/core/mac-capabilities.ts";
import { fakeIosProbe } from "./fake-mac.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const BOTH = ["chip=Apple M5 Max (Virtual)", "macos=26.3.1", "xcode=26.1.1", "runtimes=iOS 26.2,iOS 18.6", "hardware=yes frames=12 seconds=0.085", "software=yes encoder=x264 0.165, source b35605ace3ddf7c1a5d67a2eb553f034aef41d55"].join("\n");

function report(capabilities: Partial<MacCapabilities>, mac = "mac-1", at = 1_000): MacReport {
  return { mac, chip: "Apple M4 Max", macos: "27.0", at, where: "mac", capabilities: { ...NOT_MEASURED, ...capabilities } };
}

const SIMULATOR = { is: "yes", what: { xcode: "27.0", runtimes: ["iOS 27.0"] } } as const;
const HARDWARE = { is: "yes", what: { fullSizeFps: 141 } } as const;
const NO_HARDWARE = { is: "no", why: "VideoToolbox could not make a hardware session (-12903)" } as const;
const SOFTWARE = { is: "yes", what: { encoder: "x264 0.165" } } as const;
const NO_SOFTWARE = { is: "no", why: "bb-box-h264 is not installed" } as const;

test("a probe's lines read back as what the Mac offers", () => {
  const read = parseMacProbe(BOTH, "mac-1", 5, "mac");
  assert.equal(read.chip, "Apple M5 Max (Virtual)");
  assert.equal(read.macos, "26.3.1");
  assert.deepEqual(read.capabilities.simulator, { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2", "iOS 18.6"] } });
  assert.deepEqual(read.capabilities.hardwareEncoder, { is: "yes", what: { fullSizeFps: 141 } });
  assert.deepEqual(read.capabilities.softwareEncoder, { is: "yes", what: { encoder: "x264 0.165" } });
  assert.deepEqual(deviceRoom(read.capabilities), { is: "yes", way: "hardware" });

  const noEncoder = parseMacProbe("xcode=26.1.1\nruntimes=iOS 26.2\nhardware=no status=-12903\nsoftware=no why=bb-box-h264 is not installed\n", "ns", 5, "host");
  assert.deepEqual(noEncoder.capabilities.hardwareEncoder, { is: "no", why: "VideoToolbox could not make a hardware session (-12903)" });
  assert.deepEqual(deviceRoom(noEncoder.capabilities), {
    is: "no",
    why: "It cannot stream a device's screen: VideoToolbox could not make a hardware session (-12903), and bb-box-h264 is not installed.",
  });

  assert.deepEqual(parseMacProbe("xcode=\nhardware=yes frames=12 seconds=0.1\n", "m", 5, "mac").capabilities.simulator, { is: "no", why: "it has no Xcode" });
  assert.deepEqual(parseMacProbe("xcode=27.0\nruntimes=\n", "m", 5, "mac").capabilities.simulator, { is: "no", why: "Xcode 27.0 has no iOS runtime" });
  const silent = parseMacProbe("", "m", 5, "mac").capabilities;
  assert.equal(silent.simulator.is, "unknown");
  assert.equal(silent.hardwareEncoder.is, "unknown");
  assert.equal(deviceRoom(silent).is, "unknown");
  assert.deepEqual(parseMacProbe("xcode=27.0\nruntimes=iOS 27.0\nhardware=unknown why=the Mac has no Swift compiler to build its check\n", "m", 5, "mac").capabilities.hardwareEncoder, {
    is: "unknown",
    why: "the Mac has no Swift compiler to build its check",
  });
});

test("hardware streams first, software is the fallback, and neither lends nothing", () => {
  assert.equal(streamWay({ simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: SOFTWARE }), "hardware");
  assert.equal(streamWay({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }), "software");
  assert.equal(streamWay({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: NO_SOFTWARE }), null);
  assert.deepEqual(deviceRoom({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }), { is: "yes", way: "software" });
  assert.deepEqual(deviceRoom({ simulator: { is: "no", why: "it has no Xcode" }, hardwareEncoder: HARDWARE, softwareEncoder: SOFTWARE }), { is: "no", why: "It cannot run the iOS Simulator: it has no Xcode." });
  assert.equal(deviceRoom({ simulator: SIMULATOR, hardwareEncoder: { is: "unknown", why: "not measured yet" }, softwareEncoder: NO_SOFTWARE }).is, "unknown");
  assert.equal(capabilityWords({ simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: SOFTWARE }), "the iOS Simulator (Xcode 27.0, iOS 27.0); video by its hardware H.264 encoder, software (x264 0.165) as the fallback");
  assert.equal(capabilityWords({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }), "the iOS Simulator (Xcode 27.0, iOS 27.0); video by software (x264 0.165), as it has no hardware H.264 encoder");
});

test("box_list's words group Macs without naming them", () => {
  assert.equal(offeredWords([]), null);
  assert.equal(offeredWords([report({ simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: NO_SOFTWARE })]), "its Mac: iOS devices, video by its hardware H.264 encoder");
  const two = offeredWords([
    report({ simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: NO_SOFTWARE }, "mac-1"),
    report({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }, "mac-2"),
  ]);
  assert.equal(two, "1 Mac: iOS devices, video by its hardware H.264 encoder; 1 Mac: iOS devices, video by software (x264 0.165), as it has no hardware H.264 encoder");
  assert.ok(!two!.includes("mac-1") && !two!.includes("mac-2"));
  assert.equal(offeredWords([report({ simulator: SIMULATOR, hardwareEncoder: HARDWARE }, "a"), report({ simulator: SIMULATOR, hardwareEncoder: HARDWARE }, "b")]), "each of its 2 Macs: iOS devices, video by its hardware H.264 encoder");
});

test("the doctor's check per Mac says what it offers, where and when it was measured", () => {
  const now = 10 * 60_000 + 1_000;
  const ok = capabilityCheck("mac-1", "mac-1", report({ simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: NO_SOFTWARE }), now);
  assert.equal(ok.status, "ok");
  assert.equal(ok.id, "devices.mac-1");
  assert.equal(ok.name, "iOS devices on mac-1");
  assert.equal(ok.detail, "The iOS Simulator (Xcode 27.0, iOS 27.0); video by its hardware H.264 encoder. Measured on the Mac, an Apple M4 Max, 10 minutes ago.");
  const none = capabilityCheck("mac-2", "mac-2", report({ simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: NO_SOFTWARE }), now);
  assert.equal(none.status, "warn");
  assert.match(none.detail, /It lends no ios slot\.$/);
  assert.match(none.fix!, /build-h264\.sh \/usr\/local/);
  assert.equal(capabilityCheck("mac-3", "mac-3", null).status, "skipped");
});

test("a Tart Mac's iOS offer comes from its iOS image, and its hardware encoder from the Mac, unless the image's check measured it", () => {
  const mac = report({ simulator: { is: "no", why: "it has no Xcode" }, hardwareEncoder: HARDWARE, softwareEncoder: NO_SOFTWARE });
  const image = { build: "build.20261028-1", runtime: { os: "27.0", xcode: "27.0" }, softwareEncoder: null, hardwareEncoder: null };
  const composed = imageCapabilities("mac-1", image, mac, 2_000);
  assert.deepEqual(composed.capabilities.simulator, { is: "yes", what: { xcode: "27.0", runtimes: ["iOS 27.0"] } });
  assert.deepEqual(composed.capabilities.hardwareEncoder, HARDWARE);
  assert.deepEqual(composed.capabilities.softwareEncoder, { is: "no", why: "the iOS image's build build.20261028-1 has no bb-box-h264" });
  assert.equal(composed.where, "mac");
  const measuredInVm = imageCapabilities("mac-1", { ...image, softwareEncoder: "openh264 2.6.0", hardwareEncoder: false }, mac, 2_000);
  assert.equal(measuredInVm.where, "image");
  assert.deepEqual(deviceRoom(measuredInVm.capabilities), { is: "yes", way: "software" });
  assert.deepEqual(imageCapabilities("mac-1", null, null, 2_000).capabilities.simulator, { is: "no", why: "the Mac has no iOS image" });
});

test("the probe script measures a Mac with Xcode, and runs no xcrun on one without it", () => {
  const home = tempDir("probe");
  const bin = join(home, "bin");
  const software = join(home, "local", "bb-box-h264");
  fakeIosProbe(bin, { hardware: "yes", software });
  const run = (script: string) => spawnSync("sh", ["-c", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, encoding: "utf8" });
  const first = run(macProbeScript(software));
  assert.equal(first.status, 0, first.stderr);
  const read = parseMacProbe(first.stdout, "mac-1", 1, "mac");
  assert.deepEqual(read.capabilities.simulator, {
    is: "yes",
    what: { xcode: "27.0", runtimes: ["iOS 27.0"], newest: { os: "27.0", build: "24A434" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", "com.apple.CoreSimulator.SimDeviceType.iPhone-17"] },
  });
  assert.deepEqual(read.capabilities.hardwareEncoder, { is: "yes", what: { fullSizeFps: 240 } });
  assert.deepEqual(read.capabilities.softwareEncoder, { is: "yes", what: { encoder: "x264 0.165" } });
  const built = readFileSync(join(home, ".fake-xcrun-log"), "utf8").split("\n").filter((line) => line.startsWith("swiftc")).length;
  assert.equal(built, 1);
  run(macProbeScript(software));
  assert.equal(readFileSync(join(home, ".fake-xcrun-log"), "utf8").split("\n").filter((line) => line.startsWith("swiftc")).length, 1, "the check is built once and kept by its hash");

  const bare = tempDir("probe-bare");
  const without = spawnSync("sh", ["-c", macProbeScript(join(bare, "none"))], { env: { PATH: "/usr/bin:/bin", HOME: bare }, encoding: "utf8" });
  assert.equal(without.status, 0, without.stderr);
  const nothing = parseMacProbe(without.stdout, "mac-2", 1, "mac").capabilities;
  assert.deepEqual(nothing.simulator, { is: "no", why: "it has no Xcode" });
  assert.deepEqual(nothing.hardwareEncoder, { is: "unknown", why: "the Mac has no Swift compiler to build its check" });
  assert.deepEqual(nothing.softwareEncoder, { is: "no", why: "bb-box-h264 is not installed" });
  assert.equal(existsSync(join(bare, ".fake-xcrun-log")), false);
});

test("the cache measures a Mac once at a time, keeps the newest, and is read back from storage", async () => {
  const storage = new MemoryStorage();
  let runs = 0;
  let clock = 1_000;
  const cache = new MacProbeCache({
    run: async () => {
      runs++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return BOTH;
    },
    now: () => clock,
    saved: (kept) => void storage.set(reportKey(kept.mac), kept),
    staleMs: 60_000,
  });
  assert.equal(cache.report("mac-1"), null);
  const [a, b] = await Promise.all([cache.known("mac-1"), cache.known("mac-1")]);
  assert.equal(runs, 1);
  assert.equal(a, b);
  assert.equal(await cache.known("mac-1"), a, "a known Mac is not measured again while fresh");
  assert.equal(runs, 1);
  clock += 120_000;
  await cache.known("mac-1");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs, 2, "a stale Mac is measured again in the background");
  cache.remember({ ...a, at: 0 });
  assert.equal(cache.report("mac-1")!.at, clock, "an older report does not replace a newer one");
  const restored = await loadReports(storage);
  assert.deepEqual(restored.map((each) => each.mac), ["mac-1"]);
  assert.equal(restored[0]!.capabilities.hardwareEncoder.is, "yes");
});

test("a report says which probe made it, and one from an older probe is stale, so BB Box measures the Mac again", async () => {
  const fresh = parseMacProbe(BOTH, "mac-1", 1_000, "mac");
  assert.equal(fresh.probe, PROBE_VERSION);
  assert.equal(measuredByOlderProbe(fresh), false);
  const older = reportFromJson({ ...fresh, probe: undefined })!;
  assert.equal(measuredByOlderProbe(older), true);
  assert.equal(reportFromJson(fresh)?.probe, PROBE_VERSION);
  let runs = 0;
  const cache = new MacProbeCache({ run: async () => (runs++, BOTH), now: () => 2_000 });
  cache.remember(older);
  assert.equal(cache.stale("mac-1"), true);
  cache.remember(fresh);
  assert.equal(cache.stale("mac-1"), false);
  assert.equal(runs, 0);
});

test("where a provider's Macs of one kind differ machine by machine, box_list and the doctor say they vary and what each kind had", () => {
  const kind = (chip: string, capabilities: Partial<MacCapabilities>, withHardwareEncoder: number, withoutHardwareEncoder: number): MacReport => ({ ...report(capabilities, chip), chip, machines: { withHardwareEncoder, withoutHardwareEncoder } });
  const m4 = kind("Apple M4 Pro (Virtual)", { simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }, 1, 1);
  const m5 = kind("Apple M5 Max (Virtual)", { simulator: SIMULATOR, hardwareEncoder: HARDWARE, softwareEncoder: SOFTWARE }, 1, 0);
  assert.equal(offeredWords([m5]), "its Macs (Apple M5 Max (Virtual)): iOS devices, video by its hardware H.264 encoder, software (x264 0.165) as the fallback");
  assert.equal(
    offeredWords([m4, m5]),
    "its Macs vary by machine: Apple M4 Pro (Virtual), iOS devices, video by a hardware H.264 encoder on 1 of the 2 machines measured, by software (x264 0.165) on the other; Apple M5 Max (Virtual), iOS devices, video by its hardware H.264 encoder, software (x264 0.165) as the fallback",
  );
  const softwareOnly = kind("Apple M4 Pro (Virtual)", { simulator: SIMULATOR, hardwareEncoder: NO_HARDWARE, softwareEncoder: SOFTWARE }, 0, 2);
  assert.match(offeredWords([softwareOnly, m5])!, /^its Macs vary by machine: Apple M4 Pro \(Virtual\), iOS devices, video by software \(x264 0.165\), as it has no hardware H\.264 encoder; Apple M5 Max/);
  const check = capabilityCheck("namespace.m4", "Namespace's Apple M4 Pro (Virtual) Macs", m4, 2_000);
  assert.equal(check.status, "ok");
  assert.match(check.detail, /Its machines vary: video by a hardware H\.264 encoder on 1 of the 2 machines measured, by software \(x264 0.165\) on the other\./);
});
