# Phase 2 / Batch N — skip-inventory cleanup

**Cluster:** the 109-test skip burden the audit catalogues at [`post-cf-rebuild-py-test-audit-7-may-26.md:199`](../post-cf-rebuild-py-test-audit-7-may-26.md#L199). Phase 1 Batch A3 already deleted the five whole-file tombstones; this batch cleans up the residual skip-farm markers inside otherwise-live files plus decides the fate of one whole-file pre-existing skip.

**Audit refs:** [`post-cf-rebuild-py-test-audit-7-may-26.md:199-220`](../post-cf-rebuild-py-test-audit-7-may-26.md#L199).

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_composed_cache.py \
  lib/tests/test_prefix_arrival.py \
  lib/tests/test_primitive_conditioning.py \
  lib/tests/test_primitive_cache.py \
  lib/tests/test_doc31_parity.py \
  lib/tests/test_bayes_cohort_maturity_wiring.py
```

**Touches:** test files only — delete OBSOLETE skip-marked blocks (and their test bodies) plus possibly one whole-file deletion pending coverage check.

**Predicted Δ:** zero fail change (skips are not failures). Skip count reduction: -12 from skip-farm deletions (8 + 2 + 1 + 1) + possibly -24 from whole-file `test_bayes_cohort_maturity_wiring.py` deletion if coverage audit clears it. Total: -36 skips out of the 109 in scope. Signal-to-noise improvement, not a fail-count change.

---

## Per-file verdicts

| ✓ | Conf | Risk | File | Skipped tests | Action | Rationale |
|---|------|------|------|---------------|--------|-----------|
| [ ] | H | L | `test_composed_cache.py` | 8 (one class-level `@pytest.mark.skip`) | **Delete** the skipped class entirely (the 8 tests inside it). Class-level skip reason is explicit: *"OBSOLETE: every test in this class drives `compose_carrier_to_x` from the deleted `runner/carrier_composition.py` module. The 73n CF generalisation (commit e15e9a9b) removed that module entirely."* | Same shape as Phase 1 Batch A3 deletions — module gone, tests pin gone-by-design API. The 7 surviving tests in the file are not in scope. |
| [ ] | H | L | `test_prefix_arrival.py` | 2 (two `@pytest.mark.skip`s at lines 311, 437) | **Delete** both skipped tests. Reasons: *"OBSOLETE: references the deleted `compose_carrier_to_x` symbol on `runner.prefix_arrival`"* and *"OBSOLETE: compares `arrival_weight[X]` to the deleted `compose_carrier_to_x` deterministic_cdf oracle"*. | Same as above. The 13 surviving tests stay. |
| [ ] | H | L | `test_primitive_conditioning.py` | 1 (`@pytest.mark.skip` at line 786) | **Delete** the skipped test. Reason: *"OBSOLETE under 73n DrawFamilyKey v2 (Atom 2): scenario_seed was deliberately dropped from canonical_string — see runner/primitives.py:146-149."* | Test pins a property the 73n design explicitly retired. Cf. `test_primitive_contract.py::test_different_draw_family_keys_produce_independent_draws` (Batch K) which pins `scenario_id` participation in the digest — the surviving contract. |
| [ ] | H | L | `test_primitive_cache.py` | 1 (`@pytest.mark.skip` at line 222) | **Delete** the skipped test. Same reason as above (73n DrawFamilyKey v2 deliberately dropped scenario_seed from cache key). | Same. |
| [—] | H | L | `test_doc31_parity.py` | 2 (conditional `pytest.skip()` calls at lines 76, 80, 117, 146 — env/data availability gates) | **Keep**. These are legitimate env-gate skips (data repo not available, fixture not present). Not skip-farm OBSOLETE markers. | Conditional skips on data availability are correct; deletion would silently break the test in environments where the data repo is absent. |
| [~] | M | M | `test_bayes_cohort_maturity_wiring.py` | 24 (whole-file `pytestmark = pytest.mark.skip` at line 17) | **HOLD — coverage audit needed**. Pre-existing whole-file skip per audit: *"forensic review … pre-span-kernel overlay contract"*. Audit recommendation: *"with outside-in green and 73q's `rate_by_cohort` reducer landing soon, this file's contract is now covered structurally elsewhere; recommend retiring after a one-pass coverage audit"*. Action: read the file's test list (24 tests) and check each against `test_cohort_factorised_outside_in.py` + `test_cohort_maturity_v3_contract.py` for coverage equivalence. If covered → delete file. If not → either un-skip and fix, or keep skipped with a tighter reason. | The "outside-in green and 73q reducer landing soon" condition is what gates this. Out of scope for a recipe-style batch — this is a 30-minute coverage walk before the deletion can be safely landed. |

---

## Refactoring plan

Two commits + one held investigation:

1. **Skip-farm deletions** (rows 1–4 collapsed): remove the 12 OBSOLETE-marked tests across `test_composed_cache.py`, `test_prefix_arrival.py`, `test_primitive_conditioning.py`, `test_primitive_cache.py`. For each, also remove orphan helpers / imports that supported only the deleted tests; check the `@pytest.mark.skip` block's surrounding helpers don't reach into other tests in the same file.

2. **No edit to `test_doc31_parity.py`** — env-gated conditional skips stay.

3. **Coverage audit on `test_bayes_cohort_maturity_wiring.py`** (HOLD). Read the 24 test docstrings, map each contract to its sibling pin in the live oracle / contract files, decide retire-vs-revive. Fits a separate task — not part of the closing rerun.

---

## Open questions

1. **Aggressiveness of skip-farm deletion vs un-skip-and-rewrite.** All 12 skipped tests are explicitly OBSOLETE under 73n; their substantive intent is gone-by-design, not deferred. Default: delete. If user wants any of the contracts re-pinned against the new API, do it as a follow-up rewrite — but those should be new tests authored against the surviving substrate, not resurrected skip-farm bodies that reference deleted modules.

2. **`test_bayes_cohort_maturity_wiring.py` coverage walk — in this batch or a follow-up?** Default: follow-up. The walk requires reading 24 test bodies + cross-checking against the outside-in oracle's coverage map; it's not mechanical. This batch closes with the file's whole-file skip untouched.

3. **Tombstone file deletions already landed in Phase 1 Batch A3** (`test_active_cohort_carrier_readout.py`, `test_primitive_readout.py`, `test_multi_hop_window_readout.py`, `test_multi_hop_subject_readout.py`, `test_stage_8_substrate_provenance.py`) closed -66 of the original 109 skips. This batch closes another -12 (and possibly -24). Net skip burden post-Batch-N: 31 (or 7 if `test_bayes_cohort_maturity_wiring.py` retires). Mostly conditional env-gates after that.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- `[—]` no action by design (kept as-is)
- Strikethrough — drop from scope entirely

After review, type `proceed batch N` and the agent will execute rows 1-4 (skip-farm deletions), open the row 6 coverage walk as a separate task, run the verify command, and append the verify-run section.

---

## Verify run — pending
