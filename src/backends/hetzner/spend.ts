import type { EurosBeforeVat } from "./api.ts";

export interface BilledServer {
  readonly hostId: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number | null;
}

const HOUR_MS = 3_600_000;

export function startOfMonthUtc(atMs: number): number {
  const at = new Date(atMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export function startOfNextMonthUtc(atMs: number): number {
  const at = new Date(atMs);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

export function billedThisMonth(server: BilledServer, price: EurosBeforeVat, nowMs: number): number {
  const from = Math.max(server.startedAtMs, startOfMonthUtc(nowMs));
  const to = Math.min(server.endedAtMs ?? nowMs, nowMs);
  if (to <= from) return 0;
  return Math.min(price.monthly, Math.ceil((to - from) / HOUR_MS) * price.hourly);
}

export function spentThisMonth(servers: readonly BilledServer[], price: EurosBeforeVat, nowMs: number): number {
  return servers.reduce((sum, server) => sum + billedThisMonth(server, price, nowMs), 0);
}

export function oneMoreToMonthEnd(price: EurosBeforeVat, nowMs: number): number {
  return Math.min(price.monthly, Math.ceil((startOfNextMonthUtc(nowMs) - nowMs) / HOUR_MS) * price.hourly);
}

export function serverAndIpv4(prices: { server: EurosBeforeVat; ipv4: EurosBeforeVat }): EurosBeforeVat {
  return { hourly: prices.server.hourly + prices.ipv4.hourly, monthly: prices.server.monthly + prices.ipv4.monthly };
}

export function euros(amount: number): string {
  return `EUR ${amount.toFixed(2)}`;
}
