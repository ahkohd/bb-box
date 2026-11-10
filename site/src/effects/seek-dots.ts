import { clockOf } from "../demo.ts";
import { animateWhileSeen, pausedByPerson, reducedMotion } from "../motion.ts";
import { cssValue, deviceScale } from "./gl.ts";

const pitchPx = 6;
const dotPx = 1.6;
const swell = { reachPx: 34, dragReachPx: 48, rows: 2, dragRows: 3, ticksPerSecond: 14 };
const pulse = { seconds: 0.7, pxPerSecond: 900, frontPx: 18 };
const keySteps = { small: 5, large: 10 };
const playhead = { glyph: "@", px: 14, dragPx: 17 };

function hashed(column: number, row: number, tick: number): number {
  const value = Math.sin(column * 127.1 + row * 311.7 + tick * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(least, value));

interface Pulse {
  x: number;
  startsAt: number;
}

export function startSeek(seek: HTMLElement, video: HTMLVideoElement, fallbackSeconds: number): void {
  const canvas = seek.querySelector("canvas")!;
  const tip = seek.querySelector<HTMLElement>("[data-seek-tip]")!;
  const pen = canvas.getContext("2d");
  if (!pen) return;
  let width = 0;
  let tall = 0;
  let pointerX: number | null = null;
  let dragging = false;
  let pulses: Pulse[] = [];
  const ink = { played: "", ahead: "", hot: "", mono: "" };
  const lively = () => !reducedMotion() && !pausedByPerson();
  const duration = () => (Number.isFinite(video.duration) && video.duration > 0 ? video.duration : fallbackSeconds);
  const playedX = () => (video.currentTime / duration()) * width;

  const restyle = () => {
    ink.played = cssValue(canvas, "--accent");
    ink.ahead = cssValue(canvas, "--frame-ink");
    ink.hot = cssValue(canvas, "--field-hot") || ink.played;
    ink.mono = cssValue(canvas, "--sl-font-mono") || "monospace";
  };

  const resize = () => {
    const scale = deviceScale();
    ({ width, height: tall } = canvas.getBoundingClientRect());
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(tall * scale);
    pen.setTransform(scale, 0, 0, scale, 0, 0);
  };

  const pulseAt = (x: number, now: number) => {
    let strongest = 0;
    for (const { x: fromX, startsAt } of pulses) {
      const age = (now - startsAt) / 1000;
      if (age > pulse.seconds) continue;
      const front = age * pulse.pxPerSecond;
      strongest = Math.max(strongest, Math.max(0, 1 - Math.abs(Math.abs(x - fromX) - front) / pulse.frontPx) * (1 - age / pulse.seconds));
    }
    return strongest;
  };

  const dot = (x: number, y: number, side: number) => pen.fillRect(x - side / 2, y - side / 2, side, side);

  const draw = (seconds: number) => {
    if (!width) resize();
    pen.clearRect(0, 0, width, tall);
    const middle = tall / 2;
    const head = playedX();
    const now = performance.now();
    const tick = Math.floor(seconds * swell.ticksPerSecond);
    const reach = dragging ? swell.dragReachPx : swell.reachPx;
    const mostRows = dragging ? swell.dragRows : swell.rows;
    const columns = Math.ceil(width / pitchPx);
    const headPx = dragging ? playhead.dragPx : playhead.px;
    const clampedHead = clamp(head, headPx / 2, width - headPx / 2);
    const headClearPx = headPx * 0.55;
    for (let column = 0; column < columns; column++) {
      const x = column * pitchPx + pitchPx / 2;
      if (Math.abs(x - clampedHead) < headClearPx) continue;
      const played = x <= head;
      const near = pointerX === null ? 0 : Math.max(0, 1 - Math.abs(x - pointerX) / reach) ** 2;
      const wave = pulses.length && lively() ? pulseAt(x, now) : 0;
      const flicker = lively() ? hashed(column, 0, tick) : 0.5;
      const rows = Math.round((near * mostRows + wave * 2) * (0.7 + flicker * 0.6));
      pen.globalAlpha = played ? 0.95 : 0.7;
      pen.fillStyle = wave > 0.4 ? ink.hot : played ? ink.played : ink.ahead;
      dot(x, middle, dotPx + near * 0.8);
      for (let row = 1; row <= rows; row++) {
        pen.globalAlpha = (1 - row / (mostRows + 3)) * (played ? 0.9 : 0.6);
        dot(x, middle - row * pitchPx * 0.75, dotPx);
        dot(x, middle + row * pitchPx * 0.75, dotPx);
      }
    }
    pen.globalAlpha = 1;
    pen.font = `${headPx}px ${ink.mono}`;
    pen.textAlign = "center";
    pen.textBaseline = "middle";
    pen.fillStyle = ink.played;
    pen.fillText(playhead.glyph, clampedHead, middle + headPx * 0.06);
    if (pulses.length && pulses.every(({ startsAt }) => (now - startsAt) / 1000 > pulse.seconds)) pulses = [];
  };

  const redraw = () => draw(performance.now() / 1000);

  const showTip = () => {
    const at = dragging ? playedX() : pointerX;
    tip.hidden = at === null;
    if (at === null) return;
    tip.textContent = clockOf((at / width) * duration());
    tip.style.left = `${clamp(at, 12, width - 12)}px`;
  };

  const announce = () => {
    seek.setAttribute("aria-valuemax", String(Math.round(duration())));
    seek.setAttribute("aria-valuenow", String(Math.round(video.currentTime)));
    seek.setAttribute("aria-valuetext", `${clockOf(video.currentTime)} of ${clockOf(duration())}`);
  };

  const seekTo = (seconds: number) => {
    video.currentTime = clamp(seconds, 0, duration() - 0.05);
    announce();
    showTip();
    redraw();
  };

  const xOf = (event: PointerEvent) => clamp(event.clientX - canvas.getBoundingClientRect().left, 0, width);
  const sendPulse = (x: number) => {
    if (lively()) pulses = [...pulses, { x, startsAt: performance.now() }];
  };

  seek.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    seek.setPointerCapture(event.pointerId);
    dragging = true;
    pointerX = xOf(event);
    seekTo((pointerX / width) * duration());
  });

  seek.addEventListener("pointermove", (event) => {
    pointerX = xOf(event);
    if (dragging) seekTo((pointerX / width) * duration());
    else {
      showTip();
      redraw();
    }
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    sendPulse(playedX());
    showTip();
    redraw();
  };
  seek.addEventListener("pointerup", endDrag);
  seek.addEventListener("pointercancel", endDrag);

  seek.addEventListener("pointerleave", () => {
    if (dragging) return;
    pointerX = null;
    showTip();
    redraw();
  });

  seek.addEventListener("keydown", (event) => {
    const steps: Record<string, number> = {
      ArrowLeft: -keySteps.small,
      ArrowDown: -keySteps.small,
      ArrowRight: keySteps.small,
      ArrowUp: keySteps.small,
      PageDown: -keySteps.large,
      PageUp: keySteps.large,
    };
    let target: number | undefined;
    if (event.key in steps) target = video.currentTime + steps[event.key]!;
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = duration();
    if (target === undefined) return;
    event.preventDefault();
    seekTo(target);
    sendPulse(playedX());
  });

  ["timeupdate", "loadedmetadata", "seeked"].forEach((name) =>
    video.addEventListener(name, () => {
      announce();
      if (!lively()) redraw();
    }),
  );

  restyle();
  announce();
  animateWhileSeen(canvas, { draw, resize, restyle }, 30);
}
