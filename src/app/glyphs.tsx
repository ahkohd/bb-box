// The plugin's own glyphs, inline, so they show at once with their room
// reserved and nothing moves when they appear (the operator's note of
// 1 October 2026). The same drawings as assets/, which BB shows in its own
// places (the tab, the settings page).

import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

type Props = SVGProps<SVGSVGElement> & { readonly className?: string };

function Stroked({ className, children, ...rest }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" className={cn("size-4 shrink-0", className)} aria-hidden {...rest}>
      {children}
    </svg>
  );
}

function Filled({ className, children, ...rest }: Props) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={cn("size-4 shrink-0", className)} aria-hidden {...rest}>
      {children}
    </svg>
  );
}

/** A box: the plugin's cube (assets/icon.svg), leading every box row; the type reads in the badges (the operator's note of 3 October 2026). */
export function BoxGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z" />
      <path d="M3.8 7.2 12 11.8l8.2-4.6M12 11.8v9.5" />
    </Stroked>
  );
}

/** A box without a desktop: a server. */
export function ServerGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </Stroked>
  );
}

/** Paste into the box: a clipboard with an arrow into it, since BB's set has no clipboard; it pairs with BB's Copy (the operator's note of 4 October 2026). */
export function PasteGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="5" y="4" width="14" height="17.5" rx="2" />
      <rect x="9" y="2.5" width="6" height="3" rx="1" />
      <path d="M12 9.5v7.5M9.5 14.5 12 17l2.5-2.5" />
    </Stroked>
  );
}

export function KeyboardGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 13.5h.01M17.5 13.5h.01M9.5 14.5h5" />
    </Stroked>
  );
}

/** A box with a desktop: a monitor. */
export function MonitorGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </Stroked>
  );
}

/** High resolution: an HD badge, apart from the monitor of the display's other items. */
export function HighResolutionGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M7 9v6M7 12h3.5M10.5 9v6M13.5 9v6h1.5a3 3 0 0 0 0-6z" />
    </Stroked>
  );
}

/** A terminal. */
export function TerminalGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m6 9 4 3-4 3M12 15h6" />
    </Stroked>
  );
}

