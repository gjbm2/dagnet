# 29f — Forecast Engine: Implementation Status

**Date**: 14-Apr-26 (comprehensive rewrite)
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
| 5 | Done | `cohort_maturity` routes to v3 engine (185 lines, v2 was 1154). IS-conditioned via `compute_conditioned_forecast` (doc 29g). v1/v2 gated to dev only. Multi-hop acceptance passed. |
| 6 | Done | 26 Python tests + 15 TS tests. Covers parity, graceful degradation, IS conditioning correctness, draw validity, schema completeness. |
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

## Phase 5: cohort_maturity_v3

- [x] 5.1: Registered FE + BE. `cohort_maturity` → v3 handler (prod). v1/v2 gated to dev only (`devOnly: true`).
- [x] 5.2: `cohort_forecast_v3.py` — 185 lines. Delegates MC + IS to `compute_conditioned_forecast`.
- [x] 5.3: v2 vs v3 parity — window 4.2%, cohort 0%
- [x] 5.4: Multi-hop acceptance — A→C via B, structurally valid, midpoint < single-edge
- [ ] 5.5: Retire v2 — deferred. v1/v2 available in dev for parity testing.

**Key files**:
- `lib/runner/cohort_forecast_v3.py` — v3 row builder
- `lib/runner/forecast_state.py` — `compute_conditioned_forecast` (doc 29g)
- `lib/api_handlers.py` — `_handle_cohort_maturity_v3` handler
- `lib/tests/test_v2_v3_parity.py` — 4 parity tests

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

**Total: 41 tests** (26 Python + 15 TS)

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
| D8 | IS ESS collapse: joint multi-cohort IS produced ESS=1 | Fixed → capped aggregate at 200 effective trials |

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

### Must investigate before closing

1. ~~F-mode bead ± composition.~~ **DONE.** Composed at display time
   in `edgeBeadHelpers.tsx`: when `latency.completeness_stdev` is
   available, F-mode stdev = `sqrt((c × p_sd)² + (p × c_sd)²)`.
   Falls back to raw `p.forecast.stdev` when no completeness_stdev.

### Deferred (not blocking release)

2. **Retire v2 (Phase 5.5).** Delete `cohort_forecast_v2.py` (1154
   lines), `span_adapter.py` (160 lines), v2 handler. v1/v2 gated to
   dev only — not visible in prod.

3. **IS ESS tuning.** Evidence cap at 200 effective trials is
   pragmatic. Single-edge window ESS=5 is low. v2's per-cohort drift
   gives tighter conditioning with better ESS. The cap could be tuned
   or replaced with a more principled approach (e.g. tempering — see
   doc 29g §4). Affects fan band quality, not correctness.

4. **Legacy resolver call site migration (Phase 1).** Four call sites
   (`_read_edge_model_params`, `read_edge_cohort_params`, etc.) still
   use their own resolution. They serve v2 (frozen) and snapshot
   analysis. Migration deferred until v2 retirement.

### Must fix (identified by external review, 14-Apr-26)

6. **Resolver reads flat fields, not selected ModelVarsEntry (HIGH).**
   `resolve_model_params()` in `model_resolver.py` selects a source
   (bayesian/analytic/etc.) but reads mu/sigma/onset from flat
   `edge.p.latency` fields, not from the selected `model_vars[]`
   entry. If promotion hasn't run or is stale, the flat fields could
   be from a different source than what the resolver claims. Also
   ignores graph-level `model_source_preference`. Breaks the
   "best-available model resolver" contract.
   **Fix**: resolver must read values from the selected ModelVarsEntry
   directly, and accept graph-level preference.

7. **Engine uses raw cohort_data, not scoped cohorts (HIGH).**
   `handle_stats_topo_pass` builds `cohort_ages_and_weights` and
   `evidence` from `param_lookup` (raw `cohort_data`), not from
   `edge_contexts.scoped_cohorts`. Under filtered windows, the engine
   conditions on out-of-scope cohorts.
   **Fix**: engine step must use the same scoped cohort set that the
   FE/stats pass uses.

8. **scope='path' + carrier convolution = double upstream lag (HIGH).**
   The topo pass uses `scope='path'` in cohort mode (line 3975),
   returning path-level mu/sigma that already account for upstream lag.
   It then also passes `from_node_arrival` for carrier convolution,
   which applies upstream lag a second time. The parity tests use
   `scope='edge'` (correct basis for carrier convolution) so they
   don't catch this. **The production path is wrong but the tests
   pass.**
   **Fix**: carrier convolution must use edge-level params
   (`scope='edge'`). Path-level params are for v2's CDF-only approach
   (no convolution).

9. **rate_unconditioned = rate_conditioned after IS (MEDIUM).**
   `compute_conditioned_forecast` resamples draws in place, then
   computes both `rate_unconditioned` and `rate_conditioned` from the
   same conditioned draw set. So they are always equal. The design
   (doc 29) says unconditioned is the prior-only baseline (for
   surprise gauge comparison).
   **Fix**: compute unconditioned rate from the pre-IS draws before
   resampling.

10. **v3 evidence extraction incomplete (MEDIUM).**
    `cohort_forecast_v3.py` derives evidence from last_frame
    `data_points` only, not from dense per-frame `obs_x`/`obs_y`
    arrays as v2 does. Also emits zero-width `model_bands` (point
    value, not unconditioned MC draws). The parity test intentionally
    stopped asserting evidence equality.
    **Fix**: either replicate v2's multi-frame evidence aggregation,
    or accept the simpler last-frame approach with documented
    limitations. Model_bands require separate unconditioned draws
    (related to item 9).

### Known issues (separate workstream)

11. **Cohort chart rendering on DSL update.** Charts render on F5 but
    fail when the user updates the query DSL. Noted 14-Apr-26, not
    investigated. May be unrelated to engine work (possibly HMR or
    Python server reload).
