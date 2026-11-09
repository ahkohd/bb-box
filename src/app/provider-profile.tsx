// The provider's profile behind the (i) on its row in the New box form (the
// operator's artboard): plain text in the form's rhythm, read from the
// server when the popover opens, with one capacity call to the provider,
// and never on every panel load.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Capacity, Limit } from "../backends/types.ts";
import type { OfferView, ProviderProfile } from "../plugin/views.ts";
import { providerTitle, RUNS_ON_WORDS } from "./box-form.tsx";
import { ago } from "./box-words.ts";
import { seconds } from "./common.tsx";

const GIB = 1024;
const RESOURCE_WORDS: Record<Limit["resource"], string> = {
  memory: "memory",
  disk: "disk",
  cpu: "cores",
  guests: "boxes",
  "gpu-desktops": "GPU desktops",
  "gpu-memory": "GPU memory",
  machines: "machines",
};
const FORM_WORDS: Record<string, string> = { LXC: "LXC containers", Docker: "Docker containers", VM: "VMs", microVM: "microVMs", Physical: "physical machines" };

function gib(value: number): string {
  return `${Math.round((value / GIB) * 10) / 10}`;
}

/** "memory 12 of 64 GiB, 4 GiB kept back", "cores 6 of 16", "machines 1 of 2", "disk 100 GiB used". */
export function limitWords(limit: Limit): string {
  const name = `${RESOURCE_WORDS[limit.resource]}${limit.id ? ` ${limit.id}` : ""}`;
  const unit = limit.unit === "MiB" ? " GiB" : "";
  const used = limit.unit === "MiB" ? gib(limit.used) : String(limit.used);
  const reserve = limit.reserve ? `, ${limit.unit === "MiB" ? `${gib(limit.reserve)} GiB` : limit.reserve} kept back` : "";
  if (limit.total === null) return `${name} ${used}${unit} used${reserve}`;
  const total = limit.unit === "MiB" ? gib(limit.total) : String(limit.total);
  return `${name} ${used} of ${total}${unit}${reserve}`;
}

/** The room on each host, in its limits' words, then the provider's own words when none is left. */
export function roomWords(room: Capacity | null): string[] {
  if (!room) return ["Not known: the provider did not answer."];
  const lines = room.hosts.map((host) => `${host.host}: ${host.limits.length ? host.limits.map(limitWords).join(" · ") : host.ok ? "room for one more" : "full"}`);
  if (!room.ok && room.message) lines.push(room.message);
  if (room.warm) lines.push(`${room.warm.ready} of ${room.warm.target} warm`);
  return lines.length ? lines : [room.ok ? "Room for one more box." : "No room for another box."];
}

/** "pve1 (a Linux machine)", "machines of its own (Linux)", "devpc (not known yet)". */
export function runsOnWords(profile: Pick<ProviderProfile, "hosts" | "hostOs" | "nature">): string {
  const machine = profile.hostOs ? RUNS_ON_WORDS[profile.hostOs] : "not known yet";
  if (profile.hosts.length) return `${profile.hosts.join(", ")} (${machine})`;
  return profile.nature === "real" ? `machines of its own (${profile.hostOs ? machine.replace(/^a /, "") : "not known yet"})` : `a machine (${machine})`;
}

/** "Linux, Linux desktop (GPU) · LXC containers". */
export function makesWords(profile: Pick<ProviderProfile, "makes">): string {
  if (!profile.makes.length) return "Nothing now.";
  const forms = [...new Set(profile.makes.map((kind) => kind.form).filter((form): form is NonNullable<typeof form> => form !== null))].map((form) => FORM_WORDS[form] ?? form);
  return `${profile.makes.map((kind) => kind.label).join(", ")}${forms.length ? ` · ${forms.join(", ")}` : ""}`;
}

/** "Linux ~2.2 s (1 ready now) · Linux desktop ~3.1 s", from the kind's last cold starts on it. */
export function usuallyWords(profile: Pick<ProviderProfile, "makes">): string {
  const parts = profile.makes.filter((kind) => kind.typicalReadyMs !== null || kind.ready).map((kind) => `${kind.label}${kind.typicalReadyMs !== null ? ` ~${seconds(kind.typicalReadyMs)}` : ""}${kind.ready ? ` (${kind.ready} ready now)` : ""}`);
  return parts.length ? parts.join(" · ") : "No cold start recorded yet.";
}

/** "Ready · Proxmox VE 9.2 on pve · 2 boxes on it · checked 2 min ago". */
export function statusWords(profile: Pick<ProviderProfile, "status" | "boxes">, now: number): string {
  const { status, boxes } = profile;
  const parts: string[] = [];
  if (status.state === "off") parts.push("Off");
  else if (status.state === "misconfigured") parts.push(`Needs setting up${status.problem ? `: ${status.problem}` : ""}`);
  else parts.push(status.ok === false ? "Needs attention" : "Ready");
  if (status.summary) parts.push(status.summary);
  parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"} on it`);
  if (status.checkedAt !== null) parts.push(`checked ${ago(status.checkedAt, now)}`);
  return parts.join(" · ");
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </>
  );
}

/** A provider's profile as the form holds it: on its way, here, or failed. */
export type Loaded = { readonly profile: ProviderProfile | null; readonly error: string | null; readonly loading: boolean };

/** The pointer resting on the (i) opens the profile after this long, and leaving the (i) or the profile closes it after a short grace, so the pointer can move into it. */
export const HOVER_OPEN_MS = 300;
export const HOVER_CLOSE_MS = 250;

/**
 * The (i) at the end of a provider row, and its popover. The form fetches
 * every listed provider's profile in the background once it has painted
 * and keeps them while it stays open, so the popover opens filled; one
 * still on its way says "Looking…", and one that failed is asked again
 * when its (i) opens (the operator's note of 2 October 2026). The pointer
 * resting on the (i) opens it as a preview, which leaving closes; a click
 * or the keyboard opens it and keeps it until Escape or a click away, for
 * touch and screen readers.
 */
export function ProviderInfo({
  offer,
  among,
  loaded,
  load: ask,
  now = () => Date.now(),
}: {
  offer: OfferView;
  among?: readonly OfferView[];
  loaded: Loaded | undefined;
  load: () => void;
  now?: () => number;
}) {
  const [open, setOpen] = useState(false);
  /** Opened, or kept, by a click or the keyboard: the pointer leaving does not close it. */
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const title = providerTitle(offer, among);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const load = () => {
    if (!loaded?.profile && !loaded?.loading) ask();
  };
  const hoverIn = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    clear();
    if (open) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
      load();
    }, HOVER_OPEN_MS);
  };
  const hoverOut = (event: ReactPointerEvent) => {
    if (event.pointerType === "touch") return;
    clear();
    if (!open || pinned.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(false);
    }, HOVER_CLOSE_MS);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clear();
        pinned.current = next;
        setOpen(next);
        if (next) load();
      }}
    >
      <PopoverTrigger asChild>
        {/* A small (i), the size of the row's dim line, on a hit area of 24 px (the operator's note of 2 October 2026). */}
        <button
          type="button"
          aria-label={`About ${title}`}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onPointerEnter={hoverIn}
          onPointerLeave={hoverOut}
          onClick={(event) => {
            // A click on a preview keeps it open, in place of closing it.
            if (open && !pinned.current) {
              event.preventDefault();
              pinned.current = true;
              clear();
            }
          }}
        >
          <Icon name="Info" className="size-3" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4 sm:w-96" data-nested-layer="" mobileTitle={title} onPointerEnter={clear} onPointerLeave={hoverOut}>
        {loaded?.error && !loaded.loading ? (
          <p role="alert" className="text-xs leading-snug text-destructive-text">
            {loaded.error}
          </p>
        ) : !loaded?.profile ? (
          <p className="text-xs text-muted-foreground">Looking…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <h3 className="text-xs text-foreground">{loaded.profile.name}</h3>
              <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{loaded.profile.technology}</p>
            </div>
            <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs leading-snug">
              <Row label="Runs on">{runsOnWords(loaded.profile)}</Row>
              <Row label="Makes">{makesWords(loaded.profile)}</Row>
              <Row label="Room">
                {roomWords(loaded.profile.room).map((line) => (
                  <span key={line} className="block">
                    {line}
                  </span>
                ))}
              </Row>
              <Row label="Usually">{usuallyWords(loaded.profile)}</Row>
              <Row label="Status">{statusWords(loaded.profile, now())}</Row>
            </dl>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
