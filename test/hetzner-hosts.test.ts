import assert from "node:assert/strict";
import { test } from "node:test";
import { Hetzner } from "../src/backends/hetzner/api.ts";
import { HetznerHosts, LABEL, UNCLAIMED_SERVER_GRACE_MS, serverNameFor, type HostSpec } from "../src/backends/hetzner/hosts.ts";
import { FAKE_HETZNER_TOKEN, FakeHetzner, respond, type FakeHetznerCall, type Interception } from "./fake-hetzner.ts";
import { MemoryStorage } from "./helpers.ts";

const SPEC: HostSpec = { serverType: "cpx42", location: "nbg1", imageNameOrSnapshotId: "ubuntu-24.04", imageLabel: "b1" };
const PAST_GRACE = UNCLAIMED_SERVER_GRACE_MS + 60_000;

function world() {
  const api = new FakeHetzner();
  const storage = new MemoryStorage();
  const process = () =>
    new HetznerHosts({
      api: new Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: api.fetch, sleep: async () => {}, requestTimeoutMs: 3_600_000 }),
      storage,
      installId: "inst1",
      now: () => api.now,
    });
  return { api, storage, process };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 10_000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), "the step was reached");
}

function once(api: FakeHetzner, matches: (call: FakeHetznerCall) => boolean, what: Interception): () => boolean {
  let hit = false;
  api.intercept = (call) => {
    if (hit || !matches(call)) return undefined;
    hit = true;
    return what;
  };
  return () => hit;
}

const isCreate = (call: FakeHetznerCall) => call.method === "POST" && call.path === "/servers";
const isActionPoll = (call: FakeHetznerCall) => call.method === "GET" && call.path.startsWith("/actions/");
const isServerPoll = (call: FakeHetznerCall) => call.method === "GET" && /^\/servers\/\d+$/.test(call.path);
const isDelete = (call: FakeHetznerCall) => call.method === "DELETE" && call.path.startsWith("/servers/");

test("a host is claimed in storage before its server is asked for, named for the install, labelled, and ready once it runs", async () => {
  const { api, storage, process } = world();
  const hosts = process();
  let claimedBeforeCreate = false;
  api.intercept = (call) => {
    if (isCreate(call)) claimedBeforeCreate = [...storage.values.values()].some((each) => (each as { state?: string }).state === "creating");
    return undefined;
  };
  const host = await hosts.create(SPEC);
  assert.equal(claimedBeforeCreate, true);
  assert.equal(host.state, "ready");
  assert.equal(host.serverName, serverNameFor("inst1", host.hostId));
  assert.match(host.serverName, /^bb-box-inst1-[a-z0-9]{8}$/);
  const [server] = api.servers.values();
  assert.equal(server!.status, "running");
  assert.deepEqual(server!.labels, { [LABEL.install]: "inst1", [LABEL.host]: host.hostId, [LABEL.role]: "host", [LABEL.image]: "b1" });
  assert.equal(host.serverId, server!.id);
  assert.equal(host.ipv4, server!.ipv4);
  assert.deepEqual(await hosts.records(), [host]);
});

test("a create whose answer is lost after Hetzner made the server goes on with the server it made, and makes no second", async () => {
  const { api, process } = world();
  once(api, isCreate, "lose");
  const host = await process().create(SPEC);
  assert.equal(host.state, "ready");
  assert.equal(api.servers.size, 1);
  assert.equal([...api.servers.values()][0]!.id, host.serverId);
});

test("a create Hetzner refuses leaves no record and no server", async () => {
  const { api, storage, process } = world();
  api.projectServerLimit = 0;
  const error = await process().create(SPEC).catch((e) => e);
  assert.equal(error.overLimit, true);
  assert.equal(api.servers.size, 0);
  assert.equal(storage.values.size, 0);
});

test("a server that fails to start is deleted, and its record with it", async () => {
  const { api, storage, process } = world();
  const hosts = process();
  api.intercept = (call) => {
    if (isActionPoll(call)) {
      const id = Number(call.path.split("/")[2]);
      if (api.actions.get(id)?.command === "create_server") api.failActionOnNextPoll(id, "server_error", "no capacity on the hypervisor");
    }
    return undefined;
  };
  const error = await hosts.create(SPEC).catch((e) => e);
  assert.match(error.message, /no capacity on the hypervisor/);
  api.intercept = undefined;
  assert.equal(api.servers.size, 0);
  assert.equal(storage.values.size, 0);
});

for (const [step, matches, what] of [
  ["before the create reaches Hetzner", isCreate, "hang"],
  ["after Hetzner made the server, before its answer", isCreate, "hang after acting"],
  ["while the create's action is polled", isActionPoll, "hang"],
  ["while the server is polled until it runs", isServerPoll, "hang"],
] as const) {
  test(`a crash ${step} leaves no server once a restart's sweep has run, and none before the grace`, async () => {
    const { api, storage, process } = world();
    const crashed = once(api, matches, what);
    void process().create(SPEC);
    await until(crashed);
    api.intercept = undefined;
    const restarted = process();
    const early = await restarted.sweep();
    assert.deepEqual(early.deletedUnclaimedServers, [], "a create in flight is never swept");
    assert.deepEqual(early.abandonedCreates, []);
    api.advanceClock(PAST_GRACE);
    await restarted.sweep();
    assert.deepEqual([...api.servers.values()].map((each) => each.name), []);
    assert.deepEqual([...storage.values.keys()], []);
  });
}

for (const [step, matches, what] of [
  ["before the delete reaches Hetzner", isDelete, "hang"],
  ["after Hetzner took the delete, before its answer", isDelete, "hang after acting"],
  ["while the delete's action is polled", isActionPoll, "hang"],
] as const) {
  test(`a crash ${step} is finished by a restart's sweep`, async () => {
    const { api, storage, process } = world();
    const host = await process().create(SPEC);
    const crashed = once(api, matches, what);
    void process().delete(host.hostId);
    await until(crashed);
    api.intercept = undefined;
    assert.equal((await process().record(host.hostId))?.state, "deleting");
    const outcome = await process().sweep();
    assert.deepEqual(outcome.finishedDeletes, [host.serverName]);
    assert.equal(api.servers.size, 0);
    assert.equal(storage.values.size, 0);
  });
}

test("the sweep never deletes a server a record claims, however old, nor one in this process's create", async () => {
  const { api, process } = world();
  const hosts = process();
  const ready = await hosts.create(SPEC);
  const inFlight = once(api, isActionPoll, "hang");
  void hosts.create(SPEC);
  await until(inFlight);
  api.intercept = undefined;
  api.advanceClock(24 * 3_600_000);
  const outcome = await hosts.sweep();
  assert.deepEqual(outcome, { deletedUnclaimedServers: [], adoptedHosts: [], finishedDeletes: [], abandonedCreates: [], droppedRecordsOfGoneServers: [], adoptedServers: [] });
  assert.equal(api.servers.size, 2);
  assert.equal((await hosts.record(ready.hostId))?.state, "ready");
});

test("the sweep adopts the install's unclaimed host, as after lost storage, and deletes another unclaimed server of the install past the grace, never another install's or one made by hand", async () => {
  const { api, process } = world();
  const raw = new Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: api.fetch, sleep: async () => {} });
  const lost = await raw.createServer({ name: "bb-box-inst1-lost0001", serverType: "cpx42", location: "nbg1", imageNameOrSnapshotId: "ubuntu-24.04", labels: { [LABEL.install]: "inst1", [LABEL.host]: "lost0001", [LABEL.role]: "host" } });
  const stray = await raw.createServer({ name: "bb-box-inst1-stray001", serverType: "cpx42", location: "nbg1", imageNameOrSnapshotId: "ubuntu-24.04", labels: { [LABEL.install]: "inst1", [LABEL.role]: "image-build" } });
  await raw.createServer({ name: "bb-box-other-h1", serverType: "cpx42", location: "nbg1", imageNameOrSnapshotId: "ubuntu-24.04", labels: { [LABEL.install]: "other", [LABEL.host]: "h1", [LABEL.role]: "host" } });
  await raw.createServer({ name: "docker-host-made-by-hand", serverType: "cpx32", location: "nbg1", imageNameOrSnapshotId: "ubuntu-24.04", labels: {} });
  const hosts = process();
  assert.deepEqual((await hosts.unclaimedServers()).map((each) => each.name).sort(), ["bb-box-inst1-lost0001", "bb-box-inst1-stray001"]);
  const first = await hosts.sweep();
  assert.deepEqual(first.adoptedHosts, ["bb-box-inst1-lost0001"]);
  assert.deepEqual(first.deletedUnclaimedServers, [], "not within the grace");
  const adopted = await hosts.record("lost0001");
  assert.deepEqual([adopted?.state, adopted?.serverId, adopted?.answeredAtMs], ["ready", lost.server.id, null]);
  api.advanceClock(PAST_GRACE);
  assert.deepEqual((await hosts.sweep()).deletedUnclaimedServers, ["bb-box-inst1-stray001"]);
  assert.equal(api.servers.has(stray.server.id), false);
  assert.deepEqual([...api.servers.values()].map((each) => each.name).sort(), ["bb-box-inst1-lost0001", "bb-box-other-h1", "docker-host-made-by-hand"]);
  assert.ok(api.calls.filter((call) => call.method === "GET" && call.path === "/servers").every((call) => call.query.label_selector?.startsWith("bbbox-install=inst1")), "every list keeps to the install");
});

test("a record whose server was deleted in Hetzner's Console is dropped", async () => {
  const { api, process } = world();
  const hosts = process();
  const host = await hosts.create(SPEC);
  api.servers.delete(host.serverId!);
  assert.deepEqual((await hosts.sweep()).droppedRecordsOfGoneServers, [host.serverName]);
  assert.deepEqual(await hosts.records(), []);
});

test("a delete Hetzner refuses stays a delete, and the next sweep finishes it", async () => {
  const { api, storage, process } = world();
  const hosts = process();
  const host = await hosts.create(SPEC);
  once(api, isDelete, { respond: respond(503, "Service Unavailable", { error: { code: "unavailable", message: "try again" } }) });
  await assert.rejects(hosts.delete(host.hostId), /unavailable/);
  assert.equal((await hosts.record(host.hostId))?.state, "deleting");
  await hosts.sweep();
  assert.equal(api.servers.size, 0);
  assert.equal(storage.values.size, 0);
});

test("two sweeps at once are one sweep", async () => {
  const { api, process } = world();
  const hosts = process();
  await hosts.create(SPEC);
  const before = api.calls.length;
  const [a, b] = await Promise.all([hosts.sweep(), hosts.sweep()]);
  assert.equal(a, b);
  assert.equal(api.calls.filter((call, index) => index >= before && call.path === "/servers").length, 1);
});
