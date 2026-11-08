import type { FsHit } from "../../core/box-fs.ts";

export interface LineMatch {
  line: number;
  column: number;
  preview: string;
  ranges: Array<[number, number]>;
  clippedStart: boolean;
  clippedEnd: boolean;
}

export interface SearchFile {
  path: string;
  matchCount: number;
  matches: LineMatch[];
}

export type SearchResult =
  | {
      status: "ok";
      files: SearchFile[];
      totalMatches: number;
      searchedFiles: number;
      truncated: boolean;
      reason: "matches" | "files" | "time" | "listing" | null;
      durationMs: number;
      listing: "local" | "remote";
    }
  | { status: "error"; message: string };

export interface MatchFlags {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export function visibleNames(paths: readonly string[], includeHidden: boolean): string[] {
  if (includeHidden) return [...paths];
  return paths.filter((path) => !path.split("/").some((part) => part.startsWith(".")));
}

export function groupHits(hits: readonly FsHit[], truncated: boolean, query: string, flags: MatchFlags): SearchResult {
  const files = new Map<string, SearchFile>();
  for (const hit of hits) {
    const existing = files.get(hit.path);
    const file = existing ?? { path: hit.path, matchCount: 0, matches: [] };
    file.matchCount += 1;
    file.matches.push({
      line: hit.line,
      column: hit.column,
      preview: hit.preview,
      ranges: rangesIn(hit.preview, query, flags),
      clippedStart: false,
      clippedEnd: false,
    });
    if (existing === undefined) files.set(hit.path, file);
  }
  const grouped = [...files.values()];
  return {
    status: "ok",
    files: grouped,
    totalMatches: hits.length,
    searchedFiles: grouped.length,
    truncated,
    reason: truncated ? "matches" : null,
    durationMs: 0,
    listing: "local",
  };
}

function rangesIn(preview: string, query: string, flags: MatchFlags): Array<[number, number]> {
  if (query === "") return [];
  const source = flags.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = flags.wholeWord ? `\\b(?:${source})\\b` : source;
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, flags.matchCase ? "g" : "gi");
  } catch {
    return [];
  }
  const ranges: Array<[number, number]> = [];
  let found = expression.exec(preview);
  while (found !== null && ranges.length < 32) {
    if (found[0].length === 0) {
      expression.lastIndex += 1;
    } else {
      ranges.push([found.index, found.index + found[0].length]);
    }
    found = expression.exec(preview);
  }
  return ranges;
}
