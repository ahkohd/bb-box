import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { BUILD_STEPS, relative, useStore } from "./store";
import { DOCKER_MACHINES, kindOf, type BackendConfig } from "./data";
import { backendState, defaultSize, KIND_GROUPS, kindBadges, kindTitle, offering, plural, qualifierOf, sizeWords, warmTotal } from "./model";
import { useNav } from "./nav";
import { Badge, Card, Chevron, Icon, NavRow, ProviderGlyph, Rows, SavedTick, Section, StateLine, useInstant } from "./ui";
import { driverOf } from "./data";
import { FindField, FindResults } from "./find";

export function Overview() {
  const store = useStore();
  const [query, setQuery] = useState("");
  const empty = !store.doc.backends.length;
  return (
    <div className="space-y-7">
      <FindField query={query} onQuery={setQuery} />
      {query.trim() ? (
        <FindResults query={query} />
      ) : (
        <>
          {empty ? <FirstRun /> : <Status />}
          {empty ? null : <Backends />}
          <Kinds />
          <Options />
        </>
      )}
    </div>
  );
}

function Status() {
  const store = useStore();
  const nav = useNav();
  const on = store.doc.backends.filter((backend) => backend.enabled);
  const states = on.map((backend) => ({ backend, state: backendState(backend, store.live[backend.id]) }));
  const troubled = states.filter(({ state }) => state.problem);
  const checked = Math.max(0, ...on.map((backend) => store.live[backend.id]?.health?.checkedAt ?? 0));
  const kinds = new Set(on.flatMap((backend) => store.live[backend.id]?.offers ?? []).filter((kind) => store.doc.kinds[kind]?.enabled)).size;
  const off = store.doc.backends.length - on.length;
  if (store.checkingAll) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <StatusDot tone="busy" />
        Checking {plural(on.length, "backend")}… up to 30 s each, side by side.
      </div>
    );
  }
  if (!troubled.length) {
    return (
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2 text-sm text-foreground">
          <StatusDot tone="ok" />
          <span>
            All {plural(on.length, "backend")} ready
            <span className="text-muted-foreground">
              {" "}
              {off ? `· ${off} off ` : ""}· {plural(kinds, "kind")} on offer · checked {relative(checked)}
            </span>
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void store.checkAll()}>
          Check all
        </Button>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-surface-warning-border bg-surface-warning px-4 py-3" role="alert">
      <div className="flex items-center gap-3">
        <p className="min-w-0 flex-1 text-sm font-medium text-foreground">{troubled.length === 1 ? "1 backend needs you" : `${troubled.length} backends need you`}</p>
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => void store.checkAll()}>
          Check all again
        </Button>
      </div>
      <ul className="mt-2 space-y-2.5">
        {troubled.map(({ backend, state }) => (
          <li key={backend.id} className="flex items-start gap-3">
            <StatusDot tone={state.tone} className="text-sm" />
            <div className="min-w-0 flex-1 text-xs leading-snug">
              <p className="text-foreground">
                <span className="font-medium">{driverOf(backend.type).label}{qualifierOf(backend, store.live[backend.id]) ? ` on ${qualifierOf(backend, store.live[backend.id])}` : ""}</span>
                <span className="text-muted-foreground">: {state.problem?.detail}</span>
              </p>
              {state.problem?.fix ? <p className="mt-0.5 text-muted-foreground">Fix: {state.problem.fix}</p> : null}
            </div>
            <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={() => nav.go({ page: "backend", id: backend.id })}>
              Open
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BackendRow({ backend, instant }: { backend: BackendConfig; instant: ReturnType<typeof useInstant> }) {
  const store = useStore();
  const nav = useNav();
  const live = store.live[backend.id];
  const state = backendState(backend, live);
  const driver = driverOf(backend.type);
  const qualifier = qualifierOf(backend, live);
  const open = () => nav.go({ page: "backend", id: backend.id });
  const refused = instant.refused?.key === backend.id ? instant.refused.message : null;
  return (
    <div className="group flex items-center gap-3 px-4 py-3 transition-colors duration-150 hover:bg-state-hover">
      <button type="button" onClick={open} className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left focus-visible:outline-none">
        <ProviderGlyph type={backend.type} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
            {driver.label}
            {qualifier ? <Badge>{qualifier}</Badge> : null}
            {live?.bbMachine ? <Badge>BB machine</Badge> : null}
          </span>
          <StateLine className="mt-0.5" tone={state.tone} words={state.words} items={state.items} />
          {refused ? <span className="mt-1 block text-xs leading-snug text-destructive-text">{refused}</span> : null}
        </span>
      </button>
      <SavedTick show={instant.saved === backend.id} />
      <Switch
        aria-label={`${driver.label}${qualifier ? ` on ${qualifier}` : ""} on`}
        checked={backend.enabled}
        disabled={instant.pending === backend.id}
        onCheckedChange={(enabled) => void instant.run(backend.id, `backends.${backend.id}`, (doc) => ({ ...doc, backends: doc.backends.map((each) => (each.id === backend.id ? { ...each, enabled } : each)) }))}
      />
      <button type="button" tabIndex={-1} aria-hidden onClick={open} className="cursor-pointer">
        <Chevron />
      </button>
    </div>
  );
}

function Backends() {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const spare = DOCKER_MACHINES.filter((machine) => machine.docker && !store.doc.backends.some((backend) => backend.fields.host === `bb:${machine.id}`));
  return (
    <Section
      title="Backends"
      description="Where boxes run. A backend that is off takes no new boxes; its boxes keep working."
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => nav.go({ page: "add" })}>
          <Icon name="Plus" aria-hidden />
          Add backend
        </Button>
      }
    >
      <Card>
        <Rows>
          {store.doc.backends.map((backend) => (
            <BackendRow key={backend.id} backend={backend} instant={instant} />
          ))}
        </Rows>
      </Card>
      {spare.length ? (
        <p className="px-1 text-xs text-subtle-foreground">
          {spare.map((machine) => machine.name).join(" and ")} {spare.length === 1 ? "has" : "have"} Docker and could host boxes.{" "}
          <button type="button" className="cursor-pointer text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => nav.go({ page: "add" })}>
            Add {spare.length === 1 ? "it" : "one"}
          </button>
        </p>
      ) : null}
    </Section>
  );
}

function KindRow({ id, instant }: { id: string; instant: ReturnType<typeof useInstant> }) {
  const store = useStore();
  const nav = useNav();
  const kind = store.doc.kinds[id]!;
  const from = offering(store.doc, store.live, id);
  const warm = warmTotal(store.doc, id);
  const isDefault = store.doc.general.defaultKind === id;
  const notOffered = kind.enabled && !from.length;
  const open = () => nav.go({ page: "kind", id });
  const refused = instant.refused?.key === id ? instant.refused.message : null;
  const items = kind.enabled
    ? [sizeWords(defaultSize(kind)), from.length ? plural(from.length, "backend") : null, warm ? `${warm} warm` : null, kind.spares ? plural(kind.spares, "spare") : null].filter((item): item is string => item !== null)
    : ["no new boxes"];
  return (
    <div className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-state-hover">
      <button type="button" onClick={open} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left focus-visible:outline-none">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <span className="flex shrink-0 items-center gap-1.5 text-sm text-foreground">
              {kindTitle(id)}
              {kindBadges(id).map((badge) => (
                <Badge key={badge}>{badge}</Badge>
              ))}
              {isDefault ? <Badge>Default</Badge> : null}
            </span>
            <span className={cn("min-w-0 flex-1 truncate text-xs sm:text-right", notOffered ? "text-warning-text" : "text-muted-foreground")}>{notOffered ? "Not offered: no backend can make it now" : kind.enabled ? items.join(" · ") : "Off"}</span>
          </span>
          {refused ? <span className="block text-xs text-destructive-text">{refused}</span> : null}
        </span>
      </button>
      <SavedTick show={instant.saved === id} />
      <Switch aria-label={`${kindTitle(id)} on`} checked={kind.enabled} disabled={instant.pending === id} onCheckedChange={(enabled) => void instant.run(id, `kinds.${id}`, (doc) => ({ ...doc, kinds: { ...doc.kinds, [id]: { ...doc.kinds[id]!, enabled } } }))} />
      <button type="button" tabIndex={-1} aria-hidden onClick={open} className="cursor-pointer">
        <Chevron />
      </button>
    </div>
  );
}

function Kinds() {
  const store = useStore();
  const instant = useInstant();
  const [showOff, setShowOff] = useState(false);
  const empty = !store.doc.backends.length;
  const off = Object.entries(store.doc.kinds).filter(([, kind]) => !kind.enabled).length;
  return (
    <Section title="Kinds" description="What a thread can ask for. A kind is offered when it is on and a backend that is on makes it.">
      {empty ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-5 text-center text-xs text-subtle-foreground">Kinds are offered once a backend is on. Their sizes can be set now.</div>
      ) : null}
      <Card>
        {KIND_GROUPS.map((group) => {
          const ids = group.ids.filter((id) => store.doc.kinds[id]?.enabled || showOff);
          if (!ids.length) return null;
          return (
            <div key={group.title} className="border-b border-border last:border-b-0">
              <p className="px-4 pb-1 pt-2.5 text-2xs font-medium text-subtle-foreground">{group.title}</p>
              <Rows>
                {ids.map((id) => (
                  <KindRow key={id} id={id} instant={instant} />
                ))}
              </Rows>
            </div>
          );
        })}
        {off ? (
          <button type="button" onClick={() => setShowOff((current) => !current)} className="flex w-full cursor-pointer items-center gap-1.5 border-t border-border px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground">
            <Icon name={showOff ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {showOff ? "Hide the kinds that are off" : `${plural(off, "kind")} off`}
          </button>
        ) : null}
      </Card>
    </Section>
  );
}

function Options() {
  const store = useStore();
  const nav = useNav();
  const { general, monitor, images } = store.doc;
  const due = 2;
  return (
    <Section title="Options">
      <Card>
        <Rows>
          <NavRow icon={<ProviderGlyph type="box" />} title="Boxes" value={`${kindTitle(general.defaultKind)} by default · ${general.boxesPerThread ? `${general.boxesPerThread} per thread` : "no limit per thread"} · ${plural(general.files.length, "file")}`} onClick={() => nav.go({ page: "option", id: "boxes" })} />
          <NavRow icon={<Icon name="Image" className="size-4" aria-hidden />} title="Images" value={`${general.nightlyImages ? "Rebuilt each night" : "Not rebuilt on a schedule"} · ${due} due${images.length ? ` · ${plural(images.length, "project image")}` : ""}`} onClick={() => nav.go({ page: "option", id: "images" })} />
          <NavRow icon={<Icon name="Phone" className="size-4" aria-hidden />} title="Devices" value={`iOS video ${general.iosEncoder} · encoder ${general.encoderLedger ? "shared" : "not shared"}`} onClick={() => nav.go({ page: "option", id: "devices" })} />
          <NavRow icon={<Icon name="Globe" className="size-4" aria-hidden />} title="Network" value={general.tailnet.mode === "oauth" ? "Joins your tailnet" : "No tailnet"} onClick={() => nav.go({ page: "option", id: "network" })} />
          <NavRow icon={<Icon name="Activity" className="size-4" aria-hidden />} title="Monitor" value={monitor.enabled ? `On · every ${monitor.refreshIntervalSeconds} s${monitor.backgroundMonitoring ? " · in the background" : ""}` : "Off"} onClick={() => nav.go({ page: "option", id: "monitor" })} />
          <NavRow icon={<Icon name="Settings" className="size-4" aria-hidden />} title="Configuration" value={`Revision ${store.doc.revision}`} onClick={() => nav.go({ page: "option", id: "configuration" })} />
          <NavRow icon={<Icon name="Desktop" className="size-4" aria-hidden />} title="Your machines" value="2, on the Boxes page" external onClick={() => window.alert("Opens the Boxes page on its Machines tab.")} />
        </Rows>
      </Card>
    </Section>
  );
}

function FirstRun() {
  const store = useStore();
  const nav = useNav();
  const { firstRun } = store;
  const here = DOCKER_MACHINES.find((machine) => machine.name === "bb-1")!;
  if (firstRun.state === "building") {
    const share = Math.min(0.97, Math.max(0.03, (firstRun.step - 1) / BUILD_STEPS));
    return (
      <Card className="px-5 py-4">
        <p className="text-sm font-medium text-foreground">Setting up Docker on this machine</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Building the Linux image · step {firstRun.step} of {BUILD_STEPS}
        </p>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Building the Linux image">
          <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out" style={{ width: `${Math.round(share * 100)}%` }} />
        </div>
        <p className="mt-2 text-xs text-subtle-foreground">It usually takes 5 to 12 min, and goes on if you leave this page.</p>
      </Card>
    );
  }
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-foreground">Set up BB Box</h3>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">Boxes are computers for your threads. Choose where they run; you can add more places later.</p>
      </div>
      <Card className="px-5 py-4">
        <div className="flex items-start gap-3">
          <ProviderGlyph type="docker" className="mt-0.5 size-5" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
              Use Docker on this machine <Badge>Quickest</Badge>
            </p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {here.name}, where BB runs, has Docker {here.docker ?? "29.8.2"}. BB Box builds its Linux image there, usually in 5 to 12 min, and then makes Linux boxes in seconds.
            </p>
          </div>
          <Button type="button" size="sm" className="h-8 shrink-0" onClick={store.useDocker}>
            Use Docker on {here.name}
          </Button>
        </div>
      </Card>
      <button type="button" onClick={() => nav.go({ page: "add" })} className={cn("pressable flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border px-5 py-3 text-left transition-colors hover:bg-state-hover")}>
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-foreground">Choose another backend</span>
          <span className="mt-0.5 block text-xs text-subtle-foreground">Proxmox, your Macs, machines over SSH, microVMs, or the cloud.</span>
        </span>
        <Chevron />
      </button>
    </section>
  );
}

export function kindLabelList(ids: readonly string[]): string {
  return ids.map((id) => kindTitle(id) + (kindOf(id).gpu ? " (GPU)" : "")).join(", ");
}
