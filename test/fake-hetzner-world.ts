import { DockerCli } from "../src/backends/docker/cli.ts";
import { HetznerBackend, type HetznerConfig } from "../src/backends/hetzner/backend.ts";
import type { HostRecord } from "../src/backends/hetzner/hosts.ts";
import type { BackendStorage, FieldValue } from "../src/backends/types.ts";
import { dockerConfig, fakeDockerHost, type FakeDockerHost } from "./fake-docker.ts";
import { FAKE_HETZNER_TOKEN, FakeHetzner } from "./fake-hetzner.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

export const CPX42_MEMORY_MiB = 16_384;

export function hetznerConfig(overrides: Partial<HetznerConfig> = {}, dockerFields: Record<string, FieldValue> = {}): HetznerConfig {
  return {
    token: FAKE_HETZNER_TOKEN,
    location: "nbg1",
    serverType: "cpx42",
    hostImage: "ubuntu-24.04",
    hostImageLabel: "b1",
    mostHosts: 2,
    idleMinutes: 30,
    monthlyLimitEurosBeforeVat: null,
    docker: dockerConfig({ "reserve-memory-mib": 2048, ...dockerFields }),
    ...overrides,
  };
}

export function hetznerWorld(hostFacts: Record<string, unknown> = {}) {
  const api = new FakeHetzner();
  const dockerHosts = new Map<string, FakeDockerHost>();
  const silentFromTheStart = new Set<string>();
  const reachHost = (record: HostRecord) => {
    let host = dockerHosts.get(record.hostId);
    if (!host) {
      host = fakeDockerHost({ name: record.serverName, cpus: 8, memoryMiB: CPX42_MEMORY_MiB, ...hostFacts, ...(silentFromTheStart.has(record.hostId) ? { down: true } : {}) });
      dockerHosts.set(record.hostId, host);
    }
    return new DockerCli(`unix:///run/bb-box/hetzner/${record.hostId}.sock`, host.binary, async () => {});
  };
  const backend = (config: HetznerConfig = hetznerConfig(), storage: BackendStorage = new MemoryStorage(), installId = "test") =>
    new HetznerBackend(config, testContext(storage, installId, { id: "hetzner" }), {
      fetch: api.fetch,
      sleep: async () => {},
      now: () => api.now,
      reachHost,
      dockerOptions: { readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh" },
      pollMs: 1,
    });
  return { api, dockerHosts, silentFromTheStart, backend };
}
