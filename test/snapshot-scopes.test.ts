import assert from "node:assert/strict";
import { test } from "node:test";
import type { SnapshotScope } from "../src/backends/types.ts";
import { footerWords, narrowerScopeHoldsLine, offerHoldsWords } from "../src/app/snapshot-words.ts";
import { holdsWords, notForkedForScope, notKeptForScope, snapshottingWords } from "../src/core/snapshot.ts";
import type { BoxSnapshotsView } from "../src/plugin/contract.ts";

function offered(scope: SnapshotScope): Pick<BoxSnapshotsView, "offer"> {
  return { offer: { holds: ["disk"], scope, whileRunning: "pauses", restore: "in-place", fork: "none", keeps: false, excludes: null, price: null } };
}

test("a home snapshot and a machine snapshot each say what they hold", () => {
  assert.equal(holdsWords({ scope: "home", holds: "disk" }), "home folder");
  assert.equal(holdsWords({ scope: "machine", holds: "disk" }), "whole machine's disk");
  assert.equal(snapshottingWords(["disk"], "pauses", "home"), "its home folder, pausing it for a moment");
  assert.equal(snapshottingWords(["disk"], "live", "machine"), "the whole machine's disk, while it runs");
  assert.equal(offerHoldsWords(offered("home")), "home folder");
  assert.match(narrowerScopeHoldsLine("home", "amber-fox"), /^It holds amber-fox's home folder: its files, settings and keychain\. Not apps installed on the machine/);
  assert.match(footerWords({ ...offered("machine"), noneWhy: null } as BoxSnapshotsView, "amber-fox"), /^Snapshots hold the whole machine's disk, by its operator's snapshot hook\./);
});

test("neither a home snapshot nor a machine snapshot is kept past release or forked, each with its own reason", () => {
  assert.match(notKeptForScope("home", "amber-fox") ?? "", /home folder only, on a machine BB Box lends to other boxes after the release/);
  assert.match(notKeptForScope("machine", "amber-fox") ?? "", /whole machine box amber-fox was lent/);
  assert.match(notForkedForScope("home", "amber-fox") ?? "", /BB Box does not fork home folders/);
  assert.match(notForkedForScope("machine", "amber-fox") ?? "", /holds alone/);
});

test("a box snapshot and a device snapshot keep the words they had", () => {
  assert.equal(holdsWords({ scope: "box", holds: "disk-and-memory" }), "disk and memory");
  assert.equal(holdsWords({ scope: "device", holds: "disk-and-memory" }), "device");
  assert.equal(notKeptForScope("box", "amber-fox"), null);
  assert.equal(notForkedForScope("box", "amber-fox"), null);
  assert.equal(snapshottingWords(["disk", "disk-and-memory"], "live"), "its disk, or its disk and memory, while it runs");
});
