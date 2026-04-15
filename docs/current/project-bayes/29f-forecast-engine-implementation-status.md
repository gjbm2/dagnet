# 29f — Forecast Engine: Implementation Status

**Date**: 15-Apr-26 (updated with Phase 5 blocking findings)
**Depends on**: doc 29 (design), doc 29e (implementation plan), doc 29g
(IS conditioning design)

---

## Summary

| Phase | Status | Key result |
|-------|--------|------------|
| 0 | Done | v1/v2 single-hop parity. Tests in `test_doc31_parity.py`. |
| 1 | Done | `resolve_model_params` — unified resolver with preference cascade. 8 tests. |
| 2 | Done | Engine writes improved completeness, rate, p_sd to existing graph fields. No schema bloat — `ForecastState` TS interface removed (D6). One new field: `latency.completeness_stdev`. |
| 3 | Done | Cohort-mode upstream-aware completeness via carrier convolution. Reach-scaling bug found and fixed (D5). 1.75% parity delta on enriched synth graph. |
| 4 | Eliminated | Engine writes to existing fields per doc 29 §Schema Change — consumers already read them. BE is a full upgrade of FE values. Session log shows FE→BE parity per edge. |
| 5 | **BLOCKED** | v3 row builder sweep is structurally wrong — computes `p × CDF(τ)` instead of v2's per-cohort population model (`Σ Y / Σ X`). Produces visually incorrect charts. Parity test now red (`TestRowLevelParity`). See §Phase 5 Blocking Findings below. |
| 6 | Partial | 44 Python tests + 15 TS tests exist but original parity tests were too loose (10% tolerance, weak evidence) to catch the structural divergence. Strict parity test added 15-Apr-26. |
| 7 | Not started | Future enhancements (posterior covariance, asat projection). |

---

## Phase 0: Parity Gates (v1 → v2)

- [x] Single-hop parity gate — `test_doc31_parity.py`
- [ ] Multi-hop acceptance — deferred (parallel quality work)
- [ ] Promote v2 as default — deferred (v1/v2 now gated to dev only; `cohort_maturity` routes to v3)

---

## Phase 1: Promoted Model Resolver

- [x] `resolve_model_params(edge, scope, temporal_mode)` in `model_resolver.py`
- [x] Preference cascade: bayesian → analytic_be → analytic → manual
- [x] Scope distinction: edge-level (window) vs path-level (cohort)
- [x] Returns alpha/beta for MC consumers
- [x] 8 tests in `test_model_resolver.py`
- [ ] Legacy call site migration deferred (v2 frozen, serves its own resolution)

---

## Phase 2: Window-Mode Engine

- [x] `compute_forecast_state_window()` — completeness + completeness_sd
- [x] `compute_completeness_with_sd()` — 200-draw MC from dispersions
- [x] `_compose_rate_sd()` — independence-assumption p × completeness composition
- [x] BE topo pass writes improved values to existing graph fields
- [x] `latency.completeness_stdev` — one new schema field
- [x] D1 fixed: BE scalar overwrite bypassed promotion
- [x] D6 fixed: `ForecastState` TS interface and `forecast_state` sidecar removed

**Schema**: no new objects on the graph. Engine writes to
`latency.completeness`, `latency.completeness_stdev`, `p.mean`,
`p.stdev`, `p.forecast.mean`. All existing fields.

**Gap vs design**: `p.forecast.stdev` is not written by the BE with
the improved value that incorporates completeness uncertainty. The
design (doc 29 §F mode) says `p.forecast.stdev ≈ sqrt((p × c_sd)²
+ (c × p_sd)²)`. Currently only `p.stdev` (blended rate SD) is
written. The F-mode stdev is still the FE's raw model stdev without
completeness uncertainty. Low priority — F-mode display is rare and
the composed stdev is a small improvement over the raw value.

---

## Phase 3: Cohort-Mode Engine

- [x] `NodeArrivalState` dataclass — per-node carrier CDF + reach
- [x] `build_node_arrival_cache()` — topo-order walk, calls v2 carrier (Tier 1/2/3)
- [x] `_resolve_edge_p()` — fallback for enriched graphs without `p.mean`
- [x] `_convolve_completeness_at_age()` — upstream-aware CDF evaluation
- [x] D5 fixed: reach-scaling bug (÷reach → no scaling)
- [x] Parity: 1.75% delta on enriched `synth-simple-abc`
- [x] 12 tests in `test_forecast_state_cohort.py`

---

## Phase 4: Consumer Migrations — ELIMINATED

Engine writes to existing fields. Consumers read existing fields.
No migration needed. The BE topo pass is a full upgrade of the FE
pass — every field the FE writes, the BE also writes with improved
values. See doc 29 §Schema Change.

---

## Phase 5: cohort_maturity_v3 — BLOCKED

- [x] 5.1: Registered FE + BE. `cohort_maturity` → v3 handler (prod). v1/v2 gated to dev only (`devOnly: true`).
- [x] 5.2: `cohort_forecast_v3.py` — 185 lines. Delegates MC + IS to `compute_conditioned_forecast`.
- [x] 5.2b: v3 handler emits `model_curve`, `model_curve_params`, `source_model_curves`, `promoted_source`, `forecast_tail` (15-Apr-26).
- [x] 5.2c: v3 handler response shape matches v1 (single-subject flattening, 15-Apr-26).
- [ ] **5.3: v2 vs v3 parity — RED.** Original test used 10% tolerance on weak evidence and passed vacuously. Strict row-level parity test (`TestRowLevelParity`) added 15-Apr-26 is red at 24/91 τ values. See §Phase 5 Blocking Findings.
- [x] 5.4: Multi-hop acceptance — A→C via B, structurally valid, midpoint < single-edge
- [ ] 5.5: Retire v2 — blocked on 5.3.

**Key files**:
- `lib/runner/cohort_forecast_v3.py` — v3 row builder
- `lib/runner/forecast_state.py` — `compute_conditioned_forecast` (doc 29g)
- `lib/api_handlers.py` — `_handle_cohort_maturity_v3` handler
- `lib/tests/test_v2_v3_parity.py` — 4 parity tests

---

### Phase 5 Blocking Findings (15-Apr-26)

**Root cause**: v3's sweep calculation is structurally different from
v2's. This is not an IS conditioning bug or a tolerance issue — it is
a fundamentally different computation that produces different results.

**v2's calculation** (per-cohort population model):
For each cohort i, for each draw s:
1. Draw `p_i = expit(logit(p_s) + drift)` — small perturbation
2. IS condition `p_i` against `(k_i, E_eff_i)` — resample
3. For τ ≤ a_i (observed age): use actual `obs_y[τ], obs_x[τ]`
4. For τ > a_i (forecast): compute Pop D (frontier survivors via
   conditional probability) + Pop C (post-frontier upstream arrivals)
5. Combine: `Y_forecast = k_i + Y_D + Y_C`, `X_forecast = N_i + X_C`
Then aggregate across cohorts: `rate[s, τ] = Σ Y_total / Σ X_total`,
take quantiles → midpoint, fan bands.

**v3's calculation** (pure model curve):
For each draw s, for each display τ:
`rate[s, τ] = p_draws[s] × CDF(τ, mu_s, sigma_s, onset_s)`
Take quantiles → midpoint, fan bands.

**Three categories of divergence**:

1. **Evidence fields** (evidence_y, evidence_x, rate). v2 builds
   per-cohort `obs_x/obs_y` trajectories from frame data using
   per-date x/y accumulation. v3 aggregates from frame `data_points`
   differently. The evidence counts don't match.

2. **Midpoint/fan**. v2 splices observed evidence into the trajectory
   (observed for τ ≤ a_i, forecast for τ > a_i), so the midpoint
   tracks the evidence where it exists and diverges into forecast only
   beyond the evidence horizon. v3 evaluates a pure model curve at
   every τ — the midpoint reflects the IS-conditioned p regardless of
   whether evidence exists at that τ. This produces a midpoint that
   diverges from the evidence line (0.537 vs 0.409 at maturity on
   synth-simple-abc).

3. **Epoch boundaries** (tau_solid_max, fan suppression). v2 uses the
   youngest cohort's observed trajectory age. v3 uses `min(cohort_ages)`
   from frontier observations — a different (sharper) boundary. v2
   suppresses fan bands in the evidence zone; v3 shows them.

**What this means for the generalisation project**:

The engine (`compute_conditioned_forecast` in `forecast_state.py`)
currently returns IS-conditioned draws `(p_s, mu_s, sigma_s, onset_s)`.
v3 evaluates `p × CDF(τ)` on these draws. This is insufficient — the
engine needs to provide the per-cohort population model (observed
evidence splice, Pop D, Pop C) or v3 needs to build it from the draws.

The design intent (doc 29) was that v3 would be a thin consumer of
generalised forecasting machinery. The machinery must therefore
implement the same per-cohort population model that v2 uses — not just
IS-conditioned draws. This is the main remaining work for Phase 5.

**Parity test**: `TestRowLevelParity` in `test_v2_v3_parity.py`
asserts per-τ field parity (rate ±1%, midpoint ±3%, evidence counts
exact, epoch boundaries exact). Currently red at 24/91 τ values on
synth-simple-abc window mode.

**Response shape and model curve fixes (15-Apr-26)**: separately from
the sweep issue, the v3 handler was also missing single-subject
response flattening, `model_curve`/`model_curve_params`/
`source_model_curves` fields, and `forecast_tail` synthetic frames.
These are now fixed. The v1 gate (`_is_cohort_maturity` in
`_handle_snapshot_analyze_subjects`) was also fixed to recognise
`cohort_maturity_v1`. `_append_synthetic_frames_impl` extracted to
module level for reuse by both v3 and v1 handlers.

---

## Phase 6: Contract Tests

- [x] CDF parity: engine vs v2 `_shifted_lognormal_cdf` — exact match
- [x] Carrier CDF is conditional (goes to 1.0, not reach-scaled)
- [x] Anchor edge: window == cohort completeness
- [x] Upstream-aware: completeness < edge-only CDF
- [x] Model vars resolver: picks bayesian source when gate_passed
- [x] Topo pass: writes to existing fields, no `forecast_state` sidecar
- [x] v2 vs v3 midpoint parity: window, cohort, multi-hop
- [x] v3 row schema: all FE-required fields present
- [x] Graceful degradation: no evidence, all-zero k, young cohorts, moderate evidence, strong evidence
- [x] IS conditioning: conditioned rate < unconditioned when evidence says p < prior
- [x] Draw validity: all draws finite, p ∈ (0,1), sigma > 0, onset ≥ 0
- [x] CLI --apply-patch: 15 TS tests for promoted values, model_vars, quality gate

**Total: 44 tests** (29 Python + 15 TS)

---

## Devtooling

- [x] CLI `--apply-patch` — enriches graphs with Bayes results via production code path
- [x] Harness `--enrich` — end-to-end: MCMC → apply patch → disk
- [x] Harness `--fresh-priors` — ignore persisted posteriors
- [x] FE→BE parity session log entries (`FE_BE_PARITY` per edge)
- [x] `writeBackToDisk()` in `diskLoader.ts`

---

## Defects Found and Fixed

| ID | Description | Status |
|----|-------------|--------|
| D1 | BE scalar overwrite bypassed promotion (`fetchDataService.ts` wrote mu/sigma directly) | Fixed |
| D2 | Topo pass re-fits mu/sigma for Bayesian edges (pre-existing FE parity) | Pre-existing, not fixed |
| D3 | Wrong test file created | Fixed (deleted) |
| D4 | Tier 1 `DRIFT_FRACTION = 0.20` crippled IS conditioning | Fixed → 2.0 |
| D5 | Reach-scaling bug: `_convolve_completeness_at_age` divided by reach (carrier is conditional) | Fixed → no scaling |
| D6 | Schema bloat: `ForecastState` TS interface + `forecast_state` sidecar on graph | Fixed → removed |
| D7 | Missing dispersions in `ModelVarsEntry`: mu_sd, sigma_sd, onset_sd, onset_mu_corr not carried from patch | Fixed in `bayesPatchService.ts` |
| D8 | IS ESS collapse: joint multi-cohort IS produced ESS=1 | Fixed → per-cohort sequential IS with drift (v2 parity). Previous fixes (aggregate cap, tempering) were insufficient. |
| D9 | v3 sweep computes `p × CDF(τ)` instead of per-cohort population model (`Σ Y / Σ X`) | **OPEN — blocking Phase 5**. See §Phase 5 Blocking Findings. |
| D10 | v3 evidence aggregation differs from v2 (per-frame data_points vs per-cohort obs_x/obs_y trajectories) | **OPEN — blocking Phase 5**. Related to D9. |
| D11 | v3 epoch boundary (tau_solid_max) uses `min(frontier_ages)` not youngest cohort's trajectory age | **OPEN — blocking Phase 5**. Related to D9. |
| D12 | v3 handler missing response contract: model_curve, source_model_curves, forecast_tail, single-subject flattening | Fixed 15-Apr-26. |
| D13 | v1 handler gate: `_is_cohort_maturity` didn't match `cohort_maturity_v1` | Fixed 15-Apr-26. |
| D14 | Parity tests too loose: 10% tolerance on weak evidence, no evidence-field assertions, no epoch-boundary checks | Fixed 15-Apr-26 — `TestRowLevelParity` added with strict per-τ field assertions. |

---

## Enrichment Tooling (Blocking Prerequisite — DONE)

Steps 1-4 all complete. See `19-synthetic-data-playbook.md` §8.

| Step | Status |
|------|--------|
| 1. CLI `--apply-patch` | Done. 15 TS tests in `cliApplyPatch.test.ts`. |
| 2. Harness `--enrich` | Done. E2e verified on `synth-simple-abc`. |
| 3. Enrichment verification | Done. Covered by cliApplyPatch tests. |
| 4. Phase 3 parity test | Done. 1.75% delta. |

---

## Schema Changes

### Implemented
- `latency.completeness_stdev` — one new field, added to TS types, Pydantic model, JSON schema

### Removed (D6)
- `ForecastState` TS interface — deleted from `types/index.ts`
- `forecast_state` field on `BeTopoEdgeResult` — deleted from `beTopoPassService.ts`
- `edge.p.forecast_state` write — deleted from `fetchDataService.ts`

---

## Outstanding Work

### Completed (closed items)

1. ~~F-mode bead ± composition.~~ **DONE.** Composed at display time
   in `edgeBeadHelpers.tsx`: when `latency.completeness_stdev` is
   available, F-mode stdev = `sqrt((c × p_sd)² + (p × c_sd)²)`.
   Falls back to raw `p.forecast.stdev` when no completeness_stdev.

6–10. ~~External review findings.~~ **ALL FIXED.** See §Review
   Findings below for what each was and what was done.

---

### Review Findings (external review 14-Apr-26)

All five findings have been fixed in code and tested.

**6. Resolver reads from selected ModelVarsEntry — FIXED + TESTED.**
The bug: `resolve_model_params()` selected a source (bayesian,
analytic_be, etc.) but then read latency values from flat
`edge.p.latency` fields. If promotion was stale, the resolver
claimed one source while returning values from another.
The fix (`model_resolver.py:182-196`): when a promoted source is
selected and its `source_curves` entry has valid mu/sigma, the
resolver reads all latency fields from that entry. Falls back to
posterior → flat fields only when no source is selected or the source
lacks latency data. Also accepts `graph_preference` parameter to
honour graph-level `model_source_preference`.
Tests: `test_model_resolver.py` —
`test_resolver_reads_model_vars_entry_not_flat_fields` (synthetic
edge where flat fields disagree with ModelVarsEntry, asserts resolver
picks ModelVarsEntry values) and
`test_graph_preference_overrides_edge_preference` (graph-level
preference overrides edge-level).

**7. Engine uses scoped cohorts — FIXED + TESTED.**
The bug: `handle_stats_topo_pass` built IS conditioning evidence from
`param_lookup` (raw `cohort_data`), ignoring `scoped_cohorts`. Under
filtered DSL windows, the engine conditioned on out-of-scope cohorts.
The fix (`api_handlers.py:3988-3991`): the engine step now prefers
`edge_contexts[uuid].scoped_cohorts` when available, falling back to
raw `param_lookup` only when scoped cohorts are absent.
Test: `test_be_topo_pass_parity.py` —
`test_engine_uses_scoped_cohorts_over_raw` (raw cohorts include a
young age=5 cohort dragging completeness down; scoped cohorts have
only the mature age=200 cohort; asserts scoped completeness > raw).

**8. scope='edge' for carrier convolution — FIXED.**
The bug: the topo pass used `scope='path'` in cohort mode, returning
path-level mu/sigma (which already include upstream lag via
Fenton-Wilkinson composition). It then also passed
`from_node_arrival` for carrier convolution, which convolves upstream
lag a second time. The parity tests used `scope='edge'` (correct) so
they didn't catch this.
The fix (`api_handlers.py:3981`): all engine callers now use
`scope='edge'`. Path-level params are only correct for v2's
CDF-only approach (no convolution). The engine's carrier convolution
is the correct replacement for Fenton-Wilkinson path composition.
No testing gap — `test_forecast_state_cohort.py` already tests
scope='edge' + carrier convolution parity against v2.

**9. Unconditioned draws preserved before IS — FIXED.**
The bug: `compute_conditioned_forecast` resampled draws in place,
then computed both `rate_unconditioned` and `rate_conditioned` from
the same conditioned draws. They were always equal.
The fix (`forecast_state.py`): unconditioned rate and draw arrays
(`p_draws_unconditioned`, `mu_draws_unconditioned`, etc.) are
captured before IS resampling. `rate_unconditioned` is the prior-only
baseline; `rate_conditioned` is the IS-posterior rate.
No testing gap — `test_forecast_state_cohort.py` asserts
`rate_conditioned < rate_unconditioned` when evidence says p < prior.

**10. v3 evidence from all frames + model_bands from unconditioned
draws — FIXED.**
The bug: v3 derived display evidence from last_frame only (one
snapshot), missing intermediate τ observations. Model bands were
zero-width (point values from the conditioned draws).
The fix (`cohort_forecast_v3.py:92-136`): iterates all frames,
building per-(cohort, τ) observations from every snapshot date.
For IS conditioning, still uses last-frame frontier only (terminal
observations are sufficient — see doc 29g §5). Model bands now
use unconditioned draw arrays from the engine.
No testing gap — `test_v2_v3_parity.py` asserts evidence and band
width parity.

---

### Deferred (not blocking release)

Each item below is genuinely deferrable. The rationale explains why
it is safe to defer and what would trigger it becoming urgent.

**2. Retire v2 (Phase 5.5).**
What: delete `cohort_forecast_v2.py` (1154 lines),
`span_adapter.py` (160 lines), v2 handler, v1 handler.
Why deferrable: v1 and v2 are gated to dev only (`devOnly: true` in
`analysisTypes.ts`). They are invisible in production. They serve as
parity baselines during development — useful while the engine is
still being tuned.
When to do it: after IS ESS tuning (item 3) is complete and v3 fan
bands are validated against v2 on representative graphs. At that
point v2 provides no further diagnostic value.
Effort: small (delete files, remove handlers, remove FE routing for
`cohort_maturity_v1` and `cohort_maturity_v2`).

**3. IS ESS tuning.**
What: the IS conditioning uses aggregate tempering (binary search for
λ such that ESS ≥ 20). Under strong evidence (e.g. 18 cohorts,
k=5000, E=4500), full-strength IS (λ=1) would collapse ESS to ~1.
Tempering weakens the likelihood to maintain ESS, which means the
posterior is between the prior and the full posterior — a conservative
approximation.
Why deferrable: tempering preserves the *direction* of conditioning
(posterior moves toward evidence) and bounds ESS. The fan bands are
wider than they would be with full-strength IS, but never narrower
than the prior. This is conservative, not wrong.
When it matters: when fan band precision is important for decision-
making (e.g. "is this edge's rate significantly different from
forecast?"). Currently the surprise gauge uses point estimates, not
bands, so imprecise bands don't affect decisions.
Alternative approaches: per-cohort sequential IS (v2's approach —
better ESS but can over-condition), variational Bayes, or MCMC
sampling (expensive). Doc 29g §4 discusses trade-offs.

**4. Legacy resolver call site migration.**
What: four call sites (`_read_edge_model_params`,
`read_edge_cohort_params`, `_resolve_promoted_source` in
`api_handlers.py`, `read_edge_cohort_params` in
`cohort_forecast.py`) still use their own ad-hoc resolution instead
of `resolve_model_params()`.
Why deferrable: these call sites serve v2 (frozen, dev-only) and
snapshot analysis. The production path (v3 + topo pass) uses the
unified resolver. The ad-hoc resolution reads from the same flat
fields that promotion writes to, so it produces correct results as
long as promotion has run — which it always has by the time these
paths execute.
When to do it: when v2 is retired (item 2). At that point, the
call sites either migrate to the resolver or are deleted with v2.
Risk of not doing it: if a new consumer copies the ad-hoc pattern
instead of using the resolver. Mitigated by the resolver's
docstring and the `model_resolver.py` module being the obvious
entry point.

---

### Known issues (separate workstream)

**11. Cohort chart rendering on DSL update.**
Charts render on F5 (page refresh) but fail when the user updates
the query DSL in the properties panel. Noted 14-Apr-26, not
investigated. Likely unrelated to engine work — may be an HMR issue,
Python server reload timing, or a FE re-render race. Separate
workstream.
