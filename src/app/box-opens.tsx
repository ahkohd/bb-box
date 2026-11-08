import type { ReactNode } from "react";
import type { BoxView } from "../plugin/views.ts";
import { FolderGlyph, MonitorGlyph, PhoneGlyph, TerminalGlyph } from "./glyphs.tsx";
import { screensOf, screenWord, type Screen } from "./screens.ts";
import { canOpenFiles, offersFiles } from "./files-open.ts";
import { canOpenTerminal } from "./terminal.tsx";

export interface BoxOpens {
  readonly screen: (box: BoxView, screen: Screen) => void;
  readonly terminal: (box: BoxView) => void;
  readonly files: (box: BoxView) => void;
}

export interface OpenAction {
  readonly key: Screen | "terminal" | "files";
  readonly words: string;
  readonly glyph: (className?: string) => ReactNode;
  readonly open: () => void;
  readonly closedBecause: string | null;
}

export function openWords(box: BoxView, screen: Screen): string {
  return `Open ${screenWord(box, screen).toLowerCase()}`;
}

export function screenGlyph(screen: Screen, className?: string): ReactNode {
  return screen === "device" ? <PhoneGlyph className={className} /> : <MonitorGlyph className={className} />;
}

const NOT_READY_WORDS: Record<Exclude<BoxView["state"], "ready">, string> = {
  acquiring: "is starting",
  starting: "is starting",
  stopping: "is stopping",
  stopped: "is stopped",
  releasing: "is being released",
  failed: "failed",
  gone: "is gone",
};

export function whyClosed(box: BoxView): string | null {
  return box.state === "ready" ? null : `${box.name} ${NOT_READY_WORDS[box.state]}`;
}

export function openActions(box: BoxView, opens: BoxOpens): OpenAction[] {
  const closedBecause = whyClosed(box);
  const screens = screensOf(box).map((screen): OpenAction => ({
    key: screen,
    words: openWords(box, screen),
    glyph: (className) => screenGlyph(screen, className),
    open: () => opens.screen(box, screen),
    closedBecause,
  }));
  const terminal: OpenAction[] = box.terminal
    ? [{ key: "terminal", words: "Open terminal", glyph: (className) => <TerminalGlyph className={className} />, open: () => opens.terminal(box), closedBecause: canOpenTerminal(box) ? null : closedBecause }]
    : [];
  const files: OpenAction[] = offersFiles(box)
    ? [{ key: "files", words: "Open files", glyph: (className) => <FolderGlyph className={className} />, open: () => opens.files(box), closedBecause: canOpenFiles(box) ? null : closedBecause }]
    : [];
  return [...screens, ...terminal, ...files];
}

export function openableNow(actions: readonly OpenAction[]): OpenAction[] {
  return actions.filter((action) => action.closedBecause === null);
}
