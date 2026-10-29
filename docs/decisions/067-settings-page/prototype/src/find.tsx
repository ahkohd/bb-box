import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { driverOf, KINDS, PRESET_LABELS, PRESETS, type BackendLive, type Document } from "./data";
import { GROUPS, groupOf } from "./backend-page";
import { backendTitle, gib, kindName } from "./model";
import { useNav, type View } from "./nav";
import { readPath } from "./paths";
import { useStore } from "./store";
import { Icon } from "./ui";

interface Entry {
  readonly key: string;
  readonly label: string;
  readonly where: string;
  readonly words: string;
  readonly view: View;
  readonly found?: string;
  readonly value?: string;
}

const SYNONYMS: Record<string, readonly string[]> = {
  ram: ["memory"],
  cpu: ["cores", "cpu"],
  cores: ["cpu"],
  vnc: ["video"],
  tailscale: ["tailnet"],
  key: ["secret", "token"],
  password: ["secret", "token"],
  limit: ["most"],
  reserve: ["kept free"],
  turn: [],
  off: ["on"],
  disable: ["on"],
  mac: ["macs", "macos", "tart"],
  iphone: ["ios"],
  ipad: ["ios"],
  docker: ["docker"],
  template: ["templates"],
};

function valueWords(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "object" && "set" in (value as object)) return (value as { set: boolean }).set ? "set" : "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function option(key: string, label: string, where: string, page: "boxes" | "images" | "devices" | "network" | "monitor" | "configuration", found: string, extra: string, value?: unknown): Entry {
  return { key, label, where: `Options › ${where}`, words: `${label} ${where} ${extra}`, view: { page: "option", id: page }, found, value: valueWords(value) };
}

export function settingsIndex(doc: Document, live: Readonly<Record<string, BackendLive>>): Entry[] {
  const entries: Entry[] = [];
  for (const backend of doc.backends) {
    const driver = driverOf(backend.type);
    const title = backendTitle(backend, live[backend.id]);
    entries.push({ key: `b-${backend.id}`, label: title, where: "Backends", words: `${title} ${driver.label} ${driver.description} backend`, view: { page: "backend", id: backend.id }, value: backend.enabled ? "on" : "off" });
    for (const field of driver.fields) {
      const group = GROUPS.find((each) => each.id === groupOf(field))?.title ?? field.group;
      const path = `backends/${backend.id}/fields/${field.key}`;
      const stored = readPath(doc, path);
      entries.push({ key: path, label: field.label, where: `${title} › ${group}`, words: `${field.label} ${field.key.replace(/-/g, " ")} ${field.description ?? ""} ${title} ${driver.label} ${group}`, view: { page: "backend", id: backend.id }, found: path, value: valueWords(stored) ?? (field.default !== undefined && field.default !== "" ? `default ${String(field.default)}` : undefined) });
    }
    for (const host of backend.hosts ?? []) {
      for (const field of driver.hostFields) {
        const path = `backends/${backend.id}/hosts/${host.name}/fields/${field.key}`;
        entries.push({ key: path, label: `${field.label}, on ${host.name}`, where: `${title} › Macs › ${host.name}`, words: `${field.label} ${field.key.replace(/-/g, " ")} ${host.name} mac ${title} own override ${field.description ?? ""}`, view: { page: "backend", id: backend.id }, found: path, value: valueWords(host.fields[field.key]) ?? "Tart's setting or estimate" });
      }
    }
  }
  for (const kind of KINDS) {
    const name = kindName(kind.id);
    const config = doc.kinds[kind.id];
    if (!config) continue;
    entries.push({ key: `k-${kind.id}`, label: name, where: "Kinds", words: `${name} ${kind.description} kind ${kind.id.replace(/-/g, " ")}`, view: { page: "kind", id: kind.id }, value: config.enabled ? "on" : "off" });
    for (const preset of PRESETS) {
      const size = config.presets[preset];
      entries.push({ key: `k-${kind.id}-${preset}`, label: `${name}: ${PRESET_LABELS[preset]} size`, where: `Kinds › ${name} › Sizes`, words: `${name} ${PRESET_LABELS[preset]} size cores memory disk preset ${kind.id.replace(/-/g, " ")}`, view: { page: "kind", id: kind.id }, found: `kinds/${kind.id}/presets/${preset}/cores`, value: `${size.cores} cores · ${gib(size.memoryMiB)} GiB${preset === config.default ? " · default" : ""}` });
    }
    entries.push({ key: `k-${kind.id}-largest`, label: `${name}: largest custom size`, where: `Kinds › ${name} › Sizes`, words: `${name} largest custom size cores memory disk`, view: { page: "kind", id: kind.id }, found: `kinds/${kind.id}/largest/cores`, value: `${config.largest.cores} cores · ${gib(config.largest.memoryMiB)} GiB · ${config.largest.diskGiB} GiB disk` });
    entries.push({ key: `k-${kind.id}-spares`, label: `${name}: spare boxes`, where: `Kinds › ${name}`, words: `${name} spares spare ahead`, view: { page: "kind", id: kind.id }, found: `kinds/${kind.id}/spares`, value: String(config.spares) });
    for (const backend of doc.backends.filter((each) => driverOf(each.type).kinds.includes(kind.id))) {
      entries.push({ key: `k-${kind.id}-warm-${backend.id}`, label: `${name}: warm boxes on ${backendTitle(backend, live[backend.id])}`, where: `Kinds › ${name} › Where it runs`, words: `${name} warm ready waiting ${backendTitle(backend, live[backend.id])}`, view: { page: "kind", id: kind.id }, found: `backends/${backend.id}/warm/${kind.id}`, value: String(backend.warm?.[kind.id] ?? 0) });
    }
  }
  const { general, monitor } = doc;
  entries.push(
    option("o-default", "Default kind", "Boxes", "boxes", "general/defaultKind", "thread gets", kindName(general.defaultKind)),
    option("o-per-thread", "Boxes per thread", "Boxes", "boxes", "general/boxesPerThread", "limit most", general.boxesPerThread || "no limit"),
    option("o-enrol", "Boxes join BB as machines", "Boxes", "boxes", "general/enrol", "enrol enroll credentials", general.enrol),
    option("o-video", "Linux desktops as video", "Boxes", "boxes", "general/video", "vnc stream selkies", general.video),
    option("o-files", "Files for every box", "Boxes", "boxes", "general/files", "home dotfiles secret", `${general.files.length} files`),
    option("o-nightly", "Rebuild each night", "Images", "images", "general/nightlyImages", "nightly refresh 03:00 rebuild", general.nightlyImages),
    option("o-standard", "Standard images", "Images", "images", "general/nightlyImages", "templates rebuild now due"),
    option("o-project", "Project images", "Images", "images", "general/nightlyImages", "box-setup script bake check", `${doc.images.length}`),
    option("o-encoder", "iOS video encoding", "Devices", "devices", "general/iosEncoder", "encoder hardware software h264 iphone", general.iosEncoder),
    option("o-ledger", "Share each Mac's encoder fairly", "Devices", "devices", "general/encoderLedger", "encoder ledger stream", general.encoderLedger),
    option("o-test", "Test device", "Devices", "devices", "general/testDevice", "test card", general.testDevice),
    option("o-tailnet", "Join machines to the tailnet", "Network", "network", "general/tailnet/mode", "tailscale oauth", general.tailnet.mode === "oauth" ? "yes" : "no"),
    option("o-tags", "Tailnet tags", "Network", "network", "general/tailnet/tags", "tailscale oauth tags", general.tailnet.tags),
    option("o-client", "OAuth client ID and secret", "Network", "network", "general/tailnet/clientId", "tailscale oauth secret", general.tailnet.clientId.set ? "set" : "not set"),
    option("o-status", "Machine status", "Monitor", "monitor", "monitor/enabled", "monitor sidebar turn off", monitor.enabled),
    option("o-refresh", "Refresh every", "Monitor", "monitor", "monitor/refreshIntervalSeconds", "interval seconds", `${monitor.refreshIntervalSeconds} s`),
    option("o-background", "Background monitoring", "Monitor", "monitor", "monitor/backgroundMonitoring", "logs", monitor.backgroundMonitoring),
    option("o-pressure", "Pressure notifications", "Monitor", "monitor", "monitor/pressureNotifications", "toast cpu memory", monitor.pressureNotifications),
    option("o-export", "Export", "Configuration", "configuration", "configuration/export", "json copy backup"),
    option("o-import", "Import", "Configuration", "configuration", "configuration/import", "json apply restore"),
  );
  return entries;
}

export function search(entries: readonly Entry[], query: string): Entry[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0 && !["the", "a", "an", "of", "to", "for"].includes(word));
  if (!words.length) return [];
  const scored = entries
    .map((entry) => {
      const label = entry.label.toLowerCase();
      const text = `${entry.label} ${entry.words} ${entry.where}`.toLowerCase();
      const matches = words.map((word) => text.includes(word) || (SYNONYMS[word] ?? []).some((candidate) => label.includes(candidate)));
      if (!matches.every(Boolean)) return null;
      const score = words.reduce((sum, word) => sum + (label.startsWith(word) ? 4 : label.includes(word) ? 2 : 0), 0) - entry.where.split("›").length * 0.1;
      return { entry, score };
    })
    .filter((item): item is { entry: Entry; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);
  return scored.map((item) => item.entry);
}

let keptQuery = "";
const SHOWN = 40;

export function FindBox({ wide }: { wide?: boolean }) {
  const store = useStore();
  const nav = useNav();
  const [query, setQuery] = useState(keptQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const index = useMemo(() => settingsIndex(store.doc, store.live), [store.doc, store.live]);
  const results = useMemo(() => search(index, query), [index, query]);
  useEffect(() => {
    keptQuery = query;
    setActive(0);
  }, [query]);
  const choose = (entry: Entry) => {
    setOpen(false);
    nav.go(entry.view, { found: entry.found });
  };
  return (
    <div className={cn("relative", wide ? "w-full" : "w-full sm:w-72")}>
      <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
      <Input
        ref={input}
        role="combobox"
        aria-expanded={open && !!query.trim()}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? `${listId}-${active}` : undefined}
        aria-label="Find a setting"
        className="h-8 pl-8 text-xs"
        placeholder="Find a setting: memory, template, tailnet…"
        value={query}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setActive((current) => Math.min(current + 1, Math.max(0, Math.min(results.length, SHOWN) - 1)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((current) => Math.max(0, current - 1));
          } else if (event.key === "Enter" && active < SHOWN && results[active]) {
            event.preventDefault();
            choose(results[active]!);
          } else if (event.key === "Escape") {
            if (query) setQuery("");
            else setOpen(false);
          }
        }}
      />
      <span className="sr-only" aria-live="polite">
        {query.trim() ? (results.length ? `${results.length} ${results.length === 1 ? "setting matches" : "settings match"}${results.length > SHOWN ? `; the first ${SHOWN} are listed` : ""}` : "No setting matches") : ""}
      </span>
      {open && query.trim() ? (
        <div className="absolute right-0 top-9 z-30 w-full min-w-[min(100vw-2rem,26rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-[0_6px_24px_rgb(0_0_0/0.3)]">
          <p className="border-b border-border px-3 py-1.5 text-2xs text-subtle-foreground">{results.length ? `${results.length} ${results.length === 1 ? "match" : "matches"}${results.length > SHOWN ? `, the first ${SHOWN} listed; add a word to narrow them` : ""} · ↑↓ to move, Enter to open, Esc to clear` : `No setting matches “${query}”. Try a word from its label, such as memory, template or spares.`}</p>
          <ul id={listId} role="listbox" aria-label="Settings that match" className="max-h-80 overflow-y-auto py-1">
            {results.slice(0, SHOWN).map((entry, at) => (
              <li
                key={entry.key}
                id={`${listId}-${at}`}
                role="option"
                aria-selected={at === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(entry);
                }}
                onMouseMove={() => setActive(at)}
                className={cn("flex cursor-pointer items-start gap-3 px-3 py-1.5", at === active && "bg-state-hover")}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-foreground">{entry.label}</span>
                  <span className="block truncate text-2xs text-subtle-foreground">{entry.where}</span>
                </span>
                {entry.value ? <span className="max-w-[40%] shrink-0 truncate pt-px text-2xs text-muted-foreground">{entry.value}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
