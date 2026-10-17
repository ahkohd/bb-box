// A viewer's way to bb-box's desktop route through BB's server, for measuring.
// The browser loads pages from here (a secure context: localhost) and opens
// ws://127.0.0.1:7000/bb?box=..&viewer=..[&stream=selkies]; this proxy sends
// the upgrade on to BB's server with no Origin, as a client of its own, and
// then copies bytes both ways. Static files come from ./web.
// usage: node proxy.mjs <file holding BB's server URL>
import { createServer } from "node:http";
import { connect as tls } from "node:tls";
import { connect as tcp } from "node:net";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname } from "node:path";
const server = new URL(readFileSync(process.argv[2], "utf8").trim());
const route = "/api/v1/plugins/bb-box/http/desktop";
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
const http = createServer((req, res) => {
  const path = join("web", decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = existsSync(path) && statSync(path).isDirectory() ? join(path, "index.html") : path;
  if (!existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
});
http.on("upgrade", (req, client, head) => {
  const url = new URL(req.url, "http://x");
  const query = new URLSearchParams({ box: url.searchParams.get("box") ?? "", viewer: url.searchParams.get("viewer") ?? "" });
  if (url.searchParams.get("stream")) query.set("stream", url.searchParams.get("stream"));
  // Selkies' own page opens <its directory>/api/websockets: the box and viewer come from the environment.
  if (url.pathname.endsWith("/api/websockets")) {
    query.set("box", process.env.BOX ?? ""); query.set("viewer", process.env.VIEWER ?? ""); query.set("stream", "selkies");
  }
  const secure = server.protocol === "https:";
  const port = Number(server.port || (secure ? 443 : 80));
  const upstream = secure ? tls({ host: server.hostname, port, servername: server.hostname, ALPNProtocols: ["http/1.1"] }) : tcp({ host: server.hostname, port });
  upstream.setNoDelay(true); client.setNoDelay(true);
  upstream.once(secure ? "secureConnect" : "connect", () => {
    const lines = [`GET ${route}?${query} HTTP/1.1`, `Host: ${server.host}`, "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`, `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] ?? 13}`];
    if (req.headers["sec-websocket-protocol"]) lines.push(`Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  const end = () => { upstream.destroy(); client.destroy(); };
  upstream.on("error", end); client.on("error", end); upstream.on("close", end); client.on("close", end);
});
http.listen(7000, "127.0.0.1", () => console.log("proxy on 7000"));
