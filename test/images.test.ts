import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { buildEnvFor, templateArchive } from "../src/backends/boat/templates.ts";
import { IMAGE_CONTRACT, describeImage, judgeImage, parseImageRecord, pinLines, pinsDigest, programDigest, recordInDescription, identityResetFor, imageProgram, prepareDigest, type ImageRecord } from "../src/backends/images.ts";
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
  assert.equal(recordInDescription("BB Box linux template, built 2026-09-28."), null, "built before records");
  assert.equal(recordInDescription("BB Box linux template\n{not json"), null);
  assert.equal(parseImageRecord({ ...written, built: "yesterday" }), null);
  assert.equal(parseImageRecord({ kind: "linux" }), null);
  // What it does not need it fills in, so a record from a later BB Box still reads.
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

test("image-record.sh writes a record BB Box reads, with the pins' digest BB Box computes", { skip: !jq || !existsSync("/etc/os-release") }, async () => {
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

  cpSync(join(TEMPLATE, "guest"), join(build, "guest"), { recursive: true });
  writeFileSync(join(build, "build.env"), "BOX_IDENTITY_RESET=on\nPREPARE=abc\nBUILD_ID=build.20261003-021500-3f9c\n");
  const recorded = spawnSync("bash", [join(TEMPLATE, "guest", "image-record.sh"), build, "linux", out], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(recorded.status, 0, recorded.stderr);
  const wrote = parseImageRecord(JSON.parse(readFileSync(join(out, "image.json"), "utf8")));
  assert.equal(wrote?.program, await programDigest(join(build, "guest"), "on", "abc"));
});

function recordedProgram(build: string, out: string, prepare: string): string | null | undefined {
  writeFileSync(join(build, "build.env"), `BOX_IDENTITY_RESET=on\nPREPARE=${prepare}\nBUILD_ID=build.20261003-021500-3f9c\n`);
  const run = spawnSync("bash", [join(build, "guest", "image-record.sh"), build, "linux", out], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return parseImageRecord(JSON.parse(readFileSync(join(out, "image.json"), "utf8")))?.program;
}

test("a fresh build records the program digest the plugin computes for its image, so it is not due at once", { skip: !jq || !existsSync("/etc/os-release") }, async () => {
  const dir = tempDir("image-record-program");
  const [build, out] = [join(dir, "build"), join(dir, "out")];
  mkdirSync(out, { recursive: true });
  cpSync(TEMPLATE, build, { recursive: true });
  writeFileSync(join(out, "template-release"), "kind=linux\n");

  for (const backend of ["docker", "microsandbox", "proxmox-lxc", "proxmox-qemu", "tart"]) {
    const prepare = (await prepareDigest(SETUP, backend))!;
    assert.equal(recordedProgram(build, out, prepare), await imageProgram(SETUP, "linux", backend), backend);
  }

  writeFileSync(join(build, "guest", ".DS_Store"), "Finder");
  writeFileSync(join(build, "guest", "files", "._cua-launch-probe.mjs"), "AppleDouble");
  const docker = (await prepareDigest(SETUP, "docker"))!;
  assert.equal(recordedProgram(build, out, docker), await imageProgram(SETUP, "linux", "docker"), "a copy's hidden files count for nothing");

  appendFileSync(join(build, "guest", "files", "cua-launch-probe.mjs"), "\n");
  assert.notEqual(recordedProgram(build, out, docker), await imageProgram(SETUP, "linux", "docker"), "a guest file that is not a script counts");
});

test("a hidden guest file that is not Mac metadata counts, in the record and in the plugin's digest alike", { skip: !jq || !existsSync("/etc/os-release") }, async () => {
  const setup = join(tempDir("image-hidden"), "setup");
  cpSync(SETUP, setup, { recursive: true });
  const out = join(tempDir("image-hidden-out"));
  writeFileSync(join(out, "template-release"), "kind=linux\n");
  const build = join(setup, "proxmox-lxc", "template");
  const before = await imageProgram(setup, "linux", "docker");

  writeFileSync(join(build, "guest", ".guest-config"), "SETTING=1\n");
  const after = await imageProgram(setup, "linux", "docker");

  assert.notEqual(after, before, "the plugin counts it");
  assert.equal(recordedProgram(build, out, (await prepareDigest(setup, "docker"))!), after, "image-record.sh counts it the same way");
});

async function boatRecordsProgram(setup: string, kind: "linux" | "linux-desktop-cpu" | "android"): Promise<string | undefined> {
  const staged = tempDir("boat-staged");
  const unpacked = spawnSync("tar", ["-xzf", "-", "-C", staged], { input: await templateArchive(setup) });
  assert.equal(unpacked.status, 0, unpacked.stderr?.toString());
  const build = join(staged, "proxmox-lxc", "template");
  writeFileSync(join(build, "build.env"), buildEnvFor("build.20261003-021500-3f9c", kind));
  if (kind === "android") {
    cpSync(join(staged, "android", "pins.json"), join(build, "android-pins.json"));
    writeFileSync(join(build, "android-devices.json"), "[]\n");
  }
  const out = tempDir("boat-record");
  writeFileSync(join(out, "template-release"), `kind=${kind}\n`);

  const step = { linux: "linux", "linux-desktop-cpu": "desktop", android: "android" }[kind];
  const run = spawnSync("bash", [join(build, "guest", "image-record.sh"), build, step, out], { env: { PATH: process.env.PATH }, encoding: "utf8" });

  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(readFileSync(join(out, "image.json"), "utf8")).program;
}

test("boat's template records the program digest the plugin computes for it, from the files boat stages and the settings it gives", { skip: !jq || !existsSync("/etc/os-release") }, async () => {
  for (const kind of ["linux", "linux-desktop-cpu", "android"] as const) {
    assert.equal(await boatRecordsProgram(SETUP, kind), await imageProgram(SETUP, kind, "boat"), kind);
  }

  const setup = join(tempDir("boat-setup"), "setup");
  cpSync(SETUP, setup, { recursive: true });
  const before = await imageProgram(setup, "linux", "boat");
  appendFileSync(join(setup, "proxmox-lxc", "template", "guest", "files", "cua-probe.mjs"), "\n");

  assert.notEqual(await imageProgram(setup, "linux", "boat"), before, "a guest file boat stages counts");
  assert.equal(await boatRecordsProgram(setup, "linux"), await imageProgram(setup, "linux", "boat"));
});

async function withChanged(file: string, check: (setup: string) => Promise<void>): Promise<void> {
  const setup = join(tempDir("image-sources"), "setup");
  cpSync(SETUP, setup, { recursive: true });
  appendFileSync(join(setup, file), "\n");
  await check(setup);
}

test("a change to any file the Docker images are built from makes them due, on Docker and microsandbox", async () => {
  const sources = ["docker/start", "docker/fork-hold", "docker/gpu-bus-id", "docker/Dockerfile", "docker/customize.sh", "proxmox-lxc/host/common.sh", "proxmox-lxc/template/fetch-artifacts.sh", "proxmox-lxc/template/guest/files/cua-launch-probe.mjs"];

  for (const backend of ["docker", "microsandbox"]) {
    const before = await imageProgram(SETUP, "linux-desktop", backend);
    for (const file of sources) {
      await withChanged(file, async (setup) => assert.notEqual(await imageProgram(setup, "linux-desktop", backend), before, `${backend}: ${file}`));
    }
    for (const file of ["docker/README.md", "proxmox-lxc/template/pins.json", "proxmox-lxc/template/desktop-pins.tsv", "proxmox-lxc/template/apt-snapshot"]) {
      await withChanged(file, async (setup) => assert.equal(await imageProgram(setup, "linux-desktop", backend), before, `${backend}: ${file} is not built from, or the pins' digest covers it`));
    }
  }
});

test("a change to a guest file that is not a script makes every image that copies the guest folder due", async () => {
  for (const backend of ["docker", "microsandbox", "proxmox-lxc", "proxmox-qemu", "tart"]) {
    const before = await imageProgram(SETUP, "linux-desktop", backend);
    await withChanged("proxmox-lxc/template/guest/files/cua-launch-probe.mjs", async (setup) => assert.notEqual(await imageProgram(setup, "linux-desktop", backend), before, backend));
  }
});

function instructionsOf(dockerfile: string): { readonly name: string; readonly words: string[] }[] {
  return dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [name = "", ...words] = line.split(/\s+/);
      return { name: name.toUpperCase(), words };
    });
}

const isFlag = (word: string): boolean => word.startsWith("--");

function flagValue(words: readonly string[], flag: string): string | undefined {
  return words.find((word) => word.toLowerCase().startsWith(`--${flag}=`))?.slice(flag.length + 3);
}

function copiedFromContext(words: readonly string[]): string[] {
  if (flagValue(words, "from") !== undefined) return [];
  const paths = words.filter((word) => !isFlag(word));
  if (paths[0]?.startsWith("[")) return (JSON.parse(paths.join(" ")) as string[]).slice(0, -1);
  return paths.slice(0, -1);
}

function mountOptions(mount: string): Map<string, string> {
  const pairs = mount.replace(/^"|"$/g, "").split(",").map((option) => option.split("=") as [string, string?]);
  return new Map(pairs.map(([key, value]) => [key.toLowerCase(), value ?? "true"]));
}

function boundFromContext(words: readonly string[]): string[] {
  return words
    .filter((word) => word.toLowerCase().startsWith("--mount="))
    .map((word) => mountOptions(word.slice("--mount=".length)))
    .filter((options) => (options.get("type") ?? "bind").toLowerCase() === "bind" && !options.has("from"))
    .map((options) => options.get("source") ?? options.get("src") ?? "");
}

function dockerfileSources(dockerfile: string): string[] {
  return instructionsOf(dockerfile).flatMap(({ name, words }) => {
    if (name === "COPY" || name === "ADD") return copiedFromContext(words);
    if (name === "RUN") return boundFromContext(words);
    return [];
  });
}

const DOCKER_IMAGE_SOURCES = readFileSync(join(SETUP, "docker", "image-sources"), "utf8").split("\n").filter(Boolean);

function sourcesNotListed(dockerfile: string): string[] {
  const pinFiles = ["proxmox-lxc/template/pins.json", "proxmox-lxc/template/desktop-pins.tsv", "proxmox-lxc/template/apt-snapshot"];
  const covered = (source: string) => pinFiles.includes(source) || DOCKER_IMAGE_SOURCES.some((entry) => source === entry || source.startsWith(`${entry}/`));
  return [...new Set(dockerfileSources(dockerfile).filter((source) => !covered(source)))];
}

test("the list of the Docker images' sources names every file the Dockerfile copies or binds", () => {
  const dockerfile = readFileSync(join(SETUP, "docker", "Dockerfile"), "utf8");
  const sources = dockerfileSources(dockerfile);

  assert.ok(DOCKER_IMAGE_SOURCES.includes("docker/Dockerfile"));
  assert.ok(sources.includes("docker/fork-hold") && sources.includes("proxmox-lxc/template"), "the Dockerfile's copies and binds are read");
  assert.deepEqual(sourcesNotListed(dockerfile), []);
  for (const entry of DOCKER_IMAGE_SOURCES) assert.ok(existsSync(join(SETUP, entry)), entry);
});

test("a file the Dockerfile copies or binds that the list does not name is found, in any form Docker reads", () => {
  const dockerfile = readFileSync(join(SETUP, "docker", "Dockerfile"), "utf8");
  const added = (instruction: string) => sourcesNotListed(`${dockerfile}\n${instruction}\n`);

  assert.deepEqual(added("COPY docker/new-file /new-file"), ["docker/new-file"], "a new copy");
  assert.deepEqual(added("RUN --mount=type=bind,source=docker/new-file,target=/new-file true"), ["docker/new-file"], "a new bind");
  assert.deepEqual(sourcesNotListed(dockerfile.replaceAll("docker/start ", "docker/boot ")), ["docker/boot"], "a renamed file");
  assert.deepEqual(added("copy docker/new-file /new-file"), ["docker/new-file"], "an instruction in lower case");
  assert.deepEqual(added("ADD --chmod=0755 docker/new-file /new-file"), ["docker/new-file"], "an add");
  assert.deepEqual(added(`COPY ["docker/new-file", "/new-file"]`), ["docker/new-file"], "a copy in JSON form");
  assert.deepEqual(added("RUN --mount=source=docker/new-file,type=bind,target=/new-file true"), ["docker/new-file"], "a bind with its source first");
  assert.deepEqual(added("RUN --mount=type=bind,src=docker/new-file,target=/new-file true"), ["docker/new-file"], "a bind's source as src");
  assert.deepEqual(added("RUN --mount=source=docker/new-file,target=/new-file true"), ["docker/new-file"], "a mount with no type, which binds");
  assert.deepEqual(added("run --mount=Type=Bind,Source=docker/new-file,target=/new-file true"), ["docker/new-file"], "an instruction and options in mixed case");
  assert.deepEqual(added("COPY --from=fetch /artifacts /mnt/artifacts"), [], "a copy from another stage");
  assert.deepEqual(added("RUN --mount=type=cache,target=/var/cache/apt true"), [], "a cache mount");
});

test("each Docker image's build records the digest build.sh gives it", () => {
  const dockerfile = readFileSync(join(SETUP, "docker", "Dockerfile"), "utf8");
  const stages = dockerfile.split(/^FROM /m).filter((stage) => stage.includes("bash /mnt/customize.sh"));

  assert.equal(stages.length, 3);
  for (const stage of stages) assert.match(stage, /^ARG IMAGE_SOURCES_SHA256=\n(?:.*\n)*?RUN [^\n]*\n(?:\s.*\n)*?\s+bash \/mnt\/customize\.sh/m, stage.split("\n")[0]);
  assert.match(readFileSync(join(SETUP, "docker", "customize.sh"), "utf8"), /^PREPARE=\$\{IMAGE_SOURCES_SHA256:-\}$/m);
});

test("every Linux desktop's program digest includes its enabled reset and changes with guest scripts on each image backend", async () => {
  for (const kind of ["linux", "linux-desktop", "linux-desktop-cpu", "linux-desktop-wayland-cpu", "linux-arm64", "linux-arm64-desktop-cpu"]) {
    assert.equal(identityResetFor(kind), "on", kind);
    for (const backend of ["docker", "proxmox-lxc", "proxmox-qemu", "microsandbox", "tart", "boat"]) {
      assert.match(await imageProgram(SETUP, kind, backend) ?? "", /^[a-f0-9]{64}$/, `${kind}: ${backend}`);
    }
  }
  assert.equal(identityResetFor("android"), "off");
});

test("an image says what it is and how old", () => {
  assert.equal(
    describeImage(record(3), NOW),
    "Standard image build.20261002-021500-3f9c, built 30 September (3 days ago): Ubuntu 24.04.3 LTS, node 24.21.0, claude-code 2.1.283, NVIDIA 580.95.05, 6.2 GiB.",
  );
  assert.match(describeImage(record(0.2, { image: "rust-tools", nvidia: null, sizeGiB: null, tools: {} }), NOW), /^Image rust-tools \S+, built 3 October \(today\): Ubuntu 24\.04\.3 LTS\.$/);
  assert.match(describeImage(record(300), NOW), /built 7 December 2025/);
});

test("a fresh image built with this BB Box's pins and BB's app passes", () => {
  const judged = judgeImage(record(), facts, REBUILD);
  assert.deepEqual([judged.status, judged.fix], ["ok", null]);
  assert.match(judged.detail, /^Standard image build\.\S+, built 2 October \(1 day ago\)/);
  // What BB Box cannot tell does not count against it.
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
  assert.match(pins.detail, /built with other pins than this BB Box's/);

  const chrome = judgeImage(record(1, { tools: { chrome: "156.0.8078.79" } }), { ...facts, pinChrome: "154.0.8037.92" }, REBUILD);
  assert.equal(chrome.status, "warn");
  assert.match(chrome.detail, /Its Chrome is 156\.0\.8078\.79, newer than this BB Box's pin 154\.0\.8037\.92/);
  assert.equal(chrome.fix, "Update the pins first, or leave this image until the pins catch up.");
  const alsoOld = judgeImage(record(15, { tools: { chrome: "156.0.8078.79" } }), { ...facts, pinChrome: "154.0.8037.92" }, REBUILD);
  assert.equal(alsoOld.fix, `Update the pins first, or leave this image until the pins catch up. ${REBUILD}`);
  assert.equal(judgeImage(record(1, { tools: { chrome: "156.0.8078.79" } }), { ...facts, pinChrome: "156.0.8078.79" }, REBUILD).status, "ok");
});

test("an image fails with an older contract, or NVIDIA's userspace other than the host's driver", () => {
  const contract = judgeImage(record(20, { contract: IMAGE_CONTRACT - 1 }), facts, REBUILD);
  assert.equal(contract.status, "fail");
  assert.match(contract.detail, new RegExp(`It keeps image contract ${IMAGE_CONTRACT - 1}, and this BB Box needs ${IMAGE_CONTRACT}, so its boxes may not work\\. It is 20 days old`));
  const newerChrome = { ...facts, pinChrome: "154.0.8037.92" };
  const failedAndNewer = judgeImage(record(1, { contract: IMAGE_CONTRACT - 1, tools: { chrome: "156.0.8078.79" } }), newerChrome, REBUILD);
  assert.equal(failedAndNewer.status, "fail");
  assert.match(failedAndNewer.detail, /Its Chrome is 156\.0\.8078\.79, newer than this BB Box's pin 154\.0\.8037\.92/);
  assert.equal(failedAndNewer.fix, REBUILD, "a failure is rebuilt; the pin line is only for a warning");
  const failedOldAndNewer = judgeImage(record(20, { contract: IMAGE_CONTRACT - 1, tools: { chrome: "156.0.8078.79" } }), newerChrome, REBUILD);
  assert.equal(failedOldAndNewer.fix, REBUILD);

  const seen = new Date(NOW - 2 * DAY).toISOString();
  const nvidia = judgeImage(record(), { ...facts, hostNvidia: { version: "590.44.01", seen } }, REBUILD);
  assert.deepEqual([nvidia.status, nvidia.fix], ["fail", REBUILD]);
  assert.match(nvidia.detail, /It has NVIDIA userspace 580\.95\.05, but the host has driver 590\.44\.01, as a box saw on 1 October, so its desktops start without the GPU\.$/);
  assert.equal(judgeImage(record(), { ...facts, hostNvidia: { version: "580.95.05", seen } }, REBUILD).status, "ok");
  assert.equal(judgeImage(record(1, { nvidia: null }), { ...facts, hostNvidia: { version: "590.44.01", seen } }, REBUILD).status, "ok", "a CPU image has none");
});
