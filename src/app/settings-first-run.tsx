import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BackendConfig } from "../core/document.ts";
import type { Contract } from "../plugin/contract.ts";
import { building, LINUX_BUILD_GB, restartWords, setupTarget, type MachineAccessProblem, type MachineSetup } from "../plugin/setup-offer.ts";
import { message, useNow } from "./common.tsx";
import { CopyLine, estimate, JoinHelp, LINUX_BUILD_WORDS, Progress, READY_MS, useSetups, whose } from "./first-run.tsx";
import { useSettings } from "./settings-context.tsx";
import type { Machines } from "./settings-docker-hosts.tsx";
import { Card, Chevron, FOCUS_RING, ProviderGlyph } from "./settings-parts.tsx";
import { backendHealth, backendLabel, hostChip } from "./settings-status.ts";

export const DOCKER_INSTALL_LINE = "curl -fsSL https://get.docker.com | sudo sh";

function SetupCard({ title, children, action, tone }: { title: string; children: ReactNode; action?: ReactNode; tone?: "warn" }) {
  return (
    <Card className={cn("px-4 py-4", tone === "warn" && "border-surface-warning-border")}>
      <div className="flex flex-wrap items-start gap-3">
        <ProviderGlyph type="docker" className="mt-0.5 size-5" />
        <div className="min-w-0 flex-1 basis-64">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <div className="mt-1 text-xs leading-snug text-muted-foreground">{children}</div>
        </div>
        {action}
      </div>
    </Card>
  );
}

function CheckAgain({ hostIds, machines, refresh, label }: { hostIds: readonly string[]; machines: Machines; refresh: () => Promise<unknown>; label: string }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await machines.recheck(hostIds);
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" aria-label={label} aria-disabled={busy || undefined} onClick={() => void run()}>
      {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="ArrowReloadHorizontal" aria-hidden />}
      Check again
    </Button>
  );
}

function useDockerStart(target: MachineSetup, label: string, onDone: () => Promise<unknown>) {
  const rpc = useRpc<Contract>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const answer = await rpc.call("setup.docker", { hostId: target.hostId });
      const result = answer.result;
      setProblem(result.ok ? null : result.reason === "problems" ? result.problems.map((item) => item.message).join(" ") : "Someone else saved BB Box's settings at the same moment. Try again.");
      await onDone();
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button type="button" size="sm" className="h-8 shrink-0" aria-disabled={busy || undefined} onClick={() => void start()}>
      {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
      {label}
    </Button>
  );
  return { problem, button };
}

function ReadyCard({ target, access, onDone }: { target: MachineSetup; access: MachineAccessProblem | null; onDone: () => Promise<unknown> }) {
  const failed = target.build?.state === "failed" ? target.build.detail : null;
  const use = useDockerStart(target, failed ? "Try again" : `Use Docker on ${target.name}`, onDone);
  const where = target.here ? `${target.name}, where BB runs,` : target.name;
  return (
    <SetupCard title={target.here ? "Use Docker on this machine" : `Use Docker on ${target.name}`} action={use.button}>
      <p>
        {where} has Docker {target.docker}. BB Box builds its Linux image there, {estimate(target.took.linux, LINUX_BUILD_WORDS)}, then makes Linux boxes in seconds.
      </p>
      {use.problem || failed ? (
        <p role="alert" className="mt-2 text-destructive-text">
          {use.problem ?? `The Linux image did not build: ${failed}`}
        </p>
      ) : null}
      {access ? (
        <p className="mt-2 text-warning-text">
          Boxes will not join BB yet. <JoinHelp words={access.message} />
        </p>
      ) : null}
    </SetupCard>
  );
}

function troubleTitle(target: MachineSetup): string {
  if (target.fix) return `BB cannot use Docker on ${target.name}`;
  if (target.docker && target.freeGb !== null && target.freeGb < LINUX_BUILD_GB) return `Not enough disk on ${target.name}`;
  return `Docker on ${target.name} cannot host boxes`;
}

function FixCard({ target, machines, refresh }: { target: MachineSetup; machines: Machines; refresh: () => Promise<unknown> }) {
  return (
    <SetupCard title={troubleTitle(target)} tone="warn" action={<CheckAgain hostIds={[target.hostId]} machines={machines} refresh={refresh} label={`Check Docker on ${target.name} again`} />}>
      <p>{target.problem}</p>
      {target.fix ? (
        <>
          <CopyLine line={target.fix} label={`Copy the command: ${target.fix}`} />
          {target.restart ? <CopyLine line={target.restart} label={`Copy the command: ${target.restart}`} /> : null}
          <p className="mt-2 text-subtle-foreground">{restartWords(target.restart)}</p>
        </>
      ) : null}
    </SetupCard>
  );
}

function MissingCard({ here, other, machines, refresh }: { here: MachineSetup; other: MachineSetup | null; machines: Machines; refresh: () => Promise<unknown> }) {
  const use = useDockerStart(other ?? here, other ? `Use Docker on ${other.name}` : "", refresh);
  return (
    <SetupCard title={`${here.name} has no Docker`} tone="warn" action={<CheckAgain hostIds={[here.hostId]} machines={machines} refresh={refresh} label={`Check ${here.name} for Docker again`} />}>
      <p>{here.name}, where BB runs, has no Docker. Install Docker Engine there, then check again. On Linux, Docker's install script does it:</p>
      <CopyLine line={DOCKER_INSTALL_LINE} label={`Copy the command: ${DOCKER_INSTALL_LINE}`} />
      <p className="mt-2 text-subtle-foreground">Then BB's user there must be able to use it; Check again says how if it cannot.</p>
      {other ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="min-w-0 flex-1 basis-48">
            Or use a BB machine that has Docker: {other.name} has Docker {other.docker}.
          </p>
          {use.button}
        </div>
      ) : null}
      {use.problem ? (
        <p role="alert" className="mt-2 text-destructive-text">
          {use.problem}
        </p>
      ) : null}
    </SetupCard>
  );
}

function DockerCard({ machines, setups }: { machines: Machines; setups: ReturnType<typeof useSetups> }) {
  const { value, refresh } = setups;
  if (!value) return null;
  const target = setupTarget(value.machines);
  const here = value.machines.find((setup) => setup.here) ?? null;
  if (target && building(target)) return <Progress setup={target} />;
  if (here?.state === "none") {
    const other = value.machines.find((setup) => !setup.here && setup.state === "ready") ?? null;
    return <MissingCard here={here} other={other} machines={machines} refresh={refresh} />;
  }
  if (!target) return null;
  if (target.state === "fix") return <FixCard target={target} machines={machines} refresh={refresh} />;
  return <ReadyCard target={target} access={value.access} onDone={refresh} />;
}

function unfinishedOf(state: ReturnType<typeof useSettings>["state"], machines: Machines): readonly BackendConfig[] {
  const now = Date.now();
  return state.document.backends.filter((backend) => backendHealth(state, backend, now, machines.hosts).status === "unfinished");
}

function WayRow({ rowKey, glyph, title, detail, onClick, tone }: { rowKey: string; glyph?: ReactNode; title: string; detail: string; onClick: () => void; tone?: "warn" }) {
  return (
    <button type="button" data-row-key={rowKey} onClick={onClick} className={cn("flex w-full cursor-pointer items-center gap-3 rounded-lg border bg-card px-4 py-3 text-left transition-colors duration-150 hover:bg-state-hover", tone === "warn" ? "border-surface-warning-border" : "border-border", FOCUS_RING)}>
      {glyph}
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{detail}</span>
      </span>
      <Chevron />
    </button>
  );
}

export function FirstRunSection({ machines }: { machines: Machines }) {
  const { state, nav } = useSettings();
  const setups = useSetups();
  const { value } = setups;
  const unfinished = unfinishedOf(state, machines);
  const now = Date.now();
  const busy = value?.machines.some(building) ?? false;
  return (
    <section className="space-y-3" aria-labelledby="settings-first-run">
      <div>
        <h3 id="settings-first-run" className="text-sm font-medium text-foreground">
          Set up BB Box
        </h3>
        <p className="mt-0.5 text-xs leading-snug text-subtle-foreground">Boxes are computers for your threads. Choose where they run; you can add more places later.</p>
      </div>
      <DockerCard machines={machines} setups={setups} />
      {unfinished.map((backend) => {
        const label = backendLabel(state, backend);
        const chip = hostChip(backend, label, state.backends.find((live) => live.id === backend.id)?.hosts);
        return (
          <WayRow
            key={backend.id}
            rowKey={`finish-${backend.id}`}
            tone="warn"
            glyph={<ProviderGlyph type={backend.type} />}
            title={`Finish setting up ${label}${chip ? ` on ${chip}` : ""}`}
            detail={`Saved, not finished: ${backendHealth(state, backend, now, machines.hosts).detail ?? "some settings are missing."}`}
            onClick={() => nav.go({ page: "backend", id: backend.id }, `finish-${backend.id}`)}
          />
        );
      })}
      {busy ? null : <WayRow rowKey="first-run-add" title="Choose another backend" detail="Proxmox, your Macs, machines over SSH, microVMs, or the cloud." onClick={() => nav.go({ page: "add" }, "first-run-add")} />}
    </section>
  );
}

export function JustReady() {
  const { state, nav } = useSettings();
  const { value } = useSetups();
  const now = useNow(false);
  const done = state.setupDone;
  if (!value || !done || now - done.at > READY_MS) return null;
  const built = value.machines.find((setup) => setup.state === "on" && setup.build?.state === "built" && setup.build.endedAt !== null && now - setup.build.endedAt < READY_MS);
  if (!built) return null;
  const name = whose(built);
  return (
    <section className="space-y-3" aria-label={`Docker on ${name} is ready`}>
      <SetupCard title={`Docker on ${name} is ready`}>
        BB Box makes Linux boxes on {built.name} now. Ask for one in a thread, or with New box on the Boxes page. Add more backends for desktops, Macs or Windows.
      </SetupCard>
      <WayRow rowKey="ready-add" title="Add another backend" detail="Proxmox, your Macs, machines over SSH, microVMs, or the cloud." onClick={() => nav.go({ page: "add" }, "ready-add")} />
    </section>
  );
}

export function useHereHostId(): string | null {
  const { value } = useSetups();
  return value?.machines.find((setup) => setup.here)?.hostId ?? null;
}
