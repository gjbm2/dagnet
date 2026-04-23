# Project Bayes — Document Index

**Last updated**: 23-Apr-26
**Verified against codebase**: 20-Apr-26

For sequencing, priorities, and current status snapshot, see
[programme.md](programme.md).

**Single curated list of open work**: [programme.md §Open items (curated)](programme.md#open-items-curated).
Every doc below may contain stale claims; the curated list in programme.md
is the source of truth for what is actually open, verified against live
code on 18-Apr-26. Individual doc status columns are kept for navigation,
not for sequencing.

---

## Active docs (not yet fully implemented)

| # | File | Status | What's built | What's not |
|---|------|--------|-------------|------------|
| 1 | [1-cohort-completeness-model-contract.md](1-cohort-completeness-model-contract.md) | **Partial** | `query_mode` threading, completeness via `bind_evidence` | Named `_resolve_completeness_params()`, `completeness_model` per-subject object |
| 7 | [7-asat-analysis-completion.md](7-asat-analysis-completion.md) | **Partial** | Snapshot routing, `_asat_retrieved_at` annotation, integration test | Typed `asat_date` on AnalysisResult, chart subtitle/badge |
| 8 | [8-compiler-implementation-phases.md](8-compiler-implementation-phases.md) | **Partial** | Phase A (Beta+Binomial), B (Dirichlet), S (snapshot evidence), D (latent latency+onset), C (slice routing + per-slice Dirichlet emission + per-slice posterior extraction) | Phase E not started |
| 10 | [10-topology-signatures.md](10-topology-signatures.md) | **Design only** | Fingerprint field on `TopologyAnalysis` for cache identity | Per-fit-unit staleness detection, UI surfacing, warm-start invalidation |
| 13 | [13-model-quality-gating-and-preview.md](13-model-quality-gating-and-preview.md) | **Partial** | Quality tiers (failed/warning/good-0..3), `computeGraphQualityTier()`, progress indicator | Accept/reject preview workflow (sections 2-3) |
| 14 | [14-phase-c-slice-pooling-design.md](14-phase-c-slice-pooling-design.md) | **Partial** (14-Apr-26) | DSL parsing (`slices.py`), `SliceGroup` routing (`evidence.py`), per-slice hierarchical emission for **single-dimension** graphs (solo: logit-Normal + τ; BG: Dirichlet + κ), per-slice posterior extraction (`inference.py`), per-date regime filtering in binder, `bayesEngorge.ts` wired. Tested via `test_model_wiring.py`, `test_snapshot_e2e.py`, `test_param_recovery.py` | **Multi-dimension gaps (§15A.2)**: (1) single τ across all dims — should be per-dimension; (2) 1/N κ correction not implemented; (3) no multi-dim synth graphs (R2g untested); (4) `conditional_p` not emitted; (5) subsumption hierarchy not implemented. **Proposed**: `per_slice_latency` context flag (§15A.3) to gate per-slice latency RVs per dimension. No dedicated Phase C test suite. Per-slice FE visualisation not started |
| 27 | [27-fit-history-fidelity-and-asat-posterior.md](27-fit-history-fidelity-and-asat-posterior.md) | **Design only** | Types (`FitHistoryEntry`), settings (`max_days=100`) | `worker.py` does not write to `fit_history`. No archival, no asat() reconstruction |
| 42 | [42-asat-contract.md](42-asat-contract.md) | **Design** (16-Apr-26) | Consolidated asat() contract: three-date model, evidence filtering (snapshot + file), posterior resolution, invariants. Supersedes asat content in docs 3, 7, 27, 29 | Implementation + blind tests |
| 42b | [42b-asat-remedial-workplan.md](42b-asat-remedial-workplan.md) | **Active** (16-Apr-26) | Remedial workplan. D1/D3/D5/D7/D8 resolved. D2 (fit_history) blocked. 18/18 blind tests pass |
| 43 | [43-synth-gen-hash-assignment-defect.md](43-synth-gen-hash-assignment-defect.md) | **Resolved** (16-Apr-26) | Synth generator silently fell back to bare hash for contexted rows. Fixed: removed fallback, added verification. Underlying cause is doc 43b |
| 43b | [43b-context-hash-parity-defect.md](43b-context-hash-parity-defect.md) | **Resolved** (16-Apr-26) | `computeQuerySignature` was producing identical `core_hash` for bare and contexted queries. Fixed via `explode_dsl` changes |
| 29 | [29-generalised-forecast-engine-design.md](29-generalised-forecast-engine-design.md) | **Partial** (10-Apr-26) | Phase A infrastructure landed: `compose_path_maturity_frames` (`span_evidence.py`), `compose_span_kernel` (`span_kernel.py`), `XProvider` (`cohort_forecast.py`), `cohort_maturity_v2` registered FE+BE, `cohort_forecast_v2.py` (1000+ lines). Steps 1–3 building blocks exist as Phase A code | `ForecastState` contract (Step 1) not yet a standalone type. `evaluate_forecast_at_tau` scalar helper (Step 3) not extracted. Unified basis resolver (Step 2) not started. Generalisation to non-cohort-maturity consumers (Steps 4–6) not started |
| 29b | [29b-span-kernel-operator-algebra.md](29b-span-kernel-operator-algebra.md) | **Reference** | Companion design stress-test for doc 29. Operator algebra implemented in `span_kernel.py` | n/a |
| 29c | [29c-phase-a-design.md](29c-phase-a-design.md) | **Substantially implemented** (10-Apr-26). **Single-hop parity PASSED 13-Apr-26** | `cohort_forecast_v2.py` (1000+ lines): span kernel integration, x_provider, fan computation. `span_evidence.py`: evidence frame composition. `span_kernel.py`: conditional kernel. `span_adapter.py`: adapter layer. `cohort_maturity_v2` registered as analysis type FE+BE. Parity tests in `test_doc31_parity.py` | Multi-hop acceptance tests (A.5) — parallel quality work |
| 29d | [29d-phase-b-design.md](29d-phase-b-design.md) | **Design only** | — | Depends on Phase A parity gate. Not yet implemented |
| 29e | [29e-forecast-engine-implementation-plan.md](29e-forecast-engine-implementation-plan.md) | **Active** (13-Apr-26) | Phasing overview for engine build. Phases 0-6 defined, v2 frozen rule | Phase 7 (future enhancements) |
| 29f | [29f-forecast-engine-implementation-status.md](29f-forecast-engine-implementation-status.md) | **Active** (16-Apr-26) | Implementation status, defect log (D1-D20), codepath divergence analysis, Phase G generalisation plan. G.0/G.1/G.1b/G.3 done, D20 fixed. v3 parity 17/17 | G.2 (carrier fidelity), G.4 (retire det totals — blocked on D19), G.5 (evidence aggregation) |
| 30 | [30-snapshot-regime-selection-contract.md](30-snapshot-regime-selection-contract.md) | **Substantially implemented** (10-Apr-26) | BE `select_regime_rows()` + `CandidateRegime` + `mece_dimensions`, FE `candidateRegimeService.ts` (`buildCandidateRegimes`), 24+ tests (12 unit + 6 integration + DB integration), wired into analysis prep + Bayes trigger | FE preflight removal (Phase 5), Bayes evidence binder regime tests (RB-001-005) |
| 30b | [30b-regime-selection-worked-examples.md](30b-regime-selection-worked-examples.md) | **Reference** | Companion to doc 30 | n/a |
| 31 | [31-be-analysis-subject-resolution.md](31-be-analysis-subject-resolution.md) | **Implemented** (8-Apr-26) | `analysis_subject_resolution.py` (462 lines): `resolve_analysis_subjects()`, per-scope resolvers, `synthesise_snapshot_subjects()`. Wired into `api_handlers.py`. 36 unit tests + 3 parity tests (`test_doc31_parity.py`) | — |
| 32 | [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md) | **Partial** (Phase 1 implemented 8-Apr-26) | `bayes/compiler/loo.py` (362 lines): PSIS-LOO via arviz, analytic null baseline, per-edge attribution. Wired into `worker.py` for both Phase 1+2 passes. 21 tests. | Phase 2 (trajectory/Potential scoring) pending |
| 34 | [34-latency-dispersion-background.md](34-latency-dispersion-background.md) | **Implemented** (11-Apr-26) | Per-interval BetaBinomial (`kappa_lat` — timing overdispersion analogous to kappa for p). Feature-flagged `latency_dispersion`. 10/11 uncontexted graphs pass regression. Failed per-cohort random effect approach documented as anti-pattern | Mixture path kappa_lat, contexted graph regression |
| 35 | [35-per-slice-regression-reporting.md](35-per-slice-regression-reporting.md) | **Implemented** (11-Apr-26) | Per-slice verbose regression reporting. Layers 3-8 iterated per context slice. Binding receipts, audit parsing, recovery parsing, LOO scoring (per-slice truth null), report renderer, pass/fail gates — all per-slice. | Production graphs fall back to edge-level AnalyticBaseline for per-slice LOO null (no per-slice model_vars) |
| 36 | [36-posterior-predictive-calibration.md](36-posterior-predictive-calibration.md) | **Partial** (12-Apr-26) | Posterior predictive calibration: PIT uniformity, coverage curves, per-edge KS test. `calibration.py` implemented. Endpoint validated; trajectory blocked on synth DGP. | LOO-PIT for production graphs not yet wired |
| 38 | [38-ppc-calibration-findings.md](38-ppc-calibration-findings.md) | **Partial** (12-Apr-26) | PPC implementation, three-layer validation (true PIT baseline), synth two-kappa DGP mismatch discovery, MLE empirical Bayes prior for kappa. | Single-source synth flag needed for trajectory validation |
| 38c | [38-contexted-compilation-performance.md](38-contexted-compilation-performance.md) | **Implemented** (12-Apr-26) | NUTS geometry diagnostics, edge-level sigma/onset, native vector RVs, batched Phase 1 window trajectory (6→2 Potentials), auto low-rank mass matrix (n_dim>20). compile −29%, sampling −42%, step_size +74%. | Sampler geometry (tau funnels) partially addressed by lowrank; centred parameterisation not yet tried |
| 48 | [48-bayes-remediation-action-plan.md](48-bayes-remediation-action-plan.md) | **Proposed** (18-Apr-26) | Sequenced remediation plan for the current Bayes issue set. Separates fitted-posterior correctness, export/diagnostic contract work, and forecast-path convergence. | Execution not started. Depends on issue revalidation, parity harnesses, and follow-up updates to docs 33, 46, 47, and 29f |
| 50 | [50-cf-generality-gap.md](50-cf-generality-gap.md) | **Implemented** (20-Apr-26) | Conditioned forecast was silently dropping lagless edges (`sigma ≤ 0` short-circuit). Now implements Class A/B/C/D edge taxonomy with Beta-Binomial posterior path for lagless edges and structured `skipped_edges`. T1–T7 topology fixtures in place. Update the doc body to reflect shipped state | — |
| 51 | [51-subset-conditioning-double-count-correction.md](51-subset-conditioning-double-count-correction.md) | **Implemented** (20-Apr-26) | Shared pro-rata shrinkage helper now discounts aggregate prior's equivalent strength by `N_subset / N_total` before updating. Threaded through cohort-maturity v3 Beta update, CF Class B lagless-edge posterior update, and cohort-mode forecast conditioning. Update the doc body to reflect shipped state | — |
| 51 | [51-model-curve-overlay-divergence.md](51-model-curve-overlay-divergence.md) | **P0 done; B3 spike proposed** (20-Apr-26) | User-visible overlay-main divergence RESOLVED: unified overlay through span kernel with MC-median midline, reusing main chart's own MC arrays — parity test now passes at 0.00% across all cases. `path_mu_mean` no longer read by overlay; `compute_completeness` no longer called from overlay. Deeper architectural gap remains: Phase 2's cohort-level path LATENCY posterior is emitted but unused by the forecast stack (cohort p posterior is partially used for IS drift). B3 spike (convolution-aware Phase 2 — redesign as edge-level refinement) is the next determinative step: if it works, `path_mu_mean` is obsolete and FW composition of refined per-edge posteriors is the unified correct construction; if not, Position 1/2 reconciliation with PPC gating. Red test at `graph-ops/scripts/cohort-maturity-model-parity-test.sh` tightened to 0.1% tolerance. Includes sidebars on Beta distributions, mean-vs-median, CDF discretisation (including the failed P0.1 CDF-diff spike that would have regressed multi-hop), Fenton-Wilkinson | B3 spike scoping and execution; tracking half-bin-bias-vs-truth as parked item |
| 52 | [52-funnel-hi-lo-bars-design.md](52-funnel-hi-lo-bars-design.md) | **Implemented** (21-Apr-26) | Level 2 design for funnel hi/lo bars. Answers doc 49 §Deferred. Defines three regimes: **e** (raw k/n from `edge.p.evidence`, Amplitude parity, Wilson CI), **f** (draws from aggregate Bayesian posterior α/β, path-product, MC quantiles — unconditioned), **e+f** (path-product of CF-written per-edge conditioned means `edge.p.mean`, moment-matched Beta for bands from `p.sd`, stacked bar with striation for residual f = (e+f) − e). Funnel engine is pure numpy; reads the enriched graph; does **not** call `mc_span_cdfs` or `compute_forecast_trajectory` at render time — that work is done upstream by the BE CF pass and persisted per edge. Asymptotic (τ=∞). Contract tests: monotonicity, e ≤ e+f, stage-1 parity with cohort-maturity, f = path-product of bayesian means, e+f = path-product of CF conditioned means. Three refined implementation milestones + FE rendering + multi-scenario + docs. Depends on BE CF pass having landed; fallback via promotion to analytic_be / analytic when CF pending. See [STATS_SUBSYSTEMS.md](../codebase/STATS_SUBSYSTEMS.md) for the subsystem map this design consumes | — |
| 52 | [52-b3-spike-workplan.md](52-b3-spike-workplan.md) | **Proposed** (20-Apr-26) | Near-term workplan for the B3 spike. Separates structural correction from explicit drift, keeps frontier forecasting window-led, and defines phased spike execution with aggregate-first scope, latency-first prototype order, and explicit pass/fail gates | Spike not started. Needs Phase 0 evaluation contract, synth selection, and gate-based decision note before any implementation plan |
| 53 | [53-explicit-drift-modelling-discussion.md](53-explicit-drift-modelling-discussion.md) | **Discussion** (20-Apr-26) | Prospective design note on explicit drift modelling. Distinguishes structural path correction from current-regime estimation, argues that frontier forecasts must remain fast-path/window-led until a true time-indexed regime model exists, and sketches a probability-first temporal partial-pooling direction | No implementation planned yet. Serves as the doctrinal note for keeping mature cohort calibration distinct from frontier current-state estimation |
| 54 | [54-slice-dispersion-priors-and-robustness.md](54-slice-dispersion-priors-and-robustness.md) | **Discussion** (20-Apr-26) | Partial-pooling exchangeability failure: when τ ends up small (other slices agree, or prior on τ tight), every slice inherits a tight posterior — "confidently wrong" on non-exchangeable slices. Current priors: `HalfNormal(0.5)` on logit for p; `HalfNormal(0.3)` for latency τ_m, τ_r (kept tight for onset-μ identifiability). Two alternatives sketched (heavier-tailed τ prior like Cauchy/Student-t; per-slice mixture with outlier component). No evidence today that design is broken on typical graphs | No implementation proposed yet. Listed in programme.md as P2.15 under Tier-2. Pairs with P1.10 (latency re-param) |
| 56 | [56-forecast-stack-residual-v1-v2-coupling.md](56-forecast-stack-residual-v1-v2-coupling.md) | **Implemented** (22-Apr-26) | The production forecast stack now uses `forecast_runtime.py` as the runtime-owned seam for the engine, v3 row builder, and active CF handlers. The dependency audit guards against reintroducing `cohort_forecast_v2`, `span_adapter`, or `cohort_forecast` into the active stack | Historical migration-plan doc retained as the rationale for the dependency audit and the remaining frozen v2/parity surfaces |
| 55 | [55-surprise-gauge-rework.md](55-surprise-gauge-rework.md) | **Implemented** (21-Apr-26) | Surprise gauge is now a backend projection of `compute_forecast_summary`, with unavailable results instead of a second-class fallback when CF semantics do not exist (including the query-scoped-posterior degraded case from doc 57) | Implemented. Remains the design record for the gauge's bounded summary-only contract |
| 56 | [56-forecast-function-naming.md](56-forecast-function-naming.md) | **Implemented** (21-Apr-26) | Forecast summary / trajectory naming and the conditioned-versus-unconditioned completeness split have been hard-cut onto the live stack, so new forecast work uses the final identifiers rather than aliases | Implemented. Retained as the naming migration record |
| 57 | [57-cf-eligibility-topological-degradation.md](57-cf-eligibility-topological-degradation.md) | **Implemented** (22-Apr-26) | Per-edge `alpha_beta_query_scoped` sweep eligibility is now the live degraded/unavailable contract across CF, v3, daily conversions, and surprise gauge. Query-scoped posteriors no longer re-run the sweep | Keep as the semantic reference for the degraded path and provenance contract |
| 59 | [59-cohort-window-forecast-implementation-scheme.md](59-cohort-window-forecast-implementation-scheme.md) | **Active reference** (22-Apr-26) | The core runtime contract is now live: `population_root`, `carrier_to_x`, `subject_span`, `numerator_representation`, `admission_policy`, and `p_conditioning_evidence` all exist explicitly, including the narrow direct-`cohort()` rate-conditioning flag | Retained as the target/reference note for residual delta analysis and later B3 / gross-numerator questions |
| 60 | [60-forecast-adaptation-programme.md](60-forecast-adaptation-programme.md) | **Active implementation record** (22-Apr-26) | Delivery plan for the forecast adaptation workstream, now retained as the execution record and acceptance checklist after WP0-WP9 landed in code | Focused package-level suites are green; broader outside-in closure remains the main remaining validation question |
| 61 | [61-dispersion-naming-symmetry.md](61-dispersion-naming-symmetry.md) | **Implemented** (22-Apr-26) | Supersedes doc 49 §A.6 Invariant 9 and §A.9 Invariant 5. Dispersion fields now use symmetric naming: bare name is always epistemic, `_pred` suffix is always predictive. Reporting surfaces (posterior card, ModelRateChart, cohort_maturity_v3 overlap curves) read the bare (epistemic) slot; forecast surfaces (main fan, conditioned-forecast sweep) read the `_pred` slot. Load-time migration shim in `workspaceService` + `bayesPatchService` rewrites old-shape `mu_sd_epist` entries to the new shape | Implementation complete. Migration shim can retire once all in-flight graphs have been re-fitted under the new compiler |
| 62 | [62-direct-cohort-rate-conditioning-flag.md](62-direct-cohort-rate-conditioning-flag.md) | **Implemented** (22-Apr-26) | Short WP8 design note fixing the first landing of the direct-`cohort()` rate-conditioning flag. Limits the change to exact single-hop cohort subjects, keeps carrier/latency/numerator semantics unchanged, and preserves doc 52's aggregate-prior vs query-scoped discipline | Landed as the narrow WP8 follow-on after WP7's degraded-path work |
| 63 | [63-investigation-tracker-mcp-spec.md](63-investigation-tracker-mcp-spec.md) | **Phases 0–1 implemented** (22-Apr-26) | Tiny MCP-backed investigation tracker for Bayes diagnostic work. Shipped: `bayes/tracker/` package (schema, storage with flock + atomic writes, marker-fenced renderer, stdio MCP server with 12 tools — 5 reads + 7 writes), migration from doc 20, seeded `20-open-issues-register.tracker.yaml`, registered as `bayes-tracker` in `.mcp.json`. 41 tests passing. Doc 20 carries the agent-facing operations reference | Phase 2 (runner-side `--tracker-run-id` with `BAYES_REQUIRE_TRACKER=1` refuse-by-default on `run_regression.py`/`regression_plans.py`) and Phase 3 (thin `bayes/bayes-run` launch wrapper) deferred |
| 64 | [64-forecast-assurance-overhaul.md](64-forecast-assurance-overhaul.md) | **Proposed** (22-Apr-26) | First-principles replacement for the forecast refactor's parity-heavy test story. Reviews the current forecasting/CF suite, classifies keep/rewrite/retire candidates, and defines the permanent semantic assurance model for forecasting after v1/v2 deletion | Use this as the active reference for forecast assurance redesign and for deciding which parity-era harnesses must be replaced before legacy removal |
| 65 | [65-gm-rebuild-window-vs-cohort-cli-investigation.md](65-gm-rebuild-window-vs-cohort-cli-investigation.md) | **Open investigation** (23-Apr-26) | Public-tooling CLI comparison on `bayes-test-gm-rebuild` for `from(switch-registered).to(switch-success)` shows that v2 preserves a large `window(-1d:)` versus `cohort(-1d:)` gap while v3 almost collapses the two curves despite selecting distinct regimes. Records the exact `analyse.sh` commands, key tau values, and the current single-hop / direct-`cohort()` suspect set | Use as the pick-up note for further FE-path forensic work on the live single-hop downstream cohort defect |
| 66 | [66-shared-cf-runtime-and-wp8-admission-plan.md](66-shared-cf-runtime-and-wp8-admission-plan.md) | **Active implementation plan** (23-Apr-26) | Detailed staged plan for converging BE conditioned forecast, `cohort_maturity`, and Daily Conversions onto one factorised runtime while keeping WP8 as an evidence-layer admission policy rather than a structural branch. Defines structural-versus-evidence split, admission criteria, stop rules, and stage guards | Use as the execution note for shared-runtime convergence and the disciplined WP8 follow-on |
| 54 | [54-cf-readiness-protocol.md](54-cf-readiness-protocol.md) | **Design** (20-Apr-26) | Cross-cutting protocol for signalling BE CF enrichment state to CF-dependent analysis types. Problem: CF pass can take 500ms–3s; funnel v2 / surprise gauge / future bridge-attribution-diff analyses need to know per-edge whether the enrichment has landed, without blocking render. Design: in-memory `enrichmentStatusStore` (NOT persisted to graph files — ephemeral per-fetch-generation state); per-edge per-scenario tracking of FE-topo / BE-topo / CF application; `cf_dependency: required \| preferred \| none` field on `analysis_types.yaml`; `enrichment_status: {state: definitive \| approximate \| pending, cf_applied_edges/cf_total_edges, ...}` on analysis results; re-render on CF arrival via subscription; per-analysis-type approximation logic (e.g. funnel v2 falls through to promoted p.mean via `modelVarsResolution.ts`). 7 milestones M1-M7. Interim pattern (for funnels): analyses call BE CF directly per-query until the shared enrichment is in place — doc 54 §8 notes this as the deferred optimisation path | Not yet implemented. Interim: funnel v2 (doc 52) and other consumers make their own per-query CF calls until M1-M6 land |

## Open investigations

| # | File | Status | Notes |
|---|------|--------|-------|
| 37 | [37-contexted-compilation-investigation.md](37-contexted-compilation-investigation.md) | **Resolved** (12-Apr-26) | Contexted model compilation + sampling performance. Original OOM resolved by vector RV batching (doc 38c). Remaining: sampler geometry (tau funnels) partially mitigated by lowrank mass matrix |

## Performance

| # | File | Status | Notes |
|---|------|--------|-------|
| 38 | [38-contexted-compilation-performance.md](38-contexted-compilation-performance.md) | **Active** (12-Apr-26) | Like-for-like performance comparison: bare-DSL vs contexted on same data. Phase 1 sampling 11-23× slower with slices. NUTS geometry diagnostics, edge-level sigma/onset optimisation, lowrank mass matrix |

## Open defects

| # | File | Status | Notes |
|---|------|--------|-------|
| 16 | [16-lag-array-population-defect.md](16-lag-array-population-defect.md) | **Open** | Window values[] lag arrays mostly zero (71/207 nonzero). Low priority — warm-start bypasses |
| 19B | [19-be-stats-engine-bugs.md](19-be-stats-engine-bugs.md) | **Open** | Three-way prior discrepancy (FE/BE/topology). Low priority — warm-start bypasses |
| 33 | [33-bayes-compiler-dispersion-forensic-review.md](33-bayes-compiler-dispersion-forensic-review.md) | **Open** | Engineering-facing forensic review of six compiler dispersion defects. Highest-risk items are endpoint double-counting and the order-dependent Phase 2 non-exhaustive branch-group prior |
| 33B | [33-snapshot-query-batching.md](33-snapshot-query-batching.md) | **Open** | Sequential per-subject DB queries in `worker.py` — 2N round-trips for N edges. Affects Bayes worker, analysis prep, retrieve-all |
| 39 | [39-data-binding-parity-defects.md](39-data-binding-parity-defects.md) | **Open** (12-Apr-26) | Systemic class: data binding parity failures between contexted and bare DSL paths. 5 defects found and fixed; 6 parity invariants defined. Blind test coverage needed |
| 40 | [40-centred-param-sparsity-robustness.md](40-centred-param-sparsity-robustness.md) | **Ready to run** (14-Apr-26) | Centred parameterisation may degrade on sparse data. Sparsity layer built in `synth_gen.py` (3 params: `frame_drop_rate`, `toggle_rate`, `initial_absent_pct`). Sweep script (`scripts/sparsity-sweep.py`) generates variants and runs centred vs non-centred via `param_recovery.py`. 9 blind tests, 2 sparse truth YAMLs. Queued run in `programme.md` |

## Reference and operational docs

| # | File | Status | Notes |
|---|------|--------|-------|
| 2 | [2-reference-implementation-notes.md](2-reference-implementation-notes.md) | **Reference** | PyMC patterns from external repo. Research/validation |
| 5 | [5-local-dev-setup.md](5-local-dev-setup.md) | **Reference** | Operational guide: local vs Modal, prerequisites, tunnel |
| 17 | [17-synthetic-data-generator.md](17-synthetic-data-generator.md) | **Implemented** (Phase 1) | Phase 2 (context slices) not built. Kept here as active reference for synth work |
| 18J | [18-compiler-journal.md](18-compiler-journal.md) | **Active** | ~4400 lines, last entry 6-Apr-26. Ongoing chronological record |
| 19S | [19-synthetic-data-playbook.md](19-synthetic-data-playbook.md) | **Reference** | Step-by-step operational guide for synth data |
| 22 | [22-sampling-performance.md](22-sampling-performance.md) | **Research only** | No experiments run. Stack unchanged (PyTensor/nutpie) |
| 44 | [44-synth-model-test-plan.md](44-synth-model-test-plan.md) | **Active** (18-Apr-26) | Cartesian test plan: 53 synth graphs, config-driven plans, structured JSON results, sparsity calibration. Canonical truth files in `bayes/truth/` |
| — | [statistical-domain-summary.md](statistical-domain-summary.md) | **Reference** | Statistical foundations and domain concepts |

## Cohort maturity (subdirectory)

| File | Status | Notes |
|------|--------|-------|
| [cohort-maturity/INDEX.md](cohort-maturity/INDEX.md) | **Active** (10-Apr-26) | 9 docs. Posterior-predictive simulator live. Phase A (multi-hop) substantially implemented — `cohort_forecast_v2.py`, span kernel, x_provider. **Open bug**: sparse `cohort_at_tau` → zero-width bands |

---

## Archive (`archive/`)

22 docs moved to [archive/](archive/) on 8-Apr-26 after code
verification confirmed implementation. Essential knowledge captured
in codebase docs:

- **`PYTHON_BACKEND_ARCHITECTURE.md`** — compiler pipeline, async
  roundtrip, two-phase model, FE overlay components, automation
- **`STATISTICAL_DOMAIN_SUMMARY.md`** — unified posterior schema,
  slice resolution, compiler steps
- **`FE_BE_STATS_PARALLELISM.md`** — heuristic dispersion SDs,
  promoted fields

### Archived implemented docs

| # | File | Implemented | Codebase coverage |
|---|------|------------|-------------------|
| 0 | [0-high-level-logical-blocks.md](archive/0-high-level-logical-blocks.md) | Full compiler pipeline | PYTHON_BACKEND §Compiler pipeline |
| 3 | [3-compute-and-deployment-architecture.md](archive/3-compute-and-deployment-architecture.md) | Modal app, /submit, /status, /cancel | PYTHON_BACKEND §Architecture |
| 4 | [4-async-roundtrip-infrastructure.md](archive/4-async-roundtrip-infrastructure.md) | All 6 steps (config→encrypt→submit→worker→webhook→pull) | PYTHON_BACKEND §Async roundtrip |
| 6 | [6-compiler-and-worker-pipeline.md](archive/6-compiler-and-worker-pipeline.md) | IR boundary, three-function design | PYTHON_BACKEND §Compiler pipeline |
| 9 | [9-fe-posterior-consumption-and-overlay.md](archive/9-fe-posterior-consumption-and-overlay.md) | BayesPosteriorCard, PosteriorIndicator, useBayesTrigger, quality tiers | PYTHON_BACKEND §FE posterior overlay |
| 11 | [11-snapshot-evidence-assembly.md](archive/11-snapshot-evidence-assembly.md) | `bind_snapshot_evidence()`, DB→observations, param file fallback | PYTHON_BACKEND §Compiler pipeline |
| 12 | [12-drift-detection-notes.md](archive/12-drift-detection-notes.md) | `_apply_recency_weights()` in evidence.py | PYTHON_BACKEND §Key implemented features |
| 15 | [15-model-vars-provenance-design.md](archive/15-model-vars-provenance-design.md) | `ModelVarsEntry`, `resolveActiveModelVars()`, tested | FE_BE_STATS §model_vars entries |
| 18L | [18-latent-onset-design.md](archive/18-latent-onset-design.md) | Feature-flagged `latent_onset=True`, per-edge MCMC onset | PYTHON_BACKEND §Key implemented features |
| 19M | [19-model-vars-production-consumption-separation.md](archive/19-model-vars-production-consumption-separation.md) | `promoted_t95`, `promoted_onset_delta_days`, fallback chains | FE_BE_STATS §Promoted fields |
| 20 | [20-trajectory-compression-briefing.md](archive/20-trajectory-compression-briefing.md) | `zero_count_filter` in evidence.py | PYTHON_BACKEND §Key implemented features |
| 21 | [21-unified-posterior-schema.md](archive/21-unified-posterior-schema.md) | `posterior.slices` keyed by DSL, `_model_state`, active resolution | STAT_DOMAIN §9.5 Unified posterior schema |
| 23 | [23-two-phase-model-design.md](archive/23-two-phase-model-design.md) | Phase 1 window + Phase 2 cohort, DM→Binomial, BB→Binomial | PYTHON_BACKEND §Compiler pipeline (two-phase) |
| 24 | [24-phase2-redesign.md](archive/24-phase2-redesign.md) | `_ess_decay_scale()`, posterior-as-prior Beta/Dirichlet | PYTHON_BACKEND §Compiler pipeline (two-phase) |
| 25P | [25-posterior-slice-resolution-and-analysis-type-review.md](archive/25-posterior-slice-resolution-and-analysis-type-review.md) | `resolvePosteriorSlice()`, integrated into cascade | STAT_DOMAIN §9.5 Unified posterior schema |
| 26 | [26-phase2-onset-drift.md](archive/26-phase2-onset-drift.md) | `cohort_latency_warm` bypassed, Phase 2 priors from Phase 1 | PYTHON_BACKEND §Compiler pipeline (two-phase) |
| 28 | [28-bayes-run-reconnect-design.md](archive/28-bayes-run-reconnect-design.md) | 3-phase automation, `reconcileBayesFitJob`, patch apply | PYTHON_BACKEND §Automation |
| — | [heuristic-dispersion-design.md](archive/heuristic-dispersion-design.md) | Edge+path SDs (p/mu/sigma/onset), parity at 1e-9 | FE_BE_STATS §Heuristic dispersion SDs |
| — | [bayes-join-node-convergence-briefing.md](archive/bayes-join-node-convergence-briefing.md) | `moment_matched_collapse()` + PyTensor variant | PYTHON_BACKEND §Key implemented features |
| — | [t95-hdi-data-flow.md](archive/t95-hdi-data-flow.md) | Exhaustive trace verified against code | PYTHON_BACKEND §Compiler pipeline |

### Archived superseded docs

| # | File | Superseded by |
|---|------|--------------|
| 19D | [19-dispersion-investigation-plan.md](archive/19-dispersion-investigation-plan.md) | Unified MCMC kappa (31-Mar-26) — `model.py:1008-1019` |
| 25K | [25-kappa-discrepancy-investigation.md](archive/25-kappa-discrepancy-investigation.md) | Unified MCMC kappa bypasses Williams CDF adjustment |

---

## Document numbering notes

Numbers reflect creation order, not importance. Some numbers have
multiple docs (e.g. `19` = four docs; `25` = two docs). Unnumbered
docs were standalone investigations. The `cohort-maturity/`
subdirectory was split out when the topic grew to 9 docs.

## Cross-references

- **Codebase docs**: `../codebase/PYTHON_BACKEND_ARCHITECTURE.md`,
  `../codebase/STATISTICAL_DOMAIN_SUMMARY.md`,
  `../codebase/FE_BE_STATS_PARALLELISM.md`
- **Snapshot DB**: `../project-db/`
- **Hash/signature infrastructure**: `../codebase/HASH_SIGNATURE_INFRASTRUCTURE.md`
- **DSL syntax**: `../codebase/DSL_SYNTAX_REFERENCE.md`
