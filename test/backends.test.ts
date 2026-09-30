// The set of backends: offers of one kind from several backends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { offerChecks, type OfferedKind } from "../src/backends/index.ts";
import type { Backend, BoxKind } from "../src/backends/types.ts";
import { FAKE_KINDS } from "./fake-backend.ts";

const [HEADLESS, DESKTOP] = FAKE_KINDS as [BoxKind, BoxKind];

function offer(label: string, kind: BoxKind): OfferedKind {
  return { kind, backend: { id: label.toLowerCase(), label } as Backend };
}

test("a kind one backend offers needs no check", () => {
  assert.deepEqual(offerChecks([offer("One", HEADLESS), offer("One", DESKTOP)]), []);
});

test("offers of a kind that agree pass, whatever their size and extra features", () => {
  const bigger = { ...HEADLESS, size: "8 cores", capabilities: { ...HEADLESS.capabilities, features: ["docker"] } };
  const [check] = offerChecks([offer("One", HEADLESS), offer("Two", bigger)]);
  assert.deepEqual(check, {
    id: "offers.linux-headless",
    name: "Offers of linux-headless",
    status: "ok",
    detail: "One and Two offer it and agree.",
    fix: null,
  });
});

test("offers that disagree on what the kind promises warn, and say how", () => {
  const gpu = { ...HEADLESS, requires: ["docker"], capabilities: { ...HEADLESS.capabilities, gpu: true, features: [] } };
  const [check] = offerChecks([offer("One", HEADLESS), offer("Two", gpu)]);
  assert.equal(check?.status, "warn");
  assert.match(check!.detail, /Two offers linux-headless without docker, which the kind requires/);
  assert.match(check!.detail, /One and Two disagree on GPU for linux-headless: false and true/);
  assert.match(check!.detail, /disagree on required features for linux-headless: none and docker/);
  assert.match(check!.fix!, /Make the offers of linux-headless match/);
});

test("an offer with a computer-use driver but no command transport warns, even alone", () => {
  const unreachable = { ...DESKTOP, capabilities: { ...DESKTOP.capabilities, command: null } };
  const [check] = offerChecks([offer("One", unreachable)]);
  assert.equal(check?.status, "warn");
  assert.equal(check?.detail, "One offers linux-desktop with a computer-use driver but no command transport, so the computer tools cannot reach the driver.");
});
