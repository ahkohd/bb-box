const MOST_KEPT_END = 9;

export function keptEnd(text: string): number {
  return Math.min(MOST_KEPT_END, Math.floor(text.length / 2));
}

export function middleParts(text: string): { head: string; tail: string } {
  const end = keptEnd(text);
  return { head: text.slice(0, text.length - end), tail: text.slice(text.length - end) };
}
