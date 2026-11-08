import type { GuestOs } from "../transports/types.ts";

export const LIST_CAP = 5_000;
export const OPEN_BYTES = 4 * 1024 * 1024;
export const IMAGE_BYTES = 2 * 1024 * 1024;
export const RANGE_BYTES = 256 * 1024;
export const CORPUS_BYTES = 8 * 1024 * 1024;
export const CORPUS_FILE_BYTES = 512 * 1024;
export const NAME_CAP = 20_000;
export const SEARCH_FILE_BYTES = 2 * 1024 * 1024;
export const SEARCH_PER_FILE = 40;
const WARM_NAME_BUDGET = NAME_CAP * 64;
const WARM_MARGIN = 256 * 1024;
export const WARM_OUT = Math.ceil(CORPUS_BYTES / 3) * 4 + WARM_NAME_BUDGET + WARM_MARGIN;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

export function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function posixHash(): string {
  return (
    "bb_files_hash() {\n" +
    "  if command -v sha256sum >/dev/null 2>&1; then sha256sum < \"$1\" | cut -d ' ' -f 1\n" +
    "  else shasum -a 256 < \"$1\" | cut -d ' ' -f 1\n" +
    "  fi\n" +
    "}\n"
  );
}

function posixStat(probe: string): string {
  return (
    `if stat -c '%s' ${probe} >/dev/null 2>&1; then\n` +
    "  bb_files_stat() { stat -L -c '%s %Y' \"$1\" 2>/dev/null || echo '0 0'; }\n" +
    "else\n" +
    "  bb_files_stat() { stat -L -f '%z %m' \"$1\" 2>/dev/null || echo '0 0'; }\n" +
    "fi\n"
  );
}

function posixB64(): string {
  return "bb_files_b64() { printf '%s' \"$1\" | base64 | tr -d '\\n'; }\n";
}

export function homeScript(os: GuestOs): string {
  if (os === "windows") {
    return (
      "$bbFilesHome = [Environment]::GetFolderPath('UserProfile'); " +
      "if (-not $bbFilesHome) { $bbFilesHome = $HOME }; " +
      '"HOME`t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$bbFilesHome))'
    );
  }
  return "printf 'HOME\\t%s\\n' \"$(printf '%s' \"$HOME\" | base64 | tr -d '\\n')\"";
}

export function listScript(os: GuestOs, path: string): string {
  if (os === "windows") return windowsList(path);
  return posixList(path);
}

function posixList(path: string): string {
  return (
    "set -ef\n" +
    `bb_files_dir=${sh(path)}\n` +
    "if [ ! -d \"$bb_files_dir\" ]; then printf 'ERR\\tunreadable\\n'; exit 0; fi\n" +
    posixStat('"$bb_files_dir"') +
    posixB64() +
    "bb_files_n=0\n" +
    "find \"$bb_files_dir\" -mindepth 1 -maxdepth 1 -print | while IFS= read -r bb_files_path; do\n" +
    "  [ -n \"$bb_files_path\" ] || continue\n" +
    "  case \"$bb_files_path\" in \"$bb_files_dir\"/*) ;; *) continue ;; esac\n" +
    "  [ -e \"$bb_files_path\" ] || [ -L \"$bb_files_path\" ] || continue\n" +
    "  bb_files_n=$((bb_files_n + 1))\n" +
    `  if [ \"$bb_files_n\" -gt ${LIST_CAP} ]; then printf 'TRUNC\\n'; break; fi\n` +
    "  if [ -d \"$bb_files_path\" ]; then bb_files_kind=D\n" +
    "  elif [ -f \"$bb_files_path\" ]; then bb_files_kind=F\n" +
    "  else bb_files_kind=O; fi\n" +
    "  set -- $(bb_files_stat \"$bb_files_path\")\n" +
    "  bb_files_name=${bb_files_path##*/}\n" +
    "  printf 'ENT\\t%s\\t%s\\t%s\\t%s\\n' \"$bb_files_kind\" \"$1\" \"$2\" \"$(bb_files_b64 \"$bb_files_name\")\"\n" +
    "done\n"
  );
}

function windowsList(path: string): string {
  return (
    `$bbFilesDir = ${ps(path)}; ` +
    "if (-not (Test-Path -LiteralPath $bbFilesDir -PathType Container)) { \"ERR`tunreadable\"; exit 0 }; " +
    "$bbFilesItems = @(Get-ChildItem -LiteralPath $bbFilesDir -Force -ErrorAction SilentlyContinue); " +
    `$bbFilesTake = [Math]::Min($bbFilesItems.Count, ${LIST_CAP}); ` +
    "for ($bbFilesI = 0; $bbFilesI -lt $bbFilesTake; $bbFilesI++) { " +
    "$bbFilesIt = $bbFilesItems[$bbFilesI]; " +
    "$bbFilesKind = $(if ($bbFilesIt.Attributes -band [IO.FileAttributes]::Directory) { 'D' } else { 'F' }); " +
    "$bbFilesSize = $(if ($null -eq $bbFilesIt.Length) { 0 } else { [int64]$bbFilesIt.Length }); " +
    "$bbFilesWhen = [int64]([DateTimeOffset]$bbFilesIt.LastWriteTimeUtc).ToUnixTimeSeconds(); " +
    "$bbFilesName = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$bbFilesIt.Name)); " +
    "\"ENT`t$bbFilesKind`t$bbFilesSize`t$bbFilesWhen`t$bbFilesName\" }; " +
    `if ($bbFilesItems.Count -gt ${LIST_CAP}) { 'TRUNC' }`
  );
}

export function readScript(os: GuestOs, path: string): string {
  if (os === "windows") return windowsRead(path);
  return posixRead(path);
}

function posixMime(): string {
  const arms = Object.entries(IMAGE_MIME)
    .map(([ext, mime]) => `${ext}) bb_files_mime=${sh(mime)} ;;`)
    .join("\n");
  return (
    "bb_files_lower=$(printf '%s' \"$bb_files_path\" | tr '[:upper:]' '[:lower:]')\n" +
    "bb_files_ext=${bb_files_lower##*.}\n" +
    "bb_files_mime=\n" +
    "case \"$bb_files_ext\" in\n" +
    `${arms}\n` +
    "esac\n"
  );
}

function posixRead(path: string): string {
  return (
    "set -ef\n" +
    `bb_files_path=${sh(path)}\n` +
    "if [ ! -e \"$bb_files_path\" ] && [ ! -L \"$bb_files_path\" ]; then printf 'MISSING\\n'; exit 0; fi\n" +
    "if [ -d \"$bb_files_path\" ]; then printf 'DIR\\n'; exit 0; fi\n" +
    "if [ ! -f \"$bb_files_path\" ]; then printf 'ERR\\tnot-a-file\\n'; exit 0; fi\n" +
    posixStat('"$bb_files_path"') +
    posixHash() +
    posixMime() +
    "set -- $(bb_files_stat \"$bb_files_path\")\n" +
    "bb_files_size=$1\n" +
    "bb_files_sum=$(bb_files_hash \"$bb_files_path\")\n" +
    `bb_files_limit=${OPEN_BYTES}\n` +
    "[ -n \"$bb_files_mime\" ] && bb_files_limit=" +
    `${IMAGE_BYTES}\n` +
    "if [ \"$bb_files_size\" -gt \"$bb_files_limit\" ]; then printf 'LARGE\\t%s\\t%s\\n' \"$bb_files_size\" \"$bb_files_sum\"; exit 0; fi\n" +
    "if [ -n \"$bb_files_mime\" ]; then\n" +
    "  printf 'IMAGE\\t%s\\t%s\\t%s\\n' \"$bb_files_mime\" \"$bb_files_size\" \"$bb_files_sum\"\n" +
    "  base64 < \"$bb_files_path\" | tr -d '\\n'\n" +
    "  printf '\\n'\n" +
    "  exit 0\n" +
    "fi\n" +
    "bb_files_raw=$(head -c 8192 \"$bb_files_path\" | wc -c | tr -cd '0-9')\n" +
    "bb_files_kept=$(head -c 8192 \"$bb_files_path\" | tr -d '\\000' | wc -c | tr -cd '0-9')\n" +
    "if [ \"$bb_files_raw\" != \"$bb_files_kept\" ]; then printf 'BINARY\\t%s\\t%s\\n' \"$bb_files_size\" \"$bb_files_sum\"; exit 0; fi\n" +
    "printf 'TEXT\\t%s\\t%s\\n' \"$bb_files_size\" \"$bb_files_sum\"\n" +
    "base64 < \"$bb_files_path\" | tr -d '\\n'\n" +
    "printf '\\n'\n"
  );
}

function windowsRead(path: string): string {
  const arms = Object.entries(IMAGE_MIME)
    .map(([ext, mime]) => `'${ext}' { '${mime}' }`)
    .join(" ");
  return (
    `$bbFilesPath = ${ps(path)}; ` +
    "if (-not (Test-Path -LiteralPath $bbFilesPath)) { 'MISSING'; exit 0 }; " +
    "$bbFilesItem = Get-Item -LiteralPath $bbFilesPath -Force; " +
    "if ($bbFilesItem.PSIsContainer) { 'DIR'; exit 0 }; " +
    "if (-not $bbFilesItem.PSIsContainer -and -not (Test-Path -LiteralPath $bbFilesPath -PathType Leaf)) { \"ERR`tnot-a-file\"; exit 0 }; " +
    "$bbFilesSize = [int64]$bbFilesItem.Length; " +
    "$bbFilesSum = (Get-FileHash -Algorithm SHA256 -LiteralPath $bbFilesPath).Hash.ToLower(); " +
    "$bbFilesExt = [IO.Path]::GetExtension($bbFilesPath).TrimStart('.').ToLowerInvariant(); " +
    `$bbFilesMime = switch ($bbFilesExt) { ${arms} default { '' } }; ` +
    `$bbFilesLimit = ${OPEN_BYTES}; if ($bbFilesMime) { $bbFilesLimit = ${IMAGE_BYTES} }; ` +
    "if ($bbFilesSize -gt $bbFilesLimit) { \"LARGE`t$bbFilesSize`t$bbFilesSum\"; exit 0 }; " +
    "$bbFilesBytes = [IO.File]::ReadAllBytes($bbFilesPath); " +
    "if ($bbFilesMime) { \"IMAGE`t$bbFilesMime`t$bbFilesSize`t$bbFilesSum\"; [Convert]::ToBase64String($bbFilesBytes); exit 0 }; " +
    "$bbFilesBinary = $false; $bbFilesScan = [Math]::Min(8192, $bbFilesBytes.Length); " +
    "for ($bbFilesI = 0; $bbFilesI -lt $bbFilesScan; $bbFilesI++) { if ($bbFilesBytes[$bbFilesI] -eq 0) { $bbFilesBinary = $true; break } }; " +
    "if ($bbFilesBinary) { \"BINARY`t$bbFilesSize`t$bbFilesSum\"; exit 0 }; " +
    "\"TEXT`t$bbFilesSize`t$bbFilesSum\"; [Convert]::ToBase64String($bbFilesBytes)"
  );
}

export function rangeScript(os: GuestOs, path: string, start: number, length: number): string {
  const from = Math.max(0, Math.floor(start));
  const take = Math.min(RANGE_BYTES, Math.max(1, Math.floor(length)));
  if (os === "windows") {
    return (
      `$bbFilesPath = ${ps(path)}; $bbFilesStart = ${from}; $bbFilesTake = ${take}; ` +
      "if (-not (Test-Path -LiteralPath $bbFilesPath -PathType Leaf)) { \"ERR`tmissing\"; exit 0 }; " +
      "$bbFilesSize = [int64](Get-Item -LiteralPath $bbFilesPath).Length; " +
      "$bbFilesSum = (Get-FileHash -Algorithm SHA256 -LiteralPath $bbFilesPath).Hash.ToLower(); " +
      "if ($bbFilesStart -ge $bbFilesSize) { $bbFilesTake = 0 }; " +
      "if ($bbFilesStart + $bbFilesTake -gt $bbFilesSize) { $bbFilesTake = $bbFilesSize - $bbFilesStart }; " +
      "$bbFilesEnd = $bbFilesStart + $bbFilesTake; " +
      "\"RANGE`t$bbFilesStart`t$bbFilesEnd`t$bbFilesSize`t$bbFilesSum\"; " +
      "if ($bbFilesTake -gt 0) { " +
      "$bbFilesStream = [IO.File]::Open($bbFilesPath, 'Open', 'Read', 'ReadWrite'); " +
      "try { $bbFilesStream.Position = $bbFilesStart; $bbFilesBuf = New-Object byte[] $bbFilesTake; [void]$bbFilesStream.Read($bbFilesBuf, 0, $bbFilesTake); [Convert]::ToBase64String($bbFilesBuf) } finally { $bbFilesStream.Close() } }"
    );
  }
  return (
    "set -ef\n" +
    `bb_files_path=${sh(path)}\n` +
    `bb_files_start=${from}\n` +
    `bb_files_take=${take}\n` +
    "if [ ! -f \"$bb_files_path\" ]; then printf 'ERR\\tmissing\\n'; exit 0; fi\n" +
    posixStat('"$bb_files_path"') +
    posixHash() +
    "set -- $(bb_files_stat \"$bb_files_path\")\n" +
    "bb_files_size=$1\n" +
    "bb_files_sum=$(bb_files_hash \"$bb_files_path\")\n" +
    "if [ \"$bb_files_start\" -ge \"$bb_files_size\" ]; then bb_files_take=0; fi\n" +
    "if [ $((bb_files_start + bb_files_take)) -gt \"$bb_files_size\" ]; then bb_files_take=$((bb_files_size - bb_files_start)); fi\n" +
    "bb_files_end=$((bb_files_start + bb_files_take))\n" +
    "printf 'RANGE\\t%s\\t%s\\t%s\\t%s\\n' \"$bb_files_start\" \"$bb_files_end\" \"$bb_files_size\" \"$bb_files_sum\"\n" +
    "if [ \"$bb_files_take\" -gt 0 ]; then tail -c +$((bb_files_start + 1)) \"$bb_files_path\" | head -c \"$bb_files_take\" | base64 | tr -d '\\n'; printf '\\n'; fi\n"
  );
}

export type WriteMode = "guard" | "overwrite";

export function writeScript(os: GuestOs, path: string, expected: string, mode: WriteMode): string {
  if (os === "windows") return windowsWrite(path, expected, mode);
  return posixWrite(path, expected, mode);
}

function posixKeep(): string {
  return (
    "bb_files_ino() { stat -c '%i' \"$1\" 2>/dev/null || stat -f '%i' \"$1\" 2>/dev/null || echo 0; }\n" +
    "bb_files_bits() { stat -c '%a' \"$1\" 2>/dev/null || stat -f '%OLp' \"$1\" 2>/dev/null || echo 644; }\n" +
    "bb_files_link() {\n" +
    "  bb_files_ok=0\n" +
    "  if ln -T \"$1\" \"$1.bbprobe\" 2>/dev/null; then\n" +
    "    rm -f \"$1.bbprobe\"\n" +
    "    if ln -T \"$1\" \"$2\" 2>/dev/null; then bb_files_ok=1; fi\n" +
    "  else\n" +
    "    if ln \"$1\" \"$2\" 2>/dev/null; then bb_files_ok=1; fi\n" +
    "  fi\n" +
    "  if [ \"$bb_files_ok\" -eq 1 ]; then return 0; fi\n" +
    "  return 1\n" +
    "}\n" +
    "bb_files_same() {\n" +
    "  bb_files_a=$(bb_files_ino \"$1\")\n" +
    "  bb_files_b=$(bb_files_ino \"$2\")\n" +
    "  if [ \"$bb_files_a\" = \"$bb_files_b\" ] && [ \"$bb_files_a\" != 0 ]; then return 0; fi\n" +
    "  if cmp -s \"$1\" \"$2\"; then return 0; fi\n" +
    "  return 1\n" +
    "}\n" +
    "bb_files_keep() {\n" +
    "  bb_files_n=0\n" +
    "  while [ \"$bb_files_n\" -lt 100 ]; do\n" +
    "    if [ \"$bb_files_n\" -eq 0 ]; then bb_files_slot=\"$1.conflict\"\n" +
    "    else bb_files_slot=\"$1.conflict-$((bb_files_n + 1))\"\n" +
    "    fi\n" +
    "    bb_files_n=$((bb_files_n + 1))\n" +
    "    if [ -e \"$bb_files_slot\" ] || [ -L \"$bb_files_slot\" ]; then continue; fi\n" +
    "    bb_files_hold=$(mktemp \"$(dirname -- \"$1\")/.bb-files.XXXXXX\") || return 1\n" +
    "    cat < \"$2\" > \"$bb_files_hold\" || { rm -f \"$bb_files_hold\"; return 1; }\n" +
    "    if [ -f \"$1\" ]; then chmod \"$(bb_files_bits \"$1\")\" \"$bb_files_hold\" 2>/dev/null || true; fi\n" +
    "    if bb_files_link \"$bb_files_hold\" \"$bb_files_slot\"; then\n" +
    "      if [ -f \"$bb_files_slot\" ] && [ ! -L \"$bb_files_slot\" ]; then\n" +
    "        if bb_files_same \"$bb_files_hold\" \"$bb_files_slot\"; then rm -f \"$bb_files_hold\"; return 0; fi\n" +
    "        rm -f \"$bb_files_slot\" \"$bb_files_hold\"\n" +
    "        return 1\n" +
    "      fi\n" +
    "      bb_files_inner=\"$bb_files_slot/$(basename \"$bb_files_hold\")\"\n" +
    "      if [ -f \"$bb_files_inner\" ] && [ ! -L \"$bb_files_inner\" ]; then\n" +
    "        if bb_files_same \"$bb_files_hold\" \"$bb_files_inner\"; then rm -f \"$bb_files_inner\"; fi\n" +
    "      fi\n" +
    "    elif [ ! -e \"$bb_files_slot\" ] && [ ! -L \"$bb_files_slot\" ]; then\n" +
    "      if (set -C; : > \"$bb_files_slot\"); then\n" +
    "        if cat < \"$bb_files_hold\" > \"$bb_files_slot\"; then\n" +
    "          chmod \"$(bb_files_bits \"$bb_files_hold\")\" \"$bb_files_slot\" 2>/dev/null || true\n" +
    "          if bb_files_same \"$bb_files_hold\" \"$bb_files_slot\"; then rm -f \"$bb_files_hold\"; return 0; fi\n" +
    "        fi\n" +
    "        rm -f \"$bb_files_slot\" \"$bb_files_hold\"\n" +
    "        return 1\n" +
    "      fi\n" +
    "    fi\n" +
    "    rm -f \"$bb_files_hold\"\n" +
    "  done\n" +
    "  return 1\n" +
    "}\n"
  );
}

function posixWrite(path: string, expected: string, mode: WriteMode): string {
  return (
    "set -ef\n" +
    `bb_files_path=${sh(path)}\n` +
    `bb_files_mode=${sh(mode)}\n` +
    `bb_files_expected=${sh(expected)}\n` +
    posixHash() +
    posixStat("'/'") +
    posixKeep() +
    "bb_files_tmp=$(mktemp)\n" +
    "cat > \"$bb_files_tmp\"\n" +
    "if [ -d \"$bb_files_path\" ]; then rm -f \"$bb_files_tmp\"; printf 'ERR\\tis-directory\\n'; exit 0; fi\n" +
    "if [ -f \"$bb_files_path\" ]; then\n" +
    "  if [ \"$bb_files_mode\" = guard ]; then\n" +
    "    bb_files_now=$(bb_files_hash \"$bb_files_path\")\n" +
    "    if [ \"$bb_files_now\" != \"$bb_files_expected\" ]; then\n" +
    "      bb_files_keep \"$bb_files_path\" \"$bb_files_tmp\" || { rm -f \"$bb_files_tmp\"; printf 'ERR\\tfailed\\n'; exit 0; }\n" +
    "      rm -f \"$bb_files_tmp\"\n" +
    "      printf 'CONFLICT\\t%s\\n' \"$bb_files_now\"\n" +
    "      exit 0\n" +
    "    fi\n" +
    "  fi\n" +
    "  cat < \"$bb_files_tmp\" > \"$bb_files_path\"\n" +
    "elif [ -e \"$bb_files_path\" ] || [ -L \"$bb_files_path\" ]; then\n" +
    "  if [ \"$bb_files_mode\" = guard ]; then\n" +
    "    bb_files_keep \"$bb_files_path\" \"$bb_files_tmp\" || { rm -f \"$bb_files_tmp\"; printf 'ERR\\tfailed\\n'; exit 0; }\n" +
    "    rm -f \"$bb_files_tmp\"\n" +
    "    printf 'CONFLICT\\t\\n'\n" +
    "    exit 0\n" +
    "  fi\n" +
    "  cat < \"$bb_files_tmp\" > \"$bb_files_path\"\n" +
    "elif [ \"$bb_files_mode\" = guard ]; then\n" +
    "  bb_files_keep \"$bb_files_path\" \"$bb_files_tmp\" || { rm -f \"$bb_files_tmp\"; printf 'ERR\\tfailed\\n'; exit 0; }\n" +
    "  rm -f \"$bb_files_tmp\"\n" +
    "  printf 'CONFLICT\\t\\n'\n" +
    "  exit 0\n" +
    "else\n" +
    "  mkdir -p -- \"$(dirname -- \"$bb_files_path\")\"\n" +
    "  cat < \"$bb_files_tmp\" > \"$bb_files_path\"\n" +
    "fi\n" +
    "bb_files_sum=$(bb_files_hash \"$bb_files_tmp\")\n" +
    "set -- $(bb_files_stat \"$bb_files_tmp\")\n" +
    "rm -f \"$bb_files_tmp\"\n" +
    "printf 'WRITTEN\\t%s\\t%s\\n' \"$bb_files_sum\" \"$1\"\n"
  );
}

function windowsWrite(path: string, expected: string, mode: WriteMode): string {
  return (
    "$ErrorActionPreference = 'Stop'; $bbFilesTmp = $null; try { " +
    `$bbFilesPath = ${ps(path)}; $bbFilesMode = ${ps(mode)}; $bbFilesExpected = ${ps(expected)}; ` +
    "function BbFilesKeep($bbFilesLive, $bbFilesFrom) { " +
    "$bbFilesSlots = @($bbFilesLive + '.conflict'); " +
    "for ($bbFilesN = 2; $bbFilesN -le 100; $bbFilesN++) { $bbFilesSlots += ($bbFilesLive + '.conflict-' + $bbFilesN) }; " +
    "foreach ($bbFilesSlot in $bbFilesSlots) { " +
    "try { " +
    "$bbFilesOut = [IO.File]::Open($bbFilesSlot, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None); " +
    "try { $bbFilesIn = [IO.File]::Open($bbFilesFrom, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read); " +
    "try { $bbFilesIn.CopyTo($bbFilesOut) } finally { $bbFilesIn.Close() } } finally { $bbFilesOut.Close() }; " +
    "return $true } catch {} }; return $false }; " +
    "$bbFilesTmp = [IO.Path]::GetTempFileName(); " +
    "$bbFilesStream = [IO.File]::Create($bbFilesTmp); " +
    "try { [Console]::OpenStandardInput().CopyTo($bbFilesStream) } finally { $bbFilesStream.Close() }; " +
    "if (Test-Path -LiteralPath $bbFilesPath -PathType Container) { Remove-Item -LiteralPath $bbFilesTmp -Force; \"ERR`tis-directory\"; exit 0 }; " +
    "if (Test-Path -LiteralPath $bbFilesPath -PathType Leaf) { " +
    "if ($bbFilesMode -eq 'guard') { " +
    "$bbFilesNow = (Get-FileHash -Algorithm SHA256 -LiteralPath $bbFilesPath).Hash.ToLower(); " +
    "if ($bbFilesNow -ne $bbFilesExpected) { " +
    "if (-not (BbFilesKeep $bbFilesPath $bbFilesTmp)) { Remove-Item -LiteralPath $bbFilesTmp -Force; \"ERR`tfailed\"; exit 0 }; " +
    "Remove-Item -LiteralPath $bbFilesTmp -Force; \"CONFLICT`t$bbFilesNow\"; exit 0 } }; " +
    "try { [IO.File]::Copy($bbFilesTmp, $bbFilesPath, $true) } catch { Remove-Item -LiteralPath $bbFilesTmp -Force -ErrorAction SilentlyContinue; \"ERR`tfailed\"; exit 0 } " +
    "} elseif ($bbFilesMode -eq 'guard') { " +
    "if (-not (BbFilesKeep $bbFilesPath $bbFilesTmp)) { Remove-Item -LiteralPath $bbFilesTmp -Force; \"ERR`tfailed\"; exit 0 }; " +
    "Remove-Item -LiteralPath $bbFilesTmp -Force; \"CONFLICT`t\"; exit 0 } " +
    "else { " +
    "$bbFilesDir = [IO.Path]::GetDirectoryName($bbFilesPath); " +
    "if ($bbFilesDir) { [void][IO.Directory]::CreateDirectory($bbFilesDir) }; " +
    "try { [IO.File]::Copy($bbFilesTmp, $bbFilesPath, $true) } catch { Remove-Item -LiteralPath $bbFilesTmp -Force -ErrorAction SilentlyContinue; \"ERR`tfailed\"; exit 0 } }; " +
    "$bbFilesHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $bbFilesTmp).Hash.ToLower(); " +
    "$bbFilesSize = (Get-Item -LiteralPath $bbFilesTmp).Length; " +
    "Remove-Item -LiteralPath $bbFilesTmp -Force; " +
    "\"WRITTEN`t$bbFilesHash`t$bbFilesSize\" } finally { if ($null -ne $bbFilesTmp) { Remove-Item -LiteralPath $bbFilesTmp -Force -ErrorAction SilentlyContinue } }"
  );
}

export function createScript(os: GuestOs, path: string, kind: "file" | "directory"): string {
  if (os === "windows") {
    const make =
      kind === "directory"
        ? "[void][IO.Directory]::CreateDirectory($bbFilesPath)"
        : "$bbFilesDir = [IO.Path]::GetDirectoryName($bbFilesPath); if ($bbFilesDir) { [void][IO.Directory]::CreateDirectory($bbFilesDir) }; [IO.File]::WriteAllBytes($bbFilesPath, [byte[]]@())";
    return (
      `$bbFilesPath = ${ps(path)}; ` +
      "if (Test-Path -LiteralPath $bbFilesPath) { \"ERR`texists\"; exit 0 }; " +
      `${make}; ` +
      "'OK'"
    );
  }
  const make =
    kind === "directory"
      ? "mkdir -p -- \"$bb_files_path\""
      : "mkdir -p -- \"$(dirname -- \"$bb_files_path\")\" && : > \"$bb_files_path\"";
  return (
    "set -ef\n" +
    `bb_files_path=${sh(path)}\n` +
    "if [ -e \"$bb_files_path\" ] || [ -L \"$bb_files_path\" ]; then printf 'ERR\\texists\\n'; exit 0; fi\n" +
    `${make}\n` +
    "printf 'OK\\n'\n"
  );
}

export function renameScript(os: GuestOs, from: string, to: string): string {
  if (os === "windows") {
    return (
      `$bbFilesFrom = ${ps(from)}; $bbFilesTo = ${ps(to)}; ` +
      "if (-not (Test-Path -LiteralPath $bbFilesFrom)) { \"ERR`tmissing\"; exit 0 }; " +
      "if (Test-Path -LiteralPath $bbFilesTo) { \"ERR`texists\"; exit 0 }; " +
      "$bbFilesDir = [IO.Path]::GetDirectoryName($bbFilesTo); " +
      "if ($bbFilesDir) { [void][IO.Directory]::CreateDirectory($bbFilesDir) }; " +
      "Move-Item -LiteralPath $bbFilesFrom -Destination $bbFilesTo; 'OK'"
    );
  }
  return (
    "set -ef\n" +
    `bb_files_from=${sh(from)}\n` +
    `bb_files_to=${sh(to)}\n` +
    "if [ ! -e \"$bb_files_from\" ] && [ ! -L \"$bb_files_from\" ]; then printf 'ERR\\tmissing\\n'; exit 0; fi\n" +
    "if [ -e \"$bb_files_to\" ] || [ -L \"$bb_files_to\" ]; then printf 'ERR\\texists\\n'; exit 0; fi\n" +
    "mkdir -p -- \"$(dirname -- \"$bb_files_to\")\"\n" +
    "mv -- \"$bb_files_from\" \"$bb_files_to\"\n" +
    "printf 'OK\\n'\n"
  );
}

export function deleteScript(os: GuestOs, path: string, home: string): string {
  if (os === "windows") {
    return (
      `$bbFilesPath = ${ps(path)}; $bbFilesHome = ${ps(home)}; ` +
      "$bbFilesFull = [IO.Path]::GetFullPath($bbFilesPath); " +
      "if ($bbFilesFull -match '^[A-Za-z]:\\\\$' -or $bbFilesFull -eq $bbFilesHome) { \"ERR`trefused\"; exit 0 }; " +
      "if (-not (Test-Path -LiteralPath $bbFilesPath)) { \"ERR`tmissing\"; exit 0 }; " +
      "Remove-Item -LiteralPath $bbFilesPath -Recurse -Force; 'OK'"
    );
  }
  return (
    "set -ef\n" +
    `bb_files_path=${sh(path)}\n` +
    `bb_files_home=${sh(home)}\n` +
    "if [ \"$bb_files_path\" = / ] || [ \"$bb_files_path\" = \"$bb_files_home\" ]; then printf 'ERR\\trefused\\n'; exit 0; fi\n" +
    "if [ ! -e \"$bb_files_path\" ] && [ ! -L \"$bb_files_path\" ]; then printf 'ERR\\tmissing\\n'; exit 0; fi\n" +
    "rm -rf -- \"$bb_files_path\"\n" +
    "printf 'OK\\n'\n"
  );
}

export interface SearchFlags {
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
  readonly hidden: boolean;
}

export function searchScript(os: GuestOs, root: string, query: string, flags: SearchFlags): string {
  if (os === "windows") return windowsSearch(root, query, flags);
  return posixSearch(root, query, flags);
}

function posixSearch(root: string, query: string, flags: SearchFlags): string {
  const smart = flags.matchCase || /[A-Z]/.test(query);
  const rgFlags = [
    "--json",
    "--null",
    "--no-ignore",
    "--max-columns",
    "240",
    "--max-filesize",
    String(SEARCH_FILE_BYTES),
    "--max-count",
    String(SEARCH_PER_FILE + 1),
    "-g",
    "!.git/**",
    "-g",
    "!node_modules/**",
    "-g",
    "!vendor/**",
    flags.hidden ? "--hidden" : "",
    flags.regex ? "" : "-F",
    flags.wholeWord ? "-w" : "",
    smart ? "-s" : "-S",
  ]
    .filter(Boolean)
    .map(sh)
    .join(" ");
  const grepCase = smart ? "" : "-i";
  const grepFixed = flags.regex ? "" : "-F";
  const grepWord = flags.wholeWord ? "-w" : "";
  const hidden = flags.hidden ? "" : "--exclude-dir='.[!.]*' --exclude-dir='..?*' --exclude='.[!.]*' --exclude='..?*'";
  const findHidden = flags.hidden ? "" : "-name '.[!.]*' -prune -o -name '..?*' -prune -o ";
  const grepFlags = `$bb_files_bin ${grepCase} ${grepFixed} ${grepWord} -m ${SEARCH_PER_FILE + 1}`;
  return (
    "set -f\n" +
    `cd -- ${sh(root)} || { printf 'ERR\\tunreadable\\n'; exit 0; }\n` +
    "bb_files_tmp=$(mktemp)\n" +
    "if command -v rg >/dev/null 2>&1; then\n" +
    `  rg ${rgFlags} -- ${sh(query)} . > \"$bb_files_tmp\" 2>/dev/null\n` +
    "  bb_files_status=$?\n" +
    "  printf 'ENGINE\\trg\\n'\n" +
    "  cat \"$bb_files_tmp\"\n" +
    "  if [ \"$bb_files_status\" -gt 1 ]; then printf 'ERR\\tfailed\\n'; fi\n" +
    "else\n" +
    "  bb_files_bin=\n" +
    "  grep --help 2>&1 | grep -q binary-files && bb_files_bin=--binary-files=without-match\n" +
    "  if printf 'x\\n' | grep --null -h -e x >/dev/null 2>&1; then\n" +
    `    grep -RInH --null ${grepFlags} --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=vendor ${hidden} -e ${sh(query)} . > \"$bb_files_tmp\" 2>/dev/null\n` +
    "    bb_files_status=$?\n" +
    "  else\n" +
    "    bb_files_status=0\n" +
    "    bb_files_list=$(mktemp)\n" +
    "    bb_files_hits=$(mktemp)\n" +
    "    : > \"$bb_files_tmp\"\n" +
    `    find . \\( -name .git -o -name node_modules -o -name vendor \\) -prune -o ${findHidden}-type f -print > \"$bb_files_list\"\n` +
    "    while IFS= read -r bb_files_one; do\n" +
    "      [ -f \"$bb_files_one\" ] || continue\n" +
    `      grep -nh ${grepFlags} -e ${sh(query)} -- \"$bb_files_one\" > \"$bb_files_hits\" 2>/dev/null\n` +
    "      bb_files_one_status=$?\n" +
    "      if [ \"$bb_files_one_status\" -gt 1 ]; then bb_files_status=2; fi\n" +
    "      while IFS= read -r bb_files_hit; do\n" +
    "        printf '%s\\0%s\\n' \"$bb_files_one\" \"$bb_files_hit\"\n" +
    "      done < \"$bb_files_hits\" >> \"$bb_files_tmp\"\n" +
    "    done < \"$bb_files_list\"\n" +
    "    rm -f \"$bb_files_list\" \"$bb_files_hits\"\n" +
    "  fi\n" +
    "  printf 'ENGINE\\tgrep\\n'\n" +
    "  cat \"$bb_files_tmp\"\n" +
    "  if [ \"$bb_files_status\" -gt 1 ]; then printf 'ERR\\tfailed\\n'; fi\n" +
    "fi\n" +
    "rm -f \"$bb_files_tmp\"\n"
  );
}

function windowsSearch(root: string, query: string, flags: SearchFlags): string {
  const smart = flags.matchCase || /[A-Z]/.test(query);
  const rgExtra = [
    flags.hidden ? "--hidden" : "",
    flags.regex ? "" : "-F",
    flags.wholeWord ? "-w" : "",
    smart ? "-s" : "-S",
    "--max-count",
    String(SEARCH_PER_FILE + 1),
  ]
    .filter(Boolean)
    .join(" ");
  const hiddenTest = flags.hidden ? "$true" : "('\\' + $_.FullName.Substring($bbFilesRoot.Length)) -notmatch '\\\\\\.'";
  return (
    `$bbFilesRoot = ${ps(root)}; $bbFilesQuery = ${ps(query)}; ` +
    "$bbFilesRegex = " +
    (flags.regex ? "$true" : "$false") +
    "; $bbFilesWhole = " +
    (flags.wholeWord ? "$true" : "$false") +
    "; $bbFilesSmart = " +
    (smart ? "$true" : "$false") +
    "; " +
    "if (-not (Test-Path -LiteralPath $bbFilesRoot -PathType Container)) { \"ERR`tunreadable\"; exit 0 }; " +
    "Set-Location -LiteralPath $bbFilesRoot; " +
    "if (Get-Command rg -ErrorAction SilentlyContinue) { " +
    "\"ENGINE`trg\"; & rg --json --null --no-ignore --max-columns 240 --max-filesize " +
    String(SEARCH_FILE_BYTES) +
    " -g '!.git/**' -g '!node_modules/**' -g '!vendor/**' " +
    rgExtra +
    " -- $bbFilesQuery .; if ($LASTEXITCODE -gt 1) { \"ERR`tfailed\" }; exit 0 }; " +
    "\"ENGINE`tgrep\"; " +
    "$bbFilesPattern = $bbFilesQuery; if (-not $bbFilesRegex) { $bbFilesPattern = [regex]::Escape($bbFilesPattern) }; " +
    "if ($bbFilesWhole) { $bbFilesPattern = '\\b(?:' + $bbFilesPattern + ')\\b' }; " +
    "$bbFilesSeen = 0; " +
    "Get-ChildItem -LiteralPath $bbFilesRoot -Recurse -File -Force -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.FullName -notmatch '\\\\(\\.git|node_modules|vendor)\\\\' -and $_.Length -le " +
    `${SEARCH_FILE_BYTES} -and (${hiddenTest}) } | ` +
    "Select-Object -First 3000 | ForEach-Object { " +
    "$bbFilesFile = $_.FullName; $bbFilesRel = $bbFilesFile.Substring($bbFilesRoot.Length).TrimStart('\\'); " +
    "$bbFilesN = 0; $bbFilesInFile = 0; " +
    "Get-Content -LiteralPath $bbFilesFile -ErrorAction SilentlyContinue | ForEach-Object { " +
    `$bbFilesN++; if ($bbFilesSeen -ge 2000 -or $bbFilesInFile -ge ${SEARCH_PER_FILE + 1}) { return }; ` +
    "$bbFilesLine = $_; try { $bbFilesHit = if ($bbFilesSmart) { $bbFilesLine -cmatch $bbFilesPattern } else { $bbFilesLine -imatch $bbFilesPattern } } catch { $bbFilesHit = $false }; " +
    "if ($bbFilesHit) { $bbFilesInFile++; $bbFilesSeen++; ($bbFilesRel + ':' + $bbFilesN + ':' + $bbFilesLine) } } }"
  );
}

const SKIP_EXT = "png jpg jpeg gif webp ico bmp exe dll so dylib zip gz tar wasm pdf mp4 mov mp3 wav class jar woff woff2 ttf otf 7z rar iso dmg";

export function warmScript(os: GuestOs, root: string): string {
  if (os === "windows") return windowsWarm(root);
  return posixWarm(root);
}

function posixWarm(root: string): string {
  const skip = SKIP_EXT.split(" ")
    .map((ext) => `${ext}) continue ;;`)
    .join("\n");
  return (
    "set -f\n" +
    `cd -- ${sh(root)} || { printf 'ERR\\tunreadable\\n'; exit 0; }\n` +
    posixStat(".") +
    posixB64() +
    "bb_files_n=0\n" +
    "find . \\( -name .git -o -name node_modules -o -name vendor \\) -prune -o -type f -print | {\n" +
    "bb_files_out=0\n" +
    "while IFS= read -r bb_files_path; do\n" +
    "  case \"$bb_files_path\" in ./*) ;; *) continue ;; esac\n" +
    "  [ -f \"$bb_files_path\" ] || continue\n" +
    "  bb_files_rel=${bb_files_path#./}\n" +
    "  bb_files_n=$((bb_files_n + 1))\n" +
    `  if [ \"$bb_files_n\" -gt ${NAME_CAP} ]; then printf 'MORE\\n'; break; fi\n` +
    "  bb_files_name=$(bb_files_b64 \"$bb_files_rel\")\n" +
    "  if [ $((bb_files_out + ${#bb_files_name} + 16)) -ge " + WARM_NAME_BUDGET + " ]; then printf 'MORE\\n'; break; fi\n" +
    "  printf 'NAME\\t%s\\n' \"$bb_files_name\"\n" +
    "  bb_files_out=$((bb_files_out + ${#bb_files_name} + 16))\n" +
    "done\n" +
    "}\n" +
    "bb_files_used=0\n" +
    "find . \\( -name .git -o -name node_modules -o -name vendor \\) -prune -o -type f -print | {\n" +
    "bb_files_out=0\n" +
    "while IFS= read -r bb_files_path; do\n" +
    "  case \"$bb_files_path\" in ./*) ;; *) continue ;; esac\n" +
    "  [ -f \"$bb_files_path\" ] || continue\n" +
    `  if [ \"$bb_files_used\" -ge ${CORPUS_BYTES} ]; then printf 'MORE\\n'; break; fi\n` +
    "  bb_files_rel=${bb_files_path#./}\n" +
    "  bb_files_lower=$(printf '%s' \"$bb_files_rel\" | tr '[:upper:]' '[:lower:]')\n" +
    "  bb_files_ext=${bb_files_lower##*.}\n" +
    "  case \"$bb_files_ext\" in\n" +
    `${skip}\n` +
    "  esac\n" +
    "  set -- $(bb_files_stat \"$bb_files_path\")\n" +
    `  if [ \"$1\" -gt ${CORPUS_FILE_BYTES} ]; then printf 'MORE\\n'; continue; fi\n` +
    "  bb_files_raw=$(head -c 8192 \"$bb_files_path\" | wc -c | tr -cd '0-9')\n" +
    "  bb_files_kept=$(head -c 8192 \"$bb_files_path\" | tr -d '\\000' | wc -c | tr -cd '0-9')\n" +
    "  [ \"$bb_files_raw\" = \"$bb_files_kept\" ] || continue\n" +
    "  bb_files_body=$(base64 < \"$bb_files_path\" | tr -d '\\n')\n" +
    "  bb_files_need=$((${#bb_files_body} + ${#bb_files_rel} + 96))\n" +
    `  if [ $((bb_files_out + bb_files_need)) -ge ${WARM_OUT - WARM_NAME_BUDGET} ]; then printf 'MORE\\n'; break; fi\n` +
    "  printf 'FILE\\t%s\\t%s\\t%s\\n' \"$(bb_files_b64 \"$bb_files_rel\")\" \"$1\" \"$2\"\n" +
    "  printf '%s\\n' \"$bb_files_body\"\n" +
    "  printf 'ENDFILE\\n'\n" +
    "  bb_files_out=$((bb_files_out + bb_files_need))\n" +
    "  bb_files_used=$((bb_files_used + $1))\n" +
    "done\n" +
    "}\n" +
    "printf 'DONE\\n'\n"
  );
}

function windowsWarm(root: string): string {
  return (
    `$bbFilesRoot = ${ps(root)}; ` +
    "if (-not (Test-Path -LiteralPath $bbFilesRoot -PathType Container)) { \"ERR`tunreadable\"; exit 0 }; " +
    "$bbFilesSkip = @('.git','node_modules','vendor'); " +
    "$bbFilesN = 0; " +
    "Get-ChildItem -LiteralPath $bbFilesRoot -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { " +
    "$bbFilesRel = $_.FullName.Substring($bbFilesRoot.Length).TrimStart('\\'); " +
    "$bbFilesParts = $bbFilesRel.Split('\\'); " +
    "$bbFilesOut = $false; foreach ($bbFilesPart in $bbFilesParts) { if ($bbFilesSkip -contains $bbFilesPart) { $bbFilesOut = $true } }; " +
    "if ($bbFilesOut) { return }; " +
    `$bbFilesN++; if ($bbFilesN -gt ${NAME_CAP}) { 'MORE'; return }; ` +
    '"NAME`t" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bbFilesRel)) }; ' +
    "'MORE'; 'DONE'"
  );
}

export function namesScript(os: GuestOs, root: string): string {
  if (os === "windows") {
    return (
      `$bbFilesRoot = ${ps(root)}; ` +
      "if (-not (Test-Path -LiteralPath $bbFilesRoot -PathType Container)) { \"ERR`tunreadable\"; exit 0 }; " +
      "$bbFilesN = 0; " +
      "Get-ChildItem -LiteralPath $bbFilesRoot -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object { " +
      "$bbFilesRel = $_.FullName.Substring($bbFilesRoot.Length).TrimStart('\\'); " +
      "if ($bbFilesRel -eq '' -or $bbFilesRel -match '(\\.git|node_modules|vendor)(\\\\|$)') { return }; " +
      `$bbFilesN++; if ($bbFilesN -gt ${NAME_CAP}) { 'TRUNC'; return }; ` +
      "$bbFilesTag = if ($_.PSIsContainer) { 'DIR' } else { 'NAME' }; " +
      "$bbFilesTag + \"`t\" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bbFilesRel)) }"
    );
  }
  return (
    "set -f\n" +
    `cd -- ${sh(root)} || { printf 'ERR\\tunreadable\\n'; exit 0; }\n` +
    posixB64() +
    "bb_files_n=0\n" +
    "find . \\( -name .git -o -name node_modules -o -name vendor \\) -prune -o \\( -type d -o -type f \\) -print | while IFS= read -r bb_files_path; do\n" +
    "  case \"$bb_files_path\" in ./*) ;; *) continue ;; esac\n" +
    "  bb_files_n=$((bb_files_n + 1))\n" +
    `  if [ \"$bb_files_n\" -gt ${NAME_CAP} ]; then printf 'TRUNC\\n'; break; fi\n` +
    "  if [ -d \"$bb_files_path\" ]; then printf 'DIR\\t%s\\n' \"$(bb_files_b64 \"${bb_files_path#./}\")\"; else printf 'NAME\\t%s\\n' \"$(bb_files_b64 \"${bb_files_path#./}\")\"; fi\n" +
    "done\n"
  );
}
