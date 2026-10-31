import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const held = new Map();

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (message.method === "session/new") send({ id: message.id, result: { sessionId: randomUUID() } });
  else if (message.method === "session/prompt") {
    const words = (message.params.prompt ?? []).map((part) => part.text ?? "").join(" ");
    if (/\bhold\b/i.test(words)) held.set(message.params.sessionId, message.id);
    else send({ id: message.id, result: { stopReason: "end_turn" } });
  } else if (message.method === "session/cancel") {
    const id = held.get(message.params.sessionId);
    if (id !== undefined) send({ id, result: { stopReason: "cancelled" } });
    held.delete(message.params.sessionId);
  } else if (message.id !== undefined) send({ id: message.id, result: null });
}
