import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ADJECTIVES, MAX_NAME_LENGTH, NOUNS, generateName, isFriendlyName, namePattern } from "../src/core/names.ts";

const banned = /crab|box|proxmox|linux|ubuntu|windows|mac|desktop|browser|vm|host|lease|token|secret|test|cand|template|prod|dev/;

test("word lists are small, reviewed and free of product, provider, purpose or OS terms", () => {
  for (const list of [ADJECTIVES, NOUNS]) {
    assert.ok(list.length >= 32 && list.length <= 64);
    assert.equal(new Set(list).size, list.length, "no duplicates");
    for (const word of list) {
      assert.match(word, /^[a-z]{3,8}$/, word);
      assert.doesNotMatch(word, banned, word);
    }
  }
  const longest = (list: readonly string[]) => [...list].sort((a, b) => b.length - a.length)[0]!;
  assert.ok(`${longest(ADJECTIVES)}-${longest(NOUNS)}-abcd`.length <= MAX_NAME_LENGTH);
});

test("validation accepts only adjective-noun with an optional short hex suffix", () => {
  for (const good of ["quiet-heron", "amber-acorn-1f", "zesty-wren-a1b2"]) assert.equal(isFriendlyName(good), true, good);
  for (const bad of ["box-quiet-heron", "Quiet-Heron", "quiet_heron", "quiet-heron-", "quiet-heron-xyz",
    "quiet-heron-1f-2e", "quiet", "quiet-heron-abcde", "", 7, null, "a".repeat(64)]) {
    assert.equal(isFriendlyName(bad), false, String(bad));
  }
  assert.equal(namePattern.test("quiet-heron"), true);
});

function fixedRandom(sequence: number[]) {
  let offset = 0;
  return (bytes: number) => Uint8Array.from({ length: bytes }, () => sequence[offset++ % sequence.length] ?? 0);
}

test("names are chosen from the lists and a collision adds a short non-secret suffix", () => {
  const name = generateName(new Set(), fixedRandom([0, 3, 0, 5]));
  assert.equal(name, `${ADJECTIVES[3]}-${NOUNS[5]}`);
  // Every pair the generator tries is taken: it keeps a memorable base and suffixes it.
  const taken = new Set<string>();
  for (const adjective of ADJECTIVES) for (const noun of NOUNS) taken.add(`${adjective}-${noun}`);
  const suffixed = generateName(taken, fixedRandom([0, 3, 0, 5, 0x1f]));
  assert.match(suffixed, /^[a-z]+-[a-z]+-[a-f0-9]{2}$/);
  assert.equal(isFriendlyName(suffixed), true);
  taken.add(suffixed);
  const next = generateName(taken, fixedRandom([0, 3, 0, 5, 0x1f]));
  assert.notEqual(next, suffixed);
  assert.equal(isFriendlyName(next), true);
});

test("real randomness yields valid, mostly unique names", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const name = generateName(taken, (bytes) => randomBytes(bytes));
    assert.equal(isFriendlyName(name), true, name);
    assert.equal(taken.has(name), false);
    taken.add(name);
  }
});
