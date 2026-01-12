<#
.SYNOPSIS
  Manage daily DagNet RetrieveAll runs in Windows Task Scheduler.

.DESCRIPTION
  DagNet supports a headless daily automation workflow via URL parameters:
    - ?retrieveall=<graph-name>
  See: graph-editor/public/docs/dev/URL_PARAMS.md

  Non-interactive mode:
    - Use switches like -Install / -Enable / -Disable / -Remove / -RunNow.

  Interactive mode:
    - Run with no parameters to see a numbered list of registered daily tasks and manage them.

.NOTES
  - This opens a browser because DagNet automation depends on browser storage (IndexedDB) for credentials.
  - Tasks run in your user context (interactive) so the browser profile is available.
#>

[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Enable,
  [switch]$Disable,
  [switch]$Remove,
  [switch]$RunNow,
  [switch]$Execute,
  [switch]$SetupProfile,

  [string[]]$Graphs,

  [ValidatePattern('^\d{2}:\d{2}$')]
  [string]$Time = '06:00',

  [ValidateRange(0, 1440)]
  [int]$CloseAfterMinutes = 30,

  [string]$BaseUrl = 'https://dagnet.vercel.app/',

  [string]$BrowserExe = 'msedge.exe',

  [string]$BrowserProfileDirectory,

  [string]$BrowserUserDataDir,

  [string]$TaskPrefix = 'DagNet-RetrieveAll'
)

function Get-DefaultAutomationProfileDir {
  try {
    $base = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($base)) { return $null }
    return (Join-Path $base 'DagNet\automation-profile')
  } catch {
    return $null
  }
}

function Ensure-AutomationProfileDir {
  if ([string]::IsNullOrWhiteSpace($BrowserUserDataDir)) {
    $default = Get-DefaultAutomationProfileDir
    if ($default) {
      $BrowserUserDataDir = $default
    }
  }

  if ([string]::IsNullOrWhiteSpace($BrowserUserDataDir)) {
    throw "BrowserUserDataDir is required for automation runs (so we can safely auto-close without affecting your normal browser)."
  }

  if (-not (Test-Path -LiteralPath $BrowserUserDataDir)) {
    New-Item -ItemType Directory -Path $BrowserUserDataDir -Force | Out-Null
  }
}

function Show-Help {
  Write-Host ''
  Write-Host 'DagNet Daily RetrieveAll scheduler'
  Write-Host ''
  Write-Host 'Install:'
  Write-Host '  .\daily-retrieveall.ps1 -Install -Graphs graphA,graphB -Time 06:30'
  Write-Host ''
  Write-Host 'Enable/Disable/RunNow/Remove:'
  Write-Host '  .\daily-retrieveall.ps1 -Disable -Graphs graphA'
  Write-Host '  .\daily-retrieveall.ps1 -Enable   # applies to all tasks with TaskPrefix'
  Write-Host '  .\daily-retrieveall.ps1 -RunNow -Graphs graphA'
  Write-Host '  .\daily-retrieveall.ps1 -Remove   # applies to all tasks with TaskPrefix'
  Write-Host ''
  Write-Host 'Execute (what the scheduled task calls):'
  Write-Host '  .\daily-retrieveall.ps1 -Execute -Graphs graphA -CloseAfterMinutes 30 -BrowserUserDataDir "C:\...\DagNet\automation-profile"'
  Write-Host ''
  Write-Host 'Setup (one-time, to configure the automation profile/container):'
  Write-Host '  .\daily-retrieveall.ps1 -SetupProfile -BrowserUserDataDir "C:\...\DagNet\automation-profile"'
  Write-Host ''
  Write-Host 'Interactive:'
  Write-Host '  .\daily-retrieveall.ps1   # no args'
  Write-Host ''
  Write-Host 'Notes:'
  Write-Host '  - Uses DagNet URL automation: ?retrieveall=<graph-name>'
  Write-Host '  - Runs browser in interactive user context (IndexedDB credentials/profile required).'
  Write-Host '  - Scheduled runs REQUIRE BrowserUserDataDir so auto-close does not affect your normal browser.'
  Write-Host ''
}

function Get-TaskNameForGraph([string]$graphName, [string]$taskPrefix) {
  $safe = ($graphName -replace '[^A-Za-z0-9._-]', '_')
  return "$taskPrefix-$safe"
}

function Get-AllDagNetTasks([string]$taskPrefix) {
  $prefix = "$taskPrefix-"
  return Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "$prefix*" }
}

function Try-ParseGraphFromTaskName([string]$taskName, [string]$taskPrefix) {
  $prefix = "$taskPrefix-"
  if (-not $taskName.StartsWith($prefix)) { return $null }
  return $taskName.Substring($prefix.Length)
}

function Normalise-BaseUrl([string]$url) {
  if ([string]::IsNullOrWhiteSpace($url)) { throw "BaseUrl must not be empty" }
  if ($url.EndsWith('/')) { return $url }
  return "$url/"
}

function Build-RetrieveAllUrl([string]$baseUrl, [string]$graphName) {
  $b = Normalise-BaseUrl $baseUrl
  $encoded = [System.Uri]::EscapeDataString($graphName)
  return "${b}?retrieveall=$encoded"
}

function Parse-TimeOfDay([string]$hhmm) {
  $parts = $hhmm.Split(':')
  if ($parts.Length -ne 2) { throw "Invalid -Time '$hhmm' (expected HH:mm)" }
  $hour = [int]$parts[0]
  $minute = [int]$parts[1]
  if ($hour -lt 0 -or $hour -gt 23) { throw "Invalid hour in -Time '$hhmm'" }
  if ($minute -lt 0 -or $minute -gt 59) { throw "Invalid minute in -Time '$hhmm'" }
  return (Get-Date).Date.AddHours($hour).AddMinutes($minute)
}

function Build-BrowserArguments([string]$url) {
  $args = @()
  if ($BrowserUserDataDir) { $args += "--user-data-dir=`"$BrowserUserDataDir`"" }
  if ($BrowserProfileDirectory) { $args += "--profile-directory=`"$BrowserProfileDirectory`"" }

  # Use app-window mode so we can close the right window without leaving "extra tabs" accumulating.
  $args += '--no-first-run'
  $args += "--app=`"$url`""
  return ($args -join ' ')
}

function Invoke-GraphRun([string]$graphName) {
  $url = Build-RetrieveAllUrl $BaseUrl $graphName
  $args = Build-BrowserArguments $url

  Write-Host "Opening: $url"
  $p = Start-Process -FilePath $BrowserExe -ArgumentList $args -PassThru

  if ($CloseAfterMinutes -le 0) { throw "CloseAfterMinutes must be > 0 for automation runs." }

  Write-Host "Will attempt to close after $CloseAfterMinutes minute(s)..."
  Start-Sleep -Seconds ($CloseAfterMinutes * 60)

  try {
    $null = $p.CloseMainWindow()
  } catch {
    # Best-effort only
  }

  Start-Sleep -Seconds 5

  try {
    if (-not $p.HasExited) {
      Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # Best-effort only
  }
}

function Register-GraphTask([string]$graphName) {
  Ensure-AutomationProfileDir
  if ($CloseAfterMinutes -le 0) { throw "CloseAfterMinutes must be > 0 for scheduled tasks (to avoid accumulating windows/tabs)." }

  $taskName = Get-TaskNameForGraph $graphName $TaskPrefix
  $url = Build-RetrieveAllUrl $BaseUrl $graphName
  $scriptPath = $MyInvocation.MyCommand.Path
  if ([string]::IsNullOrWhiteSpace($scriptPath)) {
    throw "Cannot determine script path for task action. Try running the script from a file (not pasted)."
  }

  $at = Parse-TimeOfDay $Time
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
  $argStr = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`" -Execute -Graphs `"$graphName`" -Time `"$Time`" -CloseAfterMinutes $CloseAfterMinutes -BaseUrl `"$BaseUrl`" -BrowserExe `"$BrowserExe`" -TaskPrefix `"$TaskPrefix`""
  if ($BrowserUserDataDir) { $argStr += " -BrowserUserDataDir `"$BrowserUserDataDir`"" }
  if ($BrowserProfileDirectory) { $argStr += " -BrowserProfileDirectory `"$BrowserProfileDirectory`"" }
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argStr

  # Run in the current user's interactive context so the browser profile (IndexedDB) is available.
  $userId = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
  $principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType InteractiveToken -RunLevel LeastPrivilege

  $limitMinutes = [Math]::Max(10, ($CloseAfterMinutes + 5))
  $settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $limitMinutes)

  $task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "DagNet daily RetrieveAll for graph '$graphName' via $url"
  Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null

  Write-Host "Installed task: $taskName  (Daily @ $Time)"
}

function Assert-SingleOperationOrInteractive {
  $ops = @($Install, $Enable, $Disable, $Remove, $RunNow, $Execute, $SetupProfile) | Where-Object { $_ }
  if ($ops.Count -gt 1) {
    throw "Specify only one operation switch: -Install | -Enable | -Disable | -Remove | -RunNow | -Execute | -SetupProfile"
  }
}

function Require-Graphs([string]$opName) {
  if (-not $Graphs -or $Graphs.Count -eq 0) {
    throw "$opName requires -Graphs graphA,graphB"
  }
}

function Get-TasksTable {
  $tasks = @(Get-AllDagNetTasks $TaskPrefix | Sort-Object TaskName)
  $rows = @()
  $i = 1
  foreach ($t in $tasks) {
    $info = Get-ScheduledTaskInfo -TaskName $t.TaskName -ErrorAction SilentlyContinue
    $rows += [PSCustomObject]@{
      Num = $i
      Enabled = $t.Settings.Enabled
      TaskName = $t.TaskName
      Graph = (Try-ParseGraphFromTaskName $t.TaskName $TaskPrefix)
      NextRunTime = if ($info) { $info.NextRunTime } else { $null }
      LastRunTime = if ($info) { $info.LastRunTime } else { $null }
    }
    $i++
  }
  return $rows
}

function Prompt-Selection([int]$max, [string]$label) {
  $raw = Read-Host $label
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  $tokens = $raw -split '[, ]+' | Where-Object { $_ -ne '' }
  $nums = @()
  foreach ($tok in $tokens) {
    if ($tok -notmatch '^\d+$') { continue }
    $n = [int]$tok
    if ($n -ge 1 -and $n -le $max) { $nums += $n }
  }
  return $nums | Select-Object -Unique
}

function Interactive-Menu {
  Write-Host ''
  Write-Host 'DagNet Daily RetrieveAll (Interactive)'
  Write-Host "TaskPrefix: $TaskPrefix"
  Write-Host ''

  while ($true) {
    $rows = @(Get-TasksTable)
    if ($rows.Count -eq 0) {
      Write-Host 'No DagNet RetrieveAll tasks found.'
    } else {
      $rows | Format-Table Num, Enabled, Graph, NextRunTime, TaskName -AutoSize | Out-Host
    }

    Write-Host ''
    Write-Host 'Choose:'
    Write-Host '  [S] Setup automation profile (one-time)'
    Write-Host '  [A] Add graph'
    Write-Host '  [R] Remove graph(s)'
    Write-Host '  [D] Disable graph(s)'
    Write-Host '  [E] Enable graph(s)'
    Write-Host '  [N] Run now (start task) for graph(s)'
    Write-Host '  [Q] Quit'
    Write-Host ''

    $choice = (Read-Host 'Action').Trim().ToUpperInvariant()
    if ($choice -eq 'Q') { return }

    if ($choice -eq 'S') {
      Ensure-AutomationProfileDir
      Write-Host "Opening setup window using BrowserUserDataDir: $BrowserUserDataDir"
      $setupUrl = Normalise-BaseUrl $BaseUrl
      $args = Build-BrowserArguments $setupUrl
      Start-Process -FilePath $BrowserExe -ArgumentList $args | Out-Null
      continue
    }

    if ($choice -eq 'A') {
      Ensure-AutomationProfileDir
      $g = (Read-Host 'Graph name to add (e.g. conversion-funnel)').Trim()
      if ([string]::IsNullOrWhiteSpace($g)) { continue }
      $t = (Read-Host "Daily time HH:mm (default $Time)").Trim()
      if (-not [string]::IsNullOrWhiteSpace($t)) { $Time = $t }
      $c = (Read-Host "Close after minutes (>0 required) (default $CloseAfterMinutes)").Trim()
      if (-not [string]::IsNullOrWhiteSpace($c)) { $CloseAfterMinutes = [int]$c }
      if ($CloseAfterMinutes -le 0) {
        Write-Warning "CloseAfterMinutes must be > 0 (auto-close is required to prevent a new window every working day)."
        continue
      }
      Register-GraphTask $g
      continue
    }

    if ($rows.Count -eq 0) { continue }
    $selected = @(Prompt-Selection $rows.Count 'Enter number(s) (comma-separated)')
    if ($selected.Count -eq 0) { continue }

    $selectedTaskNames = @()
    foreach ($n in $selected) {
      $selectedTaskNames += ($rows | Where-Object { $_.Num -eq $n } | Select-Object -First 1).TaskName
    }

    if ($choice -eq 'R') {
      foreach ($tn in $selectedTaskNames) {
        Unregister-ScheduledTask -TaskName $tn -Confirm:$false -ErrorAction Stop
        Write-Host "Removed task: $tn"
      }
      continue
    }

    if ($choice -eq 'D') {
      foreach ($tn in $selectedTaskNames) {
        Disable-ScheduledTask -TaskName $tn -ErrorAction Stop
        Write-Host "Disabled task: $tn"
      }
      continue
    }

    if ($choice -eq 'E') {
      foreach ($tn in $selectedTaskNames) {
        Enable-ScheduledTask -TaskName $tn -ErrorAction Stop
        Write-Host "Enabled task: $tn"
      }
      continue
    }

    if ($choice -eq 'N') {
      foreach ($tn in $selectedTaskNames) {
        Start-ScheduledTask -TaskName $tn -ErrorAction Stop
        Write-Host "Started task: $tn"
      }
      continue
    }
  }
}

Assert-SingleOperationOrInteractive

# No operation switch provided => interactive.
if (-not ($Install -or $Enable -or $Disable -or $Remove -or $RunNow -or $Execute -or $SetupProfile)) {
  Interactive-Menu
  exit 0
}

if ($Install) {
  Ensure-AutomationProfileDir
  if ($CloseAfterMinutes -le 0) { throw "CloseAfterMinutes must be > 0 for scheduled tasks (to avoid accumulating windows/tabs)." }
  Require-Graphs 'Install'
  foreach ($g in $Graphs) {
    if ([string]::IsNullOrWhiteSpace($g)) { continue }
    Register-GraphTask $g.Trim()
  }
  exit 0
}

if ($SetupProfile) {
  Ensure-AutomationProfileDir
  Write-Host ''
  Write-Host 'DagNet automation profile setup'
  Write-Host "BrowserExe: $BrowserExe"
  Write-Host "BrowserUserDataDir: $BrowserUserDataDir"
  if ($BrowserProfileDirectory) { Write-Host "BrowserProfileDirectory: $BrowserProfileDirectory" }
  Write-Host ''
  Write-Host 'This will open DagNet using the automation browser container. Do your one-time setup there:'
  Write-Host '  - ensure credentials are available'
  Write-Host '  - select the correct repository/branch in Navigator'
  Write-Host '  - optionally run a RetrieveAll once manually to confirm it works'
  Write-Host ''
  $setupUrl = Normalise-BaseUrl $BaseUrl
  $args = Build-BrowserArguments $setupUrl
  Start-Process -FilePath $BrowserExe -ArgumentList $args | Out-Null
  exit 0
}

if ($Execute) {
  Ensure-AutomationProfileDir
  Require-Graphs 'Execute'
  foreach ($g in $Graphs) {
    if ([string]::IsNullOrWhiteSpace($g)) { continue }
    Invoke-GraphRun $g.Trim()
  }
  exit 0
}

if ($Enable) {
  if ($Graphs -and $Graphs.Count -gt 0) {
    foreach ($g in $Graphs) {
      $taskName = Get-TaskNameForGraph $g.Trim() $TaskPrefix
      Enable-ScheduledTask -TaskName $taskName -ErrorAction Stop
      Write-Host "Enabled task: $taskName"
    }
  } else {
    foreach ($t in Get-AllDagNetTasks $TaskPrefix) {
      Enable-ScheduledTask -TaskName $t.TaskName -ErrorAction Stop
      Write-Host "Enabled task: $($t.TaskName)"
    }
  }
  exit 0
}

if ($Disable) {
  if ($Graphs -and $Graphs.Count -gt 0) {
    foreach ($g in $Graphs) {
      $taskName = Get-TaskNameForGraph $g.Trim() $TaskPrefix
      Disable-ScheduledTask -TaskName $taskName -ErrorAction Stop
      Write-Host "Disabled task: $taskName"
    }
  } else {
    foreach ($t in Get-AllDagNetTasks $TaskPrefix) {
      Disable-ScheduledTask -TaskName $t.TaskName -ErrorAction Stop
      Write-Host "Disabled task: $($t.TaskName)"
    }
  }
  exit 0
}

if ($RunNow) {
  Require-Graphs 'RunNow'
  foreach ($g in $Graphs) {
    $taskName = Get-TaskNameForGraph $g.Trim() $TaskPrefix
    Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
    Write-Host "Started task: $taskName"
  }
  exit 0
}

if ($Remove) {
  if ($Graphs -and $Graphs.Count -gt 0) {
    foreach ($g in $Graphs) {
      $taskName = Get-TaskNameForGraph $g.Trim() $TaskPrefix
      Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
      Write-Host "Removed task: $taskName"
    }
  } else {
    foreach ($t in Get-AllDagNetTasks $TaskPrefix) {
      Unregister-ScheduledTask -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop
      Write-Host "Removed task: $($t.TaskName)"
    }
  }
  exit 0
}

Show-Help
exit 1



