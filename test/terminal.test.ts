// A terminal with its PTY on BB's server (src/transports/terminal.ts), and
// the sessions the plugin keeps for tabs that come and go (src/plugin/terminal.ts).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Boxes } from "../src/core/boxes.ts";
import { closeReason, registerTerminals, TerminalSessions, type TerminalViewer } from "../src/plugin/terminal.ts";
import { clampSize, openTerminal, ptyArgv } from "../src/transports/terminal.ts";
import type { CommandTransport, Terminal } from "../src/transports/types.ts";

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

test("a close reason fits a WebSocket's 123 bytes, cut at a character", () => {
  assert.equal(closeReason("The shell exited."), "The shell exited.");
  const long = `ssh: connect to host 192.0.2.85 port 22: No route to host ${"x".repeat(2_000)}`;
  const cut = closeReason(long);
  assert.ok(new TextEncoder().encode(cut).byteLength <= 123, "within 123 bytes");
  assert.ok(cut.endsWith("…"));
  const accented = `${"é".repeat(60)} ${"ü".repeat(60)}`;
  const cutAccented = closeReason(accented);
  assert.ok(new TextEncoder().encode(cutAccented).byteLength <= 123);
  assert.doesNotMatch(cutAccented, /\uFFFD/, "no broken character");
});

type Handlers = ReturnType<Parameters<BbPluginApi["http"]["experimental_websocket"]>[1]>;

/** The route's handlers for a box whose transport opens `command`, with the plugin's socket faked. */
function route(command: Partial<CommandTransport> | null, options: { idleMs?: number; logged?: string[] } = {}) {
  let handler: Parameters<BbPluginApi["http"]["experimental_websocket"]>[1] | null = null;
  const bb = { pluginId: "bb-box", log: { info() {}, error() {} }, http: { experimental_websocket: (_path: string, given: typeof handler) => void (handler = given) } } as unknown as BbPluginApi;
  const boxes = {
    find: async (id: string) => ({ id, name: "calm-otter", state: "ready" }),
    transports: async () => ({ command, displays: [], access: null }),
  } as unknown as Boxes;
  const terminals = registerTerminals(bb, { boxes, idleMs: options.idleMs, logError: (operation, error) => options.logged?.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`) });
  const open = (query: string): Handlers => handler!({ url: new URL(`http://bb.local/api/v1/plugins/bb-box/http/terminal?${query}`), request: new Request("http://bb.local/"), headers: new Headers() });
  return { terminals, open };
}

function socket() {
  const chunks: Uint8Array[] = [];
  return {
    readyState: 1,
    closed: null as { code: number; reason: string } | null,
    send: (data: string | Uint8Array) => {
      if (typeof data !== "string") chunks.push(data);
    },
    close(code?: number, reason?: string) {
      this.closed = { code: code ?? 1005, reason: reason ?? "" };
    },
    text: () => chunks.map((chunk) => decoder.decode(chunk)).join(""),
  };
}

test("the route opens a shell for a tab, takes its input and resizes, and detaches a tab that went while the shell opened", { skip }, async () => {
  const { terminals, open } = route({ terminal: (size) => openTerminal(["/bin/sh", "-c", "echo hello; cat"], size) }, { idleMs: 300 });
  const handlers = open("box=box_1&session=sess-0001-aaaa&cols=90&rows=25");
  const tab = socket();
  await handlers.onOpen!(tab);
  await until(() => tab.text().includes("hello"));
  assert.equal(terminals.live, 1);
  await handlers.onMessage!(tab, new TextEncoder().encode("ping\r"));
  await until(() => tab.text().includes("ping\r\nping"));
  await handlers.onMessage!(tab, JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
  await handlers.onClose!(tab, { code: 1001, reason: "" });
  await until(() => terminals.live === 0, 2_000);
  assert.equal(tab.closed, null, "a tab that left is not told");

  // The tab closes while ssh is still connecting: the shell must not be left with a dead socket.
  const late = open("box=box_1&session=sess-0002-bbbb&cols=80&rows=24");
  const gone = socket();
  const opening = late.onOpen!(gone);
  await late.onClose!(gone, { code: 1001, reason: "" });
  await opening;
  assert.equal(terminals.live, 1, "the shell opened");
  await until(() => terminals.live === 0, 2_000);
  await terminals.dispose();
});

test("the route tells a tab why a shell could not open, within a close reason's size, and logs the rest", { skip }, async () => {
  const logged: string[] = [];
  const detail = `ssh: connect to host 192.0.2.85 port 22: No route to host\n${"x".repeat(1_500)}`;
  const { open } = route({ terminal: async () => Promise.reject(new Error(`The terminal ended before it started: ${detail}`)) }, { logged });
  const tab = socket();
  await open("box=box_1&session=sess-0003-cccc&cols=80&rows=24").onOpen!(tab);
  assert.equal(tab.closed?.code, 1011);
  assert.ok(new TextEncoder().encode(tab.closed!.reason).byteLength <= 123);
  assert.match(tab.closed!.reason, /^The terminal ended before it started: ssh: connect/);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /x{1500}/, "the whole message is logged");

  const none = socket();
  await open("box=box_1&session=bad&cols=80&rows=24").onOpen!(none);
  assert.equal(none.closed?.code, 1008);
  const { open: without } = route(null);
  const noShell = socket();
  await without("box=box_1&session=sess-0004-dddd&cols=80&rows=24").onOpen!(noShell);
  assert.deepEqual(noShell.closed, { code: 1011, reason: "Box calm-otter has no terminal: its transport cannot open a shell on a PTY." });
});

test("a resize that fails after its session ended is no error, as its PTY went with the shell (#564)", async () => {
  const errors: string[] = [];
  let failResize = (_error: Error) => {};
  let endOutput = () => {};
  const terminal: Terminal = {
    readable: new ReadableStream<Uint8Array>({ start: (controller) => void (endOutput = () => controller.close()) }),
    writable: new WritableStream<Uint8Array>(),
    resize: () => new Promise<void>((_resolve, reject) => void (failResize = reject)),
    close: async () => endOutput(),
  };
  const sessions = new TerminalSessions({ logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`), open: async () => terminal });
  await sessions.attach("box_4", "sess-0004-dddd", viewer(), { cols: 80, rows: 24 });
  await sessions.end("box_4", "The box was released.");
  failResize(new Error("Resizing the terminal failed: stty: /dev/pts/0: No such file or directory"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, []);
});

test("a tab whose close throws does not keep the shell alive when its session ends", { skip }, async () => {
  const errors: string[] = [];
  const sessions = new TerminalSessions({ logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`), open: (_box, size) => openTerminal(["/bin/sh", "-c", "echo hello; cat"], size) });
  const broken = viewer();
  broken.close = () => {
    throw new Error("the socket is already closed");
  };
  const session = await sessions.attach("box_3", "sess-0003-cccc", broken, { cols: 80, rows: 24 });
  await until(() => broken.text().includes("hello"));
  await sessions.end("box_3", "The box was released.");
  assert.equal(session.ended, true);
  assert.equal(sessions.size, 0);
  assert.deepEqual(errors, ["tell the terminal's tab: the socket is already closed"]);
});

test("on macOS a terminal's script gets its stdin as a pipe, which macOS's script takes where it refused Node's socket (#914)", { skip: spawnSync("perl", ["-v"]).status !== 0 && "needs perl" }, async () => {
  const [perl, flag, relay, ...rest] = ptyArgv("tty", "darwin");
  assert.deepEqual([perl, flag, ...rest], ["perl", "-e", "script", "-q", "/dev/null", "/bin/sh", "-c", "tty"]);
  assert.deepEqual(ptyArgv("tty", "linux"), ["script", "-qfc", "tty", "/dev/null"]);
  // The relay, with a command in place of macOS's script, run as Node runs a child: its stdin a socket.
  const run = (script: string, input?: string) => {
    const child = spawn("perl", ["-e", relay!, "sh", "-c", script], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    if (input !== undefined) child.stdin.write(input);
    const exited = new Promise<number | null>((resolve) => child.once("close", (code) => resolve(code)));
    return { child, exited, stdout: () => stdout };
  };

  const piped = run(`[ -p /dev/stdin ] && echo pipe; read line; echo "got $line"; exit 3`, "hi\n");
  assert.equal(await piped.exited, 3, "it exits with the command's status");
  assert.equal(piped.stdout(), "pipe\ngot hi\n");

  // The command ends while the relay's own stdin stays open, as a PTY's does: the relay ends with it.
  const quick = run("exit 0");
  const ended = await Promise.race([quick.exited, new Promise((resolve) => setTimeout(resolve, 5_000, "still running").unref())]);
  quick.child.kill("SIGKILL");
  assert.equal(ended, 0);

  // SIGTERM, as a closed terminal sends, kills the command at once.
  const long = run("echo $$; exec sleep 30");
  while (!long.stdout().includes("\n")) await new Promise((resolve) => setTimeout(resolve, 20));
  const pid = Number(long.stdout().trim());
  long.child.kill("SIGTERM");
  assert.equal(await long.exited, 129);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), "the command is gone");
});
