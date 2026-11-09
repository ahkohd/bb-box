import { motionPausedKey } from "./motion-memory.ts";

export interface Animation {
  draw: (seconds: number) => void;
  resize?: () => void;
  restyle?: () => void;
}

const motionChanged = "bb-box-motion-change";
const reducedMotionQuery = matchMedia("(prefers-reduced-motion: reduce)");

export const reducedMotion = () => reducedMotionQuery.matches;
export const pausedByPerson = () => document.documentElement.dataset.motion === "paused";

function rememberForTheVisit(paused: boolean): void {
  try {
    if (paused) sessionStorage.setItem(motionPausedKey, "yes");
    else sessionStorage.removeItem(motionPausedKey);
  } catch {}
}

export function setPausedByPerson(paused: boolean): void {
  if (paused) document.documentElement.dataset.motion = "paused";
  else delete document.documentElement.dataset.motion;
  rememberForTheVisit(paused);
  announceMotionChange();
}

export const announceMotionChange = () => document.dispatchEvent(new Event(motionChanged));

export function onMotionChange(listener: () => void): void {
  document.addEventListener(motionChanged, listener);
  reducedMotionQuery.addEventListener("change", listener);
}

export function animateWhileSeen(element: Element, animation: Animation, framesPerSecond = 24, alwaysStill = false): void {
  const frameMs = 1000 / framesPerSecond;
  let onScreen = false;
  let frame = 0;
  let previous: number | undefined;
  let sinceLastFrame = frameMs;
  let seconds = 0;

  const moving = () => !alwaysStill && onScreen && !document.hidden && !reducedMotion() && !pausedByPerson();
  const shownSeconds = () => (reducedMotion() || alwaysStill ? 0 : seconds);

  const tick = (now: number) => {
    frame = 0;
    if (!moving()) {
      previous = undefined;
      return;
    }
    if (previous !== undefined) {
      seconds += (now - previous) / 1000;
      sinceLastFrame += now - previous;
    }
    previous = now;
    if (sinceLastFrame >= frameMs) {
      sinceLastFrame = 0;
      animation.draw(seconds);
    }
    frame = requestAnimationFrame(tick);
  };

  const run = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    previous = undefined;
    if (moving()) frame = requestAnimationFrame(tick);
    else animation.draw(shownSeconds());
  };

  new IntersectionObserver((entries) => {
    onScreen = entries.some((entry) => entry.isIntersecting);
    run();
  }).observe(element);

  new ResizeObserver(() => {
    animation.resize?.();
    animation.draw(shownSeconds());
  }).observe(element);

  new MutationObserver(() => {
    animation.restyle?.();
    animation.draw(shownSeconds());
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  document.addEventListener("visibilitychange", run);
  onMotionChange(run);
  animation.restyle?.();
  animation.draw(0);
}

export const cssColour = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property).trim();
