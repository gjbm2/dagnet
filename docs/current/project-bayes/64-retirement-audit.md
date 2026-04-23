---
title: Retirement audit — v1/v2 parity-era tests
status: Pass-3 prospective audit
owner: assurance overhaul (see 64-forecast-assurance-overhaul.md)
date: 22-Apr-26
---

# Retirement audit — v1/v2 parity-era tests

This document is the prospective coverage audit required by
[64-forecast-assurance-overhaul.md §10.1 item 7](64-forecast-assurance-overhaul.md).
Nothing is deleted here. Each file targeted for retirement is read end
to end, every assertion is listed, and for each assertion a replacement
is either named (green test on the live codebase) or flagged as a gap.
Gaps are then closed by new tests written in the Family A–G suites
*before* any deletion is permitted.

"Reframes are not replacements." A structural replacement does not
cover a numerical claim. A contract test does not cover a shape
invariant. Each claim must survive in something that actually tests it.

---

## Files audited

1. `graph-editor/lib/tests/test_v2_v3_parity.py` — 1559 lines
2. `graph-ops/scripts/v2-v3-parity-test.sh` — 536 lines
3. `graph-editor/lib/tests/test_cohort_forecast.py` — 711 lines
4. `graph-editor/lib/tests/test_cohort_fan_controlled.py` — 366 lines
5. `graph-editor/lib/tests/test_cohort_fan_harness.py` — 274 lines

Total: 3446 lines of assertion code.

---

## Scope limits discovered during audit

Before the audit can recommend deletion it must name the live-code
dependency. These are not all "v1/v2-only" tests:

- `compute_cohort_maturity_rows` (v1) is STILL called from
  `api_handlers.py` at multiple call sites (lines 4476, 4516, 4551,
  4583, 4606) for non-cohort-maturity analyses and fallback paths.
  Until those call sites are removed, `test_cohort_forecast.py`
  covers live production code, not dead scaffolding.
- `_shifted_lognormal_cdf` and `compute_confidence_band` (the utilities
  in `runner.confidence_bands`) are called from `forecast_runtime.py`
  (line 1258) — a layer shared by v1 and v3. They are not v1-only
  utilities. Tests on these should survive v1 deletion.
- `cohort_forecast_v2.py` still exists as a parallel implementation.
  Until it is deleted from the repo, v2-comparison tests are covering
  live code.
- The `TestUpstreamLagParity` class in `test_v2_v3_parity.py` is
  decorated with `@pytest.mark.skip` and the inline
  `_TestUpstreamLagParityInline` class begins with `_`, so pytest does
  not collect it. Both are inert and can be removed without coverage
  impact.

Conclusion: these five files cannot all be deleted in a single
deletion step. The audit below separates **v1/v2-oracle assertions**
from **assertions that happen to live in these files but actually
test live shared utilities or pure v3 behaviour**.

---

## Assertion catalogue

### Topic 1 — v1/v2 field-by-field parity claims (pure retirement candidates)

These assertions fire on the identity "v2 output ≡ v3 output within
tolerance". They are retired by deletion because v2 itself is retired.
Nothing in the new regime is expected to replace them — the whole
point of the new regime is that we no longer use v2 as an oracle.

| Source | Assertion | Replacement |
|---|---|---|
| `test_v2_v3_parity.py::TestV2V3Parity::test_window_mode_parity` | v2/v3 midpoint delta <10% on window A→B | RETIRE (v2 oracle) |
| `test_v2_v3_parity.py::TestV2V3Parity::test_cohort_mode_parity` | v2/v3 midpoint delta <10% on cohort B→C | RETIRE (v2 oracle) |
| `test_v2_v3_parity.py::TestV2V3Parity::test_window_mode_strict_midpoint_parity` | v2/v3 midpoint delta <5% | RETIRE (v2 oracle) |
| `test_v2_v3_parity.py::TestRowLevelParity::*` — all 4 tests | v2/v3 field-by-field within tight tolerance (rate 1%, midpoint 3–5%, fan band 35% width) | RETIRE (v2 oracle) |
| `test_v2_v3_parity.py::TestProdGraphCohortParity::test_single_edge_cohort_midpoint` | v2/v3 midpoint within 5% on prod graph | RETIRE (v2 oracle) |
| `v2-v3-parity-test.sh` Phase 2 (v2/v3 midpoint delta <6% across cases) | Same, via CLI | RETIRE (v2 oracle) |

---

### Topic 2 — Assertions that are NOT about v2/v3 identity but happen to live in these files

These prove v3 behaviour in its own right and must survive deletion.
Each has an identified replacement or is itself the replacement.

| Source | Assertion | Replacement / Keep-path |
|---|---|---|
| `test_v2_v3_parity.py::test_prod_graph_v3_window_vs_cohort_do_not_collapse_for_downstream_edge` | v3 window vs cohort must NOT collapse for downstream edge (max Δ > 0.10) | **KEEP**, move to `test_doc56_phase0_behaviours.py` (Family D metamorphic divergence). Already mirrored by `test_multi_hop_latent_upstream_diverges_window_vs_cohort`. |
| `test_v2_v3_parity.py::test_v3_handler_widens_single_edge_downstream_cohort_span` | v3 handler passes anchor→to-node span (not edge-only) to kernel; sets `p_conditioning_source='direct_cohort_exact_subject'` | **KEEP**, move to `test_conditioned_forecast_response_contract.py` (Family B). Pure v3 unit test — no v2 reference. |
| `test_v2_v3_parity.py::TestStrongEvidenceParity::test_strong_evidence_midpoint_near_observed_rate` | v3 midpoint at maturity within 10% of observed rate (evidence pulls midpoint off prior) | **GAP** — no current replacement. Needs new test in Family B (runtime contract). |
| `test_v2_v3_parity.py::TestV2V3Parity::test_multi_hop_acceptance` (the non-parity clauses) | v3 multi-hop rows exist, midpoints in (0,1), multi-hop midpoint < single-edge × 1.05 | **GAP** — current Family D tests only assert directional divergence, not multiplicative bound. Needs new test in Family B. |
| `test_v2_v3_parity.py::TestV2V3Parity::test_v3_row_schema_complete` | v3 row has 20 named fields; fan_bands has 80/90/95/99 levels with lo≤hi | **GAP** — new Family F schema contract test needed. |
| `test_cohort_forecast.py::TestForecastRate` (9 tests) | forecast_rate(τ,p,μ,σ,onset) = p×CDF(τ) invariants: zero at τ=0, zero before onset, approaches p at large τ, monotonic, clamped to 1, etc. | **KEEP** — pure utility tests. `forecast_rate` is v1-internal; if v1 is deleted these go with it. Until then they cover live code. |
| `test_cohort_forecast.py::TestReadEdgeCohortParams` (8 tests) | `read_edge_cohort_params` extracts {p, μ, σ, onset} from cohort posterior, falls back to flat latency, rejects missing fields | **KEEP** tied to v1 — `read_edge_cohort_params` is v1-internal. Model resolution in v3 goes via `model_resolver.resolve_model_params`, tested in `test_model_resolver.py`. |
| `test_cohort_forecast.py::TestGetIncomingEdges` / `TestFindEdgeById` (6 tests) | Graph topology helpers on dict inputs | **KEEP** tied to v1 — `get_incoming_edges` / `find_edge_by_id` live in `runner.cohort_forecast`; v3 callers use `runner.forecast_runtime.find_edge_by_id`. Equivalent `find_edge_by_id` behaviour is needed elsewhere — covered incidentally by live integration tests. |
| `test_cohort_forecast.py::TestComputeCohortMaturityRows` (10 tests) — epoch rules, fan ordering, sorted rows, empty-frames degeneration | v1 behaviour invariants | **PARTIAL GAP** — see Topic 3 below. v3 has no direct equivalent shape-invariant suite. |
| `test_cohort_forecast.py::TestWindowZeroMaturityDegeneration` (4 tests) | At zero evidence, v1 fan ≈ analytic confidence band | **PARTIAL GAP** — see Topic 4. v3 zero-evidence degeneration lives only in the v2-v3 shell (Phase 3) and is tied to v2 machinery. |
| `test_cohort_fan_controlled.py::TestCDFRatioCalibration` (3 tests) | `_shifted_lognormal_cdf` ratio behaviour | **KEEP** — pure utility tests on live shared code (`runner.confidence_bands`). |
| `test_cohort_fan_controlled.py::TestMCBand` (3 tests) | `compute_confidence_band` bounded in [0,1], opens after onset, converges asymptotically | **KEEP** — pure utility tests on live shared code. |
| `test_cohort_fan_controlled.py::TestSingleCohortMidpoint` / `TestFanWidth` / `TestMultiCohortEpochB` (11 tests) | v1 midpoint monotonicity, fan width, epoch B evidence-aware midpoint, single-cohort sanity | Tests v1 compute directly; see Topic 3. |
| `test_cohort_fan_harness.py` (19 tests including 5 `TestFlexedDistribution` parametrised combos) | v1 fixture-driven invariants: midpoint null in epoch A, midpoint present in epoch C, midpoint ≥ evidence in window mode, fan contains midpoint, fan bounded in [0,1], zero-width at boundary, fan opens after boundary, evidence rate increases in epoch A | Tests v1 compute directly; see Topic 3. |

---

### Topic 3 — v3 row-level shape invariants (GAP to fill before deletion)

The biggest gap. v1 tests assert many behavioural invariants at the row
level; the v3 path has no direct behavioural tests for the same
invariants. Family D metamorphic tests prove relations *between* v3
outputs (window vs cohort); they do not prove the internal shape of a
single v3 output is well-formed.

Specific gaps:

- **Midpoint monotonicity**: midpoint non-decreasing across τ on a
  v3 output. Tolerance: ~0.005 to accommodate binomial quantisation.
  Covered for v1 in `test_cohort_fan_harness.py::TestMidpointInvariants::test_midpoint_monotonically_increasing` and `test_cohort_fan_controlled.py::TestSingleCohortMidpoint::test_midpoint_monotonically_increasing`. No v3 equivalent.
- **Epoch rule A**: midpoint null for τ < tau_solid_max. v1 coverage in `test_cohort_fan_harness.py::test_midpoint_null_in_epoch_a`. No v3 equivalent.
- **Epoch rule C**: evidence rate null for τ > tau_future_max. v1 coverage in `test_cohort_fan_harness.py::test_evidence_null_in_epoch_c`. No v3 equivalent.
- **Fan ordering**: fan_lower ≤ midpoint ≤ fan_upper. v1 coverage in `test_cohort_fan_harness.py::test_fan_contains_midpoint` + `test_cohort_fan_controlled.py::test_fan_contains_midpoint`. No v3 equivalent.
- **Fan bounded in [0,1]**. v1 coverage in `test_cohort_fan_harness.py::test_fan_bounded_01`. No v3 equivalent.
- **Fan zero-width at boundary** (at τ = tau_solid_max, fan_upper ≈ fan_lower). v1 coverage in `test_cohort_fan_harness.py::test_fan_zero_width_at_boundary`. No v3 equivalent.
- **Fan opens after boundary** (fan widens in epoch C). v1 coverage in `test_cohort_fan_harness.py::test_fan_opens_after_boundary`. No v3 equivalent.
- **Midpoint ≥ evidence in window mode** (window-mode invariant). v1 coverage in `test_cohort_fan_harness.py::test_midpoint_ge_evidence_in_window_mode`. No v3 equivalent.
- **Rows sorted by τ**. v1 coverage in `test_cohort_forecast.py::test_rows_sorted_by_tau`. No v3 equivalent.
- **Flexed distributions** (5 combos: early-fast, late-slow, narrow-high, wide-low, combo-shift) — proves invariants hold across evidence distribution shapes that differ from the model's belief. v1 coverage in `test_cohort_fan_harness.py::TestFlexedDistribution`. No v3 equivalent.

### Topic 4 — Zero-evidence degeneration (GAP to fill before deletion)

At zero evidence (empty frames, or single cohort with y=0), a v3
maturity output must degenerate to the unconditional model curve:
midpoint ≈ model_midpoint, fan_upper ≈ model_fan_upper,
fan_lower ≈ model_fan_lower.

This is the "no evidence → pure model prediction" contract.

- v1 coverage: `test_cohort_forecast.py::TestWindowZeroMaturityDegeneration` (4 tests, 2 fixtures, tolerance 0.03–0.05).
- v1+v2 coverage: `v2-v3-parity-test.sh` Phase 3 (checks v3 via CLI).
- v3-pure coverage: **NONE.**

### Topic 5 — CLI canary non-vacuousness (GAP, partial)

`v2-v3-parity-test.sh` Phase 1d asserts each test case produces v3 rows
with midpoint > 0, forecast_x > 0, evidence_x > 0. This is a
non-vacuousness gate on the CLI — makes sure a green run is not
silently returning empty rows.

- v3 coverage: `cohort-maturity-model-parity-test.sh` (Family G canary)
  checks CLI output shape; currently red against a real defect
  (produces no output on 4 cases). Once that defect is fixed, this
  canary will cover the non-vacuousness claim. Until then, **GAP**.

### Topic 6 — Schema completeness (GAP)

`test_v2_v3_parity.py::test_v3_row_schema_complete` is the only test
that asserts a v3 cohort maturity row has the 20 fields the FE chart
builder expects, and that `fan_bands` has levels 80/90/95/99 with
lo ≤ hi at each.

This is not covered by the Family F normaliser-contract test that
landed earlier (that one covers FE-side normaliser semantics; this
covers BE-side row payload shape).

**GAP.** Needs a new Family F test.

---

## Replacement tests — status after prospective build

| # | Test | File | Family | Status |
|---|---|---|---|---|
| R1 | `test_v3_row_schema_has_canonical_fields` | `test_cohort_maturity_v3_contract.py` | F | **GREEN** |
| R1b | `test_v3_fan_bands_carry_band_level_and_median` | same file | F | **GREEN** (canonical v3 band set is {configured level, 50}; v2-era 80/90/95/99 is retired along with v2) |
| R2 | `test_v3_midpoint_monotonic_across_tau` | same file | E | **GREEN** |
| R3 | `test_v3_fan_contains_midpoint` | same file | E | **GREEN** |
| R4 | `test_v3_fan_bounded_01` | same file | E | **GREEN** |
| R5 | `test_v3_midpoint_null_before_solid_max` | — | — | **NOT WRITTEN — design divergence.** v1 emitted `midpoint=None` in epoch A; v3 emits the prior mean there. The FE handles the visual distinction via epoch-aware rendering, not by nulling rows. Not a contract for v3. |
| R6 | `test_v3_evidence_null_after_future_max` | — | — | **NOT WRITTEN — design divergence.** v1 emitted `rate=None` past `tau_future_max`; v3 populates the field in all branches. v3 distinguishes observed from projected via separate fields (`projected_rate`, `forecast_y/x`). |
| R7 | `test_v3_rows_sorted_by_tau` | `test_cohort_maturity_v3_contract.py` | E | **GREEN** |
| R8 | `test_v3_fan_zero_width_at_solid_boundary` | — | — | **NOT WRITTEN — design divergence.** v1 fan collapsed to zero at the boundary; v3 fan at the boundary carries full posterior width. Not a contract for v3. |
| R9 | `test_v3_fan_opens_after_solid_boundary` | — | — | **NOT WRITTEN — design divergence.** v3's conditioned-posterior fan is flat across τ when the posterior applies uniformly; opening only appears in MC-draw branches. Not a universal contract. |
| R10 | `test_v3_midpoint_ge_evidence_window_mode` | `test_cohort_maturity_v3_contract.py` | B | **GREEN** |
| R11 | `test_v3_zero_evidence_degenerates_to_model_curve` | same file | B | **GREEN** |
| R12 | `test_multi_hop_midpoint_below_single_edge_midpoint_v3` | `test_doc56_phase0_behaviours.py` | B/D | **GREEN** |
| R13 | `test_v3_midpoint_moves_toward_evidence_under_strong_data` | — | B | **ALREADY EXISTS** as `test_v2_v3_parity.py::TestStrongEvidenceParity::test_strong_evidence_midpoint_near_observed_rate`. The test is self-contained (inline synth graph, no DB, no v2 reference despite its location). **Relocate at deletion time** to `test_cohort_maturity_v3_contract.py`. Do not duplicate now. |
| R14 | Move `test_v3_handler_widens_single_edge_downstream_cohort_span` | — | B | **ALREADY EXISTS** in `test_v2_v3_parity.py` as a pure v3 monkeypatched unit test. **Relocate at deletion time** to `test_conditioned_forecast_response_contract.py`. Do not duplicate now. |

### Design divergences — audit verdict

R5, R6, R8, R9 represent v1 row-shape rules that v3 *deliberately does
not uphold*. They are not coverage gaps. The audit's job is to catch
that the v1 tests encoded those rules as universal when in fact they
were v1-specific design. The migration to v3 is the point at which
those rules stop holding; the v1 tests die with the engine.

### Pure utility tests

`TestForecastRate`, `TestCDFRatioCalibration`, `TestMCBand`, and
`TestReadEdgeCohortParams` are NOT replaced. They test live shared or
v1-internal utilities, and stay in their current files until the
underlying utility is deleted.

---

## Deletion gating summary

Once R1–R14 are green on main, the following file-level deletions can
proceed, phased by live-code dependency:

**Phase A — v2 oracle retirement (no live-code dependency beyond v2):**
- `test_v2_v3_parity.py` — delete, with R12/R13/R14 already relocated.
- `v2-v3-parity-test.sh` — delete, after `cohort-maturity-model-parity-test.sh` is green.

**Phase B — v1 retirement (blocked on api_handlers.py removing v1 call sites):**
- `test_cohort_forecast.py` — cannot be deleted while v1 is still called from `api_handlers.py`. Delete when v1 is removed from `api_handlers`.
- `test_cohort_fan_controlled.py` — same gating. (The `TestCDFRatioCalibration` and `TestMCBand` subclasses should be moved to a dedicated `test_confidence_bands.py` file before this one is deleted, since their target code outlives v1.)
- `test_cohort_fan_harness.py` — same gating.

No file in this audit is safe to delete today, even with R1–R14
landed, because v1 is still live in `api_handlers.py`. Phase A is
unblocked once R1–R14 land. Phase B is blocked on live-code cleanup.

---

## Audit closure

This audit is the paper trail for [64-forecast-assurance-overhaul.md §11](64-forecast-assurance-overhaul.md)
gate condition 1 ("every assertion that was previously covered by a
v1/v2 oracle has a green v2-free replacement"). It does not itself
grant deletion — deletion requires R1–R14 green on main plus, for
Phase B, the removal of v1 call sites from `api_handlers.py`.
