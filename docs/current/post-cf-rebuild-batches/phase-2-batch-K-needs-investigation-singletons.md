# Phase 2 / Batch K — four NEEDS-INVESTIGATION single-fail rows

**Cluster:** four unrelated test files, one fail each. Audit grouped them as NEEDS-INVESTIGATION because each requires a source-side trace before deciding whether the failure is a real defect, a stale contract, or a test bug. None reduce to a mechanical rewire.

**Audit refs:**
- [`post-cf-rebuild-py-test-audit-7-may-26.md:332`](../post-cf-rebuild-py-test-audit-7-may-26.md#L332) — `test_funnel_contract` (1 fail)
- [`post-cf-rebuild-py-test-audit-7-may-26.md:350`](../post-cf-rebuild-py-test-audit-7-may-26.md#L350) — `test_lag_fields` (1 fail)
- [`post-cf-rebuild-py-test-audit-7-may-26.md:372`](../post-cf-rebuild-py-test-audit-7-may-26.md#L372) — `test_primitive_contract` (1 fail)
- [`post-cf-rebuild-py-test-audit-7-may-26.md:387`](../post-cf-rebuild-py-test-audit-7-may-26.md#L387) — `test_stage1_be_topo_removal_pinning` (1 fail)

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_funnel_contract.py \
  lib/tests/test_lag_fields.py \
  lib/tests/test_primitive_contract.py \
  lib/tests/test_stage1_be_topo_removal_pinning.py
```

**Touches:** depends on per-row outcome — at most 4 small test edits + possibly 1 source fix (stage1 BE-topo token reappearance). Each row decided independently.

**Predicted Δ:** unknown without per-row source-side trace. Best case: −4 fails (all stale-contract or test-bug). Worst case: −1 fails + 3 RED canaries opened in tracker for real defects.

---

## Per-test verdicts

| ✓ | Conf | Risk | Test | Action | Rationale |
|---|------|------|------|--------|-----------|
| [ ] | M | L | `test_funnel_contract.py::TestF4FModeMatchesPathProductOfPromotedMeans::test_f_median_matches_path_product_of_evidence_means` (line 265) | **Defer to 73q-5b**. Open a tracker entry naming witness (`f-mode stage-N bar 0.006481 ≠ Π epistemic means 1.0`) and the audit's hint that the fixture's per-stage epistemic means being all `1.0` makes the assertion vacuous unless f-mode reduction also produces per-stage 1s. Test stays RED until 73q-5b's funnel regression coverage lands. | Audit wording: *"either the fixture is no longer well-formed (test bug) or the f-mode reduction has changed (contract). 73q phase 5b explicitly schedules funnel regression coverage; this file's contract is in scope there."* The `1.0` expected value is suspicious enough that fixing the test outside 73q-5b risks masking either side of the diagnosis. |
| [ ] | M | M | `test_lag_fields.py::test_build_graph_with_lag_fields` (line 101) | **Per-test trace**. Read the test's input fixture, then trace `_extract_evidence` / `_extract_forecast` blend-mean derivation. If the new blend coefficient is intentional (contract drift), update the expected value `0.72 → 0.75` (or whichever side moved); if unintentional, file a tracker entry. | Audit: *"`assert 0.75 == 0.72` (blended mean). One-line discrepancy. Cheap to triage; could be coefficient change or propagation through `_extract_evidence` / `_extract_forecast`."* Cannot resolve from the audit's witness alone — the blend formula's current shape needs a source read. |
| [ ] | M | H | `test_primitive_contract.py::test_different_draw_family_keys_produce_independent_draws` (line 465) | **Per-test verify (likely real)**. Test constructs two `DrawFamilyKey`s with different `scenario_id` values (`"scn-A"` vs `"scn-B"`); all other fields default. Audit's diagnosis ("both empty `selected_anchor_days` tuples") confused which field varies — the test is varying `scenario_id`, not `selected_anchor_days`. If `DrawFamilyKey.digest` ignores `scenario_id`, that's a real regression in the digest function — a bug pinned exactly by this test's intent. Action: read `DrawFamilyKey.digest` source; verify it includes `scenario_id` in the SHA-256 input. If it doesn't, file as REAL-REGRESSION and fix the digest. If it does, the test is failing for a different reason and needs deeper trace. | Audit's recommendation was *"read the test's two-key construction. If the tuples are genuinely different and digests collide, real defect in key derivation."* My source read of [`test_primitive_contract.py:466-468`](../../graph-editor/lib/tests/test_primitive_contract.py#L466) shows the keys differ on `scenario_id`, not `selected_anchor_days` — the audit's assessment of the test was incorrect on which field was the discriminator. Real-regression candidate. |
| [ ] | M | M | `test_stage1_be_topo_removal_pinning.py::test_a1_topo_pass_tokens_absent_from_live_code` (line 79) | **Per-test source read**. Test greps for tokens `topo-pass` / `topoPass` / `beTopoPass` / `handle_stats_topo_pass` in lib/ and src/. Audit reported reappearance at [`fetchDataService.ts:2384`](../../graph-editor/src/services/fetchDataService.ts#L2384). Action: read that line and the surrounding context; classify as (a) real defect (token reappeared in live code path → remove it, possibly via a refactor), (b) benign reference (e.g. URL-parameter name like `?nobecf` that contains a substring match → tighten the regex), or (c) historical-comment-only (allow via the test's `_is_skip_path` allowlist). Do NOT silence the pin. | Audit: *"Doc 73b §5 Action A1 forbids this; the pinning test exists exactly to catch this drift."* The pin is structural; the right fix is at the source side or via a tightened allowlist, not by relaxing the pin itself. |

---

## Refactoring plan

Per-row, in this order (cheapest first):

1. **Row 4 (stage1 BE-topo pin)** — read `fetchDataService.ts:2384` ± 10 lines, decide source-fix or test-allowlist tighten. ~5 minutes.

2. **Row 3 (primitive_contract digest)** — read `DrawFamilyKey.digest` source. If digest hashes the dataclass via `__dict__` or canonical-fields tuple, `scenario_id` should be included; verify. If it's missing, fix the digest function (real regression). ~10 minutes.

3. **Row 2 (lag_fields blend mean)** — read test fixture + `_extract_evidence` / `_extract_forecast`; identify whether `0.72` vs `0.75` is contract drift or numerical noise. ~10 minutes.

4. **Row 1 (funnel f-mode)** — open tracker entry, defer to 73q-5b. No source read needed in this batch.

Each row produces either: (a) a one-commit fix + verify-run-passes, (b) a tracker entry + test stays RED, or (c) a kicked-up question for the user. Treat them independently — no shared dependency.

---

## Open questions

1. **Row 1 — defer or investigate now?** Default: defer. Audit says 73q-5b owns the funnel contract and a fix outside that pipeline risks masking the wrong half. If user wants to investigate now, drop the tracker entry and trace `e_mode` vs `f_mode` reduction on the fixture.

2. **Row 3 — does the audit's misread of which field varies change anything?** Default: yes — promotes this row from "ambiguous test bug vs real defect" to "real-defect candidate that the audit didn't catch". Worth flagging in the tracker entry if it does turn out to be a digest regression.

3. **Row 4 — token reappearance vs pin tightening.** Default: prefer source-side fix unless the offending line is genuinely benign (comment / URL parameter substring). The pin exists to enforce a doc 73b §5 invariant; weakening it loses signal.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch K` and the agent will execute each `[ ]` row in the order above, run the verify command, and append the verify-run section.

---

## Verify run — pending
