// A desktop box records its own screen, for an agent to show its work in the
// thread (059). On X11, ffmpeg's x11grab, with the ffmpeg the desktop images
// have; on Wayland, wf-recorder, which the Wayland images have from their
// rebuild after #707. A recording runs in a session of its
// own, so it outlives the command that started it, and ends by itself at
// RECORD_LIMIT_S. Stopping it makes the clip in the box: still stretches cut
// to a short pause, an optional speed, and an H.264 MP4, which a small page
// beside it plays in the thread's inline preview.

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

/**
 * Starts recording the desktop, in the background, for at most
 * RECORD_LIMIT_S. On Wayland, wf-recorder runs with --no-damage: tracking
 * damage, it records no frame while the screen is still, and does not see
 * a stop until the screen changes. It copies frames all the while, about
 * two thirds of a core, against a tenth for x11grab. timeout ends it at
 * the limit, and passes a stop's SIGTERM on to it.
 */
export function recordStartScript(): string {
  return String.raw`d="$HOME/${RECORD_DIR}"; mkdir -p "$d"
if [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit ${RECORD_START_EXITS.running}; fi
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
rm -f "$d/capture.mkv" "$d/clip.mp4" "$d/log"
if [ -n "${"$"}{WAYLAND_DISPLAY:-}" ]; then
  command -v wf-recorder >/dev/null || exit ${RECORD_START_EXITS.noRecorder}
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

/**
 * Stops the recording, or takes one that ended at its limit, and makes the
 * clip. Still stretches over 1 s keep 0.5 s each unless `stills` is
 * "keep". Prints one line of JSON: how the recording ended, the seconds
 * recorded and in the clip, the clip's bytes and size.
 */
export function recordStopScript(options: { speed: RecordSpeed; stills: "cut" | "keep" }): string {
  return String.raw`d="$HOME/${RECORD_DIR}"
[ -s "$d/pid" ] || [ -s "$d/capture.mkv" ] || exit ${RECORD_STOP_EXITS.none}
ended=limit
if [ -s "$d/pid" ]; then
  pid=$(cat "$d/pid")
  if kill -0 "$pid" 2>/dev/null; then
    ended=stopped
    # ffmpeg ends a file whole on SIGTERM; a command started with &
    # ignores SIGINT.
    kill -TERM "$pid"
    for i in $(seq 1 100); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  fi
  rm -f "$d/pid"
fi
[ -s "$d/capture.mkv" ] || { tail -n 3 "$d/log" >&2; exit ${RECORD_STOP_EXITS.failed}; }
seconds() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
recorded=$(seconds "$d/capture.mkv")
keep=
if [ "${options.stills}" = cut ]; then
  # Each stretch with no change for over 1 s keeps its first 0.5 s. At
  # n=0.0001 a few typed characters count as change on a 1080p screen and
  # a blinking cursor does not; ffmpeg's default, 0.001, cut typing too.
  keep=$(ffmpeg -nostdin -hide_banner -i "$d/capture.mkv" -vf freezedetect=n=0.0001:d=1 -map 0:v -f null - 2>&1 |
    awk -v end="$recorded" '/freeze_start:/ { s = $NF } /freeze_end:/ { printf "%sbetween(t,%.3f,%.3f)", sep, s + 0.5, $NF; sep = "+"; s = "" }
      END { if (s != "") printf "%sbetween(t,%.3f,%.3f)", sep, s + 0.5, end }')
fi
select=; [ -z "$keep" ] || select="select='not($keep)',"
make() {
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" \
    -vf "${"$"}{select}setpts=N/(${RECORD_FPS}*${options.speed})/TB,fps=${RECORD_FPS},scale='min(1280,iw)':-2" \
    -an -c:v libx264 -preset medium -crf 28 -tune animation -pix_fmt yuv420p -movflags +faststart "$d/clip.mp4"
}
make || exit ${RECORD_STOP_EXITS.failed}
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/clip.mp4")
rm -f "$d/capture.mkv"
printf '{"ended":"%s","recorded":%s,"clip":%s,"bytes":%s,"size":"%s"}\n' \
  "$ended" "$recorded" "$(seconds "$d/clip.mp4")" "$(stat -c %s "$d/clip.mp4")" "$size"
`;
}

/** What the stop script says of the clip. */
export interface RecordResult {
  readonly ended: "stopped" | "limit";
  readonly recorded: number;
  readonly clip: number;
  readonly bytes: number;
  readonly size: string;
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
export function recordPage(title: string, mp4: string): string {
  const escape = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>
<body style="margin:0;background:#111"><video src="${escape(encodeURIComponent(mp4))}" autoplay muted loop controls playsinline style="display:block;width:100%;height:auto"></video></body>
`;
}

/** The preview's height in BB, for a clip of `size` (WxH) shown about 640 wide. */
export function previewHeight(size: string): number {
  const [width, height] = size.split("x").map(Number);
  if (!width || !height) return 400;
  return Math.max(120, Math.min(1200, Math.round((640 * height) / width) + 8));
}
