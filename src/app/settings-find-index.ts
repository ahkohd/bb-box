import { snapshotConfig, type BackendConfig } from "../core/document.ts";
import { moneyWords } from "../core/snapshot-cost.ts";
import type { ConfigState, DriverView, FieldView } from "../plugin/configuration.ts";
import { effectiveKind, formValue, gib, groupFields, inheritedValues, inheritSource, isSecretField, isSecretState, PRESET_NAMES, sourceName } from "./config.ts";
import { COPY_BUTTON, EXPORT_BUTTON, OPEN_IMPORT } from "./settings-configuration.tsx";
import { ADD_FILE } from "./settings-files.tsx";
import { BAKE_WORDS, type StandardImage } from "./settings-images.tsx";
import { runsOn } from "./settings-kinds.tsx";
import { backendEnabledPath, backendFieldPath, backendLabelPath, ceilingPath, filePath, hostEnabledPath, hostFieldPath, hostNoun, hostPath, imageBakePath, kindPath, sizeName, sizePath, snapshotPath, standardImagePath, tailnetPath, TAILNET_SECRET_LABELS, warmPath, type Path, type SizeName, type SizePart } from "./settings-paths.ts";
import type { SettingsView } from "./settings-route.ts";
import { paidBackends } from "./settings-snapshots.tsx";
import { backendLabel, hostChip, isMachineDocker, kindName, plural } from "./settings-status.ts";

export const FIND_SHOWN = 40;

export type FindOpens = { readonly view: SettingsView; readonly path: Path | null } | { readonly machinesTab: true };

export interface FindPart {
  readonly label: string;
  readonly path: Path;
}

export interface FindEntry {
  readonly key: string;
  readonly label: string;
  readonly where: string;
  readonly value: string | null;
  readonly opens: FindOpens;
  readonly labels: readonly string[];
  readonly words: string;
  readonly turns: boolean;
  readonly parts: readonly FindPart[];
}

interface EntryInput {
  readonly key: string;
  readonly label: string;
  readonly where: string;
  readonly opens: FindOpens;
  readonly value?: string | null;
  readonly labels?: readonly string[];
  readonly words?: string;
  readonly turns?: boolean;
  readonly parts?: readonly FindPart[];
}

function entry(input: EntryInput): FindEntry {
  return { value: null, labels: [], words: "", turns: false, parts: [], ...input };
}

function onOff(on: boolean): string {
  return on ? "On" : "Off";
}

function keyWords(key: string): string {
  return `${key} ${key.replace(/[-_.]/g, " ")}`;
}

function firstLine(text: string): string {
  const [first = "", ...rest] = text.split("\n").map((line) => line.trim()).filter(Boolean);
  return rest.length ? `${first} and ${plural(rest.length, "more")}` : first;
}

function withUnit(value: string | number, field: FieldView): string {
  const unit = /\((GiB|MiB)\)/.exec(field.label)?.[1];
  if (unit) return `${value} ${unit}`;
  if (/^cores\b/i.test(field.label)) return `${value} ${Number(value) === 1 ? "core" : "cores"}`;
  return String(value);
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function fieldValue(state: ConfigState, config: BackendConfig, driver: DriverView, field: FieldView): string | null {
  const stored = config.fields[field.key];
  if (isSecretField(field)) {
    if (isSecretState(stored) && stored.set) return "Set";
    const inherited = inheritedFrom(state, config, driver, field);
    return inherited ? `Not set: ${inherited.from}` : "Not set";
  }
  if (field.type === "boolean") return onOff(stored === undefined ? field.default === true : stored === true);
  if (field.offWhenEmpty && stored === "") return "Off";
  if (!isBlank(stored)) return withUnit(firstLine(String(stored)), field);
  const inherited = inheritedFrom(state, config, driver, field);
  if (inherited) return `Empty: ${inherited.value}, ${inherited.from}`;
  if (!isBlank(field.default)) return `Empty: ${withUnit(String(field.default), field)}, the default`;
  return null;
}

function inheritedFrom(state: ConfigState, config: BackendConfig, driver: DriverView, field: FieldView): { readonly value: string; readonly from: string } | null {
  if (!field.inherits) return null;
  const source = inheritSource(state.document, driver.fields, config.id);
  if (!source) return null;
  const values = Object.fromEntries(driver.fields.map((each) => [each.key, formValue(config.fields, each)]));
  const inherited = inheritedValues(driver.fields, values, source)[field.key];
  if (inherited === undefined) return null;
  return { value: isSecretState(inherited) ? "set" : withUnit(firstLine(String(inherited)), field), from: `from ${sourceName(state.document, source, field.inherits.label)}` };
}

function hostFieldValue(state: ConfigState, config: BackendConfig, driver: DriverView, host: string, field: FieldView): string | null {
  const stored = config.hosts?.find((each) => each.name === host)?.fields[field.key];
  if (!isBlank(stored)) return withUnit(firstLine(String(stored)), field);
  const own = driver.fields.some((each) => each.key === field.key) ? config.fields[field.key] : undefined;
  if (!isBlank(own)) return `Empty: ${withUnit(String(own), field)}, ${driver.label}'s setting`;
  const estimate = state.backends.find((each) => each.id === config.id)?.hostEstimates?.[host]?.[field.key];
  if (estimate !== undefined) return `Empty: ${withUnit(estimate, field)}, bb-box's estimate`;
  return null;
}

function backendTitle(state: ConfigState, config: BackendConfig): string {
  const label = backendLabel(state, config);
  const chip = hostChip(config, label, state.backends.find((each) => each.id === config.id)?.hosts);
  return chip ? `${label} on ${chip}` : label;
}

function backendEntries(state: ConfigState, config: BackendConfig): FindEntry[] {
  const driver = state.drivers.find((each) => each.type === config.type);
  const label = backendTitle(state, config);
  const view: SettingsView = { page: "backend", id: config.id };
  const page = entry({ key: `backend ${config.id}`, label, where: "Backends", value: onOff(config.enabled), opens: { view, path: null }, words: `backend ${driver ? `${driver.label} ${driver.description}` : config.type}` });
  if (!driver) return [page];
  const entries: FindEntry[] = [
    page,
    entry({ key: `backend ${config.id} enabled`, label: "Takes new boxes", where: label, value: onOff(config.enabled), opens: { view, path: backendEnabledPath(config.id) }, words: `${driver.label} backend`, turns: true }),
    entry({ key: `backend ${config.id} label`, label: "Name", where: label, value: config.label ?? label, opens: { view, path: backendLabelPath(config.id) }, labels: ["rename"], words: `${driver.label} backend` }),
  ];
  const fields = driver.fields.filter((field) => !(isMachineDocker(config) && field.key === "host"));
  for (const group of groupFields(fields)) {
    for (const field of group.fields) {
      const path = backendFieldPath(config.id, field.key);
      entries.push(entry({ key: path, label: field.label, where: `${label} › ${group.title}`, value: fieldValue(state, config, driver, field), opens: { view, path }, words: `${field.description ?? ""} ${keyWords(field.key)} ${driver.label}`, turns: field.type === "boolean" }));
    }
  }
  const noun = hostNoun(config.type);
  const nouns = noun === "Mac" ? "Macs" : "Hosts";
  for (const host of driver.hostFields.length ? (config.hosts ?? []) : []) {
    const at = hostPath(config.id, host.name);
    entries.push(entry({ key: at, label: host.name, where: `${label} › ${nouns}`, value: onOff(host.enabled), opens: { view, path: hostEnabledPath(at) }, labels: [noun], words: `${driver.label} takes new boxes`, turns: true }));
    for (const field of driver.hostFields) {
      const path = hostFieldPath(at, field.key);
      entries.push(entry({ key: path, label: `${field.label} on ${host.name}`, where: `${label} › ${nouns} › ${host.name}`, value: hostFieldValue(state, config, driver, host.name, field), opens: { view, path }, labels: [noun], words: `${field.description ?? ""} ${keyWords(field.key)} ${driver.label} its own` }));
    }
  }
  return entries;
}

function standardImageValue(image: StandardImage): string {
  if (image.outcome?.state === "failed") return "Its last rebuild failed";
  if (image.outcome?.state === "waiting") return "Its last rebuild waited";
  return image.due ? "Due" : "Up to date";
}

function standardImageEntries(state: ConfigState, images: readonly StandardImage[]): FindEntry[] {
  return images.flatMap((image) => {
    const config = state.document.backends.find((each) => each.id === image.backend);
    if (!config) return [];
    const info = state.kinds.find((each) => each.id === image.kind);
    const kind = info ? kindName(state.kinds, info) : image.kind;
    return [entry({ key: standardImagePath(image.name), label: `Standard ${kind} image`, where: `${backendTitle(state, config)} › Images`, value: standardImageValue(image), opens: { view: { page: "backend", id: config.id }, path: standardImagePath(image.name) }, words: `standard image template rebuild ${keyWords(image.kind)} ${image.name}` })];
  });
}

const SIZE_PART_LABELS: Readonly<Record<SizePart, string>> = { cores: "Cores", memoryGiB: "Memory", diskGiB: "Disk" };

function sizeWords(size: { readonly cores: number; readonly memoryMiB: number; readonly diskGiB: number | null }, largest: boolean): string {
  return [`${size.cores} ${size.cores === 1 ? "core" : "cores"}`, `${gib(size.memoryMiB)} GiB`, size.diskGiB === null ? (largest ? "any disk" : "the image's disk") : `${size.diskGiB} GiB disk`].join(" · ");
}

function kindEntries(state: ConfigState): FindEntry[] {
  const entries: FindEntry[] = [];
  const defaultKind = state.document.general.defaultKind ?? state.defaults.general.defaultKind;
  for (const info of state.kinds) {
    const name = kindName(state.kinds, info);
    const sizes = effectiveKind(state, info.id);
    const view: SettingsView = { page: "kind", id: info.id };
    const words = `${info.description} ${keyWords(info.id)} kind`;
    entries.push(entry({ key: `kind ${info.id}`, label: name, where: "Kinds", value: onOff(sizes.enabled), opens: { view, path: null }, words }));
    entries.push(entry({ key: kindPath(info.id, "enabled"), label: "Offered to threads", where: `Kinds › ${name}`, value: onOff(sizes.enabled), opens: { view, path: kindPath(info.id, "enabled") }, words: `${words}${info.id === defaultKind ? " default kind stays on" : ""}`, turns: true }));
    const shown: readonly SizeName[] = [...PRESET_NAMES, "largest"];
    for (const size of shown) {
      const value = size === "largest" ? sizes.largest : sizes.presets[size];
      const parts = (Object.keys(SIZE_PART_LABELS) as SizePart[]).map((part) => ({ label: SIZE_PART_LABELS[part], path: sizePath(info.id, size, part) }));
      entries.push(
        entry({
          key: sizePath(info.id, size, "cores").replace(/\/cores$/, ""),
          label: size === "largest" ? "Largest size" : `${sizeName(size)} size`,
          where: `Kinds › ${name} › Sizes`,
          value: `${sizeWords(value, size === "largest")}${size === sizes.default ? " · the default" : ""}`,
          opens: { view, path: parts[0]!.path },
          labels: parts.map((part) => part.label),
          words: `${words} ${size === "largest" ? "custom most" : size} preset`,
          parts,
        }),
      );
    }
    entries.push(entry({ key: kindPath(info.id, "default"), label: "Default size", where: `Kinds › ${name} › Sizes`, value: sizeName(sizes.default), opens: { view, path: kindPath(info.id, "default") }, words: `${words} preset` }));
    for (const row of runsOn(state, info)) {
      const path = warmPath(row.config.id, info.id);
      const count = row.config.warm?.[info.id] ?? 0;
      if (!row.keepsWarm && count <= 0) continue;
      entries.push(entry({ key: path, label: `Warm boxes on ${backendTitle(state, row.config)}`, where: `Kinds › ${name} › Where it runs`, value: String(count), opens: { view, path }, words: `${words} ready waiting pool` }));
    }
    entries.push(entry({ key: kindPath(info.id, "spares"), label: "Spares to keep", where: `Kinds › ${name} › Spare boxes`, value: String(sizes.spares), opens: { view, path: kindPath(info.id, "spares") }, labels: ["Spare boxes"], words: `${words} made ahead` }));
  }
  return entries;
}

function option(page: string, title: string, key: string, label: string, path: Path | null, value: string | null, words = "", turns = false): FindEntry {
  return entry({ key: `option ${page} ${key}`, label, where: `Options › ${title}`, value, opens: { view: { page: "option", id: page }, path }, words, turns });
}

const ENCODER_WORDS: Readonly<Record<string, string>> = { auto: "Automatic", hardware: "Hardware only", software: "Software only" };

function optionEntries(state: ConfigState): FindEntry[] {
  const general = { ...state.defaults.general, ...state.document.general };
  const monitor = { ...state.defaults.monitor, ...state.document.monitor };
  const defaultInfo = state.kinds.find((kind) => kind.id === general.defaultKind);
  const files = state.document.general.files ?? [];
  const images = state.document.images ?? {};
  const tailnet = state.document.general.tailnet;
  const oauth = tailnet?.mode === "oauth";
  const secretSet = (key: "clientId" | "clientSecret") => {
    const value = tailnet?.[key];
    return isSecretState(value) && value.set ? "Set" : "Not set";
  };
  const entries: FindEntry[] = [
    option("boxes", "Boxes", "page", "Boxes", null, null, "options page"),
    option("boxes", "Boxes", "default", "Default kind", "general/defaultKind", defaultInfo ? kindName(state.kinds, defaultInfo) : general.defaultKind, "what a thread gets when it does not say"),
    option("boxes", "Boxes", "per-thread", "Boxes per thread", "general/boxesPerThread", general.boxesPerThread ? String(general.boxesPerThread) : "0, no limit", "the most boxes one thread may hold limit"),
    option("boxes", "Boxes", "enrol", "Boxes join BB as machines", "general/enrol", onOff(general.enrol), "enrol enroll terminals threads credentials", true),
    option("boxes", "Boxes", "video", "Linux desktops as video", "general/video", onOff(general.video), "x11 vnc stream selkies", true),
    option("boxes", "Boxes", "files", "Files for every box", ADD_FILE, plural(files.length, "file"), "home dotfiles copied secret add file"),
    ...files.map((file) => option("boxes", "Boxes", `file ${file.path}`, `~/${file.path}`, filePath(file.path), isSecretState(file.content) && file.content.set ? "Set" : "Not set", "file for every box content home replace")),
    option("images", "Images", "page", "Images", null, null, "options page standard projects"),
    option("images", "Images", "nightly", "Rebuild each night", "general/nightlyImages", onOff(general.nightlyImages), "nightly 03:00 schedule refresh images", true),
    option("images", "Images", "standard", "Standard images", null, null, "rebuild what is due templates age"),
    ...Object.keys(images)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => option("images", "Images", `image ${name}`, `When ${name} is built ahead`, imageBakePath(name), BAKE_WORDS[images[name]!.bake ?? "auto"], `projects' images project image ${name} bake script`)),
    ...snapshotEntries(state),
    option("devices", "Devices", "page", "Devices", null, null, "options page ios android"),
    option("devices", "Devices", "encoder", "iOS video encoding", "general/iosEncoder", ENCODER_WORDS[general.iosEncoder] ?? general.iosEncoder, "encoder hardware software h264 iphone stream"),
    option("devices", "Devices", "ledger", "Share each Mac's encoder fairly", "general/encoderLedger", onOff(general.encoderLedger), "encoder ledger stream ios", true),
    option("devices", "Devices", "test", "Test device", "general/testDevice", onOff(general.testDevice), "test card device path", true),
    option("network", "Network", "page", "Network", null, null, "options page tailnet"),
    option("network", "Network", "mode", "Join machines to the tailnet", tailnetPath("mode"), oauth ? "Yes, with an OAuth client" : "No", "tailscale tailnet oauth cloud machines"),
    option("network", "Network", "tags", "Tags", oauth ? tailnetPath("tags") : tailnetPath("mode"), oauth ? (tailnet?.tags?.join(", ") ?? "Empty: tag:bb-box, the default") : "Used with Yes", "tailscale tailnet tags"),
    ...(["clientId", "clientSecret"] as const).map((key) => option("network", "Network", key, TAILNET_SECRET_LABELS[key], oauth ? tailnetPath(key) : tailnetPath("mode"), oauth ? secretSet(key) : "Used with Yes", "tailscale tailnet oauth credentials")),
    option("monitor", "Monitor", "page", "Monitor", null, null, "options page"),
    { ...option("monitor", "Monitor", "enabled", "Machine status", "monitor/enabled", onOff(monitor.enabled), "sidebar footer sampling", true), labels: ["Monitor"] },
    option("monitor", "Monitor", "refresh", "Refresh every", "monitor/refreshIntervalSeconds", `${monitor.refreshIntervalSeconds} s`, "refresh interval seconds readings monitor"),
    option("monitor", "Monitor", "background", "Background monitoring", "monitor/backgroundMonitoring", onOff(monitor.backgroundMonitoring), "monitor logs cpu memory while nobody looks", true),
    option("monitor", "Monitor", "pressure", "Pressure notifications", "monitor/pressureNotifications", onOff(monitor.pressureNotifications), "monitor toast cpu memory high", true),
    option("monitor", "Monitor", "history", "Keep each box's history", "monitor/boxHistory", onOff(monitor.boxHistory), "box history minute hour day week busy chart", true),
    ...configurationEntries(state),
    entry({ key: "machines", label: "Your machines", where: "Options", value: "On the Boxes page", opens: { machinesTab: true }, words: "machines boxes page add machine" }),
  ];
  return entries;
}

function snapshotEntries(state: ConfigState): FindEntry[] {
  const snapshots = snapshotConfig(state.document);
  const paid = paidBackends(state);
  return [
    option("snapshots", "Snapshots", "page", "Snapshots", null, null, "options page snapshot checkpoint backup restore"),
    option("snapshots", "Snapshots", "per-box", "Snapshots per box", snapshotPath("perBox"), String(snapshots.perBox), "snapshot limit most each box undos kept count"),
    option("snapshots", "Snapshots", "room", "Refuse new snapshots when a host's storage is past", snapshotPath("roomPercent"), `${snapshots.roomPercent}% full`, "snapshot room storage disk full percent thin pool metadata sweep"),
    option("snapshots", "Snapshots", "agents-restore", "Agents may restore their own boxes", snapshotPath("agentsRestore"), snapshots.agentsRestore ? "On" : "Off", "snapshot restore agent ask form yes undo rollback revert"),
    option("snapshots", "Snapshots", "agents-memory", "Agents may restore memory snapshots", snapshotPath("agentsMemory"), snapshots.agentsMemory ? "On" : "Off", "snapshot restore agent memory running apps ram"),
    ...(paid.length
      ? paid.map(({ config, live }) =>
          option("snapshots", "Snapshots", `ceiling ${config.id}`, `Paid snapshots on ${backendLabel(state, config)}`, ceilingPath(config.id), `${moneyWords(live.snapshots!.paid!.ceiling, live.snapshots!.paid!.currency)} a month`, "snapshot ceiling paid cost price money spend month budget"),
        )
      : [option("snapshots", "Snapshots", "ceiling", "Paid snapshots", null, "None of your backends charges", "snapshot ceiling paid cost price money spend month budget")]),
    option("snapshots", "Snapshots", "pictures", "Keep a picture of the screen with each snapshot", snapshotPath("pictures"), onOff(snapshots.pictures), "snapshot picture screen screenshot thumbnail image", true),
    option("snapshots", "Snapshots", "offers", "What each backend offers", null, null, "snapshot backend storage memory disk holds"),
  ];
}

function configurationEntries(state: ConfigState): FindEntry[] {
  return [
    option("configuration", "Configuration", "page", "Configuration", null, `Revision ${state.revision}`, "options page revision json file save"),
    option("configuration", "Configuration", "export", "Export", EXPORT_BUTTON, null, "copy as json download backup file bb box config show secrets"),
    option("configuration", "Configuration", "import", "Import", OPEN_IMPORT, null, "apply json file restore paste check changes"),
    ...(state.migrated ? [option("configuration", "Configuration", "copy", "Settings moved from BB", COPY_BUTTON, "Kept", "copy of bb's earlier settings migrated remove")] : []),
    option("configuration", "Configuration", "commands", "From a terminal", null, null, "bb box config show check apply migrated json commands agents scripts"),
  ];
}

export function settingsIndex(state: ConfigState, standardImages: readonly StandardImage[] = []): FindEntry[] {
  return [
    ...state.document.backends.flatMap((config) => backendEntries(state, config)),
    ...standardImageEntries(state, standardImages),
    entry({ key: "add backend", label: "Add backend", where: "Backends", opens: { view: { page: "add" }, path: null }, words: "new backend set up another" }),
    ...kindEntries(state),
    ...optionEntries(state),
  ];
}

const STOP_WORDS: ReadonlySet<string> = new Set(["the", "a", "an", "of", "to", "for", "in", "at", "by", "my", "is", "and", "with", "how", "what", "where", "do", "i"]);

const TURN_WORDS: ReadonlySet<string> = new Set(["turn", "switch", "toggle", "enable", "disable", "on", "off"]);

export const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  ram: ["memory"],
  mem: ["memory"],
  cpu: ["cores"],
  cpus: ["cores"],
  vcpu: ["cores"],
  vcpus: ["cores"],
  processor: ["cores"],
  processors: ["cores"],
  storage: ["disk"],
  hdd: ["disk"],
  ssd: ["disk"],
  vnc: ["video"],
  stream: ["video"],
  tailscale: ["tailnet"],
  password: ["secret", "token", "key"],
  credential: ["secret", "token", "key"],
  credentials: ["secret", "token", "key"],
  api: ["token", "url"],
  rename: ["name"],
  limit: ["most", "per thread"],
  max: ["most", "largest"],
  maximum: ["most", "largest"],
  reserve: ["kept free"],
  reserved: ["kept free"],
  free: ["kept free"],
  iphone: ["ios"],
  ipad: ["ios"],
  simulator: ["ios"],
  emulator: ["android"],
  pool: ["warm"],
  prewarm: ["warm"],
  spare: ["spares"],
  nightly: ["each night"],
  schedule: ["each night"],
  dotfiles: ["files"],
  address: ["url", "address", "host"],
  ip: ["url", "address", "host"],
  vm: ["template", "image"],
  template: ["image", "templates"],
  image: ["template", "templates"],
};

export interface Query {
  readonly words: readonly string[];
  readonly turning: boolean;
}

export function parseQuery(text: string): Query {
  const all = text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}~]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word));
  const rest = all.filter((word) => !TURN_WORDS.has(word));
  return rest.length ? { words: rest, turning: rest.length < all.length } : { words: all, turning: false };
}

function forms(word: string): string[] {
  const singular = word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : null;
  return singular ? [word, singular] : [word];
}

type Fit = "leads" | "whole" | "starts" | "inside";

const ALNUM = /[\p{L}\p{N}]/u;

function fitOf(text: string, word: string): Fit | null {
  let best: Fit | null = null;
  for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
    const starts = at === 0 || !ALNUM.test(text[at - 1]!);
    const ends = at + word.length >= text.length || !ALNUM.test(text[at + word.length]!);
    const fit: Fit = starts && ends ? (at === 0 ? "leads" : "whole") : starts ? "starts" : "inside";
    if (best === null || FIT_ORDER.indexOf(fit) < FIT_ORDER.indexOf(best)) best = fit;
  }
  return best;
}

const FIT_ORDER: readonly Fit[] = ["leads", "whole", "starts", "inside"];

const LABEL_POINTS: Readonly<Record<Fit, number>> = { leads: 7, whole: 5, starts: 3, inside: 2 };

const OTHER_LABEL_POINTS: Readonly<Record<Fit, number>> = { leads: 4, whole: 4, starts: 2, inside: 1 };

function bestOf(text: string, words: readonly string[], points: Readonly<Record<Fit, number>>): number | null {
  let best: number | null = null;
  for (const word of words) {
    const fit = fitOf(text, word);
    if (fit !== null) best = Math.max(best ?? 0, points[fit]);
  }
  return best;
}

function scoreWord(item: { readonly label: string; readonly labels: string; readonly where: string; readonly rest: string }, word: string): number | null {
  const each = forms(word);
  const synonyms = SYNONYMS[word] ?? [];
  const points = [bestOf(item.label, each, LABEL_POINTS), bestOf(item.labels, each, OTHER_LABEL_POINTS), synonyms.some((synonym) => item.label.includes(synonym) || item.labels.includes(synonym)) ? 2 : null, each.some((form) => item.where.includes(form)) ? 1 : null, each.some((form) => item.rest.includes(form)) ? 0 : null].filter((point): point is number => point !== null);
  return points.length ? Math.max(...points) : null;
}

export function searchSettings(entries: readonly FindEntry[], text: string): FindEntry[] {
  const query = parseQuery(text);
  if (!query.words.length) return [];
  const scored: { readonly found: FindEntry; readonly score: number; readonly at: number }[] = [];
  entries.forEach((found, at) => {
    const item = { label: found.label.toLowerCase(), labels: found.labels.join(" ").toLowerCase(), where: found.where.toLowerCase(), rest: `${found.words} ${found.value ?? ""}`.toLowerCase() };
    let score = 0;
    for (const word of query.words) {
      const points = scoreWord(item, word);
      if (points === null) return;
      score += points;
    }
    if (query.turning && found.turns) score += 3;
    if ("view" in found.opens && found.opens.path === null) score -= 0.5;
    scored.push({ found, score: score - found.where.split("›").length * 0.1, at });
  });
  return scored.sort((a, b) => b.score - a.score || a.at - b.at).map((each) => each.found);
}

export function pathFor(found: FindEntry, text: string): Path | null {
  if (!("view" in found.opens)) return null;
  const words = parseQuery(text).words;
  const part = found.parts.find((each) => {
    const label = each.label.toLowerCase();
    return words.some((word) => forms(word).some((form) => label.startsWith(form)) || (SYNONYMS[word] ?? []).some((synonym) => label.includes(synonym)));
  });
  return part?.path ?? found.opens.path;
}
