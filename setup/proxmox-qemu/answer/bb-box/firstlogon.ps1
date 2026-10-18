# The Windows template's first logon, as box with an elevated token, from the
# answer file. Reads C:\bb-box\build.json, which build.sh writes, and deletes
# it at the end, since it holds the password. Logs to C:\bb-box\firstlogon.log,
# writes C:\bb-box\firstlogon-done and restarts.
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
Start-Transcript -Path C:\bb-box\firstlogon.log -Append | Out-Null
function Step($text) { Write-Output "$(Get-Date -Format HH:mm:ss) $text" }
# New-Item -Force would empty a registry key that exists, so only make missing ones.
function Set-Reg($path, $name, $value, $type = 'DWord') {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null
}
# Downloads a pinned file and checks its SHA-256, trying a few times.
function Get-Pinned($url, $sha256, $out) {
  for ($try = 1; $try -le 5; $try++) {
    try {
      Invoke-WebRequest $url -OutFile $out -UseBasicParsing -ErrorAction Stop
      if ((Get-FileHash $out -Algorithm SHA256).Hash -eq $sha256) { return }
      Step "$url does not match its SHA-256 (try $try)"
    } catch { Step "could not download $url (try $try): $_" }
    Remove-Item $out -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
  }
  throw "could not download $url with its SHA-256"
}
# A task in box's desktop session at logon, with no console window.
function Register-LogonTask($name, $command, $level) {
  $user = "$env:COMPUTERNAME\box"
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument "--headless $command"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel $level
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}

# A step that fails stops the script and leaves C:\bb-box\firstlogon-failed,
# which build.sh watches for, so a failed build ends at once.
trap {
  Step "FAILED: $_"
  Set-Content C:\bb-box\firstlogon-failed "$_"
  Stop-Transcript | Out-Null
  break
}

$build = Get-Content C:\bb-box\build.json -Raw | ConvertFrom-Json

Step 'VirtIO drivers and the QEMU guest agent'
$virtio = Get-PSDrive -PSProvider FileSystem | Where-Object { Test-Path (Join-Path $_.Root 'virtio-win-gt-x64.msi') } | Select-Object -First 1
if ($virtio) {
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($virtio.Root)virtio-win-gt-x64.msi`" /qn /norestart"
  Start-Process msiexec.exe -Wait -ArgumentList "/i `"$($virtio.Root)guest-agent\qemu-ga-x86_64.msi`" /qn /norestart"
} else { Step 'No virtio-win disc found' }

Step "Build address $($build.address)"
& C:\bb-box\boot.ps1 -Address $build.address -Gateway $build.gateway -Dns $build.dns
# The downloads below need the network the address has just brought up.
for ($i = 0; $i -lt 60 -and -not (Resolve-DnsName github.com -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Seconds 2 }

Step "PowerShell $($build.pwsh.version)"
$msi = "C:\bb-box\pwsh.msi"
Get-Pinned $build.pwsh.url $build.pwsh.sha256 $msi
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msi`" /qn /norestart ADD_PATH=1 USE_MU=0 ENABLE_MU=0 ENABLE_PSREMOTING=0 ADD_EXPLORER_CONTEXT_MENU_OPENPOWERSHELL=0"
Remove-Item $msi -Force
$pwsh = 'C:\Program Files\PowerShell\7\pwsh.exe'

Step 'OpenSSH Server'
$capability = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1
if ($capability -and $capability.State -ne 'Installed') { Add-WindowsCapability -Online -Name $capability.Name | Out-Null }
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  Step 'No sshd from the capability: Win32-OpenSSH from GitHub'
  $release = Invoke-RestMethod https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest
  $asset = $release.assets | Where-Object name -like 'OpenSSH-Win64-*.msi' | Select-Object -First 1
  Invoke-WebRequest $asset.browser_download_url -OutFile C:\bb-box\openssh.msi
  Start-Process msiexec.exe -Wait -ArgumentList '/i C:\bb-box\openssh.msi /qn'
  Remove-Item C:\bb-box\openssh.msi -Force
}
Set-Reg 'HKLM:\SOFTWARE\OpenSSH' DefaultShell $pwsh String
Set-Service sshd -StartupType Automatic
Start-Service sshd
# Keys for members of Administrators are read from here, not from the user's home.
$keys = 'C:\ProgramData\ssh\administrators_authorized_keys'
Set-Content -Path $keys -Value ($build.keys -join "`n") -Encoding ascii
icacls.exe $keys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null
# Windows puts the box network in the Public profile; the capability's rule allows only Private.
if (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue) {
  Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Profile Any -Enabled True
} else {
  New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Profile Any -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
}

Step "Git $($build.git.version) and GitHub CLI $($build.gh.version)"
$exe = 'C:\bb-box\git.exe'
Get-Pinned $build.git.url $build.git.sha256 $exe
# On PATH for every shell. No credential manager: its sign-in window would
# wait in the desktop for a person while a command over SSH hangs.
Start-Process $exe -Wait -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/o:PathOption=Cmd', '/o:CredentialManager=Disabled'
Remove-Item $exe -Force
$msi = 'C:\bb-box\gh.msi'
Get-Pinned $build.gh.url $build.gh.sha256 $msi
Start-Process msiexec.exe -Wait -ArgumentList "/i `"$msi`" /qn /norestart"
Remove-Item $msi -Force
# Plain output for agents' commands, as the backend's command prelude asks too.
[Environment]::SetEnvironmentVariable('NO_COLOR', '1', 'Machine')

Step "Node.js $($build.node.version)"
# BB's installer for Windows needs it (#539), and Linux boxes have it.
$zip = 'C:\bb-box\node.zip'
Get-Pinned $build.node.url $build.node.sha256 $zip
$dir = 'C:\Program Files\nodejs'
Expand-Archive $zip -DestinationPath C:\bb-box\node -Force
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Get-ChildItem C:\bb-box\node -Directory | Select-Object -First 1).FullName $dir
Remove-Item C:\bb-box\node, $zip -Recurse -Force
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notlike "*$dir*") { [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'Machine') }

Step "Claude Code $($build.claude.version), Codex $($build.codex.version) and Pi $($build.pi.version)"
# The agent CLIs, as Linux boxes have them, each in a directory of its own on
# the machine's PATH (#561). Claude Code gets its PowerShell tool, on PowerShell 7.
foreach ($tool in @(@{ name = 'claude'; exe = 'claude.exe'; pin = $build.claude }, @{ name = 'codex'; exe = 'codex.exe'; pin = $build.codex }, @{ name = 'pi'; exe = 'pi.exe'; pin = $build.pi })) {
  $to = "C:\Program Files\bb-box-tools\$($tool.name)"
  $file = "C:\bb-box\$([IO.Path]::GetFileName(([Uri] $tool.pin.url).AbsolutePath))"
  Get-Pinned $tool.pin.url $tool.pin.sha256 $file
  New-Item -ItemType Directory -Force $to | Out-Null
  if ($file -like '*.zip') { Expand-Archive $file -DestinationPath $to -Force } else { Copy-Item $file "$to\$($tool.exe)" }
  Remove-Item $file -Force
  if (-not (Test-Path "$to\$($tool.exe)")) { throw "$($tool.name) has no $($tool.exe)" }
  $path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  if ($path -notlike "*$to*") { [Environment]::SetEnvironmentVariable('Path', "$path;$to", 'Machine') }
}
[Environment]::SetEnvironmentVariable('CLAUDE_CODE_USE_POWERSHELL_TOOL', '1', 'Machine')

Step "ffmpeg $($build.ffmpeg.version)"
# box_record's recorder (059): ffmpeg and ffprobe, from the archive's bin, in
# a directory of their own on the machine's PATH.
$zip = 'C:\bb-box\ffmpeg.zip'
Get-Pinned $build.ffmpeg.url $build.ffmpeg.sha256 $zip
Expand-Archive $zip -DestinationPath C:\bb-box\ffmpeg -Force
$bin = (Get-ChildItem C:\bb-box\ffmpeg -Recurse -Filter ffmpeg.exe | Select-Object -First 1).Directory.FullName
$to = 'C:\Program Files\bb-box-tools\ffmpeg'
New-Item -ItemType Directory -Force $to | Out-Null
Copy-Item "$bin\ffmpeg.exe", "$bin\ffprobe.exe" $to
Remove-Item C:\bb-box\ffmpeg, $zip -Recurse -Force
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notlike "*$to*") { [Environment]::SetEnvironmentVariable('Path', "$path;$to", 'Machine') }

# The desktop as video (060), where the build pins OpenH264, as both builds
# do: Cisco's x64 build here, and its arm64 one in Tart's
# prepare-windows-image.sh.
if ($build.openh264) {
  Step "bb-box-stream.exe, with OpenH264 $($build.openh264.version)"
  # Cisco's OpenH264, downloaded from Cisco as its licence asks, and the
  # program, compiled here, with its task in box's desktop session. Git's
  # bzip2 unpacks the library, so Git comes first.
  $archive = 'C:\bb-box\openh264.dll.bz2'
  Get-Pinned $build.openh264.url $build.openh264.sha256 $archive
  & C:\bb-box\install-stream.ps1 -Source C:\bb-box\bb-box-stream.cs -Archive $archive -Version $build.openh264.version
  Remove-Item $archive
  # The pointer as the display's hardware cursor, so bb-box-stream can leave
  # it out of the video while a person holds control.
  & C:\bb-box\hardware-cursor.ps1
} else {
  Step 'bb-box-stream.exe: none, as the build pins no OpenH264'
}

Step "Visual Studio Build Tools $($build.vs.version): $($build.vs.components -join ', ')"
# The C++ build tools and the Windows SDK, which Rust's MSVC toolchain links
# with. A fixed-version bootstrapper installs that version's components.
$exe = 'C:\bb-box\vs_BuildTools.exe'
Get-Pinned $build.vs.url $build.vs.sha256 $exe
$arguments = @('--quiet', '--wait', '--norestart', '--nocache') + ($build.vs.components | ForEach-Object { '--add', $_ }) + '--includeRecommended'
$vs = Start-Process $exe -Wait -PassThru -ArgumentList $arguments
# 3010: installed, and Windows wants a restart, which comes at the end.
if ($vs.ExitCode -notin 0, 3010) { throw "Visual Studio Build Tools exited with $($vs.ExitCode); see %TEMP%\dd_*.log" }
Remove-Item $exe -Force

Step "LLVM $($build.llvm.version)"
# clang for crates that build C with it (ring on arm64), and libclang for bindgen.
$msi = 'C:\bb-box\llvm.msi'
Get-Pinned $build.llvm.url $build.llvm.sha256 $msi
$llvm = Start-Process msiexec.exe -Wait -PassThru -ArgumentList "/i `"$msi`" /qn /norestart"
if ($llvm.ExitCode -notin 0, 3010) { throw "LLVM's installer exited with $($llvm.ExitCode)" }
Remove-Item $msi -Force
$dir = 'C:\Program Files\LLVM\bin'
if (-not (Test-Path "$dir\clang.exe")) { throw "LLVM did not install $dir\clang.exe" }
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notlike "*$dir*") { [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'Machine') }

Step "Rust: rustup $($build.rustup.version) and the stable MSVC toolchain, for box"
# In box's profile, as on Linux boxes. rustup adds ~\.cargo\bin to box's own
# PATH, which new shells, SSH's included, read. Projects' rust-toolchain.toml
# files pull their own toolchains on first use.
$exe = 'C:\bb-box\rustup-init.exe'
Get-Pinned $build.rustup.url $build.rustup.sha256 $exe
for ($try = 1; $try -le 3; $try++) {
  & $exe -y -q --profile minimal --default-toolchain stable -c rustfmt -c clippy 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { break }
  if ($try -eq 3) { throw "rustup could not install the stable toolchain (exit $LASTEXITCODE)" }
  Step "rustup failed (exit $LASTEXITCODE, try $try); trying again"
  Start-Sleep -Seconds 10
}
Remove-Item $exe -Force
if ([Environment]::GetEnvironmentVariable('Path', 'User') -notlike '*\.cargo\bin*') { throw "rustup did not put ~\.cargo\bin on box's PATH" }

Step 'UTF-8 as the system code page'
foreach ($name in 'ACP', 'OEMCP', 'MACCP') { Set-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' -Name $name -Value '65001' }

Step 'Standard font smoothing, not ClearType'
# The desktop as video (060): ClearType's coloured fringes are what 4:2:0 H.264
# loses, and text with them scored an SSIM of 0.979 against 0.999 without.
Set-Reg 'HKCU:\Control Panel\Desktop' FontSmoothing '2' String
Set-Reg 'HKCU:\Control Panel\Desktop' FontSmoothingType 1

Step 'Automatic logon; no lock screen, sleep, screen saver, UAC prompt, updates, OneDrive or first-run screens'
$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-Reg $winlogon AutoAdminLogon '1' String
Set-Reg $winlogon DefaultUserName 'box' String
Set-Reg $winlogon DefaultPassword $build.password String
Remove-ItemProperty -Path $winlogon -Name AutoLogonCount -ErrorAction SilentlyContinue
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' DevicePasswordLessBuildVersion 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' NoLockScreen 1
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' ConsentPromptBehaviorAdmin 0
Set-Reg 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' PromptOnSecureDesktop 0
Set-Reg 'HKLM:\SYSTEM\CurrentControlSet\Control\BitLocker' PreventDeviceEncryption 1
Set-Reg 'HKCU:\Control Panel\Desktop' ScreenSaveActive '0' String
Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' ScoobeSystemSettingEnabled 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoUpdate 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' NoAutoRebootWithLoggedOnUsers 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore' AutoDownload 2
# OneDrive does not start at sign-in, nor ask to back the box up, which would
# show over the desktop the agent uses and records (#707). The policy holds
# whatever OneDrive's own setup, Run entry and startup task do.
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive' DisableFileSyncNGSC 1
powercfg.exe /change standby-timeout-ac 0
powercfg.exe /change monitor-timeout-ac 0
powercfg.exe /change hibernate-timeout-ac 0
# No hibernation in the guest, so no Fast Startup: a shutdown is a full one, and
# a clone boots afresh. Proxmox's own hibernation of a box does not need it.
powercfg.exe /hibernate off
powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg.exe /setactive SCHEME_CURRENT

Step 'Edge: its whole page in the accessibility tree'
# A running Edge ignores new flags, so it must not stay running in the background.
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' HideFirstRunExperience 1
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' StartupBoostEnabled 0
Set-Reg 'HKLM:\SOFTWARE\Policies\Microsoft\Edge' BackgroundModeEnabled 0
# Links and URLs open Edge through its handler, which then passes the flag.
$handler = 'HKLM:\SOFTWARE\Classes\MSEdgeHTM\shell\open\command'
$open = (Get-ItemProperty $handler -ErrorAction SilentlyContinue).'(default)'
if ($open -and $open -notmatch 'force-renderer-accessibility') {
  Set-ItemProperty $handler -Name '(default)' -Value ($open -replace '(msedge\.exe"?)', '$1 --force-renderer-accessibility')
}
# Edge's own shortcuts pass the flag too; logon.ps1 does the same for box's taskbar pins.
& C:\bb-box\logon.ps1 -Shortcuts "$env:PUBLIC\Desktop", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs"
# The screen-reader flag, set at each logon, turns Chromium's full tree on however it starts.
Register-LogonTask 'bb-box accessibility' "`"$pwsh`" -NoProfile -NonInteractive -File C:\bb-box\logon.ps1" Limited

Step "Cua Driver $($build.cua.version)"
$zip = 'C:\bb-box\cua.zip'
Get-Pinned $build.cua.url $build.cua.sha256 $zip
$dir = 'C:\Program Files\CuaDriver'
Expand-Archive $zip -DestinationPath C:\bb-box\cua -Force
Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
Move-Item (Get-ChildItem C:\bb-box\cua -Directory | Select-Object -First 1).FullName $dir
Remove-Item C:\bb-box\cua, $zip -Recurse -Force
[Environment]::SetEnvironmentVariable('CUA_DRIVER_RS_TELEMETRY_ENABLED', 'false', 'Machine')
[Environment]::SetEnvironmentVariable('CUA_DRIVER_RS_UPDATE_CHECK', 'false', 'Machine')
$path = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if ($path -notlike "*$dir*") { [Environment]::SetEnvironmentVariable('Path', "$path;$dir", 'Machine') }
$env:CUA_DRIVER_RS_TELEMETRY_ENABLED = 'false'
& "$dir\cua-driver.exe" telemetry disable 2>&1 | Out-Null
# Elevated: its pipe accepts only its own account, and an elevated SSH client
# cannot reach a daemon that is not. The apps it opens still run unelevated.
Register-LogonTask 'bb-box cua-driver' "`"$dir\cua-driver.exe`" serve" Highest

Step 'The box address at each boot, from the SMBIOS serial'
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument '-NoProfile -ExecutionPolicy Bypass -File C:\bb-box\boot.ps1'
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'bb-box address' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Set-Content C:\bb-box\dns.txt ($build.dns -join ' ')

# The image's record (049), which the build gives as JSON text.
if ($build.record) {
  Step 'The image record, C:\bb-box\image.json'
  [IO.File]::WriteAllText('C:\bb-box\image.json', "$($build.record)`n")
}

Step 'Done: restarting'
Remove-Item C:\bb-box\build.json -Force
Set-Content C:\bb-box\firstlogon-done (Get-Date -Format o)
Stop-Transcript | Out-Null
shutdown.exe /r /t 10 /c 'bb-box first logon done'
