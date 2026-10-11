// bb-box's settings page: your machines (036), then the configuration
// (029): the backends with their switches and setup, the kinds with their
// sizes, and the general settings, all one checked document the page reads
// with config.get and writes with config.apply.
// The design is in docs/design/settings.md.

import { useRpc } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { BackendConfig, ConfigDocument, Problem } from "../core/document.ts";
import type { ConfigState, Contract } from "../plugin/contract.ts";
import { EmptyPanel, message, relativeTime, useLive } from "./common.tsx";
import { effectiveKind, inheritSource, kindChanges, sourceName, withBackend, withGeneral, withKind } from "./config.ts";
import { BackendForm, BackendRow, backendId, type BackendRowModel } from "./settings-backends.tsx";
import { Section } from "./settings-fields.tsx";
import { KindForm, KindRow, kindRowModel } from "./settings-kinds.tsx";
import { DockerHostsSection } from "./settings-docker-hosts.tsx";
import { BoxFilesSection } from "./settings-files.tsx";
import { MachinesSection } from "./settings-machines.tsx";

const STALE = "Someone saved the configuration first. It has been reloaded; make your change again.";

/** What a write came to: saved, and the problems left, which refused it when it was not saved. */
export interface Saved {
  readonly saved: boolean;
  readonly problems: readonly Problem[];
}

function GeneralRow({ label, description, children, problem }: { label: string; description?: string; children: ReactNode; problem?: string | null }) {
  return (
    <div className="flex items-start justify-between gap-5 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-foreground">{label}</p>
        {description ? <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">{description}</p> : null}
        {problem ? (
          <p role="alert" className="mt-0.5 text-xs text-destructive-text">
            {problem}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}

export function SettingsSection() {
  const rpc = useRpc<Contract>();
  const { value: state, error, refresh } = useLive<ConfigState>("config", () => rpc.call("config.get"), () => true);
  const [openBackend, setOpenBackend] = useState<string | null>(null);
  const [openKind, setOpenKind] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [boxesPerThread, setBoxesPerThread] = useState<string | null>(null);

  /**
   * Saves a document as the whole configuration. `saved` with problems means
   * it was saved anyway: a backend that is off and has no boxes may be saved
   * part way, and the problems say what is still missing.
   */
  const apply = async (draft: ConfigDocument): Promise<Saved> => {
    if (!state) return { saved: false, problems: [] };
    try {
      const result = await rpc.call("config.apply", { draft, revision: state.revision });
      if (result.ok) {
        setNotice(null);
        await refresh();
        return { saved: true, problems: result.problems };
      }
      if (result.reason === "revision") {
        setNotice(STALE);
        await refresh();
        return { saved: false, problems: [{ path: "", message: STALE }] };
      }
      return { saved: false, problems: result.problems };
    } catch (caught) {
      return { saved: false, problems: [{ path: "", message: message(caught) }] };
    }
  };
  /** A change applied at once, such as a switch; a refusal shows at the top of the page. */
  const applyNow = async (key: string, draft: ConfigDocument): Promise<void> => {
    setBusy(key);
    try {
      const { saved, problems } = await apply(draft);
      setNotice(!saved && problems.length ? problems.map((problem) => problem.message).join(" ") : null);
    } finally {
      setBusy(null);
    }
  };

  if (error) {
    return <EmptyPanel role="alert">{error}</EmptyPanel>;
  }
  if (!state) return null;

  const { document } = state;
  // The backend a driver's empty fields take from, and how the page names it.
  const lending = (source: BackendConfig | null) => ({
    source,
    sourceName: source ? sourceName(document, source, state.drivers.find((driver) => driver.type === source.type)?.label ?? source.type) : null,
  });
  const backends: BackendRowModel[] = [
    // Docker on a BB machine has its row under "Docker on BB machines" (042), not a card here.
    ...document.backends.filter((config) => !(config.type === "docker" && typeof config.fields.host === "string" && config.fields.host.startsWith("bb:"))).map((config) => ({
      driver: state.drivers.find((driver) => driver.type === config.type)!,
      config,
      ...lending(inheritSource(document, state.drivers.find((driver) => driver.type === config.type)?.fields ?? [], config.id)),
      state: state.backends.find((candidate) => candidate.id === config.id) ?? null,
      problems: state.problems.filter((problem) => problem.path === `backends.${config.id}` || problem.path.startsWith(`backends.${config.id}.`)),
    })),
    ...state.drivers
      .filter((driver) => !document.backends.some((config) => config.type === driver.type))
      .map((driver) => ({ driver, config: null, ...lending(inheritSource(document, driver.fields, driver.type)), state: null, problems: [] })),
  ].filter((model) => model.driver);
  const general = { ...state.defaults.general, ...document.general };
  const kindsOn = state.kinds.filter((kind) => effectiveKind(state, kind.id).enabled);

  return (
    <div className="space-y-6">
      {notice ? (
        <p role="alert" className="rounded-md border border-warning/40 bg-surface-recessed px-3 py-2 text-xs leading-snug text-warning-text">
          {notice}
        </p>
      ) : null}
      <MachinesSection />
      <Section title="Backends" description="Where boxes come from.">
        {backends.map((model) => {
          const id = backendId(model);
          return (
            <BackendRow
              key={id}
              model={model}
              open={openBackend === id}
              onToggle={() => setOpenBackend((current) => (current === id ? null : id))}
              switching={busy === id}
              onSwitch={(on) => {
                const entry: BackendConfig = model.config ?? { id, type: model.driver.type, enabled: false, fields: {} };
                if (!model.config && on) {
                  // Nothing is set yet, so the switch opens the setup instead.
                  setOpenBackend(id);
                  return;
                }
                void applyNow(id, withBackend(document, { ...entry, enabled: on })).then(() => {
                  if (on && (model.state?.state === "misconfigured" || model.problems.length)) setOpenBackend(id);
                });
              }}
            >
              <BackendForm
                key={`${id}-${state.revision}`}
                model={model}
                onSave={(config) => apply(withBackend(document, config))}
                onCheck={async (config) => {
                  try {
                    return await rpc.call("config.check", { draft: withBackend(document, config), test: config.id });
                  } catch (caught) {
                    return { problems: [{ path: `backends.${config.id}`, message: message(caught) }], doctor: null };
                  }
                }}
                onClose={() => setOpenBackend(null)}
              />
            </BackendRow>
          );
        })}
      </Section>
      <DockerHostsSection />
      <Section title="Kinds" description="A kind is offered when it is on and a backend that is on has it.">
        {state.kinds.map((info) => {
          const sizes = effectiveKind(state, info.id);
          const model = kindRowModel(state, info, sizes);
          return (
            <KindRow
              key={info.id}
              model={model}
              open={openKind === info.id}
              onToggle={() => setOpenKind((current) => (current === info.id ? null : info.id))}
              switching={busy === `kind:${info.id}`}
              onSwitch={(on) => void applyNow(`kind:${info.id}`, withKind(document, info.id, kindChanges(state, info.id, { ...sizes, enabled: on })))}
            >
              <KindForm
                key={`${info.id}-${state.revision}`}
                model={model}
                onSave={(edit) => {
                  let draft = withKind(document, info.id, kindChanges(state, info.id, edit.sizes));
                  for (const [backendId, count] of Object.entries(edit.warm)) {
                    const backend = draft.backends.find((candidate) => candidate.id === backendId);
                    if (!backend) continue;
                    const warm = { ...backend.warm };
                    if (count > 0) warm[info.id] = count;
                    else delete warm[info.id];
                    draft = withBackend(draft, { ...backend, ...(Object.keys(warm).length ? { warm } : { warm: undefined }) });
                  }
                  return apply(draft);
                }}
                onClose={() => setOpenKind(null)}
              />
            </KindRow>
          );
        })}
      </Section>
      <Section title="General">
        <GeneralRow label="Default kind" description="What a thread gets when it does not say." problem={state.problems.find((problem) => problem.path === "general.defaultKind")?.message}>
          <Select value={general.defaultKind} onValueChange={(kind) => void applyNow("general", withGeneral(document, { defaultKind: kind === state.defaults.general.defaultKind ? undefined : kind }))}>
            <SelectTrigger className="h-8 w-48 text-xs" aria-label="Default kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(kindsOn.some((kind) => kind.id === general.defaultKind) ? kindsOn : [...kindsOn, ...state.kinds.filter((kind) => kind.id === general.defaultKind)]).map((kind) => (
                <SelectItem key={kind.id} value={kind.id} className="text-xs">
                  {kind.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </GeneralRow>
        <GeneralRow label="Boxes per thread" description="0 means no limit." problem={state.problems.find((problem) => problem.path === "general.boxesPerThread")?.message}>
          <Input
            className="h-8 w-20 text-xs"
            inputMode="numeric"
            aria-label="Boxes per thread"
            value={boxesPerThread ?? String(general.boxesPerThread)}
            onChange={(event) => setBoxesPerThread(event.target.value)}
            onBlur={() => {
              if (boxesPerThread === null) return;
              const count = Number(boxesPerThread.trim() || "0");
              setBoxesPerThread(null);
              if (!Number.isFinite(count) || count === general.boxesPerThread) return;
              void applyNow("general", withGeneral(document, { boxesPerThread: count === state.defaults.general.boxesPerThread ? undefined : count }));
            }}
          />
        </GeneralRow>
        <GeneralRow label="Enrol boxes as BB machines" description="Threads and terminals can then use a box, with the thread's credentials.">
          <Switch aria-label="Enrol boxes as BB machines" checked={general.enrol} disabled={busy === "general"} onCheckedChange={(enrol) => void applyNow("general", withGeneral(document, { enrol: enrol === state.defaults.general.enrol ? undefined : enrol }))} />
        </GeneralRow>
        <GeneralRow
          label="Linux desktops as video"
          description="X11 desktops drawn by the CPU show as video: drags follow closely, and it stays smooth on a slow connection. Every viewer can go back with Show as VNC in its menu."
        >
          <Switch aria-label="Linux desktops as video" checked={general.video} disabled={busy === "general"} onCheckedChange={(video) => void applyNow("general", withGeneral(document, { video: video === state.defaults.general.video ? undefined : video }))} />
        </GeneralRow>
      </Section>
      <BoxFilesSection
        files={document.general.files ?? []}
        problems={state.problems.filter((problem) => problem.path.startsWith("general.files"))}
        save={async (files) => (await apply(withGeneral(document, { files: files.length ? files : undefined }))).saved}
      />
    </div>
  );
}
