# 66 — Shared CF Runtime and WP8 Admission Plan

**Date**: 23-Apr-26  
**Status**: Active implementation plan  
**Audience**: engineers working on conditioned forecast, `cohort_maturity`, and Daily Conversions  
**Relates to**: `../codebase/COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md`, `59-cohort-window-forecast-implementation-scheme.md`, `60-forecast-adaptation-programme.md`, `62-direct-cohort-rate-conditioning-flag.md`, `57-cf-eligibility-topological-degradation.md`, `65-gm-rebuild-window-vs-cohort-cli-investigation.md`

## 1. Purpose

This note records the implementation plan for bringing the live forecast
stack into tighter alignment with the semantic contract in
`COHORT_ANALYSIS_NUMERATOR_DENOMINATOR_SEMANTICS.md` and the structural
programme in `60-forecast-adaptation-programme.md`.

The immediate goal is not to reopen the semantics. The semantics are
already set. The problem is that the live implementation still contains
semantic drift, consumer-local forks, and a partially structuralised
WP8 landing.

This plan therefore does two jobs:

- define the structural contract that must be made true across BE
  conditioned forecast, `cohort_maturity`, and Daily Conversions
- define the disciplined admission policy for WP8 so that direct
  `cohort()` slice data can influence the numerator-side rate update
  without becoming a second structural runtime

## 2. Binding contract

The following points are treated as binding inputs from docs 59 and 60.

First, the runtime must remain factorised.

- denominator side: `carrier_to_x`
- numerator side: `subject_span(X -> end)`

Second, single-hop is not a separate semantic system.

- single-hop `cohort(A, X-Y)` is the natural degeneration
  `A -> X` plus `X -> Y`
- multi-hop `cohort(A, X-Z)` is the natural degeneration
  `A -> X` plus full `X -> Z`

Third, the three live forecast consumers in scope here are meant to be
three projections of one solve:

- BE conditioned forecast
- `cohort_maturity`
- Daily Conversions

Fourth, WP8 is a rate-conditioning seam only.

It may change which evidence family is admitted to move the
numerator-side rate update. It must not rewrite carrier semantics,
latency semantics, subject-span semantics, or numerator representation.

## 3. Current implementation drift this plan must close

The live code still departs from that contract in several material ways.

### 3.1 Chart versus CF still resolve the same subject differently

The chart path and the BE conditioned-forecast path share a great deal
of preparation code already, but they still retain a caller-local split
in how the same cohort subject is resolved. That means the same semantic
question can still reach different resolved prior blocks or different
conditioning decisions depending on which consumer asked.

That is the wrong seam. Equivalent questions must share one resolved
runtime object graph before projection begins.

### 3.2 Daily Conversions still bypasses the shared preparation path

Daily Conversions still derives its own forecast annotation path from
`rate_by_cohort` and then calls the inner sweep directly. That bypasses
the shared preparation, shared runtime bundle, shared carrier
construction, and shared subject-span preparation used by CF and
`cohort_maturity`.

That makes Daily Conversions a separate forecast consumer in the bad
sense: not just a different projection, but a different effective solve.

### 3.3 WP8 is still too structural in practice

The live code does already carry explicit WP8 metadata on
`p_conditioning_evidence`, which is correct in principle. The problem is
that the implementation still behaves as though "exact single-hop
cohort" were itself a caller-facing semantic branch, rather than one
possible admission outcome inside a shared evidence-layer selector.

The first landing of WP8 was always meant to be narrow. Narrow admission
is correct. Structural branching is not.

### 3.4 The runtime bundle is not yet authoritative enough

The live runtime objects exist explicitly, which is progress, but some
of them still behave more like diagnostics than like authoritative solve
inputs. Where the bundle carries metadata that does not actually control
execution, the codebase still leaves room for hidden caller-local
behaviour to survive.

## 4. Structural versus evidence-layer split

This plan depends on a strict split between the structural runtime and
the evidence layer.

### 4.1 Structural runtime

The structural runtime is the shared solve skeleton. It includes:

- subject resolution
- `population_root`
- `carrier_to_x`
- `subject_span`
- numerator representation
- sweep-versus-degraded eligibility
- prepared operator inputs for the subject span
- per-cohort evaluation coordinate metadata

This layer must be identical for equivalent semantic questions across
all first-class consumers.

### 4.2 Evidence layer

The evidence layer decides which evidence family is allowed to move the
numerator-side rate update.

At minimum it must distinguish:

- the default factorised evidence path
- an optional admitted direct-`cohort()` rate-evidence path

The evidence layer may change the numerator-side rate update. It must
not change:

- `carrier_to_x`
- `subject_span`
- active latency semantics
- completeness semantics
- numerator representation
- the degrade-versus-sweep predicate from doc 57

### 4.3 Projection layer

Each consumer then reads a different coordinate from the same solved
runtime object graph.

- `cohort_maturity` reads per-`tau` trajectory rows
- BE conditioned forecast reads per-edge scalar outputs and graph-owned
  fields
- Daily Conversions reads per-cohort evaluation-date outputs

Projection differences are allowed. Semantic differences are not.

## 5. WP8 admission policy

WP8 must be implemented as a disciplined admission policy, not as a
boolean special case.

The first landing remains intentionally narrow, but the narrowness must
be expressed as explicit admission criteria and explicit deny reasons.

### 5.1 Admission criteria

Direct `cohort()` rate evidence should be admitted only when all of the
following are true.

- the query is in `cohort()` mode
- the subject is single-hop only
- the anchor matches exactly
- the denominator node `X` matches exactly
- the end node `Y` matches exactly
- the full subject span matches exactly
- slice and context match exactly
- the `asat()` frontier and evidence basis match exactly
- the selected Cohort set matches exactly
- admissible direct `cohort()` slice rows are actually available after
  regime selection
- the resolved rate prior is aggregate, so `alpha_beta_query_scoped` is
  false

If any one of those conditions fails, the runtime must fall back to the
default factorised evidence path.

### 5.2 Deny reasons

The admission policy should surface explicit deny reasons rather than
silently treating every non-admitted case as the same.

The useful first-set reasons are:

- not in `cohort()` mode
- subject is multi-hop
- anchor mismatch
- denominator/start-node mismatch
- end-node mismatch
- full subject-span mismatch
- slice or context mismatch
- `asat()` or evidence-basis mismatch
- no admissible direct `cohort()` rows after regime selection
- resolved posterior is already query-scoped

The deny reason is not only diagnostic. It is also a guard against
future silent widening of the admission set.

### 5.3 What admission is allowed to change

When the direct-`cohort()` path is admitted, the runtime may change only
the numerator-side rate-conditioning evidence.

This may change:

- the contents of `p_conditioning_evidence`
- the numerator-side rate update
- downstream rate-style outputs that depend on that update, such as
  `p_mean`, `projected_y`, `forecast_y`, and rate bands

### 5.4 What admission must never change

When the direct-`cohort()` path is admitted, the following must remain
unchanged.

- `population_root`
- `carrier_to_x`
- `subject_span`
- numerator representation
- latency source and latency semantics
- completeness semantics
- degrade-versus-sweep eligibility

If any of those change when WP8 is toggled between denied and admitted,
the implementation has leaked evidence policy into structure.

## 6. Guard pack

The work should proceed only with an explicit guard pack. The main tests
and harnesses for this plan are:

- `graph-editor/lib/tests/test_temporal_regime_separation.py`
- `graph-editor/lib/tests/test_cf_query_scoped_degradation.py`
- `graph-editor/lib/tests/test_forecast_state_cohort.py`
- `graph-editor/lib/tests/test_analysis_subject_resolution.py`
- `graph-editor/lib/tests/test_conditioned_forecast_response_contract.py`
- `graph-editor/src/services/__tests__/conditionedForecastCompleteness.test.ts`
- `graph-editor/lib/tests/test_v3_degeneracy_invariants.py`
- `graph-ops/scripts/conditioned-forecast-parity-test.sh`
- `graph-ops/scripts/multihop-evidence-parity-test.sh`
- `graph-ops/scripts/v3-degeneracy-invariants.sh`

One additional guard should be added before the Daily Conversions
migration is considered complete: a focused parity canary proving that
Daily Conversions reads the same underlying solve as CF and
`cohort_maturity` for an equivalent semantic question.

## 7. Staged delivery plan

### Stage 0 — Freeze the contract split and the guards

**Objective**

Freeze the implementation target before changing code.

**Primary files**

- this note
- `60-forecast-adaptation-programme.md`
- the guard-pack tests above, if they need classification or gap-filling

**Required changes**

- make the structural-versus-evidence split explicit in the docs and the
  harness map
- classify current reds as fix-now, intentional-red, or stale wording
- add the missing Daily Conversions parity canary

**Entry guard**

The team agrees that WP0-WP7 remain the binding structural target and
that WP8 is evidence-only.

**Stop rules**

- do not start code changes without a frozen guard pack
- do not proceed if no test or harness can prove that WP8 changes only
  the evidence layer

**Exit guard**

There is one agreed guard pack and one agreed structural-versus-evidence
invariant list.

### Stage 1 — Remove structuralised single-hop and WP8 forks

**Objective**

Remove any use of "exact single-hop cohort" as a structural branch while
preserving the existence of the evidence-layer seam itself.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`

**Required changes**

- replace boolean single-hop gating with an admission-policy result
  object
- remove any caller-local exact-subject branch that changes structure,
  resolved priors, or subject-span semantics
- keep only the neutral `p_conditioning_evidence` seam

**Entry guard**

Stage 0 completed.

**Stop rules**

- if removing one structural branch forces the creation of another
  structural branch elsewhere, stop and redesign
- do not let "single-hop cohort" survive as a semantic path of its own

**Exit guard**

Single-hop `cohort(A, X-Y)` is represented structurally only as
`A -> X` plus `X -> Y`.

### Stage 2 — Make one runtime builder authoritative

**Objective**

Create one authoritative prepared runtime builder that owns every
structural decision and the evidence-admission decision.

**Primary files**

- `graph-editor/lib/runner/forecast_preparation.py`
- `graph-editor/lib/runner/forecast_runtime.py`

**Required changes**

- centralise subject resolution
- centralise temporal evidence-family selection for preparation
- centralise `ResolvedModelParams`
- centralise prepared `subject_span` execution inputs, including the
  deterministic-versus-MC span-kernel setup
- centralise `carrier_to_x` and `x_provider`
- centralise any multi-hop last-edge helper CDF still required by the
  projection layer
- centralise degrade-versus-sweep eligibility
- centralise WP8 admission and evidence selection
- assemble one authoritative `PreparedForecastRuntimeBundle`
- extract the duplicated runtime-assembly block out of
  `_handle_cohort_maturity_v3` and the scoped path inside
  `handle_conditioned_forecast`

The immediate next implementation cut for v3-versus-CF unification is
that handler extraction. It is the narrowest change that removes the
remaining chart-versus-CF structural drift without yet reopening
whole-graph orchestration or Daily Conversions. The first cut should
therefore target `_handle_cohort_maturity_v3` and the scoped
`handle_conditioned_forecast` flow only.

**Entry guard**

Stage 1 removed the structuralised single-hop fork.

**Stop rules**

- do not allow handlers to keep their own resolved-prior logic
- do not allow callers to make independent admission decisions

**Exit guard**

For the same semantic question, the chart path and the CF path receive
the same prepared structural runtime and the same evidence-admission
decision.

In practical terms, both handlers should then do only four things:

- perform shared subject and frame preparation
- call the authoritative runtime builder
- call `compute_cohort_maturity_rows_v3`
- project the returned solve into consumer-specific outputs

### Stage 3 — Make the row builder projection-only

**Objective**

Reduce `cohort_forecast_v3` to projection logic over the authoritative
prepared inputs.

**Primary files**

- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/runner/forecast_state.py`

**Required changes**

- stop local re-resolution of priors inside the row builder
- stop local re-creation of runtime policy inside the row builder
- stop local caller-dependent WP8 logic inside the row builder
- stop assembling span-kernel inputs, `carrier_to_x`, `x_provider`, or
  helper CDFs inside the row builder
- keep only the projection from prepared solve inputs to row outputs

This stage should follow immediately after the Stage 2 extraction. Once
the builder owns the structural solve, any remaining local reconstruction
inside `cohort_forecast_v3` is still semantic drift rather than harmless
cleanup.

**Entry guard**

Stage 2 builder is complete enough to supply all structural and
evidence-layer inputs.

**Stop rules**

- if the row builder still decides temporal mode, resolved source, or
  admission outcome for itself, the stage is not done
- if bundle fields remain decorative rather than execution-controlling,
  either wire them through or delete them

**Exit guard**

`cohort_forecast_v3` can no longer alter semantic inputs. It can only
project from them.

### Stage 4 — Unify `cohort_maturity` and scoped CF

**Objective**

Make the chart path and scoped BE conditioned forecast consume the same
prepared solve.

**Primary files**

- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`

**Required changes**

- route `_handle_cohort_maturity_v3` through the shared builder
- route scoped `handle_conditioned_forecast` through the same builder
- remove any remaining chart-versus-CF split in resolved priors or
  evidence admission

**Entry guard**

Stage 3 completed.

**Stop rules**

- if equivalent scoped questions still produce different resolved
  sources, different degrade decisions, or different rate outputs,
  stop and fix that before moving on

**Exit guard**

Scoped chart and scoped CF differ only by projection.

### Stage 5 — Harden whole-graph CF without creating a second semantic system

**Objective**

Keep whole-graph CF as the authoritative graph writer while ensuring it
remains only an orchestration variant of the shared solve.

**Primary files**

- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/runner/forecast_runtime.py`

**Required changes**

- constrain whole-graph differences to topological order and donor reuse
- keep semantic resolution and evidence admission identical to the scoped
  path
- key donor caches by semantic identity rather than incidental edge
  ordering

**Entry guard**

Stage 4 proves scoped chart and scoped CF parity.

**Stop rules**

- if whole-graph correctness relies on a second semantic path, stop
- do not let donor reuse choose different priors or different evidence
  families from the scoped path

**Exit guard**

Equivalent single-edge reads from whole-graph CF match scoped CF.

### Stage 6 — Reintroduce WP8 correctly as a shared evidence overlay

**Objective**

Keep the shared structural solve fixed and layer WP8 back in through one
admission-governed evidence selector.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- any helper moved out of `api_handlers.py` or `cohort_forecast_v3.py`
  into the shared runtime layer

**Required changes**

- implement one shared admission evaluator with explicit deny reasons
- implement one shared evidence selector that chooses between the default
  factorised evidence path and admitted direct-`cohort()` rate evidence
- preserve doc 57 and doc 52 discipline when admission is granted

**Entry guard**

Stages 1 through 5 are green enough that the structural solve is already
shared.

**Stop rules**

- if enabling WP8 changes carrier semantics, latency semantics, or
  numerator representation, stop immediately
- if one consumer admits while another denies the same semantic query,
  stop immediately

**Exit guard**

WP8 changes only numerator-side rate evidence and downstream
rate-dependent outputs.

### Stage 7 — Move Daily Conversions onto the shared solve

**Objective**

Make Daily Conversions a coordinate-B projection of the shared solve
rather than a separate forecast path.

**Primary files**

- `graph-editor/lib/api_handlers.py`
- `graph-editor/lib/runner/daily_conversions_derivation.py`
- any helper needed for per-cohort evaluation output reuse

**Required changes**

- keep `derive_daily_conversions` as snapshot aggregation only
- remove the direct inner-kernel forecast path from the Daily
  Conversions handler
- read per-cohort evaluation outputs from the same solve used by chart
  and CF
- use the same WP8 admission result and same evidence selector there too

**Entry guard**

The shared solve already exposes the evaluation outputs Daily
Conversions needs.

**Stop rules**

- if Daily Conversions still imports or calls the inner kernel directly,
  the stage is not complete
- if Daily Conversions uses a consumer-local admission rule, the stage is
  not complete

**Exit guard**

Daily Conversions differs from CF and `cohort_maturity` only by
projection.

### Stage 8 — Remove dead scaffolding and align the docs

**Objective**

Finish the workstream by collapsing obsolete branches and making the docs
describe the live boundary accurately.

**Primary files**

- `graph-editor/lib/runner/forecast_runtime.py`
- `graph-editor/lib/runner/cohort_forecast_v3.py`
- `graph-editor/lib/api_handlers.py`
- `60-forecast-adaptation-programme.md`
- `62-direct-cohort-rate-conditioning-flag.md`
- this note

**Required changes**

- delete or collapse dead structural hooks from the earlier partial WP8
  landing
- keep only execution-controlling runtime metadata
- align the docs so WP8 is described as a shared evidence overlay, not a
  structural exception

**Entry guard**

All three forecast consumers already run on one shared solve.

**Stop rules**

- if the docs still need to describe two live semantic paths in order to
  stay truthful, cleanup is not complete

**Exit guard**

One preparation path, one runtime contract, one evidence-admission
policy, and one solve remain.

## 8. Permanent stop conditions

At any point in the programme, stop immediately if any of the following
becomes true.

- WP8 changes `carrier_to_x`
- WP8 changes `subject_span`
- WP8 changes active latency semantics or completeness semantics
- the same semantic query receives different admission outcomes in
  different consumers
- a caller reintroduces a direct call to the inner forecast kernel
  outside the shared solve path
- a stage weakens a parity or degeneracy guard instead of fixing the
  underlying drift

## 9. Final acceptance criteria

This plan should be considered delivered only when all of the following
are true.

1. single-hop and multi-hop both behave as natural degenerations of the
   same factorised runtime
2. `cohort_maturity`, scoped CF, whole-graph CF, and Daily Conversions
   all consume one shared solve
3. whole-graph CF remains the authoritative graph writer without
   becoming a separate semantic system
4. doc 57's degraded-path discipline still applies consistently across
   all consumers
5. WP8 changes only numerator-side rate-conditioning evidence and
   downstream rate outputs
6. no consumer-specific semantic fork remains
7. the docs describe the live structural-versus-evidence split
   accurately
