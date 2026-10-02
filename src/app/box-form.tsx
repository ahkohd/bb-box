// The stepped box form (the operator's redesign of 1 October 2026): sections
// that narrow each other, System, Architecture, Type, Provider, Resources,
// Name, laid out as the settings page lays out its sections (a title row,
// then the options at full width; the operator's notes of 2 October 2026),
// then a summary and one button. The words come from today's kinds and
// offers; nothing here names a kind ID or a host ID, and nothing carries a
// provider's mark or colour.

import { useEffect, type ReactNode } from "react";
import type { GuestOs } from "../backends/types.ts";
import type { KindView, OfferView } from "../plugin/views.ts";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { osName, seconds } from "./common.tsx";
import { MonitorGlyph, ServerGlyph } from "./glyphs.tsx";

export type Arch = "x86_64" | "arm64";

/** What the first steps say: the OS, the architecture, a desktop or not, and a GPU for a desktop. */
export interface Choice {
  readonly os: GuestOs;
  readonly arch: Arch;
  readonly desktop: boolean;
  readonly gpu: boolean;
}

const OS_ORDER: readonly GuestOs[] = ["linux", "macos", "windows"];
export const ARCHS: readonly { readonly id: Arch; readonly label: string; readonly words: string }[] = [
  { id: "x86_64", label: "x86_64", words: "64-bit Intel / AMD" },
  { id: "arm64", label: "arm64", words: "64-bit ARM" },
];

/** A kind's arch as the form knows it. */
function archOf(kind: KindView): Arch {
  return kind.arch === "arm64" ? "arm64" : "x86_64";
}

/** The provider's name for a row: its one host, a count of hosts, or the backend's label; never an ID. */
export function providerTitle(offer: OfferView): string {
  if (offer.hosts.length === 1) return offer.hosts[0]!;
  if (offer.hosts.length > 1) return `${offer.hosts.length} ${offer.type === "tart" ? "Macs" : "hosts"}`;
  if (offer.type === "docker") return "an unnamed machine";
  return offer.label;
}

/** The systems on offer, each with the names of its hosts, or how many providers it has when there are many. */
export function systemsOf(kinds: readonly KindView[]): { readonly os: GuestOs; readonly label: string; readonly words: string }[] {
  const present = new Set(kinds.map((kind) => kind.os));
  return OS_ORDER.filter((os) => present.has(os)).map((os) => {
    const offers = kinds.filter((kind) => kind.os === os).flatMap((kind) => kind.offers);
    const providers = new Set(offers.map((offer) => offer.backend));
    const hosts = [...new Set(offers.flatMap((offer) => (offer.hosts.length ? offer.hosts : [providerTitle(offer)])))];
    const words = hosts.length && hosts.length <= 2 ? hosts.join(", ") : `${providers.size} ${providers.size === 1 ? "provider" : "providers"}`;
    return { os, label: osName(os), words };
  });
}

/** Kinds of a system on an architecture. */
function kindsAt(kinds: readonly KindView[], os: GuestOs, arch: Arch): KindView[] {
  return kinds.filter((kind) => kind.os === os && archOf(kind) === arch);
}

export function archAvailable(kinds: readonly KindView[], os: GuestOs, arch: Arch): boolean {
  return kindsAt(kinds, os, arch).length > 0;
}

export function typeAvailable(kinds: readonly KindView[], os: GuestOs, arch: Arch, desktop: boolean): boolean {
  return kindsAt(kinds, os, arch).some((kind) => kind.desktop === desktop);
}

/** For a desktop: whether a GPU desktop and a CPU one both exist, so GPU is a choice. */
export function gpuChoices(kinds: readonly KindView[], os: GuestOs, arch: Arch): { readonly none: boolean; readonly gpu: boolean } {
  const desktops = kindsAt(kinds, os, arch).filter((kind) => kind.desktop);
  return { none: desktops.some((kind) => !kind.gpu), gpu: desktops.some((kind) => kind.gpu) };
}

/** The kind the choice names, taking the desktop that exists when the GPU choice does not. */
export function kindFor(kinds: readonly KindView[], choice: Choice): KindView | null {
  const at = kindsAt(kinds, choice.os, choice.arch).filter((kind) => kind.desktop === choice.desktop);
  if (!at.length) return null;
  return at.find((kind) => kind.gpu === choice.gpu) ?? at[0]!;
}

/** The nearest choice that exists: the OS stays, then the arch, then the type, then the GPU snap to what there is. */
export function nearest(kinds: readonly KindView[], wanted: Choice): Choice {
  const os = kinds.some((kind) => kind.os === wanted.os) ? wanted.os : (systemsOf(kinds)[0]?.os ?? wanted.os);
  const arch = archAvailable(kinds, os, wanted.arch) ? wanted.arch : (ARCHS.find((candidate) => archAvailable(kinds, os, candidate.id))?.id ?? wanted.arch);
  const desktop = typeAvailable(kinds, os, arch, wanted.desktop) ? wanted.desktop : !wanted.desktop;
  const choices = gpuChoices(kinds, os, arch);
  const gpu = desktop ? (wanted.gpu ? choices.gpu : !choices.none && choices.gpu) : false;
  return { os, arch, desktop, gpu };
}

/** The choice a kind stands for, for the form to open on a remembered kind. */
export function choiceOf(kind: KindView): Choice {
  return { os: kind.os, arch: archOf(kind), desktop: kind.desktop, gpu: kind.gpu };
}

/** The hosts the providers run on, for the Host menu, in acquire order. A pool, with no host of its own, is under Any host only. */
export function hostsOf(kinds: readonly KindView[]): string[] {
  return [...new Set(kinds.flatMap((kind) => kind.offers.flatMap((offer) => offer.hosts)))];
}

/** The kinds as one host can make them: only the offers on it, and no kind that has none there; every kind for Any host. */
export function onHost(kinds: readonly KindView[], host: string | null): KindView[] {
  if (host === null) return [...kinds];
  return kinds.map((kind) => ({ ...kind, offers: kind.offers.filter((offer) => offer.hosts.includes(host)) })).filter((kind) => kind.offers.length);
}

export type FormFilter = "all" | "container" | "vm" | "physical";
export const FORM_FILTERS: readonly { readonly id: FormFilter; readonly label: string; readonly words: string }[] = [
  { id: "all", label: "All", words: "Every provider below" },
  { id: "container", label: "Container", words: "A container on a shared host, fastest to start" },
  { id: "vm", label: "VM", words: "A virtual machine with a kernel of its own" },
  { id: "physical", label: "Physical", words: "A whole machine to itself" },
];

/** What an offer's boxes are, for the Kind chips: containers (LXC or Docker), VMs or physical machines. */
export function formFilterOf(offer: OfferView): FormFilter | null {
  switch (offer.form) {
    case "LXC":
    case "Docker":
      return "container";
    case "VM":
      return "vm";
    case "Physical":
      return "physical";
    default:
      return null;
  }
}

export type RunsOn = "any" | GuestOs;
const RUNS_ON_ORDER: readonly GuestOs[] = ["macos", "linux", "windows"];
export const RUNS_ON_WORDS: Record<GuestOs, string> = { macos: "a Mac", linux: "a Linux machine", windows: "a Windows PC" };

/** The machines the offers run on, in the order the menu lists them; an offer that does not know yet adds none. */
export function runsOnOptions(offers: readonly OfferView[]): GuestOs[] {
  const present = new Set(offers.map((offer) => offer.hostOs).filter((os): os is GuestOs => os !== null));
  return RUNS_ON_ORDER.filter((os) => present.has(os));
}

/**
 * The offers the filters leave: a Kind chip keeps its form (an offer whose
 * form is unknown stays), and Runs on keeps its machine's OS, with an offer
 * that does not know its machine's OS yet kept too, so a new backend does
 * not vanish until its daemon answers.
 */
export function offersShown(offers: readonly OfferView[], filter: FormFilter, runsOn: RunsOn): OfferView[] {
  return offers.filter((offer) => {
    const form = formFilterOf(offer);
    if (filter !== "all" && form !== null && form !== filter) return false;
    if (filter !== "physical" && runsOn !== "any" && offer.hostOs !== null && offer.hostOs !== runsOn) return false;
    return true;
  });
}

/** What the boxes of an offer are, in a row's words. */
export function formWords(offer: OfferView): string | null {
  switch (offer.form) {
    case "LXC":
    case "Docker":
      return "Container";
    case "VM":
      return "VM";
    case "Physical":
      return "Physical";
    default:
      return null;
  }
}

/** A row's second line: what the boxes are, spares ready (green), free machines, the usual start. */
export function OfferWords({ offer }: { offer: OfferView }) {
  const parts: ReactNode[] = [];
  const form = formWords(offer);
  if (form) parts.push(<span key="form">{form}</span>);
  if (offer.ready) parts.push(<span key="ready" className="text-emerald-700 dark:text-emerald-400">{offer.ready} ready now</span>);
  if (offer.free !== null) parts.push(<span key="free">{offer.free} free</span>);
  if (offer.typicalReadyMs !== null) parts.push(<span key="usually">usually ~{seconds(offer.typicalReadyMs)}</span>);
  if (!parts.length) return null;
  return (
    <span className="mt-0.5 block text-2xs text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : ""}
          {part}
        </span>
      ))}
    </span>
  );
}

/**
 * One Escape closes the form whatever was used last. A menu just closed
 * keeps its layer while its closing animation plays, and Radix gives that
 * layer the Escape, so the first Escape after a menu did nothing (the
 * operator's live form, 2 October 2026). While a menu is open, Escape is
 * the menu's, as before.
 */
export function useEscapeCloses(open: boolean, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A menu or a provider's profile open: Escape is theirs.
      if (event.key !== "Escape" || document.querySelector('[role="listbox"][data-state="open"], [data-nested-layer][data-state="open"]')) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    return () => document.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [open, setOpen]);
}

/**
 * One section, as the settings page has them: its title, a dim line under
 * it where useful, then its parts at full width, each with the same clear
 * space between them (a filter row, then a list; or the options).
 */
export function FormSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xs font-medium text-foreground">{title}</h3>
        {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A small menu. A filter is compact, with its label inside the trigger
 * ("Kind: All"), since it narrows the list rather than choosing from it
 * (the operator's note of 2 October 2026); a choice that is a section's
 * only control, the GPU, has the section's title for its label. An option
 * no provider has is there, but cannot be chosen.
 */
export function MenuSelect({
  label,
  labelInside = false,
  value,
  options,
  onChange,
}: {
  label: string;
  labelInside?: boolean;
  value: string;
  options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[];
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={cn("h-7 text-xs", labelInside ? "w-auto gap-1.5 px-2" : "w-40")} aria-label={label}>
        {labelInside ? <span className="text-muted-foreground">{label}:</span> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** An option card: a title and a line under it; chosen reads as BB's active state; unavailable greys out and says so. */
export function OptionCard({
  title,
  words,
  selected,
  available = true,
  glyph,
  onClick,
  optionRef,
}: {
  title: string;
  words: string | null;
  selected: boolean;
  available?: boolean;
  glyph?: ReactNode;
  onClick: () => void;
  optionRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={optionRef}
      type="button"
      role="radio"
      aria-checked={selected}
      aria-disabled={!available || undefined}
      tabIndex={selected ? 0 : -1}
      onClick={() => {
        if (available) onClick();
      }}
      className={cn(
        "flex min-w-0 flex-1 items-start gap-2.5 rounded-md border px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
        !available && "cursor-default opacity-50 hover:bg-transparent",
      )}
    >
      {glyph}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{available ? words : "Not available"}</span>
      </span>
    </button>
  );
}

/** A provider row: its name at full strength, its words dim, no mark and no colour (the operator's note of 2 October 2026); an (i) at its end opens its profile. */
export function ProviderRow({ offer, selected, onClick, optionRef, info }: { offer: OfferView; selected: boolean; onClick: () => void; optionRef?: (element: HTMLButtonElement | null) => void; info?: ReactNode }) {
  return (
    <div className={cn("flex items-center rounded-md border", selected ? "border-transparent bg-state-active" : "border-input")}>
      <button
        ref={optionRef}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onClick}
        className={cn("flex min-w-0 flex-1 flex-col items-start rounded-md px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring", !selected && "hover:bg-state-hover")}
      >
        <span className="block w-full truncate text-xs font-medium text-foreground">{providerTitle(offer)}</span>
        <OfferWords offer={offer} />
      </button>
      {info ? <div className="flex shrink-0 items-center pr-1.5">{info}</div> : null}
    </div>
  );
}

export const TYPE_GLYPHS = { server: <ServerGlyph className="mt-0.5 shrink-0 text-muted-foreground" />, desktop: <MonitorGlyph className="mt-0.5 shrink-0 text-muted-foreground" /> };
