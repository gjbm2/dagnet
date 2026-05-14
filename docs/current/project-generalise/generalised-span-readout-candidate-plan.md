# Generalised Span Readout Candidate Plan

**Status**: proposal for the next generalisation attempt
**Date opened**: 13-May-26
**Scope**: selected evidence and model readout for `cohort_forecast_v3`, with a harness-first path that avoids reopening the whole CF runtime at once.

## Purpose

This note captures the next attempt after the rolled-back `project-generalise` rewrite. The previous attempt correctly tried to dissolve parallel row/evidence paths, but it changed too much of `cohort_forecast_v3.py` in one pass and regressed single-hop cohort subject evidence. The next attempt should be smaller, explicit, and proof-led.

The goal is one general span readout reused for both model and evidence surfaces. Carrier and subject should be roles of the same object. `window()`, `cohort(A = X)`, single-hop, non-latent, and active `cohort(A != X)` should differ by supplied operators and degenerate data, not by separate code paths.

## Current Candidate Shape

The candidate harness lives outside the production CF runtime in this folder. It is three layers plus a separate diagnostic module:

1. **`span_readout_candidate.py` — pure algebra core.** Receives already-aligned ledgers and ordered operators. Repeatedly applies the operators by dense multiplication and projects the terminal ledger to per-cohort row-age prefixes. No validation, no topology, no mode awareness, no admission. Identity carrier is the empty operator sequence.

2. **`span_operator_supply_candidate.py` — operator supply.** Owns the boundary between caller-supplied surfaces and the core's `SpanOperator`. Accepts two kinds of input:
   - raw arrays (root mass, identity, delay kernels, model CDFs, cumulative evidence rates, age-indexed `n/k`, source-day-specific `n/k`);
   - primitive surfaces (`PrimitiveModelSurface`, `PrimitiveDrawSurface`), which carry `timing_family` so one builder dispatches latent / non-latent / deterministic shapes.

3. **`runtime_model_span_adapter_candidate.py` — runtime adapter.** Pure shape normalisation from live-runtime objects into the primitive surfaces above, plus evaluation entry points. Two normalisers: `resolved_model(edge_id, src)` handles dict- or attribute-shaped sources via duck typing; `resolved_model_from_conditioned_primitive(primitive, draws=False)` walks the nested `ConditionedTransitionPrimitive` shape (per-draw with `draws=True`). Entry points: `evaluate_model_span` over an ordered edge bundle, `evaluate_window_model_span` / `evaluate_active_model_span` as thin role wrappers, `evaluate_with_operators` when the caller has compiled per-draw operators. Imports only the candidate modules.

4. **`model_span_shadow_candidate.py` — diagnostic shadow helpers.** `candidate_curve`, `compare_candidate_curve`, `expected_curve_from_composed_span_mean` / `..._draw`, `grid_edge_mass`, `carrier_horizon_from_composed_span`. Consumes the candidate's `PrefixSurface` and a production-like `composed_span` and produces differences. Not part of the adapter; not on the evaluation path.

The 2026-05-13 work compressed the candidate from ~700 to ~400 lines of code: the dual operator-supply tier collapsed into one module with a shared `_primitive_kernels` helper dispatching latent / non-latent / deterministic timing families; the four runtime shape normalisers collapsed into two; the three evaluation entry points collapsed to one body plus role wrappers; the `SpanReadoutInput` / `make_span_input` / `RuntimeResolvedModel` / `RuntimeResolvedDrawModel` dataclasses are gone — `evaluate_span_readout` takes keyword args directly and adapters return `PrimitiveModelSurface` / `PrimitiveDrawSurface`.

## What Has Been Proven

53 candidate tests cover:

**Pure core.** Identity, single-hop, multi-hop, non-latent carrier collapse to window-seed, latent carrier divergence from window, model/evidence operator reuse, source-day-specific kernels, covered-zero distinct from absence, negative-mass propagation.

**Operator supply.** Root mass compilation, identity operator, model CDF operator splitting reach from timing, age-indexed `n/k` evidence, source-day-specific `n/k` evidence, composition through the core, equivalence of `cumulative_rate` and `n/k` constructors, primitive surfaces (latent / non-latent / deterministic) compiled through one dispatching builder, draw surfaces compiled per draw, path-order preservation.

**Model-only oracles.** Single-hop `p × CDF`, two-hop instantaneous product, two-hop latent PMF convolution, carrier-plus-subject chain equivalence, identity-carrier omission, active non-latent-carrier collapse to window-seeded multi-hop subject span.

**Runtime adapter.** Topology order preservation; dict / object / conditioned-primitive ingestion; refusal at the perimeter when probability or timing posterior is absent; non-latent ingestion does not require `cdf_mean`; draw ingestion uses the production-style `timing_draws()` accessor; deterministic primitives land at `shift_days`, not zero; draw dispersion preserved through a multi-primitive chain; day-grid sizing with carrier horizon; provenance-shaped topology adapter.

**Shadow against production.** Real `ConditionedTransitionPrimitive` objects, real `compose_primitive_span`, candidate model curve matches the composed-span mean curve exactly; `grid_edge_mass` exposes too-tight grids; expected curves pad short CDFs by saturation.

**Strict shadow engine.** `graph-editor/lib/runner/generalised_span_model_shadow.py` is now plan-in / comparison-out only. It receives `SpanShadowPlan` objects containing root value/support, ordered value/support operators, and expected value/support curves. It does not inspect runtime objects, choose identity carrier, compile model/evidence surfaces, skip missing inputs, or catch failures. Unit coverage proves the same engine handles model-shaped operators, observed-rate evidence operators, covered-zero evidence, and support saturation. A direct parity test compares its support algebra against `span_readout_candidate.evaluate_span_readout`, so the shadow engine cannot drift from the candidate support semantics silently.

**Outside-in production shadow.** The maintained `cohort_maturity` path now emits strict shadow diagnostics under `--diag` for carrier, subject, request, `evidence_x`, and `evidence_y`. The current outside-in matrix covers identity carrier single-hop, active carrier single-hop, identity carrier multi-hop, and active carrier multi-hop. Evidence value/support matches current rows to floating point in those probes. Model value/support differences are small and explained by the intended semantic distinction between mass-first `E[p × CDF]` and current production marginal summaries `E[p] × E[CDF]`.

## What Has Not Been Proven

- Cutover: the row path still uses the old bespoke prefix family as runtime authority; strict span plans are still shadow diagnostics.
- Production evidence operator supply from primitive-bound rows is not yet the authority. The outside-in evidence shadow currently proves the strict engine can carry current selected A-clock aggregate value/support curves exactly; it does not yet replace the construction of those curves.
- Model row cutover has not happened. The semantic upgrade from `E[p] × E[CDF]` to mass-first `E[p × CDF]` is identified but not yet applied to row fields.
- Selected prefix integration with `SelectedAClockEvidence`, `_project_runtime_rows`, or `_selected_cohort_group_rate_draws`.

## Cutover And Debranch Plan

Take a photocopy of the working tree before starting the cutover. Then cut over directly to the strict span readout as the maintained selected-prefix engine. The goal is not to build another old/new runtime branch; the goal is to make the existing row path read one operator-supplied span object and then delete the bespoke prefix family it replaces.

### Target Contract

The evaluator remains branch-free. Its input is root value/support plus an ordered list of value/support operators. Identity carrier is an empty operator list. Single-hop is one operator. Multi-hop is more operators. Model and evidence differ only by supplied operators. Covered-zero and absent differ by support, not by a separate row path.

Production code before the evaluator may resolve request semantics, primitive identity, evidence admission, and operator construction. Once those facts have been compiled into a span plan, the evaluator only pushes ledgers forward and projects prefixes. No evaluator or row projection code should ask whether the query is `window()`, active `cohort()`, identity carrier, single-hop, multi-hop, latent, non-latent, model, or evidence.

### Replace The Prefix Objects

Replace the selected-prefix family with strict span plans:

- Carrier denominator prefix becomes a carrier value/support span rooted at the selected population.
- Subject numerator prefix becomes a subject value/support span rooted at the denominator node.
- Request prefix becomes carrier operators followed by subject operators.
- Row evidence fields and reducer frontier state read the same produced prefix object.

The old objects to retire are `_SelectedSourceDayMass`, `_CarrierOnlyDenominatorPrefix`, `_RateAttributedSubjectPrefix`, and the selected A-clock evidence amplitude path as separate business logic. During the cutover they may survive briefly as local adapters or comparison probes, but not as alternate authorities.

### Evidence Operators

Evidence operators are built from admitted primitive evidence surfaces, not from snapshots, parameter files, graph fields, or frame fallbacks. The supply boundary consumes the already-bound primitive rows and produces value/support operators. The evaluator does not know whether an evidence operator came from an age-indexed surface, source-day-specific surface, carrier evidence, or subject evidence.

The support ledger is first-class. Covered-zero is represented by zero value with positive support. Absent means no support. This is the replacement for the current split between evidence amplitude, coverage signals, and selected A-clock cell presence.

### Midpoint And Quadrature Corrections

The midpoint shift and interpolation/curvature correction are operator-supply policy, not evaluator policy.

Post-cutover, dequantisation happens while compiling observed evidence surfaces into operators. The operator supplier decides the source-day evaluation convention for local observed rates, including the first-subject-layer midpoint shift when selected mass is spread across source days, and the curvature-corrected interpolation used when a cumulative observed rate is sampled between integer ages. The output of those corrections is just an operator. The evaluator does not know that any midpoint or quadrature correction happened.

This placement preserves the existing numerical intent without reintroducing branches into the readout. If a correction is required because the source-day mass shape has particular geometry, that geometry belongs to operator construction. Once constructed, the same operator-chain algebra handles identity, active, single-hop, and multi-hop cases.

Specialised observed-rate operators must specialise the general observed-rate operator, not sit beside it as a second implementation. The shape is:

1. start with the admitted local evidence surface;
2. apply the evaluation policy required by the edge/layer context, such as midpoint shift, terminal-hop interpolation, or curvature correction;
3. pass the adjusted cumulative-rate/support surface to the general observed-rate operator constructor;
4. return the same `SpanOperator(value, support, provenance)` type as every other operator.

In other words, the specialised constructor transforms the input surface and then calls the general constructor. It must not duplicate the day-to-day kernel algebra, and the evaluator must not know whether an operator was standard or specialised. Provenance should record the policy (`evaluation_policy`, `layer_index`, `is_terminal_subject_layer`, etc.) so the numerical choice remains auditable without becoming a runtime branch.

### Model Operators

Model operators should use the draw-coherent mass surface: the mass curve is the expectation of probability times timing, not the product of marginal summaries. Current production model summaries can remain as diagnostics, but the cutover target is the mass-first object. This preserves joint probability/timing structure and still conserves eventual reach at saturation.

### Row Projection And Reducer

After prefix construction moves to strict span plans, row projection becomes a readout of the produced prefix surfaces:

- `evidence_x`, `evidence_y`, and evidence support/coverage read the strict evidence prefix.
- `x_frozen` and `y_frozen` in the E+F reducer read the same prefix at the frontier.
- Future projection terms read the model carrier/subject/request operators rather than reconstructing carrier or subject semantics locally.

The seam invariant is the cutover test: row evidence and reducer frontier state must come from the same prefix object. If they do not, the branch removal is incomplete.

### Delete The Branches

Once the strict span path is the only authority, delete the old decision points rather than preserving fallbacks. In particular:

- no identity-carrier rescue path;
- no row-level active-vs-identity evidence splice;
- no subject single-hop/multi-hop row branch;
- no display-layer cap or repair of prefix values;
- no frame-derived fallback for selected A-clock evidence;
- no projection-time carrier/subject re-decision.

Missing operator supply is a failure to build the span plan, not a reason for the evaluator or row projector to invent a substitute.

### Proof Before And After

Before deleting old code, run the strict shadow matrix outside-in on the maintained `cohort_maturity` path:

- identity carrier single-hop;
- active carrier single-hop;
- identity carrier multi-hop;
- active carrier multi-hop.

For each case, prove carrier, subject, request, evidence value, and evidence support. Evidence should match current correct rows to floating point. Model differences caused by joint expectation versus separated marginal summaries are expected and should be recorded as the intended semantic upgrade, not chased as parity bugs.

After deletion, the same matrix becomes the regression suite. The cutover is complete when the maintained path produces rows from strict span plans and the old bespoke prefix family no longer participates in runtime behaviour.

## Acceptance Criteria

This plan is not complete when the candidate merely exists. It is complete when:

- the strict xfail for `test_first_latency_edge_with_nonlatent_chain_observed_collapses_to_window` can be removed;
- multi-hop latent upstream divergence still passes;
- single-hop evidence is unchanged;
- identity `window()` and `cohort(A = X)` use the same identity carrier readout and match when their supplied operators are equivalent;
- active `cohort(A != X)` does not collapse into local-window mixing;
- row evidence and the E+F reducer read the same selected prefix at `tau_solid_max`;
- no new `is_window`, `is_identity_carrier`, or single-hop/multi-hop branch is introduced in the evaluator;
- support/coverage and visible evidence mass remain separate;
- provenance names whether a row came from model operators or observed evidence operators.

## Risks To Watch

- **Dense matrix representation is a harness choice**, not a production requirement. A production implementation should keep the operator abstraction but may use convolution, sparse, or lazy operators.
- **Wrong wiring will still produce algebraically valid but semantically wrong results.** The core will not defend against that. Adapter tests and outside-in fixtures must catch it.
- **Evidence is harder than model curves.** Model operators have clean `p` and CDF inputs; evidence operators carry clock and count semantics that must be resolved before the core sees them.
- **Do not add mode branches inside the core.** If a case seems to require a branch, the operator supply boundary is probably not explicit enough.

## Background

The current runtime already has a mostly general model span concept: `subject_span_composer.compose_primitive_span` composes conditioned primitives into a role-neutral `ComposedPrimitiveSpan`; `ResolvedCFRuntime` stores role-labelled `composed_subject` and `composed_carrier`; identity carrier is represented as `composed_carrier = None` plus semantic equality `population_root == denominator_node`.

The evidence path is less general. The row pipeline still constructs a family of selected-prefix objects around active cohort display: selected source-day mass, carrier-only denominator prefix, rate-attributed subject prefix, selected A-clock evidence cells, separate residual identity/active logic in the reducer and projection path.

This is too many evidence-span concepts. It is also the source of the current active-cohort observed-prefix defect: active cohort `evidence_x` can be read from a reach-preserving model prefix (`N_cohort * prior reach`) rather than from realised observed selected mass. In non-latent upstream cases, that prevents cohort rows from algebraically collapsing to the equivalent window rows.

## What 73r Did And Did Not Solve

`73r-generalised-primitive-evidence-acquisition-plan.md` addressed a different layer. It generalised evidence acquisition for primitive conditioning: build evidence candidates for every primitive edge, merge candidates in one path, bind primitive-local evidence with arrival weights, condition each primitive once, compose conditioned primitives.

That is necessary, but it is not sufficient for displayed `n` and `k`. It solves how evidence reaches primitive posteriors. It does not solve how observed evidence is read out as selected-cohort count prefixes for chart rows. The new work starts after primitive evidence has been admitted. It asks: given a root mass and edge-local observed/model operators, how do we push mass through a span and produce denominator/numerator prefixes with coverage?

## Target Abstraction

The target is one role-neutral span readout:

- A span has a root node, an end node, a topology, a clock policy, root mass by selected day, and edge operators.
- A readout pushes root mass through the topology and returns prefix surfaces at the end.
- Carrier and subject are role labels on the same readout.
- Model and evidence are operator families supplied to the same readout, not separate span implementations.

The readout output always separates: value amplitude (selected mass/count prefix by selected root day and row age); support/coverage (which real observed cells support the value); intermediate ledgers (selected mass at internal source nodes, when later edges need it); provenance (operator family, binding, role, clock, and degradation reason if a required operator is absent).

The core rule is: mode selects operators; the evaluator composes operators. Mode-specific decisions belong before the evaluator, not inside its mass-propagation loop.

## Operator Families

### Model

Model operators carry probabilistic reach, timing CDFs, and draw families. They already exist conceptually in `ComposedPrimitiveSpan`. For a model carrier, the readout answers how selected population mass reaches `X`. For a model subject, it answers how mass at `X` reaches the subject end. Model reach is legitimate future/projection mass.

### Evidence

Evidence operators carry observed local rate/count surfaces and support. They are derived from admitted primitive evidence rows, not from posterior model draws and not from frame-derived substitutes. Raw counts do not cross primitive boundaries: a downstream primitive's raw `k` is not selected-cohort terminal mass, it is an observed local rate on that primitive, which may be applied to selected mass reaching that primitive's source.

The evidence readout pushes selected mass through observed local kernels. Single-hop degenerates to direct counts because selected source mass and the observed row denominator are the same object: `n` times `k/n` recovers `k`. Multi-hop repeats the same operation over more edges.

## Query Degeneracies

The same readout covers these cases by data, not by code path:

- `window()`: carrier is a zero-edge identity span at `X`; subject remains `X -> end`.
- `cohort(A = X)`: same identity carrier.
- Active `cohort(A != X)`: carrier is `A -> X`; subject remains `X -> end`.
- Single-hop subject: subject topology has one edge.
- Multi-hop subject: subject topology has multiple edges.
- Non-latent edge: timing/operator delay is a point mass at zero.
- No admissible observed operator: evidence readout degrades visibly; model readout may still project future mass.

## What Must Not Happen

The next attempt must not repeat the failed broad rewrite pattern.

Do not refactor `cohort_forecast_v3.py` in place first. Do not preserve a production old/new branch as the acceptance strategy. Do not make row projection re-decide carrier, subject, admissibility, `p_infinity`, or evidence binding. Do not fill evidence-named fields from model projection values. Do not mutate `_SelectedSourceDayMass` into an evidence-local object if model consumers still rely on its source-layer timing meaning.

The selected evidence line and the E+F reducer must consume the same selected prefix object at the epoch seam. A display-only fix that changes `evidence_y` but leaves reducer `x_frozen` / `y_frozen` on a different prefix is not a fix.

## Shadow Integration Strategy

After the isolated harness is correct, add adapters from current runtime structures into the candidate in shadow mode only.

The first integration target should be the denominator evidence prefix, because the current active defect is clearest there: realised selected `X` mass must not be scaled by aggregate prior reach when the past path has already observed the carrier. Compare the candidate denominator against current window output for identity cases, a window oracle for non-latent active carrier collapse, and current active output only where it is already known correct.

Only then wire the subject evidence prefix. The subject side carries the harder per-source-day carry-forward and multi-hop propagation semantics. It should not be integrated until the denominator prefix and support surfaces are stable. After both value prefixes are correct, wire the candidate prefix into the selected-cohort reducer so `midpoint` and evidence rows share the same frontier state.

## Relationship To Existing Project-Generalise Docs

This note supersedes the broad rewrite strategy in `multi-hop-window-evidence-rate-composition-implementation-plan.md` as the recommended next execution shape. It preserves the algebraic insight from that design: selected mass should be pushed through local observed rate kernels, and single-hop/multi-hop should be degeneracies of one evaluator.

The change is procedural and architectural: first prove one general readout candidate locally, then adapt the existing runtime into it. Do not attempt another large direct rewrite of `cohort_forecast_v3.py`.
