# Phase 2 / Batch D — `test_doc56_phase0_behaviours.py` cross-consumer agreement

**Cluster:** the three failing tests in [`graph-editor/lib/tests/test_doc56_phase0_behaviours.py`](../../graph-editor/lib/tests/test_doc56_phase0_behaviours.py). The audit's verdict was "STALE-CONTRACT — retire all three" on the grounds that the tests assert the inverse of the 73n contract (cohort/window convergence). **Verified from source 8-May-26: the audit is wrong.** The file's own opening docstring explicitly supersedes the doc56 phase-0 framing with doc 64 Family C cross-consumer agreement; per-test reads show the assertions match the 73n contract; the failures look like real defects, not stale tests.

**Recommendation: keep all three, open regression-tracker entries, no test edits in this batch.**

---

## Audit refs

[`post-cf-rebuild-py-test-audit-7-may-26.md:301-314`](../post-cf-rebuild-py-test-audit-7-may-26.md#L301).
Audit's wording: "asserts the inverse of the 73n contract … STALE-CONTRACT — retire all three. The intent that survives — *cross-consumer agreement on the unified primitive substrate* — is already canonically pinned by the outside-in oracle's `test_a_equals_x_identity_collapses_to_window` and `test_cohort_and_window_p_infinity_converge_for_same_subject_rate`."

The audit conflated two distinct claims:

- **Identity-carrier collapse** (A=X case): cohort and window converge because there's no cohort-rooted prefix to differentiate. Pinned by `test_a_equals_x_identity_collapses_to_window`.
- **Downstream A≠X separation**: cohort and window must differ on edges below the anchor because they have different denominators (window counts everyone-already-at-X; cohort counts anchor-rooted-cohorts-reached-X-by-tau).

The 73n unification flattened the primitive substrate but did not merge the two cases. Both contracts are still live. The audit's "convergence" cite (`test_cohort_and_window_p_infinity_converge_for_same_subject_rate`) is the A=X case only.

---

## Per-test verdicts

Verified by running each test individually 8-May-26 (file as a whole exceeds the 4-min CI budget; per-test runs take 18–23 s).

| ✓ | Conf | Risk | Test | Audit said | Source-of-truth verdict |
|---|------|------|------|------------|-------------------------|
| [ ] | H | H | `test_query_scoped_identity_carrier_collapses_public_evidence_basis` (line 442) | DELETE — asserts inverse | **KEEP — real defect**. Test asserts cohort/window **converge** under degraded identity-carrier seam (matches 73n direction). Observed: 6513.84 vs 6417.0, divergence ≈ 1.5%, beyond the default `pytest.approx` tolerance. Identity-carrier collapse is the 73n contract; failing it 1.5% is a real undercollapse. |
| [ ] | H | H | `test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split` (line 545) | DELETE — asserts inverse | **KEEP — real defect**. Test asserts cohort/window **diverge** on downstream A≠X edge (matches 73n direction — divergence is the contract on A≠X by topology). Observed: surprise_gauge `window_p["observed"] > cohort_p["observed"]` fails — split lost. Possibly the same y-side / model-curve collapse cluster the user flagged earlier. |
| [ ] | H | H | `test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split` (line 697) | DELETE — asserts inverse | **KEEP — real defect**. Same shape as 545, on the bayesian sidecar path. Observed: window/cohort asymptotes collapse on the bayesian synth chart; the test's NOTE explicitly describes this canary's purpose: "x-side separation can survive while the y-side sweep/model projection still inflates or inverts, which shows up as `model_midpoint` / `p_infinity_mean` collapse." |

The other 4 tests in the file (cf_and_v3 carrier-tier agreement, cf_p_mean parity, edge-reorder invariance, chart-and-daily-conversions split) currently pass per the audit; not in scope here.

---

## Why the audit was wrong

Three confounds:

1. **Stale framing tag**: the file is named `test_doc56_phase0_behaviours.py` after the original "doc 56 cut-over regression guard" framing. The file's own opening docstring (lines 1-62) explicitly **supersedes** that framing with doc 64 Family C ("Forecast cross-consumer agreement"). The audit read the filename and the historical purpose; the current substance had moved on.

2. **Single-direction reading of the 73n contract**: the audit cited convergence on A=X identity (correct) and assumed every cohort/window comparison should converge. The downstream A≠X case has different denominators by topology and is not subject to the unification.

3. **No live read of test bodies**: the three tests' docstrings and assertion shapes make the directional claim explicit (test 442 asserts equality; tests 545/697 assert strict ordering). A 30-second per-test read would have caught it; the audit applied a per-file label.

This is the third audit row in the post-cf-rebuild work that turned out to be wrong on per-test verification (after A1 RETIRE-V2 and A4 row 1 STALE-73N). Pattern: per-file verdicts that don't survive per-test reads.

---

## Refactoring plan

**No test edits.** Three regression-tracker entries:

1. **Identity-carrier collapse — degraded-cohort seam undercollapses by ~1.5%** ([`test_doc56_phase0_behaviours.py:442`](../../graph-editor/lib/tests/test_doc56_phase0_behaviours.py#L442)).
   - Witness: `evidence_x` at late taus (41, 44, 50, 65, 80) on `synth-mirror-4step` with `from(m4-delegated).to(m4-success)` differs cohort vs window.
   - Expected: collapse exactly under identity-carrier (degraded seam where upstream has fully resolved).
   - Hook: which projection branch is admitting/excluding rows differently between window and cohort post-collapse?
   - Tracker home: [`cohort-outside-in-post-73n-regression-tracker.md`](../cohort-outside-in-post-73n-regression-tracker.md) — new entry.

2. **Downstream A≠X y-side collapse on `surprise_gauge`** ([`test_doc56_phase0_behaviours.py:545`](../../graph-editor/lib/tests/test_doc56_phase0_behaviours.py#L545)).
   - Witness: `surprise_gauge.p["observed"]` collapses window↔cohort on `from(simple-b).to(simple-c)` over `synth-simple-abc` despite different denominators.
   - Expected: window > cohort by topology (window includes all already-at-X; cohort restricts to anchor-rooted population).
   - Hook: same y-side / model-curve cluster the user flagged on cohort_maturity_v3 (see batch B verify-run notes — `model_midpoint` and `model_curve_midpoint` both ~16× off analytic prior on `test_no_evidence_curve_matches_truth_analytic`).
   - Tracker home: same file, possibly fold into the existing A-display y-side residual entry.

3. **Bayesian-sidecar asymptote collapse on downstream A≠X** ([`test_doc56_phase0_behaviours.py:697`](../../graph-editor/lib/tests/test_doc56_phase0_behaviours.py#L697)).
   - Witness: `p_infinity_mean` on the bayesian sidecar path collapses window↔cohort on the same `simple-b → simple-c` seam.
   - Test author's NOTE (in-file): "the older bayesian canary for downstream cohort/window model-curve collapse: x-side separation can survive while the y-side sweep/model projection still inflates or inverts."
   - Tracker home: same; likely the same root cause as entry 2.

After tracker entries land, the manifest closes with the three tests left RED and named in the tracker. Subsequent batches do not retry these.

---

## Verify command

```
cd graph-editor && venv/bin/pytest --tb=short -q \
  lib/tests/test_doc56_phase0_behaviours.py::test_query_scoped_identity_carrier_collapses_public_evidence_basis \
  lib/tests/test_doc56_phase0_behaviours.py::test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split \
  lib/tests/test_doc56_phase0_behaviours.py::test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split
```

(Running the whole file exceeds the 4-min budget; per-test runs are ~18–23 s each.)

**Touches:** no test files. One regression-tracker doc edit (or three new entries depending on consolidation choice).

**Predicted Δ:** **0 fails closed**. The three tests stay RED, named in the tracker, become known-failing canaries with explicit hooks for the next investigation.

---

## Open questions

1. **Tracker-entry consolidation.** Three separate entries vs one consolidated "downstream cohort/window collapse" entry covering 545+697 plus a separate 442. Default: separate, since the failure shapes differ (442 = undercollapse on identity; 545/697 = overcollapse on downstream A≠X).

2. **Whether 442 belongs in this batch at all.** The 1.5% gap is small; could plausibly be a fixture noise artefact (one of the late taus might be outside the strict identity-carrier regime on this specific graph). 30-min investigation needed before committing the tracker entry. Default: open the entry with the witness, mark "needs reproduction on a second graph".

3. **Whether 545/697 are the same A-display y-side residual already in the tracker.** If yes, fold in. If no, separate entry. The audit acknowledges "the A-display y-side residual that the regression tracker already names as open." Default: read the existing entry first; if the symptoms align, fold in.

---

## Tick semantics reminder

- `[ ]` proceed (default)
- `[~]` hold
- Strikethrough — drop

After review, type `proceed batch D` and the agent will (a) read the existing regression-tracker, (b) decide consolidation, (c) write tracker entry/entries, (d) append the verify-run section below.

---

## Verify run — 8-May-26

**Pre-edit baseline**: 3 failed across the three named witnesses (whole file exceeds CI budget; per-test runs preserved here).

**Post-edit**: 3 failed (unchanged). No test edits in this batch — predicted Δ was 0 fails closed; the three tests stay RED as named canaries.

**Per-test verify** (run individually to dodge the whole-file 4-min budget):

```
test_query_scoped_identity_carrier_collapses_public_evidence_basis
  FAILED in 43.02s — assert 6513.8387278324 == 6417.0 ± 0.006417

test_lag_fit_and_surprise_gauge_share_downstream_temporal_mode_split
  FAILED in 23.65s — surprise_gauge lost the downstream window/cohort split

test_bayesian_sidecar_preserves_downstream_window_cohort_chart_split
  FAILED in 22.80s — window/cohort asymptotes collapsed on the bayesian synth chart
```

**Final actions taken**:

- Two new tracker clusters added to [`cohort-outside-in-post-73n-regression-tracker.md`](../cohort-outside-in-post-73n-regression-tracker.md):
  - **Cluster G** — Identity-carrier seam undercollapses cohort vs window by ~1.5%. Witness: test 442. Owner: BE projection / admission. Hold-back: do not relax the tolerance without proving the gap is fixture noise on a second graph.
  - **Cluster H** — Downstream A≠X y-side projection collapses cohort vs window across surfaces. Witnesses: tests 545 + 697 (consolidated, same shape on different consumer surfaces). Owner: BE y-side projection / model-curve. Likely shares root cause with Cluster A's open "Display-side residual" (rate-attributed y-prefix used as evidence-named field).

- All three witness tests left RED. The audit's per-file "STALE-CONTRACT — retire all three" verdict was wrong on per-test verification (see manifest §"Why the audit was wrong"); all three assertions match the 73n contract direction and are live regression canaries.

- Investigation Discipline summary line in tracker updated to include G and H alongside D, E, F.
