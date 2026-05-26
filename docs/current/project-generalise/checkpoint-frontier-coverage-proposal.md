# Checkpoint-Frontier Coverage Proposal

**Status**: Stage 3 blocker — must resolve before cutover work continues  
**Date**: 17-May-26  
**Scope**: selected-cohort coverage, support, exposure, and admissibility in the Phase 6 spine reducer

## Proposal

Replace the Phase 6 exact-cell row-presence mask with **checkpoint-frontier coverage**.

The new coverage contract is:

- snapshot rows are cumulative checkpoints, not event-time observations;
- coverage is tested at the current chart row boundary for each primitive source day;
- coverage is then propagated through the existing latency-map / DAG DP machinery as model-weighted support;
- strict empirical values may carry forward latest-at-or-before cumulative observations, but carry-forward does not imply coverage;
- chart opacity and future-frontier striation consume two separate readouts derived from the same support substrate.

If adopted, this proposal supersedes the current Phase 6 §4.8 / §5.6 coverage and admissibility wording in `phase-6-evidence-operator-contract.md` before Stage 3 cutover.

This is a prerequisite, not optional cleanup. Post-cutover tests are failing because the current exact-τ mask logic is semantically unworkable for cumulative snapshots, especially across non-latent carriers and retrieval gaps. Stage 3 must not proceed until the coverage/admissibility contract is replaced and the failing tests are re-targeted to the replacement contract.

## Problem

Snapshot rows are keyed by an observed source day and a retrieval timestamp. For a row with source day `u` and retrieval age `r`, the row means:

The cumulative state of edge `U -> V` for source day `u` is known by age `r`.

It does not mean:

The conversion occurred at delay `r`.

The current support/exposure path uses a row-presence mask indexed by retrieval age and multiplies it against a model timing kernel indexed by transition delay. Those are different axes. The failure is clearest for structurally non-latent edges:

- the transition-delay kernel is a spike at delay zero;
- production snapshots first appear the morning after the source-day events, so row presence starts at retrieval age one;
- multiplying a delay-zero kernel by an age-one row mask yields zero support and zero exposure everywhere.

This collapses admissibility for active selected cohorts even though the rows exist and the model value stream remains correct.

The broader issue is not limited to non-latent edges. For snapshots at ages one, five, and ten, a conversion count increase at age five means the additional conversions occurred sometime in the interval from after age one through age five. It is not valid to place the increment at exact age five for coverage purposes.

## Design Requirements

Any replacement must satisfy five requirements.

First, it must preserve the latency-map / arrival-map structure. Coverage is not a direct lookup of rows by anchor date. In active cohort mode, anchor mass is propagated to downstream edge source days through carrier timing. Coverage must be evaluated after that source-day weighting.

Second, it must treat snapshots as cumulative checkpoints at their own row boundary. A checkpoint at age ten must not be used to claim coverage for output rows at ages two through nine. Future snapshots cannot contribute to earlier chart ages, and an end-of-gap checkpoint does not retroactively cover the missing rows inside the gap.

Third, it must push through arbitrary DAG topology using the existing composition machinery. The fix must not introduce a bespoke selected-cohort graph engine or reintroduce mode branches for window, identity cohort, active cohort, single-hop, or multi-hop.

Fourth, it must distinguish strict evidence from coverage. Strict evidence comes from empirical cumulative observations. Coverage asks what fraction of the modelled cumulative wavefront is constrained by the available checkpoints. These are related but not the same object.

Fifth, it must preserve observed-zero versus absent. A real checkpoint saying zero conversions by age `r` is coverage, not absence. It should admit a numeric zero where appropriate; it should not collapse to `None`.

## Proposed Algebra

For each concrete edge `e: U -> V`, source day `u`, and retrieval age `h`, define an observation checkpoint indicator `O_e(u, h)`.

`O_e(u, h)` is one iff a snapshot row exists for edge `e`, source day `u`, and retrieval age `h`. That row observes the cumulative edge state by age `h`. It does not place conversions at delay `h`.

Let the model edge kernel be the usual probability-weighted daily timing kernel for the edge. Conceptually, `K_e(d)` is the model mass that transitions from `U` to `V` at delay `d` after reaching `U`.

For a selected anchor day `C`, chart output age `τ`, and model mass that reaches edge source `U` on source day `u`, define the edge-local row age `h = (C + τ) - u`. On the anchor-relative grid, if source day `u` is represented by offset `s`, this is `h = τ - s`.

For that fixed output row `τ`, the support propagation for source day `u` uses the same model kernel as the value stream, multiplied by `O_e(u, h)`. In words: all model mass from this source-day bucket that could arrive by the current row boundary is covered iff the cumulative checkpoint exists at that row boundary for this edge/source-day.

The support multiplier is therefore not "row exists at exact conversion delay" and not "some checkpoint exists before this row". It is "row exists for this edge/source-day at the local age of the current chart row".

Coverage at a node is cumulative support through that node divided by cumulative value through that node, read at the same output age `τ`.

The key change is that support is not a fixed per-edge mask. It is an **output-row-conditioned checkpoint test**: the same edge and same source day can be covered for output age one, uncovered for output ages two through five because those retrievals are missing, and covered again at output age six if a checkpoint exists there.

## Graph Propagation

The propagation uses the same DAG DP idea as the existing spine.

At the selected root, value and support both start with the selected cohort mass. For each edge, value mass is propagated with the full model kernel. Support mass is propagated with the same kernel, but a source-day bucket contributes support only when the checkpoint indicator for that edge/source-day/local row age is one.

For serial paths, support at the terminal means that every edge traversed by the modelled path has a cumulative checkpoint at the row boundary relevant to that edge's source day.

For branching and joins, support is additive by path in the same way model value is additive by path. A path whose branch checkpoints are present contributes support through that route. A route whose required checkpoint is absent at the current row boundary contributes no support for that row. Joins sum the supported mass arriving from each route.

For active cohort mode, carrier coverage at `X` is read from the carrier-side propagation. Subject coverage at the terminal is read after the carrier-produced source-day mass has been handed to the subject span. The carrier-to-subject handoff remains the same conceptual object as today: the proposed change is only that support tests checkpoint existence at each edge's source-day row boundary.

For window and `cohort(A = X)`, the carrier is the zero-edge identity. The same propagation degenerates naturally: the source day at `X` is the selected cohort day, and checkpoint existence is read directly from the X-rooted subject primitive checkpoints.

## Invariants

The proposal relies on the following invariants.

**Checkpoint, not event-time.** `O_e(u, h)` records that a cumulative snapshot exists at age `h`. It never asserts that any conversion occurred at age `h`.

**Row-boundary freshness.** Coverage for output age `τ` uses checkpoints at the row boundary for each edge/source-day. A later checkpoint does not cover earlier missing rows. A previous checkpoint may carry strict empirical values forward for display or diagnostics, but it does not contribute coverage after its row boundary.

**Latency-map weighting.** Coverage is binary only at the primitive cell `(edge, source day, local row age)`. Anchor-level and row-level coverage become fractional only after model mass has been distributed through arrival maps, branches, joins, and carrier/subject handoff.

**Shared value/support topology.** Value and support use the same topology, same source-day mapping, same carrier/subject decomposition, and same model kernels. They differ only by multiplication by the checkpoint indicator in the support stream.

**No mode branches.** Window, `cohort(A = X)`, active `cohort(A != X)`, single-hop, and multi-hop differ only by data: identity carrier versus active carrier, one-edge versus multi-edge subject spans, and the source-day distributions implied by the latency maps.

**Observed zero is covered.** If `O_e(u, h) = 1` and the row's cumulative observed conversion count is zero, the row is covered and the strict empirical value is numeric zero. It is not absent.

**Absent means no checkpoint.** If `O_e(u, h) = 0`, the row boundary is not covered for that edge/source-day, regardless of whether earlier or later checkpoints exist.

**Coverage is not a scalar frontier.** Observation support is a per-row, per-source-day checkpoint surface. It may be non-contiguous: checkpoints at ages one and six give coverage at one and six, with no coverage at ages two through five. Any downstream consumer that assumes "observed through τ = N" from a single max frontier is incompatible with this proposal unless that scalar is explicitly redefined as a display summary rather than a computational support predicate.

## Simple Cases

For a non-latent edge, all model timing mass is at delay zero. If the first next-morning snapshot row exists at age one, then at chart output age one the checkpoint indicator at the row boundary is one. That checkpoint observes cumulative state by age one, which includes delay-zero transitions. Support therefore equals value for that row boundary. The non-latent carrier collapse disappears without a special case.

For a missing retrieval block with checkpoints at ages one and six, coverage is present at output ages one and six and absent for ages two through five. The age-six checkpoint tells us the cumulative state by age six, but it does not reveal the cumulative state at ages two through five. The coverage signal therefore respects missing rows inside the block.

For a latent edge with daily checkpoints through age five and no checkpoint at age six, coverage can be high through age five and zero at age six, even though strict empirical values may still carry the latest cumulative count forward if the display chooses to show stale empirical value. Coverage and carry-forward value answer different questions.

For active cohort rows, coverage is fractional when anchor mass is spread across multiple downstream source days. If sixty percent of anchor mass reaches `U` on one source day whose local checkpoint exists, and forty percent reaches `U` on another source day whose local checkpoint is missing, the edge contributes approximately sixty percent support before downstream topology and path weighting are applied.

## Strict Evidence And Admissibility

Strict evidence should be derived from empirical cumulative observations, not from the conditioned model support stream.

The policy choice for this proposal is: **strict empirical values carry forward latest-at-or-before cumulative observations; coverage remains checkpoint-at-current-row-boundary**.

That means a missing current retrieval row does not force `evidence_x`, `evidence_y`, or `rate` to `None` if a previous cumulative checkpoint exists and the denominator is defined. The row may carry the stale strict cumulative value forward. The same row must expose `coverage = 0` for any role whose current row-boundary checkpoint is missing. Display can then fade or suppress the stale point by coverage without losing the latest observed cumulative value in diagnostics.

Admissibility for strict row fields is therefore a display/value admissibility, not a coverage admissibility:

- strict value admissibility: at least one cumulative empirical checkpoint exists at or before the output row under the selected evidence policy;
- coverage admissibility: the checkpoint exists at the current row boundary for the relevant edge/source-day after latency-map placement.

These two gates are deliberately different. Conflating them is the source of the ambiguity in the current contract.

A terminal observed zero remains admissible. It contributes numeric zero to the strict numerator where the denominator is defined. It should not become `None` merely because empirical value is zero.

This implies that the current Phase 6 §5.6 predicate, `exposure_y_A(τ) > 0`, should be replaced or redefined. If an exposure-like field remains, it should represent checkpoint-at-row-boundary support, not exact row-presence overlap with a transition-delay kernel.

## Adjusted Evidence

Adjusted evidence remains in the Stage 3 cutover and uses the existing accepted numerator policy with the new checkpoint-boundary denominator.

The adjusted numerator policy is:

- strict empirical values may carry forward latest-at-or-before cumulative observations;
- adjusted empirical numerators do **not** use that forward-filled strict cumulative;
- adjusted empirical numerators use only observed adjacent increments at actual checkpoint rows;
- checkpoint-boundary coverage is the IPW denominator.

When the current row boundary has no checkpoint, adjusted numerator contribution is zero and checkpoint-boundary coverage is zero. The row may still carry strict stale value from the latest cumulative checkpoint, but adjusted evidence does not infer an increment across the missing boundary.

The IPW claim is therefore scoped to observed checkpoint increments, not to point event times. Its missingness assumption is stated at checkpoint level:

- checkpoint availability must be independent of the underlying conversion outcome conditional on source day, edge, context, and retrieval policy;
- the model-conditional allocation of interval-censored mass to downstream source days must be accepted as part of the estimator;
- future checkpoints must never be used to adjust earlier output ages;
- latest-at-or-before value carry-forward, if retained, must not be treated as positive coverage for missing row boundaries.

This makes adjusted evidence a validation gate, not an open design issue: Stage 3 must prove the non-forward-filled adjusted numerator plus checkpoint-boundary IPW behaviour on missing-row and retrieval-gap fixtures.

## Implementation Plan

This proposal should reuse the existing DP machinery. It does not require a new graph reducer.

The implementation should introduce an observation-checkpoint surface per primitive: for each source day, the retrieval ages at which cumulative rows exist. From that surface, the runtime reads `O_e(u, h)` for the local row age under evaluation.

The existing value evaluation can remain one-pass because the value kernels do not depend on output age. The support / coverage evaluation needs the output age as an additional context because checkpoint existence is evaluated at the row boundary. The simplest correct implementation is to evaluate support for each output age using the existing DP with a support-kernel supplier that receives the edge, source day, source index, and output age.

Optimisation can come later. A batched implementation may precompute checkpoint lookups or reuse prefix products, but it must be observationally equivalent to the row-boundary definition. In particular, a checkpoint at age ten must not mark ages two through nine as covered.

The old exact row-presence mask may still be useful as a diagnostic: it can say which retrieval ages exist. It should not be used as an event-time support mask.

## Expected Code-Level Direction

The current source-day-aware mask plumbing in the conditioned operator is close to the right mechanical location but has the wrong semantic payload. Instead of storing a mask whose one-cells are multiplied against exact conversion-delay positions, the coverage path needs access to the per-source-day checkpoint indicator at the local row boundary.

The existing `evaluate_conditioned_span_from_seed` and masked DP helpers can be generalised so support/exposure evaluation receives an output-age context. That keeps topology, edge lookup, source-day mapping, carrier/subject handoff, and draw axes in one existing path.

The empirical operator should keep its cumulative-row role. It is the right source for strict evidence and observed-zero behaviour. It should not be asked to provide model coverage; coverage remains model-conditional because it measures what fraction of modelled mass lies through source-day buckets whose row-boundary checkpoints exist.

## Chart Contract

The existing chart consumes observation support in two ways:

1. **Per-point evidence opacity** — the evidence blobs fade according to per-row coverage.
2. **Future-frontier striation** — epoch B / C display communicates that the selected cohort set is ageing beyond the observation frontier, with the striated/future region becoming least transparent by the start of epoch C.

The first readout can use checkpoint-at-row-boundary coverage directly. The second readout must remain a monotone frontier-tail display signal. These are not new chart concepts; they are the two existing consumption modes made explicit so the coverage algebra can change without breaking display semantics.

The existing row pipeline and chart model contain several frontier-style concepts: maximum τ with positive exposure, `tau_solid_max`, `tau_future_max`, and "observed through N" language. Those concepts are safe as computational coverage only when observation support is a contiguous prefix. Checkpoint-at-row-boundary coverage deliberately allows non-contiguous support.

Therefore the implementation must not use a scalar frontier as the computational source of coverage, admissibility, or support. Coverage consumers must read the per-τ support surface directly.

For display striation, derive a separate monotone **frontier-tail** signal from the same observation-support substrate. Conceptually, `frontier_tail(τ)` is the fraction of selected cohort/path mass whose observation schedule has not exhausted by `τ`.

Frontier-tail is **not** a per-mode closed-form reducer. It is a second generic support readout through the same DP interface as coverage, with only the checkpoint predicate changed.

For per-row coverage, the primitive checkpoint predicate is:

`O_e(source_day, local_row_age) = 1`

For frontier-tail, the primitive checkpoint predicate is:

`∃ h >= local_row_age such that O_e(source_day, h) = 1`

The value stream and topology are unchanged. The frontier-tail support stream multiplies the same model kernel by the future-checkpoint predicate at each edge/source-day/local-age cell, then propagates through the same carrier, subject, branch, join, and identity-degeneracy machinery as the ordinary coverage support stream. The row's `frontier_tail(τ)` is the cumulative tail-support at the readout node divided by the cumulative value at that node.

In the simple identity/window case, this generic readout degenerates to the fraction of selected cohorts with any applicable checkpoint/support at an age greater than or equal to `τ`. In active or multi-hop cases, the same DP produces the model-weighted source-day/path mass after latency-map placement. Implementers must not replace this with a bespoke `Σ_anchor Σ_source_day` active-cohort formula; such a formula is only an explanatory expansion of the generic DP in a simple topology, not an implementation authority.

This preserves the existing epoch-B effect: dense epoch A has frontier tail near one, epoch B decays as cohorts age out, and epoch C begins when the tail reaches zero.

This display-tail signal is intentionally different from per-row coverage. A missing retrieval row inside an otherwise still-observable region can have `coverage(τ) = 0` while `frontier_tail(τ) = 1`: the blob for that row fades out, but the chart should not treat the whole series as having entered the future striated region. Conversely, a genuine ageing-out frontier causes both per-row coverage and frontier tail to decline.

Scalar frontiers may still exist as derived display summaries of the frontier-tail vector, but only with a narrowed meaning. Examples:

- `tau_solid_max` may be the last τ before the first missing row in a dense-prefix display segment.
- `tau_future_max` may remain a horizon/calendar bound.
- a diagnostic `max_observed_tau` may report the largest checkpoint age present.

None of those scalars means every row up to that τ is covered unless a separate dense-prefix invariant has been proven for the request. If a renderer needs line dashing or epoch segmentation, it should derive it from the monotone frontier-tail vector or explicitly accept that the scalar is a coarse visual summary.

This is a compatibility break with any current code or doc wording that treats `max τ where exposure > 0` as an admissibility frontier. Under this proposal, exposure/support is row-indexed and can be positive, zero, positive again.

## Risks

The proposal depends on accepting coverage as model-conditional rather than purely observed. Multi-hop coverage necessarily uses model timing to allocate anchor mass to downstream source days before testing checkpoint existence. The correct name is therefore model-conditional checkpoint coverage, not exact observed timing coverage.

It can fail if cumulative checkpoints are revised non-monotonically. The algebra assumes that later checkpoints refine cumulative knowledge, not that the same source day can lose previously observed conversions because of regime changes, dedupe corrections, or source-system backfills. Such changes must be normalised or versioned before this layer.

It can fail under non-MCAR snapshot sparsity. If missing checkpoints correlate with conversion behaviour, adjusted evidence will be biased even if strict evidence and coverage are computed correctly.

It can overstate coverage if the implementation accidentally uses the latest available checkpoint regardless of output age, or uses latest-at-or-before carry-forward as coverage. This is the primary semantic regression to guard against. Future observations must never cover earlier output rows, and earlier observations must not cover later missing row boundaries.

It can silently regress if downstream code keeps using scalar frontier fields as if support were a contiguous prefix. A row-support vector with holes cannot be represented by one `frontier_by_anchor` integer without losing information. Cutover must audit every consumer of frontier fields.

It can break chart semantics if per-row coverage is reused for future-frontier striation. Blob alpha should read per-row coverage. Striation should read a monotone frontier-tail signal. They are related but not interchangeable.

It can reintroduce AP58 if frontier-tail is implemented as a separate active-cohort closed form. Frontier-tail must be a generic DP readout with a future-checkpoint predicate; mode-specific summation formulas are explanatory only.

It can understate coverage if non-latent or deterministic transitions are treated as requiring a checkpoint at exact conversion delay zero. Checkpoint semantics say a row at retrieval age one covers the cumulative by age one, which includes delay zero.

It can become too expensive if implemented as a naive full DP for every output age, every anchor, and every draw. This is a performance risk, not a semantic objection. First implement the clean semantics in a small test surface, then optimise while preserving the row-boundary checkpoint invariant.

It can conflict with existing documentation. Several current docs say coverage is a masked-kernel ratio driven by exact row-presence masks. Those sections must be marked superseded or rewritten if this proposal is accepted.

## Acceptance Tests

The acceptance suite should include algebraic tests before outside-in fixture tests.

A single non-latent edge with first checkpoint at age one must report zero coverage before age one and full coverage at age one, with no special branch for non-latent timing. Later ages require their own checkpoints; age one does not imply coverage for a missing age two row.

A single latent edge with checkpoints at ages one and six must report coverage at ages one and six and no coverage at ages two through five. The age-six checkpoint must not retroactively cover the missing ages.

A two-edge serial chain must report terminal support only for path mass whose upstream and downstream source-day buckets both have row-boundary checkpoints at the local ages induced by the output row.

A parallel-path graph must report support as the sum of covered path mass. If one path has checkpoints and the other does not, coverage should reflect only the model mass routed through the covered path.

An observed-zero terminal checkpoint must produce admissible strict evidence with numeric zero, not absence.

An exact-row-presence regression test should prove that removing an intermediate retrieval row zeros coverage at that row boundary even when earlier and later checkpoints exist.

Frontier compatibility must be tested directly: with checkpoints at ages one and six, any computational `frontier_by_anchor = 6` style field must not cause ages two through five to be treated as covered. Either the scalar is absent from the computational path, or coverage is derived from a per-τ vector that preserves the hole.

Chart compatibility must be tested directly: a missing retrieval row inside the still-observable region should drive blob alpha to zero at that row but leave the future-frontier striation in the epoch-A/non-future state; a true ageing-out region should drive the monotone frontier-tail signal down toward zero through epoch B.

Frontier-tail implementation must be tested as a generic DP readout: an identity/window fixture and an active/multi-hop fixture with equivalent checkpoint schedules should both obtain frontier-tail from the same support-evaluation path, with no active-cohort-specific reducer or closed-form branch.

The strict carry-forward policy must be pinned directly: with checkpoints at ages one and six and a missing age three row, the age-three row carries the latest strict cumulative value from age one when the denominator is defined, while coverage for the missing row boundary is zero.

Adjusted evidence must have a separate gate before Stage 3: a test must prove the non-forward-filled adjusted numerator plus checkpoint-boundary IPW semantics on a missing-retrieval block.

The current fanout failure should pass without substituting `emp_y_value_c > 0` as the admissibility predicate. The test should include a variant where the terminal observed value is zero to prove observed-zero admissibility.

## Proposed Decisions

This proposal makes the following decisions:

1. Checkpoint-at-row-boundary coverage replaces exact-τ row-presence masking.
2. Multi-hop coverage is model-conditional: interval-censored upstream mass is allocated to downstream source days by the latency map before checkpoint existence is tested.
3. Strict empirical values carry forward latest-at-or-before cumulative observations; row-boundary coverage remains independent and may be zero on stale strict rows.
4. Adjusted evidence remains in Stage 3 using the non-forward-filled adjusted numerator and checkpoint-boundary IPW denominator.
5. Per-row coverage drives evidence blob alpha.
6. Monotone frontier-tail drives future-frontier striation.
7. Scalar frontier fields are never computational coverage/admissibility authorities. They may survive only as display summaries or diagnostics.
8. Implementation reuses the existing DP by adding output-row context to support/exposure evaluation; it does not introduce a bespoke graph reducer.

## Cutover Consequences

Stage 3 is blocked by this proposal. The current mask logic cannot be patched locally without preserving the same clock error: it multiplies transition-delay kernels by retrieval-age row presence. Any Stage 3 work that continues to depend on the current `exposure_y_A(τ) > 0` predicate, exact-τ row masks, or scalar frontier-as-admissibility will keep producing post-cutover failures.

The current one-line fix of switching admissibility from conditioned exposure to empirical positive value is insufficient. It fixes the positive-evidence fanout symptom but fails observed-zero cases and leaves the coverage algebra on the wrong clock.

The current exact row-presence mask should be renamed or demoted diagnostically. Its current use as an event-time support mask is semantically invalid.

The Phase 6 contract should be updated before Stage 3 cutover. The current wording of strict admissibility and the masked support/exposure stream is no longer a valid authority for implementation.

Stage 3 must prove adjusted evidence against checkpoint-boundary coverage. The existing Stage 2(b) adjusted-numerator acceptance is retained as the numerator policy, but its denominator and retrieval-gap tests change under this proposal.

Stage 3 must audit scalar frontier consumers. Any consumer that treats `max τ where exposure > 0` or `tau_solid_max` as proof of contiguous support must be updated to read per-row coverage, read a monotone frontier-tail display vector, or recast the scalar as display-only.

The docs and tests should be reoriented around checkpoint frontiers: retrieval rows are cumulative observations by age, not point observations at age.
