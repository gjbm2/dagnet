  # Project Bayes: Compiler — data layers to model

**Status**: Draft
**Date**: 17-Mar-26
**Purpose**: How the compiler turns each input data layer into pm.Model
structure. This is the kernel design: what information exists at compile time,
what model structure each layer contributes, and how the layers interact.

**Related**: `0-high-level-logical-blocks.md` (conceptual compiler design),
`2-reference-implementation-notes.md` (PyMC patterns),
`1-cohort-completeness-model-contract.md` (maturity semantics, onset/path
contracts, join handling)

---

## What the compiler does

The compiler walks a conversion graph and its associated evidence, and emits
PyMC variable declarations that together define a joint log probability
function. NUTS then explores that function to produce posterior samples.

"Compiling" means: for each structural pattern in the graph and evidence,
decide which pm variables to create and how to wire them together (shared
references in PyTensor's expression graph). Once the pm.Model is built,
compilation is over. Everything after that is standard MCMC.

The compiler's inputs are six data layers. Each layer contributes specific
model structure. The layers interact — a context slice of a cohort observation
on a branching edge touches four layers simultaneously.

### Compiler outputs: the IR boundary

The compiler produces two intermediate representations before touching PyMC:

1. **`TopologyAnalysis`** — the structural decomposition of the graph
2. **`BoundEvidence`** — evidence mapped to the topology

These are the **stable IR**. They must be:

- **Serialisable**: JSON-round-trippable, no PyMC or PyTensor objects
- **Deterministic**: same inputs → same IR, byte-for-byte
- **Fingerprintable**: a hash of the IR determines whether a cached posterior
  is structurally compatible with a new run
- **Engine-independent**: the IR does not assume PyMC. A different inference
  backend (Stan, NumPyro) should be able to consume the same IR

Only the third function (`build_model`) imports PyMC. Everything upstream is
pure Python data structures.

This preserves the design from doc 0: the compiler produces an inspectable,
cacheable, dry-runnable plan before any inference happens.

---

## Layer 1: Graph structure

**Source**: `graph_snapshot` (sent inline by FE in the submit payload)

**What it contains**: nodes, edges, `from`/`to` connections, `entry.is_start`
flags, `absorbing` flags, edge `p` and `latency` blocks, `conditional_p`
lists.

**What it contributes to the model**:

### Solo edges (out-degree 1 from source node)

Each gets an independent probability variable:

```
p_{edge_id} ~ Beta(α, β)
```

If observed data exists:

```
obs_{edge_id} ~ Binomial(n, p_{edge_id}), observed=k
```

### Branch groups (out-degree > 1 from source node)

Sibling edges from the same source node share a Dirichlet prior and a
**Multinomial likelihood with a shared denominator**. The edges represent
mutually exclusive outcomes for the same source population, so they must
share `n`:

```
# Node A has edges A→B, A→C (non-exhaustive, so 3 components)
weights_{node_A} ~ Dirichlet([α_B, α_C, α_dropout])

# Shared denominator n_A. Observed counts must sum to ≤ n_A.
obs_{node_A} ~ Multinomial(n_A, weights_{node_A}), observed=[k_B, k_C, n_A - k_B - k_C]
```

Using separate Binomials with different `n` per sibling would be incoherent —
the probabilities are defined relative to the same source population, so
the likelihood must reflect that. The dropout count
`n_A - k_B - k_C` is the observed number of users who entered A but
reached none of the tracked downstream nodes.

The coupling is automatic: `weights[0]` and `weights[1]` are slices of the
same Dirichlet draw, so NUTS knows they're jointly constrained (if one goes
up, the others must come down).

**Determining n_A**: the shared denominator is the total traffic at the
source node. This **must** come from the data — the source node's outbound
event count (for window observations) or anchor cohort daily counts (for
cohort observations). See the denominator contract section below for the
full specification.

If `n_A` is not available from the data, the compiler must **refuse to
compile that branch group as a Multinomial** and fall back to independent
Binomials with a diagnostic warning. The `max(n_B, n_C, ...)` approximation
is unsafe — if `k_B + k_C` exceeds that max, the Multinomial likelihood
becomes infeasible.

Non-exhaustive (the common case in conversion funnels) adds a phantom dropout
component. Exhaustiveness should be a **per-node metadata flag**, not inferred
from observed counts — sampling noise, censoring, and slice incompleteness
can all make sibling probabilities appear to sum to ~1 when they don't, or
vice versa.

### Join nodes (in-degree > 1)

Each incoming edge is independently parameterised — no special coupling at
the join itself. The join matters for two things:

1. **Derived quantities** (e.g. "total probability of reaching Y from
   anchor A"), computed post-hoc from the posterior.

2. **Path latency at non-terminal joins.** If the join node has outgoing
   edges, those edges need a path latency for completeness coupling. The
   path latency at a join is a **weighted mixture** of the inbound path
   latency distributions, collapsed to a single shifted lognormal via
   moment-matching (see Join latency handling below).

**Terminal joins** (absorbing nodes, abandon sinks) are inert — they receive
traffic but have no outgoing edges, so they never need path latency for
completeness. The compiler ignores them for join-collapse purposes. Abandon
paths in particular are not event-driven; abandonment is measured
implicitly as `n_A - Σ(k_siblings)`, not by observing a downstream event.

**Non-terminal joins** (joins with outgoing event-driven edges) are common
in real production graphs. In the data repo:
- `conversion-flow-v2-recs-collapsed`: Energy Rec (in=3, out=2), Switch
  Registered (in=2, out=2)
- `high-intent-flow-v2`: Delegated (in=2, out=2), Non-Retention Reco
  (in=2, out=2), Register Delegated (in=2, out=3), Register Non-Delegated
  (in=2, out=3)
- `li-cohort-segmentation-v2`: Energy Switch Success (in=3, terminal but
  illustrative of multi-path convergence)

A unique-path constraint would be too restrictive for these graphs.

### Join latency handling: moment-matched collapse

At each join node `X` with `k` inbound edges from nodes `U_1, ..., U_k`,
each inbound path `i` carries a path model
`(path_delta_i, path_mu_i, path_sigma_i)` and a traffic weight `w_i`.

The compiler collapses the mixture to a single shifted lognormal using the
three-step moment-matching from doc 1 §15.4:

```
# Step 1: Moments of each inbound path's shifted lognormal
E[T_i] = path_delta_i + exp(path_mu_i + path_sigma_i^2 / 2)
E[T_i^2] = path_delta_i^2
            + 2 * path_delta_i * exp(path_mu_i + path_sigma_i^2 / 2)
            + exp(2 * path_mu_i + 2 * path_sigma_i^2)

# Step 2: Mixture moments
E[T_mix] = Σ_i(w_i * E[T_i])
Var[T_mix] = Σ_i(w_i * E[T_i^2]) - E[T_mix]^2

# Step 3: Collapse to shifted lognormal
delta_mix = min_i(path_delta_i)
E_shifted = E[T_mix] - delta_mix
sigma_mix^2 = ln(1 + Var[T_mix] / E_shifted^2)
mu_mix = ln(E_shifted) - sigma_mix^2 / 2
```

Result: `(delta_mix, mu_mix, sigma_mix)` — preserves the mean and variance of
the full mixture. Downstream composition via FW then proceeds as usual:

```
path_mu_XY = FW(LN(mu_mix, sigma_mix), LN(mu_XY, sigma_XY)).mu
path_sigma_XY = FW(...).sigma
path_delta_XY = delta_mix + onset_XY
```

**Traffic weights** `w_i`: during the topo-sort DP, each inbound edge carries
a flow mass (the edge's conversion volume or probability estimate). These
provide natural weights: `w_i = flow_i / Σ(flow_i)`. In the Bayes model,
these weights are deterministic functions of the latent edge probabilities —
the moment-matching formulae are differentiable, so gradients flow correctly
through the collapse and NUTS can explore the joint space.

If flow mass is unavailable for some paths (skipped edges, no data), use
equal weights and mark the result as lower-confidence in the compile
diagnostics.

**Composability**: because the collapse at each join produces a standard
`(delta, mu, sigma)` triple, joins compose naturally through chains. In
`conversion-flow-v2-recs-collapsed`, Switch Registered inherits the
collapsed model from Energy Rec (itself a join), adds the Energy Rec →
Switch Registered edge latency, and produces a further collapsed model for
downstream edges.

**What the collapse loses**: multimodality. If inbound paths have very
different timings and similar traffic weights, the mixture is bimodal but
the collapsed lognormal is unimodal. The compiler should detect this case
(high ratio of between-path variance to within-path variance) and flag it
in the compile diagnostics. For typical funnels (2–3 inbound paths of
broadly similar timing, or one dominant path), the approximation error is
small.

### Latency model: edge-level variables

For each edge with `latency.latency_parameter == true`, the compiler creates
edge-level latency variables representing the shifted lognormal
`T_edge = onset_delta + LN(mu, sigma)`:

```
mu_{edge_id}    ~ Normal(mu_prior, sigma_mu_prior)
sigma_{edge_id} ~ Gamma(alpha_sigma, beta_sigma)
```

Where:
- `mu_prior` is derived from observed data: `mu_prior = ln(median_lag - onset)`
- `sigma_mu_prior` controls prior uncertainty on the location (default: 0.5)
- The `Gamma` prior on `sigma` is parameterised to place its mode near the
  fitted dispersion from data: `alpha_sigma`, `beta_sigma` chosen so that
  `mode = (alpha - 1) / beta ≈ sigma_from_data`
- `onset_delta` is the edge's `onset_delta_days` — a fixed (non-latent)
  scalar from the parameter file

Note: `HalfNormal(scale)` is **not** used for `sigma` because its mode is at
zero, which would pull the dispersion estimate toward zero rather than
centring on the observed value. `Gamma` (or `LogNormal`) with mode at the
fitted value is the correct choice.

### Latency paths and onset composition

For each edge with latency, the compiler enumerates the path from the
anchor node to the edge's `from` node. This path determines the chain of
upstream edge-level latency variables whose composition gives the path-level
model used in completeness coupling.

The path model is a **shifted lognormal** (per doc 1 §15.3):

```
T_path = path_delta + LN(path_mu, path_sigma)
```

where:
- `path_delta = Σ_i(onset_delta_i)` — the deterministic sum of all edge
  onsets along the path
- `path_mu`, `path_sigma` — from iterative Fenton-Wilkinson composition of
  the stochastic components `LN(mu_i, sigma_i)` along the chain

**Completeness evaluation** (the CDF used in likelihood coupling):

```
completeness = CDF_LN(max(0, age - path_delta), path_mu, path_sigma)
```

The `max(0, ...)` term means completeness is exactly zero when `age` is less
than `path_delta` — no conversions can arrive before the deterministic onset.
This is consistent with doc 1 §15.3 and §15.3.4.

`path_delta` is deterministic (not a latent variable). `path_mu` and
`path_sigma` are deterministic functions of the latent edge-level
`(mu_i, sigma_i)` variables via FW — differentiable, so NUTS gradients flow
through.

At **join nodes**, the incoming path models are collapsed via moment-matching
(see above) before being composed with the next edge. The `path_delta` at a
join is `min_i(path_delta_i)` — the earliest onset among inbound paths.

Simulation-based composition (sampling from each edge's lognormal within
each MCMC draw) is ruled out — it is not differentiable and would break
NUTS's gradient-based proposals.

### Conditional probabilities

Edges with `conditional_p` entries (e.g. `visited(promo)`,
`context(device:mobile)`) represent different versions of the same edge
depending on a condition. Each condition gets its own probability variable and
evidence binding, but they may share a common prior (pooled toward the base
`p`).

This is structurally similar to the slice layer (Layer 2) — conditions are
effectively named slices with partial pooling.

---

## Layer 2: Contexts

**Source**: graph's `dataInterestsDSL` + parameter file `values[].sliceDSL`

**What it contains**: the `dataInterestsDSL` on the graph might say
`context(channel);context(device)`. This means data is fetched per context
dimension. Parameter files then have `values[]` entries with `sliceDSL`
containing specific context values:

```yaml
values:
  - sliceDSL: 'cohort(landing-page,1-Sep-25:30-Nov-25).visited(classic-cart)'
    n: 1580, k: 1518
  - sliceDSL: 'cohort(landing-page,1-Sep-25:30-Nov-25).visited(quick-cart)'
    n: 1700, k: 1657
  - sliceDSL: 'cohort(landing-page,1-Sep-25:30-Nov-25)'     # aggregate
    n: 3280, k: 3175
```

**What it contributes to the model**:

### Slice identification and double-counting prevention

The compiler groups `values[]` entries by context dimension. In the example
above, `visited(classic-cart)` and `visited(quick-cart)` are two slices of
the `visited` dimension. The aggregate entry (no context qualifier) is the
overall edge-level observation.

**Critical rule**: if slices exhaustively partition the aggregate (i.e.
`n_classic + n_quick ≈ n_aggregate`), the compiler must use **slice-level
likelihood terms only** and discard the aggregate. Otherwise the same
conversions are counted twice — once per slice and once in the aggregate.

The aggregate may still be useful as a posterior check (does the sum of
slice posteriors match it?) but it must **not** enter the likelihood.

If slices are only partial coverage (e.g. there are users in neither
classic nor quick cart), the aggregate contains un-sliced residual
observations. The compiler should then bind only the residual
(`n_aggregate - sum(n_slices)`) as a separate likelihood term for the
edge-level variable, alongside the per-slice terms.

### Per-slice probability with partial pooling

For a solo edge with slices:

```
# Edge-level probability
p_{edge_id} ~ Beta(α, β)

# Per-slice deviations (partial pooling toward edge mean)
τ_slice ~ HalfNormal(σ_τ)
δ_{slice_id} ~ Normal(0, τ_slice)
p_{edge_id}_{slice_id} = logistic(logit(p_{edge_id}) + δ_{slice_id})

# Each slice has its own likelihood
obs_{edge}_{slice} ~ Binomial(n_slice, p_{edge}_{slice}), observed=k_slice
```

### Per-slice Dirichlet for branch groups (the hard case)

If the edge is part of a branch group AND has context slices, the simplex
constraint must hold **per slice independently**. The naive approach (Dirichlet
+ logit deviations) violates this.

Correct approach: a two-level construction with a **learned base simplex**
and per-slice deviations:

```
# Branch-level base simplex (the "typical" split at this node)
base_weights_{node} ~ Dirichlet(α_hyper)

# Concentration parameter (controls how tightly slices cluster around base)
κ_{node} ~ Gamma(...)    # or HalfNormal — must be positive

# For EACH slice independently, draw around the base:
weights_{node}_{slice} ~ Dirichlet(κ_{node} * base_weights_{node})

# Likelihoods per sibling per slice (Multinomial with shared denominator)
obs_{node}_{slice} ~ Multinomial(n_{slice}, weights_{node}_{slice}),
                     observed=[k_B_slice, k_C_slice, n_slice - k_B_slice - k_C_slice]
```

This gives:
- A branch-level mean simplex (`base_weights`) learned from all slices
- Slice-specific deviations around that mean
- Interpretable pooling strength via `κ` — large κ means slices are similar
  to the base, small κ means slices are nearly independent
- Each slice respects its own simplex constraint

A shared concentration alone (without the learned base simplex) would only
control dispersion, not pool slice simplexes toward a common centre. That
distinction matters — without the base simplex, slices aren't actually
borrowing strength in a useful way.

This is the hierarchical Dirichlet pattern described in doc 0, §3.3.

### Context dimensions the compiler must handle

- `context(key:value)` — named context partition (channel, device, etc.)
- `visited(node_id)` — behavioural segment (passed through a specific node)
- `case(test_id:variant)` — A/B test variant (from `conditional_p` or case
  nodes)
- Aggregate (no context qualifier) — the overall edge observation

---

## Layer 3: Window vs cohort data

**Source**: parameter file `values[].sliceDSL` — specifically, whether the
entry uses `window(...)` or `cohort(anchor, ...)`.

**What it contains**:

- **Window entries** (`sliceDSL: window(25-Nov-25:1-Dec-25)`): standard
  event-time observations. The observation period is closed. All conversions
  that will ever happen within this window have already happened (or at least,
  maturity is not in question).

- **Cohort entries** (`sliceDSL: cohort(landing-page,1-Sep-25:30-Nov-25)`):
  anchor-time observations. The date range is a **collection window of
  single-day cohorts** — each day's entrants form an independent cohort.
  The `n_daily` / `k_daily` arrays give per-day observations. Recent days
  may be immature (converters still arriving).

**What it contributes to the model**:

### Window observations → simple likelihood

Window data is mature by assumption. The likelihood is straightforward:

```
obs ~ Binomial(n, p), observed=k
```

No latency coupling needed.

### Cohort observations → completeness-adjusted likelihood

Cohort data may be immature. The observed `(n, k)` undercounts converters
because some are still in transit. The likelihood must account for this.

**Our cohorts are single-day.** The `cohort_from:cohort_to` range is a
collection window of daily cohorts. Each day `i` in `n_daily` / `k_daily`
is an independent single-day cohort with its own age:

```
age_i = today - dates[i]
completeness_i = CDF_LN(max(0, age_i - path_delta), path_mu, path_sigma)
obs_i ~ Binomial(n_daily[i], p * completeness_i), observed=k_daily[i]
```

Each day gets its own completeness factor. Old days (large `age_i`) have
completeness ≈ 1.0. Recent days have lower completeness. There is no need
to approximate cohort age as a single scalar — each daily observation
carries its own age naturally.

Where:
- `path_delta` is the deterministic onset sum along the path from anchor to
  the edge's target node (see Layer 1, Latency paths)
- `path_mu`, `path_sigma` are deterministic functions of the **latent**
  edge-level latency variables along the path (via FW composition)
- `completeness_i` is a deterministic node in the PyTensor graph
- NUTS jointly constrains `p` and latency params through the shared
  likelihood — low observed `k_i` on a recent day can be explained by
  either low `p` or slow latency, and the model resolves this by using
  the older (mature) days as anchors

This is the probability–latency coupling. The compiler must:
1. Classify each `values[]` entry as window or cohort
2. For cohort entries, emit **per-day** likelihood terms from the daily
   arrays, each with its own completeness factor
3. Wire each day's likelihood through the correct path latency chain,
   including onset (`path_delta`)

### Identifiability risk

`p` and completeness are directly confounded in each likelihood term. The
model is identified because:
- Mature daily observations (high `age_i`, completeness ≈ 1) pin down `p`
- Immature observations then constrain latency given the established `p`
- Independent latency evidence (histograms, lag summaries) provides strong
  priors on `(mu, sigma)`

If latency evidence is weak **and** all days are immature, the model will be
poorly identified. The compiler should flag this case (diagnostic) and
consider falling back to a simpler model (treat all observations as mature,
fit latency separately).

### Apparent circularity of completeness

Completeness is a function of latency, and latency is constrained by
observations that use completeness. This looks circular but is not — it is
**joint inference**, which is exactly what MCMC is designed for.

At every NUTS step, the sampler holds concrete values for all latent
variables simultaneously: `(p, mu_1, sigma_1, mu_2, sigma_2, ...)`. It
computes completeness deterministically from those values, evaluates the
joint log probability, and proposes a new point using the gradient. There is
no sequential "first estimate latency, then estimate completeness, then
estimate p" — everything is explored jointly in the full-dimensional
posterior. The coupling between `p` and latency is the model's strength:
it can distinguish "low conversion" from "slow conversion" by comparing
mature and immature daily observations.

There are, however, two real concerns related to this coupling:

**1. Censored latency priors.** The priors for `(mu, sigma)` are derived
from observed lag summaries (`median_lag_days`, `mean_lag_days`). If those
summaries were computed from immature cohort data, they underestimate the
true lag — slow converters haven't arrived yet, pulling the median and mean
downward. This biases the prior toward faster latency, which inflates
completeness, which deflates `p`.

This is a data-preprocessing problem, not a model-structure problem. The
mitigation is:
- Use lag summaries from mature windows whenever available (preferred)
- If only cohort lag data is available, use the slice-level `latency`
  block (which includes histogram and t95), not the per-day lag arrays
  — the slice-level summary is typically computed from a longer horizon
- The model can still correct a biased prior if there is enough mature
  daily data to anchor `p`, but weak priors + all-immature days = poorly
  identified (see identifiability risk above)

**2. Join traffic weights in MCMC.** At non-terminal joins, the
moment-matched collapse uses traffic weights `w_i` derived from edge
probabilities. In the Bayes model, those probabilities are latent variables.
So the collapsed path model at a join is a function of the same latent
variables that the path model constrains through completeness downstream.

MCMC handles this correctly — all variables are explored jointly. But the
additional coupling can slow convergence or create banana-shaped posteriors
(where `p` and latency are correlated). Practical mitigations:
- Strong latency priors (from mature windows or histograms) anchor the
  latency variables independently of the completeness coupling
- The join collapse is a smooth, differentiable function of the weights,
  so NUTS can navigate the correlation efficiently
- For graphs with many joins, monitor `rhat` and ESS carefully — poor
  convergence is a sign the coupling is too tight for the available data

### Completeness — always on, no hard switch

Completeness is applied to **all** cohort daily observations, regardless of
age. For old days, `CDF(age_i - path_delta | mu, sigma) ≈ 1.0` naturally —
the adjustment has no material effect. This avoids a discontinuous model
selection boundary (mature vs immature) and simplifies the compiler.

Maturity classification remains useful for **reporting and diagnostics**
(which edges have well-identified posteriors) but does not create different
likelihood forms in the statistical model.

### Daily arrays are the natural evidence unit

Because cohorts are single-day, the daily arrays (`n_daily`, `k_daily`,
`dates`) are the correct evidence unit. The aggregate `(n, k)` on the
`values[]` entry is just their sum. The compiler should bind **daily-level**
likelihood terms because:

- Each day has a different completeness (different age)
- Per-day terms give the model maximum information for separating `p` from
  latency
- Aggregating to `(total_n, total_k)` would lose the maturity gradient
  that makes the joint model identifiable

---

## Layer 4: Historic snapshot data

**Source**: parameter file `values[]` (sent inline by FE) + snapshot DB
(PostgreSQL, queried by worker)

**What it contains**:

Parameter files carry the evidence directly:

- `values[].n`, `values[].k` — aggregate observed trials and successes
- `values[].n_daily`, `values[].k_daily` — daily breakdown
- `values[].latency.histogram` — lag distribution (day bins with counts)
- `values[].median_lag_days`, `values[].mean_lag_days` — per-date lag
  summaries
- `values[].anchor_median_lag_days`, `values[].anchor_mean_lag_days` —
  upstream anchor-to-X lag per date

**What it contributes to the model**:

### Probability evidence → Binomial likelihood data

Each `values[]` entry with `(n, k)` becomes the `observed` argument to a
`pm.Binomial` (or `pm.Multinomial` for branch groups). The compiler maps
each entry to the correct latent variable based on the entry's `sliceDSL`
and the edge's position in the graph.

### Latency evidence → LogNormal prior parameters

The lag histograms and summary statistics provide the priors for latency
variables. The compiler derives `(mu, sigma)` in **model-space** (onset
subtracted), per doc 1 §15.1:

```
median_X = max(ε, median_lag - onset_delta_days)
mean_X   = max(ε, mean_lag - onset_delta_days)
mu       = ln(median_X)
sigma    = sqrt(2 * (ln(mean_X) - mu))    # floor at 0.01
```

These become the prior parameters for the latency variables:

```
mu_{edge}    ~ Normal(mu, σ_mu)          # σ_mu controls prior uncertainty
sigma_{edge} ~ Gamma(α_σ, β_σ)          # mode at sigma, not zero
```

The `Gamma` parameterisation for `sigma_{edge}` is chosen so that the mode
equals the fitted `sigma` from data. Given a desired mode `m` and prior
spread `s`:

```
α_σ = 1 + (m / s)^2
β_σ = (α_σ - 1) / m
```

This centres the prior on the observed dispersion while allowing the data
to pull it in either direction.

### Multiple values[] windows

A parameter file may have multiple `values[]` entries — different time
windows, different cohorts, different contexts. The compiler must decide
how to combine them:

- **Same context, different time windows**: most recent window is the primary
  evidence. Older windows could contribute to the prior (informal time-series
  pooling) or be excluded by a training-window policy.
- **Same time, different contexts**: separate observations feeding separate
  slice-level likelihood terms (see Layer 2).
- **Window + cohort for the same edge**: the window entry gives a mature
  baseline; the cohort entry adds immature-but-richer latency-coupled
  evidence. Both contribute to the same edge's probability variable but
  with different likelihood forms.

### Anchor lag arrays

Cohort entries include `anchor_median_lag_days` and `anchor_mean_lag_days` —
the observed upstream latency from anchor to the edge's `from` node. These
are evidence for the upstream portion of the latency chain and inform the
path-level completeness calculation.

Where `anchor_onset_delta_days` is available (doc 1 §10.4), the anchor lag
should be fitted in model-space (onset subtracted). Where it is not yet
available, the anchor fit uses user-space moments as a fallback — see doc 1
§15.5, Level 1.

---

## Layer 5: Historic posteriors

**Source**: parameter file `posterior` block (probability) + `latency.posterior`
block. These exist if a previous Bayes run has already fitted this edge.

**What it contains**:

```yaml
posterior:
  alpha: 62.5
  beta: 2.1
  mean: 0.967
  stdev: 0.012
  hdi_lower: 0.941
  hdi_upper: 0.985
  hdi_level: 0.90
  ess: 4200
  rhat: 1.001
  provenance: bayesian
  evidence_grade: 3
  fitted_at: '7-Mar-26'
  fit_history: [...]
```

**What it contributes to the model**:

### Warm-start priors

If the previous posterior is structurally compatible (same graph topology,
same edge identity), the compiler can use it as the prior for the next run:

```
# Instead of:
p_{edge} ~ Beta(1, 1)           # weak prior

# Use:
p_{edge} ~ Beta(62.5, 2.1)     # previous posterior as prior
```

**Critical constraint: non-overlapping evidence.** Warm-starting only works
cleanly if the new evidence is disjoint from the evidence that produced the
old posterior. If the new run includes overlapping data (e.g. a rolling
training window), using the old posterior as prior double-counts those
observations.

The compiler must enforce one of:
- **Disjoint windows only**: the new training window starts after the
  previous run's window ended. The evidence binder verifies this by
  comparing the new evidence date ranges against `fitted_at` and the
  previous run's training window metadata.
- **ESS-discounted warm-start**: if windows overlap, scale down the
  posterior's effective sample size to account for the overlap. E.g. if
  80% of the new data overlaps with the old, discount the posterior ESS
  by 80%. This requires the previous run to record its training window
  boundaries.
- **No warm-start on overlap**: fall back to moment-matched or uniform
  prior whenever windows overlap. Simplest and safest.

The evidence binder must record sufficient metadata (training window
boundaries per edge) to support overlap detection on the next run.

### Compatibility check

The compiler must verify that the previous posterior is still valid:
- Has the graph topology changed? (New edges, removed edges, changed
  branching structure.) If so, the previous posterior is invalid — start
  fresh. The model fingerprint (hash of TopologyAnalysis) detects this.
- Has the edge's structural role changed? (Was solo, now part of a branch
  group.) If so, the Beta posterior can't seed a Dirichlet — start fresh.
- Is the posterior suspiciously old or from a different model version?
  Policy decision on staleness threshold.

### Prior ESS cap (replacing the overflow guard)

Warm-started priors must not accumulate unbounded concentration from many
sequential runs. Rather than the abrupt `if alpha + beta > 500: Beta(2, 2)`
(which destroys all accumulated information), use a **mean-preserving ESS
cap**:

```
ess = alpha + beta
if ess > ESS_CAP:
    alpha' = (alpha / ess) * ESS_CAP    # same mean, reduced concentration
    beta'  = (beta  / ess) * ESS_CAP
```

This preserves the posterior's location (the learned conversion rate) while
smoothly limiting its influence. `ESS_CAP = 500` is a reasonable default —
it means the prior can contribute at most ~500 pseudo-observations, after
which new evidence dominates.

---

## Layer 6: User settings

**Source**: `settings` object in the submit payload (forecasting config,
fit policy).

**What it contains**: knobs that modify compiler decisions without changing
the evidence.

**What it contributes to the model**:

### Training window

Which `values[]` entries to include. Entries outside the training window are
excluded from the likelihood. Controls recency vs sample size trade-off.

### Prior policy

- **Uniform**: `Beta(1, 1)` for all edges (maximally uninformative)
- **Moment-matched**: derive prior from current point estimates
  `(p.mean, p.stdev)` on the graph edge
- **Warm-start**: use previous posterior (Layer 5) if available
- **Default**: warm-start if available, else moment-matched, else uniform

### Exhaustiveness policy

Per-node (or global): are branch groups exhaustive or non-exhaustive?
Determines whether the Dirichlet includes a dropout component.

### Minimum-n threshold

Edges with fewer than `min_n` total observations get weak-prior-only
treatment and are marked `provenance: prior-only`. Default threshold: 10.

Note: **excluding** low-n edges entirely can distort branch group structure
(e.g. a 3-sibling Dirichlet becomes a 2-sibling one, changing the dropout
component). Weak pooling toward the branch mean is often better than
exclusion. The compiler should only fully exclude an edge (`provenance:
skipped`) if it has zero observations.

### Pooling strength

How aggressively to pool across context slices. Controls the prior on
`τ_slice` (the deviation scale). Tight pooling = slices shrink toward the
edge mean. Loose pooling = slices are nearly independent.

### Completeness coupling toggle

Whether to use completeness-adjusted likelihoods for immature cohorts
(Layer 3) or treat all observations as mature. Useful for debugging — if
the coupled model diverges, disabling coupling isolates whether the problem
is in the latency structure or the probability structure.

---

## Layer interactions

The layers are not independent. The compiler must resolve them jointly for
each `values[]` entry. Concretely, for a single observation:

```
confirmed-to-shipped-latency.yaml
values[2]: sliceDSL = 'cohort(landing-page,1-Sep-25:30-Nov-25).visited(classic-cart)'
           n = 1580, k = 1518
```

The compiler must determine:

1. **Graph structure** (Layer 1): edge `confirmed→shipped`. Source node
   `order-confirmed` has out-degree — is this a branch group or solo? Are
   there sibling edges?

2. **Context** (Layer 2): `visited(classic-cart)` — this is a slice of the
   `visited` dimension. Is there a `visited(quick-cart)` sibling slice? If so,
   this edge × slice needs partial pooling.

3. **Window vs cohort** (Layer 3): `cohort(landing-page,...)` — this is a
   cohort observation anchored at `landing-page`. Cohort closed `30-Nov-25`.
   Is it mature? Compute `cohort_age = today - cohort_to`. Compare to
   `path_t95`. If immature → completeness-adjusted likelihood.

4. **Evidence** (Layer 4): `n=1580, k=1518`. Plus per-slice latency histogram
   (`median_lag_days=5.4`, `t95=19.0`). Plus anchor latency
   (`anchor_median_lag_days=3.6`). These inform both the probability
   likelihood and the latency priors.

5. **Previous posterior** (Layer 5): does this edge have a `posterior` block
   from a previous run? If so and structurally compatible → warm-start the
   prior.

6. **Settings** (Layer 6): is this entry within the training window? Does it
   meet the minimum-n threshold? What's the pooling policy?

The compiler resolves all six layers and emits:

```python
# This observation contributes a completeness-adjusted, slice-pooled
# likelihood term to the pm.Model:

p_confirmed_shipped = ...           # from Layer 1 (solo or branch group)
delta_classic_cart = ...             # from Layer 2 (slice deviation)
p_slice = logistic(logit(p_confirmed_shipped) + delta_classic_cart)

# Path latency with onset (from Layer 1 latency chain)
path_delta = onset_landing_confirmed + onset_confirmed_shipped
path_mu = fw_compose(mu_landing_confirmed, sigma_landing_confirmed,
                     mu_confirmed_shipped, sigma_confirmed_shipped).mu
path_sigma = fw_compose(...).sigma

# Completeness with onset subtraction (doc 1 §15.3)
completeness = cdf_lognormal(max(0, cohort_age - path_delta), path_mu, path_sigma)

pm.Binomial("obs_confirmed_shipped_classic_cart",
            n=1580, p=p_slice * completeness, observed=1518)
```

---

## Dropout and abandonment in branch groups

Branch groups include a dropout component (§ Layer 1) representing users who
entered the source node but reached none of the tracked downstream nodes. For
**window** data this is straightforward — the observation period is closed, so
`n_A - k_B - k_C` is the true dropout count.

For **immature cohort** data, the observed dropout is confounded with
not-yet-arrived converters. A user who entered the source node 2 days ago
and typically takes 5 days to convert looks identical, in the data, to a user
who abandoned. The raw residual `n_A - k_B - k_C` overstates dropout.

### Completeness-adjusted Multinomial

The solution is to apply per-sibling completeness factors inside the
Multinomial likelihood, exactly as completeness is applied to solo-edge
cohort observations (§ Layer 3). Each sibling edge has its own path latency
and therefore its own completeness:

```
completeness_B(t) = CDF_LN(max(0, age_t - path_delta_B), path_mu_B, path_sigma_B)
completeness_C(t) = CDF_LN(max(0, age_t - path_delta_C), path_mu_C, path_sigma_C)

p_effective_B = p_B * completeness_B(t)
p_effective_C = p_C * completeness_C(t)
p_effective_dropout = 1 - p_effective_B - p_effective_C

obs_t ~ Multinomial(n_A_t, [p_effective_B, p_effective_C, p_effective_dropout]),
        observed=[k_B_t, k_C_t, n_A_t - k_B_t - k_C_t]
```

This gives the model the freedom to explain a large observed residual as
either true dropout (high `p_dropout`) or immaturity (low completeness
because the latency is long relative to the cohort age). Mature daily
observations anchor the true dropout rate, and immature days then constrain
latency — the same identification logic as solo-edge completeness coupling.

Note that `p_effective_dropout` absorbs both genuine abandonment *and*
not-yet-arrived converters. As `age_t → ∞` all completeness factors → 1.0,
and `p_effective_dropout → 1 - p_B - p_C` — the true long-run dropout rate.
This is correct behaviour: we never observe dropout directly (it's the
absence of an event), so the model should not try to separate "true dropout"
from "censored conversion" until the data matures.

### Shared denominator contract for branch groups

The shared denominator `n_A` is the total traffic at the source node. The
compiler **requires** this from the data — it does not estimate or
approximate it.

**Window observations**: `n_A` is the source node's outbound event count
within the window. This comes from:
- The source node's own parameter file, or
- The query layer: `from(A).to(*).window(...)`

**Cohort observations**: `n_A_t` (per daily cohort) is the number of users
who entered the source node `A` on day `t`. This is available in:
- `anchor_n_daily` when the anchor is upstream of `A`, or
- `n_daily` of the source node's own parameter file

Because completeness applies *per sibling* (not to `n_A`), the denominator
represents the full cohort entering `A` on day `t`, not an adjusted count.
The adjustment is on the probability side.

**If `n_A` is not available**: the compiler falls back to independent
Binomials for that branch group (one per sibling, no shared denominator,
no dropout component) and emits a diagnostic warning. This is a correct
but weaker model — it loses the simplex constraint and cannot estimate
dropout, but it does not produce infeasible likelihoods.

---

## Compiler structure

Given the above, the compiler is three functions:

### 1. `analyse_topology(graph) → TopologyAnalysis`

Walks the graph once. Produces:
- Topo-sorted node order
- Branch groups (which edges are siblings at each branching node)
- Solo edges
- Join nodes with inbound edge lists and traffic weights
- Latency chains (anchor → edge path for each latency-enabled edge)
- Path onset accumulation (`path_delta` per edge)
- Join-collapsed path models (moment-matched at each non-terminal join)

This is purely structural — no evidence, no PyMC. The output is a
serialisable, deterministic data structure. Testable independently with
deterministic assertions on known graph topologies.

**Model fingerprint**: a content hash of TopologyAnalysis. Used for
warm-start compatibility checks — if the fingerprint changes, all previous
posteriors are invalidated.

### 2. `bind_evidence(topology, param_files, settings) → BoundEvidence`

For each edge in the topology, reads the parameter file and classifies each
`values[]` entry:
- Context dimension and slice key
- Window vs cohort, with maturity assessment
- `(n, k)` per entry (aggregate and daily)
- `n_A` resolution for branch groups (source node traffic)
- Latency priors from histogram/summary stats (model-space, onset subtracted)
- Previous posterior for warm-start eligibility (overlap detection)
- Double-counting resolution (slice partition vs residual)
- Training window filtering

This is data wrangling — no PyMC. The output is serialisable. Testable with
real parameter files from the data repo.

**Evidence fingerprint**: a content hash of BoundEvidence (excluding
settings that don't affect model structure, like sampling config). Combined
with the model fingerprint, this determines full cache identity.

### 3. `build_model(topology, evidence) → pm.Model`

Reads the topology analysis and bound evidence, emits PyMC declarations:
- Creates probability variables (Beta or Dirichlet per structural role)
- Creates slice deviations if context slices exist
- Creates latency variables if latency chains exist
- Computes path-level `(path_delta, path_mu, path_sigma)` as deterministic
  nodes from edge-level latents
- Collapses path models at join nodes via moment-matching
- Wires completeness coupling (with onset) for cohort observations
- Binds each observation to its likelihood term

This is the only function that imports PyMC. It is a mechanical translation
of the IR into PyMC calls — all design decisions have already been made by
the first two functions.

---

## Resolved decisions

- ~~Exhaustiveness detection~~: **per-node metadata flag**, not inferred from
  observed counts. At a branching node (e.g. Energy Quiz → {Ineligible,
  Retention, Acquisition, Abandon}), the question is: do the children
  account for *all* traffic, or is there untracked leakage? If exhaustive,
  the Dirichlet has no dropout component (`Σ p_i = 1`). If non-exhaustive
  (the common case), we add a phantom dropout component. We considered
  auto-detecting this from data (`Σ k_i ≈ n_A`?) but sampling noise,
  censoring, and slice incompleteness make that unreliable — so the graph
  author sets a flag per node. Additionally, if a sibling edge's target
  node has no associated event, that edge is implicitly a leakage/dropout
  edge — we cannot measure conversions on it, so it is always the residual
  `n_A - Σ(k_measured_siblings)`.
- ~~Daily arrays vs aggregates~~: **daily-level likelihood terms** for cohort
  data. Each day has its own completeness factor. Aggregating loses the
  maturity gradient.
- ~~Mature/immature hard switch~~: **always use completeness**. Let CDF → 1.0
  naturally for old cohorts. Hard switch removed from the statistical model.
- ~~Prior overflow guard~~: replaced with **mean-preserving ESS cap**.
- ~~Latency composition method~~: **Fenton-Wilkinson only**. Simulation
  within MCMC draws is ruled out (not differentiable).
- ~~Branch group likelihood~~: **Multinomial with shared denominator**, not
  separate Binomials. If the source node's total traffic count (`n_A`) is
  not available from the data, the compiler cannot safely build a
  Multinomial (because if `k_B + k_C > n_A_estimated`, the likelihood is
  mathematically impossible). In that case it falls back to fitting each
  sibling edge independently as `Beta + Binomial` — weaker (loses the
  simplex constraint and dropout estimate) but safe. **Update**: `n_A` is
  in practice always available — the Nquery mechanism provides source-node
  traffic counts for all branch groups. The Binomial fallback is a
  theoretical safety net, not an expected runtime path.
- ~~Hierarchical Dirichlet pooling~~: **base simplex + concentration (κ)**,
  not shared concentration alone.
- ~~Dropout in immature cohorts~~: **completeness-adjusted Multinomial** with
  per-sibling completeness factors. Dropout component absorbs both true
  abandonment and not-yet-arrived converters; they separate naturally as
  cohort data matures.
- ~~Onset in completeness~~: **explicit `path_delta`** in the completeness
  CDF, consistent with doc 1 §15.3. `completeness = CDF_LN(max(0,
  age - path_delta), path_mu, path_sigma)`.
- ~~Latency prior for sigma~~: **Gamma** (or LogNormal) with mode at fitted
  value, not HalfNormal (which has mode at zero).
- ~~Join path ambiguity~~: **moment-matched collapse** at each join node, per
  doc 1 §15.4. Weighted by traffic flow mass from edge probabilities.
  Composable through chains of joins. No unique-path constraint. Dominant-
  path selection replaced.
- ~~Shared denominator source~~: **required from data** (source node event
  count or anchor cohort size). No unsafe approximations (`max(n_B, n_C)` is
  banned). Missing denominator → fall back to independent Binomials.
- ~~IR boundary~~: **TopologyAnalysis and BoundEvidence are the stable IR**.
  Serialisable, deterministic, fingerprintable, engine-independent. Only
  `build_model` imports PyMC.

- ~~Multiple values[] windows~~: **use all windows as likelihood terms**
  with recency weighting. In practice we have effectively contiguous
  `window()` and `cohort()` data over the period (sometimes contexted — in
  which case we reason back from MECE status). The existing recency-weighting
  setting on the graph controls the observation-level scale factor. Newer
  data contributes more to the posterior, older data contributes less but is
  not discarded.
- ~~Slice pooling granularity~~: **per-edge `τ`**. Different edges can have
  very different slice variability (a checkout edge might vary heavily by
  device; a shipping edge might not). The hierarchical model learns this
  naturally — `τ_slice ~ HalfNormal` per edge, with the data determining
  how much shrinkage occurs. No manual tuning needed.

## Open questions

- **Conditional probability entries**: treat as named slices with partial
  pooling, or as hard separate models? The `conditional_p` pattern on edges
  is structurally similar to context slicing but semantically distinct
  (first-match vs additive).

