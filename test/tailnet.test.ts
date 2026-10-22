import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_TAILNET_TAGS, Tailnet, TailnetError, joinScript, keyDescription, leaveScript, tailnetHostname, type TailnetFetch } from "../src/core/tailnet.ts";

const CLIENT_SECRET = "tskey-client-kSECRETvalue-0123456789abcdef";
const ACCESS_TOKEN = "tskey-api-kACCESStoken-abcdef0123456789";
const MINTED = "tskey-auth-kMINTEDkey-fedcba9876543210";

interface Call {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

function fakeTailscale(options: { refuseClient?: boolean; keysStatus?: number; devices?: unknown[]; deviceStatus?: number; tokenLifetime?: number } = {}) {
  const calls: Call[] = [];
  const fetch: TailnetFetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, headers: init.headers, body: init.body });
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    if (path === "/api/v2/oauth/token") {
      if (options.refuseClient) return reply(401, { error: "invalid_client", error_description: `client ${CLIENT_SECRET} is not valid` });
      return reply(200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: options.tokenLifetime ?? 3600, scope: "auth_keys devices:core" });
    }
    if (init.headers.Authorization !== `Bearer ${ACCESS_TOKEN}`) return reply(401, { message: "unauthorized" });
    if (path === "/api/v2/tailnet/-/keys" && init.method === "POST") {
      if (options.keysStatus && options.keysStatus !== 200) return reply(options.keysStatus, { message: `requested tags are invalid or not permitted, key ${MINTED}` });
      return reply(200, { id: "k123", key: MINTED, created: "2026-10-22T16:00:00Z", expires: "2026-10-22T16:10:00Z" });
    }
    if (path === "/api/v2/tailnet/-/devices" && init.method === "GET") return reply(200, { devices: options.devices ?? [] });
    if (path.startsWith("/api/v2/device/") && init.method === "DELETE") return reply(options.deviceStatus ?? 200, options.deviceStatus === 404 ? { message: "not found" } : {});
    return reply(404, { message: "no such route" });
  };
  return { fetch, calls };
}

const credentials = { clientId: "kCLIENTid", clientSecret: CLIENT_SECRET };

test("a key for each machine is single-use, ephemeral, pre-approved and tagged, expires in 10 minutes, and the OAuth token is asked for once", async () => {
  const fake = fakeTailscale();
  const tailnet = new Tailnet({ credentials, fetch: fake.fetch });
  const first = await tailnet.mintKey({ description: "bb-box mac quiet-heron (box_123)" });
  const second = await tailnet.mintKey({ description: "bb-box host h1" });
  assert.equal(first.key, MINTED);
  assert.equal(first.id, "k123");
  assert.equal(first.expiresAt, Date.parse("2026-10-22T16:10:00Z"));
  assert.equal(second.key, MINTED);
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.path}`), ["POST /api/v2/oauth/token", "POST /api/v2/tailnet/-/keys", "POST /api/v2/tailnet/-/keys"]);
  const token = new URLSearchParams(fake.calls[0]!.body);
  assert.deepEqual([token.get("client_id"), token.get("client_secret"), token.get("grant_type")], ["kCLIENTid", CLIENT_SECRET, "client_credentials"]);
  assert.deepEqual(JSON.parse(fake.calls[1]!.body!), {
    capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: DEFAULT_TAILNET_TAGS } } },
    expirySeconds: 600,
    description: "bb-box mac quiet-heron box 123",
  });
});

test("the OAuth token is asked for again once it is near its expiry, and after Tailscale refuses it", async () => {
  let now = 1_000_000;
  const fake = fakeTailscale({ tokenLifetime: 120 });
  const tailnet = new Tailnet({ credentials, fetch: fake.fetch, now: () => now, tags: ["tag:bb-box-mac"] });
  await tailnet.mintKey({ description: "one" });
  now += 30_000;
  await tailnet.mintKey({ description: "two" });
  now += 31_000;
  await tailnet.mintKey({ description: "three" });
  assert.equal(fake.calls.filter((call) => call.path === "/api/v2/oauth/token").length, 2);
  assert.deepEqual(JSON.parse(fake.calls.at(-1)!.body!).capabilities.devices.create.tags, ["tag:bb-box-mac"]);
});

test("no error says the OAuth client's secret, the access token or a key, and each says what to check", async () => {
  const refused = new Tailnet({ credentials, fetch: fakeTailscale({ refuseClient: true }).fetch });
  const error = await refused.mintKey({ description: "x" }).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof TailnetError);
  assert.match(error.message, /refused the OAuth client \(HTTP 401\)/);
  assert.match(error.message, /auth_keys scope/);
  assert.doesNotMatch(error.message, /tskey-client|SECRET/);

  const tags = new Tailnet({ credentials, fetch: fakeTailscale({ keysStatus: 403 }).fetch });
  const forbidden = await tags.mintKey({ description: "x" }).catch((thrown: unknown) => thrown);
  assert.ok(forbidden instanceof TailnetError);
  assert.match(forbidden.message, /did not make a key for the tailnet \(HTTP 403\)/);
  assert.doesNotMatch(forbidden.message, /tskey-auth|MINTED/);

  const unreachable = new Tailnet({ credentials, fetch: async () => { throw new Error(`connect refused for ${CLIENT_SECRET}`); } });
  const offline = await unreachable.mintKey({ description: "x" }).catch((thrown: unknown) => thrown);
  assert.ok(offline instanceof TailnetError);
  assert.match(offline.message, /Could not reach Tailscale/);
  assert.doesNotMatch(offline.message, /SECRET/);
});

test("the doctor's check signs the OAuth client in and makes nothing", async () => {
  const fake = fakeTailscale();
  assert.deepEqual(await new Tailnet({ credentials, fetch: fake.fetch }).check(), { ok: true });
  assert.deepEqual(fake.calls.map((call) => call.path), ["/api/v2/oauth/token"]);
  const failed = await new Tailnet({ credentials, fetch: fakeTailscale({ refuseClient: true }).fetch }).check();
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.ok ? "" : failed.reason, /SECRET/);
});

test("devices lists only the tailnet's devices with bb-box's tags, and removing one that is already gone is no error", async () => {
  const fake = fakeTailscale({
    devices: [
      { id: "1", nodeId: "nA", hostname: "bb-box-mac-quiet-heron", tags: ["tag:bb-box"], lastSeen: "2026-10-22T15:00:00Z" },
      { id: "2", nodeId: "nB", hostname: "owners-laptop", tags: [], lastSeen: "2026-10-22T15:05:00Z" },
      { id: "3", nodeId: "nC", name: "bb-box-host-h1.tail1234.ts.net", tags: ["tag:other", "tag:bb-box"] },
    ],
  });
  const tailnet = new Tailnet({ credentials, fetch: fake.fetch });
  assert.deepEqual(await tailnet.devices(), [
    { id: "nA", hostname: "bb-box-mac-quiet-heron", tags: ["tag:bb-box"], lastSeen: Date.parse("2026-10-22T15:00:00Z") },
    { id: "nC", hostname: "bb-box-host-h1", tags: ["tag:other", "tag:bb-box"], lastSeen: null },
  ]);
  await tailnet.removeDevice("nA");
  assert.deepEqual(fake.calls.at(-1), { method: "DELETE", path: "/api/v2/device/nA", headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: "application/json" }, body: undefined });
  await new Tailnet({ credentials, fetch: fakeTailscale({ deviceStatus: 404 }).fetch }).removeDevice("gone");
  const forbidden = await new Tailnet({ credentials, fetch: fakeTailscale({ deviceStatus: 403 }).fetch }).removeDevice("nA").catch((thrown: unknown) => thrown);
  assert.ok(forbidden instanceof TailnetError);
  assert.match(forbidden.message, /devices:core scope/);
});

test("descriptions and hostnames are what Tailscale takes", () => {
  assert.equal(keyDescription("bb-box: Mac for thr_abc/box_1!"), "bb-box Mac for thr abc box 1");
  assert.equal(keyDescription("x".repeat(80)).length, 50);
  assert.equal(keyDescription("___"), "bb-box");
  assert.equal(tailnetHostname("BB Box: Quiet_Heron!"), "bb-box-quiet-heron");
  assert.equal(tailnetHostname("-".repeat(5)), "bb-box");
});

test("the join script takes the key on its input, gives it to tailscale up only as a file, and leaves no file; the leave script logs out", () => {
  const folder = mkdtempSync(join(tmpdir(), "tailnet-"));
  const log = join(folder, "calls");
  writeFileSync(
    join(folder, "tailscale"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\ncase "$1" in up) f=$(printf '%s' "$2" | sed 's/^--auth-key=file://'); printf 'key=%s\\n' "$(cat "$f")" >> ${log};; ip) echo 100.64.0.7;; esac\n`,
  );
  chmodSync(join(folder, "tailscale"), 0o755);
  writeFileSync(join(folder, "sudo"), `#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n`);
  chmodSync(join(folder, "sudo"), 0o755);
  const scratch = mkdtempSync(join(tmpdir(), "tailnet-tmp-"));
  const env = { ...process.env, PATH: `${folder}:${process.env.PATH}`, TMPDIR: scratch };
  const out = execFileSync("sh", ["-c", joinScript("Quiet Heron")], { input: MINTED, env, encoding: "utf8" });
  assert.equal(out.trim(), "100.64.0.7");
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.match(calls[0]!, /^up --auth-key=file:\S+ --hostname=quiet-heron --accept-dns=false --timeout=60s$/);
  assert.equal(calls[1], `key=${MINTED}`);
  assert.ok(!calls[0]!.includes(MINTED), "the key is never on the command line");
  assert.deepEqual(readdirSync(scratch), [], "the key's file is gone");
  execFileSync("sh", ["-c", leaveScript()], { env, encoding: "utf8" });
  assert.equal(readFileSync(log, "utf8").trim().split("\n").at(-1), "logout");
});
