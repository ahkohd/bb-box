export const PROBE_SECONDS = 15;
const PROBE_SETTLE_SECONDS = 4;
const PROBE_ENCODERS = 2;
const PROBE_SIZE = "1206x2622";
const PROBE_CLIP_FRAMES = 30;

export function encoderProbeScript(): string {
  const counted = PROBE_SECONDS - PROBE_SETTLE_SECONDS;
  return `command -v ffmpeg >/dev/null 2>&1 || { echo no-ffmpeg; exit 0; }
t=$(mktemp -d) || exit 4
pids=
trap 'for p in $pids; do kill "$p" 2>/dev/null; done; rm -rf "$t"' EXIT
ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc2=size=${PROBE_SIZE}:rate=60 -frames:v ${PROBE_CLIP_FRAMES} -pix_fmt nv12 -f rawvideo -y "$t/clip.yuv" || exit 4
i=0
while [ "$i" -lt ${PROBE_ENCODERS} ]; do
  i=$((i + 1))
  ffmpeg -hide_banner -nostats -loglevel error -stream_loop -1 -f rawvideo -pix_fmt nv12 -s ${PROBE_SIZE} -framerate 60 -i "$t/clip.yuv" -c:v h264_videotoolbox -allow_sw 0 -b:v 8M -progress "$t/p$i" -stats_period 0.5 -f null - </dev/null >/dev/null 2>"$t/e$i" &
  pids="$pids $!"
done
frames() { sed -n 's/^frame=//p' "$1" 2>/dev/null | tail -n 1; }
sleep ${PROBE_SETTLE_SECONDS}
i=0; while [ "$i" -lt ${PROBE_ENCODERS} ]; do i=$((i + 1)); eval "a$i=$(frames "$t/p$i")"; done
sleep ${counted}
i=0
while [ "$i" -lt ${PROBE_ENCODERS} ]; do
  i=$((i + 1))
  eval "a=\\$a$i"
  b=$(frames "$t/p$i")
  [ -n "$a" ] && [ -n "$b" ] || { echo "encoder=$i failed: $(tail -n 1 "$t/e$i")"; continue; }
  echo "encoder=$i frames=$((b - a)) seconds=${counted}"
done
`;
}

export function parseEncoderProbe(stdout: string): { readonly fps: number | null; readonly words: string | null } {
  if (/^no-ffmpeg$/m.test(stdout)) return { fps: null, words: "ffmpeg is not installed there" };
  const counts = [...stdout.matchAll(/^encoder=\d+ frames=(\d+) seconds=(\d+)$/gm)].map((match) => Number(match[1]) / Number(match[2]));
  const failed = /^encoder=\d+ failed: (.*)$/m.exec(stdout)?.[1];
  if (counts.length !== PROBE_ENCODERS) return { fps: null, words: failed ? `ffmpeg's h264_videotoolbox did not run: ${failed}` : "the probe gave no frame counts" };
  return { fps: counts.reduce((sum, each) => sum + each, 0), words: null };
}
