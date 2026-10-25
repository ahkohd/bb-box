import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HostRecord } from "../src/backends/hetzner/hosts.ts";
import { HOST_IMAGE_REBUILT_AFTER_MS, PREPARE_FOR_SNAPSHOT, progressScript, readProgress, setupFingerprint, startBuildScript, type RemoteBuild } from "../src/backends/hetzner/host-image.ts";
import { setupDir } from "../src/backends/setup-dir.ts";
import type { AcquireHooks, BoxIdentity } from "../src/backends/types.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";
import { hetznerConfig, hetznerWorld } from "./fake-hetzner-world.ts";

const signal = () => AbortSignal.timeout(30_000);
const hooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

function builder(options: { failOn?: string } = {}) {
  const built: string[] = [];
  const ran: { host: string; script: string }[] = [];
  return {
    built,
    ran,
    options: {
      buildImage: async (host: HostRecord, _cli: unknown, image: string, target: string) => {
        if (options.failOn === target) throw new Error(`build.sh failed on ${target}`);
        built.push(`${host.serverName} ${image} ${target}`);
      },
      runOnHost: async (host: HostRecord, script: string) => {
        ran.push({ host: host.serverName, script });
        return { exitCode: 0, stderr: "" };
      },
      hostImageFingerprint: () => "fp1",
    },
  };
}

let counter = 0;
const box = (): BoxIdentity => ({ boxId: `bximg${String(++counter).padStart(8, "0")}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind: "linux", createdAt: 1_790_000_000_000, size: { cores: 2, memoryMiB: 4096, diskGiB: null } });

test("a host image is built on a server of its own from the base image, with every kind's image, cleaned, shut down, snapshotted with its labels, and the server deleted", async () => {
  const { api, backend } = hetznerWorld();
  const { built, ran, options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options);
  const serversSeen: { name: string; labels: Record<string, string>; image: number | null }[] = [];
  api.intercept = (call) => {
    if (call.method === "POST" && call.path.endsWith("/actions/create_image")) for (const server of api.servers.values()) serversSeen.push({ name: server.name, labels: server.labels, image: server.image });
    return undefined;
  };
  await hetzner.buildHostImage("there is no host image yet", signal());
  const [buildServer] = serversSeen;
  assert.equal(buildServer!.labels["bbbox-role"], "image-build");
  assert.equal(buildServer!.labels["bbbox-install"], "test");
  assert.deepEqual(built.map((line) => line.split(" ").slice(1).join(" ")), ["bbbox/linux:1 linux", "bbbox/linux-desktop:1 desktop", "bbbox/linux-desktop-wayland:1 desktop-wayland"]);
  assert.deepEqual(ran.map((each) => each.script), [PREPARE_FOR_SNAPSHOT]);
  assert.equal(api.shutdownsAsked, 1);
  assert.equal(api.servers.size, 0, "the build server is gone");
  const [snapshot] = api.images.values();
  assert.deepEqual(snapshot!.labels, { "bbbox-install": "test", "bbbox-role": "host-image", "bbbox-build": buildServer!.labels["bbbox-host"], "bbbox-setup": "fp1", "bbbox-arch": "x86" });
  assert.deepEqual(await hetzner.hostRecords.records(), []);
  const guest = await hetzner.acquire(box(), null, hooks, signal());
  const host = [...api.servers.values()].find((each) => each.name === guest.host)!;
  assert.equal(host.image, snapshot!.id, "a new host starts from the snapshot");
  assert.equal(host.labels["bbbox-image"], `build-${buildServer!.labels["bbbox-host"]}`);
});

test("the cleaning before a snapshot forgets the build's tailnet node, SSH host keys and cloud-init's state, so each host from it starts as itself", () => {
  for (const step of ["cloud-init clean --logs --machine-id", "rm -f /etc/ssh/ssh_host_*", "tailscale logout", "rm -rf /var/lib/tailscale/tailscaled.state", "rm -f /root/.ssh/authorized_keys"]) assert.ok(PREPARE_FOR_SNAPSHOT.includes(step), step);
  assert.ok(PREPARE_FOR_SNAPSHOT.indexOf("tailscale logout") > PREPARE_FOR_SNAPSHOT.indexOf("cloud-init clean"), "the tailnet goes last, after a moment, so the SSH session ends first");
});

test("maintain builds a host image when none is there, and keeps the two newest", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  await hetzner.maintain(signal());
  for (let i = 0; i < 200 && api.images.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.images.size, 1);
  for (let i = 0; i < 3; i++) {
    api.advanceClock(HOST_IMAGE_REBUILT_AFTER_MS + 60_000);
    await hetzner.buildHostImage("the host image is more than a week old", signal());
  }
  assert.equal(api.images.size, 2);
  const newest = Math.max(...[...api.images.keys()]);
  assert.ok(api.images.has(newest));
});

test("a host image is due when there is none, when bb-box's scripts changed, or after a week, and not otherwise", async () => {
  const { api, backend } = hetznerWorld();
  let fingerprint = "fp1";
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", { ...options, hostImageFingerprint: () => fingerprint });
  await hetzner.buildHostImage("there is no host image yet", signal());
  const report = async () => (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!.detail;
  assert.match(await report(), /Hosts start from snapshot \d+, built 0 days ago\. 1 kept, 4\.2 GB, about EUR 0\.05 a month\.$/);
  fingerprint = "fp2";
  assert.match(await report(), /A new one is due, as bb-box's image scripts changed since the host image was built\./);
  fingerprint = "fp1";
  api.advanceClock(HOST_IMAGE_REBUILT_AFTER_MS + 60_000);
  assert.match(await report(), /A new one is due, as the host image is more than a week old\./);
});

test("a failed build deletes its server, keeps no snapshot, says so in the doctor, and is tried again after 10 minutes, then 20, 40 and every hour", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder({ failOn: "desktop" });
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  await assert.rejects(hetzner.buildHostImage("there is no host image yet", signal()), /build\.sh failed on desktop/);
  assert.equal(api.servers.size, 0);
  assert.equal(api.images.size, 0);
  const detail = async () => (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!;
  const failedAt = api.now;
  assert.equal((await detail()).status, "warn");
  assert.match((await detail()).detail, new RegExp(`The last build failed at ${new Date(failedAt).toISOString()}; bb-box tries again at ${new Date(failedAt + 10 * 60_000).toISOString()}\\.`));
  const creates = () => api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
  let before = creates();
  api.advanceClock(9 * 60_000);
  await hetzner.maintain(signal());
  await settle();
  assert.equal(creates(), before, "not again within 10 minutes");
  api.advanceClock(2 * 60_000);
  await hetzner.maintain(signal());
  await settle();
  assert.equal(creates(), before + 1, "again after them");
  for (let i = 0; i < 300 && /A new one is being built/.test((await detail()).detail); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match((await detail()).detail, /, the 2nd failure in a row; bb-box tries again at /);
  const secondAt = api.now;
  assert.match((await detail()).detail, new RegExp(`tries again at ${new Date(secondAt + 20 * 60_000).toISOString()}\\.`));
  before = creates();
  api.advanceClock(19 * 60_000);
  await hetzner.maintain(signal());
  await settle();
  assert.equal(creates(), before, "then not within 20 minutes");
});

test("no host image is built past the monthly limit, nor when the hosts' image is a snapshot set in the settings", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  await backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 0.1 }), new MemoryStorage(), "test", options).maintain(signal());
  await backend(hetznerConfig({ hostImage: 4242, hostImageLabel: "snapshot-4242", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options).maintain(signal());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length, 0);
});

test("the hosts' sweep leaves a build server alone, and the builds' own sweep deletes one a crash left", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const storage = new MemoryStorage();
  const config = hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: null });
  let crashed = false;
  api.intercept = (call) => {
    if (!crashed && call.method === "POST" && call.path.endsWith("/actions/shutdown")) {
      crashed = true;
      return "hang";
    }
    return undefined;
  };
  const first = backend(config, storage, "test", options);
  void first.buildHostImage("there is no host image yet");
  for (let i = 0; i < 200 && !crashed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  api.intercept = undefined;
  const left = [...api.servers.values()].find((each) => each.labels["bbbox-role"] === "image-build")!.name;
  const restarted = backend(config, storage, "test", { ...options, hostImageFingerprint: () => "fp1" });
  await restarted.hostRecords.sweep(signal());
  assert.equal(api.servers.size, 1, "the hosts' sweep leaves the build server alone");
  api.advanceClock(11 * 60_000);
  await restarted.maintain(signal());
  assert.equal([...api.servers.values()].filter((each) => each.labels["bbbox-role"] === "image-build").length, 1, "a build may run for hours");
  api.advanceClock(3 * 3_600_000);
  await restarted.maintain(signal());
  assert.ok(![...api.servers.values()].some((each) => each.name === left && each.status !== "deleting"), "the builds' sweep deleted the one the crash left");
});

test("the setup's fingerprint changes when a file under setup/docker does, and not otherwise", () => {
  const copy = tempDir("setup-copy");
  cpSync(join(setupDir(), "docker"), join(copy, "docker"), { recursive: true });
  const before = setupFingerprint(copy);
  assert.equal(setupFingerprint(copy), before);
  writeFileSync(join(copy, "docker", "extra.txt"), "changed\n");
  assert.notEqual(setupFingerprint(copy), before);
});

test("a host image is built with BB's app in it, labelled with its digest, and is due again once BB's server gives another", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  let app = "a".repeat(64);
  const context = { bbUrl: () => "https://bb.example.test", images: { pins: async () => null, bbApp: async () => app } };
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options, context);
  await hetzner.buildHostImage("there is no host image yet", signal());
  assert.equal([...api.images.values()][0]!.labels["bbbox-app"], "a".repeat(16));
  const detail = async () => (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!.detail;
  assert.doesNotMatch(await detail(), /A new one is due/);
  app = "b".repeat(64);
  assert.match(await detail(), /A new one is due, as BB's server gives another build of its app than the host image has\./);
});

test("build.sh is given BB's URL, so the images carry BB's app, and the image's name and target", async () => {
  const setup = tempDir("setup-args");
  const { mkdirSync, readFileSync } = await import("node:fs");
  mkdirSync(join(setup, "docker"));
  writeFileSync(join(setup, "docker", "build.sh"), `echo "$DOCKER_HOST $*" > '${join(setup, "args")}'\n`);
  const { runBuildScript } = await import("../src/backends/hetzner/host-image.ts");
  const { DockerCli } = await import("../src/backends/docker/cli.ts");
  const lines: string[] = [];
  assert.equal(await runBuildScript(new DockerCli("unix:///tmp/h1.sock"), "bbbox/linux:1", "linux", "https://bb.example.test", (line) => lines.push(line), signal(), setup), 0);
  assert.equal(readFileSync(join(setup, "args"), "utf8").trim(), "unix:///tmp/h1.sock --bb-url https://bb.example.test --tag bbbox/linux:1 linux");
  await runBuildScript(new DockerCli("unix:///tmp/h1.sock"), "bbbox/linux:1", "linux", null, () => {}, signal(), setup);
  assert.equal(readFileSync(join(setup, "args"), "utf8").trim(), "unix:///tmp/h1.sock --tag bbbox/linux:1 linux");
});

test("a build Hetzner refuses a server for, as past the project's core limit, waits for room: no failure, the doctor says why, and the next maintain tries again", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  api.projectServerLimit = 0;
  await hetzner.buildHostImage("there is no host image yet", signal());
  const check = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!;
  assert.equal(check.status, "ok");
  assert.match(check.detail, /The last build waited for room: at .* Hetzner Cloud refused its server \(\(403 resource_limit_exceeded\): server limit exceeded\); bb-box tries again at its next check\. Hetzner limits the shared vCPUs of the whole account/);
  assert.doesNotMatch(check.detail, /failed/);
  api.projectServerLimit = 10;
  await hetzner.maintain(signal());
  for (let i = 0; i < 200 && api.images.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(api.images.size, 1, "the next maintain built it");
  assert.doesNotMatch((await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!.detail, /waited for room/);
});

test("a snapshot that takes longer than ten minutes, as a 320 GB disk's can, is waited for while Hetzner Cloud makes it", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options);
  api.pollsUntilSnapshotMade = 200;
  await hetzner.buildHostImage("there is no host image yet", signal());
  assert.deepEqual([...api.images.values()].map((each) => each.status), ["available"]);
  assert.equal(api.servers.size, 0, "the build server goes once its snapshot is made");
});

test("when bb-box stops waiting for a snapshot Hetzner Cloud is still making, it keeps the build server, builds no other, and takes the snapshot once made, saying so", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const lines: string[] = [];
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options, { log: (line: string) => void lines.push(line) });
  api.pollsUntilSnapshotMade = 5_000;
  await hetzner.buildHostImage("there is no host image yet", signal());
  const [snapshot] = api.images.values();
  assert.equal(snapshot!.status, "creating");
  assert.equal(api.servers.size, 1, "the build server stays while its snapshot is made");
  assert.ok(lines.some((line) => /^Snapshot \d+ of bb-box-hz-\S+ is still being made, so bb-box keeps the build server/.test(line)));
  const check = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!;
  assert.equal(check.status, "ok", "not a failure");
  assert.match(check.detail, new RegExp(`Hetzner Cloud is making a new one, snapshot ${snapshot!.id}, which bb-box takes once it is ready\\.`));

  const creates = () => api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length;
  const before = creates();
  await hetzner.maintain(signal());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creates(), before, "no other build while one is being made");
  assert.ok(lines.some((line) => line === `Host image snapshot ${snapshot!.id} of build ${snapshot!.labels["bbbox-build"]} (x86) is creating, no size yet: bb-box waits for Hetzner Cloud to finish it, and keeps its build server until then.`));
  assert.equal(api.servers.size, 1);

  snapshot!.status = "available";
  snapshot!.imageSize = 31.5;
  await hetzner.maintain(signal());
  assert.ok(lines.some((line) => line === `Host image snapshot ${snapshot!.id} of build ${snapshot!.labels["bbbox-build"]} (x86) is available, 31.5 GB: bb-box adopts it as the host image, the newest build for its current scripts.`));
  assert.ok(lines.some((line) => /^The build server bb-box-hz-\S+ waited for its snapshot, which is no longer being made: bb-box deletes it\.$/.test(line)));
  assert.equal(api.servers.size, 0);
  const guest = await hetzner.acquire(box(), null, hooks, signal());
  assert.equal([...api.servers.values()].find((each) => each.name === guest.host)!.image, snapshot!.id, "the next host starts from it");
});

test("a host image snapshot Hetzner Cloud did not make, or one still creating after two hours, is deleted, and bb-box says which", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const lines: string[] = [];
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options, { log: (line: string) => void lines.push(line) });
  const labels = (build: string) => ({ "bbbox-install": "test", "bbbox-role": "host-image", "bbbox-build": build, "bbbox-setup": "fp1", "bbbox-arch": "x86" });
  const old = new Date(api.now - 3 * 3_600_000).toISOString();
  api.images.set(9001, { id: 9001, description: "bb-box host image dead1", status: "unavailable", created: old, labels: labels("dead1"), imageSize: null, createdFrom: 1 });
  api.images.set(9002, { id: 9002, description: "bb-box host image slow1", status: "creating", created: old, labels: labels("slow1"), imageSize: null, createdFrom: 2 });
  await hetzner.maintain(signal());
  assert.equal(api.images.has(9001), false);
  assert.equal(api.images.has(9002), false);
  assert.ok(lines.includes("Host image snapshot 9001 of build dead1 (x86) is unavailable, no size yet: bb-box deletes it, as Hetzner Cloud did not make it."));
  assert.ok(lines.includes("Host image snapshot 9002 of build slow1 (x86) is creating, no size yet: bb-box deletes it, as it has been creating for over 2 hours."));
});

test("a host image build runs on its server, so a restart of bb-box does not end it: the next run carries on with the same server, and its snapshot is the host image (#1083)", async () => {
  const { api, backend } = hetznerWorld();
  const { ran, options } = builder();
  const storage = new MemoryStorage();
  const runs = new Map<string, { starts: number; exitCode: number | null }>();
  const remote: RemoteBuild = {
    start: async (record) => {
      const run = runs.get(record.hostId);
      if (run) run.starts++;
      else runs.set(record.hostId, { starts: 1, exitCode: null });
    },
    progress: async (record, fromByte) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { exitCode: runs.get(record.hostId)?.exitCode ?? null, log: fromByte === 0 ? "building bbbox/linux:1\n" : "", nextByte: fromByte + (fromByte === 0 ? 23 : 0) };
    },
  };
  const lines: string[] = [];
  const config = hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" });
  const first = backend(config, storage, "test", { ...options, remoteBuild: remote }, { log: (line: string) => void lines.push(line) });
  const stopping = new AbortController();
  const building = first.buildHostImage("there is no host image yet", stopping.signal).catch((error: unknown) => error);
  for (let i = 0; i < 400 && runs.size === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  stopping.abort();
  await building;
  assert.equal(api.servers.size, 1, "the build server keeps running");
  assert.ok(lines.some((line) => /^bb-box stopped while it built the x86 host image on bb-box-hz-\S+, at its building step: it leaves the build server running/.test(line)));

  const [buildId] = runs.keys();
  runs.get(buildId!)!.exitCode = 0;
  const next = backend(config, storage, "test", { ...options, remoteBuild: remote }, { log: (line: string) => void lines.push(line) });
  await next.buildHostImage("there is no host image yet", signal());
  assert.equal(api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length, 1, "no second build server");
  assert.ok(lines.some((line) => /^bb-box carries on with the x86 host image build on bb-box-hz-\S+, from its building step/.test(line)));
  assert.deepEqual(ran.map((each) => each.script), [PREPARE_FOR_SNAPSHOT]);
  const [snapshot] = api.images.values();
  assert.equal(snapshot!.status, "available");
  assert.equal(snapshot!.labels["bbbox-build"], buildId);
  assert.equal(api.servers.size, 0, "the build server goes once its snapshot is made");
});

test("the build script starts once, unpacks bb-box's setup on the server, runs build.sh for each image with BB's URL and the architecture, and keeps its log and exit code there; its progress reads from where it left off (#1083)", () => {
  const script = startBuildScript({ images: [{ image: "bbbox/linux:1", target: "linux" }, { image: "bbbox/linux-desktop:1", target: "desktop" }], architecture: "arm", bbUrl: "https://bb.example.test" }, "QUJD");
  assert.match(script, /\[ ! -e "\$d\/started" \] \|\| exit 0/);
  assert.match(script, /base64 -d > "\$d\/setup\.tgz" <<'BB_BOX_SETUP'\nQUJD\nBB_BOX_SETUP/);
  assert.match(script, /bash "\$d\/setup\/docker\/build\.sh" --bb-url 'https:\/\/bb\.example\.test' --arch arm64 --tag 'bbbox\/linux:1' 'linux' \|\| \{ echo \$\? > "\$d\/exit"; exit 1; \}/);
  assert.match(script, /setsid nohup bash "\$d\/run\.sh" >> "\$d\/log" 2>&1 < \/dev\/null &\n$/);
  assert.match(progressScript(120), /tail -c \+121 "\$d\/log"/);
  assert.deepEqual(readProgress("exit=\nline one\nline two\n", 100), { exitCode: null, log: "line one\nline two\n", nextByte: 118 });
  assert.deepEqual(readProgress("exit=3\n", 5), { exitCode: 3, log: "", nextByte: 5 });
});
