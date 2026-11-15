import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVERS } from "../src/backends/index.ts";
import { checkDocument, readDraft } from "../src/core/document.ts";
import { unnamedProblems } from "../src/plugin/unshown-input.ts";

const VALUE = "ValueCanaryQ7w3Zx9";
const LOWER = VALUE.toLowerCase();
const SHORTEST_LEAK = 8;
const FIELD_VALUES = [VALUE, LOWER, `-${VALUE}`, `${LOWER}:99999`, `build-1 box@192.0.2.21 ${LOWER}`, `build-1 box@192.0.2.21 linux ${LOWER}=on`, `mac-1 ${LOWER}`, `${LOWER} ${LOWER}`, `100 ${VALUE}`, `9101 ${VALUE} ${VALUE}`];

function leaked(text: string): string | null {
  for (const value of [VALUE, LOWER]) {
    for (let at = 0; at + SHORTEST_LEAK <= value.length; at += 1) if (text.includes(value.slice(at, at + SHORTEST_LEAK))) return value.slice(at, at + SHORTEST_LEAK);
  }
  return null;
}

function printed(draft: unknown): string {
  const read = readDraft(draft, DRIVERS);
  return JSON.stringify(unnamedProblems([...read.problems, ...checkDocument(read.document, {}, DRIVERS)]));
}

test("no backend's checks print a rejected field value, for any field of any backend or host", () => {
  let checked = 0;
  for (const driver of DRIVERS) {
    for (const [key, descriptor] of Object.entries(driver.fields)) {
      for (const value of FIELD_VALUES) {
        const problems = printed({ backends: [{ id: driver.type, type: driver.type, enabled: true, fields: { [key]: value } }] });
        assert.equal(leaked(problems), null, `${driver.type}.${key} (${descriptor.type}) printed ${value}: ${problems}`);
        checked += 1;
      }
    }
    for (const key of Object.keys(driver.hostFields ?? {})) {
      for (const value of FIELD_VALUES) {
        const problems = printed({ backends: [{ id: driver.type, type: driver.type, enabled: true, hosts: [{ name: "host-1", fields: { [key]: value } }] }] });
        assert.equal(leaked(problems), null, `${driver.type} host ${key} printed ${value}: ${problems}`);
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} fields were checked`);
});

test("no rejected value or key in a draft is printed in the CLI's form of its problems", () => {
  const drafts = [
    { schema: VALUE },
    { general: { defaultKind: VALUE } },
    { general: { defaultKind: LOWER } },
    { images: { valid: { kinds: [VALUE], script: "true", projects: ["p"] } } },
    { images: { [VALUE]: { kinds: ["linux"], script: "true", projects: ["p"] } } },
    { backends: [{ id: "x", type: VALUE }] },
    { backends: [{ id: LOWER, type: LOWER }] },
    { backends: [{ id: `namespace:${LOWER}${LOWER}`, type: "namespace" }] },
    { general: { files: [{ path: `/${VALUE}`, content: "made up" }, { path: `a/../${VALUE}`, content: "made up" }] } },
    { kinds: { [VALUE]: {}, linux: { presets: { [VALUE]: {} } } } },
  ];
  for (const draft of drafts) {
    const problems = printed(draft);
    assert.notEqual(problems, "[]", JSON.stringify(draft));
    assert.equal(leaked(problems), null, `${JSON.stringify(draft)} printed: ${problems}`);
  }
});
