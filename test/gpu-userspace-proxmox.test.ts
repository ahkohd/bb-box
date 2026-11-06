import assert from "node:assert/strict";
import { test } from "node:test";
import { Bridge, desktop } from "./gpu-helper/bridge.ts";
import { CARD_A, REPORT_VMID, marker } from "./gpu-helper/node.ts";

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
    refused: { why: "bb-box does not know the NVIDIA driver on pve: it has no GPU helper, and no GPU desktop there has seen the driver yet.", fix: "Set up the helper with host/setup-gpu.sh, as root on pve." },
  });
});
