import type { GuestOs } from "../transports/types.ts";
import {
  CORPUS_BYTES,
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
  type SearchFlags,
  type WriteMode,
} from "./box-fs-script.ts";

export type { SearchFlags };

export const CORPUS_FRESH_MS = 15_000;
export const SEARCH_CAP = 2_000;
export const SEARCH_FILES = 500;

export const PANEL_FILES_RPC: readonly { readonly name: string; readonly does: string }[] = [
  { name: "files.home", does: "The box user's home directory, as an absolute path." },
  { name: "files.list", does: "The names in one directory, in one command. At most 5,000. A name with a newline is left out." },
  { name: "files.read", does: "A file and its SHA-256. Text up to 4 MB, an image up to 2 MB. Past that, the size and the hash, and no bytes." },
  { name: "files.readRange", does: "A slice of a file, at most 256 KB, with the whole file's size and SHA-256." },
  { name: "files.write", does: "Replaces a file. With expectedSha256, writes only when the file still has that hash. Without it, overwrites." },
  { name: "files.create", does: "Creates a file or a directory. Refuses when the name is taken." },
  { name: "files.rename", does: "Renames a file or a directory. Refuses when the new name is taken." },
  { name: "files.delete", does: "Deletes a file or a directory. Refuses the root of the filesystem and the box user's home." },
  { name: "files.search", does: "Finds lines under a directory. ripgrep when the box has it, otherwise grep. At most 2,000 hits or 500 files." },
  { name: "files.names", does: "File paths under a directory, for go to file. Skips .git, node_modules and vendor. At most 20,000." },
];

const ERR_WORDS: Readonly<Record<string, string>> = {
  unreadable: "That folder cannot be read. Check the path and try again.",
  missing: "That file is not there.",
  exists: "Something already has that name.",
  "is-directory": "That path is a folder.",
  "not-a-file": "That path is not a file.",
  refused: "That path cannot be changed.",
  "not-ready": "This box is not ready.",
  "no-shell": "This box has no shell, so its files cannot be read.",
  device: "A device box has no files. Open the computer it runs on.",
  "bad-path": "Give a path the box user can read.",
  "too-large": "That file is too large to save from here.",
  timeout: "The box took too long. Try again.",
  failed: "The box could not do that. Try again.",
  truncated: "The answer was cut short. Try a smaller folder.",
  "bad-hash": "Reload the file, then save it again.",
};

const HASH = /^[0-9a-f]{64}$/;
const LIST_OUT = 2_000_000;
const READ_OUT = 8_000_000;
const SEARCH_OUT = 3_000_000;
const WARM_OUT = 12_000_000;
const SMALL_OUT = 64_000;

export interface FsBox {
  readonly id: string;
  readonly os: GuestOs;
  readonly state: string;
  readonly command: boolean;
  readonly device: boolean;
}

export interface FsRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
}

export type FsRun = (script: string, options: { stdin?: Uint8Array; timeoutMs: number; maxOutputBytes: number }) => Promise<FsRunResult>;

export interface FsEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "other";
  readonly size: number;
  readonly mtime: number;
}

export interface FsHit {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export type FilesHome = { readonly error: null; readonly path: string } | { readonly error: string };
export type FilesList = { readonly error: null; readonly entries: readonly FsEntry[]; readonly truncated: boolean } | { readonly error: string };
export type FilesRead =
  | { readonly error: null; readonly kind: "text"; readonly content: string; readonly sha256: string; readonly sizeBytes: number }
  | { readonly error: null; readonly kind: "image"; readonly dataUrl: string; readonly sha256: string; readonly sizeBytes: number }
  | { readonly error: null; readonly kind: "binary"; readonly reason: string; readonly sha256: string; readonly sizeBytes: number }
  | { readonly error: null; readonly kind: "large"; readonly sha256: string; readonly sizeBytes: number }
  | { readonly error: string };
export type FilesRange = { readonly error: null; readonly content: string; readonly start: number; readonly end: number; readonly sizeBytes: number; readonly sha256: string } | { readonly error: string };
export type FilesWrite = { readonly error: null; readonly outcome: "written"; readonly sha256: string; readonly sizeBytes: number } | { readonly error: null; readonly outcome: "conflict"; readonly currentSha256: string | null } | { readonly error: string };
export type FilesOk = { readonly error: null } | { readonly error: string };
export type FilesSearch = { readonly error: null; readonly engine: "rg" | "grep" | "memory"; readonly hits: readonly FsHit[]; readonly truncated: boolean } | { readonly error: string };
export type FilesNames = { readonly error: null; readonly paths: readonly string[]; readonly truncated: boolean } | { readonly error: string };

export function words(code: string): string {
  return ERR_WORDS[code] ?? ERR_WORDS.failed!;
}

export function failureWords(result: FsRunResult): string {
  if (result.timedOut) return words("timeout");
  if (result.truncated) return words("truncated");
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("ERR\t")) continue;
    return words(line.slice(4).split("\t")[0]!.trim());
  }
  return words("failed");
}

function collapse(parts: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

export function absolutePath(os: GuestOs, input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\0") || /[\r\n]/.test(trimmed) || trimmed.length > 4096) return null;
  if (os === "windows") {
    const slashed = trimmed.replaceAll("/", "\\");
    if (slashed.startsWith("\\\\")) {
      const bits = slashed.split("\\");
      const server = bits[2];
      const share = bits[3];
      if (!server || !share) return null;
      const rest = collapse(bits.slice(4));
      return `\\\\${server}\\${share}${rest.length ? `\\${rest.join("\\")}` : ""}`;
    }
    if (!/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
    const rest = collapse(slashed.slice(2).split("\\"));
    return `${slashed.slice(0, 2)}\\${rest.join("\\")}`;
  }
  if (!trimmed.startsWith("/")) return null;
  return `/${collapse(trimmed.split("/")).join("/")}`;
}

export function resolvePath(os: GuestOs, home: string, input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return absolutePath(os, home);
  if (os === "windows") {
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) return absolutePath(os, trimmed);
    return absolutePath(os, `${home.replace(/[\\/]+$/, "")}\\${trimmed.replaceAll("/", "\\")}`);
  }
  if (trimmed.startsWith("/")) return absolutePath(os, trimmed);
  return absolutePath(os, `${home.replace(/\/+$/, "")}/${trimmed}`);
}

export function parentPath(os: GuestOs, path: string): string {
  const abs = absolutePath(os, path);
  if (!abs) return path;
  if (os === "windows") {
    if (abs.startsWith("\\\\")) {
      const bits = abs.split("\\");
      if (bits.length <= 4) return abs;
      return bits.slice(0, -1).join("\\");
    }
    const rest = abs.slice(3);
    if (!rest) return abs.slice(0, 3);
    const at = rest.lastIndexOf("\\");
    return at < 0 ? abs.slice(0, 3) : `${abs.slice(0, 3)}${rest.slice(0, at)}`;
  }
  if (abs === "/") return "/";
  const at = abs.lastIndexOf("/");
  return at <= 0 ? "/" : abs.slice(0, at);
}

export function childPath(os: GuestOs, dir: string, name: string): string | null {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0") || /[\r\n]/.test(name)) return null;
  const sep = os === "windows" ? "\\" : "/";
  const base = dir.endsWith(sep) ? dir.slice(0, -1) : dir;
  return absolutePath(os, `${base}${sep}${name}`);
}

export function isHidden(path: string): boolean {
  return path.split(/[/\\]/).some((part) => part.startsWith("."));
}

function refuse(box: FsBox): string | null {
  if (box.device) return words("device");
  if (!box.command) return words("no-shell");
  if (box.state !== "ready") return words("not-ready");
  return null;
}

function decode(value: string): string {
  return Buffer.from(value.trim(), "base64").toString("utf8");
}

export function parseList(stdout: string): FilesList {
  const entries: FsEntry[] = [];
  let truncated = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("ERR\t")) return { error: words(line.slice(4).split("\t")[0]!.trim()) };
    if (line === "TRUNC") {
      truncated = true;
      continue;
    }
    const [mark, kind, size, mtime, name] = line.split("\t");
    if (mark !== "ENT" || !name) continue;
    entries.push({
      name: decode(name),
      kind: kind === "D" ? "directory" : kind === "F" ? "file" : "other",
      size: Number(size) || 0,
      mtime: Number(mtime) || 0,
    });
  }
  entries.sort((a, b) => {
    if (a.kind === "directory" && b.kind !== "directory") return -1;
    if (b.kind === "directory" && a.kind !== "directory") return 1;
    return a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true });
  });
  return { error: null, entries, truncated };
}

export function parseRead(stdout: string): FilesRead {
  const lines = stdout.split(/\r?\n/);
  const head = lines[0] ?? "";
  if (head.startsWith("ERR\t")) return { error: words(head.slice(4).split("\t")[0]!.trim()) };
  if (head === "MISSING") return { error: words("missing") };
  if (head === "DIR") return { error: words("is-directory") };
  const body = lines.slice(1).join("").replace(/\s/g, "");
  const parts = head.split("\t");
  if (parts[0] === "LARGE") return { error: null, kind: "large", sizeBytes: Number(parts[1]) || 0, sha256: parts[2] ?? "" };
  if (parts[0] === "BINARY") return { error: null, kind: "binary", reason: "This file is not text.", sizeBytes: Number(parts[1]) || 0, sha256: parts[2] ?? "" };
  if (parts[0] === "TEXT") {
    return { error: null, kind: "text", content: Buffer.from(body, "base64").toString("utf8"), sha256: parts[2] ?? "", sizeBytes: Number(parts[1]) || 0 };
  }
  if (parts[0] === "IMAGE") {
    return { error: null, kind: "image", dataUrl: `data:${parts[1]};base64,${body}`, sha256: parts[3] ?? "", sizeBytes: Number(parts[2]) || 0 };
  }
  return { error: words("failed") };
}

export function parseRange(stdout: string): FilesRange {
  const lines = stdout.split(/\r?\n/);
  const head = lines[0] ?? "";
  if (head.startsWith("ERR\t")) return { error: words(head.slice(4).split("\t")[0]!.trim()) };
  const parts = head.split("\t");
  if (parts[0] !== "RANGE") return { error: words("failed") };
  const body = lines.slice(1).join("").replace(/\s/g, "");
  return {
    error: null,
    start: Number(parts[1]) || 0,
    end: Number(parts[2]) || 0,
    sizeBytes: Number(parts[3]) || 0,
    sha256: parts[4] ?? "",
    content: Buffer.from(body, "base64").toString("utf8"),
  };
}

export function parseWrite(stdout: string): FilesWrite {
  const line = stdout.split(/\r?\n/).find((each) => each.length > 0) ?? "";
  if (line.startsWith("ERR\t")) return { error: words(line.slice(4).split("\t")[0]!.trim()) };
  if (line.startsWith("CONFLICT\t")) {
    const hash = line.slice("CONFLICT\t".length).trim();
    return { error: null, outcome: "conflict", currentSha256: HASH.test(hash) ? hash : null };
  }
  if (line.startsWith("WRITTEN\t")) {
    const [, hash, size] = line.split("\t");
    return { error: null, outcome: "written", sha256: hash ?? "", sizeBytes: Number(size) || 0 };
  }
  return { error: words("failed") };
}

function parseOk(stdout: string): FilesOk {
  const line = stdout.split(/\r?\n/).find((each) => each.length > 0) ?? "";
  if (line === "OK") return { error: null };
  if (line.startsWith("ERR\t")) return { error: words(line.slice(4).split("\t")[0]!.trim()) };
  return { error: words("failed") };
}

export function parseSearch(stdout: string): FilesSearch {
  const lines = stdout.split(/\r?\n/);
  let engine: "rg" | "grep" = "grep";
  const hits: FsHit[] = [];
  const files = new Set<string>();
  let truncated = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("ERR\t")) return { error: words(line.slice(4).split("\t")[0]!.trim()) };
    if (line.startsWith("ENGINE\t")) {
      engine = line.slice("ENGINE\t".length).trim() === "rg" ? "rg" : "grep";
      continue;
    }
    if (hits.length >= SEARCH_CAP || files.size >= SEARCH_FILES) {
      truncated = true;
      continue;
    }
    const hit = engine === "rg" ? rgHit(line) : grepHit(line);
    if (!hit) continue;
    if (!files.has(hit.path) && files.size >= SEARCH_FILES) {
      truncated = true;
      continue;
    }
    files.add(hit.path);
    hits.push(hit);
  }
  return { error: null, engine, hits, truncated };
}

function rgHit(line: string): FsHit | null {
  if (!line.startsWith("{")) return null;
  let message: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start?: number }[] } };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return null;
  }
  if (message.type !== "match" || !message.data) return null;
  const text = (message.data.lines?.text ?? "").replace(/\n$/, "");
  return {
    path: (message.data.path?.text ?? "").replace(/^\.\//, "").replaceAll("\\", "/"),
    line: message.data.line_number ?? 0,
    column: (message.data.submatches?.[0]?.start ?? 0) + 1,
    preview: text.slice(0, 240),
  };
}

function grepHit(line: string): FsHit | null {
  const first = line.indexOf(":");
  const second = line.indexOf(":", first + 1);
  if (first < 1 || second < 0) return null;
  const lineNo = Number(line.slice(first + 1, second));
  if (!Number.isInteger(lineNo)) return null;
  const path = line.slice(0, first).replace(/^\.\//, "").replaceAll("\\", "/");
  const preview = line.slice(second + 1).slice(0, 240);
  return { path, line: lineNo, column: 1, preview };
}

export function parseNames(stdout: string): FilesNames {
  const paths: string[] = [];
  let truncated = false;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("ERR\t")) return { error: words(line.slice(4).split("\t")[0]!.trim()) };
    if (line === "TRUNC" || line === "MORE") {
      truncated = true;
      continue;
    }
    if (line.startsWith("NAME\t")) paths.push(decode(line.slice(5)).replaceAll("\\", "/"));
  }
  return { error: null, paths, truncated };
}

export interface CorpusFile {
  readonly path: string;
  readonly text: string;
  readonly size: number;
  readonly mtime: number;
}

export function parseWarm(stdout: string): { names: string[]; files: CorpusFile[]; partial: boolean; error: string | null } {
  const lines = stdout.split(/\n/);
  const names: string[] = [];
  const files: CorpusFile[] = [];
  let partial = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line || line === "DONE") continue;
    if (line.startsWith("ERR\t")) return { names, files, partial, error: words(line.slice(4).split("\t")[0]!.trim()) };
    if (line === "MORE" || line === "TRUNC") {
      partial = true;
      continue;
    }
    if (line.startsWith("NAME\t")) {
      names.push(decode(line.slice(5)).replaceAll("\\", "/"));
      continue;
    }
    if (line.startsWith("FILE\t")) {
      const [, path, size, mtime] = line.split("\t");
      const encoded = lines[++i] ?? "";
      if (lines[i + 1] === "ENDFILE") i++;
      files.push({ path: decode(path ?? "").replaceAll("\\", "/"), size: Number(size) || 0, mtime: Number(mtime) || 0, text: Buffer.from(encoded, "base64").toString("utf8") });
    }
  }
  return { names, files, partial, error: null };
}

function wordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false;
  return /[\p{L}\p{N}_]/u.test(text[index] ?? "");
}

export function searchText(files: readonly { path: string; text: string }[], query: string, flags: Pick<SearchFlags, "matchCase" | "wholeWord">): { hits: FsHit[]; truncated: boolean } {
  const smart = flags.matchCase || /[A-Z]/.test(query);
  const needle = smart ? query : query.toLowerCase();
  const hits: FsHit[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const file of files) {
    if (hits.length >= SEARCH_CAP || seen.size >= SEARCH_FILES) {
      truncated = true;
      break;
    }
    const lines = file.text.split("\n");
    let inFile = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const hay = smart ? line : line.toLowerCase();
      let from = 0;
      while (from <= hay.length) {
        const at = hay.indexOf(needle, from);
        if (at < 0) break;
        const around = !flags.wholeWord || (!wordChar(line, at - 1) && !wordChar(line, at + query.length));
        if (around) {
          if (!seen.has(file.path) && seen.size >= SEARCH_FILES) {
            truncated = true;
            return { hits, truncated };
          }
          seen.add(file.path);
          hits.push({ path: file.path, line: i + 1, column: at + 1, preview: line.slice(0, 240) });
          inFile++;
          if (hits.length >= SEARCH_CAP) return { hits, truncated: true };
          if (inFile >= 50) break;
        }
        from = at + Math.max(needle.length, 1);
      }
      if (inFile >= 50) break;
    }
  }
  return { hits, truncated };
}

export function findInFile(text: string, query: string, matchCase: boolean): { start: number; end: number; line: number }[] {
  if (!query) return [];
  const smart = matchCase || /[A-Z]/.test(query);
  const needle = smart ? query : query.toLowerCase();
  const hay = smart ? text : text.toLowerCase();
  const found: { start: number; end: number; line: number }[] = [];
  let from = 0;
  let line = 1;
  let lineAt = 0;
  while (from <= hay.length) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    while (lineAt < at) {
      const next = text.indexOf("\n", lineAt);
      if (next < 0 || next >= at) break;
      line++;
      lineAt = next + 1;
    }
    found.push({ start: at, end: at + query.length, line });
    from = at + Math.max(needle.length, 1);
    if (found.length >= 5_000) break;
  }
  return found;
}

function subsequence(hay: string, needle: string): boolean {
  let at = 0;
  for (const char of needle) {
    at = hay.indexOf(char, at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

export function rankPaths(paths: readonly string[], query: string, limit = 50): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...paths].slice(0, limit);
  const scored: { path: string; score: number; length: number }[] = [];
  for (const path of paths) {
    const name = path.split(/[/\\]/).pop() ?? path;
    const hay = name.toLowerCase();
    const full = path.toLowerCase();
    const score = hay === needle ? 400 : hay.startsWith(needle) ? 300 : hay.includes(needle) ? 200 : full.includes(needle) ? 100 : subsequence(hay, needle) ? 50 : 0;
    if (score) scored.push({ path, score, length: name.length });
  }
  scored.sort((a, b) => b.score - a.score || a.length - b.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((row) => row.path);
}

export class SearchCorpus {
  #root = "";
  #at: number | null = null;
  #partial = false;
  #texts = false;
  #names: string[] = [];
  #files = new Map<string, CorpusFile>();
  #bytes = 0;
  readonly #budget: number;
  readonly #now: () => number;

  constructor(budget = CORPUS_BYTES, now: () => number = Date.now) {
    this.#budget = budget;
    this.#now = now;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get partial(): boolean {
    return this.#partial;
  }

  get root(): string {
    return this.#root;
  }

  covers(root: string): boolean {
    return this.#texts && this.#root === root && !this.#partial && this.#at !== null && this.#now() - this.#at < CORPUS_FRESH_MS;
  }

  namesFor(root: string): readonly string[] | null {
    if (this.#root !== root || this.#at === null || this.#now() - this.#at >= CORPUS_FRESH_MS) return null;
    return this.#names;
  }

  texts(hidden: boolean): { path: string; text: string }[] {
    return [...this.#files.values()].filter((file) => hidden || !isHidden(file.path)).map((file) => ({ path: file.path, text: file.text }));
  }

  load(root: string, names: readonly string[], files: readonly CorpusFile[], partial: boolean): void {
    this.#files.clear();
    this.#bytes = 0;
    this.#root = root;
    this.#names = [...names];
    this.#at = this.#now();
    let dropped = false;
    for (const file of files) {
      if (!this.#keep(file)) dropped = true;
    }
    this.#partial = partial || dropped;
    this.#texts = !this.#partial;
  }

  rememberNames(root: string, names: readonly string[], truncated: boolean): void {
    if (this.#root !== root) {
      this.#files.clear();
      this.#bytes = 0;
      this.#texts = false;
      this.#partial = truncated;
    } else if (truncated) {
      this.#partial = true;
      this.#texts = false;
    }
    this.#root = root;
    this.#names = [...names];
    this.#at = this.#now();
  }

  drop(): void {
    this.#files.clear();
    this.#bytes = 0;
    this.#names = [];
    this.#at = null;
    this.#partial = false;
    this.#texts = false;
    this.#root = "";
  }

  #keep(file: CorpusFile): boolean {
    const weight = file.text.length * 2 + 64;
    if (weight > this.#budget) return false;
    let evicted = false;
    while (this.#bytes + weight > this.#budget && this.#files.size) {
      evicted = true;
      const oldest = this.#files.keys().next().value;
      if (oldest === undefined) break;
      const gone = this.#files.get(oldest);
      this.#files.delete(oldest);
      if (gone) this.#bytes -= gone.text.length * 2 + 64;
    }
    if (this.#bytes + weight > this.#budget) return false;
    this.#files.set(file.path, file);
    this.#bytes += weight;
    return !evicted;
  }
}

export class CorpusStore {
  readonly #boxes = new Map<string, SearchCorpus>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  of(id: string): SearchCorpus {
    const found = this.#boxes.get(id);
    if (found) {
      this.#boxes.delete(id);
      this.#boxes.set(id, found);
      return found;
    }
    const made = new SearchCorpus(CORPUS_BYTES, this.#now);
    this.#boxes.set(id, made);
    while (this.#boxes.size > 4) {
      const oldest = this.#boxes.keys().next().value;
      if (oldest === undefined) break;
      this.#boxes.delete(oldest);
    }
    return made;
  }

  drop(id: string): void {
    this.#boxes.get(id)?.drop();
  }
}

export function searchUsesCorpus(corpus: SearchCorpus, root: string, flags: SearchFlags): boolean {
  return corpus.covers(root) && !flags.regex;
}

async function checked(run: FsRun, script: string, options: { stdin?: Uint8Array; timeoutMs: number; maxOutputBytes: number }): Promise<FsRunResult | { error: string }> {
  const result = await run(script, options);
  if (result.timedOut) return { error: words("timeout") };
  if (result.truncated) return { error: words("truncated") };
  return result;
}

function isResult(value: FsRunResult | { error: string }): value is FsRunResult {
  return !("error" in value);
}

export async function readHome(box: FsBox, run: FsRun): Promise<FilesHome> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const result = await checked(run, homeScript(box.os), { timeoutMs: 10_000, maxOutputBytes: SMALL_OUT });
  if (!isResult(result)) return result;
  const line = result.stdout.split(/\r?\n/).find((each) => each.startsWith("HOME\t"));
  if (!line) return { error: failureWords(result) };
  const path = absolutePath(box.os, decode(line.slice(5)));
  return path ? { error: null, path } : { error: words("failed") };
}

export async function listDirectory(box: FsBox, path: string, run: FsRun): Promise<FilesList> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  const result = await checked(run, listScript(box.os, abs), { timeoutMs: 15_000, maxOutputBytes: LIST_OUT });
  if (!isResult(result)) return result;
  return parseList(result.stdout);
}

export async function readFileAt(box: FsBox, path: string, run: FsRun): Promise<FilesRead> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  const result = await checked(run, readScript(box.os, abs), { timeoutMs: 20_000, maxOutputBytes: READ_OUT });
  if (!isResult(result)) return result;
  return parseRead(result.stdout);
}

export async function readFileRange(box: FsBox, path: string, start: number, length: number, run: FsRun): Promise<FilesRange> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  const result = await checked(run, rangeScript(box.os, abs, start, length), { timeoutMs: 20_000, maxOutputBytes: 1_000_000 });
  if (!isResult(result)) return result;
  return parseRange(result.stdout);
}

export async function writeFileAt(box: FsBox, path: string, content: string, expectedSha256: string | null, run: FsRun): Promise<FilesWrite> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  if (Buffer.byteLength(content) > 4 * 1024 * 1024) return { error: words("too-large") };
  const mode: WriteMode = expectedSha256 === null ? "overwrite" : "guard";
  if (mode === "guard" && !HASH.test(expectedSha256 ?? "")) return { error: words("bad-hash") };
  const result = await checked(run, writeScript(box.os, abs, expectedSha256 ?? "", mode), { stdin: Buffer.from(content), timeoutMs: 20_000, maxOutputBytes: SMALL_OUT });
  if (!isResult(result)) return result;
  return parseWrite(result.stdout);
}

export async function createPath(box: FsBox, path: string, kind: "file" | "directory", run: FsRun): Promise<FilesOk> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs || abs === "/" || /^[A-Za-z]:\\$/.test(abs)) return { error: words("bad-path") };
  const result = await checked(run, createScript(box.os, abs, kind), { timeoutMs: 15_000, maxOutputBytes: SMALL_OUT });
  if (!isResult(result)) return result;
  return parseOk(result.stdout);
}

export async function renamePath(box: FsBox, from: string, to: string, run: FsRun): Promise<FilesOk> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const source = absolutePath(box.os, from);
  const target = absolutePath(box.os, to);
  if (!source || !target || source === "/" || target === "/") return { error: words("bad-path") };
  const result = await checked(run, renameScript(box.os, source, target), { timeoutMs: 15_000, maxOutputBytes: SMALL_OUT });
  if (!isResult(result)) return result;
  return parseOk(result.stdout);
}

export async function deletePath(box: FsBox, path: string, home: string, run: FsRun): Promise<FilesOk> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  const homeAbs = absolutePath(box.os, home);
  if (!abs || !homeAbs) return { error: words("bad-path") };
  const result = await checked(run, deleteScript(box.os, abs, homeAbs), { timeoutMs: 30_000, maxOutputBytes: SMALL_OUT });
  if (!isResult(result)) return result;
  return parseOk(result.stdout);
}

export async function searchDirectory(box: FsBox, path: string, query: string, flags: SearchFlags, run: FsRun, corpus: SearchCorpus, warm: (root: string) => void): Promise<FilesSearch> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  if (!query.trim()) return { error: null, engine: "memory", hits: [], truncated: false };
  if (query.length > 1000 || /[\r\n]/.test(query)) return { error: "Make the search one line, and shorter than 1,000 characters." };
  if (searchUsesCorpus(corpus, abs, flags)) {
    const found = searchText(corpus.texts(flags.hidden), query, flags);
    return { error: null, engine: "memory", ...found };
  }
  const result = await checked(run, searchScript(box.os, abs, query, flags), { timeoutMs: 15_000, maxOutputBytes: SEARCH_OUT });
  if (!isResult(result)) return result;
  if (!corpus.covers(abs)) warm(abs);
  return parseSearch(result.stdout);
}

export async function warmDirectory(box: FsBox, path: string, run: FsRun, corpus: SearchCorpus): Promise<void> {
  if (refuse(box)) return;
  const abs = absolutePath(box.os, path);
  if (!abs || corpus.covers(abs)) return;
  const result = await checked(run, warmScript(box.os, abs), { timeoutMs: 25_000, maxOutputBytes: WARM_OUT });
  if (!isResult(result)) return;
  const warmed = parseWarm(result.stdout);
  if (warmed.error) return;
  corpus.load(abs, warmed.names, warmed.files, warmed.partial);
}

export async function listNames(box: FsBox, path: string, run: FsRun, corpus: SearchCorpus): Promise<FilesNames> {
  const refused = refuse(box);
  if (refused) return { error: refused };
  const abs = absolutePath(box.os, path);
  if (!abs) return { error: words("bad-path") };
  const cached = corpus.namesFor(abs);
  if (cached && !corpus.partial) return { error: null, paths: cached, truncated: false };
  const result = await checked(run, namesScript(box.os, abs), { timeoutMs: 20_000, maxOutputBytes: SEARCH_OUT });
  if (!isResult(result)) return result;
  const parsed = parseNames(result.stdout);
  if (parsed.error === null) corpus.rememberNames(abs, parsed.paths, parsed.truncated);
  return parsed;
}
