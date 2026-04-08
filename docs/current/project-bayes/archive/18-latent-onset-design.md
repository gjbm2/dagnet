# Doc 18 — Latent Onset and Onset Dispersion

**Status**: Design
**Date**: 21-Mar-26
**Purpose**: Make onset (`onset_delta_days`) a latent variable estimated by
MCMC, add dispersion parameters for both edge-level and path-level onset,
and surface onset posteriors in the FE.

**Related**: `6-compiler-and-worker-pipeline.md` (compiler model spec),
`9-fe-posterior-consumption-and-overlay.md` (FE consumption),
`15-model-vars-provenance-design.md` (model vars provenance),
`programme.md` (programme phasing)

---

## 1. Motivation

### 1.1 Current state

Edge-level onset (`onset_delta_days`) is a **fixed scalar** derived from the
Amplitude lag histogram via a 1% cumulative mass threshold
(`deriveOnsetDeltaDaysFromLagHistogram`). It enters the model as a constant
— not estimated, no posterior uncertainty.

Path-level onset (`onset_cohort`) is already latent in Phase D step 2.5, but
only for edges with 2+ latency edges on the path. Its prior spread
(`HalfNormal(sigma=max(onset_prior, 1.0))`) is hardcoded, not learned from
data.

### 1.2 Problems

1. **Fragile evidence source.** The histogram only covers ~10 days. Edges
   with long onset (subscription renewal cycles, enterprise onboarding) get
   a compressed view. The 1% threshold is arbitrary — different products
   have different noise floors.

2. **No uncertainty propagation.** A wrong onset biases completeness, which
   biases `p`, with no way for the model to express doubt. An edge with
   onset = 3 days (from a noisy histogram) vs onset = 7 days (the true
   value) produces materially different completeness at young cohort ages.
   The model has no mechanism to flag this.

3. **Onset-mu tradeoff invisible.** Onset and mu jointly determine the CDF
   shape. With onset fixed, all shape uncertainty is absorbed by mu — but
   the posterior on mu is then overconfident (it assumes onset is known
   perfectly). The model can find compensating mu values that produce the
   right CDF at observed ages but extrapolate incorrectly.

4. **No graph-level onset hyperprior.** Edges in the same graph often have
   similar onset characteristics (same product, similar funnel steps). There
   is no mechanism for low-data edges to borrow onset strength from
   better-observed edges.

5. **Path-level onset prior is hardcoded.** The `HalfNormal` sigma for
   `onset_cohort` is `max(onset_prior, 1.0)` — not learned from data,
   not informed by how much onset varies across the graph.

### 1.3 What changes

- Edge-level onset becomes **latent** with a graph-level hyperprior
- A **dispersion parameter** (`tau_onset`) governs how much onset varies
  across edges — learned from data
- Path-level onset prior spread is derived from the learned dispersion
  rather than hardcoded
- Onset posterior (mean, sd, HDI) is surfaced in the FE alongside mu and
  sigma posteriors

---

## 2. Model changes

### 2.1 Graph-level onset hyperprior

```
# Typical onset scale across the graph
onset_hyper_mu ~ HalfNormal(sigma=10.0)

# How much onset varies across edges
tau_onset ~ HalfNormal(sigma=5.0)
```

`onset_hyper_mu` anchors the graph's typical dead-time. `tau_onset` controls
how much individual edges can deviate — small tau means edges share similar
onset; large tau means edges are heterogeneous.

Prior choices:
- `HalfNormal(10.0)` for `onset_hyper_mu`: most conversion funnels have
  onset between 0 and 20 days. The prior is broad enough to accommodate
  longer onset (enterprise, subscription) while gently regularising toward
  shorter values.
- `HalfNormal(5.0)` for `tau_onset`: permits substantial edge-to-edge
  variation but discourages pathological spread.

### 2.2 Edge-level latent onset

Replace the fixed `onset_delta_days` scalar with a latent variable:

```
# Non-centred parameterisation (avoid funnel geometry)
eps_onset_{edge} ~ Normal(0, 1)
onset_raw_{edge} = onset_hyper_mu + eps_onset_{edge} * tau_onset

# Informed prior: histogram-derived onset as additional constraint
# when available (soft, not hard)
onset_{edge} = softplus(onset_raw_{edge})

# If histogram-derived onset is available, add an informative
# observation (soft constraint, not a fixed value):
onset_obs_{edge} ~ Normal(onset_{edge}, sigma=onset_obs_uncertainty)
  observed = histogram_onset_value
```

Where:
- `softplus` ensures onset ≥ 0 (dead-time cannot be negative)
- `onset_obs_uncertainty` reflects the quality of the histogram estimate.
  Default: `max(1.0, histogram_onset * 0.3)` — 30% relative uncertainty,
  floored at 1 day. Edges with no histogram get no soft constraint (pure
  hierarchical prior).
- The histogram-derived value is treated as a **noisy observation** of the
  true onset, not as ground truth. This lets the trajectory data pull
  onset away from the histogram estimate when the data warrants it.

**Non-centred rationale**: same as `p_window`/`p_cohort` — when `tau_onset`
is small, the centred parameterisation creates funnel geometry. The
non-centred form (`hyper + eps * tau`) keeps the sampler efficient.

**Edges without latency**: edges with `latency_parameter == false` do not
get onset variables. Their onset remains 0 (instant conversion).

### 2.3 Window completeness with latent onset

Currently:
```
CDF_window = CDF_LN(max(0, age - onset_fixed), mu_edge, sigma_edge)
```

Becomes:
```
CDF_window = CDF_LN(softplus(age - onset_{edge}), mu_edge, sigma_edge)
```

The `softplus` replaces `max(0, ...)` — differentiable, so NUTS gradients
flow through onset. This is critical: with fixed onset, `max(0, ...)` was
fine (no gradient needed through onset). With latent onset, the gradient
`d(CDF)/d(onset)` must exist.

### 2.4 Path-level onset with learned dispersion

Currently (Phase D step 2.5):
```
onset_cohort ~ HalfNormal(sigma=max(onset_prior, 1.0))
```

Becomes:
```
# Path onset prior: sum of edge onsets (now themselves latent)
path_onset_prior = sum(onset_{edge_i} for edge_i in path)

# Dispersion informed by graph-level tau
path_onset_tau = tau_onset * sqrt(n_path_edges)

# Non-centred
eps_onset_path_{edge} ~ Normal(0, 1)
onset_cohort_{edge} = softplus(path_onset_prior + eps_onset_path * path_onset_tau)
```

Key differences from current:
- Prior centre is the **latent** sum of edge onsets (not fixed scalars) —
  gradients flow back to edge-level onset variables
- Dispersion is `tau_onset * sqrt(n_edges)` — scales with path length and
  is learned, not hardcoded
- `softplus` for differentiability and positivity

### 2.5 Join-node onset

At join nodes, the incoming path models are collapsed. For onset:

```
path_delta_at_join = min(onset_path_i)  # (current behaviour)
```

With latent onset, this becomes `pt.minimum(onset_path_a, onset_path_b)` —
differentiable via PyTensor. The gradient flows to whichever path has the
smaller onset.

### 2.6 Feature flag

```python
feat_latent_onset = features.get("latent_onset", True)
```

When `False`, onset reverts to the current fixed-scalar behaviour. This
allows A/B comparison and safe rollback. The flag follows the pattern of
`feat_latent_latency`, `feat_cohort_latency`, and `feat_overdispersion`.

---

## 3. Posterior output changes

### 3.1 LatencyPosteriorSummary (Python)

Add fields to the `LatencyPosteriorSummary` dataclass:

```python
# Edge-level onset posterior (new — currently onset is fixed)
onset_mean: float          # posterior mean of edge-level onset
onset_sd: float            # posterior SD of edge-level onset
onset_hdi_lower: float     # HDI lower bound
onset_hdi_upper: float     # HDI upper bound

# Path-level onset posterior (currently just a point value)
path_onset_sd: float | None = None       # posterior SD
path_onset_hdi_lower: float | None = None
path_onset_hdi_upper: float | None = None
```

The existing `onset_delta_days` field retains its meaning (posterior mean
replaces the fixed value). `path_onset_delta_days` retains its meaning
(posterior mean of path onset).

### 3.2 Graph-level onset hyperparameters

Add to the `_model_state` block (persisted for warm-start, not consumed by
FE directly):

```python
"onset_hyper_mu": float,   # posterior mean of graph-level onset
"tau_onset": float,        # posterior mean of onset dispersion
```

### 3.3 Webhook payload

The `to_webhook_dict()` method on `LatencyPosteriorSummary` gains the new
fields. They are added alongside existing fields — no breaking changes to
the payload structure.

---

## 4. FE consumption changes

### 4.1 TypeScript types

Extend `LatencyPosterior` in `src/types/index.ts`:

```typescript
export interface LatencyPosterior {
  // ... existing fields ...

  // Edge-level onset posterior (new)
  onset_mean: number;           // Posterior mean of onset (days)
  onset_sd: number;             // Posterior SD of onset
  onset_hdi_lower: number;      // HDI lower bound
  onset_hdi_upper: number;      // HDI upper bound

  // Path-level onset posterior (extend existing path_onset_delta_days)
  path_onset_sd?: number;       // Posterior SD of path onset
  path_onset_hdi_lower?: number;
  path_onset_hdi_upper?: number;
}
```

### 4.2 PropertiesPanel — latency section

Currently the latency section shows: mu ± mu_sd, sigma ± sigma_sd,
t95 HDI, onset (fixed scalar).

Add:
- **Onset row**: `onset_mean ± onset_sd` with HDI band
  `[onset_hdi_lower, onset_hdi_upper]` — same display pattern as mu and
  sigma rows.
- **Path onset row** (when path-level data present):
  `path_onset ± path_onset_sd` with HDI band. Labelled "Path onset" to
  distinguish from edge-level.
- Onset provenance follows the edge's latency `provenance` field — no
  separate provenance needed.

### 4.3 AnalysisInfoCard — Forecast/Diagnostics tab

The existing latency diagnostics section (mu/sigma convergence) gains an
onset subsection:
- Onset posterior mean, SD
- Onset HDI band
- Comparison to histogram-derived value (if available): show both the
  posterior estimate and the histogram input, so the user can see how much
  the model moved onset from the prior.

### 4.4 Model curve overlay

The Bayesian model CDF curve on the cohort maturity chart already uses
latency posteriors. With latent onset, the curve naturally reflects onset
uncertainty:
- The **mean** CDF curve uses `onset_mean` (or `path_onset_mean` for cohort).
- The **confidence band** (80% HDI) already marginalises over mu; it should
  now also marginalise over onset. This happens automatically if the
  backend band generator samples from onset's posterior alongside mu's.

### 4.5 ModelVarsEntry (doc 15)

The `latency` block in `ModelVarsEntry` gains `onset_delta_days` as a
posterior-derived value when `source === 'bayesian'`:

```typescript
latency?: {
  mu: number;
  sigma: number;
  t95: number;
  onset_delta_days: number;  // Already present — value now from posterior mean
  // ... path-level fields unchanged ...
};
```

No structural change needed — `onset_delta_days` in the Bayesian entry is
populated from the posterior mean rather than the histogram value. The
analytic entry retains the histogram-derived value.

---

## 5. Identifiability considerations

### 5.1 The onset-mu tradeoff

Onset and mu jointly determine the CDF shape. The same observed
completeness at age T can be explained by:
- Large onset + small mu (long dead-time, fast post-onset conversion)
- Small onset + large mu (short dead-time, slow post-onset conversion)

This creates a ridge in the posterior — onset and mu are negatively
correlated.

**Why this is manageable:**

1. **Trajectory data resolves the ridge.** The snapshot DB provides
   repeated observations at multiple ages (1d, 3d, 7d, 14d, 30d, 60d).
   The CDF shape at young ages (near onset) pins the onset-mu boundary.
   A wrong onset produces a wrong CDF shape at early ages even if the
   late-age CDF is correct.

2. **The histogram prior helps.** The soft constraint from the histogram
   estimate provides a starting region. The trajectory data refines it.

3. **The graph-level hyperprior regularises.** Edges with sparse data
   borrow onset strength from better-observed edges. The ridge is most
   dangerous when data is sparse — partial pooling mitigates exactly this.

4. **sigma breaks the symmetry.** The CDF curvature depends on sigma. At
   any given onset value, mu and sigma are jointly identified from the
   trajectory shape. The onset-mu degeneracy is only exact when sigma is
   also unknown and data is at a single age — the multi-age trajectory
   data resolves all three.

### 5.2 Monitoring

The posterior correlation between onset and mu should be monitored. If
`|corr(onset, mu)| > 0.9` for an edge, that edge's onset is poorly
identified — likely insufficient trajectory data at young ages. The
diagnostics should flag this.

Add to `LatencyPosteriorSummary`:
```python
onset_mu_corr: float | None = None  # posterior correlation
```

When `|onset_mu_corr| > 0.8`, emit a diagnostic warning. The FE can
surface this as part of the convergence diagnostics.

---

## 6. Warm-start implications

### 6.1 Edge-level onset

On subsequent runs, the previous posterior's `onset_mean` and `onset_sd`
seed the prior for onset. The ESS-capping mechanism (same as probability
warm-start) applies — prevents over-concentration from accumulated runs.

The warm-start chain for onset:
1. Previous posterior `onset_mean/onset_sd` → informative prior
2. No previous posterior → histogram-derived value as soft observation +
   hierarchical prior
3. No histogram → pure hierarchical prior from `onset_hyper_mu`

### 6.2 Graph-level hyperparameters

`onset_hyper_mu` and `tau_onset` are persisted in `_model_state` for
warm-start. On subsequent runs they provide a tighter graph-level prior,
which particularly benefits newly added edges.

---

## 7. Implementation plan

### Phase 1: Edge-level latent onset

**Scope**: Make `onset_delta_days` latent for all edges with
`latency_parameter == true`. Add graph-level hyperprior and dispersion.

**Files changed**:
- `bayes/compiler/model.py` — add onset variables, replace fixed onset in
  completeness CDF with latent variable, switch `max(0,...)` to `softplus`
- `bayes/compiler/types.py` — extend `LatencyPosteriorSummary` with onset
  posterior fields
- `bayes/compiler/inference.py` — extract onset posterior samples, compute
  onset summary statistics, populate new fields
- `bayes/compiler/evidence.py` — pass histogram-derived onset as prior data
  (already available in `LatencyPrior.onset_delta_days`), add uncertainty
  estimate

**Feature flag**: `latent_onset` (default `True`). When `False`, existing
fixed-onset behaviour is preserved exactly.

**Validation**: run on test graph, compare posteriors with and without
latent onset. Check that onset posterior means are close to histogram values
for well-observed edges and that mu posteriors are appropriately wider (no
longer absorbing onset uncertainty).

### Phase 2: Path-level onset with learned dispersion

**Scope**: Replace hardcoded `HalfNormal(sigma=max(...))` for
`onset_cohort` with dispersion derived from `tau_onset`. Connect path onset
prior to latent edge onsets.

**Files changed**:
- `bayes/compiler/model.py` — revise cohort onset prior to use `tau_onset`,
  connect to latent edge onsets for gradient flow
- `bayes/compiler/inference.py` — extract path onset SD and HDI
- `bayes/compiler/types.py` — add `path_onset_sd`, `path_onset_hdi_*`

**Validation**: cohort maturity curves should show appropriately wider bands
near onset. Path onset posteriors should be informed by both edge-level
onset posteriors and cohort trajectory data.

### Phase 3: FE consumption

**Scope**: Surface onset posteriors in the FE. Update types, properties
panel, and analysis views.

**Files changed**:
- `graph-editor/src/types/index.ts` — extend `LatencyPosterior`
- `graph-editor/src/components/analytics/AnalysisInfoCard.tsx` — add onset
  diagnostics display
- `graph-editor/src/components/` (PropertiesPanel, latency section) — show
  onset posterior with HDI
- `graph-editor/lib/graph_types.py` — extend Pydantic `LatencyPosterior`
  model

**Validation**: onset posterior visible in PropertiesPanel for edges with
latency posteriors. Histogram-derived vs posterior onset comparison visible
in diagnostics.

### Phase 4: Onset-mu correlation monitoring

**Scope**: Compute and surface onset-mu posterior correlation. Flag edges
with high correlation (poorly identified onset).

**Files changed**:
- `bayes/compiler/inference.py` — compute correlation from posterior samples
- `bayes/compiler/types.py` — add `onset_mu_corr` field
- FE diagnostics — display correlation, warn when high

---

## 8. Interaction with existing features

### 8.1 Analytic onset override

The user can currently override `onset_delta_days` on the analytic model
via `onset_delta_days_overridden`. Under doc 15's model vars design:

- The **analytic** `ModelVarsEntry` retains the user-overridden onset as
  its `latency.onset_delta_days`.
- The **bayesian** `ModelVarsEntry` uses the posterior-derived onset.
- The **manual** `ModelVarsEntry` (if user edits) snapshots whichever is
  currently promoted.

The Bayesian model does NOT consume the user's analytic onset override as a
prior. The histogram-derived value (pre-override) is used as the soft
observation. This avoids creating a feedback loop where user overrides
influence Bayesian posteriors which influence analytic values.

### 8.2 Confidence bands on model CDF

The backend band generator (`_compute_model_bands` in analysis compute)
currently marginalises over mu only (sigma at posterior mean). With latent
onset, it should marginalise over onset as well. This requires sampling from
the joint `(onset, mu, sigma)` posterior — the same posterior samples used
for t95 HDI computation.

### 8.3 t95 computation

Currently: `t95 = exp(mu + 1.645 * sigma) + onset_fixed`.

With latent onset: `t95 = exp(mu + 1.645 * sigma) + onset`. The HDI on t95
already comes from posterior samples where this composition is computed per
sample. No formula change needed — the onset term is simply latent in each
sample.

### 8.4 Topology signatures (doc 10)

Onset is not part of the topology signature (which captures structural
identity, not parameter values). No change needed.
