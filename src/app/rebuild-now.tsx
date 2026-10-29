import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { Contract } from "../plugin/contract.ts";
import type { RunProgress } from "../plugin/images.ts";
import { message, useNow, type Tone } from "./common.tsx";
import { roughly } from "./first-run.tsx";

export type RunImage = RunProgress["images"][number];

export function stateWords(image: RunImage): string {
  switch (image.state) {
    case "next":
      return "Next";
    case "refreshing":
      return image.step ? `Rebuilding · step ${image.step.at} of ${image.step.of}` : "Rebuilding";
    case "refreshed":
      return `Rebuilt, ${image.detail ?? "a new build"}`;
    case "failed":
      return `Failed: ${image.detail ?? "no reason given"}`;
    case "waiting":
      return `Waits: ${image.detail ?? "no room"}`;
    case "skipped":
      return `Skipped: ${image.detail ?? ""}`;
    case "not started":
      return `Not started: ${image.detail ?? "the run ended first"}`;
  }
}

export const RUN_TONE: Readonly<Record<RunImage["state"], Tone>> = {
  next: "off",
  refreshing: "busy",
  refreshed: "ok",
  failed: "bad",
  waiting: "warn",
  skipped: "off",
  "not started": "off",
};

export function isRunning(progress: RunProgress | null): boolean {
  return progress !== null && progress.ended === null;
}

function runPlace(progress: RunProgress): { readonly share: number; readonly current: RunImage | null; readonly at: number } {
  const total = progress.images.length;
  const index = progress.images.findIndex((image) => image.state === "refreshing" || image.state === "next");
  const current = index >= 0 ? progress.images[index]! : null;
  const withinTheImageBeingRebuilt = current?.step ? Math.max(0, (current.step.at - 1) / current.step.of) : 0;
  const share = total ? Math.min(0.97, Math.max(0.03, ((index < 0 ? total : index) + withinTheImageBeingRebuilt) / total)) : 0.03;
  return { share, current, at: Math.min(index + 1, total) };
}

function Running({ progress }: { progress: RunProgress }) {
  const now = useNow(true, 1000);
  const { share, current, at } = runPlace(progress);
  const title = progress.only === "bb-app" ? "Rebuilding images after a BB update" : "Rebuilding images";
  return (
    <div className="px-4 py-3" role="status" aria-live="polite">
      <p className="text-sm text-foreground">{title}</p>
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{current ? `${at} of ${progress.images.length} · ${current.name}` : "Finishing"}</p>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={title} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-foreground/70" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">Started {roughly(Math.max(0, now - progress.started))} ago. One image at a time; it goes on if you leave this page.</p>
    </div>
  );
}

export function RebuildNow({ progress, due, onStarted }: { progress: RunProgress | null; due: number; onStarted: () => void }) {
  const rpc = useRpc<Contract>();
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (progress && isRunning(progress)) return <Running progress={progress} />;
  const start = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await rpc.call("images.refresh");
      if (answer.started) onStarted();
      else setProblem(answer.message);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <Button type="button" variant="outline" size="sm" className="h-7" disabled={busy || !due} onClick={() => void start()}>
        {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="ArrowReloadHorizontal" aria-hidden />}
        {due === 0 ? "Rebuild what is due" : due === 1 ? "Rebuild 1 image" : `Rebuild ${due} images`}
      </Button>
      <span className="min-w-0 flex-1 text-xs leading-snug text-subtle-foreground">{due ? "What is due, one at a time, as the night does. It goes on if you leave this page." : "No image is due, so there is nothing to rebuild."}</span>
      {problem ? (
        <p role="alert" className="basis-full text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
