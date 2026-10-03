import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImageRecord } from "../src/backends/images.ts";
import type { Backend, BackendImages, Capacity, ImageBuild } from "../src/backends/types.ts";
import type { Versions } from "../src/backends/versions.ts";
import type { RefreshOptions, RefreshResult } from "../src/core/refresh.ts";
import { AUTOMATION, ImageJobs } from "../src/plugin/images.ts";
import { MemoryStorage } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-10-03T02:00:00Z");
const [PINS, APP] = ["p".repeat(64), "a".repeat(64)];

const record = (days: number, changes: Partial<ImageRecord> = {}): ImageRecord => ({
  contract: 1,
  image: "standard",
  kind: "linux",
  arch: "x86_64",
  build: `build.${days}`,
  built: new Date(NOW - days * DAY).toISOString(),
  base: null,
  os: "Ubuntu 24.04.5 LTS",
  aptSnapshot: null,
  pins: PINS,
  bbApp: APP,
  tools: { node: "24.21.0" },
  nvidia: null,
  layer: null,
  sizeGiB: null,
  ...changes,
});
const build = (ref: string, kind: string, rec: ImageRecord | null, changes: Partial<ImageBuild> = {}): ImageBuild => ({ ref, image: "standard", kind, build: rec?.build ?? null, record: rec, current: true, ...changes });

/** A backend with image operations whose builds are `builds`, and room unless `full`. */
function backend(id: string, builds: ImageBuild[], options: { boxes?: string[]; full?: string } = {}) {
  const removed: string[] = [];
  const images: BackendImages = {
    list: async () => ({ builds, boxes: options.boxes ?? [] }),
    box: async () => assert.fail("the job does not make boxes itself"),
    capture: async () => assert.fail("the job does not capture"),
    replace: async () => assert.fail("the job does not replace"),
    remove: async (ref) => void removed.push(ref),
  };
  const capacity: Capacity = { ok: !options.full, message: options.full ?? null, warm: null, hosts: [] };
  const made = {
    id,
    label: id,
    nature: "virtual",
    images,
    kinds: () => [...new Set(builds.map((one) => one.kind))].map((kind) => ({ id: kind })),
    capacity: async () => capacity,
  } as unknown as Backend;
  return { backend: made, removed };
}

const versions = (async () => ({ resolvedAt: "", following: true, aptSnapshot: { pinned: "", version: "" }, tools: [{ name: "node", arch: "x86_64", pinned: "24.21.0", version: "24.21.0", source: "", kept: null }], files: { "pins.json": "", "desktop-pins.tsv": "", "apt-snapshot": "" } })) as unknown as () => Promise<Versions>;

function jobs(backends: Backend[], options: { app?: string; fail?: string[]; clock?: { now: number } } = {}) {
  const clock = options.clock ?? { now: NOW };
  const refreshed: string[] = [];
  const storage = new MemoryStorage();
  const job = new ImageJobs({
    backends: () => backends,
    setup: "/plugin/setup",
    bbUrl: () => "https://bb.example.com",
    facts: { pins: async () => PINS, bbApp: async () => options.app ?? APP },
    storage,
    now: () => clock.now,
    versions: versions as never,
    refresh: (async (refresh: RefreshOptions): Promise<RefreshResult> => {
      refreshed.push(`${refresh.current.ref}${refresh.replace === false ? " (try)" : ""}`);
      clock.now += 60_000;
      const failed = options.fail?.includes(refresh.current.ref);
      return {
        ok: !failed,
        build: failed ? null : { ...refresh.current, build: `build.new-${refresh.current.ref}` },
        checks: [],
        reason: failed ? "The new build failed the kind's check: docker FAIL" : null,
        output: ["a line", "the last line"],
        seconds: 60,
      };
    }) as never,
  });
  return { job, refreshed, storage, clock };
}

test("images are due in 049's order: failing the doctor, past their interval, another BB app, other pins; Windows and project images wait (049)", async () => {
  const lxc = backend("proxmox-lxc", [
    build("9100", "linux", record(1)),
    build("9101", "linux-desktop-cpu", record(10)),
    build("9102", "linux-desktop-wayland-cpu", record(1, { pins: "o".repeat(64) })),
    build("9103", "linux-desktop", record(1, { contract: 0 })),
    build("9104", "windows-desktop", null),
    build("7000", "linux", record(1), { image: "rust", current: false }),
  ]);
  const tart = backend("tart", [build("mac1/bb-box-macos", "macos", record(20, { bbApp: null })), build("mac1/bb-box-linux", "linux-arm64", record(1, { bbApp: "b".repeat(64) }))]);
  const { job } = jobs([lxc.backend, tart.backend]);
  const views = await job.list();
  assert.deepEqual(
    views.map((view) => [view.name, view.due]),
    [
      ["proxmox-lxc/9103", "it fails the doctor"],
      ["proxmox-lxc/9101", "it is 10 days old, past its 7-day interval"],
      ["tart/mac1/bb-box-linux", "it has another build of BB's app than BB's server gives"],
      ["proxmox-lxc/9102", "it was built with other pins than this bb-box's"],
      ["proxmox-lxc/9100", null],
      ["tart/mac1/bb-box-macos", null],
    ],
    "a macOS image is due after a month, and BB's app does not count on it",
  );
});

test("a run removes what a run left, refreshes the due images most needed first, and says what became of each", async () => {
  const lxc = backend("proxmox-lxc", [build("9100", "linux", record(1)), build("9101", "linux-desktop-cpu", record(10)), build("9103", "linux-desktop", record(1, { contract: 0 })), build("7005", "linux", record(0), { current: false })], { boxes: ["7004"] });
  const { job, refreshed, storage } = jobs([lxc.backend], { fail: ["9101"] });
  const result = await job.refreshAll();
  assert.deepEqual(lxc.removed, ["7004", "7005"], "an image box and a refresh's build left by a run that did not end");
  assert.deepEqual(refreshed, ["9103", "9101"]);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.lines.map((line) => [line.name, line.outcome, line.detail]),
    [
      ["proxmox-lxc/9103", "refreshed", "now build.new-9103, in 60 s"],
      ["proxmox-lxc/9101", "failed", "The new build failed the kind's check: docker FAIL"],
      ["proxmox-lxc/9100", "skipped", "not due"],
    ],
  );
  assert.equal((await storage.get<{ ok: boolean }>("images/state/proxmox-lxc/9101"))?.ok, false);
  assert.equal(await storage.get("images/lock"), undefined, "the lock goes");

  // The failed image waits until what it is built from changes; build tries it at once.
  const again = await job.refreshAll();
  assert.deepEqual(again.lines.find((line) => line.name === "proxmox-lxc/9101")?.outcome, "skipped");
  assert.match(again.lines.find((line) => line.name === "proxmox-lxc/9101")!.detail, /bb box images build proxmox-lxc\/9101 tries again$/);
  const tried = await job.build("proxmox-lxc/9101", { try: true, signal: AbortSignal.timeout(5_000) });
  assert.equal(tried.ok, false);
  assert.equal(refreshed.at(-1), "9101 (try)");
  await assert.rejects(job.build("proxmox-lxc/9999", { signal: AbortSignal.timeout(5_000) }), /There is no image proxmox-lxc\/9999\. bb box images list names them: /);
});

test("a failed image is tried again once BB's app changes, and an image waits when its host has no room", async () => {
  const lxc = backend("proxmox-lxc", [build("9101", "linux", record(10))]);
  const first = jobs([lxc.backend], { fail: ["9101"] });
  await first.job.refreshAll();
  const storage = first.storage;
  // Another build of BB's app, with what the first run recorded.
  const job = new ImageJobs({
    backends: () => [lxc.backend],
    setup: "/plugin/setup",
    bbUrl: () => null,
    facts: { pins: async () => PINS, bbApp: async () => "c".repeat(64) },
    storage,
    now: () => NOW,
    versions: versions as never,
    refresh: (async (refresh: RefreshOptions) => ({ ok: true, build: refresh.current, checks: [], reason: null, output: [], seconds: 1 })) as never,
  });
  assert.equal((await job.refreshAll()).lines[0]!.outcome, "refreshed");

  const full = backend("proxmox-lxc", [build("9101", "linux", record(10))], { full: "The node has 2 GiB of memory free." });
  const waiting = jobs([full.backend]);
  const result = await waiting.job.refreshAll();
  assert.deepEqual([result.lines[0]!.outcome, result.lines[0]!.detail], ["waiting", "no room for its build and trial boxes: The node has 2 GiB of memory free."]);
  assert.deepEqual(waiting.refreshed, []);
  const check = (await waiting.job.checks()).find((one) => one.id === "images.proxmox-lxc/9101")!;
  assert.match(check.detail, /waited: no room for its build and trial boxes: The node has 2 GiB of memory free\. It waits for the next night\.$/);
  assert.equal(result.ok, true, "waiting is not failing");
});

test("a run starts no image after its time limit, and one run at a time", async () => {
  const lxc = backend("proxmox-lxc", [build("9101", "linux", record(10)), build("9102", "linux", record(11))]);
  const { job, refreshed, storage } = jobs([lxc.backend]);
  const limited = await job.refreshAll({ limitMs: 0 });
  assert.deepEqual(limited.lines.map((line) => line.outcome), ["not started", "not started"]);
  assert.deepEqual(refreshed, []);
  const [a, b] = [job.refreshAll(), job.refreshAll()];
  assert.equal(a, b, "a second call joins the run");
  await a;
  await storage.set("images/lock", { at: NOW });
  const locked = await job.refreshAll();
  assert.deepEqual([locked.ok, locked.lines[0]!.outcome], [false, "not started"]);
  assert.match(locked.lines[0]!.detail, /^Another run started at 2026-10-03T02:00:00\.000Z and has not ended\.$/);
});

test("the doctor's checks: Nightly rebuilds, and each image whose last rebuild failed (049)", async () => {
  const lxc = backend("proxmox-lxc", [build("9101", "linux", record(10))]);
  const { job, clock } = jobs([lxc.backend], { fail: ["9101"] });
  const before = await job.checks();
  assert.deepEqual([before[0]!.name, before[0]!.status], ["Nightly rebuilds", "warn"]);
  assert.equal(before[0]!.fix, `Have a BB script automation run it each night: ${AUTOMATION}`);
  await job.refreshAll();
  const after = await job.checks();
  assert.deepEqual([after[0]!.status, after[0]!.detail], ["ok", "The last run ended today, with a failure."]);
  assert.match(after[1]!.detail, /^Its last rebuild, on 2026-10-03, failed: The new build failed the kind's check: docker FAIL Its last line: the last line$/);
  assert.equal(after[1]!.fix, "Fix the cause, then run bb box images build proxmox-lxc/9101. bb box images list shows its last lines.");
  clock.now += 9 * DAY;
  assert.deepEqual([(await job.checks())[0]!.status, (await job.checks())[0]!.detail], ["warn", "No run of bb box images refresh has ended for 9 days."]);
  assert.deepEqual(await jobs([backend("ssh-pool", []).backend]).job.checks(), [], "no images, no checks");
});
