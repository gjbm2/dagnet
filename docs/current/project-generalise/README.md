# project-generalise — archived

Archive of a generalisation attempt at the `cohort()` `y` subject handling in
`graph-editor/lib/runner/cohort_forecast_v3.py`. The work was rolled back on
11-May-26 after the generalised path caused a catastrophic regression. The
production file was restored from `stash@{0}`
(`photocopy-feature-snapshot-db-phase0-2026-05-11`).

This folder preserves the design intent, the implementation plan, the failed
code, and the probe / snapshot evidence so the effort can be resumed later
without re-discovering context.

## Rollback summary

- **Reverted file**: [graph-editor/lib/runner/cohort_forecast_v3.py](../../../graph-editor/lib/runner/cohort_forecast_v3.py)
- **Source of rollback**: `stash@{0}` = `photocopy-feature-snapshot-db-phase0-2026-05-11`
- **Generalisation code preserved at**:
  [cohort_forecast_v3.generalisation-attempt.py](cohort_forecast_v3.generalisation-attempt.py)
- **Diff vs photocopy at point of rollback**: 703 insertions, 624 deletions
  (~1300 lines changed across the file)

## Layout

```
project-generalise/
├── README.md                                               (this file)
├── cohort_forecast_v3.generalisation-attempt.py            (the failed rewrite, 6377 lines)
│
├── multi-hop-window-evidence-rate-composition-design.md    (design)
├── multi-hop-window-evidence-rate-composition-implementation-plan.md
├── multi-hop-rate-composition-y-deficit-investigation.md   (post-implementation investigation)
│
├── cf-v3-snapshots/                                        (point-in-time copies of cohort_forecast_v3.py)
│   ├── cf_v3_photocopy.py                                  (== stash@{0} content)
│   └── cf_v3_current_buggy.py                              (pre-X-fix, pre-interp; superseded by the .generalisation-attempt.py file at folder root)
│
├── probes/                                                 (single-hop probe outputs from the y-deficit investigation)
│   ├── snapshot_cohort_drift.py                            (drift-snapshot probe script)
│   ├── probe_singlehop_cohort_a_bc_photocopy.json          (reference / ground truth)
│   ├── probe_singlehop_bc_photocopy.json                   (duplicate of above, no cohort_a prefix)
│   ├── probe_singlehop_cohort_a_bc_current.json            (post-rewrite, no fixes — X +3%, Y deficit)
│   ├── probe_singlehop_cohort_a_bc_unconditional.json      (X fix — cell-emit τ union)
│   ├── probe_singlehop_cohort_a_bc_fix2.json               (X fix v1 with branch — discarded)
│   ├── probe_singlehop_cohort_a_bc_interp.json             (X fix + _build_source_day_rate_cache interp — Y unchanged)
│   └── probe_singlehop_cohort_a_bc_fixed.json              (intermediate)
│
└── snapshots/                                              (cohort multi-hop drift snapshots)
    ├── cohort-multihop-drift-snapshot.smoke-test.json
    ├── cohort-multihop-drift-snapshot.pre-rewrite.json     (baseline before generalisation)
    ├── cohort-multihop-drift-snapshot.post-rewrite.json
    ├── cohort-multihop-drift-snapshot.post-rate-prop-11May26.json
    └── cohort-multihop-drift-snapshot.post-endpoint-frontier.json
```

## Stale references

The three design / investigation docs were written when artifacts lived under
`/tmp/`. After this archive move, those `/tmp/...` paths in the docs are
historical. Resolve them under this folder:

| Path in docs            | Now lives at                                          |
| ----------------------- | ----------------------------------------------------- |
| `/tmp/cf_v3_photocopy.py`            | `cf-v3-snapshots/cf_v3_photocopy.py`     |
| `/tmp/cf_v3_current_buggy.py`        | `cf-v3-snapshots/cf_v3_current_buggy.py` |
| `/tmp/snapshot_cohort_drift.py`      | `probes/snapshot_cohort_drift.py`        |
| `/tmp/probe_singlehop_*.json`        | `probes/probe_singlehop_*.json`          |
| `/tmp/cohort-multihop-drift-snapshot.*.json` | `snapshots/cohort-multihop-drift-snapshot.*.json` |

## Picking this up later

1. Re-read the design + implementation plan + y-deficit investigation in
   order.
2. Diff `cohort_forecast_v3.generalisation-attempt.py` against the current
   `graph-editor/lib/runner/cohort_forecast_v3.py` (the photocopy state) to
   recover the intended generalisation shape.
3. The catastrophic regression was around `cohort()` `y` subject handling —
   re-tests the y-deficit fixtures first before extending scope.
