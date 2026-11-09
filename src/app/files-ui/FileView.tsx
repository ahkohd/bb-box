import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  experimental_SourceCode as SourceCode,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, languageLabel } from "./file-kind.ts";
import { findMatches, matchIndexAt, stepMatch } from "./find.ts";
import { FindBar } from "./FindBar.tsx";
import { sourcePath } from "./locate.ts";
import type { FileTab } from "./use-file-tabs.ts";

import { useWorkspaceMemory } from "./workspace-context.tsx";
import { fileViewMemory, type ViewMemory } from "./workspace-memory.ts";

import { readTextSelection, restoreTextSelection } from "./text-selection.ts";

export interface FileViewProps {
  tab: FileTab;
  onChangeDraft: (path: string, draft: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  onRetry: () => void;
  onShowSlice: () => void;

  findRequest: number;
  onCloseFind: () => void;

  revealLine: { line: number; nonce: number } | null;
}

interface EditorSelection {
  start: number;
  end: number;
  nonce: number;
}

export function FileView({
  tab,
  onChangeDraft,
  onSave,
  onReload,
  onOverwrite,
  onRetry,
  onShowSlice,
  findRequest,
  onCloseFind,
  revealLine,
}: FileViewProps) {
  const memory = useWorkspaceMemory();
  const [view] = useState(() => fileViewMemory(memory, tab.path));
  const file = tab.file;

  if (file === null) {
    return tab.error === null ? (
      <Centered>
        <Icon name="Loading" aria-hidden className="size-4 animate-spin" />
        <span>Opening {tab.path}...</span>
      </Centered>
    ) : (
      <Centered tone="error">
        <Icon name="AlertTriangle" aria-hidden className="size-4" />
        <span>{tab.error}</span>
        <button
          type="button"
          onClick={onRetry}
          className="cursor-pointer underline underline-offset-2"
        >
          Try again
        </button>
      </Centered>
    );
  }

  if (file.kind === "image") {
    return (
      <div ref={(node) => { if (node) { node.scrollTop = view.top; node.scrollLeft = view.left; } }} onScroll={(event) => { view.top = event.currentTarget.scrollTop; view.left = event.currentTarget.scrollLeft; }} className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
        <img
          src={file.dataUrl}
          alt={tab.path}
          className="mx-auto max-w-full rounded-md border border-border bg-card object-contain"
        />
        <p className="mt-3 text-center text-xs text-muted-foreground">
          {formatBytes(file.sizeBytes)}
        </p>
      </div>
    );
  }

  if (file.kind === "large") {
    return (
      <Centered>
        <Icon name="File" aria-hidden className="size-4" />
        <span>This file is too large to open ({formatBytes(file.sizeBytes)}).</span>
        <button type="button" onClick={onShowSlice} className="cursor-pointer underline underline-offset-2">
          Show the first 256 KB
        </button>
      </Centered>
    );
  }

  if (file.kind === "binary") {
    return (
      <Centered>
        <Icon name="File" aria-hidden className="size-4" />
        <span>
          {file.reason} ({formatBytes(file.sizeBytes)})
        </span>
      </Centered>
    );
  }

  return (
    <TextFileView
      tab={tab}
      content={tab.draft ?? file.content}
      onChangeDraft={onChangeDraft}
      onSave={onSave}
      onReload={onReload}
      onOverwrite={onOverwrite}
      findRequest={findRequest}
      onCloseFind={onCloseFind}
      revealLine={revealLine}
    />
  );
}

function TextFileView({
  tab,
  content,
  onChangeDraft,
  onSave,
  onReload,
  onOverwrite,
  findRequest,
  onCloseFind,
  revealLine,
}: {
  tab: FileTab;
  content: string;
  onChangeDraft: (path: string, draft: string) => void;
  onSave: () => void;
  onReload: () => void;
  onOverwrite: () => void;
  findRequest: number;
  onCloseFind: () => void;
  revealLine: { line: number; nonce: number } | null;
}) {
  const memory = useWorkspaceMemory();
  const [view] = useState(() => fileViewMemory(memory, tab.path));
  const [query, setQuery] = useState(view.query);
  const [caseSensitive, setCaseSensitive] = useState(view.caseSensitive);
  const [index, setIndex] = useState(view.index);
  const [selection, setSelection] = useState<EditorSelection | null>(null);
  const caretRef = useRef(view.start);
  const nonceRef = useRef(0);

  const isFindOpen = findRequest > 0;

  useLayoutEffect(() => {
    view.query = query;
    view.caseSensitive = caseSensitive;
    view.index = index;
  }, [view, query, caseSensitive, index]);

  const result = useMemo(
    () => (isFindOpen ? findMatches(content, query, caseSensitive) : null),
    [caseSensitive, content, isFindOpen, query],
  );
  const matches = result?.matches ?? [];

  const select = useCallback(
    (next: number) => {
      setIndex(next);
      const match = matches[next];
      if (match === undefined) return;
      caretRef.current = match.start;
      nonceRef.current += 1;
      setSelection({ start: match.start, end: match.end, nonce: nonceRef.current });
    },
    [matches],
  );

  useEffect(() => {
    if (!isFindOpen) return;
    setIndex(matchIndexAt(matches, caretRef.current));

  }, [query, caseSensitive, content, isFindOpen]);

  const step = useCallback(
    (direction: 1 | -1) => select(stepMatch(index, matches.length, direction)),
    [index, matches.length, select],
  );

  const active = matches[index];

  const viewRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (tab.mode === "edit") return;
    const root = tab.mode === "preview" ? previewRef.current : viewRef.current;
    if (!root) return;
    if (view.textSelection) restoreTextSelection(root, view.textSelection);
    const remember = () => {
      const selection = readTextSelection(root);
      if (selection) view.textSelection = selection;
    };
    document.addEventListener("selectionchange", remember);
    return () => document.removeEventListener("selectionchange", remember);
  }, [tab.mode, view]);
  const seenPathRef = useRef<string | null>(null);
  const seenModeRef = useRef<FileTab["mode"] | null>(null);
  const targetLine = revealLine?.line ?? null;
  const lineCount = useMemo(() => {
    let count = 1;
    for (let index = 0; index < content.length; index += 1) {
      if (content.charCodeAt(index) === 10) count += 1;
    }
    return count;
  }, [content]);
  useEffect(() => {

    const isSameFile = seenPathRef.current === tab.path;
    const previousMode = seenModeRef.current;
    seenPathRef.current = tab.path;
    seenModeRef.current = tab.mode;

    if (tab.mode !== "read") return;

    const findLine =
      isSameFile && previousMode === "preview" && isFindOpen
        ? matches[matchIndexAt(matches, caretRef.current)]?.line ?? null
        : null;
    const placeLine = targetLine ?? findLine;
    const root = viewRef.current;
    if (root === null) return;

    let cancelled = false;
    let observer: ResizeObserver | null = null;
    let timer = 0;
    let frame = 0;

    const attach = () => {
      if (cancelled) return;
      const port = root.querySelector<HTMLElement>('[class*="overflow-y-auto"]');
      if (port === null) {
        frame = requestAnimationFrame(attach);
        return;
      }

      const place = () => {
        if (placeLine === null) {
          port.scrollTop = view.top;
          port.scrollLeft = view.left;
          return;
        }

        const lineHeight = port.scrollHeight / lineCount;

        port.scrollTop = Math.max(0, (placeLine - 1) * lineHeight - port.clientHeight / 3);
      };
      place();
      if (view.textSelection) restoreTextSelection(root, view.textSelection);

      const release = () => {
        observer?.disconnect();
        observer = null;
        window.clearTimeout(timer);
        port.removeEventListener("wheel", release);
        port.removeEventListener("pointerdown", release);
        port.removeEventListener("keydown", release);
      };
      port.addEventListener("wheel", release, { passive: true });
      port.addEventListener("pointerdown", release);
      port.addEventListener("keydown", release);

      observer = new ResizeObserver(place);
      const inner = port.firstElementChild;
      if (inner !== null) observer.observe(inner);

      timer = window.setTimeout(release, 1500);
    };

    attach();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
    };

  }, [tab.path, tab.mode, targetLine, revealLine?.nonce]);

  useEffect(() => {
    if (tab.mode !== "edit" || revealLine === null) return;
    let offset = 0;
    for (let line = 1; line < revealLine.line && offset !== -1; line += 1) {
      offset = content.indexOf("\n", offset);
      if (offset !== -1) offset += 1;
    }
    if (offset === -1) return;
    const lineEnd = content.indexOf("\n", offset);
    caretRef.current = offset;
    nonceRef.current += 1;
    setSelection({
      start: offset,
      end: lineEnd === -1 ? content.length : lineEnd,
      nonce: nonceRef.current,
    });

  }, [revealLine?.nonce, tab.mode]);

  const markdown = useMemo(
    () => (tab.mode === "preview" ? <Markdown content={content} /> : null),
    [content, tab.mode],
  );

  const highlighted =
    active !== undefined
      ? { start: active.line, end: active.line }
      : revealLine !== null
        ? { start: revealLine.line, end: revealLine.line }
        : null;

  return (
    <div onScrollCapture={(event) => { if (event.target instanceof HTMLElement) { view.top = event.target.scrollTop; view.left = event.target.scrollLeft; } }} className="flex min-h-0 flex-1 flex-col">
      {isFindOpen ? (
        <FindBar
          query={query}
          onQueryChange={setQuery}
          caseSensitive={caseSensitive}
          onCaseSensitiveChange={setCaseSensitive}
          index={index}
          total={matches.length}
          truncated={result?.truncated ?? false}
          onStep={step}
          onClose={onCloseFind}
          focusRequest={findRequest}
        />
      ) : null}
      <SaveNotice tab={tab} onReload={onReload} onOverwrite={onOverwrite} />
      {tab.mode === "edit" ? (
        <CodeEditor
          view={view}
          path={tab.path}
          value={content}
          onChange={(next) => onChangeDraft(tab.path, next)}
          onSave={onSave}
          selection={selection}
          onCaretChange={(position) => {
            caretRef.current = position;
          }}
        />
      ) : tab.mode === "preview" ? (

        <div
          key={tab.path}
          ref={(node) => { previewRef.current = node; if (node) { node.scrollTop = view.top; node.scrollLeft = view.left; } }}
          tabIndex={0}
          role="region"
          aria-label={`Preview of ${tab.path}`}
          className="min-h-0 flex-1 overflow-auto focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
        >
          <div className="mx-auto w-full max-w-[52rem] p-5">
            {markdown}
          </div>
        </div>
      ) : (

        <div ref={viewRef} className="flex min-h-0 flex-1 flex-col">
        <SourceCode
          content={content}
          path={sourcePath(tab.path, `${tab.sha256 ?? "open"}-${content.length}`)}
          overflow="scroll"
          highlightedLines={highlighted ?? undefined}
          className="min-h-0 flex-1 text-[13px]"
        />
        </div>
      )}
    </div>
  );
}

function CodeEditor({
  view,
  path,
  value,
  onChange,
  onSave,
  selection,
  onCaretChange,
}: {
  view: ViewMemory;
  path: string;
  value: string;
  onChange: (next: string) => void;
  onSave: () => void;
  selection: EditorSelection | null;
  onCaretChange: (position: number) => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const gutterRef = useRef<HTMLPreElement | null>(null);

  const lineCount = useMemo(() => value.split("\n").length, [value]);

  const gutterText = useMemo(
    () => Array.from({ length: lineCount }, (_, index) => index + 1).join("\n"),
    [lineCount],
  );

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const { start, end, direction, top, left } = view;
    textarea.setSelectionRange(start, end, direction);
    textarea.focus({ preventScroll: true });
    textarea.scrollTop = top;
    textarea.scrollLeft = left;
    if (gutterRef.current) gutterRef.current.scrollTop = top;
    return () => {
      view.start = textarea.selectionStart;
      view.end = textarea.selectionEnd;
      view.direction = textarea.selectionDirection;
      view.top = textarea.scrollTop;
      view.left = textarea.scrollLeft;
    };
  }, [path, view]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null || selection === null) return;
    textarea.setSelectionRange(selection.start, selection.end);

    const lineHeight = 20;
    const linesAbove = value.slice(0, selection.start).split("\n").length - 1;
    const target =
      linesAbove * lineHeight - textarea.clientHeight / 2 + lineHeight;
    textarea.scrollTop = Math.max(0, target);
    if (gutterRef.current !== null) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }

  }, [selection?.nonce]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden bg-background font-mono text-[13px] leading-5">
      <pre
        ref={gutterRef}
        aria-hidden
        className="shrink-0 overflow-hidden border-r border-border bg-surface-recessed px-2 py-3 text-right font-mono text-[13px] leading-5 tabular-nums text-muted-foreground select-none"
      >
        {gutterText}
      </pre>
      <textarea
        ref={textareaRef}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label={`Edit ${path}`}
        onScroll={(event) => {
          if (gutterRef.current !== null) {
            gutterRef.current.scrollTop = event.currentTarget.scrollTop;
          }
        }}
        onChange={(event) => {
          onCaretChange(event.target.selectionStart);
          onChange(event.target.value);
        }}
        onSelect={(event) => {
          const textarea = event.currentTarget;
          view.start = textarea.selectionStart;
          view.end = textarea.selectionEnd;
          view.direction = textarea.selectionDirection;
          onCaretChange(textarea.selectionStart);
        }}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();

            event.stopPropagation();
            onSave();
            return;
          }
          if (event.key === "Tab") {
            event.preventDefault();
            event.stopPropagation();
            insertAtCaret(event.currentTarget, "  ", onChange);
          }
        }}

        wrap="off"
        className={cn(
          "min-h-0 flex-1 resize-none bg-transparent py-3 pr-4 pl-3 text-foreground",
          "overflow-auto whitespace-pre",
          "focus-visible:outline-none",
        )}
      />
    </div>
  );
}

function insertAtCaret(
  textarea: HTMLTextAreaElement,
  text: string,
  onChange: (next: string) => void,
): void {
  const { selectionStart, selectionEnd, value } = textarea;
  const next = `${value.slice(0, selectionStart)}${text}${value.slice(selectionEnd)}`;
  onChange(next);
  requestAnimationFrame(() => {
    const caret = selectionStart + text.length;
    textarea.setSelectionRange(caret, caret);
  });
}

function SaveNotice({
  tab,
  onReload,
  onOverwrite,
}: {
  tab: FileTab;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  if (tab.save.kind === "conflict") {
    return (
      <NoticeRow tone="error">
        {tab.path} changed on disk since you opened it.
        <NoticeAction onClick={onReload}>Reload</NoticeAction>
        <NoticeAction onClick={onOverwrite}>Overwrite</NoticeAction>
      </NoticeRow>
    );
  }
  if (tab.save.kind === "error") {
    return <NoticeRow tone="error">{tab.save.message}</NoticeRow>;
  }
  if (tab.file?.kind === "text" && !tab.file.editable && tab.mode === "edit") {
    return (
      <NoticeRow tone="warning">
        This file is too large to edit here, so it is shown read-only.
      </NoticeRow>
    );
  }
  return null;
}

function NoticeRow({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "error" | "warning";
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex shrink-0 items-center gap-2 px-4 py-1.5 text-xs",
        tone === "error"
          ? "bg-surface-destructive text-destructive-text"
          : "bg-surface-attention text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function NoticeAction({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer rounded-sm underline underline-offset-2 hover:opacity-80 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
    >
      {children}
    </button>
  );
}

function Centered({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "error";
}) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-wrap items-center justify-center gap-2 p-8 text-sm",
        tone === "error" ? "text-destructive-text" : "text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

export function fileMetaLabel(tab: FileTab): string {
  if (tab.file === null) return "";
  const language = languageLabel(tab.path);
  if (tab.file.kind === "text") {
    const lines = tab.file.content === "" ? 0 : tab.file.content.split("\n").length;
    return `${language} - ${lines.toLocaleString()} lines - ${formatBytes(tab.file.sizeBytes)}`;
  }
  return `${language} - ${formatBytes(tab.file.sizeBytes)}`;
}
