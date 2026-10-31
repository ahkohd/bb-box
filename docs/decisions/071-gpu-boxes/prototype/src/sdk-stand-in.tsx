import type { AnchorHTMLAttributes, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Activity01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowReloadHorizontalIcon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUpDownIcon,
  ArrowUpRight01Icon,
  Calendar03Icon,
  Camera01Icon,
  Cancel01Icon,
  CheckmarkSquare02Icon,
  CheckmarkCircle02Icon,
  Copy01Icon,
  Delete02Icon,
  FilterHorizontalIcon,
  GpuIcon,
  GitForkIcon,
  InformationCircleIcon,
  LinkSquare02Icon,
  Loading03Icon,
  Maximize01Icon,
  MessageAdd01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PlayIcon,
  PlusSignIcon,
  Search01Icon,
  Settings02Icon,
  SquareIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

const ICONS = {
  Activity: Activity01Icon,
  AlertTriangle: Alert02Icon,
  ArrowLeft: ArrowLeft01Icon,
  ArrowReloadHorizontal: ArrowReloadHorizontalIcon,
  ArrowTurnBackward: ArrowTurnBackwardIcon,
  ArrowUpDown: ArrowUpDownIcon,
  ArrowUpRight: ArrowUpRight01Icon,
  Calendar: Calendar03Icon,
  Camera: Camera01Icon,
  Check: Tick02Icon,
  CheckSquare: CheckmarkSquare02Icon,
  ChevronDown: ArrowDown01Icon,
  ChevronLeft: ArrowLeft01Icon,
  ChevronRight: ArrowRight01Icon,
  CircleCheck: CheckmarkCircle02Icon,
  Copy: Copy01Icon,
  ExternalLink: LinkSquare02Icon,
  FilterHorizontal: FilterHorizontalIcon,
  Gpu: GpuIcon,
  GitFork: GitForkIcon,
  Info: InformationCircleIcon,
  Loading: Loading03Icon,
  Maximize2: Maximize01Icon,
  MessageSquarePlus: MessageAdd01Icon,
  MoreHorizontal: MoreHorizontalIcon,
  Pencil: PencilEdit02Icon,
  Play: PlayIcon,
  Plus: PlusSignIcon,
  Search: Search01Icon,
  Settings: Settings02Icon,
  Square: SquareIcon,
  Trash2: Delete02Icon,
  X: Cancel01Icon,
} as const;

export type ExperimentalIconProps = { name: string; fallback?: string; className?: string; "aria-label"?: string; "aria-hidden"?: boolean };

export function experimental_Icon({ name, fallback, className, ...rest }: ExperimentalIconProps) {
  const icon = ICONS[name as keyof typeof ICONS] ?? ICONS[fallback as keyof typeof ICONS] ?? InformationCircleIcon;
  return <HugeiconsIcon data-icon-root icon={icon} className={className} strokeWidth={1.6} {...rest} />;
}

export function UrlLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" {...rest}>
      {children}
    </a>
  );
}

export function useRealtime(channel: string, listener: (payload: unknown) => void): void {
  void channel;
  void listener;
}

export function useRealtimeConnectionState() {
  return "connected";
}


export const OPEN_THREAD = "prototype-open-thread";

export function useBbNavigate() {
  return {
    toThread(threadId: string) {
      window.dispatchEvent(new CustomEvent(OPEN_THREAD, { detail: threadId }));
    },
  };
}
