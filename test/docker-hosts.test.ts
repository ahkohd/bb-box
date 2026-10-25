// BB machines as Docker hosts in the settings (src/plugin/docker-hosts.ts, 042).

import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { DockerInfo } from "../src/backends/docker/cli.ts";
import { DRIVERS } from "../src/backends/index.ts";
import { checkDocument, emptyDocument, type ConfigDocument } from "../src/core/document.ts";
import { hostEntry } from "../src/host/entry.ts";
import { DockerHosts, MachineNames, MachinePlatforms, SILENT_MS, desktopsOnDemand, machineHosts, machineOffline, withDesktopImage, withDockerHost, withoutDesktopImage, type MachineRecord } from "../src/plugin/docker-hosts.ts";
import { dockerKind, dockerKinds } from "../src/backends/docker/backend.ts";
import { MemoryStorage } from "./helpers.ts";
import { tempDir } from "./helpers.ts";
import { machinePlatform } from "../src/host/relay.ts";

const machine = (id: string, name: string, more: Partial<MachineRecord> = {}): MachineRecord => ({
  id,
  name,
  status: "connected",
  type: "persistent",
  machineProviderId: null,
  lifecycle: { phase: "active" },
  ...more,
});

const info = (more: Partial<DockerInfo> = {}): DockerInfo => ({
  name: "devpc",
  version: "29.8.1",
  operatingSystem: "Arch Linux",
  osType: "linux", kernelVersion: "",
  arch: "x86_64",
  cpus: 16,
  memoryMiB: 100 * 1024,
  rootless: false,
  cpuLimit: true,
  memoryLimit: true,
  cpuset: true,
  gpus: [],
  ...more,
});

test("the host entry says what machine it runs on: a Windows PC's BB daemon under WSL, a Mac, else Linux", () => {
  assert.deepEqual(
    [machinePlatform("linux", "5.15.167.4-microsoft-standard-WSL2"), machinePlatform("win32", "10.0.22631"), machinePlatform("darwin", "24.6.0"), machinePlatform("linux", "6.8.0-45-generic")],
    ["windows", "windows", "macos", "linux"],
  );
});

test("the list holds persistent machines bb-box did not make, and any the configuration already uses", () => {
  const document: ConfigDocument = { ...emptyDocument(1), backends: [{ id: "docker:gone", type: "docker", enabled: true, fields: { host: "bb:host_gone" } }] };
  const listed = machineHosts(
    [
      machine("host_b", "devpc"),
      machine("host_box", "calm-otter", { machineProviderId: "bb-box" }),
      machine("host_new", "thread-box", { machineProviderId: "bb-box-new" }),
      machine("host_eph", "ephemeral", { type: "ephemeral" }),
      machine("host_rm", "leaving", { lifecycle: { phase: "destroying" } }),
      machine("host_gone", "used", { status: "disconnected", lifecycle: { phase: "destroying" } }),
    ],
    document,
    ["bb-box", "bb-box-new"],
  );
  assert.deepEqual(listed.map((each) => each.name), ["devpc", "used"]);
});

test("each machine shows Docker as it answers through the relay, kept a while, and one that is offline or not Linux says why; looking opens a relay only where Docker is", async () => {
  let calls = 0;
  let asked: string[] = [];
  let clock = 0;
  const hosts = new DockerHosts({
    machines: async () => [machine("host_b", "devpc"), machine("host_w", "windows-pc"), machine("host_n", "no-docker"), machine("host_o", "sleepy", { status: "disconnected" })],
    document: () => ({ ...emptyDocument(1), backends: [{ id: "docker:devpc", type: "docker", enabled: true, fields: { host: "bb:host_b" } }] }),
    providers: ["bb-box"],
    // The host entry's check, with no lease and no relay.
    found: async (hostId) => {
      asked.push(hostId);
      return hostId === "host_n" ? "there is no Docker to reach: /var/run/docker.sock: connect ENOENT /var/run/docker.sock" : null;
    },
    // Through the relay: only where Docker is.
    docker: async (hostId) => {
      calls++;
      assert.notEqual(hostId, "host_n", "no relay where there is no Docker");
      return hostId === "host_w" ? info({ osType: "windows" }) : info();
    },
    boxes: async () => new Map([["docker:devpc", 2]]),
    now: () => clock,
  });
  const listed = await hosts.list();
  assert.deepEqual(listed.find((each) => each.name === "devpc"), {
    hostId: "host_b",
    name: "devpc",
    connected: true,
    docker: { version: "29.8.1", os: "Arch Linux", arch: "x86_64", cpus: 16, memoryMiB: 102400 },
    problem: null,
    absent: false,
    backend: { id: "docker:devpc", enabled: true, boxes: 2 },
    images: null,
  });
  assert.equal(listed.find((each) => each.name === "windows-pc")?.problem, "Docker there runs windows containers. Switch it to Linux containers.");
  // No Docker on a machine is normal: no problem to show, only absent.
  assert.deepEqual([listed.find((each) => each.name === "no-docker")?.problem, listed.find((each) => each.name === "no-docker")?.absent], [null, true]);
  assert.equal(listed.find((each) => each.name === "sleepy")?.problem, "The machine is offline in BB.");
  assert.deepEqual(asked.sort(), ["host_b", "host_n", "host_w"], "a machine BB shows offline is not called at all");
  assert.equal(calls, 2, "the relay only where Docker is");
  asked = [];

  await hosts.list();
  assert.equal(calls, 2, "kept for a minute");
  assert.deepEqual(asked, []);
  hosts.forget("host_b");
  await hosts.list();
  assert.equal(calls, 3);
  clock += 60_000;
  await hosts.list();
  assert.equal(calls, 5);
});

test("a machine BB shows connected but has not heard from for a minute is offline, saying why, and is not called", async () => {
  // A PC that restarted with nobody signed in said nothing as it went, and BB showed it connected until it was back (#233).
  const now = 60 * 60_000;
  assert.equal(machineOffline({ status: "connected", lastSeenAt: now - 5_000 }, now), null);
  assert.equal(machineOffline({ status: "connected", lastSeenAt: now - SILENT_MS }, now), null);
  assert.equal(machineOffline({ status: "connected", lastSeenAt: null }, now), null, "never heard from is BB's to judge");
  assert.equal(machineOffline({ status: "disconnected", lastSeenAt: now }, now), "is offline in BB.");
  assert.equal(machineOffline({ status: "connected", lastSeenAt: now - SILENT_MS - 1_000 }, now), "is offline: BB has not heard from it for 1 minute.");

  const asked: string[] = [];
  const hosts = new DockerHosts({
    machines: async () => [machine("host_r", "restarted", { lastSeenAt: now - 15 * 60_000 }), machine("host_b", "devpc", { lastSeenAt: now - 3_000 })],
    document: () => emptyDocument(1),
    providers: ["bb-box"],
    found: async (hostId) => (asked.push(hostId), null),
    docker: async () => info(),
    boxes: async () => new Map(),
    now: () => now,
  });
  const listed = await hosts.list();
  assert.deepEqual(
    listed.map((each) => [each.name, each.connected, each.problem]),
    [
      ["restarted", false, "The machine is offline: BB has not heard from it for 15 minutes."],
      ["devpc", true, null],
    ],
  );
  assert.deepEqual(asked, ["host_b"]);
});

test("turning a machine on adds a Docker backend on it, last, named after it; off removes it, or turns it off while it has boxes", () => {
  const start: ConfigDocument = { ...emptyDocument(3), backends: [{ id: "docker", type: "docker", enabled: true, fields: {} }, { id: "docker:devpc", type: "docker", enabled: true, fields: { host: "ssh://me@other" } }] };
  const on = withDockerHost(start, { id: "host_b", name: "Dev PC" }, true, 0);
  const added = on.backends.at(-1)!;
  assert.deepEqual(added, { id: "docker:dev-pc", type: "docker", label: "Docker on Dev PC", enabled: true, fields: { host: "bb:host_b", privileged: true } });
  assert.deepEqual(checkDocument(on, {}, DRIVERS), [], "a document the configuration takes");
  const clash = withDockerHost(start, { id: "host_x", name: "devpc" }, true, 0);
  assert.equal(clash.backends.at(-1)!.id, "docker:devpc-2", "a name another backend has gets a number");
  assert.deepEqual(withDockerHost(on, { id: "host_b", name: "Dev PC" }, true, 0), on, "on again changes nothing");

  const off = withDockerHost(on, { id: "host_b", name: "Dev PC" }, false, 0);
  assert.deepEqual(off.backends, start.backends);
  const held = withDockerHost(on, { id: "host_b", name: "Dev PC" }, false, 2);
  assert.deepEqual(held.backends.at(-1), { ...added, enabled: false }, "with boxes it stays, off, so it takes no new ones");
  assert.deepEqual(withDockerHost(held, { id: "host_b", name: "Dev PC" }, true, 2).backends.at(-1), added, "and on again is the same backend");
});

/** The host entry's docker answer without its setup facts, which vary by machine. */
function answer<T extends { setup?: unknown }>(full: T): Omit<T, "setup"> {
  const { setup: _, ...rest } = full;
  return rest;
}

test("the host entry's docker check finds Docker or says why, with no lease, and starts nothing (042)", async (t) => {
  const dir = tempDir("docker-check");
  const socket = join(dir, "docker.sock");
  const present = experimental_createHostEntryHarness(hostEntry({ relay: { endpoint: async () => ({ path: socket }) } }));
  t.after(() => present.experimental_dispose());
  assert.deepEqual(answer(await present.experimental_call("docker", {})), { endpoint: socket, found: false, reason: `${socket}: connect ENOENT ${socket}`, platform: machinePlatform() });
  const server = createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  t.after(() => server.close());
  const found = await present.experimental_call("docker", {});
  assert.deepEqual(answer(found), { endpoint: socket, found: true, reason: null, platform: machinePlatform() });
  // With it, what first-run setup needs: who BB's daemon runs as, and whether it has the socket's group.
  assert.equal(found.setup?.user, userInfo().username);
  assert.equal(found.setup?.inSocketGroup, process.platform === "linux" ? true : found.setup?.inSocketGroup);
  assert.ok(["ok", "denied", "absent"].includes(found.setup!.kvm));
  assert.equal(present.experimental_getRetainedWorkerLeaseCount(), 0, "the worker is left to its idle timer");
  const unset = experimental_createHostEntryHarness(hostEntry({ relay: { endpoint: async () => Promise.reject(new Error("DOCKER_HOST is ssh://me@x, which the relay cannot reach")) } }));
  t.after(() => unset.experimental_dispose());
  assert.deepEqual(answer(await unset.experimental_call("docker", {})), { endpoint: "", found: false, reason: "DOCKER_HOST is ssh://me@x, which the relay cannot reach", platform: machinePlatform() });
});

test("a Docker socket that refuses BB's daemon is Docker to fix, and the host entry's check says how (042)", { skip: process.platform !== "linux" || process.getuid?.() === 0 ? "needs Linux and a user other than root" : false }, async (t) => {
  const socket = join(tempDir("docker-refused"), "docker.sock");
  const server = createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  t.after(() => server.close());
  // As a socket of root:docker 660 is to a user outside the docker group.
  chmodSync(socket, 0o000);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { endpoint: async () => ({ path: socket }) } }));
  t.after(() => worker.experimental_dispose());
  const { username, uid } = userInfo();
  assert.deepEqual(answer(await worker.experimental_call("docker", {})), {
    endpoint: socket,
    found: false,
    reason: `${username} may not use Docker's socket ${socket}. Add ${username} to its group, usually docker, then restart ${username}'s services so BB's daemon has the group: sudo systemctl restart user@${uid}.service.`,
    refused: true, platform: machinePlatform()
  });
});

test("a BB machine's OS is kept in storage at the host entry's answer, so a restart knows it before the entry has answered again", async () => {
  const kv = new MemoryStorage();
  const platforms = new MachinePlatforms(kv);
  await platforms.load();
  assert.equal(platforms.get("host_m1"), null, "unknown until the host entry answers");
  assert.equal(await platforms.learn("host_m1", "windows"), true, "news, so panels are told");
  assert.equal(await platforms.learn("host_m1", "windows"), false, "the same again is not");
  assert.equal(platforms.get("host_m1"), "windows");
  // After a restart the kept OS stands until the host entry answers again, and its word wins when it changes.
  const restarted = new MachinePlatforms(kv);
  await restarted.load();
  assert.equal(restarted.get("host_m1"), "windows");
  assert.equal(await restarted.learn("host_m1", "linux"), true);
  assert.equal(restarted.get("host_m1"), "linux");
  assert.equal(restarted.get("host_m2"), null);
});

test("a BB machine's name is kept in storage as BB gives it, so a restart names its providers before bb-box reaches it again (#916)", async () => {
  const kv = new MemoryStorage();
  const names = new MachineNames(kv);
  await names.load();
  assert.equal(names.get("host_m1"), null, "unknown until BB gives it");
  await names.learn("host_m1", "devpc");
  assert.equal(names.get("host_m1"), "devpc");
  const restarted = new MachineNames(kv);
  await restarted.load();
  assert.equal(restarted.get("host_m1"), "devpc", "known at once after a restart");
  await restarted.learn("host_m1", "devpc-2");
  assert.equal(restarted.get("host_m1"), "devpc-2", "a new name from BB wins");
  await restarted.learn("host_m1", "");
  assert.equal(restarted.get("host_m1"), "devpc-2", "an empty name is no name");
});

test("the X11 and the Wayland desktop build on demand where first-run setup left Docker's desktop images off, each until its own image is set again", () => {
  const document = emptyDocument();
  const linuxOnly = withDockerHost(document, { id: "host_a", name: "devpc" }, true, 0, true);
  const [backend] = linuxOnly.backends;
  const x11 = { hostId: "host_a", backend: backend!.id, kind: "linux-desktop-cpu" };
  const wayland = { hostId: "host_a", backend: backend!.id, kind: "linux-desktop-wayland-cpu" };
  assert.deepEqual(desktopsOnDemand(linuxOnly), [x11, wayland]);
  assert.deepEqual(desktopsOnDemand(withDockerHost(document, { id: "host_a", name: "devpc" }, true, 0)), []);
  assert.deepEqual(desktopsOnDemand({ ...linuxOnly, kinds: { "linux-desktop-cpu": { enabled: false } } } as ConfigDocument), [wayland]);
  assert.deepEqual(desktopsOnDemand(withDockerHost(linuxOnly, { id: "host_a", name: "devpc" }, false, 1)), []);
  const set = withDesktopImage(linuxOnly, backend!.id);
  assert.equal("desktop-image" in set.backends[0]!.fields, false);
  assert.equal(set.backends[0]!.fields["wayland-desktop-image"], "");
  assert.deepEqual(desktopsOnDemand(set), [wayland]);
  assert.deepEqual(checkDocument(set, {}, DRIVERS), []);
  const both = withDesktopImage(set, backend!.id, "linux-desktop-wayland-cpu");
  assert.equal("wayland-desktop-image" in both.backends[0]!.fields, false);
  assert.deepEqual(desktopsOnDemand(both), []);
  assert.deepEqual(checkDocument(both, {}, DRIVERS), []);
  assert.deepEqual(desktopsOnDemand(withoutDesktopImage(both, backend!.id, "linux-desktop-wayland-cpu")), [wayland]);
});

test("the desktop built on demand is the kind the Docker backend offers once its image is set", () => {
  const offered = dockerKinds({ images: { linux: "a", "linux-desktop-cpu": "b", "linux-desktop": null, "linux-desktop-wayland-cpu": null }, docker: true } as never).find((kind) => kind.id === "linux-desktop-cpu");
  assert.deepEqual(dockerKind("linux-desktop-cpu", true), offered);
  assert.deepEqual(dockerKind("linux-desktop-cpu", false).capabilities.features, []);
});

test("first-run setup turns on the nightly rebuilds unless they were set, and turning a machine on by hand leaves them alone", () => {
  assert.equal(withDockerHost(emptyDocument(), { id: "host_a", name: "devpc" }, true, 0, true).general.nightlyImages, true);
  const off: ConfigDocument = { ...emptyDocument(), general: { nightlyImages: false } };
  assert.equal(withDockerHost(off, { id: "host_a", name: "devpc" }, true, 0, true).general.nightlyImages, false);
  assert.equal(withDockerHost(emptyDocument(), { id: "host_a", name: "devpc" }, true, 0).general.nightlyImages, undefined);
});
