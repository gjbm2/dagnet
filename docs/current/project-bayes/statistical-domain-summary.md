# DagNet Statistical Domain: Comprehensive Summary

**Date**: 16-Mar-26
**Purpose**: Consolidated understanding of DagNet's statistical architecture,
data pipeline, and the Bayesian inference programme, synthesised from exhaustive
review of all stats-related documentation in the repository.

**Sources reviewed**: All 7 project-bayes design docs, snapshot DB design,
analysis-forecasting docs, LAG pipeline docs, latency reference, onset
implementation plan, histogram-fitting proposal, Bayesian engine research,
confidence intervals spec, forecasting settings reference, cohort latency params,
t95 investigation, and archive docs.

---

## 1. What DagNet is modelling

DagNet models **conversion funnels** as directed acyclic graphs. Each node is a
user state (e.g. "signed up", "activated", "purchased"). Each edge represents a
conversion step with two statistical quantities:

- **Probability** (`p`): fraction of users at the source node who eventually
  reach the target node.
- **Latency**: the time it takes for those who do convert. Not all edges have
  meaningful latency; the `latency_parameter` flag distinguishes tracked vs
  instant edges.

The fundamental challenge is that conversion data is **right-censored**: for
recent cohorts, not all eventual converters have been observed yet. A cohort
entered yesterday shows fewer conversions than the same cohort will show in 30
days. Without correction, recent data systematically understates true conversion
rates.

---

## 2. The shifted lognormal latency model

Conversion latency is modelled as a **shifted lognormal**:

```
T = delta + X
where delta = onset_delta_days (deterministic dead-time)
      X ~ LogNormal(mu, sigma)
```

This applies to **both** `window()` and `cohort()` query modes. The onset
(`delta`) represents a period during which no conversions can occur — a
structural dead-time before users can possibly complete the next step. It is
derived from the Amplitude lag histogram via the `deriveOnsetDeltaDaysFromLagHistogram`
function using a cumulative mass threshold (alpha = 1%).

Key parameters persisted per edge:

| Field | Meaning |
|---|---|
| `mu` | Log-mean of post-onset latency X |
| `sigma` | Log-stdev of post-onset latency X |
| `onset_delta_days` | Dead-time shift delta |
| `t95` | 95th percentile of total lag T = delta + quantile(X, 0.95) |
| `model_trained_at` | When the model was last fitted (UK date) |

These live on `edge.p.latency` in graph files and in the latency section of
parameter files.

### Fitting from summary statistics

The current fitter uses Amplitude-reported median and mean lag:

```
median_X = max(epsilon, median_lag_days - delta)
mean_X   = max(epsilon, mean_lag_days - delta)
mu       = ln(median_X)
sigma    = sqrt(2 * ln(mean_X / median_X))
```

Quality gates (minimum converters, mean/median ratio) determine whether the
empirical fit is trusted or falls back to `DEFAULT_SIGMA` and `DEFAULT_T95_DAYS`.

### t95 tail constraint

`t95` acts as a one-way constraint: if the fitted sigma produces a t95 below
the authoritative value (user-overridden or system default), sigma is inflated
to match. This prevents thin-tail optimism that would prematurely declare
cohorts mature.

---

## 3. Two query modes: window() vs cohort()

### window()

Selects users who entered the **source node** within a date range. Latency is
**edge-local** (X to Y only). The relevant distribution is the X-to-Y edge
model. Onset is present — window() edges do have onset derived from the lag
histogram.

### cohort()

Selects users who entered at the **anchor node** (A) within a date range.
Latency is **path-level** (A to Y). The relevant distribution is the A-to-Y
path model, which is the convolution of all upstream edge latencies along the
path.

The relationship between the two modes is not merely structural — it is
**informational and temporally distinct**. Two effects drive the
distinction:

1. **Temporal spread (diffusion)**: cohort members arrive at X spread
   across the A→X path latency (potentially 100+ days). Even with stable
   underlying conversion, convolving over this arrival distribution widens
   the cohort outcome distribution relative to a temporally localised
   window observation.

2. **Temporal shift (real drift)**: conversion rates genuinely move over
   time. Window captures the current rate; cohort reflects a historical
   blend. This divergence is a valuable signal — it indicates how much
   performance has shifted since the cohort was assembled.

Window and cohort are therefore **related but distinct distributions**, not
different views of an invariant `p_XY`. Any correct model must account for
both effects — how it does so is a design decision (see doc 6 Layer 3),
but the domain constraint is that window and cohort cannot share a single
probability parameter. Recent window() conversions are the best early
signal for adjusting cohort() expectations (window as canary).

---

## 4. Canonical edge model vs derived path model

### X-to-Y: the canonical edge model

The edge-level latency model (mu, sigma, onset_delta_days, t95) is the
**primary statistical identity** of each edge. It:

- Trains earliest from fresh evidence
- Updates frequently with new data
- Underpins window() forecasting
- Remains valid regardless of upstream topology changes

### A-to-Y: the derived path model

For cohort() semantics, the system needs the full anchor-to-target latency.
This is a **derived** quantity, not an intrinsic edge property. It depends on:

- Anchor identity
- Upstream topology (which edges are in the path)
- Current upstream X-to-Y model state
- Join policy (if paths merge)

Path-level parameters (`path_mu`, `path_sigma`, `path_t95`) are computed via
**Fenton-Wilkinson approximation** for the sum of lognormals:

```
path_delta = sum(edge delta_i)              -- deterministic
path_mu, path_sigma from FW(edge_i params)  -- stochastic approximation
path_t95 = path_delta + quantile(LogNormal(path_mu, path_sigma), 0.95)
```

These are propagated through the graph via the LAG pass's topological DP,
using `approximateLogNormalSumFit`. They are persisted alongside edge-level
params so the backend can evaluate cohort-mode completeness without re-deriving
them.

---

## 5. Completeness: the coupling between probability and latency

Completeness is the fraction of eventual converters observed by a given cohort
age. It is the lognormal CDF evaluated at the effective age:

```
effective_age = anchor_age - upstream_lag    (for downstream edges)
model_age     = max(0, effective_age - onset_delta_days)
completeness  = LogNormalCDF(model_age, mu_path, sigma_path)
```

For **mature** cohorts (completeness near 1.0): observed k/n directly estimates
true conversion rate.

For **immature** cohorts: the observed rate understates reality. The system
applies an evidence-forecast blend:

```
w_evidence = (completeness * n_query) / (lambda * n_baseline + completeness * n_query)
projected  = w_evidence * observed + (1 - w_evidence) * baseline
```

This is the **probability-latency coupling**: the likelihood for immature data
jointly constrains both p (via total conversion count) and (mu, sigma) (via the
age-dependent completeness CDF). The Bayesian model must preserve this coupling.

---

## 6. Hierarchical partial pooling for context slices

### 6.1 Why partial pooling matters

DagNet supports **context slices** — segmented views of conversion data by
dimensions like channel (paid/organic), device (mobile/desktop), geography,
etc. A single edge may have evidence across multiple slices, each with
different sample sizes and potentially different true conversion rates.

The modelling question is: should each slice be estimated independently, or
should slices share information? Neither extreme is correct:

- **Fully independent** (no pooling): each slice uses only its own data. Works
  for high-traffic slices but produces noisy, unreliable estimates for
  low-traffic slices. A slice with 3 conversions out of 10 users gets treated
  as definitive.

- **Fully pooled** (complete pooling): all slices share a single conversion
  rate. Ignores real differences between slices. Paid traffic genuinely
  converts differently from organic.

**Partial pooling** is the Bayesian solution: slices borrow strength from each
other through a shared prior, but each slice can deviate from the group mean.
Low-evidence slices are pulled toward the group mean (shrinkage); high-evidence
slices are free to express their own rate. The degree of shrinkage is itself
estimated from the data — this is what makes it hierarchical.

### 6.2 The 4-layer probability hierarchy

The compiler builds a 4-layer hierarchy for conversion probabilities:

| Layer | Scope | What it represents |
|---|---|---|
| **Graph hyper** | Global | Typical conversion rate and concentration across the entire graph. Anchors all branch-group priors. |
| **Branch family** | Per branching node | Concentration parameters for the Dirichlet governing sibling edges at a node. Controls how peaked or diffuse the branch split is. |
| **Edge** | Per edge | The edge-level conversion probability (component of Dirichlet for branches, independent Beta for solo edges). |
| **Slice** | Per edge x context | Slice-specific deviation from the edge mean. `logit(p_slice) = logit(p_edge) + delta_slice`, where `delta_slice ~ Normal(0, tau_slice)`. |

`tau_slice` is the pooling strength parameter — small tau means heavy pooling
toward the edge mean; large tau means slices are nearly independent. It is
estimated from the data, not fixed.

### 6.3 The per-slice Dirichlet constraint

At branching nodes (out-degree > 1), sibling edge probabilities must sum to
<= 1. This creates a critical subtlety when combined with context slices:

**Naive approach (wrong)**: fit a single Dirichlet for the branch group, then
add per-slice logit deviations. The deviations can push `p_B_paid + p_C_paid > 1`,
violating the simplex constraint.

**Correct approach**: for each slice independently, draw from a Dirichlet:

```
(p_B_paid, p_C_paid, p_dropout_paid)       ~ Dirichlet(alpha_paid)
(p_B_organic, p_C_organic, p_dropout_organic) ~ Dirichlet(alpha_organic)
```

Partial pooling across slices comes from sharing concentration parameters:

```
alpha_paid    ~ f(alpha_branch)
alpha_organic ~ f(alpha_branch)
```

This is a **hierarchical Dirichlet** pattern (not HDP — a simpler parametric
version). Each slice respects the simplex independently; slices borrow strength
through the shared branch-level hyperprior.

### 6.4 Latency partial pooling

The same partial pooling logic applies to latency parameters:

- **Edge-level**: `mu_edge`, `sigma_edge` with graph-level hyperpriors
- **Slice-level**: `mu_edge_slice = mu_edge + delta_mu`, with pooling controlled
  by a latency-specific tau

This means a low-traffic context slice that shows unusual latency will be
pulled toward the edge-level latency estimate, rather than producing a noisy
fit from sparse data.

### 6.5 Why this is the hardest part of the compiler

The compiler must recognise when a branch group intersects with a slice group
and emit the hierarchical Dirichlet structure rather than the simpler
"Dirichlet + logit deviations" structure. It must also handle:

- Slices with zero evidence (collapse to edge prior)
- Slices present for some edges in a branch group but not others
- Latency partial pooling interacting with the completeness coupling (immature
  slice data jointly constrains both slice-level p and slice-level mu/sigma)

No existing tool handles this combination. The reference implementation
(section 9.5) has no slice layer at all — this is identified as its most
critical gap relative to the DagNet design.

---

## 7. Data pipeline: Amplitude to snapshot DB to model

### 7.1 What Amplitude provides per fetch

For each edge query, Amplitude returns:

- **Counts**: per-anchor-day n (entered source) and k (reached target)
- **Lag moments**: per-anchor-day median and mean transition times (ms)
- **Lag histogram**: binned transition time distribution
  (`stepTransTimeDistribution`) — covers first ~10 days only
- **Aggregate lag moments**: overall median and mean transition times

### 7.2 What is persisted to parameter files

Per-slice (cohort or window), parameter files store daily arrays:

- `dates[]`, `n_daily[]`, `k_daily[]`
- `median_lag_days[]`, `mean_lag_days[]`
- `anchor_n_daily[]`, `anchor_median_lag_days[]`, `anchor_mean_lag_days[]`
  (for downstream edges in 3-step funnels)

Plus edge-level summary latency block:
`{ median_lag_days, mean_lag_days, onset_delta_days, t95 }`

### 7.3 Snapshot DB: the durable evidence layer

The snapshot DB persists **repeated observations** of the same cohorts over
time. Per row:

- `A`, `X`, `Y` (counts at each funnel step)
- `median_lag_days`, `mean_lag_days` (edge-local lag)
- `anchor_median_lag_days`, `anchor_mean_lag_days` (cumulative A-to-source lag)
- `onset_delta_days`
- `anchor_day` (which cohort)
- `retrieved_at` (when observed)

The power of the snapshot DB is the **panel structure**: the same `anchor_day`
observed at successive `retrieved_at` dates, with Y/X increasing as the cohort
matures. This repeated-observation panel is the core censoring evidence for
both pre-Bayes fitting and future Bayesian inference. It reveals the long-tail
latency signal that no single fetch's histogram can capture.

### 7.4 Non-latency edges in cohort() mode

Even edges without the `latency_parameter` flag can exhibit cohort-type
maturity behaviour when they sit downstream of latency edges. Cohort members
arrive at the source node at different times due to upstream path latency.
The A-to-Y distribution for a non-latency edge equals the upstream A-to-X
distribution (convolution with a delta at zero = upstream unchanged).

Furthermore, non-latency edges in cohort() mode still need a distribution
(or at least an onset) for the Bayesian model. They may be modelled as a
sharp/degenerate distribution.

---

## 8. Current statistical architecture (pre-Bayes)

### 8.1 Frontend statistical code (to be deleted)

The frontend currently owns fitting:

- **Pure maths layer**: `lagDistributionUtils.ts` (~350 lines) — erf, CDF,
  inverse CDF, fitLagDistribution, toModelSpace
- **Orchestration layer**: `statisticalEnhancementService.ts` (~3200 lines) —
  the full LAG pipeline: per-cohort completeness, evidence-forecast blending,
  recency weighting
- **Onset derivation**: `onsetDerivationService.ts` — derives onset from
  histogram data via cumulative mass threshold

### 8.2 Backend statistical code (the future owner)

The backend (Python) is being established as the single source of truth for
fitting. The split is:

- **Fitting** (Python, master): recompute lag models when evidence changes or
  user requests. Reads from snapshot DB. Runs via `POST /api/lag/recompute-models`.
- **Application** (Python, analysis-time): evaluate completeness, projections,
  blends for the analysis window without refitting.

Fitting runs only on model update events (new snapshot data, explicit user
trigger), NOT on query edits or analysis requests.

### 8.3 Forecasting settings

All tuning constants are per-repo configuration, edited in
`graph-editor/src/constants/latency.ts`. The frontend sends them in every API
request. Python defines matching defaults. A `settings_signature` hash is
persisted with each fitted model for reproducibility and audit.

Key settings: `min_fit_converters`, `default_sigma`, `recency_half_life_days`,
`onset_mass_fraction_alpha`, `t95_percentile`, `forecast_blend_lambda`,
`blend_completeness_power`.

Bayesian posterior retention settings (added for Project Bayes):
`bayes_fit_history_interval_days` (default 7 — weekly snapshots),
`bayes_fit_history_max_entries` (default 12 — ~3 months of history).
These control the rolling `fit_history` array on each posterior, which
provides the fitting engine with posterior drift trajectory without
requiring git archaeology.

---

## 9. The Bayesian inference programme

### 9.1 Two workstreams converging

**Semantic foundation** (fix the existing system):
1. **Evaluator unification**: analysis logic and chart overlays use the same
   evaluator with the same parameters
2. **Python model ownership**: move fitting to Python, compute A-to-Y path
   models from snapshot evidence + X-to-Y edge models
3. **FE stats deletion**: delete ~4000+ lines of FE fitting code

**Async infrastructure** (build the plumbing):
1. Schema additions for posterior data
2. Webhook handler with atomic multi-file git commit
3. Compute vendor setup (Modal)
4. Submission route, FE trigger
5. FE integration (job tracking, session log)

These converge into **Bayesian inference** — real models running on proven
infrastructure.

### 9.2 The graph-to-hierarchy compiler (core complexity)

The compiler translates graph topology into Bayesian model structure. 8 steps:

1. **Canonicalise**: stable node/edge identities, topological sort
2. **Branch groups**: identify sibling sets, exhaustive vs non-exhaustive
   (Dirichlet with phantom dropout component)
3. **Probability hierarchy**: 4 levels — graph hyper, branch family, edge,
   slice (partial pooling via hierarchical Dirichlet)
4. **Latency hierarchy**: edge-level mu/sigma with graph hyperpriors,
   slice-level deviations, deterministic path composition
5. **Probability-latency coupling**: immature cohort likelihood jointly
   constrains p and (mu, sigma) via completeness CDF
6. **Evidence binding**: map snapshot rows to hierarchy leaves, mature vs
   immature partition, recency weighting
7. **Validate and fallback**: minimum signal thresholds, degenerate group
   detection, per-group degradation (pooled-only / point-estimate / skip)
8. **Emit IR**: serialisable hierarchy consumed by model builder

### 9.3 The per-slice Dirichlet problem

The hardest modelling subtlety. At branching nodes with context slices, a
naive "Dirichlet + logit deviations" approach violates the simplex constraint
per slice. The correct approach: per-slice independent Dirichlet draws with
concentration parameters pooled across slices via a shared branch-level
hyperprior (hierarchical Dirichlet pattern).

### 9.4 Evidence degradation ladder

| Level | Condition | Meaning |
|---|---|---|
| 0 | No evidence | Cold start — uniform prior Beta(1,1) |
| 1 | 0 < n < 10 | Weak — prior-dominated |
| 2 | n >= 10 | Mature — likelihood-dominated |
| 3 | n >= 10 + converged posterior | Full Bayesian |

Maps to provenance flags: `bayesian / pooled-fallback / point-estimate / skipped`.

### 9.5 Model materialisation (PyMC)

The compiler emits runtime-agnostic IR; a separate model builder translates to
PyMC. Key patterns from reference implementation review:

- Binary edges: `Beta(alpha, beta)` + `Binomial(n, p, observed=k)`
- Branch groups: `Dirichlet(concentration)` + `Multinomial`
- Latency edges: `LogNormal(mu, sigma)` — in our design, these participate in
  the completeness CDF constraint (unlike the reference impl which treats them
  as prior-only)
- Prior overflow guard: cap Beta params at 500, fall back to weak prior
- Artefact boundary: only plain Python types cross the persistence layer

### 9.6 Determinism and warm-start

Same (graph snapshot + policy + evidence window) must produce the same IR.
Model fingerprint enables warm-start from previous posterior when graph
structure hasn't changed.

---

## 10. Key semantic invariants

These are the invariants the system must satisfy:

1. **Evaluator congruence**: for any analysis, the analysis logic and chart
   overlay must use the same A-to-Y (cohort) or X-to-Y (window) model source
   and the same evaluator.

2. **Onset consistency**: onset must be applied as part of the model contract
   (T = delta + X), not as an ad-hoc display tweak. Both window() and cohort()
   edges use onset.

3. **Single fitting owner**: Python is master of fitting. The frontend is a
   pure applier of fitted parameters.

4. **Provenance tracking**: every parameter carries a provenance flag so
   consumers know whether it came from Bayesian inference, pooled fallback,
   point estimate, or was skipped.

5. **Completeness coupling**: the likelihood for immature cohort data must
   jointly constrain both conversion probability and latency parameters.

---

## 11. Outstanding concerns and gaps

### 11.1 Distribution type flexibility

The current system assumes lognormal throughout. It is not obvious that latency
will always be lognormal. The posterior schema must record distribution type
explicitly so future models can use alternative families.

### 11.2 Anchor-leg onset

`onset_delta_days` is currently derived for the X-to-Y edge from the lag
histogram. There is no equivalent `anchor_onset_delta_days` for the A-to-X
leg. Doc 1 §10.4 recommends deriving it from the A→X histogram at fetch
time. This affects **analytic (pre-Bayes) path composition only**:

```
path_delta = anchor_onset + edge_onset
```

The Bayesian compiler does not need pre-computed onset — it estimates
delta as part of the MCMC posterior from panel data (A, X, Y counts +
`anchor_median_lag_days` / `anchor_mean_lag_days`, all persisted in the
snapshot DB). For the analytic pipeline, `anchor_median_lag_days` serves
as a conservative proxy. Proper `path_delta` accumulation comes with
Semantic Foundation Phase 2 (doc 1 §15.3.4).

As of 17-Mar-26, `_resolve_completeness_params()` in `api_handlers.py`
ensures the BE chart CDF uses edge onset (not `0.0`) for cohort path
params, and will use `path_delta` when available.

### 11.3 Non-latency edge distributions

In cohort() mode, non-latency edges downstream of latency edges still need a
distribution. At minimum an onset (implying a degenerate/sharp distribution).
This is acknowledged but not yet implemented.

### 11.4 Window-cohort relationship: domain constraints

window() and cohort() observations on the same edge are related but
**not views of an invariant distribution**. They differ in two ways:

1. **Temporal spread (diffusion)**: cohort members arrive at X spread across
   the A→X path latency (potentially 100+ days). Even with stable conversion
   rates, the convolution over this arrival distribution widens the cohort
   outcome distribution relative to a temporally localised window observation.

2. **Temporal shift (real drift)**: conversion rates genuinely move over time.
   Window captures the current rate; cohort reflects a historical blend. This
   divergence is a valuable forecasting signal — it indicates how much
   conversion performance has shifted since the cohort was assembled.

**Domain constraints on any modelling approach**:
- Window and cohort must have separate probability parameters (they are
  distinct distributions).
- The model must structurally relate them (they are not independent — they
  measure the same underlying process at different temporal blends).
- The permissible divergence between them should scale with the path's
  temporal spread (longer paths → more diffusion → more divergence expected).
- Latency parameters (`mu_XY`, `sigma_XY`) are shared (latency is a physical
  property of the edge, not observation-type-dependent).
- Window data is the best early canary for future cohort performance — the
  model should encode this directional relationship.

See doc 6 Layer 3 for the chosen modelling approach.

### 11.5 Snapshot DB as primary evidence source

The model reads from the snapshot DB panel data, not just parameter files. The
repeated (anchor_day, retrieved_at, Y/X) observations are the durable
censoring evidence. Parameter files carry fitted summaries; the DB carries raw
evidence.

### 11.6 Histogram limitations

The Amplitude lag histogram only covers the first ~10 days. Long-tail signal
must come from the snapshot panel (repeated observations over time). The
histogram is useful for onset detection but insufficient for full distribution
fitting.

---

## 12. Glossary

| Term | Definition |
|---|---|
| **Anchor (A)** | Furthest upstream START node; defines cohort entry dates |
| **Cohort age** | Days since anchor entry: `retrieved_at - anchor_day` |
| **Completeness** | Fraction of eventual converters observed by a given age; `CDF(effective_age - onset, mu, sigma)` |
| **Effective age** | Cohort age minus upstream cumulative lag to the edge's source node |
| **Evidence** | Observed k/n from snapshot data |
| **Forecast** | Projected conversion rate from mature baseline |
| **Fenton-Wilkinson (FW)** | Moment-matching approximation for sum of lognormals |
| **LAG** | Latency-Adjusted Graphs — the statistical enhancement pipeline |
| **Model space** | Post-onset time: `X = T - delta` |
| **Onset (delta)** | Dead-time before conversions begin; derived from histogram cumulative mass threshold |
| **Path model (A-to-Y)** | Derived convolution of edge latencies from anchor to target |
| **Slice** | Contextual segmentation (e.g. channel:paid, device:mobile) |
| **t95** | 95th percentile of total lag T; acts as one-way tail constraint |
| **User space** | Total elapsed time T from event occurrence |
