# Phase 1 / Batch A — Sweep-deletes + DEFER-73Q xfail

> **INVALIDATED 7-May-26.** This manifest transcribed the audit's per-file
> verdicts without per-test reads. A spot-check on `test_v2_v3_parity.py`
> revealed at least four v3-only invariants lurking inside a "RETIRE-V2"
> file. The audit was prepared quickly; trusting it without independent
> verification produced a manifest with the wrong actions.
>
> Superseded by per-cluster batches with per-test analysis:
>
> - Batch A1: v2-parity cluster (`test_v2_v3_parity.py` + `_outside_in.py`)
> - Batch A2: `test_carrier_object_contract.py` STALE-73N
> - Batch A3: the 5 tombstone files
> - Batch A4: `test_subject_span_cdf_ownership.py` single-test + DEFER-73Q xfail
>
> Do not execute against this file. Kept for the historical record only.

---

**Cluster:** RETIRE-V2 files, STALE-73N tombstones, one stale-73n test inside a
mostly-relevant file, and one DEFER-73Q xfail. Highest-yield mechanical batch
in the audit. Done first to shrink the suite and reduce daemon-cascade noise
in subsequent batches.

**Audit refs:**
[`post-cf-rebuild-py-test-audit-7-may-26.md`](../post-cf-rebuild-py-test-audit-7-may-26.md)
§Sweep-deletes, §RETIRE-V2, §STALE-73N, §Defer to 73q, §Skip inventory.

**Verify command:** `cd graph-editor && venv/bin/pytest --ignore=lib/tests/test_cohort_factorised_outside_in.py --tb=short -q lib/tests/`

**Touches:** test files only + 1 plan doc edit (73q phase 4 acceptance).
No runtime change.

**Predicted Δ:** -26 fails (76 → 50). Skip count drops by ~70 as tombstone
files leave the collection.

---

## Rows

| ✓ | Conf | Risk | Target | Action | Rationale |
|---|------|------|--------|--------|-----------|
| [ ] | H | M | `graph-editor/lib/tests/test_v2_v3_parity.py` | Delete entire file | RETIRE-V2 per user directive ("anything related to parity with v2,v1 cohort maturity we can now retire"). 12 fails, 5 skips, 0 keepers. Audit §RETIRE-V2: "delete the entire file ... none of its assertions encode anything not already in `test_cohort_factorised_outside_in.py` or the `test_cohort_maturity_v3_contract` contract." |
| [ ] | H | M | `graph-editor/lib/tests/test_v2_v3_parity_outside_in.py` | Delete entire file | Same RETIRE-V2 reasoning. 3 real-residue fails after isolation but file is irrelevant once v2 goes. |
| [ ] | H | M | `graph-editor/lib/tests/test_carrier_object_contract.py` | Delete the 11 tests that import `from runner.carrier_composition` (defs at lines 184, 254, 293, 355, 382, 450, 493, 512, 529, 550, 581). Keep the 4 tests at lines 115, 135, 156, 228 that don't reference the deleted module. File stays at current name. | STALE-73N. `runner/carrier_composition.py` deleted by commit `e15e9a9b` (4-May-26). Audit option (a) recommends moving the 4 keepers to `_v3.py` and deleting; we propose the simpler in-place pruning to avoid a rename. The 4 keepers' tests still describe carrier object contract semantics — file name remains accurate. |
| [ ] | H | L | `graph-editor/lib/tests/test_primitive_readout.py`, `test_multi_hop_window_readout.py`, `test_multi_hop_subject_readout.py`, `test_stage_8_substrate_provenance.py` | Delete all four entire files | Pure tombstones — every test is `@pytest.mark.skip`. Audit §Skip inventory: "should be deleted outright, not kept as `@pytest.mark.skip` farms." Risk:L because deletion removes 0 active coverage. | ***yes, but WHAT DID THEY DO***
| [~] | M | H | `graph-editor/lib/tests/test_active_cohort_carrier_readout.py` | Delete entire file | TOMBSTONE under 73n with 16 OBSOLETE skips + **1 live source-import guard** (test 17). Audit groups it with the other four tombstones for outright deletion, but losing the live guard is a real coverage cost. Held by default — pick: (a) delete whole file per audit; (b) keep file, delete only the 16 skipped tests, leave the source-import guard; (c) drop entirely from this batch. | ***WHAT IS 'LIVE GUARD'??? YOU HAVEN'T PROVIDED CONTEXT ***
| [ ] | H | M | `graph-editor/lib/tests/test_subject_span_cdf_ownership.py:131` | Delete only `test_per_draw_cdf_variation_drives_is_separation` (single test). Keep 11 sibling tests. | STALE-73N. Already documented in [`cohort-outside-in-post-73n-regression-tracker.md`](../cohort-outside-in-post-73n-regression-tracker.md) §"Stale-architecture test". 73n stage-9 deliberately removed conditioning from the trajectory engine; assertion that `n_cohorts_conditioned == 1` is now wrong-by-design. | ***WHAT ARE YOU TALKING ABOUT? THE ENGINE _DOES_ CONDITION_. YOU ARE MAKING THIS UP. ***
| [ ] | H | M | `graph-editor/lib/tests/test_cohort_maturity_v3_projection_contract.py:212` | Add `@pytest.mark.xfail(strict=False, reason="73q projection reducer pending — clears at phase 4")` to `test_v3_fan_widens_through_epoch_b` | DEFER-73Q. File docstring explicit: "Authored against the desired contract, not the existing implementation. Until the projection reducer lands these tests are expected to fail — that is the point." |
| [ ] | H | L | `docs/current/project-bayes/73q-daily-conversions-shared-runtime-cutover-plan.md` Phase 4 acceptance (line 208 onward) | Add bullet: "`test_cohort_maturity_v3_projection_contract::test_v3_fan_widens_through_epoch_b` flips to passed (xfail clears once the projection reducer is wired)" | Cross-reference for audit's "add a clearance line to 73q phase 4 acceptance". Ensures the xfail is paired with a concrete clearance commitment, not silently parked. |

---

## Open questions (record decision before proceed)

1. **Active-cohort tombstone — option a/b/c?** See row 5. Held by default. The
   16 OBSOLETE skips are clearly dead; the live source-import guard's value
   depends on whether the import it guards is exercised elsewhere. A 30-second
   read of the live test would settle it; flagged for explicit user call.

2. **Carrier object contract — in-place prune vs `_v3.py` rename?** Audit
   prefers the rename; this manifest proposes in-place prune (no rename) on
   the grounds that the file name still describes the surviving 4 tests
   accurately and that renames carry import-update risk for no semantic gain.
   Default action is in-place prune.

3. **Commit shape — one or many?** Default: one commit per row group:
   - Commit 1: RETIRE-V2 files (rows 1–2)
   - Commit 2: STALE-73N pruning (rows 3, 6) and tombstone deletes (row 4 +
     possibly 5)
   - Commit 3: DEFER-73Q xfail + 73q clearance line (rows 7–8)
   Splits cleanly along category lines; each commit is independently
   revertable. Override by saying "single commit" or "per-row commits".

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this batch, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch A` and the agent will execute only `[ ]`
rows, run the verify command, and append the verify-run section below.

---

## Verify run — pending
