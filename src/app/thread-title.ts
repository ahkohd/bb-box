const REPLY_PREFIX = /^\s*Replying to this earlier message in the conversation:\s*/i;

export const UNTITLED_THREAD = "Untitled thread";

export const THIS_BOX_THREAD = "this box's thread";

type TitledThread = {
  readonly id?: string;
  readonly title?: string | null;
  readonly running?: boolean;
};

export function threadName(thread: TitledThread): string | null {
  const title = (thread.title ?? "").replace(REPLY_PREFIX, "").replace(/^[\s>"“]+/, "").trim();
  return title || null;
}

export function threadTitle(thread: TitledThread): string {
  return threadName(thread) ?? UNTITLED_THREAD;
}

export function threadInSentence(title: string | null | undefined): string {
  const trimmed = title?.trim();
  if (!trimmed || trimmed === UNTITLED_THREAD || trimmed === THIS_BOX_THREAD) return THIS_BOX_THREAD;
  return trimmed;
}
