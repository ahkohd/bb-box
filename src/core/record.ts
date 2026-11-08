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
import { RECORD_DIR, RECORD_LIMIT_S, type CaptionPosition, type StepKind } from "./device-recording.ts";
import type { InputEvent } from "./record-input.ts";
import { CLIP_FPS, keptMotion, type ChangedRegion, type PointerSample } from "./record-motion.ts";
import { GRID_COLUMNS, GRID_ROWS, areaOnClip, bundle, contentSize, frameTail, planScene, pointerOnClip, sceneHead, type BrightnessGrid, type PointerMode, type SceneFacts, type SceneOptions, type ScenePlan } from "./record-scene.ts";

export { RECORD_DIR, RECORD_LIMIT_S, type CaptionPosition, type StepKind };

/** The capture's frame rate. */
export const RECORD_FPS = 15;

export const SAMPLER_HZ = 30;
export const CHANGES_WIDTH = 480;
export const CHANGES_MOST = 3000;
export const SAMPLES_MOST = 12_000;
export const GRID_FILE = "grid.raw";
const GRID_CELLS = GRID_COLUMNS * GRID_ROWS;
const GRIDS_MOST = RECORD_LIMIT_S + 30;
export const FIRST_FRAME_LAG_S = { x11: 0.09, wayland: 0.09, macos: 0.1, windows: 0.1 } as const;
export const DEFAULT_SCENE_OPTIONS: SceneOptions = { zoom: true, frame: true };

const X11_SAMPLER = String.raw`import ctypes, ctypes.util, sys, time
x = ctypes.CDLL(ctypes.util.find_library("X11") or "libX11.so.6")
u, i, ui, P, B = ctypes.c_ulong, ctypes.c_int, ctypes.c_uint, ctypes.POINTER, ctypes.byref
x.XOpenDisplay.restype = ctypes.c_void_p
x.XOpenDisplay.argtypes = [ctypes.c_char_p]
x.XDefaultRootWindow.restype = u
x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
x.XDefaultScreen.argtypes = [ctypes.c_void_p]
x.XDisplayWidth.argtypes = [ctypes.c_void_p, i]
x.XDisplayHeight.argtypes = [ctypes.c_void_p, i]
x.XQueryPointer.argtypes = [ctypes.c_void_p, u, P(u), P(u), P(i), P(i), P(i), P(i), P(ui)]
display = x.XOpenDisplay(None)
if not display:
    sys.exit(1)
root = x.XDefaultRootWindow(display)
screen = x.XDefaultScreen(display)
out = open(sys.argv[1], "w", buffering=1)
out.write("screen %d %d\n" % (x.XDisplayWidth(display, screen), x.XDisplayHeight(display, screen)))
end = time.time() + float(sys.argv[2])
rr, cr, rx, ry, wx, wy, mask = u(), u(), i(), i(), i(), i(), ui()
last = None
while time.time() < end:
    if x.XQueryPointer(display, root, B(rr), B(cr), B(rx), B(ry), B(wx), B(wy), B(mask)):
        m = mask.value
        now = (rx.value, ry.value, (1 if m & 256 else 0) | (2 if m & 512 else 0) | (4 if m & 1024 else 0))
        if now != last:
            out.write("%.3f %d %d %d\n" % (time.time(), now[0], now[1], now[2]))
            last = now
    time.sleep(1 / ${SAMPLER_HZ})
`;

const MAC_SAMPLER = String.raw`ObjC.import("AppKit");
function run(argv) {
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const write = (text) => out.writeData($(text).dataUsingEncoding($.NSUTF8StringEncoding));
  const frame = $.NSScreen.mainScreen.frame;
  const height = frame.size.height;
  write("screen " + Math.round(frame.size.width) + " " + Math.round(height) + "\n");
  const end = Date.now() + Number(argv[0]) * 1000;
  let last = "";
  while (Date.now() < end) {
    const at = $.NSEvent.mouseLocation;
    const pressed = Number($.NSEvent.pressedMouseButtons);
    const now = Math.round(at.x) + " " + Math.round(height - at.y) + " " + ((pressed & 1 ? 1 : 0) | (pressed & 4 ? 2 : 0) | (pressed & 2 ? 4 : 0));
    if (now !== last) {
      write((Date.now() / 1000).toFixed(3) + " " + now + "\n");
      last = now;
    }
    delay(1 / ${SAMPLER_HZ});
  }
}
`;

const WAYLAND_CURSOR = "/usr/local/libexec/bb-box/cursor";

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
  if (os === "windows") return windowsStart(position);
  return String.raw`d="$HOME/${RECORD_DIR}"; mkdir -p "$d"
if [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit ${RECORD_START_EXITS.running}; fi
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
if [ -s "$d/pointer.pid" ]; then kill "$(cat "$d/pointer.pid")" 2>/dev/null; fi
rm -f "$d/capture.mkv" "$d/clip.mp4" "$d/log" "$d/events" "$d/pointer" "$d/pointer.pid" "$d/pointer-mode" "$d/analysis.log" "$d/${GRID_FILE}"
find "$d" -maxdepth 1 \( -name 'pill-*' -o -name 'ring-*' -o -name '*.png' -o -name '*.cmd' -o -name '*.graph' -o -name '*.bundle' \) -exec rm -f {} +
echo ${position} >"$d/position"
mode=shown
sampled() {
  sleep 0.3
  if [ -s "$d/pointer" ] && kill -0 "$(cat "$d/pointer.pid")" 2>/dev/null; then mode=drawn; else kill "$(cat "$d/pointer.pid")" 2>/dev/null; rm -f "$d/pointer.pid" "$d/pointer"; fi
}
if [ "$(uname)" = Darwin ]; then
  command -v ffmpeg >/dev/null || { echo ffmpeg >&2; exit ${RECORD_START_EXITS.noRecorder}; }
  screen=$(ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 | sed -n 's/.*\[\([0-9]*\)\] Capture screen 0.*/\1/p' | head -n 1)
  [ -n "$screen" ] || exit ${RECORD_START_EXITS.noDisplay}
  cat >"$d/pointer.js" <<'SAMPLER'
${MAC_SAMPLER}SAMPLER
  perl -MPOSIX -e '$SIG{HUP} = "IGNORE"; POSIX::setsid(); exec @ARGV' osascript -l JavaScript "$d/pointer.js" ${RECORD_LIMIT_S} >"$d/pointer" 2>/dev/null </dev/null &
  echo $! >"$d/pointer.pid"
  sampled
  cursor=1; [ $mode = shown ] || cursor=0
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' >"$d/start"
  perl -MPOSIX -e '$SIG{HUP} = "IGNORE"; POSIX::setsid(); exec @ARGV' ffmpeg -nostdin -loglevel error -y -f avfoundation -capture_cursor $cursor \
    -framerate ${RECORD_FPS} -i "$screen:none" -t ${RECORD_LIMIT_S} -c:v libx264 -preset ultrafast -crf 0 "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
elif [ -n "${"$"}{WAYLAND_DISPLAY:-}" ]; then
  command -v wf-recorder >/dev/null || { echo wf-recorder >&2; exit ${RECORD_START_EXITS.noRecorder}; }
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' >"$d/start"
  setsid nohup timeout -s TERM ${RECORD_LIMIT_S} wf-recorder --no-dmabuf --no-damage -r ${RECORD_FPS} \
    -c libx264 -p preset=ultrafast -p crf=0 -f "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
elif [ -n "${"$"}{DISPLAY:-}" ]; then
  if command -v python3 >/dev/null; then
    cat >"$d/pointer.py" <<'SAMPLER'
${X11_SAMPLER}SAMPLER
    setsid nohup python3 "$d/pointer.py" "$d/pointer" ${RECORD_LIMIT_S} >/dev/null 2>&1 </dev/null &
    echo $! >"$d/pointer.pid"
    sampled
  fi
  draw=1; [ $mode = shown ] || draw=0
  perl -MTime::HiRes=time -e 'printf "%.3f\n", time' >"$d/start"
  setsid nohup ffmpeg -nostdin -loglevel error -y -f x11grab -draw_mouse $draw -framerate ${RECORD_FPS} -i "$DISPLAY" -t ${RECORD_LIMIT_S} \
    -c:v libx264 -preset ultrafast -crf 0 "$d/capture.mkv" >"$d/log" 2>&1 </dev/null &
else
  exit ${RECORD_START_EXITS.noDisplay}
fi
echo $mode >"$d/pointer-mode"
echo $! >"$d/pid"
sleep 0.5
kill -0 "$(cat "$d/pid")" 2>/dev/null || { rm -f "$d/pid"; [ ! -s "$d/pointer.pid" ] || kill "$(cat "$d/pointer.pid")" 2>/dev/null; tail -n 3 "$d/log" >&2; exit ${RECORD_START_EXITS.failed}; }
`;
}

export const RECORD_STEP_EXITS = { saved: 0, none: 3 } as const;

export const CAPTION_CHARS = 90;

export function captionText(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CAPTION_CHARS ? `${line.slice(0, CAPTION_CHARS - 1).trimEnd()}…` : line;
}

export function recordStepScript(kind: StepKind, text: string, os: GuestOs = "linux"): string {
  const encoded = Buffer.from(captionText(text)).toString("base64");
  if (os === "windows") return windowsStep(kind, encoded);
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null || exit ${RECORD_STEP_EXITS.none}
printf '%s\t%s\t%s\n' "$(perl -MTime::HiRes=time -e 'printf "%.3f", time')" ${kind} '${encoded}' >>"$d/events"
`;
}

export function recordPrepareScript(stills: "cut" | "keep", os: GuestOs = "linux"): string {
  if (os === "windows") return windowsPrepare(stills);
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/pid" ] || [ -s "$d/capture.mkv" ] || exit ${RECORD_STOP_EXITS.none}
ended=limit
if [ -s "$d/pid" ]; then
  pid=$(cat "$d/pid")
  case $pid in '' | 0 | *[!0-9]*) pid= ;; esac
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    ended=stopped
    kill -TERM "$pid"
    for i in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -f "$d/pid"
fi
if [ -s "$d/pointer.pid" ]; then kill "$(cat "$d/pointer.pid")" 2>/dev/null; rm -f "$d/pointer.pid"; fi
[ -s "$d/capture.mkv" ] || { tail -n 3 "$d/log" >&2; exit ${RECORD_STOP_EXITS.failed}; }
recorded=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$d/capture.mkv")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/capture.mkv")
ffmpeg -nostdin -hide_banner -nostats -i "$d/capture.mkv" -filter_complex "${analysisGraph(stills)}" -map "[o]" -f null - -map "[grid]" -f rawvideo -pix_fmt gray "$d/${GRID_FILE}" 2>"$d/analysis.log" ||
  ffmpeg -nostdin -hide_banner -nostats -i "$d/capture.mkv" -vf ${FREEZE} -map 0:v -f null - 2>"$d/analysis.log"
cuts=
if [ "${stills}" = cut ]; then
  cuts=$(awk -v end="$recorded" '/freeze_start:/ { s = $NF } /freeze_end:/ { printf "%s[%.3f,%.3f]", sep, s + 0.5, $NF; sep = ","; s = "" }
      END { if (s != "") printf "%s[%.3f,%.3f]", sep, s + 0.5, end }' "$d/analysis.log")
fi
luma=$(awk -F= '/lavfi.signalstats.YAVG=/ { s += $NF; n++ } END { if (n) printf "%.1f", s / n; else printf "null" }' "$d/analysis.log")
agent=false
if [ "$(uname)" = Darwin ]; then lag=${FIRST_FRAME_LAG_S.macos}; keys=mac; agent=true; elif [ -n "${"$"}{WAYLAND_DISPLAY:-}" ]; then lag=${FIRST_FRAME_LAG_S.wayland}; keys=pc; else lag=${FIRST_FRAME_LAG_S.x11}; keys=pc; fi
printf '{"ended":"%s","recorded":%s,"size":"%s","start":%s,"position":"%s","cuts":[%s],"pointer":"%s","lag":%s,"luma":%s,"keys":"%s","agentcursor":%s}\n' "$ended" "$recorded" "$size" "$(cat "$d/start" 2>/dev/null || echo null)" "$(cat "$d/position" 2>/dev/null || echo top)" "$cuts" "$(cat "$d/pointer-mode" 2>/dev/null || echo shown)" "$lag" "$luma" "$keys" "$agent"
[ ! -s "$d/events" ] || cat "$d/events"
[ ! -s "$d/pointer" ] || head -n ${SAMPLES_MOST} "$d/pointer" | sed 's/^/P /'
awk -v f="$(echo "$size" | awk -Fx '{ printf "%.4f", $1 / ${CHANGES_WIDTH} }')" '/Parsed_bbox/ && / x1:/ {
    for (i = 1; i <= NF; i++) { split($i, kv, ":"); v[kv[1]] = kv[2] }
    printf "C %.3f %d %d %d %d\n", v["pts_time"], v["x1"] * f, v["y1"] * f, (v["x2"] - v["x1"] + 1) * f, (v["y2"] - v["y1"] + 1) * f
  }' "$d/analysis.log" | head -n ${CHANGES_MOST}
[ ! -s "$d/${GRID_FILE}" ] || od -An -v -tu1 "$d/${GRID_FILE}" | awk -v n=${GRID_CELLS} '{ for (i = 1; i <= NF; i++) { if (c % n == 0) printf "%sG %d ", (c ? "\n" : ""), c / n; printf "%02x", $i; c++ } } END { if (c) printf "\n" }' | head -n ${GRIDS_MOST}
`;
}

export function analysisGraph(stills: "cut" | "keep"): string {
  const head = stills === "cut" ? `[0:v]${FREEZE},split=2[o][a]` : "[0:v]split=2[o][a]";
  return `${head};[a]fps=4,scale=${CHANGES_WIDTH}:-2:flags=area,format=gray,split=3[c][l][g];[c]tblend=all_mode=difference,bbox=min_val=6,nullsink;[l]signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG,nullsink;[g]fps=1,scale=${GRID_COLUMNS}:${GRID_ROWS}:flags=area[grid]`;
}

export interface RecordEvent {
  readonly at: number;
  readonly kind: StepKind;
  readonly text: string;
}

export interface ClipNote {
  readonly at: number;
  readonly text: string;
}

export interface ClipLayout {
  readonly fontSize: number;
  readonly band: { readonly y: number; readonly height: number };
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
  readonly notes?: readonly ClipNote[];
  readonly layout?: ClipLayout;
  readonly scene?: SceneFacts;
}

const finiteNumbers = (parts: readonly string[]) => parts.map(Number).every(Number.isFinite);

const GRID_LINE = new RegExp(`^G (\\d+) ([0-9a-f]{${GRID_CELLS * 2}})$`);

export function parseSceneLines(lines: readonly string[]): { readonly screen: SceneFacts["screen"]; readonly samples: PointerSample[]; readonly changes: ChangedRegion[]; readonly brightness: BrightnessGrid[] } {
  let screen: SceneFacts["screen"] = null;
  const samples: PointerSample[] = [];
  const changes: ChangedRegion[] = [];
  const brightness: BrightnessGrid[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === "P" && parts[1] === "screen" && finiteNumbers(parts.slice(2, 4)) && parts.length >= 4) screen = { width: Number(parts[2]), height: Number(parts[3]) };
    else if (parts[0] === "P" && parts.length >= 5 && finiteNumbers(parts.slice(1, 5))) samples.push({ at: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]), buttons: Number(parts[4]) });
    else if (parts[0] === "C" && parts.length >= 6 && finiteNumbers(parts.slice(1, 6))) changes.push({ at: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]), width: Number(parts[4]), height: Number(parts[5]) });
    else {
      const grid = GRID_LINE.exec(line.trim());
      if (grid) brightness.push({ at: Number(grid[1]), cells: Array.from(Buffer.from(grid[2]!, "hex")) });
    }
  }
  return { screen, samples, changes, brightness };
}

export function parsePrepared(stdout: string): Prepared | null {
  const lines = stdout.trim().split(/\r?\n/);
  const head = lines.findIndex((line) => line.startsWith("{"));
  if (head < 0) return null;
  try {
    const value = JSON.parse(lines[head]!) as { ended: Prepared["ended"]; recorded: number; size: string; start: number | null; position?: string; cuts: [number, number][]; pointer?: string; lag?: number; luma?: number | null; keys?: string; agentcursor?: boolean };
    const [width, height] = value.size.split("x").map(Number);
    const rest = lines.slice(head + 1);
    const events = rest.flatMap((line): RecordEvent[] => {
      const [at, kind, encoded] = line.split("\t");
      if (!at || !encoded || (kind !== "step" && kind !== "pass" && kind !== "fail")) return [];
      return [{ at: Number(at), kind, text: Buffer.from(encoded, "base64").toString("utf8") }];
    });
    const sceneLines = parseSceneLines(rest);
    const scene: SceneFacts | undefined =
      value.pointer === undefined
        ? undefined
        : {
            pointer: (value.pointer === "drawn" ? "drawn" : "shown") as PointerMode,
            screen: sceneLines.screen,
            samples: sceneLines.samples,
            changes: sceneLines.changes,
            ...(sceneLines.brightness.length ? { brightness: sceneLines.brightness } : {}),
            luma: typeof value.luma === "number" ? value.luma : null,
            lag: typeof value.lag === "number" ? value.lag : 0,
            keys: value.keys === "mac" ? "mac" : "pc",
            agentCursor: value.agentcursor === true,
          };
    return { ended: value.ended, recorded: value.recorded, width: width ?? 0, height: height ?? 0, start: value.start, position: value.position === "bottom" ? "bottom" : "top", cuts: value.cuts, events, ...(scene ? { scene } : {}) };
  } catch {
    return null;
  }
}

export function withInputs(prepared: Prepared, inputs: readonly InputEvent[] | null): Prepared {
  return prepared.scene && inputs ? { ...prepared, scene: { ...prepared.scene, inputs } } : prepared;
}

export function driverDrawsAgentCursor(os: GuestOs): boolean {
  return os === "macos" || os === "windows";
}

export function withAgentCursorHidden(prepared: Prepared, hidden: boolean): Prepared {
  return hidden && prepared.scene ? { ...prepared, scene: { ...prepared.scene, agentCursor: false } } : prepared;
}

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

export type PillLook = StepKind | "mark" | "note" | "key";

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
  readonly fps: number;
  readonly scene: ScenePlan | null;
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

function pillClearOf(top: number, height: number, tall: number, gap: number, minY: number, maxY: number, fallback: number): number {
  const bottom = top + height;
  const below = bottom + gap;
  const above = top - gap - tall;
  if (below >= minY && below <= maxY) return Math.round(below);
  if (above >= minY && above <= maxY) return Math.round(above);
  const overlap = (y: number) => Math.max(0, Math.min(y + tall, bottom) - Math.max(y, top));
  const edge = overlap(maxY) < overlap(minY) ? maxY : minY;
  return Math.round(Number.isFinite(edge) ? edge : fallback);
}

export function planClip(prepared: Prepared, speed: RecordSpeed, options: SceneOptions = DEFAULT_SCENE_OPTIONS): ClipPlan {
  const layout = prepared.layout;
  const size = { width: prepared.width, height: prepared.height };
  const planned = prepared.scene && !layout && prepared.width > 0 && prepared.height > 0 ? planScene(prepared.scene, size, prepared.start ?? 0, prepared.recorded, options) : null;
  const scene = planned && (planned.art.length > 0 || planned.zooms) ? planned : null;
  const sorted = [...prepared.cuts].sort((a, b) => a[0] - b[0]);
  const cuts = planned ? keptMotion(sorted, planned.kept) : sorted;
  const removedBefore = (at: number) => cuts.reduce((sum, [from, to]) => sum + Math.max(0, Math.min(at, to) - from), 0);
  const onClip = (at: number) => (at - removedBefore(at)) / speed;
  const base = onClip(prepared.recorded);
  const start = prepared.start ?? 0;
  const placed = (real: number) => Math.min(base, Math.max(0, onClip(real)));
  const changes = [
    ...prepared.events.map((event) => {
      const real = Math.min(prepared.recorded, Math.max(0, event.at - start));
      return { kind: event.kind as StepKind | "note", text: captionText(event.text), real, at: placed(real) };
    }),
    ...(prepared.notes ?? []).map((note) => {
      const real = Math.min(prepared.recorded, Math.max(0, note.at));
      return { kind: "note" as const, text: captionText(note.text), real, at: placed(real) };
    }),
  ].sort((a, b) => a.at - b.at);
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
  const captions = changes.flatMap((change, index): Caption[] =>
    change.kind === "note" ? [] : [{ kind: change.kind, text: change.text, row: change.kind === "step" ? 0 : 1, from: round3(shownAt[index]!), to: round3(nextStep(index)), real: round3(change.real) }],
  );
  const framed = contentSize(size, !!scene?.frame);
  const width = layout ? prepared.width : framed.clip.width;
  const height = layout ? prepared.height : framed.clip.height;
  const inner = layout ? height : framed.content.height;
  const inset = layout ? 0 : framed.inset;
  const fontSize = layout?.fontSize ?? Math.max(14, Math.round(inner / 38));
  const pill = (size: number) => Math.round(size * 2.1);
  const gap = Math.max(4, Math.round(fontSize * 0.3));
  const edge = layout ? Math.round((layout.band.height - 2 * pill(fontSize) - gap) / 2) : Math.round(inner * 0.035);
  const dock = layout ? edge : Math.round(inner * 0.11);
  const position = prepared.position ?? "top";
  const captionY = (row: 0 | 1) =>
    layout ? layout.band.y + edge + row * (pill(fontSize) + gap) : position === "top" ? inset + edge + row * (pill(fontSize) + gap) : inset + inner - dock - (2 - row) * pill(fontSize) - (1 - row) * gap;
  const markSize = Math.max(11, Math.round(fontSize * 0.7));
  const markHeight = pill(markSize);
  const cornerY = position === "top" ? inset + inner - dock - markHeight : layout ? edge : inset + Math.round(inner * 0.05);
  const skipY = speed > 1 ? (position === "top" ? cornerY - markHeight - gap : cornerY + markHeight + gap) : cornerY;
  const noteY = layout ? (position === "top" ? layout.band.y + layout.band.height + gap : layout.band.y - gap - pill(fontSize)) : captionY(1);
  const finalAt = (at: number) => at + holds.filter((hold) => hold.at < at - 0.0005).reduce((sum, hold) => sum + hold.seconds, 0);
  const skips = cuts
    .filter(([from, to]) => to - from >= SKIP_MARK_S)
    .map(([from, to]): Overlay => {
      const shown = round3(finalAt(onClip(from)));
      return { look: "mark", text: skipWords(to - from), size: markSize, x: "right", y: skipY, from: shown, to: round3(Math.min(length, shown + MARK_SHOWN_S)) };
    });
  const notes = changes.flatMap((change, index): Overlay[] =>
    change.kind === "note" ? [{ look: "note", text: change.text, size: fontSize, x: "centre", y: noteY, from: round3(shownAt[index]!), to: round3(Math.min(length, shownAt[index]! + readingSeconds(change.text))) }] : [],
  );
  const keyPills = (planned?.pills ?? []).flatMap((each): Overlay[] => {
    const from = round3(finalAt(onClip(each.from)));
    const to = round3(Math.min(length, from + onClip(each.to) - onClip(each.from)));
    if (to - from < 0.2) return [];
    const at = pointerOnClip(planned!, each.from);
    const tall = pill(fontSize);
    const clear =
      position === "top"
        ? at && at.y > inner * 0.8
          ? captionY(1) + tall + gap
          : inset + inner - dock - tall
        : at && at.y < inner * 0.2
          ? captionY(0) - tall - gap
          : inset + edge;
    const bandTop = position === "top" ? captionY(1) + pill(fontSize) + gap : inset + edge;
    const bandBottom = position === "top" ? inset + inner - dock - tall : captionY(0) - gap - tall;
    const region = each.avoid && each.avoid.width > 0 && each.avoid.height > 0 ? areaOnClip(planned!, each.avoid, each.from) : null;
    const y = region ? pillClearOf(region.y + inset, region.height, tall, gap, Math.min(bandTop, bandBottom), Math.max(bandTop, bandBottom), clear) : clear;
    return [{ look: "key", text: each.text, size: fontSize, x: "centre", y, from, to }];
  });
  const overlays: Overlay[] = [
    ...captions.map((caption): Overlay => ({ look: caption.kind, text: caption.text, size: fontSize, x: "centre", y: captionY(caption.row), from: caption.from, to: caption.to })),
    ...(speed > 1 ? [{ look: "mark" as const, text: `${speed}x`, size: markSize, x: "right" as const, y: cornerY, from: 0, to: length }] : []),
    ...skips,
    ...notes,
    ...keyPills,
  ];
  const moves = !!scene && (scene.drawsPointer || scene.zooms || scene.pointer.rings.length > 0);
  return { speed, cuts, holds, captions, overlays, position, length, width, height, fontSize, edge: edge + inset, fps: moves ? CLIP_FPS : RECORD_FPS, scene };
}

const PILLS: Readonly<Record<PillLook, { readonly icon: string; readonly color: string; readonly fill: string; readonly alpha: number }>> = {
  step: { icon: "▶", color: "4f8df5", fill: "5f6368", alpha: 0.82 },
  pass: { icon: "✓", color: "34c759", fill: "2a2a2a", alpha: 0.94 },
  fail: { icon: "✗", color: "ff453a", fill: "2a2a2a", alpha: 0.94 },
  mark: { icon: "▶▶", color: "ffffff", fill: "1f1f1f", alpha: 0.88 },
  note: { icon: "⚠", color: "ff9f0a", fill: "2a2a2a", alpha: 0.94 },
  key: { icon: "⌨", color: "d0d0d4", fill: "1f1f1f", alpha: 0.9 },
};

export function clipGraph(plan: ClipPlan, withOverlays: boolean): string {
  const select = plan.cuts.length ? `select='not(${plan.cuts.map(([from, to]) => `between(t,${from.toFixed(3)},${to.toFixed(3)})`).join("+")})',` : "";
  const since = "(T-STARTT)";
  const removed = plan.cuts.map(([from, to]) => `clip(${since}-${from.toFixed(3)},0,${round3(to - from)})`).join("+");
  const clock = removed ? `(${since}-(${removed}))/${plan.speed}` : `${since}/${plan.speed}`;
  const pts = `'(${clock}${plan.holds.map((hold) => `+${hold.seconds}*gt(${clock},${hold.at})`).join("")})/TB'`;
  const timing = `${select}setpts=${pts},fps=${plan.fps},tpad=stop_mode=clone:stop_duration=${plan.length},trim=duration=${plan.length}`;
  const scene = plan.scene;
  const parts: string[] = [];
  let last: string;
  let firstPill = 1;
  if (scene) {
    const head = sceneHead(scene, 1);
    parts.push(head.graph, `[${head.last}]${timing}[t0]`);
    const corner = scene.art.findIndex((art) => art.name === "corner.png");
    const framed = frameTail(scene, "t0", 1 + corner, { width: plan.width, height: plan.height });
    if (framed.graph) parts.push(framed.graph);
    last = framed.last;
    firstPill = 1 + scene.art.length;
  } else {
    parts.push(`[0:v]${timing},scale='min(${CLIP_WIDTH},iw)':-2[v0]`);
    last = "v0";
  }
  if (!withOverlays || !plan.overlays.length) {
    if (!scene) return parts[0]!.replace(/\[v0\]$/, "[out]");
    parts.push(`[${last}]null[out]`);
    return parts.join(";\n");
  }
  plan.overlays.forEach((overlay, index) => {
    const x = overlay.x === "centre" ? "(W-w)/2" : `W-w-${plan.edge}`;
    const into = index === plan.overlays.length - 1 ? "out" : `p${index + 1}`;
    parts.push(`[${last}][${firstPill + index}:v]overlay=x=${x}:y=${overlay.y}:enable='between(t,${overlay.from},${overlay.to})'[${into}]`);
    last = into;
  });
  return scene ? parts.join(";\n") : parts.join(";").replace(/\[p(\d+)\]/g, "[v$1]");
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

export function pillFiles(plan: ClipPlan): number[] {
  const seen = new Map<string, number>();
  return plan.overlays.map((overlay, index) => {
    const key = `${overlay.look}\t${overlay.size}\t${overlay.text}`;
    const first = seen.get(key);
    if (first !== undefined) return first;
    seen.set(key, index);
    return index;
  });
}

function pillCalls(plan: ClipPlan, name: string): string[] {
  const files = pillFiles(plan);
  return plan.overlays.flatMap((overlay, index) => {
    if (files[index] !== index) return [];
    const look = PILLS[overlay.look];
    const encoded = Buffer.from(overlay.text).toString("base64");
    return [`${name} ${index} '${encoded}' '${Buffer.from(look.icon).toString("base64")}' '${look.color}' '${look.fill}' ${look.alpha} ${overlay.size}`];
  });
}

export function recordMakeScript(plan: ClipPlan, os: GuestOs = "linux"): string {
  if (os === "windows") return windowsMake(plan);
  const pills = pillCalls(plan, "pill");
  const files = pillFiles(plan);
  const inputs = files.map((file) => `-i "$d/pill-${file}.png"`).join(" ");
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
  measure() { ffmpeg -nostdin -hide_banner -v info -f lavfi -i color=s=16x16:d=0.1 -vf "drawtext=fontfile=$1:textfile=$2:expansion=none:fontsize=$3:x='print(tw)'" -frames:v 1 -f null - 2>&1 | awk '/^(\[Eval @ [^]]*\] )?[0-9.]+$/ { print int($NF + 0.5); exit }'; }
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
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
began=$(now)
captions=${plan.overlays.length ? "1" : "none"}
${pills.map((line) => `[ "$captions" = 0 ] || ${line} || captions=0`).join("\n")}
drawn=$(now)
${plan.scene ? sceneRun(plan, inputs) : `if [ "$captions" = 1 ]; then
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" ${inputs} -filter_complex "${clipGraph(plan, true)}" -map "[out]" ${CLIP} "$d/clip.mp4" || exit ${RECORD_STOP_EXITS.failed}
else
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" -filter_complex "${clipGraph(plan, false)}" -map "[out]" ${CLIP} "$d/clip.mp4" || exit ${RECORD_STOP_EXITS.failed}
fi`}
encoded=$(now)
seconds() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
recorded=$(seconds "$d/capture.mkv")
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/clip.mp4")
rm -f "$d/capture.mkv" "$d/events" "$d/pill.js" "$d/pointer" "$d/pointer.js" "$d/pointer.py" "$d/analysis.log" "$d/overlay.bundle" "$d/${GRID_FILE}"
find "$d" -maxdepth 1 \( -name 'pill-*' -o -name 'ring-*' -o -name '*.png' -o -name '*.cmd' -o -name '*.graph' \) -exec rm -f {} +
printf '{"ended":"stopped","recorded":%s,"clip":%s,"bytes":%s,"size":"%s","captions":%s,"drawing":%s,"encoding":%s}\n'   "$recorded" "$(seconds "$d/clip.mp4")" "$(wc -c <"$d/clip.mp4" | tr -d ' ')" "$size" "$(if [ "$captions" = 1 ]; then echo true; elif [ "$captions" = none ]; then echo null; else echo false; fi)" "$(awk -v a="$began" -v b="$drawn" 'BEGIN { printf "%.2f", b - a }')" "$(awk -v a="$drawn" -v b="$encoded" 'BEGIN { printf "%.2f", b - a }')"
`;
}

export const SCENE_BUNDLE = "overlay.bundle";

function sceneRun(plan: ClipPlan, pillInputs: string): string {
  const art = plan.scene!.art.map((each) => `-i ${each.name}`).join(" ");
  const pills = pillInputs.replaceAll('"$d/', '"');
  return String.raw`[ -s "$d/${SCENE_BUNDLE}" ] || { echo "The clip's drawing was not delivered to the box." >&2; exit ${RECORD_STOP_EXITS.failed}; }
D="$d" perl -MMIME::Base64 -ne 'chomp; my ($n, $b) = split /\t/, $_, 2; next unless defined $b && $n =~ /^[A-Za-z0-9._-]+$/; open(my $f, ">", "$ENV{D}/$n") or die "$n: $!\n"; binmode $f; print $f decode_base64($b); close $f' "$d/${SCENE_BUNDLE}" || exit ${RECORD_STOP_EXITS.failed}
major=$(ffmpeg -version | sed -n '1s/^ffmpeg version [^0-9]*\([0-9]*\).*/\1/p')
if [ "${"$"}{major:-0}" -ge 7 ]; then script="-/filter_complex"; else script="-filter_complex_script"; fi
cd "$d" || exit ${RECORD_STOP_EXITS.failed}
if [ "$captions" = 1 ]; then
  ffmpeg -nostdin -loglevel error -y -i capture.mkv ${art} ${pills} $script clip.graph -map "[out]" ${CLIP} clip.mp4 2>>log || { tail -n 5 log >&2; exit ${RECORD_STOP_EXITS.failed}; }
else
  ffmpeg -nostdin -loglevel error -y -i capture.mkv ${art} $script plain.graph -map "[out]" ${CLIP} clip.mp4 2>>log || { tail -n 5 log >&2; exit ${RECORD_STOP_EXITS.failed}; }
fi`;
}

export function sceneBundle(plan: ClipPlan): Buffer | null {
  return plan.scene ? bundle(plan.scene, [["clip.graph", clipGraph(plan, true)], ["plain.graph", clipGraph(plan, false)]]) : null;
}

/**
 * On Windows, in the desktop session, as gdigrab reads the desktop it runs
 * in. ddagrab needs a Direct3D 11 device, which a box drawn by WARP lacks.
 * ffmpeg gets a hidden console of its own, which the stop closes.
 */
const WINDOWS_DIR = String.raw`$d = Join-Path $HOME '${RECORD_DIR.replaceAll("/", "\\")}'
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
function Recording { if (Test-Path "$d\pid") { Get-Process -Id ([int](Get-Content "$d\pid" -Raw)) -ErrorAction Ignore | Where-Object ProcessName -eq ffmpeg } }
function Now { '{0:f3}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000) }`;

const WINDOWS_SAMPLER = String.raw`param($Out, $Limit)
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::InvariantCulture
Add-Type -Namespace BbBox -Name Pointer -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct Spot { public int X; public int Y; }
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetCursorPos(out Spot spot);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
'@
[void][BbBox.Pointer]::SetProcessDPIAware()
$writer = [IO.StreamWriter]::new($Out, $false)
$writer.AutoFlush = $true
$writer.WriteLine("screen $([BbBox.Pointer]::GetSystemMetrics(0)) $([BbBox.Pointer]::GetSystemMetrics(1))")
$end = [DateTime]::UtcNow.AddSeconds([double]$Limit)
$last = ''
$spot = New-Object BbBox.Pointer+Spot
while ([DateTime]::UtcNow -lt $end) {
  if ([BbBox.Pointer]::GetCursorPos([ref]$spot)) {
    $buttons = 0
    if ([BbBox.Pointer]::GetAsyncKeyState(1) -band 0x8000) { $buttons = $buttons -bor 1 }
    if ([BbBox.Pointer]::GetAsyncKeyState(4) -band 0x8000) { $buttons = $buttons -bor 2 }
    if ([BbBox.Pointer]::GetAsyncKeyState(2) -band 0x8000) { $buttons = $buttons -bor 4 }
    $now = "$($spot.X) $($spot.Y) $buttons"
    if ($now -ne $last) { $writer.WriteLine(('{0:f3} {1}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000), $now)); $last = $now }
  }
  Start-Sleep -Milliseconds ${Math.round(1000 / SAMPLER_HZ)}
}
`;

function windowsStart(position: CaptionPosition): string {
  return String.raw`${WINDOWS_DIR}
New-Item -ItemType Directory -Force $d | Out-Null
if (Recording) { exit ${RECORD_START_EXITS.running} }
$ffmpeg = (Get-Command ffmpeg -ErrorAction Ignore).Source
if (-not $ffmpeg) { [Console]::Error.WriteLine('ffmpeg'); exit ${RECORD_START_EXITS.noRecorder} }
if (Test-Path "$d\pointer.pid") { Stop-Process -Id ([int](Get-Content "$d\pointer.pid" -Raw)) -Force -ErrorAction Ignore }
Remove-Item "$d\capture.mkv", "$d\clip.mp4", "$d\log", "$d\events", "$d\pill-*", "$d\pointer", "$d\pointer.pid", "$d\pointer-mode", "$d\analysis.log", (Join-Path $d '${GRID_FILE}'), "$d\*.png", "$d\*.cmd", "$d\*.graph", "$d\*.bundle" -Force -ErrorAction Ignore
Set-Content "$d\position" '${position}'
[IO.File]::WriteAllText("$d\pointer.ps1", [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(WINDOWS_SAMPLER).toString("base64")}')))
$mode = 'shown'
$shell = (Get-Process -Id $PID).Path
$sampler = Start-Process $shell -WindowStyle Hidden -PassThru -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + "$d\pointer.ps1" + '" -Out "' + "$d\pointer" + '" -Limit ${RECORD_LIMIT_S}')
Set-Content "$d\pointer.pid" $sampler.Id
for ($i = 0; $i -lt 30 -and -not (Test-Path "$d\pointer") -and -not $sampler.HasExited; $i++) { Start-Sleep -Milliseconds 100 }
if ((Test-Path "$d\pointer") -and -not $sampler.HasExited) { $mode = 'drawn' } else { Stop-Process -Id $sampler.Id -Force -ErrorAction Ignore; Remove-Item "$d\pointer.pid", "$d\pointer" -ErrorAction Ignore }
Set-Content "$d\pointer-mode" $mode
$draw = if ($mode -eq 'drawn') { 0 } else { 1 }
Set-Content "$d\start" (Now)
$p = Start-Process $ffmpeg -WindowStyle Hidden -PassThru -RedirectStandardError "$d\log" -ArgumentList ('-nostdin -loglevel error -y -f gdigrab -framerate ${RECORD_FPS} -draw_mouse ' + $draw + ' -i desktop -t ${RECORD_LIMIT_S} -c:v libx264 -preset ultrafast -crf 0 "' + "$d\capture.mkv" + '"')
Set-Content "$d\pid" $p.Id
Start-Sleep -Milliseconds 500
if ($p.HasExited) { Remove-Item "$d\pid"; if (Test-Path "$d\pointer.pid") { Stop-Process -Id $sampler.Id -Force -ErrorAction Ignore }; Get-Content "$d\log" -Tail 3 | ForEach-Object { [Console]::Error.WriteLine($_) }; exit ${RECORD_START_EXITS.failed} }
exit ${RECORD_START_EXITS.started}
`;
}

function windowsStep(kind: StepKind, encoded: string): string {
  return String.raw`${WINDOWS_DIR}
if (-not (Recording)) { exit ${RECORD_STEP_EXITS.none} }
Add-Content "$d\events" ((Now) + "${"`"}t${kind}${"`"}t${encoded}")
exit ${RECORD_STEP_EXITS.saved}
`;
}

/**
 * The stop on Windows, in the desktop session: taskkill without /F closes
 * ffmpeg's console, and ffmpeg ends its file whole; /F would leave it
 * broken. A window's close does not reach another session.
 */
function windowsPrepare(stills: "cut" | "keep"): string {
  return String.raw`${WINDOWS_DIR}
$capture = "$d\capture.mkv"
$grid = Join-Path $d '${GRID_FILE}'
if (-not (Test-Path "$d\pid") -and -not (Test-Path $capture)) { exit ${RECORD_STOP_EXITS.none} }
$ended = 'limit'
$p = Recording
if ($p) {
  $ended = 'stopped'
  taskkill /PID $p.Id *> $null
  if (-not $p.WaitForExit(10000)) { taskkill /F /PID $p.Id *> $null }
}
Remove-Item "$d\pid" -ErrorAction Ignore
if (Test-Path "$d\pointer.pid") { Stop-Process -Id ([int](Get-Content "$d\pointer.pid" -Raw)) -Force -ErrorAction Ignore; Remove-Item "$d\pointer.pid" -ErrorAction Ignore }
if (-not (Test-Path $capture) -or -not (Get-Item $capture).Length) { Get-Content "$d\log" -Tail 3 -ErrorAction Ignore | ForEach-Object { [Console]::Error.WriteLine($_) }; exit ${RECORD_STOP_EXITS.failed} }
$recorded = [double](ffprobe -v error -show_entries format=duration -of csv=p=0 $capture)
$size = "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 $capture)".Trim()
$analysis = @(ffmpeg -nostdin -hide_banner -nostats -i $capture -filter_complex "${analysisGraph(stills)}" -map '[o]' -f null - -map '[grid]' -f rawvideo -pix_fmt gray $grid 2>&1)
if ($LASTEXITCODE) { $analysis = @(ffmpeg -nostdin -hide_banner -nostats -i $capture -vf ${FREEZE} -map 0:v -f null - 2>&1) }
$cuts = @()
if ('${stills}' -eq 'cut') {
  $still = $null
  foreach ($line in $analysis) {
    if ("$line" -match 'freeze_(start|end): ([\d.]+)') {
      $t = [double]$Matches[2]
      if ($Matches[1] -eq 'start') { $still = $t } elseif ($null -ne $still) { $cuts += '[{0:f3},{1:f3}]' -f ($still + 0.5), $t; $still = $null }
    }
  }
  if ($null -ne $still) { $cuts += '[{0:f3},{1:f3}]' -f ($still + 0.5), $recorded }
}
$factor = [double]$size.Split('x')[0] / ${CHANGES_WIDTH}
$changes = @()
$lumas = @()
foreach ($line in $analysis) {
  $text = "$line"
  if ($text -match 'Parsed_bbox.* pts_time:([\d.]+) x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)' -and $changes.Count -lt ${CHANGES_MOST}) {
    $x1 = [double]$Matches[2]; $x2 = [double]$Matches[3]; $y1 = [double]$Matches[4]; $y2 = [double]$Matches[5]
    $changes += 'C {0:f3} {1} {2} {3} {4}' -f [double]$Matches[1], [int]($x1 * $factor), [int]($y1 * $factor), [int](($x2 - $x1 + 1) * $factor), [int](($y2 - $y1 + 1) * $factor)
  } elseif ($text -match 'lavfi\.signalstats\.YAVG=([\d.]+)') { $lumas += [double]$Matches[1] }
}
$luma = if ($lumas.Count) { '{0:f1}' -f (($lumas | Measure-Object -Average).Average) } else { 'null' }
$mode = if (Test-Path "$d\pointer-mode") { (Get-Content "$d\pointer-mode" -Raw).Trim() } else { 'shown' }
$start = if (Test-Path "$d\start") { (Get-Content "$d\start" -Raw).Trim() } else { 'null' }
$position = if (Test-Path "$d\position") { (Get-Content "$d\position" -Raw).Trim() } else { 'top' }
'{{"ended":"{0}","recorded":{1},"size":"{2}","start":{3},"position":"{4}","cuts":[{5}],"pointer":"{6}","lag":${FIRST_FRAME_LAG_S.windows},"luma":{7},"keys":"pc","agentcursor":true}}' -f $ended, $recorded, $size, $start, $position, ($cuts -join ','), $mode, $luma
if (Test-Path "$d\events") { Get-Content "$d\events" }
if (Test-Path "$d\pointer") { Get-Content "$d\pointer" -TotalCount ${SAMPLES_MOST} | ForEach-Object { "P $_" } }
$changes
if (Test-Path $grid) {
  $cells = [IO.File]::ReadAllBytes($grid)
  for ($i = 0; $i + ${GRID_CELLS} -le $cells.Length -and $i / ${GRID_CELLS} -lt ${GRIDS_MOST}; $i += ${GRID_CELLS}) { 'G {0} {1}' -f ($i / ${GRID_CELLS}), [BitConverter]::ToString($cells, $i, ${GRID_CELLS}).Replace('-', '').ToLower() }
}
exit ${RECORD_STOP_EXITS.made}
`;
}

const WINDOWS_PILL = String.raw`function Decode($text) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($text)) }
function Color($hex, $alpha) { [Drawing.Color]::FromArgb([int](255 * $alpha), [Convert]::ToInt32($hex.Substring(0, 2), 16), [Convert]::ToInt32($hex.Substring(2, 2), 16), [Convert]::ToInt32($hex.Substring(4, 2), 16)) }
function Pill($index, $text, $icon, $iconHex, $fillHex, $alpha, $size) {
  $ErrorActionPreference = 'Stop'
  Add-Type -AssemblyName System.Drawing
  $label = Decode $text; $mark = Decode $icon; $fs = [int]$size
  $font = [Drawing.Font]::new('Segoe UI Semibold', $fs, [Drawing.GraphicsUnit]::Pixel)
  $iconFont = [Drawing.Font]::new('Segoe UI Symbol', $fs, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
  $format = [Drawing.StringFormat]::GenericTypographic
  $measure = [Drawing.Graphics]::FromImage([Drawing.Bitmap]::new(1, 1))
  $measure.TextRenderingHint = 'AntiAlias'
  $tw = [int][Math]::Ceiling($measure.MeasureString($label, $font, [Drawing.PointF]::Empty, $format).Width)
  $iw = [int][Math]::Ceiling($measure.MeasureString($mark, $iconFont, [Drawing.PointF]::Empty, $format).Width)
  $h = [int][Math]::Round($fs * 2.1); $pad = $fs; $gap = [int][Math]::Round($fs * 0.6); $w = $pad + $iw + $gap + $tw + $pad
  $bitmap = [Drawing.Bitmap]::new($w, $h, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [Drawing.Graphics]::FromImage($bitmap)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'; $g.TextRenderingHint = 'AntiAlias'
  $capsule = [Drawing.Drawing2D.GraphicsPath]::new()
  $capsule.AddArc(0, 0, $h, $h, 90, 180); $capsule.AddArc($w - $h, 0, $h, $h, 270, 180); $capsule.CloseFigure()
  $g.FillPath([Drawing.SolidBrush]::new((Color $fillHex ([double]$alpha))), $capsule)
  $capHeight = $fs * 0.7
  function Top($f) { ($h + $capHeight) / 2 - $fs * $f.FontFamily.GetCellAscent('Regular') / $f.FontFamily.GetEmHeight('Regular') }
  $g.DrawString($mark, $iconFont, [Drawing.SolidBrush]::new((Color $iconHex 1)), [float]$pad, [float](Top $iconFont), $format)
  $g.DrawString($label, $font, [Drawing.Brushes]::White, [float]($pad + $iw + $gap), [float](Top $font), $format)
  $bitmap.Save("$d\pill-$index.png", [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bitmap.Dispose()
}`;

function windowsMake(plan: ClipPlan): string {
  const inputs = pillFiles(plan).map((file) => `-i "$d\\pill-${file}.png"`).join(" ");
  return String.raw`${WINDOWS_DIR}
$capture = "$d\capture.mkv"
if (-not (Test-Path $capture)) { exit ${RECORD_STOP_EXITS.none} }
${WINDOWS_PILL}
function Seconds($file) { [double](ffprobe -v error -show_entries format=duration -of csv=p=0 $file) }
$began = [DateTime]::UtcNow
$captions = '${plan.overlays.length ? "1" : "none"}'
if ($captions -eq '1') {
  try {
${pillCalls(plan, "    Pill").join("\n")}
  } catch {
    Add-Content "$d\log" "$_"
    $captions = '0'
  }
}
$drawnAt = [DateTime]::UtcNow
${plan.scene ? windowsSceneRun(plan) : `if ($captions -eq '1') {
  ffmpeg -nostdin -loglevel error -y -i $capture ${inputs} -filter_complex "${clipGraph(plan, true)}" -map '[out]' ${CLIP} "$d\\clip.mp4" 2>> "$d\\log"
} else {
  ffmpeg -nostdin -loglevel error -y -i $capture -filter_complex "${clipGraph(plan, false)}" -map '[out]' ${CLIP} "$d\\clip.mp4" 2>> "$d\\log"
}`}
if ($LASTEXITCODE) { Get-Content "$d\log" -Tail 3 -ErrorAction Ignore | ForEach-Object { [Console]::Error.WriteLine($_) }; exit ${RECORD_STOP_EXITS.failed} }
$encodedAt = [DateTime]::UtcNow
$recorded = Seconds $capture
$size = "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d\clip.mp4")".Trim()
Remove-Item $capture, "$d\events", "$d\pill-*", "$d\pointer", "$d\pointer.ps1", "$d\analysis.log", (Join-Path $d '${GRID_FILE}'), "$d\*.png", "$d\*.cmd", "$d\*.graph", "$d\*.bundle" -Force -ErrorAction Ignore
$drawn = switch ($captions) { '1' { 'true' } 'none' { 'null' } default { 'false' } }
'{{"ended":"stopped","recorded":{0},"clip":{1},"bytes":{2},"size":"{3}","captions":{4},"drawing":{5:f2},"encoding":{6:f2}}}' -f $recorded, (Seconds "$d\clip.mp4"), (Get-Item "$d\clip.mp4").Length, $size, $drawn, ($drawnAt - $began).TotalSeconds, ($encodedAt - $drawnAt).TotalSeconds
exit ${RECORD_STOP_EXITS.made}
`;
}

function windowsSceneRun(plan: ClipPlan): string {
  const art = plan.scene!.art.map((each) => `-i ${each.name}`).join(" ");
  const pills = pillFiles(plan).map((file) => `-i pill-${file}.png`).join(" ");
  return String.raw`$bundle = Join-Path $d '${SCENE_BUNDLE}'
if (-not (Test-Path $bundle)) { [Console]::Error.WriteLine("The clip's drawing was not delivered to the box."); exit ${RECORD_STOP_EXITS.failed} }
foreach ($line in [IO.File]::ReadAllLines($bundle)) {
  $name, $data = $line -split "${"`"}t", 2
  if ($data -and $name -match '^[A-Za-z0-9._-]+$') { [IO.File]::WriteAllBytes((Join-Path $d $name), [Convert]::FromBase64String($data)) }
}
Push-Location $d
if ($captions -eq '1') { ffmpeg -nostdin -loglevel error -y -i capture.mkv ${art} ${pills} -/filter_complex clip.graph -map '[out]' ${CLIP} clip.mp4 2>> log }
else { ffmpeg -nostdin -loglevel error -y -i capture.mkv ${art} -/filter_complex plain.graph -map '[out]' ${CLIP} clip.mp4 2>> log }
$made = $LASTEXITCODE
Pop-Location
$global:LASTEXITCODE = $made`;
}

/** What the stop script says of the clip. */
export interface RecordResult {
  readonly ended: "stopped" | "limit";
  readonly recorded: number;
  readonly clip: number;
  readonly bytes: number;
  readonly size: string;
  readonly captions?: boolean | null;
  readonly drawing?: number;
  readonly encoding?: number;
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

export function boxClockScript(os: GuestOs): string {
  return os === "windows" ? "'{0:f3}' -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000)" : "perl -MTime::HiRes=time -e 'printf \"%.3f\\n\", time'";
}

export interface ClockReading {
  readonly before: number;
  readonly after: number;
  readonly box: number;
}

export function clockOffset(readings: readonly ClockReading[]): number | null {
  const usable = readings.filter((reading) => Number.isFinite(reading.box) && reading.box > 0 && reading.after >= reading.before);
  if (!usable.length) return null;
  const best = usable.reduce((a, b) => (b.after - b.before < a.after - a.before ? b : a));
  return Math.round(best.box * 1000 - (best.before + best.after) / 2);
}
