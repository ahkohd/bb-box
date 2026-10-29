export const PASTE_LOG_PREDICATE = '(subsystem == "com.apple.Pasteboard" AND eventMessage CONTAINS "is requesting item") OR (process == "SpringBoard" AND eventMessage CONTAINS "deferFromSBWindowScene")';
export const PASTE_NOTICE_SCENE = "com.apple.DragUI";
const READERS_OTHER_THAN_THE_APP = new Set(["(null)", "com.apple.InputUI"]);

export const PASTE_WATCH_MS = { listening: 2_000, read: 5_000, noticeAfterRead: 1_500, noticeShown: 6_000, noticeSettled: 100, recheck: 25 } as const;
export type PasteWatchTimings = { readonly [Key in keyof typeof PASTE_WATCH_MS]: number };

export type PasteLogEvent = { readonly is: "listening" } | { readonly is: "read"; readonly reader: string } | { readonly is: "notice shown" } | { readonly is: "notice hidden" };

export function pasteLogEvent(line: string): PasteLogEvent | null {
  if (line.startsWith("Filtering the log data")) return { is: "listening" };
  const reader = /Bundle ID (\S+) from team \S+ is requesting item/.exec(line)?.[1];
  if (reader) return READERS_OTHER_THAN_THE_APP.has(reader) ? null : { is: "read", reader };
  if (!line.includes("deferFromSBWindowScene") || !line.includes(PASTE_NOTICE_SCENE)) return null;
  if (line.includes("adding rule for")) return { is: "notice shown" };
  if (line.includes("invalidate for")) return { is: "notice hidden" };
  return null;
}

export type PasteRead = { readonly watched: true; readonly reader: string | null } | { readonly watched: false };
export type NoticeOutcome = "gone" | "none" | "still shown" | "unwatched";

export class PasteWatch {
  readonly #stop = new AbortController();
  readonly #ms: PasteWatchTimings;
  readonly #now: () => number;
  #listening = false;
  #ended = false;
  #pressedAt: number | null = null;
  #reader: string | null = null;
  #readAt: number | null = null;
  #noticesShown = 0;
  #noticeSeen = false;
  #noticeHiddenAt = 0;
  #changed: (() => void)[] = [];

  constructor(lines: (signal: AbortSignal) => AsyncIterable<string>, options: { readonly ms?: Partial<PasteWatchTimings>; readonly now?: () => number } = {}) {
    this.#ms = { ...PASTE_WATCH_MS, ...options.ms };
    this.#now = options.now ?? (() => performance.now());
    void (async () => {
      try {
        for await (const line of lines(this.#stop.signal)) this.#heard(pasteLogEvent(line));
      } catch {}
      this.#ended = true;
      this.#tell();
    })();
  }

  #heard(event: PasteLogEvent | null): void {
    if (!event) return;
    if (event.is === "listening") this.#listening = true;
    else if (this.#pressedAt === null) return;
    else if (event.is === "read") {
      this.#reader ??= event.reader;
      this.#readAt ??= this.#now();
    } else if (event.is === "notice shown") {
      this.#noticesShown++;
      this.#noticeSeen = true;
    } else {
      this.#noticesShown = Math.max(0, this.#noticesShown - 1);
      this.#noticeHiddenAt = this.#now();
    }
    this.#tell();
  }

  #tell(): void {
    const waiting = this.#changed;
    this.#changed = [];
    for (const wake of waiting) wake();
  }

  async #until(holds: () => boolean, ms: number): Promise<boolean> {
    const deadline = this.#now() + ms;
    while (!holds()) {
      if (this.#ended || this.#now() >= deadline) return holds();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(this.#ms.recheck, Math.max(0, deadline - this.#now())));
        this.#changed.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  async listening(): Promise<boolean> {
    return this.#until(() => this.#listening, this.#ms.listening);
  }

  pressed(): void {
    this.#pressedAt = this.#now();
  }

  async read(): Promise<PasteRead> {
    await this.#until(() => this.#reader !== null, this.#ms.read);
    if (this.#reader === null && (this.#ended || !this.#listening)) return { watched: false };
    return { watched: true, reader: this.#reader };
  }

  async noticeGone(): Promise<NoticeOutcome> {
    if (this.#ended || !this.#listening) return "unwatched";
    const from = this.#readAt ?? this.#pressedAt ?? this.#now();
    const shown = await this.#until(() => this.#noticeSeen, Math.max(0, from + this.#ms.noticeAfterRead - this.#now()));
    if (!shown) return this.#ended ? "unwatched" : "none";
    const gone = await this.#until(() => this.#noticesShown === 0 && this.#now() - this.#noticeHiddenAt >= this.#ms.noticeSettled, this.#ms.noticeShown);
    return gone ? "gone" : this.#ended ? "unwatched" : "still shown";
  }

  close(): void {
    this.#stop.abort();
  }
}
