// The server's end of the Docker API relay (042). For each BB machine that
// is a Docker host, bb-box listens on a unix socket that only BB's user can
// use, and the docker CLI takes it as the host. Each connection to it is a
// channel on one WebSocket for the machine, which the machine's worker opens
// out to bb-box's route with a one-time secret that a host call gives it.
// The relay opens when a connection needs it, and closes after IDLE_MS with
// no channel open, unless bb-box still has a box on the machine.

import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mux, type Channel } from "./mux.ts";

/** The route the machine's worker connects to, under the plugin's HTTP routes. */
export const RELAY_ROUTE = "/docker-relay";
/** How long a secret waits for the worker's socket. */
export const ACCEPT_MS = 10_000;
/** How long a relay with no channel stays open when bb-box has no box on the machine. */
export const IDLE_MS = 5 * 60_000;
/**
 * A relay that has heard nothing for this long, a ping and some, may be to a
 * machine that slept: a new connection asks BB about the machine first.
 */
export const STALE_MS = 20_000;

/** The parts of BB's plugin WebSocket the hub uses. */
export interface RelaySocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RelayHubDeps {
  /**
   * Asks the machine's worker to open the relay with `secret`: the host
   * entry's "relay" call. Resolves once the worker has started connecting.
   */
  open(hostId: string, secret: string, signal: AbortSignal): Promise<unknown>;
  /** Whether bb-box needs the machine's relay with no channel open: it has a box there. */
  keep(hostId: string): Promise<boolean>;
  /** Why the machine is offline, as BB shows it now with no call to it, or null while it is connected. */
  offline?(hostId: string): Promise<string | null>;
  logError(operation: string, error: unknown): void;
  log?(message: string): void;
  /** Where the sockets go; a private directory of its own by default. */
  readonly dir?: string;
  readonly acceptMs?: number;
  readonly idleMs?: number;
  readonly pingMs?: number;
  readonly deadMs?: number;
  readonly staleMs?: number;
}

interface Machine {
  readonly hostId: string;
  readonly path: string;
  readonly server: Server;
  /** The relay, once open or while it opens. */
  relay: Promise<Mux> | null;
  /** The docker CLI's connections, which closing the server would wait for. */
  readonly sockets: Set<Socket>;
  /** Resolves once the socket listens. */
  readonly listening: Promise<void>;
  idle: ReturnType<typeof setTimeout> | null;
}

interface Pending {
  readonly hostId: string;
  /** Whether bb-box took a socket for it, or stopped waiting. */
  settled: boolean;
  resolve(mux: Mux): void;
  reject(error: Error): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Answers the docker CLI's first request, when there is no relay or the
 * machine could not reach Docker, with the reason as an HTTP error, which it
 * shows as "Error response from daemon".
 */
function refuse(socket: Socket, reason: string): void {
  const body = `bb-box could not reach Docker on the BB machine: ${reason}`;
  socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export class RelayHub {
  readonly #deps: RelayHubDeps;
  readonly #dir: string;
  readonly #ownDir: boolean;
  readonly #machines = new Map<string, Machine>();
  readonly #pending = new Map<string, Pending>();
  #disposed = false;

  constructor(deps: RelayHubDeps) {
    this.#deps = deps;
    this.#ownDir = !deps.dir;
    this.#dir = deps.dir ?? mkdtempSync(join(tmpdir(), "bb-box-relay-"));
    chmodSync(this.#dir, 0o700);
  }

  /** The docker CLI's host for machine `hostId`, the same each time. It listens once `endpoint` resolves. */
  address(hostId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) throw new Error(`"${hostId}" is not a BB machine ID.`);
    return `unix://${join(this.#dir, `${hostId}.sock`)}`;
  }

  /** The docker CLI's host for machine `hostId`, listening once this resolves. */
  async endpoint(hostId: string): Promise<string> {
    if (this.#disposed) throw new Error("The Docker relay has stopped.");
    const address = this.address(hostId);
    const known = this.#machines.get(hostId);
    if (known) {
      await known.listening;
      return address;
    }
    const path = address.slice("unix://".length);
    rmSync(path, { force: true });
    // Half-open, so a client's end of input reaches Docker as its end of input, not of the connection.
    const server = createServer({ allowHalfOpen: true }, (socket) => this.#connection(machine, socket));
    const listening = new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        chmodSync(path, 0o600);
        resolve();
      });
    });
    const machine: Machine = { hostId, path, server, relay: null, idle: null, sockets: new Set(), listening };
    this.#machines.set(hostId, machine);
    try {
      await listening;
    } catch (error) {
      this.#machines.delete(hostId);
      throw error;
    }
    return address;
  }

  /** The handler for bb-box's WebSocket route, which the machine's worker connects to. */
  route(url: URL) {
    const secret = url.searchParams.get("s") ?? "";
    const pending = this.#pending.get(secret);
    this.#pending.delete(secret);
    let mux: Mux | null = null;
    return {
      onOpen: (socket: RelaySocket) => {
        if (!pending) {
          socket.close(1008, "This relay secret is unknown or used.");
          return;
        }
        // A socket that opens after bb-box stopped waiting would make a relay nothing uses, whose pings keep the worker's lease.
        if (pending.settled) {
          socket.close(1008, "bb-box stopped waiting for this relay.");
          return;
        }
        mux = new Mux(
          { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) },
          {
            opener: true,
            pingMs: this.#deps.pingMs,
            deadMs: this.#deps.deadMs,
            onClose: (reason) => {
              const machine = this.#machines.get(pending.hostId);
              if (machine) {
                machine.relay = null;
                this.#stopIdle(machine);
              }
              this.#deps.log?.(`The Docker relay to BB machine ${pending.hostId} closed: ${reason}.`);
            },
          },
        );
        pending.resolve(mux);
      },
      onMessage: (_socket: RelaySocket, data: string | Uint8Array) => {
        if (typeof data !== "string") mux?.receive(data);
      },
      onClose: () => mux?.close("the machine's side closed"),
      onError: (_socket: RelaySocket, error: Error) => this.#deps.logError("docker relay", error),
    };
  }

  /**
   * Ends the machine's relay, as when BB says its worker exited, so the next
   * connection finds out at once rather than when the pings stop.
   */
  drop(hostId: string, reason: string): void {
    void this.#machines.get(hostId)?.relay?.then(
      (mux) => mux.close(reason),
      () => {},
    );
  }

  /** Closes the machine's relay and socket, as when it is no longer a Docker host. */
  async forget(hostId: string): Promise<void> {
    const machine = this.#machines.get(hostId);
    if (!machine) return;
    this.#machines.delete(hostId);
    this.#stopIdle(machine);
    (await machine.relay?.catch(() => null))?.close("bb-box no longer uses this machine for Docker");
    for (const socket of machine.sockets) socket.destroy();
    await new Promise<void>((resolve) => machine.server.close(() => resolve()));
    rmSync(machine.path, { force: true });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("The Docker relay has stopped."));
    this.#pending.clear();
    await Promise.all([...this.#machines.keys()].map((hostId) => this.forget(hostId)));
    if (this.#ownDir) rmSync(this.#dir, { recursive: true, force: true });
  }

  #connection(machine: Machine, socket: Socket): void {
    machine.sockets.add(socket);
    socket.on("close", () => machine.sockets.delete(socket));
    socket.on("error", () => {});
    this.#fresh(machine).then(
      (mux) => {
        if (socket.destroyed) return;
        let channel: Channel;
        try {
          channel = mux.open();
        } catch (error) {
          refuse(socket, message(error));
          return;
        }
        this.#stopIdle(machine);
        socket.on("error", () => channel.destroy());
        socket.on("close", () => channel.destroy());
        // A channel that ended cleanly has ended the socket's output through the pipe, and the socket closes once it is sent.
        channel.on("close", () => {
          if (!mux.channels) this.#startIdle(machine, mux);
        });
        socket.pipe(channel).pipe(socket);
        // A reset before Docker answered says why the machine could not reach it, which the docker CLI shows rather than EOF.
        let answered = false;
        channel.once("data", () => (answered = true));
        channel.on("error", (error) => {
          if (answered || socket.destroyed) return void socket.destroy();
          this.#deps.log?.(`Docker on BB machine ${machine.hostId} did not answer: ${error.message}`);
          refuse(socket, error.message);
        });
      },
      (error) => refuse(socket, message(error)),
    );
  }

  /**
   * The machine's relay, checked first when it has gone quiet. One to a
   * machine BB shows offline ends at once with the reason; a quiet one to a
   * connected machine is replaced, which costs one host call.
   */
  async #fresh(machine: Machine): Promise<Mux> {
    const mux = await this.#relay(machine);
    if (mux.quietMs <= (this.#deps.staleMs ?? STALE_MS)) return mux;
    const offline = (await this.#deps.offline?.(machine.hostId).catch(() => null)) ?? null;
    mux.close(offline ?? `nothing came over it for ${Math.round(mux.quietMs / 1000)} s`);
    if (offline) throw new Error(offline);
    return this.#relay(machine);
  }

  /** The machine's relay, opening it when there is none. */
  #relay(machine: Machine): Promise<Mux> {
    if (machine.relay) return machine.relay;
    const opening = this.#open(machine.hostId);
    machine.relay = opening;
    opening.catch(() => {
      if (machine.relay === opening) machine.relay = null;
    });
    return opening;
  }

  async #open(hostId: string): Promise<Mux> {
    const secret = randomBytes(16).toString("hex");
    const abort = new AbortController();
    const accepted = new Promise<Mux>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(secret);
        pending.reject(new Error(`the machine's worker did not connect to bb-box within ${Math.round(this.#acceptMs / 1000)} s`));
      }, this.#acceptMs);
      timer.unref?.();
      const pending: Pending = {
        hostId,
        settled: false,
        resolve: (mux) => {
          pending.settled = true;
          clearTimeout(timer);
          resolve(mux);
        },
        reject: (error) => {
          pending.settled = true;
          clearTimeout(timer);
          reject(error);
        },
      };
      this.#pending.set(secret, pending);
    });
    accepted.catch(() => abort.abort());
    try {
      await this.#deps.open(hostId, secret, abort.signal);
    } catch (error) {
      this.#pending.get(secret)?.reject(error instanceof Error ? error : new Error(message(error)));
      this.#pending.delete(secret);
    }
    const mux = await accepted;
    this.#deps.log?.(`Opened the Docker relay to BB machine ${hostId}.`);
    return mux;
  }

  get #acceptMs(): number {
    return this.#deps.acceptMs ?? ACCEPT_MS;
  }

  #startIdle(machine: Machine, mux: Mux): void {
    this.#stopIdle(machine);
    machine.idle = setTimeout(async () => {
      machine.idle = null;
      if (mux.closed || mux.channels) return;
      const keep = await this.#deps.keep(machine.hostId).catch((error) => {
        this.#deps.logError("docker relay", error);
        return true;
      });
      if (keep) this.#startIdle(machine, mux);
      else if (!mux.channels) mux.close("no box or connection used it for a while");
    }, this.#deps.idleMs ?? IDLE_MS);
    machine.idle.unref?.();
  }

  #stopIdle(machine: Machine): void {
    if (machine.idle) clearTimeout(machine.idle);
    machine.idle = null;
  }
}
