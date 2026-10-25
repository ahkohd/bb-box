import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { armImageOf } from "../src/backends/hetzner/backend.ts";
import { parseHetznerPart } from "../src/backends/hetzner/config.ts";
import type { HostRecord } from "../src/backends/hetzner/hosts.ts";
import type { AcquireHooks, BoxIdentity, BoxSize, ReleaseHooks } from "../src/backends/types.ts";
import { MemoryStorage } from "./helpers.ts";
import { hetznerConfig, hetznerWorld } from "./fake-hetzner-world.ts";

const signal = () => AbortSignal.timeout(30_000);
const box4: BoxSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function hooks() {
  const timings: Record<string, number> = {};
  const value: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: (step, ms) => void (timings[step] = ms) };
  return { value, timings };
}

let counter = 0;
const identity = (kind: string): BoxIdentity => ({ boxId: `bxarm${String(++counter).padStart(9, "0")}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: box4 });

function armWorld(extra: Parameters<typeof hetznerConfig>[0] = {}) {
  const world = hetznerWorld();
  const built: { host: string; image: string; target: string; architecture: string }[] = [];
  const addImage = (record: HostRecord, image: string) => {
    const host = world.dockerHosts.get(record.hostId)!;
    const path = join(host.root, "images.json");
    const images = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...images, [image]: images[image.replace(/-arm64$/, "")] }));
  };
  const options = {
    buildImage: async (record: HostRecord, _cli: unknown, image: string, target: string, _log: unknown, _signal: unknown, architecture: string) => {
      built.push({ host: record.serverType, image, target, architecture });
      if (world.dockerHosts.has(record.hostId)) addImage(record, image);
    },
    runOnHost: async () => ({ exitCode: 0, stderr: "" }),
    hostImageFingerprint: () => "fp1",
  };
  const config = hetznerConfig({ armServerType: "cax31", hostImage: "ubuntu-26.04", hostImageLabel: "ubuntu-26.04", ...extra });
  return { ...world, built, options, config, backend: () => world.backend(config, new MemoryStorage(), "test", options) };
}

test("with an Arm server type set, the backend also offers linux-arm64 and its desktop, and without one it offers no arm64 box", () => {
  const { backend } = armWorld();
  const kinds = backend().kinds();
  assert.deepEqual(kinds.map((kind) => [kind.id, kind.capabilities.arch]), [
    ["linux", "x86_64"],
    ["linux-desktop-cpu", "x86_64"],
    ["linux-desktop-wayland-cpu", "x86_64"],
    ["linux-arm64", "arm64"],
    ["linux-arm64-desktop-cpu", "arm64"],
  ]);
  assert.equal(kinds.find((kind) => kind.id === "linux-arm64")!.label, "Linux on arm64");
  const plain = hetznerWorld().backend();
  assert.equal(plain.kinds().some((kind) => kind.capabilities.arch === "arm64"), false);
  assert.equal(armImageOf("bbbox/linux:1"), "bbbox/linux:1-arm64");
});

test("a linux-arm64 box makes an Arm host, builds the arm64 image there, and comes back as linux-arm64; an x86 box never goes on it", async () => {
  const { api, built, backend } = armWorld();
  const hetzner = backend();
  const offer = await hetzner.capacity("linux-arm64", box4, [], signal());
  assert.deepEqual(offer.hosts.map((host) => host.host), ["a new cax31 host"]);
  const { value, timings } = hooks();
  const arm = await hetzner.acquire(identity("linux-arm64"), null, value, signal());
  const armServer = [...api.servers.values()].find((server) => server.name === arm.host)!;
  assert.equal(armServer.serverType, "cax31");
  assert.deepEqual(built, [{ host: "cax31", image: "bbbox/linux:1-arm64", target: "linux", architecture: "arm" }]);
  assert.ok(timings["build image"] !== undefined);
  const held = await hetzner.held(signal());
  assert.equal(held.find((each) => each.ref === arm.ref)!.owner!.kind, "linux-arm64", "the box's kind as it asked, not the Docker kind it runs as");
  const x86 = await hetzner.acquire(identity("linux"), null, hooks().value, signal());
  assert.notEqual(x86.host, arm.host);
  assert.equal([...api.servers.values()].find((server) => server.name === x86.host)!.serverType, "cpx42");
  const { command } = await hetzner.transports(arm, "linux-arm64");
  assert.equal((await command!.run("echo arm", { timeoutMs: 10_000 })).stdout.trim(), "arm");
  await hetzner.release(arm, releasing, signal());
  await hetzner.release(x86, releasing, signal());
});

test("at the most hosts, a host of the other architecture that holds no box makes way, and one that holds a box does not (#1032)", async () => {
  const { api, backend } = armWorld({ mostHosts: 1 });
  const hetzner = backend();
  const types = () => [...api.servers.values()].map((server) => server.serverType);
  // An x86 box, then its release: its host stays, idle, until it has been for idleMinutes.
  const x86 = await hetzner.acquire(identity("linux"), null, hooks().value, signal());
  const offer = await hetzner.capacity("linux-arm64", box4, [], signal());
  assert.equal(offer.ok, false, "a host that holds a box does not make way");
  assert.match(offer.message!, /has the 1 host it may have at once/);
  await hetzner.release(x86, releasing, signal());
  assert.deepEqual(types(), ["cpx42"]);
  // Before, the arm64 box was refused until the idle host was deleted, half an hour later.
  assert.equal((await hetzner.capacity("linux-arm64", box4, [], signal())).ok, true);
  const arm = await hetzner.acquire(identity("linux-arm64"), null, hooks().value, signal());
  assert.deepEqual(types(), ["cax31"], "the idle x86 host went, and an Arm host took the box");
  assert.equal([...api.servers.values()][0]!.name, arm.host);
  await hetzner.release(arm, releasing, signal());
});

test("each architecture has its own host image: an Arm build on an Arm server with the arm64 images, labelled arm, which only Arm hosts start from", async () => {
  const { api, built, backend } = armWorld();
  const hetzner = backend();
  await hetzner.buildHostImage("there is no host image yet", signal(), "arm");
  assert.deepEqual(built.map((each) => [each.host, each.image, each.target, each.architecture]), [
    ["cax31", "bbbox/linux:1-arm64", "linux", "arm"],
    ["cax31", "bbbox/linux-desktop:1-arm64", "desktop", "arm"],
  ]);
  const [snapshot] = api.images.values();
  assert.equal(snapshot!.labels["bbbox-arch"], "arm");
  const report = await hetzner.doctor(signal());
  assert.match(report.checks.find((each) => each.id === "hetzner.arm-image")!.detail, new RegExp(`^Arm hosts start from snapshot ${snapshot!.id}`));
  assert.match(report.checks.find((each) => each.id === "hetzner.image")!.detail, /^None yet: x86 hosts start from ubuntu-26\.04/);
  assert.match(report.checks.find((each) => each.id === "hetzner.arm-type")!.detail, /^8 cores, 16 GB memory, 160 GB disk in nbg1, EUR 0\.03 an hour/);
  const arm = await hetzner.acquire(identity("linux-arm64"), null, hooks().value, signal());
  assert.equal([...api.servers.values()].find((server) => server.name === arm.host)!.image, snapshot!.id);
  const x86 = await hetzner.acquire(identity("linux"), null, hooks().value, signal());
  assert.notEqual([...api.servers.values()].find((server) => server.name === x86.host)!.image, snapshot!.id, "an x86 host never starts from an Arm snapshot");
});

test("maintain builds a host image for each architecture that has none, one after the other", async () => {
  const { api, backend } = armWorld();
  const hetzner = backend();
  await hetzner.maintain(signal());
  for (let i = 0; i < 400 && (api.images.size < 1 || api.servers.size > 0); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([...api.images.values()].map((each) => each.labels["bbbox-arch"]), ["x86"]);
  await hetzner.maintain(signal());
  for (let i = 0; i < 400 && api.images.size < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual([...api.images.values()].map((each) => each.labels["bbbox-arch"]), ["x86", "arm"]);
});

test("the month's spend counts each host at its own type's price", async () => {
  const { backend } = armWorld();
  const hetzner = backend();
  await hetzner.acquire(identity("linux-arm64"), null, hooks().value, signal());
  const spend = (await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.spend")!.detail;
  assert.match(spend, /^EUR 0\.03 before VAT so far this month/, "a cax31's hour, not a cpx42's");
  assert.match((await hetzner.doctor(signal())).checks.find((each) => each.id === "hetzner.hosts")!.detail, /\(cax31\): ready/);
});

test("the settings take an Arm server type, and refuse an x86 type there or an Arm type for the x86 hosts", () => {
  const token = "a".repeat(64);
  const ok = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token, "arm-server-type": "cax31" } });
  assert.ok(ok.ok);
  assert.equal(ok.config.armServerType, "cax31");
  const none = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token } });
  assert.ok(none.ok);
  assert.equal(none.config.armServerType, null);
  const wrong = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token, "arm-server-type": "cpx42", "server-type": "cax31" } });
  assert.ok(!wrong.ok);
  assert.deepEqual(wrong.problems.map((each) => each.path).sort(), ["arm-server-type", "server-type"]);
});
