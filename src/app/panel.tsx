// The Box panel: a thread's boxes as rows, "New box", and the empty states.

import { experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Skeleton } from "@/components/ui/skeleton";
import type { BoxResult, Contract, PanelState } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { BoxRow, type BoxAction } from "./box-row.tsx";
import { EmptyPanel, forThread, message, useLive, useNow } from "./common.tsx";
import { NewBox, type SizeRequest } from "./new-box.tsx";

/** bb-box's page under BB's settings. */
export const SETTINGS_PATH = "/settings/plugins/bb-box";

function isMoving(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting";
}

export function BoxesPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<Contract>();
  const { value: state, error, refresh } = useLive<PanelState>(threadId, () => rpc.call("state", { threadId }), forThread(threadId));
  const [open, setOpen] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    setProblem(null);
    setOpen(null);
  }, [threadId]);
  const boxes = state?.boxes ?? [];
  const now = useNow(boxes.some(isMoving));

  const settle = async (result: Promise<BoxResult>): Promise<string | null> => {
    let refused: string | null;
    try {
      refused = (await result).error;
    } catch (caught) {
      refused = message(caught);
    }
    await refresh();
    return refused;
  };
  // The size key is left out for the kind's default: RPC input must be JSON.
  const make = (kind: string, size?: SizeRequest) => settle(rpc.call("acquire", { threadId, kind, ...(size ? { size } : {}) }));
  const act = async (method: BoxAction, box: BoxView) => {
    setProblem(await settle(rpc.call(method, { threadId, box: box.id })));
  };

  if (error) {
    return (
      <EmptyPanel role="alert">
        <p>{error}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
          Try again
        </Button>
      </EmptyPanel>
    );
  }
  if (!state) {
    return (
      <DelayedLoading>
        <div role="status" aria-label="Loading boxes" className="rounded-lg border border-border bg-card px-4 py-1">
          {[0, 1].map((row) => (
            <div key={row} className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-3 py-3">
              <Skeleton className="size-6 rounded-sm" />
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-36" />
                <Skeleton className="h-3 w-56 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      </DelayedLoading>
    );
  }
  if (!state.kinds.length && !boxes.length) {
    return (
      <EmptyPanel title="BB Box is not set up yet">
        <p className="mt-1">Turn on a backend in its settings.</p>
        <Button asChild variant="outline" size="sm" className="mt-3">
          <UrlLink href={SETTINGS_PATH}>
            <Icon name="Settings" aria-hidden />
            Open BB Box settings
          </UrlLink>
        </Button>
      </EmptyPanel>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{boxes.length ? `${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}` : null}</span>
        {state.kinds.length ? <NewBox kinds={state.kinds} make={make} /> : null}
      </div>
      {problem ? (
        <p role="alert" className="text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
      {boxes.length ? (
        <div className="rounded-lg border border-border bg-card px-4 py-1">
          <div className="divide-y divide-border">
            {boxes.map((box) => (
              <BoxRow key={box.id} box={box} threadId={threadId} open={open === box.id} onToggle={() => setOpen((current) => (current === box.id ? null : box.id))} act={act} now={now} />
            ))}
          </div>
        </div>
      ) : (
        <EmptyPanel title="No boxes yet">
          <p className="mt-1">A computer for this thread.</p>
        </EmptyPanel>
      )}
    </div>
  );
}
