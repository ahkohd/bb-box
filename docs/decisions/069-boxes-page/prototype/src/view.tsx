import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { IconButton, StatusDot } from "@/src/app/common.tsx";
import { MonitorGlyph, PhoneGlyph, TerminalGlyph } from "@/src/app/glyphs.tsx";
import { openingsOf, unreachableWhy, whyClosed } from "./actions";
import { CHART } from "./activity";
import type { FakeBox } from "./data";
import { pointAt, running } from "./history";
import { cameFrom, go, goBackOr, type ViewName } from "./nav";
import { useStore } from "./store";
import { NotHere } from "./box-page";

function FakeDesktop() {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[radial-gradient(120%_90%_at_20%_10%,#2b3a55_0%,#1a2233_45%,#11151f_100%)]">
      <div className="absolute left-[6%] top-[7%] h-[78%] w-[70%] overflow-hidden rounded-md border border-white/10 bg-[#1f2430] shadow-2xl">
        <div className="flex h-8 items-center gap-1.5 border-b border-white/10 bg-[#2a3040] px-3">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
          <span className="ml-3 h-5 flex-1 rounded bg-white/5 px-2 text-[11px] leading-5 text-white/50">https://app.example.test/sign-in</span>
        </div>
        <div className="flex h-[calc(100%-2rem)] items-center justify-center bg-[#f6f7f9]">
          <div className="w-64 space-y-3 rounded-lg bg-white p-5 shadow">
            <p className="text-sm font-semibold text-[#1d2433]">Sign in</p>
            <div className="h-8 rounded border border-[#d5d9e0]" />
            <div className="h-8 rounded border border-[#d5d9e0]" />
            <div className="h-8 rounded bg-[#3563e9]" />
          </div>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 flex h-7 items-center gap-3 bg-black/40 px-3 text-[11px] text-white/60">
        <span>Activities</span>
        <span className="ml-auto">{new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(Date.now())}</span>
      </div>
    </div>
  );
}

function FakeDevice() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface-recessed p-6">
      <div className="relative aspect-[9/19.5] h-full max-h-[720px] rounded-[2.6rem] border-[10px] border-[#1c1c1e] bg-white shadow-xl">
        <div className="absolute left-1/2 top-2 h-5 w-24 -translate-x-1/2 rounded-full bg-[#1c1c1e]" />
        <div className="flex h-full flex-col px-5 pb-6 pt-12 text-[#111]">
          <p className="text-lg font-semibold">Checkout</p>
          <div className="mt-4 space-y-2">
            {["Trail shoes", "Socks, two pairs"].map((item) => (
              <div key={item} className="flex items-center justify-between rounded-xl bg-[#f2f2f7] px-3 py-3 text-sm">
                <span>{item}</span>
                <span className="text-[#666]">£{item.length * 3}.00</span>
              </div>
            ))}
          </div>
          <div className="mt-auto rounded-2xl bg-black py-3 text-center text-sm font-medium text-white">Pay</div>
        </div>
      </div>
    </div>
  );
}

function FakeTerminal({ name }: { name: string }) {
  const lines = [`box@${name}:~$ uptime`, " 18:42:07 up  2:14,  1 user,  load average: 0.84, 0.91, 0.88", `box@${name}:~$ docker ps --format '{{.Names}}'`, "postgres", "redis", `box@${name}:~$ `];
  return (
    <div className="absolute inset-0 overflow-hidden bg-[#0d0f12] p-3 font-mono text-[12.5px] leading-[1.45] text-[#d5d9e0]">
      {lines.map((line, index) => (
        <p key={index} className="whitespace-pre">
          {line}
          {index === lines.length - 1 ? <span className="inline-block h-[1.1em] w-[0.55em] translate-y-[2px] animate-pulse bg-[#d5d9e0]" /> : null}
        </p>
      ))}
    </div>
  );
}

function LiveReadout({ box, now }: { box: FakeBox; now: number }) {
  const store = useStore();
  if (!store.monitorOn || box.readingNote || !running(box, now)) return null;
  const point = pointAt(box, now, 5_000);
  return (
    <button type="button" onClick={() => go({ page: "box", id: box.view.id })} title={`${box.view.name}'s page`} className="hidden cursor-pointer items-center gap-2 rounded-md px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring sm:inline-flex">
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: CHART.cpu }} />
        CPU {Math.round(point.cpu ?? 0)}%
      </span>
      <span className="flex items-center gap-1">
        <span className="size-1.5 rounded-full" style={{ backgroundColor: CHART.memory }} />
        Memory {Math.round(point.memory ?? 0)}%
      </span>
    </button>
  );
}

export function ViewPage({ id, view: shown, fromSettings = false }: { id: string; view: ViewName; fromSettings?: boolean }) {
  const store = useStore();
  const box = store.boxes.find((each) => each.view.id === id);
  if (!box) return <NotHere id={id} />;
  const view = box.view;
  const closed = unreachableWhy(box) ?? whyClosed(view);
  const from = cameFrom();
  const back = fromSettings ? () => go({ page: "settings", section: "machines" }) : () => goBackOr({ page: "box", id }, ["list", "box"], true);
  const backWords = fromSettings ? "Back to BB Box settings" : from === "list" ? "Back to boxes" : `Back to ${view.name}`;
  const mine = view.control?.owner === "human" && view.control.holder === "this-tab";
  const others = openingsOf(view).filter((opening) => opening.view !== shown && opening.closedBecause === null);
  const screen = shown !== "terminal";
  const glyph = shown === "device" ? <PhoneGlyph /> : shown === "desktop" ? <MonitorGlyph /> : <TerminalGlyph />;
  const words = closed ? closed.replace(`${view.name} `, "").replace(/^is /, "").replace(/^./, (first) => first.toUpperCase()) : screen ? (mine ? "You have control" : "The agent has control") : "Connected";
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface-recessed px-3 py-2 text-xs">
        <IconButton label={backWords} icon="ArrowLeft" className="-ml-1" onClick={back} />
        <span className="text-muted-foreground">{glyph}</span>
        <button type="button" onClick={() => go({ page: "box", id })} className="cursor-pointer rounded-sm font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          {view.name}
        </button>
        {view.device && shown === "device" ? <span className="text-foreground">{view.device.model}</span> : null}
        <span className={cn("inline-flex items-center gap-1.5", mine ? "text-foreground" : "text-muted-foreground")}>
          <StatusDot tone={closed ? (view.state === "stopped" ? "off" : "busy") : "ok"} />
          {words}
        </span>
        {others.map((opening) => (
          <Button key={opening.view} type="button" variant="ghost" size="sm" className="h-7 gap-1.5 text-muted-foreground" onClick={() => go({ page: "view", id, view: opening.view, fromSettings }, { replace: true, from })}>
            {opening.glyph("size-3.5")}
            {opening.words}
          </Button>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <LiveReadout box={box} now={store.now} />
          {screen && !closed && !mine ? (
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => store.act("take", id)}>
              Take control
            </Button>
          ) : null}
          {screen && !closed && mine ? (
            <Button type="button" size="sm" className="h-7" onClick={() => store.act("handBack", id)}>
              Hand back to the agent
            </Button>
          ) : null}
          <IconButton label="Open in a new browser tab" icon="ExternalLink" onClick={() => store.say("Opens this view in a browser tab of its own, as Open in browser does today.")} />
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        {closed ? (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div className="flex max-w-xs flex-col items-center gap-2 rounded-md border border-border bg-card px-4 py-3 text-center text-sm text-muted-foreground">
              <span>{closed}.</span>
              {view.canStopStart && view.state === "stopped" ? (
                <Button type="button" size="sm" className="h-7 gap-1.5" onClick={() => store.act("start", id)}>
                  <Icon name="Play" className="size-4" aria-hidden />
                  Start
                </Button>
              ) : null}
            </div>
          </div>
        ) : shown === "desktop" ? (
          <FakeDesktop />
        ) : shown === "device" ? (
          <FakeDevice />
        ) : (
          <FakeTerminal name={view.name} />
        )}
      </div>
    </div>
  );
}
