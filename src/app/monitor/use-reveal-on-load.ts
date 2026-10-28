import { useLayoutEffect, useRef, type RefObject } from "react";

const REVEAL_FRAMES: Keyframe[] = [
  { filter: "blur(4px)", opacity: 0 },
  { filter: "blur(0)", opacity: 1 },
];

const REVEAL_TIMING: KeyframeAnimationOptions = { duration: 320, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useRevealOnLoad(container: RefObject<HTMLElement | null>, machineId: string, loaded: boolean) {
  const awaitingFirstReading = useRef<string | null>(loaded ? null : machineId);
  useLayoutEffect(() => {
    if (!loaded) {
      awaitingFirstReading.current = machineId;
      return;
    }
    const firstReading = awaitingFirstReading.current === machineId;
    awaitingFirstReading.current = null;
    if (!firstReading || prefersReducedMotion()) return;
    const animations = Array.from(container.current?.querySelectorAll("[data-reveal]") ?? [], (element) =>
      element.animate(REVEAL_FRAMES, REVEAL_TIMING),
    );
    return () => animations.forEach((animation) => animation.cancel());
  }, [container, machineId, loaded]);
}
