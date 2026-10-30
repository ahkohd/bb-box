import { useEffect, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/src/app/common.tsx";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { Card, Group, NavRow, PageHeader, Rows, SavedTick, SettingRow } from "@/src/app/settings-parts.tsx";
import type { FakeBox } from "./data";
import { go } from "./nav";
import { TopRow } from "./box-page";
import { SWEEP_DELETES_AT, UNDOS_A_BOX, useStore, type SnapshotSettings } from "./store";
import { money, spentThisMonth } from "./words";

type NumberKey = "perBox" | "roomPercent" | "keepDays" | "ceiling";
type SwitchKey = "agentsRestore" | "agentsMemory" | "pictures";

const LIMITS: Readonly<Record<NumberKey, { min: number; max: number }>> = { perBox: { min: 1, max: 50 }, roomPercent: { min: 50, max: 90 }, keepDays: { min: 1, max: 365 }, ceiling: { min: 0, max: 1000 } };

function offerWords(box: FakeBox): string {
  const cap = box.snapshotting;
  if (!cap) return "No snapshots";
  const holds = cap.holds.length === 2 ? "Disk, or disk and memory" : cap.holds[0] === "disk" ? "Disk" : "Disk and memory";
  const restore = box.storage?.newestOnly ? "restores the newest only" : cap.restore === "in-place" ? "restores any" : "restores as a new guest";
  const fork = cap.fork === "copy" ? "forks by full copy" : "no forks yet";
  const keeps = cap.keeps === "held-copy" ? "keeps by held copy" : cap.keeps === "as-is" ? "keeps as it is" : "no Keep";
  const price = cap.price ? `$${cap.price.amount.toFixed(3)} a day each` : "no charge";
  return `${holds}; ${restore}; ${fork}; ${keeps} · ${price}`;
}

export function SettingsOverview() {
  const store = useStore();
  const { settings } = store;
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Back", go: () => history.back() }, { words: "BB Box settings" }]} />
      <p className="text-sm text-muted-foreground">A stand-in for decision 067's overview, with its Options group only.</p>
      <Group title="Options">
        <Card>
          <Rows>
            <NavRow rowKey="option-boxes" icon={<BoxGlyph />} title="Boxes" value="Linux by default · no limit per thread" onClick={() => store.say("067's Boxes page.")} />
            <NavRow rowKey="option-images" icon={<Icon name="Activity" className="size-4" aria-hidden />} title="Images" value="Rebuilt each night" onClick={() => store.say("067's Images page.")} />
            <NavRow
              rowKey="option-snapshots"
              valueId="settings-option-snapshots"
              icon={<Icon name="Camera" className="size-4" aria-hidden />}
              title="Snapshots"
              value={[`${settings.perBox} per box`, `kept ${settings.keepDays} days`, `boat.dev up to ${money(settings.ceiling)} a month`].join(" · ")}
              tone={store.boxes.some((box) => box.cannotTakeWhy) ? "warn" : undefined}
              onClick={() => go({ page: "settings", section: "snapshots" })}
            />
            <NavRow rowKey="option-devices" icon={<Icon name="Info" className="size-4" aria-hidden />} title="Devices" value="iOS video: automatic" onClick={() => store.say("067's Devices page.")} />
            <NavRow rowKey="option-network" icon={<Icon name="Info" className="size-4" aria-hidden />} title="Network" value="No tailnet" onClick={() => store.say("067's Network page.")} />
          </Rows>
        </Card>
      </Group>
    </div>
  );
}

function NumberField({ id, value, unit, invalid, onChange, width = "w-20" }: { id: string; value: string; unit: string; invalid: boolean; onChange: (value: string) => void; width?: string }) {
  return (
    <span className="flex items-center gap-2">
      <Input id={id} inputMode="decimal" value={value} aria-invalid={invalid || undefined} onChange={(event) => onChange(event.target.value)} className={`h-8 ${width} text-right tabular-nums`} />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </span>
  );
}

function useDraft(settings: SnapshotSettings) {
  const saved = (key: NumberKey) => String(settings[key]);
  const [draft, setDraft] = useState<Record<NumberKey, string>>({ perBox: saved("perBox"), roomPercent: saved("roomPercent"), keepDays: saved("keepDays"), ceiling: saved("ceiling") });
  const invalid = (key: NumberKey) => {
    const number = Number(draft[key]);
    return !Number.isFinite(number) || number < LIMITS[key].min || number > LIMITS[key].max;
  };
  const changed = (Object.keys(draft) as NumberKey[]).filter((key) => draft[key] !== saved(key));
  return { draft, setDraft, invalid, changed, discard: () => setDraft({ perBox: saved("perBox"), roomPercent: saved("roomPercent"), keepDays: saved("keepDays"), ceiling: saved("ceiling") }) };
}

export function SnapshotSettingsPage() {
  const store = useStore();
  const { settings } = store;
  const { draft, setDraft, invalid, changed, discard } = useDraft(settings);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!savedKey) return;
    const timer = window.setTimeout(() => setSavedKey(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [savedKey]);
  const flip = (key: SwitchKey, on: boolean) => {
    store.setSettings({ [key]: on });
    setSavedKey(key);
  };
  const field = (key: NumberKey) => ({ value: draft[key], invalid: invalid(key), onChange: (value: string) => setDraft((current) => ({ ...current, [key]: value })) });
  const anyInvalid = changed.some((key) => invalid(key));
  const save = () => {
    store.setSettings(Object.fromEntries(changed.map((key) => [key, key === "ceiling" ? Math.round(Number(draft[key]) * 100) / 100 : Math.round(Number(draft[key]))])) as Partial<SnapshotSettings>);
    setSavedKey("numbers");
  };
  const rate = store.rate();
  const spent = spentThisMonth(store.snaps, store.deletedSpend, store.now);
  const held = store.snaps.filter((snap) => snap.price && snap.state === "ready").length;
  const over = rate > settings.ceiling;
  const unsaved = (key: NumberKey) => (draft[key] !== String(settings[key]) ? <Badge tone="warn">Unsaved</Badge> : null);
  const backends = [...new Map(store.boxes.filter((box) => box.state !== "released").map((box) => [`${box.backendLabel}/${box.storage?.name ?? ""}`, box])).values()];
  return (
    <div className="mx-auto w-full max-w-3xl space-y-7 px-4 pb-28 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "BB Box settings", go: () => go({ page: "settings", section: "" }) }, { words: "Snapshots" }]} />
      <PageHeader
        glyph={<Icon name="Camera" className="size-4 text-muted-foreground" aria-hidden />}
        title="Snapshots"
        description="A snapshot keeps a box's state so it can go back to it, or start a new box from it. Agents take their own; you see every one on the Boxes page."
        aside={
          <Button type="button" variant="outline" size="sm" className="h-8" onClick={() => go({ page: "list", tab: "snapshots" })}>
            Open the Snapshots tab
          </Button>
        }
      />
      <Group title="Each box">
        <Card>
          <Rows>
            <SettingRow label="Snapshots per box" htmlFor="per-box" description={`Kept ones count. Undos do not: each box keeps its last ${UNDOS_A_BOX} besides. An agent's next one replaces its own oldest that nobody kept; yours is refused with what to delete.`}>
              {unsaved("perBox")}
              <NumberField id="per-box" unit="a box" {...field("perBox")} />
            </SettingRow>
            <SettingRow label="Refuse new snapshots when a host's storage is past" htmlFor="room" description={`Snapshots on thin storage grow as a box changes. Past this, new ones are refused; ${SWEEP_DELETES_AT} points above it, bb-box deletes agents' snapshots nobody kept, oldest first, never a target, an undo or a kept one.`}>
              {unsaved("roomPercent")}
              <NumberField id="room" unit="% full" {...field("roomPercent")} />
            </SettingRow>
          </Rows>
        </Card>
      </Group>
      <Group title="Keep" description="Only you keep a snapshot. A kept one is yours, stays after its box is released, then goes at its date. You are warned 3 days before.">
        <Card>
          <SettingRow label="Keep keeps a snapshot for" htmlFor="keep-days">
            {unsaved("keepDays")}
            <NumberField id="keep-days" unit="days" {...field("keepDays")} />
          </SettingRow>
        </Card>
      </Group>
      <Group title="Agents and pictures">
        <Card>
          <Rows>
            <SettingRow label="Agents may restore their own boxes" htmlFor="agents-restore" description="With an undo taken first, never while another thread, your desktop control or a terminal is on the box. Never the box an agent runs on, or one of your machines: for those it asks you with a form in its thread. Off, it asks you for every restore.">
              <SavedTick show={savedKey === "agentsRestore"} />
              <Switch id="agents-restore" checked={settings.agentsRestore} onCheckedChange={(on) => flip("agentsRestore", on)} />
            </SettingRow>
            <SettingRow label="Agents may restore memory snapshots" htmlFor="agents-memory" description="A memory restore brings back running apps with the credentials they held then. Off, only you restore a memory snapshot.">
              <SavedTick show={savedKey === "agentsMemory"} />
              <Switch id="agents-memory" checked={settings.agentsMemory} onCheckedChange={(on) => flip("agentsMemory", on)} />
            </SettingRow>
            <SettingRow label="Keep a picture of the screen with each snapshot" htmlFor="pictures" description="A small picture of a desktop or device around the take, kept by bb-box beside the snapshot. It shows whatever was on the screen, and only to you and the snapshot's thread.">
              <SavedTick show={savedKey === "pictures"} />
              <Switch id="pictures" checked={settings.pictures} onCheckedChange={(on) => flip("pictures", on)} />
            </SettingRow>
          </Rows>
        </Card>
      </Group>
      <Group title="Paid snapshots" description="A ceiling on the monthly rate of what is held, per provider and account: every paid snapshot held, times its daily price, times 30. A take, an undo, a Keep or a renewal that would pass it is refused. It is not a cap on the bill, and bb-box never deletes kept snapshots to get under it.">
        <Card>
          <SettingRow
            label="boat.dev, this install's account"
            htmlFor="ceiling"
            description={
              <>
                $0.056 a day for each saved snapshot past your plan's. Held now: {held}, about {money(rate)} a month. Spent this month so far, deleted ones included: {money(spent)}.
                {over ? <span className="mt-1 block text-warning-text">The rate held is past the ceiling: new paid snapshots are refused until you raise it or delete some.</span> : null}
              </>
            }
          >
            {unsaved("ceiling")}
            <NumberField id="ceiling" unit="$ a month" {...field("ceiling")} />
          </SettingRow>
        </Card>
      </Group>
      <Group title="What each backend offers" description="From each backend and its storage, read when it starts. A backend with none says so, and its boxes have none.">
        <Card>
          <Rows>
            {backends.map((box) => (
              <BackendOffer key={`${box.backendLabel}/${box.storage?.name ?? ""}`} box={box} />
            ))}
          </Rows>
        </Card>
      </Group>
      {changed.length || savedKey === "numbers" ? (
        <div role="region" aria-label="Unsaved changes" className="fixed bottom-3 left-1/2 z-40 flex w-[min(36rem,calc(100vw-1.5rem))] -translate-x-1/2 items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm">
          {changed.length ? (
            <>
              <span className="min-w-0 flex-1 text-foreground">{changed.length === 1 ? "1 unsaved change" : `${changed.length} unsaved changes`}{anyInvalid ? <span className="block text-xs text-destructive-text">A value is out of range.</span> : null}</span>
              <Button type="button" variant="ghost" size="sm" className="h-8" onClick={discard}>
                Discard
              </Button>
              <Button type="button" size="sm" className="h-8" disabled={anyInvalid} onClick={save}>
                Save
              </Button>
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Icon name="Check" className="size-3.5" aria-hidden />
              Saved
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BackendOffer({ box }: { box: FakeBox }): ReactNode {
  const store = useStore();
  const [checking, setChecking] = useState(false);
  const title = box.backendLabel.replace(/^a /, "").replace(/^the /, "");
  const named = title.startsWith("boat") ? title : title.charAt(0).toUpperCase() + title.slice(1);
  const label = box.storage && box.snapshotting ? `${named}, ${box.storage.name} (${box.storage.type})` : named;
  if (box.cannotTakeWhy) {
    return (
      <div>
        <NavRow rowKey={`offer-${label}`} icon={<BoxGlyph />} title={label} value="The token cannot take snapshots" tone="warn" onClick={() => store.say("Opens the backend's page in 067.")} />
        <div className="flex flex-wrap items-center gap-2 px-4 pb-3 pl-12 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Fix: run <code className="font-mono text-foreground">host/setup-token.sh</code> again on {box.host}, or give the role VM.Snapshot and VM.Snapshot.Rollback.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            disabled={checking}
            onClick={() => {
              setChecking(true);
              window.setTimeout(() => {
                setChecking(false);
                store.fixToken(box.host);
                store.say(`${box.host}'s token can take snapshots now.`);
              }, 1_200);
            }}
          >
            {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
      </div>
    );
  }
  return <NavRow rowKey={`offer-${label}`} icon={<BoxGlyph />} title={label} value={offerWords(box)} onClick={() => store.say("Opens the backend's page in 067.")} />;
}
