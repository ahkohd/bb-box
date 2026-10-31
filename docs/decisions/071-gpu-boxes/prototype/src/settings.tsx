import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { MenuSelect } from "@/src/app/box-form.tsx";
import { Card, Group, PageHeader, Rows, SettingRow } from "@/src/app/settings-parts.tsx";
import { BACKENDS, type BackendId, type GpuPart, type GpuSettings, type KindId } from "./data";
import { TopRow } from "./box-page";
import { cardSummary } from "./boxes";
import { go } from "./nav";
import { capital, cardName, cardsOf, gib, GPU_WORDS, holders, listed, overLimit, waitingFor } from "./placement";
import { useStore } from "./store";

type NumberKey = "boxesPerCard" | "gpuMemoryMiB";
const LIMITS: Readonly<Record<NumberKey, { min: number; max: number }>> = { boxesPerCard: { min: 0, max: 64 }, gpuMemoryMiB: { min: 0, max: 81_920 } };
const SAVE_MS = 450;
const SAVED_MS = 1_600;

function valid(name: NumberKey, text: string): boolean {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value >= LIMITS[name].min && value <= LIMITS[name].max;
}

function useSaved(): [boolean, () => void] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current !== null && clearTimeout(timer.current)), []);
  return [
    saved,
    () => {
      setSaved(true);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSaved(false), SAVED_MS);
    },
  ];
}

function SavedMark({ shown }: { shown: boolean }) {
  return <span className={shown ? "text-xs text-muted-foreground" : "invisible text-xs"}>Saved</span>;
}

function GpuSection({ backend }: { backend: BackendId }) {
  const store = useStore();
  const info = BACKENDS.find((each) => each.id === backend)!;
  const settings = store.settings[backend];
  const cards = cardsOf(store, backend);
  const prefix = backend === "docker" ? "" : "proxmox-lxc-";
  const [draft, setDraft] = useState<Readonly<Record<NumberKey, string>>>({ boxesPerCard: String(settings.boxesPerCard), gpuMemoryMiB: String(settings.gpuMemoryMiB) });
  const [saving, setSaving] = useState(false);
  const [formSaved, markFormSaved] = useSaved();
  const [switchSaved, markSwitchSaved] = useSaved();
  const changed = (["boxesPerCard", "gpuMemoryMiB"] as const).filter((name) => draft[name] !== String(settings[name]));
  const allValid = changed.every((name) => valid(name, draft[name]));
  const wholeHolders = cards.flatMap((card) => holders(store, card).filter((box) => box.gpu === "whole"));
  const save = () => {
    if (!changed.length || !allValid) return;
    setSaving(true);
    window.setTimeout(() => {
      store.setSettings(backend, { ...store.settings[backend], boxesPerCard: Number(draft.boxesPerCard), gpuMemoryMiB: Number(draft.gpuMemoryMiB) } as GpuSettings);
      setSaving(false);
      markFormSaved();
    }, SAVE_MS);
  };
  const field = (name: NumberKey, id: string) => (
    <span className="flex items-center gap-2">
      {draft[name] !== String(settings[name]) ? <span className="rounded-sm bg-state-active px-1 text-2xs text-foreground">Changed</span> : null}
      <Input
        id={id}
        inputMode="numeric"
        className="h-7 w-24 px-2 text-xs"
        value={draft[name]}
        aria-invalid={!valid(name, draft[name]) || undefined}
        onChange={(event) => setDraft((all) => ({ ...all, [name]: event.target.value }))}
        onKeyDown={(event) => {
          if (event.key === "Enter") save();
        }}
      />
    </span>
  );
  return (
    <div className="space-y-6">
      <PageHeader title={`${info.label} on ${info.host}`} description="Switches, and menus that stand alone, act at once. Fields wait for Save. These set limits and defaults only: no setting changes a box's own GPU." />
      <Group title="GPUs" description={backend === "docker" ? "GPU boxes is on. Every box with Docker in it can open every card on docker-1." : `The cards on ${info.host}, as its GPU helper reports them.`}>
        <Card>
          <Rows>
            <SettingRow label="Boxes per card" description="The most boxes running on one card, desktops and servers together. 0 means no limit. A lower limit stops nothing that runs." htmlFor={`${backend}-per-card`} path={`${prefix}boxes-per-card`}>
              {field("boxesPerCard", `${backend}-per-card`)}
            </SettingRow>
            <SettingRow
              label="Whole cards"
              description={settings.wholeCards ? "Lets a box have a card to itself." : `Off: no box is given a whole card or changes to one.${wholeHolders.length ? ` ${listed(wholeHolders.map((box) => box.name))} ${wholeHolders.length === 1 ? "keeps its card" : "keep their cards"} until changed or released.` : ""}`}
              htmlFor={`${backend}-whole`}
              path={`${prefix}whole-cards`}
            >
              <span className="flex items-center gap-2">
                <SavedMark shown={switchSaved} />
                <Switch
                  id={`${backend}-whole`}
                  checked={settings.wholeCards}
                  aria-label="Whole cards"
                  onCheckedChange={(checked) => {
                    store.setSettings(backend, { ...settings, wholeCards: checked });
                    markSwitchSaved();
                  }}
                />
              </span>
            </SettingRow>
            <SettingRow label="GPU memory a new box needs, MiB" description="A card must have this free, when last read, for a new server box to be placed on it. A start-up check, not a limit on what the box uses. A desktop needs at least 384 MiB." htmlFor={`${backend}-memory`} path={`${prefix}gpu-memory-mib`}>
              {field("gpuMemoryMiB", `${backend}-memory`)}
            </SettingRow>
          </Rows>
        </Card>
        <div className="flex min-h-8 flex-wrap items-center justify-end gap-2 pt-2 text-xs">
          {changed.length ? (
            <>
              <span className="mr-auto text-muted-foreground">
                {changed.length === 1 ? "1 change" : `${changed.length} changes`} to {info.label} on {info.host} not saved{allValid ? "" : ": a value is out of range"}
              </span>
              <Button type="button" variant="outline" size="sm" className="h-7 font-normal" onClick={() => setDraft({ boxesPerCard: String(settings.boxesPerCard), gpuMemoryMiB: String(settings.gpuMemoryMiB) })}>
                Discard
              </Button>
              <Button type="button" size="sm" className="h-7 font-normal" disabled={!allValid || saving} onClick={save}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <SavedMark shown={formSaved} />
          )}
        </div>
      </Group>
      <Group title="Cards" description={backend === "docker" ? "As Docker lists them, 20 s ago." : `As the helper on ${info.host} reported them, 5 s ago.`}>
        <Card>
          <Rows>
            {cards.map((card) => {
              const on = holders(store, card);
              const parked = waitingFor(store, card);
              const over = overLimit(store, card);
              return (
                <div key={card.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                    {capital(cardName(card))}
                    <span className="text-xs text-muted-foreground">
                      {card.model} · {gib(card.memoryMiB)}
                    </span>
                    <span className="flex-1" />
                    <span className="text-xs tabular-nums text-muted-foreground">{cardSummary(store, card)}</span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-2xs text-subtle-foreground">{card.id}</p>
                  {card.outsideMiB > 0 ? <p className="mt-0.5 text-xs text-muted-foreground">{gib(card.outsideMiB)} in use outside bb-box's boxes.</p> : null}
                  {over.length ? (
                    <p className="mt-0.5 text-xs text-warning-text">
                      {on.length} boxes running, {over.length} over the limit of {settings.boxesPerCard}. They keep running; no new box goes on {cardName(card)} until it has room.
                    </p>
                  ) : null}
                  {on.length || parked.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {[...on, ...parked].map((box) => (
                        <button key={box.id} type="button" onClick={() => go({ page: "box", id: box.id })} className="inline-flex h-6 cursor-pointer items-center rounded-full border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          {box.name}
                          <span className="pl-1 text-muted-foreground">{box.gpu === "whole" ? "whole" : box.state === "stopped" ? (parked.includes(box) ? "stopped, holds no place" : "stopped") : "shared"}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </Rows>
        </Card>
      </Group>
    </div>
  );
}

function KindDefaults() {
  const store = useStore();
  const [saved, markSaved] = useSaved();
  const kinds: readonly { id: KindId; label: string }[] = [
    { id: "linux", label: "linux" },
    { id: "linux-desktop", label: "linux-desktop" },
  ];
  return (
    <div className="space-y-6">
      <PageHeader title="Kinds" description="Each kind's page. GPU when not asked for is what a box of the kind gets when a request leaves gpu out, and the New box form's first choice until you choose. An agent never gets the form's remembered choice." />
      <Group title="GPU when not asked for">
        <Card>
          <Rows>
            {kinds.map((kind) => (
              <SettingRow key={kind.id} label={kind.label} description={kind.id === "linux" ? "A server." : "An X11 desktop. linux-desktop-cpu is the same with no GPU."} path={`kinds.${kind.id}.gpu`}>
                <span className="flex items-center gap-2">
                  <SavedMark shown={saved} />
                  <MenuSelect
                    label={`GPU for ${kind.label}`}
                    value={store.kindGpu[kind.id]}
                    options={(["none", "shared", "whole"] as const).map((value) => ({ value, label: GPU_WORDS[value] }))}
                    onChange={(value) => {
                      store.setKindGpu(kind.id, value as GpuPart);
                      markSaved();
                    }}
                  />
                </span>
              </SettingRow>
            ))}
          </Rows>
        </Card>
      </Group>
    </div>
  );
}

export function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "BB Box settings" }, { words: "Backends and kinds" }]} />
      <GpuSection backend="proxmox-lxc" />
      <GpuSection backend="docker" />
      <KindDefaults />
    </div>
  );
}
