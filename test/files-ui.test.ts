import assert from "node:assert/strict";
import { test } from "node:test";
import { groupHits, visibleNames } from "../src/app/files-ui/group-hits.ts";
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

test("the source path keeps the file name, so syntax colours still see the extension", () => {
  assert.equal(sourcePath("src/app.ts", "abc-20"), "src/abc-20/app.ts");
  assert.equal(sourcePath("notes.md", "open-12").endsWith("notes.md"), true);
});
