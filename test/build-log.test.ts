import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BuildLog } from "../src/core/build-log.ts";
import { tempDir } from "./helpers.ts";

test("a build's whole output goes to its own file, and only a step's first line and build.sh's own lines are given for the plugin's log", () => {
  const dir = tempDir("build-log");
  const log = new BuildLog("bbbox/linux:1", Date.parse("2026-10-25T18:00:00Z"), dir);
  const given = [
    "#14 [linux 4/9] RUN apt-get update",
    "#14 12.3 Get:317 https://snapshot.ubuntu.com/ubuntu resolute/universe amd64 ffmpeg",
    "#14 12.4 Get:318 https://snapshot.ubuntu.com/ubuntu resolute/main amd64 fonts-noto-cjk",
    "#14 [linux 4/9] RUN apt-get update",
    "#14 DONE 98.1s",
    "#15 [linux 5/9] COPY docker/start /usr/local/sbin/bb-box-start",
    "\u001b[1mbuilt bbbox/linux:1\u001b[0m",
    "",
  ].map((line) => log.write(line));
  assert.deepEqual(given, ["#14 [linux 4/9] RUN apt-get update", null, null, null, null, "#15 [linux 5/9] COPY docker/start /usr/local/sbin/bb-box-start", "built bbbox/linux:1", null]);
  assert.equal(readFileSync(log.path, "utf8").split("\n").filter(Boolean).length, 7, "every line but the empty one is in the file");
  assert.match(log.path, /bbbox-linux-1-2026-10-25T18-00-00-000Z\.log$/);
});

test("the newest five build files of an image are kept, and older ones go", () => {
  const dir = tempDir("build-log");
  for (let i = 0; i < 7; i++) new BuildLog("bbbox/linux:1", Date.parse("2026-10-25T18:00:00Z") + i * 60_000, dir);
  new BuildLog("bbbox/linux-desktop:1", Date.parse("2026-10-25T18:00:00Z"), dir);
  const files = readdirSync(dir).sort();
  assert.equal(files.filter((file) => file.startsWith("bbbox-linux-1-")).length, 5);
  assert.ok(files.includes("bbbox-linux-1-2026-10-25T18-06-00-000Z.log"));
  assert.ok(!files.includes("bbbox-linux-1-2026-10-25T18-00-00-000Z.log"));
  assert.ok(files.some((file) => file.startsWith("bbbox-linux-desktop-1-")), "another image's files stay");
  assert.ok(join(dir, files[0]!));
});
