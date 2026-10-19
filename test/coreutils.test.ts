// What bb-box runs in a box keeps to what both GNU coreutils and sudo, as on Ubuntu 24.04, and uutils and sudo-rs, as on
// 26.04's Wayland image, do alike (060). scripts/coreutils/compare.sh runs every form in use on both; they differed only here.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { timedOutExits } from "../src/core/in-box.ts";

/** Every file under `dir` that holds code: scripts and sources, not documents. */
function code(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : code(path);
    return /\.(md|png|jpg|json|tsv|txt)$/.test(name) ? [] : [path];
  });
}

test("no in-box code asks sudo to keep the caller's environment: sudo-rs ignores -E and --preserve-env", () => {
  const found = [...code("setup"), ...code("src")].flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) => (/\bsudo\b[^\n|;&]*\s(-[A-Za-z]*E\b|--preserve-env\b)/.test(line) ? [`${path}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, [], "name each variable to keep in sudoers' env_keep, as customize-base.sh does, or pass it as VAR=value");
});

test("a command a Linux box's timeout stops counts as timed out whichever coreutils killed it: GNU exits 137 after KILL, uutils 124", () => {
  assert.deepEqual([...timedOutExits("linux")].sort(), [124, 137]);
});
