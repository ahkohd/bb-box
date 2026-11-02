import { parseTags } from "../proxmox/api.ts";
import { isEarlierGuest, isHeldCopy } from "../proxmox/copies.ts";
import { installTag, isTemplate } from "../proxmox/owner.ts";
import type { GpuPart } from "../types.ts";
import type { GpuHelperVerdict } from "./gpu-helper.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MARKER = new RegExp(`^gpu\\.(?:(none|release)|(shared|whole)\\.(${UUID}))\\.g([1-9][0-9]{0,8})$`);
const DEVICE_MODE = "0666";
const MOST_NAMED = 8;
const HELD_COPY_DESCRIPTION = /^bb-box install \S+ box \S+ held copy of snapshot /;

export type MarkerPart = GpuPart | "release";

export interface GpuMarker {
  readonly part: MarkerPart;
  readonly card: string | null;
  readonly generation: number;
}

export interface ClaimMarker extends GpuMarker {
  readonly part: GpuPart;
}

export function parseMarker(tag: string): GpuMarker | null {
  const match = MARKER.exec(tag);
  if (!match) return null;
  return { part: (match[1] ?? match[2]) as MarkerPart, card: match[3] ?? null, generation: Number(match[4]) };
}

export function markerTag(marker: GpuMarker): string {
  return marker.card === null ? `gpu.${marker.part}.g${marker.generation}` : `gpu.${marker.part}.${marker.card}.g${marker.generation}`;
}

export function isClaimMarker(marker: GpuMarker | null): marker is ClaimMarker {
  return marker !== null && marker.part !== "release";
}

export function claimMarkerOf(tags: readonly string[]): ClaimMarker | null {
  const marker = markerOf(tags);
  return isClaimMarker(marker) ? marker : null;
}

export function withMarker(tags: readonly string[], marker: GpuMarker): string[] {
  const gpu = gpuTagsOf(tags);
  return [...tags.filter((tag) => !gpu.includes(tag)), markerTag(marker)];
}

export function gpuTagsOf(tags: readonly string[]): string[] {
  return tags.filter((tag) => tag.toLowerCase().startsWith("gpu."));
}

export function markerOf(tags: readonly string[]): GpuMarker | null {
  const gpu = gpuTagsOf(tags);
  return gpu.length === 1 ? parseMarker(gpu[0]!) : null;
}

export function withGpuTagsOf(before: readonly string[], after: readonly string[]): string[] {
  const kept = gpuTagsOf(before);
  return [...after.filter((tag) => !kept.includes(tag)), ...kept];
}

export interface HelperCard {
  readonly uuid: string;
  readonly index: number | null;
  readonly pci: string;
  readonly minor: number | null;
  readonly drmCard: string | null;
  readonly drmRender: string | null;
}

export interface HelperHolder {
  readonly card: string;
  readonly vmid: number;
  readonly part: "shared" | "whole";
  readonly running: boolean;
  readonly install: string | null;
  readonly managed: boolean;
}

export interface HelperWould {
  readonly vmid: number;
  readonly words: string;
}

export type HelperAnswer =
  | { readonly vmid: number; readonly generation: number; readonly is: "granted"; readonly part: GpuPart; readonly card: string | null }
  | { readonly vmid: number; readonly generation: number; readonly is: "refused"; readonly reason: string; readonly detail: string | null }
  | { readonly vmid: number; readonly generation: number; readonly is: "yielded"; readonly card: string }
  | { readonly vmid: number; readonly generation: number; readonly is: "released" };

export interface LedgerClaim {
  readonly generation: number;
  readonly part: GpuPart;
  readonly card: string | null;
  readonly answer: "granted" | "yielded";
}

export interface LedgerEntry {
  readonly vmid: number;
  readonly box: string | null;
  readonly answered: number;
  readonly claim: LedgerClaim | null;
}

export interface HelperLines {
  readonly cards: readonly HelperCard[];
  readonly holders: readonly HelperHolder[];
  readonly ledgerReported: boolean;
  readonly ledger: ReadonlyMap<number, LedgerEntry>;
  readonly would: readonly HelperWould[];
  readonly answers: readonly HelperAnswer[];
  readonly omitted: readonly string[];
}

export const NO_HELPER_LINES: HelperLines = { cards: [], holders: [], ledgerReported: false, ledger: new Map(), would: [], answers: [], omitted: [] };

const orNull = (value: string | undefined): string | null => (value === undefined || value === "-" ? null : value);
const numberOrNull = (value: string | undefined): number | null => (value === undefined || value === "-" ? null : Number(value));

function reportLines(notes: string): string[] {
  return notes.split("\n").map((line) => line.trim());
}

export function parseHelperLines(notes: string): HelperLines {
  const indexes = new Map<string, number>();
  const cards: HelperCard[] = [];
  const holders: HelperHolder[] = [];
  const ledger = new Map<number, LedgerEntry>();
  const would: HelperWould[] = [];
  const answers: HelperAnswer[] = [];
  const omitted: string[] = [];
  let ledgerReported = false;
  for (const line of reportLines(notes)) {
    let match: RegExpExecArray | null;
    if ((match = /^gpu (?:GPU-)?(\S+) \S+ (\d+) \d+ \d+$/i.exec(line))) indexes.set(match[1]!.toLowerCase(), Number(match[2]));
    else if ((match = new RegExp(`^card (${UUID}) pci (\\S+) minor (\\d+|-) drm (\\S+) (\\S+)$`).exec(line))) {
      cards.push({ uuid: match[1]!, index: null, pci: match[2]!, minor: numberOrNull(match[3]), drmCard: orNull(match[4]), drmRender: orNull(match[5]) });
    } else if ((match = new RegExp(`^holder (${UUID}) (\\d+) (shared|whole) (running|stopped) (?:install (\\S+)|other) (managed|unmanaged)$`).exec(line))) {
      holders.push({ card: match[1]!, vmid: Number(match[2]), part: match[3] as "shared" | "whole", running: match[4] === "running", install: match[5] ?? null, managed: match[6] === "managed" });
    } else if (/^ledger entries \d+$/.test(line)) ledgerReported = true;
    else if ((match = /^ledger (\d+) box (\S+) answered g(\d+) claim (?:none|g(\d+) (none|shared|whole) (\S+) (granted|yielded))$/.exec(line))) {
      const claim = match[4] === undefined ? null : { generation: Number(match[4]), part: match[5] as GpuPart, card: orNull(match[6]), answer: match[7] as "granted" | "yielded" };
      ledger.set(Number(match[1]), { vmid: Number(match[1]), box: orNull(match[2]), answered: Number(match[3]), claim });
    } else if ((match = /^would (\d+) (.+)$/.exec(line))) would.push({ vmid: Number(match[1]), words: match[2]! });
    else if ((match = /^claim (\d+) g(\d+) granted (none|shared|whole)(?: (\S+))?$/.exec(line))) {
      answers.push({ vmid: Number(match[1]), generation: Number(match[2]), is: "granted", part: match[3] as GpuPart, card: match[4] ?? null });
    } else if ((match = /^claim (\d+) g(\d+) refused (\S+) \S+(?: (\S+))?$/.exec(line))) {
      answers.push({ vmid: Number(match[1]), generation: Number(match[2]), is: "refused", reason: match[3]!, detail: match[4] ?? null });
    } else if ((match = /^claim (\d+) g(\d+) yielded (\S+) \d+$/.exec(line))) {
      answers.push({ vmid: Number(match[1]), generation: Number(match[2]), is: "yielded", card: match[3]! });
    } else if ((match = /^claim (\d+) g(\d+) released$/.exec(line))) {
      answers.push({ vmid: Number(match[1]), generation: Number(match[2]), is: "released" });
    } else if ((match = /^omitted (.+)$/.exec(line))) omitted.push(match[1]!);
  }
  return { cards: cards.map((card) => ({ ...card, index: indexes.get(card.uuid) ?? null })), holders, ledgerReported, ledger, would, answers, omitted };
}

export function cardName(card: HelperCard): string {
  return card.index === null ? `card ${card.uuid}` : `card ${card.index}`;
}

export interface DeviceLine {
  readonly key: string;
  readonly path: string;
  readonly normal: string;
}

function parseDevice(key: string, value: unknown): DeviceLine | null {
  let path: string | null = null;
  const options = new Map<string, string>();
  for (const part of String(value ?? "").split(",")) {
    const option = /^([a-z-]+)=(.*)$/.exec(part);
    if (option) {
      if (option[1] === "path") path = option[2]!;
      else options.set(option[1]!, option[2]!);
    } else if (path === null) path = part;
  }
  if (!path) return null;
  const normal = [path, ...[...options.keys()].sort().map((name) => `${name}=${options.get(name)}`)].join(",");
  return { key, path, normal };
}

const isGpuDevicePath = (path: string) => /^\/dev\/(?:nvidia|dri(?:\/|$))/.test(path);

export function gpuDeviceLines(config: Readonly<Record<string, unknown>>): DeviceLine[] {
  return Object.keys(config)
    .filter((key) => /^dev\d+$/.test(key))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .flatMap((key) => {
      const device = parseDevice(key, config[key]);
      return device && isGpuDevicePath(device.path) ? [device] : [];
    });
}

export interface PendingChange {
  readonly key: string;
  readonly pending: string | null;
  readonly deleting: boolean;
}

export interface GuestLook {
  readonly vmid: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly pending: readonly PendingChange[];
}

export function tagsOf(look: GuestLook): string[] {
  return parseTags(look.config.tags);
}

function descriptionOf(look: GuestLook): string {
  return typeof look.config.description === "string" ? look.config.description : "";
}

export function pendingGpuLines(pending: readonly PendingChange[]): DeviceLine[] {
  return pending.flatMap((change) => {
    if (!/^dev\d+$/.test(change.key) || change.pending === null) return [];
    const device = parseDevice(change.key, change.pending);
    return device && isGpuDevicePath(device.path) ? [device] : [];
  });
}

export function pendingDeviceChange(pending: readonly PendingChange[]): boolean {
  return pending.some((change) => /^dev\d+$/.test(change.key) && (change.pending !== null || change.deleting));
}

function rawEntries(config: Readonly<Record<string, unknown>>): (readonly [string, string])[] {
  const raw = config.lxc;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string" ? [[entry[0], entry[1]] as const] : []));
}

const GPU_DEVICE_RULE = /^(?:a(?:\s|$)|[cb]\s+\*:|c\s+(?:195|226):)/;

export function rawGpuLines(config: Readonly<Record<string, unknown>>): string[] {
  return rawEntries(config).flatMap(([key, value]) => {
    if (key === "lxc.mount.entry") return isGpuDevicePath(value.trim().split(/\s+/)[0] ?? "") ? [`${key}: ${value}`] : [];
    if (/^lxc\.cgroup2?\.devices\.allow$/.test(key)) return GPU_DEVICE_RULE.test(value.trim()) ? [`${key}: ${value}`] : [];
    return [];
  });
}

function cardsNamedByPath(path: string, cards: readonly HelperCard[]): HelperCard[] | null {
  if (/^\/dev\/dri\/?$/.test(path)) return [...cards];
  let match: RegExpExecArray | null;
  if ((match = /^\/dev\/nvidia(\d+)$/.exec(path))) return cards.filter((card) => card.minor === Number(match![1]));
  if ((match = /^\/dev\/dri\/((?:card|renderD)\d+)$/.exec(path))) return cards.filter((card) => card.drmCard === match![1] || card.drmRender === match![1]);
  if ((match = /^\/dev\/dri\/by-path\/pci-(.+)-(?:card|render)$/.exec(path))) return cards.filter((card) => card.pci === match![1]!.toLowerCase());
  return null;
}

export function cardsNamedBy(devices: readonly DeviceLine[], cards: readonly HelperCard[]): HelperCard[] {
  const named = new Set(devices.flatMap((device) => cardsNamedByPath(device.path, cards) ?? []));
  return cards.filter((card) => named.has(card));
}

export function nodesOfNoCard(devices: readonly DeviceLine[], cards: readonly HelperCard[]): string[] {
  return devices.filter((device) => cardsNamedByPath(device.path, cards)?.length === 0).map((device) => device.path);
}

export type DeviceSet = "server" | "desktop";

export function deviceSetOf(tags: readonly string[], description: string): DeviceSet {
  let kind: string | null = null;
  if (description.startsWith("bb-box ") && !HELD_COPY_DESCRIPTION.test(description)) {
    kind = /^kind (\S+)$/m.exec(description)?.[1] ?? null;
    const warm = /^bb-box warm (\S+)$/m.exec(description)?.[1];
    if (kind === null && warm) kind = `warm-${warm}`;
  }
  const tagged = tags.find((tag) => tag.startsWith("kind."));
  if (tagged !== undefined) kind = tagged.slice(5);
  return kind !== null && (/^linux-desktop/.test(kind) || /^warm-desktop/.test(kind)) ? "desktop" : "server";
}

export function linesFor(card: HelperCard, set: DeviceSet): string[] | null {
  if (card.minor === null) return null;
  const paths = [`/dev/nvidia${card.minor}`, "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools"];
  if (set === "desktop") {
    if (card.drmCard === null || card.drmRender === null) return null;
    paths.push("/dev/nvidia-modeset", `/dev/dri/${card.drmRender}`, `/dev/dri/${card.drmCard}`);
  }
  return paths.map((path) => `${path},mode=${DEVICE_MODE}`);
}

function withoutEach(from: readonly string[], taken: readonly string[]): string[] {
  const left = [...from];
  for (const line of taken) {
    const at = left.indexOf(line);
    if (at >= 0) left.splice(at, 1);
  }
  return left;
}

export function linesDiffer(devices: readonly DeviceLine[], wanted: readonly string[]): { readonly lacks: string[]; readonly extra: string[] } {
  const have = devices.map((device) => device.normal).sort();
  const want = wanted.flatMap((line) => parseDevice("", line)?.normal ?? []).sort();
  return { lacks: withoutEach(want, have), extra: withoutEach(have, want) };
}

export function sameLines(devices: readonly DeviceLine[], wanted: readonly string[]): boolean {
  const have = devices.map((device) => device.normal).sort();
  const want = wanted.flatMap((line) => parseDevice("", line)?.normal ?? []).sort();
  return have.length === want.length && have.every((line, at) => line === want[at]);
}

function installNamed(description: string): string | null {
  return description.startsWith("bb-box ") && !HELD_COPY_DESCRIPTION.test(description) ? (/^install (\S+)$/m.exec(description)?.[1] ?? null) : null;
}

export function boxOf(description: string): string | null {
  const install = installNamed(description);
  const box = /^box (\S+)$/m.exec(description)?.[1];
  return install !== null && box !== undefined && !/^earlier guest$/m.test(description) ? `${install}/${box}` : null;
}

export interface Eligibility {
  readonly installId: string;
  readonly madeAndRemovedByBbBox: (tags: readonly string[]) => boolean;
}

export function ineligibility(look: GuestLook, eligibility: Eligibility): string | null {
  const tags = tagsOf(look);
  const description = descriptionOf(look);
  if (isTemplate(look.config)) return "It is a template now, and templates are never marked.";
  if (isHeldCopy(tags) || HELD_COPY_DESCRIPTION.test(description)) return "It is a held copy of a snapshot now, which holds no card.";
  if (isEarlierGuest(tags) || /^earlier guest$/m.test(description)) return "It is an earlier guest now, kept after a restore, which holds no card.";
  if (eligibility.madeAndRemovedByBbBox(tags)) return "bb-box is making or removing it now: an image box, or a warm guest being filled or retired.";
  if (!tags.includes(installTag(eligibility.installId))) return `Its tags no longer name install ${eligibility.installId}, so it is not this install's.`;
  if (installNamed(description) !== eligibility.installId) return `Its description does not name install ${eligibility.installId}, so it is not this install's to the helper.`;
  return null;
}

export interface MarkCandidate {
  readonly look: GuestLook;
  readonly recordedPart: GpuPart | null;
}

export interface MarkContext extends Eligibility {
  readonly cards: readonly HelperCard[];
  readonly holders: readonly HelperHolder[];
  readonly ledger: ReadonlyMap<number, LedgerEntry>;
  readonly answers: readonly HelperAnswer[];
  readonly boxNamedBy: ReadonlyMap<string, readonly number[]>;
}

export type MarkPlan =
  | { readonly is: "mark"; readonly marker: GpuMarker; readonly card: HelperCard; readonly replaces: string | null; readonly why: string | null }
  | { readonly is: "marked"; readonly marker: GpuMarker; readonly card: HelperCard }
  | { readonly is: "waiting"; readonly marker: GpuMarker; readonly card: HelperCard }
  | { readonly is: "refused"; readonly why: string; readonly card: HelperCard | null }
  | { readonly is: "no-card" };

function inWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function linesWords(differ: { readonly lacks: readonly string[]; readonly extra: readonly string[] }): string {
  const parts = [];
  if (differ.lacks.length) parts.push(`it lacks ${inWords(differ.lacks)}`);
  if (differ.extra.length) parts.push(`it has ${inWords(differ.extra)} besides`);
  return parts.join(", and ");
}

export function refusalInForce(answers: readonly HelperAnswer[], vmid: number, marker: GpuMarker | null): Extract<HelperAnswer, { is: "refused" }> | null {
  if (!marker) return null;
  const refused = answers.find((answer) => answer.vmid === vmid && answer.generation === marker.generation && answer.is === "refused");
  return refused?.is === "refused" ? refused : null;
}

const REFUSALS: Readonly<Record<string, string>> = {
  running: "its device lines would have to change while it runs",
  locked: "it was locked",
  pending: "it had a device change waiting for its next start",
  malformed: "its gpu tags were not one well-formed marker",
  "not-served": "its pool is not one the helper serves",
  privileged: "it is a privileged container",
  template: "it is a template",
  "not-bb-box": "its description names no bb-box install",
  "unknown-card": "the helper does not list its card",
  "card-nodes": "the helper could not find its card's device nodes",
  "no-cards": "nvidia-smi listed no card then",
  "whole-taken": "another guest holds its card whole",
  "card-held": "another guest has its card's devices",
  copy: "another guest holds its box's claim",
  "ledger-lost": "the helper's ledger was rebuilt and its lines did not match its marker",
};

export function refusalWords(reason: string, detail: string | null): string {
  const why = REFUSALS[reason] ?? `the helper's reason was ${reason}`;
  if (detail === null) return why;
  if (reason === "locked") return `it was locked (${detail})`;
  if (/^\d+$/.test(detail) && ["whole-taken", "card-held", "copy"].includes(reason)) return `${why}: CT ${detail}`;
  return why;
}

const CHECKED_BEFORE_ASKING = new Set(Object.keys(REFUSALS));

function claimWords(claim: LedgerClaim | null): string {
  if (!claim) return "no claim";
  return `g${claim.generation} ${claim.answer} ${claim.part}${claim.card ? ` ${claim.card}` : ""}`;
}

export function grantedAsAsked(claim: LedgerClaim | null, marker: GpuMarker): boolean {
  return claim !== null && claim.answer === "granted" && claim.generation === marker.generation && claim.part === marker.part && claim.card === marker.card;
}

export function planMark(guest: MarkCandidate, context: MarkContext): MarkPlan {
  const { look } = guest;
  const { config } = look;
  const tags = tagsOf(look);
  const description = descriptionOf(look);
  const devices = gpuDeviceLines(config);
  const raw = rawGpuLines(config);
  const pending = pendingGpuLines(look.pending);
  const gpu = gpuTagsOf(tags);
  const existing = markerOf(tags);
  if (!devices.length && !raw.length && !pending.length) {
    if (!gpu.length || existing?.part === "none" || existing?.part === "release") return { is: "no-card" };
    return { is: "refused", why: `It has the tag ${gpu.join(" and ")} and no card's device lines; bb box gpu mark leaves a marker it did not write.`, card: null };
  }
  const ineligible = ineligibility(look, context);
  if (ineligible) return { is: "refused", why: ineligible, card: null };
  if (config.lock) return { is: "refused", why: `It is locked (${String(config.lock)}). Run bb box gpu mark again once the lock is gone.`, card: null };
  if (pending.length) {
    return { is: "refused", why: `It has GPU device lines waiting for its next start (${inWords(pending.map((line) => `${line.key}: ${line.normal}`))}), which the helper refuses to act beside. Run bb box gpu mark again after it restarts.`, card: null };
  }
  if (pendingDeviceChange(look.pending)) return { is: "refused", why: "It has a device change waiting for its next start, which the helper refuses to act beside. Run bb box gpu mark again after it restarts.", card: null };
  if (String(config.unprivileged ?? "") !== "1") return { is: "refused", why: "It is a privileged container, which the helper never writes.", card: null };
  if (raw.length) return { is: "refused", why: `It has raw lines for GPU devices (${inWords(raw)}), which the helper does not manage.`, card: null };
  const nowhere = nodesOfNoCard(devices, context.cards);
  if (nowhere.length) return { is: "refused", why: `Its device lines name ${inWords(nowhere)}, which no card in the GPU helper's report has.`, card: null };
  const named = cardsNamedBy(devices, context.cards);
  if (!named.length) return { is: "refused", why: `Its device lines name no card: ${inWords(devices.map((device) => device.path))}.`, card: null };
  if (named.length > 1) return { is: "refused", why: `Its device lines name ${inWords(named.map(cardName))}; a guest holds one card at most.`, card: null };
  const card = named[0]!;
  const set = deviceSetOf(tags, description);
  const wanted = linesFor(card, set);
  if (!wanted) return { is: "refused", why: `The GPU helper's report does not give ${cardName(card)}'s device nodes for a ${set}.`, card };
  if (!sameLines(devices, wanted)) {
    return { is: "refused", why: `Its device lines are not the ones the helper gives a ${set} on ${cardName(card)}: ${linesWords(linesDiffer(devices, wanted))}. Marked, the helper would rewrite them once writes are on.`, card };
  }
  if (guest.recordedPart === "none") return { is: "refused", why: `Its box's record says no GPU, but its device lines name ${cardName(card)}: say which it should have before it is marked.`, card };
  const part: GpuPart = guest.recordedPart === "whole" ? "whole" : "shared";
  const otherClaims = [...context.ledger.values()].filter((entry) => entry.vmid !== look.vmid && entry.claim?.answer === "granted" && entry.claim.card === card.uuid);
  const wholeHolder = otherClaims.find((entry) => entry.claim!.part === "whole") ?? context.holders.find((holder) => holder.card === card.uuid && holder.vmid !== look.vmid && holder.part === "whole");
  if (wholeHolder) return { is: "refused", why: `CT ${wholeHolder.vmid} holds ${cardName(card)} whole, so the helper would refuse it.`, card };
  if (part === "whole") {
    const others = [...new Set(context.holders.filter((holder) => holder.card === card.uuid && holder.vmid !== look.vmid).map((holder) => holder.vmid))].map((vmid) => `CT ${vmid}`);
    if (others.length) return { is: "refused", why: `Its box's record says a whole card, but ${cardName(card)} is also held by ${inWords(others)}, so the helper would refuse it.`, card };
  }
  const box = boxOf(description);
  if (box !== null) {
    const twins = (context.boxNamedBy.get(box) ?? []).filter((vmid) => vmid !== look.vmid);
    if (twins.length) return { is: "refused", why: `${inWords(twins.map((vmid) => `CT ${vmid}`))} ${twins.length === 1 ? "names" : "name"} box ${box.split("/")[1]} as well, and the helper takes all but one for copies. Not marked until one guest names the box.`, card };
    const holding = [...context.ledger.values()].find((entry) => entry.vmid !== look.vmid && entry.box === box && (entry.answered > 0 || entry.claim !== null));
    if (holding) return { is: "refused", why: `The helper's ledger holds box ${box.split("/")[1]} for CT ${holding.vmid}, so it would refuse this guest as a copy.`, card };
  }
  const entry = context.ledger.get(look.vmid) ?? null;
  const next = Math.max(entry?.answered ?? 0, existing?.generation ?? 0) + 1;
  const asked: GpuMarker = { part, card: card.uuid, generation: next };
  if (!gpu.length) return { is: "mark", marker: asked, card, replaces: null, why: entry && entry.answered > 0 ? `The helper answered up to g${entry.answered} for it before, so it is asked with g${next}.` : null };
  if (existing?.part === "release") {
    if ((entry?.answered ?? 0) < existing.generation) return { is: "refused", why: `The helper has not answered ${gpu[0]}, which releases its claim, yet. Run bb box gpu mark again in a minute.`, card };
    return { is: "mark", marker: asked, card, replaces: gpu[0]!, why: `Its claim was released at g${existing.generation}, so it is asked again with g${next}.` };
  }
  if (!existing || existing.part !== part || existing.card !== card.uuid) {
    return { is: "refused", why: `It already has the tag ${gpu.join(" and ")}, not the marker its lines give, gpu.${part}.${card.uuid}; bb box gpu mark leaves a marker it did not write.`, card };
  }
  if (grantedAsAsked(entry?.claim ?? null, existing)) return { is: "marked", marker: existing, card };
  if ((entry?.answered ?? 0) < existing.generation) return { is: "waiting", marker: existing, card };
  const refused = refusalInForce(context.answers, look.vmid, existing);
  if (refused && !CHECKED_BEFORE_ASKING.has(refused.reason)) {
    return { is: "refused", why: `The helper refused ${gpu[0]} as ${refusalWords(refused.reason, refused.detail)}, which bb box gpu mark cannot check is put right.`, card };
  }
  const why = refused
    ? `The helper refused ${gpu[0]} as ${refusalWords(refused.reason, refused.detail)}; that is no longer so, so it is asked again.`
    : `The helper's ledger holds ${claimWords(entry?.claim ?? null)} for it, not ${gpu[0]}, so it is asked again.`;
  return { is: "mark", marker: asked, card, replaces: gpu[0]!, why };
}

export type UnmarkPlan =
  | { readonly is: "release"; readonly marker: GpuMarker; readonly replaces: string | null; readonly asked: boolean }
  | { readonly is: "unmark"; readonly marker: string }
  | { readonly is: "kept"; readonly why: string }
  | { readonly is: "refused"; readonly why: string; readonly card: null }
  | { readonly is: "unmarked" };

export function planUnmark(look: GuestLook, eligibility: Eligibility, ledger: ReadonlyMap<number, LedgerEntry>): UnmarkPlan {
  const tags = tagsOf(look);
  const gpu = gpuTagsOf(tags);
  const entry = ledger.get(look.vmid) ?? null;
  const claimed = entry?.claim != null;
  if (!gpu.length && !claimed) return { is: "unmarked" };
  const ineligible = ineligibility(look, eligibility);
  if (ineligible) return { is: "refused", why: ineligible, card: null };
  const existing = markerOf(tags);
  if (gpu.length && (!existing || existing.part === "none")) return { is: "kept", why: `Its tag ${gpu.join(" and ")} is not a marker bb box gpu mark writes, so it stays.` };
  if (existing?.part === "release") {
    if ((entry?.answered ?? 0) >= existing.generation && !claimed) return { is: "unmark", marker: gpu[0]! };
    if ((entry?.answered ?? 0) < existing.generation) return { is: "release", marker: existing, replaces: null, asked: true };
  }
  if (look.config.lock) return { is: "refused", why: `It is locked (${String(look.config.lock)}). Run bb box gpu mark --undo again once the lock is gone.`, card: null };
  const next = Math.max(entry?.answered ?? 0, existing?.generation ?? 0) + 1;
  return { is: "release", marker: { part: "release", card: null, generation: next }, replaces: gpu[0] ?? null, asked: false };
}

export function releasedAt(lines: HelperLines, vmid: number, generation: number): boolean {
  if (lines.answers.some((answer) => answer.vmid === vmid && answer.generation === generation && answer.is === "released")) return true;
  const entry = lines.ledger.get(vmid);
  return entry !== undefined && entry.answered >= generation && entry.claim === null;
}

export type MarkAnswer =
  | { readonly is: "granted" }
  | { readonly is: "refused"; readonly why: string }
  | { readonly is: "would"; readonly why: string }
  | { readonly is: "unanswered" };

export function answerTo(lines: HelperLines, vmid: number, marker: GpuMarker, fromLedger: boolean): MarkAnswer {
  const answer = lines.answers.find((each) => each.vmid === vmid && each.generation === marker.generation);
  if (answer?.is === "refused") return { is: "refused", why: refusalWords(answer.reason, answer.detail) };
  if (answer?.is === "granted" && answer.part === marker.part && answer.card === marker.card) return { is: "granted" };
  if (fromLedger && grantedAsAsked(lines.ledger.get(vmid)?.claim ?? null, marker)) return { is: "granted" };
  const would = lines.would.find((each) => each.vmid === vmid && each.words.endsWith(`for request g${marker.generation}`));
  if (would) return { is: "would", why: `the helper would write its device lines: ${would.words}` };
  return { is: "unanswered" };
}

export interface MigrationGuest {
  readonly name: string;
  readonly look: GuestLook;
}

function named(guests: readonly string[]): string {
  if (guests.length <= MOST_NAMED) return inWords(guests);
  return `${guests.slice(0, MOST_NAMED).join(", ")} and ${guests.length - MOST_NAMED} more`;
}

function nameOf(guest: MigrationGuest): string {
  return guest.name ? `CT ${guest.look.vmid} (${guest.name})` : `CT ${guest.look.vmid}`;
}

export function judgeGpuMigration(lines: HelperLines, guests: readonly MigrationGuest[], seen: Eligibility & { readonly node: string; readonly vmid: number }): GpuHelperVerdict {
  const journal = `journalctl -u bb-box-gpu on ${seen.node}`;
  if (!lines.ledgerReported) {
    return {
      status: "fail",
      detail: `VM ${seen.vmid}'s report has no ledger lines, which bb-box-gpu 0.2.0 and later write, so bb-box cannot show the helper granted each marker as it stands.`,
      fix: `Run host/setup-gpu.sh from this BB Box's setup guide, as root on ${seen.node}.`,
    };
  }
  if (lines.omitted.length) {
    return {
      status: "fail",
      detail: `VM ${seen.vmid}'s report leaves lines out (${lines.omitted.join("; ")}), so bb-box cannot show every guest is marked and the helper would write nothing.`,
      fix: `Read what the helper says with ${journal}.`,
    };
  }
  const eligible = guests.filter((guest) => ineligibility(guest.look, seen) === null);
  const cardLines = eligible.flatMap((guest) => {
    const devices = [...gpuDeviceLines(guest.look.config), ...pendingGpuLines(guest.look.pending)];
    const raw = rawGpuLines(guest.look.config);
    return devices.length || raw.length ? [{ guest, devices, raw }] : [];
  });
  const ours = new Set(guests.map((guest) => guest.look.vmid));
  const unknown = cardLines.filter(({ devices }) => nodesOfNoCard(devices, lines.cards).length).map(({ guest, devices }) => `${nameOf(guest)}, ${inWords(nodesOfNoCard(devices, lines.cards))}`);
  const unmarked = cardLines.filter(({ guest }) => !gpuTagsOf(tagsOf(guest.look)).length || markerOf(tagsOf(guest.look))?.part === "release").map(({ guest }) => nameOf(guest));
  const would = lines.would.filter((line) => ours.has(line.vmid));
  const othersWould = [...new Set(lines.would.filter((line) => !ours.has(line.vmid)).map((line) => line.vmid))];
  const refused: string[] = [];
  const unanswered: string[] = [];
  const mismatched: string[] = [];
  for (const guest of eligible) {
    const vmid = guest.look.vmid;
    const gpu = gpuTagsOf(tagsOf(guest.look));
    if (!gpu.length) continue;
    const marker = markerOf(tagsOf(guest.look));
    if (marker?.part === "release") continue;
    const answer = lines.answers.find((each) => each.vmid === vmid && each.is === "refused" && each.generation === (marker ? marker.generation : 0));
    if (answer?.is === "refused") {
      refused.push(`${nameOf(guest)}, as ${refusalWords(answer.reason, answer.detail)}`);
      continue;
    }
    if (!marker) {
      mismatched.push(`${nameOf(guest)}, whose tags ${gpu.join(" and ")} are not one marker`);
      continue;
    }
    if (would.some((line) => line.vmid === vmid)) continue;
    const entry = lines.ledger.get(vmid) ?? null;
    if (grantedAsAsked(entry?.claim ?? null, marker)) continue;
    if ((entry?.answered ?? 0) < marker.generation) unanswered.push(nameOf(guest));
    else mismatched.push(`${nameOf(guest)}, whose marker is ${gpu[0]} while the helper's ledger holds ${claimWords(entry?.claim ?? null)}`);
  }
  const problems: string[] = [];
  const fixes: string[] = [];
  if (unknown.length) {
    problems.push(`The device lines of ${named(unknown)} name nodes no card in the GPU helper's report has.`);
    fixes.push("Put those lines right by hand, as root on the host; the helper never writes them.");
  }
  if (unmarked.length) {
    problems.push(`${unmarked.length === 1 ? "This guest" : `These ${unmarked.length} guests`} of this install ${unmarked.length === 1 ? "has" : "have"} GPU device lines and no marker: ${named(unmarked)}.`);
    fixes.push("Run bb box gpu mark: it marks each with the card its lines name, or says why it cannot.");
  }
  if (would.length) {
    problems.push(`The GPU helper on ${seen.node} would write ${would.length === 1 ? "this guest" : "these guests"} once writes are on: ${named(would.map((line) => `${nameOf(guests.find((guest) => guest.look.vmid === line.vmid)!)}, ${line.words}`))}.`);
    fixes.push(`Find why with ${journal}: each write it would make must be explained before writes come on (071).`);
  }
  if (refused.length) {
    problems.push(`The GPU helper refused the marker of ${named(refused)}.`);
    fixes.push("Put right what it was refused for, then run bb box gpu mark, which asks again.");
  }
  if (mismatched.length) {
    problems.push(`The GPU helper does not hold the claim the marker asks for: ${named(mismatched)}.`);
    fixes.push("Run bb box gpu mark, which asks again with the next generation.");
  }
  if (problems.length) return { status: "fail", detail: problems.join(" "), fix: [...new Set(fixes)].join(" ") };
  const doubts: string[] = [];
  if (unanswered.length) doubts.push(`The GPU helper has not answered the marker of ${named(unanswered)} yet.`);
  if (othersWould.length) doubts.push(`It would write ${named(othersWould.map((vmid) => `CT ${vmid}`))}, which ${othersWould.length === 1 ? "is not a guest" : "are not guests"} of this install's pool.`);
  if (doubts.length) {
    return { status: "warn", detail: doubts.join(" "), fix: unanswered.length ? "Run bb box doctor again in a minute: the helper answers within seconds." : `Find why with ${journal}.` };
  }
  const detail = cardLines.length
    ? `Each of the ${cardLines.length === 1 ? "1 guest" : `${cardLines.length} guests`} of this install with GPU device lines is marked, the GPU helper on ${seen.node} granted each marker as it stands, and it would write no guest.`
    : `No guest of this install has GPU device lines, and the GPU helper on ${seen.node} would write no guest.`;
  return { status: "ok", detail, fix: null };
}
