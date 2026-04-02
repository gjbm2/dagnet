# Cohort Forecast Conditioning Attempts (1-Apr-26)

## Purpose

This note records the experimental conditioning changes attempted in
`graph-editor/lib/runner/cohort_forecast.py` during the fan-chart MC
debugging thread, and the related test change in
`graph-editor/lib/tests/test_cohort_forecast.py`.

These attempts are documented for traceability and then reverted from code.

## What was changed in `cohort_forecast.py`

### 1) Added posterior-derived effective sample size helper

- Added `_beta_effective_sample_size(mean, sd)` to map posterior mean/SD
  to an equivalent Beta sample size estimate.

### 2) Reworked cohort-mode MC forecasting branch (`is_window=False`)

- Split logic into explicit branches:
  - window mode,
  - cohort mode without upstream model,
  - cohort mode with upstream model.
- For cohort mode with upstream model:
  - forecasted `x` from `a_pop * upstream_q`,
  - scaled by observed `N_i` at the observation age,
  - hard-clipped `x` to `[N_i, max(a_pop, N_i)]`.
- Replaced direct CDF-ratio `y` progression with conditional-rate blending:
  - inferred conditional rate as `q / upstream_q`,
  - clipped inferred conditional rate to sampled `p`,
  - blended model conditional rate with observed `k_i / N_i` using
    posterior-derived effective sample size,
  - clipped resulting rates into `[0, 1]`,
  - enforced `k_i <= y <= x`.

### 3) Reworked deterministic midpoint path for cohort mode

- Mirrored the same cohort-mode calibration pattern used in MC:
  - upstream-based `x` forecast with hard clip,
  - conditional rate inferred from target/upstream ratio,
  - cap by edge posterior `p`,
  - posterior/evidence blend,
  - clamped to physical bounds.

## What was changed in `test_cohort_forecast.py`

- Added `date` and `timedelta` imports.
- Added integration-style scenario test class
  `TestCohortModeModelDominance` with
  `test_midpoint_is_pulled_by_model_in_epoch_b_for_sparse_immature_cohort`.
- Test intent:
  - confirm sparse immature evidence is pulled by model behaviour in cohort mode,
  - guard against collapse to near-zero midpoint.

## Why these changes were attempted

- Address catastrophic MC collapse for sparse immature cohorts.
- Address opposite failure mode where forecasts saturated aggressively to 1.0.
- Move towards model-dominant behaviour under sparse evidence.

## Known issues with these attempts

- Included heuristic guards/caps that were not agreed as modelling policy.
- Mixed numerical stabilisation with modelling assumptions.
- Did not cleanly separate:
  - true observed retrieval evidence,
  - carry-forward frame artefacts,
  - posterior-driven conditioning.

## Disposition

- These code changes are being reverted from:
  - `graph-editor/lib/runner/cohort_forecast.py`
  - `graph-editor/lib/tests/test_cohort_forecast.py`
- This document remains as an audit trail of attempted approaches.
