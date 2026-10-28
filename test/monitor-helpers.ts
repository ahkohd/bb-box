import type { TestContext } from "node:test";
import { defineCli } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { MONITOR_DEFAULTS, type MonitorConfig } from "../src/core/document.ts";
import { monitorCommands } from "../src/plugin/monitor-cli.ts";
import { startMonitor, type MonitorDeps } from "../src/plugin/monitor.ts";

export const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function testDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
  return {
    settings: () => ({ ...MONITOR_DEFAULTS }),
    hosts: async () => [],
    serverHostId: async () => null,
    boxes: async () => [],
    hostSnapshot: async () => {
      throw new Error("no host entry in this test");
    },
    runInBox: async () => {
      throw new Error("no box in this test");
    },
    encoderRoom: async () => null,
    log: { warn: () => undefined },
    ...overrides,
  };
}

export async function startTestMonitor(t: TestContext, options: { config?: Partial<MonitorConfig>; deps?: Partial<MonitorDeps> } = {}) {
  let config: MonitorConfig = { ...MONITOR_DEFAULTS, ...options.config };
  const { bb, harness } = createFakePluginHost({ pluginId: "bb-box" });
  const monitor = startMonitor(bb, testDeps({ settings: () => config, ...options.deps }));
  bb.cli.register(defineCli({ name: "box", summary: "Boxes for BB threads.", commands: monitorCommands(bb, monitor) }));
  t.after(() => harness.lifecycle.dispose());
  const setConfig = (patch: Partial<MonitorConfig>) => {
    config = { ...config, ...patch };
    monitor.configure(config);
  };
  return { bb, harness, monitor, setConfig };
}
