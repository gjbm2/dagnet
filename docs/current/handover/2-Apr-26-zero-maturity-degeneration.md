# Handover: Zero-Maturity Degeneration Invariant & Fan Chart Rendering

**Date**: 2-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Session context**: Multi-session work on cohort maturity fan chart. This session focused on making the fan chart degenerate correctly to the Bayes model curve at zero maturity, and fixing FE rendering of the model curve under test fixture conditions.

---

## Objective

The cohort maturity fan chart must **degenerate to the Bayes model confidence band** when maturity tends to zero (no observed evidence). This is the §8.1 invariant from `docs/current/project-bayes/cohort-maturity/INDEX.md` — identified as the highest priority open issue.

"Degenerate" means: at zero maturity (where `asat = anchor_from = sweep_to`, so every Cohort has `tau_max = 0`), the MC fan chart's midpoint, upper band, and lower band must be **precisely equal** (within MC sampling noise) to the analytic confidence band produced by `compute_confidence_band()`. They are computing the same thing: the unconditional model uncertainty envelope with no evidence updating.

The user wants to verify this visually in the app using `window(1-Jan-26:1-Jan-26).asat(1-Jan-26)` with `?test_fixture=fan_test_1&nocache=1`, and programmatically via a blind test.

---

## Current State

### DONE — Backend changes to support zero-maturity queries

- **Removed `continue` on zero-rows path** in `api_handlers.py` (~line 1184). Previously, when `derive_cohort_maturity([])` returned for a zero-rows epoch, the code appended the result and `continue`d, skipping all downstream computation (model curve, maturity rows). Now it falls through so the maturity computation can produce a model-only chart.
- **Early `_ds` initialisation** in `api_handlers.py` (line 1287). After removing the `continue`, code fell through to a block using `_ds` (display settings) which was defined later. Moved `_ds = data.get('display_settings') or {}` before the test fixture fork to prevent `UnboundLocalError`.
- **Test fixture uses app query dates** in `api_handlers.py` (~line 1645). The test fixture fork previously passed the fixture's own hardcoded `anchor_from/to` and `sweep_to`. Now it passes the app's query dates (`subj['anchor_from']`, etc.) so the user can control the date window from the UI and test different maturity levels.
- **Gate widened for maturity rows** in `api_handlers.py` (~line 1631). Changed from `'frames' in result` to `('frames' in result or _test_fixture)` so maturity rows are computed even when the result has no frames (zero-rows + test fixture).

### DONE — Model curve fix for zero-maturity queries (FE rendering fix)

- **Added `t95` to test fixture `model_params`** in `api_handlers.py` (~line 1334). The model curve generation block (line 1448) requires `axis_tau_max > 0`, computed from `max(sweep_span, t95, path_t95)`. When `sweep_to == anchor_from`, `sweep_span = 0`. The fixture has no `t95` or `path_t95`. So `candidates` was empty, `axis_tau_max = None`, and the entire model curve block was skipped — meaning the FE received no `model_curve` in the response and rendered nothing. Fix: `'t95': _fixture_data.get('axis_tau_max', 60)` in `model_params`.

### DONE — MC dispersion mechanism (window mode)

- **Switched from posterior mean to Beta draw** in `cohort_forecast.py` (~line 830). Window mode now uses `rng.beta(a_post, b_post)` for rate dispersion instead of `post_rate_b = (alpha_0 + k_i) / (alpha_0 + beta_0 + n_eff_b)`. This gives proper fan width from the Beta posterior.
- **Uses pure `cdf_arr` (no p) for `remaining_cdf`** in both window and cohort mode. Previously window mode used `q = p × CDF`, which caused a p² bug: remaining_cdf had p baked in, then multiplied by rate ≈ p again.

### DONE — Cohort mode MC dispersion

- **Same Beta draw mechanism** as window mode, but using `x_at_frontier` (scalar) for the y projection base instead of `N_i`.

### DONE — Zero-maturity diagnostic

- **`[DIAG_0d]` diagnostic dump** in `cohort_forecast.py` (~line 893). For Cohorts with `tau_max ≤ 5`, prints per-tau decomposition: `c_i_med`, `n_eff_med`, `r_draw` percentiles, `x_frontier`, `rate_med` vs `model_rate` with delta. Active for both window and cohort modes.

### DONE — Blind degeneration test

- **`TestWindowZeroMaturityDegeneration`** in `test_cohort_forecast.py` (~line 352). Loads `fan_test_1.json` fixture, creates zero-maturity frames, calls both `compute_cohort_maturity_rows` (MC fan) and `compute_confidence_band` (analytic band) with same params. Asserts midpoint, upper, and lower match within TOL=0.03.

### FAILING — The degeneration invariant itself

- **The test fails** with systematic bias. At tau=8: fan midpoint=0.3107 vs band midpoint=0.2710 (delta=0.0397). This is not MC noise — it's a consistent upward bias in the MC fan relative to the analytic band. The invariant is violated and needs root-cause investigation.

### NOT VERIFIED — FE rendering

- The `t95` fix should restore the model curve in the BE response for zero-maturity fixture queries. This has **not been verified visually** in the app yet. The user should test with `?test_fixture=fan_test_1&nocache=1` and a zero-maturity query.

---

## Key Decisions & Rationale

### 1. Window mode uses pure `cdf_arr`, not `q = p × CDF`

**What**: `remaining_cdf` and `c_i_b` use the pure latency CDF array, not the `q` array that multiplies CDF by p.

**Why**: Using `q` caused a p² bug. The forecast equation is `y = k + x × remaining_cdf × rate_draw`. If `remaining_cdf` already contains p (via q), and `rate_draw ≈ p`, the result is `p² × CDF` instead of `p × CDF`. This produced over-dispersion in window mode.

**Where**: `cohort_forecast.py` ~lines 821–840. The window and cohort modes now both compute `cdf_at_a`, `c_i_b`, `remaining_cdf` from `cdf_arr` independently.

### 2. Beta draw for rate dispersion (not posterior mean)

**What**: Both window and cohort mode use `rng.beta(a_post, b_post)` to draw rates per MC sample, rather than the deterministic posterior mean.

**Why**: Using the posterior mean `(alpha_0 + k) / (alpha_0 + beta_0 + n_eff)` gave zero rate dispersion — every MC sample had the same rate. The only fan width came from (mu, sigma, onset) variation in the CDF. The Beta draw gives proper rate uncertainty that increases at low maturity.

**Where**: `cohort_forecast.py` ~lines 835 (window) and 860 (cohort). `a_post = alpha_0 + k_i`, `b_post = max(beta_0 + n_eff_b - k_i, 1e-6)`.

### 3. α₀/β₀ derived from raw `posterior_alpha`/`posterior_beta`, not from `edge_p`/`edge_p_sd`

**What**: The MC prior uses the raw posterior alpha/beta from the graph edge's Bayesian posterior, not derived from `edge_p` and `edge_p_sd` via method-of-moments.

**Why**: We experimented with deriving from `edge_p`/`edge_p_sd` and it introduced a prior mis-centring issue. Reverted because the blind test passed with the original source. The `edge_p` / `edge_p_sd` derivation is kept only as a fallback when raw posterior alpha/beta are unavailable.

**Where**: `cohort_forecast.py` — the alpha/beta source logic is in the prior resolution block before the MC loop (~lines 730–760, check exact location). Falls back through: (1) raw `posterior_alpha`/`posterior_beta`, (2) method-of-moments from `edge_p`/`edge_p_sd`, (3) weak prior.

### 4. Test fixture passes app query dates, not fixture hardcoded dates

**What**: The test fixture fork in `api_handlers.py` now passes `subj['anchor_from']`, `subj['anchor_to']`, `subj['sweep_to']` to `compute_cohort_maturity_rows`, not the fixture's own dates.

**Why**: The user needs to control the date window from the UI to test different maturity levels (zero maturity, partial maturity, full maturity) against the same fixture evidence. With fixture dates hardcoded, changing the query dates in the app had no effect.

**Where**: `api_handlers.py` ~lines 1645–1658.

### 5. The confidence band comparison is the correct invariant test

**What**: The degeneration test compares MC fan output against `compute_confidence_band()`, not against the model curve (p × CDF).

**Why**: The user was explicit: at zero maturity, the fan and the confidence band must be **precisely the same** — same midpoint, same upper, same lower. The confidence band already captures parameter uncertainty (p, mu, sigma, onset draws from their posteriors). The MC fan at zero maturity should be doing the same thing. Comparing against the flat model curve (p × CDF) would only test the midpoint, not the bands.

**Where**: `test_cohort_forecast.py` ~line 365, `TestWindowZeroMaturityDegeneration`.

---

## Discoveries & Gotchas

### The test fixture has no `t95` or `path_t95`

The `fan_test_1.json` fixture has `axis_tau_max: 60` but no `t95`/`path_t95` in `edge_params`. The model curve generation in `api_handlers.py` depends on `axis_tau_max` being derived from `max(sweep_span, t95, path_t95)`. When `sweep_span = 0` (zero-maturity query) and there's no t95, the model curve is simply not generated — the FE receives no curve data and renders nothing. This was the cause of the "no bayes curve" bug.

### The zero-rows `continue` was load-bearing in a bad way

The `continue` on the zero-rows path (when `derive_cohort_maturity([])` returned) was originally there to handle gap epochs. But it also silently skipped ALL downstream computation: model curve overlay, source model curves, confidence bands, and maturity rows. Removing it required adding `_ds` early initialisation and widening the `'frames' in result` gate.

### The fan has a systematic upward bias at low tau

The failing test shows fan midpoint = 0.3107 vs band midpoint = 0.2710 at tau=8 (delta = 0.04). The diagnostic output shows `rate_med` tracking `model_rate` well at higher tau (delta < 0.01 at tau=10, 15, 20, 30), but the midpoint aggregation diverges. This suggests the issue is not in the per-Cohort rate draw but in how the midpoint is aggregated from the MC samples — possibly the median of (y/x) across draws differs from (median_y / median_x), or the deterministic midpoint calculation has a different basis than the MC percentiles.

### `compute_confidence_band` is also MC-based

Both the fan and the confidence band use Monte Carlo draws. The confidence band draws (p, mu, sigma, onset) from an MVN approximation of the posterior. The fan draws (mu, sigma, onset) from the same MVN and then draws rate from a Beta posterior. At zero maturity (n_eff = 0), the Beta posterior should equal the Beta prior, which should match the p distribution from the MVN. But these are different sampling mechanisms — the Beta prior shape depends on alpha_0/beta_0 while the MVN draws p directly with p_sd. They will only agree if alpha_0/beta_0 imply the same distribution as N(p, p_sd²). This may be the root cause of the systematic bias.

### User's strong preferences about testing

The user was extremely frustrated by tests using inline/fake fixtures instead of the real JSON fixture. The test must be "blind" — written from the contract, not from reading the implementation. It must compare two actual code paths with the same real fixture data, not mock anything. The current test follows this pattern correctly.

---

## Relevant Files

### Backend
- **`graph-editor/lib/api_handlers.py`** — Main API handler for snapshot analysis. Contains the test fixture fork, model curve generation, and maturity rows computation orchestration. Key areas: lines ~1184 (zero-rows path), ~1286–1338 (test fixture setup), ~1428–1465 (model curve / axis_tau_max), ~1630–1678 (maturity rows computation).
- **`graph-editor/lib/runner/cohort_forecast.py`** — Core MC fan chart computation. `compute_cohort_maturity_rows()` is the main entry point. Key areas: ~line 727 (MC_SAMPLES=2000), ~lines 818–890 (per-Cohort MC loop with window/cohort split, Beta draw, cdf_arr usage, diagnostic dump).
- **`graph-editor/lib/runner/confidence_bands.py`** — `compute_confidence_band()` — analytic (MVN MC) confidence band. The target that the fan must match at zero maturity.
- **`graph-editor/lib/runner/cohort_maturity_derivation.py`** — `derive_cohort_maturity()` — builds frames from snapshot rows. Returns empty frames with correct structure when rows==[].

### Frontend
- **`graph-editor/src/lib/graphComputeClient.ts`** — Lines ~500–535: extracts `model_curve`, `source_model_curves`, `bayesBandUpper/Lower` from BE response into `modelCurveBySubject` map. Lines ~540–600: collects `maturity_rows` from BE blocks. The FE condition at line 504 (`r?.model_curve && Array.isArray(r.model_curve) && r.model_curve.length > 0`) gates model curve inclusion.
- **`graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts`** — Renders model curves and Bayes bands. Reads from `result.metadata.model_curves[subjectId]`. Lines ~324–370 (promoted model curve), ~401–430 (Bayesian band), ~462–575 (per-source curves + legacy fallback).

### Tests
- **`graph-editor/lib/tests/test_cohort_forecast.py`** — Contains `TestWindowZeroMaturityDegeneration` with `test_fan_equals_confidence_band_at_zero_maturity`. Currently FAILING with delta=0.04 at tau=8.

### Fixtures
- **`graph-editor/lib/runner/test_fixtures/fan_test_1.json`** — 7 Cohorts dated 1-Jan to 7-Jan 2026, sweep to 13-Jan. Model: p=0.83, mu=1.62, sigma=0.8, onset=4.0. Posterior alpha=20.75, beta=4.25. Has `axis_tau_max: 60`.

### Docs
- **`docs/current/project-bayes/cohort-maturity/INDEX.md`** — Consolidated index of all open issues. §8.1 (zero-maturity degeneration) is the highest priority.
- **`docs/current/project-bayes/cohort-maturity/cohort-x-per-date-estimation.md`** — Options 1/1b/2 for per-Cohort-date x estimation. §8 has open calibration issues.
- **`docs/current/project-bayes/cohort-maturity/cohort-maturity-full-bayes-design.md`** — Full Bayes design. §7.5 (y projection base) and §11 (implementation defects) are open.

---

## Next Steps

### 1. Verify FE rendering (quick visual check)

Load `?test_fixture=fan_test_1&nocache=1` with a zero-maturity query like `window(1-Jan-26:1-Jan-26).asat(1-Jan-26)`. Confirm the Bayes model curve now appears. The `t95` fix in `model_params` should have restored it.

### 2. Investigate the systematic midpoint bias (root cause of test failure)

The test fails at tau=8 with fan midpoint=0.3107 vs confidence band midpoint=0.2710 (delta=0.04). This is the core §8.1 investigation. Likely root causes to check:

- **Distribution mismatch between Beta prior and MVN p-draw**: `compute_confidence_band` draws p from `N(p, p_sd²)` clipped to [0,1]. The fan draws rate from `Beta(alpha_0, beta_0)` where alpha_0/beta_0 are derived from the raw posterior. If the Beta(46.02, 9.42) distribution doesn't match N(0.83, 0.05²), the fans will differ systematically. Check by comparing the mean and variance of both distributions.
- **Midpoint computation mismatch**: The fan's "midpoint" row field may be computed differently (deterministic path vs median of MC) from the confidence band's midpoint ((upper+lower)/2). Check how `midpoint` is populated in `cohort_forecast.py` — it uses the deterministic path, not the MC median.
- **n_eff at zero maturity**: With tau_max=0 and x=58, `c_i_b = cdf_arr[:, 0]`. If `cdf_arr` at tau=0 is not exactly 0 for all MC draws (due to onset variation), `n_eff_b` will be nonzero, which would shift the Beta posterior away from the prior. Check the `c_i_med` values in the `[DIAG_0d]` output — they show 0.000000, so this is likely not the issue.

Start by comparing the two sampling mechanisms analytically: what is the mean/variance of `Beta(46.02, 9.42)` vs `N(0.83, 0.05²)` clipped to [0,1]? If they differ materially, the fix is to align them — either make the confidence band use Beta draws, or make the fan use MVN p-draws.

### 3. Fix the degeneration bug

Once root cause is identified, make the minimal change to align the two distributions. The fan should use the same p-draw mechanism as the confidence band at zero maturity, or vice versa.

### 4. Get the test passing with tight tolerance

After fixing, the test should pass with TOL=0.03 (MC noise only). If it doesn't, increase MC_SAMPLES in the test or seed the RNG for determinism.

### 5. Continue with §11 implementation defects

After §8.1 is resolved: shared-ancestor bug in `compute_reach_probability`, reach not anchored to query anchor node, inconsistent probability sources. These are listed in the Bayes design doc §11.

---

## Open Questions

### Blocking

- **Why does the fan midpoint have upward bias at low tau?** Is it the Beta vs MVN distribution mismatch, or the deterministic midpoint computation? This must be diagnosed before the invariant can be satisfied. See Next Steps §2 above.

### Non-blocking

- **Should the confidence band also use Beta draws for p?** If we align by changing the confidence band (rather than the fan), it would be a more principled fix (Beta is the conjugate prior for binomial rate), but it would change the confidence band appearance for all charts, not just zero-maturity.
- **Should the test seed the RNG?** Currently uses default random state, so test results vary slightly between runs. A fixed seed would make failures deterministic and reproducible. Trade-off: a seed might mask bugs that only appear with certain draw sequences.
- **Cohort mode degeneration**: The current test only covers window mode. The same invariant should hold for cohort mode, but it has additional complexity (reach probability, upstream path CDF). Defer until window mode passes.
