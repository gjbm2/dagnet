# 29-May-26 Daily Conversions Completeness Handover

## Objective

Fix the remaining forecast-stack defect around `daily_conversions` completeness.

The intended app-level semantic is that completeness is the progress of the frontier-conditioned forecast answer at the observation frontier relative to the same answer at saturation. In symbols: FC rate at frontier over FC rate at saturation. `daily_conversions` should not use a separate timing-CDF proxy, and it should not prepare its forecast bundle with a different evidence frontier from the rest of CF.

The immediate problem is not "what was changed earlier"; the important broken state is that public `daily_conversions` and public CF scalar output can disagree on completeness for the same single-Cohort query.

## Current State

- IN PROGRESS: `reduce_daily_conversions_rows` was changed so row `completeness` is computed from per-Cohort `ef_rate_draws_by_cohort[frontier] / ef_rate_draws_by_cohort[saturation]`, not from `bundle.completeness_by_cohort`.
- BLOCKED / RED: the public daily-conversions completeness value still does not match the public scalar completeness for the same query. The mismatch appears to be caused by different preparation inputs, not by the date reducer formula alone.

Known concrete mismatch to reproduce:

- Query: `from(simple-a).to(simple-b).window(10-Jan-26:10-Jan-26).asat(20-Jan-26)`.
- Public `daily_conversions` row completeness observed after the date-reducer formula change: about `0.4640`.
- Public CF / `param-pack` scalar completeness for the same query: about `0.4974`.
- Earlier direct bundle probes showed daily and CF handlers preparing different evidence sets for the same public query.

## Key Decisions & Rationale

- **`cohort_maturity` rows should not expose scalar `p@∞`.**  
  The row horizon may be a chart/display horizon, including manual `tau_extent`, and can be intentionally narrower than saturation. Scalar saturation output belongs to scalar consumers. Manifested in `graph-editor/lib/runner/cohort_forecast_v3.py`.

- **For outside-in tests that need a tau-reducer replacement for old row `p_infinity_mean`, use the same row's `projected_rate`.**  
  `projected_rate` is the FC forecast-layer row mean surface. It is the narrow replacement for the removed row scalar where the old assertion was about the right-hand edge of the cohort-maturity output. Manifested in `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`.

- **The no-lag optional overlay test is not a `p@∞` test.**  
  It asserts that `model_curve_midpoint` is the optional unconditioned model overlay. The correct setup is a no-evidence/asat query where the optional overlay and FC surface naturally collapse. Manifested in `test_degenerate_identity_and_instant_carrier_oracles_reduce_to_subject_kernel`.

- **Daily-conversions completeness should be FC frontier over FC saturation, not a timing CDF proxy.**  
  `bundle.completeness_by_cohort` is not the app-level semantic for the date reducer completeness field. The reducer should read the per-Cohort FC surface. Manifested in `graph-editor/lib/runner/cohort_forecast_v3.py`, inside `reduce_daily_conversions_rows`.

- **The remaining mismatch is likely before the reducer: handler preparation inputs diverge.**  
  For the same public DSL, `daily_conversions` and `conditioned_forecast` were observed preparing different frame/evidence sets. The daily handler uses `path_analysis_type='daily_conversions'`, whose subject resolution read mode is `raw_snapshots`. The CF path uses the cohort-maturity style forecast preparation contract. This means the shared CF bundle machinery starts too late for daily conversions.

## Discoveries & Gotchas

- Do not call `projected_rate` a scalar. It is a row surface. It is only a valid replacement for old row `p_infinity_mean` when the assertion is explicitly about the right-hand row of the cohort-maturity output.
- Do not compare optional `model_curve_midpoint` to FC scalar output unless the query is set up so evidence is absent and the two surfaces naturally degenerate.
- `conditioned_forecast.p_sd_epistemic` is currently a proxy: the scalar reducer gets the epistemic SD from conditioned-span public moments, not from a true FC-terminal epistemic surface. This is accepted for now; tests should encode it honestly.
- The earlier `cf-fix-diamond-mixed` truth parity failure was not a stable FC undershoot. Regenerating the fixture with its original-style stochastic knobs restored the selected evidence rate near truth and the test passed.
- Do not infer correctness from one public CLI path. In the daily-completeness issue, public daily-conversions and public scalar/param-pack can disagree because their handler preparation paths use different subject contracts before reaching the shared bundle builder.

## Relevant Files

### Runtime

- `graph-editor/lib/runner/cohort_forecast_v3.py`  
  Owns `reduce_cohort_maturity_rows`, `reduce_daily_conversions_rows`, and `reduce_cf_scalars`. Current defect likely involves `reduce_daily_conversions_rows` and/or the bundle it receives.

- `graph-editor/lib/runner/cf_analysis.py`  
  Shared preparation-to-bundle boundary. Important because it should be the single forecast bundle path for cohort maturity, conditioned forecast, and daily conversions.

- `graph-editor/lib/runner/forecast_preparation.py`  
  Builds `ForecastPreparation` and fetches/composes frames. Critical for tracing why daily-conversions and CF prepare different row counts.

- `graph-editor/lib/analysis_subject_resolution.py`  
  Maps analysis type to read mode. Current suspected cause: `daily_conversions` resolves as `raw_snapshots`, while forecast enrichment needs cohort-maturity style sweep/asat bounds.

- `graph-editor/lib/api_handlers.py`  
  Contains `_handle_daily_conversions` and `_handle_conditioned_forecast_impl`. The daily handler currently uses one subject resolution for both observed rows and forecast enrichment.

### Tests

- `graph-editor/lib/tests/test_cohort_factorised_outside_in.py`  
  Canonical outside-in oracle. The row `p_infinity` fallout has targeted passing coverage, but do not assume the whole file has been rerun after every latest change.

- `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`  
  Contains the scalar proxy SD contract test. Its targeted test passed after update.

- `graph-editor/lib/tests/test_cf_truth_parity.py`  
  Contains the `cf-fix-diamond-mixed` truth-parity case. Its targeted case passed after fixture regeneration.

- `graph-editor/lib/tests/test_cf_date_reducer.py`  
  Focused date reducer unit tests. Update these to pin FC frontier/saturation ratio semantics for `completeness`.

- `graph-editor/lib/tests/test_conditioned_forecast_parity.py`  
  Contains the failing daily-conversions completeness test. It currently still needs a correct replacement that compares daily output with the right shared prepared bundle / scalar datum.

### Docs

- `docs/current/codebase/CF_ROW_PIPELINE.md`
- `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`
- `docs/current/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md`
- `docs/current/project-generalise/frontier-conditioned-chart-surface-proposal-21-May-26.md`

These define the row surfaces, FC surface, scalar ownership, and daily-conversions reducer intent.

## Next Steps

1. Reproduce the current daily-completeness mismatch with one focused command:
   run `test_conditioned_forecast_parity.py::TestPhase4AsatVisibility::test_daily_conversions_completeness_matches_*` after checking the current test name in the file.

2. Trace the two public handler preparation paths in-process:
   - `_handle_daily_conversions`
   - `handle_conditioned_forecast`
   using the same graph, same `analytics_dsl`, same `effective_query_dsl`, same candidate regimes, same forecast settings.

3. Record for both handlers:
   - resolved subjects;
   - analysis type passed into `resolve_forecast_subjects`;
   - read mode;
   - `anchor_from`, `anchor_to`, `sweep_to`, `as_at`;
   - raw row count before and after regime selection;
   - composed frame count;
   - `compute_extent`, `saturation_tau`, `bundle.max_tau`;
   - `cohort_eval_ages`, `cohort_projection_status`;
   - `ef_rate(frontier)`, `ef_rate(saturation)`, and ratio.

4. Fix the boundary, not the reducer, if the trace confirms the current suspected cause:
   - daily-conversions observed rows should continue to use raw snapshot resolution;
   - daily-conversions forecast enrichment should build its CF projection bundle with the same forecast subject contract as cohort-maturity / conditioned-forecast, including `asat`-bounded sweep semantics.

5. After the boundary is fixed, update `test_conditioned_forecast_parity.py` so the daily completeness test compares daily output to the exact shared bundle/scalar datum produced by the same preparation boundary. Avoid a closed-form latency CDF approximation.

6. Re-run focused tests:
   - `graph-editor/lib/tests/test_cf_date_reducer.py`
   - the daily completeness test in `test_conditioned_forecast_parity.py`
   - the previously tracked outside-in p-infinity fallout set if row surfaces were touched.

7. Only then run the broader outside-in / touched-test set.

## Open Questions

- **Blocking:** Should daily-conversions forecast enrichment use a second subject resolution with `path_analysis_type='cohort_maturity'`, or should `_handle_daily_conversions` patch/derive `sweep_from`/`sweep_to` onto the existing raw subject before calling `prepare_forecast_subject_group`? The invariant is clear; the least risky implementation choice still needs deciding.

- **Blocking:** Does the daily-conversions public response need to expose any provenance that distinguishes observed raw series from forecast enrichment bundle provenance? Current mismatch was hard to see because both live in one handler.

- **Non-blocking:** Should `cf-fix-diamond-mixed` deterministic/stochastic fixture settings remain as currently regenerated (`kappa=50`, `kappa_step=50`, `failure_rate=0.05`), or should a future fixture-hardening pass make this truth-parity fixture less noise-prone permanently?
