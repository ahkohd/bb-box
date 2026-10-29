import type { ThreadOnBox } from "./contract.ts";

const WORKING_STATUSES: ReadonlySet<string> = new Set(["active", "starting", "pending", "stopping"]);

export interface BbThread {
  readonly id: string;
  readonly title?: string | null;
  readonly titleFallback?: string | null;
  readonly status: string;
  readonly hasPendingInteraction?: boolean;
  readonly updatedAt?: unknown;
}

export function threadOnBox(thread: BbThread): ThreadOnBox {
  return {
    id: thread.id,
    title: thread.title ?? thread.titleFallback ?? null,
    running: WORKING_STATUSES.has(thread.status) || thread.hasPendingInteraction === true,
    ...(typeof thread.updatedAt === "number" ? { activeAt: thread.updatedAt } : {}),
  };
}
