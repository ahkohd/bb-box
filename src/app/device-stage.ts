import {
  applied,
  chain,
  cssMatrix,
  frameShape,
  inverse,
  moved,
  placement,
  scaled,
  screenOnStage,
  turnsBetween,
  videoToScreen,
  videoToStage,
  type FrameShape,
  type FrameView,
  type Placement,
  type Point2,
} from "../core/device-frame.ts";
import { clockwiseTurns, foldScreenFor, modelNamed, type DeviceModel, type DeviceState, type Orientation, type VideoSize } from "../core/device.ts";
import { arrangementFor, type Arrangement as BarArrangement } from "../core/device-toolbar.ts";

export interface DeviceView {
  readonly frame: boolean;
  readonly pixelForPixel: boolean;
}

export const DEFAULT_DEVICE_VIEW: DeviceView = { frame: true, pixelForPixel: false };

export const TURN_MS = 300;
export const FOLD_MS = 350;
export const FOLD_FADE_MS = 150;
export const STAGE_MARGIN_PX = 24;
export const LABEL_ROOM_PX = 28;
export const GENERATION_MASK = 0xffff;

export type DeviceStageAction = "wake" | "reboot";

export interface ToolbarRoom {
  readonly beside: number;
  readonly below: number;
}

interface FitRoom {
  readonly beside: number;
  readonly belowRoom: number;
}

export interface StageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DeviceLayout {
  readonly arrangement: BarArrangement;
  readonly device: StageRect;
  readonly under: number;
  readonly area: { readonly width: number; readonly height: number };
}

function sameLayoutOnStage(a: DeviceLayout | null, b: DeviceLayout): boolean {
  if (!a) return false;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return a.arrangement === b.arrangement && near(a.device.x, b.device.x) && near(a.device.y, b.device.y) && near(a.device.width, b.device.width) && near(a.device.height, b.device.height) && near(a.under, b.under) && a.area.width === b.area.width && a.area.height === b.area.height;
}

export interface DeviceStageTimes {
  readonly began: number;
  readonly turned: number | null;
  readonly pictured: number | null;
  readonly veiled: number | null;
}

interface Arrangement {
  readonly generation: number;
  readonly physical: Orientation;
  readonly content: Orientation;
  readonly video: VideoSize;
  readonly view: FrameView;
}

interface Pending {
  readonly generation: number | null;
  readonly canvas: HTMLCanvasElement;
}

interface Change {
  to: Arrangement;
  readonly began: number;
  animating: boolean;
  veiled: number | null;
  turned: number | null;
  timer: ReturnType<typeof setTimeout> | undefined;
}

const GRAPHITE = "#3b3b3e";
const GRAPHITE_DEEP = "#2a2a2c";
const GLASS = "#060607";
const SVG = "http://www.w3.org/2000/svg";
const STYLE_ID = "bb-box-device-stage-style";
const STAGE_CSS = `
.bb-device-body-art { filter: drop-shadow(0 0 1px rgba(0,0,0,0.35)) drop-shadow(0 10px 28px rgba(0,0,0,0.22)); }
.bb-device-edge { stroke: rgba(0,0,0,0); }
:where(.dark) .bb-device-body-art { filter: none; }
:where(.dark) .bb-device-edge { stroke: rgba(255,255,255,0.22); }
.bb-device-label { color: var(--muted-foreground, #8a8a8e); }
`;

function ensureStyle(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = STAGE_CSS;
  document.head.appendChild(style);
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number, fill: string): SVGRectElement {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  return svgElement("rect", { x, y, width, height, rx: r, ry: r, fill });
}

export function bodyArt(shape: FrameShape, scale: number): SVGSVGElement {
  const { body } = shape;
  const svg = svgElement("svg", { viewBox: `0 0 ${body.width} ${body.height}`, width: body.width * scale, height: body.height * scale, "aria-hidden": "true" });
  svg.setAttribute("class", "bb-device-body-art");
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible;pointer-events:none";
  for (const button of shape.buttons) svg.appendChild(roundedRect(button.x, button.y, button.width, button.height, Math.min(button.width, button.height) / 2, GRAPHITE_DEEP));
  if (shape.framed) {
    svg.appendChild(roundedRect(0, 0, body.width, body.height, body.radius, GRAPHITE));
    const edge = roundedRect(0.5, 0.5, body.width - 1, body.height - 1, body.radius, "none");
    edge.setAttribute("class", "bb-device-edge");
    edge.setAttribute("stroke-width", String(Math.max(1, 1 / scale)));
    edge.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(edge);
    svg.appendChild(roundedRect(shape.band, shape.band, body.width - shape.band * 2, body.height - shape.band * 2, body.radius - shape.band, GLASS));
  } else svg.appendChild(roundedRect(0, 0, body.width, body.height, body.radius, GLASS));
  return svg;
}

function px(value: number): string {
  return `${Math.round(value * 1000) / 1000}px`;
}

function creaseBackground(shape: FrameShape): string {
  const crease = shape.crease!;
  const along = crease.hinge === "vertical" ? shape.screen.width : shape.screen.height;
  const middle = (crease.at - (crease.hinge === "vertical" ? shape.screen.x : shape.screen.y)) / along;
  const spread = crease.shaded ? 0.12 : 0.012;
  const dark = crease.shaded ? 0.38 : 0.2;
  const side = crease.hinge === "vertical" ? "to right" : "to bottom";
  const at = (offset: number) => `${((middle + offset) * 100).toFixed(2)}%`;
  return `linear-gradient(${side}, transparent ${at(-spread)}, rgba(0,0,0,${dark}) ${at(0)}, rgba(255,255,255,${crease.shaded ? 0.05 : 0.08}) ${at(spread / 4)}, transparent ${at(spread)})`;
}

function powerWords(state: DeviceState | null, connected: boolean): { readonly words: string; readonly action: DeviceStageAction | null; readonly dark: boolean } | null {
  const power = state?.power;
  if (!power) return connected ? null : { words: "Connecting", action: null, dark: true };
  if (power.is === "booting") return { words: "Booting", action: null, dark: true };
  if (power.is === "switching") return { words: `Switching to the ${power.to}`, action: null, dark: true };
  if (power.is === "stopped") return { words: "Stopped", action: null, dark: true };
  if (power.is === "failed") return { words: power.error.words, action: "reboot", dark: true };
  if (!power.awake) return { words: "Asleep", action: "wake", dark: false };
  return null;
}

const ACTION_WORDS: Readonly<Record<DeviceStageAction, string>> = { wake: "Wake", reboot: "Reboot device" };

function arrangementOf(state: DeviceState): Arrangement | null {
  const geometry = state.geometry;
  if (!geometry) return null;
  const view: FrameView =
    state.platform === "android" && state.form === "foldable"
      ? { screen: state.geometry!.screen, posture: state.posture.known ? state.posture.value : state.geometry!.screen === "outer" ? "closed" : "open" }
      : null;
  return { generation: geometry.generation, physical: geometry.physical, content: geometry.content, video: geometry.video, view };
}

function sameLayout(a: Arrangement, b: Arrangement): boolean {
  return a.physical === b.physical && a.content === b.content && a.video.width === b.video.width && a.video.height === b.video.height && a.view?.screen === b.view?.screen && a.view?.posture === b.view?.posture;
}

export class DeviceStage {
  readonly element = document.createElement("div");
  readonly #content = document.createElement("div");
  readonly #device = document.createElement("div");
  readonly #screen = document.createElement("div");
  readonly #crease = document.createElement("div");
  readonly #veil = document.createElement("div");
  readonly #cutout = document.createElement("div");
  readonly #label = document.createElement("div");
  readonly #words = document.createElement("div");
  readonly #canvas: HTMLCanvasElement;
  readonly #observer: ResizeObserver | null;
  #art: SVGSVGElement | null = null;
  #model: DeviceModel | null = null;
  #state: DeviceState | null = null;
  #shown: Arrangement | null = null;
  #change: Change | null = null;
  #pending: Pending | null = null;
  #view: DeviceView = DEFAULT_DEVICE_VIEW;
  #turns = 0;
  #shape: FrameShape | null = null;
  #place: Placement | null = null;
  #connected = false;
  #fold: HTMLElement | null = null;
  #blank = false;
  #motionEnds = 0;
  #disposed = false;
  #times: DeviceStageTimes | null = null;
  #toolbar: ToolbarRoom | null = null;
  #reported: DeviceLayout | null = null;
  #onLayout: ((layout: DeviceLayout | null) => void) | undefined;
  onAction?: (action: DeviceStageAction) => void;
  onChange?: () => void;

  constructor(canvas: HTMLCanvasElement, model: string | null) {
    ensureStyle();
    this.#canvas = canvas;
    this.element.className = "bb-device-stage";
    this.element.style.cssText = "position:absolute;inset:0;overflow:hidden";
    this.#content.style.cssText = "position:relative;min-width:100%;min-height:100%";
    this.#device.style.cssText = "position:absolute;left:0;top:0;transform-origin:50% 50%";
    this.#screen.style.cssText = "position:absolute;overflow:hidden;background:#000;isolation:isolate";
    this.#crease.style.cssText = "position:absolute;inset:0;pointer-events:none";
    this.#veil.style.cssText = "position:absolute;inset:0;pointer-events:none;background:rgba(0,0,0,0.38);opacity:0;transition:opacity 160ms ease-out";
    this.#cutout.style.cssText = "position:absolute;background:#000;pointer-events:none";
    this.#label.className = "bb-device-label";
    this.#label.style.cssText = "position:absolute;left:0;right:0;text-align:center;font-size:12px;pointer-events:none";
    this.#words.style.cssText = "position:absolute;display:none;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:#f2f2f4;font-size:13px;line-height:1.35;padding:16px;box-sizing:border-box";
    this.#words.setAttribute("role", "status");
    canvas.style.cssText = "position:absolute;left:0;top:0;transform-origin:0 0;outline:none;display:block";
    this.#screen.append(canvas, this.#crease, this.#veil);
    this.#device.append(this.#screen, this.#cutout);
    this.#content.append(this.#device, this.#label, this.#words);
    this.element.appendChild(this.#content);
    this.#model = model ? modelNamed(model) : null;
    this.#observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.#layout());
    this.#observer?.observe(this.element);
    this.element.addEventListener("scroll", () => this.#report(), { passive: true });
    this.#layout();
  }

  get layout(): DeviceLayout | null {
    return this.#reported;
  }

  set onLayout(listener: ((layout: DeviceLayout | null) => void) | undefined) {
    this.#onLayout = listener;
    listener?.(this.#reported);
  }

  setToolbar(room: ToolbarRoom | null): void {
    if (room?.beside === this.#toolbar?.beside && room?.below === this.#toolbar?.below) return;
    this.#toolbar = room;
    this.#layout();
  }

  get view(): DeviceView {
    return this.#view;
  }

  get times(): DeviceStageTimes | null {
    return this.#times;
  }

  get shownGeneration(): number | null {
    return this.#shown?.generation ?? null;
  }

  get holding(): boolean {
    return this.#change !== null;
  }

  setView(view: DeviceView): void {
    if (view.frame === this.#view.frame && view.pixelForPixel === this.#view.pixelForPixel) return;
    this.#view = view;
    this.#layout();
  }

  setModel(name: string | null): void {
    const model = name ? modelNamed(name) : null;
    if (this.#state || !model || model.name === this.#model?.name) return;
    this.#model = model;
    this.#drawWords();
    this.#layout();
  }

  setConnected(connected: boolean): void {
    if (connected === this.#connected) return;
    this.#connected = connected;
    this.#drawWords();
  }

  setState(state: DeviceState): void {
    const model = modelNamed(state.model);
    if (model && model.name !== this.#model?.name) {
      this.#model = model;
      this.#shown = null;
      this.#endChange();
    }
    this.#state = state;
    const target = arrangementOf(state);
    if (target) this.#towards(target);
    this.#drawWords();
    this.#layout();
  }

  #towards(target: Arrangement): void {
    const shown = this.#shown;
    if (!shown) {
      this.#shown = target;
      this.#turns = clockwiseTurns(target.physical);
      return;
    }
    const change = this.#change;
    const from = change?.to ?? shown;
    if (from.generation === target.generation) {
      if (from.physical !== target.physical) {
        this.#turns += turnsBetween(from.physical, target.physical);
        this.#applyTurn(!reducedMotion());
      }
      if (change) change.to = target;
      else this.#shown = target;
      return;
    }
    const turning = from.physical !== target.physical;
    const folding = from.view?.screen !== target.view?.screen;
    const animated = (turning || folding) && !reducedMotion();
    const now = performance.now();
    const moving = Math.max(0, this.#motionEnds - now);
    const previousTimes = this.#times;
    this.#endChange(moving > 0);
    if (!turning && !folding && !moving && sameLayout(shown, target)) {
      this.#shown = target;
      return;
    }
    const lasts = animated ? (folding ? FOLD_MS + FOLD_FADE_MS : TURN_MS) : 0;
    if (animated) this.#motionEnds = now + lasts;
    const next: Change = { to: target, began: now, animating: animated || moving > 0, veiled: null, turned: null, timer: undefined };
    this.#change = next;
    this.#times = moving > 0 && previousTimes ? { ...previousTimes, pictured: null, veiled: null } : { began: now, turned: null, pictured: null, veiled: null };
    if (turning) this.#turns += turnsBetween(from.physical, target.physical);
    if (folding && animated) this.#foldTowards(target);
    else if (turning) this.#applyTurn(animated);
    next.timer = setTimeout(() => this.#waited(next), next.animating ? Math.max(lasts, moving) : TURN_MS);
    if (!next.animating) this.#showPendingFor(next);
  }

  #applyTurn(animated: boolean): void {
    this.#device.style.transition = animated ? `transform ${TURN_MS}ms cubic-bezier(0.22, 0.8, 0.24, 1)` : "none";
    this.#placeDevice();
  }

  #waited(change: Change): void {
    if (this.#change !== change) return;
    change.animating = false;
    change.turned = performance.now();
    this.#times = { ...this.#times!, turned: this.#times?.turned ?? change.turned };
    this.#device.style.transition = "none";
    if (this.#showPendingFor(change)) return;
    change.veiled = performance.now();
    this.#times = { ...this.#times!, veiled: change.veiled };
    this.#veil.style.opacity = "1";
  }

  #showPendingFor(change: Change): boolean {
    const pending = this.#pending;
    if (!pending || !this.#isFor(pending.generation, change.to, pending.canvas)) return false;
    this.#show(change.to, pending.canvas, pending.canvas.width, pending.canvas.height);
    return true;
  }

  #settle(change: Change): void {
    if (this.#change !== change) return;
    clearTimeout(change.timer);
    this.#change = null;
    this.#shown = change.to;
    this.#blank = false;
    this.#veil.style.opacity = "0";
    this.#removeFold();
  }

  #endChange(stillMoving = false): void {
    const change = this.#change;
    if (!change) return;
    clearTimeout(change.timer);
    this.#change = null;
    this.#veil.style.opacity = "0";
    if (stillMoving) return;
    this.#device.style.transition = "none";
    this.#blank = false;
    this.#removeFold();
  }

  #isFor(generation: number | null, target: Arrangement, size?: VideoSize): boolean {
    if (generation !== null) return generation === (target.generation & GENERATION_MASK);
    return !!size && size.width === target.video.width && size.height === target.video.height;
  }

  paint(picture: CanvasImageSource, width: number, height: number, generation: number | null): boolean {
    if (this.#disposed) return false;
    const change = this.#change;
    const size = { width, height };
    if (change) {
      if (this.#isFor(generation, change.to, size) || (generation !== null && this.#newer(generation, change.to.generation))) {
        if (change.animating || !this.#isFor(generation, change.to, size)) {
          this.#stash(picture, width, height, generation);
          return false;
        }
        this.#show(change.to, picture, width, height);
        return true;
      }
      return false;
    }
    const shown = this.#shown;
    if (shown && generation !== null && generation !== (shown.generation & GENERATION_MASK)) {
      if (this.#newer(generation, shown.generation)) this.#stash(picture, width, height, generation);
      return false;
    }
    if (!shown || shown.video.width !== width || shown.video.height !== height) {
      this.#shown = { generation: shown?.generation ?? 0, physical: shown?.physical ?? "upright", content: shown?.content ?? "upright", video: size, view: shown?.view ?? null };
      this.#layout();
    }
    this.#draw(picture, width, height);
    return true;
  }

  #newer(generation: number, than: number): boolean {
    const ahead = (generation - (than & GENERATION_MASK) + 0x10000) & GENERATION_MASK;
    return ahead > 0 && ahead < 0x8000;
  }

  #stash(picture: CanvasImageSource, width: number, height: number, generation: number | null): void {
    const canvas = this.#pending?.canvas ?? document.createElement("canvas");
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvas.getContext("2d")?.drawImage(picture, 0, 0);
    this.#pending = { generation, canvas };
  }

  #show(target: Arrangement, picture: CanvasImageSource, width: number, height: number): void {
    const change = this.#change;
    this.#shown = { ...target, video: { width, height } };
    if (change) {
      this.#times = { ...this.#times!, pictured: performance.now() };
      this.#settle(change);
    }
    this.#pending = null;
    this.#layout();
    this.#draw(picture, width, height);
    this.onChange?.();
  }

  #draw(picture: CanvasImageSource, width: number, height: number): void {
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
      this.#placeCanvas();
    }
    this.#canvas.getContext("2d")?.drawImage(picture, 0, 0);
  }

  #layout(): void {
    if (this.#disposed) return;
    const model = this.#model;
    const shown = this.#shown;
    const area = { width: this.element.clientWidth, height: this.element.clientHeight };
    if (!model || !area.width || !area.height) {
      this.#shape = null;
      this.#place = null;
      this.#arranged = null;
      this.#drawWords();
      this.#report();
      return;
    }
    const view = shown?.view ?? (model.form === "foldable" ? { screen: foldScreenFor("open"), posture: "open" as const } : null);
    const shape = frameShape(model, view, this.#view.frame);
    const physical = this.#change?.to.physical ?? shown?.physical ?? "upright";
    const label = view?.posture === "half-open";
    const room = this.#toolbar;
    const besideFit = this.#fit(shape, physical, label, room ? { beside: room.beside, belowRoom: 0 } : undefined);
    const belowFit = room ? this.#fit(shape, physical, label, { beside: 0, belowRoom: room.below }) : besideFit;
    const arrangement = room ? arrangementFor(area.width, screenOnStage(shape, physical, besideFit).width, screenOnStage(shape, physical, belowFit).width) : null;
    const place = arrangement === "below" ? belowFit : besideFit;
    const rebuilt = this.#shape === null || this.#shape.body.width !== shape.body.width || this.#shape.body.height !== shape.body.height || this.#shape.framed !== shape.framed || this.#place?.scale !== place.scale || this.#shape.crease?.shaded !== shape.crease?.shaded;
    this.#shape = shape;
    this.#place = place;
    this.element.style.overflow = this.#view.pixelForPixel ? "auto" : "hidden";
    this.#content.style.width = px(place.content.width);
    this.#content.style.height = px(place.content.height);
    if (rebuilt) this.#rebuild(shape, place);
    this.#placeDevice();
    this.#placeCanvas();
    this.#label.textContent = label ? "Half open" : "";
    this.#label.style.top = px(place.centre.y + this.#rotatedHeight(shape, physical) * place.scale / 2 + 8);
    this.#drawWords();
    this.#arranged = arrangement ? { arrangement, shape, physical, place, label } : null;
    this.#report();
  }

  #arranged: { readonly arrangement: BarArrangement; readonly shape: FrameShape; readonly physical: Orientation; readonly place: Placement; readonly label: boolean } | null = null;

  #report(): void {
    const arranged = this.#arranged;
    if (!arranged) {
      if (this.#reported) {
        this.#reported = null;
        this.#onLayout?.(null);
      }
      return;
    }
    const { shape, physical, place } = arranged;
    const sideways = clockwiseTurns(physical) % 2 === 1;
    const width = (sideways ? shape.body.height : shape.body.width) * place.scale;
    const height = (sideways ? shape.body.width : shape.body.height) * place.scale;
    const left = place.centre.x - width / 2 - this.element.scrollLeft;
    const top = place.centre.y - height / 2 - this.element.scrollTop;
    const layout: DeviceLayout = {
      arrangement: arranged.arrangement,
      device: { x: left, y: top, width, height },
      under: top + height + (arranged.label ? LABEL_ROOM_PX : 0),
      area: { width: this.element.clientWidth, height: this.element.clientHeight },
    };
    if (sameLayoutOnStage(this.#reported, layout)) return;
    this.#reported = layout;
    this.#onLayout?.(layout);
  }

  #roomNow(): FitRoom {
    const room = this.#toolbar;
    if (!room || !this.#arranged) return { beside: 0, belowRoom: 0 };
    return this.#arranged.arrangement === "beside" ? { beside: room.beside, belowRoom: 0 } : { beside: 0, belowRoom: room.below };
  }

  #fit(shape: FrameShape, physical: Orientation, label: boolean, room: FitRoom = { beside: 0, belowRoom: 0 }): Placement {
    const area = { width: this.element.clientWidth, height: this.element.clientHeight };
    return placement(shape, physical, { area, margin: this.#view.frame ? STAGE_MARGIN_PX : 8, below: (label ? LABEL_ROOM_PX : 0) + room.belowRoom, beside: room.beside, pixelRatio: window.devicePixelRatio || 1, pixelForPixel: this.#view.pixelForPixel });
  }

  #rotatedHeight(shape: FrameShape, physical: Orientation): number {
    return clockwiseTurns(physical) % 2 ? shape.body.width : shape.body.height;
  }

  #rebuild(shape: FrameShape, place: Placement): void {
    const s = place.scale;
    this.#art?.remove();
    this.#art = bodyArt(shape, s);
    this.#device.prepend(this.#art);
    this.#device.style.width = px(shape.body.width * s);
    this.#device.style.height = px(shape.body.height * s);
    Object.assign(this.#screen.style, { left: px(shape.screen.x * s), top: px(shape.screen.y * s), width: px(shape.screen.width * s), height: px(shape.screen.height * s), borderRadius: px(shape.screen.radius * s) });
    const cutout = shape.cutout;
    this.#cutout.style.display = cutout ? "block" : "none";
    if (cutout) Object.assign(this.#cutout.style, { left: px(cutout.x * s), top: px(cutout.y * s), width: px(cutout.width * s), height: px(cutout.height * s), borderRadius: px((cutout.shape === "pill" ? cutout.height / 2 : cutout.width / 2) * s) });
    this.#crease.style.background = shape.crease ? creaseBackground(shape) : "none";
  }

  #placeDevice(): void {
    const shape = this.#shape;
    const place = this.#place;
    if (!shape || !place) return;
    const left = place.centre.x - (shape.body.width * place.scale) / 2;
    const top = place.centre.y - (shape.body.height * place.scale) / 2;
    this.#device.style.left = px(left);
    this.#device.style.top = px(top);
    this.#device.style.transform = `rotate(${this.#turns * 90}deg)`;
  }

  #placeCanvas(): void {
    const shape = this.#shape;
    const place = this.#place;
    const shown = this.#shown;
    if (!shape || !place) return;
    const video = { width: this.#canvas.width || shape.pixels.width, height: this.#canvas.height || shape.pixels.height };
    const content = shown && shown.video.width === video.width && shown.video.height === video.height ? shown.content : "upright";
    const toScreen = chain(videoToScreen(shape, content, video), moved(-shape.screen.x, -shape.screen.y), scaled(place.scale));
    this.#canvas.style.width = px(video.width);
    this.#canvas.style.height = px(video.height);
    this.#canvas.style.transform = cssMatrix(toScreen);
  }

  #drawWords(): void {
    const said = powerWords(this.#state, this.#connected);
    const shape = this.#shape;
    const place = this.#place;
    this.#screen.style.background = "#000";
    this.#canvas.style.visibility = said?.dark || this.#blank ? "hidden" : "visible";
    if (said && !said.dark) this.#veil.style.opacity = "1";
    else if (!this.#change) this.#veil.style.opacity = "0";
    if (!said) {
      this.#words.style.display = "none";
      return;
    }
    const physical = this.#change?.to.physical ?? this.#shown?.physical ?? "upright";
    const rect = shape && place ? screenOnStage(shape, physical, place) : null;
    Object.assign(this.#words.style, rect ? { display: "flex", left: px(rect.x), top: px(rect.y), width: px(rect.width), height: px(rect.height) } : { display: "flex", left: "0", top: "0", width: "100%", height: "100%" });
    this.#words.replaceChildren();
    if (said.dark && this.#model) {
      const name = document.createElement("div");
      name.style.cssText = "font-size:15px;font-weight:600";
      name.textContent = this.#model.name;
      this.#words.appendChild(name);
    }
    const words = document.createElement("div");
    words.style.cssText = said.dark ? "color:#b9b9be" : "font-size:15px;font-weight:600";
    words.textContent = said.words;
    this.#words.appendChild(words);
    if (said.action) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = ACTION_WORDS[said.action];
      button.style.cssText = "margin-top:4px;padding:6px 14px;border-radius:999px;border:1px solid rgba(255,255,255,0.45);background:rgba(255,255,255,0.12);color:#fff;font:inherit;cursor:pointer";
      const action = said.action;
      button.addEventListener("click", () => this.onAction?.(action));
      this.#words.appendChild(button);
    }
  }

  toVideo(clientX: number, clientY: number): Point2 | null {
    if (!this.#shape) this.#layout();
    const shape = this.#shape;
    const place = this.#place;
    const shown = this.#shown;
    if (!shape || !place || !shown || !this.#canvas.width || this.#change) return null;
    const rect = this.#content.getBoundingClientRect();
    const video = { width: this.#canvas.width, height: this.#canvas.height };
    const content = shown.video.width === video.width && shown.video.height === video.height ? shown.content : "upright";
    const point = applied(inverse(videoToStage(shape, shown.physical, content, video, place)), { x: clientX - rect.left, y: clientY - rect.top });
    if (point.x < 0 || point.y < 0 || point.x >= video.width || point.y >= video.height) return null;
    return { x: Math.floor(point.x), y: Math.floor(point.y) };
  }

  toElement(point: Point2): Point2 | null {
    if (!this.#shape) this.#layout();
    const shape = this.#shape;
    const place = this.#place;
    const shown = this.#shown;
    if (!shape || !place || !shown) return null;
    const onStage = applied(videoToStage(shape, shown.physical, shown.content, shown.video, place), point);
    const content = this.#content.getBoundingClientRect();
    const element = this.element.getBoundingClientRect();
    return { x: onStage.x + content.left - element.left, y: onStage.y + content.top - element.top };
  }

  #foldTowards(target: Arrangement): void {
    const model = this.#model;
    const shape = this.#shape;
    const place = this.#place;
    if (!model || model.form !== "foldable" || !shape || !place) return;
    this.#removeFold();
    const folding = target.view?.screen === "outer";
    const inner = frameShape(model, { screen: "inner", posture: "open" }, this.#view.frame);
    const innerPlace = folding ? place : this.#fit(inner, target.physical, target.view?.posture === "half-open", this.#roomNow());
    const s = innerPlace.scale;
    const half = inner.body.width / 2;
    const overlay = document.createElement("div");
    overlay.style.cssText = `position:absolute;perspective:${px(inner.body.width * s * 2.5)};pointer-events:none`;
    Object.assign(overlay.style, {
      left: px(innerPlace.centre.x - (inner.body.width * s) / 2),
      top: px(innerPlace.centre.y - (inner.body.height * s) / 2),
      width: px(inner.body.width * s),
      height: px(inner.body.height * s),
      transform: `rotate(${this.#turns * 90}deg)`,
    });
    const picture = folding ? this.#canvas : null;
    const leftHalf = this.#halfOf(inner, s, picture, 0, half);
    const flap = document.createElement("div");
    flap.style.cssText = `position:absolute;top:0;left:${px(half * s)};width:${px(half * s)};height:100%;transform-origin:0 50%;transform-style:preserve-3d;transition:transform ${FOLD_MS}ms cubic-bezier(0.45, 0, 0.25, 1)`;
    const front = this.#halfOf(inner, s, picture, half, half);
    front.style.left = "0";
    front.style.backfaceVisibility = "hidden";
    const back = document.createElement("div");
    back.style.cssText = `position:absolute;inset:0;background:${GRAPHITE};border-radius:0 ${px(inner.body.radius * s)} ${px(inner.body.radius * s)} 0;transform:rotateY(180deg);backface-visibility:hidden`;
    flap.append(front, back);
    overlay.append(leftHalf, flap);
    this.#content.appendChild(overlay);
    this.#fold = overlay;
    const open = "rotateY(0deg)";
    const shut = "rotateY(-180deg)";
    flap.style.transform = folding ? open : shut;
    this.#device.style.transition = `opacity ${FOLD_FADE_MS}ms ease-out`;
    if (folding) {
      this.#device.style.opacity = "0";
      requestAnimationFrame(() => requestAnimationFrame(() => (flap.style.transform = shut)));
      setTimeout(() => {
        if (this.#fold !== overlay) return;
        this.#layoutFor(target);
        this.#device.style.opacity = "1";
        overlay.style.transition = `opacity ${FOLD_FADE_MS}ms ease-out`;
        overlay.style.opacity = "0";
      }, FOLD_MS);
      return;
    }
    overlay.style.opacity = "0";
    overlay.style.transition = `opacity ${FOLD_FADE_MS}ms ease-out`;
    requestAnimationFrame(() => {
      overlay.style.opacity = "1";
      this.#device.style.opacity = "0";
    });
    setTimeout(() => {
      if (this.#fold !== overlay) return;
      flap.style.transform = open;
      setTimeout(() => {
        if (this.#fold !== overlay) return;
        this.#layoutFor(target);
        this.#device.style.transition = "none";
        this.#device.style.opacity = "1";
        overlay.remove();
      }, FOLD_MS);
    }, FOLD_FADE_MS);
  }

  #layoutFor(target: Arrangement): void {
    const shown = this.#shown;
    if (!shown) return;
    this.#shown = { ...shown, view: target.view, physical: target.physical };
    this.#blank = true;
    this.#layout();
  }

  #halfOf(shape: FrameShape, scale: number, picture: HTMLCanvasElement | null, from: number, width: number): HTMLElement {
    const half = document.createElement("div");
    half.style.cssText = `position:absolute;top:0;left:${px(from * scale)};width:${px(width * scale)};height:${px(shape.body.height * scale)};overflow:hidden`;
    const whole = document.createElement("div");
    whole.style.cssText = `position:absolute;top:0;left:${px(-from * scale)};width:${px(shape.body.width * scale)};height:${px(shape.body.height * scale)}`;
    whole.appendChild(bodyArt(shape, scale));
    const screen = document.createElement("div");
    screen.style.cssText = `position:absolute;overflow:hidden;background:#000;left:${px(shape.screen.x * scale)};top:${px(shape.screen.y * scale)};width:${px(shape.screen.width * scale)};height:${px(shape.screen.height * scale)};border-radius:${px(shape.screen.radius * scale)}`;
    if (picture && picture.width) {
      const copy = document.createElement("canvas");
      copy.width = picture.width;
      copy.height = picture.height;
      copy.getContext("2d")?.drawImage(picture, 0, 0);
      copy.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%`;
      screen.appendChild(copy);
    }
    whole.appendChild(screen);
    half.appendChild(whole);
    return half;
  }

  #removeFold(): void {
    this.#fold?.remove();
    this.#fold = null;
    this.#device.style.opacity = "1";
  }

  dispose(): void {
    this.#disposed = true;
    this.#endChange();
    this.#observer?.disconnect();
    this.element.remove();
  }
}
