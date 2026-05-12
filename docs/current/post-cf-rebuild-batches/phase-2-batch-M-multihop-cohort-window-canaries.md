# Phase 2 / Batch M — multi-hop cohort/window convergence canaries

**Cluster:** three failing tests across two files. All three pin the same root cause already documented in the regression tracker as **Cluster A — Display-side residual** (rate-attributed Y_prefix is a model expectation, not an observed count). The audit's per-file diagnosis converges on the same conclusion: the carrier-side fix unifies the x-axis, but the subject/projection-side path retains a divergence that surfaces on multiple test surfaces.

**Audit refs:**
- [`post-cf-rebuild-py-test-audit-7-may-26.md:360`](../post-cf-rebuild-py-test-audit-7-may-26.md#L360) — `test_multihop_evidence_parity` (2 real residue, 3 cascade-only)
- [`post-cf-rebuild-py-test-audit-7-may-26.md:418`](../post-cf-rebuild-py-test-audit-7-may-26.md#L418) — `test_window_cohort_convergence` (1 real residue)

**Relationship to your Batch F (window-path-discrimination):** distinct mechanism. Batch F addresses upstream-of-from_node fan-in topology discrimination in MSMDC (`window()` retrieving aggregate vs path-conditional traffic). Batch M addresses post-73n primitive substrate unification residue on cohort vs window y-side projection. The two could intersect if the multi-hop fixtures happen to involve fan-ins, but the audit's hypothesis is that this is the cluster-A residual (different mechanism).

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_window_cohort_convergence.py \
  lib/tests/test_multihop_evidence_parity.py
```

**Touches:** no test files. One regression-tracker doc edit (fold into existing Cluster A entry; potentially open a sub-section "Cluster A canaries on additional surfaces").

**Predicted Δ:** **0 fails closed**. Three tests stay RED, named in tracker, become known-failing canaries pointing at Cluster A.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_multihop_evidence_parity.py::TestMultihopCollapse::test_evidence_y_parity` | **Tracker entry — fold into Cluster A**. evidence_y diverges at 21 τ values (>5% gap) on `from(m4-delegated).to(m4-success)` with declared-instant upstream. evidence_x parity passes; only the y-side fails. Witness exactly matches Cluster A's open Display-side residual symptom. | Audit: *"matches the A-display residual open item in regression-tracker §Cluster A — Display-side residual (still open) which records: 'Chart evidence_y remains structurally divergent. The rate-attributed Y_prefix is a model expectation, not an observed count.'"* Same root cause, different surface. Test stays RED until the y-prefix substitution lands per [`cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md`](../cohort-maturity-selected-a-clock-evidence-clock-adapter-plan.md). |
| [ ] | H | L | `test_multihop_evidence_parity.py::TestMultihopCollapse::test_midpoint_parity` | **Tracker entry — same Cluster A canary**. Midpoint diverges at 15 τ values (>15% gap) on the same fixture. Midpoint is built from the same y-side projection that fails evidence_y parity; this is the same residue surfacing as a derived quantity. | Bigger gap (15% vs 5%) consistent with midpoint = y/x amplifying y-side divergence when x is correctly unified. Same Cluster A. |
| [ ] | H | L | `test_window_cohort_convergence.py::test_multi_hop_composition[synth-mirror-4step:c-d-e]` | **Tracker entry — same Cluster A canary, third surface**. Audit: *"fails with the same shape as test_multihop_evidence_parity::TestMultihopCollapse::test_midpoint_parity. Multi-hop composition midpoint divergence on synth-mirror-4step chain c → d → e. Likely the same A-display residual."* | Same chain, same midpoint mechanism, same y-prefix root cause. Different test entry point (`test_multi_hop_composition` is a single-fixture parametrised test on the convergence file; the multihop tests live in their own file with class-scoped fixtures). Three witnesses, one cause. |

---

## Refactoring plan

One tracker entry (or fold into existing Cluster A subsection):

1. **Cluster A — Additional canary surfaces.** Open a new subsection under [`cohort-outside-in-post-73n-regression-tracker.md` Cluster A](../cohort-outside-in-post-73n-regression-tracker.md#L473) titled *"Multi-hop canary surfaces (8-May-26)"* listing:
   - `test_multihop_evidence_parity::TestMultihopCollapse::test_evidence_y_parity` — y-side divergence on `from(m4-delegated).to(m4-success)`, 21 τ values >5% gap.
   - `test_multihop_evidence_parity::TestMultihopCollapse::test_midpoint_parity` — midpoint divergence (derived from y), 15 τ values >15% gap.
   - `test_window_cohort_convergence::test_multi_hop_composition[synth-mirror-4step:c-d-e]` — multi-hop composition midpoint divergence, same chain.

   Each pinned to the same fix candidate: replace rate-attributed Y_prefix with primitive-bound observed Y placed on the A-clock per the existing adapter plan. Tests stay RED until that substitution lands.

2. **No test edits in this batch.**

3. **MERGE-OUTSIDE-IN deferral.** Audit recommends folding the surviving claims into `test_cohort_factorised_outside_in.py` after the underlying defect is fixed. Out of scope for this batch (Cluster A close-out belongs upstream).

---

## Open questions

1. **Are the multihop fixtures involved in any upstream fan-in topology?** If yes, Batch F (your window-path-discrimination plan) could plausibly close some of these as a side effect. Default: assume no — the fixtures (`synth-mirror-4step`, `from(m4-delegated).to(m4-success)`) are linear chains by their naming convention. Worth a 30-second look at the fixture YAML before opening the tracker entry, in case Batch F's scope absorbs Batch M.

2. **TestV2CrossVersionSignal sub-class in `test_multihop_evidence_parity.py`.** Audit notes this is RETIRE-V2 (goes with the v2 sweep). Phase 1 Batch A1 already deleted `test_v2_v3_parity.py` and `test_v2_v3_parity_outside_in.py`; this sub-class within the multihop file should fold into the same v2-deletion atom. Out of scope here; flag for a clean-up pass when v2 deletion lands.

3. **Should the existing Cluster A "Display-side residual (still open)" subsection at lines 559-619 be split into "chart-evidence_y" and "multi-hop-composition" as separate subsections?** Default: keep as one cluster, add a short multi-hop canary subsection. Same root cause, splitting just makes the doc longer.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch M` and the agent will write the Cluster A canary subsection in the tracker, run the verify command, and append the verify-run section.

---

## Verify run — pending
