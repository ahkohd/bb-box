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
import { DockerHosts, SILENT_MS, machineHosts, machineOffline, withDockerHost, type MachineRecord } from "../src/plugin/docker-hosts.ts";
import { tempDir } from "./helpers.ts";

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
  osType: "linux",
  arch: "x86_64",
  cpus: 16,
  memoryMiB: 100 * 1024,
  rootless: false,
  gpus: [],
  ...more,
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

test("the host entry's docker check finds Docker or says why, with no lease, and starts nothing (042)", async (t) => {
  const dir = tempDir("docker-check");
  const socket = join(dir, "docker.sock");
  const present = experimental_createHostEntryHarness(hostEntry({ relay: { endpoint: async () => ({ path: socket }) } }));
  t.after(() => present.experimental_dispose());
  assert.deepEqual(await present.experimental_call("docker", {}), { endpoint: socket, found: false, reason: `${socket}: connect ENOENT ${socket}` });
  const server = createServer((connection) => connection.end());
  await new Promise<void>((resolve) => server.listen(socket, () => resolve()));
  t.after(() => server.close());
  assert.deepEqual(await present.experimental_call("docker", {}), { endpoint: socket, found: true, reason: null });
  assert.equal(present.experimental_getRetainedWorkerLeaseCount(), 0, "the worker is left to its idle timer");
  const unset = experimental_createHostEntryHarness(hostEntry({ relay: { endpoint: async () => Promise.reject(new Error("DOCKER_HOST is ssh://me@x, which the relay cannot reach")) } }));
  t.after(() => unset.experimental_dispose());
  assert.deepEqual(await unset.experimental_call("docker", {}), { endpoint: "", found: false, reason: "DOCKER_HOST is ssh://me@x, which the relay cannot reach" });
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
  assert.deepEqual(await worker.experimental_call("docker", {}), {
    endpoint: socket,
    found: false,
    reason: `${username} may not use Docker's socket ${socket}. Add ${username} to its group, usually docker, then restart ${username}'s services so BB's daemon has the group: sudo systemctl restart user@${uid}.service.`,
    refused: true,
  });
});
