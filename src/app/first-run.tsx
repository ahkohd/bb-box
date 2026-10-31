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
import type { BoxView } from "../plugin/views.ts";
import { building, needsSignIn, restartWords, setupTarget, type MachineAccessProblem, type MachineSetup } from "../plugin/setup-offer.ts";
import { forThread, message, SETTINGS_PATH, useLive, useNow } from "./common.tsx";
import { REPOSITORY_URL } from "./settings-backends.tsx";

/**
 * How long the Linux image usually takes to build from an empty cache: 4 to 11 min in the newcomer checks, as it varies
 * with the host. A host that has built it says its own last time instead (`estimate`).
 */
export const LINUX_BUILD_WORDS = "5 to 12 min";
/** How long the desktop image usually takes, on a host that has the Linux image it starts from: 8 min where the Linux one took 11. */
export const DESKTOP_BUILD_WORDS = "4 to 10 min";
export const DESKTOPS_BUILD_WORDS = "8 to 16 min";
/** How long the panel says the Linux image is ready, while the thread has no box yet. */
export const READY_MS = 60 * 60_000;

/** A build's estimate: this host's last time when it has one, as "about 8 min", else the usual range, as "usually 4 to 10 min". */
export function estimate(took: number | null | undefined, range: string): string {
  return took ? `about ${roughly(took)}` : `usually ${range}`;
}

/** "1 min", "4 min", or seconds without a decimal under a minute. */
export function roughly(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function buildPlace(build: Pick<NonNullable<MachineSetup["build"]>, "step" | "image">): { readonly words: string | null; readonly share: number } {
  const { step, image } = build;
  if (!step) return { words: null, share: 0.03 };
  const images = image?.of ?? 1;
  const done = ((image?.at ?? 1) - 1 + (step.at - 1) / step.of) / images;
  const words = images > 1 ? `Image ${image!.at} of ${images}: step ${step.at} of ${step.of}` : `Step ${step.at} of ${step.of}`;
  return { words, share: Math.min(0.97, Math.max(0.03, done)) };
}

function usualTime(build: NonNullable<MachineSetup["build"]>, desktop: boolean): string {
  if (!desktop) return LINUX_BUILD_WORDS;
  return build.targets.length > 1 ? DESKTOPS_BUILD_WORDS : DESKTOP_BUILD_WORDS;
}

/** A build of desktop images alone, as when a desktop was first asked for. */
const isDesktopBuild = (build: NonNullable<MachineSetup["build"]>) => build.targets.length > 0 && build.targets.every((target) => target.startsWith("desktop"));
export const whose = (setup: MachineSetup) => (setup.here ? "this machine" : setup.name);

export function useSetups() {
  const rpc = useRpc<Contract>();
  return useLive<{ machines: MachineSetup[]; access: MachineAccessProblem | null }>("setup.offer", () => rpc.call("setup.offer"), forThread(""));
}

const CARD = "rounded-lg border border-border bg-card px-4 py-4";

export function Progress({ setup }: { setup: MachineSetup }) {
  const now = useNow(true, 1000);
  const build = setup.build!;
  const elapsed = Math.max(0, now - build.startedAt);
  const { words: place, share } = buildPlace(build);
  // A desktop's image alone, built when a desktop was first asked for, rather than first-run setup's Linux image.
  const desktop = isDesktopBuild(build);
  const what = desktop ? "the desktop image" : "the Linux image";
  const took = setup.took[desktop ? "desktop" : "linux"];
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">{desktop ? `Building the desktop image on ${whose(setup)}` : `Setting up Docker on ${whose(setup)}`}</p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">
        {desktop ? (place ?? "Starting") : `Building ${what} · ${place ?? "starting"}`}
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={`Building ${what}`} aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100}>
        <div className="h-full rounded-full bg-foreground/70 transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
      </div>
      <p className="mt-2 text-xs text-subtle-foreground">
        Started {roughly(elapsed)} ago. {took ? `It took ${roughly(took)} last time here` : `It usually takes ${usualTime(build, desktop)}`}, and goes on if you close this panel.
        {desktop && setup.boxFollows ? " The desktop box that was asked for follows." : ""}
      </p>
    </div>
  );
}

/**
 * Above the panel's list: the build's progress while Docker set up from here builds its image, then, while the thread has
 * no box yet, that the image is ready (the newcomer check: the card had just gone, with nothing to say what next).
 */
export function SetupProgress({ empty }: { empty: boolean }) {
  const { value } = useSetups();
  const now = useNow(false);
  if (!value) return null;
  const target = value.machines.find(building);
  if (target) return <Progress setup={target} />;
  // A desktop's image that did not build says why, for an hour; its box was not made.
  const failed = value.machines.find((setup) => setup.build?.state === "failed" && isDesktopBuild(setup.build) && setup.build.endedAt !== null && now - setup.build.endedAt < READY_MS);
  if (failed) {
    return (
      <div className={CARD} role="alert">
        <p className="text-sm font-medium text-foreground">The desktop image did not build</p>
        <p className="mt-1 text-xs leading-snug text-destructive-text">{failed.build!.detail}</p>
        <p className="mt-2 text-xs text-subtle-foreground">So the desktop box was not made. To try again, choose Desktop in New box.</p>
      </div>
    );
  }
  const ready = empty ? value.machines.find((setup) => setup.build?.state === "built" && setup.build.endedAt !== null && now - setup.build.endedAt < READY_MS) : undefined;
  if (!ready) return null;
  return (
    <div className={CARD}>
      <p className="text-sm font-medium text-foreground">The Linux image is ready</p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">Make a box with the plus.</p>
    </div>
  );
}

/** `others`: the link to settings for other backends, which settings itself leaves out, as the backends are under it. */
export function FirstRun({ fallback, others = true }: { fallback: ReactNode; others?: boolean }) {
  const rpc = useRpc<Contract>();
  const { value, refresh } = useSetups();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const target = value ? setupTarget(value.machines) : null;
  if (!target) return <>{fallback}</>;
  if (building(target)) return <Progress setup={target} />;
  const other = others ? (
    <UrlLink href={SETTINGS_PATH} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      Other backends
    </UrlLink>
  ) : null;
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
        {problem ?? (failed ? `The Linux image did not build: ${failed}` : `Builds the Linux image first, ${estimate(target.took.linux, LINUX_BUILD_WORDS)}.`)}
      </p>
      {value?.access ? (
        <p className="mt-2 text-xs leading-snug text-warning-text">
          Boxes will not join BB yet. <JoinHelp words={value.access.message} />
        </p>
      ) : null}
    </div>
  );
}

/** Where the guide says how boxes join BB, and what to do when they cannot. */
export const JOIN_GUIDE = `${REPOSITORY_URL}/docs/guide/boxes.md#when-a-box-does-not-join-bb`;

export function joinAdvice(box: Pick<BoxView, "joinTries">): boolean {
  return !box.joinTries || box.joinTries.setup;
}

/**
 * What to do when boxes cannot join BB, from BB's words. A box joins BB through BB's machine access, and BB's desktop
 * app starts with bb connect, which needs a sign-in (the newcomer check): then the words say the two ways out.
 */
export function JoinHelp({ words, advice = true }: { words: string | null; advice?: boolean }) {
  const guide = (
    <UrlLink href={JOIN_GUIDE} className="text-foreground underline underline-offset-2">
      How boxes join BB
    </UrlLink>
  );
  if (needsSignIn(words)) {
    return (
      <>
        BB's machine access, bb connect, needs you signed in to your bb account. Sign in to it in BB, or set Machine access to Manual in BB's settings, under Machines, with an address boxes can reach, and have BB listen there: started with npx bb-app, add --server-bind-host 0.0.0.0. {guide}
      </>
    );
  }
  return (
    <>
      {words ? `${words.replace(/\.?$/, ".")} ` : ""}
      {advice ? "See Machine access in BB's settings, under Machines. " : ""}
      {guide}
    </>
  );
}

export function CopyLine({ line, label = "Copy" }: { line: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-muted/40 py-1.5 pl-3 pr-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{line}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 p-0 text-muted-foreground hover:text-foreground"
        aria-label={copied ? "Copied" : label}
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
