import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode, type RefObject } from "react";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const DIALOG_CONTENT = "flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1rem)] max-w-lg flex-col gap-4 overflow-hidden rounded-lg p-4 shadow-none sm:w-full sm:p-6";
export const DIALOG_HEADER = "shrink-0 space-y-2 text-left";
export const DIALOG_TITLE = "text-base font-normal";
export const DIALOG_BODY = "min-h-0 flex-1 space-y-3 overflow-y-auto text-sm leading-relaxed text-muted-foreground";
export const DIALOG_FOOTER = "shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end sm:space-x-0 [&>*]:mt-0 [&>*]:h-auto [&>*]:w-full [&>*]:whitespace-normal sm:[&>*]:w-auto";

const DialogBusy = createContext(false);

export function useDialogBusy(): boolean {
  return useContext(DialogBusy);
}

function rememberOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const menu = active.closest("[role=menu]");
  if (menu instanceof HTMLElement && menu.id) {
    return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`);
  }
  return active;
}

export function BoxDialog({
  open = true,
  title,
  description,
  children,
  footer,
  onClose,
  clearRefused,
  returnTo,
  busy = false,
  refused = null,
  onSubmit,
  onOpenAutoFocus,
  onCloseAutoFocus,
  marks,
}: {
  open?: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  clearRefused?: () => void;
  returnTo?: RefObject<HTMLElement | null>;
  busy?: boolean;
  refused?: string | null;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
  marks?: Record<string, string | undefined>;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const seenOpen = useRef(open);
  const clearOnClose = useRef(clearRefused);
  clearOnClose.current = clearRefused;
  if (open && !wasOpen.current) opener.current = rememberOpener();
  wasOpen.current = open;
  useEffect(() => {
    if (seenOpen.current && !open) clearOnClose.current?.();
    seenOpen.current = open;
  }, [open]);
  const body = (
    <>
      <div className={DIALOG_BODY} {...(busy ? { inert: true } : {})}>
        {children}
        <Refused words={refused} />
      </div>
      {footer ? <AlertDialogFooter className={DIALOG_FOOTER}>{footer}</AlertDialogFooter> : null}
    </>
  );
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <AlertDialogContent
        className={DIALOG_CONTENT}
        {...marks}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (event.defaultPrevented) return;
          const first = (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("[data-first-focus]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onCloseAutoFocus={(event) => {
          if (onCloseAutoFocus) {
            onCloseAutoFocus(event);
            return;
          }
          event.preventDefault();
          const target = returnTo?.current ?? (opener.current?.isConnected ? opener.current : null);
          window.setTimeout(() => target?.focus(), 0);
        }}
      >
        <DialogBusy.Provider value={busy}>
          <AlertDialogHeader className={DIALOG_HEADER}>
            <AlertDialogTitle className={DIALOG_TITLE}>{title}</AlertDialogTitle>
            {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
          </AlertDialogHeader>
          {onSubmit ? (
            <form
              className="contents"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy) onSubmit(event);
              }}
            >
              {body}
            </form>
          ) : (
            body
          )}
        </DialogBusy.Provider>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Refused({ words }: { words: string | null }) {
  return words ? (
    <p role="alert" className="text-xs text-destructive-text">
      {words}
    </p>
  ) : null;
}

export function DialogCancel({ children = "Cancel", disabled, className, ...props }: ComponentProps<typeof AlertDialogCancel>) {
  const busy = useDialogBusy();
  return (
    <AlertDialogCancel className={cn("mt-0", className)} disabled={disabled || busy} {...props}>
      {children}
    </AlertDialogCancel>
  );
}

export function DialogButton({ danger, busyWords, children, disabled, variant, className, type = "button", ...props }: ButtonProps & { danger?: boolean; busyWords?: string }) {
  const busy = useDialogBusy();
  return (
    <Button type={type} variant={danger ? "destructive" : variant} className={className} disabled={disabled || busy} {...props}>
      {busy && busyWords ? busyWords : children}
    </Button>
  );
}

export function useDialogAction(onClose: () => void): { readonly busy: boolean; readonly refused: string | null; readonly run: (act: () => Promise<string | null | void> | string | null | void) => Promise<void>; readonly clear: () => void; readonly close: () => void } {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const clear = () => setRefused(null);
  const close = () => {
    clear();
    onClose();
  };
  const run = async (act: () => Promise<string | null | void> | string | null | void) => {
    setBusy(true);
    setRefused(null);
    try {
      const why = await act();
      if (typeof why === "string" && why) setRefused(why);
      else onClose();
    } catch (error) {
      setRefused(error instanceof Error ? error.message : "Not done. Nothing changed.");
    } finally {
      setBusy(false);
    }
  };
  return { busy, refused, run, clear, close };
}
