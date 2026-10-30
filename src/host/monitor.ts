import { createCollector, type Collector, type ProcessScope } from "../monitor/collector.ts";
import { createDemandSampler } from "../monitor/demand-sampler.ts";
import { stopMacSensors } from "../monitor/mac-sensors.ts";
import type { MonitorSnapshot } from "../monitor/snapshot.ts";
import { readLightHere } from "../monitor/light-local.ts";
import type { LightReading, LightRequest, LightWire } from "../monitor/light.ts";

const LIGHT_TIMEOUT_MS = 8_000;

export interface MonitorOptions {
  readonly collector?: (scope: ProcessScope, refreshIntervalMs: () => number) => Collector;
  readonly light?: (request: LightRequest, signal: AbortSignal) => Promise<LightReading>;
}

export function monitorHandlers(options: MonitorOptions = {}) {
  const readLight = options.light ?? readLightHere;
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
      "monitor.light": async (request: LightRequest) => (await readLight(request, AbortSignal.timeout(LIGHT_TIMEOUT_MS))) as LightWire,
    },
    async dispose() {
      for (const sampler of samplers.values()) sampler.dispose();
      samplers.clear();
      stopMacSensors();
    },
  };
}
