import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { experimental_Icon as Icon, OPEN_THREAD } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { BoxPage, TopRow } from "./box-page";
import { BoxesList } from "./list";
import { go, useRoute, type Route } from "./nav";
import { StoreProvider, useStore } from "./store";
import { ViewPage } from "./view";
import { span } from "./words";

const PROJECTS = ["web-app", "mobile", "infra", "docs"];

function ThreadStandIn({ id }: { id: string }) {
  const store = useStore();
  const thread = store.threads.find((each) => each.id === id);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Back", go: () => history.back() }, { words: "Thread" }]} />
      <h1 className="text-base font-medium text-foreground">{thread?.title ?? id}</h1>
      <p className="text-sm text-muted-foreground">BB's thread, not part of this prototype. {thread ? (thread.running ? "It is working now." : `It has been idle for ${span(store.now - thread.activeAt)}.`) : ""}</p>
    </div>
  );
}

function SettingsStandIn({ section }: { section: string }) {
  const store = useStore();
  const row = "flex items-center justify-between gap-4 px-4 py-3";
  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Back", go: () => history.back() }, { words: "BB Box settings" }]} />
      <p className="text-sm text-muted-foreground">A stand-in for decision 067's settings page, with only what this prototype needs.</p>
      <section className={cn("overflow-hidden rounded-lg border border-border bg-card", section === "monitor" && "ring-1 ring-ring")}>
        <p className="border-b border-border px-4 py-2.5 text-sm font-medium text-foreground">Monitor</p>
        <div className="divide-y divide-border">
          <label className={row}>
            <span>
              <span className="block text-sm text-foreground">Monitor</span>
              <span className="block text-xs text-muted-foreground">Machine status in the sidebar, and each box's Activity.</span>
            </span>
            <Switch checked={store.monitorOn} onCheckedChange={store.setMonitorOn} aria-label="Monitor" />
          </label>
          <label className={row}>
            <span>
              <span className="block text-sm text-foreground">Keep each box's history</span>
              <span className="block text-xs text-muted-foreground">A light reading of every running box once a minute, kept 7 days, for 1 h, 24 h and 7 d and the list's busy flag. Off: nothing is read unless a page is open.</span>
            </span>
            <Switch checked={store.historyOn} disabled={!store.monitorOn} onCheckedChange={store.setHistoryOn} aria-label="Keep each box's history" />
          </label>
        </div>
      </section>
      <section className="overflow-hidden rounded-lg border border-border bg-card">
        <p className="border-b border-border px-4 py-2.5 text-sm font-medium text-foreground">Machines</p>
        <div className={row}>
          <span className="text-sm text-foreground">workbench</span>
          <span className="flex gap-1.5">
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => go({ page: "box", id: "bxdevdesk9x1p", fromSettings: true })}>
              Its page
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => go({ page: "view", id: "bxdevdesk9x1p", view: "desktop", fromSettings: true })}>
              Open desktop
            </Button>
          </span>
        </div>
      </section>
    </div>
  );
}

function Panel({ route }: { route: Route }) {
  switch (route.page) {
    case "list":
      return <BoxesList key={route.tab ?? "any"} opening={route.tab} />;
    case "box":
      return <BoxPage key={route.id} id={route.id} fromSettings={route.fromSettings} />;
    case "view":
      return <ViewPage key={`${route.id}/${route.view}`} id={route.id} view={route.view} fromSettings={route.fromSettings} />;
    case "thread":
      return <ThreadStandIn id={route.id} />;
    case "settings":
      return <SettingsStandIn section={route.section} />;
  }
}

const JUMPS: readonly { label: string; route: Route }[] = [
  { label: "The list", route: { page: "list", tab: "threads" } },
  { label: "A desktop box", route: { page: "box", id: "bxamberfox2q7k" } },
  { label: "A device box", route: { page: "box", id: "bxcalmharbor4w" } },
  { label: "A stopped box", route: { page: "box", id: "bxsilverpine6z" } },
  { label: "A busy box", route: { page: "box", id: "bxbrisklake8m3" } },
  { label: "A failed box", route: { page: "box", id: "bxoakridge7n2" } },
  { label: "A machine of yours", route: { page: "box", id: "bxdevdesk9x1p" } },
  { label: "A host not answering", route: { page: "box", id: "bxfernhollow5d" } },
  { label: "A backend removed", route: { page: "box", id: "bxmaplerow8k2" } },
  { label: "A Windows machine", route: { page: "box", id: "bxtestwin5r8q" } },
  { label: "Settings", route: { page: "settings", section: "" } },
];

function ScenarioBar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const store = useStore();
  const [open, setOpen] = useState(() => !new URLSearchParams(location.search).has("closed"));
  return (
    <aside aria-label="Prototype controls" className="fixed bottom-3 left-3 z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-dashed border-input bg-popover/95 text-xs shadow-lg backdrop-blur max-sm:bottom-auto max-sm:left-auto max-sm:right-3 max-sm:top-3">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-medium text-foreground" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="rounded-sm bg-foreground px-1 py-0.5 text-2xs leading-none text-background">Prototype</span>
        <span className="flex-1">Decision 069</span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto border-t border-border px-3 py-3">
          <div className="space-y-1.5">
            <p className="text-subtle-foreground">Go to</p>
            <div className="grid grid-cols-2 gap-1">
              {JUMPS.map((jump) => (
                <button key={jump.label} type="button" className="cursor-pointer rounded-md px-1.5 py-1 text-left text-2xs text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => go(jump.route)}>
                  {jump.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              The next Stop, Start, Resize or Release fails
              <Switch checked={store.failNext} onCheckedChange={store.setFailNext} aria-label="The next Stop, Start, Resize or Release fails" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              The Monitor is on
              <Switch checked={store.monitorOn} onCheckedChange={store.setMonitorOn} aria-label="The Monitor is on" />
            </label>
          </div>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              Dark
              <Switch checked={dark} onCheckedChange={setDark} aria-label="Dark" />
            </label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-2xs" onClick={store.reset}>
              Start over
            </Button>
          </div>
          <p className="text-2xs leading-snug text-subtle-foreground">Every page has its own link: reload, or use the browser's back and forward. north-wind starts as you watch. Stop, Start and Release work, with a short wait. Box history's switch is in Settings.</p>
        </div>
      ) : null}
    </aside>
  );
}

function Toast() {
  const { toast } = useStore();
  if (!toast) return null;
  return (
    <div role="status" className="fixed bottom-3 right-3 z-50 flex max-w-sm items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-foreground shadow-lg">
      <Icon name="CircleCheck" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {toast}
    </div>
  );
}

function Chrome({ children, onBoxes }: { children: ReactNode; onBoxes: boolean }) {
  return (
    <div className="flex h-full min-h-0 bg-background">
      <>
          <nav aria-label="BB" className="flex w-11 max-sm:hidden shrink-0 flex-col items-center gap-3 bg-rail py-3 text-muted-foreground">
            <Icon name="Plus" className="size-4" aria-hidden />
            <button type="button" aria-label="Boxes" className={cn("rounded-md p-1.5", onBoxes ? "bg-state-active text-foreground" : "hover:bg-state-hover")} onClick={() => go({ page: "list", tab: null })}>
              <BoxGlyph className="size-4" />
            </button>
            <span className="mt-auto p-1.5">
              <Icon name="Settings" className="size-4" aria-hidden />
            </span>
          </nav>
          <aside aria-label="Threads" className="w-64 shrink-0 overflow-y-auto bg-sidebar px-2 py-3 text-sm max-xl:hidden">
            <p className="px-2 pb-2 text-xs text-subtle-foreground">Projects</p>
            {PROJECTS.map((project) => (
              <p key={project} className="rounded-md px-2 py-1.5 text-foreground/80">
                {project}
              </p>
            ))}
          </aside>
      </>
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-sm font-medium text-foreground">
          <BoxGlyph className="size-4 text-muted-foreground" />
          Boxes
        </header>
        {children}
      </main>
    </div>
  );
}

function Frame() {
  const route = useRoute();
  const scroller = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(() => !new URLSearchParams(location.search).has("light"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);
  useEffect(() => {
    const open = (event: Event) => go({ page: "thread", id: (event as CustomEvent<string>).detail });
    window.addEventListener(OPEN_THREAD, open);
    return () => window.removeEventListener(OPEN_THREAD, open);
  }, []);
  const routeKey = JSON.stringify(route);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [routeKey]);
  const flush = route.page === "view" || route.page === "list";
  return (
    <TooltipProvider delayDuration={250}>
      <Chrome onBoxes={route.page !== "thread"}>
        {flush ? (
          <div className="min-h-0 flex-1">
            <Panel route={route} />
          </div>
        ) : (
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-24">
            <Panel route={route} />
          </div>
        )}
      </Chrome>
      <ScenarioBar dark={dark} setDark={setDark} />
      <Toast />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <Frame />
  </StoreProvider>,
);
