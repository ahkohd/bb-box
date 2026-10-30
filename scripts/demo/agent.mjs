import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const trace = (line) => appendFileSync(`${process.env.HOME}/demo-agent.log`, `${new Date().toISOString()} ${line}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sessions = new Map();

async function connect(servers) {
  const clients = [];
  for (const server of servers ?? []) {
    try {
      const client = new Client({ name: "demo-agent", version: "1.0.0" });
      if (server.type === "http" || server.url) {
        const headers = Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value]));
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
      } else {
        const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])) };
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env }));
      }
      const { tools } = await client.listTools();
      trace(`server ${server.name}: ${tools.map((tool) => tool.name).join(", ")}`);
      clients.push({ client, tools: new Set(tools.map((tool) => tool.name)) });
    } catch (error) {
      trace(`server ${server.name} failed: ${error.message}`);
    }
  }
  return clients;
}

function say(sessionId, text) {
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
}

async function useTool(sessionId, clients, name, args) {
  const owner = clients.find((each) => each.tools.has(name));
  if (!owner) throw new Error(`No tool ${name}.`);
  const toolCallId = `call-${randomUUID()}`;
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId, title: name, kind: "other", status: "in_progress", rawInput: args } } });
  trace(`call ${name} ${JSON.stringify(args)}`);
  const result = await owner.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  const text = result.content.map((part) => part.text ?? "").join("");
  trace(`result ${name}: ${text.slice(0, 400).replace(/\n/g, " | ")}`);
  send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId, status: result.isError ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text } }], rawOutput: { text } } } });
  if (result.isError) throw new Error(text);
  return text;
}

async function openPageOnDesktop(sessionId, clients, text) {
  const url = /https?:\/\/\S+|\b[a-z0-9-]+\.(?:app|com|org|dev)\b/i.exec(text)?.[0] ?? "getbb.app";
  const address = url.startsWith("http") ? url : `https://${url}`;
  say(sessionId, "Getting a Linux desktop box.\n\n");
  const acquired = await useTool(sessionId, clients, "box_acquire", { kind: "linux-desktop-cpu" });
  const box = /Box (\S+)/.exec(acquired)?.[1];
  if (!box) throw new Error("box_acquire named no box.");
  await pause(1500);
  say(sessionId, `${box} is ready. Opening ${url} in its browser.\n\n`);
  await useTool(sessionId, clients, "computer_launch", { box, url: address });
  await useTool(sessionId, clients, "box_run", { box, desktop: true, command: "wmctrl -r :ACTIVE: -b add,maximized_vert,maximized_horz" });
  say(sessionId, `${url} is open on ${box}'s desktop. Open the desktop from the Box panel to watch it.`);
}

const heldTurns = new Map();

function holdTurn(id, sessionId) {
  say(sessionId, "Working on it.");
  heldTurns.set(sessionId, id);
}

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  trace(`prompt ${text.slice(0, 200)}`);
  if (/\bWORK\b/.test(text)) return holdTurn(id, params.sessionId);
  if (!/desktop/i.test(text)) {
    say(params.sessionId, "Done.");
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  const clients = await session.clients;
  await openPageOnDesktop(params.sessionId, clients, text);
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  trace(`<- ${message.method ?? "response"} ${JSON.stringify(message.params ?? message.result ?? {}).slice(0, 300)}`);
  if (message.method === undefined) return;
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {}, mcpCapabilities: { http: true, sse: false } }, authMethods: [] } });
      break;
    case "session/new": {
      const sessionId = `session-${randomUUID()}`;
      sessions.set(sessionId, { clients: connect(message.params.mcpServers) });
      send({ id: message.id, result: { sessionId } });
      break;
    }
    case "session/prompt":
      prompt(message.id, message.params).catch((error) => {
        trace(`error ${error.stack}`);
        say(message.params.sessionId, `That did not work: ${error.message}`);
        send({ id: message.id, result: { stopReason: "end_turn" } });
      });
      break;
    case "session/cancel": {
      const held = heldTurns.get(message.params.sessionId);
      if (held !== undefined) {
        heldTurns.delete(message.params.sessionId);
        send({ id: held, result: { stopReason: "cancelled" } });
      }
      break;
    }
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported` } });
  }
});
