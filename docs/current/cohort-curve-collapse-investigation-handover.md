# Cohort Curve Collapse — Investigation Handover

**Status**: Open. The investigation produced one code change which empirically does nothing on the production graph. The agent (me) has been wrong multiple times during this session and the user has correctly pushed back each time. This document is for an external reviewer to evaluate independently of the chat thread.

**Date**: 4-May-26
**Author**: Claude (agent), reporting to greg@nous.co
**Repo state**: One uncommitted edit on branch `feature/snapshot-db-phase0` in [graph-editor/src/services/dataOperations/evidenceForecastScalars.ts](../../graph-editor/src/services/dataOperations/evidenceForecastScalars.ts) and one test addition in [graph-editor/src/services/__tests__/epistemicDispersion.golden.test.ts](../../graph-editor/src/services/__tests__/epistemicDispersion.golden.test.ts). Neither has been committed.

## 1. The reported symptom

User query: a cohort-mode analysis `cohort(27-Apr-26:3-May-26)` for the path `Landing-page → … → switch-registered → switch-success` on the graph `gm-rebuild-jan-26`. Today's date is 2026-05-04, so this is a 7-day cohort window of *very recently arrived* users.

The leaf edge `switch-registered → switch-success` has a fitted edge latency `t95 ≈ 16.6d` and a path-level `t95 ≈ 35.5d`. So users arriving at the anchor (`Landing-page`) within the queried 7-day window have had at most 7 days to traverse a path whose 95th-percentile completion time is around 35 days. Almost no real conversion evidence should yet exist for these cohorts. The user's expectation: with a months-strong epistemic prior (`Beta(1837, 1188)`, mean 0.607) and tiny weak immature evidence, the conditioning posterior should remain near the prior mean.

Actual chart output for the leaf edge in this cohort scenario, captured at the user's `collapse 2` mark: `p_infinity_mean = 0.1696`. The same edge's window-mode scenario in the same render captured `p_infinity_mean = 0.6095` (≈ prior). The cohort posterior has dropped by a factor of ~3.5× away from the prior with effectively zero observed evidence. The user described this as "the cohort curve collapses" and asked the question: how can almost-no-evidence pull the posterior so far from a months-strong prior?

## 2. Diagnostic tooling I used

- `scripts/extract-mark-logs.sh <label>`: bracketed window extraction across `debug/tmp.browser-console.jsonl`, `debug/tmp.session-log.jsonl`, `debug/tmp.python-server.jsonl`, and `debug/tmp.diag-state.json`, plus `debug/graph-snapshots/` files matching the slugified label. CLAUDE.md mandates this as the first action when the user mentions a mark.

- The graph snapshot files in [debug/graph-snapshots/](../../debug/graph-snapshots/) — full graph + analysis state at the mark instant. The snapshot at the `nonsense 2` mark (`1777927532170_700023_nonsense-2_graph-gm-rebuild-jan-26.json`) is the most recent reference state.

- The analysis dump files in [debug/analysis-dumps/](../../debug/analysis-dumps/) — chart-level data from the cohort_maturity analysis, including the per-cohort-per-snapshot `cohort_maturity_points` table and the rendered `data` array containing `midpoint`, `model_midpoint`, `p_infinity_mean`, `evidence_x`, `evidence_y` per `(scenario, tau)`. The dump at `1777921535670_966379_cohort_maturity_from(switch-registered)_to(switch-success).json` (within the original collapse 2 window) is the canonical chart-output reference.

- The Python server log line `[forecast] <scenario>: <edge> p=<value> conditioned=<bool> ... cohorts=<N> rows=<R>` — fires at the conditioning seam. Captured per-edge per-scenario `p_post`, `cohorts`, `rows` for both runs.

- The two private repos are mounted read-only in the workspace; `parameters/gm-registered-to-success.yaml` is the on-disk parameter file for the leaf edge. **Important**: the on-disk file ends `12-Feb-26`. The live IDB-resident state has been refetched and extends to `28-Mar-26` (per `evidence.window_to` on the snapshot). I did not have direct access to the live IDB-resident dailies; my arithmetic on the YAML is on stale data.

- A `python3` reproduction of the FE-topo dispersion estimator at `/tmp/compute_fix_numbers.py`, replicating the JS Williams/Crowder code path against the YAML's daily arrays.

## 3. What I have established as fact

These are claims I have verified directly:

1. **The CF chart output shows the symptom.** [analysis dump line 0 of the rendered `data` for `current` scenario] `p_infinity_mean = 0.1696` for the leaf-edge cohort scenario; `p_infinity_mean = 0.6095` for the window scenario on the same edge in the same render. Both scenarios report `_conditioned: true`, `_cf_mode: "sweep"`.

2. **The `[forecast]` log line for the conditioning result agrees.** `[tmp.python-server.jsonl:3609683]` records `current: switch-registered→switch-success p=0.1696 conditioned=True … cohorts=7 rows=80` at the time of the original collapse 2 mark.

3. **At the rate-conditioning seam, the predictive Beta `(α_pred, β_pred)` is what enters as the IS proposal, not the epistemic Beta `(α, β)`.** [graph-editor/lib/runner/primitive_conditioning.py:780-789](../../graph-editor/lib/runner/primitive_conditioning.py#L780-L789): the proposal-selection block prefers `prior_alpha_pred` / `prior_beta_pred` when present and positive, otherwise falls back to the epistemic safe values. The proposal samples are then importance-reweighted by the per-row Bin(k|n, p·CDF(τ)) likelihood and resampled at [primitive_conditioning.py:881-908](../../graph-editor/lib/runner/primitive_conditioning.py#L881-L908). **The importance weights contain the likelihood only — there is no `π(p)/q(p)` ratio anywhere**, so the IS targets `q(p) · L(D|p)`, not `π(p) · L(D|p)`. In particular, the strong epistemic Beta does not enter the conditioning posterior through this code path; it is sampled separately into `prior_p_draws` purely for the doc-52 mass-ratio mixture at the end.

4. **The doc-52 mixture is too small to recover the prior.** [primitive_conditioning.py:625-668](../../graph-editor/lib/runner/primitive_conditioning.py#L625-L668) mixes `(1−r)` IS-conditioned + `r` prior-only draws, where `r = min(m_S / n_effective, 1)`. For this graph: `n_effective = 7084`, admitted `m_S` for the 7-day cohort window is ~few hundred, so `r ≈ 0.03–0.05`. 95% of the output is the IS-conditioned (proposal-anchored) branch, 5% is epistemic prior. That is not enough to pull a posterior from 0.17 back to 0.61.

5. **The leaf edge's predictive Beta is absurdly wide.** [snapshot at nonsense 2, edge `switch-registered → switch-success`, `model_vars[0].probability`]: `α = 1837.43`, `β = 1188.08`, `α_pred = 1.2773`, `β_pred = 0.8259`. So `κ_pred = α_pred + β_pred ≈ 2.10`. Implied predictive Beta SD `= sqrt(0.6073·0.3927/3.10) ≈ 0.277` — near-uniform over `[0, 1]`. This is what feeds the IS proposal.

6. **The default `RECENCY_HALF_LIFE_DAYS` is 30, not 14.** [graph-editor/src/constants/latency.ts:284](../../graph-editor/src/constants/latency.ts#L284). I asserted 14 multiple times in earlier turns, which was wrong.

7. **`merge_evidence_candidates` collapses multiple retrievals per `(identity, observed_date)` to a single row.** [graph-editor/lib/evidence_merge.py:498-563](../../graph-editor/lib/evidence_merge.py#L498-L563): grouping is by `(dedupe_key, observed_date)`; within a group the latest retrieval wins. So the conditioning seam sees one row per anchor day, not one row per `(anchor day, retrieved_at)`. My initial trajectory-shape diagnosis was wrong on its own terms because it assumed multiple retrievals per cohort survive the merge. The user pointed this out and I retracted.

8. **The bayes compiler implements the trajectory-shape product-of-conditional-Binomials likelihood that my CF retraction was about.** [bayes/compiler/model.py:2783-3022](../../bayes/compiler/model.py#L2783-L3022). It groups snapshots by anchor day, monotonises cumulative counts, decomposes into intervals (`d_j = cum_y[j] − cum_y[j−1]`, `n_j = total_n − cum_y[j−1]`), and emits one Binomial per interval. This is *also* irrelevant to the CF case in this conversation, because CF only ever sees one row per cohort. I noted this as a code-pointer at one point but it does not bear on the production failure.

## 4. What I claimed and was wrong about, in order

This list is for the reviewer to weight my remaining claims appropriately. The user has been right at each step.

### 4.1 First false lead: "double-counted retrievals across snapshots"

I claimed that the CF binder produced ~80 rows for 7 cohorts because each `(anchor_day, retrieved_at)` snapshot becomes a separate independent Bernoulli row in the conditioning likelihood. The user pointed out that the merge collapses these to one row per anchor day before conditioning, so the trajectory-shape framing didn't apply. **I retracted this.** Verified by reading [evidence_merge.py:541-563](../../graph-editor/lib/evidence_merge.py#L541-L563).

### 4.2 Second false lead: "the IS swap is the catastrophic load-bearing bug"

I built up an architectural argument that the IS conditioning seam treats the proposal as if it were the prior (no `π/q` ratio), so any predictive Beta wider than the epistemic prior would render the strong prior inert. The user steered me back to fixing the FE-topo predictive estimator's drift-confusion instead. I followed that instruction and made the edit described in §5. The architectural concern about the IS seam may still be real — fact 3 in §3 above — but the user judged it secondary, and the fix the user prescribed was specific to FE-topo.

### 4.3 Third error: assumed `halfLife = 14`

When working through the math, I asserted that `RECENCY_HALF_LIFE_DAYS = 14`. The actual value is 30. The user corrected this. The correction roughly triples `Σ w_i` and changes the regime in which the Pure-Binomial branch of the estimator fires. My computations *with the wrong halfLife* gave one prediction; with the correct halfLife the prediction is different (see §6), but the production result is also different from the corrected prediction.

### 4.4 Fourth error: I quoted a math result from the param-file YAML simulation as if it would carry over to production

I ran the dispersion estimator against `parameters/gm-registered-to-success.yaml`'s daily arrays, and reported that the fix should jump `κ_pred` from ~5 to ~679 (Pure-Binomial branch) for that data. I treated that as authoritative for production. It is not: the YAML on disk ends 12-Feb-26 and production has refetched data extending to 28-Mar-26. The intra-window drift in production extends through the recency-weighted region in a way the YAML does not capture. **The math against the YAML overstated the fix's effect; the actual fix did not bite in production.**

## 5. The edit that's currently in the tree

I made one substantive edit, attempting to follow the user's prescription:

> Estimate predictive dispersion from the same mature, recency-weighted evidence regime as the forecast mean. Build weighted pseudo-counts `n_i' = w_i · n_i`, `k_i' = w_i · k_i`. Run the existing Williams/Crowder estimator on those. Moment-match `stdev_pred` from that `κ_pred`.

In [graph-editor/src/services/dataOperations/evidenceForecastScalars.ts](../../graph-editor/src/services/dataOperations/evidenceForecastScalars.ts):

1. Extended the `computeRecencyWeightedMatureForecast` return type to also expose two parallel arrays of weighted pseudo-counts — `matureWeightedN` and `matureWeightedK` — built during the same per-day iteration that produces `weightedN` / `weightedK`. Each retained mature day pushes `(w · n, w · k)` onto these arrays. The fallback branch (when censoring leaves no mature days) populates them with the raw full-window arrays so the estimator still has *something* to chew on, mirroring the mean fallback.

2. Replaced the call site at the same function's analytic-block emission so that `rateOverdispersionPredictiveBeta` is called with `dailyResult.matureWeightedN` / `dailyResult.matureWeightedK` instead of the raw full-window `nMeta` / `kMeta` arrays. The rest of the pipeline (moment-match in `buildAnalyticProbabilityBlock`, write into `model_vars[analytic].probability.{alpha_pred, beta_pred}`, flow into the IS proposal) is unchanged.

I also added an `import` of `rateOverdispersionPredictiveBeta` to the test file [epistemicDispersion.golden.test.ts](../../graph-editor/src/services/__tests__/epistemicDispersion.golden.test.ts) and three new tests asserting the contract that drift in raw inputs inflates `phi` and weighted pseudo-counts shrink it. The drift fixture in those tests is a 150-day linear-drift series; the assertions pass against my arithmetic but not against production behaviour, so the test as written is pinning my mental model rather than the production pathology.

The edit is in the tree, not committed. I have not run the full test suite. The dispersion-test file passes locally on its own.

## 6. The arithmetic I ran and what it showed

The script at `/tmp/compute_fix_numbers.py` replicates the JS estimator (`rateOverdispersionPredictiveBeta`) and the `computeRecencyWeightedMatureForecast` per-day weighting, against the on-disk YAML's `values[0].n_daily` / `k_daily` (the analytic baseline window slice). With `halfLife = 30`, `t95 = 16.58`, `maturityDays = 18`, and `asOfDate = 2026-02-12`:

- Old path (raw full-window arrays): `S = 3820`, `N = 113`, `X² = 696.6`, `kappa_pred = 5.34`, `α_pred = 4.06`, `β_pred = 1.28`, predictive SD ≈ 0.170.
- New path (mature, recency-weighted pseudo-counts), still using the existing-formula `(N−1)` chi-squared baseline: `S' = 680`, `N' = 96`, `Σw_i = 18.6`, `X²' = 39.0`. The X²-excess `(X²' − (N′ − 1))` is negative, the Pure-Binomial limit branch fires at [lagDistributionUtils.ts:460-461](../../graph-editor/src/services/lagDistributionUtils.ts#L460-L461), and the estimator returns `kappa_pred = max(1, S' − 1) = 679`, `α_pred = 535.7`, `β_pred = 143.4`, predictive SD ≈ 0.016.
- "Correct-formula" reading (subtract `Σw_i` instead of `(N−1)`): `kappa_pred = 25.4`, `α_pred = 19.8`, `β_pred = 5.6`, predictive SD ≈ 0.072.

That is what my arithmetic says against the YAML. **It does not reflect what the production code actually computes against the live data.**

The production result, captured at the `nonsense 2` mark after the user re-ran with my edit in place: `α_pred` moved from 1.1895 (pre-edit `collapse 2`) to 1.2773 (post-edit `nonsense 2`). Conditioning posterior moved from 0.1696 to 0.1755. Both deltas are ≈ 5–7%. The user noted independently that they had also nudged the cohort `cohort(...)` date range by 1 day between the two runs; that nudge alone could account for the observed delta. **The fix's effect on production is at-or-below the noise of an unrelated 1-day cohort-window shift.**

So either (a) the live `nMeta` / `kMeta` arrays in production differ enough from the on-disk YAML that the estimator is in a fundamentally different regime, or (b) my fix is wrong in a way I haven't pinned down. I have not been able to inspect the live `nMeta` / `kMeta` directly — they are constructed in-memory in `evidenceForecastScalars.ts` during the day-by-day loop and not persisted to any of the dump files I have access to.

## 7. My current best guess at why the fix doesn't bite — flagged as unverified

This section is the user's open question and the part of the document the reviewer should scrutinise hardest. I have given an algebra-flavoured argument in chat and the user did not accept it; I am restating it in writing for review and explicitly marking it as a hypothesis I have not validated.

The Williams/Crowder estimator computes `κ_pred = (S − N)/(X²_excess) − 1`. When the data has substantial smooth drift across the entire considered window — including the recency-weighted region — the per-day Pearson contribution is dominated by `(local_rate_i − aggregate_rate)² · n_i / denomVar`. Under that regime, individual per-day contributions are roughly *constant in i* (same magnitude of squared residual times same `n_i`). I called that constant `c` in chat.

If `c` is roughly constant per day, then:
- `X²_raw` ≈ `c · N`
- `X²_weighted` ≈ `c · Σw_i`
- `S_raw` ≈ `n_avg · N`
- `S_weighted` ≈ `n_avg · Σw_i`

Both numerator `(S − N)` and denominator `(X² − (N−1))` then scale by `Σw_i / N` when you switch from raw to weighted, leaving the ratio approximately invariant. Provided `c · Σw_i > N − 1` (i.e. provided we *don't* fall into the Pure-Binomial branch), `κ_weighted ≈ κ_raw`.

The Pure-Binomial branch only fires when `c · Σw_i < N − 1`. That requires either small `c` (per-day residuals modest — i.e. a near-stationary regime in the weighted region) or small `Σw_i` (heavy temporal concentration — but with `halfLife = 30` over a 180-day mature window, `Σw_i` is around 30–40, not tiny). The param-file simulation's mature window has shorter span, possibly flatter middle-window deciles, and ends up small enough on `c · Σw_i` that the Pure-Binomial branch fires. The production data evidently does not.

**Why I'm unsure**: I have not measured `c` or `X²_weighted` against the live production daily arrays. I have only inferred from the formula's algebraic structure that the cancellation should hold approximately when `c` is roughly day-constant. If `c` is not roughly day-constant in production — for example if the daily n's are highly heterogeneous and the per-day contributions therefore are dominated by a few high-n days — the cancellation argument is weakened. I haven't checked.

There's also a separate concern I haven't pursued: the Williams/Crowder formula's `(N−1)` chi-squared baseline assumes integer-count, weight-1, Binomial residuals contribute 1 unit each in expectation. For weighted pseudo-counts the per-pair expected contribution is `w_i`, not 1, so the proper baseline is `Σ w_i` rather than `(N−1)`. Mechanically using the unmodified estimator on weighted inputs is therefore *also* mathematically inconsistent with the underlying derivation, regardless of whether the recency-weighting succeeds in detrending.

## 8. What the user has asked for and not received

The user prescribed a specific small change ("estimate predictive dispersion from the same mature, recency-weighted evidence regime as the forecast mean") and expected it to materially narrow the predictive Beta. I made that change, observed it has no effect, and cycled through several explanations. The user has explicitly rejected each explanation as either hand-wavy or wrong.

What's still owed:

- A *measured* explanation of why the production `α_pred` barely moved. This requires either inspecting the live `nMeta` / `kMeta` arrays at the moment of fetch, or instrumenting `rateOverdispersionPredictiveBeta` to log `S, K, N, X², kappa_pred, branch` for the leaf edge in production, then re-running.
- A judgment, separate from any algebraic argument, about whether the user's prescribed fix is the right one for this graph at all. If drift continues right through the recency-weighted region (which I believe is what's happening in this dataset), no choice of weights on the Williams/Crowder estimator alone will detrend.
- An honest answer to whether the IS-seam architectural concern (§4.2 above) is actually the load-bearing fix, irrespective of the FE-topo issue. The user pushed back on that framing once already; it should be argued or dropped, not equivocated.

## 9. Files touched

- `graph-editor/src/services/dataOperations/evidenceForecastScalars.ts` — substantive edit, +51 / −7 lines per `git diff --stat HEAD`.
- `graph-editor/src/services/__tests__/epistemicDispersion.golden.test.ts` — added one `import` and one `describe` block of three tests.
- `docs/current/cohort-curve-collapse-investigation-handover.md` — this document.
- `/tmp/compute_fix_numbers.py`, `/tmp/inspect_*.py` — throwaway diagnostic scripts.

No commits. No backend (Python) edits.

## 10. Repro and references

- Capture marks: `collapse 1` ts 1777921532634 / `collapse 2` ts 1777921536394 (pre-edit baseline); `nonsense 1` ts 1777927527676 / `nonsense 2` ts 1777927532168 (post-edit, after a 1-day cohort window nudge). Both via `scripts/extract-mark-logs.sh "<label>"`.
- Snapshot files: `debug/graph-snapshots/1777921536395_828502_collapse-2_graph-gm-rebuild-jan-26.json`, `debug/graph-snapshots/1777927532170_700023_nonsense-2_graph-gm-rebuild-jan-26.json`.
- Analysis dump: `debug/analysis-dumps/1777921535670_966379_cohort_maturity_from(switch-registered)_to(switch-success).json` (and the corresponding nonsense-window dump).
- Diagnostic state dump: `debug/tmp.diag-state.json` at the moment of `collapse 2`.
- Source under examination: `graph-editor/src/services/dataOperations/evidenceForecastScalars.ts`, `graph-editor/src/services/lagDistributionUtils.ts:415-473`, `graph-editor/src/services/modelVarsResolution.ts:422-500`, `graph-editor/lib/runner/primitive_conditioning.py:780-908`, `graph-editor/lib/evidence_merge.py:498-563`, `bayes/compiler/model.py:2783-3022`.

— end —
