import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { toConfiguration } from "../scripts/smoke.ts";
import { DockerBackend, dockerKinds } from "../src/backends/docker/backend.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import { parseHetznerPart } from "../src/backends/hetzner/config.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { LXC_KEYS } from "../src/backends/proxmox-lxc/config.ts";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { VOXL_PORT } from "../src/backends/voxl.ts";
import type { BoxIdentity, FieldValue, Guest } from "../src/backends/types.ts";
import { backendPart } from "../src/core/document.ts";
import { videoStreams } from "../src/plugin/desktop.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { lxcConfig, testContext } from "./helpers.ts";

const signal = () => AbortSignal.timeout(20_000);
const DESKTOP = { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "none" } as const;

function dockerPart(fields: Record<string, unknown> = {}) {
  const configuration = toConfiguration({ backends: [{ id: "docker", type: "docker", enabled: true, fields }] });
  assert.deepEqual(configuration.problems, []);
  const parsed = dockerDriver.parse(backendPart(configuration.document.backends[0]!, dockerDriver, configuration.secrets));
  assert.ok(parsed.ok);
  return parsed.config;
}

let counter = 0;
function identity(kind: string): BoxIdentity {
  counter++;
  return { boxId: `bxvoxl${String(counter).padStart(8, "0")}`, threadId: "thr_voxl01", name: `calm-voxl-${counter}`, kind, createdAt: 1_790_000_000_000, size: DESKTOP };
}

const hooks = { claim: async () => undefined, starting: async () => undefined, timing: () => undefined };

test("Docker's voxl setting is off unless set: its desktops then offer voxl by choice, and with it on voxl opens first", () => {
  assert.equal(dockerDriver.fields.voxl?.default, false);
  assert.equal(dockerDriver.fields.voxl?.type, "boolean");
  assert.equal(dockerPart().voxl, "offered");
  assert.equal(dockerPart({ voxl: true }).voxl, "chosen");
  assert.equal(dockerPart({ voxl: false }).voxl, "offered");
});

test("Hetzner, which runs Docker's images, offers no voxl until its own unit", () => {
  const hetzner = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token: "a".repeat(64) } });
  assert.ok(hetzner.ok);
  assert.equal(hetzner.config.docker.voxl, "off");
  const kinds = dockerKinds(hetzner.config.docker);
  assert.ok(kinds.every((kind) => kind.capabilities.displays.every((display) => display.protocol !== "voxl")));
});

test("Docker's X11 desktops list voxl after their other streams, by choice; Linux and the Wayland desktop do not", () => {
  const kinds = dockerKinds(dockerPart({ "gpu-desktops": true }));
  const voxl = (id: string) => kinds.find((kind) => kind.id === id)!.capabilities.displays.map((display) => [display.protocol, display.byChoice ?? false]);
  assert.deepEqual(voxl("linux-desktop-cpu"), [["rfb", false], ["selkies", false], ["voxl", true]]);
  assert.deepEqual(voxl("linux-desktop"), [["rfb", false], ["voxl", true]]);
  assert.deepEqual(voxl("linux-desktop-wayland-cpu"), [["rfb", false], ["selkies", false]]);
  assert.deepEqual(voxl("linux"), []);
});

test("Proxmox LXC's voxl setting, and its X11 desktops' voxl stream", async () => {
  assert.equal(proxmoxLxcDriver.fields.voxl?.default, false);
  assert.equal(proxmoxLxcDriver.fields.voxl?.type, "boolean");
  assert.equal(proxmoxLxcDriver.fields.voxl?.group, "boxes");
  assert.equal(proxmoxLxcDriver.fields.voxl?.label, "Stream desktops with voxl");
  assert.equal(lxcConfig().desktop.voxl, "offered");
  assert.equal(lxcConfig({ [LXC_KEYS.voxl]: true }).desktop.voxl, "chosen");
  const lxc = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-desktop-templates": "9001 gpu-a", "proxmox-lxc-desktop-cpu-templates": "9003", "proxmox-lxc-desktop-wayland-cpu-templates": "9004" }),
    testContext(),
  );
  try {
    const protocols = (id: string) => lxc.kinds().find((kind) => kind.id === id)!.capabilities.displays.map((display) => display.protocol);
    assert.deepEqual(protocols("linux-desktop-cpu"), ["rfb", "selkies", "voxl"]);
    assert.deepEqual(protocols("linux-desktop"), ["rfb", "selkies", "voxl"]);
    assert.deepEqual(protocols("linux-desktop-wayland-cpu"), ["rfb", "selkies"]);
  } finally {
    await lxc.dispose();
  }
});

function dockerBackend(fields: Record<string, FieldValue>) {
  const fake = fakeDockerHost();
  const config = dockerConfig({ voxl: false, ...fields });
  return { fake, backend: new DockerBackend(config, testContext(), { binary: fake.binary, readyTimeoutMs: 2_000 }) };
}

function giveLauncher(root: string, guest: Guest, script: string): string {
  const launcher = join(root, "containers", guest.ref, "libexec", "bb-box", "voxl");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, script);
  chmodSync(launcher, 0o755);
  return launcher;
}

test("a Docker desktop from an image without voxl has no voxl stream; with it, voxl starts as its stream opens, and is reached on its port", async () => {
  const { fake, backend } = dockerBackend({});
  try {
    const old = await backend.acquire(identity("linux-desktop-cpu"), null, hooks, signal());
    assert.deepEqual((await backend.transports(old, "linux-desktop-cpu")).displays.map((display) => display.protocol), ["rfb", "selkies"]);

    const box = await backend.acquire(identity("linux-desktop-cpu"), null, hooks, signal());
    const log = join(fake.root, "containers", box.ref, "voxl.log");
    giveLauncher(fake.root, box, `#!/bin/sh\necho "$*" >>"${log}"\n`);
    const shown = (await backend.transports(box, "linux-desktop-cpu")).displays;
    assert.deepEqual(shown.map((display) => display.protocol), ["rfb", "selkies", "voxl"]);
    const voxl = shown.find((display) => display.protocol === "voxl")!;
    assert.equal(voxl.opensFirst, false);
    assert.equal(voxl.resizable, true);
    const opened = await voxl.open(signal());
    assert.equal(readFileSync(log, "utf8"), "start\n");
    assert.deepEqual(opened.auth, { type: "none" });
    assert.equal(opened.route.type, "command");
    assert.deepEqual(opened.route.type === "command" ? opened.route.argv.slice(-3) : [], ["socat", "-", `TCP:127.0.0.1:${VOXL_PORT}`]);

    const failing = await backend.acquire(identity("linux-desktop-cpu"), null, hooks, signal());
    giveLauncher(fake.root, failing, "#!/bin/sh\necho 'voxl did not answer on 127.0.0.1:5981 within 20 s: no display' >&2\nexit 1\n");
    const refused = (await backend.transports(failing, "linux-desktop-cpu")).displays.find((display) => display.protocol === "voxl")!;
    await assert.rejects(refused.open(signal()), /The box's voxl did not start: voxl did not answer on 127\.0\.0\.1:5981 within 20 s: no display/);
  } finally {
    await backend.dispose?.();
  }
});

test("with Docker's voxl setting on, the voxl stream says it opens first", async () => {
  const { fake, backend } = dockerBackend({ voxl: true });
  try {
    const box = await backend.acquire(identity("linux-desktop-cpu"), null, hooks, signal());
    giveLauncher(fake.root, box, "#!/bin/sh\n");
    const voxl = (await backend.transports(box, "linux-desktop-cpu")).displays.find((display) => display.protocol === "voxl");
    assert.equal(voxl?.opensFirst, true);
  } finally {
    await backend.dispose?.();
  }
});

test("the viewer's video streams, in the order it opens them: voxl first only when its backend chose it", () => {
  assert.deepEqual(videoStreams(true, null), ["selkies"]);
  assert.deepEqual(videoStreams(true, "offered"), ["selkies", "voxl"]);
  assert.deepEqual(videoStreams(true, "chosen"), ["voxl", "selkies"]);
  assert.deepEqual(videoStreams(false, "offered"), ["voxl"]);
  assert.deepEqual(videoStreams(false, null), []);
});
