param(
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][int]$AppProcessId,
  [ValidateRange(5,60)][int]$Seconds = 15,
  [string]$State = 'unspecified'
)
$ErrorActionPreference = 'Stop'
$expected = [IO.Path]::GetFullPath($Executable)
$owner = Get-Process -Id $AppProcessId
if (![string]::Equals($owner.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The application PID must match the exact validation executable.'
}
$started = $owner.StartTime
function Get-ApplicationSample {
  $rootProcess = Get-Process -Id $AppProcessId
  if ($rootProcess.StartTime -ne $started) { throw 'The application process changed during measurement.' }
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($AppProcessId)
  do {
    $changed = $false
    foreach ($p in $all) {
      if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  $rows = @($ids | ForEach-Object {
    $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
    if ($p) {
      [PSCustomObject]@{ id=$p.Id; name=$p.ProcessName; start=$p.StartTime.ToUniversalTime().ToString('o'); cpuSeconds=$p.TotalProcessorTime.TotalSeconds; privateBytes=$p.PrivateMemorySize64; workingSetBytes=$p.WorkingSet64 }
    }
  })
  [PSCustomObject]@{ at=[DateTime]::UtcNow; processes=$rows }
}
$before = Get-ApplicationSample
Start-Sleep -Seconds $Seconds
$after = Get-ApplicationSample
$elapsed = ($after.at - $before.at).TotalSeconds
$cpu = 0.0
$appCpu = 0.0
$born = @()
$ended = @()
foreach ($p in $after.processes) {
  $previous = @($before.processes | Where-Object { $_.id -eq $p.id -and $_.start -eq $p.start })
  if ($previous.Count -eq 1) {
    $delta = $p.cpuSeconds - $previous[0].cpuSeconds
    $cpu += $delta
    if ($p.id -eq $AppProcessId) { $appCpu = $delta }
  } else { $born += $p.id }
}
foreach ($p in $before.processes) {
  if (!($after.processes | Where-Object { $_.id -eq $p.id -and $_.start -eq $p.start })) { $ended += $p.id }
}
[PSCustomObject]@{
  state=$State; executable=$expected; pid=$AppProcessId; elapsedSeconds=$elapsed
  appCpuPercentOfOneCore=100*$appCpu/$elapsed
  treeCpuPercentOfOneCore=100*$cpu/$elapsed
  processCount=$after.processes.Count
  treePrivateMiB=($after.processes | Measure-Object -Property privateBytes -Sum).Sum/1MB
  treeWorkingSetMiB=($after.processes | Measure-Object -Property workingSetBytes -Sum).Sum/1MB
  bornPids=$born; endedPids=$ended; stableProcessTree=($born.Count -eq 0 -and $ended.Count -eq 0)
  caveat='CPU covers surviving processes only; process churn invalidates a full-tree CPU comparison. Summed working sets double-count shared pages. This short sample is not a leak or battery-life test.'
  before=$before; after=$after
} | ConvertTo-Json -Depth 6
