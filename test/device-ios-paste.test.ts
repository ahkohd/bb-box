import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { DriverError } from "../src/device/driver.ts";
import { PASTE_NOTICE_SCENE, PasteWatch, pasteLogEvent } from "../src/device/ios-paste-watch.ts";
import { accessibilityUnanswered } from "../src/device/ios-tree.ts";
import { PASTEBOARD_NOT_ANSWERING_EXIT, Simctl, type Ran, type Runner } from "../src/device/simctl.ts";

const READ_BY = (bundle: string) => `2026-10-28 23:28:20.848 Df pasted[11053:c089] [com.apple.Pasteboard:Pasteboard] Bundle ID ${bundle} from team None is requesting item 0 from pasteboard named com.apple.UIKit.pboard.general with UUID FE9BD870-88C6-458B-B8DA-0737F2B2752D`;
const NOTICE_SHOWN = `2026-10-28 23:33:58.967 Df SpringBoard[13837:ee6e] [com.apple.SpringBoard:KeyboardFocus] deferFromSBWindowScene: adding rule for <token: com.apple.frontboard.systemappservices/com.apple.BannerKit:${PASTE_NOTICE_SCENE}.druid.483513AD>`;
const NOTICE_HIDDEN = `2026-10-28 23:34:01.522 Df SpringBoard[13837:ee6e] [com.apple.SpringBoard:KeyboardFocus] deferFromSBWindowScene: invalidate for <token: com.apple.frontboard.systemappservices/com.apple.BannerKit:${PASTE_NOTICE_SCENE}.druid.483513AD>`;
const LISTENING = 'Filtering the log data using "subsystem == ..."';
const FAST = { listening: 200, read: 300, noticeAfterRead: 150, noticeShown: 400, noticeSettled: 20, recheck: 5 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeLog {
  readonly #lines: string[] = [];
  #wake: (() => void) | null = null;
  #ended = false;
  stopped = false;

  say(line: string): void {
    this.#lines.push(line);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  readonly lines = (signal: AbortSignal): AsyncIterable<string> => {
    const self = this;
    signal.addEventListener("abort", () => {
      self.stopped = true;
      self.end();
    });
    return (async function* () {
      for (;;) {
        while (self.#lines.length) yield self.#lines.shift()!;
        if (self.#ended) return;
        await new Promise<void>((resolve) => (self.#wake = resolve));
      }
    })();
  };
}

test("the device's log names an app's read of the pasteboard, but not the keyboard's or simctl's own, and the paste notice's hold on the keyboard (F-21)", () => {
  assert.deepEqual(pasteLogEvent(LISTENING), { is: "listening" });
  assert.deepEqual(pasteLogEvent(READ_BY("dev.bb-box.probe")), { is: "read", reader: "dev.bb-box.probe" });
  assert.deepEqual(pasteLogEvent(READ_BY("com.apple.mobilesafari")), { is: "read", reader: "com.apple.mobilesafari" });
  assert.equal(pasteLogEvent(READ_BY("com.apple.InputUI")), null, "the keyboard reads the pasteboard as it shows");
  assert.equal(pasteLogEvent(READ_BY("(null)")), null, "simctl's own pbpaste");
  assert.deepEqual(pasteLogEvent(NOTICE_SHOWN), { is: "notice shown" });
  assert.deepEqual(pasteLogEvent(NOTICE_HIDDEN), { is: "notice hidden" });
  assert.equal(pasteLogEvent(NOTICE_SHOWN.replace(PASTE_NOTICE_SCENE, "com.apple.Other")), null);
});

test("a paste's watch counts only what comes after the paste key: the app's read, then the notice until it has gone (F-21)", async () => {
  const log = new FakeLog();
  const watch = new PasteWatch(log.lines, { ms: FAST });
  log.say(LISTENING);
  assert.equal(await watch.listening(), true);
  log.say(READ_BY("dev.early.reader"));
  log.say(NOTICE_HIDDEN);
  await wait(10);
  watch.pressed();
  log.say(READ_BY("com.apple.InputUI"));
  setTimeout(() => log.say(READ_BY("dev.bb-box.probe")), 30);
  assert.deepEqual(await watch.read(), { watched: true, reader: "dev.bb-box.probe" });
  const gone = watch.noticeGone();
  let settled = false;
  void gone.then(() => (settled = true));
  log.say(NOTICE_SHOWN);
  log.say(NOTICE_HIDDEN);
  log.say(NOTICE_SHOWN);
  await wait(60);
  assert.equal(settled, false, "a second notice follows the first at once, and holds the keyboard on");
  log.say(NOTICE_HIDDEN);
  assert.equal(await gone, "gone");
  watch.close();
  await wait(5);
  assert.equal(log.stopped, true, "the log stream ends with the watch");
});

test("a paste's watch says when no app read, when no notice showed, when one outlasts it, and when the log could not be watched (F-21)", async () => {
  const quiet = new FakeLog();
  const unread = new PasteWatch(quiet.lines, { ms: FAST });
  quiet.say(LISTENING);
  await unread.listening();
  unread.pressed();
  assert.deepEqual(await unread.read(), { watched: true, reader: null });
  assert.equal(await unread.noticeGone(), "none");
  unread.close();

  const stuck = new FakeLog();
  const shown = new PasteWatch(stuck.lines, { ms: FAST });
  stuck.say(LISTENING);
  await shown.listening();
  shown.pressed();
  stuck.say(READ_BY("dev.bb-box.probe"));
  await shown.read();
  stuck.say(NOTICE_SHOWN);
  assert.equal(await shown.noticeGone(), "still shown");
  shown.close();

  const broken = new FakeLog();
  const unwatched = new PasteWatch(broken.lines, { ms: FAST });
  broken.end();
  assert.equal(await unwatched.listening(), false);
  unwatched.pressed();
  assert.deepEqual(await unwatched.read(), { watched: false });
  assert.equal(await unwatched.noticeGone(), "unwatched");
  unwatched.close();
});

test("simctl waits for a just-booted device's pasteboard, which exits 60 until it answers, and says so if it never does (F-21)", async () => {
  let silent = 2;
  const calls: string[] = [];
  const run: Runner = async (_program, args, options) => {
    calls.push(`${args[1]}${options.input === undefined ? "" : ` ${options.input}`}`);
    if (silent > 0) {
      silent--;
      return { code: PASTEBOARD_NOT_ANSWERING_EXIT, stdout: "", stderr: "An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=60):\nThe operation couldn’t be completed. Operation timed out\nOperation timed out" } satisfies Ran;
    }
    return { code: 0, stdout: "held", stderr: "" } satisfies Ran;
  };
  const simctl = new Simctl({ run, pasteboard: { run, ready: async () => null }, pasteboardAnswerWait: { mostMs: 1_000, everyMs: 10 } });
  await simctl.setClipboard("UDID-1", "bbtest ✓");
  assert.deepEqual(calls, ["pbcopy bbtest ✓", "pbcopy bbtest ✓", "pbcopy bbtest ✓"]);
  silent = 1;
  assert.equal(await simctl.pasteboardAnswers("UDID-1"), false);
  assert.equal(await simctl.pasteboardAnswers("UDID-1"), true);
  assert.equal(await simctl.clipboard("UDID-1"), "held");

  silent = Number.POSITIVE_INFINITY;
  const never = new Simctl({ run, pasteboard: { run, ready: async () => null }, pasteboardAnswerWait: { mostMs: 60, everyMs: 20 } });
  await assert.rejects(never.setClipboard("UDID-1", "x"), (error) => error instanceof DriverError && /simctl could not set the device's clipboard: the device's pasteboard did not answer in 0 s and \d tries \(.*Operation timed out\)\. A device's pasteboard answers some seconds after it boots/.test(error.message));

  const crashing = new Simctl({ run: async () => ({ code: 139, stdout: "", stderr: "" }), pasteboardAnswerWait: { mostMs: 1_000, everyMs: 10 } });
  await assert.rejects(crashing.clipboard("UDID-1"), /simctl could not read the device's clipboard: exit code 139/, "any other failure is not waited on");
});

test("only a read the device's accessibility service left unanswered is waited on (F-21)", () => {
  assert.equal(accessibilityUnanswered(new Error("The simulator's accessibility service did not answer a frontmost request within 5.0s, 5.0s into the read; retry the read.")), true);
  assert.equal(accessibilityUnanswered(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })), true);
  assert.equal(accessibilityUnanswered(new DriverError("failed", "The simulator's accessibility service named no frontmost application")), false);
  assert.equal(accessibilityUnanswered(new DriverError("failed", "idb_companion sent no accessibility tree.")), false);
});
