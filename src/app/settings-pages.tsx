import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { snapshotConfig, type BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { DriverView } from "../plugin/configuration.ts";
import { PRODUCT } from "./product.ts";
import { effectiveKind, inheritSource, sourceName, withBackend } from "./config.ts";
import { switchKey, useSettings } from "./settings-context.tsx";
import { ImagesPage } from "./settings-images.tsx";
import { DraftNumberRow, unplacedProblems } from "./settings-draft-fields.tsx";
import { BOXES_PART, MONITOR_PART } from "./settings-drafts.ts";
import { BoxFilesSection } from "./settings-files.tsx";
import { RestoredNote, SAVING_RULE, SaveBar, useDraft } from "./settings-saving.tsx";
import { BackendPage } from "./settings-backend-page.tsx";
import { ConfigurationOptions } from "./settings-configuration.tsx";
import { AddBackendPage, SetupPage } from "./settings-setup.tsx";
import { KindPage } from "./settings-kind-page.tsx";
import { iosEncoderWords, monitorChanged, noteMonitorChanged, ReloadNote } from "./settings-overview.tsx";
import { Card, Chevron, FOCUS_RING, Group, NavRow, NotHere, PageHeader, ProviderGlyph, RowNote, Rows, SavedTick, SettingRow } from "./settings-parts.tsx";
import { isOptionPage, type SettingsView } from "./settings-route.ts";
import { sharedIosFieldOf } from "./settings-kinds.tsx";
import { backendFieldPath, snapshotPath } from "./settings-paths.ts";
import { backendLabel, isMachineDocker, kindName, plural } from "./settings-status.ts";
import { NetworkOptions } from "./settings-tailnet.tsx";
import { FindSettings } from "./settings-find.tsx";
import { AGENTS_MEMORY_LABEL, AGENTS_RESTORE_LABEL, SnapshotsOptions } from "./settings-snapshots.tsx";

function AtOnceSwitch({ label, description, settingKey, path, value, disabled, onChange }: { label: string; description?: ReactNode; settingKey: string; path: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  const { instant } = useSettings();
  const pending = instant.pendingValue<boolean>(settingKey);
  return (
    <div>
      <SettingRow label={label} description={description} path={path}>
        <SavedTick show={instant.isSaved(settingKey)} />
        <Switch data-draft-path={path} aria-label={label} checked={pending ?? value} disabled={disabled} aria-disabled={instant.pending !== null || undefined} onCheckedChange={onChange} />
      </SettingRow>
      <RowNote note={instant.note(settingKey)} className="px-4 pb-3" />
    </div>
  );
}

function SnapshotPicturesSwitch() {
  const { state, instant, writes } = useSettings();
  return (
    <AtOnceSwitch
      label="Keep a picture of the screen with each snapshot"
      description={`A small picture of a desktop's or a device's screen, taken as each snapshot is taken, so you can tell them apart by sight. It shows whatever was on the screen then. It is kept in ${PRODUCT}'s own records with its snapshot, never on the provider or in the box, and goes with it. Boxes without a screen have none.`}
      settingKey={switchKey.snapshots("pictures")}
      path={snapshotPath("pictures")}
      value={snapshotConfig(state.document).pictures}
      onChange={(on) => void instant.run(writes.snapshots(state, "pictures", on, "Pictures of the screen"))}
    />
  );
}

function BoxesOptions() {
  const defaultKindProblemId = useId();
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
  const defaultKindProblem = problem("general.defaultKind");
  return (
    <div className="space-y-6">
      <RestoredNote draft={draft} />
      <Card>
        <Rows>
          <div>
            <SettingRow label="Default kind" description="What a thread gets when it does not say." problem={defaultKindProblem} problemId={defaultKindProblem ? defaultKindProblemId : undefined} path="general/defaultKind">
              <SavedTick show={instant.isSaved(defaultKey)} />
              <Select value={pendingDefault ?? general.defaultKind} onValueChange={(kind) => void instant.run(writes.general(state, "defaultKind", kind, "The default kind", nameOf))}>
                <SelectTrigger className="h-8 w-56 text-xs" aria-label="Default kind" aria-describedby={defaultKindProblem ? defaultKindProblemId : undefined} data-draft-path="general/defaultKind">
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
          <AtOnceSwitch label="Boxes join BB as machines" description="Threads and terminals can then use a box, with the thread's credentials." settingKey={switchKey.general("enrol")} path="general/enrol" value={general.enrol} onChange={(on) => void instant.run(writes.general(state, "enrol", on, "Boxes join BB as machines"))} />
          <AtOnceSwitch
            label="Linux desktops as video"
            description="X11 desktops drawn by the CPU show as video: drags follow closely, and it stays smooth on a slow connection. Every viewer can go back with Show as VNC in its menu."
            settingKey={switchKey.general("video")}
            path="general/video"
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

function AgentsSnapshotSwitches() {
  const { state, instant, writes } = useSettings();
  const stored = snapshotConfig(state.document);
  return (
    <>
      <AtOnceSwitch
        label={AGENTS_RESTORE_LABEL}
        description="An agent restores its thread's own boxes without asking, always taking an undo first. Off, it asks for a yes in its thread through a form. A box threads run on, or one of your machines, always needs that yes."
        settingKey={switchKey.snapshots("agentsRestore")}
        path={snapshotPath("agentsRestore")}
        value={stored.agentsRestore}
        onChange={(on) => void instant.run(writes.snapshots(state, "agentsRestore", on, AGENTS_RESTORE_LABEL))}
      />
      <AtOnceSwitch
        label={AGENTS_MEMORY_LABEL}
        description="A memory snapshot brings back the box's running apps, with the credentials they held then. Off, only you restore one."
        settingKey={switchKey.snapshots("agentsMemory")}
        path={snapshotPath("agentsMemory")}
        value={stored.agentsMemory}
        onChange={(on) => void instant.run(writes.snapshots(state, "agentsMemory", on, AGENTS_MEMORY_LABEL))}
      />
    </>
  );
}

function ImagesOptions() {
  const { state, instant, writes } = useSettings();
  const general = { ...state.defaults.general, ...state.document.general };
  return (
    <ImagesPage
      nightly={
        <AtOnceSwitch
          label="Rebuild each night"
          description="At 03:00 on BB's server, BB Box rebuilds the standard images that are due, and replaces each only when its trial box passes. After a BB update, it refreshes the Linux images within the hour."
          settingKey={switchKey.general("nightlyImages")}
          path="general/nightlyImages"
          value={general.nightlyImages}
          onChange={(on) => void instant.run(writes.general(state, "nightlyImages", on, "Rebuild each night"))}
        />
      }
    />
  );
}

const IOS_ENCODER_CHOICES: readonly (readonly ["auto" | "hardware" | "software", string])[] = [
  ["auto", "Automatic"],
  ["hardware", "Hardware only"],
  ["software", "Software only"],
];

function hasSharedIosHosts(state: ReturnType<typeof useSettings>["state"], config: BackendConfig): boolean {
  return state.drivers.some((driver) => driver.type === config.type && driver.fields.some((field) => field.group === "ios-hosts"));
}

function DevicesOptions() {
  const encoderProblemId = useId();
  const { state, nav, instant, writes } = useSettings();
  const general = { ...state.defaults.general, ...state.document.general };
  const encoderKey = switchKey.general("iosEncoder");
  const sharing = state.document.backends.filter((config) => !isMachineDocker(config) && hasSharedIosHosts(state, config));
  const deviceKinds = state.kinds.filter((kind) => kind.device);
  const encoderProblem = state.problems.find((problem) => problem.path === "general.iosEncoder")?.message ?? null;
  return (
    <div className="space-y-6">
      <Group title="Streaming">
        <Card>
          <Rows>
            <div>
              <SettingRow label="iOS video encoding" description="Automatic uses a Mac's hardware encoder, and software where it has none or its encoder fails. A box takes a change when its device server is next delivered." problem={encoderProblem} problemId={encoderProblem ? encoderProblemId : undefined} path="general/iosEncoder">
                <SavedTick show={instant.isSaved(encoderKey)} />
                <Select value={instant.pendingValue<string>(encoderKey) ?? general.iosEncoder} onValueChange={(choice) => void instant.run(writes.general(state, "iosEncoder", choice, "iOS video encoding", (value) => iosEncoderWords(String(value))))}>
                  <SelectTrigger className="h-8 w-full text-xs sm:w-44" aria-label="iOS video encoding" aria-describedby={encoderProblem ? encoderProblemId : undefined} data-draft-path="general/iosEncoder">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IOS_ENCODER_CHOICES.map(([choice, words]) => (
                      <SelectItem key={choice} value={choice} className="text-xs">
                        {words}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
              <RowNote note={instant.note(encoderKey)} className="px-4 pb-3" />
            </div>
            <AtOnceSwitch
              label="Share each Mac's encoder fairly"
              description="The person in control of a device streams at full size first; recordings, other viewers and agents share what is left, at a lower size. Off, every shared iOS stream is capped at two thirds."
              settingKey={switchKey.general("encoderLedger")}
              path="general/encoderLedger"
              value={general.encoderLedger}
              onChange={(on) => void instant.run(writes.general(state, "encoderLedger", on, "Sharing each Mac's encoder"))}
            />
          </Rows>
        </Card>
      </Group>
      {sharing.length || deviceKinds.length ? (
        <Group title="Set on other pages" description="Spares of device boxes are off unless you set a number: each waits with its device booted and its memory saved to disk, which takes up to as much disk as the box's memory.">
          <Card>
            <Rows>
              {sharing.map((config) => (
                <NavRow
                  key={config.id}
                  rowKey={`devices-hosts-${config.id}`}
                  valueId={`settings-devices-hosts-${config.id}`}
                  icon={<ProviderGlyph type={config.type} />}
                  title={`Shared iOS hosts on ${backendLabel(state, config)}`}
                  value="On its page"
                  onClick={() => {
                    const field = sharedIosFieldOf(state.drivers.find((driver) => driver.type === config.type));
                    nav.go({ page: "backend", id: config.id }, `devices-hosts-${config.id}`, field ? backendFieldPath(config.id, field) : undefined);
                  }}
                />
              ))}
              {deviceKinds.map((kind) => {
                const spares = effectiveKind(state, kind.id).spares;
                return (
                  <NavRow
                    key={kind.id}
                    rowKey={`devices-${kind.id}`}
                    valueId={`settings-devices-${kind.id}`}
                    icon={<Icon name="bb-box/phone" className="size-4" aria-hidden />}
                    title={`Spare ${kindName(state.kinds, kind)} boxes`}
                    value={spares ? plural(spares, "spare") : "None, as by default"}
                    onClick={() => nav.go({ page: "kind", id: kind.id }, `devices-${kind.id}`)}
                  />
                );
              })}
            </Rows>
          </Card>
        </Group>
      ) : null}
      <Group title="For testing">
        <Card>
          <AtOnceSwitch
            label="Test device"
            description="Linux and macOS boxes offer a test card in place of a phone, to check the device path without a simulator or emulator."
            settingKey={switchKey.general("testDevice")}
            path="general/testDevice"
            value={general.testDevice}
            onChange={(on) => void instant.run(writes.general(state, "testDevice", on, "The test device"))}
          />
        </Card>
      </Group>
    </div>
  );
}

function useHistoryFull(revision: number): string | null {
  const rpc = useRpc<Contract>();
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    rpc.call("monitor.state", null).then(
      (state) => {
        if (current) setFull(state.historyFull);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [rpc, revision]);
  return full;
}

function MonitorOptions() {
  const { state, instant, writes } = useSettings();
  const historyFull = useHistoryFull(state.document.revision);
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
            description="Machine status in BB's sidebar footer, for BB's server, your machines and every box. Off, nothing of the Monitor runs: no machine status, sampling, background monitoring, box history or Mac sensors helper."
            settingKey={enabledKey}
            path="monitor/enabled"
            value={monitor.enabled}
            onChange={(enabled) =>
              void instant.run(writes.monitor(state, "enabled", enabled, "Machine status")).then((outcome) => {
                if (outcome?.kind === "saved") noteMonitorChanged();
              })
            }
          />
          <DraftNumberRow draft={draft} path="monitor/refreshIntervalSeconds" label="Refresh every" unit="s" unitWord="seconds" description="Seconds between readings while machine status is open, 2 to 60." disabled={!on} />
          <AtOnceSwitch label="Background monitoring" description="Checks BB's server's CPU and memory every 30 seconds while nobody looks, and keeps logs for bb box monitor logs." settingKey={switchKey.monitor("backgroundMonitoring")} path="monitor/backgroundMonitoring" value={monitor.backgroundMonitoring} disabled={!on} onChange={(value) => void instant.run(writes.monitor(state, "backgroundMonitoring", value, "Background monitoring"))} />
          <AtOnceSwitch label="Pressure notifications" description="With background monitoring on, a toast in BB when CPU or memory stays high for a minute, and when it recovers." settingKey={switchKey.monitor("pressureNotifications")} path="monitor/pressureNotifications" value={monitor.pressureNotifications} disabled={!on} onChange={(value) => void instant.run(writes.monitor(state, "pressureNotifications", value, "Pressure notifications"))} />
          <AtOnceSwitch
            label="Keep each box's history"
            description="Reads every running box once a minute, lightly, and keeps 24 hours by the minute and 7 days by the hour, for the 1 h, 24 h and 7 d of a box's page. Off, nothing is read in the background; a box's page still reads it live while open, and what was kept stays until it ages out."
            settingKey={switchKey.monitor("boxHistory")}
            path="monitor/boxHistory"
            value={monitor.boxHistory}
            disabled={!on}
            onChange={(value) => void instant.run(writes.monitor(state, "boxHistory", value, "Keep each box's history"))}
          />
        </Rows>
      </Card>
      {historyFull ? (
        <p role="status" data-history-full className="rounded-lg border border-surface-warning-border px-4 py-3 text-xs text-warning-text">
          {historyFull}
        </p>
      ) : null}
      {monitorChanged() ? <ReloadNote /> : null}
      <SaveBar draft={draft} unplaced={unplacedProblems(draft, ["monitor/refreshIntervalSeconds"])} />
    </div>
  );
}

const OPTION_TITLES: Readonly<Record<string, string>> = { boxes: "Boxes", images: "Images", snapshots: "Snapshots", devices: "Devices", network: "Network", monitor: "Monitor", configuration: "Configuration" };

const OPTION_DESCRIPTIONS: Readonly<Record<string, string>> = {
  boxes: "What a thread gets, how many, and what every box has.",
  images: "What new boxes start from: BB Box's standard images, and your projects' own.",
  snapshots: "How many snapshots a box holds, how full a host's storage may get, and what paid snapshots may cost.",
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
      <PageHeader title={optionTitle(id)} description={<><p>{OPTION_DESCRIPTIONS[id]}</p>{id === "boxes" || id === "images" || id === "snapshots" || id === "network" || id === "monitor" ? <p className="mt-1">{SAVING_RULE}</p> : null}</>} />
      {id === "boxes" ? <BoxesOptions /> : null}
      {id === "images" ? <ImagesOptions /> : null}
      {id === "snapshots" ? <SnapshotsOptions agents={<AgentsSnapshotSwitches />} pictures={<SnapshotPicturesSwitch />} /> : null}
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
  if (view.page === "overview") return <FindSettings wide />;
  const back = cameFrom && cameFrom.page !== "overview" ? cameFrom : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <nav aria-label="Where you are" className="flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
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
      <FindSettings />
    </div>
  );
}
