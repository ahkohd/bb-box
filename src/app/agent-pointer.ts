import { AGENT_VERB, agentPlaceOf, type AgentPlace } from "../core/pointer.ts";
import { CURSOR_PARTS, type CursorInk } from "../core/record-cursor-paths.ts";
import type { Picture } from "./box-pointer.ts";

const SVG = "http://www.w3.org/2000/svg";
const ARROW_VIEW = 32;
const ARROW_HOTSPOT = 8.4;
const ARROW_PX = 40;
const ARROW_OFFSET_PX = -(ARROW_HOTSPOT * ARROW_PX) / ARROW_VIEW;
const RING_PX = 36;
const RING_MS = 600;
const INK_COLOURS: Readonly<Record<CursorInk, string>> = { ink: "var(--primary)", paper: "var(--primary-foreground)" };

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function arrow(): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", `0 0 ${ARROW_VIEW} ${ARROW_VIEW}`);
  svg.setAttribute("width", String(ARROW_PX));
  svg.setAttribute("height", String(ARROW_PX));
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = `position:absolute;left:${ARROW_OFFSET_PX}px;top:${ARROW_OFFSET_PX}px;overflow:visible`;
  const parts = CURSOR_PARTS.arrow;
  for (const part of [...parts.outlines, ...parts.fills]) {
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", part.d);
    path.setAttribute("fill", INK_COLOURS[part.ink]);
    path.setAttribute("fill-rule", "evenodd");
    svg.appendChild(path);
  }
  return svg;
}

export class AgentPointer {
  #place: AgentPlace | null = null;
  #shown: HTMLDivElement | null = null;
  #picture: Picture | null = null;
  #hidden = true;
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
    this.#draw();
    if (place.act === "click") this.#ring(place);
    return true;
  }

  place(picture: Picture | null, hidden: boolean): void {
    this.#picture = picture && picture.desktopWidth && picture.desktopHeight && picture.width && picture.height ? picture : null;
    this.#hidden = hidden;
    this.#draw();
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
      this.#shown.appendChild(arrow());
      this.#container.appendChild(this.#shown);
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
