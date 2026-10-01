# Runs at box's logon in its desktop session, by the task "bb-box
# accessibility", so Cua sees a browser page's content however Edge or Chrome
# was started. Without it Edge shows Cua only its toolbar.
#
# It sets Windows' screen-reader flag, which Chromium browsers watch to build
# their full accessibility tree, and adds --force-renderer-accessibility to
# Edge's shortcuts: box's taskbar pins here, and with -Shortcuts the folders
# given (the first logon passes the shared Desktop and Start menu).
param([string[]]$Shortcuts = @("$env:APPDATA\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar", "$env:USERPROFILE\Desktop"))
Add-Type -Namespace BbBox -Name Spi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint action, uint param, System.IntPtr vparam, uint winini);'
# SPI_SETSCREENREADER, sent to running windows too (SPIF_SENDCHANGE).
[BbBox.Spi]::SystemParametersInfo(0x0047, 1, [IntPtr]::Zero, 0x2) | Out-Null

$shell = New-Object -ComObject WScript.Shell
foreach ($folder in ($Shortcuts | Where-Object { $_ -and (Test-Path $_) })) {
  foreach ($file in Get-ChildItem $folder -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue) {
    try {
      $link = $shell.CreateShortcut($file.FullName)
      if ($link.TargetPath -match 'msedge\.exe$' -and $link.Arguments -notmatch 'force-renderer-accessibility') {
        $link.Arguments = "--force-renderer-accessibility $($link.Arguments)".Trim()
        $link.Save()
      }
    } catch { }
  }
}
