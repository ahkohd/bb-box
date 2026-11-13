import { PRODUCT } from "../brand.ts";
import type { Arch, GuestOs } from "../transports/types.ts";

export type FetchedOs = Exclude<GuestOs, "windows">;

export interface FfmpegDownload {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly unpack: "tar.xz" | "zip";
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
}

export interface FfmpegBuild {
  readonly os: FetchedOs;
  readonly arch: Arch;
  readonly version: string;
  readonly from: string;
  readonly licence: string;
  readonly downloads: readonly FfmpegDownload[];
}

const BTBN_TAG = "autobuild-2026-09-30-13-08";
const BTBN_RELEASE = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BTBN_TAG}`;
const BTBN_BUILD = "ffmpeg-n9.0.2-17-g2a571b6068";
const RIEDL_RELEASE = "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2";

function btbnLinux(arch: Arch, flavour: string, sha256: string, bytes: number): FfmpegBuild {
  const folder = `${BTBN_BUILD}-${flavour}-gpl-9.0`;
  return {
    os: "linux",
    arch,
    version: "9.0.2",
    from: `BtbN's FFmpeg-Builds on GitHub, release ${BTBN_TAG}`,
    licence: "GPL version 3",
    downloads: [{ url: `${BTBN_RELEASE}/${folder}.tar.xz`, sha256, bytes, unpack: "tar.xz", ffmpeg: `${folder}/bin/ffmpeg`, ffprobe: `${folder}/bin/ffprobe` }],
  };
}

export const FFMPEG_BUILDS: readonly FfmpegBuild[] = [
  btbnLinux("x86_64", "linux64", "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269", 151_017_172),
  btbnLinux("arm64", "linuxarm64", "91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46", 127_445_692),
  {
    os: "macos",
    arch: "arm64",
    version: "9.0.2",
    from: "Martin Riedl's FFmpeg builds for macOS, release 1789931890_9.0.2",
    licence: "GPL version 3",
    downloads: [
      { url: `${RIEDL_RELEASE}/ffmpeg.zip`, sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924", bytes: 28_395_699, unpack: "zip", ffmpeg: "ffmpeg" },
      { url: `${RIEDL_RELEASE}/ffprobe.zip`, sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6", bytes: 28_317_701, unpack: "zip", ffprobe: "ffprobe" },
    ],
  },
];

export const CLIP_FFMPEG_DIR = ".bb-box/ffmpeg";

export const CLIP_FFMPEG_EXITS = { ready: 0, noBuild: 4, fetchFailed: 5, mismatch: 6, broken: 7, publishFailed: 8, untrusted: 9, noneFit: 10 } as const;

export type ClipFfmpegMode = "fetch" | "choose";

export const CLIP_FILTERS = ["overlay", "geq", "freezedetect", "tpad"] as const;

export const PAIR_DOES_NOT_WORK = "broken";

const CHECK_LIMIT_S = 30;

export function clipFilters(os: FetchedOs): readonly string[] {
  return os === "linux" ? [...CLIP_FILTERS, "drawtext"] : CLIP_FILTERS;
}

export interface ClipFfmpegPair {
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

export interface ClipFfmpeg {
  readonly ffmpeg: "own" | "fetched" | "kept";
  readonly version: string;
  readonly seconds: number;
  readonly missing: readonly string[];
  readonly pair: ClipFfmpegPair;
}

function shellQuoted(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function useClipFfmpeg(pair: ClipFfmpegPair | null): string {
  if (!pair) return "";
  return `ffmpeg() { ${shellQuoted(pair.ffmpeg)} "$@"; }\nffprobe() { ${shellQuoted(pair.ffprobe)} "$@"; }`;
}

function buildId(build: FfmpegBuild): string {
  return build.downloads.map((download) => download.sha256.slice(0, 12)).join("-");
}

function unpackLines(download: FfmpegDownload): string {
  const members = [download.ffmpeg, download.ffprobe].filter((member): member is string => !!member);
  const quoted = members.map((member) => `'${member}'`).join(" ");
  const extract = download.unpack === "zip" ? `unzip -q -o "$work/get" ${quoted} -d "$work/out"` : `tar -xJf "$work/get" -C "$work/out" ${quoted}`;
  const moves = [download.ffmpeg ? `mv "$work/out/${download.ffmpeg}" "$work/bin/ffmpeg"` : "", download.ffprobe ? `mv "$work/out/${download.ffprobe}" "$work/bin/ffprobe"` : ""].filter(Boolean);
  return [
    `    curl -fsSL --retry 2 -o "$work/get" '${download.url}' 2>"$work/curl.log" || { echo "${PRODUCT} could not fetch ${download.url}: $(tail -n 1 "$work/curl.log")" >&2; exit ${CLIP_FFMPEG_EXITS.fetchFailed}; }`,
    `    [ "$(sum256 "$work/get")" = '${download.sha256}' ] || { echo "${download.url} did not match its SHA-256, so ${PRODUCT} did not use it." >&2; exit ${CLIP_FFMPEG_EXITS.mismatch}; }`,
    `    mkdir -p "$work/out" && ${extract} && ${moves.join(" && ")} || { echo "${PRODUCT} could not unpack ${download.url}." >&2; exit ${CLIP_FFMPEG_EXITS.broken}; }`,
    `    rm -rf "$work/get" "$work/out"`,
  ].join("\n");
}

const UNAME_SYSTEM: Readonly<Record<FetchedOs, string>> = { linux: "Linux", macos: "Darwin" };
const UNAME_MACHINES: Readonly<Record<Arch, readonly string[]>> = { x86_64: ["x86_64", "amd64"], arm64: ["aarch64", "arm64"] };

function unamePattern(build: FfmpegBuild): string {
  return UNAME_MACHINES[build.arch].map((machine) => `${UNAME_SYSTEM[build.os]}/${machine}`).join("|");
}

function buildBranch(build: FfmpegBuild): string {
  return `  ${unamePattern(build)})
  version='${build.version}'; id='${buildId(build)}'
  download() {
${build.downloads.map(unpackLines).join("\n")}
  }
  ;;`;
}

function pairChecks(os: FetchedOs): string {
  return String.raw`bounded() { perl -e 'alarm shift; exec @ARGV or exit 127' ${CHECK_LIMIT_S} "$@"; }
missing_in() {
  filters=$(bounded "$1" -hide_banner -filters 2>/dev/null) || { printf 'ffmpeg'; return; }
  encoders=$(bounded "$1" -hide_banner -encoders 2>/dev/null)
  out=
  printf '%s\n' "$encoders" | grep -q ' libx264 ' || out="libx264"
  for f in ${clipFilters(os).join(" ")}; do printf '%s\n' "$filters" | grep -q " $f " || out="$out${"$"}{out:+ }$f"; done
  printf '%s' "$out"
}
works() {
  [ -n "$1" ] && [ -n "$2" ] && [ -z "$(missing_in "$1")" ] || return 1
  t=$(mktemp -d "${"$"}{TMPDIR:-/tmp}/bb-box-ffmpeg.XXXXXX") || return 1
  bounded "$1" -nostdin -v error -y -f lavfi -i color=s=16x16:d=0.2:r=5 -frames:v 1 -c:v libx264 -pix_fmt yuv420p "$t/smoke.mkv" </dev/null >/dev/null 2>&1 &&
    [ "$(bounded "$2" -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$t/smoke.mkv" 2>/dev/null)" = h264 ]
  ok=$?
  rm -rf "$t"
  return $ok
}
sum256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }
private_dir() { [ -d "$1" ] && [ ! -L "$1" ] && [ -O "$1" ]; }
sums_hold() { [ -s "$1/sums" ] && [ "$(sum256 "$1/ffmpeg") $(sum256 "$1/ffprobe")" = "$(cat "$1/sums")" ]; }
cached_works() { private_dir "$1" && [ ! -L "$1/ffmpeg" ] && [ ! -L "$1/ffprobe" ] && sums_hold "$1" && works "$1/ffmpeg" "$1/ffprobe"; }`;
}

const PUBLISH = String.raw`  work=$(mktemp -d "$base/fetch.XXXXXX") || exit ${CLIP_FFMPEG_EXITS.publishFailed}
  trap 'rm -rf "$work"' EXIT
  mkdir "$work/bin" || exit ${CLIP_FFMPEG_EXITS.publishFailed}
  download
  chmod 755 "$work/bin/ffmpeg" "$work/bin/ffprobe" || exit ${CLIP_FFMPEG_EXITS.broken}
  works "$work/bin/ffmpeg" "$work/bin/ffprobe" || { echo "ffmpeg $version from ${PRODUCT}'s pinned build does not make a clip there: it lacks $(missing_in "$work/bin/ffmpeg"), or it or its ffprobe did not run." >&2; exit ${CLIP_FFMPEG_EXITS.broken}; }
  printf '%s %s\n' "$(sum256 "$work/bin/ffmpeg")" "$(sum256 "$work/bin/ffprobe")" >"$work/bin/sums" || { echo "${PRODUCT} could not write ffmpeg's checksums in $base." >&2; exit ${CLIP_FFMPEG_EXITS.publishFailed}; }
  target="$base/$id"; aside="$base/$id.old.$$"
  if [ -e "$target" ] || [ -L "$target" ]; then mv "$target" "$aside" || { echo "${PRODUCT} could not move the unusable ffmpeg in $target aside." >&2; exit ${CLIP_FFMPEG_EXITS.publishFailed}; }; fi
  if ! mv "$work/bin" "$target"; then
    [ ! -e "$aside" ] || mv "$aside" "$target"
    echo "${PRODUCT} could not put ffmpeg $version in place in $base." >&2
    exit ${CLIP_FFMPEG_EXITS.publishFailed}
  fi
  if ! cached_works "$target"; then
    rm -rf "$target"
    [ ! -e "$aside" ] || mv "$aside" "$target"
    echo "ffmpeg $version did not work once in place in $base." >&2
    exit ${CLIP_FFMPEG_EXITS.publishFailed}
  fi
  rm -rf "$aside"`;

export function clipFfmpegScript(os: FetchedOs, builds: readonly FfmpegBuild[] = FFMPEG_BUILDS, mode: ClipFfmpegMode = "fetch"): string {
  return String.raw`base="$HOME/${CLIP_FFMPEG_DIR}"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
began=$(now)
${pairChecks(os)}
said() { printf '{"ffmpeg":"%s","version":"%s","seconds":%s,"missing":"%s","path":"%s","probe":"%s"}\n' "$1" "$(bounded "$2" -hide_banner -version 2>/dev/null | sed -n '1s/^ffmpeg version [^0-9]*\([0-9][0-9.]*\).*/\1/p')" "$(awk -v a="$began" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')" "$4" "$2" "$3"; }
own=$(command -v ffmpeg 2>/dev/null || true)
probe=$(command -v ffprobe 2>/dev/null || true)
missing=ffmpeg
if [ -n "$own" ]; then
  missing=$(missing_in "$own")
  [ -n "$probe" ] || missing="$missing${"$"}{missing:+ }ffprobe"
  if [ -z "$missing" ]; then
    if works "$own" "$probe"; then said own "$own" "$probe" ""; exit 0; fi
    missing=${PAIR_DOES_NOT_WORK}
  fi
fi
id=
case "$(uname -s)/$(uname -m)" in
${builds.map(buildBranch).join("\n")}
esac
mkdir -p "$base" 2>/dev/null
if ! private_dir "$HOME/.bb-box" || ! private_dir "$base" || ! chmod 700 "$base"; then
  echo "$base is a link, or not the box user's, so ${PRODUCT} does not keep ffmpeg there. Remove it, then start again." >&2
  exit ${CLIP_FFMPEG_EXITS.untrusted}
fi
if [ -n "$id" ] && cached_works "$base/$id"; then said kept "$base/$id/ffmpeg" "$base/$id/ffprobe" ""; exit 0; fi
code=${CLIP_FFMPEG_EXITS.noBuild}
[ ${mode} = fetch ] || code=${CLIP_FFMPEG_EXITS.noneFit}
if [ -n "$id" ] && [ ${mode} = fetch ]; then
  (
${PUBLISH}
  )
  code=$?
  if [ "$code" = 0 ]; then
    find "$base" -mindepth 1 -maxdepth 1 ! -name "$id" ! -name 'fetch.*' -exec rm -rf {} + 2>/dev/null
    find "$base" -mindepth 1 -maxdepth 1 -name 'fetch.*' -mmin +30 -exec rm -rf {} + 2>/dev/null
    said fetched "$base/$id/ffmpeg" "$base/$id/ffprobe" "$missing"
    exit 0
  fi
fi
for earlier in $(find "$base" -mindepth 1 -maxdepth 1 -type d ! -name 'fetch.*' ! -name '*.old.*' 2>/dev/null); do
  if cached_works "$earlier"; then said kept "$earlier/ffmpeg" "$earlier/ffprobe" "$missing"; exit 0; fi
done
[ "$code" != ${CLIP_FFMPEG_EXITS.noBuild} ] && [ "$code" != ${CLIP_FFMPEG_EXITS.noneFit} ] || echo "$missing" >&2
exit $code
`;
}

export function parseClipFfmpeg(stdout: string): ClipFfmpeg | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as { ffmpeg?: unknown; version?: unknown; seconds?: unknown; missing?: unknown; path?: unknown; probe?: unknown };
    if (value.ffmpeg !== "own" && value.ffmpeg !== "fetched" && value.ffmpeg !== "kept") return null;
    if (typeof value.path !== "string" || !value.path.startsWith("/") || typeof value.probe !== "string" || !value.probe.startsWith("/")) return null;
    return {
      ffmpeg: value.ffmpeg,
      version: typeof value.version === "string" ? value.version : "",
      seconds: typeof value.seconds === "number" ? value.seconds : 0,
      missing: typeof value.missing === "string" && value.missing ? value.missing.split(" ") : [],
      pair: { ffmpeg: value.path, ffprobe: value.probe },
    };
  } catch {
    return null;
  }
}

export function buildFor(os: GuestOs, arch: Arch, builds: readonly FfmpegBuild[] = FFMPEG_BUILDS): FfmpegBuild | null {
  return builds.find((build) => build.os === os && build.arch === arch) ?? null;
}

export function fetchSize(build: FfmpegBuild): string {
  const bytes = build.downloads.reduce((sum, download) => sum + download.bytes, 0);
  return `${Math.round(bytes / 1_000_000)} MB`;
}
