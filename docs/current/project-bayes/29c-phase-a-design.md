# Phase A — Multi-Hop Cohort Maturity: Subject Kernel and Sampler-Preserving Integration

**Date**: 9-Apr-26  
**Status**: Design + implementation plan  
**Depends on**: Docs 30 and 31 are implemented and are treated as
available infrastructure  
**Companion docs**:
- `29-generalised-forecast-engine-design.md`
- `29b-span-kernel-operator-algebra.md`
- `29d-phase-b-design.md`

---

## Purpose

Phase A fixes the conditional `x→y` progression for multi-hop cohort
maturity. It is the numerator phase.

The core rule is simple:

- Phase A fully solves the subject-side progression problem
- Phase A does **not** redesign upstream propagation
- Phase A extracts the upstream denominator behind a stable
  `x_provider` seam so Phase B can replace it later without reopening
  the subject maths

This doc is authoritative for Phase A scope, implementation sequencing,
and acceptance gates.

---

## What Phase A Changes

- Adds a backend subject-side span kernel for arbitrary `x→y` DAGs
- Composes multi-edge evidence into one span-level maturity frame set
- Extracts the upstream denominator behind an explicit `x_provider`
  interface
- Integrates the new kernel into the existing cohort-maturity row
  builder without changing the outer sampling discipline
- Ships as `cohort_maturity_v2` until parity with `cohort_maturity` is
  proven

## What Phase A Does Not Change

- No new upstream propagation engine
- No evidence-driven recursion over `a→x`
- No redesign of the shared forecast-state contract from doc 29
- No FE/BE basis-resolution unification work
- No chart-schema change beyond span-aware labelling

Those remain later work in Phase B or in the broader forecast-engine
programme.

---

## Core Model Split

Use the notation from doc 29:

- `a` = anchor node
- `x` = query start node and maturity denominator
- `y` = query end node and maturity numerator
- `u` = source node of the last edge into `y` in the legacy
  single-edge code

The maturity curve remains `rate(s, τ) = Y_y(s, τ) / X_x(s, τ)`.

Phase A treats this as two separate responsibilities:

- Subject progression: given mass at `x`, how does it reach `y` over
  time
- Upstream provision: how much mass is at `x` over time

Phase A fully solves the first responsibility and only extracts the
second behind a seam.

### Mode Truth

- `window()` mode: Phase A is the full fix because the denominator is
  fixed at observation time
- `cohort()` mode with `x = a`: Phase A is also the full fix because
  the denominator is just `a_pop`
- `cohort()` mode with `x != a`: Phase A is a numerator fix over
  preserved legacy denominator behaviour

---

## Live Operator Inventory and Subject Planning Rules

Phase A must be designed against the operator inventory that actually
exists today, not an ideal future inventory.

Available today:

- universal `window()` edge operators for every edge
- anchor-rooted cohort-mode path objects of the form `C[a | a→v]`

Not available today:

- arbitrary fitted sub-path macro-blocks inside the subject span

This has four consequences.

1. The subject side is the true operator-cover problem.
2. The default Phase A subject solve is edge-wise `window()`
   composition across the full `x→y` DAG.
3. An aligned cohort macro-block inside `x→y` is an optional shortcut,
   not expected inventory. Use it when it genuinely exists and is
   compatible; do not design Phase A around it.
4. The upstream side is not planned the same way in Phase A. It is
   provided by `x_provider`, not re-solved as a second copy of the
   subject planner.

Subject-planning rules inherited from doc `29b`:

- Reject blocks that cross the `x` boundary or otherwise overhang the
  target regime
- Reject metadata-mismatched plans; slice, context, and as-at
  compatibility are admissibility checks, not afterthoughts
- Treat leakage as internal to operator mass; no separate planner logic
  is needed
- Prefer high-quality macro-blocks when they improve mass quality, but
  remember that atomic edge composition may preserve branched temporal
  shape more faithfully

In practice, this means the common Phase A implementation path is:

- subject evidence composed from the real `x→y` span
- subject kernel built from atomic edge operators
- sampler preserved unchanged

with cohort macro-blocks used opportunistically rather than assumed.

---

## Evidence Composition

Phase A composes span-level evidence before any forecast maths.

Path structure is already backend-native through doc 31. Phase A reuses
that structure rather than inventing new frontend path resolution.

The composed evidence rules are:

- for `x = a`, the denominator carrier is the anchor population `a`
- for `x != a`, the denominator carrier is arrivals at `x`, taken from
  frames defined at `x`; when multiple x-adjacent frames disagree, use
  the most complete carrier rather than forcing a singular "first edge"
- the numerator carrier is arrivals at `y`, taken from the last edge or
  summed across y-incident edges when `y` has fan-in
- composed frames align on cohort identity and snapshot date after the
  existing daily interpolation logic

This composition is exact for branching at `x`, fan-in at `y`, and all
intermediate subject structures. The approximation work begins only once
the forecast region starts.

Regime-coherence rule from doc 30:

- each edge still uses its own coherent regime selection
- the span composition does **not** require one forced cross-edge regime
  for the whole subject
- compatibility is enforced at the metadata level, not by demanding that
  every edge share one identical regime identity

---

## Subject Span Kernel

Phase A introduces a subject-side span kernel `K_{x→y}(τ)`.

Interpretation:

- `K_{x→y}(τ)` is the conditional probability that mass arriving at `x`
  at age zero has reached `y` by age `τ`
- it is a sub-probability CDF, not a density
- its asymptotic mass is the total conditional success probability of
  the subject span

Construction rules:

- each edge contributes a sub-probability latency object built from its
  probability and shifted-lognormal latency posterior
- serial composition is convolution
- parallel composition is summation
- computation uses forward dynamic programming in topological order
  across the reachable `x→y` DAG
- path enumeration is not allowed

Required behaviour:

- single hop must degenerate to the existing edge kernel
- branching and fan-in must be handled natively by the DP
- leakage must remain inside edge probabilities
- atomic `window()` edge composition is the common case and the
  reference path for correctness
- any subject-side cohort macro-block that is used must obey the same
  regime-boundary and metadata rules as the atomic plan

The implementation target is therefore a reusable subject-kernel helper,
not a chart-specific special case.

### Numerator convolution uses K (the CDF), not f (the density)

The numerator formula is:

```
Y_y(s, τ) = Σ_u ΔX_x(s, u) · K_{x→y}(τ − u)
```

`K_{x→y}(τ − u)` is the probability that an arrival at `x` at age `u`
has reached `y` by age `τ` — a **cumulative** quantity. The product
with `ΔX_x` gives the expected count of those arrivals that have
reached `y`. Summing over `u` gives cumulative arrivals at `y`, which
is what `Y_y` represents.

If the density `f` were used instead of the CDF `K`, the result would
be the instantaneous arrival rate at `y`, not the cumulative count.
This is the most likely implementation error in the subject kernel
integration.

In `window()` mode, `ΔX_x` is a delta at `τ = 0`, so the convolution
simplifies to `Y_y(s, τ) = X_x(s) · K_{x→y}(τ)`.

---

## Phase A `x_provider`

Phase A introduces an explicit `x_provider` interface, but it does not
redesign upstream maths.

### Contract

- `x_provider` returns cumulative arrivals at `x`
- it must never return arrivals at `u` or any other upstream seam
- the rest of Phase A is allowed to assume the provider is already in
  `x` coordinates

### Authority Rule

For `x != a`, `cohort_maturity_v2` must preserve the current upstream
denominator semantics from
`graph-editor/lib/runner/cohort_forecast.py`.

Phase A is not allowed to replace that legacy provider with a new
heuristic. Adjacent-pair parity with `cohort_maturity` is the
implementation gate that enforces this.

### Practical Cases

- when `x = a`, `x_provider` is just the anchor population for the
  cohort
- in `window()` mode, `x_provider` is the fixed observed count at `x`
- in `cohort()` mode with `x != a`, the observed region comes from
  composed evidence at `x`, and the forecast region preserves the
  current model-based continuation from the existing codebase

For Phase A design purposes, that preserved forecast-region provider can
be described as the current model-based upstream continuation built from:

- a scalar upstream reach term
- an upstream latency carrier
- post-frontier incremental arrivals

But the implementation obligation is stronger than that shorthand: v2
must extract and reuse the current code path rather than re-specifying a
simplified replacement.

### Upstream Latency in Phase A

Upstream latency in Phase A follows the asymmetry from doc `29b`:

- first prefer aligned cohort-mode ingress information into `x`
- if `x` has fan-in, combine those ingress carriers coherently
- only fall back to edge-wise upstream composition when the ingress
  carrier is missing or incompatible

This remains an implementation detail of the preserved provider in
Phase A, not a new planner of its own.

---

## New Operators, Same Sampler

Phase A keeps the current cohort-maturity forecasting discipline and
swaps only the inner ingredients.

The following behaviour must survive unchanged:

- observed region from evidence up to the frontier
- forecast region beyond the frontier
- D/C decomposition between frontier survivors and future arrivals
- conditional late-conversion sampling for the D population only
- continuous expected-mass treatment for the C population
- no Binomial noise on model-predicted future-arrival mass
- posterior-draw fan generation
- clipping, boundedness, and monotonicity discipline

Phase A row-building logic therefore becomes:

- consume composed evidence frames
- consume `x_provider`
- consume `K_{x→y}`
- preserve the existing observed/forecast splice
- preserve the existing D/C split
- replace the single-edge conditional progression with span-kernel
  progression
- keep the same fan-generation and clipping posture

The Phase A frontier update remains conservative:

- the prior still comes from the last edge's path-level cohort posterior
- the frontier still treats in-transit mass as if it were already fully
  exposed
- empty-evidence behaviour still falls back to unconditional forecast
- latency-shape uncertainty still reuses the last edge's path-level SDs

These are known approximations, not accidental drift. Phase B addresses
the frontier exposure issue. Wider span-level uncertainty propagation is
later work.

---

## Implementation Plan

Backend analysis registration:

- register `cohort_maturity_v2` through the existing backend analysis
  entry points in `graph-editor/lib/api_handlers.py`
- keep `cohort_maturity` untouched until parity gates pass

Evidence composition:

- implement a composed span-frame helper alongside the current
  cohort-maturity derivation path in
  `graph-editor/lib/runner/cohort_maturity_derivation.py` and the
  cohort-maturity handler flow in `graph-editor/lib/api_handlers.py`
- ensure the helper uses backend-native path resolution from
  `graph-editor/lib/analysis_subject_resolution.py` and
  `graph-editor/lib/graph_select.py`

Span kernel:

- add a dedicated subject-kernel helper under `graph-editor/lib/runner/`
  rather than burying the DP inside chart-row emission
- keep operator construction and DP evaluation independent from chart
  concerns so Phase B and later forecast-engine work can reuse them

Row-builder refactor:

- refactor `graph-editor/lib/runner/cohort_forecast.py` so the row
  builder consumes three explicit inputs: composed evidence,
  `x_provider`, and span kernel
- extract the current upstream denominator logic into the `x_provider`
  seam without changing its semantics
- preserve the current D/C, frontier, fan, and clipping behaviour
  during the refactor

Frontend and request plumbing:

- wire the new analysis type through
  `graph-editor/src/components/panels/analysisTypes.ts`,
  `graph-editor/src/services/analysisTypeResolutionService.ts`,
  `graph-editor/src/lib/graphComputeClient.ts`, and the existing
  analysis compute/request contract flow
- reuse the current chart builder path wherever the row schema is
  unchanged

CLI and dev tooling:

- keep the new analysis type runnable through
  `graph-editor/src/cli/commands/analyse.ts`
- retain or extend parity tooling in
  `graph-editor/src/cli/commands/parity-test.ts` so single-edge and
  multi-hop comparisons can be run from the CLI

Transitional compatibility:

- until the row builder is fully refactored around span-kernel and
  provider inputs, the implementation may need an adapter layer over the
  current model-parameter payload emitted by
  `graph-editor/lib/api_handlers.py`
- this is a temporary bridge only; the target Phase A interface is
  composed evidence plus `x_provider` plus subject kernel, not another
  permanent legacy wrapper

---

## Tests and Gates

Phase A is not complete until parity and topology coverage are proven.

Primary Python test homes:

- `graph-editor/lib/tests/test_cohort_forecast.py`
- `graph-editor/lib/tests/test_cohort_maturity_derivation.py`
- `graph-editor/lib/tests/test_cohort_fan_controlled.py`
- `graph-editor/lib/tests/test_cohort_fan_harness.py`
- `graph-editor/lib/tests/test_bayes_cohort_maturity_wiring.py`

Primary TypeScript test homes:

- `graph-editor/src/services/__tests__/analysisTypeResolutionService.test.ts`
- `graph-editor/src/lib/__tests__/graphComputeClient.test.ts`
- `graph-editor/src/cli/__tests__/cliAnalyse.test.ts`
- `graph-editor/src/services/__tests__/analysisRequestContract.test.ts`

Required Phase A gates:

- adjacent-pair parity between `cohort_maturity` and
  `cohort_maturity_v2`, field by field
- x-provider extraction parity for current-code denominator behaviour
- multi-hop subject correctness across chain, branching, fan-in, and
  leakage topologies
- evidence composition correctness for x-side denominator frames and
  y-side numerator frames
- sampler-discipline parity: same observed/forecast splice, same D/C
  split, same no-Binomial treatment for future-arrival mass, same fan
  posture on adjacent cases
- mature-limit convergence and sensible empty-evidence behaviour

---

## Known Approximations Carried Forward by Phase A

Phase A intentionally carries forward several v1 approximations:

- frontier conditioning still treats in-transit subject mass
  conservatively
- prior concentration still comes from the last edge's path-level
  cohort posterior
- latency-shape uncertainty still reuses the last edge's path-level SDs
- subject-side cohort macro-block availability is sparse and
  opportunistic, so the common solve remains atomic edge composition
- upstream propagation is still whatever the current denominator model
  already does; evidence-driven upstream reconstruction is deferred to
  Phase B

None of these block adjacent-pair parity. They are explicit carry-forwards,
not accidental omissions.

---

## Relationship to Phase B and the Broader Forecast Engine

Phase A creates two reusable seams:

- a subject-side span kernel
- an explicit upstream provider interface

Phase B upgrades the provider and frontier exposure logic without
reopening the subject kernel or the row-builder architecture.

The broader forecast-engine work from doc `29` still sits above both
phases:

- forecast-state contract
- basis-resolution unification
- backend-authoritative consumers
- cross-consumer parity

Phase A is therefore the first consumer-facing step, not the whole
generalised engine.
