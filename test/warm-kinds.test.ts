import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DRIVERS } from "../src/backends/index.ts";

const BACKENDS = join(import.meta.dirname, "..", "src", "backends");

function readsWarmCounts(type: string): boolean {
  const folder = join(BACKENDS, type);
  return readdirSync(folder)
    .filter((name) => name.endsWith(".ts"))
    .some((name) => /context\.warm\(/.test(readFileSync(join(folder, name), "utf8")));
}

test("a driver says it keeps warm boxes only of kinds it makes, and only when its backend reads warm counts at all", () => {
  for (const driver of DRIVERS) {
    const warmKinds = driver.warmKinds ?? [];
    assert.deepEqual(warmKinds.filter((kind) => !driver.kinds.includes(kind)), [], `${driver.type} keeps warm only what it makes`);
    assert.equal(warmKinds.length > 0, readsWarmCounts(driver.type), `${driver.type}: warmKinds and the warm counts its backend reads agree`);
  }
});
