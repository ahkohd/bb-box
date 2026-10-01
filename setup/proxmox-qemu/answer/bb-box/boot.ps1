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
  $nic = Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | Select-Object -First 1
  if (-not $nic) { Start-Sleep -Milliseconds 250 }
}
if (-not $nic) { Log 'no network adapter came up'; exit 1 }
$current = @(Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object PrefixOrigin -eq 'Manual')
if ($current.IPAddress -contains $ip) { Log "address $ip already set"; exit 0 }
Set-NetIPInterface -InterfaceIndex $nic.ifIndex -Dhcp Disabled
Get-NetIPAddress -InterfaceIndex $nic.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Remove-NetIPAddress -Confirm:$false
Remove-NetRoute -InterfaceIndex $nic.ifIndex -DestinationPrefix 0.0.0.0/0 -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceIndex $nic.ifIndex -IPAddress $ip -PrefixLength $prefix -DefaultGateway $Gateway | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $nic.ifIndex -ServerAddresses $Dns
Log "address $ip/$prefix, gateway $Gateway, DNS $($Dns -join ' ')"
