// A desktop box records its own screen, for an agent to show its work in the
// thread (059). On X11, ffmpeg's x11grab, with the ffmpeg the desktop images
// have; on Wayland, wf-recorder, which the Wayland images have from their
// rebuild after #707; on macOS, ffmpeg's avfoundation, with the Homebrew
// ffmpeg the Tart images have from their rebuild after #707; on Windows,
// ffmpeg's gdigrab in the desktop session, with the ffmpeg the Windows
// images have from their rebuild after #707. A recording runs in a session
// of its own, so it outlives the command that started it, and ends by itself at
// RECORD_LIMIT_S. Stopping it makes the clip in the box: still stretches cut
// to a short pause, an optional speed, and an H.264 MP4, which a small page
// beside it plays in the thread's inline preview.

import type { GuestOs } from "../transports/types.ts";

/** The longest a recording runs, in seconds, so one an agent forgets cannot run on. */
export const RECORD_LIMIT_S = 300;
/** The capture's frame rate. */
export const RECORD_FPS = 15;
/** Where a box keeps its recording, under the box user's home. */
export const RECORD_DIR = ".local/state/bb-box/recording";

/** What the start script exits with. */
export const RECORD_START_EXITS = { started: 0, running: 3, noRecorder: 4, noDisplay: 5, failed: 6 } as const;
/** What the stop script exits with. */
export const RECORD_STOP_EXITS = { made: 0, none: 3, failed: 6 } as const;

export type RecordSpeed = 1 | 2 | 4;

/** How a recording's still stretches over 1 s keep their first 0.5 s, and how the clip is made. */
const FREEZE = "freezedetect=n=0.0001:d=1";
const CLIP = "-an -c:v libx264 -preset medium -crf 28 -tune animation -pix_fmt yuv420p -movflags +faststart";

/**
 * Starts recording the desktop, in the background, for at most
 * RECORD_LIMIT_S. On Wayland, wf-recorder runs with --no-damage: tracking
 * damage, it records no frame while the screen is still, and does not see
 * a stop until the screen changes. It copies frames all the while, about
 * two thirds of a core, against a tenth for x11grab. timeout ends it at
 * the limit, and passes a stop's SIGTERM on to it. macOS has no setsid
 * command, so Perl's starts ffmpeg's session there. A missing recorder is
 * named on stderr.
 */
export function recordStartScript(os: GuestOs = "linux", position: CaptionPosition = "top"): string {
  if (os === "windows") return windowsStart();
  return String.raw`d="$HOME/${RECORD_DIR}"; mkdir -p "$d"
if [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit ${RECORD_START_EXITS.running}; fi
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
rm -f "$d/capture.mkv" "$d/clip.mp4" "$d/log" "$d/events" "$d"/pill-*
echo ${position} >"$d/position"
perl -MTime::HiRes=time -e 'printf "%.3f\n", time' >"$d/start"
if [ "$(uname)" = Darwin ]; then
  command -v ffmpeg >/dev/null || { echo ffmpeg >&2; exit ${RECORD_START_EXITS.noRecorder}; }
  screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/.*\[\([0-9]*\)\] Capture screen 0.*/\1/p' | head -n 1)
  [ -n "$screen" ] || exit ${RECORD_START_EXITS.noDisplay}
  perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' nohup ffmpeg -nostdin -loglevel error -y -f avfoundation -capture_cursor 1 \
    -framerate ${RECORD_FPS} -i "$screen:none" -t ${RECORD_LIMIT_S} -c:v libx264 -preset ultrafast -crf 0 "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
elif [ -n "${"$"}{WAYLAND_DISPLAY:-}" ]; then
  command -v wf-recorder >/dev/null || { echo wf-recorder >&2; exit ${RECORD_START_EXITS.noRecorder}; }
  setsid nohup timeout -s TERM ${RECORD_LIMIT_S} wf-recorder --no-dmabuf --no-damage -r ${RECORD_FPS} \
    -c libx264 -p preset=ultrafast -p crf=0 -f "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
elif [ -n "${"$"}{DISPLAY:-}" ]; then
  setsid nohup ffmpeg -nostdin -loglevel error -y -f x11grab -framerate ${RECORD_FPS} -i "$DISPLAY" -t ${RECORD_LIMIT_S} \
    -c:v libx264 -preset ultrafast -crf 0 "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
else
  exit ${RECORD_START_EXITS.noDisplay}
fi
echo $! >"$d/pid"
sleep 0.5
kill -0 "$(cat "$d/pid")" 2>/dev/null || { rm -f "$d/pid"; tail -n 3 "$d/log" >&2; exit ${RECORD_START_EXITS.failed}; }
`;
}

export function recordStopScript(options: { speed: RecordSpeed; stills: "cut" | "keep" }): string {
  return windowsStop(options);
}

export const RECORD_STEP_EXITS = { saved: 0, none: 3 } as const;

export type StepKind = "step" | "pass" | "fail";

export const CAPTION_CHARS = 90;

export function captionText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CAPTION_CHARS ? `${line.slice(0, CAPTION_CHARS - 1).trimEnd()}…` : line;
}

export function recordStepScript(kind: StepKind, text: string): string {
  const encoded = Buffer.from(captionText(text)).toString("base64");
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null || exit ${RECORD_STEP_EXITS.none}
printf '%s\t%s\t%s\n' "$(perl -MTime::HiRes=time -e 'printf "%.3f", time')" ${kind} '${encoded}' >>"$d/events"
`;
}

export function recordPrepareScript(stills: "cut" | "keep"): string {
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/pid" ] || [ -s "$d/capture.mkv" ] || exit ${RECORD_STOP_EXITS.none}
ended=limit
if [ -s "$d/pid" ]; then
  pid=$(cat "$d/pid")
  if kill -0 "$pid" 2>/dev/null; then
    ended=stopped
    kill -TERM "$pid"
    for i in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -f "$d/pid"
fi
[ -s "$d/capture.mkv" ] || { tail -n 3 "$d/log" >&2; exit ${RECORD_STOP_EXITS.failed}; }
recorded=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$d/capture.mkv")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/capture.mkv")
cuts=
if [ "${stills}" = cut ]; then
  cuts=$(ffmpeg -nostdin -hide_banner -i "$d/capture.mkv" -vf ${FREEZE} -map 0:v -f null - 2>&1 |
    awk -v end="$recorded" '/freeze_start:/ { s = $NF } /freeze_end:/ { printf "%s[%.3f,%.3f]", sep, s + 0.5, $NF; sep = ","; s = "" }
      END { if (s != "") printf "%s[%.3f,%.3f]", sep, s + 0.5, end }')
fi
printf '{"ended":"%s","recorded":%s,"size":"%s","start":%s,"position":"%s","cuts":[%s]}\n' "$ended" "$recorded" "$size" "$(cat "$d/start" 2>/dev/null || echo null)" "$(cat "$d/position" 2>/dev/null || echo top)" "$cuts"
[ ! -s "$d/events" ] || cat "$d/events"
`;
}

export interface RecordEvent {
  readonly at: number;
  readonly kind: StepKind;
  readonly text: string;
}

export interface Prepared {
  readonly ended: "stopped" | "limit";
  readonly recorded: number;
  readonly width: number;
  readonly height: number;
  readonly start: number | null;
  readonly position?: CaptionPosition;
  readonly cuts: readonly (readonly [number, number])[];
  readonly events: readonly RecordEvent[];
}

export function parsePrepared(stdout: string): Prepared | null {
  const lines = stdout.trim().split("\n");
  const head = lines.findIndex((line) => line.startsWith("{"));
  if (head < 0) return null;
  try {
    const value = JSON.parse(lines[head]!) as { ended: Prepared["ended"]; recorded: number; size: string; start: number | null; position?: string; cuts: [number, number][] };
    const [width, height] = value.size.split("x").map(Number);
    const events = lines.slice(head + 1).flatMap((line): RecordEvent[] => {
      const [at, kind, encoded] = line.split("\t");
      if (!at || !encoded || (kind !== "step" && kind !== "pass" && kind !== "fail")) return [];
      return [{ at: Number(at), kind, text: Buffer.from(encoded, "base64").toString("utf8") }];
    });
    return { ended: value.ended, recorded: value.recorded, width: width ?? 0, height: height ?? 0, start: value.start, position: value.position === "bottom" ? "bottom" : "top", cuts: value.cuts, events };
  } catch {
    return null;
  }
}

export type CaptionPosition = "top" | "bottom";

export interface Caption {
  readonly kind: StepKind;
  readonly text: string;
  readonly row: 0 | 1;
  readonly from: number;
  readonly to: number;
  readonly real: number;
}

export interface Hold {
  readonly at: number;
  readonly seconds: number;
}

export type PillLook = StepKind | "mark";

export interface Overlay {
  readonly look: PillLook;
  readonly text: string;
  readonly size: number;
  readonly x: "centre" | "right";
  readonly y: number;
  readonly from: number;
  readonly to: number;
}

export interface ClipPlan {
  readonly speed: RecordSpeed;
  readonly cuts: readonly (readonly [number, number])[];
  readonly holds: readonly Hold[];
  readonly captions: readonly Caption[];
  readonly overlays: readonly Overlay[];
  readonly position: CaptionPosition;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly fontSize: number;
  readonly edge: number;
}

export const CLIP_WIDTH = 1280;
export const SKIP_MARK_S = 3;
export const MARK_SHOWN_S = 1.2;

export function readingSeconds(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(6, Math.max(2, 1 + words / 3.5));
}

export function skipWords(seconds: number): string {
  return seconds < 90 ? `${Math.round(seconds)} s later` : `${Math.round(seconds / 60)} min later`;
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;

export function planClip(prepared: Prepared, speed: RecordSpeed): ClipPlan {
  const cuts = [...prepared.cuts].sort((a, b) => a[0] - b[0]);
  const removedBefore = (at: number) => cuts.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(at, to) - from), 0);
  const onClip = (at: number) => (at - removedBefore(at)) / speed;
  const base = onClip(prepared.recorded);
  const start = prepared.start ?? 0;
  const changes = [...prepared.events]
    .map((event) => {
      const real = Math.min(prepared.recorded, Math.max(0, event.at - start));
      return { ...event, text: captionText(event.text), real, at: Math.min(base, Math.max(0, onClip(real))) };
    })
    .sort((a, b) => a.at - b.at);
  const holds: Hold[] = [];
  const shownAt: number[] = [];
  let added = 0;
  changes.forEach((change, index) => {
    shownAt.push(change.at + added);
    const natural = (changes[index + 1]?.at ?? base) - change.at;
    const hold = Math.max(0, readingSeconds(change.text) - natural);
    if (hold > 0) {
      holds.push({ at: round3(change.at), seconds: round3(hold) });
      added += hold;
    }
  });
  const length = round3(base + added);
  const nextStep = (index: number) => {
    const later = changes.findIndex((change, other) => other > index && change.kind === "step");
    return later < 0 ? length : shownAt[later]!;
  };
  const captions = changes.map((change, index): Caption => ({ kind: change.kind, text: change.text, row: change.kind === "step" ? 0 : 1, from: round3(shownAt[index]!), to: round3(nextStep(index)), real: round3(change.real) }));
  const width = Math.min(CLIP_WIDTH, prepared.width || CLIP_WIDTH);
  const height = prepared.width ? Math.round((prepared.height * width) / prepared.width / 2) * 2 : 720;
  const fontSize = Math.max(14, Math.round(height / 38));
  const pill = (size: number) => Math.round(size * 2.1);
  const gap = Math.max(4, Math.round(fontSize * 0.3));
  const edge = Math.round(height * 0.035);
  const dock = Math.round(height * 0.11);
  const position = prepared.position ?? "top";
  const captionY = (row: 0 | 1) =>
    position === "top" ? edge + row * (pill(fontSize) + gap) : height - dock - (2 - row) * pill(fontSize) - (1 - row) * gap;
  const markSize = Math.max(11, Math.round(fontSize * 0.7));
  const markHeight = pill(markSize);
  const cornerY = position === "top" ? height - dock - markHeight : Math.round(height * 0.05);
  const skipY = speed > 1 ? (position === "top" ? cornerY - markHeight - gap : cornerY + markHeight + gap) : cornerY;
  const finalAt = (at: number) => at + holds.filter((hold) => hold.at < at - 0.0005).reduce((sum, hold) => sum + hold.seconds, 0);
  const skips = cuts
    .filter(([from, to]) => to - from >= SKIP_MARK_S)
    .map(([from, to]): Overlay => {
      const shown = round3(finalAt(onClip(from)));
      return { look: "mark", text: skipWords(to - from), size: markSize, x: "right", y: skipY, from: shown, to: round3(Math.min(length, shown + MARK_SHOWN_S)) };
    });
  const overlays: Overlay[] = [
    ...captions.map((caption): Overlay => ({ look: caption.kind, text: caption.text, size: fontSize, x: "centre", y: captionY(caption.row), from: caption.from, to: caption.to })),
    ...(speed > 1 ? [{ look: "mark" as const, text: `${speed}x`, size: markSize, x: "right" as const, y: cornerY, from: 0, to: length }] : []),
    ...skips,
  ];
  return { speed, cuts, holds, captions, overlays, position, length, width, height, fontSize, edge };
}

const PILLS: Readonly<Record<PillLook, { readonly icon: string; readonly color: string; readonly fill: string; readonly alpha: number }>> = {
  step: { icon: "▶", color: "4f8df5", fill: "5f6368", alpha: 0.82 },
  pass: { icon: "✓", color: "34c759", fill: "2a2a2a", alpha: 0.94 },
  fail: { icon: "✗", color: "ff453a", fill: "2a2a2a", alpha: 0.94 },
  mark: { icon: "▶▶", color: "ffffff", fill: "1f1f1f", alpha: 0.88 },
};

export function clipGraph(plan: ClipPlan, withOverlays: boolean): string {
  const select = plan.cuts.length ? `select='not(${plan.cuts.map(([from, to]) => `between(t,${from.toFixed(3)},${to.toFixed(3)})`).join("+")})',` : "";
  const since = "(T-STARTT)";
  const removed = plan.cuts.map(([from, to]) => `clip(${since}-${from.toFixed(3)},0,${round3(to - from)})`).join("+");
  const clock = removed ? `(${since}-(${removed}))/${plan.speed}` : `${since}/${plan.speed}`;
  const pts = `'(${clock}${plan.holds.map((hold) => `+${hold.seconds}*gt(${clock},${hold.at})`).join("")})/TB'`;
  const head = `[0:v]${select}setpts=${pts},fps=${RECORD_FPS},tpad=stop_mode=clone:stop_duration=${plan.length},trim=duration=${plan.length},scale='min(${CLIP_WIDTH},iw)':-2`;
  if (!withOverlays || !plan.overlays.length) return `${head}[out]`;
  const steps = plan.overlays.map((overlay, index) => {
    const x = overlay.x === "centre" ? "(W-w)/2" : `W-w-${plan.edge}`;
    const into = index === plan.overlays.length - 1 ? "[out]" : `[v${index + 1}]`;
    return `[v${index}][${index + 1}:v]overlay=x=${x}:y=${overlay.y}:enable='between(t,${overlay.from},${overlay.to})'${into}`;
  });
  return [`${head}[v0]`, ...steps].join(";");
}

const MAC_PILL = String.raw`ObjC.import("AppKit");
function run(argv) {
  const [file, icon, iconHex, fillHex, alpha, size, out] = argv;
  const text = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null);
  const fs = Number(size);
  const color = (hex, a) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255, a);
  const font = $.NSFont.systemFontOfSizeWeight(fs, $.NSFontWeightMedium);
  const iconFont = $.NSFont.systemFontOfSizeWeight(fs, $.NSFontWeightBold);
  const attrs = (f, c) => $.NSDictionary.dictionaryWithObjectsForKeys($([f, c]), $([$.NSFontAttributeName, $.NSForegroundColorAttributeName]));
  const mark = $(icon);
  const labelAttrs = attrs(font, color("ffffff", 1)), markAttrs = attrs(iconFont, color(iconHex, 1));
  const tw = Math.ceil(text.sizeWithAttributes(labelAttrs).width), iw = Math.ceil(mark.sizeWithAttributes(markAttrs).width);
  const h = Math.round(fs * 2.1), pad = fs, gap = Math.round(fs * 0.6), w = pad + iw + gap + tw + pad;
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, w, h, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  color(fillHex, Number(alpha)).setFill;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, w, h), h / 2, h / 2).fill;
  const baseline = (h - font.capHeight) / 2;
  mark.drawAtPointWithAttributes($.NSMakePoint(pad, baseline + iconFont.descender), markAttrs);
  text.drawAtPointWithAttributes($.NSMakePoint(pad + iw + gap, baseline + font.descender), labelAttrs);
  $.NSGraphicsContext.restoreGraphicsState;
  rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(out, true);
  return w + "x" + h;
}
`;

export function recordMakeScript(plan: ClipPlan): string {
  const pills = plan.overlays.map((overlay, index) => {
    const look = PILLS[overlay.look];
    const encoded = Buffer.from(overlay.text).toString("base64");
    return `pill ${index} '${encoded}' '${Buffer.from(look.icon).toString("base64")}' ${look.color} ${look.fill} ${look.alpha} ${overlay.size}`;
  });
  const inputs = plan.overlays.map((_, index) => `-i "$d/pill-${index}.png"`).join(" ");
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/capture.mkv" ] || exit ${RECORD_STOP_EXITS.none}
decode() { perl -MMIME::Base64 -e 'print decode_base64($ARGV[0])' "$1"; }
if [ "$(uname)" = Darwin ]; then
  cat >"$d/pill.js" <<'PILL'
${MAC_PILL}PILL
  pill() {
    decode "$2" >"$d/pill-$1.txt"
    osascript -l JavaScript "$d/pill.js" "$d/pill-$1.txt" "$(decode "$3")" "$4" "$5" "$6" "$7" "$d/pill-$1.png" >/dev/null
  }
else
  font=$(fc-match -f '%{file}' 'DejaVu Sans' 2>/dev/null)
  bold=$(fc-match -f '%{file}' 'DejaVu Sans:bold' 2>/dev/null)
  measure() { ffmpeg -nostdin -hide_banner -v info -f lavfi -i color=s=16x16:d=0.1 -vf "drawtext=fontfile=$1:textfile=$2:expansion=none:fontsize=$3:x='print(tw)'" -frames:v 1 -f null - 2>&1 | awk '/^[0-9.]+$/ { print int($1 + 0.5); exit }'; }
  pill() {
    fs=$7
    decode "$2" >"$d/pill-$1.txt"; decode "$3" >"$d/pill-$1.icon"
    tw=$(measure "$font" "$d/pill-$1.txt" "$fs"); iw=$(measure "$bold" "$d/pill-$1.icon" "$fs")
    [ -n "$tw" ] && [ -n "$iw" ] || return 1
    h=$((fs * 21 / 10)); pad=$fs; gap=$((fs * 6 / 10)); w=$((pad + iw + gap + tw + pad)); r=$((h / 2)); cap=$((fs * 73 / 100))
    rgb=$((0x$5))
    ffmpeg -nostdin -v error -y -f lavfi -i "color=c=black@0:s=$${"{"}w}x$${"{"}h},format=rgba" -vf "geq=r=$((rgb >> 16 & 255)):g=$((rgb >> 8 & 255)):b=$((rgb & 255)):a='255*$6*clip($r+0.5-hypot(max(0\,max($r-X\,X-($w-1-$r)))\,Y-($h-1)/2)\,0\,1)',drawtext=fontfile=$bold:textfile=$d/pill-$1.icon:expansion=none:fontsize=$fs:fontcolor=0x$4:x=$pad:y=($h+$cap)/2-ascent,drawtext=fontfile=$font:textfile=$d/pill-$1.txt:expansion=none:fontsize=$fs:fontcolor=white:x=$((pad + iw + gap)):y=($h+$cap)/2-ascent" -frames:v 1 "$d/pill-$1.png"
  }
fi
captions=${plan.overlays.length ? "1" : "none"}
${pills.map((line) => `[ "$captions" = 0 ] || ${line} || captions=0`).join("\n")}
if [ "$captions" = 1 ]; then
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" ${inputs} -filter_complex "${clipGraph(plan, true)}" -map "[out]" ${CLIP} "$d/clip.mp4" || exit ${RECORD_STOP_EXITS.failed}
else
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" -filter_complex "${clipGraph(plan, false)}" -map "[out]" ${CLIP} "$d/clip.mp4" || exit ${RECORD_STOP_EXITS.failed}
fi
seconds() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
recorded=$(seconds "$d/capture.mkv")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/clip.mp4")
rm -f "$d/capture.mkv" "$d/events" "$d"/pill-* "$d/pill.js"
printf '{"ended":"stopped","recorded":%s,"clip":%s,"bytes":%s,"size":"%s","captions":%s}\n'   "$recorded" "$(seconds "$d/clip.mp4")" "$(wc -c <"$d/clip.mp4" | tr -d ' ')" "$size" "$(if [ "$captions" = 1 ]; then echo true; elif [ "$captions" = none ]; then echo null; else echo false; fi)"
`;
}

/**
 * On Windows, in the desktop session, as gdigrab reads the desktop it runs
 * in. ddagrab needs a Direct3D 11 device, which a box drawn by WARP lacks.
 * ffmpeg gets a hidden console of its own, which the stop closes.
 */
function windowsStart(): string {
  return String.raw`$d = Join-Path $HOME '${RECORD_DIR.replaceAll("/", "\\")}'
New-Item -ItemType Directory -Force $d | Out-Null
$running = if (Test-Path "$d\pid") { Get-Process -Id ([int](Get-Content "$d\pid" -Raw)) -ErrorAction Ignore | Where-Object ProcessName -eq ffmpeg }
if ($running) { exit ${RECORD_START_EXITS.running} }
$ffmpeg = (Get-Command ffmpeg -ErrorAction Ignore).Source
if (-not $ffmpeg) { [Console]::Error.WriteLine('ffmpeg'); exit ${RECORD_START_EXITS.noRecorder} }
Remove-Item "$d\capture.mkv", "$d\clip.mp4", "$d\log" -Force -ErrorAction Ignore
$p = Start-Process $ffmpeg -WindowStyle Hidden -PassThru -RedirectStandardError "$d\log" -ArgumentList ('-nostdin -loglevel error -y -f gdigrab -framerate ${RECORD_FPS} -draw_mouse 1 -i desktop -t ${RECORD_LIMIT_S} -c:v libx264 -preset ultrafast -crf 0 "' + "$d\capture.mkv" + '"')
Set-Content "$d\pid" $p.Id
Start-Sleep -Milliseconds 500
if ($p.HasExited) { Remove-Item "$d\pid"; Get-Content "$d\log" -Tail 3 | ForEach-Object { [Console]::Error.WriteLine($_) }; exit ${RECORD_START_EXITS.failed} }
exit ${RECORD_START_EXITS.started}
`;
}

/**
 * The stop on Windows, in the desktop session: taskkill without /F closes
 * ffmpeg's console, and ffmpeg ends its file whole; /F would leave it
 * broken. A window's close does not reach another session.
 */
function windowsStop(options: { speed: RecordSpeed; stills: "cut" | "keep" }): string {
  return String.raw`$d = Join-Path $HOME '${RECORD_DIR.replaceAll("/", "\\")}'
$capture = "$d\capture.mkv"
# Numbers with a decimal point, whatever the box's language.
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
if (-not (Test-Path "$d\pid") -and -not (Test-Path $capture)) { exit ${RECORD_STOP_EXITS.none} }
$ended = 'limit'
if (Test-Path "$d\pid") {
  $p = Get-Process -Id ([int](Get-Content "$d\pid" -Raw)) -ErrorAction Ignore | Where-Object ProcessName -eq ffmpeg
  if ($p) {
    $ended = 'stopped'
    taskkill /PID $p.Id *> $null
    if (-not $p.WaitForExit(10000)) { taskkill /F /PID $p.Id *> $null }
  }
  Remove-Item "$d\pid"
}
function Fail { Get-Content "$d\log" -Tail 3 -ErrorAction Ignore | ForEach-Object { [Console]::Error.WriteLine($_) }; exit ${RECORD_STOP_EXITS.failed} }
if (-not (Test-Path $capture) -or -not (Get-Item $capture).Length) { Fail }
function Seconds($file) { [double](ffprobe -v error -show_entries format=duration -of csv=p=0 $file) }
$recorded = Seconds $capture
$keep = @()
if ('${options.stills}' -eq 'cut') {
  $start = $null
  foreach ($line in (ffmpeg -nostdin -hide_banner -i $capture -vf ${FREEZE} -map 0:v -f null - 2>&1)) {
    if ("$line" -match 'freeze_(start|end): ([\d.]+)') {
      $t = [double]$Matches[2]
      if ($Matches[1] -eq 'start') { $start = $t } elseif ($null -ne $start) { $keep += 'between(t,{0:f3},{1:f3})' -f ($start + 0.5), $t; $start = $null }
    }
  }
  if ($null -ne $start) { $keep += 'between(t,{0:f3},{1:f3})' -f ($start + 0.5), $recorded }
}
$select = if ($keep) { "select='not($($keep -join '+'))'," } else { '' }
ffmpeg -nostdin -loglevel error -y -i $capture -vf "$($select)setpts=N/(${RECORD_FPS}*${options.speed})/TB,fps=${RECORD_FPS},scale='min(1280,iw)':-2" ${CLIP} "$d\clip.mp4" 2>> "$d\log"
if ($LASTEXITCODE) { Fail }
$size = ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d\clip.mp4"
Remove-Item $capture
'{{"ended":"{0}","recorded":{1},"clip":{2},"bytes":{3},"size":"{4}"}}' -f $ended, $recorded, (Seconds "$d\clip.mp4"), (Get-Item "$d\clip.mp4").Length, "$size".Trim()
exit ${RECORD_STOP_EXITS.made}
`;
}

/** What the stop script says of the clip. */
export interface RecordResult {
  readonly ended: "stopped" | "limit";
  readonly recorded: number;
  readonly clip: number;
  readonly bytes: number;
  readonly size: string;
  readonly captions?: boolean | null;
}

/** The stop script's line of JSON, or null when it printed none. */
export function parseRecordResult(stdout: string): RecordResult | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as RecordResult;
    return typeof value.bytes === "number" && typeof value.clip === "number" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The page the thread's inline preview shows: the clip `mp4`, a file beside
 * it, playing at once, muted and looping.
 */
export interface Chapter {
  readonly at: number;
  readonly real: number;
  readonly text: string;
  readonly result: { readonly passed: boolean; readonly text: string } | null;
}

export function chaptersOf(captions: readonly Caption[]): Chapter[] {
  const chapters: Chapter[] = [];
  for (const caption of captions) {
    if (caption.kind === "step") chapters.push({ at: caption.from, real: caption.real, text: caption.text, result: null });
    else if (chapters.length) chapters[chapters.length - 1] = { ...chapters[chapters.length - 1]!, result: { passed: caption.kind === "pass", text: caption.text } };
    else chapters.push({ at: caption.from, real: caption.real, text: "", result: { passed: caption.kind === "pass", text: caption.text } });
  }
  return chapters;
}

function clock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

export function recordPage(title: string, mp4: string, chapters: readonly Chapter[] = []): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const video = `<video id="clip" src="${escape(encodeURIComponent(mp4))}" autoplay muted loop controls playsinline style="display:block;width:100%;height:auto"></video>`;
  if (!chapters.length) {
    return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="margin:0;background:#111">${video}</body>
`;
  }
  const rows = chapters
    .map((chapter) => {
      const result = chapter.result ? `<span style="color:${chapter.result.passed ? "#34c759" : "#ff453a"}">${chapter.result.passed ? "✓" : "✗"}</span> ${escape(chapter.result.text)}` : "";
      const step = chapter.text ? `<span style="color:#4f8df5">▶</span> ${escape(chapter.text)}` : "";
      return `<li><a href="#" data-at="${chapter.at}"><span class="at">${clock(chapter.real)}</span><span>${step}${step && result ? "<br>" : ""}${result}</span></a></li>`;
    })
    .join("");
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<style>body{margin:0;background:#111;color:#e8e8e8;font:13px/1.45 -apple-system,system-ui,sans-serif}ol{list-style:none;margin:0;padding:8px 10px}li a{display:flex;gap:10px;padding:5px 6px;border-radius:6px;color:inherit;text-decoration:none}li a:hover{background:#222}.at{color:#9a9a9a;font-variant-numeric:tabular-nums;min-width:2.6em}</style>
<body>${video}<ol>${rows}</ol>
<script>document.querySelectorAll("a[data-at]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); const v = document.getElementById("clip"); v.currentTime = Number(a.dataset.at); v.play(); }));</script></body>
`;
}

/** The preview's height in BB, for a clip of `size` (WxH) shown about 640 wide. */
export function previewHeight(size: string): number {
  const [width, height] = size.split("x").map(Number);
  if (!width || !height) return 400;
  return Math.max(120, Math.min(1200, Math.round((640 * height) / width) + 8));
}
