# Cohort Maturity `p_infinity` Row Removal Plan

**Date**: 29-May-26  
**Status**: Planned contract cleanup  
**Scope**: `cohort_maturity` row payloads, scalar reducer ownership, and test migration

## Decision

`cohort_maturity` rows should stop emitting `p_infinity_mean`, `p_infinity_sd`, and `p_infinity_sd_epistemic`.

Those fields are scalar outputs, not chart-row outputs. They are now owned by the scalar reducer over the shared CF projection bundle. Keeping them on every `cohort_maturity` row creates a misleading affordance: tests and callers can accidentally read a scalar-like value from a chart bundle whose `compute_extent` was chosen for chart rendering, not scalar saturation.

The scalar outputs remain available through the scalar path:

- `reduce_cf_scalars(...).fc_terminal_rate_mean`
- `reduce_cf_scalars(...).fc_terminal_rate_sd_predictive`
- `conditioned_forecast.p_mean`
- `conditioned_forecast.p_sd`
- `param-pack p.mean`

`completeness@frontier` follows the same ownership rule: it belongs to the scalar reducer / scalar public surfaces, not to `cohort_maturity` rows.

## Root Cause This Avoids

The failing outside-in case exposed a row/scalar horizon coupling:

- A test explicitly set `tau_extent = 30` to force chart rows through a specific visible τ band.
- That manual setting became the handler's `compute_extent`.
- The CF bundle projected the selected-Cohort FC surface only to `min(compute_extent, saturation_tau)`.
- The row-level `p_infinity_mean` was read from the right edge of that row projection.
- For a far-anchor cohort where saturation is beyond τ 30, the row-level value was not saturated.

The scalar path did not have the same problem when invoked through `param-pack`: it returned the saturated selected-Cohort scalar for the same DSL. The problem was not stale fixture data. It was that `cohort_maturity` carried a scalar affordance on a chart surface.

## Contract After Removal

`cohort_maturity` rows are chart rows. They may expose:

- strict evidence fields: `rate`, `rate_pure`, `evidence_x`, `evidence_y`
- FC forecast-layer fields: `midpoint`, `fan_*`, `fan_bands`, `projected_rate`, `forecast_x`, `forecast_y`
- conditioned model fields: `model_midpoint`, `model_fan_*`, `model_bands`
- optional model overlay fields: `model_curve_midpoint`, `model_curve_fan_*`, `model_curve_bands`
- display/support metadata: `coverage`, `cohorts_covered_*`, `tau_*`, provenance sentinels

They should not expose scalar saturation/frontier outputs.

Scalar clients must use the scalar reducer. The scalar reducer must own its own calculation horizon and must not inherit a chart `tau_extent` as an output-defining parameter. Its job is to sweep far enough to read:

- `p@∞` from the FC selected-Cohort surface at saturation
- completeness from the selected Cohort's frontier-to-terminal relationship
- strict empirical terminal evidence totals where needed for scalar display

## Test Migration Rule

Every assertion nullified by removing row `p_infinity_*` must be accounted for. Deletion requires explicit user sign-off.

Default migration rules:

- If the assertion was about scalar `p@∞`, migrate it to `reduce_cf_scalars`, `conditioned_forecast.p_mean`, or `param-pack p.mean`.
- If the assertion was about chart behaviour, migrate it to row fields such as `midpoint`, `model_midpoint`, `rate`, `evidence_*`, or `model_curve_*`.
- If the assertion mixed chart and scalar claims, split it into one scalar assertion and one chart assertion.
- Do not use `midpoint` as an implicit fallback for missing row `p_infinity_mean`.
- Do not allow `.get()` returning `None` on both sides to become a passing assertion.
- Do not widen `cohort_maturity` chart compute solely to satisfy a scalar assertion.

Extending `tau_extent` remains valid for chart-row parity when the claim is about a visible row, seam, or τ range. It is not the right repair for scalar parity.

## Test-By-Test Migration Plan

### `test_cohort_factorised_outside_in.py`

`_assert_public_scalar_parity`  
Remove the `cm_last["p_infinity_mean"]` comparison. Preserve scalar parity by comparing `param-pack p.mean` with `conditioned_forecast.p_mean`. Add an explicit absence check for row `p_infinity_*`.

`test_cli_window_single_edge_scalar_identity_across_public_surfaces`  
Uses `_assert_public_scalar_parity`; migrate through the helper. The scalar public-surface parity claim remains.

`test_cli_identity_collapse_matches_window_across_public_surfaces`  
Remove the explicit `cohort_maturity p_infinity_mean` comparison. Preserve the scalar collapse claim through `param-pack p.mean` and `conditioned_forecast.p_mean`. Keep row identity-collapse assertions separate.

`test_cli_single_hop_downstream_cohort_parity_and_admitted_provenance`  
Currently xfail, but still migrate the helper use so the stale row scalar does not survive inside an xfail. Keep provenance assertions unchanged.

`test_a_equals_x_identity_collapses_to_window`  
Keep row `model_midpoint` and evidence collapse assertions. Replace row `p_infinity_mean` window/cohort comparison with scalar `p.mean` comparison.

`test_single_hop_non_latent_upstream_collapses_to_window`  
Two parametrised cases. Keep row `model_midpoint` equality. Replace row `p_infinity_mean` equality with scalar `p.mean` equality for each subject DSL.

`test_single_hop_latent_upstream_lags_window_but_converges_to_same_subject_p`  
Keep lag/shape assertions on row curves. Replace the row `p_infinity_mean` comparison for the `window(-1d:)` / `cohort(-1d:)` pair with scalar `p.mean`.

`test_anchor_depth_monotonicity_for_same_subject`  
Keep row `evidence_x` and `model_midpoint` monotonicity under explicit `tau_extent=30`. Replace the four row `p_infinity_mean` values with scalar `p.mean` values computed without chart `tau_extent`. This is the direct repair for the observed failure.

`test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`  
Do not compare optional unconditioned `model_curve_midpoint` to FC selected-Cohort `p@∞`. Preserve the claim by comparing `model_curve_midpoint` to the unconditioned subject-kernel oracle or the appropriate unconditioned scalar surface.

`test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window`  
Keep row equality assertions for `evidence_x`, `evidence_y`, `rate`, `midpoint`, and `model_midpoint`. Replace `p_infinity_mean` equality with scalar `p.mean` equality.

`test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point`  
Reframe as scalar-callsite protection: prove `param-pack p.mean` / `conditioned_forecast.p_mean` are not read from an arbitrary chart τ, and assert `cohort_maturity` rows do not carry `p_infinity_*`.

`test_cohort_and_window_p_infinity_converge_for_same_subject_rate`  
Three parametrised cases. Rename/reframe around scalar `p.mean` convergence. Compare scalar public outputs, not row fields.

`test_cohort_frame_evidence_does_not_retarget_carrier_or_subject`  
Keep row curve assertions. Replace the window/identity/admitted `p∞` spread check with scalar `p.mean` spread check.

`test_v3_midline_at_saturation_converges_to_p`  
Keep the chart midpoint-at-saturation assertion. Source the scalar comparator from `reduce_cf_scalars` or `param-pack p.mean`, not from a row.

`test_d1_parity_analytic_vs_bayes_mature_window`  
Replace analytic-vs-bayes row `p_infinity_mean` parity with analytic-vs-bayes scalar `p.mean` parity. Keep midpoint curve parity unchanged.

`test_d2_parity_analytic_vs_bayes_identity_collapse_cohort`  
Replace row `p_infinity_mean` parity with scalar `p.mean` parity.

`test_d3_parity_analytic_vs_bayes_zero_evidence_returns_prior`  
Replace row `p_infinity_mean` parity with scalar `p.mean` parity.

### `test_cf_query_scoped_degradation.py`

`test_latency_rows_use_shared_sweep_contract`  
Replace row `p_infinity_mean` / `p_infinity_sd` assertions with direct scalar reducer assertions over the same constructed fixture. Add an assertion that rows do not expose `p_infinity_*`.

`test_cohort_maturity_rows_v3_identity_drift`  
Remove `p_infinity_mean` from row-field drift comparison. Add a scalar drift comparison across the same id/uuid variants using `reduce_cf_scalars`, so identity drift remains covered and missing fields cannot pass silently.

### `test_doc56_phase0_behaviours.py`

`test_cf_p_mean_matches_v3_p_infinity`  
Do not delete without sign-off. Migrate from "CF p_mean vs v3 p_infinity" to a scalar-public-output parity claim across the same matrix, likely `conditioned_forecast.p_mean` vs `param-pack p.mean` or direct scalar reducer output.

`test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split`  
Currently xfail/stale. Keep chart split assertions on evidence and model rows. The row `p_infinity_mean` asymptote assertion needs an explicit redesign: migrate to current scalar semantics, invert if the current substrate contract expects equality, or ask for sign-off before deletion.

### Other Fallback/Weak Tests

`test_conditioned_forecast_response_contract.py`  
Replace `cm_last.get("p_infinity_mean")` / `midpoint` fallback with scalar output. Keep cohort-maturity rows out of scalar parity.

`test_conditioned_forecast_parity.py`  
Rewrite `_v3_reference` so it no longer falls back from missing row scalar to `midpoint`. Use a scalar output as the reference for whole-graph CF.

`test_cohort_maturity_model_parity.py`  
Replace `forecast_mean = row["p_infinity_mean"]` with the correct unconditioned model scalar or oracle. This test is about the optional model overlay, not FC selected-Cohort `p@∞`.

## Execution Order

1. Add scalar helper functions in the affected tests.
2. Migrate assertions while `cohort_maturity` still emits `p_infinity_*`, so behaviour changes are isolated.
3. Remove row `p_infinity_*` emission from `cohort_maturity`.
4. Add absence assertions where the row contract matters.
5. Run only impacted tests.
6. Update codebase docs that currently list `p_infinity_*` as row fields.

## Non-Goals

- Do not increase `cohort_maturity` compute solely to satisfy scalar tests.
- Do not preserve row `p_infinity_*` as a backwards-compatibility shim.
- Do not silently weaken protected outside-in assertions.
- Do not delete tests or assertions without explicit user sign-off.
