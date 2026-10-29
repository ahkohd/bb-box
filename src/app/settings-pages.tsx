import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BackendConfig, ConfigDocument } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { DriverView } from "../plugin/configuration.ts";
import { Badge, KindBadges, isArm64Badge, lacksDocker, message, relativeTime } from "./common.tsx";
import { runsWayland } from "./boxes-filter.ts";
import { effectiveKind, inheritSource, kindChanges, sourceName, withBackend, withGeneral, withKind } from "./config.ts";
import { RebuildNow } from "./rebuild-now.tsx";
import { BackendForm, backendName, type BackendRowModel } from "./settings-backends.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { DockerHostsSection } from "./settings-docker-hosts.tsx";
import { DraftNumberRow, unplacedProblems } from "./settings-draft-fields.tsx";
import { BOXES_PART, MONITOR_PART } from "./settings-drafts.ts";
import { BoxFilesSection } from "./settings-files.tsx";
import { RestoredNote, SaveBar, useDraft } from "./settings-saving.tsx";
import { KindForm, kindRowModel } from "./settings-kinds.tsx";
import { iosEncoderWords, monitorChanged, noteMonitorChanged, ReloadNote } from "./settings-overview.tsx";
import { Card, Chevron, FOCUS_RING, Group, PageHeader, ProviderGlyph, RowNote, Rows, SavedTick, SettingRow, StateLine } from "./settings-parts.tsx";
import { isOptionPage, type SettingsView } from "./settings-route.ts";
import { backendHealth, backendLabel, isMachineDocker, kindName, plural } from "./settings-status.ts";
import { TailnetSection } from "./settings-tailnet.tsx";

export const SAVING_RULE = "Switches, and menus that stand alone, act at once. Fields, checkboxes and radio choices wait for Save.";

export function NotHere({ what }: { what: string }) {
  const { nav } = useSettings();
  return (
    <div className="space-y-3">
      <PageHeader title={`This ${what} is not here`} description={`BB Box's configuration has no such ${what}. It may have been removed, or the link may be wrong.`} />
      <Button type="button" variant="outline" size="sm" className="h-8" onClick={nav.toOverview}>
        Go to BB Box settings
      </Button>
    </div>
  );
}

function backendModel(state: ReturnType<typeof useSettings>["state"], driver: DriverView, config: BackendConfig | null): BackendRowModel {
  const id = config?.id ?? driver.type;
  const source = inheritSource(state.document, driver.fields, id);
  return {
    driver,
    config,
    source,
    sourceName: source ? sourceName(state.document, source, state.drivers.find((candidate) => candidate.type === source.type)?.label ?? source.type) : null,
    state: config ? (state.backends.find((candidate) => candidate.id === config.id) ?? null) : null,
    problems: config ? state.problems.filter((problem) => problem.path === `backends.${config.id}` || problem.path.startsWith(`backends.${config.id}.`)) : [],
  };
}

function useBackendForm() {
  const { state, apply } = useSettings();
  const rpc = useRpc<Contract>();
  return {
    onSave: (config: Parameters<typeof withBackend>[1]) => apply(withBackend(state.document, config)),
    onCheck: async (config: Parameters<typeof withBackend>[1]) => {
      try {
        return await rpc.call("config.check", { draft: withBackend(state.document, config), test: config.id });
      } catch (caught) {
        return { problems: [{ path: `backends.${config.id}`, message: message(caught) }], doctor: null };
      }
    },
  };
}

export function BackendPage({ id }: { id: string }) {
  const { state, nav, instant, writes } = useSettings();
  const form = useBackendForm();
  const config = state.document.backends.find((backend) => backend.id === id);
  const driver = config ? state.drivers.find((candidate) => candidate.type === config.type) : undefined;
  if (!config) return <NotHere what="backend" />;
  const now = Date.now();
  const label = backendLabel(state, config);
  const health = backendHealth(state, config, now);
  const chip = backendName(config.id, label);
  const key = switchKey.backend(config.id);
  const pending = instant.pendingValue<boolean>(key);
  const live = state.backends.find((candidate) => candidate.id === config.id);
  const healthId = "settings-backend-health";
  const checked = health.checkedAt !== null ? `checked ${relativeTime(health.checkedAt, now)}` : null;
  const healthItems = [
    ...(health.status === "stale" ? [`${relativeTime(health.checkedAt!, now)}, so it may have changed since`] : checked && health.status !== "off" && health.status !== "unfinished" ? [checked] : []),
    ...(health.detail && health.status !== "stale" && health.status !== "ready" ? [health.detail] : []),
  ];
  const kinds = live?.kinds ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        glyph={<ProviderGlyph type={config.type} className="size-5" />}
        title={label}
        chips={
          <>
            {chip ? <Badge>{chip}</Badge> : null}
            {isMachineDocker(config) ? <Badge>BB machine</Badge> : null}
          </>
        }
        description={
          <>
            <p>{driver?.description ?? config.type}</p>
            <p className="mt-1">Saved changes reach new boxes; boxes already made keep theirs.</p>
          </>
        }
        aside={
          <label className="flex items-center gap-2 text-xs text-foreground">
            <SavedTick show={instant.isSaved(key)} />
            Takes new boxes
            <Switch aria-label={`${label}: takes new boxes`} aria-describedby={healthId} checked={pending ?? config.enabled} aria-disabled={instant.pending !== null || undefined} onCheckedChange={(on) => void instant.run(writes.backendOn(state, config, on, label))} />
          </label>
        }
      >
        <RowNote note={instant.note(key)} />
      </PageHeader>
      <Group title="Health">
        <Card className="space-y-1.5 px-4 py-3">
          <StateLine id={healthId} tone={health.tone} words={health.words} items={healthItems} />
          {health.fix && (health.status === "failing" || health.status === "attention" || health.status === "unfinished") ? <p className="pl-5 text-xs text-foreground">Fix: {health.fix}</p> : null}
          <p className="pl-5 text-xs text-muted-foreground">
            {[plural(live?.boxes ?? 0, "box", "boxes") + " now", kinds.length ? `makes ${kinds.map((kind) => { const info = state.kinds.find((candidate) => candidate.id === kind); return info ? kindName(state.kinds, info) : kind; }).join(", ")}` : "makes no kind now"].join(" · ")}
          </p>
        </Card>
      </Group>
      {isMachineDocker(config) ? (
        <DockerHostsSection />
      ) : driver ? (
        <Group title="Settings" description="Today's form for this backend: Save, Check and its last check report.">
          <Card className="px-4 pb-4 pt-1 [&>form]:mt-0 [&>form]:border-t-0">
            <BackendForm key={`${config.id}-${state.revision}`} model={backendModel(state, driver, config)} onSave={form.onSave} onCheck={form.onCheck} onClose={nav.back} />
          </Card>
        </Group>
      ) : (
        <p className="text-xs text-destructive-text">This version of BB Box has no driver for {config.type}.</p>
      )}
    </div>
  );
}

export function AddBackendPage() {
  const { state, nav } = useSettings();
  const added = (driver: DriverView) => state.document.backends.find((backend) => backend.type === driver.type && !isMachineDocker(backend));
  return (
    <div className="space-y-6">
      <PageHeader title="Add a backend" description="Where boxes can run. Each says what it makes; setting one up opens its guide and form." />
      <Group title="Backends">
        <Card>
          <Rows>
            {state.drivers.map((driver) => {
              const existing = added(driver);
              const rowKey = `add-${driver.type}`;
              return (
                <button
                  key={driver.type}
                  type="button"
                  data-row-key={rowKey}
                  onClick={() => nav.go(existing ? { page: "backend", id: existing.id } : { page: "setup", type: driver.type }, rowKey)}
                  className={`flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover ${FOCUS_RING}`}
                >
                  <ProviderGlyph type={driver.type} className="mt-0.5" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{driver.label}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{driver.description}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2 self-center text-xs text-muted-foreground">
                    {existing ? "Added: open it" : "Set up"}
                    <Chevron />
                  </span>
                </button>
              );
            })}
          </Rows>
        </Card>
      </Group>
      <DockerHostsSection />
    </div>
  );
}

export function SetupPage({ type }: { type: string }) {
  const { state, nav } = useSettings();
  const form = useBackendForm();
  const driver = state.drivers.find((candidate) => candidate.type === type);
  const exists = state.document.backends.some((backend) => backend.id === type);
  const existedAtStart = useRef(exists);
  const saved = useRef(false);
  const land = () => nav.replace({ page: "backend", id: type });
  useEffect(() => {
    if (exists && !existedAtStart.current) nav.replace({ page: "backend", id: type });
  }, [exists, nav, type]);
  if (!driver) return <NotHere what="kind of backend" />;
  if (exists && existedAtStart.current) {
    return (
      <div className="space-y-3">
        <PageHeader title={`${driver.label} is added`} description="It has its own page, with its settings and checks." />
        <Button type="button" variant="outline" size="sm" className="h-8" onClick={land}>
          Open {driver.label}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader glyph={<ProviderGlyph type={driver.type} className="size-5" />} title={`Set up ${driver.label}`} description={driver.description} />
      <Card className="px-4 pb-4 pt-1 [&>form]:mt-0 [&>form]:border-t-0">
        <BackendForm
          model={backendModel(state, driver, null)}
          onSave={async (config) => {
            const result = await form.onSave(config);
            if (result.saved) saved.current = true;
            return result;
          }}
          onCheck={form.onCheck}
          onClose={() => (saved.current ? land() : nav.back())}
        />
      </Card>
    </div>
  );
}

export function KindPage({ id }: { id: string }) {
  const { state, nav, instant, writes, apply } = useSettings();
  const info = state.kinds.find((kind) => kind.id === id);
  if (!info) return <NotHere what="kind" />;
  const name = kindName(state.kinds, info);
  const sizes = effectiveKind(state, id);
  const model = kindRowModel(state, info, sizes);
  const general = { ...state.defaults.general, ...state.document.general };
  const isDefault = general.defaultKind === id;
  const key = switchKey.kind(id);
  const defaultKey = switchKey.general("defaultKind");
  const pending = instant.pendingValue<boolean>(key);
  const enabled = pending ?? sizes.enabled;
  const forms = [...new Set(model.backends.filter((backend) => backend.offers).map((backend) => backend.form).filter((form): form is NonNullable<typeof form> => form !== null))];
  return (
    <div className="space-y-6">
      <PageHeader
        title={name}
        chips={
          <>
            <KindBadges desktop={info.desktop} wayland={runsWayland({ desktop: info.desktop, kind: info.id })} gpu={info.gpu} noDocker={lacksDocker(info)} arm64={isArm64Badge(info.os, info.arch)} forms={forms} />
            {isDefault ? <Badge>Default</Badge> : null}
          </>
        }
        description={info.description}
        aside={
          <>
            {!isDefault ? (
              <Button type="button" variant="outline" size="sm" className="h-7" disabled={!enabled} aria-disabled={instant.pending !== null || undefined} onClick={() => void instant.run(writes.general(state, "defaultKind", id, "The default kind", (value) => kindName(state.kinds, state.kinds.find((kind) => kind.id === value) ?? info)))}>
                Make default
              </Button>
            ) : null}
            <label className="flex items-center gap-2 text-xs text-foreground">
              <SavedTick show={instant.isSaved(key) || instant.isSaved(defaultKey)} />
              Offered to threads
              <Switch aria-label={`${name}: offered to threads`} checked={enabled} disabled={isDefault && enabled} aria-disabled={instant.pending !== null || undefined} onCheckedChange={(on) => void instant.run(writes.kindOn(state, id, on, name))} />
            </label>
          </>
        }
      >
        {isDefault && enabled ? <p className="text-xs text-subtle-foreground">The default kind stays on. Choose another default on the Boxes page to turn it off.</p> : null}
        <RowNote note={instant.note(key) ?? instant.note(defaultKey)} />
      </PageHeader>
      <Group title="Sizes, warm boxes and spares" description="Today's editor for this kind, saved with its Save.">
        <Card className="px-4 pb-4 pt-1 [&>form]:mt-0 [&>form]:border-t-0">
          <KindForm
            key={`${id}-${state.revision}`}
            model={model}
            onSave={(edit) => {
              let draft = withKind(state.document, id, kindChanges(state, id, edit.sizes));
              for (const [backendId, count] of Object.entries(edit.warm)) {
                const backend = draft.backends.find((candidate) => candidate.id === backendId);
                if (!backend) continue;
                const warm = { ...backend.warm };
                if (count > 0) warm[id] = count;
                else delete warm[id];
                draft = withBackend(draft, { ...backend, ...(Object.keys(warm).length ? { warm } : { warm: undefined }) });
              }
              return apply(draft);
            }}
            onClose={nav.back}
          />
        </Card>
      </Group>
    </div>
  );
}

function AtOnceSwitch({ label, description, settingKey, value, disabled, onChange }: { label: string; description?: ReactNode; settingKey: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const { instant } = useSettings();
  const pending = instant.pendingValue<boolean>(settingKey);
  return (
    <div>
      <SettingRow label={label} description={description}>
        <Switch aria-label={label} checked={pending ?? value} disabled={disabled} aria-disabled={instant.pending !== null || undefined} onCheckedChange={onChange} />
        <SavedTick show={instant.isSaved(settingKey)} />
      </SettingRow>
      <RowNote note={instant.note(settingKey)} className="px-4 pb-3" />
    </div>
  );
}

function BoxesOptions() {
  const { state, instant, writes } = useSettings();
  const draft = useDraft(BOXES_PART, "Boxes");
  const general = { ...state.defaults.general, ...state.document.general };
  const defaultKey = switchKey.general("defaultKind");
  const pendingDefault = instant.pendingValue<string>(defaultKey);
  const kindsOn = state.kinds.filter((kind) => effectiveKind(state, kind.id).enabled);
  const choices = kindsOn.some((kind) => kind.id === general.defaultKind) ? kindsOn : [...kindsOn, ...state.kinds.filter((kind) => kind.id === general.defaultKind)];
  const nameOf = (value: unknown) => {
    const info = state.kinds.find((kind) => kind.id === value);
    return info ? kindName(state.kinds, info) : String(value);
  };
  const problem = (path: string) => state.problems.find((candidate) => candidate.path === path)?.message ?? null;
  return (
    <div className="space-y-6">
      <RestoredNote draft={draft} />
      <Card>
        <Rows>
          <div>
            <SettingRow label="Default kind" description="What a thread gets when it does not say." problem={problem("general.defaultKind")}>
              <SavedTick show={instant.isSaved(defaultKey)} />
              <Select value={pendingDefault ?? general.defaultKind} onValueChange={(kind) => void instant.run(writes.general(state, "defaultKind", kind, "The default kind", nameOf))}>
                <SelectTrigger className="h-8 w-56 text-xs" aria-label="Default kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((kind) => (
                    <SelectItem key={kind.id} value={kind.id} className="text-xs">
                      {kindName(state.kinds, kind)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <RowNote note={instant.note(defaultKey)} className="px-4 pb-3" />
          </div>
          <DraftNumberRow draft={draft} path="general/boxesPerThread" label="Boxes per thread" description="The most boxes one thread may hold at once. 0 means no limit." />
          <AtOnceSwitch label="Boxes join BB as machines" description="Threads and terminals can then use a box, with the thread's credentials." settingKey={switchKey.general("enrol")} value={general.enrol} onChange={(on) => void instant.run(writes.general(state, "enrol", on, "Boxes join BB as machines"))} />
          <AtOnceSwitch
            label="Linux desktops as video"
            description="X11 desktops drawn by the CPU show as video: drags follow closely, and it stays smooth on a slow connection. Every viewer can go back with Show as VNC in its menu."
            settingKey={switchKey.general("video")}
            value={general.video}
            onChange={(on) => void instant.run(writes.general(state, "video", on, "Linux desktops as video"))}
          />
        </Rows>
      </Card>
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, ["general/boxesPerThread"])} />
      <BoxFilesSection />
    </div>
  );
}

function ImagesOptions() {
  const { state, instant, writes } = useSettings();
  const general = { ...state.defaults.general, ...state.document.general };
  const projectImages = Object.keys(state.document.images ?? {});
  return (
    <div className="space-y-6">
      <Card>
        <AtOnceSwitch
          label="Rebuild each night"
          description="At 03:00 on BB's server, BB Box rebuilds the standard images that are due, so new boxes have current tools and updates. After a BB update, it refreshes the Linux images within the hour."
          settingKey={switchKey.general("nightlyImages")}
          value={general.nightlyImages}
          onChange={(on) => void instant.run(writes.general(state, "nightlyImages", on, "Rebuild each night"))}
        />
      </Card>
      <Group title="Rebuild now">
        <RebuildNow />
      </Group>
      <Group title="Projects' images" description="Set from a project's files with bb box image set; bb box image lists them.">
        {projectImages.length ? (
          <Card>
            <Rows>
              {projectImages.map((name) => (
                <p key={name} className="px-4 py-2.5 font-mono text-xs text-foreground">
                  {name}
                </p>
              ))}
            </Rows>
          </Card>
        ) : (
          <p className="px-1 text-xs text-subtle-foreground">No project has an image of its own.</p>
        )}
      </Group>
    </div>
  );
}

function DevicesOptions() {
  const { state, nav } = useSettings();
  const general = { ...state.defaults.general, ...state.document.general };
  const deviceKinds = state.kinds.filter((kind) => kind.device);
  const rows: [string, string, string][] = [
    ["iOS video encoding", iosEncoderWords(general.iosEncoder), "general.iosEncoder"],
    ["Share each Mac's encoder fairly", general.encoderLedger ? "On" : "Off", "general.encoderLedger"],
    ["Test device", general.testDevice ? "On" : "Off", "general.testDevice"],
  ];
  return (
    <div className="space-y-6">
      <Card>
        <Rows>
          {rows.map(([label, value, path]) => (
            <SettingRow key={path} label={label} description={<code className="font-mono text-2xs">{path}</code>}>
              <span className="text-sm text-muted-foreground">{value}</span>
            </SettingRow>
          ))}
        </Rows>
      </Card>
      <p className="px-1 text-xs leading-snug text-subtle-foreground">These are not set on this page yet. Change them in the file bb box config show --json prints, then save it with bb box config apply.</p>
      {deviceKinds.length ? (
        <Group title="Spare devices" description="Each device kind's spares are on its own page.">
          <Card>
            <Rows>
              {deviceKinds.map((kind) => (
                <button key={kind.id} type="button" data-row-key={`devices-${kind.id}`} onClick={() => nav.go({ page: "kind", id: kind.id }, `devices-${kind.id}`)} className={`flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-state-hover ${FOCUS_RING}`}>
                  <span className="flex-1">{kindName(state.kinds, kind)}</span>
                  <span className="text-xs text-muted-foreground">{plural(effectiveKind(state, kind.id).spares, "spare")}</span>
                  <Chevron />
                </button>
              ))}
            </Rows>
          </Card>
        </Group>
      ) : null}
    </div>
  );
}

function NetworkOptions() {
  const { state, apply } = useSettings();
  return (
    <TailnetSection
      key={JSON.stringify(state.document.general.tailnet ?? null)}
      tailnet={state.document.general.tailnet}
      problems={state.problems.filter((problem) => problem.path.startsWith("general.tailnet"))}
      save={async (tailnet) => (await apply(withGeneral(state.document, { tailnet: tailnet as ConfigDocument["general"]["tailnet"] }))).saved}
    />
  );
}

function MonitorOptions() {
  const { state, instant, writes } = useSettings();
  const draft = useDraft(MONITOR_PART, "the Monitor");
  const monitor = { ...state.defaults.monitor, ...state.document.monitor };
  const enabledKey = switchKey.monitor("enabled");
  const on = instant.pendingValue<boolean>(enabledKey) ?? monitor.enabled;
  return (
    <div className="space-y-3">
      <RestoredNote draft={draft} />
      <Card>
        <Rows>
          <AtOnceSwitch
            label="Machine status"
            description="Machine status in BB's sidebar footer, for BB's server, your machines and every box. Off, nothing of the Monitor runs: no machine status, sampling, background monitoring or Mac sensors helper."
            settingKey={enabledKey}
            value={monitor.enabled}
            onChange={(enabled) =>
              void instant.run(writes.monitor(state, "enabled", enabled, "Machine status")).then((outcome) => {
                if (outcome?.kind === "saved") noteMonitorChanged();
              })
            }
          />
          <DraftNumberRow draft={draft} path="monitor/refreshIntervalSeconds" label="Refresh every" unit="s" unitWord="seconds" description="Seconds between readings while machine status is open, 2 to 60." disabled={!on} />
          <AtOnceSwitch label="Background monitoring" description="Checks BB's server's CPU and memory every 30 seconds while nobody looks, and keeps logs for bb box monitor logs." settingKey={switchKey.monitor("backgroundMonitoring")} value={monitor.backgroundMonitoring} disabled={!on} onChange={(value) => void instant.run(writes.monitor(state, "backgroundMonitoring", value, "Background monitoring"))} />
          <AtOnceSwitch label="Pressure notifications" description="With background monitoring on, a toast in BB when CPU or memory stays high for a minute, and when it recovers." settingKey={switchKey.monitor("pressureNotifications")} value={monitor.pressureNotifications} disabled={!on} onChange={(value) => void instant.run(writes.monitor(state, "pressureNotifications", value, "Pressure notifications"))} />
        </Rows>
      </Card>
      {monitorChanged() ? <ReloadNote /> : null}
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, ["monitor/refreshIntervalSeconds"])} />
    </div>
  );
}

function ConfigurationOptions() {
  const { state } = useSettings();
  const commands = ["bb box config show", "bb box config show --json > bb-box.json", "bb box config apply bb-box.json", ...(state.migrated ? ["bb box config migrated"] : [])];
  return (
    <div className="space-y-6">
      <Card className="space-y-2 px-4 py-3 text-xs leading-snug text-muted-foreground">
        <p className="text-sm text-foreground">Revision {state.revision}</p>
        <p>Each save names the revision it was made from. When someone saved first, the save is refused and the page reloads, so nobody overwrites another's change unseen.</p>
        {state.migrated ? <p>BB Box keeps a copy of BB's earlier settings for it, made {relativeTime(state.migrated.at, Date.now())}.</p> : null}
      </Card>
      <Group title="From a terminal" description="Agents and scripts change the configuration with these. The JSON file has no secret in it.">
        <Card className="space-y-1.5 px-4 py-3">
          {commands.map((command) => (
            <code key={command} className="block font-mono text-xs text-foreground">
              {command}
            </code>
          ))}
        </Card>
      </Group>
    </div>
  );
}

const OPTION_TITLES: Readonly<Record<string, string>> = { boxes: "Boxes", images: "Images", devices: "Devices", network: "Network", monitor: "Monitor", configuration: "Configuration" };

const OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  boxes: "What a thread gets, how many, and what every box has.",
  images: "The images new boxes start from.",
  devices: "iOS and Android devices in boxes.",
  network: "How machines BB Box makes reach BB.",
  monitor: "Machine status in BB's sidebar.",
  configuration: "The configuration as one file, and its revisions.",
};

export function optionTitle(id: string): string {
  return OPTION_TITLES[id] ?? id;
}

export function OptionPage({ id }: { id: string }) {
  if (!isOptionPage(id)) return <NotHere what="page" />;
  return (
    <div className="space-y-6">
      <PageHeader title={optionTitle(id)} description={<><p>{OPTION_DESCRIPTIONS[id]}</p>{id === "boxes" || id === "images" || id === "monitor" ? <p className="mt-1">{SAVING_RULE}</p> : null}</>} />
      {id === "boxes" ? <BoxesOptions /> : null}
      {id === "images" ? <ImagesOptions /> : null}
      {id === "devices" ? <DevicesOptions /> : null}
      {id === "network" ? <NetworkOptions /> : null}
      {id === "monitor" ? <MonitorOptions /> : null}
      {id === "configuration" ? <ConfigurationOptions /> : null}
    </div>
  );
}

export function viewTitle(state: ReturnType<typeof useSettings>["state"], view: SettingsView): string {
  switch (view.page) {
    case "overview":
      return "BB Box settings";
    case "backend": {
      const config = state.document.backends.find((backend) => backend.id === view.id);
      return config ? backendLabel(state, config) : "Not here";
    }
    case "kind": {
      const info = state.kinds.find((kind) => kind.id === view.id);
      return info ? kindName(state.kinds, info) : "Not here";
    }
    case "option":
      return isOptionPage(view.id) ? optionTitle(view.id) : "Not here";
    case "add":
      return "Add a backend";
    case "setup": {
      const driver = state.drivers.find((candidate) => candidate.type === view.type);
      return driver ? `Set up ${driver.label}` : "Not here";
    }
  }
}

export function viewPage(view: SettingsView): ReactNode {
  switch (view.page) {
    case "overview":
      return null;
    case "backend":
      return <BackendPage id={view.id} />;
    case "kind":
      return <KindPage id={view.id} />;
    case "option":
      return <OptionPage id={view.id} />;
    case "add":
      return <AddBackendPage />;
    case "setup":
      return <SetupPage type={view.type} />;
  }
}

export function TopRow() {
  const { state, nav } = useSettings();
  const { view, cameFrom } = nav;
  if (view.page === "overview") return null;
  const back = cameFrom && cameFrom.page !== "overview" ? cameFrom : null;
  return (
    <nav aria-label="Where you are" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {back ? (
        <>
          <button type="button" onClick={nav.back} className={`-ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-muted-foreground hover:text-foreground ${FOCUS_RING}`}>
            <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
            Back to {viewTitle(state, back)}
          </button>
          <span className="text-subtle-foreground" aria-hidden>
            ·
          </span>
        </>
      ) : null}
      <button type="button" onClick={nav.toOverview} className={`inline-flex cursor-pointer items-center gap-0.5 rounded-sm text-muted-foreground hover:text-foreground ${back ? "" : "-ml-1 px-1"} ${FOCUS_RING}`}>
        {back ? null : <Icon name="ChevronLeft" className="size-3.5" aria-hidden />}
        BB Box settings
      </button>
      <span className="text-subtle-foreground" aria-hidden>
        ›
      </span>
      <span aria-current="page" className="min-w-0 truncate text-foreground">
        {viewTitle(state, view)}
      </span>
    </nav>
  );
}
