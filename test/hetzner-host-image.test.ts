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

test("the setup's fingerprint changes with what the image build reads, setup/docker and Proxmox's template and common.sh, and not with docs or anything else", () => {
  const copy = tempDir("setup-copy");
  for (const part of ["docker", "proxmox-lxc/host", "proxmox-lxc/template"]) cpSync(join(setupDir(), part), join(copy, part), { recursive: true });
  const before = setupFingerprint(copy);
  assert.equal(setupFingerprint(copy), before);
  writeFileSync(join(copy, "docker", "README.md"), "a docs change\n");
  assert.equal(setupFingerprint(copy), before, "the build reads no Markdown");
  writeFileSync(join(copy, "proxmox-lxc", "host", "other.sh"), "not read by the build\n");
  assert.equal(setupFingerprint(copy), before, "of proxmox-lxc/host, the build reads only common.sh");
  writeFileSync(join(copy, "docker", "extra.txt"), "changed\n");
  const docker = setupFingerprint(copy);
  assert.notEqual(docker, before);
  writeFileSync(join(copy, "proxmox-lxc", "template", "guest", "extra.sh"), "changed\n");
  assert.notEqual(setupFingerprint(copy), docker, "the template is mounted into the build");
  writeFileSync(join(copy, "proxmox-lxc", "host", "common.sh"), "changed\n");
  assert.notEqual(setupFingerprint(copy), docker);
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
  assert.equal(await building, undefined, "a build bb-box left as it stopped is no error");
  assert.equal(await storage.get("host-image-failed-at:x86"), undefined, "nor a failure, which would put off the next try");
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

function heldBuilder() {
  const { options } = builder();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  const started: string[] = [];
  const setup = { fingerprint: "fp1" };
  return {
    started,
    setup,
    release: () => release(),
    options: {
      ...options,
      hostImageFingerprint: () => setup.fingerprint,
      buildImage: async (host: HostRecord, _cli: unknown, _image: string, target: string) => {
        if (!started.includes(host.serverName)) started.push(host.serverName);
        if (target === "linux" && host.serverName === started[0]) await held;
      },
    },
  };
}

const until = async (done: () => boolean) => {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};
const buildServers = (api: ReturnType<typeof hetznerWorld>["api"]) => [...api.servers.values()].filter((server) => server.labels["bbbox-role"] === "image-build");

test("bb-box builds one host image at a time: while the x86 build runs, the Arm one waits, and the doctor says so (#1075)", async () => {
  const { api, backend } = hetznerWorld();
  const { started, release, options } = heldBuilder();
  const hetzner = backend(hetznerConfig({ armServerType: "cax31", hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  await hetzner.maintain(signal());
  await until(() => started.length > 0);
  await hetzner.maintain(signal());
  assert.deepEqual(buildServers(api).map((server) => server.serverType), ["cpx42"]);
  const arm = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.arm-image")!;
  assert.match(arm.detail, /It waits for the x86 host image's build to finish, as bb-box builds one at a time\./);
  release();
  await until(() => api.images.size === 1 && api.servers.size === 0);
  await hetzner.maintain(signal());
  await until(() => api.images.size === 2);
  assert.deepEqual([...api.images.values()].map((image) => image.labels["bbbox-arch"]), ["x86", "arm"]);
});

test("after a box Hetzner refuses for room, no build starts for 30 minutes (#1075)", async () => {
  const { api, backend } = hetznerWorld();
  const { started, setup, release, options } = heldBuilder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  await hetzner.maintain(signal());
  await until(() => started.length > 0);
  release();
  await until(() => api.images.size === 1 && api.servers.size === 0);
  api.projectServerLimit = 0;
  await assert.rejects(hetzner.acquire(box(), null, hooks, signal()), /the account is at Hetzner's limit/);
  api.projectServerLimit = 10;
  setup.fingerprint = "fp2";
  api.advanceClock(29 * 60_000);
  await hetzner.maintain(signal());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(buildServers(api).length, 0, "no build while boxes waited for room within 30 minutes");
  assert.match((await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!.detail, /A new one is due, as .*\. It waits until .*, as boxes waited for room at .*, and they come first\./);
  api.advanceClock(2 * 60_000);
  await hetzner.maintain(signal());
  await until(() => api.images.size === 2);
  assert.equal(api.images.size, 2, "the build starts once boxes have not waited for 30 minutes");
});

test("while a build runs after a failure, the doctor names the failure but no time to try again, as that time has passed", async () => {
  const { api, backend } = hetznerWorld();
  const { started, release, options } = heldBuilder();
  const storage = new MemoryStorage();
  const failedAt = api.now - 20 * 60_000;
  await storage.set("host-image-failed-at:x86", { atMs: failedAt, inARow: 1 });
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), storage, "test", options);
  await hetzner.maintain(signal());
  await until(() => started.length > 0);
  const detail = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!.detail;
  assert.match(detail, new RegExp(`A new one is being built\\. The last build failed at ${new Date(failedAt).toISOString()}\\.$`));
  release();
  await until(() => api.images.size === 1 && api.servers.size === 0);
});

test("a build that meets bb-box's reload, as its API handle goes stale, is left for the next run: no failure is kept and none is logged as an error", async () => {
  const { api, backend } = hetznerWorld();
  const storage = new MemoryStorage();
  const errors: string[] = [];
  const remote: RemoteBuild = {
    start: async () => {},
    progress: async () => {
      throw new Error('plugin "bb-box" used a stale API handle — it was reloaded or disabled; re-entry happens via a fresh factory call');
    },
  };
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), storage, "test", { ...options, remoteBuild: remote }, { logError: (what: string) => void errors.push(what) });
  await hetzner.buildHostImage("there is no host image yet", signal());
  assert.equal(await storage.get("host-image-failed-at:x86"), undefined);
  assert.deepEqual(errors, []);
  assert.equal(api.servers.size, 1, "the build server keeps running for the next run");
});

test("a backend bb-box disposes, as a reload does, stops following its build at once: no more calls to the build server, no failure, and the server is left for the next run", async () => {
  const { api, backend } = hetznerWorld();
  const storage = new MemoryStorage();
  let progressCalls = 0;
  const remote: RemoteBuild = {
    start: async () => {},
    progress: async () => {
      progressCalls++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      throw new Error("ssh: connect to host 192.0.2.10 port 22: Connection refused");
    },
  };
  const { options } = builder();
  const lines: string[] = [];
  const errors: string[] = [];
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), storage, "test", { ...options, remoteBuild: remote }, { log: (line: string) => void lines.push(line), logError: (what: string) => void errors.push(what) });
  const building = hetzner.buildHostImage("there is no host image yet");
  await until(() => progressCalls >= 3);
  await hetzner.dispose();
  assert.equal(await building, undefined);
  const callsWhenDisposed = progressCalls;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(progressCalls, callsWhenDisposed, "no call to the build server after dispose");
  assert.equal(api.servers.size, 1, "the build server is left for the next run");
  assert.equal(await storage.get("host-image-failed-at:x86"), undefined);
  assert.deepEqual(errors, []);
  assert.ok(lines.some((line) => /^bb-box stopped while it built the x86 host image on bb-box-hz-\S+, at its building step/.test(line)));
});

test("a box refused room while bb-box's own build is still building takes that room: the build stops, its server goes, the box's host is made, and no failure is kept", async () => {
  const { api, backend } = hetznerWorld();
  const { started, release, options } = heldBuilder();
  const storage = new MemoryStorage();
  const lines: string[] = [];
  const errors: string[] = [];
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), storage, "test", options, { log: (line: string) => void lines.push(line), logError: (what: string) => void errors.push(what) });
  await hetzner.maintain(signal());
  await until(() => started.length > 0);
  const [build] = buildServers(api);
  api.projectServerLimit = 1;
  const guest = await hetzner.acquire(box(), null, hooks, signal());
  release();
  assert.equal(buildServers(api).length, 0, "the build server is gone");
  assert.ok(api.servers.size === 1 && [...api.servers.values()][0]!.name === guest.host, "the box's host has the room");
  assert.ok(lines.includes(`bb-box stopped its host image build on ${build!.name}, a cpx42, and deleted the server, so a cpx42 host for a box gets its room.`));
  await until(() => lines.some((line) => line.startsWith(`bb-box stopped the x86 host image build on ${build!.name}, at its building step, and deleted the server, so a box gets its room.`)));
  assert.equal(await storage.get("host-image-failed-at:x86"), undefined);
  assert.deepEqual(errors, []);
  api.projectServerLimit = 10;
  await hetzner.maintain(signal());
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(buildServers(api).length, 0, "no new build while boxes waited for room within 30 minutes");
});

test("a box refused room while bb-box's own build is taking its snapshot waits for it, says until when, and gets the room once the snapshot is made", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const lines: string[] = [];
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", { ...options, sleep: () => new Promise((resolve) => setTimeout(resolve, 5)) }, { log: (line: string) => void lines.push(line) });
  api.pollsUntilSnapshotMade = 5_000;
  await hetzner.buildHostImage("there is no host image yet", signal());
  const [snapshot] = api.images.values();
  const [build] = buildServers(api);
  assert.equal(snapshot!.status, "creating");
  api.projectServerLimit = 1;
  const acquiring = hetzner.acquire(box(), null, hooks, signal());
  await until(() => lines.some((line) => line.startsWith("A cpx42 host for a box waits for room: bb-box's own host image build on")));
  assert.ok(lines.some((line) => new RegExp(`^A cpx42 host for a box waits for room: bb-box's own host image build on ${build!.name} is taking its snapshot, which ends by about \\S+, and its room then goes to the box\\.$`).test(line)));
  assert.ok(api.servers.has(build!.id), "the build server stays while its snapshot is made");
  snapshot!.status = "available";
  snapshot!.imageSize = 31.5;
  await hetzner.maintain(signal());
  const guest = await acquiring;
  assert.equal(buildServers(api).length, 0);
  assert.ok([...api.servers.values()].some((server) => server.name === guest.host));
});

test("the 30 minutes' hold after boxes waited for room stops new builds only: a build left by an earlier run is carried on", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const storage = new MemoryStorage();
  const runs = new Map<string, number | null>();
  const remote: RemoteBuild = {
    start: async (record) => void runs.set(record.hostId, runs.get(record.hostId) ?? null),
    progress: async (record, fromByte) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      return { exitCode: runs.get(record.hostId) ?? null, log: "", nextByte: fromByte };
    },
  };
  const lines: string[] = [];
  const config = hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 });
  const first = backend(config, storage, "test", { ...options, remoteBuild: remote });
  const building = first.buildHostImage("there is no host image yet");
  await until(() => runs.size > 0);
  await first.dispose();
  await building;
  await storage.set("boxes-refused-for-room-at", api.now);
  const [buildId] = runs.keys();
  runs.set(buildId!, 0);
  const next = backend(config, storage, "test", { ...options, remoteBuild: remote }, { log: (line: string) => void lines.push(line) });
  await next.maintain(signal());
  await until(() => api.images.size === 1);
  assert.equal(api.images.size, 1);
  assert.ok(lines.some((line) => /^bb-box carries on with the x86 host image build on bb-box-hz-\S+, from its building step/.test(line)));
});

test("a box refused room that a snapshotting build holds past the wait is refused, naming bb-box's own build server and when it ends", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder();
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04" }), new MemoryStorage(), "test", options);
  api.pollsUntilSnapshotMade = 5_000;
  await hetzner.buildHostImage("there is no host image yet", signal());
  const [server] = buildServers(api);
  api.projectServerLimit = 1;
  await assert.rejects(hetzner.acquire(box(), null, hooks, signal()), (error: Error) => {
    assert.match(error.message, new RegExp(`bb-box's own host image build holds some of that room: ${server!.name}, a cpx42 of \\d+ vCPUs, since .*, which ends by about .*\\. bb-box starts no other build while boxes wait for room\\.`));
    return true;
  });
  assert.ok(api.servers.has(server!.id), "a server taking its snapshot is never deleted for a box");
});
