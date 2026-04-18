# Project Bayes: Programme

**Status**: Active
**Updated**: 18-Apr-26
**Purpose**: Phased delivery plan for Project Bayes. This doc owns sequencing;
design docs contain the detail. The **Open items (curated)** section below
is the single source of truth for what is open — other docs may contain
stale claims. See that section's verification notes.

### Current status snapshot (13-Apr-26)

**Done**: Async infrastructure, Phase A–D compiler, FE overlay (basic
+ quality + model CDF + confidence bands), unified posterior schema,
synthetic data generator + 21-graph param recovery suite (11 uncontexted
+ 10 contexted), two-phase model architecture (posterior-as-prior),
likelihood rewrite (DM→Binomial), endpoint BetaBinomial for rate
estimation, onset observations, t95 soft constraint, posterior slice
resolution (doc 25), Phase 2 join-node CDF fix, full warm-start wiring
with quality guard, synth context data fix (`emit_context_slices` truth
flag), unified MCMC κ estimation (journal 30-31-Mar-26), snapshot regime
selection (doc 30 — BE+FE, 24+ tests), BE analysis subject resolution
(doc 31), LOO-ELPD model adequacy scoring Phase 1 (doc 32), Bayes
reconnect mechanism (doc 28 — 3-phase automation pipeline), Phase C
slice pooling partial (slice routing, per-slice Dirichlet emission,
per-slice posterior extraction), multi-hop cohort maturity Phase A
substantially implemented (`cohort_forecast_v2.py`, span kernel,
x_provider, `cohort_maturity_v2` analysis type registered FE+BE),
JAX backend as default (`gradient_backend='pytensor'`, anti-pattern 36),
Phase 2 debug dump and `--phase2-from-dump` replay devtooling.

**Synth regression (uncontexted)**: 11/11 pass. All graphs converge
cleanly (rhat<1.02, ESS>350, 98-100%). JAX backend is the default.
Three graphs (fanout-test, mirror-4step, forecast-test) previously
reported as FAIL — these were false alarms from zero-latency edges
where the recovery tool expected latency params that the model
correctly omits. Tool now fixed.

**Synth regression (contexted)**: 10/10 run to completion. None achieve
clean convergence (rhat 1.02–1.1, ESS 18–150, converged 58–80%).
Per-slice p and mu recover well. Per-slice onset is universally pinned
to the edge-level frozen value — this is by design (onset is edge-level
only; per-slice onset RVs omitted due to onset-mu ridge). Stochastic
risk present: `fanout-context` failed hard on one run (rhat=1.9) and
recovered on the next. See doc 19 §6.2 for full per-graph results.

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
7. Window kappa→alpha/beta→p_stdev→confidence bands pipeline verified
   end-to-end. The cohort export path is under renewed review after the
   9-Apr-26 forensic review found that current code still routes
   `cohort()` alpha/beta through `_estimate_cohort_kappa()` rather
   than a clearly model-based Phase 2 dispersion export. See doc 33.

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

**v1/v2 parity test tolerances increased (17-Apr-26)**:
The following parity tests have relaxed tolerances because v1 and v2
use different population model splicing and epoch handling, producing
genuine algorithmic divergence (up to ~10%) that is accepted:
- `test_doc31_parity.py::TestCohortMaturityV1V2Parity::test_single_edge_cohort_mode_parity` — 15% relative tolerance on MC fields, absolute-only below 0.05
- `test_doc31_parity.py::TestCohortMaturityV1V2Parity::test_single_edge_window_mode_parity` — 15% relative tolerance on MC + evidence-derived fields, first 30% of rows skipped (epoch A transition)
- `test_v2_v3_parity.py::TestProdGraphCohortParity::test_single_edge_cohort_midpoint` — diverges >10% at 45 tau values (known, skip-listed)
These should be revisited when v1 is retired and v3 becomes the sole
implementation — at that point the parity tests become v2/v3 only and
tolerances can be tightened.
- ~~Softplus onset leakage~~ — **FIXED 30-Mar-26**. Standard
  softplus leaked CDF mass below onset, enabling degenerate mode.
  Sharpened softplus (k=5) collapses the ridge.
- ~~Onset obs √N over-precision~~ — **FIXED 31-Mar-26**.
  Autocorrelation-corrected N_eff prevents claiming ±0.15d
  precision on a quantity that varies by ±2.4d.
- ~~Test assertions for promoted_onset~~ — **FIXED 31-Mar-26**.
  6 test files (20 tests) updated for `onset_delta_days` →
  `promoted_onset_delta_days` rename.

## Open items (curated)

**Verified**: 18-Apr-26 by direct code review of HEAD of
`feature/snapshot-db-phase0` plus uncommitted working-tree changes
(~118 files, 4.5k insertions / 2.5k deletions). This section is the
single source of truth — design docs may contain stale claims.

**Key context before reading the list**: a large in-flight refactor is
currently mid-flight in the working tree (items under "In flight").
Many things that looked "open" in the older design docs are in fact
being resolved by that diff right now, and several things that looked
"fine" are in flux. Do not start new work on items whose files are
listed in the "In flight" block until that tranche commits.

### In flight (uncommitted working tree)

These are partially-landed changes. Do NOT scope new work on top until
the diff commits and settles.

1. **`path_alpha/beta` → `cohort_alpha/beta` rename** across Bayes
   compiler, FE patch service, span adapter, API handlers, model
   resolver, surprise gauge, and tests. "Path" was misleading — those
   fields have always been cohort-mode posteriors on the edge, not
   path-composed values. The rename clarifies intent. Back-compat
   aliases are NOT being kept: consumers must be updated in lockstep.
   Left-overs should be swept before merge.
2. **Epistemic vs predictive alpha/beta separation** (doc 49 §A).
   `bayes/compiler/inference.py` now emits both `window_alpha/beta`
   (epistemic — moment-matched from raw trace) and
   `window_alpha_pred/beta_pred` (predictive — kappa-inflated via
   Williams on cohort trajectory residuals for cohort slice; kappa
   samples directly for window slice). Consumers pick the right one:
   MC sweeps use `*_pred` (what future observations will look like);
   FE model_vars display uses `*_pred` with fallback to epistemic;
   trace-derived fields for other purposes use plain `alpha/beta`.
3. **`completeness_mean` / `completeness_sd` threaded through** from
   `compute_forecast_sweep` (doc 45 response contract) into both the
   conditioned-forecast endpoint (`handle_conditioned_forecast`) and
   every cohort-maturity row. One computation, two reads. Requires
   `eval_age = frontier_age` on each `CohortEvidence` — set by
   `build_cohort_evidence_from_frames` in v3.
4. **`conversion_rate` analysis type** (doc 49 §B). New modules:
   [conversion_rate_derivation.py](graph-editor/lib/runner/conversion_rate_derivation.py),
   [epistemic_bands.py](graph-editor/lib/runner/epistemic_bands.py).
   Per-bin (day/week/month) aggregation of cohort k/n with epistemic
   HDI resolved from `fit_history` (as-at semantics). Scoped to
   non-latency edges only — latency edges return a per-subject failure
   (doc 49 Phase 3, separate design). Wired into
   `_handle_snapshot_analyze_subjects` and the legacy analyze path.
5. **Independent context dimensions** (doc 14 §15A.5). `evidence.py`
   and `model.py` now accept `independent_dimensions: list[str]`.
   Slices in an "independent" dimension get direct Beta priors with
   the base `alpha/beta_param` (no shared learned κ, no hierarchical
   τ offsets). Mixed pooled/independent dimensions supported with
   correct interleaving of the full slice vector. This replaces the
   old assumption that every dimension is pooled.
6. **Seven compiler defects fixed** (journal 18-Apr-26 update 13):
   per-slice onset=0 suppression in `param_recovery.py` (reporting);
   orthogonal multi-dim regime selection treating dims as competing
   regimes (extracted `select_regime_rows_multidim`); per-slice
   `kappa_lat` missing in batched trajectory path (now BetaBinomial);
   `is_exhaustive` coverage heuristic (now strict emptiness check);
   upstream `latency_vars` dropped on per-slice emission; Phase 2
   Case A overwriting per-slice `p_override`; branch-group Section 6
   first-sibling template (now iterates union).
7. **Regression tooling overhaul** (doc 44). Config-driven JSON
   plans, structured JSON results, canonical truth files moved to
   `bayes/truth/`, sparsity-sweep plans generated (18 YAMLs, 3 plans)
   but not yet executed.
8. **`stats_engine.py` agg_median fallback flag** — when cohort input
   has no usable median, falls back to `effective_horizon/2` but
   flags the fallback so BE/FE parity checks can verify nothing
   silently emitted the synthetic value.

### Owner's priority queue (18-Apr-26)

The owner's named work items, with pointers into the detail rows below.
Ordered as the owner groups them (three tiers separated by `---`).

**Tier 1 — production readiness**
- **BE forecasting & topo performance** — P2.11 (new).
- **Golden fixtures for forecasting; then retire v1/v2** — P2.10 (new).
- **Validate surprise gauge** (recent window/cohort on `gm-rebuild` is
  poor; "why not more surprising?") — P1.9 (new).
- **General-purpose conditioned forecast (lagless edges + topology
  coverage)** — P2.12 (new, doc 50). CF silently drops edges without
  a promoted latency distribution; coverage on mixed laggy/lagless
  topologies is untested; synth-mirror-4step demonstrates the silent
  drop today.

**Tier 2 — model-quality / infrastructure**
- **Orthogonal testing v2** — umbrella over P1.6, P1.7, P1.8 below.
- **Test sparseness** — P3.8.
- **Explore latency post-re-param** — P1.10 (new, research track).
- **Residual onset recovery challenges in contexted graphs** — P1.1 +
  P1.6 in combination (contexted onset positive bias on top of
  orthogonal-dim residual μ bias).
- **Dockerised Bayes?** — P3.22 (new).

**Tier 3 — new capability**
- **Non-default a-anchoring for cohorts** — P3.23 (new).

Detail below preserves the existing P1/P2/P3 numbering so code-review
comments can reference specific rows. New items added by this owner
list carry the lowest-unused number within their tier.

### P1 — Fitted-posterior correctness (model quality)

These are the items that actively bias the posterior used for charts,
topo-pass scalars, and forecast sweeps. Highest priority.

| # | Item | Evidence | Next action |
|---|------|----------|-------------|
| P1.1 | **Onset positive bias** across nearly all graphs. 14 of 19 z-score failures in 18-Apr-26 regression are onset. Mean bias +0.09 days, 19/20 graphs positive. Worse on edges with true onset > 2 days. Converges (rhat < 1.01, ESS > 2000) to the wrong answer. This is also the owner's "residual onset recovery challenges in contexted graphs" when compounded with P1.6. | [journal 18-Apr-26 update 13](18-compiler-journal.md). Hypothesis: softplus `effective_age = softplus(k × (age - onset)) / k` introduces asymmetric smoothing below onset, shifting MLE onset upward | Diagnostics before code: plot onset posterior vs truth across edges, coloured by true onset; sweep softplus `k` sensitivity; try wider onset prior (50% rather than 30% relative). Then decide between re-parameterising (P1.10), tightening prior, or replacing softplus |
| P1.2 | **Sigma universal positive bias**. +0.052 mean across 24/25 graphs; max z=16.0. Finite-interval CDF approximation artefact. | [journal 18-Apr-26 update 13](18-compiler-journal.md) | Known trade-off; not actionable without restructuring interval decomposition. Accept and document, or re-open only when a consumer demonstrably depends on tighter sigma recovery |
| P1.3 | **Contexted-graph convergence**. Pass rate: bare DSL 77%, contexted 20%. Large contexted graphs (`lattice-context`: 9 edges × 3 slices) come in at rhat=1.15, ESS=14. | [journal 18-Apr-26 update 13](18-compiler-journal.md); [journal 12-Apr-26 update 8](18-compiler-journal.md) scaling extrapolation: prod graphs (~12 edges × 10–15 slices) ≈ 2.5–5 h on CPU | Pursue the "one more big win" options from journal update 8: fixed-τ / empirical-Bayes (eliminates funnels), centred parameterisation for well-identified slices, further parameter sharing (p per-slice only; share κ / μ), or GPU. Not a single fix |
| P1.4 | **`synth-mirror-4step-slow` structural identifiability**. Deep chain with large latency. μ underestimated by 1.3–1.9 days even with rhat=1.004, ESS=3059. Model converges to the wrong answer. | [journal 18-Apr-26 update 13](18-compiler-journal.md). Likely likelihood-surface issue: latency parameters on sequential edges weakly identified when observation windows are short relative to cumulative path latency | Determine whether to add identifiability constraints (e.g. informative prior on path latency) or flag this topology class as "unfittable without assist". Write up the result in a new doc |
| P1.5 | **Diamond-context Phase 2 `onset_cohort` drift**. Phase 2 path-level onset variables drift +3 to +5.9 days from their Phase 1 composed values, producing p overestimates (truth 0.500 → Phase 2 0.893 on join-to-outcome). Chains stuck in different modes (rhat=2.10, ESS=5); not a number-of-draws issue. | [journal 13-Apr-26 update 11](18-compiler-journal.md:208). `path_onset_sd ≈ 0.1` permits 30–60 SD of drift; `path_t95` soft constraint too loose (±9 days envelope) | Candidates: derive `path_onset_sd` from Phase 1 posterior instead of fixed 0.1; add per-edge onset observation (not just t95); reparameterise additive drift as multiplicative (`onset_cohort = composed × (1 + eps × small_sd)`). Blocks Bayes GA on contexted production models |
| P1.6 | **Residual onset/μ bias on two-dim graph** after the 16-Apr aggregate-double-counting fix. Channel onset z=3.4–7.0, device-desktop μ z=15.0, sigma +0.108. Config D eliminates this on single-dim graphs; two-dim still fails. Part of the owner's "orthogonal testing v2" umbrella with P1.7 + P1.8. | [journal 16-Apr-26 update 12](18-compiler-journal.md:194). Not the same defect as P1.1 — persists even on graphs where P1.1 passes | Re-run after the "In flight" independent-dimensions work settles; it may resolve the two-dim case without new logic. Otherwise investigate whether it's a per-dim τ issue or a cross-dimensional interaction |
| P1.7 | **Phase 2 orthogonal context support missing**. Per-slice μ/onset from Phase 1 frozen priors is NOT propagated into Phase 2 frozen priors. Per-slice κ is independent LogNormal with no shared-population awareness across dimensions. No 1/N κ correction in Phase 2. Part of the "orthogonal testing v2" umbrella. | [journal 16-Apr-26 update 12](18-compiler-journal.md:157) Finding 3. `bayes/compiler/model.py` Phase 2 per-slice block | Design first, code second. Today's 1/N correction applies only to base/aggregate κ (correct by design after the cross-dim aggregate guard). Phase 2 contract for per-slice frozen priors needs specifying before implementation |
| P1.8 | **No per-slice t95 anchor**. `t95_obs` constrains edge-level only; slices with extreme onset via `delta_a` are unconstrained. May contribute to P1.6. Part of the "orthogonal testing v2" umbrella. | [journal 16-Apr-26 update 12](18-compiler-journal.md:169) Finding 4 | Assess impact: if removing per-slice onset (P1.10 research track) makes per-slice t95 moot, do nothing. Otherwise add the constraint |
| P1.9 | **Surprise gauge under-reports on live graphs** (owner observation). Recent window / cohort surprise on `gm-rebuild` reads as "really poor" data fit but the gauge does not flag it. User question: "why not more surprising?" | No journal entry yet. Surprise gauge is computed in `graph-editor/lib/api_handlers.py::_compute_surprise_gauge` (line ~541) — reads `cohort_alpha/beta` (after the in-flight rename) or `alpha/beta`. Likely candidates: (a) gauge uses epistemic α/β not kappa-inflated predictive (so observation dispersion is under-counted), (b) posterior has already absorbed the poor fit into a wide band so surprise is small by construction, (c) denominator/numerator of the surprise statistic is wrong for cohort-mode. Unverified | Reproduce on `gm-rebuild` with a known-poor window. Trace the gauge's inputs at compute-time — log `alpha`, `beta`, observed k/n and surprise score. Compare against what a naive z-score would say. Decide whether to switch the gauge to predictive (`*_pred`) inputs once the in-flight diff commits. Owner Tier-1 priority |
| P1.10 | **Latency post-re-param exploration** (owner research item). The onset-μ ridge blocks per-slice onset RVs today (ρ ≈ -0.99 on short-latency edges; anti-pattern 33); it may also drive P1.1 onset bias and P1.5 Phase 2 drift. Candidate re-parameterisations: multiplicative drift (`onset = composed × (1 + eps × small_sd)`), total-latency reparam (decouple onset and μ into sum / ratio), quintile reparam (naturally orthogonal). Explore once in-flight independent-dimensions work settles so a clean baseline exists | [journal 2-Apr-26 onset-μ ridge](18-compiler-journal.md) prior-sensitivity table; [journal 13-Apr-26 update 11](18-compiler-journal.md:208) reparam suggestions; anti-pattern 33 in codebase docs | Scope study: pick 1–2 reparameterisations, run the param-recovery regression, compare onset bias (P1.1) and Phase 2 drift (P1.5) against the current parameterisation. Write findings into a new doc and either adopt or record dead-end. Do NOT couple this with a production rollout — exploration only |

### P2 — Cohort-maturity chart + forecast-parity correctness

Items that directly change what the cohort-maturity chart or CF
endpoint shows. Verified against live code, not doc claims.

| # | Item | Evidence | Next action |
|---|------|----------|-------------|
| P2.1 | **V2/V3 cohort-midpoint divergence** accepted at 15% relative tolerance with >10% divergence on 45 τ values skip-listed. These are real algorithmic divergences from different population-model splicing and epoch handling, not a bug. | `bayes/tests/test_doc31_parity.py`, `test_v2_v3_parity.py`; [programme §v1/v2 parity tolerances](programme.md) | Revisit when v1/v2 are retired. Tighten to v2/v3-only tolerances at that point |
| P2.2 | **Two entry points into forecast pipelines**: `compute_conditioned_forecast` ([forecast_state.py:491](graph-editor/lib/runner/forecast_state.py#L491)) and `compute_forecast_sweep` ([forecast_state.py:1040](graph-editor/lib/runner/forecast_state.py#L1040)). Some shared infra (CohortEvidence, carrier builder) but separate preparation paths. | Direct read of [forecast_state.py](graph-editor/lib/runner/forecast_state.py). In-flight diff now uses `alpha_pred/beta_pred` with epistemic fallback in both paths — contract is converging but not yet unified | Extract a shared "prepared-input" contract for the two consumers (graph scalar, chart). Natural home for the doc 29 Step 1 `ForecastState` contract. Does NOT block the in-flight epistemic/predictive work |
| P2.3 | **Cohort-maturity: latency fall-back path-level → edge-level is silent**. `read_edge_cohort_params()` in [cohort_forecast.py:230](graph-editor/lib/runner/cohort_forecast.py#L230) falls back from path-level to edge-level latency when path-level is absent, with no flag on the response. Live when path-level params are missing | Direct read of `read_edge_cohort_params()`. User-visible consequence: wrong x/y forecasts in cohort mode with no FE indication | Emit a `latency_source` field on the response (`path-level` / `edge-fallback`). FE surfaces as provenance on the maturity chart |
| P2.4 | **Cohort-maturity fan-chart defects** from the harness notes: "fan too narrow" on multi-cohort groups, "evidence > midpoint in epoch B". Partially mitigated, still reproducible with certain data shapes. | [cohort-maturity-project-overview.md §7.1–7.2](cohort-maturity/cohort-maturity-project-overview.md); [cohort-fan-harness-context.md §8](cohort-maturity/cohort-fan-harness-context.md). Line numbers in those docs have drifted — re-forensic needed against current `cohort_forecast.py` and `cohort_forecast_v3.py` | Build the shared synth-fixture test harness (next row) first; then reproduce and fix |
| P2.5 | **Cohort-maturity shared test harness not built**. Current `test_cohort_fan_controlled.py` uses toy data with hand-picked y values. User flagged existing suite as inadequate. | [cohort-fan-harness-context.md](cohort-maturity/cohort-fan-harness-context.md) — 9-step plan, not implemented | Implement the JSON-fixture fork point in `api_handlers.py` + `cohort_forecast.py`; wire browser URL-param pass-through; port `test_cohort_fan_harness.py` |
| P2.6 | **Cohort-maturity: graph-wide x(s, τ) propagation engine** not built. Current local subject-edge shortcut works for linear funnels; fails on complex topologies with materially immature upstream edges. | [cohort-backend-propagation-engine-design.md](cohort-maturity/cohort-backend-propagation-engine-design.md) (design only); [cohort-maturity-full-bayes-design.md §7.4](cohort-maturity/cohort-maturity-full-bayes-design.md) | Only implement against an observed production graph that fails. Current shortcut viable for linear funnels |
| P2.7 | **Phase C multi-dimension gaps**: `conditional_p` never emitted (grep confirms); subsumption hierarchy not implemented. Per-dimension τ IS emitted after recent work (was the earlier claim). | Direct read of `bayes/compiler/model.py` (no `conditional_p` references); the "In flight" independent-dimensions work addresses the τ gap | `conditional_p` only needed once a consumer wants separate per-slice simplexes not pooled by the aggregate. Subsumption pushed to Phase C production-hardening |
| P2.8 | **Mixture-trajectory latency dispersion contract undefined**. Single-path trajectory now uses BetaBinomial + `kappa_lat_slice_vec` (landed 18-Apr-26, journal update 13 Fix 3). Mixture path has not been extended. | Direct read of `model.py:3521–3550` (single-path); no BetaBinomial in mixture emit path | Decide: extend BetaBinomial to mixture paths with a single edge-level `kappa_lat`, OR document mixture as Binomial-only. Either is defensible; don't leave it implicit |
| P2.9 | **Cohort-completeness parity question**: Bayes uses model-derived FW composition; FE stats engine uses observed `anchor_median_lag_days`. Snapshot DB stores both; `evidence.py` reads neither. | [programme §Other open](programme.md) discussion note; [snapshot_service.py:566](graph-editor/lib/runner/snapshot_service.py) | Decide whether Bayes should incorporate observed anchor lags as an alternative / additional signal. Not a bug — just a parity discussion |
| P2.10 | **Golden fixtures for forecasting, then retire v1 and v2** (owner Tier-1 priority). Today three forecast pipelines coexist: `cohort_forecast.py` (v1), `cohort_forecast_v2.py` (v2, span-kernel), `cohort_forecast_v3.py` (v3, engine-via-sweep). Parity is enforced by `test_doc31_parity.py` and `test_v2_v3_parity.py` with relaxed tolerances and skip-lists. Retiring v1/v2 is risky without frozen golden outputs | Direct `ls graph-editor/lib/runner/cohort_forecast*.py`. Current parity tests verify algorithmic equivalence within tolerance but don't freeze numeric output | Build a golden-fixture suite: a fixed graph + evidence + query, exact expected per-τ row values, committed to the repo. Run against v3 on every change. Then delete v1 + v2 code paths and their handler branches once v3 has burned in for N runs without fixture drift |
| P2.11 | **BE forecasting & topo performance** (owner Tier-1 priority). User-visible latency on topo pass and chart requests. No current measurement baseline in programme docs. | Topo pass wired through `api_handlers.py::handle_stats_topo_pass` (:5716); cohort maturity v3 through `_handle_cohort_maturity_v3` (:2018); conditioned forecast through `handle_conditioned_forecast`. Hot path likely dominated by per-subject snapshot queries (`query_snapshots_for_sweep_batch`), MC sweep (`compute_forecast_sweep` 2000+ draws) and span-kernel composition. Sampling-side perf separately tracked as P3.21 | Measure first. Add timing spans around: snapshot query, frame composition, sweep, row assembly, carrier build. Publish a baseline per analysis type. Then pick the dominant cost and optimise. Likely candidates: vectorise MC sweep across cohorts, cache span CDFs across repeated queries, reduce 2000-draw default when band-width doesn't require it |
| P2.12 | **Conditioned forecast is not general-purpose**. CF's per-edge path short-circuits when `resolved.latency.sigma <= 0` ([cohort_forecast_v3.py:307](graph-editor/lib/runner/cohort_forecast_v3.py#L307)) and silently omits the edge from the response. Works accidentally on `bayes-test-gm-rebuild` because BE topo wrote a synthetic near-zero lag into `analytic_be` (μ≈-6.5, σ≈2.8, t95≈0.15); fails silently on `synth-mirror-4step` where that synthetic isn't present. For lagless edges CF should still emit a Beta-Binomial posterior on `p`. Topology coverage is thin: only two linear synth chains exercise CF end-to-end; no mixed-class (laggy + lagless) or branching / join fixtures. | Direct comparison of mv[analytic_be] across graphs (inspected 18-Apr-26). `synth-mirror-4step` entry-hop edges: `wg_pmean=None` in the parity script. `handle_conditioned_forecast` appends neither to `edge_results` nor to `skipped_edges` when `maturity_rows` is empty — silent drop. See [doc 50](50-cf-generality-gap.md) for full problem statement, proposal (Class A lag-sweep / Class B Beta-Binomial / Class C–D skipped with reason), and topology test matrix (T1–T7) | (1) Build topology fixtures T1–T7 and CLI harness `cf-topology-suite.sh`. (2) Implement lagless Class B path + structured `skipped_edges`. (3) Enforce "no silent drops" invariant in CI. Fuller sequencing and design questions (prior choice, completeness semantics, sibling PMF consistency) in doc 50 §4 and §6 |

### P3 — Tooling, tests, infrastructure

Important for velocity and quality of future work, but not blocking
correctness today.

| # | Item | Evidence | Next action |
|---|------|----------|-------------|
| P3.1 | **Predictive summarisation non-deterministic** — `np.random.beta` on global NumPy RNG in `_predictive_alpha_beta`. Same trace → different predictive α/β each run. | [bayes/compiler/inference.py](bayes/compiler/inference.py) lines around `_predictive_alpha_beta` | Replace with a local seeded `Generator`. Seed derived from fit fingerprint. Add regression comparing byte-identical summarisation across runs |
| P3.2 | **LOO null does not mirror fitted likelihood**. `_compute_analytic_baselines` in `bayes/compiler/loo.py` builds edge-level baselines without branching on path-latency / dropout / κ-scaling structure. So `delta_elpd` compares unlike objects. | Direct read of `loo.py` | Make the set of LOO-scored families explicit in `trace.log_likelihood`; make nulls mirror the fitted structure exactly. Only then keep `delta_elpd` as a visible quality signal |
| P3.3 | **Path provenance vocabulary too coarse**. Current binary (`bayesian` vs `pooled-fallback`, gated on rhat/ESS) should be richer: `bayesian`, `derived-bayesian`, `derived-pooled-fallback`, `empirical`, `point-estimate`. | Direct read of [bayes/compiler/inference.py](bayes/compiler/inference.py) lines 1603, 1376, 1019. NOT "hard-coded" as doc 33 §4.6 claims | Introduce the richer vocabulary and propagate through `worker.py` → `bayesPatchService.ts` → `bayesQualityTier.ts` |
| P3.4 | **Phase C dedicated test suite missing**. Only subsection headers in `test_regression_audit.py`; no `test_phase_c.py`. Regime-binder tests RB-001–005 not written. | Direct `ls bayes/tests/` | Write `test_phase_c.py` covering multi-dim Dirichlet, regime-tag → likelihood selection (RB-003 is a Phase C prerequisite), per-slice vs edge-level pooling, independent vs pooled dimensions |
| P3.5 | **Phase 2 devtooling test coverage**. `--phase2-from-dump` flag works end-to-end but lacks automated tests (replay path, `param_recovery.py` parsing changes, analytic comparison, timeout guard) | [programme](programme.md) 13-Apr-26 entry | Add e2e test for the replay path and unit tests for the parsing changes |
| P3.6 | **Data-binding parity invariants untested end-to-end**. 5 defects fixed during 12-Apr-26 investigation; 6 invariants defined but no blind parity tests. | [doc 39](39-data-binding-parity-defects.md) | Write the 6 invariant tests over `total_n`, trajectory counts, regime selection, aggregate suppression. Required before retiring any FE stats path |
| P3.7 | **PPC trajectory validation blocked** on synth DGP mismatch. Endpoint PPC validated; trajectory PPC needs single-source synth flag (`kappa_step_default: null`). MLE-κ empirical-Bayes prior already landed as priority 2 in `build_model` kappa chain. | [doc 36](36-posterior-predictive-calibration.md); [doc 38](38-ppc-calibration-findings.md); [journal 12-Apr-26 update 7](18-compiler-journal.md:524) | Implement the synth flag in `synth_gen.py`; run trajectory PPC on a clean DGP |
| P3.8 | **Sparsity sweep infrastructure ready but not executed**. 18 truth YAMLs + 3 plans generated 18-Apr-26; blocked on truth-file activation (data-repo bootstrap). No output CSV yet. | [journal 18-Apr-26 update 13](18-compiler-journal.md) | Activate truth files; run the sweep (`--draws 5` feasibility first, then full). Decision gate: adaptive per-slice parameterisation vs ship centred as default |
| P3.9 | **ASAT Phase A remaining FE work**. 18/18 blind tests pass. Remaining: typed `asat_date` on `AnalysisResult`, chart subtitle / badge, tooltip provenance, scenario-layer visual indicator. | [doc 7](7-asat-analysis-completion.md), [doc 42b](42b-asat-remedial-workplan.md) | Ship the FE surfaces on the existing BE contract. Phase B (forward-looking forecasts at historical asat) depends on fit-history reconstruction — separate item |
| P3.10 | **ASAT Phase B reconstruction**. `fit_history` is appended by `bayesPatchService.ts` on every patch apply (FE-side), so the history DOES exist on graph edges. What is missing is a BE path that reconstructs a posterior at a historical asat by walking that history. | FE: grep `fit_history` in `graph-editor/src/services/bayesPatchService.ts` (writes). BE: no `fit_history` reads in `worker.py` or compiler. `epistemic_bands.py` does read `fit_history` from the edge for conversion-rate as-at resolution | Design first: decide whether asat Phase B uses the FE-persisted history directly or requires a separate BE archive. Update [doc 27](27-fit-history-fidelity-and-asat-posterior.md) to reflect that FE-side history exists |
| P3.11 | **Topology-signature FE surfacing**. Backend fingerprint IS computed per fit unit (`topology.py` `_compute_fingerprint`). Missing: FE staleness detection on pull, UI surfacing of stale posteriors, warm-start invalidation when topology changes. | Direct read of `bayes/compiler/topology.py` + search in `graph-editor/src` for fingerprint consumers | Do when data-integrity failures become observable. Not blocking nightly scheduling |
| P3.12 | **Nightly Bayes fit — production validation**. All 5 reconnect phases implemented 7-Apr-26. Needs `runBayes` turned on for a real graph and observed through a fetch cycle. | [doc 28](archive/28-bayes-run-reconnect-design.md) (archived as implemented); [programme](programme.md) | Needs a graph owner willing to pilot |
| P3.13 | **FE stats deletion residuals** — D11 onset fallback discrepancy, Pattern A EdgeContext fragility, `cohortsForFit` empty-set fallback. Graph-level parity proven 2-Apr-26; live fixture at 1 mismatch (stale blended_mean) | [programme §FE stats deletion](programme.md) | Decide D11 design; review Pattern A fragility; fix empty-set fallback |
| P3.14 | **Snapshot regime-selection FE preflight removal** (Phase 5). BE `select_regime_rows` + 24 tests landed 8-Apr-26 and wired into API/worker; FE still runs the old preflight | [doc 30](30-snapshot-regime-selection-contract.md) | Schedule with next FE hygiene pass |
| P3.15 | **Mixture latency models (bimodal edges)** — Phase E of compiler phases. Designed, not started. | [doc 23 §12](archive/23-two-phase-model-design.md) | Only prioritise once a production graph has a clearly bimodal edge |
| P3.16 | **Multi-hop cohort-maturity Phase B** (x provider for x ≠ a with proper a→x propagation). Phase A single-hop parity passed 13-Apr-26; Phase B not started | [doc 29d](29d-phase-b-design.md); [doc 29e](29e-forecast-engine-implementation-plan.md) | Depends on multi-hop acceptance tests for Phase A; best-available promoted-model resolution ([api_handlers.py:3262](graph-editor/lib/api_handlers.py#L3262) already has a fallback chain) |
| P3.17 | **Per-slice onset** — edge-level only by design (onset-μ ridge makes per-slice onset RVs unidentifiable). Breaks per-slice recovery when truth onset differs per slice. Universal across contexted graphs. | [model.py](bayes/compiler/model.py) per-slice emission; [programme](programme.md) "by design" note | Research track (quintile reparameterisation). Not a defect to fix directly |
| P3.18 | **Lag-array defect on window slices**. 71/207 nonzero for test graph. Warm-start + onset histogram bypass the first-run prior issue. | [doc 16](16-lag-array-population-defect.md) | Revisit only if a warm-start-free path regresses |
| P3.19 | **BE stats-engine three-way prior discrepancy** (FE / BE / topology latency priors). Only topology value produces convergent MCMC. Warm-start bypasses the divergent path | [doc 19](19-be-stats-engine-bugs.md) | Revisit during P3.13 |
| P3.20 | **Whole-graph forecast pass** design | [doc 47](47-whole-graph-forecast-pass.md) (design) | Pull when P2.2 + P2.6 are unblocked |
| P3.21 | **Sampling performance research** — compile time 155s on branch graph, GPU experiments, dev-mode draws | [doc 22](22-sampling-performance.md) | Research only; not blocking |
| P3.22 | **Dockerised Bayes** (owner Tier-2 item, marked with `?`). Today's Bayes worker runs on Modal in production and locally via `graph-editor/venv`. No container image. Impact: onboarding friction for new environments; cold-path reproducibility; and moving the worker off Modal requires a portable runtime | No existing doc or Dockerfile. `bayes/requirements.txt` pins JAX, PyMC, nutpie | Decide scope first: dev-loop container only, or production-candidate image? Dev-loop is cheap (pin Python, install requirements, mount code). Production replacement is a multi-week project (image build, GPU story, secrets, webhook surface). Write a short scope doc before starting |
| P3.23 | **Non-default a-anchoring for cohorts** (owner Tier-3 new capability). Today cohort() queries anchor on the edge's from-node (or the query-path's anchor when multi-hop). "Non-default a-anchoring" would allow cohorts to be anchored on a different node, e.g. for path-relative or event-relative cohort definitions | No existing code path. Current anchor resolution is in `analysis_subject_resolution.py` (`resolve_analysis_subjects`) and `_apply_temporal_regime_selection`. The cohort evidence builder takes `anchor_from/to` as fixed date ranges, not as variable node selectors | Design first: what DSL syntax denotes "anchor on node X"? What evidence family does a non-default anchor read? How does regime selection interact? Likely new doc. Depends on producer (does the snapshot DB have a_pop for arbitrary anchor nodes?) and consumer (do any forecast paths assume anchor = path start?) |

### Stale claims and doc drift — required doc updates

Doc tree still carries claims that current code contradicts. Each
needs its originating doc updated in a follow-up.

| Stale claim | Reality | Doc update |
|---|---|---|
| "Endpoint double-counting: terminal observation contributes to trajectory interval likelihood AND endpoint BB" ([doc 33 §4.1](33-bayes-compiler-dispersion-forensic-review.md); doc 48 Fix 1) | Endpoint BB path filters immature observations (`model.py:3917–3920, 3989–3992`) and diagnostics record exclusion counts. The claimed double-counting cannot be reproduced by grepping the likelihood emission | Doc 48 Fix 1 needs re-specification against current code, or marked superseded |
| "Phase 2 non-exhaustive branch prior order-dependent" ([doc 33 §4.2](33-bayes-compiler-dispersion-forensic-review.md); doc 48 Fix 2) | `model.py:646–725` builds `dir_alphas` array before `Dirichlet` construction; no `kappa_group` variable exists; no per-sibling mutable state | Doc 48 Fix 2 either mis-describes the defect or it was silently resolved. Re-read before acting |
| "Batched window trajectory uses plain Binomial" (programme prior Open issues; doc 48 §5.2) | `model.py:3521–3550` emits BetaBinomial with `kappa_lat_slice_vec` when `latency_dispersion` enabled. Fixed 18-Apr-26 | Already removed from programme's Open issues. Doc 48 §5.2 correctly flags as fixed but leaves mixture path open (P2.8 here) |
| "Path provenance hard-coded `bayesian` unconditionally" ([doc 33 §4.6](33-bayes-compiler-dispersion-forensic-review.md)) | `inference.py:1603, 1376, 1019` — gated on rhat < threshold and ESS ≥ threshold. Flat binary, but not unconditional | Doc 33 §4.6 should be reworded as "provenance vocabulary too coarse" — now P3.3 |
| "Topology fingerprint is a stub" ([doc 10](10-topology-signatures.md)) | `topology.py:208, 420–425` — `_compute_fingerprint()` hashes anchor, edges, branch groups per fit unit | Doc 10 header should note BE fingerprint done; remaining work is FE staleness surfacing — now P3.11 |
| "Snapshot query batching — 2N round-trips" ([doc 33B](33-snapshot-query-batching.md)) | `worker.py:1975–2085` collects hashes into `all_hashes` set and issues one batch via `query_snapshots_for_sweep_batch(...)` | Mark doc 33B resolved |
| "Fan chart MC zero-width bands from sparse `cohort_at_tau`" ([fan-chart-mc-bug.md](cohort-maturity/fan-chart-mc-bug.md); cohort-maturity INDEX "known open bug") | `cohort_forecast.py:201–215` — dense per-cohort carry-forward present (`last_x`, `last_y`). Also in `cohort_forecast_v3.py:199–215` | Mark fan-chart-mc-bug.md resolved |
| "`_read_edge_model_params` only consumes Bayes posterior" ([cohort-maturity INDEX §6](cohort-maturity/INDEX.md)) | `api_handlers.py:3262–3310` — fallback chain present: Bayes posterior → stats-pass flat → defaults | Mark the INDEX prerequisite complete |
| "JAX gradient backend is default" ([programme](programme.md); anti-pattern 36) | `inference.py:1802–1820` — gradient backend is ALWAYS pytensor (symbolic gradients). Compute backend (numba / JAX) is the configurable piece | Anti-pattern 36 + programme prose should say "symbolic gradients on pytensor; compile to JAX for compute" |
| "`topo_pass` contains snapshot DB access for forecasting" ([doc 45](45-forecast-parity-design.md)) | `api_handlers.py::handle_stats_topo_pass` (:5716–5800) takes pre-computed `cohort_data`, calls `enhance_graph_latencies()` (analytic only). No snapshot DB access | Update doc 45 / 45b scope — the defect either was fixed or was never the right description |
| "Cohort `immature_fraction²` scaling at `cohort_forecast.py:548`" ([cohort-maturity overview §7.2](cohort-maturity/cohort-maturity-project-overview.md)) | No `immature_fraction` / `avg_hw` at that line. Line numbers drifted | Re-forensic before writing the fix — merged into P2.4 |
| "Diamond-context Phase 2 JAX div-by-zero at init" (handover `12-Apr-26-jax-backend-contexted-compilation.md`) | Resolved by moving gradient backend to pytensor (symbolic first). Diamond-context now rhat=1.046, ESS=78 on that path | Handover superseded; anti-pattern 36 owns the cause |
| "Aggregate double-counting across orthogonal context dimensions" (prior programme Open issues) | Fixed 16-Apr-26: row-level dedup + cross-dimension guard in `evidence.py`. Journal update 12 | Already removed from programme here |

### Sequencing guidance

Owner's tiering (from §"Owner's priority queue") is the primary axis.
Not a strict order within a tier — the in-flight diff may change
dependencies. Read together with **In flight** above.

**Tier 1 — owner's top focus**
1. **P1.9 — validate surprise gauge**. Reproducible on `gm-rebuild`;
   measure first. Small investigation, likely feeds into whether the
   gauge switches to predictive (kappa-inflated) inputs once the
   in-flight `*_pred` work commits.
2. **P2.11 — BE forecasting & topo performance**. Measure first. No
   optimisation without a baseline.
3. **P2.10 — golden fixtures + retire v1/v2**. Prerequisite for
   cleanly deleting code without introducing silent regressions.
   Write the fixture suite now; the in-flight cohort_forecast diff
   makes the retirement safer when it settles.
4. **P2.12 — general-purpose CF (lagless + topology)**. Today CF
   silently drops edges whose promoted latency has `sigma ≤ 0`;
   coverage on mixed and branching topologies is untested. Doc 50
   captures the problem, proposed Class-A / Class-B split, and the
   T1–T7 topology test matrix. Natural companion to P2.10: both
   require whole-graph CF contract stability before retiring v1/v2.

**Tier 2 — model quality / infrastructure**
4. **P1.1 — onset bias diagnostics** (pure investigation). Natural
   precursor to P1.10 and to deciding the owner's "residual onset
   recovery in contexted graphs" strategy.
5. **P1.6 / P1.7 / P1.8 — orthogonal testing v2 umbrella**. Re-run
   after the in-flight independent-dimensions work settles; P1.6
   may resolve on its own. Then tackle P1.7 Phase 2 contract and
   P1.8 per-slice t95 only if P1.6 still fails.
6. **P3.8 — sparsity sweep**. Infrastructure is ready; blocked on
   truth-file activation in the data repo.
7. **P1.10 — latency re-param exploration**. Research track; decide
   after P1.1 diagnostics.
8. **P3.22 — Dockerised Bayes**. Scope-decision first; pull into the
   queue once scope is agreed.

**Tier 3 — new capability**
9. **P3.23 — non-default a-anchoring for cohorts**. Design doc first.

**Do not start** until the in-flight diff commits:
- P2.1, P2.2, P2.4, P2.5, P2.8 (all touch files heavily in flux)

**Unblocked quick wins** (background work while Tier-1 investigation
lands): P3.1 deterministic summarisation; P3.6 data-binding parity
invariants; P3.4 Phase C dedicated test suite.

**Explicitly blocked on in-flight settle**:
- P1.6 (two-dim residual bias) — may resolve on its own after
  independent-dimensions work
- P2.7 (`conditional_p`) — implement after the dimension-pooling
  contract stabilises
- P3.10 (ASAT Phase B) — needs the fit_history FE-side write to be
  production-visible first

### Minimum completion standard (applies to every item)

1. Code change lands with a targeted regression proving the invariant.
2. FE surface still tells the truth (labels, provenance, warnings).
3. Originating doc(s) updated — status block, remaining-work section,
   and stale references retired.
4. This `Open items (curated)` section updated in the same PR.

---

## Design docs

**Full index**: [INDEX.md](INDEX.md) — complete catalogue of all docs
(active + archived, code-verified status). The table below lists
active docs only; see `archive/` for implemented work.

### Active design docs

| Short name | File | Status | Scope |
|---|---|---|---|
| **Model contract** | `1-cohort-completeness-model-contract.md` | Partial | Cohort semantics, evaluator unification |
| **asat() completion** | `7-asat-analysis-completion.md` | Partial | Historic/future asat through analysis/charting |
| **Compiler phases** | `8-compiler-implementation-phases.md` | Partial | A-D done; Phase C model emission + Phase E not started |
| **Topology signatures** | `10-topology-signatures.md` | Design only | Per-fit-unit staleness detection |
| **Quality gating** | `13-model-quality-gating-and-preview.md` | Partial | Quality tiers done; accept/reject preview not built |
| **Phase C design** | `14-phase-c-slice-pooling-design.md` | Design only | Hierarchical Dirichlet pooling for context slices |
| **Lag array defect** | `16-lag-array-population-defect.md` | Open defect | Window values[] lag arrays mostly zero |
| **Fit history fidelity** | `27-fit-history-fidelity-and-asat-posterior.md` | Design only | Full-fidelity archival, asat() reconstruction |
| **Generalised forecast** | `29-generalised-forecast-engine-design.md` | Design only | A→Z multi-hop maturity, forecast-state contract |
| **Regime selection** | `30-snapshot-regime-selection-contract.md` | Partial | BE utility + FE candidates + mece_dimensions done; Phase 5 + RB tests pending |
| **BE subject resolution** | `31-be-analysis-subject-resolution.md` | Implemented (8-Apr-26) | `resolve_analysis_subjects()` + parity tests. Wired into `api_handlers.py` |
| **Posterior scoring** | `32-posterior-predictive-scoring-design.md` | Partial (Phase 1 done 8-Apr-26) | LOO-ELPD Phase 1 done; Phase 2 (trajectory) pending |
| **BE stats bugs** | `19-be-stats-engine-bugs.md` | Open defect | Three-way latency prior discrepancy |
| **PPC calibration design** | `36-posterior-predictive-calibration.md` | Partial (12-Apr-26) | PIT uniformity, coverage curves, per-edge KS test |
| **PPC calibration findings** | `38-ppc-calibration-findings.md` | Partial (12-Apr-26) | Implementation, three-layer validation, synth DGP mismatch |

### Reference and operational docs (still in place)

| Short name | File | Scope |
|---|---|---|
| **Reference impl** | `2-reference-implementation-notes.md` | PyMC patterns, prior art |
| **Local dev setup** | `5-local-dev-setup.md` | Local dev environment, tunnel |
| **Synth generator** | `17-synthetic-data-generator.md` | Phase 1 done; Phase 2 not built. Active reference |
| **Compiler journal** | `18-compiler-journal.md` | Ongoing (~4400 lines, last entry 6-Apr-26) |
| **Synth playbook** | `19-synthetic-data-playbook.md` | Operational guide |
| **Sampling perf** | `22-sampling-performance.md` | Research complete; no experiments run |
| **Stats domain** | `statistical-domain-summary.md` | Statistical foundations reference |
| **Regime examples** | `30b-regime-selection-worked-examples.md` | Companion to doc 30 |

### Archived docs (22 docs — see `archive/` and INDEX.md)

Implemented and superseded docs moved to `archive/` on 8-Apr-26.
Essential knowledge captured in codebase docs:
`PYTHON_BACKEND_ARCHITECTURE.md`, `STATISTICAL_DOMAIN_SUMMARY.md`,
`FE_BE_STATS_PARALLELISM.md`.

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
    (`statsParity.contract.test.ts` + `test_stats_parity_contract.py`).
  - **Status (2-Apr-26)**: Parity consolidation pass resolved 10 orchestration
    deltas (D1–D10). Graph-level parity now proven via Vector 7 (synthetic
    3-edge graph — FE and BE match at rounding tolerance). Live fixture
    improved from 15 mismatches to 1. Detailed plan and ledger at
    `.claude/plans/inherited-floating-crown.md`. Changes:
    - D1: `query_mode` threaded to BE (window/cohort semantics match)
    - D2: `compute_per_day_blended_mean` ported to BE (exact match proven)
    - D3: BE request builder uses runtime settings (IDB overrides)
    - D4: t95 split: `user_t95` (fit constraint) vs `effective_t95` (horizon)
    - D5: FE active-edge set sent to BE
    - D6+D7: UK date parsing, left-censor alignment
    - D8: Rounding tolerance in parity comparison
    - D9: Deterministic traversal order (sorted queue + edge-ID tie-breaking)
    - D10: Graph-level parity test (Vector 7) added to both FE and BE contracts
    - Horizon bootstrap moved from BE network call to FE-only fitting
  - **Remaining issues (2-Apr-26)**:
    - **D11 — Onset fallback discrepancy**: FE `enhanceGraphLatencies` derives
      `edgeOnsetDeltaDays` only from window() slices in `paramValues`, defaulting
      to 0 when none exist. BE falls back to graph-stored `onset_delta_days`.
      These are semantically different scalars (window-derived onset vs
      user/file-stored onset). In cohort-mode-only queries with non-zero graph
      onset, FE and BE diverge. Needs design decision — not a safe fallback.
    - **Pattern A — EdgeContext structural fragility**: FE recomputes onset,
      forecastMean, cohortsScoped, and nBaseline live from `paramValues`. BE
      depends on pre-computed values in `edge_contexts` sent by the FE request
      builder (`beTopoPassService.ts`). If the request builder misses a field,
      BE silently falls back to different values (graph-stored or defaults).
      Any new paramValues-derived input added to FE must have a corresponding
      `edge_contexts` entry — otherwise BE silently diverges.
    - **cohortsForFit empty-set fallback**: FE keeps the empty set after
      left-censoring (all cohorts older than censor window). BE falls back to
      the full uncensored set. Minor — only affects edges where all cohorts
      exceed the 100-day censor.
    - **D12 — Heuristic dispersion parity**: Both FE and BE now compute
      heuristic dispersions (`p_sd`, `mu_sd`, `sigma_sd`, `onset_sd`,
      `onset_mu_corr`) per `heuristic-dispersion-design.md` §3. Edge-level
      parity confirmed at 1e-9 tolerance via Vector 6 contract test.
      Path-level propagation (quadrature sum: `path_mu_sd`, `path_sigma_sd`,
      `path_onset_sd`) implemented on both sides. `beTopoPassService.ts`
      passes all dispersion fields through to `analytic_be` model_vars.
- Disable FE topo/LAG fitting pass
- Delete FE fitting codepaths: `statisticalEnhancementService.ts`,
  `lagDistributionUtils.ts`, `forecastingParityService.ts`, and related modules
- Update or remove associated test files

**Not in scope**: changing the BE fitting implementation.

**Exit criterion**: no FE code path calls `fitLagDistribution`,
`computeEdgeLatencyStats`, `approximateLogNormalSumFit`, or any other fitting
function. Build and lint confirm zero references.

**Design detail**: Model contract, section 14.3. Detailed plan and ledger at
`.claude/plans/inherited-floating-crown.md`.

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
- Phase C: slice pooling + hierarchical Dirichlet.
  Phase 1 per-slice: DONE (12-Apr-26). Phase 2 per-slice: DONE (12-Apr-26) —
  frozen Phase 1 per-slice posteriors as Beta priors, per-slice cohort
  trajectory Potentials, per-slice cohort p extraction to summary.
  Remaining: Phase 1 convergence gate before Phase 2 — if Phase 1
  ESS < threshold or rhat > threshold, skip Phase 2 per-slice and fall
  back to aggregate-only (prevents bad Phase 1 posteriors poisoning
  Phase 2 priors). Observed: Phase 1 ESS=48 with 500 draws / 2 chains
  caused Phase 2 to stall; Phase 1 ESS=1425 with 1000 tune worked.
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

- ~~**Historical DSL epoch hash discovery for Bayes**~~: **RESOLVED
  12-Apr-26.** `buildCandidateRegimesByEdge` Step 5 now inspects
  stored param file `values[]` entries via `enumeratePlausibleContextKeySets`
  to discover hash families not in the current DSL. Also fixed: window
  and cohort temporal modes are now grouped into one candidate regime
  per context key-set (previously they competed, with regime selection
  discarding all cohort data for contexted graphs). See journal
  12-Apr-26 update 5.

- **Phase 2 per-slice modelling not implemented**: Phase 2 (cohort pass
  with frozen Phase 1 posteriors) is aggregate-only for contexted
  graphs. All per-slice logic in `model.py` is gated behind
  `not is_phase2`: Section 2b (per-slice Dirichlets), Section 5
  (per-slice emissions), Section 4 (per-slice cohort latency). Phase 2
  builds a 7-RV aggregate model. Per-slice cohort posteriors in the
  output are copies of window posteriors (labelled `[window-copy]`).
  Fix requires: per-slice p hierarchy in Phase 2, per-slice branch
  group Dirichlets, per-slice cohort latency triples, per-slice
  emission in the Phase 2 Section 5 loop. Priority: high — affects
  all contexted graphs. See journal 12-Apr-26 update 4.

- **Topo pass not producing per-slice priors**: the analytic topo pass
  (`analyse_topology`) produces one set of priors per edge (aggregate
  k/n ratio from param file values[]). For contexted graphs, each
  slice should get its own analytic prior derived from per-context
  values[] entries. Without this, per-slice analytic comparison in
  the regression report compares per-slice posteriors against aggregate
  analytic baselines. The LOO null model also uses aggregate baselines.
  Priority: medium — affects regression reporting accuracy and LOO
  scoring, not model correctness (the model uses its own hierarchy).

- **Phase 1 contexted compilation performance**: `synth-simple-abc-context`
  (2 edges × 3 slices, 57 free RVs) takes ~70s for nutpie/Rust
  compilation before MCMC starts. Larger contexted graphs (diamond,
  lattice) would take much longer. The compilation time scales
  super-linearly with free RV count. Per-slice latency hierarchy
  (eps_mu, eps_sigma, eps_onset per slice) contributes ~18 RVs for
  3 slices. With `latency_dispersion=true`, per-slice kappa_lat adds
  ~6 more. Options: (a) share latency across slices (only p varies),
  (b) disable latency_dispersion for per-slice Potentials,
  (c) investigate nutpie compilation optimisation. Priority: high —
  blocks full contexted regression suite. See doc 37.

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

## Date coherence: fitted_at / model_trained_at / source_at (31-Mar-26)

**Problem**: Bayes posteriors carry dates in multiple places that can
become inconsistent:
- `posterior.fitted_at` — on the probability posterior (graph + param file)
- `latency.posterior.fitted_at` — on the latency posterior (graph + param file)
- `latency.model_trained_at` — on the latency block (graph only)
- `_posteriorSlices.fitted_at` — on the posterior slices (param file)
- `model_vars[].source_at` — per-source model vars (graph)

When `asat()` is used, `resolveAsatPosterior` checks `posterior.fitted_at`
to decide whether the posterior is valid for that historical view. If
`fitted_at` on ANY of these is after the `asat` date, the posterior is
rejected and the edge has no Bayes params for that analysis.

**Current mess**:
- `fitted_at` exists on both graph and param file; they can diverge
- `model_trained_at` is only on graph, only on edges with `latency_parameter: true`
- `source_at` on model_vars may differ from `fitted_at` (manual edits)
- Not all edges with Bayes posteriors have `model_trained_at`

**Needs**: A single authoritative timestamp for "when was this model fit"
that is consistent across all surfaces. `bayesPatchService` should set
all date fields atomically from one source. `resolveAsatPosterior` should
check one canonical field, not fish through multiple.

**Priority**: Medium — blocks reliable `asat()` testing of fan charts.

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

---

## Heuristic Dispersion for Non-Bayes Stats Pass (2-Apr-26)

**Status: PLUMBING COMPLETE — CALIBRATION NOT COMPLETE. BLOCKED.**

### What is done

Full pipeline wired end-to-end: FE + BE stats passes compute heuristic
SDs → written to model_vars → promoted to edge → read by
`_read_edge_model_params` → consumed by cohort maturity fan chart and
confidence bands → rendered by widened chart gates. `ModelCard`
component generalises the Bayesian card for all sources. JSON schema
updated. Parity test for SD field sanity ranges added.

Design: `heuristic-dispersion-design.md`. Date model fix and
`snapshot_date` rename also done in same session.

### What is NOT done — dispersion values are not sane

**The heuristic SD formulas are not calibrated against real data.** The
current constants were guessed, producing confidence bands that span
0–100% at the CDF inflection point. This is because:

1. **`onset_sd` has outsized influence.** ∂rate/∂onset peaks at the CDF
   inflection point. The delta method amplifies onset_sd enormously
   there. A 1-day onset uncertainty (the original floor) produces bands
   covering the entire chart. The current floor (0.2 days) is still a
   guess.

2. **Default-sigma `sigma_sd` is a guess.** When sigma falls back to
   0.5 (mean lag unavailable), sigma_sd = 0.10 (20% relative) has no
   principled basis.

3. **No empirical validation.** The formulas have never been compared
   against Bayesian posterior SDs from real edges.

### Required calibration work

1. **Pull real edges** from the data repo that have both analytic fits
   AND Bayesian posteriors. For each edge, record the Bayesian posterior
   SDs (ground truth) and compute what the heuristic formulas produce
   from the same input cohort data. Compare.

2. **Understand onset_sd from the Bayesian compiler.** The compiler
   computes `onset_sd = std(onset_samples)` from MCMC. What data
   structure drives this? The heuristic should approximate the same
   sensitivity — likely from the spread of per-cohort onset estimates
   (the IQR/SD of the input to the D2 weighted-quantile estimator).

3. **Derive onset_sd from onset estimator inputs, not from the point
   estimate alone.** The current formula uses only the onset value. It
   should use the per-cohort onset data — their spread IS the
   uncertainty. This data is available in the stats pass.

4. **Handle default-sigma properly.** Derive sigma_sd from the range of
   plausible sigma values given the quality gate thresholds, not from a
   guessed percentage.

5. **Visual validation.** Bands should be wider than Bayesian (less
   info) but not orders of magnitude wider. Should narrow with more
   data. Should be consistent across edge types.

### Files to change

- `statisticalEnhancementService.ts` — FE onset_sd and sigma_sd formulas
- `stats_engine.py` — BE mirror
- `heuristic-dispersion-design.md` — §3.3, §3.4 with calibrated derivations
- `test_stats_engine_parity.py` — update expected ranges after calibration

### Risk if not completed

Bands will be either too wide (noise covering the chart — current state)
or too narrow (hiding real uncertainty). Either undermines user trust.
**This feature must not ship until calibrated.**

### Upstream blocker: Bayesian latency SDs overstate predictive certainty (9-Apr-26)

The Bayesian compiler's latency posterior SDs (`mu_sd`, `sigma_sd`,
`onset_sd`) are raw MCMC posterior SDs — they measure parameter
estimation precision, not predictive spread. With many trajectories
they shrink to ±0.005 (mu) or ±0.010 (onset), implying sub-day
prediction precision. In reality, individual conversion times vary
with spread `sigma` (the LogNormal scale parameter). The predictive
spread should incorporate sigma, analogous to how predictive p
incorporates kappa via `Beta(p*κ, (1-p)*κ)`. This affects both
uncontexted and per-slice posteriors. Until fixed, the Bayesian
"ground truth" SDs used to calibrate heuristic dispersions (§ above)
are themselves wrong — any heuristic calibrated against them will
inherit the same overstatement of certainty.

### Defect: per-slice param file latency values are not slice-aware (15-Apr-26)

Param file `values[]` entries for contexted edges have per-slice
`sliceDSL` but repeat the base edge's `onset_delta_days` for every
slice (e.g. 0.5 for google, direct, and email when truth onset is
0.3, 0.5, 0.7 respectively). `mu` and `sigma` are absent from
per-slice latency blocks entirely. This means the model receives
identical latency priors for all slices, pulling onset toward the
edge mean regardless of the true per-slice value. Fix: the synth
generator (and production topo pass) should write per-slice onset,
mu, and sigma to each param file values entry. See doc 41 §4.
