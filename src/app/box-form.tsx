// The stepped box form (the operator's redesign of 1 October 2026): steps
// that narrow each other, System, Architecture, Type, Provider, Resources,
// Name, then a summary and one button. The words come from today's kinds
// and offers; nothing here names a kind ID or a host ID.

import type { ReactNode } from "react";
import type { GuestOs } from "../backends/types.ts";
import type { KindView, OfferView } from "../plugin/views.ts";
import { cn } from "@/lib/utils";
import { osName, seconds } from "./common.tsx";
import { DockerGlyph, LaptopGlyph, MonitorGlyph, PlugGlyph, ProxmoxGlyph, ServerGlyph } from "./glyphs.tsx";

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
    <span className="text-2xs text-muted-foreground">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : ""}
          {part}
        </span>
      ))}
    </span>
  );
}

/** The summary bar's words: "Linux · x86_64 · Desktop on first provider with room · 4 cores · 8 GiB". */
export function summaryWords(choice: Choice, kind: KindView | null, on: OfferView | null, size: { cores: number; memoryGiB: number } | null): string {
  const type = choice.desktop ? "Desktop" : "Server";
  const where = on ? providerTitle(on) : "first provider with room";
  const parts = [osName(choice.os), choice.arch, `${type} on ${where}`];
  if (size) parts.push(`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${size.memoryGiB} GiB`);
  if (kind?.desktop && kind.gpu) parts.push("1 GPU");
  return parts.join(" · ");
}

/** The access a box gives: a terminal always, a desktop and computer use when it has them. */
export function accessWords(kind: KindView | null, choice: Choice): string[] {
  const words = ["Terminal"];
  if (choice.desktop) words.push("Desktop");
  if (kind?.computerUse) words.push("Computer use");
  return words;
}

/** One step: its label left, its options right; narrow panels stack them. */
export function Step({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-3">
      <p className="text-xs font-medium text-foreground sm:pt-1.5">{label}</p>
      <div className="min-w-0">
        {children}
        {hint ? <p className="mt-1 text-2xs leading-snug text-subtle-foreground">{hint}</p> : null}
      </div>
    </div>
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
        "flex min-w-0 flex-1 items-start gap-2 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
        !available && "cursor-default opacity-50 hover:bg-transparent",
      )}
    >
      {glyph}
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        <span className="block truncate text-2xs text-muted-foreground">{available ? words : "Not available"}</span>
      </span>
    </button>
  );
}

/** A filter chip, BB's small bordered word, pressed when chosen. */
export function Chip({ label, selected, available = true, title, onClick }: { label: string; selected: boolean; available?: boolean; title?: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-disabled={!available || undefined}
      title={title}
      onClick={() => {
        if (available) onClick();
      }}
      className={cn(
        "rounded-full border px-2 py-0.5 text-2xs leading-none outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-transparent bg-foreground text-background" : "border-border text-muted-foreground hover:bg-state-hover",
        !available && "cursor-default opacity-50 hover:bg-transparent",
      )}
    >
      {label}
    </button>
  );
}

/** The glyph for an offer's provider: Proxmox, Docker, a laptop for a Mac, a plug for a pool machine, a server otherwise. */
export function providerGlyph(offer: Pick<OfferView, "type">): "proxmox" | "docker" | "laptop" | "plug" | "server" {
  switch (offer.type) {
    case "proxmox-lxc":
    case "proxmox-qemu":
      return "proxmox";
    case "docker":
      return "docker";
    case "tart":
      return "laptop";
    case "ssh-pool":
      return "plug";
    default:
      return "server";
  }
}

/**
 * The provider's brand colour on its glyph and name, so providers tell apart
 * at a glance (the operator's note of 1 October 2026): Proxmox orange and
 * Docker blue, each a shade that reads on light and dark; a neutral for a
 * Mac and a pool machine.
 */
export function providerTone(offer: Pick<OfferView, "type">): string {
  switch (providerGlyph(offer)) {
    case "proxmox":
      return "text-orange-700 dark:text-orange-400";
    case "docker":
      return "text-sky-700 dark:text-sky-400";
    default:
      return "text-foreground";
  }
}

/** The provider's glyph, inline, with its room reserved. */
export function ProviderGlyph({ offer, className }: { offer: Pick<OfferView, "type">; className?: string }) {
  const props = { className: cn(providerTone(offer), className) };
  switch (providerGlyph(offer)) {
    case "proxmox":
      return <ProxmoxGlyph {...props} />;
    case "docker":
      return <DockerGlyph {...props} />;
    case "laptop":
      return <LaptopGlyph {...props} />;
    case "plug":
      return <PlugGlyph {...props} />;
    default:
      return <ServerGlyph {...props} />;
  }
}

/** A provider row: its glyph in its colour, its name, and its words. */
export function ProviderRow({ offer, selected, onClick, optionRef }: { offer: OfferView; selected: boolean; onClick: () => void; optionRef?: (element: HTMLButtonElement | null) => void }) {
  return (
    <button
      ref={optionRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring",
        selected ? "border-transparent bg-state-active" : "border-input hover:bg-state-hover",
      )}
    >
      <ProviderGlyph offer={offer} className="mt-0.5 size-3.5" />
      <span className="min-w-0">
        <span className={cn("block truncate text-xs font-medium", providerTone(offer))}>{providerTitle(offer)}</span>
        <OfferWords offer={offer} />
      </span>
    </button>
  );
}

export const TYPE_GLYPHS = { server: <ServerGlyph className="mt-0.5 text-muted-foreground" />, desktop: <MonitorGlyph className="mt-0.5 text-muted-foreground" /> };
