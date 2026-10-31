import { experimental_Icon as Icon, experimental_usePluginId, UrlLink, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BoxPageState, Contract, ThreadOnBox } from "../plugin/contract.ts";
import type { BoxView } from "../plugin/views.ts";
import { Badge, boxTitleBadges, deviceModelOf, EmptyPanel, OPERATOR, osName, SETTINGS_PATH, StatusDot, systemName, useLive, useNow } from "./common.tsx";
import { BoxGlyph } from "./glyphs.tsx";
import { ThreadChips, threadTitle, WorkingMark } from "./thread-chips.tsx";
import { JoinHelp, joinAdvice } from "./first-run.tsx";
import { tryWords } from "../core/join-tries.ts";
import { BoxMenu, type MenuAsk } from "./box-menu.tsx";
import { ProblemLine, useMachineActions, useThreadBoxActions } from "./box-actions.tsx";
import { controlWord } from "./status.ts";
import { myViewers } from "./box-row.tsx";
import { boxesUrl, useBoxesNav, type WayBackTo } from "./box-nav.tsx";
import { boxPage, viewFromPage, type BoxPageRoute } from "./box-route.ts";
import { useThreadTitles } from "./desktop.tsx";
import { busyNow, busyUntil, type ShownBusy } from "./row-line.ts";
import { useWakeAt } from "./row-status.tsx";
import { Activity } from "./activity.tsx";
import { SnapshotNotices, SnapshotsCard, TakeSnapshotDialog, useSnapshotTitles } from "./snapshots-card.tsx";
import { boxViews, viewGlyph, type ViewChoice } from "./view-bar.tsx";
import {
  acquireSteps,
  actorWords,
  dayAndClock,
  driverOf,
  endedWords,
  failedNotice,
  headline,
  hostOf,
  joinedAfter,
  namedAfterReady,
  NOT_HERE_TITLE,
  NOT_HERE_WORDS,
  backendNotice,
  busyWords,
  notInSettings,
  reachNotice,
  releaseUnfinished,
  silentWhy,
  settingsNotice,
  span,
  startingAgain,
  startingSince,
  startSteps,
  stepName,
  stepTime,
  unreachableWhy,
  type ThreadTitles,
} from "./box-words.ts";

const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

const COPIED_MS = 1500;

const STEP_SHADES = ["opacity-90", "opacity-70", "opacity-55", "opacity-40", "opacity-30", "opacity-20"];

const LONGEST_STEPS = 4;

function boxPageKey(boxId: string): string {
  return `box:${boxId}`;
}

export const THREADS_RECHECK_MS = 15_000;

export function useBoxPage(boxId: string, { recheckThreads = false }: { recheckThreads?: boolean } = {}) {
  const rpc = useRpc<Contract>();
  const thread = useRef<string | null>(null);
  const live = useLive<BoxPageState>(
    boxPageKey(boxId),
    () => rpc.call("boxPage", { box: boxId }).then((state) => ({ ...state, busy: busyUntil(state.busy, Date.now()) })),
    (payload) => {
      const changed = (payload as { threadId?: unknown } | null)?.threadId;
      return changed === null || changed === undefined || thread.current === null || changed === thread.current || changed === OPERATOR;
    },
  );
  thread.current = live.value?.threadId ?? live.value?.ended?.thread ?? null;
  const { refresh } = live;
  useEffect(() => {
    if (!recheckThreads) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, THREADS_RECHECK_MS);
    return () => clearInterval(timer);
  }, [recheckThreads, refresh]);
  return live;
}

function isMoving(box: BoxView): boolean {
  return box.state === "acquiring" || box.state === "starting" || box.state === "stopping";
}

export function Trail({ back, here }: { back: WayBackTo; here: string }) {
  const words = back.place;
  const look = cn("-ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-muted-foreground hover:text-foreground", FOCUS);
  return (
    <nav aria-label="Where you are" className="flex min-w-0 items-center gap-x-1.5 text-xs">
      {"href" in back ? (
        <UrlLink href={back.href} className={look} aria-label={back.label}>
          <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
          {words}
        </UrlLink>
      ) : (
        <button type="button" onClick={back.go} className={look} aria-label={back.label}>
          <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
          {words}
        </button>
      )}
      <span aria-hidden className="text-subtle-foreground">
        ›
      </span>
      <span aria-current="page" className="min-w-0 truncate text-foreground">
        {here}
      </span>
    </nav>
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return [copied, copy];
}

function CopyValue({ value, label, mono = true }: { value: string; label: string; mono?: boolean }) {
  const [copied, copy] = useCopied();
  return (
    <button type="button" aria-label={`${label} ${value}: copy`} title="Copy" onClick={() => copy(value)} className={cn("inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left hover:text-foreground", mono && "font-mono", FOCUS)}>
      <span className="truncate">{value}</span>
      <Icon name={copied ? "Check" : "Copy"} className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function CopyLink({ url }: { url: string }) {
  const [copied, copy] = useCopied();
  return (
    <button type="button" className={cn("cursor-pointer rounded-sm hover:text-foreground", FOCUS)} onClick={() => copy(url)}>
      <span aria-live="polite">{copied ? "Copied" : "Copy link"}</span>
    </button>
  );
}

function ThreadLine({ page, now }: { page: BoxPageState; now: number }) {
  const navigate = useBbNavigate();
  if (page.owner === "yours") return null;
  const thread = page.thread;
  if (!thread || !page.threadId) return null;
  const title = threadTitle(thread);
  return (
    <p className="mt-3 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span>For</span>
      <button type="button" title={title} onClick={() => navigate.toThread(thread.id)} className={cn("inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2 text-foreground hover:bg-state-hover", FOCUS)}>
        {thread.running ? <WorkingMark /> : null}
        <span className="truncate">{title}</span>
        <Icon name="ArrowUpRight" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
      </button>
      <span>{thread.running ? "working now" : thread.activeAt !== undefined ? `idle for ${span(now - thread.activeAt)}` : "idle"}</span>
    </p>
  );
}

function showProcesses(): void {
  const processes = document.getElementById("processes");
  processes?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  document.getElementById("processes-heading")?.focus({ preventScroll: true });
}

function BusyWords({ words, toProcesses }: { words: string; toProcesses: boolean }) {
  return (
    <span data-busy className="text-warning-text">
      <span aria-hidden className="text-muted-foreground">
        ·{" "}
      </span>
      {toProcesses ? (
        <button type="button" className={cn("cursor-pointer rounded-sm underline-offset-2 hover:underline", FOCUS)} onClick={showProcesses}>
          {words}
        </button>
      ) : (
        words
      )}
    </span>
  );
}

function ViewButton({ route, view, describedBy }: { route: BoxPageRoute; view: ViewChoice; describedBy: string }) {
  const nav = useBoxesNav();
  if (view.why) {
    return (
      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled aria-describedby={describedBy}>
        {viewGlyph(view.view)}
        {view.words}
      </Button>
    );
  }
  const to = viewFromPage(route, view.view);
  return (
    <Button asChild variant="outline" size="sm" className="h-8 gap-1.5">
      <a href={nav.href(to)} onClick={nav.onLink(to)}>
        {viewGlyph(view.view)}
        {view.words}
      </a>
    </Button>
  );
}

interface PageActions {
  readonly act: (method: "stop" | "start" | "release" | "refresh" | "forget") => void;
  readonly busy: "stop" | "start" | null;
  readonly remove: () => void;
  readonly ask: (what: MenuAsk) => void;
  readonly resize: () => void;
}

function listWords(names: readonly string[]): string {
  return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function offWords(off: readonly { readonly name: string; readonly why: string }[]): string[] {
  const byWhy = new Map<string, string[]>();
  for (const { name, why } of off) byWhy.set(why, [...(byWhy.get(why) ?? []), name]);
  return [...byWhy].map(([why, names]) => `${listWords(names)} ${names.length === 1 ? "is" : "are"} off: ${why.replace(/^Its /, "its ")}.`);
}

function Header({ page, box, route, now, titles, actions, menu }: { page: BoxPageState; box: BoxView; route: BoxPageRoute; now: number; titles: ThreadTitles; actions: PageActions; menu: ReactNode }) {
  const pluginId = experimental_usePluginId();
  const heading = useRef<HTMLHeadingElement>(null);
  const reasonsId = useId();
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const head = headline(box, now, titles);
  const woken = useWakeAt((page.busy as ShownBusy | null | undefined)?.until ?? null);
  const busy = busyNow(page.busy, Math.max(now, woken));
  const unreachable = unreachableWhy(box);
  const stops = (box.canStopStart || notInSettings(box)) && box.state !== "releasing";
  const views = boxViews(box);
  const starts = stops && box.state === "stopped";
  const stopsNow = stops && (box.state === "ready" || box.state === "stopping");
  const off = [...views.flatMap((view) => (view.why ? [{ name: view.words, why: view.why }] : [])), ...(unreachable && (starts || stopsNow) ? [{ name: starts ? "Start" : "Stop", why: unreachable }] : [])];
  const reasons = offWords(off);
  return (
    <header>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <BoxGlyph />
          </span>
          <div className="min-w-0">
            <h1 ref={heading} tabIndex={-1} data-page-heading className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 focus:outline-none">
              <span className="truncate text-lg font-normal leading-tight tracking-[-0.01em] text-foreground">{box.name}</span>
              <span className="text-sm font-normal text-muted-foreground">{systemName(box)}</span>
              {deviceModelOf(box) ? <span className="text-sm font-normal text-foreground">{deviceModelOf(box)}</span> : null}
              <span className="flex items-center gap-1 self-center">
                {boxTitleBadges(box, false).map((badge) => (
                  <Badge key={badge.label}>{badge.label}</Badge>
                ))}
              </span>
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm">
              <StatusDot tone={head.tone} className="motion-reduce:[&_*]:animate-none" />
              <span className={cn("text-foreground", head.tone === "bad" && "text-destructive-text", head.tone === "warn" && "text-warning-text")}>{head.words}</span>
              {head.detail.map((detail) => (
                <span key={detail} className={cn("text-muted-foreground", detail === "Could not join BB" && "text-warning-text")}>
                  · {detail}
                </span>
              ))}
              {busy && box.state === "ready" ? <BusyWords words={busyWords(busy)} toProcesses={page.monitor.is === "read"} /> : null}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
              <CopyValue value={box.id} label="Box ID" />
              <CopyLink url={boxesUrl(pluginId, boxPage(box.id))} />
            </p>
            <ThreadLine page={page} now={now} />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5 sm:items-end">
          <div className="flex flex-wrap items-center gap-1.5">
            {views.map((view) => (
              <ViewButton key={view.view} route={route} view={view} describedBy={reasonsId} />
            ))}
            {starts ? (
              <Button type="button" size="sm" className="h-8 gap-1.5" disabled={actions.busy !== null || !!unreachable} aria-describedby={unreachable ? reasonsId : undefined} onClick={() => actions.act("start")}>
                <Icon name={actions.busy === "start" ? "Loading" : "Play"} className={cn("size-4", actions.busy === "start" && "animate-spin motion-reduce:animate-none")} aria-hidden />
                Start
              </Button>
            ) : null}
            {stopsNow ? (
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={actions.busy !== null || box.state === "stopping" || !!unreachable} aria-describedby={unreachable ? reasonsId : undefined} onClick={() => actions.act("stop")}>
                <Icon name={actions.busy === "stop" || box.state === "stopping" ? "Loading" : "Square"} className={cn("size-4", (actions.busy === "stop" || box.state === "stopping") && "animate-spin motion-reduce:animate-none")} aria-hidden />
                Stop
              </Button>
            ) : null}
            {menu}
          </div>
          {reasons.length ? (
            <p id={reasonsId} data-off-reasons className="max-w-sm text-xs leading-snug text-muted-foreground sm:text-right">
              {reasons.join(" ")}
            </p>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function PageNotice({ tone, title, children, actions }: { tone: "bad" | "warn"; title: string; children?: ReactNode; actions?: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} data-notice={tone} className={cn("rounded-lg border px-4 py-3", tone === "bad" ? "border-surface-destructive-border bg-surface-destructive" : "border-warning/40 bg-warning/5")}>
      <h2 id={headingId} className={cn("text-sm font-normal", tone === "bad" ? "text-destructive-text" : "text-warning-text")}>
        {title}
      </h2>
      {children ? <div className="mt-1 text-sm text-foreground">{children}</div> : null}
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">{actions}</div> : null}
    </section>
  );
}

function SmallButton({ words, onClick, danger = false, disabled = false, why }: { words: string; onClick: () => void; danger?: boolean; disabled?: boolean; why?: string | null }) {
  const whyId = useId();
  return (
    <>
      <Button type="button" variant="outline" size="sm" className={cn("h-7", danger && "text-destructive-text")} disabled={disabled || !!why} aria-describedby={why ? whyId : undefined} onClick={onClick}>
        {words}
      </Button>
      {why ? (
        <span id={whyId} className="text-xs text-muted-foreground">
          {offWords([{ name: words.replace(/…$/, ""), why }])[0]}
        </span>
      ) : null}
    </>
  );
}

interface Said {
  readonly key: string;
  readonly speech: string;
}

function useAnnounceNew(said: readonly Said[], announce: (speech: string) => void): void {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const latest = useRef({ said, announce });
  latest.current = { said, announce };
  const keys = said.map((each) => each.key).join("\n");
  useEffect(() => {
    const before = seen.current;
    const { said: now, announce: say } = latest.current;
    seen.current = new Set(now.map((each) => each.key));
    if (!before) return;
    const fresh = now.filter((each) => !before.has(each.key));
    if (fresh.length) say(fresh.map((each) => each.speech).join(" "));
  }, [keys]);
}

function Notices({ page, box, now, actions, announce }: { page: BoxPageState; box: BoxView; now: number; actions: PageActions; announce: (speech: string) => void }) {
  const yours = page.owner === "yours";
  const gone = notInSettings(box);
  const unreachable = unreachableWhy(box);
  const failed = failedNotice(box, now);
  const reach = reachNotice(box, now);
  const backend = backendNotice(box);
  const settings = settingsNotice(box);
  const release = () => (yours ? actions.remove() : actions.ask("release"));
  const notices: ReactNode[] = [];
  const said: Said[] = [];
  const note = (key: string, heading: string, words: string) => said.push({ key: `${key}\n${heading}\n${words}`, speech: `${heading}. ${words}` });
  if (failed) {
    const retry =
      failed.operation === "release" ? (
        gone ? null : (
          <SmallButton words={yours ? "Remove again…" : "Release again…"} danger onClick={release} />
        )
      ) : failed.operation === "resize" ? (
        <SmallButton words="Resize…" why={unreachable} onClick={actions.resize} />
      ) : failed.operation === "stop" && box.state === "ready" ? (
        <SmallButton words="Stop again" why={unreachable} disabled={actions.busy !== null} onClick={() => actions.act("stop")} />
      ) : failed.operation === "start" && box.state === "stopped" ? (
        <SmallButton words="Start again" why={unreachable} disabled={actions.busy !== null} onClick={() => actions.act("start")} />
      ) : null;
    const words = [failed.words, failed.then].filter(Boolean).join(" ");
    note("failed", failed.heading, words);
    notices.push(
      <PageNotice key="failed" tone="bad" title={failed.title} actions={retry}>
        {words}
      </PageNotice>,
    );
  } else if (box.error && !box.log?.lastFailed && box.state !== "failed" && box.state !== "releasing") {
    note("error", "Its last change failed", box.error);
    notices.push(<PageNotice key="error" tone="bad" title="Its last change failed">{box.error}</PageNotice>);
  }
  if (settings) {
    note("settings", "Its backend is not in settings", settings);
    notices.push(
      <PageNotice
        key="settings"
        tone="warn"
        title="Its backend is not in settings"
        actions={
          <>
            <Button asChild variant="outline" size="sm" className="h-7">
              <UrlLink href={SETTINGS_PATH}>Open BB Box settings</UrlLink>
            </Button>
            <SmallButton words="Forget…" danger onClick={() => actions.ask("forget")} />
          </>
        }
      >
        {settings}
      </PageNotice>,
    );
  }
  for (const [key, told] of [["backend", backend], ["reach", reach]] as const) {
    if (!told) continue;
    note(key, told.title, told.words);
    notices.push(
      <PageNotice key={key} tone="warn" title={told.title} actions={<SmallButton words="Check now" onClick={() => actions.act("refresh")} />}>
        {told.words}
        {told.next ? <span className="mt-1 block text-xs text-muted-foreground">{told.next}</span> : null}
      </PageNotice>,
    );
  }
  if (box.state === "failed") {
    note("did-not-start", "It did not start", box.error ?? "");
    notices.push(
      <PageNotice
        key="did-not-start"
        tone="bad"
        title="It did not start"
        actions={
          <>
            <SmallButton words="Check now" onClick={() => actions.act("refresh")} />
            {gone ? null : <SmallButton words={yours ? "Remove…" : "Release…"} danger onClick={release} />}
          </>
        }
      >
        {box.error ?? undefined}
      </PageNotice>,
    );
  }
  if (box.stopped) {
    note("unasked", "It stopped without being asked", box.stopped);
    notices.push(<PageNotice key="unasked" tone="warn" title="It stopped without being asked">{box.stopped}</PageNotice>);
  }
  if (page.deviceFailed && box.state === "ready") {
    note("device", `Its ${page.deviceFailed.model} did not boot`, page.deviceFailed.words);
    notices.push(
      <PageNotice key="device" tone="warn" title={`Its ${page.deviceFailed.model} did not boot`} actions={<SmallButton words="Check now" onClick={() => actions.act("refresh")} />}>
        {page.deviceFailed.words}
      </PageNotice>,
    );
  }
  if (box.state === "ready" && box.enrol.state === "failed") {
    note("join", "It could not join BB", box.enrol.error ?? "");
    notices.push(
      <PageNotice key="join" tone="warn" title="It could not join BB">
        <JoinHelp words={box.enrol.error} advice={joinAdvice(box)} />
      </PageNotice>,
    );
  }
  useAnnounceNew(said, announce);
  return notices.length ? <div className="space-y-3">{notices}</div> : null;
}

function Starting({ box, now }: { box: BoxView; now: number }) {
  const again = startingAgain(box);
  const steps = again ? [] : acquireSteps(box.timings);
  return (
    <section aria-label="Starting" className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <Icon name="Loading" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        {again ? "Starting again" : "Starting"} for <span className="tabular-nums">{span(now - startingSince(box))}</span>
      </p>
      <ol className="mt-2 space-y-1 text-xs">
        {steps.map(([step, ms]) => (
          <li key={step} className="flex items-center gap-2 text-muted-foreground">
            <Icon name="Check" className="size-3.5 text-success" aria-hidden />
            <span className="text-foreground">{stepName(step)}</span>
            <span className="tabular-nums">{stepTime(ms)}</span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-muted-foreground">
          <span className="flex size-3.5 items-center justify-center">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
          </span>
          {box.waitingOn ?? (again ? "Waiting for it to boot and answer" : "Waiting for the next step")}
        </li>
      </ol>
      <p className="mt-2 text-xs text-subtle-foreground">This page follows it: the rest shows here once it is ready.</p>
    </section>
  );
}

function Fact({ label, children, second }: { label: string; children: ReactNode; second?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5 px-4 py-3">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">
        {children}
        {second ? <span className="block text-xs text-muted-foreground">{second}</span> : null}
      </dd>
    </div>
  );
}

function formWords(box: BoxView): string {
  if (box.shared) return "A shared slot";
  switch (box.form) {
    case "LXC":
      return "LXC container";
    case "Docker":
      return "Docker container";
    case "VM":
      return "VM";
    case "microVM":
      return "microVM";
    case "Physical":
      return "Physical machine";
    default:
      return "Box";
  }
}

function hostWords(box: BoxView): string | null {
  return box.slotHost ?? hostOf(box.backendLabel);
}

function sizeWords(box: BoxView): string {
  const host = hostWords(box);
  if (box.shared) return host ? `A share of ${host}` : "A share of its Mac";
  return box.sizeNow?.words ?? box.size ?? "Not known";
}

function systemWords(box: BoxView): string {
  return `${osName(box.os)} ${box.arch}${box.docker ? ", with Docker" : ""}`;
}

function joiningSecond(tries: NonNullable<BoxView["joinTries"]>, now: number): string | null {
  const last = tries.failed > 0 && tries.words ? `Try ${tries.failed} failed: ${tries.words}` : null;
  const next = tries.next === null ? null : `Next try in ${span(Math.max(0, tries.next - now))}.`;
  return [last, next].filter(Boolean).join(" ") || null;
}

function enrolFact(box: BoxView, now: number): { first: string; second: string | null } {
  switch (box.enrol.state) {
    case "enrolled":
      return { first: "Joined", second: box.state === "ready" && !silentWhy(box) ? "Threads can run on it" : "Offline now" };
    case "enrolling":
      return box.joinTries ? { first: `Joining, ${tryWords(box.joinTries.failed)}`, second: joiningSecond(box.joinTries, now) } : { first: "Joining…", second: null };
    case "failed":
      return { first: "Could not join", second: box.enrol.error };
    default:
      return { first: box.enrols ? "Off" : "Not for this kind", second: null };
  }
}

function resizeWords(box: BoxView): string {
  const ways = box.resizing;
  if (!ways) return "Not offered for this box";
  const parts = ["cores", "memory", "disk"] as const;
  const live = parts.filter((part) => ways[part] === "live");
  const restart = parts.filter((part) => ways[part] === "restart");
  const list = (each: readonly string[]) => (each.length === 1 ? each[0]! : `${each.slice(0, -1).join(", ")} and ${each.at(-1)}`);
  const first = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
  if (!live.length && !restart.length) return "Not offered for this box";
  if (!restart.length) return `${first(list(live))}, while it runs`;
  return [live.length ? `${first(list(live))} now` : null, `${live.length ? list(restart) : first(list(restart))} with a restart`].filter(Boolean).join("; ");
}

function factOf(box: BoxView, pattern: RegExp): string | null {
  return box.facts.find((fact) => pattern.test(fact.label))?.value ?? null;
}

function controlFact(box: BoxView): string | null {
  if (!box.control) return null;
  if (box.control.owner === "agent") return "The agent has control";
  return controlWord(box, myViewers())?.text ?? null;
}

function Facts({ box, now }: { box: BoxView; now: number }) {
  const gone = notInSettings(box);
  const enrol = enrolFact(box, now);
  const host = hostWords(box);
  const control = controlFact(box);
  return (
    <section aria-label="Facts" className="overflow-hidden rounded-lg border border-border bg-card">
      <dl className="-mb-px -mr-px grid grid-cols-2 lg:grid-cols-4 [&>*]:border-b [&>*]:border-r [&>*]:border-border">
        <Fact label="Kind">{box.kindLabel}</Fact>
        <Fact label="Size">{sizeWords(box)}</Fact>
        <Fact label="Runs on" second={gone ? "Backend not in settings" : driverOf(box.backendLabel)}>
          <span className={cn(gone && "text-muted-foreground")}>
            {formWords(box)}
            {host ? ` on ${host}` : ""}
          </span>
        </Fact>
        <Fact label="Address">{box.address ? <CopyValue value={box.address} label="Address" /> : <span className="text-muted-foreground">{box.state === "stopped" ? "None while stopped" : "Not yet"}</span>}</Fact>
        <Fact label="System">{systemWords(box)}</Fact>
        <Fact label="BB machine" second={enrol.second}>
          {enrol.first}
        </Fact>
        <Fact label="Made" second={dayAndClock(box.createdAt, now)}>
          {span(now - box.createdAt)} ago
        </Fact>
        {box.device ? (
          <Fact label="Device" second={[factOf(box, /runtime|ios|android/i), control ? `control: ${control.replace(/ has control$/, "").toLowerCase()}` : null].filter(Boolean).join(" · ") || null}>
            {box.device.model ?? "Not known"}
          </Fact>
        ) : control ? (
          <Fact label="Desktop" second={factOf(box, /display/i)}>
            {control}
          </Fact>
        ) : (
          <Fact label="Resize">{resizeWords(box)}</Fact>
        )}
      </dl>
    </section>
  );
}

function ThreadsCard({ page, box, onNewThread }: { page: BoxPageState; box: BoxView; onNewThread: (() => void) | null }) {
  const yours = page.owner === "yours";
  const others = page.threads.filter((thread) => thread.id !== page.thread?.id);
  const unreachable = silentWhy(box);
  const online = box.enrol.state === "enrolled" && box.state === "ready" && !unreachable;
  const none = online ? "None now. A thread can run on its BB machine." : box.enrol.state === "enrolled" ? "None. Its BB machine is offline now." : "None. It is not a BB machine, so no thread can run on it.";
  return (
    <section aria-labelledby="threads-heading" className="rounded-lg border border-border bg-card px-4 py-3">
      <h2 id="threads-heading" className="text-sm font-normal text-foreground">
        {yours ? "Threads on this machine" : "Other threads on it"}
      </h2>
      {others.length ? <ThreadChips threads={others} className="mt-2" /> : <p className="mt-1 text-xs text-muted-foreground">{none}</p>}
      {onNewThread && box.enrol.state === "enrolled" && box.state === "ready" ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          <SmallButton words="New thread on this box…" why={unreachable} onClick={onNewThread} />
        </div>
      ) : null}
    </section>
  );
}

function HowItStarted({ box, now, titles }: { box: BoxView; now: number; titles: ThreadTitles }) {
  const afterwards = namedAfterReady(box.timings);
  const steps = acquireSteps(box.timings).filter(([step, ms]) => ms > 0 && !(afterwards !== null && step === "relabel"));
  const total = box.timings.total ?? steps.reduce((sum, [, ms]) => sum + ms, 0);
  const longest = new Set([...steps].sort((a, b) => b[1] - a[1]).slice(0, LONGEST_STEPS).map(([step]) => step));
  const joined = joinedAfter(box.timings);
  const lastStart = box.log?.lastStart;
  const restart = lastStart && !lastStart.first && lastStart.readyAt !== null ? lastStart : null;
  const restartSteps = startSteps(box.timings).filter(([step]) => step !== "start.total");
  const by = restart ? actorWords(restart.by, titles) : null;
  const quicker = steps.length - longest.size;
  const summary = [quicker > 0 ? `And ${quicker} quicker ${quicker === 1 ? "step" : "steps"}.` : null, afterwards !== null ? `Once it was ready, bb-box named it for its thread in ${stepTime(afterwards)}.` : null, joined !== null ? `It joined BB ${stepTime(joined)} later.` : null, `Made ${dayAndClock(box.createdAt, now)}.`].filter(Boolean).join(" ");
  return (
    <section aria-labelledby="started-heading" className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="started-heading" className="text-sm font-normal text-foreground">
          How it started
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{box.state === "failed" ? "Did not finish" : total > 0 ? `Ready in ${stepTime(total)}` : ""}</span>
      </div>
      {steps.length ? (
        <>
          <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-recessed" role="img" aria-label={`The time each step took: ${steps.map(([step, ms]) => `${stepName(step)} ${stepTime(ms)}`).join(", ")}`}>
            {steps.map(([step, ms], index) => (
              <span key={step} className={cn("h-full bg-foreground", STEP_SHADES[index % STEP_SHADES.length], index && "border-l border-card")} style={{ width: `${(ms / Math.max(total, 1)) * 100}%` }} />
            ))}
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {steps
              .filter(([step]) => longest.has(step))
              .map(([step, ms]) => (
                <div key={step} className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">{stepName(step)}</dt>
                  <dd className="tabular-nums text-foreground">{stepTime(ms)}</dd>
                </div>
              ))}
          </dl>
        </>
      ) : null}
      <p className="mt-2 text-xs text-subtle-foreground">{summary}</p>
      {restart && restart.readyAt !== null ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
          Last started {dayAndClock(restart.askedAt, now)}
          {by ? `, ${by}` : ""}: ready in {stepTime(restart.readyAt - restart.askedAt)}
          {restartSteps.length ? ` (${restartSteps.map(([step, ms]) => `${stepName(step).toLowerCase()} ${stepTime(ms)}`).join(", ")})` : ""}.
        </p>
      ) : null}
    </section>
  );
}

export function NotHere({ page, back, now }: { page: BoxPageState | null; back: WayBackTo; now: number }) {
  const ended = page?.ended ?? null;
  const titles = useActorTitles(ended?.by?.is === "agent" ? [ended.by.threadId] : [], null);
  const words = ended ? endedWords(ended, now, titles) : { title: NOT_HERE_TITLE, words: NOT_HERE_WORDS };
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  return (
    <PageFrame>
      <Trail back={back} here={ended?.name ?? "Not here"} />
      <EmptyPanel>
        <p ref={heading} tabIndex={-1} className="font-normal text-foreground focus:outline-none">
          {words.title}
        </p>
        <p className="mt-1">{words.words}</p>
        {"href" in back ? (
          <Button asChild variant="outline" size="sm" className="mt-3 h-7">
            <UrlLink href={back.href}>{back.label}</UrlLink>
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={back.go}>
            {back.label}
          </Button>
        )}
      </EmptyPanel>
    </PageFrame>
  );
}

function PageFrame({ children, dimmed = false }: { children: ReactNode; dimmed?: boolean }) {
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className={cn("mx-auto box-border w-full max-w-5xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4", dimmed && "opacity-60")}>{children}</div>
    </div>
  );
}

export function Loading({ back, error }: { back: WayBackTo; error: string | null }) {
  return (
    <PageFrame>
      <Trail back={back} here="Box" />
      {error ? <EmptyPanel role="alert">{error}</EmptyPanel> : <p role="status" className="sr-only">Loading the box</p>}
    </PageFrame>
  );
}

export function BoxPage({ route }: { route: BoxPageRoute }) {
  const nav = useBoxesNav();
  const { value: page, error, refresh } = useBoxPage(route.boxId, { recheckThreads: true });
  const box = page?.box ?? null;
  const now = useNow(true, box && isMoving(box) ? 1000 : 15_000);
  const back = nav.back(route, box?.name ?? null);
  const refreshAll = () => refresh();
  const threadActions = useThreadBoxActions(refreshAll);
  const machineActions = useMachineActions(refreshAll);
  const [asking, setAsking] = useState<MenuAsk>(null);
  const [resizing, setResizing] = useState(false);
  const [announced, setAnnounced] = useState("");
  const [takingSnapshot, setTakingSnapshot] = useState(false);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const titles = useActorTitles(actorThreads(box), page?.thread ?? null);
  const snapshotTitles = useSnapshotTitles(page?.snapshots);
  if (!page) return <Loading back={back} error={error} />;
  if (!box) return <NotHere page={page} back={back} now={now} />;
  const yours = page.owner === "yours";
  const threadId = page.threadId ?? OPERATOR;
  const busyOf = (busy: string | null): "stop" | "start" | null => (busy === `stop:${box.id}` ? "stop" : busy === `start:${box.id}` ? "start" : null);
  const act = (method: "stop" | "start" | "release" | "refresh" | "forget") => void (yours ? machineActions.act(method === "release" ? "remove" : method, box) : threadActions.act(threadId, method, box));
  const actions: PageActions = {
    act,
    busy: busyOf(yours ? machineActions.busy : threadActions.busy),
    remove: () => machineActions.askRemove(box),
    ask: setAsking,
    resize: () => setResizing(true),
  };
  const opens = { screen: () => undefined, terminal: () => undefined };
  const snapshots = page.snapshots ?? null;
  const restoring = !!snapshots?.restoring;
  const snapshotsShown = !!snapshots && box.state !== "acquiring" && (box.state !== "starting" || restoring) && box.state !== "failed" && box.state !== "releasing";
  const takeSnapshot = snapshotsShown && snapshots.offer ? { why: snapshots.restoring ? "It is being restored." : snapshots.takeWhy, take: () => setTakingSnapshot(true) } : null;
  const menu = (
    <BoxMenu
      box={box}
      of={yours ? { owner: "yours", inBrowser: false, stop: () => act("stop"), start: () => act("start"), remove: actions.remove, forget: () => act("forget"), check: () => act("refresh") } : { owner: "thread", threadId, held: false, offersThread: true, act: (method) => act(method) }}
      opens={opens}
      resizing={resizing}
      onResizing={setResizing}
      place="page"
      asking={asking}
      onAsking={setAsking}
      takeSnapshot={takeSnapshot}
      triggerRef={menuTrigger}
    />
  );
  const starting = box.state === "acquiring" || (box.state === "starting" && !restoring);
  const failed = box.state === "failed";
  const problem = yours ? machineActions.problem : threadActions.problem;
  return (
    <PageFrame dimmed={box.state === "releasing" && !releaseUnfinished(box)}>
      <Trail back={back} here={box.name} />
      <Header page={page} box={box} route={route} now={now} titles={titles} actions={actions} menu={menu} />
      <ProblemLine problem={problem} onDismiss={() => (yours ? machineActions.setProblem(null) : threadActions.setProblem(null))} />
      <Notices page={page} box={box} now={now} actions={actions} announce={setAnnounced} />
      {snapshotsShown ? <SnapshotNotices box={box} view={snapshots} now={now} titles={snapshotTitles} onChanged={refreshAll} /> : null}
      <p aria-live="polite" data-announcer className="sr-only">
        {announced}
      </p>
      {starting ? <Starting box={box} now={now} /> : null}
      {starting ? null : <Activity page={page} box={box} now={now} />}
      {snapshotsShown ? <SnapshotsCard box={box} view={snapshots} now={now} titles={snapshotTitles} onChanged={refreshAll} /> : null}
      {starting ? null : <Facts box={box} now={now} />}
      {starting ? null : failed ? (
        <HowItStarted box={box} now={now} titles={titles} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <ThreadsCard page={page} box={box} onNewThread={yours ? null : () => setAsking("thread")} />
          <HowItStarted box={box} now={now} titles={titles} />
        </div>
      )}
      {yours ? machineActions.dialogs : threadActions.dialogs}
      {takingSnapshot && snapshots?.offer ? <TakeSnapshotDialog box={box} view={snapshots} now={now} returnTo={menuTrigger} onClose={() => setTakingSnapshot(false)} onChanged={refreshAll} /> : null}
    </PageFrame>
  );
}

function useActorTitles(threadIds: readonly string[], holder: ThreadOnBox | null): ThreadTitles {
  const fetched = useThreadTitles(threadIds.filter((id) => id !== holder?.id));
  return holder ? { ...fetched, [holder.id]: threadTitle(holder) } : fetched;
}

function actorThreads(box: BoxView | null): string[] {
  const actors = [box?.log?.lastStart?.by, box?.log?.lastStop?.by];
  return actors.flatMap((actor) => (actor?.is === "agent" ? [actor.threadId] : []));
}
