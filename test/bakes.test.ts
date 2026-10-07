import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import type { ImageRecord } from "../src/backends/images.ts";
import type { Backend, BackendImages, ImageBox, ImageBuild } from "../src/backends/types.ts";
import type { BoxImage, BoxRecord } from "../src/core/boxes.ts";
import type { ImageConfig } from "../src/core/document.ts";
import { BoxError } from "../src/core/boxes.ts";
import { ImageBakes, bakeScript, checkDetail, scriptHash, type Bake } from "../src/plugin/bakes.ts";
import { tryText } from "../src/plugin/views.ts";
import type { RunResult } from "../src/transports/types.ts";
import { MemoryStorage } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-03T10:00:00Z");
const IMAGE: ImageConfig = { kinds: ["linux", "linux-desktop"], script: "apt-get install -y ripgrep\n", check: "rg --version\n", bake: "auto", projects: ["prj"] };

const record = (build: string, changes: Partial<ImageRecord> = {}): ImageRecord => ({
  contract: 1,
  image: "standard",
  kind: "linux",
  arch: "x86_64",
  build,
  built: "2026-10-01T02:00:00.000Z",
  base: null,
  os: "Ubuntu 24.04.5 LTS",
  aptSnapshot: "20260930T000000Z",
  pins: "p".repeat(64),
  bbApp: "a".repeat(64),
  tools: { node: "24.21.0" },
  nvidia: null,
  layer: null,
  sizeGiB: 3.1,
  ...changes,
});
const standard = (ref: string, kind: string, build: string): ImageBuild => ({ ref, image: "standard", kind, build, record: record(build, { kind }), current: true });
const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 });

/** A backend whose image operations keep builds in memory, and whose boxes answer as `answer` says. */
function backend(id = "proxmox-lxc", options: { startsFrom?: boolean; fail?: (script: string) => RunResult | null; stuck?: Set<string> } = {}) {
  const builds: ImageBuild[] = [standard("9000", "linux", "build.20261001-020000-aaaa"), standard("9001", "linux-desktop", "build.20261001-020000-bbbb")];
  const ran: { box: string; script: string }[] = [];
  const removed: string[] = [];
  let next = 7000;
  const images: BackendImages = {
    list: async () => ({ builds: [...builds], boxes: [] }),
    box: async (from) => {
      const ref = String(next++);
      let written: ImageRecord | null = null;
      const box: ImageBox & { from: string; record(): ImageRecord | null } = {
        ref,
        from: from.ref,
        record: () => written,
        command: {
          run: async (script: string) => {
            ran.push({ box: ref, script });
            const failed = options.fail?.(script);
            if (failed) return failed;
            if (script.includes("bb-box-check-headless")) return ok("node              ok   24.21.0\ndocker            ok   on first use\n");
            if (script === "cat /usr/share/bb-box/image.json") return ok(JSON.stringify(record("build.finalized", { sizeGiB: 3.4, kind: "linux-desktop" })));
            const json = /^printf '%s\\n' '(.*)' \| sudo -n tee \/usr\/share\/bb-box\/image\.json/.exec(script)?.[1];
            if (json) written = JSON.parse(json);
            return ok();
          },
          writeFile: async (path: string) => void ran.push({ box: ref, script: `write ${path}` }),
        } as never,
      };
      return box;
    },
    capture: async (box, from, image) => {
      const made = box as ImageBox & { record(): ImageRecord | null };
      // A failed build box has no record of its own; the build is kept as it is.
      const build: ImageBuild = { ref: box.ref, image, kind: from.kind, build: made.record()?.build ?? null, record: made.record(), current: false };
      builds.push(build);
      return build;
    },
    replace: async () => assert.fail("a bake replaces no standard image"),
    remove: async (ref) => {
      if (options.stuck?.has(ref)) throw new Error(`a box is a linked clone of ${ref}`);
      removed.push(ref);
      const at = builds.findIndex((build) => build.ref === ref);
      if (at >= 0) builds.splice(at, 1);
    },
    ...(options.startsFrom === false ? {} : { startsFrom: true }),
  };
  const made = { id, label: id, images, kinds: () => ["linux", "linux-desktop", "linux-desktop-cpu"].map((kind) => ({ id: kind })) } as unknown as Backend;
  return { backend: made, builds, ran, removed };
}

function bakes(backends: Backend[], images: Record<string, ImageConfig> = { rust: IMAGE }) {
  const clock = { now: NOW };
  const storage = new MemoryStorage();
  const config = { images };
  const said: string[] = [];
  /** Thread boxes a kept try started (#451), by ID, and whether the next fails to start. */
  const kept = new Map<string, { name: string; from: string; image: string; build: string | null }>();
  const keeping = { fail: false };
  const made = new ImageBakes({
    backends: () => backends,
    images: () => config.images,
    storage,
    setup: new URL("../setup/", import.meta.url).pathname,
    now: () => clock.now,
    log: (line) => said.push(line),
    keep: async ({ name, build, ref }) => {
      if (keeping.fail) throw new Error("no room");
      const id = `bx${kept.size + 1}`;
      kept.set(id, { name: `kept-${kept.size + 1}`, from: ref, image: name, build });
      return { id, name: kept.get(id)!.name };
    },
    boxExists: async (id) => kept.has(id),
  });
  return { bakes: made, storage, clock, config, said, kept, keeping };
}

/** A box of the image that is ready, as Boxes says. */
const box = (image: BoxImage, kind = "linux", backendId = "proxmox-lxc") => ({ name: "calm-otter", backend: backendId, kind, image }) as BoxRecord;

/** Waits for what ready() started, and the bakes it queued. */
async function settled(on: ImageBakes): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  await on.exclusive(async () => {});
}

test("an image is baked on a backend once two of its boxes ran its script there within 14 days, and the next box starts from the build (049)", async () => {
  const lxc = backend();
  const { bakes: on, storage, clock } = bakes([lxc.backend]);
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);
  assert.equal(lxc.ran.length, 0, "one box is not enough");
  assert.equal(await on.current("rust", "proxmox-lxc", "linux"), null);

  // A box 15 days later counts alone.
  clock.now += 15 * DAY;
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);
  assert.equal(lxc.ran.length, 0);
  clock.now += DAY;
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);

  // The bake: a box of the standard build, the script and check, the record, a capture and a trial box.
  const scripts = lxc.ran.map((one) => `${one.box}: ${one.script.split("\n")[0]!.slice(0, 40)}`);
  assert.deepEqual(scripts, [
    "7000: write bb-box-setup.tgz",
    "7000: write .bb-box-image/setup.sh",
    "7000: write .bb-box-image/check.sh",
    "7000: set -euo pipefail",
    "7000: cat /usr/share/bb-box/image.json",
    "7000: printf '%s\\n' '{\"contract\":1,\"image\":\"ru",
    "7001: write .bb-box-image/check.sh",
    "7001: set -a; [ ! -r /etc/environment ] || . /",
  ]);
  const built = lxc.builds.find((build) => build.image === "rust")!;
  assert.deepEqual([built.ref, built.kind, built.record?.kind, built.record?.base, built.record?.layer?.sha256, built.record?.sizeGiB, built.record?.tools], [
    "7000",
    "linux",
    "linux",
    "build.20261001-020000-aaaa",
    scriptHash(IMAGE),
    3.4,
    { node: "24.21.0" },
  ]);
  assert.match(built.build!, /^build\.20261019-100000-[0-9a-f]{4}$/);
  assert.deepEqual(lxc.removed, ["7001"], "the trial box goes; the build stays");
  assert.deepEqual(await on.current("rust", "proxmox-lxc", "linux"), { ref: "7000", build: built.build });

  // A box that started from it marks it used.
  clock.now += DAY;
  on.ready(box({ name: "rust", state: "baked", build: built.build, from: "7000" }));
  await settled(on);
  assert.equal((await storage.get<Bake>("images/bake/rust/proxmox-lxc/linux"))?.used, clock.now);
});

test("an image that says always is baked at its first box, never is not, nor a GPU desktop's, nor where builds do not start boxes (049)", async () => {
  const lxc = backend();
  const docker = backend("docker", { startsFrom: false });
  const { bakes: on } = bakes([lxc.backend, docker.backend], { always: { ...IMAGE, bake: "always" }, never: { ...IMAGE, bake: "never" } });
  for (const name of ["always", "never"]) {
    on.ready(box({ name, state: "done" }));
    on.ready(box({ name, state: "done" }, "linux-desktop"));
    on.ready(box({ name, state: "done" }, "linux", "docker"));
  }
  await settled(on);
  assert.deepEqual(lxc.builds.filter((build) => !build.current).map((build) => `${build.image} ${build.kind}`), ["always linux"]);
  assert.deepEqual(docker.ran, []);
});

test("a changed script or a new standard build makes a build out of date; setting the image bakes it again, and the old build goes (049)", async () => {
  const lxc = backend();
  const { bakes: on, config, clock } = bakes([lxc.backend]);
  await on.bake("rust", lxc.backend, "linux");
  assert.ok(await on.current("rust", "proxmox-lxc", "linux"));
  assert.deepEqual(await on.bake("rust", lxc.backend, "linux"), { name: "rust for linux on proxmox-lxc", outcome: "not started", detail: "its build is current" });

  config.images = { rust: { ...IMAGE, script: "apt-get install -y ripgrep fd-find\n" } };
  assert.equal(await on.current("rust", "proxmox-lxc", "linux"), null, "a changed script, at once");
  on.settle("rust");
  await settled(on);
  assert.deepEqual(await on.current("rust", "proxmox-lxc", "linux"), { ref: "7002", build: lxc.builds.find((build) => build.ref === "7002")!.build });
  assert.ok(lxc.removed.includes("7000"), "the old build goes");

  // A refresh of the standard image, once acquires list the builds again.
  lxc.builds[0] = standard("9000", "linux", "build.20261010-020000-cccc");
  assert.ok(await on.current("rust", "proxmox-lxc", "linux"), "the list of a minute ago");
  clock.now += 60_000;
  assert.equal(await on.current("rust", "proxmox-lxc", "linux"), null);
});

test("a bake that fails removes what it made, says why in the doctor, and waits a day unless its script changes (049)", async () => {
  const lxc = backend("proxmox-lxc", { fail: (script) => (script.startsWith("set -euo pipefail") ? { ...ok("bake: rust's script, as root\nE: Unable to locate package ripgrep\n"), exitCode: 100 } : null) });
  const { bakes: on, storage, clock, config } = bakes([lxc.backend]);
  const line = await on.bake("rust", lxc.backend, "linux");
  assert.deepEqual(line, { name: "rust for linux on proxmox-lxc", outcome: "failed", detail: "It exited with 100: E: Unable to locate package ripgrep" });
  assert.deepEqual(lxc.removed, ["7000"]);
  const [check] = await on.checks();
  assert.deepEqual([check!.name, check!.status], ["Build of rust for linux on proxmox-lxc", "warn"]);
  assert.equal(check!.detail, "Its last build, on 2026-10-03, failed: It exited with 100: E: Unable to locate package ripgrep. Its boxes run its script as they start meanwhile.");

  // Boxes go on running the script; the bake waits a day.
  await storage.set("images/usage/rust/proxmox-lxc/linux", [NOW]);
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);
  assert.equal(lxc.removed.length, 1, "not tried again");
  clock.now += DAY;
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);
  assert.equal(lxc.removed.length, 2, "tried again a day later");

  // A changed script is tried at once.
  config.images = { rust: { ...IMAGE, script: "apt-get install -y ripgrep\n# again\n" } };
  on.ready(box({ name: "rust", state: "done" }));
  await settled(on);
  assert.equal(lxc.removed.length, 3);
});

test("the nightly upkeep removes unused builds, those of removed images and those left by a bake, bakes again those in use, and keeps a build a box still uses (049)", async () => {
  const lxc = backend("proxmox-lxc", { stuck: new Set(["7002"]) });
  const { bakes: on, storage, clock, config } = bakes([lxc.backend], { rust: IMAGE, idle: IMAGE, gone: IMAGE, always: { ...IMAGE, kinds: ["linux-desktop-cpu"], bake: "always" } });
  for (const name of ["rust", "idle", "gone"]) await on.bake(name, lxc.backend, "linux");
  assert.deepEqual(lxc.builds.filter((build) => !build.current).map((build) => `${build.ref} ${build.image}`), ["7000 rust", "7002 idle", "7004 gone"]);
  // One left by a bake that did not end, and a refreshed standard build.
  lxc.builds.push({ ref: "7099", image: "rust", kind: "linux", build: "build.x", record: null, current: false });
  lxc.builds.push(standard("9002", "linux-desktop-cpu", "build.20261001-020000-dddd"));
  lxc.builds[0] = standard("9000", "linux", "build.20261010-020000-cccc");
  clock.now += 31 * DAY;
  const used = (await storage.get<Bake>("images/bake/rust/proxmox-lxc/linux"))!;
  await storage.set("images/bake/rust/proxmox-lxc/linux", { ...used, used: clock.now - DAY });
  config.images = { rust: IMAGE, idle: IMAGE, always: config.images.always! };

  const lines = await on.maintain();
  assert.deepEqual(
    lines.map((line) => `${line.name}: ${line.outcome}, ${line.detail.replace(/build\.\d{8}-\d{6}-[0-9a-f]{4}/, "<build>")}`),
    [
      "gone for linux on proxmox-lxc: removed, its image no longer covers the kind there",
      "idle for linux on proxmox-lxc: removed, no box started from it for 30 days",
      "rust for linux on proxmox-lxc: removed, 7099 was left by a bake that did not end",
      "rust for linux on proxmox-lxc: baked, now <build>, in 0 s",
      "always for linux-desktop-cpu on proxmox-lxc: baked, now <build>, in 0 s",
    ],
  );
  assert.deepEqual(lxc.removed.filter((ref) => ["7000", "7002", "7004", "7099"].includes(ref)).sort(), ["7000", "7004", "7099"]);
  assert.deepEqual(await storage.get("images/bake-retired"), [{ backend: "proxmox-lxc", ref: "7002" }], "idle's build has a box still, so it waits");

  // Once no box uses it, the next upkeep removes it.
  const stuck = new Set<string>();
  const freed = backend("proxmox-lxc", { stuck });
  const again = new ImageBakes({ backends: () => [freed.backend], images: () => config.images, storage, setup: "/plugin/setup", now: () => clock.now });
  await again.maintain({ until: 0 });
  assert.deepEqual(freed.removed, ["7002"]);
  assert.deepEqual(await storage.get("images/bake-retired"), []);
});

test("removing an image removes its builds at once (049)", async () => {
  const lxc = backend();
  const { bakes: on, storage, config } = bakes([lxc.backend]);
  await on.bake("rust", lxc.backend, "linux");
  config.images = {};
  on.settle("rust");
  await settled(on);
  assert.ok(lxc.removed.includes("7000"));
  assert.deepEqual(await storage.list("images/bake/"), []);
});

test("the bake's script runs the image's script as root and its check as the box user, then finalizes, keeping the standard build's release notes (049)", () => {
  const script = bakeScript("rust", "linux-desktop-cpu", "docker", "build.20261003-100000-abcd", true);
  const lines = script.split("\n");
  assert.ok(lines.includes(`sudo -n env BB_BOX_IMAGE='rust' BB_BOX_KIND='linux-desktop-cpu' BB_BOX_BACKEND='docker' BB_BOX_ARCH="$(uname -m | sed s/aarch64/arm64/)" bash "$HOME/.bb-box-image/setup.sh"`));
  assert.ok(lines.includes(`(set -a; [ ! -r /etc/environment ] || . /etc/environment; set +a; env BB_BOX_IMAGE='rust' BB_BOX_KIND='linux-desktop-cpu' BB_BOX_BACKEND='docker' BB_BOX_ARCH="$(uname -m | sed s/aarch64/arm64/)" bash "$HOME/.bb-box-image/check.sh")`), "the check reads the PATH the script set");
  assert.ok(lines.includes("sudo -n bash /var/tmp/bb-box-build/proxmox-lxc/template/guest/finalize.sh /var/tmp/bb-box-build/proxmox-lxc/template desktop"));
  assert.ok(lines.indexOf(lines.find((line) => line.includes("finalize.sh"))!) < lines.indexOf(lines.find((line) => line.startsWith("sudo -n sh -c 'cp -p /usr/share/bb-box/.bake-keep/*"))!));
  assert.ok(script.includes("BUILD_ID=%s\\n' 'build.20261003-100000-abcd'"));
  assert.ok(!bakeScript("rust", "linux", "proxmox-lxc", "build.x", false).includes("check.sh"));
  assert.ok(lines.indexOf("sudo -n install -m 0755 /var/tmp/bb-box-build/proxmox-lxc/template/guest/bb-box-feature.sh /usr/local/bin/bb-box-feature") < lines.findIndex((line) => line.includes(".bb-box-image/setup.sh")), "bb-box-feature is there before the script");
  const syntax = spawnSync("bash", ["-n"], { input: script });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
});

test("a try runs the script as a build does, then the check and the kind's check on a box of the build, and removes all it made (049)", async () => {
  const lxc = backend();
  const { bakes: on, storage } = bakes([lxc.backend], {});
  const result = await on.try({ name: "rust", kind: "linux", script: IMAGE.script, check: IMAGE.check! });
  assert.equal(result.ok, true, tryText(result));
  assert.deepEqual(
    result.checks.map((check) => [check.name, check.ok]),
    [
      ["the script and the check, in the build box", true],
      ["the check, on a box of the build", true],
      ["the kind's check (bb-box-check-headless)", true],
    ],
  );
  assert.equal(result.checks[2]!.detail, "2 checks passed");
  assert.match(result.checks[1]!.detail, /^passed in \d+\.\d s$/, "the time, not the check's last line of output");
  assert.deepEqual(lxc.removed, ["7001", "7000"], "the trial box, then the build");
  assert.deepEqual(await storage.list("images/"), [], "a try keeps nothing");
  assert.match(tryText(result), /^The script passed on proxmox-lxc \(linux\), in \d+ s, as a build runs it\.\n- the script and the check, in the build box: ok, \d+ s, with finalizing\n/);
  assert.ok(lxc.ran.some((one) => one.script.includes(`BB_BOX_IMAGE='rust' BB_BOX_KIND='linux' BB_BOX_BACKEND='proxmox-lxc'`)));
});

test("a try's check line says ok with its time, or FAIL with its exit code and the line that says why, never the check's own output on a pass", () => {
  const ran = { exitCode: 0, timedOut: false, durationMs: 1234, stdout: " __________\n< image ok >\n                ||     ||\n" };
  assert.equal(checkDetail(ran), "passed in 1.2 s");
  assert.equal(checkDetail({ ...ran, exitCode: 127, stdout: "checking\nbash: line 3: cargo: command not found\n\n" }), "exit code 127: bash: line 3: cargo: command not found");
  assert.equal(checkDetail({ ...ran, exitCode: 1, stdout: "x".repeat(300) }), `exit code 1: ${"x".repeat(199)}…`);
  assert.equal(checkDetail({ ...ran, exitCode: null, timedOut: true, stdout: "" }), "out of time after 10 minutes");
  assert.equal(checkDetail({ ...ran, exitCode: 2, stdout: "" }), "exit code 2");
});

test("a try with keep leaves a box of its build, or of the build box a failing script left, and the build goes with that box (#451)", async () => {
  const lxc = backend();
  const { bakes: on, storage, kept, keeping } = bakes([lxc.backend], {});
  const keep = { threadId: "thr_abc", projectId: null };

  const passed = await on.try({ name: "rust", kind: "linux", script: IMAGE.script, check: IMAGE.check!, keep });
  assert.equal(passed.ok, true, tryText(passed));
  assert.deepEqual(passed.kept, { box: "kept-1", detail: "a box of the build" });
  assert.deepEqual({ ...kept.get("bx1"), build: undefined }, { name: "kept-1", from: "7000", image: "rust", build: undefined }, "a box of the captured build");
  assert.match(kept.get("bx1")!.build ?? "", /^build\.\d{8}-\d{6}-[0-9a-f]{4}$/, "with the try's build ID");
  assert.deepEqual(lxc.removed, ["7001"], "only the trial box goes; the build stays for the box");
  assert.deepEqual(await storage.list("images/try-kept/"), ["images/try-kept/proxmox-lxc/7000"]);
  assert.match(tryText(passed), /\nKept box kept-1 \(a box of the build\)/);

  // Released: its build goes.
  kept.delete("bx1");
  await on.released({ id: "bx1", backend: "proxmox-lxc", image: { from: "7000" } });
  assert.deepEqual(lxc.removed, ["7001", "7000"]);
  assert.deepEqual(await storage.list("images/try-kept/"), []);

  // A failing script: the build box as it left it.
  const failing = backend("proxmox-lxc", { fail: (script) => (script.startsWith("set -euo pipefail") ? { ...ok("E: Unable to locate package ripgrep\n"), exitCode: 100 } : null) });
  const second = bakes([failing.backend], {});
  const failed = await second.bakes.try({ name: "try", kind: "linux", script: "apt-get install -y ripgrep\n", keep });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.kept, { box: "kept-1", detail: "a box of the build box as the script left it" });
  assert.deepEqual(second.kept.get("bx1")?.from, "7000");
  assert.deepEqual(failing.removed, [], "the build box is kept as a build");

  // The nightly upkeep keeps a kept build while its box is there, and removes it after.
  assert.deepEqual(await second.bakes.maintain(), []);
  assert.deepEqual(failing.removed, []);
  second.kept.delete("bx1");
  await second.bakes.maintain();
  assert.deepEqual(failing.removed, ["7000"]);

  // A box that will not start: the try says why, and keeps nothing.
  keeping.fail = true;
  const unkept = await on.try({ name: "rust", kind: "linux", script: IMAGE.script, keep });
  assert.deepEqual(unkept.kept, { box: null, detail: "The box could not start: no room" });
  assert.deepEqual(await storage.list("images/try-kept/"), []);
  assert.ok(lxc.removed.includes("7002") && lxc.removed.includes("7003"), "its build and trial box go, as without keep");
});

test("a try that fails says which step and gives the build's last lines; a GPU desktop, or no backend that builds, is refused (049)", async () => {
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n");
  const lxc = backend("proxmox-lxc", { fail: (script) => (script.startsWith("set -euo pipefail") ? { ...ok(`${lines}\nE: Unable to locate package ripgrep\n`), exitCode: 100 } : null) });
  const { bakes: on } = bakes([lxc.backend], {});
  const result = await on.try({ name: "try", kind: "linux", script: "apt-get install -y ripgrep\n" });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks, [{ name: "the script, in the build box", ok: false, detail: "It exited with 100: E: Unable to locate package ripgrep" }]);
  assert.equal(result.output.length, 200);
  assert.equal(result.output.at(-1), "E: Unable to locate package ripgrep");
  assert.deepEqual(lxc.removed, ["7000"]);
  assert.match(tryText(result), /^The script failed on proxmox-lxc \(linux\), in \d+ s, as a build runs it\.\n- the script, in the build box: FAIL, It exited with 100/);

  await assert.rejects(on.try({ name: "try", kind: "linux-desktop", script: "true\n" }), (error: unknown) => error instanceof BoxError && error.code === "unsupported" && /Try it on linux-desktop-cpu/.test(error.message));
  await assert.rejects(on.try({ name: "try", kind: "linux", script: "true\n", on: "docker" }), (error: unknown) => error instanceof BoxError && error.code === "not_found");
  const plain = bakes([backend("docker", { startsFrom: false }).backend], {});
  await assert.rejects(plain.bakes.try({ name: "try", kind: "linux", script: "true\n" }), /No backend that is on builds linux images/);
});
