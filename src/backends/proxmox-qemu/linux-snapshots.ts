import { PRODUCT } from "../../brand.ts";
import type { SnapshotPlan } from "../types.ts";

function newestOnlyUncheckedOnVms(plan: SnapshotPlan): string {
  return `${plan.storage.name} is ZFS, which restores only the newest snapshot, and ${PRODUCT} restores a Linux VM there only once that is checked on one. Take, delete, fork and Keep still work here.`;
}

export function linuxVmSnapshotPlan(plan: SnapshotPlan): SnapshotPlan {
  const restore = plan.restore;
  if (restore.way !== "rollback-newest-only") return plan;
  return {
    ...plan,
    restore: { ...restore, way: "none", why: newestOnlyUncheckedOnVms(plan), undo: "none", undoAboutMs: 0, undoBytes: null },
  };
}
