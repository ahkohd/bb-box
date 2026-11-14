import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers.ts";
import { repositoryFiles } from "./repository-files.ts";

const HAS_GIT = spawnSync("git", ["--version"]).status === 0;

function tree(files: readonly string[]): string {
  const root = tempDir("repository-files");
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "# a page\n");
  }
  return root;
}

const markdown = (path: string) => path.endsWith(".md");
const FILES = ["README.md", "docs/guide/a.md", "docs/guide/deeper/b.md", "setup/tart/README.md", "src/x.ts", "node_modules/pkg/README.md", "dist/out.md", ".github/notes.md", "scripts/preview/out/shot.md", "scripts/preview/kept.md"];

test("a copy with no Git index, as a git archive or a tarball on a box is, lists its files from the disk, without what Git ignores or keeps in dot folders", () => {
  assert.deepEqual(repositoryFiles(tree(FILES), markdown), ["README.md", "docs/guide/a.md", "docs/guide/deeper/b.md", "scripts/preview/kept.md", "setup/tart/README.md"]);
});

test("a Git work tree lists the files Git tracks, so an untracked note is left out", { skip: !HAS_GIT && "needs git" }, () => {
  const root = tree(FILES.filter((file) => !file.startsWith("node_modules/") && !file.startsWith("dist/")));
  const git = (...args: string[]) => assert.equal(spawnSync("git", args, { cwd: root }).status, 0, args.join(" "));
  git("init", "-q");
  git("add", "--all");
  writeFileSync(join(root, "untracked-note.md"), "[nowhere](nowhere.md)\n");
  assert.deepEqual(repositoryFiles(root, markdown), [".github/notes.md", "README.md", "docs/guide/a.md", "docs/guide/deeper/b.md", "scripts/preview/kept.md", "scripts/preview/out/shot.md", "setup/tart/README.md"]);
});
