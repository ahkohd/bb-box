import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { missingBackendWords } from "../src/backends/index.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import { userspaceUpdateCommand } from "../src/plugin/gpu-page.ts";
import { keepCostWords } from "../src/plugin/snapshot-words.ts";
import { INVALID_BORDER, sizeHint, sizeInvalid } from "../src/app/size-field.ts";
import { PRODUCT } from "../src/app/product.ts";
import type { KeepCheck } from "../src/core/snapshots.ts";

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

test("a custom size says the limit under the field", () => {
  assert.equal(sizeHint(8), "Enter a whole number from 1 to 8.");
  assert.equal(sizeHint(8, 2), "Enter a whole number from 2 to 8.");
  assert.equal(sizeInvalid("0", 8, false), true);
  assert.equal(sizeInvalid("", 8, true), false);
  assert.equal(sizeInvalid("9", 8, false), true);
  assert.equal(sizeInvalid("3", 8, false), false);
  assert.equal(INVALID_BORDER, "border-destructive");
});

test("the userspace notice names the command and the product is BB Box", () => {
  assert.equal(userspaceUpdateCommand("calm-otter", "thr_1"), "bb box gpu update calm-otter --thread thr_1");
  assert.equal(userspaceUpdateCommand("calm-otter", null), "bb box gpu update calm-otter --machine");
  assert.equal(PRODUCT, "BB Box");
});

test("the panel's sentences name BB Box, the save bar can wrap, and field errors share one shell", () => {
  const needs = dockerDriver.setup?.needs ?? "";
  assert.match(needs, /a host BB Box reaches over SSH/);
  assert.doesNotMatch(needs, /bb-box/);
  const check = {
    snapshot: { box: { name: "calm-otter" }, name: "before the migration", id: "snaaaaaaaaaaaa", keptUntil: null, unflushed: null, livesOn: { ref: "100" } },
    host: "pve-1",
    storage: "fast",
    keptUntil: Date.parse("2026-11-29T23:59:59.999Z"),
    current: null,
    renews: false,
    shortens: false,
    gone: false,
    way: "copy",
    price: null,
    bytes: 2e9,
    usedBytes: 1e9,
    aboutMs: 38_000,
    warning: null,
  } as unknown as KeepCheck;
  assert.match(keepCostWords(check), /BB Box first copies this snapshot/);
  assert.doesNotMatch(keepCostWords(check), /bb-box/);
  const saving = readFileSync(join(import.meta.dirname, "../src/app/settings-saving.tsx"), "utf8");
  assert.match(saving, /ml-auto flex min-w-0 w-full max-w-full basis-full flex-wrap items-center justify-end gap-1\.5 sm:w-auto sm:basis-auto/);
  assert.doesNotMatch(saving, /shrink-0 flex-wrap items-center gap-1\.5/);
  assert.equal(PRODUCT, "BB Box");
  assert.equal(missingBackendWords("docker"), "This BB Box has no docker backend.");
});

test("dialogs do not copy the destructive button style or a shadow literal", () => {
  const app = filesUnder(join(import.meta.dirname, "../src/app"));
  const copied = app.filter((path) => readFileSync(path, "utf8").includes("bg-destructive text-destructive-foreground hover:bg-destructive/90"));
  const shadows = app.filter((path) => /shadow-\[/.test(readFileSync(path, "utf8")));
  assert.deepEqual(copied, []);
  assert.deepEqual(shadows, []);
});
