import assert from "node:assert/strict";
import { test } from "node:test";
import { Hetzner, HetznerError, selectorMatchingAll, type HetznerOptions } from "../src/backends/hetzner/api.ts";
import { FAKE_HETZNER_TOKEN, FakeHetzner, selectorMatches, respond } from "./fake-hetzner.ts";

const INSTALL = { "bbbox-install": "inst1" };

function setup(options: Partial<HetznerOptions> = {}) {
  const api = new FakeHetzner();
  const sleeps: number[] = [];
  const hetzner = new Hetzner({
    token: FAKE_HETZNER_TOKEN,
    fetch: api.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return { api, hetzner, sleeps };
}

const host = (name: string, labels: Record<string, string> = { ...INSTALL, "bbbox-role": "host" }) => ({
  name,
  serverType: "cpx42",
  location: "nbg1",
  imageNameOrSnapshotId: "ubuntu-24.04",
  labels,
});

function assertNoToken(error: unknown) {
  assert.ok(error instanceof Error);
  for (const text of [error.message, String(error.stack), JSON.stringify(error), String(error)]) {
    assert.doesNotMatch(text, new RegExp(FAKE_HETZNER_TOKEN), "the token never shows");
  }
}

test("a create sends Hetzner's shape with the token only in the Authorization header, and the server runs once its action finishes", async () => {
  const { api, hetzner, sleeps } = setup();
  const firewall = await hetzner.createFirewall({ name: "bb-box-inst1", labels: INSTALL, rules: [{ direction: "in", protocol: "udp", port: "41641", sourceIps: ["0.0.0.0/0", "::/0"] }] });
  const key = await hetzner.createSshKey({ name: "bb-box-inst1", publicKey: "ssh-ed25519 AAAA bb-box", labels: INSTALL });
  const { server, startActions: actions } = await hetzner.createServer({ ...host("bb-box-inst1-h1"), sshKeys: [key.id], firewalls: [firewall.id], userData: "#cloud-config\n", ipv6: false });
  const create = api.calls.find((call) => call.method === "POST" && call.path === "/servers")!;
  assert.deepEqual(create.body, {
    name: "bb-box-inst1-h1",
    server_type: "cpx42",
    location: "nbg1",
    image: "ubuntu-24.04",
    labels: { "bbbox-install": "inst1", "bbbox-role": "host" },
    start_after_create: true,
    public_net: { enable_ipv4: true, enable_ipv6: false },
    ssh_keys: [String(key.id)],
    firewalls: [{ firewall: firewall.id }],
    user_data: "#cloud-config\n",
  });
  assert.ok(api.calls.every((call) => call.auth === `Bearer ${FAKE_HETZNER_TOKEN}`));
  assert.ok(api.calls.every((call) => !JSON.stringify({ path: call.path, query: call.query, body: call.body }).includes(FAKE_HETZNER_TOKEN)));
  assert.equal(server.status, "initializing");
  assert.equal(server.ipv4, `203.0.113.${(server.id % 250) + 1}`);
  assert.equal(actions.length, 2, "the create's action and the start that follows");
  for (const id of actions) await hetzner.waitAction(id);
  assert.deepEqual(sleeps, [1000], "actions are polled once a second, no closer");
  assert.equal((await hetzner.server(server.id))!.status, "running");
  assert.equal(api.servers.get(server.id)!.userData, "#cloud-config\n");
});

test("actions are never polled closer than a second, whatever is asked", async () => {
  const { api, hetzner, sleeps } = setup({ actionPollMs: 50 });
  api.pollsUntilCreatedServerRuns = 3;
  const { startActions: actions } = await hetzner.createServer(host("bb-box-inst1-h2"));
  await hetzner.waitAction(actions[0]!);
  assert.deepEqual(sleeps, [1000, 1000]);
});

test("a second create of a name is refused as taken, and the first server is found by its name", async () => {
  const { hetzner } = setup();
  const first = await hetzner.createServer(host("bb-box-inst1-h3"));
  const error = await hetzner.createServer(host("bb-box-inst1-h3")).catch((e) => e);
  assert.ok(error instanceof HetznerError);
  assert.equal(error.status, 409);
  assert.equal(error.taken, true);
  assert.equal((await hetzner.serverNamed("bb-box-inst1-h3"))!.id, first.server.id);
  assert.equal(await hetzner.serverNamed("bb-box-inst1-none"), null);
});

test("a create lost on the way back made the server all the same, and its name finds it", async () => {
  const { api, hetzner } = setup();
  api.intercept = (call) => (call.method === "POST" && call.path === "/servers" ? "lose" : undefined);
  const error = await hetzner.createServer(host("bb-box-inst1-h4")).catch((e) => e);
  assert.ok(error instanceof HetznerError);
  assert.equal(error.unreachable, true);
  api.intercept = undefined;
  assert.ok(await hetzner.serverNamed("bb-box-inst1-h4"));
  assert.equal((await hetzner.createServer(host("bb-box-inst1-h4")).catch((e) => e)).taken, true, "a retried create meets the first");
});

test("the project's server limit and a sold-out type are refused with their reasons", async () => {
  const { api, hetzner } = setup();
  api.projectServerLimit = 1;
  await hetzner.createServer(host("bb-box-inst1-h5"));
  const over = await hetzner.createServer(host("bb-box-inst1-h6")).catch((e) => e);
  assert.equal(over.overLimit, true);
  assert.match(over.message, /resource_limit_exceeded/);
  api.projectServerLimit = 10;
  api.soldOutTypeAtLocation.add("cpx42@nbg1");
  const sold = await hetzner.createServer(host("bb-box-inst1-h7")).catch((e) => e);
  assert.equal(sold.unavailable, true);
});

test("a 429 waits as Retry-After says and tries again, and gives up after its tries", async () => {
  const { api, hetzner, sleeps } = setup({
    triesWhenRateLimited: 3,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 2) api.requestsLeftThisHour = 5;
    },
  });
  api.requestsLeftThisHour = 0;
  assert.deepEqual(await hetzner.servers(INSTALL), []);
  assert.deepEqual(sleeps, [1000, 1000]);
  assert.equal(hetzner.requestsLeftThisHour, 4);
  const calls = api.calls.length;
  api.requestsLeftThisHour = 0;
  const error = await hetzner.servers(INSTALL).catch((e) => e);
  assert.ok(error instanceof HetznerError);
  assert.equal(error.rateLimited, true);
  assert.equal(api.calls.length - calls, 3, "three tries");
});

test("with no requests left in the hour, the next call waits for a refill before it goes", async () => {
  const { api, hetzner, sleeps } = setup();
  api.requestsLeftThisHour = 1;
  await hetzner.servers(INSTALL);
  assert.equal(hetzner.requestsLeftThisHour, 0);
  sleeps.length = 0;
  api.requestsLeftThisHour = 10;
  await hetzner.servers(INSTALL);
  assert.deepEqual(sleeps, [1000]);
});

test("lists follow Hetzner's pages, 50 at a time, and keep to the install's labels", async () => {
  const { api, hetzner } = setup();
  api.projectServerLimit = 200;
  for (let i = 0; i < 120; i++) await hetzner.createServer(host(`bb-box-inst1-p${i}`));
  await hetzner.createServer(host("bb-box-other-h1", { "bbbox-install": "other", "bbbox-role": "host" }));
  await hetzner.createServer(host("by-hand", {}));
  const before = api.calls.length;
  const all = await hetzner.servers(INSTALL);
  assert.equal(all.length, 120);
  const pages = api.calls.slice(before);
  assert.deepEqual(pages.map((call) => call.query.page), ["1", "2", "3"]);
  assert.ok(pages.every((call) => call.query.per_page === "50" && call.query.label_selector === "bbbox-install=inst1"));
  assert.ok(all.every((each) => each.labels["bbbox-install"] === "inst1"));
});

test("a delete waits for its action, and a second finds the server gone", async () => {
  const { api, hetzner } = setup();
  const { server } = await hetzner.createServer(host("bb-box-inst1-h8"));
  assert.equal(await hetzner.deleteServer(server.id), "deleted");
  assert.equal(api.servers.has(server.id), false);
  assert.equal(await hetzner.deleteServer(server.id), "already gone");
  assert.equal(await hetzner.server(server.id), null);
});

test("a failed action throws with Hetzner's code", async () => {
  const { api, hetzner } = setup();
  const { startActions: actions } = await hetzner.createServer(host("bb-box-inst1-h9"));
  api.failActionOnNextPoll(actions[0]!, "server_error", "could not create the server");
  const error = await hetzner.waitAction(actions[0]!).catch((e) => e);
  assert.ok(error instanceof HetznerError);
  assert.equal(error.code, "server_error");
  assert.match(error.message, /create_server failed: could not create the server/);
});

test("an action that never finishes stops at its timeout", async () => {
  const { api, hetzner, sleeps } = setup({ actionTimeoutMs: 5_000 });
  api.pollsUntilCreatedServerRuns = 1_000;
  const { startActions: actions } = await hetzner.createServer(host("bb-box-inst1-h10"));
  const error = await hetzner.waitAction(actions[0]!).catch((e) => e);
  assert.equal(error.code, "timeout");
  assert.equal(sleeps.length, 5);
});

test("a call that hangs times out as unreachable", async () => {
  const { api, hetzner } = setup({ requestTimeoutMs: 20 });
  api.intercept = () => "hang";
  const error = await hetzner.servers(INSTALL).catch((e) => e);
  assert.ok(error instanceof HetznerError);
  assert.equal(error.unreachable, true);
  assert.match(error.message, /timed out/);
});

test("the token shows in no error: a refused token, a failed fetch that names it, or a message that echoes it", async () => {
  const wrong = new Hetzner({ token: `${FAKE_HETZNER_TOKEN}x`, fetch: new FakeHetzner().fetch, sleep: async () => undefined });
  const unauthorised = await wrong.servers(INSTALL).catch((e) => e);
  assert.equal(unauthorised.unauthorised, true);
  assert.doesNotMatch(unauthorised.message, /hcloud-fake-token/);

  const thrown = new Hetzner({
    token: FAKE_HETZNER_TOKEN,
    fetch: async () => {
      throw new TypeError("fetch failed", { cause: new Error(`bad header Authorization: Bearer ${FAKE_HETZNER_TOKEN}`) });
    },
  });
  const failed = await thrown.servers(INSTALL).catch((e) => e);
  assertNoToken(failed);
  assert.match(failed.message, /\[token\]/);

  const { api, hetzner } = setup();
  api.intercept = () => ({ respond: respond(400, "Bad Request", { error: { code: "invalid_input", message: `token ${FAKE_HETZNER_TOKEN} is odd` } }) });
  assertNoToken(await hetzner.servers(INSTALL).catch((e) => e));

  api.intercept = undefined;
  const { startActions: actions } = await hetzner.createServer(host("bb-box-inst1-h11"));
  api.failActionOnNextPoll(actions[0]!, "server_error", `echo ${FAKE_HETZNER_TOKEN}`);
  assertNoToken(await hetzner.waitAction(actions[0]!).catch((e) => e));
});

test("a snapshot is taken, waited for, labelled, listed and deleted", async () => {
  const { hetzner } = setup();
  const { server } = await hetzner.createServer(host("bb-box-inst1-build"));
  const made = await hetzner.createSnapshot(server.id, { description: "bb-box host b1", labels: { ...INSTALL, "bbbox-build": "b1" } });
  assert.equal(made.status, "available");
  assert.equal(made.compressedSizeGB, 4.2);
  assert.deepEqual((await hetzner.snapshots(INSTALL)).map((each) => each.id), [made.id]);
  assert.deepEqual(await hetzner.snapshots({ ...INSTALL, "bbbox-build": "b2" }), []);
  assert.equal(await hetzner.deleteImage(made.id), "deleted");
  assert.equal(await hetzner.deleteImage(made.id), "already gone");
});

test("SSH keys and firewalls are listed by label, and a firewall still applied is not deleted", async () => {
  const { hetzner } = setup();
  const key = await hetzner.createSshKey({ name: "bb-box-inst1", publicKey: "ssh-ed25519 AAAA", labels: INSTALL });
  await hetzner.createSshKey({ name: "by-hand", publicKey: "ssh-ed25519 BBBB", labels: {} });
  assert.deepEqual((await hetzner.sshKeys(INSTALL)).map((each) => each.name), ["bb-box-inst1"]);
  const firewall = await hetzner.createFirewall({ name: "bb-box-inst1", labels: INSTALL, rules: [] });
  const { server } = await hetzner.createServer({ ...host("bb-box-inst1-h12"), firewalls: [firewall.id] });
  const inUse = await hetzner.deleteFirewall(firewall.id).catch((e) => e);
  assert.equal(inUse.code, "resource_in_use");
  await hetzner.deleteServer(server.id);
  assert.equal(await hetzner.deleteFirewall(firewall.id), "deleted");
  assert.equal(await hetzner.deleteSshKey(key.id), "deleted");
  assert.equal(await hetzner.deleteSshKey(key.id), "already gone");
});

test("prices come before VAT, with a public IPv4's, and a server type gives its size and where it is sold", async () => {
  const { hetzner } = setup();
  assert.deepEqual(await hetzner.pricesBeforeVat("cpx42", "nbg1"), { server: { hourly: 0.1114, monthly: 69.49 }, ipv4: { hourly: 0.0008, monthly: 0.5 } });
  assert.equal(await hetzner.pricesBeforeVat("cpx42", "ash"), null);
  assert.equal(await hetzner.pricesBeforeVat("cx99", "nbg1"), null);
  assert.deepEqual(await hetzner.serverType("cpx42"), { name: "cpx42", cores: 8, memoryGB: 16, diskGB: 320, architecture: "x86", soldIn: ["nbg1", "fsn1", "hel1"], deprecated: false });
  assert.equal(await hetzner.serverType("cx99"), null);
});

test("labels change on a server, and the selector sees the change", async () => {
  const { hetzner } = setup();
  const { server } = await hetzner.createServer(host("bb-box-inst1-h13"));
  await hetzner.setServerLabels(server.id, { ...INSTALL, "bbbox-role": "host", "bbbox-state": "deleting" });
  assert.equal((await hetzner.servers({ ...INSTALL, "bbbox-state": "deleting" })).length, 1);
});

test("label selectors: all terms match, with =, ==, !=, presence, absence, in and notin", () => {
  const labels = { "bbbox-install": "inst1", "bbbox-role": "host" };
  assert.equal(selectorMatchingAll({ "bbbox-install": "inst1", "bbbox-role": "host" }), "bbbox-install=inst1,bbbox-role=host");
  assert.equal(selectorMatches(labels, "bbbox-install=inst1,bbbox-role=host"), true);
  assert.equal(selectorMatches(labels, "bbbox-install==inst1"), true);
  assert.equal(selectorMatches(labels, "bbbox-install=inst2"), false);
  assert.equal(selectorMatches(labels, "bbbox-role!=build"), true);
  assert.equal(selectorMatches(labels, "bbbox-role"), true);
  assert.equal(selectorMatches(labels, "!bbbox-build"), true);
  assert.equal(selectorMatches(labels, "bbbox-role in (host,build)"), true);
  assert.equal(selectorMatches(labels, "bbbox-role notin (host,build),bbbox-install=inst1"), false);
  assert.equal(selectorMatches({}, "bbbox-install=inst1"), false, "a server made by hand, with no labels, never matches");
});

test("a snapshot's wait polls every 15 s for up to an hour, within Hetzner's 3600 requests an hour", async () => {
  const { api, hetzner, sleeps } = setup();
  const { server } = await hetzner.createServer(host("bb-box-inst1-slow"));
  api.pollsUntilSnapshotMade = 100_000;
  const started = await hetzner.startSnapshot(server.id, { description: "slow", labels: {} });
  const before = sleeps.length;
  const error = (await hetzner.waitAction(started.actionId, undefined, 3_600_000, 15_000).catch((e: unknown) => e)) as Error;
  assert.match(error.message, /create_image did not finish in 3600 s/);
  const waits = sleeps.slice(before);
  assert.equal(waits.length, 240);
  assert.ok(waits.every((ms) => ms === 15_000));
});
