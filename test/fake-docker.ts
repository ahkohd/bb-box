// A fake Docker host for the Docker backend's tests: the fake docker CLI
// (fake-docker.mjs) with a daemon's state of its own, which has the images
// setup/docker/build.sh makes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDockerPart, type DockerConfig } from "../src/backends/docker/config.ts";
import type { FieldValue } from "../src/backends/types.ts";
import { fakeGroup, tempDir } from "./helpers.ts";

/** A container as the fake's `docker container inspect` prints it. */
export interface FakeContainer {
  readonly Id: string;
  readonly Image: string;
  readonly Name: string;
  readonly State: { readonly Status: string; readonly ExitCode: number; readonly Paused?: boolean };
  readonly Config: { readonly Hostname: string; readonly Image: string; readonly Labels: Record<string, string>; readonly Env: string[]; readonly Cmd: string[] };
  readonly HostConfig: {
    readonly NanoCpus: number;
    readonly CpusetCpus: string;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly ShmSize: number;
    readonly Privileged: boolean;
    readonly Init: boolean;
    readonly RestartPolicy: { readonly Name: string };
    readonly Devices: string[];
    readonly Mounts: { readonly Type: string; readonly Name?: string; readonly Source: string; readonly Target: string; readonly ReadOnly: boolean }[];
  };
  readonly NetworkSettings: { readonly Networks: Readonly<Record<string, { readonly IPAddress: string }>> };
}

export interface FakeDockerHost {
  readonly root: string;
  /** A docker CLI for this host alone. */
  readonly binary: string;
  /** Changes what `docker info` says, or its switches: down, failStart, neverReady. */
  set(values: Record<string, unknown>): void;
  /** Every docker call so far, without -H. */
  calls(): string[][];
  /** The names of the containers on the host. */
  containers(): string[];
  inspect(name: string): FakeContainer;
  writeVolumeFiles(name: string, files: Readonly<Record<string, string>>): void;
  volumeFiles(name: string): Readonly<Record<string, string>>;
  /** The box user's home in a container. */
  home(name: string): string;
  withIdentityReset(image: string, version?: number): void;
  identityRoot(name: string): string;
  servicesStarted(name: string): readonly number[];
  withoutForkHold(image: string): void;
}

const IDENTITY_SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-identity.sh", import.meta.url));
const IMAGE_MACHINE_ID = "0123456789abcdef0123456789abcdef";
const IMAGE_HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIimagekey image";

function identityAtVersion(version: number): string {
  return readFileSync(IDENTITY_SCRIPT, "utf8").replace(/^readonly VERSION=\d+$/m, `readonly VERSION=${version}`);
}

function writeIn(root: string, path: string, text: string, mode?: number): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, mode === undefined ? undefined : { mode });
}

function imageWithIdentityReset(root: string, version: number): void {
  writeIn(root, "usr/local/sbin/bb-box-identity", identityAtVersion(version), 0o755);
  writeIn(root, "etc/machine-id", `${IMAGE_MACHINE_ID}\n`);
  writeIn(root, "etc/ssh/ssh_host_ed25519_key", "private\n");
  writeIn(root, "etc/ssh/ssh_host_ed25519_key.pub", `${IMAGE_HOST_KEY}\n`);
  const enabled = spawnSync("bash", [join(root, "usr/local/sbin/bb-box-identity"), "enable", "--no-unit"], { env: { ...process.env, BBBOX_IDENTITY_ROOT: root }, encoding: "utf8" });
  assert.equal(enabled.status, 0, `the image's build turned the reset on: ${enabled.stderr}`);
}

function fakeIdentityTools(bin: string): void {
  mkdirSync(bin, { recursive: true });
  const ip = `#!/bin/sh\nif [ "$1" = -o ]; then for address in $FAKE_ADDRESS $FAKE_ALSO_HOLDS; do printf '2: eth0    inet %s/16 scope global eth0\\n' "$address"; done; exit 0; fi\necho '[]'\n`;
  writeFileSync(join(bin, "ip"), ip, { mode: 0o755 });
}

export function fakeDockerHost(host: Record<string, unknown> = {}): FakeDockerHost {
  const root = tempDir("fake-docker");
  fakeGroup();
  const binary = join(root, "docker");
  const script = new URL("./fake-docker.mjs", import.meta.url).pathname;
  writeFileSync(binary, `#!/bin/sh\nFAKE_DOCKER_ROOT='${root}' exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(binary, 0o755);
  fakeGpuTools(join(root, "gpu-bin"));
  fakeIdentityTools(join(root, "identity-bin"));
  // As setup/docker/build.sh labels its images: the layout, and a fresh record (049).
  const record = (kind: string) => JSON.stringify({ contract: 1, image: "standard", kind, arch: "x86_64", build: "build.fake", built: new Date().toISOString(), os: "Ubuntu 24.04.5 LTS", tools: { node: "24.21.0" } });
  const label = (kind: string) => ({ "bbbox.image-version": "1", "bbbox.fork-hold": "1", "bbbox.image-record": record(kind) });
  writeFileSync(
    join(root, "images.json"),
    JSON.stringify({
      "bbbox/linux:1": label("linux"),
      "bbbox/linux-desktop:1": { ...label("linux-desktop"), "bbbox.gpu-bus-id": "1" },
      "bbbox/linux-desktop-wayland:1": label("linux-desktop-wayland-cpu"),
    }),
  );
  let values = { ...host };
  writeFileSync(join(root, "host.json"), JSON.stringify(values));
  const containers = join(root, "containers");
  return {
    root,
    binary,
    set: (more) => {
      values = { ...values, ...more };
      writeFileSync(join(root, "host.json"), JSON.stringify(values));
    },
    calls: () =>
      existsSync(join(root, "log"))
        ? readFileSync(join(root, "log"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
            .map((args) => (args[0] === "-H" ? args.slice(2) : args))
        : [],
    containers: () => (existsSync(containers) ? readdirSync(containers).filter((name) => existsSync(join(containers, name, "config.json"))).sort() : []),
    inspect: (name) => JSON.parse(readFileSync(join(containers, name, "config.json"), "utf8")) as FakeContainer,
    writeVolumeFiles: (name, files) => {
      const path = join(root, "volumes.json");
      const volumes = JSON.parse(readFileSync(path, "utf8"));
      if (!volumes[name]) throw new Error(`No such volume: ${name}`);
      volumes[name].Files = files;
      writeFileSync(path, JSON.stringify(volumes));
    },
    volumeFiles: (name) => JSON.parse(readFileSync(join(root, "volumes.json"), "utf8"))[name]?.Files ?? {},
    home: (name) => join(containers, name, "home"),
    withIdentityReset: (image, version = 9) => imageWithIdentityReset(join(root, "image-identities", createHash("sha256").update(image).digest("hex")), version),
    identityRoot: (name) => join(containers, name, "identity"),
    servicesStarted: (name) => servicesLog(root).filter(([started]) => started === name).map(([, calls]) => calls),
    withoutForkHold: (image) => {
      const path = join(root, "images.json");
      const images = JSON.parse(readFileSync(path, "utf8"));
      delete images[image]["bbbox.fork-hold"];
      writeFileSync(path, JSON.stringify(images));
    },
  };
}

function servicesLog(root: string): readonly (readonly [string, number])[] {
  const path = join(root, "services.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as [string, number]);
}

function fakeGpuTools(bin: string): void {
  mkdirSync(bin, { recursive: true });
  const smi = String.raw`#!/usr/bin/env node
const cards = JSON.parse(process.env.FAKE_CARDS ?? "[]");
if (!cards.length) { console.log("No devices were found"); process.exit(6); }
for (const card of cards) console.log("GPU-" + card.uuid + ", " + card.name + ", " + card.totalMiB);
`;
  const python = String.raw`#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const script = process.argv[3] ?? "";
if (process.argv[2] !== "-c" || !script.includes("libcuda.so.1")) {
  const real = spawnSync(process.env.FAKE_REAL_PYTHON || "python3", process.argv.slice(2), { stdio: "inherit", env: { ...process.env, PATH: (process.env.PATH ?? "").split(":").slice(1).join(":") } });
  process.exit(real.status ?? 1);
}
const cards = JSON.parse(process.env.FAKE_CARDS ?? "[]");
if (process.env.FAKE_CUDA_ERROR) {
  console.log(script.includes("cuDeviceGetUuid") ? "cudacard " + process.env.FAKE_CUDA_ERROR + " 0 none" : process.env.FAKE_CUDA_ERROR);
  process.exit(0);
}
const visible = process.env.CUDA_VISIBLE_DEVICES;
const picked = process.env.FAKE_CUDA_NO_DEVICE ? [] : process.env.FAKE_CUDA_IGNORES_VISIBLE || visible === undefined ? cards : cards.filter((card) => "GPU-" + card.uuid === visible);
if (!script.includes("cuDeviceGetUuid")) { console.log(picked.length ? 0 : 100); process.exit(0); }
if (!picked.length) { console.log("cudacard 100 0 none"); process.exit(0); }
console.log("cudacard 0 " + picked.length + " " + picked[0].uuid.replaceAll("-", ""));
`;
  writeFileSync(join(bin, "nvidia-smi"), smi);
  writeFileSync(join(bin, "python3"), python);
  chmodSync(join(bin, "nvidia-smi"), 0o755);
  chmodSync(join(bin, "python3"), 0o755);
}

/** A config from the fields given, the rest at their defaults. */
export function dockerConfig(fields: Record<string, FieldValue> = {}): DockerConfig {
  const parsed = parseDockerPart({ id: "docker", fields, hosts: [] });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}
