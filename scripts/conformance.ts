// Runs the backend conformance suite against a live backend, without BB:
//
//   npm run conformance -- --backend <type> --settings <settings.json>
//     [--kind <kind>]... [--skip <check>=<reason>]...
//
// The settings file is as scripts/smoke.ts reads it: bb-box's configuration,
// or BB's settings from before it, and values that can come from files. The suite is an
// install of its own, "conformance", so a bb-box install on the same backend
// leaves its boxes alone. Each backend instance it makes starts on empty
// storage, as after a lost database. --skip names a check this run cannot
// do, such as --skip enrol="no BB server here".

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { conformance, slotConformance, type ConformanceCheck } from "../test/conformance/suite.ts";
import { SLOT_KINDS } from "../src/core/device-host.ts";
import { MemoryStorage } from "../test/helpers.ts";
import { liveBackend } from "./live-backend.ts";

const USAGE = "usage: npm run conformance -- --backend <type> --settings <settings.json> [--kind <kind>]... [--skip <check>=<reason>]...";

const { values } = parseArgs({
  options: {
    backend: { type: "string" },
    settings: { type: "string" },
    kind: { type: "string", multiple: true },
    skip: { type: "string", multiple: true },
  },
});
if (!values.backend || !values.settings) throw new Error(USAGE);
const settings = resolve(values.settings);
const driver = liveBackend(values.backend, settings);
const skip: Partial<Record<ConformanceCheck, string>> = {};
for (const item of values.skip ?? []) {
  const [check, reason] = item.split(/=(.*)/s);
  if (!check || !reason) throw new Error(`Give --skip as <check>=<reason>, not ${item}.`);
  skip[check as ConformanceCheck] = reason;
}

const live = driver.create;

const lending = live(new MemoryStorage(), "conformance");
const slotKinds = SLOT_KINDS.filter((kind) => lending.slots?.lends(kind) && (!values.kind || values.kind.includes(kind)));
await lending.dispose?.();
for (const kind of slotKinds) await slotConformance({ name: driver.label, create: () => live(new MemoryStorage(), "conformance"), kind, elastic: driver.type !== "ssh-pool", timeoutMs: 600_000 });

await conformance({
  name: driver.label,
  storage: new MemoryStorage(),
  create: live,
  kinds: values.kind,
  skip,
  timeoutMs: 600_000,
  testDevice: true,
  elsewhere: { module: new URL("./live-backend.ts", import.meta.url).href, args: [driver.type, settings] },
});
