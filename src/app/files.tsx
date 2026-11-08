import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { BoxPageState, Contract, PanelState } from "../plugin/contract.ts";
import { BackControl, BOXES_ACTION, EmptyPanel, forThread, Notice, ReleasedNotice, useLive, type BackTo } from "./common.tsx";
import { BoxName, type PageLink } from "./box-nav.tsx";
import { FolderGlyph } from "./glyphs.tsx";
import { canOpenFiles, useOpenFiles } from "./files-open.ts";
import { Workspace } from "./files-ui/Workspace.tsx";

type Os = "linux" | "windows" | "macos";

function asOs(os: string): Os {
  return os === "windows" || os === "macos" ? os : "linux";
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
      {box && canOpenFiles(box) ? <Workspace key={`${threadId}:${box.id}`} boxId={box.id} os={asOs(box.os)} /> : null}
    </div>
  );
}
