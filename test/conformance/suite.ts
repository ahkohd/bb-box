// The backend conformance suite: one set of checks every backend passes,
// whatever the provider. It runs against the fake backend and the Proxmox
// LXC backend on fakes in `npm test`, and against a live backend with
// `npm run conformance -- --backend <type> --env-file <file>`.
//
// A check a run cannot do (Docker in a fake box, a desktop stream the test
// machine cannot reach) is skipped with its reason, never passed silently.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type Guest,
} from "../../src/backends/types.ts";
import type { CommandTransport, DisplayEndpoint } from "../../src/transports/types.ts";

export type ConformanceCheck = "doctor" | "docker" | "display" | "enrol" | "stop-start" | "recovery" | "interrupted";

export interface ConformanceOptions {
  readonly name: string;
  /** Makes the backend. Called again on the same storage to check recovery after a restart. */
  readonly create: (storage: BackendStorage) => Backend | Promise<Backend>;
  readonly storage: BackendStorage;
  /** Kinds to check. All the backend's kinds by default. */
  readonly kinds?: readonly string[];
  /** Checks this run cannot do, with the reason. */
  readonly skip?: Partial<Record<ConformanceCheck, string>>;
  /** Enrols a box as a BB machine. Without it, only what enrolment needs in the box is checked. */
  readonly enrol?: (box: BoxIdentity, command: CommandTransport) => Promise<void>;
  /** For each step that talks to the backend. */
  readonly timeoutMs?: number;
}

const THREAD = "thr_conformance";

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

/** The first bytes a display server sends, within `timeoutMs`. */
function greeting(endpoint: DisplayEndpoint, bytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint.port, endpoint.host);
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`No greeting from ${endpoint.host}:${endpoint.port} within ${timeoutMs} ms.`));
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(data.subarray(0, bytes).toString("latin1"));
    };
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (data.length >= bytes) done();
    });
    socket.on("end", done);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function checkKind(kind: BoxKind): void {
  assert.match(kind.id, /^[a-z0-9][a-z0-9-]*$/, "kind IDs are lowercase words joined by hyphens");
  assert.ok(kind.label.trim(), `${kind.id} has a label`);
  assert.ok(kind.description.trim(), `${kind.id} has a description`);
  assert.ok(kind.size.trim(), `${kind.id} says its size`);
  const capabilities = kind.capabilities;
  assert.ok(["linux", "windows", "macos"].includes(capabilities.os), `${kind.id} has a known OS`);
  for (const flag of ["desktop", "gpu", "docker", "enrol"] as const) assert.equal(typeof capabilities[flag], "boolean", `${kind.id}.${flag}`);
  assert.ok(capabilities.command === null || (typeof capabilities.command === "string" && capabilities.command.length > 0), `${kind.id}.command`);
  assert.ok(capabilities.display === null || ["vnc", "rdp", "webrtc"].includes(capabilities.display), `${kind.id}.display`);
  if (capabilities.display) assert.equal(capabilities.desktop, true, `${kind.id} streams a display, so it is a desktop`);
  if (capabilities.enrol || capabilities.docker) assert.ok(capabilities.command, `${kind.id} needs a command transport to enrol or run Docker`);
}

export async function conformance(options: ConformanceOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 180_000;
  const skip = options.skip ?? {};
  const backend = await options.create(options.storage);
  const kinds = backend.kinds().filter((kind) => !options.kinds || options.kinds.includes(kind.id));
  /** Guests this run acquired and has not released. */
  const outstanding = new Map<string, Guest>();
  const others: Backend[] = [];

  const acquire = async (box: BoxIdentity, hooks: AcquireHooks, signal = AbortSignal.timeout(timeout)) => {
    const guest = await backend.acquire(box, null, hooks, signal);
    outstanding.set(guest.ref, guest);
    return guest;
  };
  const release = async (target: Backend, guest: Guest) => {
    await target.release(guest, AbortSignal.timeout(timeout));
    outstanding.delete(guest.ref);
  };
  /** A virtual guest is gone after release; a real one is back in the pool. Either way no box holds it. */
  const assertReleased = async (target: Backend, guest: Guest) => {
    const held = await target.held(AbortSignal.timeout(timeout));
    assert.equal(held.find((other) => other.ref === guest.ref), undefined, `${guest.ref} is no longer held`);
    if (target.nature === "virtual") assert.equal(await target.power(guest, AbortSignal.timeout(timeout)), null, `${guest.ref} no longer exists`);
  };

  describe(`${options.name} conformance`, { timeout: timeout * 20 }, () => {
    after(async () => {
      for (const guest of outstanding.values()) await backend.release(guest).catch(() => undefined);
      for (const other of others) await other.dispose?.();
      await backend.dispose?.();
    });

    it("describes its kinds", () => {
      assert.ok(["virtual", "real"].includes(backend.nature));
      assert.ok(backend.id && backend.label, "the backend has an ID and a label");
      assert.ok(backend.kinds().length > 0, "the backend offers at least one kind");
      const ids = backend.kinds().map((kind) => kind.id);
      assert.equal(new Set(ids).size, ids.length, "kind IDs are unique");
      for (const kind of backend.kinds()) checkKind(kind);
    });

    it("doctor reports a working setup", { timeout, skip: skip.doctor }, async () => {
      const report = await backend.doctor(AbortSignal.timeout(timeout));
      assert.ok(report.checks.length > 0);
      for (const check of report.checks) {
        assert.ok(check.name && check.detail, "each check has a name and a detail");
        assert.ok(check.ok !== false || check.fix, `${check.name} failed and says how to fix it`);
      }
      assert.equal(report.ok, report.checks.every((check) => check.ok !== false), "ok agrees with the checks");
      assert.equal(report.ok, true, `doctor: ${report.summary}\n${report.checks.map((check) => `${check.name}: ${check.detail} ${check.fix ?? ""}`).join("\n")}`);
      assert.ok(report.summary.trim());
    });

    it("reports capacity for each kind", { timeout }, async () => {
      for (const kind of kinds) {
        const capacity = await backend.capacity(kind.id, [], AbortSignal.timeout(timeout));
        assert.equal(capacity.nature, backend.nature);
        assert.equal(typeof capacity.ok, "boolean");
        assert.equal(capacity.ok, capacity.message === null, "a message explains a refusal, and only a refusal");
        assert.ok(capacity.ok, `${kind.id}: ${capacity.message}`);
        if (capacity.nature === "virtual") {
          for (const value of [capacity.memory.freeMiB, capacity.memory.reserveMiB, capacity.disk.freeGiB, capacity.disk.reserveGiB, capacity.warm]) {
            assert.ok(Number.isFinite(value));
          }
        } else {
          assert.ok(capacity.free >= 1 && capacity.free <= capacity.total);
        }
      }
    });

    it("refuses a kind it does not have", async () => {
      await assert.rejects(
        backend.acquire(identity("no-such-kind"), null, recordingHooks().hooks, AbortSignal.timeout(timeout)),
        (error: unknown) => error instanceof BackendError && error.code === "unsupported",
      );
    });

    for (const kind of kinds) {
      describe(kind.id, () => {
        const box = identity(kind.id);
        let guest: Guest | null = null;
        let command: CommandTransport | null = null;
        const posix = kind.capabilities.os !== "windows";
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
          for (const [step, ms] of Object.entries(recorded.timings)) assert.ok(Number.isFinite(ms) && ms >= 0, `timing ${step}`);
          const held = (await backend.held(AbortSignal.timeout(timeout))).find((other) => other.ref === guest!.ref);
          assert.ok(held, "held lists the new box");
          assert.equal(held.owner?.boxId, box.boxId, "held names the box that owns it");
          assert.equal(held.owner?.threadId, box.threadId);
          assert.equal(await backend.power(guest, AbortSignal.timeout(timeout)), "running");
          console.log(`# ${options.name} ${kind.id}: ready in ${Date.now() - started} ms ${JSON.stringify(recorded.timings)}`);
        });

        it("the command transport answers", { timeout }, async () => {
          assert.ok(guest, "the box was acquired");
          const transports = await backend.transports(guest, kind.id);
          if (!kind.capabilities.command) {
            assert.equal(transports.command, null);
            return;
          }
          assert.ok(transports.command, "a kind with a command transport gets one");
          assert.equal(transports.command.kind, kind.capabilities.command);
          assert.equal(await transports.command.probe(AbortSignal.timeout(timeout)), true);
          command = transports.command;
        });

        it("runs a command with stdin, exit codes and a timeout", { timeout, skip: posix ? false : "Windows scripts are not in the suite yet" }, async () => {
          const { command } = need();
          const echoed = await command.run("cat; echo; echo to-stderr >&2; exit 3", { stdin: "hello from stdin", timeoutMs: 30_000 });
          assert.equal(echoed.exitCode, 3);
          assert.equal(echoed.stdout, "hello from stdin\n");
          assert.equal(echoed.stderr, "to-stderr\n");
          assert.equal(echoed.timedOut, false);
          const uname = await command.run("uname -s", { timeoutMs: 30_000 });
          assert.equal(uname.exitCode, 0);
          assert.equal(uname.stdout.trim(), kind.capabilities.os === "macos" ? "Darwin" : "Linux");
          const slow = await command.run("sleep 30", { timeoutMs: 500 });
          assert.equal(slow.timedOut, true);
          assert.ok(slow.durationMs < 10_000);
        });

        it("streams output as it arrives", { timeout, skip: posix ? false : "Windows scripts are not in the suite yet" }, async () => {
          const { command } = need();
          const chunks: string[] = [];
          const result = await command.stream("echo one; echo two >&2; exit 4", { onOutput: (chunk) => chunks.push(chunk), timeoutMs: 30_000 });
          assert.equal(result.exitCode, 4);
          assert.match(chunks.join(""), /one/);
          assert.match(chunks.join(""), /two/);
        });

        it("copies files in and out byte for byte", { timeout, skip: posix ? false : "Windows scripts are not in the suite yet" }, async () => {
          const { command } = need();
          const data = randomBytes(256 * 1024);
          data[0] = 0;
          data[1] = 255;
          const path = `bb-box-conformance/dir with space/it's ${box.name}.bin`;
          await command.writeFile(path, data, { mode: "0600" });
          assert.deepEqual(Buffer.from(await command.readFile(path, { maxBytes: data.length })), data);
          await assert.rejects(command.readFile(path, { maxBytes: 10 }), /larger than 10 bytes/);
          const mode = await command.run(`stat -c %a "$HOME"/${JSON.stringify(path)} 2>/dev/null || stat -f %Lp "$HOME"/${JSON.stringify(path)}`);
          assert.equal(mode.stdout.trim(), "600");
          await command.run("rm -rf bb-box-conformance");
        });

        if (kind.capabilities.enrol) {
          it("has what enrolment needs", { timeout, skip: skip.enrol ?? (posix ? false : "Windows enrolment is not in the suite yet") }, async () => {
            const { command } = need();
            const result = await command.run(
              "command -v sh && command -v tar && (command -v curl || command -v wget) && mkdir -p .cache && test -w .cache",
              { timeoutMs: 30_000 },
            );
            assert.equal(result.exitCode, 0, `the box needs sh, tar, curl or wget and a writable home: ${result.stderr}`);
          });

          it("enrols in BB", { timeout, skip: skip.enrol ?? (options.enrol ? false : "needs a live BB server") }, async () => {
            const { command } = need();
            await options.enrol!(box, command);
          });
        }

        if (kind.capabilities.docker) {
          it("runs Docker", { timeout, skip: skip.docker ?? false }, async () => {
            const { command } = need();
            const result = await command.run("docker version --format '{{.Server.Version}}'", { timeoutMs: 60_000 });
            assert.equal(result.exitCode, 0, `docker: ${result.stderr}`);
            assert.match(result.stdout.trim(), /^\d+\./);
          });
        }

        if (kind.capabilities.display) {
          const protocol = kind.capabilities.display;
          it("serves the desktop stream", { timeout, skip: skip.display ?? (protocol === "vnc" ? false : `the suite cannot check ${protocol} yet`) }, async () => {
            assert.ok(guest, "the box was acquired");
            const { display } = await backend.transports(guest, kind.id);
            assert.ok(display, "a desktop kind has a display endpoint");
            assert.equal(display.protocol, protocol);
            assert.match(await greeting(display, 12, 10_000), /^RFB \d{3}\.\d{3}\n$/);
          });
        }

        if (kind.capabilities.desktop) {
          it("offers computer use", { skip: "bb-box does not offer computer use yet" }, () => {});
        }

        it("stops and starts", { timeout, skip: skip["stop-start"] ?? false }, async (t) => {
          const { guest } = need();
          try {
            await backend.stop(guest, AbortSignal.timeout(timeout));
          } catch (error) {
            if (error instanceof BackendError && error.code === "unsupported") return t.skip(error.message);
            throw error;
          }
          assert.equal(await backend.power(guest, AbortSignal.timeout(timeout)), "stopped");
          await backend.start(guest, AbortSignal.timeout(timeout));
          assert.equal(await backend.power(guest, AbortSignal.timeout(timeout)), "running");
          const { command } = await backend.transports(guest, kind.id);
          if (command) assert.equal(await command.probe(AbortSignal.timeout(timeout)), true);
        });

        it("a new instance finds the box after a restart and releases it", { timeout, skip: skip.recovery ?? false }, async () => {
          const { guest } = need();
          const restarted = await options.create(options.storage);
          others.push(restarted);
          const held = (await restarted.held(AbortSignal.timeout(timeout))).find((other) => other.ref === guest.ref);
          assert.ok(held, "the new instance holds the guest");
          assert.equal(held.owner?.boxId, box.boxId);
          await release(restarted, guest);
          await assertReleased(restarted, guest);
          await assertReleased(backend, guest);
        });

        it("releases the box, and releasing again is fine", { timeout }, async () => {
          const { guest } = need();
          await release(backend, guest);
          await assertReleased(backend, guest);
          await backend.release(guest, AbortSignal.timeout(timeout));
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
}
