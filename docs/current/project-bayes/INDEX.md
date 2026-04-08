# Project Bayes — Document Index

**Last updated**: 8-Apr-26

Complete index of all design docs, investigation notes, reference
material, and operational guides in `docs/current/project-bayes/`.
For sequencing, priorities, and current status snapshot, see
[programme.md](programme.md).

---

## How to use this index

- **Status** reflects the most recent known state, reconciled between
  each doc's header and the programme.md body. Where they disagree,
  programme.md is authoritative (it is updated more frequently).
- **Docs are grouped by theme**, not by number. Numbered prefixes
  reflect chronological creation order, not importance.
- The `cohort-maturity/` subdirectory has its own
  [INDEX.md](cohort-maturity/INDEX.md) — listed here as a single
  entry with a summary; consult that index for individual docs.

---

## Core architecture and infrastructure

| # | File | Status | Scope |
|---|------|--------|-------|
| 0 | [0-high-level-logical-blocks.md](0-high-level-logical-blocks.md) | Stub | Graph-to-hierarchy compiler, model structure, inference pipeline. High-level logical decomposition. |
| 1 | [1-cohort-completeness-model-contract.md](1-cohort-completeness-model-contract.md) | Draft | Cohort semantics, model ownership, evaluator unification. The foundational contract for completeness computation. |
| 2 | [2-reference-implementation-notes.md](2-reference-implementation-notes.md) | Reference | PyMC patterns, prior art review. Implementation notes from early research phase. |
| 3 | [3-compute-and-deployment-architecture.md](3-compute-and-deployment-architecture.md) | Draft | Compute vendor (Modal), deployment topology, shared code, DB access. |
| 4 | [4-async-roundtrip-infrastructure.md](4-async-roundtrip-infrastructure.md) | Done | Async roundtrip: FE submission, remote worker, webhook, atomic git commit, schema. All 6 steps implemented 16-Mar-26. |
| 5 | [5-local-dev-setup.md](5-local-dev-setup.md) | Reference | Local dev environment, tunnel, deployment. Operational guide. |

## Compiler and model pipeline

| # | File | Status | Scope |
|---|------|--------|-------|
| 6 | [6-compiler-and-worker-pipeline.md](6-compiler-and-worker-pipeline.md) | Draft | Compiler IR, model materialisation, worker orchestration, evidence assembly. The main compiler design doc. |
| 8 | [8-compiler-implementation-phases.md](8-compiler-implementation-phases.md) | Phases A–D done; Phase C next | Phased delivery: A (independent), B (Dirichlet), S (snapshot evidence), D (latency coupling), C (slices), E (fan-out). Entry/exit criteria per phase. |
| 18 | [18-compiler-journal.md](18-compiler-journal.md) | Active (ongoing) | Chronological record of what was tried, what worked, what failed, and key invariants discovered. ~4400 lines. Prevents re-exploring dead ends. |

## Model design and likelihood

| # | File | Status | Scope |
|---|------|--------|-------|
| 23 | [23-two-phase-model-design.md](23-two-phase-model-design.md) | Phase 1 done (27-Mar-26); Phase 2 needs stabilisation | Window-to-cohort two-phase architecture. DM-to-Binomial likelihood rewrite, onset obs, t95 constraint. Production del-to-reg inflation reduced 1.94x to 1.19x. |
| 24 | [24-phase2-redesign.md](24-phase2-redesign.md) | Design — partially implemented | Posterior-as-prior with ESS-decayed Dirichlet/Beta for Phase 2. Replaces freeze+drift mechanism. |
| 18L | [18-latent-onset-design.md](18-latent-onset-design.md) | Design | Latent edge-level onset, graph-level onset hyperprior and dispersion (`tau_onset`), path-level onset with learned dispersion. Replaces fixed histogram-derived onset. |

## Evidence and snapshot integration

| # | File | Status | Scope |
|---|------|--------|-------|
| 11 | [11-snapshot-evidence-assembly.md](11-snapshot-evidence-assembly.md) | In progress — Stage 1 (evidence binder rewrite) | Phase S: direct snapshot DB queries replace inline param-file evidence. FE fetch plan, worker DB integration, maturation trajectories. |
| 12 | [12-drift-detection-notes.md](12-drift-detection-notes.md) | Implemented (19-Mar-26) | Temporal adaptation: recency weighting approaches. Exponential recency weighting for evidence assembly. |

## Regime selection and BE resolution

| # | File | Status | Scope |
|---|------|--------|-------|
| 30 | [30-snapshot-regime-selection-contract.md](30-snapshot-regime-selection-contract.md) | Partially implemented (8-Apr-26) | FE/BE regime selection contract: one regime per (edge, anchor_day, retrieved_at). BE utility + API wiring done. FE candidate construction done. FE preflight removal (Phase 5) pending. Bayes evidence binder regime tests (RB-001-005) outstanding. |
| 30b | [30b-regime-selection-worked-examples.md](30b-regime-selection-worked-examples.md) | Working document | Concrete worked examples for the regime selection contract. Edge cases, multi-context reasoning, double-counting analysis. Companion to doc 30. |
| 31 | [31-be-analysis-subject-resolution.md](31-be-analysis-subject-resolution.md) | Design — not implemented | Move DSL resolution from FE to BE. FE sends DSL string + candidate regimes; BE resolves path structure natively. Enables clean multi-hop maturity. Depends on doc 30. |

## Phase C (context slices)

| # | File | Status | Scope |
|---|------|--------|-------|
| 14 | [14-phase-c-slice-pooling-design.md](14-phase-c-slice-pooling-design.md) | Ready for implementation | Phase C detailed design: slice DSL parsing, IR extension, solo-edge pooling, hierarchical Dirichlet for branch groups, conditional_p, posterior.slices output, Phase D interaction. Revised 7-Apr-26 for doc 30 alignment. |

## Posterior schema, consumption, and overlay

| # | File | Status | Scope |
|---|------|--------|-------|
| 21 | [21-unified-posterior-schema.md](21-unified-posterior-schema.md) | Done (25-Mar-26) | Single `posterior.slices` keyed by DSL replaces split probability/latency blocks. Per-slice p + latency, `_model_state` for warm-start. |
| 9 | [9-fe-posterior-consumption-and-overlay.md](9-fe-posterior-consumption-and-overlay.md) | Draft — FE overlay sections substantially done | FE changes for posterior display, settings, fit guidance, stats deletion schedule. Phase A overlay built 18-Mar-26. |
| 7 | [7-asat-analysis-completion.md](7-asat-analysis-completion.md) | Draft | Historic asat through analysis/charting (Phase A), future asat with forecasts (Phase B). |
| 25P | [25-posterior-slice-resolution-and-analysis-type-review.md](25-posterior-slice-resolution-and-analysis-type-review.md) | Done (29-Mar-26) | Query-driven posterior slice projection in cascade + analysis graph composition. Systematic review of all analysis types for correct promoted scalars, window/cohort/context sensitivity. |
| 27 | [27-fit-history-fidelity-and-asat-posterior.md](27-fit-history-fidelity-and-asat-posterior.md) | Design | Full-fidelity posterior snapshots in fit_history. As-at posterior reconstruction. Date-bounded retention policy (replaces count-bounded). |
| 32 | [32-posterior-predictive-scoring-design.md](32-posterior-predictive-scoring-design.md) | Design — not implemented | Per-edge LOO-ELPD model adequacy scoring, benchmarked against analytic stats pass as null model. Assesses p and kappa via three distribution likelihood types. Surfaces in Forecast Quality overlay, Edge Info Model tab, PosteriorIndicator. |

## Quality, gating, and diagnostics

| # | File | Status | Scope |
|---|------|--------|-------|
| 13 | [13-model-quality-gating-and-preview.md](13-model-quality-gating-and-preview.md) | Sections 1.1-1.3 implemented (7-Apr-26); sections 2-3 pending | Model quality signalling (progress, session log, Graph Issues), auto-enable Forecast Quality, accept/reject preview workflow. Quality tiers wired into UI. |
| 10 | [10-topology-signatures.md](10-topology-signatures.md) | Design sketch | Per-fit-unit structural fingerprinting for posterior staleness detection. Not blocking nightly scheduling (gated on doc 28 instead). |

## Dispersion (kappa) and uncertainty

| # | File | Status | Scope |
|---|------|--------|-------|
| 19D | [19-dispersion-investigation-plan.md](19-dispersion-investigation-plan.md) | Superseded (31-Mar-26) | kappa recovery investigation plan, hypotheses, synth test protocol. Superseded by unified MCMC kappa approach (see journal 30-31-Mar-26). |
| 25K | [25-kappa-discrepancy-investigation.md](25-kappa-discrepancy-investigation.md) | Superseded (31-Mar-26) | 12x window/cohort kappa discrepancy traced to CDF maturity adjustment. Historical context only — superseded by MCMC kappa which avoids CDF adjustment. |
| — | [heuristic-dispersion-design.md](heuristic-dispersion-design.md) | Proposal — edge-level parity confirmed (2-Apr-26) | Heuristic SDs (p_sd, mu_sd, sigma_sd, onset_sd, onset_mu_corr) for the non-Bayes analytic stats pass. Provides uncertainty envelopes when Bayes has not run. Edge-level parity at 1e-9 via Vector 6. Path-level propagation implemented both sides. |

## Phase 2 stabilisation and onset

| # | File | Status | Scope |
|---|------|--------|-------|
| 26 | [26-phase2-onset-drift.md](26-phase2-onset-drift.md) | Fix implemented (30-Mar-26) | Phase 2 cohort onset drift diagnosis: warm-start from previous cohort posterior bypassed Phase 1. Fix: removed `cohort_latency_warm` override; all Phase 2 priors derive from Phase 1. |

## Model variables, provenance, and parameters

| # | File | Status | Scope |
|---|------|--------|-------|
| 15 | [15-model-vars-provenance-design.md](15-model-vars-provenance-design.md) | Draft | Model variable sets with provenance on graph edges, source selection, scalar promotion. Supersedes programme.md "Model variable precedence" section and doc 9 sections 5.7-5.8. |
| 19M | [19-model-vars-production-consumption-separation.md](19-model-vars-production-consumption-separation.md) | Done | `promoted_t95` separates user-configured t95 from model output. Prevents Bayesian t95 overwriting user's horizon guidance. |
| 16 | [16-lag-array-population-defect.md](16-lag-array-population-defect.md) | Open — low priority | Window-type values[] entries had zero lag arrays. Partially populated as of 31-Mar-26 (71/207 nonzero). Warm-start bypasses first-run prior issue; onset obs provide direct data-driven priors. |

## FE/BE stats parity and deletion

| # | File | Status | Scope |
|---|------|--------|-------|
| 19B | [19-be-stats-engine-bugs.md](19-be-stats-engine-bugs.md) | Open — low priority | Three-way prior discrepancy (FE vs BE vs topology) on latency inference. Only topology moment-match converges. Warm-start bypasses this path. |

## Data flow traces

| # | File | Status | Scope |
|---|------|--------|-------|
| — | [t95-hdi-data-flow.md](t95-hdi-data-flow.md) | Reference | Exhaustive trace of t95 HDI from MCMC inference through every consumer: inference, posterior writer, webhook, param file, FE reading, analysis compute, chart rendering. File, line, field name at each stage. |

## Synthetic data and testing

| # | File | Status | Scope |
|---|------|--------|-------|
| 17 | [17-synthetic-data-generator.md](17-synthetic-data-generator.md) | Phase 1 implemented (21-Mar-26) | Monte Carlo simulator for parameter recovery testing. General-purpose over any graph topology, DB-backed. Phase 2 (context slices) not yet built. |
| 19S | [19-synthetic-data-playbook.md](19-synthetic-data-playbook.md) | Reference | Step-by-step operational guide for creating synth graphs, generating data, running parameter recovery. |

## Performance and sampling

| # | File | Status | Scope |
|---|------|--------|-------|
| 22 | [22-sampling-performance.md](22-sampling-performance.md) | Research complete; no experiments run | MCMC performance bottleneck analysis: compilation time (155s on branch graph), GPU vs CPU, optimisation paths. Not blocking any current phase. |
| 20 | [20-trajectory-compression-briefing.md](20-trajectory-compression-briefing.md) | Resolved (24-Mar-26) | Zero-count bin filter, smooth clip floors fix, NUTS sensitivity analysis. |

## Automation and scheduling

| # | File | Status | Scope |
|---|------|--------|-------|
| 28 | [28-bayes-run-reconnect-design.md](28-bayes-run-reconnect-design.md) | Implemented (7-Apr-26) | 3-phase automation pipeline (Phase 0 patch apply, Phase 1 fetch+commission, Phase 2 drain), `runBayes` flag, reconnect mechanism. All 5 design phases complete. Needs production testing. |

## Forecast engine and multi-hop maturity

| # | File | Status | Scope |
|---|------|--------|-------|
| 29 | [29-generalised-forecast-engine-design.md](29-generalised-forecast-engine-design.md) | Design (pre-implementation) | Forecast-state contract, basis unification, reusable layers, A-to-Z multi-hop maturity (Phase A), known approximations. Includes post-doc-31 variant for regime coherence. |

## Reference and domain knowledge

| # | File | Status | Scope |
|---|------|--------|-------|
| — | [statistical-domain-summary.md](statistical-domain-summary.md) | Reference | Statistical foundations and domain concepts. Consolidated understanding of DagNet's statistical architecture. |
| — | [bayes-join-node-convergence-briefing.md](bayes-join-node-convergence-briefing.md) | Resolved (journal 23-Mar-26) | Join-node latency model geometry. Resolved by mixture CDF. |

## Cohort maturity (subdirectory)

| File | Status | Scope |
|------|--------|-------|
| [cohort-maturity/INDEX.md](cohort-maturity/INDEX.md) | Active (7-Apr-26) | **9 docs.** Fan chart spec, full Bayes design, backend propagation engine, per-cohort-date x estimation, project overview, test harness context, MC bug investigation, conditioning attempts audit trail, Option 1.5 analysis. See subdirectory INDEX for individual doc status and recommended reading order. |

---

## Programme and sequencing

| File | Status | Scope |
|------|--------|-------|
| [programme.md](programme.md) | Active (8-Apr-26) | Phased delivery plan, current status snapshot, dependency lattice, workstream definitions, next priorities. **This doc owns sequencing**; design docs contain the detail. |

---

## Document numbering notes

- Numbers reflect creation order, not importance or reading order.
- Number `12` was originally "drift detection"; some numbers have
  multiple docs (e.g. `18` = compiler journal + latent onset; `19` =
  four different docs; `25` = two different docs). The prefix
  identifies era, not topic.
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
