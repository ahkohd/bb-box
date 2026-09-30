// Runs the backend conformance suite against the fake backend, in both
// natures, and against the Proxmox LXC backend on a fake Proxmox and fake SSH.

import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import type { CommandTransport } from "../src/transports/types.ts";
import { conformance, type ConformanceBb } from "./conformance/suite.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

const root = tempDir("fake-backend");

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

await conformance({
  name: "fake virtual backend",
  storage: new MemoryStorage(),
  create: (storage) => new FakeBackend({ root, storage, id: "fake-virtual" }),
  bb: fakeBb(),
  timeoutMs: 20_000,
});

await conformance({
  name: "fake real backend",
  storage: new MemoryStorage(),
  create: (storage) => new FakeBackend({ root, storage, id: "fake-real", nature: "real", machines: 2 }),
  bb: fakeBb(),
  timeoutMs: 20_000,
});

fakeSsh();
const proxmox = new FakeProxmox();
proxmox.addTemplate(9000);
proxmox.addTemplate(9001);
const config = lxcConfig({
  "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
  "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
  "proxmox-lxc-desktop-template": 9001,
  "proxmox-lxc-ssh-private-key": "",
});

await conformance({
  name: "Proxmox LXC on fakes",
  storage: new MemoryStorage(),
  create: (storage) =>
    new ProxmoxLxcBackend(config, testContext(storage), {
      fetch: proxmox.fetch,
      sleep: async () => {},
      sshBinary: FAKE_SSH_BINARY,
      portCheck: async () => true,
      readyTimeoutMs: 0,
    }),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    docker: "the fake SSH runs commands on the test machine",
    display: "the fake Proxmox has no desktop to stream",
  },
  timeoutMs: 20_000,
});
