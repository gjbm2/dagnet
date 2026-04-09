# Project Bayes — Document Index

**Last updated**: 9-Apr-26
**Verified against codebase**: 9-Apr-26

For sequencing, priorities, and current status snapshot, see
[programme.md](programme.md).

---

## Active docs (not yet fully implemented)

| # | File | Status | What's built | What's not |
|---|------|--------|-------------|------------|
| 1 | [1-cohort-completeness-model-contract.md](1-cohort-completeness-model-contract.md) | **Partial** | `query_mode` threading, completeness via `bind_evidence` | Named `_resolve_completeness_params()`, `completeness_model` per-subject object |
| 7 | [7-asat-analysis-completion.md](7-asat-analysis-completion.md) | **Partial** | Snapshot routing, `_asat_retrieved_at` annotation, integration test | Typed `asat_date` on AnalysisResult, chart subtitle/badge |
| 8 | [8-compiler-implementation-phases.md](8-compiler-implementation-phases.md) | **Partial** | Phase A (Beta+Binomial), B (Dirichlet), S (snapshot evidence), D (latent latency+onset) | Phase C model emission (DSL parsing done, hierarchical Dirichlet not emitted). Phase E not started |
| 10 | [10-topology-signatures.md](10-topology-signatures.md) | **Design only** | Fingerprint field on `TopologyAnalysis` for cache identity | Per-fit-unit staleness detection, UI surfacing, warm-start invalidation |
| 13 | [13-model-quality-gating-and-preview.md](13-model-quality-gating-and-preview.md) | **Partial** | Quality tiers (failed/warning/good-0..3), `computeGraphQualityTier()`, progress indicator | Accept/reject preview workflow (sections 2-3) |
| 14 | [14-phase-c-slice-pooling-design.md](14-phase-c-slice-pooling-design.md) | **Design only** | DSL parsing in `slices.py`, `SliceGroup` routing in `evidence.py` | Hierarchical Dirichlet model emission, `conditional_p`, per-slice posteriors |
| 27 | [27-fit-history-fidelity-and-asat-posterior.md](27-fit-history-fidelity-and-asat-posterior.md) | **Design only** | Types (`FitHistoryEntry`), settings (`max_days=100`) | `worker.py` does not write to `fit_history`. No archival, no asat() reconstruction |
| 29 | [29-generalised-forecast-engine-design.md](29-generalised-forecast-engine-design.md) | **Design only** | — | No `ForecastState`, `compose_path_maturity`, or unified contract anywhere |
| 30 | [30-snapshot-regime-selection-contract.md](30-snapshot-regime-selection-contract.md) | **Partial** | BE `select_regime_rows()` + `CandidateRegime`, FE `buildCandidateRegimesByEdge()` + `mece_dimensions`, 24+ tests, wired into analysis prep + Bayes trigger | FE preflight removal (Phase 5), Bayes evidence binder regime tests (RB-001-005). Doc header stale ("FE not started") — FE candidate construction is done. |
| 30b | [30b-regime-selection-worked-examples.md](30b-regime-selection-worked-examples.md) | **Reference** | Companion to doc 30 | n/a |
| 31 | [31-be-analysis-subject-resolution.md](31-be-analysis-subject-resolution.md) | **Implemented** (8-Apr-26) | `analysis_subject_resolution.py` (462 lines): `resolve_analysis_subjects()`, per-scope resolvers, `synthesise_snapshot_subjects()`. Wired into `api_handlers.py`. 36 unit tests + 3 parity tests (`test_doc31_parity.py`) | — |
| 32 | [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md) | **Partial** (Phase 1 implemented 8-Apr-26) | `bayes/compiler/loo.py` (362 lines): PSIS-LOO via arviz, analytic null baseline, per-edge attribution. Wired into `worker.py` for both Phase 1+2 passes. 21 tests. | Phase 2 (trajectory/Potential scoring) pending |

## Open defects

| # | File | Status | Notes |
|---|------|--------|-------|
| 16 | [16-lag-array-population-defect.md](16-lag-array-population-defect.md) | **Open** | Window values[] lag arrays mostly zero (71/207 nonzero). Low priority — warm-start bypasses |
| 19B | [19-be-stats-engine-bugs.md](19-be-stats-engine-bugs.md) | **Open** | Three-way prior discrepancy (FE/BE/topology). Low priority — warm-start bypasses |
| 33 | [33-bayes-compiler-dispersion-forensic-review.md](33-bayes-compiler-dispersion-forensic-review.md) | **Open** | Engineering-facing forensic review of six compiler dispersion defects. Highest-risk items are endpoint double-counting and the order-dependent Phase 2 non-exhaustive branch-group prior |

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
| [cohort-maturity/INDEX.md](cohort-maturity/INDEX.md) | **Active** (7-Apr-26) | 9 docs. Posterior-predictive simulator live. **Open bug**: sparse `cohort_at_tau` → zero-width bands |

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
