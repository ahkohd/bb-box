import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { IMAGE_CONTRACT, describeImage, judgeImage, parseImageRecord, pinLines, pinsDigest, recordInDescription, type ImageRecord } from "../src/backends/images.ts";
import { tempDir } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-03T12:00:00Z");
const SETUP = fileURLToPath(new URL("../setup/", import.meta.url));
const TEMPLATE = join(SETUP, "proxmox-lxc", "template");

/** A record as finalize.sh writes it, built `days` before NOW. */
function record(days = 1, changes: Partial<ImageRecord> = {}): ImageRecord {
  return {
    contract: IMAGE_CONTRACT,
    image: "standard",
    kind: "linux-desktop",
    arch: "x86_64",
    build: "build.20261002-021500-3f9c",
    built: new Date(NOW - days * DAY).toISOString(),
    base: null,
    os: "Ubuntu 24.04.3 LTS",
    aptSnapshot: "20260926T060000Z",
    pins: "p".repeat(64),
    bbApp: "a".repeat(64),
    tools: { node: "24.21.0", "claude-code": "2.1.283" },
    nvidia: "580.95.05",
    layer: null,
    sizeGiB: 6.2,
    devices: null,
    ...changes,
  };
}

const facts = { os: "linux" as const, pins: "p".repeat(64), bbApp: "a".repeat(64), now: NOW };
const REBUILD = "Rebuild it.";

test("a record reads from its JSON and from a description's last JSON line (049)", () => {
  const written = record();
  assert.deepEqual(parseImageRecord(JSON.parse(JSON.stringify(written))), written);
  const description = `bb-box desktop template (GPU 0000:01:00.0), built 2026-10-02. See /usr/share/bb-box/template-release inside.\n${JSON.stringify(written)}\n`;
  assert.deepEqual(recordInDescription(description), written);
  assert.equal(recordInDescription("bb-box linux template, built 2026-09-28."), null, "built before records");
  assert.equal(recordInDescription("bb-box linux template\n{not json"), null);
  assert.equal(parseImageRecord({ ...written, built: "yesterday" }), null);
  assert.equal(parseImageRecord({ kind: "linux" }), null);
  // What it does not need it fills in, so a record from a later bb-box still reads.
  assert.deepEqual(parseImageRecord({ contract: 2, kind: "linux", build: "b", built: "2026-10-01T00:00:00Z", extra: true }), {
    contract: 2,
    image: "standard",
    kind: "linux",
    arch: "",
    build: "b",
    built: "2026-10-01T00:00:00Z",
    base: null,
    os: "",
    aptSnapshot: null,
    pins: "",
    bbApp: null,
    tools: {},
    nvidia: null,
    layer: null,
    sizeGiB: null,
    devices: null,
  });
});

test("the pins' digest is the build's: Linux's files, or a script's pin lines, as the build hashes them", async () => {
  const digest = (cwd: string, command: string) => spawnSync("sh", ["-c", `${command} | sha256sum | cut -d' ' -f1`], { cwd, encoding: "utf8" }).stdout.trim();
  assert.equal(await pinsDigest(SETUP, "linux"), digest(TEMPLATE, "cat pins.json apt-snapshot"));
  assert.equal(await pinsDigest(SETUP, "linux-desktop"), digest(TEMPLATE, "cat pins.json apt-snapshot desktop-pins.tsv"));
  assert.equal(await pinsDigest(SETUP, "android"), digest(TEMPLATE, "cat pins.json apt-snapshot ../../android/pins.json"), "as image-record.sh hashes an Android image's");
  // What each script runs to record its pins.
  const lines = "grep -E '^[A-Z0-9_]+_(VERSION|SHA256|URL)='";
  for (const [set, script] of [["macos", "tart/prepare-image.sh"], ["windows", "proxmox-qemu/build.sh"], ["windows-arm64", "tart/prepare-windows-image.sh"]] as const) {
    assert.equal(await pinsDigest(SETUP, set), digest(SETUP, `${lines} ${script}`), set);
    assert.ok(readFileSync(join(SETUP, script), "utf8").includes(lines), `${script} hashes its pin lines so`);
  }
  assert.equal(pinLines("A=1\nCUA_VERSION=0.30.4\n# CUA_SHA256=x\nCUA_SHA256=abc\nVS_URL=https://x\n"), "CUA_VERSION=0.30.4\nCUA_SHA256=abc\nVS_URL=https://x\n");
  assert.equal(await pinsDigest("/nonexistent", "linux"), null);
});

const jq = spawnSync("jq", ["--version"]).status === 0;

test("image-record.sh writes a record bb-box reads, with the pins' digest bb-box computes", { skip: !jq || !existsSync("/etc/os-release") }, async () => {
  // As finalize.sh runs it after a GPU desktop's build, with a build directory and template-release.
  const dir = tempDir("image-record");
  const [build, out] = [join(dir, "build"), join(dir, "out")];
  mkdirSync(out, { recursive: true });
  cpSync(TEMPLATE, build, { recursive: true, filter: (path) => !path.includes("guest") });
  writeFileSync(join(build, "build.env"), "DESKTOP_GPU=0000:01:00.0\nBUILD_ID=build.20261003-021500-3f9c\n");
  writeFileSync(join(out, "template-release"), "kind=desktop\napt_snapshot=20260926T060000Z\nnvidia=580.142\n");
  const run = spawnSync("bash", [join(TEMPLATE, "guest", "image-record.sh"), build, "desktop", out], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const record = parseImageRecord(JSON.parse(readFileSync(join(out, "image.json"), "utf8")));
  assert.ok(record);
  assert.deepEqual(
    [record.contract, record.kind, record.build, record.aptSnapshot, record.nvidia, record.pins],
    [IMAGE_CONTRACT, "linux-desktop", "build.20261003-021500-3f9c", "20260926T060000Z", "580.142", await pinsDigest(SETUP, "linux-desktop")],
  );
  assert.equal(record.tools.node, JSON.parse(readFileSync(join(TEMPLATE, "pins.json"), "utf8")).tools.find((tool: { name: string }) => tool.name === "node").version);
  assert.match(record.tools.chrome ?? "", /^\d+\.\d+\.\d+\.\d+$/);
  assert.match(record.tools["cua-driver"] ?? "", /^\d+\.\d+\.\d+$/);
  assert.equal(record.sizeGiB, null, "finalize.sh adds it once the image is clean");

  // Each desktop's kind, by its build's settings. Docker's one X desktop image serves GPU desktops too.
  for (const [settings, kind] of [
    ["DESKTOP_GPU=none\n", "linux-desktop-cpu"],
    ["DESKTOP_GPU=none\nDESKTOP_SESSION=wayland\n", "linux-desktop-wayland-cpu"],
    ["DESKTOP_GPU=none\nDESKTOP_SESSION=x11\nBOX_RUNTIME=docker\n", "linux-desktop"],
  ] as const) {
    writeFileSync(join(build, "build.env"), settings);
    const again = spawnSync("bash", [join(TEMPLATE, "guest", "image-record.sh"), build, "desktop", out], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(readFileSync(join(out, "image.json"), "utf8")).kind, kind, settings);
  }
  assert.equal(readFileSync(join(out, "image.json"), "utf8").split("\n").filter(Boolean).length, 1, "on one line, as a label holds it");
});

test("an image says what it is and how old", () => {
  assert.equal(
    describeImage(record(3), NOW),
    "Standard image build.20261002-021500-3f9c, built 30 September (3 days ago): Ubuntu 24.04.3 LTS, node 24.21.0, claude-code 2.1.283, NVIDIA 580.95.05, 6.2 GiB.",
  );
  assert.match(describeImage(record(0.2, { image: "rust-tools", nvidia: null, sizeGiB: null, tools: {} }), NOW), /^Image rust-tools \S+, built 3 October \(today\): Ubuntu 24\.04\.3 LTS\.$/);
  assert.match(describeImage(record(300), NOW), /built 7 December 2025/);
});

test("a fresh image built with this bb-box's pins and BB's app passes", () => {
  const judged = judgeImage(record(), facts, REBUILD);
  assert.deepEqual([judged.status, judged.fix], ["ok", null]);
  assert.match(judged.detail, /^Standard image build\.\S+, built 2 October \(1 day ago\)/);
  // What bb-box cannot tell does not count against it.
  assert.equal(judgeImage(record(), { os: "linux", pins: null, bbApp: null, now: NOW }, REBUILD).status, "ok");
});

test("an image warns when it has no record, is old, or has another BB app or other pins", () => {
  const none = judgeImage(null, facts, REBUILD);
  assert.deepEqual([none.status, none.fix], ["warn", REBUILD]);
  assert.match(none.detail, /no image record/);

  const old = judgeImage(record(15), facts, REBUILD);
  assert.equal(old.status, "warn");
  assert.match(old.detail, / It is 15 days old, more than 14, so its tools and packages are behind\.$/);
  assert.equal(judgeImage(record(13.9), facts, REBUILD).status, "ok");
  assert.equal(judgeImage(record(59, { kind: "windows" }), { ...facts, os: "windows" }, REBUILD).status, "ok", "Windows images are rebuilt monthly");

  const app = judgeImage(record(1, { bbApp: "b".repeat(64) }), facts, REBUILD);
  assert.equal(app.status, "warn");
  assert.match(app.detail, /another build of BB's app than BB's server gives, so each box downloads the app as it enrols/);
  assert.match(judgeImage(record(1, { bbApp: null }), facts, REBUILD).detail, /It has no build of BB's app/);

  const pins = judgeImage(record(1, { pins: "q".repeat(64) }), facts, REBUILD);
  assert.deepEqual([pins.status, pins.fix], ["warn", REBUILD]);
  assert.match(pins.detail, /built with other pins than this bb-box's/);
});

test("an image fails with an older contract, or NVIDIA's userspace other than the host's driver", () => {
  const contract = judgeImage(record(20, { contract: IMAGE_CONTRACT - 1 }), facts, REBUILD);
  assert.equal(contract.status, "fail");
  assert.match(contract.detail, new RegExp(`It keeps image contract ${IMAGE_CONTRACT - 1}, and this bb-box needs ${IMAGE_CONTRACT}, so its boxes may not work\\. It is 20 days old`));

  const seen = new Date(NOW - 2 * DAY).toISOString();
  const nvidia = judgeImage(record(), { ...facts, hostNvidia: { version: "590.44.01", seen } }, REBUILD);
  assert.deepEqual([nvidia.status, nvidia.fix], ["fail", REBUILD]);
  assert.match(nvidia.detail, /It has NVIDIA userspace 580\.95\.05, but the host has driver 590\.44\.01, as a box saw on 1 October, so its desktops start without the GPU\.$/);
  assert.equal(judgeImage(record(), { ...facts, hostNvidia: { version: "580.95.05", seen } }, REBUILD).status, "ok");
  assert.equal(judgeImage(record(1, { nvidia: null }), { ...facts, hostNvidia: { version: "590.44.01", seen } }, REBUILD).status, "ok", "a CPU image has none");
});
