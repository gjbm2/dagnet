# Analysis Forecasting: Implementation Plan

**Status**: In progress (11-Feb-26). Phases 1–8 complete. Parallel-run tested and debugged. Defects 1–2, 5–8 fixed. Defect 3 was not a defect. Defect 4 (DB coverage gap) is minor and not a blocker. **Remaining**: small MECE union aggregation mismatch (mu Δ≈0.016, sigma Δ≈0.037 in multi-slice case). Flag is ON for monitoring. Next: investigate MECE aggregation parity, then soak (Phase 9).  
**Parent**: `analysis-forecasting.md` (design/architecture)  
**Approach**: Parallel-run migration (§7.0 of design doc)

This plan lists every file touched, in dependency order. Update as work proceeds.

**User impact**: Phases 1–8 must have **zero user-visible impact**. All new behaviour (auto-recompute after fetch, parallel-run comparison, model persistence on graph edges) is gated behind a feature flag (`FORECASTING_PARALLEL_RUN`, default `false`). With the flag off, the new code exists but is dormant. The flag is enabled only when we are ready to enter Phase 9 (soak in production).

---

## Phase 1: Python Pure Maths Library + Golden Tests — DONE (10-Feb-26)

**Goal**: Port `lagDistributionUtils.ts` to Python with numerical parity. No runtime changes. No API changes. Foundation for everything else.

**Depends on**: Nothing.

### Files created

- `lib/runner/lag_distribution_utils.py` — pure maths functions: `erf`, `standard_normal_cdf`, `standard_normal_inverse_cdf`, `log_normal_cdf`, `log_normal_inverse_cdf`, `log_normal_survival`, `fit_lag_distribution`, `to_model_space`. Zero imports outside stdlib + `math`. No file reads, no DB access, no service dependencies.

- `lib/tests/fixtures/lag-distribution-golden.json` — golden test vectors: inputs and expected outputs for every function listed above. Values extracted from the existing TS golden test (`lagDistribution.golden.test.ts`) plus additional edge cases (negative inputs, boundary conditions, quality gate failures, onset clamping).

- `lib/tests/test_lag_distribution_parity.py` — Python tests consuming the golden fixture. Must assert numerical parity with TS to within documented tolerances. Each function tested independently. Include edge cases: zero inputs, negative values, NaN/Inf guards, quality gate boundary (totalK at/below threshold), onset delta exceeding all values.

### Files modified

- `src/services/__tests__/lagDistribution.golden.test.ts` — extend to consume the same golden fixture values (currently uses inline values). This ensures both languages are locked to identical expectations. The fixture file lives in `lib/tests/fixtures/` (Python side); the TS test can reference it via a relative path at test time.

### Tests (Phase 1)

- Python: every function in `lag_distribution_utils.py` tested against golden fixture (target: 30+ test vectors covering all functions, edge cases, and quality gate boundaries)
- TS: existing golden tests extended to use the shared fixture values
- Cross-language parity: both test suites assert identical outputs for identical inputs to within tolerance (1e-9 for CDF values, 1e-12 for mu/sigma from fitting)

---

## Phase 2: Forecasting Settings Module — DONE (10-Feb-26)

**Goal**: Python can receive, validate, and hash a `forecasting_settings` object. No API changes yet.

**Depends on**: Phase 1 (uses constants defined here as defaults).

### Files created

- `lib/runner/forecasting_settings.py` — defines `ForecastingSettings` dataclass with all fields from design doc §4.5 (fitting settings: `min_fit_converters`, `min_mean_median_ratio`, `max_mean_median_ratio`, `default_sigma`, `recency_half_life_days`, `onset_mass_fraction_alpha`, `onset_aggregation_beta`; application settings: `t95_percentile`, `forecast_blend_lambda`, `blend_completeness_power`). Defines default values matching `src/constants/latency.ts`. Provides `from_dict()` constructor (merges request-supplied values over defaults) and `compute_settings_signature()` (deterministic hash of the settings object).

- `lib/tests/test_forecasting_settings.py` — tests: construction from dict, missing fields use defaults, signature is deterministic, signature changes when any field changes, all defaults match TS constants.

### Files modified

- `src/constants/latency.ts` — add an exported function `buildForecastingSettings()` that bundles the relevant constants into a plain object matching the `forecasting_settings` wire format. This is the single choke-point for constructing the settings object that the frontend sends in API requests.

- `src/types/index.ts` (or `src/lib/graphComputeClient.ts`) — add `ForecastingSettings` TypeScript interface matching the wire format.

### Tests (Phase 2)

- Python: settings construction, defaults, signature determinism, signature sensitivity
- Cross-language: a parity test asserting every Python default value equals the corresponding TS constant value

---

## Phase 3: Model Fitter — DONE (10-Feb-26)

**Goal**: Python can query snapshot DB evidence and produce fitted model params (`mu`, `sigma`, plus provenance metadata) for a given subject. No API route yet — library only.

**Depends on**: Phase 1 (maths), Phase 2 (settings).

### Files created

- `lib/runner/lag_model_fitter.py` — given a set of snapshot rows (per anchor_day: X, Y, median_lag_days, mean_lag_days, onset_delta_days, retrieved_at) and a `ForecastingSettings` object, fits a lognormal lag model. Implements: evidence selection (latest `retrieved_at` per anchor_day), recency weighting, quality gates, onset aggregation, and returns a result dict with: `mu`, `sigma`, `onset_delta_days`, `t95_days` (derived), `model_trained_at` (UK date), plus transient provenance fields (training_window, settings_signature, quality_ok, total_k, notes) which are returned by the API but not persisted on the graph.

- `lib/tests/test_lag_model_fitter.py` — tests with constructed snapshot row sets: typical fit (sufficient data, quality OK), insufficient converters (quality gate fails), mean/median ratio out of bounds, recency weighting effect (recent anchor_days weighted higher), onset delta aggregation, missing mean (falls back to default sigma), empty evidence (returns quality_ok=false with conservative defaults).

### Files modified

- `lib/snapshot_service.py` — may need a helper query to retrieve evidence rows for fitting (anchor range, slice keys, latest-per-anchor-day). Check whether existing `query_snapshots` suffices or a dedicated `query_fitting_evidence` is cleaner.

### Tests (Phase 3)

- Unit tests for fitter with constructed row sets (no DB dependency)
- Integration test with real DB (if available): insert known rows, fit, assert model params

---

## Phase 4: Forecast Application (Completeness + Projections) — DONE (10-Feb-26)

**Goal**: Python can evaluate completeness per anchor_day and produce evidence/forecast split outputs given a fitted model.

**Depends on**: Phase 1 (maths), Phase 2 (settings).

### Files created

- `lib/runner/forecast_application.py` — given fitted model params (mu, sigma, onset_delta_days) and a set of data points (anchor_day, retrieved_at, X, Y), computes per-point: `completeness` (via `log_normal_cdf` on model-space age), `layer` classification (evidence vs forecast), `projected_y` (Y / max(completeness, epsilon)), `evidence_y`, `forecast_y`. Also: blended projection using baseline rate + blend lambda if `ForecastingSettings` supplied.

- `lib/tests/test_forecast_application.py` — tests: mature cohort (completeness near 1.0, layer = evidence), immature cohort (completeness < 0.95, layer includes forecast), very young cohort (completeness near 0), onset delta shifts age correctly, projected_y is Y/completeness, blended projection with known baseline, edge case: completeness = 0 (clamped to epsilon).

### Files modified

- `lib/runner/cohort_maturity_derivation.py` — extend to accept optional model params (mu, sigma, onset_delta_days) and `ForecastingSettings`; when present, annotate each frame's data points with `completeness`, `layer`, `projected_y`, `evidence_y`, `forecast_y`.

- `lib/runner/daily_conversions_derivation.py` — same completeness annotation for daily conversion data points.

- `lib/runner/histogram_derivation.py` — assess whether completeness annotation is meaningful here (likely not for lag histograms; document decision).

### Tests (Phase 4)

- Unit tests for forecast_application with constructed data
- Integration test: extend existing cohort maturity derivation tests to verify completeness fields appear when model is provided
- Integration test: verify completeness fields are absent when model is not provided (backward compatibility)

---

## Phase 5: Recompute API Route — DONE (10-Feb-26)

**Goal**: Frontend can call `/api/lag/recompute-models` to get fitted models for a set of subjects.

**Depends on**: Phase 3 (fitter), Phase 2 (settings).

### Files created

- `lib/runner/types.py` — extend with `RecomputeModelsRequest` and `RecomputeModelsResponse` Pydantic models matching design doc §5.2/§5.3.

### Files modified

- `lib/api_handlers.py` — new handler function `handle_lag_recompute_models(data)`. Accepts `workspace`, `subjects`, `training_anchor_from/to`, `forecasting_settings`. For each subject: queries DB evidence, calls fitter, returns fitted params (mu, sigma, onset_delta_days, t95_days, model_trained_at) plus transient provenance. Validate `forecasting_settings` is present (required, not optional).

- `dev-server.py` — register `@app.post("/api/lag/recompute-models")` route pointing to the new handler.

- `api/python-api.py` — add path dispatch for `/api/lag/recompute-models` in `do_POST()`.

- `src/services/snapshotWriteService.ts` (or new file `src/services/lagRecomputeService.ts`) — frontend API client function `recomputeLagModels(params)` that calls the new route with `forecasting_settings` from `buildForecastingSettings()`.

### Tests (Phase 5)

- Python handler test: mock DB, call handler with test subjects and settings, verify response shape includes mu, sigma, onset_delta_days, t95_days, model_trained_at, quality_ok
- Python handler test: missing `forecasting_settings` returns 400
- Python handler test: subject with no DB evidence returns quality_ok=false
- Frontend: verify client function constructs correct request shape with settings

---

## Phase 6: Analysis Response Enrichment — DONE (10-Feb-26)

**Goal**: Analysis responses (cohort maturity, daily conversions) include completeness and layer fields when a model is available.

**Depends on**: Phase 4 (application), Phase 5 (model availability).

**User impact**: None. Completeness annotation only fires when `mu`/`sigma` are present on the graph edge's latency config. Since Phase 7 (which writes these fields) is gated behind `FORECASTING_PARALLEL_RUN`, they don't exist until the flag is enabled. This phase is naturally dormant.

### Files modified

- `lib/api_handlers.py` — in `_handle_snapshot_analyze_subjects`, after retrieving snapshot data and before returning, check whether the scenario graph edge (located via `target.targetId`) has `mu` and `sigma` on its latency config. If present, pass them (plus `onset_delta_days`) to the derivation function for completeness annotation.

- `lib/graph_types.py` — extend `LatencyConfig` Pydantic model with optional `mu`, `sigma`, and `model_trained_at` fields (flat scalars, not a nested object).

- `src/types/index.ts` — extend `LatencyConfig` TypeScript interface with matching `mu?`, `sigma?`, `model_trained_at?` fields.

- `src/lib/graphComputeClient.ts` — update `normaliseSnapshotCohortMaturityResponse` and `normaliseSnapshotDailyConversionsResponse` to pass through `completeness`, `layer`, `projected_y`, `evidence_y`, `forecast_y` fields from backend responses to the normalised data rows.

- `public/param-schemas/parameter-schema.yaml` — add `mu`, `sigma`, `model_trained_at` field definitions under the latency section.

### Files modified (analysis request)

- `src/lib/graphComputeClient.ts` — extend `AnalysisRequest` / `SnapshotAnalysisRequest` interface to include optional `forecasting_settings`.

- `src/components/panels/AnalyticsPanel.tsx` — when constructing analysis requests, include `forecasting_settings` from `buildForecastingSettings()`. Only when the analysis type has a `snapshotContract` (existing gate).

### Tests (Phase 6)

- Python: cohort maturity derivation with mu/sigma present produces completeness fields
- Python: cohort maturity derivation without mu/sigma omits completeness fields (backward compat)
- Python: daily conversions derivation with mu/sigma present produces completeness fields
- Frontend: normalisation functions pass through completeness fields when present
- Frontend: normalisation functions work unchanged when completeness fields are absent

---

## Phase 7: Persistence (mu/sigma on Graph) — DONE (10-Feb-26, sync + schema only; gated trigger wiring deferred to Phase 8)

**Goal**: Fitted models are persisted on graph edges AND parameter files (via the existing graph↔file push/pull) so they survive across sessions, are committed to git, and are available offline and in shared/cloned workspaces.

**Depends on**: Phase 5 (recompute API returns models), Phase 6 (types defined).

**Gating**: All persistence triggers (auto after fetch, manual action) are gated behind `FORECASTING_PARALLEL_RUN`. With the flag off (default), no recompute calls are made, no mu/sigma is written to graph edges, and the user sees no change whatsoever.

### Files modified

- `src/services/` (new or existing service, e.g. `lagRecomputeService.ts`) — after calling the recompute API and receiving fitted params, apply them to the graph: set `edge.p.latency.mu`, `.sigma`, `.model_trained_at` for each subject. Mark the graph as dirty. The existing graph→file push mechanism will then sync these fields to the parameter file's latency section (alongside t95, median_lag_days, etc.). This is an explicit user action (or post-fetch trigger), not automatic on every DSL change. Entire call gated by `FORECASTING_PARALLEL_RUN`.

- `src/services/dataOperationsService.ts` (or UpdateManager) — ensure `mu`, `sigma`, `model_trained_at` are included in the graph→file field sync for latency config. They must be pushed to the parameter file and pulled back, same as `t95` and other latency fields.

- `src/services/dataOperationsService.ts` — in the post-fetch workflow (after `appendSnapshots` succeeds), if `FORECASTING_PARALLEL_RUN` is enabled, call the recompute API for affected subjects and apply results to the graph. This is the "automatic" trigger from design doc §7.3. When flag is off, this codepath is skipped entirely.

- `src/components/` (menu or toolbar entry) — "Recompute lag models" manual action. Only visible/enabled when `FORECASTING_PARALLEL_RUN` is on. Calls the recompute service for all latency-enabled edges.

### Tests (Phase 7)

- Integration test: after calling recompute, graph edge has mu, sigma, model_trained_at with expected values
- Integration test: mu/sigma/model_trained_at survive serialisation/deserialisation (YAML round-trip)
- Integration test: mu/sigma/model_trained_at are pushed to parameter file and pulled back correctly (graph↔file sync)

---

## Phase 8: Parallel-Run Comparison — DONE (10-Feb-26)

**Goal**: Both FE and BE compute models and completeness. Frontend compares and emits diagnostics on mismatch.

**Depends on**: Phases 1–7 all complete.

**Gating**: Entirely gated by `FORECASTING_PARALLEL_RUN`. With the flag off, no comparison runs, no extra API calls, no session log entries.

### Files created

- `src/services/forecastingParityService.ts` — comparison service. Accepts FE model params (from the existing topo/LAG pass) and BE model params (from the recompute API response). Compares mu, sigma, onset_delta_days, t95_days per subject. Emits diagnostic errors to session log and console on mismatch beyond tolerance. Accepts completeness arrays for per-anchor-day comparison. Gated by a flag (`FORECASTING_PARALLEL_RUN`).

### Files modified

- `src/services/statisticalEnhancementService.ts` — after the existing topo/LAG pass produces FE models, if `FORECASTING_PARALLEL_RUN` is enabled, call the recompute API and invoke `forecastingParityService` with both result sets.

- `src/lib/graphComputeClient.ts` — after receiving an analysis response with completeness fields, if `FORECASTING_PARALLEL_RUN` is enabled, also compute completeness locally from FE model params and invoke `forecastingParityService` for per-anchor-day comparison.

### Tests (Phase 8)

- Unit test: parity service with identical FE and BE values produces no errors
- Unit test: parity service with values differing beyond tolerance produces session log error with expected diagnostic fields (subject_id, field, FE value, BE value, delta, tolerance)
- Unit test: parity service with values differing within tolerance produces no errors
- Unit test: offline fallback — BE result is null/undefined, no comparison fires
- Unit test: completeness comparison per anchor_day with mismatched values emits diagnostic with anchor_day detail

---

## Phase 8.5: Fix Parity Defects (discovered 10-Feb-26)

**Goal**: Fix the three defects surfaced by the first parallel-run test. Until these are fixed, the parity comparison produces false mismatches and the flag must remain off.

### Defect 1: BE queries wrong slice (broad instead of window-only) — FIXED (10-Feb-26)

The `runParityComparison` in `lagRecomputeService.ts` was sending `slice_keys: ['']` (broad = all slices). Fixed to send the correct window slice key (e.g. `window(6-Sep-25:10-Feb-26)`) derived from the parameter file's window value entry.

### Defect 2: BE uses wrong anchor range — FIXED (10-Feb-26)

The parity comparison was picking `window_from`/`window_to` from whichever value entry has a `query_signature` first — which might be the cohort entry. Fixed to explicitly select the window value entry (where `sliceDSL` starts with `window(`) and use its `window_from`/`window_to`. Also fixed UK date → ISO conversion (was using `new Date()` which can't parse `d-MMM-yy`; now uses `parseUKDate`).

### Defect 3: FE recency weighting — NOT A DEFECT

Investigated (10-Feb-26): the FE's `aggregateLatencyStats` in `windowAggregationService.ts` (line 2419) DOES apply recency weighting via `computeRecencyWeight(cohort.age, recencyHalfLifeDays)`. Both FE and BE use the same `k × recency_weight` formula. This is aligned.

### Finding 4: Snapshot DB has a historical coverage gap (minor, not the root cause)

The DB is missing 36 days of pre-12-Oct-25 data across all params (DB starts at 12-Oct-25; parameter files go back to 6-Sep-25). This is a one-time gap from before the DB shadow-write was enabled. It affects all four `gm-*` params equally.

**However, this is NOT the root cause of the parity mismatches.** With recency weighting (half-life 30 days), data from Sep–Oct 2025 would have negligible weight. The delta from missing old data would be tiny.

### Defect 5: Parity comparison sends the wrong anchor range — THE ACTUAL ROOT CAUSE

**Discovered 10-Feb-26.** This is the real reason for the large mu/sigma deltas.

The FE topo pass does NOT fit from the full window range. It fits from a **query-scoped cohort window** — typically the last ~30 days. The parity comparison was sending the **full window range** (158 days) to the BE.

**Evidence:**

| | FE topo pass | BE parity comparison |
|---|---|---|
| **Anchor range** | 11-Jan-26 to 9-Feb-26 (30 days) | 6-Sep-25 to 10-Feb-26 (158 days) |
| **Edge 7bb83fbf K** | 359 | 2177 |
| **Edge 97b11265 K** | 139 | 2323 |

The FE fits from 30 recent cohorts. The BE fits from 122+ historical days. Completely different sample sizes, completely different aggregate lag moments, completely different mu/sigma. The mismatches are not a code bug or a data bug — they are an **input mismatch** in the parity comparison.

**Fix required:** The parity comparison must send the same anchor range the FE used. The FE's effective cohort window (`2026-01-11 to 2026-02-09` in this case) is determined by the query DSL and the LAG pass's window scoping logic. Options:

1. **Store the effective anchor range on the graph edge** alongside mu/sigma (e.g. `latency.model_anchor_from`, `latency.model_anchor_to`). The parity comparison reads it and sends it to the BE. Clean, explicit, survives across sessions.

2. **Derive the anchor range from the current query DSL** in the parity comparison. The FE topo pass uses a scoped window; the parity service could apply the same scoping logic. More complex, duplicates logic.

3. **Pass the FE's aggregate values directly to the BE** instead of having the BE re-aggregate from DB. The BE receives `(median_lag=X, mean_lag=Y, total_k=Z, onset=W)` and just calls `fit_lag_distribution`. This tests fitting parity only, not aggregation parity. Simplest for a first parity pass.

**Recommendation:** Option 1 for proper parity testing (store anchor range, send to BE, verify end-to-end). Option 3 as a quick win to verify the pure fitting function is identical.

### Files fixed (10-Feb-26)

- `src/services/lagRecomputeService.ts` — fixed subject construction (defects 1 + 2), added `parseUKDate` for date conversion, added diagnostic logging to `FORECASTING_PARITY_START`
- `lib/api_handlers.py` — added diagnostic print for incoming recompute subjects

### Defect 6: BE uses graph-edge onset instead of FE's fitting onset — FIXED (11-Feb-26)

**Root cause**: The FE topo pass derives onset from window() histogram data (`edgeOnsetDeltaDays`). The BE was reading `onset_delta_days` from the graph edge, which can be stale (from a previous topo pass or a user override the FE fitting does not consume). When the edge's onset differs from the FE's fitting onset, mu differs by exactly the onset delta.

**Evidence**: Production log showed FE onset=4, BE onset=0, mu delta=0.33 (explained entirely by the 4-day onset difference).

**Fix**: The parity comparison now sends the FE's onset explicitly per subject. It checks whether the parameter file's window() slices have onset data (mirroring the topo pass logic): if yes, reads `lat.onset_delta_days` from the edge (which the topo pass wrote); if no, sends 0 (matching the FE's fallback). The BE reads onset from the subject request, not from the graph edge.

**Files**: `src/services/lagRecomputeService.ts` (send explicit onset per subject), `lib/api_handlers.py` (read onset from subject, not graph edge)

**Noted FE inconsistency** (not fixed; logged in TODO.md): When the topo pass can't compute onset from window data, it writes `undefined` to `edgeLAGValues`, so the UpdateManager skips the write and the edge retains a stale onset_delta_days that's inconsistent with the mu just computed. This doesn't affect the FE's internal computation (which is self-consistent within the topo pass) but leaves the stored edge in an inconsistent state for downstream consumers.

### Defect 7: BE missing mean-fallback-to-median — FIXED (11-Feb-26)

**Root cause**: The FE's `aggregateLatencyStats` falls back to median when mean is missing/zero: `wk * (cohort.mean_lag_days || cohort.median_lag_days || 0)`. The BE's `aggregate_evidence` only included rows with valid positive mean, with no fallback.

**Fix**: Both `select_latest_evidence` (per-row aggregation across slices) and `aggregate_evidence` (across anchor days) now replicate the FE fallback: when `mean_lag_days` is None/≤0 but `median_lag_days > 0`, use median as the mean contribution.

**Files**: `lib/runner/lag_model_fitter.py`

### Defect 8: BE uses raw total_k for quality gate, FE uses recency-weighted — FIXED (11-Feb-26)

**Root cause**: The FE uses `totalKForFit = sum(c.k * computeRecencyWeight(c.age, halfLife))` for the quality gate in `fitLagDistribution`. The BE was using raw `total_k = sum(ev.y)`. With half-life 30 days and older cohort data, the recency-weighted K can drop below the 30-converter threshold while raw K stays well above. This flips the quality gate, causing completely different t95 computation paths (FE uses authoritative fallback; BE computes from fit).

**Fix**: `aggregate_evidence` now returns `total_k_recency_weighted` alongside raw `total_k`. The recency-weighted value is passed to `fit_lag_distribution` for the quality gate, and used in the `FitResult.total_k` field. Also added quality-gate-aware t95 fallback: when `empirical_quality_ok` is false, the BE uses `t95_constraint` (authoritative) directly instead of computing from the fit, matching FE behaviour.

**Files**: `lib/runner/lag_model_fitter.py`

### Remaining: MECE union aggregation mismatch (11-Feb-26)

Small mu/sigma deltas (mu Δ=0.016, sigma Δ=0.037) persist in the MECE multi-slice test case. Onset and quality-gate fixes resolved the single-slice case fully. The MECE mismatch likely involves how the FE and BE combine data from multiple context slices — further investigation needed.

### Files fixed (11-Feb-26)

- `src/services/lagRecomputeService.ts` — explicit onset per subject (defect 6), `onset_delta_days` added to `RecomputeSubject` interface
- `lib/api_handlers.py` — read onset from subject request instead of graph edge (defect 6)
- `lib/runner/lag_model_fitter.py` — mean fallback to median (defect 7), recency-weighted K for quality gate (defect 8), quality-gate-aware t95 fallback (defect 8)
- `src/services/__tests__/forecastingParity.queryFlow.snapshotDb.integration.test.ts` — load parameter/context files from local data repo via `.private-repos.conf` (replaces non-existent graph-bundles path)

---

## Phase 9: Soak in Production

**Goal**: Run in parallel-run mode in production. Investigate and fix any parity mismatches.

**Depends on**: Phase 8.5 defects fixed.

### No new files

This is an operational phase. Monitor session logs and console logs for parity diagnostic errors. For each mismatch:
- Diagnose root cause (FP precision, policy difference, evidence selection divergence, onset handling difference)
- Fix in Python or TS as appropriate
- Re-run parallel comparison until clean

### Exit criteria

- Zero parity mismatches across a representative workload (multiple graphs, multiple analysis types, multiple scenario configurations) over a sustained period (target: 1 week).

---

## Phase 10: Cutover

**Goal**: Frontend stops computing models/completeness. Backend is authoritative.

**Depends on**: Phase 9 exit criteria met.

### Files modified

- `src/services/statisticalEnhancementService.ts` — disable the fitting codepath in the topo/LAG pass. The FE now reads `mu`/`sigma` from the graph edge (persisted by the recompute workflow) and uses them for display only. Remove the FE-side `fitLagDistribution` calls.

- `src/services/forecastingParityService.ts` — remove or disable (the comparison layer is no longer needed).

- `src/constants/latency.ts` — `FORECASTING_PARALLEL_RUN` flag set to `false` or removed.

### Tests (Phase 10)

- Verify analysis results with completeness still render correctly with FE fitting disabled
- Verify offline behaviour: when backend is unreachable, frontend displays graph with persisted mu/sigma values (no fitting, no completeness — graceful degradation)

---

## Phase 11: Cleanup

**Goal**: Remove frontend fitting/application codepaths. Reduce code surface area.

**Depends on**: Phase 10 confirmed stable.

### Files modified

- `src/services/statisticalEnhancementService.ts` — remove fitting orchestration code. This file is currently ~3200 lines; a significant portion can be deleted. Retain only functions needed for display (e.g. `calculateCompleteness` from a persisted model for UI rendering, if needed).

- `src/services/lagDistributionUtils.ts` — assess which functions are still called after fitting is removed. Remove those that are not. If all are unused, delete the file entirely.

- `src/services/forecastingParityService.ts` — delete entirely.

- `src/constants/latency.ts` — remove fitting-only constants that are no longer used by any frontend code. Retain `buildForecastingSettings()` (still needed for API requests).

### Tests (Phase 11)

- Full test suite passes with reduced code
- No references to removed functions remain (checked by build + lint)

---

## Summary: File Impact Matrix

### Python — new files (7)
- `lib/runner/lag_distribution_utils.py`
- `lib/runner/forecasting_settings.py`
- `lib/runner/lag_model_fitter.py`
- `lib/runner/forecast_application.py`
- `lib/tests/test_lag_distribution_parity.py`
- `lib/tests/test_forecasting_settings.py`
- `lib/tests/test_lag_model_fitter.py`
- `lib/tests/test_forecast_application.py`
- `lib/tests/fixtures/lag-distribution-golden.json`

### Python — modified files (5)
- `lib/api_handlers.py` (new route handler)
- `lib/graph_types.py` (mu, sigma, model_trained_at on LatencyConfig)
- `lib/runner/cohort_maturity_derivation.py` (completeness annotation)
- `lib/runner/daily_conversions_derivation.py` (completeness annotation)
- `lib/runner/types.py` (request/response models)
- `dev-server.py` (route registration)
- `api/python-api.py` (route dispatch)

### TypeScript — new files (2)
- `src/services/forecastingParityService.ts` (temporary; removed in Phase 11)
- `src/services/lagRecomputeService.ts` (or integrated into existing service)

### TypeScript — modified files (8)
- `src/types/index.ts` (mu, sigma, model_trained_at on LatencyConfig; ForecastingSettings type)
- `src/constants/latency.ts` (buildForecastingSettings)
- `src/lib/graphComputeClient.ts` (request types, response normalisation)
- `src/components/panels/AnalyticsPanel.tsx` (forecasting_settings in request)
- `src/services/statisticalEnhancementService.ts` (parallel-run, then cutover/cleanup)
- `src/services/lagDistributionUtils.ts` (golden test extension, then cleanup)
- `src/services/snapshotWriteService.ts` (or new service — recompute API client)
- `src/services/dataOperationsService.ts` (post-fetch recompute trigger)

### Shared / config (2)
- `lib/tests/fixtures/lag-distribution-golden.json`
- `public/param-schemas/parameter-schema.yaml` (mu, sigma, model_trained_at fields)

### Test files (10+)
- `lib/tests/test_lag_distribution_parity.py`
- `lib/tests/test_forecasting_settings.py`
- `lib/tests/test_lag_model_fitter.py`
- `lib/tests/test_forecast_application.py`
- `src/services/__tests__/lagDistribution.golden.test.ts` (extended)
- `src/services/__tests__/forecastingParityService.test.ts`
- Additional integration tests in existing cohort maturity / daily conversions test files
