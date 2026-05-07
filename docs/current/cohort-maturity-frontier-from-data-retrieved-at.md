# Cohort Maturity Frontier From `data_retrieved_at` — Fix Proposal

**Status**: design proposal — narrow scope, single defect.
**Date**: 6-May-26
**Owner**: cohort_forecast_v3 row builder
**Companion**:
[`cohort-outside-in-post-73n-regression-tracker.md`](cohort-outside-in-post-73n-regression-tracker.md)
(Cluster C entry).

This proposal addresses **one** defect: per-cohort `tau_observed` is computed
from the frame forward-fill horizon instead of from the actual upstream
retrieval timestamp, with the consequence that `tau_solid_max` and the
selected-Cohort reducer's "observed prefix" branch both extend past the
real data horizon. No other changes are in scope here.

## 1. Canonical contract (verified against project docs)

`docs/current/codebase/DATE_MODEL_COHORT_MATURITY.md` is the canonical
reference for the date concepts in the cohort maturity pipeline.

§ 2.2:
> Zone boundaries MUST be derived from actual `tau_observed` values, not
> from `(sweep_to − anchor_to)` or `(sweep_to − anchor_from)`.
> Anchor-derived proxies work only when anchor dates and evidence dates
> are aligned, and break when they diverge.
>
> ```
> tau_evidence_all  = min(c.tau_observed for c in cohorts)  # A/B boundary
> tau_evidence_any  = max(c.tau_observed for c in cohorts)  # B/C boundary
> ```

The doc explicitly names the three failure scenarios the proxy hits.
The third is the case at hand:

> 3. **Historical `.asat()` query:** `sweep_to` capped by `.asat()` but
>    evidence may be older still. Fan falsely confident between evidence
>    date and asat date.

§ 2.3:

> ```
> tau_observed = min(
>     (evidence_retrieved_at − cohort_anchor_day).days,
>     tau_max
> )
> ```

§ 4 (change log):

> Derived rendering zone boundaries from `tau_observed` in
> `cohort_forecast.py`. `tau_solid_max = min(tau_observed)`,
> `tau_future_max = max(tau_observed)`.

`docs/current/cohort-maturity-selected-cohort-projection-pattern.md`
§ "Acceptance Invariants" pins the chart contract that depends on a
correct `tau_solid_max`:

> At `tau_solid_max`, E+F midpoint must equal the observed selected-Cohort
> group rate and all E+F fan bands must have zero width.

That invariant is the property the failing test
`test_f_mode_equals_ef_at_frontier_under_drift` ultimately rests on.

## 2. The frame layer correctly carries the right data

`graph-editor/lib/runner/cohort_maturity_derivation.py` produces frames
that include the field this fix needs.

Lines 185–193 build per-anchor `data_retrieved_at`:

```
# Track the latest contributing retrieval timestamp across
# slices for this anchor at this virtual frame. Min across
# slices is the conservative choice (the composed observation
# is only as fresh as the least-recent slice that contributed).
```

So `data_retrieved_at` per (anchor_day, snapshot_date) cell is the
**min across contributing slices** — the least-recent retrieval
timestamp among the slices that produced this cell's `(x, y)`. This
is the conservative choice: a composed observation is only as fresh as
the least-recent contributing input.

Lines 218–220 attach this string (ISO when known, else `None`) to each
`data_point` in the emitted frame.

Lines 95–117 (and the docstring) confirm that the frame grid spans
`sweep_from..sweep_to` daily even when no real retrieval happened that
day. So `snapshot_date` is the grid axis (forward-fill horizon);
`data_retrieved_at` is the per-cell observation-time stamp (least
recent across contributing slices).

The two values diverge cleanly: when no new retrieval occurred for an
anchor on a grid day, the cell carries forward the previous `(x, y)`
and records the previous (real) least-recent `retrieved_at` in
`data_retrieved_at`.

## 3. Existing algorithm reference

`graph-editor/lib/runner/cohort_forecast_v3.py` already contains the
correct algorithm for the contract, in
`SelectedAClockEvidence._observation_frontier`
([cohort_forecast_v3.py:273–304](../../graph-editor/lib/runner/cohort_forecast_v3.py#L273)):

> The sweep grid carry-forward creates cells at every tau up to the
> sweep end, but only cells whose `data_retrieved_at` is genuine
> represent real observations. The frontier is the tau corresponding to
> the latest actual retrieval, not the sweep grid edge.

The implementation iterates per-cell `data_retrieved_at`, computes
`(retrieved_d − anchor_d).days`, and returns the maximum. Falls back to
`max(tau over cells)` when `data_retrieved_at` is unavailable.

That algorithm — applied per-cohort over the cells that hold its
observations — is what § 2.3 of the canonical doc prescribes. The fix
proposed here applies the same algorithm in
`build_cohort_evidence_from_frames` over `cohort_at_tau` cells, which
the function already builds; today it discards `data_retrieved_at`
(see § 4 below).

### Active-carrier path — caveat on this analogue

A reasonable reading of the file might suggest the active-carrier path
already implements the contract via `_observation_frontier`. That is
**not** correct in the live code, and this fix should not lean on the
active path as a working example.

The live active-carrier `SelectedAClockEvidence` is built by
`_build_active_selected_a_clock_evidence_from_runtime`, called from
`compute_cohort_maturity_rows_v3` at
[cohort_forecast_v3.py:3298–3309](../../graph-editor/lib/runner/cohort_forecast_v3.py#L3298).
Its emitted cells
([cohort_forecast_v3.py:2038–2051](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2038))
**do not** populate `data_retrieved_at`:

```
cells[anchor_day][int(tau)] = SelectedAClockEvidenceCell(
    anchor_day=anchor_day,
    tau=int(tau),
    x_at_query_x=float(x_val),
    y_at_subject_end=float(y_val),
    source='runtime_observed_span_evidence',
    provenance=...,
)
```

When `_observation_frontier` runs over those cells, every
`data_retrieved_at` is `None` and the function falls back to
`max(tau over cells)`. Whether that is clock-correct depends on
whether the runtime emits cells only at τ values where real primitive
observations exist (in which case `max(tau)` is a safe surrogate for
the data horizon); the cells are built from primitive `weighted_evidence`
rows, which are bound to real observation dates — but verifying this
is independent of the proposed fix and out of scope here.

Only `SelectedAClockEvidence.from_frames`
([cohort_forecast_v3.py:117–185](../../graph-editor/lib/runner/cohort_forecast_v3.py#L117))
sets `data_retrieved_at` on cells (line 179, `data_retrieved_at=ret_str`).
That class method is not on the live active-carrier path used by the
v3 row builder; it appears to be a frame-derived constructor for other
use sites.

The point of citing `_observation_frontier` here is the **algorithm**:
it is the correct shape of the formula the proposal applies to
`build_cohort_evidence_from_frames`, regardless of which other call
sites exercise it today.

## 4. The window-mode / identity-carrier path drops it

For `window()` and `cohort(A=X)` queries, `selected_prefix` is `None`
and the reducer reads `ec.frontier_age`. That field is set in
`build_cohort_evidence_from_frames`, which **does not consume
`data_retrieved_at`** anywhere in its flow.

[cohort_forecast_v3.py:2913–2936](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2913)
populates the per-(anchor, τ) observed map:

```
cohort_at_tau: Dict[str, Dict[int, tuple]] = defaultdict(dict)
for f in frames:
    sd_str = str(f.get('snapshot_date', ''))[:10]
    for dp in (f.get('data_points') or []):
        ...
        cohort_at_tau[ad_str][tau] = (float(x_val), float(y_val))
```

Each cell becomes a `(x, y)` tuple — `data_retrieved_at` is read off
the data_point neither here nor in the per-cohort info builder at
lines 2872–2896.

[cohort_forecast_v3.py:2941–2950](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2941)
then computes per-cohort `tau_observed`:

```
for ad_str, ci in cohort_info.items():
    tau_obs = 0
    if last_frame_date:
        try:
            ad_d = _date.fromisoformat(ad_str)
            tau_obs = (last_frame_date - ad_d).days
        except (ValueError, TypeError):
            pass
    ci['tau_observed'] = min(tau_obs, ci['tau_max'])
```

`last_frame_date` is the latest frame `snapshot_date`
([cohort_forecast_v3.py:2861–2869](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2861))
— i.e. the forward-fill horizon, bounded above by `sweep_to`. The
formula `last_frame_date − anchor_day` is identical (modulo the
`tau_max` clamp) to the `(sweep_to − anchor_to)` proxy the canonical
doc § 2.2 explicitly forbids.

[cohort_forecast_v3.py:2970–2977](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2970)
then derives `tau_solid_max = min(c['tau_observed'])` across cohorts.
The aggregation form is correct; the input is wrong, so the output is
wrong.

The comment block immediately above this code
([cohort_forecast_v3.py:2953–2968](../../graph-editor/lib/runner/cohort_forecast_v3.py#L2953))
already states the intended contract — verbatim:

> tau_solid_max : right edge of epoch A — the largest τ where every
> selected Cohort is still observed. By definition this is
> min(frontier_age) across cohorts (the shallowest observed depth among
> the selected set).

The comment is consistent with the canonical doc. The implementation
beneath it is not.

## 5. Direct evidence the bug surfaces in the failing test

Test:
`graph-editor/lib/tests/test_cohort_factorised_outside_in.py::test_f_mode_equals_ef_at_frontier_under_drift`

Fixture: `synth-fmode-drift`, DSL
`window(12-Mar-26:21-Mar-26).asat(30-Apr-26)`.

Snapshot-DB observation span (verified by direct query against the
`snapshots` table):

- anchor span: 12-Dec-25 to 21-Mar-26
- retrieval span: 13-Dec-25 to **22-Mar-26**

Per-cohort latest real retrieval is 22-Mar-26 across the late window.
By § 2.3 of the canonical doc, per-cohort `tau_observed` is therefore:

- 12-Mar cohort: `(22-Mar − 12-Mar).days = 10`
- 13-Mar cohort: 9
- …
- 21-Mar cohort: 1

`tau_solid_max = min = 1`.

Daemon row dump for the same DSL (probe via
`graph-editor/lib/tests/_daemon_client.py`):

- `tau_solid_max = 40` (i.e. `30-Apr − 21-Mar = 40`)
- `tau_future_max = 49`
- `evidence_y` plateaus at 8380 from τ=10 onward — the carry-forward
  sum across cohorts of each cohort's latest real `y`
- `midpoint` is `None` for τ < 40, then `0.169` for τ ≥ 40

The 40-vs-1 mismatch is the manifestation of the bug. The reducer's
"observed prefix" branch runs to τ ≤ 40 because every cohort has
`frontier_age ≥ 40`; per-cohort `obs_y[τ]` for τ > actual data horizon
is the carry-forward, summed to 8380; the reducer divides by 49607 and
emits 0.169 as if it were the empirical group rate at τ=40.

If `tau_observed` were derived from `data_retrieved_at` per the
canonical contract, `tau_solid_max` would be 1, and at that τ every
cohort either has a real observation or is excluded; the reducer would
then satisfy the acceptance invariant "midpoint = empirical group rate
at the frontier" stated in the projection-pattern doc.

## 6. Proposed fix

Add `data_retrieved_at` plumbing to the window-mode / identity-carrier
path so it follows the same date-frontier algorithm shape that
`_observation_frontier` already implements
([cohort_forecast_v3.py:273–304](../../graph-editor/lib/runner/cohort_forecast_v3.py#L273)).
Three discrete edits in
`graph-editor/lib/runner/cohort_forecast_v3.py`, all inside
`build_cohort_evidence_from_frames`. Nothing outside this function or
its inputs needs to change.

### Edit 1 — capture `data_retrieved_at` in `cohort_at_tau`

Today the per-(anchor, τ) cell is a 2-tuple of `(x, y)`. Extend it to
carry the per-cell `data_retrieved_at` (`None` when the data_point
omits it). This is the analogue of what
`SelectedAClockEvidence.from_frames` already does at line 167.

Type change is local to this function: the `cohort_at_tau` dict is
consumed only inside `build_cohort_evidence_from_frames` (verified by
grep — see § 7 audit). No external callers see this map.

### Edit 2 — derive per-cohort `tau_observed` from `data_retrieved_at`

Replace the current `last_frame_date − anchor_day` block with the
canonical formula:

> per cohort, `tau_observed = max((data_retrieved_at − anchor_day).days
> for cells with non-null data_retrieved_at)`, clamped to `[0,
> tau_max]`.

This is the same formula `_observation_frontier` already implements at
lines 273–304, applied here over the cohort_info builder's input rather
than over `SelectedAClockEvidenceCell` values.

`data_retrieved_at` per cell is the **min across contributing slices**
(per § 2 above and `cohort_maturity_derivation.py:185–193`). Per cohort
we then take the **max across cells** of those least-recent
contributing-slice timestamps. Both reductions are deliberate: min
across slices gives a per-cell conservative freshness bound; max across
cells over the cohort's history identifies the latest such bound — the
furthest age at which we still have a least-recent-slice contribution.

**Fallback when no cell carries `data_retrieved_at`**: the canonical
doc § 2.3 prescribes "heuristic based on the last τ where Y increased
in the frame data". The proposed fix implements that explicitly: walk
the cohort's `cohort_at_tau[anchor]` cells in τ order and return the
largest τ at which `y` strictly exceeds the previous `y`.

This fallback is a **lossy lower-bound**, not a faithful reconstruction
of the canonical formula. Two failure modes are known and accepted:

1. **All-zero-y cohorts** (no conversions yet within the observation
   window). `y` is genuinely monotone with zero deltas; the strict-
   increase walk never triggers and returns 0 even when carrier
   observations were taken at later τs. The cohort's frontier is
   understated.
2. **Post-conversion plateaus**. After a cohort saturates, real
   retrievals continue but `y` is flat at the saturation value. The
   walk returns the τ of the last conversion, not the τ of the last
   retrieval. The cohort's frontier is understated.

Both cases bite **exactly the covered-zero cohorts** of the companion
coverage design — i.e. the cases where retrieval was taken but no
delta arrived. There is no provenance-free way to distinguish "carry-
forward of real observation" from "no observation". The fallback
documents the limitation rather than papering over it.

In production this fallback should not engage. Audit B in § 7 verifies
`data_retrieved_at` is preserved end-to-end through the v3 frame
pipeline, so the fallback is defensive cover for malformed inputs (a
unit-test or external producer that omits the field). If a covered-
zero failure mode is observed in practice, the correct response is to
fix the upstream omission, not to adjust the fallback.

Do **not** fall back to `last_frame_date − anchor_day` for missing
provenance — that is the same proxy the proposal is removing, and it
reintroduces the bug whenever `data_retrieved_at` is stripped upstream.

The earlier draft of this proposal made that mistake. It is corrected
here.

### Edit 3 — leave `tau_future_max` alone

The doc comment at lines 2962–2968 explicitly warns against coupling
`tau_future_max` to per-cohort `data_retrieved_at`:

> tau_future_max : … must NOT be coupled to per-cohort data_retrieved_at
> (which can lag for individual anchors and would invert the
> tau_solid_max ≤ tau_future_max invariant the row builder and chart
> both rely on).

Keep `tau_future_max = max(0, (sweep_to − anchor_from).days)` as
today, plus the existing `max(tau_future_max, tau_solid_max)` guard.
The guard now never trips when data is well-formed (because corrected
`tau_solid_max` is bounded above by `(retrieval_max − anchor_min)`,
which is bounded above by `(sweep_to − anchor_from)`).

## 7. Audits performed

Two read-only audits performed before this proposal was finalised.

### Audit A — other forward-fill-proxy frontier sites

`grep -rn "last_frame_date" graph-editor/lib/` returns sites in three
files:

- **`cohort_forecast_v3.py`** — the target of this proposal. Defective
  formula at lines 2944–2950.
- **`cohort_forecast_v2.py`** — same defective formula at lines
  637–646. v2 is "legacy, dev-only" per `BE_RUNNER_CLUSTER.md` § 1, so
  this is lower priority but is the same defect.
- **`cohort_forecast.py`** (v1) — uses `last_frame_date` only for
  `tau_max` (chart extent) at line 620, not for `tau_observed`. The
  comment block at lines 586–589 explicitly distinguishes the two
  concepts. Not the same defect; left alone.

Additionally, **`api_handlers.py:344`** in the `surprise_gauge` analysis
path constructs `engine_cohorts` directly with
`frontier_age = (last_frame_date - ad).days`. This is the **same
defective formula in a different analysis type**. The surprise gauge
feeds `compute_forecast_trajectory` rather than the v3 row builder, so
its sensitivity to `frontier_age` may differ. Out of scope for the
narrow Cluster C fix this proposal targets, but should be flagged on
the post-73n tracker as an adjacent finding.

**Conclusion**: the proposed edit closes the v3 row-builder path. v2
and the surprise gauge carry the same proxy; whether to fix them in
the same change or treat them separately is a sequencing decision for
the reviewer. This proposal does not bundle them in.

### Audit B — `data_retrieved_at` plumbing through the frame pipeline

For the v3 cohort_maturity path, frames reach
`build_cohort_evidence_from_frames` via:

```
snapshot rows
   → derive_cohort_maturity                  (cohort_maturity_derivation.py:166–220, sets data_retrieved_at per data_point)
   → per_edge_results[*].derivation_result.frames
   → compose_path_maturity_frames            (span_evidence.py:90–148, 178 — preserves data_retrieved_at across multi-edge composition; takes min across contributing edges)
   → preparation.composed_frames             (forecast_preparation.py:636–668)
   → handle_cohort_maturity                  (api_handlers.py)
   → compute_cohort_maturity_rows_v3
   → build_cohort_evidence_from_frames
```

Every step preserves `data_retrieved_at`. The single-edge fallback at
`forecast_preparation.py:652–668` uses derivation frames directly
(also preserves the field).

For our specific failing test fixture
(`synth-fmode-drift`, single-edge graph), the
`compose_path_maturity_frames` path runs with one carrier and one
y-incident edge, both pointing at the same edge. `data_retrieved_at`
is preserved in the composed frame.

**Conclusion**: the field is available at the consumer. No upstream
stripping needs to be fixed before this change.

## 8. Verification

The change should be verified at three levels:

**Unit-level**: a small synthetic that constructs `frames` with
`data_retrieved_at` set explicitly on some cells and `None` on others,
asserts that per-cohort `tau_observed` and the resulting
`tau_solid_max` match the expected derived values, and asserts that
the fallback path engages when `data_retrieved_at` is absent.

A second unit test pins the **lossy fallback failure modes** so the
limitation is documented in test form rather than only in prose:
construct a cohort with `data_retrieved_at = None` everywhere and
y monotone-flat-at-zero; assert `tau_observed = 0` (the documented
under-statement); construct a second cohort with y rising to a plateau
and `data_retrieved_at = None` everywhere; assert `tau_observed`
equals the τ of the last strict increase (not the τ of the last
retrieval, which is unrecoverable without provenance).

**Outside-in**: rerun `test_f_mode_equals_ef_at_frontier_under_drift`
and confirm `|F − E+F| ≤ 0.01` at the corrected `tau_solid_max`
(expected to be 1 for this fixture, where both F and E+F should sit
near zero per the test docstring's intent and the lognormal CDF at
τ=1 ≈ 0.06).

**Regression**: run the broader cohort-maturity suite in
`graph-editor/lib/tests/test_cohort_factorised_outside_in.py` and
`test_selected_cohort_pop_d_distribution.py` and the v3 contract suite
(`test_cohort_maturity_v3_contract.py`,
`test_cohort_maturity_v3_projection_contract.py`) to confirm nothing
that relied on the old (broken) behaviour now fails.

`test_f_mode_diverges_from_ef_off_frontier_under_drift` (the paired
anti-test) uses `_FMODE_FRONTIER_OFFSET = 10`; with corrected
`tau_solid_max ≈ 1`, the off-frontier τ becomes 11. Whether the
divergence floor (`_FMODE_FRONTIER_DIVERGE_FLOOR = 0.05`) holds at
τ=11 is a separate calibration question outside this fix's scope —
flagged here so reviewers know to check.

## 9. Out of scope

- The same defect in `cohort_forecast_v2.py:637–646` (legacy v2 path,
  per BE_RUNNER_CLUSTER.md § 1).
- The same defect in `api_handlers.py:344` (surprise gauge analysis).
  Different analysis type; sensitivity to `frontier_age` may differ
  there; should be tracked separately.
- The `_FMODE_FRONTIER_OFFSET` / `_FMODE_FRONTIER_DIVERGE_FLOOR`
  calibration of the paired anti-test (separate calibration follow-up).
- Cluster A and Cluster B from the post-73n tracker (independent
  defects).
- Active-cohort `cohort(A, X→end)` evidence semantics (Phase 3 of the
  selected-cohort-projection-pattern plan; already on a separate
  track).
- Rename of `as_at_date → snapshot_date` flagged in DATE_MODEL § 1.3
  (cosmetic; orthogonal).

## 10. Why this fix is conservative

- The canonical doc already prescribes the exact contract being
  restored.
- The frame producer already emits the exact field needed.
- The same algorithm already exists in this file as
  `_observation_frontier`; the proposal applies that algorithm in the
  one place that currently bypasses it.
- The cohort builder's own comment block already describes the
  intended contract and only its implementation diverges.
- All three edits live inside one function. No public API changes; no
  schema changes; no upstream changes; no downstream changes.
- Fallback uses the canonical-doc-prescribed heuristic (last τ where
  Y increases), not the proxy being removed.

The fix narrows a documented contract violation to its single point of
deviation in the v3 row-builder path. It does not introduce new
structure, new APIs, or new semantics.

**Adjacent proxies (out of scope, not closed by this fix):**
v2 and the surprise gauge contain similar
`last_frame_date − anchor_day` frontier proxies — see § 7 audit A.
This proposal does not bundle them in. Reviewers should assume they
remain defective until separately fixed; the v3 row-builder path does
not depend on them.
