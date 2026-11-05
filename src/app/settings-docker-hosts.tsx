import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import type { DockerHostView } from "../plugin/docker-hosts.ts";
import { restartWords, type DockerFix } from "../plugin/setup-offer.ts";
import { Meta, StatusDot, useLive } from "./common.tsx";
import { CopyLine } from "./first-run.tsx";
import { ServerGlyph } from "./glyphs.tsx";
import { switchKey, useSettings } from "./settings-context.tsx";
import { backendOfMachine, buildWords, dockerFacts, hostState, isBuilding, machineOf, machineOffers, namesWords, type MachineHosts } from "./settings-machine-docker.ts";
import { Card, Chevron, FOCUS_RING, Group, RowNote, Rows, SavedTick, StateLine } from "./settings-parts.tsx";
import { backendLabel } from "./settings-status.ts";

const BUILD_POLL_MS = 3_000;

export interface Machines {
  readonly hosts: MachineHosts;
  readonly error: string | null;
  refresh(): Promise<void>;
  recheck(hostIds: readonly string[]): Promise<void>;
}

export function useMachineHosts(wanted = true): Machines {
  const rpc = useRpc<Contract>();
  const { value, error, refresh } = useLive<DockerHostView[]>(wanted ? "docker-hosts" : "docker-hosts-unwanted", async () => (wanted ? (await rpc.call("docker.hosts", null)).hosts : []), () => false);
  const building = isBuilding(value);
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => void refresh(), BUILD_POLL_MS);
    return () => clearInterval(timer);
  }, [building, refresh]);
  const recheck = useCallback(
    async (hostIds: readonly string[]) => {
      await Promise.allSettled(hostIds.map((hostId) => rpc.call("docker.hosts", { recheck: hostId })));
      await refresh();
    },
    [rpc, refresh],
  );
  return { hosts: value, error, refresh, recheck };
}

export function MachineBuildLine({ host, className }: { host: DockerHostView | null; className?: string }) {
  const build = host ? buildWords(host) : null;
  if (!build) return null;
  return <StateLine tone={build.tone} words={build.text} className={className} />;
}

function FixSteps({ fix }: { fix: DockerFix }) {
  if (!fix.command) return null;
  return (
    <div>
      <CopyLine line={fix.command} label={`Copy the command: ${fix.command}`} />
      {fix.restart ? <CopyLine line={fix.restart} label={`Copy the command: ${fix.restart}`} /> : null}
      <p className="mt-2 text-xs leading-snug text-subtle-foreground">{restartWords(fix.restart)}</p>
    </div>
  );
}

function CheckAgain({ hostId, machines, name, onCheck, checking = false }: { hostId: string; machines: Machines; name: string; onCheck?: () => void; checking?: boolean }) {
  const [rechecking, setRechecking] = useState(false);
  const busy = rechecking || checking;
  const check = async () => {
    if (busy) return;
    if (onCheck) return onCheck();
    setRechecking(true);
    try {
      await machines.recheck([hostId]);
    } finally {
      setRechecking(false);
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" aria-label={`Check Docker on ${name} again`} aria-disabled={busy || undefined} onClick={() => void check()}>
      <Icon name={busy ? "Loading" : "ArrowReloadHorizontal"} className={cn(busy && "animate-spin")} aria-hidden />
      {busy ? "Checking…" : "Check again"}
    </Button>
  );
}

function FactRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-2.5 text-xs sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground sm:text-right">{children}</span>
    </div>
  );
}

export function MachineCard({ config, machines, onCheck, checking }: { config: BackendConfig; machines: Machines; onCheck?: () => void; checking?: boolean }) {
  const host = machineOf(machines.hosts, config);
  const hostId = (config.fields.host as string).slice("bb:".length);
  const name = host?.name ?? hostId;
  const state = host ? hostState(host, config) : null;
  const build = host ? buildWords(host) : null;
  const facts = host ? dockerFacts(host) : [];
  const fix = host?.fix?.command ? host.fix : null;
  const trouble = state && (state.tone === "bad" || state.tone === "warn");
  return (
    <Group title="BB machine" description="A box here is a privileged container, root on the machine, and takes its memory.">
      <Card>
        <Rows>
          <FactRow label="Machine">{name}</FactRow>
          <FactRow label="Docker">
            {!machines.hosts ? (
              <span className="text-muted-foreground">{machines.error ? `Not known: ${machines.error}` : "Looking…"}</span>
            ) : state ? (
              <span className="inline-flex min-w-0 items-start gap-1.5 sm:justify-end">
                <StatusDot tone={state.tone} />
                <Meta items={[<span key="state" className={cn(state.tone === "bad" && "text-destructive-text", state.tone === "warn" && "text-warning-text")}>{state.text}</span>, ...facts]} />
              </span>
            ) : (
              <span className="text-destructive-text">BB lists no such persistent machine now</span>
            )}
          </FactRow>
          {build ? (
            <FactRow label="Images">
              <span className={cn(build.tone === "bad" && "text-destructive-text")}>{build.text}</span>
            </FactRow>
          ) : null}
          {host && trouble ? (
            <div className="space-y-1 px-4 py-3 text-xs leading-snug" role="status">
              <p className="text-foreground">{host.fix?.problem ?? host.problem ?? (host.absent ? `${name} has no Docker now. Install Docker Engine there.` : null)}</p>
              {fix ? <FixSteps fix={fix} /> : null}
              <div className="pt-2">
                <CheckAgain hostId={host.hostId} machines={machines} name={name} onCheck={onCheck} checking={checking} />
              </div>
            </div>
          ) : null}
        </Rows>
      </Card>
    </Group>
  );
}

export function MachinesLine({ machines }: { machines: Machines }) {
  const { state, nav } = useSettings();
  if (!machines.hosts) return null;
  const offers = machineOffers(machines.hosts, state.document);
  if (!offers.ready.length && !offers.cannot.length) return null;
  const ready = offers.ready.map((host) => host.name);
  const cannot = offers.cannot.map((host) => host.name);
  const words = [
    ready.length ? `${namesWords(ready)} ${ready.length === 1 ? "has" : "have"} Docker and could host boxes.` : "",
    cannot.length ? `Docker on ${namesWords(cannot)} cannot host boxes now.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <p className="px-1 text-xs leading-snug text-subtle-foreground">
      {words}{" "}
      <button type="button" data-row-key="machines-line" className="cursor-pointer rounded-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" onClick={() => nav.go({ page: "add" }, "machines-line")}>
        See them under Add backend
      </button>
    </p>
  );
}

function OfferRow({ host, children, action, tone }: { host: DockerHostView; children?: ReactNode; action?: ReactNode; tone?: "muted" }) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3">
      <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center", tone === "muted" ? "text-subtle-foreground" : "text-muted-foreground")}>
        <ServerGlyph />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="truncate text-sm font-normal text-foreground">{host.name}</p>
        {children}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2 self-center">{action}</div> : null}
    </div>
  );
}

function ReadyRow({ host, onAdded }: { host: DockerHostView; onAdded: (hostId: string) => void }) {
  const { instant, writes } = useSettings();
  const key = switchKey.dockerHost(host.hostId);
  const pending = instant.pendingValue<boolean>(key) !== undefined;
  const disk = host.fix && !host.fix.command ? host.fix.problem : null;
  const add = () => {
    if (instant.pending !== null) return;
    void instant.run(writes.dockerHost(host, true)).then((outcome) => {
      if (outcome?.kind === "saved" || outcome?.kind === "already") onAdded(host.hostId);
    });
  };
  return (
    <OfferRow
      host={host}
      action={
        <>
          <SavedTick show={instant.isSaved(key)} />
          <Button type="button" variant="outline" size="sm" className="h-7" data-row-key={`machine-add-${host.hostId}`} aria-label={`Add Docker on ${host.name}`} aria-disabled={pending || instant.pending !== null || undefined} onClick={add}>
            {pending ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="Plus" aria-hidden />}
            {pending ? "Adding…" : "Add"}
          </Button>
        </>
      }
    >
      <StateLine className="mt-0.5" tone="off" words="Can host boxes" items={dockerFacts(host)} />
      {disk ? <p className="mt-0.5 text-xs leading-snug text-warning-text">{disk}</p> : null}
      <RowNote note={instant.note(key)} className="mt-0.5" />
    </OfferRow>
  );
}

function CannotRow({ host, machines }: { host: DockerHostView; machines: Machines }) {
  const fix = host.fix?.command ? host.fix : null;
  return (
    <OfferRow host={host} action={<CheckAgain hostId={host.hostId} machines={machines} name={host.name} />}>
      <StateLine className="mt-0.5" tone="bad" words="Cannot host boxes" />
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{fix?.problem ?? host.problem}</p>
      {fix ? <FixSteps fix={fix} /> : null}
    </OfferRow>
  );
}

function UsedRow({ host }: { host: DockerHostView }) {
  const { state, nav } = useSettings();
  const backend = backendOfMachine(state.document, host.hostId)!;
  const look = hostState(host, backend);
  const rowKey = `machine-${host.hostId}`;
  return (
    <button type="button" data-row-key={rowKey} onClick={() => nav.go({ page: "backend", id: backend.id }, rowKey)} className={cn("flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover", FOCUS_RING)}>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <ServerGlyph />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-normal text-foreground">{host.name}</span>
        <StateLine className="mt-0.5" tone={look.tone} words={look.text} items={[backendLabel(state, backend)]} />
        <MachineBuildLine host={host} className="mt-0.5" />
      </span>
      <span className="flex shrink-0 items-center gap-2 self-center text-xs text-muted-foreground">
        Added: open it
        <Chevron />
      </span>
    </button>
  );
}

export function MachineOffersGroup({ machines }: { machines: Machines }) {
  const { state } = useSettings();
  const [added, setAdded] = useState<string | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!added) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(`machine-${added}`)}"]`);
    if (!row) return;
    row.focus();
    setAdded(null);
  });
  const description = "Your own BB machines that run Docker, such as a PC with WSL. A box there is a privileged container, root on the machine, so none is used until you add it.";
  const offers = machines.hosts ? machineOffers(machines.hosts, state.document) : null;
  const listed = offers ? offers.ready.length + offers.cannot.length + offers.used.length + offers.offline.length : 0;
  const onAdded = (hostId: string) => {
    setAdded(hostId);
    void machines.refresh();
  };
  return (
    <section ref={root}>
      <Group title="Docker on your BB machines" description={description}>
        {!offers ? (
          machines.error ? (
            <RowNote note={`Your BB machines could not be listed: ${machines.error}`} />
          ) : (
            <p className="flex items-center gap-2 px-1 text-xs text-subtle-foreground" role="status">
              <Icon name="Loading" className="animate-spin" aria-hidden />
              Looking for Docker on your BB machines…
            </p>
          )
        ) : listed ? (
          <Card>
            <Rows>
              {offers.ready.map((host) => (
                <ReadyRow key={host.hostId} host={host} onAdded={onAdded} />
              ))}
              {offers.cannot.map((host) => (
                <CannotRow key={host.hostId} host={host} machines={machines} />
              ))}
              {offers.used.map((host) => (
                <UsedRow key={host.hostId} host={host} />
              ))}
              {offers.offline.map((host) => (
                <OfferRow key={host.hostId} host={host} tone="muted">
                  <StateLine className="mt-0.5" tone="warn" words="Offline in BB" />
                </OfferRow>
              ))}
            </Rows>
          </Card>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-subtle-foreground">No BB machine of yours has Docker. BB Box looks at connected, persistent machines it did not make.</p>
        )}
        {offers?.none.length ? (
          <p className="px-1 text-xs leading-snug text-subtle-foreground">
            No Docker on {namesWords(offers.none.map((host) => host.name))}.
          </p>
        ) : null}
      </Group>
    </section>
  );
}
