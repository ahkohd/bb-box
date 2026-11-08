import { experimental_SourceCode as SourceCode, Markdown, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { Contract, BoxPageState, PanelState } from "../plugin/contract.ts";
import { childPath, findInFile, parentPath, rankPaths, resolvePath, type FilesRead, type FsEntry, type FsHit } from "../core/box-fs.ts";
import { RANGE_BYTES } from "../core/box-fs-script.ts";
import { BackControl, BOXES_ACTION, EmptyPanel, forThread, message, Notice, ReleasedNotice, useLive, type BackTo } from "./common.tsx";
import { BoxName, type PageLink } from "./box-nav.tsx";
import { FolderGlyph } from "./glyphs.tsx";
import { canOpenFiles, useOpenFiles } from "./files-open.ts";
import { activeAfterClose } from "./files-tabs.ts";

type Os = "linux" | "windows" | "macos";

type TabPhase = "loading" | "text" | "image" | "binary" | "large" | "slice" | "error";

interface OpenTab {
  readonly path: string;
  readonly phase: TabPhase;
  readonly mode: "read" | "edit" | "preview";
  readonly content: string;
  readonly draft: string;
  readonly sha256: string | null;
  readonly sizeBytes: number;
  readonly dataUrl: string | null;
  readonly note: string | null;
  readonly reveal: number | null;
  readonly dirty: boolean;
  readonly conflict: string | null;
}

interface Listed {
  readonly entries: readonly FsEntry[];
  readonly truncated: boolean;
}

function asOs(os: string): Os {
  return os === "windows" || os === "macos" ? os : "linux";
}

function baseName(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function highlightPath(path: string, version: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const sep = slash >= 0 ? path[slash] : "/";
  const dir = slash >= 0 ? path.slice(0, slash) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  return `${dir}${sep}${version}${sep}${base}`;
}

function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function under(os: Os, root: string, path: string): boolean {
  if (os === "windows") {
    const base = root.replace(/[\\/]+$/, "").toLowerCase();
    const next = path.toLowerCase();
    return next === base || next.startsWith(`${base}\\`);
  }
  const base = root.replace(/\/+$/, "");
  return path === base || path.startsWith(`${base}/`);
}

function guarded(os: Os, path: string, home: string): boolean {
  if (path === home) return true;
  if (os === "windows") return /^[A-Za-z]:\\$/.test(path);
  return path === "/";
}

function parents(os: Os, home: string, path: string): string[] {
  const chain: string[] = [];
  let current = path;
  while (under(os, home, current)) {
    chain.unshift(current);
    if (current === home) break;
    const next = parentPath(os, current);
    if (next === current) break;
    current = next;
  }
  return chain;
}

function loadingTab(path: string): OpenTab {
  return { path, phase: "loading", mode: "read", content: "", draft: "", sha256: null, sizeBytes: 0, dataUrl: null, note: null, reveal: null, dirty: false, conflict: null };
}

function tabFromRead(path: string, read: FilesRead): OpenTab {
  if (read.error !== null) return { ...loadingTab(path), phase: "error", note: read.error };
  if (read.kind === "text") return { ...loadingTab(path), phase: "text", content: read.content, draft: read.content, sha256: read.sha256, sizeBytes: read.sizeBytes };
  if (read.kind === "image") return { ...loadingTab(path), phase: "image", sha256: read.sha256, sizeBytes: read.sizeBytes, dataUrl: read.dataUrl };
  if (read.kind === "binary") return { ...loadingTab(path), phase: "binary", sha256: read.sha256, sizeBytes: read.sizeBytes, note: read.reason };
  return { ...loadingTab(path), phase: "large", sha256: read.sha256, sizeBytes: read.sizeBytes, note: "This file is too large to open." };
}

function Editor({ value, onChange, onSave, match }: { value: string; onChange: (value: string) => void; onSave: () => void; match: { start: number; end: number } | null }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const node = area.current;
    if (!node || !match) return;
    node.focus();
    node.setSelectionRange(match.start, match.end);
  }, [match]);
  const lines = value.split("\n").length;
  return (
    <div className="flex min-h-0 flex-1">
      <pre ref={gutter} aria-hidden className="w-10 shrink-0 overflow-hidden border-r border-border py-3 pr-2 text-right font-mono text-[13px] leading-5 text-muted-foreground">
        {Array.from({ length: lines }, (_, index) => String(index + 1)).join("\n")}
      </pre>
      <textarea
        ref={area}
        value={value}
        spellCheck={false}
        aria-label="File text"
        className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 py-3 font-mono text-[13px] leading-5 text-foreground outline-none"
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            event.stopPropagation();
            onSave();
          }
        }}
      />
    </div>
  );
}

export function FilesPanel({ threadId, params }: { threadId: string; params: unknown }) {
  const boxId = typeof (params as { box?: unknown } | null)?.box === "string" ? (params as { box: string }).box : null;
  if (boxId) return <BoxFiles key={boxId} threadId={threadId} boxId={boxId} />;
  return <FilesChooser threadId={threadId} />;
}

function FilesChooser({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const open = useOpenFiles();
  const { value: state, error } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  const runsOn = state?.runsOn && canOpenFiles(state.runsOn.box) ? state.runsOn.box : null;
  const seen = new Set<string>();
  const boxes = [...(runsOn ? [runsOn] : []), ...(state?.boxes.filter(canOpenFiles) ?? [])].filter((box) => (seen.has(box.id) ? false : (seen.add(box.id), true)));
  if (boxes.length === 1) return <BoxFiles key={boxes[0]!.id} threadId={threadId} boxId={boxes[0]!.id} />;
  return (
    <div className="p-4">
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : null}
      {state && !boxes.length ? (
        <EmptyPanel title="No box with files">
          <p className="mt-1">This thread has no box whose files can be opened.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={() => navigate.openThreadPanel({ actionId: BOXES_ACTION, title: "Box" })}>
            Open the Box panel
          </Button>
        </EmptyPanel>
      ) : null}
      {boxes.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {boxes.map((box) => (
              <div key={box.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate text-sm text-foreground">{box.name}</span>
                <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => open(box)}>
                  Open
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BoxFiles({ threadId, boxId, onBack, page, otherViews }: { threadId: string; boxId: string; onBack?: BackTo; page?: PageLink; otherViews?: (shown: "files") => ReactNode }) {
  const rpc = useRpc<Contract>();
  const { value, error, refresh } = useLive<BoxPageState>(`files-page:${boxId}`, () => rpc.call("boxPage", { box: boxId }), () => true);
  const box = value?.box ?? null;
  const lastName = useRef<string | null>(null);
  if (box) lastName.current = box.name;
  return (
    <div data-files={boxId} className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        {onBack ? <BackControl back={onBack} /> : null}
        <FolderGlyph className="text-muted-foreground" />
        <BoxName name={box?.name ?? lastName.current ?? "Files"} page={page} />
        {otherViews?.("files")}
      </div>
      {error ? (
        <Notice action={<Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void refresh()}>Try again</Button>}>
          {error}
        </Notice>
      ) : null}
      {!value && !error ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading...</p> : null}
      {value && !box ? <ReleasedNotice name={lastName.current} back={onBack} /> : null}
      {box?.device ? <Notice>A device box has no files. Open the computer it runs on.</Notice> : null}
      {box && !box.device && box.state !== "ready" ? <Notice>This box is not ready.</Notice> : null}
      {box && !box.device && box.state === "ready" && !box.terminal ? <Notice>This box has no shell, so its files cannot be read.</Notice> : null}
      {box && canOpenFiles(box) ? <FilesBrowser key={`${threadId}:${box.id}`} boxId={box.id} os={asOs(box.os)} /> : null}
    </div>
  );
}

function FilesBrowser({ boxId, os }: { boxId: string; os: Os }) {
  const rpc = useRpc<Contract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const cache = useRef(new Map<string, Listed>());
  const [tick, setTick] = useState(0);
  const [reload, setReload] = useState(0);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const pathFocused = useRef(false);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [hits, setHits] = useState<readonly FsHit[] | null>(null);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [quick, setQuick] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [names, setNames] = useState<readonly string[] | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findAt, setFindAt] = useState(0);
  const [naming, setNaming] = useState<{ mode: "file" | "directory" | "rename"; value: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingClose, setPendingClose] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!pathFocused.current && cwd) setPathDraft(cwd);
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    void rpcRef.current.call("files.home", { box: boxId }).then((home) => {
      if (cancelled) return;
      if (home.error !== null) setProblem(home.error);
      else {
        setHomePath(home.path);
        setCwd(home.path);
        setOpened(new Set([home.path]));
      }
    }).catch((error: unknown) => {
      if (!cancelled) setProblem(message(error));
    });
    return () => {
      cancelled = true;
    };
  }, [boxId]);

  useEffect(() => {
    if (!cwd || cache.current.has(cwd)) return;
    let cancelled = false;
    void rpcRef.current.call("files.list", { box: boxId, path: cwd }).then(async (listed) => {
      if (cancelled) return;
      if (listed.error === null) {
        cache.current.set(cwd, { entries: listed.entries, truncated: listed.truncated });
        setTick((value) => value + 1);
        return;
      }
      const read = await rpcRef.current.call("files.read", { box: boxId, path: cwd });
      if (cancelled) return;
      if (read.error === null) {
        putTab(tabFromRead(cwd, read));
        setActive(cwd);
        setCwd(parentPath(os, cwd));
        return;
      }
      setProblem(listed.error);
    }).catch((error: unknown) => {
      if (!cancelled) setProblem(message(error));
    });
    return () => {
      cancelled = true;
    };
  }, [boxId, cwd, os, reload]);

  useEffect(() => {
    const text = query.trim();
    if (!text || !cwd) {
      setHits(null);
      setSearchNote(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      void rpcRef.current.call("files.search", { box: boxId, path: cwd, query: text, matchCase, wholeWord, regex, hidden: showHidden }).then((result) => {
        if (cancelled) return;
        setSearching(false);
        if (result.error !== null) {
          setHits([]);
          setSearchNote(result.error);
          return;
        }
        setHits(result.hits);
        setSearchNote(result.truncated ? "The search stops at 2,000 hits or 500 files." : null);
      }).catch((error: unknown) => {
        if (cancelled) return;
        setSearching(false);
        setHits([]);
        setSearchNote(message(error));
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [boxId, cwd, matchCase, query, regex, showHidden, wholeWord]);

  useEffect(() => {
    if (!quick || !homePath || names) return;
    let cancelled = false;
    void rpcRef.current.call("files.names", { box: boxId, path: homePath }).then((result) => {
      if (!cancelled && result.error === null) setNames(result.paths);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [boxId, homePath, names, quick]);

  function putTab(tab: OpenTab): void {
    setTabs((current) => {
      const rest = current.filter((each) => each.path !== tab.path);
      return [...rest, tab];
    });
    setActive(tab.path);
  }

  function patchTab(path: string, patch: Partial<OpenTab>): void {
    setTabs((current) => current.map((tab) => (tab.path === path ? { ...tab, ...patch } : tab)));
  }

  async function openPath(path: string, reveal: number | null = null): Promise<void> {
    const found = tabsRef.current.find((tab) => tab.path === path);
    if (found && found.phase !== "loading") {
      setActive(path);
      if (reveal !== null) patchTab(path, { reveal });
      return;
    }
    putTab({ ...loadingTab(path), reveal });
    try {
      const read = await rpcRef.current.call("files.read", { box: boxId, path });
      putTab({ ...tabFromRead(path, read), reveal });
    } catch (error) {
      putTab({ ...loadingTab(path), phase: "error", note: message(error) });
    }
  }

  function forget(path: string): void {
    cache.current.delete(path);
    setNames(null);
    setReload((value) => value + 1);
    setTick((value) => value + 1);
  }

  function go(path: string): void {
    setProblem(null);
    setQuery("");
    setCwd(path);
    if (homePath && under(os, homePath, path)) {
      setOpened((current) => {
        const next = new Set(current);
        for (const dir of parents(os, homePath, path)) next.add(dir);
        return next;
      });
    } else setOpened(new Set([path]));
  }

  async function save(path: string, overwrite = false): Promise<void> {
    const tab = tabsRef.current.find((each) => each.path === path);
    if (!tab || tab.phase !== "text") return;
    setSaving(true);
    try {
      const wrote = await rpcRef.current.call("files.write", { box: boxId, path, content: tab.draft, expectedSha256: overwrite ? null : tab.sha256 });
      if (wrote.error !== null) {
        patchTab(path, { note: wrote.error });
        return;
      }
      if (wrote.outcome === "conflict") {
        patchTab(path, { conflict: "This file changed since you opened it.", note: null });
        return;
      }
      patchTab(path, { content: tab.draft, sha256: wrote.sha256, sizeBytes: wrote.sizeBytes, dirty: false, conflict: null, note: null });
      if (cwd) forget(cwd);
    } catch (error) {
      patchTab(path, { note: message(error) });
    } finally {
      setSaving(false);
    }
  }

  async function readAgain(path: string): Promise<void> {
    try {
      const read = await rpcRef.current.call("files.read", { box: boxId, path });
      putTab(tabFromRead(path, read));
    } catch (error) {
      patchTab(path, { note: message(error) });
    }
  }

  async function showSlice(path: string): Promise<void> {
    try {
      const range = await rpcRef.current.call("files.readRange", { box: boxId, path, start: 0, length: RANGE_BYTES });
      if (range.error !== null) {
        patchTab(path, { note: range.error });
        return;
      }
      patchTab(path, { phase: "slice", content: range.content, draft: range.content, sha256: range.sha256, sizeBytes: range.sizeBytes, note: `Showing the first ${sizeWords(range.end - range.start)} of ${sizeWords(range.sizeBytes)}.` });
    } catch (error) {
      patchTab(path, { note: message(error) });
    }
  }

  async function createNamed(): Promise<void> {
    if (!naming || !cwd || naming.mode === "rename") return;
    const path = childPath(os, cwd, naming.value.trim());
    if (!path) {
      setProblem("Give a name with no slashes.");
      return;
    }
    try {
      const made = await rpcRef.current.call("files.create", { box: boxId, path, kind: naming.mode });
      if (made.error !== null) {
        setProblem(made.error);
        return;
      }
      setNaming(null);
      forget(cwd);
      if (naming.mode === "file") await openPath(path);
    } catch (error) {
      setProblem(message(error));
    }
  }

  async function renameSelected(): Promise<void> {
    if (!naming || naming.mode !== "rename" || !selected || !homePath) return;
    const target = childPath(os, parentPath(os, selected), naming.value.trim());
    if (!target) {
      setProblem("Give a name with no slashes.");
      return;
    }
    try {
      const moved = await rpcRef.current.call("files.rename", { box: boxId, from: selected, to: target });
      if (moved.error !== null) {
        setProblem(moved.error);
        return;
      }
      setTabs((current) => current.map((tab) => (tab.path === selected ? { ...tab, path: target } : tab)));
      if (activeRef.current === selected) setActive(target);
      setSelected(target);
      setNaming(null);
      forget(parentPath(os, selected));
    } catch (error) {
      setProblem(message(error));
    }
  }

  async function remove(path: string): Promise<void> {
    if (!homePath) return;
    try {
      const removed = await rpcRef.current.call("files.delete", { box: boxId, path, home: homePath });
      if (removed.error !== null) {
        setProblem(removed.error);
        return;
      }
      setTabs((current) => current.filter((tab) => tab.path !== path));
      setActive(activeAfterClose(tabsRef.current.map((tab) => tab.path), activeRef.current, path));
      const parent = parentPath(os, path);
      if (cwd && (cwd === path || under(os, path, cwd))) setCwd(parent);
      setSelected(null);
      setPendingDelete(null);
      forget(parent);
    } catch (error) {
      setProblem(message(error));
    }
  }

  function closeTab(path: string): void {
    const tab = tabsRef.current.find((each) => each.path === path);
    if (tab?.dirty) {
      setPendingClose(path);
      return;
    }
    dropTab(path);
  }

  function dropTab(path: string): void {
    setTabs((current) => current.filter((tab) => tab.path !== path));
    setActive(activeAfterClose(tabsRef.current.map((tab) => tab.path), activeRef.current, path));
    setPendingClose(null);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (mod && key === "p" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      setQuick(true);
      return;
    }
    if (mod && event.shiftKey && key === "f") {
      event.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (mod && !event.shiftKey && !event.altKey && key === "f") {
      event.preventDefault();
      setFindOpen(true);
      return;
    }
    if (mod && key === "s" && activeRef.current) {
      event.preventDefault();
      void save(activeRef.current);
      return;
    }
    if (event.key === "Escape") {
      if (quick) {
        setQuick(false);
        return;
      }
      if (query) {
        setQuery("");
        return;
      }
      if (findOpen) setFindOpen(false);
    }
  }

  const tab = tabs.find((each) => each.path === active) ?? null;
  const text = tab?.phase === "text" || tab?.phase === "slice" ? (tab.mode === "edit" ? tab.draft : tab.content) : "";
  const matches = findOpen && findQuery && tab && (tab.phase === "text" || tab.phase === "slice") ? findInFile(text, findQuery, false) : [];
  const match = matches.length ? matches[Math.min(findAt, matches.length - 1)]! : null;

  function renderDir(path: string, depth: number): ReactNode {
    const rows = cache.current.get(path);
    if (!rows) return depth === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p> : null;
    const entries = rows.entries.filter((entry) => showHidden || !entry.name.startsWith("."));
    return (
      <div>
        {entries.map((entry) => {
          const child = childPath(os, path, entry.name);
          if (!child) return null;
          const isDir = entry.kind === "directory";
          const open = isDir && opened.has(child);
          return (
            <div key={child}>
              <button
                type="button"
                data-files-entry={entry.name}
                className={cn("flex w-full items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs hover:bg-state-hover", selected === child ? "bg-state-hover text-foreground" : "text-muted-foreground")}
                style={{ paddingLeft: `${8 + depth * 12}px` }}
                onClick={() => {
                  setSelected(child);
                  if (isDir) {
                    if (opened.has(child) && cache.current.has(child)) {
                      setOpened((current) => {
                        const next = new Set(current);
                        next.delete(child);
                        return next;
                      });
                      return;
                    }
                    go(child);
                  } else void openPath(child);
                }}
              >
                {isDir ? <FolderGlyph className="size-3.5" /> : <span className="inline-block size-3.5 shrink-0" />}
                <span className="min-w-0 truncate">{naming?.mode === "rename" && selected === child ? "" : entry.name}</span>
              </button>
              {naming?.mode === "rename" && selected === child ? (
                <form
                  className="px-2 py-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void renameSelected();
                  }}
                >
                  <Input aria-label="New name" value={naming.value} autoFocus className="h-7 text-xs" onChange={(event) => setNaming({ mode: "rename", value: event.target.value })} />
                </form>
              ) : null}
              {open ? renderDir(child, depth + 1) : null}
            </div>
          );
        })}
        {rows.truncated ? <p className="px-2 py-1 text-xs text-muted-foreground">The list stops at 5,000 names.</p> : null}
      </div>
    );
  }

  const treeRoot = homePath && cwd && under(os, homePath, cwd) ? homePath : cwd;
  const ranked = rankPaths(names ?? [], quickQuery);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={!homePath} onClick={() => homePath && go(homePath)}>
          Home
        </Button>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={!cwd} onClick={() => cwd && go(parentPath(os, cwd))}>
          Up
        </Button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (!cwd) return;
            const next = resolvePath(os, cwd, pathDraft);
            if (!next) setProblem("Give a path the box user can read.");
            else go(next);
          }}
        >
          <Input
            aria-label="Path"
            value={pathDraft}
            className="h-7 font-mono text-xs"
            onFocus={() => {
              pathFocused.current = true;
            }}
            onBlur={() => {
              pathFocused.current = false;
              if (cwd) setPathDraft(cwd);
            }}
            onChange={(event) => setPathDraft(event.target.value)}
          />
        </form>
        <Button type="button" variant="outline" size="sm" className="h-7" disabled={!cwd} onClick={() => cwd && forget(cwd)}>
          Refresh
        </Button>
      </div>
      {problem ? <p role="alert" className="border-b border-border px-3 py-1.5 text-xs text-destructive-text">{problem}</p> : null}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(8rem,14rem)_minmax(0,1fr)] min-[720px]:grid-cols-[16rem_minmax(0,1fr)] min-[720px]:grid-rows-1">
        <div className="flex min-h-0 flex-col border-b border-border min-[720px]:border-b-0 min-[720px]:border-r">
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
            <Input ref={searchRef} aria-label="Search in files" placeholder="Search in files" value={query} className="h-7 min-w-0 flex-1 text-xs" onChange={(event) => setQuery(event.target.value)} />
            <Button type="button" variant={matchCase ? "secondary" : "outline"} size="sm" className="h-7 px-2" aria-pressed={matchCase} onClick={() => setMatchCase((value) => !value)}>
              Aa
            </Button>
            <Button type="button" variant={wholeWord ? "secondary" : "outline"} size="sm" className="h-7 px-2" aria-pressed={wholeWord} onClick={() => setWholeWord((value) => !value)}>
              Word
            </Button>
            <Button type="button" variant={regex ? "secondary" : "outline"} size="sm" className="h-7 px-2" aria-pressed={regex} onClick={() => setRegex((value) => !value)}>
              .*
            </Button>
            <Button type="button" variant={showHidden ? "secondary" : "outline"} size="sm" className="h-7 px-2" aria-pressed={showHidden} aria-label="Hidden files" onClick={() => setShowHidden((value) => !value)}>
              Hidden
            </Button>
          </div>
          <div className="flex flex-wrap gap-1 border-b border-border px-2 py-1.5">
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!cwd} onClick={() => setNaming({ mode: "file", value: "" })}>
              New file
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!cwd} onClick={() => setNaming({ mode: "directory", value: "" })}>
              New folder
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!selected} onClick={() => selected && setNaming({ mode: "rename", value: baseName(selected) })}>
              Rename
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7" disabled={!selected || !homePath || guarded(os, selected, homePath)} onClick={() => selected && setPendingDelete(selected)}>
              Delete
            </Button>
          </div>
          {naming && naming.mode !== "rename" ? (
            <form
              className="border-b border-border px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void createNamed();
              }}
            >
              <Input aria-label={naming.mode === "file" ? "New file name" : "New folder name"} value={naming.value} autoFocus placeholder={naming.mode === "file" ? "File name" : "Folder name"} className="h-7 text-xs" onChange={(event) => setNaming({ mode: naming.mode, value: event.target.value })} />
            </form>
          ) : null}
          <div className="min-h-0 flex-1 overflow-auto py-1" data-listed={tick}>
            {query.trim() ? (
              <div>
                {searching ? <p className="px-2 py-1 text-xs text-muted-foreground">Searching...</p> : null}
                {searchNote ? <p className="px-2 py-1 text-xs text-muted-foreground">{searchNote}</p> : null}
                {(hits ?? []).map((hit, index) => {
                  const absolute = cwd ? resolvePath(os, cwd, hit.path) : null;
                  return (
                    <button
                      key={`${hit.path}:${hit.line}:${index}`}
                      type="button"
                      className="block w-full truncate px-2 py-1 text-left text-xs hover:bg-state-hover"
                      onClick={() => absolute && void openPath(absolute, hit.line)}
                    >
                      <span className="text-foreground">{hit.path}</span>
                      <span className="text-muted-foreground">:{hit.line}</span>
                      <span className="block truncate text-muted-foreground">{hit.preview}</span>
                    </button>
                  );
                })}
                {hits && !hits.length && !searching ? <p className="px-2 py-1 text-xs text-muted-foreground">No matches.</p> : null}
              </div>
            ) : treeRoot ? (
              renderDir(treeRoot, 0)
            ) : (
              <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
            )}
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
          {tabs.length ? (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1">
              {tabs.map((each) => (
                <div key={each.path} className={cn("flex max-w-48 items-center rounded-sm text-xs", each.path === active ? "bg-state-hover text-foreground" : "text-muted-foreground")}>
                  <button type="button" className="min-w-0 truncate px-2 py-1" onClick={() => setActive(each.path)}>
                    {baseName(each.path)}
                    {each.dirty ? " *" : ""}
                  </button>
                  <button type="button" aria-label={`Close ${baseName(each.path)}`} className="px-1 py-1 text-muted-foreground" onClick={() => closeTab(each.path)}>
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {tab && (tab.phase === "text" || tab.phase === "slice") ? (
            <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
              <Button type="button" variant={tab.mode === "read" ? "secondary" : "outline"} size="sm" className="h-7" onClick={() => patchTab(tab.path, { mode: "read" })}>
                Read
              </Button>
              {tab.phase === "text" ? (
                <Button type="button" variant={tab.mode === "edit" ? "secondary" : "outline"} size="sm" className="h-7" onClick={() => patchTab(tab.path, { mode: "edit" })}>
                  Edit
                </Button>
              ) : null}
              {isMarkdown(tab.path) ? (
                <Button type="button" variant={tab.mode === "preview" ? "secondary" : "outline"} size="sm" className="h-7" onClick={() => patchTab(tab.path, { mode: "preview" })}>
                  Preview
                </Button>
              ) : null}
              {tab.phase === "text" ? (
                <Button type="button" variant="outline" size="sm" className="h-7" disabled={saving || !tab.dirty} onClick={() => void save(tab.path)}>
                  Save
                </Button>
              ) : null}
              <span className="ml-auto text-xs text-muted-foreground">{sizeWords(tab.sizeBytes)}</span>
            </div>
          ) : null}
          {findOpen && tab && (tab.phase === "text" || tab.phase === "slice") ? (
            <form
              className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                setFindAt((value) => (matches.length ? (value + 1) % matches.length : 0));
              }}
            >
              <Input aria-label="Find in file" value={findQuery} autoFocus className="h-7 text-xs" onChange={(event) => { setFindQuery(event.target.value); setFindAt(0); }} />
              <span className="shrink-0 text-xs text-muted-foreground">{matches.length ? `${Math.min(findAt, matches.length - 1) + 1} of ${matches.length}` : "None"}</span>
              <Button type="submit" variant="outline" size="sm" className="h-7">
                Next
              </Button>
            </form>
          ) : null}
          {tab?.conflict ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
              <span className="text-warning-text">{tab.conflict}</span>
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void readAgain(tab.path)}>
                Reload
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7" disabled={saving} onClick={() => void save(tab.path, true)}>
                Overwrite
              </Button>
            </div>
          ) : null}
          {tab?.note && tab.phase !== "large" && tab.phase !== "slice" ? <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{tab.note}</p> : null}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {!tab ? <p className="px-3 py-2 text-xs text-muted-foreground">Open a file.</p> : null}
            {tab?.phase === "loading" ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading...</p> : null}
            {tab?.phase === "error" ? <p className="px-3 py-2 text-xs text-destructive-text">{tab.note}</p> : null}
            {tab?.phase === "image" && tab.dataUrl ? <img src={tab.dataUrl} alt={baseName(tab.path)} className="max-h-full max-w-full object-contain p-3" /> : null}
            {tab?.phase === "binary" ? <p className="px-3 py-2 text-sm text-foreground">{tab.note} {sizeWords(tab.sizeBytes)}.</p> : null}
            {tab?.phase === "large" ? (
              <div className="px-3 py-2">
                <p className="text-sm text-foreground">{tab.note} {sizeWords(tab.sizeBytes)}.</p>
                <Button type="button" variant="outline" size="sm" className="mt-2 h-7" onClick={() => void showSlice(tab.path)}>
                  Show the first 256 KB
                </Button>
              </div>
            ) : null}
            {tab && tab.phase === "slice" ? <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{tab.note} It cannot be saved from here.</p> : null}
            {tab && (tab.phase === "text" || tab.phase === "slice") && tab.mode === "preview" && isMarkdown(tab.path) ? (
              <div className="min-h-0 flex-1 overflow-auto px-3 py-2 text-sm">
                <Markdown content={tab.dirty ? tab.draft : tab.content} />
              </div>
            ) : null}
            {tab && (tab.phase === "text" || tab.phase === "slice") && tab.mode === "edit" && tab.phase === "text" ? (
              <Editor value={tab.draft} match={match} onChange={(draft) => patchTab(tab.path, { draft, dirty: draft !== tab.content, conflict: null })} onSave={() => void save(tab.path)} />
            ) : null}
            {tab && (tab.phase === "text" || tab.phase === "slice") && tab.mode === "read" ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <SourceCode key={`${tab.path}:${tab.sha256 ?? ""}:${tab.content.length}`} content={tab.content} path={highlightPath(tab.path, `${tab.sha256 ?? "open"}-${tab.content.length}`)} overflow="scroll" highlightedLines={match ? { start: match.line, end: match.line } : tab.reveal ? { start: tab.reveal, end: tab.reveal } : undefined} className="min-h-0 flex-1 text-[13px]" />
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {quick ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-16" onMouseDown={() => setQuick(false)}>
          <div className="w-full max-w-lg rounded-md border border-border bg-card" onMouseDown={(event) => event.stopPropagation()}>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const picked = ranked[0];
                const absolute = picked && homePath ? resolvePath(os, homePath, picked) : null;
                if (absolute) {
                  setQuick(false);
                  setQuickQuery("");
                  void openPath(absolute);
                }
              }}
            >
              <Input aria-label="Go to file" autoFocus placeholder="Go to file" value={quickQuery} className="h-9 rounded-b-none border-0 text-sm" onChange={(event) => setQuickQuery(event.target.value)} />
            </form>
            <div className="max-h-72 overflow-auto border-t border-border py-1">
              {ranked.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="block w-full truncate px-3 py-1 text-left text-xs hover:bg-state-hover"
                  onClick={() => {
                    const absolute = homePath ? resolvePath(os, homePath, path) : null;
                    if (!absolute) return;
                    setQuick(false);
                    setQuickQuery("");
                    void openPath(absolute);
                  }}
                >
                  {path}
                </button>
              ))}
              {names && !ranked.length ? <p className="px-3 py-1 text-xs text-muted-foreground">No files.</p> : null}
              {!names ? <p className="px-3 py-1 text-xs text-muted-foreground">Loading names...</p> : null}
            </div>
          </div>
        </div>
      ) : null}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete ? baseName(pendingDelete) : "this"}?</AlertDialogTitle>
            <AlertDialogDescription>This removes it from the box. It cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingDelete && void remove(pendingDelete)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={pendingClose !== null} onOpenChange={(open) => !open && setPendingClose(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {pendingClose ? baseName(pendingClose) : "this file"} without saving?</AlertDialogTitle>
            <AlertDialogDescription>The changes in this tab will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => pendingClose && dropTab(pendingClose)}>Close without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
