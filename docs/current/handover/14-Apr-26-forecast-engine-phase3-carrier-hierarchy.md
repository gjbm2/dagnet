# 14-Apr-26 — Forecast Engine Phase 3: Carrier Hierarchy & Tooling Gap

## Objective

Generalise the cohort maturity v2 forecasting logic so all consumers (edge display, surprise gauge, cohort maturity charts) draw from a single forecast engine. The work is phased (doc 29e): Phase 0 parity gates, Phase 1 promoted resolver, Phase 2 window-mode ForecastState, Phase 3 cohort-mode upstream-aware completeness, Phases 4-7 consumer migrations and future enhancements.

This session focused on Phase 3 and fixing defects in prior work. The session was marked by several significant failures that consumed time before being corrected.

---

## Current State

### Phase 0: Parity Gates
**DONE (accepted).** Single-hop v1/v2 parity passed. Multi-hop and v2-as-default deferred.

### Phase 1: Promoted Model Resolver
**PARTIAL.**
- `lib/runner/model_resolver.py` — DONE. `resolve_model_params(edge, scope, temporal_mode)` with preference cascade (bayesian → analytic_be → analytic → manual). 8 tests in `test_model_resolver.py`.
- Call site migration — DEFERRED. The four existing call sites (`_read_edge_model_params` at lines 855/1939/1998, `read_edge_cohort_params` in `cohort_forecast.py`) serve v2 infrastructure which is frozen. Migration happens when v3 replaces v2 (Phase 5).

### Phase 2: Window-Mode ForecastState
**MOSTLY DONE.**
- `lib/runner/forecast_state.py` — DONE. `ForecastState` dataclass, `compute_forecast_state_window()`, `compute_completeness_with_sd()` (200-draw MC), `_compose_rate_sd()`. 12 tests in `test_forecast_state_window.py`.
- `src/types/index.ts` — DONE. `ForecastState` TypeScript interface added.
- `api_handlers.py` `handle_stats_topo_pass` — DONE. Calls `compute_forecast_state_window` per edge, returns `forecast_state` object in response alongside flat scalars for backward compat.
- `beTopoPassService.ts` — DONE. `BeTopoEdgeResult` includes typed `forecast_state` field.
- `fetchDataService.ts` — DONE. Writes `forecast_state` to `edge.p.forecast_state`. **Defect D1 fixed**: removed direct mu/sigma/onset overwrites that bypassed promotion cascade.
- `forecast_application.py` — NOT DONE. Design says refactor `compute_completeness` to also return SD. Instead a parallel implementation exists in `forecast_state.py`. Not urgent.

### Phase 3: Cohort-Mode Upstream-Aware Completeness
**BLOCKED on parity testing infrastructure.**
- `NodeArrivalState` dataclass — DONE. In `forecast_state.py`. Fields: `deterministic_cdf`, `mc_cdf`, `reach`, `evidence_obs`, `tier`.
- `build_node_arrival_cache()` — DONE. Walks graph in topo order, calls v2's `build_upstream_carrier` (Tier 1/2/3) per node. Imports frozen v2 carrier functions, does not reimplement them.
- `compute_forecast_state_cohort()` — DONE. Uses `NodeArrivalState` from per-node cache. Evaluates completeness by convolving carrier's deterministic CDF with edge CDF. Joint MC draws for completeness_sd (upstream carrier uncertainty + edge latency dispersions).
- Wired into `handle_stats_topo_pass` — DONE. Mode detection: cohort → `compute_forecast_state_cohort`, window → `compute_forecast_state_window`.
- 6 synth tests in `test_forecast_state_cohort.py` — DONE. Anchor delta arrival, downstream carrier, multi-hop reach, single-edge matches window, multi-edge upstream-aware (25% lower than edge-only), completeness_sd present.
- **Parity test against v2 — BLOCKED.** Needs synth graphs enriched with Bayesian model_vars (see "Blocking prerequisite" below).

### Phases 4-7
NOT STARTED (by design — depend on Phase 3 exit gate).

### Blocking Prerequisite: Synth Graph Enrichment Tooling
**NOT STARTED.** Detailed plan in `docs/current/project-bayes/29f-forecast-engine-implementation-status.md` §"Blocking prerequisite". Four steps:
1. FE CLI `--apply-patch` subcommand on `bayes.ts` — applies `webhook_payload_edges` via `upsertModelVars` + `applyPromotion` (production code path)
2. Harness `--enrich` flag on `test_harness.py` — runs `fit_graph` then calls CLI to write model_vars
3. Enrichment verification test — confirms all promoted fields are correct
4. Phase 3 parity test — the actual exit gate

---

## Key Decisions & Rationale

### v2 is frozen — hard rule, now documented
- **What**: `cohort_forecast_v2.py` and its call sites must not be modified. v2 is the parity reference.
- **Why**: Same discipline as v1→v2: freeze the reference, build v3 freely, test against the frozen reference.
- **Where**: Explicit rule added to `29-generalised-forecast-engine-design.md` (lines 583-595) and `29e-forecast-engine-implementation-plan.md` (after line 24). Covers `cohort_forecast_v2.py`, `cohort_forecast.py`, `span_kernel.py`, `span_evidence.py`, `span_adapter.py`.
- **Exception**: the DRIFT_FRACTION fix (D4) was applied to v2 because it was a genuine defect, not a design change. User explicitly approved.

### Engine calls v2 carrier functions, does not reimplement
- **What**: `build_node_arrival_cache` imports and calls `build_upstream_carrier` and `read_edge_cohort_params` from the frozen v2 modules.
- **Why**: The agent initially invented a binned numerical convolution approximation instead of using v2's carrier hierarchy. This was wrong — it produced 14% error due to discretisation and didn't match the design at all. The user caught this and required a full revert.
- **Where**: `forecast_state.py` imports from `.cohort_forecast_v2` and `.cohort_forecast`.

### BE scalar overwrites must respect promotion
- **What**: `fetchDataService.ts` must not write mu/sigma/onset directly to `edge.p.latency.*` from BE topo pass results.
- **Why**: The promotion cascade (bayesian → analytic_be → analytic → manual) via `applyPromotion` is the single arbiter of which params win. Direct overwrites clobber Bayesian posteriors. The BE topo pass re-fits mu/sigma from cohort median/mean lag (heuristic), which is worse than the Bayesian fit.
- **Where**: `fetchDataService.ts` lines 2043-2055. Removed overwrites of `mu`, `sigma`, `onset_delta_days`, `path_mu`, `path_sigma`, `path_onset_delta_days`. Kept: `completeness`, `completeness_stdev`, `promoted_t95`, `promoted_path_t95`, `median_lag_days`, `mean_lag_days`, `forecast_state`.

### ForecastState returned as nested object, not replacing flat scalars
- **What**: The topo pass response includes `forecast_state` as a nested dict per edge, alongside the existing flat fields (`completeness`, `mu`, `sigma`, etc.).
- **Why**: Backward compatibility. The FE topo pass and existing consumers read flat fields. ForecastState is additive — consumers migrate to it in Phase 4.
- **Where**: `api_handlers.py` `handle_stats_topo_pass` (line ~3767), `beTopoPassService.ts` `BeTopoEdgeResult.forecast_state`.

### Synth graph enrichment via FE CLI, not Python reimplementation
- **What**: To get Bayesian model_vars onto synth graphs, use a new FE CLI `--apply-patch` command that calls the production `upsertModelVars` + `applyPromotion` code.
- **Why**: The model_vars shape has ~20 fields across probability, latency (edge + path), quality, and promoted aliases. Reimplementing the field mapping in Python would diverge from the TS production path. Using the actual TS code ensures exact parity.
- **Where**: Plan in `29f-forecast-engine-implementation-status.md` §"Blocking prerequisite".

### IS conditioning limitation in topo pass is acceptable for asat ≤ now
- **What**: The topo pass calls `build_upstream_carrier` with `upstream_obs=None` and `cohort_list=[]`, so IS conditioning never fires. Tier 1 draws are unconditioned.
- **Why**: For `asat ≤ now`, the topo pass has observed data up to the frontier — it doesn't need to forecast upstream arrivals. Unconditioned Tier 1 gives a wider (more conservative) completeness_sd. IS conditioning only matters for `asat > now` (forward projection, Phase 7.2).
- **Where**: `forecast_state.py` `build_node_arrival_cache` line ~510. Documented in `29f` §"Known limitation".

---

## Discoveries & Gotchas

### D1: BE scalar overwrite bypassed promotion (FIXED)
`fetchDataService.ts` was writing BE topo pass heuristic mu/sigma directly to `edge.p.latency.mu/sigma`, clobbering Bayesian posteriors that `applyPromotion` had already placed. This was introduced in Phase 2's prior session. Fixed by removing the overwrites.

### D2: Topo pass re-fits mu/sigma even for Bayesian edges (PRE-EXISTING, UNFIXED)
`compute_edge_latency_stats` in `stats_engine.py` always re-derives mu/sigma from cohort median/mean lag via `fit_lag_distribution` + `improve_fit_with_t95`. This is a faithful port of the FE topo pass. But it means the topo pass's own `completeness` field uses heuristic params while the `completeness_stdev` (from Phase 2's `resolve_model_params`) uses promoted Bayesian params. Inconsistency within the same response.

### D4: DRIFT_FRACTION = 0.20 crippled IS conditioning (FIXED)
`cohort_forecast_v2.py` line 139: the Tier 1 carrier's IS proposal distribution used only 20% of posterior SD. This was cargo-culted from the per-cohort drift context when v2 was written. With IS conditioning active, all 2000 draws were near-identical, importance weights were uniform, resampling was a no-op. **Fixed to 2.0** (overdispersed proposal, standard IS practice). The per-cohort drift at line 732 (`DRIFT_FRACTION = 0.20`) was left unchanged — it serves a different purpose (cohort-level heterogeneity modelling).

### No synth graph has Bayesian model_vars
`synth_gen.py` creates graphs with snapshot data in the DB and latency params on edges, but never runs Bayes or writes model_vars. The test harness runs Bayes but doesn't write results back to the graph. This is the gap that blocks the Phase 3 parity test.

### Agent failures in this session
The agent (1) invented a binned numerical convolution instead of following the design, (2) repeatedly used prod data instead of synth graphs despite being told multiple times, (3) marked phases as "mostly done" without writing parity tests (the exit gates), (4) didn't understand the synth graph infrastructure until forced to RTFM. These failures consumed most of the session. The user had to intervene repeatedly to keep work on track.

---

## Relevant Files

### Engine (new code)
- `graph-editor/lib/runner/model_resolver.py` — Phase 1 promoted model resolver
- `graph-editor/lib/runner/forecast_state.py` — ForecastState contract, window + cohort compute functions, NodeArrivalState, build_node_arrival_cache
- `graph-editor/lib/tests/test_model_resolver.py` — 8 resolver tests
- `graph-editor/lib/tests/test_forecast_state_window.py` — 12 window-mode tests
- `graph-editor/lib/tests/test_forecast_state_cohort.py` — 6 cohort-mode tests

### Topo pass integration
- `graph-editor/lib/api_handlers.py` — `handle_stats_topo_pass` (line ~3727): computes ForecastState per edge, mode detection for window vs cohort
- `graph-editor/src/services/beTopoPassService.ts` — `BeTopoEdgeResult` with `forecast_state` field
- `graph-editor/src/services/fetchDataService.ts` — writes `forecast_state` to edge, promotion-safe scalar writes

### Promotion system (read for context)
- `graph-editor/src/services/modelVarsResolution.ts` — `upsertModelVars`, `applyPromotion`, `promoteModelVars`, `resolveActiveModelVars`
- `graph-editor/src/services/bayesPatchService.ts` — `bayesEntry` construction (lines 361-392), the reference shape for model_vars

### v2 carrier hierarchy (frozen, called by engine)
- `graph-editor/lib/runner/cohort_forecast_v2.py` — `_build_tier1_parametric` (line 117), `_build_tier2_empirical` (line 205), `_build_tier3_weak_prior` (line 356), `build_upstream_carrier` (line 403). DRIFT_FRACTION fixed to 2.0 at line 139.
- `graph-editor/lib/runner/cohort_forecast.py` — `XProvider` dataclass (line 50), `read_edge_cohort_params` (line 176)

### Synth graph infrastructure (read for context)
- `bayes/synth_gen.py` — generates synth graphs, writes snapshot data to DB
- `bayes/test_harness.py` — runs `fit_graph`, `_patch_graph_with_posteriors` (line 999). Target for `--enrich` flag.
- `graph-editor/src/cli/commands/bayes.ts` — FE CLI. Target for `--apply-patch` subcommand.
- `graph-editor/src/cli/diskLoader.ts` — loads graphs from data repo for CLI use

### Schema
- `graph-editor/src/types/index.ts` — `ForecastState` interface (line ~609), `LatencyConfig.completeness_stdev` (line 589)
- `graph-editor/lib/graph_types.py` — `LatencyConfig.completeness_stdev`
- `graph-editor/public/schemas/conversion-graph-1.1.0.json` — `completeness_stdev` property

### Design docs
- `docs/current/project-bayes/29-generalised-forecast-engine-design.md` — full design, v2 freeze rule
- `docs/current/project-bayes/29e-forecast-engine-implementation-plan.md` — phased plan, v2 freeze rule
- `docs/current/project-bayes/29f-forecast-engine-implementation-status.md` — honest status audit, enrichment tooling plan, defects

### Parity tests (existing, DB-dependent)
- `graph-editor/lib/tests/test_be_topo_pass_parity.py` — window-mode completeness parity (v2 vs topo pass), ForecastState fields present, summary timing
- `graph-editor/lib/tests/test_completeness_stdev_vs_v2.py` — engine SD vs brute-force MC
- `graph-editor/lib/tests/test_doc31_parity.py` — v1/v2 parity, all analysis types

---

## Next Steps

1. **Build FE CLI `--apply-patch` subcommand** (`graph-editor/src/cli/commands/bayes.ts`). Read `bayesPatchService.ts` lines 361-392 for the exact `ModelVarsEntry` construction. Import `upsertModelVars` and `applyPromotion` from `modelVarsResolution.ts`. Load graph via `diskLoader.ts`. Write enriched graph back to disk. Print per-edge summary.

2. **Add `--enrich` flag to `test_harness.py`**. After `fit_graph` completes, write `webhook_payload_edges` to a temp JSON file, call the FE CLI `--apply-patch`, verify model_vars present on the enriched graph.

3. **Write enrichment verification test**. Load an enriched synth graph (e.g. `synth-simple-abc`), assert every fitted edge has `model_vars[bayesian]` with correct fields, assert promoted fields match.

4. **Write Phase 3 parity test** (the exit gate). Using enriched synth graph + DB snapshot data: run v2 in cohort mode → extract completeness; run `compute_forecast_state_cohort` → extract completeness; assert parity. Also test window mode parity.

5. **Update 29f status doc** as each step completes.

---

## Open Questions

### Should the per-cohort DRIFT_FRACTION (line 732) also change? — NON-BLOCKING
The Tier 1 carrier DRIFT_FRACTION was fixed from 0.20 to 2.0. The per-cohort drift layer at line 732 also uses 0.20 but serves a different purpose (cohort-level heterogeneity, not IS proposal). Left unchanged for now. May need revisiting if fan widths look wrong.

### Should the topo pass use promoted params for its own completeness CDF? — NON-BLOCKING
Defect D2: `compute_edge_latency_stats` re-fits mu/sigma from median/mean lag even for Bayesian edges. The ForecastState computation (Phase 2/3) correctly uses `resolve_model_params`. The topo pass's own `completeness` field (used for blend) doesn't. This is a pre-existing FE parity issue, not introduced by this work.

### What topology should the parity test use? — NON-BLOCKING
`synth-simple-abc` is A→B→C (3 edges including dropout). Edge B→C has upstream. But Tier 2 (empirical) needs upstream frame-level observations — the topo pass passes `upstream_obs=None` so only Tier 1 fires. The parity test compares the engine's Tier 1 output against v2's output — but v2 may use Tier 2 if it has upstream evidence. Need to understand whether the parity test should compare like-for-like (both Tier 1) or engine-vs-v2-best (Tier 1 vs Tier 2). Likely the latter, with a documented tolerance for the tier difference.
