const MOST_KEPT_END = 9;
export const ELLIPSIS = "…";

export function keptEnd(text: string): number {
  return Math.min(MOST_KEPT_END, Math.floor(text.length / 2));
}

export function middleParts(text: string): { head: string; tail: string } {
  const end = keptEnd(text);
  return { head: text.slice(0, text.length - end), tail: text.slice(text.length - end) };
}

export function fitMiddle(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const { head, tail } = middleParts(text);
  let shortest = 0;
  let longest = head.length - 1;
  let best = `${ELLIPSIS}${tail}`;
  while (shortest <= longest) {
    const keep = Math.floor((shortest + longest) / 2);
    const candidate = `${head.slice(0, keep)}${ELLIPSIS}${tail}`;
    if (fits(candidate)) {
      best = candidate;
      shortest = keep + 1;
    } else {
      longest = keep - 1;
    }
  }
  return best;
}
