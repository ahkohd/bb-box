// Building bb-box's images on a BB machine that hosts Docker boxes (src/plugin/docker-images.ts, 042).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILD_FREE_GB, DockerImages, type DockerImagesDeps } from "../src/plugin/docker-images.ts";
import { tempDir } from "./helpers.ts";

function world(more: Partial<DockerImagesDeps> & { staleImages?: string[]; exit?: number | null; lines?: string[] } = {}) {
  const runs: { targets: readonly string[]; host: string | undefined }[] = [];
  const changes: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const images = new DockerImages({
    script: "/plugin/setup/docker/build.sh",
    images: () => ["bbbox/linux:1", "bbbox/linux-desktop:1"],
    host: async (hostId) => `unix:///tmp/relay/${hostId}.sock`,
    stale: async (_hostId, image) => (more.staleImages ?? []).includes(image),
    changed: (hostId) => changes.push(hostId),
    logError: () => {},
    run: async (_script, targets, env, onLine) => {
      runs.push({ targets, host: env.DOCKER_HOST });
      for (const line of more.lines ?? ["#5 [linux 2/9] RUN apt-get install", "\u001b[1mbuilt bbbox/linux:1\u001b[0m"]) onLine(line);
      await held;
      return more.exit === undefined ? 0 : more.exit;
    },
    ...more,
  });
  return { images, runs, changes, release };
}

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
  lacking.release();
  const done = await first;
  assert.equal(await second, done, "one build at a time per machine");
  assert.deepEqual(lacking.runs, [{ targets: ["linux"], host: "unix:///tmp/relay/host_a.sock" }]);
  assert.deepEqual([done.state, done.targets, done.detail], ["built", ["linux"], null]);
  assert.ok(lacking.changes.length >= 3, "each step reaches the settings page");
});

test("a build that fails says why from its last lines, an install with no build.sh says so, and an image bb-box does not build is named", async () => {
  const failing = world({ staleImages: ["bbbox/linux:1", "bbbox/linux-desktop:1"], exit: 1, lines: ["#7 ERROR: failed to fetch snapshot.ubuntu.com", "ERROR: failed to solve"] });
  failing.release();
  const failed = await failing.images.ensure("host_a");
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.targets, ["linux", "desktop"]);
  assert.equal(failed.detail, "build.sh exited with 1: #7 ERROR: failed to fetch snapshot.ubuntu.com ERROR: failed to solve");

  const scriptless = world({ staleImages: ["bbbox/linux:1"], script: null });
  scriptless.release();
  assert.equal((await scriptless.images.ensure("host_a")).detail, "This install of bb-box has no setup/docker/build.sh to build the images with.");

  const own = world({ images: () => ["example/linux:custom"] });
  own.release();
  const named = await own.images.ensure("host_a");
  assert.deepEqual([named.state, named.detail], ["built", "bb-box does not build example/linux:custom; load it on the machine."]);
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
      `The machine ran out of disk: building both images needs about ${BUILD_FREE_GB} GB free.`,
  );
});

const BUILD_SCRIPT = fileURLToPath(new URL("../setup/docker/build.sh", import.meta.url));
/** What build.sh needs free to build one image, in GB. */
const LINUX_FREE_GB = 10;
const DESKTOP_FREE_GB = 18;

/** Runs build.sh with a docker that says `freeGB` is free, or fails its check with `error`, and builds nothing. */
function buildWith(freeGB: number, targets: readonly string[] = [], error?: string) {
  const dir = tempDir("docker-build");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "calls");
  writeFileSync(log, "");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >>'${log}'
[ "$1" = run ] || exit 0
if [ -n "\${FAKE_ERROR:-}" ]; then echo "$FAKE_ERROR" >&2; exit 125; fi
echo 'Filesystem     1024-blocks    Used Available Capacity Mounted on'
echo "overlay           65871716 2899792 $FAKE_FREE_KB       5% /"
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_FREE_KB: String(Math.floor((freeGB * 1e9) / 1024)), ...(error ? { FAKE_ERROR: error } : {}) };
  const result = spawnSync("bash", [BUILD_SCRIPT, ...targets], { encoding: "utf8", env });
  const calls = readFileSync(log, "utf8").split("\n").filter(Boolean);
  return {
    status: result.status,
    stderr: result.stderr,
    checks: calls.filter((call) => call.startsWith("run ")),
    built: calls.filter((call) => call.startsWith("build ")).map((call) => / --target (\w+) /.exec(call)?.[1]),
  };
}

test("build.sh does not start with less disk free than the build needs, and says how much is free", () => {
  const short = buildWith(24.9);
  assert.equal(short.status, 1);
  assert.equal(short.stderr, "The Docker host has 24 GB of disk free, and building both images needs about 25 GB. Free some, for example with docker builder prune, then build again.\n");
  assert.deepEqual(short.built, []);
  assert.equal(short.checks.length, 1);
  assert.match(short.checks[0]!, /^run --rm --quiet --network none --platform linux\/amd64 --entrypoint df ubuntu:24\.04@sha256:[0-9a-f]{64} -Pk \/$/, "from the Dockerfile's base image");

  const enough = buildWith(BUILD_FREE_GB);
  assert.deepEqual([enough.status, enough.built], [0, ["linux", "desktop"]], enough.stderr);

  for (const [target, need] of [["linux", LINUX_FREE_GB], ["desktop", DESKTOP_FREE_GB]] as const) {
    const less = buildWith(need - 0.5, [target]);
    assert.equal(less.status, 1, target);
    assert.match(less.stderr, new RegExp(`^The Docker host has ${need - 1} GB of disk free, and building the ${target} image needs about ${need} GB\\.`));
    assert.deepEqual(buildWith(need, [target]).built, [target]);
  }

  const unseen = buildWith(1, [], "Unable to find image 'ubuntu:24.04' locally");
  assert.deepEqual([unseen.status, unseen.built], [0, ["linux", "desktop"]], "a check that cannot run does not stop the build");
  assert.equal(unseen.stderr, "build.sh could not see how much disk the Docker host has free, so it builds anyway: Unable to find image 'ubuntu:24.04' locally\n");
});
