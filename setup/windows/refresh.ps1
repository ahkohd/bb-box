# Refreshes a Windows image in a box of its current build (054): installs the
# updates Windows Update offers, but not drivers, and each tool in the pins
# whose installed version is not its pin, then writes the new image record.
# Run by bb-box's refresh as box, elevated, over SSH, from C:\bb-box\build:
#
#   refresh.ps1 -Pins <pins.json> -Record <image.json>
#
# The pins are setup/windows/pins.json's tools for the box's architecture.
# With bb-url beside it, BB's server URL, it installs that server's BB app
# too, so a box enrols without its download and npm install (#916).
# The record is the new build's, which goes to C:\bb-box\image.json once all
# is done. Exits 0 when done, 3010 when Windows needs a restart first (the
# refresh restarts the box and runs this again), and 1 on a failure. Each
# tool says its own version, so a run after a restart goes on from there.
param([Parameter(Mandatory)] [string] $Pins, [Parameter(Mandatory)] [string] $Record)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step($text) { Write-Output "$(Get-Date -Format HH:mm:ss) $text" }
# New-Item -Force would empty a registry key that exists, so only make missing ones.
function Set-Reg($path, $name, $value, $type = 'DWord') {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
}
$dir = 'C:\bb-box\build'
$restart = $false

# Downloads a pinned file and checks its SHA-256, trying a few times.
function Get-Pinned($pin, $out) {
  for ($try = 1; $try -le 5; $try++) {
    try {
      Invoke-WebRequest $pin.url -OutFile $out -UseBasicParsing
      if ((Get-FileHash $out -Algorithm SHA256).Hash -eq $pin.sha256) { return }
      Step "$($pin.url) does not match its SHA-256 (try $try)"
    } catch { Step "could not download $($pin.url) (try $try): $_" }
    Remove-Item $out -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
  }
  throw "could not download $($pin.url) with its SHA-256"
}
# Runs an installer and waits; 3010 means installed, with a restart to come.
function Install($file, $arguments) {
  $run = Start-Process $file -Wait -PassThru -ArgumentList $arguments
  if ($run.ExitCode -eq 3010) { $script:restart = $true } elseif ($run.ExitCode -ne 0) { throw "$(Split-Path $file -Leaf) exited with $($run.ExitCode)" }
}
function Add-MachinePath($path) {
  $now = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if (($now -split ';') -notcontains $path) { [Environment]::SetEnvironmentVariable('Path', "$now;$path", 'Machine') }
}

# Windows Update, through its API as SYSTEM: the API refuses to download or
# install for a network logon, as SSH's is. The task writes its log and, last,
# its result.
function Update-Windows {
  $log = "$dir\updates.log"
  $done = "$dir\updates.json"
  Remove-Item $log, $done -ErrorAction SilentlyContinue
  Set-Content "$dir\updates.ps1" @'
$ErrorActionPreference = 'Stop'
$log = 'C:\bb-box\build\updates.log'
function Say($text) { Add-Content $log "$(Get-Date -Format HH:mm:ss) $text" }
# Another installation is going on: Windows' own updates, as Defender's run whatever the policy.
$BUSY = 0x80240016
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $installer = $session.CreateUpdateInstaller()
  $found = 0; $installed = 0; $failed = 0; $reboot = $false; $busy = 0
  # Passes until a search finds nothing: installing one update can offer the next, as Defender's do.
  for ($pass = 1; $pass -le 5; $pass++) {
    for ($waited = 0; $installer.IsBusy -and $waited -lt 900; $waited += 10) { if (-not $waited) { Say 'Windows is installing updates of its own: waiting' }; Start-Sleep -Seconds 10 }
    $offered = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates
    if (-not $offered.Count) { $busy = 0; break }
    $updates = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($update in $offered) {
      if (-not $update.EulaAccepted) { $update.AcceptEula() }
      Say "update: $($update.Title)"
      [void] $updates.Add($update)
    }
    $found += $updates.Count
    $downloader = $session.CreateUpdateDownloader(); $downloader.Updates = $updates
    $downloaded = $downloader.Download()
    for ($i = 0; $i -lt $updates.Count; $i++) {
      $one = $downloaded.GetUpdateResult($i)
      if ($one.ResultCode -notin 2, 3) { Say ('download failed ({0}, HResult 0x{1:X8}): {2}' -f $one.ResultCode, $one.HResult, $updates.Item($i).Title) }
    }
    $installer.Updates = $updates
    $result = $installer.Install()
    $busy = 0
    for ($i = 0; $i -lt $updates.Count; $i++) {
      # 2 succeeded, 3 succeeded with errors; the HResult says why one did not.
      $one = $result.GetUpdateResult($i)
      if ($one.ResultCode -in 2, 3) { $installed++ }
      elseif (($one.HResult -band 0xFFFFFFFF) -eq $BUSY) { $busy++; Say "update waits for Windows' own installation: $($updates.Item($i).Title)" }
      else { $failed++; Say ('update failed ({0}, HResult 0x{1:X8}): {2}' -f $one.ResultCode, $one.HResult, $updates.Item($i).Title) }
    }
    if ($result.RebootRequired) { $reboot = $true }
    # A restart first, or a failure: the refresh restarts the box and runs this again, or stops.
    if ($reboot -or $failed) { break }
  }
  if ($busy) { $failed += $busy; Say "Windows was still installing updates of its own after 5 passes" }
  Set-Content 'C:\bb-box\build\updates.json' (@{ found = $found; installed = $installed; failed = $failed; reboot = $reboot } | ConvertTo-Json -Compress)
} catch {
  Say "FAILED: $_"
  Set-Content 'C:\bb-box\build\updates.json' (@{ error = "$_" } | ConvertTo-Json -Compress)
}
'@
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File $dir\updates.ps1"
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'bb-box updates' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
  try {
    Start-ScheduledTask -TaskName 'bb-box updates'
    $seen = 0
    for ($waited = 0; -not (Test-Path $done); $waited += 5) {
      if ($waited -ge 7200) { throw 'Windows Update did not finish within 2 hours' }
      Start-Sleep -Seconds 5
      # Its log as it comes, for the refresh's output.
      $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
      if ($lines.Count -gt $seen) { $lines[$seen..($lines.Count - 1)] | ForEach-Object { Write-Output $_ }; $seen = $lines.Count }
      if ((Get-ScheduledTask -TaskName 'bb-box updates').State -ne 'Running' -and -not (Test-Path $done)) { Start-Sleep -Seconds 2; if (-not (Test-Path $done)) { throw 'the Windows Update task ended without a result' } }
    }
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue)
    if ($lines.Count -gt $seen) { $lines[$seen..($lines.Count - 1)] | ForEach-Object { Write-Output $_ } }
  } finally { Unregister-ScheduledTask -TaskName 'bb-box updates' -Confirm:$false -ErrorAction SilentlyContinue }
  $result = Get-Content $done -Raw | ConvertFrom-Json
  if ($result.error) { throw "Windows Update: $($result.error)" }
  if ($result.failed) { throw "Windows Update could not install $($result.failed) of $($result.found) updates (above)" }
  Step "Windows Update: $($result.installed) of $($result.found) updates installed$(if ($result.reboot) { ', a restart to come' })"
  if ($result.reboot) { $script:restart = $true }
}

# The version each tool says it is, or nothing when it is not there.
function Version-Of([scriptblock] $ask) {
  try { $said = & $ask 2>$null | Select-Object -First 1 } catch { return $null }
  if ("$said" -match '\d+(\.\d+)+') { $Matches[0] }
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
# The agent CLIs, each in a directory of its own on the machine's PATH (#561).
$tools = 'C:\Program Files\bb-box-tools'
$versions = @{
  'pwsh' = { & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' }
  'git' = { git --version }
  'gh' = { gh --version }
  'cua-driver' = { & 'C:\Program Files\CuaDriver\cua-driver.exe' --version }
  'vs-buildtools' = { & $vswhere -products * -property catalog_productDisplayVersion }
  'llvm' = { & 'C:\Program Files\LLVM\bin\clang.exe' --version }
  'rustup' = { & (Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe') --version }
  'node' = { & 'C:\Program Files\nodejs\node.exe' --version }
  'claude-code' = { & "$tools\claude\claude.exe" --version }
  'codex' = { & "$tools\codex\codex.exe" --version }
  'pi' = { & "$tools\pi\pi.exe" --version }
  'ffmpeg' = { & "$tools\ffmpeg\ffmpeg.exe" -version }
  'openh264' = { Get-Content "$tools\bb-box-stream\openh264.version" }
}

# Puts an agent CLI's program in its directory, in place of what was there, on the machine's PATH.
function Install-Tool($name, $file, $exe) {
  $to = Join-Path $tools $name
  Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith("$to\", 'OrdinalIgnoreCase') } | Stop-Process -Force
  Remove-Item $to -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force $to | Out-Null
  if ($file -like '*.zip') { Expand-Archive $file -DestinationPath $to -Force } else { Copy-Item $file (Join-Path $to $exe) }
  if (-not (Test-Path (Join-Path $to $exe))) { throw "$name has no $exe" }
  Add-MachinePath $to
}

# Each tool, installed as the template's first logon installs it.
$installers = @{
  'pwsh' = { param($pin, $file)
    # pwsh runs this script: its files are replaced at the restart.
    Install msiexec.exe "/i `"$file`" /qn /norestart ADD_PATH=1 USE_MU=0 ENABLE_MU=0 ENABLE_PSREMOTING=0 ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=0"
    $script:restart = $true
  }
  'git' = { param($pin, $file) Install $file '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/o:PathOption=Cmd', '/o:CredentialManager=Disabled' }
  'gh' = { param($pin, $file) Install msiexec.exe "/i `"$file`" /qn /norestart" }
  'cua-driver' = { param($pin, $file)
    $to = 'C:\Program Files\CuaDriver'
    Expand-Archive $file -DestinationPath "$dir\cua" -Force
    # The daemon in the desktop session holds its files; the restart starts the new one.
    Get-Process cua-driver -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Remove-Item $to -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Get-ChildItem "$dir\cua" -Directory | Select-Object -First 1).FullName $to
    Remove-Item "$dir\cua" -Recurse -Force
    $script:restart = $true
  }
  'vs-buildtools' = { param($pin, $file)
    $path = if (Test-Path $vswhere) { & $vswhere -products * -property installationPath | Select-Object -First 1 }
    $arguments = if ($path) { @('update', '--installPath', "`"$path`"", '--quiet', '--wait', '--norestart', '--nocache') }
    else { @('--quiet', '--wait', '--norestart', '--nocache') + ($pin.components | ForEach-Object { '--add', $_ }) + '--includeRecommended' }
    Install $file $arguments
  }
  'llvm' = { param($pin, $file)
    Install msiexec.exe "/i `"$file`" /qn /norestart"
    if (-not (Test-Path 'C:\Program Files\LLVM\bin\clang.exe')) { throw 'LLVM did not install clang.exe' }
    Add-MachinePath 'C:\Program Files\LLVM\bin'
  }
  'rustup' = { param($pin, $file)
    & $file -y -q --profile minimal --default-toolchain stable -c rustfmt -c clippy 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw "rustup-init exited with $LASTEXITCODE" }
  }
  'node' = { param($pin, $file)
    $to = 'C:\Program Files\nodejs'
    Expand-Archive $file -DestinationPath "$dir\node" -Force
    Remove-Item $to -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Get-ChildItem "$dir\node" -Directory | Select-Object -First 1).FullName $to
    Remove-Item "$dir\node" -Recurse -Force
    Add-MachinePath $to
    if ((& "$to\node.exe" --version) -ne "v$($pin.version)") { throw "node.exe is not $($pin.version)" }
  }
  'claude-code' = { param($pin, $file) Install-Tool claude $file claude.exe }
  'codex' = { param($pin, $file) Install-Tool codex $file codex.exe }
  'pi' = { param($pin, $file) Install-Tool pi $file pi.exe }
  # box_record's recorder (059): ffmpeg and ffprobe, from the archive's bin.
  'ffmpeg' = { param($pin, $file)
    Expand-Archive $file -DestinationPath "$dir\ffmpeg" -Force
    $bin = (Get-ChildItem "$dir\ffmpeg" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).Directory.FullName
    Install-Tool ffmpeg "$bin\ffmpeg.exe" ffmpeg.exe
    Copy-Item "$bin\ffprobe.exe" (Join-Path $tools ffmpeg)
    Remove-Item "$dir\ffmpeg" -Recurse -Force
  }
  # bb-box-stream.exe's encoder (060), with the program built again beside it.
  'openh264' = { param($pin, $file) & "$dir\install-stream.ps1" -Source "$dir\bb-box-stream.cs" -Archive $file -Version $pin.version }
}

try {
  Step "Passwords: box's never expires, and the machine's maximum password age is unlimited"
  Set-LocalUser -Name ([Environment]::UserName) -PasswordNeverExpires $true
  net.exe accounts /maxpwage:unlimited | Out-Null
  if ($null -ne (Get-LocalUser -Name ([Environment]::UserName)).PasswordExpires) { throw "the box user's password still expires" }

  Update-Windows

  foreach ($pin in (Get-Content $Pins -Raw | ConvertFrom-Json).tools) {
    if (-not $installers.ContainsKey($pin.name)) { throw "refresh.ps1 does not know how to install $($pin.name)" }
    $have = Version-Of $versions[$pin.name]
    if ($have -eq $pin.version) { Step "$($pin.name) $($pin.version): as pinned"; continue }
    Step "$($pin.name): $(if ($have) { $have } else { 'none' }) to $($pin.version)"
    $file = Join-Path $dir ([IO.Path]::GetFileName(([Uri] $pin.url).AbsolutePath))
    Get-Pinned $pin $file
    & $installers[$pin.name] $pin $file
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
  # The script that gives each clone its address at boot, as the setup has it now: the first logon put the first one in place.
  if (Test-Path "$dir\boot.ps1") { Copy-Item "$dir\boot.ps1" 'C:\bb-box\boot.ps1' -Force; Step 'boot.ps1: as its source' }
  # bb-box-stream.exe (060), built again when its source has changed, where the image has its encoder.
  $stream = "$tools\bb-box-stream"
  if (Test-Path "$stream\openh264.dll") {
    $built = Get-Content "$stream\bb-box-stream.source" -ErrorAction SilentlyContinue
    if ($built -ne (Get-FileHash "$dir\bb-box-stream.cs" -Algorithm SHA256).Hash -or -not (Test-Path "$stream\bb-box-stream.exe")) {
      Step 'bb-box-stream.exe: built from its new source'
      & "$dir\install-stream.ps1" -Source "$dir\bb-box-stream.cs"
    } else { Step 'bb-box-stream.exe: as its source' }
    # The pointer as the display's hardware cursor, so bb-box-stream can leave it out of the video, as the first logon has it.
    & "$dir\hardware-cursor.ps1" | ForEach-Object { Step $_ }
  }
  # Rust's stable toolchain, the latest, as on Linux boxes.
  $rustup = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
  if (Test-Path $rustup) {
    & $rustup update stable --no-self-update 2>&1 | Out-Null
    if ($LASTEXITCODE) { throw "rustup update stable exited with $LASTEXITCODE" }
    Step "Rust $((& (Join-Path $env:USERPROFILE '.cargo\bin\rustc.exe') --version) -replace '^rustc ', '')"
  }

  # Claude Code's PowerShell tool, beside its Bash tool in Git Bash: it runs PowerShell 7 (#561).
  [Environment]::SetEnvironmentVariable('CLAUDE_CODE_USE_POWERSHELL_TOOL', '1', 'Machine')

  # Edge updates itself, and its update writes its handler again without the
  # flag the first logon gave it: give it again, as the first logon does.
  Step 'Edge: its whole page in the accessibility tree'
  $handler = 'HKLM:\SOFTWARE\Classes\MSEdgeHTM\shell\open\command'
  $open = (Get-ItemProperty $handler -ErrorAction SilentlyContinue).'(default)'
  if ($open -and $open -notmatch 'force-renderer-accessibility') {
    Set-ItemProperty $handler -Name '(default)' -Value ($open -replace '(msedge\.exe"?)', '$1 --force-renderer-accessibility')
  }
  & C:\bb-box\logon.ps1 -Shortcuts "$env:PUBLIC\Desktop", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"

  # Standard font smoothing, not ClearType, as the first logon has it since 060: video's 4:2:0 loses ClearType's fringes.
  Step 'Fonts: standard smoothing, not ClearType'
  Set-ItemProperty 'HKCU:\Control Panel\Desktop' -Name FontSmoothing -Value '2'
  New-ItemProperty 'HKCU:\Control Panel\Desktop' -Name FontSmoothingType -Value 1 -PropertyType DWord -Force | Out-Null

  # No OneDrive, as the first logon has it since #707: images built before
  # get the policy here, and the OneDrive their sign-in started ends now, so
  # check.ps1 need not wait for a restart.
  Step 'OneDrive: off by policy'
  $onedrive = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive'
  if (-not (Test-Path $onedrive)) { New-Item -Path $onedrive -Force | Out-Null }
  New-ItemProperty -Path $onedrive -Name DisableFileSyncNGSC -Value 1 -PropertyType DWord -Force | Out-Null
  Get-Process OneDrive -ErrorAction SilentlyContinue | Stop-Process -Force

  Step 'A plain, still desktop: no Spotlight pictures, widgets or search-box pictures'
  # Spotlight changed the desktop's picture again and again for the first
  # minutes of a box, which its video sent as frames while nothing else moved
  # (#916): a solid colour, with Spotlight off and its "Learn about this
  # picture" icon gone, and no pictures in the search box.
  $cloud = 'HKCU:\Software\Policies\Microsoft\Windows\CloudContent'
  Set-Reg $cloud DisableWindowsSpotlightFeatures 1
  Set-Reg $cloud DisableSpotlightCollectionOnDesktop 1
  Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\DesktopSpotlight\Settings' EnabledState 0
  Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers' BackgroundType 1
  Set-Reg 'HKCU:\Control Panel\Desktop' Wallpaper '' String
  Set-Reg 'HKCU:\Control Panel\Colors' Background '32 32 32' String
  Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel' '{2cc5ca98-6485-489a-920e-b3e88a6ccce3}' 1
  Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search' EnableDynamicContentInWSB 0
  Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\SearchSettings' IsDynamicSearchBoxEnabled 0
  # The taskbar's widgets, the weather, change by themselves too. Windows
  # refuses even an administrator their policy key (Dsh), so their app goes.
  Get-AppxPackage -AllUsers MicrosoftWindows.Client.WebExperience | Remove-AppxPackage -AllUsers -ErrorAction SilentlyContinue
  Get-AppxProvisionedPackage -Online | Where-Object DisplayName -eq 'MicrosoftWindows.Client.WebExperience' | Remove-AppxProvisionedPackage -Online -ErrorAction SilentlyContinue | Out-Null

  if ($restart) { Step 'a restart, then this again'; exit 3010 }

  # BB's host app, where BB's installer looks for it, so enrolment skips its
  # download and npm install, which took 35 s and more (#916). A box of a
  # server that has built BB's app again since downloads it as before.
  $bbApp = $null
  $bbUrl = if (Test-Path "$dir\bb-url") { (Get-Content "$dir\bb-url" -Raw).Trim() } else { '' }
  if ($bbUrl) {
    # Node.js and npm, as installed in this run too.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $data = Join-Path $env:USERPROFILE ('.bb-machines\' + (([Uri] $bbUrl).Authority -replace '[^a-zA-Z0-9.-]', '-'))
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    $tgz = Join-Path $dir 'bb-app.tgz'
    $got = Invoke-WebRequest "$($bbUrl.TrimEnd('/'))/install/bb-app.tgz" -OutFile $tgz -UseBasicParsing -PassThru
    $bbApp = "$($got.Headers['x-bb-artifact-sha256'])".Trim().ToLower()
    if ($bbApp -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash $tgz -Algorithm SHA256).Hash.ToLower() -ne $bbApp) { throw "bb-app.tgz does not match the server's digest" }
    & npm.cmd install -g --no-fund --no-audit --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix "$data\npm" $tgz 2>&1 | ForEach-Object { Step "npm: $_" }
    if ($LASTEXITCODE) { throw "npm could not install BB's app: exit $LASTEXITCODE" }
    & node.exe -e 'const r = process.argv[1]; require(r + "/node_modules/node-pty"); require(r + "/node_modules/@parcel/watcher")' "$data\npm\node_modules\bb-app"
    if ($LASTEXITCODE) { throw "BB's app is installed, but its native add-ons (node-pty, @parcel/watcher) do not load" }
    [IO.File]::WriteAllText("$data\host-artifact.sha256", "$bbApp`n")
    Remove-Item $tgz -Force
    Step "BB's app $($bbApp.Substring(0, 12)), from $bbUrl"
  }

  # The record, with the edition this Windows says it is, such as Windows 11 Pro.
  $edition = (Get-CimInstance Win32_OperatingSystem).Caption -replace '^Microsoft ', ''
  Step "The image record, C:\bb-box\image.json ($edition)"
  $new = Get-Content $Record -Raw | ConvertFrom-Json
  if ($edition) { $new.os = $edition }
  if ($bbApp) { $new.bbApp = $bbApp }
  [IO.File]::WriteAllText('C:\bb-box\image.json', "$($new | ConvertTo-Json -Compress -Depth 5)`n")
  Step 'Cleaning up: temporary files and update downloads'
  Stop-Service wuauserv -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:SystemRoot\SoftwareDistribution\Download\*" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item "$env:TEMP\*", "$env:SystemRoot\Temp\*" -Recurse -Force -ErrorAction SilentlyContinue
  Step 'Done'
  exit 0
} catch {
  Step "FAILED: $_"
  exit 1
}
