// Rebuild now, beside Rebuild images each night in settings (the operator,
// 11 October 2026): the standard images that are due and why, as bb box
// images list gives them, and one button that starts the night's refresh,
// one image at a time. While it runs, the card shows how far it is, image by
// image, as first-run setup's card does. A run going on is not doubled: the
// button says so instead.

import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Contract, ImagesStatus } from "../plugin/contract.ts";
import type { RunProgress } from "../plugin/images.ts";
import { message, useLive, useNow } from "./common.tsx";
import { roughly } from "./first-run.tsx";

const CARD = "rounded-lg border border-border bg-card px-4 py-4";

type Image = RunProgress["images"][number];

/** What an image of a run did, or does, in a few words. */
export function stateWords(image: Image): string {
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

const TONE: Record<Image["state"], string> = {
  next: "text-subtle-foreground",
  refreshing: "text-foreground",
  refreshed: "text-muted-foreground",
  failed: "text-destructive-text",
  waiting: "text-warning-text",
  skipped: "text-subtle-foreground",
  "not started": "text-subtle-foreground",
};

function RunImages({ images }: { images: readonly Image[] }) {
  return (
    <ul className="mt-3 space-y-1.5">
      {images.map((image) => (
        <li key={image.name} className="min-w-0 text-xs leading-snug">
          <span className="text-foreground">{image.name}</span> <span className="text-subtle-foreground">({image.kind})</span>
          <span className={`block ${TONE[image.state]}`}>{stateWords(image)}</span>
        </li>
      ))}
    </ul>
  );
}

function Running({ progress }: { progress: RunProgress }) {
  const now = useNow(true, 1000);
  const total = progress.images.length;
  const index = progress.images.findIndex((image) => image.state === "refreshing" || image.state === "next");
  const current = index >= 0 ? progress.images[index]! : null;
  // The bar follows the images, and the steps of the one being rebuilt, as the time varies with the host and the image.
  const within = current?.step ? Math.max(0, (current.step.at - 1) / current.step.of) : 0;
  const share = total ? Math.min(0.97, Math.max(0.03, ((index < 0 ? total : index) + within) / total)) : 0.03;
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">{progress.only === "bb-app" ? "Rebuilding images after a BB update" : "Rebuilding images"}</p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">{current ? `${Math.min(index + 1, total)} of ${total} · ${current.name}` : "Finishing"}</p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Rebuilding images" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">Started {roughly(Math.max(0, now - progress.started))} ago. One image at a time; it goes on if you leave this page.</p>
      <RunImages images={progress.images} />
    </div>
  );
}

export function RebuildNow() {
  const rpc = useRpc<Contract>();
  const { value: live } = useLive("images-progress", () => rpc.call("images.progress"), () => true);
  const [images, setImages] = useState<ImagesStatus["images"] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const progress = live?.progress ?? null;
  const ended = progress?.ended ?? null;
  // The list on opening, and again when a run ends, as its images are no longer due.
  useEffect(() => {
    let current = true;
    rpc.call("images.list").then(
      (answer) => current && setImages(answer.images),
      (caught: unknown) => current && setProblem(message(caught)),
    );
    return () => {
      current = false;
    };
  }, [rpc, ended]);
  if (progress && progress.ended === null) return <Running progress={progress} />;
  const due = images?.filter((image) => image.due) ?? [];
  const start = async () => {
    setBusy(true);
    try {
      const answer = await rpc.call("images.refresh");
      setProblem(answer.started ? null : answer.message);
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">Rebuild now</p>
      {images === null ? (
        <p className="mt-1 text-xs text-muted-foreground">{problem ?? "Reading the images…"}</p>
      ) : !images.length ? (
        <p className="mt-1 text-xs text-muted-foreground">No backend that is on has images BB Box rebuilds.</p>
      ) : (
        <>
          <p className="mt-1 text-xs leading-snug text-muted-foreground">
            {due.length ? `${due.length} of ${images.length} ${images.length === 1 ? "image is" : "images are"} due. A rebuild takes them one at a time, as the night does.` : "No image is due."}
          </p>
          {due.length ? (
            <ul className="mt-3 space-y-1.5">
              {due.map((image) => (
                <li key={image.name} className="min-w-0 text-xs leading-snug">
                  <span className="text-foreground">{image.name}</span> <span className="text-subtle-foreground">({image.kind})</span>
                  <span className="block text-muted-foreground">Due, as {image.due}</span>
                  {image.last ? <span className="block text-subtle-foreground">{image.last}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" onClick={() => void start()} disabled={busy || !due.length}>
              {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
              {due.length === 1 ? "Rebuild 1 image" : `Rebuild ${due.length} images`}
            </Button>
          </div>
        </>
      )}
      {problem && images !== null ? (
        <p role="alert" className="mt-2 text-xs leading-snug text-destructive-text">
          {problem}
        </p>
      ) : null}
      {progress && ended !== null ? (
        <>
          <p className="mt-4 text-xs text-subtle-foreground">The last rebuild ended {roughly(Math.max(0, Date.now() - ended))} ago:</p>
          <RunImages images={progress.images} />
        </>
      ) : null}
    </div>
  );
}
