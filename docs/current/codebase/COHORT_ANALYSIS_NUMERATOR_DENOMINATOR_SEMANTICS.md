# Cohort and Window Analysis Numerator and Denominator Semantics

**Status**: Active reference  
**Date**: 21-Apr-26  
**Review status**: Ready for systematic peer review  
**Review pack role**: 1 of 3 — semantic source of truth for the review pack

This note should be reviewed first. Its job is to state the meaning that
the later design and implementation notes must preserve. The main review
question here is whether the semantic claims are internally coherent,
sufficiently precise, and free of hidden contradictions. Sequencing,
rollout, and file-boundary questions mainly belong in docs 59 and 60
unless they expose a semantic inconsistency in this note itself.

## Purpose

This note defines the semantic contract for `window()` and `cohort()`
analyses that display or forecast a rate of the form `Y / X`, where:

- `A` is the overall anchor node in `cohort()` mode
- `X` is the denominator node (the subject start)
- `Y` or `Z` is the subject end
- `tau` is age since the anchor day

`window()` is simpler because the selected population is already rooted at
`X`, so the denominator is fixed at the subject start. `cohort()` is more
subtle because the selected population is anchored upstream at `A`, while
the displayed rate is still `y/x`, not `y/a`.

That means the denominator and numerator are related but different
forecasting problems. This note separates them explicitly, defines the
single-hop and multi-hop cases for both modes, and distinguishes two valid
modelling representations:

- a **factorised** representation with an upstream carrier to `X` plus a
  subject kernel from `X` to the subject end
- a **gross fitted numerator** representation where the future numerator
  is modelled as one object and must not be reassembled from population
  sub-terms

This is a semantics reference, not a rollout decision. It does **not**
decide the open B3 question of whether mature cohort-level path latents
should become a structural correction in the live forecast stack. It
defines what any implementation must preserve once it chooses a
representation.

## See also

- `docs/current/codebase/RESERVED_QUERY_TERMS_GLOSSARY.md` — canonical
  definitions of `cohort()`, anchor day, `a`, `x`, `y`, and the `A -> X`
  meaning of `anchor_median_lag_days`
- `docs/current/project-bayes/29-generalised-forecast-engine-design.md`
  and `29c-phase-a-design.md` — the subject-kernel and `x_provider`
  design lineage
- `docs/current/project-bayes/29b-span-kernel-operator-algebra.md` — the
  regime-cover and block-admissibility rules that explain when a fitted
  object can act as a reusable subject block
- `docs/current/project-bayes/59-cohort-window-forecast-implementation-scheme.md`
  — target implementation contract derived from this semantic note;
  defines the naturally degenerating runtime template, the object-level
  prior/evidence rules, and the flagged direct-`cohort()`-for-`p`
  conditioning path
- `docs/current/project-bayes/47-multi-hop-cohort-window-divergence.md` —
  why multi-hop `cohort()` subject construction must still respect
  `window()`-rooted `X -> end` subject semantics
- `docs/current/project-bayes/51-model-curve-overlay-divergence.md` and
  `52-b3-spike-workplan.md` — the open architectural question about
  mature cohort latency in frontier forecasting
- `graph-editor/lib/runner/forecast_state.py`,
  `graph-editor/lib/runner/cohort_forecast_v3.py`, and
  `graph-editor/lib/runner/span_kernel.py` — current Python
  implementation surfaces that consume these semantics

## Core notation

### Query shapes

- **Window single-hop** means `window(X-Y)`
- **Window multi-hop** means `window(X-Z)`, where the path from `X` to
  `Z` contains more than one edge
- **Single-hop** means the subject span is `X -> Y`
- **Multi-hop** means the subject span is `X -> Z`, where the path from
  `X` to `Z` contains more than one edge

This note uses "single-hop" and "multi-hop" only for the **subject
span**, not for the full anchor path. A query `cohort(A, X-Y)` is
single-hop even if `A != X`. A query `cohort(A, X-Z)` is multi-hop
because the subject span is `X -> Z`.

### Mode truth

- In `window()` mode, the selected population is rooted at `X`, so
  denominator mass is present at `X` at `tau = 0`
- In `cohort()` mode, the selected population is rooted at `A`, so
  denominator mass at `X` may still be maturing through an upstream
  carrier `A -> X`

This is why `window()` has no genuine Pop C term, while `cohort()` can.

### Rate semantics

The displayed rate is always:

- `Y_Y(tau) / X_X(tau)` in the single-hop case
- `Y_Z(tau) / X_X(tau)` in the multi-hop case

The denominator is therefore always about **arrival at `X`**. The
numerator is always about **arrival at the subject end**.

`cohort()` changes the population being tracked. It does **not** change
the displayed rate into a path rate `y/a`.

### Frontier and population split

For one cohort at one frontier age:

- the **observed prefix** is what is already known at or before the
  frontier
- **Pop D** are people already in the denominator at the frontier but not
  yet in the numerator
- **Pop C** are people not yet in the denominator at the frontier who may
  still arrive later

In `window()` mode, Pop C is empty by definition because later arrivals to
`X` belong to later windows, not to the selected cohort.

This `C/D` split is only valid when the future numerator is represented
in **factorised** form. It is not valid when the future numerator is a
single gross fitted object.

## First principles

For any path-rate query, the two questions are:

- **Denominator question**: who has reached `X` by age `tau`?
- **Numerator question**: who has reached the subject end by age `tau`?

Those are different clocks.

In `cohort()` mode, the denominator side is an upstream carrier problem.
It is about the anchor cohort reaching `X`.

The numerator side is a subject-progression problem. It is about mass at
`X` progressing through the subject span to the query end.

Because of that split:

- the denominator side is naturally described by a carrier `A -> X`
- the numerator side is naturally described by a subject kernel
  `K_{X -> end}`

In `window()` mode, the carrier collapses to an impulse at `X`, so the
denominator is fixed and only the subject kernel remains dynamic.

The key semantic rule is:

- **do not** let the denominator side quietly consume subject-end
  semantics
- **do not** let the numerator side quietly consume anchor-to-`X`
  semantics except through the carrier

## Two representation families

### 1. Factorised representation

The future state is decomposed into:

- an upstream carrier to `X`
- a subject kernel from `X` to the subject end

In this representation:

- Pop D and Pop C are explicit future sub-populations
- Pop D and Pop C are legitimate additive terms in the **future**
  numerator
- the denominator side and numerator side are computed separately and
  then combined into `Y / X`

This is the conceptual shape behind `x_provider` plus
`span_kernel K_{X -> end}`.

### 2. Gross fitted numerator representation

The future numerator is modelled as one fitted object such as
`C[A | X -> end]`.

In this representation:

- the gross fitted object already contains all future numerator mass for
  the cohort
- Pop D and Pop C remain useful explanatory populations
- but Pop D and Pop C are **not** separately additive numerator terms

External cohort slices are usually closest to this representation. They
answer one already-defined numerator question for one already-defined
population. They are not automatically reusable as separate carrier and
subject primitives.

The semantic prohibition is:

- if a gross fitted numerator is the source of truth, **do not add Pop D
  and Pop C numerator terms on top of it**

Doing so double-counts future numerator mass that the fitted subject
object has already included.

## Window semantics: `window(X-Y)`

### Denominator side

| Population or piece | Denominator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_x` / `x_frozen`; semantically this is the fixed `X`-rooted window cohort | none | none; already realised |
| Pop D | No new denominator term. These people are already inside the fixed `X` cohort | not applicable | not applicable |
| Pop C | None. Later arrivals to `X` are outside the selected `window()` cohort | not applicable | not applicable |

### Numerator side in factorised form

| Population or piece | Numerator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_y` / `y_frozen` | none | none; already realised |
| Pop D | Future conversions of window members already at `X` but not yet at `Y` | subject-span `p_{X -> Y}` | residual `X -> Y`, conditioned on not having converted by the frontier |
| Pop C | None in window mode | not applicable | not applicable |

### Numerator side in gross fitted form

If the future numerator is represented by one fitted `X -> Y` object,
that object already contains all future `y` mass for the fixed
`X`-anchored window cohort. There is no Pop C term, and Pop D must not be
added on top of the fitted numerator.

## Window semantics: `window(X-Z)`

The denominator is unchanged from the single-hop `window()` case. The
only change is the subject span: the numerator now asks about `X -> Z`,
not "the last edge into `Z`".

### Denominator side

| Population or piece | Denominator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_x` / `x_frozen`; semantically this is the fixed `X`-rooted window cohort | none | none; already realised |
| Pop D | No new denominator term. These people are already inside the fixed `X` cohort | not applicable | not applicable |
| Pop C | None. Later arrivals to `X` are outside the selected `window()` cohort | not applicable | not applicable |

### Numerator side in factorised form

| Population or piece | Numerator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_y` / `y_frozen` at the subject end `Z` | none | none; already realised |
| Pop D | Future conversions of window members already at `X` but not yet at `Z` | subject-span `p_{X -> Z}` | residual `X -> Z`, conditioned on not having reached `Z` by the frontier |
| Pop C | None in window mode | not applicable | not applicable |

### Numerator side in gross fitted form

If the future numerator is represented by one fitted `X -> Z` object,
that object already contains all future `z` mass for the fixed
`X`-anchored window cohort. There is no Pop C term, and Pop D must not be
added on top of the fitted numerator.

### Cohort identity case: `A = X`

When the anchor equals the denominator node, the selected population is
already rooted at `X`.

That means:

- `carrier_to_x` collapses to the identity
- there is no separate upstream carrier solve beyond `X`
- denominator-side Pop C growth vanishes
- only the subject-side `X -> end` progression remains dynamic

This identity case applies to both `cohort(A, X-Y)` and `cohort(A, X-Z)`.
Changing single-hop to multi-hop changes the subject span, not the
denominator-side identity.

## Cohort semantics: `cohort(A, X-Y)`

### Denominator side

| Population or piece | Denominator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_x` / `x_frozen` | none | none; already realised |
| Pop D | No new denominator term. These people are already inside `x_frozen` | not applicable | not applicable |
| Pop C | Future arrivals to `X` after the frontier, only when `A != X` | upstream carrier mass, not subject `p` | `A -> X` |
| Special case `A = X` | Denominator is the anchor population itself; there is no upstream carrier solve beyond `X` | not applicable | `A -> X` collapses to zero |

### Numerator side in factorised form

| Population or piece | Numerator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_y` / `y_frozen` | none | none; already realised |
| Pop D | Future conversions of frontier survivors already at `X` | subject-span `p_{X -> Y}` | residual `X -> Y`, conditioned on not having converted by the frontier |
| Pop C | Future arrivals to `X`, then progression through the subject span | subject-span `p_{X -> Y}` | `X -> Y` from each arrival time |

### Numerator side in gross fitted form

If the future numerator is represented by one fitted object
`C[A | X -> Y]`, then:

- Pop D is **not** a separate additive numerator term
- Pop C is **not** a separate additive numerator term

That fitted numerator already contains all future `y` mass for the
cohort under the chosen model. Reintroducing Pop C or Pop D as separate
future numerator terms double-counts.

## Cohort semantics: `cohort(A, X-Z)`

The only change from the single-hop case is the subject span. The
denominator is still at `X`. The numerator is now at `Z`. The subject
clock is therefore `X -> Z`, not "the last edge".

### Denominator side

| Population or piece | Denominator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_x` / `x_frozen` | none | none; already realised |
| Pop D | No new denominator term. These people are already inside `x_frozen` | not applicable | not applicable |
| Pop C | Future arrivals to `X` after the frontier, only when `A != X` | upstream carrier mass, not subject-span `p` | `A -> X` |
| Special case `A = X` | Denominator is the anchor population itself; there is no upstream carrier solve beyond `X` | not applicable | `A -> X` collapses to zero |

### Numerator side in factorised form

| Population or piece | Numerator calculation | `p` semantics | latency semantics |
|---|---|---|---|
| Observed prefix | Use observed `obs_y` / `y_frozen` at the subject end `Z` | none | none; already realised |
| Pop D | Future conversions of frontier survivors already at `X` but not yet at `Z` | subject-span `p_{X -> Z}` | residual `X -> Z`, conditioned on not having reached `Z` by the frontier |
| Pop C | Future arrivals to `X`, then progression through the subject span | subject-span `p_{X -> Z}` | `X -> Z` from each arrival time |

### Numerator side in gross fitted form

If the future numerator is represented by one fitted object
`C[A | X -> Z]`, then:

- Pop D is **not** a separate additive numerator term
- Pop C is **not** a separate additive numerator term

The same double-counting rule applies as in the single-hop case.

## Admissibility of gross-fitted evidence and model vars

### Start with the semantic question, not the storage shape

A gross-fitted object can be used in two very different ways:

1. as the **whole-query numerator** for the exact request
2. as a **subject-side helper** inside a factorised solve, where it
   supplies only `K_{X -> end}` and the carrier to `X` is handled
   separately

Those two uses have different admissibility rules.

### Whole-query admission rule

Observed rows or fitted values from a gross-fitted numerator are directly
admissible as the live numerator for another request only if they answer
the **same semantic question**:

- same mode (`window()` versus `cohort()`)
- same time origin / anchor population
- same denominator node `X`
- same subject end and full subject span
- same slice, context, and `asat()`
- same selected set of Cohorts
- same temporal evidence basis / axis
- same weighting or aggregation procedure

If any of those differ, the fetched object is a different numerator
question and must not be spliced in as whole-query evidence or whole-query
model vars.

Here "same selected set of Cohorts, temporal evidence basis / axis, and
weighting or aggregation procedure" is load-bearing. It means the fetched
object was built from the same Cohort membership, on the same temporal
clock for the question being answered, and collapsed with the same
mass-weighting or aggregation rule. If any of those differ, the object is
not the same whole-query numerator.

### Subject-side reuse rule

Model vars from a gross-fitted object may sometimes be reused more
narrowly as a subject-side helper, but only if:

- the object is rooted at `X`
- it spans exactly the required subject `X -> end`
- its slice, context, and `asat()` metadata are compatible with the live
  request
- its temporal evidence basis is compatible with the helper role being
  played for `X -> end`
- it is being used only to answer the conditional progression question
  "given unit mass at `X` at age 0, when does it reach `end`?"
- the caller still supplies the desired carrier to `X` and the desired
  frontier conditioning for the actual request

When those conditions hold, the reusable part is the subject-side
`p`/latency behaviour. The gross numerator amplitude is **not** reusable
across anchors.

These compatibility checks are admissibility gates, not afterthoughts.
Wrong slice, wrong context, wrong `asat()`, or wrong temporal evidence
basis means the helper is not admissible even if it is rooted at `X` and
spans the right nodes.

### Why raw evidence is stricter than subject-side model vars

Raw rows from `cohort(X, X-Y)` are indexed by age since entry to `X`.
Rows from `cohort(A, X-Y)` are indexed by age since entry to `A`.

Even when the downstream subject span matches, those observed curves are
on different clocks until the `A -> X` carrier has been applied.

Therefore:

- for an exact semantic match, both rows and model vars may be used
- for a different overall anchor with the same `X -> end` subject,
  subject-side model vars may be reusable, but raw rows are **not**
  directly reusable as whole-query evidence

### Allowed / forbidden matrix

Use `E` below to mean the subject end, so the same rule covers
single-hop `X -> Y` and multi-hop `X -> Z`.

| Fetched object | Needed forecast | Raw evidence rows admissible? | Whole-query model vars admissible? | Subject-side model vars admissible? | Why |
|---|---|---|---|---|---|
| exact same semantic question: same mode, same anchor / time origin, same `X`, same full subject span `X -> E`, same slice / context / `asat()`, same selected Cohorts, same temporal evidence basis, same weighting / aggregation procedure | same query | **Allowed** | **Allowed** | allowed but redundant | This is the same numerator question, so no semantic translation is needed |
| `window(X -> E)` | `cohort(A, X -> E)` | **Forbidden** | **Forbidden** | **Allowed if compatible** | `window()` is already `X`-rooted, so it can supply `K_{X -> E}`; but only if slice / context / `asat()` and the subject-side evidence basis are admissible for that helper role |
| `cohort(X, X -> E)` | `cohort(A, X -> E)` | **Forbidden** | **Forbidden** | **Allowed if compatible** | Same rule in cohort form: usable only as an `X`-rooted subject helper, with the normal metadata admissibility gates |
| `cohort(B, X -> E)` where `B != A` and `B != X` | `cohort(A, X -> E)` | **Forbidden** | **Forbidden** | **Forbidden** | The fetched object still entangles a different pre-`X` carrier. It is neither the same whole-query numerator nor an `X`-rooted helper |
| any fetched object with different denominator node `X` | any target query | **Forbidden** | **Forbidden** | **Forbidden** | Wrong subject start means a different denominator question and a different conditional-progression question |
| any fetched object with different end node or different full subject span | any target query | **Forbidden** | **Forbidden** | **Forbidden** | `X -> Y` cannot answer `X -> Z`, and one sub-span cannot stand in for another without a separate fit or composition step |

All reuse cases not explicitly marked **Allowed** above should be treated
as forbidden.

### Why `window()` is simpler

`window()` is already rooted at `X`, so there is no separate upstream
anchor to disentangle from the subject solve.

That removes the two anchor-mismatch cases above. For `window()`, the
remaining admissibility test is essentially exact subject-question
alignment: same `X`, same end node, same mode, and compatible
slice/context/`asat()`. This is why `window()` blocks are the default
reusable subject-side ingredients for multi-hop solves, subject to the
same admissibility gates.

## General abstraction points

The semantics above suggest a small set of reusable implementation
objects:

1. `population_root` — defines who the selected population is and what
   the time origin means
2. `carrier_to_x` — denominator-side object that maps the selected
   population into arrivals at `X`
3. `subject_span` — numerator-side object that answers the conditional
   progression question `X -> end`
4. `numerator_representation` — either factorised (`carrier_to_x` +
   `subject_span`) or one gross fitted whole-query numerator
5. `admission_policy` — the allowed/forbidden matrix that decides
   whether an external fitted object can be used as the whole-query
   numerator, as a subject-side helper, or not at all

These objects are more stable than today's mode-specific branches because
the main query families differ mostly by how these objects degenerate:

- `window()` sets `population_root = X`, so `carrier_to_x` collapses to
  the identity
- single-hop sets `subject_span = X -> Y`, so the subject object
  collapses to one edge
- multi-hop keeps the same template but uses a full `X -> Z` subject span
- exact-match gross numerators replace the factorised future numerator
  only when admitted by the matrix

This is the main reason to keep the abstractions explicit: it encourages
one implementation pattern with natural degeneracies instead of many
separate forks.

## Practical consequences for `p` in cohort mode

The denominator side does not have its own independent subject-rate
posterior. It is governed by carrier mass reaching `X`.

The numerator side is where subject probability enters:

- in single-hop, the subject probability is the edge probability for
  `X -> Y`
- in multi-hop, the subject probability is the span probability for
  `X -> Z`

This matters because a multi-hop `cohort(A, X-Z)` subject is **not**
semantically equivalent to "the last edge into `Z`". Replacing
subject-span `p_{X -> Z}` with a last-edge probability changes the
meaning of the numerator.

## Practical consequences for latency in cohort mode

The denominator clock is the carrier clock `A -> X`.

The numerator clock is the subject-span clock:

- single-hop: `X -> Y`
- multi-hop: `X -> Z`

This has two important consequences.

First, it is correct for the denominator side and numerator side to use
different latencies. They are answering different questions.

Second, multi-hop subject semantics are violated if the implementation
silently replaces `X -> Z` with a last-edge clock into `Z`. That
substitution is only valid when the subject span is literally one edge.

## Implementation guidance for maintainers

### The semantic split is not "path versus edge" in the abstract

The clearer mental model is three roles:

1. `carrier_to_x` — denominator-side object, answering `A -> X`
2. `subject_span` — numerator-side object, answering `X -> end`
3. `target_edge` — literal edge-local helper, only when a consumer truly
   needs the terminal edge rather than the full subject span

This is more precise than a generic `resolved_path` versus
`resolved_edge` split. A path/edge scope distinction may still be useful
inside an implementation, but it should not replace the higher-level
carrier-versus-subject distinction.

### Template for a naturally degenerating implementation

The implementation pattern implied by this note is:

1. Resolve the request into `population_root`, denominator node `X`,
   subject end, full subject span, frontier, and scope metadata.
2. Build `carrier_to_x` from the request semantics.
   In `window()` or any case where `population_root = X`, this should
   degenerate to the identity carrier rather than a separate branch.
3. Build `subject_span` for the exact `X -> end` question.
   In single-hop this degenerates to one edge; in multi-hop it remains a
   full span kernel.
4. Run `admission_policy` on any reusable external fitted object.
   The policy should yield one of three outcomes:
   whole-query numerator allowed, subject-side helper allowed, or
   rejected.
5. Choose `numerator_representation`.
   Default to factorised form; only use a gross fitted whole-query
   numerator when the admission policy says the external object is the
   same semantic question.
6. Enforce the double-counting rule from the chosen representation.
   If the numerator is factorised, Pop C and Pop D may remain additive
   future terms. If the numerator is gross fitted, Pop C and Pop D become
   explanatory only.
7. Let rows, scalars, overlays, and downstream consumers read from this
   single solve rather than rebuilding mode-specific variants.

If followed carefully, this template should let the implementation
degenerate naturally across:

- `window()` versus `cohort()`
- single-hop versus multi-hop
- `A = X` versus `A != X`
- factorised versus exact-match gross-fitted numerators

### Mapping to the current Python surfaces

- in `window()` mode, `x_provider` should collapse to the fixed `X`
  cohort and Pop C should vanish
- `x_provider` and `from_node_arrival` are denominator-side objects
- `span_kernel` is the subject-side progression object
- `PreparedForecastRuntimeBundle.p_conditioning_evidence` is the explicit
  internal name for the rate-conditioning seam; it should describe which
  evidence family is allowed to move `p`, not silently retarget the carrier
  or the subject span
- the current live WP8 landing marks that seam with
  `direct_cohort_enabled` only for exact single-hop `cohort(A, X-Y)`
  subjects; `window()` and multi-hop `cohort(A, X-Z)` leave the flag off
- the `Pop C / Pop D` split in `forecast_state.py` only makes semantic
  sense if the future numerator is still factorised
- if a future implementation promotes a gross fitted subject numerator,
  that implementation must stop adding separate Pop C and Pop D
  numerator terms

That current flagging rule is intentionally narrow. It names the direct
single-hop `cohort()` rate-conditioning seam, but it does **not** by itself
authorise a gross fitted numerator, rewrite `carrier_to_x`, or replace the
full `X -> end` subject-span semantics for multi-hop queries.

### What this means for multi-hop correctness

For multi-hop `cohort(A, X-Z)`:

- denominator growth remains an `A -> X` problem
- numerator progression is an `X -> Z` problem
- a literal last-edge clock is a helper at most, not the defining
  subject semantics

Any implementation that treats multi-hop Pop D or Pop C as a pure
last-edge timing problem is changing the meaning of the subject.

## What this note does not decide

This note does **not** decide:

- whether mature cohort path-level latents should feed the live frontier
  forecast stack
- whether B3 structural correction should replace or refine today's
  composition strategy
- whether the current implementation already satisfies these semantics in
  every code path

Those are separate architectural and forensic questions.

This note defines the semantic contract that those decisions must
preserve.
