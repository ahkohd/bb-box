import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

export interface TabContextMenuProps {
  children: React.ReactNode;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  hasOthers: boolean;
}

export function TabContextMenu({ children, onClose, onCloseOthers, onCloseAll, hasOthers }: TabContextMenuProps) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (at === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAt(null);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-tab-menu]") !== null) return;
      setAt(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [at]);

  return (
    <div
      className="contents"
      onContextMenu={(event) => {
        event.preventDefault();
        setAt({ x: event.clientX, y: event.clientY });
      }}
    >
      {children}
      {at === null
        ? null
        : createPortal(
            <div
              data-tab-menu
              role="menu"
              style={{ left: at.x, top: at.y }}
              className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground"
            >
              <MenuItem
                onSelect={() => {
                  setAt(null);
                  onClose();
                }}
              >
                Close
              </MenuItem>
              <MenuItem
                disabled={!hasOthers}
                onSelect={() => {
                  setAt(null);
                  onCloseOthers();
                }}
              >
                Close others
              </MenuItem>
              <MenuItem
                onSelect={() => {
                  setAt(null);
                  onCloseAll();
                }}
              >
                Close all
              </MenuItem>
            </div>,
            document.body,
          )}
    </div>
  );
}

function MenuItem({ children, onSelect, disabled }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-[13px] outline-none select-none",
        "hover:bg-state-hover hover:text-foreground focus:bg-state-hover focus:text-foreground",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
