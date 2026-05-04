# Snapshot fetch envelope: structural fix for cohort/window parity

**Status**: Design proposal for peer review
**Date**: 4-May-26
**Author**: Engineering, mid-conversation under auto mode
**Originating defect**: `test_cli_projection_parity_uses_last_row_saturation_not_arbitrary_tau_curve_point` —
the param-pack and cohort-maturity readouts of `p.latency.completeness` for the
same active-carrier cohort query disagree by ~0.0021, well above the
documented 1e-4 cross-surface noise floor.

This note proposes the correct structural fix for the snapshot-fetch
machinery, derived from
[`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)
and in particular its Appendix A pin (4-May-26) on the eight named
primitive forms and the per-primitive local-clock semantics of window
mode.

The author acknowledges that an earlier draft of this analysis treated
multi-hop window subjects as if they propagated clocks through subject
edges and required forward fetch extension on non-first subject edges.
That treatment is incompatible with the appendix's pin and is corrected
here. The corrected analysis is also simpler.

## 1. The defect, in one paragraph

For the query `synth-lat4-c-d.cohort(synth-lat4-b, 29-Jan-26:29-Apr-26)`
the param-pack and cohort-maturity public surfaces of
`p.latency.completeness` for the c→d edge disagree by ~0.0021. Both
public surfaces are produced from the same engine entry point
(`compute_cohort_maturity_rows_v3`), but the two callers
(`handle_conditioned_forecast` for param-pack; `_handle_cohort_maturity_v3`
for the chart) invoke that entry point with non-equivalent argument sets.
The load-bearing asymmetry is `target_subject_metadata`: only the chart
caller passes it, and only when it is passed does a second snapshot DB
fetch fire from inside `build_resolved_cf_runtime` (the 73n
"evidence-clock alignment" widening). The chart therefore conditions on
strictly more rows than the param-pack readout, and the public scalars
diverge.

## 2. Why the obvious fix is not the right fix

The smallest possible patch is to thread `target_subject_metadata`
through the param-pack call site. That closes the visible gap. It is
also wrong as a permanent design, for three independent reasons.

First, it cements two snapshot-DB round trips per active-carrier cohort
request when one would suffice. The original fetch (in
`forecast_preparation.prepare_forecast_subject_entry`) is bounded by the
public DSL anchor window. The widening fetch (inside
`build_resolved_cf_runtime`) is bounded by the request's prefix-arrival
envelope. The arrival envelope is fully determined by the request's
resolved primitive latencies — i.e., by model vars and graph topology.
Nothing forces the original fetch to use the narrower public bound; it
does so only because the layer that knows the principled bound sits
below the layer that issues the fetch.

Second, the second-fetch site lives below a deliberate typed-merge
layering boundary. `EvidenceCandidate.identity` is summability identity
(role, subject_from, subject_to, anchor, slice_family, context_key,
regime_key, population_identity). It does not carry retrieval keys
(`param_id`, `core_hash`, `equivalent_hashes`, `slice_keys`). The
runtime builder cannot reconstruct retrieval identity from the typed
candidates it receives; the second fetch therefore has to be told the
identity by an out-of-band parameter (`target_subject_metadata`). That
parameter punctures a layer that should not be punctured. Threading it
through more call sites makes the puncture more entrenched, not less.

Third, the carrier-side counterpart of this widening is
`_fetch_upstream_observations` in `api_handlers.py`. That site uses a
heuristic backward extension (`lookback_days = max(axis_tau_max * 2,
60)`) to capture older A-cohorts as donors for upstream-edge maturity
inference. The heuristic is generous on most fixtures and tighter or
wider than the principled bound on others. The principled bound is the
same arrival-map mechanism used on the subject side, evaluated on the
carrier sub-tree. Leaving it heuristic perpetuates a second-class
treatment of the carrier path.

The structural fix described below addresses all three concerns at the
same architectural level.

## 3. What the semantic note says, in operational terms

[`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)
defines one semantic contract that any forecast implementation must
preserve. Several points from the body and from Appendix A are
load-bearing for the fetch design.

**Mode truth**. In window mode the selected population is rooted at X,
so denominator mass is present at X at age zero. In cohort mode the
selected population is rooted at A, so denominator mass at X may still
be maturing through an upstream carrier A→X.

**Primitive bindings (Appendix A)**. Two bindings exist. The window
binding has α equal to β (the primitive's source) — identity arrival
map at β with no propagation. Each primitive is conditioned on its
own un-shifted source-day evidence; cohorts mix by design. The cohort
binding has α possibly different from β — weights at β are propagated
from α through the relevant sub-tree (carrier rooted at A, subject
rooted at X). Cohort identity is preserved end-to-end.

**Same edge under different bindings is a different primitive**. A
single edge bound under window mode and the same edge bound under
cohort mode are distinct objects and must not share cache entries,
evidence, or fits.

**Window vs cohort is per-primitive, not per-request**. The body's
phrase that "`window()` collapses the carrier to identity" should be
read as "the carrier sub-tree is empty in window mode", not as "the
subject sub-tree gets X-rooted propagation in window mode". Appendix A
pins this explicitly: a multi-hop window subject is a chain of
independently-conditioned local-clock primitives composed into a span
after conditioning, never bound on a single propagated arrival map.

**Donor cohorts are a carrier-side concept**. The body's Pop C term —
future arrivals to X after the frontier — is empty in window mode by
definition (later arrivals to X belong to later windows). The
backward extension presently performed at the carrier fetch site is
the operational realisation of this: older A-cohorts whose
observations land within the public retrieval window inform
upstream-edge maturity for cohorts inside the window. There is no
analogous Pop C in window mode and there is therefore no analogous
backward extension on subject-side fetches in window mode.

These four points together determine, per parameterised edge in the
request, what range of `anchor_day` rows the snapshot DB must return.
The design proposed below is a direct consequence of them.

## 4. Per-edge envelope rule

For every parameterised edge U→V in the request topology there is a
binding determined by the request and the edge's role:

- a window-bound subject primitive (window mode);
- a cohort-bound subject primitive at X (cohort mode, A possibly equal
  to X);
- a cohort-bound carrier primitive at A (cohort mode, A not equal to X).

The fetch envelope for that edge is determined by its binding.

**Window-bound subject primitive**. The fetch envelope is the public
window — `anchor_from` and `anchor_to` bound every window-mode fetch,
tout court. Identity arrival map at U over the public window means the
set of `anchor_day` values any local-clock primitive can need is exactly
the public window. No forward extension. No backward extension. No
per-node cumulative latency calculation.

This applies to every parameterised subject edge in window mode —
single-hop, multi-hop, first edge, last edge, intermediate edge, all
identical. Each primitive sees its own local-clock evidence; subject-
path latency does not reshape the envelope of any individual
primitive's fetch. This is the appendix pin's operational consequence
for fetch, and it is the simplest possible rule for window mode.

This is not an over-fetch. A non-first edge's local-clock binding
admits every U-cohort with anchor_day in the public window,
regardless of which X-cohort it descended from. Window-binding mixes
cohorts by design (Appendix A). The rows in `[anchor_from,
anchor_from + min_upstream_lag]` on a non-first edge are U-cohorts
whose X-progenitors entered X before the public window; window-mode
binding correctly admits them. There is no "tighter alternative"
that the binding layer would prefer. A forward-shifted lower bound
on non-first edges would be cohort-mode thinking applied where
cohort identity is not being tracked.

**Cohort-bound subject primitive at X**. The arrival map is rooted at
X with identity weights over the public window, propagated forward
through the subject sub-tree to U. The set of `anchor_day` values U can
need is the support of `arrival_weight[U]`, which extends past the
public anchor_to by the cumulative subject-path latency tail upstream
of U. The fetch envelope's anchor_from equals the public anchor_from
(propagation is monotone forward; X's own clock starts at the public
anchor_from). Its anchor_to equals the maximum day in
`arrival_weight[U].keys()`.

For a single-hop subject in cohort mode, U equals X and the support is
the public window with zero forward extension. For a multi-hop subject
in cohort mode, non-first subject edges acquire forward extension by
the upstream subject-path tail.

**Cohort-bound carrier primitive at A**. The arrival map is rooted at A
with root-day weights propagated forward through the carrier sub-tree
to U. Two extensions apply.

Forward: `arrival_weight[U]` extends past anchor_to by the cumulative
carrier-path tail upstream of U. The fetch envelope's anchor_to
follows.

Backward: older A-cohorts (anchor_day before the public anchor_from)
produce upstream-edge observations whose retrieval dates fall inside
the public window. Per `doc 29d §donor-fetch`, these donor cohorts
inform upstream-edge maturity. The backward extension is naturally
expressed by extending the A-rooted arrival map's root-day weights
backward by the carrier-path tail; per-node propagation then carries
the extended root weights to each carrier source node.

Per-edge envelope: `[min(arrival_weight[U].keys()),
max(arrival_weight[U].keys())]`. No calendar-direction-specific code.
Both directions fall out of the same arrival map.

## 5. Where the envelope is computed and where the fetch happens

The envelope must be computed before the fetch. Today the subject-side
arrival map is built inside `build_resolved_cf_runtime`; the carrier-side
heuristic is computed inside `_fetch_upstream_observations`. Both sit
below the layer that issues the original fetch.

The structural fix lifts envelope construction to the handler /
preparation layer, where the request is fully known (graph, anchor
window, anchor node, mode, source preference, as-at). At the same
layer, binding descriptors (§6) are constructed for every
parameterised edge in the request topology. Construction reuses pure
helpers that already exist:

- `resolve_model_params` to obtain each primitive's lognormal latency
  under the active source preference;
- `build_prefix_arrival_map` to construct the arrival map per binding
  (cohort mode only — window-binding descriptors carry identity root
  weights and need no propagation);
- `derive_retrieval_superset` to collapse the arrival map to a
  calendar envelope per source node.

Cohort mode produces two arrival maps and a list of binding descriptors
referencing them: subject edges with `α = X`, carrier edges with `α = A`
plus backward-extended root weights for donors. Window mode produces
one binding descriptor per parameterised subject edge with identity
root weights over the public window — no shared map needed; envelope
derivation reduces to "the public window" for every descriptor.

With binding descriptors in hand for every parameterised edge,
**one** per-edge fetch contract serves the entire request:
descriptor in, typed evidence candidates out. Subject vs carrier
distinction does not appear in the contract or in any of its callers'
control flow. Today's two fetch sites — `prepare_forecast_subject_entry`
and `_fetch_upstream_observations` — collapse into thin adapters
over this single per-edge contract, where "adapter" means
"resolve the request-level subject/carrier topology to a list of
binding descriptors and dispatch each to the shared per-edge fetch".
They do not retain independent fetch logic, independent envelope
derivation, independent retrieval-identity construction, or
independent post-fetch processing. The duplicated v2-style upstream
fetch in `api_handlers.py` is removed; `_fetch_upstream_observations`
itself becomes a thin adapter, not a parallel pipeline.

The widening block inside `build_resolved_cf_runtime` is removed in
full, along with its `target_subject_metadata` parameter and the
corresponding plumbing in `compute_cohort_maturity_rows_v3` and the
chart caller. The runtime builder no longer issues a fetch, no longer
holds retrieval identity, and no longer constructs arrival maps. The
arrival maps it consumes are passed in from the handler layer through
the existing `prebuilt_subject_arrival_map` and
`prebuilt_carrier_arrival_map` parameters of
`compute_resolved_runtime_readout`. The runtime is a thin readout over
prepared inputs, not a layer that punctures the merge boundary.

## 6. Branching shape (under 73g "one general forecast machinery path")

73g forbids parallel machinery for window and cohort and permits only
natural degeneration of the same objects. The structural fix must
respect that constraint. Under it, the only legitimate branching point
in the entire pipeline is the construction of the per-primitive
**binding descriptor** for each parameterised edge in the request
topology.

A binding descriptor is the small object that names, for one
parameterised edge, the inputs Appendix A enumerates: the binding type
(window or cohort), the clock anchor `α`, the source node `β`, the
target node `γ`, the role (subject vs carrier), and the root-day
weights of the primitive's local arrival map. Window mode produces a
window-binding descriptor for each subject edge, with `α = β` and
identity root weights over the public window. Cohort mode produces
cohort-binding descriptors: subject edges with `α = X` and X-rooted
root weights; carrier edges with `α = A` and A-rooted root weights
extended backward by the carrier-path tail for donor cohorts. The
A-equals-X cohort identity case yields an empty carrier-edge list,
not a separate code branch. Single-hop vs multi-hop is solely a
difference in the number of subject edges processed.

After binding-descriptor construction, **one** of each follows for
the entire request:

- one envelope planner, taking a binding descriptor and producing
  `[anchor_from, anchor_to]` for that edge's fetch — `[anchor_from,
  anchor_to]` for window-binding, `[min, max]` of
  `arrival_weight[β]` for cohort-binding;
- one retrieval-identity builder, taking the edge plus its binding
  descriptor and producing `(param_id, core_hash, slice_keys,
  equivalent_hashes)` from the FE-planned regime entries;
- one candidate-fetch path per edge, taking the envelope and the
  retrieval identity and returning typed `EvidenceCandidate` rows
  through the existing merge layer (with `as_at` preserved as a
  retrieval-time admissibility gate per §11);
- one runtime object (`ResolvedCFRuntime`) consuming the full set of
  per-primitive bound evidence uniformly;
- one projection path producing the public scalars and chart rows.

There is no subject-fetch helper distinct in shape from a
carrier-fetch helper. There is no "subject side / carrier side" fork
in the envelope planner, the retrieval-identity builder, the candidate
path, the runtime, or the projection. The role is metadata on the
binding descriptor, not a control-flow split.

This is the strict form of "natural degeneration": every degeneracy
the design needs to handle (window vs cohort; single-hop vs multi-hop;
A-equals-X vs A-not-equal-X; first edge vs intermediate edge) emerges
from the binding descriptor, never from a parallel implementation
path.

## 7. What the binding contract demands of the binding layer

The structural fix concerns fetch only. The merge layer
(`merge_evidence_candidates`), per-primitive binding
(`compute_resolved_runtime_readout`), and arrival-weight re-weighting
remain unchanged. Per-primitive binding continues to admit each fetched
row only on the local clock of the primitive it is bound to and reject
off-clock rows. The fetch envelope is, by construction, the union of every
primitive's local clock; rows pulled by the envelope but irrelevant to a
particular primitive are filtered at binding with no contamination of
either weights or conditioning.

This is the layering contract that today's punctured design violates
and the structural fix restores: the fetch supplies a sufficient
superset, the binding layer slices it per primitive, and the conditioning
layer reads what it needs. No layer punctures any other.

## 8. Reconciling current code with Appendix A

Today's `build_resolved_cf_runtime` builds a subject_arrival_map rooted at
X with propagation through the subject sub-tree, regardless of mode. In
window mode the appendix says this map should not exist as a single
propagated object: window-mode subject primitives are local-clock at
their own source nodes. The discrepancy is not load-bearing for the
fetch envelope today, because window mode has no carrier and the
existing widening only fires when `envelope_to > anchor_to_date` —
which never happens for a single-edge identity-rooted subject. But it
is load-bearing for the principled implementation, because the fetch
envelope rule derived from the appendix is "public window for every
window-mode subject primitive, period", not "X-rooted propagation that
happens to be trivial in the single-hop case".

The structural fix should align with the appendix. Concretely, in
window mode the handler should construct one identity arrival map per
parameterised subject edge (or, equivalently, observe that the envelope
is the public window for each and skip the arrival-map machinery
entirely). It should not build a single X-rooted propagated map and
expect the per-primitive binding layer to filter the consequences.

A separate question, beyond the scope of this fix, is whether the
existing X-rooted subject_arrival_map in cohort_forecast_v3.py is itself
in tension with the appendix for cohort-mode subjects too. The body of
the semantic note says the subject sub-tree is rooted at X in cohort
mode and the cohort binding propagates weights at β from α. The
appendix's pin is specifically about window mode. The cohort-mode
subject map appears compatible with both. The author recommends a
peer-review check on this point — the relationship between
"subject sub-tree rooted at X under cohort binding" and the cohort
binding's α-propagation rule should be confirmed against the
implementation rather than assumed.

## 9. Numerical claims

For the failing test, the structural fix produces a single subject-side
fetch with an envelope determined by the cohort-bound subject map rooted
at X = c. For a single-hop subject c→d the X-rooted map is identity at
c; the envelope is the public window. The carrier-side fetch (b→c)
is bounded by the cohort-bound carrier map rooted at A = b with backward
extension by the carrier-path tail (here, the b→c edge's t95+onset). The
chart caller and the param-pack caller, having no remaining asymmetry in
fetch arguments, see identical evidence and produce identical
completeness scalars to within the documented 1e-4 floor.

For active-cohort multi-hop subject queries (not covered by the failing
test but covered by the structural fix), the subject-side fetch on the
non-first subject edge gains forward extension by the upstream subject-
path tail, bringing in rows that today's widening also captures (when
target_subject_metadata is passed) but at the principled bound rather
than the widening's whole-arrival-map extent. For active-cohort single-
hop subject queries, the subject envelope is the public window with no
extension; today's widening produces the same effective bound modulo the
inclusion of d-node weights in `derive_retrieval_superset`'s envelope
calculation, an inclusion the helper's docstring flags as outside its
contract (only primitive source nodes should be passed). The structural
fix removes this incidental over-fetching.

For the carrier side, the principled backward bound is `max(t95+onset)`
over the carrier path's resolved primitives. Today's heuristic
(`max(axis_tau_max * 2, 60)`) is generous on typical fixtures and within
a small constant of the principled bound on others. The change in
fetched rows is small in expectation; correctness is strictly improved.

## 10. Implementation outline (prose only, per project standards)

The structural fix introduces three small abstractions at the
preparation layer and consolidates two existing fetch helpers as thin
adapters over the third. After consolidation, the request travels
through one shared pipeline regardless of mode or role.

The first abstraction is the **request binding plan**: a pure helper
that accepts the full request shape (graph, query_from_node,
query_to_node, anchor_node_id, anchor_from, anchor_to, is_window,
source preference, as-at) and returns a list of binding descriptors —
one per parameterised edge in the request topology. In window mode the
list is the parameterised subject edges, each carrying a window-binding
descriptor with identity root weights over the public window. In cohort
mode the list is the union of carrier edges (cohort-binding at A with
backward-extended root weights) and subject edges (cohort-binding at X
with public-window root weights), with the carrier list empty when
A equals X. The same helper builds the two arrival maps once for cohort
mode and references them from each cohort-binding descriptor.

The second abstraction is the **envelope planner**: a pure helper that
accepts a binding descriptor and returns `[anchor_from, anchor_to]` for
that edge's fetch. Window-binding returns the public window. Cohort-
binding returns the `[min, max]` over `arrival_weight[β].keys()` from
the descriptor's referenced arrival map. The planner has no knowledge
of subject vs carrier role and no `is_window` branch internal to it.
Its dispatch is on the binding type carried by the descriptor.

The third abstraction is the **per-edge fetch contract**: a single
function that accepts a binding descriptor and the request's `as_at`,
calls the envelope planner, builds the retrieval identity from the
descriptor's edge plus the FE-planned regime entries, calls
`query_snapshots_for_sweep` once with the envelope and `as_at`, runs
the typed-merge layer, and returns the bound `EvidenceCandidate` rows
for that edge. This is the only function in the entire structural fix
that issues a snapshot DB call. It serves every parameterised edge in
the request.

The handler computes the request binding plan once and dispatches each
binding descriptor through the per-edge fetch contract. Today's
`prepare_forecast_subject_entry` becomes a thin adapter that resolves
its `subj` argument to a binding descriptor and calls the contract.
Today's `_fetch_upstream_observations` becomes a thin adapter that
resolves its `(graph, anchor_node, query_from_node)` arguments to a
list of carrier-edge binding descriptors and dispatches each through
the contract. Neither adapter contains envelope derivation, retrieval-
identity construction, post-fetch row processing, or any logic that
would distinguish subject from carrier — those concerns all live in
the shared contract.

The duplicated v2-style upstream fetch block in `api_handlers.py` is
deleted. The widening block in `build_resolved_cf_runtime`, the
`target_subject_metadata` parameter, and the corresponding plumbing in
`compute_cohort_maturity_rows_v3` and the chart caller are deleted.
The runtime builder receives the pre-built arrival maps and runs the
readout against them.

The merge, binding, weighting, and conditioning paths are unchanged.

## 11. Risks, edge cases, and review questions

The author flags the following for peer review.

**Source preference consistency**. The envelope must be computed under
the same `graph_preference` that the runtime resolves primitives with.
Today's chart caller passes `graph_preference` into
`prepare_forecast_runtime_inputs`; today's param-pack caller does not
explicitly thread it but receives the graph-level default through
`resolve_model_params`. The fix must ensure both sites agree on the
preference used at the envelope step.

**Source preference may shift the envelope**. Different sources
(`analytic`, `bayesian`, `manual`) carry different lognormal
parameters. The envelope under preference X is therefore not identical
to the envelope under preference Y. The fix should compute the envelope
under the preference that will actually be used at conditioning, so the
fetch superset and the binding clocks agree.

**Path-level latency vs edge-level**. The carrier-path tail used for
backward donor extension can be derived from edge-level latencies
convolved across the carrier path or from a path-level lognormal
fitted at scope='path' if available. The two are not numerically
identical. The author proposes using the larger of the two so the
envelope errs wide. Reviewers should consider whether this matches
existing donor-fetch policy.

**Degraded primitive entries**. `derive_retrieval_superset` already
excludes degraded entries from envelope construction. Reviewers should
consider whether a degraded entry should also exclude that primitive's
edge from the per-edge fetch loop, or whether the fetch should still
issue with a fallback bound.

**A-equals-X cohort identity case**. The body of the semantic note
notes that this case has no carrier solve beyond X. Under the structural
fix it is still a cohort-binding request, so the carrier sub-tree is
empty and only the subject map exists. The handler must detect and not
build a phantom carrier map. This should fall out naturally if the
carrier sub-tree is constructed only when `anchor_node_id != query_from
_node`, but reviewers should confirm.

**Cache eviction**. Wider envelopes change snapshot-cache keys.
First-run misses on existing warm caches are expected and acceptable.
There is no correctness risk; cache eviction is natural.

**Tests that exercise the deleted widening block**. Unit tests against
`target_subject_metadata`, the widening's `widened_rows` path, or the
heuristic `lookback_days` constant must be retargeted at the new helpers
or at the new fetch-envelope plumbing. The same arithmetic is exercised;
the call site moves.

**Compatibility with the appendix's pin on window-mode local-clock
binding**. As noted in §8, today's `build_resolved_cf_runtime` builds an
X-rooted subject map even in window mode. The structural fix should
either (a) bypass that map in window mode and pass per-primitive
identity descriptors, or (b) keep building the (trivially-degenerate)
map and accept the appendix-pin gap as a separate cleanup. The author
recommends (a); reviewers may have a position.

**Handling of `axis_tau_max` plumbing**. Today
`_fetch_upstream_observations` uses `axis_tau_max` only for the
heuristic. Once the heuristic is gone, `axis_tau_max` no longer needs
to be threaded into that function. Reviewers should confirm no other
consumer of that argument exists.

**Interaction with `asat()`**. `asat()` is an admissibility / metadata
gate on `retrieved_at`, not an anchor-day truncation rule. Per
[`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`](codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md)
and the existing primitive-evidence tests, rows are admitted by
`retrieved_at <= as_at` regardless of the row's shifted primitive-local
anchor day. The envelope rule above operates on `anchor_day` — it is a
property of the request's primitive arrival map and of donor-fetch
contract, neither of which has anything to do with retrieval time.

The fix therefore must NOT cap the envelope's `anchor_to` (or
`anchor_from`) by `as_at`. The local-clock envelope is computed in
full from primitive latencies and arrival-map propagation. `as_at`
is then preserved through snapshot retrieval and into the
merge/admission layer, where it gates rows by `retrieved_at`. The
existing `query_snapshots_for_sweep(... as_at=...)` plumbing is the
right channel for that; the structural fix preserves it untouched.

A previous version of this design proposed capping the envelope's
`date_to` at `as_at`. That proposal conflated cohort identity
(`anchor_day`, an arrival-map property) with retrieval admissibility
(`retrieved_at`, a snapshot-row property). The two are independent.
Under the correct design: pull the full primitive-local envelope on
`anchor_day`; reject by `retrieved_at <= as_at` at admission. An
`as_at` clip on the local-clock envelope is only correct if a
lower-level snapshot API explicitly defines `as_at` as a
retrieval-time materialisation rule for that envelope axis — it does
not.

## 12. What the structural fix does not change

- The merge-layer typed boundary (`EvidenceCandidate.identity` carries
  summability identity, not retrieval identity). The fix strengthens
  rather than weakens this boundary by removing the puncture.
- The per-primitive binding layer's filtering rules. Off-clock rows are
  still rejected with `off_clock_rejection_count` recorded in
  diagnostics.
- The arrival-weight re-weighting that produces
  `WeightedEvidenceRow.n_weighted` / `k_weighted`.
- The Pop C / Pop D split in factorised numerator representation.
- The admission-policy gates around gross-fitted whole-query numerators.
- The eight named primitive forms in Appendix A.
- The two snapshot-cache levels (per-query and per-primitive).

## 13. Acknowledgement of an earlier confused framing

An earlier draft of this analysis (held only in conversation) treated
multi-hop window subjects as if they propagated clocks through subject
edges and required forward fetch extension on non-first subject edges.
That treatment is incompatible with Appendix A and is wrong. The author
recanted it on prompting and rewrote the analysis from the appendix's
pin. This document represents the corrected design.

The earlier confused framing produced no code change. It is recorded
here only so that reviewers can recognise the shape of the mistake if it
recurs in another design or in a revision of this document. The shape
of the mistake was treating "window mode" as "cohort mode with carrier
collapsed to identity" rather than as "per-primitive local-clock
binding". The two are observationally similar in single-hop and
diverge in multi-hop. Appendix A is unambiguous.

## 14. Summary

One handler-layer request binding plan, producing one binding
descriptor per parameterised edge — the only legitimate degeneracy
point in the pipeline (window-binding for window mode, cohort-binding
at X for cohort subjects, cohort-binding at A for cohort carriers). One
envelope planner consuming descriptors. One retrieval-identity
builder. One per-edge fetch contract — the sole DB call site for the
request. One runtime object. One projection path. Existing
`prepare_forecast_subject_entry` and `_fetch_upstream_observations`
collapse to thin adapters over the per-edge fetch contract; neither
retains independent fetch logic. No second fetch. No heuristic
constants. No `target_subject_metadata`. No layer punctures. Failing
test passes by construction; carrier-side accuracy improves under a
principled bound; multi-hop window correctness aligns with the
Appendix A pin; pipeline shape complies with 73g's "one general
forecast machinery path".
