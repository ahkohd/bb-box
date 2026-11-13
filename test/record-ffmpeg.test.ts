import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { CLIP_FFMPEG_DIR, CLIP_FFMPEG_EXITS, FFMPEG_BUILDS, clipFfmpegScript, parseClipFfmpeg, useClipFfmpeg, type FfmpegBuild } from "../src/core/record-ffmpeg.ts";
import { tempDir } from "./helpers.ts";

const skip = process.platform === "linux" ? false : "needs GNU tar";

const EVERY_FILTER = ["overlay", "geq", "freezedetect", "tpad", "drawtext"];
const HOMEBREW_FILTERS = ["overlay", "geq", "freezedetect", "tpad"];
const WORKING_FFPROBE = "#!/bin/sh\necho h264\n";
const BROKEN = "#!/bin/sh\necho broken >&2\nexit 42\n";
const NOT_INSTALLED = "#!/bin/sh\necho 'not found' >&2\nexit 127\n";

function fakeFfmpegScript(version: string, filters: readonly string[], says = "ffmpeg"): string {
  return `#!/bin/sh
case "$*" in
  *-filters*) printf ' Filters:\\n${filters.map((filter) => ` TS ${filter}              V->V       A filter.\\n`).join("")}' ;;
  *-encoders*) printf ' V....D libx264              libx264 H.264\\n' ;;
  *-version*) printf 'ffmpeg version ${version} Copyright (c) 2000-2026 the FFmpeg developers\\n'; echo "${says}" >&2 ;;
  *"-f lavfi"*) for a; do out=$a; done; echo frame > "$out" ;;
esac
`;
}

function executable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function hostWithItsOwnFfmpeg(): string {
  const host = tempDir("clip-ffmpeg-host");
  executable(join(host, "ffmpeg"), fakeFfmpegScript("6.1.1", EVERY_FILTER, "the test machine's ffmpeg"));
  executable(join(host, "ffprobe"), WORKING_FFPROBE);
  return host;
}

interface FakeBox {
  readonly home: string;
  readonly bin: string;
  readonly net: string;
  readonly host: string;
}

interface Own {
  readonly version: string;
  readonly filters: readonly string[];
  readonly ffprobe?: string;
}

function fakeBox(system: string, machine: string, own: Own | null): FakeBox {
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
  executable(join(bin, "ffmpeg"), own ? fakeFfmpegScript(own.version, own.filters, "the box's own ffmpeg") : NOT_INSTALLED);
  executable(join(bin, "ffprobe"), own ? (own.ffprobe ?? WORKING_FFPROBE) : NOT_INSTALLED);
  return { home, bin, net, host: hostWithItsOwnFfmpeg() };
}

function run(box: FakeBox, script: string) {
  return spawnSync("sh", ["-c", script], { env: { PATH: `${box.bin}:${box.host}:/usr/bin:/bin`, HOME: box.home }, encoding: "utf8" });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function linuxArchive(box: FakeBox, folder: string, filters: readonly string[], ffprobe = WORKING_FFPROBE): { readonly name: string; readonly sha256: string } {
  const staging = tempDir("clip-ffmpeg-staging");
  mkdirSync(join(staging, folder, "bin"), { recursive: true });
  executable(join(staging, folder, "bin", "ffmpeg"), fakeFfmpegScript("9.0.2", filters, "the fetched ffmpeg"));
  executable(join(staging, folder, "bin", "ffprobe"), ffprobe);
  const name = `${folder}.tar.xz`;
  assert.equal(spawnSync("tar", ["-cJf", join(box.net, name), "-C", staging, folder]).status, 0);
  return { name, sha256: sha256(join(box.net, name)) };
}

function macArchive(box: FakeBox, member: "ffmpeg" | "ffprobe"): { readonly name: string; readonly sha256: string } {
  const staging = tempDir("clip-ffmpeg-zip");
  executable(join(staging, member), member === "ffmpeg" ? fakeFfmpegScript("9.0.2", EVERY_FILTER, "the fetched ffmpeg") : WORKING_FFPROBE);
  const name = `${member}.zip`;
  assert.equal(spawnSync("zip", ["-q", "-j", join(box.net, name), join(staging, member)]).status, 0);
  return { name, sha256: sha256(join(box.net, name)) };
}

const FOLDER = "ffmpeg-n9.0.2-linux64-gpl-9.0";

function linuxBuild(archive: { readonly name: string; readonly sha256: string }): FfmpegBuild {
  return {
    os: "linux",
    arch: "x86_64",
    version: "9.0.2",
    from: "a test",
    licence: "GPL version 3",
    downloads: [{ url: `https://example.com/builds/${archive.name}`, sha256: archive.sha256, bytes: 1, unpack: "tar.xz", ffmpeg: `${FOLDER}/bin/ffmpeg`, ffprobe: `${FOLDER}/bin/ffprobe` }],
  };
}

function fetches(box: FakeBox): string[] {
  return existsSync(join(box.home, "fetched")) ? readFileSync(join(box.home, "fetched"), "utf8").trim().split("\n") : [];
}

function installedBuild(box: FakeBox, name: string, ffmpeg: string, ffprobe = WORKING_FFPROBE): string {
  const folder = join(box.home, CLIP_FFMPEG_DIR, name);
  mkdirSync(folder, { recursive: true });
  executable(join(folder, "ffmpeg"), ffmpeg);
  executable(join(folder, "ffprobe"), ffprobe);
  writeFileSync(join(folder, "sums"), `${sha256(join(folder, "ffmpeg"))} ${sha256(join(folder, "ffprobe"))}\n`);
  return folder;
}

function clipRuns(box: FakeBox, stdout: string): string {
  const pair = parseClipFfmpeg(stdout)!.pair;
  return run(box, `${useClipFfmpeg(pair)}\nffmpeg -version`).stderr.trim();
}

test("a box whose own ffmpeg and ffprobe make a test frame keeps them, and fetches nothing (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "6.1.1-3ubuntu5", filters: EVERY_FILTER });

  const ready = run(box, clipFfmpegScript("linux"));

  assert.equal(ready.status, CLIP_FFMPEG_EXITS.ready, ready.stderr);
  const said = parseClipFfmpeg(ready.stdout)!;
  assert.deepEqual([said.ffmpeg, said.version, said.missing, said.pair], ["own", "6.1.1", [], { ffmpeg: join(box.bin, "ffmpeg"), ffprobe: join(box.bin, "ffprobe") }]);
  assert.deepEqual(fetches(box), []);
});

test("an Android host with no ffmpeg gets the pinned build for its OS and architecture, checked against its SHA-256, in a private folder, and keeps it for the next recording (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));

  const fetched = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  const said = parseClipFfmpeg(fetched.stdout)!;
  assert.deepEqual([said.ffmpeg, said.version, said.missing], ["fetched", "9.0.2", ["ffmpeg"]]);
  assert.deepEqual(fetches(box), [build.downloads[0]!.url]);
  assert.equal(dirname(dirname(said.pair.ffmpeg)), join(box.home, CLIP_FFMPEG_DIR));
  assert.equal(lstatSync(join(box.home, CLIP_FFMPEG_DIR)).mode & 0o777, 0o700, "only the box user reaches the cache");
  assert.equal(clipRuns(box, fetched.stdout), "the fetched ffmpeg", "the clip's scripts run the pair it chose");

  const again = run(box, clipFfmpegScript("linux", [build]));

  assert.deepEqual([parseClipFfmpeg(again.stdout)?.ffmpeg, parseClipFfmpeg(again.stdout)?.pair], ["kept", said.pair]);
  assert.equal(fetches(box).length, 1, "fetched once");
});

test("a Linux box whose own ffmpeg cannot draw captions gets the pinned build too, as drawtext draws them there (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "7.1", filters: HOMEBREW_FILTERS });
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));

  const fetched = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  assert.deepEqual(parseClipFfmpeg(fetched.stdout)?.missing, ["drawtext"]);
});

test("a Mac's Homebrew ffmpeg without drawtext serves, as AppKit draws a Mac's captions (063)", { skip }, () => {
  const box = fakeBox("Darwin", "arm64", { version: "9.0.2", filters: HOMEBREW_FILTERS });

  const ready = run(box, clipFfmpegScript("macos"));

  assert.equal(parseClipFfmpeg(ready.stdout)?.ffmpeg, "own", ready.stderr);
  assert.deepEqual(fetches(box), []);
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
  assert.equal(fetches(box).length, 2);
});

test("a download that does not match its SHA-256 is not used, and the box keeps no ffmpeg from it (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild({ ...linuxArchive(box, FOLDER, EVERY_FILTER), sha256: "0".repeat(64) });

  const refused = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(refused.status, CLIP_FFMPEG_EXITS.mismatch);
  assert.match(refused.stderr, /did not match its SHA-256, so BB Box did not use it/);
  assert.equal(refused.stdout, "", "no pair is offered");
});

test("a box that cannot reach the download says why, and one with no build for its architecture says what it lacks (063)", { skip }, () => {
  const offline = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild({ name: "missing.tar.xz", sha256: "0".repeat(64) });

  const failed = run(offline, clipFfmpegScript("linux", [build]));

  assert.equal(failed.status, CLIP_FFMPEG_EXITS.fetchFailed);
  assert.match(failed.stderr, /could not fetch https:\/\/example\.com\/builds\/missing\.tar\.xz: curl: \(6\) Could not resolve host/);

  const riscv = fakeBox("Linux", "riscv64", { version: "6.1", filters: HOMEBREW_FILTERS });
  const none = run(riscv, clipFfmpegScript("linux", [build]));

  assert.equal(none.status, CLIP_FFMPEG_EXITS.noBuild);
  assert.equal(none.stderr.trim(), "drawtext");
});

test("an install whose last step fails is not reported ready, and an earlier build that still works is kept and used (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));
  executable(join(box.bin, "mv"), `#!/bin/sh\ncase "$1" in */fetch.*/bin) echo "mv: No space left on device" >&2; exit 1 ;; esac\nexec /bin/mv "$@"\n`);

  const failed = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(failed.status, CLIP_FFMPEG_EXITS.publishFailed, failed.stdout);
  assert.match(failed.stderr, /No space left on device\nBB Box could not put ffmpeg 9\.0\.2 in place in /);
  assert.equal(failed.stdout, "", "no pair is offered");

  const earlier = installedBuild(box, "earlier-build", fakeFfmpegScript("8.0.1", EVERY_FILTER, "the earlier build"));
  const kept = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(kept.status, CLIP_FFMPEG_EXITS.ready, kept.stderr);
  assert.deepEqual([parseClipFfmpeg(kept.stdout)?.ffmpeg, parseClipFfmpeg(kept.stdout)?.pair.ffmpeg], ["kept", join(earlier, "ffmpeg")]);
  assert.ok(existsSync(join(earlier, "ffmpeg")), "the earlier build stays until a new one is in place");
});

function cachedFolderOf(build: FfmpegBuild): string {
  return build.downloads.map((download) => download.sha256.slice(0, 12)).join("-");
}

test("a cached build that does not run is passed over, and the clip's scripts run the pair readiness chose, not whatever the cache holds (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "6.1.1", filters: EVERY_FILTER });
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));
  installedBuild(box, cachedFolderOf(build), BROKEN);

  const ready = run(box, clipFfmpegScript("linux", [build]));

  assert.deepEqual([parseClipFfmpeg(ready.stdout)?.ffmpeg, parseClipFfmpeg(ready.stdout)?.pair.ffmpeg], ["own", join(box.bin, "ffmpeg")]);
  assert.equal(clipRuns(box, ready.stdout), "the box's own ffmpeg");
});

test("a broken ffprobe is not chosen, whether the box's own or a cached one (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", { version: "6.1.1", filters: EVERY_FILTER, ffprobe: BROKEN });
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));

  const fetched = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(fetched.status, CLIP_FFMPEG_EXITS.ready, fetched.stderr);
  const said = parseClipFfmpeg(fetched.stdout)!;
  assert.deepEqual([said.ffmpeg, said.missing], ["fetched", ["broken"]]);

  installedBuild(box, cachedFolderOf(build), readFileSync(said.pair.ffmpeg, "utf8"), BROKEN);
  const again = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(parseClipFfmpeg(again.stdout)?.ffmpeg, "fetched", "the cached pair with a broken ffprobe is replaced");
  assert.equal(fetches(box).length, 2);
});

test("a cached build is checked against the checksums taken when it was put in place, and a cache that is a link is refused (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));
  const said = parseClipFfmpeg(run(box, clipFfmpegScript("linux", [build])).stdout)!;
  writeFileSync(said.pair.ffmpeg, fakeFfmpegScript("9.0.2", EVERY_FILTER, "a changed ffmpeg"));

  const again = run(box, clipFfmpegScript("linux", [build]));

  assert.equal(parseClipFfmpeg(again.stdout)?.ffmpeg, "fetched", "a changed binary is fetched again");
  assert.equal(clipRuns(box, again.stdout), "the fetched ffmpeg");

  const linked = fakeBox("Linux", "x86_64", null);
  const elsewhere = tempDir("clip-ffmpeg-elsewhere");
  mkdirSync(join(linked.home, ".bb-box"), { recursive: true });
  rmSync(join(linked.home, CLIP_FFMPEG_DIR), { recursive: true, force: true });
  symlinkSync(elsewhere, join(linked.home, CLIP_FFMPEG_DIR));
  const refused = run(linked, clipFfmpegScript("linux", [linuxBuild(linuxArchive(linked, FOLDER, EVERY_FILTER))]));

  assert.equal(refused.status, CLIP_FFMPEG_EXITS.untrusted);
  assert.match(refused.stderr, /is a link, or not the box user's, so BB Box does not keep ffmpeg there\. Remove it, then start again\./);
  assert.deepEqual(fetches(linked), []);
});

test("at a recording's stop, readiness chooses among the box's own and cached pairs and never fetches (063)", { skip }, () => {
  const box = fakeBox("Linux", "x86_64", null);
  const build = linuxBuild(linuxArchive(box, FOLDER, EVERY_FILTER));

  const none = run(box, clipFfmpegScript("linux", [build], "choose"));

  assert.equal(none.status, CLIP_FFMPEG_EXITS.noneFit);
  assert.equal(none.stderr.trim(), "ffmpeg");
  assert.deepEqual(fetches(box), []);

  const fetched = parseClipFfmpeg(run(box, clipFfmpegScript("linux", [build])).stdout)!;
  const chosen = run(box, clipFfmpegScript("linux", [build], "choose"));

  assert.deepEqual([parseClipFfmpeg(chosen.stdout)?.ffmpeg, parseClipFfmpeg(chosen.stdout)?.pair], ["kept", fetched.pair]);
  assert.equal(fetches(box).length, 1);
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
