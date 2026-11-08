import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import type { BoxView } from "../plugin/views.ts";

export const FILES_ACTION = "files";

export function filesParams(boxId: string): { box: string } {
  return { box: boxId };
}

export function filesTitle(box: Pick<BoxView, "name">, compactViewport = false): string {
  return compactViewport ? box.name : `Files: ${box.name}`;
}

export function canOpenFiles(box: Pick<BoxView, "device" | "state" | "terminal">): boolean {
  return !box.device && box.state === "ready" && box.terminal;
}

export function offersFiles(box: Pick<BoxView, "device" | "state" | "terminal">): boolean {
  if (box.device) return false;
  return box.terminal || box.state !== "ready";
}

export function useOpenFiles(): (box: BoxView) => void {
  const navigate = useBbNavigate();
  const compactViewport = useIsCompactViewport();
  return (box) => {
    navigate.openThreadPanel({
      actionId: FILES_ACTION,
      title: filesTitle(box, compactViewport),
      params: filesParams(box.id),
    });
  };
}
