import type { SaveReceipt } from "./document.ts";

export const RECEIPTS_KEPT_MS = 24 * 60 * 60 * 1000;
export const RECEIPTS_KEPT_AT_LEAST = 100;
export const RECEIPTS_KEPT_AT_MOST = 500;

export interface SentSave {
  readonly firstSentOn: number;
  readonly startedAt: number;
}

export function receiptMayBeGone(save: SentSave, receipts: readonly SaveReceipt[], now: number): boolean {
  if (now - save.startedAt >= RECEIPTS_KEPT_MS) return true;
  const oldest = receipts[0];
  const trimmedPossibly = receipts.length >= RECEIPTS_KEPT_AT_LEAST;
  return trimmedPossibly && oldest !== undefined && oldest.revision > save.firstSentOn + 1;
}
