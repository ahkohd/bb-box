import type { FsBox, FsRun } from './box-fs.ts';
import { absolutePath, words } from './box-fs.ts';
import { sh } from './box-fs-script.ts';

export type FilesTree = { error: null; path: string; paths: string[]; directories: string[]; truncated: boolean; partial: boolean; cached: boolean } | { error: string };

export function treeScript(os: FsBox['os'], path: string | null, recursive: boolean, hidden: boolean): string {
  if (os === 'windows') {
    const root = path === null ? '[Environment]::GetFolderPath("UserProfile")' : `'${path.replaceAll("'", "''")}'`;
    return `function Emit([string]$tag, [string]$value) { [Console]::Write($tag + [char]0); if ($PSBoundParameters.ContainsKey('value')) { [Console]::Write($value + [char]0) } }; $root = ${root}; $ErrorActionPreference = 'Stop'; try { $root = (Get-Item -LiteralPath $root).FullName; Emit 'ROOT' $root; $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root); $n = 0; $partial = $false; while ($pending.Count) { $dir = $pending.Pop(); try { $items = @(Get-ChildItem -LiteralPath $dir -Force) } catch { $partial = $true; continue }; foreach ($item in $items) { if ($item.Name -in @('.git','node_modules','vendor') -or $item.Name.Contains([char]10) -or $item.Name.Contains([char]13) ${hidden ? '' : '-or $item.Name.StartsWith(".")'}) { continue }; $n++; if ($n -gt ${recursive ? 20_000 : 5_000}) { Emit 'TRUNC'; Emit 'DONE'; exit }; $relative = $item.FullName.Substring($root.Length).TrimStart([char]92).Replace([char]92,[char]47); Emit $(if ($item.PSIsContainer) {'d'} else {'f'}) $relative; ${recursive ? 'if ($item.PSIsContainer -and -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $pending.Push($item.FullName) };' : ''} } }; if ($partial) { Emit 'PARTIAL' }; Emit 'DONE' } catch { Emit 'ERR' }`;

  }
  const prune = hidden ? '' : " -o -name '.*'";
  const cap = recursive ? 20_000 : 5_000;
  const selection = `\\( -name .git -o -name node_modules -o -name vendor${prune} -o -name '*\n*' -o -name '*\r*' \\) -prune -o \\( -type d -o -type f \\)`;
  return `set -f
cd -- ${path === null ? '\"$HOME\"' : sh(path)} || { printf 'UNREADABLE\\0'; exit 0; }
printf 'ROOT\\0%s\\0' "$PWD"
bb_tree_tmp=$(mktemp -d) || exit 1
bb_tree_pid=
bb_tree_cleanup() {
  trap - 0 HUP INT TERM
  if [ -n "$bb_tree_pid" ]; then kill "$bb_tree_pid" 2>/dev/null || :; wait "$bb_tree_pid" 2>/dev/null || :; fi
  rm -f "$bb_tree_tmp/pipe"
  rmdir "$bb_tree_tmp" 2>/dev/null || :
}
trap 'bb_tree_cleanup' 0
trap 'bb_tree_cleanup; exit 1' HUP INT TERM
mkfifo "$bb_tree_tmp/pipe" || exit 1
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
  find . -mindepth 1 ${recursive ? '' : '-maxdepth 1'} ${selection} -printf '%y/%P\\n' > "$bb_tree_tmp/pipe" &
else
  find . -mindepth 1 ${recursive ? '' : '-maxdepth 1'} ${selection} -exec stat ${os === 'macos' ? "-f '%HT/%N'" : "-c '%F/%n'"} {} + > "$bb_tree_tmp/pipe" &
fi
bb_tree_pid=$!
{
rm -f "$bb_tree_tmp/pipe"
rmdir "$bb_tree_tmp"
awk 'BEGIN { n=0 } { p=index($0,"/"); if (!p) next; t=substr($0,1,p-1); name=substr($0,p+1); sub(/^\\.\\//,"",name); if (++n>${cap}) { printf "TRUNC%c",0; exit 3 }; printf "%s%c%s%c", (t=="d" || tolower(t)=="directory" ? "d" : "f"),0,name,0 }'
} < "$bb_tree_tmp/pipe"
bb_tree_read=$?
if [ "$bb_tree_read" -eq 3 ]; then
  kill "$bb_tree_pid" 2>/dev/null || :
  wait "$bb_tree_pid" 2>/dev/null || :
  bb_tree_pid=
elif [ "$bb_tree_read" -ne 0 ]; then
  kill "$bb_tree_pid" 2>/dev/null || :
  wait "$bb_tree_pid" 2>/dev/null || :
  bb_tree_pid=
  printf 'ERR\\0'
  exit 0
else
  wait "$bb_tree_pid"
  bb_tree_status=$?
  bb_tree_pid=
  if [ "$bb_tree_status" -ne 0 ]; then printf 'PARTIAL\\0'; fi
fi
bb_tree_pid=
printf 'DONE\\0'

`;

}

export async function readTree(box: FsBox, path: string | null, recursive: boolean, hidden: boolean, run: FsRun): Promise<FilesTree> {
  if (box.device || !box.command || box.state !== 'ready') return { error: words(box.device ? 'device' : !box.command ? 'no-shell' : 'not-ready') };
  if (path !== null && absolutePath(box.os, path) === null) return { error: words('bad-path') };
  const result = await run(treeScript(box.os, path, recursive, hidden), { timeoutMs: 20_000, maxOutputBytes: 16 * 1024 * 1024 });
  if (result.timedOut || result.exitCode === 124) return { error: words('timeout') };
  if (result.exitCode !== 0 || result.truncated) return { error: words(result.truncated ? 'truncated' : 'failed') };
  if (result.stdout.startsWith('UNREADABLE')) return { error: words('unreadable') };
  const parts = result.stdout.split('\0');
  if (parts[0] !== 'ROOT') return { error: words('failed') };
  const root = parts[1];
  if (!root) return { error: words('failed') };
  const paths: string[] = [], directories: string[] = [];
  let truncated = false;
  let complete = false;
  let partial = false;
  for (let i = 2; i < parts.length; i += 2) {
    const kind = parts[i], name = parts[i + 1];
    if (kind === 'DONE') { complete = true; break; }
    if (kind === 'ERR') return { error: words('failed') };
    if (kind === 'PARTIAL') { partial = true; i--; continue; }
    if (kind === 'TRUNC') { truncated = true; i--; continue; }
    if (kind !== 'd' && kind !== 'f') return { error: words('failed') };
    if (!name || /[\r\n]/.test(name)) continue;
    if (paths.length + directories.length >= (recursive ? 20_000 : 5_000)) { truncated = true; continue; }
    (kind === 'd' ? directories : paths).push(name);
  }
  if (!complete) return { error: words('failed') };
  return { error: null, path: root, paths, directories, truncated, partial, cached: false };
}
