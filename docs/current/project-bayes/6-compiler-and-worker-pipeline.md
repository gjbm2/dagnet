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
- **Fingerprintable**: two-tier hashing — topology fingerprint (structural
  compatibility, warm-start eligibility) and model fingerprint (full cache
  identity including evidence and settings)
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

If `n_A` is not directly available from the data, the compiler **still
compiles a Multinomial** — the graph's intent is mass-conserving and the
model should reflect that. The compiler estimates `n_A` as
`max(Σ k_siblings, max_i(n_i))` and emits a diagnostic noting the
estimation. If the source data doesn't actually conserve mass (e.g.
`k_B + k_C > n_A` due to timing mismatches or double-counting upstream),
the Multinomial will produce a poor fit — divergences, high r-hat, or
wide posteriors. This is a **data quality signal**, not a modelling error,
and is more useful than silently switching to a different analysis pattern.

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
small. A future `mixture_lognormal` family could avoid this loss entirely
by keeping the mixture as the native path representation — see
"Distribution family extensibility".

### Overdispersion: Beta-Binomial / Dirichlet-Multinomial

**Status**: Implemented (20-Mar-26)

Standard Binomial/Multinomial likelihoods treat every conversion as an
independent trial. With n=3000 people per trajectory-day, the posterior
concentrates far more than the data warrants — day-to-day variation in
conversion rates (marketing mix, seasonality, operational factors) means
the true uncertainty is much larger than Binomial sampling noise.

**Solution**: replace Binomial with Beta-Binomial, Multinomial with
Dirichlet-Multinomial. A per-edge latent concentration parameter κ
controls the degree of overdispersion:

```
κ_{edge} ~ Gamma(3, 0.1)       # mode=20, mean=30, broad tail

# Solo edges: Beta-Binomial
obs ~ BetaBinomial(n, p·κ, (1-p)·κ)

# Branch groups: Dirichlet-Multinomial
obs ~ DirichletMultinomial(n, κ·p_vec)

# Trajectory Potentials: Dirichlet-Multinomial logp
logp = Σ_i [logΓ(count_i + κ·prob_i) − logΓ(κ·prob_i)]
     + logΓ(κ) − logΓ(n + κ)     per trajectory-day
```

Large κ → Binomial (no overdispersion). Small κ → heavy day-to-day
variation. Each edge learns its own κ from trajectory data.

**Observed values** (test graph, 20-Mar-26):

| Edge | κ | Interpretation |
|---|---|---|
| created→delegated | 1.5±0.2 | Heavily overdispersed |
| landing→created | 6.1±1.0 | Moderate |
| registered→success | 11.0±1.4 | Moderate |
| delegated→registered | 23.7±3.9 | Nearly Binomial |

Early funnel edges (traffic-dependent) have much more day-to-day jitter
than later edges (operationally stable). This matches expectation.

**Effect on posteriors**: κ flows through the likelihood into all
parameter posteriors — p, mu, sigma. Edges with small κ have wider
posteriors (less information per trajectory-day). The posterior stdevs
and HDI bands are properly calibrated to real data variation.

**Recency weighting**: trajectory-day logp contributions are weighted by
`w = exp(-ln2 · age / half_life)` (power-posterior interpretation).
Integer counts are used in the logΓ terms; the weight scales the
per-trajectory logp, not the counts.

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
`case(test_id:variant)`) represent mutually exclusive alternative versions of
the same edge. Conditionals are **separate simplexes, not pooled slices** —
they are semantically distinct from context slices. Context slices represent
additive deviations from a shared base (partial pooling); conditionals
represent mutually exclusive substitution (first-match), where each condition
defines a genuinely different population.

**Branch-group-level semantics**: a conditional on any sibling in a branch
group creates a **virtual fork** — a complete alternative Dirichlet simplex
for the branch group under that condition. The UI enforces coherence: all
siblings must have matching conditional entries (the condition applies to the
branch group, not individual edges). Each condition gets its own independent
simplex with its own latent variables. No pooling between conditions — they
represent genuinely different populations.

**Evidence binding**: the conditional's own `values[]` entries (which already
exist — the data pipeline fetches them on the conditional params) bind to the
condition-specific simplex. The default `values[]` bind to the default
simplex. The existing DSL keying identifies which condition each observation
belongs to.

**Downstream propagation — current limitation**: the model is parameterised
at the explicit conditional level only. Downstream edges that don't carry
their own conditionals use a single blended `p` from all populations. This is
correct given available data — the data pipeline currently fetches
condition-sliced observations only on the conditional params themselves, not
on downstream edges. Without per-condition observations downstream,
per-condition latent variables would be unidentified.

**Downstream propagation — future extension**: when the data pipeline extends
to produce condition-sliced cohort observations on downstream edges (e.g.
`cohort(Landing,...).conditional(visited-comparison:true)` on
Purchase→Cancelled), the compiler can introduce per-condition latent variables
downstream and route each condition-slice to its own virtual world. This
requires no model redesign — the same machinery (separate latent variables,
DSL-keyed evidence routing) applies at any edge. The constraint is data
availability, not model architecture.

**Why this matters for cohort data**: a cohort anchored upstream of a
conditional fork (e.g. `cohort(Landing,...)` on Purchase→Cancelled) traverses
the fork. The observed (n, k) on downstream edges is a blend of
condition-specific populations that may have genuinely different conversion
rates. Until condition-sliced downstream data is available, this population
heterogeneity manifests as overdispersion — wider posteriors and potentially
elevated diagnostics (divergences, poor r-hat). This is an honest signal to
the graph author that unmodelled structure exists.

**Completeness at joins downstream of conditionals**: even without
per-condition probability variables downstream, the completeness model can
account for the conditional's effect on path weights at join nodes. The
join-weight computation uses blended weights:
`blended_w = f_X * w|X + (1-f_X) * w_default`, where `f_X` is the observed
condition fraction and `w|X`, `w_default` are deterministic functions of the
upstream latent simplexes. This is fully differentiable and adds no latent
variables.

**Cost**: one extra Dirichlet (or set of independent Betas in Phase A) per
condition per branch group. Linear in the number of conditionals. No
combinatorial explosion — downstream propagation is handled by deterministic
weight blending, not by multiplying latent variable counts.

**Phasing**: Phase A–B treat conditionals as unsupported (compiler recognises,
logs diagnostic, skips). Phase C introduces conditional support at the
branch-group level (separate simplexes, existing condition-sliced data). Full
downstream propagation is a future feature contingent on data pipeline
extension.

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

### MECE classification and cross-product contexts

Not all context dimensions are mutually exclusive and collectively
exhaustive (MECE). The compiler must know which dimensions are MECE because
this determines whether the partition-based double-counting prevention
(above) applies.

**MECE dimensions** (each user belongs to exactly one value):
- `context(channel:*)` — channel attribution is exclusive by construction
- `context(device:*)` — exclusive within a session
- `case(test:variant)` — A/B assignment is exclusive by construction

**Non-MECE dimensions** (a user can appear in multiple values):
- `visited(node_id)` — a user can visit multiple nodes

**Classification**: the compiler classifies each context dimension as MECE
or non-MECE based on a **per-dimension metadata flag** on the graph's
`dataInterestsDSL`. This is analogous to the per-node exhaustiveness flag
for branch groups — sampling noise makes runtime detection unreliable.

**Cross-product explosion**: `context(channel);context(browser_type)` with
5 channels × 4 browser types = 20 slices. Each slice gets its own
deviation variable + likelihood term. For a branch group with 3 siblings,
that's 60+ variables for one node. This is feasible but the compiler must
enumerate it explicitly and the evidence binder must track which
cross-product cells have data. Cross-products of MECE dimensions are
themselves MECE, so the partition logic applies normally.

**Rules by MECE status**:
- **MECE dimensions**: slice-level Dirichlet/pooling with partition-based
  double-counting prevention. If slices exhaustively cover the aggregate,
  exclude the aggregate. If partial, compute the residual.
- **Non-MECE dimensions**: independent per-slice likelihoods without the
  partition constraint. No residual computation (residual is undefined when
  slices overlap). No aggregate exclusion — but the aggregate and per-slice
  observations are not independent, so the compiler should use only the
  per-slice terms and exclude the aggregate to avoid double-counting from
  the overlap direction. The model treats each slice as a separate
  observation of the same underlying `p` (or `p_slice` with pooling).
- **Mixed**: if both MECE and non-MECE dimensions are present, the compiler
  handles each dimension independently. MECE dimensions partition within
  each non-MECE slice (or vice versa). The cross-product logic applies only
  to MECE × MECE products.

---

## Layer 3: Window vs cohort data

**Source**: parameter file `values[].sliceDSL` — specifically, whether the
entry uses `window(...)` or `cohort(anchor, ...)`. With snapshot DB
evidence (Phase S), the source is the `slice_key` column on each DB
row.

### Terminology convention

**Cohort** (capital C): a group of people who commenced something on
a specific date — an independent experiment group. Both `window()`
and `cohort()` slices produce Cohorts; the difference is how those
Cohorts are observed. The word "Cohort" in this document always means
the statistical unit (people × date), not the DagNet slice type.

**`window()` slice**: edge-anchored observation. Denominator is `x`
(entrants at the from-node). Completeness depends on **edge-level**
latency only (single hop, no upstream path).

**`cohort()` slice**: path-anchored observation. Denominator is `a`
(anchor entrants). Completeness depends on **path-level** latency
(full path from anchor to target, including upstream edges).

### Underlying data shape: symmetric

Both `window()` and `cohort()` slices have the same underlying
structure — a collection of Cohorts (one per `anchor_day`), each
observed at successive as-at dates (`retrieved_at`), forming a
monotonic cumulative distribution:

```
Cohort 2025-11-19:
  age 82d → y=329    (as at 2026-02-09)
  age 84d → y=329    (as at 2026-02-11)

Cohort 2025-11-20:
  age 81d → y=258    (as at 2026-02-09)
  age 83d → y=258    (as at 2026-02-11)
```

Each Cohort is an independent experiment. The as-at dates are
successive measurements of the same monotonic cumulative count.
The trajectory constrains **both** the probability and the latency
distribution jointly — you cannot separate them because the
maturation curve shape reflects both.

**What differs** between `window()` and `cohort()` is not the data
shape but the **anchoring**:

| | `window()` | `cohort()` |
|---|---|---|
| Denominator | `x` (from-node entrants) | `a` (anchor entrants) |
| Probability | `p_window` (edge-level) | `p_path_cohort` (path product) |
| CDF | edge-level `CDF(t \| mu_XY, sigma_XY)` | path-level `CDF(t \| path_mu, path_sigma)` |
| Latency constraint | Direct, single hop — pins edge latency cleanly | Path-level — couples upstream edges |

**What it contains** (parameter file evidence):

- **Window entries** (`sliceDSL: window(25-Nov-25:1-Dec-25)`): event-time
  observations on a single edge X→Y. The observation period is defined but
  recent entries within the window may still be immature — converters with
  long X→Y latency haven't arrived yet. Completeness depends on the
  **edge-level** latency only (no upstream path).

- **Cohort entries** (`sliceDSL: cohort(landing-page,1-Sep-25:30-Nov-25)`):
  anchor-time observations. The date range is a **collection window of
  single-day Cohorts** — each day's entrants form an independent Cohort.
  The `n_daily` / `k_daily` arrays give per-day observations. Recent days
  may be immature. Completeness depends on the **path-level** latency
  (anchor → edge target, including upstream edges).

**What it contributes to the model**:

### Window and cohort: related but distinct distributions

`window()` and `cohort()` observations of the same edge X→Y are
**related but not identical**. They differ in two ways that both
scale with path complexity:

1. **Temporal spread (diffusion).** Cohort members enter A within a date
   range but arrive at X **spread across the A→X path latency** — which
   can span weeks or months. Each sub-group experiences whatever `p_XY`
   was at the calendar date they arrived. Even if `p_XY` is perfectly
   stable, the convolution over the arrival distribution widens the
   distribution of cohort outcomes relative to a temporally localised
   window observation.

2. **Temporal shift (real drift in `p_XY`).** Conversion rates change
   over time. Window data captures the current rate (narrow calendar
   window). Cohort data reflects a time-weighted blend of historical
   rates across the arrival spread. When `p_XY` is trending, these
   diverge — and the divergence is a real, valuable signal about changing
   conversion performance.

Both effects increase with path length. For the first edge from anchor
(path = edge, no temporal spread), they vanish — window and cohort
measure the same thing. For deeply downstream edges with `path_t95` of
100+ days, the two observations can represent materially different
distributions.

**Why this matters for forecasting**: window data arrives early and
captures recent conversion performance. It is the best early indicator
of what a mature cohort will eventually show. The model must use window
evidence to **guide** cohort fit expectations — not as an identical
constraint, but as a leading signal that the cohort estimate is pooled
toward.

### Model structure: hierarchical pooling with path-informed divergence

The model creates **separate probability variables** for window and
cohort observations, linked through a shared base with partial pooling.
The allowed divergence between them scales with path complexity:

```
# Shared base probability for edge X→Y
logit_p_base_XY ~ Normal(μ_prior, σ_prior)

# Graph-level temporal volatility (learned — how much do conversion
# rates in this graph tend to vary over time?)
σ_temporal ~ HalfNormal(σ_temporal_prior)

# Path-informed divergence allowance for the cohort
# path_sigma_AX = stdev of A→X arrival distribution (from latency model)
# More temporal spread → more room for cohort to differ from window
τ_cohort_XY = σ_temporal · path_sigma_AX

# Window probability: close to the base (direct, temporally localised)
τ_window = small constant or HalfNormal with tight prior
logit_p_window_XY ~ Normal(logit_p_base_XY, τ_window)

# Cohort probability: can diverge by path-scaled amount
logit_p_cohort_XY ~ Normal(logit_p_base_XY, τ_cohort_XY)

p_window_XY = sigmoid(logit_p_window_XY)
p_cohort_XY = sigmoid(logit_p_cohort_XY)
```

**Behaviour at the extremes**:

- **First edge from anchor** (`path_sigma_AX ≈ 0`): `τ_cohort ≈ 0`,
  so `p_cohort ≈ p_window ≈ p_base`. Window and cohort are forced to
  agree. Correct — there is no temporal spread.

- **Deep downstream edge** (`path_sigma_AX` large): `τ_cohort` is
  large, so the cohort can diverge from the window-guided base.
  Correct — the cohort observation integrates over a wide calendar
  spread and may reflect a materially different effective rate.

- **Stable graph** (`σ_temporal → 0`): all τ_cohort values shrink,
  forcing agreement everywhere. The model learns from the data that
  rates aren't moving, and behaves like a shared-p model.

- **Volatile graph** (`σ_temporal` large): cohort estimates are free
  to diverge from window. The model has learned that rates move, and
  gives the cohort evidence room to express a different effective rate.

**Window as leading indicator**: because both `p_window` and `p_cohort`
are pooled toward the same `p_base`, new window evidence shifts the
base, which pulls the cohort estimate. This is the architectural
encoding of "window data guides cohort expectations." The cohort can
deviate from this guidance, but only by the amount the path complexity
warrants. When the cohort later matures and confirms or contradicts the
window's signal, that evidence flows back into the base and into
`σ_temporal`.

### Window observations → edge-level completeness

Both `window()` and `cohort()` slices describe evolving Cohorts — the
same underlying data shape (Cohorts × as-at ages → monotonic
cumulative counts). For `window()`, each Cohort's completeness
depends only on the **edge's own** latency — no upstream path.

**Parameter-file evidence** (single retrieval per day): each
observation has an effective observation time. Completeness:

```
obs_time_j = window_end - event_date_j
completeness_j = CDF_LN(max(0, obs_time_j - onset_XY), mu_XY, sigma_XY)
obs_j ~ Binomial(n_j, p_window_XY * completeness_j), observed=k_j
```

**Snapshot evidence** (multiple retrievals per day): window Cohorts
form trajectories with the same structure as `cohort()` trajectories.
Each Cohort day has `x` entrants (from-node) and successive
observations of cumulative `y` at increasing ages. The trajectory
jointly constrains `p_window` and edge-level latency:

```
# Window trajectory for Cohort day i on edge X→Y
# x_i entrants at from-node, observed at ages t_1, t_2, ..., t_k
# CDF is edge-level only (single hop)
interval_probs = [
    p_window * CDF_edge(t_1),
    p_window * (CDF_edge(t_2) - CDF_edge(t_1)),
    ...,
    1 - p_window * CDF_edge(t_k),
]
```

Because this couples only to the edge-level `(mu_XY, sigma_XY)`, the
window provides a **direct, single-hop constraint** on both `p_window`
and edge latency. No upstream latency uncertainty dilutes the signal.
This makes window trajectory data the cleanest source for identifying
edge latency parameters.

### Cohort observations → path-level completeness

`cohort()` data may be immature. The observed `(a, y)` undercounts
converters because some are still in transit **along the full path**
from anchor.

**Our Cohorts are single-day.** The `cohort_from:cohort_to` range is
a collection window of daily Cohorts. Each day `i` in `n_daily` /
`k_daily` is an independent single-day Cohort with its own age:

```
age_i = today - dates[i]
completeness_i = CDF_LN(max(0, age_i - path_delta), path_mu, path_sigma)
obs_i ~ Binomial(n_daily[i], p_cohort_XY * completeness_i), observed=k_daily[i]
```

Each day gets its own completeness factor. Old days (large `age_i`) have
completeness ≈ 1.0. Recent days have lower completeness. There is no need
to approximate cohort age as a single scalar — each daily observation
carries its own age naturally.

Where:
- `path_delta` is the deterministic onset sum along the **full path** from
  anchor to the edge's target node (see Layer 1, Latency paths)
- `path_mu`, `path_sigma` are deterministic functions of the **latent**
  edge-level latency variables **along the entire path** (via FW
  composition) — including upstream edges, not just X→Y
- `completeness_i` is a deterministic node in the PyTensor graph
- NUTS jointly constrains `p_cohort` and all path latency params through
  the shared likelihood — low observed `k_i` on a recent day can be
  explained by either low `p_cohort` or slow latency **anywhere on the
  path**, and the model resolves this by using the older (mature) days
  as anchors

### Why the hierarchical registration matters

Window and cohort observations for the same edge participate in a single
`pm.Model` but bind to **separate probability variables** (`p_window_XY`
and `p_cohort_XY`) linked through a shared base. They share the same
edge-level latency variables `mu_XY`, `sigma_XY` — the latency model is
the same physical process regardless of observation type. The probability
is what differs, because the two observation types sample different
temporal windows of that process.

The hierarchical structure gives the model four properties:

1. **Window terms anchor the base.** Because `p_window` is tightly
   coupled to `p_base` and window completeness couples only to
   `(mu_XY, sigma_XY)` — one hop, no upstream uncertainty — the window
   data pins down the base rate and edge latency quickly, even while
   cohort data is still immature.

2. **The base guides cohort expectations.** Through the shared `p_base`,
   the window's constraint on the current rate propagates to the cohort
   estimate. This is the "window as canary" mechanism: early window
   evidence sets expectations for what the maturing cohort should show.

3. **The cohort can deviate by the amount the path warrants.** The
   path-informed `τ_cohort` gives the cohort room to express a
   different effective rate — reflecting both the diffusion from path
   convolution and any real temporal drift. The model doesn't force
   agreement when disagreement is physically expected.

4. **Divergence between window and cohort is a signal, not noise.**
   When `p_window` and `p_cohort` posteriors separate, this is real
   information: conversion rates have been changing over the period
   spanned by the cohort's arrival spread. The magnitude of the
   divergence, calibrated against `σ_temporal`, tells you how unusual
   the movement is for this graph. This is a first-order forecasting
   signal — it directly informs expectations about future cohort
   maturation.

If window and cohort evidence are **inconsistent** beyond what
`τ_cohort` can absorb (e.g. the window implies `p = 0.3` but the
mature end of the cohort implies `p = 0.15` on a short path), the
shared `p_base` will be pulled in both directions, producing wide
posteriors and diagnostics (r-hat, divergences). This signals either
genuine rapid rate change, misaligned observation windows, or
double-counting — all of which warrant investigation.

### Compiler responsibilities

The compiler must:
1. Classify each `values[]` entry as window or cohort
2. For each edge with both types, emit the hierarchical probability
   structure: `p_base`, `p_window`, `p_cohort` with path-informed
   `τ_cohort` derived from the A→X path latency spread
3. For edges with only window data: emit `p_window` only (no cohort
   variable needed). `p_base ≈ p_window`.
4. For edges with only cohort data: emit `p_cohort` only. `p_base`
   is constrained by the cohort alone (no window guidance).
5. For window entries, emit likelihood terms with **edge-level**
   completeness (single-hop: `onset_XY`, `mu_XY`, `sigma_XY`)
6. For cohort entries, emit **per-day** likelihood terms from the daily
   arrays, each with **path-level** completeness (full chain from anchor)
7. For window terms, use edge-level latency `(mu_base_XY, sigma_base_XY)`
   directly. For cohort terms, use cohort-level latent path latency
   `(onset_cohort_XY, mu_cohort_XY, sigma_cohort_XY)` with the
   FW-composed edge latency as prior (see "Hierarchical latency")
8. Emit `σ_temporal` as a graph-level hyperparameter (one per graph,
   shared across all edges). Emit `σ_latency_temporal` similarly for
   latency divergence allowance

### Identifiability

The model is identified through a combination of mechanisms:

**Probability identification**:
- Window observations (especially mature ones with completeness ≈ 1)
  directly constrain `p_window`
- Cohort observations (especially mature daily entries) directly
  constrain `p_cohort`
- The shared `p_base` and `σ_temporal` are informed by the pattern
  of agreement/disagreement across all edges in the graph
- When only one observation type exists for an edge, the missing type
  collapses to the base (no divergence to estimate)

**Latency identification** (unchanged from the coupling discussion):
- Mature daily observations (high `age_i`, completeness ≈ 1) pin down
  `p_cohort` independently of latency
- Immature observations then constrain latency given the established
  `p_cohort`
- Independent latency evidence (histograms, lag summaries) provides
  strong priors on `(mu, sigma)`

**`σ_temporal` identification**: this is a graph-level parameter
informed by the divergence pattern across all edges. Graphs with many
edges provide strong signal. Graphs with few edges may have wide
posteriors for `σ_temporal`, which is appropriate — the model is
uncertain about how volatile rates are in a small graph.

If latency evidence is weak **and** all days are immature, the model
will be poorly identified. The compiler should flag this case
(diagnostic) and consider falling back to a simpler model (treat all
observations as mature, fit latency separately).

### Hierarchical latency: mirroring the probability structure

**Date**: 19-Mar-26
**Status**: Design — follows from Phase D implementation experience

The probability dimension has a hierarchical structure: `p_base` →
`p_window` (tight pooling) → `p_cohort` (path-informed divergence via
`τ_cohort = σ_temporal · path_sigma_AX`). This accommodates temporal
diffusion and drift between the two observation types.

The latency dimension needs the same structure. Currently, window and
cohort share the same edge-level `(mu_XY, sigma_XY)` directly. This
creates two problems:

1. **The cohort CDF uses FW-composed path latency from edge latents,
   but the output is edge-level.** The FE needs a usable shifted
   lognormal `(onset, mu, sigma)` at cohort level. FW composition of
   edge posteriors gives `path_mu` and `path_sigma`, but the path onset
   is a noisy sum of edge-level histogram-derived point estimates. The
   cohort trajectory data directly constrains when conversions start
   arriving — richer evidence for path onset than the sum of edge
   estimates.

2. **Temporal diffusion and drift affect latency, not just probability.**
   Cohort members enter the anchor across a date range and arrive at
   intermediate nodes spread across the path latency distribution. This
   arrival spread means the effective latency distribution at cohort
   level is broader than what edge-level FW composition predicts. If
   latency is also drifting (product getting faster or slower), the
   cohort integrates over multiple latency regimes — the same effect
   that `σ_temporal` accommodates for probability.

#### Hierarchical latency model

Mirror the probability hierarchy into the latency dimension:

```
# Edge-level base latency (anchored by window data)
mu_base_XY    ~ Normal(mu_prior, sigma_mu_prior)
sigma_base_XY ~ Gamma(alpha, beta)   # mode at observed dispersion

# Window latency: tightly pooled toward base (direct, single-hop)
# In practice, window uses (mu_base, sigma_base) directly — no
# separate window latency variable needed (same argument as τ_window
# being a small constant for probability).

# Cohort path-level latency: can diverge from base
# Onset is latent — constrained by cohort trajectory data
onset_cohort_XY ~ HalfNormal(onset_prior)   # prior from Σ edge onsets

# Path mu and sigma: allowed to deviate from FW-composed edge base
mu_cohort_XY    ~ Normal(mu_path_composed, τ_mu_cohort)
sigma_cohort_XY ~ Normal(sigma_path_composed, τ_sigma_cohort)

# Divergence allowance mirrors the probability structure:
# τ_mu_cohort = σ_latency_temporal · path_complexity_factor
# τ_sigma_cohort = similar
```

Where:
- `mu_path_composed`, `sigma_path_composed` are the deterministic FW
  composition of upstream edge-level `(mu_base, sigma_base)` — the
  prior expectation for path latency
- `onset_cohort_XY` is latent with prior centred on `Σ edge_onsets`
- `τ_mu_cohort` and `τ_sigma_cohort` allow the cohort path latency to
  deviate from the FW-composed edge-level prediction, absorbing
  temporal diffusion and drift effects

#### Window CDF (unchanged)

```
CDF_window = CDF_LN(max(0, age - onset_edge), mu_base_XY, sigma_base_XY)
```

Single hop, edge-level, clean signal. Pins `(mu_base, sigma_base)`.

#### Cohort CDF (uses cohort-level latency)

```
CDF_cohort = CDF_LN(max(0, age - onset_cohort_XY), mu_cohort_XY, sigma_cohort_XY)
```

Path-level, with all three parameters fitted. The cohort trajectory
data directly constrains the shape (mu, sigma) AND the shift (onset).

#### Posterior output

The model produces two latency summaries per edge:

- **Edge-level** (from window): `(onset_edge, mu_base, sigma_base)` —
  the canonical fast-learning edge model. Used for `window()` analysis
  and as the building block for path composition.

- **Path-level** (from cohort): `(onset_cohort, mu_cohort, sigma_cohort)`
  — the fitted cohort application model. Directly usable for `cohort()`
  analysis rendering. No FW composition needed at consumption time.

This satisfies the contract from doc 1 §6: "`X→Y` remains the
canonical latent model family; `A→Y` path behaviour is a deterministic
path-level application of those edge latents" — except that the
application is now informed by cohort-level evidence rather than being
a pure deterministic composition. The FW composition serves as the
**prior** for the cohort latency; the cohort trajectory data provides
the **posterior correction**.

#### Joint structure: the four connections

The probability and latency dimensions for window and cohort form a
coupled square. All four connections live in the same `pm.Model`:

```
              p dimension              latency dimension
            ┌──────────────┐         ┌────────────────────┐
  window:   │ p_window_XY  │─────────│ mu_base, sigma_base│
            │ (tight pool) │  joint  │ (edge-level)       │
            └──────┬───────┘  CDF    └────────┬───────────┘
                   │                          │
          p_base + σ_temporal      FW prior + σ_latency_temporal
                   │                          │
            ┌──────┴───────┐         ┌────────┴───────────┐
  cohort:   │ p_cohort_XY  │─────────│ onset_cohort,      │
            │ (path diverge)│  joint │ mu_cohort,          │
            └──────────────┘  CDF    │ sigma_cohort        │
                                     └────────────────────┘
```

1. **window.p ↔ window.latency** (horizontal, top): joint in the
   window CDF. `p_window * CDF(age - onset_edge, mu_base, sigma_base)`.
   Window trajectory shape separates level (p) from shape (latency).

2. **window.p ↔ cohort.p** (vertical, left): hierarchical via
   `p_base` + `τ_cohort = σ_temporal · path_sigma_AX`. Window anchors
   the base; cohort can deviate proportional to path complexity.

3. **window.latency ↔ cohort.latency** (vertical, right): hierarchical
   via FW-composed prior + `τ_mu_cohort`. Edge-level latency anchors
   the path expectation; cohort latency can deviate to absorb temporal
   diffusion, drift, and onset correction.

4. **cohort.p ↔ cohort.latency** (horizontal, bottom): joint in the
   cohort CDF. `p_path * CDF(age - onset_cohort, mu_cohort, sigma_cohort)`.
   The maturation curve shape constrains both simultaneously — low
   observed k can be explained by low p_path OR slow path latency,
   and the model resolves this using the age gradient across days.

NUTS explores the full joint. The window side pins both p and latency
quickly (single hop, clean signal). Those feed as priors/anchors into
the cohort side, which has room to deviate on both dimensions
proportional to path complexity. The four connections are not
independent — they form a single coupled posterior.

#### Behaviour at extremes

- **First edge from anchor** (`path_sigma_AX ≈ 0`): `τ_mu_cohort ≈ 0`,
  so `mu_cohort ≈ mu_base`, `sigma_cohort ≈ sigma_base`,
  `onset_cohort ≈ onset_edge`. Window and cohort agree. Correct — no
  temporal spread, no path composition.

- **Deep downstream edge** (large `path_sigma_AX`): `τ_mu_cohort` is
  large, allowing the cohort path latency to diverge from the
  FW-composed edge prediction. The cohort trajectory data (which
  directly observes the path-level maturation curve) drives the fit.

- **No cohort data**: `mu_cohort` collapses to the FW-composed prior.
  The output is the deterministic composition — the best available
  estimate without cohort evidence.

#### Interaction with temporal drift (Phase D step 3)

When time-binned latency is active (`mu_t` per bin), the FW-composed
prior for `mu_cohort` uses the current-regime bin's composition. The
cohort latency can still deviate from this, but the prior tracks the
latest edge-level regime. `σ_latency_temporal` (the latency analogue
of `σ_temporal`) governs how much the cohort path latency can diverge
from the current edge composition — it is calibrated from
`fit_history` latency trajectory variance, same mechanism as
`σ_temporal` for probability.

#### Implementation phasing

This is a natural extension of Phase D:

- **Phase D step 2** (current): FW-composed path CDF for cohort, shared
  edge-level `(mu, sigma)`. Output is edge-level only.
- **Phase D step 2.5** (this design): add `(onset_cohort, mu_cohort,
  sigma_cohort)` as latent variables for cohort path latency. Output
  both edge-level and path-level latency posteriors.
- **Phase D step 3**: time-binned `mu_t` per edge. The FW-composed
  prior for `mu_cohort` uses the current bin. `σ_latency_temporal`
  calibrated from `fit_history`.

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

### Maturation trajectory likelihood (Phase S)

The snapshot DB stores multiple retrievals of the same cohort day at
different ages. This is richer evidence than a single `(n, k)` point:
it traces the CDF shape directly. The correct likelihood for this data
is a **Multinomial over retrieval intervals**, not independent Binomials.

#### Why not independent Binomials

Snapshot rows for the same cohort day at different retrieval ages are
**cumulative**: `k` at age 20 includes the converters already counted
at age 10. Treating each retrieval as an independent
`Binomial(n, p · CDF(tⱼ))` double-counts the early converters.

#### The denominator problem for downstream edges

For an edge X→Y in a chain A→X→Y with an A-anchored cohort, the
snapshot row at each retrieval age `t` gives:

- `a` = anchor entrants (entered A on this cohort day) — **constant**
- `x(t)` = entrants who have reached X by age `t` — **grows over time**
- `y(t)` = converters who have reached Y by age `t` — **grows over time**

A Multinomial requires a **fixed denominator**. Using `x` as the
denominator fails because `x` changes between retrieval ages: new
arrivals at X between retrievals contribute new potential Y-converters
that weren't in the earlier denominator. The `y`-increments between
ages conflate two sources — new Y-converters from the previously-at-X
pool and new Y-converters from newly-arrived-at-X entrants.

**For the first edge from anchor** (A→X), `x` is not relevant — the
denominator is `a`, which is constant. The problem only arises for
downstream edges.

#### The correct formulation: anchor-based denominator with path probability

The solution is to use **`a` (anchor entrants) as the denominator for
all edges**, with the **path-level probability** `p_path` (product of
per-edge probabilities along the path from anchor to this edge's
target) in the interval probabilities.

**Generative model.** Each of the `a` anchor entrants independently:

1. Converts at A→X with probability `p_AX`. If so, lag
   `T_AX ~ onset_AX + LN(mu_AX, sigma_AX)`.
2. Converts at X→Y with probability `p_XY`. If so, lag
   `T_XY ~ onset_XY + LN(mu_XY, sigma_XY)`.
3. Total time to reach Y: `T_total = T_AX + T_XY`.
4. Observed as having reached Y at retrieval age `t` iff
   `T_total ≤ t`.

The probability of reaching Y by age `t` is:

```
P(at Y by t) = p_AX · p_XY · CDF_path(t)
```

where `CDF_path(t) = P(T_AX + T_XY ≤ t)` — the FW-composed path-level
CDF, which the compiler already computes (see §Latency paths and onset
composition).

More generally, for an edge at any depth in the graph:

```
P(at target by t) = p_path · CDF_path(t)
```

where `p_path = ∏ p_edge` along the path from anchor to the edge's
target node, and `CDF_path` is the FW-composed shifted lognormal CDF
for the full path.

#### Interval partition

At any retrieval age `t`, each of the `a` anchor entrants is in one of
two observable states:

- **At Y** (reached the target by age `t`): probability `p_path · CDF_path(t)`
- **Not at Y** (either won't convert or hasn't arrived yet):
  probability `1 - p_path · CDF_path(t)`

Given retrieval ages `t₁ < t₂ < ... < tₘ` with cumulative target
counts `y₁ ≤ y₂ ≤ ... ≤ yₘ`, the `a` entrants partition into `m + 1`
mutually exclusive groups:

| Group | Description | Count | Probability |
|---|---|---|---|
| 0 | Reached target by `t₁` | `y₁` | `p_path · CDF_path(t₁)` |
| j (1 ≤ j < m) | Reached target in `(tⱼ, tⱼ₊₁]` | `yⱼ₊₁ - yⱼ` | `p_path · [CDF_path(tⱼ₊₁) - CDF_path(tⱼ)]` |
| m | Not at target by `tₘ` | `a - yₘ` | `1 - p_path · CDF_path(tₘ)` |

**Likelihood:**

```
(y₁, Δy₂, ..., Δyₘ, a - yₘ) ~ Multinomial(a, [π₀, π₁, ..., πₘ])
```

This is **exact** (up to the FW approximation of the path CDF). Each
entrant falls into exactly one interval. The denominator `a` is
constant across all retrieval ages.

#### First-edge degeneracy

For the first edge from anchor (A→X), `p_path = p_AX` and
`CDF_path = CDF_AX`. The formulation reduces to:

```
(y₁, ..., a - yₘ) ~ Multinomial(a, [p_AX · CDF_AX(t₁), ..., 1 - p_AX · CDF_AX(tₘ)])
```

No upstream path — this is a standard single-edge trajectory. With a
single retrieval (m = 1), it further degenerates to the existing
Phase A per-day Binomial: `Binomial(a, p_AX · CDF_AX(t₁))`.

#### The `x` column

Each snapshot row provides `x(t)` (from-step entrants at this
retrieval age). In the anchor-based formulation, **`x` is not used in
the likelihood**. The model predicts `x(t) = a · p_AX · CDF_AX(t)` as
a derived quantity, but does not condition on it. The observed `x`
serves as a diagnostic check: if the model's predicted `x(t)` diverges
substantially from observed `x(t)`, the upstream edge parameters may
be poorly estimated.

Each edge uses only its own `y` column from its own snapshot rows,
with `a` as denominator. The `x` observations from edge X→Y's snapshot
rows are NOT used as likelihood data for the upstream A→X edge — the
A→X edge has its own snapshot rows providing its own `y` trajectory.
Using both would double-count the A→X conversion evidence.

#### Inter-edge coupling

The X→Y trajectory likelihood contains `p_path = p_AX · p_XY` — a
product of the upstream edge's probability and the edge's own
probability. This means the Y trajectory evidence constrains both
`p_AX` and `p_XY` jointly. This is a departure from the existing
Phase A model where each edge's likelihood references only its own `p`
and uses `x` as a fixed denominator.

The coupling is **correct and desirable**. The Y trajectory IS evidence
about upstream conversion: fewer people reaching Y than expected could
mean lower `p_AX`, lower `p_XY`, or slower latency anywhere on the
path. The Multinomial interval structure lets the sampler disentangle
these through the CDF shape — the *pattern* of when converters arrive
disambiguates `p` from latency.

In the existing Phase A model, using `x` as a fixed denominator
implicitly conditions on upstream performance without letting the model
reason about it. The anchor-based formulation makes the dependency
explicit and exploits the joint constraint.

In PyMC, `p_path` is a PyTensor expression — a product of latent
variables — and gradients flow through. NUTS explores the joint
`(p_AX, p_XY, mu_AX, sigma_AX, mu_XY, sigma_XY)` space, with the
trajectory Multinomial providing structured gradient information about
the full path.

#### What this constrains

The trajectory jointly identifies `p_path` and the path CDF shape:

- Many converters in the first interval → fast path CDF rise
- Few converters in middle intervals → CDF flattening → constrains
  path sigma
- Large residual `a - yₘ` at the final age → either low `p_path` or
  slow CDF. The trajectory shape disambiguates: rapid early conversion
  + large tail = low `p_path` with fast latency. Slow early
  conversion = slow latency (and `p_path` may be high but censored).
- For downstream edges, the separation of `p_path` into
  `p_AX · p_XY` is informed by the upstream edge's own trajectory
  (which constrains `p_AX` independently).

#### Interaction with the window/cohort hierarchy

Both `window()` and `cohort()` slices describe evolving Cohorts with
the same trajectory structure. Both produce trajectory likelihood
terms. They differ in anchoring:

**`cohort()` trajectories** use path-variant probabilities:

```
p_path = p_cohort_AX · p_cohort_XY
CDF = CDF_path(t | path_onset, path_mu, path_sigma)
denominator = a (anchor entrants)
```

where `p_cohort_AX` and `p_cohort_XY` are the cohort-variant
probability variables from the hierarchical structure (§Layer 3), each
allowed to diverge from their respective `p_base` by the path-informed
`τ_cohort`.

**`window()` trajectories** use edge-level probabilities:

```
p = p_window_XY
CDF = CDF_edge(t | onset_XY, mu_XY, sigma_XY)
denominator = x (from-node entrants)
```

Window trajectories provide the **cleanest latency signal** — single
hop, no upstream path composition, no Fenton-Wilkinson approximation.
They directly pin `(mu_XY, sigma_XY)` for the edge.

Both share the same `(mu_XY, sigma_XY)` latency variables and are
linked through `p_base` via the hierarchical structure. They are not
independent — they observe the same underlying conversion process.
The `pm.Potential` emission approach (see §Efficient emission above)
creates separate Potentials for window and cohort data per edge,
preserving the hierarchical connection.

#### Interaction with branch groups

For branch groups, each sibling edge gets its own trajectory Multinomial
per cohort day. The `p_path` for each sibling includes the Dirichlet
component for that sibling: if A branches to {X₁, X₂}, then
`p_path_to_Y₁ = p_X₁ · p_X₁Y₁` where `p_X₁` is a Dirichlet
component. The trajectory constrains the product; the Dirichlet
constrains the simplex. Both coexist in the model.

The completeness-adjusted branch-group Multinomial (§Dropout and
abandonment) and the trajectory Multinomial serve different purposes:
the former couples siblings at a branching node, the latter constrains
the CDF shape per edge. They are distinct likelihood terms.

#### Edge cases

- **Δy < 0** (data correction — later retrieval shows fewer converters
  than earlier). The evidence binder should monotonise the sequence:
  if `yⱼ₊₁ < yⱼ`, set `yⱼ₊₁ = yⱼ` (carry forward) and emit a
  diagnostic.
- **Δy = 0** for an interval. Valid — the Multinomial handles zero
  counts naturally.
- **CDF differences near zero.** When `CDF_path(tⱼ₊₁) - CDF_path(tⱼ)`
  is very small, the interval probability approaches zero. If Δy > 0
  with near-zero interval probability, this is strong evidence against
  the current path latency parameters.
- **Single retrieval.** Degenerates to the existing per-day Binomial:
  `Binomial(a, p_path · CDF_path(t₁))`. The evidence binder emits a
  standard `CohortDailyObs` and the existing model path handles it.
- **Non-latency edges.** Completeness = 1.0 at all ages, so
  `CDF_path(tⱼ) = 1` for all j. The interval probabilities collapse
  to `[p_path, 0, 0, ..., 1 - p_path]` and the Multinomial reduces
  to a Binomial on the final count. The trajectory adds no
  information — without a latency model there is no CDF to constrain.

#### When trajectory data is unavailable

Edges without snapshot trajectory data fall back to parameter file
evidence — the existing per-day Binomial from `n_daily`/`k_daily`
arrays. The existing Phase A model uses `x` as the denominator and
edge-level completeness. This is an approximation (it implicitly
conditions on upstream performance) but it works and has been validated.

The trajectory Multinomial is an enrichment that activates when snapshot
data is available, not a replacement for the parameter-file path.

#### Implementation in PyMC

```
# Edge X→Y in chain A→X→Y, cohort day 15-Jan
# a = 1000 anchor entrants (constant across all retrieval ages)
# Retrieval ages and cumulative y counts from snapshot rows:
ages = [10, 20, 30, 45]
cum_y = [12, 38, 65, 82]
a = 1000

# Path probability: product of upstream p's (PyTensor expressions)
p_path = p_cohort_AX * p_cohort_XY

# Path CDF at each retrieval age (differentiable PyTensor)
cdf_vals = [CDF_path(t) for t in ages]

# Interval probabilities
interval_probs = [
    p_path * cdf_vals[0],
    p_path * (cdf_vals[1] - cdf_vals[0]),
    p_path * (cdf_vals[2] - cdf_vals[1]),
    p_path * (cdf_vals[3] - cdf_vals[2]),
    1 - p_path * cdf_vals[3],
]

# Interval counts (observed)
interval_counts = [12, 26, 27, 17, 918]

pm.Multinomial("obs_XY_15jan", n=1000, p=interval_probs,
               observed=interval_counts)
```

#### Efficient emission: `pm.Potential` vectorisation (19-Mar-26)

The per-day `pm.Multinomial` approach above creates one PyTensor
distribution node per cohort day. With real snapshot data this
produces ~235 nodes for a 4-edge graph, causing a **5-minute
PyTensor compilation bottleneck** (the model evaluates in 2ms per
gradient step — compilation, not inference, is the constraint).

**Root cause**: PyTensor's graph optimiser attempts to fuse
operations across nodes. With 235 separate distribution nodes, the
fused graph exceeds kernel argument limits ("Loop fusion failed").
The number of free variables (13) and the gradient cost (2ms) are
small — the problem is purely graph-construction overhead.

**Solution**: compute the Multinomial log-probability manually per
edge and add via `pm.Potential`. For each edge, the evidence binder
produces cohort objects (see doc 11 §9) sorted cohort-first: each
cohort day has `a` anchor entrants and a sequence of `(age, y)`
measurements. The compiler flattens all cohort days for an edge into
arrays and computes one scalar log-probability contribution:

```
# Per edge: flatten all cohort trajectories into arrays
ages_flat = [...]     # all retrieval ages, concatenated across days
y_flat = [...]        # corresponding cumulative y counts
a_per_day = [...]     # anchor entrants per day
day_offsets = [...]   # index boundaries between days

# CDF at every observation point (vectorised)
cdf_all = CDF(ages_flat, onset, mu, sigma)
q_all = p * cdf_all

# Compute interval Multinomial logp per day:
#   for each day: partition (y_1, y_2-y_1, ..., a-y_k) against
#   (q_1, q_2-q_1, ..., 1-q_k), sum log-probabilities
# Sum across all days → one scalar

pm.Potential("traj_EDGE", total_logp)
```

This replaces ~80 `pm.Multinomial` nodes with 1 `pm.Potential` node
per edge (~4 total). Compilation time should drop to seconds.

**Window vs cohort trajectories**: both observation types produce
cohort-day objects with the same structure (date, a, ages, y values).
The compiler emits separate Potentials for window and cohort data on
each edge:
- Window Potential: uses `p_window` and edge-level CDF
- Cohort Potential: uses `p_cohort` and path-level CDF

Both share `(mu_edge, sigma_edge)` and are linked through `p_base`
via the hierarchical structure (§Layer 3 above). The Potential
approach preserves the full hierarchical connection.

**Phase S vs Phase D**: with fixed latency (Phase S), CDF values are
precomputed float constants — the Potential depends on `p` only. When
latency becomes latent (Phase D), CDF values become PyTensor
expressions of `(mu_edge, sigma_edge)` — the same Potential structure
works, gradients flow through automatically. No structural change at
the Phase D boundary.

**Numerical stability**: the Multinomial logp involves `log(q)` where
`q` can be near zero (CDF differences between close ages, or large
`1 - p·CDF` remainder). Implementation must use `log1p` and
clamp interval probabilities to a small positive floor (e.g. 1e-12)
to avoid -inf contributions.

#### IR representation

The evidence binder produces cohort-first trajectory objects (see
doc 11 §9 for the transformation from DB rows). The compiler
receives:

```
@dataclass
class CohortDailyTrajectory:
    """A single cohort day observed at multiple retrieval ages."""
    date: str
    a: int                          # anchor entrants (fixed denominator)
    retrieval_ages: list[float]     # sorted ascending (days)
    cumulative_y: list[int]         # monotonised cumulative target counts
    path_edge_ids: list[str]        # edges on the path (for p_path product)
    obs_type: str                   # 'window' or 'cohort' (determines
                                    # completeness model and p variable)
```

`CohortObservation` gains an optional `trajectories` field alongside
the existing `daily` field. Days with trajectory data use the
Potential emission; days with only a single observation use the
existing Binomial emission. Both can coexist within the same
`CohortObservation`.

### Non-latency edges in cohort mode

If an edge has no latency parameter (`latency_parameter: false` or absent),
the edge itself contributes zero latency to the path composition. However,
for **downstream** non-latency edges, the **path** from anchor may still
have non-trivial latency from upstream edges. A non-latency edge X→Y
sitting downstream of a latency edge A→X inherits the A→X path latency
— entrants at A haven't all reached X yet, so cohort observations of Y
are affected by upstream immaturity.

The rule: **completeness uses the path-level latency, not the edge-level
latency.** The topology analyser already propagates upstream path latency
to non-latency edges (line 281 of `topology.py`: "non-latency edge:
inherit source node's path latency"). The evidence binder checks whether
the path has non-trivial latency (`path_sigma > 0.01 or path_delta > 0`),
not whether the edge itself has `latency_parameter: true`.

- If the **entire path** has trivial latency (no upstream latency edges):
  `completeness = 1.0`. Correct — all observations are mature.
- If upstream edges have latency: completeness uses the inherited
  `(path_delta, path_mu, path_sigma)`. The non-latency edge adds zero
  to the path composition, but the upstream contribution remains.

This means a non-latency edge downstream of a slow upstream edge will
correctly show lower completeness on recent cohort days, preventing
the model from interpreting upstream immaturity as low `p` on this edge.

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

- **Same context, different time windows**: all windows enter as likelihood
  terms with recency weighting. The existing recency-weighting setting on
  the graph controls the observation-level scale factor — newer data
  contributes more to the posterior, older data contributes less but is not
  discarded. No window is "primary"; each is a weighted likelihood term.
- **Same time, different contexts**: separate observations feeding separate
  slice-level likelihood terms (see Layer 2).
- **Window + cohort for the same edge**: both contribute — they are
  **temporally complementary**, not redundant. They share latent latency
  variables (`mu_XY`, `sigma_XY`) but have **separate probability
  variables** (`p_window_XY`, `p_cohort_XY`) linked through `p_base_XY`
  via the hierarchical structure. Window data (X→Y) matures faster
  because its completeness couples only to edge-level latency (single
  hop), while cohort data (A→X→Y) couples to the full path. The window
  anchors `p_base` and edge latency early; the cohort adds path-level
  coupling as it matures, with its probability allowed to diverge by
  `τ_cohort = σ_temporal · path_sigma_AX`. See "Why the hierarchical
  registration matters" above for the full interaction model. Date
  overlap at the edge-event level (not the anchor level) should be
  detected by the evidence binder and flagged as a diagnostic; the
  initial implementation accepts the mild overconfidence rather than
  attempting deduplication.

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
  fresh. The topology fingerprint (hash of TopologyAnalysis) detects this.
- Has the edge's structural role changed? (Was solo, now part of a branch
  group.) If so, the Beta posterior can't seed a Dirichlet — start fresh.
- Is the posterior suspiciously old or from a different model version?
  Policy decision on staleness threshold.

### Trajectory-calibrated priors (from `fit_history`)

The simple warm-start above uses only the *most recent* posterior. But
the parameter file carries a rolling `fit_history` trajectory (see doc 4)
— a sequence of posterior summaries from previous runs. The *variance of
this trajectory* is information: it tells the compiler how stable or
volatile each parameter has been, and therefore how confident the prior
should be.

**Framing: random-effects meta-analysis.** Each `fit_history` entry is a
"study" that estimated the same underlying parameter. Each has a point
estimate `m_i` (posterior mean), a standard error `s_i` (posterior stdev),
and a date `t_i`. Between runs, the true parameter may have moved. The
between-run heterogeneity `tau^2` captures this.

**Step 1 — Transform to unconstrained space.** Probability is bounded
[0, 1]; the meta-analytic calculations are cleaner in logit space:

```
eta_i = logit(m_i) = ln(m_i / (1 - m_i))
sigma_eta_i = s_i / (m_i * (1 - m_i))       # delta method
```

For latency `mu` (real-valued), no transform. For latency `sigma`
(positive), use log space.

**Step 2 — Estimate between-run heterogeneity (DerSimonian-Laird).**

```
w_i = 1 / sigma_eta_i^2                      # inverse-variance weight
eta_bar = Σ(w_i * eta_i) / Σ(w_i)            # weighted pooled mean
Q = Σ w_i * (eta_i - eta_bar)^2              # Cochran's Q statistic
c = Σ(w_i) - Σ(w_i^2) / Σ(w_i)             # scaling constant
tau^2 = max(0, (Q - (K - 1)) / c)            # between-run variance
```

`tau^2` is the genuine between-run movement after subtracting within-run
sampling noise. If the trajectory is stable, `Q ≈ K - 1` and `tau^2 = 0`.
If the parameter has been volatile, `Q >> K - 1` and `tau^2` is large.

**Step 3 — Predictive prior for the next run** (in logit space):

```
eta_{K+1} ~ Normal(eta_K, tau^2 + sigma_eta_K^2)
```

Centred on the *most recent* estimate (not the pooled mean — we want to
track drift, not regress to the historical average). The variance combines:
- `sigma_eta_K^2` — within-run uncertainty of the last fit
- `tau^2` — between-run volatility from the trajectory

**Step 4 — Convert to Beta hyperparameters** (for probability):

```
mu_prior = m_K                                # last posterior mean
V_logit = tau^2 + sigma_eta_K^2              # total variance in logit space
V_prob = V_logit * (mu_prior * (1 - mu_prior))^2    # delta method to prob space

n_eff = mu_prior * (1 - mu_prior) / V_prob - 1
n_eff = clamp(n_eff, 2, ESS_CAP)

alpha_prior = mu_prior * n_eff
beta_prior = (1 - mu_prior) * n_eff
```

The critical result: `n_eff` (the prior's effective sample size) is
**derived from the trajectory**, not a fixed constant. A stable edge
earns high `n_eff` (up to `ESS_CAP`). A volatile edge gets low `n_eff`
because `V_prob` is large. The fixed `ESS_CAP` becomes a safety ceiling,
not the primary concentration-control mechanism.

**For latency parameters** — same structure, no logit transform:

```
tau_mu^2 = DL estimate from fit_history[].mu
mu_edge ~ Normal(mu_K, sqrt(tau_mu^2 + sigma_mu_K^2))
```

For latency `sigma` (positive), work in log space for the DL estimate,
then convert back to Gamma parameters via moment-matching.

**Step 5 — Surprise detection** (post-fit diagnostic):

After the new run produces posterior mean `m_{K+1}`:

```
z = (logit(m_{K+1}) - eta_K) / sqrt(tau^2 + sigma_eta_K^2)
```

This measures departure **calibrated to the edge's own volatility**. A
stable edge with a sudden shift produces a large `|z|`. A volatile edge
with the same absolute shift produces a smaller `|z|`. Both are
meaningful: the z-score says "this is surprising *for this edge*".

Diagnostic thresholds (indicative):
- `|z| < 2`: normal variation
- `2 ≤ |z| < 3`: noteworthy — flag in session log
- `|z| ≥ 3`: surprising — flag prominently, possible regime change

**Minimum history requirement**: `K < 3` → insufficient trajectory data
to estimate `tau` reliably. Fall back to simple warm-start (last
posterior, fixed ESS cap). Trajectory calibration activates at `K ≥ 3`.

**Where this sits in the pipeline**: trajectory calibration is computed in
`bind_evidence`. It reads `fit_history`, estimates `tau^2`, derives the
calibrated hyperparameters, and stores them in the bound evidence.
`build_model` emits `pm.Beta(alpha=alpha_prior, beta=beta_prior)` without
knowing the hyperparameters came from trajectory analysis. No additional
latent variables enter the model — this is empirical Bayes (estimate
hyperparameters from historical data, condition on them in the current
model).

**Time-varying extension** (future): the above treats `tau` as constant.
If the parameter is trending (monotone drift from product evolution),
`tau` should scale with the time gap: `tau^2(Δt) = tau^2_per_day * Δt`
(random-walk model). Estimable from first differences of the trajectory.
Not required initially but the structure accommodates it.

### Prior ESS cap

The ESS cap remains as a safety ceiling on trajectory-calibrated priors.
Even if `tau ≈ 0` (very stable edge), the prior concentration must not
grow without bound:

```
n_eff = clamp(n_eff, 2, ESS_CAP)      # ESS_CAP = 500 default
alpha_prior = mu_prior * n_eff
beta_prior = (1 - mu_prior) * n_eff
```

This replaces the earlier overflow guard (`if alpha + beta > 500:
Beta(2, 2)`) which destroyed accumulated information. The ESS cap
preserves the posterior's location while smoothly limiting concentration.

### Evidence inheritance from analogous edges

When topology changes invalidate an edge's direct history (the topology
fingerprint changes), the edge's own `fit_history` is formally unusable
for warm-start. But the old edge's accumulated evidence is often still
highly relevant — a renamed edge, a split edge, or a structural
reorganisation doesn't change the underlying conversion process.

The source edge's posterior `(alpha, beta)` **encodes** all the historical
evidence that produced it. A `Beta(62.5, 2.1)` is not an arbitrary
starting point — it represents ~63 effective observations of a conversion
rate near 0.97. Inheriting this posterior is mathematically equivalent to
asserting that those historical observations are relevant to the new
edge, weighted by how much the user trusts the analogy.

The evidence inheritance mechanism lets the user assert: "this new edge
measures the same (or similar) conversion process as that old edge — its
historical data has weight here." The `strength` parameter controls how
much of that historical evidence carries over (measured in effective
observations), and the `created_at` timestamp ensures the inherited
evidence naturally fades as the new edge accumulates its own data.

**This does not add latent variables to the model.** It affects only the
prior hyperparameters — which encode inherited evidence as pseudo-
observations. The MCMC sampler sees the same model structure regardless
of where the hyperparameters came from. `build_model` emits
`pm.Beta(alpha, beta)` without knowing whether those values encode direct
history, inherited evidence, or an uninformative default.

**Annotation object** (on the edge, in the graph or parameter file):

```yaml
evidence_inherit:
  source_edge: "register-v1"
  source_graph: "conversion-flow-v2"   # optional, default: same graph
  asat: "1-Jan-26"                      # optional: historical version
  strength: 0.7                         # 0.0 (hint) → 1.0 (strong)
  created_at: "15-Mar-26"              # auto-set, drives natural decay
```

**Source resolution**: the compiler reads the source edge's posterior
summary and `fit_history` at the `asat` date (or `created_at` if `asat`
is omitted). If the source's `fit_history` covers that date, read
directly — no git lookup. If it predates `fit_history`, fall back to git
archaeology (one-off).

**How inherited evidence weight is computed:**

The source's posterior encodes `ESS_source = alpha_source + beta_source`
effective observations. The annotation controls what fraction of those
observations carry over, decaying with age:

```
annotation_age = today - created_at
decay = exp(-annotation_age / half_life)       # half_life ≈ 90 days
effective_weight = strength * decay

ESS_inherited = ESS_source * effective_weight
alpha_inherited = (alpha_source / ESS_source) * ESS_inherited
beta_inherited  = (beta_source  / ESS_source) * ESS_inherited
```

This preserves the source's posterior *mean* (the learned conversion
rate) while scaling down its *concentration* (how many pseudo-
observations it contributes). The result:

- **Fresh + strong** (weight ≈ 0.8): ~80% of the source's effective
  observations carry over. The new edge starts with substantial
  historical evidence.
- **Fresh + hint** (weight ≈ 0.1): ~10% carry over. A gentle nudge —
  the historical data is noted but easily overridden.
- **Aged** (weight → 0): the inherited evidence fades to zero effective
  observations. No manual cleanup needed.

**Strength slider** (UX convenience over raw numbers):

| Label    | strength | Effect on inherited evidence                    |
|----------|----------|-------------------------------------------------|
| Hint     | ~0.1     | ~10% of source ESS — easily overridden          |
| Moderate | ~0.4     | ~40% of source ESS — noticeable weight           |
| Strong   | ~0.8     | ~80% of source ESS — nearly full inheritance     |

**Combining with the edge's own history** — when both inherited evidence
and direct history exist, they combine via precision-weighted average in
logit space:

```
# Own trajectory-calibrated prior (if any):
tau_own = 1 / V_own

# Inherited evidence component:
V_inherited = V_source / effective_weight
tau_inherited = 1 / V_inherited

# Combined:
tau_combined = tau_own + tau_inherited
mu_combined = (mu_own * tau_own + mu_source * tau_inherited) / tau_combined
V_combined = 1 / tau_combined
```

As the edge accumulates its own `fit_history`, `tau_own` grows and the
inherited contribution shrinks. New empirical data naturally dominates —
the inherited evidence doesn't fight the data, it just provides a
starting point that's better than nothing.

**Multiple annotations**: an edge may reference multiple sources (e.g.
"this edge is similar to both A and B"). Each contributes inherited
evidence; they combine additively in precision space.

**Self-cleaning diagnostics**: the compiler emits a diagnostic when an
annotation's effective contribution drops below 5%: "evidence_inherit on
edge X is N days old and contributing < 5% to prior — consider removing
for clarity." The annotation still works (negligible effect); the
diagnostic is housekeeping.

**Prior cascade** (complete, from strongest to weakest evidence source):

```
1. Own fit_history (K ≥ 3) + any inherited evidence
   → trajectory-calibrated, precision-combined with inherited

2. Own fit_history (K < 3) + any inherited evidence
   → simple warm-start, precision-combined with inherited

3. Inherited evidence only, no own history
   → inherited evidence alone (strength- and age-decayed)

4. No history, no inheritance, but sibling edges with history
   → Dirichlet hierarchy pools toward sibling base rate

5. Graph-level base rate (if enough edges have history)
   → empirical distribution of conversion rates across all edges

6. Nothing
   → weakly informative default: Beta(1, 1)
```

Each tier contributes fewer effective observations than the one above.
The compiler walks the cascade and uses the first available source,
emitting a diagnostic noting which tier was used per edge.

**Resilience to graph changes — window/cohort asymmetry**: topology
changes affect window and cohort data differently, and this asymmetry is
what makes the architecture ductile:

- **Window data survives topology changes.** `window(X→Y)` observes
  X-event users converting to Y. It depends only on edge X→Y existing
  and having associated events. If the graph changes *upstream* of X
  (new paths to X, removed paths, restructured branching), the window
  data is unaffected — it never referenced the upstream structure. The
  window's edge-level completeness coupling uses only `(mu_XY, sigma_XY)`,
  which are properties of the edge, not the path.

- **Cohort data breaks at the path level.** `cohort(A→...→X→Y)` depends
  on the entire path from anchor to Y. If any edge on that path is added,
  removed, or restructured, the path latency composition changes and old
  cohort observations can't be combined with new ones under the same
  completeness model. The cohort data for affected paths is invalidated.

- **Evidence inheritance fills the gap.** The new or restructured edge
  borrows weighted evidence from its predecessor. The surviving window
  data anchors `p_base` (via `p_window`) and edge latency immediately
  (single-hop, unaffected by the topology change). The inherited evidence
  provides a starting
  point for path-level parameters while new cohort data matures under the
  new topology.

**Recovery dynamics — why cohort fit quality recovers quickly**: because
window and cohort terms for the same edge are hierarchically linked
through `p_base_XY` and share latent `mu_XY`, `sigma_XY` in a single
`pm.Model` (see "Why the hierarchical registration matters"), the
surviving window data does double duty after a topology change. It
directly constrains `p_window_XY` (which anchors `p_base_XY`), and
the shared latency parameters propagate into the cohort completeness
model — the sampler knows `(mu_XY, sigma_XY)` from the window, so the
cohort's path-level completeness is already partially determined even
before the new cohort data has fully matured. The `p_base_XY` anchor
means `p_cohort_XY` starts in the right region, with only the
path-informed divergence `τ_cohort_XY` left to resolve. The new cohort
observations then only need to resolve the *upstream* path latency
(which the inherited evidence gives a starting point for) and the
magnitude of temporal divergence from current window performance. This
means cohort fit quality recovers in weeks, not months — the window
evidence anchors the edge, the inherited evidence anchors the path, and
each new daily cohort observation tightens the joint posterior
incrementally.

The net result: after a topology change, the model has (a) intact window
evidence for unchanged edges, (b) inherited weighted evidence for
restructured edges, and (c) fresh cohort data accumulating under the new
path structure with its convergence accelerated by the hierarchical
window/cohort registration. Only genuinely novel edges with no window
data and no analogy start cold. Graph restructuring degrades gracefully
in proportion to how much actually changed — it is a routine operation,
not a reset.

**Note**: the survival of window data and invalidation of cohort data
after topology changes is a *snapshot DB* concern, not a compiler concern.
The compiler's evidence binder trusts that the snapshots it receives are
consistent with the current topology. See open question in `programme.md`
re: snapshot signature hash design.

**Future UI integration**: on a topology-breaking change, the app could
detect which edges lost their history and prompt "these edges have no
prior fit data — link to previous version?" with a pre-populated `asat`
pointing at the last commit before the restructure. This is a natural
UX surface for the inheritance machinery — not required for the
computational architecture but worth designing when the pipeline is
stable.

### Warm-start constraints for hierarchical parameters

Solo-edge Beta posteriors are straightforward to warm-start (same shape,
same interpretation). Hierarchical parameters require more care:

- **Dirichlet base simplex, κ**: the hierarchical structure may change
  between runs (new slices appearing, old slices disappearing).
  Warm-starting a Dirichlet with a different component count is not
  meaningful — start fresh.
- **Slice deviations**: if slice identities change, previous deviations
  don't map to the new slices — start fresh.
- **Latency posteriors**: latency variables interact with completeness
  coupling. Warm-starting them while changing the evidence window could
  bias the coupled model. Requires careful overlap detection and
  compatibility checking before reuse.

Once the parameter-file schema carries sufficient metadata (component
counts, slice identities, training windows per posterior), warm-starting
hierarchical parameters becomes feasible — but the cost of getting it
wrong (silent double-counting or shape mismatch) is higher than the cost
of a cold start.

**Implementation sequencing**: see `8-compiler-implementation-phases.md`
for warm-start rules by implementation phase.

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

Whether to use completeness-adjusted likelihoods for cohort observations
(Layer 3) or treat all observations as mature (completeness = 1.0
everywhere). Useful for debugging — if the coupled model diverges,
disabling coupling isolates whether the problem is in the latency structure
or the probability structure. When enabled (the default), completeness
applies to all daily observations — there is no mature/immature branching.

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
   Completeness coupling applies to all daily observations — no
   mature/immature branching. Old days have completeness ≈ 1.0 naturally;
   recent days have lower completeness. Maturity is a diagnostic label, not
   a model branch.

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

# Hierarchical probability structure (Layer 3)
# p_base_confirmed_shipped is the shared anchor
# This is a cohort observation, so we use p_cohort_confirmed_shipped
p_cohort_confirmed_shipped = ...    # from Layer 1 + Layer 3 hierarchical structure
delta_classic_cart = ...             # from Layer 2 (slice deviation)
p_slice = logistic(logit(p_cohort_confirmed_shipped) + delta_classic_cart)

# Path latency with onset (from Layer 1 latency chain)
path_delta = onset_landing_confirmed + onset_confirmed_shipped
path_mu = fw_compose(mu_landing_confirmed, sigma_landing_confirmed,
                     mu_confirmed_shipped, sigma_confirmed_shipped).mu
path_sigma = fw_compose(...).sigma

# Completeness with onset subtraction (doc 1 §15.3)
# Cohort uses path-level completeness (full chain from anchor)
completeness = cdf_lognormal(max(0, cohort_age - path_delta), path_mu, path_sigma)

pm.Binomial("obs_cohort_confirmed_shipped_classic_cart",
            n=1580, p=p_slice * completeness, observed=1518)

# A window observation for the same edge would instead use:
# p_window_confirmed_shipped (close to p_base, tight τ_window)
# edge-level completeness only (single hop, not full path)
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
and therefore its own completeness. The probability used is the
observation-type-appropriate variant: `p_cohort_B` for cohort observations,
`p_window_B` for window observations (see Layer 3 hierarchical structure):

```
# Cohort observation example:
completeness_B(t) = CDF_LN(max(0, age_t - path_delta_B), path_mu_B, path_sigma_B)
completeness_C(t) = CDF_LN(max(0, age_t - path_delta_C), path_mu_C, path_sigma_C)

p_effective_B = p_cohort_B * completeness_B(t)
p_effective_C = p_cohort_C * completeness_C(t)
p_effective_dropout = 1 - p_effective_B - p_effective_C

obs_t ~ Multinomial(n_A_t, [p_effective_B, p_effective_C, p_effective_dropout]),
        observed=[k_B_t, k_C_t, n_A_t - k_B_t - k_C_t]

# Window observations use p_window_B, p_window_C instead, with edge-level
# completeness (single hop) rather than path-level.
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
compiler uses this from the data when available. If `n_A` is not directly
available, the compiler estimates it as `max(Σ k_siblings, max_i(n_i))`
and emits a diagnostic — see the branch group section in Layer 1.

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

**If `n_A` is not directly available**: the compiler estimates it as
`max(Σ k_siblings, max_i(n_i))` and emits a diagnostic. The Multinomial
is still used — the graph's structural intent is mass-conserving, and the
model should reflect that even when the data source is imperfect. If mass
conservation is genuinely violated in the data, the model's diagnostics
(divergences, high r-hat) will surface it.

---

## Compiler structure

Given the above, the compiler is three functions:

### 1. `analyse_topology(graph) → TopologyAnalysis`

Walks the graph once. Produces:
- Topo-sorted node order
- Branch groups (which edges are siblings at each branching node)
- Solo edges
- Join nodes with inbound edge identities (which edges converge, not
  weights — weights are functions of latent `p`, resolved in `build_model`)
- Join recipes: at each non-terminal join, the instruction "collapse inbound
  paths via moment-matching" with the list of inbound path identifiers
- Latency chains (anchor → edge path for each latency-enabled edge)
- Path onset accumulation (`path_delta` per edge — this is purely
  structural: onset is a fixed scalar per edge, not latent)

This is purely structural — no evidence, no PyMC, no latent-dependent
values. The output is a serialisable, deterministic data structure. Testable
independently with deterministic assertions on known graph topologies.

**Topology fingerprint**: a content hash of TopologyAnalysis. Answers "has
the graph structure changed?" Used for warm-start eligibility — if the
topology fingerprint changes, all previous posteriors are invalidated.

### 2. `bind_evidence(topology, param_files, settings) → BoundEvidence`

For each edge in the topology, reads the parameter file and classifies each
`values[]` entry:
- Context dimension, slice key, and MECE classification
- Window vs cohort, with maturity classification (diagnostic only — does not
  affect likelihood form; completeness is always on)
- `(n, k)` per entry (aggregate and daily)
- `n_A` resolution for branch groups (source node traffic)
- Latency priors from histogram/summary stats (model-space, onset subtracted)
- Previous posterior for warm-start eligibility (overlap detection)
- Double-counting resolution (slice partition vs residual)
- Training window filtering

This is data wrangling — no PyMC. The output is serialisable. Testable with
real parameter files from the data repo.

**Model fingerprint**: a content hash of BoundEvidence + structural
settings (exhaustiveness flags, completeness coupling toggle, pooling
policy, prior policy). Combined with the topology fingerprint, this
determines full cache identity. Two runs with the same graph but different
training windows or different structural settings share the topology
fingerprint but have different model fingerprints.

### 3. `build_model(topology, evidence) → pm.Model`

Reads the topology analysis and bound evidence, emits PyMC declarations:
- Creates probability variables (Beta or Dirichlet per structural role)
- Creates slice deviations if context slices exist
- Creates latency variables if latency chains exist
- Computes path-level `(path_delta, path_mu, path_sigma)` as deterministic
  nodes from edge-level latents
- Computes traffic weights at join nodes as deterministic functions of
  latent edge probabilities (`w_i = p_path_i / Σ p_path_i`)
- Executes join-collapse moment-matching at each non-terminal join (per the
  join recipes from TopologyAnalysis) as differentiable PyTensor expressions
  — gradients flow through the collapse so NUTS can explore the joint space
- Wires completeness coupling (with onset) for cohort observations;
  assigns completeness = 1.0 for non-latency edges
- Binds each observation to its likelihood term

This is the only function that imports PyMC. It is a mechanical translation
of the IR into PyMC calls — the topology and evidence have already been
analysed, and `build_model` executes the recipes with actual latent values.

### Distribution family extensibility

The initial implementation uses **shifted lognormal** for latency and
**Beta** (or Dirichlet) for probability. These are good defaults but not
the only viable families. The architecture must not bake distribution-
specific assumptions into the IR or the composition pipeline.

**Design principle**: distribution-specific logic is isolated behind a
**family interface**, dispatched by a tag in the IR. The IR itself is
family-agnostic — it describes *what* needs composing and coupling, not
*how*.

**Extension points** (four places where distribution choice matters):

1. **Edge-level variable creation** (`build_model`). Each latency edge
   carries a `latency_family` tag. `build_model` dispatches on this tag to
   emit the correct PyMC variables — e.g. `(mu, sigma)` for lognormal,
   `(alpha, beta)` for Gamma, `(k, lambda)` for Weibull. Similarly, each
   probability edge carries a `prob_family` tag (Beta, logit-Normal, etc.).

2. **Chain composition** (path-level aggregation of edge latencies). FW is
   the composition strategy for lognormal. Other families need their own
   strategy — e.g. Gamma sum is exact (closed-form), Weibull sum requires
   moment-matching to a different target. The composition function is
   selected by the family tag, not hardwired.

3. **Join-node collapse** (mixture moment-matching at joins). The collapse
   targets the same family as the inbound paths. If a future family
   supports native mixture representation (e.g. mixture-of-lognormals),
   the collapse step becomes a no-op — the mixture *is* the path model,
   avoiding the multimodality loss entirely.

4. **Completeness CDF** (the coupling function in the likelihood). The CDF
   is a method on the family: `CDF_LN` for lognormal, `CDF_Gamma` for
   Gamma, etc. The likelihood wiring in `build_model` calls the family's
   CDF, not a hardcoded function.

**What this means for the IR**:

- `TopologyAnalysis` gains a `latency_family` field per edge (default:
  `"shifted_lognormal"`). Join recipes carry a `collapse_strategy` tag
  (default: `"moment_match_to_family"`).
- `BoundEvidence` maps observed summaries to family-appropriate prior
  parameters. The mapping is family-dispatched: lognormal reads
  `median_lag` and derives `(mu_prior, sigma_prior)`; Gamma would read
  `mean_lag` and derive `(alpha_prior, beta_prior)`.
- `build_model` dispatches on the family tag at each of the four
  extension points above.

**Initial implementation**: ships with `shifted_lognormal` and
`Beta`/`Dirichlet` only. The family tag exists in the IR from the start
but only one value is supported. This is a one-line default, not a
premature abstraction — the dispatch structure in `build_model` naturally
accommodates it because each extension point is already a distinct code
block.

**Model comparison**: when multiple families are available, the mechanism
for selection is posterior predictive comparison — WAIC or LOO-CV via
ArviZ. Run the same graph with two family tags, compare `elpd`. This is
a natural output of the existing sampling pipeline (ArviZ already
computes these from the inference trace).

**Candidate families**:

| Family | Latency | Probability | Notes |
|---|---|---|---|
| Shifted lognormal | initial | — | Right-skewed, FW-composable, good default |
| Beta / Dirichlet | — | initial | Conjugate to Binomial/Multinomial |
| Shifted Gamma | future | — | Closed-form sum, sometimes better numerics |
| Weibull | future | — | Flexible hazard shape, no closed-form sum |
| Log-logistic | future | — | Closed-form CDF, heavier tails |
| Mixture of lognormals | future | — | Avoids join-collapse loss entirely |
| Logit-Normal | — | future | Better for extreme p (near 0 or 1) |

---

## End-state compiler approach for snapshot evidence

**Date**: 19-Mar-26

This section describes how the compiler should work when fed real
snapshot data from the DB — the target design for Phase S and its
evolution into Phase D. It synthesises the formulations across Layers
1–3 and the `pm.Potential` emission approach into a single coherent
narrative.

### The fundamental data unit: the Cohort

A Cohort is a group of people who commenced something on a specific
date — an independent experiment group. The snapshot DB stores
successive measurements of each Cohort at increasing ages (as-at
dates). Each measurement records how many of the original population
have reached a given node by that observation date. Over time, the
cumulative count rises monotonically as late converters arrive.

Both `window()` and `cohort()` DagNet slice types produce Cohorts.
The underlying data shape is identical: a collection of Cohort days,
each observed at one or more as-at ages, each forming a monotonic
cumulative distribution. What differs is the anchoring — which
population serves as the denominator, and which latency model governs
the completeness coupling.

### Two observation types, same structure

For edge X→Y in a chain A→…→X→Y:

**`window()` observations** are anchored at the edge. The denominator
is `x` — the number of people who reached node X on a given Cohort
day. The probability is `p_window_XY` (a single edge probability).
The completeness CDF is edge-level: `CDF(t | onset_XY, mu_XY,
sigma_XY)`. This is the cleanest signal for identifying edge latency
because there is no upstream path composition, no Fenton-Wilkinson
approximation, and no coupling to other edges' latency variables.
Window data directly pins `(mu_XY, sigma_XY)`.

**`cohort()` observations** are anchored at the graph root. The
denominator is `a` — the number of people who entered at the anchor
node. The probability is `p_path = p_cohort_AX · p_cohort_XY` (the
product of all edge probabilities along the path from anchor to
target). The completeness CDF is path-level: `CDF(t | path_onset,
path_mu, path_sigma)`, where the path latency parameters are composed
from per-edge latents via Fenton-Wilkinson. This creates inter-edge
coupling — the Cohort trajectory for edge Y constrains latency
variables on edges A→X as well as X→Y. The trajectory IS evidence
about upstream conversion just as much as about this edge.

### The hierarchical connection

`window()` and `cohort()` observations of the same edge are not
independent — they observe the same underlying conversion process.
The model connects them through a shared base probability:

- `p_base_XY` — the underlying conversion rate
- `p_window_XY = invlogit(logit(p_base) + eps_window)` — small
  deviation, tightly constrained
- `p_cohort_XY = invlogit(logit(p_base) + eps_cohort)` — can diverge
  by a path-informed amount `tau_cohort = sigma_temporal ·
  path_sigma_AX`

Both share the same edge-level latency variables `(mu_XY, sigma_XY)`.
The latency is a physical property of the conversion process and does
not depend on how the observation was anchored.

This connection gives the model four properties:

1. Window data pins the base rate and edge latency quickly (direct,
   single-hop, no upstream uncertainty).
2. The base guides cohort expectations through partial pooling.
3. The cohort can diverge from the base by the amount the path
   complexity warrants (deep downstream edges have wide arrival
   spreads that genuinely produce different effective rates).
4. Divergence between window and cohort posteriors is a signal about
   temporal drift in conversion rates, not noise.

### Successive hops and latency coupling

The compiler processes a graph with successive hops: A→B→X→Y. Each
hop has its own latency parameters `(onset, mu, sigma)`. The path
latency to any node is the sum of all upstream hop latencies:
`T_path(A→Y) = T_AB + T_BX + T_XY`. The sum of shifted lognormals
is approximated via Fenton-Wilkinson to get composed `(path_onset,
path_mu, path_sigma)`.

This composition creates a chain of constraints:

- `window()` trajectory on A→B directly pins `(mu_AB, sigma_AB)`.
- `cohort()` trajectory on B→X uses a path CDF that depends on
  `(mu_AB, sigma_AB)` composed with `(mu_BX, sigma_BX)`.
- `cohort()` trajectory on X→Y uses a path CDF that depends on all
  three hops' latency variables.

The window data at each hop anchors the edge latency. That then
propagates into the path CDFs used by `cohort()` trajectories on all
downstream edges. The entire chain is coupled through shared latency
variables and the Fenton-Wilkinson composition, which is implemented
as differentiable PyTensor operations so NUTS explores the joint
space naturally.

### Emission: `pm.Potential` vectorisation

Each edge receives two `pm.Potential` nodes — one for its `window()`
Cohorts and one for its `cohort()` Cohorts. Each Potential computes
the full Multinomial log-probability across all Cohort days for that
edge and observation type in a single vectorised PyTensor expression.

The evidence binder transforms raw DB rows into Cohort-first arrays
per edge:

- `ages`: all retrieval ages across all Cohort days, concatenated
- `y`: corresponding cumulative conversion counts
- `denominators`: `x` per Cohort day for `window()`, `a` for
  `cohort()`
- `day_boundaries`: index array marking where each Cohort day starts

The Potential computes:

1. CDF at every observation age (vectorised array operation — one CDF
   call for the entire edge, not per Cohort day).
2. Interval probabilities from the cumulative CDF values: for each
   Cohort day, partition into `(y_1, y_2 - y_1, ..., denom - y_k)`
   against `(p · CDF(t_1), p · (CDF(t_2) - CDF(t_1)), ...,
   1 - p · CDF(t_k))`.
3. Multinomial log-probability per Cohort day: sum of
   `count · log(prob)` across intervals.
4. Total: sum across all Cohort days → one scalar log-probability
   contribution.

This replaces hundreds of individual `pm.Multinomial` distribution
nodes with a handful of `pm.Potential` nodes (two per edge). The
computational cost per gradient step is the same (array operations
on the same data), but the PyTensor graph is small enough for the
graph optimiser to compile in seconds rather than minutes.

### Phase S vs Phase D: latency treatment

In Phase S, latency parameters `(mu, sigma)` are fixed from the
topology priors. The CDF values in the Potential are precomputed
float constants. The trajectory data constrains only the probability
(through the level of the maturation curve, not its shape). This is
already valuable — it uses richer per-Cohort-day evidence with
correct completeness coupling instead of summary aggregates from
parameter files.

In Phase D, `(mu, sigma)` become free variables in the model. The
CDF values become PyTensor expressions — differentiable functions of
the latent latency parameters. The trajectory shape now directly
constrains the latency distribution: a steep early rise means fast
latency, a slow rise means slow latency, and the pattern across
Cohort days of different ages identifies the distribution parameters.

The structural change at the Phase D boundary is minimal: the CDF
call in the Potential switches from a precomputed array to a
PyTensor expression. The Potential structure, the Cohort-first data
transformation, and the hierarchical connection are unchanged.

### Phase D: time-binned latency with drift detection

**Sequencing**: D before C (see doc 11 §10 and `programme.md`).
Phase S delivers the data pipeline; Phase D extracts the full
value from trajectory shape. Phase C (slice pooling) adds breadth
on top.

**Motivation**: with stable `(mu, sigma)`, the model cannot detect
latency drift. A speed-up in conversion fulfilment is misattributed
as a change in probability, producing materially wrong forecasts.
The purpose of drift detection is forecasting accuracy — project
from the current latency regime, not from a historical average.

#### Time-binned latency model

Segment Cohort days into time bins (bin width configurable via model
settings, e.g. `LATENCY_DRIFT_BIN_DAYS = 7`). Each bin `t` gets its
own `mu_t`, connected by a random walk:

```
mu_base_XY ~ Normal(prior_mu, prior_sigma)
sigma_drift_XY ~ HalfNormal(sigma_drift_prior)
mu_t_XY ~ Normal(mu_{t-1}_XY, sigma_drift_XY)    for t = 1..T
sigma_XY ~ HalfNormal(sigma_prior)                 shared across bins
```

`mu_t` varies (central tendency of latency shifts over time).
`sigma` is shared (inherent variability of the process). If
`sigma_drift → 0`, all bins collapse to `mu_base` and the model
recovers stable-latency behaviour. The data decides.

Each Cohort day maps to bin `floor((anchor_day - start) / bin_days)`.
The CDF for that Cohort uses its bin's `mu_t`:

```
CDF_edge(age | onset_XY, mu_t_XY, sigma_XY)
```

Path composition for downstream edges: `FW_compose(mu_t_AB,
sigma_AB, ..., mu_t_XY, sigma_XY)` using the anchor day's bin
assignment for all path edges — "the latency conditions when this
Cohort entered are the ones that apply."

#### Drift prior calibration from `fit_history`

The `sigma_drift` and `sigma_temporal` priors are not uninformative
— they are calibrated from the parameter's own `fit_history` using
the same DerSimonian-Laird mechanism already specified in Layer 5
(§ Trajectory-calibrated priors):

**Latency drift**: `tau_mu²` estimated from `fit_history[].mu`
(between-run variance of latency log-mean across successive fits)
sets `sigma_drift_prior`:

```
sigma_drift_XY ~ HalfNormal(sqrt(tau_mu^2 / fits_per_bin))
```

The scaling by `fits_per_bin` converts between-run variance (one
fit covers the full training window) to per-bin variance (each bin
is a fraction of the window). If historic fits show stable `mu`,
`sigma_drift_prior` is small → bins tightly constrained. If `mu`
has been volatile, `sigma_drift_prior` is large → bins can separate.

**Probability drift**: `tau²` estimated from `fit_history[].logit(p)`
sets `sigma_temporal_prior`:

```
sigma_temporal ~ HalfNormal(sqrt(tau^2))
```

Already specified in Layer 5 — this is the same `tau²` that
calibrates the warm-start prior concentration, now also feeding the
temporal volatility parameter.

**Adaptive without user configuration**: the drift allowance for
both probability and latency is learned from the edge's own history.
A new edge with no `fit_history` gets uninformative drift priors
(conservative). An edge with 10+ stable fits gets tight priors that
resist spurious bin separation. Layer 5's existing `K < 3` fallback
applies: insufficient history → uninformative priors.

The mechanism is the same DerSimonian-Laird estimate already
designed for warm-start — it feeds two consumers: prior
concentration (existing) and drift variance (new).

#### Identifiability: separating p drift from latency drift

With both `p` and `mu_t` free to vary, the same observation could be
explained by higher `p` or faster latency. Window trajectories
resolve this: the maturation SHAPE of a window trajectory (edge-level
CDF) directly separates level (p) from shape (latency). A steep
early rise = fast latency. A high final level = high p.

The two drift hierarchies coexist independently:
- `sigma_temporal` governs probability drift (Layer 3 hierarchy)
- `sigma_drift` governs latency drift (Phase D addition)

Window data anchors both: edge-level `p_window` via probability,
edge-level `(mu_t, sigma)` via trajectory shape. Cohort data
constrains the full path. The hierarchical connection between
`p_window` and `p_cohort` via `p_base` (Layer 3) is unchanged.

#### Posterior output

The model's posterior for latency is the **current-regime** estimate
— the most recent time bin's `mu_t`. The forecast projects from
current conditions, not a historical average. `sigma_drift` is a
diagnostic: near zero = stable latency, material = latency is
moving.

The user sees the same posterior summary. Time bins are internal
model machinery, not exposed in the UI.

#### Cost estimate

For the test graph (4 edges, ~16 weekly bins):
- ~64 `mu_t` variables + 4 `sigma_drift` + 4 `sigma` = ~72 new
  free variables (from current 13 → ~85 total)
- NUTS sampling: estimated 5–10 minutes (from current 2 minutes)
- Compilation: unchanged (Potential structure same, CDFs become
  PyTensor expressions)

### Phase C: Dirichlet interactions

Phase C (slice pooling) adds context-sliced evidence: different
channels, devices, or segments each contribute their own Cohort
trajectories. At branch group nodes, the Dirichlet prior constrains
sibling edges to a simplex. Each sibling edge gets its own trajectory
Potential, and the `p_path` product includes the Dirichlet component
for that sibling. The trajectory constrains the product; the
Dirichlet constrains the simplex. Both coexist as likelihood terms.

The Cohort-first data structure and the `pm.Potential` emission
approach extend naturally to sliced data — each (edge × observation
type × context slice) combination gets its own Potential, with the
probability variable drawn from the appropriate slice-level or
pooled-level hierarchy.

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
- ~~Prior overflow guard~~: replaced with **trajectory-calibrated priors**.
  Between-run heterogeneity (`tau^2`) estimated from `fit_history` via
  DerSimonian-Laird; prior concentration derived from trajectory variance,
  not fixed. ESS cap retained as safety ceiling. Falls back to simple
  warm-start when `K < 3` history entries.
- ~~Latency composition method~~: **Fenton-Wilkinson** for the shifted
  lognormal family. Simulation within MCMC draws is ruled out (not
  differentiable). Other families use their own composition strategy,
  dispatched by the family tag in the IR — see "Distribution family
  extensibility".
- ~~Branch group likelihood~~: **always Multinomial with shared
  denominator**. The graph's intent is mass-conserving; the model reflects
  that. If `n_A` is not directly available, the compiler estimates it as
  `max(Σ k_siblings, max_i(n_i))` and emits a diagnostic. If the source
  data doesn't actually conserve mass, the Multinomial produces a poor
  fit — divergences, high r-hat, or wide posteriors — which is a data
  quality signal, not a modelling error. In practice `n_A` is almost
  always available via the Nquery mechanism.
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
- ~~Shared denominator source~~: **always Multinomial**. The graph's intent
  is mass-conserving; the model reflects that. If `n_A` is not directly
  available, estimate as `max(Σ k_siblings, max_i(n_i))` and emit
  diagnostic. No unsafe approximations (`max(n_B, n_C)` is banned). Mass
  conservation violations surface as data quality signals via model
  diagnostics (divergences, high r-hat).
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
- ~~IR purity~~: **TopologyAnalysis carries join recipes, not computed
  values**. Traffic weights and moment-matched collapsed path models are
  functions of latent edge probabilities — they belong in `build_model` as
  deterministic PyTensor expressions, not in the structural IR. The IR
  records which edges converge at each join and the instruction to collapse;
  `build_model` executes the collapse with actual latent values.
- ~~Fingerprint scope~~: **two-tier fingerprint**. `topology_fingerprint`
  (hash of TopologyAnalysis) answers "has the graph structure changed?" —
  used for warm-start eligibility. `model_fingerprint` (hash of
  TopologyAnalysis + BoundEvidence + structural settings: exhaustiveness,
  coupling toggle, pooling policy, prior policy) answers "is a cached trace
  compatible with this exact model?" — used for cache hit/miss. Two runs
  with the same graph but different training windows share a topology
  fingerprint (warm-start eligible) but have different model fingerprints
  (can't reuse cached trace).
- ~~Non-latency edges in cohort mode~~: **completeness uses path-level
  latency**. A non-latency edge downstream of latency edges inherits
  upstream path immaturity via `path_latency` propagation. Completeness
  = 1.0 only when the **entire path** from anchor has trivial latency.
  See §Non-latency edges in cohort mode for the updated rule.
- ~~Window + cohort for the same edge~~: **both contribute —
  hierarchically registered, temporally complementary**. Window and
  cohort terms for the same edge are linked through a shared `p_base_XY`
  with observation-type-specific probability variables (`p_window_XY`,
  `p_cohort_XY`) and shared latency parameters `mu_XY`, `sigma_XY` in a
  single `pm.Model` (see Layer 3 "hierarchical pooling with path-informed
  divergence"). `p_window_XY` is tightly pooled toward `p_base_XY`;
  `p_cohort_XY` can diverge by `τ_cohort_XY = σ_temporal · path_sigma_AX`,
  reflecting both temporal shift and path-length diffusion. **The same
  hierarchical structure extends to latency** (see "Hierarchical latency:
  mirroring the probability structure"): window uses edge-level
  `(mu_base, sigma_base)` directly; cohort uses path-level
  `(onset_cohort, mu_cohort, sigma_cohort)` with the FW-composed edge
  latency as prior and path-informed divergence allowance. Both need
  completeness adjustment at different scopes: window completeness couples
  to **edge-level** latency only (single hop); cohort completeness couples
  to the **cohort-level latent** path latency. The window anchors
  `p_base` and edge latency early (no upstream uncertainty); the cohort
  adds path-level coupling as it matures. The hierarchical structure
  means divergence between window and cohort performance is a learned
  signal (captured by `σ_temporal` for probability, `σ_latency_temporal`
  for latency), not a data quality problem. Date overlap at the
  edge-event level (not the anchor level) should be detected by the
  evidence binder and flagged as a diagnostic; the initial implementation
  accepts the mild overconfidence rather than attempting deduplication.
- ~~Hierarchical warm-start rules~~: **progressively enabled with care**.
  Solo-edge Beta posteriors are warm-started (same shape, same
  interpretation). Dirichlet base simplex, κ, and slice deviations are
  not warm-started (structure may change between runs). Latency posteriors
  are not warm-started (completeness coupling risk). See
  `8-compiler-implementation-phases.md` for warm-start rules by phase.
- ~~Context dimension MECE classification~~: **per-dimension metadata flag**.
  `context(channel)` and `case(test:variant)` are MECE by construction
  (each user belongs to exactly one value). `visited(node_id)` is never
  MECE (a user can visit multiple nodes). Cross-products of MECE dimensions
  are themselves MECE. MECE dimensions get slice-level Dirichlet/pooling
  with partition-based double-counting prevention. Non-MECE dimensions get
  independent per-slice likelihoods without the partition constraint — no
  residual computation, no aggregate exclusion.
- ~~Distribution family extensibility~~: **family-dispatched from the
  start**. The IR carries a `latency_family` tag per edge and a
  `prob_family` tag per edge (defaults: `shifted_lognormal` and `Beta`).
  Composition, collapse, CDF, and variable creation are dispatched by
  these tags. Initially one value per tag is supported. This is a design constraint,
  not a premature abstraction — it prevents distribution-specific
  assumptions from being baked into the IR or composition pipeline. Future
  families (shifted Gamma, Weibull, mixture-of-lognormals, logit-Normal)
  slot in by implementing the same interface. Model comparison via
  WAIC/LOO-CV selects between families.
- ~~Evidence inheritance across topology changes~~: **decaying weighted
  inheritance from analogous edges**. When topology changes invalidate
  direct history, an `evidence_inherit` annotation on the edge points at
  a source edge (optionally at a historical version via `asat`). The
  source's posterior encodes its accumulated evidence as effective
  observations; `strength` (0 = hint, 1 = strong) and exponential decay
  from `created_at` (half-life ~90 days) control what fraction of those
  observations carry over. Combined with any own history via precision-
  weighted average. Does not add latent variables — affects prior
  hyperparameters (which encode evidence as pseudo-observations) only.
  Post-Phase-A feature.
- ~~Per-slice quality metrics in the posterior schema~~: **keyed sub-map
  within the existing `posterior` block**. The edge-level `posterior`
  stays exactly as designed in doc 4 (always present, same shape). A
  `slices` sub-map is added, keyed by slice DSL string (the natural
  unique identifier). Each value has the same fields as the edge-level
  posterior: `alpha`, `beta`, `hdi_lower`, `hdi_upper`, `ess`, `rhat`.
  Consumers that don't care about slices ignore `slices`. `fit_history`
  remains edge-level only (per-slice trajectory history would be
  prohibitively verbose and isn't needed for prior calibration — the DL
  estimator operates on the edge aggregate). Present only when slice
  pooling is active. See doc 4 for the base schema.
- ~~Divergence count persistence~~: **yes, add `posterior.divergences`
  (integer)**. The sampler reports divergence count via ArviZ; persist it
  per-edge alongside `rhat` and `ess`. Also add to `fit_history` entries
  (divergence count per fit is important for tracking whether model
  quality is improving or degrading). Also add `total_divergences` to the
  graph-level `_bayes.quality` block. Negligible schema cost; high
  diagnostic value for fit quality visualisation and trajectory surprise
  detection.
- ~~Fit quality reporting granularity~~: **compute at edge level,
  summarise at graph level in `_bayes.quality`**. The graph-level summary
  is derived by the webhook handler from edge-level metrics at commit
  time, not computed independently by the sampler. Extend `_bayes.quality`
  with `total_divergences`, `edges_by_tier` (prior cascade tier
  distribution: how many edges used direct history, trajectory-calibrated,
  inherited, uninformative), and `edges_with_surprise` (count with
  |z| > 2). The FE reads per-edge `posterior.rhat`, `posterior.ess`,
  `posterior.evidence_grade` etc. for edge-level colour-coding; reads
  `_bayes.quality` for the graph-level "is this model trustworthy?"
  summary.

## Proof obligations (test gate)

The following acceptance tests are required proof that the design is
correctly implemented. Each test protects a specific invariant. They are
listed by the subsystem or interaction they cover.

### Topology analysis

- **Branch group identification**: given a known graph, assert correct
  sibling grouping, solo-edge classification, and join-node identification
- **Path onset accumulation**: assert `path_delta` equals the sum of edge
  onsets along the path, including through joins
- **Join recipe correctness**: assert that non-terminal joins carry the
  correct inbound edge identities and that terminal joins are inert
- **Topo-sort determinism**: same graph → same ordering, byte-for-byte

### Evidence binding

- **Slice partition detection**: given exhaustive slices, assert aggregate
  is excluded from likelihood; given partial slices, assert residual is
  correctly computed
- **MECE dimension classification**: assert `context()` dimensions flagged
  MECE produce exclusive partitions; `visited()` flagged non-MECE does not
  attempt residual computation
- **Window + cohort co-occurrence**: assert both bind to the same
  `p_base_XY` (hierarchical anchor) and shared `mu_XY`, `sigma_XY`;
  assert `p_window_XY` is tightly pooled toward `p_base_XY` (small
  `τ_window`); assert `p_cohort_XY` has divergence allowance
  `τ_cohort_XY = σ_temporal · path_sigma_AX`; window terms use
  edge-level completeness (single hop), cohort terms use path-level
  completeness (full chain); assert date-overlap diagnostic is emitted
  when windows share coverage
- **Non-latency edge handling**: assert cohort evidence on non-latency edges
  gets completeness = 1.0 with diagnostic
- **Latency prior derivation**: assert model-space (onset-subtracted)
  mu/sigma match expected values from known lag summaries
- **Double-counting prevention**: assert that when slices exhaustively
  partition the aggregate, only slice-level terms enter the likelihood

### Model materialisation

- **FW parity**: for known edge latency parameters, assert FW-composed
  path model matches the analytical result within tolerance
- **Moment preservation at joins**: for a known join with 2–3 inbound paths
  and given weights, assert the collapsed `(delta_mix, mu_mix, sigma_mix)`
  preserves mean and variance of the full mixture
- **`path_delta` correctness**: assert `completeness = 0` when
  `age < path_delta`, and `completeness → 1` for large age
- **Completeness-adjusted Multinomial**: assert per-sibling completeness
  factors produce correct effective probabilities and that
  `p_effective_dropout` converges to `1 - Σ p_i` as age → ∞
- **Probability–latency coupling**: assert that the joint model can
  distinguish low-p from slow-latency given a mix of mature and immature
  daily observations (parameter recovery test)

### Warm-start, trajectory calibration, and caching

- **Trajectory-calibrated prior (stable edge)**: given a fit_history with
  low variance, assert `n_eff` is high (near ESS_CAP) and the Beta prior
  is tight around the last posterior mean
- **Trajectory-calibrated prior (volatile edge)**: given a fit_history with
  high variance, assert `n_eff` is low and the Beta prior is wide
- **DerSimonian-Laird correctness**: given a known fit_history with
  analytically computable `tau^2`, assert the estimated between-run
  heterogeneity matches
- **Surprise detection**: given a fit_history followed by a new posterior
  that departs significantly, assert `|z| > 2` diagnostic is emitted;
  given a departure within historical range, assert no surprise diagnostic
- **ESS cap**: assert `n_eff` is clamped to ESS_CAP even when trajectory
  variance is near zero (prevents unbounded concentration)
- **Minimum history fallback**: with `K < 3` fit_history entries, assert
  the compiler falls back to simple warm-start with fixed ESS cap
- **Overlap detection**: assert warm-start is rejected (or ESS-discounted)
  when new evidence overlaps the previous training window
- **Topology fingerprint**: assert fingerprint changes when graph structure
  changes and is stable when only evidence changes
- **Model fingerprint**: assert fingerprint changes when structural settings
  (exhaustiveness, coupling toggle, pooling policy) change
- **Evidence inheritance (fresh, strong)**: given an `evidence_inherit`
  annotation with strength ~0.8 and age 0, assert inherited ESS is ~80%
  of source ESS and the prior mean matches the source's posterior mean
- **Evidence inheritance (aged)**: given the same annotation aged 180 days,
  assert inherited ESS has decayed to < 5% of source ESS
- **Evidence inheritance + own history**: given both an inheritance
  annotation and the edge's own fit_history, assert the combined prior
  reflects both sources with own history dominating as it accumulates
- **Prior cascade tier diagnostic**: assert the compiler emits a diagnostic
  identifying which evidence source tier was used for each edge

### Degradation and invalidation

- **Missing denominator estimation**: assert branch group still compiles
  as Multinomial when `n_A` is unavailable, with estimated denominator and
  diagnostic emitted to session log
- **Poorly identified model diagnostic**: assert compiler flags edges with
  weak latency evidence + all-immature daily observations
- **Structural role change**: assert warm-start is rejected when an edge
  moves from solo to branch group (or vice versa)

