# The check prepare-windows-image.sh puts in the Windows template's check.ps1
# (../../windows/check.ps1) in place of its address check, as a box on a
# Mac takes its address from QEMU: that clock.ps1 ran.
Check 'clock from QEMU in UTC, synced' {
  $rtc = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation').RealTimeIsUniversal
  $poll = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\W32Time\TimeProviders\NtpClient').SpecialPollInterval
  $start = (Get-Service W32Time).StartType
  if ($rtc -ne 1 -or $poll -ne 900 -or "$start" -ne 'Automatic') { throw "RealTimeIsUniversal $rtc, poll $poll s, W32Time $start" }
  "RealTimeIsUniversal 1, poll every $poll s"
}
