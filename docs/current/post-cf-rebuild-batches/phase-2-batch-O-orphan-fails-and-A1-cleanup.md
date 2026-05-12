# Phase 2 / Batch O — orphan fails + Phase 1 Batch A1 self-inflicted regression cleanup

**Cluster:** twelve failing tests not covered by any prior batch manifest. Three groupings:

1. **A1 self-inflicted** (2 fails) — Phase 1 Batch A1 deleted `test_v2_v3_parity.py` and `test_v2_v3_parity_outside_in.py`; the doc 73b §8 Stage 0 gate-pinning test (`test_stage0_outside_in_cli_gate.py`) asserts those files exist as mandatory public-surface gates. The deletion left this gate dangling.
2. **Audit "separate from scope" residual** (6 fails) — `test_cohort_maturity_v3_contract.py` post-7-May-26 TEST-INFRA fix. Audit explicitly noted: *"Those 12 are now NEEDS-INVESTIGATION (likely STALE-CONTRACT — band-key naming, etc.) but separate from this audit's scope"*. Down to 6 in the 8-May-26 full-suite re-run.
3. **Newly-surfaced regressions** (4 fails) — three in `test_cf_query_scoped_degradation.py` (different witnesses than audit's pre-7-May TEST-INFRA fails) and one in `test_cohort_factorised_outside_in.py` (the GREEN-baseline outside-in oracle has regressed on one anchor-override case).

**Source of truth:** `/home/reg/dev/dagnet/tmp1.log` 8-May-26 full-suite run (`39 failed, 1475 passed, 38 skipped, 2 xfailed in 1373.63s`).

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_stage0_outside_in_cli_gate.py \
  lib/tests/test_cohort_maturity_v3_contract.py \
  lib/tests/test_cf_query_scoped_degradation.py \
  lib/tests/test_cohort_factorised_outside_in.py::test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case
```

**Touches:** test files + possibly source. Mix of mechanical cleanup and per-test investigation.

**Predicted Δ:** −2 (A1 cleanup) + −1 to −3 (band-key naming if mechanical) + variable on the rest. Realistic best case: −6 closed. Worst case: −2 + 10 RED canaries opened in tracker.

---

## Per-test verdicts

### Group 1 — A1 self-inflicted regression (mechanical cleanup)

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_stage0_outside_in_cli_gate.py::test_param_pack_outside_in_gate_exists[test_v2_v3_parity_outside_in.py]` | **Update gate test** to remove the parametrised case for `test_v2_v3_parity_outside_in.py`. The file is gone-by-design (Phase 1 Batch A1 / RETIRE-V2 per audit and user direction). Adjust the parametrise list in [`test_stage0_outside_in_cli_gate.py`](../../graph-editor/lib/tests/test_stage0_outside_in_cli_gate.py) to drop both v2-parity entries; consider whether doc 73b §8 Stage 0 needs an update too (the gate-pinning was pre-RETIRE-V2). | The gate's purpose is to block silent regressions on mandatory public-surface tests. The two RETIRE-V2 files are no longer mandatory; the gate must reflect that. |
| [ ] | H | L | `test_stage0_outside_in_cli_gate.py::test_param_pack_outside_in_gate_exists[test_v2_v3_parity.py]` | Same — remove from parametrise list. | Same. |

### Group 2 — `test_cohort_maturity_v3_contract.py` 6 residual fails (audit's "separate from scope")

Source-traced 8-May-26: three sub-clusters within Group 2.

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_v3_fan_bands_carry_band_level_and_median` (line 494) | **Rewrite** to drop `'50'` from the asserted canonical level set. Witness: `assert '50' in {'80': [0.5, 0.5], '90': [...], '95': [...], '99': [...]}`. Bands now emit only `'80','90','95','99'`; the median is carried separately as `r['midpoint']`. Update test to (a) assert canonical-level set is `{'80','90','95','99'}` and (b) assert `r['midpoint']` carries the median scalar. | Mechanical STALE-CONTRACT rewire. The substantive intent (canonical band-level set is pinned) is preserved; only the level membership has shifted post-73n. |
| [ ] | M | M | `test_v3_zero_evidence_degenerates_to_model_curve` (line 645) | **Real defect — open tracker entry**. Witness: at τ=0, `mid=0.0000` while `model=0.8019`. Test fixture builds `_build_zero_evidence_frames` (frames with k=0, n>0) and asserts midpoint should degenerate to `model_midpoint`. Observed: conditioner is applying the k=0 evidence as if it were real — `k=0/n=several` constrains posterior `p → 0`, yielding `mid=0`. Expected: zero-evidence detection should short-circuit to the unconditioned model curve (per test docstring: *"with zero observed conversions on a realistic anchor population, the v3 output must degenerate to the unconditioned model curve"*). Either the degenerate-case detection has been removed or the conditioner is not honouring it. | Distinct from the empty-frames cluster below: this fixture HAS frames (with k=0); empty-frames cluster has truly zero frames. Both routes need a degenerate-case fallback to the model curve, but they exit different upstream branches. |
| [ ] | M | M | `test_v3_empty_frames_window_mode_uses_latency_curve` (line 711) | **Real defect, likely shared root cause with the next 3 rows**. Witness: `assert None == 0.0 ± 1.0e-06` at `by_tau[0]['midpoint']`. Test calls `_run_v3(..., frames=[])` on a single-edge graph and asserts `midpoint = p × CDF_X→Y(τ)`. Observed: midpoint = None across all τ. Empty-frames branch in v3 row builder is emitting None midpoint instead of falling through to the latency-only baseline. | One root cause; investigate the empty-frames branch in [`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py) where `frames=[]` enters; identify where midpoint computation gates on a non-empty subject prefix and bypasses the latency-only fallback. |
| [ ] | M | M | `test_v3_empty_frames_window_mode_matches_truth_lognormal_curve` (line 765) | **Same root cause as previous row**. Witness: `checked only 0 tau points`. Test loops over τ-points; every row has `midpoint is None` (continue branch in test) so checked=0. Same upstream emission gap. | Same fix likely closes both window-mode tests. |
| [ ] | M | M | `test_v3_empty_frames_cohort_mode_preserves_upstream_carrier` (line 843) | **Same root cause family**. Witness: `cohort empty-frame fallback lost the upstream-carrier lag`. Cohort-mode counterpart of the window-mode pair above. The cohort-mode empty-frames branch is dropping the upstream carrier convolution from the latency-only fallback. | Same upstream defect surfacing on the cohort path. |
| [ ] | M | M | `test_v3_empty_frames_cohort_mode_matches_truth_fw_curve` (line 913) | **Same root cause as previous row**. Witness: `checked only 0 FW-backed tau points`. Cohort-mode counterpart of `*_window_mode_matches_truth_lognormal_curve`. | Same. |

**Group 2 sub-clusters:**

- **Sub-cluster 2a** (1 fail) — fan_bands canonical-level set drift (mechanical rewire).
- **Sub-cluster 2b** (1 fail) — zero-evidence-with-frames degenerate-case detection lost (real defect).
- **Sub-cluster 2c** (4 fails) — empty-frames latency-fallback emission gap (real defect; one root cause likely closes all four).

### Group 3 — Newly-surfaced regressions

Source-traced 8-May-26: one mechanical (3a) plus three real-defect candidates with concrete hypotheses (3b, 3c, 3d).

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_cf_query_scoped_degradation.py::test_latency_rows_use_shared_sweep_contract` (line 138) | **Rewrite — STALE-CONTRACT**. Witness: expected `_conditioning == {'r': None, 'm_S': None, 'm_G': None, 'applied': False, 'skip_reason': 'primitive_substrate_owns_doc52_blend'}`; observed has `{'owner': 'primitive_conditioning'}` (different schema entirely). The post-73n shared-sweep `_conditioning` provenance now uses an `owner`-keyed shape. Update test expectation to match the new schema. Confirm at [`cohort_forecast_v3.py`](../../graph-editor/lib/runner/cohort_forecast_v3.py) wherever `_conditioning` is set on the first row. | Mechanical rewire, schema migration. The substantive intent (latency-row conditioning is structural skip with primitive-substrate ownership) is preserved; the field shape changed. |
| [ ] | M | M | `test_cf_query_scoped_degradation.py::test_shared_sweep_latency_rows_keep_window_denominator_fixed` (line 177) | **Per-test investigation**. Witness: `rows_by_tau[0]['evidence_x']` expected None, observed 150.0 (the window denominator). Lines 195-203 expect specific values at τ=2,4,5 as observations land. The τ=0 expectation of None pins *"before any observation, evidence_x is undefined"*. The current emission of 150.0 (= window denominator) at τ=0 suggests an over-eager-fill regression OR a deliberate contract change to populate evidence_x with the carrier-only denominator from τ=0 (independent of observations). Open tracker entry; read v3 row builder's τ=0 evidence_x emission logic to decide stale-vs-real. | Cf. Cluster E close-out — the BE now eagerly flattens evidence totals into per-edge fields. The same eagerness may now be reaching τ=0 rows where it shouldn't. |
| [ ] | H | H | `test_cf_query_scoped_degradation.py::test_cohort_maturity_rows_v3_identity_drift` (line 815) | **Real defect — open tracker entry**. Witness: at row 0 (τ=0), `same-identity p_infinity_mean=0.19971152` vs `mixed-identity=0.20058272` — gap `~0.0009`, beyond `pytest.approx` default tol. Test runs identical inputs differing only in identifier strings; assertion is identity-invariance across `tau_days`, `evidence_x`, `evidence_y`, `midpoint`, `rate`, `p_infinity_mean`, `completeness`. At τ=0 the conditioning has zero weight, so identity should not influence the projection. The 0.4% gap is structural — identity is leaking into the projection upstream of conditioning, possibly via cohort-key derivation or identity-aware draw seeding. | Identity-leak is the kind of defect that silently biases every comparison across runs with different anchor identities. The test name names the contract; the witness violates it. |
| [ ] | H | H | `test_cohort_factorised_outside_in.py::test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` (line 2258) | **Real defect — open tracker entry with hypothesis**. Witness: `(admitted_k, admitted_n) == (window_k, window_n)` expected; observed `(13440, 26317) == (17543, 27698)`. Test asserts WP8-off single-hop anchor-override (cohort with anchor=upstream-of-from) should keep window-rooted p-conditioning evidence. Both ratios are different (admitted 0.511 vs window 0.633) — admitted is using a smaller, cohort-restricted observation set. **Hypothesis**: Cluster E's silent close-out (BE flattening `last_row['evidence_x'] / evidence_y` into per-edge `evidence_n`/`evidence_k` at [`api_handlers.py:2293-2306`](../../graph-editor/lib/api_handlers.py#L2293)) exposed a pre-existing mismatch in `engine_cohorts` population under cohort+WP8-off+anchor-override. Engine_cohorts should stay window-rooted under WP8-off; the witness suggests it's being filtered cohort-restricted regardless of WP8 state. | The most concerning single witness in the current 39 fails — outside-in oracle regression. The hypothesis links it to Cluster E close-out: previously evidence_n/k were `None` (Cluster E open state), so this assertion would have been comparing `(None, None) == (None, None)` and passing trivially. With evidence_n/k now populated, the assertion compares actual values and reveals the engine_cohorts population mismatch. Verify by checking the test's git log: did the test pass under the pre-Cluster-E-close-out state by virtue of Nones, or did it pass with substantive equal values that have now drifted? |

**Group 3 sub-clusters:**

- **Sub-cluster 3a** (1 fail) — `_conditioning` schema drift (mechanical rewire).
- **Sub-cluster 3b** (1 fail) — τ=0 evidence_x over-eager fill (contract drift vs regression — needs decision).
- **Sub-cluster 3c** (1 fail) — identity-leak into projection at τ=0 (real defect).
- **Sub-cluster 3d** (1 fail) — anchor-override engine_cohorts mismatch under WP8-off (real defect, possibly exposed by Cluster E close-out).

---

## Refactoring plan

Order: cleanup first (Group 1), then mechanical fix (one row in Group 2), then per-test investigations.

1. **Group 1 — A1 cleanup** (mechanical). Remove the two parametrised cases from `test_stage0_outside_in_cli_gate.py`. If doc 73b §8 Stage 0 names these as mandatory, also update doc 73b to reflect the RETIRE-V2 close-out. ~10 minutes.

2. **Group 2 row 1 — band-key rewire** (`test_v3_fan_bands_carry_band_level_and_median`). Mechanical update of the canonical band-level set in the test. ~10 minutes.

3. **Group 2 rows 2-6 — empty-frames fallback investigation**. Read the empty-frames branch in the v3 row builder; one root cause likely covers the four `test_v3_empty_frames_*` cases plus possibly the zero-evidence-degenerate-to-model-curve case. Open one or two tracker entries depending on what the read shows. ~30 minutes.

4. **Group 3 — newly-surfaced regressions**. Each gets a per-test investigation:
   - `test_latency_rows_use_shared_sweep_contract` — schema drift read on `_conditioning`.
   - `test_shared_sweep_latency_rows_keep_window_denominator_fixed` — read shared-sweep evidence-totals contract; may be related to Cluster E close-out.
   - `test_cohort_maturity_rows_v3_identity_drift` — real-defect candidate; open tracker entry.
   - `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` — outside-in regression; open tracker entry.

---

## Open questions

1. **Doc 73b §8 Stage 0 update.** The gate-pinning test cites doc 73b as the source of "mandatory public-surface gate". If RETIRE-V2 supersedes that mandate, the doc needs a one-line note. Default: yes, update doc 73b alongside the test.

2. **Group 2 zero-evidence-degenerate-to-model-curve fold-in.** This test's failure shape matches Cluster A's display-side y-side residual exactly (model-projection-as-evidence-named-field). Default: open as a Cluster A canary subsection rather than a separate cluster. The 9 Batch B canaries already in Cluster A would gain a tenth.

3. **Group 3 outside-in regression scope.** The `test_cohort_frame_evidence_is_admitted_only_for_single_hop_anchor_override_case` regression is the canary — but other anchor-override cases in the same file may also be drifting silently. Default: investigate this one canary; if the fix exposes more, open a sub-cluster.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch O` and the agent will execute Group 1 first (mechanical), then Group 2 row 1 (mechanical), then queue Groups 2 (rows 2-6) and 3 for per-test investigation in priority order.

---

## Verify run — pending
