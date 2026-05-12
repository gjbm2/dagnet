# Perf-capture results — 12-May-26 18:25 BST

First Windows-side capture during a retrieve-all run. Source: `Desktop\dagnet-perf-20260512-1825.csv`, copied to `logs/dagnet-perf-20260512-1825.csv`. Captures span 10 minutes (18:25–18:35); user observed host slowdown during monitoring and closed the browser early.

## Raw data summary

| | Sample 1 (18:25) | Mid (18:30) | Last (18:35, post-close) |
|---|---|---|---|
| CommittedMB | 116,580 | 116,355 | 115,462 |
| CommitLimitMB | 132,895 | 132,895 | 132,895 |
| **CommitPct** | **87.7%** | **87.6%** | **86.9%** |
| AvailableMB | 14,459 | 14,704 | 15,121 |
| **PagesPerSec** | **349.5** | 5.0 | 0 |
| DiskQueueLen | 0.03 | 0 | 0 |
| **BraveProcCount** | **116** | 115 | **108** |
| **BravePrivateTotalMB** | **22,619** | 22,508 | **21,260** |
| BraveWorkingSetTotalMB | 12,815 | 12,891 | 11,796 |
| BraveHandlesTotal | 61,739 | 61,337 | 57,791 |
| TopBraveProc (PID) | brave_26232 | brave_26232 | brave_26232 |
| TopBravePrivateMB | 3,429 | 3,412 | 3,255 |

## What the data confirms

1. **Commit-exhaustion hypothesis is the correct shape.** Commit is at 87% of limit throughout the capture — within striking distance of the ~95% cliff at which kernel allocations begin page-faulting and the host becomes unresponsive. The fact that the user *observed* the host slowing down at this commit level (rather than waiting for full 95% saturation) suggests the system was either already thrashing for that one snapshot at sample-1 (PagesPerSec = 349) and stabilised after, or the threshold for noticeable degradation is lower than 95% on this machine.
2. **Brave is the dominant variable.** 22 GB of private commit (1/5 of total system commit) across 116 processes. Top single process is 3.4 GB. The 22 GB number is the actionable handle — reducing it brings commit down proportionally.
3. **Instant recovery on close is consistent with the data.** Process count dropped from 116 → 108 in the last sample (close in progress); private total dropped from 22.6 GB → 21.3 GB. Commit dropped from 88.2% → 86.9%. The full release would have continued over the next few minutes after monitoring stopped.

## What the data complicates

1. **Baseline commit was already 87% at sample 1.** The run did not push commit from a healthy baseline to the cliff over hours. It was already near the cliff when monitoring started at 18:25. Possible reasons:
   - Other Brave windows / tabs running in parallel (regular browsing + this automation).
   - Zombie Brave processes from prior automation runs that didn't fully terminate. The auto-close logic only fires on `outcome: succeeded`, and no run in 20+ days has reached that outcome (see [hypotheses.md](hypotheses.md) H-RUN-NEVER-COMPLETES). If the window stays open after a "warning" outcome and the user kills it manually, processes may orphan over time.
   - Other apps on the host using significant commit.

2. **116 Brave processes is unusually high.** Typical Chrome process tree for one window is 5–15. 116 implies many parallel tabs/windows or zombie process accumulation. Worth understanding separately from the per-run growth question. If zombies are leaking across days, the actual leak is in the close-down path, not in any one run.

3. **Capture window is short (10 min).** We saw a single elevated PagesPerSec sample (349) at start, then a stable plateau. We did not capture the climb from a low baseline; we joined at the plateau. To distinguish "Brave grows during the run" from "Brave was already huge from prior baseline", a full multi-hour capture is needed.

## Implied fixes

In priority order, based on this evidence:

1. **Pre-run baseline check.** Before the next overnight run, ensure `% Committed Bytes In Use` is under 50%. If it isn't, kill all Brave processes and (if needed) reboot Windows. The PowerShell snippet `Get-Counter "\Memory\% Committed Bytes In Use"` checks instantly. Adding this as a pre-flight to the launcher script would be defensive.

2. **Identify and kill zombie Brave trees.** `Get-Process -Name brave | Measure-Object` after a "completed" run (or after closing the window manually) should return 0 (no surviving processes). If it returns dozens, the close-down isn't actually terminating the tree. The fix is in the `window.close()` path of [dailyAutomationJob.ts](../../../graph-editor/src/services/dailyAutomationJob.ts) or [dailyRetrieveAllAutomationService.ts](../../../graph-editor/src/services/dailyRetrieveAllAutomationService.ts) — needs investigation. The Task Scheduler action could also explicitly kill the process tree on a watchdog timer rather than relying on `window.close()`.

3. **Periodic restart during the run.** Even with a clean baseline and no zombies, a multi-hour run will accumulate commit. A separate scheduled task that runs `taskkill /F /IM brave.exe /T` every 60–90 minutes and lets the main task's retry-on-startup re-launch is the standard pattern. Paired with per-slice resumability so a restart doesn't lose progress.

4. **`--use-angle=swiftshader`** to eliminate the GPU process's D3D11 texture cache as one specific component of growth. CPU rasterisation has negligible cost for an unwatched automation tab.

The flag-set tuning (the focus of the 12-May test) is a smaller lever than any of the above. Even with the dropped flags, Brave's private commit is 22 GB. The flags affect *how* Chrome manages this memory in response to visibility events, not *whether* the memory accumulates.

## Open data-collection requests

For the next overnight run, capture:

1. Full 8-hour CSV from `perf-capture-windows.md` script.
2. Pre-run baseline reading: `Get-Counter "\Memory\Committed Bytes","\Memory\Commit Limit"` immediately before the task fires.
3. Pre-run Brave process count: `(Get-Process -Name brave).Count`.
4. Post-run (after auto-close, or after manual close): same two readings.

The delta between pre- and post-run, plus the trajectory across the run, will tell us exactly how much commit the run accumulates per hour. That's the number we need to size a periodic-restart interval.
