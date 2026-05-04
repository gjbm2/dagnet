# 73n — Conditioned transition primitives for CF

**Status**: Replacement implementation plan, pending review  
**Date opened**: 30-Apr-26  
**Supersedes**: [`archive/73n-carrier-evidence-conditioning-implementation-plan-archived-30-Apr-26.md`](archive/73n-carrier-evidence-conditioning-implementation-plan-archived-30-Apr-26.md)  
**Depends on**: completed [`73m-carrier-composition-and-router-unification-implementation-plan.md`](73m-carrier-composition-and-router-unification-implementation-plan.md) and handoff record [`73m-stage-0-baseline.md`](73m-stage-0-baseline.md)  
**Parent problem statements**: [`73h-v3-router-and-carrier-conditioning-forensic.md`](73h-v3-router-and-carrier-conditioning-forensic.md), [`73g-general-purpose-f14-problem-and-invariants.md`](73g-general-purpose-f14-problem-and-invariants.md)  
**Semantic source of truth**: [`docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)  
**Evidence merge foundation**: [`73i-shared-evidence-merge-design.md`](73i-shared-evidence-merge-design.md)

## Purpose

This plan replaces the narrower carrier-evidence draft with a first-principles CF conditioning plan.

The app's admitted evidence surface is not a whole-carrier `A -> X` object. Pre-doc-60 WP8, CF admits `window(U-V)` evidence for parameterised transitions. Therefore the correct substrate is a set of conditioned transition primitives. `window()`, `subject_span`, and `carrier_to_x` are consumers of those primitives, not independent raw-evidence conditioners.

The target flow is:

1. Resolve every parameterised transition primitive needed by the request.
2. Condition each primitive from admitted `window(U-V)` evidence under the request scope.
3. Mark unparameterised or residual/complement edges unsupported for live CF composition unless they are explicit deterministic graph semantics.
4. Compose `window()`, `subject_span`, and `carrier_to_x` from the conditioned parameterised primitives.
5. Project rows, scalars, and graph fields from the composed runtime objects.

This is the missing generalisation behind 73h Issue 2. Carrier conditioning becomes a consequence of composing conditioned primitives. Subject conditioning and window conditioning use the same substrate.

## Preconditions

This plan assumes 73m has completed before implementation begins.

That means the live v3 stack has already removed the latency/non-latency router as an owning semantic path; `subject_span` and canonical `carrier_to_x` composition exist as runtime objects; and projection is expected to read resolved runtime objects rather than re-deciding carrier or subject semantics.

73m did not remove every legacy carrier-timing compatibility surface. In scoped cohort_maturity evidence materialisation, `_resolve_frame_carrier_state` may still build `NodeArrivalState` through `build_upstream_carrier`, including empirical Tier 2 or weak-prior fallback when parametric ingress timing fails. Whole-graph node arrival caching and `XProvider.carrier_to_x` use `compose_carrier_to_x`, but the scoped frame path can still see the legacy tiered carrier timing object. Stage 0 must treat that split as a 73n handoff gap, not as a completed precondition.

Stage 0 must verify those facts against the codebase before any 73n behaviour change. If any 73m condition is false, the implementation must stop and return to 73m rather than compensate inside 73n.

This plan also depends on the snapshot DB workstream staying aligned with primitive evidence identity. Snapshot admission, `retrieved_at` handling, and as-at filtering are Stage 0 read-contract risks until Stage 0 records the current snapshot DB API surface used by CF evidence resolution. Snapshot write invalidation becomes load-bearing only when Stage 7 introduces persistent primitive or composition caches.

## Non-Goals

This plan does not add a `carrier_to_x_arrivals` evidence role.

It does not admit whole-carrier `a/x` rows as a new evidence family.

It does not enable WP8 `direct_cohort_exact_subject`. That role remains a separate, flagged behaviour change.

It does not promote anchor-rooted gross-fitted whole-query numerators.

It does not change the displayed rate. The displayed rate remains `Y / X`, never `Y / A`.

It does not require the 73o carrier-state cache for correctness. 73o may later cache primitive posteriors and composed states after this plan defines the uncached truth.

It does not alter completed 73m artefacts. Those tests remain valid as composition and projection tests over supplied transition primitives.

It does not support runtime residual/complement sibling primitives in the first implementation. In particular, CF will not infer `1 - p` branch complements or rebalance sibling PMFs inside primitive composition. Ordinary parameterised sibling edges that lie inside the requested carrier or subject closure remain normal DAG composition inputs. Graph-surface sibling mass balancing after CF writes remains the responsibility of `UpdateManager.applyBatchLAGValues` and its existing sibling rebalancing path.

## Core Model

### Transition primitive

A transition primitive is the smallest CF object that evidence may condition.

For the current app, the usual primitive is a parameterised edge `U -> V` with `window(U-V)` evidence. A future implementation may also use a prepared span primitive if the same evidence contract and provenance are preserved, but the first implementation should prefer edge primitives unless the existing runtime already has a safer span abstraction for a specific surface.

A conditioned transition primitive must carry:

- transition identity: source node, destination node, edge id or stable transition id;
- scenario scope: date bounds, context, regime, selected hash family, and as-at boundary;
- evidence role, normally `window_subject_helper` for live CF before WP8;
- canonical raw `EvidenceSet` from the shared merge layer;
- effective evidence object, even when it is explicitly identical to raw evidence;
- probability posterior or draw family;
- timing posterior or conditional timing CDF draw family;
- draw-family identity for coherent downstream composition;
- unconditioned copies needed for existing doc-52 blending and diagnostics;
- conditioning status: conditioned, prior-only, structurally deterministic, unsupported, degraded, or unavailable;
- provenance for source family, skipped candidates, and effective evidence policy.

### Structurally non-latency primitives

Structurally non-latency does not mean unconditionable.

For a parameterised edge whose graph/schema semantics say there is no latency process, admitted `window(U-V)` evidence may still condition the transition probability `p`. It must not condition a latency posterior, completeness curve, `mu`, `sigma`, or onset parameter. The primitive's timing object is a structural identity, equivalent to a Dirac-at-zero transition, and remains fixed before and after probability conditioning.

In the runtime model, Dirac-at-zero includes the mass at `tau=0`. A structurally non-latency primitive's conditional timing CDF is already saturated at `tau=0`; a span made only of timing-identity transitions is also saturated at `tau=0`. Tests of runtime composition, projection, or MC consumption must not skip `tau=0` to make non-latency behaviour pass. If an external source or snapshot convention cannot observe a same-day instantaneous event at `tau=0`, that is an evidence-admission or source-timestamp rule and must be named separately; it does not change the primitive's timing semantics.

If compatibility fields such as `mu`, `sigma`, onset, or completeness are still required by existing consumers during migration, they must be emitted with provenance saying they are structural identity fields, not evidence-conditioned timing parameters. Composition may multiply reach/probability through the non-latency primitive, but the primitive contributes no delay and no timing uncertainty.

### Residual and unparameterised edges

Not every transition that a graph needs is independently parameterised. For this plan, live CF composition supports parameterised primitives and explicit deterministic graph semantics only.

No-evidence and non-parameterised edges are different cases and must not be collapsed.

For a parameterised edge with no admitted evidence, the primitive remains a **prior-only parameterised primitive**. It still has a model source and may still be usable by composition; its conditioning status is `prior_only`.

For a non-parameterised residual or complement edge, the first implementation does **not** derive a primitive. It marks the edge unsupported or degraded for live CF composition unless the graph/schema already declares it as an explicit deterministic identity.

For a structural deterministic edge, the primitive may be an explicit identity or configured deterministic primitive only when graph/schema semantics say so. The implementation must not infer determinism merely from missing evidence.

The existing graph-output sibling mass invariant is separate. CF writes its public `p_mean` back through the graph update path, and UpdateManager owns proportional sibling rebalancing on the graph surface. That output rebalancing must not be moved backward into CF primitive composition or treated as a probabilistic residual primitive.

### Complex graph topology

The current span substrate is DAG-shaped, not merely linear-path-shaped. `span_kernel` composes an `X -> Y` sub-DAG by topological dynamic programming: serial edges convolve, parallel incoming densities are summed, joins accumulate predecessor mass at the joined node, and ordinary leakage is carried by edge probabilities. `carrier_composition.compose_carrier_to_x` already uses the same substrate for `A -> X`. This is the operator algebra documented in `29b-span-kernel-operator-algebra.md`; 73n must preserve it when replacing prior/source-layer transition objects with conditioned primitives.

The supported first-implementation cases are the cases already expressed by the current app and by doc 29b:

- serial carrier prefixes and serial subject spans;
- upstream diamond/fan-in/fan-out topology inside `A -> X`;
- downstream diamond/fan-in/fan-out topology inside `X -> end`;
- ordinary leakage through side exits not on the requested carrier or subject closure, with leakage represented by the retained edge probabilities;
- joins at `X`, where all upstream alternatives remain carrier-side and the subject starts from unit mass at `X`;
- splits at `X`, where the carrier ends at `X` and downstream alternatives belong to `subject_span`.

The first implementation does not need a new defensive topology theory. It needs to preserve the existing regime split:

- build the carrier closure as `A -> X`;
- build the subject closure as `X -> end`;
- compose each closure through the shared span/carrier DAG machinery;
- reject or avoid only block choices that cross the `X` boundary or mix incompatible metadata, as doc 29b already requires for overhanging blocks and metadata-mismatched plans.

Because 73n's first implementation prefers edge primitives, most supported complex topology is just "condition each edge primitive, then feed those primitives into the existing DAG composer." If an implementation chooses to use a prepared span primitive for a specific surface, that span primitive must fit wholly inside either the carrier closure or the subject closure and must carry compatible slice, context, regime, and as-at metadata. Otherwise it must fall back to edge primitives rather than introducing a new unsupported topology rule.

### Draw-family coherence

Primitive posterior draws are not disposable summaries.

If multiple composed consumers read the same primitive under the same scope, they must consume the same posterior draw family and the same draw index semantics. A carrier and subject that both include `U -> V` must not independently regenerate that primitive's posterior draws and then pretend the sampled worlds are coherent.

The primitive layer must therefore expose whether it carries:

- a coherent draw family that may be composed per draw;
- moments only, which can support deterministic summaries but not draw-level joint composition without degradation;
- a degraded synthetic draw family, with provenance explaining the approximation.

Subject-span composition and carrier composition must preserve this draw-family identity.

### Request-scoped primitive registry

Draw coherence is a correctness requirement, not a Stage 7 performance optimisation.

By the time primitive conditioning can produce live posteriors, a request-scoped primitive registry must exist for the current solve. It is pass-local and may be uncached across requests, but within one request it is the only owner of primitive resolution and primitive posterior construction. `window()`, `subject_span`, and `carrier_to_x` must read primitive objects from that registry rather than re-resolving `U -> V` independently.

The registry key is the primitive identity plus scenario scope, evidence role, date bounds, context and case scope, regime or hash-family identity, as-at boundary, model-source preference, and evidence-clock alignment identity. A later persistent cache may use the same identity, but persistent caching is optional; pass-local single ownership is not.

### Composed consumers

`window(X-Y)` is the simplest consumer: it reads the conditioned primitive `X -> Y` directly. Multi-hop `window(X-Z)` reads the composed `subject_span(X -> Z)` built from the conditioned primitives on the full subject topology.

This is a behavioural ownership change, not a mathematical change. Today, the window path may still reach conditioning through the trajectory or summary solver. After this plan, `window()` must not decide evidence admission, subset policy, or posterior updating. It requests the relevant primitive posterior and projects it.

`subject_span(X -> end)` composes conditioned transition primitives along the subject topology. In single-hop it degenerates to one primitive. In multi-hop it remains the full `X -> end` span, not the terminal edge.

`carrier_to_x(A -> X)` composes conditioned transition primitives along the upstream denominator topology. In `window()` and `cohort(A = X)` it degenerates to identity.

Projection combines composed carrier and subject objects. Projection does not condition evidence and does not choose evidence roles.

## Evidence Contract

The live CF evidence role before WP8 is `window_subject_helper`.

For a primitive `U -> V`, admitted evidence is `window(U-V)` evidence for the same scenario scope. Snapshot and reconstructed rows use the existing adapter convention: `n = x`, `k = y`. The `a` field may be retained as provenance, but it is not a whole-carrier trial count.

The primitive evidence coordinate must be explicit. The scope includes the scenario id, `U -> V` transition identity, requested date bounds, selected anchor or window day set, context and case scope, regime or hash-family identity, as-at boundary, and model-source preference. `retrieved_at` and observed-date age calculations must follow the same convention as the shared merge layer; the primitive builder may not reinterpret them locally.

### Evidence clock alignment

For `cohort()` requests, the public date bounds are on the anchor clock, not necessarily on the evidence clock for every downstream primitive.

`window(U-V)` evidence is rooted at arrivals to `U`. Therefore a downstream primitive `U -> V` in a `cohort(A...)` request must bind evidence on the `U`-arrival clock induced by the selected anchor Cohorts and the prefix topology from `A` to `U`. It must not blindly reuse the anchor date bounds for every primitive.

The conditioner already has the timing information needed to do this alignment through the same composition machinery used elsewhere: model-var/source transition parameters, span topology, deterministic prefix CDFs, and draw-level prefix CDFs are all available before primitive posterior conditioning. This is not a separate MC forecast pass. It is a shared prefix-arrival timing provider over the contexted scenario graph: given the request root, it builds one topologically ordered prefix-arrival map for that contexted graph/root, with entries such as `arrival_weight[U]` for each primitive source node `U` needed by the request.

The prefix-arrival map must be built from the same contexted, regime-selected, source-selected graph state as the primitive registry. It must not read uncontexted graph defaults, stale promoted path fields, or a different `model_source_preference` from the one used to seed primitive conditioning.

The required flow is:

1. Enumerate required primitives.
2. Resolve the contexted/source-selected source-layer primitive set for the scenario before conditioning.
3. Build one prefix-arrival map for the request root by walking the contexted graph topology once and composing prefix timing through the shared span/carrier composition provider.
4. For each primitive `U -> V`, read `arrival_weight[U]` from that map as the primitive-local weighted `U`-arrival day map.
5. Fetch a superset of evidence that covers all primitive-local clocks needed by the scenario.
6. Bind and weight that superset into each primitive's raw `EvidenceSet` and weighted evidence view before effective-evidence policy and conditioning.

The first implementation uses weighted day binding. For each contexted scenario/root, build `arrival_weight[node_id][calendar_day]` before primitive conditioning using the shared prefix-arrival timing provider:

- start with the selected root day weights for the request: selected anchor population mass for `cohort()` and selected source-window denominator mass for `window()`. These weights are required for live weighted binding; if they cannot be resolved, the affected primitive evidence-clock alignment is degraded and must not silently live-condition from unweighted anchor dates;
- walk the graph in topological order from the request root, storing each node's arrival map in the request-scoped registry;
- obtain each edge or prefix delay PMF on the existing integer-day horizon from the contexted/source-selected source-layer primitives before conditioning;
- for identity and structurally non-latency prefixes, the delay PMF is exactly all mass at delay zero;
- for deterministic timing prefixes, the delay PMF is exactly all mass at the deterministic integer-day delay under the same runtime rounding convention as the span kernel;
- for latency-bearing prefixes, the provider uses the existing composed prefix CDF/draw machinery, differences each prefix CDF into a PMF, then averages the PMFs across draws when draw-level timing is available;
- for every source node arrival day `d` and transition delay `t`, add `arrival_weight[source][d] * delay_weight[t]` to `arrival_weight[target][d + t]`;
- do not recompute the full root-to-`U` prefix independently for each primitive; a primitive `U -> V` reads the already-built `arrival_weight[U]` entry.

The primitive raw `EvidenceSet` records the unweighted canonical rows admitted from the retrieval superset for the support of `arrival_weight[U]`. The primitive weighted evidence view is a separate primitive-local object with floating-point `n_weighted` and `k_weighted` rows, produced by multiplying each admitted row's `n` and `k` by that row's normalised `arrival_weight[U][observed_date]`. Both raw and weighted totals are exposed in provenance. The conditioning likelihood consumes the weighted view, while raw `E` remains available for audit and diagnostics.

Degenerate cases must be exact:

- `window(X-Y)` and `cohort(A = X)` use the source clock directly.
- A non-latency or identity prefix has zero shift, including at `tau=0`.
- A deterministic onset prefix uses the corresponding deterministic date shift.
- A latency-bearing prefix uses the prefix timing distribution and weighted day binding. Broad envelopes or unweighted selected-day approximations are not the first implementation target.

`asat()` remains an observation frontier. It gates which retrieved observations may be admitted; it does not collapse the primitive-local evidence clock back to the anchor date range.

`direct_cohort_exact_subject` remains default-off. This plan must not silently use cohort-family rows just because the public query is `cohort(...)`.

Bayes Phase 1 and Phase 2 roles remain Bayes roles. They may share the merge library, but they do not define live CF primitive conditioning.

If a primitive has no admitted evidence, it remains prior-only with explicit provenance. No caller may pretend that a no-evidence primitive was conditioned.

If a transition is unsupported because it would require residual or complement sibling derivation, provenance must say so explicitly.

## Subset and Effective Evidence Policy

Subset/double-count logic belongs inside primitive posterior construction, but this plan must keep two concepts distinct.

Effective-evidence policy decides how much conditioning pressure raw `E` is allowed to apply to the primitive posterior. Existing doc-52 draw or row blending is a compatibility behaviour for subset/double-count correction and brittle evidence mass. It must not be silently renamed as row-level evidence exclusion unless the implementation proves the operations commute with primitive composition. If a compatibility blend remains during migration, diagnostics must name it separately from raw evidence admission.

Operationally, the current doc-52 subset policy is mass-ratio based, not row-provenance based. It records scoped evidence mass `m_S`, source/global evidence mass `m_G`, and the ratio `r = min(m_S / m_G, 1)` when `m_G` is available. Under FE topo, the scoped subset and aggregate model vars use the same evidence base, so the scoped Cohort group is a subset of the global/source evidence by construction when numerator, denominator, context, regime, and hash family are aligned. Under Bayes/source posteriors, the nightly or selected source posterior similarly acts as the global evidence base for the matching scope, subject to as-at and source-preference selection. Stage 0 must cite the current doc-52 source and implementation sites and record where `m_S`, `m_G`, and `r` come from before Stage 3 moves the policy.

The obvious subset limit is load-bearing: as the request Cohort group becomes the whole global/source evidence base, `m_S / m_G -> 1` and the conditioned primitive must tend to the model-var primitive. In that limit, raw `E` may be large, but it is not novel conditioning mass. The implementation must not collapse to raw `k/n`, tighten uncertainty, or move the posterior merely because duplicated raw rows exist.

Compatibility blend means the existing draw or row mixing that tempers a fully conditioned answer back toward the unconditioned family when evidence mass or conditioning health is judged brittle. It is not evidence admission and it is not the raw-to-effective transformation. During migration it may remain as a separately named compatibility field on primitive or response provenance where parity or response compatibility requires it. The acceptance gate is ownership, not deletion: once primitive provenance can explain raw evidence, effective evidence, conditioning health, and unconditioned twins directly, no live consumer may require `p_conditioning_evidence` or compatibility-blend metadata to decide evidence ownership.

The primitive layer must expose both:

- raw `E`: the canonical scoped `EvidenceSet` admitted for `window(U-V)`;
- effective `e`: the evidence pressure actually allowed to update the primitive posterior after subset, mass-ratio, or doc-52 double-count policy. This may be represented as transformed evidence, as a conditioning weight, or as a named compatibility blend during migration, but it must expose `m_S`, `m_G`, `r`, and the resulting effective conditioning status.
- weighted primitive evidence view: the primitive-local clock-aligned rows after applying `arrival_weight[U]` to raw rows. This view is the input to the likelihood before doc-52 mass-ratio correction.

For current BE CF, many paths may still have `e == E`. That equality should be explicit, not implicit. If effective evidence differs from raw evidence, the primitive posterior must expose raw totals, effective totals, and the policy that transformed one into the other.

The policy should follow these rules:

- If scoped evidence is outside the selected model-var/source evidence base because of as-at, source-preference, context, regime, or hash-family mismatch, the source selection is suspect; use a compatible source or surface the mismatch rather than silently mixing incomparable evidence.
- If scoped evidence and model vars come from the same evidence base, apply the doc-52 mass-ratio correction at primitive level using `m_S`, `m_G`, and `r`.
- As `m_S / m_G -> 0`, the scoped evidence may apply full conditioning pressure. As `m_S / m_G -> 1`, the result tends to the model-var primitive.
- If `m_G` is unavailable or zero, use the current conservative doc-52 skip behaviour and surface the skip reason; do not invent row-level overlap proof.
- If a primitive has no admitted evidence, subset logic returns empty effective evidence and the primitive remains prior-only.
- If raw `E` is non-empty but the mass-ratio policy reaches the full-subset limit, the primitive numerically equals its model-var input while preserving raw evidence, `m_S`, `m_G`, `r`, and subset-policy provenance.
- Unsupported residual/complement transitions do not perform subset correction independently.
- `window()`, `subject_span`, `carrier_to_x`, and projection never apply subset logic. They only consume primitive posteriors.

The load-bearing flow is therefore:

`raw window evidence E -> subset/effective-evidence policy -> primitive posterior -> subject/carrier composition -> projection`.

Reference: the Stage 0 baseline must link the current doc-52 note and record the live implementation sites for subset correction, aggregate IS, and compatibility blending. This implementation plan intentionally does not duplicate doc-52's full derivation.

## Relationship to 73m

73m builds the carrier and subject composition surfaces that 73n consumes. After 73m, those surfaces are composers of supplied transition primitives. They may initially receive prior/source-layer primitives from the current resolver, but they must not be designed as prior-only edge-field readers.

This plan begins only after 73m leaves off:

- 73m proves that `carrier_to_x` can compose supplied primitives correctly;
- 73m proves that `subject_span` is the resolved `X -> end` object for single-hop and multi-hop subjects;
- 73m retires the latency/non-latency router as a live semantic owner;
- 73m leaves empirical Tier 2 outside the intended Phase 2 abstraction, but the legacy `build_upstream_carrier` path remains callable in scoped cohort evidence materialisation;
- this plan defines how CF resolves those supplied primitives as posterior-conditioned objects;
- after this plan, the same carrier composer should work with posterior primitives without another carrier rewrite.

Completed 73m tests over static fixture primitives remain valid composition inputs. 73n must not weaken them or use primitive conditioning to hide a carrier or subject composition regression. Stage 0 must import the 73m handoff's strict-xfail list and decide which failures are 73n flip-to-green targets versus wrong-contract tests.

## Current Implementation Gap

Assuming 73m completion, conditioning is still too late and too local.

`forecast_runtime.prepare_forecast_runtime_inputs` builds one target-subject evidence set and passes residual file/reconstructed evidence as legacy `(age, n, k)` tuples. It does not build a reusable conditioned primitive posterior for every transition in the request topology.

Current evidence retrieval and merge are not yet primitive-clock aware. They effectively build evidence around the request subject and date bounds, while a `cohort(A...)` downstream primitive needs `window(U-V)` evidence on the `U`-arrival clock induced by prefix timing. The existing shared merge types already expose most of the needed shape, but the retrieval/binding path must be upgraded to fetch a scenario-wide superset and then bind each primitive's local evidence clock deliberately.

`compute_forecast_trajectory` performs aggregate IS conditioning inside the trajectory solve. That makes the trajectory solver both a conditioner and a projector. The current `window()` path relies on this behaviour as the baseline conditioning path. Under this plan, that logic must either move into primitive posterior construction or become an internal helper called by primitive construction. `window()` itself should become a readout of the conditioned primitive, not a separate conditioning caller.

Known starting anchors for Stage 0 are `forecast_runtime.prepare_forecast_runtime_inputs`, `forecast_state.compute_forecast_trajectory`, `_cohort_binomial_log_likelihood`, `_weights_and_ess`, and `_compute_blend_params`. Stage 0 must refresh this inventory with current line references because these files move frequently.

`p_conditioning_evidence` currently describes the evidence family used to move the rate side of a runtime bundle. During migration it may remain as compatibility metadata and response provenance. It must stop being the place where `window()` or subject conditioning is decided. The decision and effective evidence policy belong to primitive posterior construction.

Carrier and subject composition consume supplied transition primitives, but those primitives are still source-layer or prior-style objects. They are not yet conditioned posterior primitives resolved from admitted `window(U-V)` evidence under the request scope.

Scoped carrier timing still has a compatibility split after 73m: `XProvider.carrier_to_x` and whole-graph arrival caches use `compose_carrier_to_x`, while `_resolve_frame_carrier_state` can still build the `NodeArrivalState` consumed by cohort evidence materialisation through `build_upstream_carrier` and its parametric/empirical/weak-prior tiers. 73n must choose the composed primitive-backed provider for prefix-arrival timing and retire, bypass, or quarantine the tiered carrier timing path for live corrected CF.

Any empirical Tier 2 observations that remain reachable after 73m are evidence inputs, not a carrier replacement design. They should condition upstream transition primitives through the standard primitive policy or remain dev/diagnostic-only.

The shared prefix-arrival timing provider this plan depends on is itself a new abstraction, not something live code already exposes. `compose_carrier_to_x` composes one carrier `A -> X` from supplied primitives, and `build_node_arrival_cache` builds whole-graph node arrival caches; both are building blocks. The request-scoped, contexted, topologically ordered `arrival_weight[node_id][calendar_day]` object that primitive evidence-clock alignment requires — covering every primitive source node `U` needed by the request, keyed by scenario/root/context/regime/source-preference, and resolved before primitive conditioning — does not exist as a first-class object today. Stage 2 owns its construction. Stage 0c records that construction as an explicit deliverable so later stages do not treat the provider as if it already existed.

The plan also depends on weighted primitive evidence rows that the current `EvidenceSet` does not represent. Today the shared merge layer carries integer `n`/`k` totals only. The floating-point `n_weighted`/`k_weighted` view this plan requires for clock-aligned conditioning is a new object that must be defined separately from the canonical `EvidenceSet`. Stage 1 owns its contract; Stage 2 may not change merge callers until the contract is pinned.

The current draw-family construction uses fixed RNG seeds (notably the `42`/`43` constants in the trajectory-local draw machinery). Those seeds do not produce primitive draws coherent across composed consumers under the same scope. Stage 1 owns the migration from fixed seeds to a key-derived seed stream; no later stage may claim draw coherence while fixed-seed callers remain.

## Target CF Flow

### Scope of whole-graph CF

Whole-graph CF is in scope as a consumer of primitive posteriors, but it is not allowed to drive the first numerical cutover.

The first live cutover should prove scoped `window()` and scoped `cohort_maturity` behaviour before whole-graph CF is widened to every parameterised edge. Stage 0 must estimate the primitive count for representative whole-graph requests and record the likely performance impact. Stage 8/9 closure may require whole-graph diagnostics and projection, but broad whole-graph primitive enumeration must remain behind the same shadow or feature flag until performance and unsupported-edge incidence are measured.

Whole-graph CF must not infer residual or complement branches from adjacency. If a requested whole-graph path would require such a branch, that portion is unsupported or degraded for live CF composition. Graph-output sibling mass balancing remains a post-CF UpdateManager concern.

### Primitive resolution pass

Before solving a request, CF should enumerate the transition primitives required by all requested consumers.

For whole-graph CF, this set may include every parameterised edge required by requested consumers. It does not include inferred residual/complement sibling primitives.

For scoped `cohort_maturity`, it includes primitives on the subject path and the upstream carrier path from `A` to `X`.

For `window()`, it includes the target primitive or subject-span primitives.

The resolver should dedupe primitives by scope so the same `U -> V` primitive is conditioned once per scenario, date bounds, context, regime, as-at, and source preference.

The deduped result is stored in the request-scoped primitive registry. From Stage 3 onward, consumers must read from that registry even if persistent caching is disabled.

### Evidence retrieval superset pass

Before per-primitive merge, CF must determine the evidence required by all primitive-local clocks in the scenario.

This pass must reuse the shared prefix-arrival timing provider. It must not introduce a second timing implementation or a standalone MC forecast sweep for evidence alignment. The provider's implementation surface is the same span/carrier composition layer used by `subject_span` and `carrier_to_x`; evidence-clock alignment is a readout of that layer before primitive conditioning.

For `cohort(A...)`, this means deriving a local evidence clock for each downstream primitive from the prefix timing from `A` to the primitive source node. For a path `A -> B -> C -> D` and query `cohort(1-Jan:1-Jan).asat(1-Feb)`, the first primitive can bind `window(A-B)` evidence on the 1-Jan source clock, but later primitives may need `window(B-C)` and `window(C-D)` evidence on days induced by arrivals at `B` and `C`, potentially extending out to `1-Jan + prefix delay`, subject to `asat(1-Feb)` admission.

The evidence retriever must therefore fetch a superset covering every primitive-local evidence clock for the request. The shared evidence builder then binds the relevant subset or weights to each primitive. A single anchor date range is not sufficient for every downstream primitive.

The first implementation represents stochastic prefix timing as weighted day binding. Contiguous envelopes and unweighted selected-day approximations are not the target implementation; they may appear only as explicit degraded diagnostics when a primitive cannot be live-conditioned.

### Primitive conditioning pass

Each parameterised primitive resolves its admitted `window(U-V)` evidence through `EvidenceScope`, candidate adapters, and `merge_evidence_candidates`.

The `EvidenceScope` date bounds and weighted day policy must come from the primitive-local evidence clock, not from the public query's anchor bounds unless the primitive source is the query root or an identity/non-latency prefix proves the clocks coincide. The source of that clock is the contexted scenario graph's prefix-arrival map, not per-primitive recomputation from raw graph fields.

Before conditioning, the primitive applies the subset/effective-evidence policy. The conditioning method consumes effective `e`, not raw `E`, unless the policy has explicitly established `e == E`.

The conditioning method should reuse the current maturity-aware likelihood discipline, but it should produce a primitive posterior object rather than only mutating a trajectory-local draw set.

The first implementation may keep numerical internals close to the current aggregate IS machinery. The architectural change is where the result lives: the conditioned primitive becomes the object consumed by window, subject, carrier, and projection.

Before Stage 3 changes numerical behaviour, Stage 2 should be able to emit a shadow primitive inventory and raw-evidence ledger for review. That ledger should show every primitive key, admitted role, raw totals, skipped candidates, selected regime/hash family, and whether effective evidence is currently equal to raw evidence.

### Unsupported edge pass

After parameterised primitives are conditioned, the resolver identifies any unparameterised, residual, or complement edge that the requested composition would require.

The first implementation does not derive those edges. Diagnostics must distinguish:

- unsupported residual/complement sibling primitive;
- explicit deterministic identity allowed by graph/schema semantics;
- unavailable transition because no parameterised primitive or deterministic semantics exists.

No unsupported edge may silently become `p=0`, `p=1`, `1 - p`, a weak prior, or a timing identity.

### Composition pass

`subject_span` and `carrier_to_x` compose from primitive posteriors.

The composition pass must keep probability and conditional timing separate. Reach affects absolute counts and denominator mass; it does not multiply displayed subject rates.

Draw-level composition must preserve primitive draw coherence. If every consumed primitive has a coherent draw family under the same scope, the composed subject or carrier uses matching draw indices. If one primitive is moments-only or degraded, the composed object must either remain deterministic/moment-level or carry degraded uncertainty provenance.

The composition pass must preserve natural degeneracies:

- `window()` reads an identity carrier and the subject primitive/span;
- `cohort(A = X)` reads an identity carrier and the subject primitive/span;
- single-hop subject spans read one primitive;
- non-latency transitions act as timing identities while their probability `p` may still be conditioned;
- multi-hop subjects and multi-hop carriers use the same composition machinery.

### Projection pass

Projection reads composed runtime objects.

Rows, scalar summaries, and graph fields must not:

- resolve evidence;
- choose an evidence role;
- recompute primitive posteriors;
- recompute carrier reach from raw graph fields after a composed carrier exists;
- substitute terminal-edge timing for a multi-hop subject span;
- multiply displayed rates by carrier reach.

For `window()`, projection is intentionally boring: it reads the conditioned primitive or composed subject span and returns the same public quantities as the current window path.

Parity expectations are query-class specific. Simple single-hop `window(X-Y)` numerical parity is the migration oracle. Multi-hop `window(X-Z)` must be checked against the intended composed `X -> Z` subject span; if existing behaviour was terminal-edge-only or trajectory-local, parity may expose an old defect rather than define the target. Any intentional non-parity must be named, tied to the subject-span invariant, and covered by tests.

### Migration choreography

Stages 3 through 6 must be flag-gated and shadowable.

During Stage 3, primitive posteriors are built in shadow mode first. The legacy public answer remains authoritative while primitive and legacy outputs are compared on simple window fixtures. If the primitive posterior diverges from the legacy simple-window answer outside the Stage 0 tolerance, the implementation stops and records whether the drift is a primitive bug, a legacy defect, or an intentionally changed semantic.

During Stage 4, unsupported residual/complement requirements are surfaced as unavailable or degraded. No residual/complement primitive is added to the live registry in this implementation unless it is an explicit deterministic graph semantic.

During Stages 5a, 5b, and 5c, `window()` and `subject_span` may be cut over only behind reviewed feature flags or equivalent request-level switches. Each sub-stage uses an independent flag so that single-hop window parity, multi-hop subject-span semantics, and multi-hop window readout can be enabled or rolled back independently. The legacy trajectory-owned conditioning path remains available as a rollback path until all three flags reach acceptance.

During Stage 6, `carrier_to_x` may consume primitive posteriors only after the same registry is shared with window and subject consumers. The cutover must not create a second primitive resolver for carrier. After Stage 6 acceptance, the legacy owner of window evidence admission in `compute_forecast_trajectory` must be deleted or reduced to an internal numerical helper called only by primitive construction, and a dead-code audit must confirm no aggregate-IS or window evidence-admission site remains reachable as a live owner under any flag combination.

## Cache Contract

The first implementation may be uncached if correctness is simpler. However, the design should make caching straightforward.

A conditioned primitive posterior cache should be keyed by:

- scenario id;
- transition id or stable edge identity;
- evidence role;
- date bounds and selected anchor/window day set where relevant;
- context and case scope;
- regime or hash-family identity;
- as-at boundary;
- model source preference and resolved source identity;
- graph topology version or parameter fingerprint sufficient to invalidate stale primitives.

Composed subject and carrier caches may be layered above primitive caching. They must include topology and primitive-cache keys in their invalidation identity.

73o should own cross-request performance optimisation and pass-local carrier-state caching. This plan requires an uncached request-scoped primitive registry for correctness; it does not require a persistent primitive posterior cache before Stage 7.

## Mathematical Invariants

Evidence binds to primitives, not to carrier or subject labels.

A primitive posterior is the only place where raw `window(U-V)` evidence may move the primitive's probability or timing.

Subset and effective-evidence policy is part of primitive posterior construction. No composed consumer may discount, reweight, or supplement evidence after the primitive posterior has been built.

Complex topology follows the existing doc 29b/span-kernel contract. Serial chains, diamonds, joins, fan-in, fan-out, and ordinary leakage are already represented by the current DAG algebra: serial composition convolves, parallel routes sum, and leakage stays inside edge probabilities. 73n must preserve that behaviour while changing the transition inputs from prior/source-layer primitives to conditioned primitives.

The load-bearing complex-topology guard is regime containment, not a new unsupported-topology taxonomy. Carrier composition covers `A -> X`; subject composition covers `X -> end`. Any prepared span primitive used during migration must fit wholly inside one of those closures and carry compatible slice, context, regime, and as-at metadata. If it does not, the implementation falls back to edge primitives rather than crossing the `X` boundary or mixing metadata.

Conditioning is an identity operator when effective conditioning pressure is zero. This includes genuinely absent evidence and the full-subset limit where `m_S / m_G -> 1` under the doc-52 mass-ratio policy. As the scoped Cohort evidence becomes the whole global/source evidence base, primitive posteriors, composed carriers, composed subject spans, Pop C/Pop D inputs, and the downstream MC run must tend to the model-var-driven result.

`window(X-Y)` is not a separate conditioning regime. It is the degenerate consumer of the conditioned primitive `X -> Y`. If the subject is multi-hop, `window(X-Z)` is the degenerate consumer of a composed `subject_span(X -> Z)` over conditioned primitives. Either way, the identity carrier is the only carrier logic in window mode.

`subject_span` probability is the composed probability of the `X -> end` primitive topology. In multi-hop it is not the terminal edge probability.

`carrier_to_x` reach is the composed probability of the `A -> X` primitive topology. It is not a separate Beta posterior over whole-carrier arrivals.

Carrier timing is conditional on reaching `X`. Subject timing is conditional on subject success. Projection may multiply by reach and subject probability when computing absolute counts, but displayed rates remain `Y / X`.

If upstream primitive evidence changes, any carrier or subject that consumes that primitive may change. Unrelated composed objects must not move.

If target subject primitive evidence changes, `subject_span` may change. `carrier_to_x` changes only if that primitive is also genuinely part of the `A -> X` topology.

Runtime CF does not derive residual/complement sibling primitives in this implementation. Any composition that would require one must fail loudly or degrade with provenance. Sibling PMF rebalancing for graph outputs remains an UpdateManager writeback invariant, not a CF runtime composition rule.

## Implementation Surface Map

Likely surfaces:

- `graph-editor/lib/evidence_merge.py`: preserve current roles; do not add carrier roles.
- `graph-editor/lib/evidence_merge.py` and the snapshot evidence retrieval path: support primitive-local retrieval supersets and weighted day binding without changing unrelated consumers accidentally.
- `graph-editor/lib/runner/evidence_adapters.py`: continue mapping live primitive evidence as `n=x`, `k=y`.
- `graph-editor/lib/runner/span_kernel.py` and `graph-editor/lib/runner/carrier_composition.py`: provide the shared prefix-arrival timing provider used for evidence-clock alignment and later subject/carrier composition; do not add a second timing path.
- `graph-editor/lib/runner/forecast_runtime.py`: introduce primitive posterior preparation and pass primitive-backed subject/carrier inputs into runtime bundles.
- `graph-editor/lib/runner/forecast_runtime.py` and `graph-editor/lib/runner/cohort_forecast_v3.py`: retire or bypass `build_upstream_carrier` / `_resolve_frame_carrier_state` as live carrier-timing owners for corrected CF, except for explicitly dev/diagnostic surfaces.
- `graph-editor/lib/runner/forecast_state.py`: consume conditioned primitive/composed objects rather than doing all conditioning inside the trajectory projection.
- `graph-editor/lib/runner/span_kernel.py`: compose primitive timing and probability objects into subject and carrier spans.
- `graph-editor/lib/runner/cohort_forecast_v3.py`: consume prepared primitive/composed objects for rows.
- `graph-editor/lib/api_handlers.py`: orchestrate primitive resolution once per scenario and share it between whole-graph CF and in-band cohort maturity where possible.
- tests near evidence merge/adapters, forecast runtime, forecast state, carrier object contract, and outside-in cohort factorisation.

## Stage 0 — Baseline and Boundary Check (split into 0a, 0b, 0c)

Stage 0 is a documentation-only readiness gate. It is intentionally split into three sub-stages so a single stage-runner session can complete one sub-stage without conflating inventory work, forensic work, and contract sign-off. Each sub-stage produces its own baseline note. No code or test changes are made in any 0x sub-stage; runtime/test changes start at Stage 1.

Stages 0a and 0b may run in either order. Stage 0c depends on the outputs of 0a and 0b but its outputs are the contracts Stages 1–9 are bound by. Later stages must cite the specific 0a/0b/0c artefact they depend on, not "Stage 0" generically.

## Stage 0a — Code Inventory and Precondition Check

Stage 0a records the current conditioning sites, line numbers, topology surface, and 73m precondition state. It is documentation-only.

Required record:

- no live latency/non-latency router owns v3 cohort_maturity semantics;
- subject-span composition is the live `X -> end` object for single-hop and multi-hop consumers;
- carrier composition is the live `A -> X` object for active `cohort(A != X)`;
- empirical Tier 2 and weak-prior carrier timing remain possible through scoped compatibility paths and must be classified before 73n cutover;
- current `window_subject_helper` role selection;
- current WP8 default-off behaviour;
- current evidence adapter `n=x`, `k=y` mapping;
- current trajectory-local aggregate IS conditioning site;
- current doc-52 subset/effective-evidence logic and where it is applied;
- current window entry points and tests that prove existing window conditioning behaviour;
- current carrier construction sites, distinguishing canonical `compose_carrier_to_x` consumers from scoped compatibility users of `build_upstream_carrier`;
- any remaining empirical Tier 2 or weak-prior carrier timing path, including whether it is live, diagnostic-only, or dev-only;
- current subject and window call sites that expect `p_conditioning_evidence`;
- current evidence, if any, that live production CF requests require residual/complement sibling primitives rather than ordinary parameterised sibling edges already covered by the requested carrier or subject closure;
- current complex-topology incidence in representative scoped and whole-graph CF requests, classified against the existing doc 29b cases: serial path, upstream diamond/fan-in/fan-out, subject diamond/fan-in/fan-out, ordinary leakage, join at `X`, split at `X`, metadata mismatch, overhanging/cross-`X` prepared block if any such block is considered, residual/complement sibling requirement, or deterministic identity;
- current code support for each classified topology case: record whether existing `span_kernel` / `compose_carrier_to_x` DAG algebra already supports it, whether 73n only needs to feed conditioned edge primitives into that algebra, or whether a prepared span primitive must be rejected/fallback-to-edge because it crosses the `X` boundary or mixes incompatible metadata;
- current graph-output sibling rebalancing path through UpdateManager after FE/CF writes;
- current snapshot DB admission/as-at API surfaces used by CF evidence resolution;
- current evidence retrieval shape: how to fetch a contiguous superset broad enough to cover all primitive-local weighted day maps, and whether fields such as `selected_anchor_days` are provenance-only or admission-active for each caller;
- current state of the building blocks the new prefix-arrival timing provider will compose, including `compose_carrier_to_x`, `build_node_arrival_cache`, deterministic prefix CDFs, and draw-level prefix CDFs from existing span/carrier machinery, with a written acknowledgement that the request-scoped `arrival_weight[node_id][calendar_day]` object is a new abstraction Stage 2 must construct rather than something live code already produces;
- current shape of the canonical `EvidenceSet` (integer `n`/`k` totals) and any existing weighted views, with a written acknowledgement that the floating-point `n_weighted`/`k_weighted` primitive evidence view is a new object Stage 1 must define separately from the existing merge layer rather than reusing `EvidenceSet` directly;
- current line inventory for `prepare_forecast_runtime_inputs`, `compute_forecast_trajectory`, aggregate IS, doc-52 compatibility blend, and projection readout sites;
- current fixed-seed RNG surfaces in the trajectory-local draw machinery (including the `42` and `43` constants), with file paths and line numbers, so Stage 1 can replace each one with a key-derived seed stream;
- baseline test suites and tolerances for `test_carrier_object_contract.py`, the completed 73m router/subject-span canaries, `test_cohort_factorised_outside_in.py`, evidence merge/adapters, and WP8 default-off behaviour;
- strict xfails and handoff targets from `73m-stage-0-baseline.md`, classified as 73n flip-to-green targets or wrong-contract tests to rewrite/delete.

Stop condition: a Stage 0a baseline note records every item above with file paths and line numbers, distinguishes primitive conditioning defects from carrier composition defects and projection defects, and states whether Stage 3+ is blocked by any missing 73m precondition, by a live production requirement for unsupported residual/complement primitives, or by a current topology case not covered by the existing doc 29b/span-kernel DAG algebra.

## Stage 0b — Forensic Localisation and Test Triage

Stage 0b localises F14 and triages non-latency / AP58 / `build_cohort_evidence_from_frames` behaviour into a single classified target list. It is documentation-only.

Required non-latency and AP58 sweep:

- inventory every existing test that asserts non-latency, identity-carrier, A=X, multi-hop terminal-non-latency, or instant-carrier behaviour;
- classify each as one of: already-correct guard that must stay green, wrong-contract assertion to delete or replace, 73n flip-to-green xfail, or source-timestamp/admission test where `tau=0` has a data-source meaning rather than runtime-object meaning;
- preserve any real 73n defect signal as a strict xfail rather than rewriting it to pass, and record the exact 73n stage expected to flip it green;
- reject any test rewrite whose only effect is to skip `tau=0` for a runtime non-latency invariant. `tau=0` may be excluded only when the test is explicitly about source observation timing and says so in the assertion reason;
- audit `build_cohort_evidence_from_frames`, `_resolve_frame_carrier_state`, `compute_forecast_trajectory`, `span_kernel._edge_sub_probability_density`, and `UpdateManager.applyBatchLAGValues` for local projection/evidence logic that could bypass the composed primitive runtime object;
- record whether `build_cohort_evidence_from_frames` remains a live projection owner after 73m or is only a temporary compatibility surface that 73n will retire or reduce to an adapter.

Required forensic localisation, satisfying the 73g precondition before any code change:

- run the two named F14 queries `from(simple-a).to(simple-b).window(-90d:)` and `from(simple-b).to(simple-c).cohort(1-Mar-26:3-Mar-26).asat(3-Mar-26)`;
- for each query, record the public scalar output, the internal trajectory-local posterior summary before projection, the raw `Σy/Σx` over admitted rows, and the maturity-aware likelihood's internal point estimate;
- localise the observed 0.546-vs-0.70 gap on `from(simple-a).to(simple-b).window(-90d:)` to one of: the maturity-aware likelihood itself produces the raw figure (defect inside conditioning), the likelihood produces the mature figure but projection overwrites it (defect inside projection), or another object on the runtime trace;
- record the first runtime object whose actual state contradicts the 73g invariants. That object is the entry point for the implementation and frames Stage 3's reuse-vs-replace decision for the existing maturity-aware likelihood.

Stop condition: a Stage 0b note produces (a) a single classified AP58/non-latency target list with each item carrying its target stage, (b) the F14 0.546-vs-0.70 gap localised to either the maturity-aware likelihood or the projection layer with concrete diagnostic numbers for each candidate, and (c) a recorded decision for `build_cohort_evidence_from_frames` and adjacent surfaces — flip target, retirement target, or reduced-to-adapter target.

## Stage 0c — Contracts, Tolerances, and Read Coordination

Stage 0c commits the numeric oracles, snapshot DB read/admission contract, evidence-clock alignment contract, and primitive-count performance estimate that later stages must implement. It depends on the inventory and forensic outputs from 0a and 0b. Persistent-cache invalidation is not a Stage 0c gate; Stage 7 owns that contract if and when it introduces persistent primitive or composition caches.

Required numeric parity tolerances, committed as concrete numbers rather than as the phrase "stochastic tolerance":

- per public quantity used in cutover gating — at minimum the displayed rate, the carrier reach where applicable, and ESS — record an absolute band and a relative band that Stage 5a, Stage 5b, Stage 5c, and Stage 6 must satisfy;
- separate shadow-comparison tolerances, used while both primitive and legacy paths run in parallel, from acceptance tolerances, used at flag flip;
- record the legacy public outputs for the named F14 queries and a small set of representative `window(X-Y)` and `cohort(A, X-end)` fixtures so each later cutover has a fixed numeric oracle.

Required snapshot DB read/admission coordination handshake:

- name the snapshot DB workstream owner and contact point for read/admission contract questions;
- record the snapshot DB API surface that CF evidence resolution consumes today, including read APIs, `retrieved_at` handling, as-at reconstruction or materialisation conventions, and any read-through cache behaviour visible to CF;
- record whether existing snapshot writes invalidate any live read-through state that CF already consumes today. Do not design the future primitive-cache invalidation policy here.

Required evidence-clock alignment handshake:

- record whether evidence retrieval can fetch a scenario-wide superset across all primitive-local clocks in one call or needs per-primitive reads;
- record the shared representation for the contexted scenario/root prefix-arrival map `arrival_weight[node_id][calendar_day]`, weighted primitive evidence rows, raw totals, weighted totals, and provenance, with the explicit acknowledgement that this map is a new request-scoped abstraction Stage 2 must construct on top of the existing `compose_carrier_to_x` / `build_node_arrival_cache` building blocks rather than something live code already produces;
- name the source of truth for prefix delay PMFs that the new provider will consume and prove it is backed by existing span/carrier composition rather than a second timing implementation;
- confirm that the new provider handles DAG fan-out, fan-in, joins, and ordinary leakage in topological order using the same doc 29b/span-kernel algebra as subject and carrier composition; no second timing implementation and no special split/join branch may be introduced for evidence-clock alignment;
- define how `asat()` interacts with primitive-local clocks: retrieved observations must satisfy the as-at boundary even when the local primitive evidence day lies after the anchor date;
- identify tests where downstream `cohort()` primitives would be wrong if every primitive reused the public anchor date bounds.

Required primitive-count and performance estimate:

- estimate representative primitive counts and runtime cost for scoped `cohort_maturity`, scoped `window()`, and whole-graph CF requests;
- record the measurement method and fixtures used so later stages can repeat the measurement when whole-graph CF is widened.

Stop condition: a Stage 0c contract note (a) commits specific numeric parity tolerances per axis for each of Stages 5a, 5b, 5c, and 6; (b) records the snapshot DB read/admission contract that Stages 2 and 3 will consume; (c) records the evidence-clock alignment contract that Stage 2 must implement, naming the request-scoped `arrival_weight[node_id][calendar_day]` map as a Stage 2 construction deliverable rather than something already available, and stating how complex topology reuses the existing DAG algebra; and (d) records the primitive-count and runtime baselines that performance gating decisions in later stages will reference.

## Stage 1 — Primitive Posterior Contract

Define the runtime shape of a conditioned transition primitive.

The contract must include identity, evidence scope, raw evidence provenance, weighted-evidence-view provenance, effective-evidence provenance, posterior probability, posterior timing, draw-family identity, unconditioned copies, residual-policy provenance where applicable, subset-policy provenance, compatibility-blend provenance where applicable, and conditioning status.

The weighted primitive evidence view is a new object that this stage must pin before Stage 2 changes any merge caller. It is distinct from the canonical `EvidenceSet` used by the existing shared merge layer: `EvidenceSet` carries integer `n` and `k` totals, while the weighted view carries floating-point `n_weighted` and `k_weighted` rows produced by multiplying admitted rows by their normalised `arrival_weight[U]`. The contract must define this object's field shape, where it lives relative to raw `EvidenceSet`, what provenance it preserves (raw totals, weighted totals, the source `arrival_weight[U]` summary, and the binding policy applied), and which conditioning consumer is allowed to read it. Stage 2 may not change merge callers — adapters, retrieval superset binding, or `merge_evidence_candidates` consumers — until this contract is recorded. The intent is to keep raw `EvidenceSet` semantics unchanged for non-primitive callers and confine the floating-point weighted view to primitive evidence resolution.

The contract must also include worked construction sketches in prose for four states:

- a conditioned parameterised primitive with raw `E`, effective `e`, posterior probability/timing draws, unconditioned twins, draw-family identity, and conditioning health;
- a prior-only parameterised primitive where raw `E` is empty, effective `e` is empty, the prior/source model remains usable, and conditioning status is not misreported as conditioned;
- an unsupported residual/complement transition that names the branch complement or residual closure that would be required and states that CF does not derive it in this implementation;
- an unavailable or degraded primitive that names the missing evidence, missing source, unsupported residual/complement requirement, or moments-only uncertainty that prevents draw-coherent composition.

It must be valid for:

- conditioned parameterised edges;
- prior-only parameterised edges with no admitted evidence;
- unsupported residual/complement edges;
- unavailable/degraded edges;
- structurally non-latency edges;
- missing or unavailable edges that must fail loudly.

The structurally non-latency sketch must show probability and timing separately: `p` may be conditioned or prior-only, but the timing object remains a structural identity and any `mu`, `sigma`, onset, or completeness compatibility fields are fixed/provenance-only rather than evidence-conditioned.

The contract must also specify draw-family identity precisely. This is a correctness requirement and must not be deferred to implementation:

- draw count `S` is fixed at request scope; consumers may not request fewer or more draws and remain coherent;
- draw indices `s ∈ [0, S)` are stable across all consumers reading the same primitive under the same scope;
- the draw-family key is a deterministic function of primitive identity, scenario scope, evidence role, date bounds, context and case scope, regime or hash-family identity, as-at boundary, model-source preference, draw count `S`, and a scenario-level RNG seed. Two consumers presenting the same key must receive the same posterior draws under matching draw indices;
- a primitive must construct its draw family in exactly one of three explicit modes: (a) sample its posterior at indices `s` from the canonical scenario RNG stream derived from the draw-family key, (b) reuse a coherent IS or MCMC draw set already produced during primitive conditioning where one exists for the same scope, or (c) decline to emit a draw family and expose moments-only provenance;
- a primitive that emits moments only must not be presented as a coherent draw family. Consumers needing draw-level uncertainty must either skip this primitive or mark their composed result degraded. This refusal is enforced at the primitive contract level, not in composition.

Stage 1 must also retire the existing fixed-seed RNG surfaces before any later stage claims draw coherence. The Stage 0a inventory lists the current fixed-seed call sites in the trajectory-local draw machinery (notably the `42` and `43` constants). Stage 1's deliverable is a key-derived seed stream that replaces each of those sites: every primitive draw, every IS resampling step, and every coherent posterior draw set used by composition must seed from a deterministic function of the draw-family key defined above, not from a hard-coded constant. Any fixed-seed call site that survives Stage 1 must be (i) explicitly classified as belonging to a non-primitive surface that is out of scope for primitive draw coherence, with that classification recorded in the Stage 1 note, or (ii) carried as a strict xfail with a target stage that flips it to the keyed stream. No later stage may claim primitive draw coherence while a fixed-seed call site is still feeding any primitive's draw construction.

Stop condition: tests can construct and serialise primitive posterior objects for each state without invoking carrier or subject composition, can distinguish raw `E`, the weighted evidence view, effective `e`, primitive conditioning policy, and any separate compatibility blend, can verify that two test consumers presenting the same draw-family key receive identical draws while a moments-only primitive refuses to act as a coherent draw family, and can verify that no primitive's draw construction reads a fixed-seed call site recorded by Stage 0a unless that site is explicitly out-of-scope-classified.

## Stage 2 — Primitive Evidence Resolution

Move evidence resolution to the primitive layer.

For every parameterised primitive, build the existing `EvidenceScope` for `window(U-V)` under the request's scenario, date bounds, context, regime, and as-at boundary. Convert snapshot, file, and reconstructed candidates through existing adapters, then call the shared merge.

Stage 2 must implement the evidence-clock alignment contract from Stage 0c. For `cohort()` requests, the primitive's evidence date bounds and weighted day map are derived from prefix timing to the primitive source node. Evidence retrieval must cover the union of these primitive-local clocks before merge/binding. The primitive merge then admits evidence from the support of that primitive's local `U`-arrival clock and constructs the weighted evidence view consumed later by conditioning. Reusing the public anchor date bounds for a downstream primitive is allowed only when the alignment contract proves the primitive source clock is identical to the anchor clock.

Stage 2 owns the construction of the request-scoped prefix-arrival map `arrival_weight[node_id][calendar_day]` as a first-class deliverable. This object does not exist in live code today: `compose_carrier_to_x` composes one carrier `A -> X` from supplied primitives, and `build_node_arrival_cache` builds whole-graph node arrival caches; both are building blocks. Stage 2 must build the new map on top of those building blocks for each contexted scenario/root, populating an entry `arrival_weight[U]` for every primitive source node `U` reachable in the request topology. The map must be keyed by the same identity used for the primitive registry (scenario id, request root, context and case scope, regime/hash family, as-at boundary, source-preference, and parameter fingerprint), built in topological order, reused across primitives within the request rather than recomputed per primitive, and live in the request-scoped registry. The Stage 0c contract names the supported topology cases (serial, doc 29b-style upstream/subject diamonds and fan-in/fan-out, ordinary leakage); cases recorded as degraded or unsupported in Stage 0c must produce a degraded entry with explicit provenance rather than a silently approximate weight map. No second timing implementation may be introduced for this construction; every prefix delay PMF the map consumes must come from the existing span/carrier composition layer.

This stage should not change the numerical conditioning method yet if that would make the change too broad. It should first prove that every primitive has the correct raw `EvidenceSet` and provenance.

Stage 2 must be test-driven around evidence-clock invariants before it is wired into live conditioning:

- clock identity tests: `window(X-Y)`, `cohort(A = X)`, and non-latency prefixes produce the same primitive-local day set as the request source clock, including `tau=0`;
- deterministic-shift tests: a synthetic `cohort(A, d:d)` with a deterministic prefix delay to `U` admits `window(U-V)` evidence on `d + delay`, rejects same-primitive evidence on the unshifted anchor day, and keeps the leading primitive on the anchor day;
- topological-map tests: one contexted scenario/root prefix-arrival map is built in graph topological order and reused by multiple primitives; test instrumentation must prove `root -> U` prefixes are not recomputed independently per primitive;
- contexted-source tests: changing context, regime, case scope, or `model_source_preference` changes the prefix-arrival map key and, where model vars differ, the resulting `arrival_weight[node_id]`; uncontexted graph defaults must not be read by the provider;
- stochastic-prefix tests: a latency-bearing prefix produces `arrival_weight[node_id]` from the shared prefix-arrival timing provider, and the day weights match the mean differenced prefix CDF within a fixed tolerance;
- carrier-DAG clock tests: a doc 29b-style upstream diamond/fan-in/fan-out fixture builds `arrival_weight[X]` by topological propagation through the shared prefix provider, and the resulting reach and timing match the existing `compose_carrier_to_x` DAG algebra within fixed tolerance;
- subject-DAG clock tests: a doc 29b-style downstream diamond/fan-in/fan-out fixture enumerates and binds all subject-side primitives needed by the composed `subject_span`, without collapsing to the terminal edge or recomputing per-primitive prefixes independently;
- boundary-at-`X` tests: a join at `X` is owned by `carrier_to_x`, a split at `X` is owned by `subject_span`, and neither side reuses the other's topology or evidence role when binding primitive evidence;
- regime-boundary tests: any prepared span primitive used by this plan is rejected or replaced by edge primitives if it crosses the `X` boundary or mixes incompatible slice, context, regime, or as-at metadata;
- no-second-timing-path tests: evidence-clock alignment and later subject/carrier composition read prefix timing from the same provider or composed primitive layer, with no standalone timing or MC forecast branch created for evidence alignment;
- retrieval-superset tests: the evidence retrieval layer fetches rows outside the public anchor date bounds when a downstream primitive's local clock requires them, while the per-primitive binding layer prevents those rows from leaking into unrelated primitives;
- as-at tests: a downstream primitive-local evidence day after the anchor date is admitted only when its `retrieved_at` satisfies the request as-at boundary, and is skipped when retrieved after as-at;
- weighted-view tests: contradictory evidence on two local days is weighted according to `arrival_weight[U]`, and the likelihood consumes weighted `n`/`k` rather than the raw retrieval superset totals;
- merge opt-in tests: primitive weighted binding is active for primitive evidence scopes and does not silently change unrelated callers of `merge_evidence_candidates`;
- mass-accounting tests: doc-52 `m_S`, `m_G`, and `r` are computed from the primitive weighted evidence view, not from the whole retrieval superset;
- registry-key tests: primitive cache/registry keys include the evidence-clock alignment identity, so two scenarios with the same edge but different induced local clocks cannot share a posterior accidentally;
- outside-in anti-leak tests: construct contradictory evidence on the anchor day and the shifted downstream day, then prove the downstream primitive conditions on the shifted evidence and not the anchor-day evidence.

Stop condition: primitive evidence totals match existing window evidence totals for simple window queries; downstream `cohort()` primitive evidence scopes show prefix-clock-weighted local evidence clocks where appropriate; supported carrier-DAG and subject-DAG fixtures use the same doc 29b/span-kernel topology algebra as the shared span/carrier composer; prepared span primitives, if used, obey regime-boundary and metadata compatibility rules or fall back to edge primitives; no cohort-family rows are admitted while WP8 is default-off; the shadow primitive inventory is reviewable; raw `E`, weighted evidence view, and effective `e` are stored separately even when they are numerically equal; and diagnostics show the retrieval superset, the contexted scenario/root prefix-arrival map, topology case, and the per-primitive binding decision.

## Stage 3 — Subset and Primitive Conditioning Policy

Make each parameterised primitive produce a posterior probability and timing object from its admitted evidence after subset/effective-evidence policy.

The initial conditioning policy should reuse the current CF maturity-aware likelihood discipline rather than inventing a new estimator. Stage 0 must name the canonical function path, expected likelihood inputs, and existing test tolerance before Stage 3 starts. The important change is that the posterior belongs to the primitive and can be consumed by multiple composed objects.

The policy must expose:

- raw evidence totals;
- weighted evidence totals after primitive-local evidence-clock binding;
- effective evidence totals, including the explicit `e == E` case;
- `m_S`, `m_G`, `r`, and the explicit raw-nonempty/full-subset-limit case where covered subset evidence is provenance only and the primitive remains numerically equal to model vars;
- subset/overlap decision and confidence;
- prior source;
- posterior summary or draw family;
- for structurally non-latency primitives, probability posterior status separately from fixed structural timing identity;
- draw-family identity and whether downstream draw-level composition is allowed;
- ESS or equivalent health diagnostics where IS is used;
- separate compatibility-blend diagnostics if any doc-52 row or draw blend remains outside effective-evidence selection;
- whether the primitive remained prior-only.

Stop condition: simple `window(U-V)` output can be produced by reading the conditioned primitive rather than by a separate conditioning path, within the Stage 0 named stochastic tolerance; composed consumers do not re-run subset logic or compatibility blending; and a known-subset fixture proves the raw-nonempty/full-subset-limit case leaves the primitive equal to its model-var input.

## Stage 4 — Unsupported Residual and Unparameterised Edge Guard

Define and implement the first guardrail for unsupported residual, complement, and unparameterised edge requirements.

The first implementation deliberately does not derive residual probabilities. It may pass through explicit deterministic graph semantics, but otherwise marks these edges unsupported or degraded for live CF composition. This is distinct from graph-output sibling rebalancing after CF writeback, which remains UpdateManager-owned.

This guard must not turn supported doc 29b split/join/leakage topology into a residual/complement problem. A split, join, fan-in, fan-out, or side-exit leakage edge remains a normal DAG-composition case when it lies inside the carrier or subject closure and has parameterised primitives. The guard applies only when composition would require an unparameterised residual/complement edge, adjacency-only `1 - p`, or a prepared span block that crosses the `X` boundary or mixes incompatible metadata.

Stop condition: tests prove unsupported residual/complement requirements fail loudly or degrade with provenance, adjacency-only residual inference is rejected, no-evidence parameterised primitives remain prior-only rather than unsupported residuals, supported split/join/leakage topology continues through the shared DAG composer, no `1 - p` or proportional sibling rebalancing is performed inside CF composition, and CF graph writeback still routes through UpdateManager so existing sibling rebalancing remains outside the runtime model.

## Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle)

Cut over single-hop `window(X-Y)` and single-hop `subject_span(X -> Y)` to read the conditioned primitive. This is the migration's parity-preserving step and its numeric oracle: existing simple-window outputs must remain within the Stage 0 acceptance tolerance committed for this sub-stage.

The legacy aggregate-IS path in `compute_forecast_trajectory` must not remain a second owner of evidence admission or posterior updating. Its numerical machinery may be extracted or reused by primitive construction, but the public window output must read the primitive posterior.

Migration rules:

- run primitive and legacy paths in shadow mode, gated by an independent `single_hop_primitive_readout` flag (or equivalent), before the flag is enabled by default;
- preserve single-hop `window(X-Y)` numerical behaviour within the Stage 0 acceptance tolerance recorded for this sub-stage;
- single-hop `subject_span(X -> Y)` returns the conditioned primitive directly;
- keep a rollback switch until Stage 6 acceptance proves window, subject, and carrier consumers share the same request-scoped primitive registry;
- move or wrap the current aggregate-IS/window conditioning logic so primitive construction owns it;
- keep `p_conditioning_evidence` as compatibility/provenance metadata only; it must not decide evidence ownership once primitive evidence provenance exists;
- apply doc-52 subset/effective-evidence logic once at primitive construction;
- do not apply any carrier logic beyond the identity carrier in window mode;
- add diagnostics showing the `window()` output came from primitive posterior `X -> Y`.

Stop condition: single-hop `window(X-Y)` parity tests stay green within the Stage 0 acceptance tolerance, single-hop `subject_span` returns the conditioned primitive directly, diagnostics identify primitive-posterior provenance, and the named F14 single-hop fixture's public scalar matches the Stage 0 numeric oracle once the F14 root cause identified at Stage 0 has been addressed.

## Stage 5b — Multi-Hop Subject Span Composition

Compose multi-hop `subject_span(X -> Z)` from conditioned primitives along the subject topology. This is a semantically changing step, not a parity-preserving one. If the legacy path produced a terminal-edge-only or trajectory-local result for any multi-hop subject, the new composed result will differ; that difference is the corrected semantics, not a regression.

Stage 5b depends on Stage 5a's primitive registry and posterior contract being live for at least the single-hop case. It does not depend on Stage 5c.

Migration rules:

- gate the composed multi-hop subject span behind an independent `multi_hop_subject_composition` flag, separate from Stage 5a's flag;
- compose primitive probability and conditional timing along the full `X -> Z` span, never the terminal edge alone;
- preserve draw-family coherence across all primitives in the span using the Stage 1 draw-identity rules;
- classify any divergence from legacy as one of: (i) the legacy result was correct and the composed result is a regression — stop and investigate; (ii) the legacy result was a known terminal-edge-only or trajectory-local defect and the composed result is the corrected target semantics — record the named semantic reason, tie it to a 73g invariant or a clause of the semantics doc, and update or add tests; (iii) draw-family or moments-only degradation — surface as degraded provenance, not silent change;
- reject any fallback that collapses a multi-hop subject to a terminal-edge primitive when more than one primitive is on the span.

Stop condition: multi-hop `subject_span` tests prove the full `X -> end` primitive composition is consumed; every divergence from legacy is named, tied to an invariant in 73g and the semantics doc, and covered by tests; degraded composition results carry explicit provenance and do not silently masquerade as coherent draw families.

## Stage 5c — Multi-Hop Window Readout

Adapt multi-hop `window(X-Z)` to read the composed multi-hop subject span produced by Stage 5b.

Stage 5c depends on Stage 5b. It does not introduce new conditioning. It changes the public window readout for multi-hop queries from whatever path it currently takes to the composed `subject_span(X -> Z)` produced by Stage 5b, with the identity carrier in window mode.

Migration rules:

- gate the multi-hop window readout behind an independent `multi_hop_window_readout` flag, separate from Stage 5a and Stage 5b flags;
- read the composed subject span, not the terminal edge, and not a separate multi-hop window evidence-conditioning branch;
- preserve `p_conditioning_evidence` as compatibility/provenance metadata only; projection and diagnostics must name primitive composition directly;
- classify multi-hop window parity separately from single-hop. The target is composed `X -> Z` subject-span semantics, not preservation of any old terminal-edge-only read. Any intentional non-parity must be named, tied to an invariant, and covered by tests.

Stop condition: multi-hop `window(X-Z)` reads the Stage 5b composed subject span, diagnostics identify composed-subject-span provenance, and any divergence from legacy is reconciled and tested per the rules above.

## Stage 6 — Carrier Consumer

Adapt `carrier_to_x` to compose primitive posteriors.

This stage uses the completed composer from 73m. It should not add carrier evidence roles. It should feed the composer the same primitive posterior objects used by other consumers.

For active `cohort(A != X)`, carrier reach and timing come from the conditioned upstream primitive topology. For `window()` and `cohort(A = X)`, the carrier remains identity. This stage must also remove the scoped compatibility split where `NodeArrivalState` for cohort evidence materialisation is built through `build_upstream_carrier` while canonical `carrier_to_x` uses `compose_carrier_to_x`.

The observations that once fed empirical Tier 2 are still useful evidence, but they should condition upstream primitives through the standard primitive policy. Any remaining empirical Tier 2 path must be dev-only, diagnostic-only, or behind an explicit reviewed flag that defaults off. This stage confirms 73m's quarantine still holds after primitive-conditioned carrier wiring, rather than introducing a new carrier evidence route.

Once Stages 5a, 5b, 5c, and 6 are all at acceptance, identify every aggregate-IS, window evidence-admission, and trajectory-local conditioning site that no longer has a live caller. Each such site must be either deleted or relabelled and proven to be an internal helper called only by primitive construction. A leftover code path that could be reached under any flag combination must be deleted, not gated, and the reachability test must be recorded.

Stop condition: changing upstream `window(U-V)` evidence moves carrier reach/timing for consumers that include that primitive; target subject-only evidence does not move unrelated carrier state; diagnostics for live CF identify carrier source as primitive composition rather than empirical carrier replacement; `build_upstream_carrier` / empirical Tier 2 / weak-prior carrier timing are unreachable on the live corrected CF path except behind explicit dev/diagnostic flags; the rollback flag can still restore the legacy public path until acceptance completes; and a recorded dead-code audit confirms that no aggregate-IS, window evidence-admission, or trajectory-local conditioning site remains live other than as an internal helper of primitive construction, with a static or test-driven reachability check covering all flag combinations.

## Stage 7 — Primitive and Composition Caching

Add cache structure only after uncached primitive conditioning works.

The first persistent cache should prefer primitive posterior caching over whole-carrier caching. Carrier and subject caches can then be derived from primitive cache entries.

Invalidation must react to graph edits, parameter edits, snapshot DB writes, scenario scope changes, context/regime changes, as-at changes, and source-preference changes. It must not rely on time alone.

Before adding persistent caches, Stage 7 must define the cache invalidation policy with the snapshot DB workstream owner. That policy must name which snapshot writes can change admitted evidence under a primitive's scope, which writes are outside any live primitive's scope, and how invalidation propagates from a primitive posterior to composed carrier or subject objects that consumed it. This is a Stage 7 entry contract because persistent caching is optional before this stage; Stages 0 through 6 must not be blocked on future cache invalidation design.

Stop condition: cached and uncached primitive posteriors and composed carrier/subject objects are numerically equivalent on focused fixtures, and a focused regression test mutates a snapshot row, observes that the affected primitive posterior recomputes on the next read, and observes that an unrelated primitive's cache entry survives.

## Stage 8 — Cross-Surface Projection and Provenance

Expose provenance showing the primitive substrate.

Closure-required response diagnostics should identify:

- primitive ids used;
- evidence role per primitive;
- raw evidence totals per primitive;
- weighted evidence totals per primitive after evidence-clock binding;
- effective evidence totals per primitive;
- evidence-clock provenance per primitive, including prefix topology, prefix timing source, context/regime/source identity, and `arrival_weight[U]` summary;
- prior source per primitive;
- conditioning status per primitive;
- unsupported residual/complement transition diagnostics, if any;
- whether a `window()` output is a direct primitive readout or a composed subject-span readout;
- composed subject and carrier topology;
- composed reach/probability and timing summaries.

Cache hit/miss status is useful once persistent caching is enabled, but it is not required to close 73h Issue 2.

Stop condition: a reviewer can explain a CF scalar or cohort_maturity row by reading primitive and composition provenance without reading logs, and no live consumer requires `p_conditioning_evidence` or compatibility-blend metadata to decide evidence ownership. If `p_conditioning_evidence` remains, it must be documented as compatibility metadata rather than transitional ownership state.

## Stage 9 — Acceptance Tests

Required tests:

- no `carrier_to_x_arrivals` role exists;
- WP8 remains default-off;
- primitive evidence resolution admits only `window(U-V)` rows under the pre-WP8 CF policy;
- primitive evidence retrieval fetches the scenario-wide superset required by all primitive-local clocks, then binds each primitive using `arrival_weight[U]` from the contexted scenario/root prefix-arrival map on its own source-node evidence clock rather than the public anchor bounds by default;
- `cohort()` tests cover a downstream primitive where prefix timing shifts and weights the required `window(U-V)` evidence dates, including an as-at boundary that limits retrieval by `retrieved_at` without collapsing the local evidence clock;
- carrier-side split/join tests prove a doc 29b-style upstream DAG composes through `carrier_to_x`, binds primitive-local clocks from the shared prefix-arrival map, and keeps carrier reach separate from displayed subject rates;
- subject-side split/join tests prove a doc 29b-style downstream DAG composes through `subject_span`, not terminal-edge-only conditioning;
- boundary-at-`X` tests prove a join at `X` is carrier-owned, a split at `X` is subject-owned, and projection does not double-count a primitive across the carrier/subject boundary;
- regime-boundary tests prove prepared span primitives, if used, do not cross the `X` boundary or mix incompatible slice, context, regime, or as-at metadata; incompatible spans fall back to edge primitives or are rejected before conditioning;
- raw `E` and effective `e` are both represented, including the `e == E` case;
- raw `E`, weighted evidence view, and effective `e` are separately represented, and the conditioning likelihood consumes weighted `n`/`k` rather than raw superset totals;
- raw-nonempty/full-subset-limit evidence is represented with `m_S`, `m_G`, and `r`, and leaves the conditioned primitive numerically equal to model vars;
- doc-52 subset correction is applied at primitive level and not by composed consumers;
- existing window parity tests stay green while `window(X-Y)` reads the conditioned primitive;
- window diagnostics identify primitive posterior provenance and no longer present the trajectory solver as the evidence owner;
- multi-hop `window(X-Z)` reads composed subject-span primitives, not terminal-edge-only conditioning;
- single-hop `subject_span` degenerates to the conditioned primitive;
- multi-hop `subject_span` composes all conditioned primitives in the span;
- complex subject and carrier DAGs use the existing doc 29b/span-kernel algebra; 73n never falls back to terminal-edge, last-path, or independent per-route evidence binding behaviour;
- structurally non-latency primitives can condition `p` while timing remains fixed identity, with no evidence-conditioned `mu`, `sigma`, onset, or completeness;
- runtime non-latency timing is saturated at `tau=0`; no runtime composition or projection test skips `tau=0` unless the test is explicitly about external source observation timing rather than primitive timing semantics;
- `carrier_to_x` composes conditioned upstream primitives;
- scoped cohort evidence materialisation uses the same composed primitive-backed carrier timing as `carrier_to_x`; legacy `build_upstream_carrier`, empirical Tier 2, and weak-prior carrier timing are not live owners on the corrected path;
- unsupported residual/complement requirements surface as unavailable or degraded with provenance;
- adjacency-only residual inference is rejected;
- no `1 - p` or proportional sibling rebalancing is performed inside CF primitive composition;
- CF writeback still routes through UpdateManager so graph-surface sibling rebalancing remains outside the runtime model;
- draw-family identity is preserved when the same primitive feeds multiple composed consumers;
- moments-only or degraded primitives do not masquerade as coherent draw families;
- parameterised no-evidence edges remain prior-only rather than being misclassified as unsupported residual/complement edges;
- upstream primitive evidence moves carrier consumers that depend on it;
- target subject evidence does not move unrelated upstream carrier primitives;
- projection does not multiply displayed rates by carrier reach;
- empirical Tier 2 is not selected on the live corrected path;
- cached and uncached primitive/composed outputs match once caching is introduced;
- feature-flag rollback restores the pre-cutover public path until final acceptance, with independent flags for Stage 5a, Stage 5b, Stage 5c, and Stage 6;
- scoped and representative whole-graph primitive enumeration have recorded runtime measurements;
- once persistent caching is introduced, snapshot DB write/as-at invalidation behaviour is tested against the Stage 7 invalidation contract, including a regression that mutates a snapshot row and verifies targeted invalidation;
- a dead-code audit recorded after Stage 6 confirms no legacy aggregate-IS, window evidence-admission, or trajectory-local conditioning site remains a live owner under any flag combination;
- draw-family identity tests verify that two consumers reading the same primitive under the same scope receive matching draws, and that moments-only primitives refuse to act as coherent draw families.
- CF outside-in subset-identity tests prove that as scoped Cohort evidence mass approaches the selected global/model-var evidence mass, primitive posteriors, composed carrier/subject objects, and the downstream MC output tend to the model-var-driven result rather than raw `k/n`.
- FE topo outside-in subset-identity tests prove the same invariant through the FE enrichment medium: when scoped Cohort evidence and model vars share the same evidence base and `m_S / m_G -> 1`, the query-scoped output must tend to the model-var baseline rather than counting the same evidence twice.
- the Stage 0 non-latency/AP58 sweep has either been resolved or carried forward as named strict xfails that 73n is expected to flip green; no wrong-contract count-equality assertion is left disguised as a 73n defect signal.

Regression discipline for `test_cohort_factorised_outside_in.py` remains strict. This plan may only move tests in the documented direction, must not xfail or skip existing passing tests, and must not relax assertions to hide changed semantics.

## Stage 10 — Codebase Documentation Pass

After the implementation and acceptance tests land, update the maintained codebase documentation so the full CF journey is discoverable without reading this project plan or forensic notes.

This stage is documentation-only. It should update existing codebase-reference docs in place where possible, especially `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md`, and only create a new `docs/current/codebase/` reference if the existing structure cannot cleanly describe the final architecture. Project-bayes plans and baselines may remain as historical implementation records, but they must not be the only place a future maintainer can learn how CF works.

The documentation pass must characterise the final journey end to end:

- request and scenario scope resolution;
- primitive enumeration and request-scoped registry ownership;
- evidence retrieval, raw `EvidenceSet`, weighted evidence view, effective evidence, and subset policy;
- primitive posterior construction and draw-family coherence;
- subject-span, carrier-to-X, and window readout composition;
- projection into rows, CF scalars, graph fields, and diagnostics;
- unsupported residual/complement handling and the relationship to graph-output sibling rebalancing;
- cache boundaries and invalidation behaviour if Stage 7 persistent caching landed;
- the remaining compatibility role, if any, of `p_conditioning_evidence` and compatibility-blend metadata.

Related codebase docs that mention CF, cohort maturity, runner entry points, span/carrier composition, or field authority must be checked for stale claims. At minimum, review `STATS_SUBSYSTEMS.md`, `BE_RUNNER_CLUSTER.md`, and `COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` and update them only where the completed implementation changed the durable architecture. If user-facing behaviour or terminology changed, update the appropriate `graph-editor/public/docs/` page as well.

Stop condition: a reviewer can start from `docs/current/codebase/FORECAST_STACK_DATA_FLOW.md` or its replacement and follow the current CF path without consulting the 73-series implementation plans; stale codebase-doc claims about trajectory-owned evidence admission, empirical Tier 2 carrier ownership, terminal-edge multi-hop semantics, or `p_conditioning_evidence` as an ownership surface have been removed or explicitly marked historical.

## Closure Criteria

73h Issue 2 can be called closed only when:

- CF resolves conditioned transition primitives from admitted `window(...)` evidence;
- `window()`, `subject_span`, and `carrier_to_x` all consume those primitive posteriors;
- residual, complement, or unparameterised edges are either explicit deterministic graph semantics or unsupported/degraded with provenance;
- complex carrier and subject topologies covered by doc 29b continue to compose through the shared DAG machinery after primitives become conditioned;
- subset/effective-evidence policy is applied once at primitive posterior construction;
- empirical carrier Tier 2 is no longer the live conditioning mechanism;
- projection reads composed runtime objects without choosing semantics;
- diagnostics trace outputs back to primitive evidence and composition provenance;
- scoped and representative whole-graph primitive enumeration have acceptable runtime or a documented flag-gated rollout limit;
- the codebase documentation pass records the completed CF architecture in `docs/current/codebase/` and removes stale claims from related maintained docs.

## Review Checklist

Reviewers should reject an implementation if:

- it adds a carrier-specific evidence family;
- it conditions `carrier_to_x` directly from whole-carrier rows;
- it leaves `window()` conditioning on a separate path from primitive posterior construction;
- it leaves `compute_forecast_trajectory` as the owner of window evidence admission after primitive construction exists;
- it changes window numerical behaviour without a named semantic reason and test update;
- it treats multi-hop window parity with a known-bad terminal-edge path as the target semantics;
- it cuts over window or carrier consumers without shadow comparison and rollback;
- it lets consumers bypass the request-scoped primitive registry and re-resolve primitives independently;
- it leaves `subject_span` conditioning as a trajectory-local special case;
- it lets multi-hop subject spans collapse to terminal-edge primitives;
- it derives residual/complement probabilities inside CF composition;
- it moves `1 - p` or proportional sibling rebalancing from UpdateManager writeback into CF primitive composition;
- it infers residual sibling closure from adjacency alone;
- it treats supported split/join/leakage topology as unsupported merely because the topology is not linear;
- it uses a prepared span primitive across the `X` boundary instead of keeping carrier and subject closures separate;
- it mixes slice, context, regime, or as-at metadata inside one composed carrier or subject plan;
- it independently regenerates primitive draws for different composed consumers under the same scope;
- it invents timing for an unsupported residual/complement edge silently;
- it conditions timing, completeness, `mu`, `sigma`, or onset for a structurally non-latency primitive instead of keeping timing as identity;
- it collapses effective-evidence selection and compatibility blending into one unnamed policy;
- it applies subset or doc-52 double-count logic in carrier, subject, window, or projection consumers instead of primitive construction;
- it hides the difference between raw `E` and effective `e`;
- it uses empirical Tier 2 as the live carrier-conditioning path;
- it caches composed carriers without a primitive invalidation story;
- it lets projection choose evidence roles or recompute primitive posteriors;
- it changes displayed rates from `Y / X` to `Y / A`.

## Implementation progress

<!-- managed by /implement-carefully — edit checkboxes manually only when the skill is not running -->

- [x] Stage 0a — Code Inventory and Precondition Check — completed 1-May-26
- [x] Stage 0b — Forensic Localisation and Test Triage — completed 1-May-26
- [x] Stage 0c — Contracts, Tolerances, and Read Coordination — completed 1-May-26
- [x] Stage 1 — Primitive Posterior Contract — completed 1-May-26
- [x] Stage 2 — Primitive Evidence Resolution — completed 1-May-26
- [x] Stage 3 — Subset and Primitive Conditioning Policy — completed 1-May-26
- [x] Stage 4 — Unsupported Residual and Unparameterised Edge Guard — completed 1-May-26
- [x] Stage 5a — Single-Hop Window and Subject Cutover (Parity Oracle) — completed 1-May-26
- [x] Stage 5b — Multi-Hop Subject Span Composition — completed 1-May-26
- [x] Stage 5c — Multi-Hop Window Readout — completed 1-May-26
- [x] Stage 6 — Carrier Consumer — completed 1-May-26
- [x] Stage 7 — Primitive and Composition Caching — completed 1-May-26
- [x] Stage 8 — Cross-Surface Projection and Provenance — completed 1-May-26
- [ ] Stage 9 — Acceptance Tests
- [x] Stage 10 — Codebase Documentation Pass — completed 2-May-26 (executed before Stage 9 per user direction; captures Stages 1-8 reality before Stage 9 drift)
