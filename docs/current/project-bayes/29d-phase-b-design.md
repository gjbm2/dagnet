# Phase B — Multi-Hop Cohort Maturity: Upstream Provider and Frontier Exposure

**Date**: 9-Apr-26  
**Status**: Design + implementation plan  
**Depends on**: Phase A in `29c-phase-a-design.md` must exist and be
parity-proven first  
**Companion docs**:
- `29-generalised-forecast-engine-design.md`
- `29b-span-kernel-operator-algebra.md`
- `29c-phase-a-design.md`

---

## Purpose

Phase B upgrades the upstream denominator path behind `x_provider`.

It does two things:

- replaces the preserved Phase A denominator behaviour with an explicit
  upstream-provider policy
- replaces the conservative frontier update with completeness-adjusted
  exposure

It does **not** reopen the subject kernel. Phase A's `x→y` solve remains
the numerator engine.

This doc is authoritative for Phase B scope, implementation sequencing,
and acceptance gates.

---

## What Phase B Changes

- Introduces an explicit upstream-provider resolution order
- Adds evidence-driven upstream propagation when the required evidence
  exists
- Retains a model-based fallback when that evidence does not exist
- Replaces the frontier's raw `x_obs - y_obs` exposure with a
  completeness-adjusted exposure term

## What Phase B Does Not Change

- No redesign of the subject-side span kernel from Phase A
- No redesign of composed span evidence for the `x→y` subject
- No change to the row-builder architecture established in Phase A
- No change to the broader forecast-engine contract work from doc 29

Phase B changes the upstream provider and the frontier update, not the
overall shape of the Phase A pipeline.

---

## The Upstream Problem Is Asymmetric

Doc `29b` makes the key asymmetry explicit:

- the subject side is a true operator-cover problem
- the upstream side is thinner and decomposes into two sub-problems:
  latency carrier and mass policy

That asymmetry must survive into implementation.

Phase B must therefore avoid turning upstream into a second copy of the
subject planner by default. The right structure is:

1. choose an upstream latency carrier
2. choose an upstream mass policy
3. feed the resulting `x_provider` into the Phase A row builder

---

## Phase A Baseline That Phase B Replaces

Phase A extracted the denominator behind `x_provider` but intentionally
preserved the current code's upstream behaviour.

That baseline is already good enough in three cases:

- `x = a`
- all `window()` subjects
- `cohort()` subjects where `x` is already mostly mature by the frontier

It becomes inadequate when:

- `x` is deep in the funnel
- the upstream latency is large relative to the frontier age
- the upstream DAG contains materially different arrival routes
- the subject frontier is young enough that much of the upstream mass is
  still in transit

Phase B only exists for those harder `cohort(), x != a` cases.

---

## Upstream Latency Carrier

The upstream latency carrier answers one question:

- what is the temporal shape of arrivals at `x` from the anchor cohort

Phase B keeps the resolution order from doc `29b`.

### Resolution Order

1. If `x = a`, there is no upstream latency problem. `X_x` is just
   `a_pop`.
2. If `x != a` and aligned ingress information into `x` is available,
   use that first. Those ingress objects already carry `a→x` timing.
3. If `x` has fan-in, combine compatible ingress carriers coherently.
   The current-code reference shape is a probability-weighted mixture of
   ingress timing carriers.
4. Only if the ingress carrier is missing or incompatible should Phase B
   recurse further upstream and compose edge by edge.

This keeps upstream latency thinner than the subject-side planner in the
common case.

### Practical Interpretation

Today the most natural ingress carrier is the cohort-mode path
information attached to edges entering `x`. When it exists and is
compatible with the query's slice, context, and as-at constraints, it is
the preferred Phase B latency carrier.

Recursive upstream composition is the fallback, not the default. If it
is used, it must obey the same regime-boundary, metadata-compatibility,
and leakage rules described in doc `29b`.

---

## Upstream Mass Policy

The upstream mass policy answers a different question:

- how much mass has arrived at `x` by age `τ`

Phase B retains the two-policy framing from doc `29b`.

### Policy A: Model-Based Continuation

Policy A is the current model-based upstream continuation preserved by
Phase A. Conceptually it combines:

- a scalar reach term
- an upstream latency carrier
- post-frontier incremental arrivals

It is cheap, always available, and already compatible with the current
row builder. It must remain as the permanent fallback path, and the
fallback implementation must be the exact Phase A provider semantics
rather than a newly invented approximation.

### Policy B: Evidence-Driven Upstream Propagation

Policy B reconstructs arrivals at `x` from upstream evidence where the
required evidence actually exists.

This is the real Phase B upgrade:

- observed upstream history becomes data-driven rather than compressed
  into one reach term
- joins are handled by summing compatible upstream contributions
- leakage is learned from the evidence already attached to the upstream
  edges rather than only from modelled asymptotic probabilities

### Resolution Order

Phase B chooses between the two policies as follows:

1. `x = a`: no upstream problem; return `a_pop`
2. `x != a` with full upstream evidence coverage: use Policy B
3. `x != a` with partial or missing upstream evidence: use Policy A for
   the entire upstream regime

The important rule is all-or-nothing per regime. Phase B must not mix a
partly evidence-driven upstream solve with a partly model-driven solve
inside one unresolved seam, because that creates accounting ambiguity at
joins and frontier boundaries.

---

## Policy B: Observed Upstream Reconstruction

Policy B reconstructs upstream arrivals over the actual upstream subgraph
`G_up = closure(a→x)`.

### Authoritative Observed State

The authoritative node-arrival quantity at a non-anchor node is the mass
that reaches that node through incoming upstream edges. In practical
terms:

- at the anchor node, arrivals are the anchor population
- at downstream upstream nodes, arrivals are reconstructed from
  compatible incoming-edge evidence
- at joins, contributions from all compatible upstream branches are
  summed

This keeps the upstream provider in node-arrival coordinates rather than
in edge-local proxy coordinates.

### Evidence Completeness Gate

Policy B may only run when the upstream evidence coverage is genuinely
complete for the requested regime:

- every edge needed to carry arrivals through `G_up` has compatible
  cohort evidence
- the evidence covers the relevant tau window for the subject analysis
- the metadata across the chosen upstream plan is compatible

If any of those checks fail, Phase B must fall back to Policy A rather
than attempting a partial reconstruction.

### Forecast Beyond the Observed Upstream Frontier

Policy B improves the observed upstream reconstruction first. Beyond the
observed upstream frontier it should continue with the model, but now
from a better frontier state.

That continuation should be framed as:

- observed upstream history comes from recursive evidence propagation
- post-frontier continuation uses the upstream latency carrier and model
  continuation, seeded from the reconstructed frontier state rather than
  from a blank initial condition

This keeps Phase B incremental. It improves the provider without turning
upstream into a second independent forecasting subsystem with different
rules.

---

## Completeness-Adjusted Frontier Exposure

Phase A keeps the current conservative frontier update, which treats all
mass that has reached `x` but not yet `y` as if it were already fully
exposed to the subject conversion opportunity.

That is acceptable for parity, but it is biased for genuine multi-hop
subjects because some of that mass is still in transit through the
subject span.

Phase B fixes this by replacing raw frontier exposure with effective
exposure:

- start from arrival increments at `x`
- weight those increments by how much of the subject kernel had time to
  mature by the frontier
- update the posterior using exposed mass rather than raw mass at `x`

In words:

- `α_post` still adds observed successes at `y`
- `β_post` adds only the portion of `x` arrivals that had time to reach
  `y`, minus the observed successes

This is the substantive row-builder change in Phase B. It does not
change the row-builder structure, but it does change the frontier maths.

### Behavioural Expectations

- when there is no meaningful in-transit subject mass, Phase B should
  collapse back toward the Phase A result
- when there is substantial in-transit subject mass, Phase B should be
  less conservative than Phase A
- the change should be largest on wide or slow multi-hop subjects, not
  on adjacent pairs

---

## Implementation Plan

Provider policy resolution:

- implement the upstream policy selector in
  `graph-editor/lib/runner/cohort_forecast.py` or a dedicated upstream
  provider helper under `graph-editor/lib/runner/`
- keep Policy A available as the baseline fallback path

Evidence completeness:

- add an upstream evidence-completeness checker that evaluates whether
  the chosen upstream regime has compatible evidence across the required
  tau window
- place the checker close to the provider selection logic so policy
  choice and evidence validation stay coupled

Observed upstream reconstruction:

- add a reusable upstream reconstruction helper under
  `graph-editor/lib/runner/` that walks the upstream regime in
  topological order and produces node-arrival histories
- keep the reconstruction in node-arrival terms so it can feed
  `x_provider` directly

Latency carrier resolution:

- implement the ingress-first carrier selection rule inside the upstream
  provider path
- only invoke recursive upstream composition when the ingress carrier is
  unavailable or incompatible

Frontier update:

- modify `graph-editor/lib/runner/cohort_forecast.py` so the frontier
  update consumes effective exposure instead of raw `x_obs`
- keep the surrounding D/C split, fan generation, and clipping logic
  unchanged

Request and analysis plumbing:

- Phase B should land inside the Phase A `cohort_maturity_v2` path
  rather than introducing a third analysis type
- `graph-editor/lib/api_handlers.py` and the existing request plumbing
  should therefore change only to pass the improved provider outputs, not
  to change the public analysis contract

---

## Tests and Gates

Primary Python test homes:

- `graph-editor/lib/tests/test_cohort_forecast.py`
- `graph-editor/lib/tests/test_cohort_maturity_derivation.py`
- `graph-editor/lib/tests/test_cohort_fan_controlled.py`
- `graph-editor/lib/tests/test_cohort_fan_harness.py`
- `graph-editor/lib/tests/test_bayes_cohort_maturity_wiring.py`

Primary TypeScript and CLI touchpoints:

- `graph-editor/src/cli/__tests__/cliAnalyse.test.ts`
- `graph-editor/src/lib/__tests__/graphComputeClient.test.ts`
- `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`

Required Phase B gates:

- `x = a` remains unchanged relative to Phase A
- complete-evidence upstream cases reconstruct arrivals at `x`
  correctly from upstream evidence
- incomplete-evidence cases fall back cleanly to Policy A without
  partial-regime mixing
- completeness-adjusted frontier exposure is equal to Phase A when no
  in-transit subject mass exists and less conservative when it does
- subject-kernel outputs remain unchanged for the same subject inputs;
  Phase B improves the provider and frontier update, not the subject
  planner
- end-to-end charts remain stable on adjacent pairs and improve only on
  the intended multi-hop cohort cases

---

## Deferred Work Beyond Core Phase B

The following ideas remain explicitly out of scope for the core Phase B
implementation:

- method-of-moments prior composition for span-level rate uncertainty
- per-draw reconvolution of the subject kernel for fuller span
  uncertainty
- commissioning a richer library of subject-side cohort macro-blocks
- broader forecast-engine contract work from doc `29`

These are valid future improvements, but they are not required to make
the Phase B denominator story coherent.

---

## Relationship to the Broader Forecast Engine

After Phase B, multi-hop cohort maturity has:

- a reusable subject kernel from Phase A
- an explicit upstream provider with evidence-driven improvement and
  model-based fallback
- a frontier update that better respects in-transit subject mass

That is enough to make cohort maturity a credible first consumer of the
broader forecast-engine architecture from doc `29`.

The later engine work still needs to generalise these building blocks
for other consumers, but Phase B completes the cohort-maturity-specific
story first.
