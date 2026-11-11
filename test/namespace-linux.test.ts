import assert from "node:assert/strict";
import { test } from "node:test";
import { NamespaceBackend } from "../src/backends/namespace/backend.ts";
import { CONTAINER_MEMORY_MARGIN_MIB, linuxShapeFor, pullScript } from "../src/backends/namespace/linux.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { fakeDockerHost } from "./fake-docker.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace } from "./fake-namespace.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG = { token: FAKE_NAMESPACE_TOKEN, region: "us" as const, macosVersion: "26.x", machines: 2, longestLifeHours: 4, largestMachine: null };

function setup() {
  fakeSsh();
  const fake = new FakeNamespace({ lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const pulls: string[] = [];
  const hosts = new Map<string, DockerCli>();
  const backend = new NamespaceBackend(CONFIG, testContext(new MemoryStorage(), "inst1", { id: "namespace" }), {
    fetch: fake.fetch,
    sshBinary: FAKE_SSH_BINARY,
    sleep: async () => {},
    readyTimeoutMs: 20_000,
    setupArchive: async () => Buffer.from("setup"),
    linuxImageScript: (target, key) => `cat >/dev/null; echo nscr.io/ws/bbbox/${target}:${key}`,
    linuxPullScript: (ref, local) => (pulls.push(`${ref} as ${local}`), ":"),
    dockerCli: (instance) => {
      let cli = hosts.get(instance);
      if (!cli) hosts.set(instance, (cli = new DockerCli(`unix:///run/bb-box/namespace/${instance}.sock`, fakeDockerHost({ name: instance, cpus: 2, memoryMiB: 4096 }).binary, async () => {})));
      return cli;
    },
    dockerOptions: { readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh" },
  });
  return { fake, backend: disposed(backend), pulls };
}

const box = (id: string, kind = "linux") => ({ boxId: id, threadId: "thr_1", name: `box-${id}`, kind, createdAt: Date.now(), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "none" as const } });
const hooks = () => {
  const steps: string[] = [];
  return { steps, hooks: { claim: async () => {}, starting: async () => {}, timing: (step: string) => void steps.push(step) } };
};

test("a Linux box takes the smallest of Namespace's Linux shapes with at least its cores and memory, and a box larger than any is refused up front", async () => {
  assert.deepEqual(linuxShapeFor({ cores: 2, memoryMiB: 4096, diskGiB: null }), { cores: 2, memoryGB: 4 });
  assert.deepEqual(linuxShapeFor({ cores: 3, memoryMiB: 6144, diskGiB: null }), { cores: 4, memoryGB: 8 });
  assert.deepEqual(linuxShapeFor({ cores: 6, memoryMiB: 12 * 1024, diskGiB: null }), { cores: 8, memoryGB: 16 });
  assert.equal(linuxShapeFor({ cores: 64, memoryMiB: 4096, diskGiB: null }), null);
  const { backend } = setup();
  const refused = await backend.capacity("linux", { cores: 2, memoryMiB: 64 * 1024, diskGiB: null }, []);
  assert.equal(refused.ok, false);
  assert.match(refused.message!, /^Namespace's Linux machines have at most 32 cores and 56 GB of memory/);
});

test("a Linux box is a Linux machine of its own with the kind's image pulled from the registry and a container from it; its guest names the container and the machine, and release destroys the machine", async () => {
  const { fake, backend, pulls } = setup();
  const recorded = hooks();
  const guest = await backend.acquire(box("b1"), null, recorded.hooks, new AbortController().signal);
  const machine = [...fake.instances.values()].find((instance) => instance.labels["bbbox-box"] === "b1")!;
  assert.equal(machine.shape.os, "linux");
  assert.deepEqual([machine.shape.virtualCpu, machine.shape.memoryMegabytes], [2, 4096]);
  assert.equal(guest.ref, "bbbox-b1");
  assert.equal(guest.data?.instance, machine.id);
  assert.deepEqual(guest.size, { cores: 2, memoryMiB: 4096, diskGiB: null }, "the machine's size, though the container keeps a margin");
  assert.ok(guest.endsAt, "it ends at the plan's longest life, as a Mac does");
  assert.deepEqual(pulls, [`nscr.io/ws/bbbox/linux:${(await backend.linuxImages.record("linux"))!.key} as bbbox/linux:1`]);
  assert.deepEqual(recorded.steps.slice(0, 6), ["create", "ready", "ssh", "image", "pull", "place"]);
  assert.ok(CONTAINER_MEMORY_MARGIN_MIB > 0);
  const { command } = await backend.transports(guest, "linux");
  assert.equal((await command!.run("echo hello", { timeoutMs: 20_000 })).stdout.trim(), "hello");
  const held = await backend.held();
  assert.deepEqual(held.map((each) => [each.ref, each.owner?.boxId]), [["bbbox-b1", "b1"]], "the sweep finds the box's guest by the container's name");
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(machine.status, "DESTROYED");
});

test("the pull script lets every user on the machine use /dev/kvm, as the machine is the box's alone, pulls the registry's image and tags it with the name the Docker backend runs", () => {
  assert.equal(pullScript("nscr.io/ws/bbbox/linux:abc", "bbbox/linux:1"), "set -eu\n[ ! -e /dev/kvm ] || chmod 0666 /dev/kvm\ndocker pull -q 'nscr.io/ws/bbbox/linux:abc' >/dev/null\ndocker tag 'nscr.io/ws/bbbox/linux:abc' 'bbbox/linux:1'");
});

test("Namespace's linux boxes offer kvm, as each is a privileged container on a machine of its own with /dev/kvm, so linux-kvm can be asked of Namespace", () => {
  const { backend } = setup();
  const features = Object.fromEntries(backend.kinds().map((kind) => [kind.id, kind.capabilities.features]));
  assert.ok(features.linux!.includes("kvm"));
  assert.ok(features.linux!.includes("docker"));
  assert.ok(!features["linux-desktop-cpu"]!.includes("kvm"), "linux-kvm asks only for linux");
  assert.ok(!features.macos!.includes("kvm"));
});
