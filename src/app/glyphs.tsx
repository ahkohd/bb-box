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

/** A box with a desktop: a monitor. */
export function MonitorGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
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

