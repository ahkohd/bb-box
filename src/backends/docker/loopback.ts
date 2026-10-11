// BB's loopback address, carried to Docker boxes on the machine that runs
// BB (the setup job's newcomer check). BB's desktop app listens on
// 127.0.0.1 alone, and tells a box's daemon to reach it there, which inside a
// container is the container. So bb-box listens on bb-box's Docker network's
// gateway, at BB's port, and forwards to 127.0.0.1 there; each box forwards
// its own 127.0.0.1 at that port to the gateway with socat. The listener is
// bound to the gateway, so the host's other interfaces never see it, and it
// takes connections from the network's subnet alone.

import { connect, createServer, type Server, type Socket } from "node:net";

/** Whether IPv4 address `address` is in `cidr`, such as 172.18.0.0/16. IPv4-mapped IPv6 addresses count as their IPv4 one. */
export function inSubnet(address: string, cidr: string): boolean {
  const ip = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  const [base, bits] = cidr.split("/");
  const size = Number(bits);
  const value = (dotted: string) => {
    const parts = dotted.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  };
  const a = value(ip);
  const b = value(base ?? "");
  if (a === null || b === null || !Number.isInteger(size) || size < 0 || size > 32) return false;
  const mask = size === 0 ? 0 : (~0 << (32 - size)) >>> 0;
  return (a & mask) === (b & mask);
}

export interface LoopbackTarget {
  /** The gateway of bb-box's Docker network: where the relay listens, and where boxes forward to. */
  readonly gateway: string;
  /** The network's subnet: the only addresses the relay takes. */
  readonly subnet: string;
  /** BB's port, on loopback here and in each box. */
  readonly port: number;
}

/** The relay's listener: one at a time, for the network and port it was last asked for. */
export class LoopbackRelay {
  #server: Server | null = null;
  #target: LoopbackTarget | null = null;
  readonly #sockets = new Set<Socket>();
  readonly #to: string;

  /** `to`: where BB listens here, 127.0.0.1 unless a test says. */
  constructor(to = "127.0.0.1") {
    this.#to = to;
  }

  get target(): LoopbackTarget | null {
    return this.#server ? this.#target : null;
  }

  /** Listens for `target`, unless it does already; a listener for another target is closed first. */
  async open(target: LoopbackTarget): Promise<void> {
    const same = this.#target && this.#server && this.#target.gateway === target.gateway && this.#target.subnet === target.subnet && this.#target.port === target.port;
    if (same) return;
    await this.close();
    const server = createServer((socket) => {
      if (!inSubnet(socket.remoteAddress ?? "", target.subnet)) {
        socket.destroy();
        return;
      }
      const upstream = connect({ host: this.#to, port: target.port });
      this.#sockets.add(socket).add(upstream);
      const done = () => {
        this.#sockets.delete(socket);
        this.#sockets.delete(upstream);
        socket.destroy();
        upstream.destroy();
      };
      socket.on("error", done).on("close", done);
      upstream.on("error", done).on("close", done);
      socket.pipe(upstream).pipe(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: target.gateway, port: target.port, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
    this.#target = target;
  }

  /** Stops listening and ends the connections it carries. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#target = null;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** What each box runs, detached, so its own 127.0.0.1 at BB's port reaches the relay. */
export function boxForwarder(target: LoopbackTarget): string[] {
  return ["socat", `TCP-LISTEN:${target.port},bind=127.0.0.1,reuseaddr,fork`, `TCP:${target.gateway}:${target.port}`];
}
