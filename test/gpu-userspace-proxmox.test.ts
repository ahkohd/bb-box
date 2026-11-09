import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Bridge, desktop } from "./gpu-helper/bridge.ts";
import { CARD_A, REPORT_VMID, marker } from "./gpu-helper/node.ts";
import { fakeSsh } from "./helpers.ts";

test("071 unit 12: Proxmox LXC gives linux and linux-desktop boxes the host's driver as its GPU helper reports it now, and no host for a kind it does not offer", async () => {
  const bridge = new Bridge();
  bridge.helper();
  const backend = bridge.backend();
  assert.deepEqual(await backend.nvidiaHost("linux"), { driver: "580.142", refused: null });
  assert.deepEqual(await backend.nvidiaHost("linux-desktop"), { driver: "580.142", refused: null });
  assert.equal(await backend.nvidiaHost("macos"), null);

  bridge.node.write("sys/module/nvidia/version", "590.10\n");
  bridge.helper();
  assert.deepEqual(await backend.nvidiaHost("linux"), { driver: "590.10", refused: null }, "read again, not remembered");
});

test("071 unit 12: Proxmox LXC says why it cannot tell the host's driver: a helper that is not reporting, or no helper and no box that saw the driver", async () => {
  const bridge = new Bridge();
  bridge.guest(7001, desktop("bx7001", "amber-fox", CARD_A, { marker: marker("shared", CARD_A, 1), running: true }));
  bridge.helper();
  const backend = bridge.backend();
  bridge.proxmox.guests.get(REPORT_VMID)!.config.description = "";
  const blocked = await backend.nvidiaHost("linux");
  assert.equal(blocked?.driver, null);
  assert.match(blocked?.refused?.why ?? "", /^The GPU helper on pve is not reporting: VM \d+'s report has no helper line/);
  assert.match(blocked?.refused?.fix ?? "", /^Try again in a minute\./);

  const none = new Bridge();
  const plain = none.backend();
  assert.deepEqual(await plain.nvidiaHost("linux"), {
    driver: null,
    refused: { why: "BB Box cannot tell the NVIDIA driver on pve: it has no GPU helper, and no running box of this install there showed the driver.", fix: "Set up the helper with host/setup-gpu.sh, as root on pve, or start a box there." },
  });
});

test("071 unit 12: with no helper, Proxmox LXC reads the host's driver from a running box of the install each time, never from what a desktop saw at an earlier start", async () => {
  const ssh = fakeSsh();
  const bridge = new Bridge();
  bridge.guest(7001, { box: "bx7001", name: "amber-fox", kind: "linux", running: true });
  const backend = bridge.backend();
  const driver = (version: string) => {
    mkdirSync(join(ssh.home("192.0.2.101"), "sys", "module", "nvidia"), { recursive: true });
    writeFileSync(join(ssh.home("192.0.2.101"), "sys", "module", "nvidia", "version"), `${version}\n`);
  };
  driver("580.142");
  assert.deepEqual(await backend.nvidiaHost("linux"), { driver: "580.142", refused: null });
  driver("590.10");
  assert.deepEqual(await backend.nvidiaHost("linux"), { driver: "590.10", refused: null }, "the host's driver changed, and it is read again");
  assert.ok(ssh.log().some((entry) => entry.command.includes("cat /sys/module/nvidia/version")));
});
