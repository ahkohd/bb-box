import { createCollector, type Collector, type ProcessScope } from "../monitor/collector.ts";
import { createDemandSampler } from "../monitor/demand-sampler.ts";
import { stopMacSensors } from "../monitor/mac-sensors.ts";
import type { MonitorSnapshot } from "../monitor/snapshot.ts";

export interface MonitorOptions {
  readonly collector?: (scope: ProcessScope, refreshIntervalMs: () => number) => Collector;
}

export function monitorHandlers(options: MonitorOptions = {}) {
  const makeCollector = options.collector ?? ((scope, refreshIntervalMs) => createCollector({ refreshIntervalMs, scope }));
  let refreshIntervalMs = 5000;
  const samplers = new Map<ProcessScope, ReturnType<typeof createDemandSampler<MonitorSnapshot>>>();
  const samplerFor = (scope: ProcessScope) => {
    let sampler = samplers.get(scope);
    if (!sampler) {
      const collector = makeCollector(scope, () => refreshIntervalMs);
      sampler = createDemandSampler({ collect: collector.collect, intervalMs: () => refreshIntervalMs, reset: collector.reset });
      samplers.set(scope, sampler);
    }
    return sampler;
  };
  return {
    handlers: {
      monitor: async ({ refreshIntervalMs: requested, force, scope }: { refreshIntervalMs: number; force: boolean; scope?: ProcessScope }) => {
        refreshIntervalMs = requested;
        return { ...(await samplerFor(scope ?? "machine").sample(force)), refreshIntervalMs };
      },
    },
    async dispose() {
      for (const sampler of samplers.values()) sampler.dispose();
      samplers.clear();
      stopMacSensors();
    },
  };
}
