# Checks a box made from the Windows template, over SSH as box, the way the
# backend reaches it. The build scripts run it on a clone of a new image, and
# a refresh (054) on a trial box of a new build.
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
Check 'Node.js 22.19 or later on PATH' {
  $v = node --version; $n = npm --version
  if (-not $v -or [version]($v.TrimStart('v')) -lt [version]'22.19') { throw "node $v" }; "node $v, npm $n"
}
Check 'Claude Code, Codex and Pi on PATH' {
  $said = foreach ($tool in 'claude', 'codex', 'pi') { $v = & $tool --version 2>&1 | Select-Object -First 1; if ($LASTEXITCODE -or -not $v) { throw "$tool did not run" }; "$v" }
  $said -join '; '
}
Check "ffmpeg with gdigrab, and ffprobe, on PATH, for box_record" {
  $v = ffmpeg -hide_banner -version | Select-Object -First 1; $p = ffprobe -hide_banner -version | Select-Object -First 1
  if (-not $v -or -not $p) { throw 'missing' }
  if (-not (ffmpeg -hide_banner -devices 2>$null | Select-String '\bgdigrab\b')) { throw "$v has no gdigrab" }
  $v
}
Check "Claude Code's PowerShell tool on PowerShell 7" {
  # Its init frame says which shell tools it has and which PowerShell runs, with no sign-in.
  $init = ('hi' | claude -p --output-format stream-json --verbose 2>$null | Select-Object -First 1) | ConvertFrom-Json
  if ($init.tools -notcontains 'PowerShell') { throw "tools: $($init.tools -join ', ')" }
  if ($init.powershell_path -notlike '*\PowerShell\7\pwsh.exe') { throw "PowerShell is $($init.powershell_path)" }
  "$($init.powershell_path), beside $(@($init.tools | Where-Object { $_ -eq 'Bash' }).Count) Bash tool"
}
Check 'NO_COLOR set' { if ($env:NO_COLOR -ne '1') { throw "NO_COLOR is '$env:NO_COLOR'" }; 'NO_COLOR=1' }
Check 'C++ build tools and SDK' {
  $tools = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'Microsoft.VisualStudio.Component.VC.Tools.ARM64' } else { 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' }
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = & $vswhere -products * -requires $tools -latest -property installationVersion
  if (-not $vs) { throw "no Visual Studio with $tools" }
  $sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Include" -Name -ErrorAction SilentlyContinue | Sort-Object | Select-Object -Last 1
  if (-not $sdk) { throw 'no Windows SDK' }; "Build Tools $vs, SDK $sdk"
}
Check 'cargo, rustc and clang on PATH' {
  $cargo = cargo --version; $rustc = rustc --version; $clang = clang --version | Select-Object -First 1
  if (-not $cargo -or -not $rustc -or -not $clang) { throw 'missing' }; "$rustc; $clang"
}
# A program each way a build makes one: Rust with MSVC's linker, and C with clang.
Check 'cargo builds and runs a program' {
  $dir = Join-Path $env:TEMP "bb-box-check-$PID"
  cargo new --vcs none --quiet $dir 2>&1 | Out-Null
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = cargo run --quiet --offline --manifest-path "$dir\Cargo.toml" 2>&1
  $ms = $sw.ElapsedMilliseconds
  Remove-Item $dir -Recurse -Force
  if ("$out" -notmatch 'Hello, world!') { throw "$out" }; "built and ran in $ms ms"
}
Check 'clang builds and runs a C program' {
  $dir = Join-Path $env:TEMP "bb-box-check-c-$PID"
  New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content "$dir\hello.c" '#include <stdio.h>
int main(void) { puts("hello from clang"); return 0; }'
  $build = clang "$dir\hello.c" -o "$dir\hello.exe" 2>&1
  $out = if (Test-Path "$dir\hello.exe") { & "$dir\hello.exe" } else { "$build" }
  Remove-Item $dir -Recurse -Force
  if ("$out" -ne 'hello from clang') { throw "$out" }; "$out"
}
# The build tools take about 12 GB; a box keeps room for a project's builds.
Check 'C: has at least 20 GB free' {
  $free = [math]::Round((Get-PSDrive C).Free / 1GB, 1)
  if ($free -lt 20) { throw "$free GB free" }; "$free GB free"
}
# How this boot went, to set beside the build's time for a box to answer: Windows' time up, the boot's type (0x1 is
# Fast Startup's), how long the boot manager waited for a choice, and the firmware's boot order.
Check 'boot' {
  $up = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
  $boot = Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Microsoft-Windows-Kernel-Boot'; Id = 27, 32 } -MaxEvents 2 -ErrorAction SilentlyContinue
  $type = ($boot | Where-Object Id -eq 27 | Select-Object -First 1).Properties[0].Value
  $waited = ($boot | Where-Object Id -eq 32 | Select-Object -First 1).Properties[0].Value
  $order = ((bcdedit /enum '{fwbootmgr}' 2>$null | Select-String '^displayorder') -replace '^displayorder\s+', '').Trim()
  'up {0:N1} s; type 0x{1:X}; boot manager waited {2} ms; firmware order {3}' -f $up.TotalSeconds, $type, $waited, $order
}
Check 'address from the SMBIOS serial' {
  $line = Get-Content C:\bb-box\boot.log -Tail 1
  if ($line -notmatch ' address \d') { throw $line }; $line -replace '^\S+ ', ''
}
Check 'no BitLocker' { $s = (Get-BitLockerVolume -MountPoint C:).VolumeStatus; if ("$s" -ne 'FullyDecrypted') { throw "$s" }; "$s" }
Check 'standard font smoothing' {
  $d = Get-ItemProperty 'HKCU:\Control Panel\Desktop'
  if ($d.FontSmoothing -ne '2' -or $d.FontSmoothingType -ne 1) { throw "FontSmoothing $($d.FontSmoothing), type $($d.FontSmoothingType)" }; 'on, not ClearType'
}
Check 'automatic logon' {
  $e = Get-Process explorer -IncludeUserName -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0 | Select-Object -First 1
  if (-not $e) { throw 'no desktop session' }; "$($e.UserName), session $($e.SessionId)"
}
Check 'no OneDrive' {
  $p = (Get-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive' -ErrorAction SilentlyContinue).DisableFileSyncNGSC
  if ($p -ne 1) { throw 'the policy is not set' }
  if (Get-Process OneDrive -ErrorAction SilentlyContinue) { throw 'OneDrive is running' }
  'not running, by policy'
}
Check 'Cua daemon in the desktop session' {
  $p = Get-Process cua-driver -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0 | Select-Object -First 1
  if (-not $p) { throw 'not running in a desktop session' }
  $status = cua-driver status 2>&1 | Select-Object -First 1
  if ($LASTEXITCODE) { throw "$status" }; "session $($p.SessionId); $status"
}
# The desktop as video (060), as bb-box's relay reaches it: connect over SSH, which starts the server in the desktop
# session through its task, an upgrade, START_VIDEO, then a key frame of the desktop.
Check 'bb-box-stream: a key frame' {
  $exe = 'C:\Program Files\bb-box-tools\bb-box-stream\bb-box-stream.exe'
  if (-not (Get-ScheduledTask bb-box-stream -ErrorAction SilentlyContinue)) { throw 'no bb-box-stream task' }
  $start = New-Object Diagnostics.ProcessStartInfo $exe, 'connect'
  $start.UseShellExecute = $false; $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true
  $process = [Diagnostics.Process]::Start($start)
  # A read that waits for ever ends when this stops the connection.
  $deadline = Start-Job { param($id) Start-Sleep 25; Stop-Process -Id $id -Force -ErrorAction SilentlyContinue } -ArgumentList $process.Id
  try {
    $in = $process.StandardInput.BaseStream; $out = $process.StandardOutput.BaseStream
    $hello = [Text.Encoding]::ASCII.GetBytes("GET / HTTP/1.1`r`nHost: localhost`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==`r`nSec-WebSocket-Version: 13`r`n`r`n")
    $in.Write($hello, 0, $hello.Length)
    $ask = [Text.Encoding]::ASCII.GetBytes('START_VIDEO')
    $frame = [byte[]](@(0x81, (0x80 + $ask.Length), 0, 0, 0, 0) + $ask); $in.Write($frame, 0, $frame.Length); $in.Flush()
    $read = { param($n) $b = New-Object byte[] $n; $at = 0; while ($at -lt $n) { $got = $out.Read($b, $at, $n - $at); if ($got -le 0) { throw 'the server ended the connection' }; $at += $got }; $b }
    $head = ''; while (-not $head.EndsWith("`r`n`r`n")) { $head += [char](& $read 1)[0] }
    if ($head -notmatch '^HTTP/1.1 101') { throw "no upgrade: $($head.Split("`r")[0])" }
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($clock.Elapsed.TotalSeconds -lt 20) {
      $f = & $read 2; $n = $f[1] -band 127
      if ($n -eq 126) { $x = & $read 2; $n = $x[0] * 256 + $x[1] } elseif ($n -eq 127) { $x = & $read 8; $n = 0; foreach ($byte in $x) { $n = $n * 256 + $byte } }
      $payload = & $read $n
      if (($f[0] -band 15) -eq 2 -and $payload[0] -eq 4 -and ($payload[1] -band 15) -eq 1) {
        return "{0}x{1} in {2} ms, {3} KB" -f ($payload[6] * 256 + $payload[7]), ($payload[8] * 256 + $payload[9]), $clock.ElapsedMilliseconds, [int]($n / 1024)
      }
    }
    throw 'no key frame within 20 s'
  } finally { if (-not $process.HasExited) { $process.Kill() }; Remove-Job $deadline -Force }
}
# The pointer out of the captured image (060), so the video can leave it out while a person holds control: the VirtIO
# GPU's hardware cursor on (hardware-cursor.ps1), and bb-box-stream's pointer test saying so from the desktop session,
# where a task of its own runs it as the stream's task runs the server.
Check 'pointer out of the captured image' {
  $gpu = Get-PnpDevice -Class Display -PresentOnly | Where-Object { (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Service).Data -eq 'VioGpuDod' } | Select-Object -First 1
  if (-not $gpu) { throw 'no VirtIO GPU' }
  $driver = (Get-PnpDeviceProperty -InstanceId $gpu.InstanceId -KeyName DEVPKEY_Device_Driver).Data
  $on = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Control\Class\$driver").HWCursor
  if ($on -ne 1) { throw "HWCursor is $on" }
  $exe = 'C:\Program Files\bb-box-tools\bb-box-stream\bb-box-stream.exe'
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\bb-box" | Out-Null
  $out = "$env:LOCALAPPDATA\bb-box\pointer.txt"
  Remove-Item $out -ErrorAction SilentlyContinue
  # A command line that starts with a quote loses its quotes through conhost, so it starts in the directory first.
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless cmd.exe /c `"cd /d %LOCALAPPDATA%\bb-box & `"$exe`" pointer > pointer.txt 2>&1`""
  $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\box" -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName bb-box-pointer-check -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  try {
    Start-ScheduledTask -TaskName bb-box-pointer-check
    $clock = [Diagnostics.Stopwatch]::StartNew()
    # Done once its output is there and the task is no longer running.
    do { Start-Sleep -Milliseconds 500 } while ((-not (Test-Path $out) -or (Get-ScheduledTask bb-box-pointer-check).State -ne 'Ready') -and $clock.Elapsed.TotalSeconds -lt 30)
    $said = ((Get-Content $out -ErrorAction SilentlyContinue) -join ' ').Trim()
    if ($said -ne 'the pointer is out of the image') { throw "bb-box-stream pointer: $(if ($said) { $said } else { 'nothing' })" }
    "HWCursor 1; $said"
  } finally { Unregister-ScheduledTask -TaskName bb-box-pointer-check -Confirm:$false -ErrorAction SilentlyContinue }
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
