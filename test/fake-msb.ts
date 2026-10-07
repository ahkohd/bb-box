// A fake msb host for the microsandbox backend's tests: bb-box's msb folder
// with the fake msb (fake-msb.mjs) as bin/msb, and the scripts of
// release.ts answered as such a host would: its facts, Docker's images, and
// imports from Docker into msb.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
  inspect(name: string): { status: string; config: { labels: Record<string, string>; env: string[]; mounts: string[]; network: string; tmpfs: string; resources: { cpus: number; memory_mib: number } } };
  /** msb's images, by reference, with their labels. */
  images(): Record<string, Record<string, string>>;
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
  ]);
  const imagesFile = join(root, "images.json");
  const readImages = (): Record<string, Record<string, string>> => (existsSync(imagesFile) ? JSON.parse(readFileSync(imagesFile, "utf8")) : {});
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
    used_kib: String(3 * 1024 * 1024),
    reflink: "0",
    docker: "29.0.0",
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
      if (name === "status") return { exitCode: 0, stdout: lines(facts), stderr: "" };
      if (name === "install") {
        facts = { ...facts, installed: "0.7.7" };
        return { exitCode: 0, stdout: "installed=0.7.7\n", stderr: "" };
      }
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
    home: (name) => join(root, "sandboxes", name, "home"),
  };
}

/** A config from the fields given, the rest at their defaults. */
export function msbConfig(fields: Record<string, FieldValue> = {}): MsbConfig {
  const parsed = parseMsbPart({ id: "microsandbox", fields, hosts: [] });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}
