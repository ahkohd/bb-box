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

/** A folder. */
export function FolderGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
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

export function ActivityGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
    </Stroked>
  );
}

export function HomeGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9v10a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1V9" />
    </Stroked>
  );
}

export function BackGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M17 5v14L6 12z" />
    </Stroked>
  );
}

export function RecentsGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </Stroked>
  );
}

export function RotateLeftGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="10" y="8" width="9" height="13" rx="1.5" />
      <path d="M4 12.5A7.5 7.5 0 0 1 11.5 5H13" />
      <path d="m2 10.5 2 2 2-2" />
    </Stroked>
  );
}

export function RotateRightGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="5" y="8" width="9" height="13" rx="1.5" />
      <path d="M20 12.5A7.5 7.5 0 0 0 12.5 5H11" />
      <path d="m22 10.5-2 2-2-2" />
    </Stroked>
  );
}

export function FoldGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M12 5v14" />
      <path d="M12 5 5 7v12l7-2" />
      <path d="M12 5h5.5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H12" />
    </Stroked>
  );
}

export function SunGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Stroked>
  );
}

export function MoonGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Stroked>
  );
}

export function TextSizeGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="m3 19 4.5-11L12 19M4.6 15h5.8" />
      <path d="m12.5 19 4.5-14 4.5 14M14.3 13.5h5.4" />
    </Stroked>
  );
}

export function SmallTextGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="m8 17 4-10 4 10M9.4 13.8h5.2" />
    </Stroked>
  );
}

export function LargeTextGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="m5 20 7-16 7 16M7.4 14.8h9.2" />
    </Stroked>
  );
}

export function ScreenshotGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3.5" />
    </Stroked>
  );
}

export function MoreGlyph(props: Props) {
  return (
    <Filled {...props}>
      <circle cx="12" cy="5.5" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="12" cy="18.5" r="1.6" />
    </Filled>
  );
}

export function MoreAcrossGlyph(props: Props) {
  return (
    <Filled {...props}>
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </Filled>
  );
}

export function LockGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </Stroked>
  );
}

export function LinkGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Stroked>
  );
}

export function LocationGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </Stroked>
  );
}

export function StatusBarGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="6" y="2.5" width="12" height="19" rx="2.5" />
      <path d="M8.5 6h2M14 6h1.5" />
    </Stroked>
  );
}

export function BatteryGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="2.5" y="7.5" width="17" height="9" rx="2" />
      <path d="M21.5 10.5v3M5.5 10.5v3M8.5 10.5v3" />
    </Stroked>
  );
}

export function NetworkGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0" />
      <path d="M12 19.5h.01" />
    </Stroked>
  );
}

export function RebootGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M12 3v7" />
      <path d="M7.5 5.8a7.5 7.5 0 1 0 9 0" />
    </Stroked>
  );
}

export function PhoneGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </Stroked>
  );
}

export function CameraGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M3.5 8.5A1.5 1.5 0 0 1 5 7h2.5l1.5-2.5h6L16.5 7H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
      <circle cx="12" cy="12.75" r="3.25" />
    </Stroked>
  );
}

export function WarningGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M10.3 4.2 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.2M12 17h.01" />
    </Stroked>
  );
}

export function ForkGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="18" cy="5" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 7v1.5a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 11.5V17" />
    </Stroked>
  );
}
