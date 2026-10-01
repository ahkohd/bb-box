import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ComputerError, chord, explain, pngSize } from "../src/core/computer.ts";
import { driverCommand } from "../src/core/in-box.ts";
import { McpClosedError, McpError, McpSession } from "../src/core/mcp.ts";
import { openRoute } from "../src/transports/route.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { FAKE_CUA_BIN } from "./fake-backend.ts";
import { emptyDesktop, png } from "./fake-cua.ts";
import { tempDir } from "./helpers.ts";

const CLIENT = { client: { name: "bb-box", version: "1" }, timeoutMs: 5_000 };

test("chord splits a key chord into its key and lowercase modifiers", () => {
  assert.deepEqual(chord("ctrl+shift+t"), { key: "t", modifiers: ["ctrl", "shift"] });
  assert.deepEqual(chord("Return"), { key: "Return", modifiers: [] });
  assert.deepEqual(chord(" Ctrl + A "), { key: "A", modifiers: ["ctrl"] });
  assert.deepEqual(chord("ctrl++"), { key: "+", modifiers: ["ctrl"] });
  assert.deepEqual(chord("+"), { key: "+", modifiers: [] });
  for (const bad of ["ctrl+", "", "ctrl++shift+a", "++"]) {
    assert.throws(() => chord(bad), (error: unknown) => error instanceof ComputerError && error.code === "input", bad);
  }
});

test("pngSize reads a PNG's size from its header, and nothing from anything else", () => {
  assert.deepEqual(pngSize(png(1568, 882)), { width: 1568, height: 882 });
  assert.equal(pngSize(Buffer.from("not an image at all, not even close").toString("base64")), null);
  assert.equal(pngSize(""), null);
});

test("explain says why the desktop refused in bb-box's words, without Cua's codes, tools or hex window IDs", () => {
  const refused = (text: string, structured?: Record<string, unknown>) => ({ content: [{ type: "text", text }], structuredContent: structured, isError: true });
  const focus =
    "foreground_unavailable: window 0x1000122 did not become the active, focused window within 1.5s (active=0x0 focus_within_target=true); " +
    "no input was sent. bring_to_front it or target that dialog instead.";
  assert.equal(explain(refused(focus, { status: "refused", refusal: { code: "foreground_unavailable" } })), "Window 16777506 could not be made the active window, so nothing was sent to it.");
  assert.equal(explain(refused(focus)), "Window 16777506 did not become the active, focused window within 1.5s; no input was sent.");
  assert.equal(
    explain(refused("element_token is stale; call get_window_state again to refresh", { status: "refused", refusal: { code: "stale_element_token" } })),
    "The element changed since bb-box last read its window, so nothing was done.",
  );
  assert.equal(explain(refused("Cua Driver could not do that.")), "The desktop gave no reason.");
  assert.equal(explain(refused("The app is not responding \u2014 call get_window_state to check it.")), "The app is not responding.");
});

/** A channel whose other end is this test: `send` writes lines to the client, `sent` holds what the client wrote. */
function loopback() {
  let push!: ReadableStreamDefaultController<Uint8Array>;
  const sent: Record<string, unknown>[] = [];
  let closed = false;
  let partial = "";
  const channel: ByteChannel = {
    readable: new ReadableStream({ start: (controller) => void (push = controller) }),
    writable: new WritableStream({
      write(chunk) {
        partial += Buffer.from(chunk).toString("utf8");
        for (let at = partial.indexOf("\n"); at !== -1; at = partial.indexOf("\n")) {
          sent.push(JSON.parse(partial.slice(0, at)) as Record<string, unknown>);
          partial = partial.slice(at + 1);
        }
      },
    }),
    async close() {
      if (closed) return;
      closed = true;
      try {
        push.close();
      } catch {
        // Already ended by the other side.
      }
    },
  };
  return {
    channel,
    sent,
    get closed() {
      return closed;
    },
    send: (text: string) => push.enqueue(new TextEncoder().encode(text)),
    end: () => push.close(),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    assert.ok(tries < 200, "timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Opens a session over a loopback, answering initialize. */
async function opened(onClose?: (error: Error) => void) {
  const other = loopback();
  const opening = McpSession.open(other.channel, { ...CLIENT, onClose });
  await until(() => other.sent.length === 1);
  assert.equal(other.sent[0]!.method, "initialize");
  other.send(`${JSON.stringify({ jsonrpc: "2.0", id: other.sent[0]!.id, result: { protocolVersion: "2025-06-18", capabilities: {} } })}\n`);
  const session = await opening;
  await until(() => other.sent.length === 2);
  assert.deepEqual(other.sent[1], { jsonrpc: "2.0", method: "notifications/initialized" });
  return { session, other };
}

test("an MCP session reads answers split across chunks and ignores what is not JSON-RPC", async () => {
  const { session, other } = await opened();
  const call = session.call("list_windows", {}, { timeoutMs: 5_000 });
  await until(() => other.sent.length === 3);
  const id = other.sent[2]!.id;
  assert.deepEqual(other.sent[2]!.params, { name: "list_windows", arguments: {} });
  const answer = JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { windows: [] } } });
  other.send("a stray log line\n");
  other.send(answer.slice(0, 20));
  other.send(`${answer.slice(20)}\n`);
  assert.deepEqual(await call, { content: [{ type: "text", text: "ok" }], structuredContent: { windows: [] }, isError: false });

  // The server's own requests: ping is answered, anything else refused.
  other.send(`${JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "ping" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "sampling/createMessage" })}\n`);
  await until(() => other.sent.length === 5);
  assert.deepEqual(other.sent[3], { jsonrpc: "2.0", id: "p1", result: {} });
  assert.equal((other.sent[4]!.error as { code: number }).code, -32601);

  const refused = session.request("tools/list", {}, { timeoutMs: 5_000 });
  await until(() => other.sent.length === 6);
  other.send(`${JSON.stringify({ jsonrpc: "2.0", id: other.sent[5]!.id, error: { code: -32602, message: "No." } })}\n`);
  await assert.rejects(refused, (error: unknown) => error instanceof McpError && error.code === -32602 && error.message === "No.");
  await session.close();
});

test("an MCP call that times out or is aborted is cancelled, and the session carries on", async () => {
  const { session, other } = await opened();
  await assert.rejects(session.call("slow", {}, { timeoutMs: 20 }), /did not answer tools\/call within 0 s/);
  await until(() => other.sent.some((message) => message.method === "notifications/cancelled"));
  const controller = new AbortController();
  const aborted = session.call("slow", {}, { timeoutMs: 5_000, signal: controller.signal });
  controller.abort(new Error("The tool call was cancelled."));
  await assert.rejects(aborted, /The tool call was cancelled\./);
  assert.equal(session.closed, false);
  await session.close();
});

test("closing an MCP session fails its calls with the reason, and the driver's end does too", async () => {
  const closes: Error[] = [];
  const first = await opened((error) => closes.push(error));
  const pending = first.session.call("click", {}, { timeoutMs: 5_000 });
  await until(() => first.other.sent.length === 3);
  const refused = assert.rejects(pending, (error: unknown) => error instanceof McpClosedError && error.message === "A person took control.");
  await first.session.close("A person took control.");
  await refused;
  await assert.rejects(first.session.call("click", {}, { timeoutMs: 5_000 }), /A person took control\./);
  assert.equal(first.other.closed, true);
  assert.equal(first.session.closed, true);

  const second = await opened((error) => closes.push(error));
  const waiting = assert.rejects(second.session.call("click", {}, { timeoutMs: 5_000 }), /The computer-use driver ended the session\./);
  second.other.end();
  await waiting;
  assert.deepEqual(
    closes.map((error) => error.message),
    ["A person took control.", "The computer-use driver ended the session."],
  );
});

test("an MCP session opens with the driver command and talks to the driver", async () => {
  const home = tempDir("bb-box-cua-");
  const desktop = emptyDesktop();
  desktop.delays.click = 5_000;
  writeFileSync(join(home, "cua-driver.json"), JSON.stringify(desktop));
  const script = `cd '${home}' && PATH='${FAKE_CUA_BIN}':"$PATH" && export PATH && ${driverCommand("linux", "cua-driver.json")}`;
  const channel = await openRoute({ type: "command", argv: ["sh", "-c", script] });
  const session = await McpSession.open(channel, CLIENT);
  const listed = await session.call("list_windows", {}, { timeoutMs: 5_000 });
  assert.deepEqual(listed.structuredContent?.windows, []);
  const clicking = assert.rejects(session.call("click", { x: 1, y: 1, scope: "desktop" }, { timeoutMs: 5_000 }), /^McpClosedError: Stopped\.$/);
  await session.close("Stopped.");
  await clicking;
});
