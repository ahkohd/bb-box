import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIPBOARD_WATCH_MAX_BYTES, MAC_CLIPBOARD_WATCH_SCRIPT, macClipboardWatchCommand, startClipboardWatch } from "../src/core/mac-clipboard.ts";
import type { ByteChannel } from "../src/transports/types.ts";

function watcher() {
  let say!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const channel: ByteChannel = {
    readable: new ReadableStream({ start: (controller) => void (say = controller) }),
    writable: new WritableStream(),
    close: async () => {
      if (closed) return;
      closed = true;
      say.close();
    },
  };
  const encoder = new TextEncoder();
  return {
    channel,
    say: (text: string) => say.enqueue(encoder.encode(text)),
    end: () => void channel.close(),
    closed: () => closed,
  };
}

test("the watcher's script goes in single quotes as it is, looks every 250 ms, and leaves out text over the limit", () => {
  assert.ok(!MAC_CLIPBOARD_WATCH_SCRIPT.includes("'"));
  assert.ok(macClipboardWatchCommand().startsWith("exec osascript -l JavaScript -e '"));
  assert.match(MAC_CLIPBOARD_WATCH_SCRIPT, /sleepForTimeInterval\(0\.25\)/);
  assert.ok(MAC_CLIPBOARD_WATCH_SCRIPT.includes(`data.length > ${CLIPBOARD_WATCH_MAX_BYTES}`));
});

test("the watcher reports each copy as UTF-8 text, the same text again too, and passes over heartbeats and what is not text", async () => {
  const fake = watcher();
  const copies: string[] = [];
  const starting = startClipboardWatch(fake.channel, (text) => copies.push(text));
  fake.say("rea");
  fake.say("dy\nh\n");
  const watch = await starting;
  const text = Buffer.from("héllo ✓ 日本\nline two").toString("base64");
  fake.say(`C ${text}\nN\nh\nC ${text.slice(0, 10)}`);
  fake.say(`${text.slice(10)}\n`);
  fake.end();
  await watch.ended;
  assert.deepEqual(copies, ["héllo ✓ 日本\nline two", "héllo ✓ 日本\nline two"]);
});

test("a watcher that ends before it is ready is an error, and its channel is closed", async () => {
  const fake = watcher();
  const starting = startClipboardWatch(fake.channel, () => undefined);
  fake.say("osascript: no desktop\n");
  fake.end();
  await assert.rejects(starting, /The clipboard watcher did not start in the desktop session/);
  assert.ok(fake.closed());
});
