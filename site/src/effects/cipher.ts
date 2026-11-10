import { cipherDuration, cipherFrame, letterGlyphsFor, monoGlyphsFor, revealTimes, type GlyphsFor } from "./cipher-text.ts";
import { onMotionChange, pausedByPerson, reducedMotion } from "../motion.ts";

interface Running {
  element: HTMLElement;
  layer: HTMLElement | null;
  chars: HTMLElement[];
  text: string;
  glyphs: GlyphsFor;
  startsAt: number;
  revealAt: number[];
  duration: number;
}

const frameMs = 1000 / 30;
const running = new Map<HTMLElement, Running>();
let ticking = 0;
let lastFrame = 0;
const started = new WeakSet<HTMLElement>();

const still = () => reducedMotion() || pausedByPerson();

const escaped = (glyph: string) => (glyph === "<" ? "&lt;" : glyph === ">" ? "&gt;" : glyph === "&" ? "&amp;" : glyph);

function finish(run: Running): void {
  run.element.removeAttribute("data-running");
  if (run.layer) run.layer.textContent = "";
  run.chars.forEach((char) => char.removeAttribute("data-glyph"));
  running.delete(run.element);
}

function show(run: Running, elapsed: number): void {
  const pieces = cipherFrame(run.text, elapsed, run.revealAt, run.glyphs, Math.random);
  if (run.chars.length) {
    pieces.forEach((piece, index) => {
      const char = run.chars[index];
      if (!char) return;
      if (piece.settled) char.removeAttribute("data-glyph");
      else char.setAttribute("data-glyph", piece.glyph);
    });
    return;
  }
  if (run.layer) run.layer.innerHTML = pieces.map((piece) => (piece.settled ? escaped(piece.glyph) : `<span class="cipher-glyph">${escaped(piece.glyph)}</span>`)).join("");
}

function tick(now: number): void {
  ticking = 0;
  if (still()) {
    running.forEach(finish);
    return;
  }
  if (now - lastFrame >= frameMs) {
    lastFrame = now;
    for (const run of running.values()) {
      const elapsed = now - run.startsAt;
      if (elapsed < 0) continue;
      run.element.setAttribute("data-running", "");
      if (elapsed >= run.duration) {
        finish(run);
        continue;
      }
      show(run, elapsed);
    }
  }
  if (running.size) ticking = requestAnimationFrame(tick);
}

export function playCipher(element: HTMLElement, delayMs = Number(element.dataset.cipherDelay ?? 0)): void {
  if (still() || running.has(element)) return;
  const chars = [...element.querySelectorAll<HTMLElement>(".cipher-char")];
  const real = element.querySelector<HTMLElement>(".cipher-real");
  const layer = element.querySelector<HTMLElement>(".cipher-layer");
  if (!chars.length && (!real || !layer)) return;
  const text = chars.length ? chars.map((char) => char.textContent ?? "").join("") : (real!.dataset.text ?? real!.textContent ?? "");
  const duration = Number(element.dataset.cipherDuration ?? cipherDuration(text));
  running.set(element, {
    element,
    layer,
    chars,
    text,
    glyphs: element.dataset.cipher === "letters" ? letterGlyphsFor : monoGlyphsFor,
    startsAt: performance.now() + delayMs,
    revealAt: revealTimes(text, duration, Math.random),
    duration,
  });
  if (!ticking) ticking = requestAnimationFrame(tick);
}

const enteredOnce = new WeakSet<HTMLElement>();
const enteredShare = 0.6;

const seen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      const element = entry.target as HTMLElement;
      const run = running.get(element);
      if (!entry.isIntersecting) {
        if (run) finish(run);
        continue;
      }
      if (entry.intersectionRatio >= enteredShare && !enteredOnce.has(element)) {
        enteredOnce.add(element);
        playCipher(element);
      }
    }
  },
  { threshold: [0, enteredShare] },
);

export function watchCiphers(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-cipher]")) {
    if (started.has(element)) continue;
    started.add(element);
    seen.observe(element);
    const hoverTarget = element.closest<HTMLElement>("[data-cipher-hover]");
    hoverTarget?.addEventListener("pointerenter", () => playCipher(element, 0));
  }
}

onMotionChange(() => {
  if (still()) running.forEach(finish);
});
