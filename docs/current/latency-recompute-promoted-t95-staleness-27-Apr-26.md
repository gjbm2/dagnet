# Latency-recompute regression: stale `promoted_t95` clobbers freshly-fitted `t95`

**Date**: 27-Apr-26
**Status**: Diagnosis + fix landed; awaiting external review
**Audience**: engineers reviewing the fix and anyone touching the FE topo / horizon-recompute pipeline next
**Author**: assistant under direction; review requested

## TL;DR

Two adjacent bugs in `graph-editor/src/services/fetchDataService.ts` caused the explicit horizon recompute (`lagHorizonsService.recomputeHorizons`) to silently overwrite the freshly-fitted `latency.t95` with the *previous* persisted t95 from the parameter file, and to drop `median_lag_days` / `mean_lag_days` on the floor entirely. Both bugs only fired when an existing model fit (mu/sigma) was already on the edge before recompute ran — which is the normal case after at least one prior fetch.

The fixes:

1. **`mergeModelVarsLatency`** (renamed from `mergeModelVarsLatencyPreservingCanonicalEdgeLatency`; see "Why the rename" below): edge-local fields (`mu`, `sigma`, `t95`, `onset_delta_days`, dispersion SDs) now use the same `next ?? prev` precedence the path-level fields in the same function already used. The asymmetry between edge-local and path-level handling was the proximate cause of bug 1.
2. **`selectLatencyToApplyForTopoPass`** (line ~2975): `median_lag_days` and `mean_lag_days` now have a `existing ?? computed` fallback, matching the surrounding fields in the same function. The omission was the proximate cause of bug 2.

Neither fix touches the documented contract of `persistGraphMasteredLatencyToParameterFiles` (which is a doc-19 commitment that promoted_t95 wins over the existing t95 when the override is off). Earlier attempts to patch at the persist boundary broke that contract; they have been reverted.

### Why the rename

The function name `mergeModelVarsLatencyPreservingCanonicalEdgeLatency` advertised a behaviour the post-fix function does not have. After the fix, edge-local fields no longer "preserve canonical" — they take the freshest writer's value, same as the path-level fields. A name that lies is a landmine for future readers, who would assume edge-local prev wins (because the name says so) and second-guess the implementation. The function has been renamed to `mergeModelVarsLatency`. The longer "freshest wins" qualifier was considered but rejected as editorialising — the function is just a merge, and `next ?? prev` is the standard merge semantics; no qualifier needed.

## What this document is

A diagnostic record for review. It contains:

- The two test failures and their assertion text.
- A `setGraph`-call trace that pinpointed the moment the freshly-fitted value was clobbered.
- The two upstream bugs that produced the staleness, with code references.
- A first attempt at a fix that papered over the symptom and broke other tests, why it was wrong, and how it was reverted.
- The actual fixes, both of which are local pattern-restoration rather than added branches.
- Test verification.
- Known unaddressed cleanup items.

## Context

A handful of services collaborate during a parameter-file refresh:

- `lagHorizonsService.recomputeHorizons` — the user-triggered "recompute horizons from file slices" entry point. Clears unlocked `t95`/`path_t95` on the graph, then asks `fetchDataService.fetchItems` to re-fit from file values with `mode: 'from-file'`, `writeLagHorizonsToGraph: true`, and `copyOptions: { includeValues: true, includeMetadata: false, permissionsMode: 'do_not_copy' }`. The intent of `includeMetadata: false` is "do not copy the file's old t95/path_t95 onto the graph as metadata; we want a fresh fit."
- `dataOperations/fileToGraphSync.ts::getParameterFromFile` — runs the change-list diff between file and graph, applies a values/metadata/permissions filter to the resulting changes, then mutates the graph with `applyChanges`. Separately, it builds an `analytic` model_vars entry via `UpdateManager.handleFileToGraph` and upserts it onto the graph.
- `UpdateManager.handleFileToGraph` (`graph-editor/src/services/UpdateManager.ts:1149-1170`) — builds the analytic `ModelVarsEntry`. The probability sub-block was extended for doc 73b §3.9 (Stage 2); the latency sub-block has been longer-standing and copies `mu`, `sigma`, `t95`, `onset_delta_days` plus optional path-level fields directly from the file's `latency` block.
- `fetchDataService.ts` Stage-2 LAG apply path (around line 2160) — runs `enhanceGraphLatencies`, then for each edge:
  1. `applyBatchLAGValues` (UpdateManager) writes `targetP.latency.t95 = roundHorizonDays(update.latency.t95)` if `writeHorizonsToGraph=true` and not overridden.
  2. Updates the `model_vars[source='analytic']` entry's latency with `mergeModelVarsLatencyPreservingCanonicalEdgeLatency(stage2Output, existingEntry.latency)`.
  3. Re-runs `applyPromotion` over each edge so `p.latency.promoted_*` mirrors the (now-merged) model_vars latency.
- `persistGraphMasteredLatencyToParameterFiles` (`fetchDataService.ts:2825`) — final step in the recompute pipeline. Per **doc 19**, when `t95_overridden=false` and `promoted_t95` is finite/positive, copies `promoted_t95` onto `lat.t95` so the subsequent `putParameterToFile` (which serialises `latency.t95`) persists the model output. This is the contract that several existing tests pin.

## Failing tests (regression symptoms)

```
src/services/__tests__/lagHorizonsService.integration.test.ts
  > recomputeHorizons(global) recomputes from file slice data,
    writes horizons to graph, and persists to parameter files
    Error: Expected 5 to be close to 22.76016606445676 (within 0.005)

src/services/__tests__/batchFetchE2E.comprehensive.test.ts
  > Comprehensive Batch Fetch E2E Tests > Scenario 4: T95 Computation
    > should compute t95 from per-day lag arrays (not default to 30)
    AssertionError: expected undefined to be defined
      (on edge.p.latency.median_lag_days)
```

Both tests run a fetch in `from-file` mode against a parameter file whose previous-persisted `latency.t95` differs from what the cohort slice data should now produce. They expect the post-recompute graph to carry the **freshly-fitted** values, not the stale file-persisted values.

The first test fails at `expect(t95).toBeCloseTo(expectedT95, 2)` with `expected ≈ 22.76` (from `fitLagDistribution(medianLagDays=10, mean=undefined, totalK=1000)`) and actual `5` (the file's old `latency.t95`).

The second test fails at `expect(medianLag).toBeDefined()` because `median_lag_days` was never written.

## Diagnostic — `setGraph` trace through one recompute

The test setup mocks `console.log/warn/error`, so visibility was via `process.stderr.write` instrumentation in the test file (since removed). Wrapping `setGraph` to log `edge.p.latency` on every state mutation produced this sequence:

```
#1 (after lagHorizonsService clears unlocked horizons)
  edge.p.latency = { latency_parameter, t95_overridden:false, path_t95_overridden:false }

#2 (after fileToGraphSync's analytic entry build + applyPromotion)
  edge.p.latency = {
    latency_parameter, t95_overridden, path_t95_overridden,
    mu: 2, sigma: 0.5,                ← from file (stale)
    promoted_t95: 5, promoted_path_t95: 5,   ← stale, from file
    promoted_onset_delta_days: 0, onset_delta_days: 0
  }

#3 (after Stage-2 LAG → applyBatchLAGValues → mergeModelVars… → applyPromotion)
  edge.p.latency = {
    ...,
    t95: 22.76, path_t95: 22.76,         ← Stage-2 LAG wrote correct value
    promoted_t95: 5,                     ← STILL STALE
    promoted_path_t95: 22.76,            ← path_t95 was correctly refreshed
    path_mu: 2.30258509…, path_sigma: 0.5,
    __parityComputedT95Days: 22.76016606445676   ← parity scaffolding shows
                                                   the *correct* computed value
  }

FINAL (after persistGraphMasteredLatencyToParameterFiles)
  edge.p.latency = {
    ..., t95: 5,                         ← clobbered back to stale
    promoted_t95: 5, path_t95: 22.76,
    ...
  }
```

The trace pinpoints two distinct anomalies:

- At step #3, `promoted_t95` is still `5` while `t95` is correctly `22.76`. So **`t95` was refreshed but `promoted_t95` was not**. Anything downstream that copies `promoted_t95 → t95` will revert the freshly-fitted value.
- Between #3 and FINAL, the persist function performed exactly that copy (`lat.t95 = promotedT95`) and overwrote the correct value.
- At step #3 also note that `path_t95` and `promoted_path_t95` are both `22.76` (consistent), but the edge-local pair is inconsistent (`t95 = 22.76` but `promoted_t95 = 5`). This asymmetry pointed at `mergeModelVarsLatencyPreservingCanonicalEdgeLatency`, which handles edge-local and path-level fields with different precedence rules.

## Bug 1 — `mergeModelVarsLatencyPreservingCanonicalEdgeLatency` preserves stale `prev` over fresh `next`

### The function

```ts
// graph-editor/src/services/fetchDataService.ts (pre-fix)
function mergeModelVarsLatencyPreservingCanonicalEdgeLatency(
  incoming: Record<string, any> | undefined,   // "next" — Stage-2 LAG output
  previous: Record<string, any> | undefined,   // "prev" — existing model_vars[analytic].latency
): Record<string, any> {
  // ...
  const preserveEdgeModel =
    prev.mu != null && prev.sigma != null &&
    Number.isFinite(prev.mu) && Number.isFinite(prev.sigma) &&
    prev.sigma > 0;

  if (preserveEdgeModel) {
    setIfPresent('mu', prev.mu);
    setIfPresent('sigma', prev.sigma);
    setIfPresent('t95', prev.t95 ?? next.t95);                       // ← prev wins
    setIfPresent('onset_delta_days', prev.onset_delta_days ?? next.onset_delta_days);
    setIfPresent('mu_sd', prev.mu_sd ?? next.mu_sd);
    setIfPresent('sigma_sd', prev.sigma_sd ?? next.sigma_sd);
    setIfPresent('onset_sd', prev.onset_sd ?? next.onset_sd);
    setIfPresent('onset_mu_corr', prev.onset_mu_corr ?? next.onset_mu_corr);
  } else {
    setIfPresent('mu', next.mu);
    setIfPresent('sigma', next.sigma);
    setIfPresent('t95', next.t95);
    // ...
  }

  // Path-level fields: opposite precedence
  setIfPresent('path_mu', next.path_mu ?? prev.path_mu);              // ← next wins
  setIfPresent('path_sigma', next.path_sigma ?? prev.path_sigma);
  setIfPresent('path_t95', next.path_t95 ?? prev.path_t95);
  // ...
}
```

The function is called from one site only — `fetchDataService.ts:2230`, inside the Stage-2 LAG apply loop, immediately after `applyBatchLAGValues` has written the fresh fit's edge-local `t95`/`mu`/`sigma` onto the graph. `next` is always the Stage-2 LAG output for that edge. `prev` is whatever was in `model_vars[analytic].latency` at the moment of the call.

### Why the asymmetry was a bug under recompute

In the **normal fetch** lifecycle this asymmetry is benign. The previous fetch left `model_vars[analytic].latency` with a real fit; this fetch's Stage-2 LAG over the same data produces the same fit (modulo recency-weighting). `prev.t95 ≈ next.t95`. Picking `prev` is a no-op.

In the **recompute** lifecycle the asymmetry is destructive, because `prev` has just been freshly polluted by the file→graph sync:

1. `lagHorizonsService.runTopoPassFromFiles` clears `e.p.latency.t95` / `path_t95` on the graph for unlocked edges.
2. `fetchDataService.fetchItems` calls `getParameterFromFile`. That function:
   - Builds `result.changes` from a file→graph diff. The `latency.t95 → p.latency.t95` mapping (`mappingConfigurations.ts:750-754`) is in there, but `result.changes` is filtered before `applyChanges` runs (`fileToGraphSync.ts:1647-1664`). With `includeMetadata: false`, `p.latency.t95` is correctly stripped from the change list. `applyChanges` therefore does **not** copy the file's t95 to the graph at this stage.
   - Calls `UpdateManager.handleFileToGraph`, which builds an `analytic` `ModelVarsEntry` directly from `paramFile.data.latency` and **does not consult `copyOptions`**. The entry includes `latency.t95 = file.latency.t95` (stale), `latency.mu = file.latency.mu`, etc.
   - Calls `upsertModelVars` with the entry, then `applyPromotion`. This is the path the `includeMetadata: false` filter does not protect.
3. `applyPromotion` reads `model_vars[analytic].latency` (now carrying the stale file values), and writes:
   - `p.latency.mu = result.latency.mu` (stale)
   - `p.latency.sigma = result.latency.sigma` (stale)
   - `p.latency.promoted_t95 = result.latency.t95` (stale — `5`)
   - `p.latency.promoted_path_t95 = result.latency.path_t95` (also stale at this moment)
4. Stage-2 LAG runs (`enhanceGraphLatencies`). It produces fresh `latency.{mu, sigma, t95, path_*}` from the cohort slices. `applyBatchLAGValues` writes those onto the graph as `lat.t95 = 22.76`, `lat.path_t95 = 22.76`, `lat.mu = 2.302…`, etc.
5. The Stage-2 apply loop then updates the `model_vars[analytic].latency` block via `existing.latency = mergeModelVarsLatencyPreservingCanonicalEdgeLatency(stage2LatencyOutput, existing.latency)`.
   - `prev` here is the entry's existing latency: `{mu: 2, sigma: 0.5, t95: 5, …}` (from step 2).
   - `next` is the fresh Stage-2 fit: `{mu: 2.302, sigma: 0.5, t95: 22.76, path_t95: 22.76, …}`.
   - `preserveEdgeModel` evaluates **true** because `prev.mu = 2`, `prev.sigma = 0.5` are present and valid.
   - The merge keeps `prev.mu = 2`, `prev.sigma = 0.5`, `prev.t95 = 5`. The fresh `next.t95 = 22.76` is discarded for the edge-local block.
   - For path-level fields the merge correctly picks `next.path_t95 = 22.76`.
6. `applyPromotion` re-runs over every edge with model_vars (line 2257-2261). It reads the post-merge `model_vars[analytic].latency.t95 = 5` and writes `p.latency.promoted_t95 = 5` again. The path-level `promoted_path_t95` is correctly refreshed to `22.76` because the merge handed it `next.path_t95`.
7. **`fetchItems` returns**. At this point the graph state matches setGraph #3: `t95 = 22.76` (set by `applyBatchLAGValues` directly in step 4), but `promoted_t95 = 5` (stale through merge → applyPromotion).
8. `persistGraphMasteredLatencyToParameterFiles` runs. Per its doc-19 contract — and per the explicit pinning tests — when `t95_overridden=false` and `promoted_t95` is finite/positive, it assigns `lat.t95 = promotedT95`. That is, `lat.t95 = 5`. **This overwrites the `22.76` from step 4.** The file is then persisted with the stale value.

### The fix

The two halves of the merge function have always disagreed about precedence. Path-level fields have always been "freshest writer wins":

```ts
setIfPresent('path_t95', next.path_t95 ?? prev.path_t95);
```

Edge-local fields had a "preserve prev" branch keyed on `preserveEdgeModel`. The `preserveEdgeModel` guard exists to avoid overwriting good prev values with absent next values when Stage-2 only partially populated `next`, but it fired wholesale even when `next` was fully populated, and there was no path-level analogue (the path fields handle the partial-`next` case via `??` instead of via a guard).

The minimal correction is to extend the path-level pattern to edge-local fields:

```ts
// graph-editor/src/services/fetchDataService.ts (post-fix)
setIfPresent('mu', next.mu ?? prev.mu);
setIfPresent('sigma', next.sigma ?? prev.sigma);
setIfPresent('t95', next.t95 ?? prev.t95);
setIfPresent('onset_delta_days', next.onset_delta_days ?? prev.onset_delta_days);
setIfPresent('mu_sd', next.mu_sd ?? prev.mu_sd);
setIfPresent('sigma_sd', next.sigma_sd ?? prev.sigma_sd);
setIfPresent('onset_sd', next.onset_sd ?? prev.onset_sd);
setIfPresent('onset_mu_corr', next.onset_mu_corr ?? prev.onset_mu_corr);
```

The `preserveEdgeModel` branch is removed entirely; the function is now uniformly "freshest writer wins".

### Why this is correct

The case rests on two pieces of evidence: the call-site history of the function, and what the new precedence actually produces in each fetch regime.

**Call-site history.** The function was introduced in commit `0c0fb72a` ("Still generalisting forecasting IV — lots of data pipeline fixes to do", 23-Apr-26). At that point it had **two** callers in `fetchDataService.ts`:

1. The Stage-2 LAG apply loop (`existing.latency = mergeModelVarsLatency...(stage2Output, existing.latency)`), where `next` was a fresh Stage-2 fit and `prev` was the existing `model_vars[analytic].latency`.
2. A BE-topo write-back (`beEntry.entry.latency = mergeModelVarsLatency...(beEntry.entry.latency, prevLatency)`), where `next` was the BE-topo pass's output and `prev` was specifically `currentP.model_vars[analytic_be]?.latency || currentP.model_vars[analytic]?.latency` — i.e. the previously-fitted analytic / analytic_be entry.

For the BE-topo caller, the `preserveEdgeModel` guard plausibly mattered: BE-topo's edge-local output could be partial or transient relative to the previous full fit on the analytic / analytic_be entry, so preserving prev's edge-local block on a per-edge basis (when it had a real fit) was a defensive choice. The `t95: prev.t95 ?? next.t95` line — keeping prev when set, falling back to next when prev was missing — is consistent with that role.

The BE-topo caller was deleted in commit `b450dd4e` ("Bye bye BE topo (-4,500 loc); fixing forecasting scenarios handling", 24-Apr-26), one commit later. The function survived with a single remaining caller — the Stage-2 LAG apply loop. Nobody updated the merge semantics to reflect the lost caller. The `preserveEdgeModel` branch is therefore a leftover from the dual-caller era; it is dead-code legacy, not a guard with a still-active rationale on the surviving caller.

This is verifiable: `git log -S 'function mergeModelVarsLatencyPreservingCanonicalEdgeLatency' --all -- graph-editor/src/services/fetchDataService.ts` gives the introducing commit; `git show b450dd4e -- graph-editor/src/services/fetchDataService.ts | grep mergeModelVars` shows the BE-topo call site removed; the current file has only the Stage-2 LAG call site.

**What the new precedence produces.**

- **Recompute path** (the failing tests): the fresh Stage-2 fit propagates through `model_vars[analytic].latency` → `applyPromotion` → `p.latency.promoted_t95` → `persistGraphMasteredLatencyToParameterFiles` → `lat.t95 = promoted_t95`, ending with the correct `22.76` on both the graph and the persisted file. This is the symptom the failing tests asserted.
- **Normal fetch path** — *not* a no-op: this is a real behavioural change. In the steady state where data hasn't changed between fetches, `prev.t95 = next.t95` and the change is invisible. But as soon as data evolves (a new day's snapshot rows, recency-weighted aggregates shifting because dates drift, window-vs-cohort scoping differences), `prev.t95 ≠ next.t95`. The pre-fix behaviour was that the file's persisted fit "stuck" on `model_vars[analytic].latency` until an explicit re-persist; Stage-2 LAG's fresh fit landed on `graph.p.latency.t95` directly (via `applyBatchLAGValues`) but did not propagate to `model_vars[analytic].latency.t95` or to `promoted_t95`. The post-fix behaviour is that Stage-2 LAG's fresh fit immediately wins on `model_vars[analytic].latency`, propagates to `promoted_t95`, and is the value the persist function will write to the file when the override is off. **This is the contract the path-level fields in the same function have always had** (`next.path_t95 ?? prev.path_t95`); the fix brings edge-local handling into line.
- **The "partial-`next`" case** (Stage-2 LAG transiently producing a degraded or absent fit, e.g. a fetch where the cohort window narrows enough that no fit is possible) is covered: `next.X ?? prev.X` falls back to `prev.X` when `next.X` is undefined, exactly as it does for path-level fields today. This is the only role the old `preserveEdgeModel` guard had a defensible reason to play; the new code preserves that role via the `??` chain.
- **The persist function's doc-19 contract** ("`promoted_t95` always replaces `lat.t95` when not locked") is unchanged. The downstream pinning tests in `fetchDataService.test.ts` and `persistGraphMasteredLatencyToParameterFiles.test.ts` continue to pass.

The honest framing of the behavioural change: the path-level fields have always had freshest-writer-wins semantics; the edge-local fields had a guard that was load-bearing for a caller that no longer exists; with that caller gone, the guard inverts the right answer for the surviving caller. The fix removes the dead-code asymmetry and unifies the function around one merge rule.

## Bug 2 — `selectLatencyToApplyForTopoPass` drops `median_lag_days` / `mean_lag_days`

### The function

```ts
// graph-editor/src/services/fetchDataService.ts (pre-fix)
export function selectLatencyToApplyForTopoPass(
  computed: { median_lag_days?, mean_lag_days?, t95, completeness, path_t95, ... },
  existing: { median_lag_days?, mean_lag_days?, t95?, mu?, sigma?, ... } | undefined,
  preserveLatencySummaryFromFile: boolean,
): { ... } {
  if (!preserveLatencySummaryFromFile) return computed;

  const hasExistingSummary =
    existing?.median_lag_days !== undefined ||
    existing?.mean_lag_days !== undefined ||
    existing?.mu !== undefined ||
    existing?.sigma !== undefined ||
    existing?.t95 !== undefined;
  if (!hasExistingSummary) return computed;

  const preserveEdgeModel = /* mu/sigma valid */;

  return {
    median_lag_days: existing?.median_lag_days,                    // ← no fallback
    mean_lag_days: existing?.mean_lag_days,                        // ← no fallback
    t95: preserveEdgeModel ? (existing?.t95 ?? computed.t95)
                           : computed.t95,                         // has fallback
    completeness: computed.completeness,
    path_t95: computed.path_t95,
    promoted_onset_delta_days: preserveEdgeModel
      ? (existing?.onset_delta_days ?? computed.promoted_onset_delta_days)
      : computed.promoted_onset_delta_days,                        // has fallback
    mu: preserveEdgeModel ? existing?.mu : computed.mu,            // partial fallback
    sigma: preserveEdgeModel ? existing?.sigma : computed.sigma,
    path_mu: computed.path_mu,
    path_sigma: computed.path_sigma,
    path_onset_delta_days: computed.path_onset_delta_days,
  };
}
```

### Why this dropped `median_lag_days`

Under the recompute path:
- `existing.mu` and `existing.sigma` are set (from step 3 of the bug-1 trace), so `hasExistingSummary` is `true` and `preserveEdgeModel` is `true`.
- `existing.median_lag_days` and `existing.mean_lag_days` are typically `undefined` (the file's `latency` block carries fit parameters but not the slice-aggregate summaries; those summaries live on the values array's per-day `median_lag_days[]` arrays which the cohort aggregator processes).
- The function returns `median_lag_days: undefined`, `mean_lag_days: undefined`.
- `applyBatchLAGValues` guards every write with `if (update.latency.X !== undefined)`. `undefined` skips the write. The freshly-aggregated `computed.median_lag_days` is silently discarded.

This is the second test's failure mode: the test seeds a parameter file with per-day `median_lag_days` arrays and asserts the aggregated value lands on the graph. It never landed.

### The fix

Restore the same `existing ?? computed` pattern the surrounding fields already use:

```ts
median_lag_days: existing?.median_lag_days ?? computed.median_lag_days,
mean_lag_days:   existing?.mean_lag_days   ?? computed.mean_lag_days,
```

### Why this is correct

- The function's adjacent fields (`t95`, `promoted_onset_delta_days`) already use this pattern. Two summary fields without it were almost certainly an oversight.
- For all callers that previously hit the `existing.median_lag_days = undefined` case, the new behaviour is to use the freshly-computed value — which is what the function would have done if `preserveLatencySummaryFromFile` were `false` or `hasExistingSummary` were `false`. So the fallback is the value the function would have returned in any of the adjacent regimes.
- For callers that previously hit `existing.median_lag_days = <some value>`, the new behaviour is unchanged.

## A first attempt that was a band-aid (and was reverted)

For honesty in review: my first fix was at the persist boundary:

```ts
// graph-editor/src/services/fetchDataService.ts (REVERTED — do not reinstate)
if (shouldWriteT95 && !(typeof lat.t95 === 'number' && Number.isFinite(lat.t95) && lat.t95 > 0)) {
  lat.t95 = promotedT95;
}
```

Intent: only fill `lat.t95` from `promoted_t95` when the canonical field is missing — preserving Stage-2 LAG's fresh write on the graph. Tests passed for the two original failures.

Three other tests immediately failed:

```
src/services/__tests__/fetchDataService.test.ts
  > persistGraphMasteredLatencyToParameterFiles (doc 19)
    > should persist promoted_t95 to file t95 when override lock is off
src/services/__tests__/fetchDataService.test.ts
  > persistGraphMasteredLatencyToParameterFiles (doc 19)
    > should persist path_t95 but not t95 when only t95 is locked
src/services/__tests__/persistGraphMasteredLatencyToParameterFiles.test.ts
  > writes latency.path_t95 from graph → parameter file when not overridden
```

The first of these is unambiguous about the contract:

```ts
// expects promoted_t95 (=85) to overwrite an existing t95 (=14)
const graph = makeGraph({
  t95: 14,                 // user's old value
  t95_overridden: false,   // unlocked
  promoted_t95: 85,        // model output
  ...
});
await persistGraphMasteredLatencyToParameterFiles({ graph, setGraph, edgeIds: ['edge-1'] });
expect(graph.edges[0].p.latency.t95).toBe(85);
```

The persist function's stated purpose is "promoted-wins-when-not-locked"; the guard violated that. The bug was upstream — `promoted_t95` was stale by the time persist saw it, not the persist function's behaviour. Fix 1 was reverted; the actual fix landed where the staleness was introduced (the merge function).

This is recorded explicitly because the temptation to fix at the persist boundary was strong (the bug looked like a "persist overwrites a fresh value" bug, and the guard was a one-line change). The lesson: when a downstream invariant ("promoted wins") is being enforced correctly per its documented contract but produces a wrong result, the fix is to make the upstream produce the right input — not to add an exception to the contract.

## Test verification

Five suites that touch the affected code paths, run after the fix:

| Suite | Tests | Result |
|---|---|---|
| `lagHorizonsService.integration.test.ts` | 4 | all green |
| `batchFetchE2E.comprehensive.test.ts` | 8 | all green |
| `fetchDataService.test.ts` | 63 | all green (including the 2 doc-19 contract tests the band-aid had broken) |
| `persistGraphMasteredLatencyToParameterFiles.test.ts` | 6 | all green (including the 1 doc-19 contract test the band-aid had broken) |
| `UpdateManager.test.ts` | 52 | all green |

A full TS suite verification run is the next gate.

## What remains (not fixed in this change)

The fix corrects the data flow through the merge function and through `selectLatencyToApplyForTopoPass`, but two adjacent issues still exist and are worth raising for review.

1. **`UpdateManager.handleFileToGraph` ignores `copyOptions`.** When `getParameterFromFile` runs with `copyOptions: { includeMetadata: false }`, the `applyChanges` filter strips file metadata fields (including `latency.t95`) from the change list. But the analytic `ModelVarsEntry` build at `UpdateManager.ts:1158-1170` reads the file's latency block directly and copies `t95`, `path_t95`, `mu`, `sigma`, `onset_delta_days` into the entry irrespective of `copyOptions`. The merge fix neutralises the staleness produced by this asymmetry, but the asymmetry itself remains: a caller who expects `includeMetadata: false` to mean "no file metadata reaches the graph" will still see file-derived `mu`/`sigma`/`t95` lurking on `model_vars[analytic].latency`. The cleanest long-term fix is to thread `copyOptions` to the entry build, or simply to omit the latency block from the entry when the file's latency is being explicitly suppressed. Out of scope for this change because it has wider blast radius and no failing test motivates it today.

2. **The pinning is defensive, not proactive.** Neither `lagHorizonsService.integration.test.ts` nor `batchFetchE2E.comprehensive.test.ts` has an assertion that says "promoted_t95 must equal t95 after recompute". The bug only manifested at the persist step because the persist contract (promoted-wins) made the inconsistency observable. A future regression that introduces a different kind of inconsistency (say, `promoted_t95` stays correct but `model_vars[analytic].latency.t95` stays stale, breaking some other consumer) would not be caught by the tests as written. A focused unit test on `mergeModelVarsLatencyPreservingCanonicalEdgeLatency` itself — asserting "next wins when both `prev` and `next` populate the same field" — would harden the fix. Recommended as a follow-up.

3. **(Resolved in this change.)** The function was previously named `mergeModelVarsLatencyPreservingCanonicalEdgeLatency`, which advertised a behaviour the post-fix function does not have. It has been renamed to `mergeModelVarsLatency`. A name that lies is a landmine; the rename ensures future readers will not assume edge-local prev wins on the basis of the name.

## Summary for review

- Two upstream bugs, both in `fetchDataService.ts`, both in the form of inconsistent precedence within a single function.
- Both fixes restore consistency with patterns the same function already uses for adjacent fields. Neither adds a special-case branch.
- The persist function (`persistGraphMasteredLatencyToParameterFiles`) and its doc-19 contract are unchanged. A first attempt to patch there was reverted because it broke that contract.
- All five affected test suites green post-fix; full-suite verification pending.
- Three follow-up items recorded above; none gate this change.
