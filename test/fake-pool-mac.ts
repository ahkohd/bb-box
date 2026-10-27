import assert from "node:assert/strict";
import { SshPoolBackend, type SshPoolBackendOptions } from "../src/backends/ssh-pool/backend.ts";
import { parseSshPoolSettings } from "../src/backends/ssh-pool/config.ts";
import type { BackendStorage } from "../src/backends/types.ts";
import { fakeDeviceHost, type FakeDeviceHost } from "./fake-device-host.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

export const POOL_MAC = "192.0.2.30";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDbH0n7Bm2fQzZ0lH8w5j0c0pYh7J6Hq4Xb1x2u3v4w";

function quoted(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

export interface FakePoolMac {
  readonly mac: FakeDeviceHost;
  readonly ssh: ReturnType<typeof fakeSsh>;
  readonly helperCommand: string;
  backend(settings?: Record<string, unknown>, storage?: BackendStorage, options?: SshPoolBackendOptions): SshPoolBackend & { readonly context: ReturnType<typeof testContext> };
}

export function fakePoolMac(options: { kinds?: string } = {}): FakePoolMac {
  const ssh = fakeSsh();
  const mac = fakeDeviceHost();
  mac.flag("screensharing");
  assert.equal(mac.machine(["init"]).status, 0);
  const init = mac.run(["init"], "kept=yes\nmost=12\nahead=1\nresetting-most=4\ndisk-reserve-gib=40\n");
  assert.equal(init.status, 0, init.stderr);
  const env = Object.entries(mac.env).map(([key, value]) => `${key}=${quoted(value)}`).join(" ");
  const helperCommand = `env ${env} /bin/sh ${quoted(mac.machineHelper)}`;
  const disposed = disposedOnceTheFileEnds();
  return {
    mac,
    ssh,
    helperCommand,
    backend(settings = {}, storage = new MemoryStorage(), more = {}) {
      const parsed = parseSshPoolSettings({
        "ssh-pool-enabled": true,
        "ssh-pool-machines": `mac-1 bbbox-admin@${POOL_MAC} ${options.kinds ?? "macos,macos-desktop,ios"}`,
        "ssh-pool-known-hosts": `${POOL_MAC} ${HOST_KEY}`,
        "ssh-pool-ios-hosts-ahead": 0,
        ...settings,
      });
      assert.ok(parsed.enabled && parsed.ok, JSON.stringify(parsed));
      const context = testContext(storage, "test");
      const backend = new SshPoolBackend(parsed.config, context, { sshBinary: FAKE_SSH_BINARY, helperCommand, sleep: async () => {}, readyTimeoutMs: 0, resetPollMs: 1, ...more });
      return disposed(Object.assign(backend, { context }));
    },
  };
}
