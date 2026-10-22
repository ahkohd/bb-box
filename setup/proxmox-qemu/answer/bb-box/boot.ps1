# Gives the VM its address. At each boot, run as SYSTEM by the task
# "bb-box address", it reads the address from the SMBIOS serial, which the
# backend sets on each box as "10.200.0.12/24 10.200.0.1": the address with its
# prefix, then the gateway (qm set --smbios1 base64=1,serial=<base64>). With no
# such serial it leaves the network alone, on DHCP in the template. The first
# logon passes the build's address as parameters. Logs to C:\bb-box\boot.log
# with the time since boot, to show how early it runs.
param([string]$Address, [string]$Gateway, [string[]]$Dns)
$log = 'C:\bb-box\boot.log'
$booted = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
function Log($text) { Add-Content $log ('{0} +{1:0.0}s {2}' -f (Get-Date -Format o), ((Get-Date) - $booted).TotalSeconds, $text) }

if (-not $Address) {
  $serial = (Get-CimInstance Win32_BIOS).SerialNumber
  if ($serial -notmatch '^(\d+\.\d+\.\d+\.\d+/\d+) (\d+\.\d+\.\d+\.\d+)$') { Log 'no address in the SMBIOS serial'; exit 0 }
  $Address, $Gateway = $Matches[1], $Matches[2]
}
if (-not $Dns) { $Dns = if (Test-Path C:\bb-box\dns.txt) { (Get-Content C:\bb-box\dns.txt -Raw).Trim() -split '\s+' } else { '1.1.1.1', '9.9.9.9' } }
$ip, $prefix = $Address -split '/'
Log "started: $ip/$prefix via $Gateway"

$nic = $null
for ($i = 0; $i -lt 120 -and -not $nic; $i++) {
  $nic = Get-CimInstance Win32_NetworkAdapter -Filter 'PhysicalAdapter=True AND NetConnectionStatus=2' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nic) { Start-Sleep -Milliseconds 250 }
}
if (-not $nic) { Log 'no network adapter came up'; exit 1 }
$index = $nic.InterfaceIndex
Log "adapter $index is up"
$config = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "InterfaceIndex=$index"
if (-not $config.DHCPEnabled -and $config.IPAddress -contains $ip) { Log "address $ip already set"; exit 0 }
$mask = (0..3 | ForEach-Object { 256 - [math]::Pow(2, 8 - [math]::Max(0, [math]::Min(8, [int]$prefix - 8 * $_))) }) -join '.'
netsh interface ipv4 set address name=$index source=static address=$ip mask=$mask gateway=$Gateway gwmetric=1 | Out-Null
if ($LASTEXITCODE) { Log "netsh could not set $ip/$prefix"; exit 1 }
netsh interface ipv4 set dnsservers name=$index source=static address=$($Dns[0]) register=none validate=no | Out-Null
for ($n = 1; $n -lt $Dns.Count; $n++) { netsh interface ipv4 add dnsservers name=$index address=$($Dns[$n]) index=$($n + 1) validate=no | Out-Null }
Log "address $ip/$prefix, gateway $Gateway, DNS $($Dns -join ' ')"
