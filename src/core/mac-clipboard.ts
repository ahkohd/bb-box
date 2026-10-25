import { pause } from "../transports/ready.ts";
import type { ByteChannel } from "../transports/types.ts";

export const CLIPBOARD_WATCH_EVERY_MS = 250;
export const CLIPBOARD_WATCH_MAX_BYTES = 4 * 1024 * 1024;
const WATCH_START_MS = 15_000;

export const MAC_CLIPBOARD_WATCH_SCRIPT = String.raw`ObjC.import("AppKit");
function run() {
  var out = $.NSFileHandle.fileHandleWithStandardOutput;
  function say(line) { out.writeData($(line + "\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
  var pasteboard = $.NSPasteboard.generalPasteboard;
  var seen = Number(pasteboard.changeCount);
  say("ready");
  for (var tick = 1; ; tick++) {
    $.NSThread.sleepForTimeInterval(${CLIPBOARD_WATCH_EVERY_MS / 1000});
    var count = Number(pasteboard.changeCount);
    if (count === seen) {
      if (tick % 8 === 0) say("h");
      continue;
    }
    seen = count;
    var string = pasteboard.stringForType($.NSPasteboardTypeString);
    var data = string.isNil() ? null : string.dataUsingEncoding($.NSUTF8StringEncoding);
    say(data === null || Number(data.length) > ${CLIPBOARD_WATCH_MAX_BYTES} ? "N" : "C " + data.base64EncodedStringWithOptions(0).js);
  }
}`;

export function macClipboardWatchCommand(): string {
  return `exec osascript -l JavaScript -e '${MAC_CLIPBOARD_WATCH_SCRIPT}'`;
}

export class ClipboardWatch {
  readonly #channel: ByteChannel;
  readonly ready: Promise<void>;
  readonly ended: Promise<void>;

  constructor(channel: ByteChannel, onText: (text: string) => void) {
    this.#channel = channel;
    let ready!: () => void;
    this.ready = new Promise((resolve) => (ready = resolve));
    this.ended = this.#read(ready, onText);
    this.ended.catch(() => undefined);
  }

  async #read(ready: () => void, onText: (text: string) => void): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.#channel.readable.getReader();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      rest += decoder.decode(value, { stream: true });
      const lines = rest.split("\n");
      rest = lines.pop()!;
      for (const line of lines) {
        if (line === "ready") ready();
        else if (line.startsWith("C ")) onText(Buffer.from(line.slice(2), "base64").toString("utf8"));
      }
    }
  }

  close(): Promise<void> {
    return this.#channel.close();
  }
}

export async function startClipboardWatch(channel: ByteChannel, onText: (text: string) => void, signal?: AbortSignal): Promise<ClipboardWatch> {
  const watch = new ClipboardWatch(channel, onText);
  const started = await Promise.race([
    watch.ready.then(() => true),
    watch.ended.then(
      () => false,
      () => false,
    ),
    pause(WATCH_START_MS, signal).then(() => false),
  ]);
  if (started) return watch;
  await watch.close().catch(() => undefined);
  throw new Error("The clipboard watcher did not start in the desktop session.");
}
