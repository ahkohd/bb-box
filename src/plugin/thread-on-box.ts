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

export function chosenThreadTitle(thread: { readonly id: string; readonly title?: string | null; readonly titleFallback?: string | null }): string | null {
  const title = thread.title?.trim() ?? "";
  if (title && title !== thread.id) return title;
  const fallback = thread.titleFallback?.trim() ?? "";
  if (fallback && fallback !== thread.id) return fallback;
  return null;
}

export function threadOnBox(thread: BbThread): ThreadOnBox {
  return {
    id: thread.id,
    title: chosenThreadTitle(thread),
    running: WORKING_STATUSES.has(thread.status) || thread.hasPendingInteraction === true,
    ...(typeof thread.updatedAt === "number" ? { activeAt: thread.updatedAt } : {}),
  };
}

export function startedAt(box: { readonly log?: { readonly lastStart: { readonly askedAt: number } | null } | null; readonly readyAt: number | null; readonly createdAt: number }): number {
  return box.log?.lastStart?.askedAt ?? box.readyAt ?? box.createdAt;
}

export function lastActiveAt(threads: readonly ThreadOnBox[], started: number, now: number): number {
  return Math.max(started, ...threads.map((thread) => (thread.running ? now : (thread.activeAt ?? 0))));
}
