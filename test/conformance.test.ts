// Runs the backend conformance suite against the fake backend, in both
// natures, and against the Proxmox LXC backend on a fake Proxmox and fake SSH.

import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { conformance } from "./conformance/suite.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

const root = tempDir("fake-backend");

await conformance({
  name: "fake virtual backend",
  storage: new MemoryStorage(),
  create: (storage) => new FakeBackend({ root, storage, id: "fake-virtual" }),
  timeoutMs: 20_000,
});

await conformance({
  name: "fake real backend",
  storage: new MemoryStorage(),
  create: (storage) => new FakeBackend({ root, storage, id: "fake-real", nature: "real", machines: 2 }),
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
    new ProxmoxLxcBackend(config, testContext(storage), { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, readyTimeoutMs: 0 }),
  skip: {
    docker: "the fake SSH runs commands on the test machine",
    display: "the fake Proxmox has no desktop to stream",
  },
  timeoutMs: 20_000,
});
