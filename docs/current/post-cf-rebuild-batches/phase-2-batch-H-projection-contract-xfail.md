# Phase 2 / Batch H — `test_cohort_maturity_v3_projection_contract.py` xfail

**Cluster:** one failing test in `test_cohort_maturity_v3_projection_contract.py`. The whole file's docstring is explicit: *"Authored against the desired contract, not the existing implementation. Until the projection reducer lands these tests are expected to fail — that is the point. The failures pin what the new projection has to deliver."*

**Audit refs:** [`post-cf-rebuild-py-test-audit-7-may-26.md:279`](../post-cf-rebuild-py-test-audit-7-may-26.md#L279) — DEFER-73Q.

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_cohort_maturity_v3_projection_contract.py
```

**Touches:** test file only (one decorator added). No runtime change.

**Predicted Δ:** −1 fail (xfail does not count as failure under default pytest config; treated as "expected" outcome).

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | H | L | `test_v3_fan_widens_through_epoch_b` | **Mark xfail** with `strict=False, reason="73q projection reducer pending — fan-widening invariant deliverable per cohort-maturity-selected-cohort-projection-pattern.md"`. | File docstring explicitly says these tests are forward-spec for the unlanded projection reducer. Test asserts fan width opens monotonically from `tau_solid_max` to first local max then peaks > 0.003; current rate-draws projection produces a flat-zero or shrinking fan past the seam. The substantive intent (fan widens past the seam) is the 73q deliverable. xfail with `strict=False` so the test flips to `XPASS` (without erroring) when the reducer lands and the contract starts holding. |
| — | — | — | `test_v3_midpoint_meets_evidence_at_seam` | (not failing — skipped by `requires_*` gates in the audit run) | Same docstring forward-spec; will fail under default config when gates pass. Apply same xfail when it runs. |
| — | — | — | `test_v3_projection_stays_within_unit_interval` | (not failing — skipped by `requires_*` gates in the audit run) | Same. |
| — | — | — | `test_v3_undefined_denominator_emits_none_not_zero` | (not failing — skipped by `requires_*` gates in the audit run) | Same. |

---

## Refactoring plan

One commit + one clearance line in 73q:

1. **Add xfail decorator** to `test_v3_fan_widens_through_epoch_b` at [`test_cohort_maturity_v3_projection_contract.py:212`](../../graph-editor/lib/tests/test_cohort_maturity_v3_projection_contract.py#L212):
   ```
   @pytest.mark.xfail(
       strict=False,
       reason="73q projection reducer pending — see "
              "cohort-maturity-selected-cohort-projection-pattern.md",
   )
   ```
   Audit recommends the same shape for the other three tests if/when they un-gate; defer until they actually run.

2. **Clearance hook** — add a one-line acceptance criterion to the 73q plan (or successor atom): *"`test_v3_fan_widens_through_epoch_b` flips XFAIL → XPASS once the selected-cohort projection reducer lands"*. The plan file is [`docs/current/cohort-maturity-selected-cohort-projection-pattern.md`](../cohort-maturity-selected-cohort-projection-pattern.md) (per the file's own companion-docs list at line 19).

---

## Open questions

1. **Apply xfail to the three `requires_*`-gated tests too?** Audit says yes; default here is no, since they don't currently fail (the gate skips them). When the gates pass under different infra, they will fail and we'll xfail them then. Reduces forward churn.

2. **Pin xfail to a specific 73q stage acceptance line?** Default: yes — find the 73q stage that owns the projection reducer and add the clearance there. Without the pin, the xfail risks living forever.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch H` and the agent will add the xfail decorator, find the 73q clearance line (or open the question if no current 73q stage owns the reducer), run the verify command, and append the verify-run section.

---

## Verify run — pending
