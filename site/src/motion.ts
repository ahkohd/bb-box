export interface Animation {
  draw: (seconds: number) => void;
  resize?: () => void;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function animateWhileSeen(element: Element, animation: Animation, framesPerSecond = 24): void {
  const frameMs = 1000 / framesPerSecond;
  let onScreen = false;
  let frame = 0;
  let last = 0;
  const startedAt = performance.now();

  const drawStill = () => animation.draw(0);

  const tick = (now: number) => {
    frame = 0;
    if (!onScreen || document.hidden || reducedMotion()) return;
    if (now - last >= frameMs) {
      last = now;
      animation.draw((now - startedAt) / 1000);
    }
    frame = requestAnimationFrame(tick);
  };

  const run = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (reducedMotion()) drawStill();
    else if (onScreen && !document.hidden) frame = requestAnimationFrame(tick);
  };

  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    run();
  }).observe(element);

  new ResizeObserver(() => {
    animation.resize?.();
    animation.draw((performance.now() - startedAt) / 1000);
  }).observe(element);

  new MutationObserver(() => animation.draw((performance.now() - startedAt) / 1000)).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  document.addEventListener("visibilitychange", run);
  matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", run);
  drawStill();
}

export const cssColour = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property).trim();
