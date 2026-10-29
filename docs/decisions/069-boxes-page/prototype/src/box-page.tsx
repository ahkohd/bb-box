import { useEffect, useRef, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Badge, boxTitleBadges, EmptyPanel, StatusDot, systemName, deviceModelOf } from "@/src/app/common.tsx";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { ThreadChips } from "@/src/app/thread-chips.tsx";
import { BoxMenu, openingsOf, openView, unreachableWhy, useReleaseDialog } from "./actions";
import { Activity, Processes } from "./activity";
import { machineThreads, type FakeBox, type FakeThread } from "./data";
import { go, goBackOr, type Route } from "./nav";
import { useStore } from "./store";
import { actorWords, ago, busyItem, clock, controlWords, dayAndClock, enrolWords, formOf, headline, span, startSince, STEP_NAMES, systemWords } from "./words";

const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function TopRow({ trail }: { trail: readonly { words: string; go?: () => void }[] }) {
  return (
    <nav aria-label="Where you are" className="flex min-w-0 items-center gap-x-1.5 text-xs">
      {trail.map((step, index) => (
        <span key={step.words} className="flex min-w-0 items-center gap-x-1.5">
          {index ? (
            <span aria-hidden className="text-subtle-foreground">
              ›
            </span>
          ) : null}
          {step.go ? (
            <button type="button" onClick={step.go} className={cn("inline-flex cursor-pointer items-center gap-0.5 rounded-sm text-muted-foreground hover:text-foreground", index === 0 && "-ml-1 px-1", FOCUS)}>
              {index === 0 ? <Icon name="ChevronLeft" className="size-3.5" aria-hidden /> : null}
              {step.words}
            </button>
          ) : (
            <span aria-current="page" className="min-w-0 truncate text-foreground">
              {step.words}
            </span>
          )}
        </span>
      ))}
    </nav>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5 px-4 py-3">
      <dt className="text-xs text-subtle-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-foreground">{children}</dd>
    </div>
  );
}

function CopyValue({ value, words, label }: { value: string; words?: string; label?: string }) {
  const store = useStore();
  return (
    <button type="button" aria-label={label ? `${label} ${value}: copy` : `Copy ${value}`} onClick={() => store.say(`Copied ${value}`)} className={cn("group inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left font-mono hover:text-foreground", FOCUS)} title="Copy">
      <span className="truncate">{words ?? value}</span>
      <Icon name="Copy" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
    </button>
  );
}

function resizeWords(view: FakeBox["view"]): string {
  const ways = view.resizing;
  if (!ways) return "Not offered for this kind";
  const live = (["cores", "memory", "disk"] as const).filter((part) => ways[part] === "live");
  const restart = (["cores", "memory", "disk"] as const).filter((part) => ways[part] === "restart");
  const list = (parts: readonly string[]) => (parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);
  const first = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);
  if (!restart.length) return `${first(list(live))}, while it runs`;
  return [live.length ? `${first(list(live))} now` : null, `${live.length ? list(restart) : first(list(restart))} with a restart`].filter(Boolean).join("; ");
}

function Facts({ box, now }: { box: FakeBox; now: number }) {
  const view = box.view;
  const control = controlWords(view);
  const gone = !!box.backendGone;
  return (
    <section aria-label="Facts" className="overflow-hidden rounded-lg border border-border bg-card">
      <dl className="-mb-px -mr-px grid grid-cols-2 lg:grid-cols-4 [&>*]:border-b [&>*]:border-r [&>*]:border-border">
        <Fact label="Kind">{view.kindLabel}</Fact>
        <Fact label="Size">{view.sizeNow ? `${view.sizeNow.cores} cores, ${view.sizeNow.memoryGiB} GiB memory, ${view.sizeNow.diskGiB ?? "base"} GiB disk` : box.shared ? `A share of ${box.shared.name} (${box.shared.cores} cores, ${box.shared.memoryGiB} GiB)` : view.size ?? "Not known"}</Fact>
        <Fact label="Runs on">
          <span className={cn(gone && "text-muted-foreground")}>
            {formOf(view)} on {view.backendLabel.replace(/^.* on /, "")}
          </span>
          <span className="block text-xs text-muted-foreground">{gone ? "Backend not in settings" : view.backendLabel.replace(/ on [^ ]+$/, "")}</span>
        </Fact>
        <Fact label="Address">{view.address ? <CopyValue value={view.address} label="Address" /> : <span className="text-muted-foreground">{view.state === "stopped" ? "None while stopped" : "Not yet"}</span>}</Fact>
        <Fact label="System">{systemWords(view)}</Fact>
        <Fact label="BB machine">
          {enrolWords(view)}
          {view.enrol.state === "enrolled" ? <span className="block text-xs text-muted-foreground">{view.state === "ready" && !box.unreachable && !gone ? "Threads can run on it" : "Offline now"}</span> : null}
        </Fact>
        <Fact label="Made">
          {span(now - view.createdAt)} ago
          <span className="block text-xs text-muted-foreground">{dayAndClock(view.createdAt, now)}</span>
        </Fact>
        {view.device ? (
          <Fact label="Device">
            {view.device.model}
            <span className="block text-xs text-muted-foreground">
              {view.facts.find((fact) => fact.label === "Runtime")?.value ?? ""}
              {control ? ` · control: ${control.toLowerCase()}` : ""}
            </span>
          </Fact>
        ) : control ? (
          <Fact label="Desktop">
            {control === "The agent" ? "The agent has control" : control === "You, in this tab" ? "You have control" : control}
            <span className="block text-xs text-muted-foreground">{view.facts.find((fact) => fact.label === "Display")?.value ?? ""}</span>
          </Fact>
        ) : (
          <Fact label="Resize">{resizeWords(view)}</Fact>
        )}
      </dl>
    </section>
  );
}

function ThreadLine({ box, thread, now }: { box: FakeBox; thread: FakeThread | null; now: number }) {
  if (box.owner === "yours") return <p className="text-xs text-muted-foreground">One of your machines. It shows in BB's machine list, and threads can run on it.</p>;
  if (!thread) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
      <span>For</span>
      <button type="button" onClick={() => go({ page: "thread", id: thread.id })} className={cn("inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2 text-foreground hover:bg-state-hover", FOCUS)}>
        {thread.running ? <Icon name="Loading" className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Working" /> : null}
        <span className="truncate">{thread.title}</span>
        <Icon name="ArrowUpRight" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
      </button>
      <span>{thread.running ? "working now" : `idle for ${span(now - thread.activeAt)}`}</span>
    </p>
  );
}

function Gated({ why, children }: { why: string | null; children: ReactNode }) {
  return why ? (
    <span title={why} className="inline-flex">
      {children}
    </span>
  ) : (
    <>{children}</>
  );
}

function Header({ box, thread, now, onRelease }: { box: FakeBox; thread: FakeThread | null; now: number; onRelease: () => void }) {
  const store = useStore();
  const view = box.view;
  const head = headline(box, now, store.threads);
  const busy = busyItem(box, now);
  const unreachable = unreachableWhy(box);
  const openings = openingsOf(view).map((opening) => ({ ...opening, closedBecause: opening.closedBecause ?? unreachable }));
  const acting = store.busy.has(view.id);
  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <BoxGlyph />
          </span>
          <div className="min-w-0">
            <h1 tabIndex={-1} data-page-heading className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 focus:outline-none">
              <span className="truncate text-lg font-medium leading-tight tracking-[-0.01em] text-foreground">{view.name}</span>
              <span className="text-sm text-muted-foreground">{systemName(view)}</span>
              {deviceModelOf(view) ? <span className="text-sm text-foreground">{deviceModelOf(view)}</span> : null}
              <span className="flex items-center gap-1 self-center">
                {boxTitleBadges(view, false).map((badge) => (
                  <Badge key={badge.label}>{badge.label}</Badge>
                ))}
              </span>
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm">
              <StatusDot tone={head.tone} />
              <span className={cn("text-foreground", head.tone === "bad" && "text-destructive-text", head.tone === "warn" && !busy && "text-warning-text")}>{head.words}</span>
              {head.detail ? <span className="text-muted-foreground">· {head.detail}</span> : null}
              {busy ? (
                <a
                  href="#processes"
                  onClick={(event) => {
                    event.preventDefault();
                    document.getElementById("processes")?.scrollIntoView({ block: "start" });
                  }}
                  className="text-warning-text underline-offset-2 hover:underline"
                >
                  · {busy.text}
                </a>
              ) : null}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-subtle-foreground">
              <CopyValue value={view.id} label="Box ID" />
              <button type="button" className={cn("cursor-pointer rounded-sm hover:text-foreground", FOCUS)} onClick={() => store.say("Copied a link to this page")}>
                Copy link
              </button>
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {openings.map((opening) => (
            <Gated key={opening.view} why={opening.closedBecause}>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={opening.closedBecause !== null} onClick={() => openView(view.id, opening.view, "box")}>
                {opening.glyph("size-4")}
                {opening.words}
              </Button>
            </Gated>
          ))}
          {view.canStopStart && view.state === "stopped" ? (
            <Gated why={unreachable}>
              <Button type="button" size="sm" className="h-8 gap-1.5" disabled={acting || !!unreachable} onClick={() => store.act("start", view.id)}>
                <Icon name={acting ? "Loading" : "Play"} className={cn("size-4", acting && "animate-spin")} aria-hidden />
                Start
              </Button>
            </Gated>
          ) : null}
          {view.canStopStart && (view.state === "ready" || view.state === "stopping") ? (
            <Gated why={unreachable}>
              <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={acting || !!unreachable} onClick={() => store.act("stop", view.id)}>
                <Icon name={acting ? "Loading" : "Square"} className={cn("size-4", acting && "animate-spin")} aria-hidden />
                Stop
              </Button>
            </Gated>
          ) : null}
          <BoxMenu
            box={box}
            onRelease={onRelease}
            offerOpenings={false}
            trigger={
              <Button type="button" variant="outline" size="icon" className="size-8 p-0 text-muted-foreground hover:text-foreground" aria-label={`${view.name} actions`}>
                <Icon name="MoreHorizontal" className="size-4" aria-hidden />
              </Button>
            }
          />
        </div>
      </div>
      <ThreadLine box={box} thread={thread} now={now} />
    </header>
  );
}

function Notice({ tone, title, children, actions }: { tone: "bad" | "warn"; title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section role={tone === "bad" ? "alert" : "status"} className={cn("rounded-lg border px-4 py-3", tone === "bad" ? "border-surface-destructive-border bg-surface-destructive" : "border-surface-warning-border bg-surface-warning")}>
      <p className={cn("text-sm font-medium", tone === "bad" ? "text-destructive-text" : "text-warning-text")}>{title}</p>
      <div className="mt-1 text-sm text-foreground">{children}</div>
      {actions ? <div className="mt-3 flex flex-wrap gap-1.5">{actions}</div> : null}
    </section>
  );
}

const OPERATION_TITLES: Readonly<Record<string, string>> = { stop: "Stop failed", start: "Start failed", resize: "Resize failed", release: "Release did not finish" };

function Notices({ box, now, onRelease }: { box: FakeBox; now: number; onRelease: () => void }) {
  const store = useStore();
  const view = box.view;
  const host = view.backendLabel.replace(/^.* on /, "");
  const small = (words: string, onClick: () => void, danger = false) => (
    <Button type="button" variant="outline" size="sm" className={cn("h-7", danger && "text-destructive-text")} onClick={onClick}>
      {words}
    </Button>
  );
  const notices: ReactNode[] = [];
  if (box.operation) {
    const operation = box.operation;
    const still = operation.action === "release" ? `The box may still run on ${host}; bb-box keeps its record until a release is confirmed.` : operation.action === "start" ? "It is still stopped." : operation.action === "stop" ? "It is still running." : "Its size did not change.";
    notices.push(
      <Notice
        key="operation"
        tone="bad"
        title={`${OPERATION_TITLES[operation.action]} ${ago(operation.at, now)}`}
        actions={operation.action === "release" ? small("Release again…", onRelease, true) : operation.action === "resize" ? small("Resize…", () => store.act("resize", view.id)) : small(`${operation.action === "stop" ? "Stop" : "Start"} again`, () => store.act(operation.action, view.id))}
      >
        {operation.error} {still}
      </Notice>,
    );
  }
  if (box.backendGone) {
    notices.push(
      <Notice
        key="gone"
        tone="warn"
        title="Its backend is not in settings"
        actions={
          <>
            {small("Open BB Box settings", () => go({ page: "settings", section: "backends" }))}
            {small("Forget…", onRelease, true)}
          </>
        }
      >
        {view.backendLabel} was removed from settings {span(now - box.backendGone.since)} ago, so bb-box cannot check, stop or release this box. It was last seen ready, and may still be running on {host}. Add the backend back to manage it, or forget it here.
      </Notice>,
    );
  }
  if (box.unreachable) {
    notices.push(
      <Notice key="unreachable" tone="warn" title={`${host} does not answer`} actions={small("Check now", () => store.act("refresh", view.id))}>
        {box.unreachable.error}. Since {clock(box.unreachable.since)}, bb-box cannot read, stop or start this box. It was last seen ready. bb-box tries again every minute.
      </Notice>,
    );
  }
  if (view.state === "failed") {
    notices.push(
      <Notice
        key="failed"
        tone="bad"
        title="It did not start"
        actions={
          <>
            {small("Check now", () => store.act("refresh", view.id))}
            {small("Release…", onRelease, true)}
          </>
        }
      >
        {view.error}
      </Notice>,
    );
  }
  if (view.stopped) notices.push(<Notice key="unrequested" tone="warn" title="It stopped without being asked">{view.stopped}</Notice>);
  return <>{notices}</>;
}

function Starting({ box, now }: { box: FakeBox; now: number }) {
  const view = box.view;
  const restart = !!box.started && box.started.readyAt === null;
  const steps = Object.entries(view.timings).filter(([step]) => (restart ? step.startsWith("start.") : step !== "total" && !step.includes(".")));
  return (
    <section aria-label="Starting" className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <Icon name="Loading" className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
        {restart ? "Starting again" : "Starting"} for {span(now - startSince(box))}
      </p>
      <ol className="mt-2 space-y-1 text-xs">
        {steps.map(([step, ms]) => (
          <li key={step} className="flex items-center gap-2 text-muted-foreground">
            <Icon name="Check" className="size-3.5 text-success" aria-hidden />
            <span className="text-foreground">{STEP_NAMES[step] ?? step}</span>
            <span className="tabular-nums">{(ms / 1000).toFixed(1)} s</span>
          </li>
        ))}
        <li className="flex items-center gap-2 text-muted-foreground">
          <span className="flex size-3.5 items-center justify-center">
            <span className="size-1.5 rounded-full bg-muted-foreground" />
          </span>
          {view.waitingOn ?? (restart ? "Waiting for it to boot" : "Waiting for the next step")}
        </li>
      </ol>
      <p className="mt-2 text-xs text-subtle-foreground">This page follows it. Its numbers start once it is ready.</p>
    </section>
  );
}

const STEP_SHADES = ["opacity-90", "opacity-70", "opacity-55", "opacity-40", "opacity-30", "opacity-20"];

function stepTime(ms: number): string {
  if (ms < 100) return `${ms} ms`;
  if (ms >= 60_000) return span(ms);
  return `${(ms / 1000).toFixed(1)} s`;
}

function HowItStarted({ box, now }: { box: FakeBox; now: number }) {
  const store = useStore();
  const view = box.view;
  const steps = Object.entries(view.timings).filter(([step, ms]) => ms > 0 && step !== "total" && step !== "enrol" && step !== "spareReconnect" && !step.includes("."));
  const total = view.timings.total ?? steps.reduce((sum, [, ms]) => sum + ms, 0);
  const restart = Object.entries(view.timings).filter(([step]) => step.startsWith("start."));
  const joined = view.timings.enrol ?? view.timings.spareReconnect;
  const largest = [...steps].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([step]) => step);
  const lastStart = box.started && box.started.readyAt !== null ? box.started : null;
  const by = lastStart ? actorWords(lastStart.by, store.threads) : null;
  return (
    <section aria-labelledby="started-heading" className="rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="started-heading" className="text-sm font-medium text-foreground">
          How it started
        </h2>
        <span className="text-xs tabular-nums text-muted-foreground">{view.state === "failed" ? "Did not finish" : `Ready in ${stepTime(total)}`}</span>
      </div>
      <div className="mt-3 flex h-2 w-full overflow-hidden rounded-full bg-surface-recessed" role="img" aria-label={`The time each step took: ${steps.map(([step, ms]) => `${STEP_NAMES[step] ?? step} ${stepTime(ms)}`).join(", ")}`}>
        {steps.map(([step, ms], index) => (
          <span key={step} className={cn("h-full bg-foreground", STEP_SHADES[index % STEP_SHADES.length], index && "border-l border-card")} style={{ width: `${(ms / Math.max(total, 1)) * 100}%` }} />
        ))}
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {steps
          .filter(([step]) => largest.includes(step))
          .map(([step, ms]) => (
            <div key={step} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{STEP_NAMES[step] ?? step}</dt>
              <dd className="tabular-nums text-foreground">{stepTime(ms)}</dd>
            </div>
          ))}
      </dl>
      <p className="mt-2 text-xs text-subtle-foreground">
        {steps.length > largest.length ? `And ${steps.length - largest.length} quicker steps. ` : ""}
        {joined !== undefined ? `It joined BB ${(joined / 1000).toFixed(1)} s later. ` : ""}
        Made {dayAndClock(view.createdAt, now)}.
      </p>
      {lastStart && restart.length ? (
        <p className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
          Last started {dayAndClock(lastStart.askedAt, now)}
          {by ? `, ${by}` : ""}: ready in {stepTime(lastStart.readyAt! - lastStart.askedAt)} ({restart.map(([step, ms]) => `${(STEP_NAMES[step] ?? step).toLowerCase()} ${stepTime(ms)}`).join(", ")}).
        </p>
      ) : null}
    </section>
  );
}

function ThreadsCard({ box }: { box: FakeBox }) {
  const store = useStore();
  const threads = machineThreads(box, store.threads).filter((thread) => thread.id !== box.threadId);
  const enrolled = box.view.enrol.state === "enrolled" && box.view.state === "ready" && !box.unreachable && !box.backendGone;
  return (
    <section aria-labelledby="threads-heading" className="rounded-lg border border-border bg-card px-4 py-3">
      <h2 id="threads-heading" className="text-sm font-medium text-foreground">
        {box.owner === "yours" ? "Threads on this machine" : "Other threads on it"}
      </h2>
      {threads.length ? (
        <ThreadChips threads={threads} className="mt-2" />
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">{enrolled ? "None now. A thread can run on its BB machine." : box.view.enrol.state === "enrolled" ? "None. Its BB machine is offline now." : "None. It is not a BB machine, so no thread can run on it."}</p>
      )}
      {enrolled ? (
        <Button type="button" variant="outline" size="sm" className="mt-3 h-7 gap-1.5" onClick={() => store.say("New thread on this box opens the Box panel's dialog.")}>
          <Icon name="MessageSquarePlus" className="size-4" aria-hidden />
          New thread on this box…
        </Button>
      ) : null}
    </section>
  );
}

function NoNumbers({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Activity" className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-sm font-medium text-foreground">Activity</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{children}</p>
    </section>
  );
}

function listRoute(box: FakeBox | null): Route {
  return { page: "list", tab: box?.owner === "yours" ? "machines" : "threads" };
}

export function NotHere({ id }: { id: string }) {
  const store = useStore();
  const released = store.released.get(id);
  const back = () => goBackOr(listRoute(null), ["list"]);
  return (
    <div className="mx-auto w-full max-w-5xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Boxes", go: back }, { words: released?.name ?? "Not here" }]} />
      <EmptyPanel title={released ? `${released.name} was released` : "This box is not here"}>
        <p className="mt-1">{released ? `Released ${span(store.now - released.at)} ago, at ${clock(released.at)}. bb-box remembers a released box for 24 hours.` : "It may have been released more than 24 hours ago, or the link is wrong."}</p>
        <Button type="button" variant="outline" size="sm" className="mt-3 h-7" onClick={back}>
          Back to boxes
        </Button>
      </EmptyPanel>
    </div>
  );
}

export function BoxPage({ id, fromSettings = false }: { id: string; fromSettings?: boolean }) {
  const store = useStore();
  const { now } = store;
  const box = store.boxes.find((each) => each.view.id === id) ?? null;
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current) return;
    focused.current = true;
    document.querySelector<HTMLElement>("[data-page-heading]")?.focus({ preventScroll: true });
  }, []);
  const release = useReleaseDialog(box ?? store.boxes[0]!);
  if (!box) return <NotHere id={id} />;
  const view = box.view;
  const thread = store.threads.find((each) => each.id === box.threadId) ?? null;
  const starting = view.state === "acquiring" || view.state === "starting";
  const failed = view.state === "failed";
  const back = fromSettings ? () => go({ page: "settings", section: "machines" }) : () => goBackOr(listRoute(box), ["list"]);
  return (
    <div className={cn("mx-auto w-full max-w-5xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4", view.state === "releasing" && !box.operation && "opacity-60")}>
      <TopRow trail={[{ words: fromSettings ? "BB Box settings" : "Boxes", go: back }, { words: view.name }]} />
      <Header box={box} thread={thread} now={now} onRelease={release.ask} />
      <Notices box={box} now={now} onRelease={release.ask} />
      {starting ? <Starting box={box} now={now} /> : null}
      {starting || failed ? null : box.readingNote ? <NoNumbers>{box.readingNote}</NoNumbers> : <Activity key={view.id} box={box} now={now} />}
      {starting || failed ? null : <Processes box={box} now={now} />}
      {starting ? null : <Facts box={box} now={now} />}
      {starting ? null : failed ? (
        <HowItStarted box={box} now={now} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <ThreadsCard box={box} />
          <HowItStarted box={box} now={now} />
        </div>
      )}
      {release.dialog}
    </div>
  );
}
