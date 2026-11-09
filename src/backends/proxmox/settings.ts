// The settings the Proxmox backends share, parsed the same way for each: the
// API connection, the VMID range and the static address fixed to each VMID,
// SSH, and what the node keeps free. Each backend names its own keys.
//
// Each VMID in the range has a fixed address: the n-th VMID gets the n-th
// address. Proxmox refuses a second guest with the same VMID, so two boxes
// never share an address and no address is stored or leased.

import { normalisePrivateKey } from "../../transports/ssh.ts";
import type { Footprint } from "../types.ts";
import { PRODUCT } from "../../brand.ts";


export interface ProxmoxConnection {
  readonly apiUrl: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly caCertificate: string | null;
  /** SHA-256 of the API's certificate, as AA:BB:..., pinned instead of checking its CA. */
  readonly tlsFingerprint: string | null;
  /** Null means the API's only node. */
  readonly node: string | null;
  readonly pool: string;
}

export interface ProxmoxNetwork {
  readonly bridge: string;
  readonly prefix: number;
  readonly gateway: string;
  /** Address of the n-th VMID in the range. */
  readonly addresses: readonly string[];
}

export interface VmidRange {
  readonly first: number;
  readonly last: number;
}

/** A backend's keys for the shared settings. */
export interface ProxmoxKeys {
  readonly url: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tlsFingerprint: string;
  readonly caCertificate: string;
  readonly node: string;
  readonly pool: string;
  readonly vmidFirst: string;
  readonly vmidLast: string;
  readonly bridge: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly addresses: string;
  readonly sshPrivateKey: string;
  readonly sshUser: string;
  readonly reserveMemoryMiB: string;
  readonly reserveDiskGiB: string;
}

export interface ProxmoxDefaults {
  readonly pool: string;
  readonly vmidFirst: number;
  readonly vmidLast: number;
  readonly bridge: string;
  readonly subnet: string;
  readonly gateway: string;
  readonly addresses: string;
  readonly sshUser: string;
  readonly reserveMemoryMiB: number;
  readonly reserveDiskGiB: number;
}

type Values = Readonly<Record<string, unknown>>;

/** Adds a problem with the setting at `key`. */
export type Problem = (key: string, message: string) => void;

export function parseIpv4(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result;
}

export function formatIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/** A SHA-256 fingerprint as AA:BB:..., from hex with or without colons, or null. */
export function normaliseFingerprint(value: string): string | null {
  const hex = value.trim().replace(/^sha256[:=]?\s*/i, "").replace(/[:\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g)!.join(":");
}

/** A string setting, or `fallback` when the key is absent. An empty string stays empty. */
export function text(values: Values, key: string, fallback = ""): string {
  const value = values[key];
  if (value === undefined || value === null) return fallback;
  return typeof value === "string" ? value.trim() : "";
}

export function number(values: Values, key: string, fallback: number): number {
  const value = values[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

export function wholeInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function checkConnection(values: Values, keys: ProxmoxKeys, defaults: ProxmoxDefaults, problem: Problem): ProxmoxConnection {
  // The setup guide's token file gives the URL with /api2/json, which the client adds itself.
  const apiUrl = text(values, keys.url).replace(/\/+$/, "").replace(/\/api2\/json$/, "");
  if (!apiUrl) problem(keys.url, "Set the Proxmox API URL.");
  else {
    try {
      const url = new URL(apiUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
      if (url.username || url.password) problem(keys.url, "Remove credentials from the Proxmox API URL.");
    } catch {
      problem(keys.url, "Use an https URL for the Proxmox API, for example https://pve.example.com:8006.");
    }
  }
  const tokenId = text(values, keys.tokenId);
  if (!tokenId) problem(keys.tokenId, "Set the Proxmox API token ID.");
  else if (!/^[^\s@!=]+@[^\s@!=]+![^\s@!=]+$/.test(tokenId)) problem(keys.tokenId, "Use a token ID like bbbox@pve!plugin.");
  const tokenSecret = text(values, keys.tokenSecret);
  if (!tokenSecret) problem(keys.tokenSecret, "Set the Proxmox API token secret.");
  const fingerprintText = text(values, keys.tlsFingerprint);
  const tlsFingerprint = fingerprintText ? normaliseFingerprint(fingerprintText) : null;
  if (fingerprintText && !tlsFingerprint) problem(keys.tlsFingerprint, "Use a SHA-256 fingerprint like AB:CD:..., with 32 pairs of hex digits.");
  const caCertificate = text(values, keys.caCertificate) || null;
  if (caCertificate && !caCertificate.includes("-----BEGIN CERTIFICATE-----")) {
    problem(keys.caCertificate, "Use a PEM certificate for the Proxmox CA, or leave it empty.");
  }
  const node = text(values, keys.node) || null;
  if (node && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(node)) problem(keys.node, "Use the node's name as Proxmox shows it.");
  const pool = text(values, keys.pool, defaults.pool);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(pool)) problem(keys.pool, "Use a Proxmox pool name such as bbbox.");
  return { apiUrl, tokenId, tokenSecret, caCertificate, tlsFingerprint, node, pool };
}

/** The VMID range, which must leave out every template in `templates`. */
export function checkVmids(values: Values, keys: ProxmoxKeys, defaults: ProxmoxDefaults, templates: readonly number[], problem: Problem): VmidRange {
  const first = number(values, keys.vmidFirst, defaults.vmidFirst);
  const last = number(values, keys.vmidLast, defaults.vmidLast);
  if (!wholeInRange(first, 100, 999_999_999) || !wholeInRange(last, first, 999_999_999)) {
    problem(wholeInRange(first, 100, 999_999_999) ? keys.vmidLast : keys.vmidFirst, "Use a VMID range from 100 whose last VMID is not below its first.");
  }
  for (const vmid of new Set(templates)) {
    if (vmid >= first && vmid <= last) problem(keys.vmidFirst, `Move template ${vmid} out of the box VMID range.`);
  }
  return { first, last };
}

/** The bridge, subnet and gateway, and an address for each VMID in `vmids`. */
export function checkNetwork(values: Values, keys: ProxmoxKeys, defaults: ProxmoxDefaults, vmids: VmidRange, problem: Problem): ProxmoxNetwork {
  const { first, last } = vmids;
  const bridge = text(values, keys.bridge, defaults.bridge);
  if (!bridge) problem(keys.bridge, "Set the network bridge.");
  else if (!/^[A-Za-z0-9_.-]{1,15}$/.test(bridge)) problem(keys.bridge, "Use a Linux bridge name such as vmbr1.");
  const [networkText = "", prefixText = ""] = text(values, keys.subnet, defaults.subnet).split("/");
  const network = parseIpv4(networkText);
  const prefix = Number(prefixText);
  const gatewayText = text(values, keys.gateway, defaults.gateway);
  const gateway = parseIpv4(gatewayText);
  const addresses: string[] = [];
  if (network === null || !wholeInRange(prefix, 8, 30)) {
    problem(keys.subnet, "Set the subnet in CIDR form, for example 10.10.10.0/24.");
  } else if (gateway === null) {
    problem(keys.gateway, "Set the gateway address, for example 10.10.10.1.");
  } else {
    const size = 2 ** (32 - prefix);
    const base = network - (network % size);
    const broadcast = base + size - 1;
    if (gateway <= base || gateway >= broadcast) problem(keys.gateway, "Put the gateway inside the subnet.");
    let low = base + 1;
    let high = broadcast - 1;
    const range = text(values, keys.addresses, defaults.addresses);
    if (range) {
      const [from, to] = range.split("-").map((part) => parseIpv4(part));
      if (from == null || to == null || from > to) {
        problem(keys.addresses, "Use a box address range like 10.10.10.100-10.10.10.199.");
      } else if (from < low || to > high) {
        problem(keys.addresses, "Keep the box address range inside the subnet.");
      } else {
        low = from;
        high = to;
      }
    }
    const count = Number.isInteger(first) && Number.isInteger(last) ? last - first + 1 : 0;
    for (let address = low; address <= high && addresses.length < count; address++) {
      if (address !== gateway) addresses.push(formatIpv4(address));
    }
    if (count > 0 && addresses.length < count) {
      problem(keys.addresses, `The box address range has ${addresses.length} addresses for ${count} VMIDs. Widen it or narrow the VMID range.`);
    }
  }
  return { bridge, prefix, gateway: gatewayText, addresses };
}

/** A null key means bb-box generates one and shows its public key. */
export function checkSsh(values: Values, keys: ProxmoxKeys, defaults: ProxmoxDefaults, problem: Problem): { privateKey: string | null; user: string } {
  const keyText = text(values, keys.sshPrivateKey);
  const privateKey = keyText ? normalisePrivateKey(keyText) : null;
  if (keyText && !privateKey) problem(keys.sshPrivateKey, `Use an unencrypted OpenSSH private key, or leave it empty for ${PRODUCT} to make one.`);
  const user = text(values, keys.sshUser) || defaults.sshUser;
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) problem(keys.sshUser, "Use a Linux user name for SSH.");
  return { privateKey, user };
}

export function checkReserve(values: Values, keys: ProxmoxKeys, defaults: ProxmoxDefaults, problem: Problem): { memoryMiB: number; diskGiB: number } {
  const memoryMiB = number(values, keys.reserveMemoryMiB, defaults.reserveMemoryMiB);
  const diskGiB = number(values, keys.reserveDiskGiB, defaults.reserveDiskGiB);
  if (!wholeInRange(memoryMiB, 0, 16_777_216)) problem(keys.reserveMemoryMiB, "Keep 0 MiB or more of memory free.");
  if (!wholeInRange(diskGiB, 0, 1_048_576)) problem(keys.reserveDiskGiB, "Keep 0 GiB or more of disk free.");
  return { memoryMiB, diskGiB };
}

/** The address fixed to `vmid`, or null outside the range. */
export function addressFor(config: { readonly vmids: VmidRange; readonly network: ProxmoxNetwork }, vmid: number): string | null {
  return config.network.addresses[vmid - config.vmids.first] ?? null;
}

/**
 * A Proxmox backend's VMIDs, which are unique in a cluster, and the
 * addresses of its boxes, on its node's bridge.
 */
export function proxmoxFootprint(config: { readonly proxmox: ProxmoxConnection; readonly vmids: VmidRange; readonly network: ProxmoxNetwork }): Footprint {
  const { apiUrl, node } = config.proxmox;
  const count = config.vmids.last - config.vmids.first + 1;
  return {
    ids: { scope: `proxmox ${apiUrl}`, first: config.vmids.first, last: config.vmids.last },
    addresses: { scope: `proxmox ${apiUrl} ${node ?? ""} ${config.network.bridge}`, list: config.network.addresses.slice(0, count) },
  };
}
