// A fake Docker host for the Docker backend's tests: the fake docker CLI
// (fake-docker.mjs) with a daemon's state of its own, which has the images
// setup/docker/build.sh makes.

import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDockerPart, type DockerConfig } from "../src/backends/docker/config.ts";
import type { FieldValue } from "../src/backends/types.ts";
import { fakeGroup, tempDir } from "./helpers.ts";

/** A container as the fake's `docker container inspect` prints it. */
export interface FakeContainer {
  readonly Id: string;
  readonly Name: string;
  readonly State: { readonly Status: string; readonly ExitCode: number };
  readonly Config: { readonly Hostname: string; readonly Image: string; readonly Labels: Record<string, string>; readonly Env: string[]; readonly Cmd: string[] };
  readonly HostConfig: {
    readonly NanoCpus: number;
    readonly Memory: number;
    readonly MemorySwap: number;
    readonly ShmSize: number;
    readonly Privileged: boolean;
    readonly Init: boolean;
    readonly RestartPolicy: { readonly Name: string };
    readonly Devices: string[];
  };
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
  /** The box user's home in a container. */
  home(name: string): string;
}

export function fakeDockerHost(host: Record<string, unknown> = {}): FakeDockerHost {
  const root = tempDir("fake-docker");
  fakeGroup();
  const binary = join(root, "docker");
  const script = new URL("./fake-docker.mjs", import.meta.url).pathname;
  writeFileSync(binary, `#!/bin/sh\nFAKE_DOCKER_ROOT='${root}' exec '${process.execPath}' '${script}' "$@"\n`);
  chmodSync(binary, 0o755);
  const label = { "bbbox.image-version": "1" };
  writeFileSync(join(root, "images.json"), JSON.stringify({ "bbbox/linux:1": label, "bbbox/linux-desktop:1": { ...label, "bbbox.gpu-bus-id": "1" } }));
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
    home: (name) => join(containers, name, "home"),
  };
}

/** A config from the fields given, the rest at their defaults. */
export function dockerConfig(fields: Record<string, FieldValue> = {}): DockerConfig {
  const parsed = parseDockerPart({ id: "docker", fields, hosts: [] });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}
