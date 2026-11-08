import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { userspaceUpdateCommand } from "../src/plugin/gpu-page.ts";
import { INVALID_BORDER, sizeHint, sizeInvalid } from "../src/app/size-field.ts";
import { PRODUCT } from "../src/app/product.ts";

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

test("dialogs do not copy the destructive button style or a shadow literal", () => {
  const app = filesUnder(join(import.meta.dirname, "../src/app"));
  const copied = app.filter((path) => readFileSync(path, "utf8").includes("bg-destructive text-destructive-foreground hover:bg-destructive/90"));
  const shadows = app.filter((path) => /shadow-\[/.test(readFileSync(path, "utf8")));
  assert.deepEqual(copied, []);
  assert.deepEqual(shadows, []);
});
