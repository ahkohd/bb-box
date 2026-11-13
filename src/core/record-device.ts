import { clockwiseTurns, deviceModel, foldScreenFor, isSideways, type QuarterTurns } from "./device.ts";
import { applied, bodyToStage, frameShape, outerBounds, screenOnStage, videoToStage, type Affine, type FrameShape, type Placement, type Point2, type Rect } from "./device-frame.ts";
import { RECORD_DIR, lastAt, segmentFile, type CaptionPosition, type RecordingLog } from "./device-recording.ts";
import { useClipFfmpeg, type ClipFfmpegPair } from "./record-ffmpeg.ts";
import { RECORD_FPS, RECORD_STOP_EXITS, type ClipLayout, type ClipNote, type Prepared, type RecordEvent } from "./record.ts";

export const DEVICE_CLIP_WIDTH = { least: 1080, most: 1280 } as const;
export const DEVICE_CLIP_HEIGHT_MOST = 1600;
export const DEVICE_CLIP_FONT = 18;
export const DEVICE_CLIP_MARGIN = 24;
export const DEVICE_CLIP_BACKGROUND = "0x161618";
export const TOUCH_SHOWN_AFTER_S = 0.3;
export const TOUCH_INTERVALS_MOST = 3000;
export const DEVICE_COMPOSE_EXITS = { composed: 0, none: 3, noRecorder: 4, failed: 6 } as const;

const FREEZE = "freezedetect=n=0.0001:d=1";
const GRAPHITE = "3b3b3e";
const GRAPHITE_DEEP = "2a2a2c";
const GLASS = "060607";
const FRAME_INTERVAL_S = 1 / RECORD_FPS;

export interface Rounded {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

export interface FrameArt {
  readonly width: number;
  readonly height: number;
  readonly turns: QuarterTurns;
  readonly x: number;
  readonly y: number;
  readonly buttons: readonly Rounded[];
  readonly body: Rounded;
  readonly glass: Rounded;
  readonly hole: Rounded;
  readonly cutout: Rounded | null;
  readonly crease: { readonly at: number; readonly spread: number; readonly dark: number } | null;
}

export interface ComposedSegment {
  readonly n: number;
  readonly file: string;
  readonly from: number;
  readonly to: number;
  readonly artFrom: number;
  readonly turns: QuarterTurns;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly art: FrameArt;
}

export interface TouchInterval {
  readonly from: number;
  readonly to: number;
  readonly x: number;
  readonly y: number;
}

export interface DeviceComposition {
  readonly width: number;
  readonly height: number;
  readonly length: number;
  readonly position: CaptionPosition;
  readonly layout: ClipLayout;
  readonly segments: readonly ComposedSegment[];
  readonly touches: readonly (readonly TouchInterval[])[];
  readonly circle: number;
  readonly events: readonly RecordEvent[];
  readonly notes: readonly ClipNote[];
  readonly ended: "stopped" | "limit" | "box-stopped";
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
const round2 = (value: number) => Math.round(value * 100) / 100;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function bandHeight(fontSize: number): number {
  const pill = Math.round(fontSize * 2.1);
  const gap = Math.max(4, Math.round(fontSize * 0.3));
  return Math.round(fontSize * 0.8) * 2 + pill * 2 + gap;
}

function turnsOf(m: Affine): QuarterTurns {
  if (m.a > 0.0001) return 0;
  if (m.b > 0.0001) return 1;
  if (m.a < -0.0001) return 2;
  return 3;
}

function turnedBounds(shape: FrameShape, sideways: boolean): { readonly width: number; readonly height: number } {
  const bounds = outerBounds(shape);
  return sideways ? { width: bounds.height, height: bounds.width } : { width: bounds.width, height: bounds.height };
}

function viewOf(model: ReturnType<typeof deviceModel>, geometry: { readonly screen?: "outer" | "inner"; readonly posture?: "closed" | "half-open" | "open" }) {
  if (model.form !== "foldable") return null;
  const posture = geometry.posture ?? (geometry.screen === "outer" ? "closed" : "open");
  return { screen: geometry.screen ?? foldScreenFor(posture), posture };
}

function artOf(shape: FrameShape, turns: QuarterTurns, place: Placement): FrameArt {
  const s = place.scale;
  const bounds = outerBounds(shape);
  const local = (x: number, y: number, width: number, height: number, radius: number): Rounded => ({
    x: round2((x - bounds.x) * s),
    y: round2((y - bounds.y) * s),
    width: round2(width * s),
    height: round2(height * s),
    radius: round2(Math.max(0, Math.min(radius * s, (width * s) / 2, (height * s) / 2))),
  });
  const toStage = bodyToStage(shape, turns, place);
  const corners = [applied(toStage, { x: bounds.x, y: bounds.y }), applied(toStage, { x: bounds.x + bounds.width, y: bounds.y + bounds.height })];
  const screen = shape.screen;
  const inset = 1 / s;
  const crease = shape.crease;
  return {
    width: Math.ceil(bounds.width * s),
    height: Math.ceil(bounds.height * s),
    turns,
    x: Math.round(Math.min(corners[0]!.x, corners[1]!.x)),
    y: Math.round(Math.min(corners[0]!.y, corners[1]!.y)),
    buttons: shape.buttons.map((button) => local(button.x, button.y, button.width, button.height, Math.min(button.width, button.height) / 2)),
    body: local(0, 0, shape.body.width, shape.body.height, shape.body.radius),
    glass: local(shape.band, shape.band, shape.body.width - shape.band * 2, shape.body.height - shape.band * 2, shape.body.radius - shape.band),
    hole: local(screen.x + inset, screen.y + inset, screen.width - inset * 2, screen.height - inset * 2, screen.radius),
    cutout: shape.cutout ? local(shape.cutout.x, shape.cutout.y, shape.cutout.width, shape.cutout.height, shape.cutout.shape === "pill" ? shape.cutout.height / 2 : shape.cutout.width / 2) : null,
    crease: crease && crease.hinge === "vertical" ? { at: round2((crease.at - bounds.x) * s), spread: round2(screen.width * s * (crease.shaded ? 0.12 : 0.012)), dark: crease.shaded ? 0.38 : 0.2 } : null,
  };
}

export function planDeviceClip(log: RecordingLog): DeviceComposition | string {
  if (!log.start) return "The recording's log has no start.";
  const position = log.start.position;
  const length = round3((log.end?.at ?? lastAt(log)) / 1000);
  const segments = log.entries.flatMap((entry) => (entry.type === "segment" ? [entry] : []));
  if (!segments.length || length <= 0) return "No picture came from the device while it recorded.";
  const shaped = segments.map((segment) => {
    const model = deviceModel(segment.model);
    const shape = frameShape(model, viewOf(model, segment.geometry), true);
    return { segment, shape, turned: turnedBounds(shape, isSideways(segment.geometry.physical)) };
  });
  const widest = Math.max(...shaped.map((each) => each.turned.width));
  const tallest = Math.max(...shaped.map((each) => each.turned.height));
  const band = bandHeight(DEVICE_CLIP_FONT);
  const margin = DEVICE_CLIP_MARGIN;
  const scale = Math.min(1, (DEVICE_CLIP_WIDTH.most - margin * 2) / widest, (DEVICE_CLIP_HEIGHT_MOST - band - margin * 2) / tallest);
  const width = even(Math.min(DEVICE_CLIP_WIDTH.most, Math.max(DEVICE_CLIP_WIDTH.least, widest * scale + margin * 2)));
  const height = even(tallest * scale + margin * 2 + band);
  const areaTop = position === "top" ? band : 0;
  const centre: Point2 = { x: width / 2, y: areaTop + (height - band) / 2 };
  const place: Placement = { scale, content: { width, height }, centre };
  const transforms = new Map<number, Affine>();
  const composed = shaped.flatMap(({ segment, shape }, index): ComposedSegment[] => {
    const from = round3(segment.at / 1000);
    const to = round3(index + 1 < shaped.length ? shaped[index + 1]!.segment.at / 1000 : length);
    if (to <= from) return [];
    const { physical, content, video } = segment.geometry;
    const toStage = videoToStage(shape, physical, content, video, place);
    transforms.set(segment.n, toStage);
    const screen: Rect = screenOnStage(shape, physical, place);
    return [
      {
        n: segment.n,
        file: segmentFile(segment.n),
        from,
        to,
        artFrom: index === 0 ? 0 : from,
        turns: turnsOf(toStage),
        width: even(screen.width),
        height: even(screen.height),
        x: Math.round(screen.x),
        y: Math.round(screen.y),
        art: artOf(shape, clockwiseTurns(physical), place),
      },
    ];
  });
  if (!composed.length) return "No picture came from the device while it recorded.";
  const first = composed[0]!;
  const circle = Math.max(24, Math.round(Math.min(first.width, first.height) * 0.11 / 2) * 2);
  const events = log.entries.flatMap((entry): RecordEvent[] => (entry.type === "caption" ? [{ at: entry.at / 1000, kind: entry.kind, text: entry.text }] : []));
  const notes = log.entries.flatMap((entry): ClipNote[] => (entry.type === "lost" ? [{ at: entry.at / 1000, text: entry.words }] : []));
  return {
    width,
    height,
    length,
    position,
    layout: { fontSize: DEVICE_CLIP_FONT, band: { y: position === "top" ? 0 : height - band, height: band } },
    segments: composed,
    touches: touchTracks(log, transforms, length),
    circle,
    events,
    notes,
    ended: log.end?.ended ?? "stopped",
  };
}

export function touchTracks(log: RecordingLog, transforms: ReadonlyMap<number, Affine>, length: number): readonly (readonly TouchInterval[])[] {
  const slots: TouchInterval[][] = [[], []];
  const open: ({ from: number; x: number; y: number } | null)[] = [null, null];
  const close = (slot: number, at: number, after: number) => {
    const held = open[slot];
    if (!held) return;
    open[slot] = null;
    const to = Math.min(length, at + after);
    if (to <= held.from) return;
    const intervals = slots[slot]!;
    const last = intervals.at(-1);
    if (last && last.to > held.from) intervals[intervals.length - 1] = { ...last, to: round3(held.from) };
    if (intervals.at(-1)?.to === intervals.at(-1)?.from) intervals.pop();
    intervals.push({ from: round3(held.from), to: round3(to), x: Math.round(held.x), y: Math.round(held.y) });
  };
  for (const entry of log.entries) {
    if (entry.type !== "touch") continue;
    const at = entry.at / 1000;
    const transform = transforms.get(entry.n);
    for (let slot = 0; slot < 2; slot++) {
      const contact = entry.contacts[slot];
      if (!contact || !transform) {
        close(slot, at, TOUCH_SHOWN_AFTER_S);
        continue;
      }
      const point = applied(transform, contact);
      const held = open[slot];
      if (held && at - held.from < FRAME_INTERVAL_S) {
        open[slot] = { from: held.from, x: point.x, y: point.y };
        continue;
      }
      close(slot, at, 0);
      open[slot] = { from: at, x: point.x, y: point.y };
    }
  }
  for (let slot = 0; slot < 2; slot++) close(slot, length, 0);
  return slots.map((slot) => slot.slice(0, TOUCH_INTERVALS_MOST));
}

function covered(shape: Rounded): string {
  const r = shape.radius;
  const left = round2(shape.x + r);
  const right = round2(shape.x + shape.width - r);
  const top = round2(shape.y + r);
  const bottom = round2(shape.y + shape.height - r);
  return `clip(${r}+0.5-hypot(max(0,max(${left}-(X+0.5),(X+0.5)-${right})),max(0,max(${top}-(Y+0.5),(Y+0.5)-${bottom}))),0,1)`;
}

function largest(parts: readonly string[]): string {
  return parts.reduce((all, part) => `max(${all},${part})`, "0");
}

export function artExpressions(art: FrameArt): { readonly r: string; readonly g: string; readonly b: string; readonly a: string } {
  const crease = art.crease ? `${art.crease.dark}*clip(1-abs((X+0.5)-${art.crease.at})/${Math.max(1, art.crease.spread)},0,1)` : "0";
  const prefix = [largest(art.buttons.map(covered)), covered(art.body), covered(art.glass), covered(art.hole), art.cutout ? covered(art.cutout) : "0", crease].map((part, index) => `st(${index},${part})`).join(";");
  const channel = (at: number) => {
    const [canvas, button, body, glass] = [DEVICE_CLIP_BACKGROUND.slice(2), GRAPHITE_DEEP, GRAPHITE, GLASS].map((hex) => parseInt(hex.slice(at, at + 2), 16));
    return `${prefix};st(6,${canvas}+(${button}-${canvas})*ld(0));st(6,ld(6)+(${body}-ld(6))*ld(1));st(7,ld(6)+(${glass}-ld(6))*ld(2));ld(7)*(1-ld(3))`;
  };
  return { r: channel(0), g: channel(2), b: channel(4), a: `${prefix};255*(1-ld(3)*(1-max(ld(4),ld(5))))` };
}

export function circleExpressions(diameter: number): { readonly lum: string; readonly a: string } {
  const r = diameter / 2;
  const distance = `hypot((X+0.5)-${r},(Y+0.5)-${r})`;
  const disc = `clip(${r}-${distance},0,1)`;
  const ring = `clip(1.5-abs(${r}-1.5-${distance}),0,1)`;
  return { lum: `255*(1-${ring})`, a: `255*max(0.45*${disc},0.5*${ring})` };
}

const TRANSPOSE: Readonly<Record<QuarterTurns, string>> = { 0: "", 1: ",transpose=clock", 2: ",hflip,vflip", 3: ",transpose=cclock" };

function sumOver(intervals: readonly TouchInterval[], value: (interval: TouchInterval) => number | null): string {
  return intervals.map((interval) => `${value(interval) ?? 1}*gte(t,${interval.from})*lt(t,${interval.to})`).join("+");
}

export function composeGraph(plan: DeviceComposition, stills: "cut" | "keep"): string {
  const lines: string[] = ["[0:v]format=yuv420p[b0]"];
  let base = 0;
  const next = () => `b${++base}`;
  plan.segments.forEach((segment, index) => {
    const input = index + 1;
    const video = `v${index}`;
    const art = `a${index}`;
    const expressions = artExpressions(segment.art);
    lines.push(`[${input}:v]setpts=PTS-STARTPTS+${segment.from}/TB,fps=${RECORD_FPS}${TRANSPOSE[segment.turns]},scale=${segment.width}:${segment.height},format=yuv420p[${video}]`);
    lines.push(`color=c=black@0:s=${segment.art.width}x${segment.art.height}:r=1:d=1,format=rgba,geq=r='${expressions.r}':g='${expressions.g}':b='${expressions.b}':a='${expressions.a}'${TRANSPOSE[segment.art.turns]}[${art}]`);
    const withVideo = next();
    lines.push(`[b${base - 1}][${video}]overlay=x=${segment.x}:y=${segment.y}:enable='gte(t,${segment.from})*lt(t,${segment.to})'[${withVideo}]`);
    const withArt = next();
    lines.push(`[${withVideo}][${art}]overlay=x=${segment.art.x}:y=${segment.art.y}:enable='gte(t,${segment.artFrom})*lt(t,${segment.to})'[${withArt}]`);
  });
  const used = plan.touches.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.length);
  if (used.length) {
    const circle = circleExpressions(plan.circle);
    lines.push(`color=c=black@0:s=${plan.circle}x${plan.circle}:r=1:d=1,format=rgba,geq=r='${circle.lum}':g='${circle.lum}':b='${circle.lum}':a='${circle.a}'${used.length > 1 ? `,split=${used.length}` : ""}${used.map(({ index }) => `[c${index}]`).join("")}`);
    const half = plan.circle / 2;
    for (const { slot, index } of used) {
      const into = next();
      lines.push(`[b${base - 1}][c${index}]overlay=eval=frame:x='${sumOver(slot, (each) => each.x)}-${half}':y='${sumOver(slot, (each) => each.y)}-${half}':enable='${sumOver(slot, () => null)}'[${into}]`);
    }
  }
  lines.push(stills === "cut" ? `[b${base}]split=2[out][still];[still]${FREEZE},nullsink` : `[b${base}]null[out]`);
  return `${lines.join(";\n")}\n`;
}

export function deviceComposeScript(plan: DeviceComposition, stills: "cut" | "keep", pair: ClipFfmpegPair | null = null): string {
  const inputs = plan.segments.map((segment) => `-i "$d/${segment.file}"`).join(" ");
  const files = plan.segments.map((segment) => segment.file).join(" ");
  return String.raw`d="$HOME/${RECORD_DIR}"
${useClipFfmpeg(pair)}
[ -s "$d/device.jsonl" ] || exit ${DEVICE_COMPOSE_EXITS.none}
command -v ffmpeg >/dev/null || { echo ffmpeg >&2; exit ${DEVICE_COMPOSE_EXITS.noRecorder}; }
for f in ${files}; do [ -s "$d/$f" ] || { echo "The recording's $f is missing." >&2; exit ${DEVICE_COMPOSE_EXITS.failed}; }; done
cat >"$d/compose.graph" <<'GRAPH'
${composeGraph(plan, stills)}GRAPH
major=$(ffmpeg -version | sed -n '1s/^ffmpeg version [^0-9]*\([0-9]*\).*/\1/p')
if [ "${"$"}{major:-0}" -ge 7 ]; then script="-/filter_complex"; else script="-filter_complex_script"; fi
rm -f "$d/capture.mkv"
ffmpeg -nostdin -hide_banner -nostats -loglevel info -y -f lavfi -i "color=c=${DEVICE_CLIP_BACKGROUND}:s=${plan.width}x${plan.height}:r=${RECORD_FPS}:d=${plan.length}" ${inputs} \
  $script "$d/compose.graph" -map "[out]" -an -c:v libx264 -preset ultrafast -crf 0 -pix_fmt yuv420p "$d/capture.mkv" 2>"$d/compose.log" || { grep -v '^\[freezedetect' "$d/compose.log" | tail -n 5 >&2; exit ${DEVICE_COMPOSE_EXITS.failed}; }
cuts=$(awk -v end="${plan.length}" '/freeze_start:/ { s = $NF } /freeze_end:/ { if (s != "") printf "%s[%.3f,%.3f]", sep, s + 0.5, $NF; sep = ","; s = "" }
  END { if (s != "" && s + 0.5 < end) printf "%s[%.3f,%.3f]", sep, s + 0.5, end }' "$d/compose.log")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/capture.mkv")
printf '{"size":"%s","cuts":[%s]}\n' "$size" "$cuts"
`;
}

export function deviceReadLogScript(): string {
  return `d="$HOME/${RECORD_DIR}"; [ -s "$d/device.jsonl" ] || exit ${RECORD_STOP_EXITS.none}; cat "$d/device.jsonl"`;
}

export function parseComposed(stdout: string): { readonly size: string; readonly cuts: readonly (readonly [number, number])[] } | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as { size?: unknown; cuts?: unknown };
    if (typeof value.size !== "string" || !Array.isArray(value.cuts)) return null;
    const cuts = value.cuts.filter((cut): cut is [number, number] => Array.isArray(cut) && cut.length === 2 && cut.every((each) => typeof each === "number" && Number.isFinite(each)) && cut[1] > cut[0]);
    return { size: value.size, cuts };
  } catch {
    return null;
  }
}

export function devicePrepared(plan: DeviceComposition, cuts: readonly (readonly [number, number])[]): Prepared {
  return {
    ended: plan.ended === "limit" ? "limit" : "stopped",
    recorded: plan.length,
    width: plan.width,
    height: plan.height,
    start: 0,
    position: plan.position,
    cuts,
    events: plan.events,
    notes: plan.notes,
    layout: plan.layout,
  };
}
