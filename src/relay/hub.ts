// The server's end of the Docker API relay (042), and of the msb relay
// (053), which is the same with another route and host call. For each BB
// machine that is a Docker host, bb-box listens on a unix socket that only
// BB's user can use, and the docker CLI takes it as the host; for an msb
// host, bb-box's msb client connects to it. Each connection to it is a
// channel on one WebSocket for the machine, which the machine's worker opens
// out to bb-box's route with a one-time secret that a host call gives it.
// The relay opens when a connection needs it, and closes after IDLE_MS with
// no channel open, unless bb-box still has a box on the machine.

import { randomBytes } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { makeTempFolderSync } from "../core/temp-folders.ts";
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
/**
 * How long after its relay was lost, or bb-box started, a machine's relay
 * counts as coming back (#415). At a deploy, BB stops the machine's worker,
 * and bb-box's relay with it, and the new instance's first relay opens once
 * BB has started the worker again: about 30 s (7 October 2026).
 */
export const REOPEN_MS = 2 * 60_000;

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
  /** What the relay carries, for its messages: "Docker" by default, or "msb". */
  readonly what?: string;
  /**
   * Answers a connection that the relay cannot carry, with the reason, in
   * what the client reads: by default an HTTP error, which the docker CLI
   * shows as "Error response from daemon".
   */
  readonly refuse?: (socket: Socket, reason: string) => void;
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
  /** Each machine's open relay, the machines whose relay has opened, and when one was last lost or failed to open (#415). */
  readonly #current = new Map<string, Mux>();
  readonly #everOpened = new Set<string>();
  readonly #lostAt = new Map<string, number>();
  readonly #startedAt = Date.now();
  readonly #what: string;
  readonly #refuse: (socket: Socket, reason: string) => void;

  constructor(deps: RelayHubDeps) {
    this.#deps = deps;
    this.#what = deps.what ?? "Docker";
    this.#refuse = deps.refuse ?? refuse;
    this.#ownDir = !deps.dir;
    this.#dir = deps.dir ?? makeTempFolderSync("bb-box-relay-");
    chmodSync(this.#dir, 0o700);
  }

  /** The docker CLI's host for machine `hostId`, the same each time. It listens once `endpoint` resolves. */
  address(hostId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(hostId)) throw new Error(`"${hostId}" is not a BB machine ID.`);
    return `unix://${join(this.#dir, `${hostId}.sock`)}`;
  }

  /** The docker CLI's host for machine `hostId`, listening once this resolves. */
  async endpoint(hostId: string): Promise<string> {
    if (this.#disposed) throw new Error(`The ${this.#what} relay has stopped.`);
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
              // An older relay can end after a newer one opened: only the machine's current one is lost.
              const current = this.#current.get(pending.hostId) === mux;
              if (current) {
                this.#current.delete(pending.hostId);
                this.#lostAt.set(pending.hostId, Date.now());
              }
              const machine = this.#machines.get(pending.hostId);
              if (machine && current) {
                machine.relay = null;
                this.#stopIdle(machine);
              }
              this.#deps.log?.(`The ${this.#what} relay to BB machine ${pending.hostId} closed: ${reason}.`);
            },
          },
        );
        this.#current.set(pending.hostId, mux);
        this.#everOpened.add(pending.hostId);
        pending.resolve(mux);
      },
      onMessage: (_socket: RelaySocket, data: string | Uint8Array) => {
        if (typeof data !== "string") mux?.receive(data);
      },
      onClose: () => mux?.close("the machine's side closed"),
      onError: (_socket: RelaySocket, error: Error) => this.#deps.logError(`${this.#what.toLowerCase()} relay`, error),
    };
  }

  /**
   * Ends the machine's relay, as when BB says its worker exited, so the next
   * connection finds out at once rather than when the pings stop.
   */
  /**
   * Whether the relay to a machine is coming back (#415): none is open, and
   * the last was lost or failed to open, or bb-box started with none yet, less
   * than REOPEN_MS ago, as at a deploy. A box there that does not answer
   * then is to be waited for, not released.
   */
  reopening(hostId: string, now = Date.now()): boolean {
    if (this.#current.has(hostId)) return false;
    const since = Math.max(this.#lostAt.get(hostId) ?? 0, this.#everOpened.has(hostId) ? 0 : this.#startedAt);
    return since > 0 && now - since < REOPEN_MS;
  }

  drop(hostId: string, reason: string): Promise<void> {
    const relay = this.#machines.get(hostId)?.relay;
    if (!relay) return Promise.resolve();
    return relay.then(
      (mux) => {
        mux.close(reason);
      },
      () => {},
    );
  }

  /** Closes the machine's relay and socket, as when it is no longer a Docker or msb host. */
  async forget(hostId: string): Promise<void> {
    const machine = this.#machines.get(hostId);
    if (!machine) return;
    this.#machines.delete(hostId);
    this.#stopIdle(machine);
    (await machine.relay?.catch(() => null))?.close(`bb-box no longer uses this machine for ${this.#what}`);
    for (const socket of machine.sockets) socket.destroy();
    await new Promise<void>((resolve) => machine.server.close(() => resolve()));
    rmSync(machine.path, { force: true });
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const pending of this.#pending.values()) pending.reject(new Error(`The ${this.#what} relay has stopped.`));
    this.#pending.clear();
    if (this.#ownDir) rmSync(this.#dir, { recursive: true, force: true });
    await Promise.all([...this.#machines.keys()].map((hostId) => this.forget(hostId)));
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
          this.#refuse(socket, message(error));
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
          this.#deps.log?.(`${this.#what} on BB machine ${machine.hostId} did not answer: ${error.message}`);
          this.#refuse(socket, error.message);
        });
      },
      (error) => this.#refuse(socket, message(error)),
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
      this.#lostAt.set(machine.hostId, Date.now());
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
    this.#deps.log?.(`Opened the ${this.#what} relay to BB machine ${hostId}.`);
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
        this.#deps.logError(`${this.#what.toLowerCase()} relay`, error);
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
