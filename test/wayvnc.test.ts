import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { wayvncAttached } from "../src/backends/wayvnc.ts";
import type { CommandTransport, RunResult } from "../src/transports/types.ts";

/** A box whose wayvncctl answers each output-list with the next of `answers`, as exit code and output. */
function box(...answers: [number, string][]): { command: CommandTransport; asked: () => number } {
  let asked = 0;
  const command = {
    run: async (script: string): Promise<RunResult> => {
      assert.match(script, /wayvncctl --json output-list/);
      const [exitCode, stdout] = answers[Math.min(asked++, answers.length - 1)]!;
      return { exitCode, stdout, stderr: "", truncated: false } as RunResult;
    },
  } as unknown as CommandTransport;
  return { command, asked: () => asked };
}

const OUTPUT = '[{"name":"HEADLESS-1","description":"Headless output 1","height":1080,"width":1920,"captured":true,"power":"UNKNOWN"}]';

test("wayvnc has lost Sway only when it lists no output twice, 2 s apart; an output, or no answer, says it has it (wayvnc 0.9.1)", async () => {
  const attached = box([0, OUTPUT]);
  assert.equal(await wayvncAttached(attached.command), true);
  assert.equal(attached.asked(), 1, "one look when it lists its output");

  // wayvnc 0.9.1 after it lost Sway, as `wayvncctl detach` leaves it.
  const lost = box([0, "[]\n"], [0, "[]\n"]);
  const began = Date.now();
  assert.equal(await wayvncAttached(lost.command), false);
  assert.ok(Date.now() - began >= 1_900, "asked again 2 s later");
  assert.equal(lost.asked(), 2);

  // A moment with none, as while a display resize starts it again.
  assert.equal(await wayvncAttached(box([0, "[]"], [0, OUTPUT]).command), true);
  // wayvncctl that does not answer, as when no wayvnc runs, says nothing either way.
  assert.equal(await wayvncAttached(box([1, ""]).command), true);
  assert.equal(await wayvncAttached(box([0, "[]"], [1, ""]).command), true);
});
