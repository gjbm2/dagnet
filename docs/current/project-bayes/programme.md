# Project Bayes: Programme

**Status**: Active
**Updated**: 31-Mar-26
**Purpose**: Phased delivery plan for Project Bayes. This doc owns sequencing;
design docs contain the detail.

### Current status snapshot (31-Mar-26)

**Done**: Async infrastructure, Phase A–D compiler, FE overlay (basic
+ quality + model CDF + confidence bands), unified posterior schema,
synthetic data generator + 10-graph param recovery suite, two-phase
model architecture (posterior-as-prior), likelihood rewrite
(DM→Binomial), endpoint BetaBinomial for rate estimation, onset
observations, t95 soft constraint, posterior slice resolution (doc 25),
Phase 2 join-node CDF fix, full warm-start wiring with quality guard,
synth context data fix (`emit_context_slices` truth flag), unified
MCMC κ estimation (journal 30-31-Mar-26).

**Synth regression**: 5/10 pass, 5/10 fail. Failures are onset
convergence issues (pre-existing "Initial evaluation failed"), not
κ-related. Mirror-4step, simple-abc, diamond, drift10d10d, drift3d10d
pass.

**Dispersion (κ) recovery — synth-mirror-4step**:
Phase 1 (window, step-day) and Phase 2 (cohort, entry-day) both
data-constrained. Single-source validation:
- Step-day only (κ_step=30): Phase 1 recovers 6–9pp SD vs truth
  6–9pp for first 3 edges. Phase 2 correctly sees attenuated signal.
- Entry-day only (κ_entry=50): Phase 2 recovers 8pp for first edge
  (truth 5.4pp — overestimates). Downstream attenuates as expected
  (entry-day fades through latency mixing).
- 10× traffic improves downstream recovery but attenuation is real
  physics, not data volume.

**Production fit quality (bayes-test-gm-rebuild)**:
- All 4 edges converge (ESS 3.9k+, rhat ≤ 1.001) with analytic priors.
- Phase 1 κ: 17–185 (data-constrained, ±SD 3–47).
- Phase 2 κ: 27–578 (data-constrained for first edge, wider downstream).
- Rate SDs: 2.5–9.8pp (Phase 1), 1.3–7.5pp (Phase 2).
- Warm-start stable: κ identical across passes.

**Key architectural decisions locked in**:
1. Textbook Binomial for trajectories — no concentration-parameter bias
2. Per-retrieval onset from Amplitude histograms — data-driven
3. t95 soft constraint from analytics pass — prevents sigma inflation
4. Two-phase model — window Phase 1, frozen-p Phase 2 with
   posterior-as-prior (ESS-decayed Dirichlet/Beta)
5. **Unified MCMC κ per edge** — LogNormal prior, constrained by
   daily BetaBinomial + endpoint BetaBinomial. Replaces separate
   kappa/kappa_p variables and external Williams MLE (which is
   retained for diagnostic comparison only).
6. Quality-gated warm-start (rhat < 1.10, ESS ≥ 100)
7. Full kappa→alpha/beta→p_stdev→confidence bands pipeline verified
   for both window and cohort modes

**Resolved bugs** (29-Mar-26 sweep):
- ~~Posterior upsert on subsequent runs~~ — **FIXED 29-Mar-26**.
- ~~Posterior slice projection is not query-driven~~ — **FIXED
  29-Mar-26**. See doc 25.
- ~~Surprise gauge uses wrong slice~~ — **FIXED 29-Mar-26**. See
  doc 25 §3.1–3.2.
- ~~Cohort maturity curve uses window p, not cohort p~~ — **FIXED
  29-Mar-26**. See doc 25 §3.3.
- ~~Phase 2 p_cohort drift~~ — **FIXED**. Posterior-as-prior
  Dirichlet/Beta with ESS decay. See doc 24, journal 28-Mar-26.
- ~~Phase 2 convergence~~ — **FIXED**. Was ESS=7; now ESS=5k+ with
  warm-start, 100% converged.
- ~~Synth context data corruption~~ — **FIXED 29-Mar-26**.
  `emit_context_slices` flag; synth gen now emits bare slices by
  default.
- ~~Warm-start gaps~~ — **FIXED 29-Mar-26**. kappa, cohort latency
  (mu, sigma, onset) now all warm-started from previous posterior
  with quality gate. kappa_p removed 31-Mar-26 (unified into kappa).
- ~~No-latency F computation bug in dispersion estimator~~ — **FIXED
  30-Mar-26**. `_estimate_cohort_kappa` recomputed F from CDF
  instead of using evidence binder's completeness. For no-latency
  edges, CDF(1d) = 0.5, filtering 92% of observations. Fixed by
  checking `et.has_latency`.
- ~~Dispersion estimation using external MLE~~ — **RESOLVED
  31-Mar-26**. Replaced with unified MCMC κ per edge (LogNormal
  prior, daily BB + endpoint BB). MLE retained for diagnostics only.
- ~~run_regression.py misclassification~~ — **FIXED 29-Mar-26**.
  Parses param_recovery output before checking exit code.
- ~~Phase 2 cohort onset drift~~ — **FIXED 30-Mar-26**. Warm-start
  from previous cohort posterior bypassed Phase 1. Removed
  `cohort_latency_warm` override; all Phase 2 priors now derive
  from Phase 1. See doc 26.
- ~~Softplus onset leakage~~ — **FIXED 30-Mar-26**. Standard
  softplus leaked CDF mass below onset, enabling degenerate mode.
  Sharpened softplus (k=5) collapses the ridge.
- ~~Onset obs √N over-precision~~ — **FIXED 31-Mar-26**.
  Autocorrelation-corrected N_eff prevents claiming ±0.15d
  precision on a quantity that varies by ±2.4d.
- ~~Test assertions for promoted_onset~~ — **FIXED 31-Mar-26**.
  6 test files (20 tests) updated for `onset_delta_days` →
  `promoted_onset_delta_days` rename.

**Open issues**:

*Model quality — WATCH LIST (no blockers)*:
- ~~**Dispersion estimation: dual-kappa model**~~ — **RESOLVED
  31-Mar-26**. Abandoned external MLE approach. Unified MCMC κ per
  edge (LogNormal prior, daily BB + endpoint BB). Phase 1 κ measures
  step-day (window) variation; Phase 2 κ measures entry-day (cohort)
  variation. Both data-constrained. Synth single-source validation
  confirms correct attribution. MLE retained as diagnostic only.
  See journal 30-31-Mar-26.
  - **Known limitation**: entry-day κ under-recovered on downstream
    edges. This is real physics — upstream latency mixes cohorts
    across ~√(n_days_mixed) entry days, diluting the entry-day
    signal. 10× traffic helps but doesn't eliminate attenuation.
    Future: research whether crossed random effects GLMM could
    separate sources more precisely (see literature review in
    journal 30-Mar-26).
- **Path latency posteriors possibly too tight** — latest run shows
  cohort onset=17.4±0.2, mu=-1.13±0.11, sigma=2.86±0.05. Onset
  ±0.2 on 17.4 is ±1.2% — may still be over-precise. However,
  onset autocorrelation correction (31-Mar-26) may have improved
  this. Needs re-examination after onset fixes stabilise.
- **Onset-mu-sigma ridge (partially fixed)** — corr ≈ -0.99 on
  short-latency edges. Three fixes applied (doc 26, journal
  30-31-Mar-26):
  1. ~~Phase 2 warm-start bypass~~ — **FIXED**. Removed
     `cohort_latency_warm`; Phase 2 priors now derive from Phase 1
     composed values only.
  2. ~~Softplus CDF leakage~~ — **FIXED**. Sharpened softplus (k=5)
     collapses the degenerate (high onset, negative mu, huge sigma)
     mode.
  3. **Onset obs over-precision** — **FIXED**. Autocorrelation-
     corrected N_eff (ρ=0.89 → N_eff=2.8 for del-to-reg).
  **No longer blocking in practice**: warm-start quality gate rejects
  deranged posteriors; param files provide reasonable priors. Fresh
  runs use topology values from the stats pass. The narrow failure
  case (no param file + stale graph edge `p.latency` fields) is
  unlikely in production. Topology could benefit from bounds-checking
  on mu/sigma but this is low priority.
- ~~5/10 synth regression failures~~ — **FIXED 31-Mar-26**. Onset
  obs contributing -inf at starting point on 3way-join, fanout,
  join-branch, lattice, skip. Independently resolved.

*Other open*:
- ~~**Ad hoc hyperparameters** — kappa priors~~ — **PARTIALLY
  RESOLVED**. κ prior now LogNormal (Stan community consensus).
  Fallback ESS, Gamma spread still ad hoc.
- **BE stats engine prior discrepancy** — three-way discrepancy.
  See `19-be-stats-engine-bugs.md`.

*Not yet built*:
- **Topology signatures** (doc 10) — current code computes a single
  global hash (stub). Needs: per-fit-unit fingerprints, staleness
  detection on FE pull, UI surfacing of stale posteriors, warm-start
  invalidation when topology changes. Blocks nightly scheduling.
- **Model quality gating** (doc 13) — quality signalling (progress,
  session log, Graph Issues), auto-enable Forecast Quality,
  accept/reject preview. Designed, not built.
- **Mixture latency models** (doc 23 §12) — bimodal edges
  (e.g. registered-to-success) need mixture of two log-normals.
  Designed, not built.
- **Phase C posteriors** — context slice pooling, hierarchical
  shrinkage, per-slice visualisation. Prerequisites done
  (doc 21 ✓, doc 25 ✓). Includes fixing harness hash mismatch
  (`compute_snapshot_subjects.mjs` sets context def hashes to `{}`
  while FE populates them).
- **Nightly Bayes fit** — automatic posterior updates after daily
  fetch. Needs: production confidence + topo sigs.
- **FE stats deletion** — ~4000 lines. Parity confirmed at
  edge-level; graph-level pipeline shows ~1% drift in orchestration
  layer (Bayesian evidence adjustment, sampled-cohort detection,
  n_baseline selection). Needs investigation before deletion.
- **Lag array defect** (doc 16) — window-type values[] entries have
  zero lag arrays; blocks sensible first-run latency priors.
- **Sampling performance** (doc 22) — compilation time (155s on
  branch graph), GPU experiment, dev-mode draws. Quality-of-life,
  not blocking.

**Next priorities**:
1. **BLOCKING: Stats pass write-back to graph edge** — stats pass
   computes correct onset/mu/sigma but they don't reach the graph
   edge's latency fields. Stale deranged values persist → model
   can't converge. Trace the write-back path in
   `statisticalEnhancementService.ts` / `modelVarsResolution.ts`.
2. **Fix path dispersion estimation** — the surprise gauge and
   confidence bands for cohort (path) slices are meaningless until
   path kappa is correct. Investigate: mature-only Williams,
   analytic derivation from edge kappa, or hierarchical cohort model.
3. Commit and stabilise all current code changes.
4. Topology signatures (doc 10) — proper implementation.
5. Phase C (context slices) — prerequisites done.
6. Nightly scheduling — prerequisite: production confidence +
   topo sigs.

---

## Design docs

| Short name | File | Scope |
|---|---|---|
| **Logical blocks** | `0-high-level-logical-blocks.md` | Graph-to-hierarchy compiler, model structure, inference pipeline |
| **Model contract** | `1-cohort-completeness-model-contract.md` | Cohort semantics, model ownership, evaluator unification |
| **Reference impl** | `2-reference-implementation-notes.md` | PyMC patterns, prior art review |
| **Compute arch** | `3-compute-and-deployment-architecture.md` | Compute vendor, deployment topology, shared code, DB access |
| **Async infra** | `4-async-roundtrip-infrastructure.md` | Async roundtrip: submission, webhook, git commit, schema |
| **Local dev setup** | `5-local-dev-setup.md` | Local dev environment, tunnel, deployment |
| **Compiler + worker** | `6-compiler-and-worker-pipeline.md` | Compiler IR, model materialisation, worker orchestration, evidence assembly |
| **asat() completion** | `7-asat-analysis-completion.md` | Historic asat through analysis/charting (Phase A), future asat with forecasts (Phase B) |
| **Compiler phases** | `8-compiler-implementation-phases.md` | Phased delivery plan for compiler: A (independent), B (Dirichlet), S (snapshot evidence), C (slices), D (latency coupling), E (fan-out) |
| **FE posterior consumption** | `9-fe-posterior-consumption-and-overlay.md` | FE changes for posterior display, settings, fit guidance, stats deletion schedule |
| **Topology signatures** | `10-topology-signatures.md` | Per-fit-unit structural fingerprinting for posterior staleness detection |
| **Snapshot evidence** | `11-snapshot-evidence-assembly.md` | Phase S: direct snapshot DB queries replace inline param-file evidence. FE fetch plan, worker DB integration, maturation trajectories. Phase D (latent latency + temporal drift) now sequenced before Phase C: A → B → **S** → **D** → C. |
| **Quality gating** | `13-model-quality-gating-and-preview.md` | Model quality signalling (progress, session log, Graph Issues), auto-enable Forecast Quality, accept/reject preview workflow |
| **Phase C design** | `14-phase-c-slice-pooling-design.md` | Phase C detailed design: slice DSL parsing, IR extension, solo-edge pooling, hierarchical Dirichlet for branch groups, conditional_p, posterior.slices output, Phase D interaction |
| **Model vars provenance** | `15-model-vars-provenance-design.md` | Model variable sets with provenance on graph edges, source selection, scalar promotion. Supersedes §"Model variable precedence" below and doc 9 §5.7–5.8. |
| **Lag array defect** | `16-lag-array-population-defect.md` | Window-type values[] entries have zero lag arrays; blocks sensible first-run latency priors. Investigation scope and fix approach. |
| **Latent onset** | `18-latent-onset-design.md` | Latent edge-level onset, graph-level onset hyperprior and dispersion (`tau_onset`), path-level onset with learned dispersion, FE onset posterior display. Replaces fixed histogram-derived onset. |
| **Synthetic data generator** | `17-synthetic-data-generator.md` | Monte Carlo simulator for parameter recovery testing. General-purpose over any graph topology, DB-backed, phased (Phase 1: core sim, Phase 2: context slices). |
| **Compiler journal** | `18-compiler-journal.md` | Chronological record of what was tried, what worked, what failed, and key invariants discovered. Prevents re-exploring dead ends. |
| **Trajectory compression** | `20-trajectory-compression-briefing.md` | Zero-count bin filter, smooth clip floors fix, NUTS sensitivity analysis. Resolved 24-Mar-26. |
| **Production/consumption separation** | `19-model-vars-production-consumption-separation.md` | `promoted_t95` separates user-configured t95 from model output. Done. |
| **Unified posterior schema** | `21-unified-posterior-schema.md` | Single `posterior.slices` keyed by DSL replaces split probability/latency posterior blocks. Per-slice p + latency, `_model_state` for warm-start. Done 25-Mar-26. |
| **BE stats engine bugs** | `19-be-stats-engine-bugs.md` | Three-way prior discrepancy (FE vs BE vs topology) on latency inference. Open. |
| **Synthetic data playbook** | `19-synthetic-data-playbook.md` | Step-by-step guide for creating synth graphs, generating data, running parameter recovery. Operational reference. |
| **Join-node convergence** | `bayes-join-node-convergence-briefing.md` | Join-node latency model geometry. Resolved by mixture CDF (journal 23-Mar-26). |
| **Statistical domain summary** | `statistical-domain-summary.md` | Reference: statistical foundations and domain concepts. |
| **Sampling performance** | `22-sampling-performance.md` | MCMC performance bottleneck analysis: compilation time, GPU vs CPU research, optimisation paths (compilation fix, dev-mode draws, more chains, NumPyro vectorised, faster cloud CPUs). Experiment protocol. |
| **Posterior slice resolution** | `25-posterior-slice-resolution-and-analysis-type-review.md` | Query-driven posterior slice projection in cascade + analysis graph composition. Systematic review of all analysis types for correct promoted scalars, window/cohort/context sensitivity, and chart visualisation. |

**Context**: `../codebase/APP_ARCHITECTURE.md` (app architecture),
`../project-db/` (snapshot DB)

---

## Structure

Three workstreams with a validation feedback loop. Bayesian inference
can start as soon as async infrastructure is done — it reads evidence
directly from graph + parameter files + snapshot DB, all already
populated by the existing system. Semantic foundation improves
*consumption* of posteriors but is not a prerequisite for *production*.

Critically, **model validation requires FE visibility**: to confirm the
model produces useful outcomes, analysis views (cohort maturity, asat,
conversion analysis) must render model-derived CDFs and posteriors
alongside the existing analytic curves. This creates a dependency
lattice — not a simple linear pipeline.

```
Async infrastructure (done)
  Steps 1–6: schema, webhook, git commit, Modal, submission, FE trigger
         │
         ▼
Bayesian inference
  Phase A (independent) → Phase B (Dirichlet) → Phase S (snapshot evidence) → Phase D (latent latency + drift) → Phase C (slices)
         │                       │                     │                    │
         ▼                       ▼                     ▼                    ▼
    FE overlay ──────────── FE overlay ─────────── FE overlay ────────── FE overlay
    (basic posterior        (simplex               (per-slice             (latency CDF
     display on edges,       constraint             posterior bands,       overlay on
     confidence bands)       visualised,            shrinkage visible)     cohort maturity
                             branch group                                  curves)
                             quality)
         │                                                                  │
         ▼                                                                  ▼
    Visual validation ──────────────────────────────────────────────── Quantitative
    (does the model                                                    backtesting
     agree with existing                                               (systematic
     analytic curves?)                                                  model comparison)

Semantic foundation (parallel, feeds into consumption quality)
  Evaluator unification → Python model ownership → FE stats deletion
```

### Dependency lattice — what blocks what

| Milestone | Depends on | Enables |
|---|---|---|
| Phase A posteriors in YAML (done) | Async infra (done), schema revision, compiler Phase A | FE overlay (basic), visual validation |
| FE overlay (basic) (done) | Phase A, FE posterior reading | Visual validation, fit quality display |
| Visual validation (done) | FE overlay (done), existing analytic curves | Confidence to proceed to Phase B |
| Phase B posteriors (done) | Phase A proven | FE overlay (Dirichlet), branch group quality |
| Phase S snapshot evidence (done) | Phase B, FE hash infrastructure, snapshot DB | Richer maturation trajectories, tighter posteriors, enables meaningful slice pooling |
| Phase D posteriors (done, likelihood rewritten 27-Mar-26) | Phase S proven | Latent latency, recency weighting, cohort latency hierarchy. **Likelihood rewrite**: DM→textbook Binomial (Gamel et al. 2000), BB→Binomial for daily obs, per-retrieval onset observations from Amplitude, t95 soft constraint from analytics pass. Two-phase model (window→cohort). See doc 23. |
| Phase D.O latent onset (done) | Phase D proven | Independent per-edge latent onset (no hierarchy — see journal 23-Mar-26). Graph-level hierarchy removed (no intellectual justification). |
| Phase D join-node mixture CDF (done) | Phase D proven | Mixture CDF at joins replaces single-path misspecification. All 8 structural topologies converge (journal 24-Mar-26). |
| Doc 19 promoted_t95 separation (done) | Phase D proven | Separates user-configured t95 (input constraint) from model-output promoted_t95 (consumption). Prevents Bayesian t95 overwriting user's horizon guidance. |
| Doc 21 unified posterior schema (done 25-Mar-26) | Phase D proven | Single `posterior.slices` keyed by DSL replaces split `posterior` + `latency.posterior`. Per-slice entries carry both probability and latency. `_model_state` for warm-start. Per-obs-type `p_window`/`p_cohort` extraction. Prerequisite for Phase C context slices. |
| Production graph fit quality (major progress 27-Mar-26) | Phase D done | Production p inflation (1.94x on del-to-reg) reduced to 1.19x. Root causes: (1) DM likelihood bias → replaced with textbook Binomial, (2) BetaBinomial daily obs bias → replaced with Binomial, (3) onset/sigma drift → anchored with per-retrieval onset obs from Amplitude + t95 soft constraint from analytics pass. Remaining 1.19x is genuine data sparsity (trajectory coverage). See journal 26-27-Mar-26 and doc 23. Synth recovery excellent (≤1.04x across all 8 graphs). |
| BE stats engine prior discrepancy (open) | Phase D done | Three-way discrepancy between FE stats pass, BE stats engine, and topology `derive_latency_prior` on latency priors. Only topology's crude moment-match gives convergence. See `19-be-stats-engine-bugs.md`. Related to production fit quality. |
| Mixture latency models (designed, not built) | Phase D proven | Some edges (e.g. registered-to-success) have bimodal conversion timing that a single shifted log-normal cannot fit. Mixture of two log-normals needed. Opt-in per edge. See doc 23 §12. |
| Phase 2 stabilisation (open) | Phase 1 likelihood rewrite done | Phase 2 (cohort pass with frozen Phase 1 values + drift) has convergence issues on some runs (ess=7). Needs investigation — may be related to Dirichlet drift parameterisation or Phase 1 latency values being passed through. **Join-node CDF fix applied 29-Mar-26**: `phase2_cohort_use_x` now detects join-downstream edges and builds mixture CDF (was picking one arbitrary path). |
| Model quality gating (designed, not built) | Phase A overlay done | Quality signalling (progress, session log, Graph Issues), auto-enable Forecast Quality, accept/reject preview. See doc 13. |
| Phase C posteriors (next) | Phase D proven, doc 21 done, test data with contexts | Per-slice visualisation, MECE validation, hierarchical shrinkage, κ recovery |
| Nightly Bayes fit | Phase C proven, production confidence | Automatic posterior updates after daily fetch. Trigger Bayes fit for `dailyFetch: true` graphs when new snapshot data lands. Uses existing Modal/webhook/git-commit infrastructure — needs scheduling trigger + staleness detection + fit-on-change logic. |
| Quantitative backtesting | Phase A + fit_history depth + snapshot DB | Distribution family selection, model improvement |
| Fit quality visualisation (done) | Phase A + FE overlay | Edge colour-coding, quality-driven graph triage |
| Semantic foundation complete | Independent | Cleaner FE derivation, deletion of FE fitting code |

The critical insight: each compiler phase needs its corresponding FE
overlay to validate before progressing. Phase A is not "done" when
posteriors land in YAML — it is done when an analyst can see the
model's `p` and confidence bands on edges and compare them against the
existing analytic estimates. If they diverge unexpectedly, that's a
signal to fix the model before adding complexity in Phase B.

Similarly, Phase D's latency coupling is not validated until the
model-derived completeness CDF is rendered alongside the existing
cohort maturity curve in the analysis view. If the model curve doesn't
match the observed maturation shape, the latency model needs work —
and that's visible only in the FE.

---

## Semantic foundation (workstream)

Fix cohort completeness semantics, move model ownership to Python, delete FE
fitting code. Statistical/semantic work on the existing codebase. No dependency
on remote compute infrastructure.

### Evaluator unification

Make the existing system internally consistent. Analysis logic and cohort
maturity charts use the same evaluator with the same parameters.

**Scope**:
- BE annotation and BE chart CDF share one parameter resolution helper
- Onset handling fixed for path params (use edge onset, not `0.0`)
- Explicit `query_mode` field on analysis requests
- Provenance metadata in analysis responses

**Progress (17-Mar-26)**: `_resolve_completeness_params()` implemented in
`api_handlers.py` — BE annotation and chart CDF now use the same resolved
mu/sigma/onset per doc 1 §16.1 truth table. Onset for cohort path params
uses edge onset (Phase 1 interim) or `path_delta` when available — never
`0.0`. Remaining: `query_mode` field on requests, provenance metadata in
responses, `completeness_model` object per subject (doc 1 §19.1).

**Not in scope**: moving FE completeness to Python, new fitting infrastructure,
join handling, chains > 2 hops.

**Exit criterion**: for every `cohort_maturity` analysis response,
`completeness_model.mode == model_curve_params.mode` and
`completeness_model.onset_delta_days == model_curve_params.onset_delta_days`.

**Design detail**: Model contract, sections 11 and 14.

### Python model ownership

Move path-model derivation and fitting into Python. FE becomes a pure applier.

**Scope**:
- Python computes A→Y path model from snapshot evidence + X→Y edge models
- Correct onset composition, mixture-based join handling
- Python publishes `(path_mu, path_sigma, path_delta)` and model-source grade
- MVP topology invalidation (stale-marking on write)
- Port tail-constraint logic and `approximateLogNormalSumFit` to Python

**Not in scope**: full Bayes fitting, topology signatures.

**Exit criterion**: FE LAG pass completeness computation removed. All consumers
use BE-published A→Y model with consistent semantics.

**Design detail**: Model contract, sections 11, 14, 21–22.

### FE stats deletion

Delete ~4000+ lines of FE statistical fitting code. Python becomes the sole
fitting owner.

**Scope**:
- Complete parallel-run soak, confirm parity
  - **Status (24-Mar-26)**: Core stats primitives (fit, CDF, inverseCDF, blended
    mean, FW composition) and edge-level pipeline (`computeEdgeLatencyStats` /
    `compute_edge_latency_stats`) confirmed in parity via contract tests
    (`statsParity.contract.test.ts` + `test_stats_parity_contract.py`). However,
    the graph-level pipeline (`enhance_graph_latencies` vs FE Stage-2) shows ~1%
    drift on completeness and blended_mean. The drift is in the orchestration
    layer: Bayesian evidence adjustment, sampled-cohort detection, n_baseline
    selection from edge context. This needs investigation before FE stats deletion
    can proceed.
- Disable FE topo/LAG fitting pass
- Delete FE fitting codepaths: `statisticalEnhancementService.ts`,
  `lagDistributionUtils.ts`, `forecastingParityService.ts`, and related modules
- Update or remove associated test files

**Not in scope**: changing the BE fitting implementation.

**Exit criterion**: no FE code path calls `fitLagDistribution`,
`computeEdgeLatencyStats`, `approximateLogNormalSumFit`, or any other fitting
function. Build and lint confirm zero references.

**Design detail**: Model contract, section 14.3. Detailed plan in
`../project-db/analysis-forecasting-implementation-plan.md`.

---

## Async infrastructure (workstream)

Build the plumbing for submitting jobs to a remote compute vendor, receiving
results via webhook, and committing them to git. Integration/DevOps work. No
dependency on cohort semantics or model ownership.

### Async roundtrip

A working end-to-end roundtrip — FE submission → remote worker execution →
webhook → atomic git commit → FE pull — with correct posterior schema fields
but placeholder values.

**Steps**:
1. ~~Schema additions (initial)~~: `posterior` sub-objects on
   `ProbabilityParam` and `LatencyConfig` in TS types, Python Pydantic
   models, YAML schemas. **Done 16-Mar-26.**

   **Schema revision required before Phase A** (post-17-Mar-26 design
   changes — see doc 4 and doc 6 Layer 3):

   - **`posterior.slices` map**: per-slice posteriors keyed by slice DSL
     string. Holds posteriors at all granularities — window/cohort
     observation types, context dimensions, and aggregate levels not
     represented in `values[]`. The `slices` map uses the same DSL
     grammar and canonicalisation as `values[].sliceDSL`.
   - **Top-level `alpha`/`beta` = window posterior**: the top-level
     posterior represents the window (most current) estimate. `p.mean`
     and `p.stdev` are derived from it. This replaces the earlier
     assumption of a single shared probability parameter.
   - **`posterior._model_state`**: model-internal parameters persisted
     for subsequent runs (e.g. `sigma_temporal`, `tau_cohort`,
     hierarchical anchor params). Separated from business-meaningful
     posteriors — no consumption semantics.
   - **`fit_history` per-slice snapshots**: each fit_history entry
     carries a `slices` sub-map with slim `alpha`/`beta` per slice,
     enabling per-observation-type trajectory analysis for the
     DerSimonian-Laird estimator.
   - **DSL canonicalisation gate**: before Phase A writes posteriors,
     the DSL identity system must be validated end-to-end — the same
     parser must produce identical keys whether invoked by the evidence
     binder (reading `values[].sliceDSL`) or the posterior writer
     (keying `posterior.slices`). TS types, Python Pydantic models, and
     YAML schema must all be updated to reflect the revised structure.
2. ~~Isomorphic verification gate~~: confirm UpdateManager extracted modules
   are platform-agnostic. **Done 16-Mar-26.**
3. ~~Webhook handler~~: `/api/bayes-webhook.ts` with atomic multi-file commit
   via Git Data API (`api/_lib/git-commit.ts`). Writes posteriors to param
   files + `_bayes` metadata to graph. No cascade — scalar derivation
   deferred to FE post-pull (see §23 in doc 1). **Done 16-Mar-26.**
4. ~~Compute vendor setup~~: Modal app (`bayes/app.py`) with DB
   connectivity (`psycopg2-binary`), webhook delivery on completion,
   progress tracking via `modal.Dict`. **Done 16-Mar-26.**
5. ~~Submission route~~: Modal `/submit` endpoint receives FE payload,
   spawns worker, returns job_id. `/status` and `/cancel` endpoints.
   FE trigger via `useBayesTrigger.ts`. **Done 16-Mar-26.**
6. ~~FE integration~~: `useBayesTrigger.ts` hook with job tracking
   (status polling), `DevBayesTrigger.tsx` in menu bar, session
   logging. **Done 16-Mar-26.**

**Exit criteria**:
- FE can submit and receive a job_id
- Worker executes, connects to DB, fires webhook
- Webhook commits atomically with correct posterior fields
- FE reads back posterior fields after pull
- Existing graphs without posteriors continue to load
- Idempotency holds (duplicate webhook = no duplicate commit)

**Not required**: real inference, FE display of posterior data, real-time
progress, nightly scheduling.

**Design detail**: Async infra (implementation), Compute arch (rationale).

---

## Bayesian inference (workstream)

**Depends on**: Async infrastructure (done — webhook, atomic commit,
Modal app, FE trigger all built). Does NOT depend on Semantic foundation.

**Why no Semantic foundation dependency**: The compiler reads evidence directly
from three sources that already exist and are already populated:

1. **Graph topology** — sent inline by FE (same as existing
   `/api/runner/analyze` pattern)
2. **Parameter files** — sent inline by FE in the submit request. Richer than
   graph edges: daily arrays (n_daily, k_daily, dates), multiple values[]
   windows, per-slice latency histograms, cohort bounds, onset data.
3. **Snapshot DB** — queried via PostgreSQL (same as existing analysis runners).
   Time-series evidence rows with full granularity.

The compiler produces posteriors. It doesn't need the FE fitting code deleted
or the evaluator unified — those concern *consumption*, not *production*.

### Compiler + worker pipeline

**Scope**:
- Graph-to-hierarchy compiler: canonicalise graph, identify branch groups,
  build probability and latency hierarchies, encode coupling, bind evidence
- Evidence assembly from parameter files (git) and snapshot DB
- PyMC model materialisation from compiler IR
- Inference execution (MCMC sampling via compute vendor)
- Posterior summarisation and quality gates (r-hat, ESS, HDI)
- Webhook callback with posterior payload → atomic git commit

**Phased delivery**: see `8-compiler-implementation-phases.md` for full
phase definitions, entry/exit criteria, warm-start rules by phase, and
cross-phase feature activation. Summary:
- Phase A: independent Beta per edge with window/cohort separation —
  proves full pipeline end-to-end (includes schema revision for
  `posterior.slices`, `_model_state`, DSL canonicalisation)
- Phase B: Dirichlet branch groups (sibling coupling)
- Phase S: snapshot DB evidence assembly — FE sends hashes, worker
  queries DB for maturation trajectories, replaces inline param-file
  evidence (doc 11). Must precede Phase C because slice pooling needs
  rich per-slice evidence.
- Phase C: slice pooling + hierarchical Dirichlet
- Phase D: probability–latency coupling through completeness
- Phase E (optional): per-chain fan-out across workers

**Design detail**: Logical blocks (compiler, hierarchy, IR), Reference impl
(PyMC patterns), Compiler + worker (implementation).

### Nightly Bayes fit (production scheduling)

Wire the Bayes model fit into the nightly fetch cycle so posteriors update
automatically when new snapshot data arrives.

**Depends on**: Phase C proven (model feature-complete for production
graph types), production confidence from visual validation on real graphs.

**Scope**:
- **Trigger**: after daily fetch completes for a graph with
  `dailyFetch: true`, check whether a Bayes refit is warranted
- **Staleness detection**: compare current snapshot evidence fingerprint
  against the fingerprint from the last fit (stored in
  `posterior._model_state`). If unchanged, skip. If new data, trigger.
- **Scheduling policy**: fit at most once per
  `bayes_fit_history_interval_days` (default 7 — weekly). Don't refit
  daily unless evidence has materially changed.
- **Execution**: submit to Modal via the existing `/submit` endpoint.
  Reuse the full worker pipeline (topology → evidence → model → MCMC →
  webhook → git commit). No new infrastructure needed.
- **Failure handling**: if fit fails (divergences, timeout, quality gate
  failure), log to session log and Graph Issues. Do not commit bad
  posteriors. Retry on next scheduled interval.
- **Warm-start**: use previous posterior as prior for the next fit
  (ESS-capped, topology-fingerprint validated). Faster convergence on
  incremental evidence updates.

**Not in scope**: real-time fitting (on every fetch), multi-graph
parallelism (one fit at a time per graph initially), FE progress
tracking for automated fits (use session log).

**Exit criteria**:
- Production graph posteriors update weekly without manual trigger
- fit_history accumulates entries, trajectory calibration activates
- Failed fits surface in Graph Issues with actionable diagnostics
- No regression in existing fetch cycle (Bayes fit is additive, not blocking)

### Sampling performance optimisation

**Status**: Researched 25-Mar-26, no experiments run yet. See
`22-sampling-performance.md` for full analysis.

**Problem**: MCMC runs use ~20% of available compute (4 chains on 4 CPU
cores; GPU idle). The branch graph takes ~7 min (155s compile + ~4 min
sample). This is too slow for compiler development iteration.

**Planned investigation sequence** (to be journalled in doc 18 as
experiments are run):

1. **Fix compilation time** — the branch graph's 155s compile is likely a
   data representation issue in Potentials (each age point becomes a symbolic
   node in the gradient graph). Investigate `freeze_model=True` and audit
   Potential data handling. Target: <15s compile.
2. **Dev-mode sampling** — add `--dev` flag to test_harness.py with reduced
   draws (500/300/2). Already supported via CLI; needs a convenience flag.
3. **More chains on production** — increase to 8 chains on Modal (many cores
   available). Better ESS/wall-clock, no code changes needed.
4. **NumPyro vectorised GPU experiment** — controlled test of
   `pm.sample(nuts_sampler="numpyro")` on simple graph. Fundamentally
   different from the prior unsuccessful JAX experiment (which used nutpie's
   JAX backend, adding per-step dispatch overhead). 50/50 chance of helping
   given this model's element-wise Potential profile.
5. **Evaluate faster cloud CPUs** — Hetzner dedicated EPYC (5.1 GHz) vs
   Modal shared EPYC (~3 GHz) for production workloads.

**Not a blocker** for any current phase — this is a quality-of-life
improvement for compiler development and a throughput improvement for
production nightly fits.

---

## Posterior consumption

**Depends on**: Bayesian inference Phase A (real posterior data in YAML files).
Benefits from Semantic foundation (cleaner FE derivation) but can start without
it.

The FE uses posterior distributions for richer analysis and display. This is
not a single milestone — it progresses in lockstep with the compiler phases,
because each phase's outputs need FE visibility for validation.

### FE overlay — model curves alongside analytic curves

The core validation mechanism: existing analysis types (cohort maturity,
conversion analysis, asat) already produce analytic curves from deterministic
logic. The Bayesian model produces probabilistic versions of the same
quantities. Rendering both side-by-side is how we confirm the model is useful.

**Phase A overlay** (built 18-Mar-26):
- **Edge-level posterior display**: `PosteriorIndicator` component shows
  quality tier badge + popover with HDI bounds, evidence grade,
  convergence metrics (rhat, ESS), prior tier, provenance, and
  fitted_at freshness. `AnalysisInfoCard` Forecast tab shows full
  posterior diagnostics per edge. Both support probability and latency
  posteriors.
- **Quality overlay mode**: edges colour-coded by quality tier
  (failed/warning/cold-start/weak/mature/strong) in forecast-quality
  overlay mode. `ConversionEdge.tsx` and `EdgeBeads.tsx` render quality
  tier beads when overlay is active.
- **Bayesian model curve on cohort maturity chart**: blue dashed line
  alongside analytic model curve for direct comparison.
- **Remaining**: window/cohort divergence indicator (deferred — Phase A
  does not populate `posterior.slices`; activates Phase C).
- **Confidence bands on model CDF** (built 19-Mar-26): 80% posterior
  uncertainty bands on Bayesian model curve in cohort maturity chart.
  Mu-only variation (sigma held at posterior mean) with k=1.28.
  Backend generates band curves, threaded through graphComputeClient,
  rendered as ECharts custom series polygon. Path-level bands visible
  in cohort() mode; edge-level bands sub-pixel (poor model fit on
  test graph — see doc 13 for quality gating response).
- **Model quality gating** (designed 19-Mar-26, not yet built): quality
  signalling (progress indicator, session log, Graph Issues), auto-enable
  Forecast Quality view on poor fits, accept/reject preview workflow.
  See doc 13 for full specification.

**Phase B overlay**:
- **Simplex visualisation**: branch group siblings shown with their
  Dirichlet-derived posteriors. Verify `Σ p_i ≤ 1` visually.
- **Branch group quality**: surface branch-group-level diagnostics
  (any sibling with poor r-hat flags the group).

**Phase C overlay**:
- **Per-slice posterior bands**: each context slice shown with its own
  posterior interval. Verify shrinkage is visible (low-data slices
  tighter toward base rate than the raw estimate would suggest).

**Phase D overlay**:
- **Latency CDF overlay on cohort maturity**: the model's completeness
  CDF (from latent latency posteriors) rendered alongside the existing
  analytic maturity curve. This is the key validation for the
  probability–latency coupling — if the model's predicted maturation
  shape doesn't match the observed data, the latency model needs work.
- **Posterior-predicted maturation**: for a given cohort, the model can
  predict the maturation curve at different cohort ages. Overlay the
  predicted curve against the actual observed maturation from later
  snapshots.

### Fit quality visualisation (built 18-Mar-26)

Per-edge quality metrics surfaced in the graph UI:
- Edge colour-coding by quality tier (composite of rhat, ESS,
  divergences, evidence grade) in forecast-quality overlay mode
- `PosteriorIndicator` popover shows convergence diagnostics, prior
  tier, provenance, freshness
- `AnalysisInfoCard` Forecast tab shows full diagnostic breakdown
- `bayesQualityTier.ts` computes tier: failed/warning/cold-start/
  weak/mature/strong with colour palette

Per-edge quality is already stored in parameter files (`posterior.ess`,
`posterior.rhat`, `posterior.evidence_grade`); graph-level summary is in
`_bayes.quality`. Per-slice quality metrics are available via
`posterior.slices` — each slice entry carries `ess`, `rhat`, and
`divergences` (see doc 4 schema revision).

### Other consumption features

- Posterior-powered queries ("is this conversion rate within the 90% HDI?")
- Fan charts in cohort analysis consuming posterior interval data
- Nightly scheduling (cron trigger for automated fits)

### Backtesting and model validation

**Depends on**: Bayesian inference Phase A (posteriors in YAML files) +
`fit_history` populated across multiple runs + snapshot DB with historical
evidence.

Systematic evaluation of model predictive accuracy by comparing
historical posteriors against later-observed evidence. This is the path
from "we have a Bayesian model" to "we have a validated, improving model."

**What it measures**:
- **Calibration**: when the model says 90% HDI, does reality fall within
  that interval ~90% of the time? Overcoverage = underconfident (model
  could be tighter). Undercoverage = overconfident (priors too tight,
  wrong family, missing structure).
- **Log predictive density**: for each held-out observation, how surprised
  was the model? Aggregated across edges and dates, this gives a single
  score for comparing model configurations.
- **Latency forecast accuracy**: the model predicts cohort maturation
  curves via the completeness CDF. Later snapshots reveal the actual
  maturation shape. The discrepancy directly measures latency model
  quality.
- **Surprise calibration**: are the trajectory z-scores (from doc 6,
  trajectory-calibrated priors) actually well-calibrated? Do flagged
  surprises correspond to real regime changes?

**What it enables for model improvement**:
- Distribution family selection (shifted-lognormal vs Gamma vs mixture —
  which has better predictive density on held-out data?)
- Prior policy evaluation (does trajectory calibration outperform
  uninformative? Does evidence inheritance help?)
- Structural model comparison (Phase A independent vs Phase B Dirichlet
  vs Phase D coupled — which generalises better?)
- Model rot detection (calibration degrading over time = something
  changed in the product, market, or data pipeline)

**Infrastructure**: `fit_history` provides historical posteriors.
`asat()` and the snapshot DB provide historical evidence. The serialisable
IR means the evidence binder can re-bind against historical snapshots
without re-running MCMC — backtesting is an evaluation loop over existing
data, not a compute-intensive operation.

**Not required for initial delivery.** This is a future programme step
that becomes valuable once the model is producing real posteriors across
multiple runs. Design detail to be written post-Phase A.

**Design detail**: to be written when Bayesian inference is near completion.

---

## Open decisions

Phase A is complete (compiler, FE overlay, real graph validation — all
done 18-Mar-26). No unresolved design decisions block Phase B. This
section tracks known limitations, future-phase concerns, and
implementation progress.

### Implementation work remaining for Phase A

**Progress (18-Mar-26)**:

1. ~~**Compiler Phase A**~~: **Done 18-Mar-26.** Full pipeline implemented
   in `bayes/compiler/` (topology → evidence → model → inference).
   Unified `bayes/worker.py` replaces duplicated placeholder code in
   both Modal (`bayes/app.py`) and local (`graph-editor/lib/bayes_worker.py`,
   now deleted). Placeholder mode preserved via `settings.placeholder`
   flag for E2E roundtrip test isolation.

2. ~~**fit_history accumulation**~~: **Done 18-Mar-26.** Webhook handler
   (`api/bayes-webhook.ts`) now appends a slim snapshot of the previous
   posterior to `fit_history[]` before overwriting with the new posterior.
   Retention capped at 20 entries (most recent kept). Both probability
   and latency posteriors accumulate independently.

3. **Real graph validation**: **18-Mar-26.** Compiler ran successfully
   on `bayes-test-gm-rebuild` (9 nodes, 8 edges, 4 param files with
   daily arrays). All 4 edges with data produced sensible posteriors
   matching analytic values. Convergence: 3 of 4 edges fully converged
   (r-hat < 1.01, ESS > 2000); 1 edge marginal (r-hat 1.014, ESS 391).
   **323 divergences** from hierarchical logit parameterisation with
   very high-n data (100k–580k obs). Requires non-centred
   reparameterisation — see known limitation below.

4. **Schema revision** — TS types, Pydantic models, and YAML schemas
   already have `posterior.slices`, `_model_state`, and `fit_history`
   fields defined. The compiler does not populate `slices` or
   `_model_state` in Phase A (correctly — no slice pooling yet). No
   blocking work remains; these activate in Phase C.

5. ~~**Phase A FE overlay**~~: **Done 18-Mar-26.** Full posterior
   consumption UI built: `PosteriorIndicator` component (badge +
   popover with HDI, evidence grade, convergence, provenance,
   freshness), quality tier utility (`bayesQualityTier.ts`), edge-level
   quality overlay mode in `ConversionEdge.tsx`/`EdgeBeads.tsx`,
   `AnalysisInfoCard` with Forecast/Diagnostics tabs,
   `localAnalysisComputeService` edge info builder with posterior
   diagnostics. Bayesian model curve on cohort maturity chart. See
   doc 9 §4 for component inventory.

### Known limitations (implementation will address when relevant)

**Divergences with high-n data (identified and fixed 18-Mar-26)**

The hierarchical p_base/p_window/p_cohort logit parameterisation
initially produced ~680 divergent transitions on the test graph
(100k–580k observations). Root cause: centred parameterisation
creates funnel geometry when the posterior is concentrated. Fixed
with non-centred parameterisation
(`logit_p_window = logit_p_base + ε * τ_window` where
`ε ~ Normal(0, 1)`) combined with `target_accept=0.95`. Result:
divergences reduced from 680 → 73, all edges converge (r-hat < 1.01,
min ESS 911). The 73 remaining divergences are on `registered-to-success`
which has latency coupling through a chain — acceptable for Phase A,
expected to improve in Phase D when latency becomes latent.

### Known limitations (implementation will address when relevant)

**Evaluator congruence (partially fixed 17-Mar-26)**

Doc 1 §13 divergences 1 and 3 fixed: `_resolve_completeness_params()`
in `api_handlers.py` ensures BE annotation and chart CDF use the same
resolved mu/sigma/onset per doc 1 §16.1 truth table. Divergence 2 (FE
vs BE evaluator independence) remains — resolves with Semantic
Foundation Phase 2 (FE becomes pure applier of BE-published path model).

**Upstream onset (A→X) not persisted**

Doc 1 §10.4 recommends deriving `anchor_onset_delta_days` from the A→X
histogram at fetch time. Not yet implemented. Affects **analytic
(pre-Bayes) path composition only** — the Bayesian compiler estimates
delta from panel data directly (A, X, Y counts + anchor lag scalars all
persisted in snapshot DB). For the analytic pipeline,
`anchor_median_lag_days` serves as a conservative proxy.
`_resolve_completeness_params()` falls back to edge onset when
`path_delta` is absent. Proper `path_delta` accumulation through
topo DP comes with Semantic Foundation Phase 2 (doc 1 §15.3.4).

**Browser-closed job rehydration (deferred)**

If the user closes the browser while a Bayes fit is running on Modal,
the FE loses the job ID and polling state. The webhook still fires and
commits a patch file (`_bayes/patch-{job_id}.json`) to git. On next
boot, the app must detect unapplied patch files in the `_bayes/`
directory, apply them (upsert posteriors into local parameter and
graph files), and surface the outcome to the user.

The happy path (browser open) is implemented: `fetchAndApplyPatch()`
reads the patch file from git by path on job completion, applies it,
and deletes it. The closed-browser path requires the workspace service
to scan `_bayes/` during pull/clone and call the patch application
logic — deferred until needed (see doc 4 § "Return path
re-architecture").

**Cross-graph prior transfer (superstructure guidance)**

New graphs with fine-grained structure (e.g.
`A→a1→a2→a3→B→b1→...→C→...→D`) often have sparse data on their
new edges. An existing graph with coarser structure (`A→B→C→D`) may
have rich data and well-fitted posteriors. The old graph's posteriors
are informative about the new graph's aggregate behaviour — this is
real observed data from a related system, not just an uninformative
prior.

The user would specify a **superstructure mapping** on the new graph:
`new_A ↔ old_A`, `new_B ↔ old_B`, etc., with a strength parameter
controlling how much influence the old data carries. The compiler
would then:

1. Identify the composed path from new_A-descendants to
   new_B-descendants in the new graph
2. Convert the old `A→B` posterior to **pseudo-observations** at the
   path level: `n_pseudo = γ(α+β)`, `k_pseudo = γα` where γ ∈ (0,1]
   is the strength discount
3. Add these pseudo-observations as an additional likelihood term
   constraining the composed path probability

This handles forking and recombination naturally — the constraint is
on the aggregate path, not individual edges. The old graph is
**read-only** — its params are consumed as evidence but never
overwritten.

**Why encoded pseudo-observations rather than reading old param files
directly**: the old graph has different topology, edge UUIDs, and
queries. The evidence binder wouldn't know what to do with foreign
param files. Converting posteriors to pseudo-observations decouples
the old structure from the new and lets the compiler treat them as
additional data at the path level.

The `fit_guidance` block (doc 9 §5.6 Level 3) is the natural home
for specifying the superstructure mapping and strength parameter.
Not needed for Phase A (edges with sufficient direct data) — becomes
valuable when building new graphs or restructuring existing ones.

**Model variable precedence and source provenance**

**Superseded by doc 15** (`15-model-vars-provenance-design.md`).

Summary of the revised design: each graph edge carries a `model_vars[]`
array of complete, provenance-tagged variable sets (analytic, Bayesian,
manual). A pure resolution function selects among them based on
`model_source_preference` (graph-level default, per-edge override).
The selected entry's values are promoted to the flat scalars (`p.mean`,
`latency.mu`, etc.) that the rest of the system consumes. UpdateManager
stays a dumb data sync; resolution is separate from cascade. Manual
user edits create a complete `source: 'manual'` entry (snapshot +
edit), replacing the `_overridden` flag mechanism for model var fields.

**Phase activation** (unchanged):

| Phase | What `'bayesian'` preference enables |
|---|---|
| A (done) | `p.mean`/`p.stdev` from window `α`/`β` |
| B (done) | Same, plus Dirichlet-derived `p.mean` for branch group edges |
| D (done) | `latency.mu`/`sigma`/`t95` from latency posteriors — full scalar switchover |
| C (next) | Per-slice scalar derivation from slice posteriors |

**Future design debt**: extend `model_vars` pattern to `CostParam`
(same `mean`/`stdev` pattern, no Bayesian source today). See doc 15 §16.4.

**Downstream conditional data**: the data pipeline only fetches
condition-sliced observations on the conditional params themselves, not
on downstream edges. Post-Phase C. See doc 6 §conditional probabilities.

**Snapshot DB topology invalidation**: topology changes invalidate
cohort datasets downstream. Window datasets survive. Doc 10 covers the
design; implementation is post-Phase A.

### Resolved

- ~~Vendor selection~~: **Modal.** Worker in `bayes/app.py`.
- ~~Shared package evolution~~: Modal uploads local code; no separate
  pip package needed.
- ~~Webhook authentication~~: **Built.** AES-256-GCM encrypted callback
  token. See `api/bayes-webhook.ts`.
- ~~Commit granularity~~: **Built.** Per-batch atomic commit via Git
  Data API. See `api/_lib/git-commit.ts`.
- ~~Graph snapshot at submission~~: **Built.** FE sends full graph +
  param files inline. See `hooks/useBayesTrigger.ts`.
- ~~Dirty file conflicts~~: **Accepted as known limitation.** User
  resolves via existing merge flow.
- ~~Evidence assembly strategy~~: **Resolved.** FE sends param file
  contents in submit request.
- ~~Bayesian inference scope~~: **Resolved 17-Mar-26.** Phased A→E.
- ~~Bayesian inference dependency on Semantic foundation~~: **Resolved
  17-Mar-26.** No hard dependency.
- ~~Exhaustiveness policy~~: **Resolved in doc 6.** Per-node metadata
  flag.
- ~~Pooling granularity~~: **Resolved in doc 6.** Per-edge `τ`.
- ~~Latency composition strategy~~: **Resolved in doc 6.**
  Fenton-Wilkinson (differentiable).
- ~~Conditional probability interaction~~: **Resolved 17-Mar-26 in
  doc 6.** Separate simplexes per condition per branch group.
- ~~Artefact schema~~: **Resolved in doc 4.** Full posterior schema.
- ~~Multi-file commit atomicity~~: **Resolved in doc 3.** Git Data API.
- ~~Warm-start storage~~: **Parameter file YAML.** Previous posterior's
  `(alpha, beta)` with ESS cap. See doc 8 Phase A.
- ~~Semantic foundation parallelism~~: **Separable.** Python model
  ownership can start on edges that don't depend on evaluator
  unification.
- ~~Application locus~~: **Resolved 17-Mar-26.** Three-tier model:
  Modal does MCMC inference → posteriors to YAML; BE analysis runners
  continue analytic lognormal fitting and path composition; FE retains
  only trivial application code (Beta CDF, mean, HDI from published
  α/β/μ/σ — tens of lines, not thousands). FE is source-agnostic:
  derives display quantities from whatever params are in the files,
  regardless of whether they came from analytic fitting or MCMC.
  Posture 2 (FE applies from published params) for Phases A–C;
  posture 3 (hybrid) becomes relevant at Phase D if path-level
  Fenton-Wilkinson composition proves too complex for TS. The BE
  analytic pipeline remains as instant fallback for edges without
  posteriors; `posterior.provenance` distinguishes source.
  Design detail: doc 1 §14, §21–22; doc 9 §6.
- ~~Cohort chart onset = 0.0 for path params~~: **Fixed 17-Mar-26.**
  `_resolve_completeness_params()` in `api_handlers.py` implements
  doc 1 §16.1 truth table. Both annotation and chart CDF use the same
  resolved mu/sigma/onset. Cohort mode uses edge onset (Phase 1) or
  `path_delta` (Phase 2) — never `0.0`. See doc 1 §17.1.
- ~~Upstream onset blocks Bayes~~: **Resolved 17-Mar-26.** The Bayesian
  compiler does not need pre-computed onset — it estimates delta as
  part of the MCMC posterior from panel data (A, X, Y counts +
  anchor lag scalars, all already persisted in snapshot DB). Upstream
  onset is only relevant to the analytic pipeline's path composition,
  where `anchor_median_lag_days` serves as a conservative proxy.
  See doc 1 §10.4, §15.3.
- ~~Async infra~~: **Built 16-Mar-26.** All 6 steps complete: schema
  additions, isomorphic verification, webhook handler, Modal app
  (`bayes/app.py` with submit/status/cancel/fit_graph), FE trigger
  (`useBayesTrigger.ts`), session logging. End-to-end roundtrip
  working with placeholder posteriors.
- ~~FE overlay spec~~: **Resolved 17-Mar-26.** Doc 9 covers posterior
  consumption: PropertiesPanel changes, edge rendering, analysis view
  adaptations, quality overlay, confidence interval migration, stats
  deletion schedule, settings/fit guidance UI. Component-level detail
  to be refined incrementally per phase.

- ~~Posterior confidence bands too narrow~~: **Resolved 20-Mar-26.**
  Replaced Binomial/Multinomial likelihoods with Beta-Binomial /
  Dirichlet-Multinomial throughout (model.py). Per-edge latent κ
  (`kappa_{edge}` ~ Gamma(3, 0.1)) controls overdispersion — large κ
  recovers Binomial, small κ allows heavy day-to-day variation. The
  model learns each edge's κ from trajectory data: test graph shows
  κ ranging from 1.5 (created→delegated, heavily overdispersed) to
  23.7 (delegated→registered, nearly Binomial). Posterior stdevs on
  p, mu, and sigma are now properly calibrated to real data variation,
  not Binomial fantasy. 0 divergences, 100% converged. See doc 6
  § "Overdispersion: Beta-Binomial / Dirichlet-Multinomial".

### Future work

- **Latency prior warm-start from previous posteriors**: after the
  first Bayes run, the fitted `(mu, sigma, onset)` per edge should be
  used as priors for subsequent runs. This is the natural extension of
  the existing probability warm-start (ESS-capped Beta). The first run
  uses whatever priors the analytic pipeline provides (median_lag /
  mean_lag from the param file, or the broad default); subsequent runs
  converge faster and more reliably from the previous posterior.
  Implementation: store latency posterior in the same `posterior` block
  on the param file; compiler reads it in the same fallback chain as
  the probability warm-start. ESS-capping applies to prevent
  over-concentration from accumulated runs.

- **Quality gate and escalating back-off**: after each MCMC run, check
  convergence quality (rhat, ESS, divergences). If below threshold:
  1. **Re-run with self-seeded priors** — use the (possibly poor)
     posteriors from the failed run as priors for a second attempt.
     Even a non-converged run finds roughly the right region; the
     second attempt starts there and usually converges.
  2. **Increase chains/draws** — if the first re-run still fails,
     double the chain count or draws. More samples help with mixing.
  3. **Flag for review** — if two re-runs fail, mark the result as
     `provenance: "unconverged"` and deliver it with a quality warning
     rather than silently delivering bad posteriors.
  Compute cost is acceptable — a complex graph taking an hour on a
  large CPU is fine for an overnight batch job. The quality gate
  ensures we don't deliver garbage.

- **Convergence diagnostics for users**: the compiler is a general tool
  that must handle arbitrary user-defined graphs. Some graphs will have
  structural or data issues that prevent convergence (p-latency
  identifiability on specific edges, pathological priors, insufficient
  data, multimodal posteriors). When a fit fails or partially converges,
  the system must export rich per-variable diagnostics — not just a
  pass/fail flag — so users can identify and fix the problem. Needed:
  1. **Per-edge convergence status** in the webhook payload: rhat, ESS,
     and a clear flag per edge (converged / unconverged / bimodal).
  2. **Problematic variable identification**: which edge(s) caused
     non-convergence, and whether the issue is p-latency coupling
     (bimodality), insufficient data, or prior-data conflict.
  3. **Actionable guidance**: e.g. "edge X has two plausible modes —
     consider adding a stronger latency prior" or "edge Y has too
     little data for latent latency — falling back to fixed CDF".
  4. **Graph Issues integration**: surface convergence problems via the
     existing Graph Issues panel so users see them in context.
  This is essential for production deployment. A model that silently
  delivers garbage when it can't converge is worse than no model at all.

- **Synthetic data generator for parameter recovery tests**: the model
  is tested against real snapshot data, but real data may have holes,
  pathological shapes, or inconsistencies that confuse the model. We
  cannot distinguish "model geometry problem" from "data quality
  problem" without a clean baseline. A synthetic data generator would:
  1. Take a graph structure with ground-truth parameters (p, onset, mu,
     sigma per edge).
  2. Monte Carlo simulate N people/day for M days traversing the graph
     (Bernoulli branching, ShiftedLognormal timing).
  3. At standard retrieval ages (1, 3, 7, 14, 30, 60d), count arrivals
     to produce window + cohort trajectory data.
  4. Output in `_query_snapshot_subjects` return format — feeds directly
     into `bind_snapshot_evidence`, no DB needed.
  Parameter recovery test: fit the model on synthetic data, verify it
  recovers the known ground-truth parameters within posterior credible
  intervals. This is the gold standard for Bayesian model validation
  and would definitively separate model issues from data issues. Also
  enables controlled testing of structural features (joins, branch
  groups) with known-good data. Priority: high — needed before
  declaring Phase D complete for graphs with joins.

- **Snapshot/param-file evidence deduplication**: when a new graph is
  created and the daily cron runs, both the parameter file `values[]`
  entries and the snapshot DB get populated with that day's data. If
  Bayes receives both sources (inline param-file evidence AND snapshot
  DB rows), the same cohort observations appear twice — inflating
  effective sample size and producing overconfident posteriors. The
  evidence binding step must deduplicate: when snapshot DB evidence is
  available for an edge, the overlapping param-file `values[]` entries
  for the same dates/slices should be suppressed. This is a
  preprocessing concern in `evidence.py`, not a model concern.

- **Lag array population defect** (doc 16): window-type `values[]`
  entries have all-zero `median_lag_days` / `mean_lag_days` arrays,
  causing the FE's `aggregateLatencyStats` to produce near-zero
  scalars. This gives the Bayes compiler pathological latency priors
  on first run. Fix needed in the daily fetch → file write pipeline.
  See doc 16 for full investigation scope.

- **Latent onset and onset dispersion (doc 18)**: edge-level onset
  becomes a latent variable with a graph-level hyperprior and learned
  dispersion parameter (`tau_onset`). Path-level onset prior spread
  derives from `tau_onset` rather than being hardcoded. Onset
  posteriors (mean, SD, HDI) surfaced in FE alongside mu/sigma.
  Sequenced as Phase D.O, between Phase D and Phase C. See
  `18-latent-onset-design.md` for full specification.

- **Analytic-derived latency priors for first run**: the analytic
  pipeline (lag fit, t95 computation) produces reasonable latency
  estimates. These could seed Bayes priors on the very first run
  before any posterior exists. Design consideration: avoid creating
  a backdoor prior injection / override system. The analytic values
  should be a one-shot initialisation, superseded by warm-start from
  posteriors on all subsequent runs. With latent onset (doc 18), the
  histogram-derived onset value enters as a soft observation rather
  than a fixed input, which partially addresses the onset prior
  concern.

- **Session logging verbosity**: the Bayes roundtrip (useBayesTrigger,
  bayesPatchService, worker diagnostics) emits detailed session log
  entries that are useful during development but excessive for
  production. Once the pipeline is stable, dial back to summary-level
  logging by default, with verbose output only in a diagnostic mode
  (e.g. `?bayes_debug=1` or a dev-tools toggle).

- **Bayes test hardening — immature cohort recovery**: the Phase A
  `test_completeness_prevents_p_underestimate` test (A4 scenario) is
  `xfail` — the fixed-latency model cannot recover true p from
  immature-only data (posterior mean ~0.16 vs truth 0.50). The
  directional assertion passes (posterior closer to truth than naive
  k/n ratio), but absolute recovery is poor. Phase D's latent latency
  should substantially improve this. When Phase D lands, remove the
  `xfail` marker and tighten the tolerance. Also review whether
  additional edge cases (mixed maturity, very short cohorts) need
  coverage.

- **Sampling progress estimation**: nutpie exposes per-chain
  `finished_draws / total_draws` via `PyChainProgress` (fields:
  `finished_draws`, `total_draws`, `tuning`, `step_size`,
  `num_steps`). Accessing it requires using nutpie's native API with
  `blocking=False` and polling `PySampler.inspect()`, instead of going
  through `pm.sample()`. This would give real % complete instead of
  the current elapsed-time heartbeat. Requires a refactor of
  `inference.py` to use nutpie directly rather than through PyMC's
  wrapper. Not blocking but would improve the FE progress display
  significantly.

---

## Post-build clean-up items

### Bayes session log verbosity (30-Mar-26)

The session log receives the full Python worker `log` array on every
bayes run (evidence detail, model summary, variable mapping, sampling
diagnostics). Useful during development but too noisy for normal use.
Gate the detailed output behind a `diagnostic` boolean (user-settable
in display settings or a dev toggle). When false, only emit a compact
summary (edges fitted, quality, timing).

---

## Compiler structural debt (23-Mar-26)

Code-level concerns identified by reviewing the compiler implementation
in isolation from the design docs. These are not feature gaps — the
statistical model and pipeline architecture are sound. They are
internal code quality issues that increase the cost and risk of
subsequent phase work.

### `_emit_cohort_likelihoods()` near-duplication (model.py)

This single function (~350 lines) handles trajectory Potentials for
both Phase S (fixed CDFs, numpy constants) and Phase D (latent CDFs,
PyTensor expressions). The two branches share ~70% of their structure
— interval count assembly, DM logp terms, remainder terms,
normalisation, recency weighting — but diverge on whether CDFs are
numpy or PyTensor. Fixing a bug in one branch without fixing the other
is the obvious failure mode. Refactor: extract a shared skeleton that
takes a CDF-coefficient provider (numpy array vs PyTensor expression),
collapsing the two branches into one.

### `build_model()` implicit state passing

Each compiler phase added a new shared dict to `build_model()`:
`onset_vars`, `latency_vars`, `cohort_latency_vars`, `bg_p_vars`,
`edge_var_names`. These dicts are the real interface between model
construction stages, but they are implicit — grown organically, not
designed. A new phase (e.g. Phase C slice emission) must understand
all existing dicts to know which variables exist and how to reference
them. Risk: the dict-passing pattern makes it easy to introduce
subtle ordering bugs (e.g. reading a dict before the stage that
populates it). Mitigation: either formalise the dicts into a typed
`ModelBuildState` dataclass, or split `build_model()` into named
stages that each receive and return explicit state.

### Utility duplication across modules

- `_safe_var_name()` is identical in `model.py` and `inference.py`.
  Move to `compiler/types.py` or a shared `compiler/utils.py`.
- `_build_path_lookup()` is identical in `evidence.py` and `worker.py`.
  Consolidate into evidence.py and import.
- Date parsing (`_parse_today`, `_date_age`, `_retrieval_age`,
  `_extract_date_from_dsl`) — four functions with slightly different
  format lists and no shared parser. Consolidate into a single
  `_parse_date(s: str) -> datetime` that tries all known formats once.

These are small individually but they signal module-boundary drift.
Each duplication is a place where a format change (e.g. adding a new
date format) must be applied in multiple locations.

### `_resolve_path_probability()` searches the model graph by string

To find upstream p variables, this function iterates
`model.deterministics + model.free_RVs` and matches `rv.name` against
string prefixes (`p_window_`, `p_base_`, `p_`). This is fragile
coupling to PyMC variable naming conventions. A dict mapping
`edge_id → p_var` (PyTensor reference) maintained alongside
`edge_var_names` would eliminate the scan and remove the dependency on
naming conventions.

### Dead backward-compat `.a` property on `CohortDailyTrajectory`

`types.py` line 160: `.a` property returns `.n`, commented "Backward
compat — old code references .a". Grep for remaining callers and
delete. If no callers exist this is dead code inflating the type
surface.

---

## Bug fix: hash-mappings.json — wrong hash format + missing fields (19-Mar-26)

Discovered when testing bayes-test branch on the data repo. The Snapshot
Manager showed 0 links for window() segments and 2 (false positive) for
cohort(). The equivalence closure set was silently empty, meaning no hash
expansion ever occurred via hash-mappings.

**Root cause**: Three issues in the data repo's `hash-mappings.json`:

1. `core_hash` values were full 64-char SHA-256 hex strings. The system
   uses ~22-char base64url short hashes (first 16 bytes of SHA-256,
   base64url encoded, no padding). The hex strings never matched anything
   in the UI or closure derivation.
2. Missing `operation` field. `getClosureSet()` in
   `hashMappingsService.ts` requires `operation === 'equivalent'` to
   include a row. Without it (`undefined !== 'equivalent'` → true), all
   rows were silently skipped — the closure set was always empty.
3. Missing `weight` field (required by `HashMapping` interface, defaults
   to 1.0).

**Fix**: Converted all `core_hash` values from hex to short base64url
format. Added `operation: "equivalent"` and `weight: 1.0` to every
entry. Pushed to `feature/bayes-test-graph` branch in data repo.

**Conversion method**: `base64url(hex_hash_bytes[:16])` — take first 16
bytes of the raw SHA-256, base64url encode without padding. This
produces the same output as `computeShortCoreHash(canonical_signature)`
because the hex values were the full SHA-256 of the same canonical
signatures.

**Impact on Bayes model**: The model was still working for cohort mode
because the seed `core_hash` (correct short format) was identical to the
production hash — same canonical signature, same hash. The broken
closure was dead weight. Window mode was not resolved because the window
seed hash differs from production and the closure couldn't bridge the
gap.

**No hash logic code was changed.** The fix was purely to the data file.
The hash computation code (`coreHashService.ts`,
`hashMappingsService.ts`, `plannerQuerySignatureService.ts`) is correct;
the mappings file was simply authored in the wrong format.

**Key invariant (confirmed)**: The canonical signature does NOT include
`param_id` or branch — it is purely semantic (connection + events +
filters + cohort mode + latency). Different param names on different
branches querying the same edge produce the same `core_hash`.
`query_snapshots` queries by `core_hash` alone (no `param_id` in WHERE),
so snapshot data is shared across branches and param names by design.
