# Installs bb-box-stream.exe (060), a Windows box's desktop as H.264 video,
# from the image's first logon and from its refresh, elevated:
#
#   install-stream.ps1 -Source <bb-box-stream.cs> [-Archive <openh264 .dll.bz2> -Version <version>]
#
# With an archive, it puts Cisco's OpenH264 beside the program first: the
# pinned .dll.bz2, downloaded from Cisco, unpacked with Git for Windows'
# bzip2. It compiles the program with the C# compiler of .NET Framework 4.8,
# which every Windows 11 has, and registers the task that starts the server in
# box's desktop session, which the program's connect runs.
param([Parameter(Mandatory)] [string] $Source, [string] $Archive, [string] $Version)
$ErrorActionPreference = 'Stop'
$to = 'C:\Program Files\bb-box-tools\bb-box-stream'
New-Item -ItemType Directory -Force $to | Out-Null
# A running server holds its program and the library.
Stop-ScheduledTask -TaskName bb-box-stream -ErrorAction SilentlyContinue
Get-Process bb-box-stream -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

if ($Archive) {
  $bzip2 = 'C:\Program Files\Git\usr\bin\bzip2.exe'
  if (-not (Test-Path $bzip2)) { throw "no $bzip2 to unpack OpenH264 with" }
  $dll = Join-Path (Split-Path $Archive) 'openh264.dll'
  Remove-Item $dll -ErrorAction SilentlyContinue
  & cmd.exe /c "`"$bzip2`" -dc `"$Archive`" > `"$dll`""
  if ($LASTEXITCODE -or -not (Test-Path $dll)) { throw "bzip2 could not unpack $Archive" }
  Move-Item $dll "$to\openh264.dll" -Force
  Set-Content "$to\openh264.version" $Version
}

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$out = & $csc /nologo /optimize /unsafe /platform:x64 /r:System.Drawing.dll /r:System.Windows.Forms.dll "/out:$to\bb-box-stream.exe" $Source 2>&1
if ($LASTEXITCODE) { throw "csc could not compile bb-box-stream.exe: $out" }
# What the program was built from, so a refresh builds it again only when its source changes.
Set-Content "$to\bb-box-stream.source" (Get-FileHash $Source -Algorithm SHA256).Hash

# The server runs as box in box's desktop session, unelevated, started on demand; it writes to its log there.
$exe = "$to\bb-box-stream.exe"
$command = "--headless cmd.exe /c `"(if not exist `"%LOCALAPPDATA%\bb-box`" mkdir `"%LOCALAPPDATA%\bb-box`") & `"$exe`" serve > `"%LOCALAPPDATA%\bb-box\stream.log`" 2>&1`""
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" -Argument $command
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\box" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName bb-box-stream -Action $action -Principal $principal -Settings $settings -Force | Out-Null
