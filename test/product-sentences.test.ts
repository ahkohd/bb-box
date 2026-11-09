import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missingBackendWords } from "../src/backends/index.ts";
import { reasonAfterColon } from "../src/app/settings-drafts.ts";
import { screenAround } from "../src/app/snapshot-words.ts";

const ROOT = join(import.meta.dirname, "../src");
const MESSAGE_ROOTS = ["core", "plugin", "backends"];
const PROSE = new RegExp(`${["bb", "box"].join("-")}(?:'s)?(?=\\s+[A-Za-z])`);
const CODESIGN_IDENTITY = `${["bb", "box"].join("-")} local code signing`;
const PLACEHOLDER = "${" + "PRODUCT}";

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

function startsRegex(text: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  if (i < 0) return true;
  const previous = text[i]!;
  if (previous === "!" && i > 0 && /\w/.test(text[i - 1]!)) return false;
  if ("([{:;,!&|?=".includes(previous)) return true;
  return /\b(return|throw|case|typeof|void|await|yield|else|do)$/.test(text.slice(Math.max(0, i - 8), i + 1));
}

function insideUnclosed(before: string, pattern: RegExp): boolean {
  const re = new RegExp(pattern.source, "g");
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(before))) last = match.index + match[0].length;
  if (last < 0) return false;
  let depth = 1;
  for (let i = last; i < before.length; i++) {
    if (before[i] === "(") depth++;
    else if (before[i] === ")") depth--;
    if (depth === 0) return false;
  }
  return true;
}

function recordPrefix(body: string): boolean {
  return /^(?:bb-box install\b|bb-box warm\b|bb-box image box:)/.test(body);
}

function skipped(before: string): "guestScript" | "commandHelp" | "logLine" | null {
  if (/String\.raw\s*$/.test(before.slice(-40))) return "guestScript";
  if (insideUnclosed(before, /\.describe\s*\(/)) return "commandHelp";
  if (insideUnclosed(before, /(?:^|[^.\w])log\s*\?\.\(|\.log\s*\?\.\(|\.log\s*\(|\.logError\s*\(|console\.(?:log|info|warn|error|debug)\s*\(/)) return "logLine";
  return null;
}

function unescapeQuoted(raw: string): string {
  return raw.replace(/\\(.)/g, "$1");
}

test("a message says BB Box, and a quoted sentence never leaves ${PRODUCT} for the panel", () => {
  const prose: string[] = [];
  const quoted: string[] = [];
  for (const file of MESSAGE_ROOTS.flatMap((root) => filesUnder(join(ROOT, root)))) {
    const text = readFileSync(file, "utf8");
    let i = 0;
    const walk = (stop: boolean) => {
      let depth = 0;
      while (i < text.length) {
        if (stop && depth === 0 && text[i] === "}") return;
        if (text.startsWith("//", i)) {
          const end = text.indexOf("\n", i);
          i = end < 0 ? text.length : end;
          continue;
        }
        if (text.startsWith("/*", i)) {
          const end = text.indexOf("*/", i + 2);
          i = end < 0 ? text.length : end + 2;
          continue;
        }
        if (text[i] === "/" && text[i + 1] !== "/" && text[i + 1] !== "*" && startsRegex(text, i)) {
          i++;
          while (i < text.length) {
            if (text[i] === "\\") {
              i += 2;
              continue;
            }
            if (text[i] === "[") {
              i++;
              while (i < text.length && text[i] !== "]") i += text[i] === "\\" ? 2 : 1;
              continue;
            }
            if (text[i] === "/") {
              i++;
              break;
            }
            i++;
          }
          while (i < text.length && /[a-z]/.test(text[i]!)) i++;
          continue;
        }
        const quote = text[i];
        if (quote === "'" || quote === '"' || quote === "`") {
          const start = i;
          const before = text.slice(Math.max(0, start - 800), start);
          i++;
          let raw = "";
          while (i < text.length) {
            if (text[i] === "\\") {
              raw += text.slice(i, i + 2);
              i += 2;
              continue;
            }
            if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
              raw += "${";
              i += 2;
              walk(true);
              if (text[i] === "}") {
                raw += "}";
                i++;
              }
              continue;
            }
            if (text[i] === quote) {
              i++;
              break;
            }
            raw += text[i];
            i++;
          }
          const body = (quote === "`" ? raw : unescapeQuoted(raw)).replaceAll(CODESIGN_IDENTITY, "");
          const line = text.slice(0, start).split("\n").length;
          if (quote !== "`" && body.includes(PLACEHOLDER)) quoted.push(`${file}:${line}`);
          if (PROSE.test(body) && !skipped(before) && !recordPrefix(body)) prose.push(`${file}:${line} ${body.replace(/\s+/g, " ").slice(0, 120)}`);
          continue;
        }
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth = Math.max(0, depth - 1);
        i++;
      }
    };
    walk(false);
  }
  assert.deepEqual(quoted, [], "a double or single quoted sentence still contains ${PRODUCT}");
  assert.deepEqual(prose, [], "a message still says bb-box before a word, outside logLine, guestScript, commandHelp and codesignIdentity");
});

test("a missing backend says what to do next, and its note stays on boxForm", () => {
  assert.equal(missingBackendWords("docker"), "BB Box has no docker backend. Update BB Box, or remove this backend.");
  const source = readFileSync(join(ROOT, "backends/index.ts"), "utf8");
  const words = source.indexOf("export function missingBackendWords");
  const form = source.indexOf("export function boxForm");
  const note = source.indexOf("What a backend's boxes are");
  assert.ok(words >= 0 && note > words && note < form, "boxForm's note sits above boxForm");
});

test("a reason after a colon lower-cases a leading common word and leaves a provider name", () => {
  assert.equal(reasonAfterColon("Docker: the host did not answer."), "Docker: the host did not answer.");
  assert.equal(reasonAfterColon("Hetzner Cloud: no token."), "Hetzner Cloud: no token.");
  assert.equal(reasonAfterColon("The host did not answer."), "the host did not answer.");
  assert.equal(reasonAfterColon("Nothing was saved."), "nothing was saved.");
  assert.equal(reasonAfterColon("BB Box gave no reason."), "BB Box gave no reason.");
  assert.equal(reasonAfterColon("It failed."), "it failed.");
  assert.equal(reasonAfterColon("Its disk is full."), "its disk is full.");
  const configuration = readFileSync(join(ROOT, "app/settings-configuration.tsx"), "utf8");
  assert.match(configuration, /reasonAfterColon\(/);
  assert.equal(configuration.includes("([A-Z])(?=[a-z])"), false);
});

test("a picture's label reads naturally for today, yesterday and an older day", () => {
  const afternoon = new Date();
  afternoon.setHours(15, 0, 0, 0);
  const now = afternoon.getTime();
  assert.match(screenAround("calm-otter", now - 2 * 60 * 60_000, now), /^calm-otter's screen around \d{2}:\d{2}$/);
  assert.match(screenAround("calm-otter", now - 26 * 60 * 60_000, now), /^calm-otter's screen around yesterday at \d{2}:\d{2}$/);
  const older = screenAround("calm-otter", now - 3 * 24 * 60 * 60_000, now);
  assert.match(older, /^calm-otter's screen on .+ at \d{2}:\d{2}$/);
  assert.doesNotMatch(older, /around on /);
});
