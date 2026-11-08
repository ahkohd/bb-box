export type EntryKind = "file" | "directory";

export interface FlatEntry {
  path: string;
  kind: EntryKind;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: EntryKind;
  children: TreeNode[];
}

export interface TreeRow {
  node: TreeNode;
  depth: number;
  isExpanded: boolean;
}

export function normalizeRelative(path: string): string {
  return path.replace(/^\.?\//, "").replace(/\/+$/, "");
}

export function basename(path: string): string {
  const normalized = normalizeRelative(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  const normalized = normalizeRelative(path);
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "" : normalized.slice(0, separator);
}

export function ancestorsOf(path: string): string[] {
  const segments = normalizeRelative(path).split("/");
  segments.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}

export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "directory", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const directoryAt = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const node: TreeNode = {
      path,
      name: basename(path),
      kind: "directory",
      children: [],
    };
    byPath.set(path, node);
    directoryAt(dirname(path)).children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalizeRelative(entry.path);
    if (path === "") continue;
    if (entry.kind === "directory") {
      directoryAt(path);
      continue;
    }
    if (byPath.has(path)) continue;
    const node: TreeNode = {
      path,
      name: basename(path),
      kind: "file",
      children: [],
    };
    byPath.set(path, node);
    directoryAt(dirname(path)).children.push(node);
  }

  sortRecursively(root);
  return root.children;
}

function sortRecursively(node: TreeNode): void {
  node.children.sort(compareNodes);
  for (const child of node.children) sortRecursively(child);
}

function compareNodes(left: TreeNode, right: TreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

export function visibleRows(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: TreeNode, depth: number): void => {
    const isExpanded = node.kind === "directory" && expanded.has(node.path);
    rows.push({ node, depth, isExpanded });
    if (!isExpanded) return;
    for (const child of node.children) visit(child, depth + 1);
  };
  for (const node of nodes) visit(node, 0);
  return rows;
}

export interface FuzzyMatch {
  score: number;
  positions: number[];
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (query === "") return { score: 0, positions: [] };

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  const positions: number[] = [];
  let score = 0;
  let cursor = 0;
  let previousIndex = -1;

  for (const character of needle) {
    if (character === " ") continue;
    const index = haystack.indexOf(character, cursor);
    if (index === -1) return null;

    let characterScore = 1;
    if (index === previousIndex + 1) characterScore += 8;
    if (isBoundary(text, index)) characterScore += 12;
    if (index === 0) characterScore += 4;
    score += characterScore;

    positions.push(index);
    previousIndex = index;
    cursor = index + 1;
  }

  const nameStart = text.lastIndexOf("/") + 1;
  if (positions.length > 0 && positions[0]! >= nameStart) score += 15;
  score -= Math.min(text.length, 120) / 12;

  return { score, positions };
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1]!;
  if (previous === "/" || previous === "_" || previous === "-" || previous === ".") {
    return true;
  }
  const current = text[index]!;
  return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

export interface RankedEntry extends FlatEntry {
  score: number;
  positions: number[];
}

export function rankEntries(
  entries: readonly FlatEntry[],
  query: string,
  limit: number,
): { matches: RankedEntry[]; truncated: boolean } {
  const trimmed = query.trim();
  if (trimmed === "") return { matches: [], truncated: false };

  const matches: RankedEntry[] = [];
  for (const entry of entries) {
    const match = fuzzyMatch(entry.path, trimmed);
    if (match === null) continue;
    matches.push({ ...entry, score: match.score, positions: match.positions });
  }

  matches.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.path.localeCompare(right.path, undefined, { numeric: true });
  });

  return {
    matches: matches.slice(0, limit),
    truncated: matches.length > limit,
  };
}

export interface FilteredTree {
  nodes: TreeNode[];

  expand: Set<string>;
  matchCount: number;
}

export function filterTree(
  nodes: readonly TreeNode[],
  query: string,
): FilteredTree {
  const trimmed = query.trim();
  if (trimmed === "") {
    return { nodes: [...nodes], expand: new Set(), matchCount: 0 };
  }

  const expand = new Set<string>();
  let matchCount = 0;

  const visit = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      if (fuzzyMatch(node.path, trimmed) === null) return null;
      matchCount += 1;
      return node;
    }
    const children = node.children
      .map(visit)
      .filter((child): child is TreeNode => child !== null);
    if (children.length === 0) return null;
    expand.add(node.path);
    return { ...node, children };
  };

  return {
    nodes: nodes.map(visit).filter((node): node is TreeNode => node !== null),
    expand,
    matchCount,
  };
}
