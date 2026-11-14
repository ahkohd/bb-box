import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import type { AcquireHooks, BoxIdentity, MachineSize, ReleaseHooks } from "../src/backends/types.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const hooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

let counter = 0;
function identity(): BoxIdentity {
  counter++;
  return { boxId: `bxpart${String(counter).padStart(8, "0")}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind: "linux", createdAt: 1_790_000_000_000, size: { ...SMALL, gpu: "none" } };
}

function part(name: string) {
  const fake = fakeDockerHost({ name });
  const prepared: string[] = [];
  const socket = `unix:///run/bb-box/hosts/${name}.sock`;
  const cli = new DockerCli(socket, fake.binary, async () => {
    prepared.push(name);
  });
  const storage = new MemoryStorage();
  const backend = new DockerBackend(dockerConfig({ host: socket }), testContext(storage, "test", { id: `hetzner.${name}` }), { cliReachingAHostAnotherBackendMade: cli, readyTimeoutMs: 2_000 });
  return { fake, backend, prepared, storage };
}

test("a Docker backend given its CLI does all its host's work through it, preparing before each call that reaches the daemon", async () => {
  const { fake, backend, prepared } = part("cloud-h1");
  const capacity = await backend.capacity("linux", SMALL, [], signal());
  assert.equal(capacity.ok, true);
  assert.equal(capacity.hosts[0]!.host, "cloud-h1");
  const box = identity();
  const guest = await backend.acquire(box, null, hooks, signal());
  assert.equal(guest.host, "cloud-h1");
  assert.deepEqual(fake.containers(), [guest.ref]);
  const { command } = await backend.transports(guest, "linux");
  assert.equal((await command!.run("echo part", { timeoutMs: 10_000 })).stdout.trim(), "part");
  assert.deepEqual((await backend.held(signal())).map((held) => held.ref), [guest.ref]);
  await backend.release(guest, releasing, signal());
  assert.deepEqual(fake.containers(), []);
  assert.ok(prepared.length >= fake.calls().filter((call) => call[0] !== "--version").length, "every call to the daemon was prepared first");
  assert.equal(backend.label, "Docker on cloud-h1");
});

test("two Docker backends, each with its own host's CLI and storage, keep their boxes and names apart", async () => {
  const one = part("cloud-h2");
  const two = part("cloud-h3");
  const a = await one.backend.acquire(identity(), null, hooks, signal());
  const b = await two.backend.acquire(identity(), null, hooks, signal());
  assert.deepEqual(one.fake.containers(), [a.ref]);
  assert.deepEqual(two.fake.containers(), [b.ref]);
  assert.deepEqual((await one.backend.held(signal())).map((held) => [held.ref, held.host]), [[a.ref, "cloud-h2"]]);
  assert.deepEqual((await two.backend.held(signal())).map((held) => [held.ref, held.host]), [[b.ref, "cloud-h3"]]);
  assert.equal(await one.storage.get("host-name"), "cloud-h2");
  assert.equal(await two.storage.get("host-name"), "cloud-h3");
  await one.backend.release(a, releasing, signal());
  await two.backend.release(b, releasing, signal());
});

test("a host its CLI cannot prepare is one that did not answer, with the reason, and nothing reaches its daemon", async () => {
  const fake = fakeDockerHost({ name: "cloud-h4" });
  const cli = new DockerCli("unix:///run/bb-box/hosts/cloud-h4.sock", fake.binary, async () => {
    throw new Error("the SSH forward to cloud-h4 is not up");
  });
  const backend = new DockerBackend(dockerConfig({ host: "unix:///run/bb-box/hosts/cloud-h4.sock" }), testContext(new MemoryStorage()), { cliReachingAHostAnotherBackendMade: cli, readyTimeoutMs: 2_000 });
  const capacity = await backend.capacity("linux", SMALL, [], signal());
  assert.equal(capacity.ok, false);
  assert.match(capacity.message ?? "", /did not answer: the SSH forward to cloud-h4 is not up/);
  assert.deepEqual(fake.calls(), []);
});
