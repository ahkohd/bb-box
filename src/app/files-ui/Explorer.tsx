import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DialogButton } from "../box-dialog.tsx";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  ancestorsOf,
  basename,
  buildTree,
  visibleRows,
  type EntryKind,
  type FlatEntry,
  type TreeRow,
} from "./tree.ts";
import type { FilesScope } from "./files-scope.ts";
import { FileGlyph } from "./FileGlyph.tsx";
import { FilePlusGlyph } from "./file-plus.tsx";
import { SearchResults } from "./SearchResults.tsx";

import { useWorkspaceMemory, useWorkspaceState } from "./workspace-context.tsx";

export interface ExplorerProps {
  entries: readonly FlatEntry[];
  onLoadFolder?: (path: string) => void;
  loadingFolders?: ReadonlySet<string>;
  folderErrors?: ReadonlyMap<string, string>;
  activePath: string | null;
  isLoading: boolean;
  error: string | null;
  truncated: boolean;

  hiddenSupported: boolean;
  includeHidden: boolean;
  onToggleHidden: (next: boolean) => void;
  onOpenFile: (path: string) => void;

  onOpenMatch: (path: string, line: number) => void;
  onRefresh: () => void;
  onQuickOpen: () => void;
  onCreate: (parent: string, kind: EntryKind, name: string) => Promise<string | null>;
  onRename: (path: string, name: string) => Promise<string | null>;
  onDelete: (path: string) => Promise<string | null>;

  scope: FilesScope | null;

  searchFocusRequest: number;
  header: React.ReactNode;
}

const INDENT_PER_LEVEL_PX = 10;

const ROW_LIMIT = 600;

export function Explorer({
  entries,
  onLoadFolder,
  loadingFolders,
  folderErrors,
  activePath,
  isLoading,
  error,
  truncated,
  hiddenSupported,
  includeHidden,
  onToggleHidden,
  onOpenFile,
  onOpenMatch,
  onRefresh,
  onQuickOpen,
  onCreate,
  onRename,
  onDelete,
  scope,
  searchFocusRequest,
  header,
}: ExplorerProps) {

  const memory = useWorkspaceMemory();
  const [query, setQuery] = useWorkspaceState("query", "");
  const [searchFocused, setSearchFocused] = useState(false);
  const [matchCase, setMatchCase] = useWorkspaceState("matchCase", false);
  const [wholeWord, setWholeWord] = useWorkspaceState("wholeWord", false);
  const [regex, setRegex] = useWorkspaceState("regex", false);
  const [submitNonce, setSubmitNonce] = useState(0);
  const createMenu = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !createMenu.current?.contains(event.target)) createMenu.current?.removeAttribute("open"); };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") createMenu.current?.removeAttribute("open"); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [expanded, setExpanded] = useWorkspaceState("expanded", new Set());
  const previousScope = useRef(scope);
  useLayoutEffect(() => {
    if (previousScope.current?.root !== scope?.root || previousScope.current?.box !== scope?.box) {
      setExpanded(new Set());
      if (memory) memory.treeTop = 0;
    }
    previousScope.current = scope;
  }, [scope?.root, scope?.box]);
  const [menu, setMenu] = useState<{ path: string; kind: EntryKind; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<{ mode: "create"; parent: string; kind: EntryKind } | { mode: "rename"; path: string } | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<{ path: string; kind: EntryKind } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const committing = useRef(false);
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPrefetch = () => { if (prefetchTimer.current !== null) clearTimeout(prefetchTimer.current); };
  useEffect(() => cancelPrefetch, []);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const isSearching = query !== "" && scope !== null;

  useEffect(() => {
    if (searchFocusRequest === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [searchFocusRequest]);

  const tree = useMemo(() => buildTree(entries), [entries]);

  const openedPath = useRef(memory?.state.expanded ? activePath : null);
  useEffect(() => {
    if (activePath === null || openedPath.current === activePath) return;
    openedPath.current = activePath;
    for (const ancestor of ancestorsOf(activePath)) onLoadFolder?.(ancestor);
    setExpanded((current) => {
      const ancestors = ancestorsOf(activePath);
      if (ancestors.every((ancestor) => current.has(ancestor))) return current;
      const next = new Set(current);
      for (const ancestor of ancestors) next.add(ancestor);
      return next;
    });
  }, [activePath, onLoadFolder]);

  const lastActive = useRef(activePath);
  useEffect(() => {
    if (lastActive.current !== activePath) activeRowRef.current?.scrollIntoView({ block: "nearest" });
    lastActive.current = activePath;
  }, [activePath]);

  const allRows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const rows = useMemo(() => {
    if (allRows.length <= ROW_LIMIT) return allRows;
    const capped = allRows.slice(0, ROW_LIMIT);

    const activeIndex = allRows.findIndex((row) => row.node.path === activePath);
    if (activeIndex >= ROW_LIMIT) capped[ROW_LIMIT - 1] = allRows[activeIndex]!;
    return capped;
  }, [activePath, allRows]);

  const toggle = (path: string) => {
    onLoadFolder?.(path);
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const beginCreate = (parent: string, kind: EntryKind) => {
    setQuery("");
    if (parent !== "") {
      onLoadFolder?.(parent);
      setExpanded((current) => {
        const next = new Set(current);
        next.add(parent);
        return next;
      });
    }
    setMenu(null);
    setDraft({ mode: "create", parent, kind });
    setDraftError(null);
  };

  const beginRename = (path: string) => {
    setQuery("");
    setMenu(null);
    setDraft({ mode: "rename", path });
    setDraftError(null);
  };

  const commitDraft = async (name: string) => {
    if (draft === null || committing.current) return;
    committing.current = true;
    setBusy(true);
    const problem = draft.mode === "rename" ? await onRename(draft.path, name) : await onCreate(draft.parent, draft.kind, name);
    committing.current = false;
    setBusy(false);
    if (problem !== null) {
      setDraftError(problem);
      return;
    }
    setDraft(null);
    setDraftError(null);
  };

  const confirmDelete = async () => {
    if (removing === null || busy) return;
    const target = removing;
    setBusy(true);
    const problem = await onDelete(target.path);
    setBusy(false);
    setRemoving(null);
    if (problem !== null) setActionError(problem);
  };

  const fileCount = useMemo(
    () => entries.reduce((total, entry) => total + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface-recessed">
      <div className="flex min-w-0 items-center gap-0.5 px-2 py-2">
        {header}
        <ExplorerAction icon="RotateCcw" label="Refresh files" onClick={onRefresh} />
        <details ref={createMenu} className="relative shrink-0">
          <summary aria-label="Create" className="flex size-6 cursor-pointer list-none items-center justify-center text-muted-foreground"><span aria-hidden>+</span></summary>
          <div className="absolute right-0 z-20 w-32 border border-border bg-popover p-1">
            <button className="block w-full px-2 py-1 text-left text-xs" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); beginCreate('', 'file'); }}><FilePlusGlyph />New file</button>
            <button className="block w-full px-2 py-1 text-left text-xs" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); beginCreate('', 'directory'); }}><Icon name="FolderPlus" />New folder</button>
          </div>
        </details>
      </div>

      <div className="flex shrink-0 items-center gap-0.5 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                setSubmitNonce((current) => current + 1);
                return;
              }

              if (event.altKey && !event.metaKey && !event.ctrlKey) {
                const key = event.code;
                if (key === "KeyC") setMatchCase((value) => !value);
                else if (key === "KeyW") setWholeWord((value) => !value);
                else if (key === "KeyR") setRegex((value) => !value);
                else return;
                event.preventDefault();
              }
            }}
            placeholder="Search"
            aria-label="Search in files"
            title="Search in files"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              "h-7 w-full min-w-[9rem] rounded-md border border-border bg-background pr-2 pl-7 text-sm",
              "text-foreground placeholder:text-muted-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
        </div>
        <ExplorerAction
          icon="Search"
          label="Go to file by name"
          onClick={onQuickOpen}
        />
        {hiddenSupported ? (
          <ExplorerAction
            icon={includeHidden ? "Eye" : "EyeOff"}
            label={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
            isActive={includeHidden}
            onClick={() => onToggleHidden(!includeHidden)}
          />
        ) : null}
      </div>

      {searchFocused || query !== "" ? (
        <div className="flex shrink-0 items-center gap-px px-2 pb-2" onMouseDown={(event) => event.preventDefault()}>
          <SearchToggle
            label="Match case. Off, a capital letter makes the search case-sensitive"
            glyph="Aa"
            isOn={matchCase}
            onToggle={() => setMatchCase((value) => !value)}
          />
          <SearchToggle
            label="Match whole word (Alt W)"
            glyph="ab"
            underline
            isOn={wholeWord}
            onToggle={() => setWholeWord((value) => !value)}
          />
          <SearchToggle
            label="Use regular expression (Alt R)"
            glyph=".*"
            isOn={regex}
            onToggle={() => setRegex((value) => !value)}
          />
        </div>
      ) : null}

      {isSearching && scope !== null ? (
        <SearchResults
          scope={scope}
          query={query}
          matchCase={matchCase}
          wholeWord={wholeWord}
          regex={regex}
          includeHidden={hiddenSupported && includeHidden}
          submitNonce={submitNonce}
          activePath={activePath}
          onOpenMatch={onOpenMatch}
        />
      ) : (
        <div ref={(node) => { if (node && memory) node.scrollTop = memory.treeTop; }} onScroll={(event) => { if (memory) memory.treeTop = event.currentTarget.scrollTop; }} className="min-h-0 flex-1 overflow-auto pb-2">
          {error !== null || actionError !== null ? (
            <p className="px-3 py-2 text-xs text-destructive-text">{error ?? actionError}</p>
          ) : isLoading && entries.length === 0 ? <FolderSkeleton /> : rows.length === 0 && !(draft?.mode === "create" && draft.parent === "") ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              This folder has no files yet.
            </p>
          ) : (
            <ul role="tree" aria-label="Files" className="min-w-max">
              {draft?.mode === "create" && draft.parent === "" ? (
                <li role="none">
                  <NameField depth={0} kind={draft.kind} label={draft.kind === "directory" ? "New folder name" : "New file name"} initial="" error={draftError} onCommit={(name) => void commitDraft(name)} onCancel={() => { setDraft(null); setDraftError(null); }} />
                </li>
              ) : null}
              {rows.map((row) => (
                <Fragment key={row.node.path}>
                  <ExplorerRow
                    onPrefetch={() => { if (row.node.kind === "directory") onLoadFolder?.(row.node.path); }}
                    onDwell={() => { cancelPrefetch(); prefetchTimer.current = setTimeout(() => { if (row.node.kind === "directory") onLoadFolder?.(row.node.path); }, 120); }}
                    onLeave={cancelPrefetch}
                    row={row}
                    query=""
                    isActive={row.node.path === activePath}
                    isRenaming={draft?.mode === "rename" && draft.path === row.node.path}
                    renameError={draft?.mode === "rename" && draft.path === row.node.path ? draftError : null}
                    activeRef={row.node.path === activePath ? activeRowRef : undefined}
                    onToggle={toggle}
                    onOpenFile={onOpenFile}
                    onMenu={(at) => setMenu({ path: row.node.path, kind: row.node.kind, x: at.x, y: at.y })}
                    onCommitRename={(name) => void commitDraft(name)}
                    onCancelRename={() => { setDraft(null); setDraftError(null); }}
                  />
                  {row.isExpanded && folderErrors?.has(row.node.path) ? <li role="none" className="px-3 text-xs text-destructive-text">{folderErrors.get(row.node.path)}</li> : null}
                  {row.isExpanded && loadingFolders?.has(row.node.path) ? <li role="none"><FolderSkeleton /></li> : null}
                  {draft?.mode === "create" && draft.parent === row.node.path ? (
                    <li role="none">
                      <NameField depth={row.depth + 1} kind={draft.kind} label={draft.kind === "directory" ? "New folder name" : "New file name"} initial="" error={draftError} onCommit={(name) => void commitDraft(name)} onCancel={() => { setDraft(null); setDraftError(null); }} />
                    </li>
                  ) : null}
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {isLoading && entries.length === 0 ? "\u00a0" : `${fileCount.toLocaleString()} ${fileCount === 1 ? "file" : "files"}`}
        {!isSearching && allRows.length > rows.length
          ? ` - showing first ${ROW_LIMIT.toLocaleString()}`
          : ""}
        {truncated ? " - listing truncated" : ""}
      </div>
      {menu === null ? null : (
        <RowMenu
          path={menu.path}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          onCreate={(kind) => beginCreate(menu.kind === "directory" ? menu.path : dirnameOf(menu.path), kind)}
          onRename={() => beginRename(menu.path)}
          onDelete={() => {
            setMenu(null);
            setRemoving({ path: menu.path, kind: menu.kind });
          }}
        />
      )}
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !busy) setRemoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {removing === null ? "this" : basename(removing.path)}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.kind === "directory" ? "This deletes the folder and everything in it." : "This deletes the file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <DialogButton danger disabled={busy} onClick={() => void confirmDelete()}>
              {busy ? "Deleting…" : "Delete"}
            </DialogButton>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function ExplorerRow({
  onPrefetch,
  onDwell,
  onLeave,
  row,
  query,
  isActive,
  isRenaming,
  renameError,
  activeRef,
  onToggle,
  onOpenFile,
  onMenu,
  onCommitRename,
  onCancelRename,
}: {
  onPrefetch: () => void;
  onDwell: () => void;
  onLeave: () => void;
  row: TreeRow;
  query: string;
  isActive: boolean;
  isRenaming: boolean;
  renameError: string | null;
  activeRef?: React.RefObject<HTMLButtonElement | null>;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onMenu: (at: { x: number; y: number }) => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
}) {
  const { node, depth, isExpanded } = row;
  const isDirectory = node.kind === "directory";

  return (
    <li role="none" className="group relative" onContextMenu={(event) => { event.preventDefault(); onMenu({ x: event.clientX, y: event.clientY }); }}>
      {isRenaming ? (
        <NameField depth={depth} kind={node.kind} label="New name" initial={node.name} error={renameError} onCommit={onCommitRename} onCancel={onCancelRename} />
      ) : (
        <button
          onFocus={onPrefetch}
          onPointerEnter={onDwell}
          onPointerLeave={onLeave}
          ref={activeRef}
          type="button"
          role="treeitem"
          aria-selected={isActive}
          aria-expanded={isDirectory ? isExpanded : undefined}
          title={node.path}
          data-files-entry={node.path}
          onClick={() => (isDirectory ? onToggle(node.path) : onOpenFile(node.path))}
          style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
          className={cn(
            "flex h-6 w-full min-w-full cursor-pointer items-center gap-1.5 pr-8 text-left text-[13px]",
            "text-foreground/90 hover:bg-state-hover",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:-outline-offset-1",
            isActive && "bg-surface-selected text-foreground",
          )}
        >
          {isDirectory ? (
            <Icon name={isExpanded ? "ChevronDown" : "ChevronRight"} aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          ) : (
            <span aria-hidden className="w-3 shrink-0" />
          )}
          <FileGlyph path={node.path} kind={node.kind} isExpanded={isExpanded} />
          <span className="truncate">
            <HighlightedText text={node.name} query={query} />
          </span>
        </button>
      )}
      {isRenaming ? null : (
        <button
          type="button"
          aria-label={`Actions for ${node.name}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            onMenu({ x: rect.left, y: rect.bottom });
          }}
          className={cn(
            "absolute top-0 right-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted-foreground",
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-state-hover hover:text-foreground",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
          )}
        >
          <Icon name="MoreHorizontal" aria-hidden className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function NameField({
  depth,
  kind,
  label,
  initial,
  error,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: EntryKind;
  label: string;
  initial: string;
  error: string | null;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  useEffect(() => {
    if (error !== null) settled.current = false;
  }, [error]);
  const finish = (action: () => void) => {
    if (settled.current) return;
    settled.current = true;
    action();
  };
  return (
    <>
      <form
        className="flex items-center gap-1.5 pr-2"
        style={{ paddingLeft: 8 + depth * INDENT_PER_LEVEL_PX }}
        onSubmit={(event) => {
          event.preventDefault();
          finish(() => onCommit(ref.current?.value ?? ""));
        }}
      >
        <span aria-hidden className="w-3 shrink-0" />
        <FileGlyph path={initial === "" ? (kind === "directory" ? "folder" : "file.txt") : initial} kind={kind} />
        <input
          ref={ref}
          aria-label={label}
          defaultValue={initial}
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finish(onCancel);
            }
          }}
          onBlur={() => {
            const value = ref.current?.value ?? "";
            if (value.trim() === "" || value === initial) finish(onCancel);
            else finish(() => onCommit(value));
          }}
          className="h-6 min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-[13px] text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
        />
      </form>
      {error === null ? null : <p className="px-3 py-1 text-xs text-destructive-text">{error}</p>}
    </>
  );
}

function RowMenu({
  path,
  x,
  y,
  onClose,
  onCreate,
  onRename,
  onDelete,
}: {
  path: string;
  x: number;
  y: number;
  onClose: () => void;
  onCreate: (kind: EntryKind) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-row-menu]") !== null) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);

  const left = Math.max(8, Math.min(x, window.innerWidth - 180));
  const top = Math.max(8, Math.min(y, window.innerHeight - 168));
  return createPortal(
    <div data-row-menu role="menu" aria-label={`Actions for ${basename(path)}`} style={{ left, top }} className="fixed z-50 min-w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground">
      <MenuRow onSelect={() => onCreate("file")}>New file</MenuRow>
      <MenuRow onSelect={() => onCreate("directory")}>New folder</MenuRow>
      <MenuRow onSelect={onRename}>Rename</MenuRow>
      <MenuRow onSelect={onDelete} tone="danger">Delete</MenuRow>
    </div>,
    document.body,
  );
}

function MenuRow({ children, onSelect, tone }: { children: string; onSelect: () => void; tone?: "danger" }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-[13px]",
        "hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
        tone === "danger" ? "text-destructive-text" : "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SearchToggle({
  label,
  glyph,
  underline,
  isOn,
  onToggle,
}: {
  label: string;
  glyph: string;
  underline?: boolean;
  isOn: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={isOn}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-5 w-[1.35rem] cursor-pointer items-center justify-center rounded font-mono text-[10.5px] leading-none",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isOn
          ? "bg-primary/20 text-foreground ring-1 ring-primary/50"
          : "text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      <span className={underline === true ? "underline underline-offset-2" : undefined}>
        {glyph}
      </span>
    </button>
  );
}

function ExplorerAction({
  icon,
  label,
  onClick,
  isActive,
  isSpinning,
}: {
  icon: React.ComponentProps<typeof Icon>["name"];
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isActive === true && "text-foreground",
      )}
    >
      {icon === "FilePlus" ? (
        <FilePlusGlyph className={cn(isSpinning === true && "animate-spin")} />
      ) : (
        <Icon
          name={icon}
          aria-hidden
          className={cn("size-3.5", isSpinning === true && "animate-spin")}
        />
      )}
    </button>
  );
}

export function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const chunks = useMemo(() => highlightChunks(text, query), [text, query]);
  if (chunks === null) return <>{text}</>;

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.isMatch ? (
          <mark

            key={index}
            className="bg-transparent text-primary"
          >
            {chunk.text}
          </mark>
        ) : (

          <span key={index}>{chunk.text}</span>
        ),
      )}
    </>
  );
}

interface HighlightChunk {
  text: string;
  isMatch: boolean;
}

export function highlightChunks(
  text: string,
  query: string,
): HighlightChunk[] | null {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return null;

  const characters = [...text];
  const lowered = characters.map((character) => character.toLowerCase());
  const matched = new Set<number>();
  let cursor = 0;

  for (const needle of trimmed) {
    if (needle === " ") continue;
    const index = lowered.indexOf(needle, cursor);
    if (index === -1) return null;
    matched.add(index);
    cursor = index + 1;
  }

  const chunks: HighlightChunk[] = [];
  for (const [index, character] of characters.entries()) {
    const isMatch = matched.has(index);
    const last = chunks.at(-1);
    if (last !== undefined && last.isMatch === isMatch) last.text += character;
    else chunks.push({ text: character, isMatch });
  }
  return chunks;
}

function FolderSkeleton() {
  return <div role="status" aria-label="Loading folder" className="px-3 motion-safe:animate-pulse">{[1, 2, 3, 4].map((row) => <div key={row} className="flex h-6 items-center"><div className="h-2 w-2/3 rounded bg-muted" /></div>)}</div>;
}
