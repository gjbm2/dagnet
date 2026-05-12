# Phase 1 / Batch A3 — 73n tombstone files

**Cluster:** five tombstone files mended from `_attic` per
[`73-attic-mending-process.md`](../project-bayes/73-attic-mending-process.md).
The mending-process tombstoned tests whose deleted symbols couldn't be
mechanically translated. The audit's recommendation was outright deletion
to remove dead weight from the suite.

**Files:**
1. `graph-editor/lib/tests/test_primitive_readout.py` (15 tests: 14 skip + 1 live)
2. `graph-editor/lib/tests/test_multi_hop_window_readout.py` (13 tests: all skip)
3. `graph-editor/lib/tests/test_multi_hop_subject_readout.py` (13 tests: all skip)
4. `graph-editor/lib/tests/test_stage_8_substrate_provenance.py` (10 tests: all skip)
5. `graph-editor/lib/tests/test_active_cohort_carrier_readout.py` (17 tests: 16 skip + 1 live)

**Audit mistake to flag:** the audit reported these as 5 pure tombstone
files. Two contain live load-bearing tests (file 1's constants check, file
5's AP58 import guard). The audit's "delete outright" recommendation
without per-file inspection would have lost both.

**Verify command:** `cd graph-editor && venv/bin/pytest lib/tests/test_primitive_readout.py lib/tests/test_multi_hop_window_readout.py lib/tests/test_multi_hop_subject_readout.py lib/tests/test_stage_8_substrate_provenance.py lib/tests/test_active_cohort_carrier_readout.py --tb=line -q`

**Touches:** test files only. No runtime change.

**Predicted Δ:** **0 fails** (all tombstones are skipped, not failed). 66
skipped tests removed from collection (68 → 2). The live tests stay live
and passing.

---

## Workplan-reminder check (done before per-test verdicts)

The four tombstone-only files (1, 2, 3, 4) carry docstring references to
GAP / Tier A workplan items not yet covered live. If the audit doc tracks
those items, deletion is safe. If not, deletion loses the on-disk
reminder.

Result of grep across `docs/`:

| Tombstone-noted item | Tracked in docs? |
|----------------------|------------------|
| Tier A.7 §709 anti-collapse-to-terminal (in `test_multi_hop_window_readout.py`) | **Yes** — [`73-attic-coverage-audit.md:426`](../project-bayes/73-attic-coverage-audit.md#L426) names the test (`test_multi_hop_window_does_not_collapse_to_terminal_edge`) and the target file (`test_primitive_readout_integration.py`). Also [`73-attic-mending-process.md:232,251`](../project-bayes/73-attic-mending-process.md). |
| Stage-8 readout-level wrapping (in `test_stage_8_substrate_provenance.py`) | **Yes** — [`73-attic-coverage-audit.md:370`](../project-bayes/73-attic-coverage-audit.md#L370) records the GAP and what's pinned vs missing. |
| Tier A.8 target-subject isolation (in `test_active_cohort_carrier_readout.py` skipped test 113) | **Yes** — [`73-attic-mending-process.md:251`](../project-bayes/73-attic-mending-process.md#L251). |
| Tier A.9 upstream-resolved-model-moves-carrier-reach (in `test_active_cohort_carrier_readout.py` skipped test 110) | **Yes** — [`73-attic-mending-process.md:251`](../project-bayes/73-attic-mending-process.md#L251). |

**Conclusion:** all workplan reminders durably tracked in the audit /
mending-process docs. No on-disk reminder lost by tombstone deletion.

**Pre-existing tech debt flagged but out of scope:**
[`73n-stage-5c-note.md:121,140`](../project-bayes/73n-stage-5c-note.md#L121)
references `test_on_flag_does_not_collapse_to_terminal_edge` as a "proof"
that §709 is satisfied — but the test is skipped under the tombstone, so
the proof is already vacuous (predates this batch). Deletion makes the
dangling reference visible. Should be cleaned up in a doc-hygiene pass
when the Tier A.7 test lands at the unified-entry layer.

---

## Per-test verdicts

### `test_primitive_readout.py` (15 tests)

| ✓ | Conf | Risk | Line | Test | Verdict | Read justifies |
|---|------|------|------|------|---------|----------------|
| [ ] | H | L | 59 | `test_shadow_band_constants_match_stage_0c_contract` | **KEEP** | Pins `SHADOW_ABS_BAND == 0.005` and `ACCEPTANCE_ABS_BAND == 0.002`. Constants still exported by `runner/primitive_readout.py` at lines 250, 254 and consumed by the runtime at lines 1003, 1019, 1021. Live load-bearing. |
| [ ] | H | L | 79–243 (14 tests) | `test_eligible_*`, `test_ineligible_*`, `test_should_substitute_*`, etc. | DELETE | All `@pytest.mark.skip(reason=_OBSOLETE_ELIGIBILITY_REASON)`. All target the deleted `compute_single_hop_readout` / `is_single_hop_window_eligible` API. Live cover for surviving intent: `test_primitive_readout_integration.py` per the file's docstring. |

**File action:** prune to keep only line 59. Update docstring to reflect
that the file is now a single-test pin on the band constants.

### `test_multi_hop_window_readout.py` (13 tests, all skip)

All tests target deleted `compute_multi_hop_window_readout` /
`is_multi_hop_window_eligible`. Verdict: **DELETE FILE**. Workplan items
(Tier A.7 §709) tracked in audit docs (see above).

### `test_multi_hop_subject_readout.py` (13 tests, all skip)

All tests target deleted `compute_multi_hop_subject_readout` /
`is_multi_hop_subject_eligible`. Live cover **confirmed** at
`test_subject_span_composer.py:294::test_two_hop_serial_composes_probability_via_doc_29b_dp`
(grep verified). Verdict: **DELETE FILE**.

### `test_stage_8_substrate_provenance.py` (10 tests, all skip)

All tests target the deleted four per-surface readout entries' diagnostics
substrate inventory. Primitive-level closure-required keys pinned live at
`test_primitive_contract.py:602::test_to_provenance_dict_carries_stage_8_closure_required_items`
(grep verified). Verdict: **DELETE FILE**.

### `test_active_cohort_carrier_readout.py` (17 tests)

| ✓ | Conf | Risk | Line | Test | Verdict | Read justifies |
|---|------|------|------|------|---------|----------------|
| [ ] | H | L | 137 | `test_module_does_not_import_trajectory_engine` | **KEEP** | Static-source AP58 import-guard. Inspects `runner/primitive_readout.py` text directly for forbidden imports (`forecast_state`, `forecast_runtime`, `cohort_forecast_v3`). Per-comment AP58 / KNOWN_ANTI_PATTERNS §272: re-introducing those imports would re-create the projection-vs-primitive duplication 73n exists to remove. **Load-bearing**. Synthetic, no DB. |
| [ ] | H | L | 55–131 (16 tests) | `test_eligible_active_cohort_*`, `test_ineligible_*`, `test_should_substitute_property`, etc. | DELETE | All `@pytest.mark.skip(reason=_OBSOLETE_REASON)`. All target the deleted `compute_active_cohort_carrier_readout` / `is_active_cohort_carrier_eligible` API. |

**File action:** prune to keep only line 137 (and its imports). The file
name `test_active_cohort_carrier_readout.py` becomes misleading post-prune
— the surviving test is about `primitive_readout.py`'s import surface,
not active-cohort carrier readout. **Open question** below.

---

## Refactoring plan

### File 1: `test_primitive_readout.py` — prune

Keep:
- Top docstring (rewrite to reflect new scope)
- `from runner.primitive_readout import ACCEPTANCE_ABS_BAND, SHADOW_ABS_BAND`
- `test_shadow_band_constants_match_stage_0c_contract`

Delete: everything else (14 skipped tests, the `_OBSOLETE_ELIGIBILITY_REASON`
constant, the section-divider comment, the verbose tombstone-record
comments).

### Files 2, 3, 4: delete entirely

`rm test_multi_hop_window_readout.py test_multi_hop_subject_readout.py test_stage_8_substrate_provenance.py`.

### File 5: `test_active_cohort_carrier_readout.py` — prune

Keep:
- Top docstring (rewrite to reflect new scope)
- imports needed for the AP58 guard (`os`)
- `test_module_does_not_import_trajectory_engine`

Delete: everything else (16 skipped tests, the `_OBSOLETE_REASON` constant,
the verbose tombstone-record comments, the unneeded `pytest` import — the
surviving test uses no pytest features beyond plain assertion).

---

## Open questions (record decision before proceed)

1. **Rename file 5?** After pruning, `test_active_cohort_carrier_readout.py`
   contains only the AP58 import guard for `primitive_readout.py`. The
   current name no longer describes the contents. Options:
   - (a) Keep current name, update docstring to explain the residual
     AP58-guard role. Default.
   - (b) Rename to `test_primitive_readout_ap58_guard.py` (or similar) to
     match the actual test's scope. More accurate, more intrusive (rename
     mechanics).

2. **Doc-hygiene followup for 73n-stage-5c-note dangling references.**
   Lines 121 and 140 cite the tombstoned test as proof. Already-vacuous;
   deletion makes the dangling reference visible. Out of scope for this
   batch — flag for later doc cleanup. Default: do not touch.

3. **Constants test relocation alternative.** `test_shadow_band_constants_match_stage_0c_contract`
   could alternatively be folded into `test_primitive_contract.py` (which
   already has primitive-related contract tests at line 602 etc.) and the
   primitive_readout file deleted entirely. Pro: one fewer file. Con:
   minor relocation churn, file's purpose stays narrowly scoped to
   primitive_readout's own surface. Default: keep file, prune to single
   test.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch A3` and the agent will execute, run the
verify command, and append the verify-run section below.

---

## Verify run — pending
