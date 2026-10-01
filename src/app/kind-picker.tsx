// The kind picker's words and parts: rows grouped by OS and named by their
// tools, a provider mark per offer, and the detail pane that follows the
// pointer or the keyboard (the operator's notes of 1 October 2026).

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import type { BoxForm } from "../backends/types.ts";
import type { KindView, OfferView, SizeView } from "../plugin/views.ts";
import { cn } from "@/lib/utils";
import { isArm64Badge, osName, seconds } from "./common.tsx";

/** OS groups in the order the list shows them; an OS bb-box does not know yet goes last. */
const OS_ORDER = ["linux", "macos", "windows"];

export interface KindGroup {
  readonly os: string;
  readonly label: string;
  readonly kinds: readonly KindView[];
}

/** The kinds grouped by OS, each group in the order given. */
export function groupKinds(kinds: readonly KindView[]): KindGroup[] {
  const groups = new Map<string, KindView[]>();
  for (const kind of kinds) (groups.get(kind.os) ?? groups.set(kind.os, []).get(kind.os)!).push(kind);
  return [...groups.entries()]
    .sort(([a], [b]) => (OS_ORDER.indexOf(a) + 1 || 99) - (OS_ORDER.indexOf(b) + 1 || 99))
    .map(([os, members]) => ({ os, label: osName(os), kinds: members }));
}

/** A row's name within its OS group: what the box has, "Terminal" or "Desktop", and what sets it apart. */
export function kindTitle(kind: KindView): string {
  const parts = [kind.desktop ? "Desktop" : "Terminal"];
  if (kind.gpu) parts.push("GPU");
  if (isArm64Badge(kind.os, kind.arch)) parts.push("arm64");
  return parts.join(", ");
}

/** The kind's full name for the pane: "Linux desktop on a GPU", "Windows desktop", "Linux terminal, arm64". */
export function kindName(kind: KindView): string {
  let name = `${osName(kind.os)} ${kind.desktop ? "desktop" : "terminal"}`;
  if (kind.gpu) name += " on a GPU";
  if (isArm64Badge(kind.os, kind.arch)) name += ", arm64";
  return name;
}

/** Every offer of the kind has Docker; a kind row says "No Docker" only when none has (041). */
export function kindHasDocker(kind: KindView): boolean {
  return kind.offers.length ? kind.offers.some((offer) => offer.docker) : kind.features.includes("docker");
}

/** The glyph for an offer's provider, from the plugin's own assets. */
export function providerGlyph(offer: OfferView): string {
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

/** The driver's name without its aside: "Tart (VMs on a Mac)" reads "Tart" before "on mac-mini". */
function shortLabel(offer: OfferView): string {
  return offer.label.replace(/\s*\([^)]*\)\s*$/, "");
}

/** "Proxmox LXC on pve1", "Tart on 2 Macs", "SSH host pool". */
export function offerWhere(offer: OfferView): string {
  const label = shortLabel(offer);
  if (offer.hosts.length === 1) return `${label} on ${offer.hosts[0]}`;
  if (offer.hosts.length > 1) return `${label} on ${offer.hosts.length} ${offer.type === "tart" ? "Macs" : "hosts"}`;
  return label;
}

/** The host's short name for a row's mark: one host's name, or a count. */
function hostWords(offer: OfferView): string | null {
  if (offer.hosts.length === 1) return offer.hosts[0]!;
  if (offer.hosts.length > 1) return `${offer.hosts.length} ${offer.type === "tart" ? "Macs" : "hosts"}`;
  return null;
}

const FORM_WORDS: Record<BoxForm, string> = { LXC: "LXC container", Docker: "container", VM: "VM", Physical: "a physical machine" };

/** The readiness words of an offer: spares ready, free machines, and the usual start. */
function offerReadiness(offer: OfferView): string[] {
  const words: string[] = [];
  if (offer.ready) words.push(`${offer.ready} ready now`);
  if (offer.free !== null) words.push(`${offer.free} free`);
  if (offer.typicalReadyMs !== null) words.push(`usually about ${seconds(offer.typicalReadyMs)}`);
  return words;
}

/** The provider marks at the right of a row: a glyph per offer, with the host's name when there is one offer. */
export function OfferMarks({ offers, pluginId }: { offers: readonly OfferView[]; pluginId: string }) {
  if (!offers.length) return null;
  const single = offers.length === 1 ? offers[0]! : null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs leading-none text-subtle-foreground">
      {offers.map((offer) => (
        <Icon key={offer.backend} name={`${pluginId}/${providerGlyph(offer)}`} className="size-3.5" aria-label={offerWhere(offer)} />
      ))}
      {single && hostWords(single) ? <span aria-hidden>{hostWords(single)}</span> : null}
    </span>
  );
}

function sizeWords(size: SizeView): string {
  return `${size.cores} ${size.cores === 1 ? "core" : "cores"} · ${size.memoryGiB} GiB`;
}

/** "Small 4 cores · 8 GiB (default) · Medium 8 cores · 16 GiB · Large 16 cores · 32 GiB · custom up to 32 cores · 64 GiB · 256 GiB disk". */
export function kindSizes(kind: KindView): string {
  const names: Record<string, string> = { small: "Small", medium: "Medium", large: "Large" };
  const presets = kind.presets.map((preset) => `${names[preset.name] ?? preset.name} ${sizeWords(preset)}${preset.name === kind.defaultPreset ? " (default)" : ""}`);
  const largest = `custom up to ${sizeWords(kind.largest)}${kind.largest.diskGiB !== null ? ` · ${kind.largest.diskGiB} GiB disk` : ""}`;
  return [...presets, largest].join(" · ");
}

/** The pane's facts about a kind, as label and words. */
export function kindFacts(kind: KindView): { readonly label: string; readonly words: string }[] {
  const windows = kind.os === "windows";
  const admin = kind.admin === true ? (windows ? "Administrator" : "root through sudo") : kind.admin === null ? (windows ? "Administrator on some backends" : "root on some backends") : null;
  const resizable = kind.offers.length ? kind.offers.some((offer) => offer.resizable === true) : false;
  const docker = kindHasDocker(kind);
  const has = [
    kind.desktop ? (kind.gpu ? "a desktop on the GPU" : "a desktop") : null,
    kind.computerUse ? "computer use" : null,
    resizable ? "follows the panel's size" : null,
    docker ? "Docker" : null,
  ].filter((item): item is string => item !== null);
  const lacks = [docker ? null : "Docker", kind.desktop && !kind.computerUse ? "computer use" : null].filter((item): item is string => item !== null);
  const facts = [
    { label: "System", words: [`${osName(kind.os)} ${kind.arch}`, admin].filter(Boolean).join(" · ") },
    { label: "Has", words: has.length ? has.join(" · ") : "a terminal" },
  ];
  if (lacks.length) facts.push({ label: "Lacks", words: lacks.join(" · ") });
  facts.push({
    label: "BB machine",
    words: kind.enrol ? "yes: Git credentials, machine variables, child threads" : "no: no Git credentials, machine variables or threads on it",
  });
  facts.push({ label: "Sizes", words: kindSizes(kind) });
  return facts;
}

/**
 * The detail pane: who provides the kind and where, how soon, and what it has
 * and lacks. `id` lets each kind option describe itself by it.
 */
export function KindDetail({ kind, pluginId, id, className }: { kind: KindView; pluginId: string; id: string; className?: string }) {
  const offers = kind.offers;
  return (
    <div id={id} className={cn("min-w-0 text-xs leading-snug text-foreground", className)}>
      <p className="flex items-center gap-2 font-medium">
        <Icon name={`${pluginId}/${kind.desktop ? "monitor" : "server"}`} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0">{kindName(kind)}</span>
      </p>
      {offers.length ? (
        <ul className="mt-1.5 space-y-0.5">
          {offers.map((offer, index) => {
            const words = [offer.form ? FORM_WORDS[offer.form] : null, ...offerReadiness(offer)].filter(Boolean);
            return (
              <li key={offer.backend} className="flex items-start gap-1.5">
                <Icon name={`${pluginId}/${providerGlyph(offer)}`} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  {index > 0 ? <span className="text-muted-foreground">or </span> : null}
                  {offerWhere(offer)}
                  {words.length ? <span className="text-muted-foreground"> · {words.join(" · ")}</span> : null}
                </span>
              </li>
            );
          })}
          {offers.length > 1 ? <li className="pl-5 text-muted-foreground">the first with room, in that order</li> : null}
        </ul>
      ) : kind.backends.length ? (
        <p className="mt-1.5 text-muted-foreground">{kind.backends.join(", or ")}</p>
      ) : null}
      <dl className="mt-2 grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        {kindFacts(kind).map((fact) => (
          <Fact key={fact.label} label={fact.label}>
            {fact.words}
          </Fact>
        ))}
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
