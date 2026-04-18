# 48 — Standalone Bayes Remediation Plan

**Date**: 18-Apr-26  
**Status**: Active  
**Audience**: engineer implementing the current Bayes fixes

## 1. What this document is

This is a self-contained implementation plan for the current Bayes issue
set.

It is written for a reader who has **not** followed the prior discussion.
It explains:

- what the Bayes system does
- where the relevant code lives
- what is wrong today
- why each problem matters
- the proposed fix
- how to prove the fix is good enough

It is not a commentary on another note. It is the action plan itself.

## 2. System briefing

### 2.1 What DagNet is modelling

DagNet represents a conversion funnel as a directed acyclic graph. Each
edge has two statistical objects:

- an eventual conversion probability `p`
- an optional latency model describing how long conversion takes

Latency is represented as a shifted lognormal with:

- `onset_delta_days`
- `mu`
- `sigma`

The system has to learn both **whether** users convert and **when** they
convert, using incomplete data from cohorts that are still maturing.

### 2.2 What evidence the Bayes compiler consumes

The compiler uses several evidence families for each edge:

- aggregate window counts
- per-day counts
- cohort trajectories observed at multiple retrieval ages
- mature endpoint counts
- branch-group counts for sibling edges sharing a denominator

Those evidence families are not interchangeable. If the same
information is consumed twice, the posterior is biased. If one family is
scored against the wrong null model, the resulting quality metric is
misleading.

### 2.3 What the two-phase fit does

The current Bayes stack has two phases:

- **Phase 1** fits edge behaviour from window-oriented evidence
- **Phase 2** carries Phase 1 information forward as priors, then fits
  cohort-oriented behaviour

That means a Phase 1 defect can propagate into Phase 2 even if the Phase
2 code is itself correct.

### 2.4 What consumes the fitted output

The fitted output is consumed in three ways:

1. **Posterior export**: backend summaries are written into the patch
   payload and then projected onto graph edges
2. **Quality surfaces**: the frontend shows provenance, fit warnings,
   and model-quality signals
3. **Forecast consumers**: graph scalars, cohort maturity charts, and
   forecast-style analyses consume the fitted parameters to project
   current and future conversion

So there are three failure classes:

- defects that change the fitted posterior
- defects that leave the posterior alone but misstate uncertainty or fit
- defects that make different forecast consumers disagree about the same
  edge

## 3. Where the relevant code lives

| Concern | Primary files |
|---|---|
| Core likelihoods and priors | `bayes/compiler/model.py` |
| Posterior summarisation and export preparation | `bayes/compiler/inference.py` |
| LOO scoring and analytic nulls | `bayes/compiler/loo.py` |
| Patch shaping and slice export | `bayes/worker.py` |
| FE patch projection onto graph edges | `graph-editor/src/services/bayesPatchService.ts` |
| FE quality warnings | `graph-editor/src/utils/bayesQualityTier.ts` |
| Forecast handlers | `graph-editor/lib/api_handlers.py` |
| Forecast engine and sweep logic | `graph-editor/lib/runner/forecast_state.py` |
| Compiler / export tests | `bayes/tests/` |

## 4. Delivery order

The work should be done in this order:

1. fix posterior-correctness defects
2. fix export and quality-signal truthfulness
3. unify forecast consumers
4. clean up any remaining scope corrections or stale assumptions

This order matters. There is no point polishing quality labels on top of
a biased posterior, and there is no point forcing forecast parity across
consumers if the producer contract is still wrong.

## 5. Scope corrections before coding

These are not "fixes". They are important targeting corrections so work
starts in the right place.

### 5.1 Multi-hop evidence-family targeting

**Current reality**  
The cohort maturity chart handlers already apply the correct
multi-hop-cohort subject-frame rule: for multi-hop cohort queries, they
prefer **window evidence** when constructing the per-edge subject frames
that feed the path computation.

**Why this matters**  
If an engineer starts by changing those handlers again, they will spend
time in the wrong code path and may re-break a path that has already
been corrected.

**Action**  
Target the remaining forecast-oriented handlers that still pass the raw
query-level `is_window` flag into subject-frame evidence selection.

**Quality bar**  
Before changing any code, demonstrate which handlers still build
multi-hop cohort subject frames with the raw query-level flag rather
than the corrected override.

### 5.2 Latency-dispersion targeting

**Current reality**  
The batched window trajectory path already uses BetaBinomial intervals
when latency dispersion is enabled. The live unresolved question is the
mixture trajectory path, not the batched window path.

**Why this matters**  
If the team keeps treating the batched window path as the live defect
site, they will miss the real remaining gap and may destabilise code
that is currently working.

**Action**  
Do not prioritise the batched window path unless a regression proves it
is broken. Treat mixture-trajectory latency dispersion as the live
decision point.

**Quality bar**  
Regression coverage proves the batched window path still emits
`kappa_lat` when enabled.

## 6. Action plan

### Fix 1 — Remove endpoint double-counting

**Problem**  
A mature terminal observation can currently influence the model twice:

- once through the trajectory interval likelihood
- once through the endpoint BetaBinomial likelihood

This affects shared probability, dispersion, and latency parameters.

**Why it matters**  
This is the highest-priority defect because it changes the fitted
posterior itself. It is not a reporting issue. It can also contaminate
Phase 2 because Phase 1 output is reused as prior information.

**Proposed fix**  
Introduce a single ownership rule for mature terminal observations:

- the trajectory likelihood owns the maturation shape
- the endpoint likelihood owns the mature terminal count

The concrete implementation should be:

- if a mature endpoint likelihood is emitted for a trajectory, exclude
  that trajectory's terminal interval from the trajectory interval
  product
- if no endpoint likelihood is emitted, keep the full trajectory

This is better than down-weighting because it removes duplication rather
than trying to compensate for it numerically.

**Implementation details**  

- `bayes/compiler/model.py`
  - centralise interval construction so the "exclude terminal interval"
    rule is applied consistently in both Phase 1 and Phase 2
  - ensure the same ownership rule is reflected in any pointwise
    log-likelihood bookkeeping used for diagnostics
- `bayes/tests/`
  - add a synthetic builder for a single-edge case with a mature
    terminal observation
  - add a regression that fits two equivalent encodings of the same data

**Quality bar**  

- the same underlying evidence encoded in two equivalent ways produces
  materially identical posterior summaries
- no mature terminal observation can contribute to both the trajectory
  and endpoint terms in one fit
- a warm-start regression shows that Phase 2 priors are stable under
  equivalent evidence encodings

### Fix 2 — Make Phase 2 non-exhaustive branch priors order-invariant

**Problem**  
The current Phase 2 prior construction for non-exhaustive branch groups
depends on the order of sibling edges.

**Why it matters**  
A Bayesian posterior must not change because siblings were listed in a
different order. This is a modelling error, not a stylistic issue.

**Proposed fix**  
Construct the branch prior in two stages:

1. compute every sibling's prior mean and concentration contribution
2. derive one group-level concentration scale and use it for all
   siblings plus dropout

The most defensible concrete rule is:

- compute sibling prior means `p_i`
- compute one shared branch concentration `kappa_group` once, using the
  mean ESS-decayed concentration across available siblings
- set sibling concentrations to `alpha_i = p_i * kappa_group`
- set dropout concentration to
  `alpha_dropout = max(1 - sum(p_i), floor) * kappa_group`

This is symmetric, easy to reason about, and matches the fact that a
Dirichlet branch prior should have one shared concentration scale.

**Implementation details**  

- `bayes/compiler/model.py`
  - remove any in-loop mutable dropout construction
  - compute sibling summaries first, then build the Dirichlet vector
- `bayes/tests/`
  - add a sparse multi-sibling non-exhaustive synthetic branch case
  - fit with two sibling orderings and the same random seed

**Quality bar**  

- sibling reordering does not change posterior summaries or predictive
  summaries beyond tolerance
- exhaustive groups are unchanged
- dropout concentration remains numerically stable in sparse-data cases

### Fix 3 — Make `cohort()` uncertainty export truthful

**Problem**  
The exported `cohort()` probability band is currently built from
`p_cohort_*` plus a fresh empirical `_estimate_cohort_kappa()` step,
while the frontend presents the result as Bayesian cohort uncertainty.

**Why it matters**  
This does not necessarily corrupt the sampler, but it does make the
export contract untruthful. Engineers and users reading the graph see a
Bayesian-looking uncertainty band that is not a clean direct export of
the fitted posterior.

**Proposed fix**  
Do this in two steps:

1. **Immediate truthfulness step**: stop presenting the current export as
   direct Bayesian cohort uncertainty unless it is actually trace-derived
2. **Preferred end state**: replace the empirical path with a genuine
   model-based cohort predictive export derived from the fitted trace

If the model cannot currently support a trace-derived Beta-style export,
then the right behaviour is not to fake one. In that case:

- either export a clearly named empirical predictive object
- or export no cohort Beta pair until a truthful model-based version
  exists

**Implementation details**  

- `bayes/compiler/inference.py`
  - isolate the current empirical step so it is explicit rather than
    mixed into the default path
- `bayes/worker.py`
  - export fields that reflect the chosen contract
- `graph-editor/src/services/bayesPatchService.ts`
  - project only truthful fields into the graph
- frontend surfaces
  - update any labels or tooltips that currently imply a direct posterior
    origin

**Quality bar**  

- backend tests prove exactly where exported cohort uncertainty comes
  from
- patch payload tests prove the exported field names match the chosen
  contract
- FE tests prove the user-facing labelling no longer overstates the
  source of the band

### Fix 4 — Make LOO scoring honest

**Problem**  
The current LOO machinery mixes two problems:

- some likelihood families are not clearly represented in
  `trace.log_likelihood`
- some null helpers do not cleanly mirror the fitted likelihood geometry

That means `delta_elpd` is weaker than it appears.

**Why it matters**  
`delta_elpd` is already part of the visible quality story. A negative
warning should mean "the Bayesian model predicts worse under the same
likelihood family", not "the metric is comparing different objects".

**Proposed fix**  
Handle this in order.

#### Step A — make the scored families explicit

Only families that are intentionally represented pointwise in
`trace.log_likelihood` should contribute to LOO.

For any family the team wants scored:

- expose a pointwise `ll_*` representation
- move it into `trace.log_likelihood` explicitly

For any family not intentionally scored:

- do not pretend it participates in `delta_elpd`

#### Step B — make the null mirror the fitted family

For every scored family, the null must use the same structure:

- path latency where the fitted likelihood uses path latency
- dropout where the fitted likelihood uses dropout
- kappa scaling where the fitted likelihood uses kappa scaling

**Implementation details**  

- `bayes/compiler/model.py`
  - add pointwise `ll_*` tracking for any currently unscored family the
    team wants included
- `bayes/compiler/inference.py`
  - move those pointwise arrays into `trace.log_likelihood`
- `bayes/compiler/loo.py`
  - score only explicitly supported families
  - implement nulls that mirror the fitted structure exactly
- `graph-editor/src/utils/bayesQualityTier.ts`
  - only warn on `delta_elpd` once the scoring scope is explicit

**Quality bar**  

- the scored family set is explicit and testable
- synthetic tests cover branch-group dropout and cohort-endpoint
  path-latency cases if those families are scored
- a negative FE `delta_elpd` warning now has a like-for-like meaning

### Fix 5 — Make summarisation deterministic

**Problem**  
Posterior summarisation currently re-simulates predictive Beta draws
through the global NumPy RNG.

**Why it matters**  
The same saved trace can produce slightly different alpha/beta, HDI, and
derived stdev values on different runs. That creates noisy diffs and
weakens regression tooling.

**Proposed fix**  

- derive outputs deterministically wherever possible
- where simulation is unavoidable, use a local seeded generator rather
  than the global RNG

The seed should be stable for a stable fit. A fixed summarisation seed or
a seed derived from the fit fingerprint is acceptable.

**Implementation details**  

- `bayes/compiler/inference.py`
  - replace global `np.random.beta(...)` usage with deterministic
    generation or a local `Generator`
  - apply the same rule consistently to every predictive helper
- `bayes/tests/`
  - add a regression that summarises the same trace twice

**Quality bar**  

- summarising the same trace twice yields byte-identical patch payloads
- rerunning the worker with unchanged inputs yields no diff in predictive
  summary fields
- one regression fails if a future helper reintroduces the global RNG

### Fix 6 — Make path provenance truthful

**Problem**  
Path provenance currently overstates certainty by labelling path-level
results as `"bayesian"` even when those values are derived or inherited
rather than separately quality-gated.

**Why it matters**  
The FE already surfaces provenance as a trust signal. If the provenance
string says more than the system can defend, the UI is telling the user a
story that is too strong.

**Proposed fix**  
Introduce explicit path provenance categories. A good concrete scheme is:

- `bayesian` — directly supported by a path-specific convergence gate
- `derived-bayesian` — derived from Bayesian upstream objects but not
  independently gated
- `derived-pooled-fallback` — derived from degraded inputs
- `empirical` — exported from an empirical estimator
- `point-estimate` — no posterior uncertainty contract

Do not use plain `"bayesian"` unless the system can justify it.

**Implementation details**  

- `bayes/compiler/inference.py`
  - compute path provenance from the actual source and diagnostics
- `bayes/worker.py`
  - export the richer provenance vocabulary
- `graph-editor/src/utils/bayesQualityTier.ts`
  - treat degraded or inherited path provenance explicitly

**Quality bar**  

- provenance changes when the underlying source or quality changes
- FE warnings and badges reflect the richer provenance meanings
- no remaining FE surface implies direct Bayesian convergence where that
  is not true

### Fix 7 — Apply the subject-frame evidence-family rule everywhere

**Problem**  
The chart handlers already use the corrected evidence-family rule for
multi-hop cohort subject frames, but other forecast paths still rely on
the raw query-level `is_window` flag.

**Why it matters**  
That leaves one part of the product on corrected semantics and another
part on older semantics, so different forecast consumers can disagree
before they even reach the span kernel.

**Proposed fix**  
Extract a shared helper for subject-frame evidence selection and use it
in every forecast-oriented handler.

The rule should be:

- multi-hop cohort query -> use window evidence for subject-frame
  construction
- keep cohort semantics for downstream path-level computation

**Implementation details**  

- `graph-editor/lib/api_handlers.py`
  - add one helper for subject-frame evidence-family selection
  - use it in conditioned forecast, whole-graph forecast, and any other
    forecast-oriented handler that currently uses raw `is_window`
- tests
  - add one multi-hop cohort regression that exercises chart and
    non-chart paths

**Quality bar**  

- chart, conditioned forecast, and whole-graph forecast produce the same
  boundary frames for the same multi-hop cohort query
- window-mode results are unchanged
- a direct code search shows no remaining raw-flag path in these
  handlers

### Fix 8 — Resolve V3 cohort midpoint inflation

**Problem**  
The current v3 cohort chart can inflate single-hop cohort midpoints
relative to v2 even when per-cohort evidence and upstream X totals are
the same.

**Why it matters**  
This is a live user-facing chart defect. It also blocks use of current
v3 parity as a correctness oracle for later forecast work.

**Proposed fix**  
Use a fixed ablation sequence rather than ad hoc tweaking.

The strongest current hypothesis is that v2 and v3 diverge because they
use different:

- sweep horizon `max_tau`
- `mc_span_cdfs` normalisation boundary
- possibly mutation or drift behaviour after those horizon differences
  already changed the arrays

So the repair should begin by forcing both paths to use the same horizon
and the same normalisation boundary.

Concretely:

1. introduce one shared horizon-resolution helper
2. use the same `max_tau` both for the sweep and for
   `mc_span_cdfs` normalisation
3. remove hard-coded alternative boundaries in the v3 path
4. only then test whether further drift or mutation differences remain

**Implementation details**  

- `graph-editor/lib/api_handlers.py`
  - remove special-case hard-coded horizon inputs
- `graph-editor/lib/runner/span_kernel.py`
  - ensure the normalisation boundary is driven by the shared horizon
    contract
- `graph-editor/lib/runner/forecast_state.py`
  - keep the sweep aligned with that same horizon contract

**Quality bar**  

- on the known single-hop cohort reproduction, v2 and v3 match within
  tolerance for midpoint, `Y_total`, and `X_total` across tau
- window-mode control remains unchanged
- the fix lands in shared preparation logic, not as a chart-only patch

### Fix 9 — Unify forecast consumers around one sweep and one carrier contract

**Problem**  
The graph scalar, chart, surprise-style consumers, and whole-graph
forecast paths do not all prepare carriers, CDFs, and conditioning
inputs in the same way.

**Why it matters**  
Even with good fitted parameters, two consumers can disagree because
they are not reading the same prepared inputs.

**Proposed fix**  
Adopt one shared preparation contract and one shared sweep contract.

The clean target is:

- one shared prepared-input object per edge containing:
  - resolved model parameters
  - cohorts
  - upstream observations or carrier
  - deterministic and MC CDF inputs
  - resolved horizon
- one authoritative sweep function
- thin consumers that differ only in **what they read** from the sweep
  result, not in how they build it

That means:

- graph scalar reads the final scalar it needs
- chart reads the full tau sweep
- other forecast consumers become wrappers, not separate implementations

**Implementation details**  

- `graph-editor/lib/runner/forecast_state.py`
  - define the shared prepared-input contract
  - make the authoritative sweep accept only that contract
- `graph-editor/lib/api_handlers.py`
  - prepare inputs once, then dispatch to the shared sweep
- remove or wrap private preparation logic in older forecast consumers

**Quality bar**  

- for the same edge, mode, and date range, graph scalar output matches
  chart `tau_max` midpoint within tolerance
- carrier tier matches across consumers for the same edge
- there is no remaining private carrier or CDF preparation path

### Fix 10 — Decide and implement the mixture-trajectory latency-dispersion contract

**Problem**  
Mixture trajectories still use plain Binomial intervals even when
single-path trajectories use BetaBinomial intervals with `kappa_lat`.

**Why it matters**  
If mixture paths are supposed to support timing overdispersion, the
current implementation understates timing uncertainty exactly where
mixture structure is already making the path harder to reason about.

**Proposed fix**  
Implement the same latency-dispersion contract in the mixture path.

The carefully reasoned choice is:

- keep `kappa_lat` as one edge-level timing-dispersion parameter for the
  emitted trajectory family
- compute the mixture hazard `q_j` from the mixture CDF exactly as today
- feed that `q_j` through a BetaBinomial interval likelihood instead of a
  Binomial interval likelihood

This is the right level of complexity. Timing overdispersion belongs to
the realised interval hazard, not to separate per-path membership
parameters.

If the team decides not to support dispersion here, that choice must be
explicit and documented as a deliberate simplification rather than an
accidental omission.

**Implementation details**  

- `bayes/compiler/model.py`
  - add the same BetaBinomial interval path used in the single-path case
    after mixture `q_j` is computed
- `bayes/tests/`
  - add a synthetic join-node or mixture-path regression

**Quality bar**  

- mixture-path fits widen relative to the Binomial fallback when the data
  support timing overdispersion
- single-path behaviour is unchanged
- the implementation uses one coherent `kappa_lat` contract rather than
  inventing per-component dispersion parameters

## 7. Recommended sequence

Implement in this order:

1. Fix 1 — endpoint double-counting
2. Fix 2 — order-invariant branch priors
3. Fix 3 — truthful `cohort()` uncertainty export
4. Fix 4 — honest LOO scoring
5. Fix 5 — deterministic summarisation
6. Fix 6 — truthful path provenance
7. Fix 7 — subject-frame evidence-family rule in all forecast paths
8. Fix 8 — v3 cohort midpoint inflation
9. Fix 9 — unified forecast-consumer contract
10. Fix 10 — mixture-path latency dispersion

## 8. Minimum completion standard

No item above counts as complete until it has all four of these:

1. the code change
2. a focused regression that proves the intended invariant
3. a check that the frontend surface still tells the truth
4. a documentation update recording the new steady state
