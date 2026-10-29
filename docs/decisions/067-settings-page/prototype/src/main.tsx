import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AddBackend, SetupBackend } from "./add-backend";
import { BackendPage } from "./backend-page";
import { KindPage } from "./kind-page";
import { NavProvider, useNav, viewKey } from "./nav";
import { OptionPageView } from "./option-pages";
import { Overview } from "./overview";
import { StoreProvider, useStore, type Elsewhere, type Scenario } from "./store";
import { Icon, ProviderGlyph } from "./ui";

const BB_SECTIONS = ["General", "Providers", "AI services", "Appearance", "Keyboard", "Browser", "Files", "Projects", "Machines", "Mobile", "Environment variables", "Updates", "Installed plugins", "Plugin marketplaces", "Experiments"];
const PLUGINS = ["Account Pooler", "ACP providers", "BB Box", "BB guide", "Canvas", "Claude Code provider", "Codex provider", "Custom instructions"];

function SettingsRoot() {
  const nav = useNav();
  const { view } = nav;
  return (
    <div key={viewKey(view)} className={nav.direction === "forward" ? "view-forward" : "view-back"}>
      {view.page === "overview" ? <Overview /> : null}
      {view.page === "backend" ? <BackendPage id={view.id} /> : null}
      {view.page === "kind" ? <KindPage id={view.id} /> : null}
      {view.page === "option" ? <OptionPageView id={view.id} /> : null}
      {view.page === "add" ? <AddBackend /> : null}
      {view.page === "setup" ? <SetupBackend type={view.type} /> : null}
    </div>
  );
}

function PluginHeader() {
  const nav = useNav();
  if (nav.view.page !== "overview") return null;
  return (
    <div className="mb-6 space-y-4">
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
        <Switch size="default" checked aria-label="BB Box on" />
      </div>
    </div>
  );
}

function ScenarioBar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const store = useStore();
  const nav = useNav();
  const [open, setOpen] = useState(true);
  const scenarios: { id: Scenario; label: string }[] = [
    { id: "healthy", label: "All ready" },
    { id: "problem", label: "A problem" },
    { id: "first-run", label: "First run" },
  ];
  const elsewhere: { id: Elsewhere; label: string }[] = [
    { id: "none", label: "No one" },
    { id: "other", label: "Another part" },
    { id: "same", label: "The same part" },
  ];
  return (
    <div className="fixed bottom-3 left-3 z-50 w-64 rounded-lg border border-dashed border-input bg-popover/95 text-xs shadow-lg backdrop-blur">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left font-medium text-foreground" onClick={() => setOpen((current) => !current)}>
        <span className="rounded-sm bg-foreground px-1 py-0.5 text-2xs leading-none text-background">Prototype</span>
        <span className="flex-1">Decision 067</span>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-3.5 text-muted-foreground" aria-hidden />
      </button>
      {open ? (
        <div className="space-y-3 border-t border-border px-3 py-3">
          <div className="space-y-1.5">
            <p className="text-subtle-foreground">Scenario</p>
            <div className="flex gap-1">
              {scenarios.map((scenario) => (
                <button
                  key={scenario.id}
                  type="button"
                  className={cn("flex-1 cursor-pointer rounded-md px-1.5 py-1 text-2xs transition-colors", store.scenario === scenario.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover")}
                  onClick={() => {
                    store.setScenario(scenario.id);
                    nav.go({ page: "overview" });
                  }}
                >
                  {scenario.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            The next save fails
            <Switch checked={store.failNextSave} onCheckedChange={store.setFailNextSave} aria-label="The next save fails" />
          </label>
          <div className="space-y-1.5">
            <p className="text-subtle-foreground">Before your next save, someone else saves</p>
            <div className="flex gap-1">
              {elsewhere.map((choice) => (
                <button key={choice.id} type="button" className={cn("flex-1 cursor-pointer rounded-md px-1.5 py-1 text-2xs transition-colors", store.elsewhere === choice.id ? "bg-state-active text-foreground" : "text-muted-foreground hover:bg-state-hover")} onClick={() => store.setElsewhere(choice.id)}>
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center justify-between gap-2 text-muted-foreground">
            Dark
            <Switch checked={dark} onCheckedChange={setDark} aria-label="Dark" />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function Frame() {
  const scroller = useRef<HTMLDivElement>(null);
  const [dark, setDark] = useState(() => !new URLSearchParams(location.search).has("light"));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.classList.toggle("light", !dark);
  }, [dark]);
  const toTop = useCallback(() => scroller.current?.scrollTo({ top: 0 }), []);
  return (
    <NavProvider onScrollTop={toTop}>
      <TooltipProvider delayDuration={250}>
        <div className="flex h-full min-h-0 bg-background">
          <nav aria-label="BB" className="flex w-11 shrink-0 flex-col items-center gap-3 bg-rail py-3 text-muted-foreground max-md:hidden">
            <Icon name="Desktop" className="size-4" aria-hidden />
            <Icon name="Refresh" className="size-4" aria-hidden />
            <ProviderGlyph type="box" />
            <span className="mt-auto rounded-md bg-state-active p-1.5 text-foreground">
              <Icon name="Settings" className="size-4" aria-hidden />
            </span>
          </nav>
          <aside className="w-72 shrink-0 overflow-y-auto bg-sidebar px-2 py-3 text-sm max-lg:hidden">
            <div className="mb-3 flex items-center gap-2 px-2 text-muted-foreground">
              <Icon name="Search" className="size-4" aria-hidden />
              Search
            </div>
            {BB_SECTIONS.map((section) => (
              <p key={section} className="rounded-md px-2 py-1.5 text-foreground/90">
                {section}
              </p>
            ))}
            <p className="mt-4 px-2 pb-1 text-xs text-subtle-foreground">Plugins</p>
            {PLUGINS.map((plugin) => (
              <p key={plugin} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5", plugin === "BB Box" ? "bg-state-active text-foreground" : "text-foreground/90")}>
                {plugin === "BB Box" ? <ProviderGlyph type="box" className="text-foreground" /> : null}
                {plugin}
              </p>
            ))}
          </aside>
          <main className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-12 shrink-0 items-center border-b border-border px-4 text-sm font-medium text-foreground">Settings</header>
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto w-full max-w-3xl px-4 pb-24 pt-6 md:px-5">
                <PluginHeader />
                <SettingsRoot />
              </div>
            </div>
          </main>
        </div>
        <ScenarioBar dark={dark} setDark={setDark} />
      </TooltipProvider>
    </NavProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <Frame />
  </StoreProvider>,
);
