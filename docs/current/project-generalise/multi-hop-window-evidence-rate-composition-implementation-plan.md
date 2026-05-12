# Multi-hop Window Evidence Rate Composition - Implementation Plan

**Status**: companion implementation plan for review  
**Date**: 11-May-26  
**Scope**: `cohort_forecast_v3` selected-evidence value construction for multi-hop `window()`, identity-carrier `cohort(A=X)`, and active `cohort(A!=X)` through one operator-supplied evidence path

## Progress Status

Current implementation state as of the first code pass:

- Partial implementation only. Do not treat this as a completed fix.
- Identity-carrier `window()` / `cohort(A=X)` selected evidence has been routed through a deterministic evidence-local subject-span propagation path.
- The first two outside-in evidence oracles passed before the later non-latency guard change; after that guard, only syntax compilation was verified because the shared Python server was unavailable to this agent's test process and must not be touched.
- Active `cohort(A!=X)` must be built through the same evidence-local path; do not preserve an old/new runtime branch as a staging mechanism.
- The deterministic push-forward helper is currently subject-span shaped. It must either become the final generic carrier/subject evaluator or be explicitly left as a short-lived adapter with no split production path.
- Non-latency/instant operators are now represented in the evidence-local path as `delta(0)` kernels when the conditioned primitive reports non-latent or zero-shift deterministic timing; focused BE-backed verification is still required.
- The durable Stage 1 operator-supply table is now recorded in this plan.
- The stale scalar-product midpoint test has not been renamed, reframed, or retired.
- Historical outside-in suite status from the user's full run before the code baseline was complete: 48 passed, 1 xfailed, 2 failed. The failures were:
  - `test_window_multihop_projected_midpoint_matches_successive_subject_projection_product` — known stale same-age scalar-product oracle; it needs the approved composed-kernel successor before it can be an acceptance target.
  - `test_v3_midline_at_saturation_converges_to_p` — active `cohort(A!=X)` selected-prefix/frontier defect matching `selected-a-clock-retrieval-frontier-provenance-proposal.md`; Stage 5 has not been completed.

## Purpose

This plan maps the algebra in `multi-hop-window-evidence-rate-composition-design.md` onto the current `cohort_forecast_v3` runtime. It is intentionally narrow. The expected production change should be a small correction to selected-prefix value construction, not a new forecast runtime, not a new fetch path, and not a chart-side reinterpretation.

The target outcome is:

- `evidence_x` remains selected mass at the denominator node `X`.
- `evidence_y` becomes selected mass propagated to the subject end through observed local primitive rates.
- `SelectedAClockEvidence` remains the single prefix object read by public rows and by the E+F reducer.
- coverage/support stays separate from value.

The current row/projection architecture is already close. The important mismatch is earlier: `_build_rate_attributed_subject_prefix` currently reads downstream primitive source mass from `_SelectedSourceDayMass`, a source-layer timing object. Multi-hop `window()` evidence needs a separate evidence-local ledger whose downstream mass is produced by observed-rate push-forward.

## Required Context

Before editing the CF runtime, read the standard warm-start docs plus the CF runtime set:

- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/codebase/FORECAST_RUNTIME_ARCHITECTURE.md`
- `docs/current/codebase/FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md`
- `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`
- `docs/current/codebase/BE_RUNNER_CLUSTER.md`
- `docs/current/codebase/STATS_SUBSYSTEMS.md`
- `docs/current/codebase/FE_BE_STATS_PARALLELISM.md`
- `docs/current/codebase/TESTING_STANDARDS.md`
- `docs/current/multi-hop-window-evidence-rate-composition-design.md`
- `docs/current/cohort-maturity-evidence-coverage-design.md`
- `docs/current/selected-a-clock-retrieval-frontier-provenance-proposal.md`

The binding invariants are the usual CF ones: one runtime path, identity carrier as data, projection as readout, displayed rate as `Y/X`, no count crossing between primitive edges, support separate from value, and visible degradation for missing required operators.

## Current Code Mapping

The implementation should stay concentrated in `graph-editor/lib/runner/cohort_forecast_v3.py`.

`compute_cohort_maturity_rows_v3` is the orchestrator. It should only attach the new selected-evidence object to the runtime and pass it through the existing builder. It must not contain rate propagation logic.

`build_resolved_cf_runtime` resolves the runtime object, primitives, subject/carrier spans, and source-layer timing transitions. It should remain a runtime resolver. Do not build the evidence-local ledger here, because the observed primitive buckets are only available later.

`_SelectedSourceDayMass` and `_build_selected_source_day_mass` are source-layer timing mass. They can continue to serve model-timing placement and diagnostics. They may serve denominator prefix construction only where that source-layer timing object is proven equivalent to the admitted carrier seed operator `B_{R->X}` for the selected-evidence value path. Otherwise `X_C(tau)` must come from the admitted carrier/identity seed operator, not from `_SelectedSourceDayMass`. They must not be treated as the evidence-local selected mass that reaches downstream subject primitives in a multi-hop `window()` value path.

`_build_observed_span_evidence_surface` is the correct place to obtain primitive-bound observed rows. Its `ObservedSpanEvidenceSurface.observed_count` is coverage/diagnostic material. Its `_SubjectChainEvidenceBuckets` output is the relevant value input because it preserves weighted `n/k` by edge, selected anchor, primitive source day, and tau.

`_build_rate_attributed_subject_prefix` is the right seam but the wrong mass contract. It should consume the evidence-local ledger, or be replaced by a helper that does. It should not read downstream mass from `_SelectedSourceDayMass`.

`_build_selected_a_clock_evidence_from_runtime` is the right integration point. It already pairs selected `X` prefix, selected `Y` prefix, and coverage into `SelectedAClockEvidenceCell`. After the new terminal prefix is built, this function should wire it through without introducing a window/cohort projection branch.

`SelectedAClockEvidence`, `_selected_cohort_group_rate_draws`, and `_project_runtime_rows` should mostly remain readouts. If a fix needs semantic code in those layers, re-check the upstream prefix contract first.

Frontend chart code should not be needed for the core fix. Cohort maturity rows pass backend fields through, and the chart already understands `evidence_x`, `evidence_y`, `rate`, and coverage fields. Adding a provenance label such as `evidence_projection` is optional unless the UX needs to display it.

## Implementation Target

Introduce a distinct evidence-local propagation ledger. Suggested name: `_SelectedEvidencePropagationLedger`.

Its job is to hold selected evidence mass at each subject primitive source node, on the selected Cohort scale, after applying observed local rate kernels from upstream subject primitives.

The intended end-state is a **generic deterministic push-forward evaluator**:

- input: a seed ledger, ordered primitive topology, and per-edge admitted kernel providers;
- output: selected mass ledgers at every reached node;
- no built-in knowledge of `window()` versus `cohort()`, carrier versus subject, or first hop versus downstream.

Subject and carrier code should be thin adapters around that evaluator. The subject adapter supplies `K_i` and reads the subject-end `Y` prefix. A future carrier adapter may supply `B_{R->X}` primitives and read the denominator `X` prefix. Operator admission remains outside the evaluator. This prevents the evaluator from silently authorising local-window subject kernels as carrier evidence.

It should be seeded at the denominator node `X` from the admitted `B_{R->X}` operator for each selected Cohort. For identity-carrier `window()` and `cohort(A=X)`, this seed is the X-rooted selected population. For active `cohort(A!=X)`, do not reuse model-timing carrier mass as the denominator merely because it exists; the active seed must be supplied as the same kind of admitted operator as every other mode.

It should propagate through the subject topology in order. Each primitive contributes observed local rate increments from `_SubjectChainEvidenceBuckets`; downstream primitive source mass must come from the previous propagation step, not from model-timing reach.

It should output the terminal selected `Y` prefix in the same shape currently expected by `SelectedAClockEvidence`: per selected anchor day, per tau, cumulative selected mass at the subject end, with compact provenance naming the rate-attributed local evidence propagation path.

It should not output ESS, posterior moments, model curves, or coverage. Those remain separate concerns.

Synthetic `x_frozen` / `y_frozen`, `evidence_x`, and `evidence_y` are mean selected-prefix masses for display and seam continuity. They are not direct Binomial evidence strength. Any uncertainty or support consumer must read explicit support/provenance surfaces, not infer sample strength from the displayed synthetic denominator.

## Operator Supply Contract

The first implementation task is to make the `B` and `K_i` operator contract explicit. Do not write the ledger until this is proved.

Expected contract:

- The denominator seed operator `B_{R->X}` is named for every mode and checked against any existing object proposed as its implementation.
- The first subject primitive at `X` may use source-day-specific local rates where selected source day and primitive row source day are the same object.
- Downstream `window()` primitives should use an age-only local rate kernel, because selected downstream source mass is synthetic and should not require same-calendar source-day identity.
- Identity-carrier `cohort(A=X)` should degenerate with `window()` when it receives equivalent primitive kernels.
- Active `cohort(A!=X)` must not silently switch into local-window mixing. Preserve the current selected A-clock/cohort-preserving semantics unless a separate oracle justifies movement.
- Non-latency or instantaneous subject and carrier primitives are valid operators, represented as point-mass-at-zero kernels, not missing timing surfaces. For carrier spans, an instant edge is a `delta(0)` step inside `B_{R->X}` composition.

For each supplied `K_i`, Stage 1 must prove the cumulative input is stable enough to difference: finite, bounded, monotone or explicitly repaired/degraded before differencing, with non-negative incremental mass and total mass in `[0, 1]`. Half-step, interpolation, curvature correction, latest-at-or-before, and other quadrature/discretisation choices belong to operator construction and must be named there, not hidden in row projection.

Support is supplied in parallel to value. The operator contract must name which admitted cells carry support for `B` and `K_i`, and must preserve the rule that forward-filled value does not create fresh support.

If `_SubjectChainEvidenceBuckets` cannot derive the required rate surface, support surface, or discretisation policy, stop and revise the bucket producer or the design. Do not read snapshot DB rows, parameter files, graph evidence fields, or model surfaces inside the selected-prefix helper.

Missing rates should degrade as missing operators. Do not convert absence of an admissible downstream rate into terminal zero evidence.

### Stage 1 Operator-Supply Table

The current implementation supplies the selected-evidence operators as follows:

| Query regime | `B_{R->X}` seed operator | First subject `K_0` | Downstream subject `K_i` | Support/admission surface | Status |
|---|---|---|---|---|---|
| Single-hop identity carrier (`window(X->Y)` / `cohort(X, X->Y)`) | Dirac identity at `X`, derived from `_SelectedSourceDayMass` identity composition and `_build_carrier_only_denominator_prefix` | Source-day-specific local rate from `_SubjectChainEvidenceBuckets.edge_nk_by_local_source_day`; `n × k/n` recovers direct observed `k` | Not applicable | `ObservedSpanEvidenceSurface` cells and exact-τ landing coverage | Implemented as a natural degeneracy of the evidence-local path. |
| Multi-hop `window(X->Z)` | Dirac identity at `X`, same seed as single-hop identity | Source-day-specific local rate for the `X` primitive | Age-only local-window rate kernel from `_SubjectChainEvidenceBuckets.edge_nk_by_local_source_day`; downstream selected mass comes only from prior push-forward through upstream `K` | Value uses the evidence-local ledger; coverage remains on observed-span support cells | Implemented for identity carrier; this is the public `synth-window-rate-prop` target. |
| Identity `cohort(A=X, X->Z)` | Dirac identity at `X`, same selected seed as equivalent `window()` when primitive kernels match | Same as multi-hop `window()` when supplied equivalent primitive rows | Same age-only downstream kernel when the bucket input is equivalent | Same as multi-hop `window()` | Implemented for identity carrier; parity with window is an acceptance target. |
| Active `cohort(A!=X, X->Z)` | Admitted selected carrier operator `B_{A->X}` supplying selected mass at X-days | Source-day-specific or reshaped primitive-local kernel supplied by binding | Source-day-specific or admitted scalarised kernel supplied by binding; no local-window shortcut unless explicitly admitted | Existing active support/frontier machinery with strict paired support remains the support source | Must use the unified evidence-local path; old/new branch preservation is not an acceptable implementation state. |
| Non-latency / instant primitives | `delta(0)` where an instant primitive participates in carrier composition | `delta(0)` local kernel: mass transfers on the same source day | `delta(0)` local kernel for downstream instant primitives | Same support/admission cells; instant timing is not missing timing | Implemented for the evidence-local subject adapter when primitives report non-latent or zero-shift deterministic timing; verification remains through focused BE-backed tests. |

This table is intentionally strict for active `cohort(A!=X)`: the implementation must not silently apply local-window subject mixing to active carrier cases. Active mode supplies its operators; the evaluator composes them.

Operator repair policy is now named in provenance. Age-only and source-day-specific cumulative rate surfaces record whether they were consumed unchanged, monotone-repaired, or collapsed to a `delta(0)` kernel. Coverage in the evidence-local value helper is support/share-like only: it is derived from binary support presence and capped to `[0, 1]`, never from selected population mass.

## Work Plan

### Stage 0 - Recon The Current Tree

Confirm the current state before editing:

- whether `cohort_forecast_v3.py` already contains residue from prior attempts;
- whether comments still encode the rejected contract that projection must never derive downstream mass from observed increments;
- which of the named outside-in tests are currently red and why;
- whether the drift snapshot assets from the design note still exist or need to be recreated.

Stop if the tree contains partial implementation residue that is unclear. Either work with it explicitly or ask before replacing it.

### Stage 1 - Prove Operator Supply

Inspect `_SubjectChainEvidenceBuckets` for three cases:

- single-hop identity carrier;
- `synth-window-rate-prop` multi-hop `window()`;
- active `cohort(A!=X)` with a multi-hop subject.

Produce a small recon table naming, for each primitive:

- the seed/rate operator supplied (`B` or `K_i`);
- primitive timing class: latent-latency, non-latency/instant `delta(0)`, or degraded;
- whether the value surface is source-day-specific, age-only, or absent/degraded;
- the cumulative surface being differenced;
- the non-negativity, boundedness, and monotonicity status;
- the quadrature/discretisation policy;
- the support/admission surface carried in parallel.

For `synth-window-rate-prop`, prove that the downstream `wrp-b -> wrp-c` age-only kernel matches the independent DB oracle used by `test_window_multihop_evidence_matches_rate_attributed_db_oracle`. Also prove the first `wrp-a -> wrp-b` primitive degenerates to selected X-window evidence.

This stage may use a temporary diagnostic or focused test, but it should not add a permanent second evidence source. If the proof fails, do not continue to ledger wiring.

### Stage 2 - Add The Evidence-Local Ledger

Add the new ledger near the existing selected-prefix dataclasses. Keep it small and explicit:

- seed selected mass at `X`;
- derive primitive local rate increments from the Stage 1 operator adapter;
- push selected mass forward through subject topology;
- expose terminal cumulative mass at the subject end;
- record compact per-edge provenance and missing-rate diagnostics.

If implementation time allows, factor the push-forward loop as a generic evaluator now and keep the subject-specific decisions in a subject adapter. If not, record the subject-only shape as an interim cut and do not present it as the final carrier-capable abstraction.

Do not mutate `_SelectedSourceDayMass`. Do not change `_project_runtime_rows`. Do not touch primitive conditioning, fetch envelopes, or chart rendering.

Acceptance for this stage is an inside proof on `synth-window-rate-prop` showing selected mass at `wrp-a`, propagated selected mass at `wrp-b`, terminal selected mass at `wrp-c`, and the local rates used. The proof must distinguish the correct synthetic selected mass from terminal raw same-anchor counts and from the downstream local denominator.

This stage must preserve the support projection contract from Stage 1. Value propagation may forward-fill where the operator policy allows it; support/freshness must remain tied to real admitted operator cells.

### Stage 3 - Wire The Repaired Prefix

Update `_build_selected_a_clock_evidence_from_runtime` so `y_at_subject_end` comes from the evidence-local terminal prefix. Keep `x_at_query_x` on the admitted `B_{R->X}` denominator prefix, or on an existing selected denominator prefix only after Stage 1 proves that prefix is equivalent to the admitted `B` operator. Keep coverage fields on the existing support surfaces.

Set `runtime.selected_y_prefix` from the same terminal prefix that rows consume. This is the seam invariant: row `evidence_y` and the reducer observed-prefix branch must read the same repaired selected prefix at `tau_solid_max`.

Do not use `ObservedSpanEvidenceSurface.observed_count` as the selected numerator. Do not cap `Y` to `X` in projection. If `Y > X` appears, expose it and fix the upstream ledger or kernel contract.

### Stage 4 - Establish The Code Baseline

Do not run or edit oracle tests in this stage. Establish the code baseline from
runtime structure and diagnostics only:

- confirm which path calls the evidence-local ledger and for which regimes;
- confirm the operator-supply table matches the code actually wired at the seam;
- inspect representative diagnostic/provenance payloads for `B`, `K_i`,
  `selected_y_prefix`, and support/coverage sources;
- record known current code gaps without changing tests to fit them.

The stale same-age scalar-product oracle remains untouched here. It is not part
of the code baseline. The purpose of this stage is to know exactly what has
been built before spending effort on test-gate work.

### Stage 5 - Complete Unified Runtime Wiring

Finish the runtime shape before any test-gate work:

- remove any old/new selected-prefix branch whose only purpose is staging;
- ensure `window()`, `cohort(A=X)`, and active `cohort(A!=X)` all call the same evidence-local evaluator;
- keep mode-specific logic in operator supply only: `B_{R->X}`, primitive `K_i`, support/provenance, and discretisation policy;
- ensure active `B_{A->X}` and subject `K_i` are admitted operators before they reach the evaluator;
- ensure non-latency/instant subject and carrier primitives enter as `delta(0)` operators;
- ensure row projection remains a readout of the repaired selected prefix.

Do not split the runtime down the middle to make this easier. The point of this work is to remove the parallel evidence paths, not to add another staged fork.

### Stage 6 - Clean Up And Document The Contract

Remove temporary diagnostics and shadow helpers that are not part of normal provenance. Keep any diagnostic payload compact and gated by diagnostic mode.

Update the semantic design with the final bucket/rate-kernel contract if implementation evidence changes the expected source-day versus age-only decision.

Update `FORECAST_RUNTIME_SEMANTIC_PSEUDOCODE.md` if the evidence-local ledger becomes a maintained runtime object.

Leave no comments claiming that `_SelectedSourceDayMass` is the evidence-local downstream value ledger.

Only after the code baseline, unified runtime wiring, and cleanup are recorded,
run focused outside-in tests and request, if still needed, explicit approval to
replace the stale scalar-product oracle test with a composed-kernel successor.
The current test name and target are not an acceptance contract for this work;
the successor should assert the convolutional subject-kernel functional
described in the semantic design. Do not weaken, reframe, rename, or replace
any protected oracle assertion without explicit approval.

## Non-Goals

Do not change `window()` binding semantics. Window primitives remain local-clock and cohort-mixed by design.

Do not add a fetch path, primitive-conditioning path, DB read, parameter-file read, or chart-only correction.

Do not rescale visible `evidence_x` or `evidence_y` with ESS.

Do not use terminal raw counts, count max-flow, or same-anchor downstream counts as the selected terminal value for multi-hop `window()`.

Do not introduce a staged flag-off architecture whose acceptance relies on the old path still running. This work is a semantic correction to the selected evidence path; verification happens after the unified code path is built, not by preserving a dormant alternative.

## Acceptance Criteria

The work is complete only when:

- `_SubjectChainEvidenceBuckets` has a documented `B`/`K_i` operator-supply contract;
- a separate evidence-local ledger owns downstream selected evidence mass;
- the deterministic push-forward logic is either generic already, or explicitly marked as an interim subject-span adapter with a follow-up to split evaluator from subject/carrier operator supply;
- `_SelectedSourceDayMass` remains source-layer timing mass;
- denominator prefix construction uses `_SelectedSourceDayMass` only where it is proven equivalent to the admitted `B_{R->X}` operator;
- single-hop and identity-carrier cases recover direct observed evidence through natural degeneracy;
- multi-hop `window()` uses the agreed downstream local-rate kernel;
- `synth-window-rate-prop` public rows match the independent rate-attributed DB oracle;
- `window()` and `cohort(A=X)` match for equivalent identity-carrier selected-evidence rows;
- row evidence and the E+F reducer read the same selected prefix at the seam;
- dense, aligned, factorised active `cohort(A!=X)` cases remain parity unless prior operator invalidity is proven;
- non-latency subject and carrier primitives are recognised as `delta(0)` kernels where present, not degraded as missing timing;
- support/coverage and statistical strength remain separate from propagated display value;
- no new duplicate runtime, row-projection semantic branch, or chart-only patch is introduced.
