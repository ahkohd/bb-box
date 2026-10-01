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

/** A Mac host. */
export function LaptopGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path d="M2.5 19h19" />
    </Stroked>
  );
}

/** A pool machine reached over SSH. */
export function PlugGlyph(props: Props) {
  return (
    <Stroked {...props}>
      <path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v5" />
    </Stroked>
  );
}

/** Proxmox, from Simple Icons (CC0); the mark is Proxmox Server Solutions GmbH's. */
export function ProxmoxGlyph(props: Props) {
  return (
    <Filled {...props}>
      <path d="M4.928 1.825c-1.09.553-1.09.64-.07 1.78 5.655 6.295 7.004 7.782 7.107 7.782.139.017 7.971-8.542 8.058-8.801.034-.07-.208-.312-.519-.536-.415-.312-.864-.433-1.712-.467-1.59-.104-2.144.242-4.115 2.455-.9 1.021-1.678 1.85-1.712 1.85-.052 0-.813-.829-1.712-1.85C8.421 1.825 7.675 1.479 6.19 1.479c-.606 0-1.04.104-1.262.346zm13.8 3.823c-.657.293-.969.606-5.01 5.102-2.265 2.508-4.15 4.634-4.202 4.738-.07.138 2.3 2.802 4.513 5.085 1.504 1.556 2.542 1.954 4.202 1.573 1.088-.242 1.712-.814 1.712-1.573 0-.398-.433-.969-3.546-4.635-1.954-2.299-3.579-4.236-3.579-4.288s1.556-1.954 3.46-4.236c1.902-2.283 3.527-4.254 3.596-4.375.19-.312-.208-1.09-.796-1.556-.606-.467-1.608-.624-2.35-.364zM3.095 5.699c-.709.312-1.09.9-1.09 1.66 0 .346.571 1.092 3.44 4.428 1.91 2.213 3.515 4.1 3.567 4.168.07.104-1.436 1.88-3.37 4.167-1.903 2.248-3.51 4.202-3.562 4.323-.173.433.242 1.09.883 1.47.918.519 2.248.433 3.2-.208.657-.433 7.419-8.473 7.419-8.818 0-.139-1.59-2.1-3.561-4.306C6.277 8.432 5.359 7.542 4.773 6.9c-.467-.433-1.14-.898-1.678-1.2z" />
    </Filled>
  );
}

/** Docker, from Simple Icons (CC0); the mark is Docker, Inc.'s. */
export function DockerGlyph(props: Props) {
  return (
    <Filled {...props}>
      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.082.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
    </Filled>
  );
}
