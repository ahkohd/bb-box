import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const trace = (line) => appendFileSync(`${process.env.HOME}/agent-trace.log`, `${new Date().toISOString()} ${line}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = new Map();

async function connect(servers) {
  const clients = [];
  for (const server of servers ?? []) {
    try {
      const client = new Client({ name: "tool-caller", version: "1.0.0" });
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

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  const call = [...text.matchAll(/CALL (\w+)(?: (\{[^\n]*\}))?/g)].at(-1);
  if (!call) throw new Error("No CALL line in the prompt.");
  const name = call[1];
  const args = call[2] ? JSON.parse(call[2]) : {};
  const owner = (await session.clients).find((each) => each.tools.has(name));
  let answer;
  if (!owner) answer = `No tool ${name}.`;
  else {
    trace(`call ${name} ${JSON.stringify(args)}`);
    const result = await owner.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    answer = result.content.map((part) => part.text ?? "").join("");
    trace(`result ${name}: ${answer.slice(0, 300).replace(/\n/g, " | ")}`);
  }
  send({ method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  trace(`<- ${message.method ?? "response"} ${JSON.stringify(message.params ?? message.result ?? {}).slice(0, 400)}`);
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
        send({ method: "session/update", params: { sessionId: message.params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Error: ${error.message}` } } } });
        send({ id: message.id, result: { stopReason: "end_turn" } });
      });
      break;
    case "session/cancel":
      break;
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported` } });
  }
});
