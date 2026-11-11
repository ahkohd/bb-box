import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Guest, TaskRef } from "../../src/backends/types.ts";
import type { InterruptedStep, InterruptedStepInput, StepEvent } from "./interrupted-step.ts";

const STEP_SCRIPT = fileURLToPath(new URL("./interrupted-step.ts", import.meta.url));

export interface ElsewhereBackend {
  readonly module: string;
  readonly args: readonly string[];
}

export interface StepSeen {
  readonly task: TaskRef | null;
  readonly claimed: Guest | null;
  readonly finished: boolean;
}

export async function interruptStep(
  elsewhere: ElsewhereBackend,
  storage: string,
  installId: string,
  run: InterruptedStep,
  killNow: (seen: StepSeen) => Promise<boolean>,
  timeoutMs: number,
): Promise<StepSeen> {
  const input: InterruptedStepInput = { module: elsewhere.module, args: elsewhere.args, storage, installId, run };
  const child = spawn(process.execPath, [STEP_SCRIPT, JSON.stringify(input)], { stdio: ["ignore", "pipe", "pipe"] });
  const errors: string[] = [];
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => errors.push(chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));

  let seen: StepSeen = { task: null, claimed: null, finished: false };
  createInterface({ input: child.stdout }).on("line", (line) => {
    const event = JSON.parse(line) as StepEvent;
    if ("task" in event) seen = { ...seen, task: event.task };
    if ("claimed" in event) seen = { ...seen, claimed: event.claimed };
    if ("done" in event) seen = { ...seen, finished: true };
  });

  const deadline = Date.now() + timeoutMs;
  let code: number | null | undefined;
  while ((code = await Promise.race([exited, new Promise<undefined>((resolve) => setTimeout(resolve, 100))])) === undefined) {
    if (seen.finished) break;
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`The step did not reach the point to stop it within ${timeoutMs} ms.`);
    }
    if (await killNow(seen)) {
      child.kill("SIGKILL");
      await exited;
      return seen;
    }
  }
  if (!seen.finished) throw new Error(`The step's process exited with ${code ?? "a signal"} before it could be stopped: ${errors.join("").trim()}`);
  child.kill("SIGKILL");
  await exited;
  return seen;
}
