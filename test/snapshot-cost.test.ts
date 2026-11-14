import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Price } from "../src/backends/types.ts";
import { SNAPSHOT_DEFAULTS, ceilingOf, readDraft, snapshotConfig } from "../src/core/document.ts";
import { CEILING_CHANGES, ceilingVerdict, heldRate, monthlyRate, moneyWords, spentThisMonth, type CeilingChange, type HeldRate } from "../src/core/snapshot-cost.ts";
import { roomThresholds } from "../src/core/snapshot.ts";

const DAY = 24 * 60 * 60_000;
const BOAT: Price = { amount: 0.056, currency: "USD", per: "day", known: true };

function held(monthly: number, count = 2): HeldRate {
  return { currency: "USD", count, monthly, unknown: 0 };
}

function verdict(change: CeilingChange, monthly: number, ceiling = 5, price: Price | null = BOAT, byPerson = true) {
  return ceilingVerdict({ change, backend: "boat.dev", held: held(monthly), price, bytes: null, ceiling, byPerson });
}

test("the ceiling admits take, undo and held copy only if the rate after them is within it, and Keep and renewal only while the rate is", () => {
  for (const change of ["take", "undo", "held-copy"] as const) {
    assert.equal(verdict(change, 3.36).ok, false, `${change} past the ceiling`);
    assert.equal(verdict(change, 3.32).ok, true, `${change} to exactly $5.00`);
    assert.deepEqual(verdict(change, 3.36), { ok: false, why: "It would bring snapshots held on boat.dev to about $5.04 a month, past your ceiling of $5.00. Delete one, or raise the ceiling in Settings, Snapshots, Paid snapshots." });
  }
  for (const change of ["keep", "renew"] as const) {
    assert.equal(verdict(change, 5).ok, true, `${change} at the ceiling adds nothing`);
    const past = verdict(change, 5.04, 3);
    assert.equal(past.ok, false);
    assert.match(past.ok ? "" : past.why, /^Snapshots held on boat\.dev cost about \$5\.04 a month, past your ceiling of \$3\.00, so BB Box does not (keep|renew) a paid snapshot there\. Delete one, or raise/);
  }
  assert.deepEqual([...CEILING_CHANGES], ["take", "undo", "keep", "renew", "held-copy"]);
  for (const change of CEILING_CHANGES) assert.equal(verdict(change, 999, 0, null).ok, true, "a free snapshot is never refused by a ceiling");
  assert.equal(verdict("take", 0, 0).ok, false, "a ceiling of 0 refuses every paid take");
});

test("a price BB Box does not know is admitted only for the person; per-GB prices need the size", () => {
  const unknown: Price = { amount: 0, currency: "USD", per: "day", known: false };
  assert.equal(verdict("take", 0, 5, unknown, true).ok, true);
  assert.deepEqual(verdict("undo", 0, 5, unknown, false), { ok: false, why: "BB Box does not know what a snapshot on boat.dev costs, so only you can take an undo there." });
  const perGb: Price = { amount: 0.05, currency: "EUR", per: "GB-month", known: true };
  assert.equal(monthlyRate(perGb, 20e9), 1);
  assert.equal(monthlyRate(perGb, null), null);
  assert.equal(monthlyRate({ amount: 2, currency: "USD", per: "month", known: true }, null), 2);
  assert.equal(moneyWords(5.035, "EUR"), "EUR 5.04");
  assert.equal(moneyWords(5, "USD"), "$5.00");
});

test("the rate held counts every paid snapshot the provider holds, taking ones included, and never failed or lost ones", () => {
  const base = { backend: { id: "boat", label: "boat.dev" }, price: BOAT, size: null };
  const records = [
    { ...base, state: "ready" },
    { ...base, state: "taking" },
    { ...base, state: "failed" },
    { ...base, state: "lost" },
    { ...base, state: "ready", price: null },
    { ...base, state: "ready", backend: { id: "other", label: "other" } },
    { ...base, state: "ready", price: { ...BOAT, known: false } },
  ] as never[];
  const rate = heldRate(records, "boat");
  assert.equal(rate.count, 3);
  assert.equal(rate.unknown, 1);
  assert.equal(rate.monthly.toFixed(2), "3.36");
});

test("this month's spend counts each charge's days within the calendar month, ended ones included", () => {
  const now = Date.UTC(2026, 10, 3, 12);
  const start = Date.UTC(2026, 10, 1);
  const charges = [
    { snapshot: "a", backend: "boat", currency: "USD" as const, daily: 1, from: start - 5 * DAY, until: start + DAY },
    { snapshot: "b", backend: "boat", currency: "USD" as const, daily: 2, from: start + DAY, until: null },
    { snapshot: "c", backend: "boat", currency: "USD" as const, daily: 9, from: start - 9 * DAY, until: start - DAY },
  ];
  assert.equal(spentThisMonth(charges, now), 1 + 2 * 1.5);
});

test("the snapshot settings: defaults, the room's thresholds, and the configuration's checks", () => {
  assert.deepEqual(snapshotConfig({ general: {} }), { perBox: 5, roomPercent: 85, keepDays: 30, agentsRestore: true, agentsMemory: true, pictures: true, ceilings: {} });
  assert.deepEqual(roomThresholds(85), { takes: 85, metadata: 80, sweep: 92 });
  assert.deepEqual(roomThresholds(50), { takes: 50, metadata: 45, sweep: 57 });
  assert.equal(ceilingOf(snapshotConfig({ general: { snapshots: { ceilings: { boat: 12.5 } } } }), "boat"), 12.5);
  assert.equal(ceilingOf(snapshotConfig({ general: {} }), "boat"), SNAPSHOT_DEFAULTS.ceiling);
  const good = readDraft({ general: { snapshots: { perBox: 50, roomPercent: 50, keepDays: 365, agentsRestore: false, agentsMemory: false, pictures: false, ceilings: { boat: 7.5, other: 0 } } } }, []);
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.document.general.snapshots, { perBox: 50, roomPercent: 50, keepDays: 365, agentsRestore: false, agentsMemory: false, pictures: false, ceilings: { boat: 7.5, other: 0 } });
  const bad = readDraft({ general: { snapshots: { perBox: 0, roomPercent: 91, keepDays: 1.5, pictures: "yes", ceilings: { boat: 5.001, other: 1001 }, often: 1 } } }, []);
  assert.deepEqual(
    bad.problems.map((problem) => problem.path),
    ["general.snapshots.perBox", "general.snapshots.roomPercent", "general.snapshots.keepDays", "general.snapshots.pictures", "general.snapshots.ceilings.boat", "general.snapshots.ceilings.other", "general.snapshots.often"],
  );
  assert.equal(bad.problems[0]!.message, "Use a whole number of snapshots a box from 1 to 50.");
  assert.equal(bad.problems[1]!.message, "Use a whole number of percent from 50 to 90.");
  assert.equal(bad.problems[4]!.message, "Use an amount a month from 0 to 1000, in whole cents, such as 5 or 7.50.");
  assert.equal(bad.document.general.snapshots, undefined);
});
