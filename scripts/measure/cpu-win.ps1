# Windows: the whole machine's CPU each second, as cpu.sh writes it: epoch,
# busy and total centiseconds summed so far, cores.
# usage: cpu-win.ps1 <seconds> > cpu.log
param([int]$Seconds)
$cores = [Environment]::ProcessorCount; $busy = 0.0; $total = 0
$counter = "\Processor(_Total)\% Processor Time"
Get-Counter -Counter $counter -SampleInterval 1 -MaxSamples $Seconds | ForEach-Object {
  $busy += $_.CounterSamples[0].CookedValue * $cores; $total += 100 * $cores
  "{0} {1:F2} {2} {3}" -f [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(), $busy, $total, $cores
}
