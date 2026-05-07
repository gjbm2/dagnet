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

The substrate already computes a single principled saturation horizon per request. `build_cohort_evidence_from_frames` produces `fe.saturation_tau = max(max_tau, ceil(2 × t95))` capped at 400, where `t95` is the resolved latency 95th percentile (path-level in cohort mode, edge-level in window mode). This is the existing single source of truth and is already the value `compute_cohort_maturity_rows_v3` passes to `_runtime_completeness` as horizon. The date reducer reads `fe.saturation_tau` from the substrate bundle for every field whose contract requires "evaluated at saturation". This plan does not introduce a new saturation definition, a percentile threshold, a floor, or a fallback. If the existing definition is wrong for some semantic question, that is a substrate change outside 73q's scope.

The substrate's per-Cohort projection arrays must extend to `fe.saturation_tau`. Today `_selected_cohort_group_rate_draws` is called with `horizon=fe.max_tau`, which can be smaller than `fe.saturation_tau`. Phase 2 aligns the projection horizon with `fe.saturation_tau` so the date reducer can index per-Cohort draws at saturation without re-running the projection at a different horizon.

### Completeness

Completeness is owned by the runtime per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §9: "Chart rows, CF scalar responses, graph-enrichment fields, and overlays are projections of the already-resolved runtime object. They must not contain their own carrier, subject-span, p∞, completeness, or admission logic." The date reducer therefore does not choose a completeness flavour. It reads a per-Cohort variant of the existing `_runtime_completeness` object — the same request-rooted CDF readout that cohort_maturity's scalar completeness already uses — at each Cohort's `eval_age`. Phase 2 exposes the pre-aggregation per-Cohort values from `_runtime_completeness`'s existing internal computation; it does not introduce a new completeness definition. If the runtime's request-rooted definition is later judged wrong for active-mode daily-conversions display semantics, that is a runtime change with its own atom and its own tests, not a date-reducer-local override.

### Layer

`layer` is a daily-conversions-only field (cohort_maturity rows do not carry one). The rule and constants are already defined in `forecast_application.py`: `MATURITY_THRESHOLD = 0.95`, `COMPLETENESS_EPSILON = 1e-9`, and `annotate_data_point` already encodes the rule as `c ≥ MATURITY_THRESHOLD → 'mature'; c > COMPLETENESS_EPSILON → 'forecast'; else 'evidence'`. The date reducer imports the constants and applies the existing rule to its per-Cohort completeness reading. No new constants. No reimplementation of the rule.

### Per-Cohort un-aggregation

The substrate's existing `_selected_cohort_group_rate_draws` accumulates `Y_total` and `X_total` across Cohorts as the loop runs and discards per-Cohort intermediates. The date reducer requires per-Cohort `Y[i, :, τ]` and `X[i, :, τ]` arrays to compute per-Cohort projected counts and per-Cohort rate bands. Phase 2 refactors the projection helper so the per-Cohort arrays are the natural intermediate and the across-Cohort aggregate is computed at consume time by callers who need it. The tau reducer sums per-Cohort arrays into the existing `(S, T)` aggregate when it builds its rows; the date reducer indexes per-Cohort directly. Memory cost is `(N_cohorts, S, T)` for X and Y; for production request shapes this is acceptable and the substrate already pays similar cost in active mode prefixes. An alternative that runs the loop twice (once aggregated, once per-Cohort) is rejected because the per-Cohort arrays are the canonical product of the loop and the aggregate is a derived view.

### Field-by-field contract for `rate_by_cohort` rows

- `date`. The Cohort's `anchor_day` taken from `cohort_list[i]['anchor_day']`. ISO date string. Always populated (a Cohort row implies a known anchor_day). Same value cohort_maturity sees per-Cohort.
- `x`, `y`, `rate`. Sourced unchanged from `derive_daily_conversions(rows)` output — the snapshot-derived observed denominator, numerator, and ratio per Cohort. The substrate carries its own `x_frozen` / `y_frozen` per Cohort (from the active-mode prefix or the engine_cohort, depending on the seam invariants the substrate already enforces) which it uses internally for projection arithmetic; the displayed `x` / `y` / `rate` on the response row are not overwritten by the substrate's view. This preserves legacy display behaviour and avoids surfacing substrate prefix vs snapshot disagreements as a behaviour change in this atom.
- `evidence_y`. Equal to `y`. Field preserved for FE compatibility; no separate substrate read.
- `projected_y`. The mean of per-Cohort `y_draws[i, :, fe.saturation_tau]`. This is the projected Y for the Cohort under the conditioned posterior, evaluated at the substrate's existing saturation horizon (defined above). Not at `eval_age[i]`. When the substrate is moments-only (per-Cohort draws unavailable) or the Cohort is skipped (active mode with no admissible carrier evidence), `projected_y` is `null` and the row's `_projection_provenance` records the reason.
- `forecast_y`. `max(0.0, projected_y - y)` when `projected_y` is not null; otherwise `null`.
- `forecast_bands`. Quantiles of per-Cohort `rate_draws[i, :, fe.saturation_tau]` at the band levels the tau reducer already emits, computed by the same `_quantiles` helper the tau reducer uses. When per-Cohort rate draws are unavailable or all-NaN at `fe.saturation_tau`, `forecast_bands` is `null`. Band-level set is whatever the tau reducer is already producing today; this plan does not redefine it.
- `completeness`. Per-Cohort variant of `_runtime_completeness` evaluated at `eval_age[i]` (see "Completeness" above). Range `[0.0, 1.0]`. Null when the runtime cannot produce a CDF readout at all.
- `layer`. Derived from `completeness` by importing `MATURITY_THRESHOLD`, `COMPLETENESS_EPSILON`, and the existing rule from `forecast_application.annotate_data_point` (see "Layer" above). When `completeness` is null, `layer` is `'evidence'` (the natural value at the rule's `c ≤ COMPLETENESS_EPSILON` branch when `c` is treated as zero).
- `latency_bands`. A map keyed by canonical band labels matching the legacy labels (`'25d'`, `'50d'`, `'75d'`). Band taus are inverse-CDF percentiles of the resolved latency distribution at 0.25, 0.50, 0.75 plus `onset_delta_days` — the existing legacy derivation, lifted into a single substrate accessor. Per band:
  - **Evidence side** (`eval_age[i] ≥ band_tau`): the value is `obs_y_at_age[i, band_tau] / x_frozen[i]`, sourced from `engine_cohorts[i].obs_y[band_tau]` (or the active prefix's `obs_y[band_tau]`) and the Cohort's `x_frozen`. Single rate value.
  - **Forecast side** (`eval_age[i] < band_tau`): the value is the quantile band of per-Cohort `rate_draws[i, :, band_tau]` at the same band level the tau reducer is emitting today.
  - When `band_tau > fe.saturation_tau` (the substrate's draw horizon, the largest tau the per-Cohort projection arrays cover), the band is `null` with `_projection_provenance.reason = 'band_tau_above_saturation'`. The reducer does not silently clamp band_tau or substitute a different value; the substrate's saturation horizon is authoritative and a band beyond it is genuinely unavailable.

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
- **Saturation-tau slicing.** `projected_y` for an immature Cohort is strictly greater than the Cohort's observed `y`, because `projected_y` is read at `fe.saturation_tau` (not at the Cohort's current age). For a Cohort whose age is at or beyond `fe.saturation_tau`, `projected_y ≈ y`. The test references `fe.saturation_tau` directly from the substrate bundle, not a hardcoded number.
- **Projection bounds.** For every Cohort row with non-null projection: `projected_y ≥ y`, `forecast_y = projected_y − y ≥ 0`, `projected_y` not exceeding the row's `x` denominator under window or cohort(A=X) modes (in active mode the bound is the substrate-derived `a_pop`, not `x`), and `rate ∈ [0, 1]` whenever `x > 0`.
- **Band geometry.** For each Cohort and each `forecast_bands` level, `bands[level][hi] ≥ bands[level][lo]`. Higher confidence levels strictly contain lower ones at every level pair the tau reducer also emits. The band midpoint is plausible relative to `projected_y / x`.
- **Completeness identity with cohort_maturity.** For the same request and the same Cohort's `eval_age`, the date reducer's per-Cohort completeness reads the same `_runtime_completeness` underlying CDF that cohort_maturity scalar uses, evaluated at this Cohort's `eval_age` rather than weighted across all Cohorts. Test: take cohort_maturity's scalar completeness for a single-Cohort fixture and confirm the daily-conversions per-Cohort completeness equals it. This pins the contract that the date reducer does not have its own completeness logic.
- **Layer rule.** Layer values come from `forecast_application.annotate_data_point`'s rule applied to the per-Cohort completeness. Tests parameterise Cohort age relative to `fe.saturation_tau` and confirm the three transitions; threshold values are imported from `forecast_application` constants, not hardcoded in the test.
- **Mode invariants.** In Window mode, two Cohorts with similar evidence and dissimilar age-on-eval-date converge to a common asymptotic projected rate as both ages grow (because saturation_tau readout is the same for both). In active Cohort mode, `rate` remains `Y / X` (never `Y / A`); changing the carrier identity changes `projected_y` for the same observed `(x, y)`.
- **Multi-hop subjects.** A multi-hop subject's daily-conversions projection differs from a hypothetical terminal-edge-only projection when the intermediate edges have non-trivial `p`; a synthetic graph with a known intermediate-edge `p` can assert this without revealing the exact projection number.
- **Latency bands.** Per the contract: when `eval_age[i] ≥ band_tau`, the band reads observed evidence (`obs_y[band_tau] / x_frozen`); when `eval_age[i] < band_tau`, the band reads per-Cohort `rate_draws[:, band_tau]` quantiles. Band rates are non-decreasing in tau within a Cohort because Y is monotone in age. Band taus above `fe.saturation_tau` produce null bands with provenance, not silently substituted values. The band-tau accessor on the runtime returns one canonical set; both reducers see it.
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

Required accessors and refactors. Each is a plumbing or shape change against an existing principled object; none introduce a new mathematical definition or a magic constant.

- **Per-Cohort projection arrays at saturation horizon.** Refactor `_selected_cohort_group_rate_draws` so its natural intermediate is per-Cohort `(N_cohorts, S, T)` arrays for X and Y, with the across-Cohort `(S, T)` aggregate computed at consume time. Return both views on `SelectedCohortProjection`. The tau reducer sums per-Cohort into the aggregate it already uses; the date reducer indexes per-Cohort directly. Per-Cohort `rate_draws` is computed as `Y_per_cohort / X_per_cohort` with the substrate's existing NaN policy. Change the call-site horizon from `fe.max_tau` to `fe.saturation_tau` so per-Cohort draws cover the same horizon `_runtime_completeness` already uses.
- **`fe.saturation_tau` plumbed through the substrate bundle.** The shared substrate-builder extracted in phase 3 returns `fe.saturation_tau` on its bundle so the date reducer reads it without retraversing internals. No new derivation; this is the existing value.
- **Per-Cohort completeness from `_runtime_completeness`.** Refactor `_runtime_completeness` to expose the per-Cohort values it already computes internally, prior to the across-Cohort weighted reduce. The existing scalar return becomes one view; the per-Cohort array becomes the other. Same underlying CDF object, same horizon, same definition. The cohort_maturity scalar caller is unchanged.
- **Latency-band tau accessor.** The legacy daily-conversions enrichment computes the band tau set inline in `api_handlers.py` from the resolved latency: `inverse_cdf(0.25/0.50/0.75, mu, sigma) + onset_delta_days`, with `max(1, round(raw))` to discretise and a deduplication step on the resulting integer set. Lift that exact derivation into a substrate accessor (e.g. `runtime.latency_band_taus()`) so both reducers and any future consumer share one definition. No new derivation. When a band tau exceeds `fe.saturation_tau` the accessor still returns it; the date reducer emits `null` for that band per the field contract.
- **Resolved-source provenance.** Confirm `runtime.runtime_provenance.p_conditioning_evidence.source` is populated at runtime construction time and accessible without traversing diagnostic blobs. The `promoted_source` field on the daily-conversions response reads from this. No alternative source.

Phase 2 is complete when:
- the cohort_maturity outside-in tests still pass unchanged through the refactored projection helper;
- the new substrate accessors are individually exercised by direct unit tests against synthetic substrates;
- no daily-conversions wiring exists yet.

### Phase 3 — Date reducer

Add a sibling of the existing tau-axis row builder, in the same module, implementing the field contract above. The date reducer takes the same substrate inputs as the tau reducer (runtime, frame evidence, selected A-clock evidence, per-Cohort eval ages and weights, max_tau, tau_solid_max, sweep_to, band_level, cohort_list) plus the per-Cohort draws, per-Cohort subject-only completeness, saturation_tau, and latency-band tau set exposed in phase 2.

For each Cohort the reducer emits one `rate_by_cohort` row whose fields are populated from the contract. The contract names which substrate accessor and which tau index each field reads — the reducer is mechanical relative to that contract. In particular: `projected_y` and `forecast_bands` slice per-Cohort draws at `fe.saturation_tau`; `completeness` reads the per-Cohort variant of the existing `_runtime_completeness` object at `eval_age`; `layer` reuses the constants and rule already defined in `forecast_application.annotate_data_point`; `latency_bands` per band tau use the evidence-vs-forecast split based on `eval_age[i] ≥ band_tau`. Cohort_maturity rows do not carry `layer` or `completeness` fields today; this work does not change that.

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

### Phase 5 — Other CF-machinery consumers: migrate or verify

Phase 5 brings the remaining four chart analysis types — `surprise_gauge`, `conversion_rate`, `conversion_funnel`, `bridge_view` — into a single coherent state with respect to the unified CF runtime. The work splits into actual migrations (where a legacy call still exists) and verifications (where the analysis already rides on the unified runtime, directly or indirectly, and only needs regression coverage after the substrate refactor in phases 2–3).

The state today, audited by static reads of the relevant modules:

- `surprise_gauge` ([api_handlers.py:130+](graph-editor/lib/api_handlers.py#L130)) calls `compute_forecast_trajectory` directly. After phase 4 it is the **only** remaining public-path consumer of the legacy trajectory engine. Its own docstring records this and names migration as the precondition for deleting the engine.
- `conversion_funnel` ([runners.py:1519](graph-editor/lib/runner/runners.py#L1519)) consumes the response of `_whole_graph_cf` (`handle_conditioned_forecast` mode b), which already routes through `compute_cohort_maturity_rows_v3` and therefore through `ResolvedCFRuntime`. It is already on the unified runtime.
- `bridge_view` ([runners.py:365](graph-editor/lib/runner/runners.py#L365)) does not call backend CF directly. Its Reach-decomposition arithmetic reads edge probabilities from the FE-supplied scenario graph, which the FE may itself have populated from a CF call depending on `visibility_mode`. Backend CF is reachable from this runner today only by a separate `_whole_graph_cf` call — none is currently made.
- `conversion_rate` ([conversion_rate_derivation.py](graph-editor/lib/runner/conversion_rate_derivation.py)) is observed-only with epistemic bands resolved from `epistemic_bands.resolve_rate_bands`. It does not call backend CF and does not handle latency edges (gated out per doc 49 §B.2).

Phase 5 therefore comprises:

#### Phase 5a — `surprise_gauge` migration off the legacy trajectory engine

Replace the `compute_forecast_trajectory` call in `surprise_gauge` with reads from `ResolvedCFRuntime`. The two scalar variables the gauge computes (`p` and `completeness`, both projected as z-scores from unconditioned vs conditioned means) are sourced from runtime-owned objects:

- The **conditioned** posterior moments come from `runtime.public_moments` and the per-Cohort completeness exposed for daily-conversions in phase 2.
- The **unconditioned** moments come from the unconditioned `predictive` overlay already exposed at `runtime.unconditioned_overlays['predictive']` (see `ResolvedCFRuntime.unconditioned_overlays` in [cohort_forecast_v3.py:907](graph-editor/lib/runner/cohort_forecast_v3.py#L907)). This is the same overlay the cohort_maturity tau reducer uses for `model_*` fan bands; reusing it for surprise_gauge does not introduce a new unconditioned object.

The gauge is a scalar projection, not a row reducer, so this migration adds no new reducer to the substrate. It removes one consumer of `compute_forecast_trajectory`. After phase 5a, combined with phase 4, the only remaining callers of `compute_forecast_trajectory` are non-public test paths and `surprise_gauge`'s deleted block. Phase 5a explicitly authorises deleting `compute_forecast_trajectory` and `forecast_state.CohortEvidence` once a final static search confirms zero public callers and the test paths have been migrated to substrate fixtures.

The variable definitions for `surprise_gauge` (`p`, `completeness`, the z-score formula, the zone classification thresholds in `classify_zone`) are the existing definitions in `api_handlers.py` and are not redefined by this work. Phase 5a is a substitution of the data source, not a redesign of the gauge.

Phase 5a tests assert that the gauge's two variables, the cf_mode/cf_reason emission, and the unavailable-with-reason error path are unchanged in shape and behaviour against the same synthetic graphs the daily-conversions phase 1 suite uses. The numerical z-score values may shift relative to the legacy trajectory output by the same magnitude phase 4 shifts daily-conversions projection values; the assertions are about contract preservation, not parity.

#### Phase 5b — `conversion_funnel` regression verification

`conversion_funnel` is already on the unified runtime by virtue of `_whole_graph_cf` → `handle_conditioned_forecast` → `compute_cohort_maturity_rows_v3`. Phases 2 and 3 refactor that path internally (extracting the substrate-builder, exposing per-Cohort views, aligning projection horizon to `fe.saturation_tau`); none of those changes alter the per-edge response shape that `conversion_funnel` consumes (`p_mean`, `p_sd`, `evidence_k`, `evidence_n`, `completeness`, `conditioned`). Phase 5b adds outside-in CLI tests that exercise `conversion_funnel` end-to-end against synthetic graphs spanning window mode, cohort(A=X), and active cohort mode, asserting that the per-stage `bar`, `lo`, `hi`, `bar_e`, `bar_f_residual`, `lo_epi`/`hi_epi`/`lo_pred`/`hi_pred` fields are produced and that the e/f/e+f mode selection still routes correctly. These tests are written and run during phase 5b, not before, because they cover the post-refactor substrate, not the legacy trajectory engine.

No code changes to `conversion_funnel` or `funnel_engine` are expected in phase 5b. If a regression appears, it is fixed at the substrate level (since the funnel's contract with `_whole_graph_cf` has not changed); the funnel runner remains untouched.

#### Phase 5c — `bridge_view` decision and (optional) migration

Bridge view is currently CF-aware only indirectly through whatever the FE has populated on the scenario graph. Two options exist for "wiring it onto the CF machinery":

- **Status quo**: continue reading edge probabilities from the FE-supplied scenario graph. The FE already invokes CF when `visibility_mode` requires it; bridge_view consumes the result transparently. No backend CF call from this runner.
- **Direct CF**: call `_whole_graph_cf` per scenario inside `run_bridge_view`, exactly as `run_conversion_funnel` does, and read per-edge `p_mean` from the response. This guarantees Reach decomposition uses the same conditioned per-edge probabilities the funnel sees, regardless of what the FE-supplied scenario graph carries.

The two options have different acceptance criteria: status quo only needs the regression coverage already implied by phase 5b's tests for downstream consumers of scenario-graph p; direct CF needs a new backend CF integration in this runner with its own outside-in tests.

This plan does **not** silently choose one. Phase 5c begins with a documented decision in this plan, taken at the time the phase starts. Until that decision is recorded, the migration work cannot start. The decision must answer: (1) is the FE's CF-populated scenario graph reliably consistent with the backend `_whole_graph_cf` response under all visibility modes, and (2) if not, is the consistency gap material for Reach decomposition? If (1) holds and (2) is no, status quo is correct and phase 5c is closed without code changes. If either fails, direct CF is the correct migration and phase 5c includes the runner change plus its tests.

#### Phase 5d — `conversion_rate` decision and (optional) extension

Conversion rate is observed-only with epistemic bands; it does not consume CF and explicitly excludes latency edges (doc 49 §B.2). Wiring it onto the CF machinery is a feature extension, not a cutover: it would add forecast-mode bands for immature bins (parity with daily-conversions's `forecast_bands`) and lift the latency-edge exclusion via the same conditioned per-Cohort projections daily-conversions uses, reduced over a calendar-bin axis (day, week, month) instead of a per-Cohort axis.

The substrate already supports the necessary draws after phases 2–3. A bin reducer would be a third sibling of the tau reducer (cohort_maturity) and date reducer (daily_conversions), summing per-Cohort per-tau projections onto calendar-bin-keyed buckets via the `calendar_date = anchor_day + tau` mapping the conceptual model already names. This is the diagonal-collapse reducer 73q's main body deliberately ruled out as "no consumer"; conversion_rate would be that consumer.

This plan does **not** silently scope conversion_rate's CF extension into 73q. Phase 5d begins with a documented decision in this plan recording one of:

- **Out of scope**: leave conversion_rate observed-only, accept the latency-edge gap, treat any forecast-mode upgrade as a separate atom (probably as part of doc 49 Phase 3, which is already named in the conversion_rate module docstring as the home for that work). 73q closes without changing conversion_rate.
- **In scope**: design the bin reducer and its field contract here, run it through phase 1-style blind tests over the outside-in suite, and ship the wiring. The cost is a third reducer plus the contract specifying which substrate accessors a bin reducer reads (largely the same as the date reducer, with `eval_age` replaced by per-bin saturation slices, and observed-side accumulated across the bin's calendar dates).

Until the decision is recorded, the work cannot start. The default if the decision is deferred is **out of scope** — the conversion_rate module continues to function exactly as it does today.

### Phase 5 acceptance

Phase 5 is complete when:

- `surprise_gauge` emits its two variables from runtime-owned objects (no `compute_forecast_trajectory` call remains in `api_handlers.py` outside of explicitly retained test paths) and its outside-in tests pass;
- `conversion_funnel` outside-in tests pass against the post-refactor substrate (no funnel code changes unless a regression is found);
- `bridge_view` decision is recorded in this plan; if direct-CF was chosen, the migration is shipped with tests;
- `conversion_rate` decision is recorded in this plan; if in-scope was chosen, the bin reducer is shipped with phase-1-style blind tests; otherwise the deferral note is recorded with a pointer to doc 49 Phase 3 as the next home;
- `compute_forecast_trajectory` and `forecast_state.CohortEvidence` are deletable (no public callers); deletion either happens here as a final cleanup or is recorded as the next atom with a static-search invariant blocking re-introduction.

## Invariants

The plan as a whole must preserve these controls:

- **Selected-set conditioning.** The posterior is conditioned on the full selected set of Cohorts scoped by the `window()` or `cohort()` query, exactly as the current shared CF runtime does.
- **No 73p semantics.** No hierarchical per-Cohort posterior, no hyperprior fitting, no partial pooling, no new per-Cohort posterior schema.
- **No duplicate forecast engine.** After phase 4, daily conversions does not call `compute_forecast_trajectory`. After phase 5a, neither does `surprise_gauge`. After both, the legacy trajectory engine has no public-path callers and is deletable.
- **No projection-time conditioning.** The date reducer does not bind evidence, condition primitives, apply doc-52, choose priors, or rebuild carrier or subject spans.
- **`Y / X` invariant.** Rates are always subject-end `Y` over denominator-at-`X`; Cohort mode never becomes `Y / A`.
- **Carrier ownership.** In active Cohort mode, denominator arrival is owned by the runtime carrier object. Daily conversions does not recompute or bypass `A → X`.
- **Subject ownership.** Numerator progression is owned by the runtime subject span. Daily conversions does not silently use a terminal edge when the request subject is multi-hop.
- **Observed evidence preserved.** `derive_daily_conversions` remains the source for observed daily deltas and observed `y_at_age`; the runtime projection does not rewrite observed history.
- **No legacy fallback.** The daily-conversions `annotate_rows` fallback is removed in phase 4. If the runtime cannot project, the response emits unavailable / degraded projection fields with provenance rather than silently switching machinery.
- **Two reducers, one substrate.** The substrate is a single shared function called by both the tau reducer (cohort_maturity) and the date reducer (daily_conversions). No new subject-resolution path, no new evidence-binding path, no second runtime construction.
- **Field contract is binding.** The "Reducer field contract" section is the source of truth for every field of the daily-conversions response. The date reducer implements that contract; phase 1 tests assert it; phase 4 cannot relax it without a corresponding plan revision.
- **Projections do not own runtime semantics.** Per `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` §9, the date reducer does not introduce its own `completeness`, saturation horizon, layer rule, or any other semantic decision. Every value the reducer reads is sourced from an existing substrate accessor or runtime-owned object; every constant is imported from an existing module. Daily_conversions emits some fields (`layer`, `completeness`) that cohort_maturity does not, but the underlying definitions are shared.
- **Terminology discipline.** Use **Cohort**, **`cohort()`**, **Cohort mode**, and **Window mode** consistently.

## Non-goals

- No 73p hierarchical per-Cohort conditioning.
- No per-Cohort posterior schema.
- No new frontend chart type requirement.
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
- after phase 5a, a static search shows no `surprise_gauge` `compute_forecast_trajectory` call;
- after phase 5b, `conversion_funnel` outside-in tests pass against the post-refactor substrate;
- phase 5c and 5d decisions are recorded in this plan; any in-scope migration is shipped with its tests, any deferral has a documented next home;
- if all phase 5 migrations are shipped, `compute_forecast_trajectory` and `forecast_state.CohortEvidence` are deleted from the codebase or have their deletion recorded as the next atom with a static-search invariant against re-introduction.
