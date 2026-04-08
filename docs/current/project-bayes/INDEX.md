# Project Bayes — Document Index

**Last updated**: 8-Apr-26
**Verified against codebase**: 8-Apr-26

Complete index of all design docs, investigation notes, reference
material, and operational guides in `docs/current/project-bayes/`.
For sequencing, priorities, and current status snapshot, see
[programme.md](programme.md).

---

## How to use this index

- **Status is code-verified** — each entry was checked against the
  actual codebase on 8-Apr-26. Where a doc header says one thing and
  the code says another, the code wins.
- **Docs are grouped by theme**, not by number. Numbered prefixes
  reflect chronological creation order, not importance.
- The `cohort-maturity/` subdirectory has its own
  [INDEX.md](cohort-maturity/INDEX.md) — listed here as a single
  entry with a summary; consult that index for individual docs.

### Status key

| Label | Meaning |
|-------|---------|
| **Implemented** | Feature described is live in the codebase and verified |
| **Partial** | Some sections implemented, others not — detail in notes |
| **Design only** | No corresponding implementation found in code |
| **Superseded** | Approach replaced by a different solution |
| **Reference** | Informational doc with no implementation claims |
| **Open defect** | Bug documented but not fixed |

---

## Core architecture and infrastructure

| # | File | Status | Notes |
|---|------|--------|-------|
| 0 | [0-high-level-logical-blocks.md](0-high-level-logical-blocks.md) | **Implemented** (doc header says "Stub") | Compiler pipeline fully built in `bayes/compiler/`: `analyse_topology` -> `bind_evidence`/`bind_snapshot_evidence` -> `build_model` -> `run_inference` -> `summarise_posteriors`. Doc header is stale — the logical blocks it describes are all implemented. |
| 1 | [1-cohort-completeness-model-contract.md](1-cohort-completeness-model-contract.md) | **Partial** | `query_mode` threading implemented (`stats_engine.py:18,97`). Completeness semantics live in `bayes/compiler/completeness.py` and `evidence.py`. But the doc's specific `_resolve_completeness_params()` function and formal `completeness_model` object per subject are not present as named — semantics are delivered via `bind_evidence` instead. |
| 2 | [2-reference-implementation-notes.md](2-reference-implementation-notes.md) | **Reference** | PyMC patterns from external repo `ccl08/dagnet-bayesian-analysis`. Research/validation patterns — no implementation claims. |
| 3 | [3-compute-and-deployment-architecture.md](3-compute-and-deployment-architecture.md) | **Implemented** (doc header says "Draft") | `bayes/app.py`: `modal.App("dagnet-bayes")`, image build with PyTensor/BLAS, `/submit` endpoint spawning workers, `/status` polling, `/cancel`. All described infrastructure built. |
| 4 | [4-async-roundtrip-infrastructure.md](4-async-roundtrip-infrastructure.md) | **Implemented** | All 6 steps verified: (1) FE config fetch in `useBayesTrigger.ts`, (2) encrypted callback token, (3) submit to Modal, (4) worker execution in `worker.py:fit_graph()`, (5) webhook atomic git commit via `bayes-webhook.ts` + `atomicCommitFiles`, (6) FE poll + pull. Retry-with-rebase on 422 conflict. |
| 5 | [5-local-dev-setup.md](5-local-dev-setup.md) | **Reference** | Operational guide: local vs Modal modes, prerequisites, tunnel setup. No false claims. |

## Compiler and model pipeline

| # | File | Status | Notes |
|---|------|--------|-------|
| 6 | [6-compiler-and-worker-pipeline.md](6-compiler-and-worker-pipeline.md) | **Implemented** (doc header says "Draft") | IR boundary fully built: `TopologyAnalysis`, `BoundEvidence` as pure Python dataclasses in `types.py`. Three-function boundary wired into `worker.py:fit_graph()` (lines 415-516). Phase A production-ready. |
| 8 | [8-compiler-implementation-phases.md](8-compiler-implementation-phases.md) | **Partial** | Phase A: `test_compiler_phase_a.py` — Beta+Binomial, warm-start. Phase B: `test_compiler_phase_b.py` — DirichletMultinomial for branch groups (`model.py:531-610`). Phase S: `test_compiler_phase_s.py` — `bind_snapshot_evidence()` (`evidence.py:197-343`). Phase D: latent onset feature-flagged (`model.py:321`), two-phase model live. **Phase C**: `slices.py` has DSL parsing and `SliceGroup` routing, but hierarchical Dirichlet pooling model emission **not yet built**. Phase E: not started. |
| 18J | [18-compiler-journal.md](18-compiler-journal.md) | **Active** | ~4400 lines. Last entry: 6-Apr-26 (harness hash-mapping closure gap, transitive closure cross-contamination). Actively maintained. |

## Model design and likelihood

| # | File | Status | Notes |
|---|------|--------|-------|
| 23 | [23-two-phase-model-design.md](23-two-phase-model-design.md) | **Implemented** | Two-phase model fully operational. `worker.py:557-877`: Phase 1 builds window model, extracts posteriors (p_alpha/beta, mu, sigma, onset with SDs), Phase 2 receives `phase2_frozen` dict. `model.py:359`: `is_phase2 = phase2_frozen is not None` controls behaviour throughout. DM->Binomial and BB->Binomial likelihood rewrites done. Onset observations used as direct constraints. |
| 24 | [24-phase2-redesign.md](24-phase2-redesign.md) | **Implemented** (doc header says "Design") | `model.py:262-285`: `_ess_decay_scale()` implements ESS decay formula. Lines 1054-1056: Phase 2 cohort p declared as `pm.Beta(alpha=max(p_alpha*scale,...))`. Branch group Phase 2 uses same mechanism at lines 588-590. Posterior-as-prior with ESS decay is live. |
| 18L | [18-latent-onset-design.md](18-latent-onset-design.md) | **Implemented** (doc header says "Design") | `model.py:321`: `latent_onset: bool` (default `True`). Feature-flagged throughout (`feat_latent_onset`). Lines 2032-2033 distinguish latent vs fixed onset. Independent per-edge onset as learned PyTensor variable with MCMC estimation. Graph-level hierarchy removed (no intellectual justification — see journal 23-Mar-26). |

## Evidence and snapshot integration

| # | File | Status | Notes |
|---|------|--------|-------|
| 11 | [11-snapshot-evidence-assembly.md](11-snapshot-evidence-assembly.md) | **Implemented** (doc header says "In progress") | `bind_snapshot_evidence()` fully implemented (`evidence.py:197-343`). Converts snapshot DB rows to observations, falls back to param files per edge, merges trajectories + supplemental daily obs. `test_compiler_phase_s.py` exercises full pipeline. Stage 1 (evidence binder rewrite) is complete. |
| 12 | [12-drift-detection-notes.md](12-drift-detection-notes.md) | **Implemented** | `evidence.py:346`: `_apply_recency_weights()` sets `traj.recency_weight = exp(-ln2 * age / half_life_days)`. `types.py:175`: `recency_weight: float = 1.0`. `model.py:2077,2138,2208`: consumed in likelihood assembly. |

## Regime selection and BE resolution

| # | File | Status | Notes |
|---|------|--------|-------|
| 30 | [30-snapshot-regime-selection-contract.md](30-snapshot-regime-selection-contract.md) | **Partial** | BE: `lib/snapshot_regime_selection.py` (145 lines) — `select_regime_rows()`, `CandidateRegime`, `RegimeSelection`. FE: `candidateRegimeService.ts` (185 lines) — `buildCandidateRegimesByEdge()`. Tests: `test_regime_handler_integration.py`, `test_snapshot_regime_selection.py`, `candidateRegimeService.test.ts`. **Not done**: FE preflight removal (Phase 5), Bayes evidence binder regime tests (RB-001-005). |
| 30b | [30b-regime-selection-worked-examples.md](30b-regime-selection-worked-examples.md) | **Reference** | Companion to doc 30. Concrete worked examples for edge cases, multi-context reasoning, double-counting analysis. No implementation claims. |
| 31 | [31-be-analysis-subject-resolution.md](31-be-analysis-subject-resolution.md) | **Design only** | Zero matches for `resolve_subject`, `resolve_dsl`, `analysis_subject` in codebase. FE resolution still active (`mapFetchPlanToSnapshotSubjects`). BE subject resolution not built. Depends on doc 30. |

## Phase C (context slices)

| # | File | Status | Notes |
|---|------|--------|-------|
| 14 | [14-phase-c-slice-pooling-design.md](14-phase-c-slice-pooling-design.md) | **Design only** (prerequisites met) | `slices.py` has DSL parsing and dimension extraction, `evidence.py:1236-1350` routes slices into `SliceGroup` structures. But hierarchical Dirichlet pooling is **not emitted in model.py** — the model-building step for Phase C is unbuilt. Prerequisites (Phase S, Phase D, doc 21) are done. |

## Posterior schema, consumption, and overlay

| # | File | Status | Notes |
|---|------|--------|-------|
| 21 | [21-unified-posterior-schema.md](21-unified-posterior-schema.md) | **Implemented** | `parameter-schema.yaml:209-309`: `posterior.slices` keyed by DSL string with `SlicePosteriorEntry`. `graph_types.py:155`: `SlicePosteriorEntry`, line 234: `Posterior` with `slices: Dict[str, SlicePosteriorEntry]`. `posteriorSliceResolution.ts:145-202`: actively resolves both probability and latency from unified schema. `_model_state` nested as model internals. |
| 9 | [9-fe-posterior-consumption-and-overlay.md](9-fe-posterior-consumption-and-overlay.md) | **Implemented** (doc header says "Draft") | `BayesPosteriorCard.tsx` (100+ lines): renders probability + latency posteriors with quality tier, HDI, ESS, freshness. `PosteriorIndicator.tsx` (80+ lines): badge + hover popover. `useBayesTrigger.ts`: full roundtrip. Types in `index.ts:742-806`: `ProbabilityPosterior`, `LatencyPosterior`, `SlicePosteriorEntry`. All core FE overlay components built and wired. |
| 7 | [7-asat-analysis-completion.md](7-asat-analysis-completion.md) | **Partial** | Snapshot routing and data fetching handle asat correctly (`_asat_retrieved_at` annotation in `fileToGraphSync.ts:328`, `getFromSourceDirect.ts:487`). Integration test `asatPosteriorResolution.integration.test.ts` exists. **Not done**: typed `asat_date` field on `AnalysisResult`, chart subtitle/badge rendering (Phase A surface layer). |
| 25P | [25-posterior-slice-resolution-and-analysis-type-review.md](25-posterior-slice-resolution-and-analysis-type-review.md) | **Implemented** | `posteriorSliceResolution.ts:93-120`: `resolvePosteriorSlice()` — takes slices dict + effective DSL, builds ideal key, matches with fallback to aggregate. `projectProbabilityPosterior()` and `projectLatencyPosterior()` integrated into cascade via `mappingConfigurations.ts:22,793,803`. |
| 27 | [27-fit-history-fidelity-and-asat-posterior.md](27-fit-history-fidelity-and-asat-posterior.md) | **Design only** | Types ready (`FitHistoryEntry`, `FitHistorySlice` in `index.ts:701-732`). Settings ready (`bayes_fit_history_max_days=100`, `bayes_fit_history_interval_days=0` in `forecasting_settings.py:68-72`). But `worker.py` does **not** append to `fit_history` — only current `slices["window()"]` and `slices["cohort()"]` are written. Full-fidelity archival and asat() posterior reconstruction are not built. |
| 32 | [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md) | **Design only** | Zero matches for `loo_elpd`, `elpd`, `predictive_score`, `pointwise_log_lik` in `bayes/`. No scoring code, likelihood extraction, or PSIS integration. |

## Quality, gating, and diagnostics

| # | File | Status | Notes |
|---|------|--------|-------|
| 13 | [13-model-quality-gating-and-preview.md](13-model-quality-gating-and-preview.md) | **Partial** | Sections 1.1-1.3: `bayesQualityTier.ts` defines `QualityTierLevel` (failed/warning/good-0..3/no-data). `useBayesTrigger.ts:624-625`: `computeGraphQualityTier()`. Per-edge quality tier, progress indicator, session log entry points all live. **Not done**: sections 2-3 (accept/reject preview workflow). No preview UI code found. |
| 10 | [10-topology-signatures.md](10-topology-signatures.md) | **Design only** | `topology_signature` only found in the doc itself. `TopologyAnalysis` has a fingerprint field (`types.py`) used for model cache identity, but per-fit-unit staleness detection and UI surfacing are not built. Not blocking nightly scheduling. |

## Dispersion (kappa) and uncertainty

| # | File | Status | Notes |
|---|------|--------|-------|
| 19D | [19-dispersion-investigation-plan.md](19-dispersion-investigation-plan.md) | **Superseded** | Replaced by unified MCMC kappa per edge (31-Mar-26). `model.py:1008-1019,1217`: unified `edge_kappa` with LogNormal prior, warm-start from `kappa_warm`. `worker.py:596-598`: "MCMC kappa is the source of truth. MLE is diagnostic only." |
| 25K | [25-kappa-discrepancy-investigation.md](25-kappa-discrepancy-investigation.md) | **Superseded** | 12x kappa discrepancy caused by CDF maturity adjustment in Williams method. Bypassed entirely — unified MCMC kappa avoids Williams-based CDF adjustment. Historical context only. |
| — | [heuristic-dispersion-design.md](heuristic-dispersion-design.md) | **Implemented** | BE: `stats_engine.py:608-650` computes `p_sd`, `mu_sd`, `sigma_sd`, `onset_sd`, `onset_mu_corr` per sections 3.1-3.4 of design. Path-level: `stats_engine.py:1038-1044` quadrature sum (`path_mu_sd = sqrt(mu_sd^2 + upstream_mu_sd^2)`). FE: `confidence_bands.py:70,103` consumes all 5 fields in 4x4 covariance matrix. Edge-level parity at 1e-9 (Vector 6). |

## Phase 2 stabilisation and onset

| # | File | Status | Notes |
|---|------|--------|-------|
| 26 | [26-phase2-onset-drift.md](26-phase2-onset-drift.md) | **Implemented** | `cohort_latency_warm` field still read from param files (`evidence.py:1206-1216`) and stored in `EdgeEvidence` (`types.py:282`), but **no longer used** in `model.py` for Phase 2 prior construction. `model.py:841-850` comment: "Phase 2 receives NO priors from external sources. All priors derive from Phase 1." Phase 2 latency priors come from Phase 1 trace (`worker.py:691-706`). Dead field not yet cleaned up. |

## Model variables, provenance, and parameters

| # | File | Status | Notes |
|---|------|--------|-------|
| 15 | [15-model-vars-provenance-design.md](15-model-vars-provenance-design.md) | **Implemented** (doc header says "Draft") | `index.ts:629`: `ModelVarsEntry` with `source`, `source_at`, `probability`, `latency`, `quality`. `modelVarsResolution.ts`: `resolveActiveModelVars()`, `promoteModelVars()`, `effectivePreference()`. Edge-level `model_vars[]` array implemented. Tested in `modelVarsResolution.test.ts`. |
| 19M | [19-model-vars-production-consumption-separation.md](19-model-vars-production-consumption-separation.md) | **Implemented** | `graph_types.py:72-74`: `promoted_t95`, `promoted_onset_delta_days` as read-only fields. `localAnalysisComputeService.ts:417,576,623`: `lat.promoted_onset_delta_days ?? lat.onset_delta_days` fallback. Separation enforced and tested. |
| 16 | [16-lag-array-population-defect.md](16-lag-array-population-defect.md) | **Open defect** | Window `values[]` entries have zero lag arrays; cohort entries have 80+ non-zero per slice. `topology.py:115-127` reads `median_lag`/`mean_lag`, `completeness.py:323-334` consumes them. Defect unresolved but low priority — warm-start bypasses first-run prior issue, onset obs provide direct data-driven priors. |

## FE/BE stats parity and deletion

| # | File | Status | Notes |
|---|------|--------|-------|
| 19B | [19-be-stats-engine-bugs.md](19-be-stats-engine-bugs.md) | **Open defect** | Three-way discrepancy (FE vs BE vs topology) on latency priors confirmed live. Only topology's crude moment-match (`completeness.py:derive_latency_prior()`) produces convergent MCMC. Low priority — warm-start bypasses. |

## Data flow traces

| # | File | Status | Notes |
|---|------|--------|-------|
| — | [t95-hdi-data-flow.md](t95-hdi-data-flow.md) | **Reference** (verified accurate) | Trace verified against code: `inference.py:817-818` edge t95 HDI, `inference.py:922-923` path t95 HDI, fields written to `LatencyPosteriorSummary` at lines 849-850 and 938-939. Data flow matches doc exactly through all stages. |

## Synthetic data and testing

| # | File | Status | Notes |
|---|------|--------|-------|
| 17 | [17-synthetic-data-generator.md](17-synthetic-data-generator.md) | **Implemented** (Phase 1) | `bayes/synth_gen.py`: `simulate_graph()`, `_generate_observations_nightly()`, `write_to_snapshot_db()`, `write_parameter_files()`. Supports arbitrary graphs via `GRAPH_CONFIGS`, drift, context slices. DB write and parameter recovery operational. **Phase 2** (context slice generation) not yet built. |
| 19S | [19-synthetic-data-playbook.md](19-synthetic-data-playbook.md) | **Reference** (verified operational) | References real scripts in `graph-ops/scripts/` (all confirmed present: `validate-graph.sh`, `param-pack.sh`, etc.). Step-by-step guide for synth graph creation, data generation, parameter recovery. |

## Performance and sampling

| # | File | Status | Notes |
|---|------|--------|-------|
| 22 | [22-sampling-performance.md](22-sampling-performance.md) | **Research only** — no experiments run | Stack remains PyTensor/numba/nutpie (`requirements.txt`: `nutpie>=0.16`, `pymc>=5.28`). No `numpyro`, `jax`, or `freeze_model` in codebase. No GPU experiments attempted. Not blocking. |
| 20 | [20-trajectory-compression-briefing.md](20-trajectory-compression-briefing.md) | **Implemented** | `evidence.py:470-478,622`: `zero_count_filter` feature flag (default `True`). Comment: "Likelihood-lossless: gammaln(0+alpha)-gammaln(alpha)=0." Smooth clip floors fix operational. |

## Automation and scheduling

| # | File | Status | Notes |
|---|------|--------|-------|
| 28 | [28-bayes-run-reconnect-design.md](28-bayes-run-reconnect-design.md) | **Implemented** | `bayesReconnectService.ts` (426 lines): `reconcileBayesFitJob` with probe grace/stale cutoff thresholds. `bayesPatchService.ts` (721 lines): `applyPatchAndCascade`, `scanForPendingPatches`. Integrated into `dailyAutomationJob.ts`. All 5 design phases verified in code. Needs production testing. |

## Forecast engine and multi-hop maturity

| # | File | Status | Notes |
|---|------|--------|-------|
| 29 | [29-generalised-forecast-engine-design.md](29-generalised-forecast-engine-design.md) | **Design only** | No `ForecastState` type, `compose_path_forecast`, or `compose_path_maturity` found anywhere. No unified forecast contract in `graph-editor/lib/` or `graph-editor/src/`. Steps 1-3 (forecast-state contract, basis resolution, scalar/trajectory/frontier layers) all unbuilt. |

## Reference and domain knowledge

| # | File | Status | Notes |
|---|------|--------|-------|
| — | [statistical-domain-summary.md](statistical-domain-summary.md) | **Reference** | Concept definitions, domain glossary. No implementation claims. |
| — | [bayes-join-node-convergence-briefing.md](bayes-join-node-convergence-briefing.md) | **Implemented** (doc header says "Blocked") | `completeness.py:151-205`: `moment_matched_collapse()` — join-node mixture CDF with moment matching. Lines 208-226: `pt_moment_matched_collapse()` — differentiable PyTensor version for MCMC. Doc header is stale ("Blocked" from 20-Mar-26); programme.md correctly notes resolved 23-Mar-26. All 8 structural topologies converge. |

## Cohort maturity (subdirectory)

| File | Status | Notes |
|------|--------|-------|
| [cohort-maturity/INDEX.md](cohort-maturity/INDEX.md) | **Active** (7-Apr-26) | **9 docs.** `cohort_forecast.py` is a posterior-predictive simulator (direct posterior MVN draws, per-cohort drift, per-cohort frontier conditioning). Dense `obs_x`/`obs_y` arrays precomputed. `tau_observed` from real evidence depth. **Open bug**: `fan-chart-mc-bug.md` — sparse `cohort_at_tau` in cohort mode producing zero-width bands (root cause documented, fix not implemented). See subdirectory INDEX for individual doc status. |

---

## Programme and sequencing

| File | Status | Notes |
|------|--------|-------|
| [programme.md](programme.md) | **Active** (8-Apr-26) | Phased delivery plan, current status snapshot, dependency lattice, workstream definitions, next priorities. **This doc owns sequencing**; design docs contain the detail. |

---

## Stale doc headers

The following docs have headers that disagree with the code. Their
actual status (verified above) should be trusted over the header.

| Doc | Header says | Code shows |
|-----|-------------|------------|
| 0 | Stub | Implemented — full compiler pipeline |
| 3 | Draft | Implemented — Modal app fully built |
| 6 | Draft | Implemented — IR boundary and three-function design |
| 9 | Draft | Implemented — all FE overlay components built |
| 11 | In progress | Implemented — Stage 1 evidence binder complete |
| 15 | Draft | Implemented — model_vars resolution live and tested |
| 18L (latent onset) | Design | Implemented — feature-flagged, default on |
| 24 | Design | Implemented — ESS decay + posterior-as-prior live |
| Join-node convergence | Blocked | Implemented — mixture CDF resolves join geometry |

---

## Document numbering notes

- Numbers reflect creation order, not importance or reading order.
- Some numbers have multiple docs (e.g. `18` = compiler journal +
  latent onset; `19` = four different docs; `25` = two different
  docs). The prefix identifies era, not topic.
- Unnumbered docs (`heuristic-dispersion-design.md`,
  `t95-hdi-data-flow.md`, `statistical-domain-summary.md`,
  `bayes-join-node-convergence-briefing.md`) were created as
  standalone investigations or reference material.
- The `cohort-maturity/` subdirectory was split out when the topic
  grew to 9 docs.

## Cross-references

- **App architecture**: `../codebase/APP_ARCHITECTURE.md`
- **Snapshot DB**: `../project-db/`
- **Hash/signature infrastructure**: `../codebase/HASH_SIGNATURE_INFRASTRUCTURE.md`
- **DSL syntax**: `../codebase/DSL_SYNTAX_REFERENCE.md`
- **FE/BE stats parallelism**: `../codebase/FE_BE_STATS_PARALLELISM.md`
- **Parity plan and ledger**: `.claude/plans/inherited-floating-crown.md`
