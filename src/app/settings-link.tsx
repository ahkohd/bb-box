import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { MouseEvent, ReactNode } from "react";
import { onSettingsPage, openSettingsView, settingsHref, type SettingsView } from "./settings-route.ts";

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function SettingsLink({ view, className, children, label }: { view: SettingsView; className?: string; children: ReactNode; label?: string }) {
  const openInPlace = (event: MouseEvent) => {
    if (!plainClick(event) || !onSettingsPage()) return;
    event.preventDefault();
    event.stopPropagation();
    openSettingsView(view);
  };
  return (
    <span className="contents" onClickCapture={openInPlace}>
      <UrlLink href={settingsHref(view)} className={className} aria-label={label}>
        {children}
      </UrlLink>
    </span>
  );
}
