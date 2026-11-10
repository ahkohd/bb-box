// Building BB Box's images on a BB machine that hosts Docker boxes (src/plugin/docker-images.ts, 042).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dockerImageBuilding } from "../src/backends/docker/building.ts";
import { prepareDigest } from "../src/backends/images.ts";
import { BUILD_FREE_GB, DockerImages, bbAppDigest, imageStep, outdated, type DockerImagesDeps, type ImageBuild } from "../src/plugin/docker-images.ts";
import { tempDir } from "./helpers.ts";

function world(more: Partial<DockerImagesDeps> & { staleImages?: string[]; exit?: number | null; lines?: string[] } = {}) {
  const runs: { args: readonly string[]; host: string | undefined }[] = [];
  /** The digest of BB's app each stale check was given. */
  const apps: (string | null)[] = [];
  const changes: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const images = new DockerImages({
    script: "/plugin/setup/docker/build.sh",
    images: () => ["bbbox/linux:1", "bbbox/linux-desktop:1"],
    host: async (hostId) => `unix:///tmp/relay/${hostId}.sock`,
    stale: async (_hostId, image, app) => {
      apps.push(app);
      return (more.staleImages ?? []).includes(image);
    },
    changed: (hostId) => changes.push(hostId),
    logError: () => {},
    run: async (_script, args, env, onLine) => {
      runs.push({ args, host: env.DOCKER_HOST });
      for (const line of more.lines ?? ["#5 [linux 2/9] RUN apt-get install", "\u001b[1mbuilt bbbox/linux:1\u001b[0m"]) onLine(line);
      await held;
      return more.exit === undefined ? 0 : more.exit;
    },
    ...more,
  });
  return { images, runs, apps, changes, release };
}

test("a build's place is its image and that image's own step: helper stages leave it, and it never goes back", () => {
  const targets = ["desktop", "desktop-wayland"];
  let current: Pick<ImageBuild, "step" | "image"> = {};
  const seen: string[] = [];
  for (const line of ["#3 [fetch 5/5] RUN curl", "#7 [desktop 2/9] RUN apt-get", "#8 [app 3/3] COPY", "#9 [desktop 4/9] RUN", "#5 [desktop 1/9] FROM", "Sending build context", "#21 [desktop-wayland 1/7] FROM", "#22 [fetch-desktop-wayland 2/2] RUN", "#23 [desktop-wayland 3/7] RUN", "#24 [desktop 9/9] RUN"]) {
    current = { ...current, ...imageStep(line, targets, current) };
    seen.push(current.image ? `${current.image.at}/${current.image.of} ${current.step!.at}/${current.step!.of}` : "none");
  }
  assert.deepEqual(seen, ["none", "1/2 2/9", "1/2 2/9", "1/2 4/9", "1/2 4/9", "1/2 4/9", "2/2 1/7", "2/2 1/7", "2/2 3/7", "2/2 3/7"]);
});

test("a machine with every image it needs builds nothing, and one that lacks one builds it through its relay", async () => {
  const fine = world();
  fine.release();
  const none = await fine.images.ensure("host_a");
  assert.deepEqual([none.state, none.targets, none.detail], ["built", [], null]);
  assert.deepEqual(fine.runs, []);

  const lacking = world({ staleImages: ["bbbox/linux:1"] });
  const first = lacking.images.ensure("host_a");
  const second = lacking.images.ensure("host_a");
  await new Promise((r) => setImmediate(r));
  assert.equal(lacking.images.state("host_a")?.state, "building");
  assert.equal(lacking.images.state("host_a")?.detail, "built bbbox/linux:1", "the last line, without its colours");
  assert.deepEqual(lacking.images.state("host_a")?.step, { at: 2, of: 9 }, "the last step Docker started, kept past its output");
  lacking.release();
  const done = await first;
  assert.equal(await second, done, "one build at a time per machine");
  assert.deepEqual(lacking.runs, [{ args: ["linux"], host: "unix:///tmp/relay/host_a.sock" }]);
  assert.deepEqual([done.state, done.targets, done.detail], ["built", ["linux"], null]);
  assert.ok(lacking.changes.length >= 3, "each step reaches the settings page");

  // The Wayland desktop's image is build.sh's desktop-wayland target (048).
  const wayland = world({ images: () => ["bbbox/linux:1", "bbbox/linux-desktop-wayland:1"], staleImages: ["bbbox/linux-desktop-wayland:1"] });
  wayland.release();
  assert.deepEqual((await wayland.images.ensure("host_a")).targets, ["desktop-wayland"]);
  assert.deepEqual(wayland.runs.map((each) => each.args), [["desktop-wayland"]]);
});

test("with BB's URL, the images have BB's app, and one with another build of it is built again (#95)", async () => {
  const digest = "a".repeat(64);
  const asked: string[] = [];
  const url = "https://bb.example.com";
  const current = world({
    appUrl: () => url,
    appDigest: async (from) => (asked.push(from), digest),
    stale: async (_hostId, image, app) => image === "bbbox/linux:1" && app === digest,
  });
  current.release();
  const built = await current.images.ensure("host_a");
  assert.deepEqual(asked, [url]);
  assert.deepEqual([built.state, built.targets], ["built", ["linux"]]);
  assert.deepEqual(current.runs, [{ args: ["--bb-url", url, "linux"], host: "unix:///tmp/relay/host_a.sock" }]);

  const errors: string[] = [];
  for (const appDigest of [async () => null, async () => Promise.reject(new Error("fetch failed"))]) {
    const silent = world({ appUrl: () => url, appDigest, staleImages: ["bbbox/linux:1"], logError: (operation) => errors.push(operation) });
    silent.release();
    await silent.images.ensure("host_a");
    assert.deepEqual(silent.apps, [null, null], "a server that gives no digest: BB's app does not count");
    assert.deepEqual(silent.runs.map((each) => each.args), [["linux"]], "and the images are built without it");
  }
  assert.deepEqual(errors, ["BB's app digest"]);

  const unasked: string[] = [];
  const none = world({ appDigest: async (from) => (unasked.push(from), digest), staleImages: ["bbbox/linux:1"] });
  none.release();
  await none.images.ensure("host_a");
  assert.deepEqual([unasked, none.apps, none.runs.map((each) => each.args)], [[], [null, null], [["linux"]]], "BB with no URL");
});

test("an image is outdated with no record or an older contract, or with another build of BB's app when BB gives one (#95, 049)", () => {
  const app = "b".repeat(64);
  const labels = (record: Record<string, unknown> | null) => ({
    "bbbox.image-version": "1",
    ...(record ? { "bbbox.image-record": JSON.stringify({ contract: 1, kind: "linux", build: "build.x", built: "2026-10-03T00:00:00Z", ...record }) } : {}),
  });
  assert.equal(outdated(labels({ bbApp: app }), app), false);
  assert.equal(outdated(labels({ bbApp: "c".repeat(64) }), app), true);
  assert.equal(outdated(labels({ bbApp: null }), app), true, "built without BB's app");
  assert.equal(outdated(labels({ bbApp: null }), null), false, "BB gives no digest");
  assert.equal(outdated(labels({ bbApp: app, contract: 0 }), app), true, "an older contract");
  assert.equal(outdated(labels(null), app), true, "built before records");
});

test("BB's app digest comes from the header of a HEAD request, as build.sh reads it (#95)", async () => {
  const digest = "d".repeat(64);
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === "/install/bb-app.tgz") response.setHeader("x-bb-artifact-sha256", digest);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal(await bbAppDigest(`${url}/`), digest);
    assert.equal(await bbAppDigest(`${url}/other`), null, "none in the answer");
    assert.deepEqual(seen, ["HEAD /install/bb-app.tgz", "HEAD /other/install/bb-app.tgz"]);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("a build that fails says why from its last lines, an install with no build.sh says so, and an image BB Box does not build is named", async () => {
  const failing = world({ staleImages: ["bbbox/linux:1", "bbbox/linux-desktop:1"], exit: 1, lines: ["#7 ERROR: failed to fetch snapshot.ubuntu.com", "ERROR: failed to solve"] });
  failing.release();
  const failed = await failing.images.ensure("host_a");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.targets, ["linux", "desktop"]);
  assert.equal(failed.detail, "build.sh exited with 1: #7 ERROR: failed to fetch snapshot.ubuntu.com ERROR: failed to solve");

  const scriptless = world({ staleImages: ["bbbox/linux:1"], script: null });
  scriptless.release();
  assert.equal((await scriptless.images.ensure("host_a")).detail, "This install of BB Box has no setup/docker/build.sh to build the images with.");

  const own = world({ images: () => ["example/linux:custom"] });
  own.release();
  const named = await own.images.ensure("host_a");
  assert.deepEqual([named.state, named.detail], ["built", "BB Box does not build example/linux:custom; load it on the machine."]);
  assert.deepEqual(own.runs, []);
});

test("a build that runs out of disk says how much a build needs", async () => {
  const full = world({
    staleImages: ["bbbox/linux:1", "bbbox/linux-desktop:1"],
    exit: 1,
    lines: ["#12 exporting layers", "ERROR: failed to solve: write /var/lib/docker/tmp/layer: no space left on device"],
  });
  full.release();
  assert.equal(
    (await full.images.ensure("host_a")).detail,
    "build.sh exited with 1: #12 exporting layers ERROR: failed to solve: write /var/lib/docker/tmp/layer: no space left on device " +
      `The machine ran out of disk: building all three images needs about ${BUILD_FREE_GB} GB free.`,
  );
});

const BUILD_SCRIPT = fileURLToPath(new URL("../setup/docker/build.sh", import.meta.url));
/** What build.sh needs free to build one image, in GB. */
const LINUX_FREE_GB = 10;
const DESKTOP_FREE_GB = 18;
const WAYLAND_FREE_GB = 18;

/**
 * Runs build.sh with a docker that says `freeGB` is free, or fails its check
 * with `error`, builds nothing, and reads `record` from an image's
 * /usr/share/bb-box/image.json, and a curl that gives `digest` as BB's app's,
 * gives none ("none"), or fails ("fail").
 */
function buildWith(freeGB: number, args: readonly string[] = [], error?: string, digest = "none", record = '{"contract":1,"kind":"linux"}', extra: { readonly imageError?: string; readonly startError?: string; readonly script?: string } = {}) {
  const dir = tempDir("docker-build");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >>'${log}'
cmd=$1
shift
case "$cmd" in
  run|exec|attach|logs)
    exit 0
    ;;
  create)
    case "$*" in
      *bb-box-df*)
        if [ -n "\${FAKE_ERROR:-}" ]; then echo "$FAKE_ERROR" >&2; exit 125; fi
        ;;
      *)
        if [ -n "\${FAKE_IMAGE_ERROR:-}" ]; then echo "$FAKE_IMAGE_ERROR" >&2; exit 125; fi
        ;;
    esac
    echo c0
    ;;
  start)
    if [ -n "\${FAKE_START_ERROR:-}" ]; then echo "$FAKE_START_ERROR" >&2; exit 1; fi
    ;;
  cp)
    src=$1
    dest=$2
    base=\${src##*/}
    case "$src" in
      *bb-box-df*)
        if [ -n "\${FAKE_ERROR:-}" ]; then echo "$FAKE_ERROR" >&2; exit 125; fi
        {
          echo 'Filesystem     1024-blocks    Used Available Capacity Mounted on'
          echo "overlay           65871716 2899792 $FAKE_FREE_KB       5% /"
        } >"$dest/$base"
        ;;
      *image.json*)
        if [ -z "$FAKE_RECORD" ]; then
          echo "Error response from daemon: Could not find the file /usr/share/bb-box/image.json in container c0" >&2
          exit 1
        fi
        printf '%s\\n' "$FAKE_RECORD" >"$dest/$base"
        ;;
      *)
        echo "Error response from daemon: Could not find the file $src" >&2
        exit 1
        ;;
    esac
    ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
printf '%s\\n' "$*" >>'${log}.curl'
[ "$FAKE_DIGEST" != fail ] || exit 22
printf 'HTTP/2 200 \\r\\n'
[ "$FAKE_DIGEST" = none ] || printf 'x-bb-artifact-sha256: %s\\r\\n' "$FAKE_DIGEST"
printf 'content-length: 1191955\\r\\n\\r\\n'
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_FREE_KB: String(Math.floor((freeGB * 1e9) / 1024)), FAKE_DIGEST: digest, FAKE_RECORD: record, ...(error ? { FAKE_ERROR: error } : {}), ...(extra.imageError ? { FAKE_IMAGE_ERROR: extra.imageError } : {}), ...(extra.startError ? { FAKE_START_ERROR: extra.startError } : {}) };
  const result = spawnSync("bash", [extra.script ?? BUILD_SCRIPT, ...args], { encoding: "utf8", env });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  // Each target's build, then a second one, from the cache, that labels it with its record (049).
  const builds = calls.filter((call) => call.startsWith("build ") && !call.includes("bbbox.image-record="));
  return {
    status: result.status,
    stderr: result.stderr,
    checks: calls.filter((call) => call.startsWith("create ") && call.includes("bb-box-df")),
    builds,
    labelled: calls.filter((call) => call.includes("bbbox.image-record=")),
    reads: calls.filter((call) => call.startsWith("create ") && call.includes("bbbox/")),
    attached: calls.filter((call) => /^(run|exec|attach|logs) /.test(call)),
    built: builds.map((call) => / --target ([\w-]+) /.exec(call)?.[1]),
    sourcesDigests: builds.map((call) => / --build-arg IMAGE_SOURCES_SHA256=(\S*) /.exec(call)?.[1]),
    curls: existsSync(`${log}.curl`) ? readFileSync(`${log}.curl`, "utf8").split("\n").filter(Boolean) : [],
  };
}

test("build.sh does not start with less disk free than the build needs, and says how much is free", () => {
  const short = buildWith(35.9);
  assert.equal(short.status, 1);
  assert.equal(short.stderr, "The Docker host has 35 GB of disk free, and building 3 images needs about 36 GB. Free some, for example with docker builder prune, then build again.\n");
  assert.deepEqual(short.built, []);
  assert.equal(short.checks.length, 1);
  assert.match(short.checks[0]!, /^create --platform linux\/amd64 --network none --entrypoint sh ubuntu:24\.04@sha256:[0-9a-f]{64} -c df -Pk \/ > \/tmp\/bb-box-df$/, "from the Dockerfile's base image, copied out, not attached");
  assert.deepEqual(short.attached, []);

  const enough = buildWith(BUILD_FREE_GB);
  assert.deepEqual([enough.status, enough.built], [0, ["linux", "desktop", "desktop-wayland"]], enough.stderr);
  assert.match(buildWith(BUILD_FREE_GB - 0.5, ["linux", "desktop"]).stderr, /building 2 images needs about 36 GB\./);

  for (const [target, need] of [["linux", LINUX_FREE_GB], ["desktop", DESKTOP_FREE_GB], ["desktop-wayland", WAYLAND_FREE_GB]] as const) {
    const less = buildWith(need - 0.5, [target]);
    assert.equal(less.status, 1, target);
    assert.match(less.stderr, new RegExp(`^The Docker host has ${need - 1} GB of disk free, and building the ${target} image needs about ${need} GB\\.`));
    assert.deepEqual(buildWith(need, [target]).built, [target]);
  }

  const unseen = buildWith(1, [], "Unable to find image 'ubuntu:24.04' locally");
  assert.deepEqual([unseen.status, unseen.built], [0, ["linux", "desktop", "desktop-wayland"]], "a check that cannot run does not stop the build");
  assert.equal(unseen.stderr, "build.sh could not see how much disk the Docker host has free, so it builds anyway: Unable to find image 'ubuntu:24.04' locally\n");
});

test("build.sh labels each image with its own record, and stops at an image with none (049)", () => {
  const record = '{"contract":1,"kind":"linux","build":"build.x"}';
  const built = buildWith(BUILD_FREE_GB, ["linux", "desktop"], undefined, "none", record);
  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(built.built, ["linux", "desktop"]);
  assert.deepEqual(built.reads, [
    "create --platform linux/amd64 bbbox/linux:1",
    "create --platform linux/amd64 bbbox/linux-desktop:1",
  ]);
  assert.deepEqual(built.attached, [], "an attached stream is empty, so the record is copied out");
  assert.equal(built.labelled.length, 2);
  for (const [i, target] of ["linux", "desktop"].entries()) {
    // The same build, so all from the cache, with the label.
    assert.equal(built.labelled[i], `${built.builds[i]!.replace(/ \S+$/, "")} --quiet --label bbbox.image-record=${record} ${built.builds[i]!.split(" ").at(-1)}`, target);
  }

  const none = buildWith(BUILD_FREE_GB, ["linux", "desktop"], undefined, "none", "");
  assert.deepEqual(
    [none.status, none.stderr, none.built, none.labelled],
    [1, "Error response from daemon: Could not find the file /usr/share/bb-box/image.json in container c0\n", ["linux"], []],
  );
});

test("build.sh gives each build the digest of the files its image is built from, as the plugin computes it", async () => {
  const setup = join(tempDir("docker-sources"), "setup");
  cpSync(fileURLToPath(new URL("../setup/", import.meta.url)), setup, { recursive: true });
  const script = join(setup, "docker", "build.sh");

  const fresh = buildWith(BUILD_FREE_GB, ["linux", "desktop"], undefined, "none", undefined, { script });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.deepEqual(fresh.sourcesDigests, [await prepareDigest(setup, "docker"), await prepareDigest(setup, "docker")]);

  appendFileSync(join(setup, "docker", "start"), "\ntrue\n");
  appendFileSync(join(setup, "proxmox-lxc", "template", "pins.json"), "\n");
  writeFileSync(join(setup, "proxmox-lxc", "template", "guest", "files", "._display"), "AppleDouble");
  const changed = buildWith(BUILD_FREE_GB, ["linux"], undefined, "none", undefined, { script });

  assert.equal(changed.status, 0, changed.stderr);
  assert.notEqual(changed.sourcesDigests[0], fresh.sourcesDigests[0], "a change to start");
  assert.deepEqual(changed.sourcesDigests, [await prepareDigest(setup, "docker")], "less the pins and Mac metadata, as the plugin leaves them out");

  writeFileSync(join(setup, "proxmox-lxc", "template", ".template-config"), "SETTING=1\n");
  const hidden = buildWith(BUILD_FREE_GB, ["linux"], undefined, "none", undefined, { script });

  assert.equal(hidden.status, 0, hidden.stderr);
  assert.notEqual(hidden.sourcesDigests[0], changed.sourcesDigests[0], "a hidden file that is not Mac metadata counts");
  assert.deepEqual(hidden.sourcesDigests, [await prepareDigest(setup, "docker")]);
});

test("build.sh reports Docker's own error when it cannot create a container to read an image, or start one to read the disk", () => {
  const record = '{"contract":1,"kind":"linux","build":"build.x"}';
  const image = buildWith(BUILD_FREE_GB, ["linux"], undefined, "none", record, { imageError: "Error response from daemon: No such image: bbbox/linux:1" });
  assert.equal(image.status, 1);
  assert.equal(image.stderr, "Error response from daemon: No such image: bbbox/linux:1\n");
  assert.deepEqual(image.built, ["linux"]);
  assert.deepEqual(image.labelled, []);

  const start = buildWith(BUILD_FREE_GB, ["linux"], undefined, "none", record, { startError: "Error response from daemon: failed to start container" });
  assert.equal(start.status, 0, start.stderr);
  assert.equal(start.stderr, "build.sh could not see how much disk the Docker host has free, so it builds anyway: Error response from daemon: failed to start container\n");
  assert.deepEqual(start.built, ["linux"]);
});

test("build.sh with BB's URL passes on the digest of BB's app that the server gives, and stops when it gives none (#95)", () => {
  const digest = "e".repeat(64);
  const url = "https://bb.example.com/";
  const app = buildWith(BUILD_FREE_GB, ["--bb-url", url, "linux"], undefined, digest);
  assert.equal(app.status, 0, app.stderr);
  assert.deepEqual(app.curls, ["-fsSI --max-time 30 https://bb.example.com/install/bb-app.tgz"]);
  assert.equal(app.builds.length, 1);
  assert.ok(app.builds[0]!.includes(` --build-arg BB_URL=${url} --build-arg BB_APP_SHA256=${digest} `), app.builds[0]);

  const none = buildWith(BUILD_FREE_GB, ["linux"], undefined, digest);
  assert.deepEqual(none.curls, [], "no URL, no request");
  assert.ok(none.builds[0]!.includes(" --build-arg BB_URL= --build-arg BB_APP_SHA256= "), none.builds[0]);

  const down = buildWith(BUILD_FREE_GB, ["--bb-url", url], undefined, "fail");
  assert.deepEqual([down.status, down.stderr, down.built, down.checks], [1, `build.sh could not reach BB's server at ${url} for its app.\n`, [], []]);
  const silent = buildWith(BUILD_FREE_GB, ["--bb-url", url]);
  assert.deepEqual([silent.status, silent.stderr, silent.built], [1, `BB's server at ${url} gave no digest for its app.\n`, []]);
});

test("build.sh --arch arm64 builds the arm64 linux and desktop images for linux/arm64, and no Wayland desktop (053)", () => {
  const arm = buildWith(BUILD_FREE_GB, ["--arch", "arm64"]);
  assert.equal(arm.status, 0, arm.stderr);
  assert.deepEqual(arm.built, ["linux", "desktop"], "both, by default");
  assert.ok(arm.builds.every((call) => call.includes("--platform linux/arm64")));
  assert.deepEqual(arm.builds.map((call) => / -t (\S+) /.exec(call)?.[1]), ["bbbox/linux:1-arm64", "bbbox/linux-desktop:1-arm64"]);
  assert.match(arm.checks[0]!, /--platform linux\/arm64 --network none --entrypoint sh /);
  assert.deepEqual(arm.attached, []);
  const wayland = buildWith(BUILD_FREE_GB, ["--arch", "arm64", "desktop-wayland"]);
  assert.deepEqual([wayland.status, wayland.stderr, wayland.built], [2, "There is no Wayland desktop for arm64 yet: build linux or desktop.\n", []]);
  assert.equal(buildWith(BUILD_FREE_GB, ["--arch", "riscv64"]).status, 2);
});

test("a build of one image alone keeps how long it took on that machine, in storage, as its next estimate; one of several does not", async () => {
  const stored = new Map<string, unknown>();
  const storage = { get: async <T,>(key: string) => stored.get(key) as T | undefined, set: async (key: string, value: unknown) => void stored.set(key, value) };
  let clock = 1_000;
  const one = world({ staleImages: ["bbbox/linux-desktop:1"], storage, now: () => clock });
  const built = one.images.ensure("host_a");
  clock += 480_000;
  one.release();
  assert.equal((await built).state, "built");
  assert.deepEqual(await one.images.took("host_a"), { desktop: 480_000 });
  // A restart reads it back.
  const again = world({ storage });
  assert.deepEqual(await again.images.took("host_a"), { desktop: 480_000 });
  assert.deepEqual(await again.images.took("host_b"), {});
  // Two images at once say nothing of either's time.
  const both = world({ staleImages: ["bbbox/linux:1", "bbbox/linux-desktop:1"], storage: { get: async () => undefined, set: async () => {} } });
  both.release();
  await both.images.ensure("host_c");
  assert.deepEqual(await both.images.took("host_c"), {});
});

test("a box that needs an image while it is building is told the image is still building", async () => {
  const { images, release } = world({ staleImages: ["bbbox/linux:1"] });
  const building = images.ensure("host_a");
  await new Promise((done) => setTimeout(done, 5));
  assert.equal(dockerImageBuilding("host_a", "bbbox/linux:1"), true);
  assert.equal(dockerImageBuilding("host_a", "bbbox/linux-desktop:1"), false);
  release();
  await building;
  assert.equal(dockerImageBuilding("host_a", "bbbox/linux:1"), false);
});
