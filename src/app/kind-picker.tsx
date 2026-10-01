// The kind picker's words and parts: rows grouped by OS and named by their
// tools, a provider mark per offer, and the detail pane that follows the
// pointer or the keyboard (the operator's notes of 1 October 2026).

import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { DockerGlyph, LaptopGlyph, MonitorGlyph, PlugGlyph, ProxmoxGlyph, ServerGlyph } from "./glyphs.tsx";
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

/** Some offer of the kind has Docker, for the pane's Has and Lacks (041). The row's badge reads the kind's own docker. */
export function kindHasDocker(kind: KindView): boolean {
  return kind.offers.length ? kind.offers.some((offer) => offer.docker) : kind.features.includes("docker");
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

/** "Proxmox LXC on pve1", "Tart on 2 Macs", "SSH host pool": the name the server made, which `on` takes too (044). */
export function offerWhere(offer: OfferView): string {
  return offer.name;
}

/** The host's short name for a row's mark: one host's name, or a count. */
function hostWords(offer: OfferView): string | null {
  if (offer.hosts.length === 1) return offer.hosts[0]!;
  if (offer.hosts.length > 1) return `${offer.hosts.length} ${offer.type === "tart" ? "Macs" : "hosts"}`;
  return null;
}

const FORM_WORDS: Record<BoxForm, string> = { LXC: "LXC container", Docker: "container", VM: "VM", Physical: "a physical machine" };

/** The readiness words of an offer, as parts: spares ready (green), free machines, and the usual start (muted). */
function offerReadiness(offer: OfferView): ReactNode[] {
  const parts: ReactNode[] = [];
  if (offer.ready) parts.push(<span key="ready" className="text-emerald-700 dark:text-emerald-400">{offer.ready} ready now</span>);
  if (offer.free !== null) parts.push(<span key="free">{offer.free} free</span>);
  if (offer.typicalReadyMs !== null) parts.push(<span key="usually">usually about {seconds(offer.typicalReadyMs)}</span>);
  return parts;
}

/** The provider marks at the right of a row: a glyph per offer, in its colour, with the host's name when there is one offer. */
export function OfferMarks({ offers }: { offers: readonly OfferView[] }) {
  if (!offers.length) return null;
  const single = offers.length === 1 ? offers[0]! : null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-2xs leading-none text-subtle-foreground">
      {offers.map((offer) => (
        <span key={offer.backend} role="img" aria-label={offerWhere(offer)} className="inline-flex">
          <ProviderGlyph offer={offer} className="size-3.5" />
        </span>
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

/** Where the box goes (044): a provider's backend ID, or null for the first with room. */
export interface ProviderChoice {
  readonly value: string | null;
  readonly onChange: (value: string | null) => void;
}

/**
 * The detail pane: who provides the kind and where, how soon, and what it has
 * and lacks. `id` lets each kind option describe itself by it. With `choice`,
 * for the chosen kind with more than one offer, the offers are a choice with
 * "First with room" first (044); otherwise they are plain text. Facts are
 * rows, a dim label above its words, since two columns wrap into a mess at
 * the pane's width (the operator's note of 1 October 2026).
 */
export function KindDetail({ kind, pluginId, id, className, choice }: { kind: KindView; pluginId: string; id: string; className?: string; choice?: ProviderChoice }) {
  void pluginId;
  const offers = kind.offers;
  const choosing = choice !== undefined && offers.length > 1;
  const options = useRef<(HTMLButtonElement | null)[]>([]);
  const values: (string | null)[] = [null, ...offers.map((offer) => offer.backend)];
  const chosenIndex = Math.max(0, values.indexOf(choice?.value ?? null));
  const pick = (position: number) => {
    choice?.onChange(values[position] ?? null);
    options.current[position]?.focus();
  };
  const arrows = (event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    pick((chosenIndex + step + values.length) % values.length);
  };
  /** The offer's line: its glyph and name in the provider's colour, then what the boxes are and how soon, dim. */
  const offerLine = (offer: OfferView) => {
    const rest: ReactNode[] = [...(offer.form ? [<span key="form">{FORM_WORDS[offer.form]}</span>] : []), ...offerReadiness(offer)];
    return (
      <>
        <ProviderGlyph offer={offer} className="mt-0.5 size-3.5" />
        <span className="min-w-0">
          <span className={cn("font-medium", providerTone(offer))}>{offerWhere(offer)}</span>
          {rest.length ? (
            <span className="text-muted-foreground">
              {rest.map((part, index) => (
                <span key={index}>
                  {" · "}
                  {part}
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </>
    );
  };
  return (
    <div id={id} className={cn("min-w-0 text-xs leading-snug text-foreground", className)}>
      <p className="flex items-center gap-2 font-medium">
        {kind.desktop ? <MonitorGlyph className="text-muted-foreground" /> : <ServerGlyph className="text-muted-foreground" />}
        <span className="min-w-0">{kindName(kind)}</span>
      </p>
      {choosing ? (
        <div role="radiogroup" aria-label="Provider" className="mt-2 space-y-0.5" onKeyDown={arrows}>
          {values.map((value, position) => {
            const selected = position === chosenIndex;
            const offer = value === null ? null : offers.find((candidate) => candidate.backend === value)!;
            return (
              <button
                key={value ?? "first"}
                ref={(element) => {
                  options.current[position] = element;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => pick(position)}
                className={cn(
                  "flex w-full items-start gap-1.5 rounded-sm px-1.5 py-1 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
                  selected && "bg-state-active",
                )}
              >
                {offer ? (
                  offerLine(offer)
                ) : (
                  <>
                    <Icon name="Check" className={cn("mt-0.5 size-3.5 shrink-0", selected ? "text-foreground" : "invisible")} aria-hidden />
                    <span className="min-w-0">
                      <span className="font-medium">First with room</span>
                      <span className="text-muted-foreground"> · in this order</span>
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      ) : offers.length ? (
        <ul className="mt-2 space-y-1">
          {offers.map((offer, index) => (
            <li key={offer.backend} className="flex items-start gap-1.5">
              {index > 0 ? <span className="mt-0.5 w-3.5 shrink-0 text-muted-foreground">or</span> : null}
              {offerLine(offer)}
            </li>
          ))}
          {offers.length > 1 ? <li className="pl-5 text-muted-foreground">the first with room, in that order</li> : null}
        </ul>
      ) : kind.backends.length ? (
        <p className="mt-2 text-muted-foreground">{kind.backends.join(", or ")}</p>
      ) : null}
      <dl className="mt-3 space-y-2">
        {kindFacts(kind).map((fact) => (
          <Fact key={fact.label} label={fact.label}>
            {fact.words}
          </Fact>
        ))}
      </dl>
    </div>
  );
}

/** One fact as a row: a dim small label, its words under it. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-2xs font-medium text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-muted-foreground">{children}</dd>
    </div>
  );
}
