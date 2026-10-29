import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { MonitorSnapshot } from "../../plugin/contract.ts";
import { cn } from "@/lib/utils";
import { HudTooltip, HudTooltipContent, HudTooltipTrigger } from "./hud-tooltip.tsx";
import { LoadingText } from "./metric-parts.tsx";
import { MiddleTruncate } from "./middle-truncate.tsx";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";

type TailscaleInfo = NonNullable<MonitorSnapshot["tailscale"]>;

const COPIED_MS = 1500;

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function CopyValue({ label, value, title, labelControl }: { label: string; value: string; title?: string; labelControl?: ReactNode }) {
  const [feedback, setFeedback] = useState<{ status: "copied" | "failed"; value: string } | null>(null);
  const state = feedback?.value === value ? feedback.status : "idle";
  const [hovered, setHovered] = useState(false);
  const pointerInside = useRef(false);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => {
      setFeedback(null);
      setHovered(pointerInside.current);
    }, COPIED_MS);
    return () => clearTimeout(timer);
  }, [feedback]);
  const copy = async () => {
    setFeedback({ status: (await copyToClipboard(value)) ? "copied" : "failed", value });
  };
  const tooltip = state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : (title ?? `Copy ${label.toLowerCase()}`);
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      {labelControl ?? <span className="shrink-0 text-subtle-foreground/75">{label}</span>}
      <HudTooltip delayDuration={350} disableHoverableContent open={hovered || state !== "idle"} onOpenChange={setHovered}>
        <HudTooltipTrigger asChild>
          <button
            type="button"
            onClick={() => void copy()}
            onPointerEnter={() => { pointerInside.current = true; }}
            onPointerLeave={() => { pointerInside.current = false; }}
            aria-label={`Copy ${label.toLowerCase()} ${value}`}
            className="group/copy -mr-1 flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          >
            <Icon
              name={state === "copied" ? "Check" : "Copy"}
              className={cn(
                "size-3 shrink-0 transition-opacity group-hover/copy:opacity-100 group-focus-visible/copy:opacity-100",
                state === "idle" ? "opacity-0" : "opacity-100",
              )}
              aria-hidden
            />
            <MiddleTruncate text={value} className="tabular-nums" reveal />
          </button>
        </HudTooltipTrigger>
        <HudTooltipContent side="top">{tooltip}</HudTooltipContent>
      </HudTooltip>
    </div>
  );
}

export function tailscaleRowCount(tailscale: TailscaleInfo): number {
  return 2 + (tailscale.ipv4 || tailscale.ipv6 ? 1 : 0) + (tailscale.tags.length > 0 ? 1 : 0);
}

const LOADING_ROWS = [
  { label: "Name", sample: "machine" },
  { label: "MagicDNS", sample: "machine.tailnet.ts.net" },
  { label: "IPv4", sample: "100.100.100.100" },
  { label: "Tags", sample: "tag:server" },
];

export function LoadingTailscaleRows({ rows }: { rows: number }) {
  return LOADING_ROWS.slice(0, rows).map(({ label, sample }) => (
    <div key={label} className="flex items-center justify-between gap-2 text-xs">
      <span className="shrink-0 text-subtle-foreground/75">{label}</span>
      <span className="-mr-1 flex min-w-0 items-center gap-1 px-1 py-0.5">
        <span className="min-w-0 truncate"><LoadingText sample={sample} /></span>
      </span>
    </div>
  ));
}

type IpVersion = "IPv4" | "IPv6";

const IP_VERSION_KEY = "bb-box:monitor:ip-version";

function readIpVersion(): IpVersion {
  try {
    return localStorage.getItem(IP_VERSION_KEY) === "IPv6" ? "IPv6" : "IPv4";
  } catch {
    return "IPv4";
  }
}

function useIpVersion() {
  const [version, setVersion] = useState<IpVersion>(readIpVersion);
  const toggle = () => {
    const next: IpVersion = version === "IPv4" ? "IPv6" : "IPv4";
    setVersion(next);
    try {
      localStorage.setItem(IP_VERSION_KEY, next);
    } catch {
      return;
    }
  };
  return { version, toggle };
}

function IpVersionToggle({ version, onToggle }: { version: IpVersion; onToggle: () => void }) {
  const other = version === "IPv4" ? "IPv6" : "IPv4";
  return (
    <HudTooltip delayDuration={350} disableHoverableContent>
      <HudTooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Show ${other}`}
          className="group/ip -ml-1 flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-subtle-foreground/75 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          {version}
          <HugeiconsIcon icon={ArrowDataTransferHorizontalIcon} className="size-3 opacity-60 group-hover/ip:opacity-100" aria-hidden="true" />
        </button>
      </HudTooltipTrigger>
      <HudTooltipContent side="top">Show {other}</HudTooltipContent>
    </HudTooltip>
  );
}

function AddressRow({ ipv4, ipv6 }: { ipv4: string | null; ipv6: string | null }) {
  const { version, toggle } = useIpVersion();
  if (ipv4 && ipv6) {
    const value = version === "IPv6" ? ipv6 : ipv4;
    return <CopyValue label={version} value={value} title={version === "IPv6" ? `Copy ${ipv6}` : undefined} labelControl={<IpVersionToggle version={version} onToggle={toggle} />} />;
  }
  if (ipv4) return <CopyValue label="IPv4" value={ipv4} />;
  return ipv6 ? <CopyValue label="IPv6" value={ipv6} title={`Copy ${ipv6}`} /> : null;
}

function machineName(dnsName: string): string {
  return dnsName.split(".")[0] || dnsName;
}

export function TailscaleRows({ tailscale }: { tailscale: TailscaleInfo }) {
  return (
    <>
      <CopyValue label="Name" value={machineName(tailscale.dnsName)} />
      <CopyValue label="MagicDNS" value={tailscale.dnsName} title={`Copy ${tailscale.dnsName}`} />
      <AddressRow ipv4={tailscale.ipv4} ipv6={tailscale.ipv6} />
      {tailscale.tags.length > 0 ? (
        <CopyValue label={tailscale.tags.length === 1 ? "Tag" : "Tags"} value={tailscale.tags.join(", ")} />
      ) : null}
    </>
  );
}
