// The stepped box form (the operator's redesign of 1 October 2026): sections
// that narrow each other, System, Architecture, Type, Provider, Resources,
// Name, laid out as the settings page lays out its sections (a title row,
// then the options at full width; the operator's notes of 2 October 2026),
// then a summary and one button. The words come from today's kinds and
// offers; nothing here names a kind ID or a host ID, and nothing carries a
// provider's mark or colour.

import { useEffect, type ReactNode } from "react";
import type { GuestOs, Windowing } from "../backends/types.ts";
import type { KindView, OfferView } from "../plugin/views.ts";
import { cn } from "@/lib/utils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { osName, seconds } from "./common.tsx";
import { MonitorGlyph, ServerGlyph } from "./glyphs.tsx";

export type Arch = "x86_64" | "arm64";

/** What the first steps say: the OS, the architecture, a desktop or not, a GPU for a desktop, and its windowing system. */
export interface Choice {
  readonly os: GuestOs;
  readonly arch: Arch;
  readonly desktop: boolean;
  readonly gpu: boolean;
  /** A desktop's windowing system (048); "x11" for a server, which never shows the choice. */
  readonly windowing: Windowing;
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

/**
 * The provider's name for a row: its one host, a count of hosts, or the backend's label; never an ID. Where another of
 * `among` has the same name, as Docker and microsandbox on one host, the backend's label goes with it (053).
 */
export function providerTitle(offer: OfferView, among: readonly OfferView[] = []): string {
  const base = (one: OfferView) => {
    if (one.hosts.length === 1) return one.hosts[0]!;
    if (one.hosts.length > 1) return `${one.hosts.length} ${one.type === "tart" ? "Macs" : "hosts"}`;
    if (one.type === "docker") return "an unnamed machine";
    return one.label;
  };
  const title = base(offer);
  const shared = among.some((other) => other.backend !== offer.backend && other.label !== offer.label && base(other) === title);
  return shared ? `${title} (${offer.label})` : title;
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

/** For a desktop of a windowing system: whether a GPU desktop and a CPU one both exist, so GPU is a choice. */
export function gpuChoices(kinds: readonly KindView[], os: GuestOs, arch: Arch, windowing: Windowing): { readonly none: boolean; readonly gpu: boolean } {
  const desktops = kindsAt(kinds, os, arch).filter((kind) => kind.desktop && kind.windowing === windowing);
  return { none: desktops.some((kind) => !kind.gpu), gpu: desktops.some((kind) => kind.gpu) };
}

/**
 * The note under the GPU menu when no GPU has room for a desktop (#603):
 * every offer lately read each of its GPUs full. Null while one has room, or
 * has not read its GPUs: the form says nothing when nothing is in the way.
 */
export function gpuFullNote(offers: readonly OfferView[], now: number): string | null {
  const rooms = offers.map((offer) => offer.gpuRoom);
  if (!rooms.length || rooms.some((room) => !room?.readings.length || room.fullUntil === null || room.fullUntil <= now)) return null;
  const readings = rooms.flatMap((room) => room!.readings);
  const most = Math.max(...readings.map((reading) => reading.freeMiB));
  const minutes = Math.max(1, Math.ceil((Math.min(...rooms.map((room) => room!.fullUntil!)) - now) / 60_000));
  return (
    `No GPU has room now: ${readings.length > 1 ? "at most " : ""}${most} MiB free, and a desktop needs ${readings[0]!.neededMiB} MiB. ` +
    `Choose None, or try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`
  );
}

/** For a desktop: whether an X11 desktop and a Wayland one both exist, so the windowing is a choice (048). */
export function displayChoices(kinds: readonly KindView[], os: GuestOs, arch: Arch): { readonly x11: boolean; readonly wayland: boolean } {
  const desktops = kindsAt(kinds, os, arch).filter((kind) => kind.desktop);
  return { x11: desktops.some((kind) => kind.windowing === "x11"), wayland: desktops.some((kind) => kind.windowing === "wayland") };
}

/** The kind the choice names: the desktop of its windowing and GPU, falling back to its windowing, then to any that exists. */
export function kindFor(kinds: readonly KindView[], choice: Choice): KindView | null {
  const at = kindsAt(kinds, choice.os, choice.arch).filter((kind) => kind.desktop === choice.desktop);
  if (!at.length) return null;
  if (!choice.desktop) return at.find((kind) => kind.gpu === choice.gpu) ?? at[0]!;
  return at.find((kind) => kind.windowing === choice.windowing && kind.gpu === choice.gpu) ?? at.find((kind) => kind.windowing === choice.windowing) ?? at[0]!;
}

/** The nearest choice that exists: the OS stays, then the arch, the type, the windowing, and the GPU snap to what there is. */
export function nearest(kinds: readonly KindView[], wanted: Choice): Choice {
  const os = kinds.some((kind) => kind.os === wanted.os) ? wanted.os : (systemsOf(kinds)[0]?.os ?? wanted.os);
  const arch = archAvailable(kinds, os, wanted.arch) ? wanted.arch : (ARCHS.find((candidate) => archAvailable(kinds, os, candidate.id))?.id ?? wanted.arch);
  const desktop = typeAvailable(kinds, os, arch, wanted.desktop) ? wanted.desktop : !wanted.desktop;
  const displays = displayChoices(kinds, os, arch);
  // A desktop keeps the windowing wanted when it exists, else the other; a server has none, so "x11" stands in.
  const windowing: Windowing = !desktop ? "x11" : wanted.windowing === "wayland" ? (displays.wayland ? "wayland" : "x11") : displays.x11 ? "x11" : "wayland";
  const choices = gpuChoices(kinds, os, arch, windowing);
  const gpu = desktop ? (wanted.gpu ? choices.gpu : !choices.none && choices.gpu) : false;
  return { os, arch, desktop, gpu, windowing };
}

/** The choice a kind stands for, for the form to open on a remembered kind. */
export function choiceOf(kind: KindView): Choice {
  return { os: kind.os, arch: archOf(kind), desktop: kind.desktop, gpu: kind.gpu, windowing: kind.windowing };
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

/**
 * A row's second line: what the boxes are, "ready now" (green) when the box would claim a spare there, free machines, the usual start.
 * `ready` is the form's say, as the box's image and size decide (#440); a spare's count is no use to the person, so it is not given.
 * A spare that waits stopped resumes first, which takes some seconds (about 12 for Windows on Proxmox), so it says "ready in seconds" (#539).
 */
export function OfferWords({ offer, ready = offer.ready > 0 }: { offer: OfferView; ready?: boolean }) {
  const parts: ReactNode[] = [];
  const form = formWords(offer);
  if (form) parts.push(<span key="form">{form}</span>);
  if (ready) parts.push(<span key="ready" className="text-emerald-700 dark:text-emerald-400">{offer.spareStarts ? "ready in seconds" : "ready now"}</span>);
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

/**
 * A provider row: one card, its name at full strength, its words dim, no
 * mark and no colour; the hover and chosen backgrounds span the whole
 * card, and the (i) that opens its profile sits inside at the right, shown
 * while the pointer is over the row, the row or the (i) has keyboard
 * focus, or the profile is open, its space kept otherwise so nothing
 * shifts; a touch screen, with no hover, shows it on the chosen row (the
 * operator's notes of 2 October 2026).
 */
export function ProviderRow({
  offer,
  among,
  ready,
  selected,
  onClick,
  optionRef,
  info,
}: {
  offer: OfferView;
  /** The kind's other offers, whose names this row's must not repeat. */
  among?: readonly OfferView[];
  ready?: boolean;
  selected: boolean;
  onClick: () => void;
  optionRef?: (element: HTMLButtonElement | null) => void;
  info?: ReactNode;
}) {
  return (
    <div className={cn("group flex items-center rounded-md border", selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover")}>
      <button
        ref={optionRef}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onClick}
        className="flex min-w-0 flex-1 flex-col items-start rounded-md px-3 py-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="block w-full truncate text-xs font-medium text-foreground">{providerTitle(offer, among)}</span>
        <OfferWords offer={offer} ready={ready} />
      </button>
      {info ? (
        <div
          data-testid="provider-info"
          className={cn(
            "flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 has-[[data-state=open]]:opacity-100",
            selected && "[@media(hover:none)]:opacity-100",
          )}
        >
          {info}
        </div>
      ) : null}
    </div>
  );
}

export const TYPE_GLYPHS = { server: <ServerGlyph className="mt-0.5 shrink-0 text-muted-foreground" />, desktop: <MonitorGlyph className="mt-0.5 shrink-0 text-muted-foreground" /> };
