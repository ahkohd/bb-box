import { useEffect, useRef } from "react";
import { Input } from "@/components/ui/input";
import { driverOf, KINDS, type Document } from "./data";
import { GROUPS, groupOf } from "./backend-page";
import { backendTitle, kindTitle } from "./model";
import { useNav, type View } from "./nav";
import { useStore } from "./store";
import { Card, Chevron, Icon, Rows } from "./ui";
import type { BackendLive } from "./data";

interface Entry {
  readonly label: string;
  readonly where: string;
  readonly words: string;
  readonly view: View;
  readonly id?: string;
}

const SYNONYMS: Record<string, string> = { ram: "memory", cpu: "cores", vnc: "video", tailscale: "tailnet", key: "secret", password: "secret", token: "token", limit: "most", reserve: "kept free", vm: "vm", disk: "disk" };

function option(label: string, where: string, page: "boxes" | "images" | "devices" | "network" | "monitor" | "configuration", id: string, extra = ""): Entry {
  return { label, where: `Options › ${where}`, words: `${label} ${where} ${extra}`, view: { page: "option", id: page }, id };
}

export function settingsIndex(doc: Document, live: Readonly<Record<string, BackendLive>>): Entry[] {
  const entries: Entry[] = [];
  for (const backend of doc.backends) {
    const driver = driverOf(backend.type);
    const title = backendTitle(backend, live[backend.id]);
    entries.push({ label: title, where: "Backends", words: `${title} ${driver.description}`, view: { page: "backend", id: backend.id } });
    for (const field of driver.fields) {
      const group = GROUPS.find((each) => each.id === groupOf(field))?.title ?? field.group;
      entries.push({ label: field.label, where: `${title} › ${group}`, words: `${field.label} ${field.description ?? ""} ${title} ${group}`, view: { page: "backend", id: backend.id }, id: `backends.${backend.id}.${field.key}` });
    }
  }
  const fallback = doc.general.defaultKind;
  entries.push({ label: "Box sizes", where: `Kinds › each kind's page, such as ${kindTitle(fallback)}`, words: "sizes small medium large largest cores memory disk preset", view: { page: "kind", id: fallback } });
  entries.push({ label: "Warm boxes", where: `Kinds › each kind's page, such as ${kindTitle(fallback)}`, words: "warm ready waiting", view: { page: "kind", id: fallback } });
  entries.push({ label: "Spare boxes", where: `Kinds › each kind's page, such as ${kindTitle(fallback)}`, words: "spares spare ahead", view: { page: "kind", id: fallback }, id: `kinds.${fallback}.spares` });
  for (const kind of KINDS) {
    const title = kindTitle(kind.id);
    entries.push({ label: title, where: "Kinds", words: `${title} ${kind.description} kind`, view: { page: "kind", id: kind.id } });
    entries.push({ label: `${title}: sizes, warm and spare boxes`, where: `Kinds › ${title}`, words: `${title} sizes warm spares`, view: { page: "kind", id: kind.id }, id: `kinds.${kind.id}.spares` });
  }
  entries.push(
    option("Default kind", "Boxes", "boxes", "general.defaultKind", "thread gets"),
    option("Boxes per thread", "Boxes", "boxes", "general.boxesPerThread", "limit most"),
    option("Boxes join BB as machines", "Boxes", "boxes", "general.enrol", "enrol enroll credentials"),
    option("Linux desktops as video", "Boxes", "boxes", "general.video", "vnc stream selkies"),
    option("Files for every box", "Boxes", "boxes", "general.files", "home dotfiles secret"),
    option("Rebuild each night", "Images", "images", "general.nightlyImages", "nightly refresh 03:00"),
    option("Standard images", "Images", "images", "general.nightlyImages", "templates rebuild now due"),
    option("Project images", "Images", "images", "general.nightlyImages", "box-setup script bake"),
    option("iOS video encoding", "Devices", "devices", "general.iosEncoder", "encoder hardware software h264"),
    option("Share each Mac's encoder fairly", "Devices", "devices", "general.encoderLedger", "encoder ledger stream"),
    option("Test device", "Devices", "devices", "general.testDevice", "test card"),
    option("Tailnet", "Network", "network", "general.tailnet", "tailscale oauth tags"),
    option("Machine status", "Monitor", "monitor", "monitor.enabled", "monitor sidebar"),
    option("Refresh every", "Monitor", "monitor", "monitor.refreshIntervalSeconds", "interval seconds"),
    option("Background monitoring", "Monitor", "monitor", "monitor.backgroundMonitoring", "logs"),
    option("Pressure notifications", "Monitor", "monitor", "monitor.pressureNotifications", "toast cpu memory"),
    option("Export", "Configuration", "configuration", "configuration.export", "json copy backup"),
    option("Import", "Configuration", "configuration", "configuration.import", "json apply restore"),
  );
  return entries;
}

export function search(entries: readonly Entry[], query: string): Entry[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SYNONYMS[word] ?? word);
  if (!words.length) return [];
  const scored = entries
    .map((entry) => {
      const label = entry.label.toLowerCase();
      const text = `${entry.words} ${entry.where}`.toLowerCase();
      if (!words.every((word) => text.includes(word) || label.includes(word))) return null;
      const score = words.reduce((sum, word) => sum + (label.startsWith(word) ? 3 : label.includes(word) ? 2 : 0), 0);
      return { entry, score };
    })
    .filter((item): item is { entry: Entry; score: number } => item !== null)
    .sort((a, b) => b.score - a.score);
  return scored.map((item) => item.entry);
}

export function FindField({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f" && document.activeElement !== ref.current) {
        event.preventDefault();
        ref.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === ref.current) onQuery("");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onQuery]);
  return (
    <label className="relative block">
      <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
      <Input ref={ref} aria-label="Find a setting" className="h-8 pl-8 text-xs" placeholder="Find a setting, such as memory, template or tailnet" value={query} onChange={(event) => onQuery(event.target.value)} />
    </label>
  );
}

export function FindResults({ query }: { query: string }) {
  const store = useStore();
  const nav = useNav();
  const results = search(settingsIndex(store.doc, store.live), query).slice(0, 30);
  if (!results.length) {
    return <div className="rounded-lg border border-dashed border-border px-6 py-6 text-center text-xs text-subtle-foreground">No setting matches “{query}”. Try a word from its label, such as memory, template or spares.</div>;
  }
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-subtle-foreground">{results.length === 30 ? "The first 30 matches" : `${results.length} ${results.length === 1 ? "match" : "matches"}`}</p>
      <Card>
        <Rows>
          {results.map((entry, index) => (
            <button key={`${entry.where}/${entry.label}/${index}`} type="button" onClick={() => nav.go(entry.view, entry.id)} className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-foreground">{entry.label}</span>
                <span className="block truncate text-xs text-subtle-foreground">{entry.where}</span>
              </span>
              <Chevron />
            </button>
          ))}
        </Rows>
      </Card>
    </div>
  );
}
