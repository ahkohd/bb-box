// BB machines as Docker hosts in the settings (src/plugin/docker-hosts.ts, 042).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DockerInfo } from "../src/backends/docker/cli.ts";
import { DRIVERS } from "../src/backends/index.ts";
import { checkDocument, emptyDocument, type ConfigDocument } from "../src/core/document.ts";
import { DockerHosts, machineHosts, withDockerHost, type MachineRecord } from "../src/plugin/docker-hosts.ts";

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
  name: "behemoth",
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
      machine("host_b", "behemoth"),
      machine("host_box", "calm-tundra", { machineProviderId: "bb-box" }),
      machine("host_new", "thread-box", { machineProviderId: "bb-box-new" }),
      machine("host_eph", "ephemeral", { type: "ephemeral" }),
      machine("host_rm", "leaving", { lifecycle: { phase: "destroying" } }),
      machine("host_gone", "used", { status: "disconnected", lifecycle: { phase: "destroying" } }),
    ],
    document,
    ["bb-box", "bb-box-new"],
  );
  assert.deepEqual(listed.map((each) => each.name), ["behemoth", "used"]);
});

test("each machine shows Docker as it answers through the relay, kept a while, and one that is offline or not Linux says why", async () => {
  let calls = 0;
  let clock = 0;
  const hosts = new DockerHosts({
    machines: async () => [machine("host_b", "behemoth"), machine("host_w", "windows-pc"), machine("host_n", "no-docker"), machine("host_o", "sleepy", { status: "disconnected" })],
    document: () => ({ ...emptyDocument(1), backends: [{ id: "docker:behemoth", type: "docker", enabled: true, fields: { host: "bb:host_b" } }] }),
    providers: ["bb-box"],
    docker: async (hostId) => {
      calls++;
      if (hostId === "host_n") throw new Error("connect: no such file or directory");
      return hostId === "host_w" ? info({ osType: "windows" }) : info();
    },
    boxes: async () => new Map([["docker:behemoth", 2]]),
    now: () => clock,
  });
  const listed = await hosts.list();
  assert.deepEqual(listed.find((each) => each.name === "behemoth"), {
    hostId: "host_b",
    name: "behemoth",
    connected: true,
    docker: { version: "29.8.1", os: "Arch Linux", arch: "x86_64", cpus: 16, memoryMiB: 102400 },
    problem: null,
    backend: { id: "docker:behemoth", enabled: true, boxes: 2 },
  });
  assert.equal(listed.find((each) => each.name === "windows-pc")?.problem, "Docker there runs windows containers. Switch it to Linux containers.");
  assert.equal(listed.find((each) => each.name === "no-docker")?.problem, "Docker did not answer: connect: no such file or directory");
  assert.equal(listed.find((each) => each.name === "sleepy")?.problem, "The machine is offline in BB.");
  assert.equal(calls, 3, "an offline machine is not asked");

  await hosts.list();
  assert.equal(calls, 3, "kept for a minute");
  hosts.forget("host_b");
  await hosts.list();
  assert.equal(calls, 4);
  clock += 60_000;
  await hosts.list();
  assert.equal(calls, 7);
});

test("turning a machine on adds a Docker backend on it, last, named after it; off removes it, or turns it off while it has boxes", () => {
  const start: ConfigDocument = { ...emptyDocument(3), backends: [{ id: "docker", type: "docker", enabled: true, fields: {} }, { id: "docker:behemoth", type: "docker", enabled: true, fields: { host: "ssh://me@other" } }] };
  const on = withDockerHost(start, { id: "host_b", name: "Behemoth PC" }, true, 0);
  const added = on.backends.at(-1)!;
  assert.deepEqual(added, { id: "docker:behemoth-pc", type: "docker", label: "Docker on Behemoth PC", enabled: true, fields: { host: "bb:host_b", privileged: true } });
  assert.deepEqual(checkDocument(on, {}, DRIVERS), [], "a document the configuration takes");
  const clash = withDockerHost(start, { id: "host_x", name: "behemoth" }, true, 0);
  assert.equal(clash.backends.at(-1)!.id, "docker:behemoth-2", "a name another backend has gets a number");
  assert.deepEqual(withDockerHost(on, { id: "host_b", name: "Behemoth PC" }, true, 0), on, "on again changes nothing");

  const off = withDockerHost(on, { id: "host_b", name: "Behemoth PC" }, false, 0);
  assert.deepEqual(off.backends, start.backends);
  const held = withDockerHost(on, { id: "host_b", name: "Behemoth PC" }, false, 2);
  assert.deepEqual(held.backends.at(-1), { ...added, enabled: false }, "with boxes it stays, off, so it takes no new ones");
  assert.deepEqual(withDockerHost(held, { id: "host_b", name: "Behemoth PC" }, true, 2).backends.at(-1), added, "and on again is the same backend");
});
