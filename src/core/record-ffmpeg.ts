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
export const CLIP_FFMPEG_BIN = `${CLIP_FFMPEG_DIR}/bin`;

export const FETCHED_FFMPEG_FIRST_ON_PATH = `[ ! -x "$HOME/${CLIP_FFMPEG_BIN}/ffmpeg" ] || PATH="$HOME/${CLIP_FFMPEG_BIN}:$PATH"; export PATH`;

export const CLIP_FFMPEG_EXITS = { ready: 0, noBuild: 4, fetchFailed: 5, mismatch: 6, broken: 7 } as const;

export const CLIP_FILTERS = ["overlay", "geq", "freezedetect", "tpad"] as const;

export function clipFilters(os: FetchedOs): readonly string[] {
  return os === "linux" ? [...CLIP_FILTERS, "drawtext"] : CLIP_FILTERS;
}

export interface ClipFfmpeg {
  readonly ffmpeg: "own" | "fetched" | "kept";
  readonly version: string;
  readonly seconds: number;
  readonly missing: readonly string[];
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
    `  curl -fsSL --retry 2 -o "$work/get" '${download.url}' 2>"$work/curl.log" || { echo "${PRODUCT} could not fetch ${download.url}: $(tail -n 1 "$work/curl.log")" >&2; exit ${CLIP_FFMPEG_EXITS.fetchFailed}; }`,
    `  [ "$(sum256 "$work/get")" = '${download.sha256}' ] || { echo "${download.url} did not match its SHA-256, so ${PRODUCT} did not use it." >&2; exit ${CLIP_FFMPEG_EXITS.mismatch}; }`,
    `  mkdir -p "$work/out" && ${extract} && ${moves.join(" && ")} || { echo "${PRODUCT} could not unpack ${download.url}." >&2; exit ${CLIP_FFMPEG_EXITS.broken}; }`,
    `  rm -rf "$work/get" "$work/out"`,
  ].join("\n");
}

const UNAME_SYSTEM: Readonly<Record<FetchedOs, string>> = { linux: "Linux", macos: "Darwin" };
const UNAME_MACHINES: Readonly<Record<Arch, readonly string[]>> = { x86_64: ["x86_64", "amd64"], arm64: ["aarch64", "arm64"] };

function unamePattern(build: FfmpegBuild): string {
  return UNAME_MACHINES[build.arch].map((machine) => `${UNAME_SYSTEM[build.os]}/${machine}`).join("|");
}

function fetchBranch(build: FfmpegBuild): string {
  return `  ${unamePattern(build)})
  version='${build.version}'; id='${buildId(build)}'
${build.downloads.map(unpackLines).join("\n")}
  ;;`;
}

export function clipFfmpegScript(os: FetchedOs, builds: readonly FfmpegBuild[] = FFMPEG_BUILDS): string {
  const filters = clipFilters(os);
  return String.raw`dir="$HOME/${CLIP_FFMPEG_DIR}"; bin="$HOME/${CLIP_FFMPEG_BIN}"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
began=$(now)
missing_in() {
  filters=$("$1" -hide_banner -filters 2>/dev/null) || { printf 'ffmpeg'; return; }
  encoders=$("$1" -hide_banner -encoders 2>/dev/null)
  out=
  printf '%s\n' "$encoders" | grep -q ' libx264 ' || out="libx264"
  for f in ${filters.join(" ")}; do printf '%s\n' "$filters" | grep -q " $f " || out="$out${"$"}{out:+ }$f"; done
  printf '%s' "$out"
}
said() { printf '{"ffmpeg":"%s","version":"%s","seconds":%s,"missing":"%s"}\n' "$1" "$("$2" -hide_banner -version 2>/dev/null | sed -n '1s/^ffmpeg version [^0-9]*\([0-9][0-9.]*\).*/\1/p')" "$(awk -v a="$began" -v b="$(now)" 'BEGIN { printf "%.1f", b - a }')" "$3"; }
if [ -x "$bin/ffmpeg" ] && [ -x "$bin/ffprobe" ] && [ -z "$(missing_in "$bin/ffmpeg")" ]; then said kept "$bin/ffmpeg" ""; exit 0; fi
own=$(command -v ffmpeg 2>/dev/null || true)
missing=ffmpeg
if [ -n "$own" ]; then
  missing=$(missing_in "$own")
  command -v ffprobe >/dev/null 2>&1 || missing="$missing${"$"}{missing:+ }ffprobe"
  if [ -z "$missing" ]; then said own "$own" ""; exit 0; fi
fi
sum256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1; else shasum -a 256 "$1" | cut -d ' ' -f 1; fi; }
mkdir -p "$dir"
work=$(mktemp -d "$dir/fetch.XXXXXX") || exit ${CLIP_FFMPEG_EXITS.broken}
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
case "$(uname -s)/$(uname -m)" in
${builds.map(fetchBranch).join("\n")}
  *) echo "$missing" >&2; exit ${CLIP_FFMPEG_EXITS.noBuild} ;;
esac
chmod 755 "$work/bin/ffmpeg" "$work/bin/ffprobe"
left=$(missing_in "$work/bin/ffmpeg")
[ -z "$left" ] || { echo "ffmpeg $version from ${PRODUCT}'s pinned build lacks $left there." >&2; exit ${CLIP_FFMPEG_EXITS.broken}; }
"$work/bin/ffprobe" -hide_banner -version >/dev/null 2>&1 || { echo "ffprobe $version from ${PRODUCT}'s pinned build does not run there." >&2; exit ${CLIP_FFMPEG_EXITS.broken}; }
rm -rf "$bin"
mv "$work/bin" "$bin" && printf '%s\n' "$id" >"$dir/build"
find "$dir" -mindepth 1 -maxdepth 1 -name 'fetch.*' ! -path "$work" -mmin +30 -exec rm -rf {} + 2>/dev/null
said fetched "$bin/ffmpeg" "$missing"
`;
}

export function parseClipFfmpeg(stdout: string): ClipFfmpeg | null {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value = JSON.parse(line) as { ffmpeg?: unknown; version?: unknown; seconds?: unknown; missing?: unknown };
    if (value.ffmpeg !== "own" && value.ffmpeg !== "fetched" && value.ffmpeg !== "kept") return null;
    return {
      ffmpeg: value.ffmpeg,
      version: typeof value.version === "string" ? value.version : "",
      seconds: typeof value.seconds === "number" ? value.seconds : 0,
      missing: typeof value.missing === "string" && value.missing ? value.missing.split(" ") : [],
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
