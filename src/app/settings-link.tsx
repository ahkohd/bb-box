import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { MouseEvent, ReactNode } from "react";
import { leaveModifiedClick, opensInNewTab } from "./modified-click.ts";
import { onSettingsPage, openSettingsView, settingsHref, type SettingsView } from "./settings-route.ts";

export function SettingsLink({ view, className, children, label }: { view: SettingsView; className?: string; children: ReactNode; label?: string }) {
  const openInPlace = (event: MouseEvent) => {
    if (opensInNewTab(event)) {
      leaveModifiedClick(event);
      return;
    }
    if (!onSettingsPage()) return;
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
