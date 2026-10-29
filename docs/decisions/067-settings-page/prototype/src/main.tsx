import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AddBackend, SetupBackend } from "./add-backend";
import { BackendPage } from "./backend-page";
import { driverOf } from "./data";
import { forgetDrafts, useLeaveWarning } from "./drafts";
import { FindBox } from "./find";
import { KindPage } from "./kind-page";
import { backendTitle, kindName } from "./model";
import { NavProvider, useNav, viewKey, type View } from "./nav";
import { OptionPageView } from "./option-pages";
import { Overview } from "./overview";
import { StoreProvider, useStore, type NextSave, type Scenario, type ServerDocker } from "./store";
import { FOCUS_RING, Icon, ProviderGlyph } from "./ui";

const BB_SECTIONS = ["General", "Providers", "AI services", "Appearance", "Keyboard", "Browser", "Files", "Projects", "Machines", "Mobile", "Environment variables", "Updates", "Installed plugins", "Plugin marketplaces", "Experiments"];
const PLUGINS = ["Account Pooler", "ACP providers", "BB Box", "BB guide", "Canvas", "Claude Code provider", "Codex provider"];

function useViewTitle(): (view: View | null) => string {
  const store = useStore();
  return (view) => {
    if (!view || view.page === "overview") return "BB Box settings";
    if (view.page === "backend") {
      const backend = store.doc.backends.find((each) => each.id === view.id);
      return backend ? backendTitle(backend, store.live[backend.id]) : "the backend";
    }
    if (view.page === "kind") return kindName(view.id);
    if (view.page === "option") return view.id.charAt(0).toUpperCase() + view.id.slice(1);
    if (view.page === "add") return "Add a backend";
    return `Set up ${driverOf(view.type).label}`;
  };
}

function TopRow() {
  const nav = useNav();
  const title = useViewTitle();
  const { view, cameFrom } = nav;
  if (view.page === "overview") return <FindBox wide />;
  const back = cameFrom && cameFrom.page !== "overview" ? cameFrom : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <nav aria-label="Where you are" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
        {back ? (
          <button type="button" onClick={nav.back} className={cn("-ml-1 inline-flex cursor-pointer items-center gap-0.5 rounded-sm px-1 text-muted-foreground hover:text-foreground", FOCUS_RING)}>
            <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
            Back to {title(back)}
          </button>
        ) : null}
        {back ? <span className="text-subtle-foreground" aria-hidden>·</span> : null}
        <button type="button" onClick={nav.toOverview} className={cn("cursor-pointer rounded-sm text-muted-foreground hover:text-foreground", !back && "-ml-1 inline-flex items-center gap-0.5 px-1", FOCUS_RING)}>
          {back ? null : <Icon name="ChevronLeft" className="size-3.5" aria-hidden />}
          BB Box settings
        </button>
        <span className="text-subtle-foreground" aria-hidden>
          ›
        </span>
        <span aria-current="page" className="min-w-0 truncate text-foreground">
          {title(view)}
        </span>
      </nav>
      <FindBox />
    </div>
  );
}

function SettingsRoot() {
  const nav = useNav();
  const { view } = nav;
  const first = useRef(true);
  useLeaveWarning();
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const target = nav.returnRow ? document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(nav.returnRow)}"]`) : null;
    (target ?? document.querySelector<HTMLElement>("[data-page-heading]"))?.focus({ preventScroll: true });
  }, [viewKey(view)]);
  return (
    <div className="space-y-5">
      <TopRow />
      <div key={viewKey(view)} className={nav.animate === "forward" ? "view-forward" : nav.animate === "back" ? "view-back" : undefined}>
        {view.page === "overview" ? <Overview /> : null}
        {view.page === "backend" ? <BackendPage id={view.id} /> : null}
        {view.page === "kind" ? <KindPage id={view.id} /> : null}
        {view.page === "option" ? <OptionPageView id={view.id} /> : null}
        {view.page === "add" ? <AddBackend /> : null}
        {view.page === "setup" ? <SetupBackend type={view.type} /> : null}
      </div>
    </div>
  );
}

function PluginChrome({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-6">
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Icon name="ChevronLeft" className="size-3.5" aria-hidden />
        Plugin details
      </span>
      <div className="flex items-center gap-3">
        <ProviderGlyph type="box" className="size-7 text-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-base font-medium text-foreground">BB Box</p>
          <p className="text-xs text-muted-foreground">Computers for BB threads.</p>
        </div>
        <Switch size="default" checked aria-label="BB Box plugin on" />
      </div>
      <p className="text-sm font-medium text-foreground">Configuration</p>
      {children}
    </div>
  );
}

function Segments<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; label: string }[]; onChange: (value: T) => void; label: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-subtle-foreground">{label}</p>
      <div className="flex flex-wrap gap-1">
        {options.map((option) => (
          <button key={option.id} type="button" className={cn("flex-1 cursor-pointer rounded-md px-1.5 py-1 text-2xs transition-colors", value === option.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover")} onClick={() => onChange(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScenarioBar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const store = useStore();
  const [open, setOpen] = useState(() => !new URLSearchParams(location.search).has("closed"));
  return (
    <aside aria-label="Prototype controls" className="fixed bottom-3 left-3 z-50 w-72 max-w-[calc(100vw-1.5rem)] max-sm:bottom-auto max-sm:left-auto max-sm:right-3 max-sm:top-3 rounded-lg border border-dashed border-input bg-popover/95 text-xs shadow-lg backdrop-blur">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-medium text-foreground" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="rounded-sm bg-foreground px-1 py-0.5 text-2xs leading-none text-background">Prototype</span>
        <span className="flex-1">Decision 067</span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="max-h-[70vh] space-y-3 overflow-y-auto border-t border-border px-3 py-3">
          <Segments<Scenario>
            label="Scenario"
            value={store.scenario}
            options={[
              { id: "healthy", label: "All ready" },
              { id: "problem", label: "Problems" },
              { id: "first-run", label: "First run" },
            ]}
            onChange={(scenario) => {
              forgetDrafts();
              store.setScenario(scenario);
              history.pushState({}, "", location.pathname + location.search);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          />
          <Segments<NextSave>
            label="The next save"
            value={store.nextSave}
            options={[
              { id: "ok", label: "Works" },
              { id: "refused", label: "Is refused" },
              { id: "lost", label: "Saves, reply lost" },
            ]}
            onChange={store.setNextSave}
          />
          <div className="space-y-1.5">
            <p className="text-subtle-foreground">While the page is open</p>
            <Button type="button" variant="outline" size="sm" className="h-7 w-full text-2xs" onClick={store.agentApply}>
              An agent runs bb box config apply
            </Button>
            <p className="text-2xs leading-snug text-subtle-foreground">It changes Proxmox LXC's memory kept free and token secret, boxes per thread, the Monitor's refresh and Linux spares.</p>
            {store.scenario === "problem" ? (
              <Button type="button" variant="outline" size="sm" className="h-7 w-full text-2xs" disabled={store.macBack} onClick={store.bringMacBack}>
                {store.macBack ? "mac-1 answers again" : "Bring mac-1 back, then Check again"}
              </Button>
            ) : null}
          </div>
          {store.scenario === "first-run" ? (
            <Segments<ServerDocker>
              label="Docker on BB's server"
              value={store.serverDocker}
              options={[
                { id: "ready", label: "Ready" },
                { id: "missing", label: "Missing" },
                { id: "permission", label: "No access" },
                { id: "disk", label: "Low disk" },
              ]}
              onChange={store.setServerDocker}
            />
          ) : null}
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              Dark
              <Switch checked={dark} onCheckedChange={setDark} aria-label="Dark" />
            </label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-2xs" onClick={() => location.reload()}>
              Reload the page
            </Button>
          </div>
          <p className="text-2xs leading-snug text-subtle-foreground">BB's sidebar works: leave by it and come back, or use the browser's back button. Unsaved changes stay.</p>
        </div>
      ) : null}
    </aside>
  );
}

function OtherPage({ hash }: { hash: string }) {
  const words: Record<string, { title: string; body: string }> = {
    "#bb-general": { title: "General", body: "BB's own General settings. Go back with the browser, or choose BB Box in the sidebar." },
    "#bb-machines": { title: "Boxes · Machines", body: "The Boxes page opens on its Machines tab, empty or not: every machine of yours, with start, stop, resize, remove, desktop and terminal." },
    "#bb-new-thread": { title: "New thread", body: "BB's new-thread screen, with New box offered." },
  };
  const page = words[hash] ?? { title: "BB", body: "Another BB page." };
  return (
    <div className="space-y-2 pt-6">
      <h1 className="text-base font-medium text-foreground">{page.title}</h1>
      <p className="text-sm text-muted-foreground">{page.body}</p>
    </div>
  );
}

function Frame() {
  const scroller = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(() => !new URLSearchParams(location.search).has("light"));
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);
  useEffect(() => {
    const read = () => setHash(location.hash);
    const open = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      history.pushState({}, "", `${location.pathname}${location.search}#bb-${target}`);
      read();
    };
    window.addEventListener("popstate", read);
    window.addEventListener("bb-open", open);
    return () => {
      window.removeEventListener("popstate", read);
      window.removeEventListener("bb-open", open);
    };
  }, []);
  const getScroller = useCallback(() => scroller.current, []);
  const toBB = (target: string) => {
    history.pushState({}, "", `${location.pathname}${location.search}${target}`);
    setHash(target);
    window.dispatchEvent(new PopStateEvent("popstate"));
    scroller.current?.scrollTo({ top: 0 });
  };
  const onSettings = !hash.startsWith("#bb-");
  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex h-full min-h-0 bg-background">
        <nav aria-label="BB" className="flex w-11 shrink-0 flex-col items-center gap-3 bg-rail py-3 text-muted-foreground max-md:hidden">
          <Icon name="Desktop" className="size-4" aria-hidden />
          <ProviderGlyph type="box" />
          <span className="mt-auto rounded-md bg-state-active p-1.5 text-foreground">
            <Icon name="Settings" className="size-4" aria-hidden />
          </span>
        </nav>
        <aside aria-label="Settings sections" className="w-72 shrink-0 overflow-y-auto bg-sidebar px-2 py-3 text-sm max-lg:hidden">
          {BB_SECTIONS.map((section) => (
            <button key={section} type="button" className={cn("block w-full rounded-md px-2 py-1.5 text-left text-foreground/90 hover:bg-state-hover", section === "General" && hash === "#bb-general" && "bg-state-active", FOCUS_RING)} onClick={() => (section === "General" ? toBB("#bb-general") : undefined)}>
              {section}
            </button>
          ))}
          <p className="mt-4 px-2 pb-1 text-xs text-subtle-foreground">Plugins</p>
          {PLUGINS.map((plugin) => (
            <button key={plugin} type="button" className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-state-hover", plugin === "BB Box" && onSettings ? "bg-state-active text-foreground" : "text-foreground/90", FOCUS_RING)} onClick={() => (plugin === "BB Box" ? toBB("") : undefined)}>
              {plugin === "BB Box" ? <ProviderGlyph type="box" className="text-foreground" /> : null}
              {plugin}
            </button>
          ))}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center border-b border-border px-4 text-sm font-medium text-foreground">Settings</header>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4 pb-28 pt-6 md:px-5">
              {onSettings ? (
                <PluginChrome>
                  <NavProvider scroller={getScroller}>
                    <SettingsRoot />
                  </NavProvider>
                </PluginChrome>
              ) : (
                <OtherPage hash={hash} />
              )}
            </div>
          </div>
        </main>
      </div>
      <ScenarioBar dark={dark} setDark={setDark} />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <Frame />
  </StoreProvider>,
);
