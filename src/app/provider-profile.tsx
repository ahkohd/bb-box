// The provider's profile behind the (i) on its row in the New box form (the
// operator's artboard): plain text in the form's rhythm, read from the
// server when the popover opens, with one capacity call to the provider,
// and never on every panel load.

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Capacity, Limit } from "../backends/types.ts";
import type { OfferView, ProviderProfile } from "../plugin/views.ts";
import { providerTitle, RUNS_ON_WORDS } from "./box-form.tsx";
import { message, relativeTime, seconds } from "./common.tsx";

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
const FORM_WORDS: Record<string, string> = { LXC: "LXC containers", Docker: "Docker containers", VM: "VMs", Physical: "physical machines" };

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

/** "Ready · Proxmox VE 9.2 on pve · 2 boxes on it · checked 2 minutes ago". */
export function statusWords(profile: Pick<ProviderProfile, "status" | "boxes">, now: number): string {
  const { status, boxes } = profile;
  const parts: string[] = [];
  if (status.state === "off") parts.push("Off");
  else if (status.state === "misconfigured") parts.push(`Needs setting up${status.problem ? `: ${status.problem}` : ""}`);
  else parts.push(status.ok === false ? "Needs attention" : "Ready");
  if (status.summary) parts.push(status.summary);
  parts.push(`${boxes} ${boxes === 1 ? "box" : "boxes"} on it`);
  if (status.checkedAt !== null) parts.push(`checked ${relativeTime(status.checkedAt, now)}`);
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

type Loaded = { readonly profile: ProviderProfile | null; readonly error: string | null; readonly loading: boolean };

/** The (i) at the end of a provider row, and its popover: asked once per open form, kept while the form stays open. */
export function ProviderInfo({ offer, profile, now = () => Date.now() }: { offer: OfferView; profile: (backend: string) => Promise<ProviderProfile>; now?: () => number }) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded>({ profile: null, error: null, loading: false });
  const title = providerTitle(offer);
  const load = () => {
    if (loaded.profile || loaded.loading) return;
    setLoaded({ profile: null, error: null, loading: true });
    profile(offer.backend).then(
      (found) => setLoaded({ profile: found, error: null, loading: false }),
      (error: unknown) => setLoaded({ profile: null, error: message(error), loading: false }),
    );
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) load();
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" aria-label={`About ${title}`} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring">
          <Icon name="Info" className="size-3.5" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4 sm:w-96" data-nested-layer="" mobileTitle={title}>
        {loaded.error ? (
          <p role="alert" className="text-xs leading-snug text-destructive-text">
            {loaded.error}
          </p>
        ) : !loaded.profile ? (
          <p className="text-xs text-muted-foreground">Looking…</p>
        ) : (
          <div className="space-y-3">
            <div>
              <h3 className="text-xs font-medium text-foreground">{loaded.profile.name}</h3>
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
