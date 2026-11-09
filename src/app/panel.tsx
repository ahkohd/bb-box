// The Box panel: a thread's boxes as rows, "New box", and the empty states.

import { FirstRun, SetupProgress } from "./first-run.tsx";
import { experimental_Icon as Icon, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BoxResult, Contract, PanelState, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { BoxRow, type Held } from "./box-row.tsx";
import type { BoxAction } from "./box-menu.tsx";
import { InUseDialog, ProblemLine, type InUse } from "./box-actions.tsx";
import { EmptyPanel, forThread, message, SETTINGS_PATH, useLive, useNow } from "./common.tsx";
import { leaveModifiedClick } from "./modified-click.ts";
import { BoxRowsSkeleton, LoadFailed, WhileLoading } from "./loading-states.tsx";
import { threadGroupHeading, useThreadTitles } from "./desktop.tsx";
import { useBoxesNav } from "./box-nav.tsx";
import { boxPage } from "./box-route.ts";
import { IMAGE_REQUEST, NewBox, useDesktopOnDemand, useDesktopProblemShownOnce, type SizeRequest } from "./new-box.tsx";

/** bb-box's page under BB's settings. */

function isMoving(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting";
}

export function BoxesPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const navigate = useBbNavigate();
  const nav = useBoxesNav();
  const { value: state, error, refresh } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  /** A release or stop left alone because threads run on the box, until the user says. */
  const [inUse, setInUse] = useState<InUse<"release" | "stop"> | null>(null);
  useEffect(() => {
    setProblem(null);
    setOpen(null);
  }, [threadId]);
  const boxes = state?.boxes ?? [];
  const runsOn = state?.runsOn ?? null;
  const titles = useThreadTitles(runsOn?.threadId ? [runsOn.threadId] : []);
  const now = useNow(boxes.some(isMoving) || (runsOn !== null && isMoving(runsOn.box)));
  // One list (the operator, 4 October 2026): the box this thread runs on first, with a "This thread" badge, then the thread's own.
  const rows: { box: BoxView; held: Held | null }[] = [
    ...(runsOn ? [{ box: runsOn.box, held: { owner: runsOn.owner, threadId: runsOn.threadId, threadTitle: runsOn.threadId ? (runsOn.threadId in titles ? threadGroupHeading(titles[runsOn.threadId]) : null) : null } }] : []),
    ...boxes.map((box) => ({ box, held: null })),
  ];

  const settle = async (result: Promise<BoxResult>, onThreads?: (threads: readonly ThreadOnBox[]) => void): Promise<string | null> => {
    let refused: string | null;
    try {
      const answer = await result;
      if (answer.threads?.length) onThreads?.(answer.threads);
      refused = answer.threads?.length ? null : answer.error;
    } catch (caught) {
      refused = message(caught);
    }
    await refresh();
    return refused;
  };
  // The size key is left out for the kind's default: RPC input must be JSON.
  const make = (kind: string, size?: SizeRequest, _name?: string, on?: string | string[], image?: string, device?: string, placement?: "dedicated" | "shared") =>
    settle(rpc.call("acquire", { threadId, kind, ...(size ? { size } : {}), ...(on ? { on } : {}), ...(image ? { image } : {}), ...(device ? { device } : {}), ...(placement === "dedicated" ? { dedicated: true } : placement === "shared" ? { shared: true } : {}) }));
  // A desktop whose image builds first (the setup plan's PR 4): the panel then shows the build, and the box follows it.
  const onDemand = useDesktopOnDemand(state?.desktopOnDemand, threadId, refresh);
  // A desktop box not made after its image was built shows as a refused acquire does, once, until dismissed.
  useDesktopProblemShownOnce(state?.desktopProblem, setProblem);
  const act = async (method: BoxAction, box: BoxView, options: { readonly force?: boolean; readonly deleteKept?: boolean } = {}): Promise<string | null> => {
    const guarded = method === "release" || method === "stop";
    const input = { threadId, box: box.id, ...(guarded && options.force ? { force: true } : {}), ...(method === "release" && options.deleteKept ? { deleteKept: true } : {}) };
    const refused = await settle(rpc.call(method, input), guarded ? (threads) => setInUse({ method, box, threads, ...(options.deleteKept ? { deleteKept: true } : {}) }) : undefined);
    const shownInDialog = options.force === true || method === "release" || method === "forget";
    if (!refused) setProblem(null);
    else if (!shownInDialog) setProblem(refused);
    return refused;
  };

  if (error) return <LoadFailed what="The boxes" error={error} onRetry={refresh} />;
  if (!state) {
    return (
      <WhileLoading words="Reading the boxes…">
        <BoxRowsSkeleton rows={2} className="py-1" />
      </WhileLoading>
    );
  }
  if (!state.kinds.length && !rows.length) {
    // First run: one action on a BB machine that can take it, or the empty state as before where none can (the setup job).
    return (
      <FirstRun
        fallback={
      <EmptyPanel title="BB Box is not set up yet">
        <p className="mt-1">Set a backend up in its settings and turn it on.</p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <UrlLink href={SETTINGS_PATH} onClick={leaveModifiedClick}>
            <Icon name="Settings" aria-hidden />
            Open BB Box settings
          </UrlLink>
        </Button>
      </EmptyPanel>
        }
      />
    );
  }
  return (
    <div className="space-y-3">
      <SetupProgress empty={!rows.length} />
      <div className="flex items-center justify-end gap-2">
        {state.kinds.length ? (
          <NewBox
            kinds={state.kinds}
            make={make}
            profile={(backend) => rpc.call("provider", { backend })}
            rooms={(kind, size) => rpc.call("rooms", { kind, ...(size ? { size } : {}) })}
            cards={(kind) => rpc.call("kind.cards", { kind })}
            askForImage={state.imageOffer ? () => navigate.toCompose({ initialPrompt: IMAGE_REQUEST, focusPrompt: true }) : undefined}
            images={state.images}
            onDemand={onDemand}
            access={state.access ?? null}
          />
        ) : null}
      </div>
      <ProblemLine problem={problem} onDismiss={() => setProblem(null)} />
      {rows.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {rows.map(({ box, held }) => (
              <BoxRow key={box.id} box={box} threadId={threadId} opening={{ details: open === box.id, toggle: () => setOpen((current) => (current === box.id ? null : box.id)) }} act={act} now={now} held={held} onBoxesPage={() => nav.go(boxPage(box.id))} />
            ))}
          </div>
        </div>
      ) : (
        <EmptyPanel title="No boxes yet">
          <p className="mt-1">A computer for this thread.</p>
        </EmptyPanel>
      )}
      <InUseDialog inUse={inUse} words={{ release: "Release", stop: "Stop" }} busyWords={{ release: "Releasing…", stop: "Stopping…" }} onClose={() => setInUse(null)} onForce={(found) => act(found.method, found.box, { force: true, deleteKept: found.deleteKept === true })} />
    </div>
  );
}
