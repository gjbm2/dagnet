# Handover: D/C State Decomposition — Posterior Predictive Fan Chart

**Date**: 3-Apr-26
**Branch**: `feature/snapshot-db-phase0`
**Continues from**: `2-Apr-26-posterior-predictive-fan.md` (now stale — superseded by this note)

---

## Objective

The cohort maturity fan chart must show a posterior predictive interval answering "with 90% confidence, where will this group of cohorts land?" The fan must degenerate to the model's unconditional curve at zero evidence and narrow progressively with data.

A multi-phase design was agreed and Phases 1-4 are implemented. A structural defect in the state decomposition was identified and a principled rewrite plan has been agreed but not yet implemented.

---

## Current State

### DONE — Phases 1-4

All implemented in `graph-editor/lib/runner/cohort_forecast.py`.

**Phase 1: Direct posterior draws.** Removed all importance sampling (was double-counting — edge vars ARE the posterior). Direct `rng.multivariate_normal(theta_mean, posterior_cov, size=S)`.

**Phase 2: Per-cohort drift layer.** Diagonal drift on (logit-p, mu, log-sigma, log1p-onset) per cohort. `DRIFT_FRACTION` sourced from `edge_params.get('cohort_drift_fraction', 0.20)`, configurable in Data > Forecasting Settings.

**Phase 3: Per-cohort IS conditioning on frontier evidence.** Each cohort's drifted draws are conditioned on its frontier observation (k_i, N_i) via Binomial log-likelihood + resampling. Tractable because per-cohort N is small (10-50). Lines ~1028-1053.

**Phase 4: Stochastic upstream x.** In cohort mode, upstream edge params are perturbed per MC draw using each edge's own posterior SDs. Beta(alpha, beta) draws for upstream p. Mixture weights normalised per draw. Lines ~916-980.

### DONE — Epoch unification

Merged in `api_handlers.py` (~lines 1149-1270). All epoch frames are gathered into a single list and `compute_cohort_maturity_rows` is called once with the full set. Each cohort carries its own tau_max. The per-epoch orchestration loop and FE epoch stitching are no longer the primary path. Tau dedup in `graphComputeClient.ts` (~line 552) remains as safety net.

### DONE — Settings and schema

`COHORT_DRIFT_FRACTION` added to `settings-schema.json` under `forecasting` (Data > Forecasting Settings), not display/chart settings. Corresponding UI schema entry in `settings-ui-schema.json`.

### DONE — Bug fixes (from prior session)

All bugs listed in the prior handover remain fixed: `x_frontier` typo, ISO date parsing in `resolveAsatPosterior`, x-base mismatch, IS double-counting.

### DONE — Red test for cohort-mode degeneration

`test_cohort_mode_zero_evidence_degenerates_to_model` in `test_cohort_forecast.py` (line 585). Uses `cohort_test_1` fixture, one cohort date with a=500, x=0, y=0, scope_from=scope_to=anchor_from. Asserts:

1. Rows produced
2. Beyond 2×onset: midpoint > 0 and non-decreasing
3. Midpoint within 10% of p × CDF_path(tau) for tau > 2×onset
4. Fan width > 5% of midpoint
5. fan_upper > midpoint > fan_lower
6. At tau=30: midpoint > 0.5 × p

**This test is RED.** It fails at tau=7 with midpoint=0 when model rate ≈ 0.22. This is the diagnostic instrument for the structural defect described below.

### NOT STARTED — D/C state decomposition rewrite (agreed plan, not yet implemented)

The structural defect and its fix are described in the next section.

---

## Key Insight: The State Decomposition Is Wrong

### The problem

The current code uses a single `x_forecast_arr` (upstream-scaled) as the denominator for the aggregate rate and as the population basis for all future y. This is structurally wrong. Upstream x should only enter where it represents new exposure arriving after the frontier, not as a universal scaler for forecast y.

Concretely, for a single cohort with frontier age a_i:

- **A** (τ ≤ a_i): x and y are both observed. No forecast needed.
- **D** (frontier survivors): people already at X who haven't converted. x does not change — only y is forecast, using the target edge's own local conversion law. Upstream x has no role here.
- **C** (future arrivals): people who haven't reached X by the frontier. Both x and y are forecast via upstream arrival then downstream conversion. This is the only place upstream x belongs.

The current code's "cohort-mode Pop B" (lines 1116-1171) uses upstream modelled arrivals to retroactively reconstruct how k_i conversions were distributed across arrival sub-cohorts. This is upstream x being used to reinterpret observed y — the wrong bridge.

### The governing design principle: factorised engine

The forecast engine must treat the upstream A→X process and the local X→Y process as factorised. Upstream supplies only C (late arrivals and their downstream conversions). Local supplies only D (frontier survivors and their future conversions). The current code mixes both — it uses the upstream arrival model to reconstruct pre-frontier sub-cohorts and reinterpret observed downstream evidence, and it uses a single upstream-scaled x as the denominator for all forecast y. That mixing is why the degenerate limit fails: at zero evidence there is no clean separation between "what upstream predicts" and "what the local edge predicts", so the two models interfere rather than compose.

The clean implementation principle:

- `Y_forecast = Y_D + Y_C`
- `X_forecast = X_observed_frontier + X_C`

where Y_D uses only local edge evidence/model, and X_C/Y_C are the only places upstream x enters. This factorisation must hold in both the MC path and the deterministic midpoint fallback.

### Why the red test fails

At zero evidence (asat=from=to), N_i=0, k_i=0. Pop C's convolution does `floor()` on sub-integer upstream arrival increments, producing zero arrivals at early taus. With zero x and zero y, the rate is 0/0 and the fallback path fires. The fallback (`p_s × cdf_arr` when median X < 1) is a hack that sometimes works but is not the structural solution.

The correct limit: with no frontier stock, there is no D. Only C exists. C's arrivals should be continuous (model-predicted people, not integer Binomial draws). Rate = Y_C / X_C = (arrivals × p × CDF) / arrivals = p × CDF per draw = model rate. Degeneration holds naturally without any fallback.

### The agreed rewrite

**Delete**: the pre-frontier upstream reconstruction (current cohort-mode Pop B, lines 1116-1171) and the single `x_forecast_arr` block (lines 1055-1068).

**Pop D** (frontier survivors): purely local. Simple conditional Binomial: `Binomial(N_i - k_i, q_late)` where `q_late = p(CDF(τ) - CDF(a_i)) / (1 - p·CDF(a_i))`. Same law for window and cohort mode — how people arrived is irrelevant to the conditional forecast. No upstream involvement.

**Pop C** (post-frontier arrivals): continuous expectations, not Binomial with floor. For each exposure duration d: `Y_C += arrivals(s) × p_i × CDF_edge(d)`, `X_C += arrivals(s)`. All continuous, all per-draw. These are model-predicted people — parameter variation across MC draws provides the uncertainty. Binomial noise is not appropriate for predicted (non-integer) populations.

**X_cohort** = N_i + X_C (not upstream-scaled x_forecast_arr).

**Y_cohort** = k_i + Y_D + Y_C.

**Deterministic midpoint** (lines 1343-1357): same D/C split. `x = x_frozen + X_C_det`, `y = y_frozen + Y_D_det + Y_C_det`. No `x_forecast × rate` pattern.

### Why degeneration holds

At asat=from=to (N_i=0, k_i=0): D is empty (no frontier stock). Only C contributes. X_C = upstream arrivals (continuous per draw). Y_C = arrivals × p × CDF per draw. Rate = Y_C / X_C = p × CDF per draw = model rate. No fallback needed. The `median X < 1` safety net stays but should never fire in this case.

### Why existing tests should still pass

For cohorts with real evidence (N_i > 0, k_i > 0): D produces the same conditional Binomial as the current window-mode Pop B. C is a small correction term at moderate maturities (most arrivals are pre-frontier). The aggregate rate should be essentially unchanged.

---

## Discoveries & Gotchas

### Pre-frontier reconstruction is the wrong bridge

The current cohort-mode Pop B apportions k_i across upstream arrival sub-cohorts via `_apportion_rowwise_total`, then draws conditional Binomial per sub-cohort. This uses the upstream arrival model to reinterpret already-observed downstream evidence. The user's diagnosis: "That is exactly upstream x being used to reinterpret observed y." The correct approach: treat frontier survivors as a single pool of N_i - k_i people with uniform exposure a_i, conditioned purely on the local edge CDF.

### The discriminator is not epoch but population type

"B" (the mixed-maturity regime) should not be a special code path. It emerges automatically when summing per-cohort pieces: mature cohorts contribute only A, partially observed cohorts contribute A + D + C, model-only cohorts contribute only the pure model term. D exists iff there is frontier stock. C exists iff there are post-frontier upstream arrivals. The epoch concept is useful for discussion but should not shape the code flow.

### Upstream SDs were initially from wrong edge

Phase 4 originally used the target edge's SDs for upstream perturbation. The user flagged this: "Valid?" Fix: `read_edge_cohort_params` now extracts `mu_sd`, `sigma_sd`, `onset_sd`, `p_sd` per upstream edge from the graph. Each edge uses its own posterior SDs.

### DRIFT_FRACTION belongs in Data > Forecasting Settings

Not in display/chart settings. The user was forceful: "not in the fucking chart settings, in the FORECASTING SETTINGS UNDER THE DATA MENU." It is a modelling parameter, not a display preference.

### Performance: Pop B's double loop

The current cohort-mode Pop B has a double loop: `for s in range(a_idx+1)` × `for tau_idx in range(a_idx+1, T)`. For a_idx=30, T=60, that's ~900 iterations of Binomial draws. The D/C rewrite eliminates this entirely — Pop D is a single vectorised conditional Binomial, no sub-cohort loop.

---

## Relevant Files

### Backend
- **`graph-editor/lib/runner/cohort_forecast.py`** — Core MC fan. The rewrite touches lines ~1055-1211 (x_forecast_arr, Pop B, Pop C, combination, diagnostic). Keep: drift (1004-1017), CDF (1019-1025), IS conditioning (1028-1053), upstream CDF MC (916-980), rate aggregation (1248+).
- **`graph-editor/lib/api_handlers.py`** — Epoch unification done. Threads `COHORT_DRIFT_FRACTION`.

### Frontend
- **`graph-editor/src/services/posteriorSliceResolution.ts`** — `parseDateToMidnightMs` fix.
- **`graph-editor/src/lib/graphComputeClient.ts`** — Tau dedup (~line 552).
- **`graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts`** — Fan polygon rendering.

### Settings
- **`graph-editor/public/schemas/settings-schema.json`** — `forecasting.COHORT_DRIFT_FRACTION`.
- **`graph-editor/public/ui-schemas/settings-ui-schema.json`** — UI for above.

### Tests
- **`graph-editor/lib/tests/test_cohort_forecast.py`** — Red test at line 585. All other tests pass.
- **`graph-editor/lib/runner/test_fixtures/cohort_test_1.json`** — Fixture used by cohort-mode tests.

---

## Next Steps

### 1. Implement D/C state decomposition (IMMEDIATE)

The agreed plan is fully described in the "Key Insight" section above. The rewrite is localised to `cohort_forecast.py` lines ~1055-1211 plus the deterministic midpoint at lines ~1343-1357. The red test is the acceptance criterion.

### 2. Phase 5: Unified simulator

Replace `confidence_bands.py` with the same posterior predictive engine. Zero-evidence output = model band. Makes degeneration exact by construction. Not yet designed in detail.

### 3. Update INDEX.md

`docs/current/project-bayes/cohort-maturity/INDEX.md` is stale — still describes the removed IS approach.

---

## Open Questions

- **Deterministic midpoint alignment**: The midpoint fallback (lines 1359-1367) uses MC median when available but falls back to a deterministic path. After the D/C rewrite, the deterministic fallback should also use the D/C split. Currently uses `x_forecast × posterior_rate` which is the old pattern.
- **Pop D simplification validity**: Treating all N_i frontier survivors as having uniform exposure a_i (ignoring their actual arrival times) is a simplification. It's exact in window mode and a good approximation in cohort mode because the IS conditioning (Phase 3) already accounts for frontier evidence. The sub-cohort refinement could be added later if needed but the user explicitly asked to remove it now.
- **`median X < 1` fallback**: Should remain as safety net after rewrite but ideally never fires. If it does fire in production, that indicates a problem with the upstream CDF computation or the population scaling.
