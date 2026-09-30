// The backend conformance suite: one set of checks every backend passes,
// whatever the provider. It runs against the fake backend and the Proxmox
// LXC backend on fakes in `npm test`, and against a live backend with
// `npm run conformance -- --backend <type> --env-file <file>`.
//
// Doctor runs first. When it finds a failure, the rest is skipped with its
// summary. Steps a kind does not support are skipped by its declared
// capabilities, never by backend name. A check a run cannot do (Docker in a
// fake box, a desktop stream the test machine cannot reach) is skipped with
// its reason, never passed silently.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type Capacity,
  type DoctorReport,
  type Guest,
  type Limit,
  type MachineNature,
  type ReleaseHooks,
} from "../../src/backends/types.ts";
import { quote } from "../../src/transports/process.ts";
import { openRoute } from "../../src/transports/route.ts";
import type { ByteChannel, CommandTransport } from "../../src/transports/types.ts";

export type ConformanceCheck = "arch" | "docker" | "display" | "enrol" | "stop-start" | "recovery" | "interrupted";

/** Enrolment in a live BB server. */
export interface ConformanceBb {
  /**
   * Runs BB's bootstrap in the box with the box ID as the key. The suite
   * calls it again after a stop and start, as bb-box does (017).
   */
  enrol(box: BoxIdentity, command: CommandTransport, signal: AbortSignal): Promise<void>;
  /** Whether the box's BB machine is connected to the server. */
  connected(box: BoxIdentity, signal: AbortSignal): Promise<boolean>;
}

export interface ConformanceOptions {
  readonly name: string;
  /** Makes the backend. Called again on the same storage to check recovery after a restart. */
  readonly create: (storage: BackendStorage) => Backend | Promise<Backend>;
  readonly storage: BackendStorage;
  /** Kinds to check. All the backend's kinds by default. */
  readonly kinds?: readonly string[];
  /** Checks this run cannot do, with the reason. */
  readonly skip?: Partial<Record<ConformanceCheck, string>>;
  /** Without it, only what enrolment needs in the box is checked. */
  readonly bb?: ConformanceBb;
  /** For each step that talks to the backend. */
  readonly timeoutMs?: number;
}

const THREAD = "thr_conformance";
const MiB = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]*$/;
/** After a stop and start, the box is connected to BB again this soon after it is ready (017). */
const RECONNECT_MS = 3_000;
/** Prints the SHA-256 of stdin, on Linux and macOS. */
const SHA256 = "if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-64";
const MIB_UNITS: readonly Limit["resource"][] = ["memory", "disk", "gpu-memory"];
const RESOURCES: readonly Limit["resource"][] = ["memory", "disk", "cpu", "guests", "gpu-desktops", "gpu-memory", "machines"];

export function identity(kind: string): BoxIdentity {
  const suffix = randomBytes(3).toString("hex");
  return { boxId: `box_conformance_${suffix}`, threadId: THREAD, name: `conformance-${suffix}`, kind, createdAt: Date.now() };
}

export function recordingHooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const hooks: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks, events, claimed, timings };
}

export function releaseHooks() {
  const events: string[] = [];
  const timings: Record<string, number> = {};
  const hooks: ReleaseHooks = {
    resetting: async () => {
      events.push("resetting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks, events, timings };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function checkTimings(timings: Record<string, number>): void {
  for (const [step, ms] of Object.entries(timings)) assert.ok(Number.isFinite(ms) && ms >= 0, `timing ${step} is a duration`);
}

/** The first `bytes` bytes a stream server sends, within `timeoutMs`. */
async function greeting(channel: ByteChannel, bytes: number, timeoutMs: number): Promise<string> {
  const reader = channel.readable.getReader();
  const timer = setTimeout(() => void reader.cancel(new Error(`No greeting within ${timeoutMs} ms.`)), timeoutMs);
  let data = Buffer.alloc(0);
  try {
    while (data.length < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      data = Buffer.concat([data, value]);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return data.subarray(0, bytes).toString("latin1");
}

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`${what} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function checkKind(kind: BoxKind): void {
  assert.match(kind.id, ID, "kind IDs are lowercase words joined by hyphens");
  assert.ok(kind.label.trim(), `${kind.id} has a label`);
  assert.ok(kind.description.trim(), `${kind.id} has a description`);
  assert.ok(kind.size.trim(), `${kind.id} says its size`);
  assert.ok(Number.isFinite(kind.readyTimeoutMs) && kind.readyTimeoutMs > 0, `${kind.id} has a ready timeout`);
  const capabilities = kind.capabilities;
  assert.ok(["linux", "windows", "macos"].includes(capabilities.os), `${kind.id} has a known OS`);
  assert.ok(["x86_64", "arm64"].includes(capabilities.arch), `${kind.id} has a known architecture`);
  for (const flag of ["gpu", "enrol"] as const) assert.equal(typeof capabilities[flag], "boolean", `${kind.id}.${flag}`);
  const computerUse = capabilities.computerUse;
  if (computerUse !== null) {
    assert.equal(computerUse.driver, "cua", `${kind.id} names a known computer-use driver`);
    assert.ok(computerUse.version.trim() && computerUse.socket.trim(), `${kind.id} pins the driver's version and names its socket`);
  }
  for (const feature of [...kind.requires, ...capabilities.features]) assert.match(feature, ID, `${kind.id} feature ${feature}`);
  for (const feature of kind.requires) assert.ok(capabilities.features.includes(feature), `${kind.id} has the ${feature} it requires`);
  const command = capabilities.command;
  if (command) {
    assert.ok(command.transport.trim(), `${kind.id} names its command transport`);
    assert.equal(command.shell, capabilities.os === "windows" ? "powershell" : "sh", `${kind.id} scripts are in the OS's shell`);
    for (const flag of ["admin", "inDesktopSession", "streaming"] as const) assert.equal(typeof command[flag], "boolean", `${kind.id}.command.${flag}`);
  }
  const ids = capabilities.displays.map((display) => display.id);
  assert.equal(new Set(ids).size, ids.length, `${kind.id} display IDs are unique`);
  for (const display of capabilities.displays) {
    assert.match(display.id, ID, `${kind.id} display ${display.id}`);
    assert.ok(["rfb", "selkies"].includes(display.protocol), `${kind.id} display ${display.id} has a known protocol`);
    assert.equal(typeof display.resizable, "boolean");
  }
  if (capabilities.enrol) {
    assert.equal(command?.shell, "sh", `${kind.id} enrols, so it runs sh commands`);
    assert.notEqual(capabilities.os, "windows", `${kind.id} enrols, so it is not Windows`);
  }
  if (computerUse) assert.ok(capabilities.displays.length && command, `${kind.id} offers computer use, so it has a display and commands`);
  if (capabilities.features.includes("docker")) assert.ok(command, `${kind.id} has Docker, so it runs commands`);
}

export function checkCapacity(capacity: Capacity, nature: MachineNature): void {
  assert.equal(typeof capacity.ok, "boolean");
  assert.equal(capacity.ok, capacity.message === null, "a message explains a refusal, and only a refusal");
  if (nature === "real") assert.equal(capacity.warm, null, "a real backend has no warm pool");
  if (capacity.warm) {
    for (const value of [capacity.warm.ready, capacity.warm.target]) assert.ok(Number.isInteger(value) && value >= 0, "warm counts");
  }
  assert.ok(capacity.hosts.length > 0, "capacity lists at least one host");
  for (const host of capacity.hosts) {
    assert.ok(host.host.trim(), "each host has a name");
    assert.equal(typeof host.ok, "boolean");
    for (const limit of host.limits) {
      const what = `${host.host} ${limit.resource}${limit.id ? ` ${limit.id}` : ""}`;
      assert.ok(RESOURCES.includes(limit.resource), `${what} is a known resource`);
      assert.equal(limit.unit, MIB_UNITS.includes(limit.resource) ? "MiB" : "count", `${what} unit`);
      assert.ok(limit.id === undefined || limit.id.trim(), `${what} ID`);
      for (const value of [limit.used, limit.reserve]) assert.ok(Number.isFinite(value) && value >= 0, `${what} figures`);
      assert.ok(limit.total === null || (Number.isFinite(limit.total) && limit.total >= 0), `${what} total`);
    }
  }
  if (capacity.hosts.some((host) => host.ok)) assert.ok(capacity.ok, "one more box fits when a host has room");
  if (nature === "real") {
    assert.ok(
      capacity.hosts.some((host) => host.limits.some((limit) => limit.resource === "machines")),
      "a real backend counts its machines",
    );
  }
}

export function checkDoctor(report: DoctorReport): void {
  assert.ok(report.checks.length > 0, "doctor runs at least one check");
  const ids = report.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "check IDs are unique");
  for (const check of report.checks) {
    assert.match(check.id, /^\S+$/, "each check has an ID");
    assert.ok(check.name.trim() && check.detail.trim(), `${check.id} has a name and a detail`);
    assert.ok(["ok", "warn", "fail", "skipped"].includes(check.status), `${check.id} has a known status`);
    if (check.status === "fail" || check.status === "warn") assert.ok(check.fix?.trim(), `${check.id} says how to fix it`);
  }
  assert.equal(report.ok, report.checks.every((check) => check.status !== "fail"), "ok means no check failed");
  assert.ok(report.summary.trim(), "doctor has a summary");
  for (const note of report.notes) assert.equal(typeof note, "string");
}

function describeDoctor(report: DoctorReport): string {
  const lines = report.checks.map((check) => `${check.status} ${check.name}: ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ""}`);
  return [`doctor: ${report.summary}`, ...lines].join("\n");
}

export async function conformance(options: ConformanceOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 180_000;
  const skip = options.skip ?? {};
  const signal = () => AbortSignal.timeout(timeout);
  const backend = await options.create(options.storage);
  const kinds = backend.kinds().filter((kind) => !options.kinds || options.kinds.includes(kind.id));
  const doctor = await backend.doctor(signal()).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  const blocked = doctor instanceof Error ? `doctor threw: ${doctor.message}` : doctor.ok ? false : `doctor found a failure: ${doctor.summary}`;
  /** Guests this run acquired and has not released. */
  const outstanding = new Map<string, Guest>();
  const others: Backend[] = [];

  const acquire = async (box: BoxIdentity, hooks: AcquireHooks) => {
    const guest = await backend.acquire(box, null, hooks, signal());
    outstanding.set(guest.ref, guest);
    return guest;
  };
  const release = async (target: Backend, guest: Guest) => {
    const recorded = releaseHooks();
    await target.release(guest, recorded.hooks, signal());
    outstanding.delete(guest.ref);
    checkTimings(recorded.timings);
    if (target.nature === "real") assert.deepEqual(recorded.events, ["resetting"], "a real backend records the reset before it starts");
  };
  /** A virtual guest is gone after release; a real one is back in the pool. Either way no box holds it. */
  const assertReleased = async (target: Backend, guest: Guest, generation: number | null = null) => {
    const held = await target.held(signal());
    assert.equal(held.find((other) => other.ref === guest.ref), undefined, `${guest.ref} is no longer held`);
    if (target.nature === "virtual") assert.equal(await target.power(guest, signal()), null, `${guest.ref} no longer exists`);
    const member = (await target.members?.(signal()))?.find((other) => other.ref === guest.ref);
    if (member) {
      assert.equal(member.state, "free", `${guest.ref} is free again`);
      if (generation !== null) assert.ok(member.generation > generation, `${guest.ref} was reset`);
    }
  };
  const generationOf = async (guest: Guest) => (await backend.members?.(signal()))?.find((other) => other.ref === guest.ref)?.generation ?? null;

  describe(`${options.name} conformance`, { timeout: timeout * 20 }, () => {
    after(async () => {
      for (const guest of outstanding.values()) await backend.release(guest, releaseHooks().hooks).catch(() => undefined);
      for (const other of others) await other.dispose?.();
      await backend.dispose?.();
    });

    it("doctor reports a working setup", () => {
      if (doctor instanceof Error) throw doctor;
      checkDoctor(doctor);
      assert.equal(doctor.ok, true, describeDoctor(doctor));
    });

    describe("with a working setup", { skip: blocked }, () => {
      it("describes its kinds", () => {
        assert.ok(["virtual", "real"].includes(backend.nature));
        assert.ok(backend.id && backend.label, "the backend has an ID and a label");
        if (backend.nature === "real") assert.ok(backend.restores === "home" || backend.restores === "machine", "a real backend says what a release restores");
        assert.ok(backend.kinds().length > 0, "the backend offers at least one kind");
        const ids = backend.kinds().map((kind) => kind.id);
        assert.equal(new Set(ids).size, ids.length, "kind IDs are unique");
        for (const kind of backend.kinds()) checkKind(kind);
      });

      it("reports capacity for each kind", { timeout }, async () => {
        for (const kind of kinds) {
          const capacity = await backend.capacity(kind.id, [], signal());
          checkCapacity(capacity, backend.nature);
          assert.ok(capacity.ok, `${kind.id}: ${capacity.message}`);
        }
      });

      it("lists its pool members", { timeout, skip: backend.members ? false : "the backend has no pool" }, async () => {
        const members = await backend.members!(signal());
        for (const member of members) {
          assert.ok(member.ref, "each member has a ref");
          assert.ok(["free", "held", "resetting", "out-of-service"].includes(member.state), `${member.ref} has a known state`);
          assert.equal(member.reason !== null, member.state === "out-of-service", `${member.ref} has a reason only when out of service`);
          assert.ok(Number.isInteger(member.generation) && member.generation >= 0, `${member.ref} has a generation`);
        }
      });

      it("refuses a kind it does not have", async () => {
        await assert.rejects(
          backend.acquire(identity("no-such-kind"), null, recordingHooks().hooks, signal()),
          (error: unknown) => error instanceof BackendError && error.code === "unsupported",
        );
      });

      for (const kind of kinds) {
        describe(kind.id, () => {
          const box = identity(kind.id);
          const capabilities = kind.capabilities;
          let guest: Guest | null = null;
          let generation: number | null = null;
          let command: CommandTransport | null = null;
          let enrolled = false;
          /** When the box answered again after the stop and start step. */
          let restartedAt: number | null = null;
          const posix = capabilities.os !== "windows";
          const scripts = posix ? false : "Windows scripts are not in the suite yet";
          const need = () => {
            assert.ok(guest && command, "the box was acquired");
            return { guest, command };
          };

          it("acquires a box, recording the guest before it changes anything", { timeout }, async () => {
            const recorded = recordingHooks();
            const started = Date.now();
            guest = await acquire(box, recorded.hooks);
            assert.ok(recorded.claimed.length >= 1, "claim ran");
            assert.equal(recorded.events[0], "claim", "claim ran first");
            assert.equal(recorded.events.filter((event) => event === "starting").length, 1, "starting ran once");
            assert.deepEqual(recorded.claimed.at(-1), guest, "the guest is the last one claimed");
            assert.ok(guest.host === null || guest.host.trim(), "the guest's host is a name or null");
            for (const fact of guest.facts ?? []) assert.ok(fact.label.trim() && typeof fact.value === "string", "a fact has a label and a value");
            for (const value of Object.values(guest.data ?? {})) assert.ok(["string", "number", "boolean"].includes(typeof value), "guest data is plain values");
            checkTimings(recorded.timings);
            const held = (await backend.held(signal())).find((other) => other.ref === guest!.ref);
            assert.ok(held, "held lists the new box");
            assert.equal(held.owner?.boxId, box.boxId, "held names the box that owns it");
            assert.equal(held.owner?.threadId, box.threadId);
            assert.equal(held.host, guest.host);
            assert.equal(await backend.power(guest, signal()), "running");
            const member = (await backend.members?.(signal()))?.find((other) => other.ref === guest!.ref);
            if (backend.members) assert.equal(member?.state, "held", "the pool shows the machine held");
            generation = await generationOf(guest);
            console.log(`# ${options.name} ${kind.id}: ready in ${Date.now() - started} ms ${JSON.stringify(recorded.timings)}`);
          });

          it("gives the transports the kind declares", { timeout }, async () => {
            assert.ok(guest, "the box was acquired");
            const transports = await backend.transports(guest, kind.id);
            assert.deepEqual(
              transports.displays.map((display) => [display.id, display.protocol, display.resizable]),
              capabilities.displays.map((display) => [display.id, display.protocol, display.resizable]),
              "the displays match the kind",
            );
            for (const display of transports.displays) assert.ok(display.label.trim(), `display ${display.id} has a label`);
            if (transports.access) {
              const ssh = transports.access.ssh;
              if (ssh) assert.ok(ssh.host && ssh.user && Number.isInteger(ssh.port), "SSH access names a host, port and user");
              assert.ok(transports.access.dockerHost === null || transports.access.dockerHost.trim(), "a Docker host is a URL or null");
            }
            if (!capabilities.command) {
              assert.equal(transports.command, null);
              return;
            }
            assert.ok(transports.command, "a kind with a command transport gets one");
            assert.equal(await transports.command.probe(signal()), true);
            command = transports.command;
          });

          it("spawns a command whose stdin and stdout are a channel", { timeout, skip: scripts }, async (t) => {
            const { command } = need();
            if (!command.spawn) {
              assert.equal(capabilities.computerUse, null, `${kind.id} offers computer use, so its command transport can spawn the driver`);
              return t.skip("the command transport cannot spawn");
            }
            const channel = await command.spawn("cat", signal());
            try {
              const writer = channel.writable.getWriter();
              await writer.write(new TextEncoder().encode("ping\n"));
              assert.equal(await greeting(channel, 5, 10_000), "ping\n");
              await writer.close();
            } finally {
              await channel.close();
            }
          });

          it("runs a command with stdin, exit codes and a timeout", { timeout, skip: scripts }, async () => {
            const { command } = need();
            const echoed = await command.run("cat; echo; echo to-stderr >&2; exit 3", { stdin: "hello from stdin", timeoutMs: 30_000 });
            assert.equal(echoed.exitCode, 3);
            assert.equal(echoed.stdout, "hello from stdin\n");
            assert.equal(echoed.stderr, "to-stderr\n");
            assert.equal(echoed.timedOut, false);
            const input = randomBytes(MiB);
            const digest = await command.run(SHA256, { stdin: input, timeoutMs: 60_000 });
            assert.equal(digest.exitCode, 0, digest.stderr);
            assert.equal(digest.stdout.trim(), sha256(input), "1 MiB of stdin arrives intact");
            const uname = await command.run("uname -s", { timeoutMs: 30_000 });
            assert.equal(uname.exitCode, 0);
            assert.equal(uname.stdout.trim(), capabilities.os === "macos" ? "Darwin" : "Linux");
            const slow = await command.run("sleep 30", { timeoutMs: 500 });
            assert.equal(slow.timedOut, true);
            assert.ok(slow.durationMs < 10_000);
          });

          it("runs on the architecture it declares", { timeout, skip: skip.arch ?? scripts }, async () => {
            const { command } = need();
            const machine = (await command.run("uname -m", { timeoutMs: 30_000 })).stdout.trim();
            assert.equal(machine === "aarch64" ? "arm64" : machine === "amd64" ? "x86_64" : machine, capabilities.arch);
          });

          it("streams output as it arrives", { timeout, skip: scripts }, async () => {
            const { command } = need();
            const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
            const text = { stdout: "", stderr: "" };
            const started = Date.now();
            let first: number | null = null;
            const result = await command.stream("echo early; sleep 1; echo late >&2; exit 4", {
              onOutput: (chunk, from) => {
                assert.ok(chunk instanceof Uint8Array, "output arrives as bytes");
                first ??= Date.now() - started;
                text[from] += decoders[from].decode(chunk, { stream: true });
              },
              timeoutMs: 30_000,
            });
            assert.equal(result.exitCode, 4);
            assert.equal(text.stdout, "early\n");
            assert.equal(text.stderr, "late\n");
            if (capabilities.command?.streaming) assert.ok(first !== null && first < Date.now() - started - 500, "output arrived before the command ended");
          });

          it("copies 32 MiB in and out byte for byte", { timeout, skip: scripts }, async () => {
            const { command } = need();
            const data = randomBytes(32 * MiB);
            data[0] = 0;
            data[1] = 255;
            const path = `bb-box-conformance/dir with space/it's ${box.name}.bin`;
            await command.writeFile(path, data, { mode: "0600", signal: signal() });
            const inBox = await command.run(`cd "$HOME" && cat -- ${quote(path)} | ${SHA256}`, { timeoutMs: 60_000 });
            assert.equal(inBox.stdout.trim(), sha256(data), "the file in the box matches");
            const out = await command.run(`cd "$HOME" && head -c ${32 * MiB} /dev/urandom > bb-box-conformance/out.bin && cat bb-box-conformance/out.bin | ${SHA256}`, { timeoutMs: 60_000 });
            assert.equal(out.exitCode, 0, out.stderr);
            const read = await command.readFile("bb-box-conformance/out.bin", { maxBytes: 32 * MiB, signal: signal() });
            assert.equal(read.length, 32 * MiB);
            assert.equal(sha256(read), out.stdout.trim(), "the file read out matches");
            await assert.rejects(command.readFile(path, { maxBytes: 10 }), /larger than 10 bytes/);
            const mode = await command.run(`cd "$HOME" && (stat -c %a ${quote(path)} 2>/dev/null || stat -f %Lp ${quote(path)})`);
            assert.equal(mode.stdout.trim(), "600");
            await command.run('cd "$HOME" && rm -rf bb-box-conformance');
          });

          if (capabilities.enrol) {
            it("has what enrolment needs", { timeout, skip: skip.enrol ?? scripts }, async () => {
              const { command } = need();
              const result = await command.run(
                "command -v sh && command -v tar && (command -v curl || command -v wget) && mkdir -p .cache && test -w .cache",
                { timeoutMs: 30_000 },
              );
              assert.equal(result.exitCode, 0, `the box needs sh, tar, curl or wget and a writable home: ${result.stderr}`);
            });

            it("enrols in BB", { timeout, skip: skip.enrol ?? (options.bb ? false : "needs a live BB server") }, async () => {
              const { command } = need();
              await options.bb!.enrol(box, command, signal());
              await until(() => options.bb!.connected(box, signal()), timeout, "the box connects to BB");
              enrolled = true;
            });
          }

          if (capabilities.features.includes("docker")) {
            it("runs Docker", { timeout, skip: skip.docker ?? false }, async () => {
              const { command } = need();
              const result = await command.run("docker version --format '{{.Server.Version}}'", { timeoutMs: 60_000 });
              assert.equal(result.exitCode, 0, `docker: ${result.stderr}`);
              assert.match(result.stdout.trim(), /^\d+\./);
            });
          }

          for (const capability of capabilities.displays) {
            const unsupported = capability.protocol === "rfb" ? false : `the suite cannot check ${capability.protocol} yet`;
            it(`serves the ${capability.id} display`, { timeout, skip: skip.display ?? unsupported }, async () => {
              assert.ok(guest, "the box was acquired");
              const display = (await backend.transports(guest, kind.id)).displays.find((other) => other.id === capability.id);
              assert.ok(display, `the box has the ${capability.id} display`);
              const { route, auth } = await display.open(signal());
              assert.ok(["none", "vnc-password"].includes(auth.type), "the display's auth is known");
              const channel = await openRoute(route, signal());
              try {
                assert.match(await greeting(channel, 12, 10_000), /^RFB \d{3}\.\d{3}\n$/);
              } finally {
                await channel.close();
              }
            });
          }

          if (capabilities.computerUse) {
            it("offers computer use", { skip: "bb-box does not offer computer use yet" }, () => {});
          }

          const stopStart = skip["stop-start"] ?? (backend.start && backend.stop ? false : "the backend cannot stop and start its boxes");
          it("stops and starts", { timeout, skip: stopStart }, async () => {
            const { guest } = need();
            await backend.stop!(guest, signal());
            assert.equal(await backend.power(guest, signal()), "stopped");
            await backend.start!(guest, signal());
            assert.equal(await backend.power(guest, signal()), "running");
            const { command } = await backend.transports(guest, kind.id);
            if (command) assert.equal(await command.probe(signal()), true);
            restartedAt = Date.now();
          });

          it("reconnects to BB within 3 s of being ready after a stop and start", { timeout, skip: stopStart || (options.bb && capabilities.enrol ? false : "needs a live BB server") }, async (t) => {
            if (!enrolled) return t.skip("the box did not enrol");
            if (restartedAt === null) return t.skip("the box did not stop and start");
            const { command } = need();
            // bb-box starts BB's daemon again with the same key after a start.
            await options.bb!.enrol(box, command, signal());
            await until(() => options.bb!.connected(box, signal()), Math.max(0, restartedAt + RECONNECT_MS - Date.now()), "the box reconnects to BB", 100);
          });

          it("a new instance finds the box after a restart and releases it", { timeout, skip: skip.recovery ?? false }, async () => {
            const { guest } = need();
            const restarted = await options.create(options.storage);
            others.push(restarted);
            const held = (await restarted.held(signal())).find((other) => other.ref === guest.ref);
            assert.ok(held, "the new instance holds the guest");
            assert.equal(held.owner?.boxId, box.boxId);
            await release(restarted, guest);
            await assertReleased(restarted, guest, generation);
            await assertReleased(backend, guest, generation);
          });

          it("releases the box, and releasing again is fine", { timeout }, async () => {
            const { guest } = need();
            if (outstanding.has(guest.ref)) await release(backend, guest);
            await assertReleased(backend, guest, generation);
            await backend.release(guest, releaseHooks().hooks, signal());
            await assertReleased(backend, guest, generation);
          });
        });
      }

      describe("interrupted acquires", { skip: skip.interrupted ?? (kinds.length ? false : "no kinds to check") }, () => {
        const kind = kinds[0]?.id ?? "";
        for (const at of ["claim", "starting"] as const) {
          it(`leave nothing behind when cancelled at ${at}`, { timeout }, async () => {
            const controller = new AbortController();
            const recorded = recordingHooks();
            const hooks: AcquireHooks = {
              ...recorded.hooks,
              claim: async (guest) => {
                await recorded.hooks.claim(guest);
                if (at === "claim") controller.abort(new Error("cancelled by the suite"));
              },
              starting: async () => {
                await recorded.hooks.starting();
                if (at === "starting") controller.abort(new Error("cancelled by the suite"));
              },
            };
            await assert.rejects(backend.acquire(identity(kind), null, hooks, controller.signal));
            assert.ok(recorded.claimed.length > 0);
            for (const guest of recorded.claimed) await assertReleased(backend, guest);
          });
        }
      });
    });
  });
}
