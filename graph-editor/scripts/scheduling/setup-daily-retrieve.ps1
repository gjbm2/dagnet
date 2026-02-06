#requires -version 5.1
# DagNet Daily Retrieve - Task Scheduler Setup
# Run this script to manage daily scheduled graph retrievals.

param()

# Self-elevate to admin
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

function Get-DagNetTasks {
    # PowerShell array handling is broken - be explicit
    $all = Get-ScheduledTask -ErrorAction SilentlyContinue
    $filtered = $all | Where-Object { $_.TaskName -like "DagNet_DailyRetrieve_*" }
    
    # Convert to proper array
    if ($null -eq $filtered) {
        return @()
    }
    elseif ($filtered -is [array]) {
        return $filtered
    }
    else {
        return @($filtered)
    }
}

function Resolve-DefaultBrowserExe {
    <#
      Attempts to resolve the current user's default browser executable for https:// URLs.
      This is ONLY used when we need to pass profile arguments (dedicated scheduler profile).

      Notes:
      - If we cannot resolve a concrete exe path, we fall back to Start-Process <url>
        (which uses the system default browser, but cannot force a profile).
    #>
    try {
        $progId = $null
        try {
            $uc = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice" -ErrorAction Stop
            $progId = $uc.ProgId
        } catch { }
        if ([string]::IsNullOrWhiteSpace($progId)) {
            try {
                $uc = Get-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice" -ErrorAction Stop
                $progId = $uc.ProgId
            } catch { }
        }
        if ([string]::IsNullOrWhiteSpace($progId)) { return $null }

        $cmdKey = "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command"
        $cmdItem = Get-Item -Path $cmdKey -ErrorAction SilentlyContinue
        if (-not $cmdItem) { return $null }
        $command = $cmdItem.GetValue("")
        if ([string]::IsNullOrWhiteSpace($command)) { return $null }

        $exe = $null
        if ($command -match '^\s*"([^"]+)"') {
            $exe = $Matches[1]
        } else {
            $exe = ($command.Trim() -split '\s+')[0]
        }
        if ([string]::IsNullOrWhiteSpace($exe)) { return $null }
        if (Test-Path $exe) { return $exe }
        return $null
    }
    catch {
        return $null
    }
}

function Show-Menu {
    Clear-Host
    Write-Host ""
    Write-Host "========================================"
    Write-Host "  DagNet Daily Retrieve Management"
    Write-Host "========================================"
    Write-Host ""
    
    $tasks = Get-DagNetTasks
    $taskCount = ($tasks | Measure-Object).Count
    
    if ($taskCount -gt 0) {
        Write-Host "Scheduled Graphs:" -ForegroundColor Yellow
        Write-Host ""
        $i = 1
        foreach ($task in $tasks) {
            $graphName = $task.TaskName -replace '^DagNet_DailyRetrieve_', ''
            $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -ErrorAction SilentlyContinue
            
            # Get trigger info (daily time)
            $trigger = $task.Triggers | Select-Object -First 1
            $dailyTime = "Unknown"
            if ($trigger -and $trigger.StartBoundary) {
                try {
                    $dailyTime = [DateTime]::Parse($trigger.StartBoundary).ToString('HH:mm')
                } catch { }
            }
            
            # Get action info (URL, browser)
            $action = $task.Actions | Select-Object -First 1
            $actionArgs = if ($action) { $action.Arguments } else { "" }
            
            # Try to decode the URL from the encoded command to get graph list and timeout
            $graphs = @()
            $browserMins = "Unknown"
            if ($actionArgs -match '-EncodedCommand\s+(\S+)') {
                try {
                    $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
                    
                    # DEBUG: Show decoded command
                    Write-Host "  [DEBUG] Decoded cmd: $($decoded.Substring(0, [Math]::Min(100, $decoded.Length)))..." -ForegroundColor DarkGray
                    
                    # Extract graphs - find retrieveall= and capture until ' or ; or end
                    # Use a more robust approach: find the URL first
                    # Check for daily-fetch mode first (retrieveall without value)
                    $isDailyFetchModeTask = $false
                    if ($decoded -match '\?retrieveall[''"]?\s*$' -or $decoded -match '\?retrieveall[''"]?\s*;' -or ($decoded -match '\?retrieveall' -and $decoded -notmatch 'retrieveall=')) {
                        $isDailyFetchModeTask = $true
                    } elseif ($decoded -match 'retrieveall=([a-zA-Z0-9_,\-]+)') {
                        $rawGraphs = $Matches[1]
                        # IMPORTANT: force array even for a single graph (otherwise $graphs[0] returns first character)
                        $graphs = @($rawGraphs -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
                    }
                    
                    # Extract timeout - look for Start-Sleep -Seconds NNNN
                    if ($decoded -match 'Start-Sleep\s+-Seconds\s+(\d+)') {
                        $secs = [int]$Matches[1]
                        $browserMins = [math]::Round($secs / 60)
                    }
                } catch { }
            }
            
            # Fallback: if no graphs extracted, use task name (strip prefix)
            if (($graphs | Measure-Object).Count -eq 0) {
                $graphs = @($graphName)
            }
            
            # Run times - check for bogus dates (1899, 1999, etc.)
            $lastRun = 'Never'
            if ($info -and $info.LastRunTime) {
                $year = $info.LastRunTime.Year
                if ($year -gt 2000 -and $year -lt 2100) {
                    $lastRun = $info.LastRunTime.ToString('d-MMM-yy HH:mm')
                }
            }
            
            $nextRun = 'Not scheduled'
            if ($info -and $info.NextRunTime) {
                $year = $info.NextRunTime.Year
                if ($year -gt 2000 -and $year -lt 2100) {
                    $nextRun = $info.NextRunTime.ToString('d-MMM-yy HH:mm')
                }
            }
            
            $state = $task.State
            
            # Check if "run if missed" is enabled - need to get full task with settings
            $fullTask = Get-ScheduledTask -TaskName $task.TaskName -ErrorAction SilentlyContinue
            $runIfMissed = "Unknown"
            if ($fullTask -and $fullTask.Settings) {
                $runIfMissed = if ($fullTask.Settings.StartWhenAvailable) { 
                    "Yes (catch up when PC wakes)" 
                } else { 
                    "No (skip missed)" 
                }
            }
            
            # Prefer showing the actual graph (decoded from action) rather than the task-name suffix.
            if ($isDailyFetchModeTask) {
                $title = "Daily Fetch (all enabled graphs)"
            } else {
                $title = if (($graphs | Measure-Object).Count -ge 1) { $graphs[0] } else { $graphName }
            }
            Write-Host "  [$i] $title" -ForegroundColor White
            
            # Show mode/graphs info
            if ($isDailyFetchModeTask) {
                Write-Host "      Mode: Daily-fetch (processes all graphs with 'Fetch daily' enabled)" -ForegroundColor Magenta
            } else {
                $graphCount = ($graphs | Measure-Object).Count
                if ($graphCount -gt 1) {
                    Write-Host "      Graphs ($graphCount, run in sequence):" -ForegroundColor Cyan
                    foreach ($g in $graphs) {
                        Write-Host "        - $g" -ForegroundColor White
                    }
                } elseif ($graphCount -eq 1) {
                    Write-Host "      Graph: $($graphs[0])" -ForegroundColor Cyan
                }
            }
            
            Write-Host "      Runs daily at: $dailyTime" -ForegroundColor Cyan
            Write-Host "      Browser stays open: $browserMins mins" -ForegroundColor Gray
            Write-Host "      If PC was off: $runIfMissed" -ForegroundColor Gray
            Write-Host "      State: $state" -ForegroundColor $(if ($state -eq 'Ready') { 'Green' } else { 'Yellow' })
            Write-Host "      Last run: $lastRun"
            Write-Host "      Next run: $nextRun"
            Write-Host ""
            $i++
        }
    }
    else {
        Write-Host "No scheduled graphs found." -ForegroundColor Yellow
        Write-Host "(Tasks are created in Task Scheduler root as 'DagNet_DailyRetrieve_*')" -ForegroundColor Gray
        Write-Host ""
    }
    
    Write-Host "Options:"
    Write-Host "  [A] Add / update schedule (recommended: daily-fetch mode)"
    Write-Host "  [R] Remove a schedule"
    Write-Host "  [T] Trigger a schedule now (run immediately)"
    Write-Host "  [D] Debug - show all tasks"
    Write-Host "  [Q] Quit"
    Write-Host ""
}

function Add-Graph {
    Write-Host ""
    Write-Host "=== Add New Schedule ===" -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "Schedule mode:" -ForegroundColor Gray
    Write-Host "  [1] Specific graph(s) - you specify which graphs to run"
    Write-Host "  [2] Daily-fetch mode  - run all graphs marked 'Fetch daily' in DagNet"
    Write-Host ""
    $modeChoice = Read-Host "Choice (default: 1)"
    if ([string]::IsNullOrWhiteSpace($modeChoice)) { $modeChoice = "1" }
    
    $isDailyFetchMode = ($modeChoice -eq "2")
    
    # Variables that differ by mode
    $graphName = $null
    $graphNames = @()
    $graphCount = 0
    $retrieveAllParam = $null
    
    if ($isDailyFetchMode) {
        # Daily-fetch mode: no graph names needed
        $graphName = "daily-fetch-all"
        $retrieveAllParam = ""  # Empty = enumerate from IDB
        
        Write-Host ""
        Write-Host "Daily-fetch mode selected." -ForegroundColor Cyan
        Write-Host "DagNet will process all graphs with 'Fetch daily' enabled." -ForegroundColor Gray
        Write-Host ""
        Write-Host "IMPORTANT: Make sure to enable 'Fetch daily' in each graph's" -ForegroundColor Yellow
        Write-Host "           Pinned Data Interests modal (or use Data > Automated Daily Fetches)." -ForegroundColor Yellow
        Write-Host ""
    } else {
        # Specific graphs mode
        Write-Host ""
        Write-Host "Enter graph name(s). For multiple graphs (run sequentially), separate with commas." -ForegroundColor Gray
        Write-Host "Example: conversion-funnel" -ForegroundColor Gray
        Write-Host "Example: graph-a, graph-b, graph-c  (runs in order)" -ForegroundColor Gray
        Write-Host ""
        $graphInput = Read-Host "Graph name(s)"
        if ([string]::IsNullOrWhiteSpace($graphInput)) {
            Write-Host "Cancelled." -ForegroundColor Yellow
            return
        }
        
        # Parse and clean graph names
        # IMPORTANT: force array even for a single graph (otherwise $graphNames[0] returns first character)
        $graphNames = @($graphInput -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
        $graphCount = ($graphNames | Measure-Object).Count
        
        if ($graphCount -eq 0) {
            Write-Host "No valid graph names." -ForegroundColor Red
            return
        }
        
        # For task naming, use first graph or "multi" indicator
        $graphName = if ($graphCount -eq 1) { $graphNames[0] } else { "$($graphNames[0])_and_$($graphCount - 1)_more" }
        $retrieveAllParam = $graphNames -join ","
        
        Write-Host ""
        if ($graphCount -gt 1) {
            Write-Host "Will run $graphCount graphs in sequence:" -ForegroundColor Cyan
            foreach ($g in $graphNames) {
                Write-Host "  - $g" -ForegroundColor White
            }
            Write-Host ""
        }
    }
    
    $startTime = Read-Host "Daily start time (HH:MM, e.g. 02:00)"
    if (-not ($startTime -match '^\d{1,2}:\d{2}$')) {
        Write-Host "Invalid time format." -ForegroundColor Red
        Read-Host "Press Enter"
        return
    }
    
    # Check if there's already a task at this time
    $existingTasks = Get-DagNetTasks
    foreach ($existing in $existingTasks) {
        $trigger = $existing.Triggers | Select-Object -First 1
        if ($trigger -and $trigger.StartBoundary) {
            try {
                $existingTime = [DateTime]::Parse($trigger.StartBoundary).ToString('HH:mm')
                if ($existingTime -eq $startTime) {
                    Write-Host ""
                    Write-Host "A schedule already exists at $startTime :" -ForegroundColor Yellow
                    Write-Host "  Task: $($existing.TaskName)" -ForegroundColor Gray
                    Write-Host ""
                    Write-Host "Do you want to:"
                    Write-Host "  [1] Add to the existing schedule (graphs run in sequence) - DEFAULT"
                    Write-Host "  [2] Pick a different time"
                    Write-Host "  [3] Cancel"
                    $choice = Read-Host "Choice (default: 1)"
                    
                    if ([string]::IsNullOrWhiteSpace($choice) -or $choice -eq "1") {
                        # Add to existing - decode current graphs, add new ones, recreate task
                        $actionArgs = ($existing.Actions | Select-Object -First 1).Arguments
                        $existingGraphs = @()
                        if ($actionArgs -match '-EncodedCommand\s+(\S+)') {
                            try {
                                $decoded = [System.Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($Matches[1]))
                                if ($decoded -match 'retrieveall=([a-zA-Z0-9_,\-]+)') {
                                    # IMPORTANT: force array even for a single graph
                                    $existingGraphs = @($Matches[1] -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
                                }
                            } catch { }
                        }
                        
                        # Combine graphs
                        $allGraphs = @(@($existingGraphs) + @($graphNames) | Select-Object -Unique)
                        $graphNames = @($allGraphs)
                        $graphCount = ($graphNames | Measure-Object).Count
                        $graphName = if ($graphCount -eq 1) { $graphNames[0] } else { "$($graphNames[0])_and_$($graphCount - 1)_more" }
                        $retrieveAllParam = $graphNames -join ","
                        
                        Write-Host ""
                        Write-Host "Combined schedule will run $graphCount graphs:" -ForegroundColor Cyan
                        foreach ($g in $graphNames) {
                            Write-Host "  - $g" -ForegroundColor White
                        }
                        
                        # Remove the existing task (will be recreated with combined graphs)
                        Unregister-ScheduledTask -TaskName $existing.TaskName -Confirm:$false
                        break
                    }
                    elseif ($choice -eq "2") {
                        Write-Host ""
                        Write-Host "Cancelled (pick a different time and try again)." -ForegroundColor Yellow
                        Read-Host "Press Enter to continue"
                        return
                    }
                    elseif ($choice -eq "3") {
                        Write-Host "Cancelled." -ForegroundColor Yellow
                        return
                    }
                    # Any other input: treat as cancel (safer)
                    Write-Host "Cancelled." -ForegroundColor Yellow
                    return
                }
            } catch { }
        }
    }
    
    $url = Read-Host "DagNet URL (default: https://dagnet-nine.vercel.app)"
    if ([string]::IsNullOrWhiteSpace($url)) {
        $url = "https://dagnet-nine.vercel.app"
    }
    
    Write-Host ""
    Write-Host "How long should browser stay open? (so you can review logs)" -ForegroundColor Gray
    Write-Host "Default is 1439 mins (24h - 1 min, ends just before next run)" -ForegroundColor Gray
    $timeout = Read-Host "Minutes to stay open (default: 1439)"
    if ([string]::IsNullOrWhiteSpace($timeout)) {
        $timeout = 1439
    }
    
    Write-Host ""
    Write-Host "If PC is off at scheduled time:" -ForegroundColor Gray
    Write-Host "  [1] Run as soon as PC wakes (catch up) - DEFAULT"
    Write-Host "  [2] Skip and wait for next day"
    $catchUp = Read-Host "Choice (default: 1)"
    $startWhenAvailable = ($catchUp -ne "2")
    
    Write-Host ""
    Write-Host "Browser window behaviour:" -ForegroundColor Gray
    Write-Host "  [1] Normal (visible) - DEFAULT" -ForegroundColor Gray
    Write-Host "  [2] Start minimised" -ForegroundColor Gray
    $windowChoice = Read-Host "Choice (default: 1)"
    if ([string]::IsNullOrWhiteSpace($windowChoice)) { $windowChoice = "1" }
    $startMinimised = ($windowChoice -eq "2")

    Write-Host ""
    Write-Host "Browser launch mode:" -ForegroundColor Gray
    Write-Host "  [1] Normal tab (restores previous session tabs) - DEFAULT" -ForegroundColor Gray
    Write-Host "  [2] App window (single tab, avoids session restore)" -ForegroundColor Gray
    $launchModeChoice = Read-Host "Choice (default: 1)"
    if ([string]::IsNullOrWhiteSpace($launchModeChoice)) { $launchModeChoice = "1" }
    $useAppWindow = ($launchModeChoice -eq "2")

    # Run the browser executable directly so the scheduled task owns the process
    # and Task Scheduler can end it when the execution time limit is reached.
    $browser = Resolve-DefaultBrowserExe
    if (-not $browser) {
        Write-Host ""
        Write-Host "Could not resolve your default browser executable." -ForegroundColor Yellow
        Write-Host "Please enter the full path to your browser exe (e.g. C:\Program Files\Google\Chrome\Application\chrome.exe)" -ForegroundColor Gray
        $browser = Read-Host "Browser exe path (leave blank to cancel)"
        if ([string]::IsNullOrWhiteSpace($browser)) {
            Write-Host "Cancelled." -ForegroundColor Yellow
            return
        }
        if (-not (Test-Path $browser)) {
            Write-Host "Invalid browser path: $browser" -ForegroundColor Red
            return
        }
    }
    
    Write-Host ""
    Write-Host "Creating scheduled task..." -ForegroundColor Yellow
    
    # Task name and URL differ by mode
    if ($isDailyFetchMode) {
        $taskName = "DagNet_DailyFetch_All"
        $fullUrl = "$url/?retrieveall"  # No value = enumerate from IDB
    } else {
        $taskName = "DagNet_DailyRetrieve_$graphName"
        $fullUrl = "$url/?retrieveall=$retrieveAllParam"
    }
    
    Write-Host "  Task name: $taskName" -ForegroundColor Gray
    Write-Host "  URL: $fullUrl" -ForegroundColor Gray
    if ($isDailyFetchMode) {
        Write-Host "  Mode: Daily-fetch (processes all graphs with 'Fetch daily' enabled)" -ForegroundColor Magenta
    }
    Write-Host "  Start time: $startTime daily" -ForegroundColor Gray
    Write-Host "  Browser open for: $timeout minutes" -ForegroundColor Gray
    Write-Host "  If PC off: $(if ($startWhenAvailable) { 'Catch up when PC wakes' } else { 'Skip missed runs' })" -ForegroundColor Gray
    Write-Host ""
    
    # Optional: dedicated browser profile for scheduled runs (recommended for stable credentials/IndexedDB).
    $profileDir = $null
    $browserArgs = $null
    $exeName = [System.IO.Path]::GetFileName($browser).ToLower()
    $isFirefox = ($exeName -like "*firefox*")

    # Base args for normal (non-dedicated) runs
    if ($isFirefox) {
        if ($useAppWindow) {
            Write-Host ""
            Write-Host "Note: App window mode is not supported in Firefox; using normal tab instead." -ForegroundColor Yellow
        }
        $browserArgs = "-new-window `"$fullUrl`""
    }
    else {
        if ($useAppWindow) {
            $browserArgs = "--app=`"$fullUrl`""
        }
        else {
            $browserArgs = "--new-window `"$fullUrl`""
        }
        if ($startMinimised) {
            $browserArgs = "$browserArgs --start-minimized"
        }
    }

    if ($startMinimised -and $isFirefox) {
        Write-Host ""
        Write-Host "Note: Firefox does not reliably support start minimised via CLI; it may open normally." -ForegroundColor Yellow
    }

    Write-Host "Use a dedicated DagNet scheduler browser profile? (recommended)" -ForegroundColor Gray
    Write-Host "  This keeps credentials/IndexedDB stable and avoids 'wrong browser profile' failures." -ForegroundColor DarkGray
    $useDedicated = Read-Host "Use dedicated profile? (Y/n)"
    if ([string]::IsNullOrWhiteSpace($useDedicated) -or $useDedicated.ToLower() -eq "y" -or $useDedicated.ToLower() -eq "yes") {
        Write-Host "Resolved browser exe: $browser" -ForegroundColor Gray
        $profileDir = Join-Path $env:LOCALAPPDATA "DagNet\scheduled-browser-profile"
        New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

        if ($isFirefox) {
            $browserArgs = "-profile `"$profileDir`" -new-window `"$fullUrl`""
        }
        else {
            # Assume Chromium-family flags (Brave/Chrome/Edge etc.)
            if ($useAppWindow) {
                $browserArgs = "--user-data-dir=`"$profileDir`" --app=`"$fullUrl`""
            }
            else {
                $browserArgs = "--user-data-dir=`"$profileDir`" --new-window `"$fullUrl`""
            }
            if ($startMinimised) {
                $browserArgs = "$browserArgs --start-minimized"
            }
        }
    }
    
    try {
        $action = New-ScheduledTaskAction -Execute $browser -Argument $browserArgs
        $trigger = New-ScheduledTaskTrigger -Daily -At $startTime
        # Align Task Scheduler's "Stop the task if it runs longer than:" EXACTLY with the chosen minutes.
        $execLimit = New-TimeSpan -Minutes ([int]$timeout)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable:$startWhenAvailable -ExecutionTimeLimit $execLimit -MultipleInstances IgnoreNew
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
        
        # Remove if exists
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "  Removing existing task..." -ForegroundColor Yellow
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
        
        # Create the task
        Write-Host "  Calling Register-ScheduledTask..." -ForegroundColor Gray
        $result = Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "DagNet daily retrieve: $graphName" -TaskPath "\"
        
        Write-Host "  Register-ScheduledTask returned:" -ForegroundColor Gray
        Write-Host "    TaskName: $($result.TaskName)" -ForegroundColor Gray
        Write-Host "    TaskPath: $($result.TaskPath)" -ForegroundColor Gray
        Write-Host "    State: $($result.State)" -ForegroundColor Gray
        
        # Verify it was created - try multiple methods
        Write-Host "  Verifying..." -ForegroundColor Gray
        Start-Sleep -Milliseconds 500
        
        $verify1 = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $verify2 = Get-ScheduledTask | Where-Object { $_.TaskName -eq $taskName }
        
        Write-Host "  Verify method 1 (direct): $(if ($verify1) { 'FOUND' } else { 'NOT FOUND' })" -ForegroundColor Gray
        Write-Host "  Verify method 2 (filter): $(if ($verify2) { 'FOUND' } else { 'NOT FOUND' })" -ForegroundColor Gray
        
        if ($verify1 -or $verify2) {
            Write-Host ""
            Write-Host "SUCCESS: Task created!" -ForegroundColor Green
            Write-Host "  Name: $taskName" -ForegroundColor Green
            Write-Host "  Location: Task Scheduler > Task Scheduler Library" -ForegroundColor Green
            Write-Host "  (Run 'taskschd.msc' to view)" -ForegroundColor Gray

            if ($profileDir) {
                Write-Host ""
                Write-Host "Dedicated scheduler profile:" -ForegroundColor Cyan
                Write-Host "  $profileDir" -ForegroundColor White
            }

            Write-Host ""
            Write-Host "Launch once now (recommended) so you can log in / cache credentials for scheduled runs?" -ForegroundColor Yellow
            $launchNow = Read-Host "Launch now? (Y/n)"
            if ([string]::IsNullOrWhiteSpace($launchNow) -or $launchNow.ToLower() -eq "y" -or $launchNow.ToLower() -eq "yes") {
                try {
                    # For this one-off interactive run, prefer visible window even if the scheduled run is minimised,
                    # so you can complete credential setup easily.
                    Start-Process $browser -ArgumentList $browserArgs
                    Write-Host "Opened browser. Please complete login/authorisation in that window/profile." -ForegroundColor Green
                }
                catch {
                    Write-Host "WARNING: Could not launch browser: $($_.Exception.Message)" -ForegroundColor Yellow
                }
            }
        }
        else {
            Write-Host ""
            Write-Host "WARNING: Register returned OK but task not found!" -ForegroundColor Yellow
            Write-Host "  The task MAY have been created. Check Task Scheduler manually." -ForegroundColor Yellow
            Write-Host "  Run 'taskschd.msc' and look for: $taskName" -ForegroundColor Yellow
        }
    }
    catch {
        Write-Host ""
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    Write-Host ""
    Read-Host "Press Enter to continue"
}

function Remove-Graph {
    $tasks = Get-DagNetTasks
    $taskCount = ($tasks | Measure-Object).Count
    
    if ($taskCount -eq 0) {
        Write-Host "No tasks to remove." -ForegroundColor Yellow
        Read-Host "Press Enter to continue"
        return
    }
    
    Write-Host ""
    Write-Host "=== Remove Graph ===" -ForegroundColor Cyan
    Write-Host ""
    
    $i = 1
    foreach ($task in $tasks) {
        $graphName = $task.TaskName -replace '^DagNet_DailyRetrieve_', ''
        Write-Host "  [$i] $graphName"
        $i++
    }
    Write-Host ""
    
    $choice = Read-Host "Enter number to remove (0 to cancel)"
    $num = 0
    if (-not [int]::TryParse($choice, [ref]$num)) { return }
    if ($num -lt 1 -or $num -gt $taskCount) { return }
    
    $taskToRemove = $tasks[$num - 1]
    try {
        Unregister-ScheduledTask -TaskName $taskToRemove.TaskName -Confirm:$false
        Write-Host "Removed: $($taskToRemove.TaskName)" -ForegroundColor Green
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    Read-Host "Press Enter to continue"
}

function Trigger-Graph {
    $tasks = Get-DagNetTasks
    $taskCount = ($tasks | Measure-Object).Count
    
    if ($taskCount -eq 0) {
        Write-Host "No tasks to run." -ForegroundColor Yellow
        Read-Host "Press Enter to continue"
        return
    }
    
    Write-Host ""
    Write-Host "=== Run Scheduled Graph Now ===" -ForegroundColor Cyan
    Write-Host ""
    
    $i = 1
    foreach ($task in $tasks) {
        $graphName = $task.TaskName -replace '^DagNet_DailyRetrieve_', ''
        Write-Host "  [$i] $graphName"
        $i++
    }
    Write-Host ""
    
    $choice = Read-Host "Enter number to run now (0 to cancel)"
    $num = 0
    if (-not [int]::TryParse($choice, [ref]$num)) { return }
    if ($num -lt 1 -or $num -gt $taskCount) { return }
    
    $taskToRun = $tasks[$num - 1]
    try {
        Write-Host ""
        Write-Host "Starting task now: $($taskToRun.TaskName)" -ForegroundColor Yellow
        Write-Host "  This runs the task's configured Action (same browser/profile args as the scheduler will use)." -ForegroundColor Gray
        Start-ScheduledTask -TaskName $taskToRun.TaskName
        Write-Host "Started. Check your browser window and Task Scheduler History for details." -ForegroundColor Green
    }
    catch {
        Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    }
    Read-Host "Press Enter to continue"
}

function Show-Debug {
    Write-Host ""
    Write-Host "=== Debug Info ===" -ForegroundColor Cyan
    Write-Host ""
    
    Write-Host "Method 1: Get-DagNetTasks function" -ForegroundColor Yellow
    $tasks = Get-DagNetTasks
    $cnt = ($tasks | Measure-Object).Count
    Write-Host "  Found: $cnt task(s)"
    foreach ($task in $tasks) {
        Write-Host "    - $($task.TaskName) [$($task.TaskPath)]" -ForegroundColor Green
    }
    Write-Host ""
    
    Write-Host "Method 2: Direct wildcard search" -ForegroundColor Yellow
    $direct = @(Get-ScheduledTask -TaskName "DagNet*" -ErrorAction SilentlyContinue)
    Write-Host "  Found: $(($direct | Measure-Object).Count) task(s)"
    foreach ($task in $direct) {
        Write-Host "    - $($task.TaskName) [$($task.TaskPath)]" -ForegroundColor Green
    }
    Write-Host ""
    
    Write-Host "Method 3: Search ALL tasks for 'DagNet'" -ForegroundColor Yellow
    $all = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like "*DagNet*" })
    Write-Host "  Found: $(($all | Measure-Object).Count) task(s)"
    foreach ($task in $all) {
        Write-Host "    - $($task.TaskName) [$($task.TaskPath)]" -ForegroundColor Green
    }
    Write-Host ""
    
    Write-Host "Method 4: Tasks in root folder (first 20)" -ForegroundColor Yellow
    $root = @(Get-ScheduledTask -TaskPath "\" -ErrorAction SilentlyContinue | Select-Object -First 20)
    Write-Host "  Found: $(($root | Measure-Object).Count) in root"
    foreach ($t in $root) {
        if ($t.TaskName -like "*DagNet*") {
            Write-Host "    - $($t.TaskName) [MATCH]" -ForegroundColor Green
        } else {
            Write-Host "    - $($t.TaskName)" -ForegroundColor Gray
        }
    }
    
    Write-Host ""
    Read-Host "Press Enter to continue"
}

# Main loop
while ($true) {
    Show-Menu
    $choice = Read-Host "Choose"
    
    switch ($choice.ToUpper()) {
        "A" { Add-Graph }
        "R" { Remove-Graph }
        "T" { Trigger-Graph }
        "D" { Show-Debug }
        "Q" { exit }
    }
}
