import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

export type OptionPage = "boxes" | "images" | "devices" | "network" | "monitor" | "configuration";

export type View =
  | { readonly page: "overview" }
  | { readonly page: "backend"; readonly id: string }
  | { readonly page: "kind"; readonly id: string }
  | { readonly page: "option"; readonly id: OptionPage }
  | { readonly page: "add" }
  | { readonly page: "setup"; readonly type: string };

interface UnsavedEdits {
  readonly what: string;
  readonly dirty: () => boolean;
}

interface Nav {
  readonly view: View;
  readonly direction: "forward" | "back";
  readonly found: string | null;
  go(view: View, found?: string): void;
  back(): void;
  guard(edits: UnsavedEdits | null): void;
}

const NavContext = createContext<Nav | null>(null);

export function viewKey(view: View): string {
  return Object.values(view).join("/");
}

export function hashOf(view: View): string {
  return view.page === "overview" ? "" : `#${viewKey(view)}`;
}

export function NavProvider({ children, onScrollTop }: { children: ReactNode; onScrollTop: () => void }) {
  const [stack, setStack] = useState<View[]>([{ page: "overview" }]);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [found, setFound] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ what: string; proceed: () => void } | null>(null);
  const edits = useRef<UnsavedEdits | null>(null);

  const leave = useCallback((proceed: () => void) => {
    const current = edits.current;
    if (current?.dirty()) {
      setAsking({ what: current.what, proceed });
      return;
    }
    proceed();
  }, []);

  const go = useCallback(
    (view: View, field?: string) =>
      leave(() => {
        edits.current = null;
        setDirection(view.page === "overview" ? "back" : "forward");
        setFound(field ?? null);
        setStack((current) => (view.page === "overview" ? [view] : [...current, view]));
        onScrollTop();
      }),
    [leave, onScrollTop],
  );

  const back = useCallback(
    () =>
      leave(() => {
        edits.current = null;
        setDirection("back");
        setFound(null);
        setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
        onScrollTop();
      }),
    [leave, onScrollTop],
  );

  const nav = useMemo<Nav>(
    () => ({
      view: stack[stack.length - 1]!,
      direction,
      found,
      go,
      back,
      guard: (next) => {
        edits.current = next;
      },
    }),
    [stack, direction, found, go, back],
  );

  return (
    <NavContext.Provider value={nav}>
      {children}
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes to {asking?.what}?</AlertDialogTitle>
            <AlertDialogDescription>They are not saved yet.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const proceed = asking?.proceed;
                edits.current = null;
                setAsking(null);
                proceed?.();
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </NavContext.Provider>
  );
}

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("No nav");
  return nav;
}
