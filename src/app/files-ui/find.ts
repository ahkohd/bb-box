export interface FindMatch {

  start: number;

  end: number;

  line: number;
}

export interface FindResult {
  matches: FindMatch[];

  truncated: boolean;
}

export const MAX_MATCHES = 5000;

const EMPTY: FindResult = { matches: [], truncated: false };

export function findMatches(
  content: string,
  query: string,
  caseSensitive = false,
): FindResult {
  if (query === "" || content === "") return EMPTY;

  const haystack = caseSensitive ? content : content.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();

  if (haystack.length !== content.length || needle.length !== query.length) {
    return findMatches(content, query, true);
  }

  const matches: FindMatch[] = [];
  let truncated = false;
  let line = 1;
  let scanned = 0;
  let from = 0;

  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) break;
    if (matches.length === MAX_MATCHES) {
      truncated = true;
      break;
    }

    for (let index = scanned; index < start; index += 1) {
      if (content.charCodeAt(index) === 10) line += 1;
    }
    scanned = start;

    matches.push({ start, end: start + query.length, line });

    from = start + query.length;
  }

  return { matches, truncated };
}

export function matchIndexAt(matches: readonly FindMatch[], caret: number): number {
  if (matches.length === 0) return -1;
  const found = matches.findIndex((match) => match.start >= caret);
  return found === -1 ? 0 : found;
}

export function stepMatch(
  current: number,
  total: number,
  direction: 1 | -1,
): number {
  if (total === 0) return -1;
  if (current < 0) return direction === 1 ? 0 : total - 1;
  return (current + direction + total) % total;
}
