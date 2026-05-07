# 73q Daily Conversions Shared Runtime Cutover Plan

**Status**: Proposal (rewrite) — 7-May-26
**Supersedes**: the 4-May-26 version of this document, archived at `docs/archive/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`.
**Scope**: Move daily conversions onto the shared CF runtime by adding a second reducer over the same substrate, without implementing 73p hierarchical per-Cohort conditioning, and without trusting the current legacy daily-conversions arithmetic as an oracle.

## Why this is a rewrite

The first draft of 73q was written before the 73m/73n carrier composition and unified CF runtime work landed. Now that the runtime owns per-Cohort × per-tau conditioned draws, the cutover is structurally smaller and conceptually cleaner than the first draft assumed: there is no second pipeline to build, only an additional reducer over the existing substrate. The first draft framed the cutover around a new preparation helper plus a new projection helper. Both are unnecessary as separate concerns; the preparation already exists inside the cohort_maturity row builder and the projection already produces the data both consumers need.

A second reason to rewrite: the team is not yet confident enough in the current legacy daily-conversions arithmetic to use it as a parity oracle for the cutover. The old plan implicitly leaned on parity-style assertions. The new plan replaces parity with semantic invariants written blind, exercised first against the current legacy path so the tests themselves get hardened before they are asked to bless the cutover.

## Conceptual model

The CF runtime exposes one projection over two axes: **Cohort** and **tau**. Calendar date is not an independent axis; it is the relabel `calendar_date = Cohort.anchor_day + tau`. The same per-(Cohort, tau) draw object can be reduced two ways:

- **Tau reducer** (existing, used by cohort_maturity): keep tau, collapse Cohorts → one row per relative age.
- **Date reducer** (new, used by daily_conversions): keep Cohort=anchor_day=date, pick `tau = eval_age` for each Cohort → one row per Cohort, labelled by its anchor date.

Both reducers consume the same conditioned draws, the same unconditioned overlays, the same band/quantile machinery, the same evidence-vs-forecast layer logic, and the same active-mode prefixes. The difference between the two charts lives entirely in which axis is iterated and which axis is collapsed.

A would-be third reducer (collapse Cohorts on the calendar-date diagonal to produce a projected daily-count series) has no consumer. The existing daily-conversions `data` series is observed-only and already produced directly from snapshot rows by `derive_daily_conversions`; it is not a projection of the runtime.

## Terminology

Capitalisation is semantic.

- **Cohort** means the dated population selected by the query.
- **`cohort()`** means the QueryDSL mode.
- **Cohort mode** means the semantics selected by `cohort()`.
- **Window mode** means the semantics selected by `window()`.

Lower-case "cohort" must not appear as a generic population term in the plan, code comments, or tests added for this work.

## Current state

`derive_daily_conversions` owns observed snapshot arithmetic and produces three artefacts: `data` (observed daily Y deltas keyed by retrieval date, summed across Cohorts), `rate_by_cohort` (per-Cohort latest observed `x`, `y`, `rate`), and `cohort_y_at_age` (per-Cohort cumulative `y` keyed by Cohort age). The bespoke part is the enrichment block in `api_handlers.py` that runs after `derive_daily_conversions` returns: it builds ad hoc evidence objects from `rate_by_cohort` and calls `compute_forecast_trajectory` once for `projected_y` / `forecast_y` / `completeness` / `forecast_bands`, optionally calls `compute_forecast_trajectory` once per latency-band tau, and falls back to `annotate_rows` if the engine call fails.

The CF row/scalar path migrated to `ResolvedCFRuntime` in 73n. Daily conversions did not. This atom finishes that migration.

The FE consumes `rate_by_cohort` as the primary chart input when present and reads observed `data` only as a fallback. The cutover therefore prioritises `rate_by_cohort` correctness; the calendar-date `data` series is preserved unchanged because `derive_daily_conversions` continues to produce it.

## Semantic preservation target

The legacy daily-conversions path asks broadly correct questions: observed daily conversions are evidence deltas from snapshot rows; each `rate_by_cohort` row represents one selected Cohort's latest observed `x`, `y`, and `Y / X` rate; immature selected Cohorts get projected future `Y` rather than being frozen at observed `y`; Window mode and Cohort mode remain different when the carrier is not identity; optional latency bands display evidence when the selected Cohort is old enough and forecast bands otherwise.

These semantic behaviours must survive the cutover. The legacy arithmetic is **not** treated as an oracle. Where the legacy trajectory engine and the shared runtime disagree, the cutover prefers the shared runtime if it is answering the same semantic question more directly. Acceptance is judged by independently-derived semantic invariants, not by line-for-line parity with the old engine.

Non-negotiable preservation points:

- `data` remains observed evidence, not forecast output.
- `rate_by_cohort[].y` and `rate_by_cohort[].x` remain observed latest values.
- `projected_y` remains an eventual or requested-horizon projected count for the selected Cohort, not a rate.
- `forecast_y` remains the non-negative projected residual over observed `y`.
- `forecast_bands` and forecast `latency_bands` remain rate bands over `Y / X`.
- Active Cohort mode uses the runtime's `A → X` carrier for denominator arrival and the runtime's `X → end` subject span for numerator progression.

## Arithmetic authority

The shared runtime is the authority for conditioned probability and timing surfaces. Daily conversions does not reproduce the legacy trajectory engine's internal Pop C / Pop D implementation. The date reducer encodes only the accounting that is genuinely specific to per-Cohort rows: selected Cohort identity and `anchor_day`, observed latest `x` and `y`, per-Cohort tau slices into the runtime draws (multiple slices, see contract below), and the per-Cohort layer/completeness decision. Projection horizon selection is the runtime's responsibility but is not a single number: the contract names which tau index is read for each field, so a Cohort's `projected_y` and a Cohort's `completeness` and a Cohort's `latency_bands` all read different taus from the same draw arrays.

## Reducer field contract

This section is binding for phases 2, 3, and 4. Every consumer field of the daily-conversions response is named here with its substrate source, the tau index at which it is read, the variant of any ambiguous mathematical object it depends on, and its behaviour when the substrate cannot produce the value. Phase 1 tests assert the contract directly. The contract must not be edited without a corresponding plan revision; phase 4 cannot relax it silently.

### Saturation tau

Several fields require a tau index that represents the runtime's saturation horizon — the age beyond which the substrate's per-Cohort `y_draws` have effectively stopped growing. The runtime exposes a single `saturation_tau` per request, derived from the resolved latency distribution as the smallest tau at which the request-rooted CDF is at or above a fixed near-one threshold (matching the legacy `max(t95, 30)` heuristic in spirit but expressed against the conditioned surface, not the prior model). In window and cohort(A=X) modes this is the subject-CDF saturation; in active Cohort mode it is the request-rooted (carrier-convolved subject) CDF saturation. Phase 2 adds `saturation_tau` as a runtime-level accessor; both reducers and any future consumer read the same value. The substrate's `max_tau` is required to be at least `saturation_tau`; if the resolved latency would saturate beyond `max_tau`, the substrate clamps to `max_tau` and the runtime records a degraded-saturation provenance flag.

### Completeness flavour

Per-Cohort `completeness` is read from the **conditioned subject-only CDF** at each Cohort's `eval_age`. The substrate exposes this via a per-Cohort accessor that reads `runtime.composed_subject.cdf_draws[:, eval_age[i]]` (or the corresponding mean fallback) and returns the per-Cohort mean. This object expresses subject-side maturity under the conditioned posterior. It is **not** the same as `_runtime_completeness`, which reads the request-rooted (carrier-convolved in active mode) CDF and is what cohort_maturity scalars use today; in active mode the two diverge by the carrier-delay component. The choice of subject-only completeness here is deliberate: the FE consumer of `rate_by_cohort.completeness` (per-row alpha attenuation, layer thresholding) expresses Cohort conversion-side maturity, not A→end maturity. Cohort_maturity scalar completeness is unchanged by this work.

### Layer rule

Per-Cohort `layer` is determined by the per-Cohort `completeness` value, not by the cohort_maturity tau-vs-frontier rule. Thresholds are: `completeness ≥ 0.95 → 'mature'`; `completeness > 1e-9 → 'forecast'`; otherwise `'evidence'`. This is the legacy daily-conversions layer logic and is preserved verbatim. The threshold constants are read from a shared constants location so cohort_maturity's mature-threshold and daily-conversions' mature-threshold do not drift independently.

### Per-Cohort un-aggregation

The substrate's existing `_selected_cohort_group_rate_draws` accumulates `Y_total` and `X_total` across Cohorts as the loop runs and discards per-Cohort intermediates. The date reducer requires per-Cohort `Y[i, :, τ]` and `X[i, :, τ]` arrays to compute per-Cohort projected counts and per-Cohort rate bands. Phase 2 refactors the projection helper so the per-Cohort arrays are the natural intermediate and the across-Cohort aggregate is computed at consume time by callers who need it. The tau reducer sums per-Cohort arrays into the existing `(S, T)` aggregate when it builds its rows; the date reducer indexes per-Cohort directly. Memory cost is `(N_cohorts, S, T)` for X and Y; for production request shapes this is acceptable and the substrate already pays similar cost in active mode prefixes. An alternative that runs the loop twice (once aggregated, once per-Cohort) is rejected because the per-Cohort arrays are the canonical product of the loop and the aggregate is a derived view.

### Field-by-field contract for `rate_by_cohort` rows

- `date`. The Cohort's `anchor_day` taken from `cohort_list[i]['anchor_day']`. ISO date string. Always populated (a Cohort row implies a known anchor_day). Same value cohort_maturity sees per-Cohort.
- `x`. The Cohort's observed denominator at X. In window and cohort(A=X) modes, sourced from `engine_cohorts[i].x_frozen`. In active Cohort mode, sourced from the SelectedAClockEvidence prefix's `x_frozen` for that Cohort, the same surface the runtime carrier reducer reads (the seam-invariant requirement of `cohort-1apr-falling-k-problem-statement.md` A.4: `x_frozen` and `obs_x` in the active builder must come from one prefix object, never from the legacy frame fallback). When the active prefix is absent for a Cohort, `x` is the Cohort's snapshot-derived `x` from `derive_daily_conversions` and the Cohort row is marked degraded for projection (see degraded handling below).
- `y`. The Cohort's observed numerator. Same source as `x` (active prefix in active mode; `engine_cohorts[i].y_frozen` otherwise).
- `rate`. `y / x` when `x > 0`, otherwise `null`. Computed at the seam, not by the substrate.
- `evidence_y`. Equal to `y`. Field preserved for FE compatibility; no separate substrate read.
- `projected_y`. The mean of per-Cohort `y_draws[i, :, saturation_tau]`. This is the eventual projected Y for the Cohort under the conditioned posterior, evaluated at the runtime's saturation horizon. Not at `eval_age[i]`. When the substrate is moments-only (per-Cohort draws unavailable) or the Cohort is skipped (active mode with no admissible carrier evidence), `projected_y` is `null` and the row's `_projection_provenance` records the reason.
- `forecast_y`. `max(0.0, projected_y - y)` when `projected_y` is not null; otherwise `null`. Trivial readout once `projected_y` is settled.
- `forecast_bands`. Quantiles of per-Cohort `rate_draws[i, :, saturation_tau]` at the four canonical band levels (80, 90, 95, 99), each emitted as `[lower, upper]`. Read at saturation_tau, matching `projected_y`. Computed by the same `_quantiles` helper the tau reducer uses, applied to a 1-D draw vector at the per-Cohort saturation slice. When per-Cohort rate draws are unavailable or all-NaN at saturation_tau, `forecast_bands` is `null`.
- `completeness`. Per-Cohort subject-only conditioned CDF at `eval_age[i]`, as defined in "Completeness flavour" above. Range `[0.0, 1.0]`. Null when `runtime.composed_subject.cdf_draws` and `cdf_mean` are both unavailable.
- `layer`. Derived from `completeness` per the rule in "Layer rule" above. When `completeness` is null, `layer` is `'evidence'` (matches legacy behaviour at age zero).
- `latency_bands`. A map keyed by canonical band labels (`'25d'`, `'50d'`, `'75d'`, etc., matching legacy labels). Band taus are inverse-CDF percentiles of the resolved latency distribution at 0.25, 0.50, 0.75 plus `onset_delta_days`. Each band's value depends on whether `eval_age[i] >= band_tau`:
  - **Evidence side** (`eval_age[i] >= band_tau`): the value is `obs_y_at_age[i, band_tau] / x_frozen[i]`, sourced from `engine_cohorts[i].obs_y[band_tau]` (or the active prefix's `obs_y[band_tau]`) and the Cohort's `x_frozen`. Single rate value, no quantile band.
  - **Forecast side** (`eval_age[i] < band_tau`): the value is the band quantiles of per-Cohort `rate_draws[i, :, band_tau]` at the configured band level (default 90), emitted as `[lower, upper]`.
  - The band-tau accessor `runtime.latency_band_taus()` is added in phase 2 as a single canonical derivation; both reducers read from it. When a band tau exceeds `max_tau`, it is clamped to `max_tau` and the band's provenance records the clamp. Duplicate taus after clamping are deduplicated in tau-then-label order.

### Skipped-Cohort handling in active mode

In active Cohort mode, a Cohort whose anchor_day has no admissible root-window carrier evidence is excluded from substrate aggregation by setting `a_pop = 0`, and the per-Cohort projection arrays carry zeros for that Cohort. The date reducer **must still emit a `rate_by_cohort` row** for such Cohorts, populated from `derive_daily_conversions`'s observed snapshot output: `date`, `x`, `y`, `rate`, `evidence_y` are populated; `projected_y`, `forecast_y`, `forecast_bands`, `completeness`, `layer`, `latency_bands` are `null`; the row carries a `_projection_provenance` field with reason `'no_root_window_evidence'`. This preserves Cohort visibility in the FE — the legacy path produces the row from snapshot reads regardless of whether the engine call succeeds; the new path must do the same.

### Response-level fields

- `data`. Calendar-date observed Y deltas across snapshot rows. Produced by `derive_daily_conversions` unchanged. Not a projection; not derived from the substrate.
- `cohort_y_at_age`. Per-Cohort cumulative observed Y by Cohort age. Produced by `derive_daily_conversions` unchanged. The substrate carries equivalent information in `engine_cohorts[i].obs_y`, but the response field shape is preserved by `derive_daily_conversions`.
- `total_conversions`, `date_range`. Produced by `derive_daily_conversions` unchanged.
- `analysis_type`. Static string `'daily_conversions'`.
- `cf_mode`, `cf_reason`. Read from `runtime` via `get_cf_mode_and_reason(runtime.resolved_override)` exactly as cohort_maturity does today.
- `promoted_source`. Read from `runtime.runtime_provenance.p_conditioning_evidence.source`. Falls back to `runtime.resolved_override.source` if the provenance block is absent. The two sources currently agree by construction; the runtime-provenance form is canonical going forward.

### Cross-reducer consistency

The substrate is the same object for both reducers, so a strong cross-reducer invariant exists, but it is more delicate than a naive aggregation equivalence. The clean form: for any single-Cohort fixture, the cohort_maturity tau-row at `tau = saturation_tau` and the daily-conversions row for that Cohort must agree on the projected `Y / X` rate at that tau. For multi-Cohort fixtures, the cohort_maturity tau-row at any tau equals the across-Cohort sum of per-Cohort `(Y[i, :, τ], X[i, :, τ])` divided once at the end (the substrate's own aggregation rule); daily-conversions per-Cohort rows expose the un-summed view at each Cohort's saturation_tau. Phase 1 tests for cross-reducer consistency are restricted to single-Cohort fixtures or to the explicit aggregation rule, never to a casual "weighted average" form.

## Phases

Each phase is a separable, mergeable chunk. Phases 2 and 3 are mechanically safe (they add capability without changing daily-conversions behaviour). Phase 1 is the calibration step that hardens the contract. Phase 4 is the cutover.

### Phase 1 — Blind invariant tests over the outside-in CLI suite

The goal of this phase is a hardened, oracle-free test bed that future phases must satisfy. Tests are extensions of the existing cohort outside-in CLI test suite (`test_cohort_factorised_outside_in.py`), targeting daily-conversions response shapes for the same synthetic graphs that already cover cohort_maturity. Tests must be authored without consulting the current legacy daily-conversions output as ground truth.

#### Phase 1a — Author tests blind

Extend the existing outside-in CLI tests with daily-conversions cases. Tests assert the "Reducer field contract" section above. The contract is the source of truth for what each field means; tests assert the contract's claims, not the legacy implementation's outputs. The required coverage classes are:

- **Observed-evidence derivation.** The `data` series equals the simple sum of positive Y deltas across snapshot rows by `retrieved_at`, derivable from raw snapshot rows without consulting any runtime output. Each `rate_by_cohort[].x` and `[].y` equal the Cohort's latest observed snapshot `x` and `y` (or the active-mode prefix `x_frozen` and `y_frozen` when the seam invariant requires it). `evidence_y` per Cohort equals the row's observed `y`.
- **Saturation-tau slicing.** `projected_y` for an immature Cohort is strictly greater than the Cohort's observed `y`, because `projected_y` is read at saturation_tau (not at the Cohort's current age). For a Cohort whose age substantially exceeds saturation_tau, `projected_y ≈ y`. This invariant directly tests that the date reducer slices at saturation, not at eval_age.
- **Projection bounds.** For every Cohort row with non-null projection: `projected_y ≥ y`, `forecast_y = projected_y − y ≥ 0`, `projected_y` not exceeding the row's `x` denominator under window or cohort(A=X) modes (in active mode the bound is the substrate-derived `a_pop`, not `x`), and `rate ∈ [0, 1]` whenever `x > 0`.
- **Band geometry.** For each Cohort and each `forecast_bands` level, `bands[level][hi] ≥ bands[level][lo]`. Higher confidence levels strictly contain lower ones: `bands['99'][lo] ≤ bands['95'][lo]` and `bands['99'][hi] ≥ bands['95'][hi]`. The band midpoint is plausible relative to `projected_y / x`.
- **Completeness flavour.** Per-Cohort `completeness` reads the conditioned subject-only CDF at the Cohort's age, not the request-rooted CDF. Test fixture: in active Cohort mode (A != X), with a carrier whose CDF is materially different from identity at the Cohort's eval_age, daily-conversions completeness for that Cohort must differ from `_runtime_completeness` evaluated at the same eval_age. The test exercises the contract's deliberate divergence in active mode.
- **Layer rule.** Layer is `'mature'` iff `completeness ≥ 0.95`; `'forecast'` iff `1e-9 < completeness < 0.95`; `'evidence'` otherwise. Tests cover all three transitions, parameterised by Cohort age relative to resolved-latency saturation.
- **Mode invariants.** In Window mode, two Cohorts with similar evidence and dissimilar age-on-eval-date converge to a common asymptotic projected rate as both ages grow (because saturation_tau readout is the same for both). In active Cohort mode, `rate` remains `Y / X` (never `Y / A`); changing the carrier identity changes `projected_y` for the same observed `(x, y)`.
- **Multi-hop subjects.** A multi-hop subject's daily-conversions projection differs from a hypothetical terminal-edge-only projection when the intermediate edges have non-trivial `p`; a synthetic graph with a known intermediate-edge `p` can assert this without revealing the exact projection number.
- **Latency bands.** Per the contract: when `eval_age[i] >= band_tau`, the band reads observed evidence (`obs_y[band_tau] / x_frozen`); when `eval_age[i] < band_tau`, the band reads per-Cohort `rate_draws[:, band_tau]` quantiles. Band rates are non-decreasing in tau within a Cohort because Y is monotone in age. Band taus exceeding `max_tau` are clamped per contract; duplicate clamped taus deduplicate. The band-tau accessor on the runtime returns the same set both reducers see.
- **Skipped-Cohort visibility.** In active Cohort mode, a Cohort with no admissible root-window carrier evidence still produces a `rate_by_cohort` row, with snapshot-derived `date`, `x`, `y`, `rate`, `evidence_y` populated and projection fields null with `_projection_provenance.reason == 'no_root_window_evidence'`. The Cohort is not silently dropped.
- **Selected set.** The number of `rate_by_cohort` rows equals the number of Cohorts admitted by the `window()` or `cohort()` clause and the same date bounds extracted by subject resolution.
- **Cross-reducer consistency (single-Cohort fixtures only).** For a single-Cohort synthetic graph, the cohort_maturity row at `tau = saturation_tau` and the daily-conversions row for that Cohort agree on `Y / X` at saturation. Multi-Cohort cross-reducer assertions express the explicit aggregation rule (across-Cohort `Σ Y[i, :, τ] / Σ X[i, :, τ]` matches cohort_maturity at tau τ), never a casual weighted-average form.
- **Static-shape invariants.** The daily-conversions response under the runtime-backed path includes `cf_mode`, `cf_reason`, and `promoted_source` whenever the legacy path emits them, with no removed or renamed fields.

Tests must use synthetic graphs whose semantic answers are derivable independently of the implementation. Where an exact value is not derivable blind, the assertion is a bound, an ordering, a contract-defined relationship, or a single-Cohort cross-reducer equality, never a hard-coded number copied from a current run.

#### Phase 1b — Run blind tests against current main and harden

Run the phase 1a tests against the current daily-conversions path on `main` (the legacy trajectory enrichment in `api_handlers.py`). Three outcomes are possible per assertion:

- **Pass on legacy.** The legacy path satisfies the invariant. The assertion stays as-is and becomes a regression guard for the cutover.
- **Fail on legacy because the test is over-tight.** The invariant is genuinely weaker than the assertion expressed it. Loosen the assertion to the minimum bound that still pins the contract. Record the original tighter form in a comment on the test as a future strengthening candidate.
- **Fail on legacy because the legacy path is wrong.** Mark the test as expected-fail with a written reason, and record the legacy gap in this document's "Known legacy gaps" section (added during phase 1b). The cutover in phase 4 is required to clear that expected-fail.

The phase 1b output is a calibrated invariant suite, a documented list of legacy gaps, and a clear definition of what phase 4 must achieve to be considered correct. No production code changes in phase 1.

### Phase 2 — Substrate expansion

The CF runtime currently aggregates per-Cohort intermediates before the row builder sees them, scalarises completeness across Cohorts, and leaves latency-band tau selection to callers. Phase 2 adds a small set of named accessors required by the field contract above. Phase 2 is internal to the runtime substrate and has zero observable effect on daily conversions, cohort_maturity, or any other current consumer.

Required accessors and refactors:

- **Per-Cohort projection arrays.** Refactor `_selected_cohort_group_rate_draws` so its natural intermediate is per-Cohort `(N_cohorts, S, T)` arrays for X and Y, with the across-Cohort `(S, T)` aggregate computed at consume time. Return both views on `SelectedCohortProjection`. The tau reducer sums per-Cohort into the aggregate it already uses; the date reducer indexes per-Cohort directly. Per-Cohort `rate_draws` is computable as `Y_per_cohort / X_per_cohort` with the substrate's existing NaN policy.
- **Saturation-tau accessor.** Add `runtime.saturation_tau` (or an equivalent named field), derived from the conditioned request-rooted CDF crossing a fixed near-one threshold (window/cohort(A=X) reads `composed_subject.cdf_draws`; active mode reads the carrier-convolved request-rooted CDF). Clamp to `max_tau` if the resolved latency saturates beyond the substrate's tau horizon, and record a degraded-saturation provenance flag when clamping occurs. Both reducers and any future consumer read this single value.
- **Per-Cohort subject-only completeness accessor.** Add a per-Cohort accessor that returns `runtime.composed_subject.cdf_draws[:, eval_age[i]].mean()` (or the cdf_mean fallback) for each Cohort. This is the daily-conversions completeness flavour. The existing `_runtime_completeness` (request-rooted, weighted scalar) is unchanged and continues to serve cohort_maturity scalar output.
- **Latency-band tau accessor.** Add `runtime.latency_band_taus()` returning an ordered, deduplicated, clamped sequence of `(band_tau, label)` pairs derived from the resolved latency distribution's inverse-CDF at the canonical percentiles plus `onset_delta_days`. Clamp policy: any band tau exceeding `max_tau` is clamped to `max_tau`; duplicate clamped taus are deduplicated in tau-then-label order. Both reducers and any future consumer read this single accessor.
- **Resolved-source provenance.** Confirm `runtime.runtime_provenance.p_conditioning_evidence.source` is populated at runtime construction time and accessible without traversing diagnostic blobs. If a separate accessor is cleaner than reaching through the provenance dict, add it.

Phase 2 is complete when:
- the cohort_maturity outside-in tests still pass unchanged through the refactored projection helper;
- the new substrate accessors are individually exercised by direct unit tests against synthetic substrates;
- no daily-conversions wiring exists yet.

### Phase 3 — Date reducer

Add a sibling of the existing tau-axis row builder, in the same module, implementing the field contract above. The date reducer takes the same substrate inputs as the tau reducer (runtime, frame evidence, selected A-clock evidence, per-Cohort eval ages and weights, max_tau, tau_solid_max, sweep_to, band_level, cohort_list) plus the per-Cohort draws, per-Cohort subject-only completeness, saturation_tau, and latency-band tau set exposed in phase 2.

For each Cohort the reducer emits one `rate_by_cohort` row whose fields are populated from the contract. The contract names which substrate accessor and which tau index each field reads — the reducer is mechanical relative to that contract. In particular: `projected_y` and `forecast_bands` slice per-Cohort draws at `saturation_tau`, not at `eval_age`; `completeness` reads the per-Cohort subject-only conditioned CDF at `eval_age`; `layer` is the completeness-thresholded rule from `forecast_application.annotate_data_point`, not the tau-reducer's `tau ≤ frontier_age` rule; `latency_bands` per band tau use the contract's evidence-vs-forecast split based on `eval_age[i] >= band_tau`.

Skipped-Cohort rows in active mode are emitted with snapshot-derived observed fields populated and projection fields null, per the contract. The date reducer does not bind evidence, condition primitives, choose priors, recompute carrier state, or introduce any per-Cohort posterior. It is a strict readout of the existing substrate. Where the substrate cannot project (degraded runtime), the reducer emits null projection fields with explicit `_projection_provenance` rather than substituting any other machinery.

Phase 3 also extracts the preparation block from `compute_cohort_maturity_rows_v3` into a shared substrate-builder that both reducers call. The cohort_maturity row builder becomes substrate-builder plus tau reducer; the new daily-conversions row builder is substrate-builder plus date reducer. Phase 3 still does not change daily-conversions response behaviour, because the new daily-conversions row builder is not yet wired in.

Phase 3 is complete when:
- cohort_maturity outside-in tests pass unchanged through the extracted substrate path;
- the new date reducer is exercised by direct unit tests against the same synthetic substrates as cohort_maturity;
- the date reducer's behaviour matches the field contract on every field, including degraded and skipped-Cohort cases;
- no api_handlers wiring change yet.

### Phase 4 — Wire into daily conversions and retire the legacy path

Replace the daily-conversions enrichment block in `api_handlers.py` with a single call into the new substrate-builder plus date reducer. Delete:

- the local imports of `compute_forecast_trajectory` and `CohortEvidence` inside the daily-conversions branch;
- the ad hoc `_engine_cohorts`, `_row_map`, and `_cohort_real_ages` construction whose only purpose is to drive `compute_forecast_trajectory`;
- the main `_sweep` trajectory call;
- the per-latency-band `_band_cohorts` construction and `_band_sweep` call;
- the daily-conversions `annotate_rows` fallback block (already a silent no-op for projection fields under a known field-name mismatch);
- comments that describe daily conversions as a surviving legacy trajectory-engine consumer.

Rewrite, do not preserve, any test whose only purpose is to bless `compute_forecast_trajectory` as the daily-conversions enrichment mechanism. Keep the semantic assertions; point them at the runtime-backed projection.

Keep:

- `derive_daily_conversions` and its observed-delta tests, because the calendar-date `data` series remains observed-only and continues to come from snapshot rows.
- FE normalisation of `rate_by_cohort` fields in `graphComputeClient.ts`.
- `compute_forecast_trajectory` itself, because `surprise_gauge` remains outside this plan.
- `annotate_rows` generally, because other legacy paths still use it; only the daily-conversions fallback is retired here.
- `cohort_y_at_age`, because the latency-band evidence side reads it. (The substrate already carries per-Cohort observed `y_at_age` in `engine_cohorts[i].obs_y[tau]`; the FE field `cohort_y_at_age` is preserved as the response-shape contract, populated by the date reducer where applicable.)

Phase 4 is complete when:

- the phase 1 invariant suite passes against the runtime-backed daily-conversions path;
- every assertion that was marked expected-fail in phase 1b for legacy-gap reasons now passes (the cutover is required to clear those);
- no assertion that passed against legacy now regresses;
- a static search shows no daily-conversions call to `compute_forecast_trajectory` and no daily-conversions fallback to `annotate_rows`.

## Invariants

The plan as a whole must preserve these controls:

- **Selected-set conditioning.** The posterior is conditioned on the full selected set of Cohorts scoped by the `window()` or `cohort()` query, exactly as the current shared CF runtime does.
- **No 73p semantics.** No hierarchical per-Cohort posterior, no hyperprior fitting, no partial pooling, no new per-Cohort posterior schema.
- **No duplicate forecast engine.** After phase 4, daily conversions does not call `compute_forecast_trajectory`. The only remaining public-path caller is whatever non-daily consumer is still pending migration.
- **No projection-time conditioning.** The date reducer does not bind evidence, condition primitives, apply doc-52, choose priors, or rebuild carrier or subject spans.
- **`Y / X` invariant.** Rates are always subject-end `Y` over denominator-at-`X`; Cohort mode never becomes `Y / A`.
- **Carrier ownership.** In active Cohort mode, denominator arrival is owned by the runtime carrier object. Daily conversions does not recompute or bypass `A → X`.
- **Subject ownership.** Numerator progression is owned by the runtime subject span. Daily conversions does not silently use a terminal edge when the request subject is multi-hop.
- **Observed evidence preserved.** `derive_daily_conversions` remains the source for observed daily deltas and observed `y_at_age`; the runtime projection does not rewrite observed history.
- **No legacy fallback.** The daily-conversions `annotate_rows` fallback is removed in phase 4. If the runtime cannot project, the response emits unavailable / degraded projection fields with provenance rather than silently switching machinery.
- **Two reducers, one substrate.** The substrate is a single shared function called by both the tau reducer (cohort_maturity) and the date reducer (daily_conversions). No new subject-resolution path, no new evidence-binding path, no second runtime construction.
- **Field contract is binding.** The "Reducer field contract" section is the source of truth for every field of the daily-conversions response. The date reducer implements that contract; phase 1 tests assert it; phase 4 cannot relax it without a corresponding plan revision. Daily_conversions and cohort_maturity differ in `layer` rule (completeness threshold vs frontier), in `completeness` flavour (subject-only conditioned vs request-rooted), and in tau slice (mixed eval_age and saturation_tau vs all taus); they share substrate, draws, bands, and quantile machinery.
- **Terminology discipline.** Use **Cohort**, **`cohort()`**, **Cohort mode**, and **Window mode** consistently.

## Non-goals

- No 73p hierarchical per-Cohort conditioning.
- No per-Cohort posterior schema.
- No new frontend chart type requirement.
- No migration of `surprise_gauge`.
- No change to observed snapshot delta derivation.
- No change to FE normalisation, except for accepting additive fields already present in the backend response.
- No gross-fitted numerator admission.
- No broad rewrite of cohort_maturity row arithmetic.
- No projected calendar-date forecast series. The third theoretical reducer (Cohort-collapsed diagonal of the substrate) has no consumer and is explicitly out of scope.

## Acceptance

The atom is complete when:

- the phase 1 invariant suite is calibrated and committed;
- the substrate exposes per-Cohort draws, per-Cohort completeness, and a latency-band tau accessor;
- the date reducer exists alongside the tau reducer over a single shared substrate-builder;
- daily conversions in `api_handlers.py` derives forecast enrichment from the substrate plus date reducer, not from the trajectory engine;
- the phase 1 invariant suite passes against the runtime-backed daily-conversions path;
- every legacy-gap expected-fail recorded in phase 1b is cleared by the cutover;
- existing daily-conversions response fields remain present;
- a static search shows no daily-conversions `compute_forecast_trajectory` call and no daily-conversions `annotate_rows` fallback;
- any remaining `compute_forecast_trajectory` public caller is explicitly outside this plan's scope.
