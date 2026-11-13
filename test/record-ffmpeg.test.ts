import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CLIP_FFMPEG_BIN, CLIP_FFMPEG_EXITS, FETCHED_FFMPEG_FIRST_ON_PATH, FFMPEG_BUILDS, clipFfmpegScript, parseClipFfmpeg, type FfmpegBuild } from "../src/core/record-ffmpeg.ts";
import { tempDir } from "./helpers.ts";

const skip = process.platform === "linux" ? false : "needs GNU tar";

const EVERY_FILTER = ["overlay", "geq", "freezedetect", "tpad", "drawtext"];
const HOMEBREW_FILTERS = ["overlay", "geq", "freezedetect", "tpad"];

function fakeFfmpegScript(version: string, filters: readonly string[]): string {
  return `#!/bin/sh
case "$*" in
  *-filters*) printf ' Filters:\\n${filters.map((filter) => ` TS ${filter}              V->V       A filter.\\n`).join("")}' ;;
  *-encoders*) printf ' V....D libx264              libx264 H.264\\n' ;;
  *-version*) printf 'ffmpeg version ${version} Copyright (c) 2000-2026 the FFmpeg developers\\n' ;;
esac
`;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

interface FakeBox {
  readonly home: string;
  readonly bin: string;
  readonly net: string;
}

function fakeBox(system: string, machine: string, own: { version: string; filters: readonly string[] } | null): FakeBox {
  const home = tempDir("clip-ffmpeg-home");
  const bin = tempDir("clip-ffmpeg-bin");
  const net = tempDir("clip-ffmpeg-net");
  executable(join(bin, "uname"), `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; *) echo ${system} ;; esac\n`);
  executable(
    join(bin, "curl"),
    `#!/bin/sh
while [ $# -gt 1 ]; do [ "$1" = -o ] && out=$2; shift; done
echo "$1" >> "$HOME/fetched"
file="${net}/$(basename "$1")"
[ -f "$file" ] || { echo "curl: (6) Could not resolve host: example.com" >&2; exit 6; }
cp "$file" "$out"
`,
  );
  if (own) {
    executable(join(bin, "ffmpeg"), fakeFfmpegScript(own.version, own.filters));
    executable(join(bin, "ffprobe"), "#!/bin/sh\necho ffprobe\n");
  }
  return { home, bin, net };
}

function run(box: FakeBox, script: string) {
  return spawnSync("sh", ["-c", script], { env: { PATH: `${box.bin}:/usr/bin:/bin`, HOME: box.home }, encoding: "utf8" });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function linuxArchive(box: FakeBox, folder: string, filters: readonly string[]): { readonly name: string; readonly sha256: string } {
  const staging = tempDir("clip-ffmpeg-staging");
  mkdirSync(join(staging, folder, "bin"), { recursive: true });
  executable(join(staging, folder, "bin", "ffmpeg"), fakeFfmpegScript("9.0.2", filters));
  executable(join(staging, folder, "bin", "ffprobe"), "#!/bin/sh\necho ffprobe\n");
  const name = `${folder}.tar.xz`;
  assert.equal(spawnSync("tar", ["-cJf", join(box.net, name), "-C", staging, folder]).status, 0);
  return { name, sha256: sha256(join(box.net, name)) };
}

function macArchive(box: FakeBox, member: "ffmpeg" | "ffprobe"): { readonly name: string; readonly sha256: string } {
  const staging = tempDir("clip-ffmpeg-zip");
  executable(join(staging, member), member === "ffmpeg" ? fakeFfmpegScript("9.0.2", EVERY_FILTER) : "#!/bin/sh\necho ffprobe\n");
  const name = `${member}.zip`;
  assert.equal(spawnSync("zip", ["-q", "-j", join(box.net, name), join(staging, member)]).status, 0);
  return { name, sha256: sha256(join(box.net, name)) };
}

function linuxBuild(archive: { readonly name: string; readonly sha256: string }, folder: string): FfmpegBuild {
  return {
    os: "linux",
    arch: "x86_64",
    version: "9.0.2",
    from: "a test",
    licence: "GPL version 3",
    downloads: [{ url: `https://example.com/builds/${archive.name}`, sha256: archive.sha256, bytes: 1, unpack: "tar.xz", ffmpeg: `${folder}/bin/ffmpeg`, ffprobe: `${folder}/bin/ffprobe` }],
  };
}

test("a box whose own ffmpeg has all a clip needs keeps it, and fetches nothing (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "6.1.1-3ubuntu5", filters: EVERY_FILTER });

  const ready = run(box, clipFfmpegScript("linux"));

  assert.equal(ready.status, CLIP_FFMPEG_EXITS.ready, ready.stderr);
  assert.deepEqual(parseClipFfmpeg(ready.stdout), { ffmpeg: "own", version: "6.1.1", seconds: parseClipFfmpeg(ready.stdout)!.seconds, missing: [] });
  assert.ok(!existsSync(join(box.home, "fetched")), "nothing fetched");
  assert.ok(!existsSync(join(box.home, CLIP_FFMPEG_BIN)));
});

test("an Android host with no ffmpeg gets the pinned build for its OS and architecture, checked against its SHA-256, and keeps it for the next recording (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const folder = "ffmpeg-n9.0.2-linux64-gpl-9.0";
  const build = linuxBuild(linuxArchive(box, folder, EVERY_FILTER), folder);

  const fetched = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  const said = parseClipFfmpeg(fetched.stdout)!;
  assert.deepEqual([said.ffmpeg, said.version, said.missing], ["fetched", "9.0.2", ["ffmpeg"]]);
  assert.deepEqual(readFileSync(join(box.home, "fetched"), "utf8").trim().split("\n"), [build.downloads[0]!.url]);
  assert.ok(existsSync(join(box.home, CLIP_FFMPEG_BIN, "ffmpeg")) && existsSync(join(box.home, CLIP_FFMPEG_BIN, "ffprobe")));

  const again = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(parseClipFfmpeg(again.stdout)?.ffmpeg, "kept");
  assert.equal(readFileSync(join(box.home, "fetched"), "utf8").trim().split("\n").length, 1, "fetched once");
  assert.equal(run(box, `${FETCHED_FFMPEG_FIRST_ON_PATH}\ncommand -v ffmpeg`).stdout.trim(), join(box.home, CLIP_FFMPEG_BIN, "ffmpeg"), "the clip's scripts use it");
});

test("a Linux box whose own ffmpeg cannot draw captions gets the pinned build too, as drawtext draws them there (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "7.1", filters: HOMEBREW_FILTERS });
  const folder = "ffmpeg-n9.0.2-linux64-gpl-9.0";
  const build = linuxBuild(linuxArchive(box, folder, EVERY_FILTER), folder);

  const fetched = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  assert.deepEqual(parseClipFfmpeg(fetched.stdout)?.missing, ["drawtext"]);
});

test("a Mac's Homebrew ffmpeg without drawtext serves, as AppKit draws a Mac's captions (063)", { skip }, () => {
  const box = fakeBox("Darwin", "arm64", { version: "9.0.2", filters: HOMEBREW_FILTERS });

  const ready = run(box, clipFfmpegScript("macos"));

  assert.equal(parseClipFfmpeg(ready.stdout)?.ffmpeg, "own", ready.stderr);
  assert.ok(!existsSync(join(box.home, "fetched")));
});

test("a shared iOS host with no ffmpeg gets the pinned macOS build, ffmpeg and ffprobe each from its own archive, with no root (064)", { skip }, () => {
  const box = fakeBox("Darwin", "arm64", null);
  const ffmpeg = macArchive(box, "ffmpeg");
  const ffprobe = macArchive(box, "ffprobe");
  const build: FfmpegBuild = {
    os: "macos",
    arch: "arm64",
    version: "9.0.2",
    from: "a test",
    licence: "GPL version 3",
    downloads: [
      { url: `https://example.com/mac/${ffmpeg.name}`, sha256: ffmpeg.sha256, bytes: 1, unpack: "zip", ffmpeg: "ffmpeg" },
      { url: `https://example.com/mac/${ffprobe.name}`, sha256: ffprobe.sha256, bytes: 1, unpack: "zip", ffprobe: "ffprobe" },
    ],
  };

  const fetched = run(box, clipFfmpegScript("macos", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  assert.equal(parseClipFfmpeg(fetched.stdout)?.ffmpeg, "fetched");
  assert.equal(readFileSync(join(box.home, "fetched"), "utf8").trim().split("\n").length, 2);
  assert.ok(existsSync(join(box.home, CLIP_FFMPEG_BIN, "ffprobe")));
});

test("a download that does not match its SHA-256 is not used, and the box keeps no ffmpeg from it (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const folder = "ffmpeg-n9.0.2-linux64-gpl-9.0";
  const archive = linuxArchive(box, folder, EVERY_FILTER);
  const build = linuxBuild({ ...archive, sha256: "0".repeat(64) }, folder);

  const refused = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(refused.status, CLIP_FFMPEG_EXITS.mismatch);
  assert.match(refused.stderr, /did not match its SHA-256, so BB Box did not use it/);
  assert.ok(!existsSync(join(box.home, CLIP_FFMPEG_BIN)));
});

test("a box that cannot reach the download says why, and one with no build for its architecture says what it lacks (063)", { skip }, () => {
  const offline = fakeBox("Linux", "x86_64", null);
  const folder = "ffmpeg-n9.0.2-linux64-gpl-9.0";
  const build = linuxBuild({ name: "missing.tar.xz", sha256: "0".repeat(64) }, folder);

  const failed = run(offline, clipFfmpegScript("linux", [build]));

  assert.equal(failed.status, CLIP_FFMPEG_EXITS.fetchFailed);
  assert.match(failed.stderr, /could not fetch https:\/\/example\.com\/builds\/missing\.tar\.xz: curl: \(6\) Could not resolve host/);

  const riscv = fakeBox("Linux", "riscv64", { version: "6.1", filters: HOMEBREW_FILTERS });
  const none = run(riscv, clipFfmpegScript("linux", [build]));

  assert.equal(none.status, CLIP_FFMPEG_EXITS.noBuild);
  assert.equal(none.stderr.trim(), "drawtext");
});

test("the pinned builds are GPL builds from named places, over HTTPS, each with its SHA-256, for Linux on x86_64 and arm64 and macOS on arm64 (063)", () => {
  assert.deepEqual(FFMPEG_BUILDS.map((build) => `${build.os}/${build.arch}`), ["linux/x86_64", "linux/arm64", "macos/arm64"]);
  for (const build of FFMPEG_BUILDS) {
    assert.match(build.licence, /^GPL/);
    assert.ok(build.from.length > 10);
    const members = build.downloads.flatMap((download) => [download.ffmpeg, download.ffprobe].filter(Boolean));
    assert.equal(members.length, 2, `${build.os}/${build.arch} gives ffmpeg and ffprobe`);
    for (const download of build.downloads) {
      assert.match(download.url, /^https:\/\//);
      assert.match(download.sha256, /^[0-9a-f]{64}$/);
    }
  }
});
