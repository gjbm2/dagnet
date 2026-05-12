# Phase 2 / Batch L — STALE-73N cluster across two files

**Cluster:** four failing tests across two files. All four pin pre-73n APIs (deleted functions, renamed accessors, retired diagnostics) — STALE-CONTRACT against the 73n architectural changes.

**Audit refs:**
- [`post-cf-rebuild-py-test-audit-7-may-26.md:321`](../post-cf-rebuild-py-test-audit-7-may-26.md#L321) — `test_forecast_state_cohort` (3 fails)
- [`post-cf-rebuild-py-test-audit-7-may-26.md:392`](../post-cf-rebuild-py-test-audit-7-may-26.md#L392) — `test_subject_span_cdf_ownership` (1 fail)

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_forecast_state_cohort.py \
  lib/tests/test_subject_span_cdf_ownership.py
```

**Touches:** test files only.

**Predicted Δ:** likely −3 fails closed (3 mechanical retirements) + 1 hold for source review (the trajectory-blend test). Worst case: 4 closed if all retire cleanly.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_forecast_state_cohort.py:412` `test_single_retrieval_completeness_lives_in_success_probability` | **Delete**. The test imports `_cohort_binomial_log_likelihood` from `runner.forecast_state`; audit confirms function deleted by 73n's "trajectory engine becomes a pure projector" change. The substantive intent (Binomial likelihood treats single-retrieval completeness as a multiplier on `p`) was a property of the deleted compiler kernel. The 73n replacement (per-cohort multinomial cell decomposition in the conditioner — see [`cohort-outside-in-post-73n-regression-tracker.md` §"Defect A1"](../cohort-outside-in-post-73n-regression-tracker.md#L635)) is pinned by `test_primitive_conditioning.py` and `test_evidence_merge.py`. No coverage gap. | Same shape as Phase 1 Batch A3 tombstone deletions — function gone, test pins gone-by-design API. |
| [~] | M | M | `test_forecast_state_cohort.py:446` `test_trajectory_blend_cohort_evals_populated_unconditioned` | **HOLD — investigate**. Asserts `sweep.blend_applied is True`. Audit notes *"the IS-blend flag is no longer raised on this trajectory shape … may still be load-bearing — needs a single read-through to decide"*. Action: read `compute_forecast_trajectory`'s current blend-flag emission and decide whether (a) the flag has been renamed (rewire the test), (b) the blend mechanism was retired (delete), or (c) the blend should still fire on this fixture and the test catches a real regression (open tracker entry). | Doc 52 §14 ownership claim in the test docstring is meaningful — the blend mechanism touches BE topo pass, daily-conversions annotation, and latency band sweep, all of which read `cohort_evals[i].y_draws/x_draws`. If the contract has been retired silently, downstream consumers may have lost coverage. Worth the 10-minute read before committing to delete vs rewire. |
| [ ] | H | L | `test_forecast_state_cohort.py:677` `test_phase1_non_latent_upstream_produces_active_dirac_carrier` | **Rewrite** to read whatever replaced `is_active` on `TimingSpan`. The substantive intent (non-latent upstream produces a Dirac-at-zero active carrier) is preserved; only the accessor name changed during the 73m carrier rewrite. Quick source read of `TimingSpan` in `runner/timing_span.py` (or wherever it now lives) to find the replacement. | Audit: *"the `is_active` accessor was renamed/removed during the 73m carrier rewrite"*. Mechanical accessor rename — STALE-CONTRACT, rewrite shape. |
| [ ] | H | L | `test_subject_span_cdf_ownership.py` `test_per_draw_cdf_variation_drives_is_separation` | **Rewrite or delete**. Audit verdict: STALE-73N. Test asserts `compute_forecast_trajectory` returns `n_cohorts_conditioned == 1`; 73n stage-9 deliberately moved conditioning OUT of the trajectory engine (per `forecast_state.py:1296-1305`), so the engine's `n_cohorts_conditioned` is 0 by design. Either rewrite to call `condition_primitive` first then check, or delete because the per-draw IS-separation contract is now pinned at the conditioner level (`test_primitive_conditioning.py`). Default: **delete** — no coverage gap; rewriting would just relocate an existing pin. The 11 sibling tests in the same file are still relevant and are not in scope. | Already documented in [`cohort-outside-in-post-73n-regression-tracker.md` §"Stale-architecture test — adjacent suite"](../cohort-outside-in-post-73n-regression-tracker.md#L959). Architecture migration; the contract migrated, not disappeared. |

---

## Refactoring plan

Three commits + one hold:

1. **Row 1 + Row 4 — deletions** ([`test_forecast_state_cohort.py:412`](../../graph-editor/lib/tests/test_forecast_state_cohort.py#L412) and [`test_subject_span_cdf_ownership.py` test_per_draw_cdf_variation_drives_is_separation](../../graph-editor/lib/tests/test_subject_span_cdf_ownership.py)). Remove function bodies + any orphan imports. If row 4's deletion leaves the parent class empty, delete the class too. Sibling tests in both files stay.

2. **Row 3 — accessor rename rewire** ([`test_forecast_state_cohort.py:677`](../../graph-editor/lib/tests/test_forecast_state_cohort.py#L677)). Read current `TimingSpan` definition, replace `is_active` with the new accessor (likely something like `active_at(0)` or a flag inside an outer container). Preserve the substantive assertion shape.

3. **Row 2 — investigation hold**. Open with a 10-minute read of `compute_forecast_trajectory` in [`runner/forecast_state.py`](../../graph-editor/lib/runner/forecast_state.py). Decide one of {delete, rewire, tracker entry}. Returns to this batch's verify command after the read.

---

## Open questions

1. **Row 2's blend flag — is the mechanism actually retired?** The doc 52 §14 framing suggests not. If the flag is still emitted under different conditions, the test fixture may need adjustment rather than deletion. Default: read the source, don't pre-judge.

2. **Row 4's sibling coverage.** `test_subject_span_cdf_ownership.py` has 11 other tests pinning subject-span CDF ownership. The deleted test is specifically about IS-separation per-draw — does any sibling cover IS-separation? Probably not (separation is a conditioner-level property post-73n). Default: delete; if user wants pinning kept somewhere, add to `test_primitive_conditioning.py` separately.

3. **Coverage gaps post-deletion.** Phase 1 Batch A3 retired five tombstone files cleanly because their substantive intent had been superseded by sibling pins. Rows 1 and 4 here follow the same pattern. The audit's footnote that "the 11 sibling tests in the same file are still relevant" applies to both — no broader coverage loss.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch L` and the agent will execute rows 1, 3, 4 (delete + rewire), open the row 2 read-through, run the verify command, and append the verify-run section.

---

## Verify run — pending
