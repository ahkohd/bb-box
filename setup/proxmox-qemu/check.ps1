# Checks a box made from the Windows template, over SSH as box, the way the
# backend reaches it. build.sh runs it on a linked clone of a new template.
# Prints one line per check and exits 1 if any fails.
$failed = 0
function Check($name, [scriptblock]$test) {
  try { "ok    {0,-34} {1}" -f $name, ((& $test) -join ' ') }
  catch { "FAIL  {0,-34} {1}" -f $name, $_; $script:failed = 1 }
}
# Calls a Cua tool through the daemon in the desktop session, as JSON.
function Cua($tool, $arguments) {
  $out = cua-driver call $tool ($arguments | ConvertTo-Json -Compress -Depth 5) 2>&1
  if ($LASTEXITCODE) { throw "cua-driver call $tool failed: $(($out | Out-String).Trim())" }
  $json = ($out | Out-String) | ConvertFrom-Json
  if ($json.structuredContent) { $json.structuredContent } else { $json }
}

Check 'PowerShell 7 over SSH' { $v = $PSVersionTable.PSVersion; if ($v.Major -lt 7) { throw "PowerShell $v" }; "$v" }
Check 'UTF-8 code page' {
  $acp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage').ACP
  if ($acp -ne '65001') { throw "ACP is $acp" }; "ACP $acp, output $([Console]::OutputEncoding.WebName)"
}
Check 'SSH session elevated' {
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'not elevated' }; "$env:USERNAME, elevated"
}
Check 'git and gh on PATH' {
  $git = git --version; $gh = gh --version | Select-Object -First 1
  if (-not $git -or -not $gh) { throw 'missing' }; "$git; $gh"
}
Check 'NO_COLOR set' { if ($env:NO_COLOR -ne '1') { throw "NO_COLOR is '$env:NO_COLOR'" }; 'NO_COLOR=1' }
Check 'address from the SMBIOS serial' {
  $line = Get-Content C:\bb-box\boot.log -Tail 1
  if ($line -notmatch ' address \d') { throw $line }; $line -replace '^\S+ ', ''
}
Check 'no BitLocker' { $s = (Get-BitLockerVolume -MountPoint C:).VolumeStatus; if ("$s" -ne 'FullyDecrypted') { throw "$s" }; "$s" }
Check 'automatic logon' {
  $e = Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0 | Select-Object -First 1
  if (-not $e) { throw 'no desktop session' }; "$($e.UserName), session $($e.SessionId)"
}
Check 'Cua daemon in the desktop session' {
  $p = Get-Process cua-driver -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0 | Select-Object -First 1
  if (-not $p) { throw 'not running in a desktop session' }
  $status = cua-driver status 2>&1 | Select-Object -First 1
  if ($LASTEXITCODE) { throw "$status" }; "session $($p.SessionId); $status"
}
Check 'Cua lists windows' { $w = @((Cua list_windows @{}).windows); if (-not $w.Count) { throw 'no windows' }; "$($w.Count) windows" }
Check 'Edge page in the accessibility tree' {
  Get-Process msedge -ErrorAction SilentlyContinue | Stop-Process -Force
  Cua launch_app @{ urls = @('https://en.wikipedia.org/wiki/Microsoft_Windows') } | Out-Null
  $edge = $null
  for ($i = 0; $i -lt 30 -and -not $edge; $i++) {
    Start-Sleep -Seconds 1
    $edge = @((Cua list_windows @{}).windows) | Where-Object { "$($_.app_name) $($_.title)" -match 'edge' -and $_.title -match 'Wikipedia' } | Select-Object -First 1
  }
  if (-not $edge) { throw 'no Edge window with the page' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $state = Cua get_window_state @{ pid = $edge.pid; window_id = $edge.window_id; include_screenshot = $false; max_elements = 5000; timeout_ms = 10000 }
  $count = if ($null -ne $state.element_count) { $state.element_count } else { @($state.elements).Count }
  if ($count -lt 200) { throw "only $count elements: the page is not in the tree" }
  "$count elements in $($sw.ElapsedMilliseconds) ms"
}
exit $failed
