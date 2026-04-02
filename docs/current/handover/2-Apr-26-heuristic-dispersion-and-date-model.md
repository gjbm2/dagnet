# Handover: Heuristic Dispersion, Date Model Fix, and snapshot_date Rename

**Date:** 2-Apr-26
**Branch:** `feature/snapshot-db-phase0`
**Session context:** Three interconnected changes: (1) fix zone boundary bug in cohort maturity fan chart, (2) rename `as_at_date` to `snapshot_date`, (3) begin implementing heuristic dispersion estimation for the non-Bayes stats pass.

---

## Objective

### Date model fix (DONE)
The cohort maturity fan chart had a bug where rendering zone boundaries (`tau_solid_max`, `tau_future_max`) were derived from query anchor dates instead of actual evidence extent. This caused nonsense rendering when querying outside the fixture/evidence date range — dead zones where nothing rendered, abrupt fan transitions at wrong tau values. The fix derives zone boundaries from per-cohort `tau_observed` values.

### snapshot_date rename (DONE)
The field `as_at_date` on maturity frames was confusingly similar to the `.asat()` query constraint but meant something different (the date of a virtual-snapshot frame). Renamed to `snapshot_date` across the full stack with backward-compatible fallbacks in FE read paths.

### Heuristic dispersion (IN PROGRESS)
The analytic stats pass produces point estimates (mu, sigma, onset, p) with no uncertainty. Downstream consumers (fan chart, confidence bands) need SDs to generate uncertainty envelopes. Currently only the Bayesian pipeline provides these. The goal is to add mathematically grounded heuristic SDs to the stats pass so every edge with a fitted model has uncertainty estimates. When Bayes runs, its posterior SDs replace these entirely.

The user confirmed this should be implemented in **both FE and BE stats passes** (not just at consumption time), following the existing parity architecture.

---

## Current State

### Date model fix — DONE
- **`cohort_forecast.py`**: `tau_solid_max` and `tau_future_max` now derived from `min(tau_observed)` and `max(tau_observed)` across cohorts (line ~697). Separate `tau_chart_extent` variable for chart drawing range (line ~417).
- **`tau_observed` fallback simplified**: When no `evidence_retrieved_at` is provided, falls back to `tau_max` (= sweep_to - anchor_day) instead of the fragile Y-increase heuristic (line ~675).
- **Diagnostic print** `[zone_boundaries]` added for debugging.
- **All 115 cohort tests pass** including the previously-failing degeneration invariant test.
- **Design doc**: `docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md` captures the full date model.

### snapshot_date rename — DONE
- Renamed in 12 files: `cohort_maturity_derivation.py`, `cohort_forecast.py`, `api_handlers.py`, `graphComputeClient.ts`, `analysisExportService.ts`, `fan_test_1.json`, and 6 test files.
- Backward-compatible fallbacks in FE: `f?.snapshot_date || f?.as_at_date || f?.retrieved_at_date || f?.date` in `graphComputeClient.ts:443`.
- `api_handlers.py` reads with fallback: `frame.get('snapshot_date', '') or frame.get('as_at_date', '')` at line 1362.
- Synthetic frame builder emits `"snapshot_date"` (line 1095).
- CSV export columns renamed to `snapshot_date_iso` / `snapshot_date_uk`.

### Heuristic dispersion — IN PROGRESS

#### Phase 1: Type system — DONE
- **`graph_types.py`** (`ModelVarsLatency`): Added `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`, `path_mu_sd`, `path_sigma_sd`, `path_onset_sd` (all Optional).
- **`types/index.ts`** (`ModelVarsEntry.latency`): Same fields added.
- **`statisticalEnhancementService.ts`** (`EdgeLatencyStats`): Added `p_sd`, `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`.
- **`statisticalEnhancementService.ts`** (`EdgeLAGValues.latency`): Added `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`, `p_sd`, `path_mu_sd`, `path_sigma_sd`, `path_onset_sd`.
- **`stats_engine.py`** (`EdgeLatencyStats` dataclass): Added `p_sd`, `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`.
- **`stats_engine.py`** (`EdgeLAGValues` dataclass): Added `p_sd`, `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr`.

#### Phase 2: Computation — DONE (core + FE path propagation)
- **FE** (`statisticalEnhancementService.ts:computeEdgeLatencyStats`): Heuristic SD computation added before return statements (~line 1301). Implements all 5 formulas from design doc section 3.
- **BE** (`stats_engine.py:compute_edge_latency_stats`): Mirror computation added (~line 602).
- **FE path-level SD propagation**: Added `nodePathMuSd`, `nodePathSigmaSd`, `nodePathOnsetSd` DP state maps in `enhanceGraphLatencies`. Propagated at all 4 `nodePathMu.set(toNodeId, ...)` sites (3 skip-through + 1 main computed). Quadrature sum at `EdgeLAGValues` construction site (~line 2879).
- **BE path-level SD propagation**: NOT STARTED — `enhance_graph_latencies` in `stats_engine.py` needs the same treatment.
- **Parity tests**: NOT STARTED — need test vectors for the new SD fields.

#### Phase 3: Write path — NOT STARTED
- `fetchDataService.ts` must write SDs to analytic model_vars entries.
- `bayesPatchService.ts` must write SDs to Bayesian model_vars entries.
- `beTopoPassService.ts` must write SDs to analytic_be model_vars entries.

#### Phase 4: Promotion and read path — NOT STARTED
- `modelVarsResolution.ts` must promote SD fields alongside point values.
- `_read_edge_model_params()` must read SDs from promoted fields when posterior is absent.

#### Phase 5: Chart display gates — NOT STARTED
- `cohortComparisonBuilders.ts:403` — widen `isBayesianPromoted` gate.
- `cohortComparisonBuilders.ts:508` — widen per-source band gate.

#### Phase 6: Generalised ModelCard — NOT STARTED
- Extract shared sub-components from `BayesPosteriorCard`.
- Replace bespoke `RoField` rows in analytic cards.
- Widen `AnalysisInfoCard` gate.

#### Phase 7: Verification — NOT STARTED

---

## Key Decisions & Rationale

### 1. Zone boundaries from tau_observed, not anchor dates
**What:** `tau_solid_max = min(tau_observed)`, `tau_future_max = max(tau_observed)` instead of `sweep_to - anchor_to` / `sweep_to - anchor_from`.
**Why:** The old computation conflated "which cohorts exist" (anchor dates) with "how far they've been observed" (evidence dates). These are independent axes that diverge in at least 3 scenarios: out-of-range fixtures, stale evidence, historical `.asat()` queries.
**Where:** `cohort_forecast.py:697-699` (zone boundaries), `cohort_forecast.py:417` (`tau_chart_extent` for drawing range).

### 2. Simplified tau_observed fallback
**What:** When no `evidence_retrieved_at` is provided, `tau_observed = tau_max` (= sweep_to - anchor_day).
**Why:** The previous Y-increase heuristic broke when Y plateaued (cohort fully converted) — it incorrectly reported evidence stopping before the last frame. Plateau IS evidence.
**Where:** `cohort_forecast.py:675`.

### 3. Heuristic SDs in both stats passes, not at consumption
**What:** Compute heuristic SDs in `computeEdgeLatencyStats` (FE) and `compute_edge_latency_stats` (BE), not in `_read_edge_model_params`.
**Why:** User explicitly confirmed this approach. Both passes maintain parity. SDs flow through model_vars like all other computed values. Consumption points already accept SDs — they just need to be populated.

### 4. Beta-binomial for p_sd, sampling distribution for mu_sd/sigma_sd
**What:** p_sd uses exact Beta posterior SD. mu_sd uses `1.25 * sigma / sqrt(totalK)`. sigma_sd uses `0.87 * sigma / sqrt(totalK)`. onset_sd uses `max(1.0, 0.25 * onset)`. onset_mu_corr fixed at -0.3.
**Why:** p_sd is well-grounded (same model as Bayesian). Latency SDs approximate the sampling variance of the method-of-moments estimator. Onset is heuristic because it's not fitted from the lag distribution. Full derivations in `heuristic-dispersion-design.md` sections 3.1-3.5.
**Where:** FE ~line 1301 in `statisticalEnhancementService.ts`, BE ~line 602 in `stats_engine.py`.

### 5. Quality-gate inflation (2x)
**What:** When `empirical_quality_ok = false`, mu_sd and sigma_sd are multiplied by 2.0.
**Why:** Poor-quality fits (totalK < 30, bad mean/median ratio) should produce visibly wider fans to signal uncertainty.

### 6. sigma_sd uses sigma_moments, not sigma_final
**What:** The SD is computed from the pre-tail-constraint sigma.
**Why:** The tail constraint is a deterministic adjustment, not a source of additional uncertainty. The SD measures uncertainty in the data-derived parameter.

### 7. Output card stays separate from generalised ModelCard
**What:** The generalisation collapses Bayesian + Analytic FE + Analytic BE into one `ModelCard` component, but the manual/Output card keeps its own component.
**Why:** Output card has fundamentally different UX — editable probability slider, blur-to-commit, source flipping on edit. Forcing this into a shared component couples display and editing concerns.

### 8. Spark chart is already source-agnostic
**What:** `BayesModelRateChart` (to be renamed `ModelRateChart`) already accepts point estimates + optional SDs. No source gate.
**Why:** When SDs are null, bands don't render and you get a plain CDF curve. Every source can drive this chart today — the component just needs to be called from more places.

---

## Discoveries & Gotchas

### The `as_at_date` → `snapshot_date` rename was partially reverted by linters
Some files had their renames reverted silently (likely by a formatter or linter). Had to re-apply and verify with `grep`. The `.pyc` cache also caused stale reads — needed `find ... -name '__pycache__' -exec rm -rf` to clear.

### The live parity test (`TestTopoPassLiveFixture::test_live_parity`) is pre-existing failure
15 mismatches on fields like `mu`, `sigma`, `path_t95`, `blended_mean` — all pre-existing on the branch before any changes. The contract parity tests (25 tests with hard-coded vectors) all pass.

### `tau_future_max` was overloaded
It served two roles: (1) epoch B/C rendering boundary, and (2) chart extent (`max_tau`). After the fix, these are separated: `tau_future_max` for rendering, `tau_chart_extent` for drawing range.

### The FE topo pass has 4 separate nodePathMu propagation sites
Three are "skip-through" cases (non-latency edges, already-computed edges, etc.) and one is the main computed path. All 4 need SD propagation.

### `ModelVarsProbability.stdev` already exists
The p_sd slot is already present in model_vars — it just needs to be populated by the stats pass with the Beta posterior SD instead of being zero.

---

## Relevant Files

### Backend (changed)
- **`graph-editor/lib/runner/cohort_forecast.py`** — Zone boundary fix (tau_observed), snapshot_date rename, diagnostic prints.
- **`graph-editor/lib/runner/cohort_maturity_derivation.py`** — snapshot_date rename.
- **`graph-editor/lib/api_handlers.py`** — snapshot_date rename with backward compat fallbacks.
- **`graph-editor/lib/runner/stats_engine.py`** — EdgeLatencyStats + EdgeLAGValues SD fields, heuristic SD computation in `compute_edge_latency_stats`.
- **`graph-editor/lib/graph_types.py`** — ModelVarsLatency SD fields.

### Frontend (changed)
- **`graph-editor/src/services/statisticalEnhancementService.ts`** — EdgeLatencyStats + EdgeLAGValues SD fields, heuristic SD computation in `computeEdgeLatencyStats`, path-level SD propagation in `enhanceGraphLatencies` (4 propagation sites + DP state maps).
- **`graph-editor/src/types/index.ts`** — ModelVarsEntry.latency SD fields.
- **`graph-editor/src/lib/graphComputeClient.ts`** — snapshot_date rename with fallback.
- **`graph-editor/src/services/analysisExportService.ts`** — snapshot_date rename in export columns.

### Tests (changed)
- **`graph-editor/lib/tests/test_cohort_fan_controlled.py`** — snapshot_date rename.
- **`graph-editor/lib/tests/test_cohort_fan_harness.py`** — Passes (39 tests).
- **`graph-editor/lib/tests/test_cohort_forecast.py`** — snapshot_date rename.
- **`graph-editor/lib/tests/test_cohort_maturity_derivation.py`** — snapshot_date rename.
- **`graph-editor/lib/tests/test_graceful_degradation.py`** — snapshot_date rename.
- **`graph-editor/lib/runner/test_fixtures/fan_test_1.json`** — snapshot_date rename.

### Docs (created/updated)
- **`docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md`** — Canonical date model reference.
- **`docs/current/project-bayes/heuristic-dispersion-design.md`** — Full design doc: maths, storage, wiring audit (7 gaps), ModelCard component architecture, phased implementation plan.

### Key files to read (not changed, but essential context)
- **`graph-editor/src/services/modelVarsResolution.ts`** — Promotion cascade. Lines 149-159 need SD promotion (Gap 3).
- **`graph-editor/src/services/fetchDataService.ts`** — FE model_vars write path. Lines ~1692-1733 need SD writing (Gap 2).
- **`graph-editor/src/services/bayesPatchService.ts`** — Bayes model_vars write. Lines 333-346 need SD writing (Gap 2).
- **`graph-editor/src/services/beTopoPassService.ts`** — BE topo pass API caller. Needs SD pass-through.
- **`graph-editor/src/components/ModelVarsCards.tsx`** — Four-card source layout. Analytic cards need `+/- sd` display (Gap 5).
- **`graph-editor/src/components/analytics/BayesPosteriorCard.tsx`** — Rich Bayesian card. Will be generalised into `ModelCard` (Gap 6).
- **`graph-editor/src/components/analytics/AnalysisInfoCard.tsx`** — Edge info tab. Line 169 gates on `posteriorsMeta` — needs widening.
- **`graph-editor/src/services/analysisECharts/cohortComparisonBuilders.ts`** — Chart rendering. Lines 403, 508 gate on Bayesian source (Gap 5).
- **`graph-editor/lib/api_handlers.py:708-945`** — `_read_edge_model_params()`. Needs to read SDs from promoted model_vars when posterior absent (Gap 4).
- **`graph-editor/public/schemas/conversion-graph-1.1.0.json`** — JSON schema missing onset/path SD fields (Gap 7).

---

## Next Steps

### 1. BE path-level SD propagation in `stats_engine.py`
Mirror the FE path-level SD propagation. Find `enhance_graph_latencies` in `stats_engine.py` and add quadrature sum propagation for `mu_sd`, `sigma_sd`, `onset_sd` through the topo pass. Write path-level SDs onto `EdgeLAGValues`. This is the BE equivalent of what was just done in the FE.

### 2. Parity test vectors for SD fields
Extend `test_stats_engine_parity.py` with test vectors that verify FE and BE agree on the new SD fields. Use the `TestTopoPassSynthetic` suite which has controlled synthetic data.

### 3. Phase 3: Write path — model_vars entries
Three write sites need updating:
- `fetchDataService.ts` (~line 1692): When creating analytic model_vars entries, map `EdgeLAGValues.latency.mu_sd` etc. into `ModelVarsEntry.latency.mu_sd`.
- `bayesPatchService.ts` (~line 333): When creating Bayesian model_vars entries, write SDs from patch slices into `model_vars.latency`.
- `beTopoPassService.ts`: When creating analytic_be model_vars entries, include SDs from BE response.

### 4. Phase 4: Promotion and read path
- `modelVarsResolution.ts:149-159`: After promoting point values (`p.latency.mu = result.latency.mu`), also promote SD fields (`p.latency.promoted_mu_sd = result.latency.mu_sd`).
- `api_handlers.py:894-904`: Add fallback path that reads SDs from `p.latency.promoted_*_sd` when `lat_posterior` SDs are absent.

### 5. Phase 5: Chart display gates
- `cohortComparisonBuilders.ts:403`: Change `isBayesianPromoted` check to `hasDispersion` — true when promoted source has band data, regardless of source.
- `cohortComparisonBuilders.ts:508`: Change `srcName === 'bayesian'` to `srcData?.band_upper != null`.

### 6. Phase 6: Generalised ModelCard
- Extract `LatencyParamsGrid` and `ModelRateChart` as shared sub-components from `BayesPosteriorCard.tsx`.
- Make quality footer and actions conditional on props.
- Replace bespoke `RoField` rows in `ModelVarsCards.tsx` analytic cards with `ModelCard`.
- Update `AnalysisInfoCard.tsx:169` gate from "has posterior" to "has model params with latency".
- Output card: reuse shared sub-components but keep own shell.

### 7. Phase 7: JSON schema update
Add missing fields to `conversion-graph-1.1.0.json` `edge.p.latency.posterior`: `onset_mean`, `onset_sd`, `onset_mu_corr`, `path_mu_mean`, `path_mu_sd`, `path_sigma_mean`, `path_sigma_sd`, `path_onset_delta_days`, `path_onset_sd`, `path_onset_mu_corr`.

### 8. Phase 7: Verification
- Visual: Load a non-Bayes edge, verify fan chart and confidence bands render with heuristic dispersion.
- Comparison: Load an edge with both Bayes and analytic, verify Bayesian SDs take precedence.
- Export: Verify CSV includes band values if present.

---

## Open Questions

### Blocking: None currently
All design decisions have been agreed with the user. Implementation is straightforward from here.

### Non-blocking

- **Recency weighting for p_sd**: Should effective sample size use recency-weighted n_eff (matching p_infinity estimation)? Recommended yes, but not yet implemented. See design doc Q1.
- **UI distinction for heuristic vs Bayesian bands**: Agreed subtle visual cue needed. Exact treatment (lighter alpha, "est." label) not yet designed. See design doc Q2.
- **Pre-existing live parity test failure**: 15 mismatches in `TestTopoPassLiveFixture::test_live_parity`. Stale golden fixture. Not related to this work but should be investigated separately.
