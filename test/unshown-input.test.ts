import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonFaultOf, readFailure } from "../src/plugin/unshown-input.ts";
import { seededRandom } from "./helpers.ts";

const AGREEMENT_ROUNDS = 5000;
const AGREEMENT_SEED = 0x150_0f00d;
const JSON_PIECES = ["{", "}", "[", "]", ",", ":", '"', '"a"', '"b\\n"', '"\\q"', '"\\u00e9"', '"\\u00g"', "1", "-", "0", "01", "1.5", "1e9", ".5", "true", "tru", "null", "x", " ", "\n", "\t", "\u0001"];

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

test("a JSON fault is placed by line and column with its kind, never its text", () => {
  const cases: [string, number, number, string][] = [
    ["", 1, 1, "the text ends before the JSON does"],
    ['{"a": 1,}', 1, 9, "a character JSON does not allow there"],
    ['{\n  "a": "made-up-secret', 2, 8, "a string that is never closed"],
    ['{"a": "\\q"}', 1, 9, "an escape JSON does not allow in a string"],
    ['{"a": "two\nlines"}', 1, 11, "a line break or control character inside a string"],
    ["[-]", 1, 2, "a number JSON cannot read"],
    ["[1] 2", 1, 5, "more text after the JSON ends"],
    ['{"a": tru}', 1, 10, "a character JSON does not allow there"],
    ['{"a": "made-up-secret"x\n}', 1, 23, "a character JSON does not allow there"],
  ];
  for (const [text, line, column, words] of cases) {
    assert.deepEqual(jsonFaultOf(text), { line, column, words }, JSON.stringify(text));
  }
  assert.equal(jsonFaultOf('{"a": [1, 2.5e3, "\\u00e9", null, true, false, {}]}'), null);
});

test("the fault locator finds a fault exactly when JSON.parse refuses the text", () => {
  const random = seededRandom(AGREEMENT_SEED);
  for (let round = 0; round < AGREEMENT_ROUNDS; round += 1) {
    const text = Array.from({ length: 1 + Math.floor(random() * 12) }, () => JSON_PIECES[Math.floor(random() * JSON_PIECES.length)]!).join("");
    assert.equal(jsonFaultOf(text) === null, parses(text), JSON.stringify(text));
  }
});

test("a file that cannot be read is described by why, never by its path", () => {
  assert.equal(readFailure(Object.assign(new Error("ENOENT: /made/up/path"), { code: "ENOENT" })), "it was not found");
  assert.equal(readFailure(Object.assign(new Error("EACCES: /made/up/path"), { code: "EACCES" })), "it is not readable");
  assert.equal(readFailure(Object.assign(new Error("EISDIR: /made/up/path"), { code: "EISDIR" })), "it is a folder");
  assert.equal(readFailure(new Error("/made/up/path")), "it could not be read");
});
