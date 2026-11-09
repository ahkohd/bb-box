import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missingBackendWords } from "../src/backends/index.ts";
import { BY_OUTSIDE, byBbBox } from "../src/core/box-log.ts";
import { forkNameProblem } from "../src/core/boxes.ts";
import { byWords } from "../src/core/snapshot.ts";
import { reasonAfterColon } from "../src/app/settings-drafts.ts";
import { screenAround } from "../src/app/snapshot-words.ts";

const ROOT = join(import.meta.dirname, "../src");
const MESSAGE_ROOTS = ["core", "plugin", "backends", "device"];
const NAME = ["bb", "box"].join("-");
const PROSE = new RegExp(`${NAME}(?:'s)?(?:(?=\\s+[A-Za-z])|\\s+\\$\\{|[.,;:!?](?=\\s|["'\`]|$))`);
const CODESIGN_IDENTITY = `${NAME} local code signing`;
const PLACEHOLDER = "${" + "PRODUCT}";
const ALLOWED = "logLine, guestScript, unitFile, commandHelp, recordPrefix, programName, providerResource, guestComment, agentInstruction and profileOwner";

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

function programName(body: string): boolean {
  if (body.startsWith("bb-box:")) return true;
  return /(?:echo ["']bb-box: |printf 'bb-box: |WriteLine\('bb-box: |die "bb-box: )/.test(body);
}

function providerResource(body: string): boolean {
  if (body.includes("tag:bb-box")) return true;
  if (/^bb-box \$\{[^}]*\}(?:$| template\b| image of | image build\b| box )/.test(body)) return true;
  return body.includes("Host image snapshot ") && /: bb-box \$\{[^}]*\}\.$/.test(body);
}

function allowance(body: string, before: string): string | null {
  if (/String\.raw\s*$/.test(before.slice(-40))) return "guestScript";
  if (body.startsWith("[Unit]")) return "unitFile";
  if (insideUnclosed(before, /\.describe\s*\(/)) return "commandHelp";
  if (insideUnclosed(before, /(?:^|[^.\w])log\s*\?\.\(|\.log\s*\?\.\(|\.#?log\s*\(|\.logError\s*\(|console\.(?:log|info|warn|error|debug)\s*\(/)) return "logLine";
  if (recordPrefix(body)) return "recordPrefix";
  if (body.startsWith("bb-box: use box_acquire")) return "agentInstruction";
  if (/# (?:Written|Added) by bb-box\b/.test(body)) return "guestComment";
  if (programName(body)) return "programName";
  if (body.includes("other plugins") || body.includes("which runs bb-box")) return "profileOwner";
  if (providerResource(body)) return "providerResource";
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
          if (PROSE.test(body) && !allowance(body, before)) prose.push(`${file}:${line} ${body.replace(/\s+/g, " ").slice(0, 120)}`);
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
  assert.deepEqual(prose, [], `a message still says bb-box where a person reads it, outside ${ALLOWED}`);
});

test("a snapshot names BB Box when BB Box or someone outside it took it", () => {
  assert.equal(byWords(byBbBox("the sweep")), "by BB Box: the sweep");
  assert.equal(byWords(BY_OUTSIDE), "outside BB Box");
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
  const kindPage = readFileSync(join(ROOT, "app/settings-kind-page.tsx"), "utf8");
  assert.match(kindPage, /reasonAfterColon\(/);
  assert.equal(kindPage.includes("/^[A-Z][a-z]/"), false);
});

test("a name says its limit is 32 characters", () => {
  assert.match(forkNameProblem("A") ?? "", /up to 32 characters/);
  for (const path of ["core/boxes.ts", "plugin/snapshot-tools.ts", "app/snapshots-card.tsx"]) {
    const source = readFileSync(join(ROOT, path), "utf8");
    assert.equal(source.includes('up to 32, not ending'), false, path);
    assert.match(source, /up to 32 characters/);
  }
});

test("a picture's label is built from the day, and a thread loss uses the shared phrase", () => {
  const words = readFileSync(join(ROOT, "app/snapshot-words.ts"), "utf8");
  const screen = words.slice(words.indexOf("export function screenAround"), words.indexOf("export function aboutWords"));
  assert.equal(screen.includes("whenInSentence"), false);
  assert.match(screen, /yesterday around/);
  assert.match(words, /THIS_BOX_THREAD/);
  assert.equal(words.includes("\"this box's thread\""), false);
  const configuration = readFileSync(join(ROOT, "app/settings-configuration.tsx"), "utf8");
  assert.match(configuration, /afterTheRefreshCommits/);
  assert.equal(configuration.includes("await Promise.resolve()"), false);
});

test("a picture's label reads naturally for today, yesterday and an older day", () => {
  const afternoon = new Date();
  afternoon.setHours(15, 0, 0, 0);
  const now = afternoon.getTime();
  assert.match(screenAround("calm-otter", now - 2 * 60 * 60_000, now), /^calm-otter's screen around \d{2}:\d{2}$/);
  assert.match(screenAround("calm-otter", now - 26 * 60 * 60_000, now), /^calm-otter's screen yesterday around \d{2}:\d{2}$/);
  const older = screenAround("calm-otter", now - 3 * 24 * 60 * 60_000, now);
  assert.match(older, /^calm-otter's screen on .+ at \d{2}:\d{2}$/);
  assert.doesNotMatch(older, /around on /);
});
