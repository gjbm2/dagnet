# 73n Unified CF Runtime Invariants and Current-State Audit

**Status**: Active invariant checklist and current-state audit — latest status 3-May-26  
**Date opened**: 2-May-26  
**Scope**: 73n closure work for carrier evidence conditioning and CF runtime unification

## Purpose

This note records the design invariants that must hold before 73n can be considered complete under the spirit and letter of 73g.

The goal is not merely to remove old code. The goal is to leave one algebraically and semantically defensible CF machinery path:

- one primitive evidence-binding pathway;
- one primitive conditioning pathway;
- one request-scoped primitive set;
- one primitive-span composition substrate shared by carrier and subject roles;
- one subject-span consumer whose one-edge case is the natural single-hop degeneracy;
- one carrier/window/cohort runtime object where `window()` is a degenerate case, not a special branch;
- one projection path for rows, CF scalars, and graph fields.

## Source Contracts

This audit is bound by:

- `docs/current/project-bayes/73g-general-purpose-f14-problem-and-invariants.md`
- `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`
- `docs/current/project-bayes/73n-carrier-evidence-conditioning-implementation-plan.md`

Any implementation that violates these contracts is wrong even if a narrow test turns green.

## Stage Namespace and Closure Semantics

This document defines **closure stages** for the final unification pass. They are not the same stage numbers as `73n-carrier-evidence-conditioning-implementation-plan.md`, whose migration stages include Stage 5a, Stage 5b, Stage 5c, Stage 6, and later staged cutovers.

Do not cite a bare "Stage 3" or "Stage 6" without naming the document. Use "73n implementation Stage 5b" for the older migration plan and "this audit's Closure Stage 3" for the stages below.

The older migration stages and flags may exist while work is in progress. They are not acceptable final architecture. A staged readout, staged diagnostic sentinel, or implementation-coupled staged test is a scaffold unless the audit explicitly says it has become a role-labelled runtime concept. 73n closure requires deleting, subsuming, or quarantining that scaffold from the public CF row/scalar path.

## Latest Current State — 3-May-26

This section supersedes the earlier "Current Code State" snapshot below and Appendix A's 2-May session audit. Those sections remain as historical records of how the branch got here; this section is the current project status.

### Completed In Code Since Appendix A

**The public CF row/scalar path no longer dispatches through staged readouts.**  
`build_resolved_cf_runtime(...)` in `graph-editor/lib/runner/cohort_forecast_v3.py` now calls one runtime helper rather than selecting among the old single-hop, multi-hop subject, multi-hop window, or active-cohort carrier readouts.

**The staged readout APIs have been removed from `primitive_readout.py`.**  
The old `compute_single_hop_readout`, `compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`, and `compute_active_cohort_carrier_readout` surfaces are no longer live runtime APIs. `primitive_readout.py` now owns the unified primitive-backed runtime assembly helper and the shared edge-resolution dataclasses.

**`ResolvedCFRuntime` now carries the Closure Stage 1 contract fields.**  
The runtime object now carries population root, denominator node, subject end, numerator representation, admission policy, arrival map, evidence-resolution registry, conditioned primitive map, carrier span role object, subject span role object, projection provenance, runtime provenance, and public moments.

**Primitive preparation ownership is centralised for the public path.**  
The unified runtime helper owns subject and optional carrier primitive enumeration, request-rooted prefix-arrival map construction, canonical evidence binding, primitive conditioning, registry registration, conditioned primitive map population, and role-labelled carrier/subject span construction.

**Window/cohort assembly now flows through one runtime helper.**  
`window()`, `cohort(A = X)`, and active `cohort(A != X)` all enter the same runtime assembly path. Identity carrier cases are data on the runtime object; active carrier cases carry an `A -> X` carrier role object.

**Carrier and subject runtime spans use one conditioned-primitive composition substrate.**  
The public runtime carrier role and subject role both compose through `compose_primitive_span(...)` over conditioned primitives. The previous active-carrier path that adapted conditioned primitives into a flatter carrier-only transition shape is no longer live.

**A shared timing algebra has been introduced and live runtime timing callers are being migrated to it.**  
`graph-editor/lib/runner/timing_span.py` provides role-neutral timing composition. `prefix_arrival.py`, `subject_span_composer.py`, `forecast_state.py`, and `forecast_runtime.py` now use that shared timing algebra for their live timing calls. The refactor was corrected to preserve the old carrier MC-CDF behaviour: the shared timing path carries transition dispersion fields and uses `mc_span_cdfs(...)` for MC carrier CDFs, matching the previous carrier composer on direct equivalence smokes.

**Projection now reads public moments and provenance through `ResolvedCFRuntime` methods.**  
`compute_cohort_maturity_rows_v3(...)` projects primitive-backed public moments through the runtime object. Runtime provenance is built from role fields on `ResolvedCFRuntime`, with low-level diagnostics nested only as forensics.

**Closure Stage 5's row/scalar projection boundary has been cleaned in code.**  
`compute_cohort_maturity_rows_v3(...)` no longer patches saturation-row `forecast_y / forecast_x`, `midpoint`, or fan bands to force convergence to `p_infinity_mean`. Public `p_infinity_*` projection is isolated in `_project_public_moments_for_rows(...)`, scalar fallback calculation is isolated in `_fallback_public_moments_from_trajectory(...)`, observed chart evidence projection is isolated in `_evidence_display_at_tau(...)`, and row formatting is isolated in `_project_cohort_maturity_rows_from_runtime(...)`. The row builder now orchestrates frame evidence, trajectory execution, runtime public moments, and row formatting rather than owning projection semantics inline.

### Verification Performed In This Session

- Python compile checks passed for the edited runtime files.
- Direct runtime smokes passed for identity-carrier and active-carrier cases.
- Prefix-arrival timing smoke passed.
- `build_x_provider_from_graph(...)` and `build_node_arrival_cache(...)` smokes passed.
- Direct equivalence smoke between old `compose_carrier_to_x(...)` and new shared timing composition passed for deterministic reach/CDF and MC CDFs under the same RNG seed.
- `ReadLints` reported no diagnostics on edited runtime files.
- `git diff --check` reported no whitespace errors on edited runtime files.
- For the Stage 5 cleanup specifically, `py_compile`, `ReadLints`, and `git diff --check` passed on `graph-editor/lib/runner/cohort_forecast_v3.py`.

These checks are not a substitute for test-suite reconciliation or outside-in acceptance.

### Not Yet Complete

**Test reconciliation is not done.**  
Several old unit tests still import deleted staged readout APIs or the deleted/retired carrier composition surface. These tests must be deleted, rewritten around `ResolvedCFRuntime`, or explicitly quarantined as migration-only tests before acceptance. This is Closure Stage 6 work.

**Outside-in acceptance has not been rerun.**  
No claim should be made that the public semantic suite is green. The existing outside-in contract remains authoritative and must not be softened to accommodate this refactor.

**Per-τ row quantities remain trajectory-owned by design.**  
The Stage 5 cleanup explicitly separates public scalar projection from trajectory projection. `p_infinity_*` is the public conditioned scalar surface; `midpoint`, fan bands, forecast X/Y, evidence rows, and completeness are row trajectory/display quantities projected from prepared frame evidence and `compute_forecast_trajectory`. The row builder no longer forces these trajectory quantities to converge to `p_infinity_mean`. Outside-in tests that asserted forced saturation convergence must be discussed and rewritten around this contract before acceptance.

**The shared timing refactor needs full test reconciliation.**  
Direct equivalence smokes passed for representative deterministic and MC cases, but the old carrier-composition contract tests still need to be translated to the new `timing_span` surface so the equivalence is durable and reviewable.

**Maintained codebase docs are stale.**  
Several codebase docs still describe staged readouts, old carrier composition, or old subject composer names. Do not mark Closure Stage 7 complete until the maintained docs are updated after tests settle.

### Current Closure Stage Status

**Closure Stage 1 — Runtime Object Contract: mostly implemented, not acceptance-proven.**  
`ResolvedCFRuntime` now carries the required contract fields. Remaining work is proving all live consumers project from those fields correctly.

**Closure Stage 2 — Primitive Preparation Owner: implemented for the public row/scalar path, not fully test-reconciled.**  
The live public path has one primitive preparation owner. Old tests and docs still reference removed staging surfaces.

**Closure Stage 3 — General Primitive-Span / Timing Substrate: implemented in code, not acceptance-proven.**  
Carrier and subject runtime spans share `compose_primitive_span(...)`. Prefix-arrival and legacy carrier-support timing callers have been moved to shared `timing_span` logic. Equivalence smokes passed, but formal tests still need migration.

**Closure Stage 4 — Unified Runtime Assembly: mostly implemented.**  
The runtime builder now assembles window, identity-cohort, and active-cohort requests through one helper with carrier identity/composition represented as data. Remaining concern is test and outside-in proof.

**Closure Stage 5 — Row/Scalar Projection Cutover: implemented in code, not acceptance-proven.**  
Public scalar moments and runtime provenance project through `ResolvedCFRuntime`; row trajectory fields are formatted from prepared frame evidence and `compute_forecast_trajectory` without re-deciding or repairing scalar semantics. The remaining work is Stage 6 proof: reconcile tests and outside-in assertions with the cleaned contract.

**Closure Stage 6 — Test and Diagnostic Reconciliation: not done.**  
This is the next major work item. Stale staged-readout and carrier-composition tests must be rewritten or removed without weakening outside-in semantic assertions.

**Closure Stage 7 — Dead-Code and Stale-Doc Audit: not done.**  
Some dead runtime surfaces have been deleted, but stale docs/tests/comments remain. Static search plus targeted tests are still required.

## Design Invariants

### A. Wall-Clock Evidence Offset Binding

Every primitive must bind evidence on the primitive source-node clock induced by the request root.

`window()` requests are the trivial case: the population root is `X`, so source-node evidence at `X` uses the request source clock directly.

`cohort()` requests are the general case: the population root is `A`, so a downstream primitive `U -> V` must bind evidence on the `U`-arrival clock induced by the prefix topology from `A` to `U`.

Both cases must use the same request-scoped arrival-weight abstraction. The difference is the contents of the map, not a different binding pathway:

- root/source node: identity membership over selected root days;
- downstream nodes: latency-adjusted arrival weights from the same prefix-arrival map;
- degraded or unsupported prefixes: explicit degraded provenance, not silent identity fallback.

An `arrival_map.get(source_node)` miss is never an identity case. Identity weights are valid only for the request root entry, or for the explicit `window()` / `cohort(A = X)` carrier identity represented in the runtime object. A non-root map miss must become degraded or unavailable provenance before conditioning; it must not bind raw rows as if the source clock equalled the request root clock.

### B. Doc-52 Blend Ownership

Doc-52 subset/effective-evidence handling must be applied exactly once, at primitive posterior construction.

Raw evidence `E`, weighted primitive evidence, effective evidence `e`, `m_S`, `m_G`, `r`, and the raw-nonempty/full-subset-limit case must be represented on the primitive. Composed consumers must not re-apply subset logic, mass-ratio correction, compatibility blending, or evidence discounts.

When effective conditioning pressure is zero, the primitive must explicitly encode the identity/equality case rather than relying on accidental numerical equality.

### C. Single Evidence-Binding Pathway

There must be one live primitive evidence-binding pathway.

The canonical path is:

- admitted raw evidence candidates are merged by the shared merge layer;
- each admitted point is multiplied by `arrival_weight[U][observed_date]`;
- off-clock rows are rejected with provenance;
- the resulting weighted primitive evidence view is passed to primitive conditioning.

No live CF readout may hand-roll `PrimitiveEvidenceResolution`, synthesise ad hoc weighted views, or bypass the canonical binder.

### D. Single Conditioning Pass

There must be one live primitive conditioning pass.

The canonical pass consumes a bound primitive evidence resolution plus resolved model parameters and emits one `ConditionedTransitionPrimitive`.

No-evidence and prior-only behaviour must be the zero-evidence degeneracy of the same pathway. Live CF row/scalar projection must not call a separate prior-only constructor or maintain a parallel unconditioned primitive-building path.

### E. Single Request-Scoped Primitive Set

A request must enumerate all primitives needed by the runtime object before projection:

- subject primitives for the full `X -> end` subject topology;
- carrier primitives for `A -> X` when `cohort(A != X)`;
- no carrier primitives when `window()` or `cohort(A = X)` because the carrier is identity;
- no residual/complement primitives unless they are explicit deterministic graph semantics.

Each primitive identity plus scope plus evidence-clock alignment identity should produce one request-local primitive entry. `window()`, `subject_span`, `carrier_to_x`, rows, scalars, and graph fields must consume this primitive set rather than independently rebuilding primitives.

For active `cohort(A != X)`, carrier primitives are not accepted as complete merely because tests can inject upstream evidence into a hook. Public acceptance requires the runtime evidence retrieval path to enumerate, fetch, bind, and condition upstream `A -> X` primitive evidence through the same request-scoped primitive owner. A carrier primitive may be prior-only only when canonical retrieval/admission found no live evidence for that primitive, and that fact is represented on the primitive provenance.

### F. Single Primitive-Span Composition Substrate

Carrier construction and subject-span construction must be role-labelled uses of one general primitive-span operation.

The fully general operation is:

`compose_primitive_span(root, end, conditioned_primitive_map, options) -> ComposedPrimitiveSpan`

It should produce:

- composed reach probability;
- conditional timing CDF;
- coherent per-draw probability/timing when every primitive is draw-coherent;
- moments-only or degraded provenance when composition cannot provide coherent draws;
- topology and primitive provenance.

`carrier_to_x` and `subject_span` are semantic wrappers over that same composed span type:

- `carrier_to_x = compose_primitive_span(A, X, role=denominator)`
- `subject_span = compose_primitive_span(X, end, role=numerator)`

The wrappers may enforce semantic boundaries and expose role-specific names. They must not own separate graph algebra, timing algebra, draw-coherence logic, horizon truncation policy, or primitive lookup machinery.

Current code reference: `graph-editor/lib/runner/subject_span_composer.py` owns `compose_subject_span`, which consumes `ConditionedTransitionPrimitive` objects and performs primitive draw/moment composition for `X -> end`. `graph-editor/lib/runner/carrier_composition.py` owns `compose_carrier_to_x`, which consumes a flatter `TransitionPrimitive` shape and composes `A -> X` via `span_kernel.compose_span_kernel`. These already share conceptual DAG/span algebra, but they are still separate construction surfaces. 73n completion should collapse the construction substrate while preserving role-labelled semantic wrappers.

A temporary adapter from `ConditionedTransitionPrimitive` into a flatter carrier-only primitive shape is not a closure substrate unless it preserves probability posterior, timing posterior, draw-family identity, degraded/moments-only status, horizon policy, and primitive provenance without loss. If the carrier can see only conditioned `p` plus resolver timing while the subject sees the full conditioned primitive, invariant F is still violated.

### G. Single Subject-Span Handler

There must be one subject-span handler for `X -> end`.

Single-hop is a one-edge subject span. Multi-hop is the full `X -> Z` subject span. Both must pass through the same handler and composer.

The handler must never collapse a multi-hop subject to the terminal edge, and it must not ask “single-hop or multi-hop?” as a semantic routing question. Topology length may appear in diagnostics or performance notes, but not as a separate conditioning or projection branch.

### H. Single Cohort/Window Handler

There must be one runtime handler for `cohort()` and `window()` semantics.

`window()` is the simplified degenerate case:

- population root is `X`;
- `carrier_to_x` is identity;
- no upstream carrier latency is applied;
- Pop C is empty because later arrivals to `X` belong to later windows;
- Pop D remains subject-side future numerator mass only under factorised representation.

`cohort()` is the general case:

- population root is `A`;
- `carrier_to_x` composes `A -> X` when `A != X`;
- `carrier_to_x` degenerates to identity when `A = X`;
- Pop C exists only when `A != X`;
- Pop C and Pop D are handled according to the selected numerator representation.

These are natural polymorphic degeneracies of the same runtime object, not separate CF engines.

### I. Displayed Rate Is Always `Y / X`

The public rate is always the subject-end numerator over the denominator at `X`.

`cohort()` changes the selected population and time origin. It must not change the displayed rate into `Y / A`.

Carrier reach may affect absolute counts and future denominator mass. It must not multiply the displayed subject rate as if carrier reach were part of the numerator probability.

### J. `carrier_to_x` Owns Denominator Arrival

For `cohort(A, X -> end)`, `carrier_to_x` answers who reaches `X` by tau.

For `window()` and `cohort(A = X)`, `carrier_to_x` is identity. There is no upstream carrier solve beyond `X`, and denominator-side Pop C vanishes.

The numerator side must not quietly consume anchor-to-`X` semantics except through `carrier_to_x`.

### K. `subject_span` Owns Numerator Progression

`subject_span` answers “given mass at `X`, when does it reach the subject end?”

Single-hop uses one edge. Multi-hop uses the full `X -> Z` span. A last-edge clock or last-edge probability is only valid when the subject span is literally one edge.

### L. Factorised and Gross-Fitted Numerators Are Mutually Exclusive

Under factorised representation, carrier and subject objects are combined and Pop C / Pop D may remain additive future numerator terms.

Under gross-fitted numerator representation, the fitted numerator already contains future numerator mass. Pop C and Pop D must not be re-added.

Admission into gross-fitted whole-query mode requires the exact same semantic question: same mode, anchor/time origin, denominator node `X`, full subject span, slice/context/as-at, selected Cohorts, temporal evidence basis, and weighting procedure.

### M. Raw Evidence Reuse Must Respect Semantic Clocks

Raw rows from `cohort(X, X -> end)` are on the `X` clock. Raw rows from `cohort(A, X -> end)` are on the `A` clock.

Even if the downstream subject span matches, raw rows are not directly reusable across different anchors until the carrier-induced evidence clock has been applied.

Subject-side model vars may be reusable only as an `X`-rooted helper when metadata and temporal evidence basis are compatible. Raw rows and whole-query model vars require exact semantic match.

### N. Projection Must Not Re-Decide Semantics

Rows, CF scalar responses, graph enrichment fields, overlays, and diagnostics must project the already-resolved runtime object.

Projection must not choose evidence families, rebuild carriers, switch subject-span definitions, substitute terminal-edge behaviour, recondition `p`, apply doc-52 logic, or patch mature rates after the fact.

Projection must also not synthesise fallback `EvidenceSet` objects from compatibility metadata such as `p_conditioning_evidence` on the closure path. Such shims are migration-only scaffolding. At closure, compatibility fields may be exposed as provenance, but they cannot decide or manufacture primitive evidence.

### O. Tests Must Prove Public Semantic Contracts

The outside-in suite is the semantic acceptance gate.

Unit tests may cover lower-level substrate contracts, but tests must not preserve 73n implementation Stage 5a/5b/5c/6 routing labels, hop-specific function names, or implementation quirks as durable requirements.

If diagnostics change, diagnostic assertions may change. Rate semantics, numerator/denominator semantics, convergence invariants, strict xfail intent, and public-path assertions must not be softened to accommodate the refactor.

Any test that asserts migration-stage names, staged eligibility predicates, staged sentinel keys, or rollback flag routing must be treated as a temporary scaffold test. It may protect an in-progress atom, but it must be deleted, rewritten around the public runtime object, or moved behind an explicit migration-only test marker before atomic acceptance. The final suite should include public-path or static assertions that staged sentinels and staged readout labels are not live runtime semantics.

## Historical Code State Snapshot — 2-May-26

This section reflects the code state observed on 2-May-26 while 73n branch work was still changing. It is now historical; use "Latest Current State — 3-May-26" above for the current project status.

### Satisfied or Largely Satisfied

**Single evidence binder is the only live binding pathway.**  
`graph-editor/lib/runner/primitive_evidence.py` owns `bind_primitive_evidence`. All four staged readouts in `graph-editor/lib/runner/primitive_readout.py` call this binder for both evidence-bearing and empty-candidate cases. The previous synthetic shim `_synthetic_identity_resolution` (which hand-built a `WeightedPrimitiveEvidenceView` with `arrival_weight = 1.0` and bypassed the merge layer) and the inline `PrimitiveEvidenceResolution(raw_evidence_set=None, ...)` blocks for prior-only edges have been deleted. The binder also no longer carries an `is_degraded` branch: empty or zero arrival weights produce a uniformly shaped zero-row weighted view through the same code path as live evidence, and `PrimitiveEvidenceResolution.weighted_view` is therefore non-optional.

**Single primitive constructor is live in staged readouts and the parallel constructor is gone.**  
Current staged readouts call `condition_primitive` for evidence-bearing and empty-candidate cases. Empty candidates bind to zero weighted evidence and become the prior-only degeneracy inside the same conditioning path. `condition_prior_only_primitive` has been deleted from `runner.primitive_conditioning`; the only remaining test fixture that invoked it (`tests/test_subject_span_composer.py::_build_prior_only_primitive`) now constructs prior-only primitives through the canonical binder + conditioner pathway. Degraded-topology detection inside `condition_primitive` no longer keys on `weighted_view is None`; it inspects `weighted_view.arrival_weight_summary['topology_case']` for the `'degraded'` tag emitted by the binder when every raw point is rejected off-clock.

**Trajectory-local aggregate IS appears retired.**  
`graph-editor/lib/runner/forecast_state.py` now describes `compute_forecast_trajectory` as a pure projector, with primitive conditioning owned by `runner.primitive_conditioning.condition_primitive`. The trajectory engine still surfaces the legacy doc-52 fields (`r`, `m_S`, `m_G`, `blend_applied`, `blend_skip_reason`) on its return value, but they are now hard-coded to the "engine no longer applies the blend" sentinel — the substrate owns doc-52 entirely.

**Legacy carrier-projection rebuild appears retired from cohort evidence frame building.**  
`graph-editor/lib/runner/cohort_forecast_v3.py` now states that `build_cohort_evidence_from_frames` no longer constructs Tier 1/2/3 upstream carriers; active carrier behaviour is owned by primitive-backed composition.

### Partially Satisfied

**Wall-clock evidence offset binding is now real for multi-hop and active-cohort cases.**  
`graph-editor/lib/runner/primitive_readout.py` contains `_build_request_arrival_map`, which converts each readout's per-edge `(transition, resolved_model)` pairs into `TransitionPrimitive` instances via `_resolved_to_carrier_transition` (with an `alpha/(alpha+beta)` fallback when `p_mean` is unset) and delegates to `prefix_arrival.build_prefix_arrival_map`. 73n implementation Stages 5b, 5c, and 6 now each construct one real `PrefixArrivalMap` per request — implementation Stage 5b/5c rooted at `X` (the request root), implementation Stage 6 rooted at `A` (the active anchor) and covering both the carrier closure `A → X` and the subject closure `X → end`. Each readout per-edge looks up `arrival_map.get(transition.source_node)`: identity at the root, composed normalised arrival distribution at downstream nodes via `compose_carrier_to_x`. The empty-stub builders `_build_synthetic_window_prefix_arrival_map` and `_build_active_cohort_prefix_arrival_map` are deleted.

The `PrefixArrivalMap` root-entry contract changed in support of this. The root entry now holds `root_day_weights` verbatim (no normalisation); downstream entries are still normalised probability distributions because the convolution layer normalises internally before composing. This means an identity-mask root input `{d: 1.0 for d in window}` survives as identity-mask weights at the root — every in-window row keeps its full evidence pressure when the binder multiplies `n × arrival_weight` — while downstream evidence is correctly weighted by the latency-induced arrival distribution at the source node. Tests in `test_prefix_arrival.py` and `test_primitive_evidence.py` were updated to encode the new contract.

This shape satisfies invariant A for multi-hop and active-cohort cases, but the broader audit has remaining items because:

- staged readouts remain separate (`compute_single_hop_readout`, `compute_multi_hop_subject_readout`, `compute_multi_hop_window_readout`, `compute_active_cohort_carrier_readout`); the map is built per readout rather than once on a request-wide runtime object;
- 73n implementation Stage 5a's single-hop readout still constructs identity arrival weights through the local helper `_identity_arrival_weights(date_from, date_to)` rather than looking them up off a request-built map (the answer is structurally identical because the source node is the root, but the entry point is not yet the same call);
- `_identity_arrival_weights` is also retained as a defensive fallback inside 73n implementation Stages 5b/5c/6 for the case where `arrival_map.get(...)` returns `None` (e.g., a node not enumerated as a target at map-build time). This is a closure-blocking violation of invariant A for any non-root source node. It must become explicit degraded/unavailable provenance rather than identity binding;
- evidence retrieval still flows through `cohort_forecast_v3.build_per_edge_evidence`, which synthesises pre-merged `EvidenceSet` objects from frames — the readouts then lift `[p.candidate for p in es.points]` back out and re-run the merge layer inside the binder. Re-merge is idempotent for already-distinct candidates, but a downstream refactor to have the upstream produce candidates + scope directly (skipping the round-trip through a pre-merged `EvidenceSet`) is still on the table.

**Single primitive set is not yet established as a request-wide object.**  
Each staged readout builds its own registry and side maps. The system still lacks one `ResolvedCFRuntimeObject` or equivalent that owns the full primitive set for subject, optional carrier, and projection.

**Subject-span composition is algebraically available but still routed through staged functions.**  
`compose_subject_span` is the correct consumer abstraction, but `compute_cohort_maturity_rows_v3` still chooses between single-hop, multi-hop subject, multi-hop window, and active cohort readouts.

**Carrier and subject construction still have separate construction surfaces.**  
`subject_span_composer.compose_subject_span` and `carrier_composition.compose_carrier_to_x` both compose directed topology from transition primitives, but they do so through different public construction APIs and different intermediate primitive shapes. This violates invariant F until they share one primitive-span substrate with carrier/subject role wrappers.

The active-cohort carrier path is especially exposed here: the carrier bridge currently adapts conditioned primitive probability into the flatter carrier shape while timing still comes from the resolved model. That may be acceptable as migration scaffolding, but it is not proof that carrier and subject consume the same conditioned primitive substrate.

**Active-cohort carrier evidence wiring is not yet closure-grade.**  
73n implementation Stage 6 can demonstrate that injected upstream evidence moves carrier reach/timing, but public acceptance requires the real evidence retrieval path to supply upstream `window(U-V)` primitive evidence for the `A -> X` closure. Prior-only carrier primitives are acceptable only when canonical retrieval and admission prove no evidence was available for that primitive.

**Cohort/window polymorphism is still staged.**  
The code still treats `window()`, `cohort(A = X)`, and `cohort(A != X)` through staged gates rather than one runtime object whose carrier naturally degenerates.

### Not Yet Satisfied

**No single runtime-object projection path yet.**  
`compute_cohort_maturity_rows_v3` still calls staged readout functions and surfaces separate diagnostic sentinels.

The row builder also remains a migration seam that can synthesise compatibility evidence and perform staged scalar substitution. Those behaviours are not closure-compatible unless reduced to projections of one resolved runtime object.

**No single subject-span handler yet.**  
The live code still has `compute_single_hop_readout`, `compute_multi_hop_subject_readout`, and `compute_multi_hop_window_readout` as public/staged readout paths.

**No single cohort/window handler yet.**  
`compute_active_cohort_carrier_readout` remains a separate live readout path for active cohort carrier cases.

**Diagnostics still encode staged routing.**  
Rows and handlers still surface `_primitive_readout`, `_multi_hop_subject_readout`, `_multi_hop_window_readout`, and `_active_cohort_carrier_readout`.

**Tests still risk preserving migration scaffolding.**  
Tests that assert staged readout eligibility, staged sentinel names, or 73n implementation Stage 5a/5b/5c/6 diagnostic labels are useful only while those stages are being migrated. They must not define the final contract.

## Audit Checklist

Use this checklist for every follow-up implementation or review.

- A: Does every primitive receive arrival weights from the same request-scoped map?
- A: Are `window()` and `cohort(A = X)` identity-clock cases represented as root-map degeneracies?
- A: Are active `cohort(A != X)` downstream primitive clocks latency-adjusted through `A -> U` prefix timing?
- A: Does every non-root `arrival_map.get(...)` miss become degraded/unavailable provenance rather than identity weights?
- B: Is doc-52 subset/effective-evidence policy applied only inside primitive construction?
- C: Are all live primitive evidence resolutions produced by `bind_primitive_evidence`?
- D: Are all live conditioned and prior-only primitive outcomes produced through `condition_primitive`?
- E: Is there one request-wide primitive set for subject and carrier consumers?
- E: Does active `cohort(A != X)` fetch and bind real upstream carrier primitive evidence through the canonical runtime path, not only through test injection hooks?
- F: Do carrier and subject construction share one primitive-span composition substrate?
- F: Are `carrier_to_x` and `subject_span` only role-labelled wrappers over that substrate?
- F: Does carrier composition consume the same conditioned primitive contract as subject composition without dropping timing posterior, draw-family, degradation, or provenance fields?
- G: Is there one subject-span handler for one-edge and multi-edge subject topologies?
- H: Is there one cohort/window runtime handler with carrier identity/composition as data?
- I: Do public rates remain `Y / X`, never `Y / A`?
- J: Does `carrier_to_x` alone own denominator arrival?
- K: Does `subject_span` alone own numerator progression?
- L: Are factorised and gross-fitted numerator representations mutually exclusive?
- M: Are raw evidence rows admitted only on the correct semantic/evidence clock?
- N: Are rows, scalars, graph fields, and diagnostics projections of the same runtime object?
- N: Has compatibility evidence synthesis in projection been removed or reduced to provenance-only metadata?
- O: Do tests assert public semantic contracts rather than staged routing?
- O: Are migration-stage sentinel, flag-routing, and eligibility tests deleted, rewritten, or explicitly marked as temporary migration-only tests before acceptance?
- Stage namespace: Are references to stages qualified as either the older 73n implementation stages or this audit's closure stages?

## Immediate Closure Work Implied by This Audit

1. Build one request-scoped primitive preparation/runtime object that owns primitive enumeration, prefix-arrival map construction, evidence binding, conditioning, registry storage, and conditioned primitive map storage.
2. Replace non-root arrival-map miss fallback with explicit degraded/unavailable provenance.
3. Wire active-cohort upstream carrier primitive evidence through the real runtime retrieval/binding path, not only through test injection seams.
4. Extract one general primitive-span composition substrate and make carrier/subject wrappers delegate to it without a lossy carrier-only primitive bridge.
5. Route one-edge and multi-edge subject spans through the same `subject_span` consumer.
6. Route `window()`, `cohort(A = X)`, and `cohort(A != X)` through one runtime object where carrier identity/composition is data.
7. Replace staged row-builder sentinels with one runtime-object provenance block and remove projection-time evidence synthesis as a semantics owner.
8. Rewrite implementation-coupled tests around the lettered invariants above while preserving outside-in semantic assertions.

## Atomic Implementation Staging

The work may be implemented in stages for reviewability and cognitive control, but it should be treated as one atomic closure unit. Intermediate stages are scaffolding checkpoints, not independently acceptable architecture. 73n is not complete until every stage below is integrated and the invariant checklist above passes on the public path.

Do not preserve transitional stage boundaries as durable runtime concepts. If a temporary helper or compatibility alias is introduced during a stage, the same atomic work must remove or subsume it before closure.

The numbered headings below are **closure stages in this audit document**. They intentionally do not reuse the semantic meaning of Stage 5a/5b/5c/6 from `73n-carrier-evidence-conditioning-implementation-plan.md`.

### Closure Stage 1 — Runtime Object Contract

Define the single resolved CF runtime object and the minimum data it must carry:

- `population_root`;
- denominator node `X`;
- subject end;
- numerator representation;
- admission policy for exact whole-query reuse versus subject-side helper reuse versus rejection;
- request-scoped evidence-resolution registry;
- request-scoped conditioned primitive map;
- carrier span role object;
- subject span role object;
- projection provenance.

This closure stage should also decide the replacement diagnostic key for the four staged sentinels. The target is one provenance block that can explain rows, CF scalars, and graph fields without referencing 73n implementation Stage 5a/5b/5c/6 routing.

Stop condition: the contract exists in code or in a narrow implementation note, and every field maps to one of the lettered invariants above.

### Closure Stage 2 — Primitive Preparation Owner

Extract one primitive preparation path that owns:

- primitive enumeration for subject and optional carrier topology;
- request-root and prefix-arrival-map construction;
- evidence candidate selection;
- `bind_primitive_evidence`;
- `condition_primitive`;
- registry registration;
- conditioned primitive map population.

This stage must remove direct `bind_primitive_evidence` plus `condition_primitive` loops from staged readout bodies, or reduce those bodies to calls into the new preparation owner.

Stop condition: live CF row/scalar projection has one owner for primitive preparation. No readout/projection function independently binds evidence or conditions primitives. Non-root arrival-map misses are represented as degraded/unavailable provenance and cannot fall back to identity weights.

### Closure Stage 3 — General Primitive-Span Composer

Extract or introduce one primitive-span composition substrate shared by carrier and subject construction.

The substrate composes `root -> end` over conditioned primitives and returns a role-neutral composed primitive span. `carrier_to_x` and `subject_span` become thin role-labelled wrappers over this substrate.

This stage should retire duplicated carrier/subject composition logic where it owns the same graph algebra, timing CDF construction, draw-coherence handling, horizon policy, or primitive lookup behaviour.

Stop condition: carrier construction and subject construction delegate to the same primitive-span composition substrate. Remaining wrapper differences are semantic role naming and boundary/provenance checks only. No live carrier path consumes a lossy adapter that drops conditioned timing, draw-family, degradation, or primitive provenance available to the subject path.

### Closure Stage 4 — Unified Runtime Assembly

Assemble one runtime object for all request shapes:

- `window()`: `population_root = X`, identity carrier span, subject span `X -> end`;
- `cohort(A = X)`: same identity carrier degeneracy;
- `cohort(A != X)`: composed carrier span `A -> X`, subject span `X -> end`.

This stage removes `single-hop` and `multi-hop` as runtime routing categories. Topology length may be observed, but only as data consumed by the primitive-span composer.

Stop condition: there is one code path that builds the runtime object for window and cohort requests, with carrier identity/composition represented as data. Active `cohort(A != X)` carrier primitives receive upstream evidence through canonical runtime retrieval and binding when such evidence exists; test-injected evidence alone is not acceptance proof.

### Closure Stage 5 — Row/Scalar Projection Cutover

Replace the `compute_cohort_maturity_rows_v3` staged readout ladder with projection from the resolved runtime object.

Projection may compute rows, CF scalars, graph enrichment fields, and diagnostics. It must not choose evidence binding, condition primitives, rebuild carrier or subject spans, apply doc-52, or decide whether the subject is single-hop or multi-hop.

Stop condition: the four staged sentinel blocks are replaced by one runtime-object provenance block, with temporary compatibility aliases only if needed for a short in-atom migration step. Projection no longer synthesises primitive evidence from compatibility metadata such as `p_conditioning_evidence`; it only displays provenance already carried by the runtime object.

### Closure Stage 6 — Test and Diagnostic Reconciliation

Rewrite implementation-coupled tests around the lettered invariants:

- preserve outside-in semantic tests;
- preserve strict xfail intent until the corrected public path flips them;
- remove tests that assert 73n implementation Stage 5a/5b/5c/6 routing labels;
- add tests proving one-edge and multi-edge subjects use the same subject-span handler;
- add tests proving window and cohort use the same runtime handler with identity/composed carrier data;
- add tests proving carrier and subject wrappers share the primitive-span substrate;
- add tests proving evidence-clock offset binding uses one request-scoped map.

Stop condition: tests exercise public semantics and substrate invariants, not implementation staging. Tests that assert staged eligibility predicates, 73n implementation Stage 5a/5b/5c/6 diagnostic labels, staged sentinel keys, or rollback flag routing are deleted, rewritten, or explicitly marked as temporary migration-only tests that are excluded from atomic acceptance. At least one public-path or static assertion proves staged sentinel labels are not live runtime semantics.

### Closure Stage 7 — Dead-Code and Stale-Doc Audit

Delete or quarantine anything made unreachable by the unified runtime:

- staged readout functions if no longer live;
- staged diagnostic sentinels;
- stale flag/stage comments;
- direct row-builder ownership of primitive preparation;
- legacy carrier or trajectory conditioning owners.

Update maintained codebase docs only after code behaviour is settled. Project-bayes implementation notes may remain as history, but codebase docs must describe the final runtime, not the migration scaffold.

Stop condition: static search plus targeted tests show no live 73n implementation Stage 5a/5b/5c/6 routing path remains in CF row/scalar projection. Any remaining references to stage numbers are qualified by document or are historical comments outside live runtime semantics.

## Atomic Acceptance

The atomic work is complete only when all of the following are true:

- every lettered invariant A through O passes review;
- the public outside-in suite is green or has only explicitly retained strict xfails with current reasons;
- every non-root arrival-map miss is degraded/unavailable, never identity-bound;
- active `cohort(A != X)` carrier primitive evidence is wired through real runtime retrieval and binding, not only through test injection;
- carrier and subject composition consume the same primitive-span substrate without a lossy carrier-only adapter;
- staged readout labels are not live runtime semantics;
- tests do not preserve migration-stage labels, sentinel keys, or eligibility predicates as final-contract assertions;
- stage references in maintained docs and live comments are qualified by document or are historical-only;
- `window()`, `cohort(A = X)`, and `cohort(A != X)` are handled by one runtime object;
- one primitive set feeds carrier, subject, rows, scalars, and graph fields;
- projection is a readout of that runtime object, not a semantics owner.

## Appendix A — Work Session Audit, 2-May-26

### Scope

This appendix records the partial closure work performed in the 2-May-26 session that followed this audit. It is written for a follow-on agent. It is not a completion note.

The work focused on removing staged runtime semantics and reducing duplicate construction surfaces. It deliberately did not complete outside-in semantic repair, and outside-in assertions must not be rewritten without explicit discussion.

### Code Changes That Should Survive

**Primitive preparation was centralised inside the readout layer.**

`graph-editor/lib/runner/primitive_readout.py` now has one helper for the bind-and-condition step. The staged readouts call this shared helper instead of each independently spelling out candidate selection, `bind_primitive_evidence`, `condition_primitive`, and registry registration.

This advances invariants C and D and partially advances Closure Stage 2. It is not yet a full request-wide primitive owner, because primitive enumeration still happens in runtime/readout assembly rather than in a single durable primitive-set object.

**Non-root arrival-map identity fallback was removed from the readouts.**

The readouts now index the request-scoped prefix-arrival map directly for primitive source nodes. A missing source-node entry is therefore a construction failure, not an identity-clock case. Existing degraded topology still belongs in `prefix_arrival.build_prefix_arrival_map`; no new generic degraded fallback should be reintroduced in the readout layer.

This advances invariant A. The important lesson from the session: adding a theoretical `_degraded_arrival_weights_for_miss` helper was wrong because it added a defensive branch without a specific observed runtime risk. That helper was removed.

**The active-cohort carrier readout now uses the primitive-span composer.**

`graph-editor/lib/runner/primitive_readout.py` no longer converts conditioned carrier primitives into the flatter `carrier_composition.TransitionPrimitive` shape for the Stage 6 active-cohort readout. The active carrier A→X span and the subject X→end span both compose through the same primitive-span composer.

This advances invariant F and Closure Stage 3. It does not remove every use of `compose_carrier_to_x` from the repository: `prefix_arrival` and other lower-level carrier-support code still use it as a timing-map building block. The next agent must decide whether those uses are acceptable lower-level substrate support or whether they must also be subsumed.

**The subject-named composer API was removed from Python.**

The Python runtime no longer exports or imports `compose_subject_span` or `ComposedSubjectSpan`. The live API is now `compose_primitive_span` and `ComposedPrimitiveSpan` in `graph-editor/lib/runner/subject_span_composer.py`.

This is an intentional removal of stale naming, not a compatibility shim. A static search under `graph-editor/**/*.py` found no remaining Python references to the old names at the end of the session.

**Projection-time synthetic evidence from `p_conditioning_evidence` was removed.**

`graph-editor/lib/runner/cohort_forecast_v3.py` no longer synthesises a minimal `EvidenceSet` from `runtime_bundle.p_conditioning_evidence` totals for primitive readout. `graph-editor/lib/api_handlers.py` now reports CF response `evidence_k` and `evidence_n` from the typed prepared `EvidenceSet`, not from compatibility metadata and not from raw frame fallback aggregation.

This advances invariant N and Closure Stage 5. `p_conditioning_evidence` remains as compatibility/display metadata through `forecast_runtime.serialise_runtime_bundle`; it must not become an evidence owner again.

**Staged response diagnostics were collapsed into one runtime provenance block.**

`compute_cohort_maturity_rows_v3` now attaches one `_runtime_provenance` row sentinel. `api_handlers` exposes `runtime_provenance` on cohort maturity and conditioned forecast responses rather than separate staged blocks such as primitive readout, multi-hop subject readout, multi-hop window readout, or active-cohort carrier readout.

Runtime diagnostic `stage` labels were removed from the readout diagnostics. Binding-policy strings were changed from migration-stage names to role-labelled `primitive_span.*` names.

This advances invariants N and O and Closure Stages 1, 5, and 6. It does not mean all implementation-coupled tests have been reconciled outside the focused unit/integration subset.

**An explicit runtime result object was introduced.**

`graph-editor/lib/runner/cohort_forecast_v3.py` now contains `ResolvedCFRuntime` and a `build_resolved_cf_runtime(...)` function. `compute_cohort_maturity_rows_v3` calls this builder and then projects `runtime.public_moments` and `runtime.runtime_provenance`.

This advances Closure Stage 1 and begins Closure Stage 4. It is still partial: `build_resolved_cf_runtime(...)` owns the orchestration, but its internals still contain request-shape-specific construction blocks.

### Work That Was Backed Out

Several changes were made and then removed during the session because they violated the spirit of this audit:

- A readout-side `_degraded_arrival_weights_for_miss` helper was added, then removed. The correct shape is to require the prefix-arrival map to enumerate every primitive source; actual unsupported topology belongs in the map builder's existing degraded entries.
- A carrier-specific density-DP path was added to `carrier_composition.py`, then removed. It thickened the carrier path instead of collapsing onto the primitive-span substrate.
- An active-cohort row projection override was added to `cohort_forecast_v3.py`, then removed. It created another projection path instead of making rows read a single resolved runtime object.
- Two outside-in assertion edits were made and then reverted after explicit user instruction. Do not change `test_cohort_factorised_outside_in.py` without discussing the intended semantic change first.

These reversions are part of the audit record because they are easy traps for a follow-on agent.

### Tests Run During This Session

The following focused suites were green after the surviving changes:

- `test_subject_span_composer.py`, `test_composed_cache.py`, `test_active_cohort_carrier_audit.py`, `test_primitive_readout.py`, and `test_active_cohort_carrier_readout.py`: 69 passed after removing the old subject-named composer API.
- Focused runtime/provenance suite including primitive readout, multi-hop subject/window readout, active-cohort carrier readout, stage-8 substrate provenance, and subject-span composer: 79 passed after introducing runtime provenance and the explicit runtime result.
- Broad primitive/runtime suite covering primitive evidence, prefix arrival, primitive conditioning, readouts, residual guard, primitive contract, provenance, active-carrier audit, seed retirement, WP8 default-off, composed cache, carrier contract, and CF query-scoped degradation: 231 passed, 1 xfailed.

The final edited-file checks were clean:

- `ReadLints` reported no linter diagnostics on edited runtime/test files.
- `git diff --check` reported no whitespace errors.

The outside-in suite was run earlier and still had public semantic failures. Those failures were not fixed in this session and must not be hidden with test changes.

### Current Status Against Closure Stages

**Closure Stage 1 — Runtime Object Contract: partially satisfied.**

`ResolvedCFRuntime` exists and projection consumes it. It does not yet carry every audit field as a stable public/internal contract. In particular, primitive registry details, admission policy, carrier role object, subject role object, and projection provenance are not yet all first-class fields on the dataclass.

**Closure Stage 2 — Primitive Preparation Owner: partially satisfied.**

The bind-and-condition step is centralised, but primitive enumeration and span-specific resolution construction are still inside runtime assembly. There is no single request-wide primitive set object that all consumers share as the final owner.

**Closure Stage 3 — General Primitive-Span Composer: mostly satisfied for the active-cohort readout.**

The active carrier A→X and subject X→end spans now use the same `compose_primitive_span` substrate. Remaining questions are lower-level `compose_carrier_to_x` uses, especially in prefix-arrival construction.

**Closure Stage 4 — Unified Runtime Assembly: partially satisfied.**

`build_resolved_cf_runtime(...)` is now the single owner called by row projection. Its internals still branch by request shape. The next reduction should make carrier identity/composition and subject topology data inside the builder rather than separate construction blocks.

**Closure Stage 5 — Row/Scalar Projection Cutover: partially satisfied.**

Rows and CF scalars now project a single runtime result for primitive-backed public moments and provenance. Per-τ rows still come primarily from `compute_forecast_trajectory`, so full projection-from-runtime is not complete.

**Closure Stage 6 — Test and Diagnostic Reconciliation: partially satisfied for focused tests only.**

Focused unit/integration tests were updated away from staged diagnostic labels. Outside-in tests remain untouched and unresolved. Codebase docs still contain stale references to the old subject composer and staged readout model.

**Closure Stage 7 — Dead-Code and Stale-Doc Audit: not done.**

Static search under Python runtime no longer finds `compose_subject_span` or `ComposedSubjectSpan`, but maintained docs still mention them. Staged comments remain in project/history docs and some code comments. Do not mark this stage complete.

### Known Remaining Gaps

- `build_resolved_cf_runtime(...)` must be thinned internally. It currently centralises but does not yet fully unify the construction logic.
- `ResolvedCFRuntime` should be expanded into the full audit contract or replaced by a better-named object that carries the required fields.
- `compose_carrier_to_x` still exists and remains used outside the Stage 6 readout. Its role must be audited rather than assumed acceptable.
- `compute_cohort_maturity_rows_v3` still projects per-τ rows from the trajectory engine. Primitive runtime currently governs public moments/provenance, not every row quantity.
- `p_conditioning_evidence` remains as compatibility metadata and must not be allowed to drift back into evidence ownership.
- The outside-in public semantic suite still has failures. These should drive further runtime fixes, not assertion softening.
- Maintained codebase docs are stale relative to the current implementation.

### Recommended Next Step

Do not start by editing tests. Continue in code:

1. Expand or reshape `ResolvedCFRuntime` so it explicitly carries `population_root`, denominator `X`, subject end, numerator representation, primitive set/provenance, carrier span, subject span, and projection provenance.
2. Thin `build_resolved_cf_runtime(...)` so it always constructs carrier span and subject span as data:
   - `window()` and `cohort(A = X)` use identity carrier data;
   - `cohort(A != X)` uses composed A→X carrier data;
   - subject span is always X→end.
3. Only after that, revisit outside-in failures and discuss any proposed test changes before touching them.

### Handoff Warning

The fastest way to go wrong is to add a new branch, fallback, or compatibility alias "temporarily". The audit's spirit is algebraic collapse: fewer construction surfaces, fewer diagnostic namespaces, and no projection-time semantic decisions.
