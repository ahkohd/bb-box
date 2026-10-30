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
import { SettingsOverview, SnapshotSettingsPage } from "./settings";
import { useUndoDialog } from "./snapshot-row";
import { StoreProvider, useStore } from "./store";

const PROJECTS = ["web-app", "mobile", "infra", "docs"];

function ThreadStandIn({ id }: { id: string }) {
  const store = useStore();
  const thread = store.threads.find((each) => each.id === id);
  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
      <TopRow trail={[{ words: "Back", go: () => history.back() }, { words: "Thread" }]} />
      <h1 className="text-base font-medium text-foreground">{thread?.title ?? id}</h1>
      <p className="text-sm text-muted-foreground">BB's thread, not part of this prototype.</p>
    </div>
  );
}

function Panel({ route }: { route: Route }) {
  switch (route.page) {
    case "list":
      return <BoxesList tab={route.tab} />;
    case "box":
      return <BoxPage key={route.id} id={route.id} />;
    case "thread":
      return <ThreadStandIn id={route.id} />;
    case "settings":
      return route.section === "snapshots" ? <SnapshotSettingsPage /> : <SettingsOverview />;
  }
}

const JUMPS: readonly { label: string; route: Route }[] = [
  { label: "Snapshots tab", route: { page: "list", tab: "snapshots" } },
  { label: "A desktop box", route: { page: "box", id: "bxamberfox2q7k" } },
  { label: "A VM with memory", route: { page: "box", id: "bxbrisklake8m3" } },
  { label: "A Mac on Tart", route: { page: "box", id: "bxsilverpine6z" } },
  { label: "A paid one (boat)", route: { page: "box", id: "bxquickwren7d" } },
  { label: "A device box", route: { page: "box", id: "bxrosyreef4k1" } },
  { label: "No snapshots", route: { page: "box", id: "bxcalmharbor4w" } },
  { label: "Token lacks rights", route: { page: "box", id: "bxdevdesk9x1p" } },
  { label: "A released box", route: { page: "box", id: "bxgreyridge5t" } },
  { label: "Settings", route: { page: "settings", section: "snapshots" } },
];

function ScenarioBar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const store = useStore();
  const [open, setOpen] = useState(() => !new URLSearchParams(location.search).has("closed"));
  return (
    <aside aria-label="Prototype controls" className="fixed bottom-3 left-3 z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-dashed border-input bg-popover/95 text-xs shadow-lg backdrop-blur max-sm:bottom-auto max-sm:left-auto max-sm:right-3 max-sm:top-3">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-medium text-foreground" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="rounded-sm bg-foreground px-1 py-0.5 text-2xs leading-none text-background">Prototype</span>
        <span className="flex-1">Decision 070</span>
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
          <Button type="button" variant="outline" size="sm" className="h-7 w-full text-2xs" onClick={() => {
            go({ page: "box", id: "bxamberfox2q7k" });
            store.agentDemo();
          }}>
            An agent snapshots and restores amber-fox
          </Button>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            The next take, restore or fork fails
            <Switch checked={store.failNext} onCheckedChange={store.setFailNext} aria-label="The next take, restore or fork fails" />
          </label>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              Dark
              <Switch checked={dark} onCheckedChange={setDark} aria-label="Dark" />
            </label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-2xs" onClick={store.reset}>
              Start over
            </Button>
          </div>
          <p className="text-2xs leading-snug text-subtle-foreground">Pictures are drawn by the prototype, not real screens. Takes, restores and forks run with short waits. Nothing is saved.</p>
        </div>
      ) : null}
    </aside>
  );
}

function ToastView() {
  const { toast } = useStore();
  if (!toast) return null;
  return (
    <div role="status" className="fixed bottom-3 right-3 z-50 flex max-w-sm items-center gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-foreground shadow-lg">
      <Icon name="CircleCheck" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">{toast.words}</span>
      {toast.action ? (
        <Button type="button" variant="outline" size="sm" className="h-7" onClick={toast.action.run}>
          {toast.action.label}…
        </Button>
      ) : null}
    </div>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 bg-background">
      <nav aria-label="BB" className="flex w-11 shrink-0 flex-col items-center gap-3 bg-rail py-3 text-muted-foreground max-sm:hidden">
        <Icon name="Plus" className="size-4" aria-hidden />
        <button type="button" aria-label="Boxes" className="rounded-md bg-state-active p-1.5 text-foreground" onClick={() => go({ page: "list", tab: "snapshots" })}>
          <BoxGlyph className="size-4" />
        </button>
        <button type="button" aria-label="Settings" className="mt-auto rounded-md p-1.5 hover:bg-state-hover" onClick={() => go({ page: "settings", section: "" })}>
          <Icon name="Settings" className="size-4" aria-hidden />
        </button>
      </nav>
      <aside aria-label="Threads" className="w-64 shrink-0 overflow-y-auto bg-sidebar px-2 py-3 text-sm max-xl:hidden">
        <p className="px-2 pb-2 text-xs text-subtle-foreground">Projects</p>
        {PROJECTS.map((project) => (
          <p key={project} className="rounded-md px-2 py-1.5 text-foreground/80">
            {project}
          </p>
        ))}
      </aside>
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
  const undo = useUndoDialog();
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
  const flush = route.page === "list";
  return (
    <TooltipProvider delayDuration={250}>
      <Chrome>
        <div ref={scroller} className={cn("min-h-0 flex-1", flush ? "" : "overflow-y-auto pb-24")}>
          <Panel route={route} />
        </div>
      </Chrome>
      <ScenarioBar dark={dark} setDark={setDark} />
      <ToastView />
      {undo}
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <Frame />
  </StoreProvider>,
);
