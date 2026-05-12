# Phase 2 / Batch B — `metadata.model_curves` rewrite

**Cluster:** Three test files assert on the deleted `result.metadata.model_curves`
container. The runtime now exposes the same information at `result.source_model_curves`
(top-level, same dict-of-source shape) and on every maturity row as
`model_curve_midpoint` / `model_curve_fan_upper` / `model_curve_fan_lower`.
Mechanical recipe — no runtime change.

**Audit refs:**
[`post-cf-rebuild-py-test-audit-7-may-26.md`](../post-cf-rebuild-py-test-audit-7-may-26.md)
§STALE-CONTRACT — `metadata.model_curves` cluster (9 tests across three files);
per-file entries for `test_cohort_maturity_model_parity.py`,
`test_cohort_maturity_no_evidence.py`, `test_cohort_maturity_no_evidence_truth.py`.

**Verify command:**
```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_cohort_maturity_model_parity.py \
  lib/tests/test_cohort_maturity_no_evidence.py \
  lib/tests/test_cohort_maturity_no_evidence_truth.py
```

**Touches:** test files only — three files, no runtime, no fixtures, no goldens.

**Predicted Δ:**
- Standalone (against current 76-fail baseline): **76 → 67 fails**.
- After Batch A lands first (50-fail baseline): **50 → 41 fails**.
- All nine fail/error events in this cluster clear; no new failures expected.

**Daemon contention:** None. All three files use `requires_python_be` (HTTP to
`dev-server.py`) but none import `_daemon_client` or call `analyse.sh`.
Direct-Python eligible — Phase 2 parallelism rule applies if the user wishes to
run Batch B alongside another non-daemon Phase 2 batch.

**Prerequisite:** `dev-server.py` up on `:9000` (per the audit's §Test infra
issue 1 — without the BE the suite silently skips these tests). Verify command
will not produce useful signal otherwise.

---

## Recipe — applied identically to each row

The deleted shape and the current shape are isomorphic on the dimensions these
tests use:

| Old (deleted) | New (current) |
|---|---|
| `result.metadata.model_curves` (dict of source → entry) | `result.source_model_curves` (same dict-of-source shape) |
| `entry.curve` — list of `{tau_days, model_rate}` | `entry.curve` — same shape, same key names |
| `entry.bayesBandUpper` / `entry.bayesBandLower` | `entry.band_upper` / `entry.band_lower` (renamed, same `[{tau_days, model_rate}]` shape) |
| `entry.promotedSource` / `metadata.promoted_source` | `result.promoted_source` (top-level) |
| `entry.sourceModelCurves` (per-source nested dict) | `result.source_model_curves` IS that dict directly (one level of nesting flattened) |

Per-row alternative for τ-aligned midline checks: `row.model_curve_midpoint`
(set per row at [`cohort_forecast_v3.py:4102`](../../graph-editor/lib/runner/cohort_forecast_v3.py#L4102))
gives the promoted-overlay model rate at that τ directly — preferable when the
test is iterating rows anyway, because it avoids the per-source key lookup.
Sibling fan fields: `model_curve_fan_upper` / `model_curve_fan_lower`.

In-repo precedent — both shapes are already exercised by green tests on this
branch:

- `test_bayes_cohort_maturity_wiring.py` reads `result.get("source_model_curves", {})`
  with per-source key (file is currently whole-file-skipped pending forensic
  review per audit §Skip inventory, but the shape it reads is current).
- `test_cohort_maturity_v3_contract.py` reads `row['model_curve_midpoint']`
  directly per row at lines 1085, 1114, 1115, 1127.

---

## Rows

| ✓ | Conf | Risk | Target | Action | Rationale |
|---|------|------|--------|--------|-----------|
| [ ] | M | L | `graph-editor/lib/tests/test_cohort_maturity_model_parity.py:139-189` (`test_main_midline_matches_promoted_overlay`, 4 parameterised cases) | Replace `metadata.model_curves[entry_key]` reads (lines 146–155) with `result.source_model_curves[entry_key]` (top-level), and `entry.bayesBandUpper`/`bayesBandLower` with `entry.band_upper`/`band_lower`. Replace `entry.sourceModelCurves` (line 174) with the top-level `result.source_model_curves` dict directly. The per-row midline (`row.model_midpoint`) and per-row promoted overlay (`row.model_curve_midpoint`) are unchanged in name and shape. | Audit §`test_cohort_maturity_model_parity.py`: STALE-CONTRACT, "rewrite the assertion against per-row `model_curve_midpoint` (or `result.source_model_curves`) instead of `metadata.model_curves`". 4 fails clear. The test's intent (main midline agrees with promoted overlay τ-by-τ) is preserved verbatim — only the field address moves. |
| [ ] | M | L | `graph-editor/lib/tests/test_cohort_maturity_no_evidence.py:125-189` (`test_cohort_maturity_no_evidence_collapse`, 4 parameterised cases) | Replace `metadata.model_curves` lookup at line 136 with `result.source_model_curves`. Replace `first_curve_entry.curve` extraction (lines 140–147) with read from `entry.curve` (key name unchanged). Alternative simpler form: skip the source dict entirely and read `row.model_curve_midpoint` per row, since the test's eligible-row loop already iterates `rows` and only needs the τ→overlay mapping. | Audit §`test_cohort_maturity_no_evidence.py`: STALE-CONTRACT, same recipe as model_parity. 4 fails clear. Intent (midpoint, model_midpoint, overlay coincide on no-evidence boundary) preserved. |
| [ ] | M | L | `graph-editor/lib/tests/test_cohort_maturity_no_evidence_truth.py:130-220+` (single test) | Same recipe — replace `metadata.model_curves` (line 156) with `result.source_model_curves`, then `next(iter(model_curves.values())).curve` becomes `next(iter(source_curves.values())).curve` (key name unchanged inside the entry). | Audit §`test_cohort_maturity_no_evidence_truth.py`: STALE-CONTRACT + MERGE-OUTSIDE-IN. 1 fail clears. Intent (public chart equals analytic p×CDF(τ)) preserved. |

---

## Out of scope for this batch

- **`MERGE-OUTSIDE-IN` fold-in** — audit's follow-up call: once green, fold the
  per-row midline parity / no-evidence boundary / analytic truth assertions into
  `test_cohort_factorised_outside_in.py` and retire these three files. That
  step touches the oracle file, alters its wallclock budget, and needs a
  session-scoped daemon plan — properly Phase 3 / solo-careful work, not a
  recipe batch. Tracked as a follow-up pointer, executed only after Batch B
  verifies green.
- **`metadata.promoted_source` reads in *other* files** — out of scope unless
  surfaced by the verify command. Those tests are already green (the `metadata`
  block was not deleted wholesale, only `metadata.model_curves` specifically).
- **Renaming `entry.bayesBandUpper`/`bayesBandLower` consumers in non-test code**
  — audit §STALE-CONTRACT: this is a test-side rewrite only. The runtime
  `band_upper`/`band_lower` keys are the canonical names since 73n; no FE/runtime
  edits needed.

---

## Open questions (record decision before proceed)

1. **Per-row midline vs source-curve lookup — which form for the recipe?**
   Both are equivalent for τ-aligned midline checks. Per-row form
   (`row.model_curve_midpoint`) is shorter and matches `test_cohort_maturity_v3_contract.py`
   precedent; source-curve form (`result.source_model_curves[k].curve`) is the
   minimal mechanical change from the deleted shape and matches
   `test_bayes_cohort_maturity_wiring.py` precedent. **Default: per-test
   preference of whichever produces the smaller diff.** Override by saying
   "use per-row form everywhere" or "use source-curve form everywhere".

2. **Bands check in `test_cohort_maturity_model_parity.py`**: the existing
   bands gate (line 170) uses `bayesBandUpper`/`bayesBandLower`. The new
   `band_upper`/`band_lower` fields are only populated when the source has SDs
   available (`band_mu_sd > 0` at [`api_handlers.py:3846`](../../graph-editor/lib/api_handlers.py#L3846)).
   The test's existing four cases may not all exercise a source-with-SDs;
   if any case now skips the band-population branch, the gate at line 170
   becomes false-positive. **Default: keep the gate; if any of the four
   cases newly fails the bands check, mark that case `[~]` and triage in a
   follow-up.** Override by saying "drop the bands gate".

3. **Commit shape — one or three?** Default: one commit per cluster
   ("rewrite metadata.model_curves reads against current source_model_curves
   shape — Batch B"). Splits cleanly along category lines but doesn't help
   bisect. Override by saying "per-file commits".

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold — skip this row, revisit at end of phase
- Strikethrough — drop from scope entirely

After review, type `proceed batch B` and the agent will execute only `[ ]`
rows, run the verify command, and append the verify-run section below.

The agent will read each test's specific assertion semantics (the recipe
table above is generic; per-test mapping requires a brief read) before
applying the rewrite. If any test's intent does not map cleanly onto the
new shape — e.g. if the test was leaning on a feature of `metadata.model_curves`
that genuinely no longer exists rather than just being relocated — the row
is converted to `[~]` and the rationale recorded under §Open questions for
user call before the commit lands.

---

## Verify run — 8-May-26

**Pre-edit baseline (audit, 7-May-26):** 9 fails across the three files (4 + 4 + 1) — all with the `metadata.model_curves missing` shape.

**Post-edit (full-suite re-run, 8-May-26):** 9 fails still RED — but **the failure shape has changed**. Wiring fix landed (tests now read `row.model_curve_midpoint` rather than `metadata.model_curves`); the failures now report substantive value drift rather than missing-shape errors:

```
test_main_midline_matches_promoted_overlay[window_single_hop]
  midline differs from overlay at 6 τ (worst: τ=20, rel=3.28%)
  — overlay path CDF diverges from main chart sweep

test_cohort_maturity_no_evidence_collapse[window_single_hop]
  tau=15: fan_lower=0.000289 != model_fan_lower=0.000198

test_no_evidence_curve_matches_truth_analytic
  tau=7: midpoint=0.00182 vs expected=0.00302 (~40% gap on early-τ tail)
```

**Final actions taken:**

- Wiring rewrite landed across all three files (`row.model_curve_midpoint` reads, `--display '{"show_model_curve":true}'` flag added where the public surface needed it). Substantive change of address, not behaviour.
- 9 fails closed at the wiring level; 9 different fails opened at the substantive value-drift level (same test names, different witnesses).
- These nine post-wiring substantive fails have been **folded into Cluster A — Display-side residual** in [`cohort-outside-in-post-73n-regression-tracker.md`](../cohort-outside-in-post-73n-regression-tracker.md) under a new subsection *"Additional canary surfaces confirmed 8-May-26"*. Same root cause as the existing chart `evidence_y` divergence: rate-attributed Y-prefix used as evidence-named field. Closure depends on the y-prefix substitution per the existing adapter plan.
- Net Δ on fail count: **0** (9 → 9, witness type changed but count unchanged). Net Δ on signal quality: **+9 substantive canaries** for the y-prefix residue, replacing 9 wiring artefacts.

