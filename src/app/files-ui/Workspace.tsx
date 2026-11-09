import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { Contract } from "../../plugin/contract.ts";
import { parentPath, resolvePath } from "../../core/box-fs.ts";
import type { GuestOs } from "../../transports/types.ts";
import { createdPath, renamedPath } from "./entry-name.ts";
import { DEFAULT_EXPLORER_PX, showsOneSurface } from "./layout.ts";
import type { EntryKind, FlatEntry } from "./tree.ts";
import { isMarkdownPath } from "./markdown.ts";
import { visibleNames } from "./group-hits.ts";
import { absoluteFrom } from "./locate.ts";
import { Explorer } from "./Explorer.tsx";
import { EditorTabs } from "./EditorTabs.tsx";
import { FileView, fileMetaLabel } from "./FileView.tsx";
import { QuickOpen } from "./QuickOpen.tsx";
import { canPreview, isDirty, useFileTabs, type FileTab, type FileViewMode } from "./use-file-tabs.ts";
import type { FilesScope } from "./files-scope.ts";
import { WorkspaceSession, useWorkspaceMemory, useWorkspaceState } from "./workspace-context.tsx";

const MIN_EXPLORER_PX = 220;
const MAX_EXPLORER_PX = 560;
const WIDTH_STORAGE_KEY = "bb-box:files-explorer-width";
const HIDDEN_STORAGE_KEY = "bb-box:files-include-hidden";

export function Workspace({ threadId, boxId, os }: { threadId: string; boxId: string; os: GuestOs }) {
  return <WorkspaceSession key={JSON.stringify([threadId, boxId])} threadId={threadId} boxId={boxId}><WorkspaceBody boxId={boxId} os={os} /></WorkspaceSession>;
}

function WorkspaceBody({ boxId, os }: { boxId: string; os: GuestOs }) {
  const memory = useWorkspaceMemory();
  const rpc = useRpc<Contract>();
  const [home, setHome] = useWorkspaceState("home", null);
  const [root, setRoot] = useWorkspaceState("root", null);
  const [names, setNames] = useWorkspaceState("names", []);
  const [directories, setDirectories] = useWorkspaceState("directories", []);
  const [truncated, setTruncated] = useWorkspaceState("truncated", false);
  const [treeStatus, setTreeStatus] = useWorkspaceState("treeStatus", "idle");
  const [treeError, setTreeError] = useState<string | null>(null);
  const [includeHidden, setIncludeHidden] = useWorkspaceState("includeHidden", readStoredHidden);
  const [explorerWidth, setExplorerWidth] = useWorkspaceState("explorerWidth", readStoredWidth);
  const [isExplorerOpen, setIsExplorerOpen] = useWorkspaceState("isExplorerOpen", true);
  const [frameWidth, setFrameWidth] = useState(readFrame);
  const [treeForward, setTreeForward] = useWorkspaceState("treeForward", true);
  const [isQuickOpen, setIsQuickOpen] = useState(false);
  const [findRequest, setFindRequest] = useWorkspaceState("findRequest", 0);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const [reveal, setReveal] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);
  const requestedRoot = useRef<string | null>(root);
  const previousBox = useRef(boxId);
  const previousHidden = useRef(includeHidden);
  const revealNonce = useRef(0);

  const scope = useMemo<FilesScope | null>(() => (root === null ? null : { box: boxId, root }), [boxId, root]);
  const tabs = useFileTabs(scope, os);

  useEffect(() => {
    if (memory?.state.root == null) rootRef.current?.focus({ preventScroll: true });
  }, []);

  const [indexEntries, setIndexEntries] = useWorkspaceState("indexEntries", []);
  const [indexFilling, setIndexFilling] = useState(true);
  const [indexTruncated, setIndexTruncated] = useState(false);
  const [loadingFolders, setLoadingFolders] = useState<ReadonlySet<string>>(new Set());
  const [folderErrors, setFolderErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [indexError, setIndexError] = useState<string | null>(null);
  const [indexPartial, setIndexPartial] = useState(false);
  const folderLoader = useRef<(path: string) => void>(() => {});
  const loadedFolders = useRef(new Set(memory?.loadedFolders));
  useEffect(() => () => { if (memory?.valid) memory.loadedFolders = loadedFolders.current; }, [memory]);
  const applyTree = useCallback((result: { paths: string[]; directories: string[]; truncated: boolean }) => {
    setNames(result.paths);
    setDirectories(result.directories);
    setTruncated(result.truncated);
    setTreeStatus("ready");
  }, []);
  const loadTree = useCallback((target: string | null, refresh = false) => {
    const reloadFolders = refresh ? [...loadedFolders.current] : [];
    const generation = ++requestRef.current;
    loadedFolders.current.clear();
    setLoadingFolders(new Set());
    setFolderErrors(new Map());
    if (!refresh) setIndexEntries([]);
    setIndexTruncated(false);
    setIndexError(null);
    setTreeError(null);
    if (!refresh) setTreeStatus("loading");
    setIndexFilling(true);
    void rpc.call("files.tree", { box: boxId, path: target, hidden: includeHidden, refresh }).then((result) => {
      if (generation !== requestRef.current) return;
      if (result.error !== null) { setTreeError(result.error); setTreeStatus("error"); return; }
      if (target === null) setHome(result.path);
      if (memory && requestedRoot.current !== null && requestedRoot.current !== result.path) {
        memory.state.expanded = new Set();
        memory.treeTop = 0;
      }
      setRoot(result.path);
      requestedRoot.current = result.path;
      if (refresh) {
        const descendants = (paths: string[]) => paths.filter((path) => path.includes("/") && result.directories.includes(path.split("/")[0]!));
        setNames((current) => [...result.paths, ...descendants(current)]);
        setDirectories((current) => [...result.directories, ...descendants(current)]);
        setTreeStatus("ready");
        setTruncated(result.truncated);
        for (const folder of reloadFolders) folderLoader.current(folder);
      } else applyTree(result);
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (generation !== requestRef.current) return;
        if (result.cached) void rpc.call("files.tree", { box: boxId, path: target, hidden: includeHidden, refresh: true }).then((fresh) => {
          if (generation === requestRef.current && fresh.error === null) {
            const descendants = (paths: string[]) => paths.filter((path) => path.includes("/") && fresh.directories.includes(path.split("/")[0]!));
            setNames((current) => [...fresh.paths, ...descendants(current)]);
            setDirectories((current) => [...fresh.directories, ...descendants(current)]);
            setTruncated(fresh.truncated);
          }
        });
        void rpc.call("files.tree", { box: boxId, path: result.path, hidden: includeHidden, recursive: true, refresh: true }).then((index) => {
          if (generation !== requestRef.current) return;
          setIndexFilling(false);
          setIndexTruncated(index.error === null && index.truncated);
          setIndexPartial(index.error === null && index.partial);
          setIndexError(index.error);
          if (index.error === null) setIndexEntries([...index.paths.map((path) => ({ path, kind: "file" as const }))]);
        });
      }));
    });
  }, [applyTree, boxId, includeHidden, rpc]);
  useEffect(() => {
    const visibilityChanged = previousHidden.current !== includeHidden;
    previousHidden.current = includeHidden;
    const restoring = requestedRoot.current !== null;
    if (!visibilityChanged && !restoring) { setNames([]); setDirectories([]); setIndexEntries([]); }
    if (previousBox.current !== boxId) { requestedRoot.current = null; previousBox.current = boxId; }
    loadTree(visibilityChanged ? root : requestedRoot.current, visibilityChanged || restoring);
    return () => { requestRef.current++; };
  }, [loadTree]);
  const loadFolder = useCallback((relative: string) => {
    if (root === null || loadedFolders.current.has(relative)) return;
    const path = absoluteFrom(os, root, relative);
    if (path === null) {
      setFolderErrors((current) => new Map([...current, [relative, "That folder path cannot be opened."]]));
      return;
    }
    loadedFolders.current.add(relative);
    const generation = requestRef.current;
    setLoadingFolders((current) => new Set([...current, relative]));
    const read = async (refresh: boolean): Promise<void> => {
      const result = await rpc.call("files.tree", { box: boxId, path, hidden: includeHidden, refresh });
      if (generation !== requestRef.current) return;
      setLoadingFolders((current) => new Set([...current].filter((path) => path !== relative)));
      if (result.error !== null) {
        loadedFolders.current.delete(relative);
        setFolderErrors((current) => new Map([...current, [relative, result.error]]));
        return;
      }
      setFolderErrors((current) => new Map([...current].filter(([path]) => path !== relative)));
      if (result.truncated || result.partial) setFolderErrors((current) => new Map([...current, [relative, result.truncated ? "Showing the first 5,000 entries. Open a smaller folder to see more." : "Some entries could not be read."]]));
      const keep = (paths: string[]) => paths.filter((path) => {
        if (!path.startsWith(`${relative}/`)) return true;
        const child = path.slice(relative.length + 1);
        return child.includes("/") && result.directories.includes(child.split("/")[0]!);
      });
      setNames((current) => [...keep(current), ...result.paths.map((path) => `${relative}/${path}`)]);
      setDirectories((current) => [...keep(current), ...result.directories.map((path) => `${relative}/${path}`)]);
      if (result.cached) void read(true);
    };
    void read(false);
  }, [boxId, includeHidden, os, root, rpc]);
  folderLoader.current = loadFolder;

  const entries = useMemo<FlatEntry[]>(
    () => [
      ...visibleNames(directories, includeHidden).map((path) => ({ path, kind: "directory" as const })),
      ...visibleNames(names, includeHidden).map((path) => ({ path, kind: "file" as const })),
    ],
    [directories, includeHidden, names],
  );

  useEffect(() => {
    const node = rootRef.current;
    if (node === null) return;
    const apply = () => {
      if (node.clientWidth > 0) setFrameWidth(node.clientWidth);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const narrow = showsOneSurface(frameWidth);
  const narrowRef = useRef(narrow);
  narrowRef.current = narrow;

  const restoreFocus = useCallback(() => {
    const node = rootRef.current;
    if (node === null) return;
    if (node.contains(document.activeElement)) return;
    node.focus({ preventScroll: true });
  }, []);

  const openFile = useCallback(
    (path: string) => {
      setReveal(null);
      tabs.open(path);
      setFindRequest(0);
      if (narrowRef.current) setTreeForward(false);
      requestAnimationFrame(restoreFocus);
    },
    [restoreFocus, tabs],
  );

  const placeOf = useCallback(
    (relative: string) => {
      if (root === null) return null;
      return absoluteFrom(os, root, relative);
    },
    [os, root],
  );

  const createEntry = useCallback(
    async (parent: string, kind: EntryKind, name: string) => {
      const relative = createdPath(parent, name);
      const abs = relative === null ? null : placeOf(relative);
      if (scope === null || abs === null) return "Use a name without slashes.";
      const mutationGeneration = requestRef.current;
      const result = await rpc.call("files.create", { box: boxId, path: abs, kind });
      if (mutationGeneration !== requestRef.current) return null;
      if (result.error !== null) return result.error;
      if (parent !== "") loadedFolders.current.add(parent);
      loadTree(root, true);
      if (kind === "file" && relative !== null) openFile(relative);
      return null;
    },
    [boxId, loadTree, openFile, placeOf, root, rpc, scope],
  );

  const renameEntry = useCallback(
    async (path: string, name: string) => {
      const relative = renamedPath(path, name);
      if (relative === null) return "Use a name without slashes.";
      if (relative === path) return null;
      const from = placeOf(path);
      const to = placeOf(relative);
      if (from === null || to === null) return "That name cannot be used.";
      const mutationGeneration = requestRef.current;
      const result = await rpc.call("files.rename", { box: boxId, from, to });
      if (mutationGeneration !== requestRef.current) return null;
      if (result.error !== null) return result.error;
      tabs.retarget(path, relative);
      loadTree(root, true);
      return null;
    },
    [boxId, loadTree, placeOf, root, rpc, tabs],
  );

  const deleteEntry = useCallback(
    async (path: string) => {
      const abs = placeOf(path);
      if (abs === null || home === null) return "That path cannot be changed.";
      const mutationGeneration = requestRef.current;
      const result = await rpc.call("files.delete", { box: boxId, path: abs, home });
      if (mutationGeneration !== requestRef.current) return null;
      if (result.error !== null) return result.error;
      tabs.closeUnder(path);
      loadTree(root, true);
      return null;
    },
    [boxId, home, loadTree, placeOf, root, rpc, tabs],
  );

  const openMatch = useCallback(
    (path: string, line: number) => {
      openFile(path);
      tabs.showSource(path);
      revealNonce.current += 1;
      setReveal({ path, line, nonce: revealNonce.current });
    },
    [openFile, tabs],
  );

  const closeTab = useCallback(
    (path: string) => {
      const tab = tabs.tabs.find((candidate) => candidate.path === path);
      if (tab !== undefined && isDirty(tab)) {
        toast.warning(`${path} has unsaved changes`, {
          action: { label: "Close anyway", onClick: () => tabs.close(path) },
        });
        return;
      }
      tabs.close(path);
    },
    [tabs],
  );

  const closeMany = useCallback(
    (doomed: readonly FileTab[], run: () => void) => {
      const dirtyCount = doomed.filter(isDirty).length;
      if (dirtyCount > 0) {
        toast.warning(dirtyCount === 1 ? "1 file has unsaved changes" : `${dirtyCount} files have unsaved changes`, {
          action: { label: "Close anyway", onClick: run },
        });
        return;
      }
      run();
    },
    [],
  );

  const closeOtherTabs = useCallback(
    (path: string) => {
      closeMany(
        tabs.tabs.filter((tab) => tab.path !== path),
        () => tabs.closeOthers(path),
      );
    },
    [closeMany, tabs],
  );

  const closeAllTabs = useCallback(() => {
    closeMany(tabs.tabs, () => tabs.closeAll());
  }, [closeMany, tabs]);

  const activeTab = tabs.activeTab;

  const openFind = () => {
    if (activeTab === null) return;
    tabs.showSource(activeTab.path);
    setFindRequest((current) => current + 1);
  };

  if (findRequest > 0 && activeTab?.mode === "preview") setFindRequest(0);
  const isFindShowing = findRequest > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const isAccel = event.metaKey || event.ctrlKey;
    if (isAccel && event.key.toLowerCase() === "p" && !event.shiftKey) {
      event.preventDefault();
      setIsQuickOpen(true);
      return;
    }
    if (isAccel && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setIsExplorerOpen(true);
      setSearchFocusRequest((current) => current + 1);
      return;
    }
    if (isAccel && event.key.toLowerCase() === "f" && !event.shiftKey) {
      event.preventDefault();
      if (activeTab?.file?.kind === "text") openFind();
      return;
    }
    if (isAccel && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (activeTab !== null && isDirty(activeTab) && activeTab.save.kind !== "saving" && activeTab.file?.kind === "text" && activeTab.file.editable) {
        tabs.save();
      }
      return;
    }
    if (event.key === "Escape" && isQuickOpen) {
      event.preventDefault();
      setIsQuickOpen(false);
      return;
    }
    if (event.key === "Escape" && isFindShowing) {
      event.preventDefault();
      setFindRequest(0);
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      setExplorerWidth(clampWidth(startWidth - moveEvent.clientX + startX));
    };
    const stop = () => {
      target.releasePointerCapture(event.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      setExplorerWidth((width) => {
        storeWidth(width);
        return width;
      });
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  };

  const go = (next: string) => {
    setNames([]);
    setDirectories([]);
    loadTree(next);
    setIsQuickOpen(false);
  };

  const header = (
    <div className="flex min-w-0 flex-1 items-center">
      <PathBar
        os={os}
        home={home}
        path={root ?? ""}
        onGo={(next) => {
          if (next === null) {
            setTreeError("That path cannot be opened.");
            return;
          }
          go(next);
        }}
      />
    </div>
  );

  const showTree = narrow ? treeForward || tabs.activePath === null : isExplorerOpen;
  const showFile = narrow ? !showTree : true;

  return (
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background focus:outline-none"
    >
      {showFile ? <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EditorTabs
          tabs={tabs.tabs}
          activePath={tabs.activePath}
          onActivate={tabs.activate}
          onClose={closeTab}
          onCloseOthers={closeOtherTabs}
          onCloseAll={closeAllTabs}
        />
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
          <Breadcrumb root={root} path={activeTab?.path ?? null} />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {activeTab?.file?.kind === "text" ? (
              <>
                <span className="hidden px-2 text-[11px] text-muted-foreground md:inline">{fileMetaLabel(activeTab)}</span>
                <ModeToggle
                  mode={activeTab.mode}
                  isMarkdown={isMarkdownPath(activeTab.path)}
                  canPreview={canPreview(activeTab)}
                  canEdit={activeTab.file.editable}
                  onChange={(next) => tabs.setMode(activeTab.path, next)}
                />
                <ToolbarButton
                  icon="Search"
                  label="Find in file"
                  isActive={isFindShowing}
                  onClick={() => (isFindShowing ? setFindRequest(0) : openFind())}
                />
                <ToolbarButton
                  icon="Check"
                  label={activeTab.save.kind === "saving" ? "Saving..." : "Save"}
                  isDisabled={!activeTab.file.editable || !isDirty(activeTab) || activeTab.save.kind === "saving"}
                  isSpinning={activeTab.save.kind === "saving"}
                  onClick={tabs.save}
                />
              </>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => (narrow ? setTreeForward(true) : setIsExplorerOpen((open) => !open))}
            aria-label={narrow ? "Back to the files" : isExplorerOpen ? "Hide the file explorer" : "Show the file explorer"}
            className={cn(
              "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md",
              "text-muted-foreground hover:bg-state-hover hover:text-foreground",
              "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
              !narrow && isExplorerOpen && "text-foreground",
            )}
          >
            <Icon name={narrow ? "ArrowLeft" : "PanelLeft"} aria-hidden className={cn("size-3.5", !narrow && "rotate-180")} />
          </button>
        </div>
        {activeTab === null ? (
          <EmptyEditor hasRoot={root !== null} error={treeError} truncated={truncated} onQuickOpen={() => setIsQuickOpen(true)} />
        ) : (
          <FileView
            key={activeTab.path}
            tab={activeTab}
            onChangeDraft={tabs.setDraft}
            onSave={tabs.save}
            onReload={() => tabs.reload()}
            onOverwrite={tabs.overwrite}
            onRetry={tabs.retry}
            onShowSlice={tabs.showSlice}
            revealLine={reveal !== null && reveal.path === activeTab.path ? { line: reveal.line, nonce: reveal.nonce } : null}
            findRequest={findRequest}
            onCloseFind={() => {
              setFindRequest(0);
              restoreFocus();
            }}
          />
        )}
      </div> : null}
      {showTree ? (
        <>
          {showFile ? (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file explorer"
              onPointerDown={startResize}
              onDoubleClick={() => {
                setExplorerWidth(DEFAULT_EXPLORER_PX);
                storeWidth(DEFAULT_EXPLORER_PX);
              }}
              className="w-px shrink-0 cursor-col-resize bg-border transition-colors hover:bg-ring"
            />
          ) : null}
          <div style={showFile ? { width: explorerWidth } : undefined} className={showFile ? "flex min-h-0 shrink-0 flex-col overflow-hidden" : "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"}>
            <Explorer
              onLoadFolder={loadFolder}
              loadingFolders={loadingFolders}
              folderErrors={folderErrors}
              entries={entries}
              activePath={tabs.activePath}
              isLoading={treeStatus === "loading"}
              error={treeError}
              truncated={truncated}
              hiddenSupported
              includeHidden={includeHidden}
              onToggleHidden={(next) => {
                setIncludeHidden(next);
                storeHidden(next);
              }}
              onOpenFile={openFile}
              onOpenMatch={openMatch}
              onRefresh={() => loadTree(root, true)}
              onQuickOpen={() => setIsQuickOpen(true)}
              onCreate={createEntry}
              onRename={renameEntry}
              onDelete={deleteEntry}
              scope={scope}
              searchFocusRequest={searchFocusRequest}
              header={header}
            />
          </div>

        </>
      ) : null}

      {isQuickOpen ? <QuickOpen error={indexError} partial={indexPartial} truncated={indexTruncated} filling={indexFilling} entries={indexFilling || indexError !== null ? [...entries, ...indexEntries] : indexEntries} onOpenFile={openFile} onClose={() => setIsQuickOpen(false)} /> : null}
    </div>
  );
}

function PathBar({
  os,
  home,
  path,
  onGo,
}: {
  os: GuestOs;
  home: string | null;
  path: string;
  onGo: (next: string | null) => void;
}) {
  const [draft, setDraft] = useState(path);
  useEffect(() => setDraft(path), [path]);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (path === "") return;
        onGo(resolvePath(os, path, draft));
      }}
    >
      <input
        aria-label="Path"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
      />
      <button
        type="button"
        aria-label="Up"
        disabled={path === ""}
        onClick={() => onGo(parentPath(os, path))}
        className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground disabled:cursor-default disabled:opacity-40"
      >
        <Icon name="ArrowUp" aria-hidden className="size-3.5" />
      </button>
    </form>
  );
}

function Breadcrumb({ root, path }: { root: string | null; path: string | null }) {
  if (root === null) return <span className="truncate text-xs text-muted-foreground">No folder</span>;
  const segments = path === null ? [] : path.split("/");
  const rootLabel = root.split(/[/\\]/).filter(Boolean).at(-1) ?? root;
  return (
    <nav aria-label="File location" title={path === null ? root : `${root}/${path}`} className="flex min-w-0 items-center gap-1 overflow-hidden text-xs">
      <span className="shrink-0 text-muted-foreground">{rootLabel}</span>
      {segments.map((segment, index) => (
        <span key={`${segment}-${index}`} className="flex min-w-0 items-center gap-1">
          <Icon name="ChevronRight" aria-hidden className="size-3 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", index === segments.length - 1 ? "text-foreground" : "text-muted-foreground")}>{segment}</span>
        </span>
      ))}
    </nav>
  );
}

function EmptyEditor({ hasRoot, error, truncated, onQuickOpen }: { hasRoot: boolean; error: string | null; truncated: boolean; onQuickOpen: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon name="Code" aria-hidden className="size-8 text-muted-foreground/60" />
      {error !== null ? (
        <p className="max-w-sm text-sm text-destructive-text">{error}</p>
      ) : !hasRoot ? (
        <p className="max-w-sm text-sm text-muted-foreground">Reading the box user's home.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Select a file to open it, or{" "}
            <button type="button" onClick={onQuickOpen} className="cursor-pointer text-foreground underline underline-offset-2">
              go to file
            </button>
            .
          </p>
          <p className="max-w-md text-xs text-muted-foreground">
            The tree skips .git, node_modules and vendor.
            {truncated ? " The listing hit its size limit." : ""}
          </p>
        </>
      )}
    </div>
  );
}

function ModeToggle({
  mode,
  isMarkdown,
  canPreview: previewOk,
  canEdit,
  onChange,
}: {
  mode: FileViewMode;
  isMarkdown: boolean;
  canPreview: boolean;
  canEdit: boolean;
  onChange: (mode: FileViewMode) => void;
}) {
  return (
    <div role="group" aria-label="File mode" className="flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">
      {isMarkdown ? (
        <ModeSegment icon="FileText" label="Preview" isSelected={mode === "preview"} isDisabled={!previewOk} title={previewOk ? undefined : "This file is too large to preview"} onClick={() => onChange("preview")} />
      ) : null}
      <ModeSegment icon="Eye" label="Read" isSelected={mode === "read"} onClick={() => onChange("read")} />
      <ModeSegment icon="Edit" label="Edit" isSelected={mode === "edit"} isDisabled={!canEdit && mode !== "edit"} title={canEdit ? undefined : "This file is too large to edit"} onClick={() => onChange("edit")} />
    </div>
  );
}

function ModeSegment({
  icon,
  label,
  isSelected,
  isDisabled,
  title,
  onClick,
}: {
  icon: string;
  label: string;
  isSelected: boolean;
  isDisabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-pressed={isSelected}
      aria-label={title ?? label}
      className={cn(
        "flex h-6 items-center gap-1 rounded px-1.5 text-[11px] transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true ? "cursor-default text-muted-foreground opacity-40" : isSelected ? "cursor-pointer bg-state-active text-foreground" : "cursor-pointer text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className="size-3" />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  isActive,
  isDisabled,
  isSpinning,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  isActive?: boolean;
  isDisabled?: boolean;
  isSpinning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      aria-label={label}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
        isDisabled === true ? "cursor-default opacity-40" : "cursor-pointer hover:bg-state-hover hover:text-foreground",
        isActive === true && "text-foreground",
      )}
    >
      <Icon name={icon} aria-hidden className={cn("size-3.5", isSpinning === true && "animate-spin")} />
    </button>
  );
}

function clampWidth(value: number): number {
  return Math.min(MAX_EXPLORER_PX, Math.max(MIN_EXPLORER_PX, Math.round(value)));
}

function readStoredWidth(): number {
  const stored = safeRead(WIDTH_STORAGE_KEY);
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  if (Number.isFinite(parsed)) return clampWidth(parsed);
  return DEFAULT_EXPLORER_PX;
}

function readFrame(): number {
  return typeof window === "undefined" ? DEFAULT_EXPLORER_PX * 3 : window.innerWidth;
}

function storeWidth(value: number): void {
  safeWrite(WIDTH_STORAGE_KEY, String(value));
}

function readStoredHidden(): boolean {
  return safeRead(HIDDEN_STORAGE_KEY) === "true";
}

function storeHidden(value: boolean): void {
  safeWrite(HIDDEN_STORAGE_KEY, value ? "true" : "false");
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}
