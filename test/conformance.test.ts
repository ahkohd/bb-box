// Runs the backend conformance suite against the fake backend, in both
// natures, against the Proxmox LXC backend on a fake Proxmox and fake SSH,
// against the Tart backend on a fake Mac, against the Docker backend on a
// fake Docker host, and against the microsandbox backend on a fake msb host.

import { DockerBackend } from "../src/backends/docker/backend.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { MsbBackend } from "../src/backends/microsandbox/backend.ts";
import { NamespaceBackend } from "../src/backends/namespace/backend.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { TartBackend } from "../src/backends/tart/backend.ts";
import type { CommandTransport } from "../src/transports/types.ts";
import { conformance, type ConformanceBb } from "./conformance/suite.ts";
import { FakeBackend } from "./fake-backend.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { hetznerConfig, hetznerWorld } from "./fake-hetzner-world.ts";
import { fakeMsbHost, msbConfig } from "./fake-msb.ts";
import { FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace } from "./fake-namespace.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_MAC_HELPER, FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

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
  // Its desktops are Wayland's: Apple's sign-in, a resize through the
  // backend and Cua's input in the foreground (048). The real one's are
  // X11's, resized through the stream (021).
  create: (storage, installId) => new FakeBackend({ root, storage, host: virtualHost, installId, id: "fake-virtual", resize: "backend", wayland: true }),
  // The fake numbers its guests g1, g2 and so on from a counter.
  reuse: async (_storage, ref) => virtualHost.set("counter", Number(ref.slice(1)) - 1),
  bb: fakeBb(),
  skip: { size: machineSize },
  timeoutMs: 20_000,
  testDevice: process.platform === "linux",
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
for (const template of [9000, 9001, 9002, 9003, 9004]) proxmox.addTemplate(template);
const config = lxcConfig({
  "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
  "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
  "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b",
  "proxmox-lxc-desktop-cpu-templates": "9003",
  "proxmox-lxc-desktop-wayland-cpu-templates": "9004",
  "proxmox-lxc-ssh-private-key": "",
});
const nodeAvailable = proxmox.memory.available;
const roomOfTheNode: typeof proxmox.fetch = (url, init) => {
  const running = [...proxmox.guests.values()].filter((guest) => guest.status === "running").reduce((sum, guest) => sum + Number(guest.config.memory ?? 0) * 2 ** 20, 0);
  proxmox.memory = { ...proxmox.memory, available: nodeAvailable - running };
  return proxmox.fetch(url, init);
};
const otherRange = lxcConfig({
  "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
  "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
  "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b",
  "proxmox-lxc-desktop-cpu-templates": "9003",
  "proxmox-lxc-desktop-wayland-cpu-templates": "9004",
  "proxmox-lxc-ssh-private-key": "",
  "proxmox-lxc-vmid-first": 9800,
  "proxmox-lxc-vmid-last": 9899,
});

await conformance({
  name: "Proxmox LXC on fakes",
  storage: new MemoryStorage(),
  create: (storage, installId) =>
    new ProxmoxLxcBackend(installId.endsWith("-other") ? otherRange : config, testContext(storage, installId), {
      fetch: roomOfTheNode,
      sleep: async () => {},
      sshBinary: FAKE_SSH_BINARY,
      portCheck: async () => true,
      readyTimeoutMs: 0,
      // The fake SSH runs commands on the test machine, where this is: a Wayland box's image has Selkies (060), and a GPU
      // desktop's encodes with NVENC (#863).
      selkiesLauncher: "/bin/sh",
      gpuVideoMarker: "/bin/sh",
    }),
  // The backend's search for a free VMID starts where its storage says.
  reuse: async (storage, ref) => storage.set("next-vmid", Number(ref)),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    docker: "the fake SSH runs commands on the test machine",
    display: "the fake Proxmox has no desktop to stream",
    "computer-use": "the fake SSH host has no computer-use driver",
    size: "the fake SSH runs commands on the test machine",
    images: "the fake SSH runs commands on the test machine, without root",
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
  create: (storage, installId) => new TartBackend(tart, testContext(storage, installId), { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER, fillQuietMs: 0 }),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    display: "the fake Mac has no VNC server to stream",
    "computer-use": "the fake VM has no computer-use driver",
    "desktop-session": "the fake SSH runs commands on the test machine, which has no launchctl",
    size: "the fake SSH runs commands on the test machine",
    images: "the fake SSH runs commands on the test machine, without root",
  },
  timeoutMs: 20_000,
});

// Again with a warm pool: suspended clones that boxes at the default size take.
const warmMac = fakeSsh().home(FAKE_MAC);
fakeMacTools(warmMac);
addImage(warmMac);
await conformance({
  name: "Tart on a fake Mac with a warm pool",
  storage: new MemoryStorage(),
  create: (storage, installId) =>
    new TartBackend(tart, testContext(storage, installId, { warm: { macos: 1, "macos-desktop": 1 } }), { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER }),
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    display: "the fake Mac has no VNC server to stream",
    "computer-use": "the fake VM has no computer-use driver",
    "desktop-session": "the fake SSH runs commands on the test machine, which has no launchctl",
    size: "the fake SSH runs commands on the test machine",
    images: "the fake SSH runs commands on the test machine, without root",
  },
  timeoutMs: 20_000,
});

// A container's name comes from its box ID, so the Docker backend has no ref to reuse.
const docker = fakeDockerHost();
const dockerSettings = dockerConfig();
await conformance({
  name: "Docker on a fake host",
  storage: new MemoryStorage(),
  create: (storage, installId) => new DockerBackend(dockerSettings, testContext(storage, installId), { binary: docker.binary, readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh" }),
  bb: fakeBb(),
  skip: {
    arch: "the fake docker runs commands on the test machine",
    docker: "the fake docker runs commands on the test machine",
    display: "the fake Docker host has no desktop to stream",
    "computer-use": "the fake container has no computer-use driver",
    size: "the fake docker runs commands on the test machine",
    images: "the fake docker runs commands on the test machine, without root",
  },
  timeoutMs: 20_000,
});

// A Hetzner Cloud backend on a fake API, whose hosts are fake Docker hosts it makes as boxes need them.
const hetzner = hetznerWorld();
await conformance({
  name: "Hetzner Cloud on a fake API and fake Docker hosts",
  storage: new MemoryStorage(),
  create: (storage, installId) => hetzner.backend(hetznerConfig(), storage, installId),
  bb: fakeBb(),
  skip: {
    arch: "the fake docker runs commands on the test machine",
    docker: "the fake docker runs commands on the test machine",
    display: "the fake Docker host has no desktop to stream",
    "computer-use": "the fake container has no computer-use driver",
    size: "the fake docker runs commands on the test machine",
    images: "the Hetzner Cloud backend builds no images yet",
    installs: "each install makes hosts of its own, so one install's box takes no room from the other's; test/hetzner-backend.test.ts checks that they leave each other's boxes alone",
  },
  timeoutMs: 20_000,
});

// A box's microVM is named from its box ID, so the microsandbox backend has no ref to reuse.
const msb = fakeMsbHost();
const msbSettings = msbConfig();
await conformance({
  name: "microsandbox on a fake msb host",
  storage: new MemoryStorage(),
  create: (storage, installId) => new MsbBackend(msbSettings, testContext(storage, installId), { dir: msb.dir, script: msb.script, readyTimeoutMs: 20_000 }),
  bb: fakeBb(),
  skip: {
    arch: "the fake msb runs commands on the test machine",
    docker: "the fake msb runs commands on the test machine",
    display: "the fake msb host has no desktop to stream",
    "computer-use": "the fake microVM has no computer-use driver",
    size: "the fake msb runs commands on the test machine",
    images: "the microsandbox backend builds no images yet",
    keep: "the fake msb host does not list a snapshot taken by the backend alone yet; microsandbox's Keep is checked in its own snapshot tests",
    snapshots: "the fake msb host does not list a snapshot taken by the backend alone yet; microsandbox's restores are checked in its own snapshot tests",
  },
  timeoutMs: 20_000,
});

const namespace = new FakeNamespace({ maxCores: 64 });
const namespaceDockerHosts = new Map<string, DockerCli>();
const namespaceDocker = (instance: string): DockerCli => {
  let cli = namespaceDockerHosts.get(instance);
  if (!cli) {
    cli = new DockerCli(`unix:///run/bb-box/namespace/${instance}.sock`, fakeDockerHost({ name: instance, cpus: 4, memoryMiB: 16 * 1024 }).binary, async () => {});
    namespaceDockerHosts.set(instance, cli);
  }
  return cli;
};
await conformance({
  name: "Namespace on a fake API",
  storage: new MemoryStorage(),
  create: (storage, installId) =>
    new NamespaceBackend(
      { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 4, longestLifeHours: 4, largestMachine: null },
      testContext(storage, installId),
      {
        fetch: namespace.fetch,
        sshBinary: FAKE_SSH_BINARY,
        macHelper: FAKE_MAC_HELPER,
        sleep: async () => {},
        readyTimeoutMs: 20_000,
        desktopScript: "cat >/dev/null",
        cuaScript: ":",
        setupArchive: async () => Buffer.from("setup"),
        linuxImageScript: (target, key) => `cat >/dev/null; echo nscr.io/ws/bbbox/${target}:${key}`,
        linuxPullScript: () => ":",
        dockerCli: namespaceDocker,
        dockerOptions: { readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh" },
      },
    ),
  skip: {
    arch: "the fake ssh and the fake docker run commands on the test machine",
    docker: "the fake docker runs commands on the test machine",
    display: "the fake ssh and the fake Docker host have no desktop to stream",
    "computer-use": "the fake Mac and the fake container have no computer-use driver",
    "desktop-session": "the fake ssh runs commands on the test machine, which has no launchctl",
    size: "the fake ssh and the fake docker run commands on the test machine",
    images: "Namespace's Macs start from its own macOS images, and its Linux boxes from images BB Box builds into the workspace's registry, which test/namespace-linux-images.test.ts checks",
    "exact-size": "Namespace's Macs come only in fixed shapes, so a box gets the smallest with at least its cores and memory",
  },
  timeoutMs: 20_000,
});
