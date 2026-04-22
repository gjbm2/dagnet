# 59 — Cohort/Window Forecast Implementation Scheme

**Status**: Active reference  
**Date**: 21-Apr-26  
**Updated**: 22-Apr-26  
**Review status**: Core runtime scheme now live; retained as the target/reference note for residual follow-on work  
**Review pack role**: 2 of 3 — target runtime and consumer contract  
**Relates to**: `docs/current/codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `29-generalised-forecast-engine-design.md`, `29b-span-kernel-operator-algebra.md`, `29c-phase-a-design.md`, `45-forecast-parity-design.md`, `47-multi-hop-cohort-window-divergence.md`, `52-subset-conditioning-double-count-correction.md`, `52-b3-spike-workplan.md`, `53-explicit-drift-modelling-discussion.md`, `60-forecast-adaptation-programme.md`

This note should be reviewed second, after the semantics reference and
before the adaptation programme. Its job is to define the target runtime
contract that the implementation should converge on. The main review
questions here are whether the runtime objects, prior/evidence rules,
projection surfaces, and first-class consumer coverage faithfully express
the semantic source of truth and whether anything material is missing or
over-specified at the target-contract level.

---

## 1. Purpose

This note defines the target implementation scheme for the forecast stack
after the semantic clarifications captured in
`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`.

The execution plan derived from this target contract lives in
`60-forecast-adaptation-programme.md`.

It is intended to do two jobs:

- define the target contract the live implementation should satisfy
- provide the frame for the immediate delta analysis against the live
  forecast consumers

As of 22-Apr-26, the core runtime objects in this note are now present in
the live code (`population_root`, `carrier_to_x`, `subject_span`,
`numerator_representation`, `admission_policy`, and
`p_conditioning_evidence`). The narrow direct-`cohort()` `p`
conditioning flag has also landed. The remaining open material in this note
is mainly the outer delta-analysis frame and the later B3 / gross-numerator
questions, not the basic runtime seam itself.

A scheme that only works for the `cohort_maturity` chart path is not
enough. The whole-graph, topo-sequenced BE conditioned-forecast pass that
writes back to the graph is a core consumer and must be treated as a
first-class citizen alongside chart, summary, and graph-reading consumers.

The aim is to produce one implementation pattern that degenerates
naturally across:

- `window()` versus `cohort()`
- single-hop versus multi-hop
- `A = X` versus `A != X`
- factorised versus exact-match gross-fitted numerators

The specific design pressure that motivates this note is that the system
should not throw away direct `cohort()` evidence that is genuinely
relevant to `p`, but it also must not destroy the cleaner factorised
runtime template by letting anchor-rooted whole-query objects seep into
every stage by default.

## 2. Starting point

This scheme takes
`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` as the semantic
reference contract.

From that note, five conclusions are load-bearing.

First, the displayed rate remains `Y / X`, not `Y / A`, even in
`cohort()` mode.

Second, the factorised runtime template is built from two different
questions:

- denominator side: who has reached `X` by age `tau`
- numerator side: given mass at `X`, who has reached the subject end by
  age `tau`

Third, multi-hop semantics are always about the full subject span
`X -> end`, not the last edge into the end node.

Fourth, a gross fitted whole-query numerator is a different
representation, not a drop-in substitute for the factorised
`carrier_to_x + subject_span` scheme.

Fifth, admissibility is a real gate. Reusable fitted objects must match
the right question, metadata, and evidence basis for the role they are
being asked to play.

## 3. Non-negotiable invariants

Any implementation that claims to satisfy the semantic note should obey
the following invariants.

1. The denominator side and numerator side are separate semantic objects,
   even when they later interact in one forecast computation.
2. `A = X` is a general identity case for cohort-mode denominator
   behaviour, not a single-hop special trick.
3. `window()` remains `X`-rooted. It does not secretly become an
   anchor-rooted object downstream.
4. Multi-hop subject semantics mean `X -> Z` as a full span. No consumer
   may silently replace that with the last edge.
5. If the future numerator is factorised, Pop C and Pop D remain additive
   future terms.
6. If the future numerator is gross fitted, Pop C and Pop D become
   explanatory only and must not be re-added on top.
7. Query-scoped rate posteriors must not be conditioned again on the same
   query-scoped evidence.
8. Aggregate rate priors may be conditioned on matching query-scoped
   evidence.
9. Frontier forecasting remains window-led in the sense of
   `53-explicit-drift-modelling-discussion.md`: mature cohort evidence may
   help structural calibration, but it must not erase the distinction
   between current-regime estimation and delayed supervision.

## 4. Canonical runtime objects

The optimal implementation scheme should make the following objects
explicit.

### 4.1 `population_root`

Defines who the selected population is and what the time origin means.

- `window()` sets `population_root = X`
- `cohort()` sets `population_root = A`

### 4.2 `carrier_to_x`

The denominator-side object that maps the selected population into
arrivals at `X`.

- in `window()`, this collapses to the identity
- in `cohort()` with `A != X`, this remains a real `A -> X` carrier
- in `cohort()` with `A = X`, it collapses to the identity again

### 4.3 `subject_span`

The numerator-side object that answers the conditional progression
question `X -> end`.

- in single-hop, this degenerates to one edge
- in multi-hop, this remains the full `X -> end` span

### 4.4 `numerator_representation`

The runtime must choose one of two representations:

- **factorised**: carrier and subject remain separate
- **gross whole-query numerator**: one exact admitted whole-query object
  becomes the future numerator source of truth

The representation choice is not cosmetic. It changes whether Pop C and
Pop D remain additive future terms.

### 4.5 `admission_policy`

The admissibility matrix from the semantic note decides whether an
external fitted object may be used:

- as the whole-query numerator
- as a subject-side helper
- or not at all

### 4.6 `p_conditioning_evidence`

This note introduces one more explicit object because the rate update path
needs a clean seam.

`p_conditioning_evidence` is the evidence base used to condition or
reweight the rate component of the runtime object under consideration.

It is not identical to the entire frame-composition result, and it is not
identical to the latency evidence basis.

Keeping this object explicit is what allows the implementation to admit
direct `cohort()` evidence for `p` without rewriting the whole runtime
template around gross whole-query objects.

## 5. One-template runtime flow

The target runtime flow should be:

1. Resolve the request into `population_root`, denominator node `X`,
   subject end, full subject span, frontier, mode, slice, context,
   `asat()`, and candidate reusable fitted objects.
2. Build `carrier_to_x` from the resolved request semantics.
3. Build `subject_span` for the exact `X -> end` question.
4. Run `admission_policy` on all reusable fitted objects.
5. Choose `numerator_representation`.
6. Resolve `p_conditioning_evidence` for the runtime objects that need a
   rate update.
7. Condition or reweight only those priors that are semantically allowed
   to update from that evidence base.
8. Compute one resolved runtime object graph, then project from it into
   the required consumer surfaces: trajectory rows, conditioned scalar
   responses, summary scalars, and graph-enrichment fields.

The key property is that the cases differ by collapse, not by changing the
semantic wiring.

## 6. First-class forecast consumers

The scheme has to generalise across all live forecast consumers, not just
the chart path.

| Consumer class | Representative surface | What it needs from the scheme | Why it is first-class |
|---|---|---|---|
| whole-graph conditioned enrichment | `handle_conditioned_forecast` without `analytics_dsl`, projected by `conditionedForecastService.ts` onto the graph | topologically ordered whole-graph solve plus authoritative per-edge scalar projection | this is the conditioned forecast writer of record for graph state; it is not a secondary read of the chart |
| direct conditioned-response consumers | `handle_conditioned_forecast` in scoped or whole-graph mode; today `run_conversion_funnel` uses the whole-graph CF response and then extracts the relevant path view | the same object-role resolution and evidence routing as the whole-graph CF pass, but consumed as response scalars instead of persisted graph fields | these consumers must see the same semantics as the authoritative CF pass, not a chart-specific approximation |
| trajectory consumers | `_handle_cohort_maturity_v3` and `compute_cohort_maturity_rows_v3` | per-`tau` rows, bands, and numerator / denominator traces from the same resolved object graph | the chart should be one projection of the shared solve, not its own semantic fork |
| scalar-summary consumers | `compute_forecast_summary` and the surprise gauge | summary statistics for one resolved subject without requiring a row sweep | summary consumers may use a reduced solve, but they must inherit the same object roles, prior choices, and evidence-routing rules |
| graph-state consumers | `apply_visibility_mode`, path / branch / end-comparison runners, and any UI that reads persisted graph fields | stable public graph fields with clear writer precedence | these consumers depend on the projection contract, not on inner-kernel knowledge |
| analytic fallback writers | `handle_stats_topo_pass` and the `analytic_be` projection path | model-var generation plus explicit provisional flat-field projections where needed | this remains a separate subsystem, but it must coexist cleanly with the CF contract instead of shadowing it |

The first row is load-bearing. Any implementation scheme that does not
describe the whole-graph BE CF pass as a first-class consumer is missing
the main conditioned writer that downstream graph readers actually depend
on.

## 7. Projection and output contract

The runtime object graph is not the public contract by itself. Consumers
observe projections of it.

| Projection surface | Representative writer or reader | Contract |
|---|---|---|
| trajectory projection | `_handle_cohort_maturity_v3` | expose per-`tau` rows, midpoint / bands, and numerator / denominator traces from the shared resolved object graph |
| conditioned scalar response | `handle_conditioned_forecast` response payload | expose per-edge conditioned scalar outputs such as `p_mean`, `p_sd`, `p_sd_epistemic`, `completeness`, `completeness_sd`, and `conditioned` without re-deciding semantic roles at projection time |
| graph-enrichment projection | `conditionedForecastService.ts` writing `edge.p.mean`, `edge.p.forecast.mean`, `edge.p.latency.completeness`, and `edge.p.latency.completeness_stdev` | this is the authoritative persisted projection when CF lands; graph-state consumers rely on these fields rather than on hidden runtime objects |
| summary projection | `compute_forecast_summary` and surprise-gauge outputs | produce scalar summaries from the same resolved object roles and conditioning rules, even if the numerical reduction is scalar-only rather than row-based |
| analytic fallback projection | `handle_stats_topo_pass`, `analytic_be`, and promoted fallback fields | provide analytic model vars and any provisional fallback scalars under an explicit authority boundary; must not masquerade as the conditioned CF result |

Two rules follow from this.

First, the whole-graph CF pass owns both a response projection and a
graph-enrichment projection. Those two projections must come from the same
resolved semantics.

Second, downstream graph readers must treat the persisted fields as the
public contract. They should not reconstruct `carrier_to_x`,
`subject_span`, or representation choice from incidental helper fields.

## 8. Prior and evidence rules by object

| Object | Question answered | Rate prior source | Latency prior source | Conditioning evidence | Notes |
|---|---|---|---|---|---|
| `carrier_to_x` | who reaches `X` by age `tau` | priors matching the `A -> X` carrier question | `A -> X` latency object | arrivals-at-`X` evidence only | never condition the carrier on numerator-at-end evidence |
| `subject_span` | given unit mass at `X`, when does it reach `end` | priors matching the `X -> end` subject question | `X -> end` latency object | subject evidence for `X -> end` only | multi-hop means the full `X -> end` span, not the last edge |
| gross whole-query numerator | what future numerator mass does the exact query produce | exact admitted whole-query prior only | exact admitted whole-query latency only | exact same whole-query evidence base only | if used, Pop C and Pop D are no longer additive numerator terms |
| `p_conditioning_evidence` | which evidence may move the rate object | n/a | n/a | depends on object role | this is a rate-conditioning input, not a general replacement for the full runtime evidence basis |

## 9. Recommended treatment by semantic table

### 9.1 `window(X-Y)`

This is the baseline case.

The denominator is fixed at `X`. No carrier solve is needed beyond the
identity.

The numerator uses a single-edge `subject_span(X -> Y)` object. Its rate
and latency priors should both be `X`-rooted. Conditioning evidence should
be query-scoped `window(X-Y)` evidence.

There is no Pop C term.

### 9.2 `window(X-Z)`

The denominator is unchanged from `window(X-Y)`.

The numerator uses a full `subject_span(X -> Z)` object. The default
inventory should be atomic `window()` edge operators across the exact
subject span. Conditioning evidence should answer the full `X -> Z`
question, not the last-edge question.

There is still no Pop C term.

### 9.3 `cohort(A, X-Y)`

The denominator side uses `carrier_to_x`.

When `A != X`, the carrier remains a true `A -> X` object. Its priors and
conditioning evidence must both answer the arrivals-at-`X` question.

When `A = X`, the carrier collapses to the identity.

The factorised numerator should still be treated as an `X -> Y` subject
question. This is the cleanest way to preserve one runtime template across
window and cohort modes.

That means the default factorised subject helper should be an
`X`-rooted object. The admitted helper may come from `window(X-Y)` or from
`cohort(X, X-Y)` if the admission gates are satisfied. It should not
default to an anchor-rooted gross query object.

### 9.4 `cohort(A, X-Z)`

The denominator side is unchanged from `cohort(A, X-Y)`.

The numerator side uses a full `subject_span(X -> Z)` object. The default
factorised subject semantics remain `X`-rooted. The implementation should
prefer admitted `X`-rooted helpers or atomic `window()` composition over
the full `X -> Z` span.

Direct anchor-rooted whole-query objects remain valid only as exact gross
whole-query numerators, not as the default subject helper in the
factorised runtime template.

## 10. Direct `cohort()` evidence for `p`

The main additional design choice introduced by this note is that the
runtime should support a narrow, explicit path for using direct
`cohort()` evidence for `p` conditioning.

The motivation is straightforward. For `cohort()` queries, direct
`cohort()` evidence is genuinely relevant evidence about the realised
performance of A-anchored Cohorts. Throwing it away entirely is too strong
a trade-off.

At the same time, this evidence should not be allowed to rewrite the whole
runtime template by stealth.

### 10.1 Current live scope

The current first implementation is:

- **flagged**
- **cohort mode only**
- **rate only**
- **single-hop first**, or more generally only where the subject match is
  exact and admitted with low semantic ambiguity

The live flag controls only the choice of `p_conditioning_evidence`.

It should not:

- switch latency semantics from `X -> end` to anchor-rooted path latency
- replace `carrier_to_x`
- silently promote a gross whole-query numerator representation
- alter the rule that frontier forecasting remains window-led for
  current-regime estimation

### 10.2 What the flag does

When the flag is enabled and the subject match is admitted:

- the runtime may use direct query-scoped `cohort()` evidence as the
  evidence base for the **rate** update of the relevant subject object
- the latency priors and latency-shape construction remain on the existing
  factorised semantics
- the carrier object remains unchanged

This produces a hybrid path:

- rate update may use direct `cohort()` evidence for `p`
- latency and carrier semantics remain factorised and role-correct

### 10.3 How rate priors behave under the flag

The update rule must still respect the existing scoping semantics of the
resolved prior source.

- If the resolved rate prior is aggregate, it may be conditioned or
  reweighted by the admitted direct `cohort()` evidence.
- If the resolved rate prior is already query-scoped, it must be read
  directly rather than updated again.

The implementation continues to branch on the semantic
property currently expressed in `ResolvedModelParams.alpha_beta_query_scoped`
in `graph-editor/lib/runner/model_resolver.py`, not on source-name
heuristics scattered through consumers.

### 10.4 Why the scope remains narrow

This design is intentionally narrower than "use `cohort(a,x-y)` directly
for everything".

Direct `cohort()` evidence is direct evidence for the **whole A-anchored
query behaviour**. It is not automatically direct evidence for the
isolated post-`X` latency kernel.

That is why the recommended v1 scope is:

- admit direct `cohort()` evidence for `p`
- do not let it silently replace latency semantics or object roles

## 11. What B3 may change

This scheme makes the B3 boundary clearer.

B3 remains viable if it is treated as an **upstream prior-refinement
programme**.

In that framing, B3 may:

- improve the prior blocks available to `carrier_to_x`
- improve the prior blocks available to `subject_span`
- move mature cohort evidence into edge-level refinement before the
  runtime solve begins

B3 should not be treated as permission to collapse the runtime template
back into anchor-rooted whole-query objects by default.

In other words: B3 may change the priors. It should not change the role
assignment of runtime objects or the evidence basis each object is
allowed to consume.

## 12. Surface ownership and delta-analysis frame

The delta analysis should compare the live code against the target
responsibilities below. The matrix separates runtime-object construction
from consumer-specific projection surfaces so that the whole-graph CF pass
is analysed as a first-class consumer rather than as a shadow of the chart
path.

| Surface | Target responsibility | Must not do |
|---|---|---|
| `graph-editor/lib/runner/model_resolver.py` | resolve mode-appropriate prior blocks and expose whether the rate posterior is already query-scoped | silently mix carrier and subject semantics |
| `graph-editor/lib/runner/span_kernel.py` and `graph-editor/lib/runner/forecast_runtime.py` | build admitted `subject_span` objects and their span-level prior summaries | treat the last edge as the multi-hop subject by default |
| `graph-editor/lib/runner/cohort_forecast_v3.py::build_cohort_evidence_from_frames` | build composed evidence objects and expose the evidence channels later stages need | choose semantic roles or mutate prior policy |
| `graph-editor/lib/runner/forecast_state.py::compute_forecast_trajectory` | solve the resolved runtime object graph for row-capable consumers | infer object roles from path length or from accidental field presence |
| `graph-editor/lib/api_handlers.py::handle_conditioned_forecast` | act as the first-class whole-graph and scoped conditioned-forecast consumer, owning topological sequencing and conditioned scalar projection inputs | be treated as a chart-only adapter or drift from the chart path on regime selection, object construction, or evidence routing |
| `graph-editor/src/services/conditionedForecastService.ts` | project authoritative CF outputs onto graph fields with explicit writer precedence over analytic fallback values | reinterpret the runtime semantics while projecting, or drop CF outputs that direct-response consumers still need |
| `graph-editor/lib/api_handlers.py::_handle_cohort_maturity_v3` and `graph-editor/lib/runner/cohort_forecast_v3.py::compute_cohort_maturity_rows_v3` | project trajectory rows from the same resolved object graph used by CF | fork a chart-only semantic path |
| `graph-editor/lib/runner/forecast_state.py::compute_forecast_summary` | produce scalar-only summary projections from the same resolved object roles and evidence contract | bypass object-role resolution or substitute bespoke last-edge / wrong-clock semantics |
| `graph-editor/lib/api_handlers.py::handle_stats_topo_pass` | produce analytic model vars and any provisional fallback projections under a clear authority boundary | become a second conditioned-forecast implementation or overwrite CF-owned semantics without explicit precedence |
| `graph-editor/lib/runner/runners.py::run_conversion_funnel` | consume the conditioned-response projection via `handle_conditioned_forecast` rather than inventing its own forecast semantics | bypass the public CF surface through inner kernels or assume edge-local completeness is always the same as path-cumulative completeness |
| `graph-editor/lib/runner/graph_builder.py::apply_visibility_mode` and graph-state runners | consume persisted graph projections only | reconstruct carrier or subject semantics from flat public fields |

The later delta pass should classify each divergence under one of five
headings:

- wrong object role
- wrong prior block
- wrong conditioning evidence base
- wrong projection or field-authority contract
- duplicated preparation logic that risks drift

## 13. Recommended rollout order

The implementation order implied by this design is:

1. Keep the semantic note as the reference contract.
2. Treat this note as the consumer map and projection contract for all
   first-class forecast consumers, explicitly including the whole-graph CF
   pass.
3. Run the delta analysis against the current code, starting with
   `handle_conditioned_forecast` and its graph projection path.
4. Implement the object-role seams explicitly enough that whole-graph CF,
   scoped CF, chart, and summary consumers share one preparation policy.
5. Add the narrow flag for direct `cohort()` `p` conditioning.
6. Land it first in the least ambiguous cohort subject case.

The design should be judged successful if the new path adds relevant
`cohort()` evidence for `p` without forcing a wider semantic fork across
carrier, latency, and representation choice, while still giving every
first-class consumer a clear projection contract and writer boundary.

