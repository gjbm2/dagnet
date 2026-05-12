# Phase 2 / Batch I — `test_selected_cohort_pop_d_distribution.py` helper-fix verify

**Cluster:** six failing tests in `test_selected_cohort_pop_d_distribution.py`. Audit said all five share root cause `TypeError: _SelectedSourceDayMass.__init__() missing 1 required positional argument: 'endpoint_cdf_by_node'`; the sixth (`test_m_select_construction_for_multi_hop_downstream_node` — `assert 0.0 == 100.0`) was downstream of the helper failing to construct.

**Verified from source 8-May-26:** the helper fix has already landed. [`test_selected_cohort_pop_d_distribution.py:74-80`](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L74) now passes `endpoint_cdf_by_node=...` to `_SelectedSourceDayMass.__init__`. The file is modified in `git status`.

**Predicted Δ:** likely −5 fails closed already (helper fix). The sixth test (`assert 0.0 == 100.0`) needs an isolated re-run to confirm whether it cleared with the helper or whether it is a real residual.

**Audit refs:** [`post-cf-rebuild-py-test-audit-7-may-26.md:382`](../post-cf-rebuild-py-test-audit-7-may-26.md#L382) — TEST-INFRA / API change.

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_selected_cohort_pop_d_distribution.py
```

**Touches:** no new test edits expected. If the verify-run still has 1 residual, that test gets a per-test verdict in a follow-up.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| — | H | L | five tests passing through `_select_source_day_mass_at_x` (helper users) | (pass — helper fix landed) | Helper at [`test_selected_cohort_pop_d_distribution.py:74`](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L74) now passes `endpoint_cdf_by_node` keyword. The dataclass-construction TypeError that the audit named is structurally impossible after this change. |
| [ ] | M | L | `test_m_select_construction_for_multi_hop_downstream_node` (line 1611) | **Verify-run only**. If still failing after helper fix, follow up with a per-test source read; the audit speculated it might disappear once the helper compiled. | Audit's wording: *"the assertion failure may turn out to be real or to disappear"*. Cannot resolve without running. The `0.0 == 100.0` shape suggests the assertion is comparing some computed mass against a fixture-expected scalar; if the helper produces the right shape now, the multi-hop construction may yield `100.0` correctly. |

---

## Refactoring plan

Just verify-run. No edits planned in this batch.

1. Run the verify command above.
2. If `0 failed` → close batch as no-action.
3. If `1 failed` (the multi-hop test) → write a per-test action (read the test body + `_select_source_day_mass_at_x` use at line 1611, decide whether the assertion is pinning real-but-broken multi-hop construction or a stale expectation).

---

## Open questions

1. **Why is this file in `git status` modified?** Likely the helper fix landed under another commit's scope (possibly the 7-May-26 TEST-INFRA fixes the audit's update §lists). Worth a `git diff` before running so we know whether to commit the existing change as part of this batch.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch I` and the agent will run the verify command, decide the closing action based on the result, and append the verify-run section.

---

## Verify run — 8-May-26 (full-suite re-run)

**Pre-edit baseline (audit, 7-May-26):** 6 fails — 5 sharing the `_SelectedSourceDayMass.__init__() missing 1 required positional argument: 'endpoint_cdf_by_node'` TypeError plus 1 downstream assertion failure (`assert 0.0 == 100.0`).

**Post-edit (full-suite re-run, 8-May-26):** 3 fails. Net Δ: −3 vs audit baseline. Helper fix landed (verified at [`test_selected_cohort_pop_d_distribution.py:74-80`](../../graph-editor/lib/tests/test_selected_cohort_pop_d_distribution.py#L74) passing `endpoint_cdf_by_node=...`).

**Witnesses on the 3 surviving fails:**

```
test_runtime_built_selected_a_clock_evidence_feeds_existing_consumers
  assert 0.0 == 6.0 ± 6.0e-06  (NEW — newly surfaced post-helper-fix)

test_per_source_day_forward_fill_preserves_monotonicity_under_sparse
  assert 0.0 == 1.2 ± 1.2e-06  (NEW — newly surfaced post-helper-fix)

test_m_select_construction_for_multi_hop_downstream_node
  assert 0.0 == 100.0 ± 1.0e-04  (the audit-named residual)
```

**Final actions taken:**

- Helper fix already landed pre-batch (file modified in `git status`); no new edit required.
- 3 of the 6 audit fails closed; 3 different fails are now visible. Two of these are NEW assertion-level signals that were buried under the helper TypeError barrier (per audit's prediction: *"Once the constructor compiles, the assertion failure may turn out to be real or to disappear"* — answer: **partly real, partly newly surfaced**). All three surviving witnesses share the `assert 0.0 == <expected>` shape, suggesting an upstream branch is returning empty / zero-mass arrays where the test fixtures expect populated mass.
- These three should be addressed as a tighter follow-up batch (likely a single root cause in M_select / x-prefix construction). Provisionally tracked under Cluster A or as a sibling cluster pending a per-test investigation.
- Net Δ: **−3 fails closed**.

