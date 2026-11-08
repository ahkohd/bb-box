import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { FilesRead } from "../../core/box-fs.ts";
import type { Contract } from "../../plugin/contract.ts";
import type { GuestOs } from "../../transports/types.ts";
import { allowedMode, isMarkdownPath, type FileViewMode } from "./markdown.ts";
import { movedPath } from "./entry-name.ts";
import { absoluteFrom } from "./locate.ts";
import type { FilesScope } from "./files-scope.ts";

export type FileContent =
  | {
      kind: "text";
      content: string;
      sha256: string;
      sizeBytes: number;
      absolutePath: string;
      editable: boolean;
    }
  | {
      kind: "image";
      dataUrl: string;
      sizeBytes: number;
      absolutePath: string;
    }
  | {
      kind: "binary";
      sizeBytes: number;
      absolutePath: string;
      reason: string;
    }
  | {
      kind: "large";
      sizeBytes: number;
      absolutePath: string;
      sha256: string;
    };

export type { FileViewMode };

export type SaveState =
  | { kind: "clean" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface FileTab {
  path: string;
  file: FileContent | null;
  error: string | null;
  draft: string | null;
  sha256: string | null;
  mode: FileViewMode;
  save: SaveState;
}

export function renderedText(tab: FileTab): string | null {
  if (tab.draft !== null) return tab.draft;
  return tab.file !== null && tab.file.kind === "text" ? tab.file.content : null;
}

export function canPreview(tab: FileTab): boolean {
  return allowedMode("preview", tab.path, renderedText(tab)) === "preview";
}

export function isDirty(tab: FileTab): boolean {
  if (tab.draft === null) return false;
  if (tab.file === null || tab.file.kind !== "text") return false;
  return tab.draft !== tab.file.content;
}

export interface FileTabsApi {
  tabs: FileTab[];
  activePath: string | null;
  activeTab: FileTab | null;
  open(path: string): void;
  close(path: string): string | null;
  closeOthers(path: string): string | null;
  closeAll(): void;
  activate(path: string): void;
  setDraft(path: string, draft: string): void;
  setMode(path: string, mode: FileViewMode): void;
  showSource(path: string): void;
  save(): void;
  overwrite(): void;
  reload(path?: string): void;
  retarget(from: string, to: string): void;
  closeUnder(path: string): void;
  retry(): void;
  showSlice(): void;
  reset(): void;
}

interface Place {
  box: string;
  root: string;
  os: GuestOs;
}

const MAX_TABS = 12;
const SLICE_BYTES = 262144;

export function useFileTabs(scope: FilesScope | null, os: GuestOs): FileTabsApi {
  const rpc = useRpc<Contract>();
  const [tabs, setTabs] = useState<FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  const readSequence = useRef(0);
  const inFlightRead = useRef(new Map<string, number>());
  const writeSequence = useRef(0);
  const inFlightWrite = useRef(new Map<string, number>());
  const placeRef = useRef<Place | null>(scope === null ? null : { ...scope, os });
  placeRef.current = scope === null ? null : { ...scope, os };

  const scopeKey = scope === null ? "" : `${scope.box}\0${scope.root}`;
  useEffect(() => {
    inFlightRead.current.clear();
    inFlightWrite.current.clear();
    setTabs([]);
    setActivePath(null);
  }, [scopeKey]);

  const patch = useCallback((path: string, update: (tab: FileTab) => FileTab) => {
    setTabs((current) => current.map((tab) => (tab.path === path ? update(tab) : tab)));
  }, []);

  const load = useCallback(
    (path: string) => {
      const place = placeRef.current;
      if (place === null) return;
      const abs = absoluteFrom(place.os, place.root, path);
      if (abs === null) {
        patch(path, (tab) => ({ ...tab, error: "That path cannot be opened." }));
        return;
      }
      const generation = (readSequence.current += 1);
      inFlightRead.current.set(path, generation);
      patch(path, (tab) => ({ ...tab, error: null }));
      const current = () => inFlightRead.current.get(path) === generation && samePlace(placeRef.current, place);
      void rpc
        .call("files.read", { box: place.box, path: abs })
        .then((result) => {
          if (!current()) return;
          if (result.error !== null) {
            patch(path, (tab) => ({ ...tab, error: result.error }));
            return;
          }
          const file = contentOf(result, abs);
          patch(path, (tab) => ({
            ...tab,
            file,
            error: null,
            draft: null,
            sha256: file.kind === "text" || file.kind === "large" ? file.sha256 : null,
            mode: allowedMode(tab.mode, path, file.kind === "text" ? file.content : null),
            save: { kind: "clean" },
          }));
        })
        .catch((error: unknown) => {
          if (!current()) return;
          patch(path, (tab) => ({ ...tab, error: messageOf(error, "Could not open this file.") }));
        });
    },
    [patch, rpc],
  );

  const open = useCallback(
    (path: string) => {
      setActivePath(path);
      if (tabsRef.current.some((tab) => tab.path === path)) return;
      const tab: FileTab = {
        path,
        file: null,
        error: null,
        draft: null,
        sha256: null,
        mode: isMarkdownPath(path) ? "preview" : "read",
        save: { kind: "clean" },
      };
      setTabs((current) => {
        if (current.some((existing) => existing.path === path)) return current;
        const next = [...current, tab];
        if (next.length <= MAX_TABS) return next;
        const evictable = next.findIndex((candidate) => candidate.path !== path && !isDirty(candidate));
        return evictable === -1 ? next : next.filter((_, index) => index !== evictable);
      });
      load(path);
    },
    [load],
  );

  const close = useCallback((path: string): string | null => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.path === path);
    if (index === -1) return activePathRef.current;
    inFlightRead.current.delete(path);
    inFlightWrite.current.delete(path);
    const remaining = current.filter((tab) => tab.path !== path);
    setTabs((live) => live.filter((tab) => tab.path !== path));
    if (activePathRef.current !== path) return activePathRef.current;
    const nextActive = (remaining[index] ?? remaining[index - 1])?.path ?? null;
    setActivePath(nextActive);
    return nextActive;
  }, []);

  const closeOthers = useCallback((path: string): string | null => {
    for (const tab of tabsRef.current) {
      if (tab.path === path) continue;
      inFlightRead.current.delete(tab.path);
      inFlightWrite.current.delete(tab.path);
    }
    const kept = tabsRef.current.filter((tab) => tab.path === path);
    setTabs((live) => live.filter((tab) => tab.path === path));
    setActivePath(kept[0]?.path ?? null);
    return kept[0]?.path ?? null;
  }, []);

  const closeAll = useCallback(() => {
    inFlightRead.current.clear();
    inFlightWrite.current.clear();
    setTabs([]);
    setActivePath(null);
  }, []);

  const writeActive = useCallback(
    (guard: string | "force") => {
      const place = placeRef.current;
      const path = activePathRef.current;
      if (place === null || path === null) return;
      const tab = tabsRef.current.find((candidate) => candidate.path === path);
      if (tab === undefined || tab.draft === null || tab.save.kind === "saving") return;
      if (tab.file?.kind === "text" && !tab.file.editable) return;
      const abs = absoluteFrom(place.os, place.root, path);
      if (abs === null) return;
      const content = tab.draft;
      const generation = (writeSequence.current += 1);
      inFlightWrite.current.set(path, generation);
      const current = () => inFlightWrite.current.get(path) === generation && samePlace(placeRef.current, place);
      patch(path, (item) => ({ ...item, save: { kind: "saving" } }));
      void rpc
        .call("files.write", {
          box: place.box,
          path: abs,
          content,
          expectedSha256: guard === "force" ? null : guard,
        })
        .then((result) => {
          if (!current()) return;
          if (result.error !== null) {
            patch(path, (item) => ({ ...item, save: { kind: "error", message: result.error } }));
            return;
          }
          if (result.outcome === "conflict") {
            patch(path, (item) => ({ ...item, save: { kind: "conflict" } }));
            return;
          }
          patch(path, (item) => ({
            ...item,
            save: { kind: "clean" },
            sha256: result.sha256,
            draft: item.draft === content ? null : item.draft,
            file:
              item.file !== null && item.file.kind === "text"
                ? { ...item.file, content, sha256: result.sha256, sizeBytes: result.sizeBytes }
                : item.file,
          }));
        })
        .catch((error: unknown) => {
          if (!current()) return;
          patch(path, (item) => ({ ...item, save: { kind: "error", message: messageOf(error, "Save failed.") } }));
        });
    },
    [patch, rpc],
  );

  const showSlice = useCallback(() => {
    const place = placeRef.current;
    const path = activePathRef.current;
    if (place === null || path === null) return;
    const abs = absoluteFrom(place.os, place.root, path);
    if (abs === null) return;
    const generation = (readSequence.current += 1);
    inFlightRead.current.set(path, generation);
    const current = () => inFlightRead.current.get(path) === generation && samePlace(placeRef.current, place);
    void rpc
      .call("files.readRange", { box: place.box, path: abs, start: 0, length: SLICE_BYTES })
      .then((result) => {
        if (!current()) return;
        if (result.error !== null) {
          patch(path, (tab) => ({ ...tab, error: result.error }));
          return;
        }
        patch(path, (tab) => ({
          ...tab,
          error: null,
          draft: null,
          sha256: result.sha256,
          mode: "read",
          save: { kind: "clean" },
          file: {
            kind: "text",
            content: result.content,
            sha256: result.sha256,
            sizeBytes: result.sizeBytes,
            absolutePath: abs,
            editable: false,
          },
        }));
      })
      .catch((error: unknown) => {
        if (!current()) return;
        patch(path, (tab) => ({ ...tab, error: messageOf(error, "Could not read this file.") }));
      });
  }, [patch, rpc]);

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;

  return {
    tabs,
    activePath,
    activeTab,
    open,
    close,
    closeOthers,
    closeAll,
    activate: setActivePath,
    setDraft: useCallback((path, draft) => patch(path, (tab) => ({ ...tab, draft })), [patch]),
    setMode: useCallback(
      (path, mode) => patch(path, (tab) => ({ ...tab, mode: allowedMode(mode, path, renderedText(tab)) })),
      [patch],
    ),
    showSource: useCallback(
      (path) => patch(path, (tab) => (tab.mode === "preview" ? { ...tab, mode: "read" } : tab)),
      [patch],
    ),
    save: useCallback(() => {
      const path = activePathRef.current;
      const tab = tabsRef.current.find((candidate) => candidate.path === path);
      writeActive(tab?.sha256 ?? "force");
    }, [writeActive]),
    overwrite: useCallback(() => {
      writeActive("force");
    }, [writeActive]),
    retarget: useCallback((from: string, to: string) => {
      const mapKey = (path: string) => movedPath(path, from, to) ?? path;
      const moveMap = (flight: Map<string, number>) => {
        for (const [path, generation] of [...flight]) {
          const next = mapKey(path);
          if (next === path) continue;
          flight.delete(path);
          flight.set(next, generation);
        }
      };
      moveMap(inFlightRead.current);
      moveMap(inFlightWrite.current);
      setTabs((live) => live.map((tab) => (movedPath(tab.path, from, to) === null ? tab : { ...tab, path: mapKey(tab.path) })));
      setActivePath((path) => (path === null ? null : mapKey(path)));
    }, []),
    closeUnder: useCallback((path: string) => {
      const covers = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      for (const tab of tabsRef.current) {
        if (!covers(tab.path)) continue;
        inFlightRead.current.delete(tab.path);
        inFlightWrite.current.delete(tab.path);
      }
      const remaining = tabsRef.current.filter((tab) => !covers(tab.path));
      setTabs(remaining);
      setActivePath((current) => (current !== null && covers(current) ? (remaining[0]?.path ?? null) : current));
    }, []),
    reload: useCallback(
      (path?: string) => {
        const target = path ?? activePathRef.current;
        if (target === null) return;
        patch(target, (tab) => {
          const next: FileTab = { ...tab, draft: null, save: { kind: "clean" } };
          const text = renderedText(next);
          return text === null ? next : { ...next, mode: allowedMode(next.mode, target, text) };
        });
        load(target);
      },
      [load, patch],
    ),
    retry: useCallback(() => {
      const target = activePathRef.current;
      if (target !== null) load(target);
    }, [load]),
    showSlice,
    reset: useCallback(() => {
      inFlightRead.current.clear();
      inFlightWrite.current.clear();
      setTabs([]);
      setActivePath(null);
    }, []),
  };
}

function samePlace(left: Place | null, right: Place): boolean {
  return left !== null && left.box === right.box && left.root === right.root;
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== "" ? error.message : fallback;
}

function contentOf(result: Exclude<FilesRead, { error: string }>, absolutePath: string): FileContent {
  if (result.kind === "text") {
    return { kind: "text", content: result.content, sha256: result.sha256, sizeBytes: result.sizeBytes, absolutePath, editable: true };
  }
  if (result.kind === "image") {
    return { kind: "image", dataUrl: result.dataUrl, sizeBytes: result.sizeBytes, absolutePath };
  }
  if (result.kind === "binary") {
    return { kind: "binary", reason: result.reason, sizeBytes: result.sizeBytes, absolutePath };
  }
  return { kind: "large", sha256: result.sha256, sizeBytes: result.sizeBytes, absolutePath };
}
