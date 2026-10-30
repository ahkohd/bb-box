import type { Price } from "../backends/types.ts";
import { heldByProvider, type SnapshotRecord, type Verdict } from "./snapshot.ts";

export const DAYS_A_MONTH = 30;
const DAY_MS = 24 * 60 * 60_000;

export const CEILING_CHANGES = ["take", "undo", "keep", "renew", "held-copy"] as const;
export type CeilingChange = (typeof CEILING_CHANGES)[number];

export type Currency = Price["currency"];

export interface Charge {
  readonly snapshot: string;
  readonly backend: string;
  readonly currency: Currency;
  readonly daily: number;
  readonly from: number;
  readonly until: number | null;
}

export interface HeldRate {
  readonly currency: Currency | null;
  readonly count: number;
  readonly monthly: number;
  readonly unknown: number;
}

export function dailyPrice(price: Price, bytes: number | null): number | null {
  if (!price.known) return null;
  switch (price.per) {
    case "day":
      return price.amount;
    case "month":
      return price.amount / DAYS_A_MONTH;
    case "GB-month":
      return bytes === null ? null : (price.amount * bytes) / 1e9 / DAYS_A_MONTH;
  }
}

export function monthlyRate(price: Price, bytes: number | null): number | null {
  const daily = dailyPrice(price, bytes);
  return daily === null ? null : daily * DAYS_A_MONTH;
}

function sizeOf(record: Pick<SnapshotRecord, "size">): number | null {
  return record.size?.bytes ?? null;
}

export function heldRate(records: readonly SnapshotRecord[], backendId: string): HeldRate {
  let count = 0;
  let monthly = 0;
  let unknown = 0;
  let currency: Currency | null = null;
  for (const record of records) {
    if (record.backend.id !== backendId || !record.price || !heldByProvider(record)) continue;
    count++;
    currency ??= record.price.currency;
    const rate = monthlyRate(record.price, sizeOf(record));
    if (rate === null) unknown++;
    else monthly += rate;
  }
  return { currency, count, monthly, unknown };
}

export function chargeOf(record: SnapshotRecord, from: number): Charge | null {
  if (!record.price) return null;
  const daily = dailyPrice(record.price, sizeOf(record));
  if (daily === null) return null;
  return { snapshot: record.id, backend: record.backend.id, currency: record.price.currency, daily, from, until: null };
}

export function monthStart(now: number): number {
  const at = new Date(now);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1);
}

export function spentThisMonth(charges: readonly Charge[], now: number): number {
  const start = monthStart(now);
  let spent = 0;
  for (const charge of charges) {
    const from = Math.max(charge.from, start);
    const until = Math.min(charge.until ?? now, now);
    if (until > from) spent += (charge.daily * (until - from)) / DAY_MS;
  }
  return spent;
}

function cents(amount: number): number {
  return Math.round(amount * 100);
}

export function moneyWords(amount: number, currency: Currency | null): string {
  const figure = (cents(amount) / 100).toFixed(2);
  return currency === "EUR" ? `EUR ${figure}` : `$${figure}`;
}

const ONLY_YOU_CAN: Readonly<Record<CeilingChange, string>> = {
  take: "take one",
  undo: "take an undo",
  keep: "keep one",
  renew: "renew one",
  "held-copy": "make a held copy",
};

export interface CeilingInput {
  readonly change: CeilingChange;
  readonly backend: string;
  readonly held: HeldRate;
  readonly price: Price | null;
  readonly bytes: number | null;
  readonly ceiling: number;
  readonly byPerson: boolean;
}

const RAISE_IT = "Delete one, or raise the ceiling in Settings, Snapshots, Paid snapshots.";

export function ceilingVerdict(input: CeilingInput): Verdict {
  if (!input.price) return { ok: true };
  const addsNothing = input.change === "keep" || input.change === "renew";
  const adds = addsNothing ? 0 : monthlyRate(input.price, input.bytes);
  if (adds === null) {
    if (input.byPerson) return { ok: true };
    return { ok: false, why: `bb-box does not know what a snapshot on ${input.backend} costs, so only you can ${ONLY_YOU_CAN[input.change]} there.` };
  }
  const currency = input.held.currency ?? input.price.currency;
  const after = input.held.monthly + adds;
  if (cents(after) <= cents(input.ceiling)) return { ok: true };
  const ceiling = moneyWords(input.ceiling, currency);
  if (addsNothing) {
    return { ok: false, why: `Snapshots held on ${input.backend} cost about ${moneyWords(input.held.monthly, currency)} a month, past your ceiling of ${ceiling}, so bb-box does not ${input.change} a paid snapshot there. ${RAISE_IT}` };
  }
  return { ok: false, why: `It would bring snapshots held on ${input.backend} to about ${moneyWords(after, currency)} a month, past your ceiling of ${ceiling}. ${RAISE_IT}` };
}

export function pastCeiling(held: HeldRate, ceiling: number): boolean {
  return cents(held.monthly) > cents(ceiling);
}
