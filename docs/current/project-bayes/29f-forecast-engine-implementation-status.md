# 29f — Forecast Engine: Implementation Status

**Date**: 16-Apr-26
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
| 5 | **In progress** | v3 row builder uses v2's population model via `compute_forecast_sweep`. Parity test (`v2-v3-parity-test.sh`) green on synth-mirror-4step (17/17). Two critical fixes landed 16-Apr-26: span widening for single-hop cohort, upstream evidence fetch for empirical carrier. |
| 6 | Done | CLI-based parity test (`v2-v3-parity-test.sh`) with data health checks, non-vacuousness gates, and 20% fan tolerance. 44 Python tests + 15 TS tests. |
| 7 | Not started | Future enhancements (posterior covariance, asat projection). |

---

## Phase 5: cohort_maturity_v3 — In Progress

### What works (16-Apr-26)

v3 parity test (`graph-ops/scripts/v2-v3-parity-test.sh`) passes 17/17 on synth-mirror-4step:
- Single-hop cohort (wide + narrow date ranges)
- Multi-hop cohort (wide + narrow date ranges)
- Window mode baseline

The test uses CLI `analyse.sh` tooling — same pipeline as the browser (FE aggregation → subject resolution → hash lookup → snapshot query → BE handler → FE normalisation). No reimplemented hash lookup or manual handler calls.

### Critical fixes landed (15-16 Apr-26)

**D9 FIXED: v2 collapsed shortcut removed.** v2's handler for single-edge cohort mode was falling back to v1's `compute_cohort_maturity_rows`, which lacks upstream x conditioning (no carrier), doesn't do a topo pass, and uses a simpler population model that v2 was designed to replace. Every single-edge cohort chart in production was running v1. The collapsed shortcut has been removed. v2 now uses its own factorised path for all cases.

**D15: Span widening for single-edge cohort with upstream lag.** When anchor ≠ from_node in single-edge cohort mode, `mc_span_cdfs(from_node, to_node)` produces an edge-level CDF that completes too fast for anchor-relative ages. Pop D contributes nothing (remaining CDF ≈ 0), midpoint stays flat. Fix: widen the span to `mc_span_cdfs(anchor, to_node)` — path-level CDF gives correct Pop D timing. Override `mc_p_s` with edge-level p so the rate converges to edge p, not path p. Applied to both v2 and v3 handlers. Natural degeneration: multi-hop span is already path-level; window mode uses edge-level (correct); single-hop with anchor = from has no widening.

**D16: det_norm_cdf must be edge-level for E_i.** The deterministic CDF used for E_i computation (effective exposure for IS conditioning) must be edge-level even when the MC CDF is path-level. Path CDF at young frontier ages gives tiny E_i → IS conditioning doesn't fire → unconditioned (wide) fans. v2 uses edge kernel for `sp.C` (E_i) and widened span for `mc_cdf_arr` (population model). v3 now matches.

**D17: Upstream evidence fetch for v3.** v3's carrier fell back to Tier 3 (weak prior) on multi-hop because it didn't fetch upstream edge snapshot data. v2 fetches 2000+ upstream rows for empirical carrier (Tier 2). Fix: extracted `_fetch_upstream_observations()` as shared function, called from v3 handler. v3 carrier now reaches Tier 2 (empirical) matching v2.

### Design insight: one generalised loop

The population model loop is the same for all cases. What changes is the inputs:
- **CDF**: from `mc_span_cdfs(span_x, to_node)` — span_x = anchor for widened single-hop cohort, from_node otherwise
- **p draws**: from `mc_span_cdfs(from_node, to_node)` — always edge-level
- **Carrier**: from `build_upstream_carrier` with upstream observations — handles x growth
- **det_norm_cdf (for E_i)**: from edge kernel — always edge-level

Cases degenerate naturally:
- Multi-hop cohort: span is already path-level. Carrier provides x growth.
- Single-hop cohort, anchor ≠ from: widened span gives path CDF. Carrier provides x growth.
- Single-hop cohort, anchor = from: no widening needed (path = edge). Carrier reach = 0.
- Window mode: edge CDF. No carrier. x = N_i fixed.

### Parity test design

The parity test (`graph-ops/scripts/v2-v3-parity-test.sh`) was designed from first principles after extensive failure with reimplemented Python tests.

**Phase 1 — Data health checks** (prevent vacuous tests):
- Graph JSON exists with expected edges
- Snapshot DB has rows per edge (cohort + window slice_keys)
- CLI analyse returns rows with `evidence_x > 0` (observed cohorts present)

**Phase 2 — Row-level parity**:
- midpoint: Δ < 0.03
- fan width (90% band) ratio: within [0.80, 1.20]
- forecast_x ratio: within [0.80, 1.20]
- forecast_y ratio: within [0.80, 1.20]

**Test cases**: wide + narrow date ranges for both single-hop and multi-hop cohort. The narrow range (young cohorts) catches the IS conditioning failure mode visible in production.

**Critical principle**: tests use `analyse.sh` (CLI tooling) which runs the exact same FE pipeline as the browser. Earlier Python tests reimplemented hash lookup and subject resolution, producing tests that passed vacuously with 0 cohorts while production was visibly broken. See anti-patterns 39-40 in `KNOWN_ANTI_PATTERNS.md`.

### What was painful and why

This workstream took far longer than it should have. The root causes:

1. **Testing against the wrong target.** v2's single-hop cohort fell through to v1 via the "collapsed shortcut". Every parity comparison was measuring v3 against v1, not v2. The real v2 implementation for this case had never run in production. Hours were spent matching v1's output when the correct target was v2's factorised path.

2. **Reimplemented test infrastructure.** Python pytest tests built manual hash lookup (`_get_candidate_regimes`), manual candidate regime construction, manual handler calls — reimplementing the FE pipeline. The hashes didn't match, cohorts were 0, tests passed vacuously. The CLI tooling (`analyse.sh`) that exercises the real pipeline was already built and documented in `cli-analyse.md`. It was not used.

3. **Code before tests.** Repeatedly: change code → run broken test → test passes → deploy → user sees it's broken → investigate → find the test was vacuous. The correct sequence (write test that fails → understand why → fix code → test passes) was not followed until the user forced it.

4. **Devtools treated as afterthought.** The hydrate tool was built but not tested — it broke core_hash alignment with snapshot data, making all downstream tests vacuous. The synth graph appeared to work (graph JSON existed, had edges) but the snapshot linkage was invisible. A 30-second check (`evidence_x > 0`) would have caught this immediately.

5. **Not reading the playbooks.** `cli-analyse.md` has a section titled "Synthetic graph testing" with the exact commands needed, including `--topo-pass` and `--no-snapshot-cache`. It was not read.

---

## Key Files

| File | Purpose |
|------|---------|
| `lib/runner/cohort_forecast_v3.py` | v3 row builder — thin consumer of engine |
| `lib/runner/forecast_state.py` | `compute_forecast_sweep` (population model), `compute_conditioned_forecast` (IS) |
| `lib/api_handlers.py` | `_handle_cohort_maturity_v3` handler, `_fetch_upstream_observations` shared function |
| `graph-ops/scripts/v2-v3-parity-test.sh` | CLI-based parity test (17 checks) |
| `graph-ops/scripts/analyse.sh` | CLI analyse tool (same pipeline as browser) |
| `lib/tests/test_v2_v3_parity.py` | Legacy Python parity tests (to be replaced by CLI test) |

---

## Defects Found and Fixed

| ID | Description | Status |
|----|-------------|--------|
| D1 | BE scalar overwrite bypassed promotion | Fixed |
| D2 | Topo pass re-fits mu/sigma for Bayesian edges | Pre-existing |
| D3 | Wrong test file created | Fixed |
| D4 | Tier 1 DRIFT_FRACTION crippled IS | Fixed |
| D5 | Reach-scaling bug in carrier convolution | Fixed |
| D6 | Schema bloat: ForecastState TS interface | Fixed (removed) |
| D7 | Missing dispersions in ModelVarsEntry | Fixed |
| D8 | IS ESS collapse | Fixed (per-cohort sequential IS) |
| D9 | v2 collapsed shortcut: single-hop cohort fell through to v1 | **Fixed 16-Apr-26** — removed shortcut, v2 uses factorised path |
| D10 | v3 evidence aggregation differs from v2 | Fixed (v3 now uses same per-cohort obs_x/obs_y) |
| D11 | v3 epoch boundary mismatch | Fixed |
| D12 | v3 handler missing response contract fields | Fixed |
| D13 | v1 handler gate didn't match cohort_maturity_v1 | Fixed |
| D14 | Parity tests too loose / vacuous | **Fixed 16-Apr-26** — CLI-based test with non-vacuousness gates |
| D15 | Single-hop cohort CDF too fast (edge-level vs anchor-relative ages) | **Fixed 16-Apr-26** — span widening |
| D16 | det_norm_cdf path-level breaks IS conditioning on young cohorts | **Fixed 16-Apr-26** — edge kernel for E_i |
| D17 | v3 carrier falls to weak prior (missing upstream evidence fetch) | **Fixed 16-Apr-26** — shared `_fetch_upstream_observations` |

---

## Outstanding Work

### Remaining for Phase 5 completion

1. **Browser verification on production graph.** Parity test passes on synth. Need visual confirmation that v2 and v3 charts match in the FE render on the production graph with various cohort selections (young, old, mixed).

2. **Retire v2 (Phase 5.5).** After browser verification. Delete `cohort_forecast_v2.py`, `span_adapter.py`, v2 handler, v1 handler. v1 and v2 currently gated to dev only.

### Deferred

3. **IS ESS tuning.** Aggregate tempering is conservative (wider bands than full IS). Acceptable for now.

4. **Legacy resolver call site migration.** v2-only call sites. Retire with v2.

5. **v3 engine generalisation.** v3 currently delegates to `compute_forecast_sweep` which reimplements v2's loop. The long-term goal (doc 29) is a single engine that naturally degenerates across all cases. The span-widening approach shows the path: one loop, different CDF/carrier inputs.
