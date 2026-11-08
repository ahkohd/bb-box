import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  parseRead,
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
import { IMAGE_BYTES, LIST_CAP, OPEN_BYTES, writeScript } from "../src/core/box-fs-script.ts";

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
  const run = shRun();
  const conflict = await writeFileAt(linux, path, "three\n", opened, run);
  assert.equal(conflict.error, null);
  assert.equal(conflict.outcome, "conflict");
  assert.equal(conflict.currentSha256, sha("two\n"));
  assert.equal(readFileSync(path, "utf8"), "two\n");
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
  const created = await writeFileAt(linux, path, "x\n", null, shRun());
  assert.equal(created.error, null);
  assert.equal(created.outcome, "written");
  assert.equal(readFileSync(path, "utf8"), "x\n");
});

test("a Windows write compares the hash and can refuse", () => {
  const script = writeScript("windows", "C:\\Users\\box\\note.txt", "abc", "guard");
  assert.match(script, /Get-FileHash/);
  assert.match(script, /CONFLICT/);
  assert.match(script, /\$bbFilesNow -ne \$bbFilesExpected/);
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
  let calls = 0;
  const run: FsRun = async (script, options) => {
    calls += 1;
    return shRun()(script, options);
  };
  const corpus = new SearchCorpus(undefined, () => 0);
  const found = await searchDirectory(linux, dir, "needle", flags, run, corpus, () => undefined);
  assert.equal(calls, 1);
  assert.equal(found.error, null);
  if (found.error) return;
  assert.equal(found.engine === "rg" || found.engine === "grep", true);
  assert.deepEqual(found.hits.map((hit) => hit.path), ["src/app.ts"]);
  assert.equal(found.hits[0]?.preview.includes("needle"), true);
  const hidden = await searchDirectory(linux, dir, "needle", { ...flags, hidden: true }, run, corpus, () => undefined);
  assert.equal(hidden.error, null);
  if (hidden.error) return;
  assert.equal(hidden.hits.some((hit) => hit.path === ".secret"), true);
  assert.equal(hidden.hits.some((hit) => hit.path.includes(".git")), false);
  corpus.load(dir, ["src/app.ts"], [{ path: "src/app.ts", text: "const needle = 1;\n", size: 18, mtime: 1 }], false);
  const before = calls;
  const memory = await searchDirectory(linux, dir, "needle", flags, run, corpus, () => undefined);
  assert.equal(calls, before);
  assert.equal(memory.error, null);
  if (memory.error) return;
  assert.equal(memory.engine, "memory");
  const pattern = await searchDirectory(linux, dir, "n..dle", { ...flags, regex: true }, run, corpus, () => undefined);
  assert.equal(calls, before + 1);
  assert.equal(pattern.error, null);
  if (pattern.error) return;
  assert.notEqual(pattern.engine, "memory");
  assert.equal(pattern.hits[0]?.path, "src/app.ts");
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
  let calls = 0;
  const run: FsRun = async (script, options) => {
    calls += 1;
    return shRun()(script, options);
  };
  const corpus = new SearchCorpus(undefined, () => 1_000);
  const names = await listNames(linux, dir, run, corpus);
  assert.equal(names.error, null);
  assert.equal(corpus.covers(dir), false);
  const found = await searchDirectory(linux, dir, "needle", { matchCase: false, wholeWord: false, regex: false, hidden: false }, run, corpus, () => undefined);
  assert.equal(found.error, null);
  if (found.error) return;
  assert.notEqual(found.engine, "memory");
  assert.equal(found.hits[0]?.path, "a.ts");
  assert.ok(calls >= 2);
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
