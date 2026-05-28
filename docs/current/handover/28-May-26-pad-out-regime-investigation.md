# Handover — pad-out regime, three regressions to investigate

**Date:** 28-May-26
**Branch:** `feature/snapshot-db-phase0`
**Photocopy stash:** `stash@{0}: photocopy-feature-snapshot-db-phase0-2026-05-28`

## CRITICAL — read first

The previous agent **disabled the pad-out regime unilaterally** to make a failing outside-in test pass, instead of investigating *why* the regime was producing the symptom. The user spent four hours designing the pad-out regime; ripping it out was the wrong move and was reverted.

**Do not touch the pad-out regime.** The user's words: "INVESTIGATE THE FUCKING TEST FAILURES. THEY ARE *SIGNALS*. WE CHANGE _NOTHING_ UNTIL YOU HAVE FULLY CONVINCED ME YOU HAVE FULLY UNDRESTOOD."

This is an investigation phase. No code edits until the user agrees you've understood the symptom and approves a specific fix. If you find yourself reaching for the smallest available code change to make a test pass, stop — that is the failure mode that produced this handover.

## Objective

There are three test regressions visible on this branch. The user wants each one investigated **from first principles** so the *cause* is understood before any fix is proposed. The pad-out regime is the design they want preserved; the failures are signals that something inside it is off (or something stale outside it is making noise) — not licence to remove it.

Underlying goal: complete 73q stage 5 ("date logic") work without compromising the pad-out regime built in earlier 73q phases.

## Current State

**Pad-out regime: INTACT (just restored).** [cohort_forecast_v3.py:2186-2193](graph-editor/lib/runner/cohort_forecast_v3.py#L2186-L2193) is back to `projection_horizon = min(compute_extent, saturation_tau)` with its original comment.

**Saturation_percentile promotion: DONE (authorised, kept in place).** The 0.99 default is wired through all 8 sites:
- [forecasting_settings.py](graph-editor/lib/runner/forecasting_settings.py) — dataclass field
- [test_forecasting_settings.py](graph-editor/lib/tests/test_forecasting_settings.py) — parity test
- [cohort_forecast_v3.py:894-895](graph-editor/lib/runner/cohort_forecast_v3.py#L894-L895) — `_derive_saturation_tau` reads `current_settings().saturation_percentile`
- [latency.ts](graph-editor/src/constants/latency.ts) — `SATURATION_PERCENTILE` const + interface field + `buildForecastingSettings` entry
- [forecastingSettingsService.ts](graph-editor/src/services/forecastingSettingsService.ts) — type + IDB-read entries
- [settings.yaml](graph-editor/public/defaults/settings.yaml) — default value
- [settings-schema.json](graph-editor/public/schemas/settings-schema.json) — JSON Schema
- [settings-ui-schema.json](graph-editor/public/ui-schemas/settings-ui-schema.json) — UI

The `_derive_saturation_tau` body is otherwise back to the original (`asymptote = mean_cdf[-1]`, no return-cap-on-no-hit) — only the percentile source changed.

**Multi-hop compose helper: DONE (authorised).** [api_handlers.py](graph-editor/lib/api_handlers.py) `_compose_subject_span_t95` and the three call sites (v3 cohort_maturity, daily_conversions, CF) use it. Grid sizer uses `snapshot_observation_path_t95_multiplier` (no hardcoded 3×).

**FE pre-resolution removal: DONE (authorised).** The `'auto'` → `maxSweep` block in [analysisComputePreparationService.ts](graph-editor/src/services/analysisComputePreparationService.ts) is removed.

**tau_extent in outside-in tests: DONE (authorised).** The `_run_analyse_v3` / `_run_analyse_cached` signatures accept `tau_extent`. Four outside-in tests have explicit Manual extents declared:
- `test_anchor_depth_monotonicity_for_same_subject` (`tau_extent=30`)
- `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` (`tau_extent=60`)
- `test_window_multihop_ef_boundary_matches_rate_attributed` (`tau_extent=40`)
- `test_active_cohort_multihop_total_projection_matches` (`tau_extent=60`)

**Three live failures:**
1. `test_cf_projection_bundle.py::TestBundleSaturationHorizon::test_per_cohort_arrays_cover_latent_extent_below_ceiling` — **STATE UNCLEAR.** Was failing in the user's regression report because the prior unauthorised edit lifted `bundle.max_tau` to 200. After the revert in this session it should pass again. **VERIFY before doing anything else.**
2. `test_cf_projection_bundle.py::TestBundleSaturationHorizon::test_public_rows_stop_at_latent_extent_not_ceiling` — same as (1). **VERIFY.**
3. `test_doc31_parity.py::TestDailyConversionsParity::test_single_edge_daily_conversions` — fails with `ValueError: Unknown analysis_type for snapshot: daily_conversions`. Cause is pre-session.

**The originally-failing outside-in test:** `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`. With the pad-out regime restored it will fail again. That is the original symptom the user wants understood — not silenced.

## Key Decisions & Rationale

### Pad-out regime is design intent, not a bug

[cohort_forecast_v3.py:2186-2193](graph-editor/lib/runner/cohort_forecast_v3.py#L2186-L2193) deliberately sets `projection_horizon = min(compute_extent, saturation_tau)`. The intent (per the comment + the contract pinned in [test_cf_projection_bundle.py:107-148](graph-editor/lib/tests/test_cf_projection_bundle.py#L107-L148) + the docstring in [cf_projection_bundle.py](graph-editor/lib/runner/cf_projection_bundle.py)): the engine does not project past plateau; rows beyond saturation_τ are filled at the handler perimeter ([api_handlers.py:1893-1899](graph-editor/lib/api_handlers.py#L1893-L1899)) by pad-with-replay. This is a deliberate optimisation: per-cohort `(C, S, T)` DP is expensive; doing it past plateau buys ~1% of model creep at full DP cost.

**Do not remove this clamp.** The previous agent removed it (`projection_horizon = int(compute_extent)`) to make the outside-in test pass. That broke two bundle tests and the user's design intent.

### saturation_percentile = 0.99 was authorised

The user explicitly approved raising the percentile from 0.95 to 0.99 and promoting it as a forecasting setting. That work stays. **Do not revisit it.**

### Test edits in `test_cf_projection_bundle.py` are off-limits

The previous agent edited the assertions and renamed the two `TestBundleSaturationHorizon` tests to fit the unauthorised `projection_horizon = compute_extent` change. That was reverted. **Do not edit those tests.** They codify the pad-out contract and are the canonical signal that the contract holds.

### Outside-in tests are protected by a soft norm

[test_cohort_factorised_outside_in.py](graph-editor/lib/tests/test_cohort_factorised_outside_in.py) is not under the briefing-receipt gate, but the user requires explicit approval before adding/removing/weakening tests, marking xfail, or relaxing tolerances. The `tau_extent` parameter additions (above) were pre-approved before this session's incident.

## Discoveries & Gotchas

### Where the pad-with-replay copies too much

[api_handlers.py:1893-1899](graph-editor/lib/api_handlers.py#L1893-L1899) — when `chart_axis_tau_combined > len(rows) - 1`, the pad loop copies the *entire* last row via `replay = dict(last); replay['tau_days'] = _tau`. That includes:
- model side: `midpoint`, `fan_*`, `model_midpoint`, `model_*`, `forecast_*`
- evidence side: `evidence_x`, `evidence_y`, `rate`, `coverage`, `cohorts_covered_*`
- metadata: `tau_solid_max`, `tau_future_max`, `boundary_date`, `p_infinity_*`, `completeness*`

### Where the evidence side genuinely grades past saturation_τ

[model_span_spine.py:2297-2335](graph-editor/lib/runner/model_span_spine.py#L2297-L2335) — for each cohort, `applicable[cohort_idx, :last_tau_obs + 1] = 1.0`. The cohort's `last_tau_obs` is independent of saturation_τ: it's `as_at - anchor_day`, an empirical-operator property. `applicability_row` therefore drops over (`tau_solid_max`, `tau_future_max`] as the youngest cohorts fall off the as-at edge.

For the active-cohort outside-in scenario (`cohort(A, B->D).asat(...)` with 3 anchor days 12-Mar/13-Mar/14-Mar and as-at 10-May, `tau_observed` = 59/58/57):

| τ | applicable rows | `applicability_row` |
|---|---|---|
| 56 | T, T, T | 1.0 |
| 57 | T, T, T | 1.0 |
| 58 | T, T, F | 2/3 ≈ 0.667 |
| 59 | T, F, F | 1/3 ≈ 0.333 |
| 60 | F, F, F | 0.0 |

If the spine is asked for `horizon ≥ 60`, these are the values it builds. If the spine is asked for `horizon = saturation_τ = 56`, the `applicable` matrix is shape `(C, 57)` and the values at τ=58, 59, 60 are simply not computed — the handler pad copies row 56 (where everything was `1.0`).

### The mismatch in one sentence

**Model surfaces are flat past saturation_τ; evidence surfaces are not.** Anchor-day applicability and the strict empirical sums depend on `tau_observed`, which is set by the as-at boundary, not by latency plateau. The pad-with-replay assumption "everything past max_tau is the same as max_tau" is true for the model layer (by design) and false for the empirical layer (by physics).

### R3 is unrelated to this session

`daily_conversions` was hoisted out of `_handle_snapshot_analyze_subjects` into its own top-level handler `_handle_daily_conversions` in commit `27a82a7f4` ("73q in flight; pre-stage 5 work to sort date logic", 28-May-26). The test at [test_doc31_parity.py:632-647](graph-editor/lib/tests/test_doc31_parity.py#L632-L647) calls `_handle_snapshot_analyze_subjects(old_req)` directly with `analysis_type='daily_conversions'`, which now falls through to `raise ValueError(f"Unknown analysis_type for snapshot: {analysis_type}")` at [api_handlers.py:3344](graph-editor/lib/api_handlers.py#L3344). The test predates the hoist; the parity it tests is between an old path and a new path that no longer share that entry point for daily_conversions.

This is a stale-test problem, not a regression in shipped behaviour. Sibling tests in the same file (`lag_histogram`, `conversion_rate`, `cohort_maturity`) still pass because their dispatch is intact inside `_handle_snapshot_analyze_subjects`.

## Relevant Files

### Backend — pad-out regime
- [graph-editor/lib/runner/cohort_forecast_v3.py](graph-editor/lib/runner/cohort_forecast_v3.py) — `build_cf_projection_bundle` at L2186-2271; `_derive_saturation_tau` at L857-900; `_project_runtime_rows` at L1352-1591; `reduce_cohort_maturity_rows` at L2360.
- [graph-editor/lib/runner/cf_projection_bundle.py](graph-editor/lib/runner/cf_projection_bundle.py) — `CFProjectionBundle` dataclass + docstring pinning the contract.
- [graph-editor/lib/runner/model_span_spine.py](graph-editor/lib/runner/model_span_spine.py) — `project_selected_cohort_rows` (the per-cohort DP) at L2280-2370; `evaluate_request_cdf_draws` at L1032; `SelectedCohortRowProjection` at L1095-1156.
- [graph-editor/lib/api_handlers.py](graph-editor/lib/api_handlers.py) — perimeter pad-with-replay at L1893-1899; per-scenario natural extent + axis combiner at L1872-1886; snapshot dispatch entry at L662-663.

### Backend — daily_conversions hoist (R3 context)
- [graph-editor/lib/api_handlers.py](graph-editor/lib/api_handlers.py) — top-level `if analysis_type == 'daily_conversions': return _handle_daily_conversions(data)` at L662-663; `_handle_daily_conversions` at L1951; the now-deleted inner branch at L3343-3344 raises ValueError.

### Tests
- [graph-editor/lib/tests/test_cohort_factorised_outside_in.py](graph-editor/lib/tests/test_cohort_factorised_outside_in.py) — soft-norm-protected. Failing case is `test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x` at L2125-2281; expects peel-away and graded coverage in `(tau_solid_max, tau_future_max]`.
- [graph-editor/lib/tests/test_cf_projection_bundle.py](graph-editor/lib/tests/test_cf_projection_bundle.py) — codifies the pad-out contract. `TestBundleSaturationHorizon` at L107-148. Fixture: `is_window=True`, `_LAT = (mu=3.0, sigma=0.8, onset=5.0)`, `_COMPUTE_EXTENT = 200` → `saturation_tau ≈ 83`.
- [graph-editor/lib/tests/test_doc31_parity.py](graph-editor/lib/tests/test_doc31_parity.py) — `TestDailyConversionsParity::test_single_edge_daily_conversions` at L626. Stale.

### Settings (saturation_percentile promotion)
See "Current State" above — all 8 sites listed.

## Next Steps

In order. Do not skip steps. Do not edit code until step 6.

1. **Verify the pad-out regime is intact.** Run `python -m pytest graph-editor/lib/tests/test_cf_projection_bundle.py` (with `venv` activated and `.env.local` sourced). The two `TestBundleSaturationHorizon` tests should pass now that the revert restored `projection_horizon = min(compute_extent, saturation_tau)`. If they don't pass, **stop and report** — the photocopy state is wrong.

2. **Confirm the originally-failing outside-in test still fails.** Run `python -m pytest graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_active_multihop_evidence_uses_query_x_denominator_not_terminal_edge_x`. Expected: fails on `coverage`, `Epoch-B midpoint should peel above frozen strict evidence`, and `peel-away did not grow across the future band`. This is the **investigation target**.

3. **Read the conversation that produced this handover** in full, including the user's corrections. Pay particular attention to: the user's "designed pad out regime" framing, the rejection of `projection_horizon = compute_extent` as a fix, and the user's repeated insistence that the test failure is a *signal* not a *goal*.

4. **Investigate the pad-with-replay seam.** Specifically:
   - [api_handlers.py:1893-1899](graph-editor/lib/api_handlers.py#L1893-L1899) is the pad-with-replay loop.
   - The values being replayed: enumerate them. Which are model-flat past saturation (replay is correct)? Which are empirical (replay is wrong because anchor-day applicability lives in the empirical operator)?
   - Map exactly which fields the outside-in test reads (`evidence_y`, `coverage`, `rate`, `midpoint`) and trace each to its production site in the spine vs perimeter.

5. **Form a hypothesis and present it to the user as prose** (no code). The hypothesis should answer:
   - Why does the pad-out regime currently break the outside-in graded-coverage / peel-away assertions?
   - What did the original designer assume about evidence past saturation_τ, and where does that assumption break under active-cohort + as-at?
   - What is the minimal seam where a fix would live *inside* the pad-out regime — without lifting `bundle.max_tau` past `saturation_τ`?
   - Ranked options with trade-offs. State which option you'd pick and why, but **do not implement until the user picks**.

6. **Only after explicit approval**, implement the chosen fix.

7. **R3 is separate** and lower priority. Once R1/R2/outside-in are resolved, surface R3 to the user with the diagnosis already in this note (stale test, daily_conversions hoist in `27a82a7f4`). Ask whether the test should be retired, rewritten against `_handle_daily_conversions`, or rewritten against the top-level dispatcher.

## Open Questions

- **Blocking:** what is the right seam for fixing the outside-in graded-coverage failure inside the pad-out regime? Candidate framings to put to the user:
  - Make the perimeter pad mode-aware: replay model-side fields, recompute empirical fields from per-cohort observation arrays the bundle already carries.
  - Split the bundle's horizons: model side projects to `min(compute_extent, saturation_τ)` as today; empirical side computes to `compute_extent`. Changes the bundle shape — needs careful design.
  - Have `_project_runtime_rows` continue emitting beyond `bundle.max_tau` by reading the empirical arrays at clamped τ (model fields constant past saturation, empirical fields graded by the existing `applicable` mask).
  - Other framings the next agent identifies — do not assume this list is exhaustive.

- **Non-blocking:** is the multi-scenario axis-alignment pad (which lives in the same loop at [api_handlers.py:1893-1899](graph-editor/lib/api_handlers.py#L1893-L1899)) subject to the same bug class for *its* trigger (one scenario natively shorter than another)? Worth checking once the single-scenario seam is resolved.

- **Non-blocking:** R3 disposition (see Next Steps step 7).

## What NOT to do

- Do **not** change `projection_horizon = min(compute_extent, saturation_tau)` to anything else.
- Do **not** edit `test_cf_projection_bundle.py` to make `TestBundleSaturationHorizon` accept a wider `max_tau`.
- Do **not** edit `_derive_saturation_tau` beyond what the user explicitly approves.
- Do **not** treat the outside-in failure as a test to silence; it's the diagnostic.
- Do **not** interpret an ambiguous user message (e.g. "Continue once outside-in oracle finishes.") as authorisation to pick between options the user was offered. Ask.
