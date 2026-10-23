import assert from "node:assert/strict";
import { cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { HostRecord } from "../src/backends/hetzner/hosts.ts";
import { HOST_IMAGE_REBUILT_AFTER_MS, PREPARE_FOR_SNAPSHOT, setupFingerprint } from "../src/backends/hetzner/host-image.ts";
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

test("a failed build deletes its server, keeps no snapshot, says so in the doctor, and is not tried again for a day", async () => {
  const { api, backend } = hetznerWorld();
  const { options } = builder({ failOn: "desktop" });
  const hetzner = backend(hetznerConfig({ hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", monthlyLimitEurosBeforeVat: 50 }), new MemoryStorage(), "test", options);
  await assert.rejects(hetzner.buildHostImage("there is no host image yet", signal()), /build\.sh failed on desktop/);
  assert.equal(api.servers.size, 0);
  assert.equal(api.images.size, 0);
  const check = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.image")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /The last build failed at .*; bb-box tries again a day after\./);
  const creates = () => api.calls.filter((call) => call.method === "POST" && call.path === "/servers").length;
  const before = creates();
  await hetzner.maintain(signal());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(creates(), before, "not again within the day");
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
  const restarted = backend(config, storage, "test", { ...options, hostImageFingerprint: () => "fp1" });
  await restarted.hostRecords.sweep(signal());
  assert.equal(api.servers.size, 1, "the hosts' sweep leaves the build server alone");
  api.advanceClock(11 * 60_000);
  await restarted.maintain(signal());
  assert.equal([...api.servers.values()].filter((each) => each.labels["bbbox-role"] === "image-build").length, 1, "a build may run for hours");
  api.advanceClock(3 * 3_600_000);
  await restarted.maintain(signal());
  assert.ok(![...api.servers.values()].some((each) => each.labels["bbbox-role"] === "image-build" && each.status !== "deleting"), "the builds' sweep deleted the one the crash left");
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
