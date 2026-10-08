// fetch-artifacts.sh's download cache (#96): pinned files from the cache when
// their SHA-256 matches, downloads into it, and nothing kept that no pin names.
// The pins point at file:// URLs, which curl reads with no network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SETUP = fileURLToPath(new URL("../setup/proxmox-lxc/", import.meta.url));
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** The script in a layout of its own, with pins for files in `upstream`. */
function world(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "bb-box-fetch-"));
  dirs.push(root);
  const upstream = join(root, "upstream");
  mkdirSync(join(root, "template"), { recursive: true });
  mkdirSync(join(root, "host"));
  mkdirSync(upstream);
  copyFileSync(join(SETUP, "template", "fetch-artifacts.sh"), join(root, "template", "fetch-artifacts.sh"));
  // common.sh's die, without its settings and its check for root on a Proxmox host.
  writeFileSync(join(root, "host", "common.sh"), 'die() { echo "${0##*/}: $*" >&2; exit 1; }\n');
  const pin = (pins: Record<string, string>) => {
    for (const [name, text] of Object.entries(pins)) writeFileSync(join(upstream, name), text);
    const tools = Object.entries(pins).map(([name, text]) => ({ name, arch: "x86_64", version: "1", url: `file://${join(upstream, name)}`, sha256: sha256(text) }));
    writeFileSync(join(root, "template", "pins.json"), JSON.stringify({ tools }));
    writeFileSync(join(root, "template", "desktop-pins.tsv"), "# name\tfile\turl\tsha256\tarch\n");
  };
  pin(files);
  const cache = join(root, "cache");
  const run = (art: string) => {
    const ran = spawnSync("bash", [join(root, "template", "fetch-artifacts.sh"), join(root, art), "linux", "x86_64"], {
      encoding: "utf8",
      env: { ...process.env, BBBOX_ENV: "/nonexistent", BBBOX_BB_URL: "", BBBOX_ARTIFACT_CACHE: cache },
    });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout;
  };
  return { root, upstream, cache, pin, run, art: (name: string) => join(root, name) };
}

test("a download goes into the cache, and a later build takes it from there with no download", { skip: spawnSync("jq", ["--version"]).status !== 0 && "needs jq" }, () => {
  const w = world({ "tool-1.0.tar.gz": "tool one", "other-2.0.tar.gz": "other two" });
  assert.match(w.run("art1"), /fetched tool-1\.0\.tar\.gz/);
  assert.deepEqual(readdirSync(w.cache).sort(), ["other-2.0.tar.gz", "tool-1.0.tar.gz"]);

  // Upstream is gone: the next build, into an empty directory, has what it needs from the cache.
  rmSync(w.upstream, { recursive: true });
  const out = w.run("art2");
  assert.match(out, /cached tool-1\.0\.tar\.gz/);
  assert.doesNotMatch(out, /fetched/);
  assert.equal(readFileSync(join(w.art("art2"), "tool-1.0.tar.gz"), "utf8"), "tool one");
});

test("a cached file that does not match its pin is downloaded again, and files no pin names leave the cache", { skip: spawnSync("jq", ["--version"]).status !== 0 && "needs jq" }, () => {
  const w = world({ "tool-1.0.tar.gz": "tool one" });
  w.run("art1");
  writeFileSync(join(w.cache, "tool-1.0.tar.gz"), "tampered");
  writeFileSync(join(w.cache, "stray.bin"), "not pinned");
  writeFileSync(join(w.cache, "tool-1.0.tar.gz.part.4242"), "another build's download");
  assert.match(w.run("art2"), /fetched tool-1\.0\.tar\.gz/);
  assert.equal(readFileSync(join(w.cache, "tool-1.0.tar.gz"), "utf8"), "tool one", "the good copy replaces the bad one");
  assert.equal(existsSync(join(w.cache, "stray.bin")), false);
  assert.equal(existsSync(join(w.cache, "tool-1.0.tar.gz.part.4242")), true, "another build's download on its way in stays");

  // A new version of the pin: its file comes in, and the old version's leaves.
  w.pin({ "tool-1.1.tar.gz": "tool one point one" });
  const out = w.run("art3");
  assert.match(out, /fetched tool-1\.1\.tar\.gz/);
  assert.match(out, /cache: removed tool-1\.0\.tar\.gz, which no pin names/);
  assert.deepEqual(readdirSync(w.cache).filter((name) => !name.includes(".part.")), ["tool-1.1.tar.gz"]);
});
