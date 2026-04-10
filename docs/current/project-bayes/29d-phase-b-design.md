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
  authoritative observed-state reconstruction and post-frontier
  continuation

That asymmetry must survive into implementation.

Phase B must therefore avoid turning upstream into a second copy of the
subject planner by default. The right structure is:

1. reconstruct the authoritative observed history at `x` when compatible
   evidence supports it
2. choose a post-frontier continuation carrier for future arrivals at
   `x`
3. compute frontier exposure from the resulting `X_x`
4. feed the resulting `x_provider` into the Phase A row builder

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

## Upstream Continuation Carrier

The continuation carrier answers one question:

- beyond the observed upstream frontier, what temporal shape should
  future arrivals at `x` follow

It does **not** define the authoritative observed history at `x`.
Observed `X_x(anchor_day, τ)` up to the frontier comes from:

- Policy B reconstruction when compatible upstream evidence has enough
  aligned coverage to support it
- otherwise the preserved Phase A / Policy A baseline

It must produce two outputs in all cases:

- a deterministic point-estimate CDF `upstream_path_cdf_arr` (used for
  `x_at_tau`, E_i, and the deterministic midpoint)
- stochastic MC draws `upstream_cdf_mc` of shape `(S, T)` (used for
  Pop C and upstream IS conditioning)

When neither output can be produced, Pop C is zero and the fan chart
has no post-frontier uncertainty — a hard failure for multi-hop spans
with young cohorts. The hierarchy below exists specifically to prevent
that collapse when upstream edges have no fitted latency model.

### Three-Tier Carrier Hierarchy

Phase B replaces the single parametric carrier with a three-tier
fallback hierarchy. Each tier produces the same output contract. The
first tier that succeeds is used; lower tiers are not consulted.

#### Tier 1: Parametric Ingress Mixture

The preferred carrier when parametric latency information exists on
edges entering `x`.

- **Trigger**: edges entering `x` have `path_mu`, `path_sigma`,
  `path_onset_delta_days` (or their posterior equivalents)
- **Deterministic CDF**: probability-weighted mixture of shifted
  lognormal CDFs across ingress edges
- **Stochastic draws**: per-draw reconvolution with drifted params
  (mu_sd, sigma_sd, onset_sd from posteriors); reach drawn from
  Beta(alpha, beta) when available

This is the existing carrier from Phase A, unchanged.

At fan-in, compatible ingress carriers are combined coherently via
probability-weighted mixture, as described in doc `29b`.

#### Tier 2: Empirical Tail Carrier

The carrier for the common case where upstream edges have snapshot
evidence but no fitted latency model.

- **Trigger**: Tier 1 unavailable AND the carrier builder has access to
  compatible donor cohorts from upstream evidence
- **Source data**: `upstream_obs` — per-cohort `(tau, x_obs)` arrival
  trajectories at `x`, already extracted by
  `extract_upstream_observations` from upstream edge evidence
- **Donor-fetch contract**: the upstream evidence fetch for Tier 2 is
  not limited to the plotted cohort window. The handler must widen the
  compatible upstream fetch enough to discover older donor cohorts when
  they exist; otherwise narrow plotted windows will falsely suppress
  uncertainty.
- **Mass donors**: cohorts sufficiently mature at `x` to inform the
  terminal `x_obs / a_pop` ratio used for unresolved total mass
- **Shape donors**: cohorts whose trajectory extends past the youngest
  plotted cohort's frontier age, so they contribute timing information
  for post-frontier arrivals
- **Censoring rule**: shape donors that are not mature at `x` must be
  treated as censored. Tier 2 must not normalise a donor by its last
  observed `x_obs` and pretend that partial observation is a full CDF.
- **Deterministic CDF**: built from the admissible donor continuation
  shape in [0, 1], with terminal scale informed only by mass donors
- **Stochastic draws** sample two quantities separately per draw:
  1. *Unresolved total mass to x*: informed by the mature donors'
     x_obs / a_pop ratios (Beta posterior on reach)
  2. *Timing of unresolved mass*: bootstrap a normalised residual
     arrival curve beyond the frontier from the set of donor cohorts
- **Admissibility guard**: require at least 2 mass donors and at least
  2 shape donors. If either requirement fails, Tier 2 is unavailable
  and Tier 3 supplies the continuation carrier.

Evidence frames are the mass input for this carrier. The carrier
shapes the model continuation beyond the observed upstream frontier
using the observed upstream history within the frontier.

#### Tier 3: Weak Prior Tail Carrier

The backstop that ensures a non-zero fan chart even when no parametric
model and no empirical donor history exist.

- **Trigger**: Tiers 1 and 2 both unavailable
- **Deterministic CDF**: broad lognormal prior (deliberately wide,
  e.g. mu=log(30), sigma=1.5) scaled by a broad prior on reach
- **Stochastic draws**: sample mu, sigma from broad priors; sample
  reach from a weakly informative Beta. Per-draw CDF from sampled
  lognormal.

This tier produces a wide, uninformative fan. It should be rare in
practice — most edges have either latency params or snapshot evidence.
Its purpose is to prevent zero-width fans from appearing when metadata
is missing.

### Carrier Selection Logic

The implementation target is `build_upstream_carrier()` in
`cohort_forecast_v2.py`. It should try Tier 1, then Tier 2, then Tier 3
and return `(upstream_path_cdf_arr, upstream_cdf_mc, tier_tag)`. The
selected tier should be logged for diagnostics.

### Relationship to Evidence Conditioning

Authoritative observed-state reconstruction and evidence conditioning
are separate concerns.

The continuation-carrier conditioning remains the same regardless of
carrier tier:

- Tier 1: upstream evidence conditions the parametric draws (existing
  behaviour)
- Tier 2: upstream evidence is already absorbed into the empirical
  CDF; IS conditioning tightens the bootstrapped draws further
- Tier 3: if upstream evidence exists but was too sparse for Tier 2,
  it conditions the weak-prior draws via the same IS mechanism

However:

- compatible evidence becomes the authoritative observed `X_x` only
  when Policy B's aligned-grid reconstruction gate is satisfied
- if that reconstruction gate fails, the authoritative observed region
  stays on the preserved Phase A / Policy A baseline
- sparse compatible evidence may still seed or condition Tier 1, Tier
  2, or Tier 3 continuation draws without becoming the authoritative
  observed history

### Practical Interpretation

The ingress carrier (Tier 1) is the **cohort-mode path latency
parameters** attached to edges entering `x`:

- `path_mu`, `path_sigma`, `path_onset_delta_days`
- their posterior equivalents where available (`posterior.path_mu_mean`,
  `posterior.path_sigma_mean`, `posterior.path_onset_delta_days`)

These parameters already encode `a→x` timing in a single parametric
form. When they exist and are compatible with the query's slice,
context, and as-at constraints, they are the preferred carrier.

The empirical carrier (Tier 2) is the **reconstructed arrival history
at `x`** from upstream edge evidence. It does not require parametric
latency models — it works from raw snapshot observations.

Recursive upstream composition belongs to Policy B observed-state
reconstruction, not to the continuation-carrier hierarchy. The carrier
hierarchy starts only after the observed upstream frontier has been
established.

---

## Upstream Mass Policy

The upstream mass policy answers a different question:

- how much mass has arrived at `x` by age `τ`

Phase B retains the two-policy framing from doc `29b`, but the policies
now govern the **authoritative observed upstream history**, not the
entire uncertainty story.

### Policy A: Model-Based Baseline / Continuation

Policy A is the current model-based upstream baseline preserved by
Phase A. Conceptually it combines:

- a scalar reach term
- a continuation carrier
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

Phase B resolves the authoritative observed upstream history as follows:

1. `x = a`: no upstream problem; observed `X_x = a_pop`
2. `x != a` with compatible evidence coverage complete on the aligned
   grid up to the subject frontier: use Policy B to reconstruct the
   observed `X_x`
3. `x != a` without that reconstruction coverage: keep Policy A as the
   authoritative observed baseline for the upstream region
4. independently of 2–3, choose the post-frontier continuation carrier
   from Tier 1 / Tier 2 / Tier 3

The all-or-nothing rule still applies to the authoritative observed
history. Phase B must not splice a partly evidence-driven observed `X_x`
with a partly model-driven observed `X_x` inside one unresolved seam,
because that creates accounting ambiguity at joins and frontier
boundaries.

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

### Reconstruction Mechanics

Policy B is **frame-level evidence propagation in node-arrival space**,
not model-parameter reconstruction. Concretely:

1. Regime-select compatible cohort evidence per upstream edge (see
   §Evidence Compatibility below).
2. Align frames across edges by `(anchor_day, snapshot_date)`.
3. For each incoming edge `u→v`, treat the `y` field on that edge's
   evidence as **observed arrivals at node `v`**.
4. At joins (multiple edges into the same node), sum the compatible
   contributions.
5. Walk the upstream subgraph `G_up = closure(a→x)` in topological
   order, propagating node-arrival histories forward.
6. Beyond the observed upstream frontier, hand off to the selected
   continuation carrier, seeded from the reconstructed frontier state
   rather than from a blank initial condition.

The output is a per-cohort arrival history at `x`: `X_x(anchor_day, τ)`
for each `τ` in the observation grid, which feeds directly into the
`x_provider` interface from Phase A.

### Evidence Compatibility

Upstream evidence on an edge is **compatible** with the subject analysis
when it satisfies all of:

- **same cohort slice type** — the edge's evidence uses cohort-mode
  slicing, not window-mode
- **same anchor** — the evidence is anchored on the same node as the
  subject analysis
- **same context predicate/family** — the context dimensions and values
  match (not necessarily byte-equal `slice_key`, but the same logical
  partition)
- **asat-admissible retrieval window** — the evidence was retrieved
  within an acceptable staleness window for the subject's as-at
  constraints (not necessarily identical `retrieved_at` across edges)
- **regime coherence per retrieved date** — the regime-selection
  contract from doc `30` is satisfied for each observation date
- **complete coverage on the aligned observation grid** — for
  authoritative Policy B reconstruction, evidence exists for all
  `(anchor_day, snapshot_date)` pairs up to the subject frontier, with
  no gaps that would require interpolation

These criteria are derived from docs `29b` and
`30-snapshot-regime-selection-contract.md`.

### Evidence Conditioning vs Reconstruction Gate

The original design overloaded one gate to do two jobs:

- decide whether evidence is strong enough to become the authoritative
  observed `X_x`
- decide whether evidence is useful for conditioning uncertainty in the
  continuation carrier

Those jobs are now separated.

The reconstruction gate remains hard and all-or-nothing per regime:

- only fully compatible, aligned, complete evidence up to the subject
  frontier becomes the authoritative observed `X_x`
- if that gate fails, the observed upstream history remains on the
  preserved Phase A / Policy A baseline

Conditioning of continuation carriers is softer:

- any upstream evidence (even sparse) conditions the carrier draws
  via importance-sampling, tightening the posterior
- dense evidence conditions more tightly; sparse evidence less
- no hard coverage threshold for conditioning — the continuation model
  is always active, evidence modulates it
- when no evidence exists at all, the carrier runs unconditioned
  (prior stands)

This is the same discipline as the subject-side IS conditioning: the
evidence conditions the continuation model, it does not replace it.

The compatibility predicate (§Evidence Compatibility above) still
applies: only compatible evidence should be used for conditioning.
Incompatible evidence (wrong slice type, wrong anchor, etc.) is
excluded, not down-weighted.

### Forecast Beyond the Observed Upstream Frontier

The carrier model provides the full `X_x(τ)` curve.  Where evidence
exists, the IS conditioning tightens the curve toward observed
arrivals.  Beyond the observed frontier, the conditioned model
extrapolates smoothly — no discontinuity at a cutover point.

That continuation should be framed as:

- observed upstream history comes from recursive evidence propagation
- post-frontier continuation uses the selected continuation carrier
  (parametric, empirical, or weak-prior), seeded from the reconstructed
  frontier state rather than from a blank initial condition

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

### Concrete Formula

The subject span kernel `K_{x→y}` from Phase A is a sub-probability CDF
(`K(∞) = span_p`).  The exposure weight must use the **normalised
completeness kernel**, not raw `K`, because raw `K` folds `p` into
exposure — the wrong quantity.

```
C_{x→y}(t) = K_{x→y}(t) / span_p    (or 0 if span_p = 0)
```

Per-cohort effective exposure at frontier age `a_i`:

```
E_i(a_i) = Σ_u  ΔX_x(u) · C_{x→y}(a_i − u)
```

where `ΔX_x(u)` is the incremental arrival mass at `x` on day `u`.

Posterior update using effective exposure:

```
α_post = α₀ + y_obs(a_i)
β_post = β₀ + max(E_i(a_i) − y_obs(a_i), 0)
```

This replaces the Phase A conservative update where `β_post` used raw
`x_obs − y_obs`.  When in-transit mass is negligible (`C ≈ 1` over the
relevant window), `E_i ≈ X_x` and the formula collapses to Phase A.

### Behavioural Expectations

- when there is no meaningful in-transit subject mass, Phase B should
  collapse back toward the Phase A result
- when there is substantial in-transit subject mass, Phase B should be
  less conservative than Phase A
- the change should be largest on wide or slow multi-hop subjects, not
  on adjacent pairs

---

## Implementation Plan

### Upstream carrier hierarchy

- extract the existing parametric carrier build in
  `graph-editor/lib/runner/cohort_forecast_v2.py` into a Tier 1 helper
- add a Tier 2 empirical tail carrier that consumes `upstream_obs`
  (already fetched by `extract_upstream_observations` in
  `graph-editor/lib/runner/span_upstream.py`)
- add a Tier 3 weak prior tail carrier as the backstop
- add a `build_upstream_carrier()` orchestrator that tries each tier
  and returns `(upstream_path_cdf_arr, upstream_cdf_mc, tier_tag)`
- replace the inline carrier build with a call to the orchestrator
- make Tier 2 donor discovery an explicit part of the fetch contract,
  not an accidental consequence of the plotted cohort window

### Handler plumbing

- pass `upstream_obs` from the handler
  (`graph-editor/lib/api_handlers.py` `_handle_cohort_maturity_v2`)
  into `compute_cohort_maturity_rows_v2` so Tier 2 can consume it
- widen the compatible upstream fetch when needed so Tier 2 can access
  older donor cohorts outside the plotted anchor window
- store both plotted cohorts and donor cohorts on
  `XProvider.upstream_obs`; the row builder decides which subsets are
  used for reconstruction vs continuation

### Frontier update (implemented)

- `graph-editor/lib/runner/cohort_forecast_v2.py` frontier update
  consumes effective exposure `E_i` instead of raw `N_i`
- IS conditioning uses parameterisation B: `Bin(E_eff, p)` where
  `E_eff = max(E_i, k_i)`
- Pop D uses `remaining_frontier = max(E_i - k_i, 0)`
- the surrounding D/C split, fan generation, and clipping logic are
  unchanged

### Provider policy resolution

- authoritative observed-history resolution and continuation-carrier
  selection must be logged separately in
  `_handle_cohort_maturity_v2` / `cohort_forecast_v2.py`
- Policy A remains the authoritative observed baseline when Policy B's
  reconstruction gate fails
- sparse compatible evidence may still condition Tier 1 / Tier 2 /
  Tier 3 continuation draws without activating Policy B reconstruction

### Request and analysis plumbing

- Phase B lands inside the existing `cohort_maturity_v2` path
- `graph-editor/lib/api_handlers.py` and the existing request plumbing
  change only to pass improved provider outputs, not to change the
  public analysis contract

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
- incomplete-evidence cases do not partially splice observed `X_x`;
  the authoritative observed region stays on Policy A without
  partial-regime mixing
- sparse compatible evidence can still widen or condition the
  continuation fan even when it is insufficient for authoritative
  Policy B reconstruction
- completeness-adjusted frontier exposure is equal to Phase A when no
  in-transit subject mass exists and less conservative when it does
- subject-kernel outputs remain unchanged for the same subject inputs;
  Phase B improves the provider and frontier update, not the subject
  planner
- end-to-end charts remain stable on adjacent pairs and improve only on
  the intended multi-hop cohort cases

Carrier-specific gates:

- Tier 1 (parametric): identical behaviour to pre-hierarchy code
- Tier 2 (empirical): non-latency upstream edge with unresolved
  upstream mass produces a non-zero MC fan; narrow plotted cohort
  window still gets uncertainty when older admissible donor cohorts
  exist in the evidence
- Tier 3 (weak prior): missing metadata produces a wide
  uninformative fan rather than zero-width
- when upstream mass is genuinely saturated at the frontier, the band
  may still be narrow — that is correct behaviour, not a defect

---

## Implementation Status (10-Apr-26)

### Implemented

- **v2 row builder** (`cohort_forecast_v2.py`): factorised X_x + C_{x→y}
  representation, parallel to v1 (frozen)
- **Planner**: detects collapsed shortcut (single-edge, path params) vs
  factorised (multi-hop); collapsed path uses v1 row builder for exact
  single-edge parity
- **Span kernel**: convolved CDF from `mc_span_cdfs`, normalised
  completeness C = K/span_p
- **E_i frontier exposure**: `E_i = Σ ΔX_x(u) · C(a_i − u)`, used in
  IS conditioning (parameterisation B: `Bin(E_eff, p)`) with guard
  skipping IS when `E_eff − k_i < 1`
- **Pop D**: uses `N_i − k_i` (actual unconverted people), not
  `E_i − k_i` (exposure-adjusted)
- **Three-tier carrier hierarchy**: Tier 1 parametric, Tier 2 empirical,
  Tier 3 weak prior.  Orchestrated by `build_upstream_carrier()`.
  Tier 2 propagates mass uncertainty via per-draw mass scaling (not
  clipped to 1.0) and skips IS on upstream obs to avoid double-counting
  evidence already baked into the empirical carrier.
- **Donor-fetch widening**: upstream evidence fetch uses data-driven
  lookback (2× axis_tau_max, min 60 days) to discover older donors
  outside the plotted window
- **Annotation**: unified with v1 via `_resolve_completeness_params`
  logic (inlined in v2 handler, same precedence)
- **Epoch contract**: A (observed, null midpoint, flat fan), B (mixed,
  MC fan), C (forecast, projected_rate = midpoint)
- **axis_tau_max**: computed from sweep_span, edge_t95, path_t95,
  tau_extent — same candidates as v1
- **Non-latency edges as δ₀**: `span_kernel.py` returns sigma=0 for
  edges without a latency model; `_edge_sub_probability_density`
  places all mass at tau=0; `mc_span_cdfs` gives zero SDs so no fake
  timing uncertainty is injected
- **FE SD promotion fix**: `promoteModelVars` in
  `modelVarsResolution.ts` now includes mu_sd, sigma_sd, onset_sd
  (and path equivalents) in the promotion result — previously omitted,
  causing `promoted_mu_sd` to never be written
- **Synth test graph**: `synth-forecast-test` created with 6 edges
  (including non-latency gate, fan-in at hub, slow/fast upstream
  paths). 85,944 snapshot rows generated and verified.  Blocked on
  CLI issues (see `33-cli-analyse-blockers.md`)

### Known defects / incomplete items

- **Tier 3 weak prior not statistically calibrated**: uses a fixed
  broad lognormal (mu=log(30), sigma=1.5) that is not informed by the
  graph structure.  Acceptable as a backstop but should not be the
  primary carrier for common cases.

- **Evidence compatibility predicate simplified**: accepts any non-empty
  upstream frames without verifying slice type, anchor, context, or
  regime coherence per §Evidence Compatibility.

- **Parity test fixtures missing**: `test_doc31_parity.py` references
  non-existent `high-intent-flow-v2` graph.  Needs synthetic test
  fixtures, not production graphs.

- **No end-to-end validation of E_i on a partially-mature span**: all
  test cases so far have saturated upstream (E_i ≈ N_i or E_i ≈ k_i).
  Need a case where the span CDF is partially mature and E_i sits
  meaningfully between k_i and N_i.

- **Frontier evidence does not directly condition latency particles**:
  E_i uses deterministic sp.C; IS weights only p_i (not CDF shape).
  cdf_i is resampled alongside p_i (joint draws from mc_span_cdfs),
  so draws with better-fitting CDF shapes survive indirectly, but
  CDF shape is not directly weighted by observed frontier data.
  Per-draw CDF conditioning is deferred to §Deferred Work.

- **CLI blockers** (doc `33-cli-analyse-blockers.md`): DSL subject
  doubling and missing topo pass prevent CLI-based testing on synth
  graphs.  All acceptance gates that require CLI verification are
  blocked until these are resolved.

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
