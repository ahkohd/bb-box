import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BoxGlyph } from "@/src/app/glyphs.tsx";
import { AgentPage } from "./agent";
import { BoxPage } from "./box-page";
import { BoxesPage } from "./boxes";
import { go, useRoute, type Route } from "./nav";
import { NewBoxPage } from "./new-box";
import { SettingsPage } from "./settings";
import { StoreProvider, useStore } from "./store";

const PROJECTS = ["ranking", "web-app", "infra", "docs"];

function Panel({ route }: { route: Route }) {
  switch (route.page) {
    case "boxes":
      return <BoxesPage />;
    case "new":
      return <NewBoxPage />;
    case "box":
      return <BoxPage key={`${route.id}-${route.resize ? "r" : ""}`} id={route.id} resize={route.resize === true} />;
    case "settings":
      return <SettingsPage />;
    case "agent":
      return <AgentPage />;
  }
}

const JUMPS: readonly { label: string; route: Route }[] = [
  { label: "Boxes, by card", route: { page: "boxes" } },
  { label: "New box", route: { page: "new" } },
  { label: "amber-fox: shared desktop", route: { page: "box", id: "bxamberfox2q7k" } },
  { label: "quiet-elm: whole card", route: { page: "box", id: "bxquietelm7k2p" } },
  { label: "calm-reef: no GPU", route: { page: "box", id: "bxcalmreef3h6n" } },
  { label: "pale-moss: CPU desktop", route: { page: "box", id: "bxpalemoss6w2r" } },
  { label: "swift-owl: stopped", route: { page: "box", id: "bxswiftowl9d3t" } },
  { label: "dock-wren: Docker", route: { page: "box", id: "bxdockwren5v1c" } },
  { label: "Settings: GPUs", route: { page: "settings" } },
  { label: "An agent asks", route: { page: "agent" } },
];

function ScenarioBar({ dark, setDark }: { dark: boolean; setDark: (dark: boolean) => void }) {
  const store = useStore();
  const [open, setOpen] = useState(() => !new URLSearchParams(location.search).has("closed"));
  const elm = store.boxes.some((box) => box.id === "bxquietelm7k2p");
  return (
    <aside aria-label="Prototype controls" className="fixed bottom-3 left-3 z-50 w-72 max-w-[calc(100vw-1.5rem)] rounded-lg border border-dashed border-input bg-popover/95 text-xs backdrop-blur max-sm:bottom-auto max-sm:left-auto max-sm:right-3 max-sm:top-3">
      <button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-foreground" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
        <span className="rounded-sm bg-foreground px-1 py-0.5 text-2xs leading-none text-background">Prototype</span>
        <span className="flex-1">Decision 071</span>
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
          <div className="grid gap-1">
            <Button type="button" variant="outline" size="sm" className="h-7 w-full text-2xs font-normal" disabled={!elm} onClick={() => store.release("bxquietelm7k2p")}>
              {elm ? "Release quiet-elm, freeing card 0" : "Card 0 is free"}
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-7 w-full text-2xs font-normal" onClick={() => go({ page: "box", id: "bxamberfox2q7k", resize: true })}>
              Resize amber-fox to a whole card
            </Button>
          </div>
          <div className="flex items-center justify-between gap-2 text-muted-foreground">
            <label className="flex items-center gap-2">
              Dark
              <Switch checked={dark} onCheckedChange={setDark} aria-label="Dark" />
            </label>
            <Button type="button" variant="ghost" size="sm" className="h-7 text-2xs font-normal" onClick={store.reset}>
              Start over
            </Button>
          </div>
          <p className="text-2xs leading-snug text-subtle-foreground">One Proxmox LXC node with two cards and one Docker host with one. A box holds its card from the moment it is placed; a stopped shared box holds none. Figures are made up. Starts and restarts take a few seconds. Nothing is saved.</p>
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
    </div>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 bg-background">
      <nav aria-label="BB" className="flex w-11 shrink-0 flex-col items-center gap-3 bg-rail py-3 text-muted-foreground max-sm:hidden">
        <button type="button" aria-label="New box" className="rounded-md p-1.5 hover:bg-state-hover" onClick={() => go({ page: "new" })}>
          <Icon name="Plus" className="size-4" aria-hidden />
        </button>
        <button type="button" aria-label="Boxes" className="rounded-md bg-state-active p-1.5 text-foreground" onClick={() => go({ page: "boxes" })}>
          <BoxGlyph className="size-4" />
        </button>
        <button type="button" aria-label="Settings" className="mt-auto rounded-md p-1.5 hover:bg-state-hover" onClick={() => go({ page: "settings" })}>
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
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4 text-sm text-foreground">
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
  const routeKey = JSON.stringify(route);
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [routeKey]);
  return (
    <TooltipProvider delayDuration={250}>
      <Chrome>
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-24">
          <Panel route={route} />
        </div>
      </Chrome>
      <ScenarioBar dark={dark} setDark={setDark} />
      <ToastView />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider>
    <Frame />
  </StoreProvider>,
);
