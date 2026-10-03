// The macOS desktop's input helper (#406): the keys it maps, its script's
// quoting, and its line protocol, over a channel a test plays the helper on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAC_INPUT_SCRIPT, MacInput, macInputCommand, macKeyCode } from "../src/core/mac-input.ts";
import type { ByteChannel } from "../src/transports/types.ts";

test("keys map to the key that types them on a US keyboard, and a key it lacks maps to none", () => {
  const code = (key: string | number) => macKeyCode(typeof key === "number" ? key : key.codePointAt(0)!);
  assert.deepEqual(["a", "A", "z", "1", "!", "0", ")", " ", "/", "?", "`", "~", "'", '"'].map(code), [0, 0, 6, 18, 18, 29, 29, 49, 44, 44, 50, 50, 39, 39]);
  // Return, Tab, BackSpace, Escape, the arrows, F1 and F12.
  assert.deepEqual([0xff0d, 0xff09, 0xff08, 0xff1b, 0xff51, 0xff52, 0xff53, 0xff54, 0xffbe, 0xffc9].map(code), [36, 48, 51, 53, 123, 126, 124, 125, 122, 111]);
  // Shift, Control, Option, and Command from Meta, as noVNC sends it on a Mac, or Super, as on Windows and Linux.
  assert.deepEqual([0xffe1, 0xffe3, 0xffe9, 0xffe7, 0xffeb, 0xffec].map(code), [56, 59, 58, 55, 55, 54]);
  assert.equal(code(0x1000041), 0, "a Unicode keysym of a key it has");
  assert.equal(code(0xe9), null, "é has no key of its own on a US keyboard");
  assert.equal(code(0x10020ac), null, "nor €");
});

test("the helper's script goes in single quotes as it is", () => {
  assert.ok(!MAC_INPUT_SCRIPT.includes("'"));
  assert.ok(macInputCommand().startsWith("exec /usr/bin/osascript -l JavaScript -e '"));
});

/** A channel whose far end the test plays: it reads the lines MacInput sends, and answers on its stdout. */
function helper() {
  const lines: string[] = [];
  let answer!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const decoder = new TextDecoder();
  let rest = "";
  const channel: ByteChannel = {
    readable: new ReadableStream({ start: (controller) => void (answer = controller) }),
    writable: new WritableStream({
      write(chunk) {
        rest += decoder.decode(chunk, { stream: true });
        const parts = rest.split("\n");
        rest = parts.pop()!;
        for (const line of parts) {
          lines.push(line);
          // It answers each ping once the lines before it are posted.
          if (line.startsWith("t ")) answer.enqueue(new TextEncoder().encode(`${line}\n`));
        }
      },
    }),
    close: async () => {
      closed = true;
      try {
        answer.close();
      } catch {
        // Closed already.
      }
    },
  };
  return { channel, lines, say: (line: string) => answer.enqueue(new TextEncoder().encode(`${line}\n`)), closed: () => closed };
}

test("the input sends one line per event, in order, and hears the box's clipboard and the helper's errors", async () => {
  const far = helper();
  const clipboards: string[] = [];
  const errors: string[] = [];
  const input = new MacInput(far.channel, { onClipboard: (text) => clipboards.push(text), onError: (message) => errors.push(message) });
  far.say("ready");
  await input.ready;
  await input.size(2048, 1536);
  assert.equal(await input.key(true, 0xffeb), true);
  assert.equal(await input.key(true, "c".codePointAt(0)!), true);
  assert.equal(await input.key(true, 0xe9), false, "a key it lacks sends nothing");
  await input.pointer(1, 100, 200);
  await input.clipboard("héllo, wörld");
  await input.ping();
  assert.deepEqual(far.lines, ["s 2048 1536", "k 1 55", "k 1 8", "p 1 100 200", `c ${Buffer.from("héllo, wörld").toString("base64")}`, "t 1"]);

  far.say(`C ${Buffer.from("copied in the box ✓").toString("base64")}`);
  far.say("e Error: no such event");
  await until(() => clipboards.length === 1 && errors.length === 1);
  assert.deepEqual(clipboards, ["copied in the box ✓"]);
  assert.deepEqual(errors, ["Error: no such event"]);

  await input.close();
  assert.equal(far.lines.at(-1), "t 2", "closing waits for what was sent to be posted");
  assert.ok(far.closed());
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out");
}
