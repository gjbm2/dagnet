# Mask / Coverage / IPW Removal Record

**Status**: Removal record  
**Date**: 18-May-26  
**Photocopy**: `stash@{0}` at the time of writing, message `photocopy-feature-snapshot-db-phase0-2026-05-18`

## Purpose

This note records the deliberate removal of the over-specified Phase 6 coverage machinery from the selected-Cohort runtime. It exists so future work does not accidentally reintroduce the same mask / support / exposure / IPW layer while trying to repair evidence display semantics.

The key decision is narrow:

- Keep evidence as observed point values and rates: `evidence_x`, `evidence_y`, and `rate` remain derived from empirical `k/n` surfaces.
- Remove coverage-as-DP algebra: row-presence masks, support streams, exposure streams, terminal coverage fields, IPW-adjusted evidence, and MCAR tests are no longer part of the live contract.

## What Was Removed

The removed layer tried to push snapshot-row presence through both conditioned and empirical span composition. It introduced several overlapping concepts:

- primitive row-presence masks
- conditioned support streams
- conditioned exposure streams
- empirical support / exposure siblings
- per-anchor terminal coverage at X and Y
- exposure-derived per-anchor frontiers
- IPW-adjusted evidence under MCAR assumptions
- row fields for `evidence_x_coverage`, `evidence_y_coverage`, `evidence_x_adjusted`, `evidence_y_adjusted`, and `rate_adjusted`

That machinery is intentionally removed from the live runner path. In particular, `subject_span_composer.py`, `empirical_evidence_operator.py`, `span_operator_supply.py`, `span_readout.py`, and `model_span_spine.py` no longer carry support / exposure / mask streams as row-authoritative surfaces.

## What Was Retained

Strict evidence remains live and load-bearing.

The retained evidence contract is point-value based:

- the empirical operator builds value kernels from observed cumulative `k/n`
- selected-Cohort projection turns those value kernels into strict evidence cumulatives
- `_project_runtime_rows` emits `evidence_x`, `evidence_y`, `rate`, and `rate_pure`
- the chart builder still reads `evidenceX`, `evidenceY`, `baseRate`, and `ratePure`

This means evidence answers “what did the observed point values say?” It does not answer “what fraction of the fitted model wavefront was observed?”

## Replacement Coverage Meaning

The row field `coverage` remains, but its meaning is deliberately simpler.

It is now a Cohort applicability display scalar: the fraction of selected Cohorts applicable at that chart age. It is used for evidence-line opacity. It is not a path-support ratio, not a terminal coverage value, not an admissibility predicate, and not an IPW denominator.

The removed terminal fields `evidence_x_coverage` and `evidence_y_coverage` should not be restored unless a future design explicitly reintroduces a simpler, reviewed meaning for them.

## Test Consequences

The following test surfaces were removed or pruned because they tested the retired semantics rather than the retained evidence contract:

- MCAR / IPW recovery tests
- primitive observation-mask tests
- conditioned support / exposure tests
- terminal coverage field tests
- active display tests whose only purpose was coverage freshness semantics

The remaining focused tests still cover strict evidence behaviour:

- empirical value-kernel construction from `k/n`
- source-day strict evidence lookup
- single-hop and multi-hop strict evidence saturation
- selected-Cohort aggregation
- window / cohort evidence differences where expected
- chart row presence of `evidence_x`, `evidence_y`, and `rate`

## Verification Recorded

Focused Python verification passed after the removal:

- `graph-editor/lib/tests/test_empirical_evidence_operator.py`
- `graph-editor/lib/tests/test_subject_span_composer.py`
- `graph-editor/lib/tests/test_model_span_spine_selected_cohort.py`
- `graph-editor/lib/tests/test_span_readout.py`
- `graph-editor/lib/tests/test_span_operator_supply.py`
- `graph-editor/lib/tests/test_generalised_span_model_shadow.py`
- `graph-editor/lib/tests/test_selected_evidence_natural_degeneracy.py`

Result: 82 passed.

The outside-in suite was not run as part of this removal record.

## Future Guardrail

Do not rebuild coverage by smuggling row-presence masks back into primitive conditioning or span composition. If future semantics require evidence applicability, define it directly at the selected-Cohort / row boundary in terms of the observed evidence object and the chart question being answered.

The retained invariant is:

> Evidence is calculated by reference to observed point values and rates, not by model-wavefront support.
