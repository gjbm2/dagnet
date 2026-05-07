# Cohort Maturity Selected A-Clock Evidence Clock Adapter Plan

**Status**: implementation plan  
**Date**: 5-May-26  

## Purpose

This note scopes the fix for active `cohort(A, X -> end)` evidence display in the cohort maturity chart.

The current problem is not only row-field plumbing. Active cohort evidence must be displayed on the selected A-clock, but the system's durable observed rows are generally available on primitive-local clocks. The forecast runtime already performs non-trivial clock alignment when primitive evidence is bound for conditioning. `SelectedAClockEvidence` should reuse that same class of clock adaptation rather than composing legacy frame artefacts or inventing a second timing path.

The target is a principled evidence curve:

- observed counts remain observed counts;
- clock placement is adapted using the conditioned carrier and subject timing objects;
- the resulting display object is paired by selected A-day and A-clock age;
- numerator and denominator are accumulated as CDF/as-of quantities, not per-age deltas.

## Background

The relevant semantic contract is:

- denominator: "who from selected A-day has reached `X` by A-clock age `tau`";
- numerator: "who from selected A-day has reached the subject end by A-clock age `tau`";
- displayed rate: `Y_A(tau) / X_A(tau)`, never `Y_A(tau) / A`;
- evidence rows are cumulative CDF observations: latest as-of value per Cohort, then sum across Cohorts.

The implementation currently has these important surfaces:

- `primitive_evidence.bind_primitive_evidence` builds primitive-local `WeightedPrimitiveEvidenceView` rows by multiplying raw admitted rows by `arrival_weight[U][observed_date]` from the prefix-arrival map.
- `primitive_conditioning.condition_primitive` consumes those weighted rows and conditions the primitive posterior.
- `primitive_readout.compute_resolved_runtime_readout` builds separate subject and carrier arrival maps, binds primitives through them, and composes `composed_subject` plus optional `composed_carrier`.
- `cohort_forecast_v3._selected_cohort_group_rate_draws` projects selected Cohort numerator and denominator masses before dividing once per particle and age.
- `SelectedAClockEvidence` is the intended display-prefix object, but it is not yet built from the primitive-bound evidence surfaces.

## Semantic and Runtime References

`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` is a core invariant source for this work. The implementation must preserve its cohort/window contract, especially:

- the displayed rate remains `Y / X`, not `Y / A`;
- the denominator side answers carrier arrival at `X`;
- the numerator side answers full subject-span arrival at `end`;
- single-hop is not a separate runtime family, it is the natural one-edge degeneration of the same full-span template;
- `A = X` is an identity-carrier degeneration, not a separate evidence path;
- raw evidence rows from a different clock are not directly admissible as whole-query evidence;
- Appendix A's primitive identity rules apply: evidence enters through the bound primitive forms keyed by binding, anchor, edge, role, arrival-map identity, prior identity, and bound-evidence identity.

`docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md` is the runtime-shape reference for this work. It describes the live `ResolvedCFRuntime`, role-labelled carrier/subject clocks, primitive-bound evidence surfaces, selected-Cohort reducer, `SelectedAClockEvidence`, and row projection boundaries. The adapter should align with those public runtime objects rather than rediscovering roles from frame shape or lower-level diagnostics.

## Core Decision

Build active selected evidence from primitive-bound observed rows plus conditioned clock surfaces.

Do not build it by:

- composing already-derived frame rows and inferring semantics from frame shape;
- lifting carrier window evidence into observed selected prefixes beyond the selected A-day base-mass role;
- fabricating an A-clock subject numerator from raw subject rows without an explicit carrier clock adapter;
- using model projection values as evidence-named fields.

The evidence display object should be called or documented as clock-adapted selected evidence. It is still evidence: the counts come from observed rows. The adapter supplies the clock transformation needed for the active cohort question.

## Risk Controls

This plan must not be executed as eight independent atomic stages with tests after each partial stage. That would validate intermediate artefacts that are not meaningful until denominator, numerator, clock placement, pairing, aggregation, row projection, and cleanup agree.

The implementation should instead preserve these controls:

- **No case forks**: do not add single-hop versus multi-hop branches, active versus identity branches, or terminal-edge shortcuts. Use one carrier-plus-subject-span template whose sub-objects degenerate naturally.
- **One evidence ingress**: do not wire the adapter directly to snapshot rows or bespoke evidence readers. The adapter consumes the existing runtime's superset evidence acquisition and primitive-bound evidence surfaces.
- **Time shifting gets targeted proof**: evidence clock placement is subtle enough to deserve small deterministic fixtures and outside-in assertions that prove the shift, carry-forward, and non-double-counting behaviour.
- **No legacy shadow path**: once the adapter is live, active evidence-named fields must not still be sourced from `_prepare_active_selected_evidence_frames`, `compose_path_maturity_frames`, or any other frame-derived substitute.
- **Clean up after the cutover**: remove dead callers, transitional helpers, stale diagnostics, and misleading field comments rather than leaving a second path for future work to trip over.

## Target Object

Extend or replace `SelectedAClockEvidence` so each cell carries:

- selected `anchor_day`;
- A-clock `tau`;
- denominator mass at query node `X`;
- numerator mass at subject end;
- provenance for the raw row sources;
- provenance for the clock adapter used to place the row on the A-clock;
- enough diagnostics to distinguish exact selected-prefix rows from clock-adapted rows.

The aggregate object must expose, per A-clock `tau`:

- cumulative selected denominator;
- cumulative selected numerator;
- boundary denominator at `tau_solid_max`;
- E-mode denominator;
- E+F evidence denominator;
- selected Cohort count contributing to the as-of aggregate;
- source/provenance summary for diagnostics.

## Clock Adaptation Semantics

### Denominator: `X_A(tau)`

For active `cohort(A, X -> end)`, denominator evidence is carrier-side evidence.

The adapter should consume carrier primitive observed rows after binding to the A-rooted carrier clock. Those rows tell us observed carrier arrivals into `X` under the selected A-day population and the conditioned carrier timing basis.

For each selected A-day and A-clock age, produce a cumulative as-of denominator:

- one latest value per selected A-day;
- no summing of multiple snapshots for the same A-day;
- no terminal-edge denominator substitution;
- no raw downstream subject row used as denominator.

### Numerator: `Y_A(tau)`

Numerator evidence is subject-side evidence placed onto the A-clock.

The adapter should consume subject primitive observed rows after primitive-local binding, then compose them with the conditioned carrier arrival clock. In words: observed progress from `X` to the subject end must be placed at A-clock ages by adding "when this selected A-day reached `X`" to "when the observed subject progression occurred on the X-clock".

For single-hop subjects this is still the same conceptual operation; the subject span happens to have one primitive. For multi-hop subjects, the full `X -> end` subject span is used. A terminal-edge row must not become the whole numerator unless the subject span is literally that one edge.

### CDF/As-Of Rule

The output of the adapter must be cumulative. At row age `tau`, for each selected A-day, choose the latest adapted evidence cell at or before `tau`. Then sum those latest cells across selected A-days.

Never sum all adapted cells up to `tau` for the same A-day. That would double count snapshots of the same Cohort.

## Runtime Integration

The implementation should add a named builder, likely in the backend runner cluster near the runtime/readout boundary. A suitable home is one of:

- `cohort_forecast_v3.py` if kept private to cohort maturity rows;
- a small new runner module if it needs to consume primitive provenance and remain testable independently;
- `primitive_readout.py` only if the adapter naturally belongs beside `compute_resolved_runtime_readout` and can be exposed through runtime diagnostics without creating a row-builder dependency.

The builder should consume:

- the `ResolvedCFRuntime`;
- the selected `cohort_list` or selected anchor-day set;
- the runtime's conditioned primitive map or registry;
- composed carrier and subject draw/mean timing surfaces;
- a horizon for the row grid;
- the active carrier predicate derived from `population_root != denominator_node`.

The builder should return `SelectedAClockEvidence`.

The row builder should then:

- pass `SelectedAClockEvidence` into `_selected_cohort_group_rate_draws`;
- build active evidence row fields from `SelectedAClockEvidence.aggregate_by_tau`;
- stop calling `_prepare_active_selected_evidence_frames` once the new adapter is live;
- leave active evidence fields blank if the adapter cannot produce a provenance-valid selected evidence object.

The main consumer contract already exists. `_selected_cohort_group_rate_draws` consumes `SelectedAClockEvidence.prefixes_for_cohorts` for selected-Cohort E+F prefix mass, `_project_runtime_rows` consumes `SelectedAClockEvidence.aggregate_by_tau` for active evidence fields, and active completeness already reads selected prefixes when present. The implementation should replace the current frame-derived producer with a runtime-built `SelectedAClockEvidence`; it should not add another downstream evidence path.

## Field Semantics

For active rows:

- `evidence_y` is cumulative clock-adapted observed selected numerator `Y_A(tau)`.
- `evidence_x` is the denominator used by the displayed E+F evidence line at `tau`.
- `rate` is `evidence_y / evidence_x`.
- `rate_pure` is the E-mode evidence-only rate:
  - before and at the A/B seam, cumulative numerator divided by cumulative denominator at `tau`;
  - after the A/B seam, cumulative numerator divided by the selected boundary denominator.
- `midpoint` and fan fields remain the selected Cohort projection from `_selected_cohort_group_rate_draws`.
- in E+F count mode, `forecast_y` must be forecast-only residual if the frontend stacks it above `evidence_y`. F mode remains pure forecast, so its count surface may represent total model-projected `Y`.

## Non-Goals

This work does not:

- introduce a new Monte Carlo pass;
- change primitive conditioning policy;
- change the source of primitive priors;
- admit raw window rows directly as whole-query evidence;
- make subject primitives A-clocked;
- replace the selected Cohort E+F projection reducer;
- solve hierarchical per-Cohort posterior dispersion.

## Implementation Shape

This is a small coherent cutover, not eight independent stage gates. Keep denominator construction, numerator placement, pairing, CDF/as-of aggregation, row projection, count semantics, tests, and cleanup close enough that no half-built display path becomes a new compatibility surface.

### Pass A. Build the Unified Selected Evidence Readout

Build or extend a named builder that consumes the existing runtime surfaces, especially the primitive-bound evidence already produced for conditioning. It should expose, for relevant carrier and subject primitives:

- raw admitted row counts;
- weighted/bound row counts;
- observed dates and retrieval dates;
- primitive source and destination;
- arrival-weight provenance;
- evidence role and scope key;
- skipped/off-clock counts.

Most of this is already present on `ConditionedTransitionPrimitive.weighted_evidence` and `to_provenance_dict`. The implementation should prefer consuming typed objects rather than parsing serialised provenance.

The builder must not open a second direct evidence path. It should use the same superset acquisition / primitive binding machinery that conditioning already uses, then read the typed bound surfaces from the resolved runtime.

For denominator evidence, use carrier primitives in the `A -> X` carrier span:

- read bound observed rows from the A-rooted carrier primitive evidence surface;
- map or aggregate them to selected A-day and A-clock `tau`;
- compose carrier primitives when the carrier is multi-edge;
- produce cumulative `X_A(tau)` cells.

For a one-edge carrier, the same carrier composition degenerates to the bound carrier row surface. Do not introduce a separate single-edge branch.

For numerator evidence, use subject primitives in the `X -> end` subject span:

- read subject observed rows from the X-rooted subject primitive evidence surface;
- place them onto A-clock ages using the conditioned carrier arrival distribution;
- compose through the full subject span for multi-hop subjects;
- produce cumulative `Y_A(tau)` cells.

The adapter must preserve the distinction between subject-side evidence and carrier-side evidence. Subject rows may supply numerator timing/progression, but only after carrier placement. For a one-edge subject, the same subject-span composition degenerates to one primitive. Do not branch to a terminal-edge numerator path.

### Pass B. Pair, Aggregate, and Wire Rows

Construct `SelectedAClockEvidenceCell` values only after both sides are expressed on the same selected A-clock.

The adapter must not emit a numerator for an A-day/age with no valid denominator basis. It may emit zero numerator with positive denominator.

Aggregate with CDF/as-of semantics inside the same row-wiring pass.

Use latest-at-or-before per selected A-day, then sum across selected A-days.

In `compute_cohort_maturity_rows_v3`, build `SelectedAClockEvidence` after `ResolvedCFRuntime` exists, because the adapter needs conditioned runtime clocks and primitive evidence.

Pass the result into `_project_runtime_rows` and `_selected_cohort_group_rate_draws`.

For active rows without a valid clock-adapted evidence object, emit no evidence-named fields. The E+F projection can still render through midpoint/fan.

### Pass C. Fix Count-Mode Semantics and Remove the Old Path

If active E+F rows expose projected mass fields, ensure frontend consumers do not double count.

Keep the existing E+F stacked-count contract: `forecast_y` is forecast-only residual above `evidence_y`, not total projected `Y`, when that field is consumed by the E+F stack. Do not change F mode: pure forecast remains the total model-projected count surface.

Treat `_prepare_active_selected_evidence_frames` as a temporary and suspect source. The desired endpoint is no active evidence display fields sourced from `compose_path_maturity_frames`. After the new adapter is live, remove dead active-evidence frame callers and stale transition helpers unless a still-live non-active path demonstrably owns them.

## Remaining Implementation Checklist

The remaining cutover should be treated as one clean-up-and-proof pass, not as optional follow-up work.

Collapse the candidate boundary so per-edge evidence feeds raw `EvidenceCandidate[]` values directly into the one request pool. Do not retain a round trip through an intermediate evidence-set object if the only purpose is to unpack it back into candidates for primitive binding.

Remove target-edge special evidence construction in `forecast_runtime.prepare_forecast_runtime_inputs()` once the descriptor path covers target, subject, and carrier edges uniformly. Target evidence should then be one role of the shared descriptor-driven acquisition path, not a privileged source.

Rename or retire `build_per_edge_evidence()` and compatibility labels that imply an independent evidence authority. Surviving names should make clear that per-edge evidence is candidate acquisition for primitive binding, not a separate display or conditioning source of truth.

Re-author the outside-in active tests so their oracle derives expected evidence from the fetch envelope and primitive-bound semantics. The oracle must not be a direct comparison against raw cohort-family rows, because those rows have not yet been bound to the primitive identity or placed on the selected A-clock.

Expand and settle diagnostics so each selected A-clock evidence cell can explain:

- fetched raw row lineage;
- primitive binding;
- clock-map decision;
- topology composition;
- final selected A-day and A-clock `tau` placement.

Audit dead code after the cutover and remove or prove dead stale helpers, including active-evidence frame callers, tuple bridges, and old adapter labels that remain reachable.

Re-run the focused runtime and outside-in tests after cleanup, with failures treated as evidence that the old and new surfaces still disagree rather than as test-only fallout.

## Test Plan

### Time-Shift Adapter Tests

Add small deterministic tests for the adapter's clock placement and CDF/as-of aggregation:

- one selected A-day, single-hop carrier and subject;
- two selected A-days with staggered observations;
- missing exact `tau` row that must carry forward once;
- multi-hop subject where terminal-edge `x` differs from query `X`;
- zero numerator with positive denominator;
- zero denominator produces absent/undefined rate, not zero.

Tests must explicitly fail if the implementation:

- branches to a separate single-hop path instead of naturally degenerating the span composition;
- sums multiple snapshots for one A-day;
- drops a selected A-day when no exact row exists at `tau`;
- allows `evidence_y` to decrease solely because an exact row is absent;
- uses a terminal-edge denominator in a multi-hop subject;
- uses model projection as evidence;
- bypasses the runtime's primitive-bound evidence surfaces with a direct evidence read.

### Runtime Tests

Update `test_selected_cohort_pop_d_distribution.py` to assert:

- `SelectedAClockEvidence` receives clock-adapted cells from runtime evidence, not manually injected frame cells;
- `_selected_cohort_group_rate_draws` consumes those cells without mutating `CohortEvidence`;
- active `rate_pure` freezes the boundary denominator after the seam;
- active `rate` uses the E+F evidence denominator, not the pure denominator.

### Outside-In Tests

Re-author the active tests in `test_cohort_factorised_outside_in.py` so the oracle matches the new semantics:

- resolve selected anchor-day set;
- drive production through normal superset evidence acquisition and primitive binding, not direct adapter injection;
- derive expected carrier and subject evidence independently from fixture observations only for the test oracle;
- apply the same A-clock adaptation concept independently of production row assembly;
- aggregate latest-as-of per selected A-day;
- assert row masses and rates at named ages.

The current exact-`tau` oracle is not sufficient because it treats missing rows at `tau` as absence rather than latest-as-of cumulative evidence.

### Regression Tests

Keep or update tests that prove:

- `window()` and `cohort(A = X)` identity cases are unchanged;
- active `A != X` numerator cannot appear before carrier arrival support;
- active multi-hop denominator remains query `X`;
- model overlay remains distinct from evidence and E+F projection;
- count mode does not double count evidence and forecast mass.

## Acceptance Criteria

The work is complete only when:

- active `cohort(A, X -> end)` evidence fields are populated from a provenance-valid clock-adapted selected evidence object;
- primitive conditioning and selected evidence display use the same clock-alignment machinery or explicitly shared runtime clock surfaces;
- evidence reaches conditioning and the selected A-clock adapter only through the evidence-superset interface, with no downstream snapshot/file evidence reads or source-family routing;
- row evidence is cumulative/latest-as-of per selected A-day;
- `rate_pure` and `rate` have distinct and documented denominator semantics in epoch B;
- single-hop and multi-hop active queries pass independent outside-in oracle tests through the same naturally-degenerating implementation template;
- no active evidence-named field is sourced from legacy frame composition alone;
- legacy active-evidence frame callers and transition helpers are removed or proven to be owned by a still-live non-active path;
- count-mode display does not double count projected mass;
- diagnostics can explain, for a row, which raw evidence and which clock adapter produced `X_A(tau)` and `Y_A(tau)`.

## Resolved Implementation Choices

The adapter should use the latency distribution map from the join-conditioned primitives. That is the runtime clock surface already produced by the shared conditioning/composition path, and it is the correct source for placing bound evidence onto the selected A-clock. Do not introduce a separate "posterior mean versus median versus draw-mean" timing choice for the display adapter.

Implement the adapter in `cohort_forecast_v3.py` for now, near `SelectedAClockEvidence` and the row projection path. A later extraction is only justified if the landed code becomes independently reusable without weakening the single runtime ingress.

The evidence-ingress abstraction is strict. Downstream runtime, adapter, and row-projection code must not read evidence from snapshot rows, parameter-file `_bayes_evidence`, or any other source-family-specific branch. It may consume only the evidence superset already fetched by the preparation/envelope layer. If evidence originally came from snapshot DB or parameter files, that distinction belongs upstream inside the superset fetcher and its provenance; it must not become a downstream routing decision.

This means the selected A-clock adapter may translate superset-provided evidence rows into typed candidates and pass those candidates into the one request pool, but it must not perform a fresh fetch, widen a query, deduplicate source families, or choose between "bayes" and "snapshot" evidence. Deduplication and source-family complexity stay behind the evidence-superset interface.

Conditioning evidence and chart evidence have different consumers but the same ingress boundary. Conditioning still receives evidence through the primitive/runtime conditioning machinery. The chart-visible active evidence fields, however, must read only from `SelectedAClockEvidence` after runtime placement. Active `evidence_x`, `evidence_y`, `rate`, `rate_pure`, selected-prefix display, and selected evidence diagnostics must not read legacy frame composition, target-edge special rows, raw cohort-family rows, or model projection fields.

The selected A-clock placement must use the join-conditioned runtime clock surfaces, not the upstream model-vars latency map or a primitive evidence clock tied to that upstream map. In particular, subject-side observed rows are placed onto the selected A-clock through the join-conditioned carrier/subject timing surfaces that come out of the shared conditioning/composition path. Any implementation that places display evidence using the upstream latency map, exact calendar `tau` alone, or raw cohort-family row age has missed the clock-adapter requirement.

## Immediate Execution Checklist

1. Delete downstream direct evidence reads from `edge_binding_descriptor.py` and the active selected-evidence runtime path. In particular, remove any `edge["_bayes_evidence"]` access from descriptor/candidate construction used by this path, and require the caller to supply evidence rows already returned by the evidence-superset interface.

2. Remove target-edge special evidence construction from `forecast_runtime.prepare_forecast_runtime_inputs()`. That function should prepare runtime/model/span metadata only; it should not build target-edge candidates, merge an `EvidenceSet`, or choose between source families.

3. Replace `build_per_edge_evidence()` and `build_per_edge_upstream_evidence()` with strictly named superset-output translation helpers. The helper names and docstrings must make clear that they translate already-fetched superset rows into typed `EvidenceCandidate` values; they are not evidence authorities, fetchers, mergers, or dedupers.

4. Wire `api_handlers.py` to pass only superset-derived candidate maps into `compute_cohort_maturity_rows_v3`. Both the cohort-maturity analysis route and the conditioned-forecast route must use the same candidate input shape for target, subject, and carrier edges.

5. Collapse `_aggregate_request_candidates()` so the request pool is built from raw `EvidenceCandidate` values only. Remove the `EvidenceSet` fallback, the candidate-lifting bridge, and any compatibility comments that describe `EvidenceCandidate[] -> EvidenceSet -> EvidenceCandidate[]` as acceptable.

6. Keep primitive/runtime conditioning unchanged in role: it consumes the one request candidate pool and performs primitive identity filtering plus runtime clock binding. Do not add direct evidence reads, source-family routing, or deduplication outside the evidence-superset interface.

7. Build chart-visible active evidence only through `_build_active_selected_a_clock_evidence_from_runtime()` and `SelectedAClockEvidence`. Active row fields `evidence_x`, `evidence_y`, `rate`, `rate_pure`, selected prefixes, and selected evidence diagnostics must not read legacy frame composition, target special rows, raw cohort-family rows, or model projection fields.

8. Verify selected A-clock placement uses join-conditioned runtime clock surfaces. Remove or fail any path that places selected evidence with the upstream model-vars latency map, a primitive evidence clock tied to that upstream map, or exact calendar age alone.

9. Expand diagnostics so each selected A-clock evidence cell reports: superset row lineage, primitive binding identity, join-conditioned clock-map decision, topology composition, and final selected A-day plus A-clock `tau` placement.

10. Update tests that currently inspect `EvidenceSet` maps to inspect raw superset candidates and runtime-bound evidence instead. Add/adjust guards proving no downstream `_bayes_evidence` read, no target special evidence construction, and no `EvidenceSet` bridge remains in the selected A-clock path.

11. Re-author the active outside-in oracle to derive expected chart evidence from fetch-envelope/superset output plus primitive-bound, latest-as-of selected A-clock semantics. It must not compare directly against raw cohort-family rows or exact-`tau` raw-row presence.

12. Run the focused verification set: candidate/runtime tests, selected A-clock runtime tests, and active outside-in cohort maturity tests. Treat failures as semantic evidence-flow or clock-placement defects until proven otherwise.

