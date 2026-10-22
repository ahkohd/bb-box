import assert from "node:assert/strict";
import { test } from "node:test";
import { NamespaceApi, NamespaceError } from "../src/backends/namespace/api.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace } from "./fake-namespace.ts";

const MAC = { os: "macos" as const, arch: "arm64" as const, cores: 6, memoryMiB: 14 * 1024, selectors: { "macos.version": "26.x" } };

function setup(options: ConstructorParameters<typeof FakeNamespace>[0] = {}) {
  const fake = new FakeNamespace(options);
  const api = new NamespaceApi({ token: FAKE_NAMESPACE_TOKEN, fetch: fake.fetch });
  return { fake, api };
}

test("an instance is made with its shape, labels, deadline, unique tag and SSH key, and a second make with the same tag finds the first", async () => {
  const { fake, api } = setup();
  const deadline = Date.parse("2030-01-01T01:00:00Z");
  const request = { shape: MAC, labels: { "bbbox-install": "i1", "bbbox-box": "box_1" }, deadline, purpose: "bb-box box quiet-heron", uniqueTag: "bbbox-i1-box_1", sshPublicKeys: ["ssh-ed25519 AAAA bb-box"] };
  const made = await api.create(request);
  const again = await api.create(request);
  assert.equal(again.id, made.id);
  assert.equal(fake.instances.size, 1);
  assert.deepEqual(fake.calls[0], {
    method: "CreateInstance",
    body: {
      shape: { os: "macos", machineArch: "arm64", virtualCpu: 6, memoryMegabytes: 14336, selectors: [{ name: "macos.version", value: "26.x" }] },
      documentedPurpose: "bb-box box quiet-heron",
      labels: [{ name: "bbbox-install", value: "i1" }, { name: "bbbox-box", value: "box_1" }],
      deadline: "2030-01-01T01:00:00.000Z",
      experimental: { uniqueTag: "bbbox-i1-box_1", authorizedSshKeys: ["ssh-ed25519 AAAA bb-box"] },
    },
  });
  assert.equal(made.status, "unknown", "as Namespace's own answer to a create has no status");
  const ready = await api.wait(made.id);
  assert.deepEqual([ready.status, ready.continent, ready.labels["bbbox-box"], ready.shape?.cores], ["running", "us", "box_1", 6]);
});

test("instances are listed by label, extended to at least a time ahead within the plan's cap, and destroyed once, a second destroy being no error", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const { fake, api } = setup({ now: () => now, lifeCapMs: 4 * 3600_000 });
  const mine = await api.create({ shape: MAC, labels: { "bbbox-install": "i1" }, deadline: now + 3600_000, purpose: "a", uniqueTag: "a", sshPublicKeys: [] });
  await api.create({ shape: { ...MAC, cores: 2, memoryMiB: 4096 }, labels: { "bbbox-install": "other" }, deadline: now + 3600_000, purpose: "b", uniqueTag: "b", sshPublicKeys: [] });
  assert.deepEqual((await api.list({ "bbbox-install": "i1" })).map((instance) => instance.id), [mine.id]);
  now += 50 * 60_000;
  const extended = await api.extend(mine.id, 3600_000);
  assert.equal(extended, now + 3600_000);
  assert.equal(fake.calls.at(-1)?.body.ensureMinimum, "3600s");
  assert.equal(await api.extend(mine.id, 48 * 3600_000), Date.parse("2030-01-01T04:00:00Z"));
  await api.destroy(mine.id, "released");
  await api.destroy(mine.id, "released again");
  assert.deepEqual((await api.list({ "bbbox-install": "i1" })).length, 0);
});

test("an instance past its deadline is gone, and reading it says so", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const { api } = setup({ now: () => now });
  const made = await api.create({ shape: MAC, labels: {}, deadline: now + 120_000, purpose: "a", uniqueTag: "a", sshPublicKeys: [] });
  now += 121_000;
  assert.equal((await api.describe(made.id)).status, "destroyed");
  const extended = await api.extend(made.id, 60_000).catch((error: unknown) => error);
  assert.ok(extended instanceof NamespaceError && extended.kind === "gone");
});

test("the desktop's sign-in comes from Namespace", async () => {
  const { api } = setup();
  const made = await api.create({ shape: MAC, labels: {}, deadline: Date.now() + 600_000, purpose: "a", uniqueTag: "a", sshPublicKeys: [] });
  await api.wait(made.id);
  assert.deepEqual(await api.vncSignIn(made.id), { user: "runner", password: `vnc-${made.id}` });
});

test("each failure says what to check, by kind, and never the token", async () => {
  const { fake, api } = setup({ maxCores: 6 });
  await api.create({ shape: MAC, labels: {}, deadline: Date.now() + 600_000, purpose: "a", uniqueTag: "a", sshPublicKeys: [] });
  const full = await api.create({ shape: MAC, labels: {}, deadline: Date.now() + 600_000, purpose: "b", uniqueTag: "b", sshPublicKeys: [] }).catch((error: unknown) => error);
  assert.ok(full instanceof NamespaceError && full.kind === "full");
  assert.match(full.message, /plan's limit of machines at once/);

  fake.token = "nsct_other";
  const refused = await api.list({}).catch((error: unknown) => error);
  assert.ok(refused instanceof NamespaceError && refused.kind === "refused");
  assert.match(refused.message, /Check the Namespace token/);
  fake.token = FAKE_NAMESPACE_TOKEN;

  fake.failNext("ListInstances", "internal", `boom ${FAKE_NAMESPACE_TOKEN}`);
  const internal = await api.list({}).catch((error: unknown) => error);
  assert.ok(internal instanceof NamespaceError && internal.kind === "failed");
  assert.doesNotMatch(internal.message, /nsct_|fakeTOKEN/);

  const offline = new NamespaceApi({ token: FAKE_NAMESPACE_TOKEN, fetch: async () => { throw new Error(`socket closed ${FAKE_NAMESPACE_TOKEN}`); } });
  const unreachable = await offline.list({}).catch((error: unknown) => error);
  assert.ok(unreachable instanceof NamespaceError && unreachable.kind === "unreachable");
  assert.doesNotMatch(unreachable.message, /nsct_|fakeTOKEN/);
});

test("the region chooses the API's endpoint and the SSH gateway", async () => {
  const urls: string[] = [];
  const api = new NamespaceApi({ token: "t", region: "eu", fetch: async (url) => (urls.push(url), { ok: true, status: 200, text: async () => JSON.stringify({ instances: [] }) }) });
  await api.list({});
  assert.deepEqual(urls, ["https://eu.compute.namespaceapis.com/namespace.cloud.compute.v1beta.ComputeService/ListInstances"]);
  assert.equal(api.sshGateway, "ssh.eu.namespace.so");
});
