import { DRIVERS } from "../src/backends/index.ts";
import { backendPart } from "../src/core/document.ts";
import { defaultSize, kindSizes, presetSizes } from "../src/core/sizes.ts";
import type { Backend, BackendStorage } from "../src/backends/types.ts";
import { readSettings, toConfiguration } from "./smoke.ts";

export interface LiveBackend {
  readonly label: string;
  readonly type: string;
  readonly create: (storage: BackendStorage, installId: string) => Backend;
}

export function liveBackend(type: string, settingsPath: string): LiveBackend {
  const driver = DRIVERS.find((other) => other.type === type);
  if (!driver) throw new Error(`No backend is called ${type}. There are ${DRIVERS.map((other) => other.type).join(" and ")}.`);
  const configuration = toConfiguration(readSettings(settingsPath));
  if (configuration.problems.length) throw new Error(configuration.problems.join(" "));
  const backend = configuration.document.backends.find((other) => other.type === driver.type);
  if (!backend?.enabled) throw new Error(`${driver.label} is off in ${settingsPath}.`);
  const parsed = driver.parse(backendPart(backend, driver, configuration.secrets, configuration.document.backends));
  if (!parsed.ok) throw new Error(`${driver.label}: ${parsed.problems.map((problem) => problem.message).join(" ")}`);

  const create = (storage: BackendStorage, installId: string) =>
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
    });
  return { label: driver.label, type: driver.type, create };
}

export function create(storage: BackendStorage, installId: string, args: readonly string[]): Backend {
  const [type, settingsPath] = args;
  if (!type || !settingsPath) throw new Error("Give the backend's type and its settings file.");
  return liveBackend(type, settingsPath).create(storage, installId);
}
