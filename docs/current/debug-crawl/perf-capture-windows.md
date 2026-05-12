# Windows performance capture during a retrieve-all run

The sysdiag instrumentation embedded in the automation log captures only the renderer's v8 heap (`performance.memory`). It is blind to:

- Browser process / GPU process / network process memory
- Per-process Windows commit
- System Commit Limit
- Hard page-fault rate
- Disk queue depth
- Handle counts

To diagnose host-side pathology (mouse lag, host-wide freezes) we need to capture Windows-side counters during the run. This doc records the standard capture script and what to look for in the output.

## The script

Run in a separate PowerShell window before launching the scheduled task. It logs key counters every 60 seconds to a CSV on the user's Desktop. Stop with Ctrl-C.

```powershell
$logfile = "$env:USERPROFILE\Desktop\dagnet-perf-$(Get-Date -Format 'yyyyMMdd-HHmm').csv"
"Timestamp,CommittedMB,CommitLimitMB,CommitPct,AvailableMB,PagesPerSec,DiskQueueLen,BraveProcCount,BravePrivateTotalMB,BraveWorkingSetTotalMB,BraveHandlesTotal,TopBraveProc,TopBravePrivateMB" | Out-File $logfile -Encoding utf8

while ($true) {
  try {
    $now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $c = Get-Counter -Counter @(
      "\Memory\Committed Bytes",
      "\Memory\Commit Limit",
      "\Memory\Available MBytes",
      "\Memory\Pages/sec",
      "\PhysicalDisk(_Total)\Avg. Disk Queue Length"
    ) -ErrorAction SilentlyContinue

    $committedMB   = [math]::Round($c.CounterSamples[0].CookedValue / 1MB, 1)
    $commitLimitMB = [math]::Round($c.CounterSamples[1].CookedValue / 1MB, 1)
    $commitPct     = [math]::Round(($committedMB / $commitLimitMB) * 100, 1)
    $availableMB   = [math]::Round($c.CounterSamples[2].CookedValue, 1)
    $pagesPerSec   = [math]::Round($c.CounterSamples[3].CookedValue, 1)
    $diskQ         = [math]::Round($c.CounterSamples[4].CookedValue, 2)

    $brave = Get-Process -Name brave -ErrorAction SilentlyContinue
    if ($brave) {
      $bCount = ($brave | Measure-Object).Count
      $bPriv  = [math]::Round((($brave | Measure-Object -Property PrivateMemorySize64 -Sum).Sum) / 1MB, 1)
      $bWS    = [math]::Round((($brave | Measure-Object -Property WorkingSet64 -Sum).Sum) / 1MB, 1)
      $bHand  = ($brave | Measure-Object -Property HandleCount -Sum).Sum
      $top    = $brave | Sort-Object PrivateMemorySize64 -Descending | Select-Object -First 1
      $topName = "{0}_{1}" -f $top.ProcessName, $top.Id
      $topPriv = [math]::Round($top.PrivateMemorySize64 / 1MB, 1)
    } else { $bCount=0; $bPriv=0; $bWS=0; $bHand=0; $topName=""; $topPriv=0 }

    "$now,$committedMB,$commitLimitMB,$commitPct,$availableMB,$pagesPerSec,$diskQ,$bCount,$bPriv,$bWS,$bHand,$topName,$topPriv" | Out-File $logfile -Encoding utf8 -Append
  } catch {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss'),ERROR,$_" | Out-File $logfile -Encoding utf8 -Append
  }
  Start-Sleep -Seconds 60
}
```

## Verifying the script is running

In a separate window:

```powershell
$f = Get-ChildItem $env:USERPROFILE\Desktop\dagnet-perf-*.csv | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content $f.FullName -Tail 5
```

The file should grow by ~150 bytes per minute. A healthy row looks like real numbers, not `,ERROR,`.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Every row is `,ERROR,...` | Counter names localised (non-English Windows) | Run `Get-Counter -ListSet Memory` to get the local counter names; patch the script. |
| `BraveProcCount` is 0 but Brave is running | Process name differs (e.g. `brave_browser`) | Check `Get-Process` and adjust the `-Name brave` filter. |
| Script refuses to run | PowerShell Execution Policy | `Set-ExecutionPolicy -Scope Process Bypass` for that shell. |
| File on Desktop but not growing | Loop stopped silently | Watch the console for red error text. |

## What to look for in the output

These are the patterns that confirm or rule out the [commit-exhaustion hypothesis](host-freeze-mechanism.md).

| Column | Healthy | Pathology |
|---|---|---|
| `CommitPct` | Stable, < 70% | Climbing toward 95%+ over hours |
| `PagesPerSec` | Sustained < 200 | Sustained > 1000 (hard-fault thrashing) |
| `DiskQueueLen` | < 2 typical, < 1 mean | Sustained > 2 (disk saturation) |
| `BravePrivateTotalMB` | Stable | Monotonic growth across the run |
| `TopBraveProc` | Renderer typically | If GPU or browser process tops the list and grows, that's the leak source |
| `BraveHandlesTotal` | Stable | Climbing toward 10 000 × N_processes |

A run that triggers the host pathology should show CommitPct climbing into the high 90s and PagesPerSec spiking into the thousands around the time of the freeze. A run that does NOT trigger the pathology should show CommitPct plateauing at some value well below the limit, and PagesPerSec staying low throughout.

## Pairing with Task Manager

Open Task Manager → Performance → Memory pane, keep it visible. When the pathology hits, screenshot it before killing the process. The "Committed: X / Y GB" line is the single most diagnostic number. Pair the screenshot with the CSV row at that timestamp.

## Note for future investigations

The capture is intentionally lightweight — five system counters and one process aggregation per minute. It does NOT capture:

- Per-process CPU% (would require sampling `\Process(*)` counters, which is heavier)
- GPU memory (different counter set, hardware-specific, less reliable)
- Network connection counts (Get-NetTCPConnection per sample is slow)
- WMI counters (much slower than perf counters)

If commit-exhaustion is ruled out by this capture and the pathology persists, the next step is a heavier capture — either a Windows Performance Recorder (`wpr -start GeneralProfile`) trace for a 60-second window of pathology, or PerfMon Data Collector Set covering process-level CPU and GPU counters. Neither is appropriate for an unattended 8-hour run; both are appropriate for a 60-second sample of "the moment the desktop seizes up".
