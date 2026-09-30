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
  assert.equal(config.proxmox.pool, "bb-box");
  assert.equal(config.ssh.user, "box");
  assert.deepEqual(config.vmids, { first: 7000, last: 7099 });
  assert.equal(config.templates.headless.template, 9000);
  assert.equal(config.templates.desktop.template, null);
  assert.equal(lxcConfig({ "proxmox-lxc-desktop-template": 9001 }).templates.desktop.template, 9001);
  assert.equal(config.templates.headless.memoryMiB, 4096);
  assert.equal(config.templates.headless.warm, 0);
  assert.deepEqual(config.desktop, { vncPassword: null, gpuDesktops: null });
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktop-vnc-password": "secret", "proxmox-lxc-desktop-gpu-limit": 3 }).desktop, {
    vncPassword: "secret",
    gpuDesktops: 3,
  });
  assert.deepEqual(config.reserve, { memoryMiB: 4096, diskGiB: 50 });
});

test("the backend can be switched off", () => {
  assert.deepEqual(parseLxcSettings({ "proxmox-lxc-enabled": false }), { enabled: false });
});

test("each VMID has a fixed static address", () => {
  const config = lxcConfig();
  assert.equal(addressFor(config, 7000), "192.0.2.100");
  assert.equal(addressFor(config, 7099), "192.0.2.199");
  assert.equal(addressFor(config, 7100), null);
  assert.equal(net0For(config, 7005), "name=eth0,bridge=vmbr1,ip=192.0.2.105/24,gw=192.0.2.1,type=veth");
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
  const result = parseLxcSettings({ "proxmox-lxc-token-secret": "do-not-show" });
  assert.ok(result.enabled && !result.ok);
  const problems = result.problems.join(" ");
  assert.match(problems, /Proxmox API URL/);
  assert.match(problems, /template/);
  assert.match(problems, /bridge/);
  assert.doesNotMatch(problems, /do-not-show/);
});

test("a template inside the box range is refused", () => {
  const result = parseLxcSettings({ ...VALID, "proxmox-lxc-headless-template": 7005 });
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
