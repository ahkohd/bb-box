// The access holder in bb-box's host entry (src/host/entry.ts), which BB's
// daemon runs in a worker on each box that is a BB machine. BB gives GH_TOKEN, the git identity and the machine
// variables only to processes its daemon starts, and its other workers come
// and go (a plugin reload stops them, and nothing starts them again). For
// each call, BB's worker puts the daemon's current variables in
// process.env, so "access" keeps a `sleep` started with them, below the
// daemon, where the env file's loader finds them. It starts a new one only
// when the values of the names bb-box asks for change, and holds a worker
// lease so BB's idle timer leaves the worker, and with it the sleep, alone.
// The sleep ends with the worker.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";

/** What the held process runs: it only waits, about 68 years. */
export const HOLDER_COMMAND = ["sleep", "2147483647"] as const;

/** The values of `names` in `env`, as a hash, so no value is kept apart from the process. */
function fingerprint(names: readonly string[], env: NodeJS.ProcessEnv): string {
  const values = [...new Set(names)].sort().map((name) => [name, env[name] ?? null]);
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

export function accessHandlers(options: { command?: readonly string[] } = {}) {
  const [program, ...args] = options.command ?? HOLDER_COMMAND;
  let held: { child: ChildProcess; fingerprint: string } | null = null;
  let lease: ExperimentalHostWorkerLease | null = null;
  const stop = () => {
    held?.child.kill("SIGTERM");
    held = null;
  };
  return {
    handlers: {
      access: async ({ names }: { names: readonly string[] }, context: ExperimentalHostRpcContext) => {
        if (!lease) {
          lease = context.experimental_retainWorker();
          context.lifecycle.signal.addEventListener("abort", stop, { once: true });
        }
        const now = fingerprint(names, process.env);
        if (held && running(held.child) && held.fingerprint === now) return { started: false, pid: held.child.pid ?? null };
        const old = held;
        const child = spawn(program!, args, { env: { ...process.env }, stdio: "ignore" });
        // A program that cannot start must not take the worker down with it.
        child.on("error", () => {});
        held = { child, fingerprint: now };
        // The new one runs first, so commands always have one.
        old?.child.kill("SIGTERM");
        return { started: true, pid: child.pid ?? null };
      },
    },
    async dispose() {
      stop();
      await lease?.dispose();
      lease = null;
    },
  };
}
