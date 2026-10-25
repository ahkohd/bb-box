// The macOS desktop's input helper (#406): the keys it maps, its script's
// quoting, and its line protocol, over a channel a test plays the helper on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MAC_INPUT_SCRIPT, MacInput, macCharacter, macInputCommand, macKeyCode, tartTypesAsCharacter } from "../src/core/mac-input.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { runJxa, type PostedKey } from "./jxa.ts";

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

test("the helper's script, with JXA's integers as strings, ends at the end of its input", () => {
  assert.deepEqual(runJxa(MAC_INPUT_SCRIPT, { chunks: ["t 7\n"] }), ["ready", "t 7"]);
});

test("the helper's script types a character above U+FFFF, as an emoji or a flag's half, with both of its UTF-16 units", () => {
  const posted: PostedKey[] = [];
  const typed = (codePoint: number) => [`u 1 ${codePoint}\n`, `u 0 ${codePoint}\n`];
  const out = runJxa(MAC_INPUT_SCRIPT, { chunks: [...typed(0x1f600), ...typed(0x1f1f2), ...typed(0x1f1fa), ...typed(0xe9), ...typed(0x41)], posted });
  assert.deepEqual(out, ["ready", ...Array<string>(10).fill("u")]);
  const units = (text: string) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
  assert.deepEqual(
    posted.map((key) => key.units),
    [units("😀"), units("😀"), units("🇲"), units("🇲"), units("🇺"), units("🇺"), units("é"), units("é"), units("A"), units("A")],
  );
  assert.deepEqual(posted.map((key) => key.down), [true, false, true, false, true, false, true, false, true, false]);
});

test("the helper's script reports a copy in the box at the next q, once, and not the viewer's own text", () => {
  const pasteboard = { changeCount: 3, text: "old" };
  const out = runJxa(MAC_INPUT_SCRIPT, {
    pasteboard,
    chunks: [
      "q\n",
      () => {
        pasteboard.changeCount = 4;
        pasteboard.text = "copied ✓";
        return "q\nq\n";
      },
      `c ${Buffer.from("pasted").toString("base64")}\nq\n`,
    ],
  });
  assert.deepEqual(out, ["ready", `C ${Buffer.from("copied ✓").toString("base64")}`]);
  assert.equal(pasteboard.text, "pasted");
});

/** A channel whose far end the test plays: it reads the lines MacInput sends, and answers on its stdout; a character at once unless `holding`. */
function helper(holding = false) {
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
          // It answers each ping once the lines before it are posted, and each character once it is.
          if (line.startsWith("t ")) answer.enqueue(new TextEncoder().encode(`${line}\n`));
          if (line.startsWith("u ") && !holding) answer.enqueue(new TextEncoder().encode("u\n"));
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

test("a character goes as itself when a US keyboard has no key for it, or its key needs another Shift, never during a shortcut (the desktop sweep)", () => {
  const typed = (key: string | number, shift = false, shortcut = false) => macCharacter(typeof key === "number" ? key : key.codePointAt(0)!, shift, shortcut);
  assert.deepEqual([typed("é"), typed(0x10020ac), typed(0x1000436)], [0xe9, 0x20ac, 0x436], "é, € and ж, which it has no key for");
  assert.deepEqual([typed("!"), typed("Z")], [0x21, 0x5a], "! and Z with no Shift held, as from a French keyboard or with Caps Lock");
  assert.equal(typed("1", true), 0x31, "1 with Shift held, as from a French keyboard");
  assert.deepEqual([typed("a"), typed("!", true), typed("Z", true), typed(" "), typed(" ", true), typed(0xff0d)], [null, null, null, null, null, null], "keys as a US keyboard types them, Space and Return");
  assert.deepEqual([typed("é", false, true), typed("Z", false, true)], [null, null], "a shortcut stays keys");
  // Over Tart's VNC server, Command is Alt.
  assert.equal(tartTypesAsCharacter(0xe9, new Set()), true);
  assert.equal(tartTypesAsCharacter(0x5a, new Set([0xffe1])), false, "Shift+Z");
  assert.equal(tartTypesAsCharacter(0x5a, new Set([0xffe9])), false, "Command+Z");
  assert.equal(tartTypesAsCharacter(0xe9, new Set([0xffe7])), true, "with Option, as a Mac's Option+E then E gives é");
});

test("the input types a character it has no key for, or with the wrong Shift, as the character, and lets it go so", async () => {
  const far = helper();
  const input = new MacInput(far.channel);
  far.say("ready");
  await input.ready;
  assert.equal(await input.key(true, 0xe9), true);
  assert.equal(await input.key(false, 0xe9), true);
  assert.equal(await input.key(true, 0xffe1), true, "Shift");
  assert.equal(await input.key(true, 0x5a), true, "Z with Shift: its key");
  assert.equal(await input.key(true, 0x31), true, "1 with Shift: the character");
  assert.equal(await input.key(false, 0x31), true);
  await input.ping();
  assert.deepEqual(far.lines, ["u 1 233", "u 0 233", "k 1 56", "k 1 6", "u 1 49", "u 0 49", "t 1"]);
  await input.close();
});

test("a character resolves once the helper says it posted it, so a key sent elsewhere after it cannot overtake it", async () => {
  const far = helper(true);
  const input = new MacInput(far.channel);
  far.say("ready");
  await input.ready;
  let done = false;
  const typing = input.character(true, 0xe9).then(() => void (done = true));
  await until(() => far.lines.includes("u 1 233"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, "sent, not yet posted");
  far.say("u");
  await typing;
  assert.equal(done, true);
  await input.close();
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out");
}
