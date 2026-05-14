# Strict Span Regression Failures

**Status**: failure record  
**Date**: 13-May-26  
**Scope**: test failures observed after the attempted strict-span / selected-prefix changes in `cohort_forecast_v3`.

## Full Reported Release Failure

The user-reported release run failed with:

- `14 failed`
- `1508 passed`
- `38 skipped`
- `7 xfailed`
- `1 xpassed`
- runtime: `1393.52s` (`0:23:13`)

The release was aborted.

## Failing Tests

### `lib/tests/test_cf_query_scoped_degradation.py::test_shared_sweep_latency_rows_use_selected_evidence_coverage`

Observed failure:

- Expected selected evidence coverage around `2.0`.
- Actual value was `0.0`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`

Observed failure:

Active single-hop selected evidence no longer matched the raw selected A-clock snapshot oracle. The reported failing band included:

- `evidence_y` undercounting the oracle from `τ=10` onward.
- `rate` undercounting the oracle from `τ=12` onward.

Representative examples:

- `τ=10`: expected `evidence_y=242`, got `131.871628`.
- `τ=14`: expected `evidence_y=6225`, got `4770.258033`.
- `τ=16`: expected `evidence_y=15288`, got `12653.080045`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`

Observed failure:

Multi-hop active selected evidence no longer used the query-X selected denominator consistently. The reported failures were primarily `evidence_y` undercounts:

- `τ=18`: expected `84`, got `33.627240`.
- `τ=23`: expected `1304`, got `813.527335`.
- `τ=29`: expected `5095`, got `3863.824656`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_window_multihop_evidence_matches_rate_attributed_db_oracle`

Observed failure:

Multi-hop `window()` evidence no longer matched the rate-attributed DB oracle.

Representative failures:

- `τ=7`: expected `evidence_y=81906.788384`, got `0.0`.
- `τ=8`: expected `evidence_y=81906.788384`, got `75103.116951`.
- `τ=8`: expected `rate=0.072012`, got `0.066030`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_identity_cohort_multihop_matches_window_rate_attributed_oracle`

Observed failure:

`cohort(A=X)` no longer degenerated to the same rate-attributed evidence as `window()`.

Representative failures:

- `τ=7`: expected cohort rate `0.072012`, got `0.0`.
- `τ=7`: expected cohort `evidence_y=81906.788384`, got `0.0`.
- `τ=8`: expected cohort rate `0.072012`, got `0.066030`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence`

Observed failure:

At the E+F boundary, the multi-hop window seam was no longer pinned to rate-attributed selected evidence.

Reported values at `tau_solid_max=27`:

- `evidence_y`: expected `81906.788384`, got `75103.116951`.
- `rate`: expected `0.072012`, got `0.066030`.
- `midpoint`: expected `0.072012`, got `0.066030`.

### `lib/tests/test_cohort_factorised_outside_in.py::test_active_cohort_multihop_total_projection_matches_subject_projection_product`

Observed failure:

The test reported that the single-hop subject projection product drifted from truth:

- successive product: `0.283418`
- truth product: `0.325000`
- absolute gap: `0.041582`
- tolerance: `0.02`

### `lib/tests/test_cohort_factorised_outside_in.py::test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`

Observed failure:

The WP8-off single-hop anchor override no longer kept the same window subject-helper evidence family for p-conditioning.

Reported example:

- field: `evidence_k`
- window: `54694`
- admitted: `58525`
- delta: `3831`
- tolerance: `273.47`

### `lib/tests/test_doc56_phase0_behaviours.py::test_query_scoped_identity_carrier_collapses_public_evidence_basis`

Observed failure:

- Expected approximately `470.4460013880415`.
- Actual value was `343.52370171513036`.

### `lib/tests/test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_y_parity`

Observed failure:

`evidence_y` diverged at `80` tau values with gaps greater than `5%`.

### `lib/tests/test_selected_cohort_pop_d_distribution.py::test_runtime_built_selected_a_clock_evidence_feeds_existing_consumers`

Observed failure:

- Expected approximately `6.0`.
- Actual value was `0.0`.

### `lib/tests/test_selected_evidence_natural_degeneracy.py::test_unified_builder_identity_carrier_synthesises_carrier_surface_from_subject_primitive`

Observed failure:

- Expected approximately `20.0`.
- Actual value was `0.0`.

### `lib/tests/test_selected_evidence_natural_degeneracy.py::test_unified_builder_single_hop_subject_max_flow_equals_primitive_k`

Observed failure:

Single-hop subject max-flow over one edge `X -> Y` no longer equalled the primitive's rate-attributed `k` contribution.

### `lib/tests/test_selected_evidence_natural_degeneracy.py::test_shadow_parity_single_hop_window_aggregate_matches_legacy_engine_cohort`

Observed failure:

Example reported:

- `τ=3`: unified `sum_y=0.0`
- legacy `obs_y=20.0`

## Failure Clusters

### Cluster 1: Identity And Zero-Length Degeneracy

Affected tests include:

- `test_unified_builder_identity_carrier_synthesises_carrier_surface_from_subject_primitive`
- `test_identity_cohort_multihop_matches_window_rate_attributed_oracle`
- `test_query_scoped_identity_carrier_collapses_public_evidence_basis`

The failures show that `window()` and `cohort(A=X)` stopped degenerating to the same evidence object.

### Cluster 2: Selected Evidence Support/Coverage

Affected tests include:

- `test_shared_sweep_latency_rows_use_selected_evidence_coverage`
- `test_runtime_built_selected_a_clock_evidence_feeds_existing_consumers`

The failures show the support/coverage channel was zeroed or disconnected. This is separate from count amplitude and must be preserved through any strict span implementation.

### Cluster 3: Multi-Hop Rate-Attributed Evidence

Affected tests include:

- `test_window_multihop_evidence_matches_rate_attributed_db_oracle`
- `test_identity_cohort_multihop_matches_window_rate_attributed_oracle`
- `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence`
- `test_multihop_evidence_parity`

The failures show that multi-hop evidence readout and E+F seam behaviour were damaged. A fix for non-latent active collapse must not disturb these already-protected semantics.

### Cluster 4: Evidence Admission / Conditioning Boundary

Affected test:

- `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case`

The failure shows p-conditioning evidence parity changed. This is outside the row-display surface and indicates the attempted change crossed a boundary it should not have crossed.

### Cluster 5: Model Projection Consistency

Affected test:

- `test_active_cohort_multihop_total_projection_matches_subject_projection_product`

The failure suggests the attempted change may have affected model/projection surfaces or at least invalidated assumptions used by projection product checks.

## Documentation Cross-Reference

This failure record should be read alongside:

- `docs/current/project-generalise/strict-span-cutover-debranch-plan.md`
- `docs/current/cohort-active-path-observed-prefix-defect.md`
- `docs/current/codebase/CF_ROW_PIPELINE.md`
- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/codebase/KNOWN_ANTI_PATTERNS.md` AP58 and AP59
