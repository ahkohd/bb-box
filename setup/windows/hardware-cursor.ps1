# Turns on the VirtIO GPU driver's hardware cursor (060), from the image's
# first logon and from its refresh, elevated:
#
#   hardware-cursor.ps1
#
# The driver's INF sets HWCursor to 0, so Windows draws the pointer into the
# desktop image, and Desktop Duplication returns it there: bb-box-stream
# cannot then leave it out of the video while a person holds control. With
# HWCursor 1 in the display device's 2 keys, and the device restarted,
# Desktop Duplication leaves it out, and bb-box-stream draws it in when asked.
# QEMU's VNC then sends the pointer as a cursor shape, not in the picture.
# Does nothing where there is no VirtIO GPU.
$ErrorActionPreference = 'Stop'
$devices = @(Get-PnpDevice -Class Display -PresentOnly -ErrorAction SilentlyContinue | Where-Object {
  (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_Device_Service).Data -eq 'VioGpuDod'
})
if (-not $devices.Count) { 'hardware cursor: no VirtIO GPU'; return }
foreach ($device in $devices) {
  # The driver's key, and the video key Windows reads the display's settings from.
  $driver = (Get-PnpDeviceProperty -InstanceId $device.InstanceId -KeyName DEVPKEY_Device_Driver).Data
  $keys = @("HKLM:\SYSTEM\CurrentControlSet\Control\Class\$driver")
  $video = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Enum\$($device.InstanceId)\Device Parameters" -ErrorAction SilentlyContinue).VideoID
  if ($video) { $keys += "HKLM:\SYSTEM\CurrentControlSet\Control\Video\$video\0000" }
  $changed = $false
  foreach ($key in $keys) {
    if (-not (Test-Path $key)) { throw "no $key" }
    if ((Get-ItemProperty $key).HWCursor -ne 1) {
      New-ItemProperty $key -Name HWCursor -Value 1 -PropertyType DWord -Force | Out-Null
      $changed = $true
    }
  }
  if (-not $changed) { "hardware cursor: on already ($($device.FriendlyName))"; continue }
  # The driver reads it as it starts: a restart of the device, with no restart of Windows.
  $out = pnputil /restart-device "$($device.InstanceId)" 2>&1
  if ($LASTEXITCODE -notin 0, 3010) { throw "pnputil could not restart $($device.FriendlyName): $out" }
  "hardware cursor: on ($($device.FriendlyName))"
}
