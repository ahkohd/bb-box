param([Parameter(Mandatory)] [string] $Source)
$ErrorActionPreference = 'Stop'

$dir = 'C:\bb-box'
$exe = Join-Path $dir 'bb-box-address.exe'
$sourceHashFile = Join-Path $dir 'bb-box-address.source'
$serviceName = 'bb-box-address'
$clang = 'C:\Program Files\LLVM\bin\clang.exe'

if (-not (Test-Path -LiteralPath $clang)) { throw "clang.exe not found at $clang" }
New-Item -ItemType Directory -Force $dir | Out-Null

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
}
Get-Process -Name 'bb-box-address' -ErrorAction SilentlyContinue | Stop-Process -Force

$output = & $clang -O2 $Source -o $exe 2>&1
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exe)) {
  throw "clang could not compile bb-box-address.exe: $output"
}

Set-Content -LiteralPath $sourceHashFile -Value (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash

$binPath = "$exe --service"
if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  $configured = sc.exe config $serviceName binPath= $binPath start= auto depend= nsi/Tcpip DisplayName= "BB Box Address" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "sc config $serviceName failed: $configured" }
} else {
  $created = sc.exe create $serviceName binPath= $binPath start= auto depend= nsi/Tcpip DisplayName= "BB Box Address" 2>&1
  if ($LASTEXITCODE -ne 0) { throw "sc create $serviceName failed: $created" }
}

Unregister-ScheduledTask -TaskName 'bb-box address' -Confirm:$false -ErrorAction SilentlyContinue
