// First-run setup in the Box panel (the operator's setup job, 11 October
// 2026). Where no backend is on, it offers one action on the BB machine that
// can take it, the one that runs BB first: "Use Docker on this machine",
// which turns its Docker on with the Linux image alone and builds it. Where
// something stands in the way, it gives that machine's own line to fix it
// and Check again. While the image builds, the panel shows how far it is,
// above the list too, as the backend is on by then.

import { experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { Contract } from "../plugin/contract.ts";
import type { MachineSetup } from "../plugin/setup-offer.ts";
import { forThread, message, SETTINGS_PATH, useLive, useNow } from "./common.tsx";

/** How long the Linux image usually takes to build from an empty cache. */
export const LINUX_BUILD_MS = 4 * 60_000;

/** "1 min", "4 min", or seconds without a decimal under a minute. */
export function roughly(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

/** A build's step from its last line, as Docker's build prints it: "#14 [linux 7/12] RUN …". */
export function buildStep(line: string | null): { readonly step: number; readonly of: number } | null {
  const found = line ? /\[[^\]\s]+ (\d+)\/(\d+)\]/.exec(line) : null;
  return found ? { step: Number(found[1]), of: Number(found[2]) } : null;
}

const building = (setup: MachineSetup) => setup.build?.state === "checking" || setup.build?.state === "building";
const whose = (setup: MachineSetup) => (setup.here ? "this machine" : setup.name);

/** The machine setup is about: one building, else the one that runs BB if it can be set up, else the first that can. */
export function setupTarget(machines: readonly MachineSetup[]): MachineSetup | null {
  return (
    machines.find(building) ??
    machines.find((setup) => setup.here && (setup.state === "ready" || setup.state === "fix")) ??
    machines.find((setup) => setup.state === "ready") ??
    machines.find((setup) => setup.state === "fix") ??
    null
  );
}

function useSetups() {
  const rpc = useRpc<Contract>();
  return useLive<{ machines: MachineSetup[] }>("setup.offer", () => rpc.call("setup.offer"), forThread(""));
}

const CARD = "rounded-lg border border-border bg-card px-4 py-4";

function Progress({ setup }: { setup: MachineSetup }) {
  const now = useNow(true, 1000);
  const build = setup.build!;
  const elapsed = Math.max(0, now - build.startedAt);
  const step = buildStep(build.detail);
  const share = Math.min(0.95, Math.max(elapsed / LINUX_BUILD_MS, step ? (step.step - 1) / step.of : 0));
  const left = LINUX_BUILD_MS - elapsed;
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">Setting up Docker on {whose(setup)}</p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">
        Building the Linux image · {left > 30_000 ? `about ${roughly(left)} left` : "almost done"}
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Building the Linux image" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">
        {step ? `Step ${step.step} of ${step.of} · ` : ""}Started {roughly(elapsed)} ago. It goes on if you close this panel.
      </p>
    </div>
  );
}

/** The build's progress above the panel's list, while Docker set up from here builds its image. */
export function SetupProgress() {
  const { value } = useSetups();
  const target = value ? value.machines.find(building) : undefined;
  return target ? <Progress setup={target} /> : null;
}

export function FirstRun({ fallback }: { fallback: ReactNode }) {
  const rpc = useRpc<Contract>();
  const { value, refresh } = useSetups();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = value ? setupTarget(value.machines) : null;
  if (!target) return <>{fallback}</>;
  if (building(target)) return <Progress setup={target} />;
  const other = (
    <UrlLink href={SETTINGS_PATH} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      Other backends
    </UrlLink>
  );
  const failed = target.build?.state === "failed" ? target.build.detail : null;
  if (target.state === "fix") {
    const check = async () => {
      setBusy(true);
      await refresh();
      setBusy(false);
    };
    return (
      <div className={CARD}>
        <p className="text-sm font-medium text-foreground">Set up BB Box</p>
        <p className="mt-1 text-xs leading-snug text-muted-foreground">{target.problem}</p>
        {target.fix ? (
          <>
            <CopyLine line={target.fix} />
            {target.restart ? <CopyLine line={target.restart} /> : null}
            <p className="mt-2 text-xs leading-snug text-subtle-foreground">{restartWords(target.restart)}</p>
          </>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={() => void check()} disabled={busy}>
            {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : <Icon name="ArrowReloadHorizontal" aria-hidden />}
            Check again
          </Button>
          {other}
        </div>
      </div>
    );
  }
  const start = async () => {
    setBusy(true);
    try {
      const answer = await rpc.call("setup.docker", { hostId: target.hostId });
      const result = answer.result;
      setProblem(result.ok ? null : result.reason === "problems" ? result.problems.map((item) => item.message).join(" ") : "Someone else saved BB Box's settings at the same moment. Try again.");
      await refresh();
    } catch (caught) {
      setProblem(message(caught));
    } finally {
      setBusy(false);
    }
  };
  const has = `${target.here ? "This machine" : target.name} has Docker ${target.docker}.`;
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">Set up BB Box</p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">{has} BB Box can make Linux boxes there.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" onClick={() => void start()} disabled={busy}>
          {busy ? <Icon name="Loading" className="animate-spin" aria-hidden /> : null}
          {failed ? "Try again" : `Use Docker on ${whose(target)}`}
        </Button>
        {other}
      </div>
      <p className={problem || failed ? "mt-2 text-xs leading-snug text-destructive-text" : "mt-2 text-xs text-subtle-foreground"} role={problem || failed ? "alert" : undefined}>
        {problem ?? (failed ? `The Linux image did not build: ${failed}` : `Builds the Linux image first, about ${roughly(LINUX_BUILD_MS)}.`)}
      </p>
    </div>
  );
}

/**
 * What the restart does, beside its line. A user service's restart restarts all of that user's services, so on a machine
 * where the user also has a desktop it ends its audio, notifications and the like too; logging out and in, or rebooting,
 * is the gentler way. Every way ends the turns of threads running there.
 */
export function restartWords(restart: string | null): string {
  if (!restart) return "Then restart BB there, or log out and in again, or reboot. That ends the turns of threads running there.";
  if (/^sudo systemctl restart user@\d+\.service$/.test(restart)) {
    return "The second line restarts all of that user's services, BB's daemon among them. That ends the turns of threads running there and, if the user has a desktop there, its audio, notifications and other services too. Logging out and in again, or rebooting, does the same more gently.";
  }
  return "The second line restarts BB's daemon there, which ends the turns of threads running there. Rebooting does the same.";
}

function CopyLine({ line }: { line: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{line}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 p-0 text-muted-foreground hover:text-foreground"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={() => {
          void navigator.clipboard?.writeText(line);
          setCopied(true);
        }}
      >
        <Icon name={copied ? "Check" : "Copy"} className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
