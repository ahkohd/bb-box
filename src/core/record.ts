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
export function recordStartScript(os: GuestOs = "linux"): string {
  if (os === "windows") return windowsStart();
  return String.raw`d="$HOME/${RECORD_DIR}"; mkdir -p "$d"
if [ -s "$d/pid" ] && kill -0 "$(cat "$d/pid")" 2>/dev/null; then exit ${RECORD_START_EXITS.running}; fi
set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
rm -f "$d/capture.mkv" "$d/clip.mp4" "$d/log"
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

/**
 * Stops the recording, or takes one that ended at its limit, and makes the
 * clip. Still stretches over 1 s keep 0.5 s each unless `stills` is
 * "keep". Prints one line of JSON: how the recording ended, the seconds
 * recorded and in the clip, the clip's bytes and size.
 */
export function recordStopScript(options: { speed: RecordSpeed; stills: "cut" | "keep"; os?: GuestOs }): string {
  if (options.os === "windows") return windowsStop(options);
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
  keep=$(ffmpeg -nostdin -hide_banner -i "$d/capture.mkv" -vf ${FREEZE} -map 0:v -f null - 2>&1 |
    awk -v end="$recorded" '/freeze_start:/ { s = $NF } /freeze_end:/ { printf "%sbetween(t,%.3f,%.3f)", sep, s + 0.5, $NF; sep = "+"; s = "" }
      END { if (s != "") printf "%sbetween(t,%.3f,%.3f)", sep, s + 0.5, end }')
fi
select=; [ -z "$keep" ] || select="select='not($keep)',"
make() {
  ffmpeg -nostdin -loglevel error -y -i "$d/capture.mkv" \
    -vf "${"$"}{select}setpts=N/(${RECORD_FPS}*${options.speed})/TB,fps=${RECORD_FPS},scale='min(1280,iw)':-2" \
    ${CLIP} "$d/clip.mp4"
}
make || exit ${RECORD_STOP_EXITS.failed}
size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$d/clip.mp4")
rm -f "$d/capture.mkv"
printf '{"ended":"%s","recorded":%s,"clip":%s,"bytes":%s,"size":"%s"}\n' \
  "$ended" "$recorded" "$(seconds "$d/clip.mp4")" "$(wc -c <"$d/clip.mp4" | tr -d ' ')" "$size"
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
