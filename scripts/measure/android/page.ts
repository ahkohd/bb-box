import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 8765);
const logFile = process.env.LOG ?? "/tmp/android-page.log";
let command = "";

writeFileSync(logFile, "");
createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://page").pathname;
  if (request.method === "POST" && path === "/log") {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      appendFileSync(logFile, `${body}\n`);
      response.end();
    });
    return;
  }
  if (path === "/command") {
    response.end(command);
    command = "";
    return;
  }
  if (path.startsWith("/fetch")) {
    const asked = new URL(request.url ?? "/", "http://page").searchParams;
    command = `fetch:${asked.get("kib") ?? "100"}:${asked.get("after") ?? "0"}`;
    response.end("ok");
    return;
  }
  if (path === "/blob") {
    const asked = Number.parseInt(new URL(request.url ?? "/", "http://page").searchParams.get("kib") ?? "100", 10);
    const kib = Number.isFinite(asked) && asked >= 0 ? asked : 100;
    response.setHeader("cache-control", "no-store");
    response.end(Buffer.alloc(kib * 1024, 97));
    return;
  }
  if (path === "/clear") {
    command = "clear";
    response.end("ok");
    return;
  }
  if (path === "/log") {
    response.end(readFileSync(logFile));
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(readFileSync(join(here, "probe.html")));
}).listen(port, "0.0.0.0", () => console.log(`page on ${port}, log in ${logFile}`));
