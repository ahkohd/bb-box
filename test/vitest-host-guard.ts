import { afterAll } from "vitest";
import { installHostGuard, reachedTestMachineMessage } from "./host-guard.ts";
import { refusalForThisMachine } from "./preflight.mjs";

const refusal = refusalForThisMachine();
if (refusal !== null) throw new Error(refusal);

const hostGuard = installHostGuard();

afterAll(() => {
  const reached = hostGuard.reached();
  if (reached.length) throw new Error(reachedTestMachineMessage(reached));
});
