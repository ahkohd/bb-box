import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { flushSync } from "react-dom";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const SCROLL_SETTLE_MS = 150;

const DEFAULT_DELAY_MS = 700;

const SCROLLING_OVERFLOW = /auto|scroll|overlay|hidden|clip/;

const HUD_HEADER = "[data-bb-box-monitor-header]";

interface VisibleArea {
  readonly top: number;
  readonly bottom: number;
}

interface HudScroll {
  readonly scrolling: boolean;
  readonly visibleArea: () => VisibleArea;
}

const viewportArea = (): VisibleArea => ({ top: 0, bottom: window.innerHeight });

const HudScrollContext = createContext<HudScroll>({ scrolling: false, visibleArea: viewportArea });

function findScrollPort(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (SCROLLING_OVERFLOW.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

function hudVisibleArea(shell: HTMLElement | null): VisibleArea {
  const viewport = viewportArea();
  if (!shell) return viewport;
  const port = findScrollPort(shell)?.getBoundingClientRect() ?? viewport;
  const headerBottom = shell.querySelector(HUD_HEADER)?.getBoundingClientRect().bottom ?? port.top;
  return { top: Math.max(viewport.top, port.top, headerBottom), bottom: Math.min(viewport.bottom, port.bottom) };
}

function scrollMovesShell(event: Event, shell: HTMLElement | null): boolean {
  const target = event.target;
  if (!shell) return false;
  if (target === document || target === window) return true;
  return target instanceof Node && target.contains(shell);
}

export function HudScrollProvider({ container, children }: { container: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [scrolling, setScrolling] = useState(false);
  const scrollingNow = useRef(false);
  useEffect(() => {
    let settle: ReturnType<typeof setTimeout> | undefined;
    const onScroll = (event: Event) => {
      if (!scrollMovesShell(event, container.current)) return;
      if (!scrollingNow.current) {
        scrollingNow.current = true;
        flushSync(() => setScrolling(true));
      }
      clearTimeout(settle);
      settle = setTimeout(() => {
        scrollingNow.current = false;
        setScrolling(false);
      }, SCROLL_SETTLE_MS);
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      clearTimeout(settle);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [container]);
  const visibleArea = useCallback(() => hudVisibleArea(container.current), [container]);
  return <HudScrollContext.Provider value={{ scrolling, visibleArea }}>{children}</HudScrollContext.Provider>;
}

interface AnchorPlacement {
  readonly hiddenAbove: number;
}

interface HudTooltipState {
  readonly trigger: MutableRefObject<HTMLElement | null>;
  readonly pointerInside: MutableRefObject<boolean>;
  readonly mayOpen: () => boolean;
  readonly hiddenAbove: number;
  readonly scrolling: boolean;
}

const HudTooltipContext = createContext<HudTooltipState | null>(null);

function useHudTooltipState(part: string): HudTooltipState {
  const state = useContext(HudTooltipContext);
  if (!state) throw new Error(`${part} must be inside a HudTooltip`);
  return state;
}

function samePlacement(next: AnchorPlacement | null) {
  return (current: AnchorPlacement | null) => (current?.hiddenAbove === next?.hiddenAbove ? current : next);
}

function placeInArea(anchor: DOMRect, area: VisibleArea): AnchorPlacement | null {
  if (anchor.bottom <= area.top || anchor.top >= area.bottom) return null;
  return { hiddenAbove: Math.max(0, area.top - anchor.top) };
}

export function HudTooltip({
  open: openProp,
  onOpenChange,
  delayDuration = DEFAULT_DELAY_MS,
  ...props
}: ComponentPropsWithoutRef<typeof Tooltip>) {
  const { scrolling, visibleArea } = useContext(HudScrollContext);
  const trigger = useRef<HTMLElement | null>(null);
  const pointerInside = useRef(false);
  const [ownOpen, setOwnOpen] = useState(false);
  const [placement, setPlacement] = useState<AnchorPlacement | null>(null);
  const wanted = openProp ?? ownOpen;
  const setWanted = useCallback((next: boolean) => {
    setOwnOpen(next);
    onOpenChange?.(next);
  }, [onOpenChange]);
  const measure = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    return anchor ? placeInArea(anchor, visibleArea()) : null;
  }, [visibleArea]);
  const mayOpen = useCallback(() => {
    if (scrolling) return false;
    const next = measure();
    setPlacement(samePlacement(next));
    return next !== null;
  }, [scrolling, measure]);

  useLayoutEffect(() => {
    if (wanted && !scrolling) setPlacement(samePlacement(measure()));
  }, [wanted, scrolling, measure]);

  useEffect(() => {
    if (scrolling || wanted || !pointerInside.current) return;
    const rest = setTimeout(() => {
      if (pointerInside.current && mayOpen()) setWanted(true);
    }, delayDuration);
    return () => clearTimeout(rest);
  }, [scrolling]);

  return (
    <HudTooltipContext.Provider value={{ trigger, pointerInside, mayOpen, hiddenAbove: placement?.hiddenAbove ?? 0, scrolling }}>
      <Tooltip {...props} delayDuration={delayDuration} open={wanted && placement !== null} onOpenChange={setWanted} />
    </HudTooltipContext.Provider>
  );
}

function holdBackUnlessOpenable(event: SyntheticEvent, mayOpen: () => boolean) {
  if (!mayOpen()) event.preventDefault();
}

export const HudTooltipTrigger = forwardRef<
  ElementRef<typeof TooltipTrigger>,
  ComponentPropsWithoutRef<typeof TooltipTrigger>
>(function HudTooltipTriggerComponent({ onPointerEnter, onPointerMove, onPointerLeave, onFocus, ...props }, ref) {
  const { trigger, pointerInside, mayOpen } = useHudTooltipState("HudTooltipTrigger");
  const attach = useCallback((element: HTMLButtonElement | null) => {
    trigger.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  }, [ref, trigger]);
  return (
    <TooltipTrigger
      ref={attach}
      onPointerEnter={(event) => {
        onPointerEnter?.(event);
        if (event.pointerType !== "touch") pointerInside.current = true;
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (event.pointerType === "touch") return;
        pointerInside.current = true;
        holdBackUnlessOpenable(event, mayOpen);
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        pointerInside.current = false;
      }}
      onFocus={(event) => {
        onFocus?.(event);
        holdBackUnlessOpenable(event, mayOpen);
      }}
      {...props}
    />
  );
});

const SIDEWAYS = new Set(["left", "right"]);

const HIDDEN_AT_ONCE = { visibility: "hidden", animation: "none" } as const;

export const HudTooltipContent = forwardRef<
  ElementRef<typeof TooltipContent>,
  ComponentPropsWithoutRef<typeof TooltipContent>
>(function HudTooltipContentComponent({ side = "top", align = "center", alignOffset, style, ...props }, ref) {
  const { hiddenAbove, scrolling } = useHudTooltipState("HudTooltipContent");
  const keepsTopInView = align === "start" && SIDEWAYS.has(side);
  return (
    <TooltipContent
      ref={ref}
      side={side}
      align={align}
      alignOffset={keepsTopInView ? (alignOffset ?? 0) + hiddenAbove : alignOffset}
      style={scrolling ? { ...style, ...HIDDEN_AT_ONCE } : style}
      {...props}
    />
  );
});
