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
import { DRIVERS } from "../src/backends/index.ts";
import { backendPart } from "../src/core/document.ts";
import { defaultSize, kindSizes, presetSizes } from "../src/core/sizes.ts";
import { conformance, type ConformanceCheck } from "../test/conformance/suite.ts";
import { MemoryStorage } from "../test/helpers.ts";
import { readSettings, toConfiguration } from "./smoke.ts";

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
const configuration = toConfiguration(readSettings(values.settings));
if (configuration.problems.length) throw new Error(configuration.problems.join(" "));
const backend = configuration.document.backends.find((other) => other.type === driver.type);
if (!backend?.enabled) throw new Error(`${driver.label} is off in ${values.settings}.`);
const parsed = driver.parse(backendPart(backend, driver, configuration.secrets, configuration.document.backends));
if (!parsed.ok) throw new Error(`${driver.label}: ${parsed.problems.map((problem) => problem.message).join(" ")}`);
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
      id: backend.id,
      storage,
      installId,
      warm: () => 0,
      warmShortfalls: () => {},
      hostOn: () => true,
      kind: (id) => {
        const sizes = kindSizes(id);
        return { enabled: true, defaultSize: defaultSize(sizes), presets: presetSizes(sizes) };
      },
      logError: (operation, error) => console.error(`# ${operation}: ${error instanceof Error ? error.message : String(error)}`),
    }),
  kinds: values.kind,
  skip,
  timeoutMs: 600_000,
  testDevice: true,
});
