import assert from "node:assert/strict";
import { test } from "node:test";
import { Backends, DRIVERS } from "../src/backends/index.ts";
import { GENERAL_SECRETS } from "../src/core/box-files.ts";
import { checkDocument, exported, readDraft, withSecretChanges, withoutSecrets } from "../src/core/document.ts";
import type { TailnetFetch } from "../src/core/tailnet.ts";
import { tailnetDoctor } from "../src/core/tailnet-doctor.ts";
import { TAILNET_CLIENT_ID, TAILNET_CLIENT_SECRET } from "../src/core/tailnet-settings.ts";
import { MemoryStorage } from "./helpers.ts";

const SECRET = "tskey-client-kSECRET-0123456789";

function draft(tailnet: unknown) {
  return readDraft({ schema: 1, revision: 0, backends: [], kinds: {}, general: { tailnet } }, DRIVERS);
}

test("the tailnet's OAuth client is two general secrets, kept only while BB Box uses it, shown only as set, and stored apart", () => {
  const read = draft({ mode: "oauth", tags: ["tag:bb-box", "tag:bb-box-mac"], clientId: "kCLIENT", clientSecret: SECRET });
  assert.deepEqual(read.problems, []);
  assert.deepEqual(read.document.general.tailnet, { mode: "oauth", tags: ["tag:bb-box", "tag:bb-box-mac"] });
  assert.deepEqual(read.secrets[GENERAL_SECRETS], { [TAILNET_CLIENT_ID]: "kCLIENT", [TAILNET_CLIENT_SECRET]: SECRET });
  const stored = withSecretChanges({}, read.secrets, read.document);
  assert.deepEqual(stored[GENERAL_SECRETS], { [TAILNET_CLIENT_ID]: "kCLIENT", [TAILNET_CLIENT_SECRET]: SECRET });
  assert.deepEqual(exported(read.document, stored, DRIVERS).general.tailnet, { mode: "oauth", tags: ["tag:bb-box", "tag:bb-box-mac"], clientId: { set: true }, clientSecret: { set: true } });
  assert.doesNotMatch(JSON.stringify(exported(read.document, stored, DRIVERS)), /SECRET|kCLIENT/);
  assert.doesNotMatch(JSON.stringify(withoutSecrets(read.document, DRIVERS)), /SECRET|kCLIENT/);
  assert.deepEqual(checkDocument(read.document, stored, DRIVERS), []);

  const kept = draft({ mode: "oauth", clientId: { set: true }, clientSecret: { set: true } });
  assert.deepEqual(withSecretChanges(stored, kept.secrets, kept.document)[GENERAL_SECRETS], stored[GENERAL_SECRETS]);
  const off = draft({ mode: "off" });
  assert.equal(withSecretChanges(stored, off.secrets, off.document)[GENERAL_SECRETS], undefined, "turning it off forgets the client");
  const cleared = draft({ mode: "oauth", clientSecret: null });
  const without = withSecretChanges(stored, cleared.secrets, cleared.document);
  assert.deepEqual(checkDocument(cleared.document, without, DRIVERS).map((problem) => problem.path), ["general.tailnet.clientSecret"]);
});

test("a tailnet setting that is not one is refused at its field, and never quotes a secret", () => {
  assert.deepEqual(draft({ mode: "vpn" }).problems.map((problem) => problem.path), ["general.tailnet.mode"]);
  assert.deepEqual(draft({ mode: "oauth", tags: ["bb-box"] }).problems.map((problem) => problem.path), ["general.tailnet.tags"]);
  const wrong = draft({ mode: "oauth", clientSecret: 42, port: 1 });
  assert.deepEqual(wrong.problems.map((problem) => problem.path), ["general.tailnet.port", "general.tailnet.clientSecret"]);
  assert.deepEqual(draft("oauth").problems.map((problem) => problem.path), ["general.tailnet"]);
});

function fakeTailscale(options: { devicesStatus?: number } = {}): TailnetFetch {
  return async (url, init) => {
    const path = new URL(url).pathname;
    const reply = (status: number, body: unknown) => ({ ok: status === 200, status, text: async () => JSON.stringify(body) });
    if (path === "/api/v2/oauth/token") return new URLSearchParams(init.body).get("client_secret") === SECRET ? reply(200, { access_token: "tok", expires_in: 3600 }) : reply(401, { error: "invalid_client" });
    if (path === "/api/v2/tailnet/-/devices") return options.devicesStatus ? reply(options.devicesStatus, { message: "forbidden" }) : reply(200, { devices: [{ nodeId: "n1", hostname: "bb-box-ns-i1-mac-one", tags: ["tag:bb-box"] }, { nodeId: "n2", hostname: "owners-laptop", tags: ["tag:bb-box"] }, { nodeId: "n3", hostname: "bb-box-ns-other-mac", tags: ["tag:bb-box"] }] });
    return reply(404, {});
  };
}

test("backends get the tailnet as the settings have it now, and the doctor checks the client and lists only this install's BB Box devices, counting the others with the tag", async () => {
  const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {}, tailnetFetch: fakeTailscale() });
  const on = draft({ mode: "oauth", clientId: "kCLIENT", clientSecret: SECRET });
  await backends.configure(on.document, withSecretChanges({}, on.secrets, on.document));
  const tailnet = backends.context("x").tailnet?.();
  assert.ok(tailnet);
  assert.equal(backends.tailnet(), tailnet, "the same client while the settings are the same");
  const report = await tailnetDoctor(tailnet, "i1");
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => `${check.id} ${check.status}`), ["tailnet.client ok", "tailnet.devices ok"]);
  assert.equal(report.checks[1]!.detail, "1 of BB Box's on the tailnet: bb-box-ns-i1-mac-one. 2 other devices have the tags tag:bb-box; BB Box leaves them alone.");

  const off = draft({ mode: "off" });
  await backends.configure(off.document, {});
  assert.equal(backends.context("x").tailnet?.(), null);

});

test("the doctor fails when Tailscale refuses the client, and says what to check, never the secret", async () => {
  const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {}, tailnetFetch: fakeTailscale() });
  const wrong = draft({ mode: "oauth", clientId: "kCLIENT", clientSecret: "tskey-client-wrong" });
  await backends.configure(wrong.document, withSecretChanges({}, wrong.secrets, wrong.document));
  const report = await tailnetDoctor(backends.tailnet()!, "i1");
  assert.equal(report.ok, false);
  assert.match(report.checks[0]!.fix ?? "", /auth_keys scope/);
  assert.doesNotMatch(JSON.stringify(report), /tskey-client/);
});

test("the devices check warns, and says which scope to add, when the client may not list devices", async () => {
  const backends = new Backends({ storage: new MemoryStorage(), installId: "i1", logError: () => {}, tailnetFetch: fakeTailscale({ devicesStatus: 403 }) });
  const on = draft({ mode: "oauth", clientId: "kCLIENT", clientSecret: SECRET });
  await backends.configure(on.document, withSecretChanges({}, on.secrets, on.document));
  const report = await tailnetDoctor(backends.tailnet()!, "i1");
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks.map((check) => `${check.id} ${check.status}`), ["tailnet.client ok", "tailnet.devices warn"]);
  assert.match(report.checks[1]!.fix ?? "", /devices:core scope/);
});
