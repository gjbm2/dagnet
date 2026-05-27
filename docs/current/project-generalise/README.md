# project-generalise — archived

Archive of a generalisation attempt at the `cohort()` `y` subject handling in
`graph-editor/lib/runner/cohort_forecast_v3.py`. The work was rolled back on
11-May-26 after the generalised path caused a catastrophic regression. The
production file was restored from `stash@{0}`
(`photocopy-feature-snapshot-db-phase0-2026-05-11`).

This folder preserves the design intent, the implementation plan, the failed
code, and the probe / snapshot evidence so the effort can be resumed later
without re-discovering context.

## Guiding principle

The engine is a mathematical object: **no fallbacks in the engine — all
defense, if any is needed, belongs at the perimeter**. The engine should
degenerate algebraically (NaN propagation, identity composition, empty
sums) rather than forking on schema, carrier kind, or missing data. The
generalisation effort and the defensive-coding audit below are two
expressions of the same goal: collapse parallel code paths into one
algebra and push validation to the boundary.

## Companion audit — 12-May-26

[cf-defensive-coding-audit.md](cf-defensive-coding-audit.md) — thorough
read of the CF machinery (Python runner, funnel/bridge engines,
statistical enhancement, Bayes surface) for defensive coding, fallbacks,
and forking/branching. 21 findings (7 HIGH / 9 MEDIUM / 5 LOW) plus 5
separate forking/branching findings. The audit was commissioned
independently of the generalisation rewrite but converges on the same
hotspots:

- **H-5 / F-1** — pervasive `is_identity_carrier` branching in
  `cohort_forecast_v3.py` (20+ sites + a parallel
  `_synthesize_identity_carrier_observed_surface` helper). This is the
  same fork the generalisation rewrite tried (and failed) to dissolve;
  the audit re-frames it as an algebraic degeneracy of one
  `ComposedPrimitiveSpan` path.
- **H-2 / F-2** — `funnel_engine.py` substitutes `0.0` for every missing
  CF scalar before `cumprod`, silently zeroing whole chains. Funnel is
  one of the "hold-outs" flagged in the recent CF refactor commit.
- **H-1** — monotone-repair clamp inside engine math at
  `cohort_forecast_v3.py:3587`, violating the semantic pseudocode's
  explicit prohibition on upstream repair by clipping.

Use the audit as the **target spec for what the next generalisation
attempt must remove**, not just the bugs it must avoid. If a future
rewrite reintroduces any of the 21 findings, it has regressed against
the principle even if all fixtures pass.

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
├── cf-defensive-coding-audit.md                            (12-May-26 audit: 21 findings + 5 forks)
├── cohort_forecast_v3.generalisation-attempt.py            (the failed rewrite, 6377 lines)
├── generalised-span-readout-candidate-plan.md              (13-May-26 next-attempt plan: isolated span readout candidate first)
├── span_readout_candidate.py                               (isolated role-neutral span evaluator candidate)
├── test_span_readout_candidate.py                          (blind algebraic tests for the candidate)
├── span_operator_supply_candidate.py                       (minimal operator constructors feeding the pure span core)
├── test_span_operator_supply_candidate.py                  (logical tests for operator construction)
├── primitive_operator_supply_candidate.py                  (primitive-shaped p/CDF/evidence -> span operator constructors)
├── test_primitive_operator_supply_candidate.py             (logical tests for primitive operator construction)
├── test_model_span_oracles_candidate.py                    (independent model-curve convolution oracle tests)
├── runtime_model_span_adapter_candidate.py                 (draft current-runtime model-shape -> candidate span adapter)
├── test_runtime_model_span_adapter_candidate.py            (logical tests for the draft runtime model adapter)
│
├── multi-hop-window-evidence-rate-composition-design.md    (design)
├── multi-hop-window-evidence-rate-composition-implementation-plan.md
├── multi-hop-rate-composition-y-deficit-investigation.md   (post-implementation investigation)
├── mask-coverage-ipw-removal-record-18-May-26.md           (masks/support/exposure/IPW retired; strict k/n evidence retained)
├── checkpoint-frontier-coverage-proposal.md                (17-May-26 external-review proposal for cumulative snapshot coverage)
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

1. Read [model-first-strict-span-cutover-plan-13-May-26.md](model-first-strict-span-cutover-plan-13-May-26.md)
   first for the strict execution sequence. The selected-Cohort row cutover
   that followed it is **complete (27-May-26)** and archived at
   [../../archive/project-generalise/selected-cohort-projection-cutover-plan.md](../../archive/project-generalise/selected-cohort-projection-cutover-plan.md):
   the mode-blind `model_span_spine.project_selected_cohort_rows` reducer
   replaced the legacy mode-sliced row machinery in production, with no
   recreated reducer branches.
2. Treat the candidate artefacts below as historical context. The promoted
   production core now lives under `graph-editor/lib/runner/`; do not resume
   work from the candidate files.
3. Start production work from the selected-Cohort cutover plan's first step:
   freeze the current numerical evidence policy before moving row authority.
4. Re-read the original design + implementation plan + y-deficit investigation
   for historical context and failure signatures.
5. Diff `cohort_forecast_v3.generalisation-attempt.py` against the current
   `graph-editor/lib/runner/cohort_forecast_v3.py` (the photocopy state) to
   recover the intended generalisation shape.
6. The catastrophic regression was around `cohort()` `y` subject handling —
   re-tests the y-deficit fixtures first before extending scope.
