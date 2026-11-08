import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CorpusStore,
  SearchCorpus,
  absolutePath,
  childPath,
  deletePath,
  failureWords,
  findInFile,
  listDirectory,
  listNames,
  parentPath,
  parseList,
  parseNames,
  parseRead,
  parseSearch,
  parseWarm,
  rankPaths,
  readFileAt,
  readFileRange,
  readHome,
  resolvePath,
  searchDirectory,
  searchText,
  searchUsesCorpus,
  warmDirectory,
  words,
  writeFileAt,
  createPath,
  renamePath,
  type FsBox,
  type FsRun,
  type FsRunResult,
} from "../src/core/box-fs.ts";
import {
  CORPUS_BYTES,
  IMAGE_BYTES,
  LIST_CAP,
  NAME_CAP,
  OPEN_BYTES,
  SEARCH_PER_FILE,
  WARM_OUT,
  createScript,
  deleteScript,
  homeScript,
  listScript,
  namesScript,
  rangeScript,
  readScript,
  renameScript,
  searchScript,
  warmScript,
  writeScript,
} from "../src/core/box-fs-script.ts";

const made: string[] = [];
process.once("exit", () => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `bb-box-${prefix}-`));
  made.push(dir);
  return dir;
}

const linux: FsBox = { id: "bx_files", os: "linux", state: "ready", command: true, device: false };

function sha(text: string | Uint8Array): string {
  return createHash("sha256").update(text).digest("hex");
}

function shell(script: string, stdin?: Uint8Array, env?: Record<string, string>): FsRunResult {
  const result = spawnSync("sh", ["-c", script], { input: stdin, encoding: "utf8", env: { ...process.env, ...env } });
  return { exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut: false, truncated: false };
}

function shRun(env?: Record<string, string>): FsRun {
  return async (script, options) => shell(script, options.stdin ? Buffer.from(options.stdin) : undefined, env);
}

function pathWithoutRg(): string {
  const bin = join(tempDir("fs-no-rg"), "bin");
  mkdirSync(bin);
  const lookup = "/usr/bin:/bin";
  for (const name of ["sh", "grep", "mktemp", "cat", "rm", "sha256sum", "base64", "stat", "find", "head", "tr", "wc", "cut", "dirname", "readlink"]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8", env: { ...process.env, PATH: lookup } }).stdout.trim();
    if (found) symlinkSync(found, join(bin, name));
  }
  const rest = (process.env.PATH ?? "").split(":").filter((dir) => dir && dir !== bin && !existsSync(join(dir, "rg")));
  return [bin, ...rest].join(":");
}

function searchWays(): { env: Record<string, string> | undefined; engine: "rg" | "grep" }[] {
  const ways: { env: Record<string, string> | undefined; engine: "rg" | "grep" }[] = [{ env: { PATH: pathWithoutRg() }, engine: "grep" }];
  const rg = spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" });
  if (rg.status === 0 && rg.stdout.trim()) ways.push({ env: undefined, engine: "rg" });
  return ways;
}

function sparse(path: string, bytes: number): void {
  const fd = openSync(path, "w");
  ftruncateSync(fd, bytes);
  closeSync(fd);
}

test("a guarded write leaves a file that changed, and an overwrite replaces it", async () => {
  const dir = tempDir("fs-guard");
  const path = join(dir, "note.txt");
  writeFileSync(path, "one\n");
  const opened = sha("one\n");
  writeFileSync(path, "two\n");
  chmodSync(path, 0o640);
  const before = statSync(path);
  const run = shRun();
  const conflict = await writeFileAt(linux, path, "three\n", opened, run);
  assert.equal(conflict.error, null);
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.currentSha256, sha("two\n"));
  assert.equal(readFileSync(path, "utf8"), "two\n");
  assert.equal(statSync(path).ino, before.ino);
  assert.equal(statSync(path).mode, before.mode);
  assert.equal(readFileSync(`${path}.conflict`, "utf8"), "three\n");
  assert.equal(statSync(`${path}.conflict`).mode & 0o777, 0o640);
  const replaced = await writeFileAt(linux, path, "three\n", null, run);
  assert.equal(replaced.error, null);
  assert.equal(replaced.outcome, "written");
  assert.equal(replaced.sha256, sha("three\n"));
  assert.equal(readFileSync(path, "utf8"), "three\n");
  const same = await writeFileAt(linux, path, "four\n", sha("three\n"), run);
  assert.equal(same.error, null);
  assert.equal(same.outcome, "written");
  assert.equal(readFileSync(path, "utf8"), "four\n");
});

test("a guarded write does not create a file that is gone", async () => {
  const dir = tempDir("fs-missing");
  const path = join(dir, "gone.txt");
  const answer = await writeFileAt(linux, path, "x\n", sha("old\n"), shRun());
  assert.equal(answer.error, null);
  assert.equal(answer.outcome, "conflict");
  assert.equal(answer.currentSha256, null);
  assert.equal(existsSync(path), false);
  assert.equal(readFileSync(`${path}.conflict`, "utf8"), "x\n");
  const created = await writeFileAt(linux, path, "x\n", null, shRun());
  assert.equal(created.error, null);
  assert.equal(created.outcome, "written");
  if (created.error === null && created.outcome === "written") assert.equal(created.sizeBytes, 2);
  assert.equal(readFileSync(path, "utf8"), "x\n");
});

test("a Windows write compares the hash and can refuse", () => {
  const script = writeScript("windows", "C:\\Users\\box\\note.txt", "abc", "guard");
  assert.match(script, /Get-FileHash/);
  assert.match(script, /CONFLICT/);
  assert.match(script, /\$bbFilesNow -ne \$bbFilesExpected/);
  assert.match(script, /\.conflict-/);
  assert.match(script, /CreateNew/);
  assert.doesNotMatch(script, /\$bbFilesAside/);
  assert.match(script, /Get-FileHash -Algorithm SHA256 -LiteralPath \$bbFilesTmp/);
  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.equal((script.match(/try \{ \[IO\.File\]::Copy\(\$bbFilesTmp, \$bbFilesPath, \$true\) \} catch/g) ?? []).length, 2);
  assert.equal(singleQuoted(script).some((part) => part.includes("`t")), false);
  assert.doesNotMatch(script, /printenv|Get-ChildItem Env:/);
});

test("listing a directory is one command, and a name with a newline is left out", async () => {
  const dir = tempDir("fs-list");
  writeFileSync(join(dir, "a.txt"), "a");
  mkdirSync(join(dir, "folder"));
  writeFileSync(join(dir, "bad\nname.txt"), "nope");
  let calls = 0;
  const run: FsRun = async (script, options) => {
    calls += 1;
    return shRun()(script, options);
  };
  const listed = await listDirectory(linux, dir, run);
  assert.equal(calls, 1);
  assert.equal(listed.error, null);
  if (listed.error) return;
  assert.equal(listed.truncated, false);
  assert.deepEqual(listed.entries.map((entry) => [entry.name, entry.kind]), [
    ["folder", "directory"],
    ["a.txt", "file"],
  ]);
  assert.equal(listed.entries.some((entry) => entry.name.includes("bad") || entry.name.includes("name")), false);
});

test("a directory past the cap is marked truncated", async () => {
  const dir = tempDir("fs-cap");
  for (let i = 0; i < LIST_CAP + 1; i++) writeFileSync(join(dir, `f${i}.txt`), "");
  const listed = await listDirectory(linux, dir, shRun());
  assert.equal(listed.error, null);
  if (listed.error) return;
  assert.equal(listed.truncated, true);
  assert.equal(listed.entries.length, LIST_CAP);
});

test("reading returns text, an image, a binary, and too large with no bytes", async () => {
  const dir = tempDir("fs-read");
  const text = join(dir, "note.ts");
  writeFileSync(text, "export const n = 1;\n");
  const read = await readFileAt(linux, text, shRun());
  assert.equal(read.error, null);
  if (read.error || read.kind !== "text") return assert.fail(JSON.stringify(read));
  assert.equal(read.content, "export const n = 1;\n");
  assert.equal(read.sha256, sha("export const n = 1;\n"));
  const png = join(dir, "dot.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  writeFileSync(png, bytes);
  const image = await readFileAt(linux, png, shRun());
  assert.equal(image.error, null);
  if (image.error || image.kind !== "image") return assert.fail(JSON.stringify(image));
  assert.equal(image.dataUrl.startsWith("data:image/png;base64,"), true);
  assert.equal(image.sha256, sha(bytes));
  const binary = join(dir, "data.bin");
  writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  const raw = await readFileAt(linux, binary, shRun());
  assert.equal(raw.error, null);
  if (raw.error || raw.kind !== "binary") return assert.fail(JSON.stringify(raw));
  assert.equal("content" in raw, false);
  const huge = join(dir, "huge.txt");
  sparse(huge, OPEN_BYTES + 1);
  const large = await readFileAt(linux, huge, shRun());
  assert.equal(large.error, null);
  if (large.error || large.kind !== "large") return assert.fail(JSON.stringify(large));
  assert.equal(large.sizeBytes, OPEN_BYTES + 1);
  assert.equal("content" in large, false);
  const picture = join(dir, "wide.png");
  sparse(picture, IMAGE_BYTES + 1);
  const wide = await readFileAt(linux, picture, shRun());
  assert.equal(wide.error, null);
  if (wide.error || wide.kind !== "large") return assert.fail(JSON.stringify(wide));
  const slice = await readFileRange(linux, text, 0, 7, shRun());
  assert.equal(slice.error, null);
  if (slice.error) return;
  assert.equal(slice.content, "export ");
  assert.equal(slice.sha256, sha("export const n = 1;\n"));
});

test("search uses ripgrep or grep, skips hidden files and .git, and a regex stays on the box", async () => {
  const dir = tempDir("fs-search");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "src", "app.ts"), "const needle = 1;\nconst other = 2;\n");
  writeFileSync(join(dir, ".secret"), "needle in a hidden file\n");
  writeFileSync(join(dir, ".git", "config"), "needle in git\n");
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  const script = searchScript("linux", dir, "needle", flags);
  assert.match(script, /grep -RInH /);
  assert.doesNotMatch(script, /--exclude-dir='\.\*'/);
  for (const way of searchWays()) {
    const found = await searchDirectory(linux, dir, "needle", flags, shRun(way.env), new SearchCorpus(undefined, () => 0), () => undefined);
    assert.equal(found.error, null);
    if (found.error) return;
    assert.equal(found.engine, way.engine);
    assert.deepEqual(found.hits.map((hit) => hit.path), ["src/app.ts"]);
    assert.equal(found.hits[0]?.preview.includes("needle"), true);
    const hidden = await searchDirectory(linux, dir, "needle", { ...flags, hidden: true }, shRun(way.env), new SearchCorpus(undefined, () => 0), () => undefined);
    assert.equal(hidden.error, null);
    if (hidden.error) return;
    assert.equal(hidden.hits.some((hit) => hit.path === ".secret"), true);
    assert.equal(hidden.hits.some((hit) => hit.path.includes(".git")), false);
    const pattern = await searchDirectory(linux, dir, "n..dle", { ...flags, regex: true }, shRun(way.env), new SearchCorpus(undefined, () => 0), () => undefined);
    assert.equal(pattern.error, null);
    if (pattern.error) return;
    assert.notEqual(pattern.engine, "memory");
    assert.equal(pattern.hits[0]?.path, "src/app.ts");
  }
  let calls = 0;
  const run: FsRun = async (scriptText, options) => {
    calls += 1;
    return shRun()(scriptText, options);
  };
  const corpus = new SearchCorpus(undefined, () => 0);
  corpus.load(dir, ["src/app.ts"], [{ path: "src/app.ts", text: "const needle = 1;\n", size: 18, mtime: 1 }], false);
  const memory = await searchDirectory(linux, dir, "needle", flags, run, corpus, () => undefined);
  assert.equal(calls, 0);
  assert.equal(memory.error, null);
  if (memory.error) return;
  assert.equal(memory.engine, "memory");
});

test("a warm corpus answers later searches until it is partial or stale", async () => {
  const dir = tempDir("fs-warm");
  writeFileSync(join(dir, "a.ts"), "alpha\n");
  writeFileSync(join(dir, "b.md"), "beta\n");
  let now = 1_000;
  const corpus = new SearchCorpus(undefined, () => now);
  await warmDirectory(linux, dir, shRun(), corpus);
  assert.equal(corpus.covers(dir), true);
  assert.equal(corpus.partial, false);
  const texts = corpus.texts(false).map((file) => file.text.trim()).sort();
  assert.deepEqual(texts, ["alpha", "beta"]);
  assert.equal(searchUsesCorpus(corpus, dir, { matchCase: false, wholeWord: false, regex: false, hidden: false }), true);
  assert.equal(searchUsesCorpus(corpus, dir, { matchCase: false, wholeWord: false, regex: true, hidden: false }), false);
  now += 20_000;
  assert.equal(corpus.covers(dir), false);
  const names = await listNames(linux, dir, shRun(), corpus);
  assert.equal(names.error, null);
  if (names.error) return;
  assert.deepEqual([...names.paths].sort(), ["a.ts", "b.md"]);
});

test("listing names does not make an empty corpus answer a search", async () => {
  const dir = tempDir("fs-names-then-search");
  writeFileSync(join(dir, "a.ts"), "needle\n");
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  for (const way of searchWays()) {
    let calls = 0;
    const run: FsRun = async (script, options) => {
      calls += 1;
      return shRun(way.env)(script, options);
    };
    const corpus = new SearchCorpus(undefined, () => 1_000);
    const names = await listNames(linux, dir, run, corpus);
    assert.equal(names.error, null);
    assert.equal(corpus.covers(dir), false);
    const found = await searchDirectory(linux, dir, "needle", flags, run, corpus, () => undefined);
    assert.equal(found.error, null);
    if (found.error) return;
    assert.equal(found.engine, way.engine);
    assert.equal(found.hits[0]?.path, "a.ts");
    assert.ok(calls >= 2);
  }
});

test("an empty folder stays listed after the searchable copy is warmed", async () => {
  const dir = tempDir("fs-empty-folder");
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "a.ts"), "a\n");
  const corpus = new SearchCorpus(undefined, () => 5_000);
  const first = await listNames(linux, dir, shRun(), corpus);
  assert.equal(first.error, null);
  if (first.error) return;
  assert.deepEqual([...first.paths].sort(), ["a.ts"]);
  assert.deepEqual([...first.directories].sort(), ["empty"]);
  await warmDirectory(linux, dir, shRun(), corpus);
  const again = await listNames(linux, dir, shRun(), corpus);
  assert.equal(again.error, null);
  if (again.error) return;
  assert.deepEqual([...again.directories].sort(), ["empty"]);
});

test("a folder that does not fit is not searched from memory", async () => {
  const dir = tempDir("fs-partial");
  writeFileSync(join(dir, "small.txt"), "keep\n");
  sparse(join(dir, "big.txt"), 600 * 1024);
  const corpus = new SearchCorpus(undefined, () => 5_000);
  await warmDirectory(linux, dir, shRun(), corpus);
  assert.equal(corpus.partial, true);
  assert.equal(corpus.covers(dir), false);
  assert.equal(searchUsesCorpus(corpus, dir, { matchCase: false, wholeWord: false, regex: false, hidden: true }), false);
});

test("the corpus drops the oldest text once its budget is spent", () => {
  const corpus = new SearchCorpus(1_000, () => 1);
  const files = [0, 1, 2].map((i) => ({ path: `f${i}.txt`, text: "x".repeat(200), size: 200, mtime: i }));
  corpus.load("/home/box", files.map((file) => file.path), files, false);
  assert.equal(corpus.partial, true);
  assert.equal(corpus.covers("/home/box"), false);
  assert.ok(corpus.bytes <= 1_000);
  assert.equal(corpus.texts(true).some((file) => file.path === "f0.txt"), false);
  assert.equal(corpus.texts(true).some((file) => file.path === "f2.txt"), true);
});

test("only four boxes keep a corpus", () => {
  const store = new CorpusStore(() => 1);
  const first = store.of("a");
  first.load("/home/box", ["a"], [{ path: "a", text: "a", size: 1, mtime: 1 }], false);
  for (const id of ["b", "c", "d", "e"]) store.of(id);
  const again = store.of("a");
  assert.notEqual(again, first);
  assert.equal(again.root, "");
});

test("a failure never repeats the box's output", () => {
  const message = failureWords({ exitCode: 1, stdout: "ERR\tSECRET\ntoken=abc\n", stderr: "TOKEN=xyz\n", timedOut: false, truncated: false });
  assert.equal(message, words("failed"));
  assert.equal(message.includes("SECRET"), false);
  assert.equal(message.includes("TOKEN"), false);
  assert.equal(message.includes("token"), false);
  const listed = parseList("ERR\tnot-a-password\npassword=hunter2\n");
  assert.equal(listed.error, words("failed"));
  assert.equal(listed.error?.includes("hunter2"), false);
  const read = parseRead("ERR\tGH_TOKEN\n");
  assert.equal(read.error, words("failed"));
  assert.equal(read.error?.includes("GH_TOKEN"), false);
});

test("a device box, a box with no shell, and a box that is not ready are refused before a command", async () => {
  let calls = 0;
  const run: FsRun = async () => {
    calls += 1;
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false };
  };
  const device = await listDirectory({ ...linux, device: true }, "/home/box", run);
  const quiet = await listDirectory({ ...linux, command: false }, "/home/box", run);
  const stopped = await readFileAt({ ...linux, state: "stopped" }, "/home/box/a", run);
  assert.equal(calls, 0);
  assert.match(device.error ?? "", /device box/);
  assert.match(quiet.error ?? "", /no shell/);
  assert.match(stopped.error ?? "", /not ready/);
  const bad = await listDirectory(linux, "notes", run);
  assert.equal(calls, 0);
  assert.match(bad.error ?? "", /path/);
});

test("create, rename and delete refuse the home directory", async () => {
  const dir = tempDir("fs-edit");
  const home = dir;
  const made = join(dir, "made.txt");
  const run = shRun();
  const created = await createPath(linux, made, "file", run);
  assert.equal(created.error, null);
  assert.equal(readFileSync(made, "utf8"), "");
  const folder = join(dir, "dir");
  assert.equal((await createPath(linux, folder, "directory", run)).error, null);
  assert.equal(existsSync(folder), true);
  const renamed = join(dir, "renamed.txt");
  assert.equal((await renamePath(linux, made, renamed, run)).error, null);
  assert.equal(existsSync(made), false);
  assert.equal(existsSync(renamed), true);
  const refused = await deletePath(linux, home, home, run);
  assert.match(refused.error ?? "", /cannot be changed/);
  assert.equal(existsSync(home), true);
  assert.equal((await deletePath(linux, renamed, home, run)).error, null);
  assert.equal(existsSync(renamed), false);
  assert.equal((await deletePath(linux, "/", home, run)).error !== null, true);
  assert.equal((await createPath(linux, "/", "directory", run)).error !== null, true);
});

test("paths collapse dot segments and stay absolute", () => {
  assert.equal(absolutePath("linux", "/home/box/../box/./a"), "/home/box/a");
  assert.equal(absolutePath("linux", "a"), null);
  assert.equal(absolutePath("linux", "/a\nb"), null);
  assert.equal(absolutePath("windows", "C:\\Users\\box\\..\\box\\a"), "C:\\Users\\box\\a");
  assert.equal(absolutePath("windows", "C:/Users/box"), "C:\\Users\\box");
  assert.equal(parentPath("windows", "C:\\"), "C:\\");
  assert.equal(parentPath("linux", "/home/box"), "/home");
  assert.equal(parentPath("linux", "/"), "/");
  assert.equal(resolvePath("linux", "/home/box", "src/a.ts"), "/home/box/src/a.ts");
  assert.equal(resolvePath("linux", "/home/box", "/tmp"), "/tmp");
  assert.equal(childPath("linux", "/home/box", ".."), null);
  assert.equal(childPath("windows", "C:\\Users\\box", "a.txt"), "C:\\Users\\box\\a.txt");
});

test("search in memory and go to file rank the way the panel asks", () => {
  const found = searchText([{ path: "a.ts", text: "Hello hello\nhelloworld hello\n" }], "hello", { matchCase: false, wholeWord: true });
  assert.deepEqual(found.hits.map((hit) => hit.line), [1, 1, 2]);
  const exact = searchText([{ path: "a.ts", text: "Hello hello\n" }], "Hello", { matchCase: false, wholeWord: false });
  assert.equal(exact.hits.length, 1);
  assert.equal(exact.hits[0]?.column, 1);
  assert.deepEqual(findInFile("ab hello ab", "hello", false).map((hit) => hit.start), [3]);
  assert.deepEqual(rankPaths(["src/App.tsx", "src/app.ts", "readme.md"], "app"), ["src/app.ts", "src/App.tsx"]);
});

test("home is the box user's home", async () => {
  const dir = tempDir("fs-home");
  const home = await readHome(linux, shRun({ HOME: dir }));
  assert.equal(home.error, null);
  if (home.error) return;
  assert.equal(home.path, dir);
});

test("a save writes through the file, so the mode and a symlink stay", async () => {
  const dir = tempDir("fs-mode");
  const path = join(dir, "run.sh");
  writeFileSync(path, "echo one\n");
  chmodSync(path, 0o755);
  const before = statSync(path);
  const wrote = await writeFileAt(linux, path, "echo two\n", sha("echo one\n"), shRun());
  assert.equal(wrote.error, null);
  assert.equal(wrote.outcome, "written");
  const after = statSync(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o755);
  assert.equal(readFileSync(path, "utf8"), "echo two\n");
  assert.equal(existsSync(`${path}.conflict`), false);
  const target = join(dir, "target.txt");
  const link = join(dir, "link.txt");
  writeFileSync(target, "old\n");
  chmodSync(target, 0o755);
  const targetIno = statSync(target).ino;
  symlinkSync(target, link);
  const linked = await writeFileAt(linux, link, "new\n", sha("old\n"), shRun());
  assert.equal(linked.error, null);
  assert.equal(linked.outcome, "written");
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), "new\n");
  assert.equal(statSync(target).ino, targetIno);
  assert.equal(statSync(target).mode & 0o777, 0o755);
});

test("an existing conflict file is kept, and the next name is used", async () => {
  const dir = tempDir("fs-conflict-next");
  const path = join(dir, "note.txt");
  writeFileSync(path, "two\n");
  writeFileSync(`${path}.conflict`, "keep\n");
  const answer = await writeFileAt(linux, path, "three\n", sha("one\n"), shRun());
  assert.equal(answer.error, null);
  assert.equal(answer.outcome, "conflict");
  assert.equal(readFileSync(path, "utf8"), "two\n");
  assert.equal(readFileSync(`${path}.conflict`, "utf8"), "keep\n");
  assert.equal(readFileSync(`${path}.conflict-2`, "utf8"), "three\n");
});

test("a conflict file that is a link is not followed", async () => {
  const dir = tempDir("fs-conflict-link");
  const path = join(dir, "note.txt");
  const other = join(dir, "other.txt");
  writeFileSync(path, "two\n");
  writeFileSync(other, "safe\n");
  symlinkSync(other, `${path}.conflict`);
  const answer = await writeFileAt(linux, path, "three\n", sha("one\n"), shRun());
  assert.equal(answer.error, null);
  assert.equal(answer.outcome, "conflict");
  assert.equal(readFileSync(path, "utf8"), "two\n");
  assert.equal(readFileSync(other, "utf8"), "safe\n");
  assert.equal(lstatSync(`${path}.conflict`).isSymbolicLink(), true);
  assert.equal(readFileSync(`${path}.conflict-2`, "utf8"), "three\n");
});

function lnThatTakesTheConflictName(dir: string, kind: "dir" | "link"): string {
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "kind"), kind);
  writeFileSync(
    join(bin, "ln"),
    `#!/bin/sh
list=\$(mktemp)
for arg in "\$@"; do printf '%s\\n' "\$arg" >> "\$list"; done
dest=\$(tail -n 1 "\$list")
case "\$dest" in
  *.bbprobe) rm -f "\$list"; exit 1 ;;
  *.conflict)
    if [ ! -e "\$dest" ] && [ ! -L "\$dest" ]; then
      if [ "\$(cat '${dir}/kind')" = link ]; then mkdir "\$dest.dir"; /bin/ln -s "\$dest.dir" "\$dest"; else mkdir "\$dest"; fi
    fi
    ;;
esac
set --
while IFS= read -r arg; do
  [ "\$arg" = -T ] && continue
  set -- "\$@" "\$arg"
done < "\$list"
rm -f "\$list"
exec /bin/ln "\$@"
`,
  );
  chmodSync(join(bin, "ln"), 0o755);
  return bin;
}

test("a conflict name that appears as a directory, or a link to one, is left alone", async () => {
  for (const kind of ["dir", "link"] as const) {
    const dir = tempDir(`fs-conflict-${kind}`);
    const path = join(dir, "note.txt");
    writeFileSync(path, "two\n");
    const answer = await writeFileAt(linux, path, "three\n", sha("one\n"), shRun({ PATH: `${lnThatTakesTheConflictName(dir, kind)}:${process.env.PATH ?? "/usr/bin:/bin"}` }));
    assert.equal(answer.error, null);
    assert.equal(answer.outcome, "conflict");
    assert.equal(readFileSync(path, "utf8"), "two\n");
    if (kind === "dir") {
      assert.equal(lstatSync(`${path}.conflict`).isDirectory(), true);
      assert.deepEqual(readdirSync(`${path}.conflict`), []);
    } else {
      assert.equal(lstatSync(`${path}.conflict`).isSymbolicLink(), true);
      assert.deepEqual(readdirSync(`${path}.conflict.dir`), []);
    }
    assert.equal(readFileSync(`${path}.conflict-2`, "utf8"), "three\n");
  }
  assert.match(writeScript("linux", "/tmp/note.txt", "abc", "guard"), /ln -T /);
});

test("a conflict file is still written when the box cannot make a hard link", async () => {
  const dir = tempDir("fs-nolink");
  const path = join(dir, "note.txt");
  writeFileSync(path, "two\n");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ln"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(bin, "ln"), 0o755);
  const answer = await writeFileAt(linux, path, "three\n", sha("one\n"), shRun({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }));
  assert.equal(answer.error, null);
  assert.equal(answer.outcome, "conflict");
  assert.equal(readFileSync(path, "utf8"), "two\n");
  assert.equal(readFileSync(`${path}.conflict`, "utf8"), "three\n");
  assert.match(writeScript("linux", path, "abc", "guard"), /set -C/);
});

test("a write that does not finish is a failure", async () => {
  const crashed: FsRun = async () => ({ exitCode: 1, stdout: `WRITTEN\t${sha("x\n")}\t2\n`, stderr: "", timedOut: false, truncated: false });
  const bad = await writeFileAt(linux, "/tmp/note.txt", "x\n", null, crashed);
  assert.match(bad.error ?? "", /could not/);
  const blank: FsRun = async () => ({ exitCode: 0, stdout: "\n", stderr: "", timedOut: false, truncated: false });
  const missing = await writeFileAt(linux, "/tmp/note.txt", "x\n", null, blank);
  assert.match(missing.error ?? "", /could not/);
});

test("the saved hash is the text that was sent, even when the file changes as it is written", async () => {
  const dir = tempDir("fs-token");
  const path = join(dir, "note.txt");
  writeFileSync(path, "one\n");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const readlink = spawnSync("/bin/sh", ["-c", "command -v readlink"], { encoding: "utf8", env: { ...process.env, PATH: `/usr/bin:/bin:${process.env.PATH ?? ""}` } }).stdout.trim() || "readlink";
  writeFileSync(
    join(bin, "cat"),
    `#!/bin/sh
exec 3>&1
${readlink} /proc/\$\$/fd/3 > '${dir}/fd'
out=\$(/bin/cat '${dir}/fd')
data=\$(/bin/cat; /usr/bin/printf x)
data=\${data%x}
/usr/bin/printf '%s' "\$data"
if [ "\$out" = '${path}' ]; then /usr/bin/printf 'later\\n' > '${path}'; fi
`,
  );
  chmodSync(join(bin, "cat"), 0o755);
  const wrote = await writeFileAt(linux, path, "person\n", sha("one\n"), shRun({ PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` }));
  assert.equal(wrote.error, null);
  assert.equal(wrote.outcome, "written");
  if (wrote.error === null && wrote.outcome === "written") assert.equal(wrote.sha256, sha("person\n"));
  assert.equal(readFileSync(path, "utf8"), "later\n");
});

test("a name with a backslash keeps its hash and its place in the tree", async () => {
  const dir = tempDir("fs-backslash");
  const path = join(dir, "has\\slash.txt");
  writeFileSync(path, "one\n");
  const read = await readFileAt(linux, path, shRun());
  assert.equal(read.error, null);
  if (read.error || read.kind !== "text") return assert.fail(JSON.stringify(read));
  assert.equal(read.sha256, sha("one\n"));
  assert.equal(read.sha256.length, 64);
  const wrote = await writeFileAt(linux, path, "two\n", read.sha256, shRun());
  assert.equal(wrote.error, null);
  assert.equal(wrote.outcome, "written");
  assert.equal(readFileSync(path, "utf8"), "two\n");
  const encoded = Buffer.from("renamed back\\slash.txt").toString("base64");
  const parsed = parseNames(`NAME\t${encoded}\n`, "linux");
  assert.equal(parsed.error, null);
  if (parsed.error) return;
  assert.deepEqual(parsed.paths, ["renamed back\\slash.txt"]);
  const windows = parseNames(`NAME\t${Buffer.from("dir\\file.txt").toString("base64")}\n`, "windows");
  assert.equal(windows.error, null);
  if (windows.error) return;
  assert.deepEqual(windows.paths, ["dir/file.txt"]);
  const grep = parseSearch("ENGINE\tgrep\nrenamed back\\slash.txt:3:hello\n", "linux");
  assert.equal(grep.error, null);
  if (!grep.error) assert.equal(grep.hits[0]?.path, "renamed back\\slash.txt");
  const rgLine = JSON.stringify({ type: "match", data: { path: { text: "renamed back\\slash.txt" }, lines: { text: "hello\n" }, line_number: 3, submatches: [{ start: 0 }] } });
  const rg = parseSearch(`ENGINE\trg\n${rgLine}\n`, "linux");
  assert.equal(rg.error, null);
  if (!rg.error) assert.equal(rg.hits[0]?.path, "renamed back\\slash.txt");
  const warmed = parseWarm(`NAME\t${encoded}\nFILE\t${encoded}\t6\t1\n${Buffer.from("hello\n").toString("base64")}\nENDFILE\n`, "linux");
  assert.equal(warmed.names[0], "renamed back\\slash.txt");
  assert.equal(warmed.files[0]?.path, "renamed back\\slash.txt");
  const winHit = parseSearch("ENGINE\tgrep\nsrc\\app.ts:2:hello\n", "windows");
  assert.equal(winHit.error, null);
  if (!winHit.error) assert.equal(winHit.hits[0]?.path, "src/app.ts");
});

test("a search that is cut short keeps the first hits", async () => {
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  const script = searchScript("linux", "/home/box", "the", flags);
  assert.match(script, new RegExp(`--max-count' '${SEARCH_PER_FILE + 1}'`));
  assert.match(script, new RegExp(`-m ${SEARCH_PER_FILE + 1}( |$)`));
  const hit = JSON.stringify({ type: "match", data: { path: { text: "a.ts" }, lines: { text: "the\n" }, line_number: 1, submatches: [{ start: 0 }] } });
  const run: FsRun = async () => ({
    exitCode: 0,
    stdout: `ENGINE\trg\n${hit}\nERR\tfailed\n`,
    stderr: "",
    timedOut: false,
    truncated: true,
  });
  const found = await searchDirectory(linux, "/home/box", "the", flags, run, new SearchCorpus(), () => undefined);
  assert.equal(found.error, null);
  if (found.error) return;
  assert.equal(found.truncated, true);
  assert.equal(found.hits.length, 1);
  assert.equal(found.hits[0]?.path, "a.ts");
  const failed: FsRun = async () => ({ exitCode: 0, stdout: "ERR\tunreadable\n", stderr: "", timedOut: false, truncated: false });
  const bad = await searchDirectory(linux, "/home/box", "the", flags, failed, new SearchCorpus(), () => undefined);
  assert.match(bad.error ?? "", /cannot be read/);
});

test("a file name with a colon stays intact in a search", async () => {
  const dir = tempDir("fs-colon");
  const name = "notes:2026.txt";
  writeFileSync(join(dir, name), "a\nb\nneedle\n");
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  for (const way of searchWays()) {
    const found = await searchDirectory(linux, dir, "needle", flags, shRun(way.env), new SearchCorpus(), () => undefined);
    assert.equal(found.error, null);
    if (found.error) return;
    assert.equal(found.engine, way.engine);
    assert.equal(found.hits[0]?.path, name);
    assert.equal(found.hits[0]?.line, 3);
    assert.equal(found.hits[0]?.preview.includes("needle"), true);
  }
  const parsed = parseSearch(`ENGINE\tgrep\nnotes:2026.txt${"\0"}3:needle\n`, "linux");
  assert.equal(parsed.error, null);
  if (!parsed.error) {
    assert.equal(parsed.hits[0]?.path, name);
    assert.equal(parsed.hits[0]?.line, 3);
  }
});

test("search finds a file that git would ignore", async () => {
  const dir = tempDir("fs-ignore");
  writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
  writeFileSync(join(dir, "secret.txt"), "needle\n");
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  assert.match(searchScript("linux", dir, "needle", flags), /--no-ignore/);
  for (const way of searchWays()) {
    const found = await searchDirectory(linux, dir, "needle", flags, shRun(way.env), new SearchCorpus(), () => undefined);
    assert.equal(found.error, null);
    if (found.error) return;
    assert.equal(found.hits.some((hit) => hit.path === "secret.txt"), true);
  }
});

test("forty-one matches in one file are marked truncated, and forty are not", async () => {
  const dir = tempDir("fs-per-file");
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  const many = join(dir, "many.txt");
  for (const way of searchWays()) {
    writeFileSync(many, `${Array.from({ length: SEARCH_PER_FILE + 1 }, (_, index) => `needle ${index}`).join("\n")}\n`);
    const over = await searchDirectory(linux, dir, "needle", flags, shRun(way.env), new SearchCorpus(), () => undefined);
    assert.equal(over.error, null);
    if (over.error) return;
    assert.equal(over.engine, way.engine);
    assert.equal(over.truncated, true);
    assert.equal(over.hits.length, SEARCH_PER_FILE);
    assert.equal(over.hits.every((hit) => hit.path === "many.txt"), true);
    writeFileSync(many, `${Array.from({ length: SEARCH_PER_FILE }, (_, index) => `needle ${index}`).join("\n")}\n`);
    const exact = await searchDirectory(linux, dir, "needle", flags, shRun(way.env), new SearchCorpus(), () => undefined);
    assert.equal(exact.error, null);
    if (exact.error) return;
    assert.equal(exact.engine, way.engine);
    assert.equal(exact.truncated, false);
    assert.equal(exact.hits.length, SEARCH_PER_FILE);
  }
});

test("a Windows search builds the hidden-file test in the script, and PowerShell can parse it", () => {
  const flags = { matchCase: false, wholeWord: false, regex: false, hidden: false };
  const shown = searchScript("windows", "C:\\Users\\box", "the", flags);
  const hidden = searchScript("windows", "C:\\Users\\box", "the", { ...flags, hidden: true });
  assert.match(shown, /--no-ignore/);
  assert.match(shown, /--null/);
  assert.doesNotMatch(shown, /flags\.hidden/);
  assert.doesNotMatch(hidden, /flags\.hidden/);
  assert.match(shown, /\('\\' \+ \$_\.FullName\.Substring\(\$bbFilesRoot\.Length\)\) -notmatch '\\\\\\.'/);
  assert.match(hidden, /-and \(\$true\)/);
  const pwsh = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { encoding: "utf8" });
  if (pwsh.error || pwsh.status !== 0) return;
  const check = "$script = [Console]::In.ReadToEnd(); $tokens = $null; $errors = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors); if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { $_.ToString() }; exit 1 }";
  for (const script of [shown, hidden, writeScript("windows", "C:\\Users\\box\\note.txt", "abc", "guard")]) {
    const parsed = spawnSync("pwsh", ["-NoProfile", "-Command", check], { input: script, encoding: "utf8" });
    assert.equal(parsed.status, 0, `${parsed.stdout}\n${parsed.stderr}`);
  }
});

test("the warm budget covers the encoded corpus, and the script stops before the cap", () => {
  assert.ok(WARM_OUT >= Math.ceil(CORPUS_BYTES / 3) * 4 + NAME_CAP * 48);
  assert.match(warmScript("linux", "/home/box"), /bb_files_out/);
});

function singleQuoted(script: string): string[] {
  const parts: string[] = [];
  for (let i = 0; i < script.length; i++) {
    if (script[i] !== "'") continue;
    let body = "";
    i += 1;
    while (i < script.length) {
      if (script[i] === "'" && script[i + 1] === "'") {
        body += "'";
        i += 2;
        continue;
      }
      if (script[i] === "'") break;
      body += script[i];
      i += 1;
    }
    parts.push(body);
  }
  return parts;
}

test("Windows scripts quote a tab, and a search without ripgrep can match a word or a pattern", () => {
  const flags = { matchCase: false, wholeWord: true, regex: false, hidden: false };
  const scripts = [
    homeScript("windows"),
    listScript("windows", "C:\\Users\\box"),
    readScript("windows", "C:\\Users\\box\\note.txt"),
    rangeScript("windows", "C:\\Users\\box\\note.txt", 0, 10),
    writeScript("windows", "C:\\Users\\box\\note.txt", "abc", "guard"),
    createScript("windows", "C:\\Users\\box\\note.txt", "file"),
    renameScript("windows", "C:\\Users\\box\\a.txt", "C:\\Users\\box\\b.txt"),
    deleteScript("windows", "C:\\Users\\box\\a.txt", "C:\\Users\\box"),
    searchScript("windows", "C:\\Users\\box", "the", flags),
    warmScript("windows", "C:\\Users\\box"),
    namesScript("windows", "C:\\Users\\box"),
  ];
  for (const script of scripts) assert.equal(singleQuoted(script).some((part) => part.includes("`t")), false);
  assert.match(homeScript("windows"), /"HOME`t"/);
  const search = searchScript("windows", "C:\\Users\\box", "the", flags);
  assert.match(search, /--max-count/);
  assert.match(search, /-cmatch/);
  assert.match(search, /-imatch/);
  assert.match(search, /\[regex\]::Escape/);
  assert.doesNotMatch(search, /\.Contains\(/);
});
