import { cssValue, deviceScale } from "./gl.ts";
import { onMotionChange, pausedByPerson, reducedMotion } from "../motion.ts";

interface Needle {
  x: number;
  y: number;
  angle: number;
  level: boolean;
}

const spacing = { alongPx: 9, downPx: 12 };
const needlePx = 7;
const restAngle = -Math.PI / 3;
const levelPx = spacing.alongPx - 1.5;
const turnRate = { least: 7, most: 16, nearPx: 600 };
const settledRadians = 0.003;
const halfTurn = Math.PI;

const towardsHalfTurn = (radians: number) => ((((radians + halfTurn / 2) % halfTurn) + halfTurn) % halfTurn) - halfTurn / 2;

function edgeNeedles(frame: HTMLElement): Needle[] {
  const box = frame.getBoundingClientRect();
  const top = frame.querySelector(".frame-top")!.getBoundingClientRect();
  const bottom = frame.querySelector(".frame-bottom")!.getBoundingClientRect();
  const inset = parseFloat(getComputedStyle(frame).fontSize) * 0.3;
  const gaps = [...frame.querySelectorAll<HTMLElement>(".frame-title, .frame-action")]
    .filter((part) => part.offsetWidth > 0)
    .map((part) => {
      const rect = part.getBoundingClientRect();
      return [rect.left - box.left - 2, rect.right - box.left + 2] as const;
    });
  const left = inset;
  const right = box.width - inset;
  const topY = top.top - box.top + top.height / 2;
  const bottomY = bottom.top - box.top + bottom.height / 2;
  const needle = (x: number, y: number): Needle => ({ x, y, angle: restAngle, level: false });
  const needles: Needle[] = [];
  for (let x = left; x <= right; x += spacing.alongPx) {
    if (!gaps.some(([from, to]) => x > from && x < to)) needles.push({ x, y: topY, angle: 0, level: true });
    needles.push(needle(x, bottomY));
  }
  for (let y = topY + spacing.downPx; y < bottomY; y += spacing.downPx) {
    needles.push(needle(left, y));
    needles.push(needle(right, y));
  }
  return needles;
}

export function pointFramesAtPointer(frame: HTMLElement): void {
  const canvas = frame.querySelector<HTMLCanvasElement>(".frame-compass");
  const pen = canvas?.getContext("2d");
  if (!canvas || !pen) return;
  let needles: Needle[] = [];
  let size = { width: 0, height: 0 };
  let pointer: { x: number; y: number } | undefined;
  let frameId = 0;
  let previous: number | undefined;
  let onScreen = false;
  const ink = { line: "" };

  const still = () => reducedMotion() || pausedByPerson();

  const layout = () => {
    const box = frame.getBoundingClientRect();
    size = { width: box.width, height: box.height };
    const scale = deviceScale();
    canvas.width = Math.round(box.width * scale);
    canvas.height = Math.round(box.height * scale);
    pen.setTransform(scale, 0, 0, scale, 0, 0);
    const before = needles;
    needles = edgeNeedles(frame);
    if (before.length) needles.forEach((needle, index) => (needle.angle = before[index]?.angle ?? restAngle));
  };

  const restyle = () => {
    ink.line = cssValue(frame, "--frame-ink");
  };

  const targetOf = (needle: Needle, at: { x: number; y: number }) => Math.atan2(at.y - needle.y, at.x - needle.x);

  const pointerHere = () => {
    if (!pointer) return undefined;
    const box = frame.getBoundingClientRect();
    return { x: pointer.x - box.left, y: pointer.y - box.top };
  };

  const draw = () => {
    pen.clearRect(0, 0, size.width, size.height);
    pen.lineCap = "butt";
    pen.lineWidth = 1.25;
    pen.strokeStyle = ink.line;
    pen.beginPath();
    for (const needle of needles) {
      const length = needle.level ? levelPx : needlePx;
      const dx = (Math.cos(needle.angle) * length) / 2;
      const dy = (Math.sin(needle.angle) * length) / 2;
      pen.moveTo(needle.x - dx, needle.y - dy);
      pen.lineTo(needle.x + dx, needle.y + dy);
    }
    pen.stroke();
  };

  const turn = (now: number) => {
    frameId = 0;
    const seconds = previous === undefined ? 1 / 60 : Math.min(0.05, (now - previous) / 1000);
    previous = now;
    const at = pointerHere();
    let moving = false;
    if (at && !still()) {
      for (const needle of needles) {
        if (needle.level) continue;
        const distance = Math.hypot(at.x - needle.x, at.y - needle.y);
        const rate = turnRate.most - (turnRate.most - turnRate.least) * Math.min(1, distance / turnRate.nearPx);
        const delta = towardsHalfTurn(targetOf(needle, at) - needle.angle);
        needle.angle += delta * (1 - Math.exp(-seconds * rate));
        if (Math.abs(delta) > settledRadians) moving = true;
      }
    }
    draw();
    if (moving && onScreen) frameId = requestAnimationFrame(turn);
    else previous = undefined;
  };

  const wake = () => {
    if (!frameId && onScreen && !still()) frameId = requestAnimationFrame(turn);
  };

  const rest = () => {
    for (const needle of needles) if (!needle.level) needle.angle = restAngle;
    draw();
  };

  restyle();
  layout();
  frame.dataset.compass = "on";
  rest();

  addEventListener(
    "pointermove",
    (event) => {
      pointer = { x: event.clientX, y: event.clientY };
      wake();
    },
    { passive: true },
  );
  addEventListener("scroll", wake, { passive: true });
  new IntersectionObserver(([entry]) => {
    onScreen = entry!.isIntersecting;
    wake();
  }).observe(frame);
  new ResizeObserver(() => {
    layout();
    draw();
  }).observe(frame);
  new MutationObserver(() => {
    restyle();
    draw();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  onMotionChange(() => (still() ? rest() : wake()));
}
