import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addressFor, net0For, normalisePrivateKey, parseLxcSettings } from "../src/backends/proxmox-lxc/config.ts";
import { parseGeneral } from "../src/core/config.ts";
import { VALID, lxcConfig, tempDir } from "./helpers.ts";

test("valid settings parse with defaults", () => {
  const config = lxcConfig();
  assert.equal(config.proxmox.apiUrl, "https://pve.example.com:8006");
  assert.equal(config.proxmox.node, null);
  assert.equal(config.proxmox.pool, "bbbox");
  assert.equal(config.proxmox.tlsFingerprint, null);
  assert.equal(config.ssh.user, "box");
  assert.deepEqual(config.vmids, { first: 9900, last: 9999 });
  assert.equal(config.templates.headless.template, 9000);
  assert.equal(config.templates.headless.diskGiB, null, "the template's disk is kept");
  assert.equal(config.templates.desktop.template, null);
  assert.equal(lxcConfig({ "proxmox-lxc-desktop-template": 9001 }).templates.desktop.template, 9001);
  assert.equal(config.templates.headless.memoryMiB, 4096);
  assert.equal(config.templates.headless.warm, 0);
  assert.deepEqual(config.desktop, { gpuDesktops: null });
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktop-gpu-limit": 3 }).desktop, { gpuDesktops: 3 });
  assert.deepEqual(config.reserve, { memoryMiB: 4096, diskGiB: 50 });
});

test("the setup guide's token file values work as they are", () => {
  const config = lxcConfig({
    "proxmox-lxc-url": "https://192.0.2.10:8006/api2/json",
    "proxmox-lxc-tls-fingerprint": "ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89",
  });
  assert.equal(config.proxmox.apiUrl, "https://192.0.2.10:8006");
  assert.equal(config.proxmox.tlsFingerprint, "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89");
  const hex = lxcConfig({ "proxmox-lxc-tls-fingerprint": `sha256 ${"0f".repeat(32)}` });
  assert.equal(hex.proxmox.tlsFingerprint, Array(32).fill("0F").join(":"));
  const wrong = parseLxcSettings({ ...VALID, "proxmox-lxc-tls-fingerprint": "AB:CD" });
  assert.ok(wrong.enabled && !wrong.ok);
  assert.match(wrong.problems.join(" "), /SHA-256 fingerprint/);
});

test("the network and template defaults match the setup guide's", () => {
  const result = parseLxcSettings({
    "proxmox-lxc-url": "https://192.0.2.10:8006",
    "proxmox-lxc-token-id": "bbbox@pve!plugin",
    "proxmox-lxc-token-secret": "s3cret",
  });
  assert.ok(result.enabled && result.ok, JSON.stringify(result));
  const { config } = result;
  assert.equal(config.templates.headless.template, 9100);
  assert.equal(config.templates.desktop.template, null);
  assert.equal(config.network.bridge, "vmbr200");
  assert.equal(config.network.gateway, "10.200.0.1");
  assert.equal(addressFor(config, 9900), "10.200.0.10");
  assert.equal(addressFor(config, 9999), "10.200.0.109");
  assert.equal(net0For(config, 9900), "name=eth0,bridge=vmbr200,ip=10.200.0.10/24,gw=10.200.0.1,type=veth");
});

test("the backend can be switched off", () => {
  assert.deepEqual(parseLxcSettings({ "proxmox-lxc-enabled": false }), { enabled: false });
});

test("each VMID has a fixed static address", () => {
  const config = lxcConfig();
  assert.equal(addressFor(config, 9900), "192.0.2.100");
  assert.equal(addressFor(config, 9999), "192.0.2.199");
  assert.equal(addressFor(config, 10000), null);
  assert.equal(net0For(config, 9905), "name=eth0,bridge=vmbr1,ip=192.0.2.105/24,gw=192.0.2.1,type=veth");
});

test("without a range, every subnet host but the gateway is used", () => {
  const config = lxcConfig({ "proxmox-lxc-addresses": "", "proxmox-lxc-subnet": "192.0.2.0/25", "proxmox-lxc-vmid-first": 100, "proxmox-lxc-vmid-last": 224 });
  assert.equal(addressFor(config, 100), "192.0.2.2");
  assert.equal(addressFor(config, 224), "192.0.2.126");
});

test("too few addresses for the VMID range is a problem", () => {
  const result = parseLxcSettings({ ...VALID, "proxmox-lxc-addresses": "192.0.2.100-192.0.2.109" });
  assert.ok(result.enabled && !result.ok);
  assert.match(result.problems.join(" "), /10 addresses for 100 VMIDs/);
});

test("missing settings are listed without echoing the secret", () => {
  const result = parseLxcSettings({ "proxmox-lxc-token-secret": "do-not-show", "proxmox-lxc-headless-template": 0, "proxmox-lxc-bridge": "" });
  assert.ok(result.enabled && !result.ok);
  const problems = result.problems.join(" ");
  assert.match(problems, /Proxmox API URL/);
  assert.match(problems, /token ID/);
  assert.match(problems, /template/);
  assert.match(problems, /bridge/);
  assert.doesNotMatch(problems, /do-not-show/);
});

test("a template inside the box range is refused", () => {
  const result = parseLxcSettings({ ...VALID, "proxmox-lxc-headless-template": 9905 });
  assert.ok(result.enabled && !result.ok);
});

test("the SSH key is optional and survives a one-line paste or base64", () => {
  assert.equal(lxcConfig({ "proxmox-lxc-ssh-private-key": "" }).ssh.privateKey, null);
  const dir = tempDir("key");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, "k")]);
  const key = readFileSync(join(dir, "k"), "utf8");
  assert.equal(normalisePrivateKey(key), key);
  assert.equal(normalisePrivateKey(key.replaceAll("\n", " ")), key);
  assert.equal(normalisePrivateKey(Buffer.from(key).toString("base64")), key);
  assert.equal(normalisePrivateKey("not a key"), null);
});

test("general settings: no per-thread limit unless set", () => {
  assert.deepEqual(parseGeneral({}), { ok: true, config: { perThreadLimit: null, enrol: true } });
  assert.deepEqual(parseGeneral({ "boxes-per-thread": 3, "enrol-boxes": false }), { ok: true, config: { perThreadLimit: 3, enrol: false } });
  assert.equal(parseGeneral({ "boxes-per-thread": -1 }).ok, false);
});
