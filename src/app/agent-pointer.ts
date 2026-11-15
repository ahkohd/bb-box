import { AGENT_VERB, agentPlaceOf, type AgentPlace } from "../core/pointer.ts";
import { CURSOR_HOTSPOTS, ShapeTimeline, type ActionShape } from "../core/pointer-shapes.ts";
import { CURSOR_PARTS, type CursorInk } from "../core/record-cursor-paths.ts";
import type { Picture } from "./box-pointer.ts";

const SVG = "http://www.w3.org/2000/svg";
const CURSOR_VIEW = 32;
const CURSOR_PX = 40;
const RING_PX = 36;
const RING_MS = 600;
const INK_COLOURS: Readonly<Record<CursorInk, string>> = { ink: "var(--primary)", paper: "var(--primary-foreground)" };

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function secondsNow(): number {
  return performance.now() / 1000;
}

function cursor(shape: ActionShape): SVGSVGElement {
  const [hotX, hotY] = CURSOR_HOTSPOTS[shape];
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${CURSOR_VIEW} ${CURSOR_VIEW}`);
  svg.setAttribute("width", String(CURSOR_PX));
  svg.setAttribute("height", String(CURSOR_PX));
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = `position:absolute;left:${-(hotX * CURSOR_PX) / CURSOR_VIEW}px;top:${-(hotY * CURSOR_PX) / CURSOR_VIEW}px;overflow:visible`;
  const parts = CURSOR_PARTS[shape];
  for (const part of [...parts.outlines, ...parts.fills]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", part.d);
    path.setAttribute("fill", INK_COLOURS[part.ink]);
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
  }
  for (const part of parts.strokes) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", part.d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", INK_COLOURS[part.ink]);
    path.setAttribute("stroke-width", "1");
    path.setAttribute("stroke-linecap", "round");
    svg.appendChild(path);
  }
  return svg;
}

export class AgentPointer {
  #place: AgentPlace | null = null;
  #shown: HTMLDivElement | null = null;
  #picture: Picture | null = null;
  #hidden = true;
  #shape: ActionShape = "arrow";
  #reshapes: ReturnType<typeof setTimeout> | null = null;
  readonly #shapes = new ShapeTimeline(secondsNow());
  readonly #container: HTMLElement;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  message(text: string): boolean {
    const comma = text.indexOf(",");
    if ((comma < 0 ? text : text.slice(0, comma)) !== AGENT_VERB) return false;
    const place = agentPlaceOf(text.slice(comma + 1));
    if (!place) return true;
    this.#place = place;
    this.#shapes.act(place, secondsNow());
    this.#reshape();
    this.#draw();
    if (place.act === "click") this.#ring(place);
    return true;
  }

  place(picture: Picture | null, hidden: boolean): void {
    this.#picture = picture && picture.desktopWidth && picture.desktopHeight && picture.width && picture.height ? picture : null;
    this.#hidden = hidden;
    this.#draw();
  }

  #reshape(): void {
    if (this.#reshapes) clearTimeout(this.#reshapes);
    this.#reshapes = null;
    const now = secondsNow();
    const { shape, changesAt } = this.#shapes.now(now);
    this.#shape = shape;
    if (changesAt === null) return;
    this.#reshapes = setTimeout(() => {
      this.#reshape();
      this.#draw();
    }, (changesAt - now) * 1000);
  }

  #at(place: AgentPlace): { left: number; top: number } | null {
    const picture = this.#picture;
    if (!picture || this.#hidden) return null;
    return { left: picture.left + (place.x * picture.width) / picture.desktopWidth, top: picture.top + (place.y * picture.height) / picture.desktopHeight };
  }

  #draw(): void {
    const at = this.#place && this.#at(this.#place);
    if (!at) {
      if (this.#shown) this.#shown.style.display = "none";
      return;
    }
    if (!this.#shown) {
      this.#shown = document.createElement("div");
      this.#shown.dataset.testid = "agent-pointer";
      this.#shown.style.cssText = "position:absolute;width:0;height:0;pointer-events:none;z-index:2";
      this.#container.appendChild(this.#shown);
    }
    if (this.#shown.dataset.shape !== this.#shape) {
      this.#shown.dataset.shape = this.#shape;
      this.#shown.replaceChildren(cursor(this.#shape));
    }
    Object.assign(this.#shown.style, { display: "block", left: `${at.left}px`, top: `${at.top}px` });
  }

  #ring(place: AgentPlace): void {
    const at = this.#at(place);
    if (!at) return;
    const ring = document.createElement("div");
    ring.dataset.testid = "agent-ring";
    ring.style.cssText = `position:absolute;left:${at.left - RING_PX / 2}px;top:${at.top - RING_PX / 2}px;width:${RING_PX}px;height:${RING_PX}px;border:2px solid var(--primary);border-radius:9999px;pointer-events:none;z-index:1`;
    this.#container.appendChild(ring);
    if (!reducedMotion() && typeof ring.animate === "function") {
      ring.animate([{ transform: "scale(0.4)", opacity: 1 }, { transform: "scale(1.4)", opacity: 0 }], { duration: RING_MS, easing: "ease-out", fill: "forwards" });
    }
    setTimeout(() => ring.remove(), RING_MS);
  }
}
