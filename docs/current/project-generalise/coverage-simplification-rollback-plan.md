# Coverage Simplification Rollback Plan

**Status**: Draft implementation plan  
**Date**: 17-May-26  
**Scope**: Controlled rollback of the checkpoint-frontier coverage implementation while preserving the source-day evidence algebra fixes from the selected-cohort projection cutover.

## Problem

The checkpoint-frontier coverage path made coverage mathematically ambitious but operationally unusable. It computes row-boundary support by re-evaluating support across output ages, anchors, draws, source days, and topology. In realistic outside-in requests this becomes computationally obscene and can make the suite impossible to run.

The original motivation was valid: the earlier mask/exposure approach failed for non-latency edges when useful snapshot evidence appeared after the instantaneous model delay cell. A non-latency transition may be semantically instantaneous, but the snapshot row that reveals the cumulative conversion can arrive at the next retrieval age. Coverage tied too tightly to model delay mass at age zero wrongly treated that evidence as uncovered.

The current checkpoint solution overcorrects. We need to return to the cheaper composed support/exposure shape, but change the local coverage mask so the non-latency case is covered by empirical observability rather than by model-delay cell alignment.

## Target Principle

Keep the evidence value algebra. Do not rework the selected-cohort evidence calculation itself.

Coverage is a sibling support signal over the same composed evidence path. It should remain mass-weighted through multi-hop composition, but the local cell mask should be empirical:

- a cell is covered when a snapshot row exists for the source-day/local-age cell; or
- a cell is covered when the empirical increment at that cell is non-zero.

This preserves mass weighting across multi-hop paths while avoiding the non-latency failure where an age-one observed increment was missed because model delay mass sat at age zero.

## What Must Be Preserved

The rollback must preserve the newer evidence-algebra fixes that landed during the selected-cohort projection work:

- `window()` evidence readout must remain local-clock. Multi-hop window evidence must not be shifted through cohort-style source-day ageing.
- `cohort()` evidence readout must preserve the selected cohort clock and source-day alignment.
- Per-source-day empirical kernels in `empirical_evidence_operator.py` must remain the evidence source for strict and adjusted evidence.
- The empirical value path must continue to read snapshot-derived `k`, `n`, and `k/n`, not model values.
- Model surfaces remain separate from evidence surfaces. Model mass may weight support and applicability, but must not supply empirical rates or counts.
- Identity carrier and active carrier must continue to degenerate through the same selected-cohort projection contract.

## What Must Be Removed

The production row path must stop using the checkpoint-frontier row-boundary evaluator:

- no dense row-boundary tensor over output age, draw, and chain day;
- no full support DP per output row;
- no row-boundary support evaluator as the source of `coverage_x`, `coverage_y`, `exposure_x`, `exposure_y`, or frontier;
- no checkpoint-frontier coverage machinery in the hot path of `project_selected_cohort_rows`.

Diagnostic remnants can survive temporarily only if unreachable from production and clearly marked for deletion. The acceptance target is that `project_selected_cohort_rows` reads composed support/presence streams, not row-boundary checkpoint output.

## Re-Implementation Shape

### 1. Restore Composed Support And Presence

`subject_span_composer._compose_draws` should again compose three sibling streams:

- value: the mass-transfer kernel;
- support: value multiplied by the empirical coverage mask;
- presence: the coverage mask carried as a value-independent stream.

The old term `exposure` should be treated as presence rather than as a separate statistical object. Its only job is to distinguish observed zero from absence and to drive admissibility/frontier-style diagnostics.

The support stream gives mass-weighted coverage. The presence stream prevents covered-zero evidence from disappearing.

### 2. Keep Source-Day-Aware Masking

The rollback must not return to a purely aggregate age-only mask if that would undo the window multi-hop fix.

The mask should be selected using the same evidence readout binding as the empirical value lookup:

- window readout uses the local primitive source-day and local age;
- cohort readout uses the selected source-day and cohort-relative age.

This keeps the source-day evidence contract aligned across value, support, and presence.

### 3. Change The Local Mask Definition

The local mask should cover either empirical observability condition:

- a snapshot row exists at that source-day/local-age cell; or
- the empirical increment at that source-day/local-age cell is non-zero.

This is the narrow change intended to fix the non-latency failure without adding row-boundary checkpoint DPs.

Observed zero remains covered because the row exists. A missing row with no increment remains uncovered. A delayed non-latency increment becomes covered when the increment appears.

### 4. Restore Cheap Projection Reads

`model_span_spine.project_selected_cohort_rows` should return to the cheaper projection shape:

- seed selected cohort mass from the composed carrier;
- read `coverage_x` and `coverage_y` from composed support divided by composed value;
- read presence/admissibility from the composed presence stream;
- read strict and adjusted evidence from empirical value/adjusted streams;
- aggregate across anchors after per-anchor surfaces are formed.

The projection must not run a row-boundary support DP.

## Acceptance Gates

The first acceptance gate is speed: the representative outside-in command for `synth-lat4` cohort maturity must complete in a reasonable time without the daemon. If it does not, the rollback has failed its primary purpose.

The correctness gate is focused and must preserve the existing semantic tests:

- empirical evidence operator tests remain green;
- subject span composer tests remain green;
- selected-cohort spine tests remain green;
- the window multi-hop local lookup test remains green;
- the non-latency coverage regression must be represented by a focused test before closing the rollback.

The outside-in suite should only be retried after the representative command completes promptly.

## Non-Goals

This plan does not attempt to perfect sparse checkpoint semantics. It deliberately rejects the full checkpoint-frontier model for now because it blocks debugging and makes the suite unusable.

This plan does not redefine evidence values. It only changes how coverage/support is computed.

This plan does not add chunking, cache policy changes, or a new parallel production path. The hot path should become simpler, not more configurable.

## Rollback Boundary

This is a controlled rollback of the coverage implementation, not a wholesale file revert.

Do not discard the source-day empirical algebra, per-draw weighted empirical kernels, or the `window()` versus `cohort()` evidence binding fixes. The rollback target is specifically the checkpoint-frontier coverage mechanism and the dense row-boundary support evaluator.
