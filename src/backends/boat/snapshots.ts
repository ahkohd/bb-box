import { endOfUtcDay } from "../../core/snapshot.ts";
import type { BoxOwner, HeldSnapshot, HeldSnapshotState, Price, SnapshotBill, SnapshotStorage, Snapshotting } from "../types.ts";
import { isTrial, perWindow, type BoatLimits, type SavedAllowance, type SavedSnapshot, type StartWindow } from "./api.ts";

export const SAVED_DAY_DOLLARS = 0.056;
export const SAVE_RUNNING_ABOUT_MS = 60_000;
export const SAVE_STOPPED_ABOUT_MS = 10_000;
export const SAVE_WAIT_MS = 15 * 60_000;
export const SAVE_POLL_MS = 2_000;
export const BOAT_EXCLUDES = "/tmp, ~/.cache, the build cache, the hostname, the address and the SSH host keys";
export const BOAT_FORK_SAFE_FROM = 8;
export const SAVED_FACTS_KEY = "saved-snapshot-facts";
export const TRIAL_NO_SAVED = "boat's free trial has no saved snapshots, so bb-box takes, restores and keeps no snapshot of a boat box there. A payment in boat's dashboard ends the trial";
export const PLAN_UNREAD = "bb-box does not recognise boat's plan as a paid plan with saved snapshots, and a saved snapshot can cost money, so it takes none there";

const SAVED_NAME = /^([a-z0-9][a-z0-9-]*)-(bx[a-z2-7]{12})-(sn[a-z2-7]{12})$/;

export function savedName(install: string, box: string, snapshot: string): string {
  return `${install}-${box}-${snapshot}`;
}

export function parseSavedName(name: string): { readonly install: string; readonly box: string; readonly snapshot: string } | null {
  const found = SAVED_NAME.exec(name);
  return found ? { install: found[1]!, box: found[2]!, snapshot: found[3]! } : null;
}

export function savedPrice(limits: BoatLimits | null, allowance: SavedAllowance | null): Price {
  const amount = limits?.savedSnapshotDayDollars ?? allowance?.dailyEach ?? SAVED_DAY_DOLLARS;
  return { amount, currency: "USD", per: "day", known: true, ...(allowance ? { included: allowance.included } : {}) };
}

export function boatOffer(limits: BoatLimits | null, allowance: SavedAllowance | null): Snapshotting {
  const trial = limits !== null && isTrial(limits);
  return {
    scope: "box",
    holds: ["disk"],
    whileRunning: "live",
    restore: trial ? "none" : "new-guest",
    fork: trial ? "none" : "copy",
    forkSafeFrom: BOAT_FORK_SAFE_FROM,
    keepsPastRelease: trial ? "no" : "as-is",
    lives: "provider",
    price: trial ? null : savedPrice(limits, allowance),
    excludes: BOAT_EXCLUDES,
    ...(trial ? { forkWhy: TRIAL_NO_SAVED } : {}),
  };
}

export function billOf(allowance: SavedAllowance, refs: readonly string[]): SnapshotBill {
  return { currency: "USD", included: allowance.included, used: allowance.used, dailyEach: allowance.dailyEach, refs };
}

export function savedRefusal(limits: BoatLimits): string | null {
  if (isTrial(limits)) return `${TRIAL_NO_SAVED}.`;
  if (!limits.savedSnapshots) return `${PLAN_UNREAD}: its limits say tier ${limits.tier}, plan ${limits.planKey ?? "none"}.`;
  return null;
}

export const RESTORE_STARTS = 2;
export const RESTORE_STARTS_HELD = 3;
export const FORK_STARTS = 2;

function windowWords(window: string): string {
  return window === "hour" ? "this hour" : window === "day" ? "today" : "this minute";
}

export function startsAvailable(window: StartWindow): number {
  const used = window.limit - window.remaining;
  return Math.max(window.remaining, (window.withWallet ?? window.limit) - used);
}

export function startCostWords(limits: BoatLimits): { readonly ok: boolean; readonly words: string } {
  const tight = [...limits.starts].sort((a, b) => a.remaining - b.remaining)[0] ?? null;
  const left = tight ? `${tight.remaining} of ${tight.limit} left ${windowWords(tight.window)}` : null;
  if (!tight || tight.remaining >= RESTORE_STARTS_HELD) return { ok: true, words: `boat.dev counts ${RESTORE_STARTS} sandbox starts for this: free within your plan's starts${left ? `, ${left}` : ""}` };
  const short = [...limits.starts].sort((a, b) => startsAvailable(a) - startsAvailable(b))[0]!;
  if (startsAvailable(short) < RESTORE_STARTS_HELD) {
    const paid = short.withWallet !== null && short.withWallet > short.limit ? `, and ${Math.max(0, startsAvailable(short) - short.remaining)} paid from the wallet beyond them` : ", and no paid starts beyond them now";
    return {
      ok: false,
      words: `A restore needs ${RESTORE_STARTS_HELD} of boat.dev's sandbox starts: ${RESTORE_STARTS} to make the box's new sandbox, and 1 to start its old one again if that fails. boat.dev allows ${short.limit} ${perWindow(short.window)}, with ${short.remaining} left${paid}. Try again when the ${short.window} is over`,
    };
  }
  const paid = Math.max(0, RESTORE_STARTS - tight.remaining);
  const price = limits.paidStartDollars ?? (limits.nextStartDollars || null);
  return { ok: true, words: `boat.dev counts ${RESTORE_STARTS} sandbox starts for this, past your plan's free starts (${left}): ${paid ? `${paid === 1 ? "1 of them is" : `${paid} of them are`} paid from the wallet` : "the start that may put the box back is paid from the wallet"}${price ? `, about $${price} each` : ""}` };
}

export function forkStartWords(limits: BoatLimits): { readonly ok: boolean; readonly words: string } {
  const tight = [...limits.starts].sort((a, b) => a.remaining - b.remaining)[0] ?? null;
  const left = tight ? `${tight.remaining} of ${tight.limit} left ${windowWords(tight.window)}` : null;
  if (!tight || tight.remaining >= FORK_STARTS) return { ok: true, words: `boat.dev counts ${FORK_STARTS} sandbox starts for this: free within your plan's starts${left ? `, ${left}` : ""}` };
  const short = [...limits.starts].sort((a, b) => startsAvailable(a) - startsAvailable(b))[0]!;
  if (startsAvailable(short) < FORK_STARTS) {
    return { ok: false, words: `A fork needs ${FORK_STARTS} of boat.dev's sandbox starts, to make the fork's sandbox from the saved snapshot. boat.dev allows ${short.limit} ${perWindow(short.window)}, with ${short.remaining} left, and no paid starts beyond them now. Try again when the ${short.window} is over` };
  }
  const paid = FORK_STARTS - tight.remaining;
  const price = limits.paidStartDollars ?? (limits.nextStartDollars || null);
  return { ok: true, words: `boat.dev counts ${FORK_STARTS} sandbox starts for this, past your plan's free starts (${left}): ${paid === 1 ? "1 of them is" : `${paid} of them are`} paid from the wallet${price ? `, about $${price} each` : ""}` };
}

export interface SavedFacts {
  readonly kept: string | null;
  readonly forkSafe: number | null;
  readonly owner: BoxOwner | null;
}

export type SavedFactsByName = Readonly<Record<string, SavedFacts>>;

const NO_FACTS: SavedFacts = { kept: null, forkSafe: null, owner: null };

export function factsWith(facts: SavedFactsByName, name: string, change: Partial<SavedFacts> | null): SavedFactsByName {
  const next: Record<string, SavedFacts> = { ...facts };
  if (change === null) delete next[name];
  else next[name] = { ...(facts[name] ?? NO_FACTS), ...change };
  return next;
}

export const BOAT_STORAGE: SnapshotStorage = {
  key: "boat.dev:saved",
  name: "boat.dev's saved snapshots",
  type: "saved snapshots",
  percentFull: 0,
  metadataPercentFull: null,
  metadataUnread: null,
  totalBytes: null,
  usedBytes: null,
};

export function heldStateOf(saved: Pick<SavedSnapshot, "status" | "error">): { readonly state: HeldSnapshotState; readonly words: string | null } {
  if (saved.status === "ready") return { state: "complete", words: null };
  if (saved.status === "saving") return { state: "in-progress", words: null };
  return { state: "incomplete", words: `boat could not save it${saved.error ? `: ${saved.error}` : ""}` };
}

export function heldFrom(saved: SavedSnapshot, box: string, snapshot: string, guest: HeldSnapshot["guest"], owner: HeldSnapshot["owner"], facts: SavedFacts | null = null): HeldSnapshot {
  const kept = facts?.kept ?? null;
  const { state, words } = heldStateOf(saved);
  return {
    id: snapshot,
    ref: saved.name,
    box,
    owner,
    guest,
    where: "current",
    state,
    words,
    holds: "disk",
    takenAt: saved.createdAt,
    keptUntil: kept ? endOfUtcDay(kept) : null,
    storage: { name: BOAT_STORAGE.name, type: BOAT_STORAGE.type },
    forkSafe: facts?.forkSafe ?? null,
  };
}
