import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DRIVERS } from "../src/backends/index.ts";
import { KIND_INFO } from "../src/backends/kinds.ts";
import { helpParts, type FieldDescriptor } from "../src/backends/types.ts";

const LONGEST_LEAD = 120;

interface Help {
  readonly where: string;
  readonly text: string;
}

function fieldHelp(): Help[] {
  return DRIVERS.flatMap((driver) => {
    const fields = (scope: string, descriptors: Readonly<Record<string, FieldDescriptor>> = {}) =>
      Object.entries(descriptors).map(([key, field]) => ({ where: `${driver.type} ${scope} ${key}`, text: field.description ?? "" }));
    return [...fields("field", driver.fields), ...fields("host field", driver.hostFields)];
  });
}

function pageHelp(): Help[] {
  return [
    ...fieldHelp(),
    ...DRIVERS.map((driver) => ({ where: `${driver.type} description`, text: driver.description })),
    ...Object.entries(KIND_INFO).map(([id, info]) => ({ where: `kind ${id}`, text: info.description })),
  ];
}

const kindIds = Object.keys(KIND_INFO).filter((id) => id.includes("-"));

test("the first sentence splits off at the first full stop followed by a space", () => {
  assert.deepEqual(helpParts("The node boxes run on. Leave empty on a single-node host."), { lead: "The node boxes run on.", more: "Leave empty on a single-node host." });
  assert.deepEqual(helpParts("Uses about 1.2 Mbit/s against 20."), { lead: "Uses about 1.2 Mbit/s against 20.", more: "" });
  assert.deepEqual(helpParts("The macOS a box runs, such as 26.x."), { lead: "The macOS a box runs, such as 26.x.", more: "" });
});

test("every field has help, and its first sentence is a sentence of its own", () => {
  for (const { where, text } of fieldHelp()) {
    assert.ok(text.trim(), `${where} has no help`);
    const { lead } = helpParts(text);
    assert.match(lead, /^[A-Z0-9]/, `${where}: its first sentence starts with a capital: ${lead}`);
    assert.match(lead, /[.!?]$/, `${where}: its first sentence ends with a full stop: ${lead}`);
  }
});

test(`every help text's first sentence is at most ${LONGEST_LEAD} characters`, () => {
  const long = pageHelp()
    .map(({ where, text }) => ({ where, lead: helpParts(text).lead }))
    .filter(({ lead }) => lead.length > LONGEST_LEAD)
    .map(({ where, lead }) => `${where} (${lead.length}): ${lead}`);
  assert.deepEqual(long, []);
});

test("help's first sentence names kinds as people read them, not by their IDs", () => {
  const named = fieldHelp().flatMap(({ where, text }) => {
    const { lead } = helpParts(text);
    return kindIds.filter((id) => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(lead)).map((id) => `${where}: ${id}`);
  });
  assert.deepEqual(named, []);
});

test("no help says a kind is not offered yet, or calls an empty field unset", () => {
  const stale = fieldHelp()
    .filter(({ text }) => /not offered yet|\bUnset\b/.test(text))
    .map(({ where }) => where);
  assert.deepEqual(stale, []);
});
