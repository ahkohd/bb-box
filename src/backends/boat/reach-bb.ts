import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type BbReach = { readonly from: "tailnet" } | { readonly from: "url"; readonly host: string } | { readonly from: "nowhere"; readonly host: string; readonly why: string } | { readonly from: "unknown" };

const PRIVATE_NAMES = /(^localhost$|\.local$|\.lan$|\.internal$|\.home\.arpa$|\.ts\.net$)/i;

export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a === 0;
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80") || (lower.startsWith("::ffff:") && isPrivateAddress(lower.slice(7)));
  }
  return false;
}

export async function bbReach(bbUrl: string | null, tailnet: boolean, resolve: (host: string) => Promise<readonly string[]> = async (host) => (await lookup(host, { all: true })).map((each) => each.address)): Promise<BbReach> {
  if (tailnet) return { from: "tailnet" };
  if (!bbUrl) return { from: "unknown" };
  let host: string;
  try {
    host = new URL(bbUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return { from: "unknown" };
  }
  if (isIP(host)) return isPrivateAddress(host) ? { from: "nowhere", host, why: `${host} is a private address` } : { from: "url", host };
  if (PRIVATE_NAMES.test(host)) return { from: "nowhere", host, why: `${host} is a name on a private network` };
  const addresses = await resolve(host).catch(() => [] as string[]);
  if (addresses.length && addresses.every(isPrivateAddress)) return { from: "nowhere", host, why: `${host} points at ${addresses.join(" and ")}, on a private network` };
  return { from: "url", host };
}

export function cannotEnrolWords(reach: Extract<BbReach, { from: "nowhere" }>): string {
  return `boat's sandboxes cannot reach BB's server: ${reach.why}. So boat boxes run commands and copy files, but do not become BB machines.`;
}

export const CANNOT_ENROL_FIX = "Turn the tailnet on in BB Box's settings (docs/guide/tailnet.md), so each boat box joins it, or give BB a URL the internet reaches.";
