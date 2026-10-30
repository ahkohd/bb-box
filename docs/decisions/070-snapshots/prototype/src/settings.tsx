import { useEffect, useState, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { Card, Group, NavRow, PageHeader, Rows, SavedTick, SettingRow } from "@/src/app/settings-parts.tsx";
import { DAY, type FakeBox } from "./data";
import { go } from "./nav";
import { TopRow } from "./box-page";
import { useStore, type SnapshotSettings } from "./store";
import { endOfMonth, money, plural } from "./words";

function useSaved(): [string | null, (key: string) => void] {
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(null), 1_600);
    return () => window.clearTimeout(timer);
  }, [saved]);
  return [saved, setSaved];
}

function offerWords(box: FakeBox): string {
  const cap = box.snapshotting;
  if (!cap) return "No snapshots";
  const holds = cap.holds.length === 2 ? "Disk, or disk and memory" : cap.holds[0] === "disk" ? "Disk" : "Disk and memory";
  const restore = cap.restore === "in-place" ? "restores any" : "restores as a new guest";
  const fork = cap.fork === "copy" ? "forks by copy" : cap.fork === "thin" ? "forks thin" : "no forks";
  const price = cap.price ? `$${cap.price.amount.toFixed(3)} a day each` : "no charge";
  return `${holds}; ${restore}; ${fork} · ${price}`;
}

export function SettingsOverview() {
  const store = useStore();
  const { settings } = store;
  const paid = store.boxes.some((box) => box.snapshotting?.price);
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
              value={[`${settings.perBox} per box`, `kept ${settings.keepDays} days`, ...(paid ? [`up to ${money(settings.ceiling)} a month on boat.dev`] : [])].join(" · ")}
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

function NumberField({ id, value, min, max, unit, onSave, width = "w-20" }: { id: string; value: number; min: number; max: number; unit: string; onSave: (value: number) => void; width?: string }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const number = Number(text);
  const valid = Number.isFinite(number) && number >= min && number <= max;
  return (
    <span className="flex items-center gap-2">
      <Input
        id={id}
        inputMode="decimal"
        value={text}
        aria-invalid={!valid || undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => (valid && number !== value ? onSave(number) : setText(String(value)))}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
        className={`h-8 ${width} text-right tabular-nums`}
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </span>
  );
}

export function SnapshotSettingsPage() {
  const store = useStore();
  const { settings } = store;
  const [saved, setSaved] = useSaved();
  const save = (key: keyof SnapshotSettings, change: Partial<SnapshotSettings>) => {
    store.setSettings(change);
    setSaved(key);
  };
  const tick = (key: keyof SnapshotSettings) => <SavedTick show={saved === key} />;
  const cost = store.monthCost();
  const paidSnaps = store.snaps.filter((snap) => snap.price && snap.state === "ready").length;
  const daysLeft = Math.ceil((endOfMonth(store.now) - store.now) / DAY);
  const over = cost > settings.ceiling;
  const backends = [...new Map(store.boxes.filter((box) => box.state !== "released").map((box) => [box.backendLabel, box])).values()];
  return (
    <div className="mx-auto w-full max-w-3xl space-y-7 px-4 pb-6 pt-3 md:px-5 md:pt-4">
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
            <SettingRow label="Snapshots per box" htmlFor="per-box" description="Kept ones count. An agent's next one replaces its oldest that nobody kept; yours is refused with what to delete.">
              {tick("perBox")}
              <NumberField id="per-box" value={settings.perBox} min={1} max={50} unit="a box" onSave={(value) => save("perBox", { perBox: Math.round(value) })} />
            </SettingRow>
            <SettingRow label="Keep each host's snapshot storage below" htmlFor="room" description="A snapshot that would fill it past this is refused, naming the largest snapshots on it.">
              {tick("roomPercent")}
              <NumberField id="room" value={settings.roomPercent} min={50} max={95} unit="% full" onSave={(value) => save("roomPercent", { roomPercent: Math.round(value) })} />
            </SettingRow>
          </Rows>
        </Card>
      </Group>
      <Group title="Keep" description="Only you keep a snapshot. A kept one stays after its box is released, then goes at its date. You are warned 3 days before.">
        <Card>
          <SettingRow label="Keep keeps a snapshot for" htmlFor="keep-days">
            {tick("keepDays")}
            <NumberField id="keep-days" value={settings.keepDays} min={1} max={365} unit="days" onSave={(value) => save("keepDays", { keepDays: Math.round(value) })} />
          </SettingRow>
        </Card>
      </Group>
      <Group title="Agents and pictures">
        <Card>
          <Rows>
            <SettingRow label="Agents may restore their own boxes" htmlFor="agents-restore" description="With an undo taken first. Never one of your machines without your yes in the thread. Off, an agent asks you instead.">
              {tick("agentsRestore")}
              <Switch id="agents-restore" checked={settings.agentsRestore} onCheckedChange={(on) => save("agentsRestore", { agentsRestore: on })} />
            </SettingRow>
            <SettingRow label="Keep a picture of the screen with each snapshot" htmlFor="pictures" description="A small picture of a desktop or device, kept by bb-box beside the snapshot. It shows whatever was on the screen, and only to you and the snapshot's thread.">
              {tick("pictures")}
              <Switch id="pictures" checked={settings.pictures} onCheckedChange={(on) => save("pictures", { pictures: on })} />
            </SettingRow>
          </Rows>
        </Card>
      </Group>
      <Group title="Paid snapshots" description="Where a provider charges for snapshots, a ceiling a month. A snapshot that would bring the month's total past it is refused.">
        <Card>
          <SettingRow
            label="boat.dev"
            htmlFor="ceiling"
            description={
              <>
                $0.056 a day for each saved snapshot past your plan's. This month: about {money(cost)} of {money(settings.ceiling)}, for {plural(paidSnaps, "snapshot")} held to the end of the month ({plural(daysLeft, "day")} left).
                {over ? <span className="mt-1 block text-warning-text">New snapshots on boat.dev are refused until you raise the ceiling or delete one.</span> : null}
              </>
            }
          >
            {tick("ceiling")}
            <NumberField id="ceiling" value={settings.ceiling} min={0} max={1000} unit="$ a month" onSave={(value) => save("ceiling", { ceiling: Math.round(value * 100) / 100 })} />
          </SettingRow>
        </Card>
      </Group>
      <Group title="What each backend offers" description="From each backend, per kind. A backend with none says so, and its boxes have none.">
        <Card>
          <Rows>
            {backends.map((box) => (
              <BackendOffer key={box.backendLabel} box={box} />
            ))}
          </Rows>
        </Card>
      </Group>
    </div>
  );
}

function BackendOffer({ box }: { box: FakeBox }): ReactNode {
  const store = useStore();
  const [checking, setChecking] = useState(false);
  const title = box.backendLabel.replace(/^a /, "").replace(/^the /, "");
  const label = title.startsWith("boat") ? title : title.charAt(0).toUpperCase() + title.slice(1);
  if (box.cannotTakeWhy) {
    return (
      <div>
        <NavRow rowKey={`offer-${box.backendLabel}`} icon={<BoxGlyph />} title={label} value="The token cannot take snapshots" tone="warn" onClick={() => store.say("Opens the backend's page in 067.")} />
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
  return <NavRow rowKey={`offer-${box.backendLabel}`} icon={<BoxGlyph />} title={label} value={offerWords(box)} onClick={() => store.say("Opens the backend's page in 067.")} />;
}
