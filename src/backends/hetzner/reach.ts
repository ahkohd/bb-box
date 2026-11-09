import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tailnetHostname, type Tailnet } from "../../core/tailnet.ts";
import { makeTempFolderSync, shortTempBase } from "../../core/temp-folders.ts";
import { KeyFile } from "../../transports/ssh.ts";
import { timedSpawn } from "../../transports/spawns.ts";
import { DockerCli } from "../docker/cli.ts";
import type { BackendStorage } from "../types.ts";
import { HetznerError, type FirewallRule, type Hetzner, type Labels } from "./api.ts";
import type { HostRecord } from "./hosts.ts";
import { storedKeyPair } from "../ssh-key.ts";
import { PRODUCT } from "../../brand.ts";

export const TAILSCALE_DIRECT_PORT = "41641";
const SSH_KEY = "ssh-key";
const FORWARD_UP_WITHIN_MS = 20_000;
const FORWARD_POLL_MS = 100;

export type HostAddress = { readonly address: string; readonly via: "tailnet" | "internet" };

export interface HostReachOptions {
  readonly api: Hetzner;
  readonly storage: BackendStorage;
  readonly installId: string;
  readonly tailnet: () => Tailnet | null;
  readonly sshFrom: readonly string[];
  readonly sshBinary?: string;
  readonly dockerBinary?: string;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function firewallRules(tailnetOn: boolean, sshFrom: readonly string[]): FirewallRule[] {
  const rules: FirewallRule[] = [
    { direction: "in", protocol: "udp", port: TAILSCALE_DIRECT_PORT, sourceIps: ["0.0.0.0/0", "::/0"], description: "Tailscale's direct connections" },
    { direction: "in", protocol: "icmp", sourceIps: ["0.0.0.0/0", "::/0"], description: "ping" },
  ];
  if (!tailnetOn && sshFrom.length) rules.push({ direction: "in", protocol: "tcp", port: "22", sourceIps: [...sshFrom], description: "SSH from BB's server" });
  return rules;
}

function sshOptions(input: { keyPath: string; knownHostsPath: string }): string[] {
  return [
    "-i", input.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${input.knownHostsPath}`,
    "-o", "ConnectTimeout=10",
  ];
}

function rootAt(address: string): string {
  return `root@${address.includes(":") ? `[${address}]` : address}`;
}

export function scriptArgs(input: { keyPath: string; knownHostsPath: string; address: string }): string[] {
  return [...sshOptions(input), rootAt(input.address), "bash -s"];
}

export function forwardArgs(input: { keyPath: string; knownHostsPath: string; socket: string; address: string }): string[] {
  return [
    "-i", input.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${input.knownHostsPath}`,
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "StreamLocalBindUnlink=yes",
    "-N",
    "-L", `${input.socket}:/var/run/docker.sock`,
    `root@${input.address.includes(":") ? `[${input.address}]` : input.address}`,
  ];
}

interface Forward {
  readonly child: ChildProcess;
  readonly socket: string;
  readonly address: string;
  exited: string | null;
}

export class HostReach {
  readonly #options: HostReachOptions;
  readonly #keyFile = new KeyFile();
  readonly #forwards = new Map<string, Forward>();
  readonly #starting = new Map<string, Promise<void>>();
  readonly #socketDir: string;
  #keys: Promise<{ privateKey: string; publicKey: string; keyPath: string }> | null = null;

  constructor(options: HostReachOptions) {
    this.#options = options;
    this.#socketDir = makeTempFolderSync("bb-box-hz-", shortTempBase());
  }

  get labels(): Labels {
    return { "bbbox-install": this.#options.installId };
  }

  get resourceName(): string {
    return `bb-box-${this.#options.installId}`;
  }

  async keys(): Promise<{ privateKey: string; publicKey: string; keyPath: string }> {
    this.#keys ??= (async () => {
      const stored = await storedKeyPair(this.#options.storage, SSH_KEY);
      return { ...stored, keyPath: await this.#keyFile.path(stored.privateKey) };
    })();
    this.#keys.catch(() => (this.#keys = null));
    return this.#keys;
  }

  async hetznerSshKeyId(signal?: AbortSignal): Promise<number> {
    const { publicKey } = await this.keys();
    const found = (await this.#options.api.sshKeys(this.labels, signal)).find((each) => each.name === this.resourceName);
    if (found) return found.id;
    try {
      return (await this.#options.api.createSshKey({ name: this.resourceName, publicKey, labels: this.labels }, signal)).id;
    } catch (error) {
      if (!(error instanceof HetznerError && error.taken)) throw error;
      const made = (await this.#options.api.sshKeys(this.labels, signal)).find((each) => each.name === this.resourceName);
      if (!made) throw new Error(`Hetzner Cloud has an SSH key named ${this.resourceName} or with ${PRODUCT}'s public key that is not this install's. Delete it in the Console.`);
      return made.id;
    }
  }

  async firewallId(signal?: AbortSignal): Promise<number> {
    const rules = firewallRules(this.#options.tailnet() !== null, this.#options.sshFrom);
    const found = (await this.#options.api.firewalls(this.labels, signal)).find((each) => each.name === this.resourceName);
    if (found) {
      await this.#options.api.setFirewallRules(found.id, rules, signal);
      return found.id;
    }
    try {
      return (await this.#options.api.createFirewall({ name: this.resourceName, labels: this.labels, rules }, signal)).id;
    } catch (error) {
      if (!(error instanceof HetznerError && error.taken)) throw error;
      const made = (await this.#options.api.firewalls(this.labels, signal)).find((each) => each.name === this.resourceName);
      if (!made) throw new Error(`Hetzner Cloud has a firewall named ${this.resourceName} that is not this install's. Delete it in the Console.`);
      return made.id;
    }
  }

  canReach(): string | null {
    if (this.#options.tailnet()) return null;
    if (this.#options.sshFrom.length) return null;
    return `${PRODUCT} reaches a host over the tailnet, which is off, or over the internet from the addresses in SSH from, which is empty. Turn the tailnet on in BB Box's General settings, or set SSH from to BB's server's public address`;
  }

  async address(record: HostRecord, signal?: AbortSignal): Promise<HostAddress> {
    const tailnet = this.#options.tailnet();
    if (tailnet) {
      const name = tailnetHostname(record.serverName);
      const device = (await tailnet.devices(signal)).find((each) => each.hostname === name);
      const address = device?.addresses.find((each) => !each.includes(":")) ?? device?.addresses[0];
      if (!address) throw new Error(`${record.serverName} is not on the tailnet yet.`);
      return { address, via: "tailnet" };
    }
    if (!record.ipv4) throw new Error(`${record.serverName} has no public IPv4 address.`);
    return { address: record.ipv4, via: "internet" };
  }

  cli(record: HostRecord): DockerCli {
    return new DockerCli(`unix://${this.#socketPath(record.hostId)}`, this.#options.dockerBinary, () => this.#forward(record));
  }

  async run(record: HostRecord, script: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    const { keyPath } = await this.keys();
    const { address } = await this.address(record, options.signal);
    const knownHostsPath = join(this.#socketDir, `known_hosts-${record.hostId}`);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
    return new Promise((resolve) => {
      const child = timedSpawn(() => spawn(this.#options.sshBinary ?? "ssh", scriptArgs({ keyPath, knownHostsPath, address }), { stdio: ["pipe", "pipe", "pipe"], signal }), "Hetzner Cloud host's script");
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => (stdout = (stdout + chunk.toString("utf8")).slice(-65_536)));
      child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-65_536)));
      child.on("error", (error) => resolve({ exitCode: null, stdout, stderr: stderr + error.message }));
      child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
      child.stdin?.end(script);
    });
  }

  async forget(hostId: string): Promise<void> {
    const forward = this.#forwards.get(hostId);
    this.#forwards.delete(hostId);
    forward?.child.kill();
    await rm(join(this.#socketDir, `known_hosts-${hostId}`), { force: true });
    await rm(this.#socketPath(hostId), { force: true });
  }

  async dispose(): Promise<void> {
    rmSync(this.#socketDir, { recursive: true, force: true });
    for (const forward of this.#forwards.values()) forward.child.kill();
    this.#forwards.clear();
    await this.#keyFile.dispose();
  }

  #socketPath(hostId: string): string {
    return join(this.#socketDir, `${hostId}.sock`);
  }

  #forward(record: HostRecord): Promise<void> {
    const forward = this.#forwards.get(record.hostId);
    if (forward && forward.exited === null && existsSync(forward.socket)) return Promise.resolve();
    const starting = this.#starting.get(record.hostId);
    if (starting) return starting;
    const started = this.#startForward(record).finally(() => this.#starting.delete(record.hostId));
    this.#starting.set(record.hostId, started);
    return started;
  }

  async #startForward(record: HostRecord): Promise<void> {
    this.#forwards.get(record.hostId)?.child.kill();
    this.#forwards.delete(record.hostId);
    const { keyPath } = await this.keys();
    const { address } = await this.address(record);
    const socket = this.#socketPath(record.hostId);
    await rm(socket, { force: true });
    const knownHostsPath = join(this.#socketDir, `known_hosts-${record.hostId}`);
    const child = timedSpawn(
      () => spawn(this.#options.sshBinary ?? "ssh", forwardArgs({ keyPath, knownHostsPath, socket, address }), { stdio: ["ignore", "ignore", "pipe"] }),
      "Hetzner Cloud host's Docker forward",
    );
    const forward: Forward = { child, socket, address, exited: null };
    let said = "";
    child.stderr?.on("data", (chunk: Buffer) => (said = (said + chunk.toString("utf8")).slice(-2000)));
    child.on("exit", (code, signal) => (forward.exited = said.trim().split("\n").pop() || `ssh exited with ${code ?? signal}`));
    child.on("error", (error) => (forward.exited = error.message));
    this.#forwards.set(record.hostId, forward);
    const sleep = this.#options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let waited = 0; waited < FORWARD_UP_WITHIN_MS; waited += FORWARD_POLL_MS) {
      if (forward.exited !== null) throw new Error(`${PRODUCT} could not reach ${record.serverName} at ${address} over SSH: ${forward.exited}`);
      if (existsSync(socket)) return;
      await sleep(FORWARD_POLL_MS);
    }
    child.kill();
    throw new Error(`${PRODUCT}'s SSH forward to ${record.serverName} at ${address} did not come up within ${FORWARD_UP_WITHIN_MS / 1000} s.`);
  }
}
