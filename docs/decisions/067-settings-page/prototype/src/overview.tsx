import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/src/app/common.tsx";
import { BUILD_STEPS, imagesFor, relative, useStore } from "./store";
import { DOCKER_MACHINES, driverOf, type BackendConfig } from "./data";
import { availability, backendState, backendTitle, defaultSize, KIND_GROUPS, kindBadges, kindName, kindTitle, offering, plural, qualifierOf, sizeWords, statusItems, warmTotal } from "./model";
import { useNav } from "./nav";
import { useDraftParts, useInstant } from "./drafts";
import { Badge, Card, Chevron, FOCUS_RING, Icon, NavRow, PageHeading, ProviderGlyph, Rows, SavedTick, Section, StateLine } from "./ui";

export function Overview() {
  const store = useStore();
  const usable = store.setupDone;
  const [showMore, setShowMore] = useState(false);
  return (
    <div className="space-y-7">
      <h2 tabIndex={-1} data-page-heading className="sr-only">
        BB Box settings
      </h2>
      {usable ? (
        <>
          {store.firstRun.state === "built" ? <FirstRun usable /> : null}
          <Status />
        </>
      ) : (
        <FirstRun usable={false} />
      )}
      {store.doc.backends.length ? <Backends /> : null}
      {usable || showMore ? (
        <>
          <Kinds firstRun={!usable} />
          <Options />
        </>
      ) : (
        <button type="button" onClick={() => setShowMore(true)} className={cn("flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border px-4 py-3 text-left text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground", FOCUS_RING)}>
          <Icon name="ChevronRight" className="size-3.5" aria-hidden />
          Sizes and options: kinds, images, devices, network, Monitor and the configuration file, for later
        </button>
      )}
    </div>
  );
}

function Status() {
  const store = useStore();
  const nav = useNav();
  const on = store.doc.backends.filter((backend) => backend.enabled);
  const states = on.map((backend) => backendState(store.doc, backend, store.live[backend.id]));
  const items = statusItems(store.doc, store.live, imagesFor(store.scenario));
  const kinds = new Set(on.flatMap((backend) => store.live[backend.id]?.offers ?? []).filter((kind) => store.doc.kinds[kind]?.enabled)).size;
  const checkedTimes = on.map((backend) => store.live[backend.id]?.health?.checkedAt).filter((at): at is number => typeof at === "number");
  const oldest = checkedTimes.length ? Math.min(...checkedTimes) : null;
  const newest = checkedTimes.length ? Math.max(...checkedTimes) : null;
  const unchecked = states.filter((state) => state.status === "never" || state.status === "changed").length;
  const fresh = states.filter((state) => state.status === "ready").length;
  const passedOld = states.filter((state) => state.status === "stale").length;
  const passed = fresh + passedOld;
  const off = store.doc.backends.length - on.length;
  const checkAll = (
    <Button type="button" variant={passedOld || unchecked ? "default" : "outline"} size="sm" className="h-7 shrink-0" disabled={store.checkingAll} onClick={() => void store.checkAll()}>
      {store.checkingAll ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
      {store.checkingAll ? "Checking…" : "Check all"}
    </Button>
  );
  const age = oldest === null ? "" : oldest === newest || Math.abs((oldest ?? 0) - (newest ?? 0)) < 5 * 60_000 ? `checked ${relative(oldest)}` : `checked between ${relative(newest!)} and ${relative(oldest)}`;
  const words = passedOld ? "passed their last check" : "ready";
  const headline = store.checkingAll
    ? `Checking ${plural(on.length, "backend")}, up to 30 s each, side by side…`
    : !on.length
      ? "Every backend is off"
      : on.length === 1 && passed === 1
        ? `${backendTitle(on[0]!, store.live[on[0]!.id])} ${passedOld ? "passed its last check" : "is ready"}`
        : passed === on.length
          ? `All ${plural(on.length, "backend")} ${words}`
          : `${passed} of ${plural(on.length, "backend")} ${words}`;
  return (
    <section aria-label="Status" className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-foreground" role="status" aria-live="polite">
          <StatusDot tone={store.checkingAll ? "busy" : items.length ? "warn" : passedOld || unchecked ? "off" : "ok"} />
          <span>
            {headline}
            <span className="text-muted-foreground">
              {store.checkingAll || !on.length ? "" : [unchecked ? ` · ${unchecked} not checked since ${unchecked === 1 ? "it" : "they"} changed` : "", off ? ` · ${off} off` : "", ` · ${plural(kinds, "kind")} on offer`, age ? ` · ${age}` : ""].join("")}
            </span>
          </span>
        </p>
        {checkAll}
      </div>
      {items.length ? (
        <div className="rounded-lg border border-surface-warning-border bg-surface-warning px-4 py-3" role="alert">
          <p className="text-sm font-medium text-foreground">{items.length === 1 ? "1 thing needs you" : `${items.length} things need you`}</p>
          <ul className="mt-2 space-y-2.5">
            {items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                <StatusDot tone={item.tone} className="text-sm" />
                <div className="min-w-0 flex-1 text-xs leading-snug">
                  <p className="font-medium text-foreground">{item.title}</p>
                  <p className="text-muted-foreground">{item.detail}</p>
                  {item.fix ? <p className="mt-0.5 text-foreground">Fix: {item.fix}</p> : null}
                </div>
                <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label={`Open ${item.title}`} onClick={() => nav.go(item.open as never, { row: `status-${item.key}` })} data-row-key={`status-${item.key}`}>
                  Open
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function BackendRow({ backend, instant }: { backend: BackendConfig; instant: ReturnType<typeof useInstant> }) {
  const store = useStore();
  const nav = useNav();
  const drafts = useDraftParts();
  const live = store.live[backend.id];
  const raw = backendState(store.doc, backend, live);
  const ages = store.doc.backends.filter((each) => each.enabled).map((each) => store.live[each.id]?.health?.checkedAt ?? 0);
  const sameAge = Math.max(...ages) - Math.min(...ages) < 5 * 60_000;
  const state = raw.status === "stale" && sameAge ? { ...raw, items: raw.items.slice(1) } : raw;
  const driver = driverOf(backend.type);
  const qualifier = qualifierOf(backend, live);
  const title = backendTitle(backend, live);
  const stateId = `state-${backend.id.replace(/[^a-z0-9]/gi, "-")}`;
  const open = () => nav.go({ page: "backend", id: backend.id }, { row: `backend-${backend.id}` });
  const refused = instant.refused?.key === backend.id ? instant.refused.message : null;
  const pendingValue = instant.pendingValue(backend.id);
  return (
    <div className="flex items-center gap-3 pr-4 transition-colors duration-150 hover:bg-state-hover">
      <button type="button" data-row-key={`backend-${backend.id}`} onClick={open} aria-describedby={stateId} className={cn("flex min-w-0 flex-1 cursor-pointer items-start gap-3 py-3 pl-4 text-left", FOCUS_RING)}>
        <ProviderGlyph type={backend.type} className="mt-0.5" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
            <span className="min-w-0 truncate">{backend.label ?? driver.label}</span>
            {qualifier ? <Badge>{qualifier}</Badge> : null}
            {live?.bbMachine ? <Badge>BB machine</Badge> : null}
            {drafts.includes(`backends/${backend.id}`) ? <Badge tone="warn">Unsaved changes</Badge> : null}
          </span>
          <StateLine id={stateId} className="mt-0.5" tone={state.tone} words={state.words} items={state.items} />
          {refused ? <span className="mt-1 block text-xs leading-snug text-destructive-text">{refused}</span> : null}
        </span>
        <span className="self-center">
          <Chevron />
        </span>
      </button>
      <SavedTick show={instant.saved === backend.id} />
      <Switch
        aria-label={`${title}: takes new boxes`}
        aria-describedby={stateId}
        checked={pendingValue !== undefined ? (pendingValue as boolean) : backend.enabled}
        disabled={instant.pending === backend.id}
        onCheckedChange={(enabled) => void instant.run(backend.id, [[`backends/${backend.id}/enabled`, enabled]], title)}
      />
    </div>
  );
}

function Backends() {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const spare = DOCKER_MACHINES.filter((machine) => machine.docker && !machine.fault && !store.doc.backends.some((backend) => backend.fields.host === `bb:${machine.id}`));
  return (
    <Section
      title="Backends"
      description="Where boxes run. Off, a backend takes no new boxes; its boxes keep working."
      action={
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => nav.go({ page: "add" }, { row: "add-backend" })} data-row-key="add-backend">
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
          <button type="button" className="cursor-pointer rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "add" })}>
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
  const drafts = useDraftParts();
  const kind = store.doc.kinds[id]!;
  const from = offering(store.doc, store.live, id);
  const warm = warmTotal(store.doc, id);
  const isDefault = store.doc.general.defaultKind === id;
  const state = availability(store.doc, store.live, id);
  const pendingValue = instant.pendingValue(id);
  const enabled = pendingValue !== undefined ? (pendingValue as boolean) : kind.enabled;
  const name = kindName(id);
  const summaryId = `kind-${id}`;
  const open = () => nav.go({ page: "kind", id }, { row: `kind-${id}` });
  const refused = instant.refused?.key === id ? instant.refused.message : null;
  const summary =
    state === "off" ? "Off: no new boxes" : state === "lost" ? "Not offered now: its backends cannot make it" : state === "none" ? "No backend you have makes it" : [sizeWords(defaultSize(kind)), plural(from.length, "backend"), warm ? `${warm} warm` : null, kind.spares ? plural(kind.spares, "spare") : null].filter(Boolean).join(" · ");
  return (
    <div className={cn("flex items-center gap-3 pr-4 transition-colors duration-150 hover:bg-state-hover", !kind.enabled && "opacity-70")}>
      <button type="button" data-row-key={`kind-${id}`} onClick={open} aria-describedby={summaryId} className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pl-4 text-left", FOCUS_RING)}>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
          <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-sm text-foreground">
            {kindTitle(id)}
            {kindBadges(id).map((badge) => (
              <Badge key={badge}>{badge}</Badge>
            ))}
            {isDefault ? <Badge>Default</Badge> : null}
            {drafts.includes(`kinds/${id}`) ? <Badge tone="warn">Unsaved changes</Badge> : null}
          </span>
          <span id={summaryId} className={cn("min-w-0 flex-1 truncate text-xs sm:text-right", state === "lost" ? "text-warning-text" : "text-muted-foreground")}>
            {summary}
          </span>
        </span>
        <Chevron />
      </button>
      <SavedTick show={instant.saved === id} />
      <span title={isDefault ? "The default kind stays on. Choose another default on the Boxes page first." : undefined}>
        <Switch aria-label={`${name}: offered to threads`} aria-describedby={summaryId} checked={enabled} disabled={instant.pending === id || isDefault} onCheckedChange={(next) => void instant.run(id, [[`kinds/${id}/enabled`, next]], name)} />
      </span>
      {refused ? <span className="sr-only" role="alert">{refused}</span> : null}
    </div>
  );
}

function Kinds({ firstRun }: { firstRun: boolean }) {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const [visibleHere] = useState(() => new Set(Object.entries(store.doc.kinds).filter(([id, kind]) => kind.enabled && availability(store.doc, store.live, id) !== "none").map(([id]) => id)));
  const [showFolded, setShowFolded] = useState(false);
  const shownIds = KIND_GROUPS.flatMap((group) => group.ids).filter((id) => store.doc.kinds[id] && (visibleHere.has(id) || (store.doc.kinds[id]!.enabled && availability(store.doc, store.live, id) !== "none")));
  const folded = KIND_GROUPS.flatMap((group) => group.ids).filter((id) => store.doc.kinds[id] && !shownIds.includes(id));
  const off = folded.filter((id) => !store.doc.kinds[id]!.enabled).length;
  const none = folded.length - off;
  const defaultName = kindName(store.doc.general.defaultKind);
  return (
    <Section
      title="Kinds"
      description={firstRun ? "What a thread can ask for, once a backend makes it. Sizes can be set now." : `What a thread can ask for. ${defaultName} is the default.`}
      action={
        <button type="button" className="cursor-pointer rounded-sm text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "option", id: "boxes" }, { found: "general/defaultKind" })}>
          Change the default
        </button>
      }
    >
      {instant.refused ? (
        <p role="alert" className="px-1 text-xs text-destructive-text">
          {instant.refused.message}
        </p>
      ) : null}
      <Card>
        {KIND_GROUPS.map((group) => {
          const ids = group.ids.filter((id) => shownIds.includes(id) || (showFolded && folded.includes(id)));
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
        {folded.length ? (
          <button type="button" aria-expanded={showFolded} onClick={() => setShowFolded((current) => !current)} className={cn("flex w-full cursor-pointer items-center gap-1.5 border-t border-border px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground", FOCUS_RING)}>
            <Icon name={showFolded ? "ChevronDown" : "ChevronRight"} className="size-3.5" aria-hidden />
            {showFolded ? "Hide them" : [off ? `${plural(off, "kind")} off` : "", none ? `${plural(none, "kind")} no backend you have makes` : ""].filter(Boolean).join(" · ")}
          </button>
        ) : null}
      </Card>
    </Section>
  );
}

function Options() {
  const store = useStore();
  const nav = useNav();
  const instant = useInstant();
  const { general, monitor, images } = store.doc;
  const due = imagesFor(store.scenario).filter((image) => image.due).length;
  const failed = imagesFor(store.scenario).filter((image) => image.lastState === "failed").length;
  const monitorPending = instant.pendingValue("monitor");
  const monitorOn = monitorPending !== undefined ? (monitorPending as boolean) : monitor.enabled;
  const go = (id: "boxes" | "images" | "devices" | "network" | "monitor" | "configuration") => nav.go({ page: "option", id }, { row: `option-${id}` });
  return (
    <Section title="Options">
      <Card>
        <Rows>
          <NavRow rowKey="option-boxes" icon={<ProviderGlyph type="box" />} title="Boxes" value={`${kindName(general.defaultKind)} by default · ${general.boxesPerThread ? `${general.boxesPerThread} per thread` : "no limit per thread"} · ${plural(general.files.length, "file")}`} onClick={() => go("boxes")} />
          <NavRow rowKey="option-images" icon={<Icon name="Image" className="size-4" aria-hidden />} title="Images" tone={failed ? "warn" : undefined} value={`${general.nightlyImages ? "Rebuilt each night" : "Not rebuilt on a schedule"} · ${failed ? `${failed} failed · ` : ""}${due} due${images.length ? ` · ${plural(images.length, "project image")}` : ""}`} onClick={() => go("images")} />
          <NavRow rowKey="option-devices" icon={<Icon name="Phone" className="size-4" aria-hidden />} title="Devices" value={`iOS video: ${general.iosEncoder === "auto" ? "automatic" : general.iosEncoder === "hardware" ? "hardware only" : "software only"}`} onClick={() => go("devices")} />
          <NavRow rowKey="option-network" icon={<Icon name="Globe" className="size-4" aria-hidden />} title="Network" value={general.tailnet.mode === "oauth" ? "Machines join your tailnet" : "No tailnet"} onClick={() => go("network")} />
          <NavRow
            rowKey="option-monitor"
            icon={<Icon name="Activity" className="size-4" aria-hidden />}
            title="Monitor"
            value={monitorOn ? `Machine status in the sidebar · every ${monitor.refreshIntervalSeconds} s` : "Off"}
            onClick={() => go("monitor")}
            trailing={
              <>
                <SavedTick show={instant.saved === "monitor"} />
                <Switch aria-label="Monitor: machine status in BB's sidebar" checked={monitorOn} disabled={instant.pending === "monitor"} onCheckedChange={(enabled) => void instant.run("monitor", [["monitor/enabled", enabled]], "The Monitor")} />
              </>
            }
          />
          <NavRow rowKey="option-configuration" icon={<Icon name="Settings" className="size-4" aria-hidden />} title="Configuration" value={`Revision ${store.doc.revision}`} onClick={() => go("configuration")} />
          <NavRow rowKey="machines" icon={<Icon name="Desktop" className="size-4" aria-hidden />} title="Your machines" value="On the Boxes page, Machines tab" external onClick={() => window.dispatchEvent(new CustomEvent("bb-open", { detail: "machines" }))} />
        </Rows>
      </Card>
      {store.monitorChanged ? <ReloadNote /> : null}
    </Section>
  );
}

export function ReloadNote() {
  return (
    <p role="status" className="flex flex-wrap items-center gap-2 px-1 text-xs text-muted-foreground">
      The sidebar's machine status changes when BB next loads.
      <button type="button" className="cursor-pointer rounded-sm text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => window.location.reload()}>
        Reload BB now
      </button>
    </p>
  );
}

function CopyLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2 rounded-md bg-surface-recessed px-3 py-2">
      <code className="min-w-0 flex-1 break-all font-mono text-2xs text-foreground">{line}</code>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 px-2 text-2xs"
        onClick={() => {
          void navigator.clipboard?.writeText(line);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        <Icon name={copied ? "Check" : "Copy"} className="size-3.5" aria-hidden />
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

function FirstRunCard({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex flex-wrap items-start gap-3">
        <ProviderGlyph type="docker" className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <div className="mt-1 text-xs leading-snug text-muted-foreground">{children}</div>
        </div>
        {action}
      </div>
    </Card>
  );
}

function FirstRun({ usable }: { usable: boolean }) {
  const store = useStore();
  const nav = useNav();
  const [checking, setChecking] = useState(false);
  const { firstRun, serverDocker } = store;
  const unfinishedBackends = store.doc.backends.filter((backend) => backendState(store.doc, backend, store.live[backend.id]).status === "unfinished");
  const others = DOCKER_MACHINES.filter((machine) => machine.docker && !machine.fault && machine.name !== "bb-1").slice(0, 1);
  const checkAgain = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0"
      disabled={checking}
      onClick={() => {
        setChecking(true);
        setTimeout(() => setChecking(false), 1200);
      }}
    >
      {checking ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="Refresh" aria-hidden />}
      Check again
    </Button>
  );
  let card: ReactNode;
  if (firstRun.state === "building") {
    const share = Math.min(0.97, Math.max(0.03, (firstRun.step - 1) / BUILD_STEPS));
    card = (
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
  } else if (firstRun.state === "built") {
    card = (
      <FirstRunCard title="Docker on this machine is ready" action={<Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => window.dispatchEvent(new CustomEvent("bb-open", { detail: "new-thread" }))}>Start a thread</Button>}>
        BB Box makes Linux boxes on bb-1 now. Ask for one in a thread, or with New box on the Boxes page. Add more backends for desktops, Macs or Windows.
      </FirstRunCard>
    );
  } else if (serverDocker === "missing") {
    card = (
      <FirstRunCard title="bb-1 has no Docker" action={checkAgain}>
        bb-1, where BB runs, has no Docker. Install it, then check again:
        <CopyLine line="curl -fsSL https://get.docker.com | sh" />
        {others.length ? <p className="mt-2">Or use a BB machine that has Docker: {others[0]!.name} has Docker {others[0]!.docker}. <button type="button" className="text-foreground underline underline-offset-2" onClick={() => nav.go({ page: "add" })}>Use {others[0]!.name}</button></p> : null}
      </FirstRunCard>
    );
  } else if (serverDocker === "permission") {
    card = (
      <FirstRunCard title="BB cannot use Docker on bb-1" action={checkAgain}>
        bb-1 has Docker 29.8, but BB's user there cannot use it. Add the user to the docker group, then restart BB so it takes effect:
        <CopyLine line="sudo usermod -aG docker bb" />
        <CopyLine line="npx bb-app stop && npx bb-app" />
      </FirstRunCard>
    );
  } else if (serverDocker === "disk") {
    card = (
      <FirstRunCard title="Not enough disk on bb-1" action={checkAgain}>
        The Linux image needs about 10 GB free to build, and bb-1 has 9 GB. Free some, then check again:
        <CopyLine line="docker builder prune" />
      </FirstRunCard>
    );
  } else {
    card = (
      <FirstRunCard title="Use Docker on this machine" action={<Button type="button" size="sm" className="h-8 shrink-0" onClick={store.useDocker}>Use Docker on bb-1</Button>}>
        bb-1, where BB runs, has Docker 29.8. BB Box builds its Linux image there, usually in 5 to 12 min, then makes Linux boxes in seconds.
      </FirstRunCard>
    );
  }
  return (
    <section className="space-y-3" aria-label="Set up BB Box">
      {usable ? null : (
        <div>
          <PageHeadingLite>Set up BB Box</PageHeadingLite>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">Boxes are computers for your threads. Choose where they run; you can add more places later.</p>
        </div>
      )}
      {card}
      {unfinishedBackends.map((backend) => (
        <button key={backend.id} type="button" onClick={() => nav.go({ page: "backend", id: backend.id })} className={cn("pressable flex w-full cursor-pointer items-center gap-3 rounded-lg border border-surface-warning-border px-5 py-3 text-left transition-colors hover:bg-state-hover", FOCUS_RING)}>
          <ProviderGlyph type={backend.type} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">Finish setting up {backendTitle(backend, store.live[backend.id])}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">Saved, not finished: {backendState(store.doc, backend, store.live[backend.id]).items[0]}</span>
          </span>
          <Chevron />
        </button>
      ))}
      {firstRun.state === "building" ? null : (
        <button type="button" onClick={() => nav.go({ page: "add" })} className={cn("pressable flex w-full cursor-pointer items-center gap-3 rounded-lg border border-border px-5 py-3 text-left transition-colors hover:bg-state-hover", FOCUS_RING)}>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">{usable ? "Add another backend" : "Choose another backend"}</span>
            <span className="mt-0.5 block text-xs text-subtle-foreground">Proxmox, your Macs, machines over SSH, microVMs, or the cloud.</span>
          </span>
          <Chevron />
        </button>
      )}
    </section>
  );
}

function PageHeadingLite({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium text-foreground">{children}</h3>;
}

export { PageHeading };
