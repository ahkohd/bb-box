// Runs the backend conformance suite against a live backend, without BB:
//
//   npm run conformance -- --backend <type> --settings <settings.json>
//     [--kind <kind>]... [--skip <check>=<reason>]...
//
// The settings file is as scripts/smoke.ts reads it: one JSON object with
// bb-box's settings, and values that can come from files. The suite is an
// install of its own, "conformance", so a bb-box install on the same backend
// leaves its boxes alone. Each backend instance it makes starts on empty
// storage, as after a lost database. --skip names a check this run cannot
// do, such as --skip enrol="no BB server here".

import { parseArgs } from "node:util";
import { DRIVERS } from "../src/backends/index.ts";
import { conformance, type ConformanceCheck } from "../test/conformance/suite.ts";
import { MemoryStorage } from "../test/helpers.ts";
import { readSettings } from "./smoke.ts";

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
const driver = DRIVERS.find((other) => other.type === values.backend);
if (!driver) throw new Error(`No backend is called ${values.backend}. There are ${DRIVERS.map((other) => other.type).join(" and ")}.`);
const parsed = driver.parse(readSettings(values.settings));
if (!parsed.enabled) throw new Error(`${driver.label} is off in ${values.settings}.`);
if (!parsed.ok) throw new Error(`${driver.label}: ${parsed.problems.join(" ")}`);
const skip: Partial<Record<ConformanceCheck, string>> = {};
for (const item of values.skip ?? []) {
  const [check, reason] = item.split(/=(.*)/s);
  if (!check || !reason) throw new Error(`Give --skip as <check>=<reason>, not ${item}.`);
  skip[check as ConformanceCheck] = reason;
}

await conformance({
  name: driver.label,
  storage: new MemoryStorage(),
  create: (storage, installId) =>
    driver.create(parsed.config, {
      storage,
      installId,
      logError: (operation, error) => console.error(`# ${operation}: ${error instanceof Error ? error.message : String(error)}`),
    }),
  kinds: values.kind,
  skip,
  timeoutMs: 600_000,
});
