# Bucket Transition Algebra Implementation Plan

**Date:** 21-May-26  
**Status:** implementation plan  
**Scope:** replace mixed midpoint / endpoint placement conventions in the current conditioned-forecast output path with one shared bucket-to-bucket transition algebra.

## 1. Objective

Standardise every current output-path consumer on one bucket transition convention:

- source bucket to output bucket transition mass is the shared runtime object;
- public rows remain endpoint-labelled cumulative rows;
- Dirac, non-latent, identity-carrier, single-hop, multi-hop, `window()`, `cohort(A = X)`, and active `cohort(A != X)` cases enter as degenerate data, not as separate central branches;
- no local midpoint correction survives in a readout or projection layer.

This plan supersedes any attempt to fix a single midpoint seam in isolation. A partial conversion is not a valid runtime state.

## 2. Hard Rules

1. Do not edit production runtime code before the concrete bucket-algebra tests exist and fail against the current runtime.
2. Do not make a local midpoint correction at any readout surface.
3. Do not weaken the outside-in active cohort evidence oracles to match current factorised helper output.
4. Do not add mode branches to make `window()`, `cohort()`, identity carrier, or multi-hop pass separately.
5. Do not claim completion until the reversion audit proves every converted site is covered by at least one failing test when reverted.

## 3. Target API

Add one small helper module: `graph-editor/lib/runner/bucket_transition.py`.

It owns the canonical transition value shape already used by `span_readout.SpanOperator`: a two-dimensional value matrix where row `s` is the source bucket and column `l` is the non-negative lag to output bucket `s + l`. Shift-invariant operators use one row. Source-day-specific operators use one row per source bucket.

The module must expose only these concepts:

- `BucketTransition`: immutable name, value matrix, and family label;
- endpoint CDF to transition value conversion;
- cumulative empirical rate to transition value conversion;
- Dirac transition construction for non-latent and deterministic timing;
- transition-to-`SpanOperator` adapter.

All consumers must enter bucket placement through this module or through `span_readout.evaluate_span_readout`, which consumes the same canonical value shape. The helper must not know about query mode, carrier identity, chart fields, evidence family, or scenario state.

## 4. Site Matrix

This is the required conversion inventory. Do not expand it unless implementation proves a site is a current output-path consumer.

| Site | Current convention | Required action | Protecting test |
|---|---|---|---|
| `timing_particles.build_per_draw_edge_cdf` | Row-aligned helper may be consumed as production CDF | Make endpoint and row-aligned surfaces explicit; production transition conversion must choose one convention through `bucket_transition` | `test_timing_particles_emit_endpoint_cdf_not_row_average` |
| `primitive_conditioning._evaluate_likelihood_plan` | Endpoint likelihood is intended; row-aligned helper is adjacent and easy to misuse | Keep likelihood/readout convention explicit; do not let row-aligned CDF leak into `TimingPosterior` | `test_d1_parity_analytic_vs_bayes_mature_window` |
| `subject_span_composer._conditioned_kernel_maps` | Native and propagated kernels diverge via source-index midpoint shift | Build both model kernels through `bucket_transition`; remove hidden half-bucket placement | `test_window_model_surface_does_not_shift_by_source_index` |
| `span_operator_supply.draw_model_primitive_operators` | Converts primitive CDFs to `SpanOperator` values locally | Convert through `bucket_transition` so model overlays share the same value shape | `test_model_kernel_uses_same_readout_shape_as_evidence_kernel` |
| `prefix_arrival.build_prefix_arrival_map` | Calendar weights are integer-day keyed but per-edge CDF conversion is local | Build arrival PMFs from `bucket_transition`; bump prefix-arrival cache identity if support semantics change | `test_phase6_inv7_arrival_map_equals_propagation_density_per_draw` |
| `empirical_evidence_operator._build_empirical_delta_kernel_draws` | Empirical cumulative rates become increments locally | Convert cumulative empirical rates through `bucket_transition` | `test_empirical_cancellation_identity_when_source_mass_equals_empirical_n` |
| `empirical_evidence_operator._build_empirical_flat_kernel_provider` | Lookup-bound empirical kernels use local diff/read logic | Supply source-bucket kernels through `bucket_transition`; no hidden source-index shift | `test_active_single_hop_chart_evidence_matches_bucket_K_compose` |
| `empirical_evidence_operator._bound_age_cumulative_rate` | Integer reads are canonical but fractional reads can enter implicitly | Keep integer endpoint reads unless `EvidenceReadoutBinding` explicitly supplies a fractional age | `test_multihop_chart_matches_bucket_K_under_non_uniform_empirical_rate` |
| `cohort_forecast_v3._build_evidence_local_rate_attributed_subject_prefix` | Identity-ledger path composes integer endpoint kernels locally | Route identity-ledger composition through the same transition value shape | `test_identity_carrier_cohort_equivalent_to_window_on_same_observations` |
| `cohort_forecast_v3._build_rate_attributed_subject_prefix` | Active path applies first-subject-layer `tau - 0.5` midpoint correction | Remove local midpoint correction; provenance must report the shared convention | `test_rate_attributed_prefix_reads_endpoint_tau_without_midpoint_offset` |
| `cohort_forecast_v3.SelectedAClockEvidence.aggregate_by_tau` | Public evidence rows are endpoint cumulative with forward-fill | Keep endpoint row labelling; verify it reads converted prefix surfaces only | `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` |
| `model_span_spine.project_selected_cohort_rows` | Public row evidence and model projections are cumulated in the spine | Ensure `evidence_x`, `evidence_y`, `rate`, `midpoint`, and `forecast_x/y` are all projections of converted transition surfaces | `test_multihop_chart_matches_bucket_K_under_chain_depth_three` |
| `span_readout.evaluate_span_readout` | Already owns canonical operator-chain readout | Do not change unless the helper proves the existing value shape is insufficient | Existing `test_span_readout.py` |

## 5. Execution Sequence

### Step 1: Turn `test_bucket_transition_algebra.py` Into Real Red Tests

Replace the placeholder strict xfails with executable tests before changing production code.

For each test:

- derive expected values from the bucket transition algebra, not from current runtime output;
- assert public or row-spine output fields, not private intermediate dataclasses whose downstream forward-fill can mask a bug;
- prove the test is red against the current mixed-convention runtime;
- remove the placeholder xfail only when the test body is real.

Implement at least these test families:

- active single-hop selected evidence with a non-Dirac carrier;
- multi-hop selected evidence with a non-Dirac carrier;
- multi-hop selected evidence with non-uniform empirical rates;
- chain depth of at least three subject edges;
- identity-carrier equivalence between `window()` and `cohort(A = X)`;
- model-side window semantics proving no source-index midpoint shift;
- empirical cancellation where source mass equals empirical `n`.

Record, in the test comments, which inventory sites each test is intended to protect.

### Step 2: Define the Shared Bucket Transition Operator Contract

Create one runtime helper contract for bucket transition mass.

The contract must state:

- a source bucket and an output bucket are integer day buckets;
- public cumulative rows are endpoint-labelled;
- a transition object answers “given mass in source bucket `s`, what fraction reaches the destination in output bucket `t`”;
- cumulative-to-density conversion and density-to-cumulative projection are inverse conventions under this contract;
- Dirac and non-latent timings are exact degenerate transitions, not midpoint-smoothed transitions.

Place the helper where both model and empirical runtime surfaces can import it without creating a dependency cycle. Keep it pure and small. Do not let it know about query mode, carrier identity, chart rows, or evidence families.

### Step 3: Convert Model-Side Placement to the Shared Contract

Convert every model-side placement site to consume the shared bucket operator.

Update these surfaces as one coordinated production change:

- `timing_particles.py`: make per-draw timing particles expose the chosen bucket CDF convention and keep row-aligned or endpoint variants explicit rather than implicit.
- `subject_span_composer.py`: remove the separate native-versus-propagated half-bucket model kernel convention; build model kernels from the shared bucket transition contract.
- `span_operator_supply.py`: convert primitive draw surfaces to `SpanOperator` values through the same transition convention.
- `prefix_arrival.py`: build prefix arrival weights from the same per-edge transition mass used by model composition.
- `model_span_spine.py`: ensure model rate draws, request CDF draws, and selected-cohort model projections consume the converted operator surfaces rather than reinterpreting placement locally.

After this step, no model-side site should decide placement by checking source index and applying a half-day shift.

### Step 4: Convert Empirical-Side Placement to the Same Contract

Convert empirical evidence composition to the shared bucket transition contract.

Update these surfaces as one coordinated production change:

- `empirical_evidence_operator.py` `_build_empirical_delta_kernel_draws`;
- `empirical_evidence_operator.py` `_cumulative_kernels_by_source_day`;
- `empirical_evidence_operator.py` `_build_empirical_flat_kernel_provider`;
- `empirical_evidence_operator.py` `_run_empirical_lookup_bound_trace`;
- `empirical_evidence_operator.py` `_bound_age_cumulative_rate`;
- `empirical_evidence_operator.py` cumulative-to-density conversion and terminal cumulative projection.

The empirical path must not add a hidden source-index shift after `EvidenceReadoutBinding` has selected source day and age. If fractional reads are needed, make the binding supply the fractional age explicitly and test that convention.

### Step 5: Remove Row-Layer Midpoint Correction

Remove the row-layer midpoint hack from `cohort_forecast_v3._build_rate_attributed_subject_prefix`.

Do all of the following:

- remove first-subject-layer `tau - 0.5` rate lookup;
- update `rate_tau_offset` provenance so it no longer advertises a midpoint correction;
- keep diagnostic dual-evaluation only if it is clearly labelled as diagnostic and not part of production semantics;
- ensure selected A-clock placement reads converted empirical/model surfaces instead of applying a late correction;
- ensure identity-ledger and active paths do not preserve separate placement conventions.

This step is not complete if row evidence improves by shifting only `evidence_y` while carrier mass, denominator, support, or model surfaces remain on another convention.

### Step 6: Align Public Row Projection

Align `cohort_forecast_v3._project_runtime_rows` and `model_span_spine.project_selected_cohort_rows` so all public fields are projections of the same bucket convention.

Check every row field:

- `evidence_x`;
- `evidence_y`;
- `rate`;
- `rate_pure`;
- `midpoint`;
- `model_midpoint`;
- `model_curve_midpoint`;
- `forecast_x`;
- `forecast_y`;
- fan and band fields.

For each field, identify the upstream converted surface it reads. If a field still synthesises carrier, subject, maturity, or placement semantics in the projection layer, move that information into the runtime object instead.

### Step 7: Run the Focused Test Suite

Run the new bucket transition suite first.

Then run focused CF runtime tests that cover the changed seams:

- `test_primitive_conditioning.py`;
- `test_empirical_evidence_operator.py`;
- `test_subject_span_composer.py`;
- `test_span_operator_supply.py`;
- `test_span_readout.py`;
- `test_model_span_spine_selected_cohort.py`;
- `test_evidence_clocking_spine_toy.py`.

Do not interpret a green partial subset as completion. The focused suite only proves local algebra.

### Step 8: Run the Outside-In Canaries

Run the outside-in canaries from `test_cohort_factorised_outside_in.py` after the bucket suite is green:

- `test_active_single_hop_evidence_matches_selected_a_clock_snapshot_oracle`;
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`;
- `test_window_multihop_ef_boundary_matches_rate_attributed_selected_evidence`;
- `test_d1_parity_analytic_vs_bayes_mature_window`.

Treat failures here as evidence that the global conversion is incomplete or that a test expectation now needs explicit review. Do not silently weaken these tests.

### Step 9: Perform the Mechanical Reversion Audit

For every converted inventory site, revert that site alone to its pre-change convention and rerun the bucket transition suite.

Require at least one bucket test to fail for each individual reversion.

If a reverted site does not make a test fail:

- either remove that site from the required conversion inventory because it is not load-bearing;
- or add a missing bucket test that makes the site observable.

Do not ship until every converted site is protected by this audit.

### Step 10: Close With an Inventory Checklist

Before reporting completion, write a closure note in the implementation PR or stage note that lists:

- every converted file and symbol;
- the test that protects each symbol;
- the result of the focused bucket suite;
- the result of the outside-in canaries;
- the result of the reversion audit;
- any intentionally deferred site and why it is not part of the current output path.

## 6. Stop Conditions

Stop and re-plan if any of these occurs:

- a proposed test can pass after changing only one local midpoint seam;
- expected numeric values are copied from current runtime output;
- a production edit introduces a new mode branch near the centre of the engine;
- the implementation requires weakening outside-in evidence tests;
- a projection field needs to reconstruct semantics that the runtime does not expose;
- the reversion audit finds an unprotected conversion site.

## 7. Non-Scope

Do not change:

- snapshot DB row semantics;
- Bayes compiler model structure;
- FE chart rendering conventions except to consume already-published row fields;
- test oracles as the primary way to make current failures green;
- unrelated hold-out engines unless the reversion audit proves they are current output-path consumers for this fix.

