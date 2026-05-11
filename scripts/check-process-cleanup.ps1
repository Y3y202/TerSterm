$ErrorActionPreference = 'Stop'

$trackedNames = @('tersterm.exe', 'ssh.exe', 'conhost.exe')
$allProcesses = @(Get-CimInstance Win32_Process)
$byId = @{}

foreach ($process in $allProcesses) {
  $byId[$process.ProcessId] = $process
}

$findings = @()

foreach ($process in $allProcesses | Where-Object { $_.Name.ToLowerInvariant() -in $trackedNames }) {
  $name = $process.Name.ToLowerInvariant()
  $parent = $byId[$process.ParentProcessId]
  $parentName = if ($parent) { $parent.Name } else { '<missing>' }
  $commandLine = if ($process.CommandLine) { $process.CommandLine } else { '' }

  if ($name -eq 'tersterm.exe') {
    $findings += "Lingering tersterm.exe PID=$($process.ProcessId) Parent=$parentName"
    continue
  }

  if ($name -eq 'ssh.exe') {
    $findings += "Lingering ssh.exe PID=$($process.ProcessId) Parent=$parentName"
    continue
  }

  $isHeadlessConHost = $commandLine -match '--headless'
  if ($isHeadlessConHost -and (!$parent -or $parentName -in @('tersterm.exe', 'ssh.exe'))) {
    $findings += "Lingering conhost.exe PID=$($process.ProcessId) Parent=$parentName CommandLine=$commandLine"
  }
}

if ($findings.Count -eq 0) {
  'No TerSterm-related lingering processes found.'
  exit 0
}

$findings | ForEach-Object { $_ }
exit 1
