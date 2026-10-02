# Windows' clock in a VM that QEMU runs on a Mac (046). Run as SYSTEM in
# Windows Setup's specialize pass, from the answer file as
# prepare-windows-image.sh adapts it. QEMU's real-time clock is UTC, so
# Windows reads it as UTC whatever a box's time zone. The time service syncs
# about every 17 minutes and corrects any offset, as a Mac that slept leaves
# a running box behind; bb-box sets the clock itself after it restores a box.
$ErrorActionPreference = 'Stop'
Start-Transcript -Path C:\bb-box\clock.log -Append | Out-Null
$w32time = 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time'
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation' RealTimeIsUniversal 1 -Type DWord
Set-ItemProperty "$w32time\Parameters" Type NTP
# 0x9: a client that polls every SpecialPollInterval seconds.
Set-ItemProperty "$w32time\Parameters" NtpServer 'time.windows.com,0x9'
# 900 s, which Windows raises to its shortest poll (MinPollInterval): 1024 s.
Set-ItemProperty "$w32time\TimeProviders\NtpClient" SpecialPollInterval 900 -Type DWord
# Any offset, however large: a stand-alone Windows corrects only up to 15 hours.
Set-ItemProperty "$w32time\Config" MaxPosPhaseCorrection 0xFFFFFFFF -Type DWord
Set-ItemProperty "$w32time\Config" MaxNegPhaseCorrection 0xFFFFFFFF -Type DWord
Set-Service W32Time -StartupType Automatic
Stop-Transcript | Out-Null
