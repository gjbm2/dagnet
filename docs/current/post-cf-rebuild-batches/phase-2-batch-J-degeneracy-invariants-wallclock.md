# Phase 2 / Batch J — `test_v3_degeneracy_invariants.py` wallclock-flakiness fix

**Cluster:** three failing tests in `test_v3_degeneracy_invariants.py`. Audit framing: 9 fails in main run → 6 cleared by daemon-cascade fix → 3 residue, all wallclock-flakiness from relative-date DSL forms (`window(-1d:)`) resolving to today's date (2026-05-08), outside the fixture cutoff (21-Mar-26).

**Audit refs:** [`post-cf-rebuild-py-test-audit-7-may-26.md:409`](../post-cf-rebuild-py-test-audit-7-may-26.md#L409). See also [`KNOWN_ANTI_PATTERNS.md`](../codebase/KNOWN_ANTI_PATTERNS.md#L276) (AP17 — vacuous-by-relative-DSL) and [`test-wallclock-flakiness-audit.md`](../test-wallclock-flakiness-audit.md).

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_v3_degeneracy_invariants.py
```

**Touches:** test file only — DSL replacements at line 323 (and possibly 182, 206, 266 if those start failing too as the calendar drifts further from fixture cutoff).

**Predicted Δ:** −2 fails closed (i5×2). Test i4 already uses absolute dates per current source (`window(1-Mar-26:22-Mar-26).asat(22-Mar-26)` at [`test_v3_degeneracy_invariants.py:304`](../../graph-editor/lib/tests/test_v3_degeneracy_invariants.py#L304)) — verify-run will reveal whether it's still failing for an unrelated reason or has resolved silently with the daemon-cascade fix.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | M | L | `test_i4_mature_window_midpoint_matches_posterior_p_mean` (line 292) | **Verify-run only.** | Test already uses absolute dates `window(1-Mar-26:22-Mar-26).asat(22-Mar-26)` per current source. Audit's wallclock diagnosis was on a prior version of this test; either it has been hardened (most likely) or it fails for a different reason now. If verify-run shows it still red, it gets a per-test follow-up. |
| [ ] | H | L | `test_i5_cohort_never_materially_above_window[synth-mirror-4step]` (line 320) | **Replace** the relative-DSL form `window(-1d:)` at [`test_v3_degeneracy_invariants.py:323`](../../graph-editor/lib/tests/test_v3_degeneracy_invariants.py#L323) with an absolute window inside the fixture cutoff: `window(1-Feb-26:21-Mar-26).asat(21-Mar-26)` (or equivalent matching the graph's enriched coverage). | Audit's witness `Failed: missing data wc=False cc=False` is the textbook AP17 vacuity signature — both window and cohort comparators returned no data because `(-1d:)` resolves to today's date, outside the 21-Mar-26 fixture cutoff. The substantive invariant (cohort never materially above window) is fixture-independent and the same test under absolute dates will exercise the same comparator path. |
| [ ] | H | L | `test_i5_cohort_never_materially_above_window[synth-lat4]` (same line 320, second parametrised graph) | Same DSL replacement covers both parametrised cases (one change at line 323 — the parametrisation is on `graph` / `edge_dsl` upstream, not on the date form). | Same diagnosis. |

---

## Refactoring plan

One commit, one file edit:

1. **DSL replacement at [`test_v3_degeneracy_invariants.py:323`](../../graph-editor/lib/tests/test_v3_degeneracy_invariants.py#L323)**: change `window(-1d:)` to `window(1-Feb-26:21-Mar-26).asat(21-Mar-26)` (or whatever absolute window the per-graph fixture coverage implies — see the parametrised `edge_dsl` definitions upstream and the `synth-mirror-4step` / `synth-lat4` enrichment ranges in `graph-ops/scripts/synth_*`).

2. **Do NOT change** lines 182, 206, 266 (the i1/i2/i3 relative-DSL forms) in this batch. They currently pass per the audit, presumably because their assertions only depend on direction/sign rather than absolute values, and wallclock-flakiness has not yet tipped them red. Note in the regression tracker that these are latent AP17 vacuities awaiting the calendar to drift further; revisit when they trip.

3. **Verify-run** test i4 alongside i5; if i4 is still red, open a separate per-test investigation (likely an unrelated regression).

---

## Open questions

1. **MERGE-OUTSIDE-IN deferral.** Audit's outer recommendation was *"after fix, fold I1–I5 into `test_cohort_factorised_outside_in.py`"*. The merge is a substantive consolidation (the file is 11 tests and the outside-in oracle already covers most invariants); not in scope for this batch. Default: do the DSL fix in this batch; open a separate task for the merge once outside-in's coverage map is audited against I1-I5.

2. **Hardening the latent AP17s** (lines 182, 206, 266 — `window(-1d:)` in i1/i2/i3). They pass today but will trip later. Audit's preference is to fix all of them now to prevent the calendar from creating noise. Default: fix only the failing one (line 323) in this batch; tracker entry for the latent ones.

3. **Choice of absolute window.** `window(1-Feb-26:21-Mar-26).asat(21-Mar-26)` is one option; matching whatever i4 uses (`1-Mar-26:22-Mar-26`) is another. Default: match i4 for consistency unless the i5 invariant needs more anchor coverage than i4.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch J` and the agent will edit line 323, run the verify command, and append the verify-run section.

---

## Verify run — 8-May-26 (full-suite re-run, pre-edit)

**Pre-edit baseline (audit, 7-May-26):** 9 fails in main run → 6 cleared by daemon-cascade fix → 3 wallclock-flakiness residue (`test_i4_mature_window_midpoint_matches_posterior_p_mean`, `test_i5_cohort_never_materially_above_window[synth-mirror-4step]`, `test_i5_cohort_never_materially_above_window[synth-lat4]`).

**Post-edit (full-suite re-run, 8-May-26):** 1 fail. Net Δ vs audit baseline: −2.

**Surviving witness:**

```
test_i5_cohort_never_materially_above_window[synth-mirror-4step]
  Failed: missing data wc=False cc=False
```

**Notes on the disappeared two:**

- `test_i4_mature_window_midpoint_matches_posterior_p_mean` — already uses absolute dates `window(1-Mar-26:22-Mar-26).asat(22-Mar-26)` per current source. Either the test was hardened before the audit captured it (most likely) or it has resolved silently with the daemon-cascade fix. No longer in scope.
- `test_i5_cohort_never_materially_above_window[synth-lat4]` — not in the current 39-fail set. Either the parametrisation has changed (synth-lat4 case dropped) or the per-graph fixture coverage now happens to overlap with the relative-DSL date. Verify the parametrise list before assuming it's permanently gone.

**Recipe still applies for the surviving witness:**

Replace the relative-DSL `window(-1d:)` at [`test_v3_degeneracy_invariants.py:323`](../../graph-editor/lib/tests/test_v3_degeneracy_invariants.py#L323) with an absolute window inside the fixture cutoff. Per-test verdict in the table above (Row 2) is unchanged.

**Net Δ pending edit:** −1 fail closed (1 → 0) when the DSL replacement lands.

