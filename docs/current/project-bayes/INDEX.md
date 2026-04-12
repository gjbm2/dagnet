# Project Bayes — Document Index

**Last updated**: 12-Apr-26
**Verified against codebase**: 12-Apr-26

For sequencing, priorities, and current status snapshot, see
[programme.md](programme.md).

---

## Active docs (not yet fully implemented)

| # | File | Status | What's built | What's not |
|---|------|--------|-------------|------------|
| 1 | [1-cohort-completeness-model-contract.md](1-cohort-completeness-model-contract.md) | **Partial** | `query_mode` threading, completeness via `bind_evidence` | Named `_resolve_completeness_params()`, `completeness_model` per-subject object |
| 7 | [7-asat-analysis-completion.md](7-asat-analysis-completion.md) | **Partial** | Snapshot routing, `_asat_retrieved_at` annotation, integration test | Typed `asat_date` on AnalysisResult, chart subtitle/badge |
| 8 | [8-compiler-implementation-phases.md](8-compiler-implementation-phases.md) | **Partial** | Phase A (Beta+Binomial), B (Dirichlet), S (snapshot evidence), D (latent latency+onset), C (slice routing + per-slice Dirichlet emission + per-slice posterior extraction) | Phase E not started |
| 10 | [10-topology-signatures.md](10-topology-signatures.md) | **Design only** | Fingerprint field on `TopologyAnalysis` for cache identity | Per-fit-unit staleness detection, UI surfacing, warm-start invalidation |
| 13 | [13-model-quality-gating-and-preview.md](13-model-quality-gating-and-preview.md) | **Partial** | Quality tiers (failed/warning/good-0..3), `computeGraphQualityTier()`, progress indicator | Accept/reject preview workflow (sections 2-3) |
| 14 | [14-phase-c-slice-pooling-design.md](14-phase-c-slice-pooling-design.md) | **Partial** (10-Apr-26) | DSL parsing (`slices.py`), `SliceGroup` routing (`evidence.py`), per-slice hierarchical Dirichlet emission (`model.py` §2b), per-slice posterior extraction (`inference.py`), `bayesEngorge.ts` wired. Tested via `test_model_wiring.py`, `test_snapshot_e2e.py`, `test_param_recovery.py` | `conditional_p` not yet emitted. No dedicated Phase C test suite. Per-slice visualisation in FE not started |
| 27 | [27-fit-history-fidelity-and-asat-posterior.md](27-fit-history-fidelity-and-asat-posterior.md) | **Design only** | Types (`FitHistoryEntry`), settings (`max_days=100`) | `worker.py` does not write to `fit_history`. No archival, no asat() reconstruction |
| 29 | [29-generalised-forecast-engine-design.md](29-generalised-forecast-engine-design.md) | **Partial** (10-Apr-26) | Phase A infrastructure landed: `compose_path_maturity_frames` (`span_evidence.py`), `compose_span_kernel` (`span_kernel.py`), `XProvider` (`cohort_forecast.py`), `cohort_maturity_v2` registered FE+BE, `cohort_forecast_v2.py` (1000+ lines). Steps 1–3 building blocks exist as Phase A code | `ForecastState` contract (Step 1) not yet a standalone type. `evaluate_forecast_at_tau` scalar helper (Step 3) not extracted. Unified basis resolver (Step 2) not started. Generalisation to non-cohort-maturity consumers (Steps 4–6) not started |
| 29b | [29b-span-kernel-operator-algebra.md](29b-span-kernel-operator-algebra.md) | **Reference** | Companion design stress-test for doc 29. Operator algebra implemented in `span_kernel.py` | n/a |
| 29c | [29c-phase-a-design.md](29c-phase-a-design.md) | **Substantially implemented** (10-Apr-26) | `cohort_forecast_v2.py` (1000+ lines): span kernel integration, x_provider, fan computation. `span_evidence.py`: evidence frame composition. `span_kernel.py`: conditional kernel. `span_adapter.py`: adapter layer. `cohort_maturity_v2` registered as analysis type FE+BE. Parity tests in `test_doc31_parity.py` | Single-hop parity gate (A.4) and multi-hop acceptance tests (A.5) need formal pass confirmation |
| 29d | [29d-phase-b-design.md](29d-phase-b-design.md) | **Design only** | — | Depends on Phase A parity gate. Not yet implemented |
| 30 | [30-snapshot-regime-selection-contract.md](30-snapshot-regime-selection-contract.md) | **Substantially implemented** (10-Apr-26) | BE `select_regime_rows()` + `CandidateRegime` + `mece_dimensions`, FE `candidateRegimeService.ts` (`buildCandidateRegimes`), 24+ tests (12 unit + 6 integration + DB integration), wired into analysis prep + Bayes trigger | FE preflight removal (Phase 5), Bayes evidence binder regime tests (RB-001-005) |
| 30b | [30b-regime-selection-worked-examples.md](30b-regime-selection-worked-examples.md) | **Reference** | Companion to doc 30 | n/a |
| 31 | [31-be-analysis-subject-resolution.md](31-be-analysis-subject-resolution.md) | **Implemented** (8-Apr-26) | `analysis_subject_resolution.py` (462 lines): `resolve_analysis_subjects()`, per-scope resolvers, `synthesise_snapshot_subjects()`. Wired into `api_handlers.py`. 36 unit tests + 3 parity tests (`test_doc31_parity.py`) | — |
| 32 | [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md) | **Partial** (Phase 1 implemented 8-Apr-26) | `bayes/compiler/loo.py` (362 lines): PSIS-LOO via arviz, analytic null baseline, per-edge attribution. Wired into `worker.py` for both Phase 1+2 passes. 21 tests. | Phase 2 (trajectory/Potential scoring) pending |
| 34 | [34-latency-dispersion-background.md](34-latency-dispersion-background.md) | **Implemented** (11-Apr-26) | Per-interval BetaBinomial (`kappa_lat` — timing overdispersion analogous to kappa for p). Feature-flagged `latency_dispersion`. 10/11 uncontexted graphs pass regression. Failed per-cohort random effect approach documented as anti-pattern | Mixture path kappa_lat, contexted graph regression |
| 35 | [35-per-slice-regression-reporting.md](35-per-slice-regression-reporting.md) | **Implemented** (11-Apr-26) | Per-slice verbose regression reporting. Layers 3-8 iterated per context slice. Binding receipts, audit parsing, recovery parsing, LOO scoring (per-slice truth null), report renderer, pass/fail gates — all per-slice. | Production graphs fall back to edge-level AnalyticBaseline for per-slice LOO null (no per-slice model_vars) |
| 36 | [36-posterior-predictive-calibration.md](36-posterior-predictive-calibration.md) | **Partial** (12-Apr-26) | Posterior predictive calibration: PIT uniformity, coverage curves, per-edge KS test. `calibration.py` implemented. Endpoint validated; trajectory blocked on synth DGP. | LOO-PIT for production graphs not yet wired |
| 38 | [38-ppc-calibration-findings.md](38-ppc-calibration-findings.md) | **Partial** (12-Apr-26) | PPC implementation, three-layer validation (true PIT baseline), synth two-kappa DGP mismatch discovery, MLE empirical Bayes prior for kappa. | Single-source synth flag needed for trajectory validation |
| 38c | [38-contexted-compilation-performance.md](38-contexted-compilation-performance.md) | **Implemented** (12-Apr-26) | NUTS geometry diagnostics, edge-level sigma/onset, native vector RVs, batched Phase 1 window trajectory (6→2 Potentials), auto low-rank mass matrix (n_dim>20). compile −29%, sampling −42%, step_size +74%. | Sampler geometry (tau funnels) partially addressed by lowrank; centred parameterisation not yet tried |

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

## Reference and operational docs

| # | File | Status | Notes |
|---|------|--------|-------|
| 2 | [2-reference-implementation-notes.md](2-reference-implementation-notes.md) | **Reference** | PyMC patterns from external repo. Research/validation |
| 5 | [5-local-dev-setup.md](5-local-dev-setup.md) | **Reference** | Operational guide: local vs Modal, prerequisites, tunnel |
| 17 | [17-synthetic-data-generator.md](17-synthetic-data-generator.md) | **Implemented** (Phase 1) | Phase 2 (context slices) not built. Kept here as active reference for synth work |
| 18J | [18-compiler-journal.md](18-compiler-journal.md) | **Active** | ~4400 lines, last entry 6-Apr-26. Ongoing chronological record |
| 19S | [19-synthetic-data-playbook.md](19-synthetic-data-playbook.md) | **Reference** | Step-by-step operational guide for synth data |
| 22 | [22-sampling-performance.md](22-sampling-performance.md) | **Research only** | No experiments run. Stack unchanged (PyTensor/nutpie) |
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
