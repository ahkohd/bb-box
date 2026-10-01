// Building bb-box's images on a BB machine that hosts Docker boxes (src/plugin/docker-images.ts, 042).

import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerImages, type DockerImagesDeps } from "../src/plugin/docker-images.ts";

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
