param([string]$Address, [string]$Gateway, [string[]]$Dns)
$log = 'C:\bb-box\boot.log'
function Log($text) {
  $uptimeSeconds = ([long][Environment]::TickCount -band 0xFFFFFFFFL) / 1000.0
  Add-Content $log ('{0} +{1:0.0}s {2}' -f (Get-Date -Format o), $uptimeSeconds, $text)
}

function Get-SmbiosSerial {
  $raw = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\mssmbios\Data' -ErrorAction SilentlyContinue).SMBiosData
  if (-not $raw -or $raw.Length -lt 12) { return $null }
  $i = 8
  while ($i + 4 -le $raw.Length) {
    $type = $raw[$i]
    $len = $raw[$i + 1]
    if ($len -lt 4 -or $i + $len -gt $raw.Length) { break }
    $stringsStart = $i + $len
    $stringsEnd = $stringsStart
    while ($stringsEnd + 1 -lt $raw.Length -and -not ($raw[$stringsEnd] -eq 0 -and $raw[$stringsEnd + 1] -eq 0)) {
      $stringsEnd++
    }
    if ($stringsEnd + 1 -ge $raw.Length) { break }
    if ($type -eq 1 -and $len -ge 8) {
      $serialIndex = $raw[$i + 7]
      if (-not $serialIndex -or $stringsEnd -le $stringsStart) { return $null }
      $strings = [Text.Encoding]::ASCII.GetString($raw, $stringsStart, $stringsEnd - $stringsStart) -split "`0"
      if ($serialIndex -le $strings.Count) { return $strings[$serialIndex - 1] }
      return $null
    }
    $i = $stringsEnd + 2
  }
  return $null
}

function Find-BoxAdapter {
  $interfaces = [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object {
    $_.NetworkInterfaceType -eq 'Ethernet' -and
    $_.OperationalStatus -eq 'Up' -and
    $_.Description -notmatch 'Virtual|Hyper-V|TAP|Wintun'
  }
  foreach ($candidate in $interfaces) {
    try {
      $properties = $candidate.GetIPProperties()
      $ipv4 = $properties.GetIPv4Properties()
      if ($null -ne $ipv4 -and $ipv4.Index -gt 0) {
        return @{ Properties = $properties; IPv4 = $ipv4 }
      }
    } catch {
    }
  }
  return $null
}

if (-not $Address) {
  $serial = Get-SmbiosSerial
  if ($serial -notmatch '^(\d+\.\d+\.\d+\.\d+/\d+) (\d+\.\d+\.\d+\.\d+)$') { Log 'no address in the SMBIOS serial'; exit 0 }
  $Address, $Gateway = $Matches[1], $Matches[2]
}
if (-not $Dns) {
  $Dns = if (Test-Path C:\bb-box\dns.txt) { @((Get-Content C:\bb-box\dns.txt -Raw).Trim() -split '\s+' | Where-Object { $_ }) } else { @('1.1.1.1', '9.9.9.9') }
}
$ip, $prefix = $Address -split '/'
Log "started: $ip/$prefix via $Gateway"

$adapter = $null
for ($i = 0; $i -lt 3600 -and -not $adapter; $i++) {
  $adapter = Find-BoxAdapter
  if (-not $adapter) { Start-Sleep -Milliseconds 50 }
}
if (-not $adapter) { Log 'no network adapter came up'; exit 1 }

$properties = $adapter.Properties
$ipv4 = $adapter.IPv4
$index = $ipv4.Index
Log "adapter $index is up"

$assigned = @($properties.UnicastAddresses | ForEach-Object { $_.Address.IPAddressToString })
if (-not $ipv4.IsDhcpEnabled -and ($assigned -contains $ip)) { Log "address $ip already set"; exit 0 }

$mask = (0..3 | ForEach-Object { 256 - [math]::Pow(2, 8 - [math]::Max(0, [math]::Min(8, [int]$prefix - 8 * $_))) }) -join '.'
netsh interface ipv4 set interface $index dadtransmits=0 | Out-Null
if ($LASTEXITCODE) { Log "netsh could not disable IPv4 DAD on adapter $index"; exit 1 }
netsh interface ipv4 set address name=$index source=static address=$ip mask=$mask gateway=$Gateway gwmetric=1 | Out-Null
if ($LASTEXITCODE) { Log "netsh could not set $ip/$prefix"; exit 1 }
if ($Dns.Count -gt 0) {
  netsh interface ipv4 set dnsservers name=$index source=static address=$($Dns[0]) register=none validate=no | Out-Null
  if ($LASTEXITCODE) { Log "netsh could not set DNS $($Dns[0])"; exit 1 }
  for ($n = 1; $n -lt $Dns.Count; $n++) {
    netsh interface ipv4 add dnsservers name=$index address=$($Dns[$n]) index=$($n + 1) validate=no | Out-Null
    if ($LASTEXITCODE) { Log "netsh could not add DNS $($Dns[$n])"; exit 1 }
  }
}
Log "address $ip/$prefix, gateway $Gateway, DNS $($Dns -join ' ')"
