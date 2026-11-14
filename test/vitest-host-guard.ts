import "./check-test-machine.mjs";
import { afterAll } from "vitest";
import { installHostGuard, reachedTestMachineMessage } from "./host-guard.ts";

const hostGuard = installHostGuard();

afterAll(() => {
  const reached = hostGuard.reached();
  if (reached.length) throw new Error(reachedTestMachineMessage(reached));
});
