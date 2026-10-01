// A terminal with its PTY on BB's server (src/transports/terminal.ts), and
// the sessions the plugin keeps for tabs that come and go (src/plugin/terminal.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalSessions, type TerminalViewer } from "../src/plugin/terminal.ts";
import { clampSize, openTerminal } from "../src/transports/terminal.ts";
import type { Terminal } from "../src/transports/types.ts";

const skip = process.platform === "linux" ? false : "needs util-linux script";
const decoder = new TextDecoder();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads a terminal's output to the end. */
async function collect(terminal: Terminal, onChunk?: (text: string) => void): Promise<string> {
  let text = "";
  const reader = terminal.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    const part = decoder.decode(value, { stream: true });
    text += part;
    onChunk?.(text);
  }
}

/** A viewer that keeps what it was sent and how it was closed. */
function viewer(): TerminalViewer & { text(): string; closed: { code: number; reason: string } | null } {
  const chunks: Uint8Array[] = [];
  return {
    closed: null,
    send: (bytes) => {
      chunks.push(bytes);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    text: () => chunks.map((chunk) => decoder.decode(chunk)).join(""),
  };
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await sleep(20);
  }
}

test("a terminal runs on a PTY here, at the size asked, and takes a new size", { skip }, async () => {
  const terminal = await openTerminal(["/bin/sh", "-c", "stty size; sleep 1; stty size"], { cols: 80, rows: 24 });
  const output = collect(terminal);
  await sleep(500);
  await terminal.resize({ cols: 100, rows: 30 });
  const text = await output;
  assert.match(text, /24 80/);
  assert.match(text, /30 100/);
  await terminal.close();
});

test("the terminal's input reaches the shell, and closing it hangs the shell up", { skip }, async () => {
  const terminal = await openTerminal(["/bin/sh", "-c", "cat"], { cols: 80, rows: 24 });
  let seen = "";
  const reading = collect(terminal, (text) => {
    seen = text;
  });
  const writer = terminal.writable.getWriter();
  await writer.write(new TextEncoder().encode("hello\r"));
  await until(() => seen.includes("hello\r\nhello"));
  await terminal.close();
  await reading;
});

test("a command that exits at once still had its PTY, and its output ends", { skip }, async () => {
  const terminal = await openTerminal(["/bin/sh", "-c", "echo gone; exit 3"], { cols: 80, rows: 24 });
  assert.match(await collect(terminal), /gone/);
  await terminal.close();
});

test("a terminal is not opened for a signal that is already aborted", async () => {
  await assert.rejects(openTerminal(["/bin/sh"], { cols: 80, rows: 24 }, AbortSignal.abort(new Error("gone"))), /gone/);
});

test("sizes are clamped to what stty takes", () => {
  assert.deepEqual(clampSize({ cols: 120.4, rows: 40 }), { cols: 120, rows: 40 });
  assert.deepEqual(clampSize({ cols: 0, rows: Number.NaN }), { cols: 80, rows: 24 });
  assert.deepEqual(clampSize({ cols: 99_999, rows: -1 }), { cols: 1000, rows: 24 });
});

test("a session keeps its shell while its tab is away, replays the output to the next tab, and ends when idle", { skip }, async () => {
  let opened = 0;
  const errors: string[] = [];
  const sessions = new TerminalSessions({
    idleMs: 300,
    logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
    open(boxId, size) {
      opened++;
      assert.equal(boxId, "box_1");
      return openTerminal(["/bin/sh", "-c", "echo hello; cat"], size);
    },
  });
  const first = viewer();
  const session = await sessions.attach("box_1", "sess-0001-aaaa", first, { cols: 80, rows: 24 });
  await until(() => first.text().includes("hello"));
  session.input(new TextEncoder().encode("ping\r"));
  await until(() => first.text().includes("ping\r\nping"));
  session.detach(first);
  assert.equal(first.closed, null, "the shell stays when its tab goes");

  const second = viewer();
  assert.equal(await sessions.attach("box_1", "sess-0001-aaaa", second, { cols: 100, rows: 30 }), session, "the same session");
  assert.match(second.text(), /hello[\s\S]*ping/, "the next tab sees what was printed");
  assert.equal(opened, 1);

  const third = viewer();
  await sessions.attach("box_1", "sess-0001-aaaa", third, { cols: 80, rows: 24 });
  assert.deepEqual(second.closed, { code: 1000, reason: "Another tab took this terminal." });

  session.detach(third);
  await until(() => session.ended, 2_000);
  assert.equal(sessions.size, 0);
  assert.equal(third.closed, null, "a detached tab is not told; it will hear when it attaches again");
  const fourth = viewer();
  const next = await sessions.attach("box_1", "sess-0001-aaaa", fourth, { cols: 80, rows: 24 });
  assert.notEqual(next, session, "an ended session is replaced by a new shell");
  assert.equal(opened, 2);
  await sessions.end("box_1", "The box was released.");
  assert.deepEqual(fourth.closed, { code: 1000, reason: "The box was released." });
  assert.deepEqual(errors, []);
});

test("a session ends when its shell exits, and tells its tab", { skip }, async () => {
  const sessions = new TerminalSessions({ logError: () => {}, open: (_box, size) => openTerminal(["/bin/sh", "-c", "echo bye"], size) });
  const tab = viewer();
  const session = await sessions.attach("box_2", "sess-0002-bbbb", tab, { cols: 80, rows: 24 });
  await until(() => session.ended);
  assert.deepEqual(tab.closed, { code: 1000, reason: "The shell exited." });
  assert.match(tab.text(), /bye/);
});
