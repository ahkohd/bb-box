import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LXC_SETTINGS, addressFor, earlierLxcSizes, net0For, parseLxcSettings } from "../src/backends/proxmox-lxc/config.ts";
import { normalisePrivateKey } from "../src/transports/ssh.ts";
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
  assert.deepEqual(config.flavours.linux, { templates: [{ vmid: 9000, gpu: null }], warm: 0 });
  assert.deepEqual(config.flavours.desktop.templates, []);
  assert.deepEqual(config.flavours["desktop-cpu"].templates, []);
  assert.deepEqual(config.desktop, { perGpu: null });
  assert.deepEqual(lxcConfig({ "proxmox-lxc-desktops-per-gpu": 3 }).desktop, { perGpu: 3 });
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
  assert.deepEqual(config.flavours.linux.templates, [{ vmid: 9100, gpu: null }]);
  assert.deepEqual(config.flavours.desktop.templates, []);
  assert.equal(config.network.bridge, "vmbr200");
  assert.equal(config.network.gateway, "10.200.0.1");
  assert.equal(addressFor(config, 9900), "10.200.0.10");
  assert.equal(addressFor(config, 9999), "10.200.0.109");
  assert.equal(net0For(config, 9900), "name=eth0,bridge=vmbr200,ip=10.200.0.10/24,gw=10.200.0.1,type=veth");
});

test("each flavour takes a list of templates, and GPU desktop templates name their GPU", () => {
  const config = lxcConfig({
    "proxmox-lxc-linux-templates": "9000, 9004",
    "proxmox-lxc-desktop-templates": "9001 GPU-0a1b2c3d\n9002=GPU-4e5f6a7b\n9005 GPU-0a1b2c3d",
    "proxmox-lxc-desktop-cpu-templates": "9003",
  });
  assert.deepEqual(config.flavours.linux.templates, [
    { vmid: 9000, gpu: null },
    { vmid: 9004, gpu: null },
  ]);
  assert.deepEqual(config.flavours.desktop.templates, [
    { vmid: 9001, gpu: "GPU-0a1b2c3d" },
    { vmid: 9002, gpu: "GPU-4e5f6a7b" },
    { vmid: 9005, gpu: "GPU-0a1b2c3d" },
  ]);
  assert.deepEqual(config.flavours["desktop-cpu"].templates, [{ vmid: 9003, gpu: null }]);
  assert.deepEqual(lxcConfig({ "proxmox-lxc-linux-templates": 9000 }).flavours.linux.templates, [{ vmid: 9000, gpu: null }]);
  const desktopsOnly = lxcConfig({ "proxmox-lxc-linux-templates": "", "proxmox-lxc-desktop-cpu-templates": "9003" });
  assert.deepEqual(desktopsOnly.flavours.linux.templates, []);
});

test("an unset Linux setting reads its key from before 027, and a set one wins", () => {
  const { "proxmox-lxc-linux-templates": _, ...unset } = VALID;
  const linux = (values: Record<string, unknown>) => {
    const result = parseLxcSettings({ ...unset, "proxmox-lxc-desktop-cpu-templates": "9003", ...values });
    assert.ok(result.enabled && result.ok, JSON.stringify(values));
    return result.config.flavours.linux;
  };
  const earlier = {
    "proxmox-lxc-headless-templates": "9010 9011",
    "proxmox-lxc-headless-cores": 6,
    "proxmox-lxc-headless-memory-mib": 6144,
    "proxmox-lxc-headless-disk-gib": 20,
    "proxmox-lxc-headless-warm": 2,
  };
  assert.deepEqual(linux(earlier), { templates: [{ vmid: 9010, gpu: null }, { vmid: 9011, gpu: null }], warm: 2 });
  const both = linux({ ...earlier, "proxmox-lxc-linux-templates": "9020", "proxmox-lxc-linux-warm": 0 });
  assert.deepEqual(both.templates, [{ vmid: 9020, gpu: null }]);
  assert.equal(both.warm, 0, "a new key set to 0 is set");
  assert.equal(linux({ ...earlier, "proxmox-lxc-linux-warm": null }).warm, 2, "a cleared key is unset");
  assert.equal(linux({ ...earlier, "proxmox-lxc-linux-templates": "9020" }).warm, 2, "each key falls back on its own");
  assert.deepEqual(linux({ ...earlier, "proxmox-lxc-linux-templates": "" }).templates, [], "an empty list is set, and turns the kinds off");
  assert.deepEqual(linux({}), { templates: [{ vmid: 9100, gpu: null }], warm: 0 });

  // BB gives a declared default in place of an unset value, so the new keys declare none, and the old keys stay declared.
  for (const field of ["templates", "warm"]) {
    const current = LXC_SETTINGS[`proxmox-lxc-linux-${field}`]!;
    const replaced = LXC_SETTINGS[`proxmox-lxc-headless-${field}`]!;
    assert.ok(!("default" in current), field);
    assert.ok(!("default" in replaced), field);
    assert.match(replaced.label, /\(replaced\)$/);
    assert.match(replaced.description ?? "", new RegExp(`Replaced by proxmox-lxc-linux-${field}`));
  }
  // The size keys, current and earlier, were replaced by box sizes (028).
  for (const key of ["proxmox-lxc-linux-cores", "proxmox-lxc-headless-memory-mib", "proxmox-lxc-desktop-disk-gib", "proxmox-lxc-desktop-cpu-cores"]) {
    const replaced = LXC_SETTINGS[key]!;
    assert.ok(!("default" in replaced), key);
    assert.match(replaced.label, /\(replaced\)$/, key);
    assert.match(replaced.description ?? "", /^Replaced by Box sizes, which took a saved value once as the default size of (linux and linux-docker|linux-desktop|linux-desktop-cpu) boxes\. Changing it does nothing\.$/, key);
  }
});

test("template lists with mistakes are refused", () => {
  const problems = (values: Record<string, unknown>) => {
    const result = parseLxcSettings({ ...VALID, ...values });
    assert.ok(result.enabled && !result.ok, JSON.stringify(values));
    return result.problems.join(" ");
  };
  assert.match(problems({ "proxmox-lxc-desktop-templates": "9001" }), /Give GPU desktop template 9001 the ID of its GPU/);
  assert.match(problems({ "proxmox-lxc-desktop-templates": "9001 GPU-a extra" }), /one line per GPU desktop template/);
  assert.match(problems({ "proxmox-lxc-desktop-cpu-templates": "9001 9001" }), /Template 9001 is listed more than once/);
  assert.match(problems({ "proxmox-lxc-desktop-cpu-templates": "9000" }), /Template 9000 is listed more than once/);
  assert.match(problems({ "proxmox-lxc-linux-templates": "ninety" }), /VMIDs from 100 for the Linux templates/);
  assert.match(problems({ "proxmox-lxc-linux-templates": "" }), /at least one CT template/);
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
  const result = parseLxcSettings({ "proxmox-lxc-token-secret": "do-not-show", "proxmox-lxc-linux-templates": "", "proxmox-lxc-bridge": "" });
  assert.ok(result.enabled && !result.ok);
  const problems = result.problems.join(" ");
  assert.match(problems, /Proxmox API URL/);
  assert.match(problems, /token ID/);
  assert.match(problems, /template/);
  assert.match(problems, /bridge/);
  assert.doesNotMatch(problems, /do-not-show/);
});

test("a template inside the box range is refused", () => {
  const result = parseLxcSettings({ ...VALID, "proxmox-lxc-desktop-cpu-templates": "9905" });
  assert.ok(result.enabled && !result.ok);
  assert.match(result.problems.join(" "), /Move template 9905 out of the box VMID range/);
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
  assert.deepEqual(parseGeneral({}), { config: { perThreadLimit: null, enrol: true, sizes: {} }, problems: [] });
  assert.deepEqual(parseGeneral({ "boxes-per-thread": 3, "enrol-boxes": false }), { config: { perThreadLimit: 3, enrol: false, sizes: {} }, problems: [] });
  assert.deepEqual(parseGeneral({ "boxes-per-thread": -1 }), {
    config: { perThreadLimit: null, enrol: true, sizes: {} },
    problems: ["Use a whole number of boxes per thread, or 0 for no limit."],
  });
});

test("general settings: box sizes, where a mistake keeps the shipped sizes and is a problem", () => {
  const sizes = parseGeneral({ "box-sizes": '{"linux":{"default":"medium"}}' });
  assert.deepEqual(sizes, { config: { perThreadLimit: null, enrol: true, sizes: { linux: { default: "medium" } } }, problems: [] });
  const wrong = parseGeneral({ "boxes-per-thread": 2, "box-sizes": '{"linux":{"default":"huge"}}' });
  assert.deepEqual(wrong.config, { perThreadLimit: 2, enrol: true, sizes: {} });
  assert.deepEqual(wrong.problems, ["linux.default must be small, medium or large."]);
});

test("the size keys saved before 028 give each kind's earlier size", () => {
  assert.deepEqual(earlierLxcSizes({}), {}, "nothing saved, nothing to carry over");
  assert.deepEqual(earlierLxcSizes({ "proxmox-lxc-linux-templates": "9000", "proxmox-lxc-linux-warm": 2 }), {}, "only the size keys count");
  const six = { cores: 6, memoryMiB: 4096, diskGiB: 20 };
  assert.deepEqual(earlierLxcSizes({ "proxmox-lxc-linux-cores": 6, "proxmox-lxc-linux-disk-gib": 20 }), { linux: six, "linux-docker": six });
  assert.deepEqual(earlierLxcSizes({ "proxmox-lxc-headless-cores": 6, "proxmox-lxc-headless-disk-gib": 20 }), { linux: six, "linux-docker": six }, "under the keys from before 027 too");
  assert.deepEqual(
    earlierLxcSizes({ "proxmox-lxc-desktop-memory-mib": 16384, "proxmox-lxc-desktop-cpu-disk-gib": 0 }),
    {
      "linux-desktop": { cores: 4, memoryMiB: 16384, diskGiB: null },
      "linux-desktop-cpu": { cores: 4, memoryMiB: 8192, diskGiB: null },
    },
    "a disk of 0 is the template's",
  );
  assert.deepEqual(earlierLxcSizes({ "proxmox-lxc-linux-cores": 0 }), {}, "a size out of range is not carried over");
});
