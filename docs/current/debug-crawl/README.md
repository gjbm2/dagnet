# debug-crawl: `?retrieveall` slow-crawl and host-freeze investigation

**Started:** 12-May-26
**Active test:** running with revised browser-flag set; data being captured via Windows perf-counter CSV.

This directory gathers materials for two related problems with the daily retrieve-all automation:

- **Issue A** — The Windows 11 host becomes catastrophically unresponsive (mouse barely moves, 20-second keystrokes, every other app stalls) while the automation is running. Instant recovery when the Chromium process tree is killed. Develops over ~8 hours into the run.
- **Issue B** — The retrieve-all run consistently takes 8+ hours and does not complete. `outcome: in-progress` on every snapshot for 20+ consecutive days.

These were initially conflated. The investigation shows they have different causes:

- **Issue A** is most likely Windows System Commit exhaustion driven by the Chromium browser and GPU processes. The renderer's v8 heap is verifiably flat (sysdiag confirms across 196 snapshots over 5 days); the growth is in *other* Chrome processes that the renderer's `performance.memory` can't see. One Task Manager snapshot at the moment of pathology settles the diagnosis. Mechanism: [host-freeze-mechanism.md](host-freeze-mechanism.md).
- **Issue B** is Amplitude query latency on specific big-cohort slices of graph 3 (`li-energy-simple-v1`), exceeding our hard-coded 30 s client `AbortController` deadline. 12 specific edges, specific slice contexts, same edges every day. Detail: [timeout-pattern-analysis.md](timeout-pattern-analysis.md).

The renderer's main thread is verifiably NOT the bottleneck for either: cache reads (`GET_FROM_FILE`) stay at 10–20 ms throughout the full 8-hour run.

## Current test (12-May-26)

The configuration under test:

```
brave.exe \
  --user-data-dir="C:\Users\Greg\AppData\Local\DagNet\scheduled-browser-profile" \
  --disable-background-timer-throttling \
  --disable-features=IntensiveWakeUpThrottling \
  --app="https://dagnet-nine.vercel.app/?retrieveall"
```

What changed from the previous overnight set: dropped `--disable-renderer-backgrounding` and `--disable-backgrounding-occluded-windows`. Kept the two timer-throttling defences (covering both tiers — see [browser-flags-analysis.md](browser-flags-analysis.md) §Reference).

What we expect to learn:
- If the host stops freezing under this config, *something* about the previous flag set was contributing — though the specific mechanism remains uncertain.
- If the host still freezes, that's strong evidence the cause is duration-driven (long-running headed Chrome) rather than flag-specific. Mitigation moves to periodic process restart or `--use-angle=swiftshader`.

In parallel, a [PowerShell capture script](perf-capture-windows.md) records `Committed`, `Commit Limit`, `Pages/sec`, `Disk Queue Length`, and per-Brave-process memory every 60 seconds to a CSV on the user's Desktop. This is the data that confirms or rules out the Commit-exhaustion hypothesis.

## Materials in this directory

| File | What it is |
|---|---|
| [README.md](README.md) | This index. |
| [host-freeze-mechanism.md](host-freeze-mechanism.md) | Leading hypothesis for Issue A — Windows System Commit exhaustion driven by Chromium browser + GPU processes. Single Task Manager diagnostic to confirm. |
| [browser-flags-analysis.md](browser-flags-analysis.md) | Source-cited reference for what each Chrome flag and feature actually does. Documents the disproved hypotheses about which flag "causes" what. |
| [timeout-pattern-analysis.md](timeout-pattern-analysis.md) | Issue B root cause — 12 specific edges on graph 3 time out repeatedly on specific big-cohort slices. The 30 s client deadline is too tight for those Amplitude queries. |
| [findings-12-May-26.md](findings-12-May-26.md) | Detailed analysis of the 8–12 May runs: heap flat throughout, timeouts dominate the run duration, where the 8 hours go. |
| [hypotheses.md](hypotheses.md) | Live list of hypotheses with current status (disproved / supported / parked). |
| [prior-investigations.md](prior-investigations.md) | Summaries and pointers to the 6-Apr and 9-Apr handover threads. |
| [perf-capture-windows.md](perf-capture-windows.md) | PowerShell script to record Windows-side counters during a run, what to look for in the output. |
| [sysdiag-trends.csv](sysdiag-trends.csv) | 196 sysdiag snapshots across 5 days. Renderer-only — does not include browser/GPU process memory. |
| [logs/](logs/) | Extracted automation logs for 8–12 May. Read-only copies from `origin/main` of the data repo. |

## Source materials referenced (not duplicated here)

- 9-Apr-26 handover: [docs/current/handover/9-Apr-26-retrieve-all-memory-investigation.md](../handover/9-Apr-26-retrieve-all-memory-investigation.md). Original memory-pressure hypothesis; sysdiag instrumentation added here.
- 6-Apr-26 handover: [docs/current/handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md). Amplitude timeout detection landed; `getSnapshotCoverageForEdges` batching reverted.
- Headless retrieve-all plan: [docs/current/specs/headless-retrieveall-plan.md](../specs/headless-retrieveall-plan.md). The plan was implemented — see [dailyAutomationJob.ts:710-731](../../../graph-editor/src/services/dailyAutomationJob.ts#L710-L731).
- Automation spec: [docs/current/specs/retrieveall-automation-spec.md](../specs/retrieveall-automation-spec.md).
- Scheduling setup: [graph-editor/scripts/scheduling/setup-daily-retrieve.ps1](../../../graph-editor/scripts/scheduling/setup-daily-retrieve.ps1) and [README-SCHEDULING.md](../../../graph-editor/scripts/scheduling/README-SCHEDULING.md).

## Open work, regardless of how the current test goes

1. **Plumb a longer per-request timeout** through `dailyRetrieveAllAutomationService → retrieveAllSlicesService → BrowserHttpExecutor` for the automation path. 90–120 s instead of 30 s. Manual users keep 30 s. This directly addresses Issue B for graph 3's slow queries.
2. **Verify Vercel `python-api.py` `maxDuration`** in [vercel.json](../../../graph-editor/vercel.json). Default 10 s on Hobby plan, 60 s on Pro. If 10 s, client-side timeout changes are moot.
3. **Investigate the `cached=0` bug on graph 1.** Every morning reports `cached=0, fetched=80` even when nothing has changed. The cache-key / signature path is the suspect. Fix here removes the most expensive queries from the retry loop entirely.
4. **`outcome: in-progress` forever.** No run in the last 20+ days has reached `outcome: succeeded`. Either runs are being killed by the user or by Task Scheduler's `ExecutionTimeLimit`, or the outer automation loop never sets the final outcome. Independent of the slow-crawl symptom but skews any time analysis.
5. **Headless mode (`--headless=new`)** as a longer-term option. Architecturally the right answer for "cron job that uses a browser" — no compositor, no GPU pipeline, no window manager interaction. Needs a one-day compatibility test for app boot, IDB persistence under `--user-data-dir`, and the `window.close()` end-of-run path.

## How the logs were obtained

The data repo (`nous-conversion`) was on branch `feature/bayes-test-graph` with one local modification (`hash-mappings.json`). A `git fetch` was run (no checkout, no pull); the automation logs were extracted from `origin/main` via `git cat-file` directly into this directory without touching the data repo's working tree. The user's uncommitted edit is untouched.

Each day's log is rewritten in-place by the automation every ~10 minutes; only the **latest** committed blob for each day is preserved as a single file here. To trace the within-run trajectory of any one day, the script reads the **commit history** for that log path (typically 30–40 commits per day) and walks each blob — that's how [sysdiag-trends.csv](sysdiag-trends.csv) was built.
