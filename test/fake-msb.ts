// A fake msb host for the microsandbox backend's tests: bb-box's msb folder
// with the fake msb (fake-msb.mjs) as bin/msb, and the scripts of
// release.ts answered as such a host would: its facts, Docker's images, and
// imports from Docker into msb.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScriptResult } from "../src/backends/microsandbox/cli.ts";
import { parseMsbPart, type MsbConfig } from "../src/backends/microsandbox/config.ts";
import type { MsbScript } from "../src/backends/microsandbox/release.ts";
import type { FieldValue } from "../src/backends/types.ts";
import { fakeGroup, tempDir } from "./helpers.ts";

export interface FakeMsbHost {
  readonly root: string;
  /** bb-box's msb folder, whose bin/msb is the fake. */
  readonly dir: string;
  /** Answers bb-box's scripts, as the backend's `script` option. */
  readonly script: (name: MsbScript, args: readonly string[]) => Promise<ScriptResult>;
  /** Changes the fake msb's switches: neverReady, ghost. */
  set(values: Record<string, unknown>): void;
  /** Changes what the status script says, such as kvm, lxc or installed. */
  facts(values: Record<string, string>): void;
  /** Docker's images on the host, by reference, with an ID and labels. */
  readonly docker: Map<string, { id: string; labels: Record<string, string> }>;
  /** Every msb call so far. */
  calls(): string[][];
  /** The scripts run so far, with their arguments. */
  readonly scripts: string[][];
  sandboxes(): string[];
  inspect(name: string): { status: string; config: { labels: Record<string, string>; env: string[]; mounts: { guest: string; type: string }[]; owned: string[]; disks: string[]; network: string; tmpfs: string; resources: { cpus: number; memory_mib: number }; restoredFrom?: string } };
  snapshots(): { id: string; group: string; name: string; labels: Record<string, string>; listed: { parent_digest: string | null; scope: string } }[];
  heads(): Record<string, string>;
  /** msb's images, by reference, with their labels. */
  images(): Record<string, Record<string, string>>;
  whenImage(ref: string): Promise<void>;
  home(name: string): string;
}

/** As setup/docker/build.sh labels its images: a fresh record (049). */
export function imageLabels(kind: string, build = "build.fake"): Record<string, string> {
  return {
    "bbbox.image-version": "1",
    "bbbox.image-record": JSON.stringify({ contract: 1, image: "standard", kind, arch: "x86_64", build, built: new Date().toISOString(), os: "Ubuntu 24.04.5 LTS", tools: { node: "24.21.0" } }),
  };
}

export function fakeMsbHost(options: { imported?: boolean } = {}): FakeMsbHost {
  const root = tempDir("fake-msb");
  const dir = join(root, "microsandbox");
  fakeGroup();
  mkdirSync(join(dir, "bin"), { recursive: true });
  const binary = join(dir, "bin", "msb");
  const script = new URL("./fake-msb.mjs", import.meta.url).pathname;
  writeFileSync(binary, `#!/bin/sh\nFAKE_MSB_ROOT='${root}' exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(binary, 0o755);
  const docker = new Map([
    ["bbbox/linux:1", { id: "sha256:linux1", labels: imageLabels("linux") }],
    ["bbbox/linux-desktop:1", { id: "sha256:desktop1", labels: imageLabels("linux-desktop") }],
    ["bbbox/linux:1-arm64", { id: "sha256:linuxarm1", labels: imageLabels("linux-arm64") }],
    ["bbbox/linux-desktop:1-arm64", { id: "sha256:desktoparm1", labels: imageLabels("linux-arm64-desktop-cpu") }],
  ]);
  const imagesFile = join(root, "images.json");
  const readImages = (): Record<string, Record<string, string>> => (existsSync(imagesFile) ? JSON.parse(readFileSync(imagesFile, "utf8")) : {});
  const imageWaiters = new Map<string, Array<() => void>>();
  const notifyImage = (ref: string) => {
    const waiting = imageWaiters.get(ref);
    if (!waiting) return;
    imageWaiters.delete(ref);
    for (const wake of waiting) wake();
  };
  writeFileSync(imagesFile, JSON.stringify(options.imported === false ? {} : Object.fromEntries([...docker].map(([ref, image]) => [ref, image.labels]))));
  let facts: Record<string, string> = {
    pinned: "0.7.7",
    dir,
    os: "Linux",
    arch: "x86_64",
    kernel: "6.12.0",
    installed: "0.7.7",
    cpus: "16",
    memory_kib: String(64 * 1024 * 1024),
    kvm: "ok",
    lxc: "0",
    free_kib: String(500 * 1024 * 1024),
    disk_kib: String(1000 * 1024 * 1024),
    used_kib: String(3 * 1024 * 1024),
    reflink: "0",
    docker: "29.0.0",
    // What the memory script says the host has available now (#557).
    available_kib: String(48 * 1024 * 1024),
  };
  let values: Record<string, unknown> = {};
  const scripts: string[][] = [];
  const lines = (entries: Record<string, string>) => Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join("");
  return {
    root,
    dir,
    docker,
    scripts,
    script: async (name, args) => {
      scripts.push([name, ...args]);
      if (name === "status") {
        return { exitCode: 0, stdout: lines(facts), stderr: "" };
      }
      if (name === "install") {
        facts = { ...facts, installed: "0.7.7" };
        return { exitCode: 0, stdout: "installed=0.7.7\n", stderr: "" };
      }
      if (name === "snapshots") {
        const listed = existsSync(join(root, "snapshots.json")) ? (JSON.parse(readFileSync(join(root, "snapshots.json"), "utf8")) as { id: string }[]) : [];
        const kept = existsSync(join(dir, "kept")) ? readdirSync(join(dir, "kept")).filter((file) => file.startsWith("snap_")) : [];
        return { exitCode: 0, stdout: [...listed.map((each) => `size:${each.id}=2048\n`), ...kept.map((file) => `kept:${file}=${readFileSync(join(dir, "kept", file), "utf8").trim()}\n`)].join(""), stderr: "" };
      }
      if (name === "keep") {
        mkdirSync(join(dir, "kept"), { recursive: true });
        if (args[1] === "none") rmSync(join(dir, "kept", args[0]!), { force: true });
        else writeFileSync(join(dir, "kept", args[0]!), `${args[1]}\n`);
        return { exitCode: 0, stdout: `kept=${args[1]}\n`, stderr: "" };
      }
      if (name === "undisk") {
        for (const disk of args) rmSync(join(dir, "disks", `${disk}.ext4`), { force: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (name === "disks") {
        const disks = existsSync(join(dir, "disks")) ? readdirSync(join(dir, "disks")) : [];
        return { exitCode: 0, stdout: disks.map((file) => `${file.replace(/\.ext4$/, "")}=${Math.round((Date.now() - statSync(join(dir, "disks", file)).mtimeMs) / 1000)}\n`).join(""), stderr: "" };
      }
      if (name === "retag") {
        const images = readImages();
        if (!images[args[0]!]) return { exitCode: 1, stdout: "", stderr: `error: image not found: ${args[0]}\n` };
        const { [args[0]!]: moved, ...rest } = images;
        writeFileSync(imagesFile, JSON.stringify({ ...rest, [args[1]!]: moved }));
        return { exitCode: 0, stdout: `retagged=${args[1]}\n`, stderr: "" };
      }
      if (name === "transfer") {
        const kind = args[1]!.includes("desktop") ? "linux-arm64-desktop-cpu" : "linux-arm64";
        writeFileSync(imagesFile, JSON.stringify({ ...readImages(), [args[1]!]: imageLabels(kind, "build.builder") }));
        notifyImage(args[1]!);
        return { exitCode: 0, stdout: `transferred=${args[1]}\n`, stderr: "" };
      }
      if (name === "memory") return { exitCode: 0, stdout: `available_kib=${facts.available_kib}\n`, stderr: "" };
      if (name === "oom") return { exitCode: 0, stdout: "adjusted=0\n", stderr: "" };
      if (name === "images") return { exitCode: 0, stdout: args.map((ref) => `docker:${ref}=${docker.get(ref)?.id ?? ""}\n`).join(""), stderr: "" };
      const image = docker.get(args[0]!);
      if (!image) return { exitCode: 2, stdout: "", stderr: `Docker on this host has no image ${args[0]} to import.\n` };
      writeFileSync(imagesFile, JSON.stringify({ ...readImages(), [args[0]!]: image.labels }));
      return { exitCode: 0, stdout: `imported=${image.id}\n`, stderr: "" };
    },
    set: (more) => {
      values = { ...values, ...more };
      writeFileSync(join(root, "host.json"), JSON.stringify(values));
    },
    facts: (more) => {
      facts = { ...facts, ...more };
    },
    calls: () =>
      existsSync(join(root, "log"))
        ? readFileSync(join(root, "log"), "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as string[])
        : [],
    sandboxes: () => (existsSync(join(root, "sandboxes")) ? readdirSync(join(root, "sandboxes")).filter((name) => existsSync(join(root, "sandboxes", name, "config.json"))).sort() : []),
    inspect: (name) => JSON.parse(readFileSync(join(root, "sandboxes", name, "config.json"), "utf8")),
    images: readImages,
    whenImage: (ref) => {
      if (readImages()[ref]) return Promise.resolve();
      return new Promise((resolve) => {
        const waiting = imageWaiters.get(ref) ?? [];
        waiting.push(resolve);
        imageWaiters.set(ref, waiting);
        if (readImages()[ref]) notifyImage(ref);
      });
    },
    snapshots: () => (existsSync(join(root, "snapshots.json")) ? JSON.parse(readFileSync(join(root, "snapshots.json"), "utf8")) : []),
    heads: () => (existsSync(join(root, "heads.json")) ? JSON.parse(readFileSync(join(root, "heads.json"), "utf8")) : {}),
    home: (name) => join(root, "sandboxes", name, "home"),
  };
}

/** A config from the fields given, the rest at their defaults. */
export function msbConfig(fields: Record<string, FieldValue> = {}): MsbConfig {
  const parsed = parseMsbPart({ id: "microsandbox", fields, hosts: [] });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}
