import type { MouseEvent as ReactMouseEvent } from "react";

export function opensInNewTab(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function leaveModifiedClick(event: ReactMouseEvent): void {
  if (opensInNewTab(event)) event.stopPropagation();
}
