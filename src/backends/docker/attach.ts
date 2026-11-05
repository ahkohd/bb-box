import { connect } from "node:net";

export const ATTACH_PING = "GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n";

export function isLocalhost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function forwarderReason(address: string): string {
  return `WSL's localhost forwarder at ${address} dropped an attached stream after the client closed its write side. docker run and docker exec then print nothing and exit 0. Set the Docker host to wsl://<distro> so bb-box reaches Docker through wsl.exe and docker system dial-stdio, and leave dockerd on its unix socket.`;
}

export function readAfterHalfClose(port: number, host: string, payload: string, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, allowHalfOpen: true });
    let text = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error && !text) reject(error);
      else resolve(text);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    socket.on("end", () => finish());
    socket.on("error", (error: Error) => finish(error));
    socket.end(payload);
  });
}

export function exitCodeFromInspect(text: string): number | null {
  const split = text.indexOf("\r\n\r\n");
  const body = (split >= 0 ? text.slice(split + 4) : text).trim();
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as { Running?: boolean; ExitCode?: number | null };
    if (parsed.Running !== false || typeof parsed.ExitCode !== "number") return null;
    return parsed.ExitCode;
  } catch {
    return null;
  }
}
