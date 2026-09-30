// bb-box: check Cua Driver end to end over MCP (stdio, newline-delimited JSON-RPC):
// initialize, list tools, and read the screen size of the desktop.
// usage: node cua-probe.mjs
import { spawn } from "node:child_process";
import readline from "node:readline";

const driver = spawn("cua-driver", ["mcp"], { stdio: ["pipe", "pipe", "ignore"] });
const pending = new Map();
readline.createInterface({ input: driver.stdout }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  }
});
const send = (message) => driver.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const call = (id, method, params) =>
  new Promise((resolve, reject) => {
    pending.set(id, resolve);
    send({ id, method, params });
    setTimeout(() => reject(new Error(`${method} timed out`)), 20000);
  });

try {
  const init = await call(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bb-box-cua-probe", version: "1" },
  });
  send({ method: "notifications/initialized" });
  const tools = await call(2, "tools/list", {});
  const size = await call(3, "tools/call", { name: "get_screen_size", arguments: {} });
  console.log(
    JSON.stringify({
      server: init.result?.serverInfo,
      tools: tools.result?.tools?.length,
      screen: size.error ?? size.result?.content?.find((c) => c.type === "text")?.text,
    }),
  );
  driver.stdin.end();
  process.exit(size.error || size.result?.isError ? 1 : 0);
} catch (error) {
  console.error(String(error));
  driver.kill();
  process.exit(1);
}
