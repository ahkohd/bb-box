import type { FileTab } from './use-file-tabs.ts';
import type { FlatEntry } from './tree.ts';
import type { SearchResult } from './group-hits.ts';
import type { TextSelection } from "./text-selection.ts";

export interface ViewMemory {
  textSelection: TextSelection | null;
  query: string;
  caseSensitive: boolean;
  index: number;
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
  top: number;
  left: number;
}

export interface WorkspaceState {
  home: string | null;
  root: string | null;
  names: string[];
  directories: string[];
  truncated: boolean;
  treeStatus: 'idle' | 'loading' | 'ready' | 'error';
  includeHidden: boolean;
  explorerWidth: number;
  isExplorerOpen: boolean;
  treeForward: boolean;
  findRequest: number;
  indexEntries: FlatEntry[];
  tabs: FileTab[];
  activePath: string | null;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  expanded: ReadonlySet<string>;
  searchResult: SearchResult | null;
  searchKey: string;
  collapsed: ReadonlySet<string>;
}

export interface WorkspaceMemory {
  thread: string;
  box: string;
  valid: boolean;
  state: Partial<WorkspaceState>;
  views: Map<string, ViewMemory>;
  loadedFolders: Set<string>;
  treeTop: number;
  searchTop: number;
}

export const WORKSPACE_LIMIT = 8;
export const WORKSPACE_BYTES = 32 * 1024 * 1024;
const kept = new Map<string, { memory: WorkspaceMemory; bytes: number }>();
const live = new Set<WorkspaceMemory>();
const keyOf = (thread: string, box: string) => JSON.stringify([thread, box]);

export function restoreWorkspace(thread: string, box: string): WorkspaceMemory {
  const existing = kept.get(keyOf(thread, box))?.memory;
  return existing ? structuredClone(existing) : { thread, box, valid: true, state: {}, views: new Map(), loadedFolders: new Set(), treeTop: 0, searchTop: 0 };
}

export function activateWorkspace(memory: WorkspaceMemory): void {
  kept.delete(keyOf(memory.thread, memory.box));
  live.add(memory);
}

export function takeWorkspace(thread: string, box: string): WorkspaceMemory {
  const memory = restoreWorkspace(thread, box);
  activateWorkspace(memory);
  return memory;
}

export function keepWorkspace(memory: WorkspaceMemory): void {
  live.delete(memory);
  if (!memory.valid) return;
  const key = keyOf(memory.thread, memory.box);
  kept.delete(key);
  const bytes = new TextEncoder().encode(JSON.stringify(memory, (_key, value: unknown) => value instanceof Map || value instanceof Set ? [...value] : value)).byteLength;
  if (bytes > WORKSPACE_BYTES) return;
  kept.set(key, { memory, bytes });
  let total = [...kept.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [oldest, entry] of kept) {
    if (kept.size <= WORKSPACE_LIMIT && total <= WORKSPACE_BYTES) break;
    kept.delete(oldest);
    total -= entry.bytes;
  }
}

export function forgetWorkspaceBox(box: string): void {
  for (const memory of live) if (memory.box === box) memory.valid = false;
  for (const [key, entry] of kept) if (entry.memory.box === box) kept.delete(key);
}

export function clearWorkspaces(): void {
  for (const memory of live) memory.valid = false;
  live.clear();
  kept.clear();
}

export function fileViewMemory(memory: WorkspaceMemory | null, path: string): ViewMemory {
  const existing = memory?.views.get(path);
  if (existing) return existing;
  const view: ViewMemory = { textSelection: null, query: '', caseSensitive: false, index: -1, start: 0, end: 0, direction: 'none', top: 0, left: 0 };
  memory?.views.set(path, view);
  return view;
}

export function workspaceBoxes(): string[] {
  return [...new Set([...live, ...[...kept.values()].map((entry) => entry.memory)].filter((memory) => memory.valid).map((memory) => memory.box))];
}
