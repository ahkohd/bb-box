# Refreshes a Windows image in a box of its current build (054): installs the
# updates Windows Update offers, but not drivers, and each tool in the pins
# whose installed version is not its pin, then writes the new image record.
# Run by bb-box's refresh as box, elevated, over SSH, from C:\bb-box\build:
#
#   refresh.ps1 -Pins <pins.json> -Record <image.json>
#
# The pins are setup/windows/pins.json's tools for the box's architecture.
# The record is the new build's, which goes to C:\bb-box\image.json once all
# is done. Exits 0 when done, 3010 when Windows needs a restart first (the
# refresh restarts the box and runs this again), and 1 on a failure. Each
# tool says its own version, so a run after a restart goes on from there.
param([Parameter(Mandatory)] [string] $Pins, [Parameter(Mandatory)] [string] $Record)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step($text) { Write-Output "$(Get-Date -Format HH:mm:ss) $text" }
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
try {
  $session = New-Object -ComObject Microsoft.Update.Session
  $found = $session.CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'").Updates
  $updates = New-Object -ComObject Microsoft.Update.UpdateColl
  foreach ($update in $found) {
    if (-not $update.EulaAccepted) { $update.AcceptEula() }
    Say "update: $($update.Title)"
    [void] $updates.Add($update)
  }
  $installed = 0; $failed = 0; $reboot = $false
  if ($updates.Count) {
    $downloader = $session.CreateUpdateDownloader(); $downloader.Updates = $updates; [void] $downloader.Download()
    $installer = $session.CreateUpdateInstaller(); $installer.Updates = $updates
    $result = $installer.Install()
    for ($i = 0; $i -lt $updates.Count; $i++) {
      # 2 succeeded, 3 succeeded with errors.
      $code = $result.GetUpdateResult($i).ResultCode
      if ($code -in 2, 3) { $installed++ } else { $failed++; Say "update failed ($code): $($updates.Item($i).Title)" }
    }
    $reboot = $result.RebootRequired
  }
  Set-Content 'C:\bb-box\build\updates.json' (@{ found = $updates.Count; installed = $installed; failed = $failed; reboot = $reboot } | ConvertTo-Json -Compress)
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
}

try {
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

  if ($restart) { Step 'a restart, then this again'; exit 3010 }

  # The record, with the edition this Windows says it is, such as Windows 11 Pro.
  $edition = (Get-CimInstance Win32_OperatingSystem).Caption -replace '^Microsoft ', ''
  Step "The image record, C:\bb-box\image.json ($edition)"
  $new = Get-Content $Record -Raw | ConvertFrom-Json
  if ($edition) { $new.os = $edition }
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
