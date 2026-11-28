import type { SnapshotScope } from "../backends/types.ts";
import type { RestoreCheck } from "../core/snapshots.ts";
import { describeSize } from "../core/sizes.ts";

export const RESTORE_FORM = "restore";
export const RESTORE_FORM_TIMEOUT_MS = 10 * 60_000;

export interface RestoreFormPayload {
  readonly box: { readonly id: string; readonly name: string };
  readonly snapshot: { readonly id: string; readonly name: string; readonly takenAt: number; readonly holds: string; readonly scope: SnapshotScope };
  readonly undo: { readonly name: string; readonly aboutSeconds: number; readonly heldCopy: boolean };
  readonly asks: "machine" | "settings";
  readonly losses: readonly string[];
  readonly sizeBack: string | null;
  readonly excludes: string | null;
  readonly runsOnIt: boolean;
  readonly changed: boolean;
  readonly plan: string;
  readonly gpuStay: string | null;
  readonly userspaceNote: string | null;
}

export interface RestoreFormAnswer {
  readonly restore: true;
  readonly plan: string;
}

export function restoreFormPayload(check: RestoreCheck, asks: "machine" | "settings", runsOnIt: boolean, changed: boolean): RestoreFormPayload {
  const undo = check.undo!;
  return {
    box: { id: check.box.id, name: check.box.name },
    snapshot: { id: check.snapshot.id, name: check.snapshot.name, takenAt: check.snapshot.takenAt, holds: check.snapshot.holds, scope: check.snapshot.scope },
    undo: { name: undo.name, aboutSeconds: Math.max(1, Math.round(undo.aboutMs / 1000)), heldCopy: undo.kind === "held-copy" },
    asks,
    losses: check.anyway,
    sizeBack: check.from && check.to && describeSize(check.from) !== describeSize(check.to) ? describeSize(check.to) : null,
    excludes: check.snapshot.excludes,
    runsOnIt,
    changed,
    plan: check.plan,
    gpuStay: check.gpuStay,
    userspaceNote: check.userspaceNote,
  };
}

export function restoreFormTitle(payload: Pick<RestoreFormPayload, "box" | "snapshot">): string {
  return `Restore ${payload.box.name} to "${payload.snapshot.name}"?`;
}

export function isRestoreYes(value: unknown, plan: string): boolean {
  if (!value || typeof value !== "object") return false;
  const answer = value as Partial<RestoreFormAnswer>;
  return answer.restore === true && answer.plan === plan;
}
