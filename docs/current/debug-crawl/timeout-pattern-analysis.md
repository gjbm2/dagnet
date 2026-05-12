# Timeout pattern — they're not random

The renderer-saturation hypothesis (Issue A explains Issue B) does not survive the data. Per-edge analysis of the 12-May run:

- 181 timeouts in the run.
- Only **12 distinct edges** ever timed out. The other 25 edges never timed out, not once.
- All 12 are on graph 3 (`li-energy-simple-v1`). Graphs 1 and 2 (cf-v2, gm-rebuild) — 0 timeouts.
- The 12 are not random; same edges time out every day, multiple times each:

```
 32× parameter-lis-account-created-to-lis-quiz-start
 18× parameter-lis-reg-attempted-to-lis-reg-successful
 18× parameter-lis-household-created-to-lis-account-created
 15× parameter-lis-deal-available-to-lis-reg-attempted
 15× parameter-lis-landing-page-to-lis-household-created
 15× parameter-lis-quiz-complete-to-lis-delegation
 14× parameter-lis-switch-now-to-lis-reg-attempted
 12× parameter-lis-delegation-to-lis-deal-available
 12× parameter-lis-quiz-start-to-lis-quiz-complete
 12× parameter-lis-deal-viewed-to-lis-switch-now
  9× parameter-lis-reg-successful-to-lis-switch-success
  9× parameter-lis-deal-available-to-lis-deal-viewed
```

And the timeouts cluster on specific slice contexts:

```
 40× context(lis-energy-blueprint:immediate-proposals-v3)
 38× context(lis-energy-blueprint:immediate-proposals-v2)
 32× context(lis-onboarding-blueprint:other)
 28× context(lis-onboarding-blueprint:low-intent-v9)
  7× context(lis-energy-blueprint:delayed-proposal-v1)
  6× context(lis-onboarding-blueprint:low-intent-v8)
  5× context(lis-energy-blueprint:immediate-proposals-v4)
  5× context(lis-energy-blueprint:immediate-proposals-v5)
  ...
```

78 of 181 timeouts (43%) are on the two `immediate-proposals-v2/v3` slices alone.

Time gaps between consecutive timeouts: median 100 s, min 60 s, max 428 s. Never bursty.

## What this pattern is consistent with

**Specific Amplitude queries that take longer than the client's 30 s `AbortController` deadline.** [BrowserHttpExecutor.ts:62](../../../graph-editor/src/lib/das/BrowserHttpExecutor.ts#L62) hard-codes `defaultTimeoutMs ?? 30_000`. Big-cohort contexts (`immediate-proposals-v2/v3`, `low-intent-v9`, `other`) likely scan large user populations and exceed that limit. The Amplitude side may eventually return — but the client has already aborted.

The retry backoff (30 → 60 → 120 → 240 → 300 s cap) then interacts badly with Vercel's function-idle timeout (typically 5–15 min before a function goes cold). By the time the wait is 5 min, the next attempt likely hits a cold Vercel function, which costs another ~30 s just to boot — frequently another timeout. After enough cycles, one retry threads the needle and succeeds.

12 edges × ~4 timeout cycles × ~5 min wait per cycle ≈ 240 minutes of pure timeout/retry waste, plus the actual fetch time and the cooldown waits. That accounts for the 8-hour run.

## What it is NOT consistent with

- **Random renderer saturation.** If the renderer were too busy to process IPC, we'd expect scattered timeouts across all edges and all slices. We see the opposite — tight concentration on a known subset.
- **Memory pressure.** Already ruled out by sysdiag (heap flat at 100 MB).
- **Amplitude rate limiting.** Steady ~22/hour pace is wrong for a rate window — we'd see bursts followed by quiet periods.
- **DNS / network flakiness.** Other edges go through fine in the same time window.

## What this points to

- **Issue B is upstream of the client** — slow Amplitude queries hitting a 30 s client deadline that's too tight for those queries.
- **Issue B is independent of Issue A** — removing the Chrome flags will not fix it.

Three handles, in order of effort and impact:

1. **Raise the 30 s deadline for the automation path.** [BrowserHttpExecutor.ts:62](../../../graph-editor/src/lib/das/BrowserHttpExecutor.ts#L62) already supports per-request `timeout`. Plumb a 90–120 s deadline through `dailyRetrieveAllAutomationService` → `retrieveAllSlicesService` → `dataOperationsService.getFromSource` → executor. Manual users keep 30 s for snappy interactive feedback.
2. **Verify `python-api.py` `maxDuration` in [vercel.json](../../../graph-editor/vercel.json).** Flagged in [handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md) — no `maxDuration` set; Vercel default is 10 s (Hobby) or 60 s (Pro). If the function is killed at 10 s, no client-side change helps.
3. **Fix the `cached=0` bug.** Every run reports `cached=0, fetched=80` on graph 1. If the cache key/signature correctly matched yesterday's results, we'd skip the expensive queries entirely. This is the *root* fix — turns an 8-hour overnight grind into a 5-minute "everything cached" pass on days when no signature actually changed. See [hypotheses.md](hypotheses.md) H-NO-CACHE-HITS-ON-GRAPH-1.

## Operational fallback — make the run resumable

Today, a Task-Scheduler kill at the execution time limit loses 8 hours of work; tomorrow starts fresh. If each completed slice were persisted with a "done-for-today" marker, an interrupted run could be picked up by the next morning's trigger (or a manual restart). This is a band-aid — the real fix is to stop the timeouts — but worth scoping separately if Issue B can't be addressed quickly.

## Cross-references

- Full timeline / heap data: [findings-12-May-26.md](findings-12-May-26.md)
- Flag mechanism (Issue A): [browser-flags-analysis.md](browser-flags-analysis.md)
- Cache-zero bug: [hypotheses.md](hypotheses.md) H-NO-CACHE-HITS-ON-GRAPH-1
- 6-Apr-26 Vercel maxDuration note: [handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md](../handover/6-Apr-26-snapshot-batch-retrievals-and-log-review.md)
