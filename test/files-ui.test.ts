import assert from "node:assert/strict";
import { test } from "node:test";
import { createdPath, movedPath, renamedPath } from "../src/app/files-ui/entry-name.ts";
import { groupHits, visibleNames } from "../src/app/files-ui/group-hits.ts";
import { DEFAULT_EXPLORER_PX, showsOneSurface } from "../src/app/files-ui/layout.ts";
import { absoluteFrom, sourcePath } from "../src/app/files-ui/locate.ts";

test("a file path joins under the folder in the path bar", () => {
  assert.equal(absoluteFrom("linux", "/home/box", "src/app.ts"), "/home/box/src/app.ts");
  assert.equal(absoluteFrom("linux", "/home/box", ""), "/home/box");
  assert.equal(absoluteFrom("windows", "C:\\Users\\box", "src/app.ts"), "C:\\Users\\box\\src\\app.ts");
  assert.equal(absoluteFrom("linux", "/home/box", "../etc/passwd"), null);
});

test("names that start with a dot stay out until hidden is on", () => {
  assert.deepEqual(visibleNames([".env", "src/.keep", "src/app.ts"], false), ["src/app.ts"]);
  assert.deepEqual(visibleNames([".env", "src/app.ts"], true), [".env", "src/app.ts"]);
});

test("search hits group by file and mark the query", () => {
  const preview = 'export const greeting = "lantern";';
  const start = preview.indexOf("lantern");
  const grouped = groupHits(
    [
      { path: "src/app.ts", line: 1, column: 1, preview },
      { path: "src/app.ts", line: 2, column: 1, preview: "lantern again" },
      { path: "notes.md", line: 1, column: 1, preview: "A lantern in the box." },
    ],
    false,
    "lantern",
    { matchCase: false, wholeWord: false, regex: false },
  );
  assert.equal(grouped.status, "ok");
  if (grouped.status !== "ok") return;
  assert.equal(grouped.files.length, 2);
  assert.equal(grouped.files[0]?.matchCount, 2);
  assert.deepEqual(grouped.files[0]?.matches[0]?.ranges, [[start, start + "lantern".length]]);
  assert.equal(grouped.totalMatches, 3);
});

test("a new name stays under its folder, and a rename keeps the parent", () => {
  assert.equal(createdPath("", "notes.md"), "notes.md");
  assert.equal(createdPath("src", "app.ts"), "src/app.ts");
  assert.equal(createdPath("src", "../outside"), null);
  assert.equal(createdPath("src", "a/b"), null);
  assert.equal(renamedPath("src/app.ts", "main.ts"), "src/main.ts");
  assert.equal(renamedPath("notes.md", "readme.md"), "readme.md");
  assert.equal(movedPath("src/app.ts", "src", "lib"), "lib/app.ts");
  assert.equal(movedPath("notes.md", "src", "lib"), null);
});

test("a wide window keeps the tree beside the file, and a narrow one shows one at a time", () => {
  assert.equal(DEFAULT_EXPLORER_PX, 360);
  assert.equal(showsOneSurface(1440), false);
  assert.equal(showsOneSurface(390), true);
});

test("the source path keeps the file name, so syntax colours still see the extension", () => {
  assert.equal(sourcePath("src/app.ts", "abc-20"), "src/abc-20/app.ts");
  assert.equal(sourcePath("notes.md", "open-12").endsWith("notes.md"), true);
});
