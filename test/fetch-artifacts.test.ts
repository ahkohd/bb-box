// fetch-artifacts.sh's download cache (#96): pinned files from the cache when
// their SHA-256 matches, downloads into it, and nothing kept that no pin names.
// The pins point at file:// URLs, which curl reads with no network.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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

test("only the Wayland desktop fetches the Ubuntu 26.04 pins, which the X11 desktops, on 24.04, leave", { skip: spawnSync("jq", ["--version"]).status !== 0 && "needs jq" }, () => {
  const w = world({});
  const files = { "selkies-2.0.0-ubuntu24.04-amd64.deb": "selkies for 24.04", "selkies-2.0.0-ubuntu26.04-amd64.deb": "selkies for 26.04" };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(w.upstream, name), text);
  const row = (name: string, file: string) => `${name}\t${file}\tfile://${join(w.upstream, file)}\t${sha256(files[file as keyof typeof files])}\tx86_64`;
  writeFileSync(
    join(w.root, "template", "desktop-pins.tsv"),
    ["# name\tfile\turl\tsha256\tarch", row("selkies", "selkies-2.0.0-ubuntu24.04-amd64.deb"), row("selkies-ubuntu26.04", "selkies-2.0.0-ubuntu26.04-amd64.deb"), ""].join("\n"),
  );
  const fetched = (kind: string, art: string) => {
    const ran = spawnSync("bash", [join(w.root, "template", "fetch-artifacts.sh"), w.art(art), kind, "x86_64"], {
      encoding: "utf8",
      env: { ...process.env, BBBOX_ENV: "/nonexistent", BBBOX_BB_URL: "", BBBOX_ARTIFACT_CACHE: "" },
    });
    assert.equal(ran.status, 0, ran.stderr);
    return readdirSync(w.art(art)).sort();
  };
  assert.deepEqual(fetched("desktop-cpu", "x11"), ["selkies-2.0.0-ubuntu24.04-amd64.deb"]);
  assert.deepEqual(fetched("desktop-wayland-cpu", "wayland"), ["selkies-2.0.0-ubuntu24.04-amd64.deb", "selkies-2.0.0-ubuntu26.04-amd64.deb"]);
});

function runAsync(script: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string; ms: number }> {
  const began = performance.now();
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr, ms: performance.now() - began }));
  });
}

test("a download that stalls is retried, then fails within its stall limits, naming the file, and leaves no part behind", { skip: spawnSync("jq", ["--version"]).status !== 0 && "needs jq" }, async () => {
  const held: ServerResponse[] = [];
  let asked = 0;
  const server = createServer((_request, response) => {
    asked++;
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": "1048576" });
    response.write("x".repeat(64));
    held.push(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const w = world({});
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/big-tool-1.0.tar.gz`;
    writeFileSync(join(w.root, "template", "pins.json"), JSON.stringify({ tools: [{ name: "big", arch: "x86_64", version: "1", url, sha256: sha256("never sent") }] }));
    const ran = await runAsync(join(w.root, "template", "fetch-artifacts.sh"), [w.art("art"), "linux", "x86_64"], {
      ...process.env,
      BBBOX_ENV: "/nonexistent",
      BBBOX_BB_URL: "",
      BBBOX_ARTIFACT_CACHE: "",
      BBBOX_DOWNLOAD_STALL_SECONDS: "1",
    });
    assert.equal(ran.status, 1, ran.stderr);
    assert.match(ran.stderr, /download failed, as it stalled, under 10240 bytes a second for 1 s, after its retries: big-tool-1\.0\.tar\.gz from http:\/\/127\.0\.0\.1:\d+\/big-tool-1\.0\.tar\.gz/);
    assert.equal(asked, 4, "the first try and its 3 retries");
    assert.ok(ran.ms < 60_000, `failed in ${Math.round(ran.ms)} ms, not after the build's time`);
    assert.deepEqual(readdirSync(w.art("art")), [], "no part of the download is left");
  } finally {
    for (const response of held) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("each download has a connect timeout, a stall abort, a cap per file and its retries", () => {
  const script = readFileSync(join(SETUP, "template", "fetch-artifacts.sh"), "utf8");
  for (const flag of ["--connect-timeout", "--speed-limit", "--speed-time", "--max-time"]) assert.match(script, new RegExp(`download_limits=\\(.*${flag} `), flag);
  assert.match(script, /retried_download_limits=\(.*--retry 3 /);
  assert.equal(script.match(/curl -fsS/g)?.length, script.match(/curl -fsSL? "\$\{(retried_)?download_limits\[@\]\}"/g)?.length, "every curl has the limits");
  assert.match(script, /download_cap_seconds=\$\{BBBOX_DOWNLOAD_CAP_SECONDS:-1800\}/);
});
