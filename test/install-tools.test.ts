import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/install-tools.sh", import.meta.url));
const ARCH = arch() === "x64" ? "x86_64" : "arm64";
const tools = ["jq", "sha256sum", "tar", "xz"].every((tool) => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0);

test("install-tools.sh runs again on a built image, as a refresh does: it keeps a version, moves its links, and removes the old one (049)", { skip: !tools }, () => {
  const dir = tempDir("install-tools");
  const [artifacts, prefix, bin] = ["artifacts", "opt", "bin"].map((name) => join(dir, name));
  mkdirSync(artifacts);
  /** A tool's release: a tarball with bin/demo printing its version, and pins.json naming it. */
  const release = (version: string) => {
    const src = join(dir, `src-${version}`, `demo-${version}`, "bin");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "demo"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
    const file = `demo-${version}.tar.gz`;
    assert.equal(spawnSync("tar", ["-czf", join(artifacts, file), "-C", join(dir, `src-${version}`), `demo-${version}`]).status, 0);
    const sha256 = createHash("sha256").update(readFileSync(join(artifacts, file))).digest("hex");
    const pins = join(dir, `pins-${version}.json`);
    writeFileSync(pins, JSON.stringify({ tools: [{ name: "demo", version, arch: ARCH, url: `https://example.com/${file}`, sha256, strip: 1, links: { demo: "bin/demo" } }] }));
    return pins;
  };
  const install = (pins: string) => spawnSync("bash", [SCRIPT, pins, artifacts, prefix, bin], { encoding: "utf8" });
  const run = () => spawnSync(join(bin, "demo"), { encoding: "utf8" }).stdout.trim();

  const first = release("1.0.0");
  assert.equal(install(first).status, 0);
  assert.equal(run(), "1.0.0");
  const again = install(first);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^keeping demo 1\.0\.0 in /m);
  assert.equal(run(), "1.0.0");

  // A refresh with a newer release: its link moves, and the old version goes.
  const newer = install(release("1.1.0"));
  assert.equal(newer.status, 0, newer.stderr);
  assert.equal(run(), "1.1.0");
  assert.equal(readlinkSync(join(bin, "demo")), join(prefix, "demo-1.1.0", "bin/demo"));
  assert.equal(existsSync(join(prefix, "demo-1.0.0")), false);
  assert.match(newer.stdout, /^removed .*demo-1\.0\.0$/m);

  // What it did not make stays, and stops it.
  const theirs = join(bin, "demo");
  spawnSync("rm", ["-f", theirs]);
  writeFileSync(theirs, "#!/bin/sh\necho theirs\n", { mode: 0o755 });
  const refused = install(release("1.2.0"));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /demo already exists$/m);
  assert.equal(run(), "theirs");
});

test("the desktop scripts' check for a newer Chrome passes where Chrome is not installed yet, as on a fresh image (049)", () => {
  const dir = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/", import.meta.url));
  const bin = tempDir("dpkg");
  // dpkg-query as for a package it has never seen.
  writeFileSync(join(bin, "dpkg-query"), "#!/bin/sh\necho \"dpkg-query: no packages found matching $3\" >&2\nexit 1\n", { mode: 0o755 });
  for (const script of ["customize-desktop.sh", "customize-desktop-wayland.sh"]) {
    const line = readFileSync(join(dir, script), "utf8").split("\n").find((one) => one.startsWith("installed=$(dpkg-query"));
    assert.ok(line, script);
    const ran = spawnSync("bash", ["-c", `set -Eeuo pipefail; ${line}; echo "installed=[$installed]"`], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8" });
    assert.deepEqual([ran.status, ran.stdout], [0, "installed=[]\n"], `${script}: ${ran.stderr}`);
  }
});
