import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { test } from "node:test";
import { ATTACH_PING, exitCodeFromInspect, readAfterHalfClose } from "../src/backends/docker/attach.ts";
import { MISSING_STATUS } from "../src/backends/docker/transport.ts";
import { CommandLine } from "../src/transports/process.ts";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, testContext } from "./helpers.ts";
import type { AcquireHooks, BoxIdentity, MachineSize } from "../src/backends/types.ts";

const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const signal = () => AbortSignal.timeout(30_000);

function listen(answer: string | null): Promise<{ port: number; close: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {});
    socket.on("end", () => socket.end(answer ?? ""));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        close: () =>
          new Promise((done) => {
            for (const socket of open) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

test("a forwarder that drops output after a half-close fails the doctor and is not an exit status", async () => {
  const dropped = await listen(null);
  const honest = await listen("OK");
  const inspected = await listen(`HTTP/1.1 200 OK\r\n\r\n${JSON.stringify({ Running: false, ExitCode: 3 })}`);
  try {
    assert.equal(await readAfterHalfClose(honest.port, "127.0.0.1", ATTACH_PING, 1_000), "OK");
    assert.equal(await readAfterHalfClose(dropped.port, "127.0.0.1", ATTACH_PING, 1_000), "");
    assert.equal(exitCodeFromInspect(await readAfterHalfClose(dropped.port, "127.0.0.1", "GET /exec/abc/json HTTP/1.1\r\nHost: docker\r\n\r\n", 1_000)), null);
    assert.equal(exitCodeFromInspect(await readAfterHalfClose(inspected.port, "127.0.0.1", "GET /exec/abc/json HTTP/1.1\r\nHost: docker\r\n\r\n", 1_000)), 3);
    assert.equal(exitCodeFromInspect(JSON.stringify({ Running: true, ExitCode: 0 })), null);

    const fake = fakeDockerHost({ kernelVersion: "6.6.87.2-microsoft-standard-WSL2" });
    const backend = new DockerBackend(dockerConfig({ host: `tcp://127.0.0.1:${dropped.port}` }), testContext(), { binary: fake.binary, readyTimeoutMs: 2_000 });
    const report = await backend.doctor(signal());
    const check = report.checks.find((entry) => entry.id === "docker.attach");
    assert.equal(check?.status, "fail");
    assert.match(check?.detail ?? "", /localhost forwarder/);
    assert.match(check?.fix ?? "", /wsl:\/\//);

    const kept = new DockerBackend(dockerConfig({ host: `tcp://127.0.0.1:${honest.port}` }), testContext(new MemoryStorage(), "other"), { binary: fake.binary, readyTimeoutMs: 2_000 });
    const ok = await kept.doctor(signal());
    assert.equal(ok.checks.find((entry) => entry.id === "docker.attach")?.status, "ok");

    const linux = new DockerBackend(dockerConfig({ host: `tcp://127.0.0.1:${dropped.port}` }), testContext(new MemoryStorage(), "linux-host"), { binary: fakeDockerHost().binary, readyTimeoutMs: 2_000 });
    const plain = await linux.doctor(signal());
    assert.equal(plain.checks.some((entry) => entry.id === "docker.attach"), false);

    const missing = new CommandLine({
      argv: () => ["/bin/sh", "-c", "exit 0"],
      statusFromMark: true,
      missingStatus: MISSING_STATUS,
      recoverStatus: async () => exitCodeFromInspect(await readAfterHalfClose(dropped.port, "127.0.0.1", "GET /exec/abc/json HTTP/1.1\r\nHost: docker\r\n\r\n", 1_000)),
    });
    await assert.rejects(missing.run("hostname; echo x; exit 3"), /without an exit status/);

    const seen = new CommandLine({
      argv: () => ["/bin/sh", "-c", "exit 0"],
      statusFromMark: true,
      missingStatus: MISSING_STATUS,
      recoverStatus: async () => exitCodeFromInspect(await readAfterHalfClose(inspected.port, "127.0.0.1", "GET /exec/abc/json HTTP/1.1\r\nHost: docker\r\n\r\n", 1_000)),
    });
    assert.equal((await seen.run("exit 3")).exitCode, 3);
  } finally {
    await dropped.close();
    await honest.close();
    await inspected.close();
  }
});

test("docker exec that exits 0 without an end mark is not a success", async () => {
  const fake = fakeDockerHost();
  const backend = new DockerBackend(dockerConfig(), testContext(), { binary: fake.binary, readyTimeoutMs: 2_000 });
  let n = 0;
  const identity = (): BoxIdentity => {
    n += 1;
    return { boxId: `bxwsl${String(n).padStart(9, "0")}`, threadId: "thr_abc123", name: `calm-otter-${n}`, kind: "linux", createdAt: 1_790_000_000_000, size: { ...SMALL, gpu: "none" } };
  };
  const hooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
  const guest = await backend.acquire(identity(), null, hooks, signal());
  fake.set({ dropAttach: true });
  const { command } = await backend.transports(guest, "linux");
  await assert.rejects(command!.run("hostname; echo x; exit 3"), /without an exit status/);
});

test("a wsl host that cannot start wsl.exe fails the doctor with the reason", async () => {
  const fake = fakeDockerHost();
  const backend = new DockerBackend(dockerConfig({ host: "wsl://bbdocker" }), testContext(), { binary: fake.binary, readyTimeoutMs: 2_000 });
  const report = await backend.doctor(signal());
  const cli = report.checks.find((entry) => entry.id === "docker.cli");
  assert.equal(cli?.status, "fail");
  assert.match(`${cli?.detail ?? ""} ${cli?.fix ?? ""}`, /wsl\.exe/);
  assert.equal(report.checks.find((entry) => entry.id === "docker.daemon")?.status, "skipped");
});
