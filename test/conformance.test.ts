// Runs the backend conformance suite against the fake backend, in both
// natures, against the Proxmox LXC backend on a fake Proxmox and fake SSH,
// and against the Tart backend on a fake Mac.

import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { TartBackend } from "../src/backends/tart/backend.ts";
import type { CommandTransport } from "../src/transports/types.ts";
import { conformance, type ConformanceBb } from "./conformance/suite.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

const root = tempDir("fake-backend");
const machineSize = "the fake box is a directory on the test machine, so it has the machine's cores and memory";

/** Stands in for BB: a box is connected while it answers, once bootstrap has run in it. */
function fakeBb(): ConformanceBb {
  const daemons = new Map<string, CommandTransport>();
  return {
    enrol: async (box, command) => {
      const result = await command.run("true");
      if (result.exitCode !== 0) throw new Error(`bootstrap failed: ${result.stderr}`);
      daemons.set(box.boxId, command);
    },
    connected: async (box) => (await daemons.get(box.boxId)?.probe()) ?? false,
  };
}

// Each fake keeps its guests in a host storage of its own, which every install on it shares.
const virtualHost = new MemoryStorage();
await conformance({
  name: "fake virtual backend",
  storage: new MemoryStorage(),
  // Its desktops resize through the backend, as a GPU desktop does; the real one's through the stream (021).
  create: (storage, installId) => new FakeBackend({ root, storage, host: virtualHost, installId, id: "fake-virtual", resize: "backend" }),
  // The fake numbers its guests g1, g2 and so on from a counter.
  reuse: async (_storage, ref) => virtualHost.set("counter", Number(ref.slice(1)) - 1),
  bb: fakeBb(),
  skip: { size: machineSize },
  timeoutMs: 20_000,
});

const realHost = new MemoryStorage();
await conformance({
  name: "fake real backend",
  storage: new MemoryStorage(),
  create: (storage, installId) => new FakeBackend({ root, storage, host: realHost, installId, id: "fake-real", nature: "real", machines: 2 }),
  bb: fakeBb(),
  skip: { size: machineSize },
  timeoutMs: 20_000,
});

fakeSsh();
const proxmox = new FakeProxmox();
for (const template of [9000, 9001, 9002, 9003]) proxmox.addTemplate(template);
const config = lxcConfig({
  "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
  "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
  "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b",
  "proxmox-lxc-desktop-cpu-templates": "9003",
  "proxmox-lxc-ssh-private-key": "",
});

await conformance({
  name: "Proxmox LXC on fakes",
  storage: new MemoryStorage(),
  create: (storage, installId) =>
    new ProxmoxLxcBackend(config, testContext(storage, installId), {
      fetch: proxmox.fetch,
      sleep: async () => {},
      sshBinary: FAKE_SSH_BINARY,
      portCheck: async () => true,
      readyTimeoutMs: 0,
    }),
  // The backend's search for a free VMID starts where its storage says.
  reuse: async (storage, ref) => storage.set("next-vmid", Number(ref)),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    docker: "the fake SSH runs commands on the test machine",
    display: "the fake Proxmox has no desktop to stream",
    "computer-use": "the fake SSH host has no computer-use driver",
    size: "the fake SSH runs commands on the test machine",
  },
  timeoutMs: 20_000,
});

// A fresh fake ssh for the fake Mac, whose VMs answer as hosts of their own.
const mac = fakeSsh().home(FAKE_MAC);
fakeMacTools(mac);
addImage(mac);
const tart = tartConfig();
await conformance({
  name: "Tart on a fake Mac",
  storage: new MemoryStorage(),
  create: (storage, installId) => new TartBackend(tart, testContext(storage, installId), { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 }),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    display: "the fake Mac has no VNC server to stream",
    "computer-use": "the fake VM has no computer-use driver",
  },
  timeoutMs: 20_000,
});
