# Selected A-Clock Observation Frontier Support

**Status**: proposal for external review  
**Date**: 11-May-26  
**Scope**: `cohort_maturity_v3` active `cohort(A, X->Y)` selected A-clock evidence and projection frontiers

## Summary

The active-carrier selected A-clock path needs one fact it does not reliably
have today:

**For each selected Cohort, what is the last A-clock tau where the paired
`Y / X` observation has real retrieved support?**

The row builder may forward-fill displayed evidence values beyond that point
so the chart remains continuous. That is display behaviour. The forecast
projection must not treat those forward-filled cells as fresh observations.

The proposed fix is to carry a minimal **strict support frontier** alongside
selected evidence. This is not a general date-provenance architecture and does
not require attaching retrieval timestamps to every displayed value.

## Triggering Regression

The issue became visible after synthetic fixture pollution was removed between
`synth-mirror-4step` and its mirror variants. The unchanged regression
`test_v3_midline_at_saturation_converges_to_p` now runs against the clean base
fixture and fails on:

- graph: `synth-mirror-4step`
- query: `from(m4-registered).to(m4-success).cohort(m4-landing,7-Mar-26:21-Mar-26)`
- observed last-row midpoint: about `0.441`
- observed `p_infinity_mean`: about `0.707`

Runtime diagnostics show the selected projection's last-row numerator and
denominator are approximately `78.57 / 178.06`, explaining the `0.441`
midpoint. The subject span rate itself is healthy, about `0.707`; the
projection is not adding the expected future mass after the real observation
frontier.

## Diagnosis

There are two different horizons in this path:

- **Display horizon**: the chart row tau. Evidence values may be forward-filled
  here so that the chart has a continuous evidence surface.
- **Observation frontier**: the last A-clock tau where the selected Cohort has
  real retrieved support for the paired `Y / X` observation.

For active `cohort(A, X->Y)`, Pop D and Pop C projection must start from the
observation frontier. Today the runtime-built selected evidence path can fall
back to the maximum tau in the selected cell map. That maximum can be a
forward-filled display cell, not a fresh observation.

The result is:

- the selected Cohort frontier is set too far right;
- Pop D and Pop C have little or no future interval to run;
- `forecast_y` is near zero at the row horizon;
- the midpoint remains pinned to stale observed selected evidence instead of
  converging towards the subject span rate.

## Existing Relevant Surfaces

The affected code is concentrated in `graph-editor/lib/runner/cohort_forecast_v3.py`:

- `_selected_cohort_group_rate_draws()` already asks for retrieval-frontier
  semantics in active carrier mode.
- `SelectedAClockEvidence._observation_frontier()` currently derives a frontier
  from `data_retrieved_at` when available, and otherwise falls back to maximum
  tau.
- `_build_selected_a_clock_evidence_from_runtime()` builds the runtime selected
  A-clock cells that feed that frontier logic.

The missing concept is not a displayed value and not a group-wide timestamp.
It is a strict support frontier per selected Cohort.

## Required Invariants

### Strict Support Only

Strict support must come only from real retrieved rows. Do not use
`_row_snapshot_date()` for support, because that helper can fall back to
observed dates for placement/display. A display or placement date must not
become observation support.

### Support Is Per Cohort

Support is not one scalar for the whole selected group. Each anchor day has a
different A-clock age. The same calendar retrieval date maps to a different
tau for each selected Cohort.

The implementation must therefore preserve support per selected Cohort. Group
logic may aggregate only after each Cohort has its own frontier.

### Pair Support Requires Required Roles

For active `cohort(A, X->Y)`, the selected observation is paired:

- denominator-side support for `X` comes from the carrier side;
- numerator-side support for `Y` comes from the subject side.

A paired `Y / X` observation has strict support at a given A-clock tau only
when every required nonzero contributing side has strict support. Partial
support must not create a paired frontier. A malformed zero-weight or off-clock
row with no strict support must not poison an otherwise valid cell.

For identity-carrier cases this degenerates naturally: the carrier is
structural identity, so the subject side is the only retrieval-bearing role.
This proposal targets active carrier mode, where both roles matter.

### Display Forward-Fill Is Not Support

Forward-filled values may remain in the display/evidence surface. They are not
fresh observations. They must not extend the observation frontier.

## Minimal Implementation Model

### 1. Carry Role Support Tau

Introduce a minimal support channel that records strict support tau, not a full
timestamp algebra:

- carrier support tau per `anchor_day`;
- subject support tau per `anchor_day`;
- paired support tau per `anchor_day`.

The support tau is the A-clock age of the last real retrieved observation for
that role and selected Cohort.

### 2. Extract Support Strictly

When placing row evidence, derive support only from real retrieval fields on
the row or coordinate. Convert the real retrieval date to A-clock tau for the
current anchor day. If no real retrieval field exists, no strict support is
recorded.

Do not use observed date fallback.

### 3. Compute Paired Frontier Locally

For each selected Cohort:

- derive the carrier frontier from carrier support;
- derive the subject frontier from subject support;
- derive the paired frontier from the required roles for that Cohort.

In active carrier mode, the paired frontier is the lower of the carrier and
subject frontiers, provided both required roles have strict support. If either
required role lacks strict support, the paired frontier is absent and the
runtime should fall back only as a legacy/malformed-input behaviour.

### 4. Use Paired Frontier for Projection

`_selected_cohort_group_rate_draws()` should use each Cohort's paired support
frontier when deciding where observed prefix ends and Pop D / Pop C projection
begins.

`tau_solid_max` may still be the minimum paired frontier across selected
Cohorts, because that means “all selected cohorts are observed through this
tau”. But Pop D and Pop C must start from each Cohort's individual frontier,
not from a group-wide date.

### 5. Keep Values Separate From Support

Displayed `X` and `Y` values may still forward-fill to the chart horizon.
Support frontier is a separate fact. The runtime should not need to answer
“which retrieval timestamp belongs to this interpolated displayed value?” to
fix this regression.

## Expected Behaviour After Fix

For the clean `synth-mirror-4step` regression:

- each selected Cohort should know where real paired support ends;
- Pop D and Pop C should forecast from that support frontier to the row
  horizon;
- the active-carrier selected-cohort midpoint should no longer remain pinned to
  stale forward-filled evidence;
- the unchanged saturation regression should pass without changing test
  semantics.

## Non-Goals

This proposal does not:

- change the public test contract;
- change `forecast_y` display semantics;
- introduce a new branch for `window()` versus `cohort()`;
- change fetch/refetch policy;
- add full timestamp provenance to every displayed value;
- use a group-wide freshness timestamp;
- treat display forward-fill as observation support.

## Design Decisions

1. The runtime primitive should be support frontier tau, not a required
   `data_retrieved_at` string on every displayed value.
2. Strict support is derived only from real retrieval fields; observed-date
   fallback is forbidden for support.
3. Support is role-specific until the selected Cohort pair is formed.
4. In active carrier mode, paired support requires every required nonzero role
   to have strict support.
5. Missing strict support remains a legacy/malformed-input case. Normal active
   runtime cells should not rely on the existing maximum-tau fallback after
   this fix.
6. Diagnostics should expose per-role and paired support frontiers for active
   selected cohorts when diagnostic mode is enabled.
