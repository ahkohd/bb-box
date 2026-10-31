import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const trace = (line) => appendFileSync(`${process.env.HOME}/agent-trace.log`, `${new Date().toISOString()} ${line}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = new Map();
const held = new Map();

async function connect(servers) {
  const clients = [];
  for (const server of servers ?? []) {
    try {
      const client = new Client({ name: "unit-5-agent", version: "1.0.0" });
      if (server.type === "http" || server.url) {
        const headers = Object.fromEntries((server.headers ?? []).map((header) => [header.name, header.value]));
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
      } else {
        const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value])) };
        await client.connect(new StdioClientTransport({ command: server.command, args: server.args ?? [], env }));
      }
      const { tools } = await client.listTools();
      trace(`server ${server.name}: ${tools.length} tools`);
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

function run(command) {
  return new Promise((resolve) => execFile("/bin/sh", ["-lc", command], { timeout: 120_000 }, (error, stdout, stderr) => resolve(`exit ${error ? (error.code ?? "?") : 0}\n${stdout}${stderr}`)));
}

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  trace(`prompt ${text.slice(0, 300).replace(/\n/g, " | ")}`);
  if (/^WORK\b/m.test(text)) {
    say(params.sessionId, "Working until stopped.");
    held.set(params.sessionId, id);
    return;
  }
  const shell = /^RUN (.+)$/m.exec(text);
  if (shell) {
    const output = await run(shell[1]);
    trace(`ran ${shell[1]}: ${output.slice(0, 300).replace(/\n/g, " | ")}`);
    say(params.sessionId, `RAN ${shell[1]}\n${output}`);
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  const call = [...text.matchAll(/^CALL (\w+)(?: (\{.*\}))?$/gm)].at(-1);
  if (!call) {
    say(params.sessionId, `HEARD ${text.slice(-400)}`);
    send({ id, result: { stopReason: "end_turn" } });
    return;
  }
  const name = call[1];
  const args = call[2] ? JSON.parse(call[2]) : {};
  const owner = (await session.clients).find((each) => each.tools.has(name));
  let answer = `No tool ${name}.`;
  if (owner) {
    trace(`call ${name} ${JSON.stringify(args)}`);
    const result = await owner.client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    answer = result.content.map((part) => part.text ?? "").join("");
    trace(`result ${name}: ${answer.slice(0, 300).replace(/\n/g, " | ")}`);
  }
  say(params.sessionId, `RESULT ${name}\n${answer}`);
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
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
        say(message.params.sessionId, `ERROR ${error.message}`);
        send({ id: message.id, result: { stopReason: "end_turn" } });
      });
      break;
    case "session/cancel": {
      const id = held.get(message.params.sessionId);
      if (id !== undefined) {
        held.delete(message.params.sessionId);
        send({ id, result: { stopReason: "cancelled" } });
      }
      break;
    }
    default:
      if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: `${message.method} is not supported` } });
  }
});
