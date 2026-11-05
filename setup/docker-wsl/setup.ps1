# Sets up a Windows PC as a Docker host for bb-box's Docker backend: Docker
# Engine in one WSL 2 distribution. BB on this PC uses host wsl://<name>,
# which reaches the daemon through wsl.exe and docker system dial-stdio.
# A BB server on another machine uses SSH on the PC's own address. See README.md.
#
# Run it in PowerShell 7.4 or later as an administrator, signed in as the
# Windows user who will own the distribution, from a copy of this directory:
#
#   .\setup.ps1 -Key "ssh-ed25519 AAAA... bb@server"
#
# -Key is the public SSH key of the user BB runs as on BB's server, which
# the docker CLI logs in with. Running it again keeps the distribution, its
# images and its running boxes, updates its packages and replaces the key.
#Requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Key,
  # The distribution, and the Linux user bb-box logs in as.
  [string] $Name = "bbdocker",
  [string] $User = "box",
  # Windows' own OpenSSH keeps port 22.
  [int] $Port = 2222,
  [string] $Path = "C:\WSL\bbdocker",
  # Memory for the whole WSL VM, such as 24GB. Empty keeps WSL's default:
  # half the PC's memory.
  [string] $Memory = "",
  [string] $Image = "https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl",
  [string] $ImageSha256 = "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e"
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# wsl.exe's own messages in UTF-8 rather than UTF-16.
$env:WSL_UTF8 = "1"
$clock = [Diagnostics.Stopwatch]::StartNew()
function Step([string] $what) { "{0,6:N1} s  {1}" -f $clock.Elapsed.TotalSeconds, $what }
function Wsl { & wsl.exe @args; if ($LASTEXITCODE) { throw "wsl.exe $args failed ($LASTEXITCODE)" } }
# A download that gives up on a stalled connection, and tries again.
function Download([string] $uri, [string] $file) {
  for ($try = 1; ; $try++) {
    try { Invoke-WebRequest $uri -OutFile $file -ConnectionTimeoutSeconds 30 -OperationTimeoutSeconds 60; return }
    catch { if ($try -ge 3) { throw } else { Start-Sleep 5 } }
  }
}

$me = [Security.Principal.WindowsIdentity]::GetCurrent()
$admin = [Security.Principal.WindowsPrincipal]::new($me)
if (-not $admin.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw "Run it as an administrator." }
# Mirrored networking needs Windows 11 22H2 (build 22621) or later.
if ([Environment]::OSVersion.Version.Build -lt 22621) { throw "Windows 11 22H2 or later is needed, for WSL's mirrored networking." }

# 1. The Virtual Machine Platform, which WSL 2 runs on.
if ((Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform).State -ne "Enabled") {
  Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All -NoRestart | Out-Null
  Step "Turned on the Virtual Machine Platform. Restart Windows, then run this again."
  exit 3
}

# 2. WSL itself, from its GitHub release: `wsl --install` fails at once
# in an SSH session.
& wsl.exe --version *> $null
if ($LASTEXITCODE) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $release = Invoke-RestMethod -Uri https://api.github.com/repos/microsoft/WSL/releases/latest
  $asset = $release.assets | Where-Object name -like "wsl.*.$arch.msi" | Select-Object -First 1
  $msi = Join-Path $env:TEMP $asset.name
  Download $asset.browser_download_url $msi
  $install = Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait -PassThru
  if ($install.ExitCode) { throw "Installing WSL $($release.tag_name) failed ($($install.ExitCode))." }
  Remove-Item $msi
  Step "Installed WSL $($release.tag_name)"
}

# 3. The WSL VM: on the PC's own addresses, never stopped when idle, and
# without WSLg, whose compositor crashes with nobody signed in. These apply
# to all of this user's distributions.
$config = Join-Path $env:USERPROFILE ".wslconfig"
$lines = [Collections.Generic.List[string]]::new()
if (Test-Path $config) { $lines.AddRange([string[]](Get-Content $config)) }
$before = $lines -join "`n"
function Set-Ini([string] $section, [string] $name, [string] $value) {
  $start = $lines.FindIndex({ param($l) $l.Trim() -ieq "[$section]" })
  if ($start -lt 0) { $lines.Add("[$section]"); $lines.Add("$name=$value"); return }
  $end = $lines.FindIndex($start + 1, { param($l) $l.Trim().StartsWith("[") })
  if ($end -lt 0) { $end = $lines.Count }
  for ($i = $start + 1; $i -lt $end; $i++) {
    if ($lines[$i] -match "^\s*$([regex]::Escape($name))\s*=") { $lines[$i] = "$name=$value"; return }
  }
  $lines.Insert($end, "$name=$value")
}
Set-Ini wsl2 networkingMode mirrored
Set-Ini wsl2 vmIdleTimeout -1
Set-Ini wsl2 guiApplications false
if ($Memory) { Set-Ini wsl2 memory $Memory }
Set-Ini general instanceIdleTimeout -1
Set-Content -Path $config -Value $lines
Step "Wrote $config"
# WSL reads it only when its VM starts.
$running = @(& wsl.exe --list --running --quiet 2>$null | Where-Object { $_.Trim() })
$restart = ($lines -join "`n") -ne $before -and $LASTEXITCODE -eq 0 -and $running.Count -gt 0

# 4. The distribution: Ubuntu's WSL image, checked against its SHA-256.
$names = (& wsl.exe --list --quiet) -split "`r?`n" | ForEach-Object { $_.Trim() }
if ($names -notcontains $Name) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  $file = Join-Path $Path ([IO.Path]::GetFileName($Image))
  Download $Image $file
  if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $ImageSha256) { throw "$file does not match its SHA-256." }
  Step "Downloaded $Image"
  Wsl --import $Name $Path $file --version 2
  Remove-Item $file
  Step "Imported $Name into $Path"
}

# 5. Inside it: systemd first, then Docker Engine and sshd. The
# distribution restarts only when its wsl.conf changed, since a restart
# stops every box in it.
$guest = (& wsl.exe -d $Name -u root --exec wslpath -u (Join-Path $PSScriptRoot "guest.sh")).Trim()
if ((Wsl -d $Name -u root --exec bash $guest conf $User) -eq "changed") { Wsl --terminate $Name | Out-Null }
Wsl -d $Name -u root --exec bash $guest install $User $Port $Key.Trim()
Step "Set up Docker Engine and sshd in $Name"

# 6. Let SSH through the Hyper-V firewall, which filters WSL's traffic.
$wslVm = "{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}"
$rule = "bb-box-docker-wsl-ssh"
Remove-NetFirewallHyperVRule -Name $rule -ErrorAction SilentlyContinue
New-NetFirewallHyperVRule -Name $rule -DisplayName "bb-box: SSH to $Name" -Direction Inbound `
  -VMCreatorId $wslVm -Protocol TCP -LocalPorts $Port -Action Allow -ErrorAction Stop | Out-Null
Step "Opened TCP port $Port in the Hyper-V firewall"

# 7. Start the distribution when Windows starts, before anyone signs in,
# and keep a process in it so WSL never stops it. The task tries again
# each minute, and does nothing while it runs, so the distribution comes
# back within a minute after `wsl --shutdown` or a WSL update. At startup
# it waits until Windows has been up a minute: a WSL VM started sooner got
# its mirrored network only 3 minutes later. Windows PowerShell runs the
# wait, since it is always at the same path. In an SSH session USERDOMAIN
# is WORKGROUP, so the task names the account from its token.
$task = "bb-box WSL Docker host"
$start = "`$up = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime; " +
  "if (`$up.TotalSeconds -lt 60) { Start-Sleep -Seconds (60 - `$up.TotalSeconds) }; " +
  "$env:SystemRoot\System32\wsl.exe -d $Name -u root --exec /bin/sleep infinity"
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -Argument "-NoProfile -NonInteractive -Command $start"
$principal = New-ScheduledTaskPrincipal -UserId $me.Name -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew -StartWhenAvailable
$triggers = @(
  New-ScheduledTaskTrigger -AtStartup
  New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
)
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings `
  -Trigger $triggers -Force -ErrorAction Stop | Out-Null
if ((Get-ScheduledTask -TaskName $task -ErrorAction Stop).State -ne "Running") { Start-ScheduledTask -TaskName $task -ErrorAction Stop }
Step "Registered the scheduled task '$task'"

$addresses = Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Dhcp, Manual -ErrorAction SilentlyContinue |
  Where-Object IPAddress -notlike "169.254.*" | Select-Object -ExpandProperty IPAddress
""
if ($restart) {
  "WSL's settings changed while it ran. To apply them, run 'wsl --shutdown' when no box is busy:"
  "it stops every box, and the scheduled task starts $Name again within a minute."
}
"Done. When BB runs on this PC, set the Docker backend host to wsl://$Name"
"dockerd listens on its unix socket. Do not publish 127.0.0.1:2375: WSL's localhost forwarder drops attached output."
"When BB runs on another machine, set host to ssh://${User}@<this PC>:${Port}"
"This PC: $env:COMPUTERNAME, $($addresses -join ', ')"
