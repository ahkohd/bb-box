import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Card, Group, PageHeader, Rows, SettingRow } from "@/src/app/settings-parts.tsx";
import { BACKENDS, type BackendId, type GpuSettings } from "./data";
import { TopRow } from "./box-page";
import { cardSummary } from "./boxes";
import { go } from "./nav";
import { boxesOnCard, capital, cardName, cardsOf, gib } from "./placement";
import { useStore } from "./store";

type NumberKey = "boxesPerCard" | "gpuMemoryMiB";
const LIMITS: Readonly<Record<NumberKey, { min: number; max: number }>> = { boxesPerCard: { min: 0, max: 64 }, gpuMemoryMiB: { min: 0, max: 81_920 } };

function NumberField({ backend, name, id }: { backend: BackendId; name: NumberKey; id: string }) {
  const store = useStore();
  const settings = store.settings[backend];
  const [text, setText] = useState(String(settings[name]));
  const value = Number(text);
  const ok = /^\d+$/.test(text.trim()) && value >= LIMITS[name].min && value <= LIMITS[name].max;
  return (
    <Input
      id={id}
      inputMode="numeric"
      className="h-7 w-24 px-2 text-xs"
      value={text}
      aria-invalid={!ok || undefined}
      onChange={(event) => {
        setText(event.target.value);
        const next = Number(event.target.value);
        if (/^\d+$/.test(event.target.value.trim()) && next >= LIMITS[name].min && next <= LIMITS[name].max) store.setSettings(backend, { ...settings, [name]: next } as GpuSettings);
      }}
    />
  );
}

function GpuSection({ backend }: { backend: BackendId }) {
  const store = useStore();
  const info = BACKENDS.find((each) => each.id === backend)!;
  const settings = store.settings[backend];
  const cards = cardsOf(store, backend);
  const prefix = backend === "docker" ? "" : "proxmox-lxc-";
  return (
    <div className="space-y-6">
      <PageHeader title={`${info.label} on ${info.host}`} description={`The GPUs section of its backend page. It sets limits and defaults only: each box's GPU is chosen in New box, by Resize, and by the agent's tools.`} />
      <Group title="GPUs" description={backend === "docker" ? "Cards the NVIDIA Container Toolkit lists as CDI devices. GPU boxes, which was GPU desktops, is on." : "Cards bb-box-gpu, the helper on the host, reports and gives boxes."}>
        <Card>
          <Rows>
            <SettingRow label="Boxes per card" description="The most boxes that share one card, desktops and servers together. 0 means no limit." htmlFor={`${backend}-per-card`} path={`${prefix}boxes-per-card`}>
              <NumberField backend={backend} name="boxesPerCard" id={`${backend}-per-card`} />
            </SettingRow>
            <SettingRow label="Whole cards" description="Lets a box have a card to itself. Off, every box with a GPU shares." htmlFor={`${backend}-whole`} path={`${prefix}whole-cards`}>
              <Switch id={`${backend}-whole`} checked={settings.wholeCards} aria-label="Whole cards" onCheckedChange={(checked) => store.setSettings(backend, { ...settings, wholeCards: checked })} />
            </SettingRow>
            <SettingRow label="GPU memory a new box needs, MiB" description="A card must have this free for a new server box to be placed on it. A desktop needs at least 384 MiB." htmlFor={`${backend}-memory`} path={`${prefix}gpu-memory-mib`}>
              <NumberField backend={backend} name="gpuMemoryMiB" id={`${backend}-memory`} />
            </SettingRow>
          </Rows>
        </Card>
      </Group>
      <Group title="Cards" description={backend === "docker" ? "As Docker lists them." : "As the host's helper last reported them, a few seconds ago."}>
        <Card>
          <Rows>
            {cards.map((card) => {
              const on = boxesOnCard(store, card);
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
                  {on.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {on.map((box) => (
                        <button key={box.id} type="button" onClick={() => go({ page: "box", id: box.id })} className="inline-flex h-6 cursor-pointer items-center rounded-full border border-border bg-background px-2 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                          {box.name}
                          <span className="pl-1 text-muted-foreground">{box.gpu === "whole" ? "whole" : box.state === "stopped" ? "stopped" : "shared"}</span>
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

export function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "BB Box settings" }, { words: "Backends" }]} />
      <GpuSection backend="proxmox-lxc" />
      <GpuSection backend="docker" />
    </div>
  );
}
