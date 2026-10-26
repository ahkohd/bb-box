import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseImageRecord, pinsDigest } from "../src/backends/images.ts";
import { compareVersions, gpgvVerify, resolveVersions, SignatureError, stageSetup, type FetchText, type Verify } from "../src/backends/versions.ts";
import { versionsText } from "../src/plugin/views.ts";
import { tempDir } from "./helpers.ts";

const SETUP = fileURLToPath(new URL("../setup/", import.meta.url));
const TEMPLATE = join(SETUP, "proxmox-lxc", "template");
const NOW = Date.parse("2026-10-03T02:15:00Z");
const pins = JSON.parse(readFileSync(join(TEMPLATE, "pins.json"), "utf8")) as { tools: { name: string; version: string; arch: string; url: string; sha256: string }[] };
const pinOf = (name: string, arch = "x86_64") => pins.tools.find((tool) => tool.name === name && tool.arch === arch)!;
const chromePin = readFileSync(join(TEMPLATE, "desktop-pins.tsv"), "utf8").split("\n").find((line) => line.startsWith("chrome\t"))!.split("\t");
const digest = (seed: string) => seed.repeat(64).slice(0, 64);

/** A newer version than the pin, whatever the pin is. */
const NEXT = "99.0.1";
const CHROME_NEXT = "999.0.0.1-1";

/**
 * Upstreams with a release after each pin, as they publish them: Claude
 * Code's latest channel and manifest, GitHub's latest releases with their
 * assets' digests, and Google's Packages index. `override` replaces an
 * answer by URL part; null answers HTTP 403.
 */
function upstream(override: Record<string, string | null> = {}): { fetch: FetchText; asked: string[] } {
  const asked: string[] = [];
  const claude = pinOf("claude-code").url;
  const base = claude.slice(0, claude.indexOf(`/${pinOf("claude-code").version}/`));
  const release = (name: string, tag: (version: string) => string) => {
    const assets = pins.tools.filter((tool) => tool.name === name).map((tool) => ({ name: tool.url.split("/").at(-1)!.replaceAll(tool.version, NEXT), digest: `sha256:${digest(tool.arch === "x86_64" ? "a" : "b")}` }));
    return JSON.stringify({ tag_name: tag(NEXT), draft: false, prerelease: false, assets });
  };
  const answers: Record<string, string> = {
    [`${base}/latest`]: `${NEXT}\n`,
    [`${base}/${NEXT}/manifest.json`]: JSON.stringify({ version: NEXT, platforms: { "linux-x64": { checksum: digest("c") }, "linux-arm64": { checksum: digest("d") } } }),
    "https://api.github.com/repos/openai/codex/releases/latest": release("codex", (version) => `rust-v${version}`),
    "https://api.github.com/repos/earendil-works/pi/releases/latest": release("pi", (version) => `v${version}`),
    "https://api.github.com/repos/cli/cli/releases/latest": release("gh", (version) => `v${version}`),
  };
  answers[`${base}/${NEXT}/manifest.json.sig`] = "a detached signature";
  for (const arch of ["amd64", "arm64"]) {
    answers[`https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-${arch}/Packages`] = [
      `Package: google-chrome-beta\nVersion: 1000.0.0.0-1\nFilename: pool/main/g/google-chrome-beta/beta_${arch}.deb\nSHA256: ${digest("0")}\n`,
      `Package: google-chrome-stable\nVersion: ${CHROME_NEXT}\nArchitecture: ${arch}\nFilename: pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_NEXT}_${arch}.deb\nSize: 1\nSHA256: ${digest(arch === "amd64" ? "e" : "f")}\n`,
    ].join("\n");
  }
  // Google's InRelease, which a trusting verify takes as it is, with each index's SHA-256.
  const index = (arch: string) => {
    const url = `https://dl.google.com/linux/chrome/deb/dists/stable/main/binary-${arch}/Packages`;
    const key = Object.keys(override).find((part) => url.includes(part));
    return (key !== undefined ? override[key] : answers[url]) ?? "";
  };
  answers["https://dl.google.com/linux/chrome/deb/dists/stable/InRelease"] =
    `Origin: Google LLC\nSHA256:\n${["amd64", "arm64"].map((arch) => ` ${createHash("sha256").update(index(arch)).digest("hex")} ${index(arch).length} main/binary-${arch}/Packages`).join("\n")}\n`;
  return {
    asked,
    fetch: async (url) => {
      asked.push(url);
      const key = Object.keys(override).find((part) => url.includes(part));
      const body = key !== undefined ? override[key] : answers[url];
      if (body === null || body === undefined) return { ok: false, status: body === null ? 403 : 404, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer };
    },
  };
}

/** Takes every signature as good: the signed text, as gpgv gives it. */
const trusting: Verify = async (_signer, signed) => new TextDecoder().decode(signed);

test("versions compare by their numbers", () => {
  assert.equal(compareVersions("2.1.288", "2.1.283"), 1);
  assert.equal(compareVersions("0.160.0", "0.157.1"), 1);
  assert.equal(compareVersions("1.0.0", "0.87.1"), 1);
  assert.equal(compareVersions("154.0.8037.97-1", "154.0.8037.92-1"), 1);
  assert.equal(compareVersions("154.0.8037.92-1", "154.0.8037.92-2"), -1);
  assert.equal(compareVersions("2.1", "2.1.0"), 0);
});

test("a rebuild takes upstream's latest of the tools that follow it, each with its published SHA-256, and the day's apt snapshot (049)", async () => {
  const { fetch, asked } = upstream();
  const versions = await resolveVersions(SETUP, { fetch, now: NOW, verify: trusting });
  assert.equal(versions.following, true);
  assert.deepEqual(
    versions.tools.map((tool) => [tool.name, tool.arch, tool.version, tool.kept]),
    [
      ["claude-code", "x86_64", NEXT, null],
      ["claude-code", "arm64", NEXT, null],
      ["codex", "x86_64", NEXT, null],
      ["codex", "arm64", NEXT, null],
      ["pi", "x86_64", NEXT, null],
      ["pi", "arm64", NEXT, null],
      ["gh", "x86_64", NEXT, null],
      ["gh", "arm64", NEXT, null],
      ["chrome", "x86_64", "999.0.0.1", null],
      ["chrome", "arm64", "999.0.0.1", null],
    ],
  );
  assert.equal(versions.tools[0]!.pinned, pinOf("claude-code").version);
  assert.equal(new Set(asked).size, asked.length, "each upstream once, for both architectures");
  assert.deepEqual(versions.aptSnapshot, { pinned: readFileSync(join(TEMPLATE, "apt-snapshot"), "utf8").trim(), version: "20261003T000000Z" });

  const resolved = JSON.parse(versions.files["pins.json"]) as { tools: Record<string, unknown>[]; aptSnapshot: string; resolvedAt: string; pinned: Record<string, string> };
  const tool = (name: string, arch = "x86_64") => resolved.tools.find((candidate) => candidate.name === name && candidate.arch === arch)!;
  const gh = tool("gh");
  assert.equal(gh.url, `https://github.com/cli/cli/releases/download/v${NEXT}/${pinOf("gh").url.split("/").at(-1)!.replaceAll(pinOf("gh").version, NEXT)}`);
  assert.equal(gh.sha256, digest("a"));
  assert.equal(gh.source, `GitHub release asset digest for cli/cli v${NEXT}`);
  assert.equal(tool("codex", "arm64").sha256, digest("b"));
  assert.match(String(tool("codex").url), new RegExp(`/rust-v${NEXT.replaceAll(".", "\\.")}/`));
  assert.equal(tool("claude-code").url, pinOf("claude-code").url.replace(`/${pinOf("claude-code").version}/`, `/${NEXT}/`));
  assert.deepEqual([tool("claude-code").sha256, tool("claude-code", "arm64").sha256], [digest("c"), digest("d")]);
  // The tools that do not follow upstream keep their pins.
  assert.deepEqual(tool("node"), pinOf("node"));
  assert.deepEqual([resolved.aptSnapshot, resolved.resolvedAt], ["20261003T000000Z", "2026-10-03T02:15:00.000Z"]);
  assert.deepEqual(resolved.pinned, { linux: await pinsDigest(SETUP, "linux"), "linux-desktop": await pinsDigest(SETUP, "linux-desktop"), android: await pinsDigest(SETUP, "android") });

  const chrome = versions.files["desktop-pins.tsv"].split("\n").filter((line) => line.startsWith("chrome\t")).map((line) => line.split("\t"));
  assert.deepEqual(chrome[0], [
    "chrome",
    `google-chrome-stable_${CHROME_NEXT}_amd64.deb`,
    `https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_NEXT}_amd64.deb`,
    digest("e"),
    "x86_64",
  ]);
  assert.equal(chrome[1]![3], digest("f"));
  // The rest of the desktop's pins, comments too, stay as they are.
  const unchanged = (text: string) => text.split("\n").filter((line) => !line.startsWith("chrome\t"));
  assert.deepEqual(unchanged(versions.files["desktop-pins.tsv"]), unchanged(readFileSync(join(TEMPLATE, "desktop-pins.tsv"), "utf8")));
});

test("a tool keeps its pin when upstream has nothing newer, or cannot be read, so no build goes back", async () => {
  const older = JSON.stringify({ tag_name: "v0.0.1", draft: false, prerelease: false, assets: [] });
  const { fetch } = upstream({
    "earendil-works/pi": older,
    "cli/cli": null,
    "openai/codex": JSON.stringify({ tag_name: `rust-v${NEXT}`, draft: false, prerelease: false, assets: [] }),
    "claude-code-releases/latest": "<html>not a version</html>",
    "binary-arm64/Packages": `Package: google-chrome-stable\nVersion: 1.0.0.0-1\nFilename: pool/x.deb\nSHA256: ${digest("9")}\n`,
  });
  const versions = await resolveVersions(SETUP, { fetch, now: NOW, verify: trusting });
  const of = (name: string, arch = "x86_64") => versions.tools.find((tool) => tool.name === name && tool.arch === arch)!;
  assert.deepEqual([of("pi").version, of("pi").kept], [pinOf("pi").version, null], "nothing newer");
  assert.equal(of("gh").version, pinOf("gh").version);
  assert.equal(of("gh").kept, "upstream could not be read: https://api.github.com/repos/cli/cli/releases/latest answered HTTP 403");
  assert.match(of("codex").kept!, /^upstream could not be read: openai\/codex rust-v99\.0\.1 has no asset codex-x86_64-unknown-linux-musl\.tar\.gz with a SHA-256$/);
  assert.match(of("claude-code").kept!, /the latest channel names "<html>not a version<\/html>", not a version/);
  assert.equal(of("chrome", "arm64").version, chromePin[1]!.replace(/^google-chrome-stable_([^_]+)-\d+_.*$/, "$1"), "an older Chrome than the pin");
  assert.equal(of("chrome").version, "999.0.0.1");
  const resolved = JSON.parse(versions.files["pins.json"]) as { tools: { name: string; arch: string }[] };
  for (const name of ["pi", "gh", "codex", "claude-code"]) assert.deepEqual(resolved.tools.find((tool) => tool.name === name && tool.arch === "x86_64"), pinOf(name), name);
});

test("a tool keeps its pin when its signature does not verify, or its index is not the signed one, saying so (#424)", async () => {
  const refusing: Verify = async (signer) => {
    throw new SignatureError(`gpgv did not accept it: BAD signature from ${signer}`);
  };
  const refused = await resolveVersions(SETUP, { fetch: upstream().fetch, now: NOW, verify: refusing });
  const of = (versions: typeof refused, name: string, arch = "x86_64") => versions.tools.find((tool) => tool.name === name && tool.arch === arch)!;
  assert.deepEqual([of(refused, "claude-code").version, of(refused, "claude-code").kept], [pinOf("claude-code").version, `its signature did not verify: manifest.json of ${NEXT}: gpgv did not accept it: BAD signature from claude-code`]);
  assert.equal(of(refused, "chrome").kept, "its signature did not verify: Google's InRelease: gpgv did not accept it: BAD signature from chrome");
  assert.equal(of(refused, "gh").version, NEXT, "a tool upstream does not sign follows as before");
  // An index other than the one the signed InRelease names: the pin stays.
  const { fetch } = upstream();
  const tampered: FetchText = async (url, init) => (url.endsWith("binary-amd64/Packages") ? { ok: true, status: 200, text: async () => "Package: google-chrome-stable\n", arrayBuffer: async () => new ArrayBuffer(0) } : fetch(url, init));
  const swapped = await resolveVersions(SETUP, { fetch: tampered, now: NOW, verify: trusting });
  assert.equal(of(swapped, "chrome").kept, "its signature did not verify: main/binary-amd64/Packages is not the index Google's signed InRelease gives");
  assert.equal(of(swapped, "chrome", "arm64").version, "999.0.0.1");
});

test("gpgv checks a signature against the pinned key, the clear-signed text too, refuses another key's or a changed text, and says when it is not installed (#424)", { skip: spawnSync("gpg", ["--version"]).status !== 0 || spawnSync("gpgv", ["--version"]).status !== 0 }, async () => {
  const dir = tempDir("gpgv");
  const home = join(dir, "gnupg");
  mkdirSync(home, { mode: 0o700 });
  const gpg = (...args: string[]) => spawnSync("gpg", ["--homedir", home, "--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase", "", ...args], { encoding: "utf8" });
  for (const name of ["Signer", "Other"]) assert.equal(gpg("--quick-gen-key", `${name} <${name.toLowerCase()}@example.com>`, "ed25519", "sign", "never").status, 0);
  const fingerprint = (name: string) => /^fpr:+([0-9A-F]{40}):/m.exec(gpg("--with-colons", "--fingerprint", name).stdout)![1]!;
  mkdirSync(join(dir, "keys"));
  writeFileSync(join(dir, "keys", "signer.asc"), gpg("--armor", "--export", "Signer").stdout);
  const signers = { "claude-code": { file: "signer.asc", fingerprint: fingerprint("Signer") }, chrome: { file: "signer.asc", fingerprint: fingerprint("Signer") } };
  const verify = gpgvVerify(dir, signers);
  const text = '{"version":"1.0.0"}';
  writeFileSync(join(dir, "manifest.json"), text);
  const sign = (key: string, ...args: string[]) => (gpg("--local-user", key, ...args, "--output", join(dir, "out"), join(dir, "manifest.json")), readFileSync(join(dir, "out")));
  assert.equal(await verify("claude-code", new TextEncoder().encode(text), sign("Signer", "--detach-sign")), text);
  assert.equal((await verify("chrome", sign("Signer", "--clearsign"), null)).trim(), text, "the clear-signed text");
  await assert.rejects(verify("claude-code", new TextEncoder().encode(`${text} `), sign("Signer", "--detach-sign")), /gpgv did not accept it: .*BAD signature/);
  await assert.rejects(verify("claude-code", new TextEncoder().encode(text), sign("Other", "--detach-sign")), (error: Error) => error instanceof SignatureError && /gpgv did not accept it/.test(error.message));
  // On a host without gpgv the pin stays, saying what to install.
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    await assert.rejects(verify("claude-code", new TextEncoder().encode(text), sign("Signer", "--detach-sign")), /^SignatureError: gpgv is not installed here to check it: install GnuPG's gpgv$/);
  } finally {
    process.env.PATH = path;
  }
});

test("setup/keys holds the keys SIGNERS pins, by their primary fingerprints (#424)", { skip: spawnSync("gpg", ["--version"]).status !== 0 }, () => {
  for (const [file, fingerprint] of [["claude-code.asc", "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE"], ["google-linux.asc", "EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796"]]) {
    const shown = spawnSync("gpg", ["--with-colons", "--show-keys", join(SETUP, "keys", file!)], { encoding: "utf8" }).stdout;
    assert.equal(/^fpr:+([0-9A-F]{40}):/m.exec(shown)?.[1], fingerprint, file);
  }
});

test("with --pinned a rebuild takes the repository's pins alone, and asks no upstream", async () => {
  const { fetch, asked } = upstream();
  const versions = await resolveVersions(SETUP, { fetch, now: NOW, pinned: true });
  assert.deepEqual(asked, []);
  assert.equal(versions.following, false);
  for (const file of ["pins.json", "desktop-pins.tsv", "apt-snapshot"] as const) assert.equal(versions.files[file], readFileSync(join(TEMPLATE, file), "utf8"), file);
  assert.ok(versions.tools.every((tool) => tool.version === tool.pinned && tool.kept === "built from the pins alone (--pinned)"));
});

test("a staged setup builds with the versions, and its image's record keeps the repository's pins (049)", { skip: spawnSync("jq", ["--version"]).status !== 0 || !existsSync("/etc/os-release") }, async () => {
  const versions = await resolveVersions(SETUP, { fetch: upstream().fetch, now: NOW, verify: trusting });
  const staged = join(tempDir("staged"), "setup");
  await stageSetup(SETUP, staged, versions);
  const template = join(staged, "proxmox-lxc", "template");
  for (const file of ["pins.json", "desktop-pins.tsv", "apt-snapshot"] as const) assert.equal(readFileSync(join(template, file), "utf8"), versions.files[file]);
  assert.equal(readFileSync(join(staged, "docker", "build.sh"), "utf8"), readFileSync(join(SETUP, "docker", "build.sh"), "utf8"), "the rest as it is");

  // What image-record.sh records from the staged pins, as a desktop build runs it.
  const out = tempDir("staged-record");
  writeFileSync(join(template, "build.env"), "DESKTOP_GPU=none\n");
  writeFileSync(join(out, "template-release"), "kind=desktop\napt_snapshot=20261003T000000Z\n");
  const run = spawnSync("bash", [join(template, "guest", "image-record.sh"), template, "desktop", out], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const record = parseImageRecord(JSON.parse(readFileSync(join(out, "image.json"), "utf8")))!;
  assert.equal(record.pins, await pinsDigest(SETUP, "linux-desktop"), "the pins it was built from, not the versions");
  // Chrome as this machine has it installed, else as the pins say.
  const installed = spawnSync("sh", ["-c", "dpkg-query -W -f='${Status} ${Version}' google-chrome-stable 2>/dev/null | sed -n 's/^install ok installed \\([0-9.]*\\)-.*/\\1/p'"], { encoding: "utf8" }).stdout.trim();
  assert.deepEqual([record.tools.codex, record.tools.gh, record.tools.chrome, record.aptSnapshot], [NEXT, NEXT, installed || "999.0.0.1", "20261003T000000Z"]);
});

test("bb box images versions says what a rebuild takes, a line per tool, its architectures together where they agree", () => {
  const tool = (name: string, arch: string, pinned: string, version: string, source: string, kept: string | null = null) => ({ name, arch, pinned, version, source, kept });
  const text = versionsText({
    resolvedAt: "2026-10-03T02:15:00.000Z",
    following: true,
    aptSnapshot: { pinned: "20260926T060000Z", version: "20261003T000000Z" },
    tools: [
      tool("claude-code", "x86_64", "2.1.283", "2.1.288", "latest channel; manifest.json SHA-256 of 2.1.288"),
      tool("claude-code", "arm64", "2.1.283", "2.1.288", "latest channel; manifest.json SHA-256 of 2.1.288"),
      tool("gh", "x86_64", "2.101.0", "2.101.0", "GitHub release asset digest for cli/cli v2.101.0"),
      tool("gh", "arm64", "2.101.0", "2.101.0", "", "upstream could not be read: HTTP 403"),
    ],
    files: { "pins.json": "", "desktop-pins.tsv": "", "apt-snapshot": "" },
  });
  assert.equal(
    text,
    [
      "A rebuild of the standard Linux images now takes, against this bb-box's pins:",
      "  claude-code 2.1.288, pinned 2.1.283, for x86_64 and arm64: latest channel; manifest.json SHA-256 of 2.1.288.",
      "  gh 2.101.0, as pinned, for x86_64: nothing newer.",
      "  gh 2.101.0, as pinned, for arm64: upstream could not be read: HTTP 403.",
      "  apt snapshot 20261003T000000Z, pinned 20260926T060000Z.",
    ].join("\n"),
  );
});
