import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { parseLxcSettings } from "../src/backends/proxmox-lxc/config.ts";
import type { BackendDriver } from "../src/backends/types.ts";
import { readSettings, smoke, timingTable } from "../scripts/smoke.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, KEY, VALID, fakeSsh, tempDir } from "./helpers.ts";

const FINGERPRINT = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");

function fakes() {
  const ssh = fakeSsh();
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  const driver: BackendDriver<any> = {
    ...proxmoxLxcDriver,
    create: (config, context) =>
      new ProxmoxLxcBackend(config, context, { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true }),
  };
  const values = { ...VALID, "proxmox-lxc-enabled": true, "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret };
  const lines: string[] = [];
  return { ssh, proxmox, values, drivers: [driver], lines, log: (line: string) => lines.push(line) };
}

test("the example settings read the setup guide's token file and key, and parse", () => {
  const dir = tempDir("smoke-settings");
  copyFileSync(new URL("../scripts/smoke.example.json", import.meta.url), join(dir, "smoke.json"));
  writeFileSync(
    join(dir, "proxmox-token.env"),
    [
      "# bb-box plugin: Proxmox API access. Secret: keep 0600.",
      "PROXMOX_API_URL=https://192.0.2.10:8006/api2/json",
      "PROXMOX_NODE=pve",
      "PROXMOX_TOKEN_ID=bbbox@pve!plugin",
      "PROXMOX_TOKEN_SECRET=s3cret",
      `PROXMOX_TLS_SHA256_FINGERPRINT=${FINGERPRINT}`,
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "ssh"));
  writeFileSync(join(dir, "ssh", "id_ed25519"), `${KEY}\n`);

  const values = readSettings(join(dir, "smoke.json"));
  assert.equal(values["proxmox-lxc-node"], "pve");
  assert.equal(values["proxmox-lxc-token-secret"], "s3cret");
  assert.equal(values["proxmox-lxc-ssh-private-key"], `${KEY}\n`);
  const parsed = parseLxcSettings(values);
  assert.ok(parsed.enabled && parsed.ok, JSON.stringify(parsed));
  assert.deepEqual(parsed.config.flavours.headless.templates.map((template) => template.vmid), [9100]);
  assert.equal(parsed.config.proxmox.tlsFingerprint, FINGERPRINT);
});

test("a settings file naming a missing key says which", () => {
  const dir = tempDir("smoke-settings");
  writeFileSync(join(dir, "token.env"), "PROXMOX_NODE=pve\n");
  writeFileSync(join(dir, "smoke.json"), JSON.stringify({ "proxmox-lxc-url": { file: "token.env", key: "PROXMOX_API_URL" } }));
  assert.throws(() => readSettings(join(dir, "smoke.json")), /token\.env has no PROXMOX_API_URL= line/);
});

test("the smoke test acquires a box, runs the command, releases the box and times each step", async () => {
  const { proxmox, values, drivers, lines, log } = fakes();
  const result = await smoke(values, { kind: "linux-headless", command: "echo hello from $(whoami 2>/dev/null || echo box)", drivers, log });

  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.equal(result.box?.kind, "linux-headless");
  assert.match(result.box?.address ?? "", /^192\.0\.2\./);
  assert.equal(result.output?.exitCode, 0);
  assert.match(result.output?.stdout ?? "", /^hello from /);
  for (const step of ["clone", "start", "ssh", "total", "acquire", "run", "release"]) assert.ok(step in result.timings, `no ${step} timing`);
  assert.deepEqual([...proxmox.guests.keys()], [9000], "the box was deleted");
  assert.match(lines.join("\n"), /is ready at 192\.0\.2\./);

  const table = timingTable(result.timings);
  assert.match(table, /^Step +Time$/m);
  assert.match(table, /^ready \(backend\) +\d+\.\d\d s$/m);
});

test("the smoke test releases the box when the command fails", async () => {
  const { proxmox, values, drivers, log } = fakes();
  const result = await smoke(values, { kind: "linux-headless", command: "exit 3", drivers, log });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, ["The command exited with 3."]);
  assert.ok("release" in result.timings);
  assert.deepEqual([...proxmox.guests.keys()], [9000]);
});

test("the smoke test stops before acquiring when the settings are wrong or no backend is on", async () => {
  const { proxmox, values, drivers, log } = fakes();
  const wrong = await smoke({ ...values, "proxmox-lxc-subnet": "not a subnet" }, { kind: "linux-headless", command: "true", drivers, log });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems[0] ?? "", /^Proxmox LXC: /);
  const off = await smoke({ ...values, "proxmox-lxc-enabled": false }, { kind: "linux-headless", command: "true", drivers, log });
  assert.deepEqual(off.problems, ["No backend is on. Turn one on in the settings file, for example proxmox-lxc-enabled."]);
  assert.equal(proxmox.calls.length, 0);
});

test("the smoke test reports an unknown kind without making a box", async () => {
  const { proxmox, values, drivers, log } = fakes();
  const result = await smoke(values, { kind: "linux-nope", command: "true", drivers, log });
  assert.equal(result.ok, false);
  assert.equal(result.box, null);
  assert.match(result.problems[0] ?? "", /linux-nope/);
  assert.deepEqual([...proxmox.guests.keys()], [9000]);
});

test("a smoke run first releases what an earlier smoke run left, and leaves other installs' guests alone", async () => {
  const { proxmox, values, drivers, lines, log } = fakes();
  const guest = (vmid: number, tags: string) =>
    proxmox.guests.set(vmid, { vmid, name: `left-${vmid}`, pool: "bbbox", status: "running", template: false, config: { tags } });
  guest(9900, "bb-box;install.smoke;box.box_left;thread.smoke;kind.linux-headless;template.9000");
  guest(9901, "bb-box;install.other;box.box_theirs;thread.thr_x;kind.linux-headless;template.9000");
  const result = await smoke(values, { kind: "linux-headless", command: "true", drivers, log });

  assert.deepEqual(result.problems, []);
  assert.deepEqual([...proxmox.guests.keys()].sort(), [9000, 9901], "the earlier run's box went, and the other install's stayed");
  assert.match(lines.join("\n"), /Releasing a box an earlier smoke run left in Proxmox LXC/);
});

test("the smoke test opens a desktop box's desktop as the relay does", async () => {
  const root = tempDir("smoke-desktop");
  const driver: BackendDriver<Record<string, never>> = {
    type: "fake",
    label: "Fake host",
    nature: "virtual",
    settings: { "fake-enabled": { type: "boolean", label: "Fake host", description: "Use the fake host.", default: false } },
    setup: { guide: "setup/fake/README.md", scripts: [] },
    parse: (values) => (values["fake-enabled"] === true ? { enabled: true, ok: true, config: {} } : { enabled: false }),
    create: (_config, context) => new FakeBackend({ root, storage: context.storage, installId: context.installId }),
  };
  const lines: string[] = [];
  const result = await smoke({ "fake-enabled": true }, { kind: "linux-desktop", command: "true", drivers: [driver], log: (line) => lines.push(line) });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.desktop, { width: 1280, height: 800 }, "the relay's handshake answered the desktop's VNC password");
  assert.ok("desktop" in result.timings);
  assert.match(lines.join("\n"), /The desktop answered: 1280 by 800\./);
});
