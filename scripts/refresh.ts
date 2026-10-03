// Refreshes one standard image on a live backend, without BB (049):
//
//   npm run refresh -- --backend <type> --settings <settings.json> --image <ref>
//     [--bb-url <url>] [--pinned] [--try]
//
// The settings file is as scripts/conformance.ts reads it. <ref> is the
// image's current build, such as a template's VMID; --try builds and checks
// a new one, then removes it and leaves the current one. --bb-url gives the
// image BB's app from that server. The refresh is an install of its own,
// "refresh", so a bb-box install on the same backend leaves its boxes alone.

import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { DRIVERS } from "../src/backends/index.ts";
import { backendPart } from "../src/core/document.ts";
import { refreshImage } from "../src/core/refresh.ts";
import { defaultSize, kindSizes, presetSizes } from "../src/core/sizes.ts";
import { bbAppDigest } from "../src/plugin/docker-images.ts";
import { MemoryStorage } from "../test/helpers.ts";
import { readSettings, toConfiguration } from "./smoke.ts";

const USAGE = "usage: npm run refresh -- --backend <type> --settings <settings.json> --image <ref> [--bb-url <url>] [--pinned] [--try]";

const { values } = parseArgs({
  options: {
    backend: { type: "string" },
    settings: { type: "string" },
    image: { type: "string" },
    "bb-url": { type: "string" },
    pinned: { type: "boolean" },
    try: { type: "boolean" },
  },
});
if (!values.backend || !values.settings || !values.image) throw new Error(USAGE);
const driver = DRIVERS.find((other) => other.type === values.backend);
if (!driver) throw new Error(`No backend is called ${values.backend}. There are ${DRIVERS.map((other) => other.type).join(" and ")}.`);
const configuration = toConfiguration(readSettings(values.settings));
if (configuration.problems.length) throw new Error(configuration.problems.join(" "));
const config = configuration.document.backends.find((other) => other.type === driver.type);
if (!config?.enabled) throw new Error(`${driver.label} is off in ${values.settings}.`);
const parsed = driver.parse(backendPart(config, driver, configuration.secrets, configuration.document.backends));
if (!parsed.ok) throw new Error(`${driver.label}: ${parsed.problems.map((problem) => problem.message).join(" ")}`);

const backend = driver.create(parsed.config, {
  id: config.id,
  storage: new MemoryStorage(),
  installId: "refresh",
  warm: () => 0,
  warmShortfalls: () => {},
  hostOn: () => true,
  kind: (id) => {
    const sizes = kindSizes(id);
    return { enabled: true, defaultSize: defaultSize(sizes), presets: presetSizes(sizes) };
  },
  logError: (operation, error) => console.error(`# ${operation}: ${error instanceof Error ? error.message : String(error)}`),
});
try {
  if (!backend.images) throw new Error(`${driver.label} has no image operations.`);
  const current = (await backend.images.list()).builds.find((build) => build.ref === values.image && build.current);
  if (!current) throw new Error(`${driver.label} has no current standard build ${values.image}: give a template from its settings.`);
  const bbUrl = values["bb-url"] ?? null;
  const result = await refreshImage({
    images: backend.images,
    current,
    setup: fileURLToPath(new URL("../setup/", import.meta.url)),
    bbUrl,
    bbApp: bbUrl ? await bbAppDigest(bbUrl) : null,
    pinned: !!values.pinned,
    replace: !values.try,
    signal: AbortSignal.timeout(3 * 60 * 60_000),
    log: (line) => console.log(`  ${line}`),
  });
  console.log(`\n${result.ok ? "ok" : "FAILED"} in ${result.seconds} s${result.build ? `: ${values.image} is now ${result.build.build}` : ""}`);
  for (const check of result.checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  if (result.reason) console.log(result.reason);
  process.exitCode = result.ok ? 0 : 1;
} finally {
  await backend.dispose?.();
}
