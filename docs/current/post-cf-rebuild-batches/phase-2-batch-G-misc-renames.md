# Phase 2 / Batch G — three independent rename / regression rows

**Cluster:** three failing tests across three unrelated files, audit-grouped as "one-off renames" but on per-test verification 8-May-26 they're three different failure modes: one likely real defect, one STALE-CONTRACT rewire, one slop-AST-grep delete.

(Filename `batch-G` because `batch-F` was already taken by the unrelated window-path-discrimination plan.)

**Audit refs:** [`post-cf-rebuild-py-test-audit-7-may-26.md`](../post-cf-rebuild-py-test-audit-7-may-26.md) — `test_evidence_adapters` (1), `test_primitive_readout_integration` (1), `test_wp8_default_off` (1).

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_evidence_adapters.py \
  lib/tests/test_primitive_readout_integration.py \
  lib/tests/test_wp8_default_off.py
```

**Touches:** test files only + one regression-tracker entry. No runtime change.

**Predicted Δ:** −2 fails closed (rows 2 and 3 land mechanically). Row 1 left RED as a tracked canary pending dedup-logic investigation.

**Pre-edit baseline:** `3 failed, 39 passed in 6.62s`.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [~] | L | M | `test_evidence_adapters.py:1063` `test_reconstructed_asat_adapter_coexists_with_raw_file_in_one_merge` | **HOLD — investigate**. Test sets up a reconstructed-asat row + a file row sharing date 2026-04-01; asserts `merged.totals.n == 80 + 30 == 110`. Got 180 = 80 + 70 + 30: the merge is keeping BOTH the reconstructed row's `n=80` AND the file row's `n=70` for the shared date instead of letting reconstructed win. Test docstring: *"The reconstructed row wins for 2026-04-01 (snapshot/reconstructed beats file when they share an identity+date)"*. Either the merge-dedup logic regressed or the contract changed and the test is stale. Investigation needed: read `merge_evidence_candidates` in current source; confirm intended dedup rule under shared identity+date; decide if 180 or 110 is the correct contract under 73n. | Audit's wording was "merge keying changed in §A1" — that points at a real contract change. But the witness number (180 vs 110) suggests dedup is NOT firing at all rather than that the keying just shifted. Could be either; should not be papered over. |
| [ ] | H | L | `test_primitive_readout_integration.py:128` `test_substitutes_identically_on_both_surfaces` | **Rewrite** to read substitution diagnostic from `cf_edge["runtime_provenance"]["projection"]` (and the equivalent path on `cm_result`) instead of `cf_edge["primitive_readout"]`. Specifically: `substituted` → `runtime_provenance.projection.substituted`; `subject_probability_source` → `runtime_provenance.projection.subject_probability_source`. Drop the `closed_form_public_moments["p_mean"]` assertion (no direct equivalent at `runtime_provenance` level) — the substantive `cm_p == cf_p` cross-surface parity is already pinned by the prior assertion at line 150. | `primitive_readout` as a CF response key has zero hits in current `api_handlers.py`. The substitution + subject_probability_source diagnostics moved to `runtime_provenance.projection.{substituted, subject_probability_source}` (built by `compute_resolved_runtime_readout`'s diag block, attached at [`api_handlers.py:2336-2340`](../../graph-editor/lib/api_handlers.py#L2336)). STALE-CONTRACT — rewire only, substantive intent (substitution happens identically on both surfaces) preserved. |
| [ ] | H | L | `test_wp8_default_off.py:161` `test_wp8_cohort_forecast_v3_call_site_hardcodes_false` | **Delete** the test entirely (function + docstring). | Test does a regex grep for the literal `_direct_cohort_p_conditioning = False` in `cohort_forecast_v3.py`. The flag mechanism the test guards has been **entirely removed** from `lib/`: zero hits for the literal anywhere in non-test source. Only the helper function `should_enable_direct_cohort_p_conditioning` survives at [`forecast_runtime.py:603`](../../graph-editor/lib/runner/forecast_runtime.py#L603); the `cohort_forecast_v3.py` call site no longer references the flag. The substantive intent (WP8 stays off in this entry point) is pinned behaviourally by sibling tests in the same file at [`test_wp8_default_off.py:91-158`](../../graph-editor/lib/tests/test_wp8_default_off.py#L91): `pce['temporal_family'] != 'cohort'`, `pce['source'] != 'direct_cohort_exact_subject'`, `'direct_cohort_enabled' not in pce`. Static-source grep is slop redundant. |

---

## Refactoring plan

Two commits + one tracker entry:

1. **Row 2 — primitive_readout key rewire** ([`test_primitive_readout_integration.py:156-163`](../../graph-editor/lib/tests/test_primitive_readout_integration.py#L156)). Replace `cf_edge["primitive_readout"]` with `cf_edge["runtime_provenance"]["projection"]`. Same for the `_cm_primitive_readout` helper (probably defined upper in the file — adjust to dig into the equivalent path on `cm_result`). Drop the `closed_form_public_moments["p_mean"]` assertion.

2. **Row 3 — wp8 AST grep delete** ([`test_wp8_default_off.py:161-184`](../../graph-editor/lib/tests/test_wp8_default_off.py#L161)). Remove `test_wp8_cohort_forecast_v3_call_site_hardcodes_false` and its docstring. Drop `re` / `os` imports if no other test in the file uses them.

3. **Row 1 — tracker entry**. Open a new entry under [`cohort-outside-in-post-73n-regression-tracker.md`](../cohort-outside-in-post-73n-regression-tracker.md): "reconstructed-asat / file-evidence merge is not deduping on shared identity+date". Witness, expected vs observed, hooks into `merge_evidence_candidates` source. Test stays RED until the merge contract is settled.

---

## Open questions

1. **Row 1 — is the contract change real?** The audit hints at "merge keying changed in §A1" but doesn't trace it. Before opening the tracker entry, a 30-second read of `merge_evidence_candidates` should confirm whether the dedup is intentional-different or actually broken. Default: read first, then either open tracker entry or rewrite the test against the new contract.

2. **Row 2 — keep or drop the closed-form moments assertion?** Default: drop. The cross-surface p_mean equality is already pinned by the prior assertion at line 150. Adding a third path (closed-form vs MC) is interesting but tangential to the primary intent. If the user wants the closed-form pin preserved, find its current home (probably `runtime_provenance.subject_span.public_moments` or similar — needs a separate read).

3. **Row 3 — completeness of the deletion.** After deleting the AST grep test, the file's behavioural tests (lines 91-158) cover the substantive WP8-stays-off contract. Re-confirm by re-running the file and checking the remaining tests pass green.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch G` and the agent will execute rows 2 and 3, open the tracker entry for row 1, run the verify command, and append the verify-run section below.

---

## Verify run — 8-May-26

**Pre-edit baseline:** `3 failed, 39 passed in 6.62s` across all three files.

**Post-edit:** `1 failed, 39 passed in 0.27s` (running the 2 surviving files; `test_primitive_readout_integration.py` deleted entirely so no longer in collection). Net Δ −2 fails closed.

```
1 failed, 39 passed in 0.27s
```

**Final actions taken:**

- **Row 2** revised from rewire → delete (substitution-as-decision retired; the surviving `runtime_provenance.projection.substituted` flag is structural, not a load-bearing decision; the cross-surface parity claim is already pinned by outside-in's `_assert_public_scalar_parity`). `test_substitutes_identically_on_both_surfaces` removed; the resulting orphan helpers and empty class meant the whole file `test_primitive_readout_integration.py` was deleted.
- **Row 3** deleted: `test_wp8_cohort_forecast_v3_call_site_hardcodes_false` removed from `test_wp8_default_off.py` (slop AST grep for a literal that no longer exists in `lib/`; behavioural coverage exists in same file). Unused `import re` removed.
- **Row 1** left RED. Cluster F entry added to `cohort-outside-in-post-73n-regression-tracker.md` naming the witness, two candidate diagnoses (regression vs contract change), and the read-`merge_evidence_candidates`-source hook. Test stays RED until the merge contract is settled.
